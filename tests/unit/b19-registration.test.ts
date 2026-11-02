import assert from 'node:assert/strict';
import test from 'node:test';
import { notifyFixture, nextIntent, acceptIntent } from './b21-fixture.js';
import { recordWakeRegistered } from '../../src/ledger/notify-events.js';
import { readLink } from '../../src/ledger/records.js';
import { readWakeState, wakeProjection } from '../../packages/hud-mcp/src/wake-state.js';
import { parentWakeRegistration } from '../../packages/hud-mcp/src/wake-registration.js';
import { wakeMessage } from '../../src/core/wake/message.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
const skip = !ledgerRuntimeSupported();

test(
  'B19 registration shares fresh intent rollback and never runs on replay or capacity refusal',
  { skip },
  async (t) => {
    const f = await notifyFixture();
    t.after(() => f.close());
    const input = nextIntent(f, 'wake');
    let calls = 0;
    const write = (tx: Parameters<typeof recordWakeRegistered>[0]) => {
      calls++;
      recordWakeRegistered(tx, input.link.linkId, f.registration, Date.now());
    };
    await assert.rejects(
      acceptIntent(f.ledger, input, 20, undefined, {}, (tx) => {
        write(tx);
        throw new Error('synthetic_rollback');
      }),
      /synthetic_rollback/
    );
    assert.equal(
      f.ledger.snapshot((tx) => tx.get('SELECT 1 FROM runs WHERE run_id=?', input.run.runId)),
      undefined
    );
    assert.equal(
      f.ledger.snapshot((tx) =>
        tx.get("SELECT 1 FROM events WHERE link_id=? AND kind='wake.registered'", input.link.linkId)
      ),
      undefined
    );
    const accepted = await acceptIntent(f.ledger, input, 20, undefined, {}, write);
    assert.equal(accepted.replayed, false);
    const replay = await acceptIntent(f.ledger, input, 20, undefined, { maxActiveRuns: 1 }, write);
    assert.equal(replay.replayed, true);
    const full = await acceptIntent(f.ledger, nextIntent(f, 'full'), 20, undefined, { maxActiveRuns: 1 }, write);
    assert.equal((full.outcome as { code: string }).code, 'concurrency_limit');
    assert.equal(calls, 2);
  }
);

test(
  'B19 verified facts choose Claude exact arm command and Codex/pi endpoints, otherwise none',
  { skip },
  async (t) => {
    const f = await notifyFixture();
    t.after(() => f.close());
    const stamp = f.meta.supervisor;
    assert.ok(stamp);
    const context = f.parent.context;
    const codex = parentWakeRegistration(context, f.parent.registration, f.root, stamp, '/synthetic/codex');
    assert.equal(codex.adapter, 'codex_queue_v1');
    assert.deepEqual(codex.target, { codexHome: f.root, threadId: f.parent.ref.sessionId });
    assert.equal(parentWakeRegistration(context, f.parent.registration, f.root, stamp).adapter, 'none');
    const claude = parentWakeRegistration(
      { ...context, harness: 'claude', sessionRef: { ...f.parent.ref, harness: 'claude' } },
      f.parent.registration,
      f.root,
      stamp
    );
    assert.equal(claude.adapter, 'claude_background_wait_v1');
    const pi = parentWakeRegistration(
      { ...context, harness: 'pi', sessionRef: { ...f.parent.ref, harness: 'pi' } },
      f.parent.registration,
      f.root,
      stamp
    );
    assert.equal(pi.adapter, 'pi_extension_v1');
    assert.deepEqual(pi.target, { socketPath: `${f.root}/wake/pi-${stamp.pid}-${stamp.proc_start}.sock` });
    await f.ledger.transaction((tx) => recordWakeRegistered(tx, 'link-a', f.registration, Date.now()));
    const state = f.ledger.snapshot((tx) => readWakeState(tx, readLink(tx, 'link-a')))!;
    state.registration = { ...state.registration, adapter: 'claude_background_wait_v1', target: {} };
    const projected = wakeProjection(state, "/synthetic/hud space's", 'run-a', 42);
    assert.equal(projected.wake.state, 'registered');
    assert.equal(
      projected.advice.wake.armCommand,
      "HUD_HOME='/synthetic/hud space'\\''s' hud run wait 'run-a' --after-seq 42 --owner-generation 1 --notify"
    );
  }
);

test('B19 native message is bounded, contains cursor rule and only IDs/kinds/sequences', () => {
  const details = {
    linkId: 'synthetic-link',
    contextGeneration: 1,
    throughSeq: 420,
    runs: [{ runId: 'synthetic-run', kind: 'report.received', seq: 420 }],
  };
  const line = wakeMessage(details);
  assert.ok(Buffer.byteLength(line) <= 512);
  assert.match(line, /run=synthetic-run/);
  assert.match(line, /afterSeq:<your cursor>/);
  assert.match(line, /drain until hasMore=false/);
  assert.doesNotMatch(line, /seq.?1|\/synthetic\//);
  assert.ok(Buffer.byteLength(wakeMessage({ ...details, linkId: 'x'.repeat(4096) })) <= 512);
});
