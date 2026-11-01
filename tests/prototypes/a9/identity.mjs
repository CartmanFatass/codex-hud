import {
  accept,
  arm,
  assert,
  context,
  evidence,
  harnessPeer,
  hash,
  home,
  id,
  join,
  json,
  meta,
  newCaller,
  now,
  session,
  sessionOwner,
  source,
  stat,
  Suite,
  tx,
  value,
  writeFileSync,
} from './common.mjs';

const suite = new Suite('identity');
const invoke = (h, method, payload = {}, name) => h.call(method, { params: meta(), ...payload }, name);
const baseConfig = {
  mcp_servers: {
    hud: { command: 'synthetic-mcp', args: ['keep', 'space quote"'], env: { KEEP: 'retained' } },
    other: { command: 'synthetic-other', env: { KEEP: 'other' } },
  },
};
const leaves = (accepted) =>
  Object.entries({
    HUD_CLAIM: accepted.claim,
    HUD_RUN: accepted.runId,
    HUD_LINK: accepted.linkId,
    HUD_HOME: home,
  }).flatMap(([key, val]) => ['-c', `mcp_servers.hud.env.${key}=${json(val)}`]);

async function claimedHarness(f, options = {}) {
  const accepted = await accept(f.db, f.ctx, f.origin, id(), { mode: 'headless' });
  assert.equal(arm(f.db, accepted.runId, accepted.ticket, stat(process.pid)), true);
  const h = await harnessPeer(suite, f, { config: baseConfig, argv: leaves(accepted), ...options });
  tx(f.db, () =>
    evidence(
      f.db,
      'launch_receipt',
      { harness: h.stamp, launchers: [stat(process.pid)], sealed: [stat(process.pid)] },
      accepted.runId
    )
  );
  await h.start();
  return { h, accepted };
}

await suite.test(
  'T-01-4',
  'MCP OS-process restart preserves ProcessKey/generation/OwnerKey and original result',
  async (detail) => {
    const f = suite.fixture('restart');
    const { h, accepted } = await claimedHarness(f);
    const first = await invoke(h, 'whoami');
    const credential = f.db.prepare('SELECT * FROM claims WHERE run_id=?').get(accepted.runId);
    const spawned = await invoke(h, 'spawn', { key: 'restart-key', directory: f.directory });
    const exited = value(await h.peer.call('stop'));
    assert.equal(exited.signal, 'SIGKILL');
    const restarted = await h.start('new');
    const second = await invoke(h, 'whoami', {}, 'new');
    const replay = await invoke(h, 'spawn', { key: 'restart-key', directory: f.directory }, 'new');
    assert.notEqual(first.ctx.caller_id, restarted.callerId);
    assert.notEqual(first.ctx.context_id, second.ctx.context_id);
    for (const key of ['process_key', 'generation', 'session_ref', 'owner'])
      assert.equal(first.ctx[key], second.ctx[key]);
    assert.equal(spawned.runId, replay.runId);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM idempotency WHERE request_key=?').get('restart-key').n, 1);
    const after = f.db.prepare('SELECT * FROM claims WHERE run_id=?').get(accepted.runId);
    assert.equal(after.redeemed_at, credential.redeemed_at);
    assert.equal(
      after.redeemed_context_id,
      credential.redeemed_context_id,
      'restart rebuilds binding without consuming claim again'
    );
    detail.push({
      mcpPidsDiffer: true,
      harness: stat(h.stamp.pid),
      first: first.ctx,
      second: second.ctx,
      runId: replay.runId,
    });
    f.db.close();
  }
);

