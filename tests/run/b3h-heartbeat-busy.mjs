// Isolated real-process/SQLite acceptance. Build production and test outputs first.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { realRun, until } from '../int/b6-real.mjs';
import { fixture } from '../int/fixture.mjs';
import { processState } from '../../dist-test/src/core/run/process.js';
import { heartbeatQuality } from '../../dist-test/src/core/execution.js';
import { HeadlessRunControl } from '../../dist-test/src/core/run/control.js';
import { PrivateLedgerGate } from '../../dist-test/src/ledger/local-manager.js';

async function locker(home) {
  const child = fork('tests/run/b3h-heartbeat-lock.mjs', [join(home, 'ledger.sqlite')], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  const done = once(child, 'exit');
  const messages = [];
  child.on('message', (message) => messages.push(message));
  const next = (type) =>
    until(() => {
      const failure = messages.find((message) => message.type === 'failed');
      if (failure) throw new Error(failure.message);
      const index = messages.findIndex((message) => message.type === type);
      if (index >= 0) return messages.splice(index, 1)[0];
      assert.equal(child.exitCode, null, stderr);
      return false;
    });
  const result = {
    async hold(durationMs) {
      child.send({ type: 'hold', durationMs });
      await next('locked');
      return { released: next('released') };
    },
    async close() {
      if (child.connected) child.send({ type: 'close' });
      else if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await done;
    },
  };
  try {
    await next('ready');
    return result;
  } catch (error) {
    child.kill('SIGKILL');
    await done;
    throw error;
  }
}

const terminal = (state) => ['ended', 'cancelled'].includes(state);

test('seven externally locked heartbeat boundaries retain stale evidence then recover durable cancel', async () => {
  const f = await realRun('setTimeout(()=>{},120000)');
  let lock;
  let stderr = '';
  f.child.stderr.on('data', (data) => {
    stderr += data;
  });
  try {
    const ready = await f.ready();
    lock = await locker(f.home);
    const before = await until(async () => {
      const s = await f.port.read(f.input.runId);
      return s.run.heartbeatSeq >= 2 && s;
    });
    const original = { seq: before.run.heartbeatSeq, at: before.run.heartbeatAt, mono: before.run.heartbeatMonoMs };
    for (let miss = 1; miss <= 7; miss++) {
      await sleep(Math.max(0, original.at + miss * 5000 - 250 - Date.now()));
      const held = await lock.hold(500);
      await held.released;
      const snapshot = await f.port.read(f.input.runId);
      assert.deepEqual(
        { seq: snapshot.run.heartbeatSeq, at: snapshot.run.heartbeatAt, mono: snapshot.run.heartbeatMonoMs },
        original
      );
      assert.equal(snapshot.slotHeld, true);
      assert.equal(snapshot.receipt, null);
      assert.equal(snapshot.run.state, 'running');
      assert.equal(snapshot.events.length, before.events.length);
      assert.deepEqual(snapshot.facts, before.facts);
      assert.equal(processState(ready.meta.harness), 'alive');
    }
    assert.equal(heartbeatQuality(original.at, Date.now()), 'stale');
    assert.match(stderr, /ledger_busy/);
    assert.equal((stderr.match(/ledger_busy/g) ?? []).length, 1, 'one diagnostic per consecutive busy episode');
    const accepted = await f.service.cancel(f.input.runId, 0, f.authority);
    assert.equal(accepted.accepted, true);
    const after = await until(async () => {
      const s = await f.port.read(f.input.runId);
      return terminal(s.run.state) && s;
    }, 15000);
    assert.ok(after.run.heartbeatSeq > original.seq);
    assert.ok(after.events.some((event) => event.kind === 'cancel.step'));
    assert.equal(after.events.filter((event) => event.kind === 'cancel.accepted').length, 1);
    assert.equal(after.events.filter((event) => event.kind === 'launch.submitting').length, 1);
    assert.equal(after.slotHeld, false);
    assert.equal((await f.done).code, 0);
  } finally {
    await lock?.close();
    await f.cleanup();
  }
});

for (const fence of ['sequence', 'instance'])
  test(`real ${fence} fence loss stops subsequent heartbeat and cancellation delivery`, async () => {
    const f = await realRun('setTimeout(()=>{},60000)');
    try {
      const ready = await f.ready();
      await f.ledger.transaction((tx) => {
        if (fence === 'sequence') tx.run('UPDATE runs SET heartbeat_seq=heartbeat_seq+1 WHERE run_id=?', f.input.runId);
        else {
          const oldStart = String(BigInt(ready.run.supervisor.proc_start) - 1n);
          tx.run('UPDATE runs SET supervisor_proc_start=? WHERE run_id=?', oldStart, f.input.runId);
          tx.run('UPDATE claims SET supervisor_proc_start=? WHERE run_id=?', oldStart, f.input.runId);
          tx.run(
            "UPDATE events SET payload=json_set(payload,'$.supervisor.proc_start',?) WHERE run_id=? AND kind='supervisor.registered'",
            oldStart,
            f.input.runId
          );
        }
      });
      const fenced = await f.port.read(f.input.runId);
      await sleep(5500);
      await f.service.cancel(f.input.runId, 0, f.authority);
      await sleep(5500);
      const after = await f.port.read(f.input.runId);
      assert.equal(after.run.heartbeatSeq, fenced.run.heartbeatSeq);
      assert.equal(after.run.heartbeatAt, fenced.run.heartbeatAt);
      assert.equal(
        after.events.some((event) => event.kind === 'cancel.step'),
        false
      );
      assert.equal(processState(ready.meta.supervisor), 'alive');
      assert.equal(processState(ready.meta.harness), 'alive');
      assert.equal(after.slotHeld, true);
      assert.equal(after.receipt, null);
    } finally {
      await f.cleanup();
    }
  });

test('bounded busy at final import preserves the immutable receipt for explicit recovery', async () => {
  const f = await fixture([process.execPath, '-e', 'setTimeout(()=>process.exit(0),1000)']);
  let lock;
  try {
    // Explicit trusted test port; the actual SQLite import and writer gates stay real.
    // cli() intentionally strips adapters; start this instance through its protected test driver.
    const child = spawn(process.execPath, ['bin/hud-run', 'start'], {
      env: {
        ...process.env,
        HUD_HOME: f.home,
        HUD_RUN_PORT_MODULE: resolve('tests/run/b3h-heartbeat-terminal-port.mjs'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.resume();
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const done = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    f.processes.push({ child, done });
    child.stdin.end(JSON.stringify({ input: f.input, ticket: f.ticket }));
    lock = await locker(f.home);
    await until(() => existsSync(join(f.home, 'heartbeat-import-ready')));
    const path = join(f.home, 'runs', f.input.runId, 'exit.json');
    const receipt = readFileSync(path);
    const before = await f.port.read(f.input.runId);
    const held = await lock.hold(250);
    writeFileSync(join(f.home, 'heartbeat-import-go'), '', { mode: 0o600 });
    assert.equal((await done).code, 1);
    assert.match(stderr, /write-lock budget/);
    await held.released;
    const unimported = await f.port.read(f.input.runId);
    assert.equal(unimported.run.heartbeatSeq, before.run.heartbeatSeq);
    assert.equal(unimported.run.heartbeatAt, before.run.heartbeatAt);
    assert.equal(unimported.slotHeld, true);
    assert.equal(unimported.receipt, null);
    assert.equal(
      unimported.events.some((event) => event.kind === 'run.terminal'),
      false
    );
    assert.deepEqual(readFileSync(path), receipt);
    const recovery = new HeadlessRunControl(f.port, f.home, new PrivateLedgerGate(f.home).actor());
    const status = await recovery.reconcile(f.input.runId);
    assert.equal(status.currentRun.state, 'ended');
    const after = await f.port.read(f.input.runId);
    assert.equal(after.slotHeld, false);
    assert.equal(after.events.filter((event) => event.kind === 'exit.receipt').length, 1);
    assert.deepEqual(readFileSync(path), receipt);
    await recovery.reconcile(f.input.runId);
    const again = await f.port.read(f.input.runId);
    assert.equal(again.events.filter((event) => event.kind === 'exit.receipt').length, 1);
    assert.equal(
      again.events.filter((event) => event.kind === 'run.terminal').length,
      after.events.filter((event) => event.kind === 'run.terminal').length
    );
    assert.deepEqual(readFileSync(path), receipt);
  } finally {
    await lock?.close();
    await f.cleanup();
  }
});

test('in-flight real heartbeat busy does not suppress a concurrent real group exit and final receipt', async () => {
  const f = await fixture([
    process.execPath,
    '-e',
    "const fs=require('fs');setInterval(()=>{if(fs.existsSync('end-go'))process.exit(0)},20)",
  ]);
  let lock;
  try {
    const child = spawn(process.execPath, ['tests/run/b3h-heartbeat-overlap.mjs'], {
      env: { ...process.env, HUD_HOME: f.home },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const done = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    f.processes.push({ child, done });
    child.stdin.end(JSON.stringify({ input: f.input, ticket: f.ticket }));
    await until(async () => (await f.port.read(f.input.runId)).run.state === 'running');
    lock = await locker(f.home);
    const before = await until(async () => {
      const s = await f.port.read(f.input.runId);
      return s.run.heartbeatSeq >= 2 && s;
    });
    await sleep(Math.max(0, before.run.heartbeatAt + 4750 - Date.now()));
    const held = await lock.hold(500);
    await until(() => existsSync(join(f.home, 'heartbeat-busy-held')));
    await held.released;
    writeFileSync(join(f.home, 'end-go'), '', { mode: 0o600 });
    await until(() => existsSync(join(f.home, 'group-waited')));
    assert.equal(processState(before.meta.harness), 'dead');
    writeFileSync(join(f.home, 'release-busy'), '', { mode: 0o600 });
    await until(() => existsSync(join(f.home, 'busy-delivered')));
    writeFileSync(join(f.home, 'release-wait'), '', { mode: 0o600 });
    assert.equal((await done).code, 0, stderr);
    assert.match(stderr, /ledger_busy/);
    const after = await f.port.read(f.input.runId);
    assert.equal(after.run.state, 'ended');
    assert.equal(after.slotHeld, false);
    assert.equal(after.run.heartbeatSeq, before.run.heartbeatSeq);
    assert.equal(after.run.heartbeatAt, before.run.heartbeatAt);
    assert.equal(after.receipt.reason, 'scope_ended');
    assert.equal(after.receipt.native_exit, null);
    assert.equal(after.events.filter((event) => event.kind === 'exit.receipt').length, 1);
    assert.equal(after.events.filter((event) => event.kind === 'launch.submitting').length, 1);
  } finally {
    for (const name of ['end-go', 'release-busy', 'release-wait'])
      writeFileSync(join(f.home, name), '', { mode: 0o600 });
    await lock?.close();
    await f.cleanup();
  }
});
