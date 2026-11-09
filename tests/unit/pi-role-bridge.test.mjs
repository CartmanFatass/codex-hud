import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { PiEvidenceChannel } from '../../packages/hud-mcp/dist/packages/hud-mcp/src/pi-channel.js';
import {
  createPiDelegationContextGuard,
  PI_EXTENSION_CONTEXT_PROFILE,
} from '../../dist/harness/pi/delegation-context.js';

async function fixture(t, { persisted = true, unassigned = false, shared = null } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hud-pi-roles-')));
  const root = shared?.root ?? join(dir, 'sessions'),
    home = shared?.home ?? join(dir, 'hud');
  const pkg = join(dir, 'node_modules/@earendil-works/pi-coding-agent');
  if (!shared) {
    await mkdir(root);
    await mkdir(home, { mode: 0o700 });
  }
  await mkdir(join(dir, 'home'));
  await mkdir(join(pkg, 'dist/bundle'), { recursive: true });
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: '@earendil-works/pi-coding-agent',
      version: '1.5.0',
      type: 'module',
      bin: { pi: 'dist/bundle/cli.js' },
    })
  );
  await copyFile('tests/fixtures/pi-role-host.mjs', join(pkg, 'dist/bundle/cli.js'));
  if (persisted)
    await writeFile(
      join(root, 'synthetic-a.jsonl'),
      JSON.stringify({ type: 'session', version: 3, id: 'synthetic-a' }) + '\n'
    );
  await copyFile('docs/examples/routing.toml', join(home, 'routing.toml'));
  // Ordinary startup: no --session-dir, --session or --session-id argv.
  const child = spawn(process.execPath, [join(pkg, 'dist/bundle/cli.js')], {
    cwd: resolve('.'),
    env: {
      PATH: process.env.PATH,
      HOME: join(dir, 'home'),
      HUD_HOME: home,
      HUD_TEST_REPO: resolve('.'),
      HUD_TEST_SESSIONS: root,
      ...(unassigned ? { HUD_TEST_UNASSIGNED: '1' } : {}),
      PI_SESSION_ID: 'forged-env-only',
      CLAUDE_CODE_SESSION_ID: 'forged-env-only',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '',
    id = 0;
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const pending = new Map();
  let readyResolve, readyReject;
  const ready = new Promise((a, b) => {
    readyResolve = a;
    readyReject = b;
  });
  const ended = new Promise((r) => child.once('close', r));
  child.once('close', () => {
    readyReject(Error(stderr));
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error(stderr || 'host exited'));
    }
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const row = JSON.parse(line);
    if (row.ready) readyResolve(row);
    else {
      const p = pending.get(row.id);
      pending.delete(row.id);
      clearTimeout(p.timer);
      p.resolve(row);
    }
  });
  t.after(async () => {
    child.stdin.end();
    await ended;
    await rm(dir, { recursive: true, force: true });
  });
  const init = await ready;
  const request = (value) =>
    new Promise((resolve, reject) => {
      const number = ++id;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(Error('fixture timeout: ' + stderr));
      }, 15000);
      pending.set(number, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id: number, ...value }) + '\n');
    });
  return {
    root,
    home,
    init,
    request,
    call: (callId, args = { action: 'show' }, tool = 'hud_roster') => request({ kind: 'call', tool, callId, args }),
  };
}

test(
  'ordinary pi entry exposes exactly six role schemas over real private MCP, no old host imports',
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(t);
    assert.deepEqual(f.init.tools, ['hud_roster', 'hud_create', 'hud_read', 'hud_send', 'hud_respond', 'hud_close']);
    const result = await f.call('ordinary');
    assert.equal(result.result?.details.ok, true, JSON.stringify(result));
    assert.ok(JSON.stringify(result.result.details).includes('/synthetic-a'));
    const forged = await f.call('forged', { action: 'show', sessionId: 'forged' });
    assert.match(forged.error, /mcp_request_failed/);
  }
);

for (const unassigned of [false, true])
  test(
    `pi lazy persistence (${unassigned ? 'unassigned' : 'missing file'}) returns defined pending then succeeds`,
    { timeout: 25000 },
    async (t) => {
      const f = await fixture(t, { persisted: false, unassigned });
      assert.equal(JSON.parse((await f.call('lazy')).error).code, 'identity_source_missing');
      assert.deepEqual((await f.request({ kind: 'children' })).result, []);
      await f.request({ kind: 'persist' });
      assert.equal((await f.call('lazy')).result?.details.ok, true);
    }
  );

