/**
 * The bar's notice zone: what changed between two collections, and how the
 * zone says it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BarNoticeTracker } from '../../src/collectors/bar-notices.js';
import { buildBarModules, NOTICE_FRESH_MS } from '../../src/render/layout/bar-modules.js';
import { stripAnsi } from '../../src/render/colors.js';
import type { HudData, SubagentStatus } from '../../src/types.js';
import { FIXED_NOW, makeHudData, makeSubagentTree } from '../fixtures/hud-data.js';

const T0 = FIXED_NOW.getTime();
const at = (seconds: number) => new Date(T0 + seconds * 1000);

function session(status: SubagentStatus, state: 'working' | 'idle', extra: Partial<HudData> = {}): HudData {
  return makeHudData({
    subagentTree: makeSubagentTree([{ id: 'a1', name: 'explorer', status, startedAt: at(0), model: 'gpt-5.6-astra', effort: 'high' }]),
    activity: state === 'working' ? { state, updatedAt: at(0), turnStartedAt: at(0) } : { state, updatedAt: at(0) },
    rateLimits: { primary: { used_percent: 40, window_minutes: 10080 } },
    ...extra,
  });
}

const notice = (data: HudData, nowMs: number) =>
  stripAnsi(buildBarModules(data, { nowMs }).find((module) => module.id === 'notice')!.variants.full ?? '');

test('a first look sets the baseline: nothing that happened before is replayed', () => {
  const tracker = new BarNoticeTracker();
  assert.deepEqual(tracker.observe(session('completed', 'working'), T0), []);
});

test('an agent that finishes or fails, and a turn that ends, are noticed once each', () => {
  const tracker = new BarNoticeTracker();
  tracker.observe(session('running', 'working'), T0);
  const done = tracker.observe(session('completed', 'working'), T0 + 5_000);
  assert.deepEqual(done.map((entry) => [entry.kind, entry.subject]), [['agent-done', 'explorer']]);
  assert.equal(tracker.observe(session('completed', 'working'), T0 + 6_000).length, 1, 'the same state again adds nothing');

  const ended = tracker.observe(session('completed', 'idle'), T0 + 768_000);
  assert.equal(ended[0].kind, 'turn-done');
  assert.equal(ended[0].durationMs, 768_000);

  const failing = new BarNoticeTracker();
  failing.observe(session('running', 'working'), T0);
  assert.deepEqual(failing.observe(session('error', 'working'), T0 + 1_000).map((entry) => entry.kind), ['agent-failed']);
});

test('a session found idle tells when its turn ended, from the activity\'s own time', () => {
  const tracker = new BarNoticeTracker();
  const idle = session('completed', 'idle', { activity: { state: 'idle', updatedAt: at(-420), turnStartedAt: at(-1188) } });
  const [turn] = tracker.observe(idle, T0);
  assert.equal(turn.kind, 'turn-done');
  assert.equal(turn.at.getTime(), at(-420).getTime());
  assert.equal(turn.durationMs, 768_000);
});

test('going on to credits is noticed when the window fills', () => {
  const tracker = new BarNoticeTracker();
  tracker.observe(session('running', 'working'), T0);
  const spent = session('running', 'working', {
    rateLimits: { primary: { used_percent: 100, window_minutes: 10080 }, credits: { has_credits: true, balance: '6800' } },
  });
  assert.deepEqual(tracker.observe(spent, T0 + 1_000).map((entry) => entry.kind), ['credits']);
  assert.equal(tracker.observe(spent, T0 + 2_000).length, 1);
});

test('another session starts with no notices', () => {
  const tracker = new BarNoticeTracker();
  tracker.observe(session('running', 'working'), T0);
  tracker.observe(session('completed', 'working'), T0 + 1_000);
  const other = session('running', 'working');
  other.session = { ...other.session!, id: 'another-session' };
  assert.deepEqual(tracker.observe(other, T0 + 2_000), []);
});

test('the zone tells what just happened for a minute, then the tool at work, then, idle, the last thing dim', () => {
  const finished = { kind: 'agent-done' as const, subject: 'explorer', at: at(0) };
  const working = { ...session('running', 'working'), notices: [finished] };
  assert.equal(notice(working, T0 + 12_000), '✓ explorer finished · 12s ago');
  assert.equal(notice(working, T0 + NOTICE_FRESH_MS), 'Edit src/types.ts', 'after a minute the tool at work has the zone again');
  const idle = { ...session('completed', 'idle'), notices: [finished] };
  assert.equal(notice(idle, T0 + 7 * 60_000), '✓ explorer finished · 7m ago');
  assert.equal(notice({ ...idle, notices: [{ kind: 'credits', at: at(0) }] }, T0 + 1_000), '◆ window spent, on credits now · 1s ago');
  assert.equal(notice({ ...idle, notices: [] }, T0), '', 'nothing happened yet: the zone is empty');
});

test('a script call is told by the command it runs, else the tool it calls', () => {
  const working = session('running', 'working');
  const script = (code: string) => ({ ...working, toolActivity: { ...working.toolActivity!, recentCalls: [
    { id: 'c1', name: 'exec', timestamp: at(0), status: 'running' as const, arguments: { code } },
  ] } });
  assert.equal(notice(script('text(await tools.exec_command({cmd:"npm test -- --watch",max_output_tokens:4000}))'), T0), 'exec npm test -- --watch');
  assert.equal(notice(script('await tools.write_stdin({session_id:7,chars:""})'), T0), 'exec write_stdin');
});
