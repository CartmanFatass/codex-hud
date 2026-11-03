/**
 * Synthetic delegation view models for the B10b presentation tests and the
 * visual baselines: a builder from a short node spec to the `DelegationViewModel`
 * the renderers read. Everything is invented (names, ids, times); a pinned
 * clock keeps the output stable. The shapes follow `src/core/link/*` and
 * `src/core/types/*`, filled with just the facts the view reads.
 */

import type { DelegationNodeDetails, DelegationViewModel } from '../../src/core/link/view-model.js';
import type { LinkRelationProjection, LinkTreeNode, LinkTreeProjection } from '../../src/core/link/types.js';
import type { StatusProjection } from '../../src/core/types/observation.js';
import { reconcileDescriptor } from '../../src/core/link/actions.js';
import { FIXED_NOW } from './hud-data.js';

export const NOW = FIXED_NOW.getTime();
/** A source id is a sha256 hex digest; this one is synthetic. */
const SOURCE_ID = 'ab'.repeat(32);
/** `n` seconds before the pinned clock. */
export const ago = (seconds: number): number => NOW - seconds * 1000;

export type HarnessName = 'claude' | 'codex' | 'pi';
type Cls =
  | 'working'
  | 'idle'
  | 'pending'
  | 'failed'
  | 'interrupted'
  | 'stale'
  | 'starting'
  | 'exited'
  | 'unknown'
  | 'uncertain'
  | 'conflict';

export interface StatusSpec {
  /** The B16 class; the reason after the colon is `reason`. */
  cls: Cls;
  reason?: string;
  since?: number | null;
  basis?: 'event' | 'observed' | 'unknown';
  evidenceAt?: number | null;
  freshness?: 'fresh' | 'stale' | 'unknown';
  freshnessReason?: string | null;
  pending?: 'approval' | 'question' | 'needs_human';
  outcome?: 'failed' | 'interrupted' | 'completed' | 'none';
  liveness?: 'alive' | 'gone' | 'unknown';
  /** `freshness.clockAnomaly`: the clock ran backwards, so no age is trustworthy (§3.4). */
  clockAnomaly?: boolean;
}

export interface RunSpec {
  state?: 'starting' | 'running' | 'cancelling' | 'uncertain' | 'ended' | 'failed' | 'cancelled';
  mode?: 'visible' | 'headless';
  createdAt?: number;
  endedAt?: number | null;
  cancelRequestedAt?: number | null;
  heartbeatAt?: number | null;
  exit?: { code: number | null; signal: string | null; source: 'wait_status' | 'trusted_harness_result' };
  /** Ledger-side facts that never reach the run row. */
  reconciliation?: 'supervisor_dead' | 'scope_unknown';
  requestedCause?: string;
  launchFailure?: boolean;
}

export interface ReportSpec {
  status: 'completed' | 'failed' | 'blocked' | 'interrupted';
  summary?: string;
  at: number;
}

export interface NodeSpec {
  id: string;
  parent?: string | null;
  harness?: HarnessName;
  kind?: 'session' | 'job' | 'intent';
  label?: string | null;
  role?: string;
  /** A native child of a session (no ledger run, no link). */
  native?: boolean;
  /** The viewpoint root. */
  root?: boolean;
  loaded?: boolean;
  /** `false`: no managed run (a plain session or a native child). Default for non-root, non-native nodes: a running headless run. */
  run?: false | RunSpec;
  report?: ReportSpec | null;
  /** `null`: the status is unavailable. */
  status?: StatusSpec | null;
  /** The reader says the observation cannot be read (renders as unavailable, whatever status is attached). */
  observationUnavailable?: string;
  conflict?: { count: number; since: number } | null;
  model?: string;
  effort?: string;
  contextPercent?: number;
  /** `null`: cost unknown; absent: unknown too. */
  costUsd?: number | null;
  pane?: string;
  createdAt?: number;
  linkState?: 'pending' | 'claimed' | 'bound' | 'reported';
  /** A conflict-claimed child is not in `nodes[]`; this makes a relation only. */
  relationOnly?: boolean;
  /** Further parents that claim the same child (conflict relations). */
  alsoClaimedBy?: string[];
  continuation?: boolean;
  // B10B-s2 additions (additive; rulings B10B-s2 Q3, Q9, Q10).
  /** The observed workspace; default: the shared synthetic checkout, so no node reads `in ?` by accident. */
  workspace?: { worktreeRoot?: string | null; worktree?: string; cwd?: string | null } | null;
  /** `link.boundAt`; default the node's creation time. `null`: bound at an unknown time. */
  boundAt?: number | null;
  /** `run.runSeq`; default 1. */
  runSeq?: number;
  /** `LinkTreeNode.native` for a native child (§7 #33). */
  nativeMeta?: {
    title: string | null;
    kind: 'research' | 'experiment' | 'fix' | 'review' | 'writing' | 'summary' | 'other' | null;
  };
  /** `reconciliation.missing`; default `[]`. */
  missing?: string[];
  /** `execution.terminal.note`. */
  terminalNote?: 'cancel_timing_unknown' | 'retire_timing_unknown';
  // B10B-s3 additions (additive; rulings B10B-s3 Q1, Q3, Q4).
  /** The node's `reconcile` descriptor: the real shipped template over synthetic ids (`l_<id>`, `r_<id>`). */
  reconcile?: boolean;
  /**
   * The host check failed: the locator is stale (or the occupant does not match), so `host.currentState` is null even
   * when a `pane` is named. Absent: a named `pane` is a verified host state, no `pane` is no host at all.
   */
  hostCheck?: 'stale' | 'mismatch';
}

