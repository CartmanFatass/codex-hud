import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { judge, procStat, workerAlive } from '../../packages/hud-mcp/dist/packages/hud-mcp/src/cli-judge.js';

test('worker identity: missing start is unknown for a live PID, but absence is still an exit fact', async () => {
  assert.equal(workerAlive(process.pid, procStat(process.pid).start), true);
  assert.equal(workerAlive(process.pid, null), null);
  assert.equal(workerAlive(process.pid, '0'), false);
  assert.equal(workerAlive(null, null), null);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await once(child, 'exit');
  assert.equal(workerAlive(child.pid, null), false);
});

const turn = { seq: 1, sent_at: new Date(0).toISOString(), report_sig: null };
const facts = { turn, reportSig: null, alive: true, status: 'working', newerChild: false,
  stop: false, close: false, openQuestions: false, canContinue: true, graceMs: 600_000 };
const initial = judge(null, facts, 0);
const quiet = judge(initial, { ...facts, status: 'done', reportSig: 'report' }, 1000);
const idle = judge(quiet, { ...facts, status: 'done', reportSig: 'report' }, 11_000);
const noReport = judge(initial, { ...facts, status: 'done' }, 1000);

const rows = [
  ['working at rest', initial, facts, 30_000, { state: 'working', wakeAt: null, action: null }],
  ['PID gone without report', initial, { alive: false }, 2, { state: 'failed', exitReason: 'worker exited' }],
  ['PID gone with report despite working', initial, { alive: false, reportSig: 'report' }, 2, { state: 'closed', outputWritten: true }],
  ['tab closure', initial, { tabClosed: true }, 2, { state: 'failed', exitReason: 'tab closed' }],
  ['stop', initial, { stop: true }, 2, { state: 'stopped' }],
  ['close', initial, { close: true }, 2, { state: 'closed', action: 'quit' }],
  ['blocked', initial, { status: 'blocked' }, 2, { state: 'waiting_orchestrator', blocked: true }],
  ['open question', quiet, { openQuestions: true }, 11_000, { state: 'waiting_orchestrator', quietSince: null }],
  ['report while summary is working', initial, { reportSig: 'report' }, 60_000, { state: 'working', quietSince: null }],
  ['quiet starts on done', initial, { status: 'done', reportSig: 'report' }, 1000, { state: 'working', wakeAt: 11_000 }],
  ['ten seconds settles report', quiet, { status: 'done', reportSig: 'report' }, 11_000, { state: 'idle_grace', outputWritten: true, wakeAt: 611_000 }],
  ['partial report resets stability', quiet, { status: 'done', reportSig: 'rewritten' }, 11_000, { state: 'working', quietSince: 11_000, wakeAt: 21_000 }],
  ['working flap resets quiet', quiet, { reportSig: 'report' }, 9000, { state: 'working', quietSince: null }],
  ['working push inside debounce resets quiet', quiet, { status: 'done', reportSig: 'report', workingAt: 10_900 }, 11_000, { state: 'working', quietSince: 11_000, wakeAt: 21_000 }],
  ['unknown child sample cannot settle', quiet, { status: 'done', reportSig: 'report', newerChild: null }, 11_000, { state: 'working', action: 'sample' }],
  ['child does not hold report from grace', quiet, { status: 'done', reportSig: 'report', newerChild: true }, 11_000, { state: 'idle_grace', outputWritten: true }],
  ['noncontinuable report closes', quiet, { status: 'done', reportSig: 'report', canContinue: false }, 11_000, { state: 'closed', action: 'quit' }],
  ['child holds noncontinuable quit, not report', quiet, { status: 'done', reportSig: 'report', canContinue: false, newerChild: true }, 11_000, { state: 'idle_grace', outputWritten: true, deadline: 11_000, wakeAt: null, action: null }],
  ['no-report child holds quiet clock', noReport, { status: 'done', newerChild: true }, 601_000, { state: 'working', quietSince: null, action: null }],
  ['no-report deadline', noReport, { status: 'done' }, 601_000, { state: 'working', action: 'decide' }],
  ['unknown child cannot decide', noReport, { status: 'done', newerChild: null }, 601_000, { state: 'working', action: 'sample' }],
  ['decision wait', noReport, { status: 'done', decision: { action: 'wait' } }, 601_000, { state: 'working', wakeAt: 1_201_000 }],
  ['decision prompt', noReport, { status: 'done', decision: { action: 'prompt-report' } }, 601_000, { state: 'working', wakeAt: 1_201_000 }],
  ['decision human', noReport, { status: 'done', decision: { action: 'needs-human' } }, 601_000, { state: 'waiting_orchestrator', quietHandled: true }],
  ['decision quota', noReport, { status: 'done', decision: { action: 'fail', failReason: 'quota line' } }, 601_000, { state: 'failed', exitReason: 'quota line' }],
  ['idle before deadline', idle, { status: 'done', reportSig: 'report' }, 20_000, { state: 'idle_grace', wakeAt: 611_000 }],
  ['idle deadline', idle, { status: 'done', reportSig: 'report' }, 611_000, { state: 'closed', action: 'quit' }],
  ['working holds idle deadline', idle, { reportSig: 'report' }, 611_000, { state: 'idle_grace', action: null, wakeAt: null }],
  ['outage does not hold an already-settled idle deadline', idle, { status: null, reportSig: 'report' }, 611_000, { state: 'closed', action: 'quit' }],
  ['child holds idle deadline', idle, { status: 'done', reportSig: 'report', newerChild: true }, 611_000, { state: 'idle_grace', action: null }],
  ['idle deadline samples lazily', idle, { status: 'done', reportSig: 'report', newerChild: null }, 611_000, { state: 'idle_grace', action: 'sample' }],
  ['only explicit turn reopens', idle, { status: 'done', reportSig: 'report', turn: { ...turn, seq: 2, report_sig: 'report' } }, 20_000, { state: 'working', outputWritten: false, settledAt: null, deadline: null }],
  ['error without report never decides', initial, { status: null }, 60_000, { state: 'working', wakeAt: null, action: null }],
  ['supervisor error', initial, { supervisorError: 'supervisor error' }, 2, { state: 'waiting_orchestrator', reason: 'supervisor error' }],
];
for (const [name, prev, patch, now, expected] of rows) test('judge: ' + name, () => {
  const before = JSON.stringify(prev);
  const result = judge(prev, { ...facts, ...patch }, now);
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(result[key], value, key);
  assert.equal(JSON.stringify(prev), before, 'pure: previous judgment is unchanged');
});

