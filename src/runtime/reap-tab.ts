/** One explicit job. A pane ID, a label or an empty agent inventory is not proof
 * of ownership. The shell and occupants must still carry the launch environment. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { jobFiles } from '../mcp/paths.js';
import type { JobStatus } from '../mcp/job-contracts.js';
import { fileStampOf } from '../roles/job-index-cache.js';
import { isActiveProcState, isValidPid, readProcStat } from '../utils/proc.js';
import { herdrId } from '../roles/herdr-run.js';
import { invocationWitness } from './cli-invocation.js';
import { herdrEndpoint, isHudHerdrFork } from './herdr-socket.js';
import { confirmIdleShells } from './tab-shell.js';
import { sameTaskDirectory, tabProcessStart } from './tab-owner.js';

const command = (args: string[], timeout = 15_000) => spawnSync('herdr', args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL' });
function query(args: string[], timeout?: number) {
  const r = command(args, timeout);
  if (r.status !== 0) throw Error(`herdr ${args.join(' ')}: ${r.error?.message ?? r.stderr}`);
  return JSON.parse(r.stdout).result;
}
type Row = { pane_id: string; tab_id: string; launch_id?: string; terminal_id?: string; name?: string; agent?: string; agent_status?: string; agent_session?: { value: string }; label?: string };
function list(kind: 'pane' | 'agent' | 'tab', timeout?: number): Row[] {
  const rows = query([kind, 'list'], timeout)?.[`${kind}s`];
  if (!Array.isArray(rows) || !rows.every(row => herdrId(row?.tab_id) && (kind === 'tab' || herdrId(row.pane_id))))
    throw Error(`unreadable herdr ${kind} list`);
  return rows;
}
function session(task: string) {
  const info: Partial<Record<'TAB' | 'TAB_NAME' | 'PRIMARY' | 'LEFT' | 'RIGHT' | 'ORCH' | 'RIGHT_SPLIT' | 'LAUNCH' | 'LAUNCH_ID' | 'TERMINAL_ID' | 'RIGHT_TERMINAL_ID' | 'DIRECT_EXEC' | 'PID' | 'PID_START' | 'HERDR_SOCKET_PATH', string>> = {};
  const path = join(task, jobFiles.session);
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    const match = /^(TAB|TAB_NAME|PRIMARY|LEFT|RIGHT|ORCH|RIGHT_SPLIT|LAUNCH|LAUNCH_ID|TERMINAL_ID|RIGHT_TERMINAL_ID|DIRECT_EXEC|PID|PID_START|HERDR_SOCKET_PATH)=(.*)$/.exec(line);
    if (match) info[match[1] as keyof typeof info] = match[2];
  }
  return info;
}
function checkLaunchStamp(task: string, info: ReturnType<typeof session>, expected?: string) {
  if (!expected) return;
  if (expected.startsWith('stamp:')) {
    const st = fs.lstatSync(join(task, jobFiles.session), { bigint: true });
    if (`stamp:${fileStampOf(st)}` !== expected) throw Error(`${task}: launch stamp changed; nothing reaped`);
    return;
  }
  const actual = info.LAUNCH_ID || info.LAUNCH;
  if (actual !== expected) throw Error(`${task}: launch stamp changed; nothing reaped`);
}
function primary(task: string): JobStatus | undefined {
  let text;
  try { text = fs.readFileSync(join(task, jobFiles.status), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const s = JSON.parse(text);
  if (s?.version !== 1 || s.slot !== 'primary' || !s.state || typeof s.state !== 'string' || !sameTaskDirectory(task, s.task_dir) ||
      s.pid != null && !isValidPid(s.pid) || s.pid_start_time != null && (!isValidPid(s.pid) || typeof s.pid_start_time !== 'string' || !/^\d+$/.test(s.pid_start_time)))
    throw Error('incompatible primary STATUS; cleanup incomplete');
  return s;
}
function liveStart(pid: number) {
  const stat = readProcStat(pid, { strict: true });
  return stat && isActiveProcState(stat.state) ? stat.start : null;
}
function callerAncestor(pid: number) {
  for (let p = process.pid; p > 1; p = readProcStat(p, { strict: true })?.ppid ?? 0) if (p === pid) return true;
  return false;
}
function alreadyReaped(task: string) {
  try { return Boolean(JSON.parse(fs.readFileSync(join(task, jobFiles.job), 'utf8')).reaped_at); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Direct-exec fork path: matches by launch_id + terminal_id and exact (pid, start).
 * Never drops to the stock reaper; refuses unknown capability (e.g. stock rollback) and respawned shells;
 * closes a remaining split helper only with positive ownership and idle-shell evidence. */
