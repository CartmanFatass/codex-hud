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
  let direct: { route: string; windows: ExpProxyWindows; at: number } | undefined;

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
    direct = undefined;
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
    draw(ctx: FooterContext): string | undefined {
      observe();
      if (!reading) return;
      const key = route(ctx);
      if (request !== key) clearRequest();
      if (!key) return;
      const own = direct;
      const windows = own?.windows ?? reading.snapshot;
      const window = windows?.primary ?? windows?.secondary;
      if (!window) return;
      const label = windowLabel(window);
      const prefix = label ? `${label} ` : '';
      const at = now();
      const stale = proxyStale(own?.at ?? reading.snapshot?.observedAtMs ?? null, reading.intervalMinutes, at);
      if (windowPending(window, at)) return `${prefix}refresh pending${stale ? ' · stale' : ''}`;
      return `${prefix}${own ? 'left ' : '≈'}${windowRemaining(window)}%${stale ? ' · stale' : ''}`;
    },
    modelChanged: clearRequest,
    requestStarted(ctx: FooterContext) {
      const hadDirect = !!direct;
      clearRequest();
      if (reading) request = route(ctx);
      if (hadDirect) repaint();
    },
    requestWindows(ctx: FooterContext, event: unknown, stream: boolean) {
      if (!reading || !request || request !== route(ctx)) return;
      const windows = stream ? streamWindows(event, ctx.model) : responseWindows(event);
      if (!windows.primary && !windows.secondary) return;
      direct = {
        route: request,
        windows: {
          primary: windows.primary ?? direct?.windows.primary,
          secondary: windows.secondary ?? direct?.windows.secondary,
        },
        at: now(),
      };
      repaint();
    },
  };
}
