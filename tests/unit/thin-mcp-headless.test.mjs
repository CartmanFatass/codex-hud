import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, cliState, taskCall, taskJob, taskRpc, until, workerFor } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile as write } from '../helpers/thin-mcp-files.mjs';
import { isProcAlive } from '../../dist/utils/proc.js';

const moduleUrl = path => new URL(path, import.meta.url).href;
const read = path => JSON.parse(fs.readFileSync(path));

// Exercise the detached launcher, actual worker tools, extension hooks and watcher, without a provider.
const fakePi = `#!${process.execPath}
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
if (!process.argv.includes('--print')) process.exit(1);
const { callWorkerTool } = await import(${JSON.stringify(moduleUrl('../../packages/hud-mcp/bin/worker-tools.mjs'))});
if (process.argv.includes('--no-session')) {
  await callWorkerTool('hud_report', { text: 'Synthetic sonic facts.' });
  process.exit(0);
}
const dir = process.env.HUD_JOB_DIR, args = process.argv, file = args[args.indexOf('--session') + 1];
assert.ok(file.startsWith(dir + '/sessions/'));
assert.ok(!args.includes('--no-session'));
const fresh = !fs.statSync(file).size;
if (fresh) fs.appendFileSync(file, JSON.stringify({ type: 'session', id: randomUUID(), cwd: process.cwd() }) + '\\n');
const id = JSON.parse(fs.readFileSync(file, 'utf8').split('\\n')[0]).id;
const { default: extension } = await import(${JSON.stringify(moduleUrl('../../integrations/pi/package/extensions/hud.mjs'))});
const hooks = {}, tools = {}, ctx = { sessionManager: { getSessionId: () => id, getSessionFile: () => file } };
await extension({ on: (name, handler) => hooks[name] = handler, registerTool: t => tools[t.name] = t, sendMessage() {} });
assert.deepEqual(Object.keys(tools).sort(), ['hud_lease', 'hud_progress', 'hud_report', 'hud_sonic']); // pi-role owns hud_ask.
const prompt = args.at(-1);
assert.equal(hooks.input({}, ctx), undefined);
fs.appendFileSync(file, JSON.stringify({ prompt }) + '\\n');
console.log(JSON.stringify({ id, prompt }));
await tools.hud_progress.execute('progress', { message: 'Synthetic progress.' });
if (fresh && fs.existsSync(join(process.env.HOME, 'ask'))) {
  const event = { toolName: 'hud_ask', input: { mode: 'async', question: 'Which value?', default: 'A' } };
  hooks.tool_call(event);
  assert.equal(event.input.mode, 'sync');
  assert.equal(args[args.indexOf('--qa-timeout') + 1], '0');
  await callWorkerTool('hud_ask', event.input);
  let ended = false;
  hooks.turn_end({ toolResults: [{ toolName: 'hud_ask' }] }, { abort: () => ended = true });
  assert.ok(ended);
} else if (prompt !== 'No new report.') {
  if (prompt === 'Check C.') {
    const started = await tools.hud_sonic.execute('start', { task: 'Read a synthetic fact.' });
    const collected = await tools.hud_sonic.execute('wait', { wait: [started.details.job] });
    assert.equal(collected.details.reports[0].body, 'Synthetic sonic facts.');
  }
  await tools.hud_report.execute('report', { text: 'Synthetic report: ' + prompt });
}
`;

const create = f => f.call('hud_create', { role: 'imp', mode: 'headless', task: 'Synthetic change.' });
const closed = job => until(() => {
  const state = cliState(job.task_dir);
  if (state?.state === 'failed') assert.fail(`${state.exit_reason}: ${fs.readFileSync(join(job.task_dir, 'stderr.log'), 'utf8')}`);
  return state?.state === 'closed' && read(join(job.task_dir, 'job.json')).reaped_at;
});
const noTab = f => !f.commands().some(({ args }) => args[0] === 'tab' && args[1] === 'create');

test('question, follow-up and land repair reopen the same tabless pi session; expiry starts a headless repair', async t => {
  const f = await fixture(t);
  f.overrideBin('pi', fakePi);
  write(join(f.env.HOME, 'ask'), '');
  const job = await create(f), dir = job.task_dir;
  assert.equal(job.mode, 'headless');
  await until(() => cliState(dir)?.state === 'waiting_orchestrator');
  const paused = cliState(dir);
  assert.ok(!isProcAlive(paused.pid));
  assert.equal(workerFor(f, job.job)?.latest_progress?.text, 'Synthetic progress.');
  const peek = await f.call('hud_peek', { job: job.job });
  assert.deepEqual(peek.status.question_ids, ['q1']);
  assert.match(JSON.stringify(peek), /Synthetic progress/);
  const answer = { job: job.job, request_id: 'q1', answer: 'Choose B.' };
  assert.equal((await f.call('hud_respond', answer)).written, true);
  await closed(job);
  assert.match(fs.readFileSync(join(dir, 'report.md'), 'utf8'), /Choose B\./);
  assert.equal((await f.call('hud_respond', answer)).written, false);
  assert.equal((await f.call('hud_send', { job: job.job, text: 'Check C.' })).continuation, 'resumed');
  await closed(job);
  const land = `import { dispatchLandRepair } from ${JSON.stringify(moduleUrl('../../dist/mcp/thin-main.js'))};\n    console.log(await dispatchLandRepair(${JSON.stringify(job.job)}, process.cwd(), 'Synthetic land repair.', 'land:test', null));`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', land], { cwd: f.root, env: f.env, encoding: 'utf8' }).trim(), job.job);
  await closed(job);
  const lines = fs.readFileSync(join(dir, 'stdout.jsonl'), 'utf8').trimEnd().split('\n').map(x => JSON.parse(x));
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map(x => x.id), Array(4).fill(paused.session_id));
  assert.deepEqual(lines.slice(1).map(x => x.prompt), ['Choose B.', 'Check C.', 'Synthetic land repair.']);
  assert.equal(cliState(dir).session_file, paused.session_file);
  assert.ok(fs.existsSync(paused.session_file));
  assert.equal(fs.existsSync(join(dir, 'SESSION.txt')), false);
  write(join(dir, 'STATUS.json'), JSON.stringify({ ...cliState(dir), ended_at: new Date(0).toISOString() }));
  const repair = await f.call('hud_send', { job: job.job, text: 'Expired follow-up.' });
  assert.equal(repair.continuation, 'repair');
  assert.notEqual(repair.job, job.job);
  assert.equal(repair.mode, 'headless');
  await until(() => cliState(repair.task_dir)?.state === 'waiting_orchestrator');
  assert.notEqual(cliState(repair.task_dir).session_id, paused.session_id);
  assert.equal((await f.call('hud_close', { job: repair.job })).exit_code, 0);
  assert.equal(cliState(repair.task_dir).state, 'stopped');
  assert.ok(noTab(f));
});

