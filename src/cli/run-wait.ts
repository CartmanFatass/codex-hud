import { NativeHostClient, type NativeHostPort } from '../managed/host-ipc.js';
import type { NativeOwner } from '../managed/relations.js';
import type { HostMessage } from '../managed/host.js';
import { nativeWakeDetails, nativeWakeMessage } from '../managed/wake-message.js';
import { performance } from 'node:perf_hooks';
import { readProcess } from '../core/run/process.js';
import { sameProcessStamp } from '../core/supervision.js';
import { waitPage } from '../core/lifecycle.js';
import { hintSubscription, waitForRun, drainWaitPages, type SubscribeWait } from '../core/wait/index.js';
import { readDelegationEventsIn } from '../ledger/delegation-read.js';
import { decodeRecord, readLink } from '../ledger/records.js';
import type { LedgerTransaction } from '../ledger/transaction.js';
import type { WaitPage, WaitUntil } from '../core/types/lifecycle.js';
import type { Run } from '../core/types/execution.js';
import type { HudIO } from './link-export.js';
import { CliError, existingLedger, identifier, integer, options } from './runtime.js';

export interface NativeWaitArguments {
  nativeOwner: NativeOwner;
  connectionId?: string;
  afterSeq: number;
  timeoutMs: number;
  json: boolean;
}
export interface WaitArguments {
  target: { runId: string } | { linkId: string };
  afterSeq: number;
  until: WaitUntil[];
  timeoutMs: number;
  ownerGeneration?: number;
  json: boolean;
}
/** Independent of ledger/watch recovery; never configurable through CLI or environment. */
export const PARENT_LIVENESS_INTERVAL_MS = 2000;
export function parseWait(args: readonly string[]): WaitArguments | NativeWaitArguments {
  if (args.includes('--native-owner')) {
    const flags = options(
      args,
      ['--notify', '--json'],
      ['--native-owner', '--connection', '--after-seq', '--timeout-ms']
    );
    if (flags.has('--notify') && flags.has('--json')) throw new CliError('invalid_arguments');
    let owner: NativeOwner;
    try {
      owner = JSON.parse(String(flags.get('--native-owner')));
    } catch {
      throw new CliError('invalid_native_owner');
    }
    if (
      !owner ||
      !['codex', 'claude', 'pi'].includes(owner.harness) ||
      typeof owner.sourceId !== 'string' ||
      !owner.sourceId ||
      typeof owner.sessionId !== 'string' ||
      !owner.sessionId ||
      (owner.threadId !== null && typeof owner.threadId !== 'string')
    )
      throw new CliError('invalid_native_owner');
    return {
      nativeOwner: owner,
      ...(flags.has('--connection') ? { connectionId: identifier(String(flags.get('--connection'))) } : {}),
      afterSeq: flags.has('--after-seq') ? integer(String(flags.get('--after-seq')), Number.MAX_SAFE_INTEGER) : 0,
      timeoutMs: flags.has('--timeout-ms') ? integer(String(flags.get('--timeout-ms')), 2_147_483_647) : 7_200_000,
      json: flags.has('--json'),
    };
  }
  const positional = args[0] && !args[0].startsWith('--') ? identifier(args[0]) : undefined;
  const flags = options(
    positional ? args.slice(1) : args,
    ['--notify', '--json'],
    ['--link', '--after-seq', '--until', '--owner-generation', '--timeout-ms']
  );
  if (!!positional === flags.has('--link') || (flags.has('--json') && flags.has('--notify')))
    throw new CliError('invalid_arguments');
  const until = flags.has('--until')
    ? String(flags.get('--until')).split(',')
    : ['report', 'run_terminal', 'uncertain'];
  if (
    !until.length ||
    until.some((v) => !['report', 'run_terminal', 'uncertain'].includes(v)) ||
    new Set(until).size !== until.length
  )
    throw new CliError('invalid_until');
  const generation = flags.has('--owner-generation')
    ? integer(String(flags.get('--owner-generation')), Number.MAX_SAFE_INTEGER)
    : undefined;
  if (generation === 0) throw new CliError('invalid_owner_generation');
  return {
    target: positional ? { runId: positional } : { linkId: identifier(String(flags.get('--link'))) },
    afterSeq: flags.has('--after-seq') ? integer(String(flags.get('--after-seq')), Number.MAX_SAFE_INTEGER) : 0,
    until: until as WaitUntil[],
    timeoutMs: flags.has('--timeout-ms') ? integer(String(flags.get('--timeout-ms')), 2_147_483_647) : 7_200_000,
    ...(generation === undefined ? {} : { ownerGeneration: generation }),
    json: flags.has('--json'),
  };
}

