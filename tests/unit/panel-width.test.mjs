import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { panelWidth, treeWidthKeeper, TreeWidthKeeper } from '../../dist/utils/pane-width.js';
import { defaultSettings, loadSettings } from '../../dist/settings.js';
import { SETTING_ROWS, resetSettingsGroup } from '../../dist/render/settings-page.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'panel-width-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'), log = join(dir, 'calls'), geometry = join(dir, 'geometry');
  mkdirSync(bin);
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const {total, width} = JSON.parse(fs.readFileSync(${JSON.stringify(geometry)}, 'utf8'));
const rect = (x, width) => ({x, y: 0, width, height: 40});
console.log(JSON.stringify({result: args[1] === 'get' ? {pane: {pane_id: args[2]}} : {layout: {
  panes: [{pane_id: 'w4E:p1', rect: rect(0, total - width)}, {pane_id: 'w4E:p2', rect: rect(total - width, width)},
    {pane_id: 'w4E:p9', rect: {x: 0, y: 40, width: total, height: 40}}],
  splits: [{direction: 'right', ratio: 1 - width / total, rect: rect(0, total)}]
}}}));
`, { mode: 0o700 });
  const setGeometry = (total, width) => writeFileSync(geometry, JSON.stringify({ total, width }));
  setGeometry(160, 56);
  writeFileSync(join(bin, 'tmux'), `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(['tmux', ...args]) + '\\n');
if (args[0] === 'display-message') console.log('160');
`, { mode: 0o700 });
  const env = {
    HOME: join(dir, 'home'), HUD_HOME: join(dir, 'hud'), CODEX_HOME: join(dir, 'codex'),
    CLAUDE_CONFIG_DIR: join(dir, 'claude'), PI_CODING_AGENT_DIR: join(dir, 'pi'),
    PATH: `${bin}:${dirname(process.execPath)}`, HERDR_SOCKET_PATH: join(dir, 'synthetic.sock'),
    HERDR_PANE_ID: 'w4E:p2', HUD_PANEL_CALLER_PANE: 'w4E:p1',
    CODEX_HUD_STANDALONE_PANEL: '1', HUD_PANEL_WIDTH: '56',
  };
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { dir, env, calls, setGeometry };
}

async function until(check, message) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await delay(50);
  }
  assert.fail(message);
}

for (const [herdr, override, tmuxHere] of [[true, false], [false, false], [true, true], [false, false, true]])
  test(`saving Width through the real panel input ${herdr ? 'resizes only its own herdr pane' : tmuxHere ? 'does not resize a --here terminal with inherited tmux markers' : 'runs no pane commands outside herdr/tmux'}${override ? ', after an explicit opening override' : ''}`, { timeout: 20000 }, async (t) => {
    const f = fixture(t), env = { ...f.env };
    if (!herdr) { delete env.HERDR_PANE_ID; delete env.HUD_PANEL_CALLER_PANE; }
    if (tmuxHere) Object.assign(env, { TMUX_PANE: '%2', CODEX_HUD_MAIN_PANE: '%1' });
    if (override) {
      f.setGeometry(160, 40);
      env.HUD_PANEL_WIDTH = '40';
      mkdirSync(env.HUD_HOME);
      writeFileSync(join(env.HUD_HOME, 'hud-settings.json'), JSON.stringify({ treeWidth: 80 }));
    }
    const child = spawn(process.execPath, [resolve('dist/tree-page.js')], { cwd: f.dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let output = '', stderr = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    await until(() => output.includes('Home'), 'panel did not paint: ' + stderr);
    child.stdin.write(',');
    await until(() => output.includes('Settings'), 'settings did not open: ' + stderr);
    if (herdr) {
      await until(() => f.calls().some((a) => a[1] === 'layout'), 'no initial width read');
      assert.equal(f.calls().filter((a) => a[1] === 'resize').length, 0, 'opening width was retained');
    }
    const index = SETTING_ROWS.findIndex((r) => r.key === 'treeWidth');
    child.stdin.write('\x1b[H' + '\x1b[B'.repeat(index) + '\x1b[Cs');
    const file = join(f.dir, 'hud', 'hud-settings.json');
    const expectedWidth = override ? 100 : 64;
    await until(() => existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).treeWidth === expectedWidth, 'settings were not saved: ' + stderr);
    if (herdr) await until(() => f.calls().some((a) => a[1] === 'resize'), 'no resize: ' + stderr);
    await delay(300);
    const resizes = f.calls().filter((a) => a[1] === 'resize');
    assert.equal(resizes.length, herdr ? 1 : 0);
    if (herdr) {
      assert.deepEqual(resizes[0].slice(0, 7), ['pane', 'resize', '--pane', 'w4E:p2', '--direction', 'left', '--amount']);
      assert.ok(Math.abs(Number(resizes[0][7]) - (override ? 60 : 8) / 160) < 1e-9);
      f.setGeometry(160, 70); // owner drags after saving, then changes only the theme
      child.stdin.write('\x1b[H\x1b[Cs');
      await until(() => JSON.parse(readFileSync(file, 'utf8')).theme === 'titanium', 'theme was not saved');
      await delay(300);
      assert.equal(f.calls().filter((a) => a[1] === 'resize').length, 1, 'unrelated save leaves the border alone');
    } else assert.deepEqual(f.calls().filter((a) => a[0] === 'pane' || a[0] === 'tmux'), []);
  });

test('keeper follows containing width, leaves manual drags alone and clamps with panelWidth', async (t) => {
  const f = fixture(t), saved = { ...process.env };
  t.after(() => { process.env = saved; });
  process.env = { ...f.env };
  let requested = 80;
  const keeper = treeWidthKeeper(() => requested);
  assert.ok(keeper);
  await keeper.apply();
  assert.equal(f.calls().filter((a) => a[1] === 'resize').length, 1);
  f.setGeometry(160, 70); // manual border drag: containing width is unchanged
  await keeper.follow();
  assert.equal(f.calls().filter((a) => a[1] === 'resize').length, 1);
  f.setGeometry(180, 70);
  await keeper.follow();
  let resize = f.calls().filter((a) => a[1] === 'resize').at(-1);
  assert.equal(resize[5], 'left');
  assert.ok(Math.abs(Number(resize[7]) - 10 / 180) < 1e-9);
  requested = 100;
  f.setGeometry(100, 70);
  await keeper.apply();
  resize = f.calls().filter((a) => a[1] === 'resize').at(-1);
  assert.equal(resize[5], 'right');
  assert.ok(Math.abs(Number(resize[7]) - 11 / 100) < 1e-9);
  assert.ok(f.calls().filter((a) => a[1] === 'resize').every((a) => a[3] === 'w4E:p2'));
  assert.equal(panelWidth(0, 160), 56);
  assert.equal(panelWidth(100, 100), 59);
  assert.equal(panelWidth(100, 40), 13);
});

test('tmux still resizes its own tree pane with the shared default and ignores unchanged window widths', async (t) => {
  const f = fixture(t), saved = { ...process.env };
  t.after(() => { process.env = saved; });
  const log = join(f.dir, 'tmux-calls');
  writeFileSync(join(f.dir, 'bin', 'tmux'), `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'display-message') console.log('160');