await suite.test(
  'T-01-5',
  'same-PID session switch closes old authorization and preserves historical child',
  async (detail) => {
    const f = suite.fixture('switch');
    const { h, accepted } = await claimedHarness(f);
    const first = await invoke(h, 'whoami');
    const before = stat(h.stamp.pid);
    value(await h.peer.call('switch', { ctx: first.ctx, sessionId: 'synthetic-b' }));
    await assert.rejects(
      () =>
        h.call('report', {
          params: { ...meta('synthetic-b'), authContext: first.ctx },
          runId: accepted.runId,
          linkId: accepted.linkId,
        }),
      /old context|old generation/
    );
    await assert.rejects(
      () => h.call('resume', { params: meta('synthetic-b'), oldContext: first.ctx }),
      /stale context/
    );
    const second = await h.call('identify', { params: meta('synthetic-b') });
    assert.equal(second.generation, first.ctx.generation + 1);
    assert.equal(before.proc_start, stat(h.stamp.pid).proc_start);
    assert.equal(before.pid, stat(h.stamp.pid).pid);
    assert.equal(f.db.prepare('SELECT child_ref FROM links WHERE link_id=?').get(accepted.linkId).child_ref, first.ref);
    assert.equal(f.db.prepare('SELECT state FROM claims WHERE run_id=?').get(accepted.runId).state, 'revoked');
    assert.equal(
      f.db.prepare('SELECT count(*) AS n FROM child_bindings WHERE run_id=? AND is_current=1').get(accepted.runId).n,
      0
    );
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM reports').get().n, 0);
    detail.push({
      pid: before.pid,
      procStart: before.proc_start,
      oldGeneration: first.ctx.generation,
      newGeneration: second.generation,
      historyRef: first.ref,
    });
    f.db.close();
  }
);

await suite.test(
  'T-01-27',
  'synthetic TUI/exec config leaves, exact metadata/header, fork and old-claim rejection, dual homes',
  async (detail) => {
    for (const shape of ['tui', 'exec']) {
      const f = suite.fixture(`config-${shape}`);
      // Real synthetic cc parent process supplies the parent context; target is Codex.
      const ccOrigin = source(f.db, join(f.directory, 'claude-root'), 'claude');
      const cc = await harnessPeer(suite, { ...f, origin: ccOrigin }, { sessionId: 'synthetic-cc' });
      await cc.start();
      value(await cc.peer.call('call-record', { toolUseId: 'cc-parent-call' }));
      f.ctx = await cc.call('identify', { params: meta('synthetic-cc', { toolUseId: 'cc-parent-call' }) });
      const accepted = await accept(f.db, f.ctx, f.origin, `config-${shape}`, { mode: 'headless', shape });
      assert.equal(arm(f.db, accepted.runId, accepted.ticket, stat(process.pid)), true);
      const original = await harnessPeer(suite, f, { config: baseConfig, argv: leaves(accepted) });
      const forked = await harnessPeer(suite, f, {
        config: baseConfig,
        argv: leaves(accepted),
        sessionId: 'synthetic-fork',
      });
      tx(f.db, () =>
        evidence(
          f.db,
          'launch_receipt',
          { harness: original.stamp, launchers: [stat(process.pid)], sealed: [stat(process.pid)] },
          accepted.runId
        )
      );
      const ready = await original.start();
      await forked.start();
      assert.equal(ready.env.KEEP, 'retained');
      assert.equal(ready.envSource, 'process.env', 'configuration env reaches the actual MCP OS process');
      assert.equal(ready.env.HUD_HOME, home);
      assert.deepEqual(ready.preserved, {
        command: baseConfig.mcp_servers.hud.command,
        args: baseConfig.mcp_servers.hud.args,
        other: baseConfig.mcp_servers.other,
      });
      assert.equal(
        hash(ready.env.HUD_CLAIM),
        f.db.prepare('SELECT claim_hash FROM claims WHERE run_id=?').get(accepted.runId).claim_hash
      );
      await original.call('initialize');
      await original.call('list');
      assert.equal(
        f.db.prepare('SELECT count(*) AS n FROM caller_contexts WHERE caller_id=?').get(ready.callerId).n,
        0
      );
      await assert.rejects(
        () =>
          original.call('identify', { params: { arguments: { _meta: meta()._meta, sessionId: 'synthetic-session' } } }),
        /identity_source_missing/
      );
      await assert.rejects(
        () => original.call('identify', { params: meta('synthetic-session', { threadId: 'native-child' }) }),
        /native child/
      );
      const claimed = await forked.call('whoami', { params: meta('synthetic-fork') });
      assert.equal(claimed.state, 'claimed');
      assert.equal(claimed.authorized, false);
      assert.equal(f.db.prepare('SELECT child_ref FROM links WHERE link_id=?').get(accepted.linkId).child_ref, null);
      await assert.rejects(
        () => forked.call('report', { params: meta('synthetic-fork'), runId: accepted.runId, linkId: accepted.linkId }),
        /report_unauthorized/
      );
      const bound = await invoke(original, 'whoami');
      assert.equal(bound.authorized, true);
      const originB = source(f.db, join(f.directory, 'other-codex-home'));
      const b = await harnessPeer(suite, { ...f, origin: originB }, { config: baseConfig, argv: leaves(accepted) });
      await b.start();
      const bIdentity = await invoke(b, 'identify');
      assert.notEqual(bIdentity.session_ref, bound.ref);
      assert.notEqual(bIdentity.owner, bound.ctx.owner);
      await assert.rejects(() => invoke(b, 'whoami'), /claim_conflict|source/);
      const headerPath = join(f.origin.root, 'synthetic-session.json');
      writeFileSync(headerPath, json({ sessionId: 'synthetic-session', sourceId: originB.sourceId }));
      await assert.rejects(() => invoke(original, 'identify'), /source\/header/);
      writeFileSync(headerPath, json({ sessionId: 'synthetic-session', sourceId: f.origin.sourceId }));
      f.db.prepare("UPDATE claims SET state='revoked' WHERE run_id=?").run(accepted.runId);
      await assert.rejects(() => invoke(original, 'whoami'), /claim_conflict/);
      assert.equal(baseConfig.mcp_servers.hud.command, 'synthetic-mcp');
      assert.deepEqual(baseConfig.mcp_servers.hud.args, ['keep', 'space quote"']);
      assert.equal(baseConfig.mcp_servers.other.env.KEEP, 'other');
      detail.push({
        shape,
        transport: 'real argv -c leaf overrides parsed by synthetic harness, not real Codex',
        preservedConfig: true,
        forkOnlyClaimed: true,
        oldClaimRejected: true,
        parentHarness: ccOrigin.harness,
        uniqueSourceRefs: [bound.ref, bIdentity.session_ref],
      });
      f.db.close();
    }
  }
);

