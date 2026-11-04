import { CallBudget, type BudgetClock } from '../../src/ledger/call-budget.js';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { handshakeFixture, hashClaim } from './b45-handshake-fixture.js';
import { DelegationService } from '../../packages/hud-mcp/src/delegation.js';
import { HandshakeService } from '../../packages/hud-mcp/src/handshake.js';
import { scopeSnapshot } from '../../src/ledger/call-context.js';
import { taskDigest } from '../../src/core/lifecycle.js';
import { commitReconcile, readReconcileSnapshot } from '../../src/ledger/reconcile.js';
import type { DelegateProfile } from '../../src/core/types/capabilities.js';
import type { PreparedRunLaunch } from '../../src/core/launch/index.js';
import type { ReconcileEvidence } from '../../src/core/types/execution.js';

/** Synthetic only: real SQLite and writer APIs, simulated independently checked process/source evidence. */
export async function delegationBenchmarkFixture(verified = true, clock?: BudgetClock) {
  const f = await handshakeFixture();
  const brief = join(f.root, 'brief.md');
  writeFileSync(brief, 'Synthetic task bytes.');
  writeFileSync(join(f.root, 'config.toml'), '[mcp_servers.hud]\ncommand="/synthetic/bin/node"\n');
  const profile: DelegateProfile = {
    name: 'codex',
    harness: 'codex',
    source: { root: f.root, label: 'Synthetic benchmark' },
    launch: { argv: [process.execPath] },
    headless: { argv: [process.execPath, 'exec', '-'] },
    resume: { argv: [process.execPath, 'resume', '{{sessionId}}'] },
    resumeHeadless: { argv: [process.execPath, 'exec', 'resume', '{{sessionId}}', '-'] },
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
  const service = new DelegationService({
    clock,
    ledger: f.ledger,
    home: f.root,
    config: { version: 1, profiles: [profile] },
    registration: f.parent.registration,
    reader: f.reader,
    env: {},
    hudRunPath: resolve('bin/hud-run'),
    // Deliberately injected test-only verifier. This is not production evidence.
    capability: {
      verify: () =>
        verified ? { ok: true as const, reason: null } : { ok: false as const, reason: 'capability_unverified' },
    },
    launch: async (launch) => {
      launches.push(launch);
      return { pid: 123, completion: Promise.resolve({ code: 0, signal: null }) };
    },
  });
  function source() {
    return {
      ok: true as const,
      callId: 'synthetic-benchmark-call-' + performance.now(),
      sessionRef: f.parent.ref,
      processKey: f.parent.authority.evidence.processKey,
      evidenceDigest: hashClaim('synthetic benchmark source'),
      scopePremise: f.ledger.snapshot((tx) =>
        scopeSnapshot(tx, f.ledger.ledgerId, f.parent.authority.evidence.processKey)
      ),
    };
  }
  const spawnArgs = {
    backend: 'codex',
    role: 'implementer',
    brief,
    cwd: f.root,
    mode: 'headless',
    request_key: 'synthetic-benchmark-spawn',
  };
  const resumeArgs = {
    linkId: 'link-a',
    mode: 'headless',
    request_key: 'synthetic-benchmark-resume',
    prompt: 'Synthetic benchmark supplement',
  };
  /**
   * Fixture setup only, outside every measurement. The initial fixture registers
   * a supervisor/submission; bind through the real child service and end through
   * the real reconciler. Never directly update run state, slots or child bindings.
   */
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
    const binding = await handshake.whoami({}, f.child.authority, clock ? new CallBudget(clock) : undefined);
    assert.equal(binding.ok && binding.state, 'bound');
    const snapshot = readReconcileSnapshot(f.ledger, 'run-a');
    const fact: ReconcileEvidence = {
      evidenceId: 'synthetic-benchmark-terminal',
      runId: 'run-a',
      sourceId: f.source.sourceId,
      bindingGeneration: 1,
      supervisor: f.meta.supervisor,
      validation: 'accepted',
      asOf: 1020,
      observedAt: 1020,
      fact: {
        kind: 'scope_reconciled',
        complete: true,
        harnessTerminated: true,
        launchersSealed: true,
        nativeExit: null,
      },
    };
    await commitReconcile(
      f.ledger,
      snapshot,
      [
        {
          record: {
            evidenceId: fact.evidenceId,
            runId: 'run-a',
            linkId: 'link-a',
            kind: 'scope_reconciled',
            producer: 'reconciler',
            fingerprint: hashClaim('synthetic benchmark terminal proof'),
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
    const ready = f.ledger.snapshot((tx) => ({
      state: tx.get('SELECT state FROM runs WHERE run_id=?', 'run-a')?.state,
      slots: tx.get('SELECT count(*) AS n FROM slots WHERE run_id=?', 'run-a')?.n,
      link: tx.get('SELECT state,current_owner FROM links WHERE link_id=?', 'link-a'),
    }));
    assert.equal(ready.state, 'ended');
    assert.equal(ready.slots, 0);
    assert.equal(ready.link?.state, 'bound');
    assert.equal(ready.link?.current_owner, 1);
  }
  return { ...f, service, launches, source, spawnArgs, resumeArgs, bindAndEnd };
}
