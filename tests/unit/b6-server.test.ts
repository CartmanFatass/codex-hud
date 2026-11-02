import test from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { HudMcpServer, serveStdio } from '../../packages/hud-mcp/src/server.js';
import { handshakeFixture } from './b45-handshake-fixture.js';
import { ReadControlService } from '../../packages/hud-mcp/src/read-control.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
const skip = ledgerRuntimeSupported() ? false : 'B6 requires Node 22.x >=22.13 or >=24';
async function setup(t: import('node:test').TestContext) {
  const f = await handshakeFixture();
  let subscriptions = 0,
    closed = 0;
  let armed!: () => void;
  const ready = new Promise<void>((r) => {
    armed = r;
  });
  const service = new ReadControlService(f.ledger, f.root, () => {
    subscriptions++;
    armed();
    return {
      unavailable: false,
      close() {
        closed++;
      },
    };
  });
  const server = new HudMcpServer(
    {
      resolve: async () => ({
        ok: true,
        sessionRef: f.parent.ref,
        processKey: f.parent.authority.evidence.processKey,
        evidenceDigest: 'synthetic',
        callId: 'synthetic',
      }),
    },
    {
      invoke: async (_source, tool, args, _started, signal) =>
        tool === 'delegate_wait'
          ? service.wait(
              args as any,
              () => f.parent.authority,
              { clientToolTimeoutMs: 180000, responseMarginMs: 1000, verified: true },
              signal
            )
          : service.status(args as any, () => f.parent.authority),
    }
  );
  t.after(async () => {
    server.shutdown();
    service.close();
    await f.close();
  });
  const cursor = f.ledger.snapshot((tx) => Number(tx.get('SELECT max(seq) AS n FROM events')!.n));
  const request = (id: number) => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'delegate_wait', arguments: { runId: 'run-a', afterSeq: cursor, until: [], timeoutMs: 120000 } },
  });
  return { f, service, server, ready, request, counts: () => ({ subscriptions, closed }) };
}

test(
  'B6 MCP request cancellation interrupts real SQLite wait under 2s and cleans subscription/timer',
  { skip },
  async (t) => {
    const s = await setup(t);
    const pending = s.server.handle(s.request(1));
    await s.ready;
    const start = performance.now();
    await s.server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
    const reply: any = await pending;
    assert.ok(performance.now() - start < 2000);
    assert.equal(reply.result.structuredContent.code, 'request_cancelled');
    assert.deepEqual(s.counts(), { subscriptions: 1, closed: 1 });
  }
);

test(
  'B6 concurrent stdio wait never blocks ping, cancellation notification, or EOF shutdown under 2s',
  { skip },
  async (t) => {
    const s = await setup(t);
    const input = new PassThrough(),
      output = new PassThrough();
    const replies: any[] = [];
    output.on('data', (data) => {
      for (const line of data.toString().trim().split('\n')) replies.push(JSON.parse(line));
    });
    const serving = serveStdio(s.server, input, output);
    input.write(JSON.stringify(s.request(2)) + '\n');
    await s.ready;
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) + '\n');
    await sleep(10);
    assert.ok(replies.some((r) => r.id === 3));
    const start = performance.now();
    input.end();
    await serving;
    assert.ok(performance.now() - start < 2000);
    assert.equal(replies.find((r) => r.id === 2)?.result.structuredContent.code, 'server_shutdown');
    assert.deepEqual(s.counts(), { subscriptions: 1, closed: 1 });
  }
);

test('B6 stable codes redact thrown filesystem/SQLite messages and normalize resolve failures', async () => {
  for (const [thrown, expected] of [
    [new Error('SQLITE /synthetic/private/file.db'), 'internal_error'],
    [Object.assign(new Error('sensitive lock details'), { code: 'ledger_busy' }), 'busy'],
    [new Error('unauthorized'), 'unauthorized'],
  ] as const) {
    for (const where of ['resolve', 'invoke']) {
      const server = new HudMcpServer(
        {
          resolve: async () => {
            if (where === 'resolve') throw thrown;
            return {
              ok: true,
              sessionRef: { harness: 'codex', sourceId: 'a'.repeat(64), sessionId: 'synthetic', threadId: null },
              processKey: 'synthetic',
              evidenceDigest: 'synthetic',
              callId: 'synthetic',
            };
          },
        },
        {
          invoke: async () => {
            throw thrown;
          },
        }
      );
      const r: any = await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'delegate_status', arguments: { runId: 'run-a' } },
      });
      assert.equal(r.result.structuredContent.code, expected);
      assert.equal(JSON.stringify(r).includes('/synthetic/private'), false);
    }
  }
});

