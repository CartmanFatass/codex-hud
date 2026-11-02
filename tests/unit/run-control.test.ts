import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { HeadlessRunControl, codexClaimArgs } from '../../src/core/run/control.js';
import { MemoryRunFactPort, FileRunFactPort } from '../../src/core/run/fake-port.js';
import { launchNodeGroup, readProcess, processState } from '../../src/core/run/process.js';
import { RunArtifacts } from '../../src/core/run/artifacts.js';
import { seedRun } from '../run/fixtures.js';
import type { RunControl } from '../../src/core/interfaces/run-control.js';
import type { ProcessStamp } from '../../src/core/types/supervision.js';
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const cliSkip =
  nodeMajor < 22 || nodeMajor === 23 || (nodeMajor === 22 && nodeMinor < 13)
    ? 'hud-run CLI requires Node 22 >=22.13 or >=24; compatible in-process tests remain enabled'
    : false;
const local = { kind: 'trusted_local' as const, uid: process.getuid!(), invocationId: 'synthetic-invocation' };
async function until<T>(fn: () => T | Promise<T>, limit = 8000): Promise<NonNullable<T>> {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value as NonNullable<T>;
    await sleep(20);
  }
  throw new Error('test event deadline');
}
function setup(argv: string[], patch: Parameters<typeof seedRun>[2] = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hud-run-control-'));
  const data = seedRun(home, argv, patch);
  const port = new MemoryRunFactPort(data.seed);
  const control = new HeadlessRunControl(port, home, local, launchNodeGroup);
  return { home, ...data, port, control, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
function cli(home: string, options: unknown) {
  const child = spawn(process.execPath, ['bin/hud-run', 'start'], {
    cwd: resolve('.'),
    env: { ...process.env, HUD_HOME: home, HUD_RUN_PORT_MODULE: resolve('tests/run/file-port.mjs') },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (x) => (stderr += x));
  child.stdin.end(JSON.stringify(options));
  const done = new Promise<number | null>((r) => child.once('exit', r));
  return { child, done, stderr: () => stderr };
}

test('RunControl real contract: readonly status, byte logs, stdin EOF, normal and nonzero native result', async () => {
  const s = setup(
    [
      process.execPath,
      '-e',
      `let a=[];process.stdin.on('data',x=>a.push(x));process.stdin.on('end',()=>setTimeout(()=>{process.stdout.write(Buffer.concat(a));process.exit(7)},100));`,
    ],
    { stdin: 'brief' }
  );
  try {
    const contract: RunControl = s.control;
    const before = await s.port.read(s.input.runId);
    await contract.status(s.input.runId);
    assert.equal((await s.port.read(s.input.runId)).revision, before.revision);
    await s.control.start({ input: s.input, ticket: s.ticket, brief: Buffer.from('é\u0000literal;$') });
    const after = await s.port.read(s.input.runId);
    assert.equal(after.run.state, 'ended');
    assert.equal(after.run.exitCode, 7);
    assert.equal(after.slotHeld, false);
    assert.equal(s.control.logs(s.input.runId, 'stdout').data.toString(), 'é\u0000literal;$');
    assert.equal(after.events.filter((e) => e.kind === 'supervisor.registered').length, 1);
  } finally {
    s.cleanup();
  }
});
test('normal exit 0 creates one durable final receipt before adoption', async () => {
  const s = setup([process.execPath, '-e', 'setTimeout(()=>process.exit(0),120)']);
  try {
    await s.control.start({ input: s.input, ticket: s.ticket });
    const r = RunArtifacts.open(s.home, s.input.runId).readExit();
    assert.equal(r?.native_exit?.exit_code, 0);
    assert.equal((await s.control.status(s.input.runId)).currentRun?.state, 'ended');
    assert.equal(r?.reason, 'normal_exit');
    assert.equal(r?.started_at, (await s.port.read(s.input.runId)).run.startedAt);
  } finally {
    s.cleanup();
  }
});
test('cancel authenticates intent, returns promptly, preserves duplicate grace and signals three stages', async () => {
  const s = setup([
    process.execPath,
    '-e',
    `process.on('SIGINT',()=>{});process.on('SIGTERM',()=>process.exit(0));process.stdout.write('ready');setTimeout(()=>{},60000)`,
  ]);
  let running: Promise<void> | undefined;
  try {
    running = s.control.start({ input: s.input, ticket: s.ticket });
    await until(() => {
      try {
        return s.control.logs(s.input.runId, 'stdout').data.toString() === 'ready';
      } catch {
        return false;
      }
    });
    const denied = new HeadlessRunControl(s.port, s.home, { ...local, uid: local.uid + 1 });
    await assert.rejects(() => denied.cancel(s.input.runId, 0), /unauthorized/);
    const t = performance.now();
    await s.control.cancel(s.input.runId, 50);
    assert.ok(performance.now() - t < 1000);
    await s.control.cancel(s.input.runId, 0);
    await running;
    const after = await s.port.read(s.input.runId);
    assert.equal(after.events.filter((e) => e.kind === 'cancel.accepted').length, 1);
    assert.equal(after.events.find((e) => e.kind === 'cancel.accepted')?.payload.graceMs, 50);
    assert.deepEqual(
      after.events.filter((e) => e.kind === 'cancel.step').map((e) => e.payload.signal),
      ['SIGINT', 'SIGTERM']
    );
    assert.equal(after.run.state, 'cancelled');
  } finally {
    if (running) await running.catch(() => {});
    s.cleanup();
  }
});
test('unknown scope refuses receipts, control and recovery after short shell without harness identity', async () => {
  const s = setup([], { launch: { shell: 'sleep 0.1; exit 137', shellPath: '/bin/sh' } });
  try {
    await s.control.start({ input: s.input, ticket: s.ticket, managedShellVerified: true });
    const p = await s.port.read(s.input.runId);
    assert.equal(p.run.scopeRef, null);
    assert.equal(p.run.state, 'uncertain');
    assert.equal(p.slotHeld, true);
    assert.equal(existsSync(join(s.home, 'runs', s.input.runId, 'exit.json')), false);
  } finally {
    s.cleanup();
  }
});
test('configuration claim leaves preserve user argv and only override four named leaves', () => {
  const args = codexClaimArgs('hud-test', {
    HUD_CLAIM: 'a"\n',
    HUD_RUN: 'run-a',
    HUD_LINK: 'link-a',
    HUD_HOME: '/synthetic/private home',
  });
  assert.equal(args.length, 8);
  assert.ok(args.every((v, i) => (i % 2 === 0 ? v === '-c' : v.startsWith('mcp_servers.hud-test.env.HUD_'))));
  assert.equal(args[1], 'mcp_servers.hud-test.env.HUD_CLAIM="a\\\"\\n"');
  assert.throws(() => codexClaimArgs('bad.env', {} as never));
});
test(
  'supervisor death receiptless Q uses registered stamp, no replacement execution or writer files',
  { skip: cliSkip },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'hud-run-recover-'));
    const data = seedRun(home, [process.execPath, '-e', 'setTimeout(()=>process.exit(0),1500)']);
    writeFileSync(join(home, 'facts.json'), JSON.stringify(data.seed), { mode: 0o600 });
    const p = cli(home, { input: data.input, ticket: data.ticket });
    try {
      await until(() => JSON.parse(readFileSync(join(home, 'facts.json'), 'utf8')).snapshot.meta?.scope);
      const supervisor = readProcess(p.child.pid!)!.stamp;
      p.child.kill('SIGKILL');
      await p.done;
      const port = new FileRunFactPort(join(home, 'facts.json')),
        control = new HeadlessRunControl(port, home, local, launchNodeGroup);
      assert.equal((await control.reconcile(data.input.runId)).currentRun?.state, 'uncertain');
      assert.equal((await port.read(data.input.runId)).slotHeld, true);
      await sleep(1800);
      const after = await control.reconcile(data.input.runId);
      assert.equal(after.currentRun?.state, 'ended');
      assert.equal(after.currentRun?.exitCode, null);
      assert.equal((await port.read(data.input.runId)).slotHeld, false);
      assert.equal(existsSync(join(home, 'runs', data.input.runId, 'exit.json')), false);
      assert.equal(processState(supervisor), 'dead');
    } finally {
      p.child.kill('SIGKILL');
      await p.done;
      rmSync(home, { recursive: true, force: true });
    }
  }
);
test(
  'two real supervisors compete for one fake slot/ticket: loser touches no logs, exactly one submission',
  { skip: cliSkip },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'hud-run-compete-'));
    const data = seedRun(home, [
      process.execPath,
      '-e',
      `process.stdout.write('one');setTimeout(()=>process.exit(0),300)`,
    ]);
    writeFileSync(join(home, 'facts.json'), JSON.stringify(data.seed), { mode: 0o600 });
    const a = cli(home, { input: data.input, ticket: data.ticket }),
      b = cli(home, { input: data.input, ticket: data.ticket });
    try {
      const codes = await Promise.all([a.done, b.done]);
      assert.equal(codes.filter((c) => c === 0).length, 1, `${codes} ${a.stderr()} ${b.stderr()}`);
      const port = new FileRunFactPort(join(home, 'facts.json'));
      assert.equal(
        (await port.read(data.input.runId)).events.filter((e) => e.kind === 'supervisor.registered').length,
        1
      );
      assert.equal(RunArtifacts.open(home, data.input.runId).readLog('stdout', 0).data.toString(), 'one');
    } finally {
      a.child.kill();
      b.child.kill();
      await Promise.all([a.done, b.done]);
      rmSync(home, { recursive: true, force: true });
    }
  }
);
test('registration commit before meta crash retains all stamp fields; missing/mismatched domain never backfills', async () => {
  const s = setup([process.execPath, '-e', '']);
  try {
    const stamp = readProcess(process.pid)!.stamp;
    await s.port.register(s.input.runId, s.ticket, s.seed.snapshot.run.launchDigest, stamp);
    assert.equal(existsSync(join(s.home, 'runs')), false);
    s.seed.snapshot.events[0].payload.supervisor = { ...stamp, pid_domain: 'invisible-synthetic-domain' };
    const status = await s.control.reconcile(s.input.runId);
    assert.equal(status.currentRun?.state, 'uncertain');
    assert.equal(s.seed.snapshot.events[0].payload.supervisor.pid_domain, 'invisible-synthetic-domain');
    assert.equal(s.seed.snapshot.slotHeld, true);
  } finally {
    s.cleanup();
  }
});
test('reconcile revision prevents competing cancel or registration being overwritten', async () => {
  const s = setup([process.execPath, '-e', '']);
  try {
    const snapshot = await s.port.read(s.input.runId);
    await s.port.acceptCancel(s.input.runId, local, 10);
    assert.equal(await s.port.reconcile(s.input.runId, snapshot.revision, [], Date.now()), null);
    assert.equal((await s.control.status(s.input.runId)).currentRun?.cancelRequestedAt !== null, true);
  } finally {
    s.cleanup();
  }
});

