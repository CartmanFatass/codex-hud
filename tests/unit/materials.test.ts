import { DerivedMaterialStore } from '../../src/core/materials/derived.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  buildMaterials,
  fileAuthority,
  fingerprint,
  isEnvelope,
  revalidateMaterials,
  type MaterialAuthority,
  type MaterialEnvelope,
  type MaterialSubject,
  type OutboundPurpose,
} from '../../src/core/materials/index.js';
import { materialRequest, legacyRequest, purposeFor } from '../../src/core/materials/request.js';
import { resolveRecipient } from '../../src/core/materials/recipient.js';
import { SmallModel, writePrivateFile, type ModelRequest } from '../../src/collectors/small-model.js';

const a = fingerprint('synthetic-codex');
const b = fingerprint('synthetic-claude');
const api = { base: 'https://synthetic.invalid/v1', model: 'synthetic-model', sourceCredential: null };
const route = { backend: 'api' as const, endpoint: `${api.base}/chat/completions`, model: api.model };
const target = resolveRecipient(route, 'synthetic-account')!;
const ref = (sourceId = a, sessionId = 'synthetic-session') => ({
  harness: sourceId === b ? ('claude' as const) : ('codex' as const),
  sourceId,
  sessionId,
  threadId: null,
});
const reply = (text = 'Synthetic answer') =>
  new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
const tick = () => new Promise<void>((done) => setImmediate(done));
const purposes: OutboundPurpose[] = [
  'brief',
  'recap',
  'progress',
  'digest',
  'label',
  'title',
  'cause',
  'changes',
  'approval',
  'probe',
  'routing',
  'jev_task',
];
const field: Record<OutboundPurpose, string> = {
  brief: 'report',
  recap: 'message',
  progress: 'report',
  digest: 'result',
  label: 'task',
  title: 'message',
  cause: 'error',
  changes: 'diff',
  approval: 'command',
  probe: 'probe',
  routing: 'signal',
  jev_task: 'message',
};
function subject(
  sourceId = a,
  text = 'Authorized public observation',
  purpose: OutboundPurpose = 'brief'
): MaterialSubject {
  return {
    ref: ref(sourceId),
    origin: 'native',
    field: field[purpose],
    kind: 'public_text',
    read: () => text,
    recordFingerprint: fingerprint(['synthetic-record', sourceId, purpose]),
  };
}
function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'b17-materials-'));
  let allowedOrigins = new Set(['native']);
  const scopes = new Map([
    [a, 1],
    [b, 1],
  ]);
  const authority = fileAuthority(home, (sourceId) =>
    scopes.has(sourceId)
      ? {
          revision: scopes.get(sourceId)!,
          local: true,
          allows: (p) => p.ref.sourceId === sourceId && allowedOrigins.has(p.origin),
        }
      : null
  );
  const grant = (
    sourceId = a,
    purpose: OutboundPurpose = 'brief',
    decision = 'allow',
    revision = 1,
    recipientId = target.recipientId
  ) => {
    writePrivateFile(
      path.join(home, 'sources', sourceId, 'outbound.json'),
      JSON.stringify({
        schemaVersion: 1,
        sourceId,
        revision,
        grants: [{ purpose, recipientId, decision, grantedAt: 0 }],
      })
    );
  };
  return {
    home,
    authority,
    grant,
    scopes,
    origins: (origins: string[]) => {
      allowedOrigins = new Set(origins);
    },
    close: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}
function build(
  authority: MaterialAuthority,
  subjects: MaterialSubject[],
  purpose: OutboundPurpose = 'brief',
  allowPartial = false
) {
  return buildMaterials({
    subjects,
    purpose,
    authority,
    resolvedRecipient: target,
    limits: { maxBytes: 65536 },
    allowPartial,
  });
}
function plan(
  authority: MaterialAuthority,
  subjects: MaterialSubject[],
  purpose: OutboundPurpose = 'brief',
  extra: Partial<NonNullable<ModelRequest['materials']>> = {}
) {
  return materialRequest(purpose === 'label' ? 'labels' : purpose, {
    purpose,
    authority,
    subjects,
    allowPartial: true,
    compose: (envelope) => ({
      feature: purpose === 'label' ? 'labels' : purpose,
      system: 'Fixed synthetic instructions',
      prompt: envelope.fragments.map((fragment) => fragment.text).join('\n'),
      cacheKey: 'synthetic-input',
    }),
    ...extra,
  });
}

