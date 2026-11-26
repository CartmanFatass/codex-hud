/** Process and Herdr helpers shared by the dispatch harnesses. */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { herdrId, runHerdr } from '../../roles/herdr-run.js';
import { jobCallerPane } from '../../roles/job-pane.js';
import { isQuotaFailure } from '../../roles/roster.js';
import type { Job, JobStatus } from '../job-contracts.js';
import type { DirectStartIdentity } from './direct-exec.js';
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
function cliError(result: DispatchResult): { code: string; message?: string } | undefined {
  for (const stream of [result.stderr, result.stdout]) {
    const text = stream.trim(), first = text.split(/\r?\n/, 1)[0];
    if (text.startsWith('{')) {
      for (const json of new Set([text, first])) {
        try {
          const error = JSON.parse(json)?.error;
          if (typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error.code))
            return { code: error.code, message: typeof error.message === 'string' ? error.message : undefined };
        } catch { /* Pretty-printed JSON, or a JSON line followed by CLI output. */ }
      }
    }
    const match = /^(?:Error:\s*)?(agent_not_ready|agent_not_found|invalid_agent_argument|agent_pane_busy|agent_blocked|agent_prompt_stalled)(?=[:\s]|$)[:\s]*(.*)$/.exec(first);
    if (match) return { code: match[1], message: match[2] };
  }
}
export function promptStalled(result: DispatchResult): boolean {
  return cliError(result)?.code === 'agent_prompt_stalled';
}
export function launchFailure(result: DispatchResult) {
  const error = cliError(result);
  const text = result.stderr.trim() || result.stdout.trim();
  const code = error?.code ?? result.code ?? result.status?.exit_reason ?? 'dispatch_failed';
  // An unrecognized CLI JSON envelope is still evidence, not a human-readable reason.
  const plain = text.startsWith('{') || (text.startsWith('[') && !text.startsWith('[roles]')) ? '' : text.split(/\r?\n/, 1)[0];
  const detail = error ? [code, error.message].filter(Boolean).join(': ') : plain;
  const reason = code === 'agent_pane_busy' && result.pane ? `agent_pane_busy: worker pane ${result.pane} is busy`
    : result.detail || detail || `launch exited ${result.exit_code}`;
  return { code, reason: reason.slice(0, 500), stderr_tail: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n').slice(-4096) };
}
export function refusedBeforeInput(result: Awaited<ReturnType<typeof run>>): boolean {
  return result.exit_code !== 0 && (result.notStarted ||
    ['agent_not_ready', 'agent_not_found', 'invalid_agent_argument'].includes(cliError(result)?.code ?? ''));
}
export async function dispatchBase(cwd: string): Promise<string> {
  const git = await run('git', ['rev-parse', 'HEAD'], cwd);
  return git.exit_code === 0 ? git.stdout.trim() : 'HEAD';
}
export function workspaceFromPaneId(pane: string | null | undefined): string | undefined {
  if (!pane) return undefined;
  const ws = pane.split(':', 1)[0];
  return ws && ws !== pane && herdrId(ws) ? ws : undefined;
}
export async function resolveWorkspace(pane: string | null | undefined): Promise<string | undefined> {
  if (!pane || !herdrId(pane)) return undefined;
  const result = await run('herdr', ['pane', 'get', pane]);
  if (result.exit_code === 0) {
    try {
      const ws = JSON.parse(result.stdout).result?.pane?.workspace_id;
      if (herdrId(ws)) return ws;
    } catch { /* Fall back to pane prefix when pane lookup is malformed. */ }
  }
  return workspaceFromPaneId(pane);
}
export async function workspaceArgs(job: Job): Promise<string[]> {
  const owner = jobCallerPane(job);
  if (owner) {
    const result = await run('herdr', ['pane', 'get', owner]);
    if (result.exit_code === 0) {
      try {
        const pane = JSON.parse(result.stdout).result.pane;
        if (owner === callerPane) rememberCallerHarness(pane.agent);
        if (herdrId(pane.workspace_id)) return ['--workspace', pane.workspace_id];
      } catch { /* Fall through to recorded workspace fallback. */ }
    }
  }
  const fallback = (herdrId(job.herdr_workspace) ? job.herdr_workspace : undefined) ?? workspaceFromPaneId(owner);
  return fallback ? ['--workspace', fallback] : [];
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
 * TAB_NAME and hud-reap compares it with the tab). A short job suffix is added only when another open job's tab
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
  if (result.stderr.trim() && !/timed? out|timeout|agent_not_ready/i.test(result.stderr)) return { ...result, pane };
  const read = await runHerdr(['pane', 'read', pane, '--source', 'recent'], process.env, { budgetMs: 2000 });
  const reason = read.ok && paneText(read.stdout).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split('\n')
    .reverse().map((line) => line.trim()).find((line) =>
      /^(?:\[roles\]|(?:\w*Error|fatal):)\s+\S/i.test(line) || isQuotaFailure(line));
  return { ...result, pane, ...(reason && { detail: reason }) };
}

