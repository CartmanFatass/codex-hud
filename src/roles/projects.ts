/** Owner gate for a project's `.hud/`. Writing `projects.json` is setup apply, not this module. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { readFileBounded } from '../utils/atomic-fs.js';
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

/** Ticket operations need the checkout and common root without starting Git. */
export function localProjectRoots(cwd: string): { checkout: string; mainRoot: string } {
  let start: string;
  try { start = fs.realpathSync(cwd); } catch { start = resolve(cwd); }
  const pointer = (path: string) => {
    const { bytes, truncated } = readFileBounded(path, 4096);
    return truncated ? '' : bytes.toString('utf8').trim();
  };
  for (let checkout = start; ; checkout = dirname(checkout)) {
    const dot = join(checkout, '.git');
    try {
      const stat = fs.statSync(dot, { throwIfNoEntry: false });
      if (stat?.isDirectory() && fs.statSync(join(dot, 'HEAD'), { throwIfNoEntry: false })?.isFile()) return { checkout, mainRoot: checkout };
      if (stat?.isFile()) {
        const match = /^gitdir: (.+)$/.exec(pointer(dot));
        if (match) {
          const gitDir = resolve(checkout, match[1]);
          const common = pointer(join(gitDir, 'commondir'));
          if (common) {
            const commonDir = fs.realpathSync(resolve(gitDir, common));
            if (basename(commonDir) === '.git') return { checkout, mainRoot: dirname(commonDir) };
          }
          return { checkout, mainRoot: checkout };
        }
      }
    } catch { return { checkout, mainRoot: checkout }; }
    if (checkout === dirname(checkout)) return { checkout: start, mainRoot: start };
  }
}

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

/** Registered project name matching `dir` (exact or enclosing registered root), else undefined. */
export function registeredProjectName(hudHome: string, dir: string): string | undefined {
  if (!dir) return undefined;
  const projects = projectList(hudHome, dir);
  if (!projects.length) return undefined;
  const root = sharedRoot(dir);
  const target = realDir(root) ?? resolve(root);
  const exact = projects.find((p) => p.root === target);
  if (exact) return exact.name;
  let best: ListedProject | undefined;
  for (const p of projects) {
    const prefix = p.root.endsWith(sep) ? p.root : p.root + sep;
    if (target.startsWith(prefix) && (!best || p.root.length > best.root.length)) best = p;
  }
  return best?.name;
}
