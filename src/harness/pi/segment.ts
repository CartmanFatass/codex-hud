/** Exact-root passive status. Never owns a footer or starts a summary producer. */
import { jobLaneSnapshot, type Lanes } from '../../collectors/job-snapshot.js';
import { readFreshWorkSummary, type WorkSummaryScope } from '../../collectors/work-summary-snapshot.js';
import { getHudHome } from '../../hud-home.js';
import { herdrId } from '../../roles/herdr-run.js';
import { renderWorkSummary, workSignals, workSignalsFromSummary, type WorkSignals } from '../../render/work-summary.js';
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
  /** The HUD-owned footer shows the icon census instead of pi's passive status text. */
  statusVisible?: () => boolean;
}) {
  type State = {
    ctx: SegmentContext;
    isCurrent(): boolean;
    home: string;
    pane: string | null;
    jobs?: ReturnType<typeof jobLaneSnapshot>;
    snapshot?: Lanes;
    summary?: WorkSummaryScope;
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
    const now = (options.now ?? Date.now)();
    if (!state.pane) {
      show(state, now);
      return;
    }
    state.summary = readFreshWorkSummary(state.home, state.pane, now)?.scope;
    if (state.summary && options.statusVisible?.() === false) {
      state.snapshot = undefined;
      state.jobs?.close();
      state.jobs = undefined;
      state.loading = false;
      show(state, now);
      return;
    }
    show(state, now);
    if (state.loading) return;
    const jobs = (state.jobs ??= jobLaneSnapshot(state.home, { project: null, pane: state.pane }));
    state.loading = true;
    void jobs.read().then((snapshot) => {
      if (current !== state || !state.isCurrent() || state.jobs !== jobs || snapshot === state.snapshot) return;
      state.snapshot = snapshot;
      show(state);
    }).catch(() => { /* Keep the last good view and retry on the next refresh. */ })
      .finally(() => { if (state.jobs === jobs) state.loading = false; });
  }
  function show(state: State, now = (options.now ?? Date.now)()) {
    const signals = state.summary ? workSignalsFromSummary(state.summary) : workSignals(state.snapshot?.lanes ?? [], now);
    options.onSignals?.(signals);
    const next = options.statusVisible?.() === false ? undefined : renderWorkSummary(state.snapshot?.lanes ?? [], 160, now) || undefined;
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
    old?.jobs?.close();
    text = undefined;
    published = false;
    if (old && isPiTui(old.ctx)) old.ctx.ui.setStatus(HUD_STATUS_KEY, undefined);
    options.onSignals?.({ workers: [] });
  }
  return {
    start(ctx: SegmentContext, _root: string, isCurrent: () => boolean) {
      stop();
      if (!isPiTui(ctx)) return;
      const pane = herdrId(options.env.HERDR_PANE_ID) ? options.env.HERDR_PANE_ID! : null;
      current = { ctx, isCurrent, home: getHudHome(options.env), pane, loading: false };
      refresh();
      arm();
    },
    refresh,
    stop,
  };
}
