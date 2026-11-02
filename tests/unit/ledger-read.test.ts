import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { LedgerReadError, ledgerReadRuntimeSupported, openLedgerReader } from '../../src/core/ledger-read.js';
import type { LedgerSnapshotReader } from '../../src/core/ledger-read.js';
import { linkListCommand, linkShowCommand } from '../../src/ledger/link-commands.js';

const sqliteSkip = ledgerReadRuntimeSupported()
  ? false
  : `Ledger read tests require Node 22.x >=22.13 or >=24 (23 unsupported); running ${process.versions.node}.`;

const sourceId = '1'.repeat(64);
const parentRef = JSON.stringify(['codex', sourceId, 'synthetic-parent', null]);
const childRef = JSON.stringify(['codex', sourceId, 'synthetic-child', 'synthetic-thread']);
const processKey = JSON.stringify(['codex', sourceId, 'synthetic-domain', 123, '456']);
const stamp = { pid: 456, proc_start: '789', boot_id: 'synthetic-boot', pid_domain: 'synthetic-domain' };

function insert(db: DatabaseSync, table: string, values: Record<string, SQLInputValue>): void {
  const columns = Object.keys(values);
  db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(
    ...Object.values(values)
  );
}

function addLink(db: DatabaseSync, id = 'link-a'): void {
  insert(db, 'links', {
    link_id: id,
    state: 'pending',
    parent_caller: 'caller-a',
    parent_context_id: 'context-a',
    parent_context_generation: 1,
    parent_ref: parentRef,
    child_ref: null,
    current_owner: 0,
    backend: 'synthetic-codex',
    role: 'implementer',
    label: null,
    brief_path: '/synthetic/brief.md',
    task_digest: '2'.repeat(64),
    created_at: 100,
  });
}

function addRun(db: DatabaseSync, id = 'run-a', seq = 1, linkId = 'link-a'): void {
  insert(db, 'runs', {
    run_id: id,
    link_id: linkId,
    run_seq: seq,
    operation: seq === 1 ? 'spawn' : 'resume',
    target_session_ref: childRef,
    source_id: sourceId,
    harness: 'codex',
    expected_generation: 1,
    mode: 'headless',
    launch_cwd: '/synthetic/launch',
    state: 'starting',
    launch_token_hash: createHash('sha256').update(id).digest('hex'),
    launch_digest: '3'.repeat(64),
    launch_call_id: `call-${id}`,
    launch_correlation_id: `correlation-${id}`,
    created_at: 100 + seq,
  });
  insert(db, 'events', { link_id: linkId, run_id: id, kind: 'intent.accepted', payload: '{}', at: 100 + seq });
  insert(db, 'claims', {
    run_id: id,
    claim_hash: createHash('sha256').update(`claim-${id}`).digest('hex'),
    source_id: sourceId,
    expected_generation: 1,
    state: 'issued',
    issued_at: 100 + seq,
    expires_at: 1800100 + seq,
  });
}

