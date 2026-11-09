// R3 live-smoke regressions. All config/state is temporary; only fake CDP is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { awaitState } from '../../src/jev/judge.js';
import { connectJevExecutor } from '../../src/jev/runtime/client.js';
import { JevRuntime } from '../../src/jev/runtime/executor.js';
import { fakeProvider } from '../../src/jev/runtime/fake.js';
import { errorBody, jevCall } from '../../src/jev/runtime/ipc.js';

function workspace(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-r3f-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function unusedCdpUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return url;
}

test('R3F production child discovers HUD JSON and explicit env TOML with HUD-home overrides', async (t) => {
  const root = workspace(t);
  const saved = { HOME: process.env.HOME, JEV_ASK_CONFIG: process.env.JEV_ASK_CONFIG };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.HOME = root;
  delete process.env.JEV_ASK_CONFIG;
  const defaultDir = join(root, '.config', 'jev-ask');
  mkdirSync(defaultDir, { recursive: true });
  const state = join(root, 'shared-state');
  mkdirSync(state);
  writeFileSync(
    join(defaultDir, 'config.toml'),
    `[jev]\nstate_dir=${JSON.stringify(state)}\ncdp_url="http://127.0.0.1:1"\n`
  );
  // A default-home HUD config must not displace the explicit runtime HUD home.
  mkdirSync(join(root, '.hud'));
  writeFileSync(join(root, '.hud', 'config.json'), JSON.stringify({ jev: { stateDir: join(root, 'wrong-state') } }));

  for (const source of ['hud-json', 'env', 'overlay', 'json-only']) {
    const hudHome = join(root, source);
    mkdirSync(hudHome);
    if (source === 'hud-json') {
      writeFileSync(join(hudHome, 'config.json'), JSON.stringify({ jev: { stateDir: state } }));
    } else {
      process.env.JEV_ASK_CONFIG = join(root, 'selected.toml');
      if (source === 'env') {
        // Ignoring JEV_ASK_CONFIG now fails rather than falling back successfully.
        writeFileSync(join(defaultDir, 'config.toml'), '[jev]\nstate_dir="/missing-synthetic-default"\n');
        writeFileSync(process.env.JEV_ASK_CONFIG, `[jev]\nstate_dir=${JSON.stringify(state)}\n`);
      } else {
        if (source === 'overlay') {
          writeFileSync(process.env.JEV_ASK_CONFIG, '[jev]\nstate_dir="/missing-synthetic-state"\n');
        } else {
          process.env.JEV_ASK_CONFIG = join(root, 'absent.toml');
        }
        writeFileSync(
          join(hudHome, 'config.json'),
          JSON.stringify({
            jev: { stateDir: state, proxy: { server: 'http://proxy.example.invalid:8080', bypass: 'example.invalid' } },
          })
        );
      }
    }
    const handle = await connectJevExecutor(hudHome, { fake: true, graceMs: 60_000 });
    const pid = (await handle.status()).pid;
    t.after(() => {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    });
    if (source === 'overlay' || source === 'json-only') {
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      assert.ok(env.includes('HTTPS_PROXY=http://proxy.example.invalid:8080'));
      assert.ok(env.includes('NO_PROXY=127.0.0.1,localhost,example.invalid'));
    }
    process.kill(pid, 'SIGTERM');
  }
});

test('R3F independently allocated array/object markers compare by value', async () => {
  let clock = 0;
  let reads = 0;
  const result = await awaitState(
    { name: 'page_ready', statement: 'The page is ready.' },
    {
      async observe() {
        reads += 1;
        // A real marker is a fresh array containing semantic action objects.
        const action = reads % 2 ? { id: 'e1', kind: 'click' } : { kind: 'click', id: 'e1' };
        return {
          page: { url: 'https://example.invalid/', title: 'Fixture', text: 'Hello' },
          elements: [],
          deltas: {},
          facts: {
            readyState: 'complete',
            marker: [1, 'https://example.invalid/', 0, 0, 1280, 900, 'Fixture', 'Hello', [action], 0],
          },
        };
      },
    },
    { judge: (request, options) => fakeProvider().judge!(request, options) },
    {
      maxMs: 1000,
      maxLoadMs: 1000,
      maxCalls: 1,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    }
  );
  assert.equal(result.verdict, 'pass');
  assert.equal(result.calls, 1);
  assert.equal(reads, 2);
  assert.equal(result.extendedMs, 0);
});

test('R3F no CDP and no configured Chrome produces public browser_unavailable', async (t) => {
  const hudHome = workspace(t);
  const stateDir = join(hudHome, 'state');
  mkdirSync(stateDir);
  writeFileSync(join(hudHome, 'jev.env'), 'TYPESAFE_API_KEY=synthetic-r3f-key\n', { mode: 0o600 });
  const runtime = new JevRuntime({
    hudHome,
    stateDir,
    cdpUrl: await unusedCdpUrl(),
    graceMs: 60_000,
    providerFactory: () => fakeProvider(),
  });
  await runtime.start();
  t.after(() => runtime.stop());
  const job = await runtime.createJob({
    requestKey: 'missing-browser',
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
  assert.deepEqual(errorBody({ code: 'browser_unavailable', message: 'browser_unavailable' }), {
    code: 'browser_unavailable',
    message: 'browser_unavailable',
  });
  const ipc = await jevCall(join(hudHome, 'jev-runtime', 'runtime.sock'), 'readJob', { jobId: job.id });
  assert.equal((ipc as typeof done).error?.code, 'browser_unavailable');
});

test('R3F explicit stateDir skips the production config loader under an empty HOME', async (t) => {
  const root = workspace(t);
  const saved = { HOME: process.env.HOME, JEV_ASK_CONFIG: process.env.JEV_ASK_CONFIG };
  process.env.HOME = root;
  process.env.JEV_ASK_CONFIG = join(root, 'unused-synthetic.toml');
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const stateDir = join(root, 'state');
  mkdirSync(stateDir);
  let loads = 0;
  const runtime = new JevRuntime({
    hudHome: root,
    stateDir,
    fake: true,
    graceMs: 60_000,
    configLoader: () => {
      loads += 1;
      throw new Error('must not load configuration');
    },
  });
  await runtime.start();
  t.after(() => runtime.stop());
  assert.equal(loads, 0);
  assert.equal(runtime.stateDir, stateDir);
});

test('R3F genuinely changing array markers still defer judgments until stable', async () => {
  for (const settles of [true, false]) {
    let clock = 0;
    let reads = 0;
    const outcome = await awaitState(
      { name: 'page_ready', statement: 'Ready.' },
      {
        async observe() {
          reads += 1;
          return {
            page: { url: 'https://example.invalid/', title: 'Fixture', text: 'Hello' },
            elements: [],
            deltas: {},
            facts: { readyState: 'complete', marker: [settles ? Math.min(reads, 2) : reads, { nested: ['text'] }] },
          };
        },
      },
      { judge: (request, options) => fakeProvider().judge!(request, options) },
      {
        maxMs: 1000,
        maxLoadMs: 1000,
        maxCalls: 1,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }
    );
    assert.equal(outcome.verdict, settles ? 'pass' : 'timeout');
    assert.equal(outcome.calls, settles ? 1 : 0);
    assert.equal(outcome.extendedMs, 1000);
  }
});
