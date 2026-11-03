import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Ledger, openLedger } from '../../src/ledger/ledger.js';
import { CallBudget, type BudgetClock } from '../../src/ledger/call-budget.js';
import type { PreparedIntent } from '../../src/ledger/types.js';

/** Trusted deterministic dependency, not a global clock or request timestamp. */
export class TestBudgetClock implements BudgetClock {
  time = 0;
  sleepExtra = 0;
  now = () => this.time;
  sleep = async (ms: number) => {
    this.time += ms + this.sleepExtra;
  };
  advance(ms: number) {
    this.time += ms;
  }
  budget() {
    return new CallBudget(this);
  }
}
export async function budgetFixture() {
  const home = mkdtempSync(join(tmpdir(), 'p065-synthetic-'));
  const file = join(home, 'ledger.sqlite');
  const original = await openLedger(file);
  const id = original.ledgerId;
  await original.close();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0');
  const ledger = new Ledger(db, id, 20);
  const fixtures = await import(pathToFileURL(resolve('tests/ledger/fixtures.mjs')).href);
  await fixtures.seedCaller(ledger);
  const clock = new TestBudgetClock();
  const input: PreparedIntent = fixtures.intent();
  const exec = db.exec.bind(db);
  const count = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
  return {
    home,
    file,
    db,
    ledger,
    clock,
    input,
    exec,
    count,
    async close() {
      await ledger.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Cloud surrogate only: H registered MCP compositions in one OS process; R real active ledger runs.
 * A fresh fixture is used for every concurrent request wave, so history never silently accumulates. */
export async function p065WorkloadFixture(h: 1 | 2, r: 1 | 10, tool: string) {
  const { performance } = await import('node:perf_hooks');
  const began = performance.now();
  const assert = (await import('node:assert/strict')).default;
  const { delegationBenchmarkFixture } = await import('./b45-delegation-fixture.js');
  const { hashClaim } = await import('./b45-handshake-fixture.js');
  const { DelegationService } = await import('../../packages/hud-mcp/src/delegation.js');
  const { HandshakeService } = await import('../../packages/hud-mcp/src/handshake.js');
  const { acceptIntent } = await import('../../src/ledger/intents.js');
  const { registerSupervisor, beginSubmission, markSubmitted, recordScope, createHeartbeatWriter } =
    await import('../../src/ledger/supervisor.js');
  const { readRun } = await import('../../src/ledger/records.js');
  const { scopeSnapshot } = await import('../../src/ledger/call-context.js');
  const { taskDigest } = await import('../../src/core/lifecycle.js');
  const { readReconcileSnapshot, commitReconcile } = await import('../../src/ledger/reconcile.js');
  const limits = { maxActiveRuns: 12, maxActiveRunsPerOwner: 12 };
  const f = await delegationBenchmarkFixture();
  const services: InstanceType<typeof DelegationService>[] = [];
  const runs: { runId: string; claim: string; child: typeof f.child; supervisor: typeof f.meta.supervisor }[] = [];
  try {
    const parent2 = h === 2 ? await f.actor('p065-parent-2', 11000, f.parent.ref.sessionId) : f.parent;
    const parents = [f.parent, parent2].slice(0, h);
    await f.startup();
    runs.push({ runId: 'run-a', claim: f.claim, child: f.child, supervisor: f.meta.supervisor });
    async function addRun(index: number) {
      const runId = `p065-run-${index}`,
        linkId = `p065-link-${index}`;
      const claim = `synthetic-p065-claim-${index}-not-a-real-secret`;
      const input = structuredClone(f.input);
      input.requestKey = `p065-seed-${index}`;
      input.link.linkId = linkId;
      input.link.briefPath = f.spawnArgs.brief;
      input.link.taskDigest = taskDigest(
        f.spawnArgs.brief,
        hashClaim('Synthetic task bytes.'),
        'codex',
        f.source.sourceId,
        'implementer'
      );
      input.params.briefPath = f.spawnArgs.brief;
      input.params.briefContentHash = hashClaim('Synthetic task bytes.');
      Object.assign(input.run, {
        runId,
        linkId,
        launchCallId: `p065-call-${index}`,
        launchCorrelationId: `p065-correlation-${index}`,
        launchTokenHash: hashClaim(`p065-ticket-${index}`),
        launchDigest: hashClaim(`p065-launch-${index}`),
      });
      Object.assign(input.claim, { runId, claimHash: hashClaim(claim) });
      input.holder = `synthetic-supervisor-${index}`;
      await acceptIntent(f.ledger, input, 20, undefined, limits);
      const supervisor = { ...f.meta.supervisor, pid: 15000 + index, proc_start: String(15000 + index) };
      const registration = {
        runId,
        ticketHash: input.run.launchTokenHash,
        launchDigest: input.run.launchDigest,
        supervisor,
        authority: f.parent.authority,
        at: 1001,
        monoMs: 1,
      };
      await registerSupervisor(f.ledger, registration);
      await beginSubmission(f.ledger, { ...registration, at: 1002 });
      await markSubmitted(f.ledger, runId, supervisor, 1003);
      const child = await f.actor(`p065-child-${index}`, 20000 + index * 10, `synthetic-child-${index}`);
      f.processes.get(child.registration.harnessPid!)!.ppid = supervisor.pid;
      const harness = {
        ...f.meta.harness!,
        pid: child.registration.harnessPid!,
        proc_start: child.registration.harnessProcStart!,
      };
      const scope = {
        ...f.meta.scope!,
        scope_id: `p065-scope-${index}`,
        pgid: harness.pid,
        sid: harness.pid,
        group_leader: harness,
      };
      const meta = {
        ...f.meta,
        run_id: runId,
        link_id: linkId,
        supervisor,
        command_leader: harness,
        harness,
        scope,
        launch_digest: input.run.launchDigest,
        launch_call_id: input.run.launchCallId!,
        launch_correlation_id: input.run.launchCorrelationId!,
      };
      await recordScope(f.ledger, runId, supervisor, scope, 1004, meta);
      const entry = { runId, claim, child, supervisor };
      runs.push(entry);
      return entry;
    }
    for (let i = 1; i < r; i++) await addRun(i);
    const targets =
      tool === 'delegate_resume'
        ? await Promise.resolve().then(async () => {
            const result: typeof runs = [];
            for (let i = 0; i < h; i++) result.push(await addRun(100 + i));
            return result;
          })
        : runs.slice(0, h);
    // Child tools must bind each independent child through the existing real handshake.
    for (const target of targets) {
      const binder = new HandshakeService({
        ledger: f.ledger,
        registration: target.child.registration,
        reader: f.reader,
        env: { HUD_CLAIM: target.claim },
        now: f.now,
        home: f.root,
      });
      const bound = await binder.whoami({}, target.child.authority);
      assert.equal(bound.ok && bound.state, 'bound');
      if (tool === 'delegate_resume') {
        const expected = readReconcileSnapshot(f.ledger, target.runId);
        const id = `p065-terminal-${target.runId}`;
        const fact = {
          evidenceId: id,
          runId: target.runId,
          sourceId: f.source.sourceId,
          bindingGeneration: 1,
          supervisor: target.supervisor,
          validation: 'accepted' as const,
          asOf: 1020,
          observedAt: 1020,
          fact: {
            kind: 'scope_reconciled' as const,
            complete: true as const,
            harnessTerminated: true as const,
            launchersSealed: true as const,
            nativeExit: null,
          },
        };
        await commitReconcile(
          f.ledger,
          expected,
          [
            {
              record: {
                evidenceId: id,
                runId: target.runId,
                linkId: expected.run.linkId,
                kind: 'scope_reconciled',
                producer: 'reconciler',
                fingerprint: hashClaim(id),
                payload: {},
                observedAt: 1020,
                validatedAt: 1020,
                validation: 'accepted',
              },
              facts: [fact],
            },
          ],
          1020
        );
      }
    }
    if (h === 2 && (tool === 'delegate_whoami' || tool === 'delegate_report')) {
      const crossed = new HandshakeService({
        ledger: f.ledger,
        registration: targets[1].child.registration,
        reader: f.reader,
        env: { HUD_CLAIM: targets[0].claim },
        now: f.now,
        home: f.root,
      });
      await assert.rejects(
        crossed.whoami({}, targets[1].child.authority),
        /claim_anchor_mismatch|claim_redeemed|claim_invalid/
      );
    }
    const childTool = tool === 'delegate_whoami' || tool === 'delegate_report';
    const actors = childTool ? targets.map((target) => target.child) : parents;
    const options = f.service['options'];
    for (let i = 0; i < h; i++)
      services.push(
        new DelegationService({
          ...options,
          config: { ...options.config, limits },
          registration: actors[i].registration,
          env: childTool ? { HUD_CLAIM: targets[i].claim } : {},
          // Avoid an actual OS probe of synthetic supervisor identities in cancel fixtures.
        })
      );
    if (tool === 'delegate_cancel') {
      // The service's read-control dependency already has an explicitly trusted probe seam.
      for (const service of services) service['reads']['probes'].supervisorState = () => 'alive';
    }
    const baselineIds = runs
      .filter((entry) => !targets.includes(entry) || tool !== 'delegate_resume')
      .map((entry) => entry.runId);
    const heartbeat = baselineIds.map((runId) => {
      const run = f.ledger.snapshot((tx) => readRun(tx, runId));
      return createHeartbeatWriter(f.ledger, runId, run.supervisor!, run);
    });
    let tick = 0;
    const pulse = async () => {
      tick++;
      return Promise.all(heartbeat.map((writer) => writer.tick(1020 + tick, 20 + tick)));
    };
    const population = () =>
      f.ledger.snapshot((tx) => {
        const active = tx.all(
          "SELECT run_id,supervisor_pid,heartbeat_seq FROM runs WHERE state IN ('starting','running','cancelling','uncertain') ORDER BY run_id"
        );
        return {
          active,
          slots: tx.all('SELECT run_id,slot_key FROM slots ORDER BY run_id'),
          claims: tx.all("SELECT run_id,state FROM claims WHERE state IN ('armed','redeemed') ORDER BY run_id"),
          totalRuns: Number(tx.get('SELECT count(*) AS n FROM runs')!.n),
          events: Number(tx.get('SELECT count(*) AS n FROM events')!.n),
        };
      });
    await pulse();
    const initial = population();
    assert.equal(initial.active.length, r);
    assert.equal(initial.slots.length, r);
    assert.equal(new Set(initial.slots.map((row) => row.slot_key)).size, r);
    for (const run of initial.active) {
      assert.ok(run.supervisor_pid);
      assert.ok(Number(run.heartbeat_seq) >= 2);
      assert.ok(initial.claims.some((claim) => claim.run_id === run.run_id));
    }
    const source = (index: number) => ({
      ok: true as const,
      callId: `p065-call-${index}-${performance.now()}`,
      sessionRef: actors[index].ref,
      processKey: actors[index].authority.evidence.processKey,
      evidenceDigest: hashClaim('synthetic p065 current source'),
      scopePremise: f.ledger.snapshot((tx) =>
        scopeSnapshot(tx, f.ledger.ledgerId, actors[index].authority.evidence.processKey)
      ),
    });
    const args = (index: number, key = `p065-foreground-${index}`): Record<string, unknown> => {
      if (tool === 'delegate_spawn') return { ...f.spawnArgs, request_key: key };
      if (tool === 'delegate_resume')
        return {
          ...f.resumeArgs,
          linkId: `p065-link-${100 + index}`,
          expectedRun: targets[index].runId,
          request_key: key,
        };
      if (tool === 'delegate_report')
        return { runId: targets[index].runId, status: 'completed', summary: 'Synthetic P065 report' };
      if (tool === 'delegate_whoami') return {};
      return { runId: targets[index].runId };
    };
    return {
      ...f,
      services,
      actors,
      source,
      args,
      targets,
      limits,
      initial,
      population,
      pulse,
      h,
      r,
      baselineIds,
      setupMs: performance.now() - began,
      async dispose() {
        for (const service of services) await service.close();
        await f.service.close();
        await f.close();
      },
    };
  } catch (error) {
    for (const service of services) await service.close();
    await f.service.close();
    await f.close();
    throw error;
  }
}