async function fixture(): Promise<{ db: DatabaseSync; path: string; cleanup: () => void }> {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'hud-ledger-read-'));
  const path = join(dir, 'ledger.sqlite');
  const db = new DatabaseSync(path);
  try {
    const contract = readFileSync(join(process.cwd(), 'docs/contracts/02-execution.md'), 'utf8');
    const ddl = /```sql\n([\s\S]*?)```/.exec(contract)?.[1];
    assert.ok(ddl);
    db.exec(ddl);
    insert(db, 'sources', { source_id: sourceId, harness: 'codex', root_path: '/synthetic/home', label: 'Synthetic' });
    insert(db, 'sessions', {
      session_ref: parentRef,
      harness: 'codex',
      source_id: sourceId,
      session_id: 'synthetic-parent',
    });
    insert(db, 'sessions', {
      session_ref: childRef,
      harness: 'codex',
      source_id: sourceId,
      session_id: 'synthetic-child',
      thread_id: 'synthetic-thread',
    });
    insert(db, 'callers', {
      caller_id: 'caller-a',
      harness: 'codex',
      source_id: sourceId,
      pid: 124,
      proc_start: '457',
      ppid: 123,
      parent_proc_start: '456',
      cwd: '/synthetic/launch',
      started_at: 1,
      last_seen_at: 1,
    });
    insert(db, 'caller_scopes', {
      process_key: processKey,
      generation: 1,
      harness: 'codex',
      source_id: sourceId,
      pid_domain: 'synthetic-domain',
      harness_pid: 123,
      harness_proc_start: '456',
      created_at: 1,
    });
    insert(db, 'caller_contexts', {
      context_id: 'context-a',
      generation: 1,
      caller_id: 'caller-a',
      context_key: 'stdio',
      kind: 'dedicated',
      source_id: sourceId,
      harness: 'codex',
      process_key: processKey,
      proc_generation: 1,
      created_at: 1,
    });
    addLink(db);
    addRun(db);
    return {
      db,
      path,
      cleanup: () => {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

test('ledger read runtime gate leaves importing on Node 18 safe', async () => {
  assert.equal(ledgerReadRuntimeSupported('18.20.8'), false);
  assert.equal(ledgerReadRuntimeSupported('22.4.9'), false);
  assert.equal(ledgerReadRuntimeSupported('22.5.0'), false);
  assert.equal(ledgerReadRuntimeSupported('22.12.0'), false);
  assert.equal(ledgerReadRuntimeSupported('22.13.0'), true);
  assert.equal(ledgerReadRuntimeSupported('23.11.0'), false);
  assert.equal(ledgerReadRuntimeSupported('24.0.0'), true);
  if (!ledgerReadRuntimeSupported()) {
    await assert.rejects(openLedgerReader('/synthetic/unopened.sqlite'), { code: 'runtime_unavailable' });
  }
});

test(
  'ledger read never creates missing ledgers or migrates uninitialized/newer versions',
  { skip: sqliteSkip },
  async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'hud-ledger-missing-'));
    const path = join(dir, 'ledger.sqlite');
    try {
      await assert.rejects(openLedgerReader(path), { code: 'unavailable' });
      assert.equal(existsSync(path), false);
      await assert.rejects(openLedgerReader(':memory:'), { code: 'unavailable' });
      const writer = new DatabaseSync(path);
      writer.close();
      const beforeSize = statSync(path).size;
      await assert.rejects(openLedgerReader(path), { code: 'unsupported_schema' });
      assert.equal(statSync(path).size, beforeSize);
      const newer = new DatabaseSync(path);
      newer.exec('PRAGMA user_version = 2');
      const before = readFileSync(path);
      await assert.rejects(openLedgerReader(path), { code: 'unsupported_schema' });
      assert.deepEqual(readFileSync(path), before);
      assert.equal(newer.prepare('PRAGMA user_version').get()?.user_version, 2);
      assert.equal(newer.prepare('SELECT count(*) AS count FROM sqlite_schema WHERE type = ?').get('table')?.count, 0);
      newer.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  'ledger typed read snapshots preserve complete refs, per-run history and private launch context',
  { skip: sqliteSkip },
  async () => {
    const f = await fixture();
    const reader = await openLedgerReader(f.path);
    try {
      const origin = { repoId: 'synthetic-repo', basis: 'declared', declaredAt: 100 };
      const workspace = {
        worktreeRoot: '/synthetic/launch',
        gitCommonDir: '/synthetic/git',
        repoId: 'synthetic-physical',
        identityKind: 'git-common-dir-v1',
        scope: 'local',
        cwdSource: 'launch',
        cwdAsOf: 101,
        gitCapturedAt: null,
        gitMissingReason: 'timeout',
      };
      f.db.prepare('UPDATE runs SET workspace_snapshot = ? WHERE run_id = ?').run(JSON.stringify(workspace), 'run-a');
      addRun(f.db, 'run-b', 2);
      // project_origin is immutable, so set it in a fresh run's INSERT fixture.
      const row = f.db.prepare('SELECT * FROM runs WHERE run_id = ?').get('run-b')!;
      row.run_id = 'run-c';
      row.run_seq = 3;
      row.launch_token_hash = '4'.repeat(64);
      row.project_origin = JSON.stringify(origin);
      insert(f.db, 'runs', row);
      const snapshot = reader.snapshot();
      assert.equal(snapshot.ledgerId, f.db.prepare('SELECT ledger_id FROM ledger_metadata').get()?.ledger_id);
      assert.equal(snapshot.asOfSeq, 2);
      assert.deepEqual(
        snapshot.runs.map((run) => [run.runId, run.operation]),
        [
          ['run-a', 'spawn'],
          ['run-b', 'resume'],
          ['run-c', 'resume'],
        ]
      );
      assert.deepEqual(snapshot.runs[0].targetSessionRef, {
        harness: 'codex',
        sourceId,
        sessionId: 'synthetic-child',
        threadId: 'synthetic-thread',
      });
      assert.equal(snapshot.links[0].parentRef?.threadId, null);
      assert.equal(snapshot.runs[0].launchCwd, '/synthetic/launch');
      assert.deepEqual(snapshot.runs[0].workspaceSnapshot, workspace);
      assert.deepEqual(snapshot.runs[2].projectOrigin, origin);
      assert.equal('launchTokenHash' in snapshot.runs[0], false);
      assert.equal('launchDigest' in snapshot.runs[0], false);
      assert.deepEqual(reader.snapshot({ linkIds: [] }).links, []);
      assert.equal(reader.snapshot({ linkIds: [] }).asOfSeq, 2);
      assert.deepEqual(reader.snapshot({ linkIds: ['missing'] }).runs, []);
    } finally {
      reader.close();
      f.cleanup();
    }
  }
);

test('ledger reads preserve empty scopes and do not truncate to HUD display limits', { skip: sqliteSkip }, async () => {
  const f = await fixture();
  const reader = await openLedgerReader(f.path);
  try {
    f.db.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 205; index++) {
      const id = `synthetic-${String(index).padStart(3, '0')}`;
      addLink(f.db, `link-${id}`);
      addRun(f.db, `run-${id}`, 1, `link-${id}`);
    }
    f.db.exec('COMMIT');
    const snapshot = reader.snapshot();
    assert.equal(snapshot.links.length, 206);
    assert.equal(snapshot.runs.length, 206);
    assert.equal(snapshot.events.length, 206);
    assert.deepEqual(
      snapshot.links.map((link) => link.linkId),
      snapshot.links.map((link) => link.linkId).sort()
    );
    const emptyScope = reader.snapshot({ linkIds: [] });
    assert.equal(emptyScope.ledgerId, snapshot.ledgerId);
    assert.equal(emptyScope.asOfSeq, 206);
    for (const field of ['links', 'runs', 'claims', 'bindings', 'reports', 'events', 'evidence', 'slots'] as const)
      assert.deepEqual(emptyScope[field], []);
  } finally {
    reader.close();
    f.cleanup();
  }
});

test(
  'ledger read uses registration evidence for full supervisor stamps and rejects contradictory facts',
  { skip: sqliteSkip },
  async () => {
    const f = await fixture();
    const reader = await openLedgerReader(f.path);
    try {
      f.db
        .prepare('UPDATE runs SET supervisor_pid = ?, supervisor_proc_start = ? WHERE run_id = ?')
        .run(stamp.pid, stamp.proc_start, 'run-a');
      assert.equal(reader.snapshot().runs[0].supervisor, null);
      const registration = { sourceId, bindingGeneration: 1, supervisor: stamp };
      insert(f.db, 'events', {
        link_id: 'link-a',
        run_id: 'run-a',
        kind: 'supervisor.registered',
        payload: JSON.stringify(registration),
        at: 102,
      });
      assert.equal(reader.snapshot().runs[0].supervisor, null);
      f.db
        .prepare('UPDATE claims SET supervisor_pid = ?, supervisor_proc_start = ? WHERE run_id = ?')
        .run(stamp.pid, stamp.proc_start, 'run-a');
      assert.deepEqual(reader.snapshot().runs[0].supervisor, stamp);
      assert.deepEqual(reader.snapshot().claims[0].supervisor, stamp);
      assert.equal('claimHash' in reader.snapshot().claims[0], false);
      f.db.prepare('UPDATE claims SET supervisor_pid = ? WHERE run_id = ?').run(999, 'run-a');
      assert.equal(reader.snapshot().runs[0].supervisor, null);
      assert.equal(reader.snapshot().claims[0].supervisor, null);
      f.db.prepare('UPDATE claims SET supervisor_pid = ? WHERE run_id = ?').run(stamp.pid, 'run-a');
      f.db.prepare('UPDATE runs SET supervisor_pid = ? WHERE run_id = ?').run(999, 'run-a');
      assert.equal(reader.snapshot().runs[0].supervisor, null);
      f.db.prepare('UPDATE runs SET supervisor_pid = ? WHERE run_id = ?').run(stamp.pid, 'run-a');
      insert(f.db, 'events', {
        link_id: 'link-a',
        run_id: 'run-a',
        kind: 'supervisor.registered',
        payload: JSON.stringify(registration),
        at: 103,
      });
      assert.equal(reader.snapshot().runs[0].supervisor, null);
    } finally {
      reader.close();
      f.cleanup();
    }
  }
);

test(
  'ledger rows and high-water stay in one WAL read snapshot during a concurrent commit',
  { skip: sqliteSkip },
  async () => {
    const f = await fixture();
    const reader = await openLedgerReader(f.path);
    try {
      reader.withSnapshot((view) => {
        assert.equal(view.asOfSeq, 1);
        assert.equal(view.listRuns().length, 1);
        f.db.exec('BEGIN IMMEDIATE');
        addLink(f.db, 'link-b');
        addRun(f.db, 'run-b', 1, 'link-b');
        f.db.prepare('UPDATE links SET label = ? WHERE link_id = ?').run('new-label', 'link-a');
        f.db.exec('COMMIT');
        assert.equal(view.listLinks().length, 1);
        assert.equal(view.listLinks()[0].label, null);
        assert.equal(view.listEvents().length, 1);
        assert.equal(view.asOfSeq, 1);
      });
      const next = reader.snapshot();
      assert.equal(next.asOfSeq, 2);
      assert.equal(next.links.length, 2);
      assert.equal(next.links[0].label, 'new-label');
      assert.equal(next.runs.length, 2);
      assert.equal(reader.snapshot({ linkIds: ['link-b'] }).events[0].runId, 'run-b');
    } finally {
      reader.close();
      f.cleanup();
    }
  }
);

test('ledger snapshot callback lifetime and errors release read transactions', { skip: sqliteSkip }, async () => {
  const f = await fixture();
  const reader = await openLedgerReader(f.path);
  try {
    let escaped: LedgerSnapshotReader | undefined;
    reader.withSnapshot((view) => {
      escaped = view;
      assert.equal('exec' in view, false);
      assert.equal('prepare' in view, false);
      assert.throws(() => reader.snapshot(), { code: 'snapshot_active' });
      assert.throws(() => reader.close(), { code: 'snapshot_active' });
    });
    assert.throws(() => escaped!.listLinks(), { code: 'closed' });
    assert.throws(
      () =>
        reader.withSnapshot(() => {
          throw new Error('synthetic callback failure');
        }),
      /synthetic callback failure/
    );
    assert.throws(() => reader.withSnapshot(() => Promise.resolve(1)), /must be synchronous/);
    assert.equal(reader.snapshot().links.length, 1);
    reader.close();
    reader.close();
    assert.throws(() => reader.snapshot(), LedgerReadError);
  } finally {
    reader.close();
    f.cleanup();
  }
});

test(
  'link command functions distinguish missing links from unavailable ledgers and keep report/run states separate',
  { skip: sqliteSkip },
  async () => {
    const f = await fixture();
    const reader = await openLedgerReader(f.path);
    try {
      insert(f.db, 'evidence', {
        evidence_id: 'evidence-a',
        run_id: 'run-a',
        link_id: 'link-a',
        kind: 'trusted_session',
        producer: 'reconciler',
        fingerprint: '5'.repeat(64),
        payload: '{}',
        observed_at: 102,
        validated_at: 102,
        validation: 'accepted',
      });
      insert(f.db, 'child_bindings', {
        binding_id: 'binding-a',
        run_id: 'run-a',
        session_ref: childRef,
        binding_generation: 1,
        caller_id: 'caller-a',
        caller_context_id: 'context-a',
        context_generation: 1,
        bound_by: 'trusted_session',
        capabilities: 'mcp',
        evidence_id: 'evidence-a',
        created_at: 103,
      });
      insert(f.db, 'reports', {
        report_id: 'report-initial',
        run_id: 'run-a',
        link_id: 'link-a',
        child_binding_id: 'binding-a',
        caller_id: 'caller-a',
        caller_context_id: 'context-a',
        context_generation: 1,
        status: 'failed',
        summary: 'Synthetic failed report',
        created_at: 104,
      });
      insert(f.db, 'events', {
        link_id: 'link-a',
        run_id: 'run-a',
        kind: 'report.received',
        payload: JSON.stringify({ reportId: 'report-initial' }),
        at: 104,
      });
      insert(f.db, 'slots', {
        slot_key: 'provisional:run-a',
        session_ref: null,
        run_id: 'run-a',
        holder: 'synthetic-holder',
        acquired_at: 101,
      });
      const list = await linkListCommand(reader);
      assert.equal(list.links[0].currentRun?.state, 'starting');
      assert.equal(list.links[0].latestReportForRun?.status, 'failed');
      const show = await linkShowCommand(f.path, 'link-a');
      assert.equal(show.link?.linkId, 'link-a');
      assert.equal(show.bindings[0].sessionRef.threadId, 'synthetic-thread');
      assert.equal(show.evidence[0].validation, 'accepted');
      assert.equal(show.slots[0].runId, 'run-a');
      assert.equal((await linkShowCommand(reader, 'missing')).link, null);
      const originalReport = f.db.prepare('SELECT * FROM reports WHERE report_id = ?').get('report-initial')!;
      const addReport = (reportId: string, createdAt: number, seq?: number) => {
        insert(f.db, 'reports', { ...originalReport, report_id: reportId, created_at: createdAt });
        if (seq !== undefined)
          insert(f.db, 'events', {
            seq,
            link_id: 'link-a',
            run_id: 'run-a',
            kind: 'report.received',
            payload: JSON.stringify({ reportId }),
            at: createdAt,
          });
      };
      addReport('report-z', 1000, 10);
      addReport('report-a', 1000, 11);
      assert.equal((await linkListCommand(reader)).links[0].latestReportForRun?.reportId, 'report-a');
      assert.equal((await linkShowCommand(reader, 'link-a')).latestReportForRun?.reportId, 'report-a');
      addReport('report-older-timestamp', 1, 12);
      addReport('report-without-event', 2000);
      insert(f.db, 'events', {
        link_id: null,
        run_id: 'run-a',
        kind: 'report.received',
        payload: JSON.stringify({ reportId: 'report-without-event' }),
        at: 2000,
      });
      assert.equal((await linkListCommand(reader)).links[0].latestReportForRun?.reportId, 'report-older-timestamp');
      const reordered = await linkShowCommand(reader, 'link-a');
      assert.equal(reordered.latestReportForRun?.reportId, 'report-older-timestamp');
      assert.equal(reordered.reports.length, 5);
      assert.equal(reader.snapshot().reports.length, 5);
      addRun(f.db, 'run-b', 2);
      const updated = await linkListCommand(reader);
      assert.equal(updated.links[0].currentRun?.runId, 'run-b');
      assert.equal(updated.links[0].latestReportForRun, null);
      await assert.rejects(linkListCommand(join(f.path, 'missing')), { code: 'unavailable' });
    } finally {
      reader.close();
      f.cleanup();
    }
  }
);
