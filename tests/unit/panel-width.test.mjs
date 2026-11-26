import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { panelWidth } from '../../dist/utils/pane-width.js';
import { defaultSettings, loadSettings, saveSettings } from '../../dist/settings.js';
import { SETTING_ROWS, resetSettingsGroup } from '../../dist/render/settings-page.js';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'panel-width-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { HUD_HOME: home, HUD_SETTINGS_PATH: join(home, 'hud-settings.json') };
}

test('only a changed Decision API rewrites config; malformed config is never destroyed', (t) => {
  const env = fixture(t), old = process.env;
  process.env = { ...old, ...env };
  t.after(() => { process.env = old; });
  const file = join(env.HUD_HOME, 'config.json'), bytes = '{ "decisions": { "primary": "gemini" }, "jev": {} }\n';
  writeFileSync(file, bytes);
  saveSettings({ ...loadSettings(), theme: 'titanium' });
  assert.equal(readFileSync(file, 'utf8'), bytes);
  saveSettings({ decisionApi: 'openai' });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).decisions.primary, 'openai');
  writeFileSync(file, '{ broken');
  assert.throws(() => saveSettings({ decisionApi: 'gemini' }));
  assert.equal(readFileSync(file, 'utf8'), '{ broken');
});

test('Width and Dock mode belong to Panel; legacy widths still load', (t) => {
  const env = fixture(t);
  const width = SETTING_ROWS.find((r) => r.key === 'treeWidth'), dock = SETTING_ROWS.find((r) => r.key === 'dockMode');
  assert.equal(width.group, 'Panel');
  assert.deepEqual(width.values, [40, 48, 56, 64, 80, 100]);
  assert.equal(dock.group, 'Panel');
  assert.deepEqual(dock.values, ['overlay', 'push']);
  assert.deepEqual([defaultSettings().treeWidth, defaultSettings().dockMode], [56, 'overlay']);
  const edited = { ...defaultSettings(), treeWidth: 80, dockMode: 'push' };
  const reset = resetSettingsGroup(edited, 'Panel');
  assert.deepEqual([reset.treeWidth, reset.dockMode], [56, 'overlay']);
  assert.deepEqual(resetSettingsGroup(edited, 'Codex'), edited);
  for (const width of [32, 0, 16, 200, 201]) {
    writeFileSync(env.HUD_SETTINGS_PATH, JSON.stringify({ treeWidth: width }));
    assert.equal(loadSettings(env).treeWidth, width === 201 ? 56 : width);
  }
  assert.equal(panelWidth(0, 160), 56);
  assert.equal(panelWidth(100, 100), 59);
  assert.equal(panelWidth(100, 40), 13);
});
