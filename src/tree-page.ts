/** Live keyboard/mouse workbench beside the compact HUD. */
import { navigateSession } from './utils/session-navigation.js';
import { defaultSettings, saveSettings } from './settings.js';
import { runtimeSettings, applyDisplaySettings } from './settings-runtime.js';
import { treeWidthKeeper } from './utils/pane-width.js';
import { renderSettingsPage, handleSettingsInput, type SettingsPageState, type SettingsFrame } from './render/settings-page.js';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { SessionFinder } from './collectors/session-finder.js';
import { RolloutParser, type RolloutParseResult } from './collectors/rollout.js';
import { buildSubagentTree, uniquePickerLabel } from './collectors/subagent-tree.js';
import { collectGitChanges, readGitDiff, type GitChanges } from './collectors/git-changes.js';
import { WorktreeCollector, worktreeSources, type WorktreesSnapshot } from './collectors/worktrees.js';
import { renderMonitor, initialMonitorState, reconcileMonitor, handleMonitorInput, canMonitorDiff,
  monitorModes, monitorPreferences, type MonitorFrame } from './render/monitor.js';
import { WorkbenchInputDecoder, type WorkbenchInput } from './utils/workbench-input.js';
import { fileSignature } from './utils/file-signature.js';
import { readAgentContextUsage } from './collectors/agent-context.js';
import type { ContextUsage, SubagentTree, SubagentTreeNode } from './types.js';

/** At most one tail read per agent per this long, however often we repaint. */
const AGENT_CONTEXT_INTERVAL_MS = 3000;

function walkNodes(nodes: SubagentTreeNode[], visit: (node: SubagentTreeNode) => void): void {
  for (const node of nodes) { visit(node); walkNodes(node.children, visit); }
}

const HUD_CWD = process.env.CODEX_HUD_CWD || process.cwd();
const HUD_CWD_REAL = (() => { try { return fs.realpathSync(HUD_CWD); } catch { return HUD_CWD; } })();
const HUD_SESSION_START = (() => {
  const raw = Number(process.env.CODEX_HUD_SESSION_START);
  return Number.isFinite(raw) && raw > 0 ? new Date(raw > 1e12 ? raw : raw * 1000) : null;
})();
const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1006h';
const LEAVE = '\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l';

function requestEnsureSingle(): void {
  const toggle = process.env.CODEX_HUD_TOGGLE_CMD;
  const session = process.env.CODEX_HUD_TMUX_SESSION;
  if (!toggle || !session) return;
  try {
    const child = spawn('bash',[toggle,session,'--ensure-single'],{stdio:'ignore',detached:true});
    child.on('error',()=>{});
    child.unref();
  } catch { /* Closing the side pane is best effort. */ }
}

