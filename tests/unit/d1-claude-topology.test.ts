import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ClaudeAdapter } from '../../src/harness/claude/index.js';
import type { LaunchProfile } from '../../src/core/types/capabilities.js';
import type { SessionRef } from '../../src/core/types/identity.js';
import type { NativeTopologyResult, ReaderBudget } from '../../src/core/interfaces/harness-adapter.js';
import { HudDelegationCollector } from '../../src/collectors/delegation.js';
import { RecoveryIndexOverlay } from '../../src/core/checkpoint.js';
import { displayNodeKey } from '../../src/core/observation.js';
import { notifyFixture } from './b21-fixture.js';
import { draw, lineOf } from '../fixtures/b10b-s3.js';

const budget: ReaderBudget = { maxBytes: 4 * 1024 * 1024, maxRecords: 2000, budgetMs: 20 };
const SESSION = 'synthetic-root';
function message(id: string, content: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'assistant',
    sessionId: SESSION,
    uuid: id,
    timestamp: '2026-03-01T12:00:00Z',
    message: { content },
    ...extra,
  });
}
const call = (id: string, extra: Record<string, unknown> = {}) =>
  message(id, [{ type: 'tool_use', name: 'Agent', id, input: {} }], extra);
const profile = (root: string) =>
  ({
    name: 'synthetic-claude',
    harness: 'claude',
    source: { root, label: 'Synthetic Claude' },
    env: {},
    mcpServerName: 'hud',
  }) as LaunchProfile;
async function fixture(t: test.TestContext, rows = [call('call-a')]) {
  t.mock.method(performance, 'now', () => 0);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd1-claude-topology-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'projects', 'synthetic-project', SESSION, 'subagents');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(path.dirname(path.dirname(directory)), `${SESSION}.jsonl`);
  fs.writeFileSync(file, rows.join('\n') + '\n');
  const adapter = new ClaudeAdapter();
  const sourceId = await adapter.resolveSource(profile(root), {});
  const ref: SessionRef = { harness: 'claude', sourceId, sessionId: SESSION, threadId: null };
  const child = (id = 'child-a', toolUseId = 'call-a', extra: Record<string, unknown> = {}, rows?: string[]) => {
    const meta = path.join(directory, `agent-${id}.meta.json`);
    const file = path.join(directory, `agent-${id}.jsonl`);
    fs.writeFileSync(meta, JSON.stringify({ toolUseId, ...extra }));
    fs.writeFileSync(
      file,
      (rows ?? [message(`header-${id}`, 'Synthetic child', { agentId: id, isSidechain: true })]).join('\n') + '\n'
    );
    return { ref: { ...ref, threadId: id }, meta, file };
  };
  return { root, file, directory, adapter, ref, child, reader: adapter.open(ref) };
}
async function collect(f: Awaited<ReturnType<typeof fixture>>, ref = f.ref, grant = budget) {
  let result: NativeTopologyResult;
  for (let i = 0; i < 100; i++) {
    result = await f.adapter.collectTopology(ref, grant);
    assert.ok(result.bytesRead <= grant.maxBytes);
    assert.ok(result.recordsRead <= grant.maxRecords);
    if (result.coverage.state !== 'catching_up') return result;
  }
  assert.fail('topology did not finish within synthetic fixture bound');
}

test('D1 native edge requires observed Agent call, exact metadata and positively identified child', async (t) => {
  const f = await fixture(t);
  const child = f.child();
  f.child('unmatched', 'different-call');
  assert.deepEqual((await f.adapter.collectTopology(f.ref, budget)).children, []);
  const read = await f.reader.read(budget);
  assert.equal(read.nativeSlice?.agentCalls[0].callId, 'call-a');
  const result = await collect(f);
  assert.equal(result.loaded, true);
  assert.deepEqual(result.children, [child.ref]);
  assert.equal(result.coverage.state, 'complete');
  // Missing metadata.finished is not a synthetic completion signal.
  const childRead = await f.adapter.open(child.ref).read(budget);
  assert.notEqual(childRead.observation.statusProjection.isRunTerminal, true);
  const idle = await f.adapter.collectTopology(f.ref, budget);
  assert.equal(idle.bytesRead, 0);
  assert.equal(idle.recordsRead, 0);
});