`, { mode: 0o700 });
  process.env = { ...f.env, TMUX_PANE: '%2', CODEX_HUD_MAIN_PANE: '%1' };
  let requested = 0;
  const keeper = treeWidthKeeper(() => requested);
  await keeper.apply();
  await keeper.follow();
  requested = 80;
  await keeper.apply();
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.filter((a) => a[0] === 'resize-pane'), [
    ['resize-pane', '-t', '%2', '-x', '56'], ['resize-pane', '-t', '%2', '-x', '80'],
  ]);
  assert.deepEqual(f.calls(), [], 'Codex tmux takes precedence over outer herdr context');
});

test('a settings save supersedes an in-flight startup width read without a duplicate resize', async () => {
  let release, requested = 56;
  const geometry = new Promise((resolve) => { release = resolve; }), resized = [];
  const keeper = new TreeWidthKeeper(() => geometry, async (width) => { resized.push(width); }, () => requested);
  const startup = keeper.apply();
  requested = 64;
  const save = keeper.apply();
  release(160);
  await Promise.all([startup, save]);
  assert.deepEqual(resized, [64], 'only the latest apply may resize after the geometry read');
});

test('Width belongs to Panel with Home presets, default 56, and legacy saved widths still load', (t) => {
  const f = fixture(t);
  const row = SETTING_ROWS.find((r) => r.key === 'treeWidth');
  assert.equal(row.group, 'Panel');
  assert.deepEqual(row.values, [40, 48, 56, 64, 80, 100]);
  assert.equal(row.help, 'Panel columns for every client; the agent pane keeps 41');
  assert.equal(defaultSettings().treeWidth, 56);
  assert.equal(resetSettingsGroup({ ...defaultSettings(), treeWidth: 80 }, 'Panel').treeWidth, 56);
  assert.equal(resetSettingsGroup({ ...defaultSettings(), treeWidth: 80 }, 'Codex').treeWidth, 80);
  mkdirSync(f.env.HUD_HOME);
  for (const width of [32, 0, 16, 200, 201]) {
    writeFileSync(join(f.env.HUD_HOME, 'hud-settings.json'), JSON.stringify({ treeWidth: width }));
    assert.equal(loadSettings(f.env).treeWidth, width === 201 ? 56 : width);
  }
});
