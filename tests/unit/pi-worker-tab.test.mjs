// Ported tab-policy, tab-lifecycle, async-ask, clean-exit, tab UI, and piWorkerArgv tests on a fake Pi with fake timers.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { jobChanges, readThinJobRows } from '../../dist/collectors/thin-jobs.js';
import { readContract, writeContract } from '../../dist/harness/pi/worker/contract.js';
import { installWorker } from '../../dist/harness/pi/worker/index.js';
import { ASYNC_ANSWER_TYPE, installTabLifecycle } from '../../dist/harness/pi/worker/tab-lifecycle.js';
import {
  DEFAULT_WARM_CAP_USD,
  IDLE_GRACE_MAX_MS,
  exitDecision,
  idleGraceMs,
  lifecycle,
  promptCacheTtlMs,
  warming,
} from '../../dist/harness/pi/worker/tab-policy.js';
import { installWorkerUi } from '../../dist/harness/pi/worker/tab-ui.js';
import { trackTps } from '../../dist/harness/pi/worker/tps.js';
import { piWorkerArgv } from '../../dist/mcp/dispatch/pi-worker-argv.js';
import { stripAnsi } from '../../dist/render/colors.js';
import { getJobIndexCache } from '../../dist/roles/job-index-cache.js';
import { readSelectionExcerpts, recordSelectionNote } from '../../dist/roles/selection-excerpts.js';
import { nextQuestionNumber, publishQuestion, readQuestionAnswer } from '../../dist/worker/qa.js';
import { waitSonic } from '../../dist/worker/tools.js';
import { createFooterHost, piPackage } from '../fakes/pi.mjs';

const VALID_STATES = new Set([
  'queued', 'working', 'waiting_helper', 'waiting_orchestrator', 'blocked',
  'idle_grace', 'closed', 'done', 'failed', 'stopped',
]);

function assertJobStatusContract(status, expectedDir, expectedRole) {
  assert.equal(status.version, 1);
  assert.equal(status.slot, 'primary');
  assert.equal(status.harness, 'pi');
  assert.equal(status.task_dir, fs.realpathSync(expectedDir));
  assert.equal(status.role, expectedRole);
  assert.equal(typeof status.session_id, 'string');
  assert.ok(status.session_id.length > 0);
  assert.ok(status.session_file === null || typeof status.session_file === 'string');
  assert.equal(status.pid, process.pid);
  const procTail = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const expectedStart = procTail.slice(procTail.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
  assert.equal(status.pid_start_time, expectedStart);
  assert.ok(VALID_STATES.has(status.state), `unexpected state ${status.state}`);
  assert.equal(status.output_path, join(fs.realpathSync(expectedDir), 'report.md'));
  assert.equal(typeof status.output_written, 'boolean');
  assert.equal(typeof status.started_at, 'string');
  assert.equal(typeof status.updated_at, 'string');
  assert.ok(status.settled_at === null || typeof status.settled_at === 'string');
  assert.ok(status.idle_deadline_at === null || typeof status.idle_deadline_at === 'string');
  assert.ok(status.ended_at === null || typeof status.ended_at === 'string');
  assert.ok(status.exit_reason === null || typeof status.exit_reason === 'string');
  assert.ok(status.error === null || typeof status.error === 'string');
}

function makeFakeClock(initial = 1000) {
  let now = initial;
  let serial = 0;
  const timers = new Map();
  const timing = {
    now: () => now,
    schedule(callback, ms) {
      const token = { id: ++serial };
      timers.set(token, { callback, delay: ms, due: now + ms });
      return token;
    },
    cancel(token) {
      timers.delete(token);
    },
  };
  return {
    timing,
    timers,
    now: () => now,
    setNow(value) { now = value; },
    advance(ms) {
      now += ms;
      for (const [token, entry] of [...timers]) {
        if (entry.due <= now) {
          timers.delete(token);
          entry.callback();
        }
      }
    },
    fireNext() {
      assert.ok(timers.size >= 1, 'expected at least one scheduled timer');
      const [token, entry] = [...timers][0];
      timers.delete(token);
      entry.callback();
    },
  };
}

function makeLifecycleFixture(t, {
  role = 'reviewer',
  profile = role === 'imp' ? 'implementer' : role,
  mode = 'tui',
  timing,
  watchQa = false,
  warmCapUsd,
  promptCache = { short: 60, long: 120 },
  agentQueue,
} = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-tab-lifecycle-'));
  const jobsDir = join(root, 'jobs');
  const jobId = 'j1111111111111111';
  const dir = join(jobsDir, jobId);
  fs.mkdirSync(join(dir, 'qa'), { recursive: true });
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({
    job: jobId, role, cwd: root, request_key: 'synthetic', created_at: new Date().toISOString(),
    dispatch_exit_code: 0, stderr_tail: '',
  }));
  fs.writeFileSync(join(dir, 'SESSION.txt'), `TASK=${jobId}\nTAB=w4E:t2\nLEFT=w4E:p2\nPRIMARY=${jobId}-primary\n`);
  const sessionFile = join(root, 'session.jsonl');
  fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 'test-session', cwd: root }) + '\n');
  const out = join(dir, 'report.md');
  const statusFile = join(dir, 'STATUS.json');
  const handlers = new Map();
  const sentMessages = [];
  const sentUsers = [];
  let shutdowns = 0;
  let aborts = 0;
  let idle = true;
  let pending = false;
  let currentSessionFile = sessionFile;
  const ctx = {
    cwd: root,
    mode,
    hasUI: mode === 'tui',
    model: { provider: 'fake', id: 'model', promptCache },
    sessionManager: {
      getSessionId: () => 'test-session',
      getSessionFile: () => currentSessionFile,
    },
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    abort: () => { aborts++; },
    shutdown: () => { shutdowns++; },
    ui: { theme: { fg: (_k, s) => s }, setStatus() {}, notify() {} },
  };
  const pi = {
    on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    sendMessage(message, options) { sentMessages.push({ message, options, idle }); },
    sendUserMessage(...args) { sentUsers.push(args); },
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools() {},
    getThinkingLevel: () => 'high',
    appendEntry() {},
    registerTool() {},
  };
  const controller = installTabLifecycle(pi, {
    taskDir: dir,
    role,
    profile,
    timing,
    watchQa,
    warmCapUsd,
    agentQueue,
    fatal(reason) { throw new Error(reason); },
  });
  const emit = async (name, event = {}) => {
    let result;
    for (const fn of handlers.get(name) ?? []) result = await fn(event, ctx);
    return result;
  };
  let reportSeq = 0;
  t.after(async () => {
    try { await emit('session_shutdown', { reason: 'quit' }); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  return {
    root, dir, out, statusFile, ctx, pi, controller, emit, sentMessages, sentUsers,
    writeReport: (body) => fs.writeFileSync(out, body ?? `Synthetic report ${++reportSeq} ${'x'.repeat(reportSeq)}\n`),
    status: () => JSON.parse(fs.readFileSync(statusFile, 'utf8')),
    shutdowns: () => shutdowns,
    aborts: () => aborts,
    setIdle: (v) => { idle = v; },
    setPending: (v) => { pending = v; },
    setSessionFile: (v) => { currentSessionFile = v; },
  };
}

// ─── 1. Ported dispatch-policy (tab-policy) tests ────────────────────────────

test('tab-policy: lifecycle classification, warming precedence, $0.50 cap boundaries, exit guards and TTL adapter', () => {
  assert.equal(DEFAULT_WARM_CAP_USD, 0.50);
  assert.equal(IDLE_GRACE_MAX_MS, 20 * 60 * 1000);
  for (const p of ['implementer', 'general']) assert.equal(lifecycle(p), 'implementer');
  for (const p of ['reviewer', 'architect', 'sonic']) assert.equal(lifecycle(p), 'one_shot');
  for (const p of [undefined, '', 'custom-implementer', 'informer']) assert.equal(lifecycle(p), undefined);

  const warm = { cap: 0.50, admitted: 0, warmCost: 0.10, action: 'warm', closing: false, settled: false };
  assert.equal(warming({ ...warm, closing: true }).action, 'stop');
  assert.equal(warming({ ...warm, cap: 0 }).action, 'stop');
  assert.equal(warming({ ...warm, settled: true }).action, 'stop', 'idle grace never warms beyond settlement');
  assert.equal(warming({ ...warm, action: 'stop' }).action, 'stop');
  assert.equal(warming(warm).action, 'warm');

  assert.deepEqual(warming({ ...warm, warmCost: 0.50 }), { action: 'warm', admitted: 0.50 });
  assert.equal(warming({ ...warm, admitted: 0.50, warmCost: 0 }).action, 'stop');
  assert.equal(warming({ ...warm, admitted: 0.49, warmCost: 0.02 }).action, 'stop');
  assert.equal(warming({ ...warm, warmCost: 0 }).admitted, 0);
  for (const value of [NaN, Infinity, -1]) {
    for (const field of ['cap', 'admitted', 'warmCost']) {
      assert.equal(warming({ ...warm, [field]: value }).action, 'stop');
    }
  }
  const first = warming({ ...warm, warmCost: 0.30 });
  assert.equal(warming({ ...warm, admitted: first.admitted, warmCost: 0.30 }).action, 'stop', 'no refund');

  const exit = {
    lifecycle: 'one_shot', settled: true, outputWritten: true, failed: false, idle: true,
    pendingMessages: false, pendingQuestions: 0, generation: 1, expectedGeneration: 1, now: 100,
  };
  assert.equal(exitDecision(exit), 'closed');
  assert.equal(exitDecision({ ...exit, outputWritten: false }), 'failed');
  assert.equal(exitDecision({ ...exit, failed: true }), 'failed');
  assert.equal(exitDecision({ ...exit, lifecycle: 'implementer', deadline: 101 }), 'wait');
  assert.equal(exitDecision({ ...exit, lifecycle: 'implementer', deadline: 100 }), 'closed');
  for (const patch of [
    { settled: false }, { idle: false }, { pendingMessages: true }, { pendingQuestions: 2 }, { generation: 2 },
  ]) {
    assert.equal(exitDecision({ ...exit, ...patch }), 'wait');
  }

  const model = { promptCache: { short: 1800, long: 3600 } };
  assert.equal(promptCacheTtlMs(model), 1_800_000);
  assert.equal(promptCacheTtlMs(model, 'long'), 3_600_000);
  assert.equal(promptCacheTtlMs(), 0);
  assert.equal(promptCacheTtlMs({ promptCache: { short: NaN } }), 0);
  assert.equal(promptCacheTtlMs({ promptCache: { short: 1800 } }, 'long'), 0);
  assert.equal(idleGraceMs(model), 1_200_000);
  assert.equal(idleGraceMs(model, 'long'), 1_200_000, '2/3 of 60m is capped at 20m');
  assert.equal(idleGraceMs({ promptCache: { short: 300 } }), 200_000);
});

// ─── 2. Ported dispatch (tab-lifecycle) tests with fake timers + JobStatus ───

test('tab-lifecycle: session link (lazy, idempotent, no self-link, preserves history, ignores link failure)', async (t) => {
  const f = makeLifecycleFixture(t, { role: 'reviewer', profile: 'reviewer' });
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-session-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const session = join(home, 'synthetic.jsonl');
  fs.writeFileSync(session, 'synthetic history\n');
  f.setSessionFile(undefined);
  await f.emit('session_start');
  assertJobStatusContract(f.status(), f.dir, 'reviewer');
  assert.equal(fs.statSync(f.statusFile).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(join(f.dir, 'sessions')), false);

  f.setSessionFile(session);
  await f.emit('before_agent_start');
  const link = join(f.dir, 'sessions', 'synthetic.jsonl');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link), session);
  await f.emit('thinking_level_select');
  assert.equal(f.status().session_file, session);

  // Deleting the job directory never deletes the linked session file.
  await f.emit('session_shutdown', { reason: 'quit' });
  fs.rmSync(f.dir, { recursive: true, force: true });
  assert.equal(fs.readFileSync(session, 'utf8'), 'synthetic history\n');

  // Session already under <job>/sessions is never linked to itself.
  const selfFix = makeLifecycleFixture(t, { role: 'reviewer', profile: 'reviewer' });
  fs.mkdirSync(join(selfFix.dir, 'sessions'));
  const inPlace = join(selfFix.dir, 'sessions', 'in-place.jsonl');
  selfFix.setSessionFile(inPlace);
  await selfFix.emit('session_start');
  await selfFix.emit('before_agent_start');
  assert.equal(fs.existsSync(inPlace), false, 'no self-referential link');

  // Link failure over an existing regular file logs once and does not fail settlement.
  const clash = makeLifecycleFixture(t, { role: 'reviewer', profile: 'reviewer' });
  fs.mkdirSync(join(clash.dir, 'sessions'));
  const regular = join(clash.dir, 'sessions', 'session.jsonl');
  fs.writeFileSync(regular, 'legacy history');
  const messages = [];
  const origErr = console.error;
  console.error = (...args) => messages.push(args.join(' '));
  try {
    await clash.emit('session_start');
    await clash.emit('before_agent_start');
    clash.writeReport();
    await clash.emit('agent_settled');
    await immediate();
  } finally {
    console.error = origErr;
  }
  assert.equal(clash.status().state, 'closed');
  assert.equal(clash.status().error, null);
  assert.equal(fs.readFileSync(regular, 'utf8'), 'legacy history');
  assert.equal(fs.lstatSync(regular).isFile(), true);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /session link failed \(ignored\)/);
});

