import { taskText } from '../utils/task-text.js';
import { extractAgentReport, type AgentReport } from './agent-report.js';
import { applyLedgerEntry, currentAction, newLedger, type AgentLedger } from './agent-stages.js';
import { SAVE_MIN_BYTES, SCAN_VERSION, scanPrint, type SavedScan, type TreeScanStore } from './tree-scan-store.js';
/**
 * Build a multi-level subagent tree from rollout session_meta parent links.
 */

import * as fs from 'fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { sessionParentId } from '../utils/session-parent.js';
import { findRolloutsInDays, treeLookbackDays, type SessionFile } from './session-finder.js';
import type { AgentAction, AgentStage, SubagentInfo, SubagentStatus, SubagentTree, SubagentTreeNode } from '../types.js';

// session_meta is the first line and never changes on append, so each rollout
// only needs to be read once. Cache entries re-validate by stat signature and
// re-peek when the file shrank (truncation/rotation rewrites the first line).
interface CachedLink {
  link: SessionLink | null;
  size: number;
  mtimeMs: number;
  ino?: number;
  // Last time the first line was actually read for this entry. Stat signatures
  // cannot detect same-signature rewrites, so entries older than
  // REVALIDATE_INTERVAL_MS get re-peeked (bounded per tick) to bound how long
  // a stale link can survive.
  verifiedAt: number;
  // Byte offset already scanned for model/effort and lifecycle events.
  contextOffset: number;
  // The hash of the bytes just before contextOffset (scanPrint): the scan
  // still describes the file while they are unchanged.
  contextPrint?: string;
}

const linkCache = new Map<string, CachedLink>();

let scanStore: TreeScanStore | undefined;

/**
 * Keep each rollout's scan on disk (tree-scan-store.ts), so a process started
 * again reads only what was written since. Off unless a process asks: the
 * panel and the bar do, the brief's dry run reads without writing.
 */
export function useTreeScanStore(store: TreeScanStore | undefined): void {
  scanStore = store;
}

/** Writes the scans that moved on, when the process stops. */
export function flushTreeScans(): void {
  scanStore?.flush();
}

// Bound the staleness window of stat-only caching: re-peek at most this many
// known files per build call, oldest verification first.
const REPEEK_BUDGET_PER_TICK = 2;
const REVALIDATE_INTERVAL_MS = 30_000;

export function resetSubagentLinkCache(): void {
  linkCache.clear();
}

interface SessionLink extends AgentIdentity {
  /** The session_meta bytes (as read by readFirstLine), independent of append. */
  headerPrint?: string;
  lastReport?: AgentReport;
  task?: string;
  id: string;
  parentId: string | null;
  name: string;
  path: string;
  model?: string;
  effort?: string;
  status?: SubagentStatus;
  statusAt?: Date;
  turnStartedAt?: Date;
  startedAt?: Date;
  modifiedAt: Date;
  /** Its stages, open tool calls and messages from other agents, as far as the scan has read. */
  ledger?: AgentLedger;
  /**
   * Plaintext the parent wrote before it spawned someone, the tail of this
   * turn. A spawn snapshots it onto `charges` for that child.
   */
  preface?: string;
  /** Child thread id to the parent's words from before that child was created. */
  charges?: Record<string, string>;
}

// session_meta lines embed full instructions and can reach hundreds of KB;
// stop well before any rollout grows large, but never truncate the JSON.
const MAX_FIRST_LINE_BYTES = 1024 * 1024;

function readFirstLine(filePath: string): string | null {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let chunk = '';
    let offset = 0;
    while (chunk.length < MAX_FIRST_LINE_BYTES) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (bytesRead <= 0) {
        break;
      }
      chunk += buffer.toString('utf8', 0, bytesRead);
      offset += bytesRead;
      const newline = chunk.indexOf('\n');
      if (newline !== -1) {
        return chunk.slice(0, newline);
      }
    }
    return chunk.length > 0 ? chunk : null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * What Codex itself calls a thread.
 *
 * A spawned agent carries two names. `agent_path` (`/root/audit_code_paths`)
 * is the task name the parent chose; it is what Codex's own `/subagents`
 * picker prints, and it says what the agent is for. `agent_nickname`
 * (`Meitner`) is drawn at random from a list of scientists, so it tells the
 * reader nothing and repeats across sessions. The path wins; the nickname is
 * kept for the inspector, because Codex's transcript still uses it.
 */
