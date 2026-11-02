import assert from 'node:assert/strict';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import { HeadlessRunControl } from '../../src/core/run/control.js';
import { readProcess, processState } from '../../src/core/run/process.js';
import { PrivateLedgerGate } from '../../src/ledger/local-manager.js';
import { appendRunFact } from '../../src/ledger/run-facts.js';
const skip = process.platform !== 'linux' || !ledgerRuntimeSupported();
const helpers = () => import(pathToFileURL(resolve('tests/int/fixture.mjs')).href);

test(
  'H07 narrow signal whitelist requires exact registered writer and valid fields without state changes',
  { skip },
  async () => {
    const { fixture } = await helpers();
    const f = await fixture([process.execPath, '-e', '']);
    try {
      const id = f.input.runId,
        self = readProcess(process.pid)!.stamp;
      await f.port.register(id, f.ticket, f.prepared.run.launchDigest, self);
      const before = await f.port.read(id);
      const payload = { signal: 'SIGHUP', observedAt: Date.now() };
      for (const bad of [
        {},
        { signal: 'SIGKILL', observedAt: Date.now() },
        { ...payload, signal: 2 },
        { ...payload, observedAt: null },
        { ...payload, observedAt: '1' },
        { ...payload, observedAt: -1 },
        { ...payload, observedAt: 0.5 },
        { ...payload, observedAt: Number.MAX_SAFE_INTEGER },
        { ...payload, sender: 'user' },
        { ...payload, subject: self },
      ])
        await assert.rejects(() => f.port.raw(id, self, 'supervisor.signal', bad));
      for (const bad of [
        { ...self, pid: self.pid + 1 },
        { ...self, proc_start: '0' },
        { ...self, boot_id: 'synthetic-other-boot' },
        { ...self, pid_domain: 'synthetic-other-domain' },
      ])
        await assert.rejects(
          () => appendRunFact(f.ledger, id, bad, 'supervisor.signal', payload),
          /writer_not_registered/
        );
      // Timestamp precedes registration to model an honest handler after a wall-clock rollback.
      const observedAt = before.run.createdAt - 1000;
      const seq = await f.port.raw(id, self, 'supervisor.signal', { signal: 'SIGHUP', observedAt });
      const after = await f.port.read(id),
        event = after.events.find((e: any) => e.seq === seq);
      assert.deepEqual(event.payload, { signal: 'SIGHUP', observedAt });
      assert.equal(event.runId, id);
      assert.equal(event.linkId, before.run.linkId);
      assert.deepEqual(after.run, before.run);
      assert.equal(after.slotHeld, true);
      assert.equal(after.receipt, null);
      assert.equal(after.events.filter((e: any) => e.kind === 'supervisor.signal').length, 1);
      assert.equal(
        after.events.some((e: any) => ['command.exited', 'cancel.accepted', 'cancel.step'].includes(e.kind)),
        false
      );
      assert.deepEqual(after.facts, before.facts);
      await f.ledger.transaction((tx: any) =>
        tx.run(
          "UPDATE events SET payload=json_set(payload,'$.supervisor.boot_id','synthetic-corrupt') WHERE run_id=? AND kind='supervisor.registered'",
          id
        )
      );
      await assert.rejects(
        () => appendRunFact(f.ledger, id, self, 'supervisor.signal', payload),
        /writer_not_registered/
      );
    } finally {
      await f.cleanup();
    }
  }
);

for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const)
  test(`H07 real headless supervisor receives ${signal} while its harness remains alive`, { skip }, async () => {
    const { fixture, cli, until } = await helpers();
    const f = await fixture([
      process.execPath,
      '-e',
      "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});console.log('ready');setTimeout(()=>{},60000)",
    ]);
    try {
      const supervisor = cli(f, ['start'], { input: f.input, ticket: f.ticket });
      const meta = await until(async () => {
        const s = await f.port.read(f.input.runId);
        return s.run.state === 'running' && s.meta;
      });
      await until(() => readFileSync(join(f.home, 'runs', f.input.runId, 'stdout.log'), 'utf8').includes('ready'));
      const observedBefore = Date.now();
      process.kill(supervisor.child.pid, signal);
      const current = await until(async () => {
        const s = await f.port.read(f.input.runId);
        return (
          s.events.some((e: any) => e.kind === 'supervisor.signal') &&
          s.events.some((e: any) => e.kind === 'cancel.step') &&
          s
        );
      });
      const events = current.events.filter((e: any) => e.kind === 'supervisor.signal');
      assert.equal(events.length, 1);
      assert.equal(events[0].payload.signal, signal);
      assert.ok(events[0].payload.observedAt >= observedBefore && events[0].payload.observedAt <= events[0].at);
      assert.equal(processState(meta.harness), 'alive');
      assert.equal(current.slotHeld, true);
      assert.equal(current.receipt, null);
      assert.equal(
        current.events.some((e: any) => e.kind === 'command.exited'),
        false
      );
      // Duplicate delivery preserves the original cancellation sequence and ladder.
      process.kill(supervisor.child.pid, signal);
      await until(
        async () =>
          (await f.port.read(f.input.runId)).events.filter((e: any) => e.kind === 'supervisor.signal').length === 2
      );
      const duplicate = await f.port.read(f.input.runId);
      assert.equal(duplicate.events.filter((e: any) => e.kind === 'cancel.accepted').length, 1);
      assert.deepEqual(
        duplicate.events.filter((e: any) => e.kind === 'cancel.step').map((e: any) => e.payload.signal),
        ['SIGINT']
      );
      process.kill(meta.harness.pid, 'SIGKILL');
      assert.equal((await supervisor.done).code, 0, supervisor.stderr());
    } finally {
      await f.cleanup();
    }
  });

