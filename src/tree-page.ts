/** Live keyboard/mouse workbench beside the compact HUD. */
import { navigateSession } from './utils/session-navigation.js';
import { defaultSettings, saveSettings, briefingScope } from './settings.js';
import { runtimeSettings, applyDisplaySettings } from './settings-runtime.js';
import { treeWidthKeeper } from './utils/pane-width.js';
import { renderSettingsPage, handleSettingsInput, type SettingsPageState, type SettingsFrame } from './render/settings-page.js';
import { spawn, execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SessionFinder } from './collectors/session-finder.js';
import { RolloutParser, type RolloutParseResult } from './collectors/rollout.js';
import { buildSubagentTree, uniquePickerLabel } from './collectors/subagent-tree.js';
import { collectGitChanges, readGitDiff, readDiffHunks, type GitChanges } from './collectors/git-changes.js';
import { WorktreeCollector, worktreeSources, type WorktreesSnapshot } from './collectors/worktrees.js';
import { renderMonitor, initialMonitorState, reconcileMonitor, handleMonitorInput, canMonitorDiff,
  monitorModes, monitorPreferences, nextRepaintDelay, paneShown, type MonitorFrame } from './render/monitor.js';
import { WorkbenchInputDecoder, type WorkbenchInput } from './utils/workbench-input.js';
import { isPanelCommand, monitorKey, overlayKey, prefixName, type PanelCommand } from './utils/panel-command.js';
import { KeyForwarder, type ForwardItem } from './utils/key-forward.js';
import { fileSignature } from './utils/file-signature.js';
import { readAgentContextUsage } from './collectors/agent-context.js';
import { Briefer } from './collectors/briefing.js';
import { SmallModel } from './collectors/small-model.js';
import { RecapStore } from './collectors/recap.js';
import { AgentLog } from './collectors/agent-log.js';
import { ModelJobs, NO_JOBS, type JobSwitches } from './collectors/model-jobs.js';
import { WorkbenchHistory } from './collectors/workbench-events.js';
import type { WorkbenchEvent } from './render/workbench-state.js';
import { getHudHome } from './utils/codex-path.js';
import { HudStatus } from './collectors/hud-status.js';
import { statusCard, sessionState } from './render/status-block.js';
import { artSize, renderArt, type ArtBitmap } from './render/art.js';
import { loadArtImage } from './collectors/art-image.js';
import { t, setLanguage, resolveLanguage } from './render/i18n.js';
import { startProfiling, stopProfiling, time, timeAsync } from './utils/profile.js';
import type { HealthSource } from './collectors/hud-health.js';
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

/** A tmux command, through CODEX_HUD_TMUX_BIN when set (the test harness's server). */
function tmux(args: string[], input?: string): Promise<void> {
  return new Promise(resolve => {
    try {
      const child = execFile(process.env.CODEX_HUD_TMUX_BIN || 'tmux',args,{timeout:3000,windowsHide:true},()=>resolve());
      if (input !== undefined) child.stdin?.end(input);
    } catch { resolve(); }
  });
}

/** The Codex pane typing is passed to: the launch's, else the session's option. */
function resolveMainPane(): string | undefined {
  const pane = process.env.CODEX_HUD_MAIN_PANE;
  if (pane) return pane;
  if (!process.env.TMUX) return undefined;
  try {
    const option = execFileSync(process.env.CODEX_HUD_TMUX_BIN || 'tmux',['show-options','-qv','@codex_hud_main_pane'],
      {encoding:'utf8',timeout:1500,stdio:['ignore','pipe','ignore']}).trim();
    return /^%\d+$/.test(option) ? option : undefined;
  } catch { return undefined; }
}

/** This pane: an overlay opened from the prefix or a button takes the keyboard. */
function focusPanel(): void {
  const pane = process.env.TMUX_PANE;
  if (pane) void tmux(['select-pane','-t',pane]);
}

/**
 * Install the prefix key again after the setting changed (bin/codex-hud-keys),
 * for this session's server. Only inside a HUD session, which passes the toggle.
 */
