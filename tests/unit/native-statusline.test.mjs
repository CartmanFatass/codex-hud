import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parityFixture } from '../../dist-test/fixtures/claude-hud-parity/fixture.js';

const launcher = resolve('bin/hud-statusline');
const native = resolve('dist/native/hud-statusline');
const base = {
  model: { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
  context_window: { used_percentage: 42, context_window_size: 200000 },
  rate_limits: { five_hour: { used_percentage: 22 }, seven_day: { used_percentage: 84 } },
};
const syntheticEmail = 'synthetic@example.invalid';
const start = process.platform === 'linux' ? fs.readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1).split(' ')[19] : '';
const toolchain = process.platform === 'linux' && process.arch === 'x64' && spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0;
const hasNative = fs.existsSync(native);
function receipt(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-native-statusline-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function setup(hud) {
  fs.mkdirSync(join(hud, 'display'), { recursive: true, mode: 0o700 });
  const scope = { running: 3, asking: 1, roles: { imp: { running: 1, asking: 0 }, sonic: { running: 2, asking: 1 } } };
  const empty = { running: 0, asking: 0, roles: {} };
  const file = join(hud, 'display/work-summary.v1.json');
  const write = (extra = {}) => fs.writeFileSync(file, JSON.stringify({
    version: 1, producer: 'hud-watch', pid: process.pid, pid_start: start, generation: 1,
    observed_at: 1000, watching: true, complete: true, global: scope, panes: { 'synthetic-pane': empty }, ...extra,
  }), { mode: 0o600 });
  fs.writeFileSync(join(hud, 'watch.pid'), `${process.pid}\n`);
  write();
  return { file, write };
}
function environment(home) {
  return { HOME: home, HUD_HOME: join(home, 'hud'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC' };
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

test('native compact Claude bar matches TypeScript byte-for-byte', { skip: !hasNative }, (t) => {
  const env = environment(receipt(t));
  setup(env.HUD_HOME);
  const cjk = { ...base, model: { display_name: '虚构苏州🧪 工作者' }, context_window: { used_percentage: 76.5 } };
  const ansi = { ...base, model: { display_name: '甲\x1b[31m\n\t\x00\u202e乙' }, cwd: join(env.HOME, '项目') };
  fs.mkdirSync(ansi.cwd);
  const rows = [
    ['Claude', base, {}, []],
    ['CJK truncation', cjk, {}, ['--width', '9']],
    ['ANSI in external text', ansi, {}, ['--width', '70']],
    ['NO_COLOR and text icons', base, { NO_COLOR: '1', HUD_ICONS: 'text', COLUMNS: '86' }, []],
    ['narrow width from the environment', base, { COLUMNS: '5' }, []],
    ['powerline, no capsule parity regressions', base, { HUD_BAR_STYLE: 'p10k' }, []],
    ['scoped workers and RGB palette', base, { HERDR_PANE_ID: 'synthetic-pane', HUD_THEME: 'mocha' }, []],
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
  const exact = Buffer.from(JSON.stringify(base).padEnd(65536, ' '));
  assert.deepEqual(run(launcher, [], env, exact), rust(env, exact), 'exactly 64 KiB remains valid');
  assert.deepEqual(run(launcher, [], env, Buffer.concat([exact, Buffer.from([0])])), ts(env, Buffer.alloc(65537, 32)));
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
  for (const bad of [{ version: 2 }, { complete: false }, { producer: 'hud-mcp' }, { pid_start: '0' }]) {
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

test('missing binary and failed renderer replay fresh stdin exactly; explicit modes never start it', (t) => {
  const home = receipt(t), env = { ...environment(home), CAPTURE: join(home, 'capture') };
  setup(env.HUD_HOME);
  const root = join(home, 'install with spaces'), localBin = join(root, 'bin'), localDist = join(root, 'dist');
  fs.mkdirSync(localBin, { recursive: true });
  fs.mkdirSync(join(localDist, 'native'), { recursive: true });
  for (const file of ['hud-statusline', 'hud-statusline-cache.sh', 'hud-statusline-native.sh']) {
    fs.copyFileSync(resolve('bin',file), join(localBin,file));
  }
  fs.symlinkSync(resolve('dist/cli'), join(localDist,'cli'));
  fs.symlinkSync(resolve('scripts'), join(root,'scripts'));
  fs.symlinkSync(resolve('package.json'), join(root,'package.json'));
  const entry = join(localBin, 'hud-statusline');
  const input = Buffer.from(`\ufeff \r\n${JSON.stringify({ ...base, model: { display_name: '示例' } })}\n\n`);
  const expected = ts(env, input);
  assert.deepEqual(run(entry, [], env, input), expected);
  const bin = join(localDist, 'native/hud-statusline');
  // Mimic a renderer which consumes every byte and prints a partial frame before it dies.
  fs.writeFileSync(bin, '#!/bin/bash\n/bin/cat > "$CAPTURE"\nprintf "hud-statusline-v1:partial"\nexit 75\n', { mode: 0o755 });
  assert.deepEqual(run(entry, [], env, input), expected);
  assert.deepEqual(fs.readFileSync(env.CAPTURE), input);
  const nul = Buffer.concat([input, Buffer.from([0, 0, 0xff, 0])]);
  assert.deepEqual(run(entry, [], env, nul), ts(env, nul));
  assert.deepEqual(fs.readFileSync(env.CAPTURE), nul);
  fs.unlinkSync(env.CAPTURE);
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { mode: 0o700 });
  for (const args of [['--details'], ['--source', env.CLAUDE_CONFIG_DIR], ['--help'], ['settings','preview']]) {
    assert.deepEqual(run(entry, args, env, input), ts(env, input, args));
    assert.equal(fs.existsSync(env.CAPTURE), false);
  }
  fs.writeFileSync(bin, '#!/synthetic/missing/interpreter\n', { mode: 0o755 });
  assert.deepEqual(run(entry, [], env, input), expected);
});
