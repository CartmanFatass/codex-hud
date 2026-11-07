import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WakeAdapters, type WakeMessageDetails } from '../../src/core/wake/adapters.js';
import type { WakeRegistration } from '../../src/ledger/notify-events.js';
import { wakeMessage } from '../../src/core/wake/message.js';
import hudWake, {
  piWakeSocketPath,
  validWakeRequest,
  deliverPiWake,
  type PiWakeAPI,
} from '../../src/harness/pi/wake-extension.js';
import { nativeWakeMessage, type NativeWakeDetails } from '../../src/managed/wake-message.js';

const details: WakeMessageDetails = {
  linkId: 'link-synthetic',
  runs: [{ runId: 'run-synthetic', kind: 'report.received', seq: 3 }],
  throughSeq: 3,
  contextGeneration: 1,
};
const content = wakeMessage(details);
function registration(
  adapter: 'codex_queue_v1' | 'pi_extension_v1',
  target: WakeRegistration['target']
): WakeRegistration {
  return {
    adapter,
    adapterVersion: 1,
    ownerKey: 'owner-synthetic',
    contextGeneration: 1,
    parentRef: {
      harness: adapter === 'codex_queue_v1' ? 'codex' : 'pi',
      sourceId: 'synthetic',
      sessionId: 'session-synthetic',
      threadId: adapter === 'codex_queue_v1' ? 'thread-synthetic' : null,
    },
    parentStamp: null,
    target,
  };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'b19-adapter-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}
async function fakeCodex(root: string, source: string): Promise<string> {
  const executable = join(root, 'codex.cjs');
  await writeFile(executable, `#!${process.execPath}\n${source}\n`);
  await chmod(executable, 0o700);
  return executable;
}
async function untilFile(path: string): Promise<string> {
  for (let i = 0; i < 150; i++) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      await delay(10);
    }
  }
  throw new Error('fixture did not start');
}
function gone(pid: number): void {
  assert.throws(
    () => process.kill(pid, 0),
    (error: NodeJS.ErrnoException) => error.code === 'ESRCH'
  );
}
async function endpoint(path: string, handle: (client: Socket, data: Buffer) => void): Promise<() => Promise<void>> {
  const clients = new Set<Socket>();
  const server = createServer((client) => {
    clients.add(client);
    client.on('error', () => {});
    client.on('data', (data) => handle(client, data));
    client.once('close', () => clients.delete(client));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return async () => {
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}

test('B19 Codex direct executable, verified CODEX_HOME and queue-only arguments', async () => {
  const f = await fixture();
  try {
    const log = join(f.root, 'args.json');
    const executable = await fakeCodex(
      f.root,
      `require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME,pid:process.pid}));`
    );
    const adapter = new WakeAdapters({ codexExecutable: executable });
    assert.deepEqual(
      await adapter.send(
        registration('codex_queue_v1', { codexHome: f.root, threadId: 'thread-synthetic' }),
        content,
        details
      ),
      { result: 'accepted' }
    );
    const observed = JSON.parse(await readFile(log, 'utf8'));
    assert.deepEqual(observed.args, ['queue', '--thread', 'thread-synthetic', '--message', content]);
    assert.equal(observed.home, f.root);
    gone(observed.pid);
    await adapter.close();
    assert.equal((await adapter.send(registration('codex_queue_v1', {}), content, details)).reason, 'aborted');
  } finally {
    await f.cleanup();
  }
});

test('B19 slow Codex is SIGKILLed at the 2 s deadline and reaped, no zombie', { timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    const log = join(f.root, 'pid');
    const executable = await fakeCodex(
      f.root,
      `require('node:fs').writeFileSync(${JSON.stringify(log)}, String(process.pid)); process.on('SIGTERM',()=>{}); setTimeout(()=>{},10000);`
    );
    const adapter = new WakeAdapters({ codexExecutable: executable });
    const start = performance.now();
    const result = await adapter.send(
      registration('codex_queue_v1', { codexHome: f.root, threadId: 'thread-synthetic' }),
      content,
      details
    );
    assert.deepEqual(result, { result: 'unknown', reason: 'timeout' });
    assert.ok(performance.now() - start < 2400);
    gone(Number(await readFile(log, 'utf8')));
    await adapter.close();
  } finally {
    await f.cleanup();
  }
});

test('B19 Codex output cap counts stdout and stderr together; no child remains', async () => {
  const f = await fixture();
  try {
    const log = join(f.root, 'pid');
    const executable = await fakeCodex(
      f.root,
      `require('node:fs').writeFileSync(${JSON.stringify(log)},String(process.pid)); process.stdout.write('a'.repeat(2048)); process.stderr.write('b'.repeat(2049)); setTimeout(()=>{},10000);`
    );
    const adapter = new WakeAdapters({ codexExecutable: executable });
    assert.deepEqual(
      await adapter.send(
        registration('codex_queue_v1', { codexHome: f.root, threadId: 'thread-synthetic' }),
        content,
        details
      ),
      { result: 'unknown', reason: 'output_limit' }
    );
    gone(Number(await readFile(log, 'utf8')));
    await adapter.close();
  } finally {
    await f.cleanup();
  }
});

test('B19 close and AbortSignal each kill/reap the active child; overlapping sends create no second helper', async () => {
  const f = await fixture();
  try {
    const log = join(f.root, 'pid');
    const executable = await fakeCodex(
      f.root,
      `require('node:fs').writeFileSync(${JSON.stringify(log)},String(process.pid)); setTimeout(()=>{},10000);`
    );
    const reg = registration('codex_queue_v1', { codexHome: f.root, threadId: 'thread-synthetic' });
    for (const useClose of [false, true]) {
      await rm(log, { force: true });
      const adapter = new WakeAdapters({ codexExecutable: executable });
      const controller = new AbortController();
      const running = adapter.send(reg, content, details, controller.signal);
      const pid = Number(await untilFile(log));
      assert.deepEqual(await adapter.send(reg, content, details), { result: 'unknown', reason: 'busy' });
      if (useClose) await adapter.close();
      else controller.abort();
      assert.deepEqual(await running, { result: 'unknown', reason: 'aborted' });
      gone(pid);
      await adapter.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('B19 Codex refusals, unavailable executable and unsafe payload are rejected', async () => {
  const f = await fixture();
  try {
    for (const reason of ['guard', 'archived']) {
      const executable = await fakeCodex(f.root, `process.stderr.write('${reason}'); process.exitCode=1;`);
      const adapter = new WakeAdapters({ codexExecutable: executable });
      assert.deepEqual(
        await adapter.send(
          registration('codex_queue_v1', { codexHome: f.root, threadId: 'thread-synthetic' }),
          content,
          details
        ),
        { result: 'rejected', reason }
      );
      await adapter.close();
    }
    const adapter = new WakeAdapters({ codexExecutable: join(f.root, 'missing') });
    const reg = registration('codex_queue_v1', { codexHome: f.root, threadId: 'thread-synthetic' });
    assert.equal((await adapter.send(reg, content, details)).reason, 'unavailable');
    assert.equal((await adapter.send(reg, 'é'.repeat(257), details)).reason, 'invalid_message');
    assert.equal((await adapter.send(reg, 'line\nbreak', details)).reason, 'invalid_message');
    await adapter.close();
  } finally {
    await f.cleanup();
  }
});

test('B19 pi sends the exact bounded protocol and preserves accepted/stale replies', async () => {
  const f = await fixture();
  try {
    for (const reply of [{ result: 'accepted' }, { result: 'rejected', reason: 'stale_session' }]) {
      const path = join(f.root, `pi-${reply.result}.sock`);
      const stop = await endpoint(path, (client, data) => {
        assert.deepEqual(JSON.parse(data.toString()), {
          parentSessionId: 'session-synthetic',
          content,
          details,
          command: 'read the ledger',
        });
        client.end(JSON.stringify(reply) + '\n');
      });
      const adapter = new WakeAdapters();
      try {
        assert.deepEqual(
          await adapter.send(registration('pi_extension_v1', { socketPath: path }), content, details),
          reply
        );
      } finally {
        await adapter.close();
        await stop();
      }
    }
  } finally {
    await f.cleanup();
  }
});

test('B19 pi absent endpoint, timeout, oversized/invalid replies and abort are bounded', async () => {
  const f = await fixture();
  try {
    const adapter = new WakeAdapters({ timeoutMs: 80 });
    assert.deepEqual(
      await adapter.send(
        registration('pi_extension_v1', { socketPath: join(f.root, 'absent.sock') }),
        content,
        details
      ),
      { result: 'rejected', reason: 'no_endpoint' }
    );
    for (const mode of ['timeout', 'oversized', 'invalid', 'abort']) {
      const path = join(f.root, `${mode}.sock`);
      const controller = new AbortController();
      const stop = await endpoint(path, (client) => {
        if (mode === 'oversized') client.write('x'.repeat(4097));
        if (mode === 'invalid') client.end('{"result":"accepted","unexpected":true}\n');
        if (mode === 'abort') controller.abort();
      });
      try {
        const result = await adapter.send(
          registration('pi_extension_v1', { socketPath: path }),
          content,
          details,
          controller.signal
        );
        assert.equal(result.result, 'unknown');
        assert.equal(
          result.reason,
          (
            { timeout: 'timeout', oversized: 'output_limit', invalid: 'invalid_response', abort: 'aborted' } as Record<
              string,
              string
            >
          )[mode]
        );
      } finally {
        await stop();
      }
    }
    await adapter.close();
  } finally {
    await f.cleanup();
  }
});

function exchange(path: string, message: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let output = '';
    socket.once('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify(message) + '\n'));
    socket.on('data', (chunk) => (output += chunk));
    socket.once('end', () => {
      try {
        resolve(JSON.parse(output));
      } catch (error) {
        reject(error);
      }
    });
  });
}

// The current extension receives native pointers, not the historical WakeAdapters ledger payload.
function nativeRequest(parentSessionId: string) {
  const details: NativeWakeDetails = {
    connectionId: 'connection-synthetic',
    nativeRef: { harness: 'claude', sessionId: 'native-child-synthetic' },
    eventSeq: 3,
    kind: 'request',
    requestId: 'request-synthetic',
  };
  return { parentSessionId, content: nativeWakeMessage(details), details, command: 'read native session' as const };
}
function invalidNativeRequests(request: ReturnType<typeof nativeRequest>): unknown[] {
  return [
    { ...request, command: 'execute this' },
    { ...request, content: 'arbitrary instructions' },
    { ...request, unexpected: 'field' },
    { ...request, content: 'é'.repeat(257) },
    { ...request, content: 'a\nb' },
    { ...request, details: { ...request.details, unexpected: true } },
    { ...request, details: { ...request.details, eventSeq: 0 } },
    { ...request, details: { ...request.details, requestId: undefined } },
    { ...request, content, details, command: 'read the ledger' },
  ];
}

test('B19 pi extension native validator and delivery boundary execute without a socket', () => {
  const sent: { message: unknown; options: unknown }[] = [];
  const api: PiWakeAPI = {
    on() {},
    sendMessage(message, options) {
      sent.push({ message, options });
    },
  };
  let sessionId = 'session-synthetic';
  const ctx = { sessionManager: { getSessionId: () => sessionId } };
  const request = nativeRequest(sessionId);
  assert.equal(validWakeRequest(request), true);
  for (const invalid of invalidNativeRequests(request)) assert.equal(validWakeRequest(invalid), false);
  assert.deepEqual(deliverPiWake(api, request, sessionId, ctx), { result: 'accepted' });
  assert.deepEqual(sent[0], {
    message: { customType: 'hud_wake', content: request.content, display: true, details: request.details },
    options: { triggerTurn: true, deliverAs: 'followUp' },
  });
  sessionId = 'replacement-synthetic';
  assert.deepEqual(deliverPiWake(api, request, 'session-synthetic', ctx), {
    result: 'rejected',
    reason: 'stale_session',
  });
  assert.deepEqual(deliverPiWake(api, { ...request, parentSessionId: sessionId }, 'session-synthetic', ctx), {
    result: 'rejected',
    reason: 'stale_session',
  });
  assert.equal(sent.length, 1, 'stale wakes must never trigger a turn');
  assert.deepEqual(deliverPiWake(api, { ...request, parentSessionId: sessionId }, sessionId, ctx), {
    result: 'accepted',
  });
});

function skipDeniedSocketListen(error: unknown, skip: () => void): void {
  const failure = error as NodeJS.ErrnoException | null;
  if (failure?.code !== 'EPERM' || failure.syscall !== 'listen') throw error;
  skip();
}

test('B19 pi extension skips only listen EPERM, never procfs or other startup failures', () => {
  let skips = 0;
  const skip = () => {
    skips++;
  };
  skipDeniedSocketListen(Object.assign(new Error('socket denied'), { code: 'EPERM', syscall: 'listen' }), skip);
  assert.equal(skips, 1);
  for (const fields of [
    { code: 'EPERM', syscall: 'open', path: '/proc/123/stat' },
    { code: 'EPERM', syscall: 'read' },
    { code: 'EPERM' },
    { code: 'EACCES', syscall: 'listen' },
  ]) {
    const failure = Object.assign(new Error('startup failed'), fields);
    assert.throws(
      () => skipDeniedSocketListen(failure, skip),
      (error) => error === failure
    );
  }
  assert.equal(skips, 1, 'non-listen failures must propagate without marking the test skipped');
});

test('B19 pi extension native session lifecycle, exact allowlist, fresh stale fence, private socket', async (t) => {
  const f = await fixture();
  const oldHome = process.env.HUD_HOME;
  process.env.HUD_HOME = f.root;
  const handlers = new Map<
    string,
    (event: unknown, ctx: { sessionManager: { getSessionId(): string } }) => void | Promise<void>
  >();
  const sent: { message: unknown; options: unknown }[] = [];
  const api: PiWakeAPI = {
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    sendMessage: (message, options) => {
      sent.push({ message, options });
    },
  };
  let sessionId = 'session-synthetic';
  const ctx = { sessionManager: { getSessionId: () => sessionId } };
  hudWake(api);
  try {
    try {
      await handlers.get('session_start')!({}, ctx);
    } catch (error) {
      skipDeniedSocketListen(error, () =>
        t.skip('Unix socket listen is prohibited by this sandbox (EPERM); native validator/delivery tested separately')
      );
      return;
    }
    const path = await piWakeSocketPath(f.root);
    assert.match(path, /pi-\d+-\d+\.sock$/);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.equal((await lstat(join(f.root, 'wake'))).mode & 0o777, 0o700);
    const request = nativeRequest(sessionId);
    assert.deepEqual(await exchange(path, request), { result: 'accepted' });
    assert.deepEqual(sent[0], {
      message: { customType: 'hud_wake', content: request.content, display: true, details: request.details },
      options: { triggerTurn: true, deliverAs: 'followUp' },
    });
    for (const invalid of invalidNativeRequests(request))
      assert.deepEqual(await exchange(path, invalid), { result: 'rejected', reason: 'invalid_request' });
    sessionId = 'replacement-synthetic';
    assert.deepEqual(await exchange(path, { ...request, content: 'x'.repeat(65536) }), {
      result: 'rejected',
      reason: 'request_too_large',
    });
    assert.deepEqual(await exchange(path, request), { result: 'rejected', reason: 'stale_session' });
    assert.deepEqual(await exchange(path, { ...request, parentSessionId: sessionId }), {
      result: 'rejected',
      reason: 'stale_session',
    });
    assert.equal(sent.length, 1, 'stale/invalid wakes must never trigger a turn');
    await handlers.get('session_shutdown')!({}, ctx);
    await assert.rejects(lstat(path), { code: 'ENOENT' });
    await handlers.get('session_start')!({}, ctx);
    assert.deepEqual(await exchange(path, { ...request, parentSessionId: sessionId }), { result: 'accepted' });
  } finally {
    await handlers.get('session_shutdown')!({}, ctx);
    if (oldHome === undefined) delete process.env.HUD_HOME;
    else process.env.HUD_HOME = oldHome;
    await f.cleanup();
  }
});
