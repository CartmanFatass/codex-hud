import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsMutable from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSubagentTree, buildSubagentTreeYielding, flushTreeScans, resetSubagentLinkCache, useTreeScanStore } from '../../src/collectors/subagent-tree.js';
import { TreeScanStore, SCAN_VERSION } from '../../src/collectors/tree-scan-store.js';
import type { SessionFile } from '../../src/collectors/session-finder.js';

const now = Date.parse('2026-10-25T12:00:00Z');
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const event = (type: string, payload: Record<string, unknown> = {}) => line({ timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type, ...payload } });
const meta = (id: string, parent_thread_id?: string) => line({ type: 'session_meta', payload: { id, parent_thread_id, agent_path: `/root/${id}` } });
const filler = line({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'x'.repeat(1000) } }).repeat(10_000);

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-adaptive-scan-'));
  resetSubagentLinkCache();
  useTreeScanStore(undefined);
  t.after(() => { useTreeScanStore(undefined); resetSubagentLinkCache(); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'child.jsonl');
  const root = path.join(dir, 'root.jsonl');
  const unicode = '多字节🙂'.repeat(30_000);
  fs.writeFileSync(root, meta('root')
    + line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Please check parser bytes.' }] } })
    + event('item_completed', { item: { type: 'SubAgentActivity', kind: 'started', agent_thread_id: 'child' } }));
  const completed = meta('child', 'root') + event('task_started', { turn_id: 'first' }) + filler
    + '\nmalformed JSON\n'
    + line({ type: 'turn_context', payload: { model: 'unicode-first', effort: '超高🙂', padding: unicode } })
    + line({ type: 'turn_context', payload: { model: 'test-model' } })
    + event('task_complete', { turn_id: 'first', last_agent_message: 'Unicode résumé 多字节🙂 accepted.' });
  const partial = event('task_started', { turn_id: 'second' });
  fs.writeFileSync(file, completed + partial.slice(0, -9));
  const listed = (): SessionFile[] => [root, file].map(filePath => {
    const stat = fs.statSync(filePath);
    return { path: filePath, sessionId: filePath === root ? 'root' : 'child', timestamp: new Date(now), size: stat.size, modifiedAt: stat.mtime, ino: stat.ino };
  });
  return { dir, file, root, listed, completedBytes: Buffer.byteLength(completed), partial };
}

/** Inject a writer only after this rollout's scan has consumed an old prefix. */
function changeDuringScan(t: { after: (fn: () => void) => void }, file: string, change: () => void, duringVerification?: () => void): () => boolean {
  const identity = fs.statSync(file);
  const read = fsMutable.readSync;
  let queued = false;
  let changed = false;
  let verificationQueued = false;
  fsMutable.readSync = ((...args: unknown[]) => {
    const bytes = Reflect.apply(read, fsMutable, args) as number;
    if (!queued && typeof args[4] === 'number' && args[4] >= 64 * 1024) {
      const stat = fs.fstatSync(args[0] as number);
      if (stat.ino === identity.ino && stat.dev === identity.dev) {
        queued = true;
        setImmediate(() => { change(); changed = true; });
      }
    }
    if (changed && !verificationQueued && duringVerification && args[4] === 0) {
      const stat = fs.fstatSync(args[0] as number);
      if (stat.ino === identity.ino && stat.dev === identity.dev) {
        verificationQueued = true;
        setImmediate(duringVerification);
      }
    }
    return bytes;
  }) as typeof fsMutable.readSync;
  syncBuiltinESMExports();
  t.after(() => { fsMutable.readSync = read; syncBuiltinESMExports(); });
  return () => changed;
}

/** Change the file between its first-line peek and the scan's descriptor open. */
function changeBeforeScan(t: { after: (fn: () => void) => void }, file: string, change: () => void): () => boolean {
  const open = fsMutable.openSync;
  let reads = 0;
  let changed = false;
  fsMutable.openSync = ((...args: unknown[]) => {
    if (args[0] === file && args[1] === 'r' && ++reads === 2) {
      change();
      changed = true;
    }
    return Reflect.apply(open, fsMutable, args) as number;
  }) as typeof fsMutable.openSync;
  syncBuiltinESMExports();
  t.after(() => { fsMutable.openSync = open; syncBuiltinESMExports(); });
  return () => changed;
}