type Page = WaitPage & { linkId: string; ownerGeneration: number; kinds: string[] };
function readPage(
  tx: LedgerTransaction,
  args: WaitArguments,
  runId: string | undefined,
  afterSeq: number,
  throughSeq?: number
): Page {
  const row = runId
    ? { run_id: runId }
    : 'runId' in args.target
      ? { run_id: args.target.runId }
      : tx.get('SELECT run_id FROM runs WHERE link_id=? ORDER BY run_seq DESC LIMIT 1', args.target.linkId);
  if (!row) throw new CliError('no_run', 4);
  const runRow = tx.get('SELECT * FROM runs WHERE run_id=?', String(row.run_id));
  if (!runRow) throw new CliError('no_run', 4);
  const run = decodeRecord<Run>(runRow);
  // waitPage consumes only runId/state, and public output exposes only
  // runId/state/mode. Supervisor authority is unavailable in this narrow read:
  // never scan historical events merely to assemble unexposed control facts.
  run.supervisor = null;
  delete (run as unknown as Record<string, unknown>).supervisorPid;
  delete (run as unknown as Record<string, unknown>).supervisorProcStart;
  const link = readLink(tx, run.linkId);
  if (args.ownerGeneration !== undefined) {
    const context = tx.get(
      'SELECT * FROM caller_contexts WHERE context_id=? AND generation=? AND closed_at IS NULL',
      link.parentContextId,
      args.ownerGeneration
    );
    const scope = context?.process_key
      ? tx.get('SELECT generation FROM caller_scopes WHERE process_key=? AND closed_at IS NULL', context.process_key)
      : null;
    if (
      link.parentContextGeneration !== args.ownerGeneration ||
      !context ||
      context.caller_id !== link.parentCaller ||
      !scope ||
      scope.generation !== context.proc_generation
    )
      throw new CliError('stale_generation', 4);
  }
  const asOfSeq = Number(tx.get('SELECT coalesce(max(seq),0) AS seq FROM events')!.seq);
  const highWaterSeq = throughSeq ?? asOfSeq;
  const { events, validReportSeqs } = readDelegationEventsIn(tx, run.runId, afterSeq, highWaterSeq);
  const page = waitPage(
    { runId: run.runId, afterSeq, until: args.until.filter((v) => v !== 'report'), timeoutMs: 0 },
    { run, highWaterSeq, events }
  );
  const reports = args.until.includes('report')
    ? page.events.filter((event) => validReportSeqs.includes(event.seq))
    : [];
  page.matched ||= reports.length > 0;
  const kinds = new Set<string>();
  for (const event of reports) {
    const report = tx.get(
      'SELECT status FROM reports WHERE report_id=? AND run_id=?',
      String(event.payload.reportId),
      run.runId
    );
    if (['completed', 'failed', 'blocked', 'interrupted'].includes(String(report?.status)))
      kinds.add(`report:${report!.status}`);
  }
  if (args.until.includes('run_terminal') && ['ended', 'failed', 'cancelled'].includes(run.state))
    kinds.add(`run:${run.state}`);
  if (args.until.includes('uncertain') && run.state === 'uncertain') kinds.add('run:uncertain');
  return { ...page, asOfSeq, linkId: link.linkId, ownerGeneration: link.parentContextGeneration, kinds: [...kinds] };
}

/** No report body, path, credential, arbitrary event payload or summary crosses this output boundary. */
export function publicWaitPage(page: Page & { watchUnavailable: boolean }) {
  return {
    runId: page.runId,
    events: page.events.map(({ seq, runId, kind, at }) => ({ seq, runId, kind, at })),
    nextSeq: page.nextSeq,
    matched: page.matched,
    timedOut: page.timedOut,
    current: { runId: page.current.runId, state: page.current.state, mode: page.current.mode },
    hasMore: page.hasMore,
    asOfSeq: page.asOfSeq,
    watchUnavailable: page.watchUnavailable,
  };
}

export function notification(page: Page & { watchUnavailable: boolean }): string {
  // All variable fields are validated identifiers/enums. Keep the line ASCII and bounded.
  const line = `[hud] ${page.matched ? 'wake' : 'deadline'} link=${page.linkId} run=${page.runId} kinds=${page.kinds.join(',') || 'none'} throughSeq=${page.nextSeq} stale=false watchUnavailable=${page.watchUnavailable} — call delegate_wait{runId, afterSeq:<your cursor>} and drain until hasMore=false; the ledger is the truth.\n`;
  if (Buffer.byteLength(line) <= 512) return line;
  return `[hud] ${page.matched ? 'wake' : 'deadline'} run=${page.runId} throughSeq=${page.nextSeq} stale=false watchUnavailable=${page.watchUnavailable} — call delegate_wait with your own cursor and drain until hasMore=false.\n`;
}

