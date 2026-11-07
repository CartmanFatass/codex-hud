import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type {
  CanUseTool,
  Options,
  OnUserDialog,
  PermissionResult,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultError,
  SDKResultSuccess,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  ClaudeSdkAdapterFactory,
  type ClaudeQuery,
  type ClaudeQueryFactory,
  type ClaudeSdkAdapterOptions,
} from '../../src/harness/claude/sdk-adapter.js';
import {
  AdapterDispatchError,
  type AdapterCallbacks,
  type AdapterCreate,
  type AdapterEvent,
  type NativeResponse,
  type NativeRequest,
} from '../../src/managed/types.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
let workspace: string;
let oldHome: string | undefined;
let oldHudHome: string | undefined;
before(() => {
  workspace = mkdtempSync(join(tmpdir(), 'hud-claude-sdk-'));
  oldHome = process.env.HOME;
  oldHudHome = process.env.HUD_HOME;
  process.env.HOME = workspace;
  process.env.HUD_HOME = join(workspace, '.hud');
});
after(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldHudHome === undefined) delete process.env.HUD_HOME;
  else process.env.HUD_HOME = oldHudHome;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const usage: SDKResultSuccess['usage'] = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  fallback_credit: null,
  inference_geo: 'not_applicable',
  iterations: [],
  output_tokens_details: { thinking_tokens: 0 },
  server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
  service_tier: 'standard',
  speed: 'standard',
};
function init(session_id = SESSION): SDKSystemMessage {
  return {
    type: 'system',
    subtype: 'init',
    uuid: randomUUID(),
    session_id,
    apiKeySource: 'none',
    claude_code_version: '2.1.319',
    cwd: workspace,
    tools: [],
    mcp_servers: [],
    model: 'synthetic',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
  };
}
function success(user_message_uuid?: string, patch: Partial<SDKResultSuccess> = {}): SDKResultSuccess {
  return {
    type: 'result',
    subtype: 'success',
    uuid: randomUUID(),
    session_id: SESSION,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: 'Synthetic final answer',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage,
    modelUsage: {},
    permission_denials: [],
    user_message_uuid,
    ...patch,
  };
}
function failure(user_message_uuid: string): SDKResultError {
  return { ...success(user_message_uuid), subtype: 'error_max_turns', errors: ['Synthetic limit'], is_error: true };
}
function assistant(user_message_uuid: string, parent_tool_use_id: string | null = null): SDKAssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    session_id: SESSION,
    parent_tool_use_id,
    user_message_uuid,
    message: {
      id: 'synthetic-message',
      type: 'message',
      role: 'assistant',
      model: 'synthetic',
      content: [{ type: 'text', text: 'Partial text', citations: null }],
      usage,
      stop_reason: null,
      stop_sequence: null,
      container: null,
      context_management: null,
      diagnostics: null,
      stop_details: null,
    },
  };
}