/** The synthetic checkout every node works in unless a test says otherwise. */
export const DEFAULT_WORKSPACE = { worktreeRoot: '/work/parser-kit', cwd: '/work/parser-kit' } as const;

function statusOf(spec: StatusSpec): StatusProjection {
  const stateKey = spec.reason ? `${spec.cls}:${spec.reason}` : spec.cls;
  const activity =
    spec.cls === 'working'
      ? 'working'
      : spec.cls === 'idle'
        ? 'idle'
        : spec.cls === 'pending'
          ? 'waiting_input'
          : spec.cls === 'exited'
            ? 'exited'
            : spec.cls === 'stale'
              ? 'working'
              : spec.cls === 'failed' || spec.cls === 'interrupted'
                ? 'idle'
                : 'unknown';
  const liveness = spec.liveness ?? (spec.cls === 'exited' ? 'gone' : spec.cls === 'unknown' ? 'unknown' : 'alive');
  const freshness = spec.freshness ?? (spec.cls === 'stale' ? 'stale' : spec.cls === 'unknown' ? 'unknown' : 'fresh');
  return {
    activity,
    pendingReason: spec.pending ?? 'none',
    lastTurnOutcome:
      spec.outcome ?? (spec.cls === 'failed' ? 'failed' : spec.cls === 'interrupted' ? 'interrupted' : 'none'),
    liveness,
    freshness: {
      state: freshness,
      sources: [],
      requiredSourceIds: [],
      staleSince: null,
      reason: spec.freshnessReason ?? null,
      clockAnomaly: spec.clockAnomaly ?? false,
    },
    stateKey,
    stateSince: spec.since === undefined ? NOW : spec.since,
    stateSinceBasis: spec.basis ?? 'event',
    isRunTerminal: null,
    asOfSeq: 1,
    observationStamp: { commitSeq: 1 } as unknown as StatusProjection['observationStamp'],
    asOf: NOW,
    observedAt: NOW,
    lastEvidenceAt: spec.evidenceAt === undefined ? NOW : spec.evidenceAt,
  } as StatusProjection;
}

/** Shorthand status specs for the common classes. */
export const S = {
  working: (since = NOW - 60_000): StatusSpec => ({ cls: 'working', since }),
  idle: (since = NOW - 60_000): StatusSpec => ({ cls: 'idle', since }),
  pending: (pending: 'approval' | 'question' | 'needs_human', since: number): StatusSpec => ({
    cls: 'pending',
    reason: pending,
    pending,
    since,
  }),
  failed: (since: number): StatusSpec => ({ cls: 'failed', reason: 'turn', since }),
  interrupted: (since: number): StatusSpec => ({ cls: 'interrupted', reason: 'turn', since }),
  stale: (since: number, evidenceAt: number): StatusSpec => ({ cls: 'stale', reason: 'heartbeat', since, evidenceAt }),
  starting: (since: number): StatusSpec => ({ cls: 'starting', since }),
  exited: (since: number): StatusSpec => ({ cls: 'exited', reason: 'reported', since }),
  unknown: (): StatusSpec => ({ cls: 'unknown', since: null, basis: 'unknown', evidenceAt: null }),
};

