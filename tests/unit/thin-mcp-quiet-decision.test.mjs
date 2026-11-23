import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { workInspectorRows } from '../../dist/render/work-inspector.js';
import { initialMonitorState } from '../../dist/render/monitor.js';
import { stripAnsi } from '../../dist/render/colors.js';
import { procStat } from '../../dist/mcp/cli-judge.js';
import {
  workerFor,
  cardText,
  fixture,
  resultValue,
  until,
  taskRpc,
  taskCall,
  taskJob,
  runSonic,
  sonicTask,
  fakeCliWithChild,
  statusQueries,
  readCloseQuit,
  reapAttempts,
  declareDone,
  writeCliRole,
  cliState,
  fakeDecisionServer,
  decisionAnswer,
  configureFakeDecision,
} from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

// The hold windows below exercise lifecycle behavior; this outer guard also covers
// starting two real sonic subprocesses, collecting them and settling the parent.
test('an open sonic child holds the real CLI supervisor; uncollected reports get one fixed prompt', { timeout: 45000 }, async (t) => {
  const f = await fixture(t);
  const task = sonicTask(f);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'sonic-parent-cli', 1, false);
  const server = await fakeDecisionServer(t, () => decisionAnswer('finished-no-report', 0.95));
  configureFakeDecision(f, server.baseUrl);
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  await f.startCliSocket();
  const handle = await taskCall(rpc, 'hud_create', { role: 'sonic-parent-cli', request_key: 'sonic-parent-cli', task: 'Synthetic CLI parent.' });
  const parent = taskJob(f, handle);
  parent.agent = `${parent.job}-primary`;
  await until(() => cliState(parent.task_dir)?.agent_session_id, 20000);
  const start = () => runSonic(f, 'start', parent.task_dir, '--task-file', task);
  const [child, alreadyCollected] = await Promise.all([start(), start()]);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(alreadyCollected.status, 0, alreadyCollected.stderr);
  const id = child.stdout.trim(), dir = join(f.env.HUD_HOME, 'jobs', id);
  const collectedId = alreadyCollected.stdout.trim();
  fs.writeFileSync(join(f.env.HUD_HOME, 'jobs', collectedId, 'release-sonic'), '');
  const report = await runSonic(f, 'wait', parent.task_dir, '--job', collectedId, '--timeout', '25');
  assert.equal(report.status, 0, report.stderr);
  const prompts = () => f.commands().filter(({ args }) => args[1] === 'prompt' && args[2] === parent.agent && args[3].startsWith('Collect these sonic reports'));
  f.push(parent.job, 'idle');
  // Two supervisor safety ticks span >= 30 s on the supervisor's accelerated clock (> 20 s grace).
  const idleQueries = statusQueries(f, parent);
  await until(() => statusQueries(f, parent) >= idleQueries + 2, 15000);
  assert.equal(server.requests.length, 0);
  assert.equal(cliState(parent.task_dir).state, 'working');

  writeFixtureFile(join(parent.task_dir, 'report.md'), 'Premature synthetic parent report.');
  // Two more safety ticks span >= 30 s on the supervisor's clock (> 10 s report stability window).
  const reportQueries = statusQueries(f, parent);
  await until(() => statusQueries(f, parent) >= reportQueries + 2, 15000);
  assert.equal(cliState(parent.task_dir).state, 'working');
  assert.equal(cliState(parent.task_dir).settled_at, null);
  assert.equal(readCloseQuit(f, parent), false);
  assert.equal(prompts().length, 0);

  fs.writeFileSync(join(dir, 'release-sonic'), '');
  await until(() => prompts().length === 1, 20000);
  // Real Herdr marks the agent working once prompted; manual-socket otherwise stays idle through hud_send/declareDone.
  f.push(parent.job, 'working');
  assert.ok(prompts()[0].args[3].includes(id));
  assert.ok(!prompts()[0].args[3].includes(collectedId));
  assert.equal((await rpc('tasks/get', { taskId: handle.taskId })).status, 'working');
  const next = await taskCall(rpc, 'hud_send', { job: parent.job, text: 'Synthetic caller turn after collection.' });
  assert.equal(next.resultType, 'complete');
  assert.equal(resultValue(next).sent, true);
  assert.equal((await rpc('tasks/get', { taskId: handle.taskId })).status, 'working');
  assert.equal(reapAttempts(f, parent), 0);
  writeFixtureFile(join(parent.task_dir, 'report.md'), 'Synthetic parent report after collect prompt.');
  declareDone(f, parent);
  f.push(parent.job, 'done');
  await until(() => cliState(parent.task_dir)?.state === 'closed', 20000);
  assert.equal((await rpc('tasks/get', { taskId: handle.taskId })).status, 'completed');
  assert.equal(prompts().length, 1, 'the same report is not prompted for again');
  assert.equal(server.requests.length, 0);
});

