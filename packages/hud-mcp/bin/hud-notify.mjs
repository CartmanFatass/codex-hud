/** Shared question/event delivery: watch, Codex queue, Antigravity mailbox, or typing. */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDistLock } from '../../../scripts/dist-lock.mjs';
import { pushAgyEvents } from './agy-events.mjs';

export { hasAgyEvents } from './agy-events.mjs';

function startTime(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
}

export function registerPiWatcher(pane, home) {
  if (!pane || basename(pane) !== pane) return;
  const dir = join(home, 'watchers'), file = join(dir, `${pane}.pid`), tmp = `${file}.${process.pid}.tmp`;
  try {
    const marker = JSON.stringify({ pid: process.pid, start: startTime(process.pid), pane, home: resolve(home) }) + '\n';
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, marker, { mode: 0o600, flag: 'wx' });
    try { fs.renameSync(tmp, file); }
    catch (error) { fs.unlinkSync(tmp); throw error; }
    return () => {
      try { if (fs.readFileSync(file, 'utf8') === marker) fs.unlinkSync(file); } catch { /* gone */ }
    };
  } catch { /* Without a marker the ordinary delivery path stays in use. */ }
}

export function watching(pane, home = process.env.HUD_HOME || join(homedir(), '.hud')) {
  try {
    if (!pane || basename(pane) !== pane) return false;
    const text = fs.readFileSync(join(home, 'watchers', `${pane}.pid`), 'utf8').trim();
    const native = text.startsWith('{') ? JSON.parse(text) : null;
    const pid = native ? native.pid : Number(text);
    if (!Number.isInteger(pid) || pid <= 1) return false;
    process.kill(pid, 0);
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    const env = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').map((s) => {
      const at = s.indexOf('='); return [s.slice(0, at), s.slice(at + 1)];
    }));
    if (env.HERDR_PANE_ID !== pane) return false;
    if (native) {
      const piEntry = /(?:^|\/)pi$|\/(?:@earendil-works|@mariozechner)\/pi-coding-agent\/dist\/cli\.js$/;
      const isPi = basename(argv[0]) === 'pi' || (/^(node|nodejs)$/.test(basename(argv[0])) && piEntry.test(argv[1] ?? ''));
      // Pi's installed binding supplies the home when it wasn't exported at process launch.
      return isPi && !env.HUD_JOB_DIR && native.pane === pane && native.home === resolve(home) &&
        (!env.HUD_HOME || resolve(env.HUD_HOME) === resolve(home)) &&
        typeof native.start === 'string' && native.start === startTime(pid);
    }
    return argv.includes('watch') && argv.some((arg) => /(?:^|\/)hud$/.test(arg)) && !argv.includes('--all') &&
      resolve(env.HUD_HOME || join(env.HOME || homedir(), '.hud')) === resolve(home);
  } catch { return false; } // Stale or reused PID: never suppress a question.
}
// Only jobs with a live, pane-bound MCP task suppress their direct question push.
export function taskDelivery(dir, pane) {
  try {
    const task = JSON.parse(fs.readFileSync(join(dir, 'mcp-task.json'), 'utf8'));
    return task.pane === pane && task.expires > Date.now() && Number.isInteger(task.pid) && task.pid > 1 &&
      typeof task.start === 'string' && startTime(task.pid) === task.start;
  } catch { return false; }
}
let runner;
const loadRunner = () => runner ??= withDistLock(() => import('../../../dist/roles/herdr-run.js'));

function deliveryResult(outcome) {
  const { exitCode: status, stdout, stderr, reason } = outcome;
  return { status, stdout, stderr, ...(status === null ? { error: new Error(stderr || reason) } : {}) };
}

export async function paneInfo(pane, env = process.env, { signal } = {}) {
  try {
    const { runHerdr } = await loadRunner();
    const got = await runHerdr(['pane', 'get', pane], env, { budgetMs: 2000, signal });
    return got.ok ? JSON.parse(got.stdout).result.pane : null;
  } catch { return null; }
}
// `done` is the unfocused, unread version of an idle prompt. Unknown and
// blocked panes are not safe to type into.
const agyIdle = (info) => info?.agent === 'agy' && (info.agent_status === 'idle' || info.agent_status === 'done');

export function notifyAgy(pane, messages, home, env, info, { signal } = {}) {
  return pushAgyEvents(pane, home, messages, env, agyIdle(info) ? async (text) => {
    // Another prompt may have started while this batch waited for the mailbox.
    if (!agyIdle(await paneInfo(pane, env, { signal })) || signal?.aborted) {
      return { status: 0, retry: true, detail: 'pending for Antigravity delivery' };
    }
    const { runHerdr } = await loadRunner();
    const outcome = await runHerdr(['agent', 'prompt', pane, text], env, { budgetMs: 20_000, killGraceMs: 500, signal });
    const sent = deliveryResult(outcome);
    if (sent.status !== 0) {
      // As with worker launch, retry only failures known to precede input.
      let code;
      try { code = JSON.parse(sent.stdout)?.error?.code; } catch { /* May be printed on stderr. */ }
      code ??= /^(?:Error:\s*)?(agent_not_ready|agent_not_found)(?=[:\s]|$)/.exec(sent.stderr?.trim() ?? '')?.[1];
      sent.retry = outcome.reason === 'unavailable' || code === 'agent_not_ready' || code === 'agent_not_found';
    }
    return sent;
  } : null);
}