export interface AgentIdentity {
  /** Canonical task path, `/root/<task>` for a first-level agent. */
  agentPath?: string;
  /** Randomly assigned nickname. */
  nickname?: string;
  /** Configured role, such as `explorer`, when the spawn named one. */
  role?: string;
  /**
   * An internal thread with no task or nickname. Codex 0.155+ opens a
   * `guardian` review thread beside every session (`source.subagent.other`,
   * `thread_source: "guardian_review"`). Its id shares the time-ordered prefix
   * of the thread it reviews, so an id-prefix name made it look like a second
   * copy of that thread.
   */
  kind?: string;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function identityFromMeta(payload: Record<string, unknown>): AgentIdentity {
  const source = payload.source;
  const subagent = source && typeof source === 'object'
    ? (source as { subagent?: { other?: unknown; thread_spawn?: Record<string, unknown> } }).subagent
    : undefined;
  const spawn = subagent?.thread_spawn;
  const threadSource = nonEmpty(payload.thread_source);
  return {
    agentPath: nonEmpty(payload.agent_path) ?? nonEmpty(spawn?.agent_path),
    nickname: nonEmpty(payload.agent_nickname) ?? nonEmpty(spawn?.agent_nickname),
    role: nonEmpty(payload.agent_role) ?? nonEmpty(spawn?.agent_role),
    kind: nonEmpty(subagent?.other)
      ?? (threadSource?.endsWith('_review') ? threadSource.slice(0, -'_review'.length) || undefined : undefined),
  };
}

/** `/root/audit/code_paths` → `code_paths`: the tree already shows the rest. */
export function agentPathLeaf(agentPath: string | undefined): string | undefined {
  return agentPath?.split(/[\\/]+/).filter(Boolean).at(-1);
}

/** Task name first, then nickname, role, and what kind of thread it is. */
export function agentDisplayName(identity: AgentIdentity): string | undefined {
  return agentPathLeaf(identity.agentPath) || identity.nickname || identity.role || identity.kind;
}

/**
 * The row label Codex's `/subagents` picker prints for a thread, as built by
 * `agent_picker_selection_view_params` and `format_agent_picker_item_name`
 * in codex-rs/tui (0.157): the path for a path-backed agent, otherwise the
 * nickname and role, and `Main [default]` for the session itself.
 */
export function agentPickerLabel(identity: AgentIdentity, isPrimary: boolean): string {
  if (isPrimary) return 'Main [default]';
  if (identity.agentPath) return identity.agentPath;
  if (identity.nickname && identity.role) return `${identity.nickname} [${identity.role}]`;
  if (identity.nickname) return identity.nickname;
  if (identity.role) return `[${identity.role}]`;
  return 'Agent';
}

/**
 * The name a narrow Codex pane prints for this thread in /subagents, where
 * ids no longer fit, or undefined when that name would not pick it out: a
 * thread with nothing but the generic "Agent", or one sharing its name with
 * another thread of the session. The session's own thread is always Main.
 */
export function uniquePickerLabel(tree: SubagentTree, id: string): string | undefined {
  if (id === tree.rootId) return agentPickerLabel({}, true);
  const labels = new Map<string, number>();
  let target: SubagentTreeNode | undefined;
  const walk = (nodes: SubagentTreeNode[]): void => {
    for (const node of nodes) {
      const label = agentPickerLabel(node, false);
      labels.set(label, (labels.get(label) ?? 0) + 1);
      if (node.id === id) target = node;
      walk(node.children);
    }
  };
  walk(tree.nodes);
  if (!target || !(target.agentPath || target.nickname || target.role)) return undefined;
  const label = agentPickerLabel(target, false);
  return labels.get(label) === 1 ? label : undefined;
}

function spawnFromSource(source: unknown): { model?: string; effort?: string } | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  const spawn = (source as {
    subagent?: { thread_spawn?: Record<string, unknown> };
  }).subagent?.thread_spawn;
  if (!spawn) {
    return undefined;
  }
  const model = typeof spawn.model === 'string' ? spawn.model : undefined;
  const rawEffort = spawn.effort ?? spawn.reasoning_effort;
  const effort = typeof rawEffort === 'string' ? rawEffort : undefined;
  return model || effort ? { model, effort } : undefined;
}

function modelEffortFromPayload(payload: Record<string, unknown>): { model?: string; effort?: string } {
  const settings = (payload.collaboration_mode as { settings?: Record<string, unknown> } | undefined)?.settings
    ?? (payload.thread_settings as Record<string, unknown> | undefined);
  const modelCandidates = [payload.model, settings?.model];
  const effortCandidates = [payload.effort, payload.reasoning_effort, settings?.effort, settings?.reasoning_effort];
  const model = modelCandidates.find((value): value is string => typeof value === 'string' && value.length > 0);
  const effort = effortCandidates.find((value): value is string => typeof value === 'string' && value.length > 0);
  return { model, effort };
}

type RolloutFields = Pick<SessionLink, 'model' | 'effort' | 'status' | 'statusAt' | 'turnStartedAt' | 'task' | 'lastReport' | 'preface' | 'charges'>;

const PREFACE_LIMIT = 1500;

/** Parent words worth keeping: not a sealed payload, not the spawn header. */
function prefaceText(value: string): string | undefined {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.includes('gAAAAA') || /^Message Type:/.test(text)) return undefined;
  return text;
}

function rememberPreface(into: RolloutFields, value: string): void {
  const text = prefaceText(value);
  if (!text) return;
  const next = into.preface ? `${into.preface} ${text}` : text;
  into.preface = next.length > PREFACE_LIMIT ? next.slice(next.length - PREFACE_LIMIT) : next;
}

function snapshotCharge(into: RolloutFields, id: string): void {
  const text = into.preface?.trim();
  if (!text) return;
  into.charges ??= {};
  into.charges[id] = text;
}

function messageText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => {
    if (!part || typeof part !== 'object') return [];
    const record = part as { type?: unknown; text?: unknown };
    if ((record.type !== 'input_text' && record.type !== 'output_text' && record.type !== 'text') || typeof record.text !== 'string') return [];
    return [record.text];
  });
  return parts.length ? parts.join('\n') : undefined;
}

