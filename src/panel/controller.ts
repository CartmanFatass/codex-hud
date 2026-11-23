import * as fs from 'node:fs';
import * as path from 'node:path';
import { ClaudeNativeTree } from '../collectors/claude-native-tree.js';
import { readExpData } from '../collectors/exp-store.js';
import type { HealthSource } from '../collectors/hud-health.js';
import { HudStatus } from '../collectors/hud-status.js';
import { ProjectCollector, projectShown } from '../collectors/project-board.js';
import { ProjectVisits, ProjectOverviews, type ProjectOverview } from '../collectors/project-visits.js';
import { RolloutParser, type RolloutParseResult } from '../collectors/rollout.js';
import { SessionFinder, findRolloutsInDaysYielding, findSessionByThreadId, treeLookbackDays } from '../collectors/session-finder.js';
import { buildSubagentTreeYielding, useTreeScanStore, flushTreeScans } from '../collectors/subagent-tree.js';
import { TreeScanStore } from '../collectors/tree-scan-store.js';
import { TryLog } from '../collectors/try-records.js';
import { worktreeSources, type WorktreesSnapshot } from '../collectors/worktrees.js';
import { makeSourceId } from '../core/identity.js';
import { getHudDisplayHome, getHudHome } from '../hud-home.js';
import { Notifier, resolveNotifierOptions } from '../notify.js';
import { theme } from '../render/colors.js';
import { frameDiff } from '../render/frame-diff.js';
import { t, setLanguage, resolveLanguage } from '../render/i18n.js';
import { controlShown, expShown } from '../render/main-tabs.js';
import { renderMonitor, fit, initialMonitorState, handleMonitorInput, type MonitorFrame, type MonitorState } from '../render/monitor.js';
import { acceptsMonitorInput, applyViewPrefs, blocksReload, filterBatchInputs, onlyTry, reconcileMonitor } from '../render/monitor-state.js';
import { projectListOpen, projectPageOf } from '../render/project-view.js';
import { projectList } from '../roles/projects.js';
import { parseRosterRoot, formatRosterRoot } from '../roles/selection.js';
import { defaultSettings, saveSettings } from '../settings.js';
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
import { createPanelModelServices } from './model-services.js';
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
  const place = readPanelPlace(settings), openedAt = place?.openedAt ?? Date.now();
  const jobPipeline = new PanelJobPipeline(getHudHome(), {
    project: HUD_CWD_REAL,
    pane: process.env.HUD_PANEL_CALLER_PANE || process.env.HERDR_PANE_ID || null,
  }, openedAt);
  let boundJobRoot = '';
  // Opened again, the panel reads only what each rollout gained since it last saved its scan.
  useTreeScanStore(new TreeScanStore(path.join(getHudDisplayHome(), 'scan')));
  const finder = new SessionFinder(HUD_CWD_REAL, undefined, HUD_SESSION_START);
  const parser = new RolloutParser(40);
  // One collector per project the tab has shown (this one's always); Home reads only the panel's own.
  const visits = new ProjectVisits(HUD_CWD_REAL, (root) => new ProjectCollector(root, jobPipeline.home));
  const tries = new TryLog(jobPipeline.home);
  let projects = projectList(jobPipeline.home, HUD_CWD_REAL);
  let projectsAt = Date.now();
  // The Projects list reads every listed project lightly, and only while it is open.
  const overviews = new ProjectOverviews((root) => new ProjectCollector(root, jobPipeline.home), HUD_CWD_REAL);
  let overview = new Map<string, ProjectOverview>();
  let overviewAt = -Infinity;
  const listing = (s: MonitorState) => projectShown(s) && projectListOpen(s, projects);
  const shownRoot = () => projects.find((p) => p.root === state.selectedProject)?.root ?? HUD_CWD_REAL;
  applyDisplaySettings(settings);
  setLanguage(resolveLanguage(settings.language));
  if (settingsFailure) settingsError = t('Settings: {reason}', { reason: String(settingsFailure) });
  let state = reconcileMonitor(place?.state ?? initialMonitorState(settings));
  let expData = expShown(state) ? readExpData(jobPipeline.home) : undefined;
  // The first read of a long rollout takes seconds; until then say so.
  let collected = false;
  let tree: SubagentTree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date() };
  // Don't reset the restored panel place on the first tree build.
  let treeBuilt = false;
  let main: RolloutParseResult | null = null;
  // Size/mtime/inode as of the last parse: this page runs its own parser over
  // the same rollout as the HUD, so it re-reads nothing while the file is still.
  let lastParsedRollout: string | null = null;
  let worktrees: WorktreesSnapshot | null = null;
  let error: string | null = settingsError || null;
  // What the last Control plane key could not do; shown until the next key.
  let roleNotice = '';
  // `w`: the board's saved name (or why not), at the top until the next key.
  let boardNotice = '';
  let frame: MonitorFrame | undefined, frameSource: MonitorState | undefined;
  // Painting derives a place for the rows it drew. Only input and collection adopt it as live state.
  const framePlace = (source: MonitorState): MonitorState => frame && frameSource === source ? frame.state : source;
  let lastPaint: string[] | null = null;
  const lifecycle = createPanelLifecycle(reload, place?.widthOverride, () => settings.treeWidth);
  const isClosed = () => lifecycle.closed;
  const agentContext = createAgentContext(isClosed);
  const models = createPanelModelServices(jobPipeline.home, () => render(), isClosed);
  const displayBoard = () => models.apply(jobPipeline.workboard(tree));
  const claudeNative = new ClaudeNativeTree();
  models.configure(settings);
  // The bar's fields, for the foot of the panel: the panel replaces the bar
  // while it is open. Fed from this page's own parse of the rollout.
  const hudStatus = new HudStatus(HUD_CWD, () => render(), 30_000);
  const currentHud = () => {
    if (selectedRoot && selectedRoot !== boundJobRoot) return undefined;
    const data = hudStatus.current();
    return data ? { ...data, modelHealth: models.modelHealth() } : undefined;
  };
  // The panel replaces the bar, so it publishes the same notifications and snapshot.
  const notifier = new Notifier(resolveNotifierOptions(process.env, settings));
  const snapshotWriter = new SnapshotWriter();
  const settingsFlow = createSettingsFlow(settings, place?.settings, models.probe, {
    current: () => settings,
    apply(saved, widthChanged) {
      settings = saved;
      if (widthChanged) lifecycle.clearWidthOverride();
      settingsError = '';
      error = null;
      applyDisplaySettings(settings);
      setLanguage(resolveLanguage(settings.language));
      models.configure(settings);
      scheduler.armCollect(settings.refreshMs);
      state = applyViewPrefs(framePlace(state), settings);
      if (!settings.experiments) expData = undefined;
      worktrees = null;
      void scheduler.refreshGit();
      notifier.configure(resolveNotifierOptions(process.env, settings));
    },
    setMouseTracking: lifecycle.setMouseTracking,
    applyWidth: lifecycle.applyWidth,
    repaint: () => render(),
    repaintAll: () => repaintAll(),
  });
  const syncModelListDiscovery = () => models.syncDiscovery(controlShown(state, settingsFlow.open));

  const render = () => {
    if (isClosed() || (place && !collected)) return;
    const source = state, painted = framePlace(source);
    // On a switch, the previous snapshot goes with its own root until the new project has been read.
    const control = controlShown(painted, settingsFlow.open), chosen = shownRoot();
    const shown = control ? { root: chosen, snapshot: visits.control(chosen) }
      : painted.activeTab === 'project' ? visits.shown(chosen) : { root: HUD_CWD_REAL, snapshot: visits.snapshot(HUD_CWD_REAL) };
    const page = projectPageOf(painted);
    const taskMode = painted.prefs.acceptance !== 'slice';
    const showTries = taskMode || painted.prefs.panelLayout === 'split' || painted.prefs.projectLayout === 'board' || painted.prefs.projectLayout === 'inbox' ? !page || page === 'progress' : !!onlyTry(painted.project.view);
    const homeTries = taskMode && painted.activeTab === 'home' && !painted.subpage && !painted.help && !settingsFlow.open;
    const tryMarks = (homeTries || projectShown(painted, settingsFlow.open) && !listing(painted) && showTries) && shown.snapshot
      ? tries.marks(shown.root, shown.snapshot.ledger) : undefined;
    const output = time('render', () => {
      const width = process.stdout.columns || 30, height = process.stdout.rows || 24;
      const settingsLines = settingsFlow.paint(width, height, () => ({
        state: hudStatus.health.current(), modelCalls: models.modelCalls(), decisionCalls: models.decisionCalls(),
      }), (help, mouse) => {
        frame = renderMonitor({ tree, state: framePlace(help), mouse, width, height });
        frameSource = help;
        return frame.lines;
      });
      if (settingsLines) return settingsLines;
      const nowMs = Date.now();
      frame = renderMonitor({
        tree,
        workboard: displayBoard(),
        workerCounts: jobPipeline.workerCounts.counts(),
        modelEnabled: settings.modelEnabled,
        mouse: settings.mouse,
        state: painted,
        worktrees,
        expData: expShown(painted) ? expData : undefined,
        project: control ? shown.snapshot : models.waitingBriefs.project(models.tryBriefs.apply(shown.root, shown.snapshot)),
        projectDisplayRoot: shown.root,
        projectWaiting: control ? visits.snapshot(chosen)?.waiting.length : undefined,
        tryMarks,
        projectName: projects.find((p) => p.root === shown.root)?.name ?? path.basename(HUD_CWD_REAL),
        projects: listing(painted) ? projects.map((p) => ({ ...p, overview: overview.get(p.root) })) : projects,
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
  const collectStep = async () => {
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
      await jobPipeline.refresh(inspect?.kind === 'worker' ? inspect.workerId : undefined, state.prefs.cardStallMinutes);
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
      stage = 'tree';
      const claude =
        selectedRoot && process.env.CODEX_HUD_PANEL_HARNESS === 'claude' && process.env.CODEX_HUD_PANEL_SOURCE
          ? claudeNative.refresh(process.env.CODEX_HUD_PANEL_SOURCE, parseRosterRoot(selectedRoot).sessionId)
          : undefined;
      const rootId = main?.session?.id ?? session?.sessionId ?? claude?.rootId ?? selectedRoot ?? '';
      if (rootId !== tree.rootId) {
        if (treeBuilt) state = initialMonitorState(settings);
        worktrees = null;
        models.leaveRoot();
        agentContext.clear();
        tree = { rootId, nodes: [], totalCount: 0, updatedAt: new Date() };
      }
      const priority = treePaths(tree.nodes);
      // The root is not a card node, but its new spawn charges must be read
      // on this tick too, rather than waiting for the quiet-file budget.
      if (session) priority.add(session.path);
      const listed =
        rootId && !!session
          ? await timeAsync('tree.list', () =>
              findRolloutsInDaysYielding(
                treeLookbackDays(rootId, 3, main?.subagents?.map((agent) => agent.id)),
                priority
              )
            )
          : undefined;
      tree =
        rootId && !!session
          ? await timeAsync('tree.build', () =>
              buildSubagentTreeYielding(rootId, main?.subagents ?? [], 3, Date.now(), listed)
            )
          : (claude ?? { rootId, nodes: [], totalCount: 0, updatedAt: new Date() });
      if (isClosed()) return;
      treeBuilt = true;
      agentContext.apply(tree.nodes);
      state = reconcileMonitor(framePlace(state));
      const board = jobPipeline.workboard(tree);
      models.update(board, tree, inspector());
      // Only the shown project is collected; the list of projects is read again at most every five seconds.
      const shown = projectShown(state, settingsFlow.open), control = controlShown(state, settingsFlow.open);
      if ((shown || control) && Date.now() - projectsAt >= 5000) {
        projectsAt = Date.now();
        projects = projectList(jobPipeline.home, HUD_CWD_REAL);
      }
      // The open list reads the light overviews instead of the shown project's full collection (Git included), at most once
      // per five seconds; opening it again reads at once.
      const full = shown && !listing(state);
      if (shown && !full) {
        if (Date.now() - overviewAt >= 5000) {
          overviewAt = Date.now();
          overview = await overviews.read(projects.map((p) => p.root), board, Date.now());
        }
      } else overviewAt = -Infinity;
      const root = shown || control ? shownRoot() : HUD_CWD_REAL;
      const visit = visits.visit(root);
      const projectFacts = await visit.collector.collect(
        control ? 'control' : shown ? full : !state.subpage && !state.help && !settingsFlow.open
          ? state.prefs.acceptance === 'slice' ? 'home' : 'home-tasks'
          : false,
        jobPipeline.workboard(tree),
        Date.now()
      );
      if (projectFacts) {
        if (control) visit.control = projectFacts;
        else visit.snapshot = projectFacts;
      }
      const stillShown = () => !isClosed() && !state.subpage && !state.help && !settingsFlow.open &&
        (state.activeTab === 'home' ? root === HUD_CWD_REAL : projectShown(state) && !listing(state) && shownRoot() === root);
      if (projectFacts && !control && stillShown()) {
        models.tryBriefs.update(root, projectFacts.ledger, stillShown);
        models.waitingBriefs.update(board, projectFacts, state.prefs.acceptance === 'slice' || projectShown(state));
      } else if (inspector() && !settingsFlow.open) models.waitingBriefs.update(board);
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
      built = hudStatus.build({ rollout: main, sessionId: session?.sessionId, stale, tree, skipGit: true });
    } catch (err) {
      hudStatus.health.fail('status', err); /* The foot keeps its last good rows. */
    }
    if (built && !stale) {
      notifier.update(built, Date.now(), jobPipeline.workboard(tree));
      try {
        snapshotWriter.write(buildSnapshot(built, { width: 0, segments: [] }));
      } catch {
        /* A state file nobody can write is not a reason to stop drawing. */
      }
    }
    // Collect both EXP readings together; paint only consumes cached facts.
    if (expShown(state) && !settingsFlow.open) reloadExp();
    render();
    void agentContext.refresh(tree.nodes, state.subpage, frame, () => {
      agentContext.apply(tree.nodes);
      tree = { ...tree };
      render();
    });
  };

  const scheduler = createCollectionScheduler(settings.refreshMs, {
    isClosed,
    pollReload: () => lifecycle.pollReload(() => settingsFlow.isDirty() || blocksReload(framePlace(state))),
    restart: () => lifecycle.restart({ state: framePlace(state), openedAt, widthOverride: lifecycle.widthOverride ?? null, settings: settingsFlow.place() }),
    collectStep,
    observation() {
      const data = currentHud();
      const native = collectionObservation(data, tree);
      const jobOnly = !boundJobRoot;
      // The board checks Claude subagent coverage and activity. Pi has only HUD jobs here.
      const boardScope = selectedHarness === 'claude' ? Boolean(selectedRoot && selectedSource)
        : selectedHarness === 'pi' || (!selectedRoot && !tree.nodes.length);
      const jobQuiet = jobOnly && boardScope && native.activity !== 'active';
      const observation = jobOnly
        ? jobPipeline.observation(tree, jobQuiet)
        : { ...native, succeeded: data?.health?.sessionBound === true };
      return {
        scopeKey: `${tree.rootId}:${state.subpage?.kind ?? 'main'}`,
        nowMs: Date.now(),
        ...observation,
        fingerprint: JSON.stringify([native.fingerprint, observation.fingerprint]),
        succeeded: observation.succeeded && !data?.stale && !error,
      };
    },
    repaint: render,
    repaintDelay: () => computeRepaintDelay(Date.now(), tree.nodes, hudStatus.current(), settingsFlow.open),
    isChangesFocused: () => state.subpage?.kind === 'changes',
    worktreeSources: () => worktreeSources(HUD_CWD_REAL, main?.session?.cwd, settings.worktreeRoot, process.env.CODEX_HUD_WORKTREE_ROOT),
    onWorktrees(snapshot) { worktrees = snapshot; render(); },
    onWorktreeError: (err) => hudStatus.health.fail('worktrees', err),
  });
  models.onChange(() => {
    scheduler.invalidate();
    render();
    void scheduler.collect(true);
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
    boardInput: () => ({ acceptance: settings.acceptance, workboard: displayBoard(), briefs: models.tryBriefs }),
    refreshModels: () => models.refreshModelLists(true),
    toggleBriefs() {
      try {
        settings = saveSettings({ modelEnabled: !settings.modelEnabled });
        models.configure(settings);
        if (models.enabled) void scheduler.collect();
      } catch (err) {
        settingsError = t('Panel preferences could not be saved: {reason}', { reason: String(err) });
        error = settingsError;
      }
    },
    openSettings: () => settingsFlow.show(settings),
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
      if (actions.expSaving && expShown(state)) continue;
      if (key.type === 'mouse' && !settings.mouse) continue;
      const fromSettings = settingsFlow.open;
      if (!acceptsMonitorInput(fromSettings ? undefined : state, key)) continue;
      const input = settingsFlow.input(key, { tree, frame }, framePlace);
      if (!input) continue;
      const previous = state;
      const result = handleMonitorInput(state, input, { tree, frame, navigationOverlay: fromSettings });
      state = result.state;
      if (expShown(state) && !expShown(previous)) reloadExp();
      if (previous.subpage?.kind !== 'changes' && state.subpage?.kind === 'changes') void scheduler.refreshGit();
      if ((projectShown(state) && (!projectShown(previous) || listing(previous) !== listing(state))) ||
        (controlShown(state) && (!controlShown(previous) || state.selectedProject !== previous.selectedProject)) ||
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
    settingsFlow.afterInput();
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
      finder.stop();
      models.dispose();
      flushTreeScans();
      scheduler.stop();
      stopProfiling();
    },
    removeSnapshot: () => snapshotWriter.remove(),
  }, installCleanup);
}