test('quiet without a report and an in-turn child makes no Decision API call and types no prompt', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const worker = fakeCliWithChild(t, f);
  writeCliRole(f, 'bg-cli', 0.25, false);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  fs.writeFileSync(join(f.env.HOME, 'write-on-report-prompt'), '');
  const server = await fakeDecisionServer(t, () => decisionAnswer('finished-no-report', 0.95));
  configureFakeDecision(f, server.baseUrl);
  const job = await f.call('hud_create', { role: 'bg-cli', request_key: 'bg-child', task: 'Synthetic bg child.' });
  await until(() => cliState(job.task_dir)?.agent_session_id && cliState(job.task_dir)?.pid === worker.pid, 15000);
  const childPid = await worker.start();
  const prompts = () => f.commands().filter((c) => c.args[1] === 'prompt' && String(c.args[3]).startsWith('Write your report to '));
  f.push(job.job, 'idle');
  const before = statusQueries(f, job);
  await until(() => statusQueries(f, job) >= before + 2, 15000);
  assert.equal(server.requests.length, 0);
  assert.equal(prompts().length, 0);
  assert.equal(cliState(job.task_dir).state, 'working');
  assert.equal(cliState(job.task_dir).quiet_decision, undefined);

  worker.stop();
  await until(() => !procStat(childPid) || procStat(childPid).state === 'Z', t.signal);
  await until(() => prompts().length === 1, 15000);
  assert.equal(server.requests.length, 1, 'the real quiet-decision path runs once the child is gone');
});

test('quiet decision discards a stale reply after working/done pushes during the API call', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'decision-race', 0.25);
  let job;
  const server = await fakeDecisionServer(t, async (_body, count, req) => {
    if (count === 1) {
      const cancelled = once(req.socket, 'close');
      f.push(job.job, 'working');
      // Start the second quiet period only after the supervisor cancels the first request.
      await cancelled;
      f.push(job.job, 'done');
      return decisionAnswer('finished-no-report', 0.95);
    }
    return decisionAnswer('needs-human', 0.95);
  });
  configureFakeDecision(f, server.baseUrl);
  job = await f.call('hud_create', { role: 'decision-race', request_key: 'decision-race', task: 'Synthetic decision race.' });
  await until(() => cliState(job.task_dir)?.agent_session_id, t.signal);
  f.push(job.job, 'done');
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator', 25000);
  assert.equal(server.requests.length, 2);
  assert.equal(f.commands().some((c) => String(c.args[3]).startsWith('Write your report to ')), false);
});

test('quiet decision still-working keeps waiting up to 3 questions then escalates, showing on card and Inspector', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'qd-wait', 1, false);
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  writeFixtureFile(
    join(f.env.HOME, 'pane-read'),
    Array.from({ length: 70 }, (_, i) => `line ${i + 1}: waiting on background build`).join('\n') + '\n'
  );
  const server = await fakeDecisionServer(t, () => decisionAnswer('still-working', 0.91));
  configureFakeDecision(f, server.baseUrl);
  const job = await f.call('hud_create', { role: 'qd-wait', request_key: 'qd-wait', task: 'Synthetic quiet wait.' });
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator', 12000);
  assert.equal(server.requests.length, 3);
  const sentBody = server.requests[0];
  const pageText = sentBody.input[0].content[1].data.page.text;
  assert.equal(pageText.split('\n').length, 60);
  assert.ok(pageText.startsWith('line 11:'));
  const facts = sentBody.input[0].content[2].data.facts;
  assert.equal(facts.background_child_alive, false);
  assert.equal(typeof facts.minutes_quiet, 'number');
  assert.equal(facts.job_state, 'working');
  const status = cliState(job.task_dir);
  assert.equal(status.quiet_decision.action, 'needs-human');
  assert.equal(status.quiet_decision.reason, 'max-questions');
  const calls = JSON.parse(fs.readFileSync(join(f.env.HUD_HOME, 'display/model-cache/decision-api/calls.json'), 'utf8'));
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.feature === 'quiet-job'));
  const worker = workerFor(f, job.job);
  assert.equal(worker.quietDecision.action, 'needs-human');
  assert.match(cardText(worker), /needs-human \(max questions\)/);
  const inspectText = workInspectorRows(worker, 80, Date.now()).map((r) => stripAnsi(r.text)).join('\n');
  assert.match(inspectText, /quiet\s+needs-human \(max questions\)/);
});

