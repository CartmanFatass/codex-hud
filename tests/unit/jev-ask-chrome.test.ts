import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CHROME_MARKER,
  chromeLaunchArgs,
  chromeModeFromVersion,
  chromeStart,
  chromeStatus,
  type ChromeVersion,
} from '../../src/jev/ask/chrome.js';
import {
  ASK_ABANDON_MS,
  ASK_LIVE_LIMIT,
  ASK_MAX_WAIT_MS,
  ASK_QUEUE_LIMIT,
  type JevConfig,
} from '../../src/jev/ask/config.js';
import { JevFailure } from '../../src/jev/ask/error.js';

function workspace(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'hud-jev-chrome-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function jevConfig(stateDir: string, patch: Partial<JevConfig> = {}): JevConfig {
  return {
    cdpUrl: 'http://127.0.0.1:9222',
    chrome: '/opt/chrome-test/chrome',
    profile: '/opt/chrome-test/profile',
    userAgent: 'SyntheticAgent/1.0',
    stateDir,
    providerRoot: 'https://example.invalid/provider',
    geminiRoot: 'https://example.invalid/gemini',
    model: 'GPT-6',
    effortWord: 'Pro',
    geminiEffortLabel: 'Argon',
    keepaliveSeconds: 15,
    cdpTimeoutMs: 60_000,
    proxy: { server: 'http://127.0.0.1:9', bypass: 'example.invalid, localhost' },
    decisions: { primary: 'typesafe', fallback: 'openai', openai: {}, typesafe: {} },
    ask: {
      maxWaitMs: ASK_MAX_WAIT_MS,
      queueLimit: ASK_QUEUE_LIMIT,
      liveLimit: ASK_LIVE_LIMIT,
      abandonMs: ASK_ABANDON_MS,
    },
    ...patch,
  };
}

test('launch flags follow mode and the resolved proxy', (t) => {
  const dir = workspace(t);
  const headless = chromeLaunchArgs(jevConfig(dir), 'headless');
  assert.equal(headless[0], '/opt/chrome-test/chrome');
  assert.ok(headless.includes('--remote-debugging-port=9222'));
  assert.ok(headless.includes('--user-data-dir=/opt/chrome-test/profile'));
  assert.ok(headless.includes('--no-first-run'));
  assert.ok(headless.includes('--no-default-browser-check'));
  assert.ok(headless.includes('--window-size=1280,900'));
  assert.ok(headless.includes('--password-store=basic'));
  assert.ok(headless.includes('--headless=new'));
  assert.ok(headless.includes('--user-agent=SyntheticAgent/1.0'));
  assert.ok(headless.includes('--proxy-server=http://127.0.0.1:9'));
  assert.ok(headless.includes('--proxy-bypass-list=example.invalid;localhost'));
  assert.equal(headless.at(-1), 'about:blank');

  const headed = chromeLaunchArgs(jevConfig(dir, { proxy: {} }), 'headed');
  assert.equal(
    headed.some((arg) => arg.startsWith('--headless')),
    false
  );
  assert.equal(
    headed.some((arg) => arg.startsWith('--user-agent=')),
    false
  );
  assert.equal(
    headed.some((arg) => arg.startsWith('--proxy-')),
    false
  );
  assert.equal(headed.at(-1), 'about:blank');
  assert.equal(chromeModeFromVersion({ Browser: 'HeadlessChrome' }), 'headless');
  assert.equal(chromeModeFromVersion({ 'User-Agent': 'Chrome/1' }), 'headed');
});

test('a running browser is reused or refused, and the marker is left alone', async (t) => {
  const dir = workspace(t);
  const marker = join(dir, CHROME_MARKER);
  writeFileSync(marker, '1');
  const spawned: string[][] = [];
  const version: ChromeVersion = {
    'User-Agent': 'Chrome/1',
    Browser: 'Chrome/1',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools',
  };
  const reused = await chromeStart(jevConfig(dir), 'headless', {
    fetchVersion: () => version,
    spawn: (argv) => spawned.push(argv),
  });
  assert.deepEqual(reused, { chrome: 'reused', mode: 'headless' });
  assert.equal(spawned.length, 0);
  assert.equal(readFileSync(marker, 'utf8'), '1');

  await assert.rejects(
    () => chromeStart(jevConfig(dir), 'headed', { fetchVersion: () => version, spawn: (argv) => spawned.push(argv) }),
    (error: unknown) =>
      error instanceof JevFailure && error.message === 'Chrome already runs headless; stop it before asking for headed'
  );
  assert.equal(spawned.length, 0);
  assert.equal(readFileSync(marker, 'utf8'), '1');
});