test('within-file yielding preserves tree, ledger, saved bytes, unicode and partial-record resume', async (t) => {
  const s = fixture(t);
  const syncStore = new TreeScanStore(path.join(s.dir, 'sync'));
  useTreeScanStore(syncStore);
  const expected = buildSubagentTree('root', [], 3, now, s.listed());
  flushTreeScans();
  const expectedScan = syncStore.load(s.file)!;
  assert.equal(expectedScan.version, SCAN_VERSION);
  assert.equal(expectedScan.offset, s.completedBytes);
  assert.equal(expected.nodes[0].status, 'completed');
  assert.equal(expected.nodes[0].charge, 'Please check parser bytes.');
  assert.equal(expected.nodes[0].stageCount, 1);
  assert.equal(expected.nodes[0].model, 'test-model');
  assert.equal(expected.nodes[0].effort, '超高🙂');
  assert.equal(expected.nodes[0].stages?.[0].result, 'Unicode résumé 多字节🙂 accepted.');
  resetSubagentLinkCache();
  const asyncStore = new TreeScanStore(path.join(s.dir, 'async'));
  useTreeScanStore(asyncStore);
  let inputServiced = false;
  const input = new Promise<void>(resolve => setImmediate(() => { inputServiced = true; resolve(); }));
  const actual = await buildSubagentTreeYielding('root', [], 3, now, s.listed());
  assert.equal(inputServiced, true, 'queued input runs before this single large rollout finishes');
  await input;
  flushTreeScans();
  assert.deepEqual(actual, expected);
  assert.deepEqual(asyncStore.load(s.file), expectedScan);
  fs.appendFileSync(s.file, s.partial.slice(-9));
  const resumed = await buildSubagentTreeYielding('root', [], 3, now + 100, s.listed());
  assert.equal(resumed.nodes[0].status, 'running');
  assert.equal(resumed.nodes[0].stageCount, 2);
  assert.equal(actual.nodes[0].stageCount, 1, 'published trees remain snapshots');
  assert.equal(actual.nodes[0].stages?.[0].status, 'done');
  flushTreeScans();
  resetSubagentLinkCache();
  useTreeScanStore(new TreeScanStore(path.join(s.dir, 'async')));
  assert.deepEqual(await buildSubagentTreeYielding('root', [], 3, now + 100, s.listed()), resumed, 'saved-cache restart preserves the resumed state');
});

test('an append during a yield is deferred to the next observed snapshot', async (t) => {
  const s = fixture(t);
  const listed = s.listed();
  const append = new Promise<void>(resolve => setImmediate(() => { fs.appendFileSync(s.file, s.partial.slice(-9)); resolve(); }));
  const before = await buildSubagentTreeYielding('root', [], 3, now, listed);
  await append;
  assert.equal(before.nodes[0].status, 'completed');
  const after = await buildSubagentTreeYielding('root', [], 3, now + 100, s.listed());
  assert.equal(after.nodes[0].status, 'running');
  assert.equal(after.nodes[0].stageCount, 2);
});

test('replacement while scanning is rejected without publishing a mixed ledger and recovers on next collection', async (t) => {
  const s = fixture(t);
  const replacement = path.join(s.dir, 'replacement.jsonl');
  fs.writeFileSync(replacement, meta('child', 'root') + event('task_complete', { last_agent_message: 'Replacement only.' }));
  const replace = new Promise<void>(resolve => setImmediate(() => { fs.renameSync(replacement, s.file); resolve(); }));
  await assert.rejects(buildSubagentTreeYielding('root', [], 3, now, s.listed()), /Rollout changed/);
  await replace;
  const recovered = await buildSubagentTreeYielding('root', [], 3, now + 100, s.listed());
  assert.equal(recovered.nodes[0].stageCount, 1);
  assert.equal(recovered.nodes[0].stages?.[0].result, 'Replacement only.');
});

test('in-place truncation during a yield discards the staged scan and retries from the new source', async (t) => {
  const s = fixture(t);
  const truncate = new Promise<void>(resolve => setImmediate(() => {
    fs.writeFileSync(s.file, meta('child', 'root') + event('task_started', { turn_id: 'replacement' }));
    resolve();
  }));
  await assert.rejects(buildSubagentTreeYielding('root', [], 3, now, s.listed()), /Rollout changed/);
  await truncate;
  const recovered = await buildSubagentTreeYielding('root', [], 3, now + 100, s.listed());
  assert.equal(recovered.nodes[0].status, 'running');
  assert.equal(recovered.nodes[0].stageCount, 1);
  assert.equal(recovered.nodes[0].stages?.[0].turnId, 'replacement');
});

