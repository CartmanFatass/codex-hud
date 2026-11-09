// Owned web-oracle lifecycle. Ported from the owner's jev-ask send/wait/reconcile.
// Only prepare() and the single persisted click may act; every recovery path is read-only.
import { randomUUID } from 'node:crypto';
import type { BrowserAcquired, BrowserAcquisition, BrowserOwnership } from '../browser.js';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireBrowserLock, acquireWaitLease, type HeldLease } from '../ask/lease.js';
import { fsyncDirectory, operationStem } from '../ask/names.js';
import { JevFailure } from '../ask/error.js';
import {
  assertCanSend,
  assertProvider,
  mergeSave,
  persistClick,
  persistRelease,
  readOperation,
  type OperationRecord,
  sha256Hex,
} from '../ask/records.js';
import { awaitState, type JudgmentProvider, type PageObservation } from '../judge.js';
import type { DecisionProvider } from '../decide.js';
import { recoverableOracleResult, type JevAskInput } from './types.js';
import { browserTimeout, oracleRead } from './oracle-read.js';

export interface OracleTurn {
  role: string;
  text: string;
  message_body?: string | null;
  message_body_code_markdown?: string | null;
  attachment_names?: string[];
  final_controls?: boolean;
}
export interface OracleFacts {
  url: string;
  readyState: string;
  marker: string;
  composer: string | null;
  stop: boolean;
  send?: boolean;
  human?: string;
  error?: boolean;
  sidebar: string[];
  turns: OracleTurn[];
  cards: string[] | null;
  /** AI Studio can provide a pre-bound exchange and its own finality proof. */
  exchange?: { text: string; final: boolean; error?: string; users: number; userPromptSha256?: string };
  recordFields?: OperationRecord;
}
export interface OraclePage {
  readonly id: string | null;
  facts(): Promise<OracleFacts>;
  observation(facts: OracleFacts): Promise<PageObservation>;
  close(): Promise<void>;
  detach(): Promise<void>;
}
export interface OracleTarget {
  readonly provider: 'chatgpt' | 'aistudio';
  readonly root: string;
  settled(url: unknown): url is string;
  open(url: string, acquisition?: BrowserAcquisition): Promise<OraclePage>;
  attach(id: string, acquisition?: BrowserAcquisition): Promise<OraclePage>;
  targets(): Promise<Array<{ targetId: string; url: string }>>;
  bindPage?(page: OraclePage, record: OperationRecord, signal: AbortSignal): void;
  prepare(
    page: OraclePage,
    input: JevAskInput,
    provider: DecisionProvider,
    signal: AbortSignal,
    committed?: OperationRecord
  ): Promise<OracleFacts>;
  click(page: OraclePage, signal: AbortSignal): Promise<void>;
  binding(
    facts: OracleFacts,
    input: JevAskInput,
    record: OperationRecord
  ): { found: boolean; answer: string; final: boolean };
  matchesDraft(facts: OracleFacts, input: JevAskInput): boolean;
}

/** The AI Studio store implements this with its driver's aggregate file and flock. */
export interface OracleStore {
  read(): Promise<OperationRecord | null>;
  save(delta: OperationRecord, lease: HeldLease): Promise<OperationRecord>;
  click(delta: OperationRecord, lease: HeldLease): Promise<OperationRecord>;
  release(delta: OperationRecord, lease: HeldLease): Promise<OperationRecord>;
}
export function chatgptStore(stateDir: string, key: string): OracleStore {
  return {
    async read() {
      return readOperation(stateDir, key);
    },
    async save(delta, lease) {
      return mergeSave(stateDir, key, delta, lease);
    },
    async click(delta, lease) {
      return persistClick(stateDir, key, delta, lease);
    },
    async release(delta, lease) {
      return persistRelease(stateDir, key, delta, lease);
    },
  };
}
export type CollectTimingStep =
  'live_facts' | 'saved_open' | 'saved_facts' | 'saved_close' | 'persist' | 'live_cleanup';

