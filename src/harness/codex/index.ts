import type { TurnContextPayload, EventMsgPayload } from '../../types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  HarnessAdapter,
  BindContext,
  ReaderBudget,
  ReaderResult,
  SessionReader,
} from '../../core/interfaces/harness-adapter.js';
import type { SessionBinding, SurfaceLocator } from '../../core/interfaces/session-binding.js';
import type { SessionEvidence, CodexExtras } from '../../core/interfaces/session-evidence.js';
import type { LaunchProfile } from '../../core/types/capabilities.js';
import type { SessionRef, SourceId } from '../../core/types/identity.js';
import type { Coverage, Metric, ObservationView, ReaderCheckpoint } from '../../core/types/observation.js';
import { makeSourceId, sameSessionRef, sessionRefKey, validateSessionRef } from '../../core/identity.js';
import { initialParserState, makeMetric, projectFreshness } from '../../core/observation.js';
import { RecoveryIndexOverlay, attachRecoveryIndex } from '../../core/checkpoint.js';
import { RecoveryMap } from './recovery-index.js';
import { validateRolloutRecovery } from './recovery.js';
import {
  SessionFinder,
  findRolloutPathBySessionIdInRoot,
  findRolloutsInDays,
  getCodexHome,
  type SessionFile,
} from '../../collectors/session-finder.js';
import { RolloutParser, type RolloutParseResult, type RolloutParserCheckpoint } from '../../collectors/rollout.js';
import { buildSubagentTreeYielding } from '../../collectors/subagent-tree.js';
import { buildContextUsage } from '../../collectors/context-usage.js';
import { codexGoal } from '../../collectors/codex-goal.js';
import { observeLinkEvidence, validLinkScanState, type LinkScanState } from './link-evidence.js';
import { MeteredCodexTopology } from '../../core/link/native-topology.js';

export const CODEX_READER_VERSION = 'codex-facade-4';
export const CODEX_RECOVERY_VERSION = 'codex-recovery-3';
export const DEFAULT_READER_BUDGET: Readonly<ReaderBudget> = {
  maxBytes: 4 * 1024 * 1024,
  maxRecords: 2000,
  budgetMs: 20,
};

/** Structured recovery plus an exact source-local index; never a native object graph. */
export interface CodexCheckpoint extends ReaderCheckpoint {
  codex: { rollout: RolloutParserCheckpoint; links: LinkScanState; clocks: MetricClocks; pendingHudCount: number };
}
interface MetricClocks {
  modelAt?: number;
  effortAt?: number;
  contextAt?: number;
  usageKey?: string;
  usageAt?: number;
}

interface SourceConfig {
  root: string;
  serverNames: string[];
}
const finiteTime = (date: Date | undefined | null): number | null =>
  date && Number.isFinite(date.getTime()) ? date.getTime() : null;
const stampKey = (stamp: NonNullable<SessionBinding['harness']>) =>
  JSON.stringify([stamp.pid, stamp.proc_start, stamp.boot_id, stamp.pid_domain]);
const sameLocator = (a: SurfaceLocator | null, b: SurfaceLocator | null) =>
  a !== null &&
  b !== null &&
  a.kind === b.kind &&
  a.server === b.server &&
  a.pane === b.pane &&
  (a.kind === 'tmux'
    ? b.kind === 'tmux' && a.session === b.session
    : b.kind === 'herdr' && a.workspace === b.workspace && a.tab === b.tab) &&
  a.occupantGeneration !== null &&
  a.occupantGeneration === b.occupantGeneration &&
  a.process !== null &&
  b.process !== null &&
  stampKey(a.process) === stampKey(b.process);

function header(file: string): { id: string; cwd?: string; timestamp?: string } | null {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, size).indexOf(10);
    if (newline < 0 && size === buffer.length) return null;
    const entry = JSON.parse(buffer.subarray(0, newline < 0 ? size : newline).toString('utf8'));
    return entry.type === 'session_meta' && typeof entry.payload?.id === 'string' ? entry.payload : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Source-scoped facade. Legacy bar/panel paths retain their permissive newest-cwd binding behavior. */
