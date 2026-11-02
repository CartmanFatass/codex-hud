import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { handshakeFixture, hashClaim } from '../../dist-test/tests/unit/b45-handshake-fixture.js';
import { HandshakeService } from '../../dist-test/packages/hud-mcp/src/handshake.js';
import { acceptIntent } from '../../dist-test/src/ledger/intents.js';
import { insertRecord, refValue } from '../../dist-test/src/ledger/records.js';
import { createRunFactPort } from '../../dist-test/src/core/run/ledger-port.js';
import { freezeRetirementPolicy } from '../../dist-test/src/core/run/retirement-policy.js';
import { launchDigest } from '../../dist-test/src/core/run/control.js';
import { processState, readProcess } from '../../dist-test/src/core/run/process.js';
import { sameProcessStamp } from '../../dist-test/src/core/supervision.js';
import { RUN_NODE_FLAGS } from '../../dist-test/src/core/run/runtime.js';
import { until } from './fixture.mjs';

test('B19 merge: real delegate_report hint arms B22 after-report before recovery', { timeout: 15000 }, async (t) => {
  const f = await handshakeFixture();
  const runId = 'run-b19-merge';
  const input = {
    runId,
    mode: 'headless',
    launch: {
      argv: [process.execPath, '-e', "process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000)"],
    },
    cwd: f.root,
    sourceId: f.source.sourceId,
    profileDigest: hashClaim('synthetic profile'),
    stdin: 'closed',
    orphanPolicy: 'continue',
    retire: freezeRetirementPolicy({ afterReportMs: 150, maxRunMs: 60000 }, 'implementer', 100, 30000),
  };
  const at = Date.now();
  const prepared = structuredClone(f.input);
  prepared.requestKey = 'synthetic-b19-merge';
  prepared.link = { ...prepared.link, linkId: 'link-b19-merge', createdAt: at };
  prepared.run = {
    ...prepared.run,
    runId,
    linkId: prepared.link.linkId,
    createdAt: at,
    launchTokenHash: hashClaim('synthetic-b19-ticket'),
    launchDigest: launchDigest(input),
  };
  prepared.claim = {
    ...prepared.claim,
    runId,
    claimHash: hashClaim('synthetic-b19-claim'),
    issuedAt: at,
    expiresAt: at + 1800000,
  };
  let port, child, done;
  t.after(async () => {
    try {
      const scope = (await port?.read(runId))?.meta?.scope;
      if (
        scope &&
        processState(scope.group_leader) === 'alive' &&
        sameProcessStamp(readProcess(scope.pgid)?.stamp ?? null, scope.group_leader)
      )
        process.kill(-scope.pgid, 'SIGKILL');
    } finally {
      if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await done;
      await port?.close();
      await f.close();
    }
  });
  await acceptIntent(f.ledger, prepared);
  mkdirSync(join(f.root, 'hints'), { mode: 0o700 });
  // Reuse B22's existing original-writer cut; no scheduler or hint logic is mocked.
  writeFileSync(join(f.root, 'b22-cut.json'), JSON.stringify({ beforeRequest: true, metrics: true }));
  port = await createRunFactPort(f.root);
  const env = { ...process.env, HUD_HOME: f.root, HUD_RUN_PORT_MODULE: resolve('tests/int/b22-port.mjs') };
  delete env.NODE_TEST_CONTEXT;
  child = spawn(process.execPath, [...RUN_NODE_FLAGS, 'bin/hud-run', 'start'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (data) => (stderr += data));
  child.stdout.resume();
  done = new Promise((resolve) => child.once('exit', (code) => resolve({ code, stderr })));
  child.stdin.end(JSON.stringify({ input, ticket: 'synthetic-b19-ticket' }));
  await until(async () => {
    if (child.exitCode !== null) throw new Error(stderr);
    const snapshot = await port.read(runId);
    return snapshot.meta?.scope && snapshot.run.state === 'running';
  });
  await until(() =>
    readdirSync(`/proc/${child.pid}/fd`).some((fd) => {
      try {
        return readlinkSync(`/proc/${child.pid}/fd/${fd}`) === 'anon_inode:inotify';
      } catch {
        return false;
      }
    })
  );
  await sleep(200); // Let the scheduler's initial snapshot finish before either report.
  // Synthetic verified child identity; the report and its event/hint use the real service.
  await f.ledger.transaction((tx) => {
    insertRecord(tx, 'child_bindings', {
      bindingId: 'synthetic-b19-binding',
      runId,
      sessionRef: f.child.ref,
      bindingGeneration: 1,
      callerId: f.child.context.callerId,
      callerContextId: f.child.context.contextId,
      contextGeneration: 1,
      boundBy: 'trusted_session',
      capabilities: 'mcp',
      evidenceId: 'identity-child',
      isCurrent: true,
      createdAt: at,
      revokedAt: null,
    });
    tx.run('UPDATE runs SET target_session_ref=? WHERE run_id=?', refValue(f.child.ref), runId);
    tx.run(
      "UPDATE links SET state='bound',child_ref=?,current_owner=1 WHERE link_id=?",
      refValue(f.child.ref),
      prepared.link.linkId
    );
    tx.run(
      "UPDATE claims SET state='redeemed',redeemed_context_id=?,redeemed_generation=1,redeemed_session_ref=?,redeemed_at=? WHERE run_id=?",
      f.child.context.contextId,
      refValue(f.child.ref),
      at,
      runId
    );
  });
  const report = (home) =>
    new HandshakeService({
      ledger: f.ledger,
      reader: f.reader,
      registration: f.child.registration,
      env: {},
      home,
    }).report({ runId, status: 'completed', summary: 'Synthetic merge outcome' }, f.child.authority);
  assert.equal((await report(undefined)).ok, true);
  await sleep(400);
  assert.equal(existsSync(join(f.root, 'before-request')), false, 'lost hint must await recovery');
  assert.deepEqual(readdirSync(join(f.root, 'hints')), []);

  const start = performance.now();
  const committed = await report(f.root);
  assert.equal(committed.ok, true);
  const seq = f.ledger.snapshot((tx) =>
    Number(tx.get("SELECT seq FROM events WHERE run_id=? AND kind='report.received' ORDER BY seq DESC", runId).seq)
  );
  assert.deepEqual(readdirSync(join(f.root, 'hints')), [`${runId}.${seq}`]);
  await until(() => existsSync(join(f.root, 'before-request')), 2000);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 2000 && elapsed < input.retire.recoveryMs / 10, `hint deadline ${elapsed} ms`);
  writeFileSync(join(f.root, 'release-request'), '');
  await until(async () => (await port.read(runId)).run.state === 'ended');
  assert.equal((await done).code, 0, stderr);
  const request = (await port.read(runId)).events.find((event) => event.kind === 'retire.requested');
  assert.equal(request.payload.rule, 'after_report');
  assert.equal(request.payload.eligibility.reportSeq, seq);
  t.diagnostic(`real report hint -> after-report request ${elapsed.toFixed(1)} ms; recovery 30000 ms`);
});
