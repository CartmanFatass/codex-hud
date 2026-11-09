import { nativeCallsOnly } from './core/link/view-model.js';
import { pathToFileURL } from 'node:url';
import { makeSourceId } from './core/identity.js';
import { externalRootHash } from './roles/external-association.js';
import { parseRosterRoot, formatRosterRoot } from './roles/selection.js';
import type { SessionRef } from './core/types/identity.js';
import { JobObservationCollector, type JobObserverOptions, type JobReadSlice } from './collectors/job-observations.js';
import type { JobSnapshot } from './collectors/job-display-types.js';
import { TaskObservationCollector } from './collectors/task-observations.js';
import { buildWorkboard } from './collectors/workboard.js';
import type { TaskSnapshot, WorkboardSnapshot } from './collectors/workboard-types.js';
import { composeJobTree, type JobTreeResult } from './collectors/job-tree.js';
import { NativeCallCollector } from './collectors/native-calls.js';
import { performance } from 'node:perf_hooks';
import { HudDelegationCollector, withDelegationObservation } from './collectors/delegation.js';
import {
  PanelHostController,
  panelHostTarget,
  panelHostStamp,
  withPanelHostAvailability,
} from './integrations/herdr/panel-host.js';
import { DelegationLogView, type LogFrame } from './utils/delegation-log-view.js';
import { initialParserState } from './core/observation.js';
import type { DelegationViewModel } from './core/link/view-model.js';
/** Live keyboard/mouse workbench beside the compact HUD. */
import { navigateSession } from './utils/session-navigation.js';
import {
  dispatchDelegationAction,
  createClipboardProvider,
  withInputRefresh,
  delegationActivityTarget,
  createNavigationGate,
  revealDelegationAncestors,
  createOpenGate,
  sameDelegationActionTarget,
  boundedActionNotice,
} from './utils/delegation-actions.js';
import { defaultSettings, saveSettings, briefingScope, settingsPath, type HudSettings } from './settings.js';
import { homedir } from 'node:os';
import { runtimeSettings, applyDisplaySettings, withDisplaySettings } from './settings-runtime.js';
import { treeWidthKeeper } from './utils/pane-width.js';
import { frameDiff } from './render/frame-diff.js';
import {
  renderSettingsPage,
  handleSettingsInput,
  settingsDirty,
  resetSettingsGroup,
  resetAllPreferences,
  SETTING_ROWS,
  type SettingsPageState,
  type SettingsFrame,
} from './render/settings-page.js';
import {
  renderSettingsConfirmation,
  handleSettingsConfirmation,
  type SettingsConfirmationState,
  type SettingsConfirmationFrame,
} from './render/settings-confirmation.js';
import { spawn, execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SessionFinder,
  findRolloutsInDaysYielding,
  treeLookbackDays,
  recentSessions,
} from './collectors/session-finder.js';
import { RolloutParser, type RolloutParseResult } from './collectors/rollout.js';
import {
  buildSubagentTreeYielding,
  uniquePickerLabel,
  useTreeScanStore,
  flushTreeScans,
} from './collectors/subagent-tree.js';
import { TreeScanStore } from './collectors/tree-scan-store.js';
import { collectGitChanges, readGitDiff, readDiffHunks, type GitChanges } from './collectors/git-changes.js';
import { WorktreeCollector, worktreeSources, type WorktreesSnapshot } from './collectors/worktrees.js';
import {
  renderMonitor,
  initialMonitorState,
  reconcileMonitor,
  handleMonitorInput,
  canMonitorDiff,
  monitorModes,
  monitorSettings,
  monitorPreferences,
  nextRepaintDelay,
  msUntilAgeChanges,
  msUntilCountdownChanges,
  finishedAt,
  paneShown,
  panelTop,
  type MonitorFrame,
} from './render/monitor.js';
import { WorkbenchInputDecoder, type WorkbenchInput } from './utils/workbench-input.js';
import { isPanelCommand, monitorKey, overlayKey, prefixName, type PanelCommand } from './utils/panel-command.js';
import { KeyForwarder, type ForwardItem } from './utils/key-forward.js';
import { PublicationWorker } from './core/link/publication-worker.js';
import { fileSignature } from './utils/file-signature.js';
import { readAgentTokens, type AgentTokens } from './collectors/agent-context.js';
import { Briefer } from './collectors/briefing.js';
import { SmallModel } from './collectors/small-model.js';
import { ModelProbe } from './collectors/model-probe.js';
import { hudProblems, diagnosticLines } from './render/hud-diagnostics.js';
import { ActivityJournal } from './collectors/activity-journal.js';
import {
  initialActivityHubState,
  renderActivityHub,
  handleActivityHubInput,
  type ActivityHubState,
  type ActivityHubFrame,
  type RecentSessionRow,
} from './render/activity-hub.js';
import {
  initialObservabilityState,
  renderObservabilityPage,
  handleObservabilityInput,
  type ObservabilityState,
  type ObservabilityFrame,
} from './render/observability-page.js';
import {
  createDiagnosticExportPreview,
  saveDiagnosticExport,
  type DiagnosticExportPreview,
} from './diagnostics/diagnostic-export.js';
import { captureRuntimeIdentity } from './diagnostics/runtime-identity.js';
import { modelTelemetryLines } from './render/model-telemetry.js';
import type { ModelTelemetrySummary } from './collectors/model-telemetry.js';
import {
  createAdaptivePollState,
  adaptivePollDue,
  forceAdaptivePoll,
  recordAdaptivePoll,
} from './collectors/adaptive-poll.js';
import { collectionObservation } from './utils/collection-observation.js';
import { scopedActivityObservation } from './utils/activity-observation.js';
import { ProgressSummarizer, progressTargets } from './collectors/progress-summary.js';
import { cardSummaryTargets } from './render/cards.js';
import { controlBar } from './render/control-bar.js';
import { RecapStore } from './collectors/recap.js';
import { AgentLog, logsIn } from './collectors/agent-log.js';
import {
  ModelJobs,
  NO_JOBS,
  jobOnlyNode,
  summaryTree,
  displayOnlySummaryRoot,
  type JobSwitches,
} from './collectors/model-jobs.js';
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

