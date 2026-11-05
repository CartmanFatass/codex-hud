import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { handshakeFixture, hashClaim } from '../unit/b45-handshake-fixture.js';
import { DelegationService } from '../../packages/hud-mcp/src/delegation.js';
import { scopeSnapshot } from '../../src/ledger/call-context.js';
import { HudMcpServer } from '../../packages/hud-mcp/src/server.js';
import { insertRecord, insertRun, refValue } from '../../src/ledger/records.js';
import { makeSourceId } from '../../src/core/identity.js';
import { openLedger } from '../../src/ledger/ledger.js';
import { HandshakeService } from '../../packages/hud-mcp/src/handshake.js';
import { taskDigest } from '../../src/core/lifecycle.js';
import { commitReconcile, readReconcileSnapshot } from '../../src/ledger/reconcile.js';
import type { DelegateProfile } from '../../src/core/types/capabilities.js';
import type { PreparedRunLaunch } from '../../src/core/launch/index.js';
import type { ReconcileEvidence } from '../../src/core/types/execution.js';

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
  const config = { version: 1 as const, profiles: [profile] };
  const options = {
    ledger: f.ledger,
    home: f.root,
    config,
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
  function source(actor = f.parent) {
    return {
      ok: true as const,
      callId: 'synthetic-call-' + performance.now(),
      sessionRef: actor.ref,
      processKey: actor.authority.evidence.processKey,
      evidenceDigest: hashClaim('synthetic source'),
      scopePremise: f.ledger.snapshot((tx) =>
        scopeSnapshot(tx, f.ledger.ledgerId, actor.authority.evidence.processKey)
      ),
    };
  }
  const args = {
    backend: 'codex',
    role: 'implementer',
    brief,
    cwd: f.root,
    mode: 'headless',
    request_key: 'synthetic-request',
  };
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
    await handshake.whoami({}, f.child.authority);
    const snapshot = readReconcileSnapshot(f.ledger, 'run-a');
    const fact: ReconcileEvidence = {
      evidenceId: 'synthetic-terminal',
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
            fingerprint: hashClaim('terminal'),
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
  return { ...f, profile, options, service, source, args, launches, bindAndEnd };
}

test('B45 accepted spawn is atomic, lost response replays immutable result with zero second launch', async () => {
  const f = await fixture();
  try {
    const first = (await f.service.invoke(f.source(), 'delegate_spawn', f.args)) as {
      ok: boolean;
      status: string;
      runId: string;
    };
    assert.equal(first.status, 'accepted');
    const replay = await f.service.invoke(f.source(), 'delegate_spawn', f.args);
    assert.deepEqual(replay, first);
    assert.equal(f.launches.length, 1);
    const rows = f.ledger.snapshot((tx) => ({
      run: tx.get('SELECT * FROM runs WHERE run_id=?', first.runId),
      claim: tx.get('SELECT * FROM claims WHERE run_id=?', first.runId),
      slot: tx.get('SELECT * FROM slots WHERE run_id=?', first.runId),
      idem: tx.get('SELECT * FROM idempotency WHERE request_key=?', f.args.request_key),
      event: tx.get("SELECT * FROM events WHERE run_id=? AND kind='intent.accepted'", first.runId),
    }));
    assert.ok(Object.values(rows).every(Boolean));
    assert.equal(rows.run!.launch_cwd, f.root);
    assert.equal(JSON.stringify(rows).includes('HUD_CLAIM'), false);
    writeFileSync(f.args.brief, 'Changed task bytes.');
    await assert.rejects(f.service.invoke(f.source(), 'delegate_spawn', f.args), /idempotency_conflict/);
    assert.equal(f.launches.length, 1);
  } finally {
    await f.close();
  }
});
test('B45 different owner same request key is isolated; unverified new intent refuses', async () => {
  const f = await fixture();
  try {
    await f.service.invoke(f.source(), 'delegate_spawn', f.args);
    const other = new DelegationService({ ...f.options, registration: f.child.registration });
    await other.invoke(f.source(f.child), 'delegate_spawn', f.args);
    assert.equal(f.launches.length, 2);
    const unverified = new DelegationService({
      ...f.options,
      capability: { verify: () => ({ ok: false as const, reason: 'capability_unverified' }) },
    });
    // An existing accepted request replays even after a capability becomes unavailable.
    assert.equal(
      ((await unverified.invoke(f.source(), 'delegate_spawn', f.args)) as { status: string }).status,
      'accepted'
    );
    await assert.rejects(
      unverified.invoke(f.source(), 'delegate_spawn', { ...f.args, request_key: 'new' }),
      /capability_unverified/
    );
    assert.equal(f.launches.length, 2);
  } finally {
    await f.close();
  }
});
test('B45 MCP resume selects current run transactionally; local stale expected-run is refused after replay', async () => {
  const f = await fixture();
  try {
    await f.bindAndEnd();
    const args = { linkId: 'link-a', mode: 'headless', request_key: 'resume-one', prompt: 'Synthetic supplement' };
    const accepted = (await f.service.invoke(f.source(), 'delegate_resume', args)) as { runId: string; status: string };
    assert.equal(accepted.status, 'accepted');
    assert.deepEqual(await f.service.invoke(f.source(), 'delegate_resume', args), accepted);
    assert.equal(f.launches.length, 1);
    assert.equal(
      f.ledger.snapshot((tx) => tx.get('SELECT state FROM claims WHERE run_id=?', 'run-a')?.state),
      'revoked'
    );
    await assert.rejects(
      f.service.resumeLocal({ ...args, request_key: 'local-stale', expectedRun: 'run-a', mode: 'headless' }),
      /expected_run_mismatch/
    );
    assert.equal(f.launches.length, 1);
  } finally {
    await f.close();
  }
});
test('B45 local resume audits actual UID without an MCP context and preserves replay before expected-run gates', async () => {
  const f = await fixture();
  try {
    await f.bindAndEnd();
    const service = new DelegationService({ ...f.options, registration: undefined, reader: undefined });
    const args = { linkId: 'link-a', mode: 'headless' as const, request_key: 'local-one', expectedRun: 'run-a' };
    const accepted = (await service.resumeLocal(args)) as { runId: string };
    assert.deepEqual(await service.resumeLocal(args), accepted);
    const e = f.ledger.snapshot((tx) =>
      tx.get("SELECT payload FROM events WHERE run_id=? AND kind='intent.accepted'", accepted.runId)
    );
    const actor = JSON.parse(String(e?.payload)).actor;
    assert.equal(actor.kind, 'local_user');
    assert.equal(actor.uid, process.getuid!());
    assert.equal('callerId' in actor, false);
    assert.equal(f.launches.length, 1);
  } finally {
    await f.close();
  }
});

test('B45 dispatch pipe uncertainty returns durable accepted promptly and never resubmits', async () => {
  const f = await fixture();
  try {
    let attempts = 0;
    const service = new DelegationService({
      ...f.options,
      launch: async () => {
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, 100));
        throw new Error('synthetic-pipe-unknown');
      },
    });
    const started = performance.now();
    const accepted = (await service.invoke(f.source(), 'delegate_spawn', f.args)) as { status: string; runId: string };
    assert.equal(accepted.status, 'accepted');
    assert.ok(performance.now() - started < 100, 'accepted cannot await private pipe flush');
    assert.deepEqual(await service.invoke(f.source(), 'delegate_spawn', f.args), accepted);
    assert.equal(attempts, 1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const run = f.ledger.snapshot((tx) => tx.get('SELECT state,launch_phase FROM runs WHERE run_id=?', accepted.runId));
    assert.deepEqual({ ...run }, { state: 'starting', launch_phase: 'reserved' });
    assert.equal(
      f.ledger.snapshot((tx) => tx.get("SELECT count(*) AS n FROM events WHERE kind='launch.dispatch_unknown'")?.n),
      0
    );
  } finally {
    await f.close();
  }
});
test('B45 same-owner predecessor atomically transfers one child and replays before historical gates', async () => {
  const f = await fixture();
  try {
    await f.bindAndEnd();
    const args = { ...f.args, request_key: 'handover-one', predecessor: 'link-a' };
    const accepted = (await f.service.invoke(f.source(), 'delegate_spawn', args)) as {
      runId: string;
      linkId: string;
      status: string;
    };
    assert.equal(accepted.status, 'accepted');
    assert.notEqual(accepted.linkId, 'link-a');
    assert.deepEqual(await f.service.invoke(f.source(), 'delegate_spawn', args), accepted);
    const rows = f.ledger.snapshot((tx) => ({
      old: tx.get('SELECT state,current_owner FROM links WHERE link_id=?', 'link-a'),
      run: tx.get('SELECT operation,run_seq,target_session_ref FROM runs WHERE run_id=?', accepted.runId),
      parents: tx.get('SELECT count(*) AS n FROM links WHERE current_owner=1'),
    }));
    assert.deepEqual({ ...rows.old }, { state: 'handed_over', current_owner: 0 });
    assert.equal(rows.run?.operation, 'handover');
    assert.equal(rows.run?.run_seq, 1);
    assert.equal(rows.parents?.n, 1);
    assert.equal(f.launches.length, 1);
    await assert.rejects(
      f.service.invoke(f.source(), 'delegate_spawn', { ...args, request_key: 'new-historical' }),
      /historical_predecessor/
    );
  } finally {
    await f.close();
  }
});

