import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { watchCommand } from '../../dist/cli/watch.js';
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

async function cliFixture(t, agent = 'claude', resume_s, role = 'resumable') {
  const f = await fixture(t);
  write(join(f.env.HOME, 'manual-socket'), '');
  write(join(f.env.HOME, 'tab-seq'), '1');
  writeCliRole(f, role, 20, true, agent);
  const roster = join(f.env.HUD_HOME, 'roles'), file = `${role}.json`;
  if (resume_s !== undefined || role === 'imp') write(join(roster, file), JSON.stringify({ ...json(roster, file), resume_s,
    ...(role === 'imp' && { instructions: 'implementer' }) }));
  const worker = fakeCliWithChild(t, f);
  const job = await f.call('hud_create', { role, task: 'Synthetic original brief.', prewalk: false });
  const dir = job.task_dir;
  await until(() => cliState(dir)?.pid === worker.pid && cliState(dir)?.agent_session_id, t.signal);
  write(join(dir, 'reap-worker'), '');
  const report = workerClient(t, f, dir);
  return { f, job, worker, report: (text) => report('hud_report', { text, turn: cliToken(dir), summary: text }) };
}

test('Imp closes without a read, resumes the exact Claude session, and escalates a repair after expiry', async (t) => {
  const { f, job, worker, report } = await cliFixture(t, 'claude', undefined, 'imp');
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
  assert.equal(json(dir, 'job.json').role, 'imp');
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
  const replacement = json(repair.task_dir, 'job.json');
  assert.equal(replacement.role, 'frontier-imp');
  assert.equal(replacement.route.source, 'repair-route');
  assert.equal(replacement.model, 'openai/gpt-6.2-astra');
  assert.equal(replacement.thinking, 'xhigh');
  assert.deepEqual(replacement.objective, objective);
  assert.match(fs.readFileSync(join(repair.task_dir, 'brief.md'), 'utf8'), /Synthetic expired continuation/);
  assert.equal(starts(f).at(-1).args.includes('--resume'), false);
});

test('Antigravity closes after declaration even if a detached daemon keeps herdr working', { timeout: 15000 }, async (t) => {
  const { f, job, worker, report } = await cliFixture(t, 'agy');
  const daemon = await worker.start('sleep', ['30'], true);
  const start = procStat(daemon).start;
  t.after(() => { if (procStat(daemon)?.start === start) process.kill(daemon, 'SIGKILL'); });
  f.push(job.job, 'working'); // Never send done or idle for this turn.
  assert.equal(dead(daemon), false);
  resultValue(await report('Synthetic report with a lingering daemon.'));
  await until(() => reaped(job) && dead(worker.pid) && dead(daemon), t.signal);
  assert.equal(json(job.task_dir, 'job.json').read_at, undefined);
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

test('an unconfirmed native CLI session receives no input, restores the original and falls back to repair', async (t) => {
  const { f, job, worker, report } = await cliFixture(t);
  resultValue(await report('Synthetic report before mismatch.'));
  f.push(job.job, 'done');
  await until(() => reaped(job) && dead(worker.pid), t.signal);
  const first = cliToken(job.task_dir), reapedAt = readCloseReaped(job);
  const candidate = fakeCliWithChild(t, f);
  write(join(f.env.HOME, 'wrong-native-session'), '');
  const repair = await f.call('hud_send', { job: job.job, text: 'Synthetic continuation with mismatched session.' });
  assert.equal(repair.continuation, 'repair');
  assert.notEqual(repair.job, job.job);
  assert.notEqual(repair.ok, false, JSON.stringify(repair));
  assert.equal(cliToken(job.task_dir), first);
  assert.equal(readCloseReaped(job), reapedAt);
  assert.match(json(job.task_dir, 'job.json').resume_failures.at(-1).reason, /did not open the recorded session/);
  assert.ok(dead(candidate.pid));
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
  assert.deepEqual(args.slice(args.indexOf('--') + 1, args.indexOf('--') + 3), ['resume', id]);
});

const tabFor = (job) => /^TAB=(.+)$/m.exec(fs.readFileSync(join(job.task_dir, 'SESSION.txt'), 'utf8'))[1];

for (const closeCurrent of [false, true]) test(closeCurrent
  ? 'a buffered close of a reused Pi address is silent; exact root exit fails and wakes the mod'
  : 'a delayed close of the old Pi tab does not fail or wake during resume', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  await f.startCliSocket();
  write(join(f.env.HOME, 'tab-seq'), '1');
  write(join(f.env.HOME, 'defer-pi-report'), '');
  // Keep the watcher subscribed across the original turn's settlement.
  const sibling = await f.call('hud_create', { role: 'general', on: 'pi', task: 'Synthetic sibling.' });
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
  const oldTab = tabFor(job);
  const ac = new AbortController(), wakes = [];
  const watch = watchCommand(['--mod'], { env: f.env, stdout: (line) => wakes.push(...JSON.parse(line).lines), stderr: assert.fail },
    { signal: ac.signal, settlementWindowMs: 0 });
  const failed = (job) => wakes.some(line => line.startsWith(`${job.job} `) && line.includes('failed | worker exited (code 3)'));
  try {
    await until(() => wakes.some(line => line.startsWith(`${job.job} `) && line.includes('First.')), t.signal);
    const launchCount = () => f.socketRequests.filter(req => req.method === 'agent.start').length;
    const launched = launchCount();
    const next = fakeCliWithChild(t, f);
    if (closeCurrent) write(join(f.env.HOME, 'tab-seq'), String(Number(oldTab.split(':t')[1]) - 1));
    else write(join(f.env.HOME, 'hold-direct-start'), '');
    const sending = taskCall(rpc, 'hud_send', { job: job.job, text: 'Synthetic Pi continuation.' });
    let task;
    try {
      if (!closeCurrent) {
        // The working STATUS is published, but the replacement tab hasn't been created.
        await until(() => launchCount() > launched, t.signal);
        f.closeTab(oldTab);
        f.exitAgent(sibling.job, 3); // A second event witnesses processing of the first.
        await until(() => failed(sibling), t.signal);
        assert.equal(cliState(dir).state, 'working');
      }
    } finally {
      if (!closeCurrent) write(join(f.env.HOME, 'release-prompt-result'), '');
      task = await sending;
    }
    assert.equal(task.resultType, 'task');
    assert.equal(task.continuation, 'resumed');
    assert.equal(task.job, job.job);
    const args = starts(f).at(-1).args;
    assert.deepEqual(args.slice(-2), ['--session', file]);
    assert.equal(cliState(dir).session_id, id);
    assert.ok(json(dir, 'job.json').pi_sent_at > previous);
    if (closeCurrent) {
      assert.equal(tabFor(job), oldTab, 'the replacement got the same synthetic tab ID');
      f.emitTabClosed(oldTab);
      f.exitAgent(sibling.job, 3);
      await until(() => failed(sibling), t.signal);
      assert.equal(cliState(dir).state, 'working');
      assert.equal(failed(job), false);
      f.exitAgent(job.job, 3);
      await until(() => failed(job), t.signal);
      assert.equal(cliState(dir).state, 'failed');
      assert.equal(cliState(dir).exit_reason, 'worker exited (code 3)');
    } else {
      assert.notEqual(tabFor(job), oldTab);
      f.closeTab(oldTab); // A duplicate delayed event after the replacement is live is harmless too.
      assert.equal((await f.call('hud_peek', { job: job.job })).status.state, 'working');
      assert.equal(cliState(dir).pid, next.pid);
      resultValue(await report('hud_report', { text: 'Synthetic native second result.', summary: 'Second.' }));
      await publishPiGrace(t, job, next, false, session);
      await until(() => reaped(job) && dead(next.pid), t.signal, 'the resumed report should settle and reap');
      const result = await rpc('tasks/get', { taskId: task.taskId });
      assert.equal(result.status, 'completed');
      assert.match(result.result.content[0].text, /Summary: Second\./);
      await until(() => wakes.some(line => line.startsWith(`${job.job} `) && line.includes('Second.')), t.signal, 'the resumed report should wake the mod');
      assert.equal(failed(job), false);
      assert.equal(json(dir, 'job.json').read_at, undefined, 'wake delivery does not mark the report read');
    }
  } finally { ac.abort(); await watch; }
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
  stop: false, close: false, openQuestions: false, canContinue: true, graceMs: 60_000 };
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
  // Native pi emits this terminal receipt when its headless run has no fresh output.
  write(join(dir, 'STATUS.json'), JSON.stringify({ state: 'failed', output_written: false, exit_reason: 'output missing, empty or unchanged' }));
  assert.deepEqual(sonicState(dir), { state: 'failed', reason: 'output missing, empty or unchanged' });
});

