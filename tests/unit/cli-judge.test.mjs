import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapWorkerTree, rememberWorkerTree } from '../../dist/roles/worker-tree.js';
import { judge, procStat, withDonePrompt, workerAlive, workerHasChild } from '../../dist/mcp/cli-judge.js';

test('Claude and Codex CLI finishing prompts stay unchanged', () => {
  const turn = { seq: 1, sent_at: '2026-11-22T00:00:00.000Z', report_sig: null };
  const expected = 'Synthetic task.\n\nFinish with hud_report. Use the token in the prompt you are answering, not a newer turn. turn: 1@2026-11-22T00:00:00.000Z\n';
  for (const agent of ['claude', 'codex']) {
    assert.equal(withDonePrompt('Synthetic task.', '/synthetic/hud-mcp', '/synthetic/job', turn, agent), expected, agent);
  }
});

test('worker identity: missing start is unknown for a live PID, but absence is still an exit fact', async () => {
  assert.equal(workerAlive(process.pid, procStat(process.pid).start), true);
  assert.equal(workerAlive(process.pid, null), null);
  assert.equal(workerAlive(process.pid, '0'), false);
  assert.equal(workerAlive(null, null), null);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const exited = once(child, 'exit');
  try {
    const oldTurn = new Date(0).toISOString();
    assert.equal(workerHasChild(process.pid, null, oldTurn), false);
    assert.equal(workerHasChild(process.pid, '0', oldTurn), false, 'a reused worker PID does not count');
    assert.equal(workerHasChild(process.pid, procStat(process.pid).start, oldTurn), true);
    const newTurn = new Date(Date.now() + 1000).toISOString();
    assert.equal(workerHasChild(process.pid, procStat(process.pid).start, newTurn), false);
  } finally {
    child.kill();
    await exited;
  }
  assert.equal(workerAlive(child.pid, null), false);
});

test('worker reap: cleans captured descendants after root exit, including detached ones', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hud-worker-tree-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pane = 'w4E:p2';
  writeFileSync(join(dir, 'SESSION.txt'), `LEFT=${pane}\nORCH=w4E:p1\n`);
  const env = { ...process.env, HUD_JOB_DIR: dir, HERDR_PANE_ID: pane };
  const script = `
    const { spawn } = require('node:child_process');
    const children = [false, true].map(detached => spawn(process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { detached, stdio: 'ignore' }));
    process.send(children.map(child => child.pid));
  `;
  const worker = spawn(process.execPath, ['-e', script], { detached: true, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, env, stdio: 'ignore' });
  const rootExit = once(worker, 'exit'), unrelatedExit = once(unrelated, 'exit');
  let stamps = [];
  t.after(async () => {
    for (const child of [worker, unrelated]) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    for (const [pid, start] of stamps) if (workerAlive(pid, start)) process.kill(pid, 'SIGKILL');
    await Promise.all([rootExit, unrelatedExit]);
  });
  const [[groupChild, detachedChild]] = await once(worker, 'message');
  stamps = [groupChild, detachedChild].map((pid) => [pid, procStat(pid).start]);
  const status = { slot: 'primary', task_dir: dir, pid: worker.pid, pid_start_time: procStat(worker.pid).start };
  const { snapshot, issue } = rememberWorkerTree(dir, status);
  assert.equal(issue, undefined);
  assert.deepEqual(snapshot.members.map(({ pid }) => pid).sort(), [groupChild, detachedChild].sort());
  worker.kill('SIGTERM');
  await rootExit;
  assert.ok(stamps.every(([pid, start]) => workerAlive(pid, start)), 'both would survive worker-only reap');
  const { complete } = await reapWorkerTree(dir, status, () => true, Boolean);
  assert.equal(complete, true);
  assert.ok(stamps.every(([pid, start]) => !workerAlive(pid, start)));
  assert.ok(workerAlive(unrelated.pid, procStat(unrelated.pid).start));
});