test('B45 distinct backend source is registered atomically with acceptance', async () => {
  const f = await fixture();
  try {
    const target = join(f.root, 'target-source');
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(join(target, 'config.toml'), '[mcp_servers.hud]\ncommand="/synthetic/bin/node"\n');
    const profile = { ...f.profile, source: { root: target, label: 'Synthetic target' }, env: { CODEX_HOME: target } };
    const service = new DelegationService({ ...f.options, config: { version: 1, profiles: [profile] } });
    const result = (await service.invoke(f.source(), 'delegate_spawn', f.args)) as { status: string; runId: string };
    assert.equal(result.status, 'accepted');
    const rows = f.ledger.snapshot((tx) => ({
      run: tx.get('SELECT source_id FROM runs WHERE run_id=?', result.runId),
      source: tx.get('SELECT source_id,root_path FROM sources WHERE root_path=?', target),
    }));
    assert.equal(rows.run?.source_id, rows.source?.source_id);
    assert.equal(rows.source?.root_path, target);
  } finally {
    await f.close();
  }
});

test('B45 headless build refuses explicit visible layouts instead of discarding them', async () => {
  const f = await fixture();
  try {
    for (const layout of ['tab', 'split'])
      await assert.rejects(
        f.service.invoke(f.source(), 'delegate_spawn', { ...f.args, layout }),
        /visible_layout_not_in_this_build/
      );
    assert.equal(f.launches.length, 0);
    assert.equal(
      f.ledger.snapshot(
        (tx) => tx.get('SELECT count(*) AS n FROM idempotency WHERE request_key=?', f.args.request_key)?.n
      ),
      0
    );
  } finally {
    await f.close();
  }
});

