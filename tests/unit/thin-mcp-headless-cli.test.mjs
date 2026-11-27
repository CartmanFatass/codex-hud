import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { cliState, entry, fixture, resultValue, taskCall, taskJob, taskRpc, until } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile as write } from '../helpers/thin-mcp-files.mjs';
import { isProcAlive } from '../../dist/utils/proc.js';

const url = path => new URL(path, import.meta.url).href;
const read = path => JSON.parse(fs.readFileSync(path));
const fakeCli = agent => `#!${process.execPath}
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { rpcClient, until } from ${JSON.stringify(url('../helpers/thin-mcp-harness.mjs'))};
const agent = ${JSON.stringify(agent)}, dir = process.env.HUD_JOB_DIR;
const args = process.argv.slice(2), value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const prompt = args.at(-1), resumed = value(agent === 'claude' ? '--resume' : '--conversation');
const advisor = Boolean(JSON.parse(fs.readFileSync(join(dir, 'job.json'))).selection_advisor);
assert.equal(process.env.HERDR_PANE_ID, undefined);
assert.equal(value('--output-format'), 'stream-json');
assert.ok(args.includes('-p'));
let id, file;
if (agent === 'claude') {
  assert.ok(args.includes('--verbose') && args.includes('--strict-mcp-config'));
  assert.equal(args.at(-2), '--');
  assert.equal(value('--session-id') !== undefined, !resumed);
  id = resumed ?? value('--session-id');
  assert.match(id, /^[0-9a-f-]{36}$/);
  file = value('--mcp-config');
  assert.equal(file, join(dir, 'worker-mcp.json'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  if (advisor) {
    assert.equal(value('--tools'), '');
    assert.equal(value('--setting-sources'), '');
    assert.match(value('--system-prompt'), /^Discuss only the supplied selection\./);
    assert.ok(!args.includes('--append-system-prompt-file'));
  }
} else {
  assert.equal(args.at(-2), '-p');
  assert.equal(value('--mcp-config'), undefined);
  id = 'synthetic-agy-conversation';
  file = join(process.env.HOME, '.gemini/config/mcp_config.json');
}
if (resumed) assert.equal(resumed, fs.readFileSync(join(dir, 'fake-session'), 'utf8'));
else fs.writeFileSync(join(dir, 'fake-session'), id, { flag: 'wx' });
const init = agent === 'claude' ? { type: 'system', subtype: 'init', session_id: id }
  : { event: 'init', conversation_id: prompt.startsWith('Wrong init.') ? 'different-agy-conversation' : id };
// Assistant output and earlier turns are not evidence of the current native session.
console.log(JSON.stringify({ type: 'assistant', event: 'step_update', session_id: 'not-init', conversation_id: 'not-init' }));
if (!prompt.startsWith('No init.')) console.log(JSON.stringify(init));
console.log(JSON.stringify({ pid: process.pid, resumed, prompt: prompt.split('\\n')[0] }));
if (prompt.startsWith('No init.') || prompt.startsWith('Wrong init.')) process.exit(0);
const hud = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.hud;
assert.equal(hud.alwaysLoad, agent === 'claude' ? true : undefined);
const child = spawn(hud.command, hud.args ?? [], { env: { ...process.env, ...hud.env }, stdio: ['pipe', 'pipe', 'inherit'] });
const exited = once(child, 'exit');
const rpc = rpcClient(child);
try {
  const { result } = await rpc('tools/list');
  assert.deepEqual(result.tools.map(tool => tool.name), advisor ? ['hud_report'] : ['hud_report', 'hud_ask', 'hud_sonic', 'hud_progress', 'hud_lease']);
  assert.deepEqual(result.tools[0].inputSchema.required, ['text', 'turn']);
  const call = async (name, args) => {
    const { result, error } = await rpc('tools/call', { name, arguments: args });
    assert.equal(error, undefined);
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return result.content[0].text;
  };
  if (!advisor) await call('hud_progress', { message: 'Synthetic headless CLI progress.' });
  if (advisor) await call('hud_report', { turn: /turn: (\\S+)/.exec(prompt)[1], text: 'Synthetic advisor answer.' });
  else if (!resumed) {
    await call('hud_sonic', { task: 'Read a synthetic fact.' });
    if (prompt.includes('Synthetic plain turn.')) await until(() => fs.existsSync(join(dir, 'release-first')), Infinity); // Released or reaped by the test.
    else {
      await call('hud_ask', { question: 'Which value?', default: 'A' });
      fs.writeFileSync(join(dir, 'continued-after-ask'), 'Unexpected next action');
      setInterval(() => {}, 1000); // The fake never volunteers to end the turn.
    }
  } else {
    const turn = /turn: (\\S+)/.exec(prompt)[1];
    if (prompt.startsWith('Choose B.') || prompt.startsWith('Synthetic next CLI turn.')) {
      const [id] = fs.readdirSync(join(dir, '.sonic'));
      const plain = prompt.startsWith('Synthetic next CLI turn.');
      assert.ok(prompt.includes('Sonic ' + id + (plain ? ' still running.' : ' settled.')));
      if (plain) fs.writeFileSync(join(process.env.HUD_HOME, 'jobs', id, 'release-sonic'), '');
      const result = JSON.parse(await call('hud_sonic', { wait: [id] }));
      assert.equal(result.reports[0].body, 'Synthetic implementation report.');
    }
    // CLI reports need not have collected all children. Closing cannot leak this runner.
    if (prompt.startsWith('Check C.')) await call('hud_sonic', { task: 'Another synthetic fact.' });
    await call('hud_report', { turn, text: 'Synthetic report: ' + prompt.split('\\n')[0] });
  }
} finally { child.stdin.end(); }
assert.deepEqual(await exited, [0, null]);
`;

