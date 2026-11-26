import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ticketFileEvidence } from '../collectors/ticket-evidence.js';
import { completedLandForJob } from '../mcp/land-state.js';
import { isTicketQueueId, queueCancelled, queueFile, queueIds, readTicketQueue, type TicketHandbackKind, type TicketQueue } from '../mcp/ticket-queue-state.js';
import { readFileBounded, readJsonBounded } from '../utils/atomic-fs.js';
import { isProcAlive, isValidPid, readBootId } from '../utils/proc.js';
import { workflowHeaders } from '../workflows/header-scan.js';

export const MAX_OBJECTIVES = 32;
export const MAX_OPEN_ITEMS = 128;
export const ESCALATION_RULE = 'Escalate only when this ticket requires deleting a user-visible feature or changing docs/spec.md. Otherwise work within the current spec; use repair or record non-blocking issues as Todo. Never create an Objective or edit docs/spec.md.';
export type OwnerApproval = 'feature-deletion' | 'spec-change';
export interface UnattendedRun { objective: string }
export interface UnattendedControl { enabled: boolean; root: string; objectives: string[] }
export interface UnattendedIdentity { pid: number; start: string; boot_id: string }
export interface UnattendedHandback {
  flow: string; root: string; objective: string;
  ticket?: string; path?: string; job?: string;
  reason: string; at: string;
  kind?: TicketHandbackKind; owner_approval?: OwnerApproval;
}
export const controlPath = (home: string) => join(home, 'unattended.json');
export const identityPath = (home: string) => join(home, 'unattended.pid.json');
export const indexPath = (home: string) => join(home, 'unattended-runs.json');
export const diagnosticsPath = (home: string) => join(home, 'unattended-diagnostics.json');
export interface UnattendedDiagnostic { ticket?: string; objective?: string; reason: string }

