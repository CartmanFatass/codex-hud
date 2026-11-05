import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, rename, symlink, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PI_EXTENSION_CONTEXT_PROFILE as profile,
  PI_EXTENSION_CONTEXT_LIMITS as limits,
  createLabPiExtensionContextGuard,
  makeLabPiContextExecute,
  validateSnapshot,
} from '../../scripts/workbench/pi-extension-context.mjs';

const header = (id = 'synthetic-session', extra = {}) =>
  JSON.stringify({ type: 'session', version: 3, id, ...extra }) + '\n';

async function fixture(t, { persisted = true } = {}) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-context-lab-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'sessions');
  await mkdir(root);
  const state = { sessionId: 'synthetic-session', sessionDir: root, sessionFile: path.join(root, 'session.jsonl') };
  if (persisted) await writeFile(state.sessionFile, header());
  const manager = {
    getSessionId() {
      return state.sessionId;
    },
    getSessionFile() {
      return state.sessionFile;
    },
    getSessionDir() {
      return state.sessionDir;
    },
  };
  const ctx = { sessionManager: manager };
  const guard = createLabPiExtensionContextGuard({ profile, canonicalSourceDir: root });
  const lifecycle = guard.start();
  return {
    home,
    root,
    state,
    manager,
    ctx,
    guard,
    lifecycle,
    snapshot: (overrides = {}) => ({
      profile,
      epoch: lifecycle.epoch,
      toolCallId: 'call-synthetic',
      toolName: 'delegate_spawn',
      ...state,
      ...overrides,
    }),
    capture: () => lifecycle.capture(ctx, 'call-synthetic', 'delegate_spawn'),
  };
}

test('pinned profile captures immutable ready context and verifies it independently', async (t) => {
  const f = await fixture(t);
  const captured = await f.capture();
  assert.ok(Object.isFrozen(captured));
  assert.equal(captured.status, 'ready');
  assert.equal(captured.headerVersion, 3);
  assert.equal(captured.headerDigest, createHash('sha256').update(header().slice(0, -1)).digest('hex'));
  assert.equal(captured.epoch, f.lifecycle.epoch);
  assert.deepEqual(await validateSnapshot(JSON.parse(JSON.stringify(captured)), f.root), captured);
  assert.deepEqual(await f.lifecycle.recheck(captured), captured);
});

test('only the three trusted context getters and explicit tool identifiers are captured', async (t) => {
  const f = await fixture(t);
  const reads = [];
  f.ctx.sessionManager = new Proxy(f.manager, {
    get(target, key) {
      reads.push(key);
      if (!['getSessionId', 'getSessionFile', 'getSessionDir'].includes(key)) throw Error('unexpected manager field');
      return Reflect.get(target, key);
    },
  });
  const ctx = new Proxy(f.ctx, {
    get(target, key) {
      assert.equal(key, 'sessionManager');
      return Reflect.get(target, key);
    },
  });
  const poison = new Proxy(
    {},
    {
      get() {
        throw Error('untrusted params accessed');
      },
      ownKeys() {
        throw Error('untrusted params enumerated');
      },
    }
  );
  let received;
  const execute = makeLabPiContextExecute({
    lifecycle: f.lifecycle,
    toolName: 'delegate_spawn',
    onCapture: (value) => {
      received = value;
      return 'observed';
    },
  });
  assert.equal(execute.length, 5);
  assert.equal(await execute('trusted-call', poison, poison, poison, ctx), 'observed');
  assert.equal(received.toolCallId, 'trusted-call');
  assert.equal(received.toolName, 'delegate_spawn');
  assert.deepEqual(
    Object.keys(received).sort(),
    [
      'profile',
      'epoch',
      'toolCallId',
      'toolName',
      'sessionId',
      'sessionFile',
      'sessionDir',
      'status',
      'headerVersion',
      'headerDigest',
      'pendingReason',
    ].sort()
  );
  assert.ok(reads.length > 0);
});

test('untrusted claim, args, RPC and status fields are neither read nor returned by independent validation', async (t) => {
  const f = await fixture(t);
  const snapshot = f.snapshot();
  for (const field of ['args', 'claim', 'rpc', 'status', 'headerVersion', 'headerDigest', 'cwd']) {
    Object.defineProperty(snapshot, field, {
      enumerable: true,
      get() {
        throw Error('untrusted field read');
      },
    });
  }
  const result = await validateSnapshot(snapshot, f.root);
  assert.equal(result.status, 'ready');
  assert.equal(result.args, undefined);
});

test('missing file is pending and becomes ready only after actual persistence', async (t) => {
  const f = await fixture(t, { persisted: false });
  const pending = await f.capture();
  assert.equal(pending.status, 'pending');
  assert.equal(pending.pendingReason, 'session_file_missing');
  assert.equal(pending.headerVersion, null);
  assert.equal(pending.headerDigest, null);
  await writeFile(f.state.sessionFile, header());
  assert.equal((await f.lifecycle.recheck(pending)).status, 'ready');
});

