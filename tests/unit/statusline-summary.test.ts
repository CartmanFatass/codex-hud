import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { handshakeFixture } from './b45-handshake-fixture.js';
import { HandshakeService } from '../../packages/hud-mcp/src/handshake.js';
import { insertRecord } from '../../src/ledger/records.js';
import { makeSourceId, sessionRefKey } from '../../src/core/identity.js';
import { readStatuslineSummary, statuslineRef } from '../../src/core/statusline-summary.js';
import { renderStatuslineSummary } from '../../src/render/statusline-summary.js';
import { visualLength } from '../../src/render/colors.js';
import { openObservationStore, ObservationStore } from '../../src/core/observation-store.js';
import { initialParserState, projectFreshness } from '../../src/core/observation.js';
import { checkpointBoundary, witnessObservationBoundary } from '../../src/core/checkpoint.js';
import type { ObservationCommit } from '../../src/core/types/observation.js';

async function fixture(t: test.TestContext) {
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
  const sourceRoot = join(f.root, 'synthetic-claude');
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  const parent = {
    harness: 'claude' as const,
    sourceId: makeSourceId('claude', sourceRoot),
    sessionId: 'synthetic-parent',
    threadId: null,
  };
  await f.ledger.transaction((tx) => {
    insertRecord(tx, 'sources', {
      sourceId: parent.sourceId,
      harness: 'claude',
      rootPath: sourceRoot,
      label: 'Synthetic',
    });
    tx.run(
      'INSERT INTO sessions(session_ref,harness,source_id,session_id,thread_id) VALUES(?,?,?,?,?)',
      sessionRefKey(parent),
      parent.harness,
      parent.sourceId,
      parent.sessionId,
      ''
    );
    tx.run(
      'UPDATE links SET parent_ref=?,label=? WHERE link_id=?',
      sessionRefKey(parent),
      'Synthetic review',
      'link-a'
    );
  });
  const input = {
    session_id: parent.sessionId,
    model: { display_name: 'Stdin model' },
    context_window: { used_percentage: 42 },
    cost: { total_cost_usd: 0.12 },
    transcript_path: '/never/read/this.jsonl',
  };
  const env = { HOME: f.root, HUD_HOME: f.root, CLAUDE_CONFIG_DIR: sourceRoot };
  const read = (nowMs = Date.now(), extra = {}) =>
    readStatuslineSummary(input, env, undefined, { nowMs, clock: () => 0, ...extra });
  const store = await openObservationStore({ hudHome: f.root, sourceId: f.child.ref.sourceId });
  t.after(() => store.close());
  const publish = (now = Date.now()) => {
    const ref = f.child.ref;
    const asOfSeq = Number(f.ledger.snapshot((tx) => tx.get('SELECT max(seq) AS seq FROM events')?.seq));
    const stamp = {
      ref,
      sourceGeneration: 1,
      seqDomain: 'synthetic-statusline',
      commitSeq: 1,
      inputLedgerSeq: asOfSeq,
      runId: 'run-a',
      bindingGeneration: 1,
    };
    const commit: ObservationCommit = {
      ref,
      sourceGeneration: 1,
      leaseGeneration: 1,
      seqDomain: stamp.seqDomain,
      commitSeq: 1,
      observationStamp: stamp,
      checkpoint: {
        schemaVersion: 1,
        readerVersion: 'synthetic-statusline-v1',
        ref,
        fileId: { dev: 1, inode: 2 },
        offset: 0,
        sourceGeneration: 1,
        parserState: initialParserState(),
      },
      summary: {
        nodeIdentity: { kind: 'session', ref },
        statusProjection: {
          activity: 'working',
          pendingReason: 'none',
          lastTurnOutcome: 'none',
          liveness: 'alive',
          freshness: projectFreshness([], [], now),
          stateKey: 'working',
          stateSince: now - 1000,
          stateSinceBasis: 'event',
          isRunTerminal: false,
          asOfSeq,
          observationStamp: stamp,
          asOf: now,
          observedAt: now,
          lastEvidenceAt: now,
        },
        conflict: null,
        spent: {
          tokens: { value: null, quality: 'unknown', source: 'synthetic', asOf: now },
          costUsd: { value: null, quality: 'unknown', source: 'synthetic', asOf: now },
        },
        workspace: null,
        coverage: { state: 'complete', skipped: {}, gaps: [], loaded: true },
        loaded: true,
        depth: 0,
        evidenceStamp: 'synthetic-statusline',
      },
      continuity: {
        nodeIdentity: { kind: 'session', ref },
        runId: 'run-a',
        bindingGeneration: 1,
        ruleVersion: 'synthetic-statusline',
        sourceGeneration: 1,
        episodeAnchor: 'synthetic-working',
        stateKey: 'working',
        stateSince: now - 1000,
        stateSinceBasis: 'event',
      },
      notices: [],
    };
    store.publish(
      {
        commit,
        previousCommitSeq: 0,
        boundary: witnessObservationBoundary(commit.checkpoint, commit.summary, checkpointBoundary(commit.checkpoint)),
      },
      store.acquire(ref, 'synthetic-statusline-fixture')
    );
    return commit;
  };
  return { ...f, intent: f.input, env, input, parent, sourceRoot, read, store, publish };
}

