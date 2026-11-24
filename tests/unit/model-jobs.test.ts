import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadSettings, saveSettings } from '../../dist/settings.js';
import { SETTING_ROWS, handleSettingsInput, renderSettingsPage } from '../../dist/render/settings-page.js';
import { stripAnsi } from '../../dist/render/colors.js';

test('Models keeps execution controls and ignores legacy display-model settings', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-thin-'));
  const saved = { ...process.env };
  try {
    process.env.HOME = home;
    process.env.HUD_HOME = home;
    delete process.env.HUD_SETTINGS_PATH;
    const legacy = { modelEnabled: true, model: 'synthetic', modelCallsPerHour: 120,
      briefingApiBase: 'https://example.invalid/v1', summaryIntervalMinutes: 10 };
    fs.writeFileSync(
      path.join(home, 'hud-settings.json'),
      JSON.stringify({
        briefing: 'off',
        agentLog: true,
        cardLabel: false,
        cardSummary: false,
        agentsPane: 'closed',
        cardModel: false,
        ...legacy,
        decisionCallsPerHour: 600,
      })
    );
    const draft = loadSettings();
    assert.equal(draft.decisionCallsPerHour, 600);
    for (const key of ['briefing', 'agentLog', 'cardLabel', 'cardSummary', 'agentsPane', 'cardModel', ...Object.keys(legacy)]) {
      assert.equal(key in draft, false);
      assert.equal(
        SETTING_ROWS.some((r) => r.key === key),
        false
      );
    }
    saveSettings({});
    const stored = JSON.parse(fs.readFileSync(path.join(home, 'hud-settings.json'), 'utf8'));
    for (const key of [...Object.keys(legacy), 'agentLog', 'cardLabel', 'cardSummary', 'agentsPane', 'cardModel'])
      assert.equal(key in stored, false);
    assert.deepEqual(
      SETTING_ROWS.filter((r) => r.group === 'Models').map((r) => r.key),
      ['decisionApi', 'decisionCallsPerHour', 'quietJobDecision', 'sonicAutoThinking', 'impPlacement', 'impEvenPool']
    );
    const text = stripAnsi(
      renderSettingsPage(
        { draft, selected: SETTING_ROWS.findIndex((r) => r.group === 'Models'), offset: 0, message: '', advanced: true },
        100,
        45,
        { decisionCalls: { lastHour: 2, byFeature: { 'sonic-thinking': 2 } } }
      ).lines.join('\n')
    );
    assert.doesNotMatch(text, /Model text|Call cap|Summary interval|Test API/);
    assert.match(text, /Decision cap/);
    assert.match(text, /Sonic thinking 2/);
    assert.match(text, /Quiet job\s+on/);
    assert.match(text, /Sonic auto-thinking\s+off/);
    assert.match(text, /Imp placement\s+fixed/);
    assert.doesNotMatch(text, /consent|Backend|AGY|Even pool/);
    const frame = renderSettingsPage({ draft, selected: SETTING_ROWS.findIndex(r => r.key === 'impPlacement'),
      impPresets: ['small', 'deep'], offset: 0, message: '' }, 80, 40);
    let next = frame.state;
    for (const key of ['right', 'down', 'enter', 'right', 'enter', 'left', 'enter'])
      next = handleSettingsInput(next, { type: 'key', key }, renderSettingsPage(next, 80, 40)).state;
    assert.equal(next.draft.impPlacement, 'even');
    assert.deepEqual(next.draft.impEvenPool, ['deep']);
    assert.deepEqual(saveSettings(next.draft).impEvenPool, ['deep']);
    assert.deepEqual(loadSettings().impEvenPool, ['deep']);
  } finally {
    process.env = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
