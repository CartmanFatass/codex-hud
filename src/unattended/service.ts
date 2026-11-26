import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import { readObjectives } from '../collectors/objectives.js';
import { getHudHome } from '../hud-home.js';
import { retryPendingFlakeCollections } from '../mcp/land-flakes.js';
import { checkTicketPaths, ticketObjectiveOwner, ticketReadiness } from '../mcp/local-tickets.js';
import { jobCache } from '../mcp/store/job-store.js';
import { startTicketQueue } from '../mcp/ticket-queue.js';
import { ensureJobWatcher } from '../mcp/watch-pid.js';
import { registeredProject } from '../roles/projects.js';
import { tryAbstractLock } from '../utils/abstract-lock.js';
import { writeJsonPrivate } from '../utils/atomic-fs.js';
import { waitUntilFs, type WatchTarget } from '../utils/fs-wait.js';
import { procStat, readBootId } from '../utils/proc.js';
import { wakeWorkflow } from '../workflows/wake.js';
import { withControl } from './control.js';
import {
  controlPath, diagnosticsPath, hasOpenHold, identityPath, indexPath, isOpenTicketRun, MAX_OPEN_ITEMS, openRunTickets,
  readControl, readRunIndex, readUnattendedDiagnostics, readUnattendedStatus, type UnattendedControl, type UnattendedDiagnostic,
} from './state.js';

const DEFAULT_RECONCILE_MS = 180_000;
const DEGRADED_RECONCILE_MS = 30_000;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 1500);

function statStamp(path: string): string {
  const st = fs.lstatSync(path, { throwIfNoEntry: false });
  return st ? `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}` : '';
}

