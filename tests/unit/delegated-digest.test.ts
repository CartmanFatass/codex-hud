import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  parseDelegatedDigest,
  planDelegatedDigest,
  runDelegatedDigest,
} from '../../src/core/materials/delegated-digest.js';
import { DigestFailure } from '../../src/core/materials/source-config.js';
import {
  digestFixture,
  deferredTransport,
  response,
  withResponseText,
  until,
  tick,
  SUMMARY,
  PRIVATE,
} from '../fixtures/delegated-digest.js';

const reason = (code: string) => (error: unknown) => error instanceof DigestFailure && error.reason === code;
function sidecars(dir: string): string[] {
  const base = join(dir, 'model-runtime-v1', 'materials-v1');
  return fs.existsSync(base) ? fs.readdirSync(base).filter((p) => p.endsWith('.json')) : [];
}
test('text-hook fixture preserves native Response getters, methods and one-shot body consumption', async () => {
  const native = new Response('synthetic body', { status: 201, headers: { 'x-synthetic': 'fixture' } });
  let reads = 0;
  const reply = withResponseText(native, () => {
    reads++;
    return native.text();
  });
  assert.equal(reply.ok, true);
  assert.equal(reply.status, 201);
  assert.equal(reply.headers.get('x-synthetic'), 'fixture');
  assert.equal(reply.bodyUsed, false);
  assert.equal(native.bodyUsed, false);
  const clone = reply.clone();
  assert.equal(clone.status, 201);
  assert.equal(await clone.text(), 'synthetic body');
  assert.equal(reads, 0);
  assert.equal(reply.bodyUsed, false);
  assert.equal(native.bodyUsed, false);
  assert.equal(await reply.text(), 'synthetic body');
  assert.equal(reads, 1);
  assert.equal(reply.bodyUsed, true);
  assert.equal(native.bodyUsed, true);
  await assert.rejects(reply.text(), TypeError);
  assert.equal(reads, 2);
});

test('strict response parser admits only bounded single-line conclusion/basis/caveats', () => {
  assert.deepEqual(parseDelegatedDigest('{"conclusion":"Done."}'), { conclusion: 'Done.' });
  for (const value of [
    null,
    [],
    { conclusion: 1 },
    {},
    { conclusion: '' },
    { conclusion: 'x'.repeat(161) },
    { conclusion: 'line\nbreak' },
    { conclusion: '\u001b[31mred' },
    { conclusion: 'ok', action: 'run' },
    { conclusion: 'ok', basis: [] },
    { conclusion: 'ok', caveats: '\u2028' },
  ]) {
    assert.equal(parseDelegatedDigest(JSON.stringify(value)), null);
  }
  assert.equal(parseDelegatedDigest('```json\n{"conclusion":"Done."}\n```'), null);
  assert.equal(
    Array.from(parseDelegatedDigest(JSON.stringify({ conclusion: '😀'.repeat(160) }))!.conclusion).length,
    160
  );
});

test('actual service generates and safely reuses generic cache with exact route and provenance', async () => {
  const f = await digestFixture();
  let calls = 0;
  const fetcher = (async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(url, 'https://synthetic.invalid/v1/chat/completions');
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer synthetic-key');
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, 'synthetic-model');
    assert.equal(JSON.parse(body.messages[1].content).completed_report_summary, SUMMARY);
    assert.ok(!JSON.stringify(body).includes(PRIVATE));
    assert.ok(!JSON.stringify(body).includes('forbidden'));
    return response();
  }) as typeof fetch;
  try {
    const before = f.db.prepare('SELECT state FROM runs').get()!.state;
    const first = await runDelegatedDigest(f.input, { fetch: fetcher });
    assert.equal(first.cached, false);
    assert.deepEqual(first.ref, f.ref);
    assert.equal(first.language, 'en');
    assert.equal(first.material, 'completed_report_summary');
    assert.equal(first.recipientId, f.recipient.recipientId);
    assert.equal(first.format, 'hud-delegated-digest');
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.digest.conclusion, 'Input validation is implemented.');
    const second = await runDelegatedDigest(f.input, { fetch: fetcher });
    assert.equal(second.cached, true);
    assert.equal(second.generatedAt, first.generatedAt);
    assert.equal(calls, 1);
    const proof = JSON.parse(
      fs.readFileSync(join(f.dir, 'model-runtime-v1', 'materials-v1', sidecars(f.dir)[0]), 'utf8')
    );
    assert.deepEqual(proof.envelope.fragments[0].provenance[0].ref, f.ref);
    assert.equal(proof.envelope.fragments[0].provenance[0].origin, 'delegated');
    assert.equal(f.db.prepare('SELECT state FROM runs').get()!.state, before);
    assert.equal(f.db.prepare('SELECT summary FROM reports').get()!.summary, SUMMARY);
    f.config.revision++;
    f.write('model.json', f.config);
    assert.equal((await runDelegatedDigest(f.input, { fetch: fetcher })).cached, false);
    assert.equal(calls, 2);
  } finally {
    f.cleanup();
  }
});

