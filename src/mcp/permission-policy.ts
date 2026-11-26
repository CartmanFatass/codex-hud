import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { dispatchChoice, dispatchDecision } from './dispatch-decision.js';
import { loadSettings } from '../settings.js';

export type PermissionDecision = { action: 'approve' | 'main'; reason: string };
export type PermissionRoots = { task: string; scratch?: string; temp?: string; variable?: string };
const safePath = /^[A-Za-z0-9_./-]+$/;
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
};
const sensitive = /(?:^|\/)(?:\.[^/]+|secrets?|credentials?|tokens?|keys?)(?:\/|$)/i;

/** Parse a small regenerable shell form without invoking a shell or expanding general variables. */
export function permissionDirectory(command: string | undefined, variable?: string): string | undefined {
  const match = /^(?:S=([\w./-]+); )?rm -f (\$S|\$\{S\}|[\w./-]+)\/\*\.png$/.exec(command ?? '');
  if (!match || (match[1] && !match[2].startsWith('$'))) return;
  const path = match[2].startsWith('$') ? match[1] ?? variable : match[2];
  if (!path || !safePath.test(path) || !isAbsolute(path) || path.split('/').includes('..')) return;
  return resolve(path);
}

/** Prove that the exact directory is job-owned, not reached by a symlink. */
export function permissionProof(command: string | undefined, roots: PermissionRoots): string | undefined {
  const absolute = permissionDirectory(command, roots.variable);
  if (!absolute) return;
  for (const [name, root] of [
    ['scratchpad', roots.scratch], ['temporary directory', roots.temp],
    ['task scratchpad', resolve(roots.task, 'scratchpad')], ['task directory', roots.task],
  ] as const) {
    if (!root || !inside(root, absolute) || sensitive.test(relative(root, absolute))) continue;
    try {
      const st = lstatSync(absolute);
      if (st.isDirectory() && st.uid === process.getuid?.() && realpathSync(absolute) === absolute) return name;
    } catch { /* Unreadable or missing target is not proof. */ }
  }
}

const reasons = {
  approve: 'Cleanup only removes regenerable PNG outputs in the verified job-owned directory.',
  outside: 'The operation is not proven to stay inside this job’s roots.',
  irreversible: 'The operation is not proven reversible or regenerable.',
  restricted: 'The operation may involve network writes, secrets, git push or installation.',
  unsure: 'HUD could not prove that this operation is low risk.',
} as const;
const choices = Object.keys(reasons) as (keyof typeof reasons)[];

/** Only structural evidence leaves the machine: never send command arguments, environment or absolute paths. */
export async function classifyPermission(home: string, proof: string | undefined, decide = dispatchDecision): Promise<PermissionDecision> {
  const fallback: PermissionDecision = proof
    ? { action: 'approve', reason: `Local path check: regenerable PNG cleanup in the job’s ${proof}.` }
    : { action: 'main', reason: reasons.unsure };
  try {
    const { result } = await decide(home, loadSettings({ ...process.env, HUD_HOME: home }), 'worker-permission', {
      page: { url: '', title: 'Worker permission prompt', text: '' }, elements: [], statements: [], deltas: {},
      facts: { verified_operation: proof ? 'rm -f <directory>/*.png' : null, verified_root: proof ?? null },
      choices: [{ name: 'permission', statement: 'Classify a native worker permission prompt from the quoted structural facts only. Approve only if the operation stays in the job’s own worktree, task dir, scratchpad or temp directory, is reversible or regenerable, and involves no network write, secrets, git push, installs or other paths. If anything is missing or uncertain, hand to main and choose the best reason. Never deny.',
        choices: choices.map(value => ({ value, description: reasons[value] })) }],
    });
    const reason = result && dispatchChoice(result, 'permission', choices);
    if (reason && reason !== 'approve') return { action: 'main', reason: `Decision model: ${reasons[reason]}` };
    if (reason === 'approve' && proof) return { action: 'approve', reason: `Decision model and local path check: regenerable PNG cleanup in the job’s ${proof}.` };
  } catch { /* Missing credentials, invalid output or timeout: local proof only. */ }
  return fallback;
}