import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, realpath, rm } from 'node:fs/promises';
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
  'explicit product extension exposes all tools and real hud-mcp binds exact session without capability promotion',
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(t);
    assert.ok(f.init.tools.includes('delegate_spawn'));
    assert.ok(f.init.tools.includes('delegate_report'));
    const who = await f.call('delegate_whoami', 'call-who');
    assert.equal(JSON.parse(who.error).code, 'claim_missing');
    const list = await f.call('delegate_list', 'call-list');
    assert.equal(list.result.details.ok, true);
    const contexts = f.contexts();
    assert.equal(contexts.length, 1);
    assert.equal(JSON.parse(contexts[0].session_ref)[2], 'synthetic-a');
    const spawn = await f.call('delegate_spawn', 'call-spawn', {
      backend: 'unconfigured-backend',
      role: 'worker',
      brief: join(f.root, 'brief.md'),
      cwd: f.root,
      mode: 'headless',
      request_key: 'synthetic-spawn',
    });
    assert.equal(JSON.parse(spawn.error).code, 'backend_not_found');
    const duplicate = await f.call('delegate_spawn', 'call-spawn', {
      backend: 'unconfigured-backend',
      role: 'worker',
      brief: join(f.root, 'brief.md'),
      cwd: f.root,
      mode: 'headless',
      request_key: 'synthetic-spawn',
    });
    assert.equal(duplicate.error, 'pi_duplicate_tool_call');
  }
);

hostTest(
  'lazy persistence stays pending and creates no synthetic identity or server',
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(t, { persisted: false });
    const pending = await f.call('delegate_whoami', 'lazy-call');
    assert.equal(JSON.parse(pending.error).code, 'identity_source_missing');
    assert.deepEqual((await f.request({ kind: 'children' })).result, []);
    await f.request({ kind: 'persist' });
    assert.equal(JSON.parse((await f.call('delegate_whoami', 'lazy-call')).error).code, 'claim_missing');
  }
);

hostTest('actual installed-package version mismatch cannot assert Pi authority', { timeout: 25000 }, async (t) => {
  const f = await fixture(t, { packageVersion: '0.73.1' });
  const result = await f.call('delegate_whoami', 'wrong-version');
  assert.equal(result.error, 'pi_channel_closed_outcome_unknown');
  await assert.rejects(
    import('node:fs/promises').then(({ stat }) => stat(join(f.home, 'ledger.sqlite'))),
    { code: 'ENOENT' }
  );
});

hostTest(
  'switch, new, fork and tree fence old identity; reconnect never resubmits a call',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await f.call('delegate_whoami', 'first');
    const killed = await f.request({ kind: 'kill' });
    assert.equal(killed.result.length, 1);
    // Allow the OS close event to reach the host. A fresh explicit call reconnects.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await f.call('delegate_whoami', 'first')).error, 'pi_duplicate_tool_call');
    assert.equal(JSON.parse((await f.call('delegate_whoami', 'second')).error).code, 'claim_missing');
    assert.equal((await f.request({ kind: 'children' })).result.length, 1);
    for (const [before, after, reason] of [
      ['session_before_switch', 'session_start', 'new'],
      ['session_before_switch', 'session_start', 'resume'],
      ['session_before_fork', 'session_start', 'fork'],
      ['session_before_tree', 'session_tree', undefined],
    ]) {
      await f.request({ kind: 'event', event: before, reason });
      assert.deepEqual((await f.request({ kind: 'children' })).result, []);
      assert.equal((await f.call('delegate_whoami', 'inactive-' + before + reason)).error, 'pi_session_inactive');
      if (after === 'session_start') {
        const sessionId = 'synthetic-' + reason;
        await f.request({ kind: 'set', state: { sessionId, sessionFile: join(f.root, sessionId + '.jsonl') } });
        await f.request({ kind: 'persist' });
      }
      await f.request({ kind: 'event', event: after, reason });
      assert.equal(
        JSON.parse((await f.call('delegate_whoami', 'after-' + before + reason)).error).code,
        'claim_missing'
      );
    }
    const current = f.contexts().filter((row) => row.closed_at === null);
    assert.ok(current.every((row) => JSON.parse(row.session_ref)[2] === 'synthetic-fork'));
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
  const first = assert.rejects(bridge.execute('delegate_list', 'first', {}, undefined, ctx), /pi_cleanup_uncertain/);
  await closingStarted;
  let secondSettled = false;
  const second = assert
    .rejects(bridge.execute('delegate_list', 'second', {}, undefined, ctx), /pi_cleanup_uncertain/)
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
    assert.equal(JSON.parse((await f.call('delegate_whoami', 'parallel-bind')).error).code, 'claim_missing');
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => f.call('delegate_list', 'parallel-' + i)));
    assert.ok(
      results.every((value) => value.result?.details.ok === true),
      JSON.stringify(results)
    );
    assert.equal((await f.request({ kind: 'children' })).result.length, 1);
    const [raced] = await Promise.all([
      f.call('delegate_list', 'shutdown-race'),
      f.request({ kind: 'event', event: 'session_shutdown' }),
    ]);
    assert.match(raced.error, /stale_pi_extension_epoch|pi_session_inactive|pi_channel_closed_outcome_unknown/);
    assert.deepEqual((await f.request({ kind: 'children' })).result, []);
  }
);

hostTest('server rechecks the installed entrypoint on every call', { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  assert.equal(JSON.parse((await f.call('delegate_whoami', 'replace-bind')).error).code, 'claim_missing');
  assert.equal((await f.call('delegate_list', 'before-replace')).result.details.ok, true);
  await writeFile(join(f.pkg, 'dist/bundle/cli.js'), '// Synthetic replaced entrypoint\n');
  assert.equal(JSON.parse((await f.call('delegate_list', 'after-replace')).error).code, 'identity_unverified');
});