async function runLivePage(): Promise<void> {
  const finder = new SessionFinder(HUD_CWD_REAL,undefined,HUD_SESSION_START);
  const parser = new RolloutParser(40);
  const worktreeCollector = new WorktreeCollector();
  const decoder = new WorkbenchInputDecoder('monitor');
  let settings = defaultSettings();
  let settingsError = '';
  try { settings = runtimeSettings(); } catch (err) { settingsError = `Settings: ${String(err)}`; }
  applyDisplaySettings(settings);
  const configuredState = () => {
    const next = initialMonitorState();
    next.tree.sort = settings.sort;
    next.tree.lingerMs = settings.finishedLingerMs;
    next.modes = monitorModes(settings);
    return next;
  };
  let state = configuredState();
  let settingsPage: SettingsPageState | null = null;
  let settingsFrame: SettingsFrame | undefined;
  let lastCollect = 0;
  let navigating = false;
  let lastClickSwitch: {id: string; at: number} | undefined;
  let navigationMessage: string | null = null;
  let tree: SubagentTree = {rootId:'',nodes:[],totalCount:0,updatedAt:new Date()};
  let main: RolloutParseResult | null = null;
  // Size/mtime/inode as of the last parse: this page runs its own parser over
  // the same rollout as the HUD, so it re-reads nothing while the file is still.
  let lastParsedRollout: string | null = null;
  let worktrees: WorktreesSnapshot | null = null;
  let git: GitChanges | null = null;
  let gitRevision = 0;
  let diff: string[] | undefined;
  let diffKey = '';
  let error: string | null = settingsError || null;
  let frame: MonitorFrame | undefined;
  let lastPaint = '';
  let closed = false;
  let collecting = false;
  let collectingGit = false;
  let gitAgain = false;
  let inspecting = false;
  let inspectAgain = false;
  // Per-agent context fill, kept beside the tree because the tree is rebuilt
  // from the rollout on every collection and would otherwise lose it.
  const agentContext = new Map<string,ContextUsage>();
  const agentContextReadAt = new Map<string,number>();
  let readingAgentContext = false;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const widthKeeper = treeWidthKeeper(()=>settings.treeWidth);
  const timers: Array<ReturnType<typeof setInterval>> = [];
  let resolveDone = () => {};

  const render = () => {
    if (closed) return;
    let lines: string[];
    if (settingsPage) {
      settingsFrame = renderSettingsPage(settingsPage,process.stdout.columns || 30,process.stdout.rows || 24);
      settingsPage = settingsFrame.state;
      lines = settingsFrame.lines;
    } else {
    frame = renderMonitor({tree,state,git,worktrees,diff,error,notice:navigationMessage,
      width:process.stdout.columns || 30,height:process.stdout.rows || 24});
    state = frame.state;
    lines = frame.lines;
    }
    const output = lines.map(line=>`${line}\x1b[K`).join('\r\n');
    if (lastPaint !== output) {
      lastPaint = output;
      process.stdout.write(`\x1b[H${output}\x1b[J`);
    }
  };
  const applyAgentContext = () => {
    walkNodes(tree.nodes,node=>{node.contextUsage = agentContext.get(node.id);});
  };
  /**
   * Read the context fill of the agents actually on screen, plus the selected
   * one. Rows nobody can see are not worth a file read, and each node is read
   * at most once every few seconds however often the panel repaints.
   */
  const refreshAgentContext = async () => {
    if (closed || readingAgentContext) return;
    readingAgentContext = true;
    try {
      const pane = frame?.panes.find(p=>p.id==='agents');
      const wanted = new Set<string>();
      if (state.tree.selectedId) wanted.add(state.tree.selectedId);
      if (pane) {
        for (let i=pane.offset;i<pane.offset+Math.max(0,pane.height-2);i++) {
          const item = pane.rows[i]?.item;
          if (item) wanted.add(item);
        }
      }
      const byId = new Map<string,SubagentTreeNode>();
      walkNodes(tree.nodes,node=>byId.set(node.id,node));
      const now = Date.now();
      let changed = false;
      for (const id of wanted) {
        const path = byId.get(id)?.rolloutPath;
        if (!path) continue;
        if (now-(agentContextReadAt.get(id) ?? 0) < AGENT_CONTEXT_INTERVAL_MS) continue;
        agentContextReadAt.set(id,now);
        const usage = await readAgentContextUsage(path);
        if (closed) return;
        if (usage) agentContext.set(id,usage); else agentContext.delete(id);
        changed = true;
      }
      // Entries for agents no longer in the tree would otherwise accumulate.
      for (const id of [...agentContext.keys()]) if (!byId.has(id)) {agentContext.delete(id);agentContextReadAt.delete(id);}
      if (changed) { applyAgentContext(); render(); }
    } catch { /* A rollout that cannot be read has no fill to report. */ }
    finally { readingAgentContext = false; }
  };
  const refreshInspection = async () => {
    if (closed) return;
    if (inspecting) { inspectAgain = true; return; }
    inspecting = true;
    const selectedFile = git?.files.find(file=>file.path === state.selectedFile);
    try {
      if (state.preview === 'file' && selectedFile && git?.root && canMonitorDiff(frame)) {
        const key = JSON.stringify([git.root,selectedFile.path,gitRevision]);
        if (key !== diffKey) {
          const repoRoot = git.root;
          const revision = gitRevision;
          const result = await readGitDiff(repoRoot,selectedFile);
          if (!closed && state.selectedFile === selectedFile.path && git?.root === repoRoot && gitRevision === revision) {
            diff = result; diffKey = key;
          } else inspectAgain = true;
        }
      }
    } catch (err) {
      if (state.preview === 'file') diff = ['Unable to read this file preview'];
    } finally {
      inspecting = false;
      render();
      if (inspectAgain && !closed) { inspectAgain = false; void refreshInspection(); }
    }
  };
  const collect = async () => {
    if (closed || collecting) return;
    collecting = true;
    try {
      const session = finder.check();
      parser.setRolloutPath(session?.path ?? null);
      if (!session) {
        main = null;
        lastParsedRollout = null;
      } else {
        const signature = fileSignature(session.path);
        const cached = parser.getCached();
        if (cached && signature !== null && signature === lastParsedRollout) {
          main = cached;
        } else {
          lastParsedRollout = signature;
          try {
            main = await parser.parse();
          } catch (err) {
            // A failed read is not "already parsed"; let the next tick retry.
            lastParsedRollout = null;
            throw err;
          }
        }
      }
      const rootId = main?.session?.id ?? session?.sessionId ?? '';
      if (rootId !== tree.rootId) {
        state = configuredState(); diff = undefined; diffKey = ''; git = null; worktrees = null;
      }
      tree = rootId ? buildSubagentTree(rootId,main?.subagents ?? []) : {rootId:'',nodes:[],totalCount:0,updatedAt:new Date()};
      applyAgentContext();
      state = reconcileMonitor(state,tree,git,worktrees);
      error = settingsError || null;
    } catch (err) { error = `Refresh: ${String(err)}`; }
    finally { collecting = false; }
    render();
    void refreshInspection();
    void refreshAgentContext();
  };
  const sources = () => worktreeSources(HUD_CWD_REAL,main?.session?.cwd,settings.worktreeRoot,process.env.CODEX_HUD_WORKTREE_ROOT);
  const refreshGit = async () => {
    if (closed) return;
    if (collectingGit) { gitAgain=true; return; }
    // Closed monitors are absent, not empty frames continuously collecting data.
    const wantChanges = state.modes.changes === 'open' || (state.modes.details === 'open' && state.preview === 'file');
    if (state.modes.worktrees !== 'open' && !wantChanges && !(state.modes.details === 'open' && state.preview === 'worktree')) return;
    collectingGit = true;
    const candidates = sources();
    const requestKey = JSON.stringify(candidates);
    try {
      const snapshot = await worktreeCollector.refresh(candidates);
      if (closed) return;
      if (requestKey !== JSON.stringify(sources())) { gitAgain=true; return; }
      worktrees = snapshot;
      const previousWorktree = state.selectedWorktree;
      state = reconcileMonitor(state,tree,git,worktrees);
      if (state.selectedWorktree !== previousWorktree) {git=null;diff=undefined;diffKey='';}
      render();
      const entry = worktrees.entries.find(w=>w.path===state.selectedWorktree);
      if (wantChanges && entry && !entry.bare && entry.prunable === undefined) {
        const selected = entry.path;
        const result = await collectGitChanges(selected);
        if (closed) return;
        if (requestKey !== JSON.stringify(sources()) || selected !== state.selectedWorktree) { gitAgain=true; return; }
        git=result;gitRevision++;
        const previousFile=state.selectedFile;
        state=reconcileMonitor(state,tree,git,worktrees);
        if(previousFile!==state.selectedFile){diff=undefined;diffKey='';}
      } else if (!entry || entry.bare || entry.prunable !== undefined) {git=null;diff=undefined;diffKey='';}
      render();
      void refreshInspection();
    } catch {
      worktrees = {sourcePath:null,entries:[],updatedAt:Date.now(),error:'Worktree read failed'};
      git=null;diff=undefined;diffKey='';render();
    } finally {
      collectingGit=false;
      if(gitAgain&&!closed){gitAgain=false;void refreshGit();}
    }
  };
  const finish = (user = false) => {
    if (closed) return;
    closed = true;
    timers.forEach(clearInterval);
    if (escapeTimer) clearTimeout(escapeTimer);
    if (resizeTimer) clearTimeout(resizeTimer);
    process.stdin.off('data',onData);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(LEAVE);
    if (user) requestEnsureSingle();
    resolveDone();
  };
  const switchSession = async (id:string) => {
    if (navigating || !id) return;
    navigating = true;
    navigationMessage = 'Switching Codex session…'; render();
    try {
      // The name is the fallback for a Codex pane too narrow to print ids.
      const result = await navigateSession(process.env.CODEX_HUD_MAIN_PANE,{id,label:uniquePickerLabel(tree,id)});
      navigationMessage = result.ok ? null : result.message;
    } catch (err) { navigationMessage = `Switch failed: ${String(err)}`; }
    finally { navigating = false; render(); }
  };
  const dispatch = (inputs: WorkbenchInput[]) => {
    for (const input of inputs) {
      if (closed) break;
      if (input.type === 'mouse' && !settings.mouse) continue;
      if (settingsPage && settingsFrame) {
        const result = handleSettingsInput(settingsPage,input,settingsFrame);
        settingsPage = result.state;
        if (result.action === 'back') settingsPage = null;
        else if (result.action === 'reset') settingsPage = {...settingsPage,draft:defaultSettings(),message:'Defaults ready; Save to apply'};
        else if (result.action === 'save') {
          try {
            settings = saveSettings(settingsPage.draft);
            settingsError = ''; error = null;
            applyDisplaySettings(settings);
            state = {...state,tree:{...state.tree,sort:settings.sort,lingerMs:settings.finishedLingerMs},modes:monitorModes(settings)};
            git=null;diff=undefined;diffKey='';void refreshGit();
            settingsPage.message = 'Saved';
            settingsPage.original = {...settings};
            process.stdout.write(settings.mouse ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1000l\x1b[?1006l');
            void widthKeeper?.apply().catch(err=>{if(settingsPage) settingsPage.message=String(err);render();});
          } catch (err) { settingsPage.message = `Save failed: ${String(err)}`; }
        }
        render(); continue;
      }
      const previous = state;
      const result = handleMonitorInput(state,input,{tree,git,worktrees,frame});
      state = result.state;
      if (result.close) { finish(true); break; }
      if (state.selectedFile !== previous.selectedFile) { diff=undefined;diffKey=''; }
      if (state.selectedWorktree !== previous.selectedWorktree) {git=null;diff=undefined;diffKey='';}
      if (JSON.stringify(state.modes) !== JSON.stringify(previous.modes)) {
        try { settings=saveSettings(monitorPreferences(state)); }
        catch (err) { settingsError=`Panel preferences could not be saved: ${String(err)}`;error=settingsError; }
      }
      if (result.action?.type === 'settings') {
        settingsPage={draft:{...settings,...monitorPreferences(state),sort:state.tree.sort??'active'},selected:0,offset:0,message:''};
      }
      render();
      if (state.selectedWorktree !== previous.selectedWorktree || JSON.stringify(state.modes) !== JSON.stringify(previous.modes)) void refreshGit();
      void refreshInspection();
      if (result.action?.type === 'switch') {
        const id=result.action.id;
        const at=Date.now();
        // Deduplicate a mouse burst only. This is NOT evidence of Codex's current thread.
        const duplicate=input.type==='mouse'&&lastClickSwitch?.id===id&&at-lastClickSwitch.at<400;
        if(input.type==='mouse')lastClickSwitch={id,at};
        if(!duplicate)void switchSession(id);
      }
    }
  };
  const onData = (chunk: Buffer) => {
    if (escapeTimer) clearTimeout(escapeTimer);
    dispatch(decoder.push(chunk));
    escapeTimer = setTimeout(()=>dispatch(decoder.flushEscape()),40);
  };
  await new Promise<void>(resolve => {
    resolveDone = resolve;
    process.once('SIGINT',()=>finish());
    process.once('SIGTERM',()=>finish());
    process.once('SIGHUP',()=>finish());
    process.stdin.once('end',()=>finish());
    process.stdout.on('resize',()=>{
      lastPaint='';render();void refreshInspection();
      // A client attaching at another size shares the change with this pane;
      // wait for the burst of resizes to settle, then take back the policy width.
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(()=>{void widthKeeper?.follow().catch(()=>{});},150);
    });
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdout.write(settings.mouse ? ENTER : '\x1b[?1049h\x1b[?25l\x1b[?2004h');
    void widthKeeper?.apply().catch(()=>{});
    process.stdin.resume();
    process.stdin.on('data',onData);
    render();
    void collect();
    void refreshGit();
    timers.push(setInterval(()=>{if(Date.now()-lastCollect >= settings.refreshMs){lastCollect=Date.now();void collect();}},100),setInterval(()=>void refreshGit(),3000),setInterval(render,250));
  });
}

runLivePage().catch(error=>{process.stderr.write(`${String(error)}\n`);process.exitCode=1;}).finally(()=>{
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(LEAVE);
  process.exit(process.exitCode ?? 0);
});
