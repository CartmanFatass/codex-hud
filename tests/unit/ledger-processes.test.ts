import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ledgerRuntimeSupported, LEDGER_RUNTIME_REQUIREMENT } from '../../src/ledger/runtime.js';

const skip = ledgerRuntimeSupported()
  ? false
  : `Ledger process acceptance requires ${LEDGER_RUNTIME_REQUIREMENT}; found ${process.versions.node}.`;
const options = { skip, timeout: 20000 };

type Message = {
  id?: number;
  type?: string;
  error?: string;
  code?: string;
  stack?: string;
  result?: any;
  label?: string;
};

/** Every fork is registered before it can run and reaped before its temporary HUD_HOME is removed. */
class LedgerProcess {
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  private serial = 0;
  private messages: Message[] = [];
  private waiters: Array<{
    match: (message: Message) => boolean;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
  }> = [];
  private stderr = '';
  private ended = false;

  constructor(home: string) {
    this.child = fork(resolve('tests/ledger/process.mjs'), [resolve(home, 'ledger.sqlite')], {
      env: { ...process.env, HUD_HOME: home, HERDR_ENV: undefined },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: [],
    });
    this.child.stderr!.on('data', (chunk) => {
      this.stderr += String(chunk);
    });
    this.child.on('message', (message: Message) => {
      const index = this.waiters.findIndex((waiter) => waiter.match(message));
      if (index < 0) this.messages.push(message);
      else this.waiters.splice(index, 1)[0].resolve(message);
    });
    this.child.on('error', (error) => {
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    });
    this.exited = new Promise((done) =>
      this.child.once('exit', (code, signal) => {
        this.ended = true;
        const error = new Error(`ledger child exited (${code ?? signal}): ${this.stderr}`);
        for (const waiter of this.waiters.splice(0)) waiter.reject(error);
        done();
      })
    );
  }

  wait(match: (message: Message) => boolean): Promise<Message> {
    const index = this.messages.findIndex(match);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    if (this.ended) return Promise.reject(new Error(`ledger child already exited: ${this.stderr}`));
    return new Promise((resolve, reject) => this.waiters.push({ match, resolve, reject }));
  }

  async request(action: string, fields: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.serial;
    const response = this.wait((message) => message.id === id);
    this.child.send({ id, action, ...fields });
    const message = await response;
    if (message.error) throw Object.assign(new Error(message.stack ?? message.error), { code: message.code });
    return message.result;
  }

  async kill(): Promise<void> {
    if (!this.ended) this.child.kill('SIGKILL');
    await this.exited;
  }

  async close(): Promise<void> {
    await this.request('close');
    await this.exited;
  }
}

async function fixture(t: TestContext) {
  const home = await mkdtemp(resolve(tmpdir(), 'hud-ledger-process-'));
  const children: LedgerProcess[] = [];
  t.after(async () => {
    await Promise.all(children.map((child) => child.kill()));
    await rm(home, { recursive: true, force: true });
  });
  async function child() {
    const process = new LedgerProcess(home);
    children.push(process);
    await process.wait((message) => message.type === 'ready');
    return process;
  }
  const seed = await child();
  await seed.request('seed');
  return { home, child, seed };
}

function assertComplete(rows: any, expected: number) {
  for (const table of ['links', 'runs', 'claims', 'slots', 'idempotency'])
    assert.equal(rows[table].length, expected, `${table} must commit with the intent`);
  assert.equal(rows.events.filter((event: any) => event.kind === 'intent.accepted').length, expected);
  assert.deepEqual(rows.integrity, { integrity: ['ok'], foreignKeys: [] });
  if (expected) {
    assert.equal(rows.claims[0].run_id, rows.runs[0].run_id);
    assert.equal(rows.slots[0].run_id, rows.runs[0].run_id);
    assert.equal(rows.idempotency[0].run_id, rows.runs[0].run_id);
    assert.equal(rows.links[0].link_id, rows.runs[0].link_id);
  }
}

async function concurrentIntents(
  t: TestContext,
  requests: Array<{ child: LedgerProcess; fields: Record<string, unknown> }>
) {
  // Both ready OS processes receive their first attempt before either response is awaited.
  const first = await Promise.allSettled(requests.map(({ child, fields }) => child.request('intent', fields)));
  assert.ok(
    first.some((result) => result.status === 'fulfilled'),
    'a competing first attempt must commit'
  );
  // By now the competitor has responded after COMMIT. Retry only an explicit busy
  // rejection, exactly once, preserving the original request key and parameters.
  return Promise.allSettled(
    first.map((result, index) => {
      if (result.status === 'fulfilled') return Promise.resolve(result.value);
      if (result.reason.code !== 'ledger_busy') return Promise.reject(result.reason);
      t.diagnostic(
        'Concurrent intent exhausted its 20 ms busy budget; retrying the same request once after the competitor committed.'
      );
      return requests[index].child.request('intent', requests[index].fields);
    })
  );
}

