import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import { HudMcpServer } from '../../packages/hud-mcp/src/server.js';

test('B19 merge: call observation, failure decoration and parent shutdown compose', async () => {
  let alive = true;
  let observed = 0;
  let decorated = 0;
  const server = new HudMcpServer(
    { resolve: async () => ({ ok: false as const, code: 'identity_unverified' }) },
    {
      parentCall: () => observed++,
      invoke: async () => assert.fail('refused source cannot invoke'),
      decorateFailure: (_tool, _args, failure) => {
        decorated++;
        return { ...failure, advice: { harness: 'codex' } };
      },
    },
    () => alive
  );
  const call = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'delegate_status', arguments: { runId: 'synthetic-run' } },
  };
  const reply: any = await server.handle(call);
  assert.deepEqual(reply.result.structuredContent, {
    ok: false,
    code: 'identity_unverified',
    advice: { harness: 'codex' },
  });
  assert.equal(observed, 1);
  assert.equal(decorated, 1);
  alive = false;
  const refused: any = await server.handle({ ...call, id: 2 });
  assert.equal(refused.error.message, 'server_shutdown');
  assert.equal(server.shutdownSignal.aborted, true);
  assert.equal(observed, 1);
  assert.equal(decorated, 1);
});

test(
  'B19 merged real-SQLite delegate_report to B22 supervisor hint integration',
  { skip: !ledgerRuntimeSupported() || process.platform !== 'linux', timeout: 20000 },
  async () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', 'tests/int/b19-merge-report.mjs'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const code = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(code, 0, output);
  }
);
