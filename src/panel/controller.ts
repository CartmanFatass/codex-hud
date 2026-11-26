import * as fs from 'node:fs';
import * as path from 'node:path';
import { ClaudeNativeTree } from '../collectors/claude-native-tree.js';
import { readExpData } from '../collectors/exp-store.js';
import type { HealthSource } from '../collectors/hud-health.js';
import { HudStatus } from '../collectors/hud-status.js';
import { blockedObjectives, ProjectCollector, projectShown } from '../collectors/project-board.js';
import { collectObjectiveEvidence, readObjectives } from '../collectors/objectives.js';
import { HomePortfolioCollector, type HomePortfolio } from '../collectors/home-portfolio.js';
import { HomeCardsCollector, type TodayFacts } from '../collectors/home-cards.js';
import type { ScheduleItem } from '../collectors/schedule.js';
import { ProjectVisits, ProjectOverviews, overviewOf, type ProjectOverview } from '../collectors/project-visits.js';
import { RolloutParser, type RolloutParseResult } from '../collectors/rollout.js';
import { SessionFinder, findRolloutsInDaysYielding, findSessionByThreadId, treeLookbackDays } from '../collectors/session-finder.js';
import { buildSubagentTreeYielding, useTreeScanStore, flushTreeScans } from '../collectors/subagent-tree.js';
import { TreeScanStore } from '../collectors/tree-scan-store.js';
import { worktreeSources, type WorktreesSnapshot } from '../collectors/worktrees.js';
import { makeSourceId } from '../core/identity.js';
import { getHudDisplayHome, getHudHome } from '../hud-home.js';
import { Notifier, resolveNotifierOptions } from '../notify.js';
import { theme } from '../render/colors.js';
import { frameDiff } from '../render/frame-diff.js';
import { t, setLanguage, resolveLanguage } from '../render/i18n.js';
import { controlShown, executionShown, resourcesShown } from '../render/main-tabs.js';
import { renderMonitor, fit, initialMonitorState, handleMonitorInput, type MonitorFrame, type MonitorState } from '../render/monitor.js';
import { acceptsMonitorInput, blocksReload, filterBatchInputs } from '../render/monitor-state.js';
import { projectListOpen } from '../render/project-view.js';
import { projectList } from '../roles/projects.js';
import { roleRegistry } from '../roles/roster.js';
import { parseRosterRoot, formatRosterRoot } from '../roles/selection.js';
import { defaultSettings } from '../settings.js';
import { runtimeSettings, applyDisplaySettings } from '../settings-runtime.js';
import { buildSnapshot, SnapshotWriter } from '../snapshot.js';
import type { SubagentTree } from '../types.js';
import { getCodexHome, getSessionsDir } from '../utils/codex-path.js';
import { collectionObservation } from '../utils/collection-observation.js';
import { withInputRefresh } from '../utils/delegation-actions.js';
import { fileSignature } from '../utils/file-signature.js';
import { readPanelPlace, type PanelReload } from '../utils/panel-reload.js';
import { startProfiling, stopProfiling, time, timeAsync } from '../utils/profile.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import { createPanelActions } from './actions.js';
import { createAgentContext, treePaths } from './agent-context.js';
import { PanelJobPipeline } from './job-pipeline.js';
import { createPanelLifecycle, type InstallCleanup } from './lifecycle.js';
import { createPanelModelDiscovery } from './model-discovery.js';
import { PanelExecution } from './execution.js';
import { countProjectLiveJobs, countProjectWaitingRuns, type ExecutionView } from '../collectors/execution.js';
import { callsByFeature, ModelRuntimeStore } from '../collectors/model-runtime-store.js';
import { computeRepaintDelay, createCollectionScheduler } from './scheduler.js';
import { createSettingsFlow } from './settings-flow.js';

const HUD_CWD = process.env.CODEX_HUD_CWD || process.cwd();
const HUD_CWD_REAL = (() => {
  try {
    return fs.realpathSync(HUD_CWD);
  } catch {
    return HUD_CWD;
  }
})();
const HUD_SESSION_START = (() => {
  const raw = Number(process.env.CODEX_HUD_SESSION_START);
  return Number.isFinite(raw) && raw > 0 ? new Date(raw > 1e12 ? raw : raw * 1000) : null;
})();

