import { constants, promises as fs } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import {
  AdapterDispatchError,
  type AdapterCallbacks,
  type AdapterCreate,
  type AdapterEvent,
  type DispatchReceipt,
  type ManagedAdapterFactory,
  type ManagedAdapterSession,
  type NativeRef,
} from '../../managed/types.js';
import {
  AppServerRequestError,
  CodexAppServerTransport,
  type AppServerMessage,
  type AppServerRequestId,
} from './app-server-transport.js';

/** Protocol reference: openai/codex@d786ff91fad8e7ddab8653ee07bc6313a6fcb03d.
 * This documents fixtures, not a restriction on the user's installed Codex version.
 */
export type CodexApprovalPolicy =
  | 'untrusted'
  | 'on-request'
  | 'never'
  | {
      granular: {
        sandbox_approval: boolean;
        rules: boolean;
        skill_approval: boolean;
        request_permissions: boolean;
        mcp_elicitations: boolean;
      };
    };
export interface CodexManagedAdapterOptions {
  executable: string;
  args?: string[];
  env: Record<string, string>;
  /** Omitted settings remain under native configuration control. */
  approvalPolicy?: CodexApprovalPolicy | null;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access' | null;
  model?: string | null;
  requestTimeoutMs?: number;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const ident = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
const idValid = (v: unknown): v is AppServerRequestId => ident(v) || (typeof v === 'number' && Number.isSafeInteger(v));
const idKey = (id: AppServerRequestId) => `${typeof id}:${id}`;
type PendingRequest = { controller: AbortController };

/** Resolve only the configured local command against the host's supplied PATH. */
async function installedExecutable(options: CodexManagedAdapterOptions, workspace: string): Promise<string> {
  const command = options.executable;
  if (!command || command.includes('\0')) throw new AdapterDispatchError('codex_invalid_executable', 'not_sent');
  const candidates = command.includes('/')
    ? [resolve(workspace, command)]
    : (options.env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => resolve(workspace, directory, command));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      /* Continue local PATH discovery, never fall back to a bundled client. */
    }
  }
  throw new AdapterDispatchError('codex_executable_unavailable', 'not_sent');
}

/** Trusted local executable selection; no package-bundled binary or version admission check. */
export class CodexManagedAdapterFactory implements ManagedAdapterFactory {
  readonly harness = 'codex' as const;
  private readonly options: CodexManagedAdapterOptions;
  constructor(options: CodexManagedAdapterOptions) {
    this.options = { ...options, args: [...(options.args ?? ['app-server'])], env: { ...options.env } };
  }
  async create(request: AdapterCreate, callbacks: AdapterCallbacks): Promise<ManagedAdapterSession> {
    if (!isAbsolute(request.workspace) || request.workspace.includes('\0'))
      throw new AdapterDispatchError('invalid_codex_workspace', 'not_sent');
    if (
      request.origin.kind !== 'new' &&
      (request.origin.source.harness !== 'codex' || !ident(request.origin.source.threadId))
    )
      throw new AdapterDispatchError('invalid_codex_source', 'not_sent');
    // Native resume prefers history/path to threadId, and fork can select by path.
    // Reject alternate locators before discovery/spawn: checking the returned ID is too late.
    const nativeOptions = { ...request.options };
    if (
      request.origin.kind !== 'new' &&
      ['path', 'history', 'threadId'].some((key) => Object.hasOwn(nativeOptions, key))
    )
      throw new AdapterDispatchError('codex_source_locator_options_forbidden', 'not_sent');
    // Capture the validated source/options before the asynchronous executable lookup.
    request = {
      ...request,
      options: nativeOptions,
      origin:
        request.origin.kind === 'new'
          ? { kind: 'new' }
          : { kind: request.origin.kind, source: { ...request.origin.source } },
    };
    const executable = await installedExecutable(this.options, request.workspace);
    const session = new CodexManagedSession({ ...this.options, executable }, request, callbacks);
    await session.start();
    return session;
  }
}

class CodexManagedSession implements ManagedAdapterSession {
  private readonly transport: CodexAppServerTransport;
  private nativeRef: Extract<NativeRef, { harness: 'codex' }> | null = null;
  private thread: Record<string, unknown> | null = null;
  private ready = false;
  private closing = false;
  private disconnected = false;
  private beforeBinding: AppServerMessage[] = [];
  private beforeBindingBytes = 0;
  /** In-memory call correlation only. Never a second turn lifecycle or result authority. */
  private readonly turnCalls = new Map<string, string>();
  private readonly requests = new Map<string, PendingRequest>();
  private closePromise?: Promise<unknown>;

