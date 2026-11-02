import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { openLinkLedgerReader } from '../../dist/core/link-ledger-read.js';
import { ledgerReadRuntimeSupported } from '../../dist/core/ledger-read.js';
import { projectLinkTree } from '../../dist/core/link/index.js';
import { fixture, root, child, ref, collected, parentEvidence } from './b9-fixture.mjs';

if (!ledgerReadRuntimeSupported()) {
  console.log('B9 performance skipped: requires Node 22.x >=22.13 or >=24 (23 unsupported)');
  process.exit(0);
}

const samples = Number(process.env.B9_SAMPLES ?? 1000);
const mode = process.env.B9_LINK_EVIDENCE ?? 'empty';
const populated = mode !== 'empty';
assert.ok(Number.isSafeInteger(samples) && samples >= 1000);
const stats = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) };
};
const cases = [];
for (const count of [0, 20, 200]) {
  const f = await fixture({ links: Math.max(0, count - 1) });
  const opening = performance.now();
  const reader = await openLinkLedgerReader(f.path);
  const openMs = performance.now() - opening;
  try {
    const sessions = count ? [collected(root), collected(child)] : [];
    for (let i = 1; i < count - 1; i++) sessions.push(collected(ref(`synthetic-${i}`)));
    if (populated && count) {
      sessions[0].evidence.linkEvidence = sessions
        .slice(1, 101)
        .map((_, i) => parentEvidence(11000, i === 0 ? 'a' : `n${i}`));
      for (let i = 1; i < sessions.length; i++) {
        const id = i === 1 ? 'a' : `n${i - 1}`;
        sessions[i].evidence.linkEvidence = Array.from({ length: 100 }, (_, j) => ({
          kind: 'tool_result',
          ref: sessions[i].evidence.ref,
          tool: mode === 'historical' ? 'delegate_spawn' : 'delegate_whoami',
          callId: `whoami-${id}-${j}`,
          nativeMessageId: `result-${id}-${j}`,
          linkId: mode === 'historical' ? `outside-link-${id}` : `link-${id}`,
          runId: mode === 'historical' ? `outside-run-${id}` : `run-${id}`,
          eventAt: 11000,
          ...(mode === 'qualified' ? { launchCallId: `call-${id}`, launchCorrelationId: `correlation-${id}` } : {}),
        }));
      }
    }
    const roots = count ? [{ kind: 'session', ref: root }] : [];
    const snapshotMs = [],
      projectionMs = [],
      totalMs = [];
    for (let i = -200; i < samples; i++) {
      const start = performance.now();
      const ledger = reader.read();
      assert.equal(ledger.state, 'available');
      const copied = performance.now();
      const tree = projectLinkTree({ ledger, roots, sessions, nowMs: 12000 });
      const end = performance.now();
      assert.equal(tree.nodes.length, count);
      if (populated)
        assert.equal(
          tree.candidates.length + tree.truncation.candidates,
          Math.max(0, count - 1 - (mode === 'qualified' ? 100 : 0)) * 100
        );
      if (i >= 0) {
        snapshotMs.push(copied - start);
        projectionMs.push(end - copied);
        totalMs.push(end - start);
      }
    }
    cases.push({
      nodes: count,
      linkEvidence: sessions.reduce((sum, session) => sum + session.evidence.linkEvidence.length, 0),
      openMs,
      scopeRows: {
        links: Math.max(0, count - 1),
        runs: Math.max(0, count - 1),
        events: 2 * Math.max(0, count - 1),
        claims: Math.max(0, count - 1),
        bindings: Math.max(0, count - 1),
        evidence: Math.max(0, count - 1),
        reports: 0,
        slots: 0,
      },
      snapshotMs: stats(snapshotMs),
      projectionMs: stats(projectionMs),
      totalMs: stats(totalMs),
      snapshotsPerTick: 1,
      readStatementsPerTick: 11,
      perNodeQueries: 0,
      sqliteVersion: f.db.prepare('SELECT sqlite_version() AS version').get().version,
    });
  } finally {
    reader.close();
    f.cleanup();
  }
}
console.log(JSON.stringify({ node: process.version, mode, cases }, null, 2));