// What this reads is saved with the scan (tree-scan-store.ts): a change to it bumps SCAN_VERSION.
function applyRolloutLine(line: string, into: RolloutFields, ledger?: AgentLedger): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  try {
    const entry = JSON.parse(trimmed) as { timestamp?: string; type?: string; payload?: Record<string, unknown> };
    if (!entry.payload) {
      return;
    }
    if (ledger) applyLedgerEntry(entry, ledger);
    const report = extractAgentReport(entry);
    if (report && (!into.lastReport || report.at >= into.lastReport.at)) into.lastReport = report;
    if (entry.type === 'response_item' && entry.payload.type === 'message' && Array.isArray(entry.payload.content)) {
      const joined = messageText(entry.payload.content);
      if (entry.payload.role === 'user') {
        const text = taskText(joined);
        if (text) into.task = text;
      }
      // Reuse the public-report boundary: private/unknown assistant channels
      // must never become a charge sent to the labels or progress model.
      if (joined && (entry.payload.role === 'user' || (entry.payload.role === 'assistant' && report))) rememberPreface(into, joined);
    }
    if (entry.type === 'event_msg') {
      const type = entry.payload.type;
      const item = entry.payload.item;
      if (type === 'item_completed' && item && typeof item === 'object') {
        const activity = item as { type?: unknown; kind?: unknown; agent_thread_id?: unknown };
        if (activity.type === 'SubAgentActivity' && activity.kind === 'started' && typeof activity.agent_thread_id === 'string') {
          snapshotCharge(into, activity.agent_thread_id);
        }
      }
      if (type === 'user_message') {
        const task = taskText(entry.payload.message);
        if (task) into.task = task;
      }
      // An aborted turn (user interrupt) is over: the agent is idle, not
      // still running, and not failed.
      const status = type === 'task_started' || type === 'turn_started' ? 'running'
        : type === 'task_complete' || type === 'turn_complete' || type === 'turn_aborted' ? 'completed'
          : undefined;
      const time = entry.timestamp ? new Date(entry.timestamp) : undefined;
      if (status && time && Number.isFinite(time.getTime())) {
        into.status = status;
        into.statusAt = time;
        if (status === 'running') into.turnStartedAt = time;
      }
    }
    if (entry.type === 'turn_context') {
      const fields = modelEffortFromPayload(entry.payload);
      if (fields.model) into.model = fields.model;
      if (fields.effort) into.effort = fields.effort;
      return;
    }
    if (entry.type === 'event_msg' && entry.payload.type === 'thread_settings_applied') {
      const settings = entry.payload.thread_settings;
      if (settings && typeof settings === 'object') {
        const fields = modelEffortFromPayload(settings as Record<string, unknown>);
        if (fields.model) into.model = fields.model;
        if (fields.effort) into.effort = fields.effort;
      }
    }
  } catch {
    // skip malformed lines
  }
}

function* scanRolloutFields(
  filePath: string,
  startOffset: number,
  source: Pick<CachedLink, 'size' | 'ino' | 'mtimeMs' | 'contextPrint'> & { headerPrint?: string },
  ledger?: AgentLedger,
  seed?: Pick<SessionLink, 'preface' | 'charges'>,
): Generator<void, RolloutFields & { endOffset: number }> {
  const { size: observedSize, ino: observedIno, mtimeMs: observedMtimeMs } = source;
  const fd = fs.openSync(filePath, 'r');
  try {
    const before = fs.fstatSync(fd);
    if (before.size < observedSize || (observedIno !== undefined && before.ino !== observedIno)
      || (before.size === observedSize && before.mtime.getTime() !== observedMtimeMs)) {
      throw new Error('Rollout changed before its scan');
    }
    if (startOffset > 0 && scanPrint(filePath, startOffset) !== source.contextPrint) {
      throw new Error('Rollout changed before its scan');
    }
    const buffer = Buffer.alloc(64 * 1024);
    const consumed = createHash('sha256');
    let offset = Math.max(0, startOffset);
    let parts: Buffer[] = [];
    let partialBytes = 0;
    let lines = 0;
    const fields: RolloutFields & { endOffset: number } = {
      endOffset: offset,
      ...(seed?.preface ? { preface: seed.preface } : {}),
      ...(seed?.charges ? { charges: { ...seed.charges } } : {}),
    };
    // Never follow a live writer forever. Bytes beyond this listing's size
    // belong to the next collection, including completion of a partial line.
    while (offset < observedSize) {
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, observedSize - offset), offset);
      if (bytesRead <= 0) {
        throw new Error('Rollout changed during its scan');
      }
      consumed.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
      let start = 0;
      let newline = buffer.indexOf(10, start);
      while (newline !== -1) {
        if (newline >= bytesRead) break;
        const tail = buffer.subarray(start, newline);
        const line = parts.length ? Buffer.concat([...parts, tail], partialBytes + tail.length) : tail;
        applyRolloutLine(line.toString('utf8'), fields, ledger);
        parts = [];
        partialBytes = 0;
        start = newline + 1;
        if (++lines % 64 === 0) yield;
        newline = buffer.indexOf(10, start);
      }
      if (start < bytesRead) {
        // Own these bytes: the read buffer is reused after the next yield.
        parts.push(Buffer.from(buffer.subarray(start, bytesRead)));
        partialBytes += bytesRead - start;
      }
      yield;
    }
    const after = fs.statSync(filePath);
    if (after.ino !== before.ino || after.dev !== before.dev || after.size < observedSize
      || (after.size === before.size && after.mtimeMs !== before.mtimeMs)) {
      throw new Error('Rollout changed during its scan');
    }
    // Size growth is not proof of append: a writer may truncate and regrow
    // this very inode between checkpoints. If the generation changed, compare
    // every byte consumed (including an incomplete last line) with the same
    // bounded region as it now stands. Never commit an old prefix/new suffix.
    if (before.size !== observedSize || before.mtime.getTime() !== observedMtimeMs
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      const verified = createHash('sha256');
      let verifyOffset = Math.max(0, startOffset);
      while (verifyOffset < observedSize) {
        const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, observedSize - verifyOffset), verifyOffset);
        if (read <= 0) throw new Error('Rollout changed during its scan');
        verified.update(buffer.subarray(0, read));
        verifyOffset += read;
        yield;
      }
      if (verified.digest('hex') !== consumed.digest('hex')
        || (startOffset > 0 && scanPrint(filePath, startOffset) !== source.contextPrint)
        || (source.headerPrint !== undefined && headerPrint(readFirstLine(filePath)) !== source.headerPrint)) {
        throw new Error('Rollout changed during its scan');
      }
      const final = fs.statSync(filePath);
      // A second source change while verifying is uncertain, even if it might
      // be append. Retry from a fresh listing instead of chasing a live writer.
      if (final.ino !== after.ino || final.dev !== after.dev || final.size !== after.size
        || final.mtimeMs !== after.mtimeMs || final.ctimeMs !== after.ctimeMs) {
        throw new Error('Rollout changed during its scan');
      }
    }
    // A writer may stop halfway through an event. Re-read its bytes on the
    // next tick instead of permanently skipping the eventual status change.
    fields.endOffset = offset - partialBytes;
    return fields;
  } finally {
    fs.closeSync(fd);
  }
}

