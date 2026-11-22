import { withState } from '../fixtures/state-helpers.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { expProxyPath, readExpData, saveExpEdit } from '../../dist/collectors/exp-store.js';
import { observeProxy, refreshProxyIfDue } from '../../dist/collectors/exp-proxy-refresh.js';
import { initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { proxyFooter } from '../fakes/exp-proxy-footer.mjs';

const START = Date.parse('2026-11-20T10:30:00Z');
const MIN = 60_000;
const windows = {
  primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: (START + 6 * MIN) / 1000 },
  secondary: { usedPercent: 43, windowDurationMins: 10080, resetsAt: (START + 10080 * MIN) / 1000 },
};

function fixture(t, enabled = true, bound = true) {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-exp-proxy-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { HOME: join(dir, 'home'), HUD_HOME: join(dir, 'hud'), PATH: join(dir, 'bin') };
  const profile = join(env.HOME, '.codex');
  const other = join(env.HOME, '.codex-other');
  for (const path of [profile, other, env.HUD_HOME, env.PATH]) fs.mkdirSync(path, { recursive: true });
  for (const path of [profile, other]) fs.writeFileSync(join(path, 'config.toml'), '# synthetic profile\n');
  let now = START;
  const setMaster = (experiments) => {
    const file = join(env.HUD_HOME, 'hud-settings.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify({ experiments }), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  };
  setMaster(enabled);
  const edit = (field, value) => saveExpEdit(env.HUD_HOME, { field, value }, now, env);
  edit('interval', 5);
  edit('proxy-enabled', true);
  if (bound) edit('binding', profile);
  const file = expProxyPath(env.HUD_HOME);
  return {
    env,
    profile,
    other,
    setMaster,
    edit,
    file,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    snapshot: () => readExpData(env.HUD_HOME, env).proxySnapshot,
  };
}

async function until(check, reason = 'condition did not settle') {
  for (let count = 0; count < 250; count++) {
    const value = check();
    if (value) return value;
    await sleep(10);
  }
  assert.fail(reason);
}

// The fake is the only `codex` discoverable by either the parent or footer workers.
function fakeCodex(f, mode = 'success') {
  const calls = join(f.env.HUD_HOME, 'calls.jsonl');
  const script = join(f.env.PATH, 'codex');
  fs.writeFileSync(
    script,
    `#!${process.execPath}
const fs = require('node:fs'), lines = require('node:readline').createInterface({input: process.stdin});
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let phase = 0;
lines.on('line', line => {
  const req = JSON.parse(line);
  if (req.method === 'initialize' && phase++ === 0) {
    send({ id: req.id, result: { userAgent: 'synthetic-app-server' } });
  } else if (req.method === 'initialized' && phase++ === 1) {
    send({ method: 'account/updated', params: { accountId: 'not-for-the-HUD' } });
  } else if (req.method === 'account/rateLimits/read' && phase++ === 2 && req.params.excludeResetCreditDetails === true) {
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), home: process.env.CODEX_HOME, hasAmbientAuth: !!process.env.CODEX_ACCESS_TOKEN }) + '\\n');
    if (${JSON.stringify(mode)} === 'timeout') return;
    if (${JSON.stringify(mode)} === 'retry') return send({ id: req.id, error: { code: 429, message: 'do not persist', data: { headers: { 'Retry-After': '900' } } } });
    setTimeout(() => send({ id: req.id, result: {
      rateLimitsByLimitId: { codex: ${JSON.stringify(windows)} },
      rateLimits: { primary: { usedPercent: 88 } }, accountId: 'do not persist', credits: { balance: '9999' }
    } }), 180);
  } else process.exit(7);
});`,
    { mode: 0o700 }
  );
  return () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : []);
}

const refresh = async (f, rpc) => {
  const current = await observeProxy(f.env);
  return current ? refreshProxyIfDue(f.env, current, () => true, { now: f.now, rpc }) : false;
};

test('footer paint starts a private, allowlisted first refresh and expires windows without inventing new quota', async (t) => {
  const f = fixture(t);
  const calls = fakeCodex(f);
  const p = proxyFooter(
    { ...f.env, CODEX_HOME: f.other, CODEX_ACCESS_TOKEN: 'synthetic-should-not-inherit' },
    { now: f.now }
  );
  t.after(p.stop);
  assert.equal(calls().length, 0, 'mounting a footer is not a refresh');
  assert.doesNotMatch(p.draw(), /≈/);
  assert.equal(calls().length, 0, 'draw returns before any RPC');
  const plain = await until(() => {
    const row = p.draw();
    return row.includes('7d ≈43%') && row;
  });
  assert.ok(visualLength(plain) <= 40, plain);
  assert.deepEqual(calls(), [
    { args: ['app-server', '--listen', 'stdio://'], cwd: '/', home: f.profile, hasAmbientAuth: false },
  ]);
  const data = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.deepEqual(data, {
    profile: f.profile,
    bindingVersion: data.bindingVersion,
    ...windows,
    observedAtMs: START,
    error: null,
    nextAttemptMs: START + 5 * MIN,
    failures: 0,
  });
  const inode = fs.statSync(f.file);
  assert.equal(inode.mode & 0o777, 0o600);

  const beforeReset = p.draw(100);
  assert.match(beforeReset, /7d ████░░░░░░ ≈43% \(7d\)  5h ≈28%$/);
  f.advance(6 * MIN);
  assert.match(p.draw(100), /7d ████░░░░░░ ≈43% \(6d23h\)  5h ↻$/);
  assert.doesNotMatch(p.draw(100), /100%|5h [█░]/);
  f.advance(5 * MIN);
  assert.match(p.draw(100), /7d ████░░░░░░ ≈43%\?  5h ↻$/);
  assert.doesNotMatch(beforeReset, /\?|↻/);
  await until(() => f.snapshot()?.observedAtMs === f.now());
  assert.notEqual(fs.statSync(f.file).ino, inode.ino, 'new snapshot replaces the old inode');
  assert.equal(calls().length, 2);
});

test('retry-after, exponential backoff and not-logged-in pause are persisted across paints', async (t) => {
  const f = fixture(t);
  const calls = fakeCodex(f, 'retry');
  assert.equal(await refresh(f), true);
  assert.equal(calls().length, 1);
  assert.equal(f.snapshot().error, 'rate_limited');
  assert.equal(f.snapshot().nextAttemptMs, START + 15 * MIN);
  assert.doesNotMatch(fs.readFileSync(f.file, 'utf8'), /do not persist|Retry-After/);
  f.advance(15 * MIN - 1);
  assert.equal(await refresh(f), false);
  assert.equal(calls().length, 1);
  f.advance(1);
  assert.equal(await refresh(f, async () => ({ error: 'request_failed' })), true);
  assert.equal(f.snapshot().nextAttemptMs, START + 25 * MIN);
  f.advance(10 * MIN);
  assert.equal(await refresh(f, async () => ({ error: 'not_logged_in' })), true);
  assert.equal(f.snapshot().nextAttemptMs, null);
  f.advance(1000 * MIN);
  assert.equal(await refresh(f), false);
  assert.equal(calls().length, 1);
  f.edit('proxy-enabled', false);
  f.edit('proxy-enabled', true);
  assert.equal(await refresh(f, async () => ({ windows })), true);
  assert.equal(f.snapshot().failures, 0);
});

test('the total deadline kills a fake app-server with an outstanding quota RPC', async (t) => {
  const f = fixture(t);
  const calls = fakeCodex(f, 'timeout');
  const reading = await observeProxy(f.env);
  assert.equal(await refreshProxyIfDue(f.env, reading, () => true, { now: f.now, timeoutMs: 500 }), true);
  assert.equal(calls().length, 1);
  assert.equal(f.snapshot().error, 'timeout');
  assert.equal(f.snapshot().observedAtMs, null);
  assert.equal(f.snapshot().nextAttemptMs, START + 5 * MIN);
});

test('rebind (including ABA), unbind and disable during an RPC fence the old result', async (t) => {
  const f = fixture(t);
  for (const change of [
    () => {
      f.edit('binding', f.other);
      f.edit('binding', f.profile);
    },
    () => f.edit('binding', null),
    () => f.edit('proxy-enabled', false),
    () => f.setMaster(false),
  ]) {
    const pending = Promise.withResolvers();
    const started = Promise.withResolvers();
    const result = refresh(f, async () => {
      started.resolve();
      return pending.promise;
    });
    await started.promise;
    change();
    pending.resolve({ windows });
    assert.equal(await result, false);
    assert.equal(fs.existsSync(f.file), false, 'old result was not written');
    f.setMaster(true);
    f.edit('binding', f.profile);
    f.edit('proxy-enabled', true);
  }
});

test('simultaneously painting worker processes send just one account RPC', async (t) => {
  const f = fixture(t);
  const calls = fakeCodex(f);
  const script = `
import { proxyFooter } from ${JSON.stringify(import.meta.resolve('../fakes/exp-proxy-footer.mjs'))};
const footer = proxyFooter(JSON.parse(process.env.FIXTURE_ENV), { now: () => ${START} });
process.once('message', () => { footer.draw(); footer.draw(); });
process.send('ready');
process.on('disconnect', footer.stop);`;
  const workers = Array.from({ length: 4 }, () =>
    spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...f.env, FIXTURE_ENV: JSON.stringify(f.env) },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    })
  );
  const exits = workers.map((child) => once(child, 'exit'));
  t.after(async () => {
    for (const child of workers) if (child.connected) child.disconnect();
    await Promise.all(exits);
  });
  await Promise.all(workers.map((child) => once(child, 'message')));
  for (const child of workers) child.send('draw');
  await until(() => f.snapshot());
  await sleep(120);
  assert.equal(calls().length, 1);
});