test('worker reap: a same-group, tagged sibling is not a descendant; PID reuse suppresses each signal', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hud-worker-tree-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'SESSION.txt'), 'LEFT=w4E:p2\nORCH=w4E:p1\n');
  const [root, child, reused, sibling] = [91_001, 91_002, 91_003, 91_004];
  const procs = new Map([[root, [50, 100]], [child, [root, 101]], [reused, [root, 102]], [sibling, [50, 103]]]);
  const signals = [];
  const { readFileSync, readdirSync } = fs;
  t.mock.method(fs, 'readdirSync', (path, ...args) => path === '/proc' ? [...procs.keys()].map(String) : readdirSync(path, ...args));
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    const pid = Number(/^\/proc\/(\d+)\/(?:stat|environ)$/.exec(String(path))?.[1]);
    if (pid < root || pid > sibling || !Number.isFinite(pid)) return readFileSync(path, ...args);
    if (!procs.has(pid)) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    const [parent, start] = procs.get(pid);
    if (path.endsWith('/environ')) return `HUD_JOB_DIR=${dir}\0HERDR_PANE_ID=w4E:p2\0`;
    return `${pid} (synthetic) S ${parent} ${root} ${'0 '.repeat(16)}${start}\n`;
  });
  t.mock.method(process, 'kill', (pid, signal) => {
    signals.push([pid, signal]);
    if (pid === child && signal === 'SIGTERM') procs.set(child, [50, 201]); // Reuse during the TERM/KILL wait.
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const status = { slot: 'primary', task_dir: dir, pid: root, pid_start_time: '100' };
  const { complete } = await reapWorkerTree(dir, status, () => {
    procs.delete(root);
    procs.set(child, [1, 101]);
    procs.set(reused, [50, 202]); // Reuse before the initial TERM.
    return false; // Even on a tab ownership refusal, only proof can authorize a signal.
  }, Boolean);
  assert.equal(complete, false);
  assert.deepEqual(signals, [[child, 'SIGTERM']]);
});

const mcpArgs = ['-e', 'setInterval(() => {}, 1000)', 'hud-mcp'];
for (const [label, command, args, ageMs, busy] of [
  ['direct MCP server during launch is not busy', process.execPath, mcpArgs, 500, false],
  ['shell during launch is busy', '/bin/bash', ['-c', 'read -r line'], 500, true],
  ['non-shell after the launch window is busy', process.execPath, mcpArgs, 20_000, true],
]) {
  test(`worker child: ${label}`, async () => {
    const child = spawn(command, args);
    const exited = once(child, 'exit');
    try {
      const boot = Date.now() - parseFloat(readFileSync('/proc/uptime', 'utf8')) * 1000;
      const sentAt = new Date(boot + Number(procStat(child.pid).start) * 10 - ageMs).toISOString();
      assert.equal(workerHasChild(process.pid, procStat(process.pid).start, sentAt, sentAt), busy);
    } finally {
      child.kill();
      await exited;
    }
  });
}

const turn = { seq: 1, sent_at: new Date(0).toISOString(), report_sig: null };
const facts = { turn, reportSig: null, reportRead: false, alive: true, status: 'working', liveChild: false,
  stop: false, close: false, openQuestions: false, canContinue: true, graceMs: 600_000 };
const initial = judge(null, facts, 0);
const quiet = judge(initial, { ...facts, status: 'done', reportSig: 'report' }, 1000);
const idle = judge(quiet, { ...facts, status: 'done', reportSig: 'report' }, 11_000);
const noReport = judge(initial, { ...facts, status: 'done' }, 1000);

const done = { seq: turn.seq, sent_at: turn.sent_at, report_sig: 'report', at: new Date(1000).toISOString() };
const declared = { ...facts, reportSig: 'report', done, liveChild: true };

test('judge: scrolling a stale marker out of view never declares a draft', () => {
  const draft = { ...facts, turn: { ...turn, seq: 3 }, reportSig: 'draft', reportRead: true,
    liveChild: true, reportMarker: 'two old markers' };
  const before = judge(initial, draft, 1000);
  const later = { ...draft, reportMarker: 'one old marker' };
  assert.equal(judge(judge(before, later, 2000), later, 32_000).state, 'working');
});

test('judge: renewed old idle cannot waive a live child even on a read draft', () => {
  const draft = { ...facts, stateTrust: 'turn', workingAt: 0, status: 'idle', idleAt: 500,
    reportMtime: 600, reportSig: 'draft', reportRead: true, liveChild: true };
  const before = judge(initial, draft, 1000);
  const later = { ...draft, idleAt: 31_000 };
  assert.equal(judge(judge(before, later, 31_000), later, 42_000).state, 'working');
});

