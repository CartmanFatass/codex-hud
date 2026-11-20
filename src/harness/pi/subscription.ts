import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  observeProxy,
  refreshProxyIfDue,
  type ProxyObservation,
  type ProxyRefreshOptions,
} from '../../collectors/exp-proxy-refresh.js';
import { getHudHome } from '../../hud-home.js';
import { settingsPath } from '../../settings.js';
import {
  proxyObject,
  proxyStale,
  proxyWindow,
  windowLabel,
  windowPending,
  windowRemaining,
  type ExpProxyWindow,
  type ExpProxyWindows,
} from '../../exp-proxy.js';
import type { FooterContext } from './footer-host.js';

function route(ctx: FooterContext | null): string | undefined {
  const model = ctx?.model;
  if (model?.provider !== 'openai' || ctx?.modelRegistry?.isUsingOAuth(model) !== true) return;
  return JSON.stringify([model.provider, model.id, model.baseUrl]);
}

function responseWindows(event: unknown): ExpProxyWindows {
  const headers = proxyObject(proxyObject(event)?.headers);
  const number = (key: string) => {
    const value = headers?.[key];
    return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : undefined;
  };
  const window = (kind: string) => {
    const prefix = `x-codex-${kind}-`;
    return proxyWindow(number(prefix + 'used-percent'), number(prefix + 'window-minutes'), number(prefix + 'reset-at'));
  };
  return { primary: window('primary'), secondary: window('secondary') };
}

function streamWindows(event: unknown, model: FooterContext['model']): ExpProxyWindows {
  const packet = proxyObject(event);
  if (packet?.provider !== 'openai' || packet.model !== model?.id) return {};
  const data = proxyObject(packet.data);
  const bucket = data?.metered_limit_name ?? data?.limit_name ?? 'codex';
  if (data?.type !== 'codex.rate_limits' || bucket !== 'codex') return {};
  const limits = proxyObject(data.rate_limits);
  const window = (kind: string) => {
    const raw = proxyObject(limits?.[kind]);
    return proxyWindow(raw?.used_percent, raw?.window_minutes, raw?.reset_at);
  };
  return { primary: window('primary'), secondary: window('secondary') };
}

/** The component's draw only enqueues I/O. File notifications invalidate cached readings and request a new draw. */
export function createPiSubscription(env: NodeJS.ProcessEnv, repaint: () => void, options: ProxyRefreshOptions = {}) {
  const now = options.now ?? Date.now;
  const preferences = settingsPath(env);
  const expDir = join(getHudHome(env), 'exp');
  let settingsWatch: FSWatcher | undefined;
  let expWatch: FSWatcher | undefined;
  let epoch = 0;
  let revision = 0;
  let poll: Promise<void> | undefined;
  let refresh: Promise<boolean> | undefined;
  let reading: ProxyObservation | undefined;
  let request: string | undefined;
  type WindowReading = { window: ExpProxyWindow; at: number | null; direct?: true };
  const slots = ['primary', 'secondary'] as const;
  let direct: Partial<Record<(typeof slots)[number], WindowReading>> = {};

  function watchDir(dir: string, change: (file: string | null) => void, closed: () => void) {
    try {
      const watcher = watch(dir, { persistent: false }, (_, file) => change(file));
      watcher.on('error', () => watcher.close());
      watcher.on('close', closed);
      return watcher;
    } catch {
      return;
    }
  }
  function invalidate() {
    revision++;
    reading = undefined;
    repaint();
  }
  function observe() {
    if (poll) return;
    const mounted = epoch;
    const captured = revision;
    const active = () => mounted === epoch;
    poll = observeProxy(env, (enabled) => {
      if (!active()) return;
      settingsWatch ??= watchDir(
        dirname(preferences),
        (file) => {
          if (!file || file === basename(preferences)) invalidate();
        },
        () => {
          if (active()) settingsWatch = undefined;
        }
      );
      if (enabled) {
        expWatch ??= watchDir(
          expDir,
          (file) => {
            if (!file || file === 'config.json') invalidate();
            else if (file === 'proxy.json') repaint();
          },
          () => {
            if (active()) expWatch = undefined;
          }
        );
      } else {
        expWatch?.close();
        expWatch = undefined;
        clearRequest();
      }
    }).then((next) => {
      if (!active()) return;
      poll = undefined;
      if (captured !== revision) return repaint();
      if (
        next?.proxy.bindingVersion !== reading?.proxy.bindingVersion ||
        next?.proxy.profile !== reading?.proxy.profile
      )
        clearRequest();
      const changed = JSON.stringify(next) !== JSON.stringify(reading);
      reading = next;
      if (next && !refresh) {
        refresh = refreshProxyIfDue(env, next, active, options);
        void refresh.then((wrote) => {
          refresh = undefined;
          if (wrote || captured !== revision) repaint();
        });
      }
      if (changed) repaint();
    });
  }
  function clearRequest() {
    request = undefined;
    direct = {};
  }
  return {
    stop() {
      epoch++;
      poll = undefined;
      reading = undefined;
      clearRequest();
      settingsWatch?.close();
      expWatch?.close();
      settingsWatch = expWatch = undefined;
    },
    draw(ctx: FooterContext): string[] {
      observe();
      if (!reading) return [];
      const key = route(ctx);
      if (request !== key) clearRequest();
      if (!key) return [];
      const { snapshot, intervalMinutes } = reading;
      const byWindow = new Map<number | string, WindowReading>();
      // Match measured durations across sources; fall back to the slot when a duration is absent.
      for (const slot of slots) {
        const proxy = snapshot?.[slot];
        if (proxy) {
          const key = proxy.windowDurationMins ?? direct[slot]?.window.windowDurationMins ?? slot;
          byWindow.set(key, { window: proxy, at: snapshot.observedAtMs });
        }
      }
      for (const slot of slots) {
        const own = direct[slot];
        if (own) byWindow.set(own.window.windowDurationMins ?? snapshot?.[slot]?.windowDurationMins ?? slot, own);
      }
      const at = now();
      return [...byWindow.entries()]
        .sort(([a], [b]) => typeof a === 'number' && typeof b === 'number' ? a - b : 0)
        .map(([, value]) => {
          const { window } = value;
          const label = windowLabel(window);
          const suffix = proxyStale(value.at, intervalMinutes, at) ? ' · stale' : '';
          const text = windowPending(window, at)
            ? 'refresh pending'
            : `${value.direct ? 'left ' : '≈'}${windowRemaining(window)}%`;
          return `${label ? label + ' ' : ''}${text}${suffix}`;
        });
    },
    modelChanged: clearRequest,
    requestStarted(ctx: FooterContext) {
      const hadDirect = direct.primary || direct.secondary;
      clearRequest();
      if (reading) request = route(ctx);
      if (hadDirect) repaint();
    },
    requestWindows(ctx: FooterContext, event: unknown, stream: boolean) {
      if (!reading || !request || request !== route(ctx)) return;
      const windows = stream ? streamWindows(event, ctx.model) : responseWindows(event);
      if (!windows.primary && !windows.secondary) return;
      const at = now();
      for (const slot of slots) {
        const window = windows[slot];
        if (window) direct[slot] = { window, at, direct: true };
      }
      repaint();
    },
  };
}
