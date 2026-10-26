import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDisplayConfig, setDisplayConfig, displayConfig, LOOKS } from '../../src/render/hud-config.js';
import { withDisplaySettings } from '../../src/settings-runtime.js';
import { setLanguage } from '../../src/render/i18n.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { renderMonitor, handleMonitorInput } from '../../src/render/monitor.js';
import { statusCard, sessionState } from '../../src/render/status-block.js';
import { visualMaterial, visualSettings, visualState, VISUAL_NOW } from '../fixtures/visual-baselines.js';
import { useDisplayFixture } from '../fixtures/display.js';

useDisplayFixture();

test('NO_COLOR overrides a saved colour theme, while an empty value allows it', () => {
  const inherited = process.env.NO_COLOR;
  const settings = visualSettings({ language: 'en', look: 'tab', width: 48, preset: 'monitor' });
  settings.theme = 'mocha';
  try {
    for (const value of ['1', 'true', '0', '']) {
      process.env.NO_COLOR = value;
      assert.equal(resolveDisplayConfig({ NO_COLOR: value, CODEX_HUD_THEME: 'mocha' }).theme, value ? 'none' : 'mocha');
      const previous = displayConfig();
      withDisplaySettings(settings, () => assert.equal(displayConfig().theme, value ? 'none' : 'mocha'));
      assert.deepEqual(displayConfig(), previous, 'preview restores the active display');
    }
  } finally {
    if (inherited === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = inherited;
  }
});

test('narrow colour and no-colour panels keep rate, context and working navigation hit areas', () => {
  for (const theme of ['terminal', 'none'] as const) for (const language of ['en', 'zh'] as const) {
    const previousLanguage = setLanguage(language);
    try {
      for (const look of LOOKS) for (const width of [32, 40, 48, 56]) for (const height of [12, 24]) {
        setDisplayConfig({ ...resolveDisplayConfig({}), theme, look, icons: 'unicode', glyphs: 'text' });
        const material = visualMaterial(language);
        material.data.outputRate = { tokensPerSecond: 42, sampledAt: new Date(VISUAL_NOW - 15_000), sampleMs: 10_000 };
        const state = visualState(visualSettings({ language, look, width, preset: 'monitor' }));
        const input = { ...material, state, width, height, nowMs: VISUAL_NOW,
          status: (now: number) => statusCard(material.data, now), session: (now: number) => sessionState(material.data, now) };
        const frame = renderMonitor(input);
        const label = `${theme}/${language}/${look}/${width}x${height}`;
        assert.equal(frame.lines.length, height, label);
        for (const line of frame.lines) assert.equal(visualLength(line), width, label);
        const band = stripAnsi(frame.lines[frame.statusCard!.y]);
        assert.match(band, /42%/, `${label}: context stays visible`);
        assert.match(band, /42 tok\/s/, `${label}: main rate stays visible`);
        assert.match(band, language === 'zh' ? /上次/ : /last/, `${label}: historical rate never looks current`);
        for (const kind of ['main', 'settings', 'help'] as const) {
          const control = frame.controls.find(control => control.kind === kind);
          assert.ok(control, `${label}: ${kind} remains reachable`);
          assert.ok(control.x >= 0 && control.x + control.width <= width && control.y < height, label);
          for (let x = control.x; x < control.x + control.width; x++) {
            const clicked = handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x, y: control.y }, { tree: material.tree, frame });
            if (kind === 'help') assert.equal(clicked.state.help, true, label);
            else assert.equal(clicked.action?.type, kind === 'main' ? 'switch' : 'settings', `${label}: ${kind} at ${x}`);
          }
        }
      }
    } finally { setLanguage(previousLanguage); }
  }
});
