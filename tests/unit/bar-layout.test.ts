/**
 * The owner-facing Codex tmux bar: one rendered frame per keep.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fitModules } from '../../src/render/layout/engine.js';
import { buildBarModules } from '../../src/render/layout/bar-modules.js';
import { fitStatusBar } from '../../src/render/header.js';
import { stripAnsi, visualWidth } from '../../src/render/colors.js';
import { DEFAULT_LAYOUT } from '../../src/types.js';
import { makeHudData, makeSubagentTree, FIXED_NOW } from '../fixtures/hud-data.js';

test('the bar reads without gaps up to the notice zone, and what Codex loaded sits at the right edge', () => {
  const calm = makeHudData({
    project: { ...makeHudData().project, skillsCount: 10, hooksCount: 1 },
    subagentTree: makeSubagentTree([
      { id: 'a1', name: 'explorer', status: 'running', startedAt: FIXED_NOW, model: 'gpt-5.6-astra', effort: 'high' },
    ]),
    activity: { state: 'working', updatedAt: FIXED_NOW, turnStartedAt: FIXED_NOW },
    outputRate: { tokensPerSecond: 57.3, sampleMs: 4000, sampledAt: FIXED_NOW },
  });
  const fit = fitStatusBar(calm, { ...DEFAULT_LAYOUT, mode: 'compact' }, 200);
  assert.deepEqual(fit.kept, [
    'identity',
    'context',
    'project',
    'quota',
    'activity',
    'speed',
    'agents',
    'tasks',
    'notice',
    'config',
  ]);
  const text = stripAnsi(fit.line);
  assert.match(
    text,
    /^gpt-5\.6-astra xhigh │ ━+─+ 114\.2K\/272K │ codex-hud main\*↑2 │ 5h 61% │ ▸ +\S+ │  57 tok\/s │ Agents 1▸ │ Tasks 2\/5 │ Edit src\/types\.ts {3,}MCP 2  skills 10  hooks 1$/
  );
  assert.ok(!/Ctx|Q61|\bPlan\b|◷/.test(text), text);
  assert.equal(visualWidth(fit.line), 200);

  // An alert takes the zone's front, and the tool at work keeps what room is left.
  const alert = stripAnsi(
    fitStatusBar(makeHudData({ activity: calm.activity }), { ...DEFAULT_LAYOUT, mode: 'compact' }, 170).line
  );
  assert.match(alert, /│ Tasks 2\/5 │  ✗ [^│]*failed {3}Edit src\/types\.ts/);
  // The zone keeps its room before what Codex loaded keeps its place.
  const noticed = makeHudData({
    activity: calm.activity,
    project: calm.project,
    outputRate: calm.outputRate,
    notices: [{ kind: 'agent-done', subject: 'streaming_docs', at: new Date(FIXED_NOW.getTime() - 12_000) }],
  });
  const roomy = fitModules(buildBarModules(noticed, { nowMs: FIXED_NOW.getTime(), density: 'balanced' }), {
    width: 200,
    separator: ' │ ',
    groupSeparator: '  ',
  });
  assert.ok(!roomy.kept.includes('config'), roomy.kept.join(' '));
  assert.match(stripAnsi(roomy.line), /failed {3}✓ streaming_docs finished · 12s ago$/);
});
