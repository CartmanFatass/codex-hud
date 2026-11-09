import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoleCallSource } from '../../packages/hud-mcp/src/role-source.js';
import { RoleFacadeTools } from '../../packages/hud-mcp/src/role-extension.js';
import { HudMcpServer } from '../../packages/hud-mcp/src/server.js';
import type { CallerProbe, CallerProcess } from '../../src/roles/caller.js';
import { resolveDaemonThread, sqliteDatabase } from '../../src/collectors/daemon-binding.js';

function fixture(t: test.TestContext, harness: 'claude' | 'codex' = 'claude') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hud-role-source-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, harness),
    home = join(dir, 'hud');
  mkdirSync(join(root, 'sessions'), { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, 'routing.toml'), readFileSync('docs/examples/routing.toml'));
  const proc: CallerProcess = {
    pid: 10,
    ppid: 1,
    procStart: '100',
    argv: [harness],
    env: { HOME: dir, CLAUDE_CONFIG_DIR: root, CODEX_HOME: root },
  };
  const probe: CallerProbe = {
    ppid: 10,
    env: { CLAUDE_CODE_SESSION_ID: 'forged-env', PI_SESSION_ID: 'forged-pi' },
    read: (pid) => (pid === proc.pid ? { ...proc } : null),
    readText: (file, max) => {
      try {
        const text = readFileSync(file, 'utf8');
        return Buffer.byteLength(text) <= max ? text : null;
      } catch {
        return null;
      }
    },
    realpath: (file) => {
      try {
        return realpathSync(file);
      } catch {
        return null;
      }
    },
    codexThread: (root, pid, since, strict) => resolveDaemonThread(join(root, 'logs_2.sqlite'), { pid, since, strict }),
    started: () => 1000,
  };
  const record = (sessionId: string, extra = {}) =>
    writeFileSync(join(root, 'sessions/10.json'), JSON.stringify({ pid: 10, procStart: '100', sessionId, ...extra }));
  record('synthetic-first');
  const source = new RoleCallSource(probe);
  const server = new HudMcpServer(
    source,
    undefined,
    undefined,
    undefined,
    new RoleFacadeTools(home, {}, null, (resolved) => source.assertCurrent(resolved))
  );
  let id = 0;
  const call = async (name = 'hud_roster', args: Record<string, unknown> = { action: 'show' }) => {
    const reply = (await server.handle({
      jsonrpc: '2.0',
      id: ++id,
      method: 'tools/call',
      params: { name, arguments: args },
    })) as { result?: { structuredContent: Record<string, unknown> }; error?: unknown };
    return reply;
  };
  return { dir, home, root, proc, probe, record, source, server, call };
}

test('ordinary Claude /clear and /resume rebind next calls; inherited env never freezes the caller', async (t) => {
  const f = fixture(t);
  for (const session of ['synthetic-first', 'synthetic-clear', 'synthetic-resumed']) {
    f.record(session);
    const result = (await f.call()).result!.structuredContent;
    assert.equal(result.ok, true);
    assert.ok(JSON.stringify(result).includes('/' + session), JSON.stringify(result));
  }
});

test('Claude native startedAt shape is process-start corroborated, not an env credential', async (t) => {
  const f = fixture(t);
  f.record('native-shape', { procStart: undefined, startedAt: 1000_000 });
  assert.equal((await f.source.resolve(null, 'hud_roster')).ok, true);
  f.record('forged-time', { procStart: undefined, startedAt: 1003_000 });
  assert.deepEqual(await f.source.resolve(null, 'hud_roster'), { ok: false, code: 'identity_unverified' });
  unlinkSync(join(f.root, 'sessions/10.json'));
  assert.equal((await f.call()).result!.structuredContent.code, 'identity_unverified');
});