test('start polls, records the marker, and a timeout leaves it', async (t) => {
  const dir = workspace(t);
  const marker = join(dir, CHROME_MARKER);
  let calls = 0;
  const spawned: string[][] = [];
  const started = await chromeStart(jevConfig(dir), 'headless', {
    fetchVersion: () => {
      calls += 1;
      return calls === 1 ? null : { Browser: 'Chrome/1' };
    },
    spawn: (argv) => {
      assert.equal(readFileSync(marker, 'utf8'), '1');
      spawned.push(argv);
    },
  });
  assert.equal(started.chrome, 'started');
  assert.equal(started.proxy, true);
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0]?.includes('--headless=new'));

  const headedDir = join(dir, 'headed');
  mkdirSync(headedDir);
  let headedCalls = 0;
  await chromeStart(jevConfig(headedDir), 'headed', {
    fetchVersion: () => {
      headedCalls += 1;
      return headedCalls === 1 ? null : { Browser: 'Chrome/1' };
    },
    spawn: (argv) => {
      assert.equal(existsSync(join(headedDir, CHROME_MARKER)), false);
      assert.equal(
        argv.some((arg) => arg.startsWith('--user-agent=')),
        false
      );
    },
  });

  let now = 0;
  const timeoutDir = join(dir, 'timeout');
  mkdirSync(timeoutDir);
  await assert.rejects(
    () =>
      chromeStart(jevConfig(timeoutDir), 'headless', {
        fetchVersion: () => null,
        spawn: () => undefined,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    (error: unknown) => error instanceof JevFailure && error.message === 'Chrome did not open its debugging port'
  );
  assert.equal(readFileSync(join(timeoutDir, CHROME_MARKER), 'utf8'), '1');
});

test('missing chrome or port fails before spawn', async (t) => {
  const dir = workspace(t);
  const spawned: string[][] = [];
  await assert.rejects(
    () =>
      chromeStart(jevConfig(dir, { chrome: undefined }), 'headless', {
        fetchVersion: () => null,
        spawn: (argv) => spawned.push(argv),
      }),
    (error: unknown) =>
      error instanceof JevFailure && error.code === 'pre_send' && /jev.chrome.*hud import/.test(error.message)
  );
  await assert.rejects(
    () =>
      chromeStart(jevConfig(dir, { cdpUrl: 'http://127.0.0.1' }), 'headed', {
        fetchVersion: () => null,
        spawn: (argv) => spawned.push(argv),
      }),
    (error: unknown) => error instanceof JevFailure && error.code === 'chrome'
  );
  assert.equal(spawned.length, 0);
  assert.equal(existsSync(join(dir, CHROME_MARKER)), false);
});

test('status does not spawn, a missing state dir is refused, and a missing binary is typed', async (t) => {
  const dir = workspace(t);
  const marker = join(dir, CHROME_MARKER);
  writeFileSync(marker, '1');
  const quiet = await chromeStatus(jevConfig(dir), { fetchVersion: () => null });
  assert.deepEqual(quiet, { chrome: 'not running', mode: null });
  const running = await chromeStatus(jevConfig(dir), {
    fetchVersion: () => ({ 'User-Agent': 'HeadlessChrome' }),
  });
  assert.deepEqual(running, { chrome: 'running', mode: 'headless' });

  const missing = join(dir, 'absent');
  let spawned = 0;
  await assert.rejects(
    () =>
      chromeStart(jevConfig(missing), 'headed', {
        fetchVersion: () => null,
        spawn: () => {
          spawned += 1;
        },
      }),
    (error: unknown) => error instanceof JevFailure && error.code === 'jev_state_dir_missing'
  );
  assert.equal(spawned, 0);
  assert.equal(existsSync(missing), false);

  let now = 0;
  await assert.rejects(
    () =>
      chromeStart(jevConfig(dir, { chrome: join(dir, 'missing-chrome') }), 'headed', {
        fetchVersion: () => null,
        pollMs: 1_000,
        now: () => now,
        sleep: async (ms) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          now += ms;
        },
      }),
    (error: unknown) =>
      error instanceof JevFailure && error.code === 'chrome' && error.message === 'Chrome could not be started: ENOENT'
  );
});
