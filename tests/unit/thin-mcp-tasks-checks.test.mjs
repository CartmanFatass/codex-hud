import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { watchCommand } from '../../dist/cli/watch.js';
import { workInspectorRows } from '../../dist/render/work-inspector.js';
import { initialMonitorState } from '../../dist/render/monitor.js';
import { stripAnsi } from '../../dist/render/colors.js';
import { procStat, reportSignature } from '../../dist/mcp/cli-judge.js';
import { appendTry } from '../../dist/collectors/try-records.js';
import { appendPanelAction } from '../../dist/collectors/panel-actions.js';
import { writeReportMeta } from '../../dist/roles/report-meta.js';
import { workSummaryPath } from '../../dist/collectors/work-summary-snapshot.js';
import { stopChild } from '../helpers/process-cleanup.mjs';
import {
  workerFor,
  cardText,
  entry,
  fixture,
  rpcClient,
  workerClient,
  resultValue,
  until,
  tasksExtension,
  taskRpc,
  taskCall,
  taskJob,
  fakeCliWithChild,
  readCloseQuit,
  readCloseReaped,
  reapAttempts,
  cliToken,
  declareDone,
  publishPiGrace,
  publishLegacyPiGrace,
  fallbackRole,
  writeCliRole,
  cliState,
} from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { parserReport, parserProse, migrationReport, migrationProse } from '../helpers/report-summary-fixtures.mjs';

test('MCP tasks: discover, progress and report settlement without reading or closing', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const rpc = taskRpc(f.rpc);
  assert.deepEqual(await rpc('server/discover'), {
    resultType: 'complete', supportedVersions: ['2026-07-28'], ttlMs: 0, cacheScope: 'private',
    capabilities: { tools: { listChanged: true }, extensions: { [tasksExtension]: {} } },
  });
  const list = await rpc('tools/list');
  assert.equal(list.resultType, 'complete');
  assert.equal(list.ttlMs, 0);
  assert.equal(list.cacheScope, 'private');
  assert.equal(list.tools.some(({ name }) => name === 'hud_wait'), false);
  assert.deepEqual(list.tools.filter((tool) => tool.execution?.taskSupport === 'optional').map((tool) => tool.name).sort(),
    ['hud_create', 'hud_land', 'hud_respond', 'hud_send', 'hud_tickets']);
  const roster = resultValue(await taskCall(rpc, 'hud_roster'));
  assert.match(roster.hint, /task completions.*hud_read/);
  assert.equal(roster.watcher_alive, undefined);
  assert.equal(roster.changes, undefined);
  const task = await taskCall(rpc, 'hud_create', { role: 'imp', task: 'Synthetic task.' });
  const job = taskJob(f, task);
  assert.equal(task.pollIntervalMs, 5000);
  assert.equal(task.ttlMs, 3 * 60 * 60_000);
  assert.match(task.statusMessage, /task completions.*hud_read/);
  const get = () => rpc('tasks/get', { taskId: task.taskId });
  writeFixtureFile(join(job.task_dir, 'progress.jsonl'), JSON.stringify({ at: new Date().toISOString(), text: 'Synthetic milestone.' }) + '\n');
  assert.match((await get()).statusMessage, /Synthetic milestone\./);
  writeFixtureFile(join(job.task_dir, 'report.md'), migrationReport);
  const summaryText = 'Migration verified; the synthetic dry-run passed.';
  const files = Array.from({ length: 10 }, (_, i) => `src/migration-${i}.ts`);
  writeReportMeta(job.task_dir, reportSignature(job.task_dir), { summary: '«Migration»' + summaryText.slice(9), files });
  await publishPiGrace(t, job, undefined, false);
  const done = await get();
  assert.equal(done.resultType, 'complete');
  assert.equal(done.status, 'completed');
  const text = done.result.content[0].text;
  assert.deepEqual(text.split('\n'), [`${job.job} (imp) — idle_grace`,
    `Report: hud_read job=${job.job} (mode: "full" for the whole report)`, `Summary: ${summaryText}`]);
  assert.ok(text.length < 600);
  assert.deepEqual(await rpc('tasks/cancel', { taskId: task.taskId }), done);
  assert.equal(JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).read_at, undefined);
  assert.equal(f.commands().some(({ command }) => command === 'hud-reap'), false);
  const compact = resultValue(await taskCall(rpc, 'hud_read', { job: job.job }));
  assert.deepEqual(text.split('\n'), [`${compact.job} (${compact.role}) — ${compact.state}`,
    `Report: ${compact.digest.read_hint}`, `Summary: ${compact.digest.result}`]);
  assert.doesNotMatch(JSON.stringify(compact), /report\.md/);
  assert.equal(compact.report_meta, undefined);
  assert.equal(compact.report, undefined);
  const report = resultValue(await taskCall(rpc, 'hud_read', { job: job.job, mode: 'full' }));
  assert.ok(report.report.includes(migrationProse));
  assert.equal(report.report_path, join(job.task_dir, 'report.md'));
  assert.deepEqual(report.report_meta, { summary: summaryText, files });
  assert.equal(report.changes, undefined);
  const repeat = resultValue(await taskCall(rpc, 'hud_read', { job: job.job }));
  assert.equal(repeat.report_unchanged, true);
  assert.equal(repeat.report_meta, undefined);
  assert.deepEqual(resultValue(await taskCall(rpc, 'hud_read', { job: job.job, mode: 'full' })).report_meta, report.report_meta);
  writeFixtureFile(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'closed', exit_reason: 'closed after report read' }));
  const repair = taskJob(f, await taskCall(rpc, 'hud_send', { job: job.job, text: 'Synthetic repair.' }));
  assert.notEqual(repair.job, job.job);
  assert.equal(JSON.parse(fs.readFileSync(join(repair.task_dir, 'job.json'))).repair_of, job.job);
});

