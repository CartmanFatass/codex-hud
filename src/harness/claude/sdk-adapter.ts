/** A held official streaming Query, not a second agent loop or task lifecycle. */
import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import type {
  CanUseTool,
  OnElicitation,
  OnUserDialog,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  getSessionMessages,
  query,
} from '@anthropic-ai/claude-agent-sdk';
import {
  AdapterDispatchError,
  type AdapterCallbacks,
  type AdapterCreate,
  type DispatchReceipt,
  type ManagedAdapterFactory,
  type ManagedAdapterSession,
  type NativeRef,
} from '../../managed/types.js';

/** Public types only. Optional read methods report actual missing capability at use. */
export type ClaudeQuery = Pick<Query, typeof Symbol.asyncIterator | 'interrupt' | 'close'> &
  Partial<Pick<Query, 'initializationResult' | 'getContextUsage'>>;
export type ClaudeQueryFactory = (input: Parameters<typeof query>[0]) => ClaudeQuery;
export interface ClaudeSdkAdapterOptions {
  queryFactory?: ClaudeQueryFactory;
  getSessionMessages?: typeof getSessionMessages;
  /** Trusted host configuration, never a model-controlled executable or settings surface. */
  sdkOptions?: Pick<
    Options,
    | 'env'
    | 'model'
    | 'tools'
    | 'pathToClaudeCodeExecutable'
    | 'permissionMode'
    | 'allowDangerouslySkipPermissions'
    | 'settingSources'
    | 'supportedDialogKinds'
  >;
}

const validId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const MAX_INPUT_BYTES = 1024 * 1024;
// These identify an inherited caller, unlike ordinary HUD preferences and storage location.
const CALLER_ENV = [
  'HUD_CALLER_ID',
  'HUD_CONTEXT_ID',
  'HUD_CONTEXT_GENERATION',
  'HUD_MCP_PROFILE',
  'HUD_CLAUDE_HOOK_CONFIG',
  'HUD_PI_EVIDENCE_FD',
  'HUD_CLAIM',
  'HUD_RUN',
  'HUD_LINK',
  'HUD_OWNER_ID',
  'HUD_CONTEXT',
  'HUD_PI_DELEGATION_FD',
  'HUD_NATIVE_SOURCE',
  'HUD_NATIVE_SOURCE_FILE',
];

/** Resolve the user's selected command, never the SDK's bundled executable. */
async function installedExecutable(
  configuration: ClaudeSdkAdapterOptions['sdkOptions'],
  workspace: string
): Promise<string> {
  const command = configuration?.pathToClaudeCodeExecutable ?? 'claude';
  if (!command || command.includes('\0')) throw new AdapterDispatchError('claude_invalid_executable', 'not_sent');
  const env = configuration?.env ?? process.env;
  const candidates = command.includes('/')
    ? [resolve(workspace, command)]
    : (env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => resolve(workspace, dir, command));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      /* Try the next PATH entry; no alternate client or version fallback. */
    }
  }
  throw new AdapterDispatchError('claude_executable_unavailable', 'not_sent');
}

/** Transport inbox only; the native harness decides how inputs are consumed. */
class PromptStream implements AsyncIterableIterator<SDKUserMessage> {
  private readonly queued: SDKUserMessage[] = [];
  private waiting?: (result: IteratorResult<SDKUserMessage>) => void;
  private ended = false;
  [Symbol.asyncIterator](): AsyncIterableIterator<SDKUserMessage> {
    return this;
  }
  next(): Promise<IteratorResult<SDKUserMessage>> {
    const value = this.queued.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
  push(value: SDKUserMessage): void {
    if (this.ended) throw new AdapterDispatchError('claude_input_unavailable', 'not_sent');
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ done: false, value });
    } else this.queued.push(value);
  }
  end(): void {
    this.ended = true;
    this.queued.length = 0;
    this.waiting?.({ done: true, value: undefined });
    this.waiting = undefined;
  }
}

function topLevel(message: SDKMessage): boolean {
  const frame = message as SDKMessage & { parent_tool_use_id?: unknown; agent_id?: unknown; subagent_type?: unknown };
  return frame.parent_tool_use_id == null && frame.agent_id == null && frame.subagent_type == null;
}

