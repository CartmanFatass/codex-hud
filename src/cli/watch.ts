/** `hud watch`: push only actionable events; --verbose retains the MCP change stream. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { formatJobChange, jobChanges, readThinJobRows, type JobRow } from '../collectors/thin-jobs.js';
import { questionFields } from '../collectors/work-artifacts.js';
import { TRIES_FILE, TryLog } from '../collectors/try-records.js';
import { PANEL_ACTIONS_FILE, PanelActionLog } from '../collectors/panel-actions.js';
import { getHudHome } from '../hud-home.js';
import { herdrId } from '../roles/herdr-run.js';
import type { HudIO } from './hud.js';
import { CliError } from './private-home.js';

export const WATCH_HELP =
  'Usage: hud watch [--all] [--verbose] [--queue]\n' +
  'Stream pending questions and actionable job events for the caller pane (HERDR_PANE_ID), plus project try records.\n' +
  '--all: every pane; --verbose: every change, as in MCP changes.\n' +
  '--queue: deliver quietly through the Codex caller queue (typed fallback on failure).\n';

// Woken by file changes under jobs/; the slow rescan only covers a watch lost or not yet attachable.
const DEFAULT_RESCAN_MS = 30_000;
const DEBOUNCE_MS = 50;

const isBrokenPipe = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED';
};

const settled = (row: JobRow) => ['idle_grace', 'closed', 'done', 'failed', 'stopped'].includes(row.state ?? '');
function actionable(home: string, prev: ReadonlyMap<string, JobRow>, rows: JobRow[], catchup = false): string[] {
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
          return `[${one(tag)}] QUESTION ${id}: ${one(q.question).slice(0, 400)}${q.options.length ? ` | options: ${q.options.map(one).join(' / ')}` : ''} | default: ${one(q.suggested)} | full text: ${file} | reply: hud_respond job=${row.job} request_id=${id}`;
        });
    if (row.parent_job && settled(row) && row.display_state !== 'failed') return questions;
    let attentionUnread = true;
    if (catchup && (row.blocked || row.display_state === 'failed')) {
      const dir = join(home, 'jobs', row.job);
      try {
        const observed = Date.parse(JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8')).observed_at);
        attentionUnread = !Number.isFinite(observed) || fs.statSync(join(dir, 'STATUS.json')).mtimeMs > observed;
      } catch { /* unread */ }
    }
    const pending = (!row.parent_job && settled(row) && row.report_unread) || (attentionUnread && (row.blocked || row.display_state === 'failed'));
    const event = (row.blocked && !old?.blocked) || (row.state !== 'working' && (
      (!old && row.state !== null && !questions.length) ||
      (old && settled(row) && !settled(old)) ||
      (!row.parent_job && row.report_unread && (!old?.report_unread || row.report_mtime !== old.report_mtime)) ||
      (row.parent_job && row.display_state === 'failed' && old?.display_state !== 'failed') ||
      (row.state === 'waiting_orchestrator' && !row.open_questions && (old?.state !== row.state || old.reason !== row.reason))
    ));
    return [...questions, ...((catchup ? pending : event) ? [formatJobChange(row)] : [])];
  });
}

export interface WatchOptions {
  rescanMs?: number;
  signal?: AbortSignal;
  queueIdleMs?: number;
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
  const scope = { pane: all ? null : callerPane };
  const home = getHudHome(io.env), tries = new TryLog(home), answers = new PanelActionLog(home);
  const queueIdleMs = options.queueIdleMs ?? 10 * 60_000;
  const rescanMs = Math.max(50, Math.min(options.rescanMs ?? DEFAULT_RESCAN_MS, queue ? queueIdleMs : Infinity));
  const delivery = queue ? await import(new URL('../../packages/hud-mcp/bin/hud-notify.mjs', import.meta.url).href) : null;
  let idleSince: number | null = null;
  let watcher: fs.FSWatcher | undefined, homeWatcher: fs.FSWatcher | undefined;
  const changed = () => {
    // A change during a scan is kept for the next wait, never lost until the rescan.
    dirty = true;
    if (wakeWait === undefined) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(fire, DEBOUNCE_MS);
  };
  const attach = () => {
    if (!homeWatcher) try {
      homeWatcher = fs.watch(home, (_event, name) => {
        const file = name?.toString();
        if (file === 'jobs' && !watcher) { attach(); changed(); }
        if (file === TRIES_FILE || file === PANEL_ACTIONS_FILE) changed();
      });
      homeWatcher.on('error', () => { homeWatcher?.close(); homeWatcher = undefined; });
    } catch { /* No home yet: the rescan retries. */ }
    if (watcher) return;
    try {
      // One recursive watch covers every job's STATUS.json, report.md and qa/ (Node 24 on Linux).
      watcher = fs.watch(join(home, 'jobs'), { recursive: true }, (_event, name) => {
        const file = name?.toString() ?? '';
        if (file.endsWith('.tmp') || file.endsWith('supervisor.pid') || file.includes('/sessions/')) return;
        changed();
      });
    } catch { return; /* The home watch or next rescan will retry. */ }
    watcher.on('error', () => { watcher?.close(); watcher = undefined; });
  };

  let stopped = Boolean(options.signal?.aborted);
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
    homeWatcher?.close();
    watcher?.close();
    watcher = undefined;
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
      attach();
      timer = setTimeout(fire, dirty ? DEBOUNCE_MS : rescanMs);
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
    attach();
    let prev = new Map<string, JobRow>();
    let first = true;
    while (!stopped) {
      if (!first) await wait();
      if (stopped) break;
      dirty = false;
      if (queue && delivery!.paneInfo(callerPane, io.env)?.agent !== 'codex') break;
      const rows = readThinJobRows(home, scope);
      // The owner's answers from the panel are events of the jobs this watch follows, never catch-up: the question is gone.
      const tryLines = [...tries.changes(queue ? process.cwd() : undefined), ...answers.changes(new Set(rows.map((row) => row.job)))];
      if (queue) {
        const pending = tryLines.length > 0 || rows.some((row) => !settled(row) || (!row.parent_job && row.report_unread) || row.open_questions) ||
          actionable(home, new Map(), rows, true).length > 0;
        if (pending) idleSince = null;
        else {
          idleSince ??= Date.now();
          if (Date.now() - idleSince >= queueIdleMs) break;
        }
      }
      const lines = first ? actionable(home, prev, rows, true) : verbose ? jobChanges(prev, rows) : actionable(home, prev, rows);
      lines.push(...tryLines);
      first = false;
      prev = new Map(rows.map((row) => [row.job, row]));
      for (const line of lines) {
        if (stopped) break;
        try {
          if (queue) {
            const sent = delivery!.notify(callerPane, line, home, { queue: true, env: io.env });
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
    homeWatcher?.close();
    watcher?.close();
  }
}