test('late Claude mod watch stands down new tasks, enables batch create, and stops main-pane typing', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t), rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  // Settle while the connection is using tasks, after its original changes baseline.
  const old = taskJob(f, await taskCall(rpc, 'hud_create', { role: 'imp', task: 'Synthetic old task.' }));
  await publishPiGrace(t, old);
  // Take the handover baseline after the watcher has closed the old job, not during idle_grace.
  await until(() => readCloseReaped(old), t.signal);
  appendPanelAction(f.env.HUD_HOME, { type: 'retry', job: old.job });
  const watch = spawn(process.execPath, [resolve('bin/hud'), 'watch', '--mod'], { cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  watch.stdout.setEncoding('utf8').on('data', (text) => { output += text; });
  const exited = once(watch, 'exit');
  t.after(() => stopChild(watch, exited));
  await until(() => fs.existsSync(join(f.env.HUD_HOME, 'watchers', `${f.env.HERDR_PANE_ID}.pid`)), t.signal);
  const roster = resultValue(await taskCall(rpc, 'hud_roster'));
  assert.equal(roster.watcher_alive, true);
  assert.match(roster.hint, /Claude mod owns event wake/);
  assert.equal(roster.changes, undefined);
  const batch = resultValue(await taskCall(rpc, 'hud_create', { jobs: [{ role: 'imp', task: 'Synthetic mod batch.' }] }));
  assert.equal(batch.changes, undefined);
  const [job] = batch.jobs;
  assert.match(job.job, /^j[0-9a-f]{16}$/);
  assert.equal(fs.existsSync(join(job.task_dir, 'mcp-task.json')), false);
  writeFixtureFile(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'waiting_orchestrator', reason: 'Synthetic input' }));
  appendPanelAction(f.env.HUD_HOME, { type: 'retry', job: job.job });
  await until(() => output.includes('Synthetic input') && output.includes(`[${job.job}] Retry requested from panel`), t.signal);
  assert.equal(f.commands().some(c => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'prompt' && c.args[2] === f.env.HERDR_PANE_ID && c.args[3].includes(job.job)), false);
  assert.equal(resultValue(await taskCall(rpc, 'hud_roster')).changes, undefined);
  watch.kill('SIGKILL'); await exited;
  appendPanelAction(f.env.HUD_HOME, { type: 'land', root: f.root, slices: ['AFTER'] });
  const fallback = resultValue(await taskCall(rpc, 'hud_roster'));
  assert.equal(fallback.watcher_alive, false);
  assert.ok(fallback.changes[0].startsWith(`${job.job} imp: waiting_orchestrator | Synthetic input`));
  assert.deepEqual(fallback.changes.slice(1), [`[${job.job}] Retry requested from panel`, `Land requested from panel: ${f.root.split('/').at(-1)}: AFTER`]);
  assert.equal(resultValue(await taskCall(rpc, 'hud_roster')).changes, undefined);
  assert.ok((await rpc('tools/list')).tools.some(tool => tool.name === 'hud_wait'));
});