/** Fake consumes exactly the public query(prompt: AsyncIterable) input/output boundary. */
class FakeQuery implements ClaudeQuery {
  readonly messages: SDKUserMessage[] = [];
  readonly options: Options;
  readonly initialization = { native_field: 'synthetic-initialization' };
  async initializationResult() {
    return this.initialization as never;
  }
  async getContextUsage(options?: { detail?: 'summary' | 'full' }) {
    return { ...options, nativeUsage: 7 } as never;
  }
  interrupts = 0;
  closes = 0;
  iteratorReturns = 0;
  failClose = false;
  failInterrupt = false;
  queued: string[] = [];
  private readonly frames: SDKMessage[] = [];
  private waiter?: ReturnType<typeof deferred<void>>;
  private ended = false;
  private error?: Error;
  constructor(args: Parameters<ClaudeQueryFactory>[0], onInput?: (message: SDKUserMessage, fake: FakeQuery) => void) {
    assert.notEqual(typeof args.prompt, 'string');
    const stream = args.prompt as AsyncIterable<SDKUserMessage>;
    this.options = args.options ?? {};
    void (async () => {
      for await (const message of stream) {
        this.messages.push(message);
        onInput?.(message, this);
      }
    })();
  }
  emit(message: SDKMessage) {
    this.frames.push(message);
    this.waiter?.resolve();
  }
  end(error?: Error) {
    this.error = error;
    this.ended = true;
    this.waiter?.resolve();
  }
  [Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    const iterator = this.readFrames();
    const close = iterator.return.bind(iterator);
    iterator.return = (value) => {
      this.iteratorReturns++;
      return close(value);
    };
    return iterator;
  }
  private async *readFrames(): AsyncGenerator<SDKMessage, void> {
    while (true) {
      if (this.frames.length) {
        yield this.frames.shift()!;
        continue;
      }
      if (this.error) throw this.error;
      if (this.ended) return;
      this.waiter = deferred<void>();
      await this.waiter.promise;
    }
  }
  async interrupt() {
    this.interrupts++;
    if (this.failInterrupt) throw new Error('synthetic interrupt failure');
    return { still_queued: this.queued };
  }
  close() {
    this.closes++;
    if (this.failClose) throw new Error('synthetic close failure');
    this.end();
  }
  // SDK contract: callback presence alone does not opt into dialog delivery.
  dialog(request: Parameters<OnUserDialog>[0], requestId = 'native-dialog') {
    if (!this.options.supportedDialogKinds?.includes(request.dialogKind)) return undefined;
    return this.options.onUserDialog!(request, { signal: new AbortController().signal, requestId });
  }
  permission(
    toolName = 'Bash',
    input: Record<string, unknown> = { command: 'printf synthetic' },
    overrides: Partial<Parameters<CanUseTool>[2]> = {}
  ) {
    return this.options.canUseTool!(toolName, input, {
      toolUseID: 'synthetic-tool',
      requestId: 'synthetic-request',
      signal: new AbortController().signal,
      ...overrides,
    });
  }
}

async function setup(
  t: TestContext,
  changes: {
    origin?: AdapterCreate['origin'];
    request?: AdapterCallbacks['request'];
    sdkOptions?: ClaudeSdkAdapterOptions['sdkOptions'];
    getSessionMessages?: ClaudeSdkAdapterOptions['getSessionMessages'];
    onInput?: (message: SDKUserMessage, fake: FakeQuery) => void;
  } = {}
) {
  const fakes: FakeQuery[] = [];
  const events: AdapterEvent[] = [];
  const requests: NativeRequest[] = [];
  const adapter = new ClaudeSdkAdapterFactory({
    queryFactory: (args) => {
      const fake = new FakeQuery(args, changes.onInput);
      fakes.push(fake);
      return fake;
    },
    // This synthetic executable is never started by FakeQuery.
    sdkOptions: {
      env: { HOME: workspace, HUD_HOME: join(workspace, '.hud') },
      pathToClaudeCodeExecutable: process.execPath,
      ...changes.sdkOptions,
    },
    getSessionMessages: changes.getSessionMessages,
  });
  const session = await adapter.create(
    { workspace, origin: changes.origin ?? { kind: 'new' } },
    {
      event: (event) => events.push(event),
      request: (request) => {
        requests.push(request);
        return changes.request?.(request) ?? new Promise<NativeResponse>(() => {});
      },
    }
  );
  t.after(() => {
    fakes[0].failClose = false;
    return session.close();
  });
  const fake = fakes[0];
  const send = async (callId = 'call-one') => {
    const receipt = await session.send({ callId, text: 'Synthetic input' });
    await tick();
    return receipt.correlation!.userMessageUuid!;
  };
  const results = () =>
    events.filter((event): event is Extract<AdapterEvent, { kind: string }> => event.type === 'native_result');
  return { session, fake, fakes, events, requests, send, results };
}

