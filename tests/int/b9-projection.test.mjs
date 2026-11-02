import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ledgerReadRuntimeSupported } from '../../dist/core/ledger-read.js';
import { openLinkLedgerReader } from '../../dist/core/link-ledger-read.js';
import { projectLinkTree, planLinkRead, linkStatusInput, linkEvidenceKey } from '../../dist/core/link/index.js';
import { displayNodeKey } from '../../dist/core/observation.js';
import { observeLinkEvidence } from '../../dist/harness/codex/link-evidence.js';
import {
  fixture,
  ref,
  root,
  child,
  collected,
  parentEvidence,
  launchEvidence,
  runProof,
  hash,
  encodeRef,
  insert,
} from './b9-fixture.mjs';

const skip = ledgerReadRuntimeSupported() ? false : 'B9 ledger tests require Node 22.x >=22.13 or >=24';
const identity = (r) => ({ kind: 'session', ref: r });
const key = (r) => displayNodeKey(identity(r));
const node = (tree, r) => tree.nodes.find((n) => n.key === key(r));
const ordinary = () => [collected(root), collected(child)];
const anchored = () => [collected(root, [], [parentEvidence()]), collected(child, [], [launchEvidence()])];

test('B9 consumes the actual B8 MCP-qualified tool names without rewriting native call anchors', { skip }, async () => {
  const f = await fixture();
  try {
    const scan = {};
    const timestamp = new Date(11000).toISOString();
    observeLinkEvidence(
      {
        type: 'response_item',
        timestamp,
        payload: { type: 'function_call', call_id: 'call-a', name: 'mcp__hud__delegate_spawn' },
      },
      scan
    );
    observeLinkEvidence(
      {
        type: 'response_item',
        timestamp,
        payload: {
          type: 'function_call_output',
          call_id: 'call-a',
          id: 'parent-result-a',
          output: JSON.stringify({ linkId: 'link-a', runId: 'run-a' }),
        },
      },
      scan
    );
    assert.equal(scan.linkEvidence[0].tool, 'mcp__hud__delegate_spawn');
    const tree = await project(f, [
      collected(
        root,
        [],
        scan.linkEvidence.map((entry) => ({ ...entry, ref: root }))
      ),
      collected(child, [], [launchEvidence()]),
    ]);
    assert.equal(tree.relations[0].verification, 'corroborated');
    assert.equal(tree.candidates.length, 0);
  } finally {
    f.cleanup();
  }
});

test('B9 qualified-heavy conflicting transcripts retain the full count with bounded record IDs', { skip }, async () => {
  const f = await fixture();
  try {
    const refs = [child, f.session(ref('synthetic-other-1')), f.session(ref('synthetic-other-2'))];
    for (let i = 1; i < refs.length; i++) f.evidence(`proof-other-${i}`, 'launch_receipt', runProof(refs[i]));
    const sessions = [
      collected(root, [], [parentEvidence()]),
      ...refs.map((r, i) =>
        collected(
          r,
          [],
          Array.from({ length: 100 }, (_, j) => ({
            kind: 'tool_result',
            ref: r,
            tool: 'delegate_whoami',
            callId: `qualified-${i}-${j}`,
            nativeMessageId: `result-${i}-${j}`,
            linkId: 'link-a',
            runId: 'run-a',
            eventAt: 11000,
            launchCallId: 'call-a',
            launchCorrelationId: 'correlation-a',
          }))
        )
      ),
    ];
    const tree = await project(f, sessions);
    assert.equal(tree.relations[0].attribution, 'conflict');
    assert.equal(tree.relations[0].conflict.count, 303);
    assert.equal(tree.relations[0].conflict.recordIds.length, 200);
    assert.equal(tree.truncation.conflictRecords, 103);
  } finally {
    f.cleanup();
  }
});