/** Parent liveness and ledger/watch recovery have separate bounded timers. */
export async function runWait(
  args: WaitArguments | NativeWaitArguments,
  home: string,
  io: HudIO,
  trusted: {
    subscribe?: SubscribeWait;
    recoveryMs?: number;
    afterWait?: (page: WaitPage) => Promise<void>;
  } = {}
): Promise<number> {
  if ('nativeOwner' in args) return runNativeWait(args, home, io);
  const ppid = process.ppid;
  const parent = readProcess(ppid)?.stamp;
  if (!parent || ppid <= 1) throw new CliError('orphaned', 4);
  const checkParent = () => {
    if (process.ppid !== ppid || !sameProcessStamp(parent, readProcess(ppid)?.stamp ?? null))
      throw new CliError('orphaned', 4);
  };
  const { ledger, gate } = await existingLedger(home);
  const controller = new AbortController();
  const interrupt = () => controller.abort(new CliError('interrupted', 130));
  const terminate = () => controller.abort(new CliError('terminated', 143));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  const deadline = performance.now() + args.timeoutMs;
  // Ledger/watch recovery stays independent of the faster parent-liveness check.
  const recoveryMs = Math.min(29_000, Math.max(1, trusted.recoveryMs ?? 29_000));
  let fixedRun: string | undefined;
  let cursor = args.afterSeq;
  let watchUnavailable = false;
  const kinds = new Set<string>();
  const subscribe = trusted.subscribe ?? hintSubscription(home);
  const cooperate = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.signal.throwIfAborted();
    checkParent();
  };
  const parentLiveness = setInterval(() => {
    try {
      checkParent();
    } catch (error) {
      controller.abort(error);
    }
  }, PARENT_LIVENESS_INTERVAL_MS);
  parentLiveness.unref();
  try {
    for (;;) {
      checkParent();
      const result = await waitForRun({
        timeoutMs: Math.min(recoveryMs, Math.max(0, Math.ceil(deadline - performance.now()))),
        subscribe,
        signal: controller.signal,
        read: async (runId) =>
          ledger.readSnapshot((tx) => {
            gate.check();
            checkParent();
            return readPage(tx, args, fixedRun ?? runId, cursor);
          }),
      });
      await trusted.afterWait?.(result);
      fixedRun ??= result.runId;
      identifier(fixedRun);
      identifier(result.linkId);
      watchUnavailable ||= result.watchUnavailable;
      if (args.json) {
        // JSON is one page. Return pagination immediately; never advance the caller's cursor invisibly.
        if (result.matched || result.hasMore || performance.now() >= deadline) {
          await cooperate();
          await io.stdout(
            JSON.stringify(
              publicWaitPage({
                ...result,
                timedOut: !result.matched && performance.now() >= deadline,
                watchUnavailable,
              })
            ) + '\n'
          );
          return 0;
        }
        continue;
      }
      let last = result;
      let matched = false;
      // Notify drains through ONE captured high-water; later commits remain for the next cycle.
      for await (const page of drainWaitPages(
        async (afterSeq, throughSeq) =>
          throughSeq === undefined
            ? result
            : ledger.readSnapshot((tx) => {
                gate.check();
                checkParent();
                return readPage(tx, args, fixedRun, afterSeq, throughSeq);
              }),
        cursor
      )) {
        last = { ...page, watchUnavailable };
        cursor = page.nextSeq;
        matched ||= page.matched;
        for (const kind of page.kinds) kinds.add(kind);
        if (page.hasMore) await cooperate();
      }
      if (matched || performance.now() >= deadline) {
        await cooperate();
        await io.stdout(notification({ ...last, matched, timedOut: !matched, kinds: [...kinds], watchUnavailable }));
        return 0;
      }
    }
  } finally {
    clearInterval(parentLiveness);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    await ledger.close();
  }
}

/** Claude's native background task runs this observer. Closing it never closes the backend. */
export async function runNativeWait(
  args: NativeWaitArguments,
  home: string,
  io: HudIO,
  host: NativeHostPort = new NativeHostClient(home, false)
): Promise<number> {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new CliError('interrupted', 130));
  const terminate = () => controller.abort(new CliError('terminated', 143));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  const deadline = performance.now() + args.timeoutMs;
  let afterSeq = args.afterSeq;
  try {
    for (;;) {
      controller.signal.throwIfAborted();
      const page = (await host.invoke(
        args.nativeOwner,
        'wait',
        {
          ...(args.connectionId ? { connectionId: args.connectionId } : {}),
          afterSeq,
          waitMs: Math.max(0, Math.min(120000, Math.ceil(deadline - performance.now()))),
        },
        controller.signal
      )) as { events: HostMessage[]; throughSeq: number; truncated: boolean; requests?: unknown[] };
      const pointers = page.events.map(nativeWakeDetails).filter((details) => details !== undefined);
      const timedOut = performance.now() >= deadline;
      if (pointers.length || page.truncated || timedOut) {
        if (args.json)
          await io.stdout(
            JSON.stringify({
              events: pointers,
              throughSeq: page.throughSeq,
              truncated: page.truncated,
              timedOut: !pointers.length && timedOut,
            }) + '\n'
          );
        else if (pointers.length) await io.stdout(pointers.map(nativeWakeMessage).join('\n') + '\n');
        else
          await io.stdout(
            page.truncated
              ? '[hud] Native observation buffer changed. Read native history and managed_requests. No task outcome inferred.\n'
              : '[hud] Native wait deadline reached. No backend cancellation or task outcome inferred.\n'
          );
        return 0;
      }
      afterSeq = page.throughSeq;
    }
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