function intentRows(f: Awaited<ReturnType<typeof fixture>>) {
  return f.ledger.snapshot((tx) => ({
    sources: tx.all('SELECT * FROM sources ORDER BY source_id'),
    links: tx.all('SELECT * FROM links ORDER BY link_id'),
    runs: tx.all('SELECT * FROM runs ORDER BY run_id'),
    claims: tx.all('SELECT * FROM claims ORDER BY run_id'),
    slots: tx.all('SELECT * FROM slots ORDER BY slot_key'),
    idempotency: tx.all('SELECT * FROM idempotency ORDER BY owner_key,request_key'),
    accepted: tx.all("SELECT * FROM events WHERE kind='intent.accepted' ORDER BY seq"),
  }));
}

test('one-level HUD rejects marked pre-bind spawns atomically, including partial and contradictory markers', async () => {
  const f = await fixture();
  try {
    const variants = [
      { HUD_RUN: 'run-a' },
      { HUD_LINK: '' },
      { HUD_CLAIM: 'unknown-claim' },
      { HUD_RUN: 'wrong-run', HUD_LINK: 'wrong-link', HUD_CLAIM: f.claim },
    ];
    for (const env of variants) {
      const service = new DelegationService({ ...f.options, registration: f.child.registration, env });
      const before = intentRows(f);
      try {
        await assert.rejects(service.invoke(f.source(f.child), 'delegate_spawn', f.args), {
          message: 'nested_delegation_not_supported',
        });
        assert.deepEqual(intentRows(f), before);
        assert.equal(f.launches.length, 0);
      } finally {
        await service.close();
      }
    }
    assert.equal(
      f.ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM child_bindings')!.n),
      0
    );
    // Refusal does not consume the request key: the genuine root still accepts.
    assert.equal(
      ((await f.service.invoke(f.source(), 'delegate_spawn', f.args)) as { status: string }).status,
      'accepted'
    );
    assert.equal(f.launches.length, 1);
  } finally {
    await f.service.close();
    await f.close();
  }
});

