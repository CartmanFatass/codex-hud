import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { JEV_TOOLS, JevTools } from '../../packages/hud-mcp/src/jev-tools.js';
import { HudMcpServer } from '../../packages/hud-mcp/src/server.js';
import { validateToolArguments } from '../../packages/hud-mcp/src/tools.js';
import type { CallResolution } from '../../packages/hud-mcp/src/resolvers.js';
import {
  createJevHost,
  JevBridgeError,
  PythonJevBridge,
  readJevRelations,
  type JevBridge,
} from '../../src/managed/jev-host.js';
import { NativeSessionHost } from '../../src/managed/host.js';
import { NativeHostClient, serveNativeHost } from '../../src/managed/host-ipc.js';
import { RelationStore, type NativeOwner } from '../../src/managed/relations.js';

const owner: NativeOwner = { harness: 'codex', sourceId: 'synthetic-source', sessionId: 'parent-a', threadId: null };
const other: NativeOwner = { ...owner, sessionId: 'parent-b' };
const source = (sessionRef = owner): Extract<CallResolution, { ok: true }> => ({
  ok: true,
  callId: 'native-call',
  sessionRef,
  processKey: 'same-process',
  evidenceDigest: 'synthetic',
});
const temporary = (t: { after(fn: () => void): void }) => {
  const directory = mkdtempSync(join(tmpdir(), 'hud-jev-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
function fakeBridge() {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  let released = false;
  const bridge: JevBridge = {
    async invoke(method, args) {
      calls.push({ method, args });
      if (method === 'create') return { targetId: 'actual-target', sessionId: 'actual-cdp-session' };
      if (method === 'snapshot' || method === 'run')
        return { status: 'blocked', page: { captcha: true }, futureField: [null, true] };
      if (method === 'command') throw new JevBridgeError({ type: 'ValueError', message: 'native command error' });
      return null;
    },
    release() {
      released = true;
    },
  };
  return { bridge, calls, released: () => released };
}

test('Jev schemas accept actual API parameters and reject forged ownership', () => {
  const create = JEV_TOOLS.find((tool) => tool.name === 'jev_create')!;
  assert.equal(
    validateToolArguments(create, {
      url: 'https://example.test',
      goals: 'observe',
      record_dir: null,
      screenshots: true,
    }),
    true
  );
  assert.equal(validateToolArguments(create, { url: 'https://example.test', goals: ['first', 'second'] }), true);
  for (const goals of [true, {}, [], ['ok', 1]])
    assert.equal(validateToolArguments(create, { url: 'x', goals }), false);
  const command = JEV_TOOLS.find((tool) => tool.name === 'jev_command')!;
  assert.equal(
    validateToolArguments(command, {
      instanceId: 'x',
      name: 'act',
      body: { fingerprint: 'p', opaque: [null, { future: true }] },
    }),
    true
  );
  for (const tool of JEV_TOOLS) {
    assert.equal(validateToolArguments(tool, { owner, callId: 'forged' }), false);
    assert.equal((tool.inputSchema.properties as Record<string, unknown>).harness, undefined);
  }
});

test('MCP resolves Jev source on every call and forwards raw values', async () => {
  const calls: unknown[] = [];
  let resolutions = 0;
  const extension = new JevTools({
    async invoke(owner, method, args) {
      calls.push({ owner, method, args });
      return ['native', null];
    },
  });
  const server = new HudMcpServer(
    {
      async resolve() {
        return source(++resolutions === 1 ? owner : other);
      },
    },
    undefined,
    undefined,
    undefined,
    extension
  );
  for (let id = 1; id <= 2; id++) {
    const reply = (await server.handle({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'jev_snapshot', arguments: { instanceId: 'instance' } },
    })) as any;
    assert.deepEqual(reply.result.structuredContent, { ok: true, value: ['native', null] });
  }
  assert.deepEqual(
    calls,
    [owner, other].map((owner) => ({
      owner,
      method: 'jev_snapshot',
      args: { instanceId: 'instance', callId: 'native-call' },
    }))
  );
});

test('missing native source cannot start Jev', async () => {
  let invoked = false;
  const server = new HudMcpServer(
    {
      async resolve() {
        return { ok: false, code: 'identity_source_missing' };
      },
    },
    undefined,
    undefined,
    undefined,
    new JevTools({
      async invoke() {
        invoked = true;
      },
    })
  );
  const reply = (await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'jev_create',
      arguments: { url: 'https://example.test', goals: 'observe' },
    },
  })) as any;
  assert.equal(invoked, false);
  assert.equal(reply.result.structuredContent.code, 'identity_source_missing');
});