export class CodexAdapter implements HarnessAdapter {
  readonly id = 'codex' as const;
  readonly glyph = '◆';
  readonly capabilities = {};
  private sources = new Map<SourceId, SourceConfig>();
  private native = new Map<string, SessionRef[]>();
  private topologies = new Map<SourceId, MeteredCodexTopology>();
  /** Per-reader ceiling. Production keeps DEFAULT_READER_BUDGET; tests inject a larger slice. */
  private readonly readerBudget: Readonly<ReaderBudget>;

  constructor(
    readerBudget: Readonly<ReaderBudget> = DEFAULT_READER_BUDGET,
    private readonly metered = false
  ) {
    this.readerBudget = { ...readerBudget };
  }

  async resolveSource(profile: LaunchProfile, env: Readonly<Record<string, string | undefined>>): Promise<SourceId> {
    if (profile.harness !== 'codex' || !path.isAbsolute(profile.source.root)) throw new Error('invalid_codex_source');
    const root = await fs.promises.realpath(profile.source.root);
    if (!(await fs.promises.stat(root)).isDirectory()) throw new Error('invalid_codex_source');
    const effectiveHome = profile.env.CODEX_HOME ?? env.CODEX_HOME;
    if (effectiveHome && (await fs.promises.realpath(effectiveHome)) !== root) throw new Error('codex_source_mismatch');
    const sourceId = makeSourceId('codex', root);
    const serverNames = [...new Set([...(this.sources.get(sourceId)?.serverNames ?? []), profile.mcpServerName])];
    this.sources.set(sourceId, { root, serverNames });
    if (this.metered && !this.topologies.has(sourceId)) this.topologies.set(sourceId, new MeteredCodexTopology(root));
    return sourceId;
  }

  private source(ref: SessionRef): SourceConfig {
    validateSessionRef(ref);
    const source = this.sources.get(ref.sourceId);
    if (ref.harness !== 'codex' || ref.threadId !== null || !source) throw new Error('unknown_codex_source');
    return source;
  }

  private rollout(ref: SessionRef): string {
    const { root } = this.source(ref);
    if (this.metered) {
      const file = this.topologies.get(ref.sourceId)?.file(ref);
      if (!file) throw new Error('codex_rollout_discovery_pending');
      const real = fs.realpathSync(file);
      if (real !== file || !real.startsWith(`${root}${path.sep}`)) throw new Error('codex_rollout_outside_source');
      return real;
    }
    const file =
      findRolloutPathBySessionIdInRoot(path.join(root, 'sessions'), ref.sessionId) ??
      findRolloutPathBySessionIdInRoot(path.join(root, 'archived_sessions'), ref.sessionId);
    if (!file) throw new Error('codex_rollout_unavailable');
    const real = fs.realpathSync(file);
    if (!real.startsWith(`${root}${path.sep}`)) throw new Error('codex_rollout_outside_source');
    return real;
  }

