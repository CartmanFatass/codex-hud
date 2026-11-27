import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, rolePlacesFixture, cliState, resultValue, taskCall, taskJob, taskRpc, until, workerFor } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile as write } from '../helpers/thin-mcp-files.mjs';
import { isProcAlive } from '../../dist/utils/proc.js';
import { readContract } from '../../dist/harness/pi/worker/contract.js';
import { readSelectionExcerpts } from '../../dist/roles/selection-excerpts.js';
import { getJobIndexCache } from '../../dist/roles/job-index-cache.js';
import { executionRows } from '../../dist/render/execution-view.js';
import { initialMonitorState, renderMonitor, handleMonitorInput } from '../../dist/render/monitor.js';

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
if (process.argv.includes(join(process.env.HUD_JOB_DIR, 'sonic-session.jsonl'))) {
  if (fs.existsSync(join(process.env.HOME, 'hold-sonic'))) {
    const { until } = await import(${JSON.stringify(moduleUrl('../helpers/thin-mcp-harness.mjs'))});
    await until(() => fs.existsSync(join(process.env.HUD_JOB_DIR, 'release-sonic')), Infinity); // Released or reaped by the test.
  }
  await callWorkerTool('hud_report', { text: 'Synthetic sonic facts.' });
  process.exit(0);
}
const dir = process.env.HUD_JOB_DIR, args = process.argv, file = args[args.indexOf('--session') + 1];
assert.ok(file.startsWith(dir + '/sessions/'));
assert.ok(!args.includes('--no-session'));
const fresh = !fs.statSync(file).size;
if (fresh) fs.appendFileSync(file, JSON.stringify({ type: 'session', id: randomUUID(), cwd: process.cwd() }) + '\\n');
const id = JSON.parse(fs.readFileSync(file, 'utf8').split('\\n')[0]).id;
const { default: extension } = await import(args[args.indexOf('-e') + 1]);
assert.ok(!args.some(arg => /^--(?:hud-|role-bundle)/.test(arg)));
const hooks = new Map(), tools = {}, notices = [];
const option = name => args.includes(name) ? args[args.lastIndexOf(name) + 1] : undefined;
const model = (option('--model') ?? 'synthetic/native').split('/');
const replaceFile = join(process.env.HOME, 'replace-session');
const mismatch = process.env.HUD_RESUME_SESSION_ID && fs.existsSync(replaceFile) && fs.readFileSync(replaceFile, 'utf8');
const ctx = { model: { provider: model[0], id: model.at(-1) },
  sessionManager: { getSessionId: () => mismatch === 'id' ? 'replacement' : id,
    getSessionFile: () => mismatch === 'file' ? file + '.replacement' : file } };
let active = [];
await extension({ on: (name, fn) => hooks.set(name, [...hooks.get(name) ?? [], fn]),
  registerTool: t => tools[t.name] = t, sendMessage: message => notices.push(message),
  getAllTools: () => Object.keys(tools).map(name => ({ name })), getActiveTools: () => active,
  setActiveTools: names => { active = names; }, getThinkingLevel: () => option('--thinking') ?? 'off' });
