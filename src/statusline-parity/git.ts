/** Git safety follows claude-hud 0.15.0's GHSA fixes: no lazy fetch/transport,
 * fsmonitor or repository filter execution; refuse driver names that cannot be overridden. */
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cachePath, cached, readBytes, saveJson, signature } from './storage.js';
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
  const configLocations = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM']);
  const gitEnv: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(env).filter(([k]) => !k.startsWith('GIT_') || configLocations.has(k))
  );
  Object.assign(gitEnv, {
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
  });
  const base = [
    '--no-pager',
    '--no-optional-locks',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'protocol.allow=never',
    '-c',
    'core.untrackedCache=false',
  ];
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
    const filters = run(['config', '--show-scope', '-z', '--get-regexp', '^filter\\.'], [0, 1]).split('\0');
    const drivers = new Set<string>();
    for (let i = 0; i + 1 < filters.length; i += 2) {
      if (filters[i] === 'global' || filters[i] === 'system') continue;
      const key = filters[i + 1].split('\n', 1)[0],
        name = key.slice(7, key.lastIndexOf('.'));
      if (!/^[\w.-]+$/.test(name)) throw new Error('unsafe_filter_name');
      drivers.add(name);
    }
    for (const name of drivers)
      base.push(
        '-c',
        `filter.${name}.clean=`,
        '-c',
        `filter.${name}.smudge=`,
        '-c',
        `filter.${name}.process=`,
        '-c',
        `filter.${name}.required=false`
      );
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
