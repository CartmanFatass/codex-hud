import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliHerdrTransport } from '../../dist/integrations/herdr/transport.js';
import { HerdrClient } from '../../dist/integrations/herdr/client.js';
import { until } from './private-server.mjs';

test('B7 real transport process exits mid-reply: bounded unknown, no resend', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hud-b7-transport-'));
  const socket = join(root, 'private.sock');
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require('net').createServer(s=>s.once('data',()=>{s.write('{"id":');setTimeout(()=>process.exit(0),10)})).listen(process.argv[1])`,
      socket,
    ],
    { stdio: 'ignore' }
  );
  const done = new Promise((resolve) => {
    child.once('exit', resolve);
    child.once('error', resolve);
  });
  try {
    await until(async () => {
      await access(socket);
      return true;
    });
    const transport = new CliHerdrTransport(socket, {}, 'herdr', 250);
    await assert.rejects(transport.request('session.snapshot', {}), /transport_unavailable/);
    await done;
    const diagnostics = [];
    const client = new HerdrClient(
      new CliHerdrTransport(socket, {}, '/synthetic/missing-herdr', 100),
      { HERDR_ENV: '1' },
      (c) => diagnostics.push(c)
    );
    assert.equal((await client.preflight()).diagnostic, 'herdr_unavailable');
    assert.deepEqual(diagnostics, ['herdr_unavailable']);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await done;
    await rm(root, { recursive: true, force: true });
  }
});