  async bind(context: BindContext): Promise<SessionBinding | null> {
    const source = this.sources.get(context.sourceId);
    if (!source) return null;
    const basic = (ref: SessionRef): SessionBinding | null => {
      try {
        this.source(ref);
      } catch {
        return null;
      }
      return ref.sourceId === context.sourceId
        ? { sessionRef: ref, harness: null, occupantGeneration: null, managed: null }
        : null;
    };
    if (context.explicitSession) return basic(context.explicitSession);
    const records = context.registry.filter(
      (record) =>
        record.evidence.validity === 'current' &&
        record.evidence.ref.sourceId === context.sourceId &&
        record.evidence.ref.harness === 'codex' &&
        record.evidence.value.occupant !== null &&
        sameSessionRef(record.evidence.ref, record.evidence.value.occupant) &&
        (context.locator === null || sameLocator(record.locator, context.locator))
    );
    const refs = new Map(records.map((record) => [sessionRefKey(record.evidence.ref), record.evidence.ref]));
    if (refs.size > 1) return null;
    if (refs.size === 1) {
      const ref = [...refs.values()][0];
      // Native observations never manufacture a managed association from a registry cache.
      const result = basic(ref);
      if (
        result &&
        context.locator?.process &&
        context.processes.some((p) => stampKey(p) === stampKey(context.locator!.process!))
      ) {
        result.harness = context.locator.process;
        result.occupantGeneration = context.locator.occupantGeneration;
      }
      return result;
    }
    if (!context.cwd) return null;
    // SessionFinder is ambient; use its pane/daemon path only for this exact source and pane.
    let found: SessionFile | null = null;
    if (
      context.locator?.kind === 'tmux' &&
      context.locator.pane === process.env.CODEX_HUD_MAIN_PANE &&
      context.locator.server === process.env.TMUX &&
      process.env.CODEX_HOME &&
      fs.realpathSync(getCodexHome()) === source.root &&
      !process.env.CODEX_SESSIONS_PATH
    ) {
      found = new SessionFinder(context.cwd, undefined, new Date(context.startedAt)).check();
    }
    const candidates = new SessionFinder(context.cwd, undefined, new Date(context.startedAt)).candidates(
      path.join(source.root, 'sessions')
    );
    // A latest-file choice alone cannot resolve ambiguity, even when the legacy finder chose it.
    if (candidates.length !== 1 || (found && found.sessionId !== candidates[0].sessionId)) return null;
    return basic({ harness: 'codex', sourceId: context.sourceId, sessionId: candidates[0].sessionId, threadId: null });
  }

