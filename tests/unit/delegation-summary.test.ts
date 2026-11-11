import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { handshakeFixture } from './b45-handshake-fixture.js';
import { HandshakeService } from '../../packages/hud-mcp/src/handshake.js';
import { insertRecord } from '../../src/ledger/records.js';
import { makeSourceId, sessionRefKey } from '../../src/core/identity.js';
import { displayNodeKey, projectFreshness } from '../../src/core/observation.js';
import { PublicationWorker } from '../../src/core/link/publication-worker.js';
import { buildDelegationSummaries, publishDelegationSummaries } from '../../src/core/delegation-summary-publisher.js';
import { delegationSummaryStatusline, validateDelegationSummary } from '../../src/core/delegation-summary-schema.js';
import {
  delegationSummaryPath,
  readDelegationSummary,
  summaryFileIdentity,
  writeDelegationSummary,
} from '../../src/core/delegation-summary-store.js';
import { readStatuslineSummary } from '../../src/core/statusline-summary.js';
import { renderStatuslineSummary } from '../../src/render/statusline-summary.js';
import { createPiDelegationSummaryProvider, type PiFooterIdentity } from '../../src/harness/pi/footer.js';
import type { DelegationViewModel } from '../../src/core/link/view-model.js';
import type { LinkTreeNode, LinkRelationProjection } from '../../src/core/link/types.js';
import type { SessionRef } from '../../src/core/types/identity.js';

const NOW = 1_800_000_000_000;
const ref = (id: string): SessionRef => ({ harness: 'codex', sourceId: 'a'.repeat(64), sessionId: id, threadId: null });
function viewFixture(now = NOW) {
  const parent = ref('parent');
  const child = ref('child');
  const stamp = {
    ref: child,
    runId: 'run-a',
    bindingGeneration: 1,
    sourceGeneration: 1,
    seqDomain: 'synthetic',
    commitSeq: 2,
    inputLedgerSeq: 7,
  };
  const status = {
    activity: 'working' as const,
    pendingReason: 'none' as const,
    lastTurnOutcome: 'none' as const,
    liveness: 'alive' as const,
    freshness: projectFreshness([], [], now),
    stateKey: 'working',
    stateSince: now - 1000,
    stateSinceBasis: 'event' as const,
    isRunTerminal: false,
    asOfSeq: 7,
    observationStamp: stamp,
    asOf: now,
    observedAt: now,
    lastEvidenceAt: now,
  };
  const run = {
    runId: 'run-a',
    expectedGeneration: 1,
    sourceId: child.sourceId,
    harness: child.harness,
    state: 'running',
    mode: 'headless',
    createdAt: now - 1000,
    endedAt: null,
    cancelRequestedAt: null,
  };
  const relation = {
    link: {
      linkId: 'link-a',
      parentRef: parent,
      childRef: child,
      currentOwner: true,
      label: 'Synthetic work',
      role: 'imp',
      backend: 'codex',
      state: 'bound',
    },
    currentRun: run,
    parentKey: displayNodeKey({ kind: 'session', ref: parent }),
    childKey: displayNodeKey({ kind: 'session', ref: child }),
    attribution: 'confirmed',
    verification: 'corroborated',
    conflict: null,
  } as unknown as LinkRelationProjection;
  const coverage = { state: 'complete' as const, loaded: true, gaps: [], skipped: {} };
  const node = {
    key: relation.childKey,
    identity: { kind: 'session', ref: child },
    loaded: true,
    currentRun: run,
    conflict: null,
    observation: { loaded: true, conflict: null, statusProjection: status, coverage },
  } as unknown as LinkTreeNode;
  const view = {
    tree: {
      ledger: { state: 'available', ledgerId: 'synthetic-ledger', asOfSeq: 9, reason: null },
      nodes: [node],
      relations: [relation],
      continuation: [],
      truncation: { continuation: 0 },
    },
    details: {},
  } as unknown as DelegationViewModel;
  return { parent, child, view, node, relation, status, stamp, run };
}