test('one-level provenance is captured at server start and returns its stable MCP refusal code', async () => {
  const f = await fixture();
  const env: Record<string, string | undefined> = { HUD_RUN: 'run-a' };
  const service = new DelegationService({ ...f.options, registration: f.child.registration, env });
  delete env.HUD_RUN;
  const server = new HudMcpServer({ resolve: async () => f.source(f.child) }, service);
  try {
    const response = (await server.handle({
      jsonrpc: '2.0',
      id: 'nested',
      method: 'tools/call',
      params: { name: 'delegate_spawn', arguments: f.args },
    })) as { result: { isError: boolean; structuredContent: { ok: boolean; code: string } } };
    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent.ok, false);
    assert.equal(response.result.structuredContent.code, 'nested_delegation_not_supported');
    assert.equal(f.launches.length, 0);
    const forged = (await server.handle({
      jsonrpc: '2.0',
      id: 'forged-provenance',
      method: 'tools/call',
      params: { name: 'delegate_spawn', arguments: { ...f.args, managedLaunch: false } },
    })) as { error: { code: number } };
    assert.equal(forged.error.code, -32602);
    await f.ledger.transaction((tx) =>
      tx.run('UPDATE callers SET retired_at=2000 WHERE caller_id=?', f.child.registration.caller.callerId)
    );
    await assert.rejects(service.invoke(f.source(f.child), 'delegate_spawn', f.args), /identity_unverified/);
  } finally {
    await service.close();
    await f.service.close();
    await f.close();
  }
});

test('one-level durable identity survives binding removal, terminal run and server/store restart without env', async () => {
  const f = await fixture();
  let restarted: Awaited<ReturnType<typeof openLedger>> | undefined;
  let service: DelegationService | undefined;
  try {
    await f.bindAndEnd();
    service = new DelegationService({ ...f.options, registration: f.child.registration, env: {} });
    await assert.rejects(
      service.invoke(f.source(f.child), 'delegate_spawn', f.args),
      /nested_delegation_not_supported/
    );
    await service.close();
    await f.ledger.transaction((tx) => {
      tx.run('UPDATE child_bindings SET is_current=0,revoked_at=2000');
      tx.run("UPDATE links SET state='revoked',current_owner=0 WHERE link_id='link-a'");
    });
    const actor = await f.actor('restarted-child', 31000, f.child.ref.sessionId);
    const source = f.source(actor);
    const before = intentRows(f);
    await f.ledger.close();
    restarted = await openLedger(join(f.root, 'ledger.sqlite'));
    service = new DelegationService({ ...f.options, ledger: restarted, registration: actor.registration, env: {} });
    await assert.rejects(service.invoke(source, 'delegate_spawn', f.args), /nested_delegation_not_supported/);
    assert.deepEqual(intentRows({ ...f, ledger: restarted }), before);
    assert.equal(f.launches.length, 0);
    assert.equal(
      restarted.snapshot((tx) => tx.get("SELECT state FROM runs WHERE run_id='run-a'")!.state),
      'ended'
    );
  } finally {
    await service?.close();
    await f.service.close();
    await restarted?.close();
    await f.close();
  }
});

test('one-level upgrade preserves accepted historical nested replay and owner-scoped list/status/wait', async () => {
  const f = await fixture();
  const legacy = new DelegationService({ ...f.options, registration: f.child.registration, env: {} });
  let guarded: DelegationService | undefined;
  try {
    // Seed a historical nested acceptance before this caller acquired a managed
    // identity. This represents data written before the one-level restriction.
    const accepted = (await legacy.invoke(f.source(f.child), 'delegate_spawn', f.args)) as {
      linkId: string;
      runId: string;
      status: string;
    };
    await f.bindAndEnd();
    guarded = new DelegationService({ ...f.options, registration: f.child.registration, env: { HUD_RUN: 'run-a' } });
    const before = intentRows(f);
    assert.deepEqual(await guarded.invoke(f.source(f.child), 'delegate_spawn', f.args), accepted);
    assert.deepEqual(intentRows(f), before);
    assert.equal(f.launches.length, 1);
    await assert.rejects(
      guarded.invoke(f.source(f.child), 'delegate_spawn', { ...f.args, request_key: 'fresh-nested' }),
      /nested_delegation_not_supported/
    );
    const page = (await guarded.invoke(f.source(f.child), 'delegate_list', {})) as { items: { linkId: string }[] };
    assert.deepEqual(
      page.items.map((x) => x.linkId),
      [accepted.linkId]
    );
    const parentPage = (await f.service.invoke(f.source(), 'delegate_list', {})) as { items: { linkId: string }[] };
    assert.deepEqual(
      parentPage.items.map((x) => x.linkId),
      ['link-a']
    );
    const status = (await guarded.invoke(f.source(f.child), 'delegate_status', { runId: accepted.runId })) as {
      ok: boolean;
    };
    assert.equal(status.ok, true);
    const wait = (await guarded.invoke(f.source(f.child), 'delegate_wait', {
      runId: accepted.runId,
      timeoutMs: 0,
    })) as { ok: boolean };
    assert.equal(wait.ok, true);
    assert.deepEqual(intentRows(f), before);
  } finally {
    await guarded?.close();
    await legacy.close();
    await f.service.close();
    await f.close();
  }
});

