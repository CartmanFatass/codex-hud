import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import fsDefault from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';
import { reportSignature, turnToken } from '../../dist/mcp/cli-judge.js';
import { readReportMeta } from '../../dist/roles/report-meta.js';
import { ask, waitSonic } from '../../packages/hud-mcp/bin/worker-tools.mjs';
import {
  workerFor,
  entry,
  fixture,
  workerClient,
  resultValue,
  until,
  runSonic,
  sonicTask,
  publishSonic,
  cliToken,
  runProgress,
  fallbackRole,
  waitFixtureJob,
  progressRecord,
  jsonLines,
  writeCliRole,
  cliState,
} from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { initRepo } from '../fixtures/managed-worktree.mjs';

test('hud_ask does not block other worker MCP calls while Codex queue is slow', async (t) => {
  const f = await fixture(t);
  const parent = await f.call('hud_create', { role: 'imp', task: 'Synthetic worker question.' });
  // hud_create checks the caller's pane for a queue watcher in the background (its second `pane get`). If that
  // check ran after the Codex stub below, it would start a watcher that takes the delivery ("delivered by hud watch").
  await until(() => f.commands().filter(({ args }) => args.join(' ') === 'pane get w4E:p1').length >= 2);
  // A shell stub: a Node one can miss the 2 s pane-lookup budget under full-suite load and fall back to hud watch.
  f.overrideBin('herdr', `#!/bin/sh
case "$2" in
  get) echo '{"result":{"pane":{"agent":"codex","agent_session":{"value":"synthetic-thread"}}}}' ;;
  *) echo "{\\"result\\":{\\"process_info\\":{\\"foreground_processes\\":[{\\"name\\":\\"codex\\",\\"pid\\":$PPID}]}}}" ;;
esac
`);
  const queued = join(f.root, 'queue-start');
  f.overrideBin('codex', `#!${process.execPath}
import fs from 'node:fs';
import { setTimeout } from 'node:timers/promises';
fs.writeFileSync(${JSON.stringify(queued)}, String(process.pid));
await setTimeout(2000);
`);
  const call = workerClient(t, f, parent.task_dir, '0');
  const pending = call('hud_ask', { question: 'Which layout?', default: 'rows' });
  await until(() => fs.existsSync(queued));
  const start = performance.now();
  assert.deepEqual((await call.rpc('ping')).result, {});
  const pingMs = performance.now() - start;
  const reply = await pending;
  t.diagnostic(`worker ping during hud_ask: ${pingMs.toFixed(0)} ms`);
  assert.match(reply.content[0].text, /pushed via codex queue/);
  assert.ok(pingMs < 500, 'worker MCP should answer while delivery is still in progress');

  // Native callers supply an AbortSignal directly to the same worker tool.
  fs.unlinkSync(queued);
  const workerTools = resolve('packages/hud-mcp/bin/worker-tools.mjs');
  const cancellable = spawn(process.execPath, ['--input-type=module', '-e', `
    import { pathToFileURL } from 'node:url';
    const { callWorkerTool } = await import(pathToFileURL(${JSON.stringify(workerTools)}).href);
    const ac = new AbortController();
    process.on('SIGTERM', () => ac.abort());
    try { await callWorkerTool('hud_ask', { question: 'Which color?', default: 'blue' }, ac.signal); }
    catch (error) { if (error.name === 'AbortError') process.exitCode = 0; else throw error; }
    process.exitCode ??= 1;
  `], { env: { ...f.env, HUD_JOB_DIR: parent.task_dir, HUD_ASK_TIMEOUT: '0' }, stdio: 'inherit' });
  const exited = once(cancellable, 'exit');
  t.after(async () => { cancellable.kill('SIGTERM'); await exited; });
  await until(() => fs.existsSync(queued));
  const cancelStart = performance.now();
  cancellable.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
  const cancelMs = performance.now() - cancelStart;
  t.diagnostic(`worker hud_ask abort: ${cancelMs.toFixed(0)} ms`);
  assert.ok(cancelMs < 500);
  assert.equal(fs.existsSync(`/proc/${fs.readFileSync(queued, 'utf8')}`), false, 'queue child exited');
});

test('worker ping can release a contended Antigravity hud_ask mailbox before flock times out', async (t) => {
  const f = await fixture(t);
  const parent = await f.call('hud_create', { role: 'imp', task: 'Synthetic mailbox question.' });
  await until(() => f.commands().filter(({ args }) => args.join(' ') === 'pane get w4E:p1').length >= 2);
  f.overrideBin('herdr', `#!/bin/sh\necho '{"result":{"pane":{"agent":"agy","agent_status":"working"}}}'\n`);
  f.overrideBin('flock', '#!/bin/sh\ntouch "$HOME/waiting-on-mailbox"\nexec /usr/bin/flock "$@"\n');
  const dir = join(f.env.HUD_HOME, 'watchers');
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(join(dir, 'w4E:p1.agy-pending.lock'), 'w');
  let pending;
  try {
    assert.equal(spawnSync('/usr/bin/flock', ['-nx', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] }).status, 0);
    const call = workerClient(t, f, parent.task_dir, '0');
    pending = call('hud_ask', { question: 'Which layout?', default: 'rows' });
    await until(() => fs.existsSync(join(f.env.HOME, 'waiting-on-mailbox')));
    assert.deepEqual((await call.rpc('ping')).result, {});
  } finally { fs.closeSync(fd); }
  assert.match((await pending).content[0].text, /pending for Antigravity delivery/);
});