export interface OracleContext {
  stateDir: string;
  key: string;
  jobId: string;
  input: JevAskInput;
  target: OracleTarget;
  store: OracleStore;
  provider: DecisionProvider;
  signal: AbortSignal;
  /** Recovery-only entry may never enter prepare/click, even when no record exists. */
  resumeOnly?: boolean;
  readTimeoutMs?: number;
  fields: OperationRecord;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  phase?: (phase: string) => void;
  diagnostic?: (code: string, error?: unknown) => void;
  /** Finite step names and elapsed time only; no page content. */
  timing?: (step: CollectTimingStep, elapsedMs: number) => void;
  /** Retain/drain acquisition cleanup independently of the job/answer. */
  retainCleanup?: (task: Promise<void>) => void;
  cleanup?: (
    step: 'open' | 'attach' | 'saved_close',
    elapsedMs: number,
    code: 'closed' | 'detached' | 'abandoned'
  ) => void;
}
export interface OracleResult {
  status: string;
  key: string;
  answer?: string;
  answer_file?: string;
  reason?: string;
  recoverable?: boolean;
  cross_check?: 'ok' | 'browser_timeout' | 'unavailable';
}

export function oracleDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
function aborted(ctx: OracleContext): void {
  ctx.signal.throwIfAborted();
}
function beforeOf(record: OperationRecord): Partial<OracleFacts> {
  return record.before && typeof record.before === 'object' ? (record.before as Partial<OracleFacts>) : {};
}
export function corroborators(facts: OracleFacts, before: Partial<OracleFacts>, target: OracleTarget): string[] {
  const evidence: string[] = [];
  if (target.settled(facts.url) && !target.settled(before.url)) evidence.push('url_moved');
  const count = facts.turns.filter((turn) => turn.role === 'user').length;
  const previous = before.turns?.filter((turn) => turn.role === 'user').length;
  if (previous !== undefined && count > previous) evidence.push('user_turn_added');
  if (facts.stop) evidence.push('stop_button');
  if (before.sidebar && facts.sidebar.filter((href) => !before.sidebar!.includes(href)).length === 1)
    evidence.push('sidebar_added');
  return evidence;
}
function result(ctx: OracleContext, status: string, extra: Partial<OracleResult> = {}): OracleResult {
  return { status, key: ctx.key, recoverable: recoverableOracleResult({ status }), ...extra };
}
function completed(ctx: OracleContext, record: OperationRecord | null): OracleResult | null {
  if (!record || (record.completion !== 'COMPLETE' && record.status !== 'done')) return null;
  const file =
    typeof record.answer_file === 'string' ? record.answer_file : typeof record.out === 'string' ? record.out : '';
  if (!file) return null;
  const answer = readFileSync(file, 'utf8').replace(/\n$/, '');
  if (typeof record.answer_sha256 === 'string' && sha256Hex(answer) !== record.answer_sha256)
    throw new Error('answer_integrity');
  return result(ctx, 'answered', { answer, answer_file: file });
}

/** Send under the browser lease; release it before the long read-only wait. */
export async function runOracle(ctx: OracleContext): Promise<OracleResult> {
  try {
    return await runOracleLifecycle(ctx);
  } catch (error) {
    if (browserTimeout(error)) {
      aborted(ctx);
      ctx.diagnostic?.('browser_timeout', error);
      const record = await ctx.store.read();
      if (record?.send_attempted === true || record?.attempted_at)
        return result(ctx, 'wait_failed', { reason: 'browser_timeout' });
    }
    throw error;
  }
}

