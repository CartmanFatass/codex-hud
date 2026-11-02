import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HerdrClient } from '../../dist/integrations/herdr/client.js';
import { HerdrRegistry } from '../../dist/integrations/herdr/registry.js';
import { HerdrHost } from '../../dist/integrations/herdr/host.js';
import { privateServer, until } from './private-server.mjs';

// All mutations are on a new private server, with no inherited Herdr context.
test(
  'private Herdr: schema/server proof, tab --env, safe argv, readiness, single dispatch, mid-call death',
  { timeout: 20_000 },
  async () => {
    const f = await privateServer();
    try {
      const client = new HerdrClient(f.transport, { HERDR_ENV: '1' });
      assert.equal((await client.preflight()).ready, true);
      const creation = await f.transport.request('workspace.create', { cwd: f.root, focus: false });
      const registry = new HerdrRegistry(client);
      const host = new HerdrHost(client, registry, {
        workspace: creation.workspace.workspace_id,
        pane: creation.root_pane.pane_id,
      });
      const locator = await host.openSurface('tab', {
        cwd: f.root,
        env: { HUD_HOME: f.env.HUD_HOME, B7_SENTINEL: 'synthetic $ ; = value' },
        managed: null,
      });
      const target = join(f.root, 'received.json');
      const args = ["'", '$()', '; touch DO_NOT_CREATE', 'line\nbreak'];
      const script = `require('fs').writeFileSync(process.argv[1],JSON.stringify({env:process.env.B7_SENTINEL,args:process.argv.slice(2)}))`;
      await host.runInSurface(locator, { argv: [process.execPath, '-e', script, target, ...args] });
      await until(async () => {
        await access(target);
        return true;
      });
      assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { env: 'synthetic $ ; = value', args });
      await assert.rejects(host.runInSurface(locator, { argv: ['true'] }), /submission_forbidden/);
      await assert.rejects(
        host.closeSurface(locator, {
          createdForRun: 'synthetic-run',
          occupantGeneration: locator.occupantGeneration,
          occupantStamp: locator.process,
        }),
        /close_tab_refused/
      );
      f.child.kill('SIGTERM');
      await f.done;
      assert.equal((await host.checkLocator(locator)).state, 'unknown');
      assert.deepEqual(await registry.list(), []);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'private Herdr: foreground workload and occupant replacement refuse close and stale input',
  { timeout: 20_000 },
  async () => {
    const f = await privateServer();
    try {
      const client = new HerdrClient(f.transport, { HERDR_ENV: '1' });
      const registry = new HerdrRegistry(client);
      const creation = await f.transport.request('workspace.create', { cwd: f.root, focus: false });
      const host = new HerdrHost(client, registry, {
        workspace: creation.workspace.workspace_id,
        pane: creation.root_pane.pane_id,
      });
      const locator = await host.openSurface('split', {
        cwd: f.root,
        env: { HUD_HOME: f.env.HUD_HOME },
        managed: { runId: 'synthetic-run', bindingGeneration: 9 },
      });
      const proof = {
        createdForRun: 'synthetic-run',
        occupantGeneration: locator.occupantGeneration,
        occupantStamp: locator.process,
      };
      await assert.rejects(host.closeSurface(locator, proof), /conditional_close_unavailable/);
      await host.runInSurface(locator, { argv: ['/bin/sleep', '0.5'] });
      await until(async () => (await host.checkLocator(locator)).state === 'stale');
      await assert.rejects(host.closeSurface(locator, proof), /locator_stale/);
      await assert.rejects(host.sendKeys(locator, ['ctrl+c']), /locator_stale|interaction_unavailable/);
      await until(async () => (await registry.observe(locator.pane)).atPrompt);
      assert.equal((await host.checkLocator(locator)).state, 'stale');
      const fresh = (await registry.observe(locator.pane)).locator;
      const freshProof = { ...proof, occupantGeneration: fresh.occupantGeneration, occupantStamp: fresh.process };
      await assert.rejects(host.closeSurface(fresh, freshProof), /conditional_close_unavailable/);
      // Destruction has never happened: both panes still exist in this private tab.
      assert.equal((await f.transport.request('pane.layout', { pane_id: fresh.pane })).layout.panes.length, 2);
    } finally {
      await f.cleanup();
    }
  }
);

test('private Herdr: first agent prompt reaches a synthetic TTY receiver once', { timeout: 20_000 }, async () => {
  const f = await privateServer();
  try {
    const { writeFile } = await import('node:fs/promises');
    const { HerdrRunControl } = await import('../../dist/integrations/herdr/run-control.js');
    const client = new HerdrClient(f.transport, { HERDR_ENV: '1' });
    const registry = new HerdrRegistry(client, async (observation) => {
      const { readProcess } = await import('../../dist/core/run/process.js');
      const stamp = readProcess(Number(await readFile(join(f.root, 'ready'), 'utf8')))?.stamp;
      return stamp && observation.pane.agent === 'codex'
        ? {
            sessionRef: {
              harness: 'codex',
              sourceId: 'synthetic-source',
              sessionId: 'synthetic-session',
              threadId: null,
            },
            harness: stamp,
          }
        : null;
    });
    const creation = await f.transport.request('workspace.create', { cwd: f.root, focus: false });
    const host = new HerdrHost(client, registry, { workspace: creation.workspace.workspace_id });
    const locator = await host.openSurface('tab', {
      cwd: f.root,
      env: { HUD_HOME: f.env.HUD_HOME },
      managed: { runId: 'synthetic-run', bindingGeneration: 1 },
    });
    const receiver = join(f.root, 'receiver.cjs');
    const ready = join(f.root, 'ready');
    const received = join(f.root, 'received');
    await writeFile(
      receiver,
      `const fs=require('fs');process.title='codex';process.stdin.setRawMode(true);let b='';process.stdin.on('data',d=>{b+=d.toString();fs.writeFileSync(process.argv[3],b)});fs.writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},10000)`
    );
    await host.runInSurface(locator, { argv: [process.execPath, receiver, ready, received] });
    await until(async () => {
      await access(ready);
      return true;
    });
    await f.transport.request('pane.report_agent', {
      pane_id: locator.pane,
      source: 'b7-synthetic',
      agent: 'codex',
      state: 'idle',
      seq: 1,
    });
    const observation = await until(async () => {
      const o = await registry.observe(locator.pane);
      return o.agentReady ? o : null;
    });
    const current = observation.locator;
    const fixed = await host.recordLocator('synthetic-run', 1, current, observation.occupant.stamp, async () => {});
    const status = {
      currentRun: {
        runId: 'synthetic-run',
        expectedGeneration: 1,
        state: 'running',
        supervisor: observation.occupant.stamp,
        locator: fixed,
      },
      interaction: { input: true },
    };
    const core = { status: async () => status, cancel: async () => status, reconcile: async () => status };
    const control = new HerdrRunControl(core, host, [
      { runId: 'synthetic-run', bindingGeneration: 1, locator: current },
    ]);
    await control.sendInput('synthetic-run', 'synthetic first prompt');
    await until(async () => (await readFile(received, 'utf8')).includes('synthetic first prompt'));
    await assert.rejects(control.sendInput('synthetic-run', 'duplicate prompt'), /initial_input_only/);
    const bytes = await readFile(received, 'utf8');
    assert.equal(bytes.split('synthetic first prompt').length - 1, 1);
    assert.ok(!bytes.includes('duplicate prompt'));
  } finally {
    await f.cleanup();
  }
});

test(
  'private Herdr: missing/stale/foreign server stamps and replaced/ambiguous endpoints refuse proof',
  { timeout: 20_000 },
  async () => {
    const f = await privateServer();
    const { CliHerdrTransport } = await import('../../dist/integrations/herdr/transport.js');
    const { readProcess } = await import('../../dist/core/run/process.js');
    const { rename } = await import('node:fs/promises');
    const { createServer } = await import('node:net');
    let replacement;
    try {
      const socket = f.transport.socketPath;
      assert.ok(await f.transport.instance());
      const noStamp = new CliHerdrTransport(socket, f.env);
      assert.equal(await noStamp.instance(), null);
      const stale = new CliHerdrTransport(socket, f.env, 'herdr', 1500, {
        ...f.stamp,
        proc_start: String(BigInt(f.stamp.proc_start) + 1n),
      });
      assert.equal(await stale.instance(), null);
      const foreign = new CliHerdrTransport(socket, f.env, 'herdr', 1500, readProcess(process.pid).stamp);
      assert.equal(await foreign.instance(), null);
      const original = await f.transport.instance();
      const backup = join(f.root, 'saved-private.sock');
      await rename(socket, backup);
      replacement = createServer(() => {});
      await new Promise((resolve, reject) => {
        replacement.once('error', reject);
        replacement.listen(socket, resolve);
      });
      // Both kernel listeners report the original pathname, which is now ambiguous;
      // the replacement inode belongs to this test process, never the recorded server.
      assert.equal(await f.transport.instance(), null);
      await new Promise((resolve) => replacement.close(resolve));
      replacement = undefined;
      await rename(backup, socket);
      const changed = await f.transport.instance();
      assert.ok(changed);
      assert.notEqual(changed, original);
      f.child.kill('SIGTERM');
      await f.done;
      assert.equal(await f.transport.instance(), null);
    } finally {
      if (replacement) await new Promise((resolve) => replacement.close(resolve));
      await f.cleanup();
    }
  }
);