  open(target: SessionRef, checkpoint?: ReaderCheckpoint): SessionReader {
    const ref = structuredClone(target);
    this.source(ref);
    const parser = new RolloutParser();
    let index = new RecoveryIndexOverlay(CODEX_RECOVERY_VERSION, checkpoint?.recoveryIndex);
    const { recoveryIndex: _handoff, ...inlineCheckpoint } = checkpoint ?? {};
    let current = checkpoint ? (structuredClone(inlineCheckpoint) as CodexCheckpoint) : undefined;
    if (
      current &&
      (current.schemaVersion !== 1 ||
        current.readerVersion !== CODEX_READER_VERSION ||
        !sameSessionRef(current.ref, ref) ||
        !current.codex ||
        !validLinkScanState(current.codex.links) ||
        current.codex.links.pendingHudCalls !== undefined ||
        !Number.isSafeInteger(current.codex.pendingHudCount) ||
        current.codex.pendingHudCount < 0 ||
        current.offset !== current.codex.rollout.offset ||
        current.codex.rollout.fileIdentity !== `${current.fileId.dev}:${current.fileId.inode}` ||
        !Number.isSafeInteger(current.sourceGeneration) ||
        current.sourceGeneration < 1 ||
        current.parserState.pendingBytes.length !== 0 ||
        (current.parserState.discardingOversize &&
          (!Number.isSafeInteger(current.parserState.discardOffset) ||
            current.parserState.discardOffset! < current.offset)))
    ) {
      throw new Error('unsupported_codex_checkpoint');
    }
    if (current) {
      validateRolloutRecovery(current.codex.rollout);
      if (!checkpoint?.recoveryIndex) throw new Error('missing_codex_recovery_index');
    }
    let pendingHud = new RecoveryMap<string>(
      index,
      'codex.hud-pending',
      current?.codex.pendingHudCount ?? 0,
      JSON.stringify,
      (raw) => JSON.parse(raw) as string
    );
    let pendingReset =
      current?.resetReason &&
      checkpoint?.recoveryIndex?.delta.base?.boundary.sourceGeneration !== current.sourceGeneration
        ? { sourceGeneration: current.sourceGeneration, reason: current.resetReason }
        : undefined;
    const cap = this.readerBudget;
    let initialized = false;
    let queue: Promise<unknown> = Promise.resolve();
    const read = async (requested: ReaderBudget = cap): Promise<ReaderResult> => {
      const started = performance.now();
      const budget = { ...requested };
      if (Object.values(budget).some((n) => !Number.isSafeInteger(n) || n < 0))
        throw new Error('invalid_reader_budget');
      budget.maxBytes = Math.min(budget.maxBytes, cap.maxBytes);
      budget.maxRecords = Math.min(budget.maxRecords, cap.maxRecords);
      budget.budgetMs = Math.min(budget.budgetMs, cap.budgetMs);
      if (!initialized) {
        parser.setRolloutPath(this.rollout(ref));
        parser.configureRecoveryIndex(index);
        if (current) parser.restoreCheckpoint(current.codex.rollout);
        initialized = true;
      }
      let sliceIndex = index.fork();
      const nextPendingHud = pendingHud.fork(sliceIndex);
      let parsedPendingHud = nextPendingHud;
      let latestOpenCall: ReturnType<RolloutParser['getLatestOpenCall']>;
      let links = structuredClone(current?.codex.links ?? {});
      let clocks: MetricClocks = structuredClone(current?.codex.clocks ?? {});
      const result = await parser.parse({
        budget,
        state: current?.parserState ?? initialParserState(),
        recoveryIndex: sliceIndex,
        onParsed: () => {
          parsedPendingHud = nextPendingHud.commit();
          latestOpenCall = parser.getLatestOpenCall();
        },
        onReset: () => {
          links = {};
          clocks = {};
          sliceIndex = new RecoveryIndexOverlay(CODEX_RECOVERY_VERSION);
          nextPendingHud.resetIndex(sliceIndex);
          return sliceIndex;
        },
        onRecord: (entry) => {
          observeLinkEvidence(entry, links, this.source(ref).serverNames, nextPendingHud);
          const eventAt = Date.parse(entry.timestamp);
          if (!Number.isFinite(eventAt)) return;
          if (entry.type === 'turn_context') {
            const p = entry.payload as TurnContextPayload;
            if (p.model || p.collaboration_mode?.settings?.model) clocks.modelAt = eventAt;
            if (p.effort || p.reasoning_effort || p.collaboration_mode?.settings?.reasoning_effort)
              clocks.effortAt = eventAt;
          }
          const p = entry.payload as EventMsgPayload;
          if (entry.type === 'event_msg' && p.type === 'token_count') {
            if (p.info?.last_token_usage || p.info?.model_context_window) clocks.contextAt = eventAt;
            const usage = p.info?.total_token_usage;
            if (usage) {
              const key = JSON.stringify([
                usage.input_tokens,
                usage.output_tokens,
                usage.cached_input_tokens,
                usage.reasoning_output_tokens,
              ]);
              if (key !== clocks.usageKey) {
                clocks.usageKey = key;
                clocks.usageAt = eventAt;
              }
            }
          }
          if (
            entry.type === 'event_msg' &&
            (p.type === 'task_started' || p.type === 'turn_started') &&
            p.model_context_window
          )
            clocks.contextAt = eventAt;
        },
      });
      if (!result || (result.session && result.session.id !== ref.sessionId)) throw new Error('codex_session_mismatch');
      const stats = parser.getReadStats()!;
      const state = stats.state;
      // Exact waits live once in codex.running; this generic compatibility array stays bounded.
      state.openToolWaits = [];
      state.rateBaseline = parser.getRateBaseline();
      const compaction = finiteTime(result.lastCompactTime);
      const newCompaction = compaction !== null && state.compactBoundary !== String(compaction);
      state.compactBoundary = compaction === null ? null : String(compaction);
      const saved = parser.exportCheckpoint();
      const [dev, inode] = saved.fileIdentity!.split(':').map(Number);
      const previousGeneration = current?.sourceGeneration ?? 1;
      const sourceGeneration = previousGeneration + (stats.resetReason || newCompaction ? 1 : 0);
      if (stats.resetReason || newCompaction)
        pendingReset = {
          sourceGeneration,
          // A later semantic compaction cannot erase the unpublished physical reset witness.
          reason:
            stats.resetReason ??
            (pendingReset?.reason !== 'compaction' ? pendingReset?.reason : undefined) ??
            'compaction',
        };
      current = {
        schemaVersion: 1,
        readerVersion: CODEX_READER_VERSION,
        ref,
        fileId: { dev, inode },
        offset: saved.offset,
        sourceGeneration,
        parserState: state,
        codex: { rollout: saved, links, clocks, pendingHudCount: parsedPendingHud.size },
        ...(pendingReset ? { resetReason: pendingReset.reason } : {}),
      };
      const coverage: Coverage = {
        state: stats.continuation
          ? 'partial'
          : stats.remainingBytes > 0
            ? 'catching_up'
            : state.gaps.length || state.tailAtEof || state.discardingOversize
              ? 'partial'
              : 'complete',
        skipped: { ...state.skipped },
        gaps: [...state.gaps],
        remainingBytes: stats.remainingBytes,
        loaded: true,
        ...(stats.continuation
          ? { reason: 'record_needs_larger_slice' }
          : state.tailAtEof
            ? { reason: 'incomplete_tail' }
            : {}),
      };
      const now = Date.now();
      const evidence = this.evidence(ref, result, coverage, now, links, clocks, latestOpenCall);
      const rate = result.outputRate;
      const sampledAt = rate?.sampledAt.getTime();
      const turnStartedAt = finiteTime(result.activity?.turnStartedAt);
      const outputRate =
        rate &&
        Number.isFinite(rate.tokensPerSecond) &&
        rate.tokensPerSecond >= 0 &&
        Number.isFinite(rate.sampleMs) &&
        rate.sampleMs > 0 &&
        sampledAt !== undefined &&
        Number.isFinite(sampledAt) &&
        sampledAt >= 0 &&
        sampledAt <= now &&
        (turnStartedAt === null || (turnStartedAt <= now && sampledAt >= turnStartedAt))
          ? {
              source: 'codex.turn_wallclock_proxy' as const,
              tokensPerSecond: rate.tokensPerSecond,
              sampleMs: rate.sampleMs,
              sampledAt,
            }
          : undefined;
      // Soft budget includes parsing and assembly; a JSON.parse/SQLite call cannot be preempted.
      stats.elapsedMs = performance.now() - started;
      index = sliceIndex.commit();
      parser.commitRecoveryIndex(index);
      pendingHud = parsedPendingHud;
      pendingHud.useIndex(index);
      const publishedReset = pendingReset;
      return {
        observation: evidence.observation,
        checkpoint: attachRecoveryIndex(structuredClone(current), index, () => {
          if (publishedReset && pendingReset === publishedReset) pendingReset = undefined;
        }),
        ...(outputRate ? { outputRate } : {}),
        evidence,
        ...(stats.continuation ? { continuation: stats.continuation } : {}),
        stats: { bytesRead: stats.bytesRead, recordsRead: stats.recordsRead, elapsedMs: stats.elapsedMs },
      };
    };
    return {
      read: (budget) => {
        const next = queue.then(() => read(budget));
        queue = next.catch(() => {});
        return next;
      },
    };
  }

