import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import { openLedger } from '../../src/ledger/ledger.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import { PrivateLedgerGate } from '../../src/ledger/local-manager.js';
import { LedgerCallerRegistry } from '../../packages/hud-mcp/src/ledger-registry.js';
import { LinuxProcessReader, type ProcessInfo, type ProcessReaderPort } from '../../packages/hud-mcp/src/process.js';
import { registerCaller } from '../../packages/hud-mcp/src/registry.js';
import { deriveProcessDomain } from '../../src/core/process-domain.js';
import { SessionRefResolver } from '../../packages/hud-mcp/src/resolvers.js';
import { HudMcpServer } from '../../packages/hud-mcp/src/server.js';
const skip = ledgerRuntimeSupported() ? false : 'Ledger requires Node 22 >=22.13 or >=24';

for (const code of ['EACCES', 'EPERM'] as const) {
  test(
    `int simulated optional ancestor ${code} writes only physical caller; source-less tool cannot authorize`,
    { skip },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'hud-mcp-ancestor-ledger-'));
      const ledger = await openLedger(join(home, 'ledger.sqlite'));
      try {
        const deniedPid = 2147483001;
        const fartherPid = 2147483002;
        assert.ok(![process.pid, process.ppid].includes(deniedPid));
        assert.ok(![process.pid, process.ppid].includes(fartherPid));
        const self: ProcessInfo = {
          pid: process.pid,
          ppid: process.ppid,
          procStart: 'synthetic-self-start',
          argv: ['node'],
          env: {},
          pidNamespace: 'pid:[synthetic]',
        };
        const parent: ProcessInfo = {
          ...self,
          pid: process.ppid,
          ppid: deniedPid,
          procStart: 'synthetic-parent-start',
          argv: ['synthetic-shell'],
        };
        const reads: number[] = [];
        const reader: ProcessReaderPort = {
          get: (pid) => {
            reads.push(pid);
            if (pid === deniedPid) throw Object.assign(new Error('simulated access denial'), { code });
            if (pid === fartherPid) return { ...parent, pid, ppid: 1, argv: ['codex'] };
            assert.ok(pid === self.pid || pid === parent.pid, 'no alternative PID search');
            return structuredClone(pid === self.pid ? self : parent);
          },
          domain: () =>
            deriveProcessDomain({
              machineId: 'synthetic-machine',
              bootId: 'synthetic-boot',
              pidNamespace: self.pidNamespace,
            }),
        };
        const registry = new LedgerCallerRegistry(ledger, new PrivateLedgerGate(home), reader);
        const registration = await registerCaller({
          reader,
          registry,
          profile: null,
          pid: process.pid,
          cwd: () => process.cwd(),
          envPane: null,
          nowMs: 123,
        });
        assert.equal(reads.filter((pid) => pid === deniedPid).length, 1);
        assert.equal(reads.includes(fartherPid), false);
        assert.equal(registration.source, null);
        assert.equal(registration.harnessPid, null);
        assert.equal(registration.harnessProcStart, null);
        const stored = ledger.snapshot((tx) =>
          tx.get('SELECT * FROM callers WHERE caller_id=?', registration.caller.callerId)
        );
        assert.equal(stored?.proc_start, self.procStart);
        assert.equal(stored?.parent_proc_start, parent.procStart);
        assert.equal(stored?.cwd, process.cwd());
        assert.equal(stored?.harness, null);
        assert.equal(stored?.source_id, null);
        const counts = () =>
          ledger.snapshot((tx) =>
            Object.fromEntries(
              [
                'sources',
                'sessions',
                'caller_scopes',
                'caller_contexts',
                'owner_aliases',
                'child_bindings',
                'claims',
                'links',
                'runs',
                'reports',
                'idempotency',
                'slots',
              ].map((table) => [table, tx.get(`SELECT count(*) AS n FROM ${table}`)!.n])
            )
          );
        const before = counts();
        assert.ok(Object.values(before).every((n) => n === 0));
        let dispatches = 0;
        const server = new HudMcpServer(new SessionRefResolver(registration, reader, null), {
          invoke: async () => {
            dispatches++;
            throw new Error('no logical authority');
          },
        });
        const reply = (await server.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'delegate_whoami', arguments: { claim: 'synthetic' }, _meta: {} },
        })) as { result: { structuredContent: unknown } };
        assert.deepEqual(reply.result.structuredContent, { ok: false, code: 'identity_source_missing' });
        assert.equal(dispatches, 0);
        assert.deepEqual(counts(), before);
        assert.equal(
          ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM callers')!.n),
          1
        );
      } finally {
        await ledger.close();
        rmSync(home, { recursive: true, force: true });
      }
    }
  );
}

