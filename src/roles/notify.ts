/** Shared question/event delivery: watch, Codex queue, Antigravity mailbox, or typing. */
import { readJsonFile, writePrivateFile } from '../utils/atomic-fs.js';
import type { DeliveryVia } from '../utils/delivery-record.js';
import { isProcAlive, isValidPid, procStat, readProcCmdline, readProcEnviron } from '../utils/proc.js';
import { runHerdr, runCommand, type HerdrOutcome } from './herdr-run.js';
import type { McpTaskMarker } from '../mcp/job-contracts.js';
import { jobFiles } from '../mcp/paths.js';
import { request } from '../runtime/herdr-socket.js';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pushAgyEvents, type Delivery } from '../../packages/hud-mcp/bin/agy-events.mjs';

export { hasAgyEvents } from '../../packages/hud-mcp/bin/agy-events.mjs';

export type NotifyOutcome = 'sent' | 'refused' | 'indeterminate';

export type NotifyResult = Delivery & {
  stdout?: string; stderr?: string; skipped?: boolean;
  retryPrompt?: (text: string, signal?: AbortSignal) => Promise<NotifyResult>;
  uncertain?: true;
  outcome?: NotifyOutcome;
  via?: DeliveryVia;
};

export function notifyOutcome(
  result: Pick<NotifyResult, 'outcome' | 'status' | 'skipped' | 'uncertain' | 'retry' | 'retryPrompt'>,
): NotifyOutcome {
  if (result.outcome) return result.outcome;
  if (result.skipped) return 'refused';
  if (result.status === 0) return 'sent';
  if (result.uncertain) return 'indeterminate';
  if (result.retry || result.retryPrompt) return 'refused';
  return 'indeterminate';
}
type Pane = { agent?: string; agent_status?: string; agent_session?: { kind?: string; value?: string } };
type Options = { signal?: AbortSignal };

export function registerPiWatcher(pane: string, home: string) {
  return registerWatcher(pane, home);
}

export function registerWatcher(pane: string, home: string, client?: 'claude-mod') {
  if (!pane || basename(pane) !== pane) return;
  const file = join(home, 'watchers', `${pane}.pid`);
  try {
    const start = procStat(process.pid)?.start;
    if (!start) return;
    const marker = JSON.stringify({ pid: process.pid, start, pane, home: resolve(home), client }) + '\n';
    writePrivateFile(file, marker);
    return () => {
      try { if (fs.readFileSync(file, 'utf8') === marker) fs.unlinkSync(file); } catch { /* gone */ }
    };
  } catch { /* Without a marker the ordinary delivery path stays in use. */ }
}

export function watchingMod(pane: string | null, home: string) {
  return watching(pane, home, true);
}

export function watching(pane: string | null, home = process.env.HUD_HOME || join(homedir(), '.hud'), modOnly = false) {
  try {
    if (!pane || basename(pane) !== pane) return false;
    const text = fs.readFileSync(join(home, 'watchers', `${pane}.pid`), 'utf8').trim();
    const native = text.startsWith('{') ? JSON.parse(text) : null;
    if (modOnly && native?.client !== 'claude-mod') return false;
    const pid = native ? native.pid : Number(text);
    if (!isValidPid(pid)) return false;
    const argv = readProcCmdline(pid), env = readProcEnviron(pid);
    if (!argv?.length || env?.HERDR_PANE_ID !== pane) return false;
    if (native) {
      const piEntry = /(?:^|\/)pi$|\/(?:@earendil-works|@mariozechner)\/pi-coding-agent\/dist\/cli\.js$/;
      const isPi = basename(argv[0]) === 'pi' || (/^(node|nodejs)$/.test(basename(argv[0])) && piEntry.test(argv[1] ?? ''));
      // Pi's installed binding supplies the home when it wasn't exported at process launch.
      const matches = native.client === 'claude-mod'
        ? /^(node|nodejs)$/.test(basename(argv[0])) && basename(argv[1] ?? '') === 'hud' && argv[2] === 'watch' && argv[3] === '--mod' &&
          resolve(env.HUD_HOME || join(env.HOME || homedir(), '.hud')) === resolve(home)
        : native.client === undefined && isPi && (!env.HUD_HOME || resolve(env.HUD_HOME) === resolve(home));
      return matches && !env.HUD_JOB_DIR && native.pane === pane && native.home === resolve(home) &&
        typeof native.start === 'string' && isProcAlive(pid, native.start);
    }
    return isProcAlive(pid) && argv.includes('watch') && argv.some((arg) => /(?:^|\/)hud$/.test(arg)) && !argv.includes('--all') &&
      resolve(env.HUD_HOME || join(env.HOME || homedir(), '.hud')) === resolve(home);
  } catch { return false; } // Stale or reused PID: never suppress a question.
}
// Only jobs with a live, pane-bound MCP task suppress their direct question push.
export function taskDelivery(dir: string, pane: string) {
  try {
    const task = readJsonFile(join(dir, jobFiles.task)) as McpTaskMarker;
    return task.pane === pane && task.expires > Date.now() && isValidPid(task.pid) &&
      typeof task.start === 'string' && isProcAlive(task.pid, task.start);
  } catch { return false; }
}

