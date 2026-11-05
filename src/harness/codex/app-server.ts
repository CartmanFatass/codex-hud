/** Bounded observation seam for a small pinned app-server JSON-RPC subset, not exec or rollout. */
export const CODEX_APP_SERVER_SCHEMA = 'openai/codex@d786ff91fad8e7ddab8653ee07bc6313a6fcb03d';
type Id = string | number;
type Method = 'initialize' | 'thread/start' | 'thread/resume';
type Pending = { method: Method; expectedThread?: string };
export interface AppServerObservation {
  schema: string;
  handshake: 'new' | 'initializing' | 'acknowledge' | 'ready' | 'failed';
  threadId: string | null;
  pending: number;
  notifications: number;
  unknownNotifications: number;
  unsupportedRequests: number;
  errors: number;
  gaps: number;
  transport: 'open' | 'closed' | 'interrupted';
}
export type ServerInput =
  | { kind: 'notification'; method: string }
  | { kind: 'unsupported_request'; method: string; id: Id }
  | { kind: 'response'; method: Method; id: Id; ok: boolean }
  | { kind: 'gap' };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const ident = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
const idValid = (v: unknown): v is Id => (typeof v === 'number' && Number.isSafeInteger(v)) || ident(v);
const key = (v: Id) => `${typeof v}:${v}`;
const knownNotifications = new Set([
  'thread/started',
  'thread/status/changed',
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
]);

/** No process, authorization, persistent session, approval, or managed launch is provided. */
export class CodexAppServerObserver {
  private state: AppServerObservation = {
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
  private readonly requests = new Map<string, Pending>();
  private readonly used = new Set<string>();
  private buffer = Buffer.alloc(0);
  private bytes = 0;
  snapshot(): AppServerObservation {
    return structuredClone(this.state);
  }
  private open(): void {
    if (this.state.transport !== 'open') throw new Error('app_server_transport_closed');
  }
  private register(id: Id, value: Pending): void {
    this.open();
    if (!idValid(id) || this.used.has(key(id)) || this.used.size >= 256)
      throw new Error('app_server_invalid_or_reused_id');
    this.used.add(key(id));
    this.requests.set(key(id), value);
    this.state.pending = this.requests.size;
  }
  initialize(id: Id, clientInfo: { name: string; version: string }): object {
    if (this.state.handshake !== 'new' || !ident(clientInfo.name) || !ident(clientInfo.version))
      throw new Error('app_server_initialize_state');
    this.register(id, { method: 'initialize' });
    this.state.handshake = 'initializing';
    return { id, method: 'initialize', params: { clientInfo: { ...clientInfo, title: null }, capabilities: null } };
  }
  initialized(): object {
    this.open();
    if (this.state.handshake !== 'acknowledge') throw new Error('app_server_initialize_state');
    this.state.handshake = 'ready';
    return { method: 'initialized' };
  }
  threadStart(id: Id): object {
    this.ready();
    this.register(id, { method: 'thread/start' });
    return { id, method: 'thread/start', params: {} };
  }
  threadResume(id: Id, threadId: string): object {
    this.ready();
    if (!ident(threadId)) throw new Error('app_server_invalid_thread');
    this.register(id, { method: 'thread/resume', expectedThread: threadId });
    return { id, method: 'thread/resume', params: { threadId } };
  }
  private ready(): void {
    this.open();
    if (this.state.handshake !== 'ready') throw new Error('app_server_not_ready');
  }
  /** Push arbitrary stdio bytes. Returns metadata only; never stores message bodies or answers server requests. */
  push(chunk: Uint8Array): ServerInput[] {
    this.open();
    this.bytes += chunk.byteLength;
    if (this.bytes > 4 * 1024 * 1024) {
      this.state.gaps++;
      this.state.transport = 'interrupted';
      this.buffer = Buffer.alloc(0);
      return [{ kind: 'gap' }];
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const events: ServerInput[] = [];
    let newline: number;
    while ((newline = this.buffer.indexOf(10)) >= 0) {
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      events.push(this.read(line));
    }
    if (this.buffer.length > 64 * 1024) {
      this.state.gaps++;
      this.state.transport = 'interrupted';
      this.buffer = Buffer.alloc(0);
      events.push({ kind: 'gap' });
    }
    return events;
  }
  finish(): AppServerObservation {
    if (this.state.transport !== 'open') return this.snapshot();
    if (this.buffer.length || this.requests.size) this.state.gaps++;
    this.buffer = Buffer.alloc(0);
    this.state.transport = 'closed';
    return this.snapshot();
  }
  private read(bytes: Uint8Array): ServerInput {
    const gap = (): ServerInput => {
      this.state.gaps++;
      return { kind: 'gap' };
    };
    let msg: unknown;
    try {
      if (bytes.byteLength > 64 * 1024) return gap();
      msg = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      return gap();
    }
    if (!object(msg)) return gap();
    if (typeof msg.method === 'string') {
      if (!ident(msg.method)) return gap();
      if ('id' in msg) {
        if (!idValid(msg.id)) return gap();
        this.state.unsupportedRequests++;
        return { kind: 'unsupported_request', method: msg.method, id: msg.id };
      }
      if (!object(msg.params)) return gap();
      this.state.notifications++;
      if (!knownNotifications.has(msg.method)) this.state.unknownNotifications++;
      return { kind: 'notification', method: msg.method };
    }
    if (!idValid(msg.id) || !this.requests.has(key(msg.id)) || 'result' in msg === 'error' in msg) return gap();
    const pending = this.requests.get(key(msg.id))!;
    if ('error' in msg) {
      if (!object(msg.error) || !Number.isSafeInteger(msg.error.code) || typeof msg.error.message !== 'string')
        return gap();
      this.requests.delete(key(msg.id));
      this.state.pending = this.requests.size;
      this.state.errors++;
      if (pending.method === 'initialize') this.state.handshake = 'failed';
      return { kind: 'response', method: pending.method, id: msg.id, ok: false };
    }
    if (!object(msg.result)) return gap();
    if (pending.method === 'initialize') {
      if (!ident(msg.result.userAgent)) return gap();
      this.state.handshake = 'acknowledge';
    } else {
      if (
        !object(msg.result.thread) ||
        !ident(msg.result.thread.id) ||
        (pending.expectedThread && pending.expectedThread !== msg.result.thread.id)
      )
        return gap();
      this.state.threadId = msg.result.thread.id;
    }
    this.requests.delete(key(msg.id));
    this.state.pending = this.requests.size;
    return { kind: 'response', method: pending.method, id: msg.id, ok: true };
  }
}