function reinstallPrefix(prefix: string): void {
  const toggle = process.env.CODEX_HUD_TOGGLE_CMD;
  const session = process.env.CODEX_HUD_TMUX_SESSION;
  if (!toggle || !session) return;
  try {
    const child = spawn('bash',[path.join(path.dirname(toggle),'codex-hud-keys'),session,prefix],{stdio:'ignore',detached:true});
    child.on('error',()=>{});
    child.unref();
  } catch { /* The next launch installs it. */ }
}

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
  startProfiling('panel');
  const finder = new SessionFinder(HUD_CWD_REAL,undefined,HUD_SESSION_START);
  const parser = new RolloutParser(40);
  const worktreeCollector = new WorktreeCollector();
  // Typing here goes to Codex; with no Codex pane to give it to (the panel
  // run on its own), the keys drive the panel as they used to.
  const mainPane = resolveMainPane();
  const decoder = new WorkbenchInputDecoder('monitor',{forward:Boolean(mainPane)});
  const forwarder = new KeyForwarder(()=>mainPane,call=>tmux(call.args,call.input));
  let settings = defaultSettings();
  let settingsError = '';
  let settingsFailure: unknown = null;
  try { settings = runtimeSettings(); } catch (err) { settingsFailure = err; }
  applyDisplaySettings(settings);
  setLanguage(resolveLanguage(settings.language));
  if (settingsFailure) settingsError = t('Settings: {reason}',{reason:String(settingsFailure)});
  const configuredState = () => {
    const next = initialMonitorState();
    next.tree.sort = settings.sort;
    next.tree.lingerMs = settings.finishedLingerMs;
    next.modes = monitorModes(settings);
    next.tabbed = settings.paneLayout === 'tabs';
    next.style = settings.panelStyle;
    next.statusLevel = settings.statusCard;
    next.labelAsName = settings.labelAsName;
    return next;
  };
  let state = configuredState();
  let settingsPage: SettingsPageState | null = null;
  let settingsFrame: SettingsFrame | undefined;
  // The first read of a long rollout takes seconds; until then say so.
  let collected = false;
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
  // Every model call of the panel goes through one service: one queue, one
  // cache, one hourly cap. Its cache and call log live beside the HUD's state.
  const model = new SmallModel({dir:path.join(getHudHome(),'model-cache')});
  // Each subagent's log: observed changes and model notes, kept per session.
  const agentLog = new AgentLog(path.join(getHudHome(),'agent-log'));
  // The Timeline pane's events: the rollout's and the agent log's, one list.
  const history = new WorkbenchHistory();
  let timeline: WorkbenchEvent[] = [];
  const recaps = new RecapStore(path.join(getHudHome(),'recaps'));
  // Repaints when a brief starts, lands or fails; render() is defined below.
  const briefer = new Briefer(()=>render(),{model,store:recaps,log:agentLog});
  /** The model's other jobs, each behind its own switch; all off with the backend. */
  const switches = (): JobSwitches => settings.briefing === 'off' ? NO_JOBS : {resultDigest:settings.resultDigest,agentLabels:settings.agentLabels,
    failureCause:settings.failureCause,changeSummary:settings.changeSummary,approvalDescription:settings.approvalDescription};
  const jobsOn = () => settings.briefing !== 'off' && !settings.briefingPaused;
  // A label or digest landing is put on the tree at once, not at the next collection.
  const jobs = new ModelJobs({model,log:agentLog,labelsFile:path.join(getHudHome(),'model-cache','labels.json'),titles:recaps,readHunks:readDiffHunks,
    onChange:()=>{jobs.apply(tree,switches(),resolveLanguage(settings.language));render();}});
  const updateJobs = () => time('jobs.update',()=>jobs.update({tree,main,switches:switches(),language:resolveLanguage(settings.language),on:jobsOn(),
    inspected:paneShown(state,'details') && state.preview === 'agent' ? state.tree.selectedId ?? undefined : undefined,
    recapGoal:briefCommand() === 'off' ? undefined : briefer.current().recap?.goal,digestLabels:{basis:t('Basis:'),caveats:t('Caveats:')},now:Date.now()}));
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  /** A short-lived line in the notice row, cleared after a few seconds. */
  const flash = (message: string) => {
    navigationMessage = message; render();
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(()=>{ if (navigationMessage === message) { navigationMessage = null; render(); } },3000);
  };
  // The decoration picture, decoded once per path; a failed read means none.
  let art: {path: string; bitmap: ArtBitmap | null} = {path:'',bitmap:null};
  const loadArt = () => {
    const path = settings.art === 'off' ? '' : settings.artImage;
    if (path === art.path) return;
    art = {path,bitmap:null};
    if (!path) { render(); return; }
    loadArtImage(path).then(bitmap=>{if(art.path===path){art.bitmap=bitmap;render();}}).catch(()=>{});
  };
  const drawArt = (cols: number, rows: number) => {
    const style = settings.art;
    if (!art.bitmap || style === 'off') return null;
    const size = artSize(art.bitmap,cols,rows);
    return size ? renderArt(art.bitmap,style,size.cols,size.rows) : null;
  };
  const configureBriefer = () => model.configure({backend:settings.briefing,api:{base:settings.briefingApiBase,model:settings.briefingApiModel,key:settings.briefingApiKey,
    reasoning:settings.briefingApiReasoning},hourlyCap:settings.modelCallsPerHour});
  const scope = () => briefingScope(settings);
  /** The brief's backend as the Briefer sees it: off too when neither brief nor recap is on. */
  const briefCommand = () => scope() ? settings.briefing : 'off';
  const updateBriefer = (paused: boolean) => time('brief.update',()=>briefer.update(tree,briefCommand(),settings.briefingMs,
    resolveLanguage(settings.language),Date.now(),paused,{scope:scope() ?? 'agents',main,floorMs:settings.recapFloorMs}));
  configureBriefer();
  // The bar's fields, for the foot of the panel: the panel replaces the bar
  // while it is open. Fed from this page's own parse of the rollout.
  const hudStatus = new HudStatus(HUD_CWD,()=>render(),30_000);
  const timers: Array<ReturnType<typeof setInterval>> = [];
  // Collection runs at the refresh setting; repaints between collections only
  // move the clocks, once a second (see nextRepaintDelay).
  let collectTimer: ReturnType<typeof setInterval> | undefined;
  let collectEvery = 0;
  let repaintTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone = () => {};

  const render = () => {
    if (closed) return;
    const output = time('render',() => {
      let lines: string[];
      if (settingsPage) {
        settingsFrame = renderSettingsPage(settingsPage,process.stdout.columns || 30,process.stdout.rows || 24,
          {state:hudStatus.health.current(),modelCalls:settings.briefing === 'off' ? undefined : model.usage()});
        settingsPage = settingsFrame.state;
        lines = settingsFrame.lines;
      } else {
      const width = process.stdout.columns || 30;
      frame = renderMonitor({tree,state,git,worktrees,diff,error,notice:navigationMessage,loading:!collected,art:drawArt,prefix:prefixName(settings.prefixKey),
        brief:briefCommand() === 'off' ? undefined : {...briefer.current(),paused:settings.briefingPaused},
        agentLog:settings.briefing !== 'off' || settings.agentLog ? agentLog.snapshot() : undefined,timeline:jobs.withCauses(timeline),
        notes:{approval:switches().approvalDescription ? jobs.approvalNote(main?.pendingApproval) : undefined,
          changes:switches().changeSummary ? jobs.changeNote(git) : undefined},
        status:nowMs=>statusCard(hudStatus.current(),nowMs),session:nowMs=>sessionState(hudStatus.current(),nowMs),width,height:process.stdout.rows || 24});
      state = frame.state;
      lines = frame.lines;
      }
      return lines.map(line=>`${line}\x1b[K`).join('\r\n');
    });
    if (lastPaint !== output) {
      lastPaint = output;
      time('write',() => process.stdout.write(`\x1b[H${output}\x1b[J`));
    }
  };
  /** The next clock-only repaint, timed to the main turn clock while a turn runs. */
  const scheduleRepaint = () => {
    if (closed) return;
    const activity = hudStatus.current()?.activity;
    const anchor = activity?.state === 'working' ? activity.turnStartedAt?.getTime() : undefined;
    repaintTimer = setTimeout(()=>{render();scheduleRepaint();},nextRepaintDelay(Date.now(),anchor));
  };
  /** (Re)arm collection at the refresh setting; a no-op while it is unchanged. */
  const armCollect = () => {
    if (closed || (collectTimer && collectEvery === settings.refreshMs)) return;
    if (collectTimer) clearInterval(collectTimer);
    collectEvery = settings.refreshMs;
    collectTimer = setInterval(()=>void collect(),collectEvery);
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
        for (let i=pane.offset;i<pane.offset+Math.max(0,pane.height-(pane.edge??1));i++) {
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
    await timeAsync('collect',collectNow);
  };
  const collectNow = async () => {
    collecting = true;
    let session: ReturnType<typeof finder.check> = null;
    let stale = false;
    // Where a failure happened, for the health row.
    let stage: HealthSource = 'session';
    try {
      session = finder.check();
      stage = 'rollout';
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
      hudStatus.health.read();
      stage = 'tree';
      const rootId = main?.session?.id ?? session?.sessionId ?? '';
      if (rootId !== tree.rootId) {
        state = configuredState(); diff = undefined; diffKey = ''; git = null; worktrees = null;
      }
      tree = rootId ? time('tree.build',()=>buildSubagentTree(rootId,main?.subagents ?? [])) : {rootId:'',nodes:[],totalCount:0,updatedAt:new Date()};
      applyAgentContext();
      jobs.apply(tree,switches(),resolveLanguage(settings.language));
      // On the same tick as the tree, so the log never lags it.
      if (time('agentlog.observe',()=>agentLog.observe(tree))) agentLog.flush();
      timeline = time('timeline',()=>history.timeline(tree,main,agentLog.snapshot()));
      state = reconcileMonitor(state,tree,git,worktrees);
      updateBriefer(settings.briefingPaused);
      updateJobs();
      error = settingsError || null;
    } catch (err) { error = t('Refresh: {reason}',{reason:String(err)}); stale = true; hudStatus.health.fail(stage,err); }
    finally { collecting = false; collected = true; }
    try { hudStatus.build({rollout:main,sessionId:session?.sessionId,stale}); }
    catch (err) { hudStatus.health.fail('status',err); /* The foot keeps its last good rows. */ }
    render();
    void refreshInspection();
    void refreshAgentContext();
  };
  const sources = () => worktreeSources(HUD_CWD_REAL,main?.session?.cwd,settings.worktreeRoot,process.env.CODEX_HUD_WORKTREE_ROOT);
  const refreshGit = async () => {
    if (closed) return;
    if (collectingGit) { gitAgain=true; return; }
    // Closed monitors are absent, not empty frames continuously collecting
    // data; in the tabs layout only the pane shown is read for.
    const wantChanges = paneShown(state,'changes') || (paneShown(state,'details') && state.preview === 'file');
    if (!paneShown(state,'worktrees') && !wantChanges && !(paneShown(state,'details') && state.preview === 'worktree')) return;
    collectingGit = true;
    const candidates = sources();
    const requestKey = JSON.stringify(candidates);
    try {
      const snapshot = await timeAsync('git.worktrees',()=>worktreeCollector.refresh(candidates));
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
        const result = await timeAsync('git.changes',()=>collectGitChanges(selected));
        if (closed) return;
        if (requestKey !== JSON.stringify(sources()) || selected !== state.selectedWorktree) { gitAgain=true; return; }
        git=result;gitRevision++;
        // While the pane is open, and at most once per floor period.
        jobs.updateChanges(git,{on:jobsOn(),enabled:switches().changeSummary,open:paneShown(state,'changes'),floorMs:settings.recapFloorMs,
          language:resolveLanguage(settings.language),now:Date.now()});
        const previousFile=state.selectedFile;
        state=reconcileMonitor(state,tree,git,worktrees);
        if(previousFile!==state.selectedFile){diff=undefined;diffKey='';}
      } else if (!entry || entry.bare || entry.prunable !== undefined) {git=null;diff=undefined;diffKey='';}
      render();
      void refreshInspection();
    } catch (err) {
      hudStatus.health.fail('worktrees',err);
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
    briefer.stop();
    jobs.stop();
    model.cancelAll();
    agentLog.flush();
    if (noticeTimer) clearTimeout(noticeTimer);
    timers.forEach(clearInterval);
    if (collectTimer) clearInterval(collectTimer);
    if (repaintTimer) clearTimeout(repaintTimer);
    stopProfiling();
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
    navigationMessage = t('Switching Codex session…'); render();
    try {
      // The name is the fallback for a Codex pane too narrow to print ids.
      const result = await navigateSession(process.env.CODEX_HUD_MAIN_PANE,{id,label:uniquePickerLabel(tree,id)});
      navigationMessage = result.ok ? null : result.message;
    } catch (err) { navigationMessage = t('Switch failed: {reason}',{reason:String(err)}); }
    finally { navigating = false; render(); }
  };
  /**
   * A command from the prefix table as the input it stands for. An open
   * overlay keeps the ones that move inside it or close it; any other
   * closes the overlay and goes to the panel.
   */
  const commandInput = (command: PanelCommand): WorkbenchInput => {
    const overlay = settingsPage ? 'settings' : state.help ? 'help' : null;
    if (overlay) {
      const key = overlayKey(command,overlay);
      if (key) return {type:'key',key};
      settingsPage = null;
      state = {...state,help:false};
    }
    return {type:'key',key:monitorKey(command)};
  };
  const dispatch = (inputs: WorkbenchInput[]) => {
    const overlayBefore = Boolean(settingsPage || state.help);
    // What goes to Codex, in order, sent once the whole read is through.
    const forward: ForwardItem[] = [];
    for (let input of inputs) {
      if (closed) break;
      if (input.type === 'mouse' && !settings.mouse) continue;
      if (input.type === 'command') input = commandInput(input.command);
      else if (mainPane && input.type !== 'mouse') {
        const overlay = Boolean(settingsPage || state.help);
        if (!overlay) {
          // Not the panel's: every key and paste is Codex's.
          if (input.type === 'paste') forward.push({kind:'paste',text:input.text});
          else if (input.raw) forward.push({kind:'keys',text:input.raw});
          continue;
        }
        // An open overlay owns the keyboard until it closes. Its keys are
        // the ones it needs; q and Ctrl+C close it, not the panel, and a
        // paste has nowhere to go.
        if (input.type === 'paste') continue;
        if (input.key === 'close') input = {type:'key',key:'escape'};
      }
      if (input.type === 'paste') continue;
      if (settingsPage && settingsFrame) {
        const result = handleSettingsInput(settingsPage,input,settingsFrame);
        settingsPage = result.state;
        if (result.action === 'back') settingsPage = null;
        else if (result.action === 'reset') settingsPage = {...settingsPage,draft:defaultSettings(),message:t('Defaults ready; Save to apply')};
        else if (result.action === 'save') {
          try {
            const previousPrefix = settings.prefixKey;
            settings = saveSettings(settingsPage.draft);
            settingsError = ''; error = null;
            applyDisplaySettings(settings);
            setLanguage(resolveLanguage(settings.language));
            configureBriefer();
            // A switched-off job's labels and digests leave the tree at once.
            jobs.apply(tree,switches(),resolveLanguage(settings.language));
            if (!jobsOn()) jobs.stop();
            armCollect();
            loadArt();
            state = {...state,tree:{...state.tree,sort:settings.sort,lingerMs:settings.finishedLingerMs},modes:monitorModes(settings),
              tabbed:settings.paneLayout === 'tabs',style:settings.panelStyle,statusLevel:settings.statusCard,labelAsName:settings.labelAsName,statusScroll:0,scroll:{...state.scroll,agents:0},revealed:null};
            git=null;diff=undefined;diffKey='';void refreshGit();
            if (settings.prefixKey !== previousPrefix) reinstallPrefix(settings.prefixKey);
            settingsPage.message = t('Saved');
            settingsPage.original = {...settings};
            process.stdout.write(settings.mouse ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1000l\x1b[?1006l');
            void widthKeeper?.apply().catch(err=>{if(settingsPage) settingsPage.message=String(err);render();});
          } catch (err) { settingsPage.message = t('Save failed: {reason}',{reason:String(err)}); }
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
        catch (err) { settingsError=t('Panel preferences could not be saved: {reason}',{reason:String(err)});error=settingsError; }
      }
      if (result.action?.type === 'brief-toggle' && briefCommand() !== 'off') {
        try {
          settings = saveSettings({briefingPaused:!settings.briefingPaused});
          // Resuming asks at once when there is news, rather than at the next tick.
          if (!settings.briefingPaused) void collect();
          else { updateBriefer(true); jobs.stop(); }
        } catch (err) { settingsError=t('Panel preferences could not be saved: {reason}',{reason:String(err)});error=settingsError; }
      }
      if (result.action?.type === 'status-level' && state.statusLevel) {
        try { settings = saveSettings({statusCard:state.statusLevel}); }
        catch (err) { settingsError=t('Panel preferences could not be saved: {reason}',{reason:String(err)});error=settingsError; }
      }
      if (result.action?.type === 'settings') {
        settingsPage={draft:{...settings,...monitorPreferences(state),sort:state.tree.sort??'active'},selected:0,offset:0,message:''};
      }
      render();
      // A tab shown in the tabs layout is read for at once, as an opened pane is.
      if (state.selectedWorktree !== previous.selectedWorktree || JSON.stringify(state.modes) !== JSON.stringify(previous.modes)
        || (state.tabbed && state.focus !== previous.focus)) void refreshGit();
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
    if (forward.length) void forwarder.send(forward);
    if (!closed && !overlayBefore && (settingsPage || state.help)) focusPanel();
  };
  /** A command that opened the panel (bin/codex-hud-toggle --command): run once, after the first read. */
  const initialCommand = process.env.CODEX_HUD_INITIAL_COMMAND;
  delete process.env.CODEX_HUD_INITIAL_COMMAND;
  const runInitialCommand = () => {
    if (initialCommand && isPanelCommand(initialCommand)) dispatch([{type:'command',command:initialCommand}]);
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
    loadArt();
    void collect().then(runInitialCommand);
    void refreshGit();
    armCollect();
    scheduleRepaint();
    timers.push(setInterval(()=>void refreshGit(),3000));
  });
}

runLivePage().catch(error=>{process.stderr.write(`${String(error)}\n`);process.exitCode=1;}).finally(()=>{
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(LEAVE);
  process.exit(process.exitCode ?? 0);
});