test('answering a headless question while the original MCP task is live carries that task through the resumed report', async t => {
  const f = await fixture(t), rpc = taskRpc(f.rpc);
  f.overrideBin('pi', fakePi);
  write(join(f.env.HOME, 'ask'), '');
  await rpc('server/discover');
  const task = await taskCall(rpc, 'hud_create', { role: 'imp', mode: 'headless', task: 'Synthetic task chain.' });
  const job = taskJob(f, task);
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator');
  const response = await taskCall(rpc, 'hud_respond', { job: job.job, request_id: 'q1', answer: 'Keep going.' });
  assert.equal(response.resultType, 'complete');
  await closed(job);
  const result = await rpc('tasks/get', { taskId: task.taskId });
  assert.equal(result.status, 'completed');
  assert.match(JSON.stringify(result.result), /Keep going/);
});

test('the panel Answer action resumes the paused session and records who answered', async t => {
  const f = await fixture(t);
  f.overrideBin('pi', fakePi);
  write(join(f.env.HOME, 'ask'), '');
  const job = await create(f), dir = job.task_dir;
  await until(() => fs.existsSync(join(dir, 'qa/q1.md'))); // The owner can answer before the asking turn exits.
  const action = `import { answerFromPanel } from ${JSON.stringify(moduleUrl('../../dist/panel/actions.js'))};\n    console.log(JSON.stringify(await answerFromPanel(process.env.HUD_HOME, process.argv[1], 'q1', 'Panel B.', 'imp')));`;
  const answer = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', action, job.job], { cwd: f.root, env: f.env, encoding: 'utf8' }));
  assert.deepEqual(answer(), { ok: true, written: true });
  await closed(job);
  assert.match(fs.readFileSync(join(dir, 'report.md'), 'utf8'), /Panel B\./);
  assert.deepEqual(answer(), { ok: true, written: false });
  assert.equal(read(join(f.env.HUD_HOME, 'panel-actions.jsonl')).answer, 'Panel B.');
  assert.ok(noTab(f));
});

test('old report cannot settle a resumed turn and noncontinuable or non-pi launches refuse the mode', async t => {
  const f = await fixture(t);
  for (const options of [{ role: 'reviewer' }, { role: 'imp', on: 'codex' }, { role: 'imp', pi_args: ['--no-session'] }]) {
    assert.equal((await f.call('hud_create', { ...options, mode: 'headless', task: 'Synthetic rejection.' })).code, 'invalid_arguments');
  }
  f.overrideBin('pi', fakePi);
  const job = await create(f);
  await closed(job);
  assert.equal((await f.call('hud_send', { job: job.job, text: 'No new report.' })).continuation, 'resumed');
  await until(() => cliState(job.task_dir)?.state === 'failed');
  assert.equal(cliState(job.task_dir).exit_reason, 'pi exited without a declared report');
  assert.ok(noTab(f));
});

test('hud_close and panel stop reap the live headless worker and its detached child', async t => {
  const f = await fixture(t);
  f.overrideBin('pi', `#!${process.execPath}
import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
if (!process.argv.includes('--print')) process.exit(1);
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
writeFileSync(process.env.HUD_JOB_DIR + '/pids', JSON.stringify([process.pid, child.pid]));`);
  for (const panel of [false, true]) {
    const job = await f.call('hud_create', { role: 'imp', task: 'Synthetic live worker ' + panel, mode: 'headless' });
    const file = join(job.task_dir, 'pids');
    await until(() => fs.existsSync(file) && fs.statSync(file).size);
    const pids = [cliState(job.task_dir).pid, ...read(file)];
    if (panel) {
      const stop = `import { stopJob } from ${JSON.stringify(moduleUrl('../../dist/cli/panel-pane.js'))}; console.log((await stopJob(process.argv[1], process.env)).ok);`;
      assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', stop, job.task_dir], { env: f.env, encoding: 'utf8' }).trim(), 'true');
    } else {
      const result = await f.call('hud_close', { job: job.job });
      assert.equal(result.exit_code, 0, JSON.stringify({ result, log: fs.existsSync(join(f.env.HUD_HOME, 'watch.log')) && fs.readFileSync(join(f.env.HUD_HOME, 'watch.log'), 'utf8') }));
    }
    assert.equal(cliState(job.task_dir).state, 'stopped');
    assert.ok(pids.every(pid => !isProcAlive(pid)));
  }
});
