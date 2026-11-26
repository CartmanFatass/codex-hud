import { randomBytes } from 'node:crypto';
import { watch } from 'node:fs';
import { basename } from 'node:path';
import { readObjectives } from '../collectors/objectives.js';
import { getHudHome } from '../hud-home.js';
import { ticketObjectiveId, ticketReadiness } from '../mcp/local-tickets.js';
import { jobCache } from '../mcp/store/job-store.js';
import { startTicketQueue } from '../mcp/ticket-queue.js';
import { ensureJobWatcher } from '../mcp/watch-pid.js';
import { registeredProject } from '../roles/projects.js';
import { tryAbstractLock } from '../utils/abstract-lock.js';
import { writeJsonPrivate } from '../utils/atomic-fs.js';
import { procStat, readBootId } from '../utils/proc.js';
import { wakeWorkflow } from '../workflows/wake.js';
import { withControl } from './control.js';
import { controlPath, diagnosticsPath, identityPath, indexPath, itemClosed, MAX_OPEN_ITEMS, readControl, readRunIndex,
  readUnattendedStatus, readUnattendedDiagnostics, type UnattendedControl, type UnattendedDiagnostic } from './state.js';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 1500);

function candidates(control: UnattendedControl) {
  const objectives = readObjectives(control.root)?.objectives ?? [];
  const selected = objectives.filter(o => o.state === 'active' && control.objectives.includes(o.id));
  if (!selected.length) return [];
  return ticketReadiness(control.root, jobCache).tickets.flatMap(({ ticket, path }) => {
    const feature = ticket.split('/')[0];
    const linked = objectives.filter(o => o.features.includes(feature));
    const declared = ticketObjectiveId(path);
    const objective = selected.find(o => o.id === (declared ?? (linked.length === 1 ? linked[0].id : undefined)));
    return objective && /^[a-z0-9-]+$/.test(feature) ? [{ objective: objective.id, ticket, path }] : [];
  });
}

async function scan(home: string, control: UnattendedControl) {
  const { runs, running } = readUnattendedStatus(home);
  // Resume an interrupted workflow driver, not a terminal run. Drivers don't belong to the service process.
  for (const q of running) wakeWorkflow(home, q);
  if (running.length) ensureJobWatcher(home);
  const open = runs.filter(q => q.state === 'working' || (q.state !== 'completed' && !itemClosed(q.unattended!)));
  const recent = runs.filter(q => q.state === 'completed').slice(-16);
  const keep = Math.max(0, Math.min(recent.length, MAX_OPEN_ITEMS - open.length - 1));
  let ids = [...recent.slice(recent.length - keep), ...open].map(q => q.flow);
  if (!registeredProject(home, control.root).registered) throw Error('Unattended project is no longer registered');
  const ready = candidates(control), issues: UnattendedDiagnostic[] = [];
  const busy = new Set(running.filter(q => q.root === control.root).map(q => q.feature));
  const held = new Set(open.filter(q => q.root === control.root).map(q => q.unattended!.ticket));
  await withControl(home, () => {
    if (!same(readControl(home), control)) return;
    if (!same(ids, readRunIndex(home))) writeJsonPrivate(indexPath(home), ids);
  });
  for (const item of ready) {
    if (!same(readControl(home), control)) break;
    if (ids.length >= MAX_OPEN_ITEMS) {
      issues.unshift({ reason: 'Unattended run limit reached; close held tickets to make room' });
      break;
    }
    const feature = item.ticket.split('/')[0];
    if (busy.has(feature) || held.has(item.ticket)) continue;
    await withControl(home, async () => {
      // Linearize off and selection changes against admission, not against the workflow's settlement.
      if (!same(readControl(home), control)) return;
      const flow = `q${randomBytes(8).toString('hex')}`;
      writeJsonPrivate(indexPath(home), [...ids, flow]);
      try {
        const q = await startTicketQueue(home, control.root, null, false, { feature }, undefined, { flow, item });
        if (q) {
          ids = [...ids, flow];
          busy.add(feature);
          ensureJobWatcher(home);
        }
      } finally {
        if (ids.at(-1) !== flow) writeJsonPrivate(indexPath(home), ids);
      }
    }).catch(error => { // A bad ticket must not block the next one.
      if (issues.length < 15) issues.push({ ticket: item.ticket, reason: reason(error) });
    });
  }
  return issues;
}

async function publishDiagnostics(home: string, control: UnattendedControl, issues: UnattendedDiagnostic[]) {
  await withControl(home, () => {
    if (same(readControl(home), control) && !same(issues, readUnattendedDiagnostics(home)))
      writeJsonPrivate(diagnosticsPath(home), issues);
  });
}

export async function runUnattended() {
  const home = getHudHome();
  const release = await tryAbstractLock('unattended', home);
  if (!release) return;
  try {
    const start = procStat(process.pid)?.start, boot_id = readBootId();
    if (!start || !boot_id) throw Error('Cannot read unattended process identity');
    let wake: (() => void) | undefined;
    const watcher = watch(home, (_event, file) => { if (!file || file === basename(controlPath(home))) wake?.(); });
    watcher.on('error', () => watcher.close()); // Timed recheck also covers a missed event.
    try {
      if (!readControl(home)?.enabled) return;
      writeJsonPrivate(identityPath(home), { pid: process.pid, start, boot_id });
      if (process.connected) process.send?.('ready', () => {});
      for (;;) {
        let timer: ReturnType<typeof setTimeout>;
        const next = new Promise<void>(done => { wake = done; timer = setTimeout(done, 2000); });
        try {
          const control = await withControl(home, async () => {
            const current = readControl(home);
            // Release election before a subsequent on checks whether this instance is still serving.
            if (!current?.enabled) {
              writeJsonPrivate(identityPath(home), null);
              await release();
              return;
            }
            return current;
          });
          if (!control) return;
          const issues = await scan(home, control).catch(error => [{ reason: reason(error) }]);
          await publishDiagnostics(home, control, issues);
          await next;
        } catch { await next; }
        finally { clearTimeout(timer!); wake = undefined; }
      }
    } finally { watcher.close(); }
  } finally { await release(); }
}
