import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { CodexAppServerObserver } from './app-server.js';

type Pending = { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
export interface AppServerTransportOptions {
  executable: string;
  args: string[];
  cwd: string;
  /** Explicit environment only; caller owns credentials/configuration authorization. */
  env: Record<string, string>;
  requestTimeoutMs?: number;
  lifetimeMs?: number;
}
/** Explicit opt-in child owner. No automatic approval, reconnect, retry or capability promotion. */
export class CodexAppServerTransport {
  private readonly observer = new CodexAppServerObserver();
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private writes: Promise<void> = Promise.resolve();
  private stopped = false;
  private reason: string | null = null;
  private stderrBytes = 0;
  private readonly requestMs: number;
  private readonly lifetime: NodeJS.Timeout;
  private killTimer?: NodeJS.Timeout;
  private reapTimer?: NodeJS.Timeout;
  private resolveClosed!: (value: { code: number | null; signal: string | null; reaped: boolean }) => void;
  readonly closed: Promise<{ code: number | null; signal: string | null; reaped: boolean }>;
  constructor(options: AppServerTransportOptions) {
    const requestMs = options.requestTimeoutMs ?? 5000;
    const lifetimeMs = options.lifetimeMs ?? 30_000;
    if (
      !isAbsolute(options.executable) ||
      !isAbsolute(options.cwd) ||
      !Number.isSafeInteger(requestMs) ||
      requestMs < 1 ||
      requestMs > 300_000 ||
      !Number.isSafeInteger(lifetimeMs) ||
      lifetimeMs < 1 ||
      lifetimeMs > 300_000 ||
      options.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    )
      throw new Error('invalid_app_server_transport_options');
    this.requestMs = requestMs;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: { ...options.env },
      shell: false,
      stdio: 'pipe',
    });
    this.lifetime = setTimeout(() => this.stop('lifetime_timeout'), lifetimeMs);
    this.child.stdin.on('error', () => this.stop('stdin_error'));
    this.child.stdout.on('error', () => this.stop('stdout_error'));
    this.child.stderr.on('error', () => this.stop('stderr_error'));
    this.child.on('error', () => this.stop('spawn_error'));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > 64 * 1024) this.stop('stderr_limit');
    });
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.stopped) return;
      for (const event of this.observer.push(chunk)) {
        if (event.kind === 'gap') {
          this.stop('protocol_gap');
          break;
        }
        if (event.kind === 'unsupported_request') {
          this.stop('unsupported_server_request');
          break;
        }
        if (event.kind === 'response' && typeof event.id === 'number') {
          const pending = this.pending.get(event.id);
          if (!pending) {
            this.stop('uncorrelated_response');
            break;
          }
          this.pending.delete(event.id);
          clearTimeout(pending.timer);
          if (event.ok) pending.resolve();
          else pending.reject(new Error('app_server_request_failed'));
        }
      }
    });
    this.child.once('close', (code, signal) => {
      clearTimeout(this.lifetime);
      clearTimeout(this.killTimer);
      clearTimeout(this.reapTimer);
      this.stopped = true;
      if (!this.reason) this.reason = code === 0 && !signal ? 'closed' : 'child_exit';
      this.rejectPending('app_server_closed');
      this.observer.finish();
      this.resolveClosed({ code, signal, reaped: true });
    });
  }
  snapshot() {
    return { observation: this.observer.snapshot(), stopped: this.stopped, reason: this.reason };
  }
  private enqueue(message: object): Promise<void> {
    const bytes = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(bytes) > 64 * 1024) throw new Error('outbound_record_limit');
    const next = this.writes.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.stopped) {
            reject(new Error('app_server_closed'));
            return;
          }
          // Only one write is active. Its callback gates the next write, including backpressure.
          this.child.stdin.write(bytes, (error) => (error ? reject(new Error('app_server_write_failed')) : resolve()));
        })
    );
    this.writes = next.catch(() => {
      this.stop('write_error');
    });
    return next;
  }
  private request(make: (id: number) => object): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('app_server_closed'));
    if (this.pending.size >= 8) return Promise.reject(new Error('app_server_pending_limit'));
    const id = this.nextId++;
    let message: object;
    try {
      message = make(id);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stop('request_timeout'), this.requestMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.enqueue(message).catch(() => this.stop('write_error'));
    });
  }
  async initialize(): Promise<void> {
    await this.request((id) => this.observer.initialize(id, { name: 'hud-opt-in-transport', version: '1' }));
    await this.enqueue(this.observer.initialized());
  }
  threadStart(): Promise<void> {
    return this.request((id) => this.observer.threadStart(id));
  }
  threadResume(threadId: string): Promise<void> {
    return this.request((id) => this.observer.threadResume(id, threadId));
  }
  private rejectPending(reason: string) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }
  private stop(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.reason = reason;
    clearTimeout(this.lifetime);
    this.rejectPending(reason);
    this.observer.finish();
    this.child.stdin.destroy();
    this.child.kill('SIGTERM');
    this.killTimer = setTimeout(() => this.child.kill('SIGKILL'), 250);
    this.reapTimer = setTimeout(() => this.resolveClosed({ code: null, signal: null, reaped: false }), 1500);
  }
  shutdown(): Promise<{ code: number | null; signal: string | null; reaped: boolean }> {
    this.stop('shutdown');
    return this.closed;
  }
}
