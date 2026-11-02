import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { delegationBenchmarkFixture } from '../../dist-test/tests/unit/b45-delegation-fixture.js';
import { WakeDrainer } from '../../dist-test/packages/hud-mcp/src/wake-drainer.js';
import { WakeAdapters } from '../../dist-test/src/core/wake/adapters.js';
import { recordWakeRegistered } from '../../dist-test/src/ledger/notify-events.js';
import { sessionOwnerKey } from '../../dist-test/src/core/identity.js';
const f = await delegationBenchmarkFixture();
const source = f.source(); // Stable synthetic identity; competing writers change only events.
const executable = join(f.root, 'codex-slow.cjs');
writeFileSync(
  executable,
  `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(join(f.root, 'slow-pids'))},process.pid+'\\n');setTimeout(()=>{},10000);`
);
chmodSync(executable, 0o700);
await f.ledger.transaction((tx) => {
  recordWakeRegistered(
    tx,
    'link-a',
    {
      adapter: 'codex_queue_v1',
      adapterVersion: 1,
      ownerKey: sessionOwnerKey(f.parent.ref),
      contextGeneration: 1,
      parentRef: f.parent.ref,
      parentStamp: null,
      target: { codexHome: f.root, threadId: f.parent.ref.sessionId },
    },
    Date.now()
  );
  tx.run(
    "INSERT INTO events(link_id,run_id,kind,payload,at)VALUES('link-a','run-a','run.state','{\"state\":\"uncertain\"}',?)",
    Date.now()
  );
});
const d = new WakeDrainer({
  ledger: f.ledger,
  home: f.root,
  processKey: f.parent.authority.evidence.processKey,
  recoveryMs: 100,
  adapters: new WakeAdapters({ codexExecutable: executable }),
});
const writers = [];
const done = [];
const writerRates = [];
const samples = { status: { success: [], busy: [], refusal: [] }, spawn: { success: [], busy: [], refusal: [] } };
function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? null;
  return { n: s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s.at(-1) ?? null };
}
try {
  for (let i = 0; i < 4; i++) {
    const child = spawn(
      process.execPath,
      [resolve('tests/int/b19-writer.mjs'), join(f.root, 'ledger.sqlite'), '3000'],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
    );
    writers.push(child);
    let errors = '';
    child.stderr.on('data', (data) => (errors += data));
    const finished = new Promise((resolve, reject) =>
      child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(errors))))
    );
    void finished.catch(() => {});
    done.push(finished);
    const [ready] = await once(child, 'message');
    assert.equal(ready.ready, true);
    child.on('message', (value) => {
      if (value.committed !== undefined) writerRates.push(value);
    });
  }
  const deadline = Date.now() + 4000;
  while (true) {
    try {
      if (readFileSync(join(f.root, 'slow-pids'), 'utf8').trim()) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('slow adapter did not start');
    await delay(5);
  }
  const args = { ...f.spawnArgs, request_key: 'b19-perf-fixed' };
  await f.service.invoke(source, 'delegate_spawn', args);
  for (const child of writers) child.send('go');
  const slowPid = Number(readFileSync(join(f.root, 'slow-pids'), 'utf8').trim().split('\n')[0]);
  const duringSlow = { status: [], spawn: [] };
  for (let i = 0; i < 1050; i++)
    for (const [tool, name, input] of [
      ['delegate_status', 'status', { runId: 'run-a' }],
      ['delegate_spawn', 'spawn', args],
    ]) {
      let helperAlive = false;
      try {
        process.kill(slowPid, 0);
        helperAlive = true;
      } catch {}
      d.parentCall();
      const start = performance.now();
      let category = 'success';
      try {
        const value = await f.service.invoke(source, tool, input);
        if (value?.ok === false) category = 'refusal';
      } catch (error) {
        category = error?.code === 'ledger_busy' || error?.message === 'busy' ? 'busy' : 'refusal';
      }
      const elapsed = performance.now() - start;
      if (i >= 50) samples[name][category].push(elapsed);
      if (i >= 50 && helperAlive) duringSlow[name].push(elapsed);
      if (i % 10 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
  for (const child of writers) if (child.connected) child.send('stop');
  await Promise.all(done);
  const result = {
    node: process.versions.node,
    sqlite: process.versions.sqlite,
    writers: 4,
    writerOperation:
      'one synthetic.progress row per short transaction, followed by1ms delay; actual rates include lock contention',
    writerRates,
    samples: Object.fromEntries(
      Object.entries(samples).map(([tool, groups]) => [
        tool,
        Object.fromEntries(Object.entries(groups).map(([kind, values]) => [kind, stats(values)])),
      ])
    ),
    drainer: d.metrics,
    duringSlow: Object.fromEntries(Object.entries(duringSlow).map(([tool, values]) => [tool, stats(values)])),
  };
  console.log(JSON.stringify(result, null, 2));
  for (const groups of Object.values(samples))
    for (const values of Object.values(groups))
      if (values.length) assert.ok(stats(values).p95 < 50, JSON.stringify(stats(values)));
} finally {
  for (const child of writers)
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  await d.close();
  await f.service.close();
  await f.close();
}
