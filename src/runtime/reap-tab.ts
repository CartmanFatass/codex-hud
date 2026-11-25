/** Per-job cleanup. The watcher/caller owns the helper process group; this helper
 * only signals the exact process recorded in STATUS, never a worker group. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { jobFiles } from '../mcp/paths.js';
import type { JobStatus } from '../mcp/job-contracts.js';
import { isActiveProcState, isValidPid, readProcStat } from '../utils/proc.js';
import { herdrId } from '../roles/herdr-run.js';

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
  const info: Partial<Record<'TAB' | 'TAB_NAME' | 'PRIMARY' | 'LEFT' | 'RIGHT' | 'ORCH' | 'RIGHT_SPLIT', string>> = {};
  const path = join(task, jobFiles.session);
  if (fs.existsSync(path)) for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    const match = /^(TAB|TAB_NAME|PRIMARY|LEFT|RIGHT|ORCH|RIGHT_SPLIT)=(.*)$/.exec(line);
    if (match) info[match[1] as keyof typeof info] = match[2];
  }
  return info;
}
function primary(task: string): JobStatus | undefined {
  const path = join(task, jobFiles.status);
  if (!fs.existsSync(path)) return;
  const s = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (s?.version === 1 && s.slot === 'primary' && s.task_dir === task) return s;
}
function liveStart(pid: number) {
  const stat = readProcStat(pid, { strict: true });
  return stat && isActiveProcState(stat.state) ? stat.start : null;
}
function callerAncestor(pid: number) {
  for (let p = process.pid; p > 1; p = readProcStat(p, { strict: true })?.ppid ?? 0) if (p === pid) return true;
  return false;
}

async function reap(task: string, after?: number): Promise<boolean> {
  const info = session(task), s = primary(task), pid = s?.pid, start = s?.pid_start_time;
  const errors: string[] = [];
  const problem = (msg: string) => { errors.push(msg); console.error(`hud-reap: ${task}: ${msg}`); };
  if (after && isValidPid(pid) && pid !== after) throw Error('recorded PID changed while waiting; nothing reaped');
  if (s && !['closed', 'failed', 'stopped', 'idle_grace'].includes(s.state)) {
    try { fs.writeFileSync(join(task, jobFiles.stopRequested), '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  if (isValidPid(pid) && liveStart(pid) && !(typeof start === 'string' && /^\d+$/.test(start))) {
    problem(`live PID ${pid} missing start time; left alone`);
    console.log(`hud-reap: ${task}: cleanup incomplete: ${errors[0]}`);
    return false;
  }
  const hasPanes = !!(info.TAB || info.LEFT || info.RIGHT || info.PRIMARY);
  const owned = (a: Row) => Boolean((info.PRIMARY && a.name === info.PRIMARY) || (s?.session_file && a.agent_session?.value === s.session_file));
  const inventory = () => {
    const panes = list('pane'), agents = list('agent');
    const orch = panes.find(p => p.pane_id === info.ORCH) ?? agents.find(a => a.name && a.name === info.ORCH);
    const protectedPane = (a: Row) => a.pane_id === (orch?.pane_id ?? info.ORCH) || a.tab_id === orch?.tab_id;
    return { panes, agents, orch, protectedPane };
  };
  let protectedPid = false;
  if (hasPanes) {
    const { agents, protectedPane, orch } = inventory();
    protectedPid = Boolean((info.ORCH && info.ORCH === info.LEFT) || (orch && (orch.pane_id === info.LEFT || orch.tab_id === info.TAB)));
    const deadline = performance.now() + 30_000, waiting = new Set<string>();
    const budget = () => Math.max(0, Math.min(15_000, Math.ceil(deadline - performance.now())));
    // Send quits before polling. A working agent cannot consume /quit: go
    // straight to the exact recorded PID instead of holding the shared grace.
    for (const agent of agents.filter(owned)) {
      if (protectedPane(agent)) { protectedPid = true; problem(`protected orchestrator agent in ${agent.pane_id}; left alone`); continue; }
      if (info.TAB && agent.tab_id !== info.TAB || info.LEFT && agent.pane_id !== info.LEFT) {
        problem(`agent moved to ${agent.pane_id}; left alone`); continue;
      }
      const getBudget = budget();
      if (!getBudget) break;
      const current: Row = query(['agent', 'get', agent.pane_id], getBudget).agent;
      if (!current || !owned(current) || current.pane_id !== agent.pane_id || current.tab_id !== agent.tab_id ||
          current.agent_session?.value !== agent.agent_session?.value || protectedPane(current)) {
        problem(`agent changed in ${agent.pane_id}; left alone`); continue;
      }
      const ms = budget();
      if (ms && ['idle', 'done'].includes(current.agent_status ?? '')) {
        waiting.add(agent.pane_id);
        command(['agent', 'prompt', agent.pane_id, '/quit'], ms);
      }
    }
    // A detached pane or 'done' is not exit evidence. Wait for the agent list.
    while (waiting.size) {
      const ms = budget();
      if (!ms) break;
      let agents: Row[];
      try { agents = list('agent', ms); }
      catch (error) { if (!budget()) break; throw error; }
      for (const pane of waiting) if (!agents.some(a => a.pane_id === pane && owned(a))) waiting.delete(pane);
      if (waiting.size && budget()) await delay(Math.min(500, budget()));
    }
  }
  const alive = () => isValidPid(pid) && typeof start === 'string' && liveStart(pid) === start;
  if (isValidPid(pid) && alive()) {
    if (hasPanes) {
      const { agents, protectedPane, orch } = inventory();
      protectedPid ||= Boolean(orch && (info.LEFT === orch.pane_id || info.TAB === orch.tab_id)) || agents.some(a => owned(a) && protectedPane(a));
    }
    if (protectedPid || callerAncestor(pid)) problem(`protected orchestrator PID ${pid}; left alone`);
    else if (!errors.length && alive()) {
      try { process.kill(pid, 'SIGTERM'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      for (let waited = 0; waited < 5000 && alive(); waited += 250) await delay(250);
      await delay(500); // herdr drops the agent shortly after process exit
      if (alive()) problem(`PID ${pid} still running`);
    }
  }
  if (hasPanes) {
    const { panes, agents, orch } = inventory();
    for (const agent of agents.filter(owned)) problem(`owned agent remains in ${agent.pane_id}`);
    if (info.TAB) {
      const tab = list('tab').find(t => t.tab_id === info.TAB);
      if (tab) {
        // This single stderr line on an otherwise clean refusal is parsed by watch-runtime.
        if (!info.TAB_NAME || tab.label !== info.TAB_NAME) problem(`TAB ${info.TAB} name changed or missing; not closing`);
        else if (tab.tab_id === orch?.tab_id || panes.some(p => p.tab_id === tab.tab_id && p.pane_id === info.ORCH))
          problem(`TAB ${info.TAB} is the orchestrator tab; not closing`);
        else if (panes.some(p => p.tab_id === tab.tab_id && p.agent) || agents.some(a => a.tab_id === tab.tab_id))
          problem(`TAB ${info.TAB} still has an agent; not closing`);
        else if (panes.some(p => p.tab_id === tab.tab_id && ![info.LEFT, info.RIGHT].includes(p.pane_id)))
          problem(`TAB ${info.TAB} has an unrecorded pane; not closing`);
        else if (errors.length) problem(`agents not confirmed gone; not closing TAB ${info.TAB}`);
        else {
          const closed = command(['tab', 'close', info.TAB]);
          if (closed.status !== 0) problem(`could not close TAB ${info.TAB}: ${closed.stderr}`);
          if (list('tab').some(t => t.tab_id === info.TAB)) problem(`TAB ${info.TAB} still exists`);
        }
      }
    } else if (info.RIGHT_SPLIT === '1' && info.RIGHT) {
      const pane = panes.find(p => p.pane_id === info.RIGHT);
      if (pane) {
        if (pane.pane_id === info.ORCH || pane.pane_id === orch?.pane_id) problem(`RIGHT ${info.RIGHT} is protected; not closing`);
        else if (pane.agent || agents.some(a => a.pane_id === pane.pane_id) || errors.length) problem(`RIGHT ${info.RIGHT} not confirmed empty; not closing`);
        else if (command(['pane', 'close', info.RIGHT]).status !== 0 || list('pane').some(p => p.pane_id === info.RIGHT)) problem(`RIGHT ${info.RIGHT} still exists`);
      }
    }
    for (const pane of panes) if ([info.LEFT, info.RIGHT].includes(pane.pane_id) && pane.agent) problem(`agent remains in recorded pane ${pane.pane_id}`);
  }
  console.log(`hud-reap: ${task}: ${errors.length ? 'cleanup incomplete' : 'reaped'}`);
  return !errors.length;
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
      const deadline = performance.now() + 30_000;
      while (liveStart(after)) {
        const ms = deadline - performance.now();
        if (ms <= 0) throw Error(`PID ${after} still alive after 30s; nothing reaped`);
        await delay(Math.min(250, ms));
      }
    }
    if (!await reap(task, after)) process.exitCode = 1;
  } catch (error) { console.error(`hud-reap: ${(error as Error).message}`); process.exitCode = 1; }
}
