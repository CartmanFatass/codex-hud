/**
 * Render cost guard. The HUD repaints four times a second in every pane, so a
 * regression here shows up as terminal lag rather than a failed assertion.
 * The bound is deliberately loose; the printed number is the thing to watch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderHud } from '../../src/render/header.js';
import { DEFAULT_LAYOUT } from '../../src/types.js';
import { makeHudData } from '../fixtures/hud-data.js';

const FRAMES = 2000;
const BUDGET_MS_PER_FRAME = 1.0;

test(`rendering ${FRAMES} frames stays under ${BUDGET_MS_PER_FRAME}ms each`, () => {
  const data = makeHudData();
  const options = { width: 120, showDetails: true, layout: { ...DEFAULT_LAYOUT, mode: 'expanded' as const } };

  // Warm the JIT so the measurement reflects steady state.
  for (let i = 0; i < 200; i++) {
    renderHud(data, options);
  }

  const started = process.hrtime.bigint();
  for (let i = 0; i < FRAMES; i++) {
    renderHud(data, options);
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const perFrame = elapsedMs / FRAMES;

  console.log(`    render: ${perFrame.toFixed(3)}ms per frame (${FRAMES} frames, 120 columns)`);
  assert.ok(perFrame < BUDGET_MS_PER_FRAME, `${perFrame.toFixed(3)}ms per frame exceeds the budget`);
});
