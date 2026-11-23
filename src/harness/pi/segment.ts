/** Passive machine-wide status. Never owns a footer or starts a summary producer. */
import { readMachineWork, type MachineWorkCounts } from '../../collectors/work-summary-snapshot.js';
import { getHudHome } from '../../hud-home.js';
import { formatMachineWork } from '../../render/work-summary.js';

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
  onSignals?: (counts: MachineWorkCounts | undefined) => void;
  /** The HUD-owned footer already shows the counts. */
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
    const counts = readMachineWork(state.home, (options.now ?? Date.now)());
    options.onSignals?.(counts);
    const next = counts && options.statusVisible?.() !== false ? formatMachineWork(counts) : undefined;
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
