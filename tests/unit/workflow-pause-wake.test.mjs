import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { watchCommand } from '../../dist/cli/watch.js';
import { countProjectWaitingRuns, executionSnapshot } from '../../dist/collectors/execution.js';
import { collectWorkSummary, createWorkSummaryPublisher, readMachineWork } from '../../dist/collectors/work-summary-snapshot.js';
import { panelDelivery } from '../../dist/mcp/panel-delivery.js';
import { settleTicketHandback } from '../../dist/mcp/ticket-queue-step.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { runDetailRows } from '../../dist/render/execution-run-detail.js';
import { executionRows } from '../../dist/render/execution-view.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { machineWorkForms } from '../../dist/render/work-summary.js';
import { procStat } from '../../dist/utils/proc.js';
import { taskNoticeSource } from '../../dist/workflows/events.js';
import { fixture as watchFixture, until } from '../helpers/job-retention-fixture.mjs';
import { stopChild } from '../helpers/process-cleanup.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { resultValue, taskCall, taskRpc } from '../helpers/thin-mcp-harness.mjs';
import { goodTicket, setupWorkflowProject } from '../helpers/workflow-ticket-project.mjs';

const MAIN_PANE = 'w4E:p1';

async function syntheticPromptHerdr(t, dir, { initialFail = true } = {}) {
  const endpoint = join(dir, 'prompt.sock');
  const sockets = new Set();
  const delivered = [];
  let failPrompts = initialFail;
  let attempts = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const input = createInterface({ input: socket });
    input.on('error', () => {});
    input.on('line', (line) => {
      const { id, method, params } = JSON.parse(line);
      if (method === 'ping') {
        socket.write(JSON.stringify({ id, result: { type: 'pong', version: '1.0-hud', capabilities: { guarded_prompt: true } } }) + '\n');
        return;
      }
      if (method === 'agent.prompt') {
        attempts++;
        if (failPrompts) {
          socket.write(JSON.stringify({ id, error: { code: 'not_ready', message: 'busy' } }) + '\n');
          return;
        }
        delivered.push({ target: params.target, text: params.text });
        socket.write(JSON.stringify({ id, result: { type: 'agent_prompted' } }) + '\n');
        return;
      }
      socket.write(JSON.stringify({ id, result: { type: 'ok' } }) + '\n');
    });
  });
  server.listen(endpoint);
  await once(server, 'listening');
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((done) => server.close(done));
  });
  return {
    endpoint,
    delivered,
    attempts: () => attempts,
    setFail(value) { failPrompts = value; },
  };
}

function seedPausedRun(home, root, { flow, kind, reason, ask, step = 'tickets', unattended = false, task = false, epoch = 0, pane = MAIN_PANE }) {
  const now = new Date().toISOString();
  const q = {
    flow,
    root,
    cwd: root,
    project_root: root,
    feature: 'sample',
    pane,
    task,
    max_parallel: 1,
    created_at: now,
    updated_at: now,
    template: 'ticket-queue',
    host: 'detached',
    epoch,
    settled: 0,
    streak: 0,
    failures: 0,
    notices: {},
    steps: {
      tickets: { state: step === 'tickets' ? 'failed' : 'done' },
      review: { state: step === 'accept' ? 'done' : 'waiting' },
      accept: { state: ask ? 'asking' : step === 'accept' ? 'failed' : 'waiting' },
    },
    ...(unattended ? { unattended: { objective: 'selected' } } : {}),
    state: 'working',
    tickets: [],
    reason,
  };
  if (ask) {
    q.state = 'paused';
    q.reason = ask;
    q.handback = { step: 'accept', choices: ['finish', 'repair', 'escalate'] };
    q.notices = {
      [`pause-${epoch}`]: `${flow} (ticket queue sample) — hand-back at accept: ${ask} (finish/repair/escalate) | reply: hud_respond job=${flow} answer=<finish|repair|escalate>[: reason]`,
    };
  } else {
    settleTicketHandback(q, { kind, step, reason });
  }
  fs.mkdirSync(join(home, 'flows', flow), { recursive: true, mode: 0o700 });
  writeFixtureFile(join(home, 'flows', `${flow}.json`), JSON.stringify(q));
  return q;
}

