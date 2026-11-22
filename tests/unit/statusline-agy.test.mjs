import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const bin = resolve('bin/hud-statusline');
const email = 'user@example.invalid';
const cwd = '/synthetic/work/demo';
const model = { id: 'gemini-4-carbon-high', display_name: 'Gemini 4 Carbon (High)' };
const thirdParty = { id: 'claude-example', display_name: 'Claude Example' };
const fixtureAt = Date.now();
const bucket = (remaining_fraction, reset_in_seconds) => ({
  remaining_fraction,
  reset_time: new Date(fixtureAt + reset_in_seconds * 1000).toISOString(),
  reset_in_seconds,
});
const quota = {
  '3p-5h': bucket(1, 18000),
  '3p-weekly': bucket(1, 604800),
  'gemini-5h': bucket(0.9121235, 7143),
  'gemini-weekly': bucket(0.9780309, 593943),
};
const payload = {
  product: 'antigravity', email, model, cwd, workspace: { current_dir: cwd, project_dir: cwd },
  terminal_width: 220, session_id: '', conversation_id: 'synthetic-conversation', version: '1.5.14',
  context_window: { used_percentage: 35, remaining_percentage: 65, context_window_size: 200000,
    total_input_tokens: 70000, total_output_tokens: 700, current_usage: null },
  agent_state: 'working', plan_tier: 'Example Plan', quota, cost: null,
};
const fresh = {
  ...payload, conversation_id: '', agent_state: 'idle', quota: {},
  context_window: Object.fromEntries(Object.keys(payload.context_window).map((key) => [key, 0])),
};
const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
const plain = '▲ Gemini 4 Carbon (High) │ ████░░░░░░ 35%/200K │ demo';
const wide = `${plain} │ 5h 91% left  7d 98% left`;

function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-statusline-agy-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hud = join(home, 'hud');
  fs.mkdirSync(hud);
  const env = { ...process.env, HOME: home, HUD_HOME: hud, CLAUDE_CONFIG_DIR: join(home, 'claude'), NO_COLOR: '1' };
  // Do not inherit the caller's HUD bar overrides or another pane's data.
  for (const key of Object.keys(env)) {
    if (/^(?:CODEX_)?HUD_(THEME|ICONS|BAR_FIELDS|BAR_STYLE|SETTINGS_PATH)$/.test(key) || key === 'HERDR_PANE_ID')
      delete env[key];
  }
  const run = (value, args = [], executable = bin) => {
    const result = spawnSync(executable, args, {
      input: typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value),
      env, encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(!result.stdout.includes(email), 'email never goes to stdout');
    return strip(result.stdout);
  };
  return { home, hud, env, run };
}

test('Antigravity renders fresh/mid-turn/quotas, EN/ZH details and the caller width', (t) => {
  const { run } = fixture(t);
  assert.equal(run(fresh), '▲ Gemini 4 Carbon (High) │ ░░░░░░░░░░ 0% │ demo');
  assert.equal(run({ ...payload, quota: null }), plain);
  assert.equal(run(payload), wide);
  assert.equal(run({ ...payload, terminal_width: 40 }), '▲ Gemini 4 Carbon (High) │ 35%');
  assert.equal(run({ ...payload, terminal_width: 40 }, ['--width', '220']), wide);
  assert.equal(run(payload, ['--details', '--lang', 'en']),
    'model Gemini 4 Carbon (High) · ctx [###-------] 35% · cwd /synthetic/work/demo · left 65% · in 70000 tokens · out 700 tokens · window 200000 tokens · 5h 91% left · 7d 98% left');
  assert.equal(run(payload, ['--details', '--lang', 'zh']),
    '模型 Gemini 4 Carbon (High) · 上下文 [###-------] 35% · 目录 /synthetic/work/demo · 剩余 65% · 输入 70000 词元 · 输出 700 词元 · 容量 200000 词元 · 5h 91% left · 7d 98% left');
  assert.equal(run(fresh, ['--details', '--lang', 'en']),
    'model Gemini 4 Carbon (High) · ctx [----------] 0% · cwd /synthetic/work/demo · left 0% · in 0 tokens · out 0 tokens');
  assert.equal(run(fresh, ['--details', '--lang', 'zh']),
    '模型 Gemini 4 Carbon (High) · 上下文 [----------] 0% · 目录 /synthetic/work/demo · 剩余 0% · 输入 0 词元 · 输出 0 词元');
});

