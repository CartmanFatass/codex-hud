import * as fs from 'node:fs';
import { getHudHome } from '../hud-home.js';
import { settingsPath } from '../settings.js';
import type { ExpConfig } from '../exp-config.js';
import {
  proxyDueAt,
  proxyIntervalMs,
  proxyWindows,
  type ExpProxyReading,
  type ExpProxySnapshot,
} from '../exp-proxy.js';
import {
  expProxyPath,
  parseProxySnapshot,
  proxyBindingVersion,
  readExpConfig,
  readExpConfigAsync,
} from './exp-store.js';
import { readCodexProxy, type ProxyRpcResult } from './exp-codex-rpc.js';
import { tryExpLock } from './exp-lock.js';
import { writePrivateFile } from './small-model.js';

const stamp = (s: fs.Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
export type ProxyObservation = ExpProxyReading & {
  settingsVersion: string;
  proxy: ExpConfig['proxy'] & { profile: string };
};

async function experimentVersion(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const file = await fs.promises.open(settingsPath(env), 'r');
  try {
    const s = await file.stat();
    if (!s.isFile() || s.size > 64 * 1024) return;
    const raw = JSON.parse(await file.readFile('utf8')) as { experiments?: unknown } | null;
    if (raw?.experiments === true) return stamp(s);
  } finally {
    await file.close();
  }
}

export async function observeProxy(
  env: NodeJS.ProcessEnv,
  onEnabled?: (enabled: boolean) => void
): Promise<ProxyObservation | undefined> {
  const home = getHudHome(env);
  try {
    const settingsVersion = await experimentVersion(env).catch(() => undefined);
    onEnabled?.(Boolean(settingsVersion));
    if (!settingsVersion) return;
    const { proxy } = await readExpConfigAsync(home);
    if (!proxy.enabled || !proxy.profile) return;
    const raw = await fs.promises.readFile(expProxyPath(home), 'utf8').catch(() => '');
    return {
      settingsVersion,
      proxy: { ...proxy, profile: proxy.profile },
      intervalMinutes: proxy.intervalMinutes,
      snapshot: parseProxySnapshot(raw, proxy),
    };
  } catch {
    return;
  }
}

const due = (reading: ExpProxyReading, now: number) => {
  const at = proxyDueAt(reading.snapshot, reading.intervalMinutes);
  return at !== null && at <= now;
};
const sameBinding = (a: ProxyObservation['proxy'], b: ExpConfig['proxy']) =>
  b.enabled && a.profile === b.profile && proxyBindingVersion(a) === proxyBindingVersion(b);

export type ProxyRefreshOptions = { now?: () => number; rpc?: typeof readCodexProxy; timeoutMs?: number };

/** Called off-paint. Recheck under the shared lock before the RPC and fence the commit by binding revision. */
export async function refreshProxyIfDue(
  env: NodeJS.ProcessEnv,
  observed: ProxyObservation,
  active: () => boolean,
  { now = Date.now, rpc = readCodexProxy, timeoutMs = 3000 }: ProxyRefreshOptions = {}
): Promise<boolean> {
  if (!due(observed, now())) return false;
  const home = getHudHome(env);
  const release = await fs.promises.realpath(home).then((key) => tryExpLock('proxy', key)).catch(() => undefined);
  if (!release) return false;
  try {
    const current = await observeProxy(env);
    if (!current || !active() || !sameBinding(observed.proxy, current.proxy) || !due(current, now())) return false;
    const { proxy, snapshot } = current;
    const canCommit = () =>
      stamp(fs.statSync(settingsPath(env))) === current.settingsVersion &&
      sameBinding(proxy, readExpConfig(home).proxy);
    const signal = AbortSignal.timeout(timeoutMs); // One bounded RPC, not a scheduler.
    let result: ProxyRpcResult;
    try {
      if (
        (await fs.promises.realpath(proxy.profile)) !== proxy.profile ||
        !(await fs.promises.stat(proxy.profile)).isDirectory()
      ) {
        result = { error: 'unavailable' };
      } else if (!active() || !canCommit()) return false;
      else result = await rpc(proxy.profile, env, signal, now);
    } catch {
      result = { error: 'unavailable' };
    }
    if (signal.aborted) result = { error: 'timeout' };
    const at = now();
    const interval = proxyIntervalMs(current.intervalMinutes);
    const base = { profile: proxy.profile, bindingVersion: proxyBindingVersion(proxy) };
    let next: ExpProxySnapshot;
    if ('error' in result) {
      const failures = Math.min(4, (snapshot?.failures ?? 0) + 1);
      const pause = result.error === 'not_logged_in' || result.error === 'binding_changed';
      next = {
        ...base,
        primary: pause ? undefined : snapshot?.primary,
        secondary: pause ? undefined : snapshot?.secondary,
        observedAtMs: snapshot?.observedAtMs ?? null,
        error: result.error,
        failures,
        nextAttemptMs: pause ? null : Math.max(at + interval * 2 ** (failures - 1), result.retryAtMs ?? 0),
      };
    } else {
      next = {
        ...base,
        ...proxyWindows(result.windows),
        observedAtMs: at,
        error: null,
        failures: 0,
        nextAttemptMs: at + interval,
      };
    }
    if (!canCommit()) return false;
    writePrivateFile(expProxyPath(home), JSON.stringify(next) + '\n');
    return true;
  } catch {
    return false;
  } finally {
    await release();
  }
}
