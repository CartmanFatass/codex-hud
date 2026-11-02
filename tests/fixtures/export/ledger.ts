import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from '../../../src/core/canonical.js';
import { sessionRefKey } from '../../../src/core/identity.js';
import type { ExportInputRecord } from '../../../src/core/types/export.js';
import type { SessionRef } from '../../../src/core/types/identity.js';
import { openLedger } from '../../../src/ledger/ledger.js';
import { insertClaim, insertRecord, insertRun } from '../../../src/ledger/records.js';
import type { PreparedIntent } from '../../../src/ledger/types.js';

export const SENTINEL = 'PRIVATE_SYNTHETIC_BRIEF_REPORT_CLAIM_SENTINEL';

/** All persistent setup goes through B2; binding validation itself belongs to B5. */
export async function exportFixture(records: readonly ExportInputRecord[] = []) {
  // Only this returned handle owns cleanup. Never infer liveness from a directory
  // prefix or an empty SQLite snapshot: another writer's rows may be uncommitted.
  const container = mkdtempSync(join(tmpdir(), 'hud-b18-'));
  const home = join(container, 'home');
  mkdirSync(home, { mode: 0o700 });
  const ledger = await openLedger(join(home, 'ledger.sqlite'));
  try {
    const fixtures = await import(pathToFileURL(resolve('tests/ledger/fixtures.mjs')).href);
    await fixtures.seedCaller(ledger);
    const inputs: PreparedIntent[] = [];
    const knownSources = new Set<string>([fixtures.sourceId]);
    const knownRefs = new Set<string>();
    const links = new Set<string>();
    await ledger.transaction((tx) => {
      tx.run('PRAGMA defer_foreign_keys=ON');
      function ensureRef(ref: SessionRef | null) {
        if (ref === null) return;
        if (!knownSources.has(ref.sourceId)) {
          insertRecord(tx, 'sources', {
            sourceId: ref.sourceId,
            harness: ref.harness,
            rootPath: `/synthetic/${ref.sourceId}`,
            label: 'Synthetic export source',
          });
          knownSources.add(ref.sourceId);
        }
        const key = sessionRefKey(ref);
        if (knownRefs.has(key)) return;
        knownRefs.add(key);
        insertRecord(tx, 'sessions', {
          sessionRef: ref,
          sourceId: ref.sourceId,
          harness: ref.harness,
          sessionId: ref.sessionId,
          threadId: ref.threadId ?? '',
        });
      }
      for (const record of records) {
        const input = fixtures.intent(record.runId) as PreparedIntent;
        const target = record.childRef;
        ensureRef(record.parentRef);
        ensureRef(target);
        input.link = {
          ...input.link,
          linkId: record.linkId,
          state: record.linkState as PreparedIntent['link']['state'],
          parentRef: record.parentRef,
          childRef: target,
          currentOwner: record.currentOwner,
          predecessor: record.predecessor,
          boundAt: record.relationshipConfirmed ? record.createdAt : null,
          label: SENTINEL,
          briefPath: `/synthetic/${SENTINEL}/brief.md`,
          reportPath: `/synthetic/${SENTINEL}/report.md`,
        };
        input.run = {
          ...input.run,
          runId: record.runId,
          linkId: record.linkId,
          runSeq: record.runSeq,
          operation: record.operation,
          sourceId: target?.sourceId ?? fixtures.sourceId,
          harness: target?.harness ?? 'codex',
          targetSessionRef: target,
          launchCwd: record.launchCwd,
          workspaceSnapshot: record.workspaceSnapshot,
          projectOrigin: record.projectOrigin,
          state: record.runState as PreparedIntent['run']['state'],
          createdAt: record.createdAt,
          startedAt: record.startedAt,
          endedAt: record.endedAt,
          submissionFencedAt: record.endedAt,
          terminalEvidenceId: record.endedAt === null ? null : `terminal-${record.runId}`,
        };
        input.claim = {
          ...input.claim,
          runId: record.runId,
          sourceId: input.run.sourceId,
          claimHash: digest(`${SENTINEL}-${record.runId}`),
          state: record.endedAt === null ? 'issued' : 'revoked',
          issuedAt: record.createdAt,
          expiresAt: record.createdAt + 1800000,
        };
        if (!links.has(record.linkId)) {
          insertRecord(tx, 'links', input.link);
          links.add(record.linkId);
        }
        insertRun(tx, input.run);
        insertClaim(tx, input.claim);
        if (record.endedAt !== null)
          insertRecord(tx, 'evidence', {
            evidenceId: input.run.terminalEvidenceId,
            runId: record.runId,
            linkId: record.linkId,
            kind: record.runState === 'failed' ? 'never_submitted' : 'scope_reconciled',
            producer: 'reconciler',
            fingerprint: digest(record.runId),
            payload: { privateText: SENTINEL },
            observedAt: record.endedAt,
            validatedAt: record.endedAt,
            validation: 'accepted',
          });
        const proof = `binding-proof-${record.runId}`;
        if (record.runHandshake.state === 'bound' && target !== null) {
          insertRecord(tx, 'evidence', {
            evidenceId: proof,
            runId: record.runId,
            linkId: record.linkId,
            kind: 'trusted_session',
            producer: 'hud-mcp',
            fingerprint: digest(proof),
            payload: { privateText: SENTINEL },
            observedAt: record.createdAt,
            validatedAt: record.createdAt,
            validation: 'accepted',
          });
          insertRecord(tx, 'child_bindings', {
            bindingId: `binding-${record.runId}`,
            runId: record.runId,
            sessionRef: target,
            bindingGeneration: 1,
            callerId: 'parent',
            callerContextId: 'parent-context',
            contextGeneration: 1,
            boundBy: 'trusted_session',
            capabilities: 'mcp',
            evidenceId: proof,
            isCurrent: record.isCurrentRun && record.currentOwner,
            createdAt: record.createdAt,
            revokedAt: record.isCurrentRun && record.currentOwner ? null : record.createdAt + 1,
          });
          insertRecord(tx, 'reports', {
            reportId: `report-${record.runId}`,
            runId: record.runId,
            linkId: record.linkId,
            childBindingId: `binding-${record.runId}`,
            callerId: 'parent',
            callerContextId: 'parent-context',
            contextGeneration: 1,
            status: 'completed',
            summary: SENTINEL,
            path: `/synthetic/${SENTINEL}/report.md`,
            createdAt: record.createdAt,
          });
        }
        insertRecord(tx, 'events', {
          linkId: record.linkId,
          runId: record.runId,
          kind: 'intent.accepted',
          payload: { privateText: SENTINEL },
          at: record.createdAt,
        });
        inputs.push(input);
      }
    });
    return {
      container,
      home,
      ledger,
      inputs,
      async cleanup() {
        await ledger.close();
        rmSync(container, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await ledger.close();
    rmSync(container, { recursive: true, force: true });
    throw error;
  }
}
