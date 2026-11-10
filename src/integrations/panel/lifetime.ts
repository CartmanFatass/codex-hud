/** Installed IN the visible panel by A7. Ends the display only, never kills a remote pane. */
import { performance } from 'node:perf_hooks';
import type { EventEmitter } from 'node:events';
import { processState } from '../../core/run/process.js';
import { PanelDeadline, samePane, registeredProcess, type PanelHerdr } from './herdr.js';
import { PanelStore, panelKey, type PanelReceipt } from './receipt.js';
export interface LifetimeOptions {
  env: NodeJS.ProcessEnv;
  receipt: PanelReceipt;
  herdr: PanelHerdr;
  end(reason: string): void;
  terminal?: () => boolean;
  signals?: Pick<EventEmitter, 'on' | 'off'>;
  processAlive?: typeof processState;
  registered?: typeof registeredProcess;
  /** Clock injection only; production intervals and deadlines are fixed below. */
  now?: () => number;
}
export interface PanelLifetime {
  dispose(): void;
  readonly disposed: boolean;
}
export function installPanelLifetime(o: LifetimeOptions): PanelLifetime {
  const store = new PanelStore(o.env);
  const key = panelKey(o.receipt);
  const now = o.now ?? (() => performance.now());
  const signals = o.signals ?? process;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: PanelDeadline | undefined;
  let lastObservation = -Infinity;
  let unavailableSince: number | null = null;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    deadline?.dispose();
    signals.off('SIGHUP', hup);
    signals.off('exit', dispose);
  };
  const end = (reason: string) => {
    if (!disposed) {
      dispose();
      o.end(reason);
    }
  };
  const hup = () => end('panel_terminal_hup');
  const unavailable = () => {
    unavailableSince ??= now();
    if (now() - unavailableSince >= 9000) end('panel_ownership_unavailable');
  };
  const tick = async () => {
    timer = undefined;
    if (disposed) return;
    const started = now();
    try {
      const r = store.read(key);
      if (!r || r.generation !== o.receipt.generation || r.token !== o.receipt.token)
        return end('panel_generation_replaced');
      if (store.fenced(r) || r.phase === 'closing' || r.phase === 'closed') return end('panel_closed');
      if (!(o.terminal ?? (() => !!process.stdin.isTTY && !!process.stdout.isTTY))()) return end('panel_terminal_lost');
      const alive = (o.processAlive ?? processState)(r.main);
      if (alive === 'dead') return end('panel_main_exited');
      if (alive === 'unknown') unavailable();
      if (disposed) return;
      if (now() - lastObservation >= 3000) {
        lastObservation = now();
        deadline = new PanelDeadline(500);
        const probe = deadline;
        const instance = await probe.run(() => o.herdr.instance(probe));
        if (disposed) return;
        if (instance === null) throw new Error('panel_ownership_unavailable');
        if (instance !== r.instance) return end('panel_instance_replaced');
        const registration = store.read(key);
        if (!registration || registration.generation !== r.generation) return end('panel_generation_replaced');
        // The local self-registration is available before the controller publishes open.
        const own = o.receipt.panel ?? r.panel;
        if (!own || !(o.registered ?? registeredProcess)(r, own)) return end('panel_identity_lost');
        const pane = await probe.run(() => o.herdr.observe(own.pane, probe, own.workspace));
        if (disposed) return;
        if (!pane || !samePane(pane, own)) return end('panel_identity_lost');
        if (alive === 'alive') unavailableSince = null;
      }
    } catch {
      if (!disposed) unavailable();
    } finally {
      deadline?.dispose();
      deadline = undefined;
      if (!disposed) timer = setTimeout(() => void tick(), Math.max(1, 1000 - (now() - started)));
    }
  };
  signals.on('SIGHUP', hup);
  signals.on('exit', dispose);
  timer = setTimeout(() => void tick(), 1000);
  return {
    dispose,
    get disposed() {
      return disposed;
    },
  };
}