test('Antigravity quota follows the model id or display name without falling back to another family', (t) => {
  const { run } = fixture(t);
  const thirdPartyPlain = '✻ Claude Example │ ████░░░░░░ 35%/200K │ demo';
  assert.equal(run({ ...payload, model: thirdParty }), `${thirdPartyPlain} │ 5h 100% left  7d 100% left`);
  assert.equal(run({ ...payload, quota: { '3p-5h': quota['3p-5h'] } }), plain);
  assert.equal(run({ ...payload, model: thirdParty, quota: { 'gemini-5h': quota['gemini-5h'] } }), thirdPartyPlain);
  assert.match(run({ ...payload, model: { id: thirdParty.id, display_name: 'gEmInI Example' } }), /5h 91% left  7d 98% left$/);
  assert.match(run({ ...payload, model: { id: 'GEMINI-example', display_name: 'Carbon Example' } }), /5h 91% left  7d 98% left$/);
});

test('Antigravity skips expired, invalid and unknown quota buckets and clamps finite fractions', (t) => {
  const { run } = fixture(t);
  assert.equal(run({ ...payload, quota: {
    'gemini-5h': { ...quota['gemini-5h'], reset_time: '2000-01-01T00:00:00Z' },
    'gemini-weekly': quota['gemini-weekly'],
    'gemini-monthly': quota['gemini-5h'],
  } }), `${plain} │ 7d 98% left`);
  assert.equal(run({ ...payload, quota: {
    'gemini-5h': { ...quota['gemini-5h'], remaining_fraction: '0.9' },
    'gemini-weekly': { ...quota['gemini-weekly'], reset_time: 'not a date' },
  } }), plain);
  assert.equal(run({ ...payload, quota: {
    'gemini-5h': { window_minutes: 300, remaining_percentage: 80 },
    'gemini-weekly': { remaining_fraction: 0.9 },
  } }), plain);
  assert.equal(run({ ...payload, quota: {
    'gemini-5h': bucket(-0.25, 7143),
    'gemini-weekly': bucket(1.25, 593943),
  } }), `${plain} │ 5h 0% left  7d 100% left`);
});

