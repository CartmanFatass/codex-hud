/** `hud watch`: push only actionable events; --verbose retains the MCP change stream. */
import * as fs from 'node:fs';
import { writePrivateFile } from '../utils/atomic-fs.js';
import { join } from 'node:path';
import { checksJustFinished, failureUnobserved, formatJobChange, jobChanges, readSessionJobRows, readThinJobRows, type JobRow, type WatchJobRow } from '../collectors/thin-jobs.js';
import { questionFields } from '../collectors/work-artifacts.js';
import { TRIES_FILE, TryLog } from '../collectors/try-records.js';
import { PANEL_ACTIONS_FILE, PanelActionLog } from '../collectors/panel-actions.js';
import { getHudHome } from '../hud-home.js';
import { watchJobChanges } from '../collectors/job-changes.js';
import { collectSessionJobRows, watchJobsInBackground } from '../collectors/job-snapshot.js';
import { noticeReader, permissionEvents, workflowEvents } from '../workflows/events.js';
import { notifyOutcome, PROMPT_QUIET_MS, PROMPT_RETRY_TTL_MS, recordPromptExpiry, registerWatcher, type NotifyResult } from '../roles/notify.js';
import { watchHerdrPane } from '../runtime/herdr-socket.js';
import { reportMainPaneGroup } from '../runtime/pane-group.js';
import { herdrId } from '../roles/herdr-run.js';
import { getJobIndexCache } from '../roles/job-index-cache.js';
import { liveWorkerPanes, type LivePaneSnapshot } from '../roles/select-send.js';
import { beginNotice, releaseDelivery, revertDeliveryClaim, settleNotice, type DeliveryNotice, type DeliveryOutcome, type DeliveryVia } from '../utils/delivery-record.js';
import type { HudIO } from './hud.js';
import { CliError } from './private-home.js';
import { bandReader } from './watch-band.js';
import { packageBatches, type Notice } from './watch-batches.js';

export const WATCH_HELP =
  'Usage: hud watch [--all] [--verbose] [--queue | --mod]\n' +
  'Stream pending questions and actionable job events for the caller pane (HERDR_PANE_ID), plus project try records.\n' +
  '--all: every pane; --verbose: every change, as in MCP changes.\n' +
  '--mod: emit pane-scoped wake records and, when it changes, the owner band (what waits for the owner) as JSON lines for the Claude mod.\n' +
  '--queue: deliver through the Codex queue (typed fallback on failure) or Antigravity hook/idle prompt.\n';

// Woken by file changes under jobs/; the slow rescan only covers a watch lost or not yet attachable.
const DEFAULT_RESCAN_MS = 30_000;
const DEBOUNCE_MS = 50;
const SETTLEMENT_WINDOW_MS = 3000;
const MOD_REPORT_LOOKBACK_MS = 2 * 60 * 60_000;
// Linux may stamp a new file with the previous kernel tick, behind Date.now().
const NOTICE_MTIME_SLOP_MS = 10;

// Test-only override for both the CLI and in-process notification paths.
function settlementWindow(env: NodeJS.ProcessEnv): number {
  const ms = Number(env.HUD_WATCH_SETTLEMENT_MS);
  return Number.isInteger(ms) && ms > 0 ? ms : SETTLEMENT_WINDOW_MS;
}

const isBrokenPipe = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED';
};