test(
  'int hud-mcp physical caller registration persists real procStart/cwd without logical authority',
  { skip },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'hud-mcp-ledger-'));
    const ledger = await openLedger(join(home, 'ledger.sqlite'));
    try {
      const registry = new LedgerCallerRegistry(ledger, new PrivateLedgerGate(home));
      const reader = new LinuxProcessReader();
      const input = {
        reader,
        registry,
        profile: null,
        pid: process.pid,
        cwd: () => process.cwd(),
        envPane: null,
        nowMs: Date.now(),
      };
      await assert.rejects(
        () =>
          registerCaller({
            ...input,
            cwd: () => {
              throw new Error('missing');
            },
          }),
        /cwd_unavailable/
      );
      assert.equal(
        ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM callers')!.n),
        0
      );
      const registration = await registerCaller(input);
      const row = ledger.snapshot((tx) =>
        tx.get('SELECT * FROM callers WHERE caller_id=?', registration.caller.callerId)
      );
      assert.equal(row?.proc_start, reader.get(process.pid).procStart);
      assert.equal(row?.parent_proc_start, reader.get(process.ppid).procStart);
      assert.equal(row?.cwd, process.cwd());
      for (const table of ['caller_scopes', 'caller_contexts', 'child_bindings', 'claims'])
        assert.equal(
          ledger.snapshot((tx) => tx.get(`SELECT count(*) AS n FROM ${table}`)!.n),
          0
        );
      await assert.rejects(
        () => registry.register({ ...registration.caller, procStart: 'forged' }, null),
        /registration_unverified/
      );
      await assert.rejects(
        () => registry.register({ ...registration.caller, cwd: '/synthetic/session-cwd' }, null),
        /registration_unverified/
      );
    } finally {
      await ledger.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
);

