/** Owner gate for a project's `.hud/`. Writing `projects.json` is setup apply, not this module. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { SAFE_GIT_ARGS, safeGitEnv } from '../utils/git-safety.js';

export interface ProjectGate {
  root: string;
  registered: boolean;
  hud_dir: string;
}

/** Realpath of `git rev-parse --show-toplevel` in cwd, else realpath of cwd. Never throws. */
export function projectRoot(cwd: string): string {
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
}

function sameRoot(stored: string, root: string): boolean {
  if (stored === root) return true;
  try {
    return fs.realpathSync(stored) === root;
  } catch {
    return false;
  }
}

/** Missing or unparseable `projects.json` means nothing is registered. Never throws. */
export function registeredProject(hudHome: string, cwd: string): ProjectGate {
  const root = projectRoot(cwd);
  const hud_dir = join(root, '.hud');
  let registered = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(join(hudHome, 'projects.json'), 'utf8')) as {
      version?: unknown;
      projects?: unknown;
    };
    if (parsed && parsed.version === 1 && Array.isArray(parsed.projects)) {
      registered = parsed.projects.some((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
        const stored = (item as { root?: unknown }).root;
        return typeof stored === 'string' && stored.length > 0 && sameRoot(stored, root);
      });
    }
  } catch {
    registered = false;
  }
  return { root, registered, hud_dir };
}