test('creation/persistence errors do not release or close a possibly live Agent', async (t) => {
  const home = temporary(t);
  const fake = fakeBridge();
  const jev = createJevHost(home, owner, () => fake.bridge);
  // Test-only failure injection: remove the empty relation destination, not an Agent.
  rmSync(join(home, 'native-relations'), { recursive: true });
  const created = (await jev.invoke('jev_create', { callId: 'call', url: 'x', goals: 'g' })) as any;
  assert.match(created.relationWriteError, /ENOENT/);
  assert.equal(((await jev.invoke('jev_snapshot', created)) as any).status, 'blocked');
  assert.equal(fake.released(), false);
  assert.equal(
    fake.calls.some((call) => call.method === 'close'),
    false
  );
  await jev.invoke('jev_close', created);
  assert.equal(fake.released(), true);

  let closed = false;
  const failed = createJevHost(home, owner, () => ({
    async invoke(method) {
      if (method === 'create') throw new JevBridgeError({ type: 'AttributeError', message: 'native metadata error' });
      if (method === 'close') closed = true;
      return null;
    },
    release() {},
  }));
  const error = (await failed.invoke('jev_create', { callId: 'call-2' })) as any;
  assert.equal(error.ok, false);
  assert.equal(error.error.message, 'native metadata error');
  assert.equal(closed, false);
  assert.equal(((await failed.invoke('jev_list', {})) as any).instances[0].instanceId, error.instanceId);
  await failed.invoke('jev_close', { instanceId: error.instanceId });
  assert.equal(closed, true);
});

test('source-scoped host preserves blocked tabs/errors and only explicit close calls Agent.close', async (t) => {
  const home = temporary(t);
  const fake = fakeBridge();
  const jev = createJevHost(home, owner, () => fake.bridge);
  const host = new NativeSessionHost(owner, [], new RelationStore(home), { jev_: jev });
  const created = (await host.invoke(owner, 'jev_create', {
    callId: 'native-call',
    url: 'https://example.test',
    goals: 'observe',
  })) as any;
  assert.equal(created.targetId, 'actual-target');
  await assert.rejects(host.invoke(other, 'jev_snapshot', { instanceId: created.instanceId }), /owner_mismatch/);
  const signal = AbortSignal.abort();
  assert.deepEqual(await host.invoke(owner, 'jev_run', created, signal), {
    status: 'blocked',
    page: { captcha: true },
    futureField: [null, true],
  });
  assert.deepEqual(await host.invoke(owner, 'jev_command', { ...created, name: 'predict' }), {
    ok: false,
    code: 'jev_native_error',
    error: { type: 'ValueError', message: 'native command error' },
  });
  assert.equal(
    fake.calls.some((call) => call.method === 'close'),
    false
  );
  assert.equal(fake.released(), false);
  const relations = readJevRelations(home, owner);
  assert.equal(relations.length, 1);
  assert.equal(relations[0].callId, 'native-call');
  assert.equal(relations[0].sessionId, 'actual-cdp-session');
  assert.deepEqual(readJevRelations(home, other), []);
  assert.deepEqual(
    Object.keys(relations[0]).sort(),
    ['owner', 'callId', 'instanceId', 'targetId', 'sessionId', 'createdAt'].sort()
  );
  await host.invoke(owner, 'jev_close', created);
  assert.equal(fake.calls.filter((call) => call.method === 'close').length, 1);
  assert.equal(fake.released(), true);
  assert.equal(((await host.invoke(owner, 'jev_list', {})) as any).instances.length, 0);
  await assert.rejects(host.invoke(owner, 'jev_snapshot', created), /not_owned_or_not_live/);
  const restarted = createJevHost(home, owner, () => {
    throw new Error('must not restart Agent');
  });
  assert.equal(((await restarted.invoke('jev_list', {})) as any).relations.length, 1);
  await assert.rejects(restarted.invoke('jev_snapshot', created), /not_owned_or_not_live/);
});

