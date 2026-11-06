import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { visualLength } from '../../dist/render/colors.js';

test('one synthetic ledger drives panel, inspector, logs, jobs, replay and owned cancel', () => {
  const r = spawnSync(process.execPath, [resolve('scripts/workbench/unified.mjs'), '--json'], {
    cwd: resolve('.'),
    encoding: 'utf8',
    timeout: 70000,
    env: { ...process.env, OPENAI_API_KEY: 'must-not-propagate', EXAMPLE_SECRET: 'must-not-propagate' },
  });
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout);
  assert.match(v.label, /SIMULATED unified/);
  assert.ok(v.replaySame);
  assert.equal(v.dispatchCount, 3);
  assert.equal(v.before.ledgerId, v.after.ledgerId);
  assert.ok(v.before.ledgerId);
  assert.ok(v.before.relations.every((r) => ['codex', 'pi'].includes(r.harness)));
  for (const h of ['codex', 'pi'])
    assert.ok(
      v.before.relations.some(
        (r) => r.harness === h && r.bound && r.label === `SIMULATED ${h === 'pi' ? 'Pi' : 'Codex'}`
      )
    );
  assert.ok(v.before.agents.some((s) => s.includes('main')));
  assert.ok(v.before.agents.some((s) => s.includes('SIMULATED Codex')));
  assert.ok(v.before.agents.some((s) => s.includes('SIMULATED Pi')));
  assert.equal(v.before.ordinary.harness, 'pi');
  assert.equal(v.before.ordinary.loaded, true);
  assert.match(v.before.ordinary.provenance, /sample not committed/);
  assert.equal(v.before.jobs.length, 2);
  assert.equal(v.before.counts.jobs, 2);
  const first = v.before.jobs.find((j) => j.ref.key === 'synthetic-question');
  assert.equal(first.state, 'uncertain');
  assert.equal(first.provenance, 'SIMULATED');
  assert.equal(first.generation, 1);
  assert.ok(v.before.agents.some((s) => s.includes('SIMULATED Jev') && s.includes('uncertain')));
  assert.equal('jobLines' in v.before, false);
  assert.equal(v.before.destinations.filter((k) => k === first.key).length, 1);
  assert.ok(first.parentKey);
  assert.equal(v.jobInspected.selectedId, first.key);
  assert.equal(v.jobInspected.selectedRunId, null);
  assert.ok(v.jobCancelRefused && v.jobLogsRefused);
  assert.ok(v.jobInspected.details.some((s) => s.includes('No run actions')));
  assert.deepEqual(
    v.jobStages.map((s) => s.stage),
    ['reopened', 'needs_human', 'terminal_observed_held', 'reconciled_released', 'next_account_dispatch']
  );
  const stages = v.jobStages.map((s) => s.frame.jobs.find((j) => j.key === first.key));
  assert.equal(stages[0].state, 'uncertain');
  assert.equal(stages[0].generation, 1);
  assert.equal(stages[1].state, 'needs_human');
  assert.equal(stages[2].state, 'answered');
  assert.ok(stages[2].lease);
  assert.equal(stages[2].answer, null);
  assert.equal(stages[3].lease, null);
  assert.equal(stages[3].answer, 'synthetic-answer');
  assert.equal(stages[4].lease.generation, 2);
  for (const stage of v.jobStages) {
    assert.equal(stage.frame.selectedId, first.key);
    assert.equal(stage.frame.selectedRunId, null);
    assert.equal(stage.frame.counts.confirmedSessions, v.before.counts.confirmedSessions);
    assert.equal(new Set(stage.frame.destinations).size, stage.frame.destinations.length);
  }
  assert.ok(v.inspected.details.some((s) => s.includes('SIMULATED Pi')));
  assert.ok(v.codexInspected.details.some((s) => s.includes('SIMULATED Codex')));
  assert.match(v.codexLog, /SIMULATED child received brief/);
  assert.equal(v.cancel.accepted, true);
  assert.equal(v.unownedRefused, true);
  assert.ok(v.before.relations.find((r) => r.runId === v.holdRun && !r.bound));
  for (const frame of [v.before, v.jobInspected, ...v.jobStages.map((s) => s.frame)])
    for (const line of [...frame.agents, ...frame.details]) {
      assert.equal(visualLength(line), 88);
      assert.doesNotMatch(line, /[\x00-\x1f\x7f]/);
    }
  assert.doesNotMatch(JSON.stringify(v), /must-not-propagate/);
});

