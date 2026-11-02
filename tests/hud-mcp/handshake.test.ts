import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import { HandshakeService } from '../../packages/hud-mcp/src/handshake.js';
import { handshakeFixture } from '../unit/b45-handshake-fixture.js';
const skip = ledgerRuntimeSupported() ? false : 'Ledger requires Node 22 >=22.13 or >=24';

for (const transport of ['env', 'parameter'] as const)
  test(`B45 whoami ${transport} claim binds exact independently observed launch and report`, { skip }, async () => {
    const f = await handshakeFixture();
    try {
      await f.startup();
      const env = transport === 'env' ? { HUD_CLAIM: f.claim, HUD_RUN: 'run-a', HUD_LINK: 'link-a' } : {};
      const service = new HandshakeService({
        ledger: f.ledger,
        registration: f.child.registration,
        reader: f.reader,
        env,
        now: f.now,
      });
      assert.equal(
        (await service.whoami(transport === 'parameter' ? { claim: f.claim } : {}, f.child.authority)).ok,
        true
      );
      const report = await service.report(
        { runId: 'run-a', status: 'completed', summary: 'Synthetic complete', reportPath: '/synthetic/report.md' },
        f.child.authority
      );
      assert.equal(report.ok, true);
      const rows = f.ledger.snapshot((tx) => ({
        claim: tx.get('SELECT * FROM claims'),
        link: tx.get('SELECT * FROM links'),
        run: tx.get('SELECT * FROM runs'),
        events: tx.all('SELECT * FROM events ORDER BY seq'),
        slots: tx.all('SELECT * FROM slots'),
      }));
      assert.equal(rows.claim?.state, 'redeemed');
      assert.equal(rows.link?.state, 'reported');
      assert.equal(rows.run?.state, 'starting');
      assert.equal(rows.slots.length, 1);
      assert.equal(rows.slots[0].slot_key, rows.run?.target_session_ref);
      const event = rows.events.find((event) => event.kind === 'report.received')!;
      assert.deepEqual(JSON.parse(String(event.payload)), { reportId: report.ok ? report.reportId : '' });
      assert.ok(
        rows.events.findIndex((event) => event.kind === 'claim.redeemed') <
          rows.events.findIndex((event) => event.kind === 'child.bound')
      );
      assert.equal(JSON.stringify(rows).includes(f.claim), false);
    } finally {
      await f.close();
    }
  });

test('B45 whoami launch evidence missing stays pending; env conflicts and wrong run refuse', { skip }, async () => {
  const f = await handshakeFixture();
  try {
    const service = new HandshakeService({
      ledger: f.ledger,
      registration: f.child.registration,
      reader: f.reader,
      env: { HUD_CLAIM: f.claim },
      now: f.now,
    });
    assert.deepEqual(await service.whoami({}, f.child.authority), {
      ok: true,
      state: 'pending',
      runId: 'run-a',
      linkId: 'link-a',
      reason: 'independent_evidence_missing',
    });
    assert.equal(
      f.ledger.snapshot((tx) => tx.get('SELECT state FROM claims')?.state),
      'armed'
    );
    await assert.rejects(service.whoami({ claim: 'different' }, f.child.authority), /claim_conflict/);
    await assert.rejects(
      new HandshakeService({
        ledger: f.ledger,
        registration: f.child.registration,
        reader: f.reader,
        env: { HUD_CLAIM: f.claim, HUD_RUN: 'run-other' },
        now: f.now,
      }).whoami({}, f.child.authority),
      /claim_anchor_mismatch/
    );
    await f.startup();
    assert.equal((await service.whoami({}, f.child.authority)).ok, true);
  } finally {
    await f.close();
  }
});

