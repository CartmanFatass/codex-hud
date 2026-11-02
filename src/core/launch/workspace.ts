import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { digest, isCanonicalAbsolutePath, requireCanonicalAbsolutePath } from '../canonical.js';
import type { RunWorkspaceSnapshot } from '../types/observation.js';

export const MAX_WORKSPACE_GIT_MS = 20;

/**
 * One optional post-acceptance capture by the existing writer. Never call this
 * from a ledger transaction, rendering, or the accepted response's hot path.
 * There is no observer, retry, cache poll or Git mutation here.
 */
export async function captureLaunchWorkspace(
  cwd: string,
  options: { cwdAsOf: number; timeoutMs?: number; gitPath?: string }
): Promise<RunWorkspaceSnapshot> {
  requireCanonicalAbsolutePath(cwd);
  const timeoutMs = options.timeoutMs ?? MAX_WORKSPACE_GIT_MS;
  if (!Number.isFinite(options.cwdAsOf) || options.cwdAsOf < 0) throw new Error('invalid_workspace_time');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WORKSPACE_GIT_MS)
    throw new Error('invalid_workspace_budget');
  const base = (): RunWorkspaceSnapshot => ({
    cwdSource: 'launch_cwd',
    cwdAsOf: options.cwdAsOf,
    gitCapturedAt: Date.now(),
    gitMissingReason: null,
    worktreeRoot: null,
    gitCommonDir: null,
    repoId: null,
    identityKind: 'git-common-dir-v1',
    scope: 'local',
  });
  const result = await new Promise<{ stdout: string; reason: string | null }>((resolve) => {
    execFile(
      options.gitPath ?? 'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 16_384,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LC_ALL: 'C',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      },
      (error, stdout, stderr) => {
        const reason = error
          ? error.killed
            ? 'timeout'
            : error.code === 'ENOENT'
              ? 'git_unavailable'
              : stderr.includes('not a git repository')
                ? 'not_git'
                : 'git_unreadable'
          : null;
        resolve({ stdout, reason });
      }
    );
  });
  if (result.reason) return { ...base(), gitMissingReason: result.reason };
  // rev-parse emits one line per requested field. Ambiguous/newline paths are
  // unknown instead of guessed from a partial output or a parent directory.
  const lines = result.stdout.replace(/\n$/, '').split('\n');
  if (lines.length !== 2 || lines.some((line) => !isCanonicalAbsolutePath(line)))
    return { ...base(), gitMissingReason: 'git_output_invalid' };
  try {
    const [worktreeRoot, gitCommonDir] = await Promise.all(lines.map((line) => fs.realpath(line)));
    return {
      ...base(),
      worktreeRoot,
      gitCommonDir,
      // Contract 06's shared, canonical local repository identity algorithm.
      repoId: digest(['git-common-dir-v1', gitCommonDir]),
    };
  } catch {
    return { ...base(), gitMissingReason: 'git_paths_unreadable' };
  }
}
