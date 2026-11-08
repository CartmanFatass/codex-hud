// R3F chrome start: a synthetic executable records argv and serves fake CDP.
// No real browser, provider, port 9222, user config or user profile is touched.
// Every directory is temporary; the only process killed is the recorded fake PID.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CHROME_MARKER, CHROME_START_TIMEOUT_MS, chromeStart, type ChromeVersion } from '../../src/jev/ask/chrome.js';
import { loadJevConfig, type JevConfig } from '../../src/jev/ask/config.js';
import { JevFailure } from '../../src/jev/ask/error.js';
import { JevRuntime } from '../../src/jev/runtime/executor.js';
import { fakeProvider } from '../../src/jev/runtime/fake.js';

const SESSION = { namespace: 'hud', sessionId: 'r3f-chrome' };

function workspace(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'jev-r3f-chrome-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A loopback port that was just free. Synthetic only: never 9222. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A full synthetic config, built the same way the runtime's loader wraps one. */
function syntheticConfig(
  stateDir: string,
  patch: { chrome?: string; profile?: string; cdpUrl?: string } = {}
): JevConfig {
  return loadJevConfig({
    configJson: {
      jev: {
        stateDir,
        cdpUrl: patch.cdpUrl ?? 'http://127.0.0.1:9',
        chrome: patch.chrome ?? '/opt/synthetic/chrome',
        profile: patch.profile ?? '/opt/synthetic/profile',
        userAgent: 'SyntheticAgent/1.0',
        proxy: { server: 'http://127.0.0.1:9', bypass: 'example.invalid, localhost' },
      },
    },
  });
}

/**
 * A stand-in Chrome: records its argv and PID, then serves the compiled fake CDP
 * on the port it was told to debug. It never opens a real browser.
 */
function writeChromeScript(dir: string, argvFile: string, pidFile: string): string {
  const script = join(dir, 'fake-chrome.mjs');
  const fakeCdp = new URL('./jev-cdp-fake.js', import.meta.url).href;
  const lines = [
    `#!${process.execPath}`,
    `import { writeFileSync } from 'node:fs';`,
    `const flags = process.argv.slice(2);`,
    `const portFlag = flags.find((flag) => flag.startsWith('--remote-debugging-port=')) ?? '';`,
    `const port = Number(portFlag.slice('--remote-debugging-port='.length));`,
    `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify({ exec: process.argv[0], script: process.argv[1], flags }));`,
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    `const { startFakeCdp } = await import(${JSON.stringify(fakeCdp)});`,
    `await startFakeCdp({ port });`,
    '',
  ];
  writeFileSync(script, lines.join('\n'), { mode: 0o755 });
  chmodSync(script, 0o755);
  return script;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await delay(20);
  }
  return !alive(pid);
}

function recordedPid(file: string): number | undefined {
  if (!existsSync(file)) return undefined;
  const pid = Number(readFileSync(file, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

test('R3F runtime starts the configured Chrome headless against fake CDP', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'jev-r3f-runtime-chrome-'));
  const hudHome = join(root, 'hud');
  const stateDir = join(root, 'state');
  const profile = join(root, 'profile with spaces');
  const argvFile = join(root, 'chrome-argv.json');
  const pidFile = join(root, 'chrome-pid');
  mkdirSync(hudHome);
  mkdirSync(stateDir);
  mkdirSync(profile);
  writeFileSync(join(hudHome, 'jev.env'), 'TYPESAFE_API_KEY=synthetic-r3f-chrome-key\n', { mode: 0o600 });

  const port = await freePort();
  const chrome = writeChromeScript(root, argvFile, pidFile);
  const config = syntheticConfig(stateDir, { chrome, profile, cdpUrl: `http://127.0.0.1:${port}` });

  let runtime: JevRuntime | undefined;
  t.after(async () => {
    await runtime?.stop().catch(() => undefined);
    // Kill only the PID this run recorded, then wait for it before deleting data.
    const pid = recordedPid(pidFile);
    if (pid !== undefined) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
      await waitDead(pid, 5_000);
    }
    rmSync(root, { recursive: true, force: true });
  });

  runtime = new JevRuntime({
    hudHome,
    graceMs: 60_000,
    fake: false,
    configLoader: () => config,
    providerFactory: () => fakeProvider(),
  });
  await runtime.start();

  const job = await runtime.createJob({
    requestKey: 'chrome-start',
    session: SESSION,
    input: {
      tag: 'judge',
      url: 'https://example.invalid/chrome-start',
      statements: [{ name: 'page_ready', statement: 'The page is ready.' }],
    },
  });
  let done = await runtime.readJob(job.id);
  for (let i = 0; i < 200 && done.state !== 'completed' && done.state !== 'failed'; i += 1) {
    await delay(25);
    done = await runtime.readJob(job.id);
  }
  assert.equal(done.state, 'completed', JSON.stringify(done.error ?? done.result));
  const result = done.result as { statements: Array<{ name: string; verdict: string }>; calls: number };
  assert.equal(result.calls, 1);
  assert.equal(result.statements[0]?.verdict, 'pass');

  const recorded = JSON.parse(readFileSync(argvFile, 'utf8')) as {
    exec: string;
    script: string;
    flags: string[];
  };
  assert.equal(recorded.exec, process.execPath);
  assert.equal(recorded.script, chrome);
  const flags = recorded.flags;
  assert.ok(flags.includes(`--remote-debugging-port=${port}`));
  assert.ok(flags.includes(`--user-data-dir=${profile}`));
  assert.ok(flags.includes('--no-first-run'));
  assert.ok(flags.includes('--no-default-browser-check'));
  assert.ok(flags.includes('--window-size=1280,900'));
  assert.ok(flags.includes('--password-store=basic'));
  assert.ok(flags.includes('--headless=new'));
  assert.ok(flags.includes('--user-agent=SyntheticAgent/1.0'));
  assert.ok(flags.includes('--proxy-server=http://127.0.0.1:9'));
  assert.ok(flags.includes('--proxy-bypass-list=example.invalid;localhost'));
  assert.equal(flags.at(-1), 'about:blank');

  assert.equal(existsSync(join(stateDir, 'chrome.log')), true);
  assert.equal(readFileSync(join(stateDir, CHROME_MARKER), 'utf8'), '1');

  const pid = recordedPid(pidFile);
  assert.ok(pid !== undefined);
  await runtime.stop();
  // The runtime never stops a shared Chrome, so the detached fake stays alive.
  assert.equal(alive(pid), true);
});