for (const invalid of ['sourceGeneration', 'ref', 'gaps']) {
  test(`B9 omitted topology with invalid ${invalid} keeps unknown descendants explicit`, { skip }, async () => {
    const f = await fixture();
    try {
      const sessions = ordinary();
      if (invalid === 'sourceGeneration') sessions[1].topology.sourceGeneration = 2;
      if (invalid === 'ref') sessions[1].topology.ref = root;
      if (invalid === 'gaps') sessions[1].topology.coverage.gaps = ['synthetic-gap'];
      const tree = await project(f, sessions, { budget: { maxNodes: 1 } });
      assert.equal(tree.counts.unknownDescendants, true);
      assert.equal(tree.counts.omitted, 1);
    } finally {
      f.cleanup();
    }
  });
}

test('B9 scoped handover projection retains target-wide conflicts and their exact resolutions', { skip }, async () => {
  const f = await fixture();
  let reader;
  try {
    f.db.prepare("UPDATE links SET state='handed_over',current_owner=0 WHERE link_id='link-a'").run();
    f.addLink('b', root, child);
    f.evidence('late-target-conflict', 'conflict', {}, 'link-a', 'run-a');
    reader = await openLinkLedgerReader(f.path, { linkIds: ['link-b'] });
    const initial = reader.read();
    assert.equal(initial.state, 'available');
    assert.deepEqual(
      initial.snapshot.links.map((link) => link.linkId),
      ['link-b']
    );
    const tree = projectLinkTree({ ledger: initial, roots: [identity(root)], sessions: ordinary(), nowMs: 12000 });
    assert.equal(tree.relations[0].attribution, 'conflict');
    assert.deepEqual(tree.relations[0].conflict.recordIds, ['late-target-conflict']);
    f.evidence('run-only-conflict', 'conflict', {}, null, 'run-a');
    const runOnly = projectLinkTree({
      ledger: reader.read(),
      roots: [identity(root)],
      sessions: ordinary(),
      nowMs: 12000,
    });
    assert.equal(runOnly.relations[0].attribution, 'conflict');
    assert.ok(runOnly.relations[0].conflict.recordIds.includes('run-only-conflict'));
    f.evidence('late-target-resolution', 'conflict_resolved', { resolves: 'late-target-conflict' }, 'link-a', 'run-a');
    f.evidence('run-only-resolution', 'conflict_resolved', { resolves: 'run-only-conflict' }, null, 'run-a');
    const resolved = projectLinkTree({
      ledger: reader.read(),
      roots: [identity(root)],
      sessions: ordinary(),
      nowMs: 12000,
    });
    assert.equal(resolved.relations[0].attribution, 'confirmed');
  } finally {
    reader?.close();
    f.cleanup();
  }
});

test('B9 a conflicted explicit root keeps run and status only as history', { skip }, async () => {
  const f = await fixture();
  try {
    const other = f.session(ref('synthetic-other'));
    f.evidence('contradictory', 'launch_receipt', runProof(other));
    const sessions = ordinary();
    const view = sessions[1].evidence.observation;
    view.statusProjection.observationStamp = {
      ref: child,
      seqDomain: 'observation:synthetic',
      commitSeq: 1,
      inputLedgerSeq: 2,
      sourceGeneration: 1,
      runId: 'run-a',
      bindingGeneration: 1,
    };
    const tree = await project(f, sessions, { roots: [identity(child)] });
    assert.equal(tree.relations[0].attribution, 'conflict');
    assert.equal(tree.relations[0].currentRun.runId, 'run-a');
    assert.equal(node(tree, child).currentRun, null);
    assert.equal(node(tree, child).observation, null);
    assert.equal(node(tree, child).lastObservation, view);
    assert.equal(linkStatusInput(tree, key(child)).conflict.count, 2);
  } finally {
    f.cleanup();
  }
});

test('B9 row cap counts every known omitted descendant without expanding bodies', { skip }, async () => {
  const f = await fixture();
  try {
    const grandchild = f.session(ref('synthetic-grandchild'));
    f.addLink('b', child, grandchild);
    const tree = await project(f, [...ordinary(), collected(grandchild)], { budget: { maxNodes: 1 } });
    assert.equal(tree.nodes.length, 1);
    assert.equal(tree.counts.omitted, 2);
    assert.equal(tree.counts.knownUnloaded, 2);
    assert.equal(tree.continuation.length, 1);
  } finally {
    f.cleanup();
  }
});

