import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { judge, procStat, REPORT_SETTLED_EXIT } from '../../dist/mcp/cli-judge.js';
import { sonicState } from '../../dist/worker/sonic-jobs.js';
import {
  cliState, cliToken, fakeCliWithChild, fixture, publishPiGrace, readCloseReaped, resultValue,
  taskCall, taskRpc, until, workerClient, writeCliRole,
} from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile as write } from '../helpers/thin-mcp-files.mjs';

const json = (dir, file) => JSON.parse(fs.readFileSync(join(dir, file), 'utf8'));
const starts = (f) => f.commands().filter(({ args }) => args[0] === 'agent' && args[1] === 'start');
const dead = (pid) => !procStat(pid) || procStat(pid).state === 'Z';
const reaped = (job) => !!readCloseReaped(job) && cliState(job.task_dir)?.exit_reason === REPORT_SETTLED_EXIT;

async function cliFixture(t, agent = 'claude', resume_s) {
  const f = await fixture(t);
  write(join(f.env.HOME, 'manual-socket'), '');
  write(join(f.env.HOME, 'tab-seq'), '1');
  writeCliRole(f, 'resumable', 20, true, agent);
  const roster = join(f.env.HUD_HOME, 'roles');
  if (resume_s !== undefined) write(join(roster, 'resumable.json'), JSON.stringify({ ...json(roster, 'resumable.json'), resume_s }));
  const worker = fakeCliWithChild(t, f);
  const job = await f.call('hud_create', { role: 'resumable', task: 'Synthetic original brief.' });
  const dir = job.task_dir;
  await until(() => cliState(dir)?.pid === worker.pid && cliState(dir)?.agent_session_id, t.signal);
  write(join(dir, 'reap-worker'), '');
  const report = workerClient(t, f, dir);
  return { f, job, worker, report: (text) => report('hud_report', { text, turn: cliToken(dir), summary: text }) };
}

test('Claude closes without a read, resumes the exact session in a new pane, and repairs after expiry', async (t) => {
  const { f, job, worker, report } = await cliFixture(t);
  const dir = job.task_dir;
  const objective = { id: 'delivery', title: 'Synthetic delivery' };
  write(join(dir, 'job.json'), JSON.stringify({ ...json(dir, 'job.json'), objective }));
  const first = cliToken(dir), id = cliState(dir).agent_session_id;
  assert.equal(json(dir, 'job.json').resume_s, 1620);
  assert.equal(resultValue(await report('Synthetic first report.')).path, join(dir, 'report.md'));
  assert.equal(cliState(dir).state, 'working');
  assert.equal(readCloseReaped(job), undefined);
  f.push(job.job, 'done');
  await until(() => reaped(job) && dead(worker.pid), t.signal);
  assert.equal(json(dir, 'job.json').read_at, undefined);
  const originalPane = starts(f)[0].args[starts(f)[0].args.indexOf('--pane') + 1];
  const next = fakeCliWithChild(t, f);
  const sent = await f.call('hud_send', { job: job.job, text: 'Synthetic continuation.', message_key: 'next-turn' });
  assert.equal(sent.continuation, 'resumed');
  assert.equal(sent.job, job.job);
  const resumed = starts(f).at(-1).args;
  assert.equal(resumed[resumed.indexOf('--resume') + 1], id);
  assert.notEqual(resumed[resumed.indexOf('--pane') + 1], originalPane);
  assert.ok(f.commands().filter(({ args }) => args[0] === 'tab' && args[1] === 'create')
    .every(({ args }) => args[args.indexOf('--cwd') + 1] === f.root));
  assert.notEqual(cliToken(dir), first);
  assert.equal(readCloseReaped(job), undefined);
  assert.equal((await f.call('hud_send', { job: job.job, text: 'Synthetic duplicate.', message_key: 'next-turn' })).sent, false);

  await until(() => cliState(dir)?.pid === next.pid && cliState(dir)?.agent_session_id === id, t.signal);
  resultValue(await report('Synthetic second report.'));
  f.push(job.job, 'idle');
  await until(() => reaped(job) && dead(next.pid), t.signal);
  write(join(dir, 'STATUS.json'), JSON.stringify({ ...cliState(dir), ended_at: new Date(Date.now() - 1621_000).toISOString() }));
  const repair = await f.call('hud_send', { job: job.job, text: 'Synthetic expired continuation.' });
  assert.equal(repair.continuation, 'repair');
  assert.notEqual(repair.continued_as, job.job);
  assert.equal(repair.job, repair.continued_as);
  assert.deepEqual(json(repair.task_dir, 'job.json').objective, objective);
  assert.match(fs.readFileSync(join(repair.task_dir, 'brief.md'), 'utf8'), /Synthetic expired continuation/);
  assert.equal(starts(f).at(-1).args.includes('--resume'), false);
});

