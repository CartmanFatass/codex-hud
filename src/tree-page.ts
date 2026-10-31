/** Live keyboard/mouse workbench beside the compact HUD. */
import { navigateSession } from './utils/session-navigation.js';
import { defaultSettings, saveSettings, briefingScope, settingsPath, type HudSettings } from './settings.js';
import { homedir } from 'node:os';
import { runtimeSettings, applyDisplaySettings, withDisplaySettings } from './settings-runtime.js';
import { treeWidthKeeper } from './utils/pane-width.js';
import { frameDiff } from './render/frame-diff.js';
import { renderSettingsPage, handleSettingsInput, settingsDirty, resetSettingsGroup, resetAllPreferences, SETTING_ROWS, type SettingsPageState, type SettingsFrame } from './render/settings-page.js';
import { renderSettingsConfirmation, handleSettingsConfirmation, type SettingsConfirmationState, type SettingsConfirmationFrame } from './render/settings-confirmation.js';
import { spawn, execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SessionFinder, findRolloutsInDaysYielding, treeLookbackDays, recentSessions } from './collectors/session-finder.js';
import { RolloutParser, type RolloutParseResult } from './collectors/rollout.js';
import { buildSubagentTreeYielding, uniquePickerLabel, useTreeScanStore, flushTreeScans } from './collectors/subagent-tree.js';
import { TreeScanStore } from './collectors/tree-scan-store.js';
import { collectGitChanges, readGitDiff, readDiffHunks, type GitChanges } from './collectors/git-changes.js';
import { WorktreeCollector, worktreeSources, type WorktreesSnapshot } from './collectors/worktrees.js';
import { renderMonitor, initialMonitorState, reconcileMonitor, handleMonitorInput, canMonitorDiff,
  monitorModes, monitorSettings, monitorPreferences, nextRepaintDelay, msUntilAgeChanges, msUntilCountdownChanges,
  finishedAt, paneShown, panelTop, type MonitorFrame } from './render/monitor.js';
import { WorkbenchInputDecoder, type WorkbenchInput } from './utils/workbench-input.js';
import { isPanelCommand, monitorKey, overlayKey, prefixName, type PanelCommand } from './utils/panel-command.js';
import { KeyForwarder, type ForwardItem } from './utils/key-forward.js';
import { fileSignature } from './utils/file-signature.js';
import { readAgentTokens, type AgentTokens } from './collectors/agent-context.js';
import { Briefer } from './collectors/briefing.js';
import { SmallModel } from './collectors/small-model.js';
import { ModelProbe } from './collectors/model-probe.js';
import { hudProblems, diagnosticLines } from './render/hud-diagnostics.js';
import { ActivityJournal } from './collectors/activity-journal.js';
import { initialActivityHubState, renderActivityHub, handleActivityHubInput, type ActivityHubState, type ActivityHubFrame, type RecentSessionRow } from './render/activity-hub.js';
import { initialObservabilityState, renderObservabilityPage, handleObservabilityInput, type ObservabilityState, type ObservabilityFrame } from './render/observability-page.js';
import { createDiagnosticExportPreview, saveDiagnosticExport, type DiagnosticExportPreview } from './diagnostics/diagnostic-export.js';
import { captureRuntimeIdentity } from './diagnostics/runtime-identity.js';
import { modelTelemetryLines } from './render/model-telemetry.js';
import type { ModelTelemetrySummary } from './collectors/model-telemetry.js';
import { createAdaptivePollState, adaptivePollDue, forceAdaptivePoll, recordAdaptivePoll } from './collectors/adaptive-poll.js';
import { collectionObservation } from './utils/collection-observation.js';
import { scopedActivityObservation } from './utils/activity-observation.js';
import { ProgressSummarizer, progressTargets } from './collectors/progress-summary.js';
import { cardSummaryTargets } from './render/cards.js';
import { controlBar } from './render/control-bar.js';
import { RecapStore } from './collectors/recap.js';
import { AgentLog, logsIn } from './collectors/agent-log.js';
import { ModelJobs, NO_JOBS, type JobSwitches } from './collectors/model-jobs.js';
import { WorkbenchHistory } from './collectors/workbench-events.js';
import type { WorkbenchEvent } from './render/workbench-state.js';
import { getCodexHome, getHudHome } from './utils/codex-path.js';
import { codexGoal } from './collectors/codex-goal.js';
import { roleSet, subtaskRoles } from './render/directions.js';
import { HudStatus } from './collectors/hud-status.js';
import { Notifier, resolveNotifierOptions } from './notify.js';
import { buildSnapshot, SnapshotWriter } from './snapshot.js';
import { resolveResetTime } from './render/quota.js';
import { statusCard, sessionState } from './render/status-block.js';
import { artSize, renderArt, type ArtBitmap } from './render/art.js';
import { loadArtImage } from './collectors/art-image.js';
import { t, setLanguage, resolveLanguage } from './render/i18n.js';
import { startProfiling, stopProfiling, time, timeAsync } from './utils/profile.js';
import type { HealthSource } from './collectors/hud-health.js';
import type { SubagentTree, SubagentTreeNode } from './types.js';

/** At most one tail read per agent per this long, however often we repaint. */
const AGENT_CONTEXT_INTERVAL_MS = 3000;
// This identifies the entry file observed at startup, not files replaced later.
const runtimeIdentity = captureRuntimeIdentity({entryFile:new URL(import.meta.url)});