test('quiet decision finished-no-report sends fixed prompt once per job and settles; second never sends twice', { timeout: 45000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'qd-prompt', 1, false);
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  fs.writeFileSync(join(f.env.HOME, 'write-on-report-prompt'), '');
  const server = await fakeDecisionServer(t, () => decisionAnswer('finished-no-report', 0.93));
  configureFakeDecision(f, server.baseUrl);
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  await f.startCliSocket();
  const handle = await taskCall(rpc, 'hud_create', { role: 'qd-prompt', request_key: 'qd-prompt-1', task: 'Synthetic report prompt.' });
  const job = taskJob(f, handle);
  await until(() => fs.existsSync(join(job.task_dir, 'report.md')), 20000);
  declareDone(f, job);
  f.push(job.job, 'done');
  await until(() => cliState(job.task_dir)?.state === 'closed', 20000);
  const done = await rpc('tasks/get', { taskId: handle.taskId });
  assert.equal(done.status, 'completed');
  assert.match(done.result.content[0].text, /Summary: Synthetic report after prompt\./);
  const expectedPrompt = `Write your report to ${join(job.task_dir, 'report.md')} now; if work remains, finish it first.`;
  const prompts = f.commands().filter((c) => c.args[1] === 'prompt' && c.args[3]?.split('\n')[0] === expectedPrompt);
  assert.equal(prompts.length, 1);
  assert.equal(cliState(job.task_dir).quiet_decision.choice, 'finished-no-report');
  assert.equal(cliState(job.task_dir).quiet_decision.probability, 0.93);
  assert.equal(cliState(job.task_dir).quiet_decision.action, 'prompt-report');

  // Second finished-no-report in the same job must NOT send the prompt twice -> needs-human.
  const f2 = await fixture(t);
  writeCliRole(f2, 'qd-prompt2', 1, false);
  fs.writeFileSync(join(f2.env.HOME, 'missing-report'), '');
  const server2 = await fakeDecisionServer(t, () => decisionAnswer('finished-no-report', 0.94));
  configureFakeDecision(f2, server2.baseUrl);
  const job2 = await f2.call('hud_create', { role: 'qd-prompt2', request_key: 'qd-prompt-2', task: 'Synthetic no repeat.' });
  await until(() => cliState(job2.task_dir)?.state === 'waiting_orchestrator', 20000);
  const expectedPrompt2 = `Write your report to ${join(job2.task_dir, 'report.md')} now; if work remains, finish it first.`;
  const prompts2 = f2.commands().filter((c) => c.args[1] === 'prompt' && c.args[3]?.split('\n')[0] === expectedPrompt2);
  assert.equal(prompts2.length, 1);
  assert.equal(server2.requests.length, 2);
  const status2 = cliState(job2.task_dir);
  assert.equal(status2.quiet_decision.choice, 'finished-no-report');
  assert.equal(status2.quiet_decision.probability, 0.94);
  assert.equal(status2.quiet_decision.action, 'needs-human');
  const worker2 = workerFor(f2, job2.job);
  assert.match(cardText(worker2), /finished-no-report 94%/);
  const inspect2 = workInspectorRows(worker2, 110, Date.now()).map((r) => stripAnsi(r.text)).join('\n');
  assert.match(inspect2, /finished-no-report 94% → needs-human/);
});

test('quiet decision failed uses screen line and quota marks place exhausted', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'roles', 'qd-fail.json'),
    JSON.stringify({
      role: 'qd-fail',
      instructions: 'implementer',
      can_continue: false,
      idle_grace_s: 1,
      run: [
        { harness: 'cli', agent: 'grok', model: 'grok-4.7' },
        { harness: 'cli', agent: 'claude', model: 'opus-5.5' },
      ],
    })
  );
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  writeFixtureFile(join(f.env.HOME, 'pane-read'), 'working...\nError: 429 rate limit exceeded for grok-4.7\n> \n');
  const server = await fakeDecisionServer(t, () => decisionAnswer('failed', 0.96));
  configureFakeDecision(f, server.baseUrl);
  const job = await f.call('hud_create', { role: 'qd-fail', request_key: 'qd-fail', task: 'Synthetic quota fail.' });
  await until(() => cliState(job.task_dir)?.state === 'failed', t.signal);
  const status = cliState(job.task_dir);
  assert.match(status.exit_reason, /429 rate limit exceeded/);
  assert.match(status.exit_reason, /next dispatch will use cli\/claude \(opus-5\.5\)/);
  assert.equal(status.quiet_decision.choice, 'failed');
  assert.equal(status.quiet_decision.probability, 0.96);
  assert.equal(status.quiet_decision.action, 'fail');
  const exhausted = JSON.parse(fs.readFileSync(join(f.env.HUD_HOME, 'exhausted.json'), 'utf8'));
  assert.ok(exhausted.places['cli:grok:grok-4.7']);
  const worker = workerFor(f, job.job);
  assert.match(cardText(worker), /failed 96% → fail/);
});

