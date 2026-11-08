/**
 * Argv for the four launch adapters. Herdr is always spawned with an argument
 * array. The Codex adapter is the one shell string, and every token in it is
 * single-quoted after a charset check.
 *
 * pi-role is asked for `--args-json`. Each string in that array must match the
 * same charset. The wrapper function, not an env-profile home, selects the
 * Codex account.
 */

import { join } from 'node:path';
import type { LaunchAdapterId } from './adapters.js';
import { isLaunchAdapter, ADAPTER_HARNESS } from './adapters.js';
import type { BackendProfile } from './routing.js';
import type { RoleName } from './roles.js';

/**
 * The Codex recipe sleeps 3s, then renames, and retries after a few more
 * seconds when the answer is `agent_not_found`. Three attempts, 3s apart.
 */
export const RENAME_BACKOFF_MS = [3000, 3000, 3000] as const;

const BARE = /^[A-Za-z0-9_.,:=/@+-]+$/;
const PANE = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,80}$/;

const PI_ROLE: Partial<Record<RoleName, string>> = {
  imp: 'implementer',
  sonic: 'implementer',
  reviewer: 'reviewer',
};

export class LaunchError extends Error {
  readonly name = 'LaunchError';

  constructor(
    readonly code: 'unsafe_launch' | 'role_unmapped' | 'pi_role_missing' | 'pi_role_failed' | 'binding_incomplete'
  ) {
    super(code);
  }
}

export function adapterOf(profile: BackendProfile): LaunchAdapterId {
  if (profile.executor !== 'herdr' || !profile.recipe || !isLaunchAdapter(profile.recipe)) {
    throw new LaunchError('binding_incomplete');
  }
  if (profile.harness !== ADAPTER_HARNESS[profile.recipe]) throw new LaunchError('binding_incomplete');
  return profile.recipe;
}

export function piRoleName(role: RoleName): string {
  const name = PI_ROLE[role];
  if (!name) throw new LaunchError('role_unmapped');
  return name;
}

/** Parent pane for `pi-role --orchestrator`, or null when the id is missing or unsafe. */
export function orchestratorPane(env: NodeJS.ProcessEnv): string | null {
  const value = env.HERDR_PANE_ID;
  return value && PANE.test(value) ? value : null;
}

export function piRoleArgv(role: RoleName, qaDirectory: string, orchestrator: string | null): string[] {
  const name = piRoleName(role);
  const argv = ['--args-json', name];
  if (orchestrator) argv.push('--orchestrator', orchestrator);
  argv.push('--qa-dir', qaDirectory);
  assertTokens(argv.filter((token) => !token.startsWith('--')));
  assertTokens(argv.filter((token) => token.startsWith('--')));
  return argv;
}

/** JSON array from `pi-role --args-json`. Every string must match the charset. */
export function parsePiRoleArgs(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new LaunchError('unsafe_launch');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== 'string')) {
    throw new LaunchError('unsafe_launch');
  }
  const words = parsed as string[];
  assertTokens(words);
  return words;
}

function assertTokens(tokens: readonly string[]): void {
  for (const token of tokens) {
    if (!BARE.test(token)) throw new LaunchError('unsafe_launch');
  }
}

/** Parsed pi-role words plus the job session directory and the binding's model. */
export function appendPiOverrides(parsed: readonly string[], profile: BackendProfile, sessionDir: string): string[] {
  const out = [...parsed];
  if (!out.includes('--session-dir')) out.push('--session-dir', sessionDir);
  if (!out.includes('--tui-mode')) out.push('--tui-mode', 'regular');
  if (profile.model && !out.includes('--model')) out.push('--model', profile.model);
  if (profile.effort && !out.includes('--thinking')) out.push('--thinking', profile.effort);
  assertTokens(out);
  return out;
}

/**
 * One shell string for `herdr pane run`. `profile.wrapper` is the function.
 * That function selects the account; this string does not set an account home.
 * Model and effort come from the profile. `service_tier=default` is set when
 * the profile did not already set it.
 */
export function codexShell(profile: BackendProfile): string {
  if (profile.wrapper !== 'codex' && profile.wrapper !== 'codex2') throw new LaunchError('binding_incomplete');
  const fn = profile.wrapper;
  const tokens: string[] = [fn];
  if (profile.model) tokens.push('-m', profile.model);
  if (profile.effort) tokens.push('-c', `model_reasoning_effort=${profile.effort}`);
  let tier = false;
  const args = profile.args;
  if (Array.isArray(args)) {
    for (const item of args) tokens.push(String(item));
  } else if (args) {
    const fields = args as Readonly<Record<string, string | number | boolean>>;
    for (const key of Object.keys(fields)) {
      if (key === 'service_tier') tier = true;
      tokens.push('-c', `${key}=${String(fields[key])}`);
    }
  }
  if (!tier) tokens.push('-c', 'service_tier=default');
  tokens.push('-s', 'danger-full-access', '-a', 'never');
  assertTokens(tokens);
  return tokens.map((token) => `'${token}'`).join(' ');
}

/** Flags checked against `grok --help`: `-m`, `--reasoning-effort`, `--permission-mode`. */
export function grokArgs(profile: BackendProfile): string[] {
  if (!profile.model || !profile.effort) throw new LaunchError('unsafe_launch');
  const args = ['-m', profile.model, '--reasoning-effort', profile.effort, '--permission-mode', 'bypassPermissions'];
  assertTokens(args);
  return args;
}

/** Flags checked against `claude --help`: `--model` and `--effort`. */
export function claudeArgs(profile: BackendProfile): string[] {
  if (!profile.model) throw new LaunchError('unsafe_launch');
  const args = ['--model', profile.model];
  if (profile.effort) args.push('--effort', profile.effort);
  assertTokens(args);
  return args;
}

export function qaDir(jobDirectory: string): string {
  return join(jobDirectory, 'qa');
}
