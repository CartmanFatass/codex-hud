import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as nodeModule from 'node:module';
import { ledgerRuntimeSupported } from '../../dist/ledger/runtime.js';

// This synthetic host directly loads the TypeScript extension and uses registerHooks.
// Its feature floor is distinct from the ledger's Node22.13 minimum.
const [major, minor] = process.versions.node.split('.').map(Number);
const hostSupported =
  ledgerRuntimeSupported() &&
  process.platform === 'linux' &&
  ((major === 22 && minor >= 18) || major >= 24) &&
  typeof nodeModule.registerHooks === 'function' &&
  ['strip', 'transform'].includes(process.features.typescript);
const { DatabaseSync } = hostSupported ? await import('node:sqlite') : { DatabaseSync: null };
const hostTest = (name, options, run) =>
  test(
    name,
    {
      ...options,
      skip: hostSupported
        ? false
        : `Synthetic Pi host requires Linux, Node22.18+ or24+, registerHooks and TypeScript loading; found ${process.platform} Node${process.versions.node}`,
    },
    run
  );

async function fixture(t, { persisted = true, packageVersion = '1.4.0' } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hud-pi-bridge-')));
  const root = join(dir, 'sessions'),
    home = join(dir, 'hud');
  const pkg = join(dir, 'node_modules/@earendil-works/pi-coding-agent');
  await mkdir(root);
  await writeFile(join(root, 'brief.md'), 'Synthetic task\n');
  await mkdir(home, { mode: 0o700 });
  await mkdir(join(dir, 'home'));
  await mkdir(join(pkg, 'dist/bundle'), { recursive: true });
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: '@earendil-works/pi-coding-agent',
      version: packageVersion,
      type: 'module',
      bin: { pi: 'dist/bundle/cli.js' },
    })
  );
  await copyFile('tests/fixtures/pi-delegation-host.mjs', join(pkg, 'dist/bundle/cli.js'));
  if (persisted)
    await writeFile(
      join(root, 'synthetic-a.jsonl'),
      JSON.stringify({ type: 'session', version: 3, id: 'synthetic-a' }) + '\n'
    );
  await writeFile(
    join(home, 'delegate.json'),
    JSON.stringify({
      version: 1,
      profiles: [
        {
          name: 'pi',
          harness: 'pi',
          source: { root, label: 'Synthetic Pi' },
          launch: { argv: ['/bin/false'] },
          headless: { argv: ['/bin/false'] },
          resume: null,
          resumeHeadless: null,
          host: { kind: 'none', layout: 'none' },
          env: {},
          mcpServerName: 'hud',
          claimTransport: 'config_env',
          clientToolTimeoutMs: null,
          responseMarginMs: 1000,
          orphan_policy: 'continue',
          managedShellVerified: false,
          callSource: { kind: 'pi_extension_v1' },
        },
      ],
    })
  );
  const child = spawn(process.execPath, [join(pkg, 'dist/bundle/cli.js'), '--session-dir', root], {
    cwd: resolve('.'),
    env: {
      PATH: process.env.PATH,
      LANG: 'C.UTF-8',
      NO_COLOR: '1',
      HOME: join(dir, 'home'),
      HUD_HOME: home,
      HUD_MCP_PROFILE: 'pi',
      HUD_TEST_REPO: resolve('.'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '',
    id = 0;
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const pending = new Map();
  let readyResolve, readyReject;
  const ready = new Promise((a, b) => {
    readyResolve = a;
    readyReject = b;
  });
  const ended = new Promise((resolve) => child.once('close', resolve));
  child.once('close', () => {
    readyReject(Error(stderr));
    for (const item of pending.values()) item.reject(Error(stderr || 'host exited'));
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const row = JSON.parse(line);
    if (row.ready) readyResolve(row);
    else {
      const item = pending.get(row.id);
      pending.delete(row.id);
      clearTimeout(item.timer);
      item.resolve(row);
    }
  });
  t.after(async () => {
    child.stdin.end();
    await ended;
    await rm(dir, { recursive: true, force: true });
  });
  const init = await ready;
  const request = (value) =>
    new Promise((resolve, reject) => {
      const number = ++id;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(Error('fixture timeout: ' + stderr));
      }, 15000);
      pending.set(number, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id: number, ...value }) + '\n');
    });
  return {
    root,
    home,
    pkg,
    request,
    init,
    call: (tool, callId, args) => request({ kind: 'call', tool, callId, args }),
    portCalls: async () =>
      (await readFile(join(home, 'synthetic-native-port.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse),
    contexts: () => {
      const db = new DatabaseSync(join(home, 'ledger.sqlite'), { readOnly: true });
      try {
        return db.prepare('SELECT * FROM caller_contexts').all();
      } finally {
        db.close();
      }
    },
  };
}

hostTest(
  'product native tools bind exact Pi source through real stdio with an explicit synthetic non-socket host port',
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(t);
    for (const name of ['managed_create', 'managed_list', 'managed_close', 'jev_run'])
      assert.ok(f.init.tools.includes(name), name);
    assert.ok(f.init.tools.every((name) => !name.startsWith('delegate_')));
    const list = await f.call('managed_list', 'call-list');
    assert.deepEqual(list.result.details.value, { connections: [], relations: [] });
    assert.deepEqual(list.result.details.wake, { adapter: 'pi_extension', last: null, modelReadAcknowledged: false });
    const contexts = f.contexts();
    assert.equal(contexts.length, 0, 'native calls do not create a legacy claim/context workflow');
    const createArgs = { profileId: 'unconfigured-backend', workspace: f.root };
    const created = await f.call('managed_create', 'call-create', createArgs);
    assert.equal(JSON.parse(created.error).code, 'native_profile_not_configured');
    const duplicate = await f.call('managed_create', 'call-create', createArgs);
    assert.equal(duplicate.error, 'pi_duplicate_tool_call');
    const close = await f.call('managed_close', 'call-close', { connectionId: 'foreign-child' });
    assert.equal(JSON.parse(close.error).code, 'native_connection_not_owned');
    const calls = await f.portCalls();
    assert.ok(calls.every((call) => call.owner.harness === 'pi' && call.owner.sessionId === 'synthetic-a'));
    assert.equal(calls.filter((call) => call.method === 'create').length, 1);
  }
);

hostTest(
  'lazy persistence stays pending and creates no synthetic identity or server',
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(t, { persisted: false });
    const pending = await f.call('managed_list', 'lazy-call');
    assert.equal(JSON.parse(pending.error).code, 'identity_source_missing');
    assert.deepEqual((await f.request({ kind: 'children' })).result, []);
    await f.request({ kind: 'persist' });
    assert.equal((await f.call('managed_list', 'lazy-call')).result.details.ok, true);
  }
);