test('D1 transient Agent calls are not truncated to retained activity history', async (t) => {
  const f = await fixture(
    t,
    Array.from({ length: 120 }, (_, i) => call(`call-${i}`))
  );
  const first = f.child('first', 'call-0');
  const last = f.child('last', 'call-119');
  const read = await f.reader.read(budget);
  assert.equal(read.nativeSlice?.agentCalls.length, 120);
  assert.ok(read.checkpoint.claude.facts.length <= 100);
  assert.deepEqual((await collect(f)).children, [first.ref, last.ref]);
});

test('D1 identity-less, wrong-sidechain and text lookalikes cannot authorize native edges', async (t) => {
  const f = await fixture(t, [
    call('missing', { sessionId: undefined }),
    call('sidechain', { isSidechain: true }),
    message('text', 'Agent call text'),
    call('other', { sessionId: 'other-session' }),
  ]);
  for (const id of ['missing', 'sidechain', 'text', 'other']) f.child(id, id);
  assert.deepEqual((await f.reader.read(budget)).nativeSlice?.agentCalls, []);
  assert.deepEqual((await collect(f)).children, []);
});

test('D1 malformed metadata and child identity mismatches do not become native children', async (t) => {
  const f = await fixture(
    t,
    ['bad-meta', 'bad-header', 'missing-header', 'valid'].map((id) => call(id))
  );
  f.child('bad-meta', 'bad-meta', { sessionId: 'other-session' });
  f.child('bad-header', 'bad-header', {}, [message('bad', 'Synthetic', { agentId: 'other-child' })]);
  f.child('missing-header', 'missing-header', {}, [message('missing', 'Synthetic', { sessionId: undefined })]);
  const valid = f.child('valid', 'valid');
  await f.reader.read(budget);
  const result = await collect(f);
  assert.deepEqual(result.children, [valid.ref]);
  assert.equal(result.coverage.state, 'partial');
});

test('D1 duplicate metadata ownership is ambiguous rather than two confirmed edges', async (t) => {
  const f = await fixture(t);
  f.child('first');
  f.child('second');
  await f.reader.read(budget);
  const result = await collect(f);
  assert.deepEqual(result.children, []);
  assert.ok(result.coverage.gaps.includes('ambiguous_native_call'));
});

test('D1 bounded metadata and header slices charge actual reads and zero grant does no I/O', async (t) => {
  const f = await fixture(t);
  const child = f.child();
  await f.reader.read(budget);
  const zero = await f.adapter.collectTopology(f.ref, { maxBytes: 0, maxRecords: 0, budgetMs: 0 });
  assert.equal(zero.bytesRead, 0);
  assert.equal(zero.recordsRead, 0);
  assert.equal(zero.loaded, false);
  assert.deepEqual((await collect(f, f.ref, { ...budget, maxBytes: 64, maxRecords: 1 })).children, [child.ref]);
});

test('D1 restored mid-file checkpoint does not claim complete old native history', async (t) => {
  const f = await fixture(t);
  f.child();
  const checkpoint = (await f.reader.read(budget)).checkpoint;
  const fresh = new ClaudeAdapter();
  await fresh.resolveSource(profile(f.root), {});
  await fresh.open(f.ref, checkpoint).read(budget);
  const result = await fresh.collectTopology(f.ref, budget);
  assert.equal(result.loaded, false);
  assert.deepEqual(result.children, []);
  assert.ok(result.coverage.gaps.includes('native_parent_history_unconfirmed'));
});