test('the watcher leaves a reopening CLI turn working and its send task completes at the new report', async (t) => {
  const { f, job, worker, report } = await cliFixture(t);
  const dir = job.task_dir, oldSupervisor = cliState(dir).supervisor_pid;
  // Keep the watcher running across closure. This second CLI job also witnesses a scan
  // while the new turn has been admitted but its prompt hasn't returned a supervisor yet.
  const sibling = 'jffffffffffffffff', other = join(f.env.HUD_HOME, 'jobs', sibling);
  fs.mkdirSync(other);
  write(join(other, 'job.json'), JSON.stringify({ ...json(dir, 'job.json'), job: sibling }));
  write(join(other, 'STATUS.json'), JSON.stringify({ state: 'working' }));
  resultValue(await report('Synthetic previous report.'));
  f.push(job.job, 'done');
  await until(() => reaped(job) && dead(worker.pid) && dead(oldSupervisor), t.signal);
  f.closeTab(); // The old tab's closure is not a fact about the replacement either.

  const next = fakeCliWithChild(t, f), rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  write(join(f.env.HOME, 'hold-prompt-result'), '');
  const seen = new Set();
  const changes = fs.watch(dir, (_event, name) => { if (name === 'STATUS.json') seen.add(cliState(dir)?.state); });
  t.after(() => changes.close());
  const sending = taskCall(rpc, 'hud_send', { job: job.job, text: 'Synthetic next turn.' });
  await until(() => json(dir, 'turn.json').seq === 2, t.signal);
  // The same dead PID really is current for the sibling, not for the reopened job.
  write(join(other, 'supervisor.pid'), `${oldSupervisor}\n`);
  await until(() => cliState(other)?.state === 'waiting_orchestrator', t.signal);
  assert.equal(cliState(other).reason, 'supervisor exited; worker liveness unknown');
  assert.equal(cliState(dir).state, 'working');
  write(join(f.env.HOME, 'release-prompt-result'), '');
  const task = await sending;
  assert.equal(task.continuation, 'resumed');
  const get = () => rpc('tasks/get', { taskId: task.taskId });
  assert.equal((await get()).status, 'working');
  await until(() => cliState(dir)?.pid === next.pid, t.signal);
  assert.deepEqual([...seen], ['working']);
  assert.equal((await get()).status, 'working');
  resultValue(await report('Synthetic resumed result.'));
  f.push(job.job, 'done');
  await until(() => reaped(job), t.signal);
  const result = await get();
  assert.equal(result.status, 'completed');
  assert.match(result.result.content[0].text, /Synthetic resumed result/);
});

test('an unconfirmed native CLI session receives no input and falls back to repair', async (t) => {
  const { f, job, worker, report } = await cliFixture(t);
  resultValue(await report('Synthetic report before mismatch.'));
  f.push(job.job, 'done');
  await until(() => reaped(job) && dead(worker.pid), t.signal);
  const first = cliToken(job.task_dir);
  write(join(f.env.HOME, 'wrong-native-session'), '');
  const repair = await f.call('hud_send', { job: job.job, text: 'Synthetic repair after mismatch.' });
  assert.equal(repair.continuation, 'repair');
  assert.notEqual(repair.job, job.job);
  assert.equal(cliToken(job.task_dir), first);
  assert.equal(f.commands().filter(({ args }) => args[1] === 'prompt' && args[2] === job.agent).length, 1);
});

