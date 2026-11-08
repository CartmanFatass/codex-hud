/**
 * herdr CLI used by the role facade. Arguments are an array, never a shell.
 * Account homes come from the caller's env map, not from this file.
 */

import type { HerdrHarness } from './routing.js';

export interface HerdrOutcome {
  readonly ok: boolean;
  readonly reason: 'ok' | 'unavailable' | 'lost' | 'failed' | 'timeout';
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

/** Wall clock when the argv has no `--timeout`. */
export const HERDR_DEFAULT_BUDGET_MS = 60_000;
/** Added to an explicit `--timeout` so the CLI can exit before we kill it. No smaller cap. */
export const HERDR_TIMEOUT_MARGIN_MS = 15_000;

const MAX_OUTPUT = 1024 * 1024;

export function herdrBudget(argv: readonly string[]): number {
  const index = argv.indexOf('--timeout');
  if (index >= 0) {
    const value = Number(argv[index + 1]);
    if (Number.isSafeInteger(value) && value >= 0) return value + HERDR_TIMEOUT_MARGIN_MS;
  }
  return HERDR_DEFAULT_BUDGET_MS;
}

export interface HerdrCallOptions {
  readonly budgetMs?: number;
}

/**
 * Spawn `bin` with `argv`. A timer kills the child and the outcome is `timeout`,
 * which the facade reports as `herdr_timeout`. An external signal stays `lost`.
 */
export async function runCommand(
  bin: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  options?: HerdrCallOptions
): Promise<HerdrOutcome> {
  const budget = options?.budgetMs ?? (bin === 'herdr' ? herdrBudget(argv) : HERDR_DEFAULT_BUDGET_MS);
  // File-only dispatch observations must not load subprocess machinery.
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    let settled = false;
    let killedByUs = false;
    let stdout = '';
    let stderr = '';
    let overflow = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: HerdrOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };
    const child = spawn(bin, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    timer = setTimeout(() => {
      if (settled) return;
      killedByUs = true;
      child.kill('SIGKILL');
      // A launcher descendant may retain the pipes. The outer budget still ends
      // this call; do not wait for close or sweep unrelated process groups.
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ ok: false, reason: 'timeout', stdout, stderr, exitCode: null });
    }, budget);
    const take = (chunk: Buffer, which: 'out' | 'err') => {
      const text = chunk.toString('utf8');
      const available = Math.max(0, MAX_OUTPUT - stdout.length - stderr.length);
      if (which === 'out') stdout += text.slice(0, available);
      else stderr += text.slice(0, available);
      if (text.length > available) {
        overflow = true;
        child.kill();
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => take(chunk, 'out'));
    child.stderr?.on('data', (chunk: Buffer) => take(chunk, 'err'));
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        reason: killedByUs ? 'timeout' : error.code === 'ENOENT' ? 'unavailable' : 'lost',
        stdout,
        stderr: stderr || error.message,
        exitCode: null,
      });
    });
    child.once('close', (code, signal) => {
      const timedOut = killedByUs;
      const lost = !timedOut && (overflow || signal !== null);
      finish({
        ok: !timedOut && !lost && code === 0,
        reason: timedOut ? 'timeout' : lost ? 'lost' : code === 0 ? 'ok' : 'failed',
        stdout,
        stderr,
        exitCode: code,
      });
    });
  });
}

export function runHerdr(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  options?: HerdrCallOptions
): Promise<HerdrOutcome> {
  return runCommand('herdr', argv, env, options);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parsed `result` object, or the top object when herdr omits the envelope. */
export function herdrResult(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) return null;
    return isRecord(parsed.result) ? parsed.result : parsed;
  } catch {
    return null;
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,80}$/;

export function tabIds(stdout: string): { tabId: string; paneId: string } | null {
  const result = herdrResult(stdout);
  const tab = result && isRecord(result.tab) ? result.tab.tab_id : undefined;
  const pane = result && isRecord(result.root_pane) ? result.root_pane.pane_id : undefined;
  if (typeof tab !== 'string' || typeof pane !== 'string' || !ID.test(tab) || !ID.test(pane)) return null;
  return { tabId: tab, paneId: pane };
}

export interface ListedAgent {
  readonly name: string;
  readonly tabId: string | null;
  readonly paneId: string | null;
  readonly status: string | null;
}

/**
 * `null` when the document is unreadable. Entries with no string `name` are
 * skipped: live `herdr agent list` includes unnamed agents.
 * An empty array is a real empty list.
 */
