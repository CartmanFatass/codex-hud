/** Bounded native STATUS observation. Snapshots are evidence, not a heartbeat. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { isRecord } from './herdr-run.js';
import { dispatchText, type PiDispatch } from './pi-dispatch.js';

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
export interface DispatchObservation {
  state: 'open' | 'done' | 'error' | 'closed' | 'launch_unknown';
  status: DispatchState | 'unreadable';
  dispatch: DispatchStatus | null;
  helpers: { slot: string; state: DispatchState; output_written: boolean; exit_reason: string | null }[];
  diagnostics: { path: string; reason: string }[];
  pending: { id: string; path: string }[];
  report: string | null;
  report_path: string;
  acceptance: null;
  continuation: 'unconfirmed' | 'unavailable' | null;
  asking_slot?: string;
  event?: 'DONE' | 'FAILED' | 'QUESTION' | 'BLOCKED' | 'timeout';
}
const STATES = ['working', 'waiting_helper', 'waiting_orchestrator', 'idle_grace', 'closed', 'failed'];
const HELPER = /^(sonic|review|architect)-([1-9][0-9]{0,5})$/;
const LIMIT_HELPERS = 64;

function nullableText(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= 4096 && !value.includes('\0'));
}
function timestamp(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)));
}

function snapshot(file: string, directory: string, slot: string, role: string, output: string): DispatchStatus | null {
  const text = dispatchText(file, 64 * 1024);
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return parseDispatchStatus(raw, directory, slot, role, output);
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

function directEntries(directory: string, limit: number): { entries: fs.Dirent[]; truncated: boolean } {
  if (fs.realpathSync(directory) !== directory) throw new Error('unsafe_directory');
  const handle = fs.opendirSync(directory);
  const entries: fs.Dirent[] = [];
  try {
    for (;;) {
      const entry = handle.readSync();
      if (!entry) return { entries, truncated: false };
      if (entries.length >= limit) return { entries, truncated: true };
      entries.push(entry);
    }
  } finally {
    handle.closeSync();
  }
}

/** File evidence only: the legacy QA protocol has no consumed receipt. */
export function dispatchQuestions(
  directory: string,
  diagnostics: DispatchObservation['diagnostics'] = []
): { id: string; path: string }[] {
  const qa = join(directory, 'qa');
  try {
    const { entries, truncated } = directEntries(qa, 512);
    if (truncated) diagnostics.push({ path: qa, reason: 'truncated' });
    const result = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !/^q[1-9][0-9]{0,3}\.md$/.test(entry.name)) continue;
      const file = join(qa, entry.name);
      if (dispatchText(file, 64 * 1024) === null) continue;
      const answer = join(qa, entry.name.replace('.md', '.answer.md'));
      // hud_respond accepts 16 KiB and may append one normalization newline.
      const text = dispatchText(answer, 16 * 1024 + 1);
      const eligible =
        text !== null && text.trim().length > 0 && fs.statSync(answer).mtimeMs >= fs.statSync(file).mtimeMs;
      if (!eligible) result.push({ id: entry.name.slice(0, -3), path: file });
      if (result.length >= 100) {
        diagnostics.push({ path: qa, reason: 'truncated' });
        break;
      }
    }
    return result;
  } catch {
    return [];
  }
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