  async children(ref: SessionRef): Promise<SessionRef[]> {
    const source = this.source(ref);
    const file = this.rollout(ref);
    const meta = header(file);
    if (meta?.id !== ref.sessionId) throw new Error('codex_session_mismatch');
    const created = meta.timestamp ? Date.parse(meta.timestamp) : Date.now();
    const days = Number.isFinite(created) ? Math.max(3, Math.ceil((Date.now() - created) / 86400000) + 1) : 30;
    const listed = findRolloutsInDays(days, path.join(source.root, 'sessions')).filter((file) => {
      try {
        return fs.realpathSync(file.path).startsWith(`${source.root}${path.sep}`);
      } catch {
        return false;
      }
    });
    const tree = await buildSubagentTreeYielding(ref.sessionId, [], days, Date.now(), listed);
    const refs = tree.nodes.map((node) => ({ ...ref, sessionId: node.id }));
    this.native.set(sessionRefKey(ref), refs);
    return structuredClone(refs);
  }

  collectionState(ref: SessionRef, checkChanges = true, deadline = performance.now() + 2) {
    this.source(ref);
    const topology = this.topologies.get(ref.sourceId);
    if (checkChanges) topology?.pollMetadata(deadline, 32, ref);
    const dirty = topology?.changed() ?? true;
    return { file: topology?.file(ref) ?? null, topologyToken: topology?.token() ?? 0, topologyDirty: dirty };
  }

