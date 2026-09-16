/** Live keyboard/mouse workbench beside the compact HUD. */
import { navigateSession } from './utils/session-navigation.js';
import { visibleRows } from './render/panel-state.js';
import { defaultSettings, saveSettings } from './settings.js';
import { runtimeSettings, applyDisplaySettings } from './settings-runtime.js';
import { resizeTreePane } from './utils/pane-width.js';
import { renderSettingsPage, handleSettingsInput, type SettingsPageState, type SettingsFrame } from './render/settings-page.js';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { SessionFinder } from './collectors/session-finder.js';
import { RolloutParser, type RolloutParseResult } from './collectors/rollout.js';
import { buildSubagentTree } from './collectors/subagent-tree.js';
import { collectGitChanges, readGitDiff, type GitChanges } from './collectors/git-changes.js';
import { WorkbenchHistory } from './collectors/workbench-events.js';
import { renderWorkbench, type WorkbenchFrame } from './render/workbench.js';
import { initialWorkbenchState, reconcileWorkbench, handleWorkbenchInput } from './render/workbench-state.js';
import { WorkbenchInputDecoder, type WorkbenchInput } from './utils/workbench-input.js';
import type { SubagentTree, SubagentTreeNode } from './types.js';

const HUD_CWD = process.env.CODEX_HUD_CWD || process.cwd();
const HUD_CWD_REAL = (() => { try { return fs.realpathSync(HUD_CWD); } catch { return HUD_CWD; } })();
const HUD_SESSION_START = (() => {
  const raw = Number(process.env.CODEX_HUD_SESSION_START);
  return Number.isFinite(raw) && raw > 0 ? new Date(raw > 1e12 ? raw : raw * 1000) : null;
})();
const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h';
const LEAVE = '\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l';

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
function findNode(nodes: SubagentTreeNode[], id: string | null): SubagentTreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findNode(node.children,id);
    if (child) return child;
  }
  return undefined;
}