test('verified shell harness keeps native unknown separately from actual shell status 137', async () => {
  const s = setup([]);
  const marker = join(s.home, 'synthetic-harness.pid');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setTimeout(()=>process.exit(0),300)`;
  s.input.launch = {
    shell: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}; exit 137`,
    shellPath: '/bin/sh',
  };
  // Single foreground synthetic profile, independently verified by its private startup record.
  s.seed.snapshot.run.launchDigest = (await import('../../src/core/run/control.js')).launchDigest(s.input);
  try {
    await s.control.start({
      input: s.input,
      ticket: s.ticket,
      managedShellVerified: true,
      identifyHarness: async () =>
        until(() => {
          try {
            return readProcess(Number(readFileSync(marker, 'utf8')))?.stamp ?? null;
          } catch {
            return null;
          }
        }),
    });
    const receipt = RunArtifacts.open(s.home, s.input.runId).readExit();
    assert.equal(receipt?.native_exit, null);
    assert.equal(receipt?.shell_exit?.exit_code, 137);
    assert.equal(receipt?.reason, 'scope_ended');
    assert.equal((await s.control.status(s.input.runId)).currentRun?.state, 'ended');
  } finally {
    s.cleanup();
  }
});
test('direct harness killed by a real signal records sourced wait signal', async () => {
  const s = setup([process.execPath, '-e', `process.stdout.write('ready');setTimeout(()=>{},60000)`]);
  let running: Promise<void> | undefined;
  try {
    running = s.control.start({ input: s.input, ticket: s.ticket });
    const stamp = await until(async () => (await s.port.read(s.input.runId)).meta?.harness);
    process.kill(stamp.pid, 'SIGTERM');
    await running;
    const receipt = RunArtifacts.open(s.home, s.input.runId).readExit();
    assert.equal(receipt?.native_exit?.signal, 'SIGTERM');
    assert.equal(receipt?.native_exit?.exit_code, null);
    assert.equal((await s.control.status(s.input.runId)).currentRun?.state, 'ended');
  } finally {
    await running?.catch(() => {});
    s.cleanup();
  }
});
test('accepted cancellation with verified scope absent never signals a guessed shell group', async () => {
  const s = setup([], { launch: { shell: 'sleep 0.3', shellPath: '/bin/sh' } });
  let running: Promise<void> | undefined;
  try {
    running = s.control.start({ input: s.input, ticket: s.ticket, managedShellVerified: true });
    await until(async () => (await s.port.read(s.input.runId)).meta?.command_leader);
    await s.control.cancel(s.input.runId, 0);
    await running;
    const snap = await s.port.read(s.input.runId);
    assert.equal(snap.slotHeld, true);
    assert.equal(snap.events.filter((e) => e.kind === 'cancel.step').length, 0);
    assert.ok(snap.events.some((e) => e.kind === 'cancel.unconfirmed'));
  } finally {
    await running?.catch(() => {});
    s.cleanup();
  }
});
test('orphan policy reacts to verified physical parent death, while continue preserves the run', async () => {
  for (const policy of ['continue', 'stop'] as const) {
    const parent = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' }),
      parentDone = new Promise((r) => parent.once('exit', r));
    const parentStamp = await until(() => readProcess(parent.pid!)?.stamp);
    const s = setup(
      [
        process.execPath,
        '-e',
        `process.on('SIGINT',()=>process.exit(0));process.stdout.write('ready');setTimeout(()=>{},60000)`,
      ],
      { orphanPolicy: policy }
    );
    let running: Promise<void> | undefined;
    try {
      running = s.control.start({ input: s.input, ticket: s.ticket });
      await until(() => {
        try {
          return s.control.logs(s.input.runId, 'stdout').data.toString() === 'ready';
        } catch {
          return false;
        }
      });
      parent.kill('SIGTERM');
      await parentDone;
      assert.equal(processState(parentStamp), 'dead');
      const supervisor = (await s.port.read(s.input.runId)).run.supervisor!;
      await s.control.parentOffline(s.input.runId, { contextId: 'synthetic-parent', generation: 1 }, supervisor);
      if (policy === 'continue') {
        assert.equal((await s.port.read(s.input.runId)).run.cancelRequestedAt, null);
        await s.control.cancel(s.input.runId, 0);
      }
      await running;
      const snap = await s.port.read(s.input.runId);
      assert.equal(snap.events.filter((e) => e.kind === 'parent.offline').length, 1);
      assert.equal(snap.slotHeld, false);
    } finally {
      parent.kill('SIGKILL');
      await parentDone;
      await running?.catch(() => {});
      s.cleanup();
    }
  }
});