test('each waiting kind records pause notice in notices and retries failed watcher delivery on next pass without duplicates', { timeout: 25_000 }, async (t) => {
  const f = watchFixture(t);
  const root = join(dirname(f.home), 'project');
  fs.mkdirSync(root, { recursive: true });
  const herdr = await syntheticPromptHerdr(t, dirname(f.home), { initialFail: true });
  const flows = [
    seedPausedRun(f.home, root, { flow: 'q00000000000000a1', kind: 'blocker', reason: 'worker blocker needs decision', unattended: true }),
    seedPausedRun(f.home, root, { flow: 'q00000000000000a2', kind: 'escalate', step: 'accept', reason: 'escalated: deletes user-visible command' }),
    seedPausedRun(f.home, root, { flow: 'q00000000000000a3', kind: 'escalate', step: 'accept', ask: 'Accept landed feature?' }),
    seedPausedRun(f.home, root, { flow: 'q00000000000000a4', kind: 'escalate', step: 'accept', reason: 'lead requested repair with no ready tickets: fix test' }),
  ];

  // Every waiting kind pauses and records a non-empty pause-0 entry in notices (including blocker & unattended).
  for (const q of flows) {
    assert.equal(q.state, 'paused', q.flow);
    assert.ok(q.notices['pause-0'] && q.notices['pause-0'].includes(q.flow), `missing pause-0 for ${q.flow}`);
  }
  // Task runs also record pause-0 in notices (never empty).
  const taskBlocker = {
    flow: 'q00000000000000a9', root, feature: 'sample', pane: MAIN_PANE, task: true, max_parallel: 1,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    epoch: 0, notices: {}, state: 'working', tickets: [], reason: 'blocker on task run',
  };
  settleTicketHandback(taskBlocker, { kind: 'blocker', step: 'tickets', reason: 'blocker on task run' });
  assert.equal(taskBlocker.state, 'paused');
  assert.match(taskBlocker.notices['pause-0'], /blocker on task run/);

  // Pass 1: herdr guarded prompt fails -> watcher attempts delivery and releases markers (no .noticed left behind).
  const preload = `process.env.HERDR_SOCKET_PATH = ${JSON.stringify(herdr.endpoint)};`;
  const watch = f.start(preload);
  t.after(() => stopChild(watch.child, watch.exited));
  await until(() => herdr.attempts() >= flows.length, 8_000);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(herdr.delivered.length, 0, 'failed attempts must not deliver');
  for (const q of flows) {
    assert.equal(fs.existsSync(join(f.home, 'flows', q.flow, 'pause-0.noticed')), false, `marker must be released after failure for ${q.flow}`);
  }

  // Next watcher pass: herdr succeeds -> every paused run delivers exactly once and writes its marker.
  herdr.setFail(false);
  await until(() => herdr.delivered.length === flows.length, 8_000);
  const byFlow = new Map();
  for (const entry of herdr.delivered) {
    assert.equal(entry.target, MAIN_PANE);
    const hit = flows.find((q) => entry.text.includes(q.flow));
    assert.ok(hit, `unexpected prompt: ${entry.text}`);
    byFlow.set(hit.flow, (byFlow.get(hit.flow) ?? 0) + 1);
  }
  for (const q of flows) {
    assert.equal(byFlow.get(q.flow), 1, `expected exactly 1 delivery for ${q.flow}`);
    assert.equal(fs.existsSync(join(f.home, 'flows', q.flow, 'pause-0.noticed')), true, `marker kept for ${q.flow}`);
  }

  // Trigger another watcher pass (touch a flow file) -> zero duplicate deliveries.
  writeFixtureFile(join(f.home, 'flows', `${flows[0].flow}.json`), JSON.stringify({ ...flows[0], updated_at: new Date().toISOString() }));
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(herdr.delivered.length, flows.length, 'subsequent watcher pass must not duplicate notices');
});

