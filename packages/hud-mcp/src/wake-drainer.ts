import { lstatSync, mkdirSync } from 'node:fs';
import { readdir, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ledger } from '../../../src/ledger/ledger.js';
import type { LedgerTransaction } from '../../../src/ledger/transaction.js';
import { decodeRecord, readLink } from '../../../src/ledger/records.js';
import {
  recordWakeDelivered,
  recordWakeRevoked,
  isWakeWorthyEvent,
  type WakeDelivery,
} from '../../../src/ledger/notify-events.js';
import type { LedgerEvent } from '../../../src/core/types/execution.js';
import type { Link, WaitUntil } from '../../../src/core/types/lifecycle.js';
import type { ProcessStamp } from '../../../src/core/types/supervision.js';
import { sameProcessStamp } from '../../../src/core/supervision.js';
import { processState } from '../../../src/core/run/process.js';
import { hintSubscription, type SubscribeWait, type WaitSubscription } from '../../../src/core/wait/index.js';
import { hintDirectory } from '../../../src/core/wait/hints.js';
import { WakeAdapters } from '../../../src/core/wake/adapters.js';
import { wakeDetails, wakeMessage } from '../../../src/core/wake/message.js';
import { readWakeState, type RegistrationState, type WakeWaitObserver } from './wake-state.js';

interface Batch {
  throughSeq: number;
  beforeSeq: number;
  attempt: number;
  confirmed: boolean;
  rejected: boolean;
}
function batchIn(tx: LedgerTransaction, state: RegistrationState): Batch {
  const args = [state.link.linkId, state.seq, state.seq] as const;
  const through = Number(
    tx.get(
      `SELECT coalesce(max(json_extract(payload,'$.throughSeq')),?) AS n FROM events
    WHERE link_id=? AND seq>? AND kind='wake.delivered' AND json_extract(payload,'$.registrationSeq')=?`,
      state.seq,
      ...args
    )!.n
  );
  const before = Number(
    tx.get(
      `SELECT coalesce(max(json_extract(payload,'$.throughSeq')),?) AS n FROM events
    WHERE link_id=? AND seq>? AND kind='wake.delivered' AND json_extract(payload,'$.registrationSeq')=?
    AND json_extract(payload,'$.throughSeq')<?`,
      state.seq,
      ...args,
      through
    )!.n
  );
  const rows = tx.all(
    `SELECT payload FROM events WHERE link_id=? AND seq>? AND kind='wake.delivered'
    AND json_extract(payload,'$.registrationSeq')=? AND json_extract(payload,'$.throughSeq')=?`,
    ...args,
    through
  );
  const results = rows.map((row) => JSON.parse(String(row.payload)) as WakeDelivery);
  return {
    throughSeq: through,
    beforeSeq: before,
    attempt: Math.max(0, ...results.map((r) => ('attempt' in r ? r.attempt : 0))),
    confirmed: results.some((r) => r.result === 'accepted' || r.result === 'wait_return'),
    rejected: results.some((r) => r.result === 'rejected'),
  };
}
interface Work {
  state: RegistrationState;
  events: LedgerEvent[];
  attempt: 1 | 2;
  throughSeq: number;
  beforeSeq: number;
}
interface Tracked {
  state: RegistrationState;
  runs: string[];
  lastRead: number;
  cursor: number;
  highWater?: number;
  backlog: boolean;
  eligible: boolean;
  hinted: boolean;
  tailClosed: boolean;
  work?: Work;
}
interface Retry {
  startedAt: number;
  throughSeq: number;
  callOrdinal: number;
  completedAt: number;
  suppressed: boolean;
  events: LedgerEvent[];
  beforeSeq: number;
}
export interface WakeDrainerOptions {
  ledger: Ledger;
  home: string;
  processKey: string;
  parentStamp?: ProcessStamp | null;
  /** This process's registered MCP, needed to prove continuous retry observation. */
  callerId?: string;
  recoveryMs?: number;
  adapters: WakeAdapters;
  subscribe?: SubscribeWait;
  /** Trusted fault/clock seams, unavailable through config/tools/environment. */
  now?: () => number;
  afterReservation?: (work: Readonly<Work>) => void;
  afterTransport?: (work: Readonly<Work>) => void;
}

