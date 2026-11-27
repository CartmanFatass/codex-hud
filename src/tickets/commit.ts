/** Sweep and commit only HUD-written ticket files whose current bytes match ticket-writes.json. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { worktreeGit } from '../collectors/worktrees.js';
import { withObjectiveLock } from '../mcp/local-objectives.js';
import { takeLease } from '../roles/lease.js';
import { localProjectRoots } from '../roles/projects.js';
import { writeFileAtomic } from '../utils/atomic-fs.js';
import { neutralizeFilters } from '../utils/git-safety.js';
import {
  pruneTicketWrites, readTicketWrites, ticketWriteRelPath, ticketWriteSha, withTicketStoreLock,
  type TicketWrite,
} from './store.js';

export type GitRunner = (args: string[]) => Promise<string>;

export interface SweepResult {
  committed: boolean;
  paths: string[];
  sha?: string;
  skipped: string[];
}

export interface CommitTicketWritesResult {
  ok: true;
  committed: boolean;
  paths: string[];
  commit?: string;
  skipped?: string[];
  deferred?: boolean;
}

const headOf = (git: GitRunner) =>
  git(['rev-parse', '--verify', '--quiet', 'HEAD']).then(out => out.trim()).catch((error: NodeJS.ErrnoException) => {
    if (Number(error.code) === 1) return '';
    throw error;
  });

// HUD never stages changes on pending files. Reject a nonblank index column (including ignored paths), except untracked files.
const hasUnsafeIndexStatus = (xy: string) => xy[0] !== ' ' && xy[0] !== '?';
const isHiddenInGit = async (git: GitRunner, rel: string) =>
  (await git(['ls-files', '-v', '-z', '--', rel])).split('\0').some(row => /^[a-zS] /.test(row));
const isIgnoredInGit = (git: GitRunner, rel: string) =>
  git(['--no-literal-pathspecs', 'check-ignore', '-q', '--', rel]).then(() => true, (error: NodeJS.ErrnoException) => {
    if (Number(error.code) === 1) return false;
    throw error;
  });

async function inspectMainPath(realMain: string, rel: string, expectedSha: string | undefined, git: GitRunner) {
  const status = await git(['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=all', '--', rel]);
  if (!status) return { handEdited: await isHiddenInGit(git, rel), untracked: false };
  const xy = status.slice(0, 2);
  if (hasUnsafeIndexStatus(xy) || xy.includes('D') || !expectedSha || ticketWriteSha(realMain, rel) !== expectedSha) {
    return { handEdited: true, untracked: false };
  }
  return xy === '??' ? { handEdited: false, untracked: true } : { handEdited: await isHiddenInGit(git, rel), untracked: false };
}

/** True when `rel` is unsafe to write in main, even with a matching HUD digest if the path is staged. */
export async function isHandEditedInMain(mainRoot: string, rel: string, expectedSha: string | undefined, git: GitRunner): Promise<boolean> {
  return (await inspectMainPath(fs.realpathSync(mainRoot), rel, expectedSha, git)).handEdited;
}

function defaultCommitMessage(keys: readonly string[]) {
  return keys.length === 1 ? `tickets: ${keys[0]}` : `tickets: ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ` (+${keys.length - 3})` : ''}`;
}

async function collectPendingWrites(realMain: string, writes: Readonly<Record<string, string>>, git: GitRunner, exclude?: ReadonlySet<string>) {
  const clean = new Map<string, string>(), skipped: string[] = [];
  const toCommit: { key: string; rel: string; digest: string; untracked: boolean }[] = [];
  for (const [key, expectedSha] of Object.entries(writes)) {
    if (exclude?.has(key)) continue;
    const rel = ticketWriteRelPath(key), actualSha = ticketWriteSha(realMain, rel);
    if (actualSha !== expectedSha) { if (actualSha !== undefined) skipped.push(rel); continue; }
    const status = await git(['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=all', '--', rel]);
    if (!status) { clean.set(key, expectedSha); continue; }
    const xy = status.slice(0, 2);
    if (hasUnsafeIndexStatus(xy) || (xy !== '??' && await isHiddenInGit(git, rel))) { skipped.push(rel); continue; }
    toCommit.push({ key, rel, digest: expectedSha, untracked: xy === '??' });
  }
  return { clean, toCommit, skipped };
}

