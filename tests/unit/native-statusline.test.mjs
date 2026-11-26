import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { parityFixture } from '../../dist-test/fixtures/claude-hud-parity/fixture.js';
import { syntheticProc } from '../fixtures/local-load.mjs';

const launcher = resolve('bin/hud-statusline');
const native = resolve('dist/native/hud-statusline');
const base = {
  model: { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
  context_window: { used_percentage: 42, context_window_size: 200000 },
  rate_limits: { five_hour: { used_percentage: 22 }, seven_day: { used_percentage: 84 } },
};
const syntheticEmail = 'synthetic@example.invalid';
const start = process.platform === 'linux' ? fs.readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1).split(' ')[19] : null;
const linuxX64 = process.platform === 'linux' && process.arch === 'x64';
const toolchain = linuxX64 && spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0;
const hasNative = fs.existsSync(native);
function receipt(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-native-statusline-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function setup(hud) {
  fs.mkdirSync(join(hud, 'display'), { recursive: true, mode: 0o700 });
  const scope = { running: 3, asking: 1, roles: { imp: { running: 1, asking: 0 }, sonic: { running: 2, asking: 1 } } };
  const file = join(hud, 'display/work-summary.v1.json');
  const write = (extra = {}) => fs.writeFileSync(file, JSON.stringify({
    version: 1, producer: 'hud-watch', pid: process.pid, pid_start: start, generation: 1,
    observed_at: 1000, watching: true, complete: true, global: { ...scope, queued: 1 }, panes: { 'synthetic-pane': scope }, ...extra,
  }), { mode: 0o600 });
  fs.writeFileSync(join(hud, 'watch.pid'), `${process.pid}\n`);
  write();
  return { file, write };
}
function environment(home) {
  return { HOME: home, HUD_HOME: join(home, 'hud'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    HUD_STATUSLINE_PROC_ROOT: join(home, 'proc'), PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC' };
}
function run(cmd, args, env, input, status = 0) {
  if (!Buffer.isBuffer(input) && typeof input !== 'string') input = JSON.stringify(input);
  const r = spawnSync(cmd, args, { env, input, timeout: 7000 });
  assert.equal(r.error, undefined, `${cmd}: ${r.error}`);
  assert.equal(r.status, status, `${cmd}: ${r.stderr}`);
  assert.equal(r.stderr.toString(), '');
  return r.stdout;
}
const ts = (env, input, args = []) => run(process.execPath, [launcher, ...args], env, input);
const rust = (env, input, args = [], status = 0) => run(native, args, env, input, status);

test('native build is present when Cargo and the Linux x64 target are available', { skip: !toolchain }, () => {
  assert.ok(hasNative, 'run npm run build before the differential gate');
});

test('Claude launcher uses TypeScript for a live even quota notice and native can render again after expiry', { skip: !hasNative }, (t) => {
  const env = { ...environment(receipt(t)), HUD_ICONS: 'unicode', NO_COLOR: '1' };
  setup(env.HUD_HOME);
  const bin = join(env.HOME, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  env.PATH = `${bin}:${env.PATH}`;
  const fast = { harness: 'pi', model: 'synthetic/fast' };
  fs.mkdirSync(join(env.HUD_HOME, 'roles'));
  fs.writeFileSync(join(env.HUD_HOME, 'roles', 'imp.json'), JSON.stringify({ role: 'imp', instructions: 'implementer',
    can_continue: true, run: [fast], presets: [{ name: 'fast', run: [fast] }] }));
  fs.writeFileSync(join(env.HUD_HOME, 'hud-settings.json'), JSON.stringify({ impPlacement: 'even', impEvenPool: ['fast'] }));
  const writeMark = (at) => fs.writeFileSync(join(env.HUD_HOME, 'exhausted.json'), JSON.stringify({ version: 1,
    places: { 'pi:synthetic/fast': { reason: 'quota', until: new Date(at).toISOString() } } }), { mode: 0o600 });
  const agy = { ...base, product: 'antigravity' };
  writeMark(Date.now() + 60_000);
  assert.equal(rust(env, base, [], 75).length, 0);
  const reference = ts(env, base);
  assert.match(reference.toString(), /⚠ imp fast: quota │ ⚒1/);
  assert.deepEqual(run(launcher, [], env, base), reference);
  assert.match(run(launcher, [], env, agy).toString(), /⚠ imp fast: quota │ ⚒1/);
  writeMark(Date.now() - 1);
  const restored = rust(env, base);
  assert.doesNotMatch(restored.toString(), /imp fast: quota/);
  assert.deepEqual(restored, ts(env, base));
  assert.doesNotMatch(run(launcher, [], env, agy).toString(), /imp fast: quota/);
});

test('Claude keeps native rendering with advisor shadow on unless a notice is live', { skip: !hasNative }, (t) => {
  const env = { ...environment(receipt(t)), NO_COLOR: '1' };
  setup(env.HUD_HOME);
  const settings = join(env.HUD_HOME, 'hud-settings.json');
  const advisorRulesFile = join(env.HOME, 'rules.md');
  fs.writeFileSync(settings, JSON.stringify({ advisorShadow: true, advisorRulesFile, icons: 'text' }));
  const input = { ...base, session_id: 'synthetic-session' };
  const nativeBar = () => {
    const line = rust(env, input);
    assert.ok(line.length > 0);
    assert.doesNotMatch(line.toString(), /skill:|rules:/);
    assert.deepEqual(line, ts(env, input));
  };
  nativeBar(); // Enabled, no display state yet.

  const notice = { session: input.session_id, projectRoot: env.HOME };
  const skill = { ...notice, skill: 'tdd', path: join(env.HOME, 'SKILL.md'), ms: 20 };
  const rule = { ...notice, rules: [{ id: 'R2', sentence: 'Name the tests run.' }] };
  const skillFile = join(env.HUD_HOME, 'display', 'advisor-state.json');
  const ruleFile = join(env.HUD_HOME, 'display', 'advisor-rules.json');
  const writeSkill = (recommendations) => fs.writeFileSync(skillFile, JSON.stringify({ version: 1, recommendations, messages: [] }), { mode: 0o600 });
  const writeRules = (hits) => fs.writeFileSync(ruleFile, JSON.stringify({ replies: ['synthetic-reply'], hits }), { mode: 0o600 });
  writeSkill([]);
  writeRules([]);
  nativeBar(); // Fresh state (e.g. a no-hit reply) is not itself a notice.

  const expired = Date.now() - 10 * 60_000 - 1000;
  writeSkill([{ ...skill, at: expired }]);
  writeRules([{ ...rule, at: expired }]);
  nativeBar(); // A fresh mtime cannot renew an expired notice.
  const old = new Date(expired);
  fs.utimesSync(skillFile, old, old);
  fs.utimesSync(ruleFile, old, old);
  nativeBar(); // An old inode does not need to be parsed.

  const expectFallback = (text) => {
    assert.equal(rust(env, input, [], 75).length, 0);
    const reference = ts(env, input);
    assert.ok(reference.toString().includes(text));
    assert.deepEqual(run(launcher, [], env, input), reference);
  };
  writeSkill([{ ...skill, at: Date.now() }]);
  expectFallback('skill: tdd');
  writeSkill([{ ...skill, at: expired }]);
  writeRules([{ ...rule, at: Date.now() }]);
  expectFallback('rules: R2');
  writeRules([{ ...rule, at: expired }]);
  nativeBar();
});

test('native compact Claude bar matches TypeScript byte-for-byte', { skip: !hasNative }, (t) => {
  const env = { ...environment(receipt(t)), HERDR_PANE_ID: 'synthetic-pane' };
  setup(env.HUD_HOME);
  const cjk = { ...base, model: { display_name: '虚构苏州🧪 工作者' }, context_window: { used_percentage: 76.5 } };
  const ansi = { ...base, model: { display_name: '甲\x1b[31m\n\t\x00\u202e乙' }, cwd: join(env.HOME, '项目') };
  fs.mkdirSync(ansi.cwd);
  const rows = [
    ['Claude', base, {}, []],
    ['GLM uncoloured mark', { ...base, model: { id: 'glm-4.7' } }, { HUD_BAR_STYLE: 'line' }, []],
    ['GLM powerline mark', { ...base, model: { id: 'glm-4.7' } }, { HUD_BAR_STYLE: 'p10k' }, []],
    ['CJK truncation', cjk, {}, ['--width', '9']],
    ['ANSI in external text', ansi, {}, ['--width', '70']],
    ['NO_COLOR and text icons', base, { NO_COLOR: '1', HUD_ICONS: 'text', COLUMNS: '86' }, []],
    ['unicode icons', base, { HUD_ICONS: 'unicode', COLUMNS: '86' }, []],
    ['narrow width from the environment', base, { COLUMNS: '5' }, []],
    ['powerline, no capsule parity regressions', base, { HUD_BAR_STYLE: 'p10k' }, []],
    ['machine load and RGB palette', base, { HUD_THEME: 'mocha' }, []],
    ['fields and hide Bedrock quota', { ...base, model: { id: 'us.anthropic.claude-sonnet-4-20250514-v1:0' } },
      { HUD_BAR_FIELDS: 'model,quota' }, []],
    ['zero reset/cost are still facts', { cost: { total_cost_usd: 0 }, context_window: { context_window_size: 200000 } }, {}, []],
    ['malformed', '{not-json', {}, ['--width', '8']],
    ['invalid UTF-8', Buffer.from([0xc3, 0x28]), {}, []],
    ['oversize', Buffer.alloc(65537, 32), {}, []],
  ];
  for (const [label, input, extra, args] of rows) {
    const childEnv = { ...env, ...extra };
    assert.deepEqual(rust(childEnv, input, args), ts(childEnv, input, args), label);
  }
  const file = join(env.HUD_HOME, 'hud-settings.json');
  const lineEnv = { ...env, HUD_BAR_STYLE: 'line' }, capsuleEnv = { ...env, HUD_BAR_STYLE: 'p10k' };
  const line = ts(lineEnv, base), capsules = ts(capsuleEnv, base);
  for (const [style, childEnv, expected] of [['line', capsuleEnv, line], ['p10k', lineEnv, capsules]]) {
    fs.writeFileSync(file, JSON.stringify({ barStyle: style }), { mode: 0o600 });
    assert.deepEqual(ts(childEnv, base), expected, `saved ${style}`);
    assert.deepEqual(rust(childEnv, base), expected, `native saved ${style}`);
  }
  for (const style of ['gauge', 'tide', 'micro', 'stacked', 'headline', 'triptych']) {
    fs.writeFileSync(file, JSON.stringify({ barStyle: style }));
    assert.deepEqual(rust(capsuleEnv, base), line, `retired ${style} renders as native line`);
  }
  // Saved and inherited icon sets are byte-identical, including the Nerd Font queue clock.
  const bar = (icons) => {
    if (icons) fs.writeFileSync(file, JSON.stringify({ icons }), { mode: 0o600 });
    else fs.rmSync(file, { force: true });
    const childEnv = { ...env, HUD_ICONS: icons ?? 'nerd', NO_COLOR: '1', COLUMNS: '160' };
    const out = ts(childEnv, base);
    assert.deepEqual(rust(childEnv, base), out, `icons ${icons}`);
    assert.doesNotMatch(out.toString(), /\x1b/);
    return out.toString();
  };
  for (const [icons, expected] of [[undefined, '\uF0AD1  \uF0E72  \uF0171'], ['unicode', '⚒1  ⚡2  ◷1'],
    ['text', 'I1  *2  Q1'], ['emoji', '⚒1  ⚡2  ◷1']]) {
    const out = bar(icons);
    assert.ok(out.includes(`│ ${expected}`), out);
  }
  fs.writeFileSync(file, JSON.stringify({ icons: 'unicode', theme: 'none', barFields: ['notice'] }));
  for (const [width, expected] of [[12, '⚒1  ⚡2  ◷1'], [9, '⚒1 ⚡2 ◷1'], [6, '⚒1 ⚡2'], [5, '']]) {
    const args = ['--width', String(width)];
    assert.equal(rust(env, base, args).toString().trimEnd(), expected);
    assert.deepEqual(rust(env, base, args), ts(env, base, args));
  }
  fs.rmSync(join(env.HUD_HOME, 'hud-settings.json'), { force: true });
  const exact = Buffer.from(JSON.stringify(base).padEnd(65536, ' '));
  assert.deepEqual(run(launcher, [], env, exact), rust(env, exact), 'exactly 64 KiB remains valid');
  assert.deepEqual(run(launcher, [], env, Buffer.concat([exact, Buffer.from([0])])), ts(env, Buffer.alloc(65537, 32)));
});

test('native and TypeScript agree on land progress and width fitting', { skip: !hasNative }, (t) => {
  const env = { ...environment(receipt(t)), NO_COLOR: '1', HUD_ICONS: 'unicode', HUD_BAR_FIELDS: 'notice' };
  const { write } = setup(env.HUD_HOME);
  const global = { running: 2, queued: 0, asking: 0, roles: { imp: { running: 2, asking: 0 } } };
  const scope = (count, oldest, queued = 0) => write({ global: { ...global, queued, land: { count, oldest } } });
  const expect = (text, width = 160) => {
    const args = ['--width', String(width)];
    const line = ts(env, base, args);
    assert.equal(line.toString().trimEnd(), text);
    assert.deepEqual(rust(env, base, args), line);
  };
  const gate = { project: 'first', step: 'gate[2]', step_started_at: Date.now() - 90_000, gate: [2, 3] };
  scope(1, gate);
  expect('⚒2  ⇡ gate 2/3 1m');
  expect('⚒2  ⇡ gate 2/3', 16);
  expect('⚒2  ⇡', 12);
  scope(2, gate, 1);
  expect('⚒2  ⇡2 gate 2/3 1m  ◷1');
  expect('⚒2  ⇡2  ◷1', 11);
  expect('⚒2 ⇡2 ◷1', 8);
  expect('⚒2 ⇡2', 5);
  scope(1, { project: 'first', step: 'wait', step_started_at: Date.now() });
  expect('⚒2  ⇡ wait <1m');
  scope(1, { project: 'first', step: 'fast-forward', step_started_at: Date.now() });
  expect('⚒2  ⇡ land <1m');
});

test('Claude processes share a private CPU sample and show RAM and swap only as observed', { skip: process.platform !== 'linux' }, (t) => {
  const home = receipt(t), env = { ...environment(home), NO_COLOR: '1', HUD_BAR_FIELDS: 'notice' };
  setup(env.HUD_HOME).write({ global: { running: 0, asking: 0, queued: 0, roles: {} } });
  const { write } = syntheticProc(home, '6.6.0-microsoft-standard-WSL2');
  const sample = join(env.HUD_HOME, 'display/cpu-sample.v1.json');
  const input = { model: { display_name: 'Synthetic' } };
  const render = (renderer = ts, width = 160) => renderer(env, input, ['--width', String(width)]).toString();
  const mem = (free) => write('meminfo',
    `MemTotal: 8388608 kB\nMemAvailable: 2097152 kB\nSwapTotal: 4194304 kB\nSwapFree: ${free} kB\n`);

  mem(4194304);
  write('stat', `cpu  100 20 40 800 10 5 5 20 30 4\n${'cpu0 0 0 0 0\n'.repeat(80)}`);
  const first = render();
  assert.equal(first.trimEnd(), 'M75%');
  assert.equal(fs.statSync(sample).mode & 0o777, 0o600);

  // +12 busy ticks, +88 idle (including iowait); guest time is already in user/nice.
  write('stat', 'cpu  112 20 40 878 20 5 5 20 40 6\n');
  mem(3355443); // 0.8/4 GiB; shown even though 25% of RAM is available.
  const second = render(hasNative ? rust : ts);
  assert.equal(second.trimEnd(), 'C12%  M75%  S20%');
  write('stat', 'cpu  124 20 40 966 20 5 5 20 40 6\n');
  const third = render();
  assert.equal(third, second, 'TypeScript and native use the same sample format and text');
  assert.equal(render(hasNative ? rust : ts, 9).trimEnd(), 'M75% S20%');
  assert.equal(render(hasNative ? rust : ts, 8).trimEnd(), 'M75%');

  const prior = JSON.parse(fs.readFileSync(sample, 'utf8'));
  fs.writeFileSync(sample, JSON.stringify({ ...prior, at: Date.now() - 31_000 }));
  const afterGap = render(hasNative ? rust : ts);
  assert.equal(afterGap.trimEnd(), 'M75%  S20%', 'stale CPU is omitted');

  mem(3984589); // 0.2/4 GiB; below the 10% display threshold.
  env.HUD_ICONS = 'text';
  write('stat', 'cpu  136 20 40 1054 20 5 5 20 40 6\n');
  assert.equal(render(hasNative ? rust : ts).trimEnd(), 'C12%  M75%');
  if (hasNative) {
    delete env.NO_COLOR;
    env.HUD_BAR_STYLE = 'p10k';
    mem(3355443);
    const capsule = render(rust);
    assert.equal(capsule, render(ts), 'local load also matches in capsules');
    assert.match(capsule, /\x1b\[32mM75%/);
    assert.match(capsule, /\x1b\[35mS20%/);
  }
});

test('Claude shows the same machine counts inside herdr, outside herdr and in an idle pane', { timeout: 60000 }, async (t) => {
  const { env, entry } = localInstall(t);
  env.NO_COLOR = '1';
  const renderers = [[process.execPath, [entry]]];
  if (hasNative) renderers.push([native, []]);
  for (const [cmd, args] of renderers) {
    const render = async (pane) => {
      const run = promisify(execFile)(cmd, args, {
        env: pane ? { ...env, HERDR_PANE_ID: pane } : env, signal: t.signal, encoding: 'buffer',
      });
      run.child.stdin.end(JSON.stringify(base));
      const { stdout, stderr } = await run;
      assert.equal(stderr.length, 0);
      return stdout;
    };
    const outside = await render();
    assert.match(outside.toString(), /\uF0AD1  \uF0E72  \uF0171/);
    assert.deepEqual(outside, await render('synthetic-pane'));
    assert.deepEqual(outside, await render('empty-pane'));
  }
});

test('warm TS git/transcript/context/config cache files are reused; stale evidence declines native', { skip: !hasNative }, (t) => {
  for (const scenario of ['dirty-git', 'config-skills']) {
    const f = parityFixture(receipt(t), scenario);
    setup(f.hud);
    const expected = ts(f.env, f.input);
    assert.deepEqual(rust(f.env, f.input), expected, scenario);
    const context = { ...f.input, context_window: { used_percentage: 0, context_window_size: 200000 } };
    assert.deepEqual(rust(f.env, context), expected, 'warm context survives zero reading');
    const gitCache = fs.readdirSync(join(f.hud, 'display/statusline')).find(name => name.startsWith('git-'));
    if (gitCache) {
      const path = join(f.hud, 'display/statusline', gitCache);
      const stale = JSON.parse(fs.readFileSync(path));
      fs.writeFileSync(path, JSON.stringify({ ...stale, at: 0 }));
      assert.equal(rust(f.env, f.input, [], 75).length, 0);
    }
    fs.appendFileSync(f.file, '{}\n');
    assert.equal(rust(f.env, f.input, [], 75).length, 0, 'grown transcript');
  }
});

test('native writes only private quota observations, never email or other rate limits', { skip: !hasNative }, (t) => {
  const env = environment(receipt(t));
  setup(env.HUD_HOME);
  const input = { ...base, email: syntheticEmail, rate_limits: { ...base.rate_limits,
    five_hour: { used_percentage: 33.25, resets_at: 1893456000.125 }, extra: { used_percentage: 17 } } };
  const out = rust(env, input);
  assert.ok(!out.includes(syntheticEmail));
  const file = join(env.HUD_HOME, 'display/state/claude-quota.json');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(syntheticEmail));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(raw).quota, [
    { label: '5h', percent: 33.25, resetsAt: '2030-01-01T00:00:00.125Z' }, { label: '7d', percent: 84 },
  ]);
  const protectedState = '{"version":1,"synthetic":"unrelated"}\n';
  fs.writeFileSync(file, protectedState);
  fs.utimesSync(file, 1, 1);
  rust(env, input);
  assert.equal(fs.readFileSync(file, 'utf8'), protectedState);
});

test('dispatcher never reuses a frame and declines missing, stale, incompatible and forward settings', { skip: !hasNative }, (t) => {
  const env = environment(receipt(t));
  const { file, write } = setup(env.HUD_HOME);
  const second = { ...base, model: { display_name: 'A different session' } };
  const wanted = ts(env, second);
  assert.notDeepEqual(run(launcher, [], env, base), wanted);
  assert.deepEqual(run(launcher, [], env, second), wanted);
  for (const bad of [
    { version: 2 }, { complete: false }, { producer: 'hud-mcp' }, { pid_start: '0' },
    { global: { running: 0, asking: 0, roles: {} } }, // Older v1 snapshots lack queued counts.
  ]) {
    write(bad);
    assert.equal(rust(env, base, [], 75).length, 0);
    assert.deepEqual(run(launcher, [], env, base), ts(env, base));
  }
  fs.unlinkSync(file);
  assert.equal(rust(env, base, [], 75).length, 0);
  assert.deepEqual(run(launcher, [], env, base), ts(env, base));
  write();
  fs.writeFileSync(join(env.HUD_HOME, 'config.json'), '{"statusline":{"forward":["/bin/false"]}}');
  assert.equal(rust(env, { ...base, email: syntheticEmail }, [], 75).length, 0);
  assert.deepEqual(run(launcher, [], env, { ...base, email: syntheticEmail }), ts(env, base));
});

function localInstall(t) {
  const home = receipt(t), env = { ...environment(home), CAPTURE: join(home, 'capture') };
  setup(env.HUD_HOME);
  const root = join(home, 'install with spaces'), localBin = join(root, 'bin'), localDist = join(root, 'dist');
  fs.mkdirSync(localBin, { recursive: true });
  fs.mkdirSync(join(localDist, 'native'), { recursive: true });
  for (const file of ['hud-statusline', 'hud-statusline-native.sh']) {
    fs.copyFileSync(resolve('bin',file), join(localBin,file));
  }
  fs.symlinkSync(resolve('dist/cli'), join(localDist,'cli'));
  // Keep this install's startup lock private, just like its HOME and receipts.
  fs.mkdirSync(join(root, 'scripts'));
  fs.copyFileSync(resolve('scripts/dist-lock.mjs'), join(root, 'scripts/dist-lock.mjs'));
  fs.symlinkSync(resolve('package.json'), join(root,'package.json'));
  const entry = join(localBin, 'hud-statusline');
  const input = Buffer.from(`\ufeff \r\n${JSON.stringify({ ...base, model: { display_name: '示例' } })}\n\n`);
  return { env, entry, input, bin: join(localDist, 'native/hud-statusline') };
}
const failingRenderer = '#!/bin/bash\n/bin/cat > "$CAPTURE"\nprintf "hud-statusline-v1:partial"\nexit 75\n';

test('missing binary and explicit modes use TS; unsupported hosts bypass native', (t) => {
  const { env, entry, input, bin } = localInstall(t);
  assert.deepEqual(run(entry, [], env, input), ts(env, input));
  fs.writeFileSync(bin, failingRenderer, { mode: 0o755 });
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { mode: 0o700 });
  for (const args of [...(linuxX64 ? [] : [[]]), ['--details'], ['--source', env.CLAUDE_CONFIG_DIR], ['--help'], ['settings','preview']]) {
    assert.deepEqual(run(entry, args, env, input), ts(env, input, args));
    assert.equal(fs.existsSync(env.CAPTURE), false);
  }
});

test('failed native renderer replays fresh stdin exactly', { skip: !linuxX64 }, (t) => {
  const { env, entry, input, bin } = localInstall(t);
  // Check bytes at the TS handoff without contending for the shared dist lock.
  const stubBin = join(env.HOME, 'bin');
  fs.mkdirSync(stubBin);
  fs.writeFileSync(join(stubBin, 'node'), '#!/bin/bash\n[[ $# == 1 && $1 == "$TS_ENTRY" ]] || exit 1\nexec /bin/cat\n', { mode: 0o755 });
  env.PATH = `${stubBin}:${env.PATH}`;
  env.TS_ENTRY = entry;

  fs.writeFileSync(bin, failingRenderer, { mode: 0o755 });
  assert.deepEqual(run(entry, [], env, input), input);
  assert.deepEqual(fs.readFileSync(env.CAPTURE), input);
  const nul = Buffer.concat([input, Buffer.from([0, 0, 0xff, 0])]);
  assert.deepEqual(run(entry, [], env, nul), nul);
  assert.deepEqual(fs.readFileSync(env.CAPTURE), nul);
  fs.writeFileSync(bin, '#!/synthetic/missing/interpreter\n', { mode: 0o755 });
  assert.deepEqual(run(entry, [], env, input), input);
});
