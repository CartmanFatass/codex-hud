import { TestBudgetClock } from '../unit/p065-budget-fixture.js';
import { PrivateLedgerGate } from '../../src/ledger/local-manager.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { handshakeFixture, hashClaim } from '../unit/b45-handshake-fixture.js';
import { DelegationService } from '../../packages/hud-mcp/src/delegation.js';
import { HandshakeService } from '../../packages/hud-mcp/src/handshake.js';
import { TOOLS, validateToolArguments } from '../../packages/hud-mcp/src/tools.js';
import { scopeSnapshot } from '../../src/ledger/call-context.js';
import { taskDigest } from '../../src/core/lifecycle.js';
import { commitReconcile, readReconcileSnapshot } from '../../src/ledger/reconcile.js';
import type { DelegateProfile } from '../../src/core/types/capabilities.js';
import type { PreparedRunLaunch } from '../../src/core/launch/index.js';
import type { ReconcileEvidence } from '../../src/core/types/execution.js';
import type { LocalResumeRequest } from '../../src/core/types/lifecycle.js';

/** Consult 5 G03 / B45-R2: optional MCP expectedRun is a new-intent CAS premise, never a replay gate. */
async function fixture() {
  const f = await handshakeFixture();
  const brief = join(f.root, 'brief.md');
  writeFileSync(brief, 'Synthetic task bytes.');
  writeFileSync(join(f.root, 'config.toml'), '[mcp_servers.hud]\ncommand="/synthetic/bin/node"\n');
  const profile: DelegateProfile = {
    name: 'codex',
    harness: 'codex',
    source: { root: f.root, label: 'Synthetic' },
    launch: { argv: ['/synthetic/bin/codex'] },
    headless: { argv: ['/synthetic/bin/codex', 'exec', '-'] },
    resume: { argv: ['/synthetic/bin/codex', 'resume', '{{sessionId}}'] },
    resumeHeadless: { argv: ['/synthetic/bin/codex', 'exec', 'resume', '{{sessionId}}', '-'] },
    host: { kind: 'none', layout: 'none' },
    env: { CODEX_HOME: f.root },
    mcpServerName: 'hud',
    claimTransport: 'config_env',
    clientToolTimeoutMs: 60000,
    responseMarginMs: 2000,
    orphan_policy: 'continue',
    managedShellVerified: false,
    roles: { implementer: { model: 'synthetic-model', effort: 'low' } },
  };
  const launches: PreparedRunLaunch[] = [];
  const clock = new TestBudgetClock();
  const options = {
    clock,
    localBinding: new PrivateLedgerGate(f.root).bind(f.ledger),
    ledger: f.ledger,
    home: f.root,
    config: { version: 1 as const, profiles: [profile] },
    registration: f.parent.registration,
    reader: f.reader,
    env: {},
    hudRunPath: resolve('bin/hud-run'),
    capability: { verify: () => ({ ok: true as const, reason: null }) },
    launch: async (p: PreparedRunLaunch) => {
      launches.push(p);
      return { pid: 123, completion: Promise.resolve({ code: 0, signal: null }) };
    },
  };
  const service = new DelegationService(options);
  function source() {
    return {
      ok: true as const,
      callId: 'synthetic-call-' + performance.now(),
      sessionRef: f.parent.ref,
      processKey: f.parent.authority.evidence.processKey,
      evidenceDigest: hashClaim('synthetic source'),
      scopePremise: f.ledger.snapshot((tx) =>
        scopeSnapshot(tx, f.ledger.ledgerId, f.parent.authority.evidence.processKey)
      ),
    };
  }
  function resumeArgs(requestKey: string, expectedRun?: string) {
    return {
      linkId: 'link-a',
      mode: 'headless' as const,
      request_key: requestKey,
      prompt: 'Synthetic supplement',
      ...(expectedRun === undefined ? {} : { expectedRun }),
    };
  }
  function runsForLink() {
    return f.ledger.snapshot((tx) =>
      tx.all('SELECT run_id,run_seq FROM runs WHERE link_id=? ORDER BY run_seq', 'link-a')
    );
  }
  function idempotencyRows(requestKey: string) {
    return f.ledger.snapshot((tx) =>
      tx.all('SELECT request_key,params_digest,run_id FROM idempotency WHERE request_key=?', requestKey)
    );
  }
  function counts() {
    return f.ledger.snapshot((tx) => ({
      runs: Number(tx.get('SELECT count(*) AS n FROM runs WHERE link_id=?', 'link-a')?.n),
      claims: Number(tx.get('SELECT count(*) AS n FROM claims')?.n),
      slots: Number(tx.get('SELECT count(*) AS n FROM slots')?.n),
    }));
  }
  /** End a run through the real reconciler, never by editing run/slot state directly. */
  async function endRun(runId: string, bindingGeneration: number, evidenceId: string) {
    const snapshot = readReconcileSnapshot(f.ledger, runId);
    const at = Date.now() + 5000;
    const fact: ReconcileEvidence = {
      evidenceId,
      runId,
      sourceId: f.source.sourceId,
      bindingGeneration,
      supervisor: snapshot.run.supervisor,
      validation: 'accepted',
      asOf: at,
      observedAt: at,
      fact: {
        kind: 'scope_reconciled',
        complete: true,
        harnessTerminated: true,
        launchersSealed: true,
        nativeExit: null,
      },
    };
    const result = await commitReconcile(
      f.ledger,
      snapshot,
      [
        {
          record: {
            evidenceId,
            runId,
            linkId: 'link-a',
            kind: 'scope_reconciled',
            producer: 'reconciler',
            fingerprint: hashClaim(evidenceId),
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
    assert.equal(result.committed && result.decision.state, 'ended');
  }
  async function bindAndEnd() {
    await f.ledger.transaction((tx) => {
      tx.run(
        'UPDATE links SET brief_path=?,task_digest=? WHERE link_id=?',
        brief,
        taskDigest(brief, hashClaim('Synthetic task bytes.'), 'codex', f.source.sourceId, 'implementer'),
        'link-a'
      );
    });
    await f.startup();
    const handshake = new HandshakeService({
      ledger: f.ledger,
      registration: f.child.registration,
      reader: f.reader,
      env: { HUD_CLAIM: f.claim },
      now: f.now,
    });
    await handshake.whoami({}, f.child.authority, clock.budget());
    await endRun('run-a', 1, 'synthetic-terminal-run-a');
  }
  return {
    ...f,
    profile,
    options,
    service,
    source,
    launches,
    resumeArgs,
    runsForLink,
    idempotencyRows,
    counts,
    endRun,
    bindAndEnd,
  };
}

test('G03 tool schema accepts optional expectedRun as a RunId and keeps it non-required', () => {
  const resume = TOOLS.find((tool) => tool.name === 'delegate_resume');
  assert.ok(resume);
  const properties = resume.inputSchema.properties as Record<string, unknown>;
  assert.deepEqual(resume.inputSchema.required, ['linkId', 'mode', 'request_key']);
  assert.ok(Object.hasOwn(properties, 'expectedRun'));
  const base = { linkId: 'link-a', mode: 'headless', request_key: 'synthetic-schema-key' };
  assert.equal(validateToolArguments(resume, base), true);
  assert.equal(validateToolArguments(resume, { ...base, expectedRun: 'run-a' }), true);
  assert.equal(validateToolArguments(resume, { ...base, expectedRun: '5f0c4a9e-1d2b-4c3d-8e9f-0a1b2c3d4e5f' }), true);
  for (const expectedRun of ['', 'bad run id', '../run-a', 42, null, { runId: 'run-a' }])
    assert.equal(validateToolArguments(resume, { ...base, expectedRun }), false, JSON.stringify(expectedRun));
});

test('G03 old request key replays its original run after a newer run appeared and ended', async () => {
  const f = await fixture();
  try {
    await f.bindAndEnd();
    const args = f.resumeArgs('g03-replay-key', 'run-a');
    const first = (await f.service.invoke(f.source(), 'delegate_resume', args)) as {
      status: string;
      runId: string;
    };
    assert.equal(first.status, 'accepted');
    assert.notEqual(first.runId, 'run-a');
    // The newer run is not terminal yet: a new intent would fail the slot/CAS gates.
    assert.deepEqual(await f.service.invoke(f.source(), 'delegate_resume', args), first);
    await f.endRun(first.runId, 2, 'synthetic-terminal-run-b');
    // The newer run started and ended; the original key still replays its own run.
    assert.deepEqual(await f.service.invoke(f.source(), 'delegate_resume', args), first);
    assert.equal(f.launches.length, 1);
    assert.deepEqual(
      f.runsForLink().map((row) => row.run_id),
      ['run-a', first.runId]
    );
  } finally {
    await f.close();
  }
});

test('G03 same request key with a different expectedRun conflicts without a new intent', async () => {
  const f = await fixture();
  try {
    await f.bindAndEnd();
    const first = (await f.service.invoke(
      f.source(),
      'delegate_resume',
      f.resumeArgs('g03-conflict-key', 'run-a')
    )) as {
      runId: string;
    };
    await assert.rejects(
      f.service.invoke(f.source(), 'delegate_resume', f.resumeArgs('g03-conflict-key', first.runId)),
      /idempotency_conflict/
    );
    assert.equal(f.launches.length, 1);
    assert.equal(f.runsForLink().length, 2);
    assert.equal(f.idempotencyRows('g03-conflict-key').length, 1);
  } finally {
    await f.close();
  }
});

/** The only legitimate pre-CAS refusals for the losing concurrent call. */
function refusalCode(reason: unknown): string {
  if (reason instanceof Error && 'code' in reason && reason.code === 'ledger_busy') return 'ledger_busy';
  return reason instanceof Error ? reason.message : String(reason);
}

test('G03 two callers that read the same run and race with different keys create at most one intent', async () => {
  const f = await fixture();
  try {
    await f.bindAndEnd();
    // Both callers observed run-a before either intent was accepted.
    const observed = readReconcileSnapshot(f.ledger, 'run-a').run.runId;
    assert.equal(observed, 'run-a');
    const results = await Promise.allSettled([
      f.service.invoke(f.source(), 'delegate_resume', f.resumeArgs('g03-race-a', observed)),
      f.service.invoke(f.source(), 'delegate_resume', f.resumeArgs('g03-race-b', observed)),
    ]);
    const accepted = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected') as PromiseRejectedResult[];
    // At most one new intent. The loser either reaches the CAS or exhausts the
    // production write budget first; both are legitimate refusals with no intent.
    assert.ok(accepted.length <= 1);
    assert.equal(accepted.length + rejected.length, 2);
    for (const result of rejected)
      assert.ok(
        ['expected_run_mismatch', 'ledger_busy'].includes(refusalCode(result.reason)),
        `unexpected refusal: ${String(result.reason)}`
      );
    // Every durable effect matches the number of accepted calls (run-a is the fixture).
    assert.deepEqual(f.counts(), {
      runs: 1 + accepted.length,
      claims: 1 + accepted.length,
      slots: accepted.length,
    });
    assert.equal(f.launches.length, accepted.length);
    assert.equal(f.idempotencyRows('g03-race-a').length + f.idempotencyRows('g03-race-b').length, accepted.length);
  } finally {
    await f.close();
  }
});

test('G03 an old expectedRun is still refused after another run started and ended', async () => {
  const f = await fixture();
  try {
    await f.bindAndEnd();
    const first = (await f.service.invoke(f.source(), 'delegate_resume', f.resumeArgs('g03-stale-a', 'run-a'))) as {
      runId: string;
    };
    await f.endRun(first.runId, 2, 'synthetic-terminal-run-b');
    // The slot is free and the link is bound again, so only the CAS can refuse this.
    await assert.rejects(
      f.service.invoke(f.source(), 'delegate_resume', f.resumeArgs('g03-stale-b', 'run-a')),
      /expected_run_mismatch/
    );
    assert.equal(f.launches.length, 1);
    // The refused intent leaves no run, claim, slot or idempotency record behind.
    assert.deepEqual(f.counts(), { runs: 2, claims: 2, slots: 0 });
    assert.equal(f.idempotencyRows('g03-stale-b').length, 0);
  } finally {
    await f.close();
  }
});

test('G03 omitted MCP expectedRun keeps transaction-selected current run and never auto-fills the digest', async () => {
  const f = await fixture();
  try {
    await f.bindAndEnd();
    const omitted = f.resumeArgs('g03-omitted-key');
    const first = (await f.service.invoke(f.source(), 'delegate_resume', omitted)) as {
      status: string;
      runId: string;
    };
    assert.equal(first.status, 'accepted');
    assert.deepEqual(await f.service.invoke(f.source(), 'delegate_resume', omitted), first);
    // Had omission auto-filled the then-current run-a into the digest, this would replay.
    await assert.rejects(
      f.service.invoke(f.source(), 'delegate_resume', f.resumeArgs('g03-omitted-key', 'run-a')),
      /idempotency_conflict/
    );
    assert.equal(f.launches.length, 1);
    assert.equal(f.runsForLink().length, 2);
  } finally {
    await f.close();
  }
});

test('G03 local management resume still requires expectedRun', async () => {
  const f = await fixture();
  try {
    await f.bindAndEnd();
    const service = new DelegationService({ ...f.options, registration: undefined, reader: undefined });
    const missing = { linkId: 'link-a', mode: 'headless' as const, request_key: 'g03-local-missing' };
    await assert.rejects(
      service.resumeLocal(missing as unknown as LocalResumeRequest),
      /local_resume_parameters_required/
    );
    const accepted = (await service.resumeLocal({
      ...missing,
      request_key: 'g03-local-required',
      expectedRun: 'run-a',
    })) as { status: string; runId: string };
    assert.equal(accepted.status, 'accepted');
    assert.equal(f.launches.length, 1);
  } finally {
    await f.close();
  }
});