test('T-07-1/3: absent, invalid, unknown, missing-purpose, wrong-source and recipient grants deny before text is read', () => {
  const fixture = setup();
  let reads = 0;
  const input = {
    ...subject(),
    read: () => {
      reads++;
      return 'DO_NOT_READ';
    },
  };
  try {
    for (const value of [
      undefined,
      '{',
      { schemaVersion: 2 },
      { schemaVersion: 1, sourceId: a, revision: 1, grants: [] },
      {
        schemaVersion: 1,
        sourceId: b,
        revision: 1,
        grants: [{ purpose: 'brief', recipientId: target.recipientId, decision: 'allow', grantedAt: 0 }],
      },
    ]) {
      if (value !== undefined)
        writePrivateFile(
          path.join(fixture.home, 'sources', a, 'outbound.json'),
          typeof value === 'string' ? value : JSON.stringify(value)
        );
      assert.ok(!isEnvelope(build(fixture.authority, [input])));
    }
    fixture.grant(a, 'recap');
    assert.ok(!isEnvelope(build(fixture.authority, [input])));
    fixture.grant(a, 'brief', 'allow', 2, 'another-recipient');
    assert.ok(!isEnvelope(build(fixture.authority, [input])));
    assert.equal(reads, 0);
  } finally {
    fixture.close();
  }
});