async function runOracleLifecycle(ctx: OracleContext): Promise<OracleResult> {
  const now = ctx.now ?? Date.now;
  const sleep = ctx.sleep ?? ((ms: number) => oracleDelay(ms, ctx.signal));
  const lease = await acquireBrowserLock({
    stateDir: ctx.stateDir,
    jobId: ctx.jobId,
    phase: 'send/reconcile',
    holder: 'hud',
    waitMs: 600_000,
    deps: {
      sleep: async (ms) => {
        aborted(ctx);
        await sleep(ms);
        aborted(ctx);
      },
    },
  });
  let page: OraclePage | undefined;
  let record: OperationRecord = {};
  let attempted = false;
  let safeToClose = false;
  try {
    aborted(ctx);
    record = (await ctx.store.read()) ?? {};
    if (ctx.target.provider === 'chatgpt') assertProvider(record, 'chatgpt');
    if (record.hud_association && JSON.stringify(record.hud_association) !== JSON.stringify(ctx.fields.hud_association))
      throw new JevFailure('association_conflict', 'association_conflict');
    const cached = completed(ctx, record);
    if (cached) return cached;
    attempted = record.send_attempted === true || Boolean(record.attempted_at);
    for (const field of ['prompt_sha256', 'attachment', 'attachment_sha256'] as const) {
      if (!attempted && record[field] != null && record[field] !== ctx.fields[field])
        throw new Error('operation_binding_mismatch');
    }
    if (attempted && record.send_effect === 'sent') {
      // A confirmed send is already authoritative. Go directly to the wait lease;
      // a second waiter tails without opening another observer.
    } else {
      if (!attempted) {
        if (ctx.resumeOnly) return result(ctx, 'interrupted');
        assertCanSend(record, ctx.input.confirmResend === true);
        ctx.phase?.('prepare');
        page = await readPage(ctx, 'Target.createTarget', (onAcquire) =>
          ctx.target.open(
            ctx.input.conversation && ctx.input.conversation !== 'new' ? ctx.input.conversation : ctx.target.root,
            onAcquire
          )
        );
        const before = await ctx.target.prepare(page, ctx.input, ctx.provider, ctx.signal, ctx.fields);
        aborted(ctx);
        if (ctx.input.dryRun) {
          safeToClose = true;
          await ctx.store.save({ ...ctx.fields, dry_run: 'ok' }, lease);
          return result(ctx, 'dry_run_ok');
        }
        // Never place raw composer/turn text in before. Count-only turns are enough for the delta.
        const baseline = {
          url: before.url,
          turns: before.turns.filter((t) => t.role === 'user').map(() => ({ role: 'user', text: '' })),
          sidebar: before.sidebar,
          composer_sha256: sha256Hex(before.composer ?? ''),
        };
        ctx.phase?.('click');
        record = await ctx.store.click(
          {
            ...ctx.fields,
            ...before.recordFields,
            before: baseline,
            sent_target_id: page.id,
            sidebar_before: before.sidebar,
            tabs: { sent: page.id },
            unresolved: 'confirm',
            ...(ctx.input.attach && before.cards?.length === 1 ? { attachment_display_name: before.cards[0] } : {}),
          },
          lease
        );
        attempted = true;
        // Any click result, stale page or transport error is ambiguous. No second call to click.
        try {
          await ctx.target.click(page, ctx.signal);
        } catch {
          /* confirm and reconcile only */
        }
      } else {
        // No force resend: release first, then confirm_resend. An unreleased
        // attempt remains read-only even when the caller acknowledges a retry.
        ctx.phase?.('reconcile');
        page = await locate(ctx, record);
      }
      if (page) {
        ctx.target.bindPage?.(page, record, ctx.signal);
        ctx.phase?.('confirm');
        const confirmation = await confirm(ctx, page, record, attempted ? 120_000 : 0, now, sleep);
        if (confirmation.facts && confirmation.sent) {
          record = await ctx.store.save(
            {
              send_effect: 'sent',
              sent_evidence: confirmation.evidence,
              ...(ctx.target.settled(confirmation.facts.url)
                ? { conversation_url: confirmation.facts.url, conversation_url_source: 'tab' }
                : {}),
              unresolved: '',
            },
            lease
          );
        } else if (confirmation.human) {
          return result(ctx, 'needs_human', { reason: confirmation.human });
        } else {
          // D5: one automatic read-only reconciliation after an uncertain confirmation.
          const released = await reconcile(ctx, page, record, lease, now, sleep);
          if (released) {
            safeToClose = true;
            return result(ctx, 'not_submitted');
          }
          record = (await ctx.store.read()) ?? record;
          if (record.send_effect !== 'sent') {
            await ctx.store.save(
              { ...(ctx.target.provider === 'aistudio' ? { status: 'uncertain' } : {}), unresolved: 'confirm' },
              lease
            );
            return result(ctx, ctx.input.confirmResend ? 'already_attempted' : 'uncertain');
          }
        }
      } else
        return result(ctx, ctx.input.confirmResend ? 'already_attempted' : 'uncertain', {
          reason: 'NoConversationAddress',
        });
    }
    // Keep the attempted send tab through unresolved locate and all exceptional exits.
    safeToClose = ctx.target.provider === 'chatgpt' && ctx.target.settled(record.conversation_url);
  } catch (error) {
    // Pre-send failures remain retryable; attempts preserve a bounded, non-reflective diagnostic.
    if (!attempted)
      await ctx.store.save(
        {
          attempts: [
            ...(record.attempts ?? []),
            {
              at: new Date(now()).toISOString(),
              phase_reached: 'prepare',
              result: 'pre_send' as const,
              error: {
                code:
                  typeof (error as { code?: unknown })?.code === 'string'
                    ? String((error as { code: string }).code)
                    : 'pre_send_failed',
                message: 'pre_send_failed',
              },
            },
          ].slice(-20),
        },
        lease
      );
    if (!attempted && error instanceof JevFailure && error.code === 'needs_human') {
      const reason = ['login', 'challenge', 'approval'].includes(error.message) ? error.message : 'approval';
      return result(ctx, 'needs_human', { reason, recoverable: false });
    }
    throw error;
  } finally {
    lease.release();
    if (page) {
      if (!attempted || safeToClose) await page.close().catch(() => undefined);
      else await page.detach().catch(() => undefined);
    }
  }
  return waitForAnswer(ctx, record, now, sleep);
}