const memo = new Map<string, { stamp: string; value: unknown }>();
function unchanged<T>(file: string, parse: () => T): T | undefined {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) { memo.delete(file); return; }
  const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const hit = memo.get(file);
  if (hit?.stamp === stamp) return hit.value as T;
  try {
    const value = parse();
    memo.delete(file);
    if (memo.size >= 384) memo.delete(memo.keys().next().value!);
    memo.set(file, { stamp, value });
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
const read = <T>(file: string, limit: number) => unchanged(file, () => readJsonBounded(file, limit) as T);
export const readControl = (home: string) => read<UnattendedControl>(controlPath(home), 128 * 1024);
export const readRunIndex = (home: string) => read<string[]>(indexPath(home), 4096) ?? [];
let boot: string | null | undefined;
export function liveIdentity(home: string) {
  const id = read<UnattendedIdentity>(identityPath(home), 1024);
  if (id && isValidPid(id.pid) && /^\d+$/.test(id.start) && id.boot_id && id.boot_id === (boot ??= readBootId()) && isProcAlive(id.pid, id.start)) return id;
}
export function unattendedOn(home: string): boolean {
  try { return readControl(home)?.enabled === true && !!liveIdentity(home); }
  catch { return false; }
}

function ticketClosedState(path: string): boolean | undefined {
  try {
    return unchanged(path, () => {
      const { bytes, truncated } = readFileBounded(path, 64 * 1024);
      return !truncated && /^(?:done|wontfix|ready-for-human)$/i.test(ticketFileEvidence(bytes.toString('utf8')).status ?? '');
    });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : false;
  }
}

export function itemClosed(path: string): boolean {
  return ticketClosedState(path) ?? true;
}

/** Positive closure evidence for ordinary holds and resume: a missing or unreadable path is not closed. */
export function ticketClosed(path: string): boolean {
  return ticketClosedState(path) === true;
}

export function openHoldsInRun(q: TicketQueue): UnattendedHandback[] {
  if (!q.unattended) return [];
  const holds: UnattendedHandback[] = [];
  for (const item of q.tickets ?? []) {
    if (!item.held || itemClosed(item.path)) continue;
    holds.push({
      flow: q.flow, root: q.root, objective: q.unattended.objective,
      ticket: item.ticket, path: item.path,
      ...(item.job && { job: item.job }),
      reason: item.held.reason, at: item.held.at,
      ...(item.held.kind && { kind: item.held.kind }),
      ...(item.held.owner_approval && { owner_approval: item.held.owner_approval }),
    });
  }
  if ((q.state === 'paused' || q.state === 'cancelled') && q.held) {
    holds.push({
      flow: q.flow, root: q.root, objective: q.unattended.objective,
      reason: q.held.reason, at: q.held.at,
      ...(q.held.kind && { kind: q.held.kind }),
      ...(q.held.owner_approval && { owner_approval: q.held.owner_approval }),
    });
  }
  return holds;
}

export function hasOpenHold(q: TicketQueue | null | undefined): boolean {
  return !!q && openHoldsInRun(q).length > 0;
}

export function isOpenTicketRun(q: TicketQueue): boolean {
  return q.state === 'working' || q.state === 'paused';
}

const cachedQueue = (home: string, id: string) => unchanged(queueFile(home, id), () => readTicketQueue(home, id));

/** A settled job can look ready on the board while its queue still owns the ticket. */
export function openRunTickets(home: string, root: string, except?: string): Set<string> {
  const tickets = new Set<string>();
  for (const id of queueIds(home)) {
    if (id === except) continue;
    const run = cachedQueue(home, id);
    if (run?.root === root && isOpenTicketRun(run)) {
      for (const item of run.tickets) if (item.job) tickets.add(item.ticket);
    }
  }
  return tickets;
}

function indexedRuns(home: string): TicketQueue[] {
  return readRunIndex(home).filter(isTicketQueueId)
    .map(id => cachedQueue(home, id))
    .filter((q): q is TicketQueue => !!q?.unattended);
}

export function readOpenHolds(home: string, root?: string): UnattendedHandback[] {
  try {
    return indexedRuns(home)
      .filter(q => !root || q.root === root)
      .flatMap(openHoldsInRun);
  } catch {
    return [];
  }
}

export interface PinnedQueueJobs {
  /** Unresolved holds: keep worktree checkout, raw logs, job directory and land receipts. */
  held: Set<string>;
  /** Lands that resolve ordinary holds: keep the source report and land receipts, not the worktree or raw logs. */
  evidence: Set<string>;
}

export function pinnedQueueJobs(home: string, pass = workflowHeaders(home)): PinnedQueueJobs {
  const held = new Set<string>();
  const evidence = new Set<string>();
  try {
    for (const q of indexedRuns(home)) {
      for (const item of q.tickets ?? []) {
        if (!item.job) continue;
        if (item.held && !itemClosed(item.path)) held.add(item.job);
        else if ((q.state === 'paused' || q.state === 'cancelled') && q.held && !item.landed && !itemClosed(item.path)) held.add(item.job);
      }
    }
  } catch { /* Unreadable index gives no extra pins. */ }
  for (const file of pass.files) {
    if (!file.endsWith('.json') || !isTicketQueueId(file.slice(0, -5))) continue;
    try {
      const q = pass.header<TicketQueue>(file);
      if (!q || q.unattended || !isOpenTicketRun(q) || q.superseded_by || queueCancelled(home, q)) continue;
      for (const item of q.tickets ?? []) {
        if (!item.job) continue;
        if (item.landed) {
          if (item.held_land && item.held_land === item.land) evidence.add(item.job);
          continue;
        }
        if (!item.held) continue;
        // Before adoption, only a completed receipt for the held job resolves its hold.
        let landed: boolean | 'error' = false;
        try { landed = !!completedLandForJob(home, item.job, pass); }
        catch { landed = 'error'; }
        if (landed === true) evidence.add(item.job);
        else if (landed === 'error' || !ticketClosed(item.path)) held.add(item.job);
      }
    } catch { /* Ignore an unreadable queue, not other holds. */ }
  }
  return { held, evidence };
}

export function pinnedHeldJobs(home: string, pass = workflowHeaders(home)): Set<string> {
  return pinnedQueueJobs(home, pass).held;
}

export function readUnattendedStatus(home: string) {
  const control = readControl(home), identity = control && liveIdentity(home);
  const runs = indexedRuns(home);
  const running = runs.filter(q => q.state === 'working');
  const handbacks = runs.flatMap(openHoldsInRun);
  return { on: !!identity && control?.enabled === true, identity, control, runs, running, handbacks };
}
export function readUnattendedDiagnostics(home: string) {
  return read<UnattendedDiagnostic[]>(diagnosticsPath(home), 64 * 1024) ?? [];
}