test('taskNoticeSource and panelDelivery retry a failed push without touching flows/ mtime and deliver unattended paused runs', async (t) => {
  const f = watchFixture(t);
  const root = join(dirname(f.home), 'project');
  fs.mkdirSync(root, { recursive: true });
  const unatt = seedPausedRun(f.home, root, {
    flow: 'q00000000000000b1', kind: 'blocker', reason: 'unattended blocker pause', unattended: true, pane: '',
  });
  const source = taskNoticeSource(f.home, MAIN_PANE, root);
  let calls = 0;
  const pushed = [];
  const delivery = panelDelivery(f.home, MAIN_PANE, root, () => false, async (msg) => {
    calls++;
    if (calls === 1) return false;
    pushed.push(msg);
    return true;
  }, source);
  t.after(() => delivery.stop());

  // Tick 1 fails and releases the marker; tick 2 retries cleanly even though flows/ mtime did not change.
  await until(() => pushed.length === 1, 5_000);
  assert.equal(calls, 2);
  assert.match(pushed[0], new RegExp(`${unatt.flow}.*unattended blocker pause`));
  assert.equal(fs.existsSync(join(f.home, 'flows', unatt.flow, 'pause-0.noticed')), true);
  assert.deepEqual(await delivery.changes(), []);
});

test('repair with no ready tickets pauses and delivers one notice to watch; resume and second pause deliver a new notice (watch + MCP task)', { timeout: 60_000 }, async (t) => {
  // 1. Lead requests repair with no ready tickets -> paused, notices['pause-0'] recorded, delivered once to hud watch.
  const f = await setupWorkflowProject(t, { tickets: { '01-only.md': goodTicket(1) } });
  const watchLines = [];
  const watch = spawn(process.execPath, [resolve('bin/hud'), 'watch'], {
    cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const watchExit = once(watch, 'exit');
  f.onCleanup(() => stopChild(watch, watchExit));
  createInterface({ input: watch.stdout }).on('line', (line) => watchLines.push(line));
  await until(() => fs.existsSync(join(f.home, 'watchers', `${f.env.HERDR_PANE_ID}.pid`)), 10_000);

  const { flow: noWorkFlow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root });
  const [j1] = await f.jobs(noWorkFlow, 1);
  await f.settle(j1);
  await until(() => Boolean(f.flow(noWorkFlow).review_job), 15_000);
  await f.settleReview(f.flow(noWorkFlow).review_job);
  await until(() => f.flow(noWorkFlow).active_lead?.kind === 'accept', 15_000);
  await f.settleLead(f.flow(noWorkFlow).active_lead.job, 'Decision: repair\nReason: Missing edge case.\n');
  const pausedNoWork = await f.end(noWorkFlow);
  assert.equal(pausedNoWork.state, 'paused');
  assert.match(pausedNoWork.notices['pause-0'], /lead requested repair with no ready tickets/);
  await until(() => watchLines.some((line) => line.includes(noWorkFlow) && /no ready tickets/.test(line)), 10_000);
  assert.equal(watchLines.filter((line) => line.includes(noWorkFlow)).length, 1);

  // 2. MCP task hand-back to main: pause -> resume (repair) -> pause again delivers a new pause notice for each epoch.
  f.writeJsonTicket(1, {}, 'taskmain');
  f.git(f.root, 'add', '.hud/tickets/taskmain.json');
  f.git(f.root, 'commit', '-qm', 'taskmain feature');

  // Stop the stdout watch so a fresh task-capable MCP client tests MCP task delivery cleanly.
  await stopChild(watch, watchExit);
  await f.stopMcp();
  const mcp = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-mcp.mjs')], {
    cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const mcpExit = once(mcp, 'exit');
  f.onCleanup(() => stopChild(mcp, mcpExit, { closeStdin: true }));
  const rpc = taskRpc((method, params) => new Promise((resolveRpc) => {
    const id = Math.floor(Math.random() * 1e9);
    const onLine = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === id) { rl.off('line', onLine); resolveRpc(msg); }
    };
    rl.on('line', onLine);
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  }));
  const rl = createInterface({ input: mcp.stdout });
  await rpc('server/discover');

  const started = await taskCall(rpc, 'hud_tickets', { op: 'run', feature: 'taskmain', max_parallel: 1, cwd: f.root, handback_to: 'main' });
  assert.equal(started.resultType, 'task');
  assert.equal(started.status, 'working');
  const taskFlow = started.taskId;
  const [tJob1] = await f.jobs(taskFlow, 1);
  await f.settle(tJob1);
  await until(() => Boolean(f.flow(taskFlow).review_job), 15_000);
  const rev1 = f.flow(taskFlow).review_job;
  await f.settleReview(rev1);
  const pause1 = await f.end(taskFlow);
  assert.equal(pause1.state, 'paused');
  assert.ok(pause1.notices['pause-0'], 'task run records pause-0 in notices');
  const get1 = await rpc('tasks/get', { taskId: taskFlow });
  assert.equal(get1.status, 'completed', 'MCP task uses valid completed status on pause');
  assert.match(get1.result.content[0].text, /hand-back at accept/);

  // Add a repair ticket and resume -> pauses again at epoch 1 with a new pause-1 notice!
  resultValue(await taskCall(rpc, 'hud_tickets', {
    op: 'add', cwd: f.root, feature: 'taskmain',
    tickets: [{ title: 'Repair round', blocked_by: [], what: 'Fix synthetic gap.', acceptance: ['Fixed'], live_try: 'none' }],
  }));
  const resumed = await taskCall(rpc, 'hud_respond', { job: taskFlow, answer: 'repair: round 1' });
  assert.equal(resumed.resultType, 'task');
  assert.equal(resumed.status, 'working');
  const [, tJob2] = await f.jobs(taskFlow, 2);
  await f.settle(tJob2);
  await until(() => f.flow(taskFlow).review_job && f.flow(taskFlow).review_job !== rev1, 15_000);
  await f.settleReview(f.flow(taskFlow).review_job);
  const pause2 = await f.end(taskFlow);
  assert.equal(pause2.state, 'paused');
  assert.equal(pause2.epoch, 1);
  assert.ok(pause2.notices['pause-1'], 'second pause records new pause-1 notice');
  assert.equal(pause2.notices['pause-0'], undefined);
  const get2 = await rpc('tasks/get', { taskId: taskFlow });
  assert.equal(get2.status, 'completed');
  assert.match(get2.result.content[0].text, /hand-back at accept/);
});