test('Claude: one streaming Query accepts inputs without a HUD single-operation gate', async (t) => {
  const h = await setup(t);
  await tick();
  assert.deepEqual(h.session.snapshot(), { nativeRef: null });
  assert.equal(h.fake.messages.length, 0);
  const first = await h.send();
  const second = await h.send('call-two');
  assert.notEqual(first, second);
  assert.equal(h.fake.messages[0].session_id, undefined);
  assert.deepEqual(h.fake.messages[0].message, { role: 'user', content: 'Synthetic input' });
  h.fake.emit(init());
  const one = success(first);
  const two = success(second, { result: 'Second answer' });
  h.fake.emit(one);
  h.fake.emit(two);
  await tick();
  assert.deepEqual(h.session.snapshot(), { nativeRef: { harness: 'claude', sessionId: SESSION } });
  assert.equal(h.fakes.length, 1);
  assert.deepEqual(
    h.results().map((event) => [event.callId, event.payload]),
    [
      ['call-one', one],
      ['call-two', two],
    ]
  );
  const third = await h.send('call-three');
  assert.equal(h.fake.messages[2].session_id, SESSION);
  assert.notEqual(third, second);
});

test('Claude: all native messages survive, including descendants and uncorrelated/merged results', async (t) => {
  const h = await setup(t);
  const uuid = await h.send();
  const messages = [
    init(),
    success(),
    success('unrelated-input'),
    assistant(uuid, 'subagent-tool'),
    { ...success(uuid), parent_tool_use_id: 'subagent-tool', session_id: OTHER } as SDKMessage,
    success('last-input', { user_message_uuids: [uuid, 'last-input'] }),
    assistant(uuid),
  ];
  for (const message of messages) h.fake.emit(message);
  await tick();
  assert.deepEqual(
    h.events
      .filter(
        (e): e is Extract<AdapterEvent, { kind: string }> => e.type === 'native_event' || e.type === 'native_result'
      )
      .map((e) => e.payload),
    messages
  );
  assert.equal(h.fake.closes, 0);
  assert.equal(h.session.snapshot().nativeRef?.harness, 'claude');
});

test('Claude: native error, interrupted, deferred and background results do not become HUD completion or closure', async (t) => {
  const cases = [
    success(undefined, { is_error: true }),
    failure('input'),
    ...(['aborted_streaming', 'aborted_tools', 'tool_deferred', 'background_requested', 'hook_stopped'] as const).map(
      (terminal_reason) => success(undefined, { terminal_reason })
    ),
  ];
  const h = await setup(t);
  for (const message of cases) h.fake.emit(message);
  await tick();
  assert.deepEqual(
    h.results().map((event) => event.payload),
    cases
  );
  assert.equal(h.fake.closes, 0);
  assert.equal(
    h.events.some((event) => event.type === 'disconnected'),
    false
  );
  await h.send('still-usable');
});

test('Claude: resume retains native ID; only explicit forkSession requests a new ID', async (t) => {
  for (const kind of ['resume', 'fork'] as const)
    await t.test(kind, async (t) => {
      const h = await setup(t, { origin: { kind, source: { harness: 'claude', sessionId: SESSION } } });
      assert.equal(h.fake.options.resume, SESSION);
      assert.equal(h.fake.options.forkSession, kind === 'fork' ? true : undefined);
      assert.equal(h.fake.options.continue, undefined);
      h.fake.emit(init(kind === 'resume' ? SESSION : OTHER));
      await tick();
      assert.deepEqual(h.session.snapshot().nativeRef, {
        harness: 'claude',
        sessionId: kind === 'resume' ? SESSION : OTHER,
      });
    });
  for (const kind of ['resume', 'fork'] as const)
    await t.test(`${kind} wrong binding`, async (t) => {
      const h = await setup(t, { origin: { kind, source: { harness: 'claude', sessionId: SESSION } } });
      h.fake.emit(init(kind === 'resume' ? OTHER : SESSION));
      await tick();
      assert.equal(h.session.snapshot().nativeRef, null);
      await assert.rejects(h.send(), { code: 'claude_session_unavailable' });
      assert.equal(h.fake.closes, 0); // Invalid identity is not permission to shut down native work.
      assert.equal(h.fake.iteratorReturns, 0);
    });
});

