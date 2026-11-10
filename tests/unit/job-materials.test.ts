import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { selfStamp } from '../../src/roles/pi-owned/runtime.js';
import { buildMaterials, fingerprint, revalidateMaterials } from '../../src/core/materials/index.js';
import {
  JobMaterialAuthority,
  JobBudgetPending,
  JOB_DISPATCH_FENCE_LIMITS,
  JOB_CONSENT_WRITE_LIMITS,
  withJobBudget,
  currentJobBudget,
  hasJobBudget,
  invalidateJobPaths,
  readJobFile,
  jobReadBudget,
  jobFileMetrics,
  type JobMaterialEnvelope,
  type JobIdentity,
  type JobMaterialSubject,
} from '../../src/core/materials/job.js';
import { jobMaterialRequest } from '../../src/core/materials/request.js';
import { resolveRecipient } from '../../src/core/materials/recipient.js';
import { DerivedMaterialStore } from '../../src/core/materials/derived.js';
import { SmallModel, modelHttpRequest, writePrivateFile } from '../../src/collectors/small-model.js';
import { ModelRuntimeStore } from '../../src/collectors/model-runtime-store.js';
import { JobPublicOutputAdapter, publicPiText } from '../../src/collectors/job-public-output.js';

const root = 'pi/synthetic-root';
const invocation = 'j0123456789abcdef';
const api = { base: 'https://synthetic.invalid/v1', model: 'synthetic-model', sourceCredential: null };
const target = resolveRecipient(
  { backend: 'api', endpoint: `${api.base}/chat/completions`, model: api.model },
  'synthetic-account'
)!;
const response = () => new Response(JSON.stringify({ choices: [{ message: { content: 'Synthetic sentence.' } }] }));
const tick = () => new Promise<void>((done) => setImmediate(done));
const coverage = { state: 'partial' as const, loaded: true, skipped: {}, gaps: ['synthetic'] };
function fixture(depth = 0) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'job-materials-'));
  const home = path.join(base, ...Array<string>(depth).fill('nested'));
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const directory = path.join(home, 'jobs', invocation);
  fs.mkdirSync(path.join(directory, 'sessions'), { recursive: true });
  const session = path.join(directory, 'sessions', 'primary.jsonl');
  const binding = {
    id: 'pi-fast',
    executor: 'herdr',
    harness: 'pi',
    model: 'synthetic-model',
    effort: 'high',
    env_profile: null,
    recipe: 'pi-role',
  };
  const herdr = { tab_id: 'synthetic-tab', pane_id: 'synthetic-pane', agent: 'synthetic-agent', workspace_id: null };
  const association = {
    schema: 1,
    job: invocation,
    root,
    role: 'imp',
    phase: null,
    preset: 'daily',
    task_label: 'Synthetic parser task',
    cwd: '/synthetic/workspace',
    backend: binding,
    herdr,
    report_path: path.join(directory, 'report.md'),
    closed: false,
  };
  const receipt = {
    schema: 1,
    job: invocation,
    parent: root,
    role: 'imp',
    phase: null,
    preset: 'daily',
    binding,
    executor: { kind: 'herdr', ...herdr },
    state: 'open',
    pi_dispatch: {
      contract_version: 1,
      role: 'implementer',
      executable: '/synthetic/pi-dispatch',
      reaper: '/synthetic/pi-role-reap',
      launch: 'acked',
    },
  };
  const status = {
    version: 1,
    task_dir: directory,
    slot: 'primary',
    role: 'implementer',
    output_path: path.join(directory, 'report.md'),
    state: 'working',
    output_written: false,
    session_id: 'synthetic-session',
    session_file: session,
    model: 'synthetic-model',
    thinking: 'high',
    settled_at: null,
    idle_deadline_at: null,
    ended_at: null,
    error: null,
    exit_reason: null,
    helper_pending: null,
  };
  const json = (relative: string, value: unknown) => writePrivateFile(path.join(home, relative), JSON.stringify(value));
  json(`assoc/${invocation}.json`, association);
  json(`jobs/${invocation}/receipt.json`, receipt);
  json(`jobs/${invocation}/STATUS.json`, status);
  fs.writeFileSync(
    path.join(directory, 'brief.md'),
    '# Synthetic task\n\n## Goal\nRepair the public parser.\n\n## Owned files\n- `src/parser.ts`\n\n## Test plan\n### Parser boundaries\n'
  );
  fs.writeFileSync(path.join(directory, 'report.md'), 'Reported result: parser repaired.');
  const rows = [
    { type: 'session', version: 3, id: 'synthetic-session', cwd: '/synthetic/workspace' },
    {
      type: 'message',
      id: 'm1',
      parentId: null,
      message: { role: 'user', content: [{ type: 'text', text: 'PRIVATE_USER' }] },
    },
    {
      type: 'message',
      id: 'm2',
      parentId: 'm1',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'PRIVATE_THINKING' },
          { type: 'text', text: 'Public parser progress.' },
          { type: 'toolCall', arguments: { secret: 'PRIVATE_ARGUMENTS' } },
        ],
      },
    },
    {
      type: 'message',
      id: 'm3',
      parentId: 'm2',
      message: { role: 'toolResult', content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }] },
    },
    {
      type: 'message',
      id: 'm4',
      parentId: 'm3',
      message: { role: 'assistant', channel: 'unknown', content: [{ type: 'text', text: 'PRIVATE_UNKNOWN' }] },
    },
  ];
  const sessionRows = (next: unknown[] = rows) =>
    fs.writeFileSync(session, next.map((r) => JSON.stringify(r)).join('\n') + '\n');
  sessionRows();
  const authority = new JobMaterialAuthority(home);
  const identity = authority.capture(invocation, root);
  assert.ok(identity);
  const adapter = new JobPublicOutputAdapter(authority);
  const policyFile = path.join(home, 'job-materials-v1', 'policy.json');
  const grant = () => authority.setConsent(target.recipientId, 'allow', 1000);
  const subject = () => adapter.subject(identity, target, { report: true });
  const attempt = (s: JobMaterialSubject = subject(), a = authority, budget = s.budget) =>
    buildMaterials({
      kind: 'job',
      purpose: 'job_card',
      subject: s,
      authority: a,
      resolvedRecipient: target,
      limits: { maxBytes: 16384, maxFragments: 32 },
      budget,
    });
  const build = (s: JobMaterialSubject = subject(), a = authority) => {
    const result = attempt(s, a);
    assert.ok(!('pending' in result));
    return result;
  };
  const envelope = () => {
    const value = build();
    assert.ok(!('denied' in value));
    return value;
  };
  const model = (fetcher: typeof fetch, dir: string | null = null) => {
    const m = new SmallModel({ account: 'synthetic-account', dir, fetch: fetcher });
    m.configure({ backend: 'api', api });
    return m;
  };
  const request = (
    s = subject(),
    compose = (e: JobMaterialEnvelope) => ({
      feature: 'job_card',
      system: 'Synthetic quoted material',
      prompt: e.fragments.map((f) => f.text).join('\n'),
      cacheKey: 'synthetic-job',
    })
  ) => jobMaterialRequest({ kind: 'job', purpose: 'job_card', subject: s, authority, compose });
  return {
    home,
    directory,
    session,
    association,
    receipt,
    status,
    rows,
    sessionRows,
    json,
    authority,
    identity,
    adapter,
    policyFile,
    grant,
    subject,
    build,
    attempt,
    envelope,
    model,
    request,
    close: () => {
      authority.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

test('job authorization precedes extraction, formatting, material hash getters and cache lookup', async (t) => {
  const f = fixture();
  const counts = { extraction: 0, prompt: 0, hash: 0, cache: 0, transport: 0 };
  const createHash = crypto.createHash;
  t.mock.method(crypto, 'createHash', (...args: Parameters<typeof crypto.createHash>) => {
    const hash = createHash(...args);
    const update = hash.update.bind(hash);
    t.mock.method(hash, 'update', (data: crypto.BinaryLike, encoding?: crypto.Encoding) => {
      if (typeof data === 'string' && data.includes('Authorized goal.')) counts.hash++;
      return typeof data === 'string' ? update(data, encoding ?? 'utf8') : update(data);
    });
    return hash;
  });
  syncBuiltinESMExports();
  const cache = ModelRuntimeStore.prototype.cache;
  t.mock.method(ModelRuntimeStore.prototype, 'cache', function (this: ModelRuntimeStore) {
    counts.cache++;
    return cache.call(this);
  });
  const subject: JobMaterialSubject = {
    kind: 'job',
    identity: f.identity,
    read() {
      counts.extraction++;
      return { fragments: [{ id: 'e1', field: 'goal', text: 'Authorized goal.', locator: 'brief.md' }], coverage };
    },
  };
  const model = f.model(
    async () => {
      counts.transport++;
      return response();
    },
    path.join(f.home, 'model')
  );
  const make = () =>
    f.request(subject, () => {
      counts.prompt++;
      return {
        feature: 'job_card',
        system: 'Quoted synthetic instructions',
        prompt: 'Authorized goal.',
        cacheKey: 'synthetic',
      };
    });
  try {
    const result = await model.submit(make()).result;
    assert.equal(result.ok, false);
    assert.deepEqual(counts, { extraction: 0, prompt: 0, hash: 0, cache: 0, transport: 0 });
    f.grant();
    assert.equal((await model.submit(make()).result).ok, true);
    assert.equal(counts.extraction, 1);
    assert.equal(counts.prompt, 1);
    assert.ok(counts.hash > 0);
    assert.ok(counts.cache > 0);
    assert.equal(counts.transport, 1);
  } finally {
    model.cancelAll();
    await model.flushTelemetry();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.close();
  }
});

test('job policy missing, malformed, oversized, unknown fields and recipient/root mismatch deny before extraction', () => {
  const f = fixture();
  let reads = 0;
  const subject: JobMaterialSubject = {
    kind: 'job',
    identity: f.identity,
    read: () => {
      reads++;
      throw new Error('forbidden');
    },
  };
  try {
    assert.ok('denied' in f.build(subject));
    f.grant();
    const good = JSON.parse(fs.readFileSync(f.policyFile, 'utf8'));
    for (const value of [
      '{',
      ' '.repeat(65537),
      { ...good, schemaVersion: 2 },
      { ...good, extra: true },
      { ...good, grants: [] },
      { ...good, scope: { ...good.scope, fields: [] } },
      { ...good, grants: [{ ...good.grants[0], recipientId: fingerprint('other') }] },
      { ...good, scope: { ...good.scope, excludedRoots: [root] } },
      { ...good, grants: [good.grants[0], { ...good.grants[0], decision: 'deny' }] },
    ]) {
      writePrivateFile(f.policyFile, typeof value === 'string' ? value : JSON.stringify(value));
      assert.ok('denied' in f.build(subject));
    }
    assert.equal(reads, 0);
  } finally {
    f.close();
  }
});

test('contributing file pins stay bounded independently of historical artifact selection', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 100; i++) {
      const relative = `review-${i + 1}.md`;
      fs.writeFileSync(path.join(f.directory, relative), 'Synthetic historical artifact.');
      assert.equal(f.authority.pinFile(f.identity, relative), true);
    }
    assert.equal(f.authority.contributingFiles(f.identity).length, 32);
    f.grant();
    assert.ok(!('denied' in f.build()));
  } finally {
    f.close();
  }
});

