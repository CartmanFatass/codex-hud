/**
 * herdr CLI used by the role facade. Arguments are an array, never a shell.
 * Account homes come from the caller's env map, not from this file.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { clearTimeout, setTimeout } from 'node:timers';

export interface HerdrOutcome {
  readonly ok: boolean;
  readonly reason: 'ok' | 'unavailable' | 'lost' | 'failed' | 'timeout' | 'aborted';
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly groupCleanupIssue?: string;
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
  readonly signal?: AbortSignal;
  /** Send SIGTERM first, then SIGKILL after this grace. Defaults to immediate SIGKILL. */
  readonly killGraceMs?: number;
  /** Unix only: isolate and signal a new group for helpers that own all their subprocesses. */
  readonly killProcessGroup?: boolean;
}

// A numeric PGID can be reused after the leader exits. Verify a live member of the
// detached session, not just kill(-pgid, 0), before signalling (including escalation).
function groupOwnership(pgid: number, token: string): 'owned' | 'gone' | 'unverified' {
  if (process.platform !== 'linux') return 'unverified';
  try { process.kill(-pgid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unverified'; }
  let unverified = false;
  const matches = (pid: string) => {
    try {
      const dir = `/proc/${pid}`;
      const stat = readFileSync(`${dir}/stat`, 'utf8');
      const [state, , group, session] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(group) !== pgid || Number(session) !== pgid || /^[ZXx]$/.test(state ?? '')) return false;
      unverified = true;
      return statSync(dir).uid === process.getuid?.() &&
        readFileSync(`${dir}/environ`, 'utf8').split('\0').includes(`HUD_REAP_GROUP_TOKEN=${token}`);
    } catch (error) {
      if (!['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) unverified = true;
      return false;
    }
  };
  if (matches(String(pgid))) return 'owned';
  try {
    if (readdirSync('/proc').some((pid) => /^\d+$/.test(pid) && matches(pid))) return 'owned';
  } catch { return 'unverified'; }
  return unverified ? 'unverified' : 'gone';
}

/** Run an argv-only command with bounded output, wall time and optional cancellation. */
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
    if (options?.signal?.aborted) {
      resolve({ ok: false, reason: 'aborted', stdout: '', stderr: '', exitCode: null });
      return;
    }
    const group = options?.killProcessGroup === true;
    // Private per-spawn identity inherited by the reaper's helpers; not user configuration.
    const token = group ? randomUUID() : undefined;
    const child = spawn(bin, argv, { env: token ? { ...env, HUD_REAP_GROUP_TOKEN: token } : env,
      detached: group, stdio: ['ignore', 'pipe', 'pipe'] });
    let groupCleanupIssue: string | undefined;
    const grace = Math.max(0, options?.killGraceMs ?? 0);
    let settled = false, exited = false, forced = false;
    let stopReason: 'timeout' | 'aborted' | 'overflow' | 'lost' | undefined;
    let budgetTimer: ReturnType<typeof setTimeout>, killTimer: ReturnType<typeof setTimeout> | undefined;
    let used = 0, stdout = '', stderr = '';
    const out = new StringDecoder('utf8'), err = new StringDecoder('utf8');
    const finish = (reason: HerdrOutcome['reason'], exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(budgetTimer);
      clearTimeout(killTimer);
      options?.signal?.removeEventListener('abort', abort);
      // Do not decode a partial character cut off by the byte limit.
      if (used < MAX_OUTPUT) { stdout += out.end(); stderr += err.end(); }
      resolve({ ok: reason === 'ok', reason, stdout, stderr: stderr || error || '', exitCode,
        ...(groupCleanupIssue ? { groupCleanupIssue } : {}) });
    };
    const closePipes = () => { child.stdout?.destroy(); child.stderr?.destroy(); };
    const finishStopped = () => {
      closePipes(); // Inherited pipes must not keep a cancelled call open.
      finish(stopReason === 'overflow' ? 'lost' : stopReason!, null);
    };
    const ownsGroup = () => {
      if (!child.pid || !token) return false;
      const ownership = groupOwnership(child.pid, token);
      if (ownership === 'unverified') groupCleanupIssue = `group ${child.pid} ownership unverified; not signalling`;
      return ownership === 'owned';
    };
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid || !ownsGroup()) return false;
      try { process.kill(-child.pid, signal); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        return false;
      }
    };
    const signalChild = (signal: NodeJS.Signals) => group ? signalGroup(signal) : !exited && child.kill(signal);
    const finishIfGone = () => {
      if (exited && (forced || !group || !ownsGroup())) { finishStopped(); return true; }
      return false;
    };
    const forceKill = () => {
      forced = true;
      const sent = signalChild('SIGKILL');
      if (!sent && groupCleanupIssue && !exited) { child.unref(); finishStopped(); return; }
      closePipes();
      // Wait for the child exit event even after SIGKILL, not for pipe closure.
      finishIfGone();
    };
    const stop = (reason: NonNullable<typeof stopReason>) => {
      if (settled || stopReason) return;
      stopReason = reason;
      clearTimeout(budgetTimer);
      if (finishIfGone()) return;
      const wait = reason === 'overflow' ? Math.min(grace || 250, 250) : grace;
      if (!wait) forceKill();
      else {
        signalChild('SIGTERM');
        killTimer = setTimeout(forceKill, wait);
      }
    };
    const abort = () => stop('aborted');
    options?.signal?.addEventListener('abort', abort, { once: true });
    budgetTimer = setTimeout(() => stop('timeout'), Math.max(0, budget));
    const take = (chunk: Buffer, which: 'out' | 'err') => {
      const available = MAX_OUTPUT - used;
      const kept = chunk.subarray(0, available);
      used += kept.length;
      if (which === 'out') stdout += out.write(kept);
      else stderr += err.write(kept);
      if (chunk.length > available) { closePipes(); stop('overflow'); }
    };
    child.stdout?.on('data', (chunk: Buffer) => take(chunk, 'out'));
    child.stderr?.on('data', (chunk: Buffer) => take(chunk, 'err'));
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (stopReason) finishStopped();
      else finish(error.code === 'ENOENT' ? 'unavailable' : 'lost', null, error.message);
    });
    child.once('exit', () => {
      exited = true;
      if (stopReason) finishIfGone();
      else if (group && (ownsGroup() || groupCleanupIssue)) stop('lost');
    });
    child.once('close', (code, signal) => {
      if (!stopReason) finish(signal !== null ? 'lost' : code === 0 ? 'ok' : 'failed', code);
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

export const herdrId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(value);

export function tabIds(stdout: string): { tabId: string; paneId: string } | null {
  const result = herdrResult(stdout);
  const tab = result && isRecord(result.tab) ? result.tab.tab_id : undefined;
  const pane = result && isRecord(result.root_pane) ? result.root_pane.pane_id : undefined;
  if (!herdrId(tab) || !herdrId(pane)) return null;
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
      tabId: herdrId(entry.tab_id) ? entry.tab_id : null,
      paneId: herdrId(entry.pane_id) ? entry.pane_id : null,
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
    if (!isRecord(entry) || !herdrId(entry.tab_id)) return null;
    tabs.push({
      label: typeof entry.label === 'string' ? entry.label : null,
      tabId: entry.tab_id,
      workspaceId: herdrId(entry.workspace_id) ? entry.workspace_id : null,
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
  if (!tab || !herdrId(tab.tab_id)) return null;
  return {
    label: typeof tab.label === 'string' ? tab.label : null,
    tabId: tab.tab_id,
    workspaceId: herdrId(tab.workspace_id) ? tab.workspace_id : null,
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
    if (!isRecord(entry) || !herdrId(entry.pane_id)) return null;
    const tabId = herdrId(entry.tab_id) ? entry.tab_id : null;
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
