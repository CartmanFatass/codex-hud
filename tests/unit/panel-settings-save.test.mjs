import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsFlow } from '../../dist/panel/settings-flow.js';
import { SETTING_ROWS } from '../../dist/render/settings-page.js';
import { loadSettings, saveSettings } from '../../dist/settings.js';

function fixture(t, initial, row) {
  const home = mkdtempSync(join(tmpdir(), 'hud-settings-save-'));
  const file = join(home, 'hud-settings.json');
  const old = process.env;
  process.env = { ...old, HUD_HOME: home, HUD_SETTINGS_PATH: file };
  t.after(() => {
    process.env = old;
    rmSync(home, { recursive: true, force: true });
  });
  writeFileSync(file, JSON.stringify(initial));
  let current = loadSettings(), applied = 0;
  const position = row && { selected: SETTING_ROWS.findIndex(row), offset: 0 };
  const flow = createSettingsFlow(current, position, {
    current: () => current,
    apply(saved) { current = saved; applied++; },
    setMouseTracking() {}, applyWidth() {}, repaint() {}, repaintAll() {},
  }, () => ['first']);
  if (!position) flow.show(current);
  const input = (key) => {
    flow.paint(80, 40, () => ({}), () => []);
    flow.input({ type: 'key', key }, {}, (state) => state);
  };
  return { file, flow, input, applied: () => applied };
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
