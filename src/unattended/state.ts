import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ticketFileEvidence } from '../collectors/ticket-evidence.js';
import { isTicketQueueId, queueFile, readTicketQueue, type TicketQueue } from '../mcp/ticket-queue-state.js';
import { readFileBounded, readJsonBounded } from '../utils/atomic-fs.js';
import { isProcAlive, isValidPid, readBootId } from '../utils/proc.js';

export const MAX_OBJECTIVES = 32;
export const MAX_OPEN_ITEMS = 128;
export const ESCALATION_RULE = 'Escalate only when this ticket requires deleting a user-visible feature or changing docs/spec.md. Otherwise work within the current spec; use repair or record non-blocking issues as Todo. Never create an Objective or edit docs/spec.md.';
export type OwnerApproval = 'feature-deletion' | 'spec-change';
export interface UnattendedItem { objective: string; ticket: string; path: string }
export interface UnattendedControl { enabled: boolean; root: string; objectives: string[] }
export interface UnattendedIdentity { pid: number; start: string; boot_id: string }
export const controlPath = (home: string) => join(home, 'unattended.json');
export const identityPath = (home: string) => join(home, 'unattended.pid.json');
export const indexPath = (home: string) => join(home, 'unattended-runs.json');
export const diagnosticsPath = (home: string) => join(home, 'unattended-diagnostics.json');
export interface UnattendedDiagnostic { ticket?: string; reason: string }

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

export function itemClosed(item: UnattendedItem): boolean {
  try {
    return unchanged(item.path, () => {
      const { bytes, truncated } = readFileBounded(item.path, 64 * 1024);
      return !truncated && /^(?:done|wontfix|ready-for-human)$/i.test(ticketFileEvidence(bytes.toString('utf8')).status ?? '');
    }) ?? true;
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
}

export function readUnattendedStatus(home: string) {
  const control = readControl(home), identity = control && liveIdentity(home);
  const runs = (control ? readRunIndex(home) : []).filter(isTicketQueueId)
    .map(id => unchanged(queueFile(home, id), () => readTicketQueue(home, id))).filter((q): q is TicketQueue => !!q?.unattended);
  const running = runs.filter(q => q.state === 'working');
  const handbacks = runs.filter(q => q.state === 'paused' && q.handback?.owner_approval && !itemClosed(q.unattended!));
  return { on: !!identity && control?.enabled === true, identity, control, runs, running, handbacks };
}
export function readUnattendedDiagnostics(home: string) {
  return read<UnattendedDiagnostic[]>(diagnosticsPath(home), 64 * 1024) ?? [];
}