test('undefined upstream file is explicit pending, never inferred from an id or arguments', async (t) => {
  const f = await fixture(t);
  f.state.sessionFile = undefined;
  const pending = await f.capture();
  assert.equal(pending.sessionFile, null);
  assert.equal(pending.pendingReason, 'session_file_unassigned');
  f.state.sessionFile = path.join(f.root, 'session.jsonl');
  await assert.rejects(f.capture(), /pi_session_retarget_requires_new_epoch/);
});

for (const badProfile of [
  undefined,
  null,
  'pi-v0.73.1',
  'pi-extension-v0.73.2-781152fc',
  'pi-extension-v0.73.1-deadbeef',
]) {
  test(`unsupported profile is rejected: ${badProfile}`, async (t) => {
    const f = await fixture(t);
    assert.throws(
      () => createLabPiExtensionContextGuard({ profile: badProfile, canonicalSourceDir: f.root }),
      /unsupported_pi_extension_profile/
    );
    await assert.rejects(
      validateSnapshot(f.snapshot({ profile: badProfile }), f.root),
      /unsupported_pi_extension_profile/
    );
  });
}

for (const [field, value] of [
  ['sessionId', ''],
  ['sessionId', 'x'.repeat(limits.sessionIdBytes + 1)],
  ['sessionId', '../session'],
  ['toolCallId', ''],
  ['toolCallId', 'x'.repeat(limits.toolCallIdBytes + 1)],
  ['toolCallId', 'a\nb'],
  ['toolName', ''],
  ['toolName', 'x'.repeat(limits.toolNameBytes + 1)],
  ['toolName', 'a/b'],
  ['epoch', ''],
  ['epoch', 'x'.repeat(129)],
]) {
  test(`bounded identifiers reject ${field}: ${JSON.stringify(value).slice(0, 40)}`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(validateSnapshot(f.snapshot({ [field]: value }), f.root), /invalid_pi_/);
  });
}

test('source root must be independent, canonical, and exactly equal to context directory', async (t) => {
  const f = await fixture(t);
  await assert.rejects(validateSnapshot(f.snapshot(), f.home), /pi_session_dir_mismatch/);
  await assert.rejects(
    validateSnapshot(f.snapshot({ sessionDir: `${f.root}/.` }), f.root),
    /invalid_pi_canonical_path/
  );
  await assert.rejects(
    validateSnapshot(f.snapshot({ sessionDir: 'sessions' }), 'sessions'),
    /invalid_pi_canonical_path/
  );
});

test('relative, escaped, sibling-prefix, root-as-file and oversized paths are rejected', async (t) => {
  const f = await fixture(t);
  for (const sessionFile of [
    'session.jsonl',
    `${f.root}/../escape`,
    `${f.root}-sibling/file`,
    f.root,
    path.join(f.root, 'x'.repeat(limits.pathBytes)),
  ]) {
    await assert.rejects(
      validateSnapshot(f.snapshot({ sessionFile }), f.root),
      /invalid_pi_canonical_path|pi_session_file_outside_source/
    );
  }
});

test('a canonical nested session file is supported', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'nested'));
  f.state.sessionFile = path.join(f.root, 'nested', 'session.jsonl');
  await writeFile(f.state.sessionFile, header());
  assert.equal((await f.capture()).status, 'ready');
});

test('symlink source, parent components and file are rejected, even within the source', async (t) => {
  const f = await fixture(t);
  const rootLink = path.join(f.home, 'root-link');
  await symlink(f.root, rootLink);
  await assert.rejects(
    validateSnapshot(f.snapshot({ sessionDir: rootLink, sessionFile: path.join(rootLink, 'session.jsonl') }), rootLink),
    /pi_path_not_canonical/
  );
  const fileLink = path.join(f.root, 'file-link');
  await symlink(f.state.sessionFile, fileLink);
  await assert.rejects(validateSnapshot(f.snapshot({ sessionFile: fileLink }), f.root), { code: 'ELOOP' });
  const parentLink = path.join(f.root, 'parent-link');
  await symlink(f.root, parentLink);
  await assert.rejects(
    validateSnapshot(f.snapshot({ sessionFile: path.join(parentLink, 'session.jsonl') }), f.root),
    /ENOTDIR|ELOOP/
  );
});

test('dangling symlink is refused rather than treated as lazy persistence', async (t) => {
  const f = await fixture(t);
  const link = path.join(f.root, 'dangling');
  await symlink(path.join(f.home, 'not-there'), link);
  await assert.rejects(validateSnapshot(f.snapshot({ sessionFile: link }), f.root), { code: 'ELOOP' });
});

