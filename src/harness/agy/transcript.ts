import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Native log for a recorded AGY session, never a search of other sessions. */
export function agyTranscriptPath(id: unknown): string | undefined {
  if (typeof id === 'string' && /^[\w-]{1,128}$/.test(id)) {
    return join(homedir(), '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');
  }
}

export interface AgyActivityCursor {
  path: string;
  ino: number;
  offset: number;
  openTasks: Set<string>;
}

export interface AgyNativeActivity {
  activityAt: number | null;
  runningTask: boolean;
}

const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const BG_TASK_START = /\bbackground task with task id:\s*(\S+)/i;
const BG_TASK_END = /\bTask id "([^"]+)" (?:finished|failed|was cancel(?:l)?ed|cancel(?:l)?ed|terminated|stopped|exited)\b/gi;
const BG_TASK_KILL = /\bTask "([^"]+)" (?:cancel(?:l)?ed|killed|stopped|finished|terminated|failed)\b/gi;

function applyTranscriptLine(line: string, openTasks: Set<string>): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let entry: { type?: unknown; status?: unknown; content?: unknown };
  try { entry = JSON.parse(trimmed); } catch { return; }
  if (!entry || typeof entry !== 'object' || typeof entry.content !== 'string') return;
  if (entry.type === 'GENERIC' && entry.status === 'RUNNING') {
    const started = BG_TASK_START.exec(entry.content);
    if (started) openTasks.add(started[1]);
  }
  if (entry.type === 'SYSTEM_MESSAGE' || entry.type === 'GENERIC') {
    for (const match of entry.content.matchAll(BG_TASK_END)) openTasks.delete(match[1]);
    for (const match of entry.content.matchAll(BG_TASK_KILL)) openTasks.delete(match[1]);
  }
}

function readRange(path: string, start: number, length: number): Buffer {
  const buf = Buffer.allocUnsafe(length);
  const fd = fs.openSync(path, 'r');
  try {
    let filled = 0;
    while (filled < length) {
      const n = fs.readSync(fd, buf, filled, length - filled, start + filled);
      if (n <= 0) break;
      filled += n;
    }
    return filled === length ? buf : buf.subarray(0, filled);
  } finally {
    fs.closeSync(fd);
  }
}

/** Read bounded native AGY step-log mtime and open background task state for a recorded session. */
export function readAgyNativeActivity(id: unknown, cursor?: AgyActivityCursor): AgyNativeActivity {
  const path = agyTranscriptPath(id);
  const reset = () => {
    if (cursor) { cursor.path = ''; cursor.ino = 0; cursor.offset = 0; cursor.openTasks.clear(); }
    return { activityAt: null, runningTask: false };
  };
  if (!path) return reset();
  let stat: fs.Stats | undefined;
  try { stat = fs.lstatSync(path, { throwIfNoEntry: false }); }
  catch { return reset(); }
  if (!stat || !stat.isFile() || stat.size <= 0) return reset();
  const state: AgyActivityCursor = cursor ?? { path: '', ino: 0, offset: 0, openTasks: new Set() };
  if (state.path !== path || state.ino !== stat.ino || stat.size < state.offset) {
    state.path = path;
    state.ino = stat.ino;
    state.offset = 0;
    state.openTasks.clear();
  }
  let openTasks = state.openTasks;
  if (stat.size > state.offset) {
    try {
      let start = state.offset;
      let skipFirstPartial = false;
      if (stat.size - start > MAX_SCAN_BYTES) {
        start = stat.size - MAX_SCAN_BYTES;
        skipFirstPartial = true;
      }
      const chunk = readRange(path, start, stat.size - start);
      let scanStart = 0;
      if (skipFirstPartial) {
        const firstNl = chunk.indexOf(0x0a);
        if (firstNl < 0) return { activityAt: stat.mtimeMs, runningTask: state.openTasks.size > 0 };
        scanStart = firstNl + 1;
      }
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl >= scanStart) {
        const lines = chunk.subarray(scanStart, lastNl).toString('utf8').split('\n');
        for (const line of lines) applyTranscriptLine(line, state.openTasks);
        state.offset = start + lastNl + 1;
      } else if (skipFirstPartial) {
        state.offset = start + scanStart;
      }
      const tailStart = lastNl >= scanStart ? lastNl + 1 : scanStart;
      if (tailStart < chunk.length) {
        const tail = chunk.subarray(tailStart).toString('utf8').trim();
        if (tail) {
          openTasks = new Set(state.openTasks);
          applyTranscriptLine(tail, openTasks);
        }
      }
    } catch { /* Unreadable native log: fall back to the mtime observation without fabricating task state. */ }
  }
  return { activityAt: stat.mtimeMs, runningTask: openTasks.size > 0 };
}