await suite.test(
  'T-01-33',
  'cc current toolUseId origin rejects missing/native source despite root env and claim',
  async (detail) => {
    const f = suite.fixture('cc-calls');
    const ccOrigin = source(f.db, join(f.directory, 'cc-root'), 'claude');
    const h = await harnessPeer(
      suite,
      { ...f, origin: ccOrigin },
      { config: { mcp_servers: { hud: { env: { HUD_CLAIM: 'synthetic-root-claim' } } } } }
    );
    const ready = await h.start();
    const before = f.db.prepare('SELECT count(*) AS n FROM caller_contexts').get().n;
    await assert.rejects(
      () => h.call('spawn', { params: meta(), key: 'missing', directory: f.directory }),
      /toolUseId/
    );
    value(await h.peer.call('call-record', { toolUseId: 'native', agentId: 'synthetic-agent' }));
    await assert.rejects(
      () =>
        h.call('spawn', {
          params: { ...meta('synthetic-session', { toolUseId: 'native' }), claim: ready.env.HUD_CLAIM },
          key: 'native',
          directory: f.directory,
        }),
      /toolUseId/
    );
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM caller_contexts').get().n, before);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM idempotency').get().n, 0);
    value(await h.peer.call('call-record', { toolUseId: 'root' }));
    const allowed = await h.call('spawn', {
      params: meta('synthetic-session', { toolUseId: 'root' }),
      key: 'root',
      directory: f.directory,
    });
    assert.equal(allowed.ctx.harness, 'claude');
    assert.equal(allowed.ctx.generation, 1, 'rejected native call does not switch root generation');
    detail.push({
      rejected: ['missing', 'native'],
      currentRootAccepted: true,
      callerId: ready.callerId,
      runId: allowed.runId,
    });
    f.db.close();
  }
);
suite.finish();