const emit = (key, event, context = ctx) => (hooks.get(key) ?? []).map(fn => fn(event, context));
emit('session_start', {});
const advisor = Boolean(JSON.parse(fs.readFileSync(join(dir, 'job.json'))).selection_advisor);
assert.deepEqual([...active].sort(), advisor ? ['hud_report'] : ['hud_ask', 'hud_lease', 'hud_progress', 'hud_report', 'hud_sonic']);
const opts = { sections: {}, skills: [] };
const results = emit('before_agent_start', { systemPromptOptions: opts });
if (advisor) {
  assert.match(results.find(result => result?.systemPrompt)?.systemPrompt, /^Discuss only the supplied selection\\./);
  assert.equal(opts.sections.role, undefined);
  assert.ok(args.includes('--no-context-files'));
  assert.equal(option('--tools'), 'hud_report');
  assert.ok(!args.includes('--skill') && !args.includes('--append-system-prompt'));
} else fs.writeFileSync(join(dir, 'role-section'), opts.sections.role);
const prompt = args.at(-1);
fs.appendFileSync(file, JSON.stringify({ prompt }) + '\\n');
console.log(JSON.stringify({ id, prompt }));
const gate = fresh ? 'first' : 'next', home = process.env.HOME;
if (fs.existsSync(join(home, 'hold-' + gate))) {
  const { waitUntilFs } = await import(${JSON.stringify(moduleUrl('../../dist/utils/fs-wait.js'))});
  assert.ok(await waitUntilFs({ targets: [{ dir: home }], timeoutMs: Infinity, check: ({ timedOut }) => {
    const value = fs.existsSync(join(home, 'release-' + gate));
    return value || timedOut ? { done: true, value } : { done: false };
  } }));
}
if (advisor) {
  const reported = await tools.hud_report.execute('report', { text: fresh ? 'The hunk removes the duplicate.' : 'The guard still runs once.' });
  assert.equal(reported.terminate, true);
  assert.deepEqual(reported.details, { ok: true });
  assert.equal(reported.content[0].text, JSON.stringify({ ok: true }));
  assert.ok(!reported.content[0].text.includes(process.env.HUD_HOME) && !reported.content[0].text.includes(dir));
  emit('session_shutdown', {});
  process.exit(0);
}
await tools.hud_progress.execute('progress', { message: 'Synthetic progress.' });
if (fresh && fs.existsSync(join(process.env.HOME, 'ask'))) {
  if (fs.existsSync(join(home, 'hold-sonic'))) await tools.hud_sonic.execute('start', { task: 'Read a fact before the decision.' });
  const result = await tools.hud_ask.execute('ask', { question: 'Which value?', default: 'A' });
  assert.equal(result.terminate, true);
  assert.match(result.content[0].text, /answer resumes this session/);
  fs.appendFileSync(file, JSON.stringify({ toolResult: result }) + '\\n');
  let ended = false;
  emit('turn_end', { toolResults: [{ toolName: 'hud_ask' }, { toolName: 'hud_progress' }] }, { ...ctx, abort: () => ended = true });
  assert.ok(ended);
} else if (prompt !== 'No new report.') {
  if (prompt.startsWith('Collect after pause.')) {
    const child = fs.readdirSync(join(dir, '.sonic'))[0];
    assert.ok(prompt.includes('Sonic ' + child + ' settled. Collect its result with hud_sonic'));
    const collected = await tools.hud_sonic.execute('wait', { wait: [child], timeout_s: 0 });
    assert.equal(collected.details.reports[0].body, 'Synthetic sonic facts.');
  }
  if (prompt === 'Check C.') {
    const started = await tools.hud_sonic.execute('start', { task: 'Read a synthetic fact.' });
    const collected = await tools.hud_sonic.execute('wait', { wait: [started.details.job] });
    assert.equal(collected.details.reports[0].body, 'Synthetic sonic facts.');
    assert.deepEqual(notices, [], 'an active wait already received the report');
  }
  if (prompt.startsWith('Notify when ready.')) {
    const { until } = await import(${JSON.stringify(moduleUrl('../helpers/thin-mcp-harness.mjs'))});
    const started = await tools.hud_sonic.execute('start', { task: 'Read another synthetic fact.' });
    await until(() => notices.length > 0, 10000);
    assert.deepEqual(notices.map(n => n.customType), ['hud-sonic-ready']);
    assert.ok(notices[0].content.includes(started.details.job + ' settled'));
    await tools.hud_sonic.execute('wait', { wait: [started.details.job] });
  }
  const reported = await tools.hud_report.execute('report', { text: 'Synthetic report: ' + prompt });
  assert.equal(reported.terminate, true);
  assert.deepEqual(reported.details, { path: join(dir, 'report.md') });
  assert.equal(reported.content[0].text, JSON.stringify({ path: join(dir, 'report.md') }));
}
emit('session_shutdown', {});
`;

const create = f => f.call('hud_create', { role: 'imp', mode: 'headless', task: 'Synthetic change.' });
const closed = (job, limit) => until(() => {
  const state = cliState(job.task_dir);
  if (state?.state === 'failed') assert.fail(`${state.exit_reason}: ${fs.readFileSync(join(job.task_dir, 'stderr.log'), 'utf8')}`);
  return state?.state === 'closed' && read(join(job.task_dir, 'job.json')).reaped_at;
}, limit);
const noTab = f => !f.commands().some(({ args }) => args[0] === 'tab' && args[1] === 'create');

test('question, follow-up and land repair reopen the same tabless pi session; expiry starts a headless repair', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  f.overrideBin('pi', fakePi);
  write(join(f.env.HOME, 'ask'), '');
  const cwd = join(f.root, 'linked-cwd');
  fs.symlinkSync(f.root, cwd);
  const job = await f.call('hud_create', { role: 'imp', mode: 'headless', cwd, task: 'Synthetic change.' }), dir = job.task_dir;
  assert.equal(job.mode, 'headless');
  await until(() => cliState(dir)?.state === 'waiting_orchestrator', t.signal);
  const paused = cliState(dir);
  assert.ok(!isProcAlive(paused.pid));
  assert.equal(workerFor(f, job.job)?.latest_progress?.text, 'Synthetic progress.');
  const peek = await f.call('hud_peek', { job: job.job });
  assert.deepEqual(peek.status.question_ids, ['q1']);
  assert.match(JSON.stringify(peek), /Synthetic progress/);
  const answer = { job: job.job, request_id: 'q1', answer: 'Choose B.' };
  assert.equal((await f.call('hud_respond', answer)).written, true);
  await closed(job, t.signal);
  assert.match(fs.readFileSync(join(dir, 'report.md'), 'utf8'), /Choose B\./);
  assert.equal((await f.call('hud_respond', answer)).written, false);
  assert.equal((await f.call('hud_send', { job: job.job, text: 'Check C.' })).continuation, 'resumed');
  await closed(job, t.signal);
  const land = `import { dispatchLandRepair } from ${JSON.stringify(moduleUrl('../../dist/mcp/thin-main.js'))};\n    console.log(await dispatchLandRepair(${JSON.stringify(job.job)}, ${JSON.stringify(cwd)}, 'Synthetic land repair.', 'land:test', null));`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', land], { cwd: f.root, env: f.env, encoding: 'utf8' }).trim(), job.job);
  await closed(job, t.signal);
  const lines = fs.readFileSync(join(dir, 'stdout.jsonl'), 'utf8').trimEnd().split('\n').map(x => JSON.parse(x));
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map(x => x.id), Array(4).fill(paused.session_id));
  assert.deepEqual(lines.slice(1).map(x => x.prompt), ['Choose B.', 'Check C.', 'Synthetic land repair.']);
  assert.equal(cliState(dir).session_file, paused.session_file);
  const transcript = fs.readFileSync(paused.session_file, 'utf8');
  assert.ok(transcript.indexOf('toolResult') > 0 && transcript.indexOf('toolResult') < transcript.indexOf('Choose B.'));
  assert.equal(fs.existsSync(join(dir, 'SESSION.txt')), false);
  write(join(dir, 'STATUS.json'), JSON.stringify({ ...cliState(dir), ended_at: new Date(0).toISOString() }));
  const repair = await f.call('hud_send', { job: job.job, text: 'Expired follow-up.' });
  assert.equal(repair.continuation, 'repair');
  assert.notEqual(repair.job, job.job);
  assert.equal(repair.mode, 'headless');
  await until(() => cliState(repair.task_dir)?.state === 'waiting_orchestrator', t.signal);
  assert.notEqual(cliState(repair.task_dir).session_id, paused.session_id);
  assert.equal((await f.call('hud_close', { job: repair.job })).exit_code, 0);
  assert.equal(cliState(repair.task_dir).state, 'stopped');
  assert.ok(noTab(f));
});

test('selection advisor popup hides and reopens one native conversation, with independent jobs and explicit end', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.overrideBin('pi', fakePi);
  const home = f.env.HUD_HOME, roles = join(home, 'roles');
  fs.mkdirSync(roles, { recursive: true });
  for (const role of ['oracle', 'general']) write(join(roles, `${role}.json`), JSON.stringify({ role,
    instructions: role, run: [{ harness: 'pi', pi_role: 'architect' }], prewalk: 'on', can_continue: false }));
  write(join(home, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: f.root }] }));
  fs.mkdirSync(join(f.root, '.hud', 'agents'), { recursive: true });
  write(join(f.root, '.hud', 'brief.md'), 'Standing brief must not travel.');
  write(join(f.root, '.hud', 'agents', 'oracle.md'), 'Project agent prompt must not travel.');
  write(join(f.env.HOME, 'hold-first'), '');

  const excerpts = () => readSelectionExcerpts(home, getJobIndexCache(home), { project: f.root });
  const popup = (input) => {
    const cmd = `import { runComposerSession } from ${JSON.stringify(moduleUrl('../../dist/cli/select-send.js'))};
      const result = await runComposerSession({ ...${JSON.stringify(input)}, env: process.env, hudHome: process.env.HUD_HOME,
        stdin: process.stdin, stdout: process.stdout, onFrame: frame => console.log(JSON.stringify(frame)) });
      process.exitCode = result.code;`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', cmd], {
      env: { ...f.env, NO_COLOR: '1', LC_ALL: 'C' }, cwd: f.root, stdio: ['pipe', 'pipe', 'pipe'],
    });
    f.onCleanup(() => { child.stdin.destroy(); child.kill(); });
    let buffer = '', err = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { buffer += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { err += chunk; });
    const exited = once(child, 'exit');
    return { send: keys => child.stdin.write(keys), see: async text => {
      try { await until(() => buffer.includes(text), 6000); }
      catch { assert.fail(`popup did not show ${text}: ${err}\n${buffer.slice(-1600)}`); }
      return buffer.split('\n').find(line => line.includes(text));
    }, hide: async () => { child.stdin.end('\x1b'); assert.deepEqual(await exited, [0, null], err); return buffer; } };
  };
  const select = async text => {
    const ui = popup({ context: { selected_text: text, focused_pane_id: 'w4E:p1', focused_pane_cwd: f.root } });
    await ui.see(text);
    ui.send('\t\x1b[F');
    await ui.see('Ask an advisor');
    ui.send('\rWhy is this needed?\r');
    await ui.see('Advisor working');
    return ui;
  };

  const first = await select('- duplicate()');
  const [original] = excerpts(), dir = join(home, 'jobs', original.target);
  assert.equal(original.role, 'oracle');
  assert.equal(original.source.projectRoot, f.root);
  assert.equal(original.question, 'Why is this needed?');
  await first.hide();
  assert.equal(cliState(dir).state, 'working');
  write(join(f.env.HOME, 'release-first'), '');
  await closed({ task_dir: dir }, t.signal);
  const nativeId = cliState(dir).session_id;
  const prompt = JSON.parse(fs.readFileSync(join(dir, 'stdout.jsonl'), 'utf8').trim()).prompt;
  assert.match(prompt, /pane=w4E:p1/);
  assert.match(prompt, /- duplicate\(\)[\s\S]*Question: Why is this needed\?/);
  assert.doesNotMatch(prompt, /Standing brief|Project agent prompt/);
  assert.match(executionRows({ complete: true, jobs: [], excerpts: excerpts() }, undefined, 70, Date.now()).map(x => x.text).join('\n'), /The hunk removes the duplicate/);
  const cursor = `project:excerpt:${original.id}`;
  const state = { ...initialMonitorState(), activeTab: 'execution' };
  state.execution.cursor = cursor;
  const frame = renderMonitor({ state, width: 70, height: 25, execution: { complete: true, jobs: [], excerpts: excerpts() } });
  assert.deepEqual(handleMonitorInput(frame.state, { type: 'key', key: 'enter' }, { frame, nowMs: Date.now() }).action, { type: 'open-selection-advisor', id: original.id });

  const follow = popup({ advisorId: original.id });
  await follow.see('The hunk removes the duplicate.');
  await follow.see('Advisor ready for a follow-up');
  follow.send('Does the guard still run?\r');
  await follow.see('The guard still runs once.');
  await closed({ task_dir: dir }, t.signal);
  assert.equal(cliState(dir).session_id, nativeId);
  assert.equal(excerpts()[0].advisor.followups[0].question, 'Does the guard still run?');
  await follow.hide();
  const reopened = popup({ advisorId: original.id });
  await reopened.see('Does the guard still run?');
  await reopened.see('The guard still runs once.');
  await reopened.hide();

  write(f.env.HUD_SETTINGS_PATH, JSON.stringify({ selectionAdvisorRole: 'general' }));
  fs.unlinkSync(join(f.env.HOME, 'release-first'));
  const second = await select('+ guard()');
  const [other] = excerpts(), otherDir = join(home, 'jobs', other.target);
  assert.notEqual(other.target, original.target);
  assert.equal(other.role, 'general');
  second.send('/end\r');
  await second.see('Advisor ended');
  assert.equal(cliState(otherDir).state, 'stopped');
  assert.equal(excerpts()[0].advisor.ended, true);
  assert.equal(excerpts()[1].answer.text, 'The hunk removes the duplicate.');
  await second.hide();
  assert.ok(noTab(f));

  await t.test('failed launch with a job receipt leaves the composer draft editable', async () => {
    write(f.env.HUD_SETTINGS_PATH, JSON.stringify({ selectionAdvisorRole: 'fixture-advisor' }));
    write(join(roles, 'fixture-advisor.json'), JSON.stringify({ role: 'fixture-advisor', instructions: 'oracle', can_continue: true,
      run: [{ harness: 'cli', agent: 'claude' }] }));
    write(join(f.env.CLAUDE_CONFIG_DIR, '.claude.json'), '{}');
    const ui = popup({ context: { selected_text: '+ launch guard', focused_pane_id: 'w4E:p1', focused_pane_cwd: f.root } });
    await ui.see('+ launch guard');
    ui.send('\t\x1b[F\rKeep this draft.\r');
    const frame = await ui.see('Could not start advisor. Draft kept.');
    assert.match(frame, /claude has not trusted/);
    assert.match(frame, /Ask an advisor.*Question: Keep this draft\./);
    ui.send('\x7f!');
    await ui.see('Question: Keep this draft!');
    assert.doesNotMatch(await ui.hide(), /Selection advisor/);
    const [failed] = excerpts();
    assert.equal(cliState(join(home, 'jobs', failed.target)).state, 'failed');
  });
});

test('resumed Pi rejects a replacement session ID or file before delivering the answer', async t => {
  const f = await fixture(t);
  f.overrideBin('pi', fakePi);
  write(join(f.env.HOME, 'ask'), '');
  for (const replacement of ['id', 'file']) {
    const job = await f.call('hud_create', { role: 'imp', mode: 'headless', task: `Synthetic replacement ${replacement}.` });
    const dir = job.task_dir;
    await until(() => cliState(dir)?.state === 'waiting_orchestrator', t.signal);
    const session = cliState(dir).session_file;
    write(join(f.env.HOME, 'replace-session'), replacement);
    const answer = 'Do not deliver to the replacement.';
    assert.equal((await f.call('hud_respond', { job: job.job, request_id: 'q1', answer })).continuation, 'resumed');
    await until(() => cliState(dir)?.state === 'failed', t.signal);
    assert.match(fs.readFileSync(join(dir, 'stderr.log'), 'utf8'), /Pi did not open the recorded session/);
    assert.ok(!fs.readFileSync(join(dir, 'stdout.jsonl'), 'utf8').includes(answer));
    assert.ok(!fs.readFileSync(session, 'utf8').includes(answer));
  }
});

test('headless general resumes its own pi session with the borrowed role selectors', async t => {
  const f = await fixture(t);
  f.overrideBin('pi', fakePi);
  write(join(f.env.HOME, 'ask'), '');
  const roles = join(f.env.HUD_HOME, 'roles');
  fs.mkdirSync(roles);
  const source = join(roles, 'imp.json');
  write(source, JSON.stringify({ role: 'imp', instructions: 'implementer', can_continue: true,
    run: [{ harness: 'pi', pi_role: 'implementer' }], active_preset: 'synthetic',
    presets: [{ name: 'synthetic', run: [{ harness: 'cli', agent: 'agy' }, { harness: 'pi', pi_role: 'reviewer' }] }] }));
  const job = await f.call('hud_create', { role: 'general', mode: 'headless', instructions: 'imp', task: 'Synthetic comparison.' });
  const dir = job.task_dir;
  await until(() => cliState(dir)?.state === 'waiting_orchestrator', t.signal);
  const session = cliState(dir).session_id;
  assert.ok(session);
  // Changing the source's active chain must not change an existing session's launch selectors.
  write(source, JSON.stringify({ role: 'imp', instructions: 'reviewer', can_continue: true,
    run: [{ harness: 'pi', pi_role: 'reviewer' }] }));
  assert.equal((await f.call('hud_respond', { job: job.job, request_id: 'q1', answer: 'Choose B.' })).continuation, 'resumed');
  await closed(job, t.signal);
  assert.equal(cliState(dir).session_id, session);
  assert.equal(read(join(dir, 'job.json')).instructions_from, 'imp');
  const contract = readContract(dir);
  assert.equal(contract.instructions, 'implementer');
  assert.equal(contract.guard, 'strict');
  assert.equal(contract.model, undefined, 'use the general seat’s native defaults, not the borrowed role defaults');
  assert.equal(contract.thinking, undefined);
  assert.equal(fs.readFileSync(join(dir, 'role-section'), 'utf8'), fs.readFileSync('packages/hud-mcp/instructions/implementer.md', 'utf8').trim());
});

test('headless presets resolve profile defaults and report Sonic ready once on a closed PATH', async t => {
  const f = await rolePlacesFixture(t);
  f.overrideBin('pi', fakePi);
  const roles = join(f.env.HUD_HOME, 'roles');
  fs.mkdirSync(roles);
  write(join(roles, 'general.json'), JSON.stringify({ role: 'general', instructions: 'general', can_continue: true,
    run: [{ harness: 'pi' }], presets: [
      { name: 'review', run: [{ harness: 'pi', pi_role: 'reviewer' }] },
      { name: 'advice', run: [{ harness: 'pi', pi_role: 'architect', thinking: 'low' }] },
    ] }));
  for (const [preset, model, thinking, guard] of [
    ['review', 'openai/gpt-6.2-sol', 'xhigh', 'strict'], ['advice', 'openai/gpt-6.2-astra', 'low', 'oracle'],
  ]) {
    const task = preset === 'review' ? 'Notify when ready.' : 'Synthetic advice.';
    const job = await f.call('hud_create', { role: 'general', preset, mode: 'headless', task });
    assert.ok(job.task_dir, JSON.stringify(job));
    await closed(job, t.signal);
    const contract = readContract(job.task_dir);
    assert.deepEqual([contract.model, contract.thinking, contract.guard], [model, thinking, guard]);
    const receipt = read(join(job.task_dir, 'job.json'));
    assert.deepEqual([receipt.model, receipt.thinking], [model, thinking]);
  }
  write(join(roles, 'custom.json'), JSON.stringify({ role: 'custom', can_continue: true, run: [{ harness: 'pi', pi_role: 'security-reviewer' }] }));
  const invalid = await f.call('hud_create', { role: 'custom', mode: 'headless', task: 'Not launched.' });
  assert.equal(invalid.code, 'role_unavailable');
  assert.match(invalid.reason, /Unknown pi_role; expected sonic, implementer, reviewer, architect, general/);
});

test('a sonic survives its headless pi parent asking; resume carries ready input, stop reaps instead', async t => {
  const f = await fixture(t);
  f.overrideBin('pi', fakePi);
  write(join(f.env.HOME, 'hold-sonic'), '');
  write(join(f.env.HOME, 'ask'), '');
  for (const stop of [false, true]) {
    const job = await f.call('hud_create', { role: 'imp', mode: 'headless', task: 'Synthetic child ' + stop });
    const dir = job.task_dir;
    await until(() => cliState(dir)?.state === 'waiting_orchestrator', t.signal);
    const [id] = fs.readdirSync(join(dir, '.sonic')), child = join(f.env.HUD_HOME, 'jobs', id);
    const runner = cliState(child).pid;
    assert.ok(!isProcAlive(cliState(dir).pid) && isProcAlive(runner));
    if (stop) {
      assert.equal((await f.call('hud_close', { job: job.job })).exit_code, 0);
      assert.equal(cliState(child).state, 'stopped');
    } else {
      write(join(child, 'release-sonic'), '');
      await closed({ task_dir: child }, t.signal);
      assert.ok(!fs.existsSync(join(child, 'sonic-collected')));
      assert.equal((await f.call('hud_respond', { job: job.job, request_id: 'q1', answer: 'Collect after pause.' })).written, true);
      await closed(job, t.signal);
      assert.ok(fs.existsSync(join(child, 'sonic-collected')));
    }
    assert.ok(!isProcAlive(runner));
  }
});

test('queued pi sends run in order after a report and keep the original MCP task', { timeout: 60000 }, async t => {
  const f = await fixture(t), rpc = taskRpc(f.rpc);
  f.overrideBin('pi', fakePi);
  const signal = file => write(join(f.env.HOME, file), '');
  signal('hold-first');
  signal('hold-next');
  await rpc('server/discover');
  const task = await taskCall(rpc, 'hud_create', { role: 'imp', mode: 'headless', task: 'Synthetic intermediate report.' });
  const job = taskJob(f, task), dir = job.task_dir;
  const firstPid = cliState(dir).pid;
  const send = args => taskCall(rpc, 'hud_send', args).then(resultValue);
  const get = () => rpc('tasks/get', { taskId: task.taskId });
  const first = { job: job.job, text: 'First queued follow-up.', message_key: 'first' };
  assert.deepEqual(await send(first), { ok: true, sent: true, queued: true });
  assert.equal(await send(first).then(reply => reply.sent), false);
  assert.deepEqual(await send({ jobs: [job.job], text: 'Second queued follow-up.' }),
    { sent: [job.job], skipped: [], queued: [job.job] });
  assert.equal(fs.statSync(join(dir, 'headless-sends.json')).mode & 0o777, 0o600);
  assert.equal((await get()).status, 'working');
  signal('release-first');
  const stdout = join(dir, 'stdout.jsonl');
  await until(() => fs.readFileSync(stdout, 'utf8').includes('Second queued follow-up.'), t.signal);
  assert.notEqual(cliState(dir).pid, firstPid);
  assert.ok(!isProcAlive(firstPid));
  assert.match(fs.readFileSync(join(dir, 'report.md'), 'utf8'), /Synthetic intermediate report/);
  assert.equal((await get()).status, 'working');
  const lines = fs.readFileSync(stdout, 'utf8').trimEnd().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].id, lines[0].id);
  assert.equal(lines[1].prompt, 'First queued follow-up.\n\nSecond queued follow-up.');
  signal('release-next');
  await closed(job, t.signal);
  const result = await get();
  assert.equal(result.status, 'completed');
  assert.match(result.result.content[0].text, /First queued follow-up/);
  assert.equal(await send(first).then(reply => reply.sent), false);
  assert.ok(!fs.existsSync(join(dir, 'headless-sends.json')) && noTab(f));
});

test('queued pi sends accompany the answer when the working turn ends with a question', async t => {
  const f = await fixture(t), rpc = taskRpc(f.rpc);
  f.overrideBin('pi', fakePi);
  write(join(f.env.HOME, 'ask'), '');
  write(join(f.env.HOME, 'hold-first'), '');
  await rpc('server/discover');
  const task = await taskCall(rpc, 'hud_create', { role: 'imp', mode: 'headless', task: 'Synthetic task chain.' });
  const job = taskJob(f, task);
  const queued = await taskCall(rpc, 'hud_send', { job: job.job, text: 'Also check the fixture.' });
  assert.equal(resultValue(queued).queued, true);
  write(join(f.env.HOME, 'release-first'), '');
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator', t.signal);
  const response = await taskCall(rpc, 'hud_respond', { job: job.job, request_id: 'q1', answer: 'Keep going.' });
  assert.equal(response.resultType, 'complete');
  await closed(job, t.signal);
  const result = await rpc('tasks/get', { taskId: task.taskId });
  assert.equal(result.status, 'completed');
  assert.match(result.result.content[0].text, /Keep going/);
  assert.match(fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8'), /Keep going\.\n\nAlso check the fixture\./);
  assert.deepEqual(read(join(job.task_dir, 'job.json')).answered_by, { q1: 'orchestrator' });
});

test('the panel Answer action resumes the paused session and records who answered', async t => {
  const f = await fixture(t);
  f.overrideBin('pi', fakePi);
  write(join(f.env.HOME, 'ask'), '');
  const job = await create(f), dir = job.task_dir;
  await until(() => fs.existsSync(join(dir, 'qa/q1.md')), t.signal); // The owner can answer before the asking turn exits.
  const action = `import { answerFromPanel } from ${JSON.stringify(moduleUrl('../../dist/panel/actions.js'))};\n    console.log(JSON.stringify(await answerFromPanel(process.env.HUD_HOME, process.argv[1], 'q1', 'Panel B.', 'imp')));`;
  const answer = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', action, job.job], { cwd: f.root, env: f.env, encoding: 'utf8' }));
  assert.deepEqual(answer(), { ok: true, written: true });
  await closed(job, t.signal);
  assert.match(fs.readFileSync(join(dir, 'report.md'), 'utf8'), /Panel B\./);
  assert.deepEqual(answer(), { ok: true, written: false });
  assert.equal(read(join(f.env.HUD_HOME, 'panel-actions.jsonl')).answer, 'Panel B.');
  assert.deepEqual(read(join(dir, 'job.json')).answered_by, { q1: 'owner' });
  assert.ok(noTab(f));
});

test('queued headless imp can overflow without borrowing the general role definition', async t => {
  const f = await fixture(t);
  const roles = join(f.env.HUD_HOME, 'roles');
  fs.mkdirSync(roles, { recursive: true });
  write(join(roles, 'general.json'), JSON.stringify({ role: 'general', instructions: 'general', can_continue: false,
    run: [{ harness: 'pi', model: 'synthetic/general' }] }));
  const settings = { autoPrewalk: false, roleCaps: { imp: 1, general: 1 }, impOverflow: false };
  write(f.env.HUD_SETTINGS_PATH, JSON.stringify(settings));
  assert.equal((await f.call('hud_create', { role: 'imp', task: 'Fill the imp slot.' })).state, 'working');
  f.overrideBin('pi', fakePi);
  const queued = await create(f);
  assert.equal(queued.state, 'queued');
  write(f.env.HUD_SETTINGS_PATH, JSON.stringify({ ...settings, impOverflow: true }));
  await closed(queued, t.signal);
  const receipt = read(join(queued.task_dir, 'job.json'));
  assert.equal(receipt.role, 'general');
  assert.equal(receipt.overflow_from, 'imp');
  assert.equal(receipt.headless, true);
  assert.equal(receipt.model, 'openai/gpt-6.2-sol');
  write(join(queued.task_dir, 'STATUS.json'), JSON.stringify({ ...cliState(queued.task_dir), ended_at: new Date(0).toISOString() }));
  const replacement = await f.call('hud_send', { job: queued.job, text: 'Expired overflow follow-up.' });
  assert.equal(replacement.continuation, 'repair');
  assert.equal(replacement.overflow_from, 'imp', JSON.stringify(replacement));
  await closed(replacement, t.signal);
  assert.equal(read(join(replacement.task_dir, 'job.json')).model, receipt.model);
});

test('direct and queued unrouted headless creates skip incompatible places and pre-input rejections', async t => {
  const f = await fixture(t);
  const roles = join(f.env.HUD_HOME, 'roles');
  fs.mkdirSync(roles, { recursive: true });
  write(join(roles, 'general.json'), JSON.stringify({ role: 'general', instructions: 'general', can_continue: true, run: [
    { harness: 'cli', agent: 'codex' }, { harness: 'cli', agent: 'claude' }, { harness: 'pi', model: 'synthetic/fallback' },
  ] }));
  write(join(f.env.CLAUDE_CONFIG_DIR, '.claude.json'), '{}');
  f.overrideBin('pi', fakePi);
  for (const queued of [false, true]) {
    if (queued) {
      write(f.env.HUD_SETTINGS_PATH, JSON.stringify({ roleCaps: { general: 1 } }));
      assert.equal((await f.call('hud_create', { role: 'general', task: 'Hold a slot.', on: 'pi' })).state, 'working');
    }
    const job = await f.call('hud_create', { role: 'general', mode: 'headless', task: `Fallback (queued: ${queued}).` });
    assert.ok(job.job, JSON.stringify(job));
    if (queued) {
      assert.equal(job.state, 'queued');
      write(f.env.HUD_SETTINGS_PATH, JSON.stringify({ roleCaps: { general: 0 } }));
    }
    await closed(job, t.signal);
    const receipt = read(join(job.task_dir, 'job.json'));
    assert.equal(receipt.attempts.length, 2);
    assert.match(receipt.attempts[0].reason, /claude has not trusted/);
    assert.equal(receipt.model, 'synthetic/fallback');
    assert.equal(receipt.headless, true);
    assert.equal(receipt.caller_pane, 'w4E:p1');
    assert.equal(Object.hasOwn(receipt, 'herdr_pane'), false);
  }
});

test('old report cannot settle a resumed turn and unsupported launches refuse headless mode', async t => {
  const f = await fixture(t);
  for (const options of [{ role: 'reviewer' }, { role: 'imp', pi_args: ['--no-session'] }]) {
    assert.equal((await f.call('hud_create', { ...options, mode: 'headless', task: 'Synthetic rejection.' })).code, 'invalid_arguments');
  }
  const cli = await f.call('hud_create', { role: 'general', on: 'codex', mode: 'headless', task: 'Synthetic rejection.' });
  assert.equal(cli.code, 'invalid_arguments');
  assert.equal(cli.error, 'headless mode requires pi, claude or agy');
  f.overrideBin('pi', fakePi);
  const job = await create(f);
  await closed(job, t.signal);
  assert.equal((await f.call('hud_send', { job: job.job, text: 'No new report.' })).continuation, 'resumed');
  await until(() => cliState(job.task_dir)?.state === 'failed', t.signal);
  assert.equal(cliState(job.task_dir).exit_reason, 'pi exited without a declared report');
  assert.ok(noTab(f));
});

test('hud_close and panel stop reap the live headless worker and its detached child', async t => {
  const exitProbe = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
if (process.argv[1]?.endsWith('/hud-watch.mjs')) {
  const read = fs.readFileSync, kill = process.kill;
  let exiting;
  fs.readFileSync = (file, ...args) => {
    if (exiting && file === '/proc/' + exiting + '/cmdline') {
      const pid = exiting;
      fs.writeFileSync(process.env.HOME + '/saw-empty-cmdline', String(pid));
      exiting = undefined;
      setImmediate(() => kill(pid, 'SIGKILL')); // Finish exiting once the watcher has sampled cmdline.
      return '';
    }
    return read(file, ...args);
  };
  process.kill = (pid, signal) => {
    if (signal !== 'SIGKILL' || !read('/proc/' + pid + '/cmdline', 'utf8').includes('/sonic-run.mjs')) return kill(pid, signal);
    exiting = pid;
    return true;
  };
  syncBuiltinESMExports();
}`;
  const preload = ' --import=data:text/javascript,' + encodeURIComponent(exitProbe);
  const f = await fixture(t, { probe: `process.env.NODE_OPTIONS += ${JSON.stringify(preload)}` });
  f.env.NODE_OPTIONS += preload; // Either the MCP or the panel process can launch the watcher.
  f.overrideBin('pi', `#!${process.execPath}
import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
if (!process.argv.includes('--print')) process.exit(1);
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
writeFileSync(process.env.HUD_JOB_DIR + '/pids', JSON.stringify([process.pid, child.pid]));`);
  for (const panel of [false, true]) {
    const job = await f.call('hud_create', { role: 'imp', task: 'Synthetic live worker ' + panel, mode: 'headless' });
    const file = join(job.task_dir, 'pids');
    await until(() => fs.existsSync(file) && fs.statSync(file).size, t.signal);
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
    assert.equal(fs.readFileSync(join(f.env.HOME, 'saw-empty-cmdline'), 'utf8'), String(pids[0]));
  }
});
