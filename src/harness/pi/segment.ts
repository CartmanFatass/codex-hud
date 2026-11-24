/** Passive machine-wide status. Never owns a footer or starts a summary producer. */
import { readMachineWork, type MachineWorkCounts } from '../../collectors/work-summary-snapshot.js';
import { getHudHome } from '../../hud-home.js';
import { readBarSettings } from '../../bar-settings.js';
import { formatMachineWork } from '../../render/work-summary.js';
import { collectLocalLoad, type LocalLoad } from '../../collectors/local-load.js';
import { formatLocalLoad } from '../../render/local-load.js';

export const HUD_STATUS_KEY = 'hud-delegation';
export interface SegmentContext {
  mode: string;
  hasUI: boolean;
  ui: { setStatus(key: string, text: string | undefined): void };
}
export const isPiTui = (ctx: SegmentContext): boolean => ctx.hasUI && ctx.mode === 'tui';
export function createPiSegment(options: {
  env: NodeJS.ProcessEnv;
  now?: () => number;
  schedule?: (callback: () => void, ms: number) => () => void;
  onSignals?: (counts: MachineWorkCounts | undefined, localLoad?: LocalLoad) => void;
  /** The HUD-owned footer already shows these readings. */
  statusVisible?: () => boolean;
}) {
  let current: { ctx: SegmentContext; isCurrent(): boolean; home: string } | null = null;
  let cancel: (() => void) | undefined;
  let text: string | undefined;
  let published = false;
  const schedule =
    options.schedule ??
    ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref();
      return () => clearTimeout(timer);
    });
  function refresh() {
    const state = current;
    if (!state) return;
    if (!isPiTui(state.ctx) || !state.isCurrent()) {
      stop();
      return;
    }
    const now = (options.now ?? Date.now)();
    const counts = readMachineWork(state.home, now), localLoad = collectLocalLoad(state.home, now, options.env);
    options.onSignals?.(counts, localLoad);
    let next: string | undefined;
    if (options.statusVisible?.() !== false && (counts || localLoad)) {
      const settings = readBarSettings(options.env);
      next = [counts && formatMachineWork(counts, now, settings?.icons), localLoad && formatLocalLoad(localLoad, settings?.theme)]
        .filter(Boolean).join(' │ ') || undefined;
    }
    if (current === state && (!published || next !== text)) {
      published = true;
      text = next;
      state.ctx.ui.setStatus(HUD_STATUS_KEY, next);
    }
  }
  function arm() {
    if (!current) return;
    cancel = schedule(() => {
      cancel = undefined;
      refresh();
      arm();
    }, 5000);
  }
  function stop() {
    cancel?.();
    cancel = undefined;
    const old = current;
    current = null;
    text = undefined;
    published = false;
    if (old && isPiTui(old.ctx)) old.ctx.ui.setStatus(HUD_STATUS_KEY, undefined);
    options.onSignals?.(undefined);
  }
  return {
    start(ctx: SegmentContext, isCurrent: () => boolean) {
      stop();
      if (!isPiTui(ctx)) return;
      current = { ctx, isCurrent, home: getHudHome(options.env) };
      refresh();
      arm();
    },
    refresh,
    stop,
  };
}