const TERMINAL: ReadonlySet<string> = new Set(['ended', 'failed', 'cancelled']);

export interface Built {
  vm: DelegationViewModel;
  keys: Record<string, string>;
}

export interface BuildOptions {
  /** `tree.selectionMap`: an intent key to the session key it was bound to. */
  selectionMap?: Record<string, string>;
  capacity?: { active: number; limit: number; mine: number; mineLimit: number; uncertain?: number } | null;
}

const keyOf = (spec: NodeSpec): string =>
  spec.kind === 'job'
    ? `jev:${spec.id}`
    : spec.kind === 'intent'
      ? `intent:${spec.id}`
      : `${spec.harness ?? 'codex'}:${spec.id}`;

export function buildVm(specs: readonly NodeSpec[], options: BuildOptions = {}): Built {
  const keys: Record<string, string> = {};
  for (const spec of specs) keys[spec.id] = keyOf(spec);
  const depthOf = (spec: NodeSpec): number => {
    let depth = 0;
    let cursor = spec;
    while (cursor.parent) {
      const parent = specs.find((s) => s.id === cursor.parent);
      if (!parent) break;
      depth++;
      cursor = parent;
    }
    return depth;
  };
  const nodes: LinkTreeNode[] = [];
  const relations: LinkRelationProjection[] = [];
  const details: Record<string, DelegationNodeDetails> = {};
  const continuation: LinkTreeProjection['continuation'] = [];

  for (const spec of specs) {
    const key = keys[spec.id];
    const harness = spec.harness ?? 'codex';
    const managed = spec.run !== false && !spec.root && !spec.native && spec.kind !== 'job';
    const run = managed ? ({ state: 'running', mode: 'headless', ...(spec.run || {}) } as RunSpec) : null;
    const createdAt = spec.createdAt ?? ago(3600);
    const identity =
      spec.kind === 'job'
        ? { kind: 'job' as const, ref: { key: spec.id } }
        : spec.kind === 'intent'
          ? { kind: 'delegationIntent' as const, linkId: `l_${spec.id}` }
          : {
              kind: 'session' as const,
              ref: { harness, sourceId: SOURCE_ID, sessionId: `${spec.id}-0001`, threadId: null },
            };
    const ledgerRun = run
      ? {
          runId: `r_${spec.id}`,
          linkId: `l_${spec.id}`,
          state: run.state,
          mode: run.mode,
          createdAt: run.createdAt ?? createdAt,
          endedAt: run.endedAt ?? null,
          cancelRequestedAt: run.cancelRequestedAt ?? null,
          heartbeatAt: run.heartbeatAt ?? null,
          runSeq: spec.runSeq ?? 1,
          exitCode: run.exit?.code ?? null,
          exitSignal: run.exit?.signal ?? null,
          exitSource: run.exit?.source ?? null,
        }
      : null;
    const isRunTerminal = run ? TERMINAL.has(run.state!) : null;
    const observation =
      spec.status === null || spec.loaded === false
        ? null
        : {
            evidenceStamp: `ev-${spec.id}`,
            model: spec.model ? { value: spec.model, quality: 'reported', source: 'synthetic', asOf: NOW } : undefined,
            effort: spec.effort
              ? { value: spec.effort, quality: 'reported', source: 'synthetic', asOf: NOW }
              : undefined,
            context:
              spec.contextPercent === undefined
                ? undefined
                : {
                    value: { used: spec.contextPercent * 1000, window: 100_000, percent: spec.contextPercent },
                    quality: 'reported',
                    source: 'synthetic',
                    asOf: NOW,
                  },
            workspace:
              spec.workspace === null
                ? null
                : {
                    worktreeRoot: DEFAULT_WORKSPACE.worktreeRoot,
                    cwd: DEFAULT_WORKSPACE.cwd,
                    ...(spec.workspace ?? {}),
                  },
            spent: {
              costUsd:
                spec.costUsd === undefined || spec.costUsd === null
                  ? { value: null, quality: 'unknown', source: 'none', asOf: 0 }
                  : { value: spec.costUsd, quality: 'reported', source: 'synthetic-price', asOf: NOW },
            },
          };
    const node = {
      identity,
      key,
      parentKey: spec.parent ? keys[spec.parent] : null,
      edge: spec.root ? null : spec.native ? 'native' : spec.kind === 'intent' ? 'intent' : 'delegated',
      depth: depthOf(spec),
      crossHarnessDepth: 0,
      loaded: spec.loaded !== false,
      observation,
      lastObservation: null,
      currentRun: ledgerRun,
      execution: {
        isRunTerminal,
        execution: run ? 'managed' : 'unmanaged',
        launchFailure: run?.launchFailure ? { stateKey: 'launch_failed', reason: 'spawn_error' } : null,
        reconciliation: run?.reconciliation ? { cause: run.reconciliation, missing: spec.missing ?? [] } : null,
        terminal:
          run?.requestedCause || spec.terminalNote
            ? {
                note: spec.terminalNote ?? null,
                termination: run?.requestedCause ? { requestedCause: run.requestedCause } : null,
              }
            : null,
      },
      conflict: spec.conflict ?? null,
      links: [],
      host: spec.hostCheck
        ? {
            locator: null,
            state: spec.hostCheck === 'stale' ? 'stale' : 'valid',
            occupantMatches: spec.hostCheck === 'mismatch' ? false : null,
            checkedAt: NOW,
            currentState: null,
          }
        : spec.pane
          ? { locator: null, state: 'valid', occupantMatches: true, checkedAt: NOW, currentState: { label: spec.pane } }
          : null,
      parent: null,
      ...(spec.nativeMeta ? { native: spec.nativeMeta } : {}),
    } as unknown as LinkTreeNode;
    if (!spec.relationOnly) nodes.push(node);
    if (spec.continuation) continuation.push({ key, identity, reason: 'native_topology' } as never);

    const status = spec.status === null ? null : statusOf(spec.status ?? (spec.root ? S.idle() : S.working()));
    const report = spec.report
      ? ({
          reportId: `rep_${spec.id}`,
          runId: `r_${spec.id}`,
          linkId: `l_${spec.id}`,
          status: spec.report.status,
          summary: spec.report.summary ?? '',
          path: null,
          createdAt: spec.report.at,
        } as DelegationNodeDetails['latestReportForRun'])
      : null;
    details[key] = {
      status,
      statusSource: status ? 'committed' : 'unavailable',
      latestReportForRun: report,
      reportHistory: report ? [report] : [],
      ...(spec.observationUnavailable ? { observationUnavailableReason: spec.observationUnavailable } : {}),
      parentOffline: null,
      wake: null,
      reconcile: spec.reconcile ? reconcileDescriptor('/synthetic/hud-home', `l_${spec.id}`, `r_${spec.id}`) : null,
      resumable: { resumable: false, reason: 'capability_unverified', subject: 'local_user' },
    } as DelegationNodeDetails;

    // A native child has a relation only when the test gives it a label (the real tree may name it by its short ref).
    if (spec.parent !== undefined && spec.parent !== null && !spec.root && (!spec.native || spec.label)) {
      const claimants = [spec.parent, ...(spec.alsoClaimedBy ?? [])];
      claimants.forEach((claimant, i) => {
        const conflict = spec.alsoClaimedBy !== undefined || spec.relationOnly;
        relations.push({
          link: {
            linkId: `l_${spec.id}${i ? `_${i}` : ''}`,
            state: spec.linkState ?? 'bound',
            label: spec.label === undefined ? spec.id : spec.label,
            role: spec.role ?? 'worker',
            backend: harness === 'pi' ? 'pi-reviewer' : harness === 'claude' ? 'claude' : 'codex-sol',
            createdAt,
            boundAt: spec.boundAt === undefined ? createdAt : spec.boundAt,
            parentRef: null,
            // A link names its child session once it is bound; an intent has none yet.
            childRef:
              spec.kind === 'intent' || spec.kind === 'job'
                ? null
                : { harness, sourceId: SOURCE_ID, sessionId: `${spec.id}-0001`, threadId: null },
          },
          currentRun: ledgerRun,
          parentKey: keys[claimant] ?? null,
          childKey: key,
          attribution: conflict ? 'conflict' : spec.kind === 'intent' ? 'intent' : 'confirmed',
          verification: 'not_observed',
          conflict: conflict ? { count: claimants.length, recordIds: [], since: spec.conflict?.since ?? NOW } : null,
          parentOffline: null,
          host: { locator: null, state: 'valid', occupantMatches: null, checkedAt: null, currentState: null },
        } as unknown as LinkRelationProjection);
      });
    }
  }

  const tree = {
    ledger: { state: 'ok', ledgerId: 'ledger-synthetic', asOfSeq: 1, reason: null },
    nodes,
    relations,
    candidates: [],
    selectionMap: options.selectionMap ?? {},
    continuation,
    truncation: { candidates: 0, conflictRecords: 0, continuation: 0 },
    counts: {
      confirmedSessions: nodes.length,
      delegationIntents: 0,
      jobs: 0,
      knownUnloaded: 0,
      omitted: 0,
      unknownDescendants: false,
    },
    io: { bytesRead: 0, recordsRead: 0, remainingBytes: 0, exceeded: false },
    coverage: { state: 'complete', skipped: {}, gaps: [], loaded: true },
  } as unknown as LinkTreeProjection;

  const cap = options.capacity;
  const capacity = cap
    ? ({
        active: cap.active,
        limit: cap.limit,
        mine: cap.mine,
        mineLimit: cap.mineLimit,
        full: cap.active >= cap.limit || cap.mine >= cap.mineLimit,
        occupants: Array.from({ length: cap.uncertain ?? 0 }, (_, i) => ({
          runId: `r_u${i}`,
          linkId: `l_u${i}`,
          state: 'uncertain',
          since: ago(600),
          holder: 'self',
          retireEta: null,
        })),
      } as unknown as DelegationViewModel['capacity'])
    : null;

  return {
    keys,
    vm: {
      tree,
      capacity,
      limits: { source: 'default', limits: {} } as unknown as DelegationViewModel['limits'],
      details,
      pendingStatus: 0,
    },
  };
}