test('Claude: installed executable is selected from PATH, not bundled SDK or a version whitelist', async (t) => {
  const bin = join(workspace, 'bin');
  mkdirSync(bin);
  const executable = join(bin, 'claude');
  writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  chmodSync(executable, 0o700);
  const h = await setup(t, {
    sdkOptions: { env: { PATH: bin, HOME: workspace }, pathToClaudeCodeExecutable: undefined },
  });
  assert.equal(h.fake.options.pathToClaudeCodeExecutable, executable);
  h.fake.emit({ ...init(), claude_code_version: '999.future' });
  await tick();
  assert.equal(
    h.events.some((e) => e.type === 'disconnected'),
    false
  );
  let called = false;
  const missing = new ClaudeSdkAdapterFactory({
    sdkOptions: { env: { PATH: '/synthetic/missing' } },
    queryFactory: () => {
      called = true;
      throw Error('must not run');
    },
  });
  await assert.rejects(
    missing.create(
      { workspace, origin: { kind: 'new' } },
      {
        event() {},
        request: async () => ({ result: {} }),
      }
    ),
    { code: 'claude_executable_unavailable', certainty: 'not_sent' }
  );
  assert.equal(called, false);
});

test('Claude: input and source validation cannot override the configured executable or native permissions', async (t) => {
  const callbacks: AdapterCallbacks = { event() {}, request: async () => ({ result: {} }) };
  const adapter = new ClaudeSdkAdapterFactory();
  await assert.rejects(adapter.create({ workspace: 'relative', origin: { kind: 'new' } }, callbacks), {
    code: 'claude_invalid_workspace',
  });
  await assert.rejects(
    adapter.create({ workspace, origin: { kind: 'resume', source: { harness: 'pi', sessionId: SESSION } } }, callbacks),
    { code: 'claude_invalid_source' }
  );
  await assert.rejects(
    adapter.create({ workspace, origin: { kind: 'new' }, options: { permissionMode: 'bypassPermissions' } }, callbacks),
    { code: 'claude_unsupported_create_options' }
  );
  const h = await setup(t);
  await assert.rejects(h.session.send({ callId: 'x', text: 'x', options: { cwd: '/other' } }), {
    code: 'claude_unsupported_send_options',
  });
  await assert.rejects(h.session.send({ callId: '', text: 'x' }), { code: 'claude_invalid_input' });
});

test('Claude: interrupt returns native ACK without withdrawing callbacks or closing the Query', async (t) => {
  const answer = deferred<NativeResponse>();
  const h = await setup(t, { request: () => answer.promise });
  const uuid = await h.send();
  h.fake.queued = [uuid];
  const pending = h.fake.permission();
  await tick();
  await assert.rejects(h.session.cancel({ nativeTurnId: 'invented' }), { code: 'claude_turn_interrupt_unsupported' });
  assert.deepEqual(await h.session.cancel({}), { still_queued: [uuid] });
  assert.equal(h.requests[0].signal?.aborted, false);
  assert.equal(h.results().length, 0);
  assert.equal(h.fake.closes, 0);
  const result = { behavior: 'allow' };
  answer.resolve({ result });
  assert.equal(await pending, result);
  h.fake.failInterrupt = true;
  await assert.rejects(h.session.cancel({}), { code: 'claude_interrupt_unconfirmed', certainty: 'uncertain' });
});

