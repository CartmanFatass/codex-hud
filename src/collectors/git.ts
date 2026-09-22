/**
 * Git status collector.
 *
 * One `git status --porcelain=v2 --branch` invocation yields everything the
 * bar shows: branch, ahead/behind, the dirty flag and the file counts. The
 * previous implementation ran four synchronous `execSync` calls per refresh
 * (rev-parse, rev-list and `status --porcelain` twice), which blocked the
 * event loop for as long as the 5s timeout on slow mounts such as WSL
 * `/mnt/c`.
 *
 * A second cheap guard keeps git from being spawned at all: the mtimes of the
 * repository metadata that can change the answer (index, HEAD, the branch ref,
 * packed-refs, FETCH_HEAD) are remembered, and an unchanged signature reuses
 * the previous snapshot for up to CACHE_MAX_AGE_MS.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GitStatus } from '../types.js';

const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Longest a cached snapshot may be reused while no tracked git metadata file
 * changed. Edits that only touch the working tree leave no trace in the git
 * directory, so this bound is what makes them appear at all.
 */
const CACHE_MAX_AGE_MS = 10_000;

/** Status for a directory that is not a git repository (or git is unusable). */
function emptyGitStatus(): GitStatus {
  return {
    branch: null,
    isDirty: false,
    isGitRepo: false,
    ahead: 0,
    behind: 0,
    modified: 0,
    added: 0,
    deleted: 0,
    untracked: 0,
  };
}

export interface ParsedGitStatus {
  branch: string | null;
  detached: boolean;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  isDirty: boolean;
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
}

/**
 * Count one changed entry the way the old `--porcelain` (v1) reader did, so
 * the displayed numbers do not move with this change. In v2 an unchanged
 * half of the XY pair is `.` rather than a space; everything else matches.
 */
function countEntry(xy: string, counts: ParsedGitStatus): void {
  const index = xy[0] === '.' ? ' ' : xy[0];
  const worktree = xy[1] === '.' ? ' ' : xy[1];

  if (index === 'M' || worktree === 'M') {
    counts.modified++;
  } else if (index === 'A') {
    counts.added++;
  } else if (index === 'D' || worktree === 'D') {
    counts.deleted++;
  } else if (index === 'R' || index === 'C') {
    counts.modified++;
  }
}

/**
 * Parse `git status --porcelain=v2 --branch` output.
 *
 * Exported for tests: the shape of this output is the only contract between
 * the HUD and git, so it is pinned by fixtures rather than by running git.
 */