/** The live refresh and tests share this lifecycle: no I/O in compose/afterPaint. */
export class PanelJobPipeline {
  private observer: JobObservationCollector;
  private artifacts: TaskObservationCollector;
  private taskSnapshot: TaskSnapshot | null = null;
  private boardCache?: {
    tree: SubagentTree;
    legacy: DelegationViewModel | null;
    jobs: JobSnapshot | null;
    tasks: TaskSnapshot | null;
    board: WorkboardSnapshot;
  };
  private snapshot: JobSnapshot | null = null;
  private generation = 0;
  private closed = false;
  constructor(
    readonly home: string,
    private root: string | null,
    private readonly options: JobObserverOptions = {},
    private readonly workspace: string | null = null
  ) {
    this.observer = new JobObservationCollector(home, { ...options, root });
    this.artifacts = new TaskObservationCollector(workspace);
  }
  setRoot(root: string | null): void {
    if (root === this.root) return;
    this.generation++;
    this.root = root;
    this.snapshot = null;
    this.observer.dispose();
    this.artifacts.dispose();
    this.taskSnapshot = null;
    this.boardCache = undefined;
    this.artifacts = new TaskObservationCollector(this.workspace);
    this.observer = new JobObservationCollector(this.home, { ...this.options, root });
  }
  dispose(): void {
    this.closed = true;
    this.generation++;
    this.snapshot = null;
    this.taskSnapshot = null;
    this.boardCache = undefined;
    this.artifacts.dispose();
    this.observer.dispose();
  }
  get artifactCost() {
    return this.taskSnapshot?.cost;
  }
  workboard(tree: SubagentTree, legacy: DelegationViewModel | null = null): WorkboardSnapshot {
    const cached = this.boardCache;
    if (
      cached &&
      cached.tree === tree &&
      cached.legacy === legacy &&
      cached.jobs === this.snapshot &&
      cached.tasks === this.taskSnapshot
    )
      return cached.board;
    const jobs = this.snapshot ?? {
      generation: this.generation,
      root: this.root,
      jobs: [],
      coverage: { entries: 0, files: 0, bytes: 0, incomplete: true, omitted: null, diagnostics: [] },
    };
    const tasks = this.taskSnapshot ?? {
      revision: 0,
      lanes: [],
      coverage: { incomplete: true, workspace: this.workspace, diagnostics: [] },
      cost: { entries: 0, files: 0, bytes: 0, probes: 0, enumerations: 0, parses: 0, elapsedMs: 0 },
    };
    const board = buildWorkboard(this.observer.home, tasks, jobs, tree, legacy);
    this.boardCache = { tree, legacy, jobs: this.snapshot, tasks: this.taskSnapshot, board };
    return board;
  }
  get live() {
    return this.observer.live;
  }
  async refresh(
    charge?: (bytes: number, entries: number, elapsed: number) => void,
    slice?: JobReadSlice
  ): Promise<boolean> {
    const generation = this.generation;
    const start = performance.now();
    const snapshot = await this.observer.refresh({ ...slice, maxFiles: 24, maxEntries: 112 });
    if (this.closed || generation !== this.generation) return false;
    const tasks = this.artifacts.refresh(snapshot.jobs, this.observer.home, {
      deadline: slice?.deadline,
      maxFiles: 32 - snapshot.coverage.files,
      maxEntries: 128 - snapshot.coverage.entries,
      maxBytes: Math.max(0, Math.min(1024 * 1024, slice?.maxBytes ?? 1024 * 1024) - snapshot.coverage.bytes),
    });
    this.snapshot = snapshot;
    this.taskSnapshot = tasks;
    charge?.(
      snapshot.coverage.bytes + tasks.cost.bytes,
      snapshot.coverage.entries + snapshot.coverage.files + tasks.cost.entries + tasks.cost.files + tasks.cost.probes,
      performance.now() - start
    );
    return true;
  }
  afterPaint(tree: SubagentTree, legacy: DelegationViewModel | null, nowMs: number, boundRoot?: string): JobTreeResult {
    return this.compose(tree, legacy, nowMs, boundRoot);
  }
  /** Always recompose from the unmodified native tree and newly committed legacy view. */
  compose(tree: SubagentTree, legacy: DelegationViewModel | null, nowMs: number, boundRoot?: string): JobTreeResult {
    const snapshot = this.snapshot ?? {
      generation: this.generation,
      root: this.root,
      jobs: [],
      coverage: {
        entries: 0,
        files: 0,
        bytes: 0,
        incomplete: true,
        omitted: null,
        diagnostics: [],
      },
    };
    if (this.closed) return { tree, legacy, aliases: {}, coverage: snapshot.coverage, diagnostics: [] };
    const nativeRefs = new Map<string, SessionRef>();
    if (boundRoot && boundRoot.endsWith(`/${tree.rootId}`)) {
      const sourceId = boundRoot.slice(0, boundRoot.indexOf('/'));
      const add = (id: string) => nativeRefs.set(id, { harness: 'codex', sourceId, sessionId: id, threadId: null });
      add(tree.rootId);
      walkNodes(tree.nodes, (node) => {
        if (!node.ref && !jobOnlyNode(node)) add(node.id);
      });
    }
    if (this.root !== null) {
      if (legacy) {
        const admitted = new Set(
          legacy.tree.nodes
            .filter(
              (node) =>
                node.parentKey === null &&
                node.identity.kind === 'session' &&
                `${node.identity.ref.sourceId}/${node.identity.ref.sessionId}` === this.root
            )
            .map((node) => node.key)
        );
        for (let n = 0; n < legacy.tree.nodes.length; n++)
          for (const node of legacy.tree.nodes)
            if (node.parentKey && admitted.has(node.parentKey)) admitted.add(node.key);
        const scoped = legacy.tree.nodes.filter((node) => admitted.has(node.key));
        legacy = {
          ...legacy,
          tree: {
            ...legacy.tree,
            nodes: scoped,
            counts: {
              ...legacy.tree.counts,
              confirmedSessions: scoped.filter((node) => node.identity.kind === 'session').length,
              jobs: scoped.filter((node) => node.identity.kind === 'job').length,
            },
          },
        };
      }
      return composeJobTree({ tree, legacy, snapshot, root: this.root, nowMs, nativeRefs });
    }
    const roots = new Set(snapshot.jobs.map((job) => job.root));
    const nodes = tree.nodes.map((node) => ({ ...node, children: [...node.children] }));
    const aliases: Record<string, string> = {};
    const diagnostics: string[] = [];
    let incomplete = snapshot.coverage.incomplete;
    const remaining = () => {
      let count = legacy?.tree.nodes.length ?? 0;
      walkNodes(nodes, () => {
        count++;
      });
      return Math.max(0, 200 - count);
    };
    for (const root of roots) {
      const match = (ref: SessionRef | undefined) => ref && `${ref.sourceId}/${ref.sessionId}` === root;
      let native = nodes.find((node) => match(node.ref));
      const legacyRoot = legacy?.tree.nodes.find(
        (node) => node.parentKey === null && node.identity.kind === 'session' && match(node.identity.ref)
      );
      if (!native && root !== boundRoot && remaining() < 2) {
        incomplete = true;
        continue;
      }
      // A known native root is represented by its original key/ref, never by job-root metadata.
      if (!native && root !== boundRoot && legacyRoot?.identity.kind === 'session') {
        native = displayOnlySummaryRoot({
          id: legacyRoot.key,
          name: legacyRoot.identity.ref.sessionId,
          ref: legacyRoot.identity.ref,
          status: 'unknown',
          depth: 1,
          children: [],
        });
        nodes.push(native);
      }
      if (!native && root === boundRoot) {
        const result = composeJobTree({
          tree: { ...tree, nodes },
          legacy,
          snapshot: { ...snapshot, jobs: snapshot.jobs.filter((job) => job.root === root) },
          root,
          nowMs,
          nativeRefs,
          maxAdditionalNodes: remaining(),
        });
        incomplete ||= result.coverage.incomplete;
        nodes.splice(0, nodes.length, ...result.tree.nodes);
        legacy = result.legacy;
        Object.assign(aliases, result.aliases);
        diagnostics.push(...result.diagnostics);
        continue;
      }
      if (!native) {
        if (remaining() < 2) {
          incomplete = true;
          continue;
        }
        native = { id: `job-root:${externalRootHash(root)}`, name: root, status: 'unknown', depth: 1, children: [] };
        nodes.push(native);
      }
      const result = composeJobTree({
        tree: { ...tree, rootId: native.id, nodes: native.children },
        legacy,
        snapshot: { ...snapshot, jobs: snapshot.jobs.filter((job) => job.root === root) },
        root,
        nowMs,
        maxAdditionalNodes: remaining(),
      });
      incomplete ||= result.coverage.incomplete;
      native.children = result.tree.nodes;
      legacy = result.legacy;
      Object.assign(aliases, result.aliases);
      diagnostics.push(...result.diagnostics);
    }
    let count = 0;
    const depth = (items: SubagentTreeNode[], n: number) => {
      for (const node of items) {
        node.depth = n;
        count++;
        depth(node.children, n + 1);
      }
    };
    depth(nodes, 1);
    return {
      tree: { ...tree, nodes, totalCount: count },
      legacy,
      aliases,
      coverage: { ...snapshot.coverage, incomplete, omitted: incomplete ? null : snapshot.coverage.omitted },
      diagnostics,
    };
  }
}

/** Final action boundary, shared by keyboard, mouse and legacy dispatch. */
export function panelActionAllowed(tree: SubagentTree, id: string): boolean {
  if (jobOnlyNode({ id })) return false;
  let denied = false;
  walkNodes(tree.nodes, (node) => {
    if (node.id === id && jobOnlyNode(node)) denied = true;
  });
  return !denied;
}
/** Shared final dispatch seam: every keyboard/mouse switch or legacy action goes through it. */
export function dispatchPanelAction<T>(tree: SubagentTree, id: string, dispatch: () => T): T | undefined {
  return panelActionAllowed(tree, id) ? dispatch() : undefined;
}

/** Feed global observation uncertainty into the panel's existing empty-state and notice vocabulary. */
export function panelJobRenderState(
  result: Pick<JobTreeResult, 'coverage' | 'diagnostics'> | null,
  loading: boolean
): { loading: boolean; notice: string | null } {
  if (!result) return { loading, notice: null };
  const { coverage, diagnostics } = result;
  const partial =
    coverage.incomplete || (coverage.omitted ?? 0) > 0 || coverage.diagnostics.length > 0 || diagnostics.length > 0;
  let notice: string | null = null;
  if (partial) notice = coverage.omitted ? t('{n} not loaded', { n: coverage.omitted }) : t('tree partial');
  return { loading: loading || partial, notice };
}

/** At most one tail read per agent per this long, however often we repaint. */
const AGENT_CONTEXT_INTERVAL_MS = 3000;
// This identifies the entry file observed at startup, not files replaced later.
const runtimeIdentity = captureRuntimeIdentity({ entryFile: import.meta.url });

/** A path as people write it: the home directory as `~`. */
function shortPath(file: string): string {
  const home = homedir();
  return home && (file === home || file.startsWith(home + '/')) ? '~' + file.slice(home.length) : file;
}

function walkNodes(nodes: SubagentTreeNode[], visit: (node: SubagentTreeNode) => void): void {
  for (const node of nodes) {
    visit(node);
    walkNodes(node.children, visit);
  }
}

/** Rollouts the current tree already shows, so a quiet one that starts writing is stat'd at once. */
function treePaths(nodes: SubagentTreeNode[]): Set<string> {
  const paths = new Set<string>();
  walkNodes(nodes, (node) => {
    if (node.rolloutPath) paths.add(node.rolloutPath);
  });
  return paths;
}

const HUD_CWD = process.env.CODEX_HUD_CWD || process.cwd();
const STANDALONE_PANEL = process.env.CODEX_HUD_STANDALONE_PANEL === '1';
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
const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1006h';
const LEAVE = '\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l';

/** A tmux command, through CODEX_HUD_TMUX_BIN when set (the test harness's server). */
function tmux(args: string[], input?: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const child = execFile(process.env.CODEX_HUD_TMUX_BIN || 'tmux', args, { timeout: 3000, windowsHide: true }, () =>
        resolve()
      );
      if (input !== undefined) child.stdin?.end(input);
    } catch {
      resolve();
    }
  });
}

