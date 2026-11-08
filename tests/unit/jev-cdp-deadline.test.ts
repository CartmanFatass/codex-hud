// CDP HTTP deadline regressions: synthetic loopback port 0 only.
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { loopbackJson } from '../../src/jev/cdp.js';
import { JevRuntime } from '../../src/jev/runtime/executor.js';
import { fakeProvider } from '../../src/jev/runtime/fake.js';

async function endpoint(t: TestContext, body: (res: ServerResponse) => void): Promise<string> {
  const server = createServer((_req, res) => body(res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function boundedProbe(url: string): Promise<void> {
  let watchdog: NodeJS.Timeout | undefined;
  const started = Date.now();
  try {
    await assert.rejects(
      Promise.race([
        loopbackJson(`${url}/json/version`, 100),
        new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(() => reject(new Error('probe_still_pending')), 800);
        }),
      ]),
      /cdp_http_(closed|aborted|timeout)/
    );
    assert.ok(Date.now() - started < 800);
  } finally {
    clearTimeout(watchdog);
  }
}

test('R3F truncated CDP response rejects instead of leaving the probe pending', async (t) => {
  const url = await endpoint(t, (res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
    res.write('{"partial":');
    const timer = setTimeout(() => res.destroy(), 10);
    res.once('close', () => clearTimeout(timer));
  });
  await boundedProbe(url);

  const root = mkdtempSync(join(tmpdir(), 'jev-r3f-truncated-'));
  const stateDir = join(root, 'state');
  mkdirSync(stateDir);
  writeFileSync(join(root, 'jev.env'), 'TYPESAFE_API_KEY=synthetic-deadline-key\n', { mode: 0o600 });
  const runtime = new JevRuntime({
    hudHome: root,
    stateDir,
    cdpUrl: url,
    graceMs: 60_000,
    providerFactory: () => fakeProvider(),
  });
  t.after(async () => {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await runtime.start();
  const job = await runtime.createJob({
    requestKey: 'truncated',
    session: { namespace: 'hud', sessionId: 'r3f' },
    input: { tag: 'judge', url: 'https://example.invalid/', statements: [{ name: 'page_ready', statement: 'Ready.' }] },
  });
  let done = await runtime.readJob(job.id);
  for (let i = 0; i < 100 && done.state === 'running'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    done = await runtime.readJob(job.id);
  }
  assert.equal(done.state, 'failed');
  assert.equal(done.error?.code, 'browser_unavailable');
});

test('R3F trickling CDP response cannot extend the absolute HTTP deadline', async (t) => {
  const url = await endpoint(t, (res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"padding":"');
    const interval = setInterval(() => res.write('x'), 10);
    res.once('close', () => clearInterval(interval));
  });
  await boundedProbe(url);
});
