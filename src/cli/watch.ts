/** `hud watch [--all]`: stream one `jobChanges` line per job change with zero writes. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { jobChanges, readThinJobRows, type JobRow } from '../collectors/thin-jobs.js';
import { getHudHome } from '../hud-home.js';
import { herdrId } from '../roles/herdr-run.js';
import type { HudIO } from './hud.js';
import { CliError } from './private-home.js';

export const WATCH_HELP =
  'Usage: hud watch [--all]\n' +
  'Stream job state change lines for the caller pane (HERDR_PANE_ID), or all jobs with --all.\n';

// Woken by file changes under jobs/; the slow rescan only covers a watch lost or not yet attachable.
const DEFAULT_RESCAN_MS = 30_000;
const DEBOUNCE_MS = 50;

const isBrokenPipe = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED';
};

export interface WatchOptions {
  rescanMs?: number;
  signal?: AbortSignal;
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
  let all = false;
  for (const arg of args) {
    if (arg === '--all') all = true;
    else throw new CliError('usage: hud watch [--all]');
  }

  // Capture caller's pane once at start from HERDR_PANE_ID; never persisted.
  const callerPane = herdrId(io.env.HERDR_PANE_ID) ? io.env.HERDR_PANE_ID : null;
  if (!all && !callerPane) {
    io.stderr('no pane found (HERDR_PANE_ID unset); pass --all to watch all jobs\n');
    return 1;
  }
  const scope = { pane: all ? null : callerPane };
  const home = getHudHome(io.env);
  const rescanMs = Math.max(50, options.rescanMs ?? DEFAULT_RESCAN_MS);
  let watcher: fs.FSWatcher | undefined;
  const attach = () => {
    if (watcher) return;
    try {
      // One recursive watch covers every job's STATUS.json, report.md and qa/ (Node 24 on Linux).
      watcher = fs.watch(join(home, 'jobs'), { recursive: true }, (_event, name) => {
        const file = name?.toString() ?? '';
        if (file.endsWith('.tmp') || file.endsWith('supervisor.pid') || file.includes('/sessions/')) return;
        // A change during a scan is kept for the next wait, never lost until the rescan.
        dirty = true;
        if (wakeWait === undefined) return;
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(fire, DEBOUNCE_MS);
      });
      watcher.on('error', () => { watcher?.close(); watcher = undefined; });
    } catch {
      /* No jobs/ yet: the rescan attaches the watch once it exists. */
    }
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
  process.on('SIGPIPE', stop);
  process.stdout?.on('error', onStdoutError);
  options.signal?.addEventListener('abort', stop, { once: true });

  const wait = () =>
    new Promise<void>((resolve) => {
      if (stopped) return resolve();
      wakeWait = resolve;
      attach();
      timer = setTimeout(fire, dirty ? DEBOUNCE_MS : rescanMs);
    });

  try {
    // First pass builds the baseline silently without emitting lines.
    let prev = new Map<string, JobRow>(readThinJobRows(home, scope).map((row) => [row.job, row]));
    while (!stopped) {
      await wait();
      if (stopped) break;
      dirty = false;
      const rows = readThinJobRows(home, scope);
      const lines = jobChanges(prev, rows);
      prev = new Map(rows.map((row) => [row.job, row]));
      for (const line of lines) {
        if (stopped) break;
        try {
          await io.stdout(`${line}\n`);
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
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    process.off('SIGPIPE', stop);
    process.stdout?.off('error', onStdoutError);
    options.signal?.removeEventListener('abort', stop);
    if (timer !== undefined) clearTimeout(timer);
    watcher?.close();
  }
}
