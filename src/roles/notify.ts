/** Shared question/event delivery: watch, Codex queue, Antigravity mailbox, or typing. */
import { readJsonFile, writePrivateFile } from '../utils/atomic-fs.js';
import { isProcAlive, isValidPid, procStat, readProcCmdline, readProcEnviron } from '../utils/proc.js';
import { runHerdr, runCommand, type HerdrOutcome } from './herdr-run.js';
import type { McpTaskMarker } from '../mcp/job-contracts.js';
import { jobFiles } from '../mcp/paths.js';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pushAgyEvents, type Delivery } from '../../packages/hud-mcp/bin/agy-events.mjs';

export { hasAgyEvents } from '../../packages/hud-mcp/bin/agy-events.mjs';

type NotifyResult = Delivery & { stdout?: string; stderr?: string; skipped?: boolean };
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

export function notifyAgy(pane: string, messages: string[], home: string, env: NodeJS.ProcessEnv, info: Pane | null, { signal }: Options = {}) {
  return pushAgyEvents(pane, home, messages, env, writePrivateFile, agyIdle(info) ? async (text) => {
    // Another prompt may have started while this batch waited for the mailbox.
    if (!agyIdle(await paneInfo(pane, env, { signal })) || signal?.aborted) {
      return { status: 0, retry: true, detail: 'pending for Antigravity delivery' };
    }

    const outcome = await runHerdr(['agent', 'prompt', pane, text], env, { budgetMs: 20_000, killGraceMs: 500, signal });
    const sent = deliveryResult(outcome);
    if (sent.status !== 0) {
      // As with worker launch, retry only failures known to precede input.
      let code;
      try { code = JSON.parse(sent.stdout!)?.error?.code; } catch { /* May be printed on stderr. */ }
      code ??= /^(?:Error:\s*)?(agent_not_ready|agent_not_found)(?=[:\s]|$)/.exec(sent.stderr?.trim() ?? '')?.[1];
      sent.retry = outcome.reason === 'unavailable' || code === 'agent_not_ready' || code === 'agent_not_found';
    }
    return sent;
  } : null);
}

export async function notify(pane: string | null, message: string, home?: string, { queue = false, env = process.env, signal }: Options & { queue?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<NotifyResult> {
  if (!queue && watching(pane, home)) return { status: 0, skipped: true };
  const info = await paneInfo(pane, env, { signal });
  const aborted = () => ({ status: null, stdout: '', stderr: '', error: new Error('aborted') });
  if (signal?.aborted) return aborted();
  if (info?.agent === 'agy') {
    const sent = await notifyAgy(pane!, [message], home ?? (env.HUD_HOME || join(env.HOME || homedir(), '.hud')), env, info, { signal });
    if (!sent.accepted) return { status: 1, error: sent.error ?? new Error('Antigravity mailbox busy or full') };
    // Once persisted the event can still be delivered after a rejected prompt.
    return { status: 0, detail: sent.detail ?? (sent.status === 0 ? 'typed into Antigravity' : 'pending for Antigravity delivery') };
  }

  let detail = '';
  if (info?.agent === 'codex' && info.agent_session?.value) {
    try {
      const got = await runHerdr(['pane', 'process-info', '--pane', pane!], env, { budgetMs: 2000, killGraceMs: 500, signal });
      if (!got.ok) throw new Error(got.stderr || `process-info failed (${got.reason})`);
      const proc = JSON.parse(got.stdout).result.process_info.foreground_processes.find((p: { name: string }) => p.name === 'codex');
      if (!proc) throw new Error('Codex process not found');
      const account = readProcEnviron(proc.pid);
      if (!account) throw new Error('Codex process environment unreadable');
      const CODEX_HOME = account.CODEX_HOME || join(account.HOME || homedir(), '.codex');
      // Leave headroom for the queue watcher to exit in 500 ms even if Codex ignores TERM.
      const outcome = await runCommand('codex', ['queue', '--thread', info.agent_session.value, '--message', message],
        { ...env, CODEX_HOME }, { budgetMs: 20_000, killGraceMs: 250, signal });
      const sent = deliveryResult(outcome);
      if (outcome.ok) return { ...sent, detail: 'pushed via codex queue' };
      throw new Error(sent.error?.message || sent.stderr || `exit ${sent.status}`);
    } catch (error) {
      if (signal?.aborted) return aborted();
      detail = `codex queue failed (${String((error as Error).message).trim().slice(0, 200)}); fell back to typing`;
    }
  }
  const typed = await runHerdr(['agent', 'prompt', pane!, message], env, { budgetMs: 20_000, killGraceMs: 500, signal });
  return { ...deliveryResult(typed), ...(detail ? { detail } : {}) };
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