test('a same-sized rewrite after listing is rejected before mixing source versions', async (t) => {
  const s = fixture(t);
  const stale = s.listed();
  const bytes = fs.readFileSync(s.file);
  fs.writeFileSync(s.file, bytes);
  // The listing stores a Date, while fs also exposes fractional mtimeMs.
  // Compare Date precision consistently and reject an actual observed change.
  fs.utimesSync(s.file, new Date(now), new Date(now));
  await assert.rejects(buildSubagentTreeYielding('root', [], 3, now, stale), /Rollout changed before/);
  assert.equal((await buildSubagentTreeYielding('root', [], 3, now + 100, s.listed())).nodes[0].stageCount, 1);
});

test('a same-inode truncate-and-regrow past the snapshot during yielding cannot publish mixed generations', async (t) => {
  const s = fixture(t);
  const before = fs.statSync(s.file);
  const regenerated = meta('child', 'root') + event('task_started', { turn_id: 'newer' }) + filler + filler
    + event('task_complete', { turn_id: 'newer', last_agent_message: 'Only the regenerated turn.' });
  const changed = changeDuringScan(t, s.file, () => fs.writeFileSync(s.file, regenerated));
  await assert.rejects(buildSubagentTreeYielding('root', [], 3, now, s.listed()), /Rollout changed/);
  assert.equal(changed(), true);
  assert.equal(fs.statSync(s.file).ino, before.ino);
  assert.ok(fs.statSync(s.file).size > before.size);
  const recovered = await buildSubagentTreeYielding('root', [], 3, now + 100, s.listed());
  assert.equal(recovered.nodes[0].stageCount, 1);
  assert.equal(recovered.nodes[0].stages?.[0].turnId, 'newer');
  assert.equal(recovered.nodes[0].stages?.[0].result, 'Only the regenerated turn.');
});

test('growth between metadata peek and scan still accepts an unchanged snapshot prefix', async (t) => {
  const s = fixture(t);
  const changed = changeBeforeScan(t, s.file, () => fs.appendFileSync(s.file, s.partial.slice(-9)));
  const snapshot = await buildSubagentTreeYielding('root', [], 3, now, s.listed());
  assert.equal(changed(), true);
  assert.equal(snapshot.nodes[0].status, 'completed');
  const next = await buildSubagentTreeYielding('root', [], 3, now + 100, s.listed());
  assert.equal(next.nodes[0].status, 'running');
  assert.equal(next.nodes[0].stageCount, 2);
});

test('larger same-inode regeneration before scanning cannot combine stale metadata with new events', async (t) => {
  const s = fixture(t);
  const before = fs.statSync(s.file);
  const regenerated = meta('changed-id', 'root') + event('task_started', { turn_id: 'newer' }) + filler + filler;
  const changed = changeBeforeScan(t, s.file, () => fs.writeFileSync(s.file, regenerated));
  await assert.rejects(buildSubagentTreeYielding('root', [], 3, now, s.listed()), /Rollout changed/);
  assert.equal(changed(), true);
  assert.equal(fs.statSync(s.file).ino, before.ino);
  assert.ok(fs.statSync(s.file).size > before.size);
  const recovered = await buildSubagentTreeYielding('root', [], 3, now + 100, s.listed());
  assert.equal(recovered.nodes[0].id, 'changed-id');
  assert.equal(recovered.nodes[0].stageCount, 1);
  assert.equal(recovered.nodes[0].stages?.[0].turnId, 'newer');
});

test('a second write during cooperative prefix verification is uncertain and retries from a fresh listing', async (t) => {
  const s = fixture(t);
  let wroteDuringVerification = false;
  changeDuringScan(t, s.file,
    () => fs.appendFileSync(s.file, s.partial.slice(-9)),
    () => { fs.appendFileSync(s.file, event('task_complete', { turn_id: 'second' })); wroteDuringVerification = true; });
  await assert.rejects(buildSubagentTreeYielding('root', [], 3, now, s.listed()), /Rollout changed/);
  assert.equal(wroteDuringVerification, true);
  const recovered = await buildSubagentTreeYielding('root', [], 3, now + 100, s.listed());
  assert.equal(recovered.nodes[0].stageCount, 2);
  assert.equal(recovered.nodes[0].status, 'completed');
});