/**
 * The cross-harness tree of the design's situation (c): a Claude Code `main`
 * with a Codex implementer (visible, two native children), a pi reviewer
 * waiting for approval (headless), a ChatGPT job, and a reported Codex writer.
 */
export function situationC(options: { reviewPass?: boolean; nativeMeta?: boolean } = {}): Built {
  return buildVm(
    [
      {
        id: 'main',
        root: true,
        harness: 'claude',
        model: 'fable-5.1',
        effort: 'high',
        contextPercent: 41,
        status: S.working(ago(190)),
        label: null,
      },
      {
        id: 'impl-parser',
        parent: 'main',
        harness: 'codex',
        run: { state: 'running', mode: 'visible' },
        status: S.working(ago(724)),
        model: 'gpt-6.1-sol',
        effort: 'xhigh',
        contextPercent: 56,
        pane: 'pane 4',
        costUsd: null,
        createdAt: ago(720),
      },
      {
        id: 'scout',
        parent: 'impl-parser',
        native: true,
        harness: 'codex',
        label: options.nativeMeta ? null : 'scout 中文 boundaries',
        ...(options.nativeMeta ? { nativeMeta: { title: 'scout 中文 boundaries', kind: 'research' as const } } : {}),
        status: S.working(ago(60)),
        model: 'gpt-6.1-sol',
        createdAt: ago(300),
      },
      ...(options.reviewPass
        ? [
            {
              id: 'review-pass',
              parent: 'impl-parser',
              native: true,
              harness: 'codex' as const,
              label: options.nativeMeta ? null : 'review-pass',
              ...(options.nativeMeta ? { nativeMeta: { title: 'review-pass', kind: 'review' as const } } : {}),
              status: S.idle(ago(100)),
              model: 'gpt-6.1-sol',
              createdAt: ago(400),
            },
          ]
        : []),
      {
        id: 'review-tests',
        parent: 'main',
        harness: 'pi',
        run: { state: 'running', mode: 'headless' },
        status: S.pending('approval', ago(10)),
        model: 'gpt-6.1-sol',
        effort: 'high',
        contextPercent: 24,
        costUsd: 0.12,
        createdAt: ago(400),
      },
      {
        id: 'ask-pro',
        parent: 'main',
        kind: 'job',
        label: 'ask-pro',
        run: false,
        status: S.working(ago(240)),
        createdAt: ago(240),
      },
      {
        id: 'docs-sync',
        parent: 'main',
        harness: 'codex',
        run: { state: 'ended', mode: 'headless', endedAt: ago(120) },
        status: S.exited(ago(120)),
        report: { status: 'completed', summary: 'Synced two reference sections.', at: ago(120) },
        model: 'gpt-6.1-sol',
        effort: 'high',
        contextPercent: 31,
        createdAt: ago(1500),
      },
    ],
    {}
  );
}

