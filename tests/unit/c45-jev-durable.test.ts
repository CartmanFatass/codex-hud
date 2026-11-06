import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { DurableJevLab, SimulatedJevReader, type SimulatedJevUnavailableReason } from '../fakes/jev-durable.js';
import { mvpOperationPolicy } from '../../src/core/execution.js';
import { displayNodeKey } from '../../src/core/observation.js';

const owner = 'synthetic-owner';
const input = (id = 'one', browser = 'synthetic-browser') => ({
  owner,
  browser,
  ref: { kind: 'jev' as const, provider: 'synthetic-provider', account: `synthetic-${id}`, key: `synthetic-${id}` },
  requestId: `synthetic-request-${id}`,
  requestFingerprint: `synthetic-fingerprint-${id}`,
});
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'jev-durable-')),
    path = join(root, 'lab.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, path };
}
function available(db: DurableJevLab | SimulatedJevReader) {
  const view = db.snapshot();
  assert.ok(view.availability === 'available');
  return view;
}
const job = (db: DurableJevLab | SimulatedJevReader, id = 'one') =>
  available(db).jobs.find((j) => j.ref.key === `synthetic-${id}`)!;
function unavailable(path: string, reason: SimulatedJevUnavailableReason, expectedStoreId?: string) {
  const reader = new SimulatedJevReader(path, expectedStoreId);
  const view = reader.snapshot();
  assert.deepEqual(view, {
    provenance: 'SIMULATED',
    availability: 'unavailable',
    storeId: expectedStoreId ?? null,
    revision: null,
    jobs: [],
    reason,
  });
  reader.close();
}

