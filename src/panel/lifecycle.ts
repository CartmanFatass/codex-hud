import { closePanelPane, watchPanelCaller } from '../cli/panel-pane.js';
import type { PanelPlace } from '../render/monitor-reload-codec.js';
import type { PanelReload } from '../utils/panel-reload.js';
import { treeWidthKeeper } from '../utils/pane-width.js';
import { WorkbenchInputDecoder, type WorkbenchInput } from '../utils/workbench-input.js';

const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?2004h';
const LEAVE = '\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l';
// Clicks and the wheel only (mode 1000): the panel asks for no motion reports.
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1000l\x1b[?1006l';

export function restoreTerminal(): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(LEAVE);
}

type LifecycleCallbacks = {
  input(inputs: WorkbenchInput[]): void;
  resize(): void;
  start(): void;
  dispose(): void;
  removeSnapshot(): void;
};

export type InstallCleanup = (end: () => void) => () => void;

export function createPanelLifecycle(reload: PanelReload, placeWidth: number | null | undefined, getWidth: () => number) {
  let closed = false;
  let restarting: Promise<void> | undefined;
  let finish = (_callerGone?: boolean) => {};
  let widthOverride = placeWidth === null ? undefined
    : placeWidth ?? (Number(process.env.HUD_PANEL_WIDTH) || undefined);
  const widthKeeper = !process.env.HUD_PANEL_CALLER_PANE
    ? null : treeWidthKeeper(() => widthOverride ?? getWidth());
  const decoder = new WorkbenchInputDecoder('workboard');

  return {
    get closed() { return closed; },
    get reloadFailed() { return reload.failed; },
    get widthOverride() { return widthOverride; },
    clearWidthOverride() { widthOverride = undefined; },
    applyWidth: () => widthKeeper?.apply(),
    setMouseTracking: (enabled: boolean) => process.stdout.write(enabled ? MOUSE_ON : MOUSE_OFF),
    finish: () => finish(),
    pollReload: (isDirty: () => boolean) => reload.poll(isDirty),
    restart(place: PanelPlace) {
      return restarting = reload.restart(place, () => finish());
    },
    async run(mouse: boolean, callbacks: LifecycleCallbacks, installCleanup?: InstallCleanup): Promise<void> {
      let escapeTimer: ReturnType<typeof setTimeout> | undefined;
      let resizeTimer: ReturnType<typeof setTimeout> | undefined;
      const onData = (chunk: Buffer) => {
        if (escapeTimer) clearTimeout(escapeTimer);
        callbacks.input(decoder.push(chunk));
        escapeTimer = setTimeout(() => callbacks.input(decoder.flushEscape()), 40);
      };
      const onFinish = () => finish();
      const onResize = () => {
        callbacks.resize();
        // A client attaching at another size shares the change with this pane;
        // wait for the burst of resizes to settle, then take back the policy width.
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { void widthKeeper?.follow().catch(() => {}); }, 150);
      };
      await new Promise<void>((resolve) => {
        let disposeLifetime: (() => void) | undefined;
        let disposeCaller: (() => void) | undefined;
        finish = (callerGone = false) => {
          if (closed) return;
          closed = true;
          disposeLifetime?.();
          disposeCaller?.();
          callbacks.dispose();
          if (escapeTimer) clearTimeout(escapeTimer);
          if (resizeTimer) clearTimeout(resizeTimer);
          process.off('SIGINT', onFinish);
          process.off('SIGTERM', onFinish);
          process.off('SIGHUP', onFinish);
          process.stdin.off('end', onFinish);
          process.stdout.off('resize', onResize);
          process.stdin.off('data', onData);
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write(LEAVE);
          callbacks.removeSnapshot();
          if (callerGone) void closePanelPane(process.env.HERDR_PANE_ID!, process.env).catch(() => {}).finally(resolve);
          else resolve();
        };
        disposeLifetime = installCleanup?.(onFinish);
        disposeCaller = watchPanelCaller(process.env, () => finish(true));
        process.once('SIGINT', onFinish);
        process.once('SIGTERM', onFinish);
        process.once('SIGHUP', onFinish);
        process.stdin.once('end', onFinish);
        process.stdout.on('resize', onResize);
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdout.write(mouse ? ENTER + MOUSE_ON : ENTER);
        void widthKeeper?.apply().catch(() => {});
        process.stdin.resume();
        process.stdin.on('data', onData);
        callbacks.start();
      });
      await restarting;
    },
  };
}