/** Situation (d): six slots held, nine finished; the main session holds its four. */
export function situationD(): Built {
  const done = (id: string, endedAgo: number): NodeSpec => ({
    id,
    parent: 'main',
    harness: 'codex',
    run: { state: 'ended', mode: 'headless', endedAt: ago(endedAgo) },
    status: S.exited(ago(endedAgo)),
    report: { status: 'completed', summary: `Finished ${id}.`, at: ago(endedAgo) },
    createdAt: ago(endedAgo + 600),
  });
  return buildVm(
    [
      {
        id: 'main',
        root: true,
        harness: 'claude',
        model: 'fable-5.1',
        effort: 'high',
        contextPercent: 41,
        status: S.working(ago(482)),
        label: null,
      },
      {
        id: 't-07',
        parent: 'main',
        harness: 'pi',
        status: S.pending('approval', ago(10)),
        createdAt: ago(900),
      },
      {
        id: 't-11',
        parent: 'main',
        harness: 'codex',
        run: { state: 'uncertain', mode: 'headless', reconciliation: 'scope_unknown', heartbeatAt: ago(840) },
        status: { cls: 'uncertain', reason: 'scope_unknown', since: ago(840), evidenceAt: ago(840) },
        createdAt: ago(1500),
      },
      {
        id: 't-01',
        parent: 'main',
        harness: 'codex',
        status: S.working(ago(542)),
        model: 'gpt-6.1-sol',
        effort: 'xhigh',
        contextPercent: 56,
        createdAt: ago(560),
      },
      {
        id: 't-12',
        parent: 't-01',
        harness: 'codex',
        status: S.working(ago(171)),
        model: 'gpt-6.1-sol',
        effort: 'xhigh',
        contextPercent: 24,
        createdAt: ago(180),
      },
      {
        id: 't-13',
        parent: 't-01',
        harness: 'pi',
        run: { state: 'starting', createdAt: ago(12) },
        status: S.starting(ago(12)),
        createdAt: ago(12),
      },
      {
        id: 't-09',
        parent: 'main',
        harness: 'pi',
        status: S.working(ago(195)),
        model: 'gpt-6.1-sol',
        effort: 'high',
        contextPercent: 25,
        createdAt: ago(210),
      },
      ...['t-02', 't-03', 't-04', 't-05', 't-06', 't-14', 't-15', 't-16', 't-17'].map((id, i) =>
        done(id, 1500 - i * 60)
      ),
    ],
    { capacity: { active: 6, limit: 6, mine: 4, mineLimit: 4, uncertain: 1 } }
  );
}

