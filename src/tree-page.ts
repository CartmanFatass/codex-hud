import { openEditorPane, closePanelPane, watchPanelCaller } from './cli/panel-pane.js';
import { ProjectCollector, projectShown } from './collectors/project-board.js';
import { ProjectVisits, ProjectOverviews, type ProjectOverview } from './collectors/project-visits.js';
import { projectList } from './roles/projects.js';
import { editPlaces, placeItem } from './roles/role-control.js';
import { pathToFileURL } from 'node:url';
import { PanelReload, readPanelPlace } from './utils/panel-reload.js';
import { theme } from './render/colors.js';
import { makeSourceId } from './core/identity.js';
import { externalRootHash } from './roles/external-association.js';
import { parseRosterRoot, formatRosterRoot } from './roles/selection.js';
import type { SessionRef } from './core/types/identity.js';
import { JobObservationCollector, type JobObserverOptions, type JobReadSlice } from './collectors/job-observations.js';
import type { JobSnapshot } from './collectors/job-display-types.js';
import { TaskObservationCollector } from './collectors/task-observations.js';
import { buildWorkboard } from './collectors/workboard.js';
import { readThinJobs, type ThinJobScope } from './collectors/thin-jobs.js';
import type { TaskSnapshot, WorkboardSnapshot } from './collectors/workboard-types.js';
import { composeJobTree, type JobTreeResult } from './collectors/job-tree.js';
import { NativeCallCollector } from './collectors/native-calls.js';
import { performance } from 'node:perf_hooks';
import type { DelegationViewModel } from './core/link/view-model.js';
/** Live keyboard/mouse workbench beside the compact HUD. */
import {
  withInputRefresh,
} from './utils/delegation-actions.js';
import { readHudCredentials, decisionKeys } from './jev/ask/config.js';
import { defaultSettings, loadSettings, saveSettings, settingsPath, type HudSettings } from './settings.js';
import { homedir } from 'node:os';
import { runtimeSettings, applyDisplaySettings, withDisplaySettings } from './settings-runtime.js';
import { treeWidthKeeper } from './utils/pane-width.js';
import { frameDiff } from './render/frame-diff.js';
import {
  renderSettingsPage,
  handleSettingsInput,
  settingsDirty,
  resetSettingsGroup,
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
import { SessionFinder, findRolloutsInDaysYielding, treeLookbackDays } from './collectors/session-finder.js';
import { RolloutParser, type RolloutParseResult } from './collectors/rollout.js';
import {
  buildSubagentTreeYielding,
  useTreeScanStore,
  flushTreeScans,
} from './collectors/subagent-tree.js';
import { TreeScanStore } from './collectors/tree-scan-store.js';
import { WorktreeCollector, worktreeSources, type WorktreesSnapshot } from './collectors/worktrees.js';
import {
  renderMonitor,
  fit,
  initialMonitorState,
  reconcileMonitor,
  handleMonitorInput,
  monitorModes,
  monitorSettings,
  monitorPreferences,
  nextRepaintDelay,
  msUntilAgeChanges,
  msUntilCountdownChanges,
  finishedAt,
  paneShown,
  type MonitorFrame,
  type MonitorState,
} from './render/monitor.js';
import { projectListOpen } from './render/project-view.js';
import { WorkbenchInputDecoder, type WorkbenchInput } from './utils/workbench-input.js';
import { isPanelCommand, monitorKey, overlayKey, prefixName, type PanelCommand } from './utils/panel-command.js';
import { KeyForwarder, type ForwardItem } from './utils/key-forward.js';
import { fileSignature } from './utils/file-signature.js';
import { readAgentTokens, type AgentTokens } from './collectors/agent-context.js';
import { SmallModel, modelHttpRequest } from './collectors/small-model.js';
import { ModelProbe, apiSettings } from './collectors/model-probe.js';
import { JobSentences } from './collectors/job-sentences.js';
import { DecisionLabels } from './collectors/decision-labels.js';
import { HomeRecommendation } from './collectors/home-recommendation.js';
import { DecisionTitles } from './collectors/decision-titles.js';
import { hudProblems } from './render/hud-diagnostics.js';
import { createAdaptivePollState, forceAdaptivePoll, recordAdaptivePoll } from './collectors/adaptive-poll.js';
import { collectionObservation, jobPanelObservation } from './utils/collection-observation.js';
import { jobOnlyNode, displayOnlySummaryRoot } from './collectors/model-jobs.js';
import { ClaudeNativeTree } from './collectors/claude-native-tree.js';
import { getCodexHome } from './utils/codex-path.js';
import { getHudDisplayHome } from './hud-home.js';
import { HudStatus } from './collectors/hud-status.js';
import { Notifier, resolveNotifierOptions } from './notify.js';
import { buildSnapshot, SnapshotWriter } from './snapshot.js';
import { resolveResetTime } from './render/quota.js';
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
  private thinJobs: ReturnType<typeof readThinJobs> = [];
  private thinObservation = { complete: false };
  observation(tree: SubagentTree, legacy: DelegationViewModel | null, nativeQuiet: boolean) {
    return jobPanelObservation(this.workboard(tree, legacy), this.thinObservation.complete, nativeQuiet);
  }
  private snapshot: JobSnapshot | null = null;
  private generation = 0;
  private closed = false;
  /** Collection-only bridge; presentation never invokes it. Consumes this slice's remainder. */
  constructor(
    readonly home: string,
    private root: string | null,
    private readonly options: JobObserverOptions = {},
    private readonly workspace: string | null = null,
    private readonly thinScope: ThinJobScope = { project: workspace, pane: null },
    readonly openedAt = Date.now()
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
    const base = buildWorkboard(this.observer.home, tasks, jobs, tree, legacy);
    const board = {
      ...base,
      lanes: [...this.thinJobs, ...base.lanes],
      workers: [...this.thinJobs.flatMap((lane) => lane.workers), ...base.workers],
      decisions: [...this.thinJobs.flatMap((lane) => lane.decisions), ...base.decisions],
    };
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
    this.thinJobs = readThinJobs(this.home, this.thinScope, JSON.parse, { openedAt: this.openedAt }, this.thinObservation);
    this.boardCache = undefined;
    this.snapshot = snapshot;
    this.taskSnapshot = tasks;
    charge?.(
      snapshot.coverage.bytes + tasks.cost.bytes,
      snapshot.coverage.entries + tasks.cost.entries + snapshot.coverage.files + tasks.cost.files + tasks.cost.probes,
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

export async function runLivePage(options: { installCleanup?: (end: () => void) => () => void } = {}): Promise<void> {
  const reload = new PanelReload(), place = readPanelPlace(), openedAt = place?.openedAt ?? Date.now();
  let restarting: Promise<void> | undefined;
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
  const nativeCalls = NativeCallCollector.fromEnv();
  const jobPipeline = new PanelJobPipeline(nativeCalls.home, selectedRoot, {}, allDelegations ? null : HUD_CWD_REAL, {
    project: HUD_CWD_REAL,
    pane: process.env.HUD_PANEL_CALLER_PANE || process.env.HERDR_PANE_ID || null,
  }, openedAt);
  let disposeLifetime: (() => void) | undefined;
  let disposeCaller: (() => void) | undefined;
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
  useTreeScanStore(new TreeScanStore(path.join(getHudDisplayHome(), 'scan')));
  const finder = new SessionFinder(HUD_CWD_REAL, undefined, HUD_SESSION_START);
  const parser = new RolloutParser(40);
  const worktreeCollector = new WorktreeCollector();
  // One collector per project the tab has shown (this one's always); Home reads only the panel's own.
  const visits = new ProjectVisits(HUD_CWD_REAL, (root) => new ProjectCollector(root, jobPipeline.home));
  let projects = projectList(jobPipeline.home, HUD_CWD_REAL);
  let projectsAt = Date.now();
  // The Projects list reads every listed project lightly, and only while it is open.
  const overviews = new ProjectOverviews((root) => new ProjectCollector(root, jobPipeline.home), HUD_CWD_REAL);
  let overview = new Map<string, ProjectOverview>();
  let overviewAt = -Infinity;
  const listing = (s: MonitorState) => projectShown(s) && projectListOpen(s, projects);
  const shownRoot = () => projects.find((p) => p.root === state.projectRoot)?.root ?? HUD_CWD_REAL;
  // Typing here goes to Codex; with no Codex pane to give it to (the panel
  // run on its own), the keys drive the panel as they used to.
  const mainPane = STANDALONE_PANEL ? undefined : resolveMainPane();
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
    next.modes = monitorModes(settings);
    return { ...next, ...monitorSettings(settings) };
  };
  const availableDecisionKeys = () => { try { return decisionKeys(readHudCredentials()); } catch { return undefined; } };
  let state = { ...configuredState(), ...place?.state };
  let settingsPage: SettingsPageState | null = place?.settings
    ? { ...place.settings, draft: { ...settings }, original: { ...settings }, decisionKeys: availableDecisionKeys(), message: '' } : null;
  let settingsFrame: SettingsFrame | undefined;
  let settingsLeave: (SettingsConfirmationState & { destination?: string }) | null = null;
  let confirmationFrame: SettingsConfirmationFrame | undefined;
  // The first read of a long rollout takes seconds; until then say so.
  let collected = false;
  let panelDelegation: DelegationViewModel | null = null;
  const syncPanelView = () => {
    panelDelegation = delegation;
  };
  let tree: SubagentTree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date() };
  // The root the tree was last built for: until then an empty tree is not news.
  let treeBuiltFor: string | null = null;
  let main: RolloutParseResult | null = null;
  // Size/mtime/inode as of the last parse: this page runs its own parser over
  // the same rollout as the HUD, so it re-reads nothing while the file is still.
  let lastParsedRollout: string | null = null;
  let worktrees: WorktreesSnapshot | null = null;
  let collectingGit = false;
  let gitAgain = false;
  let error: string | null = settingsError || null;
  // What the last Control plane key could not do; shown until the next key.
  let roleNotice = '';
  let frame: MonitorFrame | undefined;
  let lastPaint: string[] | null = null;
  let closed = false;
  let collecting = false;
  // Per-agent context fill and output rate, kept beside the tree because the
  // tree is rebuilt from the rollout on every collection and would otherwise lose them.
  const agentContext = new Map<string, AgentTokens>();
  const agentContextReadAt = new Map<string, number>();
  let readingAgentContext = false;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let widthOverride = place?.widthOverride === null ? undefined
    : place?.widthOverride ?? (Number(process.env.HUD_PANEL_WIDTH) || undefined);
  const widthKeeper = STANDALONE_PANEL && !process.env.HUD_PANEL_CALLER_PANE
    ? null : treeWidthKeeper(() => widthOverride ?? settings.treeWidth);
  // Every model call of the panel goes through one service: one queue, one
  // cache, one hourly cap. Its cache and call log live beside the HUD's state.
  let modelOn = false;
  let modelChanged = () => {};
  const model = new SmallModel({ dir: path.join(getHudDisplayHome(), 'model-cache'), onChange: () => modelChanged() });
  const probe = new ModelProbe({ dir: path.join(getHudDisplayHome(), 'model-cache') }, () => render());
  const jobSentences = new JobSentences(
    model,
    path.join(getHudDisplayHome(), 'model-cache', 'job-sentences.json'),
    () => render()
  );
  const decisionTitles = new DecisionTitles(
    model,
    path.join(getHudDisplayHome(), 'model-cache', 'decision-titles.json'),
    () => render()
  );
  const decisionLabels = new DecisionLabels(path.join(getHudDisplayHome(), 'model-cache'), () => render());
  const homeRecommendation = new HomeRecommendation(path.join(getHudDisplayHome(), 'model-cache'), model, () => render());
  const displayBoard = () => decisionLabels.apply(decisionTitles.apply(jobSentences.apply(jobPipeline.workboard(tree, panelDelegation))));
  const claudeNative = new ClaudeNativeTree();
  const configureModel = () => {
    modelOn =
      settings.modelEnabled &&
      !('error' in modelHttpRequest(apiSettings(settings), { feature: 'progress', system: '', prompt: '' }));
    model.configure({
      backend: modelOn ? 'api' : 'off',
      api: {
        base: settings.briefingApiBase,
        model: settings.model,
      },
      hourlyCap: settings.modelCallsPerHour,
    });
    decisionLabels.configure(settings.modelEnabled, settings.decisionCallsPerHour);
    homeRecommendation.configure(settings.homeMode === 'recommended' && settings.modelEnabled, resolveLanguage(settings.language), settings.decisionCallsPerHour, settings.decisionApi, settings.summaryIntervalMinutes, settings);
    jobSentences.configure(modelOn, resolveLanguage(settings.language), settings.summaryIntervalMinutes);
    decisionTitles.configure(modelOn, resolveLanguage(settings.language));
  };
  configureModel();
  // The bar's fields, for the foot of the panel: the panel replaces the bar
  // while it is open. Fed from this page's own parse of the rollout.
  const hudStatus = new HudStatus(HUD_CWD, () => render(), 30_000);
  const currentHud = () => {
    if (selectedRoot && selectedRoot !== boundJobRoot) return undefined;
    const data = hudStatus.current();
    return data
      ? {
          ...data,
          modelHealth: !modelOn ? undefined : model.diagnostics(),
        }
      : undefined;
  };
  // The panel replaces the bar, so it publishes the same notifications and snapshot.
  const notifier = new Notifier(resolveNotifierOptions(process.env, settings));
  const snapshotWriter = new SnapshotWriter();
  const timers: Array<ReturnType<typeof setInterval>> = [];
  // Collection runs at the refresh setting; repaints between collections only
  // move the clocks, once a second (see nextRepaintDelay).
  let collectTimer: ReturnType<typeof setTimeout> | undefined;
  let collectEvery = 0;
  let collectClock = 0;
  let adaptive = createAdaptivePollState(settings.refreshMs);
  let collectionEpoch = 0;
  let repaintTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone = () => {};

  const render = () => {
    if (closed || (place && !collected)) return;
    syncPanelView();
    const output = time('render', () => {
      let lines: string[];
      if (settingsPage) {
        settingsFrame = withDisplaySettings(settingsPage.draft, () =>
          renderSettingsPage(settingsPage!, process.stdout.columns || 30, process.stdout.rows || 24, {
            state: hudStatus.health.current(),
            modelCalls: model.usage(),
            decisionCalls: decisionLabels.usage(),
            probe: probe.current(),
            settingsFile: shortPath(settingsPath()),
          })
        );
        settingsPage = settingsFrame.state;
        lines = settingsFrame.lines;
        if (settingsLeave) {
          confirmationFrame = renderSettingsConfirmation(
            lines,
            settingsLeave,
            process.stdout.columns || 30,
            process.stdout.rows || 24,
            1,
            settingsPage
          );
          lines = confirmationFrame.lines;
        }
      } else {
        const width = process.stdout.columns || 30;
        const nowMs = Date.now();
        const hud = currentHud();
        const jobRender = panelJobRenderState(jobComposition, !collected || treeBuiltFor !== tree.rootId);
        // The Project tab keeps the previous project's page until a project just switched to has been read once.
        const shown = state.mainTab === 'project' ? visits.shown(shownRoot()) : { root: HUD_CWD_REAL, snapshot: visits.snapshot(HUD_CWD_REAL) };
        frame = renderMonitor({
          tree,
          workboard: state.mainTab === 'home' && state.focus === 'agents' && !state.help ? homeRecommendation.apply(displayBoard()) : displayBoard(),
          modelEnabled: settings.modelEnabled,
          mouse: settings.mouse,
          embedded: !STANDALONE_PANEL,
          state,
          worktrees,
          project: shown.snapshot,
          projectName: projects.find((p) => p.root === shown.root)?.name ?? path.basename(HUD_CWD_REAL),
          projects: listing(state) ? projects.map((p) => ({ ...p, overview: overview.get(p.root) })) : projects,
          error,
          nowMs,
          hud: hud ? { ...hud, delegation: panelDelegation } : hud,
          notice: jobRender.notice || hudProblems(hud, nowMs, t)[0],
          loading: jobRender.loading,
          prefix: prefixName(settings.prefixKey),
          width,
          height: process.stdout.rows || 24,
        });
        state = frame.state;
        lines = frame.lines;
      }
      return lines;
    });
    if (reload.failed) output[output.length - 1] = fit(theme.dim(t('new build failed to load')), process.stdout.columns || 30);
    const update = frameDiff(lastPaint, output);
    lastPaint = output;
    if (update) time('write', () => process.stdout.write(update));
  };
  modelChanged = () => {
    adaptive = forceAdaptivePoll(adaptive);
    collectionEpoch++;
    render();
    void collect(true);
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
    if (settingsPage) return nextRepaintDelay(now, anchor);
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
    return Math.min(60_000, Math.max(1, wait));
  };
  const scheduleRepaint = () => {
    if (closed) return;
    repaintTimer = setTimeout(() => {
      render();
      scheduleRepaint();
    }, repaintDelay());
  };
  /** (Re)arm collection at the refresh setting; a no-op while it is unchanged. */
  const armCollect = () => {
    if (closed || (collectTimer && collectEvery === settings.refreshMs)) return;
    if (collectTimer) clearTimeout(collectTimer);
    collectEvery = settings.refreshMs;
    collectClock = Date.now();
    adaptive = createAdaptivePollState(collectEvery);
    collectTimer = setTimeout(() => void collect(), collectEvery);
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
        if (!path || byId.get(id)?.ref?.harness === 'claude') continue;
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
        tree = { ...tree };
        render();
      }
    } catch {
      /* A rollout that cannot be read has no fill to report. */
    } finally {
      readingAgentContext = false;
    }
  };
  const collectionScope = () => `${tree.rootId}:${state.focus}:${JSON.stringify(state.modes)}`;
  const collect = async (force = false) => {
    if (force) {
      adaptive = forceAdaptivePoll(adaptive);
      collectionEpoch++;
    }
    if (closed || collecting) return;
    const ready = await reload.poll(() => Boolean(settingsPage && settingsDirty(settingsPage)));
    if (closed) return;
    if (ready) {
      restarting = reload.restart({ state, openedAt, widthOverride: widthOverride ?? null,
        settings: settingsPage && { selected: settingsPage.selected, offset: settingsPage.offset } }, () => finish());
      await restarting;
      return;
    }
    if (collecting) return;
    const epoch = collectionEpoch;
    await timeAsync('collect', collectNow);
    if (epoch === collectionEpoch) {
      const data = currentHud();
      const native = collectionObservation(data, tree);
      const jobOnly = STANDALONE_PANEL && !boundJobRoot;
      const jobQuiet = jobOnly && !selectedRoot && !nativeTree.nodes.length && native.activity !== 'active';
      const observation = jobOnly
        ? jobPipeline.observation(tree, panelDelegation, jobQuiet && nativeCalls.emptyAndComplete)
        : { ...native, succeeded: data?.health?.sessionBound === true };
      adaptive = recordAdaptivePoll(adaptive, {
        scopeKey: collectionScope(),
        nowMs: Date.now(),
        ...observation,
        fingerprint: JSON.stringify([native.fingerprint, observation.fingerprint]),
        succeeded: observation.succeeded && !data?.stale && !error,
      });
      if (collectTimer) clearTimeout(collectTimer);
      let due = adaptive.nextDueAt;
      if (adaptive.intervalMs === collectEvery)
        due += (collectEvery - ((due - collectClock) % collectEvery)) % collectEvery;
      if (!closed) collectTimer = setTimeout(() => void collect(), Math.max(1, due - Date.now()));
    } else if (!closed) void collect(true);
  };
  const collectNow = async () => {
    collecting = true;
    try {
      await collectNowBody();
    } finally {
      collecting = false;
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
      const jobRead = jobPipeline.refresh(undefined, { deadline: delegationDeadline });
      await jobRead;
      if (closed) return;
      const nativeRead = selectedRoot
        ? nativeCalls.collect()
        : nativeCalls.collectCodex(session?.sessionId, getCodexHome(), allDelegations);
      const legacyDelegation = null;
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
      await nativeRead;
      await jobRead;
      if (closed) return;
      delegation = nativeCalls.merge(legacyDelegation);
      stage = 'tree';
      const claude =
        selectedRoot && process.env.CODEX_HUD_PANEL_HARNESS === 'claude' && process.env.CODEX_HUD_PANEL_SOURCE
          ? claudeNative.refresh(process.env.CODEX_HUD_PANEL_SOURCE, parseRosterRoot(selectedRoot).sessionId)
          : undefined;
      const rootId = main?.session?.id ?? session?.sessionId ?? claude?.rootId ?? selectedRoot ?? '';
      if (rootId !== tree.rootId) {
        if (treeBuiltFor !== null) state = configuredState();
        worktrees = null;
        // Cancel old-root writers before loading the next root's model log.
        decisionLabels.stop();
        homeRecommendation.stop();
        jobSentences.stop();
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
          : (claude ?? { rootId, nodes: [], totalCount: 0, updatedAt: new Date() });
      if (closed) return;
      nativeTree = tree;
      applyJobComposition(legacyDelegation);
      treeBuiltFor = rootId;
      applyAgentContext();
      state = reconcileMonitor(state, tree, Date.now(), delegation);
      const visibleDecisions = new Set(
        (frame?.panes ?? []).flatMap((p) => p.rows.slice(p.offset, p.offset + (p.visible ?? 0)).map((r) => r.item!))
      );
      decisionTitles.update(jobPipeline.workboard(tree, panelDelegation), jobPipeline.home, visibleDecisions);
      decisionLabels.update(jobPipeline.workboard(tree, panelDelegation), jobPipeline.home, tree);
      jobSentences.update(jobPipeline.workboard(tree, panelDelegation), jobPipeline.home, tree);
      homeRecommendation.update(displayBoard());
      // Only the shown project is collected; the list of projects is read again at most every five seconds.
      const shown = projectShown(state, Boolean(settingsPage));
      if (shown && Date.now() - projectsAt >= 5000) {
        projectsAt = Date.now();
        projects = projectList(jobPipeline.home, HUD_CWD_REAL);
      }
      // The open list reads the light overviews instead of the shown project's full collection (Git included), at most once
      // per five seconds; opening it again reads at once.
      if (shown && listing(state)) {
        if (Date.now() - overviewAt >= 5000) {
          overviewAt = Date.now();
          overview = await overviews.read(projects.map((p) => p.root), jobPipeline.workboard(tree, panelDelegation), Date.now());
        }
      } else overviewAt = -Infinity;
      const visit = visits.visit(shown ? shownRoot() : HUD_CWD_REAL);
      const projectFacts = await visit.collector.collect(
        shown ? !listing(state) : state.focus === 'agents' && !state.help && !settingsPage ? 'home' : false,
        jobPipeline.workboard(tree, panelDelegation),
        Date.now()
      );
      if (projectFacts) visit.snapshot = projectFacts;
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
      if (delegation) Object.assign(built, { delegation });
    } catch (err) {
      hudStatus.health.fail('status', err); /* The foot keeps its last good rows. */
    }
    if (built && !stale) {
      notifier.update(built, Date.now(), jobPipeline.workboard(tree, panelDelegation));
      try {
        snapshotWriter.write(buildSnapshot(built, { width: 0, segments: [] }));
      } catch {
        /* A state file nobody can write is not a reason to stop drawing. */
      }
    }
    // Collection owns publication. Paint only consumes the same cached workboard.
    syncPanelView();
    render();
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
    if (state.focus !== 'changes') return;
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
      render();
    } catch (err) {
      hudStatus.health.fail('worktrees', err);
      worktrees = { sourcePath: null, entries: [], updatedAt: Date.now(), error: 'Worktree read failed' };
      render();
    } finally {
      collectingGit = false;
      if (gitAgain && !closed) {
        gitAgain = false;
        void refreshGit();
      }
    }
  };
  const finish = (user = false, callerGone = false) => {
    if (closed) return;
    closed = true;
    disposeLifetime?.();
    disposeCaller?.();
    jobPipeline.dispose();

    jobSentences.stop();
    decisionTitles.stop();
    decisionLabels.stop();
    homeRecommendation.stop();
    model.cancelAll();
    probe.cancel();
    flushTreeScans();
    timers.forEach(clearInterval);
    if (collectTimer) clearTimeout(collectTimer);
    if (repaintTimer) clearTimeout(repaintTimer);
    stopProfiling();
    if (escapeTimer) clearTimeout(escapeTimer);
    if (resizeTimer) clearTimeout(resizeTimer);
    process.off('SIGINT', onFinish);
    process.off('SIGTERM', onFinish);
    process.off('SIGHUP', onFinish);
    process.stdin.off('end', onFinish);
    process.stdout.off('resize', onResize);
    process.stdin.off('data', onData);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(LEAVE);
    snapshotWriter.remove();
    if (user) requestEnsureSingle();
    if (callerGone) void closePanelPane(process.env.HERDR_PANE_ID!, process.env).catch(() => {}).finally(resolveDone);
    else resolveDone();
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
      const previousPrefix = settings.prefixKey, previousWidth = settings.treeWidth;
      settings = saveSettings(page.draft);
      if (settings.treeWidth !== previousWidth) widthOverride = undefined;
      settingsError = '';
      error = null;
      applyDisplaySettings(settings);
      setLanguage(resolveLanguage(settings.language));
      configureModel();

      armCollect();
      state = {
        ...state,
        ...monitorSettings(settings),
        modes: monitorModes(settings),
        zoom: false,
        scroll: { ...state.scroll, agents: 0 },
      };
      worktrees = null;
      void refreshGit();
      notifier.configure(resolveNotifierOptions(process.env, settings));
      if (settings.prefixKey !== previousPrefix) reinstallPrefix(settings.prefixKey);
      page.message = t('Saved');
      page.original = { ...settings };
      process.stdout.write(settings.mouse ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1000l\x1b[?1006l');
      void (settings.treeWidth !== previousWidth ? widthKeeper?.apply() : undefined)
        ?.then(() => {
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
    const overlayBefore = Boolean(settingsPage || state.help);
    // What goes to Codex, in order, sent once the whole read is through.
    const forward: ForwardItem[] = [];
    if (roleNotice && inputs.length) {
      if (error === roleNotice) error = settingsError || null;
      roleNotice = '';
    }
    for (let input of inputs) {
      if (closed) break;
      if (input.type === 'mouse' && !settings.mouse) continue;
      syncPanelView();
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
          render();
          continue;
        }
        // Preserve the destination by key, not old mouse coordinates: Save
        // may have changed the pane width and therefore every tab's hit span.
        input = { type: 'key', key: destination };
        panelInput = true;
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
      if (input.type === 'paste') continue;
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
              group === 'Models'
                ? 'Model generation disabled; connection preserved; Save to apply'
                : 'Group defaults ready; Save to apply'
            ),
          };
        } else if (result.action === 'save') applySettingsDraft();
        else if (result.action === 'test-api') {
          if (probe.current().running) probe.cancel();
          else
            void probe.run({ ...settingsPage.draft }).catch(() => {
              probe.cancel();
              if (settingsPage) settingsPage.message = t('Connection test failed');
              render();
            });
        }
        render();
        continue;
      }
      const previous = state;
      const result = handleMonitorInput(state, input, {
        tree,
        frame,
        navigationOverlay: fromSettings,
        standalone: STANDALONE_PANEL,
      });
      state = result.state;
      syncPanelView();
      if (previous.focus !== 'changes' && state.focus === 'changes') void refreshGit();
      if (projectShown(state) && (!projectShown(previous) || listing(previous) !== listing(state))) void collect(true);
      if (result.close) {
        finish(true);
        break;
      }
      if (JSON.stringify(state.modes) !== JSON.stringify(previous.modes)) {
        try {
          settings = saveSettings(monitorPreferences(state));
        } catch (err) {
          settingsError = t('Panel preferences could not be saved: {reason}', { reason: String(err) });
          error = settingsError;
        }
      }
      if (result.action?.type === 'open-files') {
        void openEditorPane(result.action.files, process.env).catch((err) => {
          error = String(err);
          render();
        });
      }
      if (result.action?.type === 'role-edit') {
        const { type: _type, ...edit } = result.action;
        const done = editPlaces(jobPipeline.home, shownRoot(), process.env, edit);
        if (done.ok && done.index !== undefined) state = { ...state, projectCursor: placeItem(edit.role, done.index), boardRevealed: undefined };
        // Read the roles again now, so this frame (and a cursor on a new row) show what the next job will use; the
        // collection after every key reads everything else.
        const visit = visits.visit(shownRoot());
        if (visit.snapshot) visit.collector.refreshRoles(visit.snapshot, Date.now());
        roleNotice = done.ok ? '' : t(done.message ?? 'could not save the change') + (done.reason ? `: ${done.reason}` : '');
        error = roleNotice || settingsError || null;
      }
      if (result.action?.type === 'brief-toggle') {
        try {
          settings = saveSettings({ modelEnabled: !settings.modelEnabled });
          configureModel();
          if (modelOn) void collect();
        } catch (err) {
          settingsError = t('Panel preferences could not be saved: {reason}', { reason: String(err) });
          error = settingsError;
        }
      }
      if (result.action?.type === 'settings') {
        let decisionApi = settings.decisionApi;
        try { decisionApi = loadSettings().decisionApi; } catch { /* Keep the loaded draft. */ }
        settingsPage = {
          draft: { ...settings, ...monitorPreferences(state), decisionApi },
          decisionKeys: availableDecisionKeys(),
          selected: 0,
          offset: 0,
          message: '',
        };
      }
      if (!previous.keys && state.keys) focusPanel();
      if (previous.keys && !state.keys) focusMain();
      render();
    }
    if (!STANDALONE_PANEL && forward.length) void forwarder.send(forward);
    if (!settingsPage) probe.cancel();
    if (!closed && !overlayBefore && (settingsPage || state.help)) focusPanel();
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
    if (!place && initialCommand && isPanelCommand(initialCommand)) dispatch([{ type: 'command', command: initialCommand }]);
  };
  const onData = (chunk: Buffer) => {
    if (escapeTimer) clearTimeout(escapeTimer);
    dispatch(decoder.push(chunk));
    escapeTimer = setTimeout(() => dispatch(decoder.flushEscape()), 40);
  };
  const onFinish = () => finish();
  const onResize = () => {
    lastPaint = null;
    render();
    // A client attaching at another size shares the change with this pane;
    // wait for the burst of resizes to settle, then take back the policy width.
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      void widthKeeper?.follow().catch(() => {});
    }, 150);
  };
  await new Promise<void>((resolve) => {
    resolveDone = resolve;
    disposeLifetime = options.installCleanup?.(onFinish);
    disposeCaller = watchPanelCaller(process.env, () => finish(false, true));
    process.once('SIGINT', onFinish);
    process.once('SIGTERM', onFinish);
    process.once('SIGHUP', onFinish);
    process.stdin.once('end', onFinish);
    process.stdout.on('resize', onResize);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdout.write(settings.mouse ? ENTER : '\x1b[?1049h\x1b[?25l\x1b[?2004h');
    void widthKeeper?.apply().catch(() => {});
    process.stdin.resume();
    process.stdin.on('data', onData);
    render();
    void collect().then(runInitialCommand);
    void refreshGit();
    armCollect();
    scheduleRepaint();
    timers.push(setInterval(() => void refreshGit(), 3000));
  });
  await restarting;
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