test('cancel escalates INT then TERM then KILL; lost KILL wait remains unknown without complete scope proof', async () => {
  const s = setup([
    process.execPath,
    '-e',
    `process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});process.stdout.write('ready');setTimeout(()=>{},60000)`,
  ]);
  let running: Promise<void> | undefined;
  try {
    running = s.control.start({ input: s.input, ticket: s.ticket });
    await until(() => {
      try {
        return s.control.logs(s.input.runId, 'stdout').data.toString() === 'ready';
      } catch {
        return false;
      }
    });
    await s.control.cancel(s.input.runId, 0);
    await running;
    const p = await s.port.read(s.input.runId);
    assert.deepEqual(
      p.events.filter((e) => e.kind === 'cancel.step').map((e) => e.payload.signal),
      ['SIGINT', 'SIGTERM', 'SIGKILL']
    );
    assert.equal(p.receipt?.native_exit ?? null, null);
    if (!p.receipt) assert.equal(p.slotHeld, true);
  } finally {
    await running?.catch(() => {});
    s.cleanup();
  }
});

test('cancel accepted after submitting and before scope fixation wakes once discovery finishes', async () => {
  const s = setup([
    process.execPath,
    '-e',
    `process.on('SIGINT',()=>process.exit(0));process.stdout.write('executed');setTimeout(()=>process.exit(0),1000)`,
  ]);
  const original = s.port.phase.bind(s.port);
  s.port.phase = async (id, stamp, phase) => {
    await original(id, stamp, phase);
    if (phase === 'submitting') await s.control.cancel(id, 0);
  };
  try {
    await s.control.start({ input: s.input, ticket: s.ticket });
    const p = await s.port.read(s.input.runId);
    assert.ok(p.events.some((e) => e.kind === 'cancel.step'));
    assert.equal(p.slotHeld, false);
    assert.equal(p.events.filter((e) => e.kind === 'cancel.accepted').length, 1);
  } finally {
    s.cleanup();
  }
});