/** Situation (e): the root has exited; five workers in five kinds of trouble. */
export function situationE(): Built {
  return buildVm([
    {
      id: 'main',
      root: true,
      harness: 'claude',
      model: 'fable-5.1',
      effort: 'high',
      contextPercent: 41,
      status: S.exited(ago(180)),
      label: null,
    },
    {
      id: 'impl-a',
      parent: 'main',
      harness: 'codex',
      status: S.working(ago(130)),
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
      contextPercent: 40,
      createdAt: ago(1300),
    },
    { id: 'rev-a', parent: 'impl-a', harness: 'pi', status: S.stale(ago(48), ago(48)), createdAt: ago(800) },
    {
      id: 'impl-c',
      parent: 'main',
      alsoClaimedBy: ['claude-other'],
      relationOnly: true,
      harness: 'codex',
      conflict: { count: 2, since: ago(360) },
      createdAt: ago(1000),
    },
    {
      id: 'impl-d',
      parent: 'main',
      harness: 'codex',
      run: { state: 'uncertain', mode: 'visible', reconciliation: 'supervisor_dead', heartbeatAt: ago(425) },
      status: { cls: 'uncertain', reason: 'supervisor_dead', since: ago(420), evidenceAt: ago(425) },
      createdAt: ago(1200),
      reconcile: true,
    },
    {
      id: 'ask-pro',
      parent: 'main',
      kind: 'job',
      label: 'ask-pro',
      run: false,
      status: S.pending('needs_human', ago(540)),
      createdAt: ago(1100),
    },
    {
      id: 'impl-b',
      parent: 'main',
      harness: 'codex',
      run: { state: 'uncertain', mode: 'headless', reconciliation: 'scope_unknown', heartbeatAt: ago(840) },
      status: { cls: 'uncertain', reason: 'scope_unknown', since: ago(840), evidenceAt: ago(840) },
      createdAt: ago(1400),
      reconcile: true,
    },
  ]);
}