test('quiet decision failed without quota regex falls back to needs-human without exhausting', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'qd-nonquota', 1, false);
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  writeFixtureFile(join(f.env.HOME, 'pane-read'), 'working...\nError: segmentation fault in worker\n> \n');
  const server = await fakeDecisionServer(t, () => decisionAnswer('failed', 0.95));
  configureFakeDecision(f, server.baseUrl);
  const job = await f.call('hud_create', { role: 'qd-nonquota', request_key: 'qd-nonquota', task: 'Synthetic non-quota error.' });
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator', t.signal);
  const status = cliState(job.task_dir);
  assert.equal(status.reason, 'quiet without a report; hud_send to continue or hud_close to stop');
  assert.equal(status.quiet_decision.choice, 'failed');
  assert.equal(status.quiet_decision.probability, 0.95);
  assert.equal(status.quiet_decision.action, 'needs-human');
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'exhausted.json')), false);
  assert.equal(f.commands().filter((c) => c.args[1] === 'prompt' && c.args[2] !== 'w4E:p1').length, 1);
});

test('low probability, cap reached, and provider error all fall back to needs-human without prompting worker', { timeout: 20000 }, async (t) => {
  // 1. Low probability (< 0.8)
  const fLow = await fixture(t);
  writeCliRole(fLow, 'qd-low', 1, false);
  fs.writeFileSync(join(fLow.env.HOME, 'missing-report'), '');
  const sLow = await fakeDecisionServer(t, () => decisionAnswer('finished-no-report', 0.79));
  configureFakeDecision(fLow, sLow.baseUrl);
  const jLow = await fLow.call('hud_create', { role: 'qd-low', request_key: 'qd-low', task: 'Synthetic low prob.' });
  await until(() => cliState(jLow.task_dir)?.state === 'waiting_orchestrator', t.signal);
  assert.equal(cliState(jLow.task_dir).quiet_decision.choice, 'finished-no-report');
  assert.equal(cliState(jLow.task_dir).quiet_decision.probability, 0.79);
  assert.equal(cliState(jLow.task_dir).quiet_decision.action, 'needs-human');
  assert.equal(fLow.commands().filter((c) => c.args[1] === 'prompt' && c.args[2] !== 'w4E:p1').length, 1);

  // 2. Cap reached
  const fCap = await fixture(t);
  writeCliRole(fCap, 'qd-cap', 1, false);
  fs.writeFileSync(join(fCap.env.HOME, 'missing-report'), '');
  const sCap = await fakeDecisionServer(t, () => decisionAnswer('finished-no-report', 0.95));
  configureFakeDecision(fCap, sCap.baseUrl, 1);
  const apiDir = join(fCap.env.HUD_HOME, 'display/model-cache/decision-api');
  fs.mkdirSync(apiDir, { recursive: true });
  writeFixtureFile(join(apiDir, 'calls.json'), JSON.stringify([{ at: Date.now(), feature: 'outcome' }]));
  const jCap = await fCap.call('hud_create', { role: 'qd-cap', request_key: 'qd-cap', task: 'Synthetic cap.' });
  await until(() => cliState(jCap.task_dir)?.state === 'waiting_orchestrator', t.signal);
  assert.equal(sCap.requests.length, 0);
  assert.equal(cliState(jCap.task_dir).quiet_decision.action, 'needs-human');
  assert.equal(cliState(jCap.task_dir).quiet_decision.reason, 'cap');
  assert.equal(fCap.commands().filter((c) => c.args[1] === 'prompt' && c.args[2] !== 'w4E:p1').length, 1);

  // 3. Provider error (HTTP 500)
  const fErr = await fixture(t);
  writeCliRole(fErr, 'qd-err', 1, false);
  fs.writeFileSync(join(fErr.env.HOME, 'missing-report'), '');
  const sErr = await fakeDecisionServer(t, () => ({ status: 500, body: { error: 'boom' } }));
  configureFakeDecision(fErr, sErr.baseUrl);
  const jErr = await fErr.call('hud_create', { role: 'qd-err', request_key: 'qd-err', task: 'Synthetic error.' });
  await until(() => cliState(jErr.task_dir)?.state === 'waiting_orchestrator', t.signal);
  assert.equal(sErr.requests.length, 1);
  assert.equal(cliState(jErr.task_dir).quiet_decision.action, 'needs-human');
  assert.equal(cliState(jErr.task_dir).quiet_decision.reason, 'error');
  assert.equal(fErr.commands().filter((c) => c.args[1] === 'prompt' && c.args[2] !== 'w4E:p1').length, 1);
});