test('hud watch stdout error releases flow notice markers so the next pass retries cleanly', async (t) => {
  const f = watchFixture(t);
  const root = join(dirname(f.home), 'project');
  fs.mkdirSync(root, { recursive: true });
  const q = seedPausedRun(f.home, root, { flow: 'q00000000000000c1', kind: 'escalate', step: 'accept', reason: 'retry watch stdout' });
  const prevCwd = process.cwd();
  process.chdir(root);
  t.after(() => process.chdir(prevCwd));

  const env = { ...process.env, HUD_HOME: f.home, HERDR_PANE_ID: MAIN_PANE };
  const failPipe = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
  await watchCommand([], { env, stdout: async () => { throw failPipe; }, stderr: () => {} }, { rescanMs: 50 });
  assert.equal(fs.existsSync(join(f.home, 'flows', q.flow, 'pause-0.noticed')), false, 'broken pipe must release marker');

  let received = '';
  const ac = new AbortController();
  const running = watchCommand([], { env, stdout: async (chunk) => { received += chunk; ac.abort(); }, stderr: () => {} }, { signal: ac.signal, rescanMs: 50 });
  await running;
  assert.match(received, new RegExp(`${q.flow}.*retry watch stdout`));
  assert.equal(fs.existsSync(join(f.home, 'flows', q.flow, 'pause-0.noticed')), true);
});