test('admission rechecks after async acquisition and before facade dispatch; PID reuse is stale', async (t) => {
  const f = fixture(t);
  const admitted = await f.source.resolve(null, 'hud_roster');
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  f.record('changed-during-await');
  const extension = new RoleFacadeTools(f.home, {}, null, (resolved) => f.source.assertCurrent(resolved));
  await assert.rejects(
    extension.invoke(admitted, 'hud_roster', { action: 'select', preset: 'daily' }),
    /stale_context/
  );
  f.proc.procStart = '101';
  assert.deepEqual(await f.source.resolve(null, 'hud_roster'), { ok: false, code: 'stale_context' });
});

test('source-qualified sessions sharing cwd/config cannot select or read another session jobs', async (t) => {
  const f = fixture(t);
  const first = await f.source.resolve(null, 'hud_roster');
  assert.ok(first.ok);
  assert.equal((await f.call('hud_roster', { action: 'select', preset: 'daily' })).result!.structuredContent.ok, true);
  f.record('synthetic-other');
  const other = await f.source.resolve(null, 'hud_roster');
  assert.ok(other.ok);
  if (!first.ok || !other.ok) return;
  assert.equal(first.sessionRef.sourceId, other.sessionRef.sourceId);
  assert.notEqual(first.sessionRef.sessionId, other.sessionRef.sessionId);
  assert.ok(!JSON.stringify((await f.call()).result).includes('"source":"session"'));
  // Real facade ownership check, using a receipt owned by first. Foreign reads fail
  // before parsing/observing a job or contacting herdr.
  const job = 'j0123456789abcdef';
  mkdirSync(join(f.home, 'jobs', job), { recursive: true });
  writeFileSync(
    join(f.home, 'jobs', job, 'receipt.json'),
    JSON.stringify({
      schema: 1,
      job,
      parent: `${first.sessionRef.sourceId}/${first.sessionRef.sessionId}`,
      executor: { kind: 'herdr' },
      state: 'done',
      role: 'sonic',
      binding: {},
    })
  );
  const foreign = (await f.call('hud_read', { job })).result!.structuredContent;
  assert.equal(foreign.code, 'not_found');
  f.record(first.sessionRef.sessionId);
  assert.equal((await f.call('hud_read', { job })).result!.structuredContent.ok, true);
});

test('simultaneous Claude processes share native store but never session authority', async (t) => {
  const f = fixture(t);
  const second = { ...f.proc, pid: 11, procStart: '200' };
  writeFileSync(
    join(f.root, 'sessions/11.json'),
    JSON.stringify({ pid: 11, procStart: '200', sessionId: 'synthetic-second' })
  );
  const other = new RoleCallSource({ ...f.probe, ppid: 11, read: (pid) => (pid === 11 ? second : null) });
  const a = await f.source.resolve(null, 'hud_roster');
  const b = await other.resolve(null, 'hud_roster');
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.equal(a.sessionRef.sourceId, b.sessionRef.sourceId);
  assert.notEqual(a.sessionRef.sessionId, b.sessionRef.sessionId);
  assert.notEqual(a.processKey, b.processKey);
});

test('forged model identity arguments rejected; missing native evidence never falls back to cwd', async (t) => {
  const f = fixture(t);
  assert.ok((await f.call('hud_roster', { action: 'show', sessionId: 'forged' })).error);
  f.probe.read = () => null;
  assert.equal((await f.call()).result!.structuredContent.code, 'identity_source_missing');
});