export async function notify(pane, message, home, { queue = false, env = process.env, signal } = {}) {
  if (!queue && watching(pane, home)) return { status: 0, skipped: true };
  const info = await paneInfo(pane, env, { signal });
  const aborted = () => ({ status: null, stdout: '', stderr: '', error: new Error('aborted') });
  if (signal?.aborted) return aborted();
  if (info?.agent === 'agy') {
    const sent = await notifyAgy(pane, [message], home ?? (env.HUD_HOME || join(env.HOME || homedir(), '.hud')), env, info, { signal });
    if (!sent.accepted) return { status: 1, error: sent.error ?? new Error('Antigravity mailbox busy or full') };
    // Once persisted the event can still be delivered after a rejected prompt.
    return { status: 0, detail: sent.detail ?? (sent.status === 0 ? 'typed into Antigravity' : 'pending for Antigravity delivery') };
  }
  const { runCommand, runHerdr } = await loadRunner();
  let detail = '';
  if (info?.agent === 'codex' && info.agent_session?.value) {
    try {
      const got = await runHerdr(['pane', 'process-info', '--pane', pane], env, { budgetMs: 2000, killGraceMs: 500, signal });
      if (!got.ok) throw new Error(got.stderr || `process-info failed (${got.reason})`);
      const proc = JSON.parse(got.stdout).result.process_info.foreground_processes.find((p) => p.name === 'codex');
      if (!proc) throw new Error('Codex process not found');
      const entries = fs.readFileSync(`/proc/${proc.pid}/environ`, 'utf8').split('\0');
      const value = (key) => entries.find((s) => s.startsWith(`${key}=`))?.slice(key.length + 1);
      const CODEX_HOME = value('CODEX_HOME') || join(value('HOME') || homedir(), '.codex');
      // Leave headroom for the queue watcher to exit in 500 ms even if Codex ignores TERM.
      const outcome = await runCommand('codex', ['queue', '--thread', info.agent_session.value, '--message', message],
        { ...env, CODEX_HOME }, { budgetMs: 20_000, killGraceMs: 250, signal });
      const sent = deliveryResult(outcome);
      if (outcome.ok) return { ...sent, detail: 'pushed via codex queue' };
      throw new Error(sent.error?.message || sent.stderr || `exit ${sent.status}`);
    } catch (error) {
      if (signal?.aborted) return aborted();
      detail = `codex queue failed (${String(error.message).trim().slice(0, 200)}); fell back to typing`;
    }
  }
  const typed = await runHerdr(['agent', 'prompt', pane, message], env, { budgetMs: 20_000, killGraceMs: 500, signal });
  return { ...deliveryResult(typed), ...(detail ? { detail } : {}) };
}

export async function ensureQueueWatcher(pane, home, { signal } = {}) {
  try {
    if (!pane || watching(pane, home)) return;
    const agent = (await paneInfo(pane, process.env, { signal }))?.agent;
    if (signal?.aborted || (agent !== 'codex' && agent !== 'agy') || watching(pane, home)) return;
    const pidFile = join(home, 'watchers', `${pane}.pid`);
    fs.mkdirSync(join(home, 'watchers'), { recursive: true, mode: 0o700 });
    const hud = fileURLToPath(new URL('../../../bin/hud', import.meta.url));
    const child = spawn(process.execPath, [hud, 'watch', '--queue'], { detached: true, stdio: 'ignore' });
    const cleanup = () => {
      try { if (fs.readFileSync(pidFile, 'utf8').trim() === String(child.pid)) fs.unlinkSync(pidFile); } catch { /* gone */ }
    };
    child.on('error', cleanup);
    if (child.pid) fs.writeFileSync(pidFile, `${child.pid}\n`, { mode: 0o600 });
    child.unref();
  } catch { /* Dispatch still succeeds; questions retain the typed fallback. */ }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [home, launchPane, job, message = ''] = process.argv.slice(2);
  process.env.HUD_HOME = home;
  let pane = launchPane;
  if (/^j[0-9a-f]{16}$/.test(job)) {
    try {
      const dir = join(home, 'jobs', job);
      const receipt = JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8'));
      // An opt-in Pi DONE push must also leave child reports to their parent.
      if (receipt.parent_job && /^\[.*\] DONE /.test(message)) process.exit(0);
      if (typeof receipt.herdr_pane === 'string' && receipt.herdr_pane && !/[\x00-\x1f\x7f-\x9f]/.test(receipt.herdr_pane)) pane = receipt.herdr_pane;
      if (taskDelivery(dir, pane)) process.exit(0);
    } catch { /* No receipt: keep the launch delivery path. */ }
  }
  // pi-roles builds a file-write reply; the HUD main session answers through its MCP.
  const line = message.replace(/ \| reply: write .*$/, ` | reply: hud_respond job=${job} request_id=${message.match(/QUESTION (q\d+):/)?.[1] ?? ''}`);
  const result = await notify(pane, line);
  if (result.error) process.stderr.write(`${result.error.message}\n`);
  process.exitCode = result.status ?? 1;
}