function bytes(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, item.name);
      if (item.isDirectory()) walk(file);
      else if (!file.endsWith('-shm')) files.set(file, fs.readFileSync(file).toString('base64'));
    }
  };
  walk(root);
  return files;
}

test('statusline identity needs explicit canonical source and exact root/thread tuple', async (t) => {
  const f = await fixture(t);
  assert.equal(statuslineRef(f.input, undefined), null);
  assert.equal(statuslineRef(f.input, 'relative'), null);
  assert.equal(statuslineRef({ session_id: 1 }, f.sourceRoot), null);
  assert.deepEqual(statuslineRef(f.input, f.sourceRoot)?.ref, f.parent);
  const wrong = await readStatuslineSummary({ ...f.input, agent_id: 'native-thread' }, f.env, undefined, {
    clock: () => 0,
  });
  assert.equal(wrong.reason, 'identity_unavailable');
  const noSource = await readStatuslineSummary(f.input, { HOME: f.root, HUD_HOME: f.root }, undefined, {
    clock: () => 0,
  });
  assert.equal(noSource.reason, 'identity_unavailable');
});

test('committed projection is read-only, partial and independent of transcript/recovery bodies', async (t) => {
  const f = await fixture(t);
  const now = Date.now();
  f.publish(now);
  const mutation = new DatabaseSync(f.store.databasePath);
  mutation.exec("UPDATE checkpoint_blobs SET body='INVALID_RECOVERY_MUST_NOT_DECODE'");
  mutation.close();
  const before = bytes(f.root);
  const summary = await f.read(now);
  assert.equal(summary.state, 'partial');
  assert.equal(summary.source, 'parent_index');
  assert.equal(summary.treeCounts, null);
  assert.equal(summary.children.length, 1);
  assert.equal(summary.children[0].status?.activity, 'working');
  assert.equal(summary.children[0].stamp?.runId, 'run-a');
  assert.equal(summary.children[0].coverage?.state, 'complete');
  assert.match(renderStatuslineSummary(summary, 100, now)!, /partial.*Synthetic review/);
  assert.deepEqual(bytes(f.root), before, 'no persistent file changes; SQLite SHM read locks excluded');
});

test('missing, old, future and oversized projections never invent current activity', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.read()).children[0].status, null);
  const now = Date.now();
  f.publish(now);
  for (const at of [now - 1, now + 5001]) {
    const summary = await f.read(at);
    assert.equal(summary.children[0].status, null);
    assert.match(renderStatuslineSummary(summary, 100, at)!, /not loaded/);
  }
  const db = new DatabaseSync(f.store.databasePath);
  db.prepare('UPDATE observation_current SET projection_body=?').run(' '.repeat(32769));
  db.close();
  assert.equal((await f.read(now)).children[0].status, null);
  assert.throws(() => f.store.readProjection(f.child.ref, 0), /invalid_projection_budget/);
});

test('later ledger sequence and revoked exact binding invalidate observation', async (t) => {
  const f = await fixture(t);
  const now = Date.now();
  f.publish(now);
  await f.ledger.transaction((tx) => tx.run("INSERT INTO events(kind,payload,at) VALUES('synthetic','{}',?)", now));
  assert.equal((await f.read(now)).children[0].status, null);
  await f.ledger.transaction((tx) => tx.run('UPDATE child_bindings SET is_current=0,revoked_at=?', now));
  assert.equal((await f.read(now)).children[0].status, null);
});

test('one indexed parent page is capped at fifty with no tree totals or descendants', async (t) => {
  const f = await fixture(t);
  await f.ledger.transaction((tx) => {
    for (let i = 0; i < 65; i++)
      insertRecord(tx, 'links', { ...f.intent.link, linkId: `synthetic-page-${i}`, parentRef: f.parent });
    insertRecord(tx, 'links', { ...f.intent.link, linkId: 'synthetic-descendant', parentRef: f.child.ref });
  });
  const summary = await f.read();
  assert.equal(summary.children.length, 50);
  assert.equal(summary.limitReached, true);
  assert.equal(summary.treeCounts, null);
  assert.ok(!summary.children.some((c) => c.key === 'synthetic-descendant'));
  assert.match(renderStatuslineSummary(summary, 80, Date.now())!, /partial \(limit\)/);
  const smaller = await f.read(Date.now(), { maxChildren: 3 });
  assert.equal(smaller.children.length, 3);
  assert.equal(smaller.limitReached, true);
});

test('historical rows consume candidate budget rather than an unbounded filtered scan', async (t) => {
  const f = await fixture(t);
  await f.ledger.transaction((tx) => {
    for (let i = 0; i < 50; i++)
      insertRecord(tx, 'links', { ...f.intent.link, linkId: `history-${i}`, parentRef: f.parent, state: 'revoked' });
    insertRecord(tx, 'links', { ...f.intent.link, linkId: 'beyond-first-page', parentRef: f.parent });
  });
  const summary = await f.read();
  assert.equal(summary.children.length, 1);
  assert.equal(summary.limitReached, true);
  assert.ok(!summary.children.some((c) => c.key === 'beyond-first-page'));
});

