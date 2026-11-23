import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, fallbackRole, taskCall, taskRpc, until, resultValue } from '../helpers/thin-mcp-harness.mjs';
import { cleanupFixture } from '../helpers/process-cleanup.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
async function project(t, { thirdBlocker = 'none', frontend = false, crossProject = false } = {}) {
  const caller = await fixture(t, { failedRetentionMs: 30_000 });
  const f = crossProject ? { ...caller, root: join(caller.root, 'project') } : caller;
  if (crossProject) fs.mkdirSync(f.root);
  cleanupFixture(t, { root: `${f.root}-wt` });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: f.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(f.root, 'init', '-qb', 'base');
  git(f.root, 'config', 'user.name', 'Synthetic');
  git(f.root, 'config', 'user.email', 'synthetic@example.invalid');
  fs.mkdirSync(join(f.root, '.hud'));
  fs.writeFileSync(join(f.root, '.hud/project.json'), JSON.stringify({ land: { base: 'base', gate: ['true'], after: [], push: false } }));
  fs.writeFileSync(join(f.root, '.hud/brief.md'), 'Synthetic standing brief.\n');
  fs.writeFileSync(join(f.env.HUD_HOME, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: f.root }] }));
  if (frontend) fallbackRole(f, 'frontend-imp', [{ harness: 'pi', pi_role: 'implementer', split: false }]);
  const issues = join('.scratch', 'sample', 'issues');
  fs.mkdirSync(join(f.root, issues), { recursive: true });
  const ticketPath = n => join(issues, `0${n}-synthetic.md`);
  for (const n of [1, 2, 3]) fs.writeFileSync(join(f.root, ticketPath(n)),
    `# 0${n}: Synthetic ${n}\n\n**Status:** ready-for-agent\n**Owner try:** no\n**Blocked by:** ${n === 3 ? thirdBlocker : 'none'}\n` +
    (n === 2 && frontend ? '**Role:** frontend-imp\n' : '') +
    `\n**What to build:** Synthetic change ${n}\n\n- [ ] Checked\n\n## Comments\n`);
  git(f.root, 'add', '.scratch', '.hud');
  git(f.root, 'commit', '-qm', 'synthetic tickets');
  const home = f.env.HUD_HOME;
  const flow = id => read(join(home, 'flows', `${id}.json`));
  const dir = id => join(home, 'jobs', id);
  const job = id => read(join(dir(id), 'job.json'));
  const status = id => read(join(dir(id), 'STATUS.json'));
  const start = max_parallel => f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel, cwd: f.root });
  const jobs = async (id, count) => {
    await until(() => {
      const q = flow(id);
      assert.equal(q.state, 'working', JSON.stringify(q));
      return q.tickets.filter(x => x.job).length === count;
    }, 15_000);
    return flow(id).tickets.map(x => x.job);
  };
  const settle = async (id, { checks, report = 'Synthetic finished report.\n' } = {}) => {
    const receipt = job(id), root = receipt.worktree.root, file = `${receipt.ticket.replace('/', '-')}.txt`;
    fs.writeFileSync(join(root, file), 'Synthetic implementation.\n');
    git(root, 'add', file); git(root, 'commit', '-qm', file);
    if (checks) writeFixtureFile(join(dir(id), 'job.json'), JSON.stringify({ ...receipt, checks }));
    await until(() => Date.now() > Date.parse(receipt.pi_sent_at ?? receipt.created_at) + 1, t.signal);
    writeFixtureFile(join(dir(id), 'report.md'), report);
    writeFixtureFile(join(dir(id), 'STATUS.json'), JSON.stringify({ state: 'closed', output_written: true, settled_at: new Date().toISOString() }));
  };
  const end = async id => {
    await until(() => flow(id).state !== 'working', 20_000);
    return flow(id);
  };
  return { ...f, dir, end, flow, git, job, jobs, settle, start, status, ticketPath };
}

