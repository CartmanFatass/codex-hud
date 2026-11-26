import type { PanelPlace } from '../render/monitor-reload-codec.js';
import type { PanelReload } from '../utils/panel-reload.js';
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

export function createPanelLifecycle(reload: PanelReload) {
  let closed = false;
  let restarting: Promise<void> | undefined;
  let finish = () => {};
  const decoder = new WorkbenchInputDecoder('workboard');

  return {
    get closed() { return closed; },
    get reloadFailed() { return reload.failed; },
    setMouseTracking: (enabled: boolean) => process.stdout.write(enabled ? MOUSE_ON : MOUSE_OFF),
    finish: () => finish(),
    pollReload: (isDirty: () => boolean) => reload.poll(isDirty),
    restart(place: PanelPlace) {
      return restarting = reload.restart(place, () => finish());
    },
    async run(mouse: boolean, callbacks: LifecycleCallbacks, installCleanup?: InstallCleanup): Promise<void> {
      let escapeTimer: ReturnType<typeof setTimeout> | undefined;
      const onData = (chunk: Buffer) => {
        if (escapeTimer) clearTimeout(escapeTimer);
        callbacks.input(decoder.push(chunk));
        escapeTimer = setTimeout(() => callbacks.input(decoder.flushEscape()), 40);
      };
      const onFinish = () => finish();
      const onResize = () => callbacks.resize();
      await new Promise<void>((resolve) => {
        let disposeLifetime: (() => void) | undefined;
        finish = () => {
          if (closed) return;
          closed = true;
          disposeLifetime?.();
          callbacks.dispose();
          if (escapeTimer) clearTimeout(escapeTimer);
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
          resolve();
        };
        disposeLifetime = installCleanup?.(onFinish);
        process.once('SIGINT', onFinish);
        process.once('SIGTERM', onFinish);
        process.once('SIGHUP', onFinish);
        process.stdin.once('end', onFinish);
        process.stdout.on('resize', onResize);
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdout.write(mouse ? ENTER + MOUSE_ON : ENTER);
        process.stdin.resume();
        process.stdin.on('data', onData);
        callbacks.start();
      });
      await restarting;
    },
  };
}