test('heartbeat wall/monotonic disagreement records one anomaly and stays uncertain', async () => {
  const s = setup([
    process.execPath,
    '-e',
    `process.on('SIGINT',()=>process.exit(0));process.stdout.write('ready');setTimeout(()=>process.exit(0),12000)`,
  ]);
  let running: Promise<void> | undefined;
  const now = Date.now;
  try {
    running = s.control.start({ input: s.input, ticket: s.ticket });
    await until(() => {
      try {
        return s.control.logs(s.input.runId, 'stdout').data.toString() === 'ready';
      } catch {
        return false;
      }
    });
    Date.now = () => now() - 2000;
    await until(async () => (await s.port.read(s.input.runId)).events.some((e) => e.kind === 'clock.anomaly'), 7000);
    const status = await s.control.reconcile(s.input.runId);
    assert.equal(status.currentRun?.state, 'uncertain');
    assert.equal(status.reconciliation?.cause, 'clock_anomaly');
    assert.equal((await s.port.read(s.input.runId)).events.filter((e) => e.kind === 'clock.anomaly').length, 1);
    Date.now = now;
    await s.control.cancel(s.input.runId, 0);
    await running;
  } finally {
    Date.now = now;
    await running?.catch(() => {});
    s.cleanup();
  }
});

test('historical PGID/SID reuse simulation never makes unrelated new workload an old-scope conflict', async () => {
  const old = setup([process.execPath, '-e', 'setTimeout(()=>process.exit(0),100)']),
    fresh = setup([process.execPath, '-e', 'setTimeout(()=>process.exit(0),1000)']);
  let active: Promise<void> | undefined;
  try {
    await old.control.start({ input: old.input, ticket: old.ticket });
    active = fresh.control.start({ input: fresh.input, ticket: fresh.ticket });
    const current = await until(async () => (await fresh.port.read(fresh.input.runId)).meta?.scope);
    // Real new group; only historical registration start tick is simulated.
    const historical = { ...current, group_leader: { ...current.group_leader, proc_start: '0' } };
    old.seed.snapshot.run.scopeRef = historical;
    old.seed.snapshot.meta!.scope = historical;
    const status = await old.control.reconcile(old.input.runId);
    assert.equal(status.currentRun?.state, 'ended');
    assert.equal(status.reconciliation, null);
    assert.equal((await old.port.read(old.input.runId)).slotHeld, false);
    const snap = await old.port.read(old.input.runId);
    await old.port.reconcile(
      old.input.runId,
      snap.revision,
      [
        {
          evidenceId: 'synthetic-confirmed-conflict',
          runId: snap.run.runId,
          sourceId: snap.run.sourceId,
          bindingGeneration: snap.run.expectedGeneration,
          supervisor: snap.run.supervisor,
          validation: 'accepted',
          asOf: Date.now(),
          observedAt: Date.now(),
          fact: { kind: 'conflict', cause: 'scope_conflict' },
        },
      ],
      Date.now()
    );
    assert.equal(
      (await old.port.read(old.input.runId)).slotHeld,
      false,
      'terminal conflict blocks operations without reacquiring released slot'
    );
  } finally {
    await active?.catch(() => {});
    old.cleanup();
    fresh.cleanup();
  }
});