/** What a node carries of its ledger: copies, so a later scan never changes a tree already built. */
function ledgerFields(ledger: AgentLedger | undefined): Pick<SubagentTreeNode, 'stages' | 'stageCount' | 'action' | 'peers'> {
  if (!ledger || (!ledger.count && !ledger.peers.size && !ledger.open.size)) return {};
  const action = currentAction(ledger);
  return {
    stages: ledger.stages.map(stage => ({ ...stage, ...(stage.by ? { by: { ...stage.by } } : {}), ...(stage.peers ? { peers: { ...stage.peers } } : {}) })),
    stageCount: ledger.count,
    ...(action ? { action: { ...action } } : {}),
    ...(ledger.peers.size ? { peers: Object.fromEntries(ledger.peers) } : {}),
  };
}

function* refreshRolloutFields(link: SessionLink): Generator<void, void> {
  const cached = linkCache.get(link.path);
  if (!cached?.link) {
    return;
  }
  const start = cached.contextOffset ?? 0;
  if (start >= cached.size) {
    return;
  }
  // A yield can let the file be replaced/truncated. Keep the old cache whole
  // until this scan verifies its source and commits its fields and byte offset.
  const ledger = cached.link.ledger ? structuredClone(cached.link.ledger) : newLedger();
  let extra: RolloutFields & { endOffset: number };
  try {
    extra = yield* scanRolloutFields(link.path, start, {
      size: cached.size, ino: cached.ino, mtimeMs: cached.mtimeMs,
      contextPrint: cached.contextPrint, headerPrint: link.headerPrint,
    }, ledger, start > 0 ? link : undefined);
    if (linkCache.get(link.path) !== cached) throw new Error('Rollout cache changed during its scan');
  } catch (error) {
    if (linkCache.get(link.path) === cached) linkCache.delete(link.path);
    throw error;
  }
  link.ledger = ledger;
  cached.link.ledger = ledger;
  if (extra.model) {
    link.model = extra.model;
    cached.link.model = extra.model;
  }
  if (extra.effort) {
    link.effort = extra.effort;
    cached.link.effort = extra.effort;
  }
  if (extra.status) {
    link.status = extra.status;
    link.statusAt = extra.statusAt;
  }
  if (extra.turnStartedAt) link.turnStartedAt = extra.turnStartedAt;
  if (extra.task) link.task = extra.task;
  if (extra.preface) {
    link.preface = extra.preface;
    cached.link.preface = extra.preface;
  }
  if (extra.charges) {
    link.charges = extra.charges;
    cached.link.charges = extra.charges;
  }
  if (extra.lastReport && (!link.lastReport || extra.lastReport.at >= link.lastReport.at)) link.lastReport = extra.lastReport;
  if (extra.endOffset === cached.contextOffset) return;
  cached.contextOffset = extra.endOffset;
  cached.contextPrint = scanPrint(link.path, extra.endOffset);
  if (extra.endOffset >= SAVE_MIN_BYTES) scanStore?.mark(link.path, () => savedScan(link.path));
}

const iso = (date: Date | undefined): string | undefined => date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;

/** The scan of `filePath` as it stands, to be saved: what was read, how far, and the bytes it ended on. */
function savedScan(filePath: string): SavedScan | undefined {
  const cached = linkCache.get(filePath);
  const link = cached?.link;
  if (!cached || !link || cached.contextOffset < SAVE_MIN_BYTES || !cached.contextPrint) return undefined;
  const ledger = link.ledger;
  return {
    version: SCAN_VERSION, path: filePath, id: link.id, ...(cached.ino !== undefined ? { ino: cached.ino } : {}),
    offset: cached.contextOffset, print: cached.contextPrint,
    fields: {
      model: link.model, effort: link.effort, status: link.status, statusAt: iso(link.statusAt), turnStartedAt: iso(link.turnStartedAt),
      task: link.task, lastReport: link.lastReport ? { ...link.lastReport, at: iso(link.lastReport.at) } : undefined,
      ...(link.preface ? { preface: link.preface } : {}),
      ...(link.charges ? { charges: link.charges } : {}),
    },
    ...(ledger ? { ledger: {
      stages: ledger.stages.map((stage) => ({ ...stage, startedAt: iso(stage.startedAt), endedAt: iso(stage.endedAt) })),
      count: ledger.count,
      open: [...ledger.open].map(([id, action]) => [id, { ...action, at: iso(action.at) }]),
      peers: [...ledger.peers],
      ...(ledger.pending ? { pending: ledger.pending } : {}),
    } } : {}),
  };
}