test('ticket queue lands two ready tickets, resumes after a runner crash, and releases the dependent', { timeout: 45_000 }, async t => {
  const f = await project(t, { thirdBlocker: '01', frontend: true });
  const { flow } = await f.start(2);
  assert.match(flow, /^q[0-9a-f]{16}$/);
  assert.equal((await f.start(2)).flow, flow);
  const [first, second] = await f.jobs(flow, 2);
  assert.deepEqual([f.job(first).role, f.job(second).role], ['imp', 'frontend-imp']);
  assert.deepEqual([f.job(first).ticket, f.job(second).ticket], ['sample/01', 'sample/02']);
  assert.match(fs.readFileSync(join(f.dir(first), 'brief.md'), 'utf8'), /Synthetic change 1[\s\S]*Read the project standing brief/);
  assert.equal(f.flow(flow).tickets.length, 2);
  const crashed = f.flow(flow).pid;
  process.kill(crashed, 'SIGKILL');
  await until(() => f.flow(flow).pid !== crashed, 15_000);
  assert.deepEqual(await f.jobs(flow, 2), [first, second]);
  assert.equal((await f.call('hud_lease', { name: 'main-checkout' })).granted, true);
  await f.settle(first);
  await f.settle(second);
  await until(() => f.flow(flow).tickets.filter(x => x.land).length === 2, 15_000);
  assert.equal(f.flow(flow).tickets.length, 2);
  await f.call('hud_lease', { name: 'main-checkout', release: true });
  const [, , third] = await f.jobs(flow, 3);
  assert.match(f.git(f.root, 'show', `base:${f.ticketPath(1)}`), /\*\*Status:\*\* done/);
  assert.equal(f.job(third).ticket, 'sample/03');
  await f.settle(third);
  const done = await f.end(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  for (const n of [1, 2, 3]) assert.match(f.git(f.root, 'show', `base:${f.ticketPath(n)}`), /\*\*Status:\*\* done/);
  const result = await f.call('hud_read', { job: flow });
  assert.deepEqual(result.landed, ['sample/01', 'sample/02', 'sample/03']);
  assert.deepEqual(result.changes, [`${flow} (ticket queue sample) — completed. Landed: sample/01, sample/02, sample/03.`]);
  assert.equal((await f.call('hud_read', { job: flow })).changes, undefined);
});

test('running a failed queue in another project retries only the land, keeping the settled worker and original receipts', { timeout: 45_000 }, async t => {
  const f = await project(t, { thirdBlocker: '01', crossProject: true });
  const { flow } = await f.start(1);
  const [first] = await f.jobs(flow, 1);
  const dirty = join(f.root, 'sample-01.txt');
  fs.writeFileSync(dirty, 'Synthetic untracked change.\n');
  await f.settle(first);
  const failed = await f.end(flow);
  assert.equal(failed.state, 'failed');
  assert.match(failed.reason, /dirty or hidden changes/);
  const originalLand = failed.tickets[0].land;

  const { flow: retry } = await f.start();
  assert.notEqual(retry, flow);
  const failedAgain = await f.end(retry);
  assert.equal(failedAgain.state, 'failed');
  assert.deepEqual(failedAgain.tickets.map(t => t.job), [first]);
  assert.equal(failedAgain.tickets[0].land, `${originalLand}-2`);

  fs.unlinkSync(dirty);
  const { flow: resumed } = await f.start();
  const [, second] = await f.jobs(resumed, 2);
  assert.equal(f.flow(resumed).tickets[0].job, first);
  assert.equal(f.flow(resumed).tickets[0].land, `${originalLand}-3`);
  assert.equal(f.flow(resumed).tickets[0].landed, true);
  assert.deepEqual(f.flow(flow), failed);
  await f.settle(second);
  const [, , third] = await f.jobs(resumed, 3);
  await f.settle(third);
  assert.equal((await f.end(resumed)).state, 'completed');
  const all = fs.readdirSync(join(f.env.HUD_HOME, 'jobs')).filter(id => /^j[a-f0-9]{16}$/.test(id));
  assert.deepEqual(all.sort(), [first, second, third].sort());
});

test('ticket queue hands back on a worker question without stopping its peer', { timeout: 30_000 }, async t => {
  const f = await project(t);
  const { flow } = await f.start(2);
  const [first, peer] = await f.jobs(flow, 2);
  const qa = join(f.dir(first), 'qa');
  fs.mkdirSync(qa, { recursive: true });
  writeFixtureFile(join(qa, 'q1.md'), '# Question q1 from Synthetic\n\nChoose a synthetic path.\n');
  const stopped = await f.end(flow);
  assert.equal(stopped.state, 'failed');
  assert.match(stopped.reason, /worker question q1/);
  assert.equal(f.status(peer).state, 'working');
  assert.equal(stopped.tickets.length, 2);
  assert.ok(stopped.remaining.some(text => text.includes(peer)));
  const result = await f.call('hud_read', { job: flow });
  assert.equal(result.changes.length, 1);
  assert.match(result.changes[0], /worker question q1.*Still running:/);
  assert.equal((await f.call('hud_read', { job: flow })).changes, undefined);

  // The answer to the stopping question resumes the queue with the same jobs.
  const answered = await f.call('hud_respond', { job: first, request_id: 'q1', answer: 'Take the synthetic path.' });
  assert.match(answered.queue_resumed, /^q[0-9a-f]{16}$/);
  assert.equal(f.flow(answered.queue_resumed).state, 'working');
  assert.deepEqual(f.flow(answered.queue_resumed).tickets.map(x => x.job), [first, peer]);
});

test('ticket queue keeps going past an answered worker question', { timeout: 30_000 }, async t => {
  const f = await project(t);
  const { flow } = await f.start();
  const [first] = await f.jobs(flow, 1);
  const qa = join(f.dir(first), 'qa');
  fs.mkdirSync(qa, { recursive: true });
  writeFixtureFile(join(qa, 'q1.md'), '# Question q1 from Synthetic\n\nChoose a synthetic path.\n');
  writeFixtureFile(join(qa, 'q1.answer.md'), 'Take the synthetic path.\n');
  // The worker has not read the answer yet.
  writeFixtureFile(join(f.dir(first), 'STATUS.json'), JSON.stringify({ ...f.status(first), state: 'waiting_orchestrator' }));
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(f.flow(flow).state, 'working');
  await f.settle(first);
  const [, second] = await f.jobs(flow, 2);
  await f.settle(second);
  const [, , third] = await f.jobs(flow, 3);
  await f.settle(third);
  assert.equal((await f.end(flow)).state, 'completed');
});

test('ticket queue task hands back on a red HUD check, not on the report before checks', { timeout: 30_000 }, async t => {
  const f = await project(t);
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const task = await taskCall(rpc, 'hud_tickets', { op: 'run', feature: 'sample', max_parallel: 2 });
  assert.equal(task.resultType, 'task');
  const { taskId } = task;
  const [first, peer] = await f.jobs(taskId, 2);
  await f.settle(first, { checks: ['test -f synthetic-missing'] });
  const stopped = await f.end(taskId);
  assert.equal(stopped.state, 'failed', JSON.stringify(stopped));
  assert.match(stopped.reason, /HUD checks failed/);
  assert.equal(stopped.tickets.length, 2);
  assert.equal(stopped.tickets.some(x => x.land), false);
  assert.equal(f.status(peer).state, 'working');
  const response = await rpc('tasks/get', { taskId });
  assert.equal(response.status, 'failed');
  assert.match(response.result.content[0].text, new RegExp(`HUD checks failed.*Still running:.*${peer}`));
  assert.equal(resultValue(await taskCall(rpc, 'hud_read', { job: taskId })).changes, undefined);
});

test('ticket queue cancel stops new dispatches and leaves the running worker alone', { timeout: 30_000 }, async t => {
  const f = await project(t);
  const { flow } = await f.start(1);
  const [first] = await f.jobs(flow, 1);
  const request = await f.call('hud_tickets', { op: 'run', feature: 'sample', cancel: true });
  assert.equal(request.cancel_requested, true);
  const stopped = await f.end(flow);
  assert.equal(stopped.state, 'cancelled');
  assert.equal(f.status(first).state, 'working');
  assert.match(stopped.remaining.join(' '), new RegExp(first));
  await f.settle(first);
  const status = await f.call('hud_read', { job: flow });
  assert.deepEqual(status.jobs, [{ job: first, ticket: 'sample/01' }]);
  assert.deepEqual(status.landed, []);
  assert.equal(f.status(first).state, 'closed');
});
