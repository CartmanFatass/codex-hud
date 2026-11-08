// R4/R3F integration: the RuntimeChrome in-flight gate. Synthetic only: the start
// and the version probe are injected fakes, so no real Chrome, port, profile,
// provider or user config is touched, and no process is spawned.

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChromeDeps, ChromeMode, ChromeStartResult, ChromeVersion } from '../../src/jev/ask/chrome.js';
import { loadJevConfig, type JevConfig } from '../../src/jev/ask/config.js';
import { JevRuntimeError, RuntimeChrome } from '../../src/jev/runtime/executor.js';

const STATE_DIR = '/tmp/synthetic-r4-state';
const PROFILE = '/opt/synthetic/r4-profile';
const DEFAULT_CDP = 'http://127.0.0.1:9222';
const ACCOUNT_CDP = 'http://127.0.0.1:9333';
const ACCOUNT_WS = 'ws://127.0.0.1:9333/devtools/browser/synthetic-r4';

type StartFn = ConstructorParameters<typeof RuntimeChrome>[0];
type FetchVersionFn = ConstructorParameters<typeof RuntimeChrome>[1];

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A full synthetic config. Nothing on disk is read: no TOML path and no config.json path. */
function config(): JevConfig {
  return loadJevConfig({ configJson: { jev: { stateDir: STATE_DIR, profile: PROFILE } } });
}

interface StartCall {
  config: JevConfig;
  mode: ChromeMode;
  deps: ChromeDeps;
}

interface ProbeCall {
  url: string;
  remainingMs?: number;
}

/** The only start a test ever sees. The real `chromeStart` is never imported as a value here. */
function recordingStart(gate: Promise<ChromeStartResult>): { start: StartFn; calls: StartCall[] } {
  const calls: StartCall[] = [];
  const start: StartFn = (cfg, mode, deps) => {
    calls.push({ config: cfg, mode, deps });
    return gate;
  };
  return { start, calls };
}

function recordingProbe(version: ChromeVersion | null | Error): { fetchVersion: FetchVersionFn; probes: ProbeCall[] } {
  const probes: ProbeCall[] = [];
  const fetchVersion: FetchVersionFn = async (cdpUrl, remainingMs) => {
    probes.push({ url: cdpUrl, remainingMs });
    if (version instanceof Error) throw version;
    return version;
  };
  return { fetchVersion, probes };
}

test('concurrent ensures on the default endpoint share exactly one start', async () => {
  const cfg = config();
  const gate = deferred<ChromeStartResult>();
  const { start, calls } = recordingStart(gate.promise);
  const { fetchVersion, probes } = recordingProbe(null);
  const chrome = new RuntimeChrome(start, fetchVersion);

  const settled: string[] = [];
  const consumers = ['ChatGPT', 'browse', 'judge'].map((label) =>
    chrome.ensure(cfg, DEFAULT_CDP).then(() => {
      settled.push(label);
    })
  );

  // The gate is still held: one start for three consumers, none of them settled.
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.deepEqual(settled, []);

  gate.resolve({ chrome: 'reused', mode: 'headless' });
  await Promise.all(consumers);

  assert.deepEqual(settled.sort(), ['ChatGPT', 'browse', 'judge']);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.mode, 'headless');
  assert.equal(call.deps.reuseAnyMode, true);
  assert.equal(call.deps.fetchVersion, fetchVersion);
  assert.equal(call.config, cfg);
  assert.equal(call.config.profile, PROFILE);
  assert.equal(call.config.stateDir, STATE_DIR);
  assert.equal(probes.length, 0);
});

