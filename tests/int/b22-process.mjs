import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fixture, until, acceptResume, addIntent } from './fixture.mjs';
import { insertRecord, refValue } from '../../dist-test/src/ledger/records.js';
import { freezeRetirementPolicy } from '../../dist-test/src/core/run/retirement-policy.js';
import { launchDigest, HeadlessRunControl } from '../../dist-test/src/core/run/control.js';
import { PrivateLedgerGate } from '../../dist-test/src/ledger/local-manager.js';
import { commitReconcile, readReconcileSnapshot } from '../../dist-test/src/ledger/reconcile.js';
import { processState, readProcess, inspectGroup } from '../../dist-test/src/core/run/process.js';
import { acceptIntent } from '../../dist-test/src/ledger/intents.js';
import { intent } from '../ledger/fixtures.mjs';
import { RUN_NODE_FLAGS } from '../../dist-test/src/core/run/runtime.js';
const aliveScript =
  "process.on('SIGINT',()=>setTimeout(()=>process.exit(0),150));console.log('ready');setInterval(()=>{},1000)";

async function run({
  script = aliveScript,
  policy = {},
  role = 'implementer',
  graceMs = 50,
  recoveryMs = 100,
  cut = null,
  evidence = null,
} = {}) {
  const f = await fixture([process.execPath, '-e', script]);
  f.input.retire = freezeRetirementPolicy({ maxRunMs: 60000, ...policy }, role, graceMs, recoveryMs);
  await f.ledger.transaction((tx) =>
    tx.run('UPDATE runs SET launch_digest=? WHERE run_id=?', launchDigest(f.input), f.input.runId)
  );
  mkdirSync(join(f.home, 'hints'), { mode: 0o700 });
  if (cut) writeFileSync(join(f.home, 'b22-cut.json'), JSON.stringify(cut), { mode: 0o600 });
  const env = { ...process.env, HUD_HOME: f.home, HUD_RUN_PORT_MODULE: cut ? resolve('tests/int/b22-port.mjs') : '' };
  delete env.NODE_TEST_CONTEXT;
  if (evidence) writeFileSync(join(f.home, 'synthetic-evidence.json'), JSON.stringify(evidence), { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [...RUN_NODE_FLAGS, ...(evidence ? ['tests/int/b22-evidence.mjs'] : ['bin/hud-run', 'start'])],
    {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  let stderr = '';
  child.stderr.on('data', (data) => (stderr += data));
  child.stdout.resume();
  const done = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, stderr })));
  f.processes.push({ child, done });
  child.stdin.end(JSON.stringify({ input: f.input, ticket: f.ticket }));
  const stamps = [];
  const read = () => f.port.read(f.input.runId);
  const ready = async () => {
    const s = await until(async () => {
      const snapshot = await read();
      if (child.exitCode !== null) throw new Error('B22 startup: ' + stderr);
      return snapshot.meta?.scope && snapshot.run.state === 'running' && snapshot;
    });
    stamps.push(...inspectGroup(s.meta.scope).members.map((p) => p.stamp));
    await until(() => readFileSync(join(f.home, 'runs', f.input.runId, 'stdout.log'), 'utf8').includes('ready'));
    return s;
  };
  const cleanup = async () => {
    await f.cleanup();
    await until(() => stamps.every((stamp) => processState(stamp) !== 'alive'));
    for (const stamp of stamps) assert.notEqual(processState(stamp), 'alive', 'owned process survived cleanup');
  };
  return {
    ...f,
    child,
    done,
    read,
    ready,
    cleanup,
    mark(name) {
      writeFileSync(join(f.home, name), '', { mode: 0o600 });
    },
    at(name) {
      return existsSync(join(f.home, name));
    },
    async end() {
      const result = await until(async () => {
        const s = await read();
        if (['ended', 'cancelled', 'failed'].includes(s.run.state)) return s;
        if (child.exitCode !== null) throw new Error('B22 exited without terminal: ' + stderr + ' ' + s.run.state);
      }, 15000);
      const exit = await done;
      assert.equal(exit.code, 0, exit.stderr);
      assert.equal(result.slotHeld, false);
      const event = result.events.findLast((e) => e.kind === 'run.terminal');
      return { ...result, termination: event.payload.termination };
    },
  };
}
function hint(f, seq) {
  writeFileSync(join(f.home, 'hints', `${f.input.runId}.${seq}`), '', { mode: 0o600 });
}
async function report(f, status, notify = true) {
  const at = Date.now(),
    id = randomUUID();
  const seq = await f.ledger.transaction((tx) => {
    let binding = tx.get('SELECT binding_id FROM child_bindings WHERE run_id=?', f.input.runId);
    if (!binding) {
      const ref = { harness: 'codex', sourceId: f.input.sourceId, sessionId: 'synthetic-b22-child', threadId: null };
      tx.run('INSERT INTO sessions VALUES(?,?,?,?,?)', refValue(ref), ref.harness, ref.sourceId, ref.sessionId, '');
      insertRecord(tx, 'evidence', {
        evidenceId: 'b22-binding',
        runId: f.input.runId,
        linkId: f.prepared.link.linkId,
        kind: 'trusted_session',
        producer: 'reconciler',
        fingerprint: 'b'.repeat(64),
        payload: {},
        observedAt: at,
        validatedAt: at,
        validation: 'accepted',
      });
      insertRecord(tx, 'child_bindings', {
        bindingId: 'b22-binding',
        runId: f.input.runId,
        sessionRef: ref,
        bindingGeneration: 1,
        callerId: 'parent',
        callerContextId: 'parent-context',
        contextGeneration: 1,
        boundBy: 'trusted_session',
        capabilities: 'mcp',
        evidenceId: 'b22-binding',
        isCurrent: true,
        createdAt: at,
        revokedAt: null,
      });
      tx.run('UPDATE runs SET target_session_ref=? WHERE run_id=?', refValue(ref), f.input.runId);
      tx.run(
        "UPDATE claims SET state='redeemed',redeemed_context_id='parent-context',redeemed_generation=1,redeemed_session_ref=?,redeemed_at=? WHERE run_id=?",
        refValue(ref),
        at,
        f.input.runId
      );
      tx.run(
        "UPDATE links SET state='bound',child_ref=?,current_owner=1 WHERE link_id=?",
        refValue(ref),
        f.prepared.link.linkId
      );
      binding = { binding_id: 'b22-binding' };
    }
    insertRecord(tx, 'reports', {
      reportId: id,
      runId: f.input.runId,
      linkId: f.prepared.link.linkId,
      childBindingId: binding.binding_id,
      callerId: 'parent',
      callerContextId: 'parent-context',
      contextGeneration: 1,
      status,
      summary: 'Synthetic B22 outcome',
      path: null,
      createdAt: at,
    });
    insertRecord(tx, 'events', {
      runId: f.input.runId,
      linkId: f.prepared.link.linkId,
      kind: 'report.received',
      payload: { reportId: id },
      at,
    });
    return Number(tx.get('SELECT last_insert_rowid() AS seq').seq);
  });
  if (notify) hint(f, seq);
  return seq;
}