async function selectionNoteFixture(t, agentQueue) {
  const clock = makeFakeClock();
  const f = makeLifecycleFixture(t, { role: 'imp', timing: clock.timing, agentQueue });
  const target = 'j1111111111111111', launchId = 'launch-test-a', endpoint = join(f.root, 'herdr.sock');
  const userPrompt = { messageType: 'user' };
  await f.emit('session_start');
  fs.appendFileSync(join(f.dir, 'SESSION.txt'), `DIRECT_EXEC=1\nLAUNCH_ID=${launchId}\nHERDR_SOCKET_PATH=${endpoint}\nPID=${process.pid}\nPID_START=${f.status().pid_start_time}\n`);
  assert.equal(await f.emit('before_agent_start', userPrompt), undefined);

  const owner = { project: 'project', projectRoot: f.root, pane: 'w4E:p9', job: null, role: null, time: '2026-11-26T12:00:00.000Z' };
  const excerpt = 'Original log: check failed';
  const note = 'Check the expected output';
  const record = await recordSelectionNote(f.root, { target, launchId, role: 'imp', source: owner, excerpt, note }, endpoint);
  const current = () => readSelectionExcerpts(f.root, getJobIndexCache(f.root), { job: target })[0];
  assert.equal(current().id, record.id);
  return { f, current, userPrompt };
}

const selectionNoteText = /\[HUD selection note\][\s\S]*pane=w4E:p9[\s\S]*Original log: check failed[\s\S]*Note: Check the expected output/;

