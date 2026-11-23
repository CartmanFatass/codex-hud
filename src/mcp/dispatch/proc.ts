/** Process and Herdr helpers shared by the dispatch harnesses. */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { herdrId, runHerdr } from '../../roles/herdr-run.js';
import { isQuotaFailure } from '../../roles/roster.js';
import type { Job, JobStatus } from '../job-contracts.js';
import { callerPane, rememberCallerHarness } from '../mcp/session-state.js';
import { bundled, hudHome, jobs, jobCache } from '../store/job-store.js';
import { ensureJobWatcher } from '../watch-pid.js';

export const binScript = (name: string) => join(bundled, 'bin', name);

export function run(
  command: string,
  argv: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv
): Promise<{ exit_code: number; stdout: string; stderr: string; notStarted: boolean }> {
  return new Promise((done) => {
    const child = spawn(command, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8').on('data', (data: string) => {
      stdout = (stdout + data).slice(-65536);
    });
    child.stderr.setEncoding('utf8').on('data', (data: string) => {
      stderr = (stderr + data).slice(-4096);
    });
    child.on('error', (error) => {
      stderr = (stderr + error.message).slice(-4096);
    });
    child.on('close', (code) => done({ exit_code: code ?? -1, stdout, stderr, notStarted: child.pid === undefined }));
  });
}
const AGENT_PANE_BUSY_DELAYS_MS = [100, 200, 400, 800] as const;
export function isAgentPaneBusy(result: Awaited<ReturnType<typeof run>>): boolean {
  if (result.exit_code === 0) return false;
  for (const text of [result.stdout, result.stderr]) {
    try {
      if (JSON.parse(text)?.error?.code === 'agent_pane_busy') return true;
    } catch { /* Herdr may also render plain text or trailing lines. */ }
    if (/\bagent_pane_busy\b/.test(text)) return true;
  }
  return false;
}
export async function startAgentWithBusyWait(argv: string[]) {
  let started = await run('herdr', argv);
  for (const delay of AGENT_PANE_BUSY_DELAYS_MS) {
    if (!isAgentPaneBusy(started)) return started;
    await sleep(delay);
    started = await run('herdr', argv);
  }
  return started;
}
export function refusedBeforeInput(result: Awaited<ReturnType<typeof run>>): boolean {
  if (result.exit_code === 0) return false;
  if (result.notStarted) return true;
  let code;
  try { code = JSON.parse(result.stdout)?.error?.code; } catch { /* Herdr can also render the error on stderr. */ }
  code ??= /^(?:Error:\s*)?(agent_not_ready|agent_not_found)(?=[:\s]|$)/.exec(result.stderr.trim())?.[1];
  return code === 'agent_not_ready' || code === 'agent_not_found';
}
export async function dispatchBase(cwd: string): Promise<string> {
  const git = await run('git', ['rev-parse', 'HEAD'], cwd);
  return git.exit_code === 0 ? git.stdout.trim() : 'HEAD';
}
export async function workspaceArgs(job: Job): Promise<string[]> {
  const result = await run('herdr', ['pane', 'get', job.herdr_pane]);
  if (result.exit_code !== 0) return [];
  try {
    const pane = JSON.parse(result.stdout).result.pane;
    if (job.herdr_pane === callerPane) rememberCallerHarness(pane.agent);
    return herdrId(pane.workspace_id) ? ['--workspace', pane.workspace_id] : [];
  } catch {
    return [];
  } // An unavailable caller lookup keeps herdr's default workspace.
}
export function ensureWatcher(): void {
  ensureJobWatcher(hudHome);
}
const wideChar = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;
function cut(text: string, max: number): string {
  const chars = [...text],
    wide = (char: string) => (wideChar.test(char) ? 2 : 1);
  let columns = chars.reduce((sum, char) => sum + wide(char), 0);
  if (columns <= max) return text;
  while (chars.length && columns > max - 1) columns -= wide(chars.pop()!);
  return chars.join('').trimEnd() + '…';
}

/**
 * The worker's herdr tab label: `<role> <package or brief title>` in about 28 columns, on one line (it is recorded as
 * TAB_NAME and pi-role-reap compares it with the tab). A short job suffix is added only when another open job's tab
 * already has the same label.
 */
export function tabLabel(job: Job, task: string): string {
  const lines = Buffer.from(task.slice(0, 4096)).subarray(0, 4096).toString('utf8').split(/\r?\n/);
  const title =
    job.package?.trim() || (lines.find((line) => /^#{1,6}\s/.test(line)) ?? lines.find((line) => line.trim()) ?? '');
  const label = cut(
    `${job.role} ${title.replace(/^#{1,6}\s+/, '')}`.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim(),
    28
  );
  const taken = jobs().flatMap((other) =>
    other.job === job.job || other.reaped_at
      ? []
      : [jobCache.readSession(other.job)?.fields.tabName]
  );
  return taken.includes(label) ? `${cut(label, 23)} ${job.job.slice(-4)}` : label;
}

export const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

export function paneText(stdout: string): string {
  try {
    const result = JSON.parse(stdout).result;
    if (typeof result?.read?.text === 'string') return result.read.text;
    if (typeof result?.text === 'string') return result.text;
  } catch {
    /* A plain-text screen is the text itself. */
  }
  return stdout;
}
export async function startupFailure(result: DispatchResult, pane: string): Promise<DispatchResult> {
  if (result.stderr.trim() && !/timed? out|timeout|agent_not_ready/i.test(result.stderr)) return result;
  const read = await runHerdr(['pane', 'read', pane, '--source', 'recent'], process.env, { budgetMs: 2000 });
  const reason = read.ok && paneText(read.stdout).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split('\n')
    .reverse().map((line) => line.trim()).find((line) =>
      /^(?:\[roles\]|(?:\w*Error|fatal):)\s+\S/i.test(line) || isQuotaFailure(line));
  return reason ? { ...result, stderr: reason } : result;
}

export type DispatchResult = {
  exit_code: number; stdout: string; stderr: string; code?: Job['dispatch_code'];
  preInput?: boolean; cleanupFailed?: boolean; status?: JobStatus; path?: string;
};
export const canTryNext = (job: Job, result: DispatchResult) => job.role !== 'sonic' && result.preInput && !result.cleanupFailed;
export const launchError = (stderr: string, code?: Job['dispatch_code']): DispatchResult => ({ exit_code: 1, stdout: '', stderr, code });
export async function rejectLaunch(result: DispatchResult, tab?: string): Promise<DispatchResult> {
  const cleanup = tab && await runHerdr(['tab', 'close', tab], process.env, { budgetMs: 3000 });
  return { ...result, preInput: true, cleanupFailed: Boolean(cleanup && !cleanup.ok) };
}