test(
  'B45 copied fork claim refuses before consumption, expiry boundary and bound retry after TTL',
  { skip },
  async () => {
    const f = await handshakeFixture();
    try {
      await f.startup();
      const fork = await f.actor('fork', 30000, 'synthetic-fork');
      const service = (registration = f.child.registration) =>
        new HandshakeService({
          ledger: f.ledger,
          registration,
          reader: f.reader,
          env: { HUD_CLAIM: f.claim },
          now: f.now,
        });
      await assert.rejects(service(fork.registration).whoami({}, fork.authority), /claim_anchor_mismatch/);
      assert.equal(
        f.ledger.snapshot((tx) => tx.get('SELECT state FROM claims')?.state),
        'armed'
      );
      f.setNow(1801000);
      await assert.rejects(service().whoami({}, f.child.authority), /claim_expired/);
      f.setNow(1800999);
      assert.equal((await service().whoami({}, f.child.authority)).ok, true);
      f.setNow(1802000);
      assert.equal((await service().whoami({}, f.child.authority)).ok, true);
      assert.equal(
        f.ledger.snapshot((tx) => tx.get("SELECT count(*) AS n FROM events WHERE kind='claim.redeemed'")?.n),
        1
      );
      assert.equal(
        f.ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM child_bindings')?.n),
        1
      );
    } finally {
      await f.close();
    }
  }
);

test(
  'B45 same-process MCP restart rebuilds binding with independent proof and never redeems twice',
  { skip },
  async () => {
    const f = await handshakeFixture();
    try {
      await f.startup();
      const first = new HandshakeService({
        ledger: f.ledger,
        registration: f.child.registration,
        reader: f.reader,
        env: { HUD_CLAIM: f.claim },
        now: f.now,
      });
      await first.whoami({}, f.child.authority);
      const restart = await f.actor('restart', 20000, 'synthetic-child', 20002);
      const service = new HandshakeService({
        ledger: f.ledger,
        registration: restart.registration,
        reader: f.reader,
        env: { HUD_CLAIM: f.claim },
        now: f.now,
      });
      assert.equal(
        (await service.report({ runId: 'run-a', status: 'completed', summary: 'Before rebinding' }, restart.authority))
          .ok,
        false
      );
      f.setNow(1802000);
      assert.equal((await service.whoami({}, restart.authority)).ok, true);
      assert.equal(
        (await service.report({ runId: 'run-a', status: 'completed', summary: 'After rebinding' }, restart.authority))
          .ok,
        true
      );
      assert.equal(
        f.ledger.snapshot((tx) => tx.get("SELECT count(*) AS n FROM events WHERE kind='claim.redeemed'")?.n),
        1
      );
      assert.equal(
        f.ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM child_bindings WHERE is_current=1')?.n),
        1
      );
      assert.equal(
        (await first.report({ runId: 'run-a', status: 'completed', summary: 'Old instance' }, f.child.authority)).ok,
        false
      );
    } finally {
      await f.close();
    }
  }
);

test(
  'B45 identity ProcessKey and run stamp keep their distinct domain encodings on the same host',
  { skip },
  async () => {
    const f = await handshakeFixture(true);
    try {
      await f.startup();
      assert.notEqual(f.reader.domain().pidDomain, f.meta.harness!.pid_domain);
      const service = new HandshakeService({
        ledger: f.ledger,
        registration: f.child.registration,
        reader: f.reader,
        env: { HUD_CLAIM: f.claim },
        now: f.now,
      });
      assert.equal((await service.whoami({}, f.child.authority)).ok, true);
      const wrongNamespace = {
        get: f.reader.get,
        domain: () => ({ ...f.reader.domain(), runPidDomain: 'other-machine-pidns' }),
      };
      await assert.rejects(
        new HandshakeService({
          ledger: f.ledger,
          registration: f.child.registration,
          reader: wrongNamespace,
          env: { HUD_CLAIM: f.claim },
          now: f.now,
        }).whoami({}, f.child.authority),
        /claim_anchor_mismatch/
      );
    } finally {
      await f.close();
    }
  }
);