test('mod-negotiated connection with no live watcher exposes hud_wait and per-call changes', async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [entry], { cwd: f.root, env: { ...f.env, HUD_CLAUDE_MOD: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  t.after(async () => { child.stdin.end(); await exited; });
  const rpc = taskRpc(rpcClient(child));
  await rpc('server/discover');
  const list = await rpc('tools/list');
  assert.ok(list.tools.some(tool => tool.name === 'hud_wait'));
  assert.ok(list.tools.every(tool => !tool.execution));
  appendPanelAction(f.env.HUD_HOME, { type: 'land', root: f.root, slices: ['ONE'] });
  const roster = resultValue(await taskCall(rpc, 'hud_roster'));
  assert.equal(roster.watcher_alive, false);
  assert.match(roster.changes.join('\n'), /Land requested from panel: .*ONE/);
});

test('MCP tasks: scoped panel decisions wake the pane without a worker task; a reconnect collects offline intents once', async (t) => {
  const f = await fixture(t), rpc = taskRpc(f.rpc), home = f.env.HUD_HOME;
  const job = 'j1234567890abcdef', other = 'j1234567890abcdee';
  for (const [id, pane] of [[job, f.env.HERDR_PANE_ID], [other, 'other:p1']]) {
    const dir = join(home, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job: id, herdr_pane: pane, cwd: f.root,
      role: 'imp', created_at: new Date().toISOString(), dispatch_exit_code: 1 }));
  }
  await rpc('server/discover');
  appendTry(home, f.root, 'accept', { milestone: 'M1', slices: [{ id: 'ONE' }] });
  appendPanelAction(home, { type: 'retry', job });
  appendPanelAction(home, { type: 'retry', job: other });
  appendPanelAction(home, { type: 'land', root: join(f.root, 'elsewhere'), slices: ['FOREIGN'] });
  appendPanelAction(home, { type: 'answer', job, role: 'imp', qid: 'q1', answer: 'keep it' });
  const messages = () => f.commands().filter(c => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'prompt').flatMap(c => c.args[3].split('\n'));
  await until(() => messages().length >= 3, t.signal);
  assert.deepEqual(messages(), [`try accepted ${f.root.split('/').at(-1)} M1: ONE`, `[${job}] Retry requested from panel`, `[imp@${job}] ANSWERED q1 from panel: keep it`]);
  // End this connection's task mode. A fresh server in the same pane resumes the saved position.
  await rpc('initialize');
  appendPanelAction(home, { type: 'land', root: f.root, slices: ['ONE'] });
  fs.writeFileSync(join(f.env.HOME, 'fail-prompt'), '');
  const child = spawn(process.execPath, [entry], { cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  t.after(async () => { child.stdin.end(); await exited; });
  const next = taskRpc(rpcClient(child));
  await next('server/discover');
  const roster = async () => resultValue(await taskCall(next, 'hud_roster'));
  assert.deepEqual((await roster()).changes, [`Land requested from panel: ${f.root.split('/').at(-1)}: ONE`]);
  assert.equal((await roster()).changes, undefined);
});

test('MCP tasks: launch fall-through and effective effort stay in the dispatch and read, not the final notice', async (t) => {
  const f = await fixture(t);
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  fallbackRole(f, 'general');
  fs.writeFileSync(join(f.env.HOME, 'fail-start-grok'), 'Synthetic start failure');
  fs.writeFileSync(join(f.env.HOME, 'pi-model-caps.json'), JSON.stringify({
    'synthetic/second': { provider: 'synthetic', id: 'second', reasoning: false },
  }));
  const task = await taskCall(rpc, 'hud_create', { role: 'general', task: 'Synthetic fallback.', thinking: 'high' });
  const job = taskJob(f, task);
  const launch = /used_place: pi \(synthetic\/second\); thinking: off; attempts: cli\/grok \(synthetic-first\) \(invalid_request: Synthetic start failure\) → pi \(synthetic\/second\)/;
  assert.match(task.statusMessage, launch);
  await publishPiGrace(t, job);
  const done = await rpc('tasks/get', { taskId: task.taskId });
  assert.equal(done.status, 'completed');
  assert.doesNotMatch(done.result.content[0].text, /Launch:|used_place:|attempts:/);
  const read = resultValue(await taskCall(rpc, 'hud_read', { job: job.job, detail: true }));
  assert.equal(read.used_place, 'pi (synthetic/second)');
  assert.equal(read.thinking, 'off');
  assert.equal(read.attempts.length, 2);
});

test('MCP tasks: a question completes the task; an answer starts another task', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const task = await taskCall(rpc, 'hud_create', { role: 'imp', task: 'Synthetic question job.', checks: ['true'] });
  const job = taskJob(f, task);
  const worker = workerClient(t, f, job.task_dir, '0');
  assert.match((await worker('hud_ask', { question: 'Which synthetic option?', default: 'A', options: ['A', 'B'] })).content[0].text,
    /delivered by MCP task/);
  assert.equal(f.commands().some(({ args }) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'w4E:p1'), false);
  const question = await rpc('tasks/get', { taskId: task.taskId });
  assert.equal(question.status, 'completed');
  assert.match(question.result.content[0].text, /Question q1: Which synthetic option\?/);
  const next = await taskCall(rpc, 'hud_respond', { job: job.job, request_id: 'q1', answer: 'B' });
  assert.equal(taskJob(f, next).job, job.job);
  assert.notEqual(next.taskId, task.taskId);
  assert.equal(fs.readFileSync(join(job.task_dir, 'qa/q1.answer.md'), 'utf8'), 'B');
  assert.deepEqual(await rpc('tasks/cancel', { taskId: task.taskId }), question);
  assert.equal((await rpc('tasks/get', { taskId: next.taskId })).status, 'working');
  await publishPiGrace(t, job);
  await until(() => checkReceipt(job)?.state === 'done', 20000);
  const result = await rpc('tasks/get', { taskId: next.taskId });
  assert.equal(result.status, 'completed');
  assert.match(result.result.content[0].text, /Checks: 1\/1 passed$/);
});