test('nonregular directory and FIFO are rejected without blocking', { timeout: 3000 }, async (t) => {
  const f = await fixture(t);
  const dir = path.join(f.root, 'directory');
  await mkdir(dir);
  await assert.rejects(validateSnapshot(f.snapshot({ sessionFile: dir }), f.root), /pi_session_file_not_regular/);
  const fifo = path.join(f.root, 'fifo');
  execFileSync('mkfifo', [fifo]);
  await assert.rejects(validateSnapshot(f.snapshot({ sessionFile: fifo }), f.root), /pi_session_file_not_regular/);
});

for (const [name, bytes, expected] of [
  ['wrong id', header('other-session'), /pi_session_header_mismatch/],
  ['old version', header(undefined, { version: 2 }), /invalid_pi_session_header/],
  ['missing version', '{"type":"session","id":"synthetic-session"}\n', /invalid_pi_session_header/],
  ['string version', header(undefined, { version: '3' }), /invalid_pi_session_header/],
  ['wrong type', header(undefined, { type: 'message' }), /invalid_pi_session_header/],
  ['oversized id', header('x'.repeat(129)), /invalid_pi_session_header/],
  ['array', '[]\n', /invalid_pi_session_header/],
  ['null', 'null\n', /invalid_pi_session_header/],
  ['empty', '', /invalid_pi_session_header/],
  ['partial json', '{"type":"session"', /invalid_pi_session_header/],
  ['invalid utf8', Buffer.from([0xff, 0x0a]), /invalid_pi_session_header/],
  ['oversized first line', ' '.repeat(limits.headerBytes + 1) + header(), /pi_session_header_too_large/],
]) {
  test(`header validation rejects ${name}`, async (t) => {
    const f = await fixture(t);
    await writeFile(f.state.sessionFile, bytes);
    await assert.rejects(f.capture(), expected);
  });
}

test('only the first bounded line is parsed; arbitrary transcript tail is not an identity source', async (t) => {
  const f = await fixture(t);
  await writeFile(f.state.sessionFile, header() + 'untrusted transcript tail\n'.repeat(100000));
  assert.equal((await f.capture()).status, 'ready');
  await writeFile(f.state.sessionFile, '{"type":"message"}\n' + header());
  await assert.rejects(f.capture(), /invalid_pi_session_header/);
});

test('maximum bounded header is accepted and one byte more is refused', async (t) => {
  const f = await fixture(t);
  const value = header().trimEnd();
  await writeFile(f.state.sessionFile, value + ' '.repeat(limits.headerBytes - Buffer.byteLength(value)) + '\n');
  assert.equal((await f.capture()).status, 'ready');
  await writeFile(f.state.sessionFile, value + ' '.repeat(limits.headerBytes + 1 - Buffer.byteLength(value)) + '\n');
  await assert.rejects(f.capture(), /pi_session_header_too_large/);
});

test('shutdown and restart invalidate old captures and execute closures, stale shutdown cannot kill a new epoch', async (t) => {
  const f = await fixture(t);
  const captured = await f.capture();
  const execute = makeLabPiContextExecute({
    lifecycle: f.lifecycle,
    toolName: 'delegate_spawn',
    onCapture: () => assert.fail('must not call stale consumer'),
  });
  f.guard.shutdown();
  await assert.rejects(f.capture(), /stale_pi_extension_epoch/);
  await assert.rejects(f.lifecycle.recheck(captured), /stale_pi_extension_epoch/);
  const fresh = f.guard.start();
  assert.notEqual(fresh.epoch, f.lifecycle.epoch);
  f.lifecycle.shutdown();
  await assert.rejects(execute('call-id', {}, undefined, undefined, f.ctx), /stale_pi_extension_epoch/);
  assert.equal((await fresh.capture(f.ctx, 'new-call', 'delegate_spawn')).status, 'ready');
});

test('restart without shutdown also fences the earlier lifecycle', async (t) => {
  const f = await fixture(t);
  f.guard.start();
  await assert.rejects(f.capture(), /stale_pi_extension_epoch/);
});

test('cloned, forged, and foreign captures cannot be rechecked as trusted handles', async (t) => {
  const f = await fixture(t);
  const captured = await f.capture();
  await assert.rejects(f.lifecycle.recheck({ ...captured }), /unrecognized_pi_context_capture/);
  await assert.rejects(f.lifecycle.recheck(f.snapshot()), /unrecognized_pi_context_capture/);
  const other = createLabPiExtensionContextGuard({ profile, canonicalSourceDir: f.root }).start();
  await assert.rejects(other.recheck(captured), /unrecognized_pi_context_capture/);
});