for (const mode of ['missing', 'off', 'disabled', 'paused', 'scope', 'outbound', 'invalid', 'wrong-recipient']) {
  test(`plan/run refuse ${mode} with zero summary reads, cache, budget or fetch`, async () => {
    const f = await digestFixture();
    const queries: string[] = [];
    let calls = 0;
    try {
      f.db.prepare('UPDATE reports SET summary=?').run('DENIED_SENTINEL'.repeat(100000));
      if (mode === 'missing') {
        fs.unlinkSync(join(f.dir, 'model.json'));
        fs.writeFileSync(
          join(f.home, 'settings.json'),
          JSON.stringify({
            briefing: 'api',
            resultDigest: true,
            briefAgents: true,
            briefMain: true,
            agentProgress: true,
            briefingApiKey: 'synthetic-legacy-key',
          }),
          { mode: 0o600 }
        );
      }
      if (mode === 'off') f.write('model.json', { ...f.config, connection: { backend: 'off' } });
      if (mode === 'disabled') {
        f.config.delegatedDigest.enabled = false;
        f.write('model.json', f.config);
      }
      if (mode === 'paused') {
        f.config.delegatedDigest.paused = true;
        f.write('model.json', f.config);
      }
      if (mode === 'scope') f.write('model.json', { ...f.config, materials: [] });
      if (mode === 'outbound') f.write('outbound.json', { ...f.policy, grants: [] });
      if (mode === 'invalid') fs.writeFileSync(join(f.dir, 'model.json'), '{bad');
      const plan = await planDelegatedDigest(f.input, { onQuery: (q) => queries.push(q) });
      assert.equal(JSON.stringify(plan).includes('DENIED_SENTINEL'), false);
      assert.equal(JSON.stringify(plan).includes(f.home), false);
      if (mode !== 'wrong-recipient') assert.equal(plan.readiness.ready, false);
      await assert.rejects(
        runDelegatedDigest(
          { ...f.input, expectedRecipient: mode === 'wrong-recipient' ? '0'.repeat(64) : f.input.expectedRecipient },
          {
            onQuery: (q) => queries.push(q),
            fetch: (async () => {
              calls++;
              return response();
            }) as typeof fetch,
          }
        )
      );
      assert.equal(calls, 0);
      assert.ok(!queries.some((q) => q.startsWith('SELECT summary')));
      assert.equal(fs.existsSync(join(f.dir, 'model-runtime-v1')), false);
    } finally {
      f.cleanup();
    }
  });
}

for (const change of ['scope', 'outbound', 'credential', 'handover', 'binding', 'source-directory']) {
  test(`deferred reply is discarded after same-source ${change} change`, async () => {
    const f = await digestFixture();
    const transport = deferredTransport();
    try {
      const pending = runDelegatedDigest(f.input, { fetch: transport.fetcher });
      const rejected = assert.rejects(pending, reason('authorization_changed'));
      await until(() => transport.calls.length === 1);
      if (change === 'scope') f.write('model.json', { ...f.config, revision: 2, materials: [] });
      if (change === 'outbound') f.write('outbound.json', { ...f.policy, revision: 2, grants: [] });
      if (change === 'credential') f.env.SYNTHETIC_DIGEST_KEY = 'changed';
      if (change === 'handover') f.db.exec("UPDATE links SET state='handed_over',current_owner=0");
      if (change === 'binding') {
        f.db.exec('PRAGMA foreign_keys=OFF');
        f.db.exec("UPDATE child_bindings SET caller_context_id='different'");
      }
      if (change === 'source-directory') {
        fs.renameSync(f.dir, f.dir + '.old');
        fs.mkdirSync(f.dir, { mode: 0o700 });
        f.write('model.json', f.config);
        f.write('outbound.json', f.policy);
      }
      transport.calls[0].resolve(response());
      await rejected;
      assert.deepEqual(sidecars(f.dir), []);
      assert.equal(fs.existsSync(join(f.home, 'agent-log.json')), false);
    } finally {
      f.cleanup();
    }
  });
}