async function confirm(
  ctx: OracleContext,
  page: OraclePage,
  record: OperationRecord,
  maxMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>
) {
  const provider: JudgmentProvider = {
    judge:
      ctx.provider.judge?.bind(ctx.provider) ??
      (async () => {
        throw new Error('judge_unavailable');
      }),
  };
  let facts: OracleFacts | undefined;
  let evidence: string[] = [];
  const outcome = await awaitState(
    { name: 'submitted', statement: 'The committed message has been submitted to this conversation.' },
    {
      async observe() {
        facts = await page.facts();
        evidence = corroborators(facts, beforeOf(record), ctx.target);
        const bound = ctx.target.binding(facts, ctx.input, record).found;
        if (bound && !evidence.includes('user_turn_added')) evidence.push('user_turn_added');
        const observation = await page.observation(facts);
        observation.deltas = Object.fromEntries(evidence.map((name) => [name, true]));
        return observation;
      },
    },
    provider,
    {
      maxMs: Math.max(1, maxMs),
      maxLoadMs: 30_000,
      maxCalls: 6,
      signal: ctx.signal,
      now,
      sleep,
      cacheKey: `hud-jev:${ctx.jobId}`,
      fastPath: () => (facts && ctx.target.binding(facts, ctx.input, record).found ? 'pass' : null),
    }
  );
  return {
    sent: outcome.verdict === 'pass' && evidence.length > 0,
    facts,
    human: outcome.verdict === 'needs_human' ? outcome.humanKind : facts?.human,
    evidence: {
      via: outcome.probability === undefined ? 'facts' : 'judgment',
      corroborators: evidence,
      ...(outcome.probability !== undefined ? { p: outcome.probability } : {}),
    },
  };
}
async function reconcile(
  ctx: OracleContext,
  page: OraclePage,
  record: OperationRecord,
  lease: HeldLease,
  now: () => number,
  sleep: (ms: number) => Promise<void>
): Promise<boolean> {
  ctx.phase?.('reconcile');
  // AI Studio's legacy driver has no release; attempted_at is irrevocable.
  if (ctx.target.provider !== 'chatgpt' || record.released === true || ctx.target.settled(record.conversation_url))
    return false;
  const proofs: Array<{ at: number; p: number }> = [];
  for (let i = 0; i < 2; i++) {
    if (i) await sleep(10_000);
    let facts: OracleFacts | undefined;
    const provider: JudgmentProvider = {
      judge:
        ctx.provider.judge?.bind(ctx.provider) ??
        (async () => {
          throw new Error('judge_unavailable');
        }),
    };
    const outcome = await awaitState(
      { name: 'submitted', statement: 'The committed message has been submitted.' },
      {
        async observe() {
          facts = await page.facts();
          return page.observation(facts);
        },
      },
      provider,
      {
        maxMs: 15_000,
        maxLoadMs: 15_000,
        maxCalls: 1,
        now,
        sleep,
        signal: ctx.signal,
        cacheKey: `hud-jev:${ctx.jobId}`,
      }
    );
    if (!facts) return false;
    const hard = corroborators(facts, beforeOf(record), ctx.target);
    if (ctx.target.binding(facts, ctx.input, record).found || (outcome.verdict === 'pass' && hard.length)) {
      await ctx.store.save(
        {
          send_effect: 'sent',
          sent_evidence: { via: 'judgment', corroborators: hard, p: outcome.probability },
          ...(ctx.target.settled(facts.url) ? { conversation_url: facts.url } : {}),
        },
        lease
      );
      return false;
    }
    const baseline = Array.isArray(record.sidebar_before) ? (record.sidebar_before as string[]) : [];
    if (
      outcome.verdict !== 'deny' ||
      !(outcome.probability !== undefined && outcome.probability <= 0.1) ||
      !ctx.target.matchesDraft(facts, ctx.input) ||
      facts.stop ||
      facts.human ||
      facts.turns.some((t) => t.role === 'user') ||
      ctx.target.settled(facts.url) ||
      facts.url !== ctx.target.root ||
      facts.sidebar.some((href) => !baseline.includes(href))
    )
      return false;
    proofs.push({ at: now(), p: outcome.probability });
  }
  if (proofs[1]!.at - proofs[0]!.at < 10_000) return false;
  await ctx.store.release(
    {
      send_effect: 'not submitted',
      released_evidence: 'two stable reads: committed draft remains unsent',
      released_judgments: proofs,
      released_prompt_sha256: record.prompt_sha256,
      prompt_sha256: null,
    },
    lease
  );
  return true;
}

