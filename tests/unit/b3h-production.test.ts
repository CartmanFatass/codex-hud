import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import { HeadlessRunControl } from '../../src/core/run/control.js';
import { PrivateLedgerGate } from '../../src/ledger/local-manager.js';
const skip = process.platform !== 'linux' || !ledgerRuntimeSupported();
const helpers = () => import(pathToFileURL(resolve('tests/int/fixture.mjs')).href);

function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]
  );
}
test('H01 production source graph contains no compatibility executor or test fixture imports', () => {
  for (const path of [...files('src'), ...files('bin')]) {
    if (path.endsWith('.md')) continue;
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /launchNodeGroup|group-helper\.[jt]s/, path);
    assert.doesNotMatch(source, /(?:from\s*|import\s*\(|new URL\s*\()\s*['"][^'"]*tests\/run\//, path);
  }
  assert.equal(existsSync('src/core/run/group-helper.ts'), false);
});

for (const fault of ['missing', 'non-gnu'])
  test(`H01 ${fault} env refuses before registration with zero ledger changes and dispatch`, { skip }, async () => {
    const { fixture } = await helpers();
    const f = await fixture([process.execPath, '-e', "require('fs').writeFileSync('dispatched','bad')"]);
    try {
      const tables = f.ledger.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
      const snapshot = () =>
        tables.map((row: any) => [row.name, f.ledger.db.prepare(`SELECT * FROM "${row.name}"`).all()]);
      const before = snapshot();
      const child = spawn(process.execPath, ['tests/run/b3h-preflight.mjs'], {
        env: { ...process.env, HUD_HOME: f.home, B3H_ENV_FAULT: fault },
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (b) => (stderr += b));
      const done = new Promise((r) => child.once('exit', r));
      f.processes.push({ child, done });
      child.stdin.end(JSON.stringify({ input: f.input, ticket: f.ticket }));
      assert.equal(await done, 1);
      assert.match(stderr, /headless_env_features_unavailable/);
      assert.deepEqual(snapshot(), before);
      assert.equal(existsSync(join(f.home, 'dispatched')), false);
      assert.equal(existsSync(join(f.home, 'runs')), false);
    } finally {
      await f.cleanup();
    }
  });

test('H04 equals in a managed shell executable refuses before ticket consumption', { skip }, async () => {
  const { fixture } = await helpers();
  const f = await fixture({ shell: 'printf forbidden', shellPath: '/synthetic/sh=unsupported' });
  try {
    const before = await f.port.read(f.input.runId);
    await assert.rejects(
      () =>
        new HeadlessRunControl(f.port, f.home, new PrivateLedgerGate(f.home).actor()).start({
          input: f.input,
          ticket: f.ticket,
          managedShellVerified: true,
        }),
      /headless_executable_assignment_unsupported/
    );
    const after = await f.port.read(f.input.runId);
    assert.deepEqual(after.run, before.run);
    assert.deepEqual(after.events, before.events);
    assert.equal(after.claimState, 'issued');
    assert.equal(existsSync(join(f.home, 'runs')), false);
  } finally {
    await f.cleanup();
  }
});

for (const role of ['forwarder', 'waiter', 'leader'] as const)
  test(`H05 real-ledger ${role} death preserves the documented fault boundary`, { skip }, async () => {
    const { fixture, until } = await helpers();
    const { launchGroup, readProcess, processState, sameStamp } = await import('../../src/core/run/process.js');
    const f = await fixture([
      process.execPath,
      '-e',
      "process.on('SIGINT',()=>{});console.log('ready');setTimeout(()=>process.exit(0),1200)",
    ]);
    let group: Awaited<ReturnType<typeof launchGroup>> | undefined;
    let running: Promise<void> | undefined;
    const owned: import('../../src/core/types/supervision.js').ProcessStamp[] = [];
    try {
      const control = new HeadlessRunControl(f.port, f.home, new PrivateLedgerGate(f.home).actor(), async (o) => {
        group = await launchGroup(o);
        return group;
      });
      running = control.start({ input: f.input, ticket: f.ticket });
      await until(async () => (await f.port.read(f.input.runId)).meta?.scope);
      await until(() => readFileSync(join(f.home, 'runs', f.input.runId, 'stdout.log'), 'utf8').includes('ready'));
      const g = group!;
      const waiter = readProcess(g.command!.pid)!.ppid;
      const children = readFileSync(`/proc/${g.helper.pid}/task/${g.helper.pid}/children`, 'utf8')
        .trim()
        .split(/\s+/)
        .map(Number);
      owned.push(
        g.helper,
        g.command!,
        ...children.flatMap((pid) => {
          const p = readProcess(pid);
          return p ? [p.stamp] : [];
        })
      );
      assert.equal(children.length, 2);
      const target =
        role === 'leader' ? g.helper.pid : role === 'waiter' ? waiter : children.find((pid) => pid !== waiter)!;
      process.kill(target, 'SIGKILL');
      if (role === 'forwarder') {
        assert.equal(await g.signal('SIGINT'), false);
        await running;
        const after = await f.port.read(f.input.runId);
        assert.equal(after.run.state, 'ended');
        assert.equal(after.receipt.reason, 'scope_ended');
        assert.equal(after.receipt.native_exit, null);
        assert.equal(after.slotHeld, false);
      } else if (role === 'waiter') {
        await until(() => processState(g.command!) === 'dead');
        const held = await f.port.read(f.input.runId);
        assert.equal(held.slotHeld, true);
        assert.equal(held.receipt, null);
        assert.equal(g.shellDiagnostic, null);
        assert.equal(
          held.events.some((e: any) => e.kind === 'command.exited'),
          false
        );
        assert.equal(await g.signal('SIGINT'), true);
        assert.equal(await g.signal('SIGKILL'), false);
        await running;
      } else {
        await running;
        assert.equal(processState(g.command!), 'alive');
        assert.equal(await g.signal('SIGTERM'), false);
        const after = await f.port.read(f.input.runId);
        assert.equal(after.run.state, 'uncertain');
        assert.equal(after.slotHeld, true);
        assert.equal(after.receipt, null);
      }
      assert.equal((await f.port.read(f.input.runId)).receipt?.native_exit ?? null, null);
    } finally {
      for (const stamp of owned) {
        const current = readProcess(stamp.pid);
        if (current && sameStamp(current.stamp, stamp) && processState(stamp) === 'alive') {
          try {
            process.kill(stamp.pid, 'SIGKILL');
          } catch {}
        }
      }
      group?.close();
      await running?.catch(() => {});
      for (const stamp of owned) {
        await until(() => processState(stamp) === 'dead');
        assert.equal(processState(stamp), 'dead', `owned ${stamp.pid} survived cleanup`);
      }
      await f.cleanup();
    }
  });
