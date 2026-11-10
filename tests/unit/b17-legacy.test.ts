import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { SmallModel, requestDigest, writePrivateFile, type ModelRequest } from '../../src/collectors/small-model.js';
import { legacyRequest, materialRequest } from '../../src/core/materials/request.js';
import { briefMaterial, repairPrompt } from '../../src/collectors/briefing.js';
import * as jobs from '../../src/collectors/model-jobs.js';
import { progressSystemPrompt } from '../../src/collectors/progress-summary.js';
import { ModelProbe } from '../../src/collectors/model-probe.js';
import { defaultSettings } from '../../src/settings.js';
import { makeSourceId } from '../../src/core/identity.js';
import { buildMaterials, fingerprint, isEnvelope } from '../../src/core/materials/index.js';
const api = { base: 'https://synthetic.invalid/v1', model: 'synthetic-model', key: '' };
const reply = (text = 'Synthetic reply') => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
function home(
  raw: Record<string, unknown> = { briefing: 'api', briefingApiBase: api.base, briefingApiModel: api.model }
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b17-legacy-'));
  const file = path.join(root, 'sessions', 'synthetic.jsonl');
  writePrivateFile(
    file,
    JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic-root', source: 'cli' } }) + '\n'
  );
  const settings = path.join(root, 'hud-settings.json');
  writePrivateFile(settings, JSON.stringify(raw));
  return {
    root,
    file,
    settings,
    dir: path.join(root, 'hud', 'model-cache'),
    env: {
      HOME: root,
      CODEX_HOME: root,
      HUD_HOME: path.join(root, 'universal'),
      HUD_SETTINGS_PATH: undefined,
      CODEX_HUD_SETTINGS_PATH: undefined,
    },
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
function request(feature = 'brief', text = 'Synthetic public material', fixture: ReturnType<typeof home>, extras = {}) {
  return legacyRequest(feature, [{ sessionId: 'synthetic-root', rolloutPath: fixture.file }], () => ({
    feature,
    system: 'Static synthetic instructions',
    prompt: text,
    cacheKey: 'synthetic-cache',
    ...extras,
  }));
}
// Actual pre-implementation HTTP body hashes captured from 1ebebd4, using only fixed synthetic input.
const goldenHashes = [
  'd44e99fa0caa6a875ae7620bb50e8970e09f42de537ea17ecfbbdda3e43e6697',
  '62a4856dc3c07c57b2cac0a3e8a6edffbec2d3856e960f27298170964549d36d',
  'fd8556c31eceaccde8751bacfaf183fbdb13185cc8ed7b70105701a889de3cb2',
  '420b80cf667e8e276042cf532e9e5e62e5e12871c658c621c7d5efdf5e74b3fb',
  '7db9716f1a9957fd44159309c10048266e10b8292522b7edcd2332177ec7d4ac',
  'dea6e9921d6e41d6094a1fe76a03bb587240c1b57dd77ceb33baeb7e9b6d28af',
  'ac256b03b0e9eeceafbe50c6a1963586e8337636132a08220e34dc7257a2b434',
  '25c2ab52728ecc1bc13b2757b8d273bec7252c406d0c80a3f2f572c5e52e54b4',
  '5e049834a49ee473a3112aea610b458000f7bb62a4810e25abe6494d13a7f2ee',
];
function legacyRequests(): ModelRequest[] {
  const tree = {
    rootId: 'synthetic-root',
    nodes: [
      {
        id: 'synthetic-child',
        name: 'Worker',
        status: 'running' as const,
        depth: 1,
        children: [],
        task: 'Verify synthetic parser',
        startedAt: new Date(1700000000000),
        lastReport: { text: 'Checked parser fixtures', kind: 'update' as const, at: new Date(1700000001000) },
      },
    ],
    totalCount: 1,
    updatedAt: new Date(1700000002000),
  };
  const material = briefMaterial(tree, {
    scope: 'agents',
    language: 'en',
    now: 1700000002000,
    main: null,
    recap: null,
    since: undefined as unknown as null,
  })!;
  return [
    { feature: material.feature, ...material.write(), language: 'en' },
    { feature: 'brief', system: material.write().system, prompt: repairPrompt('synthetic malformed reply') },
    { feature: 'digest', system: jobs.digestSystemPrompt('en'), prompt: jobs.digestPrompt('Synthetic final answer') },
    { feature: 'labels', system: jobs.labelsSystemPrompt('en'), prompt: jobs.labelsPrompt(['Synthetic task']) },
    { feature: 'title', system: jobs.titleSystemPrompt('en'), prompt: jobs.titlePrompt('Synthetic first request') },
    {
      feature: 'cause',
      system: jobs.causeSystemPrompt('en'),
      prompt: jobs.causePrompt('Synthetic tool', 'Synthetic error'),
    },
    { feature: 'approval', system: jobs.approvalSystemPrompt('en'), prompt: jobs.approvalPrompt('echo synthetic') },
    {
      feature: 'changes',
      system: jobs.changeSystemPrompt('en'),
      prompt: jobs.changeSummaryInput([], 'Synthetic hunk'),
    },
    {
      feature: 'progress',
      system: progressSystemPrompt('en'),
      prompt: '<observations>\n{"reports":["Synthetic progress"]}\n</observations>',
    },
  ];
}

test('golden legacy Codex: explicit backend plus historical feature defaults preserves identical request bytes', async () => {
  const fixture = home({
    briefing: 'api',
    briefingApiBase: api.base,
    briefingApiModel: api.model,
    resultDigest: true,
    failureCause: true,
    changeSummary: true,
    approvalDescription: true,
  });
  const captured: string[] = [];
  const model = new SmallModel({
    dir: fixture.dir,
    env: fixture.env,
    fetch: (async (_url, init) => {
      captured.push(createHash('sha256').update(String(init?.body)).digest('hex'));
      return reply();
    }) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  try {
    for (const original of legacyRequests()) {
      assert.ok(
        (
          await model.submit(
            legacyRequest(
              original.feature,
              [{ sessionId: 'synthetic-root', rolloutPath: fixture.file }],
              () => original
            )
          ).result
        ).ok,
        original.feature
      );
    }
    assert.deepEqual(captured, goldenHashes);
    await model.flushTelemetry();
  } finally {
    model.cancelAll();
    fixture.close();
  }
});

test('T-07-2/17 legacy: default booleans, credentials, malformed settings and new sources cannot create a grant', async () => {
  for (const raw of [
    {},
    { briefingApiKey: 'synthetic-key' },
    { briefing: 'off' },
    { briefing: 'api', briefAgents: null },
    { briefing: 'api', briefAgents: 'true' },
    { briefing: 'api', briefAgents: false },
  ]) {
    const fixture = home(raw);
    let calls = 0;
    const model = new SmallModel({
      dir: fixture.dir,
      env: fixture.env,
      fetch: (async () => {
        calls++;
        return reply();
      }) as typeof fetch,
    });
    model.configure({ backend: 'api', api: { ...api, base: '' } });
    try {
      assert.ok(!(await model.submit(request('brief', 'UNAUTHORIZED', fixture)).result).ok);
      assert.equal(calls, 0);
    } finally {
      model.cancelAll();
      fixture.close();
    }
  }
  const fixture = home();
  let calls = 0;
  const model = new SmallModel({
    dir: fixture.dir,
    env: fixture.env,
    fetch: (async () => {
      calls++;
      return reply();
    }) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  try {
    for (const origin of ['delegated', 'native'] as const) {
      const unauthorized = legacyRequest(
        'brief',
        [
          {
            sessionId: 'synthetic-root',
            rolloutPath: fixture.file,
            origin,
            ref: {
              harness: 'claude',
              sourceId: fingerprint('different-source'),
              sessionId: 'synthetic-root',
              threadId: null,
            },
          },
        ],
        () => {
          throw new Error('new source must not compose');
        }
      );
      assert.ok(!(await model.submit(unauthorized).result).ok);
    }
    assert.equal(calls, 0);
  } finally {
    model.cancelAll();
    fixture.close();
  }
});

test('T-07-6/17 legacy old caches remain readable only in proven original scope and are never migrated or deleted', async () => {
  const fixture = home();
  const original = {
    feature: 'brief',
    system: 'Static synthetic instructions',
    prompt: 'Synthetic public material',
    cacheKey: 'synthetic-cache',
  };
  const digest = requestDigest(original, {
    backend: 'api',
    endpoint: api.base + '/chat/completions',
    model: api.model,
    reasoning: false,
  });
  const cache = path.join(fixture.dir, 'cache.json');
  writePrivateFile(cache, JSON.stringify({ [digest]: { text: 'Original legacy reply', at: 1700000000000 } }));
  const before = fs.readFileSync(cache, 'utf8');
  let calls = 0;
  const model = new SmallModel({
    dir: fixture.dir,
    env: fixture.env,
    fetch: (async () => {
      calls++;
      return reply();
    }) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  try {
    assert.deepEqual(await model.submit(request('brief', 'Synthetic public material', fixture)).result, {
      ok: true,
      text: 'Original legacy reply',
      cached: true,
    });
    writePrivateFile(
      fixture.settings,
      JSON.stringify({ briefing: 'api', briefingApiBase: api.base, briefAgents: false })
    );
    assert.ok(!(await model.submit(request('brief', 'Synthetic public material', fixture)).result).ok);
    assert.equal(calls, 0);
    assert.equal(fs.readFileSync(cache, 'utf8'), before);
  } finally {
    model.cancelAll();
    fixture.close();
  }
});

test('T-07-7 legacy recipient/credential changes and preflight cancellation do not send to a new recipient', async () => {
  const fixture = home();
  let calls = 0;
  const env: NodeJS.ProcessEnv = { ...fixture.env, CODEX_HUD_BRIEF_API_KEY: 'synthetic-account-a' };
  const model = new SmallModel({
    dir: fixture.dir,
    env,
    fetch: (async () => {
      calls++;
      return reply();
    }) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  try {
    assert.ok((await model.submit(request('brief', 'first', fixture)).result).ok);
    env.CODEX_HUD_BRIEF_API_KEY = 'synthetic-account-b';
    assert.ok(!(await model.submit(request('brief', 'second', fixture)).result).ok);
    assert.equal(calls, 1);
    const queued = model.submit(request('brief', 'preflight', fixture));
    model.cancelAll();
    assert.ok(!(await queued.result).ok);
    assert.equal(calls, 1);
  } finally {
    model.cancelAll();
    await model.flushTelemetry();
    fixture.close();
  }
});

test('T-07-7/17 legacy explicit policy is authoritative; deleting it cannot resurrect the compatibility grant', async () => {
  const fixture = home();
  let calls = 0;
  const model = new SmallModel({
    dir: fixture.dir,
    env: fixture.env,
    fetch: (async () => {
      calls++;
      return reply();
    }) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  const sourceId = makeSourceId('codex', fs.realpathSync(fixture.root));
  const policy = path.join(fixture.env.HUD_HOME, 'sources', sourceId, 'outbound.json');
  try {
    assert.ok((await model.submit(request('brief', 'first', fixture)).result).ok);
    writePrivateFile(policy, JSON.stringify({ schemaVersion: 1, sourceId, revision: 1, grants: [] }));
    assert.ok(!(await model.submit(request('brief', 'second', fixture)).result).ok);
    fs.unlinkSync(policy);
    assert.ok(!(await model.submit(request('brief', 'third', fixture)).result).ok);
    const restarted = new SmallModel({
      dir: fixture.dir,
      env: fixture.env,
      fetch: (async () => {
        calls++;
        return reply();
      }) as typeof fetch,
    });
    restarted.configure({ backend: 'api', api });
    assert.ok(!(await restarted.submit(request('brief', 'fourth', fixture)).result).ok);
    assert.equal(calls, 1);
  } finally {
    model.cancelAll();
    await model.flushTelemetry();
    fixture.close();
  }
});

test('T-07-6 unknown legacy provenance stays tainted and cannot be relabelled as general source material', async () => {
  const fixture = home();
  const model = new SmallModel({ dir: fixture.dir, env: fixture.env, fetch: (async () => reply()) as typeof fetch });
  model.configure({ backend: 'api', api });
  try {
    const handle = model.submit(request('brief', 'Legacy previous brief of unknown historic contributors', fixture));
    assert.ok((await handle.result).ok);
    const envelope = handle.materials!;
    const sourceId = envelope.sources[0];
    const decision = buildMaterials({
      purpose: 'brief',
      resolvedRecipient: { recipientId: envelope.recipientId, model: api.model },
      subjects: [
        {
          ref: envelope.fragments[0].provenance[0].ref,
          origin: 'native',
          field: 'note',
          kind: 'derived',
          recordFingerprint: envelope.fingerprint,
          derived: envelope,
          read: () => 'Laundered summary',
        },
      ],
      authority: {
        scope: () => ({ revision: 0, local: true, allows: () => true }),
        policy: () => ({
          schemaVersion: 1,
          sourceId,
          revision: 0,
          grants: [{ purpose: 'brief', recipientId: envelope.recipientId, decision: 'allow', grantedAt: 0 }],
        }),
      },
      limits: { maxBytes: 65536 },
    });
    assert.equal(isEnvelope(decision), false);
  } finally {
    model.cancelAll();
    await model.flushTelemetry();
    fixture.close();
  }
});

test('T-07-9 explicit paused probe sends only fixed synthetic material; off sends zero calls', async () => {
  const captured: string[] = [];
  const probe = new ModelProbe({
    env: {},
    fetch: (async (_url, init) => {
      captured.push(String(init?.body));
      return reply('OK');
    }) as typeof fetch,
  });
  const settings = {
    ...defaultSettings(),
    briefing: 'api' as const,
    briefingPaused: true,
    briefingApiBase: api.base,
    briefingApiModel: api.model,
  };
  await probe.run(settings);
  assert.equal(captured.length, 3);
  for (const body of captured) {
    const messages = JSON.parse(body).messages;
    assert.deepEqual(messages, [
      { role: 'system', content: 'This is a connectivity check. Return only OK.' },
      { role: 'user', content: 'Reply with OK.' },
    ]);
  }
  await probe.run({ ...settings, briefing: 'off' });
  assert.equal(captured.length, 3);
});

test('T-07-8 legacy agy: concrete executable/PATH is pinned; replacement profiles cannot inherit the grant', async () => {
  const fixture = home({ briefing: 'agy' });
  const bin = path.join(fixture.root, 'synthetic-bin');
  fs.mkdirSync(bin, { mode: 0o700 });
  const executable = path.join(bin, 'agy');
  fs.writeFileSync(executable, '#!/bin/sh\nprintf "Synthetic reply"\n', { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...fixture.env, PATH: bin };
  const model = new SmallModel({ dir: fixture.dir, env });
  model.configure({ backend: 'agy' });
  try {
    assert.ok((await model.submit(request('brief', 'Synthetic CLI material', fixture)).result).ok);
    env.PATH = path.join(fixture.root, 'different-profile');
    assert.ok(!(await model.submit(request('brief', 'Must not reach new profile', fixture)).result).ok);
    env.PATH = bin;
    fs.writeFileSync(executable, '#!/bin/sh\nprintf "Changed synthetic profile"\n', { mode: 0o700 });
    assert.ok(!(await model.submit(request('brief', 'Must not reach replacement', fixture)).result).ok);
    assert.equal(model.usage().lastHour, 1);
    await model.flushTelemetry();
  } finally {
    model.cancelAll();
    fixture.close();
  }
});

test('T-07-2 native topology: both historical parent encodings work; conflicting and delegated edges deny before compose', async () => {
  const fixture = home();
  let calls = 0;
  const child = path.join(fixture.root, 'sessions', 'synthetic-child.jsonl');
  const model = new SmallModel({
    dir: fixture.dir,
    env: fixture.env,
    fetch: (async () => {
      calls++;
      return reply();
    }) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  try {
    for (const metadata of [
      { parent_thread_id: 'synthetic-root' },
      { source: { subagent: { thread_spawn: { parent_thread_id: 'synthetic-root' } } } },
    ]) {
      writePrivateFile(
        child,
        JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic-child', ...metadata } }) + '\n'
      );
      assert.ok(
        (
          await model.submit(
            legacyRequest(
              'brief',
              [{ sessionId: 'synthetic-child', parentSessionId: 'synthetic-root', rolloutPath: child }],
              () => ({ feature: 'brief', system: 'Synthetic instructions', prompt: 'Synthetic native update' })
            )
          ).result
        ).ok
      );
    }
    writePrivateFile(
      child,
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'synthetic-child',
          parent_thread_id: 'synthetic-root',
          source: { subagent: { thread_spawn: { parent_thread_id: 'conflicting-parent' } } },
        },
      }) + '\n'
    );
    for (const origin of ['native', 'delegated'] as const) {
      assert.ok(
        !(
          await model.submit(
            legacyRequest(
              'brief',
              [{ sessionId: 'synthetic-child', parentSessionId: 'synthetic-root', rolloutPath: child, origin }],
              () => {
                throw new Error('untrusted edge composed');
              }
            )
          ).result
        ).ok
      );
    }
    assert.equal(calls, 2);
    await model.flushTelemetry();
  } finally {
    model.cancelAll();
    fixture.close();
  }
});

test('T-07-6 narrow recap: unknown both-to-main ancestry and its coverage/overall are omitted; proven main translation survives', async () => {
  const { Briefer } = await import('../../src/collectors/briefing.js');
  const { RecapStore } = await import('../../src/collectors/recap.js');
  const { LegacyRecapScopes } = await import('../../src/core/materials/legacy-scopes.js');
  const fixture = home({ briefing: 'api', briefingApiBase: api.base, briefMain: true, briefAgents: false });
  const at = 1700000020000;
  const tree = { rootId: 'synthetic-root', nodes: [], totalCount: 0, updatedAt: new Date(at) };
  const main = {
    session: {
      id: tree.rootId,
      rolloutPath: fixture.file,
      startTime: new Date(at - 5000),
      cwd: '/synthetic/project',
      cliVersion: 'synthetic',
    },
    toolActivity: { recentCalls: [], totalCalls: 0, callsByType: {}, lastUpdateTime: new Date(at) },
    planProgress: null,
    tokenUsage: null,
    rateLimits: null,
    pendingApproval: null,
    subagents: [],
    compactCount: 0,
    lastCompactTime: null,
    lastToolActivityTime: null,
    lastAssistantMessageTime: null,
    lastEventTime: null,
    workDirs: [],
    events: [],
    quotaSamples: [],
    transcript: [
      { role: 'user' as const, kind: 'prompt' as const, text: 'PUBLIC_MAIN_FACT_EARLIER', at: new Date(at - 3000) },
    ],
    lastUserMessageAt: new Date(at - 3000),
  };
  const store = new RecapStore(path.join(fixture.root, 'hud', 'recaps'));
  const unknown = {
    sessionId: tree.rootId,
    language: 'en' as const,
    at: at - 1000,
    coveredUntil: at - 2000,
    goal: 'BROAD_CHILD_SECRET_SENTINEL',
    done: ['Child body'],
    now: 'Child progress',
    needs: '',
    overall: 'AGENT_OVERALL_SECRET',
    fingerprint: '',
    floorFingerprint: '',
  };
  const oldMaterial = briefMaterial(tree, {
    scope: 'main',
    language: 'en',
    main,
    recap: unknown,
    now: at,
    since: null,
  })!;
  unknown.fingerprint = oldMaterial.fingerprint;
  unknown.floorFingerprint = oldMaterial.floorFingerprint;
  store.save(unknown);
  const captured: string[] = [];
  let language = 'en';
  const model = new SmallModel({
    dir: fixture.dir,
    env: fixture.env,
    fetch: (async (_url, init) => {
      captured.push(String(init?.body));
      return reply(
        language === 'en'
          ? '{"main":{"goal":"New main summary","done":[],"now":"Root only","needs":""},"overall":"AGENT_OVERALL_UNEXPECTED","agents":[]}'
          : '{"main":{"goal":"根会话摘要","done":[],"now":"处理中","needs":""},"agents":[]}'
      );
    }) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  const briefer = new Briefer(() => {}, { model, store });
  const settle = async () => {
    const deadline = Date.now() + 5000;
    while (briefer.current().running) {
      assert.ok(Date.now() < deadline);
      await new Promise<void>((done) => setImmediate(done));
    }
  };
  try {
    briefer.update(tree, 'api', 60000, 'en', at, false, { scope: 'main', main, floorMs: 900000 });
    await settle();
    assert.equal(captured.length, 1, 'an unknown old main fingerprint cannot suppress safe regeneration');
    assert.ok(captured[0].includes('PUBLIC_MAIN_FACT_EARLIER'), 'omitted prior coverage must not hide main facts');
    assert.ok(!captured[0].includes('BROAD_CHILD_SECRET_SENTINEL'));
    assert.ok(!captured[0].includes('AGENT_OVERALL_SECRET'));
    const saved = store.load(tree.rootId)!;
    assert.equal(saved.overall, undefined);
    assert.equal(new LegacyRecapScopes(path.join(fixture.dir, 'materials-v1', 'recap-scopes')).fitsMain(saved), true);
    language = 'zh';
    briefer.update(tree, 'api', 60000, 'zh', at + 60000, false, { scope: 'main', main, floorMs: 900000 });
    await settle();
    assert.equal(captured.length, 2);
    assert.ok(captured[1].includes('New main summary'), 'newly proved narrow history is translated');
    await model.flushTelemetry();
  } finally {
    briefer.stop();
    model.cancelAll();
    fixture.close();
  }
});

test('T-07-9 actual Cards preset changes display only and cannot revive a disabled generator', async () => {
  const { applyCardPreset } = await import('../fixtures/legacy-card-presets.js');
  const settings = {
    ...defaultSettings(),
    briefing: 'api' as const,
    briefingApiBase: api.base,
    briefAgents: false,
    agentProgress: false,
  };
  const fixture = home(settings);
  let calls = 0;
  const model = new SmallModel({
    dir: fixture.dir,
    env: fixture.env,
    fetch: (async () => {
      calls++;
      return reply();
    }) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  try {
    for (const preset of ['minimal', 'progress', 'monitor'] as const) {
      writePrivateFile(fixture.settings, JSON.stringify(applyCardPreset(settings, preset)));
      assert.ok(!(await model.submit(request('brief', 'DISPLAY_SENTINEL', fixture)).result).ok);
      assert.ok(!(await model.submit(request('progress', 'DISPLAY_SENTINEL', fixture)).result).ok);
    }
    assert.equal(calls, 0);
    await model.flushTelemetry();
  } finally {
    model.cancelAll();
    fixture.close();
  }
});

test('B17 tick performance: collector material scheduling performs zero new synchronous filesystem operations', async () => {
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const { Briefer } = await import('../../src/collectors/briefing.js');
  const fixture = home();
  const child = path.join(fixture.root, 'sessions', 'tick-child.jsonl');
  writePrivateFile(
    child,
    JSON.stringify({ type: 'session_meta', payload: { id: 'tick-child', parent_thread_id: 'synthetic-root' } }) + '\n'
  );
  const model = new SmallModel({
    dir: fixture.dir,
    env: fixture.env,
    fetch: (async () => reply('{"overall":"Synthetic progress","agents":[]}')) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  const briefer = new Briefer(() => {}, { model });
  const nativeFs = createRequire(import.meta.url)('node:fs') as typeof fs;
  const methods = [
    'openSync',
    'readSync',
    'readFileSync',
    'realpathSync',
    'statSync',
    'existsSync',
    'mkdirSync',
    'writeFileSync',
    'renameSync',
  ] as const;
  const saved = new Map<string, unknown>();
  let io = 0;
  try {
    for (const key of methods) {
      const original = nativeFs[key];
      saved.set(key, original);
      Object.assign(nativeFs, {
        [key]: (...args: unknown[]) => {
          io++;
          return (original as (...args: unknown[]) => unknown)(...args);
        },
      });
    }
    syncBuiltinESMExports();
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      briefer.update(
        {
          rootId: 'synthetic-root',
          nodes: [
            {
              id: 'tick-child',
              name: 'Synthetic worker',
              status: 'running',
              depth: 1,
              children: [],
              rolloutPath: child,
              lastReport: { at: new Date(1700000000000), text: 'Synthetic progress', kind: 'update' },
            },
          ],
          totalCount: 1,
          updatedAt: new Date(1700000000000),
        },
        'api',
        60000,
        'en',
        1700000000000
      );
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    assert.equal(io, 0);
    console.log(
      `B17 collector scheduling n=100 p50=${samples[49].toFixed(3)}ms p95=${samples[94].toFixed(3)}ms p99=${samples[98].toFixed(3)}ms max=${samples[99].toFixed(3)}ms; synchronous HUD-tick filesystem operations=${io}; indexed policy checks=0`
    );
  } finally {
    for (const [key, value] of saved) Object.assign(nativeFs, { [key]: value });
    syncBuiltinESMExports();
    const deadline = Date.now() + 5000;
    while (briefer.current().running) {
      assert.ok(Date.now() < deadline);
      await new Promise<void>((done) => setImmediate(done));
    }
    briefer.stop();
    model.cancelAll();
    await model.flushTelemetry();
    fixture.close();
  }
});

// E2: all sources, settings and transport below are private synthetic fixtures.
function selectedSettings(fixture: ReturnType<typeof home>, raw: Record<string, unknown>) {
  const file = path.join(fixture.root, 'selected B with spaces.json');
  writePrivateFile(file, JSON.stringify(raw));
  const env: NodeJS.ProcessEnv = {
    ...fixture.env,
    HOME: fixture.root,
    CODEX_HUD_SETTINGS_PATH: fixture.settings,
    HUD_SETTINGS_PATH: file,
  };
  return { file, env };
}
const allowedSettings = { briefing: 'api', briefingApiBase: api.base, briefingApiModel: api.model };

for (const [name, raw] of [
  ['off', { ...allowedSettings, briefing: 'off' }],
  ['missing grant', {}],
  ['different recipient', { ...allowedSettings, briefingApiBase: 'https://other.synthetic.invalid/v1' }],
  ['disabled feature', { ...allowedSettings, briefAgents: false }],
  ['paused', { ...allowedSettings, briefingPaused: true }],
] as Array<[string, Record<string, unknown>]>) {
  test(`E2 model selected B ${name} cannot borrow shadowed A authority`, async () => {
    const fixture = home();
    const selected = selectedSettings(fixture, raw);
    let calls = 0;
    let composed = 0;
    const model = new SmallModel({
      dir: fixture.dir,
      env: selected.env,
      fetch: (async () => {
        calls++;
        return reply();
      }) as typeof fetch,
    });
    model.configure({ backend: 'api', api });
    try {
      const handle = model.submit(
        legacyRequest('brief', [{ sessionId: 'synthetic-root', rolloutPath: fixture.file }], () => {
          composed++;
          return { feature: 'brief', system: 'Synthetic', prompt: 'Must not be read' };
        })
      );
      assert.ok(!(await handle.result).ok);
      assert.equal(composed, 0);
      assert.equal(calls, 0);
      assert.equal(handle.isAuthorized?.(), false);
      assert.equal(handle.materials, undefined);
    } finally {
      model.cancelAll();
      await model.flushTelemetry();
      fixture.close();
    }
  });
}

test('E2 selected settings use the injected env and shadowed legacy changes do not move authority', async () => {
  const fixture = home({ briefing: 'off' });
  const selected = selectedSettings(fixture, allowedSettings);
  let calls = 0;
  const model = new SmallModel({
    dir: fixture.dir,
    env: selected.env,
    fetch: (async () => {
      calls++;
      return reply();
    }) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  try {
    const first = model.submit(request('brief', 'Synthetic public material', fixture));
    assert.ok((await first.result).ok);
    assert.equal(first.materials?.sources[0], makeSourceId('codex', fs.realpathSync(fixture.root)));
    selected.env.CODEX_HUD_SETTINGS_PATH = path.join(fixture.root, 'shadowed missing A.json');
    const cached = await model.submit(request('brief', 'Synthetic public material', fixture)).result;
    assert.ok(cached.ok && cached.cached);
    assert.equal(first.isAuthorized?.(), true);
    assert.equal(calls, 1);
    assert.equal(selected.env.CODEX_HOME, fixture.root);
    assert.equal(selected.env.HUD_HOME, fixture.env.HUD_HOME);
    selected.env.HUD_SETTINGS_PATH = fixture.settings;
    assert.equal(first.isAuthorized?.(), false);
    assert.ok(!(await model.submit(request('brief', 'Synthetic public material', fixture)).result).ok);
    assert.equal(calls, 1, 'a captured cache grant does not survive selected-path changes');
  } finally {
    model.cancelAll();
    await model.flushTelemetry();
    fixture.close();
  }
});

test('E2 legacy-only settings override retains authorization and empty neutral uses the original default', async () => {
  for (const neutral of [undefined, '']) {
    const fixture = home({ briefing: 'off' });
    const selected = selectedSettings(fixture, allowedSettings);
    selected.env.CODEX_HUD_SETTINGS_PATH = selected.file;
    if (neutral === undefined) delete selected.env.HUD_SETTINGS_PATH;
    else selected.env.HUD_SETTINGS_PATH = neutral;
    let calls = 0;
    const model = new SmallModel({
      dir: fixture.dir,
      env: selected.env,
      fetch: (async () => {
        calls++;
        return reply();
      }) as typeof fetch,
    });
    model.configure({ backend: 'api', api });
    try {
      assert.equal((await model.submit(request('brief', 'Synthetic', fixture)).result).ok, neutral === undefined);
      assert.equal(calls, neutral === undefined ? 1 : 0);
    } finally {
      model.cancelAll();
      await model.flushTelemetry();
      fixture.close();
    }
  }
});

test('E2 effective selector changes before deferred capture refuse even when both files grant the same source', async () => {
  const fixture = home();
  const selected = selectedSettings(fixture, allowedSettings);
  const sourceId = makeSourceId('codex', fs.realpathSync(fixture.root));
  const recipientId = fingerprint([
    'legacy-codex-recipient-v1',
    sourceId,
    'api',
    `${api.base}/chat/completions`,
    'original-account',
  ]);
  let calls = 0;
  let composed = 0;
  const model = new SmallModel({
    dir: fixture.dir,
    env: selected.env,
    // An explicit authority defers legacy capture until submitNow, isolating
    // SmallModel's preflight check from the bridge's already-captured baseline.
    materials: {
      scope: (source) =>
        source === sourceId ? { revision: 0, local: true, allows: (p) => p.origin === 'native' } : null,
      policy: (source) =>
        source === sourceId
          ? {
              schemaVersion: 1,
              sourceId,
              revision: 0,
              grants: [{ purpose: 'brief', recipientId, decision: 'allow', grantedAt: 0 }],
            }
          : null,
    },
    fetch: (async () => {
      calls++;
      return reply();
    }) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  try {
    const queued = model.submit(
      legacyRequest('brief', [{ sessionId: 'synthetic-root', rolloutPath: fixture.file }], () => {
        composed++;
        return { feature: 'brief', system: 'Synthetic', prompt: 'Deferred synthetic text' };
      })
    );
    selected.env.HUD_SETTINGS_PATH = fixture.settings;
    const result = await queued.result;
    assert.ok(!result.ok && result.refused && result.cancelled);
    assert.equal(composed, 0);
    assert.equal(calls, 0);
    // Positive control: it was the between-submit-and-dispatch change, not an
    // intrinsically denied authority, that blocked the preceding request.
    assert.ok((await model.submit(request('brief', 'Positive synthetic control', fixture)).result).ok);
    assert.equal(calls, 1);
  } finally {
    model.cancelAll();
    await model.flushTelemetry();
    fixture.close();
  }
});

test('E2 changed selector invalidates captured handles, queued dispatch and late cache writes', async () => {
  const fixture = home();
  const selected = selectedSettings(fixture, allowedSettings);
  let calls = 0;
  let release: ((response: Response) => void) | undefined;
  const model = new SmallModel({
    dir: fixture.dir,
    env: selected.env,
    fetch: (async () => {
      calls++;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  let restarted: SmallModel | undefined;
  try {
    const active = model.submit(request('brief', 'Synthetic active input', fixture));
    const deadline = Date.now() + 5000;
    while (!release) {
      assert.ok(Date.now() < deadline, 'fake transport should start');
      await new Promise<void>((done) => setImmediate(done));
    }
    assert.equal(active.isAuthorized?.(), true);
    const queued = model.submit(request('brief', 'Synthetic queued input', fixture));
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(queued.status, 'queued');
    // A is also authorized, so a reread without a pinned selector is unsafe.
    selected.env.HUD_SETTINGS_PATH = fixture.settings;
    assert.equal(active.isAuthorized?.(), false);
    release(reply('Synthetic late answer must not be reusable'));
    assert.ok(!(await active.result).ok);
    assert.ok(!(await queued.result).ok);
    assert.equal(calls, 1);
    assert.equal(active.isAuthorized?.(), false, 'captured material cannot authorize reuse');
    const files = (dir: string): string[] =>
      !fs.existsSync(dir)
        ? []
        : fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const file = path.join(dir, entry.name);
            return entry.isDirectory() ? files(file) : [file];
          });
    for (const file of files(fixture.dir)) {
      const bytes = fs.readFileSync(file, 'utf8');
      assert.ok(!bytes.includes('Synthetic late answer must not be reusable'), file);
      assert.ok(!bytes.includes(fingerprint('Synthetic late answer must not be reusable')), file);
    }
    // A new process-equivalent instance is allowed to establish a new baseline,
    // but must fetch fresh output rather than reuse the discarded late result.
    restarted = new SmallModel({
      dir: fixture.dir,
      env: selected.env,
      fetch: (async () => {
        calls++;
        return reply('Synthetic fresh answer');
      }) as typeof fetch,
    });
    restarted.configure({ backend: 'api', api });
    const fresh = await restarted.submit(request('brief', 'Synthetic active input', fixture)).result;
    assert.ok(fresh.ok && !fresh.cached);
    assert.equal(calls, 2);
  } finally {
    release?.(reply());
    model.cancelAll();
    restarted?.cancelAll();
    await model.flushTelemetry();
    await restarted?.flushTelemetry();
    fixture.close();
  }
});

test('E2 same-source delegated text stays denied with an authorized neutral selector', async () => {
  const fixture = home();
  const selected = selectedSettings(fixture, allowedSettings);
  let calls = 0;
  let composed = 0;
  const model = new SmallModel({
    dir: fixture.dir,
    env: selected.env,
    fetch: (async () => {
      calls++;
      return reply();
    }) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  try {
    const result = await model.submit(
      legacyRequest(
        'brief',
        [
          {
            sessionId: 'synthetic-root',
            rolloutPath: fixture.file,
            origin: 'delegated',
            ref: {
              harness: 'codex',
              sourceId: makeSourceId('codex', fs.realpathSync(fixture.root)),
              sessionId: 'synthetic-root',
              threadId: null,
            },
          },
        ],
        () => {
          composed++;
          return { feature: 'brief', system: 'Synthetic', prompt: 'Delegated text must not compose' };
        }
      )
    ).result;
    assert.ok(!result.ok);
    assert.equal(composed, 0);
    assert.equal(calls, 0);
  } finally {
    model.cancelAll();
    await model.flushTelemetry();
    fixture.close();
  }
});

test('E2 backend off reads no material and makes no transport calls despite authorized A and B', async () => {
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const fixture = home();
  const selected = selectedSettings(fixture, allowedSettings);
  let reads = 0;
  let composed = 0;
  let calls = 0;
  const nativeFs = createRequire(import.meta.url)('node:fs') as typeof fs;
  const original = nativeFs.readFileSync;
  const originalOpen = nativeFs.openSync;
  const model = new SmallModel({
    dir: fixture.dir,
    env: selected.env,
    fetch: (async () => {
      calls++;
      return reply();
    }) as typeof fetch,
  });
  try {
    Object.assign(nativeFs, {
      readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
        if ([fixture.file, fixture.settings, selected.file].includes(String(args[0]))) reads++;
        return original(...args);
      },
      openSync: (...args: Parameters<typeof fs.openSync>) => {
        if ([fixture.file, fixture.settings, selected.file].includes(String(args[0]))) reads++;
        return originalOpen(...args);
      },
    });
    syncBuiltinESMExports();
    model.configure({ backend: 'off', api });
    const result = await model.submit(
      legacyRequest('brief', [{ sessionId: 'synthetic-root', rolloutPath: fixture.file }], () => {
        composed++;
        return { feature: 'brief', system: 'Synthetic', prompt: 'Off must not compose' };
      })
    ).result;
    await new Promise<void>((done) => setImmediate(done));
    assert.ok(!result.ok && result.refused);
    assert.equal(reads, 0);
    assert.equal(composed, 0);
    assert.equal(calls, 0);
  } finally {
    Object.assign(nativeFs, { readFileSync: original, openSync: originalOpen });
    syncBuiltinESMExports();
    model.cancelAll();
    await model.flushTelemetry();
    fixture.close();
  }
});