test('judge: matching receipt settles; shell counter changes and missing pane reads cannot invalidate it', () => {
  const settled = judge(initial, { ...declared, paneSig: '2 shells' }, 1000);
  assert.equal(settled.state, 'idle_grace');
  assert.equal(settled.outputWritten, true);
  const changed = judge(settled, { ...declared, paneSig: '1 shell' }, 2000);
  assert.equal(changed.deadline, settled.deadline);
  assert.equal(judge(changed, { ...declared, status: null, reportRead: true }, 3000).action, 'quit');
  assert.equal(judge(changed, declared, changed.deadline).state, 'closed');
  assert.equal(judge(initial, { ...declared, canContinue: false }, 1000).action, 'quit');
});

const rewritten = { ...declared, reportSig: 'rewrite', reportRead: true, status: 'idle', liveChild: false,
  stateTrust: 'turn', workingAt: 0 };

test('judge: rewritten report hands a quiet turn to the main session after the role grace', () => {
  const settled = judge(initial, declared, 1000);
  const due = 2000 + facts.graceMs;
  for (const previous of [settled, null]) { // A restarted supervisor still sees the old receipt on disk.
    const reopened = judge(previous, rewritten, 2000);
    assert.equal(reopened.state, 'working');
    assert.equal(reopened.wakeAt, due);
    const beforeDue = judge(reopened, rewritten, due - 1);
    assert.equal(beforeDue.state, 'working');
    assert.equal(judge(beforeDue, { ...rewritten, liveChild: null }, due).action, 'sample');
    const handedOff = judge(beforeDue, rewritten, due);
    assert.equal(handedOff.state, 'waiting_orchestrator');
    assert.equal(handedOff.reason, 'report changed after done receipt; no new receipt (hud_send to continue or hud_close to stop)');
    assert.equal(handedOff.action, null);
    assert.equal(handedOff.outputWritten, false);
    assert.equal(handedOff.settledAt, null);
    assert.equal(handedOff.deadline, null);
    assert.deepEqual(judge(handedOff, rewritten, due + 30_000), handedOff);
    const replacement = { ...rewritten, reportRead: false, done: { ...done, report_sig: 'rewrite' } };
    assert.equal(judge(handedOff, replacement, due + 1).state, 'idle_grace');
  }
});

test('judge: work or another rewrite restarts the fresh-receipt grace', () => {
  const quiet = judge(initial, rewritten, 2000);
  const due = 2000 + facts.graceMs;
  for (const [patch, quietAt] of [
    [{ status: 'working' }, due + 1], [{ liveChild: true }, due + 1],
    [{ workingAt: due - 1 }, due], [{ reportSig: 'rewrite again' }, due],
  ]) {
    const active = judge(quiet, { ...rewritten, ...patch }, due);
    assert.equal(active.state, 'working');
    assert.equal(active.action, null);
    const next = judge(active, { ...rewritten, ...patch, status: 'idle', liveChild: false }, due + 1);
    assert.equal(next.state, 'working');
    assert.equal(next.wakeAt, quietAt + facts.graceMs);
  }
});

test('judge: advisory blocked does not hold a valid receipt, but an open question does', () => {
  const blocked = { ...declared, status: 'blocked' };
  const settled = judge(initial, blocked, 1000);
  assert.equal(settled.state, 'idle_grace');
  assert.equal(settled.wakeAt, settled.deadline);
  assert.equal(judge(settled, { ...blocked, openQuestions: true }, 2000).state, 'waiting_orchestrator');
  assert.equal(judge(settled, blocked, settled.deadline).action, 'quit');
});

test('judge: new turn or a reused sequence with a different send time invalidates a receipt', () => {
  const settled = judge(initial, declared, 1000);
  for (const newTurn of [{ ...turn, seq: 2 }, { ...turn, sent_at: new Date(2000).toISOString() }]) {
    assert.equal(judge(settled, { ...declared, turn: newTurn }, 3000).state, 'working');
  }
  const stale = { ...declared, turn: { ...turn, report_sig: 'report' }, status: 'idle' };
  assert.equal(judge(initial, stale, 1000).quietSince, null, 'unchanged report does not count even with a receipt');
});

