import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ticketFileEvidence } from '../collectors/ticket-evidence.js';
import { isTicketQueueId, queueFile, readTicketQueue, type TicketHandbackKind, type TicketQueue } from '../mcp/ticket-queue-state.js';
import { readFileBounded, readJsonBounded } from '../utils/atomic-fs.js';
import { isProcAlive, isValidPid, readBootId } from '../utils/proc.js';

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

export function itemClosed(path: string): boolean {
  try {
    return unchanged(path, () => {
      const { bytes, truncated } = readFileBounded(path, 64 * 1024);
      return !truncated && /^(?:done|wontfix|ready-for-human)$/i.test(ticketFileEvidence(bytes.toString('utf8')).status ?? '');
    }) ?? true;
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
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
  if (q.state === 'paused' && q.held) {
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

function indexedRuns(home: string): TicketQueue[] {
  return readRunIndex(home).filter(isTicketQueueId)
    .map(id => unchanged(queueFile(home, id), () => readTicketQueue(home, id)))
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

export function pinnedHeldJobs(home: string): Set<string> {
  const pinned = new Set<string>();
  try {
    for (const q of indexedRuns(home)) {
      for (const item of q.tickets ?? []) {
        if (!item.job) continue;
        if (item.held && !itemClosed(item.path)) pinned.add(item.job);
        else if (q.state === 'paused' && q.held && !item.landed && !itemClosed(item.path)) pinned.add(item.job);
      }
    }
  } catch { /* Unreadable index gives no extra pins. */ }
  return pinned;
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