test('only openai OAuth shows windows; direct data wins and never survives its model or binding', async (t) => {
  const f = fixture(t);
  const p = proxyFooter(f.env, { now: f.now, rpc: async () => ({ windows }) });
  t.after(p.stop);
  await until(() => /5h ≈28%/.test(p.draw(100)));
  p.controller.requestStarted(p.ctx);
  p.controller.requestWindows(
    p.ctx,
    {
      headers: {
        'x-codex-primary-used-percent': '11',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': String(windows.primary.resetsAt),
      },
    },
    false
  );
  const normal = p.draw(100),
    narrow = p.draw(36);
  assert.match(normal, /7d ████░░░░░░ ≈43% \(7d\)  5h 11%$/);
  assert.match(narrow, /7d ≈43%$/);
  assert.doesNotMatch(narrow, /5h/);
  assert.ok(visualLength(narrow) <= 36);
  t.diagnostic(`pi footer 100 columns: ${normal}\npi footer 36 columns: ${narrow}`);
  p.controller.requestStarted(p.ctx);
  assert.match(p.draw(100), /5h ≈28%/);
  p.controller.requestWindows(
    p.ctx,
    {
      provider: 'openai',
      model: p.ctx.model.id,
      data: { type: 'codex.rate_limits', rate_limits: { primary: { used_percent: 12, window_minutes: 300 } } },
    },
    true
  );
  assert.match(p.draw(100), /≈43% \(7d\)  5h 12%$/);
  p.controller.requestStarted(p.ctx);
  p.controller.requestWindows(
    p.ctx,
    {
      provider: 'openai',
      model: p.ctx.model.id,
      data: { type: 'codex.rate_limits', rate_limits: { primary: { used_percent: 32, window_minutes: 10080 } } },
    },
    true
  );
  assert.match(p.draw(100), /7d ███░░░░░░░ 32%  5h ≈28%$/, 'evidence matches measured duration, not array position');
  p.ctx.model.id = 'a-different-model';
  p.controller.modelChanged();
  p.controller.update();
  assert.match(p.draw(100), /5h ≈28%/);
  p.ctx.model.provider = 'oapi';
  const quota = /(?:5h|7d) /;
  assert.doesNotMatch(p.draw(100), quota);
  p.ctx.model.provider = 'openai';
  p.oauth(false);
  assert.doesNotMatch(p.draw(100), quota);
  p.oauth(true);
  assert.match(p.draw(100), /5h ≈28%/);
  f.edit('binding', f.other);
  await until(() => !quota.test(p.draw(100)) || f.snapshot()?.profile === f.other);
  // The proxy refreshes on footer draws only, so keep drawing while waiting.
  await until(() => (p.draw(100), f.snapshot()?.profile === f.other));
  f.edit('binding', null);
  await until(() => !quota.test(p.draw(100)));
});