test(
  'pi reload/new/resume/fork/tree and cancelled transitions fence epochs; MCP restart never replays',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await f.call('first')).result?.details.ok, true);
    await f.request({ kind: 'kill' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await f.call('first')).error, 'pi_duplicate_tool_call');
    assert.equal((await f.call('after-restart')).result?.details.ok, true);
    for (const reason of ['reload', 'new', 'resume', 'fork', 'tree']) {
      const before =
        reason === 'tree'
          ? 'session_before_tree'
          : reason === 'fork'
            ? 'session_before_fork'
            : reason === 'reload'
              ? 'session_shutdown'
              : 'session_before_switch';
      await f.request({ kind: 'event', event: before, reason });
      assert.match((await f.call('fenced-' + reason)).error, /stale_context/);
      assert.deepEqual((await f.request({ kind: 'children' })).result, []);
      const sessionId = 'synthetic-' + reason;
      await f.request({ kind: 'set', state: { sessionId, sessionFile: join(f.root, sessionId + '.jsonl') } });
      await f.request({ kind: 'persist' });
      await f.request({ kind: 'event', event: reason === 'tree' ? 'session_tree' : 'session_start', reason });
      const next = await f.call('after-' + reason);
      assert.equal(next.result?.details.ok, true, JSON.stringify(next));
      assert.ok(JSON.stringify(next.result.details).includes('/' + sessionId));
    }
    await f.request({ kind: 'event', event: 'session_before_switch', reason: 'new' });
    assert.match((await f.call('cancelled')).error, /stale_context/);
    await f.request({ kind: 'command', args: 'reconnect' });
    assert.equal((await f.call('after-cancel')).result?.details.ok, true);
    assert.equal((await f.call('after-cancel')).error, 'pi_duplicate_tool_call');
  }
);

test(
  'pi transition racing capture refuses old admission and leaves no duplicated dispatch',
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(t);
    // Filesystem capture yields. The host processes shutdown synchronously before it resumes.
    const [raced] = await Promise.all([f.call('race'), f.request({ kind: 'event', event: 'session_shutdown' })]);
    assert.match(raced.error, /stale_pi_extension_epoch|stale_context/);
    assert.deepEqual((await f.request({ kind: 'children' })).result, []);
    await f.request({ kind: 'event', event: 'session_start', reason: 'reload' });
    assert.equal((await f.call('race')).result?.details.ok, true, 'unadmitted call is not marked submitted');
    assert.equal((await f.call('race')).error, 'pi_duplicate_tool_call');
  }
);

test(
  'two ordinary pi processes sharing cwd, source and configuration keep independent selections',
  { timeout: 25000 },
  async (t) => {
    const first = await fixture(t);
    const other = await fixture(t, { shared: first, persisted: false });
    await other.request({
      kind: 'set',
      state: { sessionId: 'synthetic-other', sessionFile: join(first.root, 'synthetic-other.jsonl') },
    });
    await other.request({ kind: 'persist' });
    assert.equal((await first.call('select', { action: 'select', preset: 'pi-build' })).result?.details.ok, true);
    const a = (await first.call('show-a')).result.details;
    const b = (await other.call('show-b')).result.details;
    assert.ok(JSON.stringify(a).includes('pi-build'));
    assert.ok(JSON.stringify(a).includes('/synthetic-a'));
    assert.ok(JSON.stringify(b).includes('/synthetic-other'));
    assert.ok(!JSON.stringify(b).includes('"source":"session"'));
    assert.equal(
      (await other.call('foreign-job', { job: 'j0123456789abcdef' }, 'hud_read')).error,
      '{"ok":false,"code":"not_found","field":"job"}'
    );
  }
);

test('real server evidence channel fences a close during asynchronous native evidence inspection', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hud-pi-role-race-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: 'synthetic' }) + '\n');
  const ctx = {
    sessionManager: { getSessionId: () => 'synthetic', getSessionFile: () => file, getSessionDir: () => dir },
  };
  const guard = createPiDelegationContextGuard({ profile: PI_EXTENSION_CONTEXT_PROFILE, canonicalSourceDir: dir });
  const snapshot = await guard.start().capture(ctx, 'call-race', 'hud_roster');
  const input = new PassThrough();
  const channel = new PiEvidenceChannel(input);
  const ticket = randomUUID();
  input.write(JSON.stringify({ seq: 1, ticket, snapshot }) + '\n');
  const pending = channel.consume({ 'hud/pi': { seq: 1, ticket, callId: 'call-race' } }, 'hud_roster', dir);
  channel.close();
  await assert.rejects(pending, /stale_context/);
});
