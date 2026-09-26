/**
 * Which repository the status bar describes.
 *
 * Codex is often started one level above the repository it works in: a
 * workspace folder holding a repo beside notes and data. The launch folder
 * then has no git status at all, and the bar showed no branch. The rollout
 * records where the work happens, as the directory of every command and the
 * path of every edited file, so the most recent of those that lies inside the
 * session's folder and inside a repository names the repository. Paths
 * outside that folder do not count: reading another project for reference
 * does not make it this session's repository.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GitTarget {
  /** Where to run git. */
  dir: string;
  /** The repository's top level, when it lies inside the session folder rather than containing it. */
  subRepo?: string;
}

/** A folder with more entries than this is not scanned for a lone repository. */
const CHILD_SCAN_LIMIT = 256;

/**
 * A `.git` that git itself would open: a directory with a HEAD, or the
 * `gitdir:` file of a linked worktree or submodule. A stray empty `.git`
 * folder, such as one left in a home directory, is not a repository.
 */
function hasGit(dir: string): boolean {
  const entry = path.join(dir, '.git');
  try {
    const stats = fs.statSync(entry);
    if (stats.isDirectory()) return fs.statSync(path.join(entry, 'HEAD')).isFile();
    return stats.isFile() && fs.readFileSync(entry, 'utf8').startsWith('gitdir:');
  } catch {
    return false;
  }
}

/** The nearest folder at or above `dir` that is the top of a repository. */
export function repoRootOf(dir: string): string | null {
  let current = path.resolve(dir);
  for (;;) {
    if (hasGit(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function within(base: string, dir: string): boolean {
  const relative = path.relative(base, dir);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** The one repository directly inside `base`, if there is exactly one. */
function soleChildRepo(base: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return null;
  }
  if (entries.length > CHILD_SCAN_LIMIT) return null;
  const repos = entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => path.join(base, entry.name))
    .filter(hasGit);
  return repos.length === 1 ? repos[0] : null;
}

/**
 * The first answer wins:
 * 1. a session or launch folder inside a repository: that repository, as before;
 * 2. the newest directory the rollout worked in, inside one of those folders
 *    and inside a repository;
 * 3. the only repository directly inside one of those folders, before the
 *    session has run anything.
 * Null when none applies; the bar then shows no git section.
 */
export function resolveGitTarget(folders: ReadonlyArray<string | undefined>, workDirs: readonly string[] = []): GitTarget | null {
  const bases = [...new Set(folders.filter((folder): folder is string => !!folder).map(folder => path.resolve(folder)))];
  for (const base of bases) {
    if (repoRootOf(base)) return { dir: base };
  }
  for (let i = workDirs.length - 1; i >= 0; i--) {
    const dir = path.resolve(workDirs[i]);
    const base = bases.find(folder => within(folder, dir));
    if (!base) continue;
    const repo = repoRootOf(dir);
    if (repo && within(base, repo)) return { dir: repo, subRepo: repo };
  }
  for (const base of bases) {
    const repo = soleChildRepo(base);
    if (repo) return { dir: repo, subRepo: repo };
  }
  return null;
}

/**
 * resolveGitTarget, worked out again only when its inputs change or the
 * answer is older than `ttlMs`. The bar asks every few seconds, and on a
 * slow mount such as WSL's /mnt/c each answer costs dozens of blocking stats.
 */
export class GitTargetCache {
  private key = '';
  private at = -Infinity;
  private value: GitTarget | null = null;
  constructor(private readonly ttlMs = 30_000, private readonly now: () => number = Date.now) {}
  resolve(folders: ReadonlyArray<string | undefined>, workDirs: readonly string[] = []): GitTarget | null {
    const key = JSON.stringify([folders, workDirs]);
    const now = this.now();
    if (key !== this.key || now - this.at >= this.ttlMs) {
      this.value = resolveGitTarget(folders, workDirs);
      this.key = key;
      this.at = now;
    }
    return this.value;
  }
}