/** Verify HEAD and every touched file before writing; returns pre-write snapshots for rollback. */
export async function checkArchiveFiles(
  mainRoot: string,
  home: string,
  files: readonly TicketWrite[],
  git: GitRunner,
  handEditError = (rel: string) => new Error(`Cannot archive tickets in ${rel}: uncommitted hand edit present; commit or revert it and retry`),
) {
  const realMain = fs.realpathSync(mainRoot), writes = readTicketWrites(home, realMain);
  const base = await headOf(git);
  if (!base) throw new Error('Cannot archive tickets: repository has no commits yet');
  const snapshots: { full: string; existed: boolean; bytes?: Buffer; mode?: number }[] = [];
  const newPaths: string[] = [], preWriteMatched = new Map<string, string>();
  for (const file of files) {
    if (file.mirror) continue;
    const rel = ticketWriteRelPath(file.key), full = join(realMain, rel);
    const expected = Object.hasOwn(writes, file.key) ? writes[file.key] : undefined;
    const info = await inspectMainPath(realMain, rel, expected, git);
    if (info.handEdited) throw handEditError(rel);
    const st = fs.lstatSync(full, { throwIfNoEntry: false });
    if (st) {
      if (!st.isFile()) throw new Error(`Cannot archive tickets in ${rel}: not a regular file`);
      if (info.untracked) newPaths.push(rel);
      snapshots.push({ full, existed: true, bytes: fs.readFileSync(full), mode: st.mode & 0o777 });
    } else {
      if (await isIgnoredInGit(git, rel)) throw new Error(`Cannot archive tickets in ${rel}: path is ignored by Git`);
      newPaths.push(rel);
      snapshots.push({ full, existed: false });
    }
    if (expected !== undefined) preWriteMatched.set(file.key, expected);
  }
  return { realMain, base, writes, snapshots, newPaths, preWriteMatched };
}

/** Atomically write and commit archive/landing files (optionally folding pending HUD writes); restores disk & index on Git failure. */
export async function commitArchiveFiles(
  mainRoot: string,
  home: string,
  files: readonly TicketWrite[],
  git: GitRunner,
  opts: { mode: 'commit' | 'amend'; message?: string; identity?: string[]; expectedTip?: string; sweepPending?: boolean; handEditError?: (rel: string) => Error },
): Promise<SweepResult> {
  const local = files.filter(file => !file.mirror), realMain = fs.realpathSync(mainRoot);
  const checked = local.length ? await checkArchiveFiles(realMain, home, local, git, opts.handEditError) : undefined;
  const writes = checked?.writes ?? readTicketWrites(home, realMain);
  const pending = opts.sweepPending
    ? await collectPendingWrites(realMain, writes, git, new Set(local.map(f => f.key)))
    : { clean: new Map<string, string>(), toCommit: [], skipped: [] };
  if (!local.length && !pending.toCommit.length) {
    pruneTicketWrites(home, realMain, pending.clean);
    return { committed: false, paths: [], skipped: pending.skipped };
  }
  const base = checked?.base ?? await headOf(git);
  if (opts.expectedTip && base !== opts.expectedTip) throw new Error(`Main checkout HEAD moved from ${opts.expectedTip} to ${base || 'none'} before amend`);
  const snapshots = checked?.snapshots ?? [];
  const commitPaths = [...new Set([...local.map(f => ticketWriteRelPath(f.key)), ...pending.toCommit.map(i => i.rel)])].sort();
  const intentPaths = [...new Set([...(checked?.newPaths ?? []), ...pending.toCommit.filter(i => i.untracked).map(i => i.rel)])];
  const idArgs = opts.identity ?? [];
  let added = false;
  try {
    for (let i = 0; i < local.length; i++) writeFileAtomic(snapshots[i].full, local[i].bytes, { dotPrefix: true, mode: local[i].mode });
    if (intentPaths.length) { added = true; await git(['add', '--intent-to-add', '--', ...intentPaths]); }
    if (opts.mode === 'amend') await git([...idArgs, 'commit', '--amend', '--no-edit', '--no-gpg-sign', '--only', '--', ...commitPaths]);
    else {
      const msg = opts.message ?? defaultCommitMessage([...local.map(f => f.key), ...pending.toCommit.map(i => i.key)]);
      await git([...idArgs, 'commit', '--no-gpg-sign', '--only', '-m', msg, '--', ...commitPaths]);
    }
  } catch (error) {
    if (await headOf(git).catch(() => '') === base) {
      for (const snap of snapshots) {
        try {
          if (snap.existed) writeFileAtomic(snap.full, snap.bytes!, { dotPrefix: true, mode: snap.mode });
          else fs.rmSync(snap.full, { force: true });
        } catch { /* Best-effort restore of remaining snapshots. */ }
      }
      if (added) await git(['reset', '-q', '--', ...intentPaths]).catch(() => {});
    }
    throw error;
  }
  const sha = await headOf(git), pruned = new Map([...(checked?.preWriteMatched ?? []), ...pending.clean]);
  for (const item of pending.toCommit) pruned.set(item.key, item.digest);
  pruneTicketWrites(home, realMain, pruned);
  return { committed: true, paths: commitPaths, sha: sha || undefined, skipped: pending.skipped };
}

