// Jev runtime: one browse job through the fake CDP browser, one judge job read-only.
// Every HUD home and state directory is temporary. Credentials are synthetic.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Browser, DEFAULT_CDP_TIMEOUT_MS } from '../../src/jev/browser.js';
import { JevRuntime } from '../../src/jev/runtime/executor.js';
import { fakeProvider } from '../../src/jev/runtime/fake.js';
import type { JevJob } from '../../src/jev/runtime/types.js';
import { startFakeCdp } from './jev-cdp-fake.js';

const SENTINEL = 'synthetic-r3-sentinel';
const session = { namespace: 'hud', sessionId: 'sess-1' };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function home(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'jev-r3-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeEnv(dir: string, body: string): void {
  const file = join(dir, 'credentials.env');
  writeFileSync(file, body, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function bothKeys(dir: string): void {
  writeEnv(dir, `TYPESAFE_API_KEY=${SENTINEL}\nOPENAI_API_KEY=${SENTINEL}-openai\nTYPESAFE_MODEL=from-env\n`);
}

function tempState(hudHome: string): string {
  const stateDir = join(hudHome, 'jev-state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return stateDir;
}

async function started(
  t: TestContext,
  hudHome: string,
  extra: ConstructorParameters<typeof JevRuntime>[0] = { hudHome }
): Promise<JevRuntime> {
  const stateDir = extra.stateDir ?? join(hudHome, 'jev-state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const runtime = new JevRuntime({
    chrome: '/synthetic/chrome',
    profile: '/synthetic/profile',
    cdpUrl: 'http://offline.invalid',
    graceMs: 60_000,
    fake: true,
    ...extra,
    hudHome,
    stateDir,
  });
  await runtime.start();
  t.after(() => runtime.stop());
  return runtime;
}

async function until(read: () => Promise<JevJob>, state: string): Promise<JevJob> {
  let latest = await read();
  for (let i = 0; i < 50 && latest.state !== state; i += 1) {
    latest = await read();
    if (latest.state === state) break;
    await delay(20);
  }
  return latest;
}

test('browse completes through the fake CDP browser', { timeout: DEFAULT_CDP_TIMEOUT_MS + 5_000 }, async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  const stateDir = tempState(hudHome);
  const fake = await startFakeCdp();
  t.after(() => fake.close());
  // complete() publishes the job before finally closes the browser. Wait for that close.
  let browserClosed = Promise.resolve();
  const runtime = await started(t, hudHome, {
    hudHome,
    stateDir,
    fake: false,
    browserFactory: async (url) => {
      const browser = await Browser.open(url, { cdpUrl: fake.httpUrl, timeoutMs: DEFAULT_CDP_TIMEOUT_MS });
      const finish = browser.close.bind(browser);
      browserClosed = new Promise((resolve, reject) => {
        browser.close = () =>
          finish().then(
            () => resolve(),
            (error: unknown) => {
              reject(error);
              throw error;
            }
          );
      });
      browserClosed.catch(() => undefined);
      // The loopback CDP stand-in does not run page JavaScript, so the marker check cannot pass.
      browser.fresh = async () => true;
      return browser;
    },
    providerFactory: () => fakeProvider(),
  });
  const job = await runtime.createJob({
    requestKey: 'cdp-1',
    session,
    input: { tag: 'browse', goal: 'Stop on the synthetic page.', url: 'http://127.0.0.1/synthetic' },
  });
  const deadline = Date.now() + DEFAULT_CDP_TIMEOUT_MS;
  let finished = await runtime.readJob(job.id);
  while (finished.state !== 'completed' && finished.state !== 'failed' && Date.now() < deadline) {
    await delay(20);
    finished = await runtime.readJob(job.id);
  }
  assert.equal(finished.state, 'completed', JSON.stringify(finished.error ?? finished.result));
  await browserClosed;
  assert.equal((finished.result as { status: string }).status, 'done');
  assert.equal(finished.provider?.id, 'typesafe');
  assert.ok(fake.navigated.includes('http://127.0.0.1/synthetic'));
  assert.equal(fake.closedTargets.length > 0, true);
  assert.equal(new URL(fake.httpUrl).hostname, '127.0.0.1');
});

test('new runtime jobs reread primary while explicit profiles stay pinned', async (t) => {
  const hudHome = home(t);
  writeEnv(hudHome, 'GEMINI_API_KEY=synthetic-google\nOPENAI_API_KEY=synthetic-openai\nTYPESAFE_API_KEY=synthetic-typesafe\n');
  const runtime = await started(t, hudHome);
  for (const [index, provider] of ['openai', 'gemini', 'typesafe'].entries()) {
    if (index === 1) writeFileSync(join(hudHome, 'config.json'), JSON.stringify({ decisions: { primary: 'gemini' } }));
    const job = await runtime.createJob({ requestKey: `provider-${index}`, session,
      ...(index === 2 ? { jevDecisions: { provider: 'typesafe' as const } } : {}),
      input: { tag: 'judge', url: 'https://example.invalid/fixture', statements: [{ name: 'ready', statement: 'The page is ready.' }] },
    });
    const finished = await until(() => runtime.readJob(job.id), 'completed');
    assert.equal(finished.state, 'completed');
    assert.equal(finished.provider?.id, provider);
  }
});

test('judge runs read-only against the fake page', async (t) => {
  const hudHome = home(t);
  bothKeys(hudHome);
  const runtime = await started(t, hudHome);
  const job = await runtime.createJob({
    requestKey: 'judge-1',
    session,
    input: {
      tag: 'judge',
      url: 'https://example.invalid/fixture',
      statements: [{ name: 'page_ready', statement: 'The page is ready.' }],
    },
  });
  const finished = await until(() => runtime.readJob(job.id), 'completed');
  const result = finished.result as { statements: Array<{ name: string; verdict: string }> };
  assert.equal(result.statements[0]?.verdict, 'pass');
  assert.equal(result.statements[0]?.name, 'page_ready');
});