test('a custom account endpoint does not join the default in-flight gate', async () => {
  const cfg = config();
  const gate = deferred<ChromeStartResult>();
  const { start, calls } = recordingStart(gate.promise);
  const { fetchVersion, probes } = recordingProbe({ webSocketDebuggerUrl: ACCOUNT_WS });
  const chrome = new RuntimeChrome(start, fetchVersion);

  let defaultDone = false;
  const defaultEnsure = chrome.ensure(cfg, DEFAULT_CDP).then(() => {
    defaultDone = true;
  });
  await chrome.ensure(cfg, ACCOUNT_CDP);

  // The account probe resolved while the default start is still held.
  assert.equal(defaultDone, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(probes, [{ url: ACCOUNT_CDP, remainingMs: cfg.cdpTimeoutMs }]);

  gate.resolve({ chrome: 'started', mode: 'headless' });
  await defaultEnsure;
  assert.equal(defaultDone, true);
  assert.equal(calls.length, 1);
});

test('an unreachable account endpoint is a typed browser_unavailable and never starts', async () => {
  const cfg = config();
  const { start, calls } = recordingStart(Promise.resolve({ chrome: 'started', mode: 'headless' }));
  const { fetchVersion } = recordingProbe(new Error('probe refused'));
  const chrome = new RuntimeChrome(start, fetchVersion);

  await assert.rejects(chrome.ensure(cfg, ACCOUNT_CDP), (error: unknown) => {
    assert.ok(error instanceof JevRuntimeError);
    assert.equal(error.name, 'JevRuntimeError');
    assert.equal(error.code, 'browser_unavailable');
    assert.equal(error.message, 'browser_unavailable: account');
    assert.ok(!error.message.includes(ACCOUNT_CDP));
    assert.ok(!error.message.includes(DEFAULT_CDP));
    assert.ok(!error.message.includes(PROFILE));
    return true;
  });
  assert.equal(calls.length, 0);
});

test('a reachable account endpoint is reused without a start and probed only at its own URL', async () => {
  const cfg = config();
  const { start, calls } = recordingStart(Promise.resolve({ chrome: 'started', mode: 'headless' }));
  const { fetchVersion, probes } = recordingProbe({ webSocketDebuggerUrl: ACCOUNT_WS });
  const chrome = new RuntimeChrome(start, fetchVersion);

  await chrome.ensure(cfg, ACCOUNT_CDP);

  assert.equal(calls.length, 0);
  assert.deepEqual(probes, [{ url: ACCOUNT_CDP, remainingMs: cfg.cdpTimeoutMs }]);
});

test('a failed default start rejects every concurrent consumer and the next ensure retries', async () => {
  const cfg = config();
  const first = deferred<ChromeStartResult>();
  const calls: StartCall[] = [];
  const start: StartFn = (cfgIn, mode, deps) => {
    calls.push({ config: cfgIn, mode, deps });
    return calls.length === 1 ? first.promise : Promise.resolve({ chrome: 'started', mode: 'headless' });
  };
  const { fetchVersion } = recordingProbe(null);
  const chrome = new RuntimeChrome(start, fetchVersion);

  const consumers = [chrome.ensure(cfg, DEFAULT_CDP), chrome.ensure(cfg, DEFAULT_CDP)];
  first.reject(new Error('synthetic spawn failure'));
  const results = await Promise.allSettled(consumers);

  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    const error = (result as PromiseRejectedResult).reason as unknown;
    assert.ok(error instanceof JevRuntimeError);
    assert.equal(error.code, 'browser_unavailable');
    assert.equal(error.message, 'browser_unavailable');
  }
  assert.equal(calls.length, 1);

  // The failed gate is gone, so the next ensure starts again and succeeds.
  await chrome.ensure(cfg, DEFAULT_CDP);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].mode, 'headless');
  assert.equal(calls[1].deps.reuseAnyMode, true);
});

test('the mode accessor keeps the started mode, not the requested headless mode', async () => {
  const cfg = config();
  const { start, calls } = recordingStart(Promise.resolve({ chrome: 'started', mode: 'headed' }));
  const { fetchVersion } = recordingProbe(null);
  const chrome = new RuntimeChrome(start, fetchVersion);

  await chrome.ensure(cfg, DEFAULT_CDP);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, 'headless', 'the runtime asks for headless');
  assert.equal(chrome.mode(DEFAULT_CDP), 'headed', 'the accessor reports the actual started mode');
  assert.equal(chrome.mode(`${DEFAULT_CDP}/`), 'headed', 'the endpoint is normalized before lookup');
  assert.equal(chrome.mode(ACCOUNT_CDP), undefined, 'an unstarted endpoint has no mode');
});

test('a malformed endpoint is a typed browser_unavailable with no start and no probe', async () => {
  const cfg = config();
  const { start, calls } = recordingStart(Promise.resolve({ chrome: 'started', mode: 'headless' }));
  const { fetchVersion, probes } = recordingProbe({ webSocketDebuggerUrl: ACCOUNT_WS });
  const chrome = new RuntimeChrome(start, fetchVersion);

  await assert.rejects(chrome.ensure(cfg, 'not a url'), (error: unknown) => {
    assert.ok(error instanceof JevRuntimeError);
    assert.equal(error.code, 'browser_unavailable');
    assert.equal(error.message, 'browser_unavailable');
    return true;
  });
  assert.equal(calls.length, 0);
  assert.equal(probes.length, 0);
});