test('default selection advisor runs a report-only Claude Code turn', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  f.overrideBin('claude', fakeCli('claude'));
  const code = `import { startSelectionAdvisor } from ${JSON.stringify(url('../../dist/roles/selection-advisor.js'))};
    const { advisor: row } = await startSelectionAdvisor(process.env.HUD_HOME, { excerpt: '+ synthetic guard', question: 'Why?',
      source: { project: 'fixture', projectRoot: process.cwd(), pane: 'w4E:p1', job: null, role: null, time: new Date().toISOString() } }, process.env);
    console.log(JSON.stringify(row));`;
  const row = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: f.root, env: f.env, encoding: 'utf8' }));
  const dir = join(f.env.HUD_HOME, 'jobs', row.target);
  assert.equal(row.role, 'oracle');
  assert.equal(read(join(dir, 'job.json')).cli.agent, 'claude');
  await until(() => {
    const status = cliState(dir);
    if (status?.state === 'failed') assert.fail(fs.readFileSync(join(dir, 'stderr.log'), 'utf8'));
    return status?.state === 'closed';
  }, t.signal);
  assert.equal(read(join(f.env.HUD_HOME, 'selection-excerpts.json'))[0].answer.text, 'Synthetic advisor answer.');
});

test('working headless Claude resumes queued input after a plain turn end', { timeout: 60000 }, async t => {
  const f = await fixture(t), rpc = taskRpc(f.rpc);
  f.overrideBin('claude', fakeCli('claude'));
  write(join(f.env.HOME, 'hold-sonic'), '');
  const roles = join(f.env.HUD_HOME, 'roles');
  fs.mkdirSync(roles, { recursive: true });
  write(join(roles, 'frontend-imp.json'), JSON.stringify({ role: 'frontend-imp', harness: 'cli', agent: 'claude',
    can_continue: true, instructions: 'frontend-implementer' }));
  await rpc('server/discover');
  const task = await taskCall(rpc, 'hud_create', { role: 'frontend-imp', mode: 'headless', task: 'Synthetic plain turn.' });
  const { job, task_dir: dir } = taskJob(f, task);
  const sent = await taskCall(rpc, 'hud_send', { jobs: [job], text: 'Synthetic next CLI turn.' });
  assert.deepEqual(resultValue(sent), { sent: [job], skipped: [], queued: [job] });
  write(join(dir, 'release-first'), '');
  await until(() => {
    const status = cliState(dir);
    if (status?.state === 'failed' && status.exit_reason !== 'claude exited without a declared report')
      assert.fail(`${status.exit_reason}: ${fs.readFileSync(join(dir, 'stderr.log'), 'utf8')}`);
    return status?.state === 'closed' && read(join(dir, 'job.json')).reaped_at;
  }, t.signal);
  const invocations = fs.readFileSync(join(dir, 'stdout.jsonl'), 'utf8').trimEnd().split('\n').map(JSON.parse).filter(row => row.pid);
  assert.equal(invocations.length, 2);
  assert.notEqual(invocations[0].pid, invocations[1].pid);
  assert.equal(invocations[1].resumed, fs.readFileSync(join(dir, 'fake-session'), 'utf8'));
  assert.equal(invocations[1].prompt, 'Synthetic next CLI turn.');
  const result = await rpc('tasks/get', { taskId: task.taskId });
  assert.equal(result.status, 'completed');
  assert.match(result.result.content[0].text, /Synthetic next CLI turn/);
});