const settled = (row: JobRow) => ['idle_grace', 'closed', 'done', 'failed', 'stopped'].includes(row.state ?? '');
type BatchItem = { line: string; marker?: undefined } | DeliveryNotice;
const textOf = (items: readonly BatchItem[]) => items.map(item => item.line).join('\n');
const prepare = (items: readonly BatchItem[]) => items.filter(item => !item.marker || beginNotice(item));
const release = (items: readonly BatchItem[]) => { for (const item of items) if (item.marker) releaseDelivery(item); };
function finish(items: readonly BatchItem[], outcome: DeliveryOutcome, via: DeliveryVia, reason?: string) {
  for (const item of items) if (item.marker) settleNotice(item, outcome, via, reason);
}
function appendBuffered(held: BatchItem[], incoming: BatchItem[]) {
  if (!incoming.length) return held;
  if (Buffer.byteLength(textOf(held)) + Buffer.byteLength(textOf(incoming)) < 16 * 1024) return held.concat(incoming);
  release(held);
  return incoming;
}
async function collectObligations(home: string, pane: string | null, cwd: string, env: NodeJS.ProcessEnv, all = false, modStartedAt: number | false = false,
  panes?: LivePaneSnapshot['panes']) {
  const pull = noticeReader(home, pane, cwd, env, panes === undefined ? undefined
    : async () => ({ panes, workerPanes: panes ? liveWorkerPanes(home, panes, env) : new Set() }));
  const flows = await workflowEvents(home, pane, all, cwd, modStartedAt, pull);
  const perms = await permissionEvents(home, pull, all);
  return { events: [...flows.events, ...perms.events], pending: flows.pending || perms.pending };
}
// A numeric catch-up value is the Claude mod's cutoff for individual report notices.
function actionable(home: string, prev: ReadonlyMap<string, JobRow>, rows: WatchJobRow[], catchup: boolean | number = false, lastScanAt = -Infinity): Notice[] {
  let olderReports = 0, olderFailures = 0;
  const settledAt = (job: string) => {
    const status = getJobIndexCache(home).readStatus(job);
    return status.status === 'ok'
      ? [status.value.settled_at, status.value.ended_at].map(v => typeof v === 'string' ? Date.parse(v) : NaN).find(Number.isFinite) ?? status.at
      : -Infinity;
  };
  const notices = rows.flatMap<Notice>((row) => {
    const old = prev.get(row.job);
    if (row.permission || row.ticket_queue) return [];
    const questions = row.question_ids.filter((id) => !old?.question_ids.includes(id)).map((id) => {
          const file = join(home, 'jobs', row.job, 'qa', `${id}.md`);
          const buffer = Buffer.alloc(2048);
          let fd: number | undefined;
          let body = '';
          try { fd = fs.openSync(file, 'r'); body = buffer.subarray(0, fs.readSync(fd, buffer, 0, 2048, 0)).toString('utf8'); }
          catch { /* The full-text path remains usable if publication raced this read. */ }
          finally { if (fd !== undefined) fs.closeSync(fd); }
          const q = questionFields(body), one = (s: string) => s.replace(/\s+/g, ' ').trim();
          const tag = body.match(/^# Question q\d+ from (.+)$/m)?.[1] ?? row.role ?? row.job;
          const question = body.replace(/^# Question q\d+ from .*\n/, '')
            .split(/^(?:Options:\s*$|Default if unanswered:|Context:|Answer:)/m, 1)[0];
          return { line: `[${one(tag)}] QUESTION ${id}: ${one(question)}${q.options.length ? ` | options: ${q.options.map(one).join(' / ')}` : ''} | default: ${one(q.suggested)}${q.context ? ` | context: ${one(q.context)}` : ''} | full text: ${file} | reply: hud_respond job=${row.job} request_id=${id}` };
        });
    if (row.land_turn || ((row.workflow || row.batch_flow) && !row.blocked)) return questions;
    if (row.auto_land && !row.auto_land_blocked && !row.blocked &&
        row.display_state !== 'failed' && row.display_state !== 'stopped' &&
        row.state !== 'waiting_orchestrator') return questions;
    if (row.parent_job && settled(row) && row.display_state !== 'failed') return questions;
    // A newly visible row can be old work promoted into the bounded window by retention.
    if (catchup === false && !old && settled(row) && row.notice_mtime + NOTICE_MTIME_SLOP_MS < lastScanAt) return questions;
    let attentionUnread = true;
    if (catchup && (row.blocked || row.display_state === 'failed')) {
      const idx = getJobIndexCache(home), job = idx.readJob(row.job);
      const status = job.status === 'ok' ? idx.readStatus(row.job) : null;
      if (job.status === 'ok' && status && status.status !== 'error')
        attentionUnread = failureUnobserved(join(home, 'jobs', row.job), job.value.observed_at, status.status === 'missing' ? null : status.at);
    }
    const attention = attentionUnread && (row.blocked || row.display_state === 'failed');
    const unread = !row.parent_job && settled(row) && row.report_unread;
    // The mod's first wake folds failures that ended before its cutoff, like old reports: a day-old
    // failure nobody opened (often a worker's child its parent already handled) is history, not news.
    const oldFailure = attention && !row.blocked;
    if (typeof catchup === 'number' && (oldFailure || (unread && !attention)) && settledAt(row.job) < catchup) {
      if (oldFailure) olderFailures++;
      else olderReports++;
      return questions;
    }
    const blockedUnread = Boolean(row.auto_land_blocked && (row.report_unread || !row.report_present));
    const pending = unread || attention || blockedUnread;
    const report = !row.parent_job && row.report_unread && (!old?.report_unread || row.report_mtime !== old.report_mtime);
    const escalation = row.state === 'waiting_orchestrator' && row.open_questions === 0 && (old?.state !== row.state || old.reason !== row.reason);
    const failingChecks = row.checks && row.checks.passed < row.checks.total && checksJustFinished(row, old);
    const autoLandBlocked = Boolean(row.auto_land_blocked && row.auto_land_blocked !== old?.auto_land_blocked);
    const failureOrStop = row.display_state === 'failed' || row.display_state === 'stopped';
    const event = failingChecks || autoLandBlocked || (row.blocked && !old?.blocked) || (row.state !== 'working' && (
      (!old && row.state !== null && row.state !== 'queued' && !questions.length) ||
      (old && settled(row) && !settled(old)) || report || escalation ||
      (failureOrStop && row.display_state !== old?.display_state)
    ));
    if (!(catchup ? pending : event)) return questions;
    const defer = !row.blocked && !failureOrStop && !failingChecks && !escalation && !autoLandBlocked && (settled(row) || report);
    return [...questions, { line: formatJobChange(row), defer, status: row }];
  });
  const older = [
    olderReports && `${olderReports} older unread report${olderReports === 1 ? '' : 's'}`,
    olderFailures && `${olderFailures} older failure${olderFailures === 1 ? '' : 's'}`,
  ].filter(Boolean);
  if (older.length) notices.push({ line: `${older.join(', ')} — hud_read view:compact` });
  return notices;
}

function sonicCheckpointNotices() {
  let seen = new Map<string, string>();
  return (rows: JobRow[], verbose: boolean): string[] => {
    const next = new Map<string, string>();
    const lines = rows.flatMap(row => {
      if (row.workflow || row.batch_flow || row.role !== 'sonic' || row.state !== 'working') return [];
      const checkpoint = row.progress?.filter(p => p.source === 'checkpoint').at(-1);
      const before = seen.get(row.job);
      const at = checkpoint?.at ?? before;
      if (at) next.set(row.job, at);
      return checkpoint && (!before || checkpoint.at > before) && (verbose || !checkpoint.text.startsWith('still working at '))
        ? [`[sonic ${row.job}] ${checkpoint.text}`] : [];
    });
    seen = next;
    return lines;
  };
}

// A fixed window from the first settlement, not a debounce that slides with each arrival.
function settlementNotices(windowMs: number) {
  let held: BatchItem[] = [], deadline = Infinity;
  return {
    get pending() { return held.length > 0; },
    get delay() { return Math.max(0, Math.ceil(deadline - performance.now())); },
    collect(events: Notice[], other: readonly BatchItem[]): BatchItem[][] {
      const ready: BatchItem[][] = [], now = performance.now();
      const flush = (items: readonly BatchItem[] = []) => {
        ready.push(held.concat(items));
        held = [];
        deadline = Infinity;
      };
      if (now >= deadline) flush();
      const items = [...events.map(({ line }) => ({ line })), ...other];
      if (!items.length) return ready;
      if (other.length || events.some(event => !event.defer)) {
        if (held.length || events.some(event => event.defer)) flush(items);
        else ready.push(...items.map(item => [item]));
      } else {
        if (!held.length) deadline = now + windowMs;
        held.push(...items);
      }
      return ready;
    },
  };
}

// Both transports advance the same delivery cursors once per scan, never on the idle/pending probe.
function watchNotices(windowMs: number) {
  const settlements = settlementNotices(windowMs), batches = packageBatches(), checkpoints = sonicCheckpointNotices();
  return {
    collect: settlements.collect,
    get delay() { return Math.min(settlements.delay, batches.delay); },
    get pending() { return settlements.pending || Number.isFinite(batches.delay); },
    select(home: string, prev: ReadonlyMap<string, JobRow>, rows: WatchJobRow[], catchup: boolean | number, lastScanAt: number, verbose = false) {
      const progress = checkpoints(rows, verbose);
      if (verbose && !catchup) return { events: [], progress };
      const events = actionable(home, prev, rows, catchup, lastScanAt);
      return { events: verbose ? events : batches.collect(rows, prev, events), progress };
    },
  };
}

// The CLI and pi both watch the same inputs, including atomic replacements of tries.jsonl.
function watchInputs(home: string, changed: () => void, persistent = true) {
  let homeWatcher: fs.FSWatcher | undefined, flowWatcher: fs.FSWatcher | undefined;
  const jobs = persistent
    ? watchJobChanges(home, (notice) => { if (notice) changed(); }, true)
    : watchJobsInBackground(home, changed);
  let closed = false;
  const attach = () => {
    if (closed) return;
    jobs.attach();
    if (!homeWatcher) try {
      homeWatcher = fs.watch(home, { persistent }, (_event, name) => {
        const file = name?.toString();
        if (file === 'flows') { flowWatcher?.close(); flowWatcher = undefined; attach(); }
        if (!file || file === 'flows' || file === TRIES_FILE || file === PANEL_ACTIONS_FILE) changed();
      });
      homeWatcher.on('error', () => { homeWatcher?.close(); homeWatcher = undefined; });
    } catch { /* No home yet: the rescan retries. */ }
    if (!flowWatcher) try {
      flowWatcher = fs.watch(join(home, 'flows'), { persistent }, (_event, file) => {
        if (!file || file.endsWith('.json')) changed();
      }).on('error', () => { flowWatcher?.close(); flowWatcher = undefined; });
    } catch { /* No flows yet. */ }
  };
  return {
    attach,
    close: () => {
      if (closed) return;
      closed = true;
      homeWatcher?.close();
      flowWatcher?.close();
      jobs.close();
    },
  };
}

/** In-process, pane-scoped quiet events; no CLI signal hooks or transport. */
export function startSessionWatch(home: string, pane: string, cwd: string, deliver: (lines: string[]) => DeliveryOutcome, settlementWindowMs = settlementWindow(process.env)) {
  const tries = new TryLog(home), answers = new PanelActionLog(home);
  let prev = new Map<string, JobRow>();
  let first = true, stopped = false, scanning = false, dirty = false, lastScanAt = -Infinity;
  let timer: ReturnType<typeof setTimeout>;
  const notices = watchNotices(settlementWindowMs);
  const inputs = watchInputs(home, () => {
    if (scanning) dirty = true;
    else schedule(DEBOUNCE_MS);
  }, false);
  function schedule(ms: number) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(scan, Math.min(ms, notices.delay)).unref();
  }
  async function scan() {
    inputs.attach();
    scanning = true;
    dirty = false;
    const scanAt = Date.now();
    try {
      const { rows, panes } = await collectSessionJobRows(home, pane, cwd, process.env);
      if (stopped) return;
      const obligations = await collectObligations(home, pane, cwd, process.env, false, false, panes);
      if (stopped) { release(obligations.events); return; }
      const { events, progress } = notices.select(home, prev, rows, first, lastScanAt);
      const other = [...obligations.events, ...[...tries.changes(cwd),
        ...answers.changes(new Set(rows.map(row => row.job)), cwd, pane), ...progress].map(line => ({ line }))];
      const items = notices.collect(events, other).map(prepare).filter(batch => batch.length);
      first = false;
      lastScanAt = scanAt;
      prev = new Map(rows.map(row => [row.job, row]));
      if (items.length) {
        let outcome: DeliveryOutcome = 'indeterminate';
        try { outcome = deliver(items.map(textOf)); }
        finally { finish(items.flat(), outcome, 'pi-steer'); }
      }
    } catch { /* Retry collection on the next wake. */ }
    finally {
      scanning = false;
      schedule(dirty ? DEBOUNCE_MS : DEFAULT_RESCAN_MS);
    }
  }
  inputs.attach();
  schedule(DEBOUNCE_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
    inputs.close();
  };
}

export interface WatchOptions {
  rescanMs?: number;
  signal?: AbortSignal;
  queueIdleMs?: number;
  settlementWindowMs?: number;
}

export async function watchCommand(
  args: readonly string[],
  io: HudIO,
  options: WatchOptions = {}
): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    await io.stdout(WATCH_HELP);
    return 0;
  }
  let all = false, verbose = false, queue = false, mod = false;
  for (const arg of args) {
    if (arg === '--all') all = true;
    else if (arg === '--verbose') verbose = true;
    else if (arg === '--queue') queue = true;
    else if (arg === '--mod') mod = true;
    else throw new CliError('usage: hud watch [--all] [--verbose] [--queue | --mod]');
  }
  if (mod && (all || verbose || queue)) throw new CliError('--mod requires a single pane and quiet events');
  if (queue && (all || verbose)) throw new CliError('--queue requires a single pane and quiet events');

  // Capture the pane once; the ephemeral PID marker below advertises only this watch.
  const callerPane = herdrId(io.env.HERDR_PANE_ID) ? io.env.HERDR_PANE_ID : null;
  if (!all && !callerPane) {
    io.stderr('no pane found (HERDR_PANE_ID unset); pass --all to watch all jobs\n');
    return 1;
  }
  const home = getHudHome(io.env), tries = new TryLog(home), answers = new PanelActionLog(home);
  if (callerPane) void reportMainPaneGroup(process.cwd(), io.env, home);
  // A sleeping mod resumes its two log readers at the last completed scan, not the new EOF.
  const modHandshake = mod && io.env.HUD_MOD_CURSOR !== undefined;
  let freshMod = mod;
  if (modHandshake) {
    const [t, a] = (io.env.HUD_MOD_CURSOR ?? '').split(':').map(Number);
    if (Number.isSafeInteger(t) && t >= 0 && Number.isSafeInteger(a) && a >= 0) {
      tries.delivered = t;
      answers.offset = a;
      freshMod = false;
    }
  }
  if (freshMod) tries.seekEnd();
  const readBand = modHandshake ? bandReader(process.cwd(), home, io.env) : undefined;
  const lastDelivery = Number(io.env.HUD_MOD_LAST_DELIVERY);
  const queueIdleMs = options.queueIdleMs ?? 10 * 60_000;
  const rescanMs = Math.max(50, Math.min(options.rescanMs ?? DEFAULT_RESCAN_MS, queue || mod ? queueIdleMs : Infinity));
  const delivery = queue ? await import(new URL('../../packages/hud-mcp/bin/hud-notify.mjs', import.meta.url).href) : null;
  if (options.signal?.aborted) return 0;
  const controller = new AbortController(), { signal } = controller;
  let idleSince: number | null = null;
  const notices = watchNotices(options.settlementWindowMs ?? settlementWindow(io.env));
  const inputs = watchInputs(home, changed);
  function changed() {
    // A change during a scan is kept for the next wait, never lost until the rescan.
    dirty = true;
    if (wakeWait === undefined) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(fire, Math.min(DEBOUNCE_MS, notices.delay));
  }
  let stopPaneWatch: (() => void) | undefined;
  let retryAt = Infinity;
  let flowRetryAt = Infinity;
  const waitForPrompt = () => {
    retryAt = performance.now() + PROMPT_QUIET_MS;
    stopPaneWatch ??= watchHerdrPane(callerPane!, io.env, changed, stop);
  };
  const noPendingPrompt = () => {
    retryAt = Infinity;
    stopPaneWatch?.();
    stopPaneWatch = undefined;
  };

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wakeWait: (() => void) | undefined;
  let dirty = false;
  const fire = () => {
    timer = undefined;
    const wake = wakeWait;
    wakeWait = undefined;
    wake?.();
  };
  const stop = () => {
    stopped = true;
    controller.abort();
    inputs.close();
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const wake = wakeWait;
    wakeWait = undefined;
    wake?.();
  };
  const onStdoutError = (error: unknown) => {
    if (isBrokenPipe(error)) stop();
  };

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // Leave SIGPIPE ignored by Node: removing its last listener resets it to SIG_DFL.
  process.stdout?.on('error', onStdoutError);
  options.signal?.addEventListener('abort', stop, { once: true });

  const wait = () =>
    new Promise<void>((resolve) => {
      if (stopped) return resolve();
      wakeWait = resolve;
      inputs.attach();
      timer = setTimeout(fire, Math.min(dirty ? DEBOUNCE_MS : rescanMs, notices.delay, Math.max(0, Math.min(retryAt, flowRetryAt) - performance.now())));
    });

  const pidFile = !all && callerPane ? join(home, 'watchers', `${callerPane}.pid`) : null;
  let unregister: (() => void) | undefined;
  const cleanup = () => {
    if (mod) return unregister?.();
    if (pidFile) {
      try { if (fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidFile); } catch { /* gone */ }
    }
  };
  process.once('exit', cleanup);
  try {
    if (mod) {
      unregister = registerWatcher(callerPane!, home, 'claude-mod');
      if (!unregister) throw new Error('could not register Claude mod watcher');
    } else if (pidFile) {
      writePrivateFile(pidFile, `${process.pid}\n`);
    }
    // Attach before catch-up so events during the scan are not lost.
    inputs.attach();
    let prev = new Map<string, JobRow>();
    let first = true, lastScanAt = -Infinity, modStartedAt: number | false = false;
    let queueAgent: 'codex' | 'agy' | undefined;
    let agyBacklog: BatchItem[] = [], agyGuardUntil: number | undefined;
    let typedPending: { retry: NonNullable<NotifyResult['retryPrompt']>; items: BatchItem[]; until: number } | undefined;
    const retryReleased = (items: BatchItem[]) => {
      if (!items.some(item => item.marker)) return;
      idleSince = null;
      flowRetryAt = performance.now() + Math.min(rescanMs, PROMPT_QUIET_MS);
    };
    const bufferAgain = (items: BatchItem[]) => items.filter(item => !item.marker || revertDeliveryClaim(item));
    try {
    while (!stopped) {
      if (!first) await wait();
      if (stopped) break;
      dirty = false;
      if (performance.now() >= flowRetryAt) flowRetryAt = Infinity;
      const pane = queue ? await delivery!.paneInfo(callerPane, io.env, { signal }) : null;
      if (stopped) break;
      if (queue) {
        const agent = pane?.agent;
        if ((agent !== 'codex' && agent !== 'agy') || (queueAgent && queueAgent !== agent)) break;
        queueAgent = agent;
      }
      const agyPending = queueAgent === 'agy' && delivery!.hasAgyEvents(callerPane, home);
      const scanAt = Date.now();
      const { rows, panes } = all ? { rows: readThinJobRows(home, { pane: null }), panes: undefined }
        : await readSessionJobRows(home, callerPane!, process.cwd(), io.env);
      if (stopped) break;
      // The owner's answers from the panel are events of the jobs this watch follows, never catch-up: the question is gone.
      const modCatchup = first && freshMod;
      if (modCatchup) modStartedAt = scanAt;
      const obligations = await collectObligations(home, callerPane, process.cwd(), io.env, all, modStartedAt, panes);
      if (stopped) { release(obligations.events); break; }
      const trySize = modHandshake ? fs.lstatSync(join(home, TRIES_FILE), { throwIfNoEntry: false })?.size ?? 0 : 0;
      const modCutoff = Number.isSafeInteger(lastDelivery) && lastDelivery > 0 && lastDelivery <= scanAt
        ? lastDelivery : scanAt - MOD_REPORT_LOOKBACK_MS;
      const { events, progress } = notices.select(home, prev, rows, first && mod ? modCutoff : first, lastScanAt, verbose);
      const otherItems = [...[...tries.changes(queue || mod ? process.cwd() : undefined),
        ...answers.changes(new Set(rows.map(row => row.job)), all ? undefined : process.cwd(), callerPane ?? undefined)].map(line => ({ line })),
        ...obligations.events, ...(modCatchup ? [] : progress.map(line => ({ line })))];
      // Release the mod's first HUD call only after capturing its pre-call baseline.
      if (first && modHandshake) await io.stdout('{"type":"ready"}\n');
      const band = readBand && await readBand(scanAt);
      if (band) await io.stdout(JSON.stringify(band) + '\n');
      if (queue || mod) {
        const pending = (mod && events.length > 0) || obligations.pending || agyPending || agyBacklog.length > 0 || typedPending !== undefined || Number.isFinite(flowRetryAt) || notices.pending || otherItems.length > 0 || rows.some((row) => !row.ticket_queue && !row.workflow && !row.batch_flow && (row.open_questions || (!row.land_turn && (!settled(row) || (!row.parent_job && row.report_unread && (!row.auto_land || Boolean(row.auto_land_blocked))) || row.checks?.state === 'running')))) ||
          actionable(home, new Map(), rows, true).length > 0;
        if (pending) idleSince = null;
        else {
          idleSince ??= Date.now();
          if (Date.now() - idleSince >= queueIdleMs) {
            if (modHandshake) await io.stdout(JSON.stringify({ type: 'sleep', cursor: `${tries.delivered}:${answers.offset}`, sizes: [trySize, answers.offset] }) + '\n');
            break;
          }
        }
      }
      let batches: BatchItem[][] = verbose
        ? [...(first ? events.map(e => e.line) : jobChanges(prev, rows)).map(line => [{ line }]), ...otherItems.map(item => [item])]
        : notices.collect(events, otherItems);
      first = false;
      lastScanAt = scanAt;
      prev = new Map(rows.map(row => [row.job, row]));
      if (queueAgent === 'agy') {
        for (const item of batches.flat()) {
          if (item.marker) agyBacklog.push(item);
          else for (const line of item.line.split('\n')) agyBacklog.push({ line });
        }
        if (stopped) break;
        if (!agyPending) agyGuardUntil = undefined;
        if (agyGuardUntil && performance.now() >= agyGuardUntil) {
          recordPromptExpiry(home);
          agyGuardUntil = 0;
        }
        const sending = prepare(agyBacklog);
        agyBacklog = [];
        if (!sending.length && !agyPending) { noPendingPrompt(); continue; }
        // Acknowledge the mailbox before waiting on the prompt; only overflow or a pre-write failure can retry.
        let acknowledged = false;
        const published = (accepted: number) => {
          acknowledged = true;
          finish(sending.slice(0, accepted), 'sent', 'agy-mailbox');
          agyBacklog = bufferAgain(sending.slice(accepted));
        };
        const sent = await delivery!.notifyAgy(callerPane, sending.map(item => item.line), home, io.env, agyGuardUntil === 0 ? null : pane, { signal, published });
        if (!acknowledged) published(sent.accepted);
        if (sent.guardPending && !stopped) {
          agyGuardUntil ??= performance.now() + PROMPT_RETRY_TTL_MS;
          waitForPrompt();
        } else noPendingPrompt();
        if (sent.status !== 0) io.stderr(`${sent.detail || sent.error?.message || 'Antigravity event delivery failed; will retry'}\n`);
        continue;
      }
      const fallback = typedPending;
      typedPending = undefined;
      const retry = fallback && performance.now() < fallback.until ? fallback.retry : undefined;
      if (fallback) {
        noPendingPrompt();
        if (retry) batches = [appendBuffered(fallback.items, batches.flat())];
        else {
          recordPromptExpiry(home);
          release(fallback.items);
          retryReleased(fallback.items);
        }
      }
      for (const [i, batch] of batches.entries()) {
        if (stopped) { release(batches.slice(i).flat()); break; }
        const items = prepare(batch);
        if (!items.length) continue;
        const line = textOf(items), via = queue ? (retry ? 'herdr-prompt' : 'codex-queue') : mod ? 'claude-mod' : 'watch-stdout';
        try {
          if (queue) {
            const sent: NotifyResult = retry ? await retry(line, signal)
              : await delivery!.notify(callerPane, line, home, { queue: true, env: io.env, signal });
            const outcome = notifyOutcome(sent);
            if (!stopped && outcome === 'refused' && sent.retryPrompt) {
              typedPending = { retry: sent.retryPrompt, items: appendBuffered(bufferAgain(items), batches.slice(i + 1).flat()),
                until: retry ? fallback!.until : performance.now() + PROMPT_RETRY_TTL_MS };
              waitForPrompt();
              break;
            }
            finish(items, outcome, sent.via ?? via, sent.detail || sent.error?.message);
            if (outcome === 'refused') retryReleased(items);
            if (!stopped && (sent.detail?.includes('failed') || sent.status !== 0)) io.stderr(`${sent.detail || 'event delivery failed'}\n`);
          } else {
            const at = i === batches.length - 1 && !notices.pending ? scanAt : undefined;
            const wakeLines = line.startsWith('[HUD selection]\n') ? [line] : line.split('\n');
            await io.stdout(mod ? JSON.stringify({ type: 'wake', lines: wakeLines, at }) + '\n' : `${line}\n`);
            finish(items, 'sent', via);
          }
        } catch (error) {
          finish(items, !queue && isBrokenPipe(error) ? 'refused' : 'indeterminate', via, String(error));
          release(batches.slice(i + 1).flat());
          throw error;
        }
      }
    }
    } finally {
      release(typedPending?.items ?? []);
      release(agyBacklog);
    }
    return 0;
  } catch (error) {
    if (isBrokenPipe(error)) return 0;
    throw error;
  } finally {
    noPendingPrompt();
    cleanup();
    process.off('exit', cleanup);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    process.stdout?.off('error', onStdoutError);
    options.signal?.removeEventListener('abort', stop);
    if (timer !== undefined) clearTimeout(timer);
    inputs.close();
  }
}
