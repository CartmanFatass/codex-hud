/** Bounded, display-only derived cache. Never observation/checkpoint or lifecycle authority. */
import { sameSessionRef, validateSessionRef } from './identity.js';
import { projectFreshness } from './observation.js';
import type { SessionRef } from './types/identity.js';
import type { StatuslineChild, StatuslineSummary } from './statusline-summary.js';

export const DELEGATION_SUMMARY_VERSION = 1;
export const DELEGATION_SUMMARY_MAX_AGE_MS = 5000;
export const DELEGATION_SUMMARY_MAX_BYTES = 256 * 1024;
export const DELEGATION_SUMMARY_MAX_CHILDREN = 50;
export interface CommittedDelegationSummary {
  schemaVersion: 1;
  parent: SessionRef;
  ledgerId: string;
  ledgerFileIdentity: string;
  asOfSeq: number;
  observedAt: number;
  expiresAt: number;
  coverage: 'partial';
  reason: 'direct_children_only';
  treeCounts: null;
  limitReached: boolean;
  children: StatuslineChild[];
}

type Check = (value: unknown) => boolean;
const text: Check = (v) => typeof v === 'string' && v.length <= 1024;
const uint: Check = (v) => Number.isSafeInteger(v) && Number(v) >= 0;
const bool: Check = (v) => typeof v === 'boolean';
const nullable =
  (check: Check): Check =>
  (v) =>
    v === null || check(v);
const optional =
  (check: Check): Check =>
  (v) =>
    v === undefined || check(v);
const one =
  (...values: unknown[]): Check =>
  (v) =>
    values.includes(v);
const object =
  (fields: Record<string, Check>): Check =>
  (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const r = v as Record<string, unknown>;
    return (
      Object.keys(r).every((key) => Object.hasOwn(fields, key)) &&
      Object.entries(fields).every(([key, check]) => check(r[key]))
    );
  };
const list =
  (check: Check, max = 64): Check =>
  (v) =>
    Array.isArray(v) && v.length <= max && v.every(check);
const ref = object({
  harness: one('claude', 'codex', 'pi'),
  sourceId: text,
  sessionId: text,
  threadId: nullable(text),
});
const stamp = object({
  seqDomain: text,
  commitSeq: uint,
  inputLedgerSeq: nullable(uint),
  ref,
  runId: optional(text),
  bindingGeneration: optional(uint),
  sourceGeneration: uint,
});
const validity = one('current', 'stale', 'unknown', 'conflict');
const freshness = object({
  state: one('fresh', 'stale', 'unknown'),
  sources: list(
    object({
      id: text,
      validity,
      lastEvidenceAt: nullable(uint),
      observedAt: nullable(uint),
      lastSuccessfulReadAt: nullable(uint),
      deadlineAt: nullable(uint),
      error: optional(text),
      reason: optional(text),
      clockAnomaly: optional(bool),
    })
  ),
  requiredSourceIds: list(text),
  staleSince: nullable(uint),
  reason: nullable(text),
  clockAnomaly: bool,
});
const activity = one('working', 'waiting_input', 'idle', 'exited', 'unknown');
const status = object({
  activity,
  pendingReason: one('none', 'approval', 'question', 'needs_human'),
  lastTurnOutcome: one('none', 'completed', 'failed', 'interrupted'),
  liveness: one('alive', 'gone', 'unknown'),
  freshness,
  stateKey: text,
  stateSince: nullable(uint),
  stateSinceBasis: one('event', 'observed', 'unknown'),
  isRunTerminal: nullable(bool),
  asOfSeq: nullable(uint),
  observationStamp: nullable(stamp),
  asOf: nullable(uint),
  observedAt: uint,
  lastEvidenceAt: nullable(uint),
  lastKnownActivity: optional(activity),
});
const coverage = object({
  state: one('complete', 'partial', 'catching_up'),
  skipped: (v) =>
    !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 64 && Object.values(v).every(uint),
  gaps: list(text),
  remainingBytes: optional(uint),
  loaded: bool,
  reason: optional(text),
});
const child = object({
  key: text,
  ref: nullable(ref),
  label: text,
  backend: text,
  linkState: text,
  run: nullable(
    object({
      id: text,
      state: one('starting', 'running', 'cancelling', 'uncertain', 'ended', 'failed', 'cancelled'),
      mode: one('visible', 'headless'),
      generation: uint,
      createdAt: uint,
      endedAt: nullable(uint),
      cancelRequestedAt: nullable(uint),
    })
  ),
  status: nullable(status),
  stamp: nullable(stamp),
  coverage: nullable(coverage),
  unavailableReason: nullable(text),
  conflict: optional(nullable(object({ count: uint, since: uint }))),
});
const envelope = object({
  schemaVersion: one(1),
  parent: ref,
  ledgerId: text,
  ledgerFileIdentity: text,
  asOfSeq: uint,
  observedAt: uint,
  expiresAt: uint,
  coverage: one('partial'),
  reason: one('direct_children_only'),
  treeCounts: one(null),
  limitReached: bool,
  children: list(child, DELEGATION_SUMMARY_MAX_CHILDREN),
});