  constructor(
    private readonly options: CodexManagedAdapterOptions,
    private readonly request: AdapterCreate,
    private readonly callbacks: AdapterCallbacks
  ) {
    this.transport = new CodexAppServerTransport({
      executable: options.executable,
      args: options.args!,
      env: options.env,
      cwd: request.workspace,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    this.transport.onMessage((message) => this.onMessage(message));
    this.transport.onDiagnostic((event) => {
      if (event.type === 'disconnected') this.disconnect(event.reason);
      else if (event.type === 'process_exit') this.emit(event);
      else this.emit({ type: 'native_event', kind: 'transport/stderr', payload: event });
    });
  }
  snapshot() {
    return {
      nativeRef: this.nativeRef ? { ...this.nativeRef } : null,
      connected: this.ready && !this.disconnected && !this.closing,
      thread: this.thread,
    };
  }
  async start(): Promise<void> {
    try {
      await this.transport.initialize();
      const { origin } = this.request;
      const params: Record<string, unknown> = { ...this.request.options, cwd: this.request.workspace };
      // Resume/fork identity is selected by the verified source, not arbitrary options.
      delete params.threadId;
      if (this.options.approvalPolicy !== undefined) params.approvalPolicy = this.options.approvalPolicy;
      if (this.options.sandbox !== undefined) params.sandbox = this.options.sandbox;
      if (this.options.model !== undefined) params.model = this.options.model;
      if (origin.kind !== 'new' && origin.source.harness === 'codex') params.threadId = origin.source.threadId;
      const result = await this.transport.request(
        origin.kind === 'new' ? 'thread/start' : `thread/${origin.kind}`,
        params
      );
      const thread = result.thread;
      if (!object(thread) || !ident(thread.id)) throw new Error('invalid_codex_binding');
      if (origin.kind !== 'new' && origin.source.harness === 'codex') {
        if (origin.kind === 'resume' && thread.id !== origin.source.threadId) throw new Error('codex_resume_mismatch');
        if (
          origin.kind === 'fork' &&
          (thread.id === origin.source.threadId ||
            (thread.forkedFromId != null && thread.forkedFromId !== origin.source.threadId))
        )
          throw new Error('codex_fork_mismatch');
      }
      if (result.cwd !== undefined && result.cwd !== this.request.workspace)
        throw new Error('codex_workspace_mismatch');
      this.nativeRef = {
        harness: 'codex',
        threadId: thread.id,
        ...(ident(thread.sessionId) ? { sessionId: thread.sessionId } : {}),
      };
      this.thread = thread;
      if (this.disconnected || this.closing) throw new Error('codex_closed_during_create');
      this.ready = true;
      this.emit({ type: 'binding', nativeRef: { ...this.nativeRef } });
      this.emit({ type: 'ready', payload: result });
      const early = this.beforeBinding;
      this.beforeBinding = [];
      this.beforeBindingBytes = 0;
      for (const message of early) this.onMessage(message);
    } catch (error) {
      // Release only this failed connection, never interrupt a native turn or signal descendants.
      await this.close();
      throw this.dispatchError(error);
    }
  }
  private requireRef(): Extract<NativeRef, { harness: 'codex' }> {
    if (!this.ready || this.closing || this.disconnected || !this.nativeRef)
      throw new AdapterDispatchError('codex_not_ready', 'not_sent');
    return this.nativeRef;
  }
  async send(input: { callId: string; text: string; options?: Record<string, unknown> }): Promise<DispatchReceipt> {
    const ref = this.requireRef();
    if (!ident(input.callId) || typeof input.text !== 'string' || !input.text.length)
      throw new AdapterDispatchError('invalid_codex_input', 'not_sent');
    const { mode = 'start', ...options } = input.options ?? {};
    if (mode !== 'start' && mode !== 'steer') throw new AdapterDispatchError('invalid_codex_input_mode', 'not_sent');
    if (mode === 'steer' && !ident(options.expectedTurnId))
      throw new AdapterDispatchError('codex_expected_turn_required', 'not_sent');
    try {
      const payload = await this.transport.request(mode === 'steer' ? 'turn/steer' : 'turn/start', {
        ...options,
        threadId: ref.threadId,
        input: [{ type: 'text', text: input.text, text_elements: [] }],
      });
      const nativeTurnId = object(payload.turn) ? payload.turn.id : payload.turnId;
      if (ident(nativeTurnId)) {
        this.turnCalls.set(nativeTurnId, input.callId);
        if (this.turnCalls.size > 256) this.turnCalls.delete(this.turnCalls.keys().next().value!);
      }
      // Native payload/status is authoritative, including queued/active/failed or future values.
      return { payload, ...(ident(nativeTurnId) ? { correlation: { nativeTurnId } } : {}) };
    } catch (error) {
      throw this.dispatchError(error);
    }
  }
  async read(options: Record<string, unknown> = {}): Promise<unknown> {
    const ref = this.requireRef();
    const { method = 'thread/read', ...params } = options;
    if (method !== 'thread/read' && method !== 'thread/loaded/list')
      throw new AdapterDispatchError('unsupported_codex_read_method', 'not_sent');
    const result = await this.transport.request(
      method,
      method === 'thread/read' ? { ...params, threadId: ref.threadId } : params
    );
    if (method === 'thread/read' && object(result.thread)) {
      if (result.thread.id !== ref.threadId) throw new Error('codex_read_mismatch');
      this.thread = result.thread;
    }
    return result;
  }
  async cancel(input: { nativeTurnId?: string }): Promise<unknown> {
    const ref = this.requireRef();
    if (!ident(input.nativeTurnId)) throw new AdapterDispatchError('codex_turn_required', 'not_sent');
    return this.transport.request('turn/interrupt', { threadId: ref.threadId, turnId: input.nativeTurnId });
  }
  close(): Promise<unknown> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.ready = false;
    this.invalidateRequests();
    // Closing stdin is connection release, not evidence that background work has stopped.
    this.closePromise = this.transport.shutdown().then((result) => ({ connectionReleased: true, process: result }));
    return this.closePromise;
  }
  private dispatchError(error: unknown): AdapterDispatchError {
    return new AdapterDispatchError(
      error instanceof Error ? error.message : 'codex_request_failed',
      error instanceof AppServerRequestError && error.dispatch === 'not_sent' ? 'not_sent' : 'uncertain',
      { cause: error }
    );
  }
  private emit(event: AdapterEvent): void {
    this.callbacks.event(event);
  }
  private invalidateRequests(): void {
    for (const pending of this.requests.values()) pending.controller.abort();
    this.requests.clear();
  }
  private disconnect(reason: string): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.ready = false;
    this.invalidateRequests();
    this.emit({ type: 'disconnected', reason });
  }
  private onMessage(message: AppServerMessage): void {
    if (this.disconnected || this.closing) return;
    const { method, params, id } = message;
    // One app-server is owned per connection; only this bound thread's traffic can reach its parent.
    const threadId =
      params.threadId ??
      (['execCommandApproval', 'applyPatchApproval'].includes(method) ? params.conversationId : undefined) ??
      (object(params.thread) ? params.thread.id : undefined);
    if (!this.nativeRef && threadId != null) {
      const bytes = Buffer.byteLength(JSON.stringify(message));
      if (this.beforeBindingBytes + bytes > 4 * 1024 * 1024) {
        this.disconnect('codex_pre_binding_limit');
        return;
      }
      this.beforeBinding.push(message);
      this.beforeBindingBytes += bytes;
      return;
    }
    if (threadId != null && threadId !== this.nativeRef?.threadId) return;
    if (id !== undefined) {
      this.forwardRequest(message);
      return;
    }
    if (method === 'serverRequest/resolved' && idValid(params.requestId)) {
      const key = idKey(params.requestId);
      this.requests.get(key)?.controller.abort();
      this.requests.delete(key);
    }
    if (method === 'thread/status/changed' && this.thread) this.thread = { ...this.thread, status: params.status };
    const turnId = object(params.turn) ? params.turn.id : params.turnId;
    const callId = ident(turnId) ? this.turnCalls.get(turnId) : undefined;
    this.emit({
      type: method === 'turn/completed' ? 'native_result' : 'native_event',
      kind: method,
      payload: message,
      ...(callId ? { callId } : {}),
      ...(ident(turnId) ? { correlation: { nativeTurnId: turnId } } : {}),
    });
  }
  private forwardRequest(message: AppServerMessage): void {
    const id = message.id!;
    const key = idKey(id);
    if (this.requests.has(key)) {
      this.emit({
        type: 'native_event',
        kind: 'transport/requestError',
        payload: { requestId: key, error: 'duplicate_request_id' },
      });
      return;
    }
    const pending: PendingRequest = { controller: new AbortController() };
    this.requests.set(key, pending);
    const current = () => this.requests.get(key) === pending && !this.disconnected && !this.closing;
    const callId = ident(message.params.turnId) ? this.turnCalls.get(message.params.turnId) : undefined;
    void Promise.resolve()
      .then(() => {
        if (!current()) return null;
        return this.callbacks.request({
          requestId: key,
          kind: message.method,
          payload: message,
          ...(callId ? { callId } : {}),
          signal: pending.controller.signal,
        });
      })
      .then(async (response) => {
        if (!current()) return;
        if (!response || !Object.hasOwn(response, 'result')) throw new Error('codex_invalid_native_response');
        await this.transport.respond(id, response.result, current);
        if (this.requests.get(key) === pending) this.requests.delete(key);
      })
      .catch((error: unknown) => {
        if (current())
          this.emit({
            type: 'native_event',
            kind: 'transport/requestError',
            payload: { requestId: key, error: error instanceof Error ? error.message : 'callback_failed' },
          });
      });
  }
}