for (const [agent, role] of [['claude', 'frontend-imp'], ['agy', 'general']]) {
  test(`${agent} headless runs one MCP-enabled process per question, answer, send and repair turn`, async t => {
    const f = await fixture(t);
    f.overrideBin(agent, fakeCli(agent));
    write(join(f.env.HOME, 'hold-sonic'), '');
    const roles = join(f.env.HUD_HOME, 'roles');
    fs.mkdirSync(roles, { recursive: true });
    write(join(roles, `${role}.json`), JSON.stringify({ role, harness: 'cli', agent, can_continue: true,
      instructions: agent === 'claude' ? 'frontend-implementer' : 'general' }));
    const config = join(f.env.HOME, '.gemini/config/mcp_config.json');
    const registered = JSON.stringify({ mcpServers: { hud: { command: entry, disabled: false, env: { HUD_MCP_SURFACE: 'roles' } } } });
    if (agent === 'agy') {
      fs.mkdirSync(join(f.env.HOME, '.gemini/config'), { recursive: true });
      write(config, registered);
    }
    const job = await f.call('hud_create', { role, mode: 'headless', task: 'Synthetic CLI task.' });
    assert.equal(job.mode, 'headless', JSON.stringify(job));
    const dir = job.task_dir, status = () => cliState(dir);
    const wait = state => until(() => {
      if (state !== 'failed' && status()?.state === 'failed')
        assert.fail(`${status().exit_reason}: ${fs.readFileSync(join(dir, 'stderr.log'), 'utf8')}`);
      return status()?.state === state && (state === 'waiting_orchestrator' || read(join(dir, 'job.json')).reaped_at);
    }, t.signal);
    await wait('waiting_orchestrator');
    assert.ok(!fs.existsSync(join(dir, 'continued-after-ask')));
    const [sonic] = fs.readdirSync(join(dir, '.sonic'));
    const childDir = id => join(f.env.HUD_HOME, 'jobs', id);
    assert.ok(isProcAlive(cliState(childDir(sonic)).pid));
    write(join(childDir(sonic), 'release-sonic'), '');
    await until(() => cliState(childDir(sonic))?.state === 'closed', t.signal);
    const id = status().agent_session_id;
    const native = { harness: agent, id };
    const sessions = () => read(join(dir, 'job.json')).sessions;
    assert.deepEqual(sessions(), [native]);
    assert.ok(id && !isProcAlive(status().pid));
    assert.equal(status().slot, 'headless');
    assert.equal(status().agent, agent);
    assert.deepEqual((await f.call('hud_peek', { job: job.job })).status.question_ids, ['q1']);
    assert.equal((await f.call('hud_respond', { job: job.job, request_id: 'q1', answer: 'Choose B.' })).continuation, 'resumed');
    await wait('closed');
    assert.match(fs.readFileSync(join(dir, 'report.md'), 'utf8'), /Choose B\./);
    assert.equal((await f.call('hud_send', { job: job.job, text: 'Check C.' })).continuation, 'resumed');
    await wait('closed');
    const leftover = childDir(fs.readdirSync(join(dir, '.sonic')).find(id => id !== sonic));
    await until(() => cliState(leftover)?.state === 'stopped', t.signal);
    assert.ok(!isProcAlive(cliState(leftover).pid));
    const land = `import { dispatchLandRepair } from ${JSON.stringify(url('../../dist/mcp/thin-main.js'))};
      console.log(await dispatchLandRepair(process.argv[1], process.cwd(), 'Synthetic repair.', 'land:test', null));`;
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', land, job.job], { cwd: f.root, env: f.env, encoding: 'utf8' }).trim(), job.job);
    await wait('closed');
    assert.match(fs.readFileSync(join(dir, 'report.md'), 'utf8'), /Synthetic repair\./);
    assert.equal(status().agent_session_id, id);
    assert.deepEqual(sessions(), [native], 'native land repair resumes the same session without duplicating it');
    const invocations = fs.readFileSync(join(dir, 'stdout.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.pid);
    assert.equal(new Set(invocations.map(row => row.pid)).size, 4);
    assert.deepEqual(invocations.map(row => row.resumed), [undefined, id, id, id]);
    assert.deepEqual(invocations.slice(1).map(row => row.prompt), ['Choose B.', 'Check C.', 'Synthetic repair.']);
    assert.ok(!fs.existsSync(join(dir, 'SESSION.txt')));
    assert.ok(!f.commands().some(({ args }) => args[0] === 'tab' && args[1] === 'create'));
    if (agent === 'agy') assert.equal(fs.readFileSync(config, 'utf8'), registered);

    const text = agent === 'claude' ? 'No init.' : 'Wrong init.';
    assert.equal((await f.call('hud_send', { job: job.job, text })).continuation, 'resumed');
    await wait('failed');
    assert.equal(status().agent_session_id, null);
    assert.match(status().exit_reason, /did not open the recorded session/);
    assert.deepEqual(sessions(), agent === 'claude' ? [native] : [native, { harness: agent, id: 'different-agy-conversation' }]);
  });
}