test('judge: 60s continuous errors include the stability window, and recovery resets the outage', () => {
  let prev = judge(initial, { ...facts, status: null, reportSig: 'report' }, 0);
  assert.equal(prev.wakeAt, 60_000);
  prev = judge(prev, { ...facts, status: null, reportSig: 'report' }, 59_999);
  assert.equal(prev.state, 'working');
  assert.equal(judge(prev, { ...facts, status: null, reportSig: 'report' }, 60_000).state, 'idle_grace');
  prev = judge(prev, { ...facts, status: 'working', reportSig: 'report' }, 59_999);
  prev = judge(prev, { ...facts, status: null, reportSig: 'report' }, 60_000);
  assert.equal(prev.wakeAt, 120_000);
});

test('judge: unknown pid requires three consecutive missing ticks and never fails', () => {
  let prev = initial;
  for (let i = 1; i <= 3; i++) {
    prev = judge(prev, { ...facts, alive: null, agentMissing: true, status: null, tick: true }, i * 30_000);
    assert.equal(prev.state, i === 3 ? 'waiting_orchestrator' : 'working');
  }
  assert.equal(prev.reason, 'worker not found');
  prev = judge(prev, { ...facts, alive: null, agentMissing: false, tick: true }, 120_000);
  assert.equal(prev.missingTicks, 0);
});

test('judge: a handled quiet episode does not ask repeatedly, a new turn can ask again', () => {
  let prev = judge(noReport, { ...facts, status: 'done', decision: { action: 'needs-human' } }, 601_000);
  prev = judge(prev, { ...facts, status: 'done' }, 700_000);
  assert.equal(prev.action, null);
  assert.equal(prev.state, 'waiting_orchestrator');
  prev = judge(prev, { ...facts, status: 'done', turn: { ...turn, seq: 2 } }, 700_001);
  assert.equal(prev.state, 'working');
  assert.equal(prev.quietHandled, false);
});