test('fix1 last-known held and free custody is historical in bounded Agents and Inspector rows', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DurableJevLab } = await import('../../dist-test/tests/fakes/jev-durable.js');
  const { LinkTickCollector } = await import('../../dist/core/link/tick.js');
  const { loadLimits } = await import('../../dist/core/link/limits.js');
  const { root, collected } = await import('../int/b9-fixture.mjs');
  const { buildUnifiedFrame } = await import('../../scripts/workbench/unified-panel.mjs');
  const home = mkdtempSync(join(tmpdir(), 'jev-historical-'));
  const lab = DurableJevLab.create(join(home, 'jobs.sqlite'));
  const ledger = {
    state: 'available',
    snapshot: {
      ledgerId: 'synthetic-ledger',
      asOfSeq: 1,
      links: [],
      runs: [],
      claims: [],
      bindings: [],
      reports: [],
      events: [],
      evidence: [],
      slots: [],
    },
    claimChecks: [],
    conflictTargets: new Map(),
    reason: null,
  };
  const collector = new LinkTickCollector(
    { changeToken: () => 'fixed', read: () => ledger, close() {} },
    home,
    loadLimits(home)
  );
  t.after(() => {
    collector.close();
    lab.close();
    rmSync(home, { recursive: true, force: true });
  });
  const ref = { kind: 'jev', provider: 'synthetic-provider', key: 'synthetic-question' };
  const owner = 'synthetic-owner';
  lab.enqueue({
    ref,
    owner,
    browser: 'synthetic-browser',
    requestId: 'synthetic-request',
    requestFingerprint: 'synthetic-fingerprint',
    parentContext: { ledgerId: 'synthetic-ledger', ref: root },
  });
  const ticket = lab.consumeDispatch(owner, ref, lab.snapshot().jobs[0].revision);
  const input = (simulationJobs) => ({
    roots: [{ kind: 'session', ref: root }],
    sessions: [collected(root)],
    simulationJobs,
    nowMs: 1000,
  });
  for (const custody of ['held', 'free']) {
    if (custody === 'free') {
      lab.observe(owner, ref, ticket.generation, ticket.revision, 'answered', 'synthetic-evidence');
      lab.reconcile(
        owner,
        ref,
        ticket.generation,
        lab.snapshot().jobs[0].revision,
        'answered',
        'synthetic-evidence',
        'synthetic-answer'
      );
    }
    const raw = lab.snapshot();
    await collector.tick(input(raw));
    const vm = await collector.tick(
      input({
        provenance: 'SIMULATED',
        availability: 'unavailable',
        storeId: raw.storeId,
        revision: null,
        jobs: [],
        reason: 'store_busy',
      })
    );
    const node = vm.tree.nodes.find((n) => n.simulationJob);
    const frame = buildUnifiedFrame(vm, node.key, 88, null, 1000);
    assert.equal(node.simulationJob.answer, null);
    const agents = frame.agents.join('\n'),
      details = frame.details.join('\n');
    assert.match(agents, new RegExp(`last known browser ${custody}`));
    assert.match(details, new RegExp(`Last known browser: ${custody}`));
    assert.match(details, /Current custody: unknown/);
    assert.match(details, /Last known generation:/);
    assert.match(details, /last known holder generation:/);
    assert.doesNotMatch(details, /current holder generation|Synthetic answer:|synthetic-answer/);
    for (const line of [...frame.agents, ...frame.details]) {
      assert.equal(visualLength(line), 88);
      assert.doesNotMatch(line, /[\x00-\x1f\x7f]/);
    }
  }
});
