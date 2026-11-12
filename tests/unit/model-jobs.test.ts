import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultSettings, loadSettings, saveSettings } from '../../src/settings.js';
import { SETTING_ROWS, renderSettingsPage } from '../../src/render/settings-page.js';
import { stripAnsi } from '../../src/render/colors.js';

test('LLM has only switch, model and cap; key defaults on and retired settings load but never save', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-thin-'));
  const saved = { ...process.env };
  try {
    process.env.HOME = home;
    process.env.HUD_HOME = home;
    delete process.env.HUD_SETTINGS_PATH;
    delete process.env.MISTRAL_API_KEY;
    delete process.env.OPENAI_API_KEY;
    assert.equal(defaultSettings().modelEnabled, false);
    fs.writeFileSync(path.join(home, 'credentials.env'), 'MISTRAL_API_KEY=synthetic-key\n', { mode: 0o600 });
    fs.writeFileSync(
      path.join(home, 'hud-settings.json'),
      JSON.stringify({
        briefing: 'off',
        agentLog: true,
        cardLabel: false,
        cardSummary: false,
        agentsPane: 'closed',
        cardModel: false,
      })
    );
    const draft = loadSettings();
    assert.equal(draft.modelEnabled, true);
    assert.equal(draft.model, 'deepseek-v4-1-flash-1017');
    for (const key of ['briefing', 'agentLog', 'cardLabel', 'cardSummary', 'agentsPane', 'cardModel']) {
      assert.equal(key in draft, false);
      assert.equal(
        SETTING_ROWS.some((r) => r.key === key),
        false
      );
    }
    saveSettings({});
    assert.doesNotMatch(
      fs.readFileSync(path.join(home, 'hud-settings.json'), 'utf8'),
      /agentLog|cardLabel|cardSummary|agentsPane|cardModel/
    );
    assert.deepEqual(
      SETTING_ROWS.filter((r) => r.group === 'Models').map((r) => r.key),
      ['modelEnabled', 'model', 'decisionApi', 'modelCallsPerHour']
    );
    const text = stripAnsi(
      renderSettingsPage(
        { draft, selected: SETTING_ROWS.findIndex((r) => r.group === 'Models'), offset: 0, message: '' },
        100,
        30
      ).lines.join('\n')
    );
    assert.match(text, /Model text/);
    assert.match(text, /Call cap/);
    assert.doesNotMatch(text, /consent|Backend|AGY/);
    fs.unlinkSync(path.join(home, 'credentials.env'));
    assert.equal(loadSettings().modelEnabled, true, 'a saved master boolean wins over the key-aware default');
    fs.unlinkSync(path.join(home, 'hud-settings.json'));
    assert.equal(loadSettings().modelEnabled, false);
  } finally {
    process.env = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
