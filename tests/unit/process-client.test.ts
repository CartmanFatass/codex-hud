import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ProcessClient } from '../int/process-client.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'hud-process-client-'));
  mkdirSync(join(root, 'home'));
  mkdirSync(join(root, 'hud'));
  const clients: ProcessClient[] = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.kill()));
    rmSync(root, { recursive: true, force: true });
  });
  const launch = (entry: string) => {
    const child = fork(entry, [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, HOME: join(root, 'home'), HUD_HOME: join(root, 'hud') },
      execArgv: [],
    });
    const client = new ProcessClient(child, 'synthetic-helper');
    clients.push(client);
    return client;
  };
  const script = (source: string) => {
    const entry = join(root, `synthetic-${clients.length}.mjs`);
    writeFileSync(entry, source);
    return launch(entry);
  };
  return { root, launch, script };
}

for (const entry of ['b12r-process.mjs', 'b16-process.mjs'])
  test(
    `process client rejects pending and later RPC/point waits with ${entry} import diagnostics`,
    { timeout: 5000 },
    async (t) => {
      const f = fixture(t);
      const dir = join(f.root, 'tests', 'int');
      mkdirSync(dir, { recursive: true });
      const copy = join(dir, entry);
      // Copy the actual child into a private tree with no dist/, reproducing its startup failure.
      copyFileSync(resolve('tests/int', entry), copy);
      const client = f.launch(copy);
      const check = (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /synthetic-helper/);
        assert.match(error.message, /ERR_MODULE_NOT_FOUND/);
        assert.match(error.message, /dist\/core\/observation-store.js/);
        assert.match(error.message, /Node.js v/);
        return true;
      };
      await Promise.all([
        assert.rejects(client.call('open'), check),
        assert.rejects(client.point('before_commit'), check),
      ]);
      await client.closed;
      await assert.rejects(client.call('later'), check);
      await assert.rejects(client.point('after_commit'), check);
    }
  );

test(
  'process client drains noisy stderr with bounded diagnostics and rejects a zero-exit missing reply',
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t);
    const client = f.script(
      `process.stderr.write('synthetic-start\\n' + 'x'.repeat(1024 * 1024), () => process.exit(0));`
    );
    await assert.rejects(client.call('missing'), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /synthetic-helper exited \(code 0, signal null\)/);
      assert.match(error.message, /synthetic-start/);
      assert.ok(error.message.length < 8400);
      return true;
    });
  }
);

test('process client reports id-less errors to RPC and point waits', { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  const client = f.script(`process.on('message', () => process.send({error:'synthetic B16 failure'}));`);
  await Promise.all([
    assert.rejects(client.point('before_commit'), /synthetic-helper reported synthetic B16 failure/),
    assert.rejects(client.call('publish'), /synthetic-helper reported synthetic B16 failure/),
  ]);
  await assert.rejects(client.point('later'), /synthetic B16 failure/);
});

test('process client rejects live IPC disconnection instead of leaving waits pending', { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  const client = f.script(`process.on('message', () => process.disconnect()); setInterval(() => {}, 1000);`);
  await Promise.all([
    assert.rejects(client.point('missing'), /synthetic-helper.*IPC disconnected/),
    assert.rejects(client.call('disconnect'), /synthetic-helper.*IPC disconnected/),
  ]);
  await assert.rejects(client.call('later'), /IPC disconnected/);
});

test(
  'process client preserves replies and early points, then reaps an intentional exact-child kill',
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t);
    const client = f.script(`process.on('message', ({id,op}) => {
    if(op === 'fail') process.send({id,error:'synthetic request error'});
    else { process.send({point:'before_commit'}); process.send({id,result:'synthetic result'}); }
  });`);
    assert.equal(await client.call('publish'), 'synthetic result');
    assert.deepEqual(await client.point('before_commit'), { point: 'before_commit' });
    await assert.rejects(client.call('fail'), /synthetic request error/);
    assert.equal(await client.call('again'), 'synthetic result');
    await client.point('before_commit');
    const pending = assert.rejects(client.point('never'), /synthetic-helper/);
    await client.kill();
    await pending;
    assert.equal(client.child.signalCode, 'SIGKILL');
    await client.kill();
    await assert.rejects(client.call('after kill'), /synthetic-helper/);
  }
);
