import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { realRun, until } from './b6-real.mjs';
import { readProcess, processState } from '../../dist-test/src/core/run/process.js';
import { delegationBenchmarkFixture } from '../../dist-test/tests/unit/b45-delegation-fixture.js';
import { LedgerRunFactPort } from '../../dist-test/src/core/run/ledger-port.js';
import { HeadlessRunControl } from '../../dist-test/src/core/run/control.js';
import { PrivateLedgerGate } from '../../dist-test/src/ledger/local-manager.js';
import { PARENT_LIVENESS_INTERVAL_MS } from '../../dist/cli/run-wait.js';

function child(home, args, entry = resolve('bin/hud'), ipc = false) {
  const processChild = spawn(process.execPath, [entry, ...args], {
    cwd: resolve('.'),
    env: { PATH: '/usr/bin:/bin', HOME: home, HUD_HOME: home },
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  processChild.stdout.on('data', (data) => (stdout += data));
  processChild.stderr.on('data', (data) => (stderr += data));
  const done = new Promise((resolve) =>
    processChild.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  );
  return { child: processChild, done };
}
function ledgerOpened(pid, home) {
  try {
    return readdirSync(`/proc/${pid}/fd`).some((fd) => {
      try {
        return readlinkSync(`/proc/${pid}/fd/${fd}`) === join(home, 'ledger.sqlite');
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

if (process.argv[2] !== '--resume-only') {
  const f = await realRun('setTimeout(()=>{},90000)');
  let background;
  try {
    mkdirSync(join(f.home, 'hints'), { mode: 0o700 });
    const ready = await f.ready();
    const id = f.input.runId;
    const invoke = async (args) => {
      const p = child(f.home, args);
      f.processes.push(p);
      return p.done;
    };
    const before = f.ledger.snapshot((tx) => Number(tx.get('SELECT max(seq) AS n FROM events').n));
    const status = await invoke(['run', 'status', id, '--json']);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).currentRun.state, 'running');
    const deadline = await invoke(['run', 'wait', id, '--after-seq', String(before), '--timeout-ms', '100', '--json']);
    assert.equal(deadline.code, 0, deadline.stderr);
    assert.equal(JSON.parse(deadline.stdout).timedOut, true);
    assert.equal(
      f.ledger.snapshot((tx) => Number(tx.get('SELECT max(seq) AS n FROM events').n)),
      before
    );
    const waiter = child(f.home, ['run', 'wait', id, '--after-seq', String(before), '--timeout-ms', '120000']);
    f.processes.push(waiter);
    await until(() => ledgerOpened(waiter.child.pid, f.home));
    waiter.child.kill('SIGTERM');
    const stopped = await waiter.done;
    assert.equal(stopped.code, 143, JSON.stringify(stopped));
    assert.match(stopped.stderr, /terminated/);
    assert.equal(processState(ready.meta.harness), 'alive');
    const parent = child(f.home, [f.home, id], resolve('tests/int/b11-parent.mjs'), true);
    f.processes.push(parent);
    const [message] = await once(parent.child, 'message');
    background = await until(() => {
      const error = readFileSync(join(f.home, 'wait.stderr'), 'utf8');
      if (/orphaned|failure|invalid/.test(error)) throw new Error('background waiter startup: ' + error);
      return ledgerOpened(message.pid, f.home) && readProcess(message.pid)?.stamp;
    });
    const started = Date.now();
    parent.child.kill('SIGKILL');
    await parent.done;
    await until(() => processState(background) !== 'alive', 31_000);
    const orphanMs = Date.now() - started;
    assert.ok(orphanMs <= 30_000, `orphan exit took ${orphanMs} ms`);
    assert.ok(
      orphanMs <= PARENT_LIVENESS_INTERVAL_MS + 3000,
      `orphan exit exceeded liveness interval headroom: ${orphanMs} ms`
    );
    assert.match(readFileSync(join(f.home, 'wait.stderr'), 'utf8'), /orphaned/);
    const cancel = await invoke(['run', 'cancel', id, '--grace', '0', '--json']);
    assert.equal(cancel.code, 0, cancel.stderr);
    await until(async () => ['cancelled', 'ended'].includes((await f.port.read(id)).run.state), 15_000);
    await f.done;
    assert.notEqual(processState(ready.meta.harness), 'alive');
    console.log(
      JSON.stringify({
        scenario: 'real hud-run status/deadline/SIGTERM/detached orphan/cancel',
        orphanMs,
        parentLivenessIntervalMs: PARENT_LIVENESS_INTERVAL_MS,
        result: 'passed',
        claudeSession: 'not used; run_in_background process contract simulated',
      })
    );
  } finally {
    if (background && processState(background) === 'alive') {
      try {
        process.kill(background.pid, 'SIGKILL');
      } catch {}
      await until(() => processState(background) !== 'alive');
    }
    await f.cleanup();
  }
}

const resume = await delegationBenchmarkFixture();
const owned = [];
let runId;
try {
  await resume.bindAndEnd();
  const workload = join(resume.root, 'synthetic-codex.mjs');
  writeFileSync(
    workload,
    'import {appendFileSync} from "node:fs";appendFileSync(process.env.CODEX_HOME+"/dispatch-count","one\\n");process.stdin.resume();setTimeout(()=>process.exit(0),5000);'
  );
  const binary = join(resume.root, 'synthetic-codex');
  writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath}' '${workload}' "$@"\n`, { mode: 0o700 });
  const profile = {
    ...resume.service.options.config.profiles[0],
    headless: { argv: [binary, 'exec', '-'] },
    resumeHeadless: { argv: [binary, 'exec', 'resume', '{{sessionId}}', '-'] },
  };
  writeFileSync(join(resume.root, 'delegate.json'), JSON.stringify({ version: 1, profiles: [profile] }), {
    mode: 0o600,
  });
  const launcher = child(resume.root, [resume.root, 'hold'], resolve('tests/int/b11-resume.mjs'));
  owned.push(launcher);
  await until(() => existsSync(join(resume.root, 'dispatched')));
  launcher.child.kill('SIGKILL');
  await launcher.done;
  const rows = resume.ledger.snapshot((tx) => tx.all("SELECT run_id FROM runs WHERE run_seq=2 AND link_id='link-a'"));
  assert.equal(rows.length, 1);
  runId = rows[0].run_id;
  const gate = new PrivateLedgerGate(resume.root);
  const port = new LedgerRunFactPort(resume.ledger, gate);
  const running = await until(async () => {
    const snapshot = await port.read(runId);
    if (snapshot.run.supervisor && processState(snapshot.run.supervisor) === 'dead')
      throw new Error(
        JSON.stringify({
          phase: snapshot.run.launchPhase,
          state: snapshot.run.state,
          kinds: snapshot.events.map((e) => e.kind),
          hasMeta: !!snapshot.meta,
          dispatchCount: existsSync(join(resume.root, 'dispatch-count')),
          diagnostic: existsSync(join(resume.root, 'supervisor.stderr'))
            ? readFileSync(join(resume.root, 'supervisor.stderr'), 'utf8')
            : null,
        })
      );
    return snapshot.meta?.scope && snapshot;
  });
  const replay = child(resume.root, [resume.root], resolve('tests/int/b11-resume.mjs'));
  owned.push(replay);
  const result = await replay.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).runId, runId);
  await until(async () => ['ended', 'failed'].includes((await port.read(runId)).run.state), 15_000);
  assert.equal(readFileSync(join(resume.root, 'dispatch-count'), 'utf8'), 'one\n');
  assert.notEqual(processState(running.meta.harness), 'alive');
  await until(() => processState(running.meta.supervisor) !== 'alive');
  assert.equal(
    resume.ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM slots WHERE run_id=?', runId).n),
    0
  );
  console.log(
    JSON.stringify({
      scenario: 'B4 local resume real hud-run; launcher SIGKILL after private dispatch; replay',
      dispatches: 1,
      result: 'passed',
    })
  );
} finally {
  if (runId) {
    try {
      const gate = new PrivateLedgerGate(resume.root);
      await new HeadlessRunControl(new LedgerRunFactPort(resume.ledger, gate), resume.root, gate.actor()).cancel(
        runId,
        0
      );
    } catch {}
  }
  for (const p of owned) {
    if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill('SIGKILL');
    await p.done;
  }
  await resume.close();
}
