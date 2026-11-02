// Synthetic dispatch-unknown timing coverage. The model-facing launch response is
// deliberately not awaited; the single original ticket is sent once to a real,
// gated hud-run process. No paid harness, ticket reissue or dispatch retry occurs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { fixture } from './fixture.mjs';
import { ledgerRuntimeSupported } from '../../dist-test/src/ledger/runtime.js';
import { HeadlessRunControl } from '../../dist-test/src/core/run/control.js';
import { readProcess, processState } from '../../dist-test/src/core/run/process.js';
import { RUN_NODE_FLAGS } from '../../dist-test/src/core/run/runtime.js';
import { sameProcessStamp } from '../../dist-test/src/core/supervision.js';
import { PrivateLedgerGate } from '../../dist-test/src/ledger/local-manager.js';
import { commitReconcile, readReconcileSnapshot } from '../../dist-test/src/ledger/reconcile.js';

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`B45 ${label} deadline exceeded`)), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

if (!ledgerRuntimeSupported()) {
  process.stdout.write('SKIP B45 dispatch unknown requires Node 22 >=22.13 or >=24\n');
} else if (process.argv[2] === '--delayed-supervisor') {
  // IPC is a deterministic fixture gate before the real CLI reads its sole
  // protected stdin delivery. It grants no execution rights and carries no ticket.
  const release = once(process, 'message');
  process.send({ ready: true });
  const [message] = await release;
  assert.equal(message, 'release-original-dispatch');
  process.disconnect();
  const { main } = await import('../../dist-test/src/core/run/cli.js');
  await main(['start']);
} else {
  const f = await fixture([
    process.execPath,
    '-e',
    "require('fs').appendFileSync('submissions','one\\n');setTimeout(()=>{},200)",
  ]);
  try {
    const environment = { ...process.env, HUD_HOME: f.home };
    delete environment.HUD_RUN_PORT_MODULE;
    const child = spawn(process.execPath, [...RUN_NODE_FLAGS, fileURLToPath(import.meta.url), '--delayed-supervisor'], {
      cwd: resolve('.'),
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (bytes) => (stdout += bytes));
    child.stderr.on('data', (bytes) => (stderr += bytes));
    const done = new Promise((finished, reject) => {
      child.once('exit', (code, signal) => finished({ code, signal, stdout, stderr }));
      child.once('error', reject);
    });
    f.processes.push({ child, done });
    const ready = once(child, 'message');
    // Exactly one transport delivery of the original accepted execution ticket.
    child.stdin.end(JSON.stringify({ input: f.input, ticket: f.ticket }));
    const [message] = await bounded(
      Promise.race([
        ready,
        done.then(() => {
          throw new Error('supervisor exited before gate');
        }),
      ]),
      'delayed supervisor gate'
    );
    assert.equal(message.ready, true);
    const delayedStamp = readProcess(child.pid)?.stamp;
    assert.ok(delayedStamp);
    const initial = await f.port.read(f.input.runId);
    assert.equal(initial.run.state, 'starting');
    assert.equal(initial.run.launchPhase, 'reserved');
    assert.equal(initial.run.supervisor, null);
    assert.equal(initial.slotHeld, true);
    const ticketHash = initial.run.launchTokenHash;
    const control = new HeadlessRunControl(f.port, f.home, new PrivateLedgerGate(f.home).actor());
    assert.equal((await control.reconcile(f.input.runId)).currentRun.state, 'starting');
    assert.equal(
      (await f.port.read(f.input.runId)).events.some((event) => event.kind === 'supervisor.registered'),
      false
    );
    assert.ok(sameProcessStamp(readProcess(child.pid)?.stamp ?? null, delayedStamp));
    child.send('release-original-dispatch');
    const result = await bounded(done, 'original supervisor completion');
    assert.equal(result.code, 0, result.stderr);
    const completed = await f.port.read(f.input.runId);
    assert.equal(completed.run.state, 'ended');
    assert.equal(completed.slotHeld, false);
    assert.equal(completed.run.launchTokenHash, ticketHash);
    assert.equal(completed.events.filter((event) => event.kind === 'supervisor.registered').length, 1);
    assert.equal(completed.events.filter((event) => event.kind === 'launch.submitting').length, 1);
    assert.ok(completed.run.startedAt - completed.run.createdAt <= 30000);
    assert.equal(readFileSync(join(f.home, 'submissions'), 'utf8'), 'one\n');
    assert.ok(completed.receipt);
    assert.equal(
      completed.events.some((event) => event.kind === 'dispatch.unknown'),
      false
    );
    process.stdout.write(
      JSON.stringify({
        case: 'response-unknown-delayed-original-supervisor',
        result: completed.run.state,
        registrations: 1,
        submissions: 1,
        registrationWithinMs: completed.run.startedAt - completed.run.createdAt,
      }) + '\n'
    );
    // Cleanup below is tied to the original child handle plus authoritative scope
    // stamps from BINT1; it never signals a numeric PID after stamp reuse.
    if (processState(delayedStamp) === 'alive')
      assert.ok(sameProcessStamp(readProcess(delayedStamp.pid)?.stamp ?? null, delayedStamp));
  } finally {
    await f.cleanup();
  }

  const absent = await fixture([process.execPath, '-e', "require('fs').appendFileSync('submissions','unexpected\\n')"]);
  try {
    const initial = readReconcileSnapshot(absent.ledger, absent.input.runId);
    const originalTicketHash = initial.run.launchTokenHash;
    const before = await commitReconcile(absent.ledger, initial, [], initial.run.createdAt + 30000);
    assert.equal(before.committed && before.decision.state, 'starting');
    const timedOut = await commitReconcile(
      absent.ledger,
      readReconcileSnapshot(absent.ledger, absent.input.runId),
      [],
      initial.run.createdAt + 30001
    );
    assert.equal(timedOut.committed && timedOut.decision.state, 'uncertain');
    const final = await absent.port.read(absent.input.runId);
    assert.equal(final.slotHeld, true);
    assert.equal(final.run.launchPhase, 'reserved');
    assert.equal(final.run.launchTokenHash, originalTicketHash);
    assert.equal(final.run.supervisor, null);
    assert.equal(final.claimState, 'issued');
    assert.equal(
      final.events.filter((event) =>
        ['supervisor.registered', 'launch.submitting', 'dispatch.unknown'].includes(event.kind)
      ).length,
      0
    );
    assert.equal(absent.processes.length, 0);
    assert.equal(existsSync(join(absent.home, 'submissions')), false);
    process.stdout.write(
      JSON.stringify({
        case: 'response-unknown-no-supervisor-after-window',
        result: final.run.state,
        elapsedMs: 30001,
        slotHeld: final.slotHeld,
        registrations: 0,
        submissions: 0,
        retries: 0,
      }) + '\n'
    );
  } finally {
    await absent.cleanup();
  }
}