test('T-07-2/4: new Claude/pi/delegated and private fields stay absent from requests, prompts, cache-key getters and caches', async () => {
  const fixture = setup();
  const captured: string[] = [];
  let forbiddenReads = 0;
  fixture.grant();
  const denied = [
    {
      ...subject(b),
      read: () => {
        forbiddenReads++;
        return 'CLAUDE_SENTINEL';
      },
    },
    {
      ...subject(fingerprint('pi')),
      ref: { ...ref(fingerprint('pi')), harness: 'pi' as const },
      read: () => {
        forbiddenReads++;
        return 'PI_SENTINEL';
      },
    },
    {
      ...subject(),
      origin: 'delegated' as const,
      read: () => {
        forbiddenReads++;
        return 'DELEGATED_SENTINEL';
      },
    },
    ...['reasoning', 'unknown', 'raw_log'].map((kind) => ({
      ...subject(),
      kind: kind as MaterialSubject['kind'],
      read: () => {
        forbiddenReads++;
        return 'PRIVATE_SENTINEL';
      },
    })),
  ];
  const model = new SmallModel({
    dir: path.join(fixture.home, 'cache'),
    env: {},
    account: 'synthetic-account',
    fetch: (async (_url, init) => {
      captured.push(String(init?.body));
      return reply();
    }) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  try {
    const request = plan(fixture.authority, [subject(), ...denied]);
    assert.ok((await model.submit(request).result).ok);
    assert.equal(forbiddenReads, 0);
    assert.equal(captured.length, 1);
    assert.ok(!/SENTINEL/.test(captured.join('')));
    const persisted = fs.readFileSync(
      path.join(fixture.home, 'cache', 'materials-v1', 'replies', 'cache.json'),
      'utf8'
    );
    assert.ok(!/SENTINEL/.test(persisted));
    const envelope = build(fixture.authority, [subject(), ...denied], 'brief', true);
    assert.ok(isEnvelope(envelope));
    assert.equal(envelope.coverage.state, 'partial');
    assert.deepEqual(envelope.sources, [a]);
    assert.ok(!isEnvelope(build(fixture.authority, denied, 'brief', true)));
    assert.ok(!isEnvelope(build(fixture.authority, [{ ...subject(), read: () => 'gAAAAAsealed-task' }])));
  } finally {
    model.cancelAll();
    fixture.close();
  }
});

test('T-07-5: every purpose requires its own source grant before compose/cache and raw submit is refused', async () => {
  const fixture = setup();
  let network = 0;
  let composed = 0;
  const model = new SmallModel({
    env: {},
    account: 'synthetic-account',
    fetch: (async () => {
      network++;
      return reply();
    }) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  try {
    const raw = {
      feature: 'brief',
      get system(): string {
        throw new Error('unauthorized system accessed');
      },
      get prompt(): string {
        throw new Error('unauthorized prompt accessed');
      },
      get cacheKey(): string {
        throw new Error('unauthorized key accessed');
      },
    };
    assert.ok(!(await model.submit(raw).result).ok);
    for (const purpose of purposes) {
      const request = plan(fixture.authority, [subject(a, 'Public synthetic text', purpose)], purpose, {
        compose: () => {
          composed++;
          return { feature: purpose, system: 'synthetic', prompt: 'synthetic' };
        },
      });
      assert.ok(!(await model.submit(request).result).ok, purpose);
      fixture.grant(a, purpose);
      assert.ok((await model.submit(request).result).ok, purpose);
    }
    assert.equal(network, purposes.length);
    assert.equal(composed, purposes.length);
  } finally {
    model.cancelAll();
    fixture.close();
  }
});

test('T-07-6: derived summaries retain source union, reject parent relabelling, cloning and unauthorized union members', () => {
  const fixture = setup();
  fixture.grant();
  fixture.grant(b);
  fixture.origins(['native', 'delegated']);
  try {
    const original = build(fixture.authority, [subject(), subject(b)]);
    assert.ok(isEnvelope(original));
    const derived: MaterialSubject = {
      ...subject(),
      field: 'note',
      kind: 'derived',
      derived: original,
      read: () => 'Merged synthetic summary',
    };
    const union = build(fixture.authority, [derived]);
    assert.ok(isEnvelope(union));
    assert.deepEqual(union.sources, [a, b].sort());
    const relabelled = { ...derived, ref: ref(a, 'different-parent') };
    assert.ok(!isEnvelope(build(fixture.authority, [relabelled])));
    assert.ok(!isEnvelope(build(fixture.authority, [{ ...derived, derived: structuredClone(original) }])));
    fixture.grant(b, 'brief', 'deny', 2);
    let reads = 0;
    assert.ok(
      !isEnvelope(
        build(fixture.authority, [
          {
            ...derived,
            read: () => {
              reads++;
              return 'PRIVATE_CHILD_SUMMARY';
            },
          },
        ])
      )
    );
    assert.equal(reads, 0);
  } finally {
    fixture.close();
  }
});

test('T-07-7 queue: revocation after enqueue cancels before a second outbound request', async () => {
  const fixture = setup();
  fixture.grant();
  fixture.grant(b);
  const pending: Array<(value: Response) => void> = [];
  const model = new SmallModel({
    env: {},
    account: 'synthetic-account',
    fetch: (() => new Promise<Response>((done) => pending.push(done))) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  try {
    const first = model.submit(plan(fixture.authority, [subject()]));
    const queued = model.submit(plan(fixture.authority, [subject(b)]));
    fixture.grant(b, 'brief', 'deny', 2);
    pending[0](reply());
    assert.ok((await first.result).ok);
    assert.ok(!(await queued.result).ok);
    assert.equal(pending.length, 1);
  } finally {
    model.cancelAll();
    fixture.close();
  }
});

test('T-07-7 late reply: revocation prevents memory/disk caching and consumer note persistence', async () => {
  const fixture = setup();
  fixture.grant();
  let finish!: (value: Response) => void;
  const model = new SmallModel({
    dir: path.join(fixture.home, 'cache'),
    env: {},
    account: 'synthetic-account',
    fetch: (() =>
      new Promise<Response>((done) => {
        finish = done;
      })) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  try {
    const handle = model.submit(plan(fixture.authority, [subject()]));
    while (!finish) await tick();
    fixture.grant(a, 'brief', 'deny', 2);
    finish(reply('LATE_REPLY_MUST_NOT_PERSIST'));
    assert.ok(!(await handle.result).ok);
    assert.equal(handle.isAuthorized?.(), false);
    const cache = path.join(fixture.home, 'cache', 'materials-v1', 'replies', 'cache.json');
    assert.ok(!fs.existsSync(cache) || !fs.readFileSync(cache, 'utf8').includes('LATE_REPLY'));
    const proofs = path.join(fixture.home, 'cache', 'materials-v1');
    assert.ok(!fs.existsSync(proofs) || fs.readdirSync(proofs).length === 0);
  } finally {
    model.cancelAll();
    fixture.close();
  }
});

test('T-07-6/7 repair and translation: revoked inherited provenance is checked before repair/system construction', async () => {
  const fixture = setup();
  fixture.grant();
  fixture.grant(b);
  let calls = 0;
  const model = new SmallModel({
    env: {},
    account: 'synthetic-account',
    fetch: (async () => {
      calls++;
      return reply('malformed synthetic output');
    }) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  try {
    const first = model.submit(plan(fixture.authority, [subject(), subject(b)]));
    assert.ok((await first.result).ok);
    assert.deepEqual(first.materials!.sources, [a, b].sort());
    fixture.grant(b, 'brief', 'deny', 2);
    let composed = false;
    for (const operation of ['repair', 'translation']) {
      const request = plan(fixture.authority, [subject()], 'brief', {
        inherited: first.materials,
        compose: () => {
          composed = true;
          return { feature: 'brief', system: operation, prompt: 'CHILD_SUMMARY_SENTINEL' };
        },
      });
      assert.ok(!(await model.submit(request).result).ok);
    }
    assert.equal(composed, false);
    assert.equal(calls, 1);
  } finally {
    model.cancelAll();
    fixture.close();
  }
});

test('T-07-6 cache: reauthorize before hit; missing, mismatched or unknown provenance never gives a general hit', async () => {
  const fixture = setup();
  fixture.grant();
  let calls = 0;
  const options = {
    dir: path.join(fixture.home, 'cache'),
    env: {},
    account: 'synthetic-account',
    fetch: (async () => {
      calls++;
      return reply();
    }) as typeof fetch,
  };
  const model = new SmallModel(options);
  model.configure({ backend: 'api', api });
  try {
    const request = plan(fixture.authority, [subject()]);
    assert.ok((await model.submit(request).result).ok);
    const cached = await model.submit(request).result;
    assert.ok(cached.ok && cached.cached);
    assert.equal(calls, 1);
    fixture.grant(a, 'brief', 'deny', 2);
    assert.ok(!(await model.submit(request).result).ok);
    assert.equal(calls, 1);
    fixture.grant();
    const proofDir = path.join(options.dir, 'materials-v1');
    const proofFile = path.join(proofDir, fs.readdirSync(proofDir)[0]);
    const before = fs.readFileSync(path.join(options.dir, 'materials-v1', 'replies', 'cache.json'), 'utf8');
    for (const invalid of [
      '{',
      JSON.stringify({ schemaVersion: 2 }),
      JSON.stringify({ schemaVersion: 1, reply: fingerprint('wrong') }),
    ]) {
      fs.writeFileSync(proofFile, invalid);
      const reader = new SmallModel(options);
      reader.configure({ backend: 'api', api });
      assert.ok(!(await reader.submit(request).result).ok);
      assert.equal(calls, 1);
      assert.equal(fs.readFileSync(path.join(options.dir, 'materials-v1', 'replies', 'cache.json'), 'utf8'), before);
    }
  } finally {
    model.cancelAll();
    fixture.close();
  }
});

test('T-07-8: endpoint/base path/account/profile changes deny, credentials alone never resolve a recipient', async () => {
  assert.equal(resolveRecipient(route), null);
  assert.equal(resolveRecipient({ backend: 'agy', model: 'synthetic-model' }), null);
  assert.equal(
    resolveRecipient({ ...route, endpoint: 'https://name:password@synthetic.invalid/v1' }, 'synthetic'),
    null
  );
  assert.equal(
    resolveRecipient({ ...route, endpoint: 'https://synthetic.invalid/v1?token=secret' }, 'synthetic'),
    null
  );
  const fixture = setup();
  fixture.grant();
  let calls = 0;
  const model = new SmallModel({
    env: {},
    account: 'other-account',
    fetch: (async () => {
      calls++;
      return reply();
    }) as typeof fetch,
  });
  model.configure({ backend: 'api', api });
  try {
    assert.ok(!(await model.submit(plan(fixture.authority, [subject()])).result).ok);
    const changed = new SmallModel({
      env: {},
      account: 'synthetic-account',
      fetch: (async () => {
        calls++;
        return reply();
      }) as typeof fetch,
    });
    changed.configure({ backend: 'api', api: { ...api, base: 'https://synthetic.invalid/api-b' } });
    assert.ok(!(await changed.submit(plan(fixture.authority, [subject()])).result).ok);
    assert.equal(calls, 0);
  } finally {
    fixture.close();
  }
});

test('T-07-9: backend off is zero network and never evaluates material or prompt; display preset has no grants', async () => {
  const fixture = setup();
  let calls = 0;
  let reads = 0;
  const model = new SmallModel({
    env: {},
    account: 'synthetic-account',
    fetch: (async () => {
      calls++;
      return reply();
    }) as typeof fetch,
  });
  try {
    fixture.grant();
    assert.ok(
      !(
        await model.submit(
          plan(fixture.authority, [
            {
              ...subject(),
              read: () => {
                reads++;
                return 'NEVER';
              },
            },
          ])
        ).result
      ).ok
    );
    assert.equal(calls, 0);
    assert.equal(reads, 0);
    model.configure({ backend: 'api', api });
    const unknown = fileAuthority(fixture.home, () => null);
    assert.ok(!(await model.submit(plan(unknown, [subject()])).result).ok);
    assert.equal(calls, 0);
  } finally {
    fixture.close();
  }
});

test('T-07-7 scope revision and source changes invalidate a previously built envelope', () => {
  const fixture = setup();
  fixture.grant();
  try {
    const envelope = build(fixture.authority, [subject()]);
    assert.ok(isEnvelope(envelope));
    assert.equal(revalidateMaterials(envelope, fixture.authority, target), true);
    fixture.scopes.set(a, 2);
    assert.equal(revalidateMaterials(envelope, fixture.authority, target), false);
    fixture.scopes.delete(a);
    assert.equal(revalidateMaterials(envelope, fixture.authority, target), false);
  } finally {
    fixture.close();
  }
});

test('material building cost: pure bounded public fragments, no collection or paint hook', () => {
  const fixture = setup();
  fixture.grant();
  try {
    const inputs = Array.from({ length: 20 }, () => subject());
    const measurements: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      assert.ok(isEnvelope(build(fixture.authority, inputs)));
      measurements.push(performance.now() - start);
    }
    measurements.sort((x, y) => x - y);
    console.log(
      `B17 material file-authority n=100 fragments=20 p50=${measurements[50].toFixed(3)}ms p95=${measurements[95].toFixed(3)}ms p99=${measurements[99].toFixed(3)}ms max=${measurements.at(-1)!.toFixed(3)}ms; new HUD-tick I/O=0`
    );
  } finally {
    fixture.close();
  }
});

test('T-07-6 persistent notes: source union survives restart, translation and revocation without entering legacy stores', () => {
  const fixture = setup();
  fixture.grant();
  fixture.grant(b);
  try {
    const envelope = build(fixture.authority, [subject(), subject(b)]);
    assert.ok(isEnvelope(envelope));
    const store = new DerivedMaterialStore(path.join(fixture.home, 'notes'));
    const id = store.save('A synthetic joint summary', envelope, fixture.authority, target);
    assert.ok(id);
    const restored = new DerivedMaterialStore(path.join(fixture.home, 'notes')).load(
      id,
      fixture.authority,
      'brief',
      target
    );
    assert.ok(restored);
    assert.deepEqual(restored.sources, [a, b].sort());
    assert.equal(restored.fragments[0].text, 'A synthetic joint summary');
    assert.equal(store.load(id, fixture.authority, 'routing', target), null);
    fixture.grant(b, 'brief', 'deny', 2);
    assert.equal(store.load(id, fixture.authority, 'brief', target), null);
    assert.equal(store.save('Late note', envelope, fixture.authority, target), null);
    assert.equal(fs.statSync(path.join(fixture.home, 'notes', `${id}.json`)).mode & 0o777, 0o600);
  } finally {
    fixture.close();
  }
});

test('T-07-17 preservation: more than 200 general entries never prune or rewrite the original legacy cache', async () => {
  const fixture = setup();
  fixture.grant();
  const dir = path.join(fixture.home, 'shared-runtime');
  const legacyFile = path.join(dir, 'cache.json');
  const old = JSON.stringify({
    [fingerprint('old-native-entry')]: { text: 'Legacy-only synthetic reply', at: 1700000000000 },
  });
  writePrivateFile(legacyFile, old);
  let calls = 0;
  const model = new SmallModel({
    dir,
    env: {},
    account: 'synthetic-account',
    fetch: (async () => {
      calls++;
      return reply();
    }) as typeof fetch,
  });
  model.configure({ backend: 'api', api, hourlyCap: 1000 });
  try {
    for (let i = 0; i < 205; i++)
      assert.ok((await model.submit(plan(fixture.authority, [subject(a, `Synthetic observation ${i}`)])).result).ok);
    assert.equal(calls, 205);
    assert.equal(fs.readFileSync(legacyFile, 'utf8'), old);
    const generalFile = path.join(dir, 'materials-v1', 'replies', 'cache.json');
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(generalFile, 'utf8'))).length, 200);
    assert.equal(model.usage().lastHour, 205, 'general calls retain the existing shared budget');
    await model.flushTelemetry();
  } finally {
    model.cancelAll();
    fixture.close();
  }
});