test(
  'B9 a uniquely qualified transcript remains a candidate until the reconciler binds the intent',
  { skip },
  async () => {
    const f = await fixture({ links: 0 });
    try {
      f.addLink('a', root, null, 'pending');
      f.evidence('independent-launch', 'launch_receipt', runProof(child));
      const tree = await project(f, anchored());
      assert.equal(tree.counts.delegationIntents, 1);
      assert.equal(tree.candidates[0].reason, 'qualified_awaiting_reconciler');
      assert.equal(node(tree, child), undefined);
      assert.equal(f.db.prepare("SELECT state,child_ref FROM links WHERE link_id='link-a'").get().child_ref, null);
    } finally {
      f.cleanup();
    }
  }
);

async function project(f, sessions = ordinary(), extra = {}) {
  const reader = await openLinkLedgerReader(f.path);
  try {
    const messages = sessions.flatMap((s) => s.evidence.linkEvidence.filter((e) => e.kind === 'launch_message'));
    const ledger = reader.read(messages);
    assert.equal(ledger.state, 'available');
    return projectLinkTree({ ledger, roots: [identity(root)], sessions, nowMs: 12000, ...extra });
  } finally {
    reader.close();
  }
}

test('B9 late-arriving in-window evidence still corroborates after run end and claim expiry', { skip }, async () => {
  const f = await fixture();
  try {
    f.evidence('terminal', 'scope_reconciled');
    f.db
      .prepare(
        "UPDATE runs SET state='ended',ended_at=12000,terminal_evidence_id='terminal',submission_fenced_at=12000 WHERE run_id='run-a'"
      )
      .run();
    f.db.prepare("UPDATE claims SET state='revoked' WHERE run_id='run-a'").run();
    const tree = await project(f, anchored(), { nowMs: 10000000 });
    assert.equal(tree.relations[0].verification, 'corroborated');
    assert.equal(tree.relations[0].attribution, 'confirmed');
    assert.equal(node(tree, child).execution.isRunTerminal, true);
    assert.ok(!JSON.stringify(tree).includes(hash('claim-a')), 'claim hash must not escape the projection');
  } finally {
    f.cleanup();
  }
});

test('B9 duplicate evidence and repeated envelopes produce one edge and no conflict', { skip }, async () => {
  const f = await fixture();
  try {
    const sessions = anchored();
    sessions[1].evidence.linkEvidence.push({ ...launchEvidence() });
    const tree = await project(f, [...sessions, sessions[1]]);
    assert.equal(tree.nodes.length, 2);
    assert.equal(tree.relations[0].verification, 'corroborated');
    assert.equal(tree.relations[0].conflict, null);
    assert.equal(tree.candidates.length, 0);
  } finally {
    f.cleanup();
  }
});

test('B9 two contradictory explicit accepted run receipts stop attribution', { skip }, async () => {
  const f = await fixture();
  try {
    const other = f.session(ref('synthetic-other'));
    f.evidence('proof-other', 'launch_receipt', runProof(other));
    const tree = await project(f);
    assert.equal(tree.relations[0].attribution, 'conflict');
    assert.deepEqual(tree.relations[0].conflict.recordIds, ['proof-a', 'proof-other']);
    assert.equal(tree.relations[0].conflict.since, 11000);
    assert.equal(node(tree, child), undefined);
    assert.equal(f.db.prepare("SELECT state FROM links WHERE link_id='link-a'").get().state, 'bound');
  } finally {
    f.cleanup();
  }
});

