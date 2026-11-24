/** Bounded, read-only Git numstat for panel previews. These are workspace facts, not per-agent attribution. */
import { isAbsolute, join, resolve } from 'node:path';
import { neutralizeFilters } from '../utils/git-safety.js';
import { worktreeGit } from './worktrees.js';
import { readJobFile } from './read-job-file.js';

export const DIFF_FILE_LIMIT = 12;
const GATE_MS = 5000;
const NUMSTAT = ['--numstat', '-z', '--no-relative', '--no-renames', '--no-ext-diff', '--no-textconv',
  '--submodule=short', '--ignore-submodules=dirty'];

export interface DiffStatSummary {
  files: { path: string; absPath: string; added: number | null; deleted: number | null; binary?: boolean }[];
  totalFiles: number;
  totalAdded: number;
  totalDeleted: number;
}

/** -z preserves tabs and newlines in file names. With --no-renames each record has exactly one path. */
export function parseNumstat(text: string, root: string): DiffStatSummary {
  const files = new Map<string, { added: number; deleted: number; binary: boolean }>();
  let totalAdded = 0, totalDeleted = 0;
  const records = text.split('\0');
  if (records.pop() !== '') throw Error('Incomplete numstat');
  for (const record of records) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!m || (m[1] === '-') !== (m[2] === '-')) throw Error('Invalid numstat');
    const [, a, d, path] = m;
    if (isAbsolute(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) throw Error('Invalid numstat path');
    const file = files.get(path) ?? { added: 0, deleted: 0, binary: false };
    if (a === '-') file.binary = true;
    else {
      const added = Number(a), deleted = Number(d);
      totalAdded += added;
      totalDeleted += deleted;
      if (!Number.isSafeInteger(totalAdded) || !Number.isSafeInteger(totalDeleted)) throw Error('Invalid numstat count');
      file.added += added;
      file.deleted += deleted;
    }
    files.set(path, file);
  }
  const top = [...files].sort(([, a], [, b]) => (b.added + b.deleted) - (a.added + a.deleted)).slice(0, DIFF_FILE_LIMIT);
  return { totalAdded, totalDeleted, totalFiles: files.size, files: top.map(([path, f]) => ({
    path, absPath: resolve(root, path), added: f.binary ? null : f.added, deleted: f.binary ? null : f.deleted,
    ...(f.binary ? { binary: true } : {}),
  })) };
}

async function numstat(cwd: string, args: string[], workingTree = false): Promise<DiffStatSummary> {
  const root = (await worktreeGit(cwd, ['rev-parse', '--show-toplevel'])).replace(/\n$/, '');
  if (!isAbsolute(root)) throw Error('No Git worktree');
  const filters = workingTree ? await neutralizeFilters(worktreeGit, root) : [];
  return parseNumstat(await worktreeGit(root, [...filters, ...args, '--']), root);
}

interface Read {
  until: number;
  pending: boolean;
  value: Promise<DiffStatSummary | undefined>;
}

export class DiffStatCollector {
  private reads = new Map<string, Read>();
  private read(key: string, now: number, run: () => Promise<DiffStatSummary | undefined>, freeze: boolean | 'success' = false) {
    const hit = this.reads.get(key);
    if (hit && (hit.pending || now < hit.until)) return hit.value;
    const next: Read = { until: now + GATE_MS, pending: true, value: run().catch(() => undefined).then((value) => {
      next.pending = false;
      if (freeze === true || (freeze === 'success' && value)) next.until = Infinity;
      return value;
    }) };
    this.reads.delete(key);
    this.reads.set(key, next);
    if (this.reads.size > 200) this.reads.delete(this.reads.keys().next().value!);
    return next.value;
  }
  /** The caller already checked that status reports dirty files. Untracked files have no Git numstat. */
  workingTree(cwd: string, now: number) {
    return this.read(`tree:${cwd}`, now, () => numstat(cwd, ['diff', ...NUMSTAT, 'HEAD'], true));
  }
  commits(cwd: string, text: string, now: number) {
    const hashes = [...new Set(Array.from(text.matchAll(/\b[0-9a-f]{7,64}\b/gi), (m) => m[0].toLowerCase()))].slice(0, 5).sort();
    if (!hashes.length) return Promise.resolve(undefined);
    return this.read(`commits:${cwd}:${hashes.join(',')}`, now, () => numstat(cwd, ['show', ...NUMSTAT, '--format=',
      '--no-show-signature', '--diff-merges=first-parent', ...hashes.map((hash) => `${hash}^{commit}`)]), 'success');
  }
  /** Inspect just the selected job. A settlement takes one final sample; a resumed job samples again. */
  job(directory: string, settledAt: number | null, now: number) {
    const active = `active:${directory}`;
    if (settledAt !== null) this.reads.delete(active);
    return this.read(settledAt === null ? active : `settled:${settledAt}:${directory}`, now, async () => {
      const session = readJobFile(join(directory, 'SESSION.txt'), 4097).text;
      const base = /^BASE=([0-9a-fA-F]{7,64})\r?$/m.exec(session)?.[1]?.toLowerCase();
      if (!base || Buffer.byteLength(session) > 4096) return;
      const job = JSON.parse(readJobFile(join(directory, 'job.json'), 65536).text);
      const cwd = job.worktree?.root ?? job.cwd;
      if (typeof cwd !== 'string' || !isAbsolute(cwd)) return;
      return numstat(cwd, ['diff', ...NUMSTAT, `${base}^{commit}`], true);
    }, settledAt !== null);
  }
}