test('Jev invocation continues when IPC observer disconnects', async (t) => {
  const home = temporary(t);
  let finishRun!: (value: unknown) => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let closed = false;
  const jev = createJevHost(home, owner, () => ({
    async invoke(method) {
      if (method === 'create') return { targetId: 't', sessionId: 's' };
      if (method === 'run') {
        started();
        return new Promise((resolve) => {
          finishRun = resolve;
        });
      }
      if (method === 'close') closed = true;
      return { status: 'blocked' };
    },
    release() {},
  }));
  const host = new NativeSessionHost(owner, [], new RelationStore(home), { jev_: jev });
  let server;
  try {
    server = await serveNativeHost(home, host);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    t.skip('Environment prohibits Unix socket listen (EPERM); IPC disconnect continuity NOT_RUN.');
    return;
  }
  t.after(() => server.close());
  const client = new NativeHostClient(home, false);
  const created = (await client.invoke(owner, 'jev_create', { callId: 'call', url: 'x', goals: 'g' })) as Record<
    string,
    unknown
  >;
  const controller = new AbortController();
  const observation = client.invoke(owner, 'jev_run', created, controller.signal);
  await running;
  controller.abort();
  await assert.rejects(observation, /observation_cancelled/);
  assert.equal(closed, false);
  finishRun([{ status: 'blocked' }]);
  assert.deepEqual(await client.invoke(owner, 'jev_snapshot', created), { status: 'blocked' });
  assert.equal(closed, false);
  await client.invoke(owner, 'jev_close', created);
  assert.equal(closed, true);
});

test('actual Python JSONL bridge calls synthetic Agent API and retains CAPTCHA/errors until explicit close', async (t) => {
  const home = temporary(t);
  const module = join(home, 'jev_ultrafast');
  mkdirSync(module);
  const callsPath = join(home, 'calls.jsonl');
  // Synthetic implementation of the pinned upstream API. No provider/browser is started.
  writeFileSync(
    join(module, '__init__.py'),
    `import json, os
def record(method, value=None):
    with open(os.environ['JEV_TEST_CALLS'], 'a') as f: f.write(json.dumps([method,value])+'\\n')
class Browser:
    target = 'fixture-owned-target'
    session = 'fixture-cdp-session'
class Agent:
    def __init__(self, url, goals, *, record_dir=None, screenshots=False):
        record('create', [url,goals,record_dir,screenshots])
        self.browser = Browser()
        self.status = 'ready'
        print('synthetic upstream diagnostic')
    def snapshot(self):
        record('snapshot')
        return {'status': self.status, 'page': {'text': 'CAPTCHA'}, 'newField': [None,False,7]}
    def run(self):
        record('run')
        yield {'status':'ready', 'step':1}
        self.status = 'blocked'
        yield self.snapshot()
    def command(self, name, body=None):
        record('command', [name,body])
        if name == 'error': raise ValueError('native failure')
        return {'name':name, 'body':body}
    def close(self):
        record('close')
`
  );
  const bridge = new PythonJevBridge({
    env: { ...process.env, HOME: home, HUD_HOME: home, PYTHONPATH: home, JEV_TEST_CALLS: callsPath },
  });
  t.after(() => bridge.release());
  assert.deepEqual(
    await bridge.invoke('create', {
      url: 'https://example.test',
      goals: ['a', 'b'],
      screenshots: true,
      record_dir: '/synthetic/recording',
    }),
    { targetId: 'fixture-owned-target', sessionId: 'fixture-cdp-session' }
  );
  const yielded = await bridge.invoke('run', {});
  assert.deepEqual(yielded, [
    { status: 'ready', step: 1 },
    { status: 'blocked', page: { text: 'CAPTCHA' }, newField: [null, false, 7] },
  ]);
  await assert.rejects(
    bridge.invoke('command', { name: 'error' }),
    (error: unknown) => error instanceof JevBridgeError && (error.nativeError as any).message === 'native failure'
  );
  assert.deepEqual(
    await bridge.invoke('command', { name: 'future-command', body: { fingerprint: 'p', future: [null, 2] } }),
    { name: 'future-command', body: { fingerprint: 'p', future: [null, 2] } }
  );
  assert.equal(((await bridge.invoke('snapshot', {})) as any).status, 'blocked');
  const calls = () =>
    readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  assert.deepEqual(calls()[0], ['create', ['https://example.test', ['a', 'b'], '/synthetic/recording', true]]);
  assert.equal(calls().filter((row) => row[0] === 'close').length, 0);
  assert.equal(await bridge.invoke('close', {}), null);
  assert.equal(calls().filter((row) => row[0] === 'close').length, 1);
});

