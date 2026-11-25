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
import { landEvents } from '../mcp/land-state.js';
import { registerWatcher } from '../roles/notify.js';
import { herdrId } from '../roles/herdr-run.js';
import { getJobIndexCache } from '../roles/job-index-cache.js';
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
    if (row.ticket_queue) return [];
    const old = prev.get(row.job);
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
    const pending = unread || attention;
    const report = !row.parent_job && row.report_unread && (!old?.report_unread || row.report_mtime !== old.report_mtime);
    const escalation = row.state === 'waiting_orchestrator' && !row.open_questions && (old?.state !== row.state || old.reason !== row.reason);
    const failingChecks = row.checks && row.checks.passed < row.checks.total && checksJustFinished(row, old);
    const failureOrStop = row.display_state === 'failed' || row.display_state === 'stopped';
    const event = failingChecks || (row.blocked && !old?.blocked) || (row.state !== 'working' && (
      (!old && row.state !== null && row.state !== 'queued' && !questions.length) ||
      (old && settled(row) && !settled(old)) || report || escalation ||
      (failureOrStop && row.display_state !== old?.display_state)
    ));
    if (!(catchup ? pending : event)) return questions;
    const defer = !row.blocked && !failureOrStop && !failingChecks && !escalation && (settled(row) || report);
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
  let held: string[] = [], deadline = Infinity;
  return {
    get pending() { return held.length > 0; },
    get delay() { return Math.max(0, Math.ceil(deadline - performance.now())); },
    collect(events: Notice[], other: string[]): string[] {
      const ready: string[] = [], now = performance.now();
      const flush = (lines: string[] = []) => {
        ready.push(held.concat(lines).join('\n'));
        held = [];
        deadline = Infinity;
      };
      if (now >= deadline) flush();
      const lines = events.map((event) => event.line).concat(other);
      if (!lines.length) return ready;
      if (other.length || events.some((event) => !event.defer)) {
        if (held.length || events.some((event) => event.defer)) flush(lines);
        else ready.push(...lines);
      } else {
        if (!held.length) deadline = now + windowMs;
        held.push(...lines);
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
export function startSessionWatch(home: string, pane: string, cwd: string, deliver: (lines: string[]) => void, settlementWindowMs = settlementWindow(process.env)) {
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
    let rows;
    try { rows = await collectSessionJobRows(home, pane, cwd, process.env); }
    catch { if (!stopped) schedule(DEFAULT_RESCAN_MS); return; }
    finally { scanning = false; }
    if (stopped) return;
    const { events, progress } = notices.select(home, prev, rows, first, lastScanAt);
    const lines = notices.collect(events, [...tries.changes(cwd), ...answers.changes(new Set(rows.map((row) => row.job)), cwd), ...landEvents(home, pane, false, cwd).lines, ...progress]);
    first = false;
    lastScanAt = scanAt;
    prev = new Map(rows.map((row) => [row.job, row]));
    schedule(dirty ? DEBOUNCE_MS : DEFAULT_RESCAN_MS);
    if (lines.length) deliver(lines);
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
  const inputs = watchInputs(home, () => {
    // A change during a scan is kept for the next wait, never lost until the rescan.
    dirty = true;
    if (wakeWait === undefined) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(fire, Math.min(DEBOUNCE_MS, notices.delay));
  });

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
      timer = setTimeout(fire, Math.min(dirty ? DEBOUNCE_MS : rescanMs, notices.delay));
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
    let first = true, lastScanAt = -Infinity;
    let queueAgent: 'codex' | 'agy' | undefined;
    const agyBacklog: string[] = [];
    while (!stopped) {
      if (!first) await wait();
      if (stopped) break;
      dirty = false;
      const pane = queue ? await delivery!.paneInfo(callerPane, io.env, { signal }) : null;
      if (stopped) break;
      if (queue) {
        const agent = pane?.agent;
        if ((agent !== 'codex' && agent !== 'agy') || (queueAgent && queueAgent !== agent)) break;
        queueAgent = agent;
      }
      const agyPending = queueAgent === 'agy' && delivery!.hasAgyEvents(callerPane, home);
      const scanAt = Date.now();
      const rows = all ? readThinJobRows(home, { pane: null }) : await readSessionJobRows(home, callerPane!, process.cwd(), io.env);
      if (stopped) break;
      // The owner's answers from the panel are events of the jobs this watch follows, never catch-up: the question is gone.
      const modCatchup = first && freshMod;
      const flows = landEvents(home, callerPane, all, process.cwd(), modCatchup);
      const trySize = modHandshake ? fs.lstatSync(join(home, TRIES_FILE), { throwIfNoEntry: false })?.size ?? 0 : 0;
      const modCutoff = Number.isSafeInteger(lastDelivery) && lastDelivery > 0 && lastDelivery <= scanAt
        ? lastDelivery : scanAt - MOD_REPORT_LOOKBACK_MS;
      const { events, progress } = notices.select(home, prev, rows, first && mod ? modCutoff : first, lastScanAt, verbose);
      const tryLines = [...tries.changes(queue || mod ? process.cwd() : undefined), ...answers.changes(new Set(rows.map((row) => row.job)), all ? undefined : process.cwd()), ...flows.lines, ...(modCatchup ? [] : progress)];
      // Release the mod's first HUD call only after capturing its pre-call baseline.
      if (first && modHandshake) await io.stdout('{"type":"ready"}\n');
      const band = readBand && await readBand(scanAt);
      if (band) await io.stdout(JSON.stringify(band) + '\n');
      if (queue || mod) {
        const pending = (mod && events.length > 0) || flows.pending || agyPending || agyBacklog.length > 0 || notices.pending || tryLines.length > 0 || rows.some((row) => !row.ticket_queue && !row.workflow && !row.batch_flow && (row.open_questions || (!row.land_turn && (!settled(row) || (!row.parent_job && row.report_unread) || row.checks?.state === 'running')))) ||
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
      const lines = verbose
        ? (first ? events.map((event) => event.line) : jobChanges(prev, rows)).concat(tryLines)
        : notices.collect(events, tryLines);
      first = false;
      lastScanAt = scanAt;
      prev = new Map(rows.map((row) => [row.job, row]));
      if (queueAgent === 'agy') {
        for (const batch of lines) for (const line of batch.split('\n')) agyBacklog.push(line);
        // A regular filesystem wake or safety rescan also flushes old events
        // when the caller returns to its prompt without any new job events.
        if (!stopped && (agyBacklog.length || agyPending)) {
          const sent = await delivery!.notifyAgy(callerPane, agyBacklog, home, io.env, pane, { signal });
          if (stopped) break;
          agyBacklog.splice(0, sent.accepted);
          if (sent.status !== 0) io.stderr(`${sent.detail || sent.error?.message || 'Antigravity event delivery failed; will retry'}\n`);
        }
        continue;
      }
      const batches = first && mod && lines.length ? [lines.join('\n')] : lines;
      for (const [i, line] of batches.entries()) {
        if (stopped) break;
        try {
          if (queue) {
            const sent = await delivery!.notify(callerPane, line, home, { queue: true, env: io.env, signal });
            if (stopped) break;
            if (sent.detail?.includes('failed') || sent.status !== 0) io.stderr(`${sent.detail || 'event delivery failed'}\n`);
          } else if (mod) {
            // Checkpoint only after the whole scan's batch, and leave changes racing the scan eligible on reload.
            const at = i === batches.length - 1 && !notices.pending ? scanAt : undefined;
            await io.stdout(JSON.stringify({ type: 'wake', lines: line.split('\n'), at }) + '\n');
          } else await io.stdout(`${line}\n`);
        } catch (error) {
          if (isBrokenPipe(error)) {
            stop();
            break;
          }
          throw error;
        }
      }
    }
    return 0;
  } catch (error) {
    if (isBrokenPipe(error)) return 0;
    throw error;
  } finally {
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
