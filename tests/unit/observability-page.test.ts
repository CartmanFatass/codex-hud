import test from 'node:test';
import assert from 'node:assert/strict';
import { renderObservabilityPage, handleObservabilityInput, initialObservabilityState } from '../../src/render/observability-page.js';
import { setLanguage } from '../../src/render/i18n.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { visualLength } from '../../src/render/colors.js';
import { useDisplayFixture } from '../fixtures/display.js';

useDisplayFixture();
const content = { sources: ['Source: synthetic rollout', '采样时间：unknown'], calls: ['progress: 3 requests'], preview: JSON.stringify({ version: 1, samples: Array.from({ length: 20 }, (_, i) => i) }, null, 2) };

test('evidence modal fits narrow EN/ZH displays and routes only explicit export saves', () => {
  for (const language of ['en', 'zh'] as const) for (const theme of ['terminal', 'none'] as const) {
    const old = setLanguage(language);
    setDisplayConfig({ theme });
    try {
      for (const width of [16, 32, 40, 48, 56]) for (const height of [8, 12, 24]) {
        for (const tab of ['sources', 'calls', 'export'] as const) {
          const frame = renderObservabilityPage({ tab, scroll: 0 }, content, width, height);
          assert.equal(frame.lines.length, height);
          assert.ok(frame.lines.every(line => visualLength(line) === width));
          for (const control of frame.controls) {
            assert.ok(control.x >= 0 && control.x + control.width <= width && control.y < height);
            const action = handleObservabilityInput(frame.state, { type: 'mouse', button: 'left', x: control.x, y: control.y }, frame);
            if (control.kind === 'save') assert.equal(action.action, 'save');
            else assert.notEqual(action.action, 'save');
          }
          assert.notEqual(handleObservabilityInput(frame.state, { type: 'key', key: 'enter' }, frame).action, 'save');
          assert.equal(handleObservabilityInput(frame.state, { type: 'key', key: 'escape' }, frame).action, 'close');
        }
      }
    } finally { setLanguage(old); }
  }
});

test('export preview scrolls without regenerating or saving; tab changes reset position', () => {
  const state = { tab: 'export' as const, scroll: 0 };
  const frame = renderObservabilityPage(state, content, 32, 8);
  const end = handleObservabilityInput(state, { type: 'key', key: 'end' }, frame);
  assert.equal(end.state.scroll, frame.total - frame.count);
  assert.equal(end.action, undefined);
  const saved = handleObservabilityInput(state, { type: 'key', key: 'sort', raw: 's' }, frame);
  assert.equal(saved.action, 'save');
  const next = handleObservabilityInput(end.state, { type: 'key', key: 'tab' }, frame);
  assert.equal(next.state.tab, 'sources');
  assert.equal(next.state.scroll, 0);
  const sourceFrame = renderObservabilityPage(initialObservabilityState(), content, 32, 12);
  assert.equal(handleObservabilityInput(sourceFrame.state, { type: 'key', key: 'sort', raw: 's' }, sourceFrame).action, undefined);
});