hostTest(
  'installed Pi versions do not gate authenticated native source calls (synthetic non-socket port)',
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(t, { packageVersion: '99.123.456' });
    const result = await f.call('managed_list', 'different-version');
    assert.equal(result.result.details.ok, true);
    assert.equal((await f.portCalls()).find((call) => call.method === 'list').owner.sessionId, 'synthetic-a');
  }
);

hostTest(
  'switch, new, fork and tree fence old identity; reconnect never resubmits a call',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await f.call('managed_list', 'first');
    const killed = await f.request({ kind: 'kill' });
    assert.equal(killed.result.length, 1);
    // Allow the OS close event to reach the host. A fresh explicit call reconnects.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await f.call('managed_list', 'first')).error, 'pi_duplicate_tool_call');
    assert.equal((await f.call('managed_list', 'second')).result.details.ok, true);
    assert.equal((await f.request({ kind: 'children' })).result.length, 1);
    for (const [before, after, reason] of [
      ['session_before_switch', 'session_start', 'new'],
      ['session_before_switch', 'session_start', 'resume'],
      ['session_before_fork', 'session_start', 'fork'],
      ['session_before_tree', 'session_tree', undefined],
    ]) {
      await f.request({ kind: 'event', event: before, reason });
      assert.deepEqual((await f.request({ kind: 'children' })).result, []);
      assert.equal((await f.call('managed_list', 'inactive-' + before + reason)).error, 'pi_session_inactive');
      if (after === 'session_start') {
        const sessionId = 'synthetic-' + reason;
        await f.request({ kind: 'set', state: { sessionId, sessionFile: join(f.root, sessionId + '.jsonl') } });
        await f.request({ kind: 'persist' });
      }
      await f.request({ kind: 'event', event: after, reason });
      assert.equal((await f.call('managed_list', 'after-' + before + reason)).result.details.ok, true);
    }
    const calls = (await f.portCalls()).filter((call) => call.method === 'list');
    assert.equal(calls.at(-1).owner.sessionId, 'synthetic-fork');
    for (const id of ['synthetic-new', 'synthetic-resume', 'synthetic-fork'])
      assert.ok(calls.some((call) => call.owner.sessionId === id));
  }
);