for (const [role, status] of [
  ['implementer', 'completed'],
  ['reviewer', 'failed'],
])
  test(
    `B22 real after-report ${role}/${status}: alive child -> ended, retire_after_report, caused`,
    { timeout: 20000 },
    async () => {
      const f = await run({ policy: { afterReportMs: 100, reviewerAfterReportMs: 50 }, role, graceMs: 400 });
      try {
        await f.ready();
        const seq = await report(f, status);
        const end = await f.end();
        assert.equal(end.run.state, 'ended');
        assert.equal(end.termination.requestedCause, 'retire_after_report');
        assert.equal(end.termination.attribution, 'caused');
        assert.equal(end.termination.outcome, status);
        const request = end.events.find((e) => e.kind === 'retire.requested');
        assert.equal(request.payload.eligibility.reportSeq, seq);
        assert.equal(end.events.find((e) => e.kind === 'cancel.step').payload.requestSeq, request.seq);
        assert.equal(end.receipt.cancel_request_seq, null);
      } finally {
        await f.cleanup();
      }
    }
  );

test('B22 real lost report hint recovers on frozen recovery timer', { timeout: 20000 }, async () => {
  const f = await run({ policy: { afterReportMs: 20 }, recoveryMs: 100, graceMs: 300 });
  try {
    await f.ready();
    await report(f, 'completed', false);
    assert.equal((await f.end()).termination.requestedCause, 'retire_after_report');
  } finally {
    await f.cleanup();
  }
});

for (const change of ['intent', 'report'])
  test(
    `B22 real ${change} after deadline armed aborts pending retirement without a signal`,
    { timeout: 20000 },
    async () => {
      const f = await run({ policy: { afterReportMs: 200 }, cut: { afterRequest: true } });
      try {
        await f.ready();
        await report(f, 'completed');
        await until(() => f.at('retirement-committed'));
        if (change === 'report') await report(f, 'blocked');
        else
          await f.ledger.transaction((tx) => {
            insertRecord(tx, 'events', {
              runId: f.input.runId,
              linkId: f.prepared.link.linkId,
              kind: 'intent.accepted',
              payload: { operation: change },
              at: Date.now(),
            });
          });
        f.mark('release-signal');
        await sleep(250);
        const s = await f.read();
        assert.equal(
          s.events.some((e) => e.kind === 'cancel.step'),
          false
        );
        assert.equal(processState(s.meta.harness), 'alive');
        assert.equal(s.slotHeld, true);
      } finally {
        await f.cleanup();
      }
    }
  );

