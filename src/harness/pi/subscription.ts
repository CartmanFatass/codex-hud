import { lstatSync, realpathSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  observeProxy,
  refreshProxyIfDue,
  type ProxyObservation,
  type ProxyRefreshOptions,
} from '../../collectors/exp-proxy-refresh.js';
import { getHudHome } from '../../hud-home.js';
import { settingsPath } from '../../settings.js';
import {
  proxyDueAt,
  proxyObject,
  proxyStale,
  proxyWindow,
  windowLabel,
  windowPending,
  type ExpProxyWindow,
  type ExpProxyWindows,
} from '../../exp-proxy.js';
import { span, type BarQuotaWindow } from '../../render/layout/bar-fields.js';
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
  let observed = false;
  let expEnabled = false;
  let poll: Promise<void> | undefined;
  let refresh: Promise<boolean> | undefined;
  let reading: ProxyObservation | undefined;
  let request: string | undefined;
  type WindowReading = { window: ExpProxyWindow; at: number | null; direct?: true };
  const slots = ['primary', 'secondary'] as const;
  let direct: Partial<Record<(typeof slots)[number], WindowReading>> = {};

  function watchDir(dir: string, change: (file: string | null) => void, closed: (watcher: FSWatcher) => void) {
    try {
      const watcher = watch(dir, { persistent: false }, (_, file) => change(file));
      watcher.on('error', () => watcher.close());
      watcher.on('close', () => closed(watcher));
      return watcher;
    } catch {
      return;
    }
  }
  function invalidate(clear = true) {
    revision++;
    observed = false;
    if (clear) reading = undefined;
    repaint();
  }
  function maybeRefresh(target: ProxyObservation, captured: number) {
    if (refresh) return;
    const dueAt = proxyDueAt(target.snapshot, target.intervalMinutes);
    if (dueAt === null || dueAt > now()) return;
    const mounted = epoch;
    const active = () => mounted === epoch;
    refresh = refreshProxyIfDue(env, target, active, options);
    void refresh.then((wrote) => {
      if (!active()) return;
      refresh = undefined;
      if (wrote) invalidate(false);
      else if (captured !== revision) repaint();
    });
  }
  function observe() {
    if (poll) return;
    if (observed && settingsWatch && (!expEnabled || expWatch)) return;
    const mounted = epoch;
    const captured = revision;
    const active = () => mounted === epoch;
    let covered = false;
    // Attach before reading, so even an atomic replacement during the read invalidates it.
    poll = Promise.resolve().then(() => {
      if (!active()) return;
      settingsWatch ??= watchDir(
        dirname(preferences),
        (file) => {
          if (!file || file === basename(preferences)) invalidate();
          else if (expEnabled && !expWatch && file === 'exp') invalidate(false);
        },
        (watcher) => {
          if (active() && settingsWatch === watcher) {
            settingsWatch = undefined;
            observed = false;
          }
        }
      );
      // A watch on a link's parent cannot see edits to its target in a dotfiles directory.
      try {
        covered = !!settingsWatch && realpathSync(dirname(preferences)) === resolve(dirname(preferences)) &&
          !lstatSync(preferences, { throwIfNoEntry: false })?.isSymbolicLink();
      } catch { /* Unknown watch coverage: read on the next draw too. */ }
      return observeProxy(env, enabledChanged);
    }).then(
      (next) => {
        if (!active()) return;
        poll = undefined;
        if (captured !== revision) return repaint();
        observed = covered;
        if (
          next?.proxy.bindingVersion !== reading?.proxy.bindingVersion ||
          next?.proxy.profile !== reading?.proxy.profile
        )
          clearRequest();
        const changed = JSON.stringify(next) !== JSON.stringify(reading);
        reading = next;
        if (next) maybeRefresh(next, captured);
        if (changed) repaint();
      },
      () => {
        if (active()) poll = undefined;
      }
    );
    function enabledChanged(enabled: boolean) {
      if (!active()) return;
      expEnabled = enabled;
      if (enabled) {
        expWatch ??= watchDir(
          expDir,
          (file) => {
            if (!file || file === 'config.json') invalidate();
            else if (file === 'proxy.json') invalidate(false);
          },
          (watcher) => {
            if (active() && expWatch === watcher) {
              expWatch = undefined;
              observed = false;
            }
          }
        );
      } else {
        const watcher = expWatch;
        expWatch = undefined;
        watcher?.close();
        clearRequest();
      }
    }
  }
  function clearRequest() {
    request = undefined;
    direct = {};
  }
  return {
    stop() {
      epoch++;
      poll = undefined;
      refresh = undefined;
      observed = false;
      expEnabled = false;
      reading = undefined;
      clearRequest();
      const sw = settingsWatch;
      const ew = expWatch;
      settingsWatch = expWatch = undefined;
      sw?.close();
      ew?.close();
    },
    draw(ctx: FooterContext): BarQuotaWindow[] {
      observe();
      if (!reading) return [];
      if (!poll) maybeRefresh(reading, revision);
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
        .sort(([a], [b]) => (typeof a === 'number' && typeof b === 'number' ? a - b : 0))
        .map(([, value]) => {
          const { window } = value;
          const label = windowLabel(window) ?? '';
          if (windowPending(window, at)) return { label, shown: '↻', quiet: true };
          const quiet = proxyStale(value.at, intervalMinutes, at);
          const percent = Math.min(100, window.usedPercent);
          return {
            label,
            percent,
            shown: `${value.direct && !quiet ? '' : '≈'}${Math.round(percent)}%${quiet ? '?' : ''}`,
            quiet,
            reset:
              !quiet && window.resetsAt !== undefined
                ? span(Math.ceil((window.resetsAt * 1000 - at) / 60_000))
                : undefined,
          };
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