/** A path as people write it: the home directory as `~`. */
function shortPath(file: string): string {
  const home = homedir();
  return home && (file === home || file.startsWith(home+'/')) ? '~'+file.slice(home.length) : file;
}

function walkNodes(nodes: SubagentTreeNode[], visit: (node: SubagentTreeNode) => void): void {
  for (const node of nodes) { visit(node); walkNodes(node.children, visit); }
}

/** Rollouts the current tree already shows, so a quiet one that starts writing is stat'd at once. */
function treePaths(nodes: SubagentTreeNode[]): Set<string> {
  const paths = new Set<string>();
  walkNodes(nodes, node => { if (node.rolloutPath) paths.add(node.rolloutPath); });
  return paths;
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

/** Esc leaves focus mode: the keys go back to the Codex pane. */
function focusMain(): void {
  const pane = process.env.CODEX_HUD_MAIN_PANE;
  if (pane) void tmux(['select-pane','-t',pane]);
}

/**
 * Refresh the command table at panel startup or after the prefix changed,
 * so an existing session picks up removed commands and new bindings too.
 * Only inside a HUD session, which passes the toggle.
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
  // Opened again, the panel reads only what each rollout gained since it last saved its scan.
  useTreeScanStore(new TreeScanStore(path.join(getHudHome(),'scan')));
  const finder = new SessionFinder(HUD_CWD_REAL,undefined,HUD_SESSION_START);
  const parser = new RolloutParser(40);
  const worktreeCollector = new WorktreeCollector();
  // Typing here goes to Codex; with no Codex pane to give it to (the panel
  // run on its own), the keys drive the panel as they used to.
  const mainPane = resolveMainPane();
  // Search modals need literal Unicode and paste even in a standalone panel.
  const decoder = new WorkbenchInputDecoder('monitor',{forward:true});
  const forwarder = new KeyForwarder(()=>mainPane,call=>tmux(call.args,call.input));
  let settings = defaultSettings();
  let settingsError = '';
  let settingsFailure: unknown = null;
  try { settings = runtimeSettings(); } catch (err) { settingsFailure = err; }
  applyDisplaySettings(settings);
  setLanguage(resolveLanguage(settings.language));
  if (settingsFailure) settingsError = t('Settings: {reason}',{reason:String(settingsFailure)});
  else reinstallPrefix(settings.prefixKey);
  const configuredState = () => {
    const next = initialMonitorState();
    next.tree.sort = settings.sort;
    next.tree.lingerMs = settings.finishedLingerMs;
    next.modes = monitorModes(settings);
    return {...next,...monitorSettings(settings)};
  };
  let state = configuredState();
  let journal = new ActivityJournal({rootId:''});
  let journalRoot = '';
  let agentLogRoot = '';
  let activityHealthSuccess = {tree:0,status:0,worktrees:0};
  let activityHub: ActivityHubState | null = null;
  let activityFrame: ActivityHubFrame | undefined;
  let observability: ObservabilityState | null = null;
  let observabilityFrame: ObservabilityFrame | undefined;
  let exportPreview: DiagnosticExportPreview | undefined;
  let telemetry: ModelTelemetrySummary | undefined;
  let settingsPage: SettingsPageState | null = null;
  let settingsFrame: SettingsFrame | undefined;
  let settingsLeave: (SettingsConfirmationState & { destination?: string }) | null = null;
  let confirmationFrame: SettingsConfirmationFrame | undefined;
  // The first read of a long rollout takes seconds; until then say so.
  let collected = false;
  let navigating = false;
  let lastClickSwitch: {id: string; at: number} | undefined;
  let navigationMessage: string | null = null;
  let tree: SubagentTree = {rootId:'',nodes:[],totalCount:0,updatedAt:new Date()};
  // The root the tree was last built for: until then an empty tree is not news.
  let treeBuiltFor: string | null = null;
  let main: RolloutParseResult | null = null;
  // Size/mtime/inode as of the last parse: this page runs its own parser over
  // the same rollout as the HUD, so it re-reads nothing while the file is still.
  let lastParsedRollout: string | null = null;
  let worktrees: WorktreesSnapshot | null = null;
  let git: GitChanges | null = null;
  let gitRevision = 0;
  let gitObservedAt = 0;
  let diff: string[] | undefined;
  let diffKey = '';
  let error: string | null = settingsError || null;
  let frame: MonitorFrame | undefined;
  let lastPaint: string[] | null = null;
  let closed = false;
  let collecting = false;
  let collectingGit = false;
  let gitAgain = false;
  let inspecting = false;
  let inspectAgain = false;
  // Per-agent context fill and output rate, kept beside the tree because the
  // tree is rebuilt from the rollout on every collection and would otherwise lose them.
  const agentContext = new Map<string,AgentTokens>();
  const agentContextReadAt = new Map<string,number>();
  let readingAgentContext = false;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const widthKeeper = treeWidthKeeper(()=>settings.treeWidth);
  // Every model call of the panel goes through one service: one queue, one
  // cache, one hourly cap. Its cache and call log live beside the HUD's state.
  let modelChanged = () => {};
  const model = new SmallModel({dir:path.join(getHudHome(),'model-cache'),onChange:()=>modelChanged()});
  const probe = new ModelProbe({dir:path.join(getHudHome(),'model-cache')},()=>render());
  // Each subagent's log: observed changes and model notes, kept per session.
  const agentLog = new AgentLog(path.join(getHudHome(),'agent-log'));
  // The Timeline pane's events: the rollout's and the agent log's, one list.
  const history = new WorkbenchHistory();
  let timeline: WorkbenchEvent[] = [];
  const recaps = new RecapStore(path.join(getHudHome(),'recaps'));
  // Repaints when a brief starts, lands or fails; render() is defined below.
  const briefer = new Briefer(()=>render(),{model,store:recaps,log:agentLog});
  // Visible summary subjects request public progress independently of the periodic brief.
  const progress = new ProgressSummarizer(model,agentLog,{onChange:()=>render()});
  const updateProgress = () => {
    const now = Date.now();
    const language = resolveLanguage(settings.language);
    progress.update({tree,
      targets:state.style === 'rich' && paneShown(state,'agents') && !state.help && !settingsPage && !activityHub && !observability
        ? progressTargets(tree,cardSummaryTargets({tree,agentLog:logsIn(agentLog.snapshot(),language)},state,now)) : new Set(),
      on:settings.briefing !== 'off' && settings.agentProgress && !settings.briefingPaused,
      offReason:settings.briefing === 'off' ? 'off' : settings.briefingPaused ? 'paused' : 'progress-disabled',
      language,now});
  };
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
    reasoning:settings.briefingApiReasoning,models:{lite:settings.briefingApiLiteModel,low:settings.briefingApiLowModel,
      medium:settings.briefingApiMediumModel}},hourlyCap:settings.modelCallsPerHour});
  const scope = () => briefingScope(settings);
  /** The brief's backend as the Briefer sees it: off too when neither brief nor recap is on. */
  const briefCommand = () => scope() ? settings.briefing : 'off';
  // The goal set in Codex is main-session material: read only for a scope that sends it.
  const updateBriefer = (paused: boolean) => time('brief.update',()=>briefer.update(tree,briefCommand(),settings.briefingMs,
    resolveLanguage(settings.language),Date.now(),paused,{scope:scope() ?? 'agents',main,floorMs:settings.recapFloorMs,
      importantRoles:roleSet(settings.importantRoles),goal:settings.briefing !== 'off' && settings.briefMain ? codexGoal(getCodexHome(),tree.rootId) : null,
      labels:switches().agentLabels}));
  configureBriefer();
  // The bar's fields, for the foot of the panel: the panel replaces the bar
  // while it is open. Fed from this page's own parse of the rollout.
  const hudStatus = new HudStatus(HUD_CWD,()=>render(),30_000);
  const currentHud = () => {
    const data = hudStatus.current();
    return data ? {...data,modelHealth:settings.briefing === 'off' ? undefined : model.diagnostics()} : undefined;
  };
  const observeActivity = () => {
    if (tree.rootId !== journalRoot) {
      journal.flush(); journalRoot = tree.rootId;
      journal = new ActivityJournal({codexHome:getCodexHome(),rootId:journalRoot});
      activityHub = activityHub ? initialActivityHubState(activityHub.tab) : null;
      exportPreview = undefined;
    }
    if (!journalRoot) return;
    journal.observe(scopedActivityObservation(journalRoot,agentLogRoot,{tree,data:currentHud(),
      logs:agentLog.snapshot(),git,gitObservedAt,
      gitFresh:!!git?.root && !git.error && gitObservedAt > 0 && Date.now() - gitObservedAt <= 15_000,
      modelAvailable:settings.briefing !== 'off',
      healthSignals:Object.entries(activityHealthSuccess).filter(([,at])=>at>0)
        .map(([source,at])=>({key:`collector:${source}`,kind:'health' as const,active:false,at}))}));
  };
  const sampleTelemetry = () => { telemetry = model.telemetry(); };
  const markActivitySourceSuccess = (source: keyof typeof activityHealthSuccess) => {
    const failure=hudStatus.health.current().lastError;
    if (!activityHealthSuccess[source] || (failure?.source===source && failure.at.getTime()>=activityHealthSuccess[source]))
      activityHealthSuccess[source]=Date.now();
  };
  const captureExport = () => {
    sampleTelemetry();
    exportPreview = createDiagnosticExportPreview({data:currentHud(),tree,selectedId:state.tree.selectedId ?? undefined,telemetry,runtimeIdentity,nowMs:Date.now()});
  };
  // The panel replaces the bar, so it publishes the same notifications and snapshot.
  const notifier = new Notifier(resolveNotifierOptions(process.env, settings));
  const snapshotWriter = new SnapshotWriter();
  /** Codex's pane width, when tmux has reported it. Unknown still allows session links. */
  let mainCols: number | null = null;
  const timers: Array<ReturnType<typeof setInterval>> = [];
  // Collection runs at the refresh setting; repaints between collections only
  // move the clocks, once a second (see nextRepaintDelay).
  let collectTimer: ReturnType<typeof setInterval> | undefined;
  let collectEvery = 0;
  let adaptive = createAdaptivePollState(settings.refreshMs);
  let collectionEpoch = 0;
  let repaintTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone = () => {};

  // The panel's top as a draft of the settings would draw it.
  const previewTop = (draft: HudSettings, width: number) => withDisplaySettings(draft,() =>
    panelTop({tree,brief:settings.briefing === 'off' ? undefined : {paused:settings.briefingPaused}},{...state,tabbed:draft.paneLayout === 'tabs'},width));
  // This directory's recent sessions, read only while the activity hub's Sessions tab is open, at most every ten seconds.
  let sessionsRead: {at:number;cwd:string;rows:RecentSessionRow[]} | null = null;
  const sessionList = (): RecentSessionRow[] => {
    const cwd = main?.session?.cwd || HUD_CWD;
    const now = Date.now();
    if (!sessionsRead || sessionsRead.cwd !== cwd || now-sessionsRead.at >= 10_000) {
      let rows: RecentSessionRow[] = [];
      try {
        rows = recentSessions(cwd).map(file => {
          // A title a model wrote earlier, read from its file: nothing is asked for here.
          const title = recaps.loadTitle(file.sessionId)?.title;
          return {id:file.sessionId,modifiedAt:file.modifiedAt.getTime(),...(title ? {title} : {}),...(file.sessionId === tree.rootId ? {current:true} : {})};
        });
      } catch { /* An unreadable sessions directory lists nothing. */ }
      sessionsRead = {at:now,cwd,rows};
    }
    return sessionsRead.rows;
  };
  const render = () => {
    if (closed) return;
    const output = time('render',() => {
      let lines: string[];
      if (activityHub) {
        activityFrame = renderActivityHub(journal.view(),activityHub,process.stdout.columns || 30,process.stdout.rows || 24,Date.now(),
          activityHub.tab === 'sessions' ? sessionList() : []);
        activityHub = activityFrame.state;
        lines = activityFrame.lines;
      } else if (observability) {
        const width = process.stdout.columns || 30;
        observabilityFrame = renderObservabilityPage(observability,{
          sources:diagnosticLines(currentHud(),width,Date.now(),{tree,selectedId:state.tree.selectedId ?? undefined}),
          calls:modelTelemetryLines(telemetry,width),preview:exportPreview?.json,
        },width,process.stdout.rows || 24);
        observability = observabilityFrame.state;
        lines = observabilityFrame.lines;
      } else if (settingsPage) {
        // Key roles offers the roles the subtasks have now.
        settingsFrame = renderSettingsPage({...settingsPage,roles:subtaskRoles(tree)},process.stdout.columns || 30,process.stdout.rows || 24,
          {state:hudStatus.health.current(),modelCalls:settings.briefing === 'off' ? undefined : model.usage(),probe:probe.current(),settingsFile:shortPath(settingsPath())},previewTop,
          controlBar(state,{settingsActive:true,expired:0,brief:settings.briefing === 'off' ? undefined : {paused:settings.briefingPaused}},process.stdout.columns || 30));
        settingsPage = settingsFrame.state;
        lines = settingsFrame.lines;
        if (settingsLeave) {
          confirmationFrame = renderSettingsConfirmation(lines,settingsLeave,process.stdout.columns || 30,process.stdout.rows || 24,settingsFrame.headerY);
          lines = confirmationFrame.lines;
        }
      } else {
      const width = process.stdout.columns || 30;
      const nowMs = Date.now();
      const hud = currentHud();
      const agentLogs = logsIn(agentLog.snapshot(),resolveLanguage(settings.language),settings.briefing !== 'off' || settings.agentLog);
      frame = renderMonitor({tree,state,git,worktrees,diff,error,nowMs,hud,notice:navigationMessage || hudProblems(hud,nowMs,t)[0],loading:!collected || treeBuiltFor !== tree.rootId,art:drawArt,prefix:prefixName(settings.prefixKey),
        brief:settings.briefing === 'off' ? undefined : {...(briefCommand() === 'off' ? {} : briefer.current()),paused:settings.briefingPaused},
        agentLog:agentLogs,
        progress:progress.state(),progressContext:{backendOn:settings.briefing !== 'off',paused:settings.briefingPaused,enabled:settings.agentProgress,
          targets:cardSummaryTargets({tree,agentLog:agentLogs},state,nowMs)},timeline:jobs.withCauses(timeline),
        notes:{approval:switches().approvalDescription ? jobs.approvalNote(main?.pendingApproval) : undefined,
          changes:switches().changeSummary ? jobs.changeNote(git) : undefined},
        status:nowMs=>statusCard(hud ?? null,nowMs),session:nowMs=>sessionState(hud ?? null,nowMs),width,height:process.stdout.rows || 24,
        linkNames:mainCols === null || mainCols >= 63});
      state = frame.state;
      lines = frame.lines;
      }
      return lines;
    });
    const update = frameDiff(lastPaint, output);
    lastPaint = output;
    if (update) time('write',() => process.stdout.write(update));
  };
  modelChanged = () => { adaptive = forceAdaptivePoll(adaptive); collectionEpoch++; render(); };
  /**
   * The next clock-only repaint. A second while something on screen shows
   * seconds (a turn, a live agent, the settings health line). Otherwise the
   * next age or countdown boundary, and never more than a minute.
   */
  const repaintDelay = () => {
    const now = Date.now();
    const data = hudStatus.current();
    const activity = data?.activity;
    const anchor = activity?.state === 'working' ? activity.turnStartedAt?.getTime() : undefined;
    if (settingsPage || activityHub || observability) return nextRepaintDelay(now, anchor);
    let live = activity?.state === 'working';
    if (!live) walkNodes(tree.nodes, node => { if (node.status === 'running' || node.status === 'starting') live = true; });
    if (live) return nextRepaintDelay(now, anchor);
    let wait = 60_000;
    const consider = (ms: number) => { if (ms > 0 && ms < wait) wait = ms; };
    const ageAt = (at?: Date) => { if (at && Number.isFinite(at.getTime())) consider(msUntilAgeChanges(at.getTime(), now)); };
    walkNodes(tree.nodes, node => { ageAt(finishedAt(node)); ageAt(node.startedAt); ageAt(node.turnStartedAt); ageAt(node.lastEventAt); ageAt(node.statusAt); });
    ageAt(data?.session?.startTime);
    ageAt(data?.sessionStart);
    // How long it has been idle, on the bar and the status card.
    if (activity?.state === 'idle') ageAt(activity.updatedAt);
    for (const window of [data?.rateLimits?.primary, data?.rateLimits?.secondary]) {
      if (!window) continue;
      const target = resolveResetTime(window, now);
      if (target) consider(msUntilCountdownChanges(target.getTime(), now));
    }
    if (paneShown(state, 'timeline')) for (const event of timeline) ageAt(event.at);
    return Math.min(60_000, Math.max(1, wait));
  };
  const scheduleRepaint = () => {
    if (closed) return;
    repaintTimer = setTimeout(()=>{render();scheduleRepaint();},repaintDelay());
  };
  /** The Codex pane's columns, so a narrow one is not offered as a link. */
  const readMainCols = () => {
    const pane = process.env.CODEX_HUD_MAIN_PANE;
    if (!pane) return;
    execFile(process.env.CODEX_HUD_TMUX_BIN || 'tmux', ['display-message', '-p', '-t', pane, '#{pane_width}'],
      { timeout: 1500, windowsHide: true }, (err, stdout) => {
        if (closed || err) return;
        const cols = Number(String(stdout ?? '').trim());
        if (!Number.isInteger(cols) || cols <= 0 || cols === mainCols) return;
        mainCols = cols;
        render();
      });
  };
  /** (Re)arm collection at the refresh setting; a no-op while it is unchanged. */
  const armCollect = () => {
    if (closed || (collectTimer && collectEvery === settings.refreshMs)) return;
    if (collectTimer) clearInterval(collectTimer);
    collectEvery = settings.refreshMs;
    adaptive = createAdaptivePollState(collectEvery);
    collectTimer = setInterval(()=>void collect(),collectEvery);
  };
  const applyAgentContext = () => {
    walkNodes(tree.nodes,node=>{
      const tokens = agentContext.get(node.id);
      node.contextUsage = tokens?.usage;
      node.outputRate = tokens?.rate;
      node.tokensSpent = tokens?.spent;
    });
  };
  /**
   * Read the context fill and output rate of the agents actually on screen,
   * the selected one, and every one still running, for the summary's total
   * rate. Finished rows nobody can see are not worth a file read; a running
   * one costs what its rollout grew by. Each node is read at most once every
   * few seconds however often the panel repaints.
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
      walkNodes(tree.nodes,node=>{
        byId.set(node.id,node);
        if (node.status === 'running' || node.status === 'starting') wanted.add(node.id);
      });
      const now = Date.now();
      let changed = false;
      for (const id of wanted) {
        const path = byId.get(id)?.rolloutPath;
        if (!path) continue;
        if (now-(agentContextReadAt.get(id) ?? 0) < AGENT_CONTEXT_INTERVAL_MS) continue;
        agentContextReadAt.set(id,now);
        const tokens = await readAgentTokens(path);
        if (closed) return;
        if (tokens.usage || tokens.rate || tokens.spent) agentContext.set(id,tokens); else agentContext.delete(id);
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
  const collectionScope = () => `${tree.rootId}:${activityHub?.tab ?? observability?.tab ?? state.focus}:${JSON.stringify(state.modes)}`;
  const collect = async (force = false) => {
    if (force) { adaptive = forceAdaptivePoll(adaptive); collectionEpoch++; }
    if (closed || collecting) return;
    if (!adaptivePollDue(adaptive, collectionScope(), Date.now())) return;
    const epoch = collectionEpoch;
    await timeAsync('collect',collectNow);
    if (epoch === collectionEpoch) adaptive = recordAdaptivePoll(adaptive, {
      scopeKey: collectionScope(), nowMs: Date.now(), ...collectionObservation(currentHud(), tree),
      succeeded: !currentHud()?.stale && !error && currentHud()?.health?.sessionBound === true,
    });
    else if (!closed) void collect(true);
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
      hudStatus.health.bind(Boolean(session));
      hudStatus.health.read();
      stage = 'tree';
      const rootId = main?.session?.id ?? session?.sessionId ?? '';
      if (rootId !== tree.rootId) {
        state = configuredState(); diff = undefined; diffKey = ''; git = null; gitObservedAt = 0; worktrees = null;
        // Cancel old-root writers before loading the next root's model log. A failed
        // subsequent tree read must never journal the previous session's summaries.
        progress.stop();jobs.stop();briefer.stop();
        agentLog.attach(rootId);agentLogRoot=rootId;
        activityHealthSuccess={tree:0,status:0,worktrees:0};
        agentContext.clear();agentContextReadAt.clear();
        tree = {rootId,nodes:[],totalCount:0,updatedAt:new Date()};
      }
      const priority = treePaths(tree.nodes);
      // The root is not a card node, but its new spawn charges must be read
      // on this tick too, rather than waiting for the quiet-file budget.
      if (session) priority.add(session.path);
      const listed = rootId ? await timeAsync('tree.list', () => findRolloutsInDaysYielding(
        treeLookbackDays(rootId, 3, main?.subagents?.map(agent => agent.id)), priority)) : undefined;
      tree = rootId ? await timeAsync('tree.build',()=>buildSubagentTreeYielding(rootId,main?.subagents ?? [],3,Date.now(),listed)) : {rootId:'',nodes:[],totalCount:0,updatedAt:new Date()};
      treeBuiltFor = rootId;
      markActivitySourceSuccess('tree');
      applyAgentContext();
      jobs.apply(tree,switches(),resolveLanguage(settings.language));
      // On the same tick as the tree, so the log never lags it.
      if (time('agentlog.observe',()=>agentLog.observe(tree))) agentLog.flush();
      timeline = time('timeline',()=>history.timeline(tree,main,logsIn(agentLog.snapshot(),resolveLanguage(settings.language))));
      state = reconcileMonitor(state,tree,git,worktrees);
      updateProgress();
      updateBriefer(settings.briefingPaused);
      updateJobs();
      error = settingsError || null;
    } catch (err) { error = t('Refresh: {reason}',{reason:String(err)}); stale = true; hudStatus.health.fail(stage,err); }
    finally { collecting = false; collected = true; }
    let built: ReturnType<HudStatus['build']> | null = null;
    try { built = hudStatus.build({rollout:main,sessionId:session?.sessionId,stale,tree});markActivitySourceSuccess('status'); }
    catch (err) { hudStatus.health.fail('status',err); /* The foot keeps its last good rows. */ }
    if (built && !stale) {
      notifier.update(built);
      try { snapshotWriter.write(buildSnapshot(built, {width:0,segments:[]})); }
      catch { /* A state file nobody can write is not a reason to stop drawing. */ }
    }
    observeActivity();
    if (observability) sampleTelemetry();
    render();
    readMainCols();
    void refreshInspection();
    void refreshAgentContext();
  };
  const sources = () => worktreeSources(HUD_CWD_REAL,main?.session?.cwd,settings.worktreeRoot,process.env.CODEX_HUD_WORKTREE_ROOT);
  const refreshGit = async () => {
    if (closed) return;
    if (collectingGit) { gitAgain=true; return; }
    // Closed monitors are absent, not empty frames continuously collecting
    // data; in the tabs layout only the pane shown is read for.
    const wantChanges = activityHub?.tab === 'updates' || paneShown(state,'changes') || (paneShown(state,'details') && state.preview === 'file');
    if (!wantChanges && !(paneShown(state,'details') && state.preview === 'worktree')) return;
    collectingGit = true;
    const candidates = sources();
    const requestKey = JSON.stringify(candidates);
    try {
      const snapshot = await timeAsync('git.worktrees',()=>worktreeCollector.refresh(candidates));
      if (closed) return;
      if (requestKey !== JSON.stringify(sources())) { gitAgain=true; return; }
      worktrees = snapshot;
      if (!snapshot.error) markActivitySourceSuccess('worktrees');
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
        git=result;gitRevision++;gitObservedAt=Date.now();
        // While the pane is open, and at most once per floor period.
        jobs.updateChanges(git,{on:jobsOn(),enabled:switches().changeSummary,open:paneShown(state,'changes'),floorMs:settings.recapFloorMs,
          language:resolveLanguage(settings.language),now:Date.now()});
        const previousFile=state.selectedFile;
        state=reconcileMonitor(state,tree,git,worktrees);
        if(previousFile!==state.selectedFile){diff=undefined;diffKey='';}
      } else if (!entry || entry.bare || entry.prunable !== undefined) {git=null;diff=undefined;diffKey='';}
      observeActivity();render();
      void refreshInspection();
    } catch (err) {
      hudStatus.health.fail('worktrees',err);
      worktrees = {sourcePath:null,entries:[],updatedAt:Date.now(),error:'Worktree read failed'};
      git=null;gitObservedAt=0;diff=undefined;diffKey='';observeActivity();render();
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
    progress.stop();
    model.cancelAll();
    probe.cancel();
    agentLog.flush();
    journal.flush();
    flushTreeScans();
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
    snapshotWriter.remove();
    if (user) requestEnsureSingle();
    // Settle bounded local telemetry writes before the terminal process exits.
    void model.flushTelemetry().catch(()=>{}).finally(resolveDone);
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
  const applySettingsDraft = (): boolean => {
    const page = settingsPage;
    if (!page) return false;
    try {
      const previousPrefix = settings.prefixKey;
      settings = saveSettings(page.draft);
      settingsError = ''; error = null;
      applyDisplaySettings(settings);
      setLanguage(resolveLanguage(settings.language));
      configureBriefer();
      jobs.apply(tree,switches(),resolveLanguage(settings.language));
      if (!jobsOn()) jobs.stop();
      armCollect(); loadArt();
      state = {...state,...monitorSettings(settings),tree:{...state.tree,sort:settings.sort,lingerMs:settings.finishedLingerMs},modes:monitorModes(settings),
        zoom:false,statusScroll:0,scroll:{...state.scroll,agents:0},revealed:null};
      updateProgress(); updateBriefer(settings.briefingPaused);
      git=null;diff=undefined;diffKey='';void refreshGit();
      notifier.configure(resolveNotifierOptions(process.env, settings));
      if (settings.prefixKey !== previousPrefix) reinstallPrefix(settings.prefixKey);
      page.message = t('Saved'); page.original = {...settings};
      process.stdout.write(settings.mouse ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1000l\x1b[?1006l');
      void widthKeeper?.apply().then(()=>{lastPaint=null;render();}).catch(err=>{if(settingsPage) settingsPage.message=String(err);render();});
      return true;
    } catch (err) {
      page.message = t('Save failed: {reason}',{reason:String(err)});
      return false;
    }
  };
  const requestSettingsLeave = (destination?: string): boolean => {
    if (settingsPage && settingsDirty(settingsPage)) {
      settingsLeave = {choice:'cancel',destination};
      return false;
    }
    settingsPage = null;
    return true;
  };
  const commandInput = (command: PanelCommand): WorkbenchInput | null => {
    const overlay = settingsPage ? 'settings' : state.help ? 'help' : null;
    if (overlay) {
      const key = overlayKey(command,overlay);
      if (key) return {type:'key',key};
      if (settingsPage && !requestSettingsLeave(monitorKey(command))) return null;
      settingsPage = null;
      state = {...state,help:false};
    }
    return {type:'key',key:monitorKey(command)};
  };
  const dispatch = (inputs: WorkbenchInput[]) => {
    if (inputs.length) void collect(true);
    const overlayBefore = Boolean(settingsPage || state.help || activityHub || observability);
    // What goes to Codex, in order, sent once the whole read is through.
    const forward: ForwardItem[] = [];
    for (let input of inputs) {
      if (closed) break;
      const fromSettings = Boolean(settingsPage);
      let panelInput = input.type === 'command';
      if (input.type === 'mouse' && !settings.mouse) continue;
      if (settingsLeave && confirmationFrame) {
        const dialogInput: WorkbenchInput = input.type === 'command'
          ? {type:'key',key:overlayKey(input.command,'settings') ?? ''} : input;
        const result = handleSettingsConfirmation(settingsLeave,dialogInput,confirmationFrame);
        settingsLeave = {...settingsLeave,...result.state};
        if (!result.action) {render();continue;}
        if (result.action === 'cancel') {settingsLeave=null;render();continue;}
        if (result.action === 'save' && !applySettingsDraft()) {
          settingsLeave.error = settingsPage?.message || t('Could not save settings');
          render();continue;
        }
        const destination = settingsLeave.destination;
        settingsLeave = null; settingsPage = null;
        if (!destination) {updateProgress();render();continue;}
        // Preserve the destination by key, not old mouse coordinates: Save
        // may have changed the pane width and therefore every tab's hit span.
        input = {type:'key',key:destination}; panelInput = true;
      }
      if (activityHub || observability) {
        if (input.type === 'command') {
          const key = overlayKey(input.command,'help');
          if (key) input = {type:'key',key};
          else { activityHub=null; observability=null; exportPreview=undefined; }
        }
        if (activityHub && activityFrame) {
          const tab = activityHub.tab;
          const result = handleActivityHubInput(activityHub,input,activityFrame);
          activityHub = result.state;
          const action = result.action;
          if (action?.type === 'close') { activityHub=null; focusMain(); }
          else if (action?.type === 'read') journal.markRead(action.eventId,action.value);
          else if (action?.type === 'snooze') journal.snooze(action.eventId,action.until);
          else if (action?.type === 'pin') journal.pin(action.agentId,action.value);
          else if (action?.type === 'viewed') journal.markViewed(action.receipt);
          else if (action?.type === 'target') {
            let live = action.agentId === tree.rootId;
            walkNodes(tree.nodes,node=>{if(node.id===action.agentId)live=true;});
            if (live) {
              state={...state,keys:true,focus:'details',preview:action.agentId===tree.rootId?'diagnostics':'agent',
                tree:{...state.tree,selectedId:action.agentId===tree.rootId?state.tree.selectedId:action.agentId,showAll:true},
                modes:{...state.modes,details:'open'},scroll:{...state.scroll,details:0}};
              activityHub=null;
            } else navigationMessage=t('This historical agent is no longer in the current tree');
          }
          updateProgress(); render();
          if (activityHub?.tab === 'updates' && tab !== 'updates') void refreshGit();
          continue;
        }
        if (observability && observabilityFrame) {
          const result = handleObservabilityInput(observability,input,observabilityFrame);
          observability=result.state;
          if (result.action === 'close') { observability=null; exportPreview=undefined; focusMain(); }
          else if (result.action === 'preview') captureExport();
          else if (result.action === 'save' && exportPreview) {
            const saved=saveDiagnosticExport(exportPreview,getCodexHome());
            observability.message=saved.ok ? t('Report saved: {path}',{path:saved.path}) : t('Report could not be saved');
          }
          updateProgress();render();continue;
        }
      }
      if (input.type === 'command') {
        const decoded = commandInput(input.command);
        if (!decoded) {render();continue;}
        input = decoded;
      }
      else if (mainPane && input.type !== 'mouse' && !panelInput) {
        // Focus mode keeps keys here, as an overlay does, without being one:
        // a prefix command is still a panel command.
        const overlay = Boolean(settingsPage || state.help || state.keys);
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
      if (input.type === 'key' && ['activity-hub','find-agent','observability'].includes(input.key)) {
        if (settingsPage && !requestSettingsLeave(input.key)) { render();continue; }
        state={...state,help:false};
        if (input.key === 'observability') { sampleTelemetry();observability=initialObservabilityState();activityHub=null; }
        else { observeActivity();activityHub=initialActivityHubState(input.key==='find-agent'?'find':'inbox');observability=null; }
        exportPreview=undefined;focusPanel();updateProgress();render();continue;
      }
      if (input.type === 'paste') continue;
      if (settingsPage && settingsFrame && input.type === 'mouse' && input.button === 'left') {
        const {x,y} = input;
        const hit = settingsFrame.navigationControls.find(c=>y === c.y && x >= c.x && x < c.x+c.width);
        if (hit) {
          if (hit.kind === 'settings') continue;
          const destination = hit.kind === 'tab' ? hit.pane
            : ({main:'main',help:'help',brief:'brief-toggle',older:'show-all'} as Record<string,string>)[hit.kind];
          if (!destination) continue;
          if (!requestSettingsLeave(destination)) {render();continue;}
          input = {type:'key',key:destination};
        }
      }
      if (settingsPage && settingsFrame) {
        const result = handleSettingsInput(settingsPage,input,settingsFrame);
        settingsPage = result.state;
        probe.invalidate(settingsPage.draft);
        if (result.action === 'back') requestSettingsLeave();
        else if (result.action === 'reset') {
          const group = SETTING_ROWS[settingsPage.selected].group;
          settingsPage = {...settingsPage,draft:resetSettingsGroup(settingsPage.draft,group),
            message:t(group === 'LLM' ? 'Model generation disabled; connection preserved; Save to apply' : 'Group defaults ready; Save to apply')};
        }
        else if (result.action === 'reset-all') settingsPage = {...settingsPage,draft:resetAllPreferences(settingsPage.draft),message:t('Preference defaults ready; model connection preserved and generation paused')};
        else if (result.action === 'save') applySettingsDraft();
        else if (result.action === 'test-api') {
          if (probe.current().running) probe.cancel();
          else void probe.run({...settingsPage.draft}).catch(()=>{
            probe.cancel();
            if (settingsPage) settingsPage.message=t('Connection test failed');
            render();
          });
        }
        else if (result.action === 'diagnostics' && requestSettingsLeave('diagnostics')) {
          state={...state,preview:'diagnostics',focus:'details',modes:{...state.modes,details:'open'},scroll:{...state.scroll,details:0}};
        }
        updateProgress();
        render(); continue;
      }
      const previous = state;
      const result = handleMonitorInput(state,input,{tree,git,worktrees,frame,navigationOverlay:fromSettings});
      state = result.state;
      if (result.close) { finish(true); break; }
      if (state.selectedFile !== previous.selectedFile) { diff=undefined;diffKey=''; }
      if (state.selectedWorktree !== previous.selectedWorktree) {git=null;diff=undefined;diffKey='';}
      if (JSON.stringify(state.modes) !== JSON.stringify(previous.modes)) {
        try { settings=saveSettings(monitorPreferences(state)); }
        catch (err) { settingsError=t('Panel preferences could not be saved: {reason}',{reason:String(err)});error=settingsError; }
      }
      if (result.action?.type === 'brief-toggle' && settings.briefing !== 'off') {
        try {
          settings = saveSettings({briefingPaused:!settings.briefingPaused});
          // Resuming asks at once when there is news, rather than at the next tick.
          if (!settings.briefingPaused) void collect();
          else { updateBriefer(true); jobs.stop(); }
          updateProgress();
        } catch (err) { settingsError=t('Panel preferences could not be saved: {reason}',{reason:String(err)});error=settingsError; }
      }
      if (result.action?.type === 'status-level' && state.statusLevel) {
        try { settings = saveSettings({statusCard:state.statusLevel}); }
        catch (err) { settingsError=t('Panel preferences could not be saved: {reason}',{reason:String(err)});error=settingsError; }
      }
      if (result.action?.type === 'settings') {
        settingsPage={draft:{...settings,...monitorPreferences(state),sort:state.tree.sort??'active'},selected:0,offset:0,message:''};
      }
      if (result.action?.type === 'observability') {
        sampleTelemetry();observability=initialObservabilityState();activityHub=null;exportPreview=undefined;focusPanel();
      }
      if (result.action?.type === 'pick' && input.type === 'mouse') {
        const id = result.action.id;
        const at = Date.now();
        const again = lastClickSwitch?.id === id && at - lastClickSwitch.at < 400;
        lastClickSwitch = again ? undefined : {id, at};
        if (again) {
          if (mainCols !== null && mainCols < 63) navigationMessage = t('The Codex pane is too narrow to show agent IDs; widen it, then try again.');
          else void switchSession(id);
        }
      }
      if (!previous.keys && state.keys) focusPanel();
      if (previous.keys && !state.keys) focusMain();
      updateProgress();
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
    if (!settingsPage) probe.cancel();
    if (!closed && !overlayBefore && (settingsPage || state.help || activityHub || observability)) focusPanel();
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
      lastPaint=null;render();readMainCols();void refreshInspection();
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
    readMainCols();
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