test('failed prompt-report keeps waiting_orchestrator across turn wake', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'qd-prompt-fail', 1, false);
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  fs.writeFileSync(join(f.env.HOME, 'fail-report-prompt'), '');
  const server = await fakeDecisionServer(t, () => decisionAnswer('finished-no-report', 0.93));
  configureFakeDecision(f, server.baseUrl);
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  await f.startCliSocket();
  const handle = await taskCall(rpc, 'hud_create', { role: 'qd-prompt-fail', request_key: 'qd-prompt-fail', task: 'Synthetic failed report prompt.' });
  const job = taskJob(f, handle);
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator', t.signal);
  const attention = await rpc('tasks/get', { taskId: handle.taskId });
  assert.equal(attention.status, 'completed');
  assert.match(attention.result.content[0].text, /waiting_orchestrator — quiet without a report; .*Use hud_read\/hud_peek/);
  assert.deepEqual(await rpc('tasks/cancel', { taskId: handle.taskId }), attention);
  assert.equal(reapAttempts(f, job), 0);
  const status = cliState(job.task_dir);
  assert.equal(status.quiet_decision.action, 'needs-human');
  assert.equal(status.quiet_decision.reason, 'prompt-failed');
  const turn = JSON.parse(fs.readFileSync(join(job.task_dir, 'turn.json'), 'utf8'));
  assert.equal(turn.seq, 2);
  assert.equal(turn.report_prompt_sent, true);

  // After another completed status query, waiting_orchestrator still holds.
  const queries = statusQueries(f, job);
  await until(() => statusQueries(f, job) >= queries + 2, t.signal);
  assert.equal(cliState(job.task_dir).state, 'waiting_orchestrator');
  assert.equal(cliState(job.task_dir).quiet_decision.reason, 'prompt-failed');
  assert.equal(server.requests.length, 1);
  // The full diagnostics show why, not only the generic reason.
  const read = await f.call('hud_read', { job: job.job, mode: 'full' });
  assert.deepEqual([read.quiet_decision?.action, read.quiet_decision?.reason], ['needs-human', 'prompt-failed']);
});

test('reportPromptSent persists across supervisor restart via hud_send', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'qd-prompt-respawn', 1, true);
  const liveWorker = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { liveWorker.kill('SIGKILL'); } catch {} });
  writeFixtureFile(join(f.env.HOME, 'cli-pid'), String(liveWorker.pid));
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  const server = await fakeDecisionServer(t, () => decisionAnswer('finished-no-report', 0.93));
  configureFakeDecision(f, server.baseUrl);

  const job = await f.call('hud_create', { role: 'qd-prompt-respawn', request_key: 'qd-prompt-respawn', task: 'Synthetic respawn no repeat.' });
  const expectedPrompt = `Write your report to ${join(job.task_dir, 'report.md')} now; if work remains, finish it first.`;
  const prompts = () => f.commands().filter((c) => c.args[1] === 'prompt' && c.args[3]?.split('\n')[0] === expectedPrompt);
  await until(() => prompts().length === 1 && cliState(job.task_dir)?.supervisor_pid, t.signal);
  const oldSupPid = cliState(job.task_dir).supervisor_pid;
  assert.equal(JSON.parse(fs.readFileSync(join(job.task_dir, 'turn.json'), 'utf8')).report_prompt_sent, true);

  process.kill(oldSupPid, 'SIGKILL');
  await until(() => procStat(oldSupPid) === null, t.signal);
  const sent = await f.call('hud_send', { job: job.job, message_key: 'respawn-no-repeat', text: 'Continue after supervisor restart.' });
  assert.equal(sent.sent, true);
  await until(() => cliState(job.task_dir)?.supervisor_pid !== oldSupPid && cliState(job.task_dir)?.state === 'waiting_orchestrator', t.signal);

  assert.equal(prompts().length, 1);
  assert.ok(server.requests.length >= 2);
  assert.equal(server.requests.at(-1).input[0].content[2].data.facts.report_prompt_already_sent, true);
  assert.equal(cliState(job.task_dir).quiet_decision.action, 'needs-human');
});