test('job scope cannot grant an auto-discovered workspace directory, wrong home/root/invocation or external record', () => {
  const f = fixture();
  try {
    f.grant();
    fs.mkdirSync(path.join(f.home, 'workspace', 'tmp', 'tasks', invocation), { recursive: true });
    fs.writeFileSync(path.join(f.home, 'workspace', 'tmp', 'tasks', invocation, 'report.md'), 'WORKSPACE_SENTINEL');
    assert.equal(f.authority.capture(path.join(f.home, 'workspace', 'tmp', 'tasks', invocation), root), null);
    assert.equal(f.authority.capture('external-task', root), null);
    assert.equal(f.authority.capture(invocation, 'pi/another-root'), null);
    assert.equal(f.authority.policy()?.scope.external, false);
    for (const identity of [
      { ...f.identity, home: fingerprint('another-home') },
      { ...f.identity, root: 'pi/another-root' },
      { ...f.identity, invocation: 'j1111111111111111' },
      { ...f.identity, episode: fingerprint('another-episode') },
    ])
      assert.equal(f.authority.authorize(identity, target), null);
    const external = f.authority.policy()!;
    external.scope.external = true;
    writePrivateFile(f.policyFile, JSON.stringify(external));
    assert.equal(f.authority.capture('external-task', root), null); // eligibility is not an output locator
  } finally {
    f.close();
  }
});

test('job material is public-only, bounded, source-bound and unchanged warm refreshes read zero bodies', () => {
  const f = fixture();
  try {
    f.grant();
    const first = f.envelope();
    const text = first.fragments.map((s) => s.text).join('\n');
    assert.ok(text.includes('Public parser progress.'));
    assert.ok(text.includes('Repair the public parser.'));
    assert.ok(!text.includes('PRIVATE_'));
    assert.ok(first.fragments.every((fragment) => fragment.provenance.every((p) => p.kind === 'job' && !('ref' in p))));
    assert.ok(Buffer.byteLength(text) <= 16384);
    assert.ok(first.fragments.length <= 32);
    assert.ok(f.adapter.reads.files <= 8);
    assert.ok(f.adapter.reads.bytes <= 256 * 1024);
    const reads = { ...f.adapter.reads },
      authReads = { ...f.authority.reads };
    const probesBefore = jobFileMetrics.probes;
    for (let i = 0; i < 5; i++) assert.equal(f.envelope().fingerprint, first.fingerprint);
    assert.deepEqual(f.adapter.reads, reads);
    assert.deepEqual(f.authority.reads, authReads);
    console.log(
      `job warm refreshes=5 bodyReads=0 bytes=0 reparses=0 metadataProbes=${jobFileMetrics.probes - probesBefore}; cold files=${reads.files} bytes=${reads.bytes}`
    );
    fs.appendFileSync(path.join(f.directory, 'brief.md'), '\n');
    f.envelope();
    assert.ok(f.adapter.reads.files > reads.files);
  } finally {
    f.close();
  }
});

test('job material enforces 16 KiB and 32 fragments independently with explicit partial coverage', () => {
  const f = fixture();
  try {
    f.grant();
    const fragments = Array.from({ length: 64 }, (_, i) => ({
      id: `p${i}`,
      field: 'owned_path' as const,
      text: `src/${i}.ts`,
      locator: 'brief.md',
    }));
    const result = f.build({ kind: 'job', identity: f.identity, read: () => ({ fragments, coverage }) });
    assert.ok(!('denied' in result));
    assert.equal(result.fragments.length, 32);
    assert.ok(result.coverage.gaps.includes('material_budget'));
    fs.mkdirSync(path.join(f.directory, 'qa'));
    fs.writeFileSync(path.join(f.directory, 'qa/q1.md'), '界'.repeat(2000));
    const large = f.build({
      kind: 'job',
      identity: f.identity,
      read: () => ({
        fragments: [
          { id: 'e1', field: 'report', text: '界'.repeat(4000), locator: 'report.md' },
          { id: 'e2', field: 'question', text: '界'.repeat(2000), locator: 'qa/q1.md' },
        ],
        coverage,
      }),
    });
    assert.ok(!('denied' in large));
    assert.equal(large.fragments.length, 1);
    assert.ok(Buffer.byteLength(large.fragments[0].text) <= 16384);
    const budget = jobReadBudget();
    budget.maxFiles = 1;
    budget.maxBytes = 65536;
    const limited = f.attempt(f.adapter.subject(f.identity, target, { report: true, questions: ['qa/q1.md'] }, budget));
    assert.ok(budget.files <= 1);
    assert.ok(budget.bytes <= 65536);
    assert.deepEqual(limited, { pending: true, reason: 'budget' });
  } finally {
    f.close();
  }
});

test('unsafe Pi session locators, headers and branch changes degrade to artifacts, never prose', () => {
  const f = fixture();
  try {
    f.grant();
    const cases = ['outside', 'dotdot', 'symlink', 'fifo', 'header', 'branch', 'unknown', 'oversized'];
    for (const kind of cases) {
      f.sessionRows();
      let locator = f.session;
      if (kind === 'outside') locator = path.join(f.home, 'outside.jsonl');
      if (kind === 'dotdot') locator = path.join(f.directory, 'sessions') + '/../sessions/primary.jsonl';
      if (kind === 'symlink') {
        locator = path.join(f.directory, 'sessions', 'linked.jsonl');
        fs.symlinkSync(f.session, locator);
      }
      if (kind === 'fifo') {
        locator = path.join(f.directory, 'sessions', 'unsafe.pipe');
        const made = spawnSync('mkfifo', [locator], { encoding: 'utf8', timeout: 5000 });
        assert.equal(made.status, 0, made.stderr);
      }
      if (kind === 'header') f.sessionRows([{ ...f.rows[0], id: 'wrong-header' }, ...f.rows.slice(1)]);
      if (kind === 'branch')
        f.sessionRows([
          ...f.rows,
          {
            type: 'message',
            id: 'forked',
            parentId: 'm1',
            message: { role: 'assistant', content: [{ type: 'text', text: 'WRONG_BRANCH' }] },
          },
        ]);
      if (kind === 'unknown')
        f.sessionRows([...f.rows, { type: 'custom', id: 'private', parentId: 'm4', data: 'PRIVATE_CUSTOM' }]);
      if (kind === 'oversized') fs.truncateSync(f.session, 64 * 1024 * 1024 + 1);
      f.json(`jobs/${invocation}/STATUS.json`, { ...f.status, session_file: locator });
      const identity = f.authority.capture(invocation, root)!;
      assert.ok(identity);
      const result = f.build(f.adapter.subject(identity, target, { report: true }));
      assert.ok(!('denied' in result), kind);
      assert.ok(
        !result.fragments.some((fragment) => fragment.provenance.some((p) => p.field === 'public_output')),
        kind
      );
    }
  } finally {
    f.close();
  }
});

test('Pi public record allowlist excludes private/unknown channels, sealed data, incomplete records and bounds tail records', () => {
  const message = (id: number, parentId: string | null, content: unknown, channel?: string) => ({
    type: 'message',
    id: `m${id}`,
    parentId,
    message: { role: 'assistant', content, ...(channel ? { channel } : {}) },
  });
  const rows: unknown[] = [{ type: 'session', id: 'synthetic-session', version: 3 }];
  for (let i = 1; i <= 8; i++)
    rows.push(
      message(i, i === 1 ? null : `m${i - 1}`, [
        { type: 'text', text: `Public ${i}` },
        { type: 'thinking', text: 'PRIVATE' },
      ])
    );
  const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  assert.equal(publicPiText(text + JSON.stringify(rows[0]) + '\n', false, 'synthetic-session'), null);
  const unknownPrivate = {
    ...message(9, 'm8', [{ type: 'text', text: 'UNKNOWN_PRIVATE' }]),
    message: { role: 'assistant', private: true, content: [{ type: 'text', text: 'UNKNOWN_PRIVATE' }] },
  };
  assert.ok(
    !publicPiText(text + JSON.stringify(unknownPrivate) + '\n', false, 'synthetic-session')?.some((f) =>
      f.text.includes('UNKNOWN_PRIVATE')
    )
  );
  assert.deepEqual(
    publicPiText(text, false, 'synthetic-session')?.map((s) => s.text),
    ['Public 5', 'Public 6', 'Public 7', 'Public 8']
  );
  assert.deepEqual(
    publicPiText(
      text + JSON.stringify(message(9, 'm8', [{ type: 'text', text: 'INCOMPLETE' }])),
      false,
      'synthetic-session'
    )?.map((s) => s.text),
    ['Public 5', 'Public 6', 'Public 7', 'Public 8']
  );
  const privateRows = [
    message(9, 'm8', [{ type: 'text', text: 'PRIVATE' }], 'analysis'),
    message(10, 'm9', [{ type: 'text', text: 'gAAAAASEALED' }]),
    message(11, 'm10', [{ type: 'text', text: 'UNKNOWN', private: true }]),
  ];
  assert.deepEqual(
    publicPiText(text + privateRows.map((r) => JSON.stringify(r)).join('\n') + '\n', false, 'synthetic-session')?.map(
      (s) => s.text
    ),
    ['Public 5', 'Public 6', 'Public 7', 'Public 8']
  );
});

