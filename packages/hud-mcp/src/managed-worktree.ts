import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseWorktreeList, worktreeGit as git } from '../../../src/collectors/worktrees.js';
import { neutralizeFilters } from '../../../src/utils/git-safety.js';

export interface ManagedWorktree {
  main_root: string;
  root: string;
  branch: string;
  base_head: string;
}
const oid = (value: unknown) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const list = async (cwd: string) => parseWorktreeList(await git(cwd, ['worktree', 'list', '--porcelain', '-z']));
const pathFor = (main: string, name: string) => join(dirname(main), `${basename(main)}-wt`, name);

export async function planWorktree(cwd: string, job: string, label: string): Promise<ManagedWorktree> {
  const [main] = await list(cwd);
  const base_head = (await git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (!main || main.bare || !oid(base_head) || (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true')
    throw new Error('worktree isolation requires a Git checkout with a HEAD commit');
  const main_root = fs.realpathSync(main.path);
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48).replace(/^-+|-+$/g, '') || 'job';
  const name = `${slug}-${job.slice(-6)}`;
  return { main_root, root: pathFor(main_root, name), branch: `wt/${name}`, base_head };
}

export async function addWorktree(wt: ManagedWorktree) {
  const parent = dirname(wt.root);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.realpathSync(parent) !== parent || fs.lstatSync(wt.root, { throwIfNoEntry: false }))
    throw new Error('worktree destination already exists or is redirected');
  await git(wt.main_root, ['worktree', 'add', '--no-checkout', '-b', wt.branch, '--', wt.root, wt.base_head]);
}

export async function populateWorktree(wt: ManagedWorktree) {
  // Discover filters after branch registration: includeIf may differ in the new worktree.
  const filters = await neutralizeFilters(git, wt.root);
  await git(wt.root, [...filters, 'read-tree', 'HEAD']);
  await git(wt.root, [...filters, 'checkout-index', '--all']);
  const source = join(wt.main_root, 'node_modules'), link = join(wt.root, 'node_modules');
  if (fs.existsSync(source) && !fs.lstatSync(link, { throwIfNoEntry: false })) fs.symlinkSync(source, link);
}

const status = (root: string, filters: string[], ignored: boolean) => git(root, [...filters,
  'status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--ignore-submodules=dirty',
  ...(ignored ? ['--ignored=matching'] : []),
]);
const fields = (text: string) => text ? text.slice(0, -1).split('\0') : [];
function dependencyLink(wt: ManagedWorktree) {
  const link = join(wt.root, 'node_modules');
  return fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() &&
    fs.readlinkSync(link) === join(wt.main_root, 'node_modules');
}

export async function gitSummary(wt: ManagedWorktree) {
  const base = { branch: wt.branch, base_head: wt.base_head };
  try {
    const tree = (await list(wt.main_root)).find((t) => t.path === wt.root && t.branch === wt.branch);
    if (!oid(tree?.head) || !oid(wt.base_head) || fs.realpathSync(wt.root) !== wt.root) throw Error();
    const head = tree!.head!;
    const filters = await neutralizeFilters(git, wt.root);
    const [commits, diff, pending] = await Promise.all([
      git(wt.root, ['rev-list', '--count', `${wt.base_head}..${head}`, '--']),
      git(wt.root, ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', wt.base_head, head, '--']),
      status(wt.root, filters, false),
    ]);
    const paths = fields(pending).filter((row) => row !== '?? node_modules' || !dependencyLink(wt));
    return { ...base, head, ahead_commits: Number(commits), changed_files: new Set([...fields(diff), ...paths.map((row) => row.slice(3))]).size, dirty: paths.length > 0 };
  } catch { return { ...base, head: null, ahead_commits: null, changed_files: null, dirty: null }; }
}

function nestedGitReason(root: string): string | undefined {
  const pending = [root];
  let remaining = 100_000;
  while (pending.length) {
    const path = pending.pop()!;
    if (!fs.lstatSync(path).isDirectory()) return 'worktree directory changed during cleanup check';
    const dir = fs.opendirSync(path);
    try {
      for (let entry; (entry = dir.readSync());) {
        if (--remaining < 0) return 'worktree exceeds the nested Git repository check limit';
        if (entry.name === '.git') {
          if (path !== root) return 'worktree contains a nested Git repository marker';
        } else if (entry.isDirectory()) pending.push(join(path, entry.name));
      }
    } finally { dir.closeSync(); }
  }
}

/** Returns the reason for preserving the checkout (or its branch); null means removed. */
export async function reapWorktree(id: string, job: { job: string; cwd: string; worktree: ManagedWorktree }) {
  const wt = job.worktree;
  try {
    const name = basename(wt.root);
    if (job.job !== id || job.cwd !== wt.root || wt.branch !== `wt/${name}` || !/^[a-z0-9-]+$/.test(name) ||
        !name.endsWith(`-${id.slice(-6)}`) || !oid(wt.base_head) || wt.root !== pathFor(wt.main_root, name) ||
        fs.realpathSync(wt.main_root) !== wt.main_root || fs.realpathSync(wt.root) !== wt.root)
      return 'worktree receipt does not match its checkout';
    const [main, ...linked] = await list(wt.main_root);
    const tree = linked.find((t) => t.path === wt.root && t.branch === wt.branch);
    if (main?.path !== wt.main_root || !tree || tree.locked !== undefined || tree.prunable !== undefined || !oid(tree.head))
      return 'worktree is not registered at the recorded branch and path, or is locked';
    const common = await git(wt.main_root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (await git(wt.root, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']) !== `${wt.root}\n${common}`)
      return 'worktree belongs to a different repository';
    const head = tree.head!;
    if (head !== wt.base_head) {
      try { await git(wt.main_root, ['merge-base', '--is-ancestor', head, 'HEAD']); }
      catch { return 'worktree has unmerged commits or ancestry could not be verified'; }
    }
    const filters = await neutralizeFilters(git, wt.root);
    const index = await git(wt.root, ['ls-files', '-v', '-z']);
    if (fields(index).some((row) => /^[a-zS] /.test(row))) return 'worktree has hidden index entries';
    const pending = fields(await status(wt.root, filters, true));
    if (pending.some((row) => !/^(?:\?\?|!!) node_modules$/.test(row) || !dependencyLink(wt)))
      return 'worktree is dirty (tracked, untracked or ignored files)';
    const nested = nestedGitReason(wt.root);
    if (nested) return nested;
    if (pending.includes('?? node_modules')) fs.unlinkSync(join(wt.root, 'node_modules'));
    await git(wt.main_root, [...filters, 'worktree', 'remove', '--', wt.root]);
    // Don't delete a branch advanced independently during cleanup; Git also checks merge/checkout safety.
    if ((await git(wt.main_root, ['rev-parse', '--verify', `refs/heads/${wt.branch}`])).trim() !== head)
      return 'worktree removed; branch changed during cleanup';
    try { await git(wt.main_root, ['branch', '-d', '--', wt.branch]); }
    catch { return 'worktree removed; Git refused to delete its branch'; }
    return null;
  } catch { return 'worktree cleanup could not be verified or completed'; }
}
