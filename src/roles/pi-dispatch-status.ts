/** Bounded native STATUS observation. Snapshots are evidence, not a heartbeat. */
import { join } from 'node:path';
import { isRecord } from './herdr-run.js';

export type DispatchState = 'working' | 'waiting_helper' | 'waiting_orchestrator' | 'idle_grace' | 'closed' | 'failed';
export interface DispatchStatus {
  state: DispatchState;
  session_id: string;
  slot: string;
  /** Owned producer parent slot; legacy producers may omit it. */
  parent?: string | null;
  /** Optional producer event; invalid metadata does not alter the dispatch protocol. */
  started_at?: string | null;
  model: string | null;
  thinking: string | null;
  output_written: boolean;
  settled_at: string | null;
  idle_deadline_at: string | null;
  ended_at: string | null;
  error: string | null;
  exit_reason: string | null;
  helper_pending: { kind: string; n: number | null; status_file: string | null } | null;
}
const STATES = ['working', 'waiting_helper', 'waiting_orchestrator', 'idle_grace', 'closed', 'failed'];

function nullableText(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= 4096 && !value.includes('\0'));
}
function timestamp(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)));
}

/** Single-file parser shared with the incremental read-only tree observer. */
export function parseDispatchStatus(
  raw: unknown,
  directory: string,
  slot: string,
  role: string,
  output: string
): DispatchStatus | null {
  if (
    !isRecord(raw) ||
    raw.version !== 1 ||
    raw.task_dir !== directory ||
    raw.slot !== slot ||
    raw.role !== role ||
    raw.output_path !== output ||
    typeof raw.state !== 'string' ||
    !STATES.includes(raw.state) ||
    typeof raw.output_written !== 'boolean' ||
    typeof raw.session_id !== 'string' ||
    raw.session_id.length < 1 ||
    raw.session_id.length > 400 ||
    !['model', 'thinking', 'error', 'exit_reason'].every((key) => nullableText(raw[key])) ||
    !['settled_at', 'idle_deadline_at', 'ended_at'].every((key) => timestamp(raw[key]))
  )
    return null;
  let pending: DispatchStatus['helper_pending'] = null;
  if (raw.helper_pending !== null) {
    const h = raw.helper_pending;
    if (
      !isRecord(h) ||
      !['sonic', 'review', 'architect'].includes(String(h.kind)) ||
      !(h.n === null || (Number.isSafeInteger(h.n) && Number(h.n) > 0)) ||
      !nullableText(h.status_file)
    )
      return null;
    pending = { kind: String(h.kind), n: h.n as number | null, status_file: h.status_file };
  }
  return {
    state: raw.state as DispatchState,
    session_id: raw.session_id,
    slot,
    ...(raw.parent === null || typeof raw.parent === 'string' ? { parent: raw.parent } : {}),
    started_at: timestamp(raw.started_at) ? (raw.started_at as string | null) : null,
    model: raw.model as string | null,
    thinking: raw.thinking as string | null,
    output_written: raw.output_written,
    settled_at: raw.settled_at as string | null,
    idle_deadline_at: raw.idle_deadline_at as string | null,
    ended_at: raw.ended_at as string | null,
    error: raw.error as string | null,
    exit_reason: raw.exit_reason as string | null,
    helper_pending: pending,
  };
}

/** Follow only recorded active slots, never producer-selected paths. PR3 permits at most two edges. */
export function activeDispatchQuestion(
  directory: string,
  primary: DispatchStatus,
  helpers: ReadonlyMap<string, DispatchStatus>
): { slot: string | null; unknown: boolean } {
  let current = primary;
  const seen = new Set(['primary']);
  if (primary.parent !== null) return { slot: null, unknown: true };
  for (let depth = 0; ; depth++) {
    const pending = current.helper_pending;
    if (!pending) return { slot: current.state === 'waiting_orchestrator' ? current.slot : null, unknown: false };
    if (depth >= 2 || current.state !== 'waiting_helper' || !pending.n) return { slot: null, unknown: true };
    const slot = `${pending.kind}-${pending.n}`;
    if (
      !/^(?:sonic-(?:[1-9]|10)|review-[1-3])$/.test(slot) ||
      seen.has(slot) ||
      pending.status_file !== join(directory, '.dispatch', slot, 'STATUS.json') ||
      (depth === 1 && (!current.slot.startsWith('review-') || !slot.startsWith('sonic-')))
    )
      return { slot: null, unknown: true };
    const next = helpers.get(slot);
    if (!next || next.parent !== current.slot) return { slot: null, unknown: true };
    seen.add(slot);
    current = next;
  }
}