for (const boundary of ['before', 'after'] as const)
  test(
    `H07 signal ${boundary} terminal import remains a partial fact and preserves normal scope end`,
    { skip },
    async () => {
      const { fixture, until } = await helpers();
      const f = await fixture([process.execPath, '-e', 'setTimeout(()=>process.exit(0),200)']);
      const id = f.input.runId;
      let running: Promise<void> | undefined;
      const originalRaw = f.port.raw.bind(f.port);
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      let observed = false;
      f.port.raw = async (runId: string, stamp: any, kind: string, payload: any) => {
        if (kind === 'supervisor.signal') {
          observed = true;
          await gate;
        }
        return originalRaw(runId, stamp, kind, payload);
      };
      const receipt = f.port.receipt.bind(f.port);
      const reconcile = f.port.reconcile.bind(f.port);
      try {
        const fire = async () => {
          process.kill(process.pid, 'SIGHUP');
          await until(() => observed);
        };
        if (boundary === 'before')
          f.port.receipt = async (...args: any[]) => {
            await fire();
            return receipt(...args);
          };
        else
          f.port.reconcile = async (...args: any[]) => {
            const result = await reconcile(...args);
            if ((await f.port.read(id)).run.state === 'ended' && !observed) await fire();
            return result;
          };
        const control = new HeadlessRunControl(f.port, f.home, new PrivateLedgerGate(f.home).actor());
        let settled = false;
        running = control.start({ input: f.input, ticket: f.ticket });
        running
          .finally(() => {
            settled = true;
          })
          .catch(() => {});
        await until(() => observed);
        await until(async () => (await f.port.read(id)).run.state === 'ended');
        await sleep(20);
        assert.equal(settled, false, 'start must drain the observed pending fact');
        release();
        await running;
        const final = await f.port.read(id);
        assert.equal(final.run.state, 'ended');
        assert.equal(final.receipt.reason, 'scope_ended');
        assert.equal(final.receipt.native_exit, null);
        assert.equal(final.slotHeld, false);
        assert.equal(final.events.filter((e: any) => e.kind === 'supervisor.signal').length, 1);
        assert.equal(
          final.events.some((e: any) => e.kind === 'cancel.step'),
          false
        );
        await assert.rejects(
          () => f.port.raw(id, final.run.supervisor, 'clock.anomaly', { wallDeltaMs: 0, monoDeltaMs: 0 }),
          /writer_terminal/
        );
      } finally {
        release();
        await running?.catch(() => {});
        await f.cleanup();
      }
    }
  );