test('D1 nested parents share the session but authorize only their own call IDs', async (t) => {
  const f = await fixture(t);
  const first = f.child('first', 'call-a', {}, [call('nested-call', { agentId: 'first', isSidechain: true })]);
  const nested = f.child('nested', 'nested-call');
  await f.reader.read(budget);
  assert.deepEqual((await collect(f)).children, [first.ref]);
  await f.adapter.open(first.ref).read(budget);
  assert.deepEqual((await collect(f, first.ref)).children, [nested.ref]);
});

test('D1 topology notices metadata changes and drops physically replaced parent authority', async (t) => {
  const f = await fixture(t);
  const child = f.child();
  await f.reader.read(budget);
  assert.deepEqual((await collect(f)).children, [child.ref]);
  fs.writeFileSync(child.meta, JSON.stringify({ toolUseId: 'other-call' }));
  assert.deepEqual((await collect(f)).children, []);
  fs.writeFileSync(child.meta, JSON.stringify({ toolUseId: 'call-a' }));
  assert.deepEqual((await collect(f)).children, [child.ref]);
  const replacement = `${f.file}.replacement`;
  fs.writeFileSync(replacement, message('new', 'Synthetic replacement') + '\n');
  fs.renameSync(replacement, f.file);
  assert.deepEqual((await f.adapter.collectTopology(f.ref, budget)).children, []);
  await f.reader.read(budget);
  assert.deepEqual((await collect(f)).children, []);
});

test('D1 native Claude child reaches the real collector tree and rendered agents panel', async (t) => {
  const f = await fixture(t);
  const child = f.child();
  const ledger = await notifyFixture();
  t.after(() => ledger.close());
  fs.writeFileSync(
    path.join(ledger.root, 'delegate.json'),
    JSON.stringify({ version: 1, profiles: [profile(f.root)] })
  );
  const runtime = await HudDelegationCollector.open({ HUD_HOME: ledger.root });
  assert.ok(runtime);
  t.after(() => runtime.close());
  const key = displayNodeKey({ kind: 'session', ref: child.ref });
  let view;
  for (let i = 0; i < 30; i++) {
    view = await runtime.collector.tick({ roots: [{ kind: 'session', ref: f.ref }], nowMs: Date.now() });
    if (view?.tree.nodes.some((node) => node.key === key)) break;
  }
  assert.ok(
    view?.tree.nodes.some((node) => node.key === key),
    'native child in real collected graph'
  );
  assert.ok(lineOf(draw(view, { width: 100, height: 40, showAll: true }), key) >= 0, 'native child in panel');
});

test('D1 older open readers cannot restore superseded topology authority', async (t) => {
  const f = await fixture(t);
  f.child();
  const newer = f.adapter.open(f.ref);
  await f.reader.read(budget);
  const ignored = await f.adapter.collectTopology(f.ref, budget);
  assert.equal(ignored.loaded, false);
  assert.deepEqual(ignored.children, []);
  await newer.read(budget);
  assert.equal((await collect(f)).children.length, 1);
});

test('D1 failed slice cannot leak calls parsed before a lazy index failure', async (t) => {
  const f = await fixture(t, [call('early'), call('late')]);
  f.child('early', 'early');
  const original = RecoveryIndexOverlay.prototype.get;
  const mock = t.mock.method(
    RecoveryIndexOverlay.prototype,
    'get',
    function (this: RecoveryIndexOverlay, namespace: string, key: string) {
      if (key.startsWith('late:')) throw new Error('synthetic index read failure');
      return original.call(this, namespace, key);
    }
  );
  await assert.rejects(f.reader.read(budget), /synthetic index read failure/);
  mock.mock.restore();
  const rejected = await f.adapter.collectTopology(f.ref, budget);
  assert.equal(rejected.loaded, false);
  assert.deepEqual(rejected.children, []);
  assert.equal((await f.reader.read(budget)).nativeSlice?.agentCalls.length, 2);
  assert.equal((await collect(f)).children.length, 1);
});

