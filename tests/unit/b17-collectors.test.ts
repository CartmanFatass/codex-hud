/** Production collectors and transport: no SyntheticModel or pre-approved request wrapper. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { SmallModel, writePrivateFile } from '../../src/collectors/small-model.js';
import { ModelJobs, NO_JOBS, labelKey, type JobsInput } from '../../src/collectors/model-jobs.js';
import { Briefer } from '../../src/collectors/briefing.js';
import { ProgressSummarizer } from '../../src/collectors/progress-summary.js';
import { AgentLog } from '../../src/collectors/agent-log.js';
import { makeSourceId } from '../../src/core/identity.js';
import { fingerprint, type MaterialAuthority } from '../../src/core/materials/index.js';
import { legacyRequest, materialRequest, type LegacySubject } from '../../src/core/materials/request.js';
import { CliRecipientBinding, resolveRecipient, bindResolvedRecipient } from '../../src/core/materials/recipient.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';
import type { RolloutParseResult } from '../../src/collectors/rollout.js';

const NOW = 1700000020000;
const api = { base: 'https://synthetic.invalid/v1', model: 'synthetic-model', key: '' };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(done: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!done()) {
    assert.ok(Date.now() < deadline, 'production collector did not settle');
    await tick();
  }
}
async function quiet() {
  for (let i = 0; i < 12; i++) await tick();
}
function fixture(authority?: MaterialAuthority) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b17-collectors-'));
  const file = path.join(root, 'sessions', 'root.jsonl');
  const native = (id: string, parent?: string) => {
    const target = path.join(root, 'sessions', `${id}.jsonl`);
    writePrivateFile(
      target,
      JSON.stringify({
        type: 'session_meta',
        payload: { id, ...(parent ? { parent_thread_id: parent } : { source: 'cli' }) },
      }) + '\n'
    );
    return target;
  };
  native('root');
  writePrivateFile(
    path.join(root, 'hud-settings.json'),
    JSON.stringify({
      briefing: 'api',
      briefingApiBase: api.base,
      briefingApiModel: api.model,
      briefMain: true,
      resultDigest: true,
      failureCause: true,
      approvalDescription: true,
      changeSummary: true,
    })
  );
  const bodies: string[] = [];
  let responseWait: Promise<void> | undefined;
  let response =
    '{"overall":"Synthetic progress","agents":[],"main":{"goal":"Synthetic goal","done":[],"now":"Checking","needs":""}}';
  const dir = path.join(root, 'hud', 'model-cache');
  const model = new SmallModel({
    dir,
    env: { CODEX_HOME: root, HUD_HOME: path.join(root, 'universal') },
    materials: authority,
    fetch: (async (_url, init) => {
      bodies.push(String(init?.body));
      if (responseWait) await responseWait;
      return new Response(JSON.stringify({ choices: [{ message: { content: response } }] }));
    }) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  const sourceId = makeSourceId('codex', fs.realpathSync(root));
  return {
    root,
    file,
    native,
    dir,
    model,
    bodies,
    sourceId,
    response: (value: string) => {
      response = value;
    },
    pause() {
      let resume!: () => void;
      responseWait = new Promise<void>((resolve) => {
        resume = resolve;
      });
      return resume;
    },
    async close() {
      model.cancelAll();
      await model.flushTelemetry();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
function node(file?: string, extra: Partial<SubagentTreeNode> = {}): SubagentTreeNode {
  return {
    id: 'child',
    name: 'Synthetic worker',
    status: 'running',
    depth: 1,
    children: [],
    rolloutPath: file,
    startedAt: new Date(NOW - 5000),
    turnStartedAt: new Date(NOW - 4000),
    task: 'Verify synthetic parser',
    lastReport: { at: new Date(NOW - 1000), text: 'Checked parser fixtures', kind: 'update' },
    ...extra,
  };
}
function tree(nodes: SubagentTreeNode[]): SubagentTree {
  return { rootId: 'root', nodes, totalCount: nodes.length, updatedAt: new Date(NOW) };
}
function main(file: string): RolloutParseResult {
  return {
    session: {
      id: 'root',
      rolloutPath: file,
      startTime: new Date(NOW - 10000),
      cwd: '/synthetic/project',
      cliVersion: 'synthetic',
    },
    toolActivity: { recentCalls: [], totalCalls: 0, callsByType: {}, lastUpdateTime: new Date(NOW) },
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
    transcript: [{ role: 'user', kind: 'prompt', text: 'Verify the synthetic parser', at: new Date(NOW - 3000) }],
    lastUserMessageAt: new Date(NOW - 3000),
  };
}
function input(t: SubagentTree, m: RolloutParseResult | null, switches = NO_JOBS): JobsInput {
  return {
    tree: t,
    main: m,
    switches,
    language: 'en',
    on: true,
    now: NOW,
    digestLabels: { basis: 'Basis:', caveats: 'Caveats:' },
  };
}
function explicitAuthority(sourceId: () => string, allowed: (id: string) => boolean, local = true): MaterialAuthority {
  return {
    scope: () => ({ revision: 0, local, allows: (p) => allowed(p.ref.sessionId) }),
    policy: () => ({
      schemaVersion: 1,
      sourceId: sourceId(),
      revision: 0,
      grants: ['brief', 'recap', 'progress', 'digest', 'label'].map((purpose) => ({
        purpose: purpose as 'brief',
        recipientId: fingerprint([
          'legacy-codex-recipient-v1',
          sourceId(),
          'api',
          api.base + '/chat/completions',
          'original-account',
        ]),
        decision: 'allow' as const,
        grantedAt: 0,
      })),
    }),
  };
}

test('review F1: async child extraction keeps captured authority after the child disappears from the same root', async () => {
  let sourceId = '';
  let childAllowed = true;
  const f = fixture(
    explicitAuthority(
      () => sourceId,
      (id) => id === 'root' || childAllowed
    )
  );
  sourceId = f.sourceId;
  let finish!: (text: string) => void;
  let reads = 0;
  const jobs = new ModelJobs({
    model: f.model,
    log: new AgentLog(),
    read: () => {
      reads++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const child = node(f.native('child', 'root'), { status: 'completed', statusAt: new Date(NOW) });
  try {
    jobs.update(input(tree([child]), main(f.file), { ...NO_JOBS, resultDigest: true }));
    await until(() => reads === 1);
    childAllowed = false;
    jobs.update(input(tree([]), main(f.file), { ...NO_JOBS, resultDigest: true }));
    finish(
      JSON.stringify({
        timestamp: new Date(NOW).toISOString(),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'DELEGATED_ASYNC_SOURCE_SENTINEL' }],
        },
      })
    );
    await quiet();
    assert.equal(f.bodies.length, 0);
    assert.equal(f.model.usage().lastHour, 0);
  } finally {
    jobs.stop();
    await f.close();
  }
});

test('review F1/F4: denied source cannot begin async extraction or read collector text getters', async () => {
  let scopes = 0;
  let reads = 0;
  let textReads = 0;
  const deny: MaterialAuthority = {
    scope: () => {
      scopes++;
      return { revision: 0, local: false, allows: () => false };
    },
    policy: () => null,
  };
  const f = fixture(deny);
  const child = node(f.native('child', 'root'));
  Object.defineProperty(child, 'task', {
    get() {
      textReads++;
      return 'DENIED_TASK_SENTINEL';
    },
    enumerable: true,
  });
  Object.defineProperty(child.lastReport!, 'text', {
    get() {
      textReads++;
      return 'DENIED_REPORT_SENTINEL';
    },
  });
  child.action = {
    name: 'exec_command',
    at: new Date(NOW),
    get text() {
      textReads++;
      return 'DENIED_ACTION_SENTINEL';
    },
  };
  const m = main(f.file);
  Object.defineProperty(m, 'transcript', {
    get() {
      textReads++;
      return [];
    },
  });
  const log = new AgentLog();
  const jobs = new ModelJobs({
    model: f.model,
    log,
    read: async () => {
      reads++;
      return '';
    },
  });
  const briefer = new Briefer(() => {}, { model: f.model });
  const progress = new ProgressSummarizer(f.model, log);
  try {
    const t = tree([child]);
    briefer.update(t, 'api', 60000, 'en', NOW, false, { scope: 'both', main: m, floorMs: 900000 });
    progress.update({
      tree: t,
      targets: new Set(['child']),
      on: true,
      language: 'en',
      now: NOW,
      rootRolloutPath: f.file,
    });
    jobs.update(input(t, m, { ...NO_JOBS, agentLabels: true }));
    const completed = node(child.rolloutPath, { status: 'completed', statusAt: new Date(NOW) });
    jobs.update(input(tree([completed]), m, { ...NO_JOBS, resultDigest: true }));
    await quiet();
    assert.ok(scopes > 0);
    assert.equal(textReads, 0);
    assert.equal(reads, 0);
    assert.equal(f.bodies.length, 0);
  } finally {
    jobs.stop();
    briefer.stop();
    progress.stop();
    await f.close();
  }
});

test('review F2: explicit options and per-plan authorities remain authoritative over the legacy bridge', async () => {
  for (const atPlan of [false, true]) {
    let scopes = 0;
    let composed = 0;
    const deny: MaterialAuthority = {
      scope: () => {
        scopes++;
        return { revision: 4, local: false, allows: () => false };
      },
      policy: () => null,
    };
    const f = fixture(atPlan ? undefined : deny);
    try {
      const request = legacyRequest('brief', [{ sessionId: 'root', rolloutPath: f.file }], () => {
        composed++;
        return { feature: 'brief', system: '', prompt: 'MUST_NOT_SEND' };
      });
      if (atPlan) request.materials!.authority = deny;
      assert.equal((await f.model.submit(request).result).ok, false);
      assert.ok(scopes > 0);
      assert.equal(composed, 0);
      assert.equal(f.bodies.length, 0);
    } finally {
      await f.close();
    }
  }
});

test('round-two explicit null/throwing recipient resolvers cannot fall back to legacy identity', async () => {
  for (const throws of [false, true]) {
    const f = fixture();
    let calls = 0;
    let reads = 0;
    const model = new SmallModel({
      dir: f.dir,
      env: { CODEX_HOME: f.root, HUD_HOME: path.join(f.root, 'universal') },
      resolveRecipient: () => {
        if (throws) throw new Error('synthetic unresolved recipient');
        return null;
      },
      fetch: (async () => {
        calls++;
        return new Response('{}');
      }) as typeof fetch,
    });
    model.configure({ backend: 'api', api });
    try {
      const result = await model.submit(
        legacyRequest('brief', [{ sessionId: 'root', rolloutPath: f.file }], () => {
          reads++;
          return { feature: 'brief', system: '', prompt: 'MUST_NOT_SEND' };
        })
      ).result;
      assert.equal(result.ok, false);
      assert.equal(calls, 0);
      assert.equal(reads, 0);
    } finally {
      model.cancelAll();
      await model.flushTelemetry();
      await f.close();
    }
  }
});

test('round-two legacy revalidation retains its explicit resolved identity and refuses a later unresolved recipient', async () => {
  const f = fixture();
  let allowed = true;
  let calls = 0;
  let finish!: () => void;
  const identity = { recipientId: fingerprint('synthetic-explicit-legacy-account'), model: api.model };
  const recipient = bindResolvedRecipient(
    { backend: 'api', endpoint: api.base + '/chat/completions', model: api.model },
    identity
  )!;
  const authority: MaterialAuthority = {
    scope: () => ({ revision: 0, local: true, allows: () => true }),
    policy: () => ({
      schemaVersion: 1,
      sourceId: f.sourceId,
      revision: 0,
      grants: [{ purpose: 'brief', recipientId: recipient.recipientId, decision: 'allow', grantedAt: 0 }],
    }),
  };
  const model = new SmallModel({
    dir: f.dir,
    env: { CODEX_HOME: f.root, HUD_HOME: path.join(f.root, 'universal') },
    materials: authority,
    resolveRecipient: () => (allowed ? identity : null),
    fetch: (async () => {
      calls++;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Synthetic reply' } }] }));
    }) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  try {
    const handle = model.submit(
      legacyRequest('brief', [{ sessionId: 'root', rolloutPath: f.file }], () => ({
        feature: 'brief',
        system: 'Synthetic instructions',
        prompt: 'Synthetic report',
        cacheKey: 'synthetic-explicit-legacy',
      }))
    );
    await until(() => calls === 1);
    allowed = false;
    finish();
    assert.equal((await handle.result).ok, false);
    assert.equal(handle.isAuthorized?.(), false);
    assert.equal(fs.existsSync(path.join(f.dir, 'cache.json')), false);
  } finally {
    finish?.();
    model.cancelAll();
    await model.flushTelemetry();
    await f.close();
  }
});

test('live collector metadata cannot change origin before formatting or late-result persistence', async () => {
  for (const afterSend of [false, true]) {
    const f = fixture();
    f.response('{"labels":[{"name":"Parser checks","kind":"test"}]}');
    const resume = afterSend ? f.pause() : () => {};
    const jobs = new ModelJobs({ model: f.model, log: new AgentLog() });
    const child = node(f.native('child', 'root'));
    const t = tree([child]);
    let reads = 0;
    Object.defineProperty(child, 'task', {
      get() {
        reads++;
        return 'Verify synthetic parser';
      },
    });
    try {
      jobs.update(input(t, main(f.file), { ...NO_JOBS, agentLabels: true }));
      if (afterSend) await until(() => f.bodies.length === 1);
      Object.assign(child, { origin: 'delegated' });
      resume();
      await quiet();
      jobs.apply(t, { ...NO_JOBS, agentLabels: true }, 'en');
      await quiet();
      assert.equal(f.bodies.length, afterSend ? 1 : 0);
      if (!afterSend) assert.equal(reads, 0);
      assert.equal(child.label, undefined);
      assert.equal(fs.existsSync(path.join(f.dir, 'cache.json')), false);
    } finally {
      resume();
      jobs.stop();
      await f.close();
    }
  }
});

test('review F3: general CLI material grants bind executable/PATH even with a supplied recipient resolver', async () => {
  for (const customResolver of [false, true])
    for (const changedSelector of ['PATH', 'HOME', 'XDG_CONFIG_HOME'] as const) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b17-general-cli-'));
      const bins = ['a', 'b'].map((name) => path.join(root, name));
      const marker = path.join(root, 'b-ran');
      for (const [i, bin] of bins.entries()) {
        fs.mkdirSync(bin);
        fs.writeFileSync(
          path.join(bin, 'agy'),
          '#!/bin/sh\n' + (i ? `printf changed > '${marker}'\n` : '') + 'printf "Synthetic reply"\n',
          { mode: 0o700 }
        );
      }
      const env: NodeJS.ProcessEnv = {
        PATH: bins[0],
        HOME: path.join(root, 'profile-a'),
        XDG_CONFIG_HOME: path.join(root, 'config-a'),
      };
      const route = { backend: 'agy' as const, model: 'gemini-3.8-flash-low', reasoning: false };
      const binding = new CliRecipientBinding();
      binding.capture(env);
      const recipient = binding.bind(
        customResolver
          ? bindResolvedRecipient(route, { recipientId: 'trusted-synthetic-resolver', model: route.model })
          : resolveRecipient(route, undefined, 'synthetic-profile'),
        env
      )!;
      const sourceId = fingerprint('general-cli-source');
      const authority: MaterialAuthority = {
        scope: () => ({ revision: 0, local: true, allows: () => true }),
        policy: () => ({
          schemaVersion: 1,
          sourceId,
          revision: 0,
          grants: [{ purpose: 'brief', recipientId: recipient.recipientId, decision: 'allow', grantedAt: 0 }],
        }),
      };
      const model = new SmallModel({
        dir: path.join(root, 'cache'),
        env,
        materials: authority,
        trustedProfile: 'synthetic-profile',
        ...(customResolver
          ? {
              resolveRecipient: (actual: { model?: string }) => ({
                recipientId: 'trusted-synthetic-resolver',
                model: actual.model!,
              }),
            }
          : {}),
      });
      model.configure({ backend: 'agy' });
      const request = (text: string) =>
        materialRequest('brief', {
          purpose: 'brief',
          subjects: [
            {
              ref: { harness: 'codex', sourceId, sessionId: 'root', threadId: null },
              origin: 'native',
              field: 'report',
              kind: 'public_text',
              recordFingerprint: fingerprint(text),
              read: () => text,
            },
          ],
          compose: (envelope) => ({
            feature: 'brief',
            system: 'Synthetic instructions',
            prompt: envelope.fragments[0].text,
          }),
        });
      try {
        assert.equal((await model.submit(request('first')).result).ok, true);
        env[changedSelector] = changedSelector === 'PATH' ? bins[1] : path.join(root, 'profile-b');
        assert.equal((await model.submit(request('must not send to B')).result).ok, false);
        assert.equal(fs.existsSync(marker), false);
        assert.equal(model.usage().lastHour, 1);
      } finally {
        model.cancelAll();
        await model.flushTelemetry();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
});

test('known API credential changes cannot reuse a static account grant or read new material', async () => {
  for (const change of ['environment', 'configured-key'] as const) {
    const env = { CODEX_HUD_BRIEF_API_KEY: 'synthetic-account-a' };
    const sourceId = fingerprint('synthetic-api-credential-source');
    const recipient = resolveRecipient(
      { backend: 'api', endpoint: api.base + '/chat/completions', model: api.model },
      'synthetic-account'
    )!;
    const authority: MaterialAuthority = {
      scope: () => ({ revision: 0, local: true, allows: () => true }),
      policy: () => ({
        schemaVersion: 1,
        sourceId,
        revision: 0,
        grants: [{ purpose: 'brief', recipientId: recipient.recipientId, decision: 'allow', grantedAt: 0 }],
      }),
    };
    let calls = 0;
    let reads = 0;
    const model = new SmallModel({
      env,
      account: 'synthetic-account',
      materials: authority,
      fetch: (async () => {
        calls++;
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Synthetic reply' } }] }));
      }) as typeof fetch,
    });
    model.configure({ backend: 'api', api });
    const request = () =>
      materialRequest('brief', {
        purpose: 'brief',
        subjects: [
          {
            ref: { harness: 'codex', sourceId, sessionId: 'root', threadId: null },
            origin: 'native',
            field: 'report',
            kind: 'public_text',
            recordFingerprint: fingerprint('synthetic-record'),
            read: () => {
              reads++;
              return 'Synthetic public report';
            },
          },
        ],
        compose: (envelope) => ({
          feature: 'brief',
          system: 'Synthetic instructions',
          prompt: envelope.fragments[0].text,
        }),
      });
    try {
      assert.equal((await model.submit(request()).result).ok, true);
      if (change === 'environment') env.CODEX_HUD_BRIEF_API_KEY = 'synthetic-account-b';
      else model.configure({ api: { ...api, key: 'synthetic-account-b' } });
      assert.equal((await model.submit(request()).result).ok, false, change);
      assert.equal(calls, 1);
      assert.equal(reads, 1);
    } finally {
      model.cancelAll();
      await model.flushTelemetry();
    }
  }
});

test('trusted API resolver may verify same-account rotation; queued credentials stay captured and require rebuilding', async () => {
  const env = { CODEX_HUD_BRIEF_API_KEY: 'synthetic-key-a' };
  const sourceId = fingerprint('synthetic-resolved-api-source');
  const route = { backend: 'api' as const, endpoint: api.base + '/chat/completions', model: api.model };
  const identity = { recipientId: fingerprint('synthetic-verified-account'), model: api.model };
  const recipient = bindResolvedRecipient(route, identity)!;
  const authority: MaterialAuthority = {
    scope: () => ({ revision: 0, local: true, allows: () => true }),
    policy: () => ({
      schemaVersion: 1,
      sourceId,
      revision: 0,
      grants: [{ purpose: 'brief', recipientId: recipient.recipientId, decision: 'allow', grantedAt: 0 }],
    }),
  };
  let finish!: () => void;
  const bodies: Array<{ body: string; credential: string | undefined }> = [];
  const model = new SmallModel({
    env,
    materials: authority,
    resolveRecipient: (actual) =>
      ['synthetic-key-a', 'synthetic-key-b'].includes(env.CODEX_HUD_BRIEF_API_KEY)
        ? { ...identity, model: actual.model! }
        : null,
    fetch: (async (_url, init) => {
      bodies.push({ body: String(init?.body), credential: (init?.headers as Record<string, string>).authorization });
      if (bodies.length === 1)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Synthetic reply' } }] }));
    }) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  const request = (text: string) =>
    materialRequest('brief', {
      purpose: 'brief',
      subjects: [
        {
          ref: { harness: 'codex', sourceId, sessionId: 'root', threadId: null },
          origin: 'native',
          field: 'report',
          kind: 'public_text',
          recordFingerprint: fingerprint(text),
          read: () => text,
        },
      ],
      compose: (envelope) => ({
        feature: 'brief',
        system: 'Synthetic instructions',
        prompt: envelope.fragments[0].text,
        cacheKey: 'synthetic-resolved-api',
      }),
    });
  try {
    const active = model.submit(request('active'));
    await until(() => bodies.length === 1);
    const queued = model.submit(request('queued'));
    env.CODEX_HUD_BRIEF_API_KEY = 'synthetic-key-b';
    finish();
    assert.equal((await active.result).ok, false);
    assert.equal((await queued.result).ok, false);
    assert.equal(bodies.length, 1);
    assert.equal((await model.submit(request('freshly verified same account')).result).ok, true);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].credential, 'Bearer synthetic-key-a');
    assert.equal(bodies[1].credential, 'Bearer synthetic-key-b');
    const cached = await model.submit(request('freshly verified same account')).result;
    assert.ok(cached.ok && cached.cached);
    assert.equal(bodies.length, 2);
    env.CODEX_HUD_BRIEF_API_KEY = 'synthetic-unknown-account';
    assert.equal((await model.submit(request('must deny')).result).ok, false);
    assert.equal(bodies.length, 2);
  } finally {
    finish?.();
    model.cancelAll();
    await model.flushTelemetry();
  }
});

test('review F5: matching universal refs require affirmative native origin before any formatter or task read', async () => {
  const f = fixture();
  let reads = 0;
  const file = f.native('child', 'root');
  try {
    const ref = { harness: 'codex' as const, sourceId: f.sourceId, sessionId: 'child', threadId: null };
    const subjects: LegacySubject[] = [
      { sessionId: 'child', parentSessionId: 'root', rolloutPath: file, ref },
      { sessionId: 'child', parentSessionId: 'root', rolloutPath: file, universal: true },
      { sessionId: 'child', parentSessionId: 'root', rolloutPath: file, ref, origin: 'delegated' },
    ];
    for (const subject of subjects)
      assert.equal(
        (
          await f.model.submit(
            legacyRequest('brief', [subject], () => {
              reads++;
              return { feature: 'brief', system: '', prompt: 'UNKNOWN_ORIGIN' };
            })
          ).result
        ).ok,
        false
      );
    for (const metadata of [{ ref }, { sourceId: f.sourceId, harness: 'codex' }, { ref: undefined }]) {
      const child = node(file);
      Object.assign(child, metadata);
      Object.defineProperty(child, 'task', {
        get() {
          reads++;
          return 'UNKNOWN_TASK_SENTINEL';
        },
      });
      const jobs = new ModelJobs({ model: f.model, log: new AgentLog() });
      jobs.update(input(tree([child]), main(f.file), { ...NO_JOBS, agentLabels: true }));
      await quiet();
      jobs.stop();
    }
    assert.equal(reads, 0);
    assert.equal(f.bodies.length, 0);
    assert.equal(
      (
        await f.model.submit(
          legacyRequest('brief', [{ ...subjects[0], origin: 'native' }], () => ({
            feature: 'brief',
            system: '',
            prompt: 'Verified native',
          }))
        ).result
      ).ok,
      true
    );
  } finally {
    await f.close();
  }
});

test('review F4: backend-off local labels need positive native proof and cannot authorize delegated or unknown subjects', async () => {
  const f = fixture();
  const file = f.native('child', 'root');
  const labelsFile = path.join(f.dir, 'labels.json');
  writePrivateFile(
    labelsFile,
    JSON.stringify({ labels: { [labelKey('Verify synthetic parser', 'en')]: { name: 'Parser checks', kind: 'test' } } })
  );
  f.model.configure({ backend: 'off' });
  const jobs = new ModelJobs({ model: f.model, log: new AgentLog(), labelsFile });
  try {
    const native = node(file);
    const t = tree([native]);
    jobs.apply(t, { ...NO_JOBS, agentLabels: true }, 'en');
    await quiet();
    jobs.apply(t, { ...NO_JOBS, agentLabels: true }, 'en');
    assert.equal(native.label, 'Parser checks', 'existing local label survives backend-off restart');
    let reads = 0;
    for (const metadata of [
      { origin: 'delegated' },
      { ref: { harness: 'codex', sourceId: f.sourceId, sessionId: 'child', threadId: null } },
      { origin: 'native', ref: { harness: 'codex', sourceId: f.sourceId, sessionId: 'child', threadId: null } },
    ]) {
      const untrusted = node(file);
      Object.assign(untrusted, metadata);
      Object.defineProperty(untrusted, 'task', {
        get() {
          reads++;
          return 'Verify synthetic parser';
        },
      });
      const t = tree([untrusted]);
      jobs.apply(t, { ...NO_JOBS, agentLabels: true }, 'en');
      await quiet();
      jobs.apply(t, { ...NO_JOBS, agentLabels: true }, 'en');
      assert.equal(untrusted.label, undefined);
    }
    assert.equal(reads, 0);
    assert.equal(f.bodies.length, 0);
  } finally {
    jobs.stop();
    await f.close();
  }
});

test('review F6: native pre-create charge belongs to the verified parent even before the child rollout exists', async () => {
  const f = fixture();
  f.response('{"labels":[{"name":"Parser checks","kind":"test"}]}');
  const jobs = new ModelJobs({ model: f.model, log: new AgentLog() });
  try {
    const child = node(undefined, { charge: 'PARENT_PUBLIC_CHARGE' });
    let taskReads = 0;
    Object.defineProperty(child, 'task', {
      get() {
        taskReads++;
        return 'UNVERIFIED_CHILD_TASK';
      },
    });
    jobs.update(input(tree([child]), main(f.file), { ...NO_JOBS, agentLabels: true }));
    await until(() => f.bodies.length === 1);
    await quiet();
    assert.ok(f.bodies[0].includes('PARENT_PUBLIC_CHARGE'));
    assert.ok(!f.bodies[0].includes('UNVERIFIED_CHILD_TASK'));
    assert.equal(taskReads, 0);
    jobs.apply(tree([child]), { ...NO_JOBS, agentLabels: true }, 'en');
    assert.equal(child.label, 'Parser checks');
    for (const metadata of [
      { origin: 'delegated' },
      { ref: { harness: 'codex', sourceId: f.sourceId, sessionId: 'other', threadId: null } },
    ]) {
      const other = node(undefined, { id: 'other', charge: 'DENIED_PRECREATE_CHARGE' });
      Object.assign(other, metadata);
      jobs.update(input(tree([other]), main(f.file), { ...NO_JOBS, agentLabels: true }));
      await quiet();
    }
    assert.equal(f.bodies.length, 1);
  } finally {
    jobs.stop();
    await f.close();
  }
});

test('production charge:undefined shape uses child task proof with no contributing root, including backend-off labels', async () => {
  for (const localOnly of [false, true]) {
    const f = fixture();
    f.response('{"labels":[{"name":"Parser checks","kind":"test"}]}');
    const labelsFile = path.join(f.dir, 'labels.json');
    if (localOnly) {
      writePrivateFile(
        labelsFile,
        JSON.stringify({
          labels: { [labelKey('Verify synthetic parser', 'en')]: { name: 'Parser checks', kind: 'test' } },
        })
      );
      f.model.configure({ backend: 'off' });
    }
    const jobs = new ModelJobs({ model: f.model, log: new AgentLog(), labelsFile });
    const child = node(f.native('child', 'root'), { charge: undefined });
    const t = tree([child]);
    try {
      if (!localOnly) {
        jobs.update(input(t, null, { ...NO_JOBS, agentLabels: true }));
        await until(() => f.bodies.length === 1);
        await quiet();
        assert.ok(f.bodies[0].includes('Verify synthetic parser'));
      }
      jobs.apply(t, { ...NO_JOBS, agentLabels: true }, 'en');
      await quiet();
      jobs.apply(t, { ...NO_JOBS, agentLabels: true }, 'en');
      assert.equal(child.label, 'Parser checks');
      assert.equal(f.bodies.length, localOnly ? 0 : 1);
    } finally {
      jobs.stop();
      await f.close();
    }
  }
  const f = fixture();
  f.response('{"labels":[{"name":"Parser checks","kind":"test"}]}');
  const jobs = new ModelJobs({ model: f.model, log: new AgentLog() });
  let chargeReads = 0;
  const child = node(f.native('child', 'root'));
  Object.defineProperty(child, 'charge', {
    get() {
      chargeReads++;
      return 'UNPROVABLE_PARENT_CHARGE';
    },
  });
  try {
    jobs.update(input(tree([child]), null, { ...NO_JOBS, agentLabels: true }));
    await until(() => f.bodies.length === 1);
    assert.equal(chargeReads, 0);
    assert.ok(!f.bodies[0].includes('UNPROVABLE_PARENT_CHARGE'));
    assert.ok(f.bodies[0].includes('Verify synthetic parser'));
  } finally {
    jobs.stop();
    await f.close();
  }
});

test('owner tree-page exception: progress includes a proved parent charge and omits absent or unprovable parents', async () => {
  for (const parentProof of ['valid', 'absent', 'unprovable', 'scope-denied'] as const) {
    let sourceId = '';
    const f = fixture(
      parentProof === 'scope-denied'
        ? explicitAuthority(
            () => sourceId,
            (id) => id !== 'root'
          )
        : undefined
    );
    sourceId = f.sourceId;
    f.response('Synthetic progress.');
    const log = new AgentLog();
    const progress = new ProgressSummarizer(f.model, log);
    const child = node(f.native('child', 'root'));
    let chargeReads = 0;
    Object.defineProperty(child, 'charge', {
      get() {
        chargeReads++;
        return 'PARENT_CHARGE_SENTINEL';
      },
    });
    try {
      progress.update({
        tree: tree([child]),
        targets: new Set(['child']),
        on: true,
        language: 'en',
        now: NOW,
        ...(parentProof === 'absent'
          ? {}
          : { rootRolloutPath: parentProof === 'unprovable' ? path.join(f.root, 'missing.jsonl') : f.file }),
      });
      await until(() => f.bodies.length === 1);
      await quiet();
      assert.equal(f.bodies[0].includes('PARENT_CHARGE_SENTINEL'), parentProof === 'valid', parentProof);
      assert.equal(chargeReads > 0, parentProof === 'valid', parentProof);
      assert.ok(f.bodies[0].includes('Checked parser fixtures'));
    } finally {
      progress.stop();
      await f.close();
    }
  }
});

test('rebuilt progress task metadata is checked behind the grant even when report clocks and objects are unchanged', async () => {
  const f = fixture();
  f.response('Synthetic progress.');
  const resume = f.pause();
  const log = new AgentLog();
  const progress = new ProgressSummarizer(f.model, log);
  const initial = node(f.native('child', 'root'), { task: 'OLD_PUBLIC_TASK' });
  const update = (child: SubagentTreeNode, now: number) =>
    progress.update({
      tree: tree([child]),
      rootRolloutPath: f.file,
      targets: new Set(['child']),
      on: true,
      language: 'en',
      now,
    });
  try {
    update(initial, NOW);
    await until(() => f.bodies.length === 1);
    update({ ...initial, task: 'NEW_PUBLIC_TASK' }, NOW + 1);
    await quiet();
    resume();
    await until(() => f.bodies.length === 2);
    await until(() => progress.state().get('child')?.running === false);
    assert.ok(f.bodies[1].includes('NEW_PUBLIC_TASK'));
    assert.equal(log.entries('child').filter((entry) => entry.kind === 'note').length, 1);
  } finally {
    resume();
    progress.stop();
    await f.close();
  }
});

test('review F7: actual label batch keeps one numbered task for identical authorized sources', async () => {
  const f = fixture();
  f.response('{"labels":[{"name":"Parser checks","kind":"test"}]}');
  const jobs = new ModelJobs({ model: f.model, log: new AgentLog() });
  const children = [node(f.native('child', 'root')), node(f.native('other', 'root'), { id: 'other' })];
  try {
    const t = tree(children);
    jobs.update(input(t, main(f.file), { ...NO_JOBS, agentLabels: true }));
    await until(() => f.bodies.length === 1);
    await quiet();
    const prompt = JSON.parse(f.bodies[0]).messages[1].content as string;
    assert.equal(prompt.split('Verify synthetic parser').length - 1, 1);
    assert.doesNotMatch(prompt, /\n2[.)]/);
    jobs.apply(t, { ...NO_JOBS, agentLabels: true }, 'en');
    assert.deepEqual(
      children.map((n) => n.label),
      ['Parser checks', 'Parser checks']
    );
  } finally {
    jobs.stop();
    await f.close();
  }
});

test('round-two label scan advances past sealed tasks, including rebuilt trees, and sees a new task', async () => {
  const f = fixture();
  f.response('{"labels":[{"name":"Parser checks","kind":"test"}]}');
  const jobs = new ModelJobs({ model: f.model, log: new AgentLog() });
  const files = Array.from({ length: 9 }, (_, i) => f.native(`worker-${i}`, 'root'));
  try {
    for (let i = 0; i < 3; i++) {
      const nodes = files.map((file, j) =>
        node(file, { id: `worker-${j}`, task: j < 8 ? 'gAAAAAsealed' : 'PUBLIC_NINTH_TASK' })
      );
      jobs.update(input(tree(nodes), main(f.file), { ...NO_JOBS, agentLabels: true }));
      await quiet();
    }
    assert.equal(f.bodies.length, 1);
    assert.ok(f.bodies[0].includes('PUBLIC_NINTH_TASK'));
    assert.ok(!f.bodies[0].includes('gAAAAA'));
    const changed = node(files[8], { id: 'worker-8', task: 'NEW_PUBLIC_TASK' });
    jobs.update(input(tree([changed]), main(f.file), { ...NO_JOBS, agentLabels: true }));
    await until(() => f.bodies.length === 2);
    assert.ok(f.bodies[1].includes('NEW_PUBLIC_TASK'));
  } finally {
    jobs.stop();
    await f.close();
  }
});

test('round-two local hydration deduplicates pending checks under the real apply-onChange wiring', async () => {
  const f = fixture();
  const nodes = Array.from({ length: 12 }, (_, i) => node(f.native(`local-${i}`, 'root'), { id: `local-${i}` }));
  const t = tree(nodes);
  const inspect = f.model.inspectLocalLegacy.bind(f.model);
  let checks = 0;
  let callbacks = 0;
  f.model.inspectLocalLegacy = (subjects) => {
    checks++;
    return inspect(subjects);
  };
  const jobs = new ModelJobs({
    model: f.model,
    log: new AgentLog(),
    onChange: () => {
      callbacks++;
      jobs.apply(t, NO_JOBS, 'en');
    },
  });
  try {
    jobs.apply(t, NO_JOBS, 'en');
    await until(() => callbacks === 12);
    await quiet();
    assert.equal(checks, 12);
    assert.equal(callbacks, 12);
    assert.equal(f.bodies.length, 0);
  } finally {
    jobs.stop();
    await f.close();
  }
});

test('round-two local hydration retains only the latest record per current binding and prunes removed subjects', async () => {
  const f = fixture();
  const file = f.native('child', 'root');
  const labelsFile = path.join(f.dir, 'labels.json');
  writePrivateFile(
    labelsFile,
    JSON.stringify({ labels: { [labelKey('Verify synthetic parser', 'en')]: { name: 'Parser checks', kind: 'test' } } })
  );
  f.model.configure({ backend: 'off' });
  const jobs = new ModelJobs({ model: f.model, log: new AgentLog(), labelsFile });
  try {
    for (let i = 0; i < 100; i++) {
      jobs.apply(tree([node(file, { charge: undefined })]), { ...NO_JOBS, agentLabels: true }, 'en');
      await quiet();
    }
    const retained = jobs as unknown as { localHydrations: Map<string, unknown>; localViews: Set<string> };
    assert.equal(retained.localHydrations.size, 1);
    assert.equal(retained.localViews.size, 1);
    jobs.apply(tree([]), { ...NO_JOBS, agentLabels: true }, 'en');
    await quiet();
    assert.equal(retained.localHydrations.size, 0);
    assert.equal(retained.localViews.size, 0);
    assert.equal(f.bodies.length, 0);
  } finally {
    jobs.stop();
    await f.close();
  }
});

test('round-two changed Codex goal triggers an authorized recap at the interval without waiting for the floor', async () => {
  const f = fixture();
  const briefer = new Briefer(() => {}, { model: f.model });
  const t = tree([]);
  const m = main(f.file);
  try {
    briefer.update(t, 'api', 60000, 'en', NOW, false, {
      scope: 'main',
      main: m,
      floorMs: 900000,
      goal: { objective: 'INITIAL_PUBLIC_GOAL', status: 'active' },
    });
    await until(() => !briefer.current().running);
    assert.equal(f.bodies.length, 1);
    briefer.update(t, 'api', 60000, 'en', NOW + 60000, false, {
      scope: 'main',
      main: m,
      floorMs: 900000,
      goal: { objective: 'CHANGED_PUBLIC_GOAL', status: 'active' },
    });
    await until(() => !briefer.current().running);
    assert.equal(f.bodies.length, 2);
    assert.ok(f.bodies[1].includes('CHANGED_PUBLIC_GOAL'));
  } finally {
    briefer.stop();
    await f.close();
  }
});

// Actual Briefer -> SmallModel HTTP body captures from base 1ebebd4, not formatter-only calls.
const collectorGoldens: Record<string, string> = {
  agents: '1a3bab61f2f81edf215d03f5d7907094b902481adf2e88e1d0616493e37b9ecc',
  main: '34fc722318b0238a036cc2936f1cd6f8ae189d10fe42f513aa67f06876cfc66a',
  both: 'bef6778441dd47464fed4101078e7f13fcd8cbc916230677a1b1087be05ab41e',
};
test('golden legacy Codex actual collectors: agents, main and combined request bytes match the base revision', async () => {
  for (const scope of ['agents', 'main', 'both'] as const) {
    const f = fixture();
    const briefer = new Briefer(() => {}, { model: f.model });
    try {
      briefer.update(tree([node(f.native('child', 'root'))]), 'api', 60000, 'en', NOW, false, {
        scope,
        main: main(f.file),
        floorMs: 900000,
      });
      await until(() => !briefer.current().running);
      assert.equal(f.bodies.length, 1, scope);
      assert.equal(createHash('sha256').update(f.bodies[0]).digest('hex'), collectorGoldens[scope], scope);
    } finally {
      briefer.stop();
      await f.close();
    }
  }
});
