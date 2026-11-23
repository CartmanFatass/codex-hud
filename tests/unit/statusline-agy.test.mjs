import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createWorkSummaryPublisher } from '../../dist/collectors/work-summary-snapshot.js';

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
  const run = (value, args = [], executable = bin) =>
    new Promise((resolveRun, rejectRun) => {
      const child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); rejectRun(new Error('timeout')); }, 30000);
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.on('error', (err) => { clearTimeout(timer); rejectRun(err); });
      child.on('close', (status) => {
        clearTimeout(timer);
        try {
          assert.equal(status, 0, stderr);
          assert.equal(stderr, '');
          assert.ok(!stdout.includes(email), 'email never goes to stdout');
          assert.ok(!stdout.includes('\x1b'), 'NO_COLOR disables terminal escapes');
          resolveRun(strip(stdout));
        } catch (err) { rejectRun(err); }
      });
      child.stdin.end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    });
  return { home, hud, env, run };
}

test('Antigravity renders fresh/mid-turn/quotas, EN/ZH details and the caller width', async (t) => {
  const { run } = fixture(t);
  const results = await Promise.all([
    run(fresh),
    run({ ...payload, quota: null }),
    run(payload),
    run({ ...payload, terminal_width: 40 }),
    run({ ...payload, terminal_width: 40 }, ['--width', '220']),
    run(payload, ['--details', '--lang', 'en']),
    run(payload, ['--details', '--lang', 'zh']),
    run(fresh, ['--details', '--lang', 'en']),
    run(fresh, ['--details', '--lang', 'zh']),
  ]);
  assert.deepEqual(results, [
    '▲ Gemini 4 Carbon (High) │ ░░░░░░░░░░ 0% │ demo',
    plain,
    wide,
    '▲ Gemini 4 Carbon (High) │ 35%',
    wide,
    'model Gemini 4 Carbon (High) · ctx [###-------] 35% · cwd /synthetic/work/demo · left 65% · in 70000 tokens · out 700 tokens · window 200000 tokens · 5h 91% left · 7d 98% left',
    '模型 Gemini 4 Carbon (High) · 上下文 [###-------] 35% · 目录 /synthetic/work/demo · 剩余 65% · 输入 70000 词元 · 输出 700 词元 · 容量 200000 词元 · 5h 91% left · 7d 98% left',
    'model Gemini 4 Carbon (High) · ctx [----------] 0% · cwd /synthetic/work/demo · left 0% · in 0 tokens · out 0 tokens',
    '模型 Gemini 4 Carbon (High) · 上下文 [----------] 0% · 目录 /synthetic/work/demo · 剩余 0% · 输入 0 词元 · 输出 0 词元',
  ]);
});

test('Antigravity draws machine-wide counts, including long-running jobs outside the caller pane', async (t) => {
  const { hud, run } = fixture(t);
  const publisher = createWorkSummaryPublisher(hud, 'hud-watch');
  fs.writeFileSync(join(hud, 'watch.pid'), `${process.pid}\n`);
  const pane = 'w4E:p1', id = 'j0000000000000001';
  const dir = join(hud, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();
  fs.writeFileSync(
    join(dir, 'job.json'),
    JSON.stringify({ job: id, role: 'imp', model: 'gpt-6.2-sol-fast', thinking: 'high', herdr_pane: pane, created_at: ago(1800) })
  );
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working', started_at: ago(1800) }));
  fs.writeFileSync(join(dir, 'brief.md'), '# Secret heading');
  assert.equal(publisher.publish({ watching: true }), true);
  assert.equal(await run(payload), `${wide} │ HUD (OS): 1 running, 0 queued`);
  assert.match(await run(payload, ['--details']), /\nHUD \(OS\): 1 running, 0 queued$/);
  // A job settled seconds ago, report unread, is not counted: only the running one is.
  const done = 'j0000000000000002', doneDir = join(hud, 'jobs', done);
  fs.mkdirSync(doneDir, { recursive: true });
  fs.writeFileSync(
    join(doneDir, 'job.json'),
    JSON.stringify({ job: done, role: 'imp', model: 'gpt-6.2-sol-fast', thinking: 'high', herdr_pane: pane, created_at: ago(60) })
  );
  fs.writeFileSync(join(doneDir, 'STATUS.json'), JSON.stringify({ state: 'closed', settled_at: ago(10) }));
  fs.writeFileSync(join(doneDir, 'report.md'), 'Done.');
  assert.equal(publisher.publish({ watching: true }), false);
  assert.equal(await run(payload), `${wide} │ HUD (OS): 1 running, 0 queued`);
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'closed', settled_at: ago(5) }));
  assert.equal(publisher.publish({ watching: true }), true);
  assert.equal(await run(payload), `${wide} │ HUD (OS): 0 running, 0 queued`);
});