test(
  'B9 two matching transcripts with independent proof per ref conflict instead of choosing the nearer record',
  { skip },
  async () => {
    const f = await fixture();
    try {
      const other = f.session(ref('synthetic-other'));
      f.evidence('proof-other', 'launch_receipt', runProof(other));
      const a = launchEvidence(),
        b = launchEvidence(other, 11001);
      const noise = (r) =>
        Array.from({ length: 99 }, (_, i) => ({
          kind: 'tool_result',
          ref: r,
          tool: 'delegate_whoami',
          callId: `ordinary-${i}`,
          nativeMessageId: `ordinary-result-${i}`,
          linkId: 'link-a',
          runId: 'run-a',
          eventAt: 11000,
        }));
      const tree = await project(f, [
        collected(root, [], [parentEvidence()]),
        collected(child, [], [...noise(child), a]),
        collected(other, [], [...noise(other), b]),
      ]);
      assert.equal(tree.relations[0].attribution, 'conflict');
      assert.ok(tree.relations[0].conflict.recordIds.includes(linkEvidenceKey(a)));
      assert.ok(tree.relations[0].conflict.recordIds.includes(linkEvidenceKey(b)));
      assert.equal(tree.relations[0].conflict.count, 4);
      assert.equal(tree.counts.confirmedSessions, 1);
    } finally {
      f.cleanup();
    }
  }
);

test('B9 fork carrying the same claim is candidate-only without independent run proof', { skip }, async () => {
  const f = await fixture();
  try {
    const fork = f.session(ref('synthetic-fork'));
    const sessions = [...anchored(), collected(fork, [], [launchEvidence(fork)])];
    const tree = await project(f, sessions);
    assert.equal(tree.relations[0].attribution, 'confirmed');
    assert.equal(tree.relations[0].conflict, null);
    assert.equal(tree.candidates[0].reason, 'independent_run_proof_missing');
    assert.equal(node(tree, fork), undefined);
    assert.equal(tree.nodes.length, 2);
    assert.equal(planLinkRead(tree, { remainingMs: 10 }).target, null);
  } finally {
    f.cleanup();
  }
});

test('B9 self-cycle in authoritative native topology is rejected without recursion', { skip }, async () => {
  const f = await fixture();
  try {
    const tree = await project(f, [collected(root, [root]), collected(child)]);
    assert.equal(tree.nodes.length, 2);
    assert.equal(node(tree, root).parentKey, null);
    assert.ok(node(tree, root).conflict);
  } finally {
    f.cleanup();
  }
});

test('B9 ledger ancestor cycle suppresses all cycle edges before traversal', { skip }, async () => {
  const f = await fixture();
  try {
    f.addLink('b', child, root);
    const tree = await project(f);
    assert.ok(tree.relations.every((r) => r.attribution === 'conflict'));
    assert.equal(tree.nodes.length, 1);
    assert.equal(tree.nodes[0].parentKey, null);
  } finally {
    f.cleanup();
  }
});

const locator = {
  kind: 'tmux',
  server: 'synthetic-server',
  session: 'synthetic-terminal',
  pane: '%42',
  runId: 'run-a',
  bindingGeneration: 1,
  process: null,
};
const host = (state, occupantMatches) => ({
  runId: 'run-a',
  bindingGeneration: 1,
  locator,
  check: { state, occupantMatches, checkedAt: 11900, evidence: ['synthetic-check'], foregroundInteractive: false },
  state: { activity: 'replacement-busy', label: 'Replacement occupant' },
});

test('B9 closed pane retains relation and last session state', { skip }, async () => {
  const f = await fixture();
  try {
    f.db.prepare("UPDATE runs SET locator=? WHERE run_id='run-a'").run(JSON.stringify(locator));
    const sessions = ordinary();
    const last = sessions[1].evidence.observation;
    const tree = await project(f, sessions, { hosts: [host('stale', null)] });
    assert.equal(tree.relations[0].attribution, 'confirmed');
    assert.equal(node(tree, child).lastObservation, last);
    assert.equal(node(tree, child).host.currentState, null);
    assert.equal(node(tree, child).currentRun.state, 'running');
  } finally {
    f.cleanup();
  }
});

test('B9 occupant mismatch preserves history but suppresses replacement host state', { skip }, async () => {
  const f = await fixture();
  try {
    f.db.prepare("UPDATE runs SET locator=? WHERE run_id='run-a'").run(JSON.stringify(locator));
    const tree = await project(f, ordinary(), { hosts: [host('stale', false)] });
    assert.equal(tree.relations[0].host.occupantMatches, false);
    assert.equal(tree.relations[0].host.currentState, null);
    assert.equal(tree.relations[0].attribution, 'confirmed');
    assert.deepEqual(tree.relations[0].host.locator, locator);
  } finally {
    f.cleanup();
  }
});