test('unsafe private paths and unavailable ledger leave first-line fallback possible', async (t) => {
  const f = await fixture(t);
  fs.chmodSync(join(f.root, 'ledger.sqlite'), 0o644);
  assert.equal((await f.read()).state, 'unavailable');
  fs.chmodSync(join(f.root, 'ledger.sqlite'), 0o600);
  f.publish();
  fs.chmodSync(f.store.databasePath, 0o644);
  const summary = await f.read();
  assert.equal(summary.state, 'partial');
  assert.equal(summary.children[0].status, null);
  fs.chmodSync(f.store.databasePath, 0o600);
});

test('budget includes close and close failure cannot escape the read-only reader', async (t) => {
  const f = await fixture(t);
  f.publish();
  let clock = 0;
  const original = ObservationStore.prototype.close;
  t.after(() => {
    ObservationStore.prototype.close = original;
  });
  ObservationStore.prototype.close = function () {
    original.call(this);
    clock = 21;
  };
  const timed = await f.read(Date.now(), { clock: () => clock });
  assert.equal(timed.state, 'unavailable');
  assert.equal(timed.reason, 'budget_exceeded');
  assert.equal(timed.elapsedMs, 21);
  ObservationStore.prototype.close = function () {
    original.call(this);
    throw new Error('synthetic close failure');
  };
  assert.equal((await f.read()).state, 'unavailable');
  ObservationStore.prototype.close = original;
  assert.equal((await f.read(Date.now(), { budgetMs: 0 })).state, 'unavailable');
});

test('render is bounded, terminal-safe and never supplies capacity or tree totals', async (t) => {
  const f = await fixture(t);
  const now = Date.now();
  f.publish(now);
  const summary = await f.read(now);
  summary.children[0].label = '\x1b]52;c;PRIVATE\x07\n\u202e\u2028';
  for (let width = 1; width <= 200; width++) {
    const line = renderStatuslineSummary(summary, width, now);
    if (line === null) continue;
    assert.ok(visualLength(line) <= width);
    assert.match(line, /partial/);
    assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/);
    assert.doesNotMatch(line, /total|capacity|\/\d/);
  }
  const ended = structuredClone(summary);
  ended.children[0].run!.state = 'ended';
  ended.children[0].run!.endedAt = now;
  ended.children[0].status = null;
  assert.equal(renderStatuslineSummary(ended, 100, now), null, 'normal endings quietly leave the active line');
  assert.equal(renderStatuslineSummary({ ...summary, state: 'unavailable' }, 100, now), null);
});

test('actual hud-statusline and hud statusline render line 2 without settings or transcript reads', async (t) => {
  const f = await fixture(t);
  f.publish();
  for (const argv of [[resolve('bin/hud-statusline')], [resolve('bin/hud'), 'statusline']]) {
    const result = spawnSync(process.execPath, [...argv, '--width', '120'], {
      input: JSON.stringify(f.input),
      env: f.env,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines[0], 'Stdin model · ctx 42% · $0.12');
    assert.match(lines[1] ?? '', /partial.*Synthetic review/);
    assert.equal(result.stderr, '');
  }
  assert.equal(fs.existsSync(join(f.sourceRoot, 'settings.json')), false);
  const fallback = spawnSync(process.execPath, [resolve('bin/hud-statusline')], {
    input: JSON.stringify(f.input),
    env: { HOME: f.root, HUD_HOME: f.root },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(fallback.status, 0);
  assert.equal(fallback.stdout, 'Stdin model · ctx 42% · $0.12\n');
  const explicit = spawnSync(process.execPath, [resolve('bin/hud-statusline'), '--source', f.sourceRoot], {
    input: JSON.stringify(f.input),
    env: { HOME: f.root, HUD_HOME: f.root },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.match(explicit.stdout, /\n.*partial/);
});

test('projection byte charge includes stored whitespace and malformed JSON before decode', async (t) => {
  const f = await fixture(t);
  f.publish();
  const db = new DatabaseSync(f.store.databasePath);
  t.after(() => db.close());
  const raw = String(db.prepare('SELECT projection_body FROM observation_current').get()!.projection_body);
  const padded = raw + ' '.repeat(5000);
  db.prepare('UPDATE observation_current SET projection_body=?').run(padded);
  let charged = 0;
  assert.ok(
    f.store.readProjection(f.child.ref, 32768, (bytes) => {
      charged += bytes;
    })
  );
  assert.equal(charged, Buffer.byteLength(padded));
  charged = 0;
  assert.equal(
    f.store.readProjection(f.child.ref, 10, (bytes) => {
      charged += bytes;
    }),
    null
  );
  assert.equal(charged, 0, 'oversized body is never returned or decoded');
  db.exec("UPDATE observation_current SET projection_body='invalid'");
  assert.throws(() =>
    f.store.readProjection(f.child.ref, 32768, (bytes) => {
      charged += bytes;
    })
  );
  assert.equal(charged, 7);
});