test('MCP tasks: fan-out sends keep the create task through report settlement', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');
  const task = await taskCall(rpc, 'hud_create', { role: 'imp', task: 'Synthetic fan-out job.' });
  const job = taskJob(f, task);
  const get = () => rpc('tasks/get', { taskId: task.taskId });

  const failPrompt = join(f.env.HOME, 'fail-prompt');
  fs.writeFileSync(failPrompt, '');
  const failed = await taskCall(rpc, 'hud_send', { jobs: [job.job], text: 'Synthetic refused fan-out.' });
  assert.deepEqual(resultValue(failed).skipped, [{ job: job.job, reason: 'send_failed' }]);
  assert.equal((await get()).status, 'working');
  fs.unlinkSync(failPrompt);

  const sent = await taskCall(rpc, 'hud_send', { jobs: [job.job], text: 'Synthetic queued fan-out.' });
  assert.equal(sent.resultType, 'complete');
  assert.deepEqual(resultValue(sent).sent, [job.job]);
  assert.equal((await get()).status, 'working');

  writeFixtureFile(join(job.task_dir, 'report.md'), 'Original synthetic report.');
  writeReportMeta(job.task_dir, reportSignature(job.task_dir), { summary: 'Stale synthetic summary.', files: ['stale.ts'] });
  writeFixtureFile(join(job.task_dir, 'report.md'), parserReport);
  await publishPiGrace(t, job, undefined, false);
  const done = await get();
  assert.equal(done.status, 'completed');
  assert.ok(done.result.content[0].text.includes(`Report: hud_read job=${job.job}`));
  assert.doesNotMatch(done.result.content[0].text, /report\.md/);
  assert.equal(done.result.content[0].text.split('\n')[2], `Summary: ${parserProse}`);
  assert.doesNotMatch(done.result.content[0].text, /Stale synthetic summary|stale\.ts/);
  const read = resultValue(await taskCall(rpc, 'hud_read', { job: job.job }));
  assert.equal(read.digest.result, parserProse);
  assert.equal(read.report_meta, undefined);
});