/** Strict schema and cross-field checks; a corrupt child never becomes executable/display state. */
export function validateDelegationSummary(
  value: unknown,
  parent: SessionRef,
  now: number
): value is CommittedDelegationSummary {
  try {
    if (!envelope(value) || !uint(now)) return false;
    const s = value as CommittedDelegationSummary;
    validateSessionRef(s.parent);
    if (
      !sameSessionRef(s.parent, parent) ||
      !s.ledgerId ||
      !s.ledgerFileIdentity ||
      s.observedAt > now ||
      now > s.expiresAt ||
      s.expiresAt < s.observedAt ||
      s.expiresAt - s.observedAt > DELEGATION_SUMMARY_MAX_AGE_MS
    )
      return false;
    const seen = new Set<string>();
    for (const c of s.children) {
      if (!c.key || seen.has(c.key)) return false;
      seen.add(c.key);
      if (c.ref) validateSessionRef(c.ref);
      if (c.status) {
        const stamp = c.status.observationStamp;
        if (
          !c.ref ||
          !c.run ||
          !stamp ||
          c.unavailableReason !== null ||
          c.conflict ||
          !c.coverage ||
          !sameSessionRef(stamp.ref, c.ref) ||
          stamp.runId !== c.run.id ||
          stamp.bindingGeneration !== c.run.generation ||
          stamp.inputLedgerSeq === null ||
          stamp.inputLedgerSeq > s.asOfSeq ||
          c.status.asOfSeq !== stamp.inputLedgerSeq ||
          JSON.stringify(c.stamp) !== JSON.stringify(stamp) ||
          c.status.observedAt > s.observedAt ||
          s.observedAt - c.status.observedAt > DELEGATION_SUMMARY_MAX_AGE_MS ||
          c.status.isRunTerminal !== ['ended', 'failed', 'cancelled'].includes(c.run.state)
        )
          return false;
      } else if (c.stamp !== null || c.coverage !== null || c.unavailableReason === null) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Recompute ages on every consumer read/paint, never extend a committed observation's life. */
export function delegationSummaryStatusline(s: CommittedDelegationSummary, now: number): StatuslineSummary {
  return {
    state: 'partial',
    reason: s.reason,
    source: 'committed_summary',
    asOfSeq: s.asOfSeq,
    treeCounts: null,
    limitReached: s.limitReached,
    elapsedMs: 0,
    children: s.children.map((child) => {
      if (!child.status) return child;
      if (child.status.observedAt > now || now - child.status.observedAt > DELEGATION_SUMMARY_MAX_AGE_MS)
        return { ...child, status: null, stamp: null, coverage: null, unavailableReason: 'projection_stale' };
      return {
        ...child,
        status: {
          ...child.status,
          freshness: projectFreshness(child.status.freshness.sources, child.status.freshness.requiredSourceIds, now),
        },
      };
    }),
  };
}