export function listedAgents(stdout: string): ListedAgent[] | null {
  const result = herdrResult(stdout);
  if (!result || !Array.isArray(result.agents)) return null;
  const agents: ListedAgent[] = [];
  for (const entry of result.agents) {
    if (!isRecord(entry)) return null;
    if (typeof entry.name !== 'string' || entry.name.length === 0) continue;
    agents.push({
      name: entry.name,
      tabId: typeof entry.tab_id === 'string' ? entry.tab_id : null,
      paneId: typeof entry.pane_id === 'string' ? entry.pane_id : null,
      status: typeof entry.agent_status === 'string' ? entry.agent_status : null,
    });
  }
  return agents;
}

export interface ListedTab {
  readonly label: string | null;
  readonly tabId: string;
  readonly workspaceId: string | null;
}

/** Live `herdr tab list` puts rows in `result.tabs` (`label`, `tab_id`). There is no pane id. */
export function listedTabs(stdout: string): ListedTab[] | null {
  const result = herdrResult(stdout);
  if (!result || !Array.isArray(result.tabs)) return null;
  const tabs: ListedTab[] = [];
  for (const entry of result.tabs) {
    if (!isRecord(entry) || typeof entry.tab_id !== 'string' || !ID.test(entry.tab_id)) return null;
    tabs.push({
      label: typeof entry.label === 'string' ? entry.label : null,
      tabId: entry.tab_id,
      workspaceId: typeof entry.workspace_id === 'string' ? entry.workspace_id : null,
    });
  }
  return tabs;
}

/**
 * `herdr tab get` returns `result.tab` with the same fields as a list row.
 * It does not include a pane id. Callers recover the root pane from `pane list`.
 */
export function tabInfo(stdout: string): ListedTab | null {
  const result = herdrResult(stdout);
  const tab = result && isRecord(result.tab) ? result.tab : null;
  if (!tab || typeof tab.tab_id !== 'string' || !ID.test(tab.tab_id)) return null;
  return {
    label: typeof tab.label === 'string' ? tab.label : null,
    tabId: tab.tab_id,
    workspaceId: typeof tab.workspace_id === 'string' ? tab.workspace_id : null,
  };
}

export interface ListedPane {
  readonly paneId: string;
  readonly tabId: string | null;
}

/** Live `herdr pane list` puts rows in `result.panes` (`pane_id`, `tab_id`). */
export function listedPanes(stdout: string): ListedPane[] | null {
  const result = herdrResult(stdout);
  if (!result || !Array.isArray(result.panes)) return null;
  const panes: ListedPane[] = [];
  for (const entry of result.panes) {
    if (!isRecord(entry) || typeof entry.pane_id !== 'string' || !ID.test(entry.pane_id)) return null;
    const tabId = typeof entry.tab_id === 'string' && ID.test(entry.tab_id) ? entry.tab_id : null;
    panes.push({ paneId: entry.pane_id, tabId });
  }
  return panes;
}

const STATUSES = new Set(['idle', 'working', 'blocked', 'done', 'unknown']);

export function agentStatus(stdout: string): string | null {
  const result = herdrResult(stdout);
  if (!result) return null;
  const agent = isRecord(result.agent) ? result.agent : result;
  const status = agent.agent_status ?? agent.status;
  return typeof status === 'string' && STATUSES.has(status) ? status : null;
}

export function tabCreateArgs(
  cwd: string,
  label: string,
  envVars: Readonly<Record<string, string>>,
  workspace: string | null
): string[] {
  const args = ['tab', 'create', '--cwd', cwd, '--label', label, '--no-focus'];
  if (workspace) args.push('--workspace', workspace);
  for (const key of Object.keys(envVars).sort()) args.push('--env', `${key}=${envVars[key]}`);
  return args;
}

export function agentStartArgs(
  agent: string,
  harness: HerdrHarness,
  paneId: string,
  agentArgs: readonly string[]
): string[] {
  return ['agent', 'start', agent, '--kind', harness, '--pane', paneId, '--timeout', '30000', '--', ...agentArgs];
}

export function promptArgs(agent: string, text: string, waitForWorking: boolean): string[] {
  const args = ['agent', 'prompt', agent, text];
  if (waitForWorking) args.push('--wait', '--until', 'working', '--timeout', '30000');
  return args;
}

export function waitArgs(agent: string, timeoutMs: number | null): string[] {
  const args = ['agent', 'wait', agent, '--until', 'idle', '--until', 'done', '--until', 'blocked'];
  if (timeoutMs !== null) args.push('--timeout', String(timeoutMs));
  return args;
}