test('durable canonical identity, immutable requests and replay survive a real close/reopen', (t) => {
  const { path } = fixture(t),
    a = input();
  let db = DurableJevLab.create(path);
  const created = db.enqueue(a),
    storeId = db.snapshot().storeId;
  db.close();
  db = DurableJevLab.open(path, storeId);
  t.after(() => db.close());
  const reorder = { key: a.ref.key, account: a.ref.account, provider: a.ref.provider, kind: a.ref.kind };
  assert.deepEqual(db.enqueue({ ...a, ref: reorder }), { ...created, replay: true });
  assert.equal(db.snapshot().storeId, storeId);
  assert.equal(job(db).key, displayNodeKey({ kind: 'job', ref: a.ref }));
  for (const changed of [
    { owner: 'synthetic-other' },
    { browser: 'synthetic-other' },
    { requestId: 'synthetic-other' },
    { requestFingerprint: 'synthetic-other' },
    { ref: { ...a.ref, key: 'synthetic-other' } },
  ])
    assert.throws(() => db.enqueue({ ...a, ...changed }), /request_conflict/);
  db.enqueue({ ...input('two'), ref: { ...a.ref, account: 'synthetic-two' } });
  db.enqueue({ ...input('three'), ref: { kind: 'jev', provider: a.ref.provider, key: a.ref.key } });
  db.enqueue({ ...input('four'), ref: { ...a.ref, provider: 'synthetic-other-provider' } });
  assert.equal(new Set(db.snapshot().jobs.map((j) => j.key)).size, 4);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('consumed ticket is uncertain across reopen; timeout, loss and human attention never release', (t) => {
  const { path } = fixture(t),
    a = input(),
    b = input('two');
  let db = DurableJevLab.create(path);
  db.enqueue(a);
  db.enqueue(b);
  db.enqueue(input('three', 'synthetic-independent'));
  const storeId = db.snapshot().storeId;
  const ticket = db.consumeDispatch(owner, a.ref, job(db).revision);
  assert.equal(ticket.state, 'uncertain');
  db.close();
  db = DurableJevLab.open(path, storeId);
  t.after(() => db.close());
  assert.equal(job(db).dispatches, 1);
  assert.equal(job(db).generation, ticket.generation);
  assert.throws(() => db.consumeDispatch(owner, a.ref, job(db).revision), /no_retry/);
  assert.throws(() => db.consumeDispatch(owner, b.ref, job(db, 'two').revision), /browser_busy/);
  db.consumeDispatch(owner, input('three').ref, job(db, 'three').revision);
  for (const state of ['needs_human', 'uncertain', 'sent', 'uncertain'] as const) {
    db.observe(owner, a.ref, ticket.generation, job(db).revision, state);
    assert.ok(job(db).lease);
    assert.equal(job(db).reconciled, false);
    assert.throws(() => db.consumeDispatch(owner, b.ref, job(db, 'two').revision), /browser_busy/);
  }
  assert.throws(() => db.observe(owner, a.ref, ticket.generation, ticket.revision, 'sent'), /stale_revision/);
  assert.throws(
    () => db.observe(owner, a.ref, ticket.generation + 1, job(db).revision, 'sent'),
    /stale_or_foreign_lease/
  );
  assert.throws(() => db.observe('synthetic-foreign', a.ref, ticket.generation, job(db).revision, 'sent'), /not_owned/);
});

test('needs-human and unreconciled terminal observations survive close/reopen without releasing', (t) => {
  const { path } = fixture(t),
    a = input();
  let db = DurableJevLab.create(path);
  db.enqueue(a);
  const storeId = db.snapshot().storeId;
  const ticket = db.consumeDispatch(owner, a.ref, job(db).revision);
  for (const state of ['needs_human', 'answered'] as const) {
    db.observe(
      owner,
      a.ref,
      ticket.generation,
      job(db).revision,
      state,
      state === 'answered' ? 'synthetic-evidence' : undefined
    );
    const before = db.snapshot();
    db.close();
    db = DurableJevLab.open(path, storeId);
    assert.deepEqual(db.snapshot(), before);
    assert.ok(job(db).lease);
    assert.equal(job(db).answer, null);
    assert.throws(() => db.consumeDispatch(owner, a.ref, job(db).revision), /no_retry/);
  }
  db.close();
});

test('terminal evidence and row revision gate atomic release; old exact receipt cannot release a new holder', (t) => {
  const { path } = fixture(t),
    a = input(),
    b = input('two');
  let db = DurableJevLab.create(path);
  db.enqueue(a);
  db.enqueue(b);
  const storeId = db.snapshot().storeId;
  const ticket = db.consumeDispatch(owner, a.ref, job(db).revision);
  assert.throws(
    () => db.reconcile(owner, a.ref, ticket.generation, job(db).revision, 'answered', 'synthetic-evidence'),
    /outcome_mismatch/
  );
  db.observe(owner, a.ref, ticket.generation, job(db).revision, 'answered', 'synthetic-evidence');
  const revision = job(db).revision;
  assert.equal(job(db).answer, null);
  assert.ok(job(db).lease);
  for (const [outcome, evidence] of [
    ['failed', 'synthetic-evidence'],
    ['answered', 'synthetic-other'],
  ] as const)
    assert.throws(() => db.reconcile(owner, a.ref, ticket.generation, revision, outcome, evidence), /outcome_mismatch/);
  assert.throws(() => db.observe(owner, a.ref, ticket.generation, revision, 'uncertain'), /terminal_conflict/);
  assert.throws(
    () => db.reconcile(owner, a.ref, ticket.generation, revision - 1, 'answered', 'synthetic-evidence'),
    /stale_revision/
  );
  const receipt = db.reconcile(
    owner,
    a.ref,
    ticket.generation,
    revision,
    'answered',
    'synthetic-evidence',
    'synthetic-answer'
  );
  assert.equal(job(db).answer, 'synthetic-answer');
  assert.equal(job(db).lease, null);
  const next = db.consumeDispatch(owner, b.ref, job(db, 'two').revision);
  assert.ok(next.generation > ticket.generation);
  db.close();
  db = DurableJevLab.open(path, storeId);
  t.after(() => db.close());
  const before = db.snapshot();
  assert.deepEqual(
    db.reconcile(owner, a.ref, ticket.generation, revision, 'answered', 'synthetic-evidence', 'synthetic-answer'),
    { ...receipt, replay: true }
  );
  assert.deepEqual(db.snapshot(), before);
  assert.equal(job(db, 'two').lease?.generation, next.generation);
  assert.throws(
    () => db.reconcile(owner, a.ref, next.generation, revision, 'answered', 'synthetic-evidence', 'synthetic-answer'),
    /reconcile_conflict/
  );
  assert.throws(
    () =>
      db.reconcile(owner, a.ref, ticket.generation, revision, 'answered', 'synthetic-evidence', 'synthetic-changed'),
    /reconcile_conflict/
  );
  db.observe(owner, b.ref, next.generation, next.revision, 'failed', 'synthetic-failure');
  db.reconcile(owner, b.ref, next.generation, job(db, 'two').revision, 'failed', 'synthetic-failure');
  assert.equal(job(db, 'two').lease, null);
});

test('independent connections contend for one transaction, one ticket and one browser generation', (t) => {
  const { path } = fixture(t),
    a = input();
  const init = DurableJevLab.create(path);
  init.enqueue(a);
  const rev = job(init).revision,
    storeId = init.snapshot().storeId;
  init.close();
  const second = DurableJevLab.open(path, storeId);
  t.after(() => second.close());
  let blocked = false;
  const first = DurableJevLab.open(path, storeId, (point) => {
    if (point === 'before_commit') {
      assert.throws(() => second.consumeDispatch(owner, a.ref, rev), /locked|busy/);
      blocked = true;
    }
  });
  t.after(() => first.close());
  first.consumeDispatch(owner, a.ref, rev);
  assert.ok(blocked);
  assert.equal(job(second).dispatches, 1);
  assert.equal(job(second).generation, 1);
  assert.throws(() => second.consumeDispatch(owner, a.ref, rev), /stale_revision/);
  assert.throws(() => second.consumeDispatch(owner, a.ref, job(second).revision), /no_retry/);
});

for (const point of ['before_commit', 'after_commit'] as const) {
  test(`owned child crash ${point}: reopen preserves the actual committed boundary`, (t) => {
    const { root, path } = fixture(t),
      a = input();
    const db = DurableJevLab.create(path);
    db.enqueue(a);
    const revision = job(db).revision,
      storeId = db.snapshot().storeId;
    db.close();
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { DurableJevLab } from ${JSON.stringify(new URL('../fakes/jev-durable.js', import.meta.url).href)};
      const db = DurableJevLab.open(${JSON.stringify(path)}, ${JSON.stringify(storeId)}, point => { if (point === ${JSON.stringify(point)}) process.kill(process.pid, 'SIGKILL'); });
      db.consumeDispatch(${JSON.stringify(owner)}, ${JSON.stringify(a.ref)}, ${revision});
      process.exitCode = 99;
    `,
      ],
      { encoding: 'utf8', timeout: 10000, env: { HOME: root, HUD_HOME: root, TMPDIR: root, PATH: '/usr/bin:/bin' } }
    );
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    assert.equal(child.error, undefined);
    const reopened = DurableJevLab.open(path, storeId);
    t.after(() => reopened.close());
    const current = job(reopened);
    if (point === 'before_commit') {
      assert.equal(current.state, 'queued');
      assert.equal(current.dispatches, 0);
      assert.equal(current.lease, null);
      assert.equal(reopened.consumeDispatch(owner, a.ref, current.revision).generation, 1);
    } else {
      assert.equal(current.state, 'uncertain');
      assert.equal(current.dispatches, 1);
      assert.equal(current.lease?.generation, 1);
      assert.throws(() => reopened.consumeDispatch(owner, a.ref, current.revision), /no_retry/);
      reopened.observe(owner, a.ref, 1, current.revision, 'failed', 'synthetic-crash-reconciliation');
      reopened.reconcile(owner, a.ref, 1, job(reopened).revision, 'failed', 'synthetic-crash-reconciliation');
      assert.equal(job(reopened).lease, null);
    }
  });
}

test('read-only coherent snapshot, optional label and detached DTO; reading never creates or changes', (t) => {
  const { root, path } = fixture(t),
    a = input(),
    b = input('two');
  const db = DurableJevLab.create(path);
  t.after(() => db.close());
  db.enqueue({ ...a, label: 'synthetic-visible-label' });
  db.enqueue(b);
  const reader = new SimulatedJevReader(path, db.snapshot().storeId);
  t.after(() => reader.close());
  const rev = available(reader).revision;
  assert.equal(job(reader).holderLabel, undefined);
  db.consumeDispatch(owner, a.ref, job(db).revision);
  const view = available(reader);
  assert.equal(view.provenance, 'SIMULATED');
  assert.ok(view.revision > rev);
  assert.equal(view.jobs[1].holderLabel, 'synthetic-visible-label');
  assert.equal(view.jobs[1].lease?.key, view.jobs[0].key);
  view.jobs[0].ref.key = 'synthetic-mutation';
  view.jobs[0].lease!.owner = 'synthetic-mutation';
  assert.equal(job(reader).ref.key, a.ref.key);
  assert.equal(job(reader).lease?.owner, owner);
  const before = db.snapshot();
  reader.snapshot();
  assert.deepEqual(db.snapshot(), before);
  const missing = join(root, 'missing.sqlite');
  unavailable(missing, 'missing_store');
  assert.equal(existsSync(missing), false);
  assert.throws(() => DurableJevLab.open(missing));
  assert.equal(existsSync(missing), false);
  db.enqueue(input('three', 'synthetic-other'));
  db.consumeDispatch(owner, input('three').ref, job(db, 'three').revision);
  assert.equal(job(reader, 'three').holderLabel, undefined);
});

test('expected store identity rejects a different valid database for reader and writer without mutation', (t) => {
  const { root, path } = fixture(t),
    otherPath = join(root, 'other.sqlite');
  const first = DurableJevLab.create(path),
    second = DurableJevLab.create(otherPath);
  first.enqueue(input());
  second.enqueue(input());
  const a = first.snapshot(),
    b = second.snapshot();
  assert.notEqual(a.storeId, b.storeId);
  assert.throws(() => DurableJevLab.open(otherPath, a.storeId), /store_identity_mismatch/);
  unavailable(otherPath, 'store_identity_mismatch', a.storeId);
  const reader = new SimulatedJevReader(path, a.storeId),
    writer = DurableJevLab.open(path, a.storeId);
  assert.deepEqual(reader.snapshot(), a);
  assert.deepEqual(writer.snapshot(), a);
  assert.deepEqual(first.snapshot(), a);
  assert.deepEqual(second.snapshot(), b);
  reader.close();
  writer.close();
  first.close();
  second.close();
});

test('unknown formats and corrupt job/lease state fail closed without repair', (t) => {
  const { path } = fixture(t),
    a = input();
  const db = DurableJevLab.create(path);
  db.enqueue(a);
  db.consumeDispatch(owner, a.ref, job(db).revision);
  db.close();
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA user_version=99');
  assert.throws(() => DurableJevLab.open(path), /unsupported_format/);
  unavailable(path, 'unsupported_format');
  assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 99);
  raw.exec('PRAGMA user_version=1; PRAGMA application_id=0');
  assert.throws(() => DurableJevLab.open(path), /unsupported_format/);
  unavailable(path, 'unsupported_format');
  assert.equal(raw.prepare('PRAGMA application_id').get()?.application_id, 0);
  raw.exec('PRAGMA application_id=1246058060');
  const original = raw.prepare('SELECT payload FROM simulated_jev_store').get()!.payload as string;
  for (const change of [
    (d: any) => {
      d.leases = [];
    },
    (d: any) => {
      d.jobs[0].dispatches = 0;
    },
    (d: any) => {
      d.leases[0].generation++;
    },
    (d: any) => {
      d.jobs[0].owner = 'not-synthetic';
    },
    (d: any) => {
      d.generations[0].generation++;
    },
    (d: any) => {
      d.jobs.push(d.jobs[0]);
    },
  ]) {
    const data = JSON.parse(original);
    change(data);
    const payload = JSON.stringify(data);
    raw.prepare('UPDATE simulated_jev_store SET payload=?').run(payload);
    unavailable(path, 'corrupt_store');
    assert.throws(() => DurableJevLab.open(path), /jev_lab_/);
    assert.equal(raw.prepare('SELECT payload FROM simulated_jev_store').get()!.payload, payload);
  }
  raw.close();
});

test('corrupt singleton refuses reader, reopen and repeated dispatch attempts without changing the store', (t) => {
  const { path } = fixture(t),
    db = DurableJevLab.create(path),
    a = input();
  t.after(() => db.close());
  db.enqueue(a);
  const before = db.snapshot(),
    revision = job(db).revision;
  const reader = new SimulatedJevReader(path, before.storeId);
  t.after(() => reader.close());
  const raw = new DatabaseSync(path);
  t.after(() => raw.close());
  raw.exec(
    'PRAGMA ignore_check_constraints=ON; UPDATE simulated_jev_store SET singleton=2; PRAGMA ignore_check_constraints=OFF'
  );
  const corrupt = raw.prepare('SELECT * FROM simulated_jev_store').all();
  assert.equal(reader.snapshot().availability, 'unavailable');
  unavailable(path, 'corrupt_store', before.storeId);
  assert.throws(() => DurableJevLab.open(path, before.storeId), /malformed_store/);
  for (let attempt = 0; attempt < 2; attempt++)
    assert.throws(() => db.consumeDispatch(owner, a.ref, revision), /malformed_store/);
  assert.deepEqual(raw.prepare('SELECT * FROM simulated_jev_store').all(), corrupt);
  assert.equal(JSON.parse(corrupt[0].payload as string).jobs[0].dispatches, 0);
});

test('unexpected input fields cannot persist or forge derived metadata, with or without a holder', (t) => {
  const { path } = fixture(t),
    db = DurableJevLab.create(path),
    a = input();
  t.after(() => db.close());
  for (const extra of [{ holderLabel: 'synthetic-forged-label' }, { extra: 'non-synthetic-canary' }, { lease: null }]) {
    const before = db.snapshot();
    assert.throws(() => db.enqueue({ ...a, ...extra }), /invalid_input_fields/);
    assert.deepEqual(db.snapshot(), before);
  }
  db.enqueue(a);
  assert.equal(job(db).lease, null);
  assert.equal('holderLabel' in job(db), false);
  db.consumeDispatch(owner, a.ref, job(db).revision);
  const before = db.snapshot();
  assert.throws(
    () => db.enqueue({ ...input('two'), ...{ holderLabel: 'synthetic-forged-label', extra: 'non-synthetic-canary' } }),
    /invalid_input_fields/
  );
  assert.deepEqual(db.snapshot(), before);
  assert.equal('holderLabel' in job(db), false);
  assert.doesNotMatch(JSON.stringify(db.snapshot()), /forged|canary/);
});

test('persisted unknown fields fail closed for queued and unlabeled held jobs without leaking or repair', (t) => {
  const { path } = fixture(t),
    db = DurableJevLab.create(path),
    a = input();
  t.after(() => db.close());
  db.enqueue(a);
  const storeId = db.snapshot().storeId;
  const reader = new SimulatedJevReader(path, storeId);
  t.after(() => reader.close());
  const raw = new DatabaseSync(path);
  t.after(() => raw.close());
  for (const held of [false, true]) {
    if (held) db.consumeDispatch(owner, a.ref, job(db).revision);
    const original = raw.prepare('SELECT payload FROM simulated_jev_store').get()!.payload as string;
    for (const change of [
      (d: any) => {
        d.jobs[0].holderLabel = 'synthetic-forged-label';
      },
      (d: any) => {
        d.jobs[0].extra = 'non-synthetic-canary';
      },
      (d: any) => {
        d.jobs[0].ref.extra = 'non-synthetic-canary';
      },
      (d: any) => {
        d.extra = 'non-synthetic-canary';
      },
      ...(held
        ? [
            (d: any) => {
              d.leases[0].holderLabel = 'synthetic-forged-label';
            },
            (d: any) => {
              d.generations[0].extra = 'non-synthetic-canary';
            },
          ]
        : []),
    ]) {
      const data = JSON.parse(original);
      change(data);
      const corrupt = JSON.stringify(data);
      raw.prepare('UPDATE simulated_jev_store SET payload=?').run(corrupt);
      const view = reader.snapshot();
      assert.deepEqual(view, {
        provenance: 'SIMULATED',
        availability: 'unavailable',
        storeId,
        revision: null,
        jobs: [],
        reason: 'corrupt_store',
      });
      assert.doesNotMatch(JSON.stringify(view), /forged|canary/);
      unavailable(path, 'corrupt_store', storeId);
      assert.throws(() => DurableJevLab.open(path, storeId), /jev_lab_/);
      assert.equal(raw.prepare('SELECT payload FROM simulated_jev_store').get()!.payload, corrupt);
      raw.prepare('UPDATE simulated_jev_store SET payload=?').run(original);
    }
  }
});

test('reader availability explicitly reports busy, corruption, identity changes and closed state', (t) => {
  const { path } = fixture(t),
    db = DurableJevLab.create(path);
  db.enqueue(input());
  const before = db.snapshot();
  db.close();
  const reader = new SimulatedJevReader(path, before.storeId),
    raw = new DatabaseSync(path);
  t.after(() => {
    reader.close();
    raw.close();
  });
  assert.deepEqual(reader.snapshot(), before);
  raw.exec('BEGIN EXCLUSIVE');
  assert.deepEqual(reader.snapshot(), {
    provenance: 'SIMULATED',
    availability: 'unavailable',
    storeId: before.storeId,
    revision: null,
    jobs: [],
    reason: 'store_busy',
  });
  raw.exec('ROLLBACK');
  assert.deepEqual(reader.snapshot(), before);
  raw.prepare('UPDATE simulated_jev_store SET store_id=?').run('synthetic-store-00000000-0000-0000-0000-000000000000');
  const changed = reader.snapshot();
  assert.ok(changed.availability === 'unavailable');
  assert.equal(changed.reason, 'store_identity_mismatch');
  assert.deepEqual(changed.jobs, []);
  raw.prepare('UPDATE simulated_jev_store SET store_id=?').run(before.storeId);
  raw.exec('ALTER TABLE simulated_jev_store ADD COLUMN unexpected TEXT');
  const corrupt = reader.snapshot();
  assert.ok(corrupt.availability === 'unavailable');
  assert.equal(corrupt.reason, 'corrupt_store');
  assert.throws(() => DurableJevLab.open(path, before.storeId), /malformed_store/);
  reader.close();
  assert.deepEqual(reader.snapshot(), {
    provenance: 'SIMULATED',
    availability: 'unavailable',
    storeId: before.storeId,
    revision: null,
    jobs: [],
    reason: 'reader_closed',
  });
});

test('synthetic-only bounded input, private paths and unchanged production gates', (t) => {
  const { root, path } = fixture(t),
    db = DurableJevLab.create(path);
  t.after(() => db.close());
  assert.throws(() => db.enqueue({ ...input(), owner: 'actual-user' }), /invalid_input/);
  assert.throws(() => db.enqueue({ ...input(), ref: { ...input().ref, account: '' } }), /invalid_ref/);
  for (let i = 0; i < 128; i++) db.enqueue(input(`job-${i}`));
  assert.throws(() => db.enqueue(input('overflow')), /job_limit/);
  chmodSync(root, 0o755);
  unavailable(path, 'private_path_required');
  chmodSync(root, 0o700);
  for (const op of ['jev_send', 'browser_control'] as const)
    assert.deepEqual(mvpOperationPolicy(op), { allowed: false, reason: 'unsupported', dispatches: 0 });
});