test('a mid-turn selection note is delivered once when pi drains a queued user follow-up', async (t) => {
  const followUps = [];
  const agentQueue = { followUp(message) { followUps.push(message); } };
  const { f, current } = await selectionNoteFixture(t, agentQueue);
  const text = { type: 'text', text: 'Synthetic follow-up question?' };
  const image = { type: 'image', data: 'synthetic', mimeType: 'image/png' };
  const followUp = { role: 'user', content: [text, image] };
  const secondFollowUp = { role: 'user', content: [text] };
  const customWake = { role: 'custom', customType: 'synthetic-wake', content: 'Wake' };
  agentQueue.followUp(customWake);
  agentQueue.followUp(followUp);
  agentQueue.followUp(secondFollowUp);
  assert.deepEqual(followUp.content, [text, image], 'enqueue does not alter the prompt');
  assert.equal(current().delivery, 'pending');

  // A steer with the same text is not the queued follow-up, even while it is pending.
  const steer = { role: 'user', content: [text] };
  await f.emit('message_start', { message: steer });
  await f.emit('message_end', { message: steer });
  assert.deepEqual(steer.content, [text]);
  await f.emit('turn_end');
  await f.emit('turn_start');
  const wake = followUps.shift();
  await f.emit('message_start', { message: wake });
  await f.emit('message_end', { message: wake });
  assert.equal(current().delivery, 'pending', 'a queued custom wake does not take the note');

  await f.emit('turn_end');
  await f.emit('turn_start'); // Pi does not emit before_agent_start on the queue drain.
  const drained = followUps.shift();
  await f.emit('message_start', { message: drained });
  assert.deepEqual(drained.content.slice(0, 2), [text, image]);
  assert.equal(drained.content.length, 3);
  assert.match(drained.content[2].text, selectionNoteText);
  assert.equal(current().delivery, 'pending', 'wait for pi to finish the augmented message');
  await f.emit('message_end', { message: drained });
  assert.equal(current().delivery, 'delivered');

  const next = followUps.shift();
  await f.emit('message_start', { message: next });
  await f.emit('message_end', { message: next });
  assert.deepEqual(next.content, [text], 'the next follow-up does not repeat the note');
  assert.deepEqual(f.sentMessages, []);
  assert.deepEqual(f.sentUsers, []);
});

test('a steer, tool step and custom wake leave a selection note pending for a fresh user prompt', async (t) => {
  const { f, current, userPrompt } = await selectionNoteFixture(t);
  const steer = { role: 'user', content: [{ type: 'text', text: 'Synthetic steer' }] };
  await f.emit('message_start', { message: steer });
  await f.emit('message_end', { message: steer });
  const toolResult = { role: 'toolResult' };
  await f.emit('message_start', { message: toolResult });
  await f.emit('message_end', { message: toolResult });
  await f.emit('turn_end');
  await f.emit('turn_start');
  assert.deepEqual(f.sentMessages, []);
  assert.deepEqual(f.sentUsers, []);
  assert.equal(current().delivery, 'pending');

  assert.equal(await f.emit('before_agent_start', { messageType: 'custom' }), undefined);
  f.writeReport();
  await f.emit('agent_settled');
  assert.equal(f.status().state, 'idle_grace');
  assert.equal(current().delivery, 'pending');

  const { message } = await f.emit('before_agent_start', userPrompt);
  assert.match(message.content, selectionNoteText);
  assert.equal(current().delivery, 'pending', 'a prepared prompt does not yet acknowledge the note');
  await f.emit('message_end', { message: { role: 'custom', ...message } });
  assert.equal(current().delivery, 'delivered');
  assert.equal(await f.emit('before_agent_start', userPrompt), undefined);
  assert.equal(current().delivery, 'delivered');
});

test('tab-lifecycle: one-shot closes cleanly after settled and defers/rechecks queued-message guard', async (t) => {
  const f = makeLifecycleFixture(t, { role: 'reviewer', profile: 'reviewer' });
  await f.emit('session_start');
  await f.emit('before_agent_start');
  f.writeReport();
  await f.emit('agent_end');
  await immediate();
  assert.equal(f.shutdowns(), 0);
  await f.emit('agent_settled');
  f.setPending(true);
  await immediate();
  assert.equal(f.shutdowns(), 0);
  f.setPending(false);
  await f.emit('agent_settled');
  await immediate();
  assert.equal(f.shutdowns(), 1);
  const s = f.status();
  assertJobStatusContract(s, f.dir, 'reviewer');
  assert.equal(s.state, 'closed');
  assert.equal(s.output_written, true);
  assert.equal(s.idle_deadline_at, null, 'one-shots never advertise idle grace');
});

function makeSonicChild(f) {
  const jobs = join(f.root, 'jobs'), id = 'j0000000000000001', child = join(jobs, id);
  const parent = JSON.parse(fs.readFileSync(join(f.dir, 'job.json'), 'utf8'));
  fs.mkdirSync(child);
  fs.mkdirSync(join(f.dir, '.sonic'));
  fs.writeFileSync(join(f.dir, '.sonic', id), '');
  fs.writeFileSync(join(child, 'job.json'), JSON.stringify({ job: id, role: 'sonic', parent_job: parent.job }));
  fs.writeFileSync(join(child, 'STATUS.json'), JSON.stringify({ state: 'working' }));
  return {
    jobs, id, child, parent,
    complete() {
      fs.writeFileSync(join(child, 'report.md'), 'Synthetic Sonic report.\n');
      fs.writeFileSync(join(child, 'STATUS.json'), JSON.stringify({ state: 'closed' }));
    },
  };
}

for (const queued of [false, true]) {
  test(`a Sonic reminder leaves the note for the next ${queued ? 'queued user follow-up' : 'fresh user prompt'}`, async (t) => {
    const followUps = [];
    const agentQueue = { followUp(message) { followUps.push(message); } };
    const { f, current, userPrompt } = await selectionNoteFixture(t, agentQueue);
    makeSonicChild(f).complete();
    f.setIdle(!queued);
    await f.emit('agent_settled');
    assert.equal(f.sentMessages.length + f.sentUsers.length, 1);
    // Model the role pi assigns to each sending API, including the old user-message path.
    const reminder = f.sentMessages.length
      ? { role: 'custom', ...f.sentMessages[0].message }
      : { role: 'user', content: f.sentUsers[0][0] };
    const text = { type: 'text', text: reminder.content };
    const drain = async (input) => {
      await f.emit('message_start', { message: input });
      await f.emit('message_end', { message: input });
    };

    if (queued) {
      agentQueue.followUp(reminder);
      await drain(followUps.shift());
    } else {
      const staged = await f.emit('before_agent_start', reminder.role === 'custom'
        ? { messageType: 'custom', message: reminder }
        : { ...userPrompt, prompt: text.text });
      await drain(reminder);
      if (staged) await drain({ role: 'custom', ...staged.message });
    }
    assert.equal(current().delivery, 'pending', 'the automatic wake must not acknowledge the note');
    assert.equal(reminder.content, text.text);

    // The owner can submit the same text: provenance, not content, distinguishes this prompt.
    if (queued) {
      const followUp = { role: 'user', content: [text] };
      agentQueue.followUp(followUp);
      await drain(followUps.shift());
      assert.equal(followUp.content.length, 2);
      assert.deepEqual(followUp.content[0], text);
      assert.match(followUp.content[1].text, selectionNoteText);
      assert.equal(current().delivery, 'delivered');
      const next = { role: 'user', content: [text] };
      agentQueue.followUp(next);
      await drain(followUps.shift());
      assert.deepEqual(next.content, [text]);
    } else {
      const { message: note } = await f.emit('before_agent_start', { ...userPrompt, prompt: text.text });
      assert.match(note.content, selectionNoteText);
      await drain({ role: 'custom', ...note });
      assert.equal(current().delivery, 'delivered');
      assert.equal(await f.emit('before_agent_start', userPrompt), undefined);
    }
  });
}

