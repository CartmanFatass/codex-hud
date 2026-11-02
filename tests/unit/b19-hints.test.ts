import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { HandshakeService } from '../../packages/hud-mcp/src/handshake.js';
import { sessionOwnerKey } from '../../src/core/identity.js';
import { hintDirectory, touchHint } from '../../src/core/wait/hints.js';
import { authorizeRootCall, scopeSnapshot } from '../../src/ledger/call-context.js';
import { openLedger } from '../../src/ledger/ledger.js';
import { recordWakeRegistered, recordWakeRevoked } from '../../src/ledger/notify-events.js';
import { commitReconcile, readReconcileSnapshot } from '../../src/ledger/reconcile.js';
import { appendRunFact } from '../../src/ledger/run-facts.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import { acceptIntent, completion, factEvidence, nextIntent, notifyFixture } from './b21-fixture.js';

const options = { skip: !ledgerRuntimeSupported() };
type Fixture = Awaited<ReturnType<typeof notifyFixture>>;
function files(f: Fixture): string[] {
  return readdirSync(hintDirectory(f.root));
}
function latest(f: Fixture, kind: string) {
  return f.ledger.snapshot((tx) => tx.get('SELECT * FROM events WHERE kind=? ORDER BY seq DESC LIMIT 1', kind)!);
}
function service(f: Fixture, home: string | undefined = f.root) {
  return new HandshakeService({
    ledger: f.ledger,
    registration: f.child.registration,
    reader: f.reader,
    home,
    env: { HUD_CLAIM: f.claim },
    now: f.now,
  });
}
async function fixture() {
  const f = await notifyFixture();
  mkdirSync(hintDirectory(f.root), { mode: 0o700 });
  return f;
}
async function reconcile(f: Fixture, terminal: boolean) {
  return commitReconcile(
    f.ledger,
    readReconcileSnapshot(f.ledger, 'run-a'),
    [
      factEvidence(
        f,
        terminal ? 'completion' : 'supervisor-dead',
        terminal ? completion : { kind: 'supervisor', state: 'dead' },
        1050
      ),
    ],
    1060,
    undefined,
    f.ledger.busyBudgetMs,
    f.root
  );
}

test(
  'B19 hints are exclusive empty private files; invalid names and filesystem failures are ignored',
  options,
  async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    touchHint(f.root, 'run-a', 1);
    const file = join(hintDirectory(f.root), 'run-a.1');
    assert.equal(readFileSync(file, 'utf8'), '');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const before = statSync(file).mtimeMs;
    touchHint(f.root, 'run-a', 1);
    assert.equal(statSync(file).mtimeMs, before);
    for (const id of ['../escape', '/absolute', '', 'bad/name']) touchHint(f.root, id, 1);
    for (const seq of [0, -1, NaN, Infinity, 1.5]) touchHint(f.root, 'run-a', seq);
    touchHint(join(f.root, 'missing'), 'run-a', 2);
    assert.deepEqual(files(f), ['run-a.1']);
  }
);

test(
  'B19 accepted report creates hint only after commit visible to another SQLite connection; all report outcomes wake',
  options,
  async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    await f.startup();
    const child = service(f);
    await child.whoami({}, f.child.authority);
    const observer = await openLedger(join(f.root, 'ledger.sqlite'));
    t.after(() => observer.close());
    const transaction = f.ledger.transaction.bind(f.ledger);
    f.ledger.transaction = async (callback, budget) => {
      const result = await transaction((tx) => {
        const value = callback(tx);
        assert.deepEqual(files(f), [], 'hint absent inside transaction');
        return value;
      }, budget);
      assert.deepEqual(files(f), [], 'hint absent before committed result reaches writer');
      assert.ok(observer.snapshot((tx) => tx.get("SELECT 1 FROM events WHERE kind='report.received'")));
      return result;
    };
    for (const status of ['completed', 'failed', 'blocked', 'interrupted'] as const) {
      const result = await child.report({ runId: 'run-a', status, summary: 'Synthetic outcome' }, f.child.authority);
      assert.equal(result.ok, true);
      const seq = Number(latest(f, 'report.received').seq);
      assert.deepEqual(files(f), [`run-a.${seq}`]);
      unlinkSync(join(hintDirectory(f.root), `run-a.${seq}`));
    }
  }
);