/** Build explicit worker env for direct-exec `agent.start` from HUD's own process env plus job vars.
 * Forwards auth and toolchain vars (PATH, GOOGLE_*, NVM_*, credentials) while stripping parent
 * job/session/control handles and outer-terminal handles unless explicitly supplied in `extra`. */
const STRIPPED_PARENT_ENV = new Set([
  // Agent / parent session nesting handles
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CODEX_THREAD_ID',
  'OMPCODE',
  // HUD job/session/control handles
  'HUD_MCP_SURFACE',
  'HUD_MCP_PI_SESSION_ID',
  'HUD_MCP_JSON',
  'HUD_JOB_DIR',
  'HUD_TAB_LAUNCH',
  'HUD_INVOCATION_TOKEN',
  'HUD_RESUME_SESSION_ID',
  'HUD_REAP_GROUP_TOKEN',
  'HUD_CLAUDE_MOD',
  'HUD_DOCK_CALLER_PANE',
  // Outer-terminal / multiplexer handles
  'HERDR_PANE_ID',
  'HERDR_TAB_ID',
  'HERDR_WORKSPACE_ID',
  'HERDR_DOCK',
  'TMUX',
  'TMUX_PANE',
  'CODEX_HUD_TMUX_SESSION',
  'CODEX_HUD_TMUX_BIN',
  'STY',
  'WINDOW',
  'ZELLIJ',
  'ZELLIJ_SESSION_NAME',
  'ZELLIJ_PANE_ID',
  'WEZTERM_PANE',
  'WEZTERM_UNIX_SOCKET',
  'KITTY_WINDOW_ID',
  'KITTY_LISTEN_ON',
  'TERM_SESSION_ID',
  'ITERM_SESSION_ID',
  'WT_SESSION',
]);

export function directExecEnv(extra: Record<string, string>, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key || typeof value !== 'string' || STRIPPED_PARENT_ENV.has(key)) continue;
    if (key.includes('=') || key.includes('\0') || value.includes('\0')) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (!key || key.includes('=') || key.includes('\0') || value.includes('\0')) continue;
    env[key] = value;
  }
  return env;
}

export type DispatchResult = {
  exit_code: number; stdout: string; stderr: string; code?: Job['dispatch_code'];
  pane?: string; detail?: string; preInput?: boolean; cleanupFailed?: boolean; launchUnknown?: boolean;
  directRollback?: DirectStartIdentity; status?: JobStatus; path?: string;
};
export const canTryNext = (job: Job, result: DispatchResult) => (job.role !== 'sonic' || job.headless) &&
  result.code !== 'herdr_fork_required' && result.preInput && !result.cleanupFailed;
export const launchError = (stderr: string, code?: Job['dispatch_code']): DispatchResult => ({ exit_code: 1, stdout: '', stderr, code });
export function rejectLaunch(result: DispatchResult): DispatchResult {
  return { ...result, preInput: true, cleanupFailed: false };
}