test('EXP off or unbound causes zero RPCs and leaves the 40-column footer unchanged', async (t) => {
  const off = fixture(t, false);
  const unbound = fixture(t, true, false);
  const enabled = fixture(t);
  const rpc = async () => {
    calls++;
    return { windows };
  };
  let calls = 0;
  const footers = [off, unbound, enabled].map((f) => proxyFooter(f.env, { now: f.now, rpc }));
  t.after(() => footers.forEach((p) => p.stop()));
  const before = footers[2].draw();
  for (const p of footers.slice(0, 2)) assert.equal(p.draw(), before);
  await until(() => footers[2].draw().includes('≈'));
  for (const p of footers.slice(0, 2)) assert.equal(p.draw(), before);
  assert.equal(calls, 1);
  enabled.setMaster(false);
  await until(() => footers[2].draw() === before);
  enabled.advance(20 * MIN);
  assert.equal(footers[2].draw(), before);
  assert.equal(calls, 1);
});

test('EXP shows live proxy and OpenAI grant readings at 40 columns', async (t) => {
  const f = fixture(t);
  await refresh(f, async () => ({ windows }));
  f.advance(6 * MIN);
  await refresh(f, async () => ({ error: 'timeout' }));
  for (const edit of [
    { field: 'grant-enabled', account: 'openai-api', value: true },
    { field: 'calibration', account: 'openai-api', value: 12_750_000 },
  ])
    await saveExpEdit(f.env.HUD_HOME, edit, f.now(), f.env);
  const expData = readExpData(f.env.HUD_HOME, f.env, f.now());
  const tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(0) };
  const old = setLanguage('en');
  t.after(() => setLanguage(old));
  for (const lang of ['en', 'zh'])
    for (const panelLayout of ['classic', 'split']) {
      setLanguage(lang);
      const draw = (detail) => {
        const frame = renderMonitor({
          tree,
          state: withState(initialMonitorState(), { activeTab: 'exp', prefs: { panelLayout, experiments: true }, exp: { detail, scroll: 0 } }),
          width: 40,
          height: 24,
          nowMs: f.now(),
          expData,
          modelEnabled: false,
        });
        for (const line of frame.lines) assert.equal(visualLength(line), 40);
        return frame.lines.map(stripAnsi).join('\n');
      };
      const plain = draw('proxy-status');
      assert.match(plain, lang === 'en' ? /Codex profile\s+\.codex/ : /Codex 配置\s+\.codex/);
      assert.match(plain, lang === 'en' ? /Primary window\s+5h refresh pending/ : /主窗口\s+5h 待刷新/);
      assert.match(plain, /7d ≈57%/);
      assert.match(plain, /2026-11-20 10:36Z/);
      assert.match(plain, /2026-11-27 10:30Z/);
      assert.match(plain, lang === 'en' ? /Source\s+Codex proxy/ : /来源\s+Codex 代理/);
      assert.match(plain, /2026-11-20 10:30Z/);
      assert.match(plain, lang === 'en' ? /Last error\s+Timed out/ : /最近错误\s+请求超时/);
      assert.match(plain, /2026-11-20 10:41Z/);
      assert.match(draw('openai-api'), lang === 'en' ? /Estimated remaining\s+≈\$12\.75/ : /估算剩余\s+≈\$12\.75/);
    }
});