for (const signal of ['SIGTERM', 'SIGHUP'] as const)
  test(
    `B6 real hud-mcp process ${signal} aborts 120s SQLite wait, closes handles and exits under 2s`,
    { skip },
    async (t) => {
      const { fork } = await import('node:child_process');
      const { resolve } = await import('node:path');
      const child = fork(resolve('tests/int/b6-server.mjs'), [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
      let stderr = '';
      child.stderr!.on('data', (data) => {
        stderr += data;
      });
      child.stdout!.resume();
      const exit = once(child, 'exit');
      let closed = false;
      child.on('message', (m: any) => {
        if (m.closed) closed = true;
      });
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exit;
      });
      await once(child, 'message');
      const armed = once(child, 'message');
      child.stdin!.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'delegate_wait',
            arguments: { runId: 'run-a', afterSeq: 999999, until: [], timeoutMs: 120000 },
          },
        }) + '\n'
      );
      await armed;
      const start = performance.now();
      child.kill(signal);
      const [code] = await exit;
      assert.equal(code, 0, stderr);
      assert.ok(performance.now() - start < 2000);
      assert.equal(closed, true);
    }
  );

test('B6 overloaded stdio closes and cancels waits despite output backpressure and unread EOF', { skip }, async (t) => {
  const s = await setup(t);
  const input = new PassThrough();
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, _callback) {
      /* deliberately blocked client */
    },
  });
  const serving = serveStdio(s.server, input, output);
  for (let id = 1; id <= 33; id++) input.write(JSON.stringify(s.request(id)) + '\n');
  input.end();
  const start = performance.now();
  await serving;
  assert.ok(performance.now() - start < 2000);
  assert.equal(s.server.shutdownSignal.aborted, true);
  assert.equal(s.counts().closed, s.counts().subscriptions);
  assert.equal(output.listenerCount('drain'), 0);
  assert.equal(output.listenerCount('error'), 0);
});

test('B6 parse-error response backpressure cannot block a later wait cancellation or EOF', { skip }, async (t) => {
  const s = await setup(t);
  const input = new PassThrough();
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) {} });
  const serving = serveStdio(s.server, input, output);
  input.write(JSON.stringify(s.request(1)) + '\n');
  await s.ready;
  input.write('invalid-json\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }) + '\n');
  input.end();
  const start = performance.now();
  await serving;
  assert.ok(performance.now() - start < 2000);
  assert.equal(s.counts().closed, 1);
  assert.equal(output.listenerCount('drain'), 0);
});

test('B6 real process SIGTERM closes a native blocked stdout write under 2s', { skip }, async (t) => {
  const { fork } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const child = fork(resolve('tests/int/b6-server.mjs'), [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr!.on('data', (x) => {
    stderr += x;
  });
  // stdout remains unread, so a 1 MiB response cannot drain into the client.
  const exit = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit;
  });
  await once(child, 'message');
  child.stdin!.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'delegate_status', arguments: { runId: 'run-a' } },
    }) + '\n'
  );
  await sleep(50);
  const start = performance.now();
  child.kill('SIGTERM');
  const [code] = await exit;
  assert.equal(code, 0, stderr);
  assert.ok(performance.now() - start < 2000);
});

test(
  'B6 actual SessionRefResolver keeps valid source during a concurrent writer using read-only scope port',
  { skip },
  async (t) => {
    const s = await setup(t);
    const { SessionRefResolver } = await import('../../packages/hud-mcp/src/resolvers.js');
    const { ReadOnlyScopeSnapshot } = await import('../../src/core/ledger-scope-read.js');
    const { fork } = await import('node:child_process');
    const { join, resolve } = await import('node:path');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const id = '01900000-0000-7000-8000-000000000001';
    const actor = await s.f.actor('scope-reader', 30000, id);
    mkdirSync(join(s.f.root, 'sessions'));
    const file = join(s.f.root, 'sessions', id + '.jsonl');
    writeFileSync(
      file,
      JSON.stringify({ type: 'session_meta', payload: { id, source: 'exec', cli_version: '0.166.0' } }) + '\n'
    );
    const source = new SessionRefResolver(
      actor.registration,
      s.f.reader,
      { harness: 'codex', source: { root: s.f.root }, mcpServerName: 'hud' } as any,
      { codex: () => file },
      undefined,
      new ReadOnlyScopeSnapshot(join(s.f.root, 'ledger.sqlite'))
    );
    const meta = {
      callId: 'synthetic-concurrent',
      sessionId: id,
      threadId: id,
      'x-codex-turn-metadata': {
        session_id: id,
        thread_id: id,
        thread_source: 'user',
        codex_version: '0.166.0',
        turn_trigger: 'exec',
      },
    };
    assert.equal((await source.resolve(meta, 'delegate_status')).ok, true);
    const child = fork(resolve('tests/int/b6-lock.mjs'), [join(s.f.root, 'ledger.sqlite')], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const done = once(child, 'exit');
    child.stderr!.resume();
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await done;
    });
    await once(child, 'message');
    const writing = s.f.ledger.transaction((tx) => tx.run('SELECT 1')).catch((error) => error);
    await sleep(1);
    const server = new HudMcpServer(source, {
      invoke: async () => s.f.ledger.readSnapshot((tx) => ({ ok: !!tx.get('SELECT 1 AS n') })),
    });
    const reply: any = await server.handle({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'delegate_status', arguments: { runId: 'run-a' }, _meta: meta },
    });
    assert.equal(reply.result.structuredContent.ok, true);
    await writing;
    await done;
    server.shutdown();
  }
);