async function reapDirect(task: string, s: JobStatus | undefined, info: ReturnType<typeof session>, after?: number, expectedLaunch?: string) {
  const refuse = (message: string): never => { throw Error(`${task}: ${message}`); };
  checkLaunchStamp(task, info, expectedLaunch);
  const launchId = info.LAUNCH_ID, left = info.LEFT, right = info.RIGHT || undefined;
  const terminalId = info.TERMINAL_ID || undefined;
  const rightTerminalId = info.RIGHT_TERMINAL_ID || undefined;
  const pid = Number(info.PID), start = info.PID_START;
  if (!info.TAB || !left || !herdrId(launchId) || !isValidPid(pid) || typeof start !== 'string' || !/^\d+$/.test(start))
    refuse('missing direct-exec launch identity; cleanup incomplete');
  if ((s?.pid != null && s.pid !== pid) || (s?.pid_start_time != null && s.pid_start_time !== start))
    refuse('recorded worker identity does not match direct-exec launch; cleanup incomplete');
  if (after && pid !== after) refuse('recorded PID changed while waiting; nothing reaped');
  if (info.HERDR_SOCKET_PATH && herdrEndpoint() === info.HERDR_SOCKET_PATH && !(await isHudHerdrFork()))
    refuse('herdr endpoint lacks launch_id capability; not closing');
  if (!s?.state || !['closed', 'failed', 'stopped', 'idle_grace'].includes(s.state)) {
    try { fs.writeFileSync(join(task, jobFiles.stopRequested), '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const alive = () => liveStart(pid) === start;
  if (alive() && callerAncestor(pid)) refuse(`protected caller PID ${pid}; cleanup incomplete`);
  const ids = [left, ...(right ? [right] : [])];
  const expectedSession = s?.session_file || s?.agent_session_id;
  const matches = (a: Row) => Boolean(info.PRIMARY && a.name === info.PRIMARY && a.pane_id === left &&
    a.launch_id === launchId && (!terminalId || a.terminal_id === terminalId) &&
    (!expectedSession || expectedSession === a.agent_session?.value));
  function inspect() {
    if (alreadyReaped(task)) return null;
    const freshInfo = session(task);
    checkLaunchStamp(task, freshInfo, expectedLaunch);
    const fresh = primary(task);
    if ((fresh?.pid != null && fresh.pid !== pid) || (fresh?.pid_start_time != null && fresh.pid_start_time !== start) ||
        JSON.stringify(freshInfo) !== JSON.stringify(info))
      refuse('launch or worker identity changed; cleanup incomplete');
    const tabs = list('tab'), panes = list('pane'), agents = list('agent');
    // On rollback to stock herdr, inventory omits launch_id. Treat capability absence as unknown, never as absence.
    if (tabs.some(t => !herdrId(t.launch_id)) || panes.some(p => !herdrId(p.launch_id)) || agents.some(a => !herdrId(a.launch_id)))
      refuse('herdr inventory missing launch_id; endpoint lacks launch_id capability; not closing');
    const target = tabs.find(t => t.launch_id === launchId);
    const selected = target ? panes.filter(p => p.tab_id === target.tab_id) : panes.filter(p => p.launch_id === launchId);
    if (!target) {
      if (alive() || selected.length || agents.some(a => a.launch_id === launchId))
        refuse('recorded target missing but worker or panes remain');
      return null;
    }
    const tab = target.tab_id;
    // Keep this one-line stderr diagnostic: watch-runtime parses it.
    if (!info.TAB_NAME || target.label !== info.TAB_NAME) refuse(`TAB ${tab} name changed or missing; not closing`);
    const orch = panes.find(p => p.pane_id === info.ORCH) ?? agents.find(a => a.name && a.name === info.ORCH);
    if (ids.includes(info.ORCH) || orch?.tab_id === tab) refuse(`TAB ${tab} is the orchestrator tab; not closing`);
    if (selected.some(p => p.launch_id !== launchId)) refuse('pane launch_id mismatch; not closing');
    if (selected.some(p => p.pane_id !== left && p.pane_id !== right)) refuse('recorded pane set changed; not closing');
    const rootPane = selected.find(p => p.pane_id === left);
    const helperPane = right ? selected.find(p => p.pane_id === right) : undefined;
    // Under close_on_zero on a split tab, a clean root-only exit removes LEFT and leaves only helper RIGHT.
    if (!rootPane && (!helperPane || alive())) refuse('recorded pane set changed; not closing');
    if (rootPane && terminalId) {
      if (!herdrId(rootPane.terminal_id)) refuse('herdr inventory missing terminal_id; not closing');
      if (rootPane.terminal_id !== terminalId) refuse('root pane terminal_id mismatch; not closing');
    }
    if (helperPane) {
      if (rightTerminalId && helperPane.terminal_id && helperPane.terminal_id !== rightTerminalId)
        refuse('helper pane terminal_id mismatch; not closing');
      if (helperPane.agent) refuse('foreign agent in helper pane; not closing');
    }
    if (agents.some(a => (ids.includes(a.pane_id) || a.tab_id === tab || a.launch_id === launchId || (info.PRIMARY && a.name === info.PRIMARY)) &&
      (!rootPane || !matches(a) || a.tab_id !== tab))) refuse('foreign agent in recorded pane or binding changed; not closing');
    // Verify the root pane's process matches our recorded direct-exec PID/start (never close a restored/respawned shell after handoff).
    if (rootPane) {
      const proc = query(['pane', 'process-info', '--pane', left!])?.process_info;
      if (proc?.pane_id !== left) refuse('root pane process info unavailable; not closing');
      if (alive()) {
        if (proc.shell_pid !== pid) refuse('root pane process does not match direct-exec launch; not closing');
      } else {
        if (isValidPid(proc.shell_pid) && liveStart(proc.shell_pid) !== null)
          refuse('root pane hosts a different live process; not closing');
        if (Array.isArray(proc.foreground_processes) &&
            proc.foreground_processes.some((item: { pid?: number }) => isValidPid(item?.pid) && liveStart(item.pid) !== null))
          refuse('live foreground process remains in root pane; not closing');
      }
    }
    return { agent: rootPane ? agents.find(matches) : undefined, tab, rootPane, helperPane };
  }
  const emitOwnerAndRefuse = (message: string): never => {
    console.log(`tree-owner ${pid}:${start}`);
    return refuse(message);
  };
  function checkHelperIdle(tab: string): { ok: true } | { ok: false; retryable: boolean; reason: string } {
    if (!right) return { ok: true };
    const proc = query(['pane', 'process-info', '--pane', right])?.process_info;
    if (proc?.pane_id !== right || !isValidPid(proc.shell_pid) || !Array.isArray(proc.foreground_processes))
      return { ok: false, retryable: false, reason: 'helper pane launch ownership unverified; not closing' };
    if (!tabProcessStart(task, right, tab, proc.shell_pid, launchId))
      return { ok: false, retryable: false, reason: 'helper pane launch ownership unverified; not closing' };
    const foregroundBusy = proc.foreground_process_group_id !== proc.shell_pid ||
      proc.foreground_processes.some((item: { pid?: number }) => item?.pid !== proc.shell_pid);
    if (foregroundBusy)
      return { ok: false, retryable: true, reason: 'helper pane has active foreground process; not closing' };
    return confirmIdleShells(task, tab, launchId, [{
      pane: right, pid: proc.shell_pid, group: proc.foreground_process_group_id, foreground: proc.foreground_processes,
    }], left);
  }
  let state = inspect();
  if (!state) {
    if (!alreadyReaped(task)) console.log(`tree-owner ${pid}:${start}`);
    return;
  }
  if (state.agent && alive()) {
    const current = query(['agent', 'get', left!]).agent;
    if (!current || !matches(current) || current.tab_id !== state.tab || current.agent_session?.value !== state.agent.agent_session?.value)
      refuse('agent changed in recorded pane; left alone');
    if (['idle', 'done'].includes(current.agent_status)) {
      if (!alive() || callerAncestor(pid)) refuse('idle agent launch identity unverified; left alone');
      const deadline = performance.now() + 30_000;
      command(['agent', 'prompt', left!, '/quit']);
      for (;;) {
        const ms = Math.ceil(deadline - performance.now());
        if (ms <= 0 || !alive() || !list('tab', Math.min(15_000, ms)).some(t => t.launch_id === launchId) ||
            !list('agent', Math.min(15_000, ms)).some(matches)) break;
        await delay(Math.min(500, ms));
      }
      state = inspect();
      if (!state) {
        if (!alreadyReaped(task)) console.log(`tree-owner ${pid}:${start}`);
        return;
      }
    }
  }
  if (alive()) {
    if (callerAncestor(pid)) refuse(`protected caller PID ${pid}; left alone`);
    if (liveStart(pid) !== start) refuse(`PID ${pid} start time changed; left alone`);
    process.kill(pid, 'SIGTERM');
    for (let waited = 0; waited < 5000 && alive(); waited += 250) await delay(250);
    await delay(250);
    state = inspect();
    if (!state) {
      if (!alreadyReaped(task)) console.log(`tree-owner ${pid}:${start}`);
      return;
    }
  }
  if (alive()) emitOwnerAndRefuse('worker process remains; not closing');
  state = inspect();
  if (!state) {
    if (!alreadyReaped(task)) console.log(`tree-owner ${pid}:${start}`);
    return;
  }
  if (state.helperPane) {
    // Never whole-tab close while a non-agent foreground program runs in the helper, or without positive helper-shell proof.
    const settleDeadline = performance.now() + 1_000;
    for (;;) {
      const check = checkHelperIdle(state.tab);
      if (check.ok) break;
      const remaining = Math.ceil(settleDeadline - performance.now());
      if (!check.retryable || remaining <= 0) emitOwnerAndRefuse(check.reason);
      await delay(Math.min(200, remaining));
      state = inspect();
      if (!state) {
        if (!alreadyReaped(task)) console.log(`tree-owner ${pid}:${start}`);
        return;
      }
      if (!state.helperPane) break;
    }
  }
  const closed = command(['tab', 'close', state.tab]);
  if (closed.status !== 0 || list('tab').some(t => t.launch_id === launchId)) refuse(`tab ${state.tab} still exists`);
  console.log(`tree-owner ${pid}:${start}`);
}

async function reap(task: string, after?: number, expectedLaunch?: string) {
  if (alreadyReaped(task)) return;
  const info = session(task);
  checkLaunchStamp(task, info, expectedLaunch);
  const s = primary(task), pid = s?.pid, start = s?.pid_start_time;
  // A fork receipt never drops to the stock reaper.
  if (info.DIRECT_EXEC === '1' || info.LAUNCH_ID || info.TERMINAL_ID) return reapDirect(task, s, info, after, expectedLaunch);
  const refuse = (message: string): never => { throw Error(`${task}: ${message}`); };
  if (after && isValidPid(pid) && pid !== after) refuse('recorded PID changed while waiting; nothing reaped');
  if (!s?.state || !['closed', 'failed', 'stopped', 'idle_grace'].includes(s.state)) {
    try { fs.writeFileSync(join(task, jobFiles.stopRequested), '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  if (isValidPid(pid) && liveStart(pid) && !(typeof start === 'string' && /^\d+$/.test(start)))
    refuse(`live PID ${pid} missing start time; cleanup incomplete`);
  const alive = () => isValidPid(pid) && typeof start === 'string' && liveStart(pid) === start;
  if (alive() && callerAncestor(pid!)) refuse(`protected caller PID ${pid}; cleanup incomplete`);
  const left = info.TAB ? info.LEFT : info.RIGHT;
  if (!left || (!info.TAB && info.RIGHT_SPLIT !== '1')) refuse('missing pane receipt; cleanup incomplete');
  const witness = s?.harness === 'cli' ? invocationWitness(task, info.LAUNCH) : null;
  if (s?.harness === 'cli' && alive() && (!witness || witness.pid !== pid || witness.start !== start))
    refuse('CLI invocation witness mismatch; cleanup incomplete');
  const ids = info.TAB ? [left, ...(info.RIGHT ? [info.RIGHT] : [])] : [left];
  const expectedSession = s?.session_file || s?.agent_session_id;
  const matches = (a: Row) => Boolean(info.PRIMARY && a.name === info.PRIMARY && a.pane_id === left &&
    (!expectedSession || expectedSession === a.agent_session?.value));
  function inspect(allowExitedForeground = false) {
    if (alreadyReaped(task)) return null;
    const fresh = primary(task);
    if (fresh?.pid !== pid || fresh?.pid_start_time !== start || JSON.stringify(session(task)) !== JSON.stringify(info))
      refuse('launch or worker identity changed; cleanup incomplete');
    const panes = list('pane'), agents = list('agent');
    const target = info.TAB ? list('tab').find(t => t.tab_id === info.TAB) : panes.find(p => p.pane_id === left);
    const selected = panes.filter(p => info.TAB ? p.tab_id === info.TAB : p.pane_id === left);
    if (!target) {
      if (alive() || selected.length || panes.some(p => ids.includes(p.pane_id)) || agents.some(a => ids.includes(a.pane_id) || matches(a) || a.tab_id === info.TAB))
        refuse('recorded target missing but worker or panes remain');
      return null; // Already gone. This is NOT a grant to signal descendants.
    }
    const tab = target.tab_id;
    // Keep this one-line stderr diagnostic: watch-runtime parses it.
    if (info.TAB && (!info.TAB_NAME || target.label !== info.TAB_NAME)) refuse(`TAB ${tab} name changed or missing; not closing`);
    const orch = panes.find(p => p.pane_id === info.ORCH) ?? agents.find(a => a.name && a.name === info.ORCH);
    if (ids.includes(info.ORCH) || orch?.tab_id === tab) refuse(`TAB ${tab} is the orchestrator tab; not closing`);
    if (selected.length !== ids.length || ids.some(id => !selected.some(p => p.pane_id === id))) refuse('recorded pane set changed; not closing');
    if (agents.some(a => (ids.includes(a.pane_id) || info.TAB && a.tab_id === tab || info.PRIMARY && a.name === info.PRIMARY) &&
      (!matches(a) || a.tab_id !== tab))) refuse('foreign agent in recorded pane or binding changed; not closing');
    const agent = agents.find(matches);
    const foreground = new Map<number, string>();
    const shells: Parameters<typeof confirmIdleShells>[3] = [];
    let exitedForeground = false;
    for (const p of selected) {
      const kind = s?.harness === 'cli' ? s.agent : info.PRIMARY ? 'pi' : undefined;
      if (p.agent && (!agent || agent.pane_id !== p.pane_id || p.agent !== kind)) refuse('unidentified agent in recorded pane; not closing');
      const proc = query(['pane', 'process-info', '--pane', p.pane_id])?.process_info;
      if (proc?.pane_id !== p.pane_id || !tabProcessStart(task, p.pane_id, tab, proc.shell_pid, info.LAUNCH) || !Array.isArray(proc.foreground_processes))
        refuse('pane launch ownership unverified; not closing');
      shells.push({ pane: p.pane_id, pid: proc.shell_pid, group: proc.foreground_process_group_id, foreground: proc.foreground_processes });
      for (const item of proc.foreground_processes) {
        if (item?.pid === proc.shell_pid && item.pid === pid) refuse('recorded worker is the pane shell; left alone');
        if (s?.harness === 'cli' && item?.pid === pid && (item.name !== s.agent || proc.foreground_process_group_id !== pid))
          refuse('recorded CLI worker is not the expected foreground agent');
        const ticks = tabProcessStart(task, p.pane_id, tab, item?.pid, info.LAUNCH);
        if (!ticks || p.pane_id !== left && item?.pid !== proc.shell_pid) {
          if (allowExitedForeground && isValidPid(item?.pid)) {
            const itemStat = readProcStat(item.pid, { strict: true });
            if (!itemStat || !isActiveProcState(itemStat.state)) {
              exitedForeground = true;
              continue;
            }
          }
          refuse('foreign or unverified foreground occupant; not closing');
        }
        foreground.set(item.pid, ticks!);
      }
    }
    return { agent, foreground, tab, shells, exitedForeground };
  }
  let state = inspect(!alive());
  if (!state) return;
  let verifiedRoot = false;
  if (isValidPid(pid) && state.foreground.has(pid) && state.foreground.get(pid) !== start) refuse('foreground PID start time changed; left alone');
  if (alive() && state.foreground.get(pid!) !== start) refuse('recorded process is not the verified pane occupant');
  if (state.agent) {
    const current = query(['agent', 'get', left!]).agent;
    if (!current || !matches(current) || current.tab_id !== state.tab || current.agent_session?.value !== state.agent.agent_session?.value)
      refuse('agent changed in recorded pane; left alone');
    if (['idle', 'done'].includes(current.agent_status)) {
      if (!isValidPid(pid) || !alive() || state.foreground.get(pid!) !== start || callerAncestor(pid!) ||
          tabProcessStart(task, left!, state.tab, pid, info.LAUNCH) !== start)
        refuse('idle agent launch identity unverified; left alone');
      verifiedRoot = true;
      const deadline = performance.now() + 30_000;
      command(['agent', 'prompt', left!, '/quit']);
      for (;;) {
        const ms = Math.ceil(deadline - performance.now());
        if (ms <= 0 || !list('agent', Math.min(15_000, ms)).some(matches)) break;
        await delay(Math.min(500, ms));
      }
      state = inspect(!alive());
      if (!state) {
        if (verifiedRoot && !alreadyReaped(task)) console.log(`tree-owner ${pid}:${start}`);
        return;
      }
    }
  }
  let needInspect = false;
  if (alive() && isValidPid(pid)) {
    if (callerAncestor(pid) || state.foreground.get(pid) !== start || tabProcessStart(task, left!, state.tab, pid, info.LAUNCH) !== start)
      refuse(`PID ${pid} is not a verified worker; left alone`);
    process.kill(pid, 'SIGTERM');
    verifiedRoot = true;
    for (let waited = 0; waited < 5000 && alive(); waited += 250) await delay(250);
    await delay(500);
    needInspect = true;
  }
  const refuseWithOwner = (message: string): never => {
    if (verifiedRoot) console.log(`tree-owner ${pid}:${start}`);
    return refuse(message);
  };
  const IDLE_SETTLE_MS = 2_000;
  const settleDeadline = performance.now() + IDLE_SETTLE_MS;
  for (;;) {
    if (needInspect) state = inspect(true);
    needInspect = true;
    if (!state) {
      if (verifiedRoot && !alreadyReaped(task)) console.log(`tree-owner ${pid}:${start}`);
      return;
    }
    if (state.agent || alive()) {
      // A verified worker may be waiting for its child.
      refuseWithOwner(state.agent ? `owned agent remains in ${left}` : 'worker or foreground process remains; not closing');
    }
    const shellPids = new Set(state.shells.map(shell => shell.pid));
    const foregroundBusy = state.exitedForeground || [...state.foreground.keys()].some(id => !shellPids.has(id)) ||
      state.shells.some(shell => shell.group !== shell.pid);
    const check = foregroundBusy
      ? { ok: false as const, retryable: true, reason: 'worker or foreground process remains; not closing' }
      : confirmIdleShells(task, state.tab, info.LAUNCH, state.shells, left);
    if (check.ok) break;
    const remaining = Math.ceil(settleDeadline - performance.now());
    if (!check.retryable || remaining <= 0) refuseWithOwner(check.reason);
    await delay(Math.min(200, remaining));
  }
  const kind = info.TAB ? 'tab' : 'pane', id = info.TAB || left!;
  const closed = command([kind, 'close', id]);
  if (closed.status !== 0 || list(kind).some(p => (info.TAB ? p.tab_id : p.pane_id) === id)) refuse(`${kind} ${id} still exists`);
  if (isValidPid(pid) && typeof start === 'string') {
    // When the root exited before this invocation, the pane proof is not a PID
    // proof. Only positively job-tagged captured members may be cleaned then.
    console.log(`${verifiedRoot ? 'tree-owner' : 'tree-pane'} ${pid}:${start}`);
  }
}

export async function main(args = process.argv.slice(2)) {
  const usage = 'hud-reap <task-dir> [--after-pid PID] [--launch STAMP]';
  try {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(usage); return; }
    if (args.length < 1 || args[0].startsWith('-')) throw Error(`usage: ${usage}`);
    const task = fs.realpathSync(args[0]);
    let after: number | undefined;
    let expectedLaunch: string | undefined;
    for (let i = 1; i < args.length; i += 2) {
      const flag = args[i], value = args[i + 1];
      if (!value) throw Error(`usage: ${usage}`);
      if (flag === '--after-pid' && after === undefined) {
        after = Number(value);
        if (!/^[1-9]\d*$/.test(value) || !isValidPid(after) || after === process.pid) throw Error('invalid --after-pid PID');
      } else if (flag === '--launch' && expectedLaunch === undefined) {
        if (!herdrId(value)) throw Error('invalid --launch STAMP');
        expectedLaunch = value;
      } else {
        throw Error(`usage: ${usage}`);
      }
    }
    if (after !== undefined) {
      if (alreadyReaped(task)) { console.log(`hud-reap: ${task}: already reaped`); return; }
      checkLaunchStamp(task, session(task), expectedLaunch);
      const deadline = performance.now() + 30_000;
      while (liveStart(after)) {
        const ms = deadline - performance.now();
        if (ms <= 0) throw Error(`PID ${after} still alive after 30s; nothing reaped`);
        await delay(Math.min(250, ms));
      }
    }
    await reap(task, after, expectedLaunch);
    console.log(`hud-reap: ${task}: reaped`);
  } catch (error) { console.error(`hud-reap: ${(error as Error).message}`); process.exitCode = 1; }
}
