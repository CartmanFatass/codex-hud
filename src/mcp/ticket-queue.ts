import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { capForRole, loadConcurrencySettings } from '../roles/concurrency.js';
import { herdrId } from '../roles/herdr-run.js';
import { registeredProject, sharedRoot } from '../roles/projects.js';
import { workerTreeRootGone } from '../roles/worker-tree.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { validLandConfig } from './land.js';
import { binScript } from './paths.js';
import { ensureJobWatcher } from './watch-pid.js';
import { cancelTicketQueue, queueIds, readTicketQueue, ticketQueueNotice, writeTicketQueue, type TicketQueue } from './ticket-queue-state.js';

const starting = new Map<string, ChildProcess>();
export function wakeTicketQueue(home: string, q: TicketQueue) {
  if (q.state !== 'working' || starting.has(q.flow) || (q.pid && q.start && !workerTreeRootGone(q.pid, q.start))) return;
  const { HUD_JOB_DIR: _worker, ...env } = process.env;
  const child = spawn(process.execPath, [binScript('ticket-queue-runner'), q.flow], {
    cwd: q.root, detached: true, stdio: 'ignore', env: { ...env, HUD_HOME: home, HERDR_PANE_ID: q.pane },
  });
  starting.set(q.flow, child);
  const clear = () => { if (starting.get(q.flow) === child) starting.delete(q.flow); };
  child.once('exit', clear).once('error', clear).unref();
}

export async function startTicketQueue(home: string, cwd: string, pane: string | null, task: boolean, args: Record<string, unknown>) {
  const { feature, max_parallel, cancel } = args;
  if (typeof feature !== 'string' || !/^[a-z0-9-]+$/.test(feature)) throw Error('invalid_arguments: feature');
  if (max_parallel !== undefined && (typeof max_parallel !== 'number' || !Number.isSafeInteger(max_parallel) || max_parallel < 1))
    throw Error('invalid_arguments: max_parallel');
  if (cancel !== undefined && typeof cancel !== 'boolean') throw Error('invalid_arguments: cancel');
  if (!pane || !herdrId(pane)) throw Error('hud_tickets run requires a caller pane');
  const root = sharedRoot(cwd);
  return withAbstractLock('ticket-start', `${home}\0${root}\0${feature}`, () => {
    const queues = queueIds(home).map(id => readTicketQueue(home, id)).filter(q => q !== null)
      .filter(q => q.root === root && q.feature === feature);
    const prior = queues.find(q => q.state === 'working');
    if (prior) {
      if (prior.pane !== pane) throw Error(`Ticket queue ${prior.flow} is owned by another pane`);
      if (cancel) cancelTicketQueue(home, prior);
      wakeTicketQueue(home, prior);
      return prior;
    }
    if (cancel) return null;
    if (!registeredProject(home, root).registered) throw Error('hud_tickets run requires a registered project');
    validLandConfig(home, root);
    fs.mkdirSync(join(home, 'flows'), { mode: 0o700, recursive: true });
    const latest = queues.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    const resumed = latest?.state === 'failed' ? latest : undefined;
    const now = new Date().toISOString();
    const q: TicketQueue = { flow: `q${randomBytes(8).toString('hex')}`, root, feature, pane, task,
      max_parallel: max_parallel ?? resumed?.max_parallel ?? capForRole(loadConcurrencySettings(), 'imp'), created_at: now, updated_at: now,
      state: 'working', tickets: resumed?.tickets.map(item => ({ ...item, dispatch_queue: item.dispatch_queue ?? resumed.flow })) ?? [] };
    writeTicketQueue(home, q, true);
    wakeTicketQueue(home, q);
    return q;
  });
}
export function ticketQueueTask(home: string, q: TicketQueue, cancel = false) {
  if (cancel) cancelTicketQueue(home, q);
  if (q.state === 'working') {
    wakeTicketQueue(home, q);
    ensureJobWatcher(home);
  }
  const text = ticketQueueNotice(q);
  return { taskId: q.flow, status: q.state, statusMessage: q.state === 'working' ? `${q.flow} (ticket queue ${q.feature}) — working` : text,
    createdAt: q.created_at, lastUpdatedAt: q.updated_at, ttlMs: 3 * 60 * 60_000, pollIntervalMs: 5000,
    ...(q.state !== 'working' && { result: { content: [{ type: 'text', text }] } }) };
}