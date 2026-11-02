import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeteredCodexTopology } from '../../src/core/link/native-topology.js';
import { makeSourceId } from '../../src/core/identity.js';
import { RolloutParser } from '../../src/collectors/rollout.js';
import type { SessionRef } from '../../src/core/types/identity.js';
function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'hud-b10a-topology-'));
  const dir = join(root, 'sessions');
  mkdirSync(dir);
  const catalog = new MeteredCodexTopology(root);
  t.after(() => {
    catalog.close();
    rmSync(root, { recursive: true, force: true });
  });
  const ref: SessionRef = {
    harness: 'codex',
    sourceId: makeSourceId('codex', root),
    sessionId: 'synthetic-root',
    threadId: null,
  };
  return { root, dir, catalog, ref };
}
const meta = (id: string, parent?: string, extra = {}) =>
  JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-11-02T12:00:00Z',
    payload: { id, ...(parent ? { parent_thread_id: parent } : {}), ...extra },
  }) + '\n';
const budget = { maxBytes: 4 * 1024 * 1024, maxRecords: 2000, budgetMs: 20 };
async function drain(catalog: MeteredCodexTopology, ref: SessionRef) {
  let result = await catalog.collect(ref, budget);
  for (let i = 0; i < 100 && result.coverage.state === 'catching_up'; i++) result = await catalog.collect(ref, budget);
  assert.notEqual(result.coverage.state, 'catching_up');
  return result;
}

test('B10A metered native catalog returns direct children, not grandchildren or collaboration receivers', async (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.dir, 'root.jsonl'),
    meta(f.ref.sessionId) +
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call', name: 'send_input', arguments: '{"id":"synthetic-sibling"}' },
      }) +
      '\n'
  );
  writeFileSync(join(f.dir, 'child.jsonl'), meta('synthetic-child', f.ref.sessionId));
  writeFileSync(join(f.dir, 'grandchild.jsonl'), meta('synthetic-grandchild', 'synthetic-child'));
  writeFileSync(join(f.dir, 'sibling.jsonl'), meta('synthetic-sibling', 'some-other-parent'));
  const result = await drain(f.catalog, f.ref);
  assert.deepEqual(
    result.children.map((r) => r.sessionId),
    ['synthetic-child']
  );
  assert.equal(result.coverage.state, 'complete');
  const grand = await drain(f.catalog, { ...f.ref, sessionId: 'synthetic-child' });
  assert.deepEqual(
    grand.children.map((r) => r.sessionId),
    ['synthetic-grandchild']
  );
});
test('B10A two source roots retain distinct refs for the same native IDs', async (t) => {
  const a = fixture(t),
    b = fixture(t);
  for (const f of [a, b]) writeFileSync(join(f.dir, 'child.jsonl'), meta('synthetic-child', f.ref.sessionId));
  const x = await drain(a.catalog, a.ref),
    y = await drain(b.catalog, b.ref);
  assert.equal(x.children[0].sessionId, y.children[0].sessionId);
  assert.notEqual(x.children[0].sourceId, y.children[0].sourceId);
});
test('B10A escaping symlink and malformed/oversized headers stay explicitly partial', async (t) => {
  const f = fixture(t);
  const outside = join(f.root, 'outside.jsonl');
  writeFileSync(outside, meta('escaped', f.ref.sessionId));
  symlinkSync(outside, join(f.dir, 'escape.jsonl'));
  writeFileSync(join(f.dir, 'invalid.jsonl'), 'not json\n');
  writeFileSync(
    join(f.dir, 'oversize.jsonl'),
    meta('oversize', f.ref.sessionId, { padding: 'x'.repeat(1024 * 1024 + 1) })
  );
  const result = await drain(f.catalog, f.ref);
  assert.deepEqual(result.children, []);
  assert.equal(result.coverage.state, 'partial');
  assert.ok(result.coverage.gaps.includes('native_symlink_skipped'));
  assert.ok(result.coverage.gaps.includes('native_header_unavailable'));
});
test('B10A incomplete enumeration and header replacement retain progress and never invent completeness', async (t) => {
  const f = fixture(t);
  const file = join(f.dir, 'header.jsonl');
  writeFileSync(file, meta('old-child', f.ref.sessionId, { padding: 'x'.repeat(200000) }));
  const first = await f.catalog.collect(f.ref, { maxBytes: 128, maxRecords: 1, budgetMs: 20 });
  assert.equal(first.coverage.state, 'catching_up');
  assert.ok(first.bytesRead <= 128);
  writeFileSync(join(f.dir, 'replacement'), meta('new-child', f.ref.sessionId));
  renameSync(join(f.dir, 'replacement'), file);
  const result = await drain(f.catalog, f.ref);
  assert.deepEqual(
    result.children.map((r) => r.sessionId),
    ['new-child']
  );
  rmSync(file);
  const after = await drain(f.catalog, f.ref);
  assert.deepEqual(after.children, []);
});

test('B10A truncation, malformed rewrite and oversized rewrite revoke native identity', async (t) => {
  for (const replacement of [
    '',
    'invalid json\n',
    meta('oversized', 'synthetic-root', { padding: 'x'.repeat(1024 * 1024 + 100) }),
  ]) {
    const f = fixture(t),
      file = join(f.dir, 'child.jsonl');
    writeFileSync(file, meta('synthetic-child', f.ref.sessionId));
    assert.equal((await drain(f.catalog, f.ref)).children.length, 1);
    if (replacement.length > 1024 * 1024) {
      writeFileSync(file + '.new', replacement);
      renameSync(file + '.new', file);
    } else writeFileSync(file, replacement);
    const result = await drain(f.catalog, f.ref);
    assert.deepEqual(result.children, []);
    assert.equal(f.catalog.file({ ...f.ref, sessionId: 'synthetic-child' }), null);
    assert.equal(result.coverage.state, 'partial');
  }
});

test('B10A header rewrite across a production-parser await cannot stamp the previous identity', async (t) => {
  const f = fixture(t),
    file = join(f.dir, 'child.jsonl');
  writeFileSync(file, meta('old-child', f.ref.sessionId));
  const original = RolloutParser.prototype.parse;
  let replaced = false;
  t.mock.method(
    RolloutParser.prototype,
    'parse',
    async function (this: RolloutParser, ...args: Parameters<typeof original>) {
      const result = await original.apply(this, args);
      if (!replaced) {
        replaced = true;
        writeFileSync(file, meta('new-child', f.ref.sessionId));
      }
      return result;
    }
  );
  const result = await drain(f.catalog, f.ref);
  assert.deepEqual(
    result.children.map((r) => r.sessionId),
    ['new-child']
  );
  assert.equal(f.catalog.file({ ...f.ref, sessionId: 'old-child' }), null);
});