/** Situation (g): history of every ending the design lists, newest first. */
export function situationG(): Built {
  const ended = (id: string, endedAgo: number, extra: Partial<NodeSpec> = {}, run: RunSpec = {}): NodeSpec => ({
    id,
    parent: 'main',
    harness: 'codex',
    run: { state: 'ended', mode: 'headless', endedAt: ago(endedAgo), ...run },
    status: S.exited(ago(endedAgo)),
    createdAt: ago(endedAgo + 3000),
    ...extra,
  });
  return buildVm([
    {
      id: 'main',
      root: true,
      harness: 'claude',
      model: 'fable-5.1',
      effort: 'high',
      contextPercent: 41,
      status: S.working(ago(80)),
      label: null,
    },
    {
      id: 'impl-parser',
      parent: 'main',
      harness: 'codex',
      status: S.working(ago(724)),
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
      contextPercent: 56,
      createdAt: ago(730),
    },
    ended('docs-sync', 840, {
      report: { status: 'completed', summary: 'Synced two reference sections.', at: ago(840) },
    }),
    ended('lint-fix', 1860, {
      harness: 'pi',
      report: { status: 'failed', summary: 'Lint rule 12 unresolved after three passes.', at: ago(1860) },
    }),
    {
      id: 'bench',
      parent: 'main',
      harness: 'codex',
      run: { state: 'cancelled', mode: 'headless', endedAt: ago(3600), cancelRequestedAt: ago(3610) },
      status: S.exited(ago(3600)),
      createdAt: ago(7000),
    },
    ended('soak', 7200, {}, { requestedCause: 'runtime_limit' }),
    ended('t-07', 10800, { report: { status: 'completed', summary: '', at: ago(10800) } }),
    {
      id: 't-old',
      parent: 'main',
      harness: 'codex',
      loaded: false,
      run: { state: 'ended', mode: 'headless', endedAt: ago(2 * 86_400) },
      createdAt: ago(3 * 86_400),
    },
  ]);
}

/** Situation (h): a visible cancel waits on its pane; a visible writer reported and holds its pane. */
export function situationH(): Built {
  return buildVm(
    [
      {
        id: 'main',
        root: true,
        harness: 'claude',
        model: 'fable-5.1',
        effort: 'high',
        contextPercent: 41,
        status: S.working(ago(552)),
        label: null,
      },
      {
        id: 'impl-parser',
        parent: 'main',
        harness: 'codex',
        run: { state: 'cancelling', mode: 'visible', cancelRequestedAt: ago(120) },
        status: { cls: 'interrupted', reason: 'cancelling', since: ago(120), outcome: 'none' },
        model: 'gpt-6.1-sol',
        effort: 'xhigh',
        pane: 'pane 4',
        createdAt: ago(900),
      },
      {
        id: 'review-tests',
        parent: 'main',
        harness: 'pi',
        status: S.working(ago(300)),
        model: 'gpt-6.1-sol',
        effort: 'high',
        contextPercent: 24,
        createdAt: ago(600),
      },
      {
        id: 'ask-pro',
        parent: 'main',
        kind: 'job',
        label: 'ask-pro',
        run: false,
        status: S.working(ago(240)),
        createdAt: ago(240),
      },
      {
        id: 'docs-sync',
        parent: 'main',
        harness: 'codex',
        run: { state: 'running', mode: 'visible' },
        status: S.exited(ago(480)),
        report: { status: 'completed', summary: 'Synced two reference sections.', at: ago(480) },
        pane: 'pane 5',
        createdAt: ago(1500),
      },
    ],
    { capacity: { active: 3, limit: 6, mine: 3, mineLimit: 4 } }
  );
}

// ---------------------------------------------------------------------------
// B10B-s2 situations (additive): the panel's (a), (b) and the delegatee's parent row.

/** Situation (a): one Claude Code session at work, nothing under it. */
export function situationA(): Built {
  return buildVm([
    {
      id: 'main',
      root: true,
      harness: 'claude',
      model: 'fable-5.1',
      effort: 'high',
      contextPercent: 41,
      status: S.working(ago(190)),
      label: null,
    },
  ]);
}

