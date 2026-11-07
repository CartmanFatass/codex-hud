import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexAppServerTransport, AppServerRequestError } from '../../src/harness/codex/app-server-transport.js';

function fixture(t: test.TestContext, mode = 'normal', maxFrameBytes = 1024) {
  const home = mkdtempSync(join(tmpdir(), 'hud-managed-codex-transport-'));
  const log = join(home, 'requests.jsonl');
  const client = new CodexAppServerTransport({
    executable: process.execPath,
    args: [resolve('tests/fakes/managed-codex-server.mjs'), mode, log],
    cwd: home,
    env: { HOME: home, HUD_HOME: join(home, '.hud'), CODEX_HOME: join(home, '.codex') },
    requestTimeoutMs: 1500,
    maxFrameBytes,
  });
  t.after(async () => {
    await client.shutdown();
    rmSync(home, { force: true, recursive: true });
  });
  const barrier = () =>
    client.request('thread/start', { cwd: home, approvalPolicy: 'on-request', sandbox: 'read-only' });
  return {
    client,
    barrier,
    requests: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
  };
}

test('managed Codex transport: bounded outbound rejection is provably not sent and does not poison the connection', async (t) => {
  const f = fixture(t);
  await f.client.initialize();
  await assert.rejects(
    f.client.request('turn/start', { payload: 'x'.repeat(1024) }),
    (e: unknown) =>
      e instanceof AppServerRequestError && e.dispatch === 'not_sent' && e.message === 'outbound_record_limit'
  );
  await f.barrier();
  assert.equal(
    f.requests().some((r) => r.method === 'turn/start'),
    false
  );
  assert.equal(f.client.snapshot().stopped, false);
  assert.equal(f.client.snapshot().observation.pending, 0);
});

test('managed Codex transport: approval validity is rechecked at actual write, not merely when queued', async (t) => {
  const f = fixture(t);
  await f.client.initialize();
  let current = true;
  const response = f.client.respond('expired-approval', { decision: 'accept' }, () => current);
  current = false;
  await response;
  await f.barrier();
  assert.equal(
    f.requests().some((r) => r.id === 'expired-approval'),
    false
  );
  assert.equal(f.client.snapshot().stopped, false);
});

test('managed Codex transport: release never signals even a non-cooperative child', async (t) => {
  const f = fixture(t, 'ignore-term');
  await f.client.initialize();
  const closed = await f.client.shutdown();
  assert.equal(closed.reaped, false);
  assert.equal(closed.signal, null);
  assert.deepEqual(await f.client.shutdown(), closed);
  assert.equal(
    f.requests().some((r) => r.signal),
    false
  );
});