test('concurrent reconnects share cleanup barrier and uncertain close fences every caller', async (t) => {
  // Isolated cleanup seam only: no synthetic resolver, registration or capability.
  const { PiDelegationBridge } = await import('../../dist/harness/pi/delegation-bridge.js');
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hud-pi-cleanup-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'synthetic.jsonl');
  await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: 'synthetic' }) + '\n');
  const bridge = new PiDelegationBridge({ sourceRoot: dir, env: {}, cwd: dir });
  await bridge.start();
  let closeStarted, rejectClose;
  const closingStarted = new Promise((resolve) => {
    closeStarted = resolve;
  });
  const cleanup = new Promise((_resolve, reject) => {
    rejectClose = reject;
  });
  let closes = 0;
  bridge.channel = {
    isClosed: () => true,
    close: () => {
      ++closes;
      closeStarted();
      return cleanup;
    },
  };
  const ctx = {
    sessionManager: { getSessionId: () => 'synthetic', getSessionFile: () => file, getSessionDir: () => dir },
  };
  const first = assert.rejects(bridge.execute('managed_list', 'first', {}, undefined, ctx), /pi_cleanup_uncertain/);
  await closingStarted;
  let secondSettled = false;
  const second = assert
    .rejects(bridge.execute('managed_list', 'second', {}, undefined, ctx), /pi_cleanup_uncertain/)
    .finally(() => {
      secondSettled = true;
    });
  // Give the concurrent capture its actual filesystem work, then inspect the owned slot.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(secondSettled, false);
  assert.equal(bridge.channel, null, 'must not start a replacement before cleanup receipt');
  rejectClose(Error('pi_cleanup_uncertain'));
  await Promise.all([first, second]);
  assert.equal(closes, 1);
  await assert.rejects(bridge.start(), /pi_cleanup_uncertain/);
});

hostTest(
  'overlapping calls create one owned channel; lifecycle shutdown invalidates pending capture',
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await f.call('managed_list', 'parallel-bind')).result.details.ok, true);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => f.call('managed_list', 'parallel-' + i)));
    assert.ok(
      results.every((value) => value.result?.details.ok === true),
      JSON.stringify(results)
    );
    assert.equal((await f.request({ kind: 'children' })).result.length, 1);
    const [raced] = await Promise.all([
      f.call('managed_list', 'shutdown-race'),
      f.request({ kind: 'event', event: 'session_shutdown' }),
    ]);
    assert.match(raced.error, /stale_pi_extension_epoch|pi_session_inactive|pi_channel_closed_outcome_unknown/);
    assert.deepEqual((await f.request({ kind: 'children' })).result, []);
  }
);

hostTest('server rechecks the installed entrypoint on every call', { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('managed_list', 'replace-bind')).result.details.ok, true);
  assert.equal((await f.call('managed_list', 'before-replace')).result.details.ok, true);
  await writeFile(join(f.pkg, 'dist/bundle/cli.js'), '// Synthetic replaced entrypoint\n');
  assert.equal(JSON.parse((await f.call('managed_list', 'after-replace')).error).code, 'identity_unverified');
});