test('bridge EOF does not call Agent.close', async (t) => {
  const home = temporary(t);
  writeFileSync(
    join(home, 'jev_ultrafast.py'),
    `class Browser:
    target = 'target'
    session = 'session'
class Agent:
    def __init__(self, *args, **kwargs): self.browser = Browser()
    def close(self): raise Exception('unexpected close')
`
  );
  const result = spawnSync('python3', ['-u', join(process.cwd(), 'src', 'managed', 'jev-bridge.py')], {
    env: { ...process.env, HOME: home, HUD_HOME: home, PYTHONPATH: home },
    input: JSON.stringify({ id: 1, method: 'create', args: { url: 'x', goals: 'g' } }) + '\n',
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { id: 1, ok: true, value: { targetId: 'target', sessionId: 'session' } });
});

test('relocated root/MCP builds find the explicitly packaged Python asset without source TS', async (t) => {
  const home = temporary(t);
  writeFileSync(join(home, 'package.json'), JSON.stringify({ type: 'module' }));
  mkdirSync(join(home, 'src', 'managed'), { recursive: true });
  copyFileSync(join(process.cwd(), 'src', 'managed', 'jev-bridge.py'), join(home, 'src', 'managed', 'jev-bridge.py'));
  writeFileSync(
    join(home, 'jev_ultrafast.py'),
    `class Browser:
    target = 'packaged-target'
    session = 'packaged-session'
class Agent:
    def __init__(self, *args, **kwargs): self.browser = Browser()
    def close(self): pass
`
  );
  for (const layout of ['dist/managed', 'packages/hud-mcp/dist/src/managed']) {
    const directory = join(home, layout);
    mkdirSync(directory, { recursive: true });
    for (const name of ['jev-host.js', 'relations.js'])
      copyFileSync(new URL(`../../src/managed/${name}`, import.meta.url), join(directory, name));
    const code = `import {PythonJevBridge} from ${JSON.stringify(pathToFileURL(join(directory, 'jev-host.js')).href)};
      const bridge = new PythonJevBridge();
      console.log(JSON.stringify(await bridge.invoke('create', {url:'x',goals:'g'})));
      await bridge.invoke('close',{}); bridge.release();`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: home,
      env: { ...process.env, HOME: home, HUD_HOME: home, PYTHONPATH: home },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { targetId: 'packaged-target', sessionId: 'packaged-session' });
  }
});