/** Lightweight metadata-only stamp across control, objectives, runs, jobs dir and ticket files (no body reads). */
function computeInputStamp(home: string, control: UnattendedControl, runIds: readonly string[], liveJobIds: readonly string[]): string {
  const parts: string[] = [
    JSON.stringify(control),
    statStamp(join(control.root, '.hud', 'objectives.md')),
    statStamp(indexPath(home)),
    statStamp(join(home, 'jobs')),
  ];
  for (const id of runIds) parts.push(`${id}=${statStamp(join(home, 'flows', `${id}.json`))}`);
  for (const id of liveJobIds) parts.push(`j:${id}=${statStamp(join(home, 'jobs', id, 'STATUS.json'))}`);
  const scratch = join(control.root, '.scratch');
  const scratchSt = fs.lstatSync(scratch, { throwIfNoEntry: false });
  if (scratchSt?.isDirectory()) {
    parts.push(`s=${scratchSt.mtimeMs}`);
    try {
      const features = fs.readdirSync(scratch, { withFileTypes: true }).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
      for (const feat of features) {
        const issues = join(scratch, feat.name, 'issues');
        const issSt = fs.lstatSync(issues, { throwIfNoEntry: false });
        if (!issSt?.isDirectory()) continue;
        parts.push(`f:${feat.name}=${issSt.mtimeMs}`);
        const files = fs.readdirSync(issues, { withFileTypes: true }).filter(e => e.isFile() && /^\d+-.+\.md$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
        for (const f of files) parts.push(`${feat.name}/${f.name}=${statStamp(join(issues, f.name))}`);
      }
    } catch { parts.push('scratch-err'); }
  }
  return parts.join('|');
}

function groupBySelectedObjective(control: UnattendedControl, home: string) {
  const objectives = readObjectives(control.root)?.objectives ?? [];
  const selected = objectives.filter(o => o.state === 'active' && control.objectives.includes(o.id));
  if (!selected.length) return { byObjective: new Map<string, { ticket: string; path: string }[]>(), liveJobIds: [] as string[] };
  // One readiness pass per admission batch; ticketReadiness memoizes unchanged ticket bodies and excludes open holds.
  const readiness = ticketReadiness(control.root, jobCache, undefined, { home, excludeTickets: openRunTickets(home, control.root) });
  const byObjective = new Map<string, { ticket: string; path: string }[]>();
  for (const { ticket, path, objective: declared } of readiness.tickets) {
    const ownerId = ticketObjectiveOwner(objectives, ticket, declared);
    const owner = selected.find(o => o.id === ownerId);
    if (!owner) continue;
    const list = byObjective.get(owner.id) ?? [];
    list.push({ ticket, path });
    byObjective.set(owner.id, list);
  }
  const liveJobIds: string[] = [];
  try {
    for (const id of jobCache.listJobIds()) {
      const st = jobCache.readStatus(id);
      const state = st.status === 'ok' ? st.value.state : undefined;
      if (!state || state === 'working' || state === 'queued' || state === 'waiting_orchestrator') liveJobIds.push(id);
    }
  } catch { /* Best-effort live job tracking for stamp invalidation. */ }
  return { byObjective, liveJobIds };
}

interface ScanState {
  lastStamp?: string;
  liveJobIds: string[];
  lastIssues: UnattendedDiagnostic[];
}

async function scan(home: string, control: UnattendedControl, state: ScanState, forceRecheck: boolean): Promise<UnattendedDiagnostic[]> {
  const { runs, running } = readUnattendedStatus(home);
  // Resume an interrupted workflow driver, not a terminal run. Drivers don't belong to the service process.
  for (const q of running) wakeWorkflow(home, q);
  if (running.length) ensureJobWatcher(home);

  const active = runs.filter(isOpenTicketRun);
  const open = runs.filter(q => isOpenTicketRun(q) || hasOpenHold(q));
  const openIds = new Set(open.map(q => q.flow));
  const recent = runs.filter(q => !openIds.has(q.flow) && (q.state === 'completed' || q.state === 'cancelled')).slice(-16);
  const keep = Math.max(0, Math.min(recent.length, MAX_OPEN_ITEMS - open.length - 1));
  let ids = [...recent.slice(recent.length - keep), ...open].map(q => q.flow);

  await withControl(home, () => {
    if (!same(readControl(home), control)) return;
    if (!same(ids, readRunIndex(home))) writeJsonPrivate(indexPath(home), ids);
  });

  if (!registeredProject(home, control.root).registered) throw Error('Unattended project is no longer registered');

  await retryPendingFlakeCollections(home, control.root, null).catch(() => {});

  const stamp = computeInputStamp(home, control, ids, state.liveJobIds);
  if (!forceRecheck && state.lastStamp === stamp) {
    return state.lastIssues;
  }

  const { byObjective, liveJobIds } = groupBySelectedObjective(control, home);
  state.liveJobIds = liveJobIds;
  const issues: UnattendedDiagnostic[] = [];
  const busy = new Set(active.filter(q => q.root === control.root).map(q => q.unattended!.objective));

  for (const objective of control.objectives) {
    if (!same(readControl(home), control)) break;
    if (busy.has(objective)) continue;
    const ready = byObjective.get(objective);
    if (!ready?.length) continue;
    const gaps = checkTicketPaths(control.root, ready);
    for (const g of gaps) {
      if (issues.length < 15) issues.push({ ticket: g.ticket, objective, reason: `ticket_check_failed: ${g.ticket}: ${g.gaps.join(', ')}` });
    }
    const invalid = new Set(gaps.map(g => g.ticket));
    const valid = ready.filter(t => !invalid.has(t.ticket));
    if (!valid.length) continue;
    if (ids.length >= MAX_OPEN_ITEMS) {
      issues.unshift({ reason: 'Unattended run limit reached; close held tickets to make room' });
      break;
    }
    await withControl(home, async () => {
      // Linearize off and selection changes against admission, not against the workflow's settlement.
      if (!same(readControl(home), control)) return;
      const flow = `q${randomBytes(8).toString('hex')}`;
      writeJsonPrivate(indexPath(home), [...ids, flow]);
      try {
        const q = await startTicketQueue(home, control.root, null, false, { feature: objective }, undefined, { flow, objective, ready: valid });
        if (q) {
          ids = [...ids, flow];
          busy.add(objective);
          ensureJobWatcher(home);
        }
      } finally {
        if (ids.at(-1) !== flow) writeJsonPrivate(indexPath(home), ids);
      }
    }).catch(error => {
      if (issues.length < 15) issues.push({ objective, reason: reason(error) });
    });
  }

  state.lastStamp = computeInputStamp(home, control, ids, state.liveJobIds);
  state.lastIssues = issues;
  return issues;
}

async function publishDiagnostics(home: string, control: UnattendedControl, issues: UnattendedDiagnostic[]) {
  await withControl(home, () => {
    if (same(readControl(home), control) && !same(issues, readUnattendedDiagnostics(home)))
      writeJsonPrivate(diagnosticsPath(home), issues);
  });
}

function watchTargets(home: string, control: UnattendedControl | undefined): WatchTarget[] {
  const controlName = basename(controlPath(home)), flows = join(home, 'flows');
  const targets: WatchTarget[] = [
    { dir: home, filter: file => !file || file === controlName || file === basename(indexPath(home)) || file === 'flows' },
    { dir: join(home, 'jobs'), recursive: true, filter: file => !file || /(?:^|\/)(?:job|STATUS)\.json$/.test(file) },
  ];
  // First admission creates flows/. Watch its creation in home rather than leave a failed watcher until fallback.
  if (fs.existsSync(flows)) targets.push({ dir: flows, filter: file => !file || /^[qf][a-f0-9]{16}(?:-\d+)?\.json$/.test(file) });
  if (control?.root) {
    targets.push(
      { dir: join(control.root, '.hud'), filter: file => !file || file === 'objectives.md' },
      { dir: join(control.root, '.scratch'), recursive: true },
    );
  }
  return targets;
}

export async function runUnattended() {
  const home = getHudHome();
  const release = await tryAbstractLock('unattended', home);
  if (!release) return;
  try {
    const start = procStat(process.pid)?.start, boot_id = readBootId();
    if (!start || !boot_id) throw Error('Cannot read unattended process identity');
    if (!readControl(home)?.enabled) return;
    writeJsonPrivate(identityPath(home), { pid: process.pid, start, boot_id });
    if (process.connected) process.send?.('ready', () => {});

    const envMs = Number(process.env.HUD_UNATTENDED_RECONCILE_MS);
    const reconcileMs = Number.isFinite(envMs) && envMs >= 500 ? envMs : DEFAULT_RECONCILE_MS;
    const scanState: ScanState = { liveJobIds: [], lastIssues: [] };
    let currentControl: UnattendedControl | undefined = readControl(home);

    await waitUntilFs<void>({
      timeoutMs: Infinity,
      coalesceMs: 50,
      fallbackIntervalMs: reconcileMs,
      degradedIntervalMs: Math.min(DEGRADED_RECONCILE_MS, reconcileMs),
      targets: () => watchTargets(home, currentControl),
      check: async ({ reason: wakeReason }) => {
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
        currentControl = control;
        if (!control) return { done: true, value: undefined };
        const forceRecheck = wakeReason === 'event';
        const issues = await scan(home, control, scanState, forceRecheck).catch(error => [{ reason: reason(error) }]);
        await publishDiagnostics(home, control, issues);
        return { done: false };
      },
    });
  } finally { await release(); }
}