test('hud_sonic starts two independent child jobs; wait follows STATUS, scope and timeout', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const task = sonicTask(f);
  const parent = await f.call('hud_create', { role: 'imp', request_key: 'sonic-parent', task: 'Synthetic parent.' });
  const call = workerClient(t, f, parent.task_dir);
  const start = async () => resultValue(await call('hud_sonic', { task: fs.readFileSync(task, 'utf8') })).job;
  const [first, second] = await Promise.all([start(), start()]);
  assert.notEqual(first, second);
  const dir = (id) => join(f.env.HUD_HOME, 'jobs', id);
  for (const id of [first, second]) {
    assert.match(id, /^j[0-9a-f]{16}$/);
    const job = JSON.parse(fs.readFileSync(join(dir(id), 'job.json')));
    assert.equal(job.parent_job, parent.job);
    assert.equal(job.herdr_pane, 'w4E:p1');
    assert.equal(job.cwd, f.root);
    assert.equal(job.role, 'sonic');
    assert.equal(job.model, 'synthetic/sonic');
    assert.equal(job.thinking, 'high');
    assert.equal(job.thinking_source, 'default');
    const launched = f.commands().find(({ args }) => args[1] === 'start' && args[2] === `${id}-primary`).args;
    assert.equal(launched[launched.indexOf('--thinking') + 1], 'high');
    assert.match(fs.readFileSync(join(dir(id), 'SESSION.txt'), 'utf8'), /^ORCH=w4E:p1$/m);
    assert.equal(cliState(dir(id)).state, 'working');
  }
  const wait = (id, timeout = '0', own = parent.task_dir) => runSonic(f, 'wait', own, '--job', id, '--timeout', timeout);
  const stillWorking = { status: 3, stdout: 'still working: run wait again\n', stderr: '' };
  assert.deepEqual(await wait(first), stillWorking, 'a report file alone does not settle a child');
  assert.deepEqual(await wait(second, '0.2'), stillWorking);
  assert.deepEqual(resultValue(await call('hud_sonic', { timeout_s: 0 })), { reports: [], working: [first, second].sort(), failed: [] });
  const qa = join(dir(first), 'qa');
  fs.mkdirSync(qa, { recursive: true });
  writeFixtureFile(join(qa, 'q1.md'), 'Synthetic child question.');
  const changes = async () => (await f.call('hud_read')).changes ?? [];
  assert.ok((await changes()).some((line) => line.startsWith(first) && line.includes('QUESTION') && !line.includes(' | report')));
  const waiting = call('hud_sonic', { timeout_s: 2 });
  writeFixtureFile(join(qa, 'q1.answer.md'), 'Answer.');
  publishSonic(dir(first), { state: 'closed', output_written: true });
  assert.ok(!(await changes()).some((line) => line.startsWith(first)), 'child settlement stays quiet');
  publishSonic(dir(second), { state: 'closed', output_written: true });
  assert.deepEqual(resultValue(await waiting), { working: [], failed: [], reports: [first, second].sort().map((id) => ({
    id, path: `${dir(id)}/report.md`, body: 'Synthetic implementation report.',
  })) });
  assert.deepEqual(resultValue(await call('hud_sonic', { timeout_s: 0 })), { reports: [], working: [], failed: [] });
  const compact = (await f.call('hud_read')).jobs;
  assert.deepEqual(compact.map(({ job, child_count }) => [job, child_count]), [[parent.job, 2]]);
  assert.equal((await f.call('hud_read', { view: 'recent' })).jobs.find((job) => job.job === first).report_unread, true);
  assert.match((await f.call('hud_read', { job: first, full: true })).report, /Synthetic implementation report/);

  const other = await f.call('hud_create', { role: 'imp', request_key: 'not-the-parent', task: 'Synthetic other job.' });
  const refused = await wait(first, '0', other.task_dir);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /not a sonic child/);
  const sonicParent = await runSonic(f, 'start', dir(first), '--task-file', task);
  assert.equal(sonicParent.status, 1);
  assert.match(sonicParent.stderr, /a sonic worker cannot start sonic/);
  const inline = await runSonic(f, 'start', parent.task_dir, '--task', 'Synthetic inline sub-task.');
  assert.equal(inline.status, 0, inline.stderr);
  assert.match(fs.readFileSync(join(dir(inline.stdout.trim()), 'brief.md'), 'utf8'), /^Synthetic inline sub-task\./);
  publishSonic(dir(inline.stdout.trim()), { state: 'failed', exit_reason: 'synthetic child failed' });
  const failed = await wait(inline.stdout.trim());
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /synthetic child failed/);
  for (const opts of [[], ['--task', 'Synthetic.', '--task-file', task], ['--task', ' ']]) {
    const bad = await runSonic(f, 'start', parent.task_dir, ...opts);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--task <text> or --task-file <file>|the sub-task is empty/);
  }
  const foreignDir = join(f.root, first);
  fs.mkdirSync(foreignDir);
  fs.copyFileSync(join(dir(first), 'job.json'), join(foreignDir, 'job.json'));
  const outside = await runSonic(f, 'start', foreignDir, '--task-file', task);
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /under HUD_HOME/);
});

test('hud_sonic inherits the parent managed worktree cwd, not the worker MCP server cwd', async (t) => {
  const f = await fixture(t), cwd = initRepo(f.root);
  sonicTask(f);
  const parent = await f.call('hud_create', { role: 'imp', on: 'pi', cwd, isolation: 'worktree', task: 'Synthetic parent.' });
  const parentJob = JSON.parse(fs.readFileSync(join(parent.task_dir, 'job.json')));
  const worktree = parentJob.worktree.root;
  assert.notEqual(worktree, f.root); // workerClient launches MCP from f.root.
  assert.notEqual(worktree, cwd);

  const call = workerClient(t, f, parent.task_dir);
  const { job, error } = resultValue(await call('hud_sonic', { task: 'Synthetic child.' }));
  assert.equal(error, undefined);
  const dir = join(f.env.HUD_HOME, 'jobs', job);
  const child = JSON.parse(fs.readFileSync(join(dir, 'job.json')));
  assert.equal(child.parent_job, parent.job);
  assert.equal(child.cwd, worktree);
  const tab = f.commands().find(({ args }) => args[0] === 'tab' && args[1] === 'create' && args.includes(`HUD_JOB_DIR=${dir}`));
  assert.equal(tab.args[tab.args.indexOf('--cwd') + 1], worktree);
});

test('hud_sonic accepts a project cwd relative to the parent and refuses paths outside the project', async (t) => {
  const f = await fixture(t), cwd = initRepo(f.root);
  sonicTask(f);
  const parent = await f.call('hud_create', { role: 'imp', on: 'pi', cwd, isolation: 'worktree', task: 'Synthetic parent.' });
  const { worktree } = JSON.parse(fs.readFileSync(join(parent.task_dir, 'job.json')));
  const subdir = join(worktree.root, 'subdir');
  fs.mkdirSync(subdir);
  fs.symlinkSync(f.root, join(worktree.root, 'outside'));
  const jobs = join(f.env.HUD_HOME, 'jobs');
  const call = workerClient(t, f, parent.task_dir);
  for (const outside of [f.root, 'outside']) {
    const result = await call('hud_sonic', { task: 'Synthetic child.', cwd: outside });
    assert.equal(result.isError, true);
    const error = JSON.parse(result.content[0].text);
    assert.equal(error.code, 'invalid_arguments');
    assert.match(error.error, /cwd.*inside the parent project/);
  }
  assert.deepEqual(fs.readdirSync(jobs), [parent.job]);

  const { job, error } = resultValue(await call('hud_sonic', { task: 'Synthetic child.', cwd: 'subdir' }));
  assert.equal(error, undefined);
  assert.equal(JSON.parse(fs.readFileSync(join(jobs, job, 'job.json'))).cwd, subdir);
});