test('B9 handed_over link remains history and never becomes a second parent', { skip }, async () => {
  const f = await fixture();
  try {
    f.db.prepare("UPDATE links SET state='handed_over',current_owner=0 WHERE link_id='link-a'").run();
    const other = f.session(ref('synthetic-new-parent'));
    f.addLink('b', other, child);
    const tree = await project(f, [...ordinary(), collected(other)], { roots: [identity(other)] });
    assert.equal(tree.relations.find((r) => r.link.linkId === 'link-a').attribution, 'history');
    assert.equal(node(tree, child).parentKey, key(other));
    assert.equal(tree.nodes.filter((n) => n.key === key(child)).length, 1);
    assert.equal(node(tree, child).currentRun.runId, 'run-b');
  } finally {
    f.cleanup();
  }
});

test('B9 bind keeps intent selection mapping with one real node and one parent', { skip }, async () => {
  const f = await fixture({ links: 0 });
  try {
    f.addLink('a', root, null, 'pending');
    const before = await project(f, [collected(root)]);
    const oldKey = displayNodeKey({ kind: 'delegationIntent', linkId: 'link-a' });
    assert.equal(before.counts.delegationIntents, 1);
    assert.equal(before.counts.confirmedSessions, 1);
    f.db
      .prepare("UPDATE links SET state='bound',child_ref=?,current_owner=1,bound_at=11000 WHERE link_id='link-a'")
      .run(encodeRef(child));
    f.db.prepare("UPDATE runs SET target_session_ref=? WHERE run_id='run-a'").run(encodeRef(child));
    const after = await project(f, [collected(root, [child]), collected(child)], { selectionMap: before.selectionMap });
    assert.equal(after.selectionMap[oldKey], key(child));
    assert.equal(after.counts.delegationIntents, 0);
    assert.equal(after.nodes.length, 2);
    assert.equal(node(after, child).parentKey, key(root));
    assert.equal(node(after, child).edge, 'delegated');
    assert.equal(node(after, child).observation, null, 'binding selection does not invent compatible status');
  } finally {
    f.cleanup();
  }
});

for (const [eventAt, qualifies] of [
  [5000, true],
  [610000, true],
  [4999, false],
  [610001, false],
]) {
  test(`B9 issuance window ${eventAt} is ${qualifies ? 'accepted inclusively' : 'refused'}`, { skip }, async () => {
    const f = await fixture();
    try {
      const tree = await project(
        f,
        [collected(root, [], [parentEvidence(11000)]), collected(child, [], [launchEvidence(child, eventAt)])],
        { nowMs: 10000000 }
      );
      assert.equal(tree.relations[0].verification, qualifies ? 'corroborated' : 'not_observed');
      if (!qualifies) assert.equal(tree.candidates[0].reason, 'event_outside_issuance_window');
    } finally {
      f.cleanup();
    }
  });
}

test(
  'B9 200-node overflow preserves bounded rows, unloaded placeholders, and exact known frontier count',
  { skip },
  async () => {
    const f = await fixture({ links: 205 });
    try {
      const tree = await project(f, [collected(root)]);
      assert.equal(tree.nodes.length, 200);
      assert.equal(tree.nodes.filter((n) => !n.loaded).length, 199);
      assert.equal(tree.counts.omitted, 6);
      assert.equal(tree.counts.knownUnloaded, 205);
      assert.equal(tree.continuation.length, 200);
      assert.equal(tree.truncation.continuation, 5);
      assert.equal(tree.coverage.state, 'partial');
    } finally {
      f.cleanup();
    }
  }
);

test('B9 same-harness native descendants beyond display depth four remain loaded', { skip }, async () => {
  const f = await fixture({ links: 0 });
  try {
    const refs = [root, ...Array.from({ length: 8 }, (_, i) => ref(`synthetic-native-${i}`))];
    const sessions = refs.map((r, i) => collected(r, refs[i + 1] ? [refs[i + 1]] : []));
    const tree = await project(f, sessions);
    assert.equal(tree.nodes.length, 9);
    assert.equal(tree.nodes.at(-1).depth, 8);
    assert.ok(tree.nodes.every((n) => n.loaded && n.crossHarnessDepth === 0));
  } finally {
    f.cleanup();
  }
});