test('source replacement at the same path and continuation invalidate minted material before publication', () => {
  const f = fixture();
  try {
    f.grant();
    const original = f.envelope();
    assert.equal(revalidateMaterials(original, f.authority, target), true);
    const replacement = f.session + '.new';
    fs.copyFileSync(f.session, replacement);
    fs.renameSync(replacement, f.session);
    assert.equal(revalidateMaterials(original, f.authority, target), false);
    assert.ok('denied' in f.build());
    const next = f.authority.capture(invocation, root)!;
    assert.notEqual(next.episode, f.identity.episode);
    assert.ok(!('denied' in f.build(f.adapter.subject(next, target, { report: true }))));
    f.json(`jobs/${invocation}/receipt.json`, {
      ...f.receipt,
      pi_dispatch: {
        ...f.receipt.pi_dispatch,
        continuation: {
          message_key: 'synthetic-next',
          previous_session_id: 'synthetic-session',
          previous_settled_at: '2026-01-01T00:00:00Z',
        },
      },
    });
    assert.equal(f.authority.authorize(next, target), null);
  } finally {
    f.close();
  }
});

test('queued and in-flight job revocation aborts work, fences late replies and retains the single transport slot', async () => {
  const f = fixture();
  let calls = 0;
  let aborted = false;
  let release!: () => void;
  const pending = new Promise<void>((done) => {
    release = done;
  });
  const model = f.model(async (_url, init) => {
    calls++;
    init?.signal?.addEventListener('abort', () => {
      aborted = true;
    });
    await pending;
    return response();
  });
  try {
    f.grant();
    const active = model.submit(f.request());
    const queued = model.submit(
      f.request(f.subject(), (e) => ({
        feature: 'job_card',
        system: 'Synthetic',
        prompt: e.fragments[0].text,
        cacheKey: 'second-input',
      }))
    );
    await tick(); // q8: job-only dispatch begins after admission's microtask boundary.
    assert.equal(calls, 1);
    f.authority.setConsent(target.recipientId, 'deny', 2000);
    assert.equal((await active.result).ok, false);
    assert.equal((await queued.result).ok, false);
    assert.equal(aborted, true);
    assert.equal(active.jobMaterials, undefined);
    f.grant();
    const replacement = model.submit(f.request());
    assert.equal(calls, 1);
    release();
    assert.equal((await replacement.result).ok, true);
    assert.equal(calls, 2);
    assert.equal(active.isAuthorized?.(), false);
  } finally {
    release();
    model.cancelAll();
    await tick();
    f.close();
  }
});

test('real SmallModel and derived store restart keeps revocation; denied cache bytes stay unchanged', async () => {
  const f = fixture();
  const dir = path.join(f.home, 'model');
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return response();
  };
  let model = f.model(fetcher, dir);
  try {
    f.grant();
    const first = model.submit(f.request());
    assert.equal((await first.result).ok, true);
    const envelope = first.jobMaterials!;
    assert.ok(envelope);
    const store = new DerivedMaterialStore(path.join(f.home, 'derived'));
    const id = store.saveJob('Synthetic sentence.', envelope, f.authority, target);
    assert.ok(id);
    await model.flushTelemetry();
    model.cancelAll();
    model = f.model(fetcher, dir);
    const hit = await model.submit(f.request()).result;
    assert.equal(hit.ok && hit.cached, true);
    assert.equal(calls, 1);
    const freshAuthority = new JobMaterialAuthority(f.home);
    const identity = freshAuthority.capture(invocation, root)!;
    assert.ok(new DerivedMaterialStore(path.join(f.home, 'derived')).loadJob(id, identity, freshAuthority, target));
    f.authority.setConsent(target.recipientId, 'deny', 2000);
    const files = [
      path.join(dir, 'materials-v1', 'replies', 'cache.json'),
      path.join(f.home, 'derived', 'jobs-v1', `${id}.json`),
    ];
    const before = files.map((file) => fs.readFileSync(file));
    model.cancelAll();
    await model.flushTelemetry();
    const restarted = new JobMaterialAuthority(f.home);
    const nextIdentity = restarted.capture(invocation, root)!;
    assert.equal(
      new DerivedMaterialStore(path.join(f.home, 'derived')).loadJob(id, nextIdentity, restarted, target),
      null
    );
    model = f.model(fetcher, dir);
    assert.equal(
      (
        await model.submit(
          jobMaterialRequest({
            kind: 'job',
            purpose: 'job_card',
            authority: restarted,
            subject: new JobPublicOutputAdapter(restarted).subject(nextIdentity, target, { report: true }),
            compose: () => {
              throw new Error('denied formatter');
            },
          })
        ).result
      ).ok,
      false
    );
    assert.equal(calls, 1);
    files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), before[i]));
  } finally {
    model.cancelAll();
    await model.flushTelemetry();
    f.close();
  }
});

test('direct Pi facade sessions require a unique safe job-local source and unchanged membership is not re-enumerated', () => {
  const f = fixture();
  try {
    const { pi_dispatch: _dispatch, ...receipt } = f.receipt;
    f.json(`jobs/${invocation}/receipt.json`, receipt);
    fs.unlinkSync(path.join(f.directory, 'STATUS.json'));
    const authority = new JobMaterialAuthority(f.home);
    const identity = authority.capture(invocation, root)!;
    assert.ok(identity);
    authority.setConsent(target.recipientId, 'allow', 1000);
    const adapter = new JobPublicOutputAdapter(authority);
    const build = (id: JobIdentity) =>
      buildMaterials({
        kind: 'job',
        purpose: 'job_card',
        subject: adapter.subject(id, target),
        authority,
        resolvedRecipient: target,
        limits: { maxBytes: 16384 },
      });
    const first = build(identity);
    assert.ok(!('denied' in first) && !('pending' in first));
    assert.ok(first.fragments.some((f) => f.provenance[0].field === 'public_output'));
    const before = { ...authority.reads };
    const body = { ...adapter.reads };
    for (let i = 0; i < 5; i++) assert.ok(!('denied' in build(identity)));
    assert.deepEqual(authority.reads, before);
    assert.deepEqual(adapter.reads, body);
    fs.copyFileSync(f.session, path.join(f.directory, 'sessions', 'ambiguous.jsonl'));
    assert.equal(authority.authorize(identity, target), null);
    const next = authority.capture(invocation, root)!;
    assert.ok(next);
    const ambiguous = build(next);
    assert.ok(!('denied' in ambiguous) && !('pending' in ambiguous));
    assert.ok(!ambiguous.fragments.some((f) => f.provenance[0].field === 'public_output'));
  } finally {
    f.close();
  }
});

test('review material binds the validated helper slot/session and never follows a helper-supplied locator', () => {
  const f = fixture();
  try {
    f.grant();
    const review = path.join(f.directory, 'review-1.md');
    fs.writeFileSync(review, 'Verdict: changes-required\n\n## Finding: public boundary\nPRIVATE_HELPER_BODY');
    f.json(`jobs/${invocation}/.dispatch/review-1/STATUS.json`, {
      ...f.status,
      slot: 'review-1',
      role: 'reviewer',
      session_id: 'synthetic-helper-session',
      output_path: review,
      state: 'closed',
      output_written: true,
    });
    const e = f.build(f.adapter.subject(f.identity, target, { review: 'review-1.md' }));
    assert.ok(!('denied' in e));
    const fragments = e.fragments.filter((fragment) => fragment.provenance[0].field === 'review');
    assert.equal(fragments.length, 2);
    assert.ok(fragments.every((fragment) => fragment.provenance[0].helper?.sessionId === 'synthetic-helper-session'));
    assert.ok(!e.fragments.some((fragment) => fragment.text.includes('PRIVATE_HELPER_BODY')));
    f.json(`jobs/${invocation}/.dispatch/review-1/STATUS.json`, {
      ...f.status,
      slot: 'review-1',
      role: 'reviewer',
      session_id: 'replaced-helper',
      output_path: review,
      state: 'closed',
      output_written: true,
    });
    assert.equal(revalidateMaterials(e, f.authority, target), false);
    fs.unlinkSync(path.join(f.directory, '.dispatch/review-1/STATUS.json'));
    const missing = f.build(f.adapter.subject(f.identity, target, { review: 'review-1.md' }));
    assert.ok(!('denied' in missing));
    assert.ok(!missing.fragments.some((fragment) => fragment.provenance[0].field === 'review'));
  } finally {
    f.close();
  }
});