test('ledger processes: concurrent identical request keys replay one complete intent and slot', options, async (t) => {
  const f = await fixture(t);
  const other = await f.child();
  const settled = await concurrentIntents(t, [
    { child: f.seed, fields: { variant: 'one' } },
    { child: other, fields: { variant: 'two' } },
  ]);
  const results = settled.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
  assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
  assert.deepEqual(results[0].outcome, results[1].outcome);
  assert.equal(results[0].runId, results[1].runId);
  const rows = await f.seed.request('inspect');
  assertComplete(rows, 1);
  assert.equal(rows.runs[0].run_id, results[0].runId);
});

test(
  'ledger processes: concurrent same key with different parameters rejects the losing request',
  options,
  async (t) => {
    const f = await fixture(t);
    const other = await f.child();
    const results = await concurrentIntents(t, [
      { child: f.seed, fields: { variant: 'one', auditClock: 'eligible' } },
      { child: other, fields: { variant: 'two', changed: true, auditClock: 'eligible' } },
    ]);
    const accepted = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 1);
    assert.match((rejected[0] as PromiseRejectedResult).reason.message, /idempotency_conflict/);
    const rows = await f.seed.request('inspect');
    assertComplete(rows, 1);
    assert.equal(rows.runs[0].run_id, (accepted[0] as PromiseFulfilledResult<any>).value.runId);
    const audit = rows.events.filter((event: any) => event.kind === 'intent.rejected');
    assert.equal(audit.length, 1);
    assert.deepEqual(JSON.parse(audit[0].payload), { requestKey: 'same-key', reason: 'idempotency_conflict' });
    assert.equal(audit[0].link_id, null);
    assert.equal(audit[0].run_id, null);
    const clocks = await Promise.all([f.seed, other].map((child) => child.request('audit-clock-observation')));
    assert.deepEqual(clocks.map((clock) => clock.transactions).sort(), [1, 2]);
    assert.deepEqual(clocks.map((clock) => clock.rollbacks).sort(), [0, 1]);
    assert.ok(clocks.every((clock) => clock.mode === 'eligible' && clock.now === 0 && clock.restored));
  }
);

test(
  'ledger processes: exhausted rejection-audit budget preserves concurrent conflict without a new transaction',
  options,
  async (t) => {
    const f = await fixture(t);
    const other = await f.child();
    const results = await concurrentIntents(t, [
      { child: f.seed, fields: { variant: 'one', auditClock: 'exhausted' } },
      { child: other, fields: { variant: 'two', changed: true, auditClock: 'exhausted' } },
    ]);
    const accepted = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 1);
    assert.match((rejected[0] as PromiseRejectedResult).reason.message, /idempotency_conflict/);
    const rows = await f.seed.request('inspect');
    assertComplete(rows, 1);
    assert.equal(rows.runs[0].run_id, (accepted[0] as PromiseFulfilledResult<any>).value.runId);
    assert.equal(rows.events.filter((event: any) => event.kind === 'intent.rejected').length, 0);
    const clocks = await Promise.all([f.seed, other].map((child) => child.request('audit-clock-observation')));
    // The losing request reaches the deadline only after rollback. Optional auditing must not
    // call ledger.transaction at all, even if a second transaction could later acquire its lock.
    assert.deepEqual(clocks.map((clock) => clock.transactions).sort(), [1, 1]);
    assert.deepEqual(clocks.map((clock) => clock.rollbacks).sort(), [0, 1]);
    assert.deepEqual(
      clocks.map((clock) => clock.now).sort((a, b) => a - b),
      [0, 20]
    );
    assert.ok(clocks.every((clock) => clock.mode === 'exhausted' && clock.restored));
  }
);