test('B9 fifth harness transition is unloaded and does not recursively expand', { skip }, async () => {
  const f = await fixture({ links: 0 });
  try {
    const refs = [
      root,
      ...Array.from({ length: 6 }, (_, i) => ref(`synthetic-cross-${i}`, i % 2 === 0 ? 'claude' : 'codex')),
    ];
    for (let i = 1; i < refs.length; i++) f.addLink(`cross-${i}`, refs[i - 1], refs[i]);
    const tree = await project(
      f,
      refs.map((r) => collected(r))
    );
    assert.equal(tree.nodes.length, 6);
    assert.equal(tree.nodes.at(-1).crossHarnessDepth, 5);
    assert.equal(tree.nodes.at(-1).loaded, false);
    assert.equal(tree.nodes[4].loaded, true);
    assert.equal(tree.continuation[0].reason, 'depth');
    assert.equal(planLinkRead(tree, { remainingMs: 10 }).target, null);
  } finally {
    f.cleanup();
  }
});

test('B9 8-MiB exact budget and overspend report actual charged I/O without recursive work', { skip }, async () => {
  const f = await fixture();
  try {
    const sessions = ordinary();
    sessions[0].bytesRead = 4 * 1024 * 1024;
    sessions[1].topology.bytesRead = 4 * 1024 * 1024;
    const exact = await project(f, sessions);
    assert.equal(exact.io.bytesRead, 8 * 1024 * 1024);
    assert.equal(exact.io.exceeded, false);
    assert.equal(planLinkRead(exact, { remainingMs: 10 }).reason, 'bytes');
    sessions[1].bytesRead = 1;
    const overflow = await project(f, sessions);
    assert.equal(overflow.io.bytesRead, 8 * 1024 * 1024 + 1);
    assert.equal(overflow.io.exceeded, true);
    assert.equal(overflow.nodes[0].loaded, false);
    assert.equal(overflow.nodes.length, 1);
    assert.equal(overflow.coverage.reason, 'collection_budget_exceeded');
  } finally {
    f.cleanup();
  }
});

test('B9 unknown native topology stays partial and read planning shares bytes/deadline fairly', { skip }, async () => {
  const f = await fixture();
  try {
    const sessions = ordinary();
    delete sessions[0].topology;
    sessions[1].loaded = false;
    const tree = await project(f, sessions);
    assert.equal(node(tree, root).loaded, true);
    assert.equal(tree.counts.unknownDescendants, true);
    const first = planLinkRead(tree, { remainingMs: 7 });
    assert.ok(first.target);
    assert.equal(first.budget.budgetMs, 7);
    const second = planLinkRead(tree, { remainingMs: 3, afterKey: first.nextCursor });
    assert.ok(second.target);
    assert.notEqual(first.target.key, second.target.key);
    assert.equal(planLinkRead(tree, { remainingMs: 0 }).reason, 'deadline');
    assert.equal(
      planLinkRead(tree, { remainingMs: 3, minimumBytes: new Map([[first.target.key, 9 * 1024 * 1024]]) }).reason,
      'bytes'
    );
  } finally {
    f.cleanup();
  }
});

test('B9 old-run or unknown-shape proofs cannot qualify a new run/fork', { skip }, async () => {
  const f = await fixture();
  try {
    const fork = f.session(ref('synthetic-fork'));
    f.evidence('unrelated', 'trusted_session', { sessionRef: fork }, null, null);
    f.evidence('wrong-generation', 'launch_receipt', { ...runProof(fork), bindingGeneration: 2 });
    f.evidence('unknown-proof-shape', 'launch_receipt', { ref: fork, independentEvidence: true });
    const tree = await project(f, [...anchored(), collected(fork, [], [launchEvidence(fork)])]);
    assert.equal(tree.relations[0].attribution, 'confirmed');
    assert.equal(tree.candidates[0].reason, 'independent_run_proof_missing');
  } finally {
    f.cleanup();
  }
});