test('Codex uses the recorded thread ID and honors the role resume window', async (t) => {
  const { f, job, worker, report } = await cliFixture(t, 'codex', 900);
  const id = cliState(job.task_dir).agent_session_id;
  assert.equal(json(job.task_dir, 'job.json').resume_s, 900);
  resultValue(await report('Synthetic Codex report.'));
  f.push(job.job, 'idle');
  await until(() => reaped(job) && dead(worker.pid), t.signal);
  fakeCliWithChild(t, f);
  assert.equal((await f.call('hud_send', { job: job.job, text: 'Synthetic Codex continuation.' })).continuation, 'resumed');
  const args = starts(f).at(-1).args;
  assert.deepEqual(args.slice(args.indexOf('--') + 2, args.indexOf('--') + 4), ['resume', id]);
});

test('pi closes on native settlement after hud_report and resumes the saved file under the same job task', async (t) => {
  const f = await fixture(t);
  await f.startCliSocket();
  write(join(f.env.HOME, 'defer-pi-report'), '');
  const worker = fakeCliWithChild(t, f);
  const job = await f.call('hud_create', { role: 'imp', task: 'Synthetic Pi brief.' });
  const dir = job.task_dir, file = join(f.env.PI_CODING_AGENT_DIR, 'example.jsonl'), id = 'synthetic-pi-session';
  write(file, JSON.stringify({ type: 'session', id, cwd: f.root }) + '\n');
  const session = { session_file: file, session_id: id };
  write(join(dir, 'reap-worker'), '');
  write(join(dir, 'STATUS.json'), JSON.stringify({ ...session, version: 1, task_dir: dir, slot: 'primary', state: 'working',
    pid: worker.pid, pid_start_time: procStat(worker.pid).start }));
  const report = workerClient(t, f, dir);
  resultValue(await report('hud_report', { text: 'Synthetic native first result.', summary: 'First.' }));
  assert.equal(readCloseReaped(job), undefined, 'report publication alone is not a native turn end');
  await publishPiGrace(t, job, worker, false, session);
  await until(() => reaped(job) && dead(worker.pid), t.signal);
  assert.equal(json(dir, 'job.json').read_at, undefined);
  const previous = json(dir, 'job.json').pi_sent_at;
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const task = await taskCall(rpc, 'hud_send', { job: job.job, text: 'Synthetic Pi continuation.' });
  assert.equal(task.resultType, 'task');
  assert.equal(task.continuation, 'resumed');
  assert.equal(task.job, job.job);
  const args = starts(f).at(-1).args;
  assert.deepEqual(args.slice(-2), ['--session', file]);
  assert.equal(cliState(dir).session_id, id);
  assert.ok(json(dir, 'job.json').pi_sent_at > previous);
  await publishPiGrace(t, job, undefined, true, session);
  const result = await rpc('tasks/get', { taskId: task.taskId });
  assert.equal(result.status, 'completed');
});

test('native Pi settlement does not close while a question is open', async (t) => {
  const f = await fixture(t);
  await f.startCliSocket();
  const job = await f.call('hud_create', { role: 'imp', task: 'Synthetic question job.' });
  const qa = join(job.task_dir, 'qa');
  write(join(qa, 'q1.md'), 'Synthetic decision?');
  await publishPiGrace(t, job);
  await f.call('hud_read', { job: job.job });
  assert.equal(cliState(job.task_dir).state, 'idle_grace');
  assert.equal(readCloseReaped(job), undefined);
  write(join(qa, 'q1.answer.md'), 'Synthetic answer.');
  await until(() => reaped(job), t.signal);
});

const turn = { seq: 1, sent_at: new Date(0).toISOString(), report_sig: null };
const facts = { closeAtReport: true, turn, reportSig: null, reportRead: false, alive: true, status: 'idle',
  liveChild: false, stop: false, close: false, openQuestions: false, canContinue: true, graceMs: 60_000 };
const receipt = { ...turn, report_sig: 'fresh', at: new Date(1000).toISOString() };
const declared = { ...facts, reportSig: 'fresh', done: receipt };
const decideAfterQuiet = (input) => judge(judge(null, input, 1000), input, 61_000);

