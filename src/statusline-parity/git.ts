/** Git safety follows claude-hud 0.15.0's GHSA fixes: no lazy fetch/transport,
 * fsmonitor or repository filter execution; refuse driver names that cannot be overridden. */
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
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
const GIT_BUDGET_MS = 120;
const GIT_MAX_BUFFER = 512 * 1024;

function runGitAsync(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  timeoutMs: number,
  codes: readonly number[]
): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    if (timeoutMs < 1) {
      rejectRun(new Error('git_budget'));
      return;
    }
    const child = spawn('git', args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (err: Error | null, stdout = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) rejectRun(err);
      else resolveRun(stdout);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
      finish(new Error('git_budget'));
    }, Math.max(1, Math.floor(timeoutMs)));
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > GIT_MAX_BUFFER) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already exited */
        }
        finish(new Error('git_unavailable'));
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', () => finish(new Error('git_unavailable')));
    child.on('close', (code, signal) => {
      if (signal !== null || !codes.includes(code ?? -1)) {
        finish(new Error('git_unavailable'));
        return;
      }
      finish(null, Buffer.concat(chunks).toString('utf8'));
    });
  });
}

export async function collectParityGit(
  cwd: string,
  env: NodeJS.ProcessEnv,
  now = Date.now()
): Promise<GitView | null> {
  const file = cachePath(env, 'git', cwd),
    old = cached<GitCache>(file);
  const unchanged = old && Object.entries(old.stamps).every(([p, s]) => signature(p) === s);
  if (old && unchanged && now >= old.at && now - old.at < TTL) return old.value;
  const started = performance.now();
  const gitEnv = safeGitEnv(env);
  const base = [...SAFE_GIT_ARGS];
  const run = (args: string[], codes = [0], extraBase: readonly string[] = base): Promise<string> =>
    runGitAsync(cwd, gitEnv, [...extraBase, ...args], GIT_BUDGET_MS - (performance.now() - started), codes);
  try {
    const [discoveredRaw, filterConfigRaw] = await Promise.all([
      old && unchanged
        ? Promise.resolve(null)
        : run(['rev-parse', '--absolute-git-dir', '--git-common-dir', '--show-toplevel']),
      run(FILTER_CONFIG_ARGS, [0, 1]),
    ]);
    const discovered = discoveredRaw === null ? null : discoveredRaw.trim().split('\n');
    const directory = discovered ? resolve(cwd, discovered[0]) : old!.directory;
    const commonRaw = discovered?.[1] ?? old!.common,
      common = isAbsolute(commonRaw) ? commonRaw : resolve(cwd, commonRaw);
    const safeStatusBase = [...base, ...filterOverrides(filterConfigRaw)];
    const [output, upstreamRaw] = await Promise.all([
      run(
        ['status', '--porcelain=v2', '--branch', '--ignore-submodules=dirty', '--untracked-files=normal'],
        [0],
        safeStatusBase
      ),
      unchanged ? Promise.resolve('') : run(['rev-parse', '--symbolic-full-name', '@{upstream}'], [0, 128], base),
    ]);
    const head = /^# branch\.head (.+)$/m.exec(output)?.[1];
    let branch = head ?? '';
    if (branch === '(detached)') {
      branch =
        unchanged && old?.value
          ? old.value.branch
          : (await run(['describe', '--tags', '--exact-match', 'HEAD'], [0, 128], safeStatusBase)).trim() ||
            (await run(['rev-parse', '--short', 'HEAD'], [0], safeStatusBase)).trim();
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
    const upstream = upstreamRaw.trim();
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