test('tab-lifecycle: one Sonic reminder does not settle; collection and a fresh report do', async (t) => {
  const clock = makeFakeClock(1000);
  const f = makeLifecycleFixture(t, { timing: clock.timing });
  const { jobs, id, child, parent, complete } = makeSonicChild(f);
  await f.emit('session_start');
  await f.emit('before_agent_start');
  f.writeReport();
  await f.emit('agent_settled');
  await immediate();
  assert.equal(f.status().state, 'working');
  assert.equal(f.status().settled_at, null);
  assert.equal(f.status().idle_deadline_at, null);
  assert.equal(f.shutdowns(), 0);
  assert.deepEqual(f.sentUsers, []);

  clock.fireNext();
  assert.equal(f.shutdowns(), 0);
  complete();
  clock.fireNext();
  assert.equal(f.sentMessages.length, 1);
  const { message, options } = f.sentMessages[0];
  assert.match(message.content, new RegExp(id));
  assert.equal(message.display, true);
  assert.deepEqual(options, { triggerTurn: true, deliverAs: 'followUp' });
  assert.equal(fs.existsSync(join(child, 'sonic-prompted')), true);
  assert.equal(f.status().state, 'working');
  assert.equal(f.shutdowns(), 0);

  await f.emit('before_agent_start', { messageType: 'custom', message: { role: 'custom', ...message } });
  f.writeReport('Another report, before collection.\n');
  await f.emit('agent_settled');
  await immediate();
  assert.equal(f.status().state, 'working');
  assert.equal(f.status().settled_at, null);
  assert.equal(f.shutdowns(), 0);
  assert.equal(f.sentMessages.length, 1);

  const result = await waitSonic({ dir: f.dir, root: jobs, job: parent }, [id], 0);
  assert.equal(result.reports[0].id, id);
  assert.equal(fs.existsSync(join(child, 'sonic-collected')), true);
  assert.equal(f.shutdowns(), 0, 'collection alone does not settle the earlier report');
  await f.emit('before_agent_start');
  f.writeReport('Final report after Sonic collection.\n');
  await f.emit('agent_settled');
  await immediate();
  assert.equal(f.status().state, 'closed');
  assert.equal(f.shutdowns(), 1);
  assert.equal(f.sentMessages.length, 1);
});

test('tab-lifecycle: hud-sonic-ready follow-up keeps the turn report baseline; an empty new turn still fails', async (t) => {
  const clock = makeFakeClock(1000);
  const f = makeLifecycleFixture(t, { role: 'imp', profile: 'implementer', timing: clock.timing });
  const jobs = join(f.root, 'jobs'), id = 'j0000000000000002', child = join(jobs, id);
  const parent = JSON.parse(fs.readFileSync(join(f.dir, 'job.json'), 'utf8'));
  // Simulate a resumed Pi session that already has the earlier turn's report on disk.
  f.writeReport('Previous turn report.\n');
  fs.mkdirSync(child);
  fs.mkdirSync(join(f.dir, '.sonic'));
  fs.writeFileSync(join(f.dir, '.sonic', id), '');
  fs.writeFileSync(join(child, 'job.json'), JSON.stringify({ job: id, role: 'sonic', parent_job: parent.job }));
  fs.writeFileSync(join(child, 'STATUS.json'), JSON.stringify({ state: 'working' }));

  await f.emit('session_start');
  await f.emit('before_agent_start');
  f.writeReport('Repair turn report.\n');
  await f.emit('agent_settled');
  await immediate();
  assert.equal(f.status().state, 'working');
  assert.equal(f.status().settled_at, null);
  assert.equal(f.controller.isSettled(), false);

  // Sonic finishes and hud-sonic-ready starts a continuation run before the 2s retry timer.
  fs.writeFileSync(join(child, 'report.md'), 'Synthetic Sonic confirmation.\n');
  fs.writeFileSync(join(child, 'STATUS.json'), JSON.stringify({ state: 'closed' }));
  await f.emit('before_agent_start');
  const collected = await waitSonic({ dir: f.dir, root: jobs, job: parent }, [id], 0);
  assert.equal(collected.reports[0].id, id);
  await f.emit('agent_settled');
  await immediate();
  assert.equal(f.status().state, 'idle_grace');
  assert.equal(f.status().output_written, true);
  assert.equal(f.status().error, null);
  assert.equal(f.controller.isSettled(), true);

  // A subsequent turn from idle_grace with no fresh report still fails.
  await f.emit('before_agent_start');
  assert.equal(f.controller.isSettled(), false);
  await f.emit('agent_settled');
  await immediate();
  assert.equal(f.status().state, 'failed');
  assert.equal(f.status().output_written, false);
  assert.equal(f.status().exit_reason, 'output missing, empty or unchanged');
  assert.equal(f.controller.isSettled(), true);
});

test('tab-lifecycle: stale/missing/empty outputs and aborted/provider-error settlements fail and retain tab (no exit 0)', async (t) => {
  for (const kind of ['stale', 'missing', 'empty', 'aborted', 'provider-error']) {
    const f = makeLifecycleFixture(t, { role: 'reviewer', profile: 'reviewer' });
    if (kind === 'stale') f.writeReport();
    await f.emit('session_start');
    await f.emit('before_agent_start');
    if (kind === 'empty') fs.writeFileSync(f.out, '');
    if (kind === 'aborted' || kind === 'provider-error') f.writeReport();
    if (kind === 'provider-error') {
      await f.emit('message_end', {
        message: { role: 'assistant', stopReason: 'error', errorMessage: 'HTTP 429: quota exceeded' },
      });
    }
    await f.emit('agent_settled', { aborted: kind === 'aborted' });
    await immediate();
    const s = f.status();
    assertJobStatusContract(s, f.dir, 'reviewer');
    assert.equal(s.state, 'failed', kind);
    // Do NOT call ctx.shutdown() (which exits 0) on failures so herdr close_on_zero retains the tab for 2h.
    assert.equal(f.shutdowns(), 0, `${kind} must retain tab instead of exiting 0`);
    if (kind === 'provider-error') assert.match(s.error, /HTTP 429/);
    // Manual quit later preserves failed state and error.
    await f.emit('session_shutdown', { reason: 'quit' });
    assert.equal(f.status().state, 'failed', kind);
  }
});

test('tab-lifecycle: pending nested sync hud_ask IDs block exit until every tool_execution_end', async (t) => {
  const f = makeLifecycleFixture(t, { role: 'reviewer', profile: 'reviewer' });
  await f.emit('session_start');
  await f.emit('before_agent_start');
  f.writeReport();
  for (const toolCallId of ['qa', 'outer/1']) {
    await f.emit('tool_execution_start', { toolName: 'hud_ask', toolCallId });
  }
  assert.equal(f.status().state, 'waiting_orchestrator');
  await f.emit('agent_settled');
  await immediate();
  assert.equal(f.shutdowns(), 0);
  await f.emit('tool_execution_end', { toolCallId: 'qa', isError: true });
  await immediate();
  assert.equal(f.shutdowns(), 0);
  await f.emit('tool_execution_end', { toolCallId: 'outer/1', isError: true });
  await immediate();
  assert.equal(f.shutdowns(), 1);
  assert.equal(f.status().state, 'closed');
});

