import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bindPi, PiTranscriptFiles, type PiBindContext } from '../../src/harness/pi/binding.js';
import { PiAdapter } from '../../src/harness/pi/index.js';
import { makeSourceId } from '../../src/core/identity.js';
import type { SessionRef } from '../../src/core/types/identity.js';
import type { LaunchProfile } from '../../src/core/types/capabilities.js';
const stamp = { pid: 12345, proc_start: '101', boot_id: 'synthetic-boot', pid_domain: 'synthetic-domain' };
function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-binding-'));
  const root = path.join(directory, 'sessions');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourceId = makeSourceId('pi', root);
  const ref: SessionRef = { harness: 'pi', sourceId, sessionId: 'session1', threadId: null };
  const file = path.join(root, '2026_session1.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session', id: 'session1' }) + '\n');
  const files = new PiTranscriptFiles(root, sourceId);
  const context: PiBindContext = {
    sourceId,
    explicitSession: null,
    registry: [],
    locator: null,
    processes: [stamp],
    cwd: root,
    startedAt: 0,
    commandlines: [{ process: stamp, argv: ['pi', '--session-dir', root, '--session-id', 'session1'] }],
  };
  return { directory, root, ref, file, files, context };
}
test('pi binding verifies exact current cmdline and header, preserving source and null managed authority', (t) => {
  const f = fixture(t);
  const binding = bindPi(f.context, f.files);
  assert.deepEqual(binding?.sessionRef, f.ref);
  assert.deepEqual(binding?.harness, stamp);
  assert.equal(binding?.managed, null);
  const byPath = bindPi(
    { ...f.context, commandlines: [{ process: stamp, argv: ['pi', '--session', f.file] }] },
    f.files
  );
  assert.deepEqual(byPath?.sessionRef, f.ref);
});
test('pi role, directory, orchestrator and cwd never identify a session on their own', (t) => {
  const f = fixture(t);
  assert.equal(
    bindPi(
      {
        ...f.context,
        commandlines: [
          { process: stamp, argv: ['pi', '--session-dir', f.root, '--role', 'reviewer', '--orchestrator', 'session1'] },
        ],
      },
      f.files
    ),
    null
  );
  assert.equal(bindPi({ ...f.context, commandlines: [] }, f.files), null);
});
test('pi reused PID, duplicate switches, mismatched IDs and another source fail closed', (t) => {
  const f = fixture(t);
  assert.equal(bindPi({ ...f.context, processes: [{ ...stamp, proc_start: '102' }] }, f.files), null);
  assert.equal(
    bindPi(
      {
        ...f.context,
        commandlines: [{ process: stamp, argv: ['pi', '--session-id', 'session1', '--session-id', 'session2'] }],
      },
      f.files
    ),
    null
  );
  assert.equal(
    bindPi(
      {
        ...f.context,
        commandlines: [{ process: stamp, argv: ['pi', '--session', f.file, '--session-id', 'session2'] }],
      },
      f.files
    ),
    null
  );
  assert.equal(bindPi({ ...f.context, explicitSession: { ...f.ref, sourceId: 'b'.repeat(64) } }, f.files), null);
});
test('pi filename is insufficient; symlink escapes and duplicate ID paths never bind', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, JSON.stringify({ type: 'session', id: 'fork' }) + '\n');
  assert.equal(bindPi(f.context, f.files), null);
  fs.unlinkSync(f.file);
  const outside = path.join(f.directory, 'outside.jsonl');
  fs.writeFileSync(outside, JSON.stringify({ type: 'session', id: 'session1' }) + '\n');
  fs.symlinkSync(outside, f.file);
  assert.equal(bindPi(f.context, new PiTranscriptFiles(f.root, f.ref.sourceId)), null);
  fs.unlinkSync(f.file);
  fs.writeFileSync(f.file, fs.readFileSync(outside));
  fs.writeFileSync(path.join(f.root, 'copy_session1.jsonl'), fs.readFileSync(outside));
  assert.equal(bindPi(f.context, new PiTranscriptFiles(f.root, f.ref.sourceId)), null);
});
test('pi cached binding revalidates path containment after symlink replacement', (t) => {
  const f = fixture(t);
  assert.ok(bindPi(f.context, f.files));
  const outside = path.join(f.directory, 'outside.jsonl');
  fs.writeFileSync(outside, fs.readFileSync(f.file));
  fs.unlinkSync(f.file);
  fs.symlinkSync(outside, f.file);
  assert.equal(bindPi(f.context, f.files), null);
});
test('PiAdapter uses explicit source, exposes known-empty topology and no launch/navigation capability', async (t) => {
  const f = fixture(t);
  const adapter = new PiAdapter();
  const profile = { harness: 'pi', source: { root: f.root, label: 'synthetic' } } as LaunchProfile;
  assert.equal(await adapter.resolveSource(profile, {}), f.ref.sourceId);
  assert.deepEqual(await adapter.children(f.ref), []);
  assert.equal(
    (await adapter.collectTopology(f.ref, { maxBytes: 0, maxRecords: 0, budgetMs: 0 })).coverage.state,
    'complete'
  );
  assert.deepEqual(adapter.capabilities, {});
  const result = await adapter.open(f.ref).read();
  assert.equal(result.evidence.cwd, null);
  await assert.rejects(
    adapter.resolveSource({ ...profile, source: { root: 'relative', label: 'bad' } }, {}),
    /invalid_pi_source/
  );
});