for (const point of ['submitted_before_scope', 'cancel_before_ack_commit'])
  test(`real supervisor SIGKILL at ${point} never resubmits or replays signals`, { skip: cliSkip }, async () => {
    const home = mkdtempSync(join(tmpdir(), 'hud-run-cut-')),
      ownedFile = join(home, 'owned.json');
    const code = `require('node:fs').writeFileSync(${JSON.stringify(ownedFile)},JSON.stringify({command:process.pid,helper:process.ppid}));process.on('SIGINT',()=>process.stdout.write('INT'));process.stdout.write('one');setTimeout(()=>process.exit(0),12000);`;
    const data = seedRun(home, [process.execPath, '-e', code]);
    writeFileSync(join(home, 'facts.json'), JSON.stringify(data.seed), { mode: 0o600 });
    const env = {
      ...process.env,
      HUD_HOME: home,
      HUD_RUN_PORT_MODULE: resolve('tests/run/crash-port.mjs'),
      HUD_RUN_TEST_CUT: point,
    };
    const child = spawn(process.execPath, ['bin/hud-run', 'start'], {
      cwd: resolve('.'),
      env,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let errors = '';
    child.stderr.on('data', (x) => (errors += x));
    const done = new Promise((r) => child.once('exit', r));
    child.stdin.end(JSON.stringify({ input: data.input, ticket: data.ticket }));
    let owned: ProcessStamp[] = [];
    try {
      const ids = await until(() => {
        try {
          return JSON.parse(readFileSync(ownedFile, 'utf8'));
        } catch {
          return null;
        }
      });
      owned = [readProcess(ids.command)!.stamp, readProcess(ids.helper)!.stamp];
      if (point === 'cancel_before_ack_commit') {
        await until(() => RunArtifacts.open(home, data.input.runId).readLog('stdout', 0).data.toString() === 'one');
        await until(() => JSON.parse(readFileSync(join(home, 'facts.json'), 'utf8')).snapshot.run.state === 'running');
        const cancel = spawn(process.execPath, ['bin/hud-run', 'cancel', data.input.runId, '--grace', '0'], {
          cwd: resolve('.'),
          env,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let cancelErrors = '';
        cancel.stderr.on('data', (x) => (cancelErrors += x));
        assert.equal(await new Promise((r) => cancel.once('exit', r)), 0, cancelErrors);
      }
      await until(() => existsSync(join(home, 'cut.json')), 8000);
      child.kill('SIGKILL');
      await done;
      const port = new FileRunFactPort(join(home, 'facts.json')),
        control = new HeadlessRunControl(port, home, local),
        before = await port.read(data.input.runId);
      if (point === 'submitted_before_scope') assert.equal(before.meta, null);
      else assert.equal(before.events.filter((e) => e.kind === 'cancel.step').length, 0);
      const status = await control.reconcile(data.input.runId);
      assert.equal(status.currentRun?.state, 'uncertain', errors);
      assert.equal((await port.read(data.input.runId)).slotHeld, true);
      assert.equal(existsSync(join(home, 'runs', data.input.runId, 'exit.json')), false);
      await control.reconcile(data.input.runId);
      const bytes = RunArtifacts.open(home, data.input.runId).readLog('stdout', 0).data.toString();
      assert.equal(bytes, point === 'submitted_before_scope' ? 'one' : 'oneINT');
      assert.equal((await port.read(data.input.runId)).events.filter((e) => e.kind === 'cancel.step').length, 0);
    } finally {
      child.kill('SIGKILL');
      await done;
      for (const stamp of owned)
        if (processState(stamp) === 'alive') {
          try {
            process.kill(stamp.pid, 'SIGKILL');
          } catch {}
        }
      rmSync(home, { recursive: true, force: true });
    }
  });

test('argv wrapper honors independent harness discovery and never uses launcher wait as native exit', async () => {
  const s = setup([]),
    marker = join(s.home, 'argv-harness.pid');
  const child = `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setTimeout(()=>process.exit(0),200);`;
  const wrapper = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});c.on('exit',()=>process.exit(137));`;
  s.input.launch = { argv: [process.execPath, '-e', wrapper] };
  s.seed.snapshot.run.launchDigest = (await import('../../src/core/run/control.js')).launchDigest(s.input);
  try {
    await s.control.start({
      input: s.input,
      ticket: s.ticket,
      identifyHarness: async () =>
        until(() => {
          try {
            return readProcess(Number(readFileSync(marker, 'utf8')))?.stamp ?? null;
          } catch {
            return null;
          }
        }),
    });
    const r = RunArtifacts.open(s.home, s.input.runId).readExit();
    assert.ok(r);
    assert.notEqual(r.harness?.pid, r.command_leader?.pid);
    assert.equal(r.native_exit, null);
    assert.equal(r.reason, 'scope_ended');
    assert.equal((await s.control.status(s.input.runId)).currentRun?.exitCode, null);
  } finally {
    s.cleanup();
  }
});
