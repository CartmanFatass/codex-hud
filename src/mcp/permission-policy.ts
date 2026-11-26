import { spawnSync } from 'node:child_process';
import { lstatSync, opendirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { SAFE_GIT_ARGS, safeGitEnv } from '../utils/git-safety.js';
import { dispatchChoice, dispatchDecision } from './dispatch-decision.js';
import { loadSettings } from '../settings.js';

export type PermissionDecision = { action: 'approve' | 'main'; reason: string };
export type PermissionRoots = { task: string; scratch?: string; temp?: string; worktree?: string };
const safePath = /^[A-Za-z0-9_./-]+$/;
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
};
const sensitive = /(?:^|\/)(?:\.[^/]+|secrets?|credentials?|tokens?|keys?)(?:\/|$)/i;

/** Parse a small regenerable shell form without invoking a shell or expanding general variables. */
export function permissionDirectory(command: string | undefined): string | undefined {
  const match = /^(?:S=([\w./-]+); )?rm -f (\$S|\$\{S\}|[\w./-]+)\/\*\.png$/.exec(command ?? '');
  if (!match || (match[1] && !match[2].startsWith('$'))) return;
  const path = match[2].startsWith('$') ? match[1] : match[2];
  if (!path || !safePath.test(path) || !isAbsolute(path) || path.split('/').includes('..')) return;
  return resolve(path);
}

/** Check the bounded glob against the actual directory and the worktree's Git index. */
function trackedPngs(root: string, dir: string) {
  const paths: string[] = [];
  const entries = opendirSync(dir);
  try {
    for (let i = 0; ; i++) {
      const item = entries.readSync();
      if (!item) break;
      if (i === 4096) return false;
      // Include case variants and dotfiles in the check: the tool shell's glob options are unknown.
      if (!item.name.toLowerCase().endsWith('.png')) continue;
      if (paths.length === 256 || !item.isFile() || !safePath.test(item.name) || sensitive.test(item.name)) return false;
      paths.push(relative(root, join(dir, item.name)));
    }
  } finally { entries.closeSync(); }
  if (!paths.length) return false;
  const git = (...args: string[]) => {
    const result = spawnSync('git', [...SAFE_GIT_ARGS, '--literal-pathspecs', ...args], {
      cwd: root, env: safeGitEnv(process.env), encoding: 'utf8', timeout: 400, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return !result.error && result.status === 0 ? result.stdout : undefined;
  };
  if (git('rev-parse', '--show-toplevel') !== `${resolve(root)}\n`) return false;
  const indexed = git('ls-files', '--stage', '-z', '--', ...paths)?.split('\0');
  if (indexed?.pop() !== '' || indexed.length !== paths.length) return false;
  const blobs = new Map<string, string>();
  for (const row of indexed) {
    const match = /^100(?:644|755) ([a-f0-9]+) 0\t(.+)$/.exec(row);
    if (!match) return false;
    blobs.set(match[2], match[1]);
  }
  if (!paths.every(path => blobs.has(path))) return false;
  // Unstaged bytes (and intent-to-add placeholders) are not preserved just because a path is indexed.
  const hashes = git('hash-object', '--no-filters', '--', ...paths)?.trimEnd().split('\n');
  return hashes?.length === paths.length && paths.every((path, i) => blobs.get(path) === hashes[i]);
}

/** Prove that the directory is job-owned and not reached by a symlink, and deletion is recoverable. */
export function permissionProof(command: string | undefined, roots: PermissionRoots): string | undefined {
  const absolute = permissionDirectory(command);
  if (!absolute) return;
  try {
    const st = lstatSync(absolute);
    if (!st.isDirectory() || st.uid !== process.getuid?.() || realpathSync(absolute) !== absolute) return;
    for (const [name, root] of [
      ['scratchpad', roots.scratch], ['temporary directory', roots.temp], ['task scratchpad', resolve(roots.task, 'scratchpad')],
    ] as const) {
      if (root && inside(root, absolute) && !sensitive.test(relative(root, absolute))) return name;
    }
    const worktree = roots.worktree;
    if (worktree && inside(worktree, absolute) && !sensitive.test(relative(worktree, absolute)) && trackedPngs(worktree, absolute))
      return 'worktree (Git-tracked files)';
  } catch { /* Unreadable or missing target is not proof. */ }
}

const reasons = {
  approve: 'Cleanup only removes recoverable or regenerable PNGs in the verified job-owned directory.',
  outside: 'The operation is not proven to stay inside this job’s roots.',
  irreversible: 'The operation is not proven reversible or regenerable.',
  restricted: 'The operation may involve network writes, secrets, git push or installation.',
  unsure: 'HUD could not prove that this operation is low risk.',
} as const;
const choices = Object.keys(reasons) as (keyof typeof reasons)[];

/** Only structural evidence leaves the machine: never send command arguments, environment or absolute paths. */
export async function classifyPermission(home: string, proof: string | undefined, decide = dispatchDecision): Promise<PermissionDecision> {
  const fallback: PermissionDecision = proof
    ? { action: 'approve', reason: `Local path check: verified PNG cleanup in the job’s ${proof}.` }
    : { action: 'main', reason: reasons.unsure };
  try {
    const { result } = await decide(home, loadSettings({ ...process.env, HUD_HOME: home }), 'worker-permission', {
      page: { url: '', title: 'Worker permission prompt', text: '' }, elements: [], statements: [], deltas: {},
      facts: { verified_operation: proof ? 'rm -f <directory>/*.png' : null, verified_root: proof ?? null },
      choices: [{ name: 'permission', statement: 'Classify a native worker permission prompt from the quoted structural facts only. Approve only with verified local proof of regenerable scratchpad or job temp cleanup, or recoverable Git-tracked files in the job’s own worktree, and no network write, secrets, git push, installs or other paths. If anything is missing or uncertain, hand to main and choose the best reason. Never deny.',
        choices: choices.map(value => ({ value, description: reasons[value] })) }],
    });
    const reason = result && dispatchChoice(result, 'permission', choices);
    if (reason && reason !== 'approve') return { action: 'main', reason: `Decision model: ${reasons[reason]}` };
    if (reason === 'approve' && proof) return { action: 'approve', reason: `Decision model and local path check: verified PNG cleanup in the job’s ${proof}.` };
  } catch { /* Missing credentials, invalid output or timeout: local proof only. */ }
  return fallback;
}