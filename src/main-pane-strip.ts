import { paneStripEnabled, type StripClient } from './settings.js';
import { PaneStripClient } from './strip-bar.js';
import { herdrEndpoint, probeHerdrPaneStrip } from './runtime/herdr-socket.js';

export function mainStripTarget(env: NodeJS.ProcessEnv) {
  const pane = env.HERDR_PANE_ID, endpoint = herdrEndpoint(env);
  if (env.HERDR_ENV === '1' && env.HUD_JOB_DIR === undefined && endpoint && pane && !/[\x00-\x1f\x7f-\x9f]/.test(pane)) {
    return { pane, endpoint };
  }
}

type Paint = (width: number) => string;

/** An existing session process owns the lease; no timer or socket is inherited by its children. */
export function ownMainPaneStrip(client: StripClient, env: NodeJS.ProcessEnv, sample: () => Paint | undefined) {
  const target = mainStripTarget(env);
  if (!target) return;
  const { pane } = target;
  let strip: PaneStripClient | undefined, paint: Paint | undefined;
  let stopped = false, priming = false, nextProbe = 0, busy: Promise<void> | undefined;

  async function update() {
    paint = paneStripEnabled(client, env) ? sample() : undefined;
    if (!paint) {
      await strip?.stop();
      strip = undefined;
      nextProbe = 0;
      return;
    }
    if (!strip) {
      if (Date.now() < nextProbe) return;
      nextProbe = Date.now() + 5000;
      const { supported } = await probeHerdrPaneStrip(env);
      if (!supported || stopped || !paneStripEnabled(client, env)) return;
      const owned: PaneStripClient = strip = new PaneStripClient({
        env, paneId: pane, initialWidth: 1,
        onWidthChange(width) {
          if (priming || !paint || stopped || strip !== owned) return;
          try { void owned.push(paint(width), { force: true }); } catch { /* No usable frame. */ }
        },
        onPaneGone() { void stop(false); },
      });
      owned.start();
    }
    // The reservation and its resize event give us the same authoritative inner width.
    // Never show an estimated-width statusline during the first paint.
    if (strip.measuredWidth === null) {
      priming = true;
      try { await strip.push(''); } finally { priming = false; }
    }
    const width = strip.measuredWidth;
    if (!stopped && width !== null) await strip.push(paint(width));
  }

  function refresh() {
    if (stopped || busy) return;
    busy = update().catch(() => {}).finally(() => { busy = undefined; });
  }
  const timer = setInterval(refresh, 1000).unref();
  function stop(clear = true) {
    stopped = true;
    clearInterval(timer);
    const closing = strip?.stop({ clear });
    return Promise.all([busy, closing]).then(() => {});
  }
  refresh();
  return { stop };
}