test('MCP tasks: cancel fences stale tasks and reaps live tasks once even with duplicate requests', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const task = await taskCall(rpc, 'hud_create', { role: 'imp', task: 'Synthetic cancel job.' });
  const job = taskJob(f, task);
  const fanOut = await taskCall(rpc, 'hud_send', { jobs: [job.job], text: 'Synthetic fan-out.' });
  assert.equal(fanOut.resultType, 'complete');
  assert.deepEqual(resultValue(fanOut).sent, [job.job]);
  const send = await taskCall(rpc, 'hud_send', { job: job.job, text: 'Synthetic new turn.' });
  assert.equal(send.resultType, 'complete');
  assert.equal(resultValue(send).sent, true);
  assert.equal((await rpc('tasks/get', { taskId: task.taskId })).status, 'working');
  const reaps = () => f.commands().filter(({ command }) => command === 'hud-reap');
  assert.equal(reaps().length, 0);
  const params = { taskId: task.taskId };
  const [first, duplicate] = await Promise.all([rpc('tasks/cancel', params), rpc('tasks/cancel', params)]);
  assert.equal(first.status, 'cancelled');
  assert.deepEqual(first, duplicate);
  assert.deepEqual(first, await rpc('tasks/get', params));
  const launch = /^LAUNCH_ID=(.+)$/m.exec(fs.readFileSync(join(job.task_dir, 'SESSION.txt'), 'utf8'))?.[1];
  assert.ok(launch);
  assert.deepEqual(reaps().map(({ args }) => args), [[job.task_dir, '--launch', launch]]);
  assert.ok(fs.existsSync(join(job.task_dir, 'STATUS.json.stop-requested')));
});

test('MCP tasks: follow-up sends and live hud_respond carry on one task and extend TTL', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');
  const task = await taskCall(rpc, 'hud_create', { role: 'imp', task: 'Synthetic chained follow-ups.' });
  const job = taskJob(f, task);
  const get = () => rpc('tasks/get', { taskId: task.taskId });
  const marker = () => JSON.parse(fs.readFileSync(join(job.task_dir, 'mcp-task.json'), 'utf8'));
  const initialExpires = marker().expires;
  const stamp = Date.now();
  await until(() => Date.now() > stamp, t.signal);

  const first = await taskCall(rpc, 'hud_send', { job: job.job, text: 'Synthetic follow-up one.' });
  assert.equal(first.resultType, 'complete');
  assert.equal(resultValue(first).sent, true);
  assert.equal(resultValue(first).queued, true);
  assert.ok(marker().expires > initialExpires, 'follow-up extends task marker TTL');
  const afterFirst = await get();
  assert.equal(afterFirst.status, 'working');
  assert.ok(afterFirst.ttlMs >= task.ttlMs);

  const failPrompt = join(f.env.HOME, 'fail-prompt');
  fs.writeFileSync(failPrompt, '');
  const failed = await taskCall(rpc, 'hud_send', { job: job.job, text: 'Synthetic refused follow-up.' });
  assert.equal(failed.resultType, 'complete');
  assert.equal(resultValue(failed).code, 'send_failed');
  assert.equal((await get()).status, 'working', 'refused send does not fail the live task');
  fs.unlinkSync(failPrompt);

  const second = await taskCall(rpc, 'hud_send', { job: job.job, text: 'Synthetic follow-up two.' });
  assert.equal(second.resultType, 'complete');
  assert.equal(resultValue(second).sent, true);
  const batchMsg = await taskCall(rpc, 'hud_send', { messages: [{ job: job.job, text: 'Synthetic batch follow-up.' }] });
  assert.equal(batchMsg.resultType, 'complete');
  assert.equal(resultValue(batchMsg).messages[0].sent, true);
  assert.equal((await get()).status, 'working');

  // An unanswered question answered while the task is still live continues the same task.
  writeFixtureFile(join(job.task_dir, 'qa', 'q1.md'), 'Synthetic live question?');
  writeFixtureFile(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'waiting_orchestrator', reason: 'question open' }));
  const resp = await taskCall(rpc, 'hud_respond', { job: job.job, request_id: 'q1', answer: 'Keep going.' });
  assert.equal(resp.resultType, 'complete');
  assert.deepEqual(resultValue(resp), { ok: true, written: true });
  assert.equal((await get()).status, 'working');

  writeFixtureFile(join(job.task_dir, 'report.md'), parserReport);
  writeReportMeta(job.task_dir, reportSignature(job.task_dir), { summary: 'Latest turn synthetic summary.', files: ['src/parser.ts'] });
  await publishPiGrace(t, job, undefined, false);
  const done = await get();
  assert.equal(done.status, 'completed');
  assert.match(done.result.content[0].text, /Summary: Latest turn synthetic summary\./);
});

