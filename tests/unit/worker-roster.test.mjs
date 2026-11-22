/** Compact Home worker-roster helper: Variant A short names, narrowing ladder, sonic running-only `⚡N`, zero raw ANSI in `none`. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import {
  workerModelName,
  workerModelBadge,
  renderWorkerRoster,
  sonicChildrenRunning,
  isUnreadReport,
} from '../../dist/render/worker-roster.js';

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const MIN = 60_000;

test('workerModelName derives short names from catalog rules matching statusline-workers Variant A', () => {
  const cases = [
    ['gpt-6.2-sol-fast', 'sol-fast'],
    ['gpt-6.2-sol', 'sol'],
    ['gpt-6-astra', 'astra'],
    ['gpt-6.1-terra', 'terra'],
    ['gpt-6-luna', 'luna'],
    ['claude-opus-5-5', 'opus'],
    ['claude-sonnet-5-5', 'sonnet'],
    ['claude-fable-5-2', 'fable'],
    ['haiku', 'haiku'],
    ['gemini-4-hydrogen-high', 'hydrogen'],
    ['gemini-4-argon-high', 'argon'],
    ['gemini-3.8-flash-high', 'flash'],
    ['gemini-4-neon-high', 'neon'],
    ['gemini-4-carbon-high', 'carbon'],
    ['deepseek-v4-1-flash-1017', 'ds'],
    ['zai-glm-5-3', 'glm'],
    ['mistral-large-4', 'mis'],
    ['grok-4.7', 'xai'],
  ];
  for (const [id, want] of cases) assert.equal(workerModelName(id), want, id);
});

test('renderWorkerRoster follows Variant A rungs, counts only running sonic as ⚡N, and emits no ANSI under none', () => {
  const w = (id, role, model, effort, extra = {}) => ({
    id,
    laneId: 'lane',
    harness: 'pi',
    role,
    task: 'Synthetic task',
    model,
    effort,
    state: 'working',
    startedAt: NOW - 10 * MIN,
    settledAt: null,
    phase: 'build',
    homeNeedsHuman: false,
    humanEndedAt: null,
    stale: false,
    evidence: [],
    ...extra,
  });
  const workers = [
    w('j1', 'imp', 'gpt-6.2-sol-fast', 'high', { startedAt: NOW - 15 * MIN }),
    w('j2', 'imp', 'gpt-6.2-sol-fast', 'high', { startedAt: NOW - 14 * MIN, homeNeedsHuman: true }),
    w('j3', 'general', 'gemini-4-neon-high', 'high', { startedAt: NOW - 12 * MIN, state: 'failed', settledAt: NOW - 4 * MIN, work: { failed: true } }),
    w('j4', 'frontend', 'claude-sonnet-5-5', 'xhigh', { startedAt: NOW - 10 * MIN, state: 'done', settledAt: NOW - 2 * MIN, reportUnread: true }),
    w('s1', 'sonic', 'deepseek-v4-1-flash-1017', 'high', { parentJobId: 'j1' }),
    w('s2', 'sonic', 'deepseek-v4-1-flash-1017', 'high', { parentJobId: 'j1' }),
    w('s3', 'sonic', 'deepseek-v4-1-flash-1017', 'high', { parentJobId: 'j1', state: 'done', settledAt: NOW - MIN }),
  ];

  assert.equal(sonicChildrenRunning(workers, 'j1'), 2, 'finished sonic child adds nothing');
  assert.equal(isUnreadReport(workers[3]), true);

  const prev = setDisplayConfig({ theme: 'none', icons: 'unicode' });
  try {
    const full = renderWorkerRoster(workers, 'full', NOW);
    assert.doesNotMatch(full, /\x1b/, 'none theme emits zero ANSI escapes');
    assert.equal(full, '◎ sol-fast◕ 2 ?  ▲ neon◕ 1 ✗  ✻ sonnet● 1 ✓●  ⚡2');
    assert.equal(renderWorkerRoster(workers, 'no-model', NOW), '◎◕2 ?  ▲◕1 ✗  ✻●1 ✓●  ⚡2');
    assert.equal(renderWorkerRoster(workers, 'provider', NOW), '◎2 ?  ▲1 ✗  ✻1 ✓●  ⚡2');
    assert.equal(renderWorkerRoster(workers, 'compact', NOW), '◉2 ⚡2');
    assert.equal(workerModelBadge(workers[0], 'full'), '◎ sol-fast◕');
    assert.equal(workerModelBadge(workers[0], 'compact'), '◎◕');
    assert.equal(workerModelBadge(workers[0], 'min'), '◎');
    assert.equal(visualLength(full), 49, '⚡ occupies 2 terminal cells');
  } finally {
    setDisplayConfig(prev);
  }

  const prevAscii = setDisplayConfig({ theme: 'terminal', icons: 'text' });
  try {
    const ascii = stripAnsi(renderWorkerRoster(workers, 'provider', NOW, true));
    assert.equal(ascii, 'OAI2 ?  Gem1 x  Ant1 +*  *2');
  } finally {
    setDisplayConfig(prevAscii);
  }
});