test('B9 conflict resolution clears only the named record in the same run', { skip }, async () => {
  const f = await fixture();
  try {
    f.evidence('x1', 'conflict');
    f.evidence('x2', 'conflict');
    f.evidence('resolution1', 'conflict_resolved', { resolves: 'x1' });
    f.evidence('wrong-scope', 'conflict_resolved', { resolves: 'x2' }, null, null);
    const tree = await project(f);
    assert.deepEqual(tree.relations[0].conflict.recordIds, ['x2']);
    assert.equal(tree.relations[0].attribution, 'conflict');
    const fragment = linkStatusInput(tree, key(child));
    assert.equal(fragment.asOfSeq, 2);
    assert.deepEqual(fragment.conflict.recordIds, ['x2']);
  } finally {
    f.cleanup();
  }
});

test('B9 competing authoritative parents conflict before visited order can choose one', { skip }, async () => {
  const f = await fixture();
  try {
    const other = ref('synthetic-native-parent');
    const tree = await project(f, [collected(root, [other]), collected(other, [child]), collected(child)]);
    assert.equal(tree.relations[0].attribution, 'conflict');
    assert.equal(node(tree, child), undefined);
    assert.equal(tree.relations[0].conflict.count, 2);
  } finally {
    f.cleanup();
  }
});

test(
  'B9 parent call and child launch message anchors remain separate; missing whoami correlations stay candidates',
  { skip },
  async () => {
    const f = await fixture();
    try {
      const whoami = {
        kind: 'tool_result',
        ref: child,
        tool: 'delegate_whoami',
        callId: 'child-call',
        nativeMessageId: 'child-result',
        linkId: 'link-a',
        runId: 'run-a',
        eventAt: 11001,
      };
      const p = { ...parentEvidence(), nativeMessageId: null };
      const tree = await project(f, [collected(root, [], [p]), collected(child, [], [launchEvidence(), whoami])]);
      assert.equal(tree.relations[0].verification, 'corroborated');
      assert.equal(tree.candidates[0].reason, 'launch_anchor_unverified');
      const wrong = await project(f, [
        collected(root, [], [parentEvidence()]),
        collected(child, [], [{ ...launchEvidence(), nativeMessageId: 'parent-message-a' }]),
      ]);
      assert.equal(wrong.candidates[0].reason, 'launch_message_mismatch');
    } finally {
      f.cleanup();
    }
  }
);

test('B9 mismatched fingerprints and stale reading lineages remain candidates', { skip }, async () => {
  const f = await fixture();
  try {
    const sessions = anchored();
    sessions[1].evidence.linkEvidence[0].claimFingerprint = hash('incorrect');
    const wrong = await project(f, sessions);
    assert.equal(wrong.candidates[0].reason, 'claim_fingerprint_mismatch');
    sessions[1].linkEvidenceCurrent = false;
    const stale = await project(f, sessions);
    assert.equal(stale.candidates[0].reason, 'reading_lineage_unverified');
    assert.equal(stale.relations[0].attribution, 'confirmed');
  } finally {
    f.cleanup();
  }
});

test('B9 launch_failed intent is non-execution and does not fabricate a session or failed turn', { skip }, async () => {
  const f = await fixture({ links: 0 });
  try {
    f.addLink('a', root, null, 'pending');
    f.evidence('never', 'never_submitted');
    f.db
      .prepare(
        "UPDATE runs SET state='failed',ended_at=12000,terminal_evidence_id='never',submission_fenced_at=12000 WHERE run_id='run-a'"
      )
      .run();
    f.db.prepare("UPDATE links SET state='failed' WHERE link_id='link-a'").run();
    const tree = await project(f, [collected(root)]);
    const intent = tree.nodes.find((n) => n.identity.kind === 'delegationIntent');
    assert.equal(intent.execution.execution, 'non_execution');
    assert.equal(intent.execution.launchFailure.stateKey, 'launch_failed');
    assert.equal(intent.execution.isRunTerminal, true);
    assert.equal(intent.observation, null);
    assert.equal(tree.counts.confirmedSessions, 1);
  } finally {
    f.cleanup();
  }
});