test('D1 failed record cannot leak a call before a caught syntax error', async (t) => {
  const f = await fixture(t);
  f.child();
  const original = RecoveryIndexOverlay.prototype.get;
  const mock = t.mock.method(
    RecoveryIndexOverlay.prototype,
    'get',
    function (this: RecoveryIndexOverlay, namespace: string, key: string) {
      if (namespace === 'claude.pendingTodoUpdates') throw new SyntaxError('synthetic malformed lazy record');
      return original.call(this, namespace, key);
    }
  );
  const result = await f.reader.read(budget);
  mock.mock.restore();
  assert.deepEqual(result.nativeSlice?.agentCalls, []);
  assert.equal(result.nativeSlice?.identityVerified, false);
  assert.deepEqual((await collect(f)).children, []);
});

test('D1 native metadata/header reads cannot escape the verified parent directory', async (t) => {
  const f = await fixture(t);
  const child = f.child();
  const other = path.join(f.root, 'projects', 'other-project');
  fs.mkdirSync(other);
  const target = path.join(other, 'agent-child-a.jsonl');
  fs.renameSync(child.file, target);
  fs.symlinkSync(target, child.file);
  await f.reader.read(budget);
  assert.deepEqual((await collect(f)).children, []);
  fs.unlinkSync(child.file);
  fs.renameSync(target, child.file);
  const alias = `${f.directory}-other`;
  fs.renameSync(f.directory, alias);
  fs.symlinkSync(alias, f.directory);
  assert.deepEqual((await collect(f)).children, []);
});

test('D1 incremental parent reads and compaction retain only verified native evidence', async (t) => {
  const compact = JSON.stringify({
    type: 'system',
    sessionId: SESSION,
    uuid: 'compact',
    subtype: 'compact_boundary',
    timestamp: '2026-03-01T12:00:01Z',
  });
  const f = await fixture(t, [call('call-a'), compact, call('call-b')]);
  const a = f.child();
  const b = f.child('child-b', 'call-b');
  const result = await f.reader.read({ ...budget, maxRecords: 1 });
  assert.equal(result.nativeSlice?.agentCalls.length, 1);
  assert.equal((await f.adapter.collectTopology(f.ref, budget)).loaded, false);
  await f.reader.read(budget);
  assert.deepEqual((await collect(f)).children, [a.ref, b.ref]);
});

test('D1 duplicate call identity across nested parents invalidates both edges and excludes self edges', async (t) => {
  const f = await fixture(t);
  const first = f.child('first', 'call-a', {}, [call('call-a', { agentId: 'first', isSidechain: true })]);
  await f.reader.read(budget);
  assert.deepEqual((await collect(f)).children, [first.ref]);
  await f.adapter.open(first.ref).read(budget);
  const nested = await collect(f, first.ref);
  assert.deepEqual(nested.children, []);
  assert.deepEqual((await collect(f)).children, []);
  assert.ok(nested.coverage.gaps.length > 0);
});

test('D1 invalidation while a child header read is awaited cannot repopulate stale children', async (t) => {
  const f = await fixture(t);
  f.child();
  await f.reader.read(budget);
  const pending = f.adapter.collectTopology(f.ref, budget);
  f.adapter.invalidateTopology(f.ref);
  const result = await pending;
  assert.equal(result.loaded, false);
  assert.deepEqual(result.children, []);
});

test('D1 same-inode rewrite hides old calls until the parent is re-observed', async (t) => {
  const f = await fixture(t);
  f.child();
  await f.reader.read(budget);
  assert.equal((await collect(f)).children.length, 1);
  fs.writeFileSync(f.file, call('call-x') + '\n');
  fs.utimesSync(f.file, new Date(), new Date(Date.now() + 1000));
  const stale = await f.adapter.collectTopology(f.ref, budget);
  assert.equal(stale.loaded, false);
  assert.deepEqual(stale.children, []);
  await f.reader.read(budget);
  assert.deepEqual((await collect(f)).children, []);
});

