/** On-demand retention for rebuildable HUD display files, not owner state. */
import * as fs from 'node:fs';
import { join } from 'node:path';

const MAX_AGE_MS = 30 * 86_400_000;
const MAX_FILES = 512;
const MAX_BYTES = 8 * 1024 * 1024;

type Entry = { name: string; file: string; stat: fs.Stats; usedAt: number };

function entries(dir: string, namePattern: RegExp): Entry[] {
  try {
    // Never sweep a directory redirected outside its expected location.
    if (fs.realpathSync(dir) !== dir) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(({ name }) => {
      if (!namePattern.test(name)) return [];
      const file = join(dir, name);
      try {
        const stat = fs.lstatSync(file);
        if (stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.())
          return [{ name, file, stat, usedAt: Math.max(stat.atimeMs, stat.mtimeMs) }];
      } catch { /* Missing or inaccessible; leave it alone. */ }
      return [];
    });
  } catch { return []; }
}

function remove({ file, stat }: Entry): void {
  try {
    const current = fs.lstatSync(file);
    // Don't evict an atomically published replacement or a file used since listing.
    if (current.dev === stat.dev && current.ino === stat.ino && current.ctimeMs === stat.ctimeMs &&
        current.atimeMs === stat.atimeMs) fs.unlinkSync(file);
  } catch { /* Retention is best effort. */ }
}

function pruneCache(dir: string, names: RegExp, now: number): void {
  // Use filesystem recency (including reads on systems tracking atime) without
  // rewriting a cache hit or reading any cache bodies during retention.
  const newestFirst = entries(dir, names).sort((a, b) => b.usedAt - a.usedAt);
  let files = 0, bytes = 0;
  for (const entry of newestFirst) {
    if (now - entry.usedAt >= MAX_AGE_MS || files >= MAX_FILES || bytes + entry.stat.size > MAX_BYTES) {
      remove(entry);
    } else {
      files++;
      bytes += entry.stat.size;
    }
  }
}

export function pruneDisplayFiles(display: string, now = Date.now()): void {
  pruneCache(join(display, 'model-cache', 'decision-labels'), /^(?:[0-9a-f]{64}|cache)\.json$/, now);
  pruneCache(join(display, 'statusline'), /^(?:config|context|git|transcript)-[0-9a-f]{64}\.json$/, now);
  for (const entry of entries(join(display, 'state'), /^pid-[1-9][0-9]{0,9}\.json$/)) {
    const pid = Number(entry.name.slice(4, -5));
    if (pid > 0x7fffffff) continue;
    try { process.kill(pid, 0); }
    catch (error) {
      // EPERM and unknown errors are not proof that the process is gone.
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') remove(entry);
    }
  }
}