const STATUSES = new Set<string>(['starting', 'running', 'completed', 'error', 'unknown']);
const STAGE_STATUSES = new Set<string>(['running', 'done', 'aborted', 'failed']);
const isText = (value: unknown): value is string => typeof value === 'string';
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const dateOf = (value: unknown): Date | undefined => {
  if (!isText(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
};
/** An optional field: absent, or what `read` makes of it; null when it is there and does not read. */
const optional = <T>(value: unknown, read: (value: unknown) => T | undefined): T | undefined | null =>
  value === undefined ? undefined : read(value) ?? null;
const header = (value: unknown) => isRecord(value) && isText(value.type) && isText(value.sender) ? { type: value.type, sender: value.sender } : undefined;
const counts = (value: unknown) => isRecord(value) && Object.values(value).every((n) => typeof n === 'number')
  ? value as Record<string, number> : undefined;

/**
 * A saved scan put back on `link`, the fields and the ledger, when every part
 * of it reads; false, with `link` untouched, when any part does not.
 */
function restoreScan(saved: SavedScan, link: SessionLink): boolean {
  const f = saved.fields;
  const statusAt = optional(f.statusAt, dateOf);
  const turnStartedAt = optional(f.turnStartedAt, dateOf);
  const report = optional(f.lastReport, (value) => {
    const at = isRecord(value) ? dateOf(value.at) : undefined;
    return isRecord(value) && at && isText(value.text) && (value.kind === 'message' || value.kind === 'update' || value.kind === 'reply')
      ? { text: value.text, at, kind: value.kind } as AgentReport : undefined;
  });
  if ([f.model, f.effort, f.task].some((value) => value !== undefined && !isText(value))
    || (f.status !== undefined && !(isText(f.status) && STATUSES.has(f.status)))
    || statusAt === null || turnStartedAt === null || report === null) return false;
  let ledger: AgentLedger | undefined;
  if (saved.ledger !== undefined) {
    const raw = saved.ledger;
    if (!isRecord(raw) || !Array.isArray(raw.stages) || typeof raw.count !== 'number' || !Array.isArray(raw.open) || !Array.isArray(raw.peers)) return false;
    const stages: AgentStage[] = [];
    for (const value of raw.stages) {
      const startedAt = isRecord(value) ? dateOf(value.startedAt) : undefined;
      if (!isRecord(value) || !startedAt || !isText(value.status) || !STAGE_STATUSES.has(value.status)) return false;
      const endedAt = optional(value.endedAt, dateOf);
      const by = optional(value.by, header);
      const peers = optional(value.peers, counts);
      if (endedAt === null || by === null || peers === null || [value.turnId, value.intent, value.result].some((text) => text !== undefined && !isText(text))) return false;
      stages.push({
        startedAt, status: value.status as AgentStage['status'],
        ...(isText(value.turnId) ? { turnId: value.turnId } : {}), ...(endedAt ? { endedAt } : {}), ...(by ? { by } : {}),
        ...(isText(value.intent) ? { intent: value.intent } : {}), ...(isText(value.result) ? { result: value.result } : {}), ...(peers ? { peers } : {}),
      });
    }
    const open = new Map<string, AgentAction>();
    for (const value of raw.open) {
      const action = Array.isArray(value) && isRecord(value[1]) ? value[1] : undefined;
      const at = action ? dateOf(action.at) : undefined;
      if (!action || !at || !isText(value[0]) || !isText(action.name) || !isText(action.text)) return false;
      open.set(value[0], { name: action.name, text: action.text, at });
    }
    const peers = new Map<string, number>();
    for (const value of raw.peers) {
      if (!Array.isArray(value) || !isText(value[0]) || typeof value[1] !== 'number') return false;
      peers.set(value[0], value[1]);
    }
    const pending = optional(raw.pending, header);
    if (pending === null) return false;
    ledger = { stages, count: raw.count, open, peers, ...(pending ? { pending } : {}) };
  }
  if (isText(f.model)) link.model = f.model;
  if (isText(f.effort)) link.effort = f.effort;
  if (isText(f.status)) link.status = f.status as SubagentStatus;
  link.statusAt = statusAt;
  link.turnStartedAt = turnStartedAt;
  if (isText(f.task)) link.task = f.task;
  if (f.preface !== undefined && !isText(f.preface)) return false;
  if (f.charges !== undefined && (!isRecord(f.charges) || !Object.values(f.charges).every(isText))) return false;
  if (isText(f.preface)) link.preface = f.preface;
  if (isRecord(f.charges)) link.charges = Object.fromEntries(Object.entries(f.charges).filter((entry): entry is [string, string] => isText(entry[1])));
  link.lastReport = report;
  link.ledger = ledger;
  return true;
}

const headerPrint = (line: string | null): string | undefined => line === null ? undefined : createHash('sha256').update(line).digest('hex');

function peekSessionLink(filePath: string, modifiedAt: Date): SessionLink | null {
  try {
    const firstLine = readFirstLine(filePath);
    if (!firstLine) {
      return null;
    }
    const entry = JSON.parse(firstLine.trim()) as {
      type?: string;
      payload?: {
        id?: string;
        session_id?: string;
        parent_thread_id?: string;
        model?: string;
        effort?: string;
        timestamp?: string;
        source?: unknown;
      };
    };
    if (entry.type !== 'session_meta' || !entry.payload) {
      return null;
    }
    const id = entry.payload.id || entry.payload.session_id;
    if (!id) {
      return null;
    }
    const identity = identityFromMeta(entry.payload as Record<string, unknown>);
    const spawn = spawnFromSource(entry.payload.source);
    const payloadModel = typeof entry.payload.model === 'string' ? entry.payload.model : undefined;
    const payloadEffort = typeof (entry.payload as { effort?: unknown }).effort === 'string'
      ? (entry.payload as { effort?: string }).effort
      : undefined;
    return {
      ...identity,
      headerPrint: headerPrint(firstLine),
      id,
      parentId: sessionParentId(entry.payload) ?? null,
      name: agentDisplayName(identity) ?? id.slice(0, 8),
      path: filePath,
      model: spawn?.model ?? payloadModel,
      effort: spawn?.effort ?? payloadEffort,
      startedAt: entry.payload.timestamp ? new Date(entry.payload.timestamp) : undefined,
      modifiedAt,
    };
  } catch {
    return null;
  }
}

function resolveStatus(known: SubagentInfo | undefined, link: SessionLink | undefined): SubagentStatus {
  // Compare event timestamps, never file mtime: model settings and other
  // writes after completion do not mean the agent has started another turn.
  if (link?.status && (!known || !known.lastActivityAt ||
      (link.statusAt && link.statusAt >= known.lastActivityAt))) {
    return link.status;
  }
  if (known) {
    return known.status;
  }
  // A parent link alone does not establish activity or completion.
  return 'unknown';
}

function newestEvidence(...times: Array<Date | undefined>): Date | undefined {
  let newest: Date | undefined;
  for (const time of times) {
    if (time && (!newest || time > newest)) {
      newest = time;
    }
  }
  return newest;
}

function countNodes(nodes: SubagentTreeNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

export function collectNodesByDepth(nodes: SubagentTreeNode[]): SubagentTreeNode[][] {
  const levels: SubagentTreeNode[][] = [];
  const walk = (items: SubagentTreeNode[], depth: number) => {
    if (items.length === 0) {
      return;
    }
    if (!levels[depth]) {
      levels[depth] = [];
    }
    levels[depth].push(...items);
    for (const item of items) {
      walk(item.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return levels;
}

export interface SubagentTreeEntry {
  node: SubagentTreeNode;
  // Directory-tree connector fragment (├─ / └─ with │ continuation) locating
  // the node under its ancestors. Depth-1 entries render bare: they all hang
  // directly off the main session.
  prefix: string;
  // id of the depth-1 ancestor owning this entry, for row grouping.
  rootId: string;
}

// One depth-2 agent and the depth-3 agents it spawned. Keeping them together
// lets the renderer align grandchildren under their immediate parent, so the
// same depth can share a row without losing parent identity.
export interface SubagentTreeSlice {
  entry: SubagentTreeEntry;
  children: SubagentTreeEntry[];
}

export interface SubagentTreeLineage {
  root: SubagentTreeEntry;
  slices: SubagentTreeSlice[];
}

function nodeIsActive(node: SubagentTreeNode): boolean {
  return node.status === 'running' || node.status === 'starting';
}

function subtreeHasActive(node: SubagentTreeNode): boolean {
  if (nodeIsActive(node)) {
    return true;
  }
  return node.children.some(subtreeHasActive);
}

function lastDisplayedIndex(nodes: SubagentTreeNode[]): number {
  let last = -1;
  nodes.forEach((node, index) => {
    if (subtreeHasActive(node)) {
      last = index;
    }
  });
  return last;
}

/**
 * Collect ACTIVE agents (running/starting) grouped by lineage. Completed
 * agents stay only when they anchor an active descendant, so connector
 * prefixes keep showing ownership. Depth is capped at 3 levels (root lineage
 * entry + one slice level + one grandchild level); deeper agents are dropped.
 */
export function collectActiveTreeLineages(
  tree: SubagentTree | null | undefined,
  maxLevels: number = 3
): SubagentTreeLineage[] {
  const lineages: SubagentTreeLineage[] = [];
  for (const root of tree?.nodes ?? []) {
    if (!subtreeHasActive(root)) {
      continue;
    }
    const lineage: SubagentTreeLineage = {
      root: { node: root, prefix: '', rootId: root.id },
      slices: [],
    };
    if (maxLevels >= 2) {
      const rootLast = lastDisplayedIndex(root.children);
      root.children.forEach((kid, index) => {
        if (!subtreeHasActive(kid)) {
          return;
        }
        const kidLast = index === rootLast;
        const slice: SubagentTreeSlice = {
          entry: { node: kid, prefix: kidLast ? '└─ ' : '├─ ', rootId: root.id },
          children: [],
        };
        if (maxLevels >= 3) {
          const kidCont = kidLast ? '   ' : '│  ';
          const kidChildLast = lastDisplayedIndex(kid.children);
          kid.children.forEach((grand, gIndex) => {
            if (!subtreeHasActive(grand)) {
              return;
            }
            slice.children.push({
              node: grand,
              prefix: kidCont + (gIndex === kidChildLast ? '└─ ' : '├─ '),
              rootId: root.id,
            });
          });
        }
        lineage.slices.push(slice);
      });
    }
    lineages.push(lineage);
  }
  return lineages;
}

/** Deepest level actually present (0 when there is nothing to show). */
export function countActiveTreeLevels(lineages: SubagentTreeLineage[]): number {
  if (lineages.length === 0) {
    return 0;
  }
  if (lineages.some((lineage) => lineage.slices.some((slice) => slice.children.length > 0))) {
    return 3;
  }
  if (lineages.some((lineage) => lineage.slices.length > 0)) {
    return 2;
  }
  return 1;
}

export function buildSubagentTree(
  rootId: string,
  knownSubagents: SubagentInfo[] = [],
  maxDaysBack: number = 3,
  nowMs: number = Date.now(),
  /** Rollouts already listed. Passed by the panel so this build does not scan again. */
  listed?: SessionFile[],
): SubagentTree {
  const work = buildTreeSteps(rootId, knownSubagents, maxDaysBack, nowMs, listed);
  let step = work.next();
  while (!step.done) step = work.next();
  return step.value;
}

/**
 * The panel's build: same scan and result as the synchronous API, yielding
 * within files after a short work slice so queued terminal input can run.
 * Each read and group of 64 lines is a checkpoint. A single JSON record is
 * still parsed atomically, so this is not a hard per-record time cap.
 */
export async function buildSubagentTreeYielding(
  rootId: string,
  knownSubagents: SubagentInfo[] = [],
  maxDaysBack: number = 3,
  nowMs: number = Date.now(),
  listed?: SessionFile[],
): Promise<SubagentTree> {
  const work = buildTreeSteps(rootId, knownSubagents, maxDaysBack, nowMs, listed);
  let deadline = performance.now() + 4;
  let step = work.next();
  while (!step.done) {
    if (performance.now() >= deadline) {
      await new Promise<void>(resolve => setImmediate(resolve));
      deadline = performance.now() + 4;
    }
    step = work.next();
  }
  return step.value;
}

function* buildTreeSteps(
  rootId: string,
  knownSubagents: SubagentInfo[],
  maxDaysBack: number,
  nowMs: number,
  listed?: SessionFile[],
): Generator<void, SubagentTree> {
  const known = new Map(knownSubagents.map((agent) => [agent.id, agent]));
  const links = new Map<string, SessionLink>();

  const files = listed ?? findRolloutsInDays(treeLookbackDays(rootId, maxDaysBack, knownSubagents.map(agent => agent.id)));
  const seen = new Set<string>();
  // Same-signature rewrites are invisible to stat; force a re-read of entries
  // whose content has not been verified recently, oldest verification first,
  // bounded per tick.
  const revalidatePaths = new Set<string>();
  {
    const staleCandidates: Array<{ path: string; verifiedAt: number }> = [];
    for (const [entryPath, entry] of linkCache) {
      if (nowMs - entry.verifiedAt > REVALIDATE_INTERVAL_MS) {
        staleCandidates.push({ path: entryPath, verifiedAt: entry.verifiedAt });
      }
    }
    staleCandidates.sort((a, b) => a.verifiedAt - b.verifiedAt);
    for (const candidate of staleCandidates) {
      if (revalidatePaths.size >= REPEEK_BUDGET_PER_TICK) {
        break;
      }
      revalidatePaths.add(candidate.path);
    }
  }
  for (const file of files) {
    seen.add(file.path);
    const modifiedMs = file.modifiedAt.getTime();
    const cached = linkCache.get(file.path);
    let link: SessionLink | null;

    const unchanged = Boolean(
      cached &&
        cached.size === file.size &&
        cached.mtimeMs === modifiedMs &&
        (cached.ino === undefined || file.ino === undefined || cached.ino === file.ino)
    );
    // Append-only growth keeps the first line intact, so the cached metadata
    // stays valid. Anything else (shrink, same-size rewrite with a newer
    // mtime, inode replacement, or a previously failed peek) re-peeks.
    const appended = Boolean(
      cached &&
        cached.link &&
        cached.size < file.size &&
        cached.mtimeMs <= modifiedMs &&
        (cached.ino === undefined || file.ino === undefined || cached.ino === file.ino)
    );
    const revalidate = revalidatePaths.has(file.path);

    if (cached && cached.link && (unchanged || appended) && !revalidate) {
      link = cached.link;
      link.modifiedAt = file.modifiedAt;
      // Track the latest observation so later shrinks are detected against
      // the most recent size, not the size at first cache time.
      cached.size = file.size;
      cached.mtimeMs = modifiedMs;
      cached.ino = file.ino ?? cached.ino;
    } else if (cached && !cached.link && unchanged && !revalidate) {
      // Negative cache: the file has not changed since the last failed peek,
      // so there is nothing new to read yet.
      link = null;
    } else {
      // First sight, previously failed peek with new bytes, shrink, same-size
      // rewrite, or a scheduled revalidation: read the first line again.
      const previous = cached;
      link = peekSessionLink(file.path, file.modifiedAt);
      // A revalidation that finds the same thread, the file as it was or
      // grown, and the bytes the scan ended on unchanged keeps the scan: a
      // growing rollout is not read again from its first byte.
      const keepContext = Boolean(revalidate && previous?.link && link && link.id === previous.link.id && (unchanged || appended)
        && scanPrint(file.path, previous.contextOffset) === (previous.contextPrint ?? ''));
      let contextOffset = 0;
      let contextPrint: string | undefined;
      if (keepContext && previous?.link && link) {
        link.model = previous.link.model ?? link.model;
        link.effort = previous.link.effort ?? link.effort;
        link.status = previous.link.status;
        link.statusAt = previous.link.statusAt;
        link.turnStartedAt = previous.link.turnStartedAt;
        link.task = previous.link.task;
        link.preface = previous.link.preface;
        link.charges = previous.link.charges;
        link.lastReport = previous.link.lastReport;
        link.ledger = previous.link.ledger;
        contextOffset = previous.contextOffset;
        contextPrint = previous.contextPrint;
      } else if (!previous && link && scanStore) {
        // First sight in this process: an earlier one's scan, while it still
        // describes the file.
        const saved = scanStore.load(file.path);
        if (saved && saved.id === link.id && saved.offset <= file.size
          && (saved.ino === undefined || file.ino === undefined || saved.ino === file.ino)
          && scanPrint(file.path, saved.offset) === saved.print && restoreScan(saved, link)) {
          contextOffset = saved.offset;
          contextPrint = saved.print;
          scanStore.used(file.path, nowMs);
          // Saved before scans said which file they were made from: saved again, saying it.
          if (saved.ino === undefined && file.ino !== undefined) scanStore.mark(file.path, () => savedScan(file.path));
        }
      }
      linkCache.set(file.path, {
        link,
        size: file.size,
        mtimeMs: modifiedMs,
        ino: file.ino,
        verifiedAt: nowMs,
        contextOffset,
        ...(contextPrint !== undefined ? { contextPrint } : {}),
      });
    }
    if (!link) {
      yield;
      continue;
    }
    const existing = links.get(link.id);
    if (!existing || link.modifiedAt > existing.modifiedAt) {
      links.set(link.id, link);
    }
    yield;
  }
  for (const key of Array.from(linkCache.keys())) {
    if (!seen.has(key)) {
      linkCache.delete(key);
    }
  }

  const children = new Map<string, string[]>();
  for (const link of links.values()) {
    if (!link.parentId) {
      continue;
    }
    const siblings = children.get(link.parentId) ?? [];
    siblings.push(link.id);
    children.set(link.parentId, siblings);
  }

  // Collab-spawned agents may not have their own rollout peeked yet.
  for (const agent of knownSubagents) {
    if (links.has(agent.id)) {
      continue;
    }
    const siblings = children.get(rootId) ?? [];
    if (!siblings.includes(agent.id)) {
      siblings.push(agent.id);
      children.set(rootId, siblings);
    }
  }

  const visiting = new Set<string>();

  // Scan parents before children, preserving spawn charges and lifecycle
  // ordering. Only this root's reachable rollouts need their event histories.
  const scanned = new Set<string>();
  const pending = children.get(rootId)?.length ? [rootId] : [];
  while (pending.length) {
    const id = pending.pop()!;
    if (scanned.has(id)) continue;
    scanned.add(id);
    const link = links.get(id);
    if (link) yield* refreshRolloutFields(link);
    const descendants = children.get(id) ?? [];
    for (let i = descendants.length - 1; i >= 0; i--) pending.push(descendants[i]);
    yield;
  }

  const buildNode = (id: string, depth: number): SubagentTreeNode => {
    visiting.add(id);
    const link = links.get(id);
    // The root rollout is never a node, so a child's charge is read only
    // after the parent link has been scanned.
    const parent = link?.parentId ? links.get(link.parentId) : undefined;
    const knownAgent = known.get(id);
    const childIds = (children.get(id) ?? []).filter((childId) => !visiting.has(childId));
    const node: SubagentTreeNode = {
      id,
      // The task path and nickname from the agent's own rollout outrank the
      // parent-side record, which only ever knew the nickname.
      name: agentPathLeaf(link?.agentPath) || link?.nickname || knownAgent?.name || link?.name || id.slice(0, 8),
      agentPath: link?.agentPath,
      nickname: link?.nickname,
      role: link?.role,
      kind: link?.kind,
      status: resolveStatus(knownAgent, link),
      startedAt: knownAgent?.startedAt ?? link?.startedAt,
      turnStartedAt: link?.turnStartedAt,
      rolloutPath: link?.path,
      lastReport: link?.lastReport,
      ...ledgerFields(link?.ledger),
      task: taskText(link?.task) ?? taskText(knownAgent?.task),
      charge: parent?.charges?.[id],
      statusAt: knownAgent?.lastActivityAt && (!link?.statusAt || knownAgent.lastActivityAt > link.statusAt)
        ? knownAgent.lastActivityAt : link?.statusAt,
      // Child turn_context is the live model/effort; spawn events are fallback.
      model: link?.model ?? knownAgent?.model,
      effort: link?.effort ?? knownAgent?.effort,
      lastActivityAt: knownAgent?.lastActivityAt,
      // Newest evidence of any kind: a main-to-agent exchange, or the agent's
      // own rollout growing. This is data freshness, not a status.
      lastEventAt: newestEvidence(knownAgent?.lastActivityAt, link?.modifiedAt),
      depth,
      children: childIds.map((childId) => buildNode(childId, depth + 1)),
    };
    visiting.delete(id);
    return node;
  };

  const nodes = (children.get(rootId) ?? []).map((id) => buildNode(id, 1));
  scanStore?.flushDue(nowMs);
  return {
    rootId,
    nodes,
    totalCount: countNodes(nodes),
    updatedAt: new Date(nowMs),
  };
}

/**
 * Counts for the bar and the panel header.
 *
 * Finished and failed are separate numbers on purpose: a single "done" count
 * reads a failure as work completed. Agents with no observed state are counted
 * as unknown rather than folded into either side.
 */
export interface SubagentSummary {
  total: number;
  running: number;
  starting: number;
  completed: number;
  failed: number;
  unknown: number;
  /** Agents that still need something to happen before the session can finish. */
  active: number;
}

/** What a thread is to every view that counts them. */
export type ThreadKind = 'agent' | 'subtask' | 'review';

/**
 * Every thread under the main session, with what it is: an agent (one the
 * main session started), a subtask (a thread under an agent, at any depth)
 * or a review (a guardian approval review, wherever it sits).
 */
export function eachThread(nodes: readonly SubagentTreeNode[], visit: (node: SubagentTreeNode, kind: ThreadKind) => void): void {
  const walk = (node: SubagentTreeNode, top: boolean): void => {
    visit(node, node.kind === 'guardian' ? 'review' : top ? 'agent' : 'subtask');
    for (const child of node.children) walk(child, false);
  };
  for (const node of nodes) walk(node, true);
}

/** Threads by how they stand: active (running or starting), finished, failed, or with no observed state. */
export interface StatusCounts { total: number; active: number; completed: number; failed: number; unknown: number }

/**
 * The counts the panel's title row, the status card's alerts, the bar,
 * notifications and the JSON snapshot all give, so they agree: the agents,
 * one active while it or a subtask under it is; their subtasks; the reviews.
 */
export interface AgentCounts { agents: StatusCounts; subtasks: StatusCounts; reviews: StatusCounts }

const isActive = (node: SubagentTreeNode): boolean => node.status === 'running' || node.status === 'starting';
const busyBelow = (node: SubagentTreeNode): boolean =>
  node.children.some((child) => child.kind !== 'guardian' && (isActive(child) || busyBelow(child)));

export function agentCounts(nodes: readonly SubagentTreeNode[]): AgentCounts {
  const blank = (): StatusCounts => ({ total: 0, active: 0, completed: 0, failed: 0, unknown: 0 });
  const counts: AgentCounts = { agents: blank(), subtasks: blank(), reviews: blank() };
  eachThread(nodes, (node, kind) => {
    const into = kind === 'agent' ? counts.agents : kind === 'subtask' ? counts.subtasks : counts.reviews;
    into.total += 1;
    if (isActive(node) || (kind === 'agent' && busyBelow(node))) into.active += 1;
    else if (node.status === 'completed') into.completed += 1;
    else if (node.status === 'error') into.failed += 1;
    else into.unknown += 1;
  });
  return counts;
}

export function summarizeSubagents(nodes: SubagentTreeNode[]): SubagentSummary {
  const summary: SubagentSummary = {
    total: 0,
    running: 0,
    starting: 0,
    completed: 0,
    failed: 0,
    unknown: 0,
    active: 0,
  };

  const walk = (items: SubagentTreeNode[]): void => {
    for (const node of items) {
      summary.total += 1;
      switch (node.status) {
        case 'running':
          summary.running += 1;
          summary.active += 1;
          break;
        case 'starting':
          summary.starting += 1;
          summary.active += 1;
          break;
        case 'completed':
          summary.completed += 1;
          break;
        case 'error':
          summary.failed += 1;
          break;
        default:
          summary.unknown += 1;
          break;
      }
      walk(node.children);
    }
  };

  walk(nodes);
  return summary;
}