async function runLivePage(): Promise<void> {
  const finder = new SessionFinder(HUD_CWD_REAL,undefined,HUD_SESSION_START);
  const parser = new RolloutParser(40);
  const history = new WorkbenchHistory();
  const decoder = new WorkbenchInputDecoder();
  let settings = defaultSettings();
  let settingsError = '';
  try { settings = runtimeSettings(); } catch (err) { settingsError = `Settings: ${String(err)}`; }
  applyDisplaySettings(settings);
  const configuredState = () => {
    const next = initialWorkbenchState();
    next.tree.sort = settings.sort;
    next.tasksEnabled = settings.tasks;
    next.collapsed = {agents:false,details:!settings.details,changes:!settings.changes,activity:!settings.activity};
    return next;
  };
  let state = configuredState();
  let settingsPage: SettingsPageState | null = null;
  let settingsFrame: SettingsFrame | undefined;
  let lastCollect = 0;
  let navigating = false;
  let navigationMessage: string | null = null;
  let tree: SubagentTree = {rootId:'',nodes:[],totalCount:0,updatedAt:new Date()};
  let main: RolloutParseResult | null = null;
  let agent: RolloutParseResult | null = null;
  let git: GitChanges | null = null;
  let gitRevision = 0;
  let diff: string[] | undefined;
  let diffKey = '';
  let agentPath: string | undefined;
  let agentParser = new RolloutParser(30);
  let error: string | null = settingsError || null;
  let frame: WorkbenchFrame | undefined;
  let lastPaint = '';
  let closed = false;
  let collecting = false;
  let collectingGit = false;
  let inspecting = false;
  let inspectAgain = false;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
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
    frame = renderWorkbench({tree,state,git,diff,main,agent,events:history.values(),error,notice:navigationMessage,
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
  const refreshInspection = async () => {
    if (closed) return;
    if (inspecting) { inspectAgain = true; return; }
    inspecting = true;
    const selected = findNode(tree.nodes,state.tree.selectedId);
    const selectedFile = git?.files.find(file=>file.path === state.selectedFile);
    const root = tree.rootId;
    try {
      if (state.preview === 'agent') {
        if (selected?.rolloutPath !== agentPath) {
          agentPath = selected?.rolloutPath;
          agentParser = new RolloutParser(30);
          agentParser.setRolloutPath(agentPath ?? null);
          agent = null;
        }
        const path = agentPath;
        const result = path ? await agentParser.parse() : null;
        if (!closed && root === tree.rootId && path === findNode(tree.nodes,state.tree.selectedId)?.rolloutPath) {
          agent = result;
          history.update(tree,main,agent);
        }
      } else if (state.preview === 'file' && selectedFile && git?.root) {
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
      if (state.preview === 'file') diff = [`Unable to read diff: ${String(err)}`];
      else agent = null;
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
      main = session ? await parser.parse() : null;
      const rootId = main?.session?.id ?? session?.sessionId ?? '';
      if (rootId !== tree.rootId) {
        state = configuredState(); agent = null; agentPath = undefined; diff = undefined; diffKey = '';
      }
      tree = rootId ? buildSubagentTree(rootId,main?.subagents ?? []) : {rootId:'',nodes:[],totalCount:0,updatedAt:new Date()};
      state = reconcileWorkbench(state,tree,git);
      history.update(tree,main);
      error = settingsError || null;
    } catch (err) { error = `Refresh: ${String(err)}`; }
    finally { collecting = false; }
    render();
    void refreshInspection();
  };
  const refreshGit = async () => {
    if (closed || collectingGit) return;
    collectingGit = true;
    try {
      git = await collectGitChanges(HUD_CWD_REAL);
      gitRevision++;
      const oldFile = state.selectedFile;
      state = reconcileWorkbench(state,tree,git);
      if (state.selectedFile !== oldFile) { diff = undefined; diffKey = ''; }
      render();
      void refreshInspection();
    } finally { collectingGit = false; }
  };
  const finish = (user = false) => {
    if (closed) return;
    closed = true;
    timers.forEach(clearInterval);
    if (escapeTimer) clearTimeout(escapeTimer);
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
      const result = await navigateSession(process.env.CODEX_HUD_MAIN_PANE,id);
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
            state = {...state,tree:{...state.tree,sort:settings.sort},tasksEnabled:settings.tasks,
              activityTab:!settings.tasks && state.activityTab === 'tasks' ? 'checks' : state.activityTab,
              collapsed:{...state.collapsed,details:!settings.details,changes:!settings.changes,activity:!settings.activity}};
            settingsPage.message = 'Saved';
            process.stdout.write(settings.mouse ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1000l\x1b[?1006l');
            void resizeTreePane(settings.treeWidth).catch(err=>{if(settingsPage) settingsPage.message=String(err);render();});
          } catch (err) { settingsPage.message = `Save failed: ${String(err)}`; }
        }
        render(); continue;
      }
      if ((input.type === 'key' && input.key === 'settings') ||
          (input.type === 'mouse' && input.button === 'left' && !state.help && input.y === 0 && input.x >= 7 && input.x < 17)) {
        settingsPage = {draft:{...settings,details:!state.collapsed.details,changes:!state.collapsed.changes,
          activity:!state.collapsed.activity,sort:state.tree.sort ?? 'active'},selected:0,offset:0,message:''};
        render(); continue;
      }
      if ((input.type === 'key' && input.key === 'main') ||
          (input.type === 'mouse' && input.button === 'left' && !state.help && input.y === 0 && input.x < 6)) {
        void switchSession(tree.rootId); continue;
      }
      if (input.type === 'key' && input.key === 'open-session') {
        if (state.tree.selectedId) void switchSession(state.tree.selectedId);
        continue;
      }
      const agentPane = frame?.panes.find(p=>p.id === 'agents');
      const clickedAgent = input.type === 'mouse' && input.button === 'left' && agentPane &&
        input.x > agentPane.x && input.x < agentPane.x+agentPane.width-1 &&
        input.y > agentPane.y && input.y < agentPane.y+agentPane.height-1
        ? visibleRows(tree.nodes,state.tree)[agentPane.offset+input.y-agentPane.y-1]?.node : undefined;
      const previous = state;
      const result = handleWorkbenchInput(state,input,{tree,git,panes:frame?.panes ?? [],events:history.values()});
      state = result.state;
      if (result.close) { finish(true); break; }
      if (state.selectedFile !== previous.selectedFile) { diff = undefined; diffKey = ''; }
      if (state.tree.selectedId !== previous.tree.selectedId) agent = null;
      render();
      void refreshInspection();
      if (clickedAgent) void switchSession(clickedAgent.id);
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
    process.stdout.on('resize',()=>{lastPaint='';render();});
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdout.write(settings.mouse ? ENTER : '\x1b[?1049h\x1b[?25l');
    void resizeTreePane(settings.treeWidth).catch(()=>{});
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
