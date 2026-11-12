/** Exact-root passive status. Never owns a footer or starts a summary producer. */
import { readThinJobs } from '../../collectors/thin-jobs.js';
import { getHudHome } from '../../hud-home.js';
import { renderWorkSummary, workSignals, type WorkSignals } from '../../render/work-summary.js';
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
  /** Told what the jobs ask and just did, at every refresh and, empty, when the segment stops. */
  onSignals?: (signals: WorkSignals) => void;
}) {
  let current: { ctx: SegmentContext; root: string; isCurrent(): boolean } | null = null;
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
    const lanes = readThinJobs(getHudHome(options.env), { project: null, pane: options.env.HERDR_PANE_ID ?? null });
    options.onSignals?.(workSignals(lanes, now));
    const next = renderWorkSummary(lanes, 160, now) || undefined;
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
      // Sync bounded read, then re-arm: no overlapping timer work.
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
    options.onSignals?.({ needs: [], events: [] });
  }
  return {
    start(ctx: SegmentContext, root: string, isCurrent: () => boolean) {
      stop();
      if (!isPiTui(ctx)) return;
      current = { ctx, root, isCurrent };
      refresh();
      arm();
    },
    refresh,
    stop,
  };
}