/** Coordinate panel state, collection and painting. The terminal loop belongs to the lifecycle. */
export async function runPanel(reload: PanelReload, installCleanup?: InstallCleanup): Promise<void> {
  startProfiling('panel');
  for (const key of [
    'CODEX_HUD_MAIN_PANE',
    'CODEX_HUD_TOGGLE_CMD',
    'CODEX_HUD_TMUX_SESSION',
    'CODEX_HUD_INITIAL_COMMAND',
    'TMUX',
    'TMUX_PANE',
  ])
    delete process.env[key];
  const selectedHarness = process.env.CODEX_HUD_PANEL_HARNESS || '';
  const selectedSource = process.env.CODEX_HUD_PANEL_SOURCE || '';
  if (selectedHarness === 'codex' && selectedSource) process.env.CODEX_HOME = selectedSource;
  const selectedRoot = process.env.CODEX_HUD_PANEL_ROOT
    ? formatRosterRoot(parseRosterRoot(process.env.CODEX_HUD_PANEL_ROOT))
    : null;
  let settings = defaultSettings();
  let settingsError = '';
  let settingsFailure: unknown = null;
  try {
    settings = runtimeSettings();
  } catch (err) {
    settingsFailure = err;
  }
  const place = readPanelPlace(), openedAt = place?.openedAt ?? Date.now();
  const callerPane = (process.env.HERDR_DOCK === '1' ? process.env.HUD_DOCK_CALLER_PANE : process.env.HERDR_PANE_ID) || null;
  const jobPipeline = new PanelJobPipeline(getHudHome(), { project: HUD_CWD_REAL, pane: callerPane });
  const execution = new PanelExecution(jobPipeline.home, callerPane);
  let boundJobRoot = '';
  let scanStoreStarted = false;
  const finder = new SessionFinder(HUD_CWD_REAL, undefined, HUD_SESSION_START);
  const parser = new RolloutParser(40);
  // Project visit state is independent of Home's collectors.
  const visits = new ProjectVisits(HUD_CWD_REAL, (root) => new ProjectCollector(root, jobPipeline.home));
  const portfolioCollector = new HomePortfolioCollector(jobPipeline.home);
  const homeCards = new HomeCardsCollector(jobPipeline.home);
  let portfolio: HomePortfolio | undefined, homeToday: TodayFacts | undefined, openSchedule: readonly ScheduleItem[] | undefined;
  let registered = projectList(jobPipeline.home, HUD_CWD_REAL);
  const projectChoices = () => registered[0]?.root === HUD_CWD_REAL ? registered : [
    { root: HUD_CWD_REAL, name: path.basename(HUD_CWD_REAL) || HUD_CWD_REAL }, ...registered,
  ];
  let projects = projectChoices();
  let projectsAt = Date.now();
  // Light per-project facts for the resident strip and Projects list, refreshed on every visible tab at a 5 s cadence.
  const overviews = new ProjectOverviews((root) => new ProjectCollector(root, jobPipeline.home), HUD_CWD_REAL);
  let overview = new Map<string, ProjectOverview>();
  let overviewAt = -Infinity;
  const listing = (s: MonitorState) => projectShown(s) && projectListOpen(s, projects);
  const shownRoot = () => projects.find((p) => p.root === state.selectedProject)?.root ?? HUD_CWD_REAL;
  // The Project hub, Objective and Feature sub-pages use only ticket activity. Live worker details stay on Execution itself.
  const projectHub = () => projectShown(state, settingsFlow.open) && state.project.view.kind === 'hub';
  const objectiveOpen = (s = state) => !settingsFlow.open && !s.help && s.subpage?.kind === 'objective' ? s.subpage : undefined;
  const featureOpen = (s = state) => !settingsFlow.open && !s.help && s.subpage?.kind === 'feature' ? s.subpage : undefined;
  const subProjectRoot = (s = state) => {
    const obj = objectiveOpen(s);
    if (obj) return obj.target.root;
    const feat = featureOpen(s);
    if (feat) return feat.target.root || shownRoot();
    if (!settingsFlow.open && !s.help && s.subpage?.kind === 'inspector' && s.subpage.from === 'feature') {
      return s.subpage.back?.target.root || shownRoot();
    }
    return undefined;
  };
  const executionPage = () => executionShown(state, settingsFlow.open);
  const executionTargetRoot = () => subProjectRoot() ?? (state.activeTab === 'execution' || projectHub() ? shownRoot() : undefined);
  const executionKept = () => executionTargetRoot() !== undefined;
  const activityOnly = () => !executionPage() && (projectHub() || !!subProjectRoot());
  const syncExecution = () => execution.sync(executionTargetRoot());
  let executionCount: { root: string; count: number } | undefined;
  applyDisplaySettings(settings);
  setLanguage(resolveLanguage(settings.language));
  if (settingsFailure) settingsError = t('Settings: {reason}', { reason: String(settingsFailure) });
  let state = place?.state ?? initialMonitorState();
  let expData = resourcesShown(state) ? readExpData(jobPipeline.home) : undefined;
  // The first read of a long rollout takes seconds; until then say so.
  let collected = false;
  const emptyTree: SubagentTree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date() };
  let tree: SubagentTree | undefined;
  // Binding the calling session and collecting its native tree are separate operations.
  let sessionRoot: string | undefined;
  let main: RolloutParseResult | null = null;
  // Size/mtime/inode as of the last parse: this page runs its own parser over
  // the same rollout as the HUD, so it re-reads nothing while the file is still.
  let lastParsedRollout: string | null = null;
  let worktrees: WorktreesSnapshot | null = null;
  let worktreesRoot: string | undefined;
  let error: string | null = settingsError || null;
  // What the last Control plane key could not do; shown until the next key.
  let roleNotice = '';
  // `w`: the board's saved name (or why not), at the top until the next key.
  let boardNotice = '';
  let frame: MonitorFrame | undefined, frameSource: MonitorState | undefined;
  // Painting derives a place for the rows it drew. Only input and collection adopt it as live state.
  const framePlace = (source: MonitorState): MonitorState => frame && frameSource === source ? frame.state : source;
  let lastPaint: string[] | null = null;
  const lifecycle = createPanelLifecycle(reload);
  const isClosed = () => lifecycle.closed;
  const agentContext = createAgentContext(isClosed);
  const discovery = createPanelModelDiscovery(jobPipeline.home, isClosed);
  const boardFacts = () => jobPipeline.workboard(emptyTree);
  const claudeNative = new ClaudeNativeTree();
  // The bar's fields, for the foot of the panel: the panel replaces the bar
  // while it is open. Fed from this page's own parse of the rollout.
  const hudStatus = new HudStatus(HUD_CWD, () => render(), 30_000);
  const currentHud = () => {
    if (selectedRoot && selectedRoot !== boundJobRoot) return undefined;
    return hudStatus.current() ?? undefined;
  };
  // The panel replaces the bar, so it publishes the same notifications and snapshot.
  const notifier = new Notifier(resolveNotifierOptions(process.env, settings));
  const snapshotWriter = new SnapshotWriter();
  const settingsFlow = createSettingsFlow(settings, place?.settings, {
    current: () => settings,
    apply(saved) {
      settings = saved;
      settingsError = '';
      error = null;
      applyDisplaySettings(settings);
      setLanguage(resolveLanguage(settings.language));
      scheduler.armCollect(settings.refreshMs);
      state = framePlace(state);
      worktrees = null;
      void scheduler.refreshGit();
      notifier.configure(resolveNotifierOptions(process.env, settings));
    },
    setMouseTracking: lifecycle.setMouseTracking,
    repaint: () => render(),
  }, (role) => roleRegistry(jobPipeline.home, shownRoot()).roles().get(role)?.presets?.map(p => p.name) ?? []);
  const projectControlShown = (state: MonitorState, modal = false) => controlShown(state, modal) && state.control.subTab !== 'resources';
  const syncModelListDiscovery = () => discovery.sync(projectControlShown(state, settingsFlow.open));
  const decisions = new ModelRuntimeStore(path.join(getHudDisplayHome(), 'model-cache', 'decision-api'));
  let decisionCalls: { lastHour: number; byFeature: Record<string, number> } | undefined;
  const readDecisionCalls = () => {
    try {
      const byFeature = callsByFeature(decisions.calls(), Date.now());
      decisionCalls = { lastHour: Object.values(byFeature).reduce((sum, n) => sum + n, 0), byFeature };
    } catch { decisionCalls = undefined; }
  };

  const render = () => {
    if (isClosed() || (place && !collected)) return;
    const source = state, painted = framePlace(source);
    // On a switch, the previous snapshot goes with its own root until the new project has been read.
    const control = projectControlShown(painted, settingsFlow.open), chosen = shownRoot();
    const executing = painted.activeTab === 'execution';
    const objRoot = objectiveOpen(painted)?.target.root;
    const featOpen = featureOpen(painted);
    const detailRoot = objRoot ?? (featOpen ? (featOpen.target.root || chosen) : undefined);
    const chosenSnapshot = visits.snapshot(chosen) ?? portfolio?.projects.find((p) => p.root === chosen)?.snapshot;
    const shown = control ? { root: chosen, snapshot: visits.control(chosen) }
      : detailRoot ? { root: detailRoot, snapshot: visits.snapshot(detailRoot) ?? portfolio?.projects.find((p) => p.root === detailRoot)?.snapshot }
      : executing ? { root: chosen, snapshot: chosenSnapshot }
        : painted.activeTab !== 'project' ? { root: HUD_CWD_REAL, snapshot: visits.snapshot(HUD_CWD_REAL) }
          : painted.project.view.kind === 'waiting' ? { root: chosen, snapshot: chosenSnapshot }
            : visits.shown(chosen);
    const waitingRuns = (view?: ExecutionView) => (view?.runs ?? []).filter((run) =>
      run.endedAt === undefined && (run.state === 'paused' || (run.state === 'working' && run.handback?.kind === 'blocker'))).length;
    const execView = executing ? execution.view(chosen) : undefined;
    const liveJobs = (execView ? execView.jobs.length + waitingRuns(execView) : undefined)
      ?? (executionCount?.root === chosen ? executionCount.count : undefined);
    const output = time('render', () => {
      const width = process.stdout.columns || 30, height = process.stdout.rows || 24;
      const settingsLines = settingsFlow.paint(width, height, () => ({
        decisionCalls,
      }), (help, mouse) => {
        frame = renderMonitor({ state: framePlace(help), mouse, width, height });
        frameSource = help;
        return frame.lines;
      });
      if (settingsLines) return settingsLines;
      const nowMs = Date.now();
      const unattendedHandbacks = portfolio?.requests.filter((r) => r.index < 0).length ?? 0;
      const registeredWaiting = overview.size
        ? registered.reduce((sum, p) => sum + (overview.get(p.root)?.waiting ?? 0), 0) + unattendedHandbacks
        : undefined;
      const homeRequestCount = painted.activeTab === 'home' && portfolio
        ? portfolio.requests.length
        : registeredWaiting ?? portfolio?.requests.length;
      const projectWaiting = shown.root === chosen && shown.snapshot
        ? shown.snapshot.waiting.length
        : chosenSnapshot?.waiting.length ?? overview.get(chosen)?.waiting;
      frame = renderMonitor({
        tree,
        // An Inspector opened from Execution or a Feature page reads the project's jobs, which other panes may have dispatched.
        workboard: (((executing && painted.subpage) || (painted.subpage?.kind === 'inspector' && painted.subpage.from === 'feature')) && execution.board()) || boardFacts(),
        execution: executing && (!painted.subpage || painted.subpage.kind === 'run-detail' || painted.subpage.kind === 'station-detail') ? execution.view(chosen) : undefined,
        projectActivity: detailRoot ? execution.activity(detailRoot)
          : projectHub() && shown.root === chosen ? execution.activity(chosen) : undefined,
        projectLandings: featOpen && detailRoot ? execution.landings(detailRoot) : undefined,
        executionCount: liveJobs,
        jobsObserved: jobPipeline.jobsObserved,
        homeWaiting: visits.snapshot(HUD_CWD_REAL)?.waiting,
        homeRequestCount,
        homePortfolio: portfolio,
        homeToday,
        openSchedule,
        mouse: settings.mouse,
        state: painted,
        worktrees: worktreesRoot === chosen && shown.root === chosen ? worktrees : undefined,
        expData: resourcesShown(painted) ? expData : undefined,
        project: shown.snapshot,
        projectDisplayRoot: shown.root,
        projectWaiting,
        projectName: projects.find((p) => p.root === shown.root)?.name ?? path.basename(HUD_CWD_REAL),
        projects: projects.map((p) => ({ ...p, overview: overview.get(p.root) })),
        error,
        publicationNotice: boardNotice || null,
        nowMs,
        hud: currentHud(),
        width,
        height,
      });
      frameSource = source;
      return frame.lines;
    });
    if (lifecycle.reloadFailed) output[output.length - 1] = fit(theme.dim(t('new build failed to load')), process.stdout.columns || 30);
    const update = frameDiff(lastPaint, output);
    lastPaint = output;
    if (update) time('write', () => process.stdout.write(update));
  };
  const repaintAll = () => {
    lastPaint = null;
    render();
  };
  const reloadExp = () => { expData = readExpData(jobPipeline.home); };
  const inspector = () => !settingsFlow.open && !state.help && state.subpage?.kind === 'inspector' ? state.subpage : undefined;
  const nativeInspector = () => !settingsFlow.open && !state.help && state.subpage?.kind === 'native-inspector';
  const workingTree = () => projectShown(state, settingsFlow.open) && state.project.view.kind === 'tree';
  const collectStep = async () => {
    if (settingsFlow.open) settingsFlow.observeUnattended();
    state = framePlace(state);
    let session: Awaited<ReturnType<typeof finder.check>> = null;
    let stale = false;
    // Where a failure happened, for the health row.
    let stage: HealthSource = 'session';
    try {
      if (selectedHarness === 'codex' && selectedRoot && selectedSource) {
        const sid = parseRosterRoot(selectedRoot).sessionId;
        session = findSessionByThreadId(sid, selectedSource);
        boundJobRoot = `${makeSourceId('codex', fs.realpathSync(selectedSource))}/${sid}`;
      } else if (
        selectedHarness === 'codex' ||
        (!selectedHarness && fs.statSync(getSessionsDir(), { throwIfNoEntry: false })?.isDirectory())
      ) {
        session = await finder.check();
        boundJobRoot = session ? `${makeSourceId('codex', fs.realpathSync(getCodexHome()))}/${session.sessionId}` : '';
        if (selectedRoot && selectedRoot !== boundJobRoot) session = null;
      } else boundJobRoot = '';
      const inspect = inspector()?.target;
      await jobPipeline.refresh(inspect?.workerId);
      if (isClosed()) return;
      syncExecution();
      if (!activityOnly()) await execution.refresh(state.activeTab === 'execution' ? inspect?.workerId : undefined);
      if (isClosed()) return;
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
      if (isClosed()) return;
      const rootId = main?.session?.id ?? session?.sessionId ?? selectedRoot ?? '';
      if (rootId !== sessionRoot) {
        if (sessionRoot !== undefined) {
          const { othersExpanded } = state.home;
          state = initialMonitorState();
          state.home.othersExpanded = othersExpanded;
        }
        sessionRoot = rootId;
        worktrees = null;
        agentContext.clear();
        tree = undefined;
      }
      // Neither Home nor the ordinary Jobs list enumerates nearby native transcripts.
      if (nativeInspector()) {
        stage = 'tree';
        if (rootId && session) {
          if (!scanStoreStarted) {
            useTreeScanStore(new TreeScanStore(path.join(getHudDisplayHome(), 'scan')));
            scanStoreStarted = true;
          }
          const priority = treePaths(tree?.nodes ?? []);
          priority.add(session.path);
          const lookback = treeLookbackDays(rootId, 3, main?.subagents?.map((agent) => agent.id));
          const listed = await timeAsync('tree.list', () => findRolloutsInDaysYielding(lookback, priority));
          if (nativeInspector() && !isClosed())
            tree = await timeAsync('tree.build', () => buildSubagentTreeYielding(rootId, main?.subagents ?? [], 3, Date.now(), listed));
        } else if (selectedHarness === 'claude' && selectedRoot && selectedSource) {
          tree = claudeNative.refresh(selectedSource, parseRosterRoot(selectedRoot).sessionId);
        } else tree = emptyTree;
        if (tree && nativeInspector()) agentContext.apply(tree.nodes);
      }
      if (!nativeInspector()) tree = undefined;
      if (isClosed()) return;
      stage = 'status';
      state = framePlace(state);
      const board = boardFacts();
      if (settingsFlow.open) readDecisionCalls();
      const now = Date.now();
      openSchedule = homeCards.readOpenSchedule();
      const shown = projectShown(state, settingsFlow.open), control = projectControlShown(state, settingsFlow.open);
      const visible = !settingsFlow.open && !state.help;
      const home = state.activeTab === 'home' && !state.subpage && visible;
      if (home || (visible && now - projectsAt >= 5000)) {
        projectsAt = now;
        registered = projectList(jobPipeline.home, HUD_CWD_REAL);
        projects = projectChoices();
      }
      // The open list pauses the shown project's full collection (Git included); light overviews refresh at a 5 s cadence
      // on every visible tab (Home derives them from its portfolio reads; modals pause them; opening the list reads at once).
      const full = shown && !listing(state);
      const countRoot = shownRoot();
      const activeExecView = state.activeTab === 'execution' ? execution.view(countRoot) : undefined;
      executionCount = {
        root: countRoot,
        count: (activeExecView ? activeExecView.jobs.length + (activeExecView.runs ?? []).filter((run) =>
          run.endedAt === undefined && (run.state === 'paused' || (run.state === 'working' && run.handback?.kind === 'blocker'))).length : undefined)
          ?? (countProjectLiveJobs(jobPipeline.home, countRoot) + countProjectWaitingRuns(jobPipeline.home, countRoot)),
      };
      if (visible && !home && (projects.length > 1 || !full) && now - overviewAt >= 5000) {
        overviewAt = now;
        overview = await overviews.read(projects.map((p) => p.root), board, now);
      }
      if (home) {
        portfolio = await portfolioCollector.read(registered, board, now);
        homeToday = homeCards.readToday(portfolio.projects, now);
        const own = visits.visit(HUD_CWD_REAL);
        // The tab badge remains pane-project scoped, even if that project isn't registered.
        own.snapshot = portfolio.projects.find((p) => p.root === HUD_CWD_REAL)?.snapshot
          ?? await own.collector.collect('home', board, now);
        const nextOverview = new Map<string, ProjectOverview>();
        for (const entry of portfolio.projects) {
          if (entry.snapshot) nextOverview.set(entry.root, overviewOf(entry.snapshot, entry.snapshot.active.length));
        }
        if (own.snapshot && !nextOverview.has(HUD_CWD_REAL)) {
          nextOverview.set(HUD_CWD_REAL, overviewOf(own.snapshot, own.snapshot.active.length));
        }
        overview = nextOverview;
        overviewAt = now;
      } else if (full || control) {
        const visit = visits.visit(shownRoot());
        const facts = await visit.collector.collect(control ? 'control' : true, board, now);
        if (control) visit.control = facts;
        else {
          visit.snapshot = facts;
          if (facts) overview.set(shownRoot(), overviewOf(facts, facts.active.length));
        }
      } else if (objectiveOpen()?.target.root || featureOpen()) {
        const targetRoot = objectiveOpen()?.target.root ?? (featureOpen()!.target.root || shownRoot());
        const visit = visits.visit(targetRoot);
        const facts = await visit.collector.collect(true, board, now);
        visit.snapshot = facts;
        if (facts) overview.set(targetRoot, overviewOf(facts, facts.active.length));
      }
      // Join Execution's workers to the ticket jobs resolved by this tick's Project scan.
      const activityRoot = activityOnly() ? executionTargetRoot() : undefined;
      if (activityRoot) {
        execution.sync(activityRoot);
        const snapshot = visits.snapshot(activityRoot) ?? portfolio?.projects.find((p) => p.root === activityRoot)?.snapshot;
        const detail = inspector();
        await execution.refresh(detail?.from === 'feature' ? detail.target.workerId : undefined, Date.now(), true, snapshot);
        if (isClosed()) return;
      }
      const currentOverview = overview.get(countRoot);
      if (currentOverview) overview.set(countRoot, { ...currentOverview, running: executionCount.count });
      error = settingsError || roleNotice || null;
    } catch (err) {
      error = t('Refresh: {reason}', { reason: String(err) });
      stale = true;
      hudStatus.health.fail(stage, err);
    } finally {
      collected = true;
    }
    let built: ReturnType<HudStatus['build']> | null = null;
    try {
      built = hudStatus.build({ rollout: main, sessionId: session?.sessionId, stale, tree, skipTree: true, skipGit: true });
    } catch (err) {
      hudStatus.health.fail('status', err); /* The foot keeps its last good rows. */
    }
    if (built && !stale) {
      notifier.update(built);
      try {
        snapshotWriter.write(buildSnapshot(built, { width: 0, segments: [] }));
      } catch {
        /* A state file nobody can write is not a reason to stop drawing. */
      }
    }
    // Collect both EXP readings together; paint only consumes cached facts.
    if (resourcesShown(state) && !settingsFlow.open) reloadExp();
    render();
    const observed = tree;
    if (observed && nativeInspector()) void agentContext.refresh(observed.nodes, frame, () => {
      if (tree !== observed || !nativeInspector()) return;
      agentContext.apply(observed.nodes);
      render();
    });
  };

  const scheduler = createCollectionScheduler(settings.refreshMs, {
    isClosed,
    pollReload: () => lifecycle.pollReload(() => settingsFlow.isDirty() || blocksReload(framePlace(state))),
    restart: () => lifecycle.restart({ state: framePlace(state), openedAt, settings: settingsFlow.place() }),
    collectStep,
    observation() {
      const data = currentHud();
      const native = collectionObservation(data, tree ?? (main?.subagents?.length ? undefined : emptyTree));
      const jobOnly = !boundJobRoot;
      // Outside the native Inspector, polling the pane's jobs does not depend on native activity.
      const boardScope = selectedHarness === 'claude' ? Boolean(selectedRoot && selectedSource && (!nativeInspector() || (tree && !tree.incomplete)))
        : selectedHarness === 'pi' || !selectedRoot;
      const jobQuiet = jobOnly && boardScope && native.activity !== 'active';
      const observation = jobOnly
        ? jobPipeline.observation(tree ?? emptyTree, jobQuiet)
        : { ...native, succeeded: data?.health?.sessionBound === true };
      return {
        scopeKey: `${sessionRoot ?? ''}:${state.subpage?.kind ?? 'main'}`,
        nowMs: Date.now(),
        ...observation,
        fingerprint: JSON.stringify([native.fingerprint, observation.fingerprint]),
        succeeded: observation.succeeded && !data?.stale && !error,
      };
    },
    repaint: render,
    repaintDelay: () => computeRepaintDelay(Date.now(), tree?.nodes ?? [], hudStatus.current(), settingsFlow.open),
    isWorkingTreeOpen: workingTree,
    worktreeSources: () => shownRoot() === HUD_CWD_REAL
      ? worktreeSources(HUD_CWD_REAL, main?.session?.cwd, settings.worktreeRoot, process.env.CODEX_HUD_WORKTREE_ROOT)
      : worktreeSources(shownRoot()),
    onWorktrees(snapshot) { worktrees = snapshot; worktreesRoot = shownRoot(); render(); },
    onWorktreeError: (err) => hudStatus.health.fail('worktrees', err),
  });
  const actions = createPanelActions(jobPipeline.home, HUD_CWD_REAL, visits, {
    get state() { return state; },
    set state(value) { state = value; },
    isClosed, shownRoot, reloadExp,
    projectDisplayRoot: () => frame?.projectDisplayRoot,
    collect: () => { void scheduler.collect(true); },
    repaint: render,
    notice(text) { roleNotice = text; error = text || settingsError || null; },
    boardNotice(text) { boardNotice = text; },
    error(text) { error = text; },
    boardInput: () => ({ workboard: boardFacts() }),
    refreshModels: () => discovery.refresh(true),
    openSettings() {
      readDecisionCalls();
      settingsFlow.show(settings);
    },
  });
  const processInput = (inputs: WorkbenchInput[]) => {
    if (boardNotice && inputs.length) boardNotice = '';
    if (roleNotice && inputs.length) {
      if (error === roleNotice) error = settingsError || null;
      roleNotice = '';
    }
    for (const key of inputs) {
      if (isClosed()) break;
      state = framePlace(state);
      if (actions.expSaving && resourcesShown(state)) continue;
      if (key.type === 'mouse' && !settings.mouse) continue;
      const fromSettings = settingsFlow.open;
      if (!acceptsMonitorInput(fromSettings ? undefined : state, key)) continue;
      const input = settingsFlow.input(key, { frame }, framePlace);
      if (!input) continue;
      const previous = state;
      const wasWorkingTree = workingTree(), priorRoot = shownRoot(), wasNative = nativeInspector(), wasExecution = executionPage(), wasHub = projectHub(), wasSubRoot = subProjectRoot();
      const result = handleMonitorInput(state, input, { frame, navigationOverlay: fromSettings });
      state = result.state;
      const detail = state.subpage;
      if (detail?.kind === 'objective' && !detail.evidence) {
        const { root, objective } = detail.target;
        const cachedSnap = root ? visits.snapshot(root) ?? portfolio?.projects.find((p) => p.root === root)?.snapshot : undefined;
        const freshRecord = cachedSnap?.objectives ?? (root ? readObjectives(root) : undefined);
        const freshObj = freshRecord?.objectives.find((o) => o.id === objective.id);
        if (freshObj) {
          const blocked = cachedSnap
            ? freshObj.state !== 'done' && blockedObjectives(cachedSnap.waiting).has(freshObj.id)
            : detail.target.blocked;
          state = {
            ...state,
            subpage: {
              ...detail,
              target: { root, objective: freshObj, blocked },
              evidence: collectObjectiveEvidence(freshObj, root, jobPipeline.home),
            },
          };
        } else if (detail.target.unavailable) {
          state = { ...state, subpage: { ...detail, evidence: [] } };
        } else {
          state = {
            ...state,
            subpage: {
              ...detail,
              evidence: collectObjectiveEvidence(detail.target.objective, root, jobPipeline.home),
            },
          };
        }
      }
      if (resourcesShown(state) && !resourcesShown(previous)) reloadExp();
      if (workingTree() && (!wasWorkingTree || priorRoot !== shownRoot())) void scheduler.refreshGit();
      if (!nativeInspector()) tree = undefined;
      if (wasNative !== nativeInspector()) void scheduler.collect(true);
      syncExecution();
      if (wasExecution !== executionPage() || (!wasHub && projectHub()) || wasSubRoot !== subProjectRoot() || (executionKept() && priorRoot !== shownRoot())) void scheduler.collect(true);
      if (!listing(previous) && listing(state)) overviewAt = -Infinity;
      if ((projectShown(state) && (!projectShown(previous) || listing(previous) !== listing(state) || priorRoot !== shownRoot())) ||
        (projectControlShown(state) && (!projectControlShown(previous) || state.selectedProject !== previous.selectedProject)) ||
        ((state.subpage?.kind === 'inspector' || previous.subpage?.kind === 'inspector') &&
          (state.subpage?.kind !== previous.subpage?.kind || !!state.help !== !!previous.help ||
            (state.subpage?.kind === 'inspector' && previous.subpage?.kind === 'inspector' && state.subpage.target !== previous.subpage.target)))) void scheduler.collect(true);
      if (result.close) {
        lifecycle.finish();
        break;
      }
      actions.execute(result.action, previous);
      render();
    }
    syncModelListDiscovery();
  };
  const dispatch = (all: WorkbenchInput[]) => {
    const inputs = filterBatchInputs(settingsFlow.open ? undefined : framePlace(state), all);
    return withInputRefresh(
      inputs.length > 0,
      () => processInput(inputs),
      () => {
        if (!isClosed()) void scheduler.collect(true);
      }
    );
  };
  await lifecycle.run(settings.mouse, {
    input: dispatch,
    resize: repaintAll,
    start() {
      render();
      syncModelListDiscovery();
      scheduler.start(settings.refreshMs);
    },
    dispose() {
      jobPipeline.dispose();
      execution.dispose();
      finder.stop();
      discovery.dispose();
      if (scanStoreStarted) flushTreeScans();
      scheduler.stop();
      stopProfiling();
    },
    removeSnapshot: () => snapshotWriter.remove(),
  }, installCleanup);
}
