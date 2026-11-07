// Ported from the owner's jev-ask (jev_send.py chrome_start/status, running_mode).
// Tests inject fetchVersion and spawn. This module does not launch Chrome unless the
// caller leaves spawn unset. There is no stop helper: the HUD does not close a Chrome
// it may not have started. src/jev/cdp.ts is a parallel worktree and is not imported.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromeProxyFlags, type JevConfig } from './config.js';
import { JevFailure } from './error.js';
import { assertStateDir } from './names.js';

export const CHROME_MARKER = 'chrome-headless';
export const CHROME_START_TIMEOUT_MS = 30_000;
export const CHROME_POLL_MS = 500;

export type ChromeMode = 'headless' | 'headed';

export interface ChromeVersion {
  'User-Agent'?: string;
  Browser?: string;
  webSocketDebuggerUrl?: string;
}

export interface ChromeSpawnHandle {
  /** The latest spawn error, if the child has already reported one. */
  error?: () => Error | undefined;
}

export interface ChromeDeps {
  fetchVersion: (cdpUrl: string) => ChromeVersion | null | Promise<ChromeVersion | null>;
  /** Return value is ignored except for `{ error }` from the real spawn. */
  spawn?: (argv: string[], options: { logPath: string }) => unknown;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

export interface ChromeStartResult {
  chrome: 'reused' | 'started';
  mode: ChromeMode;
  proxy?: boolean;
}

export function chromeModeFromVersion(version: ChromeVersion): ChromeMode {
  const blob = `${version['User-Agent'] ?? ''}${version.Browser ?? ''}`;
  return blob.includes('Headless') ? 'headless' : 'headed';
}

/** The driver's headless Chrome keeps a headed user agent, so the marker wins. */
export function runningMode(stateDir: string, version: ChromeVersion): ChromeMode {
  return fs.existsSync(markerPath(stateDir)) ? 'headless' : chromeModeFromVersion(version);
}

export function chromeLaunchArgs(config: JevConfig, mode: ChromeMode): string[] {
  if (!config.chrome) throw new JevFailure('chrome', 'chrome executable is not configured');
  if (!config.profile) throw new JevFailure('chrome', 'chrome profile is not configured');
  const argv = [
    config.chrome,
    `--remote-debugging-port=${cdpPort(config.cdpUrl)}`,
    `--user-data-dir=${config.profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    '--password-store=basic',
  ];
  if (mode === 'headless') argv.push('--headless=new', `--user-agent=${config.userAgent}`);
  argv.push(...chromeProxyFlags(config.proxy), 'about:blank');
  return argv;
}

/**
 * One Chrome on the logged-in profile. A running browser in the other mode is reported
 * and left alone: this function does not kill it and does not spawn a second one.
 */
export async function chromeStart(config: JevConfig, mode: ChromeMode, deps: ChromeDeps): Promise<ChromeStartResult> {
  assertStateDir(config.stateDir);
  const version = await loadVersion(config.cdpUrl, deps);
  if (version) {
    const running = runningMode(config.stateDir, version);
    if (running !== mode) {
      throw new JevFailure('chrome', `Chrome already runs ${running}; stop it before asking for ${mode}`);
    }
    return { chrome: 'reused', mode };
  }
  const argv = chromeLaunchArgs(config, mode);
  const marker = markerPath(config.stateDir);
  if (mode === 'headless') fs.writeFileSync(marker, '1', { encoding: 'utf8', mode: 0o600 });
  else fs.rmSync(marker, { force: true });
  const logPath = path.join(config.stateDir, 'chrome.log');
  fs.closeSync(fs.openSync(logPath, 'a', 0o600));
  const spawned = (deps.spawn ?? defaultSpawn)(argv, { logPath });
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const poll = deps.pollMs ?? CHROME_POLL_MS;
  const deadline = now() + CHROME_START_TIMEOUT_MS;
  for (let attempt = 0; attempt < 70 && now() < deadline; attempt += 1) {
    const failed = spawnFailure(spawned);
    if (failed) {
      const code = (failed as NodeJS.ErrnoException).code ?? 'error';
      throw new JevFailure('chrome', `Chrome could not be started: ${code}`);
    }
    if (await loadVersion(config.cdpUrl, deps)) {
      return { chrome: 'started', mode, proxy: chromeProxyFlags(config.proxy).length > 0 };
    }
    await sleep(poll);
  }
  const failed = spawnFailure(spawned);
  if (failed) {
    const code = (failed as NodeJS.ErrnoException).code ?? 'error';
    throw new JevFailure('chrome', `Chrome could not be started: ${code}`);
  }
  throw new JevFailure('chrome', 'Chrome did not open its debugging port');
}

export async function chromeStatus(
  config: JevConfig,
  deps: ChromeDeps
): Promise<{ chrome: 'running'; mode: ChromeMode } | { chrome: 'not running'; mode: null }> {
  const version = await loadVersion(config.cdpUrl, deps);
  if (!version) return { chrome: 'not running', mode: null };
  return { chrome: 'running', mode: runningMode(config.stateDir, version) };
}

function markerPath(stateDir: string): string {
  return path.join(stateDir, CHROME_MARKER);
}

function cdpPort(cdpUrl: string): string {
  let url: URL;
  try {
    url = new URL(cdpUrl);
  } catch {
    throw new JevFailure('chrome', 'cdp URL must include a port');
  }
  if (!url.port) throw new JevFailure('chrome', 'cdp URL must include a port');
  return url.port;
}

async function loadVersion(cdpUrl: string, deps: ChromeDeps): Promise<ChromeVersion | null> {
  try {
    return (await deps.fetchVersion(cdpUrl)) ?? null;
  } catch {
    return null;
  }
}

function defaultSpawn(argv: string[], options: { logPath: string }): ChromeSpawnHandle {
  const logFd = fs.openSync(options.logPath, 'a', 0o600);
  let spawnError: Error | undefined;
  let child: ChildProcess | undefined;
  try {
    child = nodeSpawn(argv[0]!, argv.slice(1), {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.once('error', (error) => {
      spawnError = error;
    });
    child.unref();
  } catch (error) {
    spawnError = error instanceof Error ? error : new Error(String(error));
  } finally {
    fs.closeSync(logFd);
  }
  return { error: () => spawnError };
}

function spawnFailure(handle: unknown): Error | undefined {
  if (!handle || typeof handle !== 'object' || !('error' in handle)) return undefined;
  const read = (handle as ChromeSpawnHandle).error;
  if (typeof read !== 'function') return undefined;
  const error = read();
  return error instanceof Error ? error : undefined;
}
