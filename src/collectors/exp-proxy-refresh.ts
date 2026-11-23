import * as fs from 'node:fs';
import { getHudHome } from '../hud-home.js';
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
import { tryAbstractLock } from '../utils/abstract-lock.js';
import { writePrivateFile } from '../utils/atomic-fs.js';

export type ProxyObservation = ExpProxyReading & {
  proxy: ExpConfig['proxy'] & { profile: string };
};

export async function observeProxy(env: NodeJS.ProcessEnv): Promise<ProxyObservation | undefined> {
  const home = getHudHome(env);
  try {
    const { proxy } = await readExpConfigAsync(home);
    if (!proxy.enabled || !proxy.profile) return;
    const raw = await fs.promises.readFile(expProxyPath(home), 'utf8').catch(() => '');
    return {
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
  const release = await fs.promises.realpath(home).then((key) => tryAbstractLock('exp-proxy', key)).catch(() => undefined);
  if (!release) return false;
  try {
    const current = await observeProxy(env);
    if (!current || !active() || !sameBinding(observed.proxy, current.proxy) || !due(current, now())) return false;
    const { proxy, snapshot } = current;
    const canCommit = () => {
      const latest = readExpConfig(home).proxy;
      return sameBinding(proxy, latest) && proxy.intervalMinutes === latest.intervalMinutes;
    };
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
