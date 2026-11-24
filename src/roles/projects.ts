/** Owner gate for a project's `.hud/`. Writing `projects.json` is setup apply, not this module. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { SAFE_GIT_ARGS, safeGitEnv } from '../utils/git-safety.js';
import { fileSignature } from '../utils/file-signature.js';

export interface ProjectGate {
  root: string;
  registered: boolean;
  hud_dir: string;
}

export interface ListedProject {
  root: string;
  name: string;
  /** Order in projects.json, independent of the pane-first project switcher. */
  registrationIndex: number;
  unavailable?: true;
}

const ROOT_TTL_MS = 2_000;
const MAX_ROOTS = 256;

function memoRoot(lookup: (cwd: string) => string) {
  const cache = new Map<string, { root: string; expires: number }>();
  return (cwd: string): string => {
    const key = isAbsolute(cwd) ? cwd : `${process.cwd()}${sep}${cwd}`;
    const prior = cache.get(key);
    if (prior && prior.expires > performance.now()) return prior.root;
    const root = lookup(cwd);
    cache.delete(key);
    if (cache.size >= MAX_ROOTS) cache.delete(cache.keys().next().value!);
    cache.set(key, { root, expires: performance.now() + ROOT_TTL_MS });
    return root;
  };
}

/** Realpath of `git rev-parse --show-toplevel` in cwd, else realpath of cwd. Never throws. */
export const projectRoot = memoRoot((cwd) => {
  let top = '';
  try {
    const git = spawnSync('git', [...SAFE_GIT_ARGS, 'rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      env: safeGitEnv(process.env),
      timeout: 5000,
    });
    if (git.status === 0) top = git.stdout.trim();
  } catch {
    top = '';
  }
  for (const candidate of [top, cwd]) {
    if (!candidate) continue;
    try {
      return fs.realpathSync(candidate);
    } catch {
      /* Missing path: try the next candidate. */
    }
  }
  return cwd;
});

/** The main checkout's root for cwd (shared by its linked worktrees), else projectRoot(cwd). Never throws. */
export const sharedRoot = memoRoot((cwd) => {
  try {
    const git = spawnSync('git', [...SAFE_GIT_ARGS, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      env: safeGitEnv(process.env),
      timeout: 5000,
    });
    const common = git.status === 0 ? git.stdout.trim() : '';
    if (common && basename(common) === '.git') return fs.realpathSync(resolve(common, '..'));
  } catch {
    /* Not a usable checkout: fall back. */
  }
  return projectRoot(cwd);
});

function sameRoot(stored: string, root: string): boolean {
  if (stored === root) return true;
  try {
    return fs.realpathSync(stored) === root;
  } catch {
    return false;
  }
}

export function projectRegistryRoots(value: unknown): string[] {
  const registry = value as { version?: unknown; projects?: unknown } | null;
  if (registry?.version !== 1 || !Array.isArray(registry.projects)) return [];
  return registry.projects.flatMap((item) => typeof item?.root === 'string' && item.root ? [item.root] : []);
}

/** Missing or unparseable `projects.json` means nothing is registered. Never throws. */
export function registeredProject(hudHome: string, cwd: string): ProjectGate {
  const root = projectRoot(cwd);
  const hud_dir = join(root, '.hud');
  let registered = false;
  try {
    registered = projectRegistryRoots(JSON.parse(fs.readFileSync(join(hudHome, 'projects.json'), 'utf8')))
      .some((stored) => sameRoot(stored, root));
  } catch {
    registered = false;
  }
  return { root, registered, hud_dir };
}

function realDir(path: string): string | null {
  try {
    const real = fs.realpathSync(path);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

let listCache: { file: string; stamp: string | null; roots: string[] } | undefined;

/** Registered projects only, pane root first if registered. Missing roots keep their stored identity. */
export function projectList(hudHome: string, panelRoot: string): ListedProject[] {
  const file = join(hudHome, 'projects.json'), stamp = fileSignature(file);
  if (listCache?.file !== file || listCache.stamp !== stamp) {
    let roots: string[] = [];
    if (stamp !== null) try { roots = projectRegistryRoots(JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch { /* Missing or unparseable registry. */ }
    listCache = { file, stamp, roots };
  }
  const first = realDir(panelRoot) ?? resolve(panelRoot), out: ListedProject[] = [], seen = new Set<string>();
  for (const [registrationIndex, stored] of listCache.roots.entries()) {
    const real = realDir(stored), root = real ?? resolve(stored);
    if (seen.has(root)) continue;
    seen.add(root);
    const item: ListedProject = { root, name: basename(root) || root, registrationIndex, ...(!real && { unavailable: true }) };
    if (root === first) out.unshift(item);
    else out.push(item);
  }
  return out;
}
