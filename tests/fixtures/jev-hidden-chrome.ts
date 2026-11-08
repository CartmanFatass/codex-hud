// Real browser coverage, isolated from the owner's CDP/profile. No provider access.
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { CdpConnection } from '../../src/jev/cdp.js';

function chromeBinary(): string | undefined {
  if (process.env.HUD_TEST_CHROME) {
    accessSync(process.env.HUD_TEST_CHROME, constants.X_OK);
    return process.env.HUD_TEST_CHROME;
  }
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  const versions = readdirSync(cache)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    for (const layout of ['chrome-linux64', 'chrome-linux']) {
      const binary = join(cache, version, layout, 'chrome');
      try {
        accessSync(binary, constants.X_OK);
        return binary;
      } catch {
        /* try the next installed version */
      }
    }
  }
  return undefined;
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}
async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitBounded(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function hiddenChrome(t: TestContext): Promise<{ cdp: CdpConnection; url: string } | undefined> {
  // Shared-endpoint regression evidence is explicitly opt-in, never a unit default.
  if (process.env.HUD_TEST_SHARED_CDP === '1') {
    const url = 'http://127.0.0.1:9222';
    const cdp = await CdpConnection.connect(url, 1_000);
    t.after(() => cdp.close());
    return { cdp, url };
  }
  const binary = chromeBinary();
  if (!binary) {
    t.skip('No isolated Chrome: set HUD_TEST_CHROME or install Playwright Chromium in ~/.cache/ms-playwright');
    return undefined;
  }
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'jev-hidden-chrome-'));
  const url = `http://127.0.0.1:${port}`;
  // about:blank is the owned foreground page; T9 creates a second background target.
  const child = spawn(
    binary,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${new URL(url).port}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        HOME: profile,
        XDG_CONFIG_HOME: join(profile, 'config'),
        XDG_CACHE_HOME: join(profile, 'cache'),
      },
    }
  );
  let spawnError: Error | undefined;
  child.once('error', (error) => {
    spawnError = error;
  });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  let cdp: CdpConnection | undefined;
  t.after(async () => {
    if (cdp) {
      await cdp.call('Browser.close', {}, { timeoutMs: 1_000 }).catch(() => undefined);
      cdp.close();
    }
    // This process group was created by this fixture, never kill by name/pattern.
    const signal = (name: NodeJS.Signals) => {
      if (child.pid)
        try {
          process.kill(-child.pid, name);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
    };
    signal('SIGTERM');
    await waitBounded(exited, 2_000);
    signal('SIGKILL');
    await waitBounded(exited, 2_000);
    if (child.pid && child.exitCode === null && child.signalCode === null)
      throw new Error('owned_chrome_cleanup_failed');
    rmSync(profile, { recursive: true, force: true });
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !spawnError && child.exitCode === null && child.signalCode === null) {
    try {
      cdp = await CdpConnection.connect(url, 300);
      return { cdp, url };
    } catch {
      await delay(30);
    }
  }
  throw new Error('isolated_chrome_start_failed');
}
