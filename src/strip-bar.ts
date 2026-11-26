import { createConnection, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';
import {
  clearPaneStrip,
  herdrEndpoint,
  setPaneStrip,
  type PaneStripPosition,
} from './runtime/herdr-socket.js';

/** Default herdr pane-strip lease (matches fork default). */
export const STRIP_LEASE_MS = 15_000;
/** Renew well before lease expiry so transient hiccups or handoffs do not drop the strip. */
export const STRIP_RENEW_MS = 5_000;
/** Special exit code signaling codex-launch to respawn the bar sidecar after a rebuild. */
export const BAR_RELOAD_EXIT_CODE = 75;

const MIN_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 5_000;

export interface PaneStripClientOptions {
  paneId: string;
  position?: PaneStripPosition;
  initialWidth: number;
  leaseMs?: number;
  renewMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  onWidthChange?: (width: number) => void;
  onPaneGone?: () => void;
}

/**
 * Owns one herdr pane strip slot: subscribes to `pane.resized` for exact inner
 * width updates, coalesces single-flight `pane.strip.set` pushes, renews the
 * lease before expiry, and clears only its own slot on shutdown.
 */
export class PaneStripClient {
  private readonly paneId: string;
  private readonly position: PaneStripPosition;
  private readonly leaseMs: number;
  private readonly renewMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly onWidthChange?: (width: number) => void;
  private readonly onPaneGone?: () => void;

  private currentWidth: number;
  private widthObserved = false;
  private widthEvent = 0;
  private lastSentLine: string | null = null;
  private lastPushAt = -Infinity;
  private inFlight: Promise<void> | null = null;
  private pending: { line: string; force: boolean } | null = null;
  private activeAbort: AbortController | null = null;

  private socket: Socket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectMs = MIN_RECONNECT_MS;
  private hasSubscribedOnce = false;
  private stopped = false;

  constructor(options: PaneStripClientOptions) {
    this.paneId = options.paneId;
    this.position = options.position ?? 'bottom';
    this.currentWidth = Math.max(1, Math.floor(options.initialWidth || 80));
    this.leaseMs = options.leaseMs ?? STRIP_LEASE_MS;
    this.renewMs = options.renewMs ?? STRIP_RENEW_MS;
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.onWidthChange = options.onWidthChange;
    this.onPaneGone = options.onPaneGone;
  }

  get width(): number {
    return this.currentWidth;
  }

  /** The server's inner width, which can differ from the launching process's PTY columns. */
  get measuredWidth(): number | null {
    return this.widthObserved ? this.currentWidth : null;
  }

  private observeWidth(raw: unknown): void {
    const width = Number(raw);
    if (!Number.isInteger(width) || width <= 0) return;
    this.widthObserved = true;
    if (width === this.currentWidth) return;
    this.currentWidth = width;
    this.onWidthChange?.(width);
  }

  /** Open the `pane.resized` subscription socket (reconnecting automatically on disconnect). */
  start(): void {
    if (this.stopped || this.socket || this.reconnectTimer) return;
    this.subscribe();
  }

  private subscribe(): void {
    if (this.stopped || this.socket || this.reconnectTimer) return;
    const endpoint = herdrEndpoint(this.env);
    if (!endpoint) return;
    const peer = (this.socket = createConnection(endpoint));
    const lines = createInterface({ input: peer });
    const subId = `hud-pane-strip-${process.pid}`;

    const drop = () => {
      if (this.socket !== peer) return;
      this.socket = null;
      lines.close();
      peer.destroy();
      if (this.stopped) return;
      const delayMs = this.reconnectMs;
      this.reconnectMs = Math.min(MAX_RECONNECT_MS, this.reconnectMs * 2);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.subscribe();
      }, delayMs);
      this.reconnectTimer.unref();
    };

    peer.on('connect', () => {
      if (this.socket !== peer) return;
      peer.write(
        JSON.stringify({
          id: subId,
          method: 'events.subscribe',
          params: { subscriptions: [{ type: 'pane.resized' }] },
        }) + '\n'
      );
    });

    lines.on('line', (raw) => {
      if (this.socket !== peer || this.stopped) return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.error) {
        drop();
        return;
      }
      if (message.id === subId) {
        this.reconnectMs = MIN_RECONNECT_MS;
        const reconnected = this.hasSubscribedOnce;
        this.hasSubscribedOnce = true;
        // After a reconnect (e.g. live-handoff), re-push so the strip and width re-sync immediately.
        if (reconnected && this.lastSentLine !== null) {
          void this.push(this.lastSentLine, { force: true });
        }
        return;
      }
      const kind = String(message.event ?? '').replace(/\./g, '_');
      if (kind !== 'pane_resized') return;
      const data = message.data as Record<string, unknown> | undefined;
      if (!data || data.pane_id !== this.paneId) return;
      const width = Number(data.width);
      if (!Number.isInteger(width) || width <= 0) return;
      this.widthEvent++;
      this.observeWidth(width);
    });

    lines.on('error', drop);
    peer.on('error', drop);
    peer.on('close', drop);
  }

  /**
   * Push a rendered bar line if it changed, `force` is set, or lease renewal is due.
   * Coalesces concurrent updates into a single-flight request chain.
   */
  push(line: string, opts: { force?: boolean; nowMs?: number } = {}): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const force = opts.force === true;
    const nowMs = opts.nowMs ?? this.now();
    const renewalDue = nowMs - this.lastPushAt >= this.renewMs;
    if (!force && !renewalDue && line === this.lastSentLine && !this.pending) {
      return this.inFlight ?? Promise.resolve();
    }
    this.pending = { line, force: force || renewalDue || line !== this.lastSentLine };
    if (!this.inFlight) {
      this.inFlight = this.drain().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.pending) {
      const next = this.pending;
      this.pending = null;
      const nowMs = this.now();
      const renewalDue = nowMs - this.lastPushAt >= this.renewMs;
      if (!next.force && !renewalDue && next.line === this.lastSentLine) {
        continue;
      }
      const controller = new AbortController();
      const widthEvent = this.widthEvent;
      this.activeAbort = controller;
      const reply = await setPaneStrip(
        this.paneId,
        { position: this.position, line: next.line, leaseMs: this.leaseMs },
        { timeoutMs: 1500, signal: controller.signal, env: this.env }
      ).catch(() => null);
      if (this.activeAbort === controller) this.activeAbort = null;
      if (this.stopped) return;
      if (!reply) continue;
      if (reply.error) {
        if (reply.error.code === 'pane_not_found') {
          this.onPaneGone?.();
          return;
        }
        continue;
      }
      this.lastSentLine = next.line;
      this.lastPushAt = this.now();
      // RPC and subscription use separate sockets. An older set reply must not undo a resize event received in flight.
      if (this.widthEvent === widthEvent) this.observeWidth(reply.result?.strip?.width);
    }
  }

  /** Clear only this strip slot on the pane. */
  async clear(): Promise<void> {
    await clearPaneStrip(this.paneId, this.position, { timeoutMs: 1000, env: this.env }).catch(() => null);
  }

  /** Stop the subscription and pending pushes; optionally clear the strip slot (default true). */
  async stop(opts: { clear?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.pending = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const peer = this.socket;
    this.socket = null;
    peer?.destroy();
    this.activeAbort?.abort();
    if (this.inFlight) {
      await this.inFlight.catch(() => {});
    }
    if (opts.clear !== false) {
      await this.clear();
    }
  }
}