test('tab-lifecycle: implementer idle grace (2/3 TTL, fixed deadline, early timer re-arm, follow-up cancels timer, model_select clamps)', async (t) => {
  const clock = makeFakeClock(1000);
  const f = makeLifecycleFixture(t, {
    role: 'imp', profile: 'implementer', timing: clock.timing,
    promptCache: { short: 600, long: 3600 },
  });
  await f.emit('session_start');
  await f.emit('before_agent_start');
  f.writeReport();
  await f.emit('agent_settled');
  await immediate();
  const s = f.status();
  assertJobStatusContract(s, f.dir, 'imp');
  assert.equal(s.state, 'idle_grace');
  assert.equal(clock.timers.size, 1);
  // 2/3 of 600s = 400s = 400_000ms
  assert.equal([...clock.timers.values()][0].delay, 400_000);
  const originalDeadline = s.idle_deadline_at;

  // Warming stops during idle grace and never moves the deadline.
  assert.deepEqual(await f.emit('cache_warming_decision', { warmCost: 0.1, action: 'warm' }), { action: 'stop' });
  assert.equal(f.status().warm.admitted_count, 0);
  assert.equal(f.status().idle_deadline_at, originalDeadline);

  // Early timer delivery re-arms the exact same fixed deadline without renewing grace.
  clock.setNow(400_999.75);
  clock.fireNext();
  assert.equal(f.shutdowns(), 0);
  assert.equal(clock.timers.size, 1);
  assert.equal([...clock.timers.values()][0].delay, 1);
  assert.equal(f.status().idle_deadline_at, originalDeadline);

  // Follow-up prompt during idle grace cancels the old timer and stale callbacks cannot fire.
  const staleCallback = [...clock.timers.values()][0].callback;
  await f.emit('before_agent_start');
  assert.equal(clock.timers.size, 0);
  assert.equal(f.status().state, 'working');
  assert.equal(f.status().idle_deadline_at, null);
  staleCallback();
  assert.equal(clock.timers.size, 0);
  assert.equal(f.shutdowns(), 0);

  // Second settlement + model_select with shorter cache clamps the remaining deadline.
  clock.setNow(500_000);
  f.writeReport();
  await f.emit('agent_settled');
  await immediate();
  assert.equal(f.status().state, 'idle_grace');
  assert.equal([...clock.timers.values()][0].delay, 400_000);
  await f.emit('model_select', { model: { provider: 'fake', id: 'shorter', promptCache: { short: 60 } } });
  assert.equal([...clock.timers.values()][0].delay, 40_000);

  clock.advance(40_000);
  assert.equal(f.shutdowns(), 1);
  assert.equal(clock.timers.size, 0);
  assert.equal(f.status().state, 'closed');
});

test('tab-lifecycle: external shutdown during idle grace closes cleanly; working shutdown fails; stop publishes stopped', async (t) => {
  for (const reason of ['quit', 'signal']) {
    const clock = makeFakeClock(0);
    const f = makeLifecycleFixture(t, { role: 'imp', profile: 'implementer', timing: clock.timing });
    await f.emit('session_start');
    await f.emit('before_agent_start');
    f.writeReport();
    await f.emit('agent_settled');
    await immediate();
    assert.equal(f.status().state, 'idle_grace');
    assert.equal(clock.timers.size, 1);
    await f.emit('session_shutdown', { reason });
    const s = f.status();
    assert.equal(s.state, 'closed');
    assert.equal(s.output_written, true);
    assert.equal(s.exit_reason, 'shutdown during idle grace');
    assert.equal(s.error, null);
    assert.ok(s.ended_at);
    assert.equal(clock.timers.size, 0);
    assert.equal(f.shutdowns(), 0);
  }

  // Shutdown while working fails even with an output file or after a follow-up cancels idle grace.
  for (const previousSettle of [false, true]) {
    const clock = makeFakeClock(0);
    const f = makeLifecycleFixture(t, { role: 'imp', profile: 'implementer', timing: clock.timing });
    await f.emit('session_start');
    await f.emit('before_agent_start');
    f.writeReport();
    if (previousSettle) {
      await f.emit('agent_settled');
      await immediate();
      assert.equal(f.status().state, 'idle_grace');
      await f.emit('before_agent_start');
    }
    await f.emit('session_shutdown', { reason: 'quit' });
    assert.equal(f.status().state, 'failed');
    assert.equal(f.status().output_written, false);
    assert.equal(f.status().exit_reason, 'external shutdown: quit');
  }

  // Deliberate stop (STATUS.json.stop-requested) publishes stopped and shuts down cleanly on aborted settlement.
  for (const mode of ['shutdown', 'aborted']) {
    const clock = makeFakeClock(0);
    const f = makeLifecycleFixture(t, { role: 'imp', profile: 'implementer', timing: clock.timing });
    await f.emit('session_start');
    await f.emit('before_agent_start');
    fs.writeFileSync(`${f.statusFile}.stop-requested`, '');
    if (mode === 'aborted') {
      await f.emit('message_end', { message: { role: 'assistant', stopReason: 'aborted' } });
      await f.emit('agent_settled', { aborted: true });
      await immediate();
      assert.equal(f.shutdowns(), 1, 'deliberate stop closes Pi cleanly');
    }
    await f.emit('session_shutdown', { reason: 'signal' });
    const s = f.status();
    assertJobStatusContract(s, f.dir, 'imp');
    assert.equal(s.state, 'stopped');
    assert.equal(s.error, null);
    assert.equal(s.exit_reason, 'stop requested');
    assert.ok(s.ended_at);
  }
});

test('tab-lifecycle: unknown TTL closes at settlement, $0.50 warm cap admissions, cap 0, session_tree/reload disable', async (t) => {
  const f = makeLifecycleFixture(t, { role: 'imp', profile: 'implementer' });
  f.ctx.model.promptCache = undefined;
  await f.emit('session_start');
  await f.emit('before_agent_start');
  assert.deepEqual(await f.emit('cache_warming_decision', { warmCost: 0.50, action: 'warm' }), { action: 'warm' });
  assert.equal(f.status().warm.admitted_usd, 0.50);
  assert.equal(f.status().warm.admitted_count, 1);
  assert.deepEqual(await f.emit('cache_warming_decision', { warmCost: 0, action: 'warm' }), { action: 'stop' });
  f.writeReport();
  await f.emit('agent_settled');
  await immediate();
  assert.equal(f.shutdowns(), 1);
  assert.equal(f.status().state, 'closed');

  const zero = makeLifecycleFixture(t, { role: 'imp', profile: 'implementer', warmCapUsd: 0 });
  await zero.emit('session_start');
  assert.deepEqual(await zero.emit('cache_warming_decision', { warmCost: 0, action: 'warm' }), { action: 'stop' });

  const treed = makeLifecycleFixture(t, { role: 'imp', profile: 'implementer' });
  await treed.emit('session_start');
  await treed.emit('session_tree');
  assert.equal(treed.status().state, 'failed');

  const reload = makeLifecycleFixture(t, { role: 'imp', profile: 'implementer' });
  await reload.emit('session_start', { reason: 'reload' });
  await reload.emit('agent_settled');
  await immediate();
  assert.equal(reload.shutdowns(), 0);
  assert.equal(fs.existsSync(reload.statusFile), false);
});

// ─── 3. Ported QA + async/sync ask tests (fs-watch wake & fake timers) ──────

test('src/worker/qa.ts: question numbering, wx reservation, and answer mtime rules', (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-qa-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(nextQuestionNumber(['q1.md', 'q3.answer.md'], 0), 4);
  assert.equal(nextQuestionNumber(['q1.md'], 5), 6);
  const qa = join(dir, 'qa');
  fs.mkdirSync(qa);
  fs.writeFileSync(join(qa, 'q2.answer.md'), 'stale');
  const q1 = publishQuestion(qa, { tag: 'imp@proj', question: 'First?', default: 'A' });
  assert.equal(q1.n, 3);
  assert.equal(fs.statSync(q1.qfile).mode & 0o777, 0o600);
  assert.equal(readQuestionAnswer(q1), undefined);
  fs.writeFileSync(q1.afile, '   ');
  assert.equal(readQuestionAnswer(q1), undefined);
  fs.writeFileSync(q1.afile, 'Option B\n');
  assert.equal(readQuestionAnswer(q1), 'Option B');
  assert.equal(readQuestionAnswer(q1, q1.questionMtimeMs - 10_000), undefined);
});