test('Antigravity quota follows the model id or display name without falling back to another family', async (t) => {
  const { run } = fixture(t);
  const thirdPartyPlain = '✻ Claude Example │ ████░░░░░░ 35%/200K │ demo';
  const [tp, only3p, tpGem, mixedName, mixedId] = await Promise.all([
    run({ ...payload, model: thirdParty }),
    run({ ...payload, quota: { '3p-5h': quota['3p-5h'] } }),
    run({ ...payload, model: thirdParty, quota: { 'gemini-5h': quota['gemini-5h'] } }),
    run({ ...payload, model: { id: thirdParty.id, display_name: 'gEmInI Example' } }),
    run({ ...payload, model: { id: 'GEMINI-example', display_name: 'Carbon Example' } }),
  ]);
  assert.equal(tp, `${thirdPartyPlain} │ 5h 100% left  7d 100% left`);
  assert.equal(only3p, plain);
  assert.equal(tpGem, thirdPartyPlain);
  assert.match(mixedName, /5h 91% left  7d 98% left$/);
  assert.match(mixedId, /5h 91% left  7d 98% left$/);
});

test('Antigravity skips expired, invalid and unknown quota buckets and clamps finite fractions', async (t) => {
  const { run } = fixture(t);
  const results = await Promise.all([
    run({ ...payload, quota: {
      'gemini-5h': { ...quota['gemini-5h'], reset_time: '2000-01-01T00:00:00Z' },
      'gemini-weekly': quota['gemini-weekly'],
      'gemini-monthly': quota['gemini-5h'],
    } }),
    run({ ...payload, quota: {
      'gemini-5h': { ...quota['gemini-5h'], remaining_fraction: '0.9' },
      'gemini-weekly': { ...quota['gemini-weekly'], reset_time: 'not a date' },
    } }),
    run({ ...payload, quota: {
      'gemini-5h': { window_minutes: 300, remaining_percentage: 80 },
      'gemini-weekly': { remaining_fraction: 0.9 },
    } }),
    run({ ...payload, quota: {
      'gemini-5h': bucket(-0.25, 7143),
      'gemini-weekly': bucket(1.25, 593943),
    } }),
  ]);
  assert.deepEqual(results, [`${plain} │ 7d 98% left`, plain, plain, `${plain} │ 5h 0% left  7d 100% left`]);
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
  const badInputs = ['', '{broken', '{}', '[1]', { product: 'unsupported', model }, { product: 'antigravity', email }, Buffer.alloc(65537, 32)];
  const [direct, viaNode, ...badOut] = await Promise.all([
    run(input),
    run(input, [bin], process.execPath),
    ...badInputs.map((bad) => run(bad)),
  ]);
  assert.equal(direct, wide);
  assert.equal(viaNode, wide, 'node bin/hud-statusline stays compatible');
  for (const out of badOut) assert.equal(out, 'HUD unavailable');
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
      const { input, cwd, args } = JSON.parse(line);
      const child = spawnSync('sh', ['-c', '"$@"; exit $?', 'sh', ${JSON.stringify(shim)}, ...args], {
        input, cwd, encoding: 'utf8', timeout: 10000,
      });
      console.log(JSON.stringify({ status: child.status, stdout: child.stdout, stderr: child.stderr }));
    }
  `], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise((done) => caller.once('exit', done));
  t.after(async () => { caller.stdin.end(); await exited; });
  const replies = createInterface({ input: caller.stdout })[Symbol.asyncIterator]();
  return async (value, cwd, args = []) => {
    caller.stdin.write(JSON.stringify({ input: typeof value === 'string' ? value : JSON.stringify(value), cwd, args }) + '\n');
    const reply = await replies.next();
    assert.ok(!reply.done, 'fake agy exited before replying');
    const { status, stdout, stderr } = JSON.parse(reply.value);
    assert.equal(status, 0, stderr);
    assert.equal(stderr, '');
    assert.ok(!stdout.includes(email));
    assert.ok(!stdout.includes('\x1b'), 'NO_COLOR disables terminal escapes on the cache path');
    return strip(stdout);
  };
}

test('Antigravity cache revalidates by age, isolates callers and recovers from corruption or a dead worker', { timeout: 60000 }, async (t) => {
  if (!fs.existsSync(resolve('dist/native/hud-statusline'))) return t.skip('native cache unavailable');
  const helpers = spawnSync('sh', ['-c', 'command -v setsid >/dev/null && command -v timeout'], { encoding: 'utf8' });
  if (helpers.status !== 0) return t.skip('Linux refresh helpers unavailable');
  const { home, hud, env } = fixture(t);
  // This scenario tests caching, not the production 2 s cold-render cutoff. Keep a watchdog
  // but allow Node to start under load; the installed launcher and timeout are unchanged.
  const helpersDir = join(home, 'bin');
  fs.mkdirSync(helpersDir);
  fs.writeFileSync(join(helpersDir, 'timeout'), `#!/bin/sh\nif [ "$1" = -k ] && [ "$2" = .2s ] && [ "$3" = 2s ]; then\n  shift 3\n  set -- -k .2s 8s "$@"\nfi\nexec "${helpers.stdout.trim()}" "$@"\n`, { mode: 0o700 });
  env.PATH = `${helpersDir}:${env.PATH}`;
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
  assert.equal(await fromAgy(changed, undefined, ['--agy-render']), wide, 'explicit agy render shares the verified caller cache');
  const makeStale = (age = 1500) => fs.writeFileSync(cache, fs.readFileSync(cache, 'utf8').replace(
    /^([a-f0-9]+ [a-f0-9]+) \d+ /, `$1 ${Date.now() - age} `));
  makeStale(3100);
  assert.equal(await fromAgy(changed), next, 'a frame beyond the stale cap is never served');
  fs.writeFileSync(join(hud, 'config.json'), '{}');
  assert.equal(await fromAgy(payload), wide, 'config changes invalidate even a fresh frame');
  makeStale();
  const seen = await fromAgy(changed);
  assert.ok(seen === wide || seen === next, `got ${seen}`);
  while (!fs.readFileSync(cache, 'utf8').includes('25% left') || fs.existsSync(marker))
    await delay(20, null, { signal: t.signal });
  assert.match(fs.readFileSync(cache, 'utf8'), /25% left/);

  fs.writeFileSync(marker, '', { mode: 0o600 }); // no live holder of the slot lock
  assert.equal(await fromAgy(payload), wide, 'an orphaned refresh synchronously restores the new frame');
  assert.ok(!fs.existsSync(marker));
  fs.appendFileSync(cache, 'corrupt payload\n');
  assert.equal(await fromAgy(payload), wide, 'corrupt content is never displayed');
  makeStale();
  await fromAgy('{broken');
  while (fs.existsSync(cache) || fs.existsSync(marker)) await delay(20, null, { signal: t.signal });
  assert.ok(!fs.existsSync(cache), 'a failed renderer discards the stale frame');
  assert.equal(await fromAgy('{broken'), 'HUD unavailable', 'the next frame falls back to a synchronous render');
  assert.equal(await fromAgy(payload), wide);
  assert.equal(await agyCaller(t, shim, env)(changed), next, 'another caller cannot see the previous frame');
  assert.equal(await fromAgy(changed, home), next, 'same caller at another cwd also has a cold frame');
});