test('actual Python run yields are observable before completion while snapshot/command/close stay serial', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hud-jev-stream-'));
  const releasePath = join(home, 'release-run');
  const callsPath = join(home, 'calls.jsonl');
  writeFileSync(
    join(home, 'jev_ultrafast.py'),
    `import json, os, time
def record(method):
    with open(os.environ['JEV_TEST_CALLS'], 'a') as f: f.write(json.dumps(method)+'\\n')
class Browser:
    target = 'yield-target'
    session = 'yield-session'
class Agent:
    def __init__(self, *args, **kwargs):
        self.browser = Browser()
        self.history = []
        record('create')
    def run(self):
        record('run')
        yield {'status':'ready', 'history':self.history, 'futureField':[None,True]}
        while not os.path.exists(os.environ['JEV_TEST_RELEASE']): time.sleep(0.01)
        self.history.append('second-step')
        yield {'status':'blocked', 'history':self.history}
    def snapshot(self):
        record('snapshot')
        return {'status':'blocked', 'history':self.history}
    def command(self, name, body=None):
        record('command')
        return {'name':name, 'body':body}
    def close(self): record('close')
`
  );
  const bridge = new PythonJevBridge({
    env: {
      ...process.env,
      HOME: home,
      HUD_HOME: home,
      PYTHONPATH: home,
      JEV_TEST_CALLS: callsPath,
      JEV_TEST_RELEASE: releasePath,
    },
  });
  let runForCleanup: Promise<unknown> | undefined;
  t.after(async () => {
    writeFileSync(releasePath, 'release');
    await runForCleanup?.catch(() => {});
    bridge.release();
    rmSync(home, { recursive: true, force: true });
  });
  const host = createJevHost(home, owner, () => bridge);
  const created = (await host.invoke('jev_create', { callId: 'yield-call', url: 'x', goals: 'g' })) as Record<
    string,
    unknown
  >;
  let finished = false;
  const run = host.invoke('jev_run', created).then((value) => {
    finished = true;
    return value;
  });
  runForCleanup = run;
  const deadline = Date.now() + 5000;
  while (!bridge.observation() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(bridge.observation(), 'first real yield must arrive before run completes');
  assert.equal(finished, false);
  const list = (await host.invoke('jev_list', {})) as any;
  assert.equal(list.instances[0].apiExecution, 'serial');
  assert.deepEqual(list.instances[0].observation.value, { status: 'ready', history: [], futureField: [null, true] });
  const receivedAt = list.instances[0].observation.receivedAt;
  const snapshot = host.invoke('jev_snapshot', created);
  const command = host.invoke('jev_command', { ...created, name: 'native-command', body: { future: true } });
  const close = host.invoke('jev_close', created);
  assert.deepEqual(
    readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    ['create', 'run']
  );
  assert.equal(((await host.invoke('jev_list', {})) as any).instances[0].observation.receivedAt, receivedAt);
  writeFileSync(releasePath, 'release');
  assert.deepEqual(await run, [
    { status: 'ready', history: [], futureField: [null, true] },
    { status: 'blocked', history: ['second-step'] },
  ]);
  assert.deepEqual(await snapshot, { status: 'blocked', history: ['second-step'] });
  assert.deepEqual(await command, { name: 'native-command', body: { future: true } });
  await close;
  assert.deepEqual(
    readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    ['create', 'run', 'snapshot', 'command', 'close']
  );
});

for (const [label, expression, errorType] of [
  ['non-JSON', 'object()', 'TypeError'],
  ['NaN', "float('nan')", 'ValueError'],
  ['encoder recursion', 'Deep([1])', 'RecursionError'],
])
  test(`Jev ${label} yield encoding cannot stop or repeat the native generator`, async (t) => {
    const home = temporary(t);
    const callsPath = join(home, 'calls.jsonl');
    writeFileSync(
      join(home, 'jev_ultrafast.py'),
      `import json, os
class Deep(list):
    def __iter__(self): raise RecursionError('synthetic deeply nested snapshot')
def record(method):
    with open(os.environ['JEV_TEST_CALLS'], 'a') as f: f.write(json.dumps(method)+'\\n')
class Browser:
    target = 'encoding-target'
    session = 'encoding-session'
class Agent:
    def __init__(self, *args, **kwargs): self.browser = Browser()
    def run(self):
        record('run')
        yield ${expression}
        record('continued after unserializable yield')
        yield {'status':'blocked', 'page':'CAPTCHA'}
        record('generator exhausted')
    def close(self): record('close')
`
    );
    const bridge = new PythonJevBridge({
      env: { ...process.env, HOME: home, HUD_HOME: home, PYTHONPATH: home, JEV_TEST_CALLS: callsPath },
    });
    t.after(() => bridge.release());
    await bridge.invoke('create', { url: 'x', goals: 'g' });
    await assert.rejects(
      bridge.invoke('run', {}),
      (error: unknown) =>
        error instanceof JevBridgeError &&
        (error.nativeError as any).type === errorType &&
        (error.nativeError as any).origin === 'observation_encoding'
    );
    assert.deepEqual(bridge.observation()?.value, { status: 'blocked', page: 'CAPTCHA' });
    assert.deepEqual(
      readFileSync(callsPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      ['run', 'continued after unserializable yield', 'generator exhausted']
    );
    await bridge.invoke('close', {});
  });