/** Caller holds the `main-checkout` lease and the tickets and objective locks. */
export const sweepTicketWrites = (
  mainRoot: string, home: string, git: GitRunner,
  opts: { mode: 'commit' | 'amend'; message?: string; identity?: string[]; expectedTip?: string },
) => commitArchiveFiles(mainRoot, home, [], git, { ...opts, sweepPending: true });

async function gitMainRoot(cwd: string): Promise<string | undefined> {
  const { mainRoot } = localProjectRoots(cwd);
  const top = await worktreeGit(mainRoot, ['rev-parse', '--show-toplevel']).catch((error: Error) => {
    if (/^fatal: not a git repository/m.test(error.message)) return '';
    throw error;
  });
  return top ? fs.realpathSync(top.trimEnd()) : undefined;
}

/** Acquire `main-checkout` lease and run `fn(root)`. Returns undefined only when `wait_s === 0` and `deferOnBusy` is true. */
export async function withMainCheckoutLease<T>(
  cwd: string, home: string, opts: { wait_s: number; holderPrefix: string; deferOnBusy?: boolean }, fn: (root: string) => Promise<T>,
): Promise<T | undefined> {
  const root = await gitMainRoot(cwd);
  if (!root) throw new Error('not a git repository');
  const lease = { home, cwd: root, holder: `${opts.holderPrefix}-${randomUUID()}` };
  const res = await takeLease({ name: 'main-checkout', wait_s: opts.wait_s }, lease);
  if (!('granted' in res && res.granted)) {
    if (opts.wait_s === 0 && opts.deferOnBusy) return undefined;
    throw new Error('main-checkout lease is busy; try again after the active land finishes');
  }
  try { return await fn(root); }
  finally { await takeLease({ name: 'main-checkout', release: true }, lease); }
}

/** Commit all dirty/untracked HUD-written ticket files under `main-checkout` → `tickets` lock order. */
export async function commitTicketWrites(cwd: string, home: string, opts?: { wait_s?: number; message?: string }): Promise<CommitTicketWritesResult> {
  const wait_s = opts?.wait_s ?? 300;
  const result = await withMainCheckoutLease(cwd, home, { wait_s, holderPrefix: 'tickets-commit', deferOnBusy: wait_s === 0 }, (root) =>
    withTicketStoreLock(root, () => withObjectiveLock(root, async () => {
      const filters = await neutralizeFilters(worktreeGit, root);
      const res = await sweepTicketWrites(root, home, (args) => worktreeGit(root, [...filters, ...args]), { mode: 'commit', message: opts?.message });
      return { ok: true as const, committed: res.committed, paths: res.paths, ...(res.sha && { commit: res.sha }), ...(res.skipped.length && { skipped: res.skipped }) };
    })),
  );
  return result ?? { ok: true, committed: false, paths: [], deferred: true };
}
