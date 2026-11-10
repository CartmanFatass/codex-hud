import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
async function host(t, { unassigned = false, shared = null, id = 'synthetic-a' } = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-a5-role-')),
    pkg = join(dir, 'node_modules/@earendil-works/pi-coding-agent');
  const sessions = shared?.sessions ?? join(dir, 'sessions'),
    home = shared?.home ?? join(dir, 'hud');
  fs.mkdirSync(join(pkg, 'dist/bundle'), { recursive: true, mode: 0o700 });
  for (const name of ['home', 'codex', 'agent']) fs.mkdirSync(join(dir, name), { mode: 0o700 });
  if (!shared) {
    fs.mkdirSync(sessions, { mode: 0o700 });
    fs.mkdirSync(home, { mode: 0o700 });
    fs.copyFileSync('docs/examples/routing.toml', join(home, 'routing.toml'));
  }
  fs.writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: '@earendil-works/pi-coding-agent',
      version: '1.5.1',
      type: 'module',
      bin: { pi: 'dist/bundle/cli.js' },
    })
  );
  fs.copyFileSync('tests/fixtures/pi-package-host.mjs', join(pkg, 'dist/bundle/cli.js'));
  if (!unassigned)
    fs.writeFileSync(
      join(sessions, 'synthetic-a.jsonl'),
      JSON.stringify({ type: 'session', id: 'synthetic-a', version: 3 }) + '\n'
    );
  const child = spawn(process.execPath, [join(pkg, 'dist/bundle/cli.js')], {
    cwd: resolve('.'),
    env: {
      PATH: process.env.PATH,
      HOME: join(dir, 'home'),
      HUD_HOME: home,
      CODEX_HOME: join(dir, 'codex'),
      PI_CODING_AGENT_DIR: join(dir, 'agent'),
      HUD_TEST_REPO: resolve('.'),
      HUD_TEST_SESSIONS: sessions,
      HUD_TEST_ID: id,
      ...(unassigned ? { HUD_TEST_UNASSIGNED: '1' } : {}),
      PI_SESSION_ID: 'forged-env',
      HUD_SESSION_ID: 'forged-env',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let errors = '',
    seq = 0;
  const pending = new Map();
  child.stderr.on('data', (b) => (errors += b));
  let readyResolve, readyReject;
  const ready = new Promise((a, b) => {
    readyResolve = a;
    readyReject = b;
  });
  const ended = new Promise((r) => child.once('close', r));
  child.once('close', () => {
    readyReject(Error(errors));
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error(errors || 'host_closed'));
    }
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const v = JSON.parse(line);
    if (v.ready) readyResolve(v);
    else {
      const p = pending.get(v.id);
      pending.delete(v.id);
      clearTimeout(p.timer);
      p.resolve(v);
    }
  });
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    await ended;
    clearTimeout(timer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const init = await ready;
  const request = (v) =>
    new Promise((resolve, reject) => {
      const n = ++seq;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(Error('fixture_deadline: ' + errors));
      }, 15000);
      pending.set(n, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id: n, ...v }) + '\n');
    });
  return {
    sessions,
    home,
    init,
    request,
    call: (callId, args = { action: 'show' }, tool = 'hud_roster') => request({ kind: 'call', callId, args, tool }),
  };
}
test(
  'A5 entry REAL bridge admits exactly six role tools, forged arguments refuse, restart re-admits only new host call',
  { timeout: 30000 },
  async (t) => {
    const f = await host(t);
    assert.deepEqual(f.init.tools, ['hud_roster', 'hud_create', 'hud_read', 'hud_send', 'hud_respond', 'hud_close']);
    const first = await f.call('first');
    assert.equal(first.result?.details.ok, true, JSON.stringify(first));
    assert.match((await f.call('forged', { action: 'show', sessionId: 'other' })).error, /mcp_request_failed/);
    await f.request({ kind: 'kill' });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await f.call('first')).error, 'pi_duplicate_tool_call');
    assert.equal((await f.call('second')).result?.details.ok, true);
    await f.request({ kind: 'event', event: 'session_before_switch' });
    assert.equal((await f.call('cancelled')).error, 'pi_session_inactive');
    await f.request({ kind: 'command', args: 'reconnect' });
    assert.equal((await f.call('after-reconnect')).result?.details.ok, true);
  }
);
test(
  'A5 unpersisted session starts without MCP; first persisted call uses native identity, not env',
  { timeout: 25000 },
  async (t) => {
    const f = await host(t, { unassigned: true });
    const pending = await f.call('lazy');
    assert.equal(JSON.parse(pending.error).code, 'identity_source_missing');
    assert.deepEqual((await f.request({ kind: 'children' })).result, []);
    await f.request({ kind: 'persist' });
    const r = await f.call('lazy');
    assert.equal(r.result?.details.ok, true);
    assert.match(JSON.stringify(r.result.details), /synthetic-a/);
    assert.doesNotMatch(JSON.stringify(r.result.details), /forged-env/);
  }
);
test(
  'A5 two native sessions sharing cwd and HUD/source keep selections and job visibility isolated',
  { timeout: 30000 },
  async (t) => {
    const a = await host(t),
      b = await host(t, { shared: a, unassigned: true, id: 'synthetic-b' });
    await b.request({ kind: 'persist' });
    assert.equal((await a.call('choose', { action: 'select', preset: 'pi-build' })).result?.details.ok, true);
    const first = await a.call('show'),
      second = await b.call('show');
    assert.match(JSON.stringify(first.result.details), /synthetic-a/);
    assert.match(JSON.stringify(second.result.details), /synthetic-b/);
    assert.doesNotMatch(JSON.stringify(second.result.details), /"source":"session"/);
    assert.equal(
      JSON.parse((await b.call('foreign', { job: 'j0123456789abcdef' }, 'hud_read')).error).code,
      'not_found'
    );
  }
);
test(
  'A5 native transition races tool admission: old call refuses and cleanup leaves no MCP process',
  { timeout: 25000 },
  async (t) => {
    const f = await host(t);
    const [call] = await Promise.all([f.call('race'), f.request({ kind: 'event', event: 'session_shutdown' })]);
    assert.match(call.error, /stale_pi_extension_epoch|pi_session_inactive/);
    assert.deepEqual((await f.request({ kind: 'children' })).result, []);
    await f.request({ kind: 'event', event: 'session_start' });
    assert.equal((await f.call('race')).result?.details.ok, true);
  }
);