test('Antigravity ignores transcript, Claude quota publication and raw forwarding; unknown input degrades', async (t) => {
  const { hud, home, run } = fixture(t);
  const transcript_path = join(home, 'transcript.jsonl');
  const script = join(home, 'forward.mjs');
  const receipt = join(home, 'forwarded');
  fs.writeFileSync(transcript_path, '{"type":"synthetic-transcript"}\n');
  fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(receipt)}, 'called');`);
  fs.writeFileSync(join(hud, 'config.json'), JSON.stringify({ statusline: { forward: [process.execPath, script] } }));
  const input = { ...payload, transcript_path, rate_limits: { five_hour: { used_percentage: 20 } } };
  assert.equal(run(input), wide);
  assert.equal(run(input, [bin], process.execPath), wide, 'node bin/hud-statusline stays compatible');
  for (const bad of ['', '{broken', '{}', '[1]', { product: 'unsupported', model }, { product: 'antigravity', email }, Buffer.alloc(65537, 32)])
    assert.equal(run(bad), 'HUD unavailable');
  await delay(200);
  assert.ok(!fs.existsSync(receipt));
  assert.ok(!fs.existsSync(join(hud, 'display', 'statusline')), 'no transcript or context cache');
  assert.ok(!fs.existsSync(join(hud, 'display', 'state', 'claude-quota.json')));
});

// A fake agy remains the parent across redraws. `sh -c` adds the same transient wrapper as a shell statusLine command.
function agyCaller(t, shim, env) {
  const caller = spawn(process.execPath, ['--input-type=module', '-e', `
    import { spawnSync } from 'node:child_process';
    import { createInterface } from 'node:readline';
    process.title = 'agy';
    for await (const line of createInterface({ input: process.stdin })) {
      const { input, cwd } = JSON.parse(line);
      const child = spawnSync('sh', ['-c', '"$1"; exit $?', 'sh', ${JSON.stringify(shim)}], {
        input, cwd, encoding: 'utf8', timeout: 10000,
      });
      console.log(JSON.stringify({ status: child.status, stdout: child.stdout, stderr: child.stderr }));
    }
  `], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => caller.kill());
  const replies = createInterface({ input: caller.stdout })[Symbol.asyncIterator]();
  return async (value, cwd) => {
    caller.stdin.write(JSON.stringify({ input: typeof value === 'string' ? value : JSON.stringify(value), cwd }) + '\n');
    const reply = await replies.next();
    assert.ok(!reply.done, 'fake agy exited before replying');
    const { status, stdout, stderr } = JSON.parse(reply.value);
    assert.equal(status, 0, stderr);
    assert.equal(stderr, '');
    assert.ok(!stdout.includes(email));
    return strip(stdout);
  };
}

test('Antigravity cache revalidates by age, isolates callers and recovers from corruption or a dead worker', { timeout: 20000 }, async (t) => {
  if (spawnSync('bash', ['-c', 'for c in flock setsid timeout sha256sum; do command -v "$c" || exit 1; done']).status !== 0)
    return t.skip('Linux cache helpers unavailable');
  const { home, hud, env } = fixture(t);
  const shim = join(home, 'hud-statusline');
  fs.symlinkSync(bin, shim);
  const fromAgy = agyCaller(t, shim, env);
  const dir = join(hud, 'display', 'statusline-agy-v1');
  assert.equal(await fromAgy(payload), wide);
  const names = fs.readdirSync(dir);
  const cache = join(dir, names.find((name) => name.endsWith('.line')));
  const marker = cache.replace(/\.line$/, '.refresh');
  const raw = fs.readFileSync(cache, 'utf8');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(cache).mode & 0o777, 0o600);
  assert.doesNotMatch(raw, /synthetic-conversation|user@example\.invalid/);

  const changed = { ...payload, quota: { 'gemini-5h': bucket(0.25, 7143) } };
  const next = `${plain} │ 5h 25% left`;
  assert.equal(await fromAgy(changed), wide, 'returns the previous line within the fresh interval');
  const makeStale = () => fs.writeFileSync(cache, fs.readFileSync(cache, 'utf8').replace(
    /^([a-f0-9]+ [a-f0-9]+) \d+ /, `$1 ${Date.now() - 1500} `));
  makeStale();
  const seen = await fromAgy(changed);
  assert.ok(seen === wide || seen === next, `got ${seen}`);
  for (let i = 0; i < 300 && !fs.readFileSync(cache, 'utf8').includes('25% left'); i++) await delay(10);
  assert.match(fs.readFileSync(cache, 'utf8'), /25% left/);
  for (let i = 0; i < 300 && fs.existsSync(marker); i++) await delay(10);

  fs.writeFileSync(marker, '', { mode: 0o600 }); // no live holder of the slot lock
  assert.equal(await fromAgy(payload), wide, 'an orphaned refresh synchronously restores the new frame');
  assert.ok(!fs.existsSync(marker));
  fs.appendFileSync(cache, 'corrupt payload\n');
  assert.equal(await fromAgy(payload), wide, 'corrupt content is never displayed');
  makeStale();
  await fromAgy('{broken');
  for (let i = 0; i < 300 && fs.existsSync(cache); i++) await delay(10);
  assert.ok(!fs.existsSync(cache), 'a failed renderer discards the stale frame');
  assert.equal(await fromAgy('{broken'), 'HUD unavailable', 'the next frame falls back to a synchronous render');
  assert.equal(await fromAgy(payload), wide);
  assert.equal(await agyCaller(t, shim, env)(changed), next, 'another caller cannot see the previous frame');
  assert.equal(await fromAgy(changed, home), next, 'same caller at another cwd also has a cold frame');
});