test('MCP tasks: pane change or repair job ends old task cleanly naming the successor without reaping', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');

  // 1. Pane changed before a send: old task ends as cancelled naming the new pane; cancel does not reap.
  const movedTask = await taskCall(rpc, 'hud_create', { role: 'imp', task: 'Synthetic moved pane job.' });
  const movedJob = taskJob(f, movedTask);
  const receiptPath = join(movedJob.task_dir, 'job.json');
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  receipt.herdr_pane = 'w4E:p9';
  writeFixtureFile(receiptPath, JSON.stringify(receipt, null, 2));
  const afterMove = await taskCall(rpc, 'hud_send', { job: movedJob.job, text: 'Synthetic send after pane move.' });
  assert.equal(afterMove.resultType, 'task');
  assert.notEqual(afterMove.taskId, movedTask.taskId);
  const movedOld = await rpc('tasks/cancel', { taskId: movedTask.taskId });
  assert.equal(movedOld.status, 'cancelled');
  assert.match(movedOld.statusMessage, /moved to pane w4E:p9/);
  assert.doesNotMatch(movedOld.statusMessage, /failed/i);
  assert.equal(reapAttempts(f, movedJob), 0);

  // 2. Repair job created while old task is still live: old task ends as cancelled naming the repair successor.
  const origTask = await taskCall(rpc, 'hud_create', { role: 'imp', task: 'Synthetic repair source job.' });
  const origJob = taskJob(f, origTask);
  writeFixtureFile(join(origJob.task_dir, 'report.md'), 'Synthetic first report.');
  writeFixtureFile(join(origJob.task_dir, 'STATUS.json'), JSON.stringify({ state: 'closed', exit_reason: 'closed after report read' }));
  const repairTask = await taskCall(rpc, 'hud_send', { job: origJob.job, text: 'Synthetic repair follow-up.' });
  assert.equal(repairTask.resultType, 'task');
  const repairJob = taskJob(f, repairTask);
  assert.notEqual(repairJob.job, origJob.job);
  assert.equal(repairTask.continued_as, repairJob.job);
  const reapsBefore = reapAttempts(f, origJob);
  const origOld = await rpc('tasks/cancel', { taskId: origTask.taskId });
  assert.equal(origOld.status, 'cancelled');
  assert.match(origOld.statusMessage, new RegExp(`continued as repair job ${repairJob.job}`));
  assert.doesNotMatch(origOld.statusMessage, /failed/i);
  assert.equal(reapAttempts(f, origJob), reapsBefore);
  assert.equal(fs.existsSync(join(origJob.task_dir, 'STATUS.json.stop-requested')), false);
  assert.equal(reapAttempts(f, repairJob), 0);
});