export class ClaudeSdkAdapterFactory implements ManagedAdapterFactory {
  readonly harness = 'claude' as const;
  constructor(private readonly configuration: ClaudeSdkAdapterOptions = {}) {}
  async create(request: AdapterCreate, callbacks: AdapterCallbacks): Promise<ManagedAdapterSession> {
    if (!isAbsolute(request.workspace) || request.workspace.includes('\0'))
      throw new AdapterDispatchError('claude_invalid_workspace', 'not_sent');
    if (
      request.origin.kind !== 'new' &&
      (request.origin.source.harness !== 'claude' || !validId(request.origin.source.sessionId))
    )
      throw new AdapterDispatchError('claude_invalid_source', 'not_sent');
    // There is intentionally no model-controlled permission/configuration override.
    if (request.options && Object.keys(request.options).length)
      throw new AdapterDispatchError('claude_unsupported_create_options', 'not_sent');
    const executable = await installedExecutable(this.configuration.sdkOptions, request.workspace);
    let factory = this.configuration.queryFactory;
    if (!factory) {
      try {
        factory = (await import('@anthropic-ai/claude-agent-sdk')).query;
      } catch (cause) {
        throw new AdapterDispatchError('claude_sdk_unavailable', 'not_sent', { cause });
      }
    }
    return new ClaudeSdkSession(request, callbacks, factory, {
      ...this.configuration,
      sdkOptions: { ...this.configuration.sdkOptions, pathToClaudeCodeExecutable: executable },
    });
  }
}

class ClaudeSdkSession implements ManagedAdapterSession {
  private readonly input = new PromptStream();
  private readonly requests = new AbortController();
  private readonly query: ClaudeQuery;
  private nativeRef: Extract<NativeRef, { harness: 'claude' }> | null = null;
  private readonly calls = new Map<string, string>();
  private unavailable = false;
  private released = false;
  constructor(
    private readonly request: AdapterCreate,
    private readonly callbacks: AdapterCallbacks,
    factory: ClaudeQueryFactory,
    private readonly configuration: ClaudeSdkAdapterOptions
  ) {
    const supplied = configuration.sdkOptions ?? {};
    const env = { ...(supplied.env ?? process.env) };
    for (const name of CALLER_ENV) delete env[name];
    const options: Options = {
      ...supplied,
      cwd: request.workspace,
      env,
      canUseTool: this.canUseTool,
      onElicitation: this.onElicitation,
      onUserDialog: this.onUserDialog,
      // The public SDK requires both the callback and an explicit capability
      // declaration. Relay this documented dialog to the caller unchanged; HUD
      // does not choose its answer. Trusted hosts may declare other supported
      // kinds, or [] to opt out. Never claim wildcard/future dialog support.
      supportedDialogKinds: supplied.supportedDialogKinds ?? ['refusal_fallback_prompt'],
      stderr: (data) => callbacks.event({ type: 'native_event', kind: 'claude_stderr', payload: data }),
      ...(request.origin.kind === 'new'
        ? {}
        : {
            resume: request.origin.source.harness === 'claude' ? request.origin.source.sessionId : undefined,
            ...(request.origin.kind === 'fork' ? { forkSession: true } : {}),
          }),
    };
    // No probe input, changed native permissions, disabled settings, or background-work policy.
    try {
      this.query = factory({ prompt: this.input, options });
    } catch (cause) {
      this.input.end();
      throw new AdapterDispatchError('claude_query_create_failed', 'not_sent', { cause });
    }
    void this.consume();
  }