test('context session retarget is rejected until explicit new epoch', async (t) => {
  const f = await fixture(t);
  const captured = await f.capture();
  f.state.sessionId = 'new-session';
  f.state.sessionFile = path.join(f.root, 'new-session.jsonl');
  await writeFile(f.state.sessionFile, header('new-session'));
  await assert.rejects(f.capture(), /pi_session_retarget_requires_new_epoch/);
  await assert.rejects(f.lifecycle.recheck(captured), /pi_session_changed_before_recheck/);
  assert.equal((await f.guard.start().capture(f.ctx, 'new-call', 'delegate_spawn')).sessionId, 'new-session');
});

test('same-session file path changes are also retargets', async (t) => {
  const f = await fixture(t);
  await f.capture();
  f.state.sessionFile = path.join(f.root, 'other-path.jsonl');
  await writeFile(f.state.sessionFile, header());
  await assert.rejects(f.capture(), /pi_session_retarget_requires_new_epoch/);
});

test('a replaced file with identical header is refused within an epoch', async (t) => {
  const f = await fixture(t);
  const captured = await f.capture();
  await rename(f.state.sessionFile, path.join(f.root, 'old-file'));
  await writeFile(f.state.sessionFile, header());
  await assert.rejects(f.lifecycle.recheck(captured), /pi_session_file_replaced/);
  await assert.rejects(f.capture(), /pi_session_file_replaced/);
});

test('a changed header in the same file is refused even when session id stays unchanged', async (t) => {
  const f = await fixture(t);
  const captured = await f.capture();
  await writeFile(f.state.sessionFile, header(undefined, { cwd: '/synthetic-changed' }));
  const independentlyChecked = await validateSnapshot(f.snapshot({ headerDigest: captured.headerDigest }), f.root);
  assert.notEqual(independentlyChecked.headerDigest, captured.headerDigest);
  await assert.rejects(f.lifecycle.recheck(captured), /pi_session_header_replaced/);
});

test('a previously ready file becoming absent is refused, not downgraded to pending authority', async (t) => {
  const f = await fixture(t);
  const captured = await f.capture();
  await rm(f.state.sessionFile);
  await assert.rejects(f.lifecycle.recheck(captured), /pi_session_file_replaced/);
});

test('a replaced source directory with identical session header is refused within an epoch', async (t) => {
  const f = await fixture(t);
  const captured = await f.capture();
  await rename(f.root, path.join(f.home, 'old-source'));
  await mkdir(f.root);
  await writeFile(f.state.sessionFile, header());
  await assert.rejects(f.lifecycle.recheck(captured), /pi_source_directory_replaced/);
});

test('session identity is re-read after filesystem validation', async (t) => {
  const f = await fixture(t);
  const original = f.manager.getSessionDir;
  let reads = 0;
  f.manager.getSessionDir = () => {
    const dir = original();
    if (++reads === 1) f.state.sessionId = 'switched-after-first-read';
    return dir;
  };
  await assert.rejects(f.capture(), /pi_session_changed_during_capture/);
});

test('epoch is checked after each context read and after async validation', async (t) => {
  const f = await fixture(t);
  const original = f.manager.getSessionDir;
  f.manager.getSessionDir = () => {
    f.guard.shutdown();
    return original();
  };
  await assert.rejects(f.capture(), /stale_pi_extension_epoch/);
  const fresh = f.guard.start();
  f.manager.getSessionDir = original;
  const pending = fresh.capture(f.ctx, 'synthetic-call', 'delegate_spawn');
  f.guard.shutdown();
  await assert.rejects(pending, /stale_pi_extension_epoch/);
});

test('recheck rejects changed manager object even when all returned values match', async (t) => {
  const f = await fixture(t);
  const captured = await f.capture();
  f.ctx.sessionManager = { ...f.manager };
  await assert.rejects(f.lifecycle.recheck(captured), /pi_session_manager_changed/);
});

test('recheck verifies session and epoch again after its filesystem work', async (t) => {
  const f = await fixture(t);
  const captured = await f.capture();
  let reads = 0;
  const original = f.manager.getSessionDir;
  f.manager.getSessionDir = () => {
    const dir = original();
    if (++reads === 1) f.state.sessionId = 'changed-during-recheck';
    return dir;
  };
  await assert.rejects(f.lifecycle.recheck(captured), /pi_session_changed_during_recheck/);
});

test('unsupported context does not fall back to RPC, args or alternate method names', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.lifecycle.capture(
      { sessionId: f.state.sessionId, sessionFile: f.state.sessionFile, sessionDir: f.root },
      'call',
      'delegate_spawn'
    ),
    /pi_session_manager_changed/
  );
  await assert.rejects(
    f.lifecycle.capture(
      {
        sessionManager: {
          getSessionPath() {
            return f.state.sessionFile;
          },
        },
      },
      'call',
      'delegate_spawn'
    ),
    /unsupported_pi_extension_context/
  );
});