test('one settled committed view keeps sibling facts across unrelated ledger events, explicit partial and no totals', () => {
  const f = viewFixture();
  const summary = buildDelegationSummaries(f.view, NOW - 100, NOW, '1:2')[0];
  assert.ok(validateDelegationSummary(summary, f.parent, NOW));
  assert.equal(summary.asOfSeq, 9);
  assert.equal(summary.children[0].stamp?.inputLedgerSeq, 7);
  assert.equal(summary.children[0].status?.activity, 'working');
  assert.equal(summary.children[0].status?.observedAt, NOW);
  assert.equal(summary.expiresAt, NOW + 4900);
  assert.equal(summary.treeCounts, null);
  assert.equal(summary.coverage, 'partial');
  assert.equal(validateDelegationSummary(summary, { ...f.parent, sourceId: 'b'.repeat(64) }, NOW), false);
  assert.equal(validateDelegationSummary(summary, { ...f.parent, threadId: 'branch' }, NOW), false);
  assert.ok(!validateDelegationSummary({ ...summary, schemaVersion: 2 }, f.parent, NOW));
  assert.ok(!validateDelegationSummary({ ...summary, treeCounts: { total: 1 } }, f.parent, NOW));
  assert.ok(!validateDelegationSummary(summary, f.parent, NOW - 1));
  assert.ok(!validateDelegationSummary(summary, f.parent, NOW + 4901));
});

test('run/binding/ref/lifecycle conflicts and stale child evidence do not erase healthy siblings', () => {
  for (const mutate of [
    (f: ReturnType<typeof viewFixture>) => {
      f.stamp.runId = 'old-run';
    },
    (f: ReturnType<typeof viewFixture>) => {
      f.stamp.bindingGeneration = 2;
    },
    (f: ReturnType<typeof viewFixture>) => {
      f.stamp.ref = ref('other');
    },
    (f: ReturnType<typeof viewFixture>) => {
      f.stamp.inputLedgerSeq = 10;
    },
    (f: ReturnType<typeof viewFixture>) => {
      f.run.state = 'ended';
    },
    (f: ReturnType<typeof viewFixture>) => {
      f.status.observedAt = NOW - 5001;
    },
    (f: ReturnType<typeof viewFixture>) => {
      f.node.conflict = { count: 2, since: NOW - 3, recordIds: ['synthetic'] };
    },
  ]) {
    const f = viewFixture();
    const sibling = structuredClone(f.node);
    sibling.key = 'sibling';
    const relation = structuredClone(f.relation);
    relation.link.linkId = 'sibling-link';
    relation.childKey = sibling.key;
    f.view.tree.nodes.push(sibling);
    f.view.tree.relations.push(relation);
    mutate(f);
    const s = buildDelegationSummaries(f.view, NOW, NOW, '1:2')[0];
    assert.equal(s.children[0].status, null);
    assert.equal(s.children[1].status?.activity, 'working');
    assert.ok(validateDelegationSummary(s, f.parent, NOW));
    if (f.node.conflict)
      assert.match(renderStatuslineSummary(delegationSummaryStatusline(s, NOW), 180, NOW)!, /conflict/);
  }
});

test('candidate cap, ledger age and original child age cannot be refreshed by rewriting cache', () => {
  const f = viewFixture();
  const s = buildDelegationSummaries(f.view, NOW, NOW, '1:2')[0];
  assert.equal(delegationSummaryStatusline(s, NOW + 5001).children[0].status, null);
  assert.equal(buildDelegationSummaries(f.view, NOW - 5001, NOW, '1:2').length, 0);
  assert.equal(buildDelegationSummaries(f.view, NOW + 1, NOW, '1:2').length, 0);
  f.view.tree.relations = Array.from({ length: 51 }, (_, i) => ({
    ...f.relation,
    link: { ...f.relation.link, linkId: `link-${i}`, currentOwner: i === 50 },
  }));
  const capped = buildDelegationSummaries(f.view, NOW, NOW, '1:2')[0];
  assert.equal(capped.children.length, 0, 'filtering cannot scan past candidate cap');
  assert.equal(capped.limitReached, true);
});

async function privateFixture(t: test.TestContext) {
  const f = await handshakeFixture();
  t.after(() => f.close());
  const v = viewFixture(Date.now());
  const s = buildDelegationSummaries(
    v.view,
    Date.now(),
    Date.now(),
    summaryFileIdentity(join(f.root, 'ledger.sqlite'))
  )[0];
  return { ...f, ...v, summary: s };
}