test('continuation suppresses old result, review, question and public output; complete report excerpts are head/tail bounded', () => {
  const f = fixture();
  try {
    f.grant();
    fs.mkdirSync(path.join(f.directory, 'qa'));
    fs.writeFileSync(path.join(f.directory, 'qa', 'q1.md'), 'Current synthetic question?');
    fs.writeFileSync(
      path.join(f.directory, 'review-1.md'),
      'Verdict: changes-required\n\n## Finding: parser boundary\nPRIVATE_REVIEW_BODY'
    );
    fs.writeFileSync(path.join(f.directory, 'report.md'), 'HEAD_MARKER' + 'x'.repeat(8000) + 'TAIL_MARKER');
    f.json(`jobs/${invocation}/STATUS.json`, { ...f.status, output_written: true, settled_at: '2026-01-01T00:00:00Z' });
    const identity = f.authority.capture(invocation, root)!;
    const selection = { report: true, review: 'review-1.md', questions: ['qa/q1.md'] };
    const first = f.build(f.adapter.subject(identity, target, selection));
    assert.ok(!('denied' in first));
    const report = first.fragments.find((fragment) => fragment.provenance[0].field === 'report')!;
    assert.ok(report);
    assert.ok(report.text.startsWith('HEAD_MARKER'));
    assert.ok(report.text.endsWith('TAIL_MARKER'));
    assert.ok(report.text.includes('[truncated]'));
    assert.ok(Array.from(report.text).length <= 4000);
    assert.ok(!first.fragments.some((fragment) => fragment.text.includes('PRIVATE_REVIEW_BODY')));
    f.json(`jobs/${invocation}/receipt.json`, {
      ...f.receipt,
      pi_dispatch: {
        ...f.receipt.pi_dispatch,
        continuation: {
          message_key: 'synthetic-next',
          previous_session_id: 'synthetic-session',
          previous_settled_at: '2026-01-01T00:00:00Z',
        },
      },
    });
    const next = f.authority.capture(invocation, root)!;
    const continued = f.build(f.adapter.subject(next, target, selection));
    assert.ok(!('denied' in continued));
    assert.ok(
      continued.fragments.every((fragment) =>
        ['goal', 'owned_path', 'test_heading'].includes(fragment.provenance[0].field)
      )
    );
  } finally {
    f.close();
  }
});

test('job derived-note generations keep the complete original provenance union', () => {
  const f = fixture();
  try {
    f.grant();
    const original = f.envelope();
    const store = new DerivedMaterialStore(path.join(f.home, 'derived'));
    const first = store.saveJob('First synthetic sentence.', original, f.authority, target)!;
    assert.ok(first);
    const loaded = store.loadJob(first, f.identity, f.authority, target)!;
    assert.ok(loaded);
    assert.deepEqual(
      loaded.fragments.flatMap((fragment) => fragment.provenance),
      original.fragments.flatMap((fragment) => fragment.provenance)
    );
    const second = store.saveJob('Second synthetic sentence.', loaded, f.authority, target)!;
    assert.equal(second, first);
    const restored = store.loadJob(second, f.identity, f.authority, target)!;
    assert.ok(restored);
    assert.deepEqual(
      restored.fragments.flatMap((fragment) => fragment.provenance),
      original.fragments.flatMap((fragment) => fragment.provenance)
    );
  } finally {
    f.close();
  }
});

test('stored job annotations reject contributing artifact replacement and local-root revocation without rewriting records', () => {
  const f = fixture();
  try {
    f.grant();
    const envelope = f.envelope();
    const store = new DerivedMaterialStore(path.join(f.home, 'derived'));
    const id = store.saveJob('Synthetic sentence.', envelope, f.authority, target)!;
    assert.ok(id);
    const file = path.join(f.home, 'derived', 'jobs-v1', `${id}.json`);
    const before = fs.readFileSync(file);
    const brief = path.join(f.directory, 'brief.md');
    fs.copyFileSync(brief, brief + '.new');
    fs.renameSync(brief + '.new', brief);
    assert.equal(revalidateMaterials(envelope, f.authority, target), false);
    const restarted = new JobMaterialAuthority(f.home);
    const identity = restarted.capture(invocation, root)!;
    assert.equal(new DerivedMaterialStore(path.join(f.home, 'derived')).loadJob(id, identity, restarted, target), null);
    const policy = f.authority.policy()!;
    policy.revision++;
    policy.scope.excludedRoots = [root];
    writePrivateFile(f.policyFile, JSON.stringify(policy));
    f.authority.refresh();
    assert.ok('denied' in f.build());
    assert.deepEqual(fs.readFileSync(file), before);
  } finally {
    f.close();
  }
});

test('helper STATUS session replacement in place invalidates live and restarted derived material', () => {
  const f = fixture();
  try {
    f.grant();
    const review = path.join(f.directory, 'review-1.md');
    fs.writeFileSync(review, 'Verdict: accept\n\n## Finding: synthetic result');
    const helper = {
      ...f.status,
      slot: 'review-1',
      role: 'reviewer',
      session_id: 'original-helper',
      output_path: review,
      state: 'closed',
      output_written: true,
    };
    f.json(`jobs/${invocation}/.dispatch/review-1/STATUS.json`, helper);
    const envelope = f.build(f.adapter.subject(f.identity, target, { review: 'review-1.md' }));
    assert.ok(!('denied' in envelope));
    const store = new DerivedMaterialStore(path.join(f.home, 'derived'));
    const id = store.saveJob('Synthetic annotation.', envelope, f.authority, target);
    assert.ok(id);
    const file = path.join(f.directory, '.dispatch/review-1/STATUS.json'),
      ino = fs.statSync(file).ino;
    fs.writeFileSync(file, JSON.stringify({ ...helper, session_id: 'replacement-helper' }));
    assert.equal(fs.statSync(file).ino, ino);
    assert.equal(revalidateMaterials(envelope, f.authority, target), false);
    const restarted = new JobMaterialAuthority(f.home),
      identity = restarted.capture(invocation, root)!;
    assert.equal(new DerivedMaterialStore(path.join(f.home, 'derived')).loadJob(id, identity, restarted, target), null);
  } finally {
    f.close();
  }
});