  snapshot(): ReturnType<ManagedAdapterSession['snapshot']> {
    return { nativeRef: this.nativeRef ? { ...this.nativeRef } : null };
  }
  async send(input: Parameters<ManagedAdapterSession['send']>[0]): Promise<DispatchReceipt> {
    if (this.unavailable) throw new AdapterDispatchError('claude_session_unavailable', 'not_sent');
    if (!input.callId || typeof input.text !== 'string' || Buffer.byteLength(input.text) > MAX_INPUT_BYTES)
      throw new AdapterDispatchError('claude_invalid_input', 'not_sent');
    if (input.options && Object.keys(input.options).length)
      throw new AdapterDispatchError('claude_unsupported_send_options', 'not_sent');
    const uuid = randomUUID();
    this.calls.set(uuid, input.callId);
    this.input.push({
      type: 'user',
      uuid,
      parent_tool_use_id: null,
      message: { role: 'user', content: input.text },
      ...(this.nativeRef ? { session_id: this.nativeRef.sessionId } : {}),
    });
    // Receipt identifies this input, not native acceptance, success, or a terminal state.
    return { correlation: { userMessageUuid: uuid } };
  }
  async read(options: Record<string, unknown> = {}): Promise<unknown> {
    const method = options.method ?? 'initializationResult';
    if (method === 'initializationResult') {
      if (this.unavailable) throw new AdapterDispatchError('claude_session_unavailable', 'not_sent');
      if (!this.query.initializationResult)
        throw new AdapterDispatchError('claude_initialization_read_unavailable', 'not_sent');
      return this.query.initializationResult();
    }
    if (method === 'getContextUsage') {
      if (this.unavailable) throw new AdapterDispatchError('claude_session_unavailable', 'not_sent');
      if (!this.query.getContextUsage) throw new AdapterDispatchError('claude_context_read_unavailable', 'not_sent');
      if (options.detail !== undefined && options.detail !== 'summary' && options.detail !== 'full')
        throw new AdapterDispatchError('claude_invalid_read_options', 'not_sent');
      return this.query.getContextUsage({ detail: options.detail });
    }
    if (method !== 'getSessionMessages') throw new AdapterDispatchError('claude_unsupported_read_method', 'not_sent');
    const sessionId =
      this.nativeRef?.sessionId ??
      (this.request.origin.kind === 'resume' && this.request.origin.source.harness === 'claude'
        ? this.request.origin.source.sessionId
        : undefined);
    if (!sessionId) throw new AdapterDispatchError('claude_native_id_unavailable', 'not_sent');
    for (const key of ['offset', 'limit'] as const)
      if (options[key] !== undefined && (!Number.isSafeInteger(options[key]) || (options[key] as number) < 0))
        throw new AdapterDispatchError('claude_invalid_read_options', 'not_sent');
    if (options.includeSystemMessages !== undefined && typeof options.includeSystemMessages !== 'boolean')
      throw new AdapterDispatchError('claude_invalid_read_options', 'not_sent');
    // The public SDK disk reader uses its own process environment. Never mutate
    // process.env or silently read another profile when the child was configured differently.
    const env = this.configuration.sdkOptions?.env;
    if (
      !this.configuration.getSessionMessages &&
      env &&
      ['HOME', 'CLAUDE_CONFIG_DIR'].some((key) => env[key] !== process.env[key])
    )
      throw new AdapterDispatchError('claude_history_profile_unavailable', 'not_sent');
    const reader =
      this.configuration.getSessionMessages ?? (await import('@anthropic-ai/claude-agent-sdk')).getSessionMessages;
    return reader(sessionId, {
      dir: this.request.workspace,
      offset: options.offset as number | undefined,
      limit: options.limit as number | undefined,
      includeSystemMessages: options.includeSystemMessages as boolean | undefined,
    });
  }
  async cancel(input: { nativeTurnId?: string }): Promise<unknown> {
    if (this.unavailable) throw new AdapterDispatchError('claude_session_unavailable', 'not_sent');
    // Query.interrupt is session-wide; never pretend to target a particular turn.
    if (input.nativeTurnId !== undefined)
      throw new AdapterDispatchError('claude_turn_interrupt_unsupported', 'not_sent');
    try {
      return await this.query.interrupt();
    } catch (cause) {
      throw new AdapterDispatchError('claude_interrupt_unconfirmed', 'uncertain', { cause });
    }
  }
  async close(): Promise<{ connectionReleased: boolean; workStopped: 'unknown' }> {
    this.disconnect('claude_query_closed');
    if (!this.released) {
      this.query.close();
      this.released = true;
    }
    return { connectionReleased: true, workStopped: 'unknown' };
  }
  private disconnect(reason: string): void {
    if (this.unavailable) return;
    this.unavailable = true;
    this.input.end();
    this.requests.abort();
    this.calls.clear();
    this.callbacks.event({ type: 'disconnected', reason });
  }
  private bind(sessionId: string): boolean {
    if (!validId(sessionId)) return false;
    if (this.nativeRef) return this.nativeRef.sessionId === sessionId;
    const origin = this.request.origin;
    if (
      origin.kind !== 'new' &&
      origin.source.harness === 'claude' &&
      ((origin.kind === 'resume' && sessionId !== origin.source.sessionId) ||
        (origin.kind === 'fork' && sessionId === origin.source.sessionId))
    )
      return false;
    this.nativeRef = { harness: 'claude', sessionId };
    this.callbacks.event({ type: 'binding', nativeRef: { ...this.nativeRef } });
    return true;
  }
  private async consume(): Promise<void> {
    try {
      // A for-await early return calls iterator.return(), which can dispose an
      // SDK generator. Only the explicit close method may release this Query.
      const iterator = this.query[Symbol.asyncIterator]();
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        if (this.unavailable) return;
        const message = next.value;
        // Descendant and background messages remain visible, but cannot replace
        // the root identity. Binding is not a synthetic turn-completion test.
        if (
          topLevel(message) &&
          'session_id' in message &&
          typeof message.session_id === 'string' &&
          !this.bind(message.session_id)
        ) {
          this.callbacks.event({ type: 'native_event', kind: 'claude_binding_mismatch', payload: message });
          this.disconnect('claude_source_binding_mismatch');
          return;
        }
        const frame = message as SDKMessage & { user_message_uuid?: string };
        const uuid = frame.user_message_uuid;
        const callId = uuid ? this.calls.get(uuid) : undefined;
        this.callbacks.event({
          type: message.type === 'result' ? 'native_result' : 'native_event',
          kind: 'claude_message',
          payload: message,
          ...(callId ? { callId, correlation: { userMessageUuid: uuid } } : {}),
        });
      }
      this.disconnect('claude_query_ended');
    } catch (error) {
      this.callbacks.event({
        type: 'native_event',
        kind: 'claude_query_error',
        payload: error instanceof Error ? { name: error.name, message: error.message } : error,
      });
      this.disconnect('claude_query_failed');
    }
    // Never call close implicitly, including EOF, errors, deferred results and background work.
  }
  private async relayNativeRequest(
    requestId: string,
    kind: string,
    payload: unknown,
    nativeSignal: AbortSignal
  ): Promise<unknown> {
    const signal = AbortSignal.any([nativeSignal, this.requests.signal]);
    signal.throwIfAborted();
    if (!requestId) throw new AdapterDispatchError('claude_native_request_id_unavailable', 'not_sent');
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (succeeded: boolean, result: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', aborted);
        if (succeeded) resolve(result);
        else reject(result);
      };
      const aborted = () => finish(false, signal.reason);
      signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return this.callbacks.request({ requestId, kind, payload: structuredClone(payload), signal });
        })
        .then((response) => response.result)
        .then(
          (result) => finish(true, result),
          (error: unknown) => finish(false, error)
        );
    });
  }
  private readonly canUseTool: CanUseTool = async (toolName, input, { signal, ...options }) =>
    (await this.relayNativeRequest(
      options.requestId,
      'claude_tool_permission',
      { toolName, input, options },
      signal
    )) as Awaited<ReturnType<CanUseTool>>;
  private readonly onElicitation: OnElicitation = async (request, { signal, ...options }) =>
    (await this.relayNativeRequest(options.requestId, 'claude_elicitation', { request, options }, signal)) as Awaited<
      ReturnType<OnElicitation>
    >;
  private readonly onUserDialog: OnUserDialog = async (request, { signal, ...options }) =>
    (await this.relayNativeRequest(options.requestId, 'claude_user_dialog', { request, options }, signal)) as Awaited<
      ReturnType<OnUserDialog>
    >;
}