test('cache bounded read validates private paths, schema, exact identity, age and ledger replacement without mutation', async (t) => {
  const f = await privateFixture(t);
  assert.ok(writeDelegationSummary(f.root, f.summary));
  const file = delegationSummaryPath(f.root, f.parent);
  const original = fs.readFileSync(file);
  const before = fs.statSync(file);
  assert.deepEqual(readDelegationSummary(f.root, f.parent, { clock: () => 0 }), f.summary);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.equal(readDelegationSummary(f.root, { ...f.parent, threadId: 'other' }), null);
  assert.equal(readDelegationSummary(f.root, f.parent, { budgetMs: 0 }), null);
  let clock = 0;
  assert.equal(readDelegationSummary(f.root, f.parent, { clock: () => (clock += 5) }), null);
  for (const content of [
    '{',
    JSON.stringify({ ...f.summary, schemaVersion: 2 }),
    ' '.repeat(256 * 1024 + 1),
    JSON.stringify({ ...f.summary, ledgerFileIdentity: 'wrong' }),
    JSON.stringify({ ...f.summary, expiresAt: f.summary.observedAt - 1 }),
  ]) {
    fs.writeFileSync(file, content);
    assert.equal(readDelegationSummary(f.root, f.parent), null);
  }
  fs.writeFileSync(file, original);
  fs.chmodSync(file, 0o644);
  assert.equal(readDelegationSummary(f.root, f.parent), null);
  assert.equal(writeDelegationSummary(f.root, f.summary), false);
  fs.chmodSync(file, 0o600);
  const moved = file + '.old';
  fs.renameSync(file, moved);
  fs.symlinkSync(moved, file);
  assert.equal(readDelegationSummary(f.root, f.parent), null);
  assert.equal(writeDelegationSummary(f.root, f.summary), false);
  fs.unlinkSync(file);
  fs.renameSync(moved, file);
  const write = t.mock.method(fs, 'renameSync', () => {
    throw new Error('synthetic pre-rename crash');
  });
  syncBuiltinESMExports();
  try {
    assert.equal(writeDelegationSummary(f.root, { ...f.summary, children: [] }), false);
  } finally {
    write.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(fs.readFileSync(file), original, 'failed publication preserves complete previous envelope');
  assert.ok(fs.readdirSync(join(f.root, 'delegation-summaries-v1')).every((name) => !name.startsWith('.pending-')));
  assert.equal(publishDelegationSummaries(f.root, f.view, Date.now(), 'old-ledger-inode'), 0);
  assert.deepEqual(fs.readFileSync(file), original, 'a different ledger identity cannot bless an old view');
  const originalOpen = fs.openSync;
  const read = t.mock.method(fs, 'openSync', (...args: unknown[]) => {
    assert.ok((Number(args[1]) & fs.constants.O_NONBLOCK) !== 0);
    assert.ok((Number(args[1]) & fs.constants.O_NOFOLLOW) !== 0);
    return Reflect.apply(originalOpen, fs, args);
  });
  syncBuiltinESMExports();
  try {
    assert.ok(readDelegationSummary(f.root, f.parent, { clock: () => 0 }));
  } finally {
    read.mock.restore();
    syncBuiltinESMExports();
  }
  const originalClose = fs.closeSync;
  let tick = 0;
  const delayedClose = t.mock.method(fs, 'closeSync', (fd: number) => {
    originalClose(fd);
    tick = 30;
  });
  syncBuiltinESMExports();
  try {
    assert.equal(
      readDelegationSummary(f.root, f.parent, { clock: () => tick }),
      null,
      'close is inside the read budget'
    );
  } finally {
    delayedClose.mock.restore();
    syncBuiltinESMExports();
  }
});

async function workerFixture(t: test.TestContext, harness: 'claude' | 'pi') {
  const f = await handshakeFixture();
  t.after(() => f.close());
  await f.startup();
  const service = new HandshakeService({
    ledger: f.ledger,
    registration: f.child.registration,
    reader: f.reader,
    env: { HUD_CLAIM: f.claim },
    now: f.now,
  });
  await service.whoami({}, f.child.authority);
  const root = join(f.root, `synthetic-${harness}`);
  fs.mkdirSync(root, { mode: 0o700 });
  const parent: SessionRef = {
    harness,
    sourceId: makeSourceId(harness, root),
    sessionId: 'synthetic-parent',
    threadId: null,
  };
  const file = join(root, `${parent.sessionId}.jsonl`);
  const timestamp = new Date().toISOString();
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'session', version: 3, id: parent.sessionId, timestamp, cwd: '/synthetic' }) + '\n'
  );
  const codexDir = join(f.root, 'sessions', '2026', '11', '05');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    join(codexDir, `rollout-${f.child.ref.sessionId}.jsonl`),
    JSON.stringify({
      type: 'session_meta',
      timestamp,
      payload: { id: f.child.ref.sessionId, cwd: '/synthetic', timestamp, cli_version: 'synthetic' },
    }) + '\n'
  );
  await f.ledger.transaction((tx) => {
    insertRecord(tx, 'sources', { sourceId: parent.sourceId, harness, rootPath: root, label: 'Synthetic parent' });
    tx.run(
      'INSERT INTO sessions(session_ref,harness,source_id,session_id,thread_id) VALUES(?,?,?,?,?)',
      sessionRefKey(parent),
      harness,
      parent.sourceId,
      parent.sessionId,
      ''
    );
    tx.run(
      'UPDATE links SET parent_ref=?,label=? WHERE link_id=?',
      sessionRefKey(parent),
      'Shared synthetic child',
      'link-a'
    );
  });
  let settled: ((error: string | null) => void) | undefined;
  const worker = new PublicationWorker(f.root, f.root, (_changed, error) => settled?.(error));
  let closed = false;
  t.after(async () => {
    if (!closed) await worker.close();
  });
  async function collect() {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('synthetic summary worker timeout')), 10000);
      settled = (error) => {
        clearTimeout(timer);
        settled = undefined;
        if (error) reject(new Error(error));
        else resolve();
      };
      worker.request();
    });
  }
  let summary;
  for (let i = 0; i < 50; i++) {
    await collect();
    summary = readDelegationSummary(f.root, parent, { clock: () => 0 });
    if (summary?.children[0]?.status) break;
  }
  assert.ok(summary?.children[0]?.status, JSON.stringify(summary));
  const close = async () => {
    assert.equal(await worker.close(), true);
    closed = true;
  };
  return { ...f, sourceRoot: root, parentRef: parent, file, summary, close };
}

