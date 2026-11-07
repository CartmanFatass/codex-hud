import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { CODEX_APP_SERVER_SCHEMA, type AppServerObservation } from './app-server.js';

export type AppServerRequestId = string | number;
export type AppServerMessage = { method: string; params: Record<string, unknown>; id?: AppServerRequestId };
export type AppServerDiagnostic =
  | { type: 'disconnected'; reason: string }
  | { type: 'process_exit'; code: number | null; signal: string | null }
  | { type: 'stderr'; text: string };
export interface AppServerCloseResult {
  code: number | null;
  signal: string | null;
  reaped: boolean;
}
export interface AppServerTransportOptions {
  executable: string;
  args: string[];
  cwd: string;
  /** Explicit environment only; caller owns credentials/configuration authorization. */
  env: Record<string, string>;
  requestTimeoutMs?: number;
  /** Optional whole-connection limit. Managed sessions do not expire after one turn. */
  lifetimeMs?: number;
  maxFrameBytes?: number;
}
export class AppServerRequestError extends Error {
  constructor(
    message: string,
    readonly dispatch: 'not_sent' | 'unknown' | 'rejected',
    readonly rpcCode?: number,
    readonly rpcError?: Record<string, unknown>
  ) {
    super(message);
  }
}
type Pending = {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  sent: boolean;
};
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const ident = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
const idValid = (v: unknown): v is AppServerRequestId => (typeof v === 'number' && Number.isSafeInteger(v)) || ident(v);
const boundedInt = (v: number, max: number) => Number.isSafeInteger(v) && v >= 1 && v <= max;