  invalidateTopology(ref: SessionRef): void {
    this.topologies.get(ref.sourceId)?.invalidateSession(ref);
  }

  async collectTopology(ref: SessionRef, budget: ReaderBudget) {
    const source = this.source(ref);
    let topology = this.topologies.get(ref.sourceId);
    if (!topology) {
      topology = new MeteredCodexTopology(source.root);
      this.topologies.set(ref.sourceId, topology);
    }
    return topology.collect(ref, budget);
  }

  closeCollection(): void {
    for (const topology of this.topologies.values()) topology.close();
  }

  private evidence(
    ref: SessionRef,
    result: RolloutParseResult,
    coverage: Coverage,
    now: number,
    links: LinkScanState,
    clocks: MetricClocks,
    running: ReturnType<RolloutParser['getLatestOpenCall']>
  ): SessionEvidence {
    const at = finiteTime(result.lastEventTime);
    const metric = <T>(
      value: T | null,
      source: string,
      asOf = at ?? now,
      quality: 'reported' | 'estimated' = 'reported'
    ): Metric<T> =>
      makeMetric(value, { source, asOf: value === null ? now : asOf, quality: value === null ? 'unknown' : quality });
    const usageAfterCompaction =
      !result.lastCompactTime || (result.tokenUsageAt && result.tokenUsageAt >= result.lastCompactTime);
    const context = usageAfterCompaction
      ? buildContextUsage(result.tokenUsage ?? undefined, result.compactCount, result.lastCompactTime)
      : undefined;
    const usage = result.tokenUsage?.total_token_usage;
    const pending = result.pendingApproval;
    const activity = pending
      ? 'waiting_input'
      : result.activity?.state === 'working'
        ? 'working'
        : result.activity
          ? 'idle'
          : 'unknown';
    const outcome =
      result.activity?.state === 'error'
        ? 'failed'
        : result.activity?.state === 'interrupted'
          ? 'interrupted'
          : result.activity?.state === 'idle' && result.events.at(-1)?.kind === 'turn-finished'
            ? 'completed'
            : 'none';
    const observation: ObservationView = {
      nodeIdentity: { kind: 'session', ref },
      statusProjection: {
        activity,
        pendingReason: pending ? (pending.kind === 'input' ? 'question' : 'approval') : 'none',
        lastTurnOutcome: outcome,
        liveness: 'unknown',
        freshness: projectFreshness(
          [
            {
              id: 'codex-rollout',
              validity: 'current',
              lastEvidenceAt: at,
              observedAt: now,
              lastSuccessfulReadAt: now,
              deadlineAt: now + 5000,
            },
          ],
          ['codex-rollout'],
          now
        ),
        stateKey: 'unknown',
        stateSince: null,
        stateSinceBasis: 'unknown',
        isRunTerminal: null,
        asOfSeq: null,
        observationStamp: null,
        asOf: at,
        observedAt: now,
        lastEvidenceAt: at,
      },
      conflict: null,
      spent: {
        tokens: metric(
          usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number'
            ? {
                input: usage.input_tokens,
                output: usage.output_tokens,
                ...(typeof usage.cached_input_tokens === 'number' ? { cacheRead: usage.cached_input_tokens } : {}),
                ...(typeof usage.reasoning_output_tokens === 'number'
                  ? { reasoning: usage.reasoning_output_tokens }
                  : {}),
              }
            : null,
          'codex.total_token_usage',
          clocks.usageAt ?? at ?? now
        ),
        costUsd: metric<number>(null, 'codex.cost_unavailable'),
      },
      workspace: null,
      coverage,
      loaded: true,
      depth: 0,
      evidenceStamp: JSON.stringify([ref, at, result.toolActivity.totalCalls, result.compactCount]),
      ...(result.session?.model
        ? { model: metric(result.session.model, 'codex.turn_context', clocks.modelAt ?? at ?? now) }
        : {}),
      ...(result.session?.reasoningEffort
        ? { effort: metric(result.session.reasoningEffort, 'codex.turn_context', clocks.effortAt ?? at ?? now) }
        : {}),
      ...(context
        ? {
            context: metric(
              { used: context.used, window: context.total, percent: context.percent },
              'codex.token_count.baseline_adjusted',
              clocks.contextAt ?? at ?? now,
              'estimated'
            ),
          }
        : {}),
    };
    const plan = result.planProgress;
    const windows = result.rateLimits;
    const quota: CodexExtras['quota'] = windows ? {} : null;
    for (const name of ['primary', 'secondary'] as const) {
      const w = windows?.[name];
      if (quota && w && typeof w.used_percent === 'number') {
        const sample = result.quotaSamples.filter((s) => s.window === name).at(-1);
        quota[name] = {
          usedPercent: w.used_percent,
          ...(w.window_minutes !== undefined ? { windowMinutes: w.window_minutes } : {}),
          ...(sample?.resetsAt ? { resetsAt: sample.resetsAt.getTime() } : {}),
        };
      }
    }
    const goal = codexGoal(this.source(ref).root, ref.sessionId, now);
    return {
      ref,
      observation,
      cwd: result.session?.cwd ?? null,
      cwdSource: result.session?.cwd ? 'session_meta' : 'unknown',
      cwdAsOf: finiteTime(result.session?.startTime),
      startedAt: finiteTime(result.session?.startTime),
      version: result.session?.cliVersion ?? null,
      model: metric(
        result.session?.model
          ? {
              id: result.session.model,
              ...(result.session.modelProvider ? { provider: result.session.modelProvider } : {}),
              ...(result.session.reasoningEffort ? { effort: result.session.reasoningEffort } : {}),
            }
          : null,
        'codex.turn_context',
        Math.max(clocks.modelAt ?? 0, clocks.effortAt ?? 0, finiteTime(result.session?.startTime) ?? 0) || now
      ),
      context: metric(
        context ? { used: context.used, window: context.total, afterCompaction: result.compactCount > 0 } : null,
        'codex.token_count.baseline_adjusted',
        clocks.contextAt ?? at ?? now,
        'estimated'
      ),
      ...(running
        ? {
            action: {
              id: running.id,
              name: running.name,
              startedAt: running.timestamp.getTime(),
              ...(running.target ? { target: running.target } : {}),
            },
          }
        : {}),
      reports: result.transcript
        .filter((entry) => entry.role === 'assistant')
        .map((entry) => ({
          kind: entry.kind as 'message' | 'update' | 'reply',
          text: entry.text,
          at: entry.at.getTime(),
        })),
      ...(plan
        ? {
            progress: metric(
              {
                done: plan.completedSteps,
                total: plan.totalSteps,
                ...(plan.steps.find((step) => step.status === 'in_progress')
                  ? { current: plan.steps.find((step) => step.status === 'in_progress')!.step }
                  : {}),
              },
              'codex.plan_update',
              plan.lastUpdate.getTime()
            ),
          }
        : {}),
      native: structuredClone(this.native.get(sessionRefKey(ref)) ?? []),
      linkEvidence: (links.linkEvidence ?? []).map((entry) => ({ ...entry, ref })),
      caps: {
        codex: {
          quota,
          goals: goal ? [goal] : [],
          plan: plan
            ? {
                steps: plan.steps.map((step) => ({ step: step.step, status: step.status })),
                completed: plan.completedSteps,
                total: plan.totalSteps,
                asOf: plan.lastUpdate.getTime(),
              }
            : null,
          todos: plan?.todos?.map((todo) => ({ ...todo })) ?? [],
        },
      },
    };
  }
}