const rows = [
  ['working at rest', initial, facts, 30_000, { state: 'working', wakeAt: null, action: null }],
  ['PID gone without report', initial, { alive: false }, 2, { state: 'failed', exitReason: 'worker exited' }],
  ['PID gone with report despite working', initial, { alive: false, reportSig: 'report' }, 2, { state: 'closed', outputWritten: true }],
  ['tab closure', initial, { tabClosed: true }, 2, { state: 'failed', exitReason: 'tab closed' }],
  ['stop', initial, { stop: true }, 2, { state: 'stopped' }],
  ['stop then the worker is killed', initial, { stop: true, alive: false }, 2, { state: 'stopped', exitReason: 'stop requested' }],
  ['stop then the tab is closed', initial, { stop: true, tabClosed: true }, 2, { state: 'stopped', exitReason: 'stop requested' }],
  ['close', initial, { close: true }, 2, { state: 'closed', action: 'quit' }],
  ['blocked', initial, { status: 'blocked' }, 2, { state: 'waiting_orchestrator', blocked: true }],
  ['open question', quiet, { openQuestions: true }, 11_000, { state: 'waiting_orchestrator', quietSince: null }],
  ['report while summary is working', initial, { reportSig: 'report' }, 60_000, { state: 'working', quietSince: null }],
  ['quiet starts on done', initial, { status: 'done', reportSig: 'report' }, 1000, { state: 'working', wakeAt: 11_000 }],
  ['ten seconds settles report', quiet, { status: 'done', reportSig: 'report' }, 11_000, { state: 'idle_grace', outputWritten: true, wakeAt: 611_000 }],
  ['partial report resets stability', quiet, { status: 'done', reportSig: 'rewritten' }, 11_000, { state: 'working', quietSince: 11_000, wakeAt: 21_000 }],
  ['working flap resets quiet', quiet, { reportSig: 'report' }, 9000, { state: 'working', quietSince: null }],
  ['working push inside debounce resets quiet', quiet, { status: 'done', reportSig: 'report', workingAt: 10_900 }, 11_000, { state: 'working', quietSince: 11_000, wakeAt: 21_000 }],
  ['unsampled child fact cannot settle', quiet, { status: 'done', reportSig: 'report', liveChild: null }, 11_000, { state: 'working', action: 'sample' }],
  ['child holds report from grace', quiet, { status: 'done', reportSig: 'report', liveChild: true }, 11_000, { state: 'working', settledAt: null, outputWritten: false }],
  ['noncontinuable report closes', quiet, { status: 'done', reportSig: 'report', canContinue: false }, 11_000, { state: 'closed', action: 'quit' }],
  ['child holds noncontinuable settlement and quit', quiet, { status: 'done', reportSig: 'report', canContinue: false, liveChild: true }, 11_000, { state: 'working', outputWritten: false, deadline: null, wakeAt: null, action: null }],
  ['no-report child holds quiet clock', noReport, { status: 'done', liveChild: true }, 601_000, { state: 'working', quietSince: null, action: null }],
  ['no-report deadline', noReport, { status: 'done' }, 601_000, { state: 'working', action: 'decide' }],
  ['unsampled child fact cannot decide', noReport, { status: 'done', liveChild: null }, 601_000, { state: 'working', action: 'sample' }],
  ['decision wait', noReport, { status: 'done', decision: { action: 'wait' } }, 601_000, { state: 'working', wakeAt: 1_201_000 }],
  ['decision prompt', noReport, { status: 'done', decision: { action: 'prompt-report' } }, 601_000, { state: 'working', wakeAt: 1_201_000 }],
  ['decision human', noReport, { status: 'done', decision: { action: 'needs-human' } }, 601_000, { state: 'waiting_orchestrator', quietHandled: true }],
  ['decision quota', noReport, { status: 'done', decision: { action: 'fail', failReason: 'quota line' } }, 601_000, { state: 'failed', exitReason: 'quota line' }],
  ['idle before deadline', idle, { status: 'done', reportSig: 'report' }, 20_000, { state: 'idle_grace', wakeAt: 611_000 }],
  ['idle deadline', idle, { status: 'done', reportSig: 'report' }, 611_000, { state: 'closed', action: 'quit' }],
  ['working holds idle deadline', idle, { reportSig: 'report' }, 611_000, { state: 'idle_grace', action: null, wakeAt: null }],
  ['outage does not hold an already-settled idle deadline', idle, { status: null, reportSig: 'report' }, 611_000, { state: 'closed', action: 'quit' }],
  ['child holds idle deadline', idle, { status: 'done', reportSig: 'report', liveChild: true }, 611_000, { state: 'idle_grace', action: null }],
  ['idle deadline samples lazily', idle, { status: 'done', reportSig: 'report', liveChild: null }, 611_000, { state: 'idle_grace', action: 'sample' }],
  ['only explicit turn reopens', idle, { status: 'done', reportSig: 'report', turn: { ...turn, seq: 2, report_sig: 'report' } }, 20_000, { state: 'working', outputWritten: false, settledAt: null, deadline: null }],
  ['error without report never decides', initial, { status: null }, 60_000, { state: 'working', wakeAt: null, action: null }],
  ['supervisor error', initial, { supervisorError: 'supervisor error' }, 2, { state: 'waiting_orchestrator', reason: 'supervisor error' }],
];
test('judge: pure state transitions across working, quiet, decision, grace and terminal inputs', () => {
  for (const [name, prev, patch, now, expected] of rows) {
    const before = JSON.stringify(prev);
    const result = judge(prev, { ...facts, ...patch }, now);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(result[key], value, `${name}: ${key}`);
    assert.equal(JSON.stringify(prev), before, `${name}: pure: previous judgment is unchanged`);
  }
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

test('judge: turn trust settles a stable report at 2s after done or idle, never before', () => {
  for (const status of ['done', 'idle']) {
    const observed = { ...facts, stateTrust: 'turn', workingAt: 0, status, reportSig: 'report' };
    let prev = judge(initial, observed, 1000);
    assert.equal(prev.wakeAt, 3000);
    assert.equal(judge(prev, observed, 2999).state, 'working');
    prev = judge(prev, observed, 3000);
    assert.equal(prev.state, 'idle_grace');
    assert.equal(prev.outputWritten, true);
    assert.equal(prev.deadline, 603_000);
    assert.equal(judge(prev, { ...observed, status: 'working', workingAt: 4000 }, 4000).state, 'idle_grace');
    assert.equal(judge(quiet, { ...observed, canContinue: false }, 3000).action, 'quit');
  }
});

test('judge: turn trust reaches the no-report decision at 10s, then keeps the full post-decision wait', () => {
  const observed = { ...facts, stateTrust: 'turn', workingAt: 0, status: 'done' };
  const prev = judge(initial, observed, 1000);
  assert.equal(prev.wakeAt, 11_000);
  assert.equal(judge(prev, observed, 10_999).action, null);
  assert.equal(judge(prev, observed, 11_000).action, 'decide');
  assert.equal(judge(prev, { ...observed, decision: { action: 'needs-human' } }, 11_000).state, 'waiting_orchestrator');
  for (const action of ['wait', 'prompt-report']) {
    const waiting = judge(prev, { ...observed, decision: { action } }, 11_000);
    assert.equal(waiting.wakeAt, 611_000);
    assert.equal(judge(waiting, observed, 21_000).wakeAt, 611_000);
    assert.equal(judge(waiting, observed, 610_999).action, null);
    assert.equal(judge(waiting, observed, 611_000).action, 'decide');
  }
  // A failed report-prompt updates turn.json without new working evidence. Its validated decision must stick.
  const failedPrompt = { ...observed, turn: { ...turn, seq: 2, sent_at: new Date(12_000).toISOString() } };
  const handedOff = judge({ ...prev, seq: 2 }, { ...failedPrompt, decision: { action: 'needs-human' } }, 12_001);
  assert.equal(handedOff.state, 'waiting_orchestrator');
  assert.equal(judge(handedOff, failedPrompt, 12_002).state, 'waiting_orchestrator');
});

test('judge: turn trust without working in this turn retains advisory timings', () => {
  const laterTurn = { ...turn, seq: 2, sent_at: new Date(1000).toISOString() };
  for (const workingAt of [undefined, null, 999]) {
    const observed = { ...facts, turn: laterTurn, stateTrust: 'turn', workingAt, status: 'idle' };
    const prev = judge(initial, observed, 1000);
    assert.equal(prev.wakeAt, 601_000);
    assert.equal(judge(prev, observed, 11_000).action, null);
    assert.equal(judge(prev, observed, 601_000).action, 'decide');
    const report = { ...observed, reportSig: 'report' };
    const writing = judge(initial, report, 1000);
    assert.equal(writing.wakeAt, 11_000);
    assert.equal(judge(writing, report, 3000).state, 'working');
    assert.equal(judge(writing, report, 11_000).state, 'idle_grace');
  }
});

test('judge: advisory report during working and status flaps never starts grace early (agy)', () => {
  const observed = { ...facts, stateTrust: 'advisory', workingAt: 0, reportSig: 'report' };
  let prev = judge(initial, observed, 1000);
  assert.equal(prev.quietSince, null);
  prev = judge(prev, { ...observed, status: 'done' }, 60_000);
  assert.equal(prev.wakeAt, 70_000);
  prev = judge(prev, { ...observed, workingAt: 61_000 }, 61_000);
  assert.equal(prev.state, 'working');
  assert.equal(prev.quietSince, null);
  const done = { ...observed, status: 'done', workingAt: 61_000 };
  prev = judge(prev, done, 62_000);
  assert.equal(judge(prev, done, 71_999).state, 'working');
  prev = judge(prev, done, 72_000);
  assert.equal(prev.state, 'idle_grace');
  assert.equal(prev.deadline, 672_000);
  assert.equal(prev.outputWritten, true);
  const noReportFacts = { ...done, reportSig: null };
  const noReportQuiet = judge(initial, noReportFacts, 62_000);
  assert.equal(judge(noReportQuiet, noReportFacts, 72_000).action, null);
  assert.equal(judge(noReportQuiet, noReportFacts, 662_000).action, 'decide');
});

test('judge: an old job without state_trust behaves exactly as advisory', () => {
  const oldJob = { cli: { agent: 'grok', can_continue: true, idle_grace_s: 600 } };
  let legacy = initial, advisory = initial;
  for (const [now, patch] of [[1000, { status: 'done' }], [11_000, { status: 'done' }],
    [601_000, { status: 'done' }], [602_000, { status: 'working', reportSig: 'report', workingAt: 602_000 }],
    [603_000, { status: 'done', reportSig: 'report' }], [605_000, { status: 'done', reportSig: 'report' }],
    [613_000, { status: 'done', reportSig: 'report' }]]) {
    const observed = { ...facts, workingAt: 0, ...patch };
    legacy = judge(legacy, { ...observed, stateTrust: oldJob.cli.state_trust }, now);
    advisory = judge(advisory, { ...observed, stateTrust: 'advisory' }, now);
    assert.deepEqual(legacy, advisory);
  }
});

test('judge: turn trust preserves outage, child, question and working-flap boundaries', () => {
  const observed = { ...facts, stateTrust: 'turn', workingAt: 0, status: 'done', reportSig: 'report' };
  const prev = judge(initial, observed, 1000);
  assert.equal(judge(prev, { ...observed, status: null }, 3000).wakeAt, 63_000);
  assert.equal(judge(prev, { ...observed, status: 'unknown' }, 3000).wakeAt, 11_000);
  assert.equal(judge(prev, { ...observed, status: 'blocked' }, 3000).state, 'waiting_orchestrator');
  assert.equal(judge(prev, { ...observed, openQuestions: true }, 3000).state, 'waiting_orchestrator');
  assert.equal(judge(prev, { ...observed, workingAt: 2999 }, 3000).wakeAt, 5000);
  assert.equal(judge(prev, { ...observed, reportSig: 'rewritten' }, 3000).wakeAt, 5000);
  const held = judge(prev, { ...observed, liveChild: true, canContinue: false }, 3000);
  assert.equal(held.state, 'working');
  assert.equal(held.action, null);
  assert.equal(judge(held, { ...observed, liveChild: true }, 4000).action, null);
  const noReportFacts = { ...observed, reportSig: null, liveChild: true };
  assert.equal(judge(initial, noReportFacts, 11_000).quietSince, null);
  assert.equal(judge(prev, { ...observed, liveChild: null }, 3000).action, 'sample');
});
