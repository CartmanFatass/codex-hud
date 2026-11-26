import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsFlow } from '../../dist/panel/settings-flow.js';
import { SETTING_ROWS } from '../../dist/render/settings-page.js';
import { runtimeSettings } from '../../dist/settings-runtime.js';
import { loadSettings, saveSettings } from '../../dist/settings.js';

function fixture(t, initial, row, extraEnv) {
  const home = mkdtempSync(join(tmpdir(), 'hud-settings-save-'));
  const file = join(home, 'hud-settings.json');
  const old = process.env;
  process.env = { ...old, HUD_HOME: home, HUD_SETTINGS_PATH: file, ...extraEnv };
  if (extraEnv) delete process.env.NO_COLOR;
  t.after(() => {
    process.env = old;
    rmSync(home, { recursive: true, force: true });
  });
  if (initial !== null) writeFileSync(file, JSON.stringify(initial));
  let current = initial === null ? runtimeSettings() : loadSettings(), applied = 0;
  const position = row && { selected: SETTING_ROWS.findIndex(row), offset: 0 };
  const flow = createSettingsFlow(current, position, {
    current: () => current,
    apply(saved) { current = saved; applied++; },
    setMouseTracking() {},
    repaint() {},
  }, () => ['first']);
  if (!position) flow.show(current);
  const input = (key) => {
    flow.paint(80, 40, () => ({}), () => []);
    flow.input({ type: 'key', key }, {}, (state) => state);
  };
  return {
    file,
    flow,
    input,
    current: () => current,
    applied: () => applied,
  };
}

test('saving a theme edit leaves newer settings and Decision API choices intact', (t) => {
  const f = fixture(t, { impEvenPool: ['first'] });
  f.input('right'); // theme, the first row
  saveSettings({ roleCaps: { imp: 6 }, impEvenPool: ['second', 'third'], decisionApi: 'gemini' });
  f.input('settings-save');
  const saved = loadSettings();
  assert.equal(saved.theme, 'titanium');
  assert.deepEqual(saved.roleCaps, { imp: 6, general: 3 });
  assert.deepEqual(saved.impEvenPool, ['second', 'third']);
  assert.equal(saved.decisionApi, 'gemini');
  assert.equal(f.applied(), 1);
  assert.equal(f.flow.isDirty(), false, 'draft and snapshot both adopt the merged settings');
});

test('saving one worker cap leaves other caps written since the page opened intact', (t) => {
  const f = fixture(t, { roleCaps: { imp: 3, general: 3, reviewer: 2 } }, (row) => row.role === 'imp');
  f.input('right');
  saveSettings({ roleCaps: { general: 6, reviewer: 5, sonic: 2 } });
  f.input('settings-save');
  assert.deepEqual(loadSettings().roleCaps, { imp: 4, general: 6, reviewer: 5, sonic: 2 });
  assert.equal(f.flow.isDirty(), false);
});

test('saving after an array edit returns to its opening value does not write or apply anything', (t) => {
  const f = fixture(t, { impPlacement: 'even', impEvenPool: ['first'] }, (row) => row.key === 'impEvenPool');
  f.input('enter');
  assert.equal(f.flow.isDirty(), true);
  f.input('enter');
  assert.equal(f.flow.isDirty(), false);
  const external = '{"impPlacement":"even", "impEvenPool":["second"]}\n';
  writeFileSync(f.file, external);
  const inode = statSync(f.file).ino;
  f.input('settings-save');
  assert.equal(readFileSync(f.file, 'utf8'), external);
  assert.equal(statSync(f.file).ino, inode);
  assert.equal(f.applied(), 0);
});

test('first save with no settings file keeps effective opening width and display values', (t) => {
  const f = fixture(t, null, (row) => row.key === 'claudePaneStrip', {
    HUD_TREE_WIDTH: '80',
    HUD_THEME: 'mocha',
    HUD_ICONS: 'text',
    HUD_BAR_STYLE: 'p10k',
    HUD_BAR_FIELDS: 'model,context',
  });
  assert.equal(f.current().treeWidth, 80);
  f.input('right');
  f.input('settings-save');
  const saved = loadSettings();
  const persisted = JSON.parse(readFileSync(f.file, 'utf8'));
  for (const actual of [f.current(), saved, persisted]) {
    assert.equal(actual.claudePaneStrip, true);
    assert.equal(actual.treeWidth, 80);
    assert.equal(actual.theme, 'mocha');
    assert.equal(actual.icons, 'text');
    assert.equal(actual.barStyle, 'p10k');
    assert.deepEqual(actual.barFields, ['model', 'context']);
  }
  assert.equal(f.applied(), 1);
  assert.equal(f.flow.isDirty(), false);
});

test('first save merges onto a settings file created by another writer between open and save', (t) => {
  const f = fixture(t, null, (row) => row.key === 'claudePaneStrip', {
    HUD_TREE_WIDTH: '80',
    HUD_THEME: 'mocha',
    HUD_BAR_STYLE: 'p10k',
  });
  assert.equal(f.current().treeWidth, 80);
  f.input('right');
  writeFileSync(f.file, JSON.stringify({ roleCaps: { imp: 6 }, theme: 'latte' }));
  f.input('settings-save');
  const saved = loadSettings();
  assert.equal(saved.claudePaneStrip, true);
  assert.deepEqual(saved.roleCaps, { imp: 6, general: 3 });
  assert.equal(saved.theme, 'latte');
  assert.equal(saved.barStyle, 'line');
  assert.equal(saved.treeWidth, 56);
  assert.equal(f.current().treeWidth, 56);
  assert.equal(f.flow.isDirty(), false);
});
