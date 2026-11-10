/** Exact-root passive status. Never owns a footer or starts a summary producer. */
import { readRoleSummary } from '../../roles/role-summary.js';
import { renderRoleSummary } from '../../render/role-summary.js';
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
    const next =
      renderRoleSummary(
        readRoleSummary(options.env, state.root, {
          budgetMs: 20,
          nowMs: (options.now ?? Date.now)(),
        }),
        160
      ) || undefined;
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