test('MCP tasks: a fresh server can poll but cannot cancel old tasks; legacy and failed dispatches stay immediate', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  await f.rpc('initialize', { protocolVersion: '2025-11-25' });
  const { result: legacy } = await f.rpc('tools/list');
  assert.equal(legacy.resultType, undefined);
  assert.ok(legacy.tools.some(({ name }) => name === 'hud_wait'));
  const old = await f.call('hud_create', { role: 'imp', task: 'Synthetic legacy job.' });
  assert.equal(old.watcher_alive, false);
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const task = await taskCall(rpc, 'hud_create', { role: 'imp', task: 'Synthetic task before restart.' });
  const job = taskJob(f, task);
  const child = spawn(process.execPath, [entry], { cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  f.onCleanup(async () => {
    const { forced, result } = await stopChild(child, exited, {
      closeStdin: true,
      graceMs: t.signal?.aborted ? 200 : 1500,
      killMs: 400,
    });
    if (!forced && !t.signal?.aborted) assert.deepEqual(result, [0, null]);
  });
  const next = taskRpc(rpcClient(child));
  await next('server/discover');
  const recovered = await next('tasks/get', { taskId: task.taskId });
  assert.equal(recovered.resultType, 'complete');
  assert.equal(recovered.status, 'working');
  assert.equal((await next('tasks/cancel', { taskId: task.taskId })).status, 'failed');
  assert.equal(fs.existsSync(join(job.task_dir, 'STATUS.json.stop-requested')), false);
  const retry = await taskCall(next, 'hud_create', { role: 'imp', task: 'Synthetic legacy job.' });
  assert.equal(retry.resultType, 'complete');
  assert.equal(resultValue(retry).job, old.job);
  fs.writeFileSync(join(f.env.HOME, 'fail-start'), 'Synthetic startup failure.');
  const failure = await taskCall(next, 'hud_create', { role: 'general', on: 'pi', task: 'Synthetic failure.' });
  assert.equal(failure.resultType, 'complete');
  assert.equal(resultValue(failure).ok, false);
});

const checkFile = (job) => join(job.task_dir, 'checks.json');
const checkReceipt = (job) => fs.existsSync(checkFile(job)) ? JSON.parse(fs.readFileSync(checkFile(job), 'utf8')) : null;

test('HUD checks: CLI declaration starts ordered checks and announces results after the worker closes', { timeout: 30000 }, async (t) => {
  const f = await fixture(t, true, '', 200);
  const worker = fakeCliWithChild(t, f);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'hud-check-cli', 15, false);
  await f.startCliSocket();
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const task = await taskCall(rpc, 'hud_create', { role: 'hud-check-cli', task: 'Synthetic check job.', checks: [
    'echo "$BASHPID" > check-shell; for ((i=0; i<300; i++)); do [[ -f release-check ]] && break; sleep .05; done; test -f release-check',
    'test -f check-shell || exit 9; printf "%4096s failure tail" x >&2; exit 7',
  ] });
  const job = taskJob(f, task), get = () => rpc('tasks/get', { taskId: task.taskId });
  const dir = job.task_dir, pidFile = join(f.env.HUD_HOME, 'watch.pid');
  fs.writeFileSync(join(dir, 'reap-worker'), '');
  const lines = [], ac = new AbortController();
  const watching = watchCommand([], { env: f.env, stdout: (s) => lines.push(...s.trim().split('\n')), stderr: () => {} },
    { signal: ac.signal, rescanMs: 100, settlementWindowMs: 250 });
  try {
    const summary = workSummaryPath(f.env.HUD_HOME);
    const published = () => fs.existsSync(summary) && JSON.parse(fs.readFileSync(summary)).producer === 'hud-watch';
    await until(() => cliState(dir)?.pid === worker.pid && published(), t.signal);
    fs.rmSync(summary, { force: true });
    writeFixtureFile(join(dir, 'report.md'), 'Synthetic report without a declaration yet.\n');
    await until(published, t.signal);
    assert.equal(checkReceipt(job), null);
    declareDone(f, job);
    f.push(job.job, 'done');
    await until(() => checkReceipt(job)?.state === 'running' && fs.existsSync(join(f.root, 'check-shell')), t.signal);
    const { pid: helper } = checkReceipt(job);
    const shell = Number(fs.readFileSync(join(f.root, 'check-shell'), 'utf8'));
    const watchPid = Number(fs.readFileSync(pidFile, 'utf8'));
    await until(() => lines.some((line) => line.includes('closed') && line.includes('report')), t.signal);
    assert.ok(procStat(watchPid) && procStat(helper));
    await until(() => readCloseReaped(job) && (!procStat(worker.pid) || procStat(worker.pid)?.state === 'Z'), t.signal);
    assert.equal(reapAttempts(f, job), 1);
    assert.equal(readCloseQuit(f, job), false);
    const held = await get();
    assert.equal(held.status, 'working');
    assert.equal(held.result, undefined);
    assert.equal((await f.call('hud_read', { job: job.job })).checks.state, 'running');
    assert.match(cardText(workerFor(f, job.job)), /\[↻0\/2\]/);
    writeFixtureFile(join(f.root, 'release-check'), '');
    await until(() => checkReceipt(job)?.state === 'done' && !fs.existsSync(pidFile), t.signal);
    const done = await get();
    assert.equal(done.status, 'completed');
    const text = done.result.content[0].text;
    assert.match(text, /Checks: 1\/2 passed$/);
    assert.ok(text.length < 600);
    assert.deepEqual(await get(), done, 'later polls return the same terminal result');
    const receipt = checkReceipt(job);
    assert.equal(receipt.turn, cliToken(dir));
    assert.equal(receipt.report_sig, reportSignature(dir));
    assert.equal(fs.statSync(checkFile(job)).mode & 0o777, 0o600);
    assert.deepEqual(receipt.results.map((r) => r.exit_code), [0, 7]);
    assert.ok(receipt.results.every((r) => r.duration_ms >= 0 && Buffer.byteLength(r.output_tail) <= 2048));
    const compact = await f.call('hud_read', { job: job.job });
    assert.match(compact.checks.results[0], /^pass: /);
    assert.match(compact.checks.results[1], /^fail: /);
    const read = await f.call('hud_read', { job: job.job, mode: 'full' });
    assert.equal(read.state, 'closed', 'the failing check does not fail the job');
    assert.equal(read.checks.stale, false);
    assert.deepEqual(read.checks.results.map((r) => r.passed), [true, false]);
    assert.equal(read.checks.results[0].output_tail, undefined);
    assert.match(read.checks.results[1].output_tail, /failure tail$/);
    assert.match(cardText(workerFor(f, job.job)), /\[✗1\/2\]/);
    assert.match(workInspectorRows(workerFor(f, job.job), 56, Date.now()).map((r) => stripAnsi(r.text)).join('\n'), /\[✗1\/2\]/);
    await until(() => lines.some((line) => line.endsWith(' | checks 1/2')), t.signal);
    assert.equal(lines.filter((line) => line.includes(' | checks ')).length, 1);
    assert.equal(reapAttempts(f, job), 1);
    assert.ok([helper, shell, watchPid, worker.pid].every((pid) => !procStat(pid) || procStat(pid)?.state === 'Z'));
  } finally {
    writeFixtureFile(join(f.root, 'release-check'), '');
    ac.abort(); await watching;
  }
});

