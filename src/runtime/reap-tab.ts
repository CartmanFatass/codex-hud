/** One explicit job. A pane ID, a label or an empty agent inventory is not proof
 * of ownership. The shell and occupants must still carry the launch environment. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { jobFiles } from '../mcp/paths.js';
import type { JobStatus } from '../mcp/job-contracts.js';
import { isActiveProcState, isValidPid, readProcStat } from '../utils/proc.js';
import { herdrId } from '../roles/herdr-run.js';
import { invocationWitness } from './cli-invocation.js';
import { confirmIdleShells } from './tab-shell.js';
import { sameTaskDirectory, tabProcessStart } from './tab-owner.js';

const command = (args: string[], timeout = 15_000) => spawnSync('herdr', args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL' });
function query(args: string[], timeout?: number) {
  const r = command(args, timeout);
  if (r.status !== 0) throw Error(`herdr ${args.join(' ')}: ${r.error?.message ?? r.stderr}`);
  return JSON.parse(r.stdout).result;
}
type Row = { pane_id: string; tab_id: string; name?: string; agent?: string; agent_status?: string; agent_session?: { value: string }; label?: string };
function list(kind: 'pane' | 'agent' | 'tab', timeout?: number): Row[] {
  const rows = query([kind, 'list'], timeout)?.[`${kind}s`];
  if (!Array.isArray(rows) || !rows.every(row => herdrId(row?.tab_id) && (kind === 'tab' || herdrId(row.pane_id))))
    throw Error(`unreadable herdr ${kind} list`);
  return rows;
}
function session(task: string) {
  const info: Partial<Record<'TAB' | 'TAB_NAME' | 'PRIMARY' | 'LEFT' | 'RIGHT' | 'ORCH' | 'RIGHT_SPLIT' | 'LAUNCH', string>> = {};
  const path = join(task, jobFiles.session);
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    const match = /^(TAB|TAB_NAME|PRIMARY|LEFT|RIGHT|ORCH|RIGHT_SPLIT|LAUNCH)=(.*)$/.exec(line);
    if (match) info[match[1] as keyof typeof info] = match[2];
  }
  return info;
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

async function reap(task: string, after?: number) {
  if (alreadyReaped(task)) return;
  const s = primary(task), pid = s?.pid, start = s?.pid_start_time;
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
  const info = session(task), left = info.TAB ? info.LEFT : info.RIGHT;
  if (!left || (!info.TAB && info.RIGHT_SPLIT !== '1')) refuse('missing pane receipt; cleanup incomplete');
  if (s?.harness === 'cli' && alive()) {
    const witness = invocationWitness(task, info.LAUNCH);
    if (!witness || witness.pid !== pid || witness.start !== start) refuse('CLI invocation witness mismatch; cleanup incomplete');
  }
  const ids = info.TAB ? [left, ...(info.RIGHT ? [info.RIGHT] : [])] : [left];
  const expectedSession = s?.session_file || s?.agent_session_id;
  const matches = (a: Row) => Boolean(info.PRIMARY && a.name === info.PRIMARY && a.pane_id === left &&
    (!expectedSession || expectedSession === a.agent_session?.value));
  function inspect() {
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
        if (!ticks || p.pane_id !== left && item?.pid !== proc.shell_pid) refuse('foreign or unverified foreground occupant; not closing');
        foreground.set(item.pid, ticks!);
      }
    }
    return { agent, foreground, tab, shells };
  }
  let state = inspect();
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
      state = inspect();
      if (!state) {
        if (verifiedRoot && !alreadyReaped(task)) console.log(`tree-owner ${pid}:${start}`);
        return;
      }
    }
  }
  if (alive() && isValidPid(pid)) {
    if (callerAncestor(pid) || state.foreground.get(pid) !== start || tabProcessStart(task, left!, state.tab, pid, info.LAUNCH) !== start)
      refuse(`PID ${pid} is not a verified worker; left alone`);
    process.kill(pid, 'SIGTERM');
    verifiedRoot = true;
    for (let waited = 0; waited < 5000 && alive(); waited += 250) await delay(250);
    await delay(500);
  }
  state = inspect();
  if (!state) {
    if (verifiedRoot && !alreadyReaped(task)) console.log(`tree-owner ${pid}:${start}`);
    return;
  }
  const shellPids = new Set(state.shells.map(shell => shell.pid));
  if (state.agent || [...state.foreground.keys()].some(id => !shellPids.has(id)) || alive()) {
    if (verifiedRoot) console.log(`tree-owner ${pid}:${start}`); // A verified worker may be waiting for its child.
    refuse(state.agent ? `owned agent remains in ${left}` : 'worker or foreground process remains; not closing');
  }
  if (!confirmIdleShells(task, state.tab, info.LAUNCH, state.shells)) {
    if (verifiedRoot) console.log(`tree-owner ${pid}:${start}`);
    refuse('original shell identity or idle foreground unverified; not closing');
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
  const usage = 'hud-reap <task-dir> [--after-pid PID]';
  try {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(usage); return; }
    if (!(args.length === 1 || args.length === 3 && args[1] === '--after-pid') || args[0].startsWith('-')) throw Error(`usage: ${usage}`);
    const task = fs.realpathSync(args[0]);
    let after: number | undefined;
    if (args.length === 3) {
      after = Number(args[2]);
      if (!/^[1-9]\d*$/.test(args[2]) || !isValidPid(after) || after === process.pid) throw Error('invalid --after-pid PID');
      if (alreadyReaped(task)) { console.log(`hud-reap: ${task}: already reaped`); return; }
      const deadline = performance.now() + 30_000;
      while (liveStart(after)) {
        const ms = deadline - performance.now();
        if (ms <= 0) throw Error(`PID ${after} still alive after 30s; nothing reaped`);
        await delay(Math.min(250, ms));
      }
    }
    await reap(task, after);
    console.log(`hud-reap: ${task}: reaped`);
  } catch (error) { console.error(`hud-reap: ${(error as Error).message}`); process.exitCode = 1; }
}