function deliveryResult(outcome: HerdrOutcome): NotifyResult {
  const { exitCode: status, stdout, stderr, reason } = outcome;
  return { status, stdout, stderr, ...(status === null ? { error: new Error(stderr || reason) } : {}) };
}

export async function paneInfo(pane: string | null, env = process.env, { signal }: Options = {}): Promise<Pane | null> {
  try {
    const got = await runHerdr(['pane', 'get', pane!], env, { budgetMs: 2000, signal });
    return got.ok ? JSON.parse(got.stdout).result.pane : null;
  } catch { return null; }
}
// `done` is the unfocused, unread version of an idle prompt. Unknown and
// blocked panes are not safe to type into.
const agyIdle = (info: Pane | null) => info?.agent === 'agy' && (info.agent_status === 'idle' || info.agent_status === 'done');

const guardRefusals = new Set(['not_ready', 'scrolled_back', 'recent_input', 'draft_present', 'prompt_unknown']);
const nonSendRefusals = new Set(['agent_not_ready', 'agent_not_found', 'pane_not_found', ...guardRefusals]);
const codexQueueRefusalCodes = new Set(['not_found', 'thread_not_found', 'session_not_found', 'no_rollout', 'rollout_not_found', 'unavailable', 'invalid_argument', 'queue_full']);

export function classifyCodexQueueOutcome(outcome: HerdrOutcome): { kind: NotifyOutcome; reason: string } {
  if (outcome.ok) return { kind: 'sent', reason: '' };
  const reason = outcome.stderr.trim() || outcome.reason || `exit ${outcome.exitCode}`;
  if (outcome.reason === 'unavailable') return { kind: 'refused', reason };
  if (outcome.reason !== 'failed') return { kind: 'indeterminate', reason };
  let code: string | undefined;
  try { code = JSON.parse(outcome.stdout)?.error?.code; } catch { /* Plain stderr diagnostic. */ }
  const refused = (typeof code === 'string' && codexQueueRefusalCodes.has(code)) ||
    (outcome.exitCode === 2 && /^error: unrecognized subcommand\b/i.test(outcome.stderr.trim()));
  return { kind: refused ? 'refused' : 'indeterminate', reason };
}
export const PROMPT_QUIET_MS = 3000; // Also the fork's default input_quiet_ms.
export const PROMPT_RETRY_TTL_MS = 10 * 60_000;

export function recordPromptExpiry(home: string) {
  // Detached queue watchers have no stderr reader. Keep just the latest diagnostic, without notice text.
  try { writePrivateFile(join(home, 'watchers', 'typed-expiry.log'), `${new Date().toISOString()} pending typed notice expired\n`); }
  catch { /* Diagnostics must not prevent expiry. */ }
}