test('Claude: permission requests preserve native IDs, rich payloads and exact native responses', async (t) => {
  const answer = deferred<NativeResponse>();
  const h = await setup(t, { request: () => answer.promise });
  await h.send();
  const input = { command: 'printf original' };
  const options: Partial<Parameters<CanUseTool>[2]> = {
    suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    blockedPath: '/synthetic/path',
    mcpServer: { name: 'synthetic-server', source: 'sdk' },
    decisionReason: 'Synthetic native reason',
    title: 'Native prompt title',
    displayName: 'Native action',
    description: 'Native description',
    defaultToNo: true,
    suppressAlwaysAllowRule: false,
    agentID: 'synthetic-agent',
    matchedAskRule: { source: 'user', toolName: 'Bash', ruleContent: 'printf:*' },
  };
  const pending = h.fake.permission('Bash', input, options);
  await tick();
  assert.equal(h.requests[0].requestId, 'synthetic-request');
  assert.equal(h.requests[0].kind, 'claude_tool_permission');
  assert.equal(Object.hasOwn(h.requests[0], 'callId'), false); // SDK callback has no input UUID.
  assert.deepEqual(h.requests[0].payload, {
    toolName: 'Bash',
    input: { command: 'printf original' },
    options: { toolUseID: 'synthetic-tool', requestId: 'synthetic-request', ...options },
  });
  input.command = 'changed';
  assert.equal((h.requests[0].payload as { input: typeof input }).input.command, 'printf original');
  const result: PermissionResult = {
    behavior: 'allow',
    updatedInput: { command: 'printf revised' },
    updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    toolUseID: 'synthetic-tool',
    decisionClassification: 'user_permanent',
  };
  answer.resolve({ result });
  assert.equal(await pending, result);
});

test('Claude: denial, AskUserQuestion, large payloads and callback failures are not rewritten', async (t) => {
  const result: PermissionResult = {
    behavior: 'deny',
    message: 'Native response',
    interrupt: true,
    toolUseID: 'synthetic-tool',
    decisionClassification: 'user_reject',
  };
  const h = await setup(t, { request: async () => ({ result }) });
  assert.equal(
    await h.fake.permission('AskUserQuestion', { questions: [{ question: 'Question', options: ['A', 'B'] }] }),
    result
  );
  assert.equal(await h.fake.permission('Bash', { command: 'x'.repeat(9000) }), result);
  const error = new Error('Native relay failure');
  const failed = await setup(t, {
    request: async () => {
      throw error;
    },
  });
  await assert.rejects(failed.fake.permission(), (caught: unknown) => caught === error);
  const malformed = await setup(t, { request: async () => null as unknown as NativeResponse });
  await assert.rejects(malformed.fake.permission(), TypeError);
});

test('Claude: form/URL elicitation and unknown dialog kinds retain native public fields', async (t) => {
  const result = { action: 'accept' as const, content: { answer: 'synthetic' } };
  const h = await setup(t, { request: async () => ({ result }) });
  for (const mode of ['form', 'url'] as const) {
    const request = {
      serverName: 'synthetic',
      message: 'Question',
      mode,
      ...(mode === 'form'
        ? { requestedSchema: { type: 'object', properties: {} } }
        : { url: 'https://synthetic.invalid/question', elicitationId: 'native-elicitation' }),
      title: 'Native title',
      displayName: 'Native name',
      description: 'Native description',
    };
    assert.equal(
      await h.fake.options.onElicitation!(request, { signal: new AbortController().signal, requestId: mode }),
      result
    );
    assert.deepEqual(h.requests.at(-1)?.payload, { request, options: { requestId: mode } });
  }
  const dialog = { dialogKind: 'future-dialog', payload: { question: 'Question' }, toolUseID: 'native-tool' };
  assert.equal(
    await h.fake.options.onUserDialog!(dialog, { signal: new AbortController().signal, requestId: 'dialog' }),
    result
  );
  assert.equal(h.requests.at(-1)?.requestId, 'dialog');
  assert.deepEqual(h.requests.at(-1)?.payload, { request: dialog, options: { requestId: 'dialog' } });
});

