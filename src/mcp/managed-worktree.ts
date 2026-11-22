import * as fs from 'node:fs';
import { basename, dirname, join, matchesGlob, resolve } from 'node:path';
import { registeredProject } from '../roles/projects.js';
import { readBytes } from '../statusline-parity/storage.js';
import { parseWorktreeList, worktreeGit as git, type WorktreeGit } from '../collectors/worktrees.js';
import { neutralizeFilters } from '../utils/git-safety.js';

export interface ManagedWorktree {
  main_root: string;
  root: string;
  branch: string;
  base_head: string;
  owner?: string;
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

const status = (root: string, filters: string[], ignored: boolean, run: WorktreeGit = git) => run(root, [...filters,
  'status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--ignore-submodules=dirty',
  ...(ignored ? ['--ignored'] : []),
]);
const fields = (text: string) => text ? text.slice(0, -1).split('\0') : [];
function dependencyLink(wt: ManagedWorktree) {
  const link = join(wt.root, 'node_modules');
  return fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() &&
    fs.readlinkSync(link) === join(wt.main_root, 'node_modules');
}

const diffNames = ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv'];
function worktreeHead(wt: ManagedWorktree, head: string | undefined): string {
  if (!head || !oid(head) || !oid(wt.base_head) || fs.realpathSync(wt.root) !== wt.root) throw new Error('Invalid worktree');
  return head;
}
async function changedPaths(wt: ManagedWorktree, head: string, run: WorktreeGit) {
  const [diff, pending] = await Promise.all([
    run(wt.root, [...diffNames, wt.base_head, head, '--']),
    neutralizeFilters(run, wt.root).then((filters) => status(wt.root, filters, false, run)),
  ]);
  const paths = fields(pending).filter((row) => row !== '?? node_modules' || !dependencyLink(wt));
  return { committed: fields(diff), dirty: paths.map((row) => row.slice(3)) };
}

export interface OverlapCandidate { job: string; worktree: ManagedWorktree }
type Overlap = { job: string; files: string[]; more?: number };
const MAX_SIBLINGS = 8, MAX_COMPARE_PATHS = 200, MAX_REPORT_PATHS = 20;
// At most four calls per sibling: diff + filter lookup in parallel, then status, then integration diff.
const overlapGit: WorktreeGit = (cwd, args) => git(cwd, args, 1000);

async function worktreeOverlaps(
  wt: ManagedWorktree, trees: Awaited<ReturnType<typeof list>>, mine: Set<string>,
  candidates: () => OverlapCandidate[],
): Promise<{ overlaps: Overlap[]; overlaps_incomplete?: true }> {
  const [main, ...linked] = trees;
  const registered = new Map(linked.filter((tree) => tree.path !== wt.root && tree.prunable === undefined)
    .map((tree) => [tree.path, tree]));
  if (!mine.size || !registered.size) return { overlaps: [] };
  let siblings;
  try {
    siblings = candidates().flatMap(({ job, worktree }) => {
      const tree = registered.get(worktree.root);
      if (!tree || worktree.main_root !== wt.main_root || tree.branch !== worktree.branch) return [];
      registered.delete(worktree.root); // One probe per registered checkout.
      return [{ job, worktree, head: tree.head }];
    });
  } catch { return { overlaps: [], overlaps_incomplete: true }; }
  let incomplete = siblings.length > MAX_SIBLINGS;
  const overlaps = await Promise.all(siblings.slice(0, MAX_SIBLINGS).map(async ({ job, worktree, head: listedHead }) => {
    try {
      const head = worktreeHead(worktree, listedHead);
      const { committed, dirty } = await changedPaths(worktree, head, overlapGit);
      const files = new Set(dirty.filter((path) => mine.has(path)));
      const compare = committed.filter((path) => mine.has(path) && !files.has(path)).sort();
      if (compare.length > MAX_COMPARE_PATHS) incomplete = true;
      if (compare.length) {
        try {
          if (!main?.head || !oid(main.head)) throw new Error('Missing main checkout HEAD');
          // Compare committed content only. A cherry-pick can change the commit ID, but not the file's contents.
          const checked = compare.slice(0, MAX_COMPARE_PATHS);
          const diff = await overlapGit(wt.main_root, ['--literal-pathspecs', ...diffNames, main.head, head, '--', ...checked]);
          const different = new Set(fields(diff));
          // A literal pathspec can also match descendants when the path became a directory.
          for (const path of checked) if (different.has(path)) files.add(path);
        } catch { incomplete = true; } // Dirty paths remain known even if the committed ones cannot be checked.
      }
      const more = files.size - MAX_REPORT_PATHS;
      if (files.size) return { job, files: [...files].sort().slice(0, MAX_REPORT_PATHS), ...(more > 0 ? { more } : {}) };
    } catch { incomplete = true; }
    return null;
  }));
  return { overlaps: overlaps.filter((row) => row !== null), ...(incomplete ? { overlaps_incomplete: true } : {}) };
}

export async function gitSummary(wt: ManagedWorktree, candidates: () => OverlapCandidate[] = () => []) {
  const base = { branch: wt.branch, base_head: wt.base_head };
  try {
    const trees = await list(wt.main_root);
    const head = worktreeHead(wt, trees.find((t) => t.path === wt.root && t.branch === wt.branch)?.head);
    const [{ committed, dirty }, commits] = await Promise.all([
      changedPaths(wt, head, git),
      git(wt.root, ['rev-list', '--count', `${wt.base_head}..${head}`, '--']),
    ]);
    const mine = new Set([...committed, ...dirty]);
    return { ...base, head, ahead_commits: Number(commits), changed_files: mine.size, dirty: dirty.length > 0,
      paths: [...mine].slice(0, MAX_REPORT_PATHS), ...await worktreeOverlaps(wt, trees, mine, candidates) };
  } catch { return { ...base, head: null, ahead_commits: null, changed_files: null, paths: null, dirty: null, overlaps: null }; }
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

export function managedReceiptMatches(id: string, job: { job: string; cwd: string; worktree: ManagedWorktree }) {
  const wt = job.worktree, name = basename(wt.root), owner = wt.owner ?? id;
  return job.job === id && /^j[0-9a-f]{16}$/.test(owner) && job.cwd === wt.root && wt.branch === `wt/${name}` &&
    /^[a-z0-9-]+$/.test(name) && name.endsWith(`-${owner.slice(-6)}`) && oid(wt.base_head) &&
    wt.root === pathFor(wt.main_root, name) &&
    fs.realpathSync(wt.main_root) === wt.main_root && fs.realpathSync(wt.root) === wt.root;
}

export async function reusableWorktree(
  source: { job: string; cwd: string; worktree?: ManagedWorktree },
  cwd: string,
): Promise<ManagedWorktree | null> {
  const wt = source.worktree;
  if (!wt) return null;
  try {
    if (!managedReceiptMatches(source.job, { ...source, worktree: wt })) return null;
    const [main, ...linked] = await list(cwd);
    if (!main || main.bare || fs.realpathSync(main.path) !== wt.main_root) return null;
    const tree = linked.find((t) => t.path === wt.root && t.branch === wt.branch);
    if (!tree || tree.locked !== undefined || tree.prunable !== undefined || !oid(tree.head)) return null;
    const common = await git(wt.main_root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (await git(wt.root, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']) !== `${wt.root}\n${common}`)
      return null;
    const index = await git(wt.root, ['ls-files', '-v', '-z']);
    if (fields(index).some((row) => /^[a-zS] /.test(row))) return null;
    const filters = await neutralizeFilters(git, wt.root);
    const pending = fields(await status(wt.root, filters, false));
    if (pending.some((row) => row !== '?? node_modules' || !dependencyLink(wt))) return null;
    return { ...wt, owner: wt.owner ?? source.job };
  } catch { return null; }
}

/** Cheap scan hint only: the reaper verifies the registered checkout and commit IDs with Git. */
export function mainHead(root: string): string | null {
  try {
    let dir = join(root, '.git');
    if (!fs.lstatSync(dir).isDirectory()) {
      const pointer = readBytes(dir, 4096)?.toString().trim().match(/^gitdir: (.+)$/)?.[1];
      if (!pointer) return null;
      dir = resolve(root, pointer);
    }
    const head = readBytes(join(dir, 'HEAD'), 4096)?.toString().trim();
    if (head && oid(head)) return head;
    const ref = head?.match(/^ref: (refs\/heads\/.+)$/)?.[1];
    if (!ref || ref.includes('..')) return null;
    const sha = readBytes(join(dir, ref), 4096)?.toString().trim() ??
      readBytes(join(dir, 'packed-refs'))?.toString().split('\n').find((row) => row.endsWith(` ${ref}`))?.split(' ')[0];
    return sha && oid(sha) ? sha : null;
  } catch { return null; }
}

const kept = (reason: string, checkedHead?: string) => ({ worktree_kept_reason: reason, worktree_checked_head: checkedHead });
function disposablePaths(home: string, root: string): string[] {
  if (!registeredProject(home, root).registered) return [];
  try {
    const globs = JSON.parse(fs.readFileSync(join(root, '.hud/project.json'), 'utf8')).worktree?.disposable;
    return Array.isArray(globs) && globs.every(g => typeof g === 'string') ? globs : [];
  } catch { return []; }
}
export async function reapWorktree(id: string, job: { job: string; cwd: string; worktree: ManagedWorktree }, home: string) {
  const wt = job.worktree;
  try {
    if (!managedReceiptMatches(id, job))
      return kept('worktree receipt does not match its checkout');
    const [main, ...linked] = await list(wt.main_root);
    const tree = linked.find((t) => t.path === wt.root && t.branch === wt.branch);
    if (main?.path !== wt.main_root || !oid(main.head) || !tree || tree.locked !== undefined || tree.prunable !== undefined || !oid(tree.head))
      return kept('worktree is not registered at the recorded branch and path, or is locked');
    const common = await git(wt.main_root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (await git(wt.root, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']) !== `${wt.root}\n${common}`)
      return kept('worktree belongs to a different repository');
    const head = tree.head!, base = main.head!;
    const filters = await neutralizeFilters(git, wt.root);
    const index = await git(wt.root, ['ls-files', '-v', '-z']);
    if (fields(index).some((row) => /^[a-zS] /.test(row))) return kept('worktree has hidden index entries');
    const pending = fields(await status(wt.root, filters, true));
    const globs = pending.some(row => row.startsWith('!! ')) ? disposablePaths(home, wt.main_root) : [];
    if (pending.some(row => !(row.startsWith('!! ') && globs.some(glob => matchesGlob(row.slice(3), glob))) &&
        (!/^(?:\?\?|!!) node_modules$/.test(row) || !dependencyLink(wt))))
      return kept('worktree is dirty (tracked, untracked or ignored files)');
    const nested = nestedGitReason(wt.root);
    if (nested) return kept(nested);
    let picked = false;
    if (head !== wt.base_head) {
      try { await git(wt.main_root, ['merge-base', '--is-ancestor', head, base]); }
      catch (error) {
        if ((error as { code?: number }).code !== 1) throw error;
        // Look for even one slice-only commit without an equivalent patch. Unlike git cherry,
        // this includes unmerged merge commits, whose conflict resolutions have no patch ID.
        if (await git(wt.main_root, ['rev-list', '--cherry-pick', '--right-only', '-1', `${base}...${head}`, '--']))
          return kept('worktree has unmerged commits', base);
        picked = true;
      }
    }
    if (pending.includes('?? node_modules')) fs.unlinkSync(join(wt.root, 'node_modules'));
    await git(wt.main_root, [...filters, 'worktree', 'remove', '--', wt.root]);
    // Don't delete a branch advanced independently during cleanup; Git also checks merge/checkout safety.
    if ((await git(wt.main_root, ['rev-parse', '--verify', `refs/heads/${wt.branch}`])).trim() !== head)
      return kept('worktree removed; branch changed during cleanup');
    try {
      // branch -d cannot recognize picks. Delete only the exact tip we proved equivalent.
      if (picked) await git(wt.main_root, ['update-ref', '--no-deref', '-d', `refs/heads/${wt.branch}`, head]);
      else await git(wt.main_root, ['branch', '-d', '--', wt.branch]);
    } catch { return kept('worktree removed; Git refused to delete its branch'); }
    return { worktree_removed_at: new Date().toISOString() };
  } catch { return kept('worktree cleanup could not be verified or completed'); }
}