/** One owned app-server child, bounded JSONL and writes. No reconnect, retry, provider fallback or PID recovery. */
export class CodexAppServerTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(message: AppServerMessage) => void>();
  private readonly diagnostics = new Set<(event: AppServerDiagnostic) => void>();
  private readonly timedOut = new Set<number>();
  private nextId = 1;
  private writes: Promise<void> = Promise.resolve();
  private queuedWrites = 0;
  private stopped = false;
  private exited = false;
  private settled = false;
  private reason: string | null = null;
  private buffer = Buffer.alloc(0);
  private readonly requestMs: number;
  private readonly maxFrame: number;
  private lifetime?: NodeJS.Timeout;
  private reapTimer?: NodeJS.Timeout;
  private resolveClosed!: (value: AppServerCloseResult) => void;
  readonly closed: Promise<AppServerCloseResult>;
  private observation: AppServerObservation = {
    schema: CODEX_APP_SERVER_SCHEMA,
    handshake: 'new',
    threadId: null,
    pending: 0,
    notifications: 0,
    unknownNotifications: 0,
    unsupportedRequests: 0,
    errors: 0,
    gaps: 0,
    transport: 'open',
  };

  constructor(options: AppServerTransportOptions) {
    this.requestMs = options.requestTimeoutMs ?? 5000;
    this.maxFrame = options.maxFrameBytes ?? 1024 * 1024;
    if (
      !isAbsolute(options.executable) ||
      options.executable.includes('\0') ||
      !isAbsolute(options.cwd) ||
      options.cwd.includes('\0') ||
      !boundedInt(this.requestMs, 300_000) ||
      !boundedInt(this.maxFrame, 4 * 1024 * 1024) ||
      (options.lifetimeMs !== undefined && !boundedInt(options.lifetimeMs, 86_400_000)) ||
      options.args.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
      Object.entries(options.env).some(([k, v]) => !k || /[=\0]/.test(k) || typeof v !== 'string' || v.includes('\0'))
    )
      throw new Error('invalid_app_server_transport_options');
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: { ...options.env },
      shell: false,
      stdio: 'pipe',
    });
    if (options.lifetimeMs !== undefined)
      this.lifetime = setTimeout(() => this.stop('lifetime_timeout'), options.lifetimeMs);
    this.child.stdin.on('error', () => this.stop('stdin_error'));
    this.child.stdout.on('error', () => this.stop('stdout_error'));
    this.child.stderr.on('error', () => this.stop('stderr_error'));
    this.child.once('error', () => this.stop('spawn_error'));
    this.child.stderr.on('data', (chunk: Buffer) => {
      // Forward diagnostics to the same owning session; do not retain or adjudicate their content.
      this.diagnostic({ type: 'stderr', text: chunk.toString('utf8') });
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.consume(chunk));
    this.child.stdout.once('end', () => {
      if (!this.stopped) this.stop(this.buffer.length ? 'truncated_frame' : 'stdout_eof');
    });
    this.child.once('exit', (code, signal) => {
      this.exited = true;
      this.diagnostic({ type: 'process_exit', code, signal });
      this.stop('child_exit');
    });
    this.child.once('close', (code, signal) => {
      this.exited = true;
      this.stop(code === 0 && !signal ? 'closed' : 'child_exit');
      this.finish({ code, signal, reaped: true });
    });
  }

  snapshot() {
    return {
      observation: { ...this.observation, pending: this.pending.size },
      stopped: this.stopped,
      reason: this.reason,
    };
  }
  onMessage(listener: (message: AppServerMessage) => void): () => void {
    if (this.stopped) throw new AppServerRequestError('app_server_closed', 'not_sent');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onDiagnostic(listener: (event: AppServerDiagnostic) => void): () => void {
    this.diagnostics.add(listener);
    return () => this.diagnostics.delete(listener);
  }
  private diagnostic(event: AppServerDiagnostic): void {
    for (const listener of this.diagnostics) listener(event);
  }

  private consume(chunk: Buffer): void {
    if (this.stopped) return;
    // Process slices before concatenation, so even a giant chunk cannot allocate an unbounded frame.
    let offset = 0;
    while (offset < chunk.length && !this.stopped) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      if (this.buffer.length + end - offset > this.maxFrame) {
        this.stop('frame_limit');
        return;
      }
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, end)]);
      if (newline < 0) return;
      const line = this.buffer;
      this.buffer = Buffer.alloc(0);
      offset = newline + 1;
      try {
        this.read(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)));
      } catch {
        this.stop('protocol_gap');
      }
    }
  }
  private read(msg: unknown): void {
    if (!object(msg) || ('jsonrpc' in msg && msg.jsonrpc !== '2.0')) throw new Error('invalid_frame');
    if ('method' in msg) {
      if (
        !ident(msg.method) ||
        !object(msg.params) ||
        'result' in msg ||
        'error' in msg ||
        ('id' in msg && !idValid(msg.id))
      )
        throw new Error('invalid_frame');
      const message: AppServerMessage = { method: msg.method, params: msg.params };
      if ('id' in msg) message.id = msg.id as AppServerRequestId;
      else this.observation.notifications++;
      if (message.id !== undefined && this.listeners.size === 0) {
        this.observation.unsupportedRequests++;
        this.stop('unsupported_server_request');
      } else {
        for (const listener of this.listeners) listener(message);
      }
      return;
    }
    if (typeof msg.id !== 'number' || 'result' in msg === 'error' in msg) throw new Error('uncorrelated_response');
    // A local read/request deadline does not cancel native work. Consume its late ACK without retrying it.
    if (this.timedOut.delete(msg.id)) return;
    if (!this.pending.has(msg.id)) throw new Error('uncorrelated_response');
    const p = this.pending.get(msg.id)!;
    if ('error' in msg) {
      if (!object(msg.error) || !Number.isSafeInteger(msg.error.code) || typeof msg.error.message !== 'string')
        throw new Error('invalid_rpc_error');
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      this.observation.errors++;
      p.reject(new AppServerRequestError(msg.error.message, 'rejected', msg.error.code as number, msg.error));
    } else {
      if (!object(msg.result)) throw new Error('invalid_result');
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg.result);
    }
  }

  private enqueue(message: object, beforeWrite?: () => void | boolean): Promise<void> {
    let bytes: string;
    try {
      bytes = JSON.stringify(message) + '\n';
    } catch {
      return Promise.reject(new AppServerRequestError('invalid_app_server_message', 'not_sent'));
    }
    if (Buffer.byteLength(bytes) > this.maxFrame)
      return Promise.reject(new AppServerRequestError('outbound_record_limit', 'not_sent'));
    if (this.stopped) return Promise.reject(new AppServerRequestError('app_server_closed', 'not_sent'));
    if (this.queuedWrites >= 32) return Promise.reject(new AppServerRequestError('app_server_write_limit', 'not_sent'));
    this.queuedWrites++;
    const next = this.writes.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.stopped) {
            reject(new AppServerRequestError('app_server_closed', 'not_sent'));
            return;
          }
          if (beforeWrite?.() === false) {
            resolve();
            return;
          }
          this.child.stdin.write(bytes, (error) =>
            error ? reject(new AppServerRequestError('app_server_write_failed', 'unknown')) : resolve()
          );
        })
    );
    this.writes = next.then(
      () => {
        this.queuedWrites--;
      },
      () => {
        this.queuedWrites--;
        this.stop('write_error');
      }
    );
    return next;
  }
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!ident(method) || !object(params))
      return Promise.reject(new AppServerRequestError('invalid_app_server_request', 'not_sent'));
    if (this.stopped) return Promise.reject(new AppServerRequestError('app_server_closed', 'not_sent'));
    if (this.pending.size >= 8)
      return Promise.reject(new AppServerRequestError('app_server_pending_limit', 'not_sent'));
    const id = this.nextId++;
    if (!Number.isSafeInteger(id)) return Promise.reject(new AppServerRequestError('app_server_id_limit', 'not_sent'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.timedOut.add(id);
        if (this.timedOut.size > 512) this.timedOut.delete(this.timedOut.values().next().value!);
        reject(new AppServerRequestError('request_timeout', p.sent ? 'unknown' : 'not_sent'));
      }, this.requestMs);
      const p: Pending = { resolve, reject, timer, sent: false };
      this.pending.set(id, p);
      void this.enqueue({ id, method, params }, () => {
        if (!this.pending.has(id)) return false;
        p.sent = true;
      }).catch((error: Error) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        reject(error);
      });
    });
  }
  notify(method: string): Promise<void> {
    return this.enqueue({ method });
  }
  respond(id: AppServerRequestId, result: unknown, stillCurrent?: () => boolean): Promise<void> {
    if (!idValid(id)) return Promise.reject(new AppServerRequestError('invalid_app_server_id', 'not_sent'));
    return this.enqueue({ id, result }, stillCurrent);
  }
  async initialize(): Promise<void> {
    if (this.observation.handshake !== 'new')
      throw new AppServerRequestError('app_server_initialize_state', 'not_sent');
    this.observation.handshake = 'initializing';
    try {
      const result = await this.request('initialize', {
        clientInfo: { name: 'hud-managed', version: '1', title: null },
        capabilities: null,
      });
      if (!ident(result.userAgent)) {
        this.stop('invalid_initialize');
        throw new AppServerRequestError('invalid_initialize', 'unknown');
      }
      this.observation.handshake = 'acknowledge';
      await this.notify('initialized');
      this.observation.handshake = 'ready';
    } catch (error) {
      this.observation.handshake = 'failed';
      throw error;
    }
  }
  async threadStart(): Promise<void> {
    await this.legacyThread('thread/start', {});
  }
  async threadResume(threadId: string): Promise<void> {
    if (!ident(threadId)) throw new AppServerRequestError('app_server_invalid_thread', 'not_sent');
    await this.legacyThread('thread/resume', { threadId });
  }
  private async legacyThread(method: string, params: Record<string, unknown>): Promise<void> {
    if (this.observation.handshake !== 'ready') throw new AppServerRequestError('app_server_not_ready', 'not_sent');
    const result = await this.request(method, params);
    if (
      !object(result.thread) ||
      !ident(result.thread.id) ||
      (params.threadId && result.thread.id !== params.threadId)
    ) {
      this.stop('thread_mismatch');
      throw new AppServerRequestError('thread_mismatch', 'unknown');
    }
    this.observation.threadId = result.thread.id;
  }
  private finish(result: AppServerCloseResult): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.lifetime);
    clearTimeout(this.reapTimer);
    this.buffer = Buffer.alloc(0);
    this.listeners.clear();
    // Inherited pipes cannot keep an expired owned connection alive. No signaling after direct-child exit.
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    if (!result.reaped) this.child.unref();
    this.resolveClosed(result);
  }
  private stop(reason: string, release = false): void {
    if (!this.stopped) {
      this.stopped = true;
      this.reason = reason;
      this.observation.transport = reason === 'shutdown' || reason === 'closed' ? 'closed' : 'interrupted';
      if (reason === 'protocol_gap' || reason === 'frame_limit' || reason === 'truncated_frame')
        this.observation.gaps++;
      clearTimeout(this.lifetime);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new AppServerRequestError(reason, p.sent ? 'unknown' : 'not_sent'));
      }
      this.pending.clear();
      this.diagnostic({ type: 'disconnected', reason });
    }
    // Protocol/read failures are not authorization to stop a native process. On explicit release,
    // close only this pipe; Codex decides its own EOF behavior. Never signal the child or descendants.
    if (release) this.child.stdin.end();
    if ((release || this.exited) && !this.settled && !this.reapTimer)
      this.reapTimer = setTimeout(() => this.finish({ code: null, signal: null, reaped: false }), 250);
  }
  shutdown(): Promise<AppServerCloseResult> {
    this.stop('shutdown', true);
    return this.closed;
  }
}