test('real owned worker publishes cache consumed first by actual hud-statusline, miss keeps indexed fallback and stdin', async (t) => {
  const f = await workerFixture(t, 'claude');
  const input = {
    session_id: f.parentRef.sessionId,
    model: { display_name: 'Stdin wins' },
    context_window: { used_percentage: 42 },
    cost: { total_cost_usd: 0.12 },
  };
  const env = { HOME: f.root, HUD_HOME: f.root, CLAUDE_CONFIG_DIR: f.sourceRoot };
  assert.equal((await readStatuslineSummary(input, env, undefined, { clock: () => 0 })).source, 'committed_summary');
  const result = spawnSync(process.execPath, [resolve('bin/hud-statusline'), '--width', '180'], {
    input: JSON.stringify(input),
    env: {
      ...env,
      PATH: process.env.PATH,
      NODE_OPTIONS: `--import=${pathToFileURL(resolve('tests/fixtures/pinned-budget-clock.mjs')).href}`,
    },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Stdin wins/);
  assert.match(result.stdout, /partial.*Shared synthetic child/);
  await f.close();
  fs.writeFileSync(delegationSummaryPath(f.root, f.parentRef), '{');
  assert.equal((await readStatuslineSummary(input, env, undefined, { clock: () => 0 })).source, 'parent_index');
  const absent = spawnSync(process.execPath, [resolve('bin/hud-statusline')], {
    input: JSON.stringify(input),
    env: { HOME: f.root, HUD_HOME: '/synthetic/missing' },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(absent.status, 0);
  assert.match(absent.stdout, /Stdin wins/);
  assert.equal(absent.stdout.trim().split('\n').length, 1);
});

test('real owned worker feeds the retained Pi provider; exact native identity, source and freshness required', async (t) => {
  const f = await workerFixture(t, 'pi');
  const identity: PiFooterIdentity = {
    sessionId: f.parentRef.sessionId,
    sessionFile: f.file,
    sessionDir: f.sourceRoot,
    leafId: 'leaf-a',
  };
  const env = { HUD_HOME: f.root, HUD_PI_SOURCE_ROOT: f.sourceRoot };
  const provider = createPiDelegationSummaryProvider(env);
  const result = provider(identity) as {
    identity: PiFooterIdentity;
    committedDelegation: { expiresAt: number; children: unknown[] };
  };
  assert.deepEqual(result.identity, identity);
  assert.ok(result.committedDelegation);
  assert.match(JSON.stringify(result.committedDelegation), /Shared synthetic child/);
  assert.equal(provider({ ...identity, sessionId: 'synthetic-fork', leafId: 'leaf-fork' }), null);
  assert.equal(createPiDelegationSummaryProvider({ ...env, HUD_PI_SOURCE_ROOT: '/unrelated' })(identity), null);
  assert.equal(createPiDelegationSummaryProvider(env, () => result.committedDelegation.expiresAt + 1)(identity), null);
  assert.equal(provider({ ...identity, sessionFile: null }), null);
  await f.close();
  fs.unlinkSync(delegationSummaryPath(f.root, f.parentRef));
  assert.equal(provider(identity), null);
});