test('int hud-mcp composition uses existing ledger even when diagnostic registry requested', { skip }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'hud-mcp-composition-'));
  const ledger = await openLedger(join(home, 'ledger.sqlite'));
  const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-mcp.mjs')], {
    env: { ...process.env, HUD_HOME: home, HUD_MCP_REGISTRY_DIR: join(home, 'diagnostic') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (x) => (stderr += x));
  const done = new Promise<number | null>((resolve) => child.once('exit', resolve));
  child.stdin.end();
  try {
    assert.equal(await done, 0, stderr);
    const rows = ledger.snapshot((tx) => tx.all('SELECT * FROM callers'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pid, child.pid);
    assert.equal(rows[0].cwd, process.cwd());
    assert.ok(rows[0].proc_start);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await done;
    await ledger.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// Child exit can precede the last stdio data event. Only close completes capture.
function captureMcpOutput(child: { stdout: Readable; stderr: Readable; once: EventEmitter['once'] }) {
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const done = new Promise<number | null>((resolve) => child.once('close', resolve));
  return {
    done,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

function assertDiscoveryStdout(stdout: string) {
  assert.ok(stdout.endsWith('\n'));
  const replies = stdout
    .slice(0, -1)
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(replies.length, 3);
  assert.deepEqual(
    replies.map((reply) => [reply.jsonrpc, reply.id]),
    [
      ['2.0', 1],
      ['2.0', 2],
      ['2.0', 3],
    ]
  );
}

for (const [name, tail] of [
  ['non-JSON line', 'late diagnostic\n'],
  ['extra JSON-RPC record', JSON.stringify({ jsonrpc: '2.0', id: 4, result: {} }) + '\n'],
  ['unterminated output', 'late diagnostic'],
] as const) {
  test(`stdio capture rejects ${name} delivered after exit and before close`, async () => {
    // Trusted deterministic event fixture: no process, socket or timing race is needed.
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    const capture = captureMcpOutput(child);
    const valid = [1, 2, 3].map((id) => JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\n').join('');
    child.stdout.write(valid);
    assertDiscoveryStdout(capture.stdout);
    let completed = false;
    const done = capture.done.then((code) => {
      completed = true;
      assert.equal(code, 0);
      assertDiscoveryStdout(capture.stdout);
    });
    // Attach the rejection assertion before introducing the contaminated output.
    const rejected = assert.rejects(done, name === 'non-JSON line' ? SyntaxError : assert.AssertionError);
    child.emit('exit', 0, null);
    await Promise.resolve();
    assert.equal(completed, false, 'exit must not settle complete-output verification');
    child.stdout.write(tail);
    child.stderr.write('late stderr diagnostic\n');
    await Promise.all(
      [child.stdout, child.stderr].map(
        (stream) =>
          new Promise<void>((resolve) => {
            stream.once('end', resolve);
            stream.end();
          })
      )
    );
    assert.equal(completed, false, 'capture waits for close even after EOF');
    child.emit('close', 0, null);
    await rejected;
    assert.equal(completed, true);
    assert.equal(capture.stdout, valid + tail);
    assert.equal(capture.stderr, 'late stderr diagnostic\n');
  });
}

test('int unconfigured real MCP answers discovery and refuses whoami with JSON-RPC-only stdout', { skip }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'hud-mcp-ancestor-stdio-'));
  const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-mcp.mjs')], {
    env: { ...process.env, HOME: home, HUD_HOME: home, HUD_MCP_PROFILE: '', HUD_MCP_REGISTRY_DIR: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const capture = captureMcpOutput(child);
  let buffer = '';
  let sequence = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const reply = JSON.parse(line) as { id: number };
        pending.get(reply.id)?.resolve(reply);
      } catch {
        for (const request of pending.values()) request.reject(new Error('non-JSON-RPC stdout'));
      }
    }
  });
  const done = capture.done.then((code) => {
    for (const request of pending.values()) request.reject(new Error(`MCP closed early: ${capture.stderr}`));
    return code;
  });
  const request = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++sequence;
      const finish = (value: unknown, error?: Error) => {
        clearTimeout(timer);
        pending.delete(id);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => finish(null, new Error(`MCP deadline: ${method}: ${capture.stderr}`)), 5000);
      pending.set(id, { resolve: (value) => finish(value), reject: (error) => finish(null, error) });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  try {
    const initialized = (await request('initialize', { protocolVersion: '2025-06-18' })) as {
      result: { serverInfo: { name: string } };
    };
    assert.equal(initialized.result.serverInfo.name, 'hud-mcp');
    const listed = (await request('tools/list', {})) as { result: { tools: unknown[] } };
    assert.equal(listed.result.tools.length, 7);
    const called = (await request('tools/call', { name: 'delegate_whoami', arguments: {} })) as {
      result: { structuredContent: unknown };
    };
    assert.deepEqual(called.result.structuredContent, { ok: false, code: 'identity_source_missing' });
    child.stdin.end();
    assert.equal(await done, 0, capture.stderr);
    assert.equal(buffer, '');
    assertDiscoveryStdout(capture.stdout);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await done;
    rmSync(home, { recursive: true, force: true });
  }
});