for (const reply of [
  '{"conclusion":42}',
  '{"conclusion":"ok","action":"launch"}',
  '```json\n{"conclusion":"ok"}\n```',
  JSON.stringify({ conclusion: '这是一个清晰的中文总结，说明已经完成了修改，并通过了所有相关检查。' }),
]) {
  test('invalid-format or wrong-language reply is never reusable', async () => {
    const f = await digestFixture();
    try {
      await assert.rejects(
        runDelegatedDigest(f.input, { fetch: (async () => response(reply)) as typeof fetch }),
        reason('invalid_response')
      );
      assert.deepEqual(sidecars(f.dir), []);
    } finally {
      f.cleanup();
    }
  });
}

test('source cap is shared across concurrent model instances; cancellation and late reply never publish', async () => {
  const f = await digestFixture();
  const transport = deferredTransport();
  try {
    f.config.delegatedDigest.hourlyCap = 1;
    f.write('model.json', f.config);
    const controller = new AbortController();
    const first = runDelegatedDigest(f.input, { fetch: transport.fetcher, signal: controller.signal });
    const cancelled = assert.rejects(first, reason('cancelled'));
    await until(() => transport.calls.length === 1);
    const second = runDelegatedDigest(f.input, { fetch: transport.fetcher, deadlineMs: 50 });
    await assert.rejects(second, reason('timeout'));
    assert.equal(transport.calls.length, 1);
    controller.abort();
    await cancelled;
    transport.calls[0].resolve(response());
    await tick();
    await tick();
    assert.deepEqual(sidecars(f.dir), []);
    await assert.rejects(runDelegatedDigest(f.input, { fetch: transport.fetcher }), reason('hourly_cap'));
    assert.equal(transport.calls.length, 1);
  } finally {
    f.cleanup();
  }
});

test('cache commit observes revocation inside asynchronous body delivery', async () => {
  const f = await digestFixture();
  try {
    const fetcher = (async () => {
      const r = response();
      const original = r.text.bind(r);
      return withResponseText(r, async () => {
        const text = await original();
        f.write('outbound.json', { ...f.policy, revision: 2, grants: [] });
        return text;
      });
    }) as typeof fetch;
    await assert.rejects(runDelegatedDigest(f.input, { fetch: fetcher }), reason('authorization_changed'));
    assert.deepEqual(sidecars(f.dir), []);
  } finally {
    f.cleanup();
  }
});

test('queued same-source request observes revocation and cannot revive after bytes are restored', async () => {
  const { SmallModel } = await import('../../src/collectors/small-model.js');
  const { captureSource } = await import('../../src/core/materials/source-config.js');
  const { openCompletedReport } = await import('../../src/core/delegated-report-read.js');
  const { materialRequest } = await import('../../src/core/materials/request.js');
  const f = await digestFixture();
  const transport = deferredTransport();
  const target = await openCompletedReport(f.home, f.input.runId, f.input.reportId);
  const prepared = captureSource(f.home, f.ref.sourceId, f.env, () => target.current());
  prepared.prepareRuntime();
  const model = new SmallModel({
    dir: prepared.runtimeDir,
    env: {},
    account: 'synthetic-account',
    materials: prepared.authority,
    fetch: transport.fetcher,
  });
  model.configure({ backend: 'api', api: prepared.api! });
  const request = (key: string) =>
    materialRequest('digest', {
      purpose: 'digest',
      subjects: [target.subject],
      authority: prepared.authority,
      compose: (envelope) => ({
        feature: 'digest',
        system: 'Synthetic test',
        prompt: envelope.fragments[0].text,
        cacheKey: key,
      }),
    });
  try {
    const first = model.submit(request('first'));
    await until(() => transport.calls.length === 1);
    const queued = model.submit(request('second'));
    assert.equal(queued.status, 'queued');
    f.write('outbound.json', { ...f.policy, revision: 2, grants: [] });
    assert.equal(queued.isAuthorized?.(), false); // an actual boundary observes the revocation
    f.write('outbound.json', f.policy);
    assert.equal(queued.isAuthorized?.(), false);
    transport.calls[0].resolve(response());
    assert.equal((await first.result).ok, false);
    assert.equal((await queued.result).ok, false);
    assert.equal(transport.calls.length, 1);
    assert.deepEqual(sidecars(f.dir), []);
  } finally {
    model.cancelAll();
    await model.flushTelemetry();
    target.close();
    f.cleanup();
  }
});