/** Ledger-backed scheduling, not a parent consumption cursor. See B19/amendments.md. */
export class WakeDrainer implements WakeWaitObserver {
  private readonly recoveryMs: number;
  private readonly terminalTailMs: number;
  private readonly now: () => number;
  private readonly subscribe: SubscribeWait;
  private readonly tracked = new Map<number, Tracked>();
  private readonly subscriptions = new Map<string, WaitSubscription>();
  private readonly waits = new Map<symbol, { runId: string; afterSeq: number; until: WaitUntil[] }>();
  private readonly returnedSeqs = new Map<number, LedgerEvent>();
  private readonly retries = new Map<number, Retry>();
  private readonly lifetime = new AbortController();
  private callOrdinal = 0;
  private stopped = false;
  private immediate?: NodeJS.Immediate;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private again = false;
  private janitor?: Promise<void>;
  private rotation = 0;
  readonly metrics = {
    pages: 0,
    startupPages: 0,
    hintPages: 0,
    recoveryPages: 0,
    metadataSnapshots: 0,
    reservationWrites: 0,
    outcomeWrites: 0,
    errors: 0,
  };
  get timerArmed(): boolean {
    return !!this.timer;
  }
  get eligibleRegistrations(): number {
    return [...this.tracked.values()].filter((t) => t.eligible).length;
  }
  constructor(private readonly options: WakeDrainerOptions) {
    this.recoveryMs = options.recoveryMs ?? 30000;
    if (!Number.isSafeInteger(this.recoveryMs) || this.recoveryMs < 1) throw new TypeError('invalid_recovery');
    this.terminalTailMs = Math.max(300000, 10 * this.recoveryMs);
    this.now = options.now ?? Date.now;
    this.subscribe = options.subscribe ?? hintSubscription(options.home);
    const directory = hintDirectory(options.home);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
      throw new Error('private_hints_required');
    this.janitor = this.cleanOldHints().catch(() => {});
    this.request();
  }
  /** A call at any point after attempt 1 permanently suppresses that batch's retry. */
  parentCall(): void {
    this.callOrdinal++;
    for (const retry of this.retries.values()) retry.suppressed = true;
    for (const tracked of this.tracked.values()) tracked.hinted = true;
    this.request();
  }
  opened(token: symbol, runId: string, afterSeq: number, until: WaitUntil[]): void {
    this.waits.set(token, { runId, afterSeq, until });
  }
  returned(token: symbol, events: LedgerEvent[]): void {
    if (!this.waits.has(token)) return;
    for (const event of events) if (isWakeWorthyEvent(event)) this.returnedSeqs.set(event.seq, event);
    this.request();
  }
  closed(token: symbol): void {
    this.waits.delete(token);
    this.request();
  }
  request(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.immediate ??= setImmediate(() => {
      this.immediate = undefined;
      this.running = this.drain()
        .catch(() => {
          this.metrics.errors++;
        })
        .finally(() => {
          this.running = undefined;
          if (this.again) {
            this.again = false;
            this.request();
          }
        });
    });
  }
  /** Tests may await scheduling, but production never awaits this from a tool. */
  async settled(): Promise<void> {
    if (this.immediate) await new Promise<void>((resolve) => setImmediate(resolve));
    await this.running;
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.lifetime.abort();
    if (this.immediate) clearImmediate(this.immediate);
    if (this.timer) clearTimeout(this.timer);
    this.immediate = undefined;
    this.timer = undefined;
    for (const subscription of this.subscriptions.values()) subscription.close();
    this.subscriptions.clear();
    await this.options.adapters.close();
    await this.running;
    await this.janitor;
  }
  private owned(state: RegistrationState): boolean {
    return (
      state.valid &&
      (!this.options.parentStamp || sameProcessStamp(this.options.parentStamp, state.registration.parentStamp))
    );
  }
  private async collect(): Promise<Tracked[]> {
    this.metrics.metadataSnapshots++;
    const now = this.now();
    const live = await this.options.ledger.readSnapshot((tx) => {
      const scope = tx.get(
        'SELECT session_ref,generation FROM caller_scopes WHERE process_key=? AND closed_at IS NULL',
        this.options.processKey
      );
      if (!scope?.session_ref) return [];
      const links = tx.all('SELECT * FROM links WHERE parent_ref=?', scope.session_ref);
      const found: Tracked[] = [];
      for (const row of links) {
        const link = decodeRecord<Link>(row);
        const state = readWakeState(tx, link);
        if (!state || !this.owned(state) || state.registration.adapter === 'none') continue;
        if (
          state.context?.kind !== 'dedicated' ||
          state.context.processKey !== this.options.processKey ||
          state.context.procGeneration !== Number(scope.generation)
        )
          continue;
        const runs = tx.all('SELECT run_id,state,ended_at FROM runs WHERE link_id=? ORDER BY run_seq', link.linkId);
        const current = runs.at(-1);
        if (!current) continue;
        const active = runs.some((r) => !['ended', 'failed', 'cancelled'].includes(String(r.state)));
        const tail = current.ended_at !== null && now - Number(current.ended_at) <= this.terminalTailMs;
        let tracked = this.tracked.get(state.seq);
        if (!tracked)
          tracked = {
            state,
            runs: [],
            lastRead: -Infinity,
            cursor: state.seq,
            backlog: false,
            eligible: false,
            hinted: false,
            tailClosed: !active && !tail,
          };
        tracked.state = state;
        tracked.runs = runs.map((r) => String(r.run_id));
        const batch = batchIn(tx, state);
        for (const [seq, event] of this.returnedSeqs)
          if (event.linkId === link.linkId && seq <= batch.throughSeq) this.returnedSeqs.delete(seq);
        const retry = this.retries.get(state.seq);
        if (retry && !retry.suppressed && !this.observesRetry(tx, state)) retry.suppressed = true;
        const retryEligible =
          !!retry &&
          !retry.suppressed &&
          retry.callOrdinal === this.callOrdinal &&
          retry.throughSeq === batch.throughSeq &&
          batch.attempt === 1 &&
          !batch.confirmed &&
          !batch.rejected;
        tracked.eligible =
          active || tail || !tracked.tailClosed || tracked.backlog || !!tracked.work || tracked.hinted || retryEligible;
        if (!tracked.eligible) {
          found.push(tracked);
          continue;
        }
        if (!tracked.work && now - tracked.lastRead >= this.recoveryMs) {
          if (retryEligible && now - retry!.completedAt < this.recoveryMs) {
            found.push(tracked);
            continue;
          }
          const attempt: 1 | 2 = retryEligible ? 2 : 1;
          const beforeSeq = retryEligible ? retry!.beforeSeq : Math.max(batch.throughSeq, tracked.cursor);
          const highWater = retryEligible
            ? batch.throughSeq
            : (tracked.highWater ?? Number(tx.get('SELECT coalesce(max(seq),0) AS n FROM events')!.n));
          const page = retryEligible
            ? retry!.events
            : tx
                .all(
                  'SELECT * FROM events WHERE link_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 200',
                  link.linkId,
                  beforeSeq,
                  highWater
                )
                .map((row) => decodeRecord<LedgerEvent>(row));
          if (!retryEligible) {
            this.metrics.pages++;
            if (tracked.lastRead === -Infinity) this.metrics.startupPages++;
            else if (tracked.hinted) this.metrics.hintPages++;
            else this.metrics.recoveryPages++;
            tracked.lastRead = now;
          }
          tracked.hinted = false;
          const events = page.filter(isWakeWorthyEvent);
          if (!active && !tail && page.length < 200 && events.length === 0) {
            tracked.tailClosed = true;
            tracked.eligible = false;
          }
          if (!retryEligible) {
            tracked.cursor = page.at(-1)?.seq ?? Math.max(beforeSeq, highWater);
            tracked.highWater = page.length === 200 ? highWater : undefined;
            tracked.backlog = page.length === 200;
          }
          if (events.length && state.registration.adapter !== 'claude_background_wait_v1')
            tracked.work = {
              state,
              events,
              attempt,
              throughSeq: events.at(-1)!.seq,
              beforeSeq: retryEligible ? batch.beforeSeq : batch.throughSeq,
            };
        }
        found.push(tracked);
      }
      return found;
    });
    this.tracked.clear();
    for (const tracked of live) this.tracked.set(tracked.state.seq, tracked);
    const wanted = new Set(live.flatMap((t) => t.runs));
    for (const [run, subscription] of this.subscriptions)
      if (!wanted.has(run)) {
        subscription.close();
        this.subscriptions.delete(run);
      }
    for (const run of wanted) {
      const old = this.subscriptions.get(run);
      if (old?.unavailable) {
        old.close();
        this.subscriptions.delete(run);
      }
      if (!this.subscriptions.has(run))
        this.subscriptions.set(
          run,
          this.subscribe(run, () => {
            for (const tracked of this.tracked.values()) if (tracked.runs.includes(run)) tracked.hinted = true;
            this.request();
          })
        );
    }
    return live;
  }
  private covered(event: LedgerEvent): boolean {
    if (this.returnedSeqs.has(event.seq)) return true;
    return [...this.waits.values()].some(
      (w) =>
        w.runId === event.runId &&
        w.afterSeq < event.seq &&
        w.until.includes(
          event.kind === 'report.received' ? 'report' : event.kind === 'run.terminal' ? 'run_terminal' : 'uncertain'
        )
    );
  }
  private async reserve(work: Work): Promise<boolean> {
    return this.options.ledger.transaction((tx) => {
      const state = readWakeState(tx, readLink(tx, work.state.link.linkId));
      if (!state || state.seq !== work.state.seq || !this.owned(state)) return false;
      const batch = batchIn(tx, state);
      if (work.attempt === 1 && batch.throughSeq > work.beforeSeq) return false;
      if (work.attempt === 2) {
        const retry = this.retries.get(state.seq);
        if (
          !retry ||
          retry.suppressed ||
          retry.callOrdinal !== this.callOrdinal ||
          !this.observesRetry(tx, state) ||
          batch.throughSeq !== work.throughSeq ||
          batch.attempt !== 1 ||
          batch.confirmed ||
          batch.rejected ||
          this.now() - retry.completedAt < this.recoveryMs
        )
          return false;
      }
      recordWakeDelivered(
        tx,
        state.link.linkId,
        {
          registrationSeq: state.seq,
          throughSeq: work.throughSeq,
          result: 'unknown',
          ...(work.attempt === 1 ? { attempt: 1 as const } : { attempt: 2 as const, exhausted: true as const }),
        },
        this.now()
      );
      this.metrics.reservationWrites++;
      return true;
    });
  }
  private observesRetry(tx: LedgerTransaction, state: RegistrationState): boolean {
    const retry = this.retries.get(state.seq);
    if (
      !this.options.callerId ||
      state.context?.callerId !== this.options.callerId ||
      !retry ||
      retry.suppressed ||
      retry.callOrdinal !== this.callOrdinal
    )
      return false;
    // A newly registered MCP is an observation gap even before its first
    // context. Known contexts of other harness processes are unrelated.
    const observers = Number(
      tx.get(
        `SELECT count(*) AS n FROM callers c WHERE c.source_id=? AND (c.retired_at IS NULL OR c.retired_at>=?)
      AND NOT EXISTS (SELECT 1 FROM caller_contexts x WHERE x.caller_id=c.caller_id AND x.closed_at IS NULL AND x.process_key<>?)`,
        state.registration.parentRef.sourceId,
        retry.startedAt,
        this.options.processKey
      )!.n
    );
    return observers === 1;
  }
  private async process(tracked: Tracked): Promise<void> {
    const work = tracked.work;
    if (!work) return;
    if (work.events.every((e) => this.returnedSeqs.has(e.seq))) {
      const committed = await this.options.ledger.transaction((tx) => {
        const state = readWakeState(tx, readLink(tx, work.state.link.linkId));
        if (
          !state ||
          state.seq !== work.state.seq ||
          !this.owned(state) ||
          batchIn(tx, state).throughSeq >= work.throughSeq
        )
          return false;
        recordWakeDelivered(
          tx,
          state.link.linkId,
          { registrationSeq: state.seq, throughSeq: work.throughSeq, result: 'wait_return' },
          this.now()
        );
        return true;
      });
      if (committed) await this.cleanCoveredHints(tracked.runs, work.throughSeq);
      tracked.work = undefined;
      return;
    }
    if (work.events.every((e) => this.covered(e))) return;
    if (this.stopped) return;
    const ordinal = this.callOrdinal;
    const observedAt = this.now();
    if (!(await this.reserve(work))) {
      tracked.work = undefined;
      // The inspected suffix may extend beyond a competing worker's shorter
      // reservation. Re-read from durable coverage using the next allowance.
      tracked.cursor = work.beforeSeq;
      tracked.highWater = undefined;
      tracked.backlog = true;
      this.again = true;
      return;
    }
    this.options.afterReservation?.(work);
    // Recheck the committed sender fence after reservation. No await between this
    // snapshot's resolution and starting the native transport.
    const valid = await this.options.ledger.readSnapshot((tx) => {
      const state = readWakeState(tx, readLink(tx, work.state.link.linkId));
      return (
        !!state &&
        state.seq === work.state.seq &&
        this.owned(state) &&
        (work.attempt === 1 || this.observesRetry(tx, state))
      );
    });
    if (!valid || this.stopped) {
      tracked.work = undefined;
      return;
    }
    const stamp = work.state.registration.parentStamp;
    if (stamp && processState(stamp) !== 'alive') {
      tracked.work = undefined;
      return;
    }
    // The snapshot await itself yields: a call may have arrived after its
    // callback checked silence. This final local fence must not yield.
    const retry = this.retries.get(work.state.seq);
    if (work.attempt === 2 && (!retry || retry.suppressed || retry.callOrdinal !== this.callOrdinal)) {
      tracked.work = undefined;
      return;
    }
    const details = wakeDetails(work.state.link.linkId, work.state.registration.contextGeneration, work.events);
    const result = await this.options.adapters.send(
      work.state.registration,
      wakeMessage(details),
      details,
      this.lifetime.signal
    );
    this.options.afterTransport?.(work);
    if (this.stopped) return;
    if (result.result === 'unknown' && work.attempt === 1)
      this.retries.set(work.state.seq, {
        throughSeq: work.throughSeq,
        callOrdinal: ordinal,
        completedAt: this.now(),
        suppressed: ordinal !== this.callOrdinal,
        events: work.events,
        beforeSeq: work.beforeSeq,
        startedAt: observedAt,
      });
    const outcome: WakeDelivery = {
      registrationSeq: work.state.seq,
      throughSeq: work.throughSeq,
      ...(result.result === 'accepted'
        ? { result: 'accepted' as const, attempt: work.attempt }
        : result.result === 'rejected'
          ? { result: 'rejected' as const, attempt: work.attempt, reason: result.reason ?? 'adapter_rejected' }
          : work.attempt === 1
            ? { result: 'unknown' as const, attempt: 1 as const }
            : { result: 'unknown' as const, attempt: 2 as const, exhausted: true as const }),
    };
    await this.options.ledger.transaction((tx) => {
      recordWakeDelivered(tx, work.state.link.linkId, outcome, this.now());
      if (outcome.result === 'rejected')
        recordWakeRevoked(
          tx,
          work.state.link.linkId,
          { registrationSeq: work.state.seq, reason: 'adapter_rejected' },
          this.now()
        );
      this.metrics.outcomeWrites++;
    });
    tracked.work = undefined;
    for (const event of work.events) this.returnedSeqs.delete(event.seq);
    await this.cleanCoveredHints(tracked.runs, work.throughSeq);
  }
  private async drain(): Promise<void> {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    try {
      const all = await this.collect();
      if (all.length) {
        const start = this.rotation++ % all.length;
        for (let offset = 0; offset < all.length && !this.stopped; offset++) {
          const tracked = all[(start + offset) % all.length];
          const through = await this.options.ledger.readSnapshot((tx) => batchIn(tx, tracked.state).throughSeq);
          await this.cleanCoveredHints(tracked.runs, through);
          if (tracked.state.registration.adapter === 'claude_background_wait_v1')
            await this.cleanCoveredHints(tracked.runs, tracked.cursor);
          else await this.process(tracked);
        }
      }
    } finally {
      if (!this.stopped && [...this.tracked.values()].some((t) => t.eligible)) {
        const now = this.now();
        const due = Math.min(
          ...[...this.tracked.values()]
            .filter((t) => t.eligible)
            .map((t) => {
              const retry = this.retries.get(t.state.seq);
              return Math.max(
                t.lastRead + this.recoveryMs,
                retry && !retry.suppressed ? retry.completedAt + this.recoveryMs : 0
              );
            })
        );
        this.timer = setTimeout(
          () => {
            this.timer = undefined;
            this.request();
          },
          due <= now ? this.recoveryMs : Math.min(this.recoveryMs, due - now)
        );
        this.timer.unref();
      }
    }
  }
  private async cleanCoveredHints(runs: string[], throughSeq: number): Promise<void> {
    const owned = new Set(runs);
    try {
      for (const name of await readdir(hintDirectory(this.options.home))) {
        const parsed = /^([A-Za-z0-9_-]+)\.([0-9]+)$/.exec(name);
        if (parsed && owned.has(parsed[1]) && Number(parsed[2]) <= throughSeq)
          await unlink(join(hintDirectory(this.options.home), name)).catch(() => {});
      }
    } catch {
      /* Hints are not delivery state. */
    }
  }
  private async cleanOldHints(): Promise<void> {
    const directory = hintDirectory(this.options.home);
    const names = await readdir(directory);
    const terminal = await this.options.ledger.readSnapshot((tx) => {
      const ids = new Set<string>();
      for (const name of names) {
        const parsed = /^([A-Za-z0-9_-]+)\.([0-9]+)$/.exec(name);
        if (!parsed) continue;
        const run = tx.get('SELECT state FROM runs WHERE run_id=?', parsed[1]);
        if (run && ['ended', 'failed', 'cancelled'].includes(String(run.state))) ids.add(parsed[1]);
      }
      return ids;
    });
    for (const name of names) {
      if (this.stopped) return;
      const parsed = /^([A-Za-z0-9_-]+)\.([0-9]+)$/.exec(name);
      if (!parsed || !terminal.has(parsed[1])) continue;
      const path = join(directory, name);
      try {
        const stat = await lstat(path);
        if (stat.isFile() && this.now() - stat.mtimeMs > 3600000) await unlink(path);
      } catch {
        /* Races harmless. */
      }
    }
  }
}
