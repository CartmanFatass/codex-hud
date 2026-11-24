import test from 'node:test';
import assert from 'node:assert/strict';
const NOW = Date.parse('2026-11-12T12:35:00Z');
import { workJobDetail as workCardDetail } from '../../dist/render/work-job-detail.js';
import { projectWorkCard } from '../../dist/collectors/work-card.js';
import { workInspectorRows } from '../../dist/render/work-inspector.js';
import { stripAnsi } from '../../dist/render/colors.js';
test('settled cards drop stale still-working or prompt-report quiet_decision while unsettled and quiet-failed keep it', (t) => {
  const base = { role: 'imp', task: 'Synthetic job', state: 'working', startedAt: NOW - 60000, settledAt: null, laneId: 'synthetic', work: { reason: 'Synthetic detail', phases: [] } };
  for (const [choice, action] of [['still-working', 'wait'], ['finished-no-report', 'prompt-report']]) {
    const settled = {
      ...base,
      state: 'closed',
      settledAt: NOW - 1000,
      quietDecision: { choice, probability: 0.92, action },
      work: { ...base.work, failed: false, result: true, reason: 'settled' },
    };
    const card = projectWorkCard(settled, NOW);
    assert.doesNotMatch(workCardDetail(card), /still-working|prompt-report|wait/);
    const inspector = (worker) => workInspectorRows(worker, 110, NOW).map((r) => stripAnsi(r.text)).join('\n');
    assert.doesNotMatch(inspector(settled), new RegExp(choice), 'the Inspector follows the card');
    assert.doesNotMatch(workInspectorRows(settled, 80, NOW).map(r => stripAnsi(r.text)).join('\n'), /still-working|prompt-report|wait/);

    const unsettled = { ...settled, state: 'working', settledAt: null, work: { ...base.work, failed: false, result: false, reason: 'quiet' } };
    assert.match(workCardDetail(projectWorkCard(unsettled, NOW)), new RegExp(`${choice} 92%`));
  }
  const failedByQuiet = {
    ...base,
    state: 'failed',
    settledAt: NOW - 1000,
    quietDecision: { choice: 'failed', probability: 0.96, action: 'fail' },
    work: { ...base.work, failed: true, result: false, reason: '429 rate limit' },
  };
  assert.match(workCardDetail(projectWorkCard(failedByQuiet, NOW)), /failed 96% → fail/);
  assert.match(workInspectorRows(failedByQuiet, 110, NOW).map((r) => stripAnsi(r.text)).join('\n'), /quiet\s+failed 96% → fail/);
});