test('D1 retained call-ID overflow is bounded and never claims complete topology', async (t) => {
  const tools = Array.from({ length: 10001 }, (_, i) => ({
    type: 'tool_use',
    name: 'Agent',
    id: `call-${i}`,
    input: {},
  }));
  const f = await fixture(t, [message('many-calls', tools)]);
  await f.reader.read(budget);
  const result = await collect(f);
  assert.equal(result.loaded, false);
  assert.ok(result.coverage.gaps.includes('native_parent_call_limit'));
  assert.ok(result.coverage.gaps.includes('native_parent_history_unconfirmed'));
});

test('D1 directory listing yields across time slices without restarting and overflow is explicit', async (t) => {
  const f = await fixture(t);
  await f.reader.read(budget);
  let listed = 0,
    opens = 0,
    closed = 0,
    clock = 0;
  const directory = {
    readSync: () => (listed++ < 100 ? { name: `synthetic-unrelated-${listed}` } : null),
    closeSync: () => {
      closed++;
    },
  };
  const listingMock = t.mock.method(fs, 'opendirSync', () => {
    opens++;
    return directory as unknown as fs.Dir;
  });
  t.mock.method(performance, 'now', () => clock++);
  const first = await f.adapter.collectTopology(f.ref, budget);
  assert.equal(first.loaded, false);
  assert.ok(listed < 100);
  const complete = await collect(f);
  assert.equal(complete.loaded, true);
  assert.ok(complete.coverage.gaps.includes('native_call_unmatched'));
  assert.equal(opens, 1);
  assert.equal(closed, 1);
  f.adapter.invalidateTopology(f.ref);
  await f.adapter.open(f.ref).read({ ...budget, budgetMs: 1000 });
  t.mock.method(performance, 'now', () => 0);
  listingMock.mock.restore();
  t.mock.method(
    fs,
    'opendirSync',
    () =>
      ({
        readSync: () => {
          listed++;
          return { name: 'synthetic-unrelated' };
        },
        closeSync() {},
      }) as unknown as fs.Dir
  );
  listed = 0;
  const limited = await collect(f);
  assert.equal(listed, 20000);
  assert.equal(limited.loaded, false);
  assert.ok(limited.coverage.gaps.includes('native_metadata_limit'));
});

test('D1 a parent rewrite during awaited header I/O cannot publish stale native authority', async (t) => {
  const f = await fixture(t);
  f.child();
  await f.reader.read(budget);
  const pending = f.adapter.collectTopology(f.ref, budget);
  fs.writeFileSync(f.file, call('call-x') + '\n');
  fs.utimesSync(f.file, new Date(), new Date(Date.now() + 1000));
  const result = await pending;
  assert.deepEqual(result.children, []);
  assert.equal(result.loaded, false);
});

test('D1 parent rewrites during catch-up also invalidate previously observed calls', async (t) => {
  const f = await fixture(t, [call('call-a'), message('later', 'Synthetic later record')]);
  f.child();
  const read = await f.reader.read({ ...budget, maxRecords: 1 });
  assert.equal(read.observation.coverage.state, 'catching_up');
  fs.writeFileSync(f.file, [call('call-x'), message('later', 'Synthetic later record')].join('\n') + '\n');
  fs.utimesSync(f.file, new Date(), new Date(Date.now() + 1000));
  const result = await f.adapter.collectTopology(f.ref, budget);
  assert.deepEqual(result.children, []);
  assert.equal(result.loaded, false);
});

test('D1 an oversized metadata candidate can recover when repaired without a directory change', async (t) => {
  const f = await fixture(t);
  const child = f.child();
  fs.writeFileSync(child.meta, ' '.repeat(65537));
  await f.reader.read(budget);
  assert.deepEqual((await collect(f)).children, []);
  fs.writeFileSync(child.meta, JSON.stringify({ toolUseId: 'call-a' }));
  assert.deepEqual((await collect(f)).children, [child.ref]);
});
