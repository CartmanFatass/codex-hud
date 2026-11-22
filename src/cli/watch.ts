/** `hud watch`: push only actionable events; --verbose retains the MCP change stream. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { checksJustFinished, formatJobChange, jobChanges, readSessionJobRows, readThinJobRows, type JobRow } from '../collectors/thin-jobs.js';
import { questionFields } from '../collectors/work-artifacts.js';
import { TRIES_FILE, TryLog } from '../collectors/try-records.js';
import { PANEL_ACTIONS_FILE, PanelActionLog } from '../collectors/panel-actions.js';
import { getHudHome } from '../hud-home.js';
import { landEvents } from '../mcp/land-state.js';
import { herdrId } from '../roles/herdr-run.js';
import type { HudIO } from './hud.js';
import { CliError } from './private-home.js';

export const WATCH_HELP =
  'Usage: hud watch [--all] [--verbose] [--queue]\n' +
  'Stream pending questions and actionable job events for the caller pane (HERDR_PANE_ID), plus project try records.\n' +
  '--all: every pane; --verbose: every change, as in MCP changes.\n' +
  '--queue: deliver through the Codex queue (typed fallback on failure) or Antigravity hook/idle prompt.\n';

// Woken by file changes under jobs/; the slow rescan only covers a watch lost or not yet attachable.
const DEFAULT_RESCAN_MS = 30_000;
const DEBOUNCE_MS = 50;
const SETTLEMENT_WINDOW_MS = 3000;

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
type Notice = { line: string; defer?: boolean };
function actionable(home: string, prev: ReadonlyMap<string, JobRow>, rows: JobRow[], catchup = false): Notice[] {
  return rows.flatMap((row) => {
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
    if (row.parent_job && settled(row) && row.display_state !== 'failed') return questions;
    let attentionUnread = true;
    if (catchup && (row.blocked || row.display_state === 'failed')) {
      const dir = join(home, 'jobs', row.job);
      try {
        const observed = Date.parse(JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8')).observed_at);
        // Failed dispatch may have only a job receipt. Compare timestamps at receipt precision.
        const status = fs.statSync(join(dir, 'STATUS.json'), { throwIfNoEntry: false });
        attentionUnread = !Number.isFinite(observed) || (status !== undefined && Math.floor(status.mtimeMs) > observed);
      } catch { /* unread */ }
    }
    const pending = (!row.parent_job && settled(row) && row.report_unread) || (attentionUnread && (row.blocked || row.display_state === 'failed'));
    const report = !row.parent_job && row.report_unread && (!old?.report_unread || row.report_mtime !== old.report_mtime);
    const escalation = row.state === 'waiting_orchestrator' && !row.open_questions && (old?.state !== row.state || old.reason !== row.reason);
    const checks = checksJustFinished(row, old);
    const event = checks || (row.blocked && !old?.blocked) || (row.state !== 'working' && (
      (!old && row.state !== null && !questions.length) ||
      (old && settled(row) && !settled(old)) || report || escalation ||
      (row.parent_job && row.display_state === 'failed' && old?.display_state !== 'failed')
    ));
    if (!(catchup ? pending : event)) return questions;
    const defer = !row.blocked && row.display_state !== 'failed' && !escalation && (settled(row) || report || checks);
    return [...questions, { line: formatJobChange(row), defer }];
  });
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

// The CLI and pi both watch the same inputs, including atomic replacements of tries.jsonl.
function watchInputs(home: string, changed: () => void, persistent = true) {
  let watcher: fs.FSWatcher | undefined, homeWatcher: fs.FSWatcher | undefined, flowWatcher: fs.FSWatcher | undefined;
  let closed = false;
  const attach = () => {
    if (closed) return;
    if (!homeWatcher) try {
      homeWatcher = fs.watch(home, { persistent }, (event, name) => {
        const file = name?.toString();
        if (file === 'jobs' && event === 'rename') {
          watcher?.close();
          watcher = undefined;
          attach();
        }
        if (file === 'flows') { flowWatcher?.close(); flowWatcher = undefined; attach(); }
        if (!file || file === 'flows' || file === 'jobs' || file === TRIES_FILE || file === PANEL_ACTIONS_FILE) changed();
      });
      homeWatcher.on('error', () => { homeWatcher?.close(); homeWatcher = undefined; });
    } catch { /* No home yet: the rescan retries. */ }
    if (!flowWatcher) try {
      flowWatcher = fs.watch(join(home, 'flows'), { persistent }, (_event, file) => {
        if (!file || file.endsWith('.json')) changed();
      }).on('error', () => { flowWatcher?.close(); flowWatcher = undefined; });
    } catch { /* No flows yet. */ }
    if (watcher) return;
    try {
      // One recursive watch covers every job's STATUS.json, report.md and qa/ (Node 24 on Linux).
      const jobs = fs.watch(join(home, 'jobs'), { recursive: true, persistent }, (_event, name) => {
        const file = name?.toString() ?? '';
        if (file.endsWith('.tmp') || file.endsWith('supervisor.pid') || file.endsWith('/progress.jsonl') ||
          file.endsWith('/report-meta.json') || file.includes('/sessions/')) return;
        changed();
      });
      watcher = jobs;
      jobs.on('error', () => { jobs.close(); if (watcher === jobs) watcher = undefined; });
    } catch { /* The home watch or next rescan will retry. */ }
  };
  return {
    attach,
    close: () => {
      if (closed) return;
      closed = true;
      homeWatcher?.close();
      flowWatcher?.close();
      watcher?.close();
    },
  };
}