test('HUD checks: Pi continuation and report rewrite make results stale; a running check does not block repair', { timeout: 14000 }, async (t) => {
  const f = await fixture(t, true, '', 200);
  await f.startCliSocket();
  const checks = ['echo ran >> check-count; if [[ -f hold-check ]]; then while [[ ! -f release-check ]]; do sleep .05; done; fi'];
  const job = await f.call('hud_create', { role: 'imp', task: 'Synthetic checks and repair.', checks });
  assert.equal(checkReceipt(job), null);
  await publishLegacyPiGrace(t, job);
  await until(() => checkReceipt(job)?.state === 'done', t.signal);
  const previous = checkReceipt(job);
  assert.equal(previous.report_sig, reportSignature(job.task_dir));
  assert.equal((await f.call('hud_send', { job: job.job, text: 'Synthetic continuation.' })).sent, true);
  assert.equal((await f.call('hud_read', { job: job.job })).checks.stale, true);
  assert.equal(checkReceipt(job).turn, previous.turn);
  const oldRead = Date.now();
  // Keep the synthetic report newer than the previous report's read receipt, even on coarse file clocks.
  await until(() => Date.now() > oldRead + 5, t.signal);
  await publishPiGrace(t, job);
  await until(() => checkReceipt(job)?.state === 'done' && checkReceipt(job).turn !== previous.turn, t.signal);
  const next = checkReceipt(job);
  assert.notEqual(next.report_sig, previous.report_sig);
  assert.equal(readCloseReaped(job), undefined);
  const report = join(job.task_dir, 'report.md');
  writeFixtureFile(report, 'Synthetic rewritten Pi report.\n');
  await until(() => Date.now() > fs.statSync(report).mtimeMs, t.signal);
  assert.equal((await f.call('hud_read', { job: job.job })).checks.stale, true);
  assert.equal(checkReceipt(job).report_sig, next.report_sig);
  fs.writeFileSync(join(f.root, 'hold-check'), '');
  await publishPiGrace(t, job, undefined, false);
  const send = { job: job.job, text: 'Synthetic repair during a check hold.' };
  try {
    await until(() => checkReceipt(job)?.state === 'running', t.signal);
    const repair = await f.call('hud_send', send);
    assert.equal(repair.continued_as, repair.job);
    assert.notEqual(repair.job, job.job);
    assert.deepEqual(JSON.parse(fs.readFileSync(join(repair.task_dir, 'job.json'), 'utf8')).checks, checks);
    assert.equal(readCloseReaped(job), undefined);
    assert.equal(reapAttempts(f, job), 0);
    assert.equal(cliState(job.task_dir).state, 'idle_grace');
    fs.writeFileSync(join(f.root, 'release-check'), '');
    await until(() => readCloseReaped(job), t.signal);
    assert.equal(checkReceipt(job).report_sig, reportSignature(job.task_dir));
    assert.equal(fs.readFileSync(join(f.root, 'check-count'), 'utf8'), 'ran\nran\nran\n');
    assert.equal((await f.call('hud_send', send)).continued_as, repair.job);
  } finally { fs.writeFileSync(join(f.root, 'release-check'), ''); }
});