test('exit matrix: a rewritten report or a new turn invalidates the declaration', () => {
  const early = judge(null, { ...declared, status: 'working' }, 1000);
  assert.equal(judge(early, { ...declared, reportSig: 'rewrite' }, 11_000).state, 'working');
  assert.equal(judge(early, { ...declared, turn: { ...turn, seq: 2, report_sig: 'fresh' } }, 11_000).state, 'working');
});

test('exit matrix: close on done/idle or after 10 seconds; open questions and Sonic still block closure', () => {
  const working = { ...declared, status: 'working' };
  const early = judge(null, working, 1000);
  assert.equal(early.wakeAt, 11_000);
  assert.equal(judge(early, { ...declared, statusAt: 999 }, 2000).state, 'working', 'old idle is not the end of this turn');
  for (const status of ['done', 'idle']) {
    assert.equal(judge(early, { ...declared, status }, 2000).exitReason, REPORT_SETTLED_EXIT);
  }
  assert.equal(judge(early, working, 10_999).state, 'working');
  assert.equal(judge(early, working, 11_000).exitReason, REPORT_SETTLED_EXIT);
  const asked = judge(early, { ...working, openQuestions: true }, 11_000);
  assert.equal(asked.state, 'waiting_orchestrator');
  assert.equal(judge(asked, working, 11_001).exitReason, REPORT_SETTLED_EXIT);
  const child = 'j0000000000000001', uncollected = { open: false, uncollected: [child], remind: [child] };
  assert.equal(judge(early, { ...working, sonic: { open: true, uncollected: [], remind: [] } }, 11_000).state, 'working');
  const stillWorking = judge(early, { ...working, sonic: uncollected }, 11_000);
  assert.equal(stillWorking.state, 'working');
  assert.equal(stillWorking.action, null);
  assert.equal(judge(stillWorking, { ...declared, sonic: uncollected }, 11_001).action, 'collect-sonic');
  const reminded = judge(early, { ...declared, sonic: { ...uncollected, remind: [] } }, 11_001);
  assert.equal(reminded.state, 'working');
  assert.equal(reminded.action, null);
});