async function makeFullTabWorkerFixture(t, {
  role = 'reviewer',
  profile = 'reviewer',
  mode = 'tui',
  askTimeout = '10',
} = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-tab-worker-'));
  const home = join(root, 'hud_home');
  const jobId = 'j2222222222222222';
  const dir = join(home, 'jobs', jobId);
  fs.mkdirSync(join(dir, 'qa'), { recursive: true });
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({
    job: jobId, role, cwd: root, request_key: 'synthetic', created_at: new Date().toISOString(),
    dispatch_exit_code: 0, stderr_tail: '',
  }));
  fs.writeFileSync(join(dir, 'SESSION.txt'), `TASK=${jobId}\nTAB=w4E:t2\nLEFT=w4E:p2\nPRIMARY=${jobId}-primary\n`);
  writeContract(dir, {
    version: 1, job: jobId, role, instructions: role === 'imp' ? 'implementer' : role,
    guard: role === 'reviewer' ? 'strict' : undefined, explicitTools: false, tps: true,
    tab: { profile },
  });
  const prevJobDir = process.env.HUD_JOB_DIR;
  const prevHome = process.env.HUD_HOME;
  const prevAskTimeout = process.env.HUD_ASK_TIMEOUT;
  process.env.HUD_JOB_DIR = dir;
  process.env.HUD_HOME = home;
  process.env.HUD_ASK_TIMEOUT = askTimeout;
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const messages = [];
  const entries = [];
  let active = [];
  let idle = false;
  let shutdowns = 0;
  let aborts = 0;
  const ctx = {
    cwd: root,
    mode,
    hasUI: mode === 'tui',
    model: { provider: 'fake', id: 'model', promptCache: { short: 60 } },
    sessionManager: { getSessionId: () => 'synthetic-tab-worker', getSessionFile: () => undefined },
    isIdle: () => idle,
    hasPendingMessages: () => false,
    abort: () => { aborts++; },
    shutdown: () => { shutdowns++; },
    ui: { theme: { fg: (_k, s) => s }, setStatus() {}, notify() {} },
  };
  const pi = {
    on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, cmd) { commands.set(name, cmd); },
    sendMessage(message, options) { messages.push({ message, options, idle }); },
    sendUserMessage() { assert.fail('must not send user message during ask'); },
    getAllTools: () => [...tools.keys(), 'read', 'bash', 'edit', 'write'].map(name => ({ name })),
    getActiveTools: () => active,
    setActiveTools: (names) => { active = names; },
    getThinkingLevel: () => 'high',
    appendEntry: (...args) => entries.push(args),
  };
  await installWorker(pi);
  const emit = async (name, event = {}) => {
    for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
  };
  await emit('session_start', { reason: 'startup' });
  await emit('before_agent_start', { systemPromptOptions: { sections: {}, skills: [] } });
  const statusFile = join(dir, 'STATUS.json');
  const qa = join(dir, 'qa');
  const report = join(dir, 'report.md');
  t.after(async () => {
    try { await emit('session_shutdown', { reason: 'quit' }); }
    finally {
      if (prevJobDir === undefined) delete process.env.HUD_JOB_DIR; else process.env.HUD_JOB_DIR = prevJobDir;
      if (prevHome === undefined) delete process.env.HUD_HOME; else process.env.HUD_HOME = prevHome;
      if (prevAskTimeout === undefined) delete process.env.HUD_ASK_TIMEOUT; else process.env.HUD_ASK_TIMEOUT = prevAskTimeout;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  return {
    root, home, dir, qa, report, statusFile, tools, commands, messages, entries, ctx, emit,
    setIdle: (v) => { idle = v; },
    shutdowns: () => shutdowns,
    aborts: () => aborts,
    status: () => JSON.parse(fs.readFileSync(statusFile, 'utf8')),
    stop: () => fs.writeFileSync(`${statusFile}.stop-requested`, ''),
    answer: (id, text) => fs.writeFileSync(join(qa, `${id}.answer.md`), text, { flag: 'wx' }),
    ack: (index) => emit('message_start', { message: { role: 'custom', ...messages[index].message } }),
    async ask(askMode = 'async', id = 'call-1') {
      const event = { toolName: 'hud_ask', toolCallId: id };
      await emit('tool_execution_start', event);
      try {
        return await tools.get('hud_ask').execute(id, {
          question: 'Choose a synthetic option?',
          default: 'Option A',
          ...(askMode !== undefined ? { mode: askMode } : {}),
        }, undefined, undefined, ctx);
      } finally {
        await emit('tool_execution_end', event);
      }
    },
  };
}

async function waitFor(predicate, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('timed out waiting for predicate');
}

test('async hud_ask wakes via fs.watch (< 200 ms), steers once, and settles cleanly after fresh report', async (t) => {
  const f = await makeFullTabWorkerFixture(t);
  // R3: no legacy slash commands registered.
  assert.deepEqual([...f.commands.keys()], []);
  const askTool = f.tools.get('hud_ask');
  assert.match(askTool.promptGuidelines.join(' '), /mode="async".*unrelated work/);
  const result = await f.ask('async');
  assert.deepEqual([result.details.requestId, result.details.pending], ['q1', true]);
  assert.equal(result.terminate, undefined, 'tab async ask never terminates the turn');
  assert.match(fs.readFileSync(join(f.qa, 'q1.md'), 'utf8'), /Choose a synthetic option/);
  assert.equal(f.status().state, 'waiting_orchestrator');
  assert.deepEqual(f.messages, []);

  const answeredAt = performance.now();
  f.answer('q1', 'Option B');
  await waitFor(() => f.messages.length > 0, 1000);
  const wakeMs = performance.now() - answeredAt;
  assert.ok(wakeMs < 200, `fs-watch wake expected < 200 ms, got ${wakeMs.toFixed(1)} ms`);
  assert.equal(f.messages[0].idle, false);
  assert.deepEqual(f.messages[0].options, { triggerTurn: true, deliverAs: 'steer' });
  assert.match(f.messages[0].message.content, /ANSWER.*q1.*\n\nOption B/);
  assert.equal(f.messages[0].message.customType, ASYNC_ANSWER_TYPE);
  assert.equal(f.status().state, 'waiting_orchestrator', 'queued is not yet consumed');

  await delay(60);
  assert.equal(f.messages.length, 1, 'answer file left on disk must not queue twice');
  await f.ack(0);
  assert.equal(f.status().state, 'working');

  // Fresh report via hud_report -> settles and shuts down cleanly.
  await f.tools.get('hud_report').execute('rep', { text: 'Fresh report after the decision.' }, undefined, undefined, f.ctx);
  f.setIdle(true);
  await f.emit('agent_settled');
  await immediate();
  assert.equal(f.status().state, 'closed');
  assert.equal(f.shutdowns(), 1);
  assert.equal(f.messages.length, 1);
});

test('async hud_ask answer and default timeout require ack and fresh output', async (t) => {
  const clock = makeFakeClock(1000);
  const f = makeLifecycleFixture(t, { role: 'reviewer', profile: 'reviewer', timing: clock.timing, watchQa: false });
  await f.emit('session_start');
  await f.emit('before_agent_start');
  const q1 = publishQuestion(join(f.dir, 'qa'), { tag: 'reviewer@proj', question: 'First?', default: 'A' });
  const q2 = publishQuestion(join(f.dir, 'qa'), { tag: 'reviewer@proj', question: 'Second?', default: 'B' });
  f.controller.trackQuestion(f.ctx, q1, 5000);
  f.controller.trackQuestion(f.ctx, q2, 5000);
  f.writeReport('interim report\n');
  f.setIdle(true);
  await f.emit('agent_settled');
  await immediate();
  assert.equal(f.status().state, 'waiting_orchestrator');
  assert.equal(f.shutdowns(), 0);

  // Answer q1 before deadline, let q2 time out at +5000ms.
  fs.writeFileSync(q1.afile, 'Option A1\n', { flag: 'wx' });
  clock.advance(2000);
  assert.equal(f.sentMessages.length, 1);
  assert.equal(f.sentMessages[0].message.details.answered, true);
  clock.advance(3000);
  assert.equal(f.sentMessages.length, 2);
  assert.equal(f.sentMessages[1].message.details.answered, false);
  assert.match(f.sentMessages[1].message.content, /No answer to q2.*reversible and inside the brief.*blocked in your report/);
  assert.equal(fs.existsSync(q2.afile), false, 'timeout is not an orchestrator answer');

  // Ack both; interim report before ack must NOT satisfy fresh output.
  await f.emit('message_start', { message: { role: 'custom', ...f.sentMessages[0].message } });
  assert.equal(f.status().state, 'waiting_orchestrator');
  await f.emit('message_start', { message: { role: 'custom', ...f.sentMessages[1].message } });
  assert.equal(f.status().state, 'working');
  await f.emit('agent_settled');
  await immediate();
  assert.equal(f.status().state, 'failed', 'interim report cannot be accepted as fresh output');
});

test('an overdue async steer polls normally while busy, then tells main and accepts a late ack once', async (t) => {
  const clock = makeFakeClock(1000);
  const f = makeLifecycleFixture(t, { timing: clock.timing });
  await f.emit('session_start');
  await f.emit('before_agent_start');
  const q = publishQuestion(join(f.dir, 'qa'), { tag: 'reviewer@proj', question: 'Choose?', default: 'A' });
  f.controller.trackQuestion(f.ctx, q, 5000);
  fs.writeFileSync(q.afile, 'B', { flag: 'wx' });
  f.setIdle(false);
  clock.advance(2000);
  assert.equal(f.sentMessages.length, 1);
  assert.equal(f.sentMessages[0].message.details.answered, true);
  clock.advance(20_000);
  assert.equal([...clock.timers.values()][0].delay, 2000, 'no 1 ms loop while Pi is busy');
  assert.equal(f.status().reason, undefined);

  const rows = () => readThinJobRows(f.root, { pane: null });
  const before = rows();
  assert.equal(before.length, 1);
  assert.equal(before[0].open_questions, 0, 'main already answered');
  f.setIdle(true);
  clock.advance(2000);
  assert.equal(f.status().state, 'waiting_orchestrator');
  assert.equal(f.status().error, null);
  assert.equal(f.status().ended_at, null);
  assert.match(jobChanges(before, rows()).join('\n'), /waiting_orchestrator.*Undelivered HUD decision \(q1\)/);
  f.writeReport('Interim report while awaiting acknowledgement.\n');
  await f.emit('agent_settled');
  await immediate();
  assert.equal(f.shutdowns(), 0);
  assert.equal(f.status().state, 'waiting_orchestrator');
  const noticed = rows();
  clock.advance(20_000);
  assert.deepEqual(jobChanges(noticed, rows()), [], 'no repeated notification');
  assert.equal(f.sentMessages.length, 1);

  const ack = { message: { role: 'custom', ...f.sentMessages[0].message } };
  await f.emit('message_start', ack);
  assert.equal(f.status().state, 'working');
  assert.equal(f.status().reason, undefined);
  f.writeReport('Fresh report after acknowledgement.\n');
  await f.emit('message_start', ack); // Duplicate ack must not reset the fresh-report baseline.
  await f.emit('agent_settled');
  await immediate();
  assert.equal(f.status().state, 'closed');
  assert.equal(f.shutdowns(), 1);
  assert.equal(f.sentMessages.length, 1);
});

test('stop, abort, session_tree, session_shutdown and stale ownership suppress pending async delivery', async (t) => {
  for (const reason of ['stop', 'abort', 'tree', 'session_shutdown', 'replaced']) {
    await t.test(reason, async (sub) => {
      const f = await makeFullTabWorkerFixture(sub, { askTimeout: '0' });
      await f.ask('async');
      f.setIdle(true);
      f.answer('q1', 'do not deliver');
      if (reason === 'stop') f.stop();
      if (reason === 'abort') await f.emit('agent_settled', { aborted: true });
      if (reason === 'tree') await f.emit('session_tree');
      if (reason === 'session_shutdown') await f.emit('session_shutdown', { reason: 'new' });
      if (reason === 'replaced') {
        fs.writeFileSync(f.statusFile, JSON.stringify({ state: 'working', session_id: 'replacement' }));
        await f.emit('thinking_level_select');
      }
      await delay(40);
      assert.equal(f.status().state, reason === 'stop' ? 'stopped' : reason === 'replaced' ? 'working' : 'failed');
      assert.deepEqual(f.messages, []);
    });
  }
});

test('sync hud_ask waits via fs-watch wake (< 200 ms) and non-TUI rejects async ask cleanly', async (t) => {
  const f = await makeFullTabWorkerFixture(t, { askTimeout: '5' });
  const pending = f.ask('sync');
  await waitFor(() => fs.existsSync(join(f.qa, 'q1.md')), 1000);
  assert.equal(f.status().state, 'waiting_orchestrator');
  const answeredAt = performance.now();
  f.answer('q1', 'Sync choice');
  const result = await pending;
  assert.ok(performance.now() - answeredAt < 200, 'sync hud_ask should wake via fs.watch in < 200 ms');
  assert.match(result.content[0].text, /ANSWER from the orchestrator \(q1.*Sync choice/s);
  assert.equal(result.terminate, undefined);
  assert.equal(f.messages.length, 0);

  const nonTui = await makeFullTabWorkerFixture(t, { mode: 'json', askTimeout: '0' });
  await assert.rejects(nonTui.ask('async'), /requires the live HUD Pi TUI worker/);
  assert.equal(fs.existsSync(join(nonTui.qa, 'q1.md')), false);
});

// ─── 4. Tab UI entry (HUD footer + native t/s) + piWorkerArgv tab tests ──────

test('tab UI entry mounts HUD createP10kFooter and displays native t/s from trackTps', () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-tab-ui-'));
  try {
    const handlers = new Map();
    const sessionEntries = [];
    let footerComponent;
    let editorComponent;
    let renders = 0;
    const pi = {
      on(name, fn) {
        handlers.set(name, [...(handlers.get(name) ?? []), fn]);
        return () => handlers.set(name, (handlers.get(name) ?? []).filter(h => h !== fn));
      },
      appendEntry(type, data) {
        sessionEntries.push({ type: 'custom', customType: type, data });
      },
      getThinkingLevel: () => 'high',
      getAllTools: () => [{ name: 'read' }],
      getCommands: () => [],
    };
    let now = 100;
    trackTps(pi, () => now);
    const host = createFooterHost({
      visibleWidth: (text) => [...stripAnsi(text)].length,
      truncateToWidth: (text, width, ellipsis = '') => {
        const plain = stripAnsi(text);
        if ([...plain].length <= width) return plain;
        return [...plain].slice(0, Math.max(0, width - [...ellipsis].length)).join('') + ellipsis;
      },
    });
    const footer = installWorkerUi(pi, host, { HUD_HOME: home, NO_COLOR: '1' }, {
      gitStatus: (_cwd, done) => done(null, '## main\n'),
    });
    const ctx = {
      mode: 'tui',
      hasUI: true,
      model: { provider: 'openai', id: 'gpt-6.2-sol', contextWindow: 200_000 },
      sessionManager: {
        getSessionId: () => 'tab-ui-session',
        getLeafId: () => `leaf-${sessionEntries.length}`,
        getEntries: () => sessionEntries,
        getBranch: () => sessionEntries,
        getCwd: () => home,
      },
      getContextUsage: () => ({ contextWindow: 200_000, percent: 25 }),
      ui: {
        theme: { fg: (_token, text) => text },
        notify() {},
        setFooter(factory) {
          footerComponent = factory ? factory({ requestRender: () => { renders++; } }, ctx.ui.theme, {
            getExtensionStatuses: () => new Map([['role', 'role:imp']]),
          }) : undefined;
        },
        setEditorComponent(factory) {
          editorComponent = factory ? factory({ requestRender: () => { renders++; } }, ctx.ui.theme, {}) : undefined;
        },
      },
    };
    const emit = (name, event = {}) => {
      for (const fn of handlers.get(name) ?? []) fn(event, ctx);
    };
    emit('session_start');
    assert.equal(footer.ownsFooter(), true);
    assert.ok(footerComponent && editorComponent);

    // Run one measured turn through native trackTps -> turn_end updates footer.
    const msg = {
      message: {
        role: 'assistant', provider: 'openai', model: 'gpt-6.2-sol',
        usage: { input: 90, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } },
      },
    };
    emit('turn_start');
    now = 110; emit('message_start', msg);
    for (now of [150, 160, 210, 260, 310, 360]) emit('message_update', msg);
    now = 370; emit('message_end', msg);
    now = 450; emit('turn_end');
    assert.equal(sessionEntries.length, 1);

    const ribbon = stripAnsi(editorComponent.renderTopBorder(140, 0));
    const barLine = stripAnsi(footerComponent.render(120).join('\n'));
    assert.match(ribbon, /50\.0 t\/s|50 t\/s/, `expected native t/s in ribbon: ${ribbon}`);
    assert.match(ribbon, /role:imp/, `expected role status in top border: ${ribbon}`);
    assert.match(barLine, /25%/, `expected context in HUD footer bar: ${barLine}`);
    assert.ok(renders > 0);

    emit('session_shutdown');
    assert.equal(footer.ownsFooter(), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('piWorkerArgv tab mode attaches HUD UI, herdr-agent-state, opt-in optional MCP/lens (R2), and keeps headless UI-free', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-tab-argv-'));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const home = join(root, 'hud_home');
  const jobId = 'j3333333333333333';
  const dir = join(home, 'jobs', jobId);
  const agentDir = join(root, 'pi-agent');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(join(agentDir, 'extensions'), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const herdrState = join(agentDir, 'extensions', 'herdr-agent-state.ts');
  fs.writeFileSync(herdrState, 'export default function () {}\n');
  const mcpDir = join(home, 'pi-worker', 'optional', 'node_modules', 'pi-mcp-adapter');
  const lensDir = join(home, 'pi-worker', 'optional', 'pi-lens');
  fs.mkdirSync(mcpDir, { recursive: true });
  fs.mkdirSync(lensDir, { recursive: true });

  const baseJob = { job: jobId, role: 'imp', model: 'openai/gpt-6.2-sol', thinking: 'high' };
  const tabArgs = piWorkerArgv(home, dir, baseJob, { instructions: 'implementer' }, 'implementer', []);
  assert.ok(tabArgs.includes('--tui-mode'));
  assert.ok(tabArgs.includes(resolve('integrations/pi/worker/hud-worker.mjs')));
  assert.ok(tabArgs.includes(resolve('integrations/pi/worker/hud-worker-ui.mjs')));
  assert.ok(tabArgs.includes(herdrState), 'herdr-agent-state attached on tab');
  assert.equal(tabArgs.includes(mcpDir), false, 'R2: MCP never auto-loads');
  assert.equal(tabArgs.includes(lensDir), false, 'lens is opt-in');
  assert.equal(tabArgs.includes('--print'), false);
  const tabContract = readContract(dir);
  assert.deepEqual(tabContract.tab, { profile: 'implementer' });

  const withOpt = piWorkerArgv(home, dir, { ...baseJob, mcp: true, lens: true, ui_ext: false }, { instructions: 'implementer' }, 'implementer', [], undefined, '/synthetic/resume.jsonl', 'orchestrator');
  assert.equal(withOpt.includes(resolve('integrations/pi/worker/hud-worker-ui.mjs')), false, 'ui_ext: false skips tab UI');
  assert.ok(withOpt.includes(mcpDir), 'mcp: true attaches optional/node_modules/pi-mcp-adapter');
  assert.ok(withOpt.includes(lensDir), 'lens: true attaches optional/pi-lens');
  assert.deepEqual(withOpt.slice(-2), ['--session', '/synthetic/resume.jsonl']);
  assert.equal(readContract(dir).tab?.effortSource, 'orchestrator');

  // Headless never attaches tab UI or herdr-agent-state.
  const headlessArgs = piWorkerArgv(home, dir, { ...baseJob, headless: true }, { instructions: 'implementer' }, 'implementer', [], 'brief', '/synthetic/headless.jsonl');
  assert.equal(headlessArgs.includes(resolve('integrations/pi/worker/hud-worker-ui.mjs')), false);
  assert.equal(headlessArgs.includes(herdrState), false);
  assert.equal(readContract(dir).tab, undefined);
});

test('installed Pi loader loads hud-worker.mjs and hud-worker-ui.mjs with zero errors and no R3 slash commands', async (t) => {
  const pkg = piPackage();
  if (!pkg) return t.skip('pi package not installed');
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-tab-loader-'));
  const home = join(root, 'hud_home');
  const jobId = 'j4444444444444444';
  const dir = join(home, 'jobs', jobId);
  fs.mkdirSync(join(dir, 'qa'), { recursive: true });
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({
    job: jobId, role: 'imp', cwd: root, request_key: 'loader', created_at: new Date().toISOString(),
    dispatch_exit_code: 0, stderr_tail: '',
  }));
  writeContract(dir, {
    version: 1, job: jobId, role: 'imp', instructions: 'implementer',
    explicitTools: false, tps: true, tab: { profile: 'implementer' },
  });
  const prevJobDir = process.env.HUD_JOB_DIR;
  const prevHome = process.env.HUD_HOME;
  process.env.HUD_JOB_DIR = dir;
  process.env.HUD_HOME = home;
  t.after(() => {
    if (prevJobDir === undefined) delete process.env.HUD_JOB_DIR; else process.env.HUD_JOB_DIR = prevJobDir;
    if (prevHome === undefined) delete process.env.HUD_HOME; else process.env.HUD_HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { loadExtensions } = await import(pathToFileURL(join(pkg.root, 'dist/core/extensions/loader.js')).href);
  const agentPackage = createRequire(join(pkg.root, 'package.json')).resolve('@earendil-works/pi-agent-core/package.json');
  const { Agent } = await import(pathToFileURL(join(dirname(agentPackage), 'dist/index.js')).href);
  const followUp = Agent.prototype.followUp;
  t.after(() => { Agent.prototype.followUp = followUp; });
  const { errors, extensions } = await loadExtensions([
    resolve('integrations/pi/worker/hud-worker.mjs'),
    resolve('integrations/pi/worker/hud-worker-ui.mjs'),
  ], root);
  assert.deepEqual(errors, []);
  assert.equal(extensions.length, 2);
  assert.notEqual(Agent.prototype.followUp, followUp, 'HUD observes the installed host queue, not a second copy of pi');
  const allCommands = extensions.flatMap((ext) => [...ext.commands.keys()]);
  for (const removed of ['role', 'brief', 'deepseek-search', 'deepseek-fetch', 'hud']) {
    assert.equal(allCommands.includes(removed), false, `R3: /${removed} must not be registered in worker tabs`);
  }
  const workerTools = [...extensions[0].tools.keys()];
  for (const required of ['hud_report', 'hud_ask', 'hud_sonic', 'hud_progress', 'hud_lease']) {
    assert.ok(workerTools.includes(required), `missing worker tool ${required}`);
  }
});