test('Claude: callbacks survive result/background frames until native withdrawal or explicit close', async (t) => {
  const answer = deferred<NativeResponse>();
  const h = await setup(t, { request: () => answer.promise });
  const uuid = await h.send();
  const abort = new AbortController();
  const pending = h.fake.permission('Bash', {}, { signal: abort.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await tick();
  h.fake.emit(success(uuid, { terminal_reason: 'background_requested' }));
  await tick();
  assert.equal(h.requests[0].signal?.aborted, false);
  await h.send('next');
  abort.abort();
  await rejected;
  assert.equal(h.requests[0].signal?.aborted, true);
  answer.resolve({ result: { behavior: 'allow' } });
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(h.fake.permission('Bash', {}, { signal: preAborted.signal }), { name: 'AbortError' });
  assert.equal(h.requests.length, 1);
});

test('Claude: equal native request IDs in separate sessions cannot cross-deliver replies', async (t) => {
  const answerA = deferred<NativeResponse>(),
    answerB = deferred<NativeResponse>();
  const a = await setup(t, { request: () => answerA.promise });
  const b = await setup(t, { request: () => answerB.promise });
  const pendingA = a.fake.permission();
  const rejected = assert.rejects(pendingA, { name: 'AbortError' });
  const pendingB = b.fake.permission();
  await tick();
  await a.session.close();
  await rejected;
  assert.equal(b.requests[0].signal?.aborted, false);
  assert.equal(b.fake.closes, 0);
  answerA.resolve({ result: { behavior: 'allow' } });
  const result = { behavior: 'deny', message: 'Only B' };
  answerB.resolve({ result });
  assert.equal(await pendingB, result);
});

test('Claude: explicit close uses the public API, does not interrupt, and reports no claim of stopped work', async (t) => {
  const h = await setup(t);
  const pending = h.fake.permission();
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await tick();
  assert.deepEqual(await h.session.close(), { connectionReleased: true, workStopped: 'unknown' });
  await rejected;
  await h.session.close();
  assert.equal(h.fake.closes, 1);
  assert.equal(h.fake.interrupts, 0);
  await assert.rejects(h.send(), { code: 'claude_session_unavailable' });
});

test('Claude: close errors propagate; only an explicit retry calls close again', async (t) => {
  const h = await setup(t);
  h.fake.failClose = true;
  await assert.rejects(h.session.close(), /synthetic close failure/);
  h.fake.failClose = false;
  await h.session.close();
  assert.equal(h.fake.closes, 2);
});

test('Claude: EOF and read errors report connection facts, never implicit close or a process exit', async (t) => {
  for (const failed of [false, true])
    await t.test(failed ? 'error' : 'EOF', async (t) => {
      const h = await setup(t);
      await h.send();
      h.fake.end(failed ? Error('synthetic read failure') : undefined);
      await tick();
      assert.equal(h.results().length, 0);
      assert.equal(h.fake.closes, 0);
      assert.equal(
        h.events.some((event) => event.type === 'process_exit'),
        false
      );
      assert.ok(h.events.some((event) => event.type === 'disconnected'));
      await assert.rejects(h.send('no-replay'), { code: 'claude_session_unavailable' });
    });
});

test('Claude: raw initialization/context/history reads are official calls scoped to this native session', async (t) => {
  const reads: unknown[] = [];
  const history = [{ uuid: 'native-entry', type: 'assistant', session_id: SESSION, message: { text: 'history' } }];
  const h = await setup(t, {
    getSessionMessages: async (...args) => {
      reads.push(args);
      return history as never;
    },
  });
  assert.equal(await h.session.read(), h.fake.initialization);
  assert.deepEqual(await h.session.read({ method: 'getContextUsage', detail: 'summary' }), {
    detail: 'summary',
    nativeUsage: 7,
  });
  await assert.rejects(h.session.read({ method: 'getSessionMessages' }), { code: 'claude_native_id_unavailable' });
  h.fake.emit(init());
  await tick();
  assert.equal(
    await h.session.read({
      method: 'getSessionMessages',
      offset: 2,
      limit: 3,
      includeSystemMessages: true,
      sessionId: OTHER,
      dir: '/other',
    }),
    history
  );
  assert.deepEqual(reads, [[SESSION, { dir: workspace, offset: 2, limit: 3, includeSystemMessages: true }]]);
  await assert.rejects(h.session.read({ method: 'getSessionMessages', offset: -1 }), {
    code: 'claude_invalid_read_options',
  });
  await assert.rejects(h.session.read({ method: 'invented' }), { code: 'claude_unsupported_read_method' });
  await h.session.close();
  assert.equal(await h.session.read({ method: 'getSessionMessages' }), history);
});

test('Claude: history read cannot silently use a different HOME from the configured native session', async (t) => {
  const h = await setup(t, {
    sdkOptions: { env: { HOME: '/synthetic-other-home' } },
    origin: { kind: 'resume', source: { harness: 'claude', sessionId: SESSION } },
  });
  await assert.rejects(h.session.read({ method: 'getSessionMessages' }), {
    code: 'claude_history_profile_unavailable',
  });
});

test('Claude: native permissions/settings/background configuration and nonidentity HUD preferences survive', async (t) => {
  const defaults = await setup(t);
  for (const key of ['permissionMode', 'allowDangerouslySkipPermissions', 'settingSources'])
    assert.equal(Object.hasOwn(defaults.fake.options, key), false);
  const env = {
    HOME: workspace,
    HUD_HOME: join(workspace, '.hud'),
    HUD_THEME: 'synthetic',
    HUD_MCP_PROFILE: 'parent-profile',
    HUD_CALLER_ID: 'parent-caller',
    HUD_CONTEXT_ID: 'parent-context',
    HUD_CONTEXT_GENERATION: 'parent-generation',
    HUD_CLAUDE_HOOK_CONFIG: '/synthetic/parent-hook',
    HUD_PI_EVIDENCE_FD: '3',
    HUD_OWNER_ID: 'parent',
    HUD_CLAIM: 'parent',
    HUD_RUN: 'parent',
    HUD_LINK: 'parent',
    HUD_CONTEXT: 'parent',
    HUD_PI_DELEGATION_FD: '3',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0',
    CLAUDE_CONFIG_DIR: join(workspace, '.claude'),
  };
  const h = await setup(t, {
    sdkOptions: { env, permissionMode: 'plan', settingSources: ['user', 'project', 'local'] },
  });
  assert.equal(h.fake.options.permissionMode, 'plan');
  assert.deepEqual(h.fake.options.settingSources, ['user', 'project', 'local']);
  assert.equal(h.fake.options.env?.HUD_HOME, env.HUD_HOME);
  assert.equal(h.fake.options.env?.HUD_THEME, 'synthetic');
  for (const key of [
    'HUD_CALLER_ID',
    'HUD_CONTEXT_ID',
    'HUD_CONTEXT_GENERATION',
    'HUD_MCP_PROFILE',
    'HUD_CLAUDE_HOOK_CONFIG',
    'HUD_PI_EVIDENCE_FD',
  ])
    assert.equal(h.fake.options.env?.[key], undefined);
  assert.equal(h.fake.options.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '0');
  assert.equal(h.fake.options.env?.CLAUDE_CONFIG_DIR, env.CLAUDE_CONFIG_DIR);
  for (const key of ['HUD_OWNER_ID', 'HUD_CLAIM', 'HUD_RUN', 'HUD_LINK', 'HUD_CONTEXT', 'HUD_PI_DELEGATION_FD'])
    assert.equal(h.fake.options.env?.[key], undefined);
  assert.equal(env.HUD_OWNER_ID, 'parent');
  h.fake.options.stderr?.('native stderr');
  assert.ok(
    h.events.some((e) => e.type === 'native_event' && e.kind === 'claude_stderr' && e.payload === 'native stderr')
  );
});

test('Claude: synchronous query failure is not_sent and never retried', async () => {
  let calls = 0;
  const adapter = new ClaudeSdkAdapterFactory({
    sdkOptions: { pathToClaudeCodeExecutable: process.execPath },
    queryFactory: () => {
      calls++;
      throw Error('create failure');
    },
  });
  await assert.rejects(
    adapter.create(
      { workspace, origin: { kind: 'new' } },
      {
        event() {},
        request: async () => ({ result: {} }),
      }
    ),
    (error: unknown) => error instanceof AdapterDispatchError && error.certainty === 'not_sent'
  );
  assert.equal(calls, 1);
});

test('Claude: a result received before awaiting send receipt retains the same native correlation', async (t) => {
  const h = await setup(t, { onInput: (message, fake) => fake.emit(success(message.uuid)) });
  const pending = h.session.send({ callId: 'fast-input', text: 'Synthetic input' });
  await tick();
  assert.equal(h.results().length, 1);
  const receipt = await pending;
  assert.equal(h.results()[0].callId, 'fast-input');
  assert.equal(h.results()[0].correlation?.userMessageUuid, receipt.correlation?.userMessageUuid);
});

test('Claude: an actually missing public read method is reported without version rejection', async (t) => {
  const h = await setup(t);
  Object.defineProperty(h.fake, 'initializationResult', { value: undefined });
  Object.defineProperty(h.fake, 'getContextUsage', { value: undefined });
  await assert.rejects(h.session.read(), { code: 'claude_initialization_read_unavailable' });
  await assert.rejects(h.session.read({ method: 'getContextUsage' }), { code: 'claude_context_read_unavailable' });
  await h.send();
  assert.equal(h.fake.closes, 0);
});

test('Claude: Query declares supported official dialogs so the native callback can actually be delivered', async (t) => {
  const result = { behavior: 'cancelled' as const };
  const h = await setup(t, { request: async () => ({ result }) });
  assert.deepEqual(h.fake.options.supportedDialogKinds, ['refusal_fallback_prompt']);
  assert.equal(typeof h.fake.options.onUserDialog, 'function');
  const request = { dialogKind: 'refusal_fallback_prompt', payload: { synthetic: 'native fields' } };
  assert.equal(await h.fake.dialog(request), result);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].payload, { request, options: { requestId: 'native-dialog' } });
  assert.equal(h.fake.dialog({ dialogKind: 'undeclared_future_kind', payload: {} }), undefined);
  assert.equal(h.requests.length, 1);
});

test('Claude: trusted dialog capability declarations pass to Query unchanged including explicit opt-out', async (t) => {
  for (const supportedDialogKinds of [[], ['refusal_fallback_prompt', 'explicit-host-kind']]) {
    const result = { behavior: 'completed' as const, result: { nativeChoice: 'synthetic' } };
    const h = await setup(t, { sdkOptions: { supportedDialogKinds }, request: async () => ({ result }) });
    assert.deepEqual(h.fake.options.supportedDialogKinds, supportedDialogKinds);
    const delivered = h.fake.dialog({ dialogKind: 'explicit-host-kind', payload: {} });
    if (supportedDialogKinds.length) {
      assert.equal(await delivered, result);
      assert.equal(h.requests.length, 1);
    } else {
      assert.equal(delivered, undefined);
      assert.equal(h.requests.length, 0);
      assert.equal(h.fake.dialog({ dialogKind: 'refusal_fallback_prompt', payload: {} }), undefined);
    }
    assert.equal(Object.hasOwn(h.fake.options, 'permissionMode'), false);
    assert.equal(Object.hasOwn(h.fake.options, 'allowDangerouslySkipPermissions'), false);
  }
});