export function parseGitStatusPorcelainV2(output: string): ParsedGitStatus {
  const parsed: ParsedGitStatus = {
    branch: null,
    detached: false,
    oid: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    isDirty: false,
    modified: 0,
    added: 0,
    deleted: 0,
    untracked: 0,
  };

  for (const line of output.split('\n')) {
    const record = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!record) {
      continue;
    }

    if (record.startsWith('# branch.oid ')) {
      const oid = record.slice(13).trim();
      parsed.oid = oid === '(initial)' ? null : oid;
      continue;
    }
    if (record.startsWith('# branch.head ')) {
      const head = record.slice(14).trim();
      if (head === '(detached)') {
        parsed.detached = true;
      } else {
        parsed.branch = head;
      }
      continue;
    }
    if (record.startsWith('# branch.upstream ')) {
      parsed.upstream = record.slice(18).trim() || null;
      continue;
    }
    if (record.startsWith('# branch.ab ')) {
      // Absent entirely when the branch has no upstream, which stays 0/0.
      const counts = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (counts) {
        parsed.ahead = Number(counts[1]);
        parsed.behind = Number(counts[2]);
      }
      continue;
    }
    if (record.startsWith('#')) {
      continue;
    }

    const kind = record[0];
    if (record[1] !== ' ') {
      continue;
    }
    if (kind === '?') {
      parsed.isDirty = true;
      parsed.untracked++;
      continue;
    }
    if (kind === '1' || kind === '2' || kind === 'u') {
      parsed.isDirty = true;
      countEntry(record.slice(2, 4), parsed);
    }
    // `!` (ignored) is never requested, and anything else is not an entry.
  }

  return parsed;
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'color.ui=false',
        '-c', 'core.quotePath=true', ...args],
      {
        cwd,
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          GIT_NO_LAZY_FETCH: '1',
        },
      },
      (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

/**
 * Label for a detached HEAD: an exact tag if there is one, else the short SHA
 * the status header already reported. This is the only case that costs a
 * second git call, and only while HEAD stays detached.
 */
async function detachedLabel(cwd: string, oid: string | null): Promise<string | null> {
  try {
    const tag = (await runGit(cwd, ['describe', '--tags', '--exact-match'])).trim();
    if (tag) {
      return `tag:${tag}`;
    }
  } catch {
    // No exact tag on this commit; fall back to the SHA.
  }
  return oid && /^[0-9a-f]{7,}$/i.test(oid) ? oid.slice(0, 7) : null;
}

interface GitDirs {
  gitDir: string;
  commonDir: string;
}

function readCommonDir(gitDir: string): string {
  // A linked worktree keeps HEAD and index locally but shares refs.
  try {
    const raw = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    return raw ? path.resolve(gitDir, raw) : gitDir;
  } catch {
    return gitDir;
  }
}

/**
 * Locate the git directory without spawning git. Returns null when the path is
 * not inside a normal repository, in which case the caller falls back to a
 * time-only cache.
 */
function findGitDirs(cwd: string): GitDirs | null {
  let dir = path.resolve(cwd);

  for (;;) {
    const candidate = path.join(dir, '.git');
    let stats: fs.Stats | null = null;
    try {
      stats = fs.statSync(candidate);
    } catch {
      stats = null;
    }

    if (stats?.isDirectory()) {
      return { gitDir: candidate, commonDir: readCommonDir(candidate) };
    }
    if (stats?.isFile()) {
      try {
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(candidate, 'utf8'));
        if (match) {
          const gitDir = path.resolve(dir, match[1]);
          return { gitDir, commonDir: readCommonDir(gitDir) };
        }
      } catch {
        // Unreadable .git file: treat as unknown.
      }
      return null;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

async function fileStamp(file: string): Promise<string> {
  try {
    const stats = await fs.promises.stat(file);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return '-';
  }
}

/**
 * Fingerprint of the metadata that can change the answer: the index (staging,
 * commits, `git add`), HEAD (checkout), the current branch ref and packed-refs
 * (commits, resets), the upstream ref and FETCH_HEAD (fetch/pull).
 */
async function metadataSignature(
  dirs: GitDirs,
  branch: string | null,
  upstream: string | null
): Promise<string> {
  const files = [
    path.join(dirs.gitDir, 'index'),
    path.join(dirs.gitDir, 'HEAD'),
    path.join(dirs.commonDir, 'packed-refs'),
    path.join(dirs.commonDir, 'FETCH_HEAD'),
  ];
  if (branch && !branch.startsWith('tag:')) {
    files.push(path.join(dirs.commonDir, 'refs', 'heads', branch));
  }
  if (upstream) {
    files.push(path.join(dirs.commonDir, 'refs', 'remotes', upstream));
  }

  return (await Promise.all(files.map(fileStamp))).join('|');
}

interface CacheEntry {
  status: GitStatus;
  upstream: string | null;
  dirs: GitDirs | null;
  signature: string | null;
  at: number;
  inFlight: Promise<GitStatus> | null;
}

const cache = new Map<string, CacheEntry>();

/** Test seam: forget every cached snapshot. */
export function resetGitStatusCache(): void {
  cache.clear();
}

async function readGitStatus(cwd: string): Promise<{ status: GitStatus; upstream: string | null }> {
  let output: string;
  try {
    output = await runGit(cwd, ['status', '--porcelain=v2', '--branch']);
  } catch {
    // Not a repository, git missing, or a timeout: the bar shows no git
    // section, exactly as the previous rev-parse probe did on failure.
    return { status: emptyGitStatus(), upstream: null };
  }

  const parsed = parseGitStatusPorcelainV2(output);
  const branch = parsed.detached ? await detachedLabel(cwd, parsed.oid) : parsed.branch;

  return {
    status: {
      branch,
      isDirty: parsed.isDirty,
      isGitRepo: true,
      ahead: parsed.ahead,
      behind: parsed.behind,
      modified: parsed.modified,
      added: parsed.added,
      deleted: parsed.deleted,
      untracked: parsed.untracked,
    },
    upstream: parsed.upstream,
  };
}

/**
 * Collect git status for `cwd`, reusing the last snapshot while nothing in the
 * git directory changed. Concurrent callers share one in-flight invocation.
 */
export async function collectGitStatus(cwd?: string): Promise<GitStatus> {
  const key = path.resolve(cwd || process.cwd());
  const cached = cache.get(key);

  if (cached?.inFlight) {
    return cached.inFlight;
  }

  if (cached && Date.now() - cached.at < CACHE_MAX_AGE_MS) {
    if (cached.dirs) {
      const signature = await metadataSignature(cached.dirs, cached.status.branch, cached.upstream);
      if (signature === cached.signature) {
        return cached.status;
      }
    } else if (!cached.status.isGitRepo) {
      // Nothing to invalidate on: a directory only becomes a repository
      // through `git init`, which the age bound picks up soon enough.
      return cached.status;
    }
  }

  const inFlight = (async () => {
    const { status, upstream } = await readGitStatus(key);
    const dirs = findGitDirs(key);
    cache.set(key, {
      status,
      upstream,
      dirs,
      signature: dirs ? await metadataSignature(dirs, status.branch, upstream) : null,
      at: Date.now(),
      inFlight: null,
    });
    return status;
  })();

  cache.set(key, {
    status: cached?.status ?? emptyGitStatus(),
    upstream: cached?.upstream ?? null,
    dirs: cached?.dirs ?? null,
    signature: cached?.signature ?? null,
    at: cached?.at ?? 0,
    inFlight,
  });

  try {
    return await inFlight;
  } catch {
    const entry = cache.get(key);
    if (entry?.inFlight === inFlight) {
      cache.delete(key);
    }
    return cached?.status ?? emptyGitStatus();
  }
}

/**
 * Format git status for display
 */
export function formatGitStatus(status: GitStatus): string {
  if (!status.isGitRepo) {
    return '';
  }

  const branch = status.branch || 'unknown';
  const indicator = status.isDirty ? '●' : '';

  return `git:(${branch})${indicator ? ' ' + indicator : ''}`;
}