async function typeMainNotice(pane: string | null, text: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<NotifyResult> {
  const pending = (retryPrompt: NonNullable<NotifyResult['retryPrompt']>): NotifyResult =>
    ({ status: 1, retry: true, retryPrompt, outcome: 'refused' });
  const abortedRefusal = (): NotifyResult =>
    ({ status: null, stdout: '', stderr: '', error: new Error('aborted'), retry: true, outcome: 'refused' });
  const guarded = async (message: string, attemptSignal?: AbortSignal): Promise<NotifyResult> => {
    if (attemptSignal?.aborted) return abortedRefusal();
    const reply = await request('agent.prompt', { target: pane, text: message, guarded: true }, { env, signal: attemptSignal, timeoutMs: 20_000 });
    if (reply?.error && guardRefusals.has(reply.error.code)) return pending(guarded);
    if (reply?.error && nonSendRefusals.has(reply.error.code)) {
      return { status: 1, retry: true, stderr: reply.error.message || reply.error.code, outcome: 'refused' };
    }
    if (!reply?.error && reply?.result?.type === 'agent_prompted') return { status: 0, outcome: 'sent', via: 'herdr-prompt' };
    // A lost/failed reply after submission does not prove that zero bytes were written.
    return { status: 1, uncertain: true, outcome: 'indeterminate' };
  };
  if (signal?.aborted) return abortedRefusal();
  const reply = await request('ping', {}, { env, signal, timeoutMs: 500 });
  if (signal?.aborted) return abortedRefusal();
  if (reply?.error || reply?.result?.type !== 'pong') return pending((message, attemptSignal) => typeMainNotice(pane, message, env, attemptSignal));
  if (reply.result.capabilities?.guarded_prompt === true) return guarded(text, signal);
  const outcome = await runHerdr(['agent', 'prompt', pane!, text], env, { budgetMs: 20_000, killGraceMs: 500, signal });
  const sent = deliveryResult(outcome);
  if (sent.status === 0) {
    sent.outcome = 'sent';
    sent.via = 'herdr-prompt';
    return sent;
  }
  // Only positive non-send evidence justifies retry; timeouts and unknown failures are indeterminate.
  let code: string | undefined;
  try { code = JSON.parse(sent.stdout!)?.error?.code; } catch { /* May be printed on stderr. */ }
  code ??= /^(?:Error:\s*)?(agent_not_ready|agent_not_found|pane_not_found|not_ready|scrolled_back|recent_input|draft_present|prompt_unknown)(?=[:\s]|$)/.exec(sent.stderr?.trim() ?? '')?.[1];
  const refused = outcome.reason === 'unavailable' || (typeof code === 'string' && nonSendRefusals.has(code));
  if (refused) {
    sent.retry = true;
    sent.outcome = 'refused';
  } else {
    sent.retry = false;
    sent.uncertain = true;
    sent.outcome = 'indeterminate';
  }
  return sent;
}

export function notifyAgy(pane: string, messages: string[], home: string, env: NodeJS.ProcessEnv, info: Pane | null, { signal }: Options = {}) {
  return pushAgyEvents(pane, home, messages, env, writePrivateFile, agyIdle(info) ? async (text) => {
    if (signal?.aborted) return { status: 0, retry: true, detail: 'pending for Antigravity delivery' };
    // The fork's guarded prompt rechecks readiness when it writes input.
    const sent = await typeMainNotice(pane, text, env, signal);
    return sent.retryPrompt ? { status: 0, retry: true, guardPending: true, detail: 'pending for Antigravity delivery' } : sent;
  } : null);
}

export async function notify(pane: string | null, message: string, home?: string, { queue = false, env = process.env, signal }: Options & { queue?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<NotifyResult> {
  if (!queue && watching(pane, home)) return { status: 0, skipped: true };
  const info = await paneInfo(pane, env, { signal });
  const aborted = (): NotifyResult => ({ status: null, stdout: '', stderr: '', error: new Error('aborted'), outcome: 'refused' });
  if (signal?.aborted) return aborted();
  if (info?.agent === 'agy') {
    const sent = await notifyAgy(pane!, [message], home ?? (env.HUD_HOME || join(env.HOME || homedir(), '.hud')), env, info, { signal });
    if (!sent.accepted) return { status: 1, outcome: 'refused', error: sent.error ?? new Error('Antigravity mailbox busy or full') };
    // Once persisted the event can still be delivered after a rejected prompt.
    return { status: 0, outcome: 'sent', via: 'agy-mailbox', detail: sent.detail ?? (sent.status === 0 ? 'typed into Antigravity' : 'pending for Antigravity delivery') };
  }

  let detail = '';
  if (info?.agent === 'codex' && info.agent_session?.value) {
    let codexStarted = false;
    try {
      const got = await runHerdr(['pane', 'process-info', '--pane', pane!], env, { budgetMs: 2000, killGraceMs: 500, signal });
      if (!got.ok) throw new Error(got.stderr || `process-info failed (${got.reason})`);
      const proc = JSON.parse(got.stdout).result.process_info.foreground_processes.find((p: { name: string }) => p.name === 'codex');
      if (!proc) throw new Error('Codex process not found');
      const account = readProcEnviron(proc.pid);
      if (!account) throw new Error('Codex process environment unreadable');
      const CODEX_HOME = account.CODEX_HOME || join(account.HOME || homedir(), '.codex');
      if (signal?.aborted) return aborted();
      codexStarted = true;
      // Leave headroom for the queue watcher to exit in 500 ms even if Codex ignores TERM.
      const outcome = await runCommand('codex', ['queue', '--thread', info.agent_session.value, '--message', message],
        { ...env, CODEX_HOME }, { budgetMs: 20_000, killGraceMs: 250, signal });
      const sent = deliveryResult(outcome);
      const classified = classifyCodexQueueOutcome(outcome);
      if (classified.kind === 'sent') return { ...sent, outcome: 'sent', via: 'codex-queue', detail: 'pushed via codex queue' };
      if (signal?.aborted) return { ...aborted(), uncertain: true, outcome: 'indeterminate' };
      if (classified.kind === 'indeterminate') {
        return {
          ...sent,
          retry: false,
          uncertain: true,
          outcome: 'indeterminate',
          detail: `codex queue outcome uncertain (${classified.reason.slice(0, 200)}); did not fall back to typing`,
        };
      }
      throw new Error(classified.reason);
    } catch (error) {
      if (signal?.aborted) return codexStarted ? { ...aborted(), uncertain: true, outcome: 'indeterminate' } : aborted();
      detail = `codex queue failed (${String((error as Error).message).trim().slice(0, 200)}); fell back to typing`;
    }
  }
  const typed = await typeMainNotice(pane, message, env, signal);
  return { ...typed, ...(detail && !typed.retryPrompt ? { detail } : {}) };
}

export async function ensureQueueWatcher(pane: string | undefined, home: string) {
  try {
    if (!pane || watching(pane, home)) return;
    const agent = (await paneInfo(pane))?.agent;
    if ((agent !== 'codex' && agent !== 'agy') || watching(pane, home)) return;
    const pidFile = join(home, 'watchers', `${pane}.pid`);
    fs.mkdirSync(join(home, 'watchers'), { recursive: true, mode: 0o700 });
    const hud = fileURLToPath(new URL('../../bin/hud', import.meta.url));
    const child = spawn(process.execPath, [hud, 'watch', '--queue'], { detached: true, stdio: 'ignore' });
    const cleanup = () => {
      try { if (fs.readFileSync(pidFile, 'utf8').trim() === String(child.pid)) fs.unlinkSync(pidFile); } catch { /* gone */ }
    };
    child.on('error', cleanup);
    if (child.pid) writePrivateFile(pidFile, `${child.pid}\n`, { mkdir: false });
    child.unref();
  } catch { /* Dispatch still succeeds; questions retain the typed fallback. */ }
}