test('language, recipient, report and full-ref changes cannot reuse a generic cache entry', async () => {
  const { captureSource } = await import('../../src/core/materials/source-config.js');
  const f = await digestFixture();
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return response(
      f.config.delegatedDigest.language === 'zh'
        ? JSON.stringify({ conclusion: '合成组件已实现输入验证。', basis: '报告表示相关检查通过。' })
        : undefined
    );
  }) as typeof fetch;
  try {
    await runDelegatedDigest(f.input, { fetch: fetcher });
    f.config.revision++;
    f.config.delegatedDigest.language = 'zh';
    f.write('model.json', f.config);
    const chinese = await runDelegatedDigest(f.input, { fetch: fetcher });
    assert.equal(chinese.cached, false);
    assert.equal(chinese.language, 'zh');
    if (f.config.connection.backend !== 'api') throw new Error('fixture');
    f.config.revision++;
    f.config.connection.account = 'synthetic-other-account';
    f.write('model.json', f.config);
    const recipient = captureSource(f.home, f.ref.sourceId, f.env, () => true).recipient!;
    f.policy.revision++;
    f.policy.grants[0].recipientId = recipient.recipientId;
    f.write('outbound.json', f.policy);
    const input = { ...f.input, expectedRecipient: recipient.recipientId };
    assert.equal((await runDelegatedDigest(input, { fetch: fetcher })).cached, false);
    f.db.exec(
      "INSERT INTO reports SELECT 'another-report',run_id,link_id,child_binding_id,caller_id,caller_context_id,context_generation,status,summary,path,1 FROM reports"
    );
    f.db
      .prepare("INSERT INTO events(run_id,link_id,kind,payload,at) VALUES(?,?,'report.received',?,101)")
      .run(f.input.runId, 'synthetic-link', JSON.stringify({ reportId: 'another-report' }));
    assert.equal(
      (await runDelegatedDigest({ ...input, reportId: 'another-report' }, { fetch: fetcher })).cached,
      false
    );
    assert.equal(calls, 4);
    const other = await digestFixture('pi', 'other-thread');
    try {
      assert.equal(
        (await runDelegatedDigest(other.input, { fetch: (async () => response()) as typeof fetch })).cached,
        false
      );
    } finally {
      other.cleanup();
    }
  } finally {
    f.cleanup();
  }
});

test('unsafe existing source runtime is refused without chmod or repair', async () => {
  const f = await digestFixture();
  try {
    const runtime = join(f.dir, 'model-runtime-v1');
    fs.mkdirSync(runtime, { mode: 0o755 });
    fs.chmodSync(runtime, 0o755);
    await assert.rejects(
      runDelegatedDigest(f.input, {
        fetch: (async () => {
          throw new Error('must not fetch');
        }) as typeof fetch,
      }),
      reason('runtime_unsafe')
    );
    assert.equal(fs.statSync(runtime).mode & 0o777, 0o755);
    assert.deepEqual(fs.readdirSync(runtime), []);
  } finally {
    f.cleanup();
  }
});