/**
 * Situation (b): a Codex session with native children only: an implementer at work with two subtasks under it
 * (one failed, one running) and a scout that finished. Titles and kinds come from `native` (§7 #33).
 */
export function situationB(): Built {
  return buildVm([
    {
      id: 'main',
      root: true,
      harness: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'high',
      contextPercent: 33,
      status: S.working(ago(250)),
      label: null,
    },
    {
      id: 'impl',
      parent: 'main',
      native: true,
      harness: 'codex',
      label: null,
      nativeMeta: { title: 'implementer', kind: 'fix' },
      status: S.working(ago(200)),
      model: 'gpt-6.1-sol',
      contextPercent: 52,
      createdAt: ago(240),
    },
    {
      id: 'running-sub',
      parent: 'impl',
      native: true,
      harness: 'codex',
      label: null,
      nativeMeta: { title: 'running_子', kind: 'research' },
      status: S.working(ago(70)),
      model: 'gpt-6.1-sol',
      createdAt: ago(150),
    },
    {
      id: 'failed-sub',
      parent: 'impl',
      native: true,
      harness: 'codex',
      label: null,
      nativeMeta: { title: 'failed_子', kind: 'experiment' },
      status: S.failed(ago(40)),
      model: 'gpt-6.1-sol',
      createdAt: ago(160),
    },
    {
      id: 'scout',
      parent: 'main',
      native: true,
      harness: 'codex',
      label: null,
      nativeMeta: { title: 'scout', kind: 'research' },
      status: S.idle(ago(90)),
      model: 'gpt-6.1-sol',
      createdAt: ago(230),
    },
  ]);
}

/**
 * The delegatee's view (§4.6): the HUD sits in a Codex worker's pane; its root is someone's child. `form` picks the
 * parent row's form: a confirmed parent, an offline one, an unconfirmed caller, or a visible cancel asked of it.
 */
export function situationParent(form: 'confirmed' | 'offline' | 'unconfirmed' | 'cancel' = 'confirmed'): Built {
  const built = buildVm([
    {
      id: 'impl-parser',
      root: true,
      harness: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
      contextPercent: 56,
      status: S.working(ago(300)),
      label: null,
    },
    {
      id: 'scout',
      parent: 'impl-parser',
      native: true,
      harness: 'codex',
      label: null,
      nativeMeta: { title: 'scout boundaries', kind: 'research' },
      status: S.working(ago(60)),
      createdAt: ago(100),
    },
  ]);
  const rootKey = built.keys['impl-parser'];
  const parentRef = { harness: 'claude', sourceId: 'cd'.repeat(32), sessionId: 'a7f3c2d1-0001', threadId: null };
  const relation = {
    link: {
      linkId: 'l_root',
      state: 'bound',
      label: 'impl-parser',
      role: 'implementer',
      backend: 'codex-sol',
      createdAt: ago(800),
      boundAt: ago(720),
      parentCaller: 'c0ffee12-3456-4789-abcd-ef0123456789',
      parentRef: form === 'unconfirmed' ? null : parentRef,
      childRef: null,
    },
    currentRun:
      form === 'cancel'
        ? { runId: 'r_root', state: 'cancelling', mode: 'visible', cancelRequestedAt: ago(120) }
        : { runId: 'r_root', state: 'running', mode: 'visible', cancelRequestedAt: null },
    parentKey: null,
    childKey: rootKey,
    attribution: form === 'unconfirmed' ? 'intent' : 'confirmed',
    verification: 'not_observed',
    conflict: null,
    parentOffline: form === 'offline' ? { since: ago(180), seq: 9, orphanPolicy: 'continue' } : null,
    host: { locator: null, state: 'valid', occupantMatches: null, checkedAt: null, currentState: null },
  } as unknown as LinkRelationProjection;
  built.vm.tree.relations.push(relation);
  if (form !== 'unconfirmed') {
    const root = built.vm.tree.nodes.find((n) => n.key === rootKey)!;
    (root as { parent: LinkTreeNode['parent'] }).parent = {
      identity: { kind: 'session', ref: parentRef as never },
      harness: 'claude',
      name: 'main',
      liveness: 'alive',
      paneLabel: 'pane 2',
    };
  }
  return built;
}