test('B9 resume does not borrow old-run proof, status, duration or observation stamp', { skip }, async () => {
  const f = await fixture();
  try {
    const row = f.db.prepare("SELECT * FROM runs WHERE run_id='run-a'").get();
    insert(f.db, 'runs', {
      ...row,
      run_id: 'run-b',
      run_seq: 2,
      operation: 'resume',
      expected_generation: 2,
      launch_token_hash: hash('token-b'),
      launch_call_id: 'call-b',
      launch_correlation_id: 'correlation-b',
      launch_message_id: 'message-b',
      created_at: 13000,
      started_at: 13001,
    });
    insert(f.db, 'claims', {
      run_id: 'run-b',
      claim_hash: hash('claim-b'),
      source_id: child.sourceId,
      expected_generation: 2,
      state: 'issued',
      issued_at: 13000,
      expires_at: 1813000,
    });
    const sessions = ordinary();
    const old = sessions[1].evidence.observation;
    old.statusProjection.observationStamp = {
      ref: child,
      seqDomain: 'observation:synthetic',
      commitSeq: 1,
      inputLedgerSeq: 2,
      sourceGeneration: 1,
      runId: 'run-a',
      bindingGeneration: 1,
    };
    old.statusProjection.stateKey = 'failed:synthetic-old-run';
    old.statusProjection.stateSince = 10500;
    sessions[0].evidence.linkEvidence = [{ ...parentEvidence(14000, 'b'), linkId: 'link-a', tool: 'delegate_resume' }];
    sessions[1].evidence.linkEvidence = [{ ...launchEvidence(child, 14000, 'b'), linkId: 'link-a' }];
    const tree = await project(f, sessions, { nowMs: 15000 });
    assert.equal(tree.relations[0].attribution, 'confirmed');
    assert.equal(tree.relations[0].currentRun.runId, 'run-b');
    assert.equal(tree.relations[0].verification, 'not_observed');
    assert.equal(tree.candidates[0].reason, 'independent_run_proof_missing');
    assert.equal(node(tree, child).observation, null);
    assert.equal(node(tree, child).lastObservation, old);
    assert.equal(node(tree, child).execution.isRunTerminal, false);
  } finally {
    f.cleanup();
  }
});

test(
  'B9 compatible committed status keeps its original observation stamp independently of ledger high-water',
  { skip },
  async () => {
    const f = await fixture();
    try {
      const sessions = ordinary();
      const view = sessions[1].evidence.observation;
      view.statusProjection.observationStamp = {
        ref: child,
        seqDomain: 'observation:synthetic',
        commitSeq: 3,
        inputLedgerSeq: 1,
        sourceGeneration: 1,
        runId: 'run-a',
        bindingGeneration: 1,
      };
      const tree = await project(f, sessions);
      assert.equal(node(tree, child).observation, view);
      assert.equal(node(tree, child).observation.statusProjection.observationStamp.inputLedgerSeq, 1);
      assert.equal(tree.ledger.asOfSeq, 2);
    } finally {
      f.cleanup();
    }
  }
);

test('B9 missing collection costs are unknown and cannot authorize another read', { skip }, async () => {
  const f = await fixture();
  try {
    const sessions = ordinary();
    delete sessions[0].bytesRead;
    const tree = await project(f, sessions);
    assert.equal(tree.io.bytesRead, null);
    assert.equal(tree.io.remainingBytes, 0);
    assert.equal(planLinkRead(tree, { remainingMs: 10 }).reason, 'bytes');
    assert.ok(tree.coverage.gaps.includes('collection_cost_unknown'));
  } finally {
    f.cleanup();
  }
});

test('B9 an anchor with no event time stays unqualified without throwing into a tick', { skip }, async () => {
  const f = await fixture();
  try {
    const sessions = anchored();
    delete sessions[1].evidence.linkEvidence[0].eventAt;
    const tree = await project(f, sessions);
    assert.equal(tree.relations[0].verification, 'not_observed');
    assert.equal(tree.candidates[0].asOf, null);
    assert.equal(tree.candidates[0].reason, 'event_outside_issuance_window');
  } finally {
    f.cleanup();
  }
});