for (const language of [['en'], ['zh'], null, true, 1, {}]) {
  test(`malformed language ${JSON.stringify(language)} refuses plan/run before material and runtime`, async () => {
    const f = await digestFixture();
    const queries: string[] = [];
    let fetches = 0;
    try {
      f.write('model.json', { ...f.config, delegatedDigest: { ...f.config.delegatedDigest, language } });
      const options = {
        onQuery: (sql: string) => queries.push(sql),
        fetch: (async () => {
          fetches++;
          return response();
        }) as typeof fetch,
      };
      const plan = await planDelegatedDigest(f.input, options);
      assert.deepEqual(plan.readiness, { ready: false, reason: 'source_configuration_invalid' });
      assert.equal(Object.hasOwn(plan, 'language'), false);
      await assert.rejects(runDelegatedDigest(f.input, options), reason('source_configuration_invalid'));
      assert.equal(
        queries.some((sql) => sql.startsWith('SELECT summary')),
        false
      );
      assert.equal(fs.existsSync(join(f.dir, 'model-runtime-v1')), false);
      assert.equal(fetches, 0);
    } finally {
      f.cleanup();
    }
  });
}

for (const cancellation of ['abort', 'deadline'] as const) {
  test(`deferred response body ${cancellation} settles transport and releases its claim before late body completion`, async () => {
    const f = await digestFixture();
    const controller = new AbortController();
    let resolveBody!: (text: string) => void;
    const body = new Promise<string>((resolve) => {
      resolveBody = resolve;
    });
    let bodyReads = 0;
    let fetches = 0;
    let deliveries = 0;
    const runtime = join(f.dir, 'model-runtime-v1');
    const claims = (): Record<string, { id: string }> =>
      JSON.parse(fs.readFileSync(join(runtime, 'claims.json'), 'utf8'));
    const fetcher = (async () => {
      fetches++;
      const reply = response();
      // Headers arrive, but this body deliberately never observes AbortSignal.
      return withResponseText(reply, () => {
        bodyReads++;
        return body;
      });
    }) as typeof fetch;
    f.config.delegatedDigest.hourlyCap = 1;
    f.write('model.json', f.config);
    const pending = runDelegatedDigest(
      f.input,
      { fetch: fetcher, signal: controller.signal, ...(cancellation === 'deadline' ? { deadlineMs: 500 } : {}) },
      () => {
        deliveries++;
      }
    );
    const rejected = assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof DigestFailure &&
        error.exitCode === 6 &&
        error.reason === (cancellation === 'deadline' ? 'timeout' : 'cancelled')
    );
    try {
      await until(() => bodyReads === 1);
      assert.equal(fetches, 1);
      const entries = Object.entries(claims());
      assert.equal(entries.length, 1);
      const [digest, claim] = entries[0];
      const activeFile = join(runtime, '.coordination', `${claim.id}.active`);
      assert.equal(fs.existsSync(activeFile), true);
      const started = Date.now();
      if (cancellation === 'abort') controller.abort();
      await rejected;
      // No need to resolve the body: SmallModel must reach its ordinary finally/finish path.
      await until(() => !fs.existsSync(activeFile) && !Object.hasOwn(claims(), digest));
      assert.ok(Date.now() - started < 4000, 'bounded synthetic cancellation and claim release');
      assert.equal(deliveries, 0);
      assert.deepEqual(sidecars(f.dir), []);
      assert.equal(fetches, 1);
      // A new explicit request reaches the shared cap, rather than waiting on a stranded peer claim.
      await assert.rejects(runDelegatedDigest(f.input, { fetch: fetcher, deadlineMs: 500 }), reason('hourly_cap'));
      assert.equal(fetches, 1);
      resolveBody(await response().text());
      await tick();
      await tick();
      assert.equal(deliveries, 0);
      assert.deepEqual(sidecars(f.dir), []);
      assert.equal(fetches, 1);
      assert.deepEqual(claims(), {});
    } finally {
      controller.abort();
      resolveBody(await response().text());
      await pending.catch(() => undefined);
      await rejected.catch(() => undefined);
      // Also drain the old implementation on assertion failure, without retaining a 30-second timer.
      await until(
        () =>
          !fs.existsSync(join(runtime, '.coordination')) ||
          !fs.readdirSync(join(runtime, '.coordination')).some((name) => name.endsWith('.active'))
      );
      f.cleanup();
    }
  });
}