test('exit matrix: lost process or tab before a report fails', () => {
  assert.equal(judge(null, { ...facts, alive: false }, 1000).exitReason, 'worker exited');
  assert.equal(judge(null, { ...facts, tabClosed: true }, 1000).exitReason, 'tab closed');
});

test('exit matrix: rejected dispatch fails without admitting a turn', async (t) => {
  const f = await fixture(t);
  write(join(f.env.HOME, 'fail-start'), 'synthetic start refused');
  const job = await f.call('hud_create', { role: 'imp', task: 'Synthetic rejected job.' });
  assert.equal(job.ok, false);
  assert.equal(cliState(job.task_dir).state, 'failed');
  assert.equal(f.commands().some(({ args }) => args[1] === 'prompt'), false);
});

test('exit matrix: quiet without a report uses the existing Decision outcomes', () => {
  const quiet = decideAfterQuiet(facts);
  assert.equal(quiet.action, 'decide');
  for (const [action, expected] of Object.entries({ wait: 'working', 'prompt-report': 'working', fail: 'failed', 'needs-human': 'waiting_orchestrator' })) {
    assert.equal(judge(quiet, { ...facts, decision: { action, failReason: 'synthetic quota' } }, 61_001).state, expected);
  }
});

test('exit matrix: a hand-written draft without declaration follows the quiet rule even after read', () => {
  const draft = decideAfterQuiet({ ...facts, reportSig: 'draft', reportRead: true });
  assert.equal(draft.action, 'decide');
  assert.equal(draft.outputWritten, false);
});

test('exit matrix: chat completion without a report follows the quiet rule', () => {
  assert.equal(decideAfterQuiet({ ...facts, status: 'done' }).action, 'decide');
});

test('exit matrix: stop intent wins; non-stop early close retains its existing behavior', () => {
  assert.equal(judge(null, { ...declared, stop: true, tabClosed: true }, 1000).state, 'stopped');
  const close = judge(null, { ...facts, close: true }, 1000);
  assert.equal(close.state, 'closed');
  assert.equal(close.exitReason, 'settled');
});

test('exit matrix: a headless sonic missing its report stays failed', (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'sonic-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Native pi-roles emits this terminal receipt when its headless run has no fresh output.
  write(join(dir, 'STATUS.json'), JSON.stringify({ state: 'failed', output_written: false, exit_reason: 'output missing, empty or unchanged' }));
  assert.deepEqual(sonicState(dir), { state: 'failed', reason: 'output missing, empty or unchanged' });
});

test('exit matrix: a rewritten report or a new turn invalidates the declaration', () => {
  const early = judge(null, { ...declared, status: 'working' }, 1000);
  assert.equal(judge(early, { ...declared, reportSig: 'rewrite' }, 2000).state, 'working');
  assert.equal(judge(early, { ...declared, turn: { ...turn, seq: 2, report_sig: 'fresh' } }, 2000).state, 'working');
});

test('exit matrix: wait up to 120 seconds for a turn end; keep questions and sonic ahead of closure', () => {
  const early = judge(null, { ...declared, status: 'working' }, 1000);
  assert.equal(early.wakeAt, 121_000);
  assert.equal(judge(early, { ...declared, statusAt: 999 }, 2000).state, 'working', 'old idle is not the end of this turn');
  assert.equal(judge(early, { ...declared, status: 'working' }, 121_000).state, 'waiting_orchestrator');
  assert.equal(judge(early, declared, 121_001).state, 'waiting_orchestrator');
  assert.equal(judge(early, { ...declared, openQuestions: true }, 2000).state, 'waiting_orchestrator');
  assert.equal(judge(early, { ...declared, sonic: { open: true, uncollected: [] } }, 2000).state, 'working');
  assert.equal(judge(early, { ...declared, sonic: { open: false, uncollected: ['j0000000000000001'] } }, 2000).action, 'collect-sonic');
  assert.equal(judge(early, declared, 2000).exitReason, REPORT_SETTLED_EXIT);
});
