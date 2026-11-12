/** Git safety follows claude-hud 0.15.0's GHSA fixes: no lazy fetch/transport,
 * fsmonitor or repository filter execution; refuse driver names that cannot be overridden. */
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cachePath, cached, readBytes, saveJson, signature } from './storage.js';
import { safeGitEnv, SAFE_GIT_ARGS, FILTER_CONFIG_ARGS, filterOverrides } from '../utils/git-safety.js';
export interface GitView {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
}
interface GitCache {
  version: 1;
  at: number;
  directory: string;
  common: string;
  stamps: Record<string, string>;
  value: GitView | null;
}
const TTL = 2000;
export function collectParityGit(cwd: string, env: NodeJS.ProcessEnv, now = Date.now()): GitView | null {
  const file = cachePath(env, 'git', cwd),
    old = cached<GitCache>(file);
  const unchanged = old && Object.entries(old.stamps).every(([p, s]) => signature(p) === s);
  if (old && unchanged && now >= old.at && now - old.at < TTL) return old.value;
  const started = performance.now();
  const gitEnv = safeGitEnv(env);
  const base = [...SAFE_GIT_ARGS];
  const run = (args: string[], codes = [0]): string => {
    const remaining = 120 - (performance.now() - started);
    if (remaining < 1) throw new Error('git_budget');
    const r = spawnSync('git', [...base, ...args], {
      cwd,
      env: gitEnv,
      encoding: 'utf8',
      timeout: Math.max(1, Math.floor(remaining)),
      killSignal: 'SIGKILL',
      maxBuffer: 512 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.error || !codes.includes(r.status ?? -1)) throw new Error('git_unavailable');
    return r.stdout;
  };
  try {
    const discovered =
      old && unchanged
        ? null
        : run(['rev-parse', '--absolute-git-dir', '--git-common-dir', '--show-toplevel']).trim().split('\n');
    const directory = discovered ? resolve(cwd, discovered[0]) : old!.directory;
    const commonRaw = discovered?.[1] ?? old!.common,
      common = isAbsolute(commonRaw) ? commonRaw : resolve(cwd, commonRaw);
    base.push(...filterOverrides(run(FILTER_CONFIG_ARGS, [0, 1])));
    const output = run([
      'status',
      '--porcelain=v2',
      '--branch',
      '--ignore-submodules=dirty',
      '--untracked-files=normal',
    ]);
    const head = /^# branch\.head (.+)$/m.exec(output)?.[1];
    let branch = head ?? '';
    if (branch === '(detached)') {
      branch =
        unchanged && old?.value
          ? old.value.branch
          : run(['describe', '--tags', '--exact-match', 'HEAD'], [0, 128]).trim() ||
            run(['rev-parse', '--short', 'HEAD']).trim();
    }
    const ab = /^# branch\.ab \+(\d+) -(\d+)$/m.exec(output);
    const value: GitView | null = branch
      ? {
          branch,
          dirty: output.split('\n').some((l) => /^[12u?] /.test(l)),
          ahead: Number(ab?.[1] ?? 0),
          behind: Number(ab?.[2] ?? 0),
        }
      : null;
    const paths =
      old && unchanged
        ? Object.keys(old.stamps)
        : [
            join(directory, 'HEAD'),
            join(directory, 'index'),
            join(common, 'packed-refs'),
            join(common, 'config'),
            join(directory, 'config.worktree'),
          ];
    if (discovered) {
      // New nested repositories or replaced .git pointers invalidate the location cache.
      let p = resolve(cwd);
      for (let depth = 0; depth < 64; depth++) {
        paths.push(join(p, '.git'));
        if (p === discovered[2] || p === dirname(p)) break;
        p = dirname(p);
      }
    }
    try {
      const ref = readBytes(join(directory, 'HEAD'), 4096)?.toString().trim();
      if (ref?.startsWith('ref: refs/')) {
        const p = resolve(common, ref.slice(5));
        if (p.startsWith(common + '/')) paths.push(p, dirname(p));
      }
    } catch {
      /* no ref cache dependency */
    }
    const upstream = unchanged ? '' : run(['rev-parse', '--symbolic-full-name', '@{upstream}'], [0, 128]).trim();
    if (upstream.startsWith('refs/')) {
      const p = resolve(common, upstream);
      if (p.startsWith(common + '/')) paths.push(p);
    }
    const stamps = Object.fromEntries(paths.map((p) => [p, signature(p)]));
    try {
      saveJson(file, { version: 1, at: now, directory, common, stamps, value });
    } catch {
      /* optional cache */
    }
    return value;
  } catch {
    return null;
  }
}