test('ordinary Codex current-thread change is read from the real native daemon store per call', async (t) => {
  const Db = sqliteDatabase();
  if (!Db) {
    t.skip('node:sqlite required');
    return;
  }
  const f = fixture(t, 'codex');
  const db = new Db(join(f.root, 'logs_2.sqlite'));
  t.after(() => db.close());
  db.prepare(
    'CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, target TEXT, feedback_log_body TEXT, thread_id TEXT, process_uuid TEXT)'
  ).all();
  const insert = db.prepare('INSERT INTO logs VALUES (?, ?, 0, ?, ?, ?, ?)');
  insert.all(1, 1000, 'codex_tui::app::startup', 'startup', null, 'pid:10:synthetic');
  insert.all(
    2,
    1001,
    'daemon',
    'rpc.method="thread/start" app_server.connection_id=1 app_server.client_name="codex-tui"',
    'synthetic-thread-a',
    'daemon'
  );
  const first = await f.source.resolve(null, 'hud_roster');
  assert.ok(first.ok && first.sessionRef.sessionId === 'synthetic-thread-a');
  insert.all(
    3,
    1010,
    'daemon',
    'rpc.method="thread/resume" app_server.connection_id=1 app_server.client_name="codex-tui"',
    'synthetic-thread-b',
    'daemon'
  );
  const next = await f.source.resolve(null, 'hud_roster');
  assert.ok(next.ok && next.sessionRef.sessionId === 'synthetic-thread-b');
  insert.all(4, 1000, 'codex_tui::app::startup', 'startup', null, 'pid:11:synthetic');
  insert.all(
    5,
    1002,
    'daemon',
    'rpc.method="thread/start" app_server.connection_id=2 app_server.client_name="codex-tui"',
    'other-thread',
    'daemon'
  );
  assert.deepEqual(
    await f.source.resolve(null, 'hud_roster'),
    { ok: false, code: 'identity_unverified' },
    'role admission must not rank two simultaneous same-config sessions'
  );
  assert.equal(
    resolveDaemonThread(join(f.root, 'logs_2.sqlite'), { pid: 10, since: 1000 }),
    'synthetic-thread-b',
    'display ranking unchanged'
  );
  // Reviewer #1: a unique resume can belong to a connection created long before
  // this TUI. The candidate window alone is not ownership evidence.
  db.prepare('DELETE FROM logs WHERE id IN (2, 4, 5)').all();
  insert.all(
    6,
    900,
    'daemon',
    'app-server request: initialize connection_id=ConnectionId(1) request_id=Integer(1)',
    null,
    'daemon'
  );
  assert.deepEqual(await f.source.resolve(null, 'hud_roster'), { ok: false, code: 'identity_unverified' });

  // Synthetic fixture of installed Codex 0.167.0's ordinary no-prompt startup:
  // initialize/account precede TRACE thread/start, its exact request-id span,
  // and only THEN the TUI startup row. No real IDs or transcript content.
  db.prepare('DELETE FROM logs').all();
  insert.all(1, 1002, 'codex_tui::app::startup', 'connected app-server', null, 'pid:10:synthetic');
  insert.all(
    2,
    1000,
    'daemon',
    'app-server request: initialize connection_id=ConnectionId(2) request_id=String("initialize")',
    null,
    'daemon'
  );
  insert.all(
    3,
    1000,
    'daemon',
    'app-server request: account/read connection_id=ConnectionId(2) request_id=Integer(1)',
    null,
    'daemon'
  );
  insert.all(
    4,
    1001,
    'daemon',
    'app-server request: thread/start connection_id=ConnectionId(2) request_id=String("startup-thread-start-synthetic")',
    null,
    'daemon'
  );
  const span =
    'rpc.method="thread/start" rpc.request_id=startup-thread-start-synthetic app_server.connection_id=2 app_server.client_name="codex-tui"';
  insert.all(5, 1001, 'daemon', span, 'synthetic-normal', 'daemon');
  const normal = await f.source.resolve(null, 'hud_roster');
  assert.ok(normal.ok && normal.sessionRef.sessionId === 'synthetic-normal');
  db.prepare('UPDATE logs SET feedback_log_body = ? WHERE id = 5').all(
    span.replace('startup-thread-start-synthetic', 'different-request')
  );
  assert.deepEqual(
    await f.source.resolve(null, 'hud_roster'),
    { ok: false, code: 'identity_unverified' },
    'TRACE cannot borrow another request span'
  );
  db.prepare('DELETE FROM logs WHERE id = 5').all();
  assert.deepEqual(
    await f.source.resolve(null, 'hud_roster'),
    { ok: false, code: 'identity_unverified' },
    'uncorroborated TRACE refuses'
  );
});