test('bar and panel show a paused run as main load until answered', (t) => {
  const f = watchFixture(t);
  const root = join(dirname(f.home), 'project');
  fs.mkdirSync(root, { recursive: true });
  const q = seedPausedRun(f.home, root, { flow: 'q00000000000000d1', kind: 'escalate', step: 'accept', ask: 'Accept feature?' });
  const prevDisplay = setDisplayConfig({ theme: 'none', icons: 'unicode' });
  const prevLang = setLanguage('en');
  t.after(() => { setDisplayConfig(prevDisplay); setLanguage(prevLang); });

  const now = Date.now();
  const pub = createWorkSummaryPublisher(f.home, 'hud-watch');
  writeFixtureFile(join(f.home, 'watch.pid'), `${process.pid}\n`);
  assert.equal(pub.publish({ watching: true, now }), true);

  // Bar: paused run counts as Main 1 even with 0 running jobs, and clears when answered.
  assert.equal(collectWorkSummary(f.home).global.pausedMain, 1);
  const work = readMachineWork(f.home, now);
  assert.equal(work.pausedMain, 1);
  assert.equal(machineWorkForms(work, now, 'unicode')[0], 'Main 1');

  // Panel: Execution shows waiting count & tab live badge (not ?N owner request), Run Detail shows Waiting on main in EN/ZH.
  assert.equal(countProjectWaitingRuns(f.home, root), 1);
  assert.equal(countProjectWaitingRuns(f.home, '/synthetic/other'), 0);
  const snap = executionSnapshot(f.home, { workers: [], lanes: [] }, { root, pane: MAIN_PANE, complete: true }, now);
  const execText = executionRows(snap, undefined, 80, now).map((r) => stripAnsi(r.text)).join('\n');
  assert.match(execText, /0 running\s+1 waiting\s+0 queued/);
  const execFrame = renderMonitor({
    state: { ...initialMonitorState(), activeTab: 'execution' },
    width: 80, height: 24, nowMs: now, execution: snap,
  });
  assert.match(stripAnsi(execFrame.lines[0]), /Execution·1/);
  assert.doesNotMatch(stripAnsi(execFrame.lines[0]), /\?1/);
  for (const [lang, expected] of [['en', 'Waiting on main'], ['zh', '等待主会话处理']]) {
    setLanguage(lang);
    const detail = runDetailRows(snap.runs[0], 80, now);
    for (const row of detail) {
      assert.equal(visualLength(row.text), 80);
      assert.equal(row.text, stripAnsi(row.text));
    }
    assert.ok(detail.map((r) => r.text).join('\n').includes(expected), `${lang} missing ${expected}`);
  }
  setLanguage('en');

  // Answer / finish the paused run -> both bar and panel clear main load immediately.
  const answered = { ...q, state: 'completed', updated_at: new Date().toISOString() };
  delete answered.handback;
  writeFixtureFile(join(f.home, 'flows', `${q.flow}.json`), JSON.stringify(answered));
  assert.equal(collectWorkSummary(f.home).global.pausedMain, undefined);
  assert.equal(pub.publish({ watching: true, now: now + 100 }), true);
  assert.deepEqual(machineWorkForms(readMachineWork(f.home, now + 100), now + 100, 'unicode'), []);
  assert.equal(countProjectWaitingRuns(f.home, root), 0);
  const snapAfter = executionSnapshot(f.home, { workers: [], lanes: [] }, { root, pane: MAIN_PANE, complete: true }, now + 100);
  const afterText = executionRows(snapAfter, undefined, 80, now + 100).map((r) => stripAnsi(r.text)).join('\n');
  assert.doesNotMatch(afterText, /1 waiting/);
  const frameAfter = renderMonitor({
    state: { ...initialMonitorState(), activeTab: 'execution' },
    width: 80, height: 24, nowMs: now + 100, execution: snapAfter,
  });
  assert.doesNotMatch(stripAnsi(frameAfter.lines[0]), /Execution·/);
  assert.doesNotMatch(runDetailRows(snapAfter.runs[0], 80, now + 100).map((r) => r.text).join('\n'), /Waiting on main/);
});