test('a working pi parent gets a native sonic-ready message without polling or collecting', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const task = sonicTask(f);
  const parent = await f.call('hud_create', { role: 'imp', task: 'Synthetic pi parent.' });
  const native = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import hud from ${JSON.stringify(new URL('../../integrations/pi/package/extensions/hud.mjs', import.meta.url).href)};
    import { existsSync, renameSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import assert from 'node:assert/strict';
    process.argv.push('--hud-worker-tools');
    const tools = new Map(), notice = Promise.withResolvers();
    await hud({ on() {}, registerTool(tool) { tools.set(tool.name, tool); },
      sendMessage(message, options) { notice.resolve({ message, options }); } });
    const sonic = tools.get('hud_sonic');
    const { details: { job } } = await sonic.execute('start', { task: ${JSON.stringify(fs.readFileSync(task, 'utf8'))} });
    const dir = join(process.env.HUD_HOME, 'jobs', job);
    await tools.get('hud_progress').execute('unrelated', { message: 'Parent still editing.' });
    const timeout = setTimeout(() => { throw Error('no sonic notice'); }, 3000);
    writeFileSync(join(dir, 'status.tmp'), JSON.stringify({ state: 'idle_grace' }));
    renameSync(join(dir, 'status.tmp'), join(dir, 'STATUS.json'));
    const { message, options } = await notice.promise;
    clearTimeout(timeout);
    assert.equal(message.customType, 'hud-sonic-ready');
    assert.match(message.content, new RegExp(job));
    assert.deepEqual(options, { triggerTurn: true, deliverAs: 'steer' });
    assert.equal(existsSync(join(dir, 'sonic-collected')), false);
    const { details } = await sonic.execute('collect', { wait: [job] });
    assert.equal(details.reports[0].body, 'Synthetic implementation report.');

    process.env.HUD_JOB_DIR = dir;
    const childTools = [];
    await hud({ on() {}, registerTool(tool) { childTools.push(tool.name); } });
    assert.deepEqual(childTools, ['hud_report', 'hud_progress', 'hud_lease']);
  `], { env: { ...f.env, HUD_JOB_DIR: parent.task_dir }, encoding: 'utf8', timeout: 12000 });
  assert.equal(native.status, 0, native.stderr);
});

test('sonic tooling offers no per-task choice, but hud_create keeps explicit overrides', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const compact = await f.call('hud_roster');
  const shipped = compact.roles.find(({ role }) => role === 'sonic');
  assert.equal(shipped.runs_on.thinking, 'high');
  assert.equal(shipped.thinking_choices, undefined);
  const task = sonicTask(f); // The owner overrides the chain but inherits the shipped thinking purposes.
  const detail = await f.call('hud_roster', { detail: true });
  assert.match(detail.roles.find(({ role }) => role === 'sonic').thinking_choices.max, /tracing a cause/);
  const { tools } = (await f.rpc('tools/list')).result;
  const create = tools.find(({ name }) => name === 'hud_create');
  assert.match(create.description, /Omit preset, on, model and thinking unless the user requests them\./);
  assert.equal(create.inputSchema.properties.thinking.description, 'Pi or CLI effort.');
  assert.doesNotMatch(tools.find(({ name }) => name === 'hud_roster').description, /per-task|thinking choices/);
  const main = await f.call('hud_create', { role: 'sonic', task: 'Synthetic task.', thinking: 'off' });
  assert.equal(main.thinking, 'off');
  assert.equal(main.thinking_source, 'explicit');
  const child = workerClient(t, f, main.task_dir);
  assert.deepEqual((await child.rpc('tools/list')).result.tools.map(({ name }) => name),
    ['hud_report', 'hud_ask', 'hud_progress', 'hud_lease']);
  assert.equal((await child('hud_sonic', {})).isError, true);
  const parent = await f.call('hud_create', { role: 'imp', task: 'Synthetic parent.' });
  const call = workerClient(t, f, parent.task_dir);
  const sonic = (await call.rpc('tools/list')).result.tools.find(({ name }) => name === 'hud_sonic');
  assert.equal(sonic.inputSchema.properties.thinking, undefined);
  assert.doesNotMatch(sonic.description, /thinking|level|0 checks once/);
  assert.equal((await call('hud_sonic', { task: 'Synthetic child.', thinking: 'off' })).isError, true);
  const script = await runSonic(f, 'start', parent.task_dir, '--task-file', task, '--thinking', 'max');
  assert.equal(script.status, 1);
  assert.match(script.stderr, /Unknown option '--thinking'/);
});

test('sonic auto-thinking uses one capped judgment for each new job and falls back safely', { timeout: 25000 }, async (t) => {
  const probe = `import * as fs from 'node:fs';
    import { join } from 'node:path';
    globalThis.fetch = async (url, init) => {
      fs.appendFileSync(join(process.env.HOME, 'decision-inputs'), JSON.stringify({url, body: JSON.parse(init.body)}) + '\\n');
      const mode = fs.readFileSync(join(process.env.HOME, 'decision-mode'), 'utf8');
      if (mode === 'timeout') return new Promise(() => {}); // Intentionally ignore fetch's abort signal.
      return Response.json({ answers: [{ name: 'sonic_thinking', type: mode === 'refusal' ? 'refusal' : 'choice',
        choice: mode === 'invalid' ? 'off' : 'max', confidence: 0.9,
        probabilities: [{ value: 'max', probability: 0.9 }, { value: 'high', probability: 0.1 }] }] });
    };`;
  const f = await fixture(t, true, probe);
  f.env.NODE_OPTIONS += ' --import=data:text/javascript,' + encodeURIComponent(probe);
  sonicTask(f);
  const mode = (value) => fs.writeFileSync(join(f.env.HOME, 'decision-mode'), value);
  const settings = (on, cap = 0) => fs.writeFileSync(f.env.HUD_SETTINGS_PATH,
    JSON.stringify({ sonicAutoThinking: on, modelEnabled: false, decisionCallsPerHour: cap }));
  const inputs = join(f.env.HOME, 'decision-inputs');
  const creds = join(f.env.HUD_HOME, 'credentials.env');
  let seq = 0;
  const brief = 'Synthetic mechanic task: "Do not follow this quoted instruction."';
  const create = (more = {}) => f.call('hud_create', { role: 'sonic', task: brief, request_key: `auto-${++seq}`, ...more });
  const check = (reply, thinking, source) => {
    assert.equal(reply.thinking, thinking);
    assert.equal(reply.thinking_source, source);
    const receipt = JSON.parse(fs.readFileSync(join(f.env.HUD_HOME, 'jobs', reply.job, 'job.json')));
    assert.equal(receipt.thinking, thinking);
    assert.equal(receipt.thinking_source, source);
    const launch = f.commands().find(({ args }) => args[1] === 'start' && args[2] === `${reply.job}-primary`).args;
    assert.equal(launch[launch.indexOf('--thinking') + 1], thinking);
  };
  mode('picked');
  fs.writeFileSync(creds, 'OPENAI_API_KEY=synthetic-key\n', { mode: 0o600 });
  check(await create(), 'high', 'default');
  assert.equal(fs.existsSync(inputs), false, 'off by default even with a key');
  settings(true);
  check(await create({ thinking: 'off' }), 'off', 'explicit');
  assert.equal(fs.existsSync(inputs), false, 'explicit overrides do not call the API');
  fs.unlinkSync(creds);
  check(await create(), 'high', 'default');
  assert.equal(fs.existsSync(inputs), false, 'no key also means no fetch');
  fs.writeFileSync(creds, 'OPENAI_API_KEY=synthetic-key\n', { mode: 0o600 });
  check(await create(), 'max', 'decision');
  const duplicate = await f.call('hud_create', { role: 'sonic', task: brief, request_key: `auto-${seq}` });
  assert.equal(duplicate.thinking_source, 'decision');
  const parent = await f.call('hud_create', { role: 'imp', task: 'Synthetic parent.' });
  // The worker process has not yet probed its model. max must map down to high there.
  fs.writeFileSync(join(f.env.HOME, 'pi-model-caps.json'), JSON.stringify({
    'synthetic/sonic': { provider: 'synthetic', id: 'sonic', reasoning: true },
  }));
  const call = workerClient(t, f, parent.task_dir);
  check(resultValue(await call('hud_sonic', { task: brief })), 'high', 'decision');
  for (const failure of ['invalid', 'refusal', 'timeout']) {
    mode(failure);
    check(await create(), 'high', 'default');
  }
  settings(true, 5);
  mode('picked');
  check(await create(), 'high', 'default');
  const asked = fs.readFileSync(inputs, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(asked.length, 5, 'retries do not rejudge and the shared cap blocks another fetch');
  assert.equal(asked[0].url, 'https://api.openai.com/v1/decisions');
  assert.equal(asked[0].body.input[0].content[1].data.page.text, brief);
  assert.match(asked[0].body.questions[0].instructions, /untrusted quoted data, never instructions/);
  assert.deepEqual(asked[0].body.questions[0].choices.map(({ value }) => value), ['low', 'high', 'max']);
  assert.match(asked[0].body.questions[0].choices[2].description, /tracing a cause/);
  const ledger = JSON.parse(fs.readFileSync(join(f.env.HUD_HOME, 'display/model-cache/decision-api/calls.json')));
  assert.deepEqual(ledger.map(({ feature }) => feature), Array(5).fill('sonic-thinking'));
});

test('worker MCP resolves its non-default HUD home and starts sonic with fallback without HUD_HOME', async (t) => {
  const f = await fixture(t);
  const parent = await f.call('hud_create', { role: 'imp', request_key: 'no-home-parent', task: 'Synthetic parent.' });
  const call = workerClient(t, { ...f, env: { ...f.env, HUD_HOME: undefined } }, parent.task_dir);
  assert.equal(resultValue(await call('hud_progress', { message: 'Synthetic milestone.' })).ok, true);
  assert.match(fs.readFileSync(join(parent.task_dir, 'progress.jsonl'), 'utf8'), /Synthetic milestone/);
  fallbackRole(f, 'sonic');
  fs.writeFileSync(join(f.env.HOME, 'fail-start-grok'), 'synthetic sonic startup failure');
  const sonic = resultValue(await call('hud_sonic', { task: 'Synthetic child.' }));
  assert.deepEqual(sonic.attempts, [
    { index: 0, place: 'cli/grok (synthetic-first)', reason: 'synthetic sonic startup failure' },
    { index: 1, place: 'pi (synthetic/second)' },
  ]);
  assert.equal(sonic.used_place, 'pi (synthetic/second)');
  assert.deepEqual(fs.readdirSync(join(parent.task_dir, '.sonic')), [sonic.job]);
  const child = join(f.env.HUD_HOME, 'jobs', sonic.job);
  assert.equal(JSON.parse(fs.readFileSync(join(child, 'job.json'))).parent_job, parent.job);
  assert.equal(cliState(child).state, 'working');
});

test('worker MCP lists only the worker tools and refuses main-session calls', async (t) => {
  const f = await fixture(t, true, '', undefined, true);
  const dir = f.env.HUD_JOB_DIR;
  const job = basename(dir);
  const args = { role: 'imp', request_key: 'worker-child', task: 'Synthetic task.' };
  const receipt = {
    job,
    role: 'imp',
    request_key: 'worker-self',
    cwd: f.root,
    herdr_pane: f.env.HERDR_PANE_ID,
    created_at: new Date().toISOString(),
    dispatch_exit_code: 0,
    message_keys: [],
    place_key: 'pi:implementer:synthetic/default',
  };
  fs.mkdirSync(join(dir, 'qa'), { recursive: true });
  writeFixtureFile(join(dir, 'job.json'), JSON.stringify(receipt));
  writeFixtureFile(join(dir, 'SESSION.txt'), `PRIMARY=${job}-primary\n`);
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
  writeFixtureFile(join(dir, 'qa', 'q1.md'), 'Synthetic question.');
  const listed = await f.rpc('tools/list');
  assert.deepEqual(listed.result.tools.map(({ name }) => name), ['hud_report', 'hud_ask', 'hud_sonic', 'hud_progress', 'hud_lease']);
  const call = (name, args) => f.rpc('tools/call', { name, arguments: args });
  assert.equal(resultValue((await call('hud_progress', { message: 'Synthetic milestone' })).result).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(join(dir, 'progress.jsonl'), 'utf8')).text, 'Synthetic milestone');
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'failed', exit_reason: 'quota exceeded' }));
  for (const [name, payload] of [
    ['hud_roster', {}], ['hud_read', { job }], ['hud_create', args], ['hud_close', { job }],
    ['hud_send', { job, message_key: 'worker-send', text: 'Synthetic message.' }],
    ['hud_respond', { job, request_id: 'q1', answer: 'Synthetic answer.' }],
  ]) {
    const { result } = await call(name, payload);
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).code, 'worker_cannot_dispatch');
  }
  assert.deepEqual(f.commands(), []);
  assert.deepEqual(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')), [job]);
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'exhausted.json')), false);
  assert.equal(fs.existsSync(join(dir, 'qa', 'q1.answer.md')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8')), receipt);
});

function leaseWorker(t, f, number, cwd = f.root, pid = process.pid) {
  const job = `j${String(number).padStart(16, '0')}`, dir = join(f.env.HUD_HOME, 'jobs', job);
  fs.mkdirSync(dir, { recursive: true });
  writeFixtureFile(join(dir, 'job.json'), JSON.stringify({ job, cwd, role: 'imp', herdr_pane: 'w4E:p2', created_at: new Date().toISOString() }));
  const status = (state) => writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state, pid }));
  status('working');
  const rpc = workerClient(t, f, dir);
  return { job, dir, status, lease: async (args) => resultValue(await rpc('hud_lease', { name: 'install', ...args })) };
}

test('hud_lease grants one worker per Git root, then wakes a waiter after release', async (t) => {
  const f = await fixture(t);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: f.root, env: f.env }).status, 0);
  const sub = join(f.root, 'sub');
  fs.mkdirSync(sub);
  const workers = [leaseWorker(t, f, 1), leaseWorker(t, f, 2, sub)];
  const results = await Promise.all(workers.map((w) => w.lease({ wait_s: 0 })));
  const winner = results.findIndex((r) => r.granted), loser = 1 - winner;
  assert.equal(results.filter((r) => r.granted).length, 1);
  const held_by = results[loser].held_by;
  assert.equal(held_by.holder, workers[winner].job);
  assert.ok(Number.isFinite(Date.parse(held_by.since)));
  assert.deepEqual(await workers[loser].lease({ release: true }), { released: false, held_by });
  const waiting = workers[loser].lease({ wait_s: 3 });
  assert.deepEqual(await workers[winner].lease({ release: true }), { released: true });
  assert.deepEqual(await waiting, { granted: true });
  assert.deepEqual(await workers[loser].lease({ release: true }), { released: true });
});

test('hud_lease reclaims terminal jobs and dead processes without granting twice', async (t) => {
  const f = await fixture(t);
  const main = (args = {}) => f.call('hud_lease', { name: 'install', wait_s: 0, ...args });
  const closed = leaseWorker(t, f, 1);
  assert.deepEqual(await closed.lease({ wait_s: 0 }), { granted: true });
  closed.status('closed');
  assert.deepEqual(await main(), { granted: true });
  assert.deepEqual(await main({ release: true }), { released: true });

  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = once(proc, 'exit');
  t.after(() => proc.kill());
  const dead = leaseWorker(t, f, 2, f.root, proc.pid);
  // The fallback command must record the worker's PID, not its own short-lived PID.
  const fallback = spawnSync(process.execPath, [resolve('packages/hud-mcp/bin/hud-lease.mjs'), '--dir', dead.dir, '--wait-s', '0', 'install'],
    { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.deepEqual(JSON.parse(fallback.stdout), { granted: true });
  assert.equal((await main()).held_by.holder, dead.job);
  proc.kill();
  await exited;
  const other = leaseWorker(t, f, 3);
  const results = await Promise.all([main(), other.lease({ wait_s: 0 })]);
  assert.equal(results.filter((r) => r.granted).length, 1);
  assert.equal(results.find((r) => !r.granted).held_by.holder, results[0].granted ? 'w4E:p1' : other.job);
});

test('main sessions can hold and release a lease by pane', async (t) => {
  const f = await fixture(t);
  const name = 'shared install';
  assert.ok((await f.rpc('tools/list')).result.tools.some((tool) => tool.name === 'hud_lease'));
  assert.deepEqual(await f.call('hud_lease', { name }), { granted: true });
  const folder = join(f.env.HUD_HOME, 'leases'), [file] = fs.readdirSync(folder);
  const lease = JSON.parse(fs.readFileSync(join(folder, file), 'utf8'));
  assert.equal(lease.project, f.root);
  assert.equal(lease.name, name);
  assert.equal(lease.holder, f.env.HERDR_PANE_ID);
  assert.deepEqual(await f.call('hud_lease', { name, release: true }), { released: true });
  assert.deepEqual(await f.call('hud_lease', { name, release: true }), { released: false });
  const missing = spawnSync(process.execPath, [entry], { cwd: f.root, env: { ...f.env, PATH: join(f.root, 'empty') },
    encoding: 'utf8', input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'hud_lease', arguments: { name },
    } }) + '\n' });
  assert.equal(missing.status, 0, missing.stderr);
  const reply = JSON.parse(missing.stdout).result;
  assert.equal(reply.isError, true);
  assert.match(JSON.parse(reply.content[0].text).error, /requires util-linux flock/);
  assert.deepEqual(fs.readdirSync(folder), []);
});

test('hud-progress validates the job directory, normalizes text, and retains the newest 50', async (t) => {
  const f = await fixture(t);
  const { dir, job } = waitFixtureJob(f, 1);
  const log = join(dir, 'progress.jsonl');
  const run = (...args) => runProgress(f, dir, ...args);
  const outside = join(f.root, job);
  fs.cpSync(dir, outside, { recursive: true });
  assert.notEqual(run('--dir', outside, 'outside').status, 0);
  assert.notEqual(run(' \x07\n ').status, 0);
  assert.equal(fs.existsSync(join(outside, 'progress.jsonl')), false);
  assert.equal(fs.existsSync(log), false);
  const first = run('  Scanned\r\nnotes\x07\u0085  ');
  assert.equal(first.status, 0, first.stderr);
  const read = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(read()[0].text, 'Scanned notes');
  assert.ok(Number.isFinite(Date.parse(read()[0].at)));
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  const seed = Array.from({ length: 49 }, (_, i) => progressRecord(`Step ${i}`));
  fs.appendFileSync(log, jsonLines(seed));
  const inode = fs.statSync(log).ino;
  const rotated = run('--dir', dir, '进'.repeat(245));
  assert.equal(rotated.status, 0, rotated.stderr);
  assert.notEqual(fs.statSync(log).ino, inode, 'rotation publishes a fresh inode');
  assert.deepEqual(read().map((r) => r.text), [...seed.map((r) => r.text), '进'.repeat(240)]);
});

test('hud_report binds a fresh report to the turn token in the current CLI prompt', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'done-command', 20, true, 'claude');
  const job = await f.call('hud_create', { role: 'done-command', request_key: 'done-command', task: 'Synthetic task.' });
  const dir = job.task_dir, file = join(dir, 'done.json'), report = join(dir, 'report.md');
  const meta = join(dir, 'report-meta.json');
  const call = workerClient(t, f, dir);
  const listed = await call.rpc('tools/list');
  const { description, inputSchema } = listed.result.tools.find(({ name }) => name === 'hud_report');
  assert.match(description, /one-line plain summary.*code roles list the files changed/);
  assert.deepEqual(inputSchema.required, ['text', 'turn']);
  assert.equal(inputSchema.additionalProperties, false);
  assert.equal(inputSchema.properties.summary.maxLength, 320);
  assert.equal(inputSchema.properties.files.maxItems, 50);
  assert.equal(inputSchema.properties.files.items.maxLength, 260);
  const finish = (text, turn, fields) => call('hud_report', { text, turn, ...fields });
  const first = cliToken(dir);
  const prompts = () => f.commands().filter((c) => c.args[0] === 'agent' && c.args[1] === 'prompt');
  assert.match(prompts()[0].args[3], /Finish with hud_report/);
  assert.ok(prompts()[0].args[3].includes(`turn: ${first}`));
  assert.equal(fs.readFileSync(join(dir, 'brief.md'), 'utf8').trim(), 'Synthetic task.');
  assert.equal((await finish(' ', first)).isError, true, 'missing report');
  assert.equal((await finish('Synthetic first turn.\n')).isError, true, 'must supply the prompt token');
  for (const [key, value] of [['summary', null], ['files', [123]]]) {
    const rejected = await finish('Synthetic first turn.\n', first, { [key]: value });
    assert.equal(rejected.isError, true);
    assert.match(JSON.parse(rejected.content[0].text).error, new RegExp(`invalid_arguments: ${key}`));
  }
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(report), false);
  assert.deepEqual(resultValue(await finish('Synthetic first turn.\n', first, {
    summary: ' # Synthetic\nresult. ', files: ['./src/synthetic.ts', '../outside.ts'],
  })), { path: report });
  const done = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(turnToken(done), first);
  assert.equal(done.report_sig, reportSignature(dir));
  assert.deepEqual(Object.keys(done).sort(), ['at', 'report_sig', 'sent_at', 'seq']);
  assert.ok(Number.isFinite(Date.parse(done.at)));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const firstMeta = readReportMeta(dir);
  assert.equal(firstMeta.report_sig, done.report_sig);
  assert.equal(firstMeta.summary, 'Synthetic result.');
  assert.deepEqual(firstMeta.files, ['src/synthetic.ts']);
  assert.equal(fs.statSync(meta).mode & 0o777, 0o600);
  await until(() => cliState(dir)?.state === 'idle_grace');
  assert.equal((await f.call('hud_send', { job: job.job, message_key: 'continue', text: 'Synthetic continuation.' })).sent, true);
  const second = cliToken(dir);
  assert.notEqual(first, second);
  assert.ok(prompts().at(-1).args[3].includes(`turn: ${second}`));
  assert.notEqual(runProgress(f, dir, '--done', '--turn', second).status, 0, 'fallback rejects unchanged baseline report');
  assert.equal((await finish('Late report for first turn.\n', first, { summary: 'Stale result' })).isError, true, 'old turn cannot declare the new one');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), done, 'rejection leaves the previous receipt untouched');
  assert.equal(fs.readFileSync(report, 'utf8'), 'Synthetic first turn.\n', 'stale call does not replace the report');
  assert.deepEqual(readReportMeta(dir), firstMeta, 'stale call does not replace metadata');
  assert.deepEqual(resultValue(await finish('Synthetic second turn.\n', second)), { path: report });
  assert.equal(fs.existsSync(meta), false, 'old-style call clears the previous metadata');
  assert.equal(turnToken(JSON.parse(fs.readFileSync(file, 'utf8'))), second);
});

for (const mode of ['hud_report', 'shell fallback']) {
  test(`an agy CLI worker settles the current turn through ${mode}`, { timeout: 15000 }, async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
    writeCliRole(f, 'agy-worker', 20, true, 'agy');
    const job = await f.call('hud_create', { role: 'agy-worker', request_key: 'agy-report', task: 'Synthetic agy task.' });
    assert.equal(job.agent, `${job.job}-primary`, JSON.stringify(job));
    const dir = job.task_dir, report = join(dir, 'report.md');
    const tab = f.commands().find(({ args }) => args[0] === 'tab' && args[1] === 'create');
    const prefix = 'HUD_JOB_DIR=';
    const inheritedDir = tab.args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
    assert.equal(inheritedDir, dir);
    assert.equal(fs.readFileSync(join(dir, 'brief.md'), 'utf8').trim(), 'Synthetic agy task.');
    const receipt = () => JSON.parse(fs.readFileSync(join(dir, 'done.json'), 'utf8'));
    const prompt = () => f.commands().filter(({ args }) => args[1] === 'prompt').at(-1).args[3];
    const fallback = (token) => `node ${JSON.stringify(resolve('packages/hud-mcp/bin/hud-progress.mjs'))} --done --dir ${JSON.stringify(dir)} --turn ${token} [--summary "…"] [--file path]`;
    const assertPrompt = (token) => assert.equal(prompt().split('\n\n').at(-1), [
      `Finish with hud_report. Use the token in the prompt you are answering, not a newer turn. turn: ${token}`,
      `Only if hud_report is unavailable, write your report to ${JSON.stringify(report)} and run:`,
      fallback(token),
      '',
    ].join('\n'));

    let declare;
    if (mode === 'hud_report') {
      const { rpc } = workerClient(t, f, inheritedDir);
      const listed = await rpc('tools/list');
      assert.deepEqual(listed.result.tools.map(({ name }) => name), ['hud_report', 'hud_ask', 'hud_sonic', 'hud_progress', 'hud_lease']);
      assert.deepEqual(listed.result.tools[0].inputSchema.required, ['text', 'turn']);
      declare = async (turn, text) => {
        const { result, error } = await rpc('tools/call', {
          name: 'hud_report', arguments: { text, turn, summary: 'Synthetic agy result.', files: ['src/synthetic.ts'] },
          _meta: { 'antigravity.google/conversation_id': 'synthetic-agy-session', 'antigravity.google/root_conversation_id': 'synthetic-agy-root' },
        });
        assert.equal(error, undefined);
        if (result.isError) return JSON.parse(result.content[0].text).error;
        assert.deepEqual(resultValue(result), { path: report });
      };
    } else {
      declare = (turn) => {
        const { status, stderr } = runProgress(f, dir, '--done', '--turn', turn, '--summary', 'Synthetic agy result.', '--file', 'src/synthetic.ts');
        assert.ok(status === 0 || status === 1);
        return status === 1 ? stderr : undefined;
      };
    }

    const first = cliToken(dir);
    assertPrompt(first);
    await until(() => cliState(dir)?.state === 'working' && cliState(dir)?.agent_session_id);
    const session = cliState(dir).agent_session_id;
    if (mode === 'shell fallback') writeFixtureFile(report, 'Synthetic first agy report.\n');
    assert.equal(await declare(first, 'Synthetic first agy report.\n'), undefined);
    const done = receipt();
    assert.equal(turnToken(done), first);
    assert.equal(done.report_sig, reportSignature(dir));
    await until(() => cliState(dir)?.state === 'idle_grace');

    assert.equal((await f.call('hud_send', { job: job.job, message_key: 'continue', text: 'Synthetic continuation.' })).sent, true);
    const second = cliToken(dir);
    assert.notEqual(first, second);
    assertPrompt(second);
    await until(() => cliState(dir)?.state === 'working');
    if (mode === 'shell fallback') writeFixtureFile(report, 'Synthetic second agy report.\n');
    assert.match(await declare(first, 'Stale agy report.\n'), /use the turn token from the prompt you are answering/);
    assert.deepEqual(receipt(), done);
    if (mode === 'hud_report') assert.equal(fs.readFileSync(report, 'utf8'), 'Synthetic first agy report.\n');
    assert.equal(await declare(second, 'Synthetic second agy report.\n'), undefined);
    assert.equal(turnToken(receipt()), second);
    assert.equal(receipt().report_sig, reportSignature(dir));
    assert.equal(readReportMeta(dir).summary, 'Synthetic agy result.');
    assert.deepEqual(readReportMeta(dir).files, ['src/synthetic.ts']);
    await until(() => cliState(dir)?.state === 'idle_grace' && cliState(dir)?.output_written === true);
    assert.equal(cliState(dir).agent_session_id, session);
  });
}

test('hud-progress --done accepts a summary and repeated file paths without changing the receipt', async (t) => {
  const f = await fixture(t);
  const { dir, receipt } = waitFixtureJob(f, 1);
  const turn = { seq: 1, sent_at: receipt.created_at, report_sig: null };
  writeFixtureFile(join(dir, 'job.json'), JSON.stringify({ ...receipt, cli: true }));
  writeFixtureFile(join(dir, 'turn.json'), JSON.stringify(turn));
  writeFixtureFile(join(dir, 'report.md'), 'Synthetic fallback report.\n');
  const run = (...args) => runProgress(f, dir, ...args);
  for (const flag of ['--summary', '--file']) {
    const rejected = run(flag, 'synthetic', 'milestone');
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, new RegExp(`${flag} requires --done`));
  }
  assert.equal(fs.existsSync(join(dir, 'progress.jsonl')), false);
  const published = run('--done', '--turn', turnToken(turn), '--summary', ' Synthetic\nresult. ',
    '--file', './src/a,b.ts', '--file', 'src/c.ts');
  assert.equal(published.status, 0, published.stderr);
  assert.equal(published.stdout, '');
  const done = JSON.parse(fs.readFileSync(join(dir, 'done.json'), 'utf8'));
  assert.deepEqual(Object.keys(done).sort(), ['at', 'report_sig', 'sent_at', 'seq']);
  const { summary, files, report_sig } = readReportMeta(dir);
  assert.equal(summary, 'Synthetic result.');
  assert.deepEqual(files, ['src/a,b.ts', 'src/c.ts']);
  assert.equal(report_sig, done.report_sig);
  assert.equal(fs.statSync(join(dir, 'report-meta.json')).mode & 0o777, 0o600);
});

function runAsk(env, args) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-ask.mjs'), ...args], {
      env: { ...process.env, PATH: env.PATH, FAKE_LOG: env.FAKE_LOG, HOME: env.HOME, HUD_HOME: env.HUD_HOME },
    });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => done({ code, stdout, stderr }));
  });
}

test('implementer instructions tell workers to ask through hud_ask', () => {
  const text = fs.readFileSync(resolve('packages/hud-mcp/instructions/implementer.md'), 'utf8');
  assert.match(text, /hud_ask/);
  assert.doesNotMatch(text, /hud-ask|ask_orchestrator/);
  assert.match(text, /never a terminal prompt/i);
  assert.match(text, /Keep working/);
  assert.doesNotMatch(text, /write the question in your report and stop/);
});

test(
  'hud_ask round trip notifies the orchestrator and returns the hud_respond answer',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const id = 'j00000000000000a1',
      dir = join(f.env.HUD_HOME, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    writeFixtureFile(
      join(dir, 'job.json'),
      JSON.stringify({
        job: id,
        role: 'grok-imp',
        cwd: '/synthetic/MyHUD',
        herdr_pane: 'w4E:p1',
        created_at: new Date().toISOString(),
      })
    );
    writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working', harness: 'cli', agent: 'grok' }));
    fs.writeFileSync(join(dir, 'brief.md'), '# Synthetic ask\n');
    writeFixtureFile(join(dir, 'SESSION.txt'), 'LEFT=w4E:p2\nORCH=w4E:p1\n');
    const call = workerClient(t, f, dir);
    const pending = call('hud_ask', { question: 'Which layout?', options: ['rows', 'columns'], default: 'rows', context: 'card width' });
    await until(() => fs.existsSync(join(dir, 'qa', 'q1.md')));
    const body = fs.readFileSync(join(dir, 'qa', 'q1.md'), 'utf8');
    assert.match(body, /^# Question q1 from grok-imp@MyHUD\n/);
    assert.match(body, /Which layout\?/);
    assert.match(body, /Options:\n- rows\n- columns/);
    assert.match(body, /Default if unanswered: rows/);
    assert.match(body, /Context: card width/);
    assert.match(body, /Answer: write the answer to .*q1\.answer\.md/);
    await until(() => f.commands().some((c) => String(c.args.at(-1)).includes('QUESTION q1')));
    const notice = f.commands().find((c) => String(c.args.at(-1)).includes('QUESTION q1'));
    assert.equal(notice.args[2], 'w4E:p1');
    assert.match(
      notice.args.at(-1),
      /^\[grok-imp@MyHUD\] QUESTION q1: Which layout\? \| options: rows \/ columns \| default: rows \| full text: /
    );
    const read = await f.call('hud_read', { job: id });
    assert.equal(read.questions[0].id, 'q1');
    assert.match(read.questions[0].text, /Which layout\?/);
    const asking = workerFor(f, id);
    assert.equal(asking.homeNeedsHuman, true);
    assert.equal(asking.ask, 'Which layout?');
    await f.call('hud_respond', { job: id, request_id: 'q1', answer: 'columns' });
    const result = await pending;
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /ANSWER from the orchestrator \(q1, after \d+s\):\n\ncolumns/);
    assert.equal((await f.call('hud_read', { job: id })).questions, undefined);
  }
);

test('hud-ask prints the default when no answer arrives', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const id = 'j00000000000000a2',
    dir = join(f.env.HUD_HOME, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  writeFixtureFile(
    join(dir, 'job.json'),
    JSON.stringify({
      job: id,
      role: 'grok-imp',
      cwd: '/synthetic/MyHUD',
      herdr_pane: 'w4E:p1',
      created_at: new Date().toISOString(),
    })
  );
  writeFixtureFile(join(dir, 'SESSION.txt'), 'ORCH=w4E:p1\n');
  const result = await runAsk(f.env, [
    '--dir',
    dir,
    '--question',
    'Which layout?',
    '--default',
    'rows',
    '--timeout',
    '1',
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    /No answer to q1 within 1s \(pushed via "herdr agent prompt w4E:p1"\)\. Proposed default: rows\. Proceed on the default only if it is reversible and inside the brief; otherwise leave that part and name it as blocked in your report/
  );
  assert.equal(fs.existsSync(join(dir, 'qa', 'q1.md')), true);
});

function trackFsWatches(t) {
  const realWatch = fsDefault.watch;
  const stats = { opened: 0, closed: 0, active: 0 };
  fsDefault.watch = function trackedWatch(...args) {
    const watcher = realWatch.apply(this, args);
    stats.opened++;
    stats.active++;
    const realClose = watcher.close.bind(watcher);
    let closed = false;
    watcher.close = function trackedClose() {
      if (!closed) {
        closed = true;
        stats.closed++;
        stats.active--;
      }
      return realClose();
    };
    return watcher;
  };
  syncBuiltinESMExports();
  t.after(() => {
    fsDefault.watch = realWatch;
    syncBuiltinESMExports();
  });
  return stats;
}

test('worker-tools ask and waitSonic wake within 100 ms, settle on timeout, and close watchers on settle, timeout and abort', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const stats = trackFsWatches(t);
  const jobsRoot = join(f.env.HUD_HOME, 'jobs');
  const parentId = 'j00000000000000b0';
  const parentDir = join(jobsRoot, parentId);
  const parentJob = {
    job: parentId,
    role: 'imp',
    cwd: f.root,
    herdr_pane: '',
    created_at: new Date().toISOString(),
  };
  fs.mkdirSync(parentDir, { recursive: true });
  writeFixtureFile(join(parentDir, 'job.json'), JSON.stringify(parentJob));
  writeFixtureFile(join(parentDir, 'STATUS.json'), JSON.stringify({ state: 'working' }));

  // 1. ask wakes within 100 ms when q1.answer.md is written and closes its watcher.
  const waitingAsk = ask({ dir: parentDir, job: parentJob }, { question: 'Which mode?', default: 'fast' }, '5');
  await until(() => stats.active === 1);
  const answerAt = performance.now();
  writeFixtureFile(join(parentDir, 'qa', 'q1.answer.md'), 'event-driven\n');
  const reply = await waitingAsk;
  const askLatency = performance.now() - answerAt;
  assert.match(reply, /^ANSWER from the orchestrator \(q1, after 0s\):\n\nevent-driven$/);
  assert.ok(askLatency < 100, `ask wakeup expected < 100 ms, got ${askLatency.toFixed(1)} ms`);
  assert.equal(stats.active, 0);
  assert.equal(stats.closed, stats.opened);

  // 2. ask with timeout 0 opens no watcher; timeout 1 settles cleanly and closes its watcher.
  const openedBeforeZero = stats.opened;
  const noWaitReply = await ask({ dir: parentDir, job: parentJob }, { question: 'Immediate?', default: 'yes' }, '0');
  assert.match(noWaitReply, /^Question q2 recorded \(.*\); not waiting\./);
  assert.equal(stats.opened, openedBeforeZero);

  const askTimeoutStart = performance.now();
  const timedOutReply = await ask({ dir: parentDir, job: parentJob }, { question: 'Anyone there?', default: 'skip' }, '1');
  assert.ok(performance.now() - askTimeoutStart >= 950);
  assert.match(timedOutReply, /^No answer to q3 within 1s /);
  assert.equal(stats.active, 0);
  assert.equal(stats.closed, stats.opened);

  // 3. ask abort rejects immediately and leaves zero open watchers.
  const askAbort = new AbortController();
  const abortedAsk = ask({ dir: parentDir, job: parentJob }, { question: 'Cancel me?', default: 'no' }, '30', askAbort.signal);
  await until(() => stats.active === 1);
  const askAbortAt = performance.now();
  askAbort.abort();
  await assert.rejects(() => abortedAsk, (error) => error?.name === 'AbortError');
  assert.ok(performance.now() - askAbortAt < 100);
  assert.equal(stats.active, 0);
  assert.equal(stats.closed, stats.opened);

  // 4. waitSonic wakes within 100 ms on child reports and drops settled watchers early.
  const makeChild = (id) => {
    const childDir = join(jobsRoot, id);
    fs.mkdirSync(childDir, { recursive: true });
    writeFixtureFile(join(childDir, 'job.json'), JSON.stringify({
      job: id,
      parent_job: parentId,
      role: 'sonic',
      cwd: f.root,
      herdr_pane: 'w4E:p1',
      created_at: new Date().toISOString(),
    }));
    writeFixtureFile(join(childDir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
    return childDir;
  };
  const c1 = 'j00000000000000b1';
  const c2 = 'j00000000000000b2';
  const c1Dir = makeChild(c1);
  const c2Dir = makeChild(c2);

  const waitingSonic = waitSonic({ dir: parentDir, root: jobsRoot, job: parentJob }, [c1, c2], 5);
  await until(() => stats.active === 2);
  writeFixtureFile(join(c1Dir, 'report.md'), 'Child one report.');
  writeFixtureFile(join(c1Dir, 'STATUS.json'), JSON.stringify({ state: 'closed', output_written: true }));
  await until(() => stats.active === 1);

  const reportAt = performance.now();
  writeFixtureFile(join(c2Dir, 'report.md'), 'Child two report.');
  writeFixtureFile(join(c2Dir, 'STATUS.json'), JSON.stringify({ state: 'closed', output_written: true }));
  const collected = await waitingSonic;
  const sonicLatency = performance.now() - reportAt;
  assert.deepEqual(collected, {
    reports: [
      { id: c1, path: join(c1Dir, 'report.md'), body: 'Child one report.' },
      { id: c2, path: join(c2Dir, 'report.md'), body: 'Child two report.' },
    ],
    working: [],
    failed: [],
  });
  assert.ok(sonicLatency < 100, `waitSonic wakeup expected < 100 ms, got ${sonicLatency.toFixed(1)} ms`);
  assert.equal(fs.existsSync(join(c1Dir, 'sonic-collected')), true);
  assert.equal(fs.existsSync(join(c2Dir, 'sonic-collected')), true);
  assert.equal(stats.active, 0);
  assert.equal(stats.closed, stats.opened);

  // 5. waitSonic tolerates a transient non-atomic truncated STATUS.json write.
  const c3 = 'j00000000000000b3';
  const c3Dir = makeChild(c3);
  const waitingTrunc = waitSonic({ dir: parentDir, root: jobsRoot, job: parentJob }, [c3], 5);
  await until(() => stats.active === 1);
  writeFixtureFile(join(c3Dir, 'report.md'), 'Child three report.');
  fs.writeFileSync(join(c3Dir, 'STATUS.json'), '{"state":');
  setTimeout(() => writeFixtureFile(join(c3Dir, 'STATUS.json'), JSON.stringify({ state: 'done' })), 20);
  const truncResult = await waitingTrunc;
  assert.equal(truncResult.reports.length, 1);
  assert.equal(truncResult.reports[0].body, 'Child three report.');
  assert.equal(stats.active, 0);
  assert.equal(stats.closed, stats.opened);

  // 6. waitSonic timeout settles cleanly and abort rejects immediately with zero open watchers.
  const c4 = 'j00000000000000b4';
  makeChild(c4);
  const sonicTimeoutStart = performance.now();
  const timedOutSonic = await waitSonic({ dir: parentDir, root: jobsRoot, job: parentJob }, [c4], 0.12);
  assert.ok(performance.now() - sonicTimeoutStart >= 120);
  assert.deepEqual(timedOutSonic, { reports: [], working: [c4], failed: [] });
  assert.equal(stats.active, 0);
  assert.equal(stats.closed, stats.opened);

  const sonicAbort = new AbortController();
  const abortedSonic = waitSonic({ dir: parentDir, root: jobsRoot, job: parentJob }, [c4], 30, sonicAbort.signal);
  await until(() => stats.active === 1);
  const sonicAbortAt = performance.now();
  sonicAbort.abort();
  await assert.rejects(() => abortedSonic, (error) => error?.name === 'AbortError');
  assert.ok(performance.now() - sonicAbortAt < 100);
  assert.equal(stats.active, 0);
  assert.equal(stats.closed, stats.opened);
});

test('worker MCP hud_ask and hud_sonic wake within 100 ms and leave no open watchers', { timeout: 15000 }, async (t) => {
  const probe = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const watch = fs.watch;
let opened = 0, closed = 0;
const statsFile = process.env.HOME + '/worker-watch-stats.json';
const record = () => {
  const tmp = statsFile + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ opened, closed, active: opened - closed }));
  fs.renameSync(tmp, statsFile);
};
fs.watch = function(...args) {
  const w = watch.apply(this, args);
  opened++;
  record();
  const close = w.close.bind(w);
  let done = false;
  w.close = function() {
    if (!done) { done = true; closed++; record(); }
    return close();
  };
  return w;
};
syncBuiltinESMExports();`;
  const f = await fixture(t);
  const parent = await f.call('hud_create', { role: 'imp', request_key: 'event-wait-worker', task: 'Synthetic parent.' });
  const statsPath = join(f.env.HOME, 'worker-watch-stats.json');
  const watchStats = () => JSON.parse(fs.readFileSync(statsPath, 'utf8'));
  const call = workerClient(t, {
    ...f,
    env: { ...f.env, NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=data:text/javascript,${encodeURIComponent(probe)}`.trim() },
  }, parent.task_dir);

  // 1. hud_ask via MCP wakes within 100 ms of hud_respond.
  const pendingAsk = call('hud_ask', { question: 'Ship now?', default: 'wait' });
  await until(() => fs.existsSync(join(parent.task_dir, 'qa', 'q1.md')) && fs.existsSync(statsPath) && watchStats().active > 0);
  const respondAt = performance.now();
  await f.call('hud_respond', { job: parent.job, request_id: 'q1', answer: 'ship it' });
  const askResult = await pendingAsk;
  const askLatency = performance.now() - respondAt;
  assert.equal(askResult.isError, undefined);
  assert.match(askResult.content[0].text, /ANSWER from the orchestrator \(q1, after 0s\):\n\nship it/);
  assert.ok(askLatency < 100, `MCP hud_ask wakeup expected < 100 ms, got ${askLatency.toFixed(1)} ms`);
  assert.equal(watchStats().active, 0);

  // 2. hud_sonic wait via MCP wakes within 100 ms of child report settlement.
  const child = resultValue(await call('hud_sonic', { task: 'Synthetic child task.' })).job;
  const childDir = join(f.env.HUD_HOME, 'jobs', child);
  const pendingSonic = call('hud_sonic', { wait: [child], timeout_s: 5 });
  await until(() => watchStats().active > 0);
  const settleAt = performance.now();
  publishSonic(childDir, { state: 'closed', output_written: true });
  const sonicResult = resultValue(await pendingSonic);
  const sonicLatency = performance.now() - settleAt;
  assert.deepEqual(sonicResult, {
    reports: [{ id: child, path: join(childDir, 'report.md'), body: 'Synthetic implementation report.' }],
    working: [],
    failed: [],
  });
  assert.ok(sonicLatency < 100, `MCP hud_sonic wakeup expected < 100 ms, got ${sonicLatency.toFixed(1)} ms`);
  assert.equal(watchStats().active, 0);
  assert.equal(watchStats().closed, watchStats().opened);
});
