import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { readFileBounded, writePrivateFile } from './atomic-fs.js';

const KEEP_NEW = 10;
const KEEP_LEGACY = 20;

function backupDir(home: string): string {
  return join(home, 'backups', 'trust');
}

function remove(file: string): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch { return false; } // Best effort; an archive may already be gone.
}

function contents(file: string, size: number): Buffer | undefined {
  try {
    const { bytes, truncated } = readFileBounded(file, size, { validate: (stat) => {
      if (stat.size !== size || stat.uid !== process.getuid?.()) throw Error('not a matching backup');
    } });
    if (!truncated && bytes.length === size) return bytes;
  } catch { /* An unreadable backup is never evidence of a duplicate. */ }
  return undefined;
}

/** Archive original bytes before a trust edit; count only archives with the same source path. */
export function backupTrustFile(home: string, agent: string, source: string, data: Buffer): void {
  const dir = backupDir(home);
  for (const folder of [dirname(dir), dir]) {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(folder);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.()) throw Error('unsafe trust backup directory');
    fs.chmodSync(folder, 0o700);
  }
  const base = basename(source);
  const canonical = join(fs.realpathSync(dirname(source)), base);
  const prefix = `${agent}-${createHash('sha256').update(canonical).digest('hex')}-`;
  const suffix = `-${base}`;
  let next = BigInt(Date.now());
  for (;;) {
    const names = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => {
      const { name } = entry;
      const stamp = name.slice(prefix.length, -suffix.length);
      return entry.isFile() && name.startsWith(prefix) && name.endsWith(suffix) && /^\d{16}$/.test(stamp);
    }).map((entry) => entry.name).sort().reverse();
    if (names[0] && contents(join(dir, names[0]), data.length)?.equals(data)) {
      for (const name of names.slice(KEEP_NEW)) remove(join(dir, name));
      return;
    }
    // Keep names in publication order even on a same-ms update or clock rollback.
    const latest = names[0] ? BigInt(names[0].slice(prefix.length, -suffix.length)) : 0n;
    if (next <= latest) next = latest + 1n;
    const stamp = String(next++).padStart(16, '0');
    try {
      writePrivateFile(join(dir, `${prefix}${stamp}${suffix}`), data, { mkdir: false, exclusive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    // Every removal has ten newer archives, even if another writer is pruning too.
    for (const name of names.slice(KEEP_NEW - 1)) remove(join(dir, name));
    return;
  }
}

/** Legacy names lack a source path; treat each agent/basename group as one owner file. */
export function pruneLegacyTrustBackups(home: string): number {
  const dir = backupDir(home);
  const sources = { grok: 'trusted_folders.toml', agy: 'settings.json', claude: '.claude.json' } as const;
  const groups = new Map<string, { file: string; stamp: string; collision: boolean; stat: fs.Stats }[]>();
  try {
    if (fs.realpathSync(dir) !== dir) return 0;
    const directory = fs.lstatSync(dir);
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) return 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const match = /^(grok|agy|claude)-(\d{8}T\d{9}Z)(-\d+)?-(.+)$/.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      const [, agent, stamp, pidSuffix, base] = match;
      if (base !== sources[agent as keyof typeof sources]) continue;
      const file = join(dir, entry.name);
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1) continue;
        const group = groups.get(agent) ?? [];
        group.push({ file, stamp, collision: Boolean(pidSuffix), stat });
        groups.set(agent, group);
      } catch { /* A racing removal or inaccessible entry doesn't stop the sweep. */ }
    }
  } catch { return 0; }

  let removed = 0;
  for (const group of groups.values()) {
    group.sort((a, b) => b.stamp.localeCompare(a.stamp) || b.stat.mtimeMs - a.stat.mtimeMs ||
      Number(b.collision) - Number(a.collision));
    for (const { file } of group.slice(KEEP_LEGACY)) if (remove(file)) removed++;
  }
  return removed;
}
