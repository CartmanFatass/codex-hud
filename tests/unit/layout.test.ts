/**
 * Width safety for the status bar: whatever the pane size, the HUD must fit
 * inside it and must not leave an escape sequence half-written.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderHud } from '../../src/render/header.js';
import { visualWidth, stripAnsi } from '../../src/render/colors.js';
import { DEFAULT_LAYOUT } from '../../src/types.js';
import type { HudData, LayoutMode } from '../../src/types.js';
import { makeHudData, TEST_WIDTHS } from '../fixtures/hud-data.js';

const HOSTILE: Array<[string, Partial<HudData>]> = [
  ['baseline', {}],
  ['cjk project name', { project: { ...makeHudData().project, projectName: '代码审查工具集合' } }],
  ['very long path', {
    project: {
      ...makeHudData().project,
      projectName: 'a-really-long-project-name-that-will-not-fit-anywhere-near-a-narrow-pane',
      cwd: '/home/fires/' + 'nested/'.repeat(20) + 'leaf',
    },
  }],
  ['emoji branch', { git: { ...makeHudData().git, branch: 'feature/🔥-hot-path-🚀-rewrite' } }],
  ['no session yet', { session: undefined, contextUsage: undefined, tokenUsage: undefined, rateLimits: undefined }],
];

for (const mode of ['compact', 'expanded'] as LayoutMode[]) {
  for (const [label, overrides] of HOSTILE) {
    test(`${mode} layout fits every width: ${label}`, () => {
      const data = makeHudData(overrides);
      for (const width of TEST_WIDTHS) {
        const lines = renderHud(data, {
          width,
          showDetails: mode !== 'compact',
          layout: { ...DEFAULT_LAYOUT, mode },
        });
        for (const line of lines) {
          assert.ok(
            visualWidth(line) <= width,
            `${label} at ${width} columns produced ${visualWidth(line)}: ${JSON.stringify(stripAnsi(line))}`
          );
          assert.ok(
            !stripAnsi(line).includes('\x1b'),
            `${label} at ${width} columns leaked an escape sequence`
          );
        }
      }
    });
  }
}

test('compact layout is exactly one line', () => {
  const lines = renderHud(makeHudData(), {
    width: 120,
    showDetails: false,
    layout: { ...DEFAULT_LAYOUT, mode: 'compact' },
  });
  assert.equal(lines.length, 1);
});