/** In-process, pane-scoped quiet events; no CLI signal hooks or transport. */
export function startSessionWatch(home: string, pane: string, cwd: string, deliver: (lines: string[]) => void, settlementWindowMs = settlementWindow(process.env)) {
  const tries = new TryLog(home), answers = new PanelActionLog(home);
  let prev = new Map<string, JobRow>();
  let first = true, stopped = false, scanning = false, dirty = false;
  let timer: ReturnType<typeof setTimeout>;
  const notices = settlementNotices(settlementWindowMs);
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
    const rows = await readSessionJobRows(home, pane, cwd, process.env);
    scanning = false;
    if (stopped) return;
    const lines = notices.collect(actionable(home, prev, rows, first), [...tries.changes(cwd), ...answers.changes(new Set(rows.map((row) => row.job))), ...landEvents(home, pane, false, cwd).lines]);
    first = false;
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
  let all = false, verbose = false, queue = false;
  for (const arg of args) {
    if (arg === '--all') all = true;
    else if (arg === '--verbose') verbose = true;
    else if (arg === '--queue') queue = true;
    else throw new CliError('usage: hud watch [--all] [--verbose] [--queue]');
  }
  if (queue && (all || verbose)) throw new CliError('--queue requires a single pane and quiet events');

  // Capture the pane once; the ephemeral PID marker below advertises only this watch.
  const callerPane = herdrId(io.env.HERDR_PANE_ID) ? io.env.HERDR_PANE_ID : null;
  if (!all && !callerPane) {
    io.stderr('no pane found (HERDR_PANE_ID unset); pass --all to watch all jobs\n');
    return 1;
  }
  const home = getHudHome(io.env), tries = new TryLog(home), answers = new PanelActionLog(home);
  const queueIdleMs = options.queueIdleMs ?? 10 * 60_000;
  const rescanMs = Math.max(50, Math.min(options.rescanMs ?? DEFAULT_RESCAN_MS, queue ? queueIdleMs : Infinity));
  const delivery = queue ? await import(new URL('../../packages/hud-mcp/bin/hud-notify.mjs', import.meta.url).href) : null;
  if (options.signal?.aborted) return 0;
  const controller = new AbortController(), { signal } = controller;
  let idleSince: number | null = null;
  const notices = settlementNotices(options.settlementWindowMs ?? settlementWindow(io.env));
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
  const cleanup = () => {
    if (pidFile) {
      try { if (fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidFile); } catch { /* gone */ }
    }
  };
  process.once('exit', cleanup);
  try {
    if (pidFile) {
      fs.mkdirSync(join(home, 'watchers'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });
    }
    // Attach before catch-up so events during the scan are not lost.
    inputs.attach();
    let prev = new Map<string, JobRow>();
    let first = true;
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
      const rows = all ? readThinJobRows(home, { pane: null }) : await readSessionJobRows(home, callerPane!, process.cwd(), io.env);
      if (stopped) break;
      // The owner's answers from the panel are events of the jobs this watch follows, never catch-up: the question is gone.
      const flows = landEvents(home, callerPane, all);
      const tryLines = [...tries.changes(queue ? process.cwd() : undefined), ...answers.changes(new Set(rows.map((row) => row.job))), ...flows.lines];
      if (queue) {
        const pending = flows.pending || agyPending || agyBacklog.length > 0 || notices.pending || tryLines.length > 0 || rows.some((row) => !settled(row) || (!row.parent_job && row.report_unread) || row.open_questions || row.checks?.state === 'running') ||
          actionable(home, new Map(), rows, true).length > 0;
        if (pending) idleSince = null;
        else {
          idleSince ??= Date.now();
          if (Date.now() - idleSince >= queueIdleMs) break;
        }
      }
      const events = first || !verbose ? actionable(home, prev, rows, first) : [];
      const lines = verbose
        ? (first ? events.map((event) => event.line) : jobChanges(prev, rows)).concat(tryLines)
        : notices.collect(events, tryLines);
      first = false;
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
      for (const line of lines) {
        if (stopped) break;
        try {
          if (queue) {
            const sent = await delivery!.notify(callerPane, line, home, { queue: true, env: io.env, signal });
            if (stopped) break;
            if (sent.detail?.includes('failed') || sent.status !== 0) io.stderr(`${sent.detail || 'event delivery failed'}\n`);
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