test(
  'B19 rejected and rolled-back reports create no hint; missing hints directory does not fail committed report',
  options,
  async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    const child = service(f);
    const rejected = await child.report({ runId: 'run-a', status: 'blocked', summary: 'Synthetic' }, f.child.authority);
    assert.equal(rejected.ok, false);
    assert.deepEqual(files(f), []);
    await f.startup();
    await child.whoami({}, f.child.authority);
    await f.ledger.transaction((tx) =>
      tx.run(`CREATE TRIGGER reject_report BEFORE INSERT ON events
    WHEN NEW.kind='report.received' BEGIN SELECT RAISE(ABORT,'synthetic_rollback'); END`)
    );
    await assert.rejects(
      child.report({ runId: 'run-a', status: 'completed', summary: 'Synthetic' }, f.child.authority),
      /synthetic_rollback/
    );
    assert.equal(
      f.ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM reports')!.n),
      0
    );
    assert.deepEqual(files(f), []);
    await f.ledger.transaction((tx) => tx.run('DROP TRIGGER reject_report'));
    const withoutDirectory = service(f, join(f.root, 'missing'));
    assert.equal(
      (await withoutDirectory.report({ runId: 'run-a', status: 'completed', summary: 'Synthetic' }, f.child.authority))
        .ok,
      true
    );
    assert.deepEqual(files(f), []);
  }
);

test(
  'B19 legacy callers without a trusted home retain report behavior and do not infer HUD_HOME from env',
  options,
  async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    await f.startup();
    const child = new HandshakeService({
      ledger: f.ledger,
      registration: f.child.registration,
      reader: f.reader,
      env: { HUD_CLAIM: f.claim, HUD_HOME: f.root },
      now: f.now,
    });
    await child.whoami({}, f.child.authority);
    assert.equal(
      (await child.report({ runId: 'run-a', status: 'completed', summary: 'Synthetic' }, f.child.authority)).ok,
      true
    );
    assert.ok(latest(f, 'report.received'));
    assert.deepEqual(files(f), []);
  }
);

for (const terminal of [false, true]) {
  test(
    `B19 ${terminal ? 'terminal import' : 'uncertain reconciliation'} emits committed hint; replay and stale CAS create none`,
    options,
    async (t) => {
      const f = await fixture();
      t.after(() => f.close());
      await f.startup();
      const stale = readReconcileSnapshot(f.ledger, 'run-a');
      const result = await reconcile(f, terminal);
      assert.ok(result.committed);
      assert.equal(result.decision.state, terminal ? 'ended' : 'uncertain');
      const row = latest(f, terminal ? 'run.terminal' : 'run.state');
      assert.deepEqual(files(f), [`run-a.${row.seq}`]);
      unlinkSync(join(hintDirectory(f.root), `run-a.${row.seq}`));
      const replay = await commitReconcile(
        f.ledger,
        readReconcileSnapshot(f.ledger, 'run-a'),
        [],
        1070,
        undefined,
        20,
        f.root
      );
      assert.ok(replay.committed);
      assert.equal(replay.decision.emitTransition, false);
      assert.deepEqual(files(f), []);
      const refused = await commitReconcile(f.ledger, stale, [], 1080, undefined, 20, f.root);
      assert.equal(refused.committed, false);
      assert.deepEqual(files(f), []);
    }
  );
}

async function switched(f: Fixture) {
  const processKey = f.parent.authority.evidence.processKey;
  return authorizeRootCall(f.ledger, {
    callerId: f.parent.context.callerId,
    processKey,
    sessionRef: { ...f.parent.ref, sessionId: 'synthetic-after-clear' },
    evidenceDigest: 'b'.repeat(64),
    premise: f.ledger.snapshot((tx) => scopeSnapshot(tx, f.ledger.ledgerId, processKey)),
    at: 1100,
  });
}