// A target factory contains several CDP calls (discovery, attach, navigation).
// Bound the aggregate too, including injected factories that never answer.
function readTarget<T>(ctx: OracleContext, method: string, read: () => Promise<T>): Promise<T> {
  return oracleRead(method, read, ctx.signal, ctx.readTimeoutMs);
}

/** Cleanup has its own host-clock bound, never the already-aborted job signal.
 * The answer doesn't await it; the runtime retains and drains it before exit. */
function cleanPage(
  ctx: OracleContext,
  step: 'open' | 'attach' | 'saved_close',
  resource: Promise<BrowserOwnership>,
  close: boolean
): Promise<void> {
  const started = Date.now();
  return (async () => {
    let owned: BrowserOwnership | undefined;
    let code: 'closed' | 'detached' | 'abandoned' = 'abandoned';
    try {
      await oracleRead(
        'Target.closeTarget',
        async () => {
          owned = await resource;
          if (close) await owned.close();
          else await owned.detach();
        },
        undefined,
        2_000
      );
      code = close ? 'closed' : 'detached';
    } catch {
      // A stuck close must not retain the transport or runtime indefinitely.
    } finally {
      const acquired = owned;
      if (acquired && (close || code === 'abandoned'))
        await oracleRead('Target.detachFromTarget', () => acquired.detach(), undefined, 1_000).catch(() => undefined);
      ctx.cleanup?.(step, Math.max(0, Date.now() - started), code);
    }
  })();
}

/** Register ownership at creation, before the factory's navigation can hang.
 * A recovery attach owns only a connection: abort must never close the send tab.
 * Late injected factories without early ownership still get a bounded disposal. */
