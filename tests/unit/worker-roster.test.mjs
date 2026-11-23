/** Model badges, Sonic child counts, and unread reports still used by job diagnostics. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import {
  workerModelName,
  workerModelBadge,
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

test('badges emit no ANSI under none; child counts and unread reports use observed state', () => {
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
    assert.equal(workerModelBadge(workers[0], 'full'), '◎ sol-fast◕');
    assert.equal(workerModelBadge(workers[0], 'compact'), '◎◕');
    assert.equal(workerModelBadge(workers[0], 'min'), '◎');
  } finally {
    setDisplayConfig(prev);
  }
});
