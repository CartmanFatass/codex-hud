/** Exact-root passive status. Never owns a footer or starts a summary producer. */
import { jobLaneSnapshot, type Lanes } from '../../collectors/job-snapshot.js';
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
  /** Told the census of the jobs, at every refresh and, empty, when the segment stops. */
  onSignals?: (signals: WorkSignals) => void;
}) {
  type State = {
    ctx: SegmentContext;
    isCurrent(): boolean;
    jobs: ReturnType<typeof jobLaneSnapshot>;
    snapshot?: Lanes;
    loading: boolean;
  };
  let current: State | null = null;
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
    show(state);
    if (state.loading) return;
    state.loading = true;
    void state.jobs.read().then((snapshot) => {
      if (current !== state || !state.isCurrent() || snapshot === state.snapshot) return;
      state.snapshot = snapshot;
      show(state);
    }).catch(() => { /* Keep the last good view and retry on the next refresh. */ })
      .finally(() => { state.loading = false; });
  }
  function show(state: State) {
    const now = (options.now ?? Date.now)(), lanes = state.snapshot?.lanes ?? [];
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
      refresh();
      arm();
    }, 5000);
  }
  function stop() {
    cancel?.();
    cancel = undefined;
    const old = current;
    current = null;
    old?.jobs.close();
    text = undefined;
    published = false;
    if (old && isPiTui(old.ctx)) old.ctx.ui.setStatus(HUD_STATUS_KEY, undefined);
    options.onSignals?.({ workers: [] });
  }
  return {
    start(ctx: SegmentContext, _root: string, isCurrent: () => boolean) {
      stop();
      if (!isPiTui(ctx)) return;
      const jobs = jobLaneSnapshot(getHudHome(options.env), { project: null, pane: options.env.HERDR_PANE_ID ?? null });
      current = { ctx, isCurrent, jobs, loading: false };
      refresh();
      arm();
    },
    refresh,
    stop,
  };
}