async function readPage(
  ctx: OracleContext,
  method: 'Target.createTarget' | 'Target.attachToTarget',
  read: (acquisition: BrowserAcquisition) => Promise<OraclePage>
): Promise<OraclePage> {
  const cancel = new AbortController();
  let release!: () => void;
  const lifetime = new Promise<void>((resolve) => {
    release = resolve;
  });
  ctx.retainCleanup?.(lifetime);
  let acquired = false;
  let provide!: BrowserAcquired;
  const resource = new Promise<BrowserOwnership>((resolve) => {
    provide = (ownership) => {
      if (acquired) return;
      acquired = true;
      resolve(ownership);
    };
  });
  try {
    const page = await readTarget(ctx, method, async () => {
      const page = await read({ onAcquire: provide, signal: AbortSignal.any([ctx.signal, cancel.signal]) });
      provide(page);
      return page;
    });
    release();
    return page;
  } catch (error) {
    cancel.abort(error);
    void cleanPage(
      ctx,
      method === 'Target.createTarget' ? 'open' : 'attach',
      resource,
      method === 'Target.createTarget'
    ).then(release, release);
    throw error;
  }
}

/** Address -> surviving send target (even provisional) -> unique sidebar difference. No typing/clicking. */
async function locate(ctx: OracleContext, record: OperationRecord): Promise<OraclePage | undefined> {
  if (ctx.target.settled(record.conversation_url)) {
    const url = record.conversation_url;
    return readPage(ctx, 'Target.createTarget', (acquired) => ctx.target.open(url, acquired));
  }
  const id = typeof record.sent_target_id === 'string' ? record.sent_target_id : '';
  const targets = await readTarget(ctx, 'Target.getTargets', () => ctx.target.targets());
  const sent = targets.find((target) => target.targetId === id);
  if (sent) return readPage(ctx, 'Target.attachToTarget', (acquired) => ctx.target.attach(sent.targetId, acquired));
  const root = await readPage(ctx, 'Target.createTarget', (acquired) => ctx.target.open(ctx.target.root, acquired));
  try {
    ctx.target.bindPage?.(root, record, ctx.signal);
    const facts = await root.facts();
    const before = Array.isArray(record.sidebar_before) ? (record.sidebar_before as string[]) : [];
    const added = facts.sidebar.filter((href) => !before.includes(href)).filter((href) => ctx.target.settled(href));
    if (added.length === 1) {
      await root.close();
      return readPage(ctx, 'Target.createTarget', (acquired) => ctx.target.open(added[0]!, acquired));
    }
    // A root draft is useful for the one conservative release check.
    return root;
  } catch (error) {
    await root.close();
    throw error;
  }
}
async function waitForAnswer(
  ctx: OracleContext,
  initial: OperationRecord,
  now: () => number,
  sleep: (ms: number) => Promise<void>
): Promise<OracleResult> {
  ctx.phase?.('wait');
  const joined = acquireWaitLease(ctx.stateDir, ctx.key, { jobId: ctx.jobId, phase: 'wait', holder: 'hud' });
  const deadline = now() + Math.min(ctx.input.maxWaitMs ?? 7_200_000, 14_400_000);
  if (joined.role === 'tail') {
    while (now() < deadline) {
      aborted(ctx);
      const cached = completed(ctx, await ctx.store.read());
      if (cached) return cached;
      await sleep(500);
    }
    return result(ctx, 'timed_out');
  }
  let page: OraclePage | undefined;
  let record = initial;
  let previous = '';
  let stable = 0;
  let recoveries = 0;
  let changedAt = now();
  let lastGeneratingJudgment = -Infinity;
  const timed = async <T>(step: CollectTimingStep, read: () => T | Promise<T>): Promise<T> => {
    const started = now();
    try {
      return await read();
    } finally {
      ctx.timing?.(step, Math.max(0, now() - started));
    }
  };
  try {
    const tabs = record.tabs as { observer?: unknown } | undefined;
    if (typeof tabs?.observer === 'string' && tabs.observer !== record.sent_target_id) {
      const observer = tabs.observer;
      const old = await readPage(ctx, 'Target.attachToTarget', (acquired) =>
        ctx.target.attach(observer, acquired)
      ).catch(() => undefined);
      await old?.close().catch(() => undefined);
    }
    page = await locate(ctx, record);
    if (!page) return result(ctx, 'wait_failed', { reason: 'NoConversationAddress' });
    ctx.target.bindPage?.(page, record, ctx.signal);
    await ctx.store.save(
      { tabs: { sent: initial.sent_target_id, observer: page.id !== initial.sent_target_id ? page.id : null } },
      joined.lease
    );
    while (now() < deadline) {
      aborted(ctx);
      // The next live sample is the final collection check, not a saved-view
      // cross-check. A hang here still leaves the answer unproven/recoverable.
      if (stable === 2) ctx.phase?.('collect');
      let facts: OracleFacts;
      try {
        const live = page;
        facts = stable === 2 ? await timed('live_facts', () => live.facts()) : await live.facts();
      } catch (error) {
        aborted(ctx);
        if (browserTimeout(error)) throw error;
        await page.detach().catch(() => undefined);
        if (++recoveries > 2) return result(ctx, 'wait_failed', { reason: 'browser_recovery_exhausted' });
        page = await locate(ctx, (await ctx.store.read()) ?? record);
        if (!page) return result(ctx, 'wait_failed', { reason: 'NoConversationAddress' });
        ctx.target.bindPage?.(page, record, ctx.signal);
        continue;
      }
      if (facts.human) return result(ctx, 'needs_human', { reason: facts.human });
      if (facts.error) return result(ctx, 'wait_failed', { reason: 'page_error' });
      if (
        ctx.target.settled(record.conversation_url) &&
        ctx.target.settled(facts.url) &&
        facts.url !== record.conversation_url
      )
        return result(ctx, 'wait_failed', { reason: 'conversation_changed' });
      const bound = ctx.target.binding(facts, ctx.input, record);
      if (ctx.target.settled(facts.url))
        record = await ctx.store.save(
          { conversation_url: facts.url, conversation_url_source: 'tab', unresolved: '' },
          joined.lease
        );
      if (bound.found) {
        record = await ctx.store.save(
          {
            send_effect: 'sent',
            partial_answer_chars: bound.answer.length,
            ...(ctx.target.provider === 'aistudio' && !record.observed_sent_at
              ? { observed_sent_at: new Date(now()).toISOString() }
              : {}),
          },
          joined.lease
        );
        if (bound.answer) writeOracleFile(ctx.stateDir, ctx.key, '.partial.txt', bound.answer + '\n');
      }
      if (bound.answer !== previous || facts.stop) changedAt = now();
      if (!facts.stop && !bound.final && now() - changedAt >= 300_000 && now() - lastGeneratingJudgment >= 300_000) {
        lastGeneratingJudgment = now();
        const observation = await page.observation(facts);
        const still = await awaitState(
          { name: 'still_generating', statement: 'The model is still thinking or generating a response.' },
          {
            async observe() {
              return observation;
            },
          },
          {
            judge:
              ctx.provider.judge?.bind(ctx.provider) ??
              (async () => {
                throw new Error('judge_unavailable');
              }),
          },
          { maxMs: 5_000, maxLoadMs: 0, maxCalls: 1, signal: ctx.signal, now, sleep }
        );
        if (still.verdict !== 'pass') {
          await ctx.store.save({ completion: 'INCOMPLETE' }, joined.lease);
          return result(ctx, 'incomplete');
        }
      }
      if (facts.exchange?.final && !facts.exchange.text && bound.found) {
        await ctx.store.save({ status: 'empty', completion: 'INCOMPLETE' }, joined.lease);
        return result(ctx, 'incomplete', { reason: 'empty_answer' });
      }
      const wasCollecting = stable >= 2;
      stable = bound.found && bound.answer && bound.final && !facts.stop && bound.answer === previous ? stable + 1 : 0;
      if (wasCollecting && stable < 2) ctx.phase?.('wait');
      previous = bound.answer;
      if (stable >= 3) {
        let finalAnswer = bound.answer;
        let crossCheck: OracleResult['cross_check'];
        const crossCheckFailure = (error: unknown) => {
          crossCheck = browserTimeout(error) ? 'browser_timeout' : 'unavailable';
          ctx.diagnostic?.(`cross_check.${crossCheck}`, error);
        };
        if (ctx.target.provider === 'aistudio') {
          // A stable, final live answer is authoritative. Do not spend 20 ×
          // (2s + virtualised facts) waiting for an optional Drive address.
          // If already settled, give the *whole* saved-view cross-check 5s,
          // including opening a hidden tab and its render pauses, not 5s per RPC.
          if (ctx.target.settled(facts.url)) {
            record = await ctx.store.save({ conversation_url: facts.url }, joined.lease);
            let saved: OraclePage | undefined;
            const budget = new AbortController();
            const timer = setTimeout(
              () => budget.abort(new JevFailure('browser_timeout', 'browser_timeout')),
              Math.min(5_000, ctx.readTimeoutMs ?? 5_000)
            );
            const signal = AbortSignal.any([ctx.signal, budget.signal]);
            const crossContext = { ...ctx, signal };
            try {
              const url = facts.url;
              saved = await timed('saved_open', () =>
                readPage(crossContext, 'Target.createTarget', (acquired) => ctx.target.open(url, acquired))
              );
              ctx.target.bindPage?.(saved, record, signal);
              const observer = saved;
              const view = await timed('saved_facts', () =>
                oracleRead('Runtime.evaluate', () => observer.facts(), signal, ctx.readTimeoutMs)
              );
              const reread = ctx.target.binding(view, ctx.input, record);
              if (
                !view.human &&
                !view.error &&
                reread.found &&
                reread.final &&
                reread.answer.length >= finalAnswer.length
              ) {
                finalAnswer = reread.answer;
                crossCheck = 'ok';
              } else crossCheck = 'unavailable';
            } catch (error) {
              aborted(ctx);
              crossCheckFailure(error);
              // Every saved-view failure keeps the stable, final live answer.
            } finally {
              clearTimeout(timer);
              if (saved) {
                const observer = saved;
                const cleanup = timed('saved_close', () =>
                  cleanPage(ctx, 'saved_close', Promise.resolve(observer), true)
                );
                ctx.retainCleanup?.(cleanup);
              }
            }
          } else crossCheck = 'unavailable';
        }
        const persistedAt = now();
        const file = writeOracleFile(ctx.stateDir, ctx.key, '.md', finalAnswer + '\n');
        await ctx.store.save(
          {
            completion: 'COMPLETE',
            status: ctx.target.provider === 'aistudio' ? 'done' : undefined,
            answer_file: file,
            out: ctx.target.provider === 'aistudio' ? file : undefined,
            answer_sha256: sha256Hex(finalAnswer),
            chars: finalAnswer.length,
            done_at: new Date(now()).toISOString(),
          },
          joined.lease
        );
        ctx.timing?.('persist', Math.max(0, now() - persistedAt));
        return result(ctx, 'answered', {
          answer: finalAnswer,
          answer_file: file,
          ...(crossCheck ? { cross_check: crossCheck } : {}),
        });
      }
      await sleep(3_000);
    }
    await ctx.store.save(
      {
        completion: 'IN_PROGRESS',
        ...(ctx.target.provider === 'aistudio' ? { status: 'timeout', timeout_at: new Date(now()).toISOString() } : {}),
      },
      joined.lease
    );
    return result(ctx, 'timed_out');
  } finally {
    joined.lease.release();
    if (page) {
      // Only an owned observer may close. A send target is retained until final collection.
      const disk = await ctx.store.read().catch(() => null);
      const observer = page;
      const cleanup = () =>
        observer.id !== initial.sent_target_id ||
        (disk?.completion === 'COMPLETE' &&
          (ctx.target.provider !== 'aistudio' || ctx.target.settled(disk.conversation_url)))
          ? observer.close().catch(() => undefined)
          : observer.detach().catch(() => undefined);
      if (disk?.completion === 'COMPLETE') await timed('live_cleanup', cleanup);
      else await cleanup();
    }
  }
}
export function writeOracleFile(stateDir: string, key: string, suffix: string, text: string): string {
  const dir = join(stateDir, 'out');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, operationStem(key) + suffix);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
  fsyncDirectory(dir, fsyncSync);
  return file;
}
