/** Finite synthetic service/storage tests. No live accounts, providers or user homes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runDelegatedDigest, showDelegatedDigest, planDelegatedDigest,
  type DigestRetention } from '../../src/core/materials/delegated-digest.js';
import { DigestFailure, captureSource } from '../../src/core/materials/source-config.js';
import { fingerprint } from '../../src/core/materials/index.js';
import { digestFixture, deferredTransport, response, until, tick, SUMMARY, PRIVATE } from '../fixtures/delegated-digest.js';

const fetcher = (async () => response()) as typeof fetch;
const notesDir = (f: Awaited<ReturnType<typeof digestFixture>>) => join(f.dir, 'digest-notes-v1');
const notes = (f: Awaited<ReturnType<typeof digestFixture>>) => fs.existsSync(notesDir(f))
  ? fs.readdirSync(notesDir(f)).filter((p) => /^[a-f0-9]{64}\.json$/.test(p)) : [];
const unavailable = (e: unknown) => e instanceof DigestFailure && e.reason === 'digest_note_unavailable';
async function save(f: Awaited<ReturnType<typeof digestFixture>>) {
  let retention: DigestRetention | undefined;
  const document = await runDelegatedDigest(f.input, { fetch: fetcher, save: true, onRetention: (r) => { retention = r; } });
  assert.ok(retention);
  return { document, retention };
}
function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (path: string, key: string) => {
    for (const name of fs.readdirSync(path).sort()) {
      const file = join(path, name); const relative = `${key}/${name}`;
      if (fs.lstatSync(file).isDirectory()) walk(file, relative);
      else result[relative] = fingerprint(fs.readFileSync(file).toString('base64'));
    }
  };
  walk(dir, ''); return result;
}
function rehash(record: Record<string, unknown>) {
  record.outputFingerprint = fingerprint(record.document);
  const { recordFingerprint: _old, ...body } = record;
  record.recordFingerprint = fingerprint(body);
}

test('ordinary run has no note writes; explicit save and fresh show preserve the original document with zero transport or runtime writes', async () => {
  const f = await digestFixture();
  try {
    const ordinary = await runDelegatedDigest(f.input, { fetch: fetcher });
    assert.equal(fs.existsSync(notesDir(f)), false);
    assert.equal(Object.hasOwn(ordinary, 'retention'), false);
    const saved = await save(f);
    assert.equal(saved.retention.state, 'saved'); assert.equal(notes(f).length, 1);
    const file = join(notesDir(f), notes(f)[0]);
    assert.equal(fs.statSync(notesDir(f)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(file).nlink, 1); assert.ok(fs.statSync(file).size <= 256 * 1024);
    const stored = fs.readFileSync(file, 'utf8');
    assert.equal(stored.includes(SUMMARY), false); assert.equal(stored.includes('synthetic-key'), false);
    assert.equal(stored.includes(PRIVATE), false);
    const before = snapshot(join(f.dir, 'model-runtime-v1'));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('show must never fetch'); }) as typeof fetch;
    const originalOpen = fs.opendirSync;
    const originalWrite = fs.writeFileSync; const originalMkdir = fs.mkdirSync;
    fs.writeFileSync = (() => { throw new Error('show must not write'); }) as typeof fs.writeFileSync;
    fs.mkdirSync = (() => { throw new Error('show must not initialize'); }) as typeof fs.mkdirSync;
    fs.opendirSync = (() => { throw new Error('show must not enumerate notes'); }) as typeof fs.opendirSync;
    syncBuiltinESMExports();
    try {
      const reopened = await showDelegatedDigest(f.input);
      assert.deepEqual(reopened.document, saved.document);
      assert.equal(reopened.document.generatedAt, ordinary.generatedAt);
      assert.equal(reopened.label, 'model_generated');
      assert.ok(!JSON.stringify(reopened).includes(SUMMARY));
      assert.ok(!JSON.stringify(reopened).includes(f.home));
      assert.deepEqual(snapshot(join(f.dir, 'model-runtime-v1')), before);
    } finally {
      globalThis.fetch = originalFetch; fs.opendirSync = originalOpen; fs.writeFileSync = originalWrite;
      fs.mkdirSync = originalMkdir; syncBuiltinESMExports();
    }
  } finally { f.cleanup(); }
});

test('missing note is read-only unavailability, not implicit generation or storage initialization', async () => {
  const f = await digestFixture();
  try {
    await assert.rejects(showDelegatedDigest(f.input), unavailable);
    assert.equal(fs.existsSync(join(f.dir, 'model-runtime-v1')), false);
  } finally { f.cleanup(); }
});

for (const change of ['scope', 'denied', 'missing-policy', 'corrupt-policy', 'paused', 'disabled', 'off',
  'credential', 'account', 'recipient', 'unsafe-source', 'target', 'report-run'] as const) {
  test(`show checks ${change} before opening the saved generated text or reading report summary`, async () => {
    const f = await digestFixture(); const queries: string[] = [];
    let noteOpens = 0;
    const originalOpen = fs.openSync;
    try {
      await save(f);
      if (change === 'scope') f.write('model.json', { ...f.config, materials: [] });
      if (change === 'denied') f.write('outbound.json', { ...f.policy, grants: [] });
      if (change === 'missing-policy') fs.unlinkSync(join(f.dir, 'outbound.json'));
      if (change === 'corrupt-policy') fs.writeFileSync(join(f.dir, 'outbound.json'), '{bad');
      if (change === 'paused') f.write('model.json', { ...f.config, delegatedDigest: { ...f.config.delegatedDigest, paused: true } });
      if (change === 'disabled') f.write('model.json', { ...f.config, delegatedDigest: { ...f.config.delegatedDigest, enabled: false } });
      if (change === 'off') f.write('model.json', { ...f.config, connection: { backend: 'off' } });
      if (change === 'credential') delete f.env.SYNTHETIC_DIGEST_KEY;
      if (change === 'account') f.write('model.json', { ...f.config, connection: { ...f.config.connection, account: 'synthetic-new-account' } });
      if (change === 'unsafe-source') fs.chmodSync(f.dir, 0o755);
      if (change === 'target') f.db.exec("UPDATE links SET current_owner=0,state='handed_over'");
      if (change === 'report-run') { f.db.exec('PRAGMA foreign_keys=OFF'); f.db.exec("UPDATE reports SET run_id='different-run'"); }
      fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
        if (String(args[0]).includes('digest-notes-v1')) noteOpens++;
        return originalOpen(...args);
      }) as typeof fs.openSync;
      syncBuiltinESMExports();
      const input = change === 'recipient' ? { ...f.input, expectedRecipient: '0'.repeat(64) } : f.input;
      await assert.rejects(showDelegatedDigest(input, { onQuery: (q) => queries.push(q) }));
      assert.equal(noteOpens, 0);
      assert.equal(queries.some((q) => q.startsWith('SELECT summary')), false);
    } finally { fs.openSync = originalOpen; syncBuiltinESMExports(); f.cleanup(); }
  });
}

for (const change of ['model', 'language', 'revision', 'policy-revision', 'same-size-summary'] as const) {
  test(`current ${change} cannot reuse an old retained note`, async () => {
    const f = await digestFixture();
    try {
      await save(f);
      if (change === 'model') f.write('model.json', { ...f.config, connection: { ...f.config.connection, model: 'synthetic-other-model' } });
      if (change === 'language') f.write('model.json', { ...f.config, delegatedDigest: { ...f.config.delegatedDigest, language: 'zh' } });
      if (change === 'revision') f.write('model.json', { ...f.config, revision: 2 });
      if (change === 'policy-revision') f.write('outbound.json', { ...f.policy, revision: 2 });
      if (change === 'same-size-summary') f.db.prepare('UPDATE reports SET summary=?').run('X' + SUMMARY.slice(1));
      await assert.rejects(showDelegatedDigest(f.input));
    } finally { f.cleanup(); }
  });
}

test('same session/report strings in distinct source/thread/ledger identities never share notes', async () => {
  const a = await digestFixture('claude'); const b = await digestFixture('codex', 'synthetic-thread');
  try {
    const one = await save(a); const two = await save(b);
    assert.equal(one.retention.state, 'saved'); assert.equal(two.retention.state, 'saved');
    assert.notEqual(notes(a)[0], notes(b)[0]);
    assert.equal(a.ref.sessionId, b.ref.sessionId);
    const foreign = fs.readFileSync(join(notesDir(a), notes(a)[0]));
    fs.writeFileSync(join(notesDir(b), notes(b)[0]), foreign);
    await assert.rejects(showDelegatedDigest(b.input), unavailable);
    await assert.rejects(showDelegatedDigest({ ...a.input, expectedLedger: b.input.expectedLedger }));
    assert.equal((await planDelegatedDigest(a.input)).ref.sourceId, a.ref.sourceId);
    assert.equal((await planDelegatedDigest(b.input)).ref.sourceId, b.ref.sourceId);
  } finally { a.cleanup(); b.cleanup(); }
});

for (const corruption of ['schema', 'extra', 'provenance', 'text-hash', 'record-hash', 'shape', 'control', 'oversized'] as const) {
  test(`tampered ${corruption} is unavailable without exposing private text`, async () => {
    const f = await digestFixture();
    try {
      await save(f); const file = join(notesDir(f), notes(f)[0]);
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (corruption === 'schema') record.schemaVersion = 2;
      if (corruption === 'extra') record.unexpected = PRIVATE;
      if (corruption === 'provenance') record.provenance.material.fragments[0].provenance[0].origin = 'native';
      if (corruption === 'text-hash') record.document.digest.conclusion = 'Altered synthetic text.';
      if (corruption === 'record-hash') record.recordFingerprint = '0'.repeat(64);
      if (corruption === 'shape') record.document.digest.action = 'execute';
      if (corruption === 'control') record.document.digest.conclusion = '\u001b[31m';
      if (['schema', 'extra', 'provenance', 'shape', 'control'].includes(corruption)) rehash(record);
      fs.writeFileSync(file, corruption === 'oversized' ? 'x'.repeat(256 * 1024 + 1) : JSON.stringify(record));
      let delivered = false;
      await assert.rejects(showDelegatedDigest(f.input, {}, () => { delivered = true; }), unavailable);
      assert.equal(delivered, false);
    } finally { f.cleanup(); }
  });
}

for (const unsafe of ['symlink', 'hardlink', 'fifo', 'permissions', 'directory'] as const) {
  test(`unsafe note ${unsafe} refuses without following or repairing it`, async () => {
    const f = await digestFixture();
    try {
      await save(f); const file = join(notesDir(f), notes(f)[0]);
      if (unsafe === 'symlink') { fs.renameSync(file, join(f.home, 'saved')); fs.symlinkSync(join(f.home, 'saved'), file); }
      if (unsafe === 'hardlink') fs.linkSync(file, join(f.home, 'extra-link'));
      if (unsafe === 'fifo') {
        fs.unlinkSync(file);
        const result = spawnSync('mkfifo', ['-m', '600', file], { encoding: 'utf8' });
        assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
      }
      if (unsafe === 'permissions') fs.chmodSync(file, 0o644);
      if (unsafe === 'directory') { fs.unlinkSync(file); fs.mkdirSync(file, { mode: 0o700 }); }
      await assert.rejects(showDelegatedDigest(f.input), unavailable);
      if (unsafe === 'permissions') assert.equal(fs.lstatSync(file).mode & 0o777, 0o644);
    } finally { f.cleanup(); }
  });
}

test('changed inode during bounded note read is refused', async () => {
  const f = await digestFixture(); const originalOpen = fs.openSync;
  let replaced = false;
  try {
    await save(f); const file = join(notesDir(f), notes(f)[0]); const data = fs.readFileSync(file);
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      const fd = originalOpen(...args);
      if (String(args[0]) === file && !replaced) {
        replaced = true; const tmp = join(f.home, 'replacement');
        fs.writeFileSync(tmp, data, { mode: 0o600 }); fs.renameSync(tmp, file);
      }
      return fd;
    }) as typeof fs.openSync;
    syncBuiltinESMExports();
    await assert.rejects(showDelegatedDigest(f.input), unavailable); assert.equal(replaced, true);
  } finally { fs.openSync = originalOpen; syncBuiltinESMExports(); f.cleanup(); }
});

for (const cancellation of ['abort', 'timeout', 'revoke', 'source'] as const) {
  test(`late response after ${cancellation} cannot save or deliver a note`, async () => {
    const f = await digestFixture(); const transport = deferredTransport(); const controller = new AbortController();
    let delivered = 0; let receipts = 0;
    const pending = runDelegatedDigest(f.input, { fetch: transport.fetcher, save: true, signal: controller.signal,
      ...(cancellation === 'timeout' ? { deadlineMs: 500 } : {}), onRetention: () => { receipts++; } }, () => { delivered++; });
    const rejection = assert.rejects(pending);
    try {
      await until(() => transport.calls.length === 1);
      if (cancellation === 'abort') controller.abort();
      if (cancellation === 'revoke') f.write('outbound.json', { ...f.policy, revision: 2, grants: [] });
      if (cancellation === 'source') f.write('model.json', { ...f.config, revision: 2, materials: [] });
      if (cancellation === 'revoke' || cancellation === 'source') transport.calls[0].resolve(response());
      await rejection;
      transport.calls[0].resolve(response()); await tick(); await tick();
      assert.deepEqual(notes(f), []); assert.equal(receipts, 0); assert.equal(delivered, 0);
      assert.equal(transport.calls.length, 1);
    } finally { controller.abort(); transport.calls.forEach((c) => c.resolve(response())); await pending.catch(() => {}); f.cleanup(); }
  });
}

test('busy lock refuses retention, not successful generation; lock is neither stolen nor expired', async () => {
  const f = await digestFixture();
  try {
    await save(f); const lock = join(notesDir(f), '.write-lock');
    fs.writeFileSync(lock, '', { mode: 0o600 }); const inode = fs.statSync(lock).ino;
    const result = await save(f);
    assert.deepEqual(result.retention, { state: 'not_saved', reason: 'digest_note_busy' });
    assert.equal(result.document.format, 'hud-delegated-digest'); assert.equal(fs.statSync(lock).ino, inode);
    assert.equal((await showDelegatedDigest(f.input)).label, 'model_generated');
  } finally { f.cleanup(); }
});

test('200 notes permit exact replacement; new identity is refused without deleting any note', async () => {
  const f = await digestFixture();
  try {
    await save(f);
    for (let i = 1; i < 200; i++) fs.writeFileSync(join(notesDir(f), `${i.toString(16).padStart(64, '0')}.json`), '{}', { mode: 0o600 });
    const names = notes(f).sort(); assert.equal(names.length, 200);
    assert.equal((await save(f)).retention.state, 'saved');
    f.db.exec('UPDATE events SET at=101');
    assert.deepEqual((await save(f)).retention, { state: 'not_saved', reason: 'digest_note_capacity' });
    assert.deepEqual(notes(f).sort(), names);
  } finally { f.cleanup(); }
});

for (const stage of ['before-rename', 'after-rename', 'revoke-at-publish'] as const) {
  test(`atomic ${stage} interruption preserves old/new whole note or refuses invalidated publication`, async () => {
    const f = await digestFixture(); const originalRename = fs.renameSync; let interrupted = false;
    try {
      const first = await save(f); const file = join(notesDir(f), notes(f)[0]); const prior = fs.readFileSync(file);
      fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
        if (String(from).includes('/digest-notes-v1/.pending-')) {
          interrupted = true;
          if (stage === 'before-rename') throw new Error(PRIVATE);
          if (stage === 'revoke-at-publish') f.write('outbound.json', { ...f.policy, revision: 2, grants: [] });
          originalRename(from, to);
          if (stage === 'after-rename') throw new Error(PRIVATE);
          return;
        }
        originalRename(from, to);
      }) as typeof fs.renameSync;
      syncBuiltinESMExports();
      if (stage === 'revoke-at-publish') {
        await assert.rejects(save(f)); assert.deepEqual(notes(f), []);
        f.write('outbound.json', f.policy);
        await assert.rejects(showDelegatedDigest(f.input), unavailable);
      } else {
        const result = await save(f);
        assert.deepEqual(result.retention, { state: 'not_saved', reason: 'digest_note_publish_uncertain' });
        if (stage === 'before-rename') assert.deepEqual(fs.readFileSync(file), prior);
        const reopened = await showDelegatedDigest(f.input);
        assert.deepEqual(reopened.document.digest, first.document.digest);
        assert.equal(fs.existsSync(join(notesDir(f), '.write-lock')), false);
      }
      assert.equal(interrupted, true);
    } finally { fs.renameSync = originalRename; syncBuiltinESMExports(); f.cleanup(); }
  });
}

test('observed source invalidation cannot be revived by restoring policy bytes in the same invocation', async () => {
  const f = await digestFixture();
  try {
    await save(f);
    const source = captureSource(f.home, f.ref.sourceId, f.env, () => true);
    f.write('outbound.json', { ...f.policy, revision: 2, grants: [] });
    assert.equal(source.current(), false);
    f.write('outbound.json', f.policy);
    assert.equal(source.current(), false);
    // This does not claim cross-restart anti-rollback: a fresh authorized show can reopen a prior valid note.
    assert.equal((await showDelegatedDigest(f.input)).label, 'model_generated');
  } finally { f.cleanup(); }
});

test('revocation before receipt delivery invalidates the published note and cannot revive it after policy restoration', async () => {
  const f = await digestFixture(); let receipts = 0; let delivered = false;
  try {
    await assert.rejects(runDelegatedDigest(f.input, { fetch: fetcher, save: true, onRetention: (receipt) => {
      receipts++; assert.equal(receipt.state, 'saved');
      f.write('outbound.json', { ...f.policy, revision: 2, grants: [] });
    } }, () => { delivered = true; }));
    assert.equal(receipts, 1); assert.equal(delivered, false); assert.deepEqual(notes(f), []);
    f.write('outbound.json', f.policy);
    await assert.rejects(showDelegatedDigest(f.input), unavailable);
  } finally { f.cleanup(); }
});

test('show revalidates after bounded note reads and before output', async () => {
  const f = await digestFixture(); const originalOpen = fs.openSync; const originalClose = fs.closeSync;
  let noteFd = -1; let changed = false; let delivered = false;
  try {
    await save(f); const file = join(notesDir(f), notes(f)[0]);
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      const fd = originalOpen(...args); if (String(args[0]) === file) noteFd = fd; return fd;
    }) as typeof fs.openSync;
    fs.closeSync = ((fd: number) => {
      originalClose(fd);
      if (fd === noteFd && !changed) {
        changed = true; f.write('outbound.json', { ...f.policy, revision: 2, grants: [] });
      }
    }) as typeof fs.closeSync;
    syncBuiltinESMExports();
    await assert.rejects(showDelegatedDigest(f.input, {}, () => { delivered = true; }), unavailable);
    assert.equal(changed, true); assert.equal(delivered, false);
  } finally { fs.openSync = originalOpen; fs.closeSync = originalClose; syncBuiltinESMExports(); f.cleanup(); }
});

// Round 1: regressions for the independently reviewed real service composition.
for (const change of ['abort', 'timeout', 'source', 'target'] as const) {
  test(`saved guard survives deferred output and removes its own note after ${change}`, async () => {
    const f = await digestFixture(); const controller = new AbortController();
    let deliver!: () => void; const delivery = new Promise<void>((resolve) => { deliver = resolve; });
    let entered = false; let sends = 0;
    const pending = runDelegatedDigest(f.input, { save: true, signal: controller.signal,
      ...(change === 'timeout' ? { deadlineMs: 500 } : {}),
      fetch: (async () => { sends++; return response(); }) as typeof fetch }, () => { entered = true; return delivery; });
    const rejected = assert.rejects(pending);
    try {
      await until(() => entered); assert.equal(notes(f).length, 1);
      if (change === 'abort') controller.abort();
      if (change === 'source') f.write('outbound.json', { ...f.policy, revision: 2, grants: [] });
      if (change === 'target') f.db.exec('UPDATE events SET at=101');
      if (change === 'source' || change === 'target') deliver();
      await rejected;
      assert.deepEqual(notes(f), []); assert.equal(sends, 1);
      f.write('outbound.json', f.policy); f.db.exec('UPDATE events SET at=100');
      deliver(); await tick(); await tick();
      await assert.rejects(showDelegatedDigest(f.input), unavailable);
    } finally { controller.abort(); deliver(); await pending.catch(() => {}); f.cleanup(); }
  });
}

test('save settlement observes a source change during bounded telemetry cleanup', async () => {
  const { SmallModel } = await import('../../src/collectors/small-model.js');
  const f = await digestFixture(); const oldFlush = SmallModel.prototype.flushTelemetry;
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  SmallModel.prototype.flushTelemetry = async function () { entered = true; await gate; await oldFlush.call(this); };
  const pending = runDelegatedDigest(f.input, { save: true, fetch: fetcher });
  const rejected = assert.rejects(pending);
  try {
    await until(() => entered); assert.equal(notes(f).length, 1);
    f.write('model.json', { ...f.config, revision: 2, materials: [] });
    release(); await rejected;
    assert.deepEqual(notes(f), []);
    f.write('model.json', f.config); await assert.rejects(showDelegatedDigest(f.input), unavailable);
  } finally { release(); await pending.catch(() => {}); SmallModel.prototype.flushTelemetry = oldFlush; f.cleanup(); }
});

test('aborted saved output never deletes a peer replacement', async () => {
  const f = await digestFixture(); const controller = new AbortController();
  let entered = false; let deliver!: () => void;
  const pending = runDelegatedDigest(f.input, { save: true, fetch: fetcher, signal: controller.signal },
    () => { entered = true; return new Promise<void>((resolve) => { deliver = resolve; }); });
  const rejected = assert.rejects(pending, (e: unknown) => e instanceof DigestFailure && e.reason === 'digest_note_publish_uncertain_use_show');
  try {
    await until(() => entered); const file = join(notesDir(f), notes(f)[0]);
    const replacement = join(f.home, 'synthetic-peer-replacement');
    const bytes = fs.readFileSync(file); fs.writeFileSync(replacement, bytes, { mode: 0o600 });
    fs.renameSync(replacement, file); const inode = fs.statSync(file).ino;
    controller.abort(); await rejected;
    assert.equal(fs.statSync(file).ino, inode); assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal((await showDelegatedDigest(f.input)).label, 'model_generated');
  } finally { controller.abort(); deliver?.(); await pending.catch(() => {}); f.cleanup(); }
});

for (const unsafe of ['mode', 'link-count'] as const) {
  test(`opened descriptor rejects ${unsafe} changed after initial path identity, before any payload read`, async () => {
    const f = await digestFixture(); const oldStat = fs.lstatSync; const oldOpen = fs.openSync; const oldRead = fs.readSync;
    let noteStats = 0; let changed = false; let reads = 0; let delivered = false; const noteFds = new Set<number>();
    try {
      await save(f); const file = join(notesDir(f), notes(f)[0]);
      fs.lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => {
        if (String(args[0]) === file && ++noteStats === 3) {
          changed = true;
          if (unsafe === 'mode') fs.chmodSync(file, 0o644);
          else fs.linkSync(file, join(f.home, 'synthetic-second-link'));
        }
        return Reflect.apply(oldStat, fs, args);
      }) as typeof fs.lstatSync;
      fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
        const fd = oldOpen(...args); if (String(args[0]) === file) noteFds.add(fd); return fd;
      }) as typeof fs.openSync;
      fs.readSync = ((fd: number, ...rest: unknown[]) => {
        if (noteFds.has(fd)) reads++;
        return Reflect.apply(oldRead, fs, [fd, ...rest]) as number;
      }) as typeof fs.readSync;
      syncBuiltinESMExports();
      await assert.rejects(showDelegatedDigest(f.input, {}, () => { delivered = true; }), unavailable);
      assert.equal(changed, true); assert.ok(noteFds.size > 0); assert.equal(reads, 0); assert.equal(delivered, false);
    } finally { fs.lstatSync = oldStat; fs.openSync = oldOpen; fs.readSync = oldRead; syncBuiltinESMExports(); f.cleanup(); }
  });
}

for (const existing of [false, true]) {
  test(`saved receipt follows pinned note and source-parent fsync (${existing ? 'replacement' : 'first creation'})`, async () => {
    const f = await digestFixture(); const oldOpen = fs.openSync; const oldSync = fs.fsyncSync;
    const opened = new Map<number, string>(); const synced: string[] = [];
    try {
      if (existing) await save(f);
      fs.openSync = ((...args: Parameters<typeof fs.openSync>) => { const fd = oldOpen(...args); opened.set(fd, String(args[0])); return fd; }) as typeof fs.openSync;
      fs.fsyncSync = ((fd: number) => { synced.push(opened.get(fd) ?? 'other'); oldSync(fd); }) as typeof fs.fsyncSync;
      syncBuiltinESMExports();
      assert.equal((await save(f)).retention.state, 'saved');
      const fileSync = synced.findIndex((p) => p.startsWith(join(notesDir(f), '.pending-')));
      const dirSync = synced.indexOf(notesDir(f)); const parentSync = synced.indexOf(f.dir);
      assert.ok(fileSync >= 0); assert.ok(dirSync > fileSync); assert.ok(parentSync > dirSync);
      assert.equal(fs.existsSync(join(f.dir, 'model-runtime-v1', 'digest-notes-v1')), false);
    } finally { fs.openSync = oldOpen; fs.fsyncSync = oldSync; syncBuiltinESMExports(); f.cleanup(); }
  });
}

test('source-parent durability failure after rename is not_saved/publish_uncertain and exact show can read back', async () => {
  const f = await digestFixture(); const oldOpen = fs.openSync; const oldSync = fs.fsyncSync;
  const opened = new Map<number, string>(); let failed = false;
  try {
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => { const fd = oldOpen(...args); opened.set(fd, String(args[0])); return fd; }) as typeof fs.openSync;
    fs.fsyncSync = ((fd: number) => {
      if (opened.get(fd) === f.dir) { failed = true; throw new Error('synthetic fsync failure'); }
      oldSync(fd);
    }) as typeof fs.fsyncSync;
    syncBuiltinESMExports();
    const result = await save(f);
    assert.deepEqual(result.retention, { state: 'not_saved', reason: 'digest_note_publish_uncertain' });
    assert.equal(failed, true); assert.equal(notes(f).length, 1);
    assert.deepEqual((await showDelegatedDigest(f.input)).document, result.document);
  } finally { fs.openSync = oldOpen; fs.fsyncSync = oldSync; syncBuiltinESMExports(); f.cleanup(); }
});

test('populated notes are untouched by ordinary no-save runtime checks', async () => {
  const f = await digestFixture(); const oldReadDir = fs.readdirSync; const oldOpenDir = fs.opendirSync; const oldStat = fs.lstatSync;
  let noteAccess = 0;
  try {
    await save(f);
    for (let i = 1; i < 200; i++) fs.writeFileSync(join(notesDir(f), `${i.toString(16).padStart(64, '0')}.json`), '{}', { mode: 0o600 });
    const guard = (path: unknown) => {
      if (String(path).startsWith(notesDir(f))) { noteAccess++; throw new Error('ordinary run touched notes'); }
    };
    fs.readdirSync = ((...args: Parameters<typeof fs.readdirSync>) => { guard(args[0]); return Reflect.apply(oldReadDir, fs, args); }) as typeof fs.readdirSync;
    fs.opendirSync = ((...args: Parameters<typeof fs.opendirSync>) => { guard(args[0]); return Reflect.apply(oldOpenDir, fs, args); }) as typeof fs.opendirSync;
    fs.lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => { guard(args[0]); return Reflect.apply(oldStat, fs, args); }) as typeof fs.lstatSync;
    syncBuiltinESMExports();
    const result = await runDelegatedDigest(f.input, { fetch: fetcher });
    assert.equal(result.format, 'hud-delegated-digest'); assert.equal(noteAccess, 0);
  } finally { fs.readdirSync = oldReadDir; fs.opendirSync = oldOpenDir; fs.lstatSync = oldStat; syncBuiltinESMExports(); f.cleanup(); }
});

test('oversized notes directory is admitted through at most 202 iterator steps, never recursive readdir allocation', async () => {
  const f = await digestFixture(); const oldReadDir = fs.readdirSync; const oldOpenDir = fs.opendirSync;
  let reads = 0; let fullReads = 0;
  try {
    await save(f);
    for (let i = 1; i <= 250; i++) fs.writeFileSync(join(notesDir(f), `${i.toString(16).padStart(64, '0')}.json`), '{}', { mode: 0o600 });
    fs.readdirSync = ((...args: Parameters<typeof fs.readdirSync>) => {
      if (String(args[0]) === notesDir(f)) { fullReads++; throw new Error('unbounded notes allocation'); }
      return Reflect.apply(oldReadDir, fs, args);
    }) as typeof fs.readdirSync;
    fs.opendirSync = ((...args: Parameters<typeof fs.opendirSync>) => {
      const dir = Reflect.apply(oldOpenDir, fs, args) as fs.Dir;
      if (String(args[0]) === notesDir(f)) {
        const read = dir.readSync.bind(dir);
        dir.readSync = () => { reads++; return read(); };
      }
      return dir;
    }) as typeof fs.opendirSync;
    syncBuiltinESMExports();
    const result = await save(f);
    assert.deepEqual(result.retention, { state: 'not_saved', reason: 'digest_note_capacity' });
    assert.equal(fullReads, 0); assert.ok(reads > 0 && reads <= 202);
  } finally { fs.readdirSync = oldReadDir; fs.opendirSync = oldOpenDir; syncBuiltinESMExports(); assert.equal(notes(f).length, 251); f.cleanup(); }
});

// Final bounded fix: use the real compiled CLI as a cooperating peer at the exact unlink boundary.
test('cleanup holds the same writer lock across final identity comparison and unlink; a peer CLI cannot publish in that window', async () => {
  const f = await digestFixture(); const controller = new AbortController(); const oldUnlink = fs.unlinkSync;
  let entered = false; let deliver!: () => void; let peerChecked = false;
  const pending = runDelegatedDigest(f.input, { save: true, fetch: fetcher, signal: controller.signal },
    () => { entered = true; return new Promise<void>((resolve) => { deliver = resolve; }); });
  const rejected = assert.rejects(pending, (e: unknown) => e instanceof DigestFailure && e.reason === 'cancelled');
  try {
    await until(() => entered); const file = join(notesDir(f), notes(f)[0]);
    const preload = join(f.home, 'synthetic-peer-fetch.mjs');
    fs.writeFileSync(preload, `
      globalThis.fetch = async (url) => {
        if (url !== 'https://synthetic.invalid/v1/chat/completions') throw new Error('unexpected target');
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ conclusion: 'Synthetic peer result.' }) } }] }));
      };
    `, { mode: 0o600 });
    fs.unlinkSync = ((path: fs.PathLike) => {
      if (String(path) === file && !peerChecked) {
        peerChecked = true;
        // This is after A's successful leaf comparison, immediately before the actual unlink syscall.
        const peer = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, resolve('bin/hud'),
          'digest', 'run', '--run', f.input.runId, '--report', f.input.reportId,
          '--expected-ledger', f.input.expectedLedger, '--expected-recipient', f.input.expectedRecipient,
          '--save', '--json'], { env: { ...f.env, PATH: process.env.PATH }, encoding: 'utf8', timeout: 10000 });
        assert.ifError(peer.error); assert.equal(peer.status, 0, peer.stderr);
        assert.deepEqual(JSON.parse(peer.stdout).retention, { state: 'not_saved', reason: 'digest_note_busy' });
        assert.equal(fs.existsSync(join(notesDir(f), '.write-lock')), true);
      }
      oldUnlink(path);
    }) as typeof fs.unlinkSync;
    syncBuiltinESMExports();
    controller.abort(); await rejected;
    assert.equal(peerChecked, true); assert.deepEqual(notes(f), []);
    assert.equal(fs.existsSync(join(notesDir(f), '.write-lock')), false);
  } finally { fs.unlinkSync = oldUnlink; syncBuiltinESMExports(); controller.abort(); deliver?.(); await pending.catch(() => {}); f.cleanup(); }
});

test('cleanup lock contention preserves the original inode/bytes and reports uncertainty without a retry', async () => {
  const f = await digestFixture(); const controller = new AbortController(); const oldOpen = fs.openSync;
  let entered = false; let deliver!: () => void; let peerFd: number | undefined; let attempts = 0;
  const pending = runDelegatedDigest(f.input, { save: true, fetch: fetcher, signal: controller.signal },
    () => { entered = true; return new Promise<void>((resolve) => { deliver = resolve; }); });
  const rejected = assert.rejects(pending, (e: unknown) => e instanceof DigestFailure && e.reason === 'digest_note_publish_uncertain_use_show');
  try {
    await until(() => entered); const file = join(notesDir(f), notes(f)[0]);
    const bytes = fs.readFileSync(file); const inode = fs.statSync(file).ino;
    const lock = join(notesDir(f), '.write-lock');
    peerFd = oldOpen(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => { if (String(args[0]) === lock) attempts++; return oldOpen(...args); }) as typeof fs.openSync;
    syncBuiltinESMExports();
    controller.abort(); await rejected;
    assert.equal(attempts, 1); assert.equal(fs.statSync(file).ino, inode); assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(fs.statSync(lock).ino, fs.fstatSync(peerFd).ino);
    // Show is read-only and does not steal or wait on a peer's lock.
    assert.equal((await showDelegatedDigest(f.input)).label, 'model_generated');
  } finally {
    fs.openSync = oldOpen; syncBuiltinESMExports();
    if (peerFd !== undefined) { fs.closeSync(peerFd); fs.unlinkSync(join(notesDir(f), '.write-lock')); }
    controller.abort(); deliver?.(); await pending.catch(() => {}); f.cleanup();
  }
});

// Round 3: a bounded allocator model can reuse A's number only when A has neither a name nor a descriptor.
// Real open/rename/unlink/read/fsync operations still run against the synthetic fixture.
test('A delivery pin prevents deterministic A to B to C inode reuse and preserves C on late abort', async () => {
  const f = await digestFixture(); const controller = new AbortController();
  const original = { open: fs.openSync, close: fs.closeSync, stat: fs.fstatSync, lstat: fs.lstatSync,
    rename: fs.renameSync, read: fs.readSync };
  const descriptors = new Map<number, number>();
  let first: number | undefined; let third: number | undefined; let creations = 0;
  let firstLinked = false; let eligibleForReuse: boolean | undefined; let revoked = false; let readsAfterRevoke = 0;
  const originalFetch = globalThis.fetch; let showSends = 0;
  globalThis.fetch = (async () => { showSends++; throw new Error('show must not fetch'); }) as typeof fetch;
  let entered = false; let release!: () => void; let pending: Promise<unknown> | undefined;
  const model = (st: fs.Stats): fs.Stats => {
    if (eligibleForReuse && st.ino === third && first !== undefined)
      return Object.assign(Object.create(Object.getPrototypeOf(st)) as fs.Stats, st, { ino: first });
    return st;
  };
  fs.openSync = ((path: fs.PathLike, flags: number | string, mode?: fs.Mode) => {
    const fd = original.open(path, flags, mode);
    const name = String(path);
    if (name.startsWith(`${notesDir(f)}/`) && !name.endsWith('/.write-lock')) {
      const ino = original.stat(fd).ino; descriptors.set(fd, ino);
      if (name.includes('/.pending-')) {
        creations++;
        if (creations === 1) first = ino;
        if (creations === 3) {
          third = ino;
          eligibleForReuse = !firstLinked && ![...descriptors.values()].includes(first!);
        }
      }
    }
    return fd;
  }) as typeof fs.openSync;
  fs.closeSync = ((fd: number) => { original.close(fd); descriptors.delete(fd); }) as typeof fs.closeSync;
  fs.fstatSync = ((fd: number, options?: fs.StatOptions) => {
    const st = original.stat(fd, options); return model(st as fs.Stats);
  }) as typeof fs.fstatSync;
  fs.lstatSync = ((path: fs.PathLike, options?: fs.StatOptions) => {
    const st = original.lstat(path, options); return model(st as fs.Stats);
  }) as typeof fs.lstatSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    original.rename(from, to);
    if (String(from).startsWith(`${notesDir(f)}/.pending-`))
      firstLinked = original.lstat(to).ino === first;
  }) as typeof fs.renameSync;
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    if (revoked && descriptors.has(args[0])) readsAfterRevoke++;
    return original.read(...args);
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try {
    pending = runDelegatedDigest(f.input, { save: true, fetch: fetcher, signal: controller.signal },
      () => { entered = true; return new Promise<void>((resolve) => { release = resolve; }); });
    const rejected = assert.rejects(pending, (e: unknown) => e instanceof DigestFailure &&
      e.reason === 'digest_note_publish_uncertain_use_show' && e.exitCode === 6);
    await until(() => entered);
    const file = join(notesDir(f), notes(f)[0]); const a = fs.readFileSync(file);
    const aPins = [...descriptors].filter(([, ino]) => ino === first);
    await tick(); assert.equal((await save(f)).retention.state, 'saved');
    if (aPins.length) assert.equal(original.stat(aPins[0][0]).nlink, 0); // Still allocated after unlink.
    await tick(); const c = await save(f); assert.equal(c.retention.state, 'saved');
    const cBytes = fs.readFileSync(file); const cInode = original.lstat(file).ino;
    assert.notDeepEqual(cBytes, a);
    revoked = true; controller.abort(); await rejected;
    assert.equal(readsAfterRevoke, 0); assert.equal(descriptors.size, 0);
    assert.equal(original.lstat(file).ino, cInode); assert.deepEqual(fs.readFileSync(file), cBytes);
    assert.equal(aPins.length, 1); assert.equal(eligibleForReuse, false);
    revoked = false;
    assert.deepEqual((await showDelegatedDigest(f.input)).document, c.document);
    assert.equal(showSends, 0); assert.equal(descriptors.size, 0);
  } finally {
    controller.abort(); release?.(); await pending?.catch(() => {});
    fs.openSync = original.open; fs.closeSync = original.close; fs.fstatSync = original.stat;
    fs.lstatSync = original.lstat; fs.renameSync = original.rename; fs.readSync = original.read;
    globalThis.fetch = originalFetch;
    syncBuiltinESMExports(); f.cleanup();
  }
});

for (const outcome of ['success', 'sink-loss', 'revocation', 'cancel', 'cleanup-busy', 'write-failure'] as const) {
  test(`publication descriptors close after repeated ${outcome} settlement`, async () => {
    const { SmallModel } = await import('../../src/collectors/small-model.js');
    const f = await digestFixture();
    const original = { open: fs.openSync, close: fs.closeSync, write: fs.writeFileSync,
      flush: SmallModel.prototype.flushTelemetry };
    const pins = new Set<number>(); let inSettlement = 0; let peerLock: string | undefined;
    fs.openSync = ((path: fs.PathLike, flags: number | string, mode?: fs.Mode) => {
      const fd = original.open(path, flags, mode);
      if (String(path).startsWith(`${notesDir(f)}/.pending-`)) pins.add(fd);
      return fd;
    }) as typeof fs.openSync;
    fs.closeSync = ((fd: number) => { original.close(fd); pins.delete(fd); }) as typeof fs.closeSync;
    fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
      if (outcome === 'write-failure' && typeof args[0] === 'number' && pins.has(args[0]))
        throw new Error('synthetic write failure');
      return original.write(...args);
    }) as typeof fs.writeFileSync;
    SmallModel.prototype.flushTelemetry = async function () {
      if (outcome !== 'write-failure') assert.equal(pins.size, 1);
      await original.flush.call(this);
      if (outcome !== 'write-failure') { assert.equal(pins.size, 1); inSettlement++; }
    };
    syncBuiltinESMExports();
    try {
      for (let iteration = 0; iteration < 3; iteration++) {
        const controller = new AbortController(); let receipt: DigestRetention | undefined;
        const operation = runDelegatedDigest(f.input, { save: true, fetch: fetcher, signal: controller.signal,
          onRetention: (r) => { receipt = r; } }, () => {
          assert.equal(pins.size, outcome === 'write-failure' ? 0 : 1);
          if (outcome === 'sink-loss') throw new Error('synthetic sink loss');
          if (outcome === 'revocation') f.write('outbound.json', { ...f.policy, revision: 2, grants: [] });
          if (outcome === 'cleanup-busy') {
            peerLock = join(notesDir(f), '.write-lock');
            original.write(peerLock, '', { mode: 0o600, flag: 'wx' });
          }
          if (outcome === 'cancel' || outcome === 'cleanup-busy') controller.abort();
        });
        if (outcome === 'success' || outcome === 'write-failure') await operation;
        else await assert.rejects(operation);
        assert.equal(pins.size, 0);
        if (peerLock) { fs.unlinkSync(peerLock); peerLock = undefined; }
        f.write('outbound.json', f.policy);
        if (outcome === 'sink-loss' || outcome === 'cleanup-busy' || outcome === 'success')
          assert.equal((await showDelegatedDigest(f.input)).label, 'model_generated');
        if (outcome === 'write-failure') assert.deepEqual(receipt, { state: 'not_saved', reason: 'digest_note_write_failed' });
      }
      if (outcome !== 'write-failure') assert.equal(inSettlement, 3);
    } finally {
      fs.openSync = original.open; fs.closeSync = original.close; fs.writeFileSync = original.write;
      SmallModel.prototype.flushTelemetry = original.flush; syncBuiltinESMExports(); f.cleanup();
    }
  });
}
