/** The connection owns its timer, not the worker tasks. A durable byte cursor per pane/project
 * lets a later connection pick up an intent even after the last worker task finished. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { panelActionLine, PANEL_ACTIONS_FILE } from '../collectors/panel-actions.js';
import { liveTryLine, TRIES_FILE } from '../collectors/try-records.js';
import { writePrivateFile } from '../utils/atomic-fs.js';

const files = [TRIES_FILE, PANEL_ACTIONS_FILE] as const;
const maxBytes = 256 * 1024;
const size = (file: string) => {
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  return st?.isFile() ? st.size : 0;
};

export function panelDelivery(home: string, pane: string | null, cwd: string, owns: (id: string) => boolean,
  push: (text: string) => Promise<boolean>) {
  const logs = files.map(name => join(home, name));
  const scope = createHash('sha256').update(JSON.stringify([pane, cwd, process.env.CLAUDE_CODE_SESSION_ID])).digest('hex');
  const dir = join(home, 'panel-cursors', scope), cursor = join(dir, 'offsets.json');
  let offsets = logs.map(size);
  if (pane) {
    // A brand new reader starts at the live edge. Never replace a reconnecting reader's cursor.
    try { writePrivateFile(cursor, JSON.stringify(offsets), { exclusive: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    offsets = JSON.parse(fs.readFileSync(cursor, 'utf8'));
  }
  let stopped = false;
  let sending: Promise<string[]> | undefined;
  async function drain(notify: boolean): Promise<string[]> {
    let lock: number | undefined;
    try {
      if (sending || stopped || logs.every((file, i) => size(file) === offsets[i])) return [];
      // Reconnects (and hot reloads) can overlap. Lock the stable directory, not the replaced cursor.
      if (pane) {
        lock = fs.openSync(dir, 'r');
        if (spawnSync('flock', ['-nx', '3'], { stdio: ['ignore', 'ignore', 'ignore', lock], timeout: 1000 }).status !== 0) return [];
        offsets = JSON.parse(fs.readFileSync(cursor, 'utf8'));
      }
      const lines: string[] = [], after = [...offsets];
      for (const [i, file] of logs.entries()) {
        const end = size(file), start = end < offsets[i] ? 0 : offsets[i];
        after[i] = start;
        if (end === start) continue;
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          const buf = Buffer.alloc(Math.min(maxBytes, end - start));
          const n = fs.readSync(fd, buf, 0, buf.length, start);
          let at = 0;
          while (at < n && lines.length < 32) {
            const nl = buf.subarray(0, n).indexOf(10, at);
            if (nl < 0) { if (at === 0 && n === maxBytes) after[i] += n; break; } // Oversized or not yet complete.
            const raw = buf.toString('utf8', at, nl);
            const line = i === 0 ? liveTryLine(raw, cwd) : panelActionLine(raw, owns, cwd);
            if (line) lines.push(line);
            at = nl + 1;
            after[i] = start + at;
          }
        } finally { fs.closeSync(fd); }
      }
      if (lines.length && notify && !await push(lines.join('\n'))) return [];
      if (after.some((at, i) => at !== offsets[i])) {
        if (pane) writePrivateFile(cursor, JSON.stringify(after));
        offsets = after;
      }
      return lines;
    } catch { return []; } // A failed read or push leaves the previous cursor for the next call/tick.
    finally { if (lock !== undefined) fs.closeSync(lock); }
  }
  const timer = pane && setInterval(() => {
    if (!sending) sending = drain(true).finally(() => { sending = undefined; });
  }, 1000).unref();
  return {
    changes: () => drain(false),
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      // Finish a bounded in-flight notify before retiring: aborting after submit could replay it on reconnect.
      await sending;
    },
  };
}