test(
  'B19 same-process generation switch revokes all old registrations atomically and leaves other processes alone',
  options,
  async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    const second = await f.actor('parent-second', 10000, f.parent.ref.sessionId, 10002);
    await acceptIntent(f.ledger, nextIntent(f, 'second', second));
    await acceptIntent(f.ledger, nextIntent(f, 'unrelated', f.child));
    const registrations = await f.ledger.transaction((tx) => [
      recordWakeRegistered(tx, 'link-a', f.registration, 1020),
      recordWakeRegistered(tx, 'link-a', f.registration, 1021),
      recordWakeRegistered(tx, 'link-second', f.registration, 1021),
    ]);
    const unrelated = await f.ledger.transaction((tx) =>
      recordWakeRegistered(
        tx,
        'link-unrelated',
        {
          ...f.registration,
          ownerKey: sessionOwnerKey(f.child.ref),
          parentRef: f.child.ref,
          target: { codexHome: f.root, threadId: f.child.ref.sessionId },
        },
        1021
      )
    );
    await f.ledger.transaction((tx) =>
      recordWakeRevoked(tx, 'link-a', { registrationSeq: registrations[0], reason: 'adapter_rejected' }, 1022)
    );
    const authority = await switched(f);
    assert.equal(authority.generation, 2);
    const rows = f.ledger.snapshot((tx) => tx.all("SELECT payload FROM events WHERE kind='wake.revoked' ORDER BY seq"));
    assert.deepEqual(
      rows.map((row) => JSON.parse(String(row.payload))),
      [
        { reason: 'adapter_rejected', registrationSeq: registrations[0] },
        { reason: 'generation_changed', registrationSeq: registrations[1] },
        { reason: 'generation_changed', registrationSeq: registrations[2] },
      ]
    );
    assert.ok(!rows.some((row) => JSON.parse(String(row.payload)).registrationSeq === unrelated));
    assert.equal(
      f.ledger.snapshot(
        (tx) => tx.get("SELECT closed_at FROM caller_contexts WHERE context_id='context-parent'")!.closed_at
      ),
      1100
    );
    assert.equal(
      f.ledger.snapshot(
        (tx) => tx.get("SELECT closed_at FROM caller_contexts WHERE context_id='context-child'")!.closed_at
      ),
      null
    );
  }
);

test('B19 failed generation switch rolls back revocation with generation closure', options, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.ledger.transaction((tx) => {
    recordWakeRegistered(tx, 'link-a', f.registration, 1020);
    tx.run(`CREATE TRIGGER reject_switch BEFORE UPDATE OF closed_at ON caller_scopes
      BEGIN SELECT RAISE(ABORT,'synthetic_switch_rollback'); END`);
  });
  await assert.rejects(switched(f), /synthetic_switch_rollback/);
  assert.equal(
    f.ledger.snapshot((tx) => tx.get("SELECT count(*) AS n FROM events WHERE kind='wake.revoked'")!.n),
    0
  );
  assert.equal(
    f.ledger.snapshot((tx) => tx.get('SELECT max(generation) AS n FROM caller_scopes')!.n),
    1
  );
  assert.equal(
    f.ledger.snapshot(
      (tx) => tx.get("SELECT closed_at FROM caller_contexts WHERE context_id='context-parent'")!.closed_at
    ),
    null
  );
});

test(
  'B19 parent.offline and wake revocation commit together; duplicate observations do not duplicate revocations',
  options,
  async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    const seq = await f.ledger.transaction((tx) => recordWakeRegistered(tx, 'link-a', f.registration, 1020));
    const payload = { contextId: f.parent.context.contextId, generation: 1, since: 1030, orphanPolicy: 'continue' };
    const offline = await appendRunFact(f.ledger, 'run-a', f.meta.supervisor!, 'parent.offline', payload);
    assert.equal(latest(f, 'parent.offline').seq, offline);
    assert.deepEqual(JSON.parse(String(latest(f, 'wake.revoked').payload)), {
      registrationSeq: seq,
      reason: 'parent_offline',
    });
    await appendRunFact(f.ledger, 'run-a', f.meta.supervisor!, 'parent.offline', payload);
    assert.equal(
      f.ledger.snapshot((tx) => tx.get("SELECT count(*) AS n FROM events WHERE kind='wake.revoked'")!.n),
      1
    );
  }
);

test('B19 parent.offline rolls back if its same-transaction revocation fails', options, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.ledger.transaction((tx) => {
    recordWakeRegistered(tx, 'link-a', f.registration, 1020);
    tx.run(`CREATE TRIGGER reject_revocation BEFORE INSERT ON events WHEN NEW.kind='wake.revoked'
      BEGIN SELECT RAISE(ABORT,'synthetic_revoke_rollback'); END`);
  });
  await assert.rejects(
    appendRunFact(f.ledger, 'run-a', f.meta.supervisor!, 'parent.offline', {
      contextId: f.parent.context.contextId,
      generation: 1,
      since: 1030,
      orphanPolicy: 'continue',
    }),
    /synthetic_revoke_rollback/
  );
  assert.equal(
    f.ledger.snapshot(
      (tx) => tx.get("SELECT count(*) AS n FROM events WHERE kind IN ('wake.revoked','parent.offline')")!.n
    ),
    0
  );
});
