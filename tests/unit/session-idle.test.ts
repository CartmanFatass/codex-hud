/**
 * How long the main session has waited on the person since its turn
 * finished: on the bar's activity and the status card's state, from a minute
 * on, and only while it is idle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { useDisplayFixture } from '../fixtures/display.js';
import { makeHudData, FIXED_NOW } from '../fixtures/hud-data.js';
import { idleFor } from '../../src/render/monitor-labels.js';
import { buildBarModules } from '../../src/render/layout/bar-modules.js';
import { statusCard } from '../../src/render/status-block.js';
import { stripAnsi } from '../../src/render/colors.js';
import { setLanguage } from '../../src/render/i18n.js';

useDisplayFixture();
const now = FIXED_NOW.getTime();
const idle = (minutes: number) => ({ state: 'idle' as const, updatedAt: new Date(now - minutes * 60_000) });

test('idle time: from a minute on, only while idle, as ages are written', () => {
  assert.equal(idleFor(idle(0.5), now), '', 'under a minute: nothing yet');
  assert.equal(idleFor(idle(12), now), '12m');
  assert.equal(idleFor(idle(150), now), '2h');
  assert.equal(idleFor(idle(12), now, true), '', 'a stale reading says nothing of it');
  assert.equal(idleFor({ state: 'working', updatedAt: new Date(now - 720_000), turnStartedAt: new Date(now - 720_000) }, now), '');
  assert.equal(idleFor({ state: 'interrupted', updatedAt: new Date(now - 720_000) }, now), '', 'interrupted is marked on its own');
  assert.equal(idleFor(undefined, now), '');
});

test('the bar and the status card say how long the session has been idle', () => {
  const data = { ...makeHudData(), activity: idle(12) };
  const activity = (words: boolean) => buildBarModules(data, { nowMs: now, words }).find(module => module.id === 'activity')!.variants;
  const glyphs = activity(false);
  assert.equal(stripAnsi(glyphs.full!), '✓ idle 12m');
  assert.equal(stripAnsi(glyphs.short!), '✓ 12m');
  assert.equal(stripAnsi(glyphs.min!), '✓');
  assert.equal(stripAnsi(activity(true).full!), 'Idle 12m');
  const fresh = buildBarModules({ ...data, activity: idle(0.2) }, { nowMs: now }).find(module => module.id === 'activity')!.variants;
  assert.equal(stripAnsi(fresh.full!), '✓', 'just finished: the mark alone');
  assert.equal(stripAnsi(statusCard(data, now)!.state), '✓ Idle 12m');
  const previous = setLanguage('zh');
  try { assert.equal(stripAnsi(statusCard(data, now)!.state), '✓ 空闲 12m'); } finally { setLanguage(previous); }
});