for (const writeFails of [false, true])
  test(
    `H07 in-flight duplicate coalesces and ${writeFails ? 'failed' : 'delayed'} fact cannot supply an exit`,
    { skip },
    async () => {
      const { fixture, until } = await helpers();
      const f = await fixture([
        process.execPath,
        '-e',
        "process.on('SIGINT',()=>{});console.log('ready');setTimeout(()=>{},60000)",
      ]);
      const originalRaw = f.port.raw.bind(f.port);
      let calls = 0;
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      f.port.raw = async (id: string, stamp: any, kind: string, payload: any) => {
        if (kind === 'supervisor.signal') {
          calls++;
          await gate;
          if (writeFails) throw new Error('synthetic signal write gap');
        }
        return originalRaw(id, stamp, kind, payload);
      };
      let running: Promise<void> | undefined;
      let harness: import('../../src/core/types/supervision.js').ProcessStamp | undefined;
      try {
        const control = new HeadlessRunControl(f.port, f.home, new PrivateLedgerGate(f.home).actor());
        running = control.start({ input: f.input, ticket: f.ticket });
        const meta = await until(
          async () => (await f.port.read(f.input.runId)).meta?.scope && (await f.port.read(f.input.runId)).meta
        );
        harness = meta.harness;
        await until(() => readFileSync(join(f.home, 'runs', f.input.runId, 'stdout.log'), 'utf8').includes('ready'));
        process.kill(process.pid, 'SIGHUP');
        await until(() => calls === 1);
        process.kill(process.pid, 'SIGHUP');
        await sleep(30);
        assert.equal(calls, 1);
        process.kill(process.pid, 'SIGTERM');
        await until(() => calls === 2);
        await until(async () => (await f.port.read(f.input.runId)).events.some((e: any) => e.kind === 'cancel.step'));
        const partial = await f.port.read(f.input.runId);
        assert.equal(partial.receipt, null);
        assert.equal(partial.slotHeld, true);
        assert.equal(processState(harness!), 'alive');
        assert.equal(
          partial.events.some((e: any) => e.kind === 'command.exited'),
          false
        );
        assert.equal(partial.events.filter((e: any) => e.kind === 'cancel.accepted').length, 1);
        assert.equal(partial.events.filter((e: any) => e.kind === 'cancel.step').length, 1);
        release();
        if (!writeFails)
          await until(
            async () =>
              (await f.port.read(f.input.runId)).events.filter((e: any) => e.kind === 'supervisor.signal').length === 2
          );
        process.kill(harness!.pid, 'SIGKILL');
        await running;
        assert.equal(
          (await f.port.read(f.input.runId)).events.filter((e: any) => e.kind === 'supervisor.signal').length,
          writeFails ? 0 : 2
        );
      } finally {
        release();
        if (harness && processState(harness) === 'alive') {
          try {
            process.kill(harness.pid, 'SIGKILL');
          } catch {}
        }
        await running?.catch(() => {});
        await f.cleanup();
      }
    }
  );

test(
  'H07 cancel-acceptance failure cannot erase the independently persisted signal observation',
  { skip },
  async () => {
    const { fixture, until } = await helpers();
    const f = await fixture([process.execPath, '-e', 'setTimeout(()=>process.exit(0),500)']);
    let attempts = 0;
    f.port.acceptCancel = async () => {
      attempts++;
      throw new Error('synthetic cancel failure');
    };
    try {
      const control = new HeadlessRunControl(f.port, f.home, new PrivateLedgerGate(f.home).actor());
      const running = control.start({ input: f.input, ticket: f.ticket });
      await until(async () => (await f.port.read(f.input.runId)).meta?.scope);
      process.kill(process.pid, 'SIGHUP');
      await until(async () =>
        (await f.port.read(f.input.runId)).events.some((e: any) => e.kind === 'supervisor.signal')
      );
      await running;
      const final = await f.port.read(f.input.runId);
      assert.equal(attempts, 1);
      assert.equal(final.events.filter((e: any) => e.kind === 'supervisor.signal').length, 1);
      assert.equal(
        final.events.some((e: any) => e.kind === 'cancel.accepted' || e.kind === 'cancel.step'),
        false
      );
      assert.equal(final.run.state, 'ended');
      assert.equal(final.receipt.reason, 'scope_ended');
    } finally {
      await f.cleanup();
    }
  }
);

test(
  'H07 early registered setup failure removes every handler and closes opened artifact descriptors',
  { skip },
  async () => {
    const { fixture } = await helpers();
    const f = await fixture([process.execPath, '-e', '']);
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const listeners = signals.map((signal) => process.listenerCount(signal));
    const read = f.port.read.bind(f.port);
    let calls = 0;
    f.port.read = async (...args: any[]) => {
      if (++calls === 2) throw new Error('synthetic initial-read failure');
      return read(...args);
    };
    try {
      const control = new HeadlessRunControl(f.port, f.home, new PrivateLedgerGate(f.home).actor());
      await assert.rejects(() => control.start({ input: f.input, ticket: f.ticket }), /synthetic initial-read failure/);
      assert.deepEqual(
        signals.map((signal) => process.listenerCount(signal)),
        listeners
      );
      const leaked = readdirSync('/proc/self/fd')
        .flatMap((fd) => {
          try {
            return [readlinkSync(`/proc/self/fd/${fd}`)];
          } catch {
            return [];
          }
        })
        .filter((path) => path.startsWith(join(f.home, 'runs')));
      assert.deepEqual(leaked, []);
      assert.equal(
        (await read(f.input.runId)).events.some((e: any) => e.kind === 'launch.submitting'),
        false
      );
    } finally {
      f.port.read = read;
      await f.cleanup();
    }
  }
);