for (const operation of ['resume', 'handover'] as const)
  test(`one-level restriction preserves authorized ${operation} of an existing session and replay`, async () => {
    const f = await fixture();
    const service = new DelegationService({ ...f.options, env: { HUD_RUN: 'restrictive-marker' } });
    try {
      await f.bindAndEnd();
      const args =
        operation === 'resume'
          ? { linkId: 'link-a', mode: 'headless', request_key: 'existing-session' }
          : { ...f.args, predecessor: 'link-a', request_key: 'existing-session' };
      const tool = operation === 'resume' ? 'delegate_resume' : 'delegate_spawn';
      const accepted = (await service.invoke(f.source(), tool, args)) as { status: string };
      assert.equal(accepted.status, 'accepted');
      assert.deepEqual(await service.invoke(f.source(), tool, args), accepted);
      assert.equal(f.launches.length, 1);
    } finally {
      await service.close();
      await f.service.close();
      await f.close();
    }
  });

for (const difference of ['source', 'thread'] as const)
  test(`one-level exact identity does not reject an unrelated ${difference} with the same session ID`, async () => {
    const f = await fixture();
    try {
      const source =
        difference === 'source'
          ? {
              ...f.parent.registration.source!,
              rootPath: '/synthetic/other-source',
              sourceId: makeSourceId('codex', '/synthetic/other-source'),
            }
          : f.parent.registration.source!;
      const target = {
        ...f.parent.ref,
        sourceId: source.sourceId,
        threadId: difference === 'thread' ? 'other-thread' : null,
      };
      await f.ledger.transaction((tx) => {
        if (difference === 'source') insertRecord(tx, 'sources', source);
        tx.run(
          'INSERT INTO sessions(session_ref,harness,source_id,session_id,thread_id) VALUES(?,?,?,?,?)',
          refValue(target),
          target.harness,
          target.sourceId,
          target.sessionId,
          target.threadId ?? ''
        );
        insertRecord(tx, 'links', { ...f.input.link, linkId: 'other-identity', childRef: target });
        insertRun(tx, {
          ...f.input.run,
          runId: 'other-identity-run',
          linkId: 'other-identity',
          sourceId: source.sourceId,
          targetSessionRef: target,
          launchTokenHash: hashClaim(difference),
        });
      });
      const accepted = (await f.service.invoke(f.source(), 'delegate_spawn', f.args)) as { status: string };
      assert.equal(accepted.status, 'accepted');
      assert.equal(f.launches.length, 1);
    } finally {
      await f.service.close();
      await f.close();
    }
  });

test('one-level durable run identity remains restrictive without a corresponding child binding or link identity', async () => {
  const f = await fixture();
  const service = new DelegationService({ ...f.options, registration: f.child.registration, env: {} });
  try {
    await f.ledger.transaction((tx) =>
      tx.run('UPDATE runs SET target_session_ref=? WHERE run_id=?', refValue(f.child.ref), 'run-a')
    );
    const before = intentRows(f);
    await assert.rejects(
      service.invoke(f.source(f.child), 'delegate_spawn', f.args),
      /nested_delegation_not_supported/
    );
    assert.deepEqual(intentRows(f), before);
    assert.equal(f.launches.length, 0);
  } finally {
    await service.close();
    await f.service.close();
    await f.close();
  }
});

test('one-level marked child retains verified whoami and report while new-session spawn is denied', async () => {
  const f = await fixture();
  const env = { HUD_RUN: 'run-a', HUD_LINK: 'link-a', HUD_CLAIM: f.claim };
  const service = new DelegationService({ ...f.options, registration: f.child.registration, env });
  try {
    await f.startup();
    const binding = new HandshakeService({
      ledger: f.ledger,
      registration: f.child.registration,
      reader: f.reader,
      env,
      now: f.now,
    });
    assert.equal((await binding.whoami({}, f.child.authority)).ok, true);
    const whoami = (await service.invoke(f.source(f.child), 'delegate_whoami', {})) as { ok: boolean; state: string };
    assert.equal(whoami.ok, true);
    assert.equal(whoami.state, 'bound');
    const report = (await service.invoke(f.source(f.child), 'delegate_report', {
      runId: 'run-a',
      status: 'completed',
      summary: 'Synthetic completed task',
    })) as { ok: boolean };
    assert.equal(report.ok, true);
    await assert.rejects(
      service.invoke(f.source(f.child), 'delegate_spawn', f.args),
      /nested_delegation_not_supported/
    );
    assert.equal(f.launches.length, 0);
  } finally {
    await service.close();
    await f.service.close();
    await f.close();
  }
});