test('R3F chromeStart refuses a missing executable without launching Chrome', async (t) => {
  const dir = workspace(t);
  const missing = join(dir, 'missing-chrome');
  const started = Date.now();
  await assert.rejects(
    () =>
      chromeStart(syntheticConfig(dir, { chrome: missing }), 'headless', {
        // Real spawn: the synthetic path does not exist, so no browser can start.
        fetchVersion: () => null,
        pollMs: 10,
      }),
    (error: unknown) =>
      error instanceof JevFailure && error.code === 'chrome' && error.message === 'Chrome could not be started: ENOENT'
  );
  assert.ok(Date.now() - started < 5_000);
  assert.equal(existsSync(missing), false);
  // The marker is written before the spawn attempt, as for any headless start.
  assert.equal(readFileSync(join(dir, CHROME_MARKER), 'utf8'), '1');
});

test('R3F reuseAnyMode reuses a headed Chrome for a headless request', async (t) => {
  const dir = workspace(t);
  const version: ChromeVersion = { 'User-Agent': 'Chrome/1', Browser: 'Chrome/1' };
  let spawns = 0;
  const spawn = () => {
    spawns += 1;
  };

  const reused = await chromeStart(syntheticConfig(dir), 'headless', {
    fetchVersion: () => version,
    reuseAnyMode: true,
    spawn,
  });
  assert.deepEqual(reused, { chrome: 'reused', mode: 'headed' });
  assert.equal(spawns, 0);
  assert.equal(existsSync(join(dir, CHROME_MARKER)), false);

  // Without reuseAnyMode the existing opposite-mode refusal stays.
  await assert.rejects(
    () => chromeStart(syntheticConfig(dir), 'headless', { fetchVersion: () => version, spawn }),
    (error: unknown) =>
      error instanceof JevFailure &&
      error.code === 'chrome' &&
      error.message === 'Chrome already runs headed; stop it before asking for headless'
  );
  assert.equal(spawns, 0);
  assert.equal(existsSync(join(dir, CHROME_MARKER)), false);
});

test('R3F chromeStart bounds every probe and sleep by the 30 s deadline', async (t) => {
  const dir = workspace(t);
  let clock = 0;
  const remainings: number[] = [];
  let spawns = 0;

  await assert.rejects(
    () =>
      chromeStart(syntheticConfig(dir), 'headless', {
        fetchVersion: (_cdpUrl, remainingMs) => {
          const remaining = remainingMs ?? -1;
          remainings.push(remaining);
          // A probe is bounded by the remaining budget, and it advances the clock.
          clock += Math.min(700, remaining);
          return null;
        },
        spawn: () => {
          spawns += 1;
        },
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    (error: unknown) =>
      error instanceof JevFailure &&
      error.code === 'chrome' &&
      error.message === 'Chrome did not open its debugging port'
  );

  assert.equal(spawns, 1);
  assert.ok(remainings.length > 1);
  assert.equal(remainings[0], CHROME_START_TIMEOUT_MS);
  for (const remaining of remainings) {
    assert.ok(remaining > 0 && remaining <= CHROME_START_TIMEOUT_MS, `remaining ${remaining}`);
  }
  for (let i = 1; i < remainings.length; i += 1) {
    assert.ok(remainings[i]! < remainings[i - 1]!, `probe ${i} remaining ${remainings[i]}`);
  }
  // Initial probe plus every sleep stays inside the one 30 s budget.
  assert.ok(clock <= CHROME_START_TIMEOUT_MS, `elapsed ${clock}`);
});