test(
  'B22 real user cancel racing committed pending policy wins with conservative B21 attribution',
  { timeout: 20000 },
  async () => {
    const f = await run({ policy: { afterReportMs: 50 }, cut: { afterRequest: true } });
    try {
      await f.ready();
      await report(f, 'completed');
      await until(() => f.at('retirement-committed'));
      const user = await f.port.acceptCancel(f.input.runId, new PrivateLedgerGate(f.home).actor(), 0);
      f.mark('release-signal');
      const end = await f.end();
      assert.equal(end.termination.requestedCause, 'user_cancel');
      assert.equal(end.termination.attribution, 'unknown');
      assert.equal(end.status.terminalNote, 'cancel_timing_unknown');
      assert.ok(end.events.filter((e) => e.kind === 'cancel.step').every((e) => e.payload.requestSeq === user.seq));
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'B22 real unobservable idle never retires; finite max-runtime interrupts active work',
  { timeout: 20000 },
  async () => {
    const f = await run({ policy: { idleMs: 20, maxRunMs: 700 }, graceMs: 300 });
    try {
      await f.ready();
      await sleep(200);
      assert.equal(
        (await f.read()).events.some((e) => e.kind === 'retire.requested'),
        false
      );
      const end = await f.end();
      assert.equal(end.termination.requestedCause, 'runtime_limit');
      assert.equal(end.events.find((e) => e.kind === 'retire.requested').payload.rule, 'max_runtime');
    } finally {
      await f.cleanup();
    }
  }
);

for (const status of ['blocked', 'interrupted'])
  test(`B22 real blocked-wait ${status} preserves blocked outcome`, { timeout: 20000 }, async () => {
    const f = await run({ policy: { blockedWaitMs: 50 }, graceMs: 300 });
    try {
      await f.ready();
      await report(f, status);
      const end = await f.end();
      assert.equal(end.termination.requestedCause, 'retire_blocked_wait');
      assert.equal(end.termination.outcome, 'blocked');
    } finally {
      await f.cleanup();
    }
  });

test(
  'B22 real SIGINT/SIGTERM ignoring child escalates TERM then KILL and leaves group empty',
  { timeout: 20000 },
  async () => {
    const f = await run({
      script: "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)",
      policy: { maxRunMs: 300 },
      graceMs: 40,
    });
    try {
      const ready = await f.ready();
      const end = await f.end();
      assert.deepEqual(
        end.events.filter((e) => e.kind === 'cancel.step').map((e) => e.payload.signal),
        ['SIGINT', 'SIGTERM', 'SIGKILL']
      );
      assert.equal(inspectGroup(ready.meta.scope).members.length, 0);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'B22 real SIGKILL supervisor during ladder leaves alive child uncertain and slot held',
  { timeout: 20000 },
  async () => {
    const f = await run({
      script: "process.on('SIGINT',()=>{});console.log('ready');setInterval(()=>{},1000)",
      policy: { maxRunMs: 300 },
      graceMs: 10000,
    });
    try {
      const ready = await f.ready();
      await until(async () => (await f.read()).events.some((e) => e.kind === 'cancel.step'));
      f.child.kill('SIGKILL');
      await f.done;
      const control = new HeadlessRunControl(f.port, f.home, new PrivateLedgerGate(f.home).actor());
      await control.reconcile(f.input.runId);
      const s = await f.read();
      assert.equal(s.run.state, 'uncertain');
      assert.equal(s.slotHeld, true);
      assert.equal(processState(ready.meta.harness), 'alive');
      await sleep(100);
      assert.equal((await f.read()).events.filter((e) => e.kind === 'cancel.step').length, 1);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'B22 real SIGKILL supervisor at terminal import has no automatic release; dead-only uncertain, explicit Q releases',
  { timeout: 20000 },
  async () => {
    const f = await run({ policy: { maxRunMs: 300 }, graceMs: 300, cut: { import: true } });
    try {
      await f.ready();
      await until(() => f.at('terminal-import'));
      f.child.kill('SIGKILL');
      await f.done;
      const before = await f.read();
      assert.equal(before.slotHeld, true);
      assert.notEqual(before.run.state, 'ended');
      const expected = readReconcileSnapshot(f.ledger, f.input.runId),
        at = Date.now(),
        evidenceId = 'b22-dead-supervisor';
      const fact = {
        evidenceId,
        runId: f.input.runId,
        sourceId: expected.run.sourceId,
        bindingGeneration: expected.run.expectedGeneration,
        supervisor: expected.run.supervisor,
        validation: 'accepted',
        asOf: at,
        observedAt: at,
        fact: { kind: 'supervisor', state: 'dead' },
      };
      await commitReconcile(
        f.ledger,
        expected,
        [
          {
            record: {
              evidenceId,
              runId: f.input.runId,
              linkId: expected.link.linkId,
              kind: 'heartbeat',
              producer: 'reconciler',
              fingerprint: createHash('sha256').update(evidenceId).digest('hex'),
              payload: {},
              observedAt: at,
              validatedAt: at,
              validation: 'accepted',
            },
            facts: [fact],
          },
        ],
        at
      );
      const partial = await f.read();
      assert.equal(partial.run.state, 'uncertain');
      assert.equal(partial.slotHeld, true);
      await new HeadlessRunControl(f.port, f.home, new PrivateLedgerGate(f.home).actor()).reconcile(f.input.runId);
      const full = await f.read();
      assert.equal(full.run.state, 'ended');
      assert.equal(full.slotHeld, false);
    } finally {
      await f.cleanup();
    }
  }
);

test('B22 real clock anomaly during policy grace prevents causal attribution', { timeout: 20000 }, async () => {
  const f = await run({
    script: "process.on('SIGINT',()=>{});console.log('ready');setInterval(()=>{},1000)",
    policy: { maxRunMs: 300 },
    graceMs: 50,
    cut: { clock: true },
  });
  try {
    await f.ready();
    const end = await f.end();
    assert.ok(end.events.some((e) => e.kind === 'clock.anomaly'));
    assert.equal(end.termination.attribution, 'unknown');
    assert.equal(end.status.terminalNote, 'retire_timing_unknown');
  } finally {
    await f.cleanup();
  }
});

test(
  'B22 real natural exit before first policy signal retains request audit and proves not_caused',
  { timeout: 20000 },
  async () => {
    const f = await run({
      script:
        "const fs=require('fs');console.log('ready');const t=setInterval(()=>{if(fs.existsSync('finish')){clearInterval(t);process.exit(0)}},10)",
      policy: { afterReportMs: 100 },
      cut: { beforeRequest: true, natural: true },
    });
    try {
      await f.ready();
      await report(f, 'completed');
      await until(() => f.at('before-request'));
      f.mark('finish');
      await until(() => f.at('natural-import'));
      f.mark('release-request');
      await until(() => f.at('retirement-committed'));
      f.mark('release-natural');
      const end = await f.end();
      assert.equal(end.termination.attribution, 'not_caused');
      assert.equal(end.termination.requestedCause, 'retire_after_report');
      assert.equal(
        end.events.some((e) => e.kind === 'cancel.step'),
        false
      );
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'B22 real newer report during armed grace cancels old deadline before any request',
  { timeout: 20000 },
  async () => {
    const f = await run({ policy: { afterReportMs: 400, blockedWaitMs: 10000 } });
    try {
      await f.ready();
      await report(f, 'completed');
      await sleep(100);
      await report(f, 'blocked');
      await sleep(500);
      const snapshot = await f.read();
      assert.equal(
        snapshot.events.some((e) => e.kind === 'retire.requested'),
        false
      );
      assert.equal(
        snapshot.events.some((e) => e.kind === 'cancel.step'),
        false
      );
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'B22 real accepted resume changes current assignment while old policy is pending; no signal',
  { timeout: 20000 },
  async () => {
    const f = await run({
      script:
        "const fs=require('fs');console.log('ready');setInterval(()=>{if(fs.existsSync('finish'))process.exit(0)},10)",
      policy: { maxRunMs: 300 },
      cut: { afterRequest: true },
    });
    try {
      await f.ready();
      await until(() => f.at('retirement-committed'));
      f.mark('finish');
      await until(async () => (await f.read()).run.state === 'ended');
      const next = await acceptResume(f);
      assert.equal((await f.port.read(next.input.runId)).run.state, 'starting');
      f.mark('release-signal');
      const exit = await f.done;
      assert.equal(exit.code, 0, exit.stderr);
      assert.equal(
        (await f.read()).events.some((e) => e.kind === 'cancel.step'),
        false
      );
      assert.equal((await f.port.read(next.input.runId)).run.state, 'starting');
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'B22 real natural exit after retirement request but before signal has unknown attribution',
  { timeout: 20000 },
  async () => {
    const f = await run({
      script:
        "const fs=require('fs');console.log('ready');setInterval(()=>{if(fs.existsSync('finish'))process.exit(0)},10)",
      policy: { afterReportMs: 50 },
      cut: { afterRequest: true },
    });
    try {
      await f.ready();
      await report(f, 'completed');
      await until(() => f.at('retirement-committed'));
      f.mark('finish');
      await until(async () => (await f.read()).run.state === 'ended');
      f.mark('release-signal');
      const end = await f.end();
      assert.equal(end.termination.attribution, 'unknown');
      assert.equal(end.status.terminalNote, 'retire_timing_unknown');
      assert.equal(
        end.events.some((e) => e.kind === 'cancel.step'),
        false
      );
    } finally {
      await f.cleanup();
    }
  }
);

test('B22 real fast SIGINT exit does not manufacture a later alive witness', { timeout: 20000 }, async () => {
  const f = await run({
    script: "process.on('SIGINT',()=>process.exit(0));console.log('ready');setInterval(()=>{},1000)",
    policy: { maxRunMs: 300 },
    graceMs: 100,
  });
  try {
    await f.ready();
    const end = await f.end();
    // A fast exit is allowed to race the probe, so any caused classification
    // must carry an independently later accepted alive witness.
    if (end.termination.attribution === 'caused') {
      const step = end.events.find((e) => e.kind === 'cancel.step');
      assert.ok(
        end.facts.some((fact) => fact.fact.kind === 'scope' && fact.fact.state === 'alive' && fact.asOf > step.at)
      );
    } else assert.equal(end.termination.attribution, 'unknown');
  } finally {
    await f.cleanup();
  }
});

test(
  'B22 real visible TTY run with expired frozen policy never receives policy signals',
  { timeout: 30000 },
  async () => {
    const f = await fixture([process.execPath, '-e', '']);
    let tmux, metadata;
    const infrastructure = [];
    try {
      const prepared = intent('b22-visible'),
        at = Date.now();
      const input = {
        runId: prepared.run.runId,
        mode: 'visible',
        launch: { argv: [process.execPath, '-e', "console.log('ready');setTimeout(()=>{},60000)"] },
        cwd: f.home,
        sourceId: prepared.run.sourceId,
        profileDigest: 'a'.repeat(64),
        stdin: 'tty',
        orphanPolicy: 'continue',
        retire: freezeRetirementPolicy({ maxRunMs: 50, idleMs: 0 }, 'implementer', 0, 30),
      };
      const ticket = 'synthetic-b22-visible-ticket';
      prepared.requestKey = 'b22-visible';
      prepared.params.mode = 'visible';
      prepared.params.launchCwd = f.home;
      prepared.link.createdAt = at;
      prepared.run = {
        ...prepared.run,
        mode: 'visible',
        supervisionStrategy: 'wrapper',
        launchCwd: f.home,
        createdAt: at,
        launchDigest: launchDigest(input),
        launchTokenHash: createHash('sha256').update(ticket).digest('hex'),
      };
      prepared.claim.issuedAt = at;
      prepared.claim.expiresAt = at + 1800000;
      await acceptIntent(f.ledger, prepared);
      const socket = 'b22-' + process.pid + '-' + at;
      const env = {
        ...process.env,
        HUD_HOME: f.home,
        TMUX_TMPDIR: f.home,
        HOME: f.home,
        SHELL: '/bin/bash',
        HUD_RUN_PORT_MODULE: '',
      };
      delete env.TMUX;
      delete env.NODE_TEST_CONTEXT;
      tmux = (...args) => {
        const r = spawnSync('/usr/bin/tmux', ['-L', socket, ...args], { env, encoding: 'utf8', timeout: 5000 });
        if (r.status !== 0) throw new Error(r.stderr);
        return r.stdout.trim();
      };
      tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'b22', '/bin/bash --noprofile --norc');
      infrastructure.push(
        ...tmux('display-message', '-p', '-t', 'b22:0.0', '#{pid}:#{pane_pid}')
          .split(':')
          .map(Number)
          .flatMap((pid) => (readProcess(pid)?.stamp ? [readProcess(pid).stamp] : []))
      );
      const file = join(f.home, 'visible.json');
      writeFileSync(file, JSON.stringify({ input, ticket, visible: { expectedExecutable: process.execPath }, env }), {
        mode: 0o600,
      });
      const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
      tmux(
        'send-keys',
        '-t',
        'b22:0.0',
        `${quote(process.execPath)} ${RUN_NODE_FLAGS.join(' ')} ${quote(resolve('bin/hud-run'))} start --launch-fd 3 3<${quote(file)} 2>${quote(join(f.home, 'errors'))}`,
        'Enter'
      );
      const live = await until(async () => {
        const s = await f.port.read(input.runId);
        return s.run.state === 'running' && s.meta?.scope && s;
      }, 20000);
      metadata = live.meta;
      await sleep(300);
      const after = await f.port.read(input.runId);
      assert.equal(processState(metadata.harness), 'alive');
      assert.equal(
        after.events.some((e) => e.kind === 'retire.requested' || e.kind === 'cancel.step'),
        false
      );
      assert.equal(after.slotHeld, true);
    } finally {
      for (const stamp of [metadata?.harness, metadata?.command_leader, metadata?.supervisor].filter(Boolean))
        if (processState(stamp) === 'alive') {
          try {
            process.kill(stamp.pid, 'SIGKILL');
          } catch {}
        }
      try {
        tmux?.('kill-server');
      } catch {}
      await until(() =>
        [...infrastructure, metadata?.harness, metadata?.supervisor]
          .filter(Boolean)
          .every((stamp) => processState(stamp) !== 'alive')
      );
      await f.cleanup();
    }
  }
);

test('B22 real supervisor trusted observed quiescence port permits idle retirement', { timeout: 20000 }, async () => {
  const f = await run({
    policy: { idleMs: 100 },
    graceMs: 300,
    evidence: {
      quiescent: true,
      since: Date.now() - 1000,
      pendingInput: 'none',
      pendingSince: null,
      source: 'synthetic:completed-turn',
    },
  });
  try {
    await f.ready();
    const end = await f.end();
    assert.equal(end.termination.requestedCause, 'retire_idle');
    assert.equal(end.events.find((e) => e.kind === 'retire.requested').payload.eligibility.quiescence, 'observed');
  } finally {
    await f.cleanup();
  }
});

test('B22 real supervisor observed pending redirects after-report to blocked-wait', { timeout: 20000 }, async () => {
  const f = await run({
    policy: { afterReportMs: 50, blockedWaitMs: 300 },
    graceMs: 300,
    evidence: {
      quiescent: false,
      since: null,
      pendingInput: 'approval',
      pendingSince: Date.now(),
      source: 'synthetic:approval',
    },
  });
  try {
    await f.ready();
    writeFileSync(
      join(f.home, 'synthetic-evidence.json'),
      JSON.stringify({
        quiescent: false,
        since: null,
        pendingInput: 'approval',
        pendingSince: Date.now(),
        source: 'synthetic:approval',
      }),
      { mode: 0o600 }
    );
    await report(f, 'completed');
    const end = await f.end();
    assert.equal(end.termination.requestedCause, 'retire_blocked_wait');
    assert.equal(
      end.events.find((e) => e.kind === 'retire.requested').payload.eligibility.pendingInput,
      'policy_override'
    );
  } finally {
    await f.cleanup();
  }
});

test(
  'B22 performance armed default run: idle CPU and ledger snapshots per hour',
  { skip: process.env.B22_PERF !== '1', timeout: 45000 },
  async () => {
    const f = await run({ policy: { maxRunMs: 120000 }, recoveryMs: 30000, cut: { metrics: true } });
    const ticks = (pid) => {
      const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = text
        .slice(text.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/);
      return Number(fields[11]) + Number(fields[12]);
    };
    try {
      const ready = await f.ready();
      await sleep(200);
      const owned = [ready.meta.supervisor, ...inspectGroup(ready.meta.scope).members.map((p) => p.stamp)];
      const beforeCpu = owned.reduce((sum, stamp) => sum + ticks(stamp.pid), 0);
      const beforeReads = Number(readFileSync(join(f.home, 'read-count'), 'utf8'));
      const began = performance.now();
      await sleep(31000);
      const elapsedMs = performance.now() - began;
      const deltaTicks = owned.reduce((sum, stamp) => sum + ticks(stamp.pid), 0) - beforeCpu;
      const deltaReads = Number(readFileSync(join(f.home, 'read-count'), 'utf8')) - beforeReads;
      const hz = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim());
      console.log(
        'B22_PERF_ARMED ' +
          JSON.stringify({
            elapsedMs,
            deltaTicks,
            hz,
            cpuMs: (deltaTicks * 1000) / hz,
            cpuPercent: (deltaTicks * 100000) / hz / elapsedMs,
            ledgerSnapshots: deltaReads,
            recoverySnapshotsPerHour: 3600000 / 30000,
            deadlineSnapshotsPerEvent: 2,
            signals: 0,
          })
      );
      assert.equal(deltaReads, 1);
      assert.equal(
        (await f.read()).events.some((e) => e.kind === 'retire.requested'),
        false
      );
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'B22 performance real ladder latency beyond frozen grace plus TERM wait',
  { skip: process.env.B22_PERF !== '1', timeout: 45000 },
  async () => {
    const samples = [];
    for (let sample = 0; sample < 5; sample++) {
      const f = await run({
        script:
          "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)",
        policy: { maxRunMs: 300 },
        graceMs: 40,
        recoveryMs: 30000,
        cut: { metrics: true },
      });
      try {
        await f.ready();
        const readsBefore = Number(readFileSync(join(f.home, 'read-count'), 'utf8'));
        const end = await f.end();
        const request = end.events.find((e) => e.kind === 'retire.requested');
        const steps = end.events.filter((e) => e.kind === 'cancel.step');
        samples.push({
          supervisorSnapshotsFromReady: Number(readFileSync(join(f.home, 'read-count'), 'utf8')) - readsBefore,
          deadlineToRequestMs: request.at - request.payload.deadlineAt,
          requestToINTMs: steps[0].at - request.at,
          intToKillMs: steps.at(-1).at - steps[0].at,
          ladderOverheadMs: steps.at(-1).at - steps[0].at - 2040,
          terminalAfterDeadlineMs: end.run.endedAt - request.payload.deadlineAt,
        });
      } finally {
        await f.cleanup();
      }
    }
    console.log('B22_PERF_LADDER ' + JSON.stringify({ n: samples.length, samples }));
  }
);

test(
  'B22 real max-runtime stays monotonic across wall-clock rollback before deadline',
  { timeout: 15000 },
  async () => {
    const f = await run({ policy: { maxRunMs: 3000 }, graceMs: 300, recoveryMs: 30000, cut: { rollback: true } });
    try {
      await f.ready();
      const began = performance.now();
      const end = await f.end();
      assert.ok(performance.now() - began < 4500, 'wall rollback postponed finite maximum');
      assert.equal(end.termination.requestedCause, 'runtime_limit');
      assert.equal(end.termination.attribution, 'unknown');
      assert.ok(end.events.some((e) => e.kind === 'clock.anomaly'));
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'B22 real user cancel interrupts pending policy grace and keeps its own canonical grace/steps',
  { timeout: 20000 },
  async () => {
    const f = await run({
      script: "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)",
      policy: { maxRunMs: 300 },
      graceMs: 10000,
      recoveryMs: 30000,
    });
    try {
      await f.ready();
      await until(async () => (await f.read()).events.some((e) => e.kind === 'cancel.step'));
      const began = performance.now();
      const actor = new PrivateLedgerGate(f.home).actor();
      const user = await f.port.acceptCancel(f.input.runId, actor, 0);
      const duplicate = await f.port.acceptCancel(f.input.runId, actor, 60000);
      assert.equal(duplicate.seq, user.seq);
      assert.equal(duplicate.graceMs, 0);
      const end = await f.end();
      assert.ok(performance.now() - began < 9000, 'user cancel did not interrupt the policy grace');
      assert.equal(end.termination.requestedCause, 'user_cancel');
      assert.equal(end.termination.attribution, 'unknown');
      const userSteps = end.events.filter((e) => e.kind === 'cancel.step' && e.payload.requestSeq === user.seq);
      assert.deepEqual(
        userSteps.map((e) => e.payload.signal),
        ['SIGINT', 'SIGTERM', 'SIGKILL']
      );
      assert.equal(end.events.filter((e) => e.kind === 'cancel.step' && e.payload.requestSeq !== user.seq).length, 1);
    } finally {
      await f.cleanup();
    }
  }
);

test('B22 real parent decision after blocked report resets blocked-wait deadline', { timeout: 15000 }, async () => {
  const f = await run({ policy: { blockedWaitMs: 300 } });
  try {
    await f.ready();
    await report(f, 'blocked');
    await sleep(70);
    const seq = await f.ledger.transaction((tx) => {
      insertRecord(tx, 'events', {
        runId: f.input.runId,
        linkId: f.prepared.link.linkId,
        kind: 'intent.accepted',
        payload: { operation: 'resume' },
        at: Date.now(),
      });
      return Number(tx.get('SELECT last_insert_rowid() AS seq').seq);
    });
    hint(f, seq);
    await sleep(500);
    const s = await f.read();
    assert.equal(
      s.events.some((e) => e.kind === 'retire.requested' || e.kind === 'cancel.step'),
      false
    );
    assert.equal(processState(s.meta.harness), 'alive');
  } finally {
    await f.cleanup();
  }
});

test(
  'B22 real pending superseded by parent decision does not spin an expired blocked-wait deadline',
  { timeout: 15000 },
  async () => {
    const f = await run({
      policy: { idleMs: 150, blockedWaitMs: 50 },
      recoveryMs: 100,
      cut: { metrics: true },
      evidence: {
        quiescent: false,
        since: null,
        pendingInput: 'approval',
        pendingSince: Date.now(),
        source: 'synthetic:pending',
      },
    });
    try {
      await f.ready();
      const pendingSince = Date.now();
      writeFileSync(
        join(f.home, 'synthetic-evidence.json'),
        JSON.stringify({
          quiescent: false,
          since: null,
          pendingInput: 'approval',
          pendingSince,
          source: 'synthetic:pending',
        }),
        { mode: 0o600 }
      );
      await sleep(10);
      await f.ledger.transaction((tx) =>
        insertRecord(tx, 'events', {
          runId: f.input.runId,
          linkId: f.prepared.link.linkId,
          kind: 'intent.accepted',
          payload: { operation: 'resume' },
          at: Date.now(),
        })
      );
      await sleep(400);
      const s = await f.read();
      assert.equal(
        s.events.some((e) => e.kind === 'retire.requested' || e.kind === 'cancel.step'),
        false
      );
      assert.ok(
        Number(readFileSync(join(f.home, 'read-count'), 'utf8')) < 30,
        'expired blocked deadline caused repeated reads'
      );
    } finally {
      await f.cleanup();
    }
  }
);

for (const invalidation of ['binding', 'context', 'scope', 'claim'])
  test(
    `B22 real ${invalidation} invalidation after retirement commit aborts the first policy signal`,
    { timeout: 15000 },
    async () => {
      const f = await run({ policy: { afterReportMs: 50 }, cut: { afterRequest: true } });
      try {
        await f.ready();
        await report(f, 'completed');
        await until(() => f.at('retirement-committed'));
        const before = await f.read();
        assert.equal(before.claimState, 'redeemed');
        await f.ledger.transaction((tx) => {
          const at = Date.now();
          if (invalidation === 'binding')
            tx.run('UPDATE child_bindings SET is_current=0,revoked_at=? WHERE run_id=?', at, f.input.runId);
          if (invalidation === 'context')
            tx.run("UPDATE caller_contexts SET closed_at=? WHERE context_id='parent-context'", at);
          if (invalidation === 'scope') tx.run('UPDATE caller_scopes SET closed_at=? WHERE harness_pid=41001', at);
          if (invalidation === 'claim') tx.run("UPDATE claims SET state='revoked' WHERE run_id=?", f.input.runId);
        });
        const changed = await f.read();
        assert.notEqual(changed.retirement.assignment, before.retirement.assignment);
        assert.equal(changed.retirement.authorityValid, false);
        f.mark('release-signal');
        await sleep(300);
        const s = await f.read();
        assert.equal(
          s.events.some((e) => e.kind === 'cancel.step'),
          false
        );
        assert.equal(processState(s.meta.harness), 'alive');
        assert.equal(s.slotHeld, true);
      } finally {
        await f.cleanup();
      }
    }
  );

for (const location of ['run', 'relation', 'other-same-ref'])
  test(
    `B22 real unresolved ${location} conflict after retirement commit blocks policy signals`,
    { timeout: 15000 },
    async () => {
      const f = await run({ policy: { afterReportMs: 50 }, cut: { afterRequest: true } });
      try {
        await f.ready();
        await report(f, 'completed');
        await until(() => f.at('retirement-committed'));
        let targetRun = f.input.runId,
          targetLink = f.prepared.link.linkId;
        if (location === 'other-same-ref') {
          const other = await addIntent(f.ledger, f.home, [process.execPath, '-e', ''], 'b22-conflict-other');
          targetRun = other.input.runId;
          targetLink = other.prepared.link.linkId;
          await f.ledger.transaction((tx) =>
            tx.run(
              'UPDATE runs SET target_session_ref=(SELECT target_session_ref FROM runs WHERE run_id=?) WHERE run_id=?',
              f.input.runId,
              targetRun
            )
          );
        }
        await f.ledger.transaction((tx) =>
          insertRecord(tx, 'evidence', {
            evidenceId: 'b22-new-conflict',
            runId: location === 'relation' ? null : targetRun,
            linkId: targetLink,
            kind: 'conflict',
            producer: 'reconciler',
            fingerprint: 'c'.repeat(64),
            payload: {},
            observedAt: Date.now(),
            validatedAt: Date.now(),
            validation: 'accepted',
          })
        );
        assert.equal((await f.read()).controlConflict, true);
        f.mark('release-signal');
        await sleep(250);
        const s = await f.read();
        assert.equal(
          s.events.some((e) => e.kind === 'cancel.step'),
          false
        );
        assert.equal(processState(s.meta.harness), 'alive');
        assert.equal(s.slotHeld, true);
      } finally {
        await f.cleanup();
      }
    }
  );

test('B22 real conflict arriving during policy grace blocks TERM/KILL', { timeout: 15000 }, async () => {
  const f = await run({
    script: "process.on('SIGINT',()=>{});console.log('ready');setInterval(()=>{},1000)",
    policy: { maxRunMs: 300 },
    graceMs: 300,
  });
  try {
    await f.ready();
    await until(async () => (await f.read()).events.some((e) => e.kind === 'cancel.step'));
    await f.ledger.transaction((tx) =>
      insertRecord(tx, 'evidence', {
        evidenceId: 'b22-grace-conflict',
        runId: null,
        linkId: f.prepared.link.linkId,
        kind: 'conflict',
        producer: 'reconciler',
        fingerprint: 'd'.repeat(64),
        payload: {},
        observedAt: Date.now(),
        validatedAt: Date.now(),
        validation: 'accepted',
      })
    );
    await sleep(500);
    const s = await f.read();
    assert.deepEqual(
      s.events.filter((e) => e.kind === 'cancel.step').map((e) => e.payload.signal),
      ['SIGINT']
    );
    assert.equal(processState(s.meta.harness), 'alive');
    assert.equal(s.slotHeld, true);
  } finally {
    await f.cleanup();
  }
});

test('B22 real natural exit during slow evidence read closes all retirement timers', { timeout: 8000 }, async () => {
  const f = await run({
    script: "console.log('ready');setTimeout(()=>process.exit(0),250)",
    policy: { idleMs: 0 },
    evidence: { delayMs: 800, returnsNull: true },
  });
  try {
    await f.ready();
    const began = performance.now();
    const end = await f.end();
    assert.equal(end.run.state, 'ended');
    assert.ok(performance.now() - began < 2000, 'late evidence continuation kept supervisor alive');
  } finally {
    await f.cleanup();
  }
});

test('B22 real B16 pending approval never borrows an old blocked-report interval', { timeout: 10000 }, () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['tests/int/b22-pending-projection.mjs'], {
    env,
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /"pendingSince":null/);
});

test(
  'B22 real user ladder started during retirement writer await is never duplicated or reset',
  { timeout: 20000 },
  async () => {
    const f = await run({
      script: "process.on('SIGINT',()=>{});console.log('ready');setInterval(()=>{},1000)",
      policy: { afterReportMs: 50 },
      cut: { afterRequest: true },
      recoveryMs: 30000,
    });
    try {
      await f.ready();
      await report(f, 'completed');
      await until(() => f.at('retirement-committed'));
      const user = await f.port.acceptCancel(f.input.runId, new PrivateLedgerGate(f.home).actor(), 5000);
      await until(
        async () => (await f.read()).events.some((e) => e.kind === 'cancel.step' && e.payload.requestSeq === user.seq),
        8000
      );
      f.mark('release-signal');
      await sleep(250);
      assert.equal(
        (await f.read()).events.filter(
          (e) => e.kind === 'cancel.step' && e.payload.requestSeq === user.seq && e.payload.signal === 'SIGINT'
        ).length,
        1
      );
      const end = await f.end();
      const steps = end.events.filter((e) => e.kind === 'cancel.step');
      assert.deepEqual(
        steps.map((e) => [e.payload.requestSeq, e.payload.signal]),
        [
          [user.seq, 'SIGINT'],
          [user.seq, 'SIGTERM'],
        ]
      );
      assert.ok(
        steps[1].at - steps[0].at >= 4800 && steps[1].at - steps[0].at < 6500,
        'canonical user grace was changed'
      );
    } finally {
      await f.cleanup();
    }
  }
);
