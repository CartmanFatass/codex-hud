import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { watchCommand } from '../../dist/cli/watch.js';
import { classifyCodexQueueOutcome, notify } from '../../dist/roles/notify.js';
import { claimQueueTask, queueTaskFile, readQueueTask } from '../../dist/mcp/ticket-queue-state.js';
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
import { beginNotice, readDeliveryRecord, settleNotice } from '../../dist/utils/delivery-record.js';
import { noticeResolver } from '../../dist/roles/select-send.js';
import { taskNoticeSource, workflowEvents } from '../../dist/workflows/events.js';
import { runVisible } from '../../dist/workflows/scope.js';
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
      if (method === 'pane.list') {
        socket.write(JSON.stringify({ id, result: { panes: [{ pane_id: MAIN_PANE, agent: 'claude', cwd: join(dir, 'project') }] } }) + '\n');
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

function seedPausedRun(home, root, { flow, kind, reason, ask, step = 'tickets', unattended = false, task = false, epoch = 0, pane = MAIN_PANE, origin_mcp }) {
  const now = new Date().toISOString();
  const q = {
    flow,
    root,
    cwd: root,
    project_root: root,
    feature: 'sample',
    pane,
    ...(origin_mcp ? { origin_mcp } : {}),
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
  const herdr = await syntheticPromptHerdr(t, dirname(f.home));
  const resolveNotice = noticeResolver(f.home, { ...process.env, HERDR_SOCKET_PATH: herdr.endpoint });
  const source = taskNoticeSource(f.home, MAIN_PANE, root);
  let calls = 0;
  const pushed = [];
  const delivery = panelDelivery(f.home, MAIN_PANE, root, () => false, async (msg) => {
    calls++;
    if (calls === 1) return { outcome: 'refused' };
    pushed.push(msg);
    return { outcome: 'sent' };
  }, () => source(async origin => (await resolveNotice(origin, { pane: MAIN_PANE, cwd: root })).kind === 'pane'));
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

async function codexQueueFallbackFixture(t, respond) {
  const f = watchFixture(t);
  const root = join(dirname(f.home), 'project');
  const bin = join(f.home, 'fake-bin');
  const socketPath = join(dirname(f.home), 'guarded-codex.sock');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const fake = `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'pane' && args[1] === 'get') {
  console.log(JSON.stringify({ result: { pane: { agent: 'codex', agent_status: 'idle', agent_session: { value: '00000000-0000-4000-8000-000000000001' } } } }));
} else if (args[0] === 'pane' && args[1] === 'process-info') {
  console.log(JSON.stringify({ result: { process_info: { foreground_processes: [{ name: 'codex', pid: ${process.pid} }] } } }));
} else if (args[0] === 'queue') {
  console.log(JSON.stringify({ error: { code: 'no_rollout' } }));
  process.exit(1);
}
`;
  for (const name of ['herdr', 'codex']) fs.writeFileSync(join(bin, name), fake, { mode: 0o700 });
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const lines = createInterface({ input: socket });
    lines.on('error', () => {});
    lines.on('line', (line) => {
      const { id, method, params } = JSON.parse(line);
      const reply = respond(method, params, socket);
      if (reply) socket.write(JSON.stringify({ id, ...reply }) + '\n');
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    await once(server, 'close');
  });
  const env = {
    ...process.env,
    HOME: join(dirname(f.home), 'home'),
    HUD_HOME: f.home,
    HERDR_PANE_ID: MAIN_PANE,
    HERDR_SOCKET_PATH: socketPath,
    PATH: `${bin}:${process.env.PATH}`,
  };
  return { home: f.home, root, env };
}

test('typed pause notice releases marker on expiry or cancellation for later delivery once, and never repeats an uncertain send', { timeout: 25_000 }, async (t) => {
  let mode = 'draft_present';
  let subscription;
  const attempts = [];
  const delivered = [];
  const f = await codexQueueFallbackFixture(t, (method, params, socket) => {
    if (method === 'ping') return { result: { type: 'pong', capabilities: { guarded_prompt: true } } };
    if (method === 'events.subscribe') {
      subscription = socket;
      return { result: { type: 'subscription_started' } };
    }
    assert.equal(method, 'agent.prompt');
    attempts.push(params.text);
    if (mode === 'draft_present' || mode === 'not_ready') return { error: { code: mode } };
    if (mode === 'uncertain') { socket.end(); return null; }
    delivered.push(params.text);
    return { result: { type: 'agent_prompted' } };
  });

  const prevCwd = process.cwd();
  process.chdir(f.root);
  t.after(() => process.chdir(prevCwd));

  const realNow = performance.now.bind(performance);
  let advance = 0;
  t.mock.method(performance, 'now', () => realNow() + advance);

  // 1. Draft present past the 10-minute guard -> expires unsent, releases marker, later watcher pass delivers exactly once.
  const expiredFlow = seedPausedRun(f.home, f.root, {
    flow: 'q00000000000000e1', kind: 'blocker', reason: 'draft expired pause notice',
  });
  const expiredMarker = join(f.home, 'flows', expiredFlow.flow, 'pause-0.noticed');
  const ac1 = new AbortController();
  t.after(() => ac1.abort());
  const run1 = watchCommand(['--queue'], { env: f.env, stdout: (s) => assert.fail(s), stderr: () => {} },
    { signal: ac1.signal, rescanMs: 80 });

  await until(() => Boolean(subscription) && attempts.length === 1, 8_000);
  assert.equal(fs.existsSync(expiredMarker), true, 'marker is claimed while pending');
  assert.equal(delivered.length, 0);

  const expiredSub = subscription;
  advance += 10 * 60_000;
  expiredSub.write(JSON.stringify({ event: 'pane.scroll_changed', data: { pane_id: MAIN_PANE } }) + '\n');
  await until(() => expiredSub.destroyed, 8_000);
  assert.match(fs.readFileSync(join(f.home, 'watchers', 'typed-expiry.log'), 'utf8'), /pending typed notice expired/);
  assert.equal(fs.existsSync(expiredMarker), false, 'expired unsent typed pause notice must release its marker');

  mode = 'ok';
  await until(() => delivered.length === 1, 8_000);
  assert.match(delivered[0], new RegExp(`${expiredFlow.flow}.*draft expired pause notice`));
  assert.equal(fs.existsSync(expiredMarker), true, 'marker stays set after delivery');
  await new Promise((r) => setTimeout(r, 220));
  assert.equal(delivered.length, 1, 'later watcher passes must not duplicate delivered pause notice');
  ac1.abort();
  assert.equal(await run1, 0);

  // 2. Cancellation while pending (busy) releases the marker so a later pass can deliver it.
  mode = 'not_ready';
  subscription = undefined;
  const cancelledFlow = seedPausedRun(f.home, f.root, {
    flow: 'q00000000000000e2', kind: 'blocker', reason: 'cancelled pending pause notice',
  });
  const cancelledMarker = join(f.home, 'flows', cancelledFlow.flow, 'pause-0.noticed');
  const ac2 = new AbortController();
  t.after(() => ac2.abort());
  const run2 = watchCommand(['--queue'], { env: f.env, stdout: (s) => assert.fail(s), stderr: () => {} },
    { signal: ac2.signal, rescanMs: 30_000 });
  await until(() => Boolean(subscription), 8_000);
  assert.equal(fs.existsSync(cancelledMarker), true);
  ac2.abort();
  assert.equal(await run2, 0);
  assert.equal(fs.existsSync(cancelledMarker), false, 'cancelled pending typed pause notice must release its marker');
  // Consume so it doesn't interfere with subcase 3.
  assert.equal((await workflowEvents(f.home, MAIN_PANE, false, f.root)).lines.length, 1);

  // 3. Uncertain send on retry keeps the marker and is never repeated on later watcher passes.
  mode = 'draft_present';
  subscription = undefined;
  const attemptsBeforeUncertain = attempts.length;
  const uncertainFlow = seedPausedRun(f.home, f.root, {
    flow: 'q00000000000000e3', kind: 'blocker', reason: 'uncertain pause notice',
  });
  const uncertainMarker = join(f.home, 'flows', uncertainFlow.flow, 'pause-0.noticed');
  const ac3 = new AbortController();
  t.after(() => ac3.abort());
  const run3 = watchCommand(['--queue'], { env: f.env, stdout: (s) => assert.fail(s), stderr: () => {} },
    { signal: ac3.signal, rescanMs: 60 });
  await until(() => Boolean(subscription) && attempts.length === attemptsBeforeUncertain + 1, 8_000);
  const uncertainSub = subscription;
  mode = 'uncertain';
  uncertainSub.write(JSON.stringify({ event: 'pane.updated', data: { pane: { pane_id: MAIN_PANE } } }) + '\n');
  await until(() => uncertainSub.destroyed && attempts.length === attemptsBeforeUncertain + 2, 8_000);
  assert.equal(fs.existsSync(uncertainMarker), true, 'uncertain send must keep its marker');

  mode = 'ok';
  await new Promise((r) => setTimeout(r, 220));
  assert.equal(attempts.length, attemptsBeforeUncertain + 2, 'uncertain send must never be repeated by later watcher passes');
  assert.equal(delivered.length, 1, 'uncertain pause notice must not be re-delivered');
  assert.deepEqual((await workflowEvents(f.home, MAIN_PANE, false, f.root)).lines, []);
  ac3.abort();
  assert.equal(await run3, 0);
});

test('the send gate rejects a buffered notice from the old epoch or without its claim', async t => {
  const f = watchFixture(t);
  const run = seedPausedRun(f.home, f.root, { flow: 'q0000000000000f00', kind: 'blocker', reason: 'synthetic pause' });
  const file = join(f.home, 'flows', `${run.flow}.json`);
  const save = () => writeFixtureFile(file, JSON.stringify(run));
  const read = async () => (await workflowEvents(f.home, MAIN_PANE, false, f.root)).events;
  run.notices = { 'handback-demo': 'Before resume' };
  save();
  const [old] = await read();
  run.epoch++;
  run.notices['handback-demo'] = 'After resume';
  save();
  assert.equal(beginNotice(old), false);
  assert.equal(readDeliveryRecord(old.marker).state, 'abandoned');
  const [current] = await read();
  assert.equal(current.epoch, run.epoch);
  assert.equal(current.marker, old.marker);
  assert.equal(beginNotice(old), false, 'the current epoch claim does not authorize the old item');
  fs.unlinkSync(current.marker);
  assert.equal(beginNotice(current), false, 'a current source on its own does not authorize sending');
  const [retry] = await read();
  assert.equal(beginNotice(retry), true);
  assert.equal(settleNotice(retry, 'sent', 'watch-stdout'), true);
});

test('with live origin pane a second project main does not claim its pause notice; with dead origin project fallback delivers', { timeout: 20_000 }, async (t) => {
  const f = watchFixture(t);
  const root = join(dirname(f.home), 'project');
  const unrelated = join(dirname(f.home), 'other-project');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(unrelated, { recursive: true });

  const originProc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const originExit = once(originProc, 'exit');
  t.after(() => stopChild(originProc, originExit));
  const originStart = procStat(originProc.pid)?.start;
  assert.ok(originStart, 'live origin process start time');
  const origin_mcp = { pid: originProc.pid, start: originStart };
  const OTHER_PANE = 'w4E:p2';

  const liveRun = seedPausedRun(f.home, root, {
    flow: 'q00000000000000f1', kind: 'blocker', reason: 'live origin pause', pane: MAIN_PANE, origin_mcp,
  });
  const fallbackTaskRun = seedPausedRun(f.home, root, {
    flow: 'q00000000000000f2', kind: 'blocker', reason: 'dead origin fallback via task source', pane: MAIN_PANE, origin_mcp,
  });
  const fallbackWatchRun = seedPausedRun(f.home, root, {
    flow: 'q00000000000000f3', kind: 'blocker', reason: 'dead origin fallback via workflowEvents', pane: MAIN_PANE, origin_mcp,
  });

  // Project-wide read/control visibility stays enabled for another main in the same project.
  assert.equal(runVisible(liveRun, OTHER_PANE, root), true);
  const snapshot = async () => ({ panes: [{ pane_id: MAIN_PANE, agent: 'claude', cwd: root },
    { pane_id: OTHER_PANE, agent: 'pi', cwd: root }], workerPanes: new Set() });
  const resolver = noticeResolver(f.home, process.env, snapshot);
  const read = async origin => (await resolver(origin, { pane: OTHER_PANE, cwd: root })).kind === 'pane';
  const watchEvents = () => workflowEvents(f.home, OTHER_PANE, false, root, false, read);
  assert.equal(await read(liveRun), false);
  assert.equal((await resolver(liveRun, { pane: MAIN_PANE, cwd: root })).kind, 'pane');

  // Prime second main's taskNoticeSource and scan workflowEvents while origin is alive -> claims nothing.
  const otherTaskSource = taskNoticeSource(f.home, OTHER_PANE, root);
  assert.deepEqual(await otherTaskSource(read), []);
  assert.deepEqual((await watchEvents()).lines, []);
  assert.deepEqual((await workflowEvents(f.home, null, false, root)).lines, []);
  for (const run of [liveRun, fallbackTaskRun, fallbackWatchRun]) {
    assert.equal(fs.existsSync(join(f.home, 'flows', run.flow, 'pause-0.noticed')), false, `other main must not claim ${run.flow}`);
  }

  // Origin pane claims its own pause notice (leave f2 and f3 unclaimed by simulating origin only claiming f1 via marker or direct scan).
  const originClaimed = await workflowEvents(f.home, MAIN_PANE, false, root);
  assert.equal(originClaimed.lines.length, 3);
  assert.ok(originClaimed.lines.some((line) => line.includes(liveRun.flow)));
  // Release f2 and f3 markers to test fallback after origin dies (as if origin died before claiming them).
  fs.rmSync(join(f.home, 'flows', fallbackTaskRun.flow, 'pause-0.noticed'), { force: true });
  fs.rmSync(join(f.home, 'flows', fallbackWatchRun.flow, 'pause-0.noticed'), { force: true });

  // While origin is still alive, second main still cannot claim f2 or f3.
  assert.deepEqual(await otherTaskSource(read), []);
  assert.deepEqual((await watchEvents()).lines, []);

  // Origin dies without touching flows/ mtime.
  const flowsDir = join(f.home, 'flows');
  const beforeStamp = fs.statSync(flowsDir, { bigint: true });
  originProc.kill('SIGKILL');
  await originExit;
  const afterStamp = fs.statSync(flowsDir, { bigint: true });
  assert.equal(afterStamp.mtimeNs, beforeStamp.mtimeNs);

  // Unrelated project main still does not claim.
  assert.deepEqual((await workflowEvents(f.home, OTHER_PANE, false, unrelated)).lines, []);
  assert.equal(fs.existsSync(join(f.home, 'flows', fallbackTaskRun.flow, 'pause-0.noticed')), false);

  // Second main in the same project now claims via project fallback (even through already-primed taskNoticeSource).
  // Claim f2 via workflowEvents first after confirming f3 stays unclaimed until taskNoticeSource runs, or verify both!
  const claimedByTaskSource = await otherTaskSource(read);
  assert.equal(claimedByTaskSource.length, 2);
  assert.ok(claimedByTaskSource.some((e) => e.line.includes(fallbackTaskRun.flow)));
  assert.ok(claimedByTaskSource.some((e) => e.line.includes(fallbackWatchRun.flow)));
  assert.equal(fs.existsSync(join(f.home, 'flows', fallbackTaskRun.flow, 'pause-0.noticed')), true);
  assert.equal(fs.existsSync(join(f.home, 'flows', fallbackWatchRun.flow, 'pause-0.noticed')), true);

  // Release f3 marker and verify workflowEvents fallback also delivers once.
  fs.rmSync(join(f.home, 'flows', fallbackWatchRun.flow, 'pause-0.noticed'), { force: true });
  const claimedByEvents = await watchEvents();
  assert.equal(claimedByEvents.lines.length, 1);
  assert.match(claimedByEvents.lines[0], new RegExp(`${fallbackWatchRun.flow}.*dead origin fallback via workflowEvents`));
  assert.deepEqual((await watchEvents()).lines, []);
});

test('batch resume on a task run and task expiry fall back to bound-origin delivery while origin MCP stays alive', { timeout: 60_000 }, async (t) => {
  // 1. Live MCP task run -> pause epoch 0 (reserved for task) -> batch resume (no task for epoch 1) -> pause epoch 1 delivers fallback while origin MCP is alive.
  const f = await setupWorkflowProject(t, { tickets: { '01-only.md': goodTicket(1) } });
  await f.stopMcp();
  const mcp = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-mcp.mjs')], {
    cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const mcpExit = once(mcp, 'exit');
  f.onCleanup(() => stopChild(mcp, mcpExit, { closeStdin: true }));
  const rl = createInterface({ input: mcp.stdout });
  const rpc = taskRpc((method, params) => new Promise((resolveRpc) => {
    const id = Math.floor(Math.random() * 1e9);
    const onLine = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === id) { rl.off('line', onLine); resolveRpc(msg); }
    };
    rl.on('line', onLine);
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  }));
  await rpc('server/discover');

  const started = await taskCall(rpc, 'hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root, handback_to: 'main' });
  assert.equal(started.resultType, 'task');
  const taskFlow = started.taskId;
  const pane = f.env.HERDR_PANE_ID;
  const [j1] = await f.jobs(taskFlow, 1);
  await f.settle(j1);
  await until(() => Boolean(f.flow(taskFlow).review_job), 15_000);
  const rev1 = f.flow(taskFlow).review_job;
  await f.settleReview(rev1);
  const pause0 = await f.end(taskFlow);
  assert.equal(pause0.state, 'paused');
  assert.equal(pause0.epoch, 0);
  assert.equal(fs.existsSync(queueTaskFile(f.home, taskFlow)), true, 'live epoch-0 task claim exists');

  // While epoch 0 has a live task, fallback sources reserve pause-0 for tasks/get.
  const originSource = taskNoticeSource(f.home, pane, f.root);
  assert.deepEqual(await originSource(), []);
  assert.deepEqual((await workflowEvents(f.home, pane, false, f.root)).lines, []);
  const get0 = await rpc('tasks/get', { taskId: taskFlow });
  assert.equal(get0.status, 'completed');
  assert.match(get0.result.content[0].text, /hand-back at accept/);
  assert.equal(fs.existsSync(join(f.home, 'flows', taskFlow, 'pause-0.noticed')), true);

  // Add a repair ticket and resume via batch hud_respond (returns no MCP task for epoch 1).
  resultValue(await taskCall(rpc, 'hud_tickets', {
    op: 'add', cwd: f.root, feature: 'sample',
    tickets: [{ title: 'Batch repair', blocked_by: [], what: 'Fix synthetic gap.', acceptance: ['Fixed'], live_try: 'none' }],
  }));
  const batchRes = resultValue(await taskCall(rpc, 'hud_respond', {
    answers: [{ job: taskFlow, answer: 'repair: batch resume' }],
  }));
  assert.equal(batchRes.answers[0].ok, true);
  assert.equal(batchRes.answers[0].resultType, undefined);
  assert.equal(fs.existsSync(queueTaskFile(f.home, taskFlow)), false, 'batch resume clears stale epoch-0 task claim');
  const staleTask = await rpc('tasks/get', { taskId: taskFlow });
  assert.equal(staleTask.status, 'failed');
  assert.match(staleTask.statusMessage, /Unknown or expired task/);

  const [, j2] = await f.jobs(taskFlow, 2);
  await f.settle(j2);
  await until(() => f.flow(taskFlow).review_job && f.flow(taskFlow).review_job !== rev1, 15_000);
  await f.settleReview(f.flow(taskFlow).review_job);
  const pause1 = await f.end(taskFlow);
  assert.equal(pause1.state, 'paused');
  assert.equal(pause1.epoch, 1);
  assert.ok(pause1.notices['pause-1']);

  // Origin MCP is still alive, yet epoch 1 has no live task -> bound-origin fallback delivers pause-1 (never suppressed).
  await originSource();
  await until(() => fs.existsSync(join(f.home, 'flows', taskFlow, 'pause-1.noticed')), 10_000);
  assert.equal(fs.existsSync(join(f.home, 'flows', taskFlow, 'pause-1.noticed')), true, 'pause-1 delivered via fallback');

  // 2. Task expiry while origin MCP stays alive: reserved before expiry, then watch-runtime + taskNoticeSource fall back at expiry.
  const wf = watchFixture(t);
  const root = join(dirname(wf.home), 'project-exp');
  fs.mkdirSync(root, { recursive: true });
  const herdr = await syntheticPromptHerdr(t, dirname(wf.home), { initialFail: false });
  const originProc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const originExit = once(originProc, 'exit');
  t.after(() => stopChild(originProc, originExit));
  const origin_mcp = { pid: originProc.pid, start: procStat(originProc.pid).start };
  const OTHER_PANE = 'w4E:p2';

  const watchExpired = seedPausedRun(wf.home, root, {
    flow: 'q00000000000001a1', kind: 'blocker', reason: 'expired task watch wake', task: true, pane: MAIN_PANE, origin_mcp,
  });
  const sourceExpired = seedPausedRun(wf.home, root, {
    flow: 'q00000000000001a2', kind: 'blocker', reason: 'expired task source wake', task: true, pane: MAIN_PANE, origin_mcp,
  });
  const soon = Date.now() + 450;
  claimQueueTask(wf.home, watchExpired, soon);
  claimQueueTask(wf.home, sourceExpired, soon);
  // Prime taskNoticeSource before expiry so we verify expiry works without changing flows/ mtime.
  const primedOrigin = taskNoticeSource(wf.home, MAIN_PANE, root);
  assert.deepEqual(await primedOrigin(), []);
  assert.deepEqual((await workflowEvents(wf.home, MAIN_PANE, false, root)).lines, []);

  // Start watch-runtime before expiry: must not type before expiry, then wakes at expiry and delivers g1 once.
  const preload = `process.env.HERDR_SOCKET_PATH = ${JSON.stringify(herdr.endpoint)};`;
  // Claim g2 temporarily via a live other-process marker only after priming? No, let watch-runtime deliver g1 and leave g2 without watch-runtime interference by giving g2 a different expiry.
  const later = Date.now() + 300;
  claimQueueTask(wf.home, watchExpired, soon);
  claimQueueTask(wf.home, sourceExpired, later);
  const watch = wf.start(preload);
  t.after(() => stopChild(watch.child, watch.exited));

  // Before expiry: nothing delivered yet.
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(herdr.delivered.length, 0, 'unexpired live task must suppress fallback typing');

  // After g2 expires: primed taskNoticeSource claims g2 (or watch delivers both); verify other pane still cannot claim while origin is live.
  await until(() => Date.now() > soon + 50, 2_000);
  assert.deepEqual((await workflowEvents(wf.home, OTHER_PANE, false, root)).lines, [], 'second main must not steal while origin is live');
  const fromSource = await primedOrigin();
  await until(() => herdr.delivered.length + fromSource.length >= 2, 8_000);
  const allTexts = [...herdr.delivered.map((d) => d.text), ...fromSource.map((e) => e.line)];
  assert.ok(allTexts.some((text) => text.includes(watchExpired.flow)), 'expired task g1 delivered to bound origin');
  assert.ok(allTexts.some((text) => text.includes(sourceExpired.flow)), 'expired task g2 delivered to bound origin');
  assert.equal(fs.existsSync(join(wf.home, 'flows', watchExpired.flow, 'pause-0.noticed')), true);
  assert.equal(fs.existsSync(join(wf.home, 'flows', sourceExpired.flow, 'pause-0.noticed')), true);
});

test('legacy typed sends distinguish sent/refused/indeterminate and watch --queue never repeats indeterminate delivery', { timeout: 25_000 }, async (t) => {
  const f = watchFixture(t);
  const root = join(dirname(f.home), 'project-legacy');
  const bin = join(f.home, 'fake-bin');
  const socketPath = join(dirname(f.home), 'legacy-prompt.sock');
  const modeFile = join(f.home, 'herdr-mode');
  const attemptsFile = join(f.home, 'prompt-attempts.log');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(modeFile, 'ok');

  const fake = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'pane' && args[1] === 'get') {
  console.log(JSON.stringify({ result: { pane: { agent: 'codex', agent_status: 'idle', agent_session: { value: '00000000-0000-4000-8000-000000000002' } } } }));
} else if (args[0] === 'pane' && args[1] === 'process-info') {
  console.log(JSON.stringify({ result: { process_info: { foreground_processes: [{ name: 'codex', pid: ${process.pid} }] } } }));
} else if (args[0] === 'queue') {
  console.log(JSON.stringify({ error: { code: 'no_rollout' } }));
  process.exit(1);
} else if (args[0] === 'agent' && args[1] === 'prompt') {
  const mode = fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8').trim();
  fs.appendFileSync(${JSON.stringify(attemptsFile)}, mode + ':' + args[3] + '\\n');
  if (mode === 'ok') process.exit(0);
  if (mode === 'refused_json') { console.log(JSON.stringify({ error: { code: 'agent_not_ready' } })); process.exit(1); }
  if (mode === 'refused_stderr') { console.error('Error: pane_not_found: missing'); process.exit(1); }
  if (mode === 'unknown_fail') { console.error('broken pipe after write'); process.exit(1); }
  if (mode === 'killed') { process.kill(process.pid, 'SIGKILL'); }
}
`;
  for (const name of ['herdr', 'codex']) fs.writeFileSync(join(bin, name), fake, { mode: 0o700 });

  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const lines = createInterface({ input: socket });
    lines.on('error', () => {});
    lines.on('line', (line) => {
      const { id, method } = JSON.parse(line);
      if (method === 'ping') socket.write(JSON.stringify({ id, result: { type: 'pong' } }) + '\n');
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    await once(server, 'close');
  });

  const env = {
    ...process.env,
    HOME: join(dirname(f.home), 'home'),
    HUD_HOME: f.home,
    HERDR_PANE_ID: MAIN_PANE,
    HERDR_SOCKET_PATH: socketPath,
    PATH: `${bin}:${process.env.PATH}`,
  };

  // 1. Direct notify() outcome classification on legacy prompt transport.
  fs.writeFileSync(modeFile, 'ok');
  const sentOk = await notify(MAIN_PANE, 'sent check', f.home, { queue: true, env });
  assert.equal(sentOk.outcome, 'sent');
  assert.equal(sentOk.outcome, 'sent');
  assert.equal(sentOk.uncertain, undefined);

  fs.writeFileSync(modeFile, 'refused_json');
  const refusedJson = await notify(MAIN_PANE, 'refused json', f.home, { queue: true, env });
  assert.equal(refusedJson.outcome, 'refused');
  assert.equal(refusedJson.outcome, 'refused');
  assert.equal(refusedJson.retry, true);
  assert.equal(refusedJson.uncertain, undefined);

  fs.writeFileSync(modeFile, 'refused_stderr');
  const refusedStderr = await notify(MAIN_PANE, 'refused stderr', f.home, { queue: true, env });
  assert.equal(refusedStderr.outcome, 'refused');
  assert.equal(refusedStderr.retry, true);

  fs.writeFileSync(modeFile, 'unknown_fail');
  const indeterminateFail = await notify(MAIN_PANE, 'unknown fail', f.home, { queue: true, env });
  assert.equal(indeterminateFail.outcome, 'indeterminate');
  assert.equal(indeterminateFail.outcome, 'indeterminate');
  assert.equal(indeterminateFail.uncertain, true);
  assert.equal(indeterminateFail.retry, false);

  fs.writeFileSync(modeFile, 'killed');
  const indeterminateKilled = await notify(MAIN_PANE, 'killed', f.home, { queue: true, env });
  assert.equal(indeterminateKilled.outcome, 'indeterminate');
  assert.equal(indeterminateKilled.uncertain, true);
  assert.equal(indeterminateKilled.retry, false);

  // 2. End-to-end watchCommand(['--queue']): refused releases & retries; indeterminate keeps marker & never repeats.
  const prevCwd = process.cwd();
  process.chdir(root);
  t.after(() => process.chdir(prevCwd));
  fs.rmSync(attemptsFile, { force: true });
  const readAttempts = () => fs.existsSync(attemptsFile) ? fs.readFileSync(attemptsFile, 'utf8').trim().split('\n').filter(Boolean) : [];

  fs.writeFileSync(modeFile, 'refused_json');
  const refusedFlow = seedPausedRun(f.home, root, {
    flow: 'q00000000000002a1', kind: 'blocker', reason: 'legacy refused pause',
  });
  const refusedMarker = join(f.home, 'flows', refusedFlow.flow, 'pause-0.noticed');
  const ac1 = new AbortController();
  t.after(() => ac1.abort());
  const run1 = watchCommand(['--queue'], { env, stdout: (s) => assert.fail(s), stderr: () => {} }, { signal: ac1.signal, rescanMs: 80 });
  await until(() => readAttempts().some((line) => line.includes(refusedFlow.flow)), 8_000);
  await until(() => !fs.existsSync(refusedMarker), 4_000);
  fs.writeFileSync(modeFile, 'ok');
  await until(() => readAttempts().some((line) => line.startsWith('ok:') && line.includes(refusedFlow.flow)), 8_000);
  assert.equal(fs.existsSync(refusedMarker), true);
  ac1.abort();
  assert.equal(await run1, 0);

  fs.writeFileSync(modeFile, 'unknown_fail');
  const indeterminateFlow = seedPausedRun(f.home, root, {
    flow: 'q00000000000002a2', kind: 'blocker', reason: 'legacy indeterminate pause',
  });
  const indeterminateMarker = join(f.home, 'flows', indeterminateFlow.flow, 'pause-0.noticed');
  const ac2 = new AbortController();
  t.after(() => ac2.abort());
  const run2 = watchCommand(['--queue'], { env, stdout: (s) => assert.fail(s), stderr: () => {} }, { signal: ac2.signal, rescanMs: 60 });
  await until(() => readAttempts().filter((line) => line.includes(indeterminateFlow.flow)).length === 1, 8_000);
  assert.equal(fs.existsSync(indeterminateMarker), true, 'indeterminate legacy send must keep its marker');
  fs.writeFileSync(modeFile, 'ok');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(readAttempts().filter((line) => line.includes(indeterminateFlow.flow)).length, 1, 'indeterminate legacy send must never repeat');
  ac2.abort();
  assert.equal(await run2, 0);
});

test('indeterminate codex queue outcome propagates without falling back to typing', { timeout: 20_000 }, async (t) => {
  // Pure classification checks across HerdrOutcome reasons, including timeout and lost.
  assert.equal(classifyCodexQueueOutcome({ ok: true, reason: 'ok', stdout: '', stderr: '', exitCode: 0 }).kind, 'sent');
  assert.equal(classifyCodexQueueOutcome({ ok: false, reason: 'unavailable', stdout: '', stderr: 'ENOENT', exitCode: null }).kind, 'refused');
  assert.equal(classifyCodexQueueOutcome({ ok: false, reason: 'failed', stdout: JSON.stringify({ error: { code: 'no_rollout' } }), stderr: '', exitCode: 1 }).kind, 'refused');
  assert.equal(classifyCodexQueueOutcome({ ok: false, reason: 'failed', stdout: '', stderr: 'no rollout found', exitCode: 1 }).kind, 'indeterminate');
  assert.equal(classifyCodexQueueOutcome({ ok: false, reason: 'failed', stdout: '', stderr: 'permission denied', exitCode: 1 }).kind, 'indeterminate');
  assert.equal(classifyCodexQueueOutcome({ ok: false, reason: 'failed', stdout: '', stderr: 'no such file or directory', exitCode: 1 }).kind, 'indeterminate');
  assert.equal(classifyCodexQueueOutcome({ ok: false, reason: 'failed', stdout: '', stderr: "error: unrecognized subcommand 'queue'", exitCode: 2 }).kind, 'refused');
  assert.equal(classifyCodexQueueOutcome({ ok: false, reason: 'timeout', stdout: '', stderr: '', exitCode: null }).kind, 'indeterminate');
  assert.equal(classifyCodexQueueOutcome({ ok: false, reason: 'lost', stdout: '', stderr: '', exitCode: null }).kind, 'indeterminate');
  assert.equal(classifyCodexQueueOutcome({ ok: false, reason: 'aborted', stdout: '', stderr: '', exitCode: null }).kind, 'indeterminate');
  assert.equal(classifyCodexQueueOutcome({ ok: false, reason: 'failed', stdout: '', stderr: 'broken pipe after write', exitCode: 1 }).kind, 'indeterminate');
  assert.equal(classifyCodexQueueOutcome({ ok: false, reason: 'failed', stdout: '', stderr: '', exitCode: 1 }).kind, 'indeterminate');

  // End-to-end notify(): indeterminate codex queue sends never invoke herdr typing; positive non-send still falls back.
  const f = watchFixture(t);
  const bin = join(f.home, 'codex-indeterminate-bin');
  const socketPath = join(dirname(f.home), 'codex-indeterminate.sock');
  const codexModeFile = join(f.home, 'codex-mode');
  const typedLog = join(f.home, 'typed.log');
  fs.mkdirSync(bin, { recursive: true });
  const fake = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'pane' && args[1] === 'get') {
  console.log(JSON.stringify({ result: { pane: { agent: 'codex', agent_status: 'idle', agent_session: { value: '00000000-0000-4000-8000-000000000009' } } } }));
} else if (args[0] === 'pane' && args[1] === 'process-info') {
  console.log(JSON.stringify({ result: { process_info: { foreground_processes: [{ name: 'codex', pid: ${process.pid} }] } } }));
} else if (args[0] === 'queue') {
  const mode = fs.readFileSync(${JSON.stringify(codexModeFile)}, 'utf8').trim();
  if (mode === 'lost') process.kill(process.pid, 'SIGKILL');
  if (mode === 'unknown_fail') { console.error('connection reset while reading reply'); process.exit(1); }
  if (mode === 'perm_denied') { console.error('permission denied'); process.exit(1); }
  if (mode === 'no_such_file') { console.error('no such file or directory'); process.exit(1); }
  if (mode === 'refused') { console.log(JSON.stringify({ error: { code: 'no_rollout' } })); process.exit(1); }
} else if (args[0] === 'agent' && args[1] === 'prompt') {
  fs.appendFileSync(${JSON.stringify(typedLog)}, args[3] + '\\n');
}
`;
  for (const name of ['herdr', 'codex']) fs.writeFileSync(join(bin, name), fake, { mode: 0o700 });
  const server = createServer((socket) => {
    socket.on('error', () => {});
    const lines = createInterface({ input: socket });
    lines.on('error', () => {});
    lines.on('line', (line) => {
      const { id, method } = JSON.parse(line);
      if (method === 'ping') socket.write(JSON.stringify({ id, result: { type: 'pong' } }) + '\n');
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  t.after(async () => { server.close(); await once(server, 'close'); });

  const env = {
    ...process.env,
    HOME: join(dirname(f.home), 'home'),
    HUD_HOME: f.home,
    HERDR_PANE_ID: MAIN_PANE,
    HERDR_SOCKET_PATH: socketPath,
    PATH: `${bin}:${process.env.PATH}`,
  };
  const readTyped = () => fs.existsSync(typedLog) ? fs.readFileSync(typedLog, 'utf8').trim().split('\n').filter(Boolean) : [];

  for (const mode of ['lost', 'unknown_fail', 'perm_denied', 'no_such_file']) {
    fs.writeFileSync(codexModeFile, mode);
    const res = await notify(MAIN_PANE, `indeterminate ${mode}`, f.home, { queue: true, env });
    assert.equal(res.outcome, 'indeterminate', mode);
    assert.equal(res.outcome, 'indeterminate', mode);
    assert.equal(res.uncertain, true, mode);
    assert.equal(res.retry, false, mode);
    assert.match(res.detail ?? '', /did not fall back to typing/);
  }
  assert.deepEqual(readTyped(), [], 'indeterminate codex queue sends must never fall back to typing');

  fs.writeFileSync(codexModeFile, 'refused');
  const fallback = await notify(MAIN_PANE, 'confirmed refusal', f.home, { queue: true, env });
  assert.equal(fallback.outcome, 'sent');
  assert.match(fallback.detail ?? '', /fell back to typing/);
  assert.deepEqual(readTyped(), ['confirmed refusal']);
});

test('stale caller task receipt cannot poll, cancel, or re-claim a newer epoch task owned by another caller', { timeout: 60_000 }, async (t) => {
  const f = await setupWorkflowProject(t, { tickets: { '01-only.md': goodTicket(1) } });
  await f.stopMcp();

  const spawnTaskMcp = (paneId) => {
    const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-mcp.mjs')], {
      cwd: f.root, env: { ...f.env, HERDR_PANE_ID: paneId }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const exited = once(child, 'exit');
    f.onCleanup(() => stopChild(child, exited, { closeStdin: true }));
    const rl = createInterface({ input: child.stdout });
    const rpc = taskRpc((method, params) => new Promise((resolveRpc) => {
      const id = Math.floor(Math.random() * 1e9);
      const onLine = (raw) => {
        const msg = JSON.parse(raw);
        if (msg.id === id) { rl.off('line', onLine); resolveRpc(msg); }
      };
      rl.on('line', onLine);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    }));
    return { child, exited, rpc };
  };

  // Caller A starts epoch-0 task and lets it pause at accept.
  const callerA = spawnTaskMcp('w4E:p1');
  await callerA.rpc('server/discover');
  const started = await taskCall(callerA.rpc, 'hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root, handback_to: 'main' });
  assert.equal(started.resultType, 'task');
  const flow = started.taskId;
  const [j1] = await f.jobs(flow, 1);
  await f.settle(j1);
  await until(() => Boolean(f.flow(flow).review_job), 15_000);
  await f.settleReview(f.flow(flow).review_job);
  const pause0 = await f.end(flow);
  assert.equal(pause0.state, 'paused');
  assert.equal(pause0.epoch, 0);

  // Add a repair ticket and have Caller B resume as an epoch-1 task (updating global task.json to epoch 1).
  resultValue(await taskCall(callerA.rpc, 'hud_tickets', {
    op: 'add', cwd: f.root, feature: 'sample',
    tickets: [{ title: 'Epoch 1 slice', blocked_by: [], what: 'Work in epoch 1.', acceptance: ['Done'], live_try: 'none' }],
  }));
  const callerB = spawnTaskMcp('w4E:p2');
  await callerB.rpc('server/discover');
  const resumedB = await taskCall(callerB.rpc, 'hud_respond', { job: flow, answer: 'repair: epoch 1' });
  assert.equal(resumedB.resultType, 'task');
  assert.equal(f.flow(flow).epoch, 1);
  const markerB = readQueueTask(f.home, flow);
  assert.equal(markerB?.epoch, 1);
  assert.equal(markerB?.pid, callerB.child.pid);

  // Caller A (still live, holding epoch-0 receipt) cannot poll or cancel Caller B's epoch-1 task.
  const pollLiveA = await callerA.rpc('tasks/get', { taskId: flow });
  assert.equal(pollLiveA.status, 'failed');
  assert.match(pollLiveA.statusMessage, /Unknown or expired task/);
  const cancelLiveA = await callerA.rpc('tasks/cancel', { taskId: flow });
  assert.equal(cancelLiveA.status, 'failed');
  assert.match(cancelLiveA.statusMessage, /Unknown or expired task/);
  assert.equal(f.flow(flow).state, 'working', 'stale caller cancel must not stop epoch-1 run');
  assert.equal(readQueueTask(f.home, flow)?.pid, callerB.child.pid, 'stale caller must not overwrite epoch-1 task marker');

  // Reconnected Caller A (same pane, recovering from disk receipt with epoch 0) also cannot poll or re-claim epoch 1.
  await stopChild(callerA.child, callerA.exited, { closeStdin: true });
  const callerA2 = spawnTaskMcp('w4E:p1');
  await callerA2.rpc('server/discover');
  const pollReconnectedA = await callerA2.rpc('tasks/get', { taskId: flow });
  assert.equal(pollReconnectedA.status, 'failed');
  assert.match(pollReconnectedA.statusMessage, /Unknown or expired task/);
  assert.equal(readQueueTask(f.home, flow)?.pid, callerB.child.pid, 'reconnected stale caller must not re-claim epoch-1 task marker');

  // Caller B (owning epoch-1 receipt) still polls its own task cleanly.
  const pollB = await callerB.rpc('tasks/get', { taskId: flow });
  assert.equal(pollB.status, 'working');
});
