import { sameSessionRef, sessionRefKey } from './identity.js';
import type { DelegationViewModel } from './link/view-model.js';
import type { StatuslineChild } from './statusline-summary.js';
import type { SessionRef } from './types/identity.js';
import {
  DELEGATION_SUMMARY_MAX_AGE_MS,
  DELEGATION_SUMMARY_MAX_CHILDREN,
  type CommittedDelegationSummary,
} from './delegation-summary-schema.js';
import { summaryFileIdentity, writeDelegationSummary } from './delegation-summary-store.js';
import { join } from 'node:path';

/** Only already committed projections from one settled view, never readers, recovery or a mixed-store lookup. */
export function buildDelegationSummaries(
  view: DelegationViewModel,
  ledgerObservedAt: number,
  now: number,
  ledgerFileIdentity: string
): CommittedDelegationSummary[] {
  if (
    view.tree.ledger.state !== 'available' ||
    !view.tree.ledger.ledgerId ||
    view.tree.ledger.asOfSeq === null ||
    !Number.isSafeInteger(ledgerObservedAt) ||
    ledgerObservedAt > now ||
    now - ledgerObservedAt > DELEGATION_SUMMARY_MAX_AGE_MS
  )
    return [];
  const seq = view.tree.ledger.asOfSeq;
  const groups = new Map<string, { ref: SessionRef; children: StatuslineChild[]; candidates: number }>();
  // Existing projection is bounded; this derivation also caps parents and candidate work before filtering.
  for (const relation of view.tree.relations.slice(0, 2500)) {
    const parent = relation.link.parentRef;
    if (!parent) continue;
    const key = sessionRefKey(parent);
    if (!groups.has(key)) {
      if (groups.size === 50) continue;
      groups.set(key, { ref: parent, children: [], candidates: 0 });
    }
    const group = groups.get(key)!;
    if (++group.candidates > DELEGATION_SUMMARY_MAX_CHILDREN) continue;
    const link = relation.link;
    if (!link.currentOwner && !(link.childRef === null && ['pending', 'claimed', 'failed'].includes(link.state)))
      continue;
    const run = relation.currentRun;
    const node = view.tree.nodes.find((value) => value.key === relation.childKey);
    const observation = node?.observation;
    const status = observation?.statusProjection;
    const stamp = status?.observationStamp;
    const conflict = node?.conflict ?? relation.conflict ?? observation?.conflict ?? null;
    const child: StatuslineChild = {
      key: link.linkId,
      ref: link.childRef,
      label: (link.label ?? link.role).slice(0, 256),
      backend: link.backend,
      linkState: link.state,
      run: run
        ? {
            id: run.runId,
            state: run.state,
            mode: run.mode,
            generation: run.expectedGeneration,
            createdAt: run.createdAt,
            endedAt: run.endedAt,
            cancelRequestedAt: run.cancelRequestedAt,
          }
        : null,
      status: null,
      stamp: null,
      coverage: null,
      unavailableReason: conflict ? 'identity_conflict' : 'projection_unavailable',
      conflict: conflict ? { count: conflict.count, since: conflict.since } : null,
    };
    // The view already checks source-generation and binding ownership. Unrelated ledger events do NOT erase siblings.
    if (
      !conflict &&
      node?.loaded &&
      observation?.loaded &&
      node.identity.kind === 'session' &&
      link.childRef &&
      run &&
      stamp &&
      status &&
      node.currentRun?.runId === run.runId &&
      node.currentRun.expectedGeneration === run.expectedGeneration &&
      run.sourceId === link.childRef.sourceId &&
      run.harness === link.childRef.harness &&
      sameSessionRef(node.identity.ref, link.childRef) &&
      sameSessionRef(stamp.ref, link.childRef) &&
      stamp.runId === run.runId &&
      stamp.bindingGeneration === run.expectedGeneration &&
      stamp.inputLedgerSeq !== null &&
      stamp.inputLedgerSeq <= seq &&
      status.asOfSeq === stamp.inputLedgerSeq &&
      status.observedAt <= now &&
      now - status.observedAt <= DELEGATION_SUMMARY_MAX_AGE_MS &&
      status.isRunTerminal === ['ended', 'failed', 'cancelled'].includes(run.state)
    ) {
      child.status = status;
      child.stamp = stamp;
      child.coverage = observation.coverage;
      child.unavailableReason = null;
    }
    group.children.push(child);
  }
  return [...groups.values()].map((group) => ({
    schemaVersion: 1,
    parent: group.ref,
    ledgerId: view.tree.ledger.ledgerId!,
    ledgerFileIdentity,
    asOfSeq: seq,
    observedAt: now,
    expiresAt: Math.min(now, ledgerObservedAt) + DELEGATION_SUMMARY_MAX_AGE_MS,
    coverage: 'partial',
    reason: 'direct_children_only',
    treeCounts: null,
    limitReached:
      group.candidates >= DELEGATION_SUMMARY_MAX_CHILDREN ||
      view.tree.relations.length > 2500 ||
      view.tree.continuation.length > 0 ||
      view.tree.truncation.continuation > 0,
    children: group.children,
  }));
}

/** Called by the existing owned worker after its publication has settled. Failures leave readers' fallback intact. */
export function publishDelegationSummaries(
  home: string,
  view: DelegationViewModel | null,
  ledgerObservedAt: number | null,
  ledgerFileIdentity: string,
  now = Date.now()
): number {
  if (!view || ledgerObservedAt === null) return 0;
  try {
    if (summaryFileIdentity(join(home, 'ledger.sqlite')) !== ledgerFileIdentity) return 0;
    const summaries = buildDelegationSummaries(view, ledgerObservedAt, now, ledgerFileIdentity);
    let published = 0;
    for (const summary of summaries) if (writeDelegationSummary(home, summary)) published++;
    return published;
  } catch {
    return 0;
  }
}