export function observeDispatch(directory: string, metadata: PiDispatch, closed = false): DispatchObservation {
  const report = join(directory, 'report.md');
  const primaryFile = join(directory, 'STATUS.json');
  const primary = snapshot(primaryFile, directory, 'primary', metadata.role, report);
  const diagnostics: DispatchObservation['diagnostics'] = [];
  if (!primary) diagnostics.push({ path: primaryFile, reason: 'missing_malformed_or_unsupported' });
  const helpers: DispatchObservation['helpers'] = [];
  const helperStatuses = new Map<string, DispatchStatus>();
  const helperDir = join(directory, '.dispatch');
  try {
    const { entries, truncated } = directEntries(helperDir, 256);
    if (truncated) diagnostics.push({ path: helperDir, reason: 'truncated' });
    let count = 0;
    for (const entry of entries) {
      const match = HELPER.exec(entry.name);
      if (!match) continue;
      if (++count > LIMIT_HELPERS) {
        diagnostics.push({ path: helperDir, reason: 'truncated' });
        break;
      }
      const file = join(helperDir, entry.name, 'STATUS.json');
      const role = match[1] === 'review' ? 'reviewer' : match[1]!;
      const value = entry.isDirectory()
        ? snapshot(file, directory, entry.name, role, join(directory, `${entry.name}.md`))
        : null;
      if (!value) {
        diagnostics.push({ path: file, reason: 'missing_malformed_or_unsupported' });
        continue;
      }
      helpers.push({
        slot: value.slot,
        state: value.state,
        output_written: value.output_written,
        exit_reason: value.exit_reason,
      });
      helperStatuses.set(value.slot, value);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostics.push({ path: helperDir, reason: 'unreadable' });
  }
  let continuation: DispatchObservation['continuation'] = null;
  const baseline = metadata.continuation;
  if (baseline && primary) {
    if (primary.session_id !== baseline.previous_session_id || primary.settled_at === baseline.previous_settled_at) {
      continuation = primary.state === 'closed' || primary.state === 'failed' ? 'unavailable' : 'unconfirmed';
    }
  } else if (baseline) continuation = 'unconfirmed';
  const settled = primary?.state === 'idle_grace' || primary?.state === 'closed';
  const state = closed
    ? 'closed'
    : !primary
      ? 'launch_unknown'
      : continuation
        ? 'open'
        : settled
          ? 'done'
          : primary.state === 'failed'
            ? 'error'
            : 'open';
  let event: DispatchObservation['event'];
  const active = primary?.helper_pending;
  const activeHelper = active?.n ? helperStatuses.get(`${active.kind}-${active.n}`) : undefined;
  const pending = dispatchQuestions(directory, diagnostics);
  const question =
    metadata.contract_version === 2 && primary ? activeDispatchQuestion(directory, primary, helperStatuses) : null;
  if (question?.unknown) diagnostics.push({ path: primaryFile, reason: 'active_helper_unknown' });
  const askingSlot = question
    ? question.slot
    : primary?.state === 'waiting_orchestrator'
      ? 'primary'
      : activeHelper?.state === 'waiting_orchestrator'
        ? activeHelper.slot
        : null;
  if (!continuation && primary?.state === 'failed') event = 'FAILED';
  else if (!continuation && settled) event = 'DONE';
  // Historical unanswered files can survive the legacy QA timeout. They are
  // pointers, not evidence that the current primary/helper is still asking.
  else if (askingSlot) event = 'QUESTION';
  else if (closed || continuation === 'unavailable') event = 'BLOCKED';
  return {
    state,
    status: primary?.state ?? 'unreadable',
    dispatch: primary,
    helpers,
    diagnostics,
    pending,
    report: primary?.output_written && !continuation && dispatchText(report, 4 * 1024 * 1024)?.trim() ? report : null,
    report_path: report,
    acceptance: null,
    continuation,
    ...(askingSlot ? { asking_slot: askingSlot } : {}),
    ...(event ? { event } : {}),
  };
}

export interface DispatchWaitOptions {
  directory: string;
  /** Test seam; production always uses fs.watch. */
  watch?: (directory: string, changed: () => void) => fs.FSWatcher;
}

/** Each call owns its watchers and monotonic budget; no shared delivered bit. */
export async function waitDispatch<T extends { event?: DispatchObservation['event'] }>(
  observe: (remainingMs: number, checkHerdr: boolean) => Promise<T>,
  timeoutMs: number,
  options?: DispatchWaitOptions
): Promise<T & { event: NonNullable<DispatchObservation['event']> }> {
  // hrtime is monotonic without loading Node's performance-observer subsystem.
  const monotonicNow = () => Number(process.hrtime.bigint()) / 1_000_000;
  const deadline = monotonicNow() + timeoutMs;
  const watchers = new Map<string, fs.FSWatcher>();
  const unavailable = new Set<string>();
  let coalesce: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  let changed = false;
  const signal = () => {
    if (coalesce || changed) return;
    coalesce = setTimeout(() => {
      coalesce = undefined;
      changed = true;
      wake?.();
    }, 50);
  };
  const refresh = () => {
    if (!options) return;
    const directory = options.directory;
    const paths = [directory, join(directory, 'qa'), join(directory, '.dispatch')];
    // Shallow and capped: only direct slots, never a status_file from JSON.
    try {
      const { entries } = directEntries(join(directory, '.dispatch'), 256);
      let count = 0;
      for (const entry of entries) {
        if (count >= LIMIT_HELPERS) break;
        if (entry.isDirectory() && HELPER.test(entry.name)) {
          paths.push(join(directory, '.dispatch', entry.name));
          count++;
        }
      }
    } catch {
      /* Parent events or the fallback poll will retry a missing dir. */
    }
    for (const path of paths) {
      if (watchers.has(path) || unavailable.has(path)) continue;
      try {
        if (fs.realpathSync(path) !== path) continue;
        const watcher = options.watch ? options.watch(path, signal) : fs.watch(path, signal);
        watchers.set(path, watcher);
        watcher.on('error', () => {
          watcher.close();
          watchers.delete(path);
          unavailable.add(path);
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailable.add(path);
      }
    }
  };
  let interval = 1000;
  let nextPoll = monotonicNow();
  try {
    refresh(); // Before the first read: do not lose a rename in the read/arm gap.
    for (;;) {
      const checkHerdr = monotonicNow() >= nextPoll;
      const value = await observe(Math.max(0, Math.ceil(deadline - monotonicNow())), checkHerdr);
      if (value.event) return { ...value, event: value.event };
      const now = monotonicNow();
      if (now >= deadline) return { ...value, event: 'timeout' };
      refresh();
      if (checkHerdr) {
        nextPoll = now + interval;
        interval = Math.min(interval * 2, 8000);
      }
      const sleep = Math.max(1, Math.ceil(Math.min(nextPoll, deadline) - monotonicNow()));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = undefined;
          resolve();
        }, sleep);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
        if (changed) wake();
      });
      changed = false;
    }
  } finally {
    if (coalesce) clearTimeout(coalesce);
    for (const watcher of watchers.values()) watcher.close();
  }
}
