import * as fs from 'node:fs';
import { join } from 'node:path';
import { readDirSafe, readJsonFile } from '../utils/atomic-fs.js';

// One flows listing per pass. Atomic replacement can preserve mtime on a coarse clock,
// so compare inode too. Evict pruned receipts; never cache notice delivery or PID liveness.
export function headerScanner() {
  let root: string | undefined;
  const cache = new Map<string, { mtime: number; ino: number; value: unknown }>();
  return (home: string) => {
    const dir = join(home, 'flows'), files = readDirSafe(dir);
    if (root !== dir) { root = dir; cache.clear(); }
    const present = new Set(files);
    for (const file of cache.keys()) if (!present.has(file.split('/', 1)[0])) cache.delete(file);
    function header<T>(file: string): T | null {
      const parent = file.includes('/') ? file.split('/', 1)[0] : undefined;
      if (parent && !fs.lstatSync(join(dir, parent), { throwIfNoEntry: false })?.isDirectory()) {
        cache.delete(file); return null;
      }
      const path = join(dir, file), st = fs.lstatSync(path, { throwIfNoEntry: false });
      if (!st?.isFile()) { cache.delete(file); return null; }
      const hit = cache.get(file);
      if (hit && hit.mtime === st.mtimeMs && hit.ino === st.ino) return hit.value as T;
      try {
        const value = readJsonFile(path) as T;
        cache.set(file, { mtime: st.mtimeMs, ino: st.ino, value }); return value;
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    }
    return { files, header };
  };
}
export type HeaderPass = ReturnType<ReturnType<typeof headerScanner>>;
export const workflowHeaders = headerScanner();