test('readJobFile never reuses a pre-read ancestor after a symlink swap', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'job-read-ancestor-'));
  const parent = path.join(directory, 'source'),
    moved = path.join(directory, 'moved');
  fs.mkdirSync(parent);
  const file = path.join(parent, 'public.txt');
  fs.writeFileSync(file, 'Synthetic public material.');
  let swapped = false;
  const original = fs.readSync;
  const replacement = ((...args: Parameters<typeof fs.readSync>) => {
    const n = original(...args);
    if (!swapped) {
      swapped = true;
      fs.renameSync(parent, moved);
      fs.symlinkSync(moved, parent, 'dir');
    }
    return n;
  }) as typeof fs.readSync;
  t.mock.method(fs, 'readSync', replacement);
  syncBuiltinESMExports();
  try {
    assert.throws(() => readJobFile(file, 1024, jobReadBudget()), /unsafe_path|replaced/);
    assert.equal(swapped, true);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('explicit consent writes ignore even an exhausted ambient material scope', () => {
  const f = fixture();
  try {
    f.grant();
    const budget = jobReadBudget();
    budget.maxFiles = budget.maxBytes = budget.maxProbes = 0;
    budget.deadline = performance.now() - 1;
    const before = { ...jobFileMetrics.consentWrite };
    withJobBudget(budget, () => f.authority.setConsent(target.recipientId, 'deny', 2000));
    assert.equal(budget.files, 0);
    assert.equal(budget.bytes, 0);
    assert.equal(budget.probes, 0);
    assert.equal(jobFileMetrics.consentWrite.checks - before.checks, 1);
    assert.equal(jobFileMetrics.consentWrite.label, 'consent-write');
    assert.equal(f.authority.policy()!.grants[0].decision, 'deny');
  } finally {
    f.close();
  }
});

test('one supplied budget charges authority STATUS bodies and every path/fstat probe', () => {
  const f = fixture();
  try {
    f.grant();
    f.envelope();
    const before = { ...f.authority.reads };
    fs.appendFileSync(path.join(f.directory, 'STATUS.json'), '\n');
    const empty = jobReadBudget();
    empty.maxFiles = 0;
    empty.maxBytes = 0;
    const probes = jobFileMetrics.probes;
    const first = f.attempt(f.subject(), f.authority, empty);
    assert.deepEqual(first, { pending: true, reason: 'budget' });
    assert.equal(empty.files, 0);
    assert.equal(empty.bytes, 0);
    assert.equal(f.authority.reads.files, before.files);
    assert.equal(f.authority.reads.bytes, before.bytes);
    assert.equal(empty.probes, jobFileMetrics.probes - probes);
    assert.ok(empty.probes! > 0);
    const full = jobReadBudget();
    const result = f.attempt(f.subject(), f.authority, full);
    assert.ok(!('pending' in result) && !('denied' in result));
    assert.equal(full.files, 1);
    assert.equal(full.bytes, fs.statSync(path.join(f.directory, 'STATUS.json')).size);
    assert.equal(full.probes! + empty.probes!, jobFileMetrics.probes - probes);
  } finally {
    f.close();
  }
});

test('one-file slices resume completed reductions without rereading them and match an unbounded build', () => {
  const f = fixture();
  const baselineAdapter = new JobPublicOutputAdapter(f.authority);
  try {
    f.grant();
    const baseline = f.build(baselineAdapter.subject(f.identity, target));
    assert.ok(!('denied' in baseline));
    let result: ReturnType<typeof f.attempt> | undefined,
      pending = 0;
    for (let n = 0; n < 8; n++) {
      const budget = jobReadBudget();
      budget.maxFiles = 1;
      result = f.attempt(f.adapter.subject(f.identity, target, {}, budget));
      assert.ok(budget.files <= 1);
      if (!('pending' in result)) break;
      pending++;
    }
    assert.ok(pending >= 2);
    assert.ok(result && !('pending' in result) && !('denied' in result));
    assert.deepEqual(result.fragments, baseline.fragments);
    assert.equal(result.fingerprint, baseline.fingerprint);
    assert.deepEqual(result.coverage, baseline.coverage);
    assert.equal(f.adapter.reads.files, 3); // Brief, header, tail exactly once each; authority owns STATUS.
  } finally {
    baselineAdapter.dispose();
    f.close();
  }
});

test('64-probe opportunities defer and then finish without restarting completed sources', async () => {
  const f = fixture();
  let model: SmallModel | undefined;
  try {
    f.grant();
    f.json(`jobs/${invocation}/STATUS.json`, { ...f.status, output_written: true });
    fs.mkdirSync(path.join(f.directory, 'qa'));
    fs.writeFileSync(path.join(f.directory, 'qa/q1.md'), 'Synthetic question one.');
    fs.writeFileSync(path.join(f.directory, 'qa/q2.md'), 'Synthetic question two.');
    fs.writeFileSync(
      path.join(f.directory, 'report.md'),
      'Synthetic report head.' + 'x'.repeat(20000) + 'Synthetic report tail.'
    );
    fs.writeFileSync(path.join(f.directory, 'review-1.md'), 'Verdict: accept\n\n## Finding: synthetic parser');
    f.json(`jobs/${invocation}/.dispatch/review-1/STATUS.json`, {
      ...f.status,
      slot: 'review-1',
      role: 'reviewer',
      session_id: 'synthetic-helper',
      output_path: path.join(f.directory, 'review-1.md'),
      output_written: true,
    });
    const selection = { report: true, review: 'review-1.md', questions: ['qa/q1.md', 'qa/q2.md'] };
    let result: ReturnType<typeof f.attempt> | undefined,
      pending = 0,
      coldProbes = 0;
    for (let n = 0; n < 20; n++) {
      const budget = jobReadBudget();
      budget.maxProbes = 64;
      const before = jobFileMetrics.probes;
      result = f.attempt(f.adapter.subject(f.identity, target, selection, budget));
      coldProbes += budget.probes!;
      assert.ok(budget.probes! <= 64);
      assert.equal(budget.probes, jobFileMetrics.probes - before);
      if (!('pending' in result)) break;
      pending++;
    }
    assert.ok(pending > 0);
    assert.ok(result && !('pending' in result) && !('denied' in result));
    assert.ok(result.fragments.some((fragment) => fragment.provenance[0].field === 'public_output'));
    const warm = jobReadBudget();
    warm.maxProbes = 64;
    const unchanged = f.attempt(f.adapter.subject(f.identity, target, selection, warm));
    assert.ok(!('pending' in unchanged) && !('denied' in unchanged));
    console.log(
      `normal all-artifact admission coldProbes=${coldProbes} warmProbes=${warm.probes} deferredOpportunities=${pending}`
    );
    let calls = 0;
    let shouldRevoke = false,
      attempted = false;
    let writerError: unknown;
    model = new SmallModel({
      account: 'synthetic-account',
      dir: null,
      fetch: async () => {
        calls++;
        return response();
      },
      onChange: () => {
        if (shouldRevoke && !attempted && (model?.diagnostics().queued ?? 0) > 0) {
          attempted = true;
          try {
            f.authority.setConsent(target.recipientId, 'deny', 2000);
          } catch (error) {
            writerError = error;
          }
        }
      },
    });
    model.configure({ backend: 'api', api });
    const admission = jobReadBudget();
    admission.maxProbes = 64;
    const handle = model.submitJob({
      ...f.request(f.adapter.subject(f.identity, target, selection)).jobMaterials,
      budget: admission,
    });
    assert.equal(handle.status, 'queued');
    assert.equal((await handle.result).ok, true);
    assert.equal(calls, 1);
    assert.ok(admission.probes! <= 64);
    console.log(`normal warm SmallModel admission probes=${admission.probes} cap=64`);
    shouldRevoke = true;
    const controlBefore = { ...jobFileMetrics.consentWrite },
      revokeBudget = jobReadBudget();
    revokeBudget.maxProbes = 64;
    const revoked = await model.submitJob({
      ...f.request(f.adapter.subject(f.identity, target, selection)).jobMaterials,
      budget: revokeBudget,
    }).result;
    assert.equal(attempted, true);
    assert.equal(writerError, undefined);
    assert.ok(!revoked.ok && !('pending' in revoked));
    assert.equal(revoked.error, 'requires_authorization');
    assert.equal('text' in revoked, false);
    assert.equal(calls, 1);
    assert.equal(revokeBudget.probes, admission.probes);
    assert.equal(f.authority.policy()!.grants[0].decision, 'deny');
    const controlProbes = jobFileMetrics.consentWrite.probes - controlBefore.probes;
    assert.ok(controlProbes <= JOB_CONSENT_WRITE_LIMITS.maxProbes);
    assert.equal(jobFileMetrics.consentWrite.ioErrors - controlBefore.ioErrors, 0);
    console.log(
      `consent-write materialProbes=${revokeBudget.probes} controlProbes=${controlProbes} files=${jobFileMetrics.consentWrite.files - controlBefore.files} bytes=${jobFileMetrics.consentWrite.bytes - controlBefore.bytes} extraTransport=0`
    );
  } finally {
    model?.cancelAll();
    await model?.flushTelemetry();
    f.close();
  }
});

test('deep paths expose a 64-probe pending and complete with a larger admission budget', () => {
  const f = fixture(43);
  try {
    f.grant();
    const small = jobReadBudget();
    small.maxProbes = 64;
    assert.deepEqual(f.attempt(f.adapter.subject(f.identity, target, {}, small)), { pending: true, reason: 'budget' });
    const large = jobReadBudget();
    const result = f.attempt(f.adapter.subject(f.identity, target, {}, large));
    assert.ok(!('pending' in result) && !('denied' in result));
    const warm = jobReadBudget();
    const next = f.attempt(f.adapter.subject(f.identity, target, {}, warm));
    assert.ok(!('pending' in next) && !('denied' in next));
    console.log(
      `deep admission coldProbes=${small.probes! + large.probes!} completionProbes=${large.probes} warmProbes=${warm.probes} cap64=pending`
    );
  } finally {
    f.close();
  }
});

test('revocation or source replacement between pending attempts never resumes the old reduction', () => {
  for (const change of ['revoke', 'replace']) {
    const f = fixture();
    try {
      f.grant();
      const small = jobReadBudget();
      small.maxFiles = 2;
      assert.deepEqual(f.attempt(f.adapter.subject(f.identity, target, {}, small)), {
        pending: true,
        reason: 'budget',
      });
      if (change === 'revoke') f.authority.setConsent(target.recipientId, 'deny', 2000);
      else {
        fs.renameSync(f.session, f.session + '.old');
        f.sessionRows();
        fs.writeFileSync(path.join(f.directory, 'brief.md'), '## Goal\nReplacement episode goal.\n');
      }
      const before = { ...f.adapter.reads };
      const old = f.attempt(f.adapter.subject(f.identity, target));
      assert.deepEqual(old, { denied: true, reason: 'requires_authorization' });
      assert.deepEqual(f.adapter.reads, before);
      if (change === 'replace') {
        const identity = f.authority.capture(invocation, root)!;
        assert.notEqual(identity.episode, f.identity.episode);
        const next = f.build(f.adapter.subject(identity, target));
        assert.ok(!('denied' in next));
        assert.ok(next.fragments.some((fragment) => fragment.text.includes('Replacement episode goal.')));
        assert.ok(!next.fragments.some((fragment) => fragment.text.includes('Repair the public parser.')));
      }
    } finally {
      f.close();
    }
  }
});

test('direct Pi discovery resumes its bounded directory cursor and charges entry reads', () => {
  const f = fixture();
  try {
    const { pi_dispatch: _dispatch, ...receipt } = f.receipt;
    f.json(`jobs/${invocation}/receipt.json`, receipt);
    fs.unlinkSync(path.join(f.directory, 'STATUS.json'));
    const before = f.authority.reads.entries;
    const first = jobReadBudget();
    first.maxEntries = 1;
    assert.throws(() => f.authority.capture(invocation, root, first), /job_budget_pending/);
    assert.equal(first.entries, 1);
    const second = jobReadBudget();
    second.maxEntries = 1;
    assert.ok(f.authority.capture(invocation, root, second));
    assert.equal(second.entries, 1);
    assert.equal(f.authority.reads.entries - before, 2); // One entry and EOF, not the first entry twice.
  } finally {
    f.close();
  }
});

test('job-specific pending costs no compose/hash/cache/transport/telemetry or hourly cap', async (t) => {
  const f = fixture(),
    dir = path.join(f.home, 'model');
  fs.mkdirSync(dir);
  let compose = 0,
    calls = 0,
    hashes = 0,
    materialHashes = 0,
    caches = 0;
  const model = f.model(async () => {
    calls++;
    return response();
  }, dir);
  model.configure({ hourlyCap: 1 });
  try {
    f.grant();
    const telemetry = model.telemetry(1000),
      diagnostics = model.diagnostics(),
      files = fs.readdirSync(dir);
    const originalHash = crypto.createHash;
    t.mock.method(crypto, 'createHash', (...args: Parameters<typeof crypto.createHash>) => {
      hashes++;
      const hash = originalHash(...args),
        update = hash.update.bind(hash);
      t.mock.method(hash, 'update', (data: crypto.BinaryLike, encoding?: crypto.Encoding) => {
        if (
          typeof data === 'string' &&
          [
            'Repair the public parser.',
            'Public parser progress.',
            'src/parser.ts',
            'Synthetic quoted material',
            'synthetic-job',
          ].some((marker) => data.includes(marker))
        )
          materialHashes++;
        return typeof data === 'string' ? update(data, encoding ?? 'utf8') : update(data);
      });
      return hash;
    });
    syncBuiltinESMExports();
    const originalCache = ModelRuntimeStore.prototype.cache;
    t.mock.method(ModelRuntimeStore.prototype, 'cache', function (this: ModelRuntimeStore) {
      caches++;
      return originalCache.call(this);
    });
    for (let i = 0; i < 2; i++) {
      const budget = jobReadBudget();
      budget.maxProbes = 0;
      const handle = model.submitJob({
        ...f.request().jobMaterials,
        budget,
        compose: (envelope) => {
          compose++;
          return {
            feature: 'job_card',
            system: '',
            prompt: envelope.fragments.map((fragment) => fragment.text).join('\n'),
          };
        },
      });
      assert.equal(handle.status, 'pending');
      assert.deepEqual(await handle.result, { ok: false, pending: true, reason: 'budget' });
      assert.equal(budget.probes, 0);
    }
    assert.deepEqual({ compose, calls, hashes, caches }, { compose: 0, calls: 0, hashes: 0, caches: 0 });
    const small = jobReadBudget();
    small.maxFiles = 1;
    const deferred = model.submitJob({
      ...f.request().jobMaterials,
      budget: small,
      compose: () => {
        compose++;
        throw new Error('pending compose');
      },
    });
    assert.deepEqual(await deferred.result, { ok: false, pending: true, reason: 'budget' });
    assert.deepEqual(
      { compose, calls, materialHashes, caches },
      { compose: 0, calls: 0, materialHashes: 0, caches: 0 }
    );
    assert.ok(hashes > 0); // q5 permits only destination-metadata fingerprints before a grant.
    assert.deepEqual(model.telemetry(1000), telemetry);
    assert.deepEqual(model.diagnostics(), diagnostics);
    assert.deepEqual(fs.readdirSync(dir), files);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal((await model.submitJob(f.request().jobMaterials).result).ok, true);
    assert.equal(calls, 1);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    model.cancelAll();
    await model.flushTelemetry();
    f.close();
  }
});

test('unchanged frozen material refreshes reuse the envelope with zero content hashing', (t) => {
  const f = fixture();
  try {
    f.grant();
    const first = f.envelope(),
      before = { ...f.adapter.reads },
      authority = { ...f.authority.reads };
    let hashes = 0;
    const originalHash = crypto.createHash;
    t.mock.method(crypto, 'createHash', (...args: Parameters<typeof crypto.createHash>) => {
      hashes++;
      return originalHash(...args);
    });
    syncBuiltinESMExports();
    for (let n = 0; n < 5; n++) {
      const current = f.envelope();
      assert.equal(current, first);
      assert.equal(revalidateMaterials(current, f.authority, target), true);
    }
    assert.equal(hashes, 0);
    assert.deepEqual(f.adapter.reads, before);
    assert.deepEqual(f.authority.reads, authority);
    assert.equal(Object.isFrozen(first.fragments[0].provenance[0]), true);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.close();
  }
});

test('synchronous compose and queued/running lifecycle revocations cannot cross the send fence', async () => {
  for (const phase of ['compose', 'queued', 'running']) {
    const f = fixture(),
      dir = path.join(f.home, 'model');
    let calls = 0,
      acted = false;
    const model = new SmallModel({
      account: 'synthetic-account',
      dir,
      fetch: async () => {
        calls++;
        return response();
      },
      onChange: () => {
        const diagnostics = model.diagnostics();
        if (
          !acted &&
          ((phase === 'queued' && diagnostics.queued > 0) || (phase === 'running' && diagnostics.running))
        ) {
          acted = true;
          f.authority.setConsent(target.recipientId, 'deny', 2000);
        }
      },
    });
    model.configure({ backend: 'api', api });
    try {
      f.grant();
      const plan = f.request().jobMaterials;
      const handle = model.submitJob({
        ...plan,
        compose: (envelope) => {
          if (phase === 'compose') {
            acted = true;
            f.authority.setConsent(target.recipientId, 'deny', 2000);
          }
          return plan.compose(envelope);
        },
      });
      const result = await handle.result;
      assert.equal(acted, true);
      assert.equal(result.ok, false);
      assert.ok(!('pending' in result));
      assert.equal(calls, 0);
      await tick();
      const store = new ModelRuntimeStore(dir);
      assert.equal(store.calls().length, phase === 'running' ? 1 : 0);
      assert.equal(store.cache().size, 0);
      const claims = path.join(dir, 'claims.json');
      if (fs.existsSync(claims)) assert.deepEqual(JSON.parse(fs.readFileSync(claims, 'utf8')), {});
    } finally {
      model.cancelAll();
      await model.flushTelemetry();
      f.close();
    }
  }
});

test('an external-style atomic revoke inside compose cannot consume a cached reply', async () => {
  const f = fixture(),
    dir = path.join(f.home, 'model');
  let calls = 0;
  const model = f.model(async () => {
    calls++;
    return response();
  }, dir);
  try {
    f.grant();
    const base = f.request().jobMaterials;
    assert.equal((await model.submitJob(base).result).ok, true);
    await model.flushTelemetry();
    const cache = path.join(dir, 'materials-v1/replies/cache.json'),
      before = fs.readFileSync(cache);
    const policy = structuredClone(f.authority.policy()!);
    policy.revision++;
    policy.grants[0].decision = 'deny';
    const result = await model.submitJob({
      ...base,
      compose: (envelope) => {
        writePrivateFile(f.policyFile, JSON.stringify(policy));
        return base.compose(envelope);
      },
    }).result;
    assert.ok(!result.ok && !('pending' in result));
    assert.equal(result.error, 'requires_authorization');
    assert.equal(calls, 1);
    assert.deepEqual(fs.readFileSync(cache), before);
  } finally {
    model.cancelAll();
    await model.flushTelemetry();
    f.close();
  }
});

test('a telemetry clock callback cannot invalidate the final send fence', async () => {
  const f = fixture(),
    dir = path.join(f.home, 'model');
  let calls = 0,
    acted = false;
  let revoked = '';
  const model = new SmallModel({
    account: 'synthetic-account',
    dir,
    fetch: async () => {
      calls++;
      return response();
    },
    clock: () => {
      if (revoked && !acted && model.diagnostics().running) {
        acted = true;
        writePrivateFile(f.policyFile, revoked);
      }
      return Date.now();
    },
  });
  model.configure({ backend: 'api', api });
  try {
    f.grant();
    const policy = structuredClone(f.authority.policy()!);
    policy.revision++;
    policy.grants[0].decision = 'deny';
    revoked = JSON.stringify(policy);
    const result = await model.submitJob(f.request().jobMaterials).result;
    assert.ok(!result.ok && !('pending' in result));
    assert.equal(result.error, 'requires_authorization');
    assert.equal(acted, true);
    assert.equal(calls, 0);
    assert.equal(new ModelRuntimeStore(dir).calls().length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8')), {});
  } finally {
    model.cancelAll();
    await model.flushTelemetry();
    f.close();
  }
});

test('job worker cache hits are free and revocation before their microtask releases no cached text', async () => {
  const f = fixture(),
    dir = path.join(f.home, 'model');
  let calls = 0;
  const model = f.model(async () => {
    calls++;
    return response();
  }, dir);
  try {
    f.grant();
    assert.equal((await model.submitJob(f.request().jobMaterials).result).ok, true);
    await model.flushTelemetry();
    const store = new ModelRuntimeStore(dir),
      before = { ...jobFileMetrics.dispatch };
    const hit = model.submitJob(f.request().jobMaterials);
    assert.equal(hit.status, 'queued');
    const reply = await hit.result;
    assert.equal(reply.ok && reply.cached, true);
    assert.equal(calls, 1);
    assert.equal(store.calls().length, 1);
    console.log(
      `job cache-hit worker checks=${jobFileMetrics.dispatch.checks - before.checks} files=${jobFileMetrics.dispatch.files - before.files} bytes=${jobFileMetrics.dispatch.bytes - before.bytes} probes=${jobFileMetrics.dispatch.probes - before.probes} newCharge=0 transport=0`
    );
    const cache = path.join(dir, 'materials-v1/replies/cache.json'),
      bytes = fs.readFileSync(cache);
    const revoked = model.submitJob(f.request().jobMaterials);
    f.authority.setConsent(target.recipientId, 'deny', 2000);
    const denied = await revoked.result;
    assert.ok(!denied.ok && !('pending' in denied));
    assert.equal(denied.error, 'requires_authorization');
    assert.equal('text' in denied, false);
    await tick();
    assert.equal(calls, 1);
    assert.equal(store.calls().length, 1);
    assert.deepEqual(fs.readFileSync(cache), bytes);
  } finally {
    model.cancelAll();
    await model.flushTelemetry();
    f.close();
  }
});

test('worker validation cannot prune a cached reply after its callback revokes consent', async () => {
  const f = fixture(),
    dir = path.join(f.home, 'model');
  let calls = 0;
  const model = f.model(async () => {
    calls++;
    return response();
  }, dir);
  try {
    f.grant();
    const base = f.request().jobMaterials;
    assert.equal((await model.submitJob(base).result).ok, true);
    await model.flushTelemetry();
    const cache = path.join(dir, 'materials-v1/replies/cache.json'),
      bytes = fs.readFileSync(cache);
    const denied = await model.submitJob({
      ...base,
      compose: (envelope) => ({
        ...base.compose(envelope),
        validateResponse: () => {
          f.authority.setConsent(target.recipientId, 'deny', 2000);
          return false;
        },
      }),
    }).result;
    assert.ok(!denied.ok && !('pending' in denied));
    assert.equal(denied.error, 'requires_authorization');
    assert.equal(calls, 1);
    assert.deepEqual(fs.readFileSync(cache), bytes);
    assert.equal(new ModelRuntimeStore(dir).calls().length, 1);
  } finally {
    model.cancelAll();
    await model.flushTelemetry();
    f.close();
  }
});

test('natural late expiry is job pending without cap/cache/failure effects, and fresh-budget retry succeeds', async () => {
  const f = fixture(),
    dir = path.join(f.home, 'model');
  let calls = 0,
    composed = 0;
  const model = f.model(async () => {
    calls++;
    return response();
  }, dir);
  model.configure({ hourlyCap: 1 });
  try {
    f.grant();
    const budget = jobReadBudget();
    budget.deadline = performance.now() + 1000;
    const base = f.request().jobMaterials,
      before = model.telemetry(1000);
    const result = await model.submitJob({
      ...base,
      budget,
      compose: (envelope) => {
        composed++;
        while (performance.now() <= budget.deadline!) {
          /* Real monotonic deadline crossing. */
        }
        return base.compose(envelope);
      },
    }).result;
    assert.deepEqual(result, { ok: false, pending: true, reason: 'budget' });
    assert.equal(composed, 1);
    assert.equal(calls, 0);
    const store = new ModelRuntimeStore(dir);
    assert.equal(store.calls().length, 0);
    assert.equal(store.cache().size, 0);
    assert.deepEqual(model.telemetry(1000), before);
    assert.equal(model.diagnostics().lastFailure, undefined);
    assert.equal((await model.submitJob({ ...base, budget: jobReadBudget() }).result).ok, true);
    assert.equal(calls, 1);
    assert.equal(store.calls().length, 1);
  } finally {
    model.cancelAll();
    await model.flushTelemetry();
    f.close();
  }
});

test('a real revocation found during compose wins over simultaneous deadline expiry', async () => {
  const f = fixture(),
    dir = path.join(f.home, 'model');
  let calls = 0;
  const model = f.model(async () => {
    calls++;
    return response();
  }, dir);
  try {
    f.grant();
    const budget = jobReadBudget();
    budget.deadline = performance.now() + 1000;
    const base = f.request().jobMaterials;
    const result = await model.submitJob({
      ...base,
      budget,
      compose: (envelope) => {
        f.authority.setConsent(target.recipientId, 'deny', 2000);
        while (performance.now() <= budget.deadline!) {
          /* Natural late expiry after the real durable revoke. */
        }
        return base.compose(envelope);
      },
    }).result;
    assert.ok(!result.ok && !('pending' in result));
    assert.equal(result.error, 'requires_authorization');
    assert.equal(calls, 0);
    assert.equal(new ModelRuntimeStore(dir).calls().length, 0);
  } finally {
    model.cancelAll();
    await model.flushTelemetry();
    f.close();
  }
});

test('cancel or revoke between job submit and its microtask sends nothing', async () => {
  for (const action of ['cancel', 'revoke']) {
    const f = fixture(),
      dir = path.join(f.home, 'model');
    let calls = 0;
    const model = f.model(async () => {
      calls++;
      return response();
    }, dir);
    try {
      f.grant();
      const handle = model.submitJob(f.request().jobMaterials);
      if (action === 'cancel') handle.cancel();
      else f.authority.setConsent(target.recipientId, 'deny', 2000);
      assert.equal((await handle.result).ok, false);
      await tick();
      assert.equal(calls, 0);
      assert.equal(new ModelRuntimeStore(dir).calls().length, 0);
    } finally {
      model.cancelAll();
      await model.flushTelemetry();
      f.close();
    }
  }
});

test('settlement observers revoke transport results and worker cache hits before text publication', async () => {
  for (const cached of [false, true])
    for (const observer of ['onChange', 'idle', 'listener', 'external']) {
      const f = fixture(),
        dir = path.join(f.home, 'model');
      let calls = 0,
        revoked = false,
        armed = false;
      const peer = observer === 'external' ? new JobMaterialAuthority(f.home) : undefined;
      let handle: ReturnType<SmallModel['submitJob']> | undefined;
      const revoke = () => {
        if (
          armed &&
          !revoked &&
          handle?.status === 'settled' &&
          model.diagnostics().queued === 0 &&
          (observer !== 'idle' || !model.diagnostics().running)
        ) {
          revoked = true;
          (peer ?? f.authority).setConsent(target.recipientId, 'deny', 2000);
        }
      };
      const model = new SmallModel({
        account: 'synthetic-account',
        dir,
        fetch: async () => {
          calls++;
          return response();
        },
        onChange: () => {
          if (observer !== 'listener') revoke();
        },
      });
      model.configure({ backend: 'api', api });
      try {
        f.grant();
        if (cached) {
          assert.equal((await model.submitJob(f.request().jobMaterials).result).ok, true);
          await model.flushTelemetry();
        }
        armed = true;
        handle = model.submitJob(f.request().jobMaterials);
        const unsubscribe = observer === 'listener' ? handle.subscribe?.(revoke) : undefined;
        const result = await handle.result;
        unsubscribe?.();
        assert.equal(revoked, true);
        assert.ok(!result.ok && !('pending' in result));
        assert.equal(result.error, 'requires_authorization');
        assert.equal('text' in result, false);
        assert.equal(f.authority.policy()!.grants[0].decision, 'deny');
        assert.equal(handle.jobMaterials, undefined);
        assert.equal(calls, 1);
        assert.equal(new ModelRuntimeStore(dir).calls().length, 1);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8')), {});
        assert.equal(
          fs.readdirSync(path.join(dir, '.coordination')).filter((name) => name.endsWith('.active')).length,
          0
        );
      } finally {
        model.cancelAll();
        await model.flushTelemetry();
        peer?.dispose();
        f.close();
      }
    }
});

test('telemetry-time revocation is fenced before successful job publication', async () => {
  const f = fixture(),
    dir = path.join(f.home, 'model');
  let calls = 0,
    revoked = false;
  let handle: ReturnType<SmallModel['submitJob']> | undefined;
  const model = new SmallModel({
    account: 'synthetic-account',
    dir,
    fetch: async () => {
      calls++;
      return response();
    },
    clock: () => {
      if (!revoked && calls === 1 && handle?.status === 'running' && handle.generatedAt !== undefined) {
        revoked = true;
        f.authority.setConsent(target.recipientId, 'deny', 2000);
      }
      return Date.now();
    },
  });
  model.configure({ backend: 'api', api });
  try {
    f.grant();
    handle = model.submitJob(f.request().jobMaterials);
    const result = await handle.result;
    assert.equal(revoked, true);
    assert.ok(!result.ok && !('pending' in result));
    assert.equal(result.error, 'requires_authorization');
    assert.equal('text' in result, false);
    assert.equal(calls, 1);
  } finally {
    model.cancelAll();
    await model.flushTelemetry();
    f.close();
  }
});

test('settlement cancellation honors individual handles and cancelAll before publication', async () => {
  for (const all of [false, true]) {
    const f = fixture();
    let calls = 0,
      cancelled = false;
    let handle: ReturnType<SmallModel['submitJob']> | undefined;
    const model = new SmallModel({
      account: 'synthetic-account',
      dir: null,
      fetch: async () => {
        calls++;
        return response();
      },
      onChange: () => {
        if (!cancelled && handle?.status === 'settled' && (!all || !model.diagnostics().running)) {
          cancelled = true;
          if (all) model.cancelAll();
          else handle.cancel();
        }
      },
    });
    model.configure({ backend: 'api', api });
    try {
      f.grant();
      handle = model.submitJob(f.request().jobMaterials);
      const result = await handle.result;
      assert.equal(cancelled, true);
      assert.ok(!result.ok && !('pending' in result));
      assert.equal(result.cancelled, true);
      assert.equal('text' in result, false);
      assert.equal(calls, 1);
    } finally {
      model.cancelAll();
      await model.flushTelemetry();
      f.close();
    }
  }
});

test('post-reserve budget exhaustion before running cleans ownership and permits same-input retry', async () => {
  const f = fixture(),
    dir = path.join(f.home, 'model');
  let calls = 0,
    exhausted = false,
    runningEvents = 0;
  const before = { ...jobFileMetrics.dispatch };
  const model = new SmallModel({
    account: 'synthetic-account',
    dir,
    clock: () => {
      if (!exhausted && hasJobBudget() && currentJobBudget().maxProbes === JOB_DISPATCH_FENCE_LIMITS.maxProbes) {
        exhausted = true;
        let bounded = false;
        try {
          for (let n = 0; n < 300; n++) {
            invalidateJobPaths();
            f.authority.policy();
          }
        } catch (error) {
          assert.ok(error instanceof JobBudgetPending);
          bounded = true;
        }
        assert.equal(bounded, true);
      }
      return Date.now();
    },
    fetch: async () => {
      calls++;
      return response();
    },
    onChange: () => {
      if (model.diagnostics().running) runningEvents++;
    },
  });
  model.configure({ backend: 'api', api, hourlyCap: 2 });
  try {
    f.grant();
    const pending = await model.submitJob(f.request().jobMaterials).result;
    assert.deepEqual(pending, { ok: false, pending: true, reason: 'budget' });
    assert.equal(exhausted, true);
    assert.equal(runningEvents, 0);
    assert.equal(calls, 0);
    const store = new ModelRuntimeStore(dir);
    assert.equal(store.calls().length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8')), {});
    assert.equal(fs.readdirSync(path.join(dir, '.coordination')).filter((name) => name.endsWith('.active')).length, 0);
    assert.equal(jobFileMetrics.dispatch.pendingAfterReserve - before.pendingAfterReserve, 1);
    assert.equal(jobFileMetrics.dispatch.pendingBeforeReserve - before.pendingBeforeReserve, 0);
    assert.equal((await model.submitJob(f.request().jobMaterials).result).ok, true);
    assert.equal(calls, 1);
    assert.equal(store.calls().length, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8')), {});
    assert.equal(fs.readdirSync(path.join(dir, '.coordination')).filter((name) => name.endsWith('.active')).length, 0);
  } finally {
    model.cancelAll();
    await model.flushTelemetry();
    f.close();
  }
});

test('post-reserve exceptions release ownership before failing closed', async () => {
  const f = fixture(),
    dir = path.join(f.home, 'model');
  let calls = 0,
    failed = false;
  const model = new SmallModel({
    account: 'synthetic-account',
    dir,
    clock: () => {
      if (!failed && fs.existsSync(path.join(dir, 'calls.json')) && !model.diagnostics().running) {
        failed = true;
        throw new Error('synthetic clock failure after reserve');
      }
      return Date.now();
    },
    fetch: async () => {
      calls++;
      return response();
    },
  });
  model.configure({ backend: 'api', api, hourlyCap: 2 });
  try {
    f.grant();
    const result = await model.submitJob(f.request().jobMaterials).result;
    assert.equal(failed, true);
    assert.ok(!result.ok && !('pending' in result));
    assert.equal(calls, 0);
    const store = new ModelRuntimeStore(dir);
    assert.equal(store.calls().length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8')), {});
    assert.equal(fs.readdirSync(path.join(dir, '.coordination')).filter((name) => name.endsWith('.active')).length, 0);
    assert.equal((await model.submitJob(f.request().jobMaterials).result).ok, true);
    assert.equal(calls, 1);
    assert.equal(store.calls().length, 2);
  } finally {
    model.cancelAll();
    await model.flushTelemetry();
    f.close();
  }
});

test('public job-handle checks honor caller budgets and fail closed without releasing material', async () => {
  const f = fixture();
  const model = f.model(async () => response());
  try {
    f.grant();
    const handle = model.submitJob(f.request().jobMaterials);
    assert.equal((await handle.result).ok, true);
    const empty = jobReadBudget();
    empty.maxFiles = empty.maxBytes = empty.maxProbes = 0;
    let before = jobFileMetrics.probes;
    const unproven = withJobBudget(empty, () => ({ allowed: handle.isAuthorized?.(), envelope: handle.jobMaterials }));
    assert.equal(unproven.allowed, false);
    assert.equal(unproven.envelope, undefined);
    assert.equal(empty.probes, jobFileMetrics.probes - before);
    assert.equal(empty.probes, 0);
    const sufficient = jobReadBudget();
    sufficient.maxProbes = JOB_DISPATCH_FENCE_LIMITS.maxProbes;
    before = jobFileMetrics.probes;
    const checked = withJobBudget(sufficient, () => ({
      allowed: handle.isAuthorized?.(),
      envelope: handle.jobMaterials,
    }));
    assert.equal(checked.allowed, true);
    assert.equal(checked.envelope?.kind, 'job');
    assert.ok(sufficient.probes! > 0);
    assert.equal(sufficient.probes, jobFileMetrics.probes - before);
    // The direct authority seam still exposes typed pending when P3b needs the distinction.
    withJobBudget(empty, () =>
      assert.throws(() => revalidateMaterials(checked.envelope!, f.authority, target), JobBudgetPending)
    );
    const dispatchBefore = { ...jobFileMetrics.dispatch };
    before = jobFileMetrics.probes;
    assert.equal(handle.isAuthorized?.(), true);
    assert.ok(handle.jobMaterials);
    const standaloneProbes = jobFileMetrics.probes - before;
    assert.ok(standaloneProbes <= 2 * JOB_DISPATCH_FENCE_LIMITS.maxProbes);
    assert.equal(jobFileMetrics.dispatch.probes - dispatchBefore.probes, standaloneProbes);
    console.log(
      `public handle callerProbes=${sufficient.probes} actualProbes=${sufficient.probes} standaloneDispatchProbes=${standaloneProbes} exhaustedRelease=0`
    );
  } finally {
    model.cancelAll();
    await model.flushTelemetry();
    f.close();
  }
});

test('bounded dispatch deferral is labelled, releases claims and preserves only post-reserve charges', async () => {
  for (const persistent of [false, true]) {
    const f = fixture(),
      dir = persistent ? path.join(f.home, 'model') : null;
    let calls = 0,
      acted = false,
      exhausted = false;
    let handle: ReturnType<SmallModel['submitJob']> | undefined;
    const before = { ...jobFileMetrics.dispatch };
    const model = new SmallModel({
      account: 'synthetic-account',
      dir,
      fetch: async () => {
        calls++;
        return response();
      },
      onChange: () => {
        if (acted || !model.diagnostics().running || !handle) return;
        acted = true;
        for (let n = 0; n < JOB_DISPATCH_FENCE_LIMITS.maxProbes; n++) {
          f.authority.refresh(); // Real invalidation boundary; repeated checks in one phase legitimately reuse metadata.
          if (handle.isAuthorized?.() === false) {
            // q13: public budget exhaustion is fail-closed, not thrown.
            exhausted = true;
            break;
          }
        }
      },
    });
    model.configure({ backend: 'api', api, hourlyCap: 1 });
    try {
      f.grant();
      handle = model.submitJob(f.request().jobMaterials);
      const result = await handle.result;
      assert.deepEqual(result, { ok: false, pending: true, reason: 'budget' });
      assert.equal(exhausted, true);
      assert.equal(calls, 0);
      assert.equal(model.diagnostics().lastFailure, undefined);
      assert.equal(jobFileMetrics.dispatch.pendingAfterReserve - before.pendingAfterReserve, persistent ? 1 : 0);
      assert.equal(jobFileMetrics.dispatch.pendingBeforeReserve - before.pendingBeforeReserve, persistent ? 0 : 1);
      assert.ok(jobFileMetrics.dispatch.probes - before.probes <= JOB_DISPATCH_FENCE_LIMITS.maxProbes);
      console.log(
        `dispatch ${persistent ? 'post-reserve' : 'pre-reserve'} pending checks=${jobFileMetrics.dispatch.checks - before.checks} files=${jobFileMetrics.dispatch.files - before.files} bytes=${jobFileMetrics.dispatch.bytes - before.bytes} probes=${jobFileMetrics.dispatch.probes - before.probes}`
      );
      if (dir) {
        const store = new ModelRuntimeStore(dir);
        assert.equal(store.calls().length, 1);
        assert.equal(store.cache().size, 0);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8')), {});
      } else {
        const retryBefore = { ...jobFileMetrics.dispatch };
        model.configure({ backend: 'api', api, hourlyCap: 1 });
        assert.equal((await model.submitJob(f.request().jobMaterials).result).ok, true);
        assert.equal(calls, 1);
        console.log(
          `dispatch successful retry checks=${jobFileMetrics.dispatch.checks - retryBefore.checks} files=${jobFileMetrics.dispatch.files - retryBefore.files} bytes=${jobFileMetrics.dispatch.bytes - retryBefore.bytes} probes=${jobFileMetrics.dispatch.probes - retryBefore.probes}`
        );
      }
    } finally {
      model.cancelAll();
      await model.flushTelemetry();
      f.close();
    }
  }
});

test('consent locking: live/unknown owners are busy without mutation; dead owners allow revocation', () => {
  const f = fixture();
  try {
    f.grant();
    const lock = path.join(f.home, 'job-materials-v1', 'policy.lock');
    const before = fs.readFileSync(f.policyFile);
    for (const owner of [selfStamp(), { ...selfStamp(), pid_domain: 'synthetic-unknown-domain' }]) {
      writePrivateFile(lock, JSON.stringify(owner));
      const old = new Date(Date.now() - 61000);
      fs.utimesSync(lock, old, old);
      assert.throws(() => f.authority.setConsent(target.recipientId, 'deny', 2000), /consent_busy/);
      assert.deepEqual(fs.readFileSync(f.policyFile), before);
      assert.equal(fs.existsSync(lock), true);
      fs.unlinkSync(lock);
    }
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { selfStamp } from ${JSON.stringify(new URL('../../src/roles/pi-owned/runtime.js', import.meta.url).href)}; console.log(JSON.stringify(selfStamp()));`,
      ],
      { encoding: 'utf8', env: process.env, timeout: 10000 }
    );
    assert.equal(child.status, 0, child.stderr);
    writePrivateFile(lock, child.stdout.trim());
    f.authority.setConsent(target.recipientId, 'deny', 2000);
    assert.equal(f.authority.authorize(f.identity, target), null);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    f.close();
  }
});

test('consent locking: only stale malformed locks recover and a write error releases its own inode', () => {
  const f = fixture();
  try {
    f.grant();
    const lock = path.join(f.home, 'job-materials-v1', 'policy.lock');
    for (const contents of ['', '{']) {
      writePrivateFile(lock, contents);
      assert.throws(() => f.authority.setConsent(target.recipientId, 'deny', 2000), /consent_busy/);
      const old = new Date(Date.now() - 61000);
      fs.utimesSync(lock, old, old);
      f.authority.setConsent(target.recipientId, 'deny', 2000);
      assert.equal(fs.existsSync(lock), false);
      f.grant();
    }
    writePrivateFile(f.policyFile, '{');
    assert.throws(() => f.authority.setConsent(target.recipientId, 'deny', 2000), /invalid_policy/);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(fs.readFileSync(f.policyFile, 'utf8'), '{');
  } finally {
    f.close();
  }
});

test('consent locking: a stale second writer cannot resurrect a revoked recipient while granting another', () => {
  const f = fixture();
  try {
    f.grant();
    const second = new JobMaterialAuthority(f.home);
    assert.equal(second.policy()?.grants[0].decision, 'allow');
    f.authority.setConsent(target.recipientId, 'deny', 2000);
    second.setConsent(fingerprint('synthetic-other-recipient'), 'allow', 3000);
    assert.equal(second.policy()?.grants.find((g) => g.recipientId === target.recipientId)?.decision, 'deny');
    assert.equal(second.policy()?.revision, 3);
    assert.equal(f.authority.authorize(f.identity, target), null);
  } finally {
    f.close();
  }
});

test('job consent never widens host-bound panel credentials or changes the F4 explicit source path', async () => {
  const f = fixture();
  let calls = 0,
    extracted = 0;
  const model = new SmallModel({
    account: 'synthetic-account',
    env: { OPENAI_API_KEY: 'synthetic-key', MISTRAL_API_KEY: 'synthetic-other' },
    fetch: async () => {
      calls++;
      return response();
    },
  });
  model.configure({ backend: 'api', api: { base: api.base, model: api.model } });
  try {
    f.grant();
    const subject: JobMaterialSubject = {
      kind: 'job',
      identity: f.identity,
      read: () => {
        extracted++;
        return { fragments: [], coverage };
      },
    };
    assert.equal((await model.submit(f.request(subject)).result).ok, false);
    assert.equal(calls, 0);
    assert.equal(extracted, 0);
    const panel = modelHttpRequest(
      { base: api.base, model: api.model },
      { feature: 'job_card', system: '', prompt: '' },
      { OPENAI_API_KEY: 'synthetic-key' }
    );
    assert.ok('error' in panel);
    const source = modelHttpRequest(
      { ...api, sourceCredential: 'synthetic-f4-key' },
      { feature: 'digest', system: '', prompt: '' },
      {}
    );
    assert.ok(!('error' in source));
    assert.equal(source.headers.authorization, 'Bearer synthetic-f4-key');
  } finally {
    model.cancelAll();
    f.close();
  }
});