for (const cut of [
  'insert:links',
  'insert:runs',
  'insert:claims',
  'insert:slots',
  'insert:idempotency',
  'insert:events',
  'insert:events:2',
  'before:commit',
  'after:commit',
]) {
  test(`ledger processes: SIGKILL at ${cut} recovers an atomic intent without a double slot`, options, async (t) => {
    const f = await fixture(t);
    const ledgerId = (await f.seed.request('inspect')).ledgerId;
    await f.seed.close();
    const writer = await f.child();
    // Attach the rejection handler before killing the process to avoid an unhandled rejection.
    const interrupted = writer.request('intent', { variant: 'one', cut, workspace: true }).catch((error) => error);
    const reached = await writer.wait((message) => message.type === 'cut');
    assert.equal(reached.label, cut);
    await writer.kill();
    assert.equal(writer.child.signalCode, 'SIGKILL');
    assert.ok((await interrupted) instanceof Error);
    const recovered = await f.child();
    const before = await recovered.request('inspect');
    assert.equal(before.ledgerId, ledgerId);
    assertComplete(before, cut === 'after:commit' ? 1 : 0);
    const retry = await recovered.request('intent', { variant: 'one', workspace: true });
    assert.equal(retry.replayed, cut === 'after:commit');
    assert.equal(retry.runId, 'run-one');
    const replay = await recovered.request('intent', { variant: 'two' });
    assert.equal(replay.replayed, true);
    assert.equal(replay.runId, retry.runId);
    const after = await recovered.request('inspect');
    assertComplete(after, 1);
    assert.equal(after.events.filter((event: any) => event.kind === 'workspace.captured').length, 1);
  });
}

test(
  'ledger processes: the gathered reconcile evidence can commit against an unchanged snapshot',
  options,
  async (t) => {
    const f = await fixture(t);
    await f.seed.request('intent', { variant: 'one' });
    await f.seed.request('snapshot');
    const result = await f.seed.request('reconcile');
    assert.equal(result.committed, true);
    assert.equal(result.decision.state, 'failed');
    const rows = await f.seed.request('inspect');
    assert.equal(rows.runs[0].state, 'failed');
    assert.equal(rows.slots.length, 0);
  }
);

for (const mutation of ['cancel', 'terminate', 'conflict']) {
  test(
    `ledger processes: stale reconcile after actual write-lock contention preserves ${mutation}`,
    options,
    async (t) => {
      const f = await fixture(t);
      await f.seed.request('intent', { variant: 'one' });
      const reconciler = await f.child();
      const writer = await f.child();
      await reconciler.request('snapshot');
      const barrier = resolve(f.home, `busy-${mutation}`);
      const holding = writer.request('hold', { mutation, barrier });
      void holding.catch(() => {});
      // Do not start the stale commit until the other OS process owns BEGIN IMMEDIATE.
      await writer.wait((message) => message.type === 'locked');
      let result = await reconciler.request('reconcile', { barrier });
      const busyAttempts = result.busyAttempts;
      await holding;
      // A loaded OS may deschedule a child for longer than the public 20 ms budget.
      // Make one explicit caller retry after the holder commits, using the SAME
      // gathered snapshot. This must still refuse stale evidence before any insert.
      if (result.lockBudgetExhausted) {
        t.diagnostic(
          `Reconcile exhausted its 20 ms budget after ${busyAttempts} actual busy attempts; retrying once with the original snapshot after the holder committed.`
        );
        result = await reconciler.request('reconcile');
      }
      assert.equal(result.committed, false);
      assert.equal(result.reason, 'stale_snapshot');
      assert.ok(busyAttempts >= 1, 'must observe a real SQLite busy failure before retrying');
      const rows = await f.seed.request('inspect');
      assert.deepEqual(rows.integrity, { integrity: ['ok'], foreignKeys: [] });
      assert.equal(
        rows.evidence.some((row: any) => row.evidence_id === 'stale-never-submitted'),
        false
      );
      if (mutation === 'cancel') {
        assert.equal(rows.runs[0].state, 'cancelling');
        assert.equal(rows.runs[0].cancel_requested_at, 1005);
        assert.equal(rows.slots.length, 1);
      } else if (mutation === 'terminate') {
        assert.equal(rows.runs[0].state, 'ended');
        assert.equal(rows.runs[0].terminal_evidence_id, 'new-terminal');
        assert.equal(rows.runs[0].exit_code, 0);
        assert.equal(rows.slots.length, 0);
      } else {
        assert.equal(rows.runs[0].state, 'starting');
        assert.equal(rows.slots.length, 1);
        assert.equal(rows.evidence.find((row: any) => row.evidence_id === 'new-conflict')?.validation, 'accepted');
      }
    }
  );
}