/** The Codex pane typing is passed to: the launch's, else the session's option. */
function resolveMainPane(): string | undefined {
  if (STANDALONE_PANEL) return undefined;
  const pane = process.env.CODEX_HUD_MAIN_PANE;
  if (pane) return pane;
  if (!process.env.TMUX) return undefined;
  try {
    const option = execFileSync(
      process.env.CODEX_HUD_TMUX_BIN || 'tmux',
      ['show-options', '-qv', '@codex_hud_main_pane'],
      { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    return /^%\d+$/.test(option) ? option : undefined;
  } catch {
    return undefined;
  }
}

/** This pane: an overlay opened from the prefix or a button takes the keyboard. */
function focusPanel(): void {
  if (STANDALONE_PANEL) return;
  const pane = process.env.TMUX_PANE;
  if (pane) void tmux(['select-pane', '-t', pane]);
}

/** Esc leaves focus mode: the keys go back to the Codex pane. */
function focusMain(): void {
  if (STANDALONE_PANEL) return;
  const pane = process.env.CODEX_HUD_MAIN_PANE;
  if (pane) void tmux(['select-pane', '-t', pane]);
}

/**
 * Refresh the command table at panel startup or after the prefix changed,
 * so an existing session picks up removed commands and new bindings too.
 * Only inside a HUD session, which passes the toggle.
 */
function reinstallPrefix(prefix: string): void {
  if (STANDALONE_PANEL) return;
  const toggle = process.env.CODEX_HUD_TOGGLE_CMD;
  const session = process.env.CODEX_HUD_TMUX_SESSION;
  if (!toggle || !session) return;
  try {
    const child = spawn('bash', [path.join(path.dirname(toggle), 'codex-hud-keys'), session, prefix], {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* The next launch installs it. */
  }
}

function requestEnsureSingle(): void {
  if (STANDALONE_PANEL) return;
  const toggle = process.env.CODEX_HUD_TOGGLE_CMD;
  const session = process.env.CODEX_HUD_TMUX_SESSION;
  if (!toggle || !session) return;
  try {
    const child = spawn('bash', [toggle, session, '--ensure-single'], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* Closing the side pane is best effort. */
  }
}

async function runLivePage(): Promise<void> {
  startProfiling('panel');
  if (STANDALONE_PANEL)
    for (const key of [
      'CODEX_HUD_MAIN_PANE',
      'CODEX_HUD_TOGGLE_CMD',
      'CODEX_HUD_TMUX_SESSION',
      'CODEX_HUD_INITIAL_COMMAND',
      'TMUX',
      'TMUX_PANE',
    ])
      delete process.env[key];
  const selectedRoot = process.env.CODEX_HUD_PANEL_ROOT
    ? formatRosterRoot(parseRosterRoot(process.env.CODEX_HUD_PANEL_ROOT))
    : null;
  const allDelegations = !selectedRoot && process.env.CODEX_HUD_PANEL_ALL_DELEGATIONS === '1';
  const delegationCollector = await HudDelegationCollector.open(process.env, getCodexHome());
  const nativeCalls = NativeCallCollector.fromEnv();
  const jobPipeline = new PanelJobPipeline(nativeCalls.home, selectedRoot, {}, allDelegations ? null : HUD_CWD_REAL);
  let nativeTree: SubagentTree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date() };
  let boundJobRoot = '';
  let jobComposition: JobTreeResult | null = null;
  const applyJobComposition = (legacy: DelegationViewModel | null, afterPaint = false) => {
    const composed = afterPaint
      ? jobPipeline.afterPaint(nativeTree, nativeCalls.merge(legacy), Date.now(), boundJobRoot)
      : jobPipeline.compose(nativeTree, nativeCalls.merge(legacy), Date.now(), boundJobRoot);
    jobComposition = composed;
    tree = composed.tree;
    delegation = composed.legacy;
    const selected = state.tree.selectedId;
    if (selected && composed.aliases[selected]) state.tree.selectedId = composed.aliases[selected]!;
  };
  let delegation: DelegationViewModel | null = null;
  // Opened again, the panel reads only what each rollout gained since it last saved its scan.
  useTreeScanStore(new TreeScanStore(path.join(getHudHome(), 'scan')));
  const finder = new SessionFinder(HUD_CWD_REAL, undefined, HUD_SESSION_START);
  const parser = new RolloutParser(40);
  const worktreeCollector = new WorktreeCollector();
  // Typing here goes to Codex; with no Codex pane to give it to (the panel
  // run on its own), the keys drive the panel as they used to.
  const mainPane = STANDALONE_PANEL ? undefined : resolveMainPane();
  // Search modals need literal Unicode and paste even in a standalone panel.
  const decoder = new WorkbenchInputDecoder('workboard', { forward: !STANDALONE_PANEL });
  const forwarder = new KeyForwarder(
    () => mainPane,
    (call) => tmux(call.args, call.input)
  );
  let settings = defaultSettings();
  let settingsError = '';
  let settingsFailure: unknown = null;
  try {
    settings = runtimeSettings();
  } catch (err) {
    settingsFailure = err;
  }
  applyDisplaySettings(settings);
  setLanguage(resolveLanguage(settings.language));
  if (settingsFailure) settingsError = t('Settings: {reason}', { reason: String(settingsFailure) });
  else reinstallPrefix(settings.prefixKey);
  const configuredState = () => {
    const next = initialMonitorState();
    next.tree.sort = settings.sort;
    next.tree.lingerMs = settings.finishedLingerMs;
    next.modes = monitorModes(settings);
    return { ...next, ...monitorSettings(settings) };
  };
  let state = configuredState();
  let journal = new ActivityJournal({ rootId: '' });
  let journalRoot = '';
  let agentLogRoot = '';
  let activityHealthSuccess = { tree: 0, status: 0, worktrees: 0 };
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
  const clipboard = createClipboardProvider();
  const navigateOnce = createNavigationGate();
  const openOnce = createOpenGate();
  const runLogs = new DelegationLogView();
  let logFrame: LogFrame | undefined;
  const panelHost = new PanelHostController({ home: delegationCollector?.home ?? null });
  let panelDelegation: DelegationViewModel | null = null;
  let appliedDelegation: DelegationViewModel | null = null;
  let appliedHost: typeof panelHost.snapshot = null;
  let panelEpoch = 0;
  let panelSelection = '';
  const logContext = () => ({
    vm: panelDelegation,
    root: tree.rootId,
    epoch: panelEpoch,
    selected: state.tree.selectedId,
  });
  const syncPanelView = () => {
    const selection = JSON.stringify([tree.rootId, state.tree.selectedId]);
    if (selection !== panelSelection) {
      panelSelection = selection;
      panelEpoch++;
      runLogs.close();
      panelHost.invalidate();
    }
    if (appliedDelegation !== delegation || appliedHost !== panelHost.snapshot) {
      appliedDelegation = delegation;
      appliedHost = panelHost.snapshot;
      panelDelegation = withPanelHostAvailability(delegation, panelHost.snapshot);
    }
    if (runLogs.isOpen && !runLogs.valid(logContext())) runLogs.close();
  };
  const refreshPanelHost = () => {
    if (closed) return;
    syncPanelView();
    const target = panelHostTarget(delegation, state.tree.selectedId);
    const epoch = panelEpoch;
    const current = () => {
      const next = panelHostTarget(delegation, state.tree.selectedId);
      return !closed && epoch === panelEpoch && !!target && !!next && panelHostStamp(target) === panelHostStamp(next);
    };
    void panelHost.refresh(target, current).then(() => {
      if (!closed) {
        syncPanelView();
        render();
      }
    });
  };
  let lastClickSwitch: { id: string; at: number } | undefined;
  let navigationMessage: string | null = null;
  let tree: SubagentTree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date() };
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
  let frameRoot = '';
  let frameEpoch = 0;
  let lastPaint: string[] | null = null;
  let closed = false;
  let publicationWorker: PublicationWorker | null = null;
  let publicationError: string | null = null;
  let workerRefresh = false;
  let collecting = false;
  let collectingGit = false;
  let gitAgain = false;
  let inspecting = false;
  let inspectAgain = false;
  // Per-agent context fill and output rate, kept beside the tree because the
  // tree is rebuilt from the rollout on every collection and would otherwise lose them.
  const agentContext = new Map<string, AgentTokens>();
  const agentContextReadAt = new Map<string, number>();
  let readingAgentContext = false;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const widthKeeper = STANDALONE_PANEL ? null : treeWidthKeeper(() => settings.treeWidth);
  // Every model call of the panel goes through one service: one queue, one
  // cache, one hourly cap. Its cache and call log live beside the HUD's state.
  let modelChanged = () => {};
  const model = new SmallModel({ dir: path.join(getHudHome(), 'model-cache'), onChange: () => modelChanged() });
  const probe = new ModelProbe({ dir: path.join(getHudHome(), 'model-cache') }, () => render());
  // Each subagent's log: observed changes and model notes, kept per session.
  const agentLog = new AgentLog(path.join(getHudHome(), 'agent-log'));
  // The Timeline pane's events: the rollout's and the agent log's, one list.
  const history = new WorkbenchHistory();
  let timeline: WorkbenchEvent[] = [];
  const recaps = new RecapStore(path.join(getHudHome(), 'recaps'));
  // Repaints when a brief starts, lands or fails; render() is defined below.
  const briefer = new Briefer(() => render(), { model, store: recaps, log: agentLog });
  // Visible summary subjects request public progress independently of the periodic brief.
  const progress = new ProgressSummarizer(model, agentLog, { onChange: () => render() });
  const updateProgress = () => {
    const now = Date.now();
    const language = resolveLanguage(settings.language);
    progress.update({
      tree,
      rootRolloutPath: main?.session?.rolloutPath,
      targets:
        state.style === 'rich' &&
        paneShown(state, 'agents') &&
        !state.help &&
        !settingsPage &&
        !activityHub &&
        !observability
          ? progressTargets(
              tree,
              cardSummaryTargets({ tree, agentLog: logsIn(agentLog.snapshot(), language) }, state, now)
            )
          : new Set(),
      on: settings.briefing !== 'off' && settings.agentProgress && !settings.briefingPaused,
      offReason: settings.briefing === 'off' ? 'off' : settings.briefingPaused ? 'paused' : 'progress-disabled',
      language,
      now,
    });
  };
  /** The model's other jobs, each behind its own switch; all off with the backend. */
  const switches = (): JobSwitches =>
    settings.briefing === 'off'
      ? NO_JOBS
      : {
          resultDigest: settings.resultDigest,
          agentLabels: settings.agentLabels,
          failureCause: settings.failureCause,
          changeSummary: settings.changeSummary,
          approvalDescription: settings.approvalDescription,
        };
  const jobsOn = () => settings.briefing !== 'off' && !settings.briefingPaused;
  // A label or digest landing is put on the tree at once, not at the next collection.
  const jobs = new ModelJobs({
    model,
    log: agentLog,
    labelsFile: path.join(getHudHome(), 'model-cache', 'labels.json'),
    titles: recaps,
    readHunks: readDiffHunks,
    onChange: () => {
      jobs.apply(tree, switches(), resolveLanguage(settings.language));
      render();
    },
  });
  const updateJobs = () =>
    time('jobs.update', () =>
      jobs.update({
        tree,
        main,
        switches: switches(),
        language: resolveLanguage(settings.language),
        on: jobsOn(),
        inspected:
          paneShown(state, 'details') && state.preview === 'agent' ? (state.tree.selectedId ?? undefined) : undefined,
        recapGoal: briefCommand() === 'off' ? undefined : briefer.current().recap?.goal,
        digestLabels: { basis: t('Basis:'), caveats: t('Caveats:') },
        now: Date.now(),
      })
    );
  // The decoration picture, decoded once per path; a failed read means none.
  let art: { path: string; bitmap: ArtBitmap | null } = { path: '', bitmap: null };
  const loadArt = () => {
    const path = settings.art === 'off' ? '' : settings.artImage;
    if (path === art.path) return;
    art = { path, bitmap: null };
    if (!path) {
      render();
      return;
    }
    loadArtImage(path)
      .then((bitmap) => {
        if (art.path === path) {
          art.bitmap = bitmap;
          render();
        }
      })
      .catch(() => {});
  };
  const drawArt = (cols: number, rows: number) => {
    const style = settings.art;
    if (!art.bitmap || style === 'off') return null;
    const size = artSize(art.bitmap, cols, rows);
    return size ? renderArt(art.bitmap, style, size.cols, size.rows) : null;
  };
  const configureBriefer = () =>
    model.configure({
      backend: settings.briefing,
      api: {
        base: settings.briefingApiBase,
        model: settings.briefingApiModel,
        key: settings.briefingApiKey,
        reasoning: settings.briefingApiReasoning,
        models: {
          lite: settings.briefingApiLiteModel,
          low: settings.briefingApiLowModel,
          medium: settings.briefingApiMediumModel,
        },
      },
      hourlyCap: settings.modelCallsPerHour,
    });
  const scope = () => briefingScope(settings);
  /** The brief's backend as the Briefer sees it: off too when neither brief nor recap is on. */
  const briefCommand = () => (scope() ? settings.briefing : 'off');
  // The goal set in Codex is main-session material: read only for a scope that sends it.
  const updateBriefer = (paused: boolean) =>
    time('brief.update', () =>
      briefer.update(
        tree,
        briefCommand(),
        settings.briefingMs,
        resolveLanguage(settings.language),
        Date.now(),
        paused,
        {
          scope: scope() ?? 'agents',
          main,
          floorMs: settings.recapFloorMs,
          importantRoles: roleSet(settings.importantRoles),
          goal: settings.briefing !== 'off' && settings.briefMain ? codexGoal(getCodexHome(), tree.rootId) : null,
          labels: switches().agentLabels,
        }
      )
    );
  configureBriefer();
  // The bar's fields, for the foot of the panel: the panel replaces the bar
  // while it is open. Fed from this page's own parse of the rollout.
  const hudStatus = new HudStatus(HUD_CWD, () => render(), 30_000);
  const currentHud = () => {
    if (selectedRoot && selectedRoot !== boundJobRoot) return undefined;
    const data = hudStatus.current();
    return data
      ? {
          ...data,
          modelHealth: settings.briefing === 'off' ? undefined : model.diagnostics(),
        }
      : undefined;
  };
  const observeActivity = () => {
    if (tree.rootId !== journalRoot) {
      journal.flush();
      journalRoot = tree.rootId;
      journal = new ActivityJournal({ codexHome: getCodexHome(), rootId: journalRoot });
      activityHub = activityHub ? initialActivityHubState(activityHub.tab) : null;
      exportPreview = undefined;
    }
    if (!journalRoot) return;
    journal.observe(
      scopedActivityObservation(journalRoot, agentLogRoot, {
        tree,
        data: currentHud(),
        logs: agentLog.snapshot(),
        git,
        gitObservedAt,
        gitFresh: !!git?.root && !git.error && gitObservedAt > 0 && Date.now() - gitObservedAt <= 15_000,
        modelAvailable: settings.briefing !== 'off',
        healthSignals: Object.entries(activityHealthSuccess)
          .filter(([, at]) => at > 0)
          .map(([source, at]) => ({ key: `collector:${source}`, kind: 'health' as const, active: false, at })),
      })
    );
  };
  const sampleTelemetry = () => {
    telemetry = model.telemetry();
  };
  const markActivitySourceSuccess = (source: keyof typeof activityHealthSuccess) => {
    const failure = hudStatus.health.current().lastError;
    if (
      !activityHealthSuccess[source] ||
      (failure?.source === source && failure.at.getTime() >= activityHealthSuccess[source])
    )
      activityHealthSuccess[source] = Date.now();
  };
  const captureExport = () => {
    sampleTelemetry();
    exportPreview = createDiagnosticExportPreview({
      data: currentHud(),
      tree,
      selectedId: state.tree.selectedId ?? undefined,
      telemetry,
      runtimeIdentity,
      nowMs: Date.now(),
    });
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
  const previewTop = (draft: HudSettings, width: number) =>
    withDisplaySettings(draft, () =>
      panelTop(
        { tree, brief: settings.briefing === 'off' ? undefined : { paused: settings.briefingPaused } },
        { ...state, tabbed: draft.paneLayout === 'tabs' },
        width
      )
    );
  // This directory's recent sessions, read only while the activity hub's Sessions tab is open, at most every ten seconds.
  let sessionsRead: { at: number; cwd: string; rows: RecentSessionRow[] } | null = null;
  const sessionList = (): RecentSessionRow[] => {
    const cwd = main?.session?.cwd || HUD_CWD;
    const now = Date.now();
    if (!sessionsRead || sessionsRead.cwd !== cwd || now - sessionsRead.at >= 10_000) {
      let rows: RecentSessionRow[] = [];
      try {
        rows = recentSessions(cwd).map((file) => {
          // A title a model wrote earlier, read from its file: nothing is asked for here.
          const title = recaps.loadTitle(file.sessionId)?.title;
          return {
            id: file.sessionId,
            modifiedAt: file.modifiedAt.getTime(),
            ...(title ? { title } : {}),
            ...(file.sessionId === tree.rootId ? { current: true } : {}),
          };
        });
      } catch {
        /* An unreadable sessions directory lists nothing. */
      }
      sessionsRead = { at: now, cwd, rows };
    }
    return sessionsRead.rows;
  };
  const render = () => {
    if (closed) return;
    syncPanelView();
    const output = time('render', () => {
      let lines: string[];
      if (runLogs.isOpen) {
        logFrame = runLogs.render(process.stdout.columns || 30, process.stdout.rows || 24);
        lines = logFrame.lines;
      } else if (activityHub) {
        activityFrame = renderActivityHub(
          journal.view(),
          activityHub,
          process.stdout.columns || 30,
          process.stdout.rows || 24,
          Date.now(),
          activityHub.tab === 'sessions' ? sessionList() : []
        );
        activityHub = activityFrame.state;
        lines = activityFrame.lines;
      } else if (observability) {
        const width = process.stdout.columns || 30;
        observabilityFrame = renderObservabilityPage(
          observability,
          {
            sources: diagnosticLines(currentHud(), width, Date.now(), {
              tree,
              selectedId: state.tree.selectedId ?? undefined,
            }),
            calls: modelTelemetryLines(telemetry, width),
            preview: exportPreview?.json,
          },
          width,
          process.stdout.rows || 24
        );
        observability = observabilityFrame.state;
        lines = observabilityFrame.lines;
      } else if (settingsPage) {
        // Key roles offers the roles the subtasks have now.
        settingsFrame = renderSettingsPage(
          { ...settingsPage, roles: subtaskRoles(tree) },
          process.stdout.columns || 30,
          process.stdout.rows || 24,
          {
            state: hudStatus.health.current(),
            modelCalls: settings.briefing === 'off' ? undefined : model.usage(),
            probe: probe.current(),
            settingsFile: shortPath(settingsPath()),
          },
          previewTop,
          controlBar(
            state,
            {
              settingsActive: true,
              expired: 0,
              brief: settings.briefing === 'off' ? undefined : { paused: settings.briefingPaused },
            },
            process.stdout.columns || 30
          )
        );
        settingsPage = settingsFrame.state;
        lines = settingsFrame.lines;
        if (settingsLeave) {
          confirmationFrame = renderSettingsConfirmation(
            lines,
            settingsLeave,
            process.stdout.columns || 30,
            process.stdout.rows || 24,
            settingsFrame.headerY
          );
          lines = confirmationFrame.lines;
        }
      } else {
        const width = process.stdout.columns || 30;
        const nowMs = Date.now();
        const hud = currentHud();
        const jobRender = panelJobRenderState(jobComposition, !collected || treeBuiltFor !== tree.rootId);
        const agentLogs = logsIn(
          agentLog.snapshot(),
          resolveLanguage(settings.language),
          settings.briefing !== 'off' || settings.agentLog
        );
        frame = renderMonitor({
          tree,
          workboard: jobPipeline.workboard(tree, panelDelegation),
          state,
          git,
          worktrees,
          diff,
          error,
          publicationNotice: publicationError ? t('Publisher unavailable; read-only') : null,
          nowMs,
          hud: hud ? { ...hud, delegation: panelDelegation } : hud,
          notice:
            (navigationMessage ? boundedActionNotice(navigationMessage, width) : null) ||
            panelHost.snapshot?.reason ||
            (panelHostTarget(panelDelegation, state.tree.selectedId) && !panelHost.snapshot
              ? 'Open unavailable: verifying exact host identity.'
              : null) ||
            jobRender.notice ||
            hudProblems(hud, nowMs, t)[0],
          loading: jobRender.loading,
          art: drawArt,
          prefix: prefixName(settings.prefixKey),
          brief:
            settings.briefing === 'off'
              ? undefined
              : { ...(briefCommand() === 'off' ? {} : briefer.current()), paused: settings.briefingPaused },
          agentLog: agentLogs,
          progress: progress.state(),
          progressContext: {
            backendOn: settings.briefing !== 'off',
            paused: settings.briefingPaused,
            enabled: settings.agentProgress,
            targets: cardSummaryTargets({ tree, agentLog: agentLogs }, state, nowMs),
          },
          timeline: jobs.withCauses(timeline),
          notes: {
            approval: switches().approvalDescription ? jobs.approvalNote(main?.pendingApproval) : undefined,
            changes: switches().changeSummary ? jobs.changeNote(git) : undefined,
          },
          status: (nowMs) => statusCard(hud ?? null, nowMs),
          session: (nowMs) => sessionState(hud ?? null, nowMs),
          width,
          height: process.stdout.rows || 24,
          linkNames: mainCols === null || mainCols >= 63,
        });
        frameRoot = tree.rootId;
        frameEpoch = collectionEpoch;
        state = frame.state;
        lines = frame.lines;
      }
      return lines;
    });
    const update = frameDiff(lastPaint, output);
    lastPaint = output;
    if (update) time('write', () => process.stdout.write(update));
  };
  modelChanged = () => {
    adaptive = forceAdaptivePoll(adaptive);
    collectionEpoch++;
    render();
  };
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
    if (!live)
      walkNodes(tree.nodes, (node) => {
        if (node.status === 'running' || node.status === 'starting') live = true;
      });
    if (live) return nextRepaintDelay(now, anchor);
    let wait = 60_000;
    const consider = (ms: number) => {
      if (ms > 0 && ms < wait) wait = ms;
    };
    const ageAt = (at?: Date) => {
      if (at && Number.isFinite(at.getTime())) consider(msUntilAgeChanges(at.getTime(), now));
    };
    walkNodes(tree.nodes, (node) => {
      ageAt(finishedAt(node));
      ageAt(node.startedAt);
      ageAt(node.turnStartedAt);
      ageAt(node.lastEventAt);
      ageAt(node.statusAt);
    });
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
    repaintTimer = setTimeout(() => {
      render();
      scheduleRepaint();
    }, repaintDelay());
  };
  /** The Codex pane's columns, so a narrow one is not offered as a link. */
  const readMainCols = () => {
    if (STANDALONE_PANEL) return;
    const pane = process.env.CODEX_HUD_MAIN_PANE;
    if (!pane) return;
    execFile(
      process.env.CODEX_HUD_TMUX_BIN || 'tmux',
      ['display-message', '-p', '-t', pane, '#{pane_width}'],
      { timeout: 1500, windowsHide: true },
      (err, stdout) => {
        if (closed || err) return;
        const cols = Number(String(stdout ?? '').trim());
        if (!Number.isInteger(cols) || cols <= 0 || cols === mainCols) return;
        mainCols = cols;
        render();
      }
    );
  };
  /** (Re)arm collection at the refresh setting; a no-op while it is unchanged. */
  const armCollect = () => {
    if (closed || (collectTimer && collectEvery === settings.refreshMs)) return;
    if (collectTimer) clearInterval(collectTimer);
    collectEvery = settings.refreshMs;
    adaptive = createAdaptivePollState(collectEvery);
    collectTimer = setInterval(() => void collect(), collectEvery);
  };
  const applyAgentContext = () => {
    walkNodes(tree.nodes, (node) => {
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
      const pane = frame?.panes.find((p) => p.id === 'agents');
      const wanted = new Set<string>();
      if (state.tree.selectedId) wanted.add(state.tree.selectedId);
      if (pane) {
        for (let i = pane.offset; i < pane.offset + Math.max(0, pane.height - (pane.edge ?? 1)); i++) {
          const item = pane.rows[i]?.item;
          if (item) wanted.add(item);
        }
      }
      const byId = new Map<string, SubagentTreeNode>();
      walkNodes(tree.nodes, (node) => {
        byId.set(node.id, node);
        if (node.status === 'running' || node.status === 'starting') wanted.add(node.id);
      });
      const now = Date.now();
      let changed = false;
      for (const id of wanted) {
        const path = byId.get(id)?.rolloutPath;
        if (!path) continue;
        if (now - (agentContextReadAt.get(id) ?? 0) < AGENT_CONTEXT_INTERVAL_MS) continue;
        agentContextReadAt.set(id, now);
        const tokens = await readAgentTokens(path);
        if (closed) return;
        if (tokens.usage || tokens.rate || tokens.spent) agentContext.set(id, tokens);
        else agentContext.delete(id);
        changed = true;
      }
      // Entries for agents no longer in the tree would otherwise accumulate.
      for (const id of [...agentContext.keys()])
        if (!byId.has(id)) {
          agentContext.delete(id);
          agentContextReadAt.delete(id);
        }
      if (changed) {
        applyAgentContext();
        render();
      }
    } catch {
      /* A rollout that cannot be read has no fill to report. */
    } finally {
      readingAgentContext = false;
    }
  };
  const refreshInspection = async () => {
    if (closed) return;
    if (inspecting) {
      inspectAgain = true;
      return;
    }
    inspecting = true;
    const selectedFile = git?.files.find((file) => file.path === state.selectedFile);
    try {
      if (state.preview === 'file' && selectedFile && git?.root && canMonitorDiff(frame)) {
        const key = JSON.stringify([git.root, selectedFile.path, gitRevision]);
        if (key !== diffKey) {
          const repoRoot = git.root;
          const revision = gitRevision;
          const result = await readGitDiff(repoRoot, selectedFile);
          if (
            !closed &&
            state.selectedFile === selectedFile.path &&
            git?.root === repoRoot &&
            gitRevision === revision
          ) {
            diff = result;
            diffKey = key;
          } else inspectAgain = true;
        }
      }
    } catch {
      if (state.preview === 'file') diff = ['Unable to read this file preview'];
    } finally {
      inspecting = false;
      render();
      if (inspectAgain && !closed) {
        inspectAgain = false;
        void refreshInspection();
      }
    }
  };
  const collectionScope = () =>
    `${tree.rootId}:${activityHub?.tab ?? observability?.tab ?? state.focus}:${JSON.stringify(state.modes)}`;
  const collect = async (force = false) => {
    if (force) {
      adaptive = forceAdaptivePoll(adaptive);
      collectionEpoch++;
    }
    if (closed || collecting) return;
    if (!adaptivePollDue(adaptive, collectionScope(), Date.now())) return;
    const epoch = collectionEpoch;
    await timeAsync('collect', collectNow);
    if (epoch === collectionEpoch)
      adaptive = recordAdaptivePoll(adaptive, {
        scopeKey: collectionScope(),
        nowMs: Date.now(),
        ...withDelegationObservation(collectionObservation(currentHud(), tree), delegation),
        succeeded: !currentHud()?.stale && !error && currentHud()?.health?.sessionBound === true,
      });
    else if (!closed) void collect(true);
  };
  const collectNow = async () => {
    collecting = true;
    try {
      await collectNowBody();
    } finally {
      collecting = false;
      delegationCollector?.abandonCollection();
      refreshPanelHost();
    }
  };
  const collectNowBody = async () => {
    const collectionStartedAt = performance.now();
    const delegationDeadline = collectionStartedAt + 40;
    let session: ReturnType<typeof finder.check> = null;
    let stale = false;
    // Where a failure happened, for the health row.
    let stage: HealthSource = 'session';
    try {
      session = finder.check();
      boundJobRoot = session ? `${makeSourceId('codex', fs.realpathSync(getCodexHome()))}/${session.sessionId}` : '';
      if (selectedRoot && selectedRoot !== boundJobRoot) session = null;
      const observationRoot = allDelegations ? null : (selectedRoot ?? boundJobRoot);
      jobPipeline.setRoot(allDelegations ? null : observationRoot || 'unbound/no-session');
      let jobCharge: [number, number, number] | undefined;
      const jobRead = jobPipeline.refresh(
        (bytes, entries, ms) => {
          jobCharge = [bytes, entries, ms];
        },
        { deadline: delegationDeadline }
      );
      await jobRead;
      if (closed) return;
      const nativeRead = selectedRoot
        ? nativeCalls.collect()
        : nativeCalls.collectCodex(session?.sessionId, getCodexHome(), allDelegations);
      delegation = delegationCollector
        ? await delegationCollector.tick(
            allDelegations ? undefined : session?.sessionId,
            delegationDeadline,
            Math.max(0, (publicationWorker ? 2 : 4) * 1024 * 1024 - (jobCharge?.[0] ?? 0))
          )
        : null;
      const legacyDelegation = delegation;
      if (workerRefresh) workerRefresh = false;
      else publicationWorker?.request(allDelegations ? undefined : session?.sessionId);
      stage = 'rollout';
      const rootReadStarted = performance.now();
      const priorRootStats = parser.getReadStats();
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
            main = await parser.parse(
              legacyDelegation || publicationWorker
                ? {
                    budget: {
                      maxBytes: Math.max(
                        0,
                        (publicationWorker ? 2 : 4) * 1024 * 1024 -
                          (jobCharge?.[0] ?? 0) -
                          (delegationCollector?.collector.stats().bytesRead ?? 0)
                      ),
                      maxRecords: 2000,
                      budgetMs: Math.max(0, Math.min(20, Math.floor(delegationDeadline - performance.now()))),
                    },
                    state: parser.getReadStats()?.state ?? initialParserState(),
                  }
                : undefined
            );
            if (
              legacyDelegation &&
              ((parser.getReadStats()?.remainingBytes ?? 0) > 0 || parser.getReadStats()?.continuation)
            )
              lastParsedRollout = null;
          } catch (err) {
            // A failed read is not "already parsed"; let the next tick retry.
            lastParsedRollout = null;
            throw err;
          }
        }
      }
      const rootStats = parser.getReadStats();
      if (legacyDelegation && rootStats && rootStats !== priorRootStats)
        delegationCollector?.collector.chargeAdditionalRead(
          rootStats.bytesRead,
          rootStats.recordsRead,
          performance.now() - rootReadStarted
        );
      hudStatus.health.bind(Boolean(session));
      hudStatus.health.read();
      await nativeRead;
      await jobRead;
      if (jobCharge) delegationCollector?.collector.chargeAdditionalRead(...jobCharge);
      if (closed) return;
      delegation = nativeCalls.merge(legacyDelegation);
      stage = 'tree';
      const rootId = main?.session?.id ?? session?.sessionId ?? selectedRoot ?? '';
      if (rootId !== tree.rootId) {
        state = configuredState();
        diff = undefined;
        diffKey = '';
        git = null;
        gitObservedAt = 0;
        worktrees = null;
        // Cancel old-root writers before loading the next root's model log. A failed
        // subsequent tree read must never journal the previous session's summaries.
        progress.stop();
        jobs.stop();
        briefer.stop();
        agentLog.attach(rootId);
        agentLogRoot = rootId;
        activityHealthSuccess = { tree: 0, status: 0, worktrees: 0 };
        agentContext.clear();
        agentContextReadAt.clear();
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
                treeLookbackDays(
                  rootId,
                  3,
                  main?.subagents?.map((agent) => agent.id)
                ),
                priority
              )
            )
          : undefined;
      tree =
        rootId && !!session
          ? await timeAsync('tree.build', () =>
              buildSubagentTreeYielding(rootId, main?.subagents ?? [], 3, Date.now(), listed)
            )
          : { rootId, nodes: [], totalCount: 0, updatedAt: new Date() };
      if (closed) return;
      nativeTree = tree;
      applyJobComposition(legacyDelegation);
      treeBuiltFor = rootId;
      markActivitySourceSuccess('tree');
      applyAgentContext();
      jobs.apply(tree, switches(), resolveLanguage(settings.language));
      // On the same tick as the tree, so the log never lags it.
      if (time('agentlog.observe', () => agentLog.observe(summaryTree(tree)))) agentLog.flush();
      timeline = time('timeline', () =>
        history.timeline(tree, main, logsIn(agentLog.snapshot(), resolveLanguage(settings.language)))
      );
      state = reconcileMonitor(state, tree, git, worktrees, Date.now(), delegation);
      updateProgress();
      updateBriefer(settings.briefingPaused);
      updateJobs();
      error = settingsError || null;
    } catch (err) {
      error = t('Refresh: {reason}', { reason: String(err) });
      stale = true;
      hudStatus.health.fail(stage, err);
    } finally {
      collected = true;
    }
    let built: ReturnType<HudStatus['build']> | null = null;
    try {
      const delegationMs = delegationCollector?.collector.stats().totalMs ?? 0;
      if (delegationMs > 50)
        hudStatus.health.fail(
          'tree',
          delegationMs >= 200 ? 'delegation_tick_performance_unqualified' : 'delegation_tick_over_50ms'
        );
      built = hudStatus.build({ rollout: main, sessionId: session?.sessionId, stale, tree });
      if (delegation) Object.assign(built, { delegation });
      markActivitySourceSuccess('status');
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
    observeActivity();
    if (observability) sampleTelemetry();
    render();
    try {
      const publicationToken = delegationCollector?.publicationToken();
      await delegationCollector?.afterPaint(
        (committed) => {
          if (closed) return;
          applyJobComposition(committed, true);
          jobs.apply(tree, switches(), resolveLanguage(settings.language));
          if (built) Object.assign(built, { delegation });
          render();
        },
        collectionStartedAt,
        publicationToken
      );
      const fullDelegationMs = delegationCollector?.publicationStats().fullTickMs ?? 0;
      if (fullDelegationMs > 50)
        hudStatus.health.fail(
          'tree',
          fullDelegationMs >= 200 ? 'delegation_tick_performance_unqualified' : 'delegation_tick_over_50ms'
        );
    } finally {
      collecting = false;
    }
    readMainCols();
    void refreshInspection();
    void refreshAgentContext();
  };
  const sources = () =>
    worktreeSources(HUD_CWD_REAL, main?.session?.cwd, settings.worktreeRoot, process.env.CODEX_HUD_WORKTREE_ROOT);
  const refreshGit = async () => {
    if (closed) return;
    if (collectingGit) {
      gitAgain = true;
      return;
    }
    // Closed monitors are absent, not empty frames continuously collecting
    // data; in the tabs layout only the pane shown is read for.
    const wantChanges =
      activityHub?.tab === 'updates' ||
      paneShown(state, 'changes') ||
      (paneShown(state, 'details') && state.preview === 'file');
    if (!wantChanges && !(paneShown(state, 'details') && state.preview === 'worktree')) return;
    collectingGit = true;
    const candidates = sources();
    const requestKey = JSON.stringify(candidates);
    try {
      const snapshot = await timeAsync('git.worktrees', () => worktreeCollector.refresh(candidates));
      if (closed) return;
      if (requestKey !== JSON.stringify(sources())) {
        gitAgain = true;
        return;
      }
      worktrees = snapshot;
      if (!snapshot.error) markActivitySourceSuccess('worktrees');
      const previousWorktree = state.selectedWorktree;
      state = reconcileMonitor(state, tree, git, worktrees, Date.now(), delegation);
      if (state.selectedWorktree !== previousWorktree) {
        git = null;
        diff = undefined;
        diffKey = '';
      }
      render();
      const entry = worktrees.entries.find((w) => w.path === state.selectedWorktree);
      if (wantChanges && entry && !entry.bare && entry.prunable === undefined) {
        const selected = entry.path;
        const result = await timeAsync('git.changes', () => collectGitChanges(selected));
        if (closed) return;
        if (requestKey !== JSON.stringify(sources()) || selected !== state.selectedWorktree) {
          gitAgain = true;
          return;
        }
        git = result;
        gitRevision++;
        gitObservedAt = Date.now();
        // While the pane is open, and at most once per floor period.
        jobs.updateChanges(git, {
          on: jobsOn(),
          enabled: switches().changeSummary,
          open: paneShown(state, 'changes'),
          floorMs: settings.recapFloorMs,
          language: resolveLanguage(settings.language),
          now: Date.now(),
        });
        const previousFile = state.selectedFile;
        state = reconcileMonitor(state, tree, git, worktrees, Date.now(), delegation);
        if (previousFile !== state.selectedFile) {
          diff = undefined;
          diffKey = '';
        }
      } else if (!entry || entry.bare || entry.prunable !== undefined) {
        git = null;
        diff = undefined;
        diffKey = '';
      }
      observeActivity();
      render();
      void refreshInspection();
    } catch (err) {
      hudStatus.health.fail('worktrees', err);
      worktrees = { sourcePath: null, entries: [], updatedAt: Date.now(), error: 'Worktree read failed' };
      git = null;
      gitObservedAt = 0;
      diff = undefined;
      diffKey = '';
      observeActivity();
      render();
    } finally {
      collectingGit = false;
      if (gitAgain && !closed) {
        gitAgain = false;
        void refreshGit();
      }
    }
  };
  const finish = (user = false) => {
    if (closed) return;
    closed = true;
    runLogs.close();
    panelHost.close();
    const clipboardClosing = clipboard.close();
    const workerClosing = publicationWorker?.close().then((clean) => {
      if (!clean) process.stderr.write('observation_worker_cleanup_unconfirmed\n');
    });
    delegationCollector?.close();
    jobPipeline.dispose();
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
    process.stdin.off('data', onData);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(LEAVE);
    snapshotWriter.remove();
    if (user) requestEnsureSingle();
    // Settle bounded local telemetry writes before the terminal process exits.
    void Promise.all([model.flushTelemetry().catch(() => {}), clipboardClosing, workerClosing]).finally(resolveDone);
  };
  const switchNativeSession = (id: string) => {
    if (STANDALONE_PANEL) {
      navigationMessage = t('Switching is unavailable in the standalone panel.');
      render();
      return;
    }
    const root = tree.rootId;
    const view = nativeCallsOnly(delegation) ? null : delegation;
    const selected = state.tree.selectedId;
    const label = view ? undefined : uniquePickerLabel(tree, id);
    const selectedIdentity = (snapshot: DelegationViewModel | null) => {
      if (nativeCallsOnly(snapshot)) snapshot = null;
      const node = snapshot?.tree.nodes.find((item) => item.key === selected);
      return snapshot
        ? JSON.stringify({
            ledger: snapshot.tree.ledger.ledgerId,
            identity: node?.identity,
            parent: node?.parentKey,
            run: node?.currentRun?.runId,
          })
        : null;
    };
    const identity = selectedIdentity(view);
    const current = () =>
      !closed &&
      tree.rootId === root &&
      state.tree.selectedId === selected &&
      selectedIdentity(delegation) === identity;
    return navigateOnce(
      id,
      () => navigateSession(process.env.CODEX_HUD_MAIN_PANE, { id, label }, undefined, current),
      current,
      () => {
        navigationMessage = t('Switching Codex session…');
        render();
      },
      (outcome) => {
        navigationMessage =
          'error' in outcome
            ? t('Switch failed: {reason}', { reason: String(outcome.error) })
            : outcome.value.ok
              ? null
              : outcome.value.message;
        render();
      }
    );
  };
  const switchSession = (id: string) => dispatchPanelAction(tree, id, () => switchNativeSession(id));
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
      settingsError = '';
      error = null;
      applyDisplaySettings(settings);
      setLanguage(resolveLanguage(settings.language));
      configureBriefer();
      jobs.apply(tree, switches(), resolveLanguage(settings.language));
      if (!jobsOn()) jobs.stop();
      armCollect();
      loadArt();
      state = {
        ...state,
        ...monitorSettings(settings),
        tree: { ...state.tree, sort: settings.sort, lingerMs: settings.finishedLingerMs },
        modes: monitorModes(settings),
        zoom: false,
        statusScroll: 0,
        scroll: { ...state.scroll, agents: 0 },
        revealed: null,
      };
      updateProgress();
      updateBriefer(settings.briefingPaused);
      git = null;
      diff = undefined;
      diffKey = '';
      void refreshGit();
      notifier.configure(resolveNotifierOptions(process.env, settings));
      if (settings.prefixKey !== previousPrefix) reinstallPrefix(settings.prefixKey);
      page.message = t('Saved');
      page.original = { ...settings };
      process.stdout.write(settings.mouse ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1000l\x1b[?1006l');
      void widthKeeper
        ?.apply()
        .then(() => {
          lastPaint = null;
          render();
        })
        .catch((err) => {
          if (settingsPage) settingsPage.message = String(err);
          render();
        });
      return true;
    } catch (err) {
      page.message = t('Save failed: {reason}', { reason: String(err) });
      return false;
    }
  };
  const requestSettingsLeave = (destination?: string): boolean => {
    if (settingsPage && settingsDirty(settingsPage)) {
      settingsLeave = { choice: 'cancel', destination };
      return false;
    }
    settingsPage = null;
    return true;
  };
  const commandInput = (command: PanelCommand): WorkbenchInput | null => {
    const overlay = settingsPage ? 'settings' : state.help ? 'help' : null;
    if (overlay) {
      const key = overlayKey(command, overlay);
      if (key) return { type: 'key', key };
      if (settingsPage && !requestSettingsLeave(monitorKey(command))) return null;
      settingsPage = null;
      state = { ...state, help: false };
    }
    return { type: 'key', key: monitorKey(command) };
  };
  const processInput = (inputs: WorkbenchInput[]) => {
    const overlayBefore = Boolean(settingsPage || state.help || activityHub || observability);
    // What goes to Codex, in order, sent once the whole read is through.
    const forward: ForwardItem[] = [];
    for (let input of inputs) {
      if (closed) break;
      if (input.type === 'mouse' && !settings.mouse) continue;
      syncPanelView();
      if (runLogs.isOpen) {
        runLogs.input(input, logFrame, logContext());
        if (!runLogs.isOpen && !state.keys) focusMain();
        render();
        continue;
      }
      const fromSettings = Boolean(settingsPage);
      let panelInput = input.type === 'command';
      if (settingsLeave && confirmationFrame) {
        const dialogInput: WorkbenchInput =
          input.type === 'command' ? { type: 'key', key: overlayKey(input.command, 'settings') ?? '' } : input;
        const result = handleSettingsConfirmation(settingsLeave, dialogInput, confirmationFrame);
        settingsLeave = { ...settingsLeave, ...result.state };
        if (!result.action) {
          render();
          continue;
        }
        if (result.action === 'cancel') {
          settingsLeave = null;
          render();
          continue;
        }
        if (result.action === 'save' && !applySettingsDraft()) {
          settingsLeave.error = settingsPage?.message || t('Could not save settings');
          render();
          continue;
        }
        const destination = settingsLeave.destination;
        settingsLeave = null;
        settingsPage = null;
        if (!destination) {
          updateProgress();
          render();
          continue;
        }
        // Preserve the destination by key, not old mouse coordinates: Save
        // may have changed the pane width and therefore every tab's hit span.
        input = { type: 'key', key: destination };
        panelInput = true;
      }
      if (activityHub || observability) {
        if (input.type === 'command') {
          const key = overlayKey(input.command, 'help');
          if (key) input = { type: 'key', key };
          else {
            activityHub = null;
            observability = null;
            exportPreview = undefined;
          }
        }
        if (activityHub && activityFrame) {
          const tab = activityHub.tab;
          const result = handleActivityHubInput(activityHub, input, activityFrame);
          activityHub = result.state;
          const action = result.action;
          if (action?.type === 'close') {
            activityHub = null;
            focusMain();
          } else if (action?.type === 'read') journal.markRead(action.eventId, action.value);
          else if (action?.type === 'snooze') journal.snooze(action.eventId, action.until);
          else if (action?.type === 'pin') journal.pin(action.agentId, action.value);
          else if (action?.type === 'viewed') journal.markViewed(action.receipt);
          else if (action?.type === 'target') {
            const nativeOnly = nativeCallsOnly(delegation);
            const target =
              delegation && !nativeOnly ? delegationActivityTarget(delegation, tree.rootId, action.agentId) : null;
            const selected = target?.key ?? null;
            let live = delegation && !nativeOnly ? target !== null : action.agentId === tree.rootId;
            if (!delegation || nativeOnly)
              walkNodes(tree.nodes, (node) => {
                if (node.id === action.agentId) live = true;
              });
            if (live) {
              state = {
                ...state,
                keys: true,
                focus: 'details',
                preview: action.agentId === tree.rootId ? 'diagnostics' : 'agent',
                tree: {
                  ...state.tree,
                  selectedId: action.agentId === tree.rootId ? state.tree.selectedId : (selected ?? action.agentId),
                  collapsed:
                    delegation && selected
                      ? revealDelegationAncestors(delegation, selected, state.tree.collapsed)
                      : state.tree.collapsed,
                  showAll: true,
                },
                modes: { ...state.modes, details: 'open' },
                scroll: { ...state.scroll, details: 0 },
              };
              activityHub = null;
            } else navigationMessage = t('This historical agent is no longer in the current tree');
          }
          updateProgress();
          render();
          if (activityHub?.tab === 'updates' && tab !== 'updates') void refreshGit();
          continue;
        }
        if (observability && observabilityFrame) {
          const result = handleObservabilityInput(observability, input, observabilityFrame);
          observability = result.state;
          if (result.action === 'close') {
            observability = null;
            exportPreview = undefined;
            focusMain();
          } else if (result.action === 'preview') captureExport();
          else if (result.action === 'save' && exportPreview) {
            const saved = saveDiagnosticExport(exportPreview, getCodexHome());
            observability.message = saved.ok
              ? t('Report saved: {path}', { path: saved.path })
              : t('Report could not be saved');
          }
          updateProgress();
          render();
          continue;
        }
      }
      if (input.type === 'command') {
        const decoded = commandInput(input.command);
        if (!decoded) {
          render();
          continue;
        }
        input = decoded;
      } else if (mainPane && input.type !== 'mouse' && !panelInput) {
        // Focus mode keeps keys here, as an overlay does, without being one:
        // a prefix command is still a panel command.
        const overlay = Boolean(settingsPage || state.help || state.keys);
        if (!overlay) {
          // Not the panel's: every key and paste is Codex's.
          if (input.type === 'paste') forward.push({ kind: 'paste', text: input.text });
          else if (input.raw) forward.push({ kind: 'keys', text: input.raw });
          continue;
        }
        // An open overlay owns the keyboard until it closes. Its keys are
        // the ones it needs; q and Ctrl+C close it, not the panel, and a
        // paste has nowhere to go.
        if (input.type === 'paste') continue;
        if (input.key === 'close') input = { type: 'key', key: 'escape' };
      }
      if (input.type === 'key' && ['activity-hub', 'find-agent', 'observability'].includes(input.key)) {
        if (settingsPage && !requestSettingsLeave(input.key)) {
          render();
          continue;
        }
        state = { ...state, help: false };
        if (input.key === 'observability') {
          sampleTelemetry();
          observability = initialObservabilityState();
          activityHub = null;
        } else {
          observeActivity();
          activityHub = initialActivityHubState(input.key === 'find-agent' ? 'find' : 'inbox');
          observability = null;
        }
        exportPreview = undefined;
        focusPanel();
        updateProgress();
        render();
        continue;
      }
      if (input.type === 'paste') continue;
      if (settingsPage && settingsFrame && input.type === 'mouse' && input.button === 'left') {
        const { x, y } = input;
        const hit = settingsFrame.navigationControls.find((c) => y === c.y && x >= c.x && x < c.x + c.width);
        if (hit) {
          if (hit.kind === 'settings') continue;
          const destination =
            hit.kind === 'tab'
              ? hit.pane
              : ({ main: 'main', help: 'help', brief: 'brief-toggle', older: 'show-all' } as Record<string, string>)[
                  hit.kind
                ];
          if (!destination) continue;
          if (!requestSettingsLeave(destination)) {
            render();
            continue;
          }
          input = { type: 'key', key: destination };
        }
      }
      if (settingsPage && settingsFrame) {
        const result = handleSettingsInput(settingsPage, input, settingsFrame);
        settingsPage = result.state;
        probe.invalidate(settingsPage.draft);
        if (result.action === 'back') requestSettingsLeave();
        else if (result.action === 'reset') {
          const group = SETTING_ROWS[settingsPage.selected].group;
          settingsPage = {
            ...settingsPage,
            draft: resetSettingsGroup(settingsPage.draft, group),
            message: t(
              group === 'LLM'
                ? 'Model generation disabled; connection preserved; Save to apply'
                : 'Group defaults ready; Save to apply'
            ),
          };
        } else if (result.action === 'reset-all')
          settingsPage = {
            ...settingsPage,
            draft: resetAllPreferences(settingsPage.draft),
            message: t('Preference defaults ready; model connection preserved and generation paused'),
          };
        else if (result.action === 'save') applySettingsDraft();
        else if (result.action === 'test-api') {
          if (probe.current().running) probe.cancel();
          else
            void probe.run({ ...settingsPage.draft }).catch(() => {
              probe.cancel();
              if (settingsPage) settingsPage.message = t('Connection test failed');
              render();
            });
        } else if (result.action === 'diagnostics' && requestSettingsLeave('diagnostics')) {
          state = {
            ...state,
            preview: 'diagnostics',
            focus: 'details',
            modes: { ...state.modes, details: 'open' },
            scroll: { ...state.scroll, details: 0 },
          };
        }
        updateProgress();
        render();
        continue;
      }
      const previous = state;
      const actionFrame = frame;
      const actionRoot = frameRoot;
      const actionEpoch = frameEpoch;
      const result = handleMonitorInput(state, input, {
        tree,
        git,
        worktrees,
        frame,
        navigationOverlay: fromSettings,
        standalone: STANDALONE_PANEL,
      });
      state = result.state;
      syncPanelView();
      if (result.action?.type !== 'delegation-open') refreshPanelHost();
      if (result.close) {
        finish(true);
        break;
      }
      if (state.selectedFile !== previous.selectedFile) {
        diff = undefined;
        diffKey = '';
      }
      if (state.selectedWorktree !== previous.selectedWorktree) {
        git = null;
        diff = undefined;
        diffKey = '';
      }
      if (JSON.stringify(state.modes) !== JSON.stringify(previous.modes)) {
        try {
          settings = saveSettings(monitorPreferences(state));
        } catch (err) {
          settingsError = t('Panel preferences could not be saved: {reason}', { reason: String(err) });
          error = settingsError;
        }
      }
      if (result.action?.type === 'brief-toggle' && settings.briefing !== 'off') {
        try {
          settings = saveSettings({ briefingPaused: !settings.briefingPaused });
          // Resuming asks at once when there is news, rather than at the next tick.
          if (!settings.briefingPaused) void collect();
          else {
            updateBriefer(true);
            jobs.stop();
          }
          updateProgress();
        } catch (err) {
          settingsError = t('Panel preferences could not be saved: {reason}', { reason: String(err) });
          error = settingsError;
        }
      }
      if (result.action?.type === 'status-level' && state.statusLevel) {
        try {
          settings = saveSettings({ statusCard: state.statusLevel });
        } catch (err) {
          settingsError = t('Panel preferences could not be saved: {reason}', { reason: String(err) });
          error = settingsError;
        }
      }
      if (result.action?.type === 'settings') {
        settingsPage = {
          draft: { ...settings, ...monitorPreferences(state), sort: state.tree.sort ?? 'active' },
          selected: 0,
          offset: 0,
          message: '',
        };
      }
      if (result.action?.type === 'observability') {
        sampleTelemetry();
        observability = initialObservabilityState();
        activityHub = null;
        exportPreview = undefined;
        focusPanel();
      }
      if (result.action?.type === 'pick' && input.type === 'mouse') {
        const id = result.action.id;
        const at = Date.now();
        const again = lastClickSwitch?.id === id && at - lastClickSwitch.at < 400;
        lastClickSwitch = again ? undefined : { id, at };
        if (again) {
          if (mainCols !== null && mainCols < 63)
            navigationMessage = t('The Codex pane is too narrow to show agent IDs; widen it, then try again.');
          else void switchSession(id);
        }
      }
      if (!previous.keys && state.keys) focusPanel();
      if (previous.keys && !state.keys) focusMain();
      updateProgress();
      render();
      // A tab shown in the tabs layout is read for at once, as an opened pane is.
      if (
        state.selectedWorktree !== previous.selectedWorktree ||
        JSON.stringify(state.modes) !== JSON.stringify(previous.modes) ||
        (state.tabbed && state.focus !== previous.focus)
      )
        void refreshGit();
      void refreshInspection();
      if (
        result.action &&
        (result.action.type === 'delegation-open' ||
          result.action.type === 'delegation-log' ||
          result.action.type === 'delegation-copy' ||
          result.action.type === 'delegation-diagnostic')
      ) {
        const action = result.action;
        const selected = state.tree.selectedId;
        const execute = () =>
          dispatchPanelAction(tree, action.key, () =>
            dispatchDelegationAction(
              action,
              actionFrame?.delegation?.vm,
              panelDelegation,
              actionRoot === tree.rootId && actionEpoch === collectionEpoch,
              {
                home: delegationCollector?.home ?? null,
                copy: clipboard.copy,
                openLog: () => {
                  if (!delegationCollector?.home) return false;
                  const opened = runLogs.open(delegationCollector.home, action.key, logContext());
                  if (opened) {
                    focusPanel();
                    render();
                  }
                  return opened;
                },
                open: async () => {
                  const target = panelHostTarget(panelDelegation, action.key);
                  const epoch = panelEpoch;
                  const root = tree.rootId;
                  return target
                    ? panelHost.open(target, () => {
                        const next = panelHostTarget(delegation, action.key);
                        return (
                          !closed &&
                          root === tree.rootId &&
                          epoch === panelEpoch &&
                          state.tree.selectedId === selected &&
                          !!next &&
                          panelHostStamp(next) === panelHostStamp(target)
                        );
                      })
                    : 'Open unavailable for this run.';
                },
              }
            )
          ) ?? Promise.resolve('');
        void (action.type === 'delegation-open' ? openOnce(action.key, execute) : execute()).then((message) => {
          if (
            message === null ||
            closed ||
            actionRoot !== tree.rootId ||
            !sameDelegationActionTarget(actionFrame?.delegation?.vm, panelDelegation, action.key) ||
            state.tree.selectedId !== selected
          )
            return;
          navigationMessage = message;
          render();
        });
      }
      if (result.action?.type === 'switch') {
        const id = result.action.id;
        const at = Date.now();
        // Deduplicate a mouse burst only. This is NOT evidence of Codex's current thread.
        const duplicate = input.type === 'mouse' && lastClickSwitch?.id === id && at - lastClickSwitch.at < 400;
        if (input.type === 'mouse') lastClickSwitch = { id, at };
        if (
          !duplicate &&
          (!actionFrame?.delegation ||
            (actionFrame.delegation.vm === panelDelegation &&
              actionRoot === tree.rootId &&
              actionEpoch === collectionEpoch))
        )
          void switchSession(id);
        else if (!duplicate) {
          navigationMessage = t('Selection changed; try again.');
          render();
        }
      }
    }
    if (!STANDALONE_PANEL && forward.length) void forwarder.send(forward);
    if (!settingsPage) probe.cancel();
    if (!closed && !overlayBefore && (settingsPage || state.help || activityHub || observability)) focusPanel();
  };
  const dispatch = (inputs: WorkbenchInput[]) =>
    withInputRefresh(
      inputs.length > 0,
      () => processInput(inputs),
      () => {
        if (!closed) void collect(true);
      }
    );
  /** A command that opened the panel (bin/codex-hud-toggle --command): run once, after the first read. */
  const initialCommand = process.env.CODEX_HUD_INITIAL_COMMAND;
  delete process.env.CODEX_HUD_INITIAL_COMMAND;
  const runInitialCommand = () => {
    if (initialCommand && isPanelCommand(initialCommand)) dispatch([{ type: 'command', command: initialCommand }]);
  };
  const onData = (chunk: Buffer) => {
    if (escapeTimer) clearTimeout(escapeTimer);
    dispatch(decoder.push(chunk));
    escapeTimer = setTimeout(() => dispatch(decoder.flushEscape()), 40);
  };
  if (STANDALONE_PANEL && delegationCollector) {
    try {
      publicationWorker = new PublicationWorker(
        delegationCollector.home,
        getCodexHome(),
        (changed, error, displays) => {
          if (closed) return;
          const displayChanged = delegationCollector.acceptPublicationDisplays(displays ?? []);
          const previousError = publicationError;
          publicationError = error;
          if (error) {
            render();
          } else if (previousError) {
            render();
          }
          if (changed || displayChanged) {
            workerRefresh = true;
            void collect(true);
          }
        }
      );
    } catch {
      publicationError = 'observation_worker_unavailable';
    }
  }
  await new Promise<void>((resolve) => {
    resolveDone = resolve;
    process.once('SIGINT', () => finish());
    process.once('SIGTERM', () => finish());
    process.once('SIGHUP', () => finish());
    process.stdin.once('end', () => finish());
    process.stdout.on('resize', () => {
      lastPaint = null;
      render();
      readMainCols();
      void refreshInspection();
      // A client attaching at another size shares the change with this pane;
      // wait for the burst of resizes to settle, then take back the policy width.
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        void widthKeeper?.follow().catch(() => {});
      }, 150);
    });
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdout.write(settings.mouse ? ENTER : '\x1b[?1049h\x1b[?25l\x1b[?2004h');
    void widthKeeper?.apply().catch(() => {});
    process.stdin.resume();
    process.stdin.on('data', onData);
    render();
    readMainCols();
    loadArt();
    void collect().then(runInitialCommand);
    void refreshGit();
    armCollect();
    scheduleRepaint();
    timers.push(setInterval(() => void refreshGit(), 3000));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  runLivePage()
    .catch((error) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(() => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdout.write(LEAVE);
      process.exit(process.exitCode ?? 0);
    });
