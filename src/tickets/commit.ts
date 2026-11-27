/** Sweep and commit only HUD-written ticket files whose current bytes match ticket-writes.json. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { worktreeGit } from '../collectors/worktrees.js';
import { withObjectiveLock } from '../mcp/local-objectives.js';
import { takeLease } from '../roles/lease.js';
import { localProjectRoots } from '../roles/projects.js';
import { neutralizeFilters } from '../utils/git-safety.js';
import {
  pruneTicketWrites, readReconciledTicketWriteState, ticketWriteRelPath, ticketWriteSha, withTicketStoreLock,
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

const isUnmerged = (xy: string) => /^(?:[DAU]{2}|U.|.U)$/.test(xy);

/** True when `rel` has uncommitted/untracked/ignored changes in main that do NOT match HUD's recorded digest. */
export async function isHandEditedInMain(mainRoot: string, rel: string, expectedSha: string | undefined, git: GitRunner): Promise<boolean> {
  const status = await git(['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=all', '--', rel]);
  if (!status) {
    const hidden = (await git(['ls-files', '-v', '-z', '--', rel])).split('\0').some(row => /^[a-zS] /.test(row));
    return hidden;
  }
  const xy = status.slice(0, 2);
  if (xy === '!!' || isUnmerged(xy)) return true;
  if (!expectedSha) return true;
  const realMain = fs.realpathSync(mainRoot);
  return ticketWriteSha(realMain, rel) !== expectedSha;
}

function defaultCommitMessage(keys: readonly string[]) {
  return keys.length === 1 ? `tickets: ${keys[0]}` : `tickets: ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ` (+${keys.length - 3})` : ''}`;
}

/** Caller holds the `main-checkout` lease and the tickets and objective locks. */
export async function sweepTicketWrites(
  mainRoot: string,
  home: string,
  git: GitRunner,
  opts: { mode: 'commit' | 'amend'; message?: string; identity?: string[]; expectedTip?: string },
): Promise<SweepResult> {
  const realMain = fs.realpathSync(mainRoot);
  const { writes, groups, retired } = readReconciledTicketWriteState(home, mainRoot);

  const clean = new Map<string, string>();
  let toCommit: { key: string; rel: string; digest: string; untracked: boolean }[] = [];
  const skipped: string[] = [];
  const grouped = new Set(groups.flat());

  for (const [key, expectedSha] of Object.entries(writes)) {
    const rel = ticketWriteRelPath(key);
    const actualSha = ticketWriteSha(realMain, rel);
    if (actualSha !== expectedSha) {
      if (actualSha !== undefined) skipped.push(rel);
      continue;
    }
    const status = await git(['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=all', '--', rel]);
    if (!status) {
      if (grouped.has(key) && (await git(['ls-files', '-v', '-z', '--', rel])).split('\0').some(row => /^[a-zS] /.test(row))) continue;
      clean.set(key, expectedSha);
      continue;
    }
    const xy = status.slice(0, 2);
    if (xy === '!!' || isUnmerged(xy)) {
      skipped.push(rel);
      continue;
    }
    if (xy === '??') {
      toCommit.push({ key, rel, digest: expectedSha, untracked: true });
      continue;
    }
    const hidden = (await git(['ls-files', '-v', '-z', '--', rel])).split('\0').some(row => /^[a-zS] /.test(row));
    if (hidden) {
      skipped.push(rel);
      continue;
    }
    toCommit.push({ key, rel, digest: expectedSha, untracked: false });
  }

  const matched = new Set([...clean.keys(), ...toCommit.map(item => item.key)]);
  const fenced = new Set(groups.filter(group => group.some(key => !matched.has(key))).flat());
  for (const key of fenced) {
    clean.delete(key);
    const rel = ticketWriteRelPath(key);
    if (!skipped.includes(rel)) skipped.push(rel);
  }
  toCommit = toCommit.filter(item => !fenced.has(item.key));
  const pruned = new Map([...retired, ...clean]);
  if (!toCommit.length) {
    pruneTicketWrites(home, mainRoot, pruned);
    return { committed: false, paths: [], skipped };
  }

  toCommit.sort((a, b) => a.rel.localeCompare(b.rel));
  const sweepPaths = toCommit.map(item => item.rel);
  const newPaths = toCommit.filter(item => item.untracked).map(item => item.rel);
  const base = await headOf(git);
  if (opts.expectedTip && base !== opts.expectedTip) {
    throw new Error(`Main checkout HEAD moved from ${opts.expectedTip} to ${base || 'none'} before amend`);
  }
  const idArgs = opts.identity ?? [];
  let added = false;

  try {
    if (newPaths.length) {
      await git(['add', '--intent-to-add', '--', ...newPaths]);
      added = true;
    }
    if (opts.mode === 'amend') {
      await git([...idArgs, 'commit', '--amend', '--no-edit', '--no-gpg-sign', '--only', '--', ...sweepPaths]);
    } else {
      const msg = opts.message ?? defaultCommitMessage(toCommit.map(item => item.key));
      await git([...idArgs, 'commit', '--no-gpg-sign', '--only', '-m', msg, '--', ...sweepPaths]);
    }
  } catch (error) {
    if (added && await headOf(git) === base) {
      await git(['reset', '-q', '--', ...newPaths]).catch(() => {});
    }
    throw error;
  }

  const sha = await headOf(git);
  for (const item of toCommit) pruned.set(item.key, item.digest);
  pruneTicketWrites(home, mainRoot, pruned);
  return { committed: true, paths: sweepPaths, sha: sha || undefined, skipped };
}

async function gitMainRoot(cwd: string): Promise<string | undefined> {
  const { mainRoot } = localProjectRoots(cwd);
  const top = await worktreeGit(mainRoot, ['rev-parse', '--show-toplevel']).catch((error: Error) => {
    if (/^fatal: not a git repository/m.test(error.message)) return '';
    throw error;
  });
  return top ? fs.realpathSync(top.trimEnd()) : undefined;
}

/** Commit all dirty/untracked HUD-written ticket files under `main-checkout` → `tickets` lock order. */
export async function commitTicketWrites(
  cwd: string,
  home: string,
  opts?: { wait_s?: number; message?: string },
): Promise<CommitTicketWritesResult> {
  const root = await gitMainRoot(cwd);
  if (!root) throw new Error('not a git repository');
  const lease = { home, cwd: root, holder: `tickets-commit-${randomUUID()}` };
  const wait_s = opts?.wait_s ?? 300;
  let granted = false;
  if (wait_s === 0) {
    const res = await takeLease({ name: 'main-checkout', wait_s: 0 }, lease);
    granted = 'granted' in res && res.granted;
    if (!granted) return { ok: true, committed: false, paths: [], deferred: true };
  } else {
    const res = await takeLease({ name: 'main-checkout', wait_s }, lease);
    granted = 'granted' in res && res.granted;
    if (!granted) throw new Error('main-checkout lease is busy; try again after the active land finishes');
  }
  try {
    return await withTicketStoreLock(root, () => withObjectiveLock(root, async () => {
      const filters = await neutralizeFilters(worktreeGit, root);
      const git: GitRunner = (args) => worktreeGit(root, [...filters, ...args]);
      const res = await sweepTicketWrites(root, home, git, { mode: 'commit', message: opts?.message });
      return {
        ok: true as const,
        committed: res.committed,
        paths: res.paths,
        ...(res.sha && { commit: res.sha }),
        ...(res.skipped.length && { skipped: res.skipped }),
      };
    }));
  } finally {
    await takeLease({ name: 'main-checkout', release: true }, lease);
  }
}
