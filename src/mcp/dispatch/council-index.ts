/** Browser participants get pointers to original attachments, never their bodies. No fetch. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, relative, isAbsolute, basename } from 'node:path';
import { safeGitEnv, SAFE_GIT_ARGS } from '../../utils/git-safety.js';
import { jobFiles } from '../paths.js';
import { directory } from '../store/job-store.js';
import type { Job } from '../job-contracts.js';

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  try {
    const { stdout } = await exec('git', [...SAFE_GIT_ARGS, '--literal-pathspecs', ...args],
      { cwd, env: safeGitEnv(process.env), timeout: 3000, maxBuffer: 64 * 1024 });
    return stdout.trimEnd();
  } catch { return ''; }
}

// Emit just the repository slug; never send an arbitrary URL, credentials or host.
function githubRepo(remote: string) {
  const path = /^git@github\.com:(.+)$/i.exec(remote)?.[1] ?? (() => {
    try { const u = new URL(remote); if (u.hostname === 'github.com' && ['https:', 'ssh:'].includes(u.protocol)) return u.pathname.slice(1); }
    catch { /* Not a GitHub URL. */ }
  })();
  const slug = path?.replace(/\.git\/?$/, '');
  return slug && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug) ? slug : undefined;
}

export async function councilIndex(job: Job) {
  const attachments = [
    ...(job.context_files ?? []).map(path => ({ path, label: relative(job.cwd, path) })),
    ...(job.from_jobs ?? []).map(id => ({ path: join(directory(id), jobFiles.report), label: `${id} report` })),
  ];
  if (!attachments.length) return '';
  const root = await git(job.cwd, 'rev-parse', '--show-toplevel');
  const branch = root && await git(root, 'symbolic-ref', '-q', '--short', 'HEAD');
  const upstream = branch && await git(root, 'for-each-ref', '--format=%(upstream:remotename)%00%(upstream)', `refs/heads/${branch}`);
  const [trackedRemote, ref] = upstream.split('\0');
  const remote = trackedRemote && trackedRemote !== '.' ? trackedRemote : 'origin';
  const repo = root && githubRepo(await git(root, 'config', '--get', `remote.${remote}.url`));
  let commit = '';
  if (repo) {
    // Detached worktrees and branches without an upstream may still have a known remote HEAD.
    for (const candidate of [ref, branch && `refs/remotes/${remote}/${branch}`, `refs/remotes/${remote}/HEAD`]) {
      if (!candidate?.startsWith(`refs/remotes/${remote}/`)) continue;
      commit = await git(root, 'rev-parse', '--verify', `${candidate}^{commit}`);
      if (commit) break;
    }
  }
  const lines: string[] = [];
  for (const { path, label } of attachments) {
    const name = relative(root || job.cwd, path);
    if (repo && commit && !isAbsolute(name) && !name.startsWith('../')) {
      const [blob, atHead, atIndex, onRemote] = await Promise.all([
        git(root, 'hash-object', '--no-filters', '--', path), git(root, 'rev-parse', '--verify', `HEAD:${name}`),
        git(root, 'rev-parse', '--verify', `:${name}`), git(root, 'rev-parse', '--verify', `${commit}:${name}`),
      ]);
      if (blob && blob === atHead && blob === atIndex && blob === onRemote) {
        lines.push(`- ${JSON.stringify(label)}: https://github.com/${repo}/blob/${commit}/${name.split('/').map(encodeURIComponent).join('/')}`);
        continue;
      }
    }
    lines.push(`- ${JSON.stringify(isAbsolute(label) ? basename(label) : label)}: local-only`);
  }
  return `\n\nOriginal attachment index${repo ? ` (${repo}; ${commit ? `last known pushed commit ${commit}` : 'no verified pushed commit'})` : ''}:\n${lines.join('\n')}`;
}
