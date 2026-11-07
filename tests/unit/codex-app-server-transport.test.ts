import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexAppServerTransport } from '../../src/harness/codex/app-server-transport.js';
function fixture(t: test.TestContext, mode = 'normal', requestTimeoutMs = 3000) {
  const home = mkdtempSync(join(tmpdir(), 'hud-app-transport-'));
  const client = new CodexAppServerTransport({
    executable: process.execPath,
    args: [resolve('tests/fixtures/codex-app-server/synthetic-server.mjs'), mode],
    cwd: home,
    env: { HOME: home, HUD_HOME: join(home, '.hud') },
    requestTimeoutMs,
    lifetimeMs: 10000,
  });
  t.after(async () => {
    await client.shutdown();
    rmSync(home, { recursive: true, force: true });
  });
  return client;
}
test('actual child: split response, initialize acknowledgement, start/resume and reaped shutdown', async (t) => {
  const c = fixture(t);
  await c.initialize();
  await c.threadStart();
  await c.threadResume('synthetic-thread');
  assert.equal(c.snapshot().observation.handshake, 'ready');
  assert.equal(c.snapshot().observation.threadId, 'synthetic-thread');
  assert.equal((await c.shutdown()).reaped, true);
  await assert.rejects(c.threadStart());
});
test('actual child: reordered IDs resolve distinct requests; outbound writes remain ordered', async (t) => {
  const c = fixture(t, 'reorder');
  await c.initialize();
  await Promise.all([c.threadStart(), c.threadResume('resumed-thread')]);
  assert.equal(c.snapshot().observation.pending, 0);
});
test('actual child: approval, malformed frame and exit fail without automatic replies or retries', async (t) => {
  for (const mode of ['approval', 'malformed', 'exit']) {
    const c = fixture(t, mode);
    await c.initialize();
    await assert.rejects(c.threadStart());
    assert.equal((await c.shutdown()).reaped, true);
    assert.notEqual(c.snapshot().reason, null);
  }
});
test('actual silent child: deadlines reject calls without stopping the connection', async (t) => {
  const c = fixture(t, 'silent', 1000);
  await c.initialize();
  const pending = Array.from({ length: 8 }, () => c.threadStart());
  const all = Promise.allSettled(pending);
  await assert.rejects(c.threadStart(), /pending_limit/);
  assert.ok((await all).every((r) => r.status === 'rejected'));
  assert.equal(c.snapshot().reason, null);
  assert.equal(c.snapshot().stopped, false);
  assert.equal((await c.shutdown()).reaped, true);
});

test('stderr volume is diagnostic, not authority to terminate a native process', async (t) => {
  const noisy = fixture(t, 'stderr-limit', 100);
  const diagnostics: string[] = [];
  noisy.onDiagnostic((e) => {
    if (e.type === 'stderr') diagnostics.push(e.text);
  });
  await noisy.initialize();
  await assert.rejects(noisy.threadStart(), /request_timeout/);
  assert.ok(diagnostics.join('').length > 65536);
  assert.equal(noisy.snapshot().stopped, false);
  assert.equal((await noisy.shutdown()).reaped, true);
});
test('missing executable rejects initialization and resolves actual child close', async (t) => {
  const c = new CodexAppServerTransport({
    executable: '/synthetic/missing-app-server',
    args: [],
    cwd: process.cwd(),
    env: {},
    lifetimeMs: 1000,
  });
  t.after(() => c.shutdown());
  await assert.rejects(c.initialize());
  assert.equal((await c.shutdown()).reaped, true);
});
