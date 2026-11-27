import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { reportSignature } from '../../dist/roles/cli-turn.js';
import { readExecutionRuns } from '../../dist/collectors/execution-runs.js';
import { resumeQueueAfterAnswer } from '../../dist/mcp/ticket-queue.js';
import { readTicketQueue, writeTicketQueue } from '../../dist/mcp/ticket-queue-state.js';
import { readTicketFeature, serializeTicketFeature, ticketFeaturePath } from '../../dist/tickets/store.js';
import { runLock } from '../../dist/workflows/store.js';
import { fixture, fallbackRole, taskCall, taskRpc, until, resultValue } from '../helpers/thin-mcp-harness.mjs';
import { cleanupFixture } from '../helpers/process-cleanup.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { setupWorkflowProject } from '../helpers/workflow-ticket-project.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
async function project(t, { thirdBlocker = 'none', frontend = false, crossProject = false, done = [], upstream = [] } = {}) {
  const caller = await fixture(t, { failedRetentionMs: 30_000 });
  const f = crossProject ? { ...caller, root: join(caller.root, 'project') } : caller;
  if (crossProject) {
    fs.mkdirSync(f.root);
    const claudeCfg = join(f.env.CLAUDE_CONFIG_DIR, '.claude.json');
    const cfg = JSON.parse(fs.readFileSync(claudeCfg, 'utf8'));
    cfg.projects[fs.realpathSync(f.root)] = { hasTrustDialogAccepted: true };
    fs.writeFileSync(claudeCfg, JSON.stringify(cfg));
  }
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
    `# 0${n}: Synthetic ${n}\n\n**Status:** ${done.includes(n) ? 'done' : 'ready-for-agent'}\n**Owner try:** no\n**Live try:** none\n**Blocked by:** ${n === 3 ? thirdBlocker : 'none'}\n` +
    (n === 2 && frontend ? '**Role:** frontend-imp\n' : '') +
    `\n**What to build:** Synthetic change ${n}\n\n- [ ] Checked\n\n## Comments\n`);
  if (upstream.length) {
    const dir = join(f.root, '.scratch', 'upstream', 'issues');
    fs.mkdirSync(dir, { recursive: true });
    upstream.forEach((status, i) => fs.writeFileSync(join(dir, `0${i + 1}-synthetic.md`),
      `# 0${i + 1}: Upstream ${i + 1}\n\n**Status:** ${status}\n**Live try:** none\n**Blocked by:** none\n\n**What to build:** Synthetic upstream change.\n\n- [ ] Checked\n`));
  }
  git(f.root, 'add', '.scratch', '.hud');
  git(f.root, 'commit', '-qm', 'synthetic tickets');
  const home = f.env.HUD_HOME;
  const flow = id => read(join(home, 'flows', `${id}.json`));
  const dir = id => join(home, 'jobs', id);
  const job = id => read(join(dir(id), 'job.json'));
  const status = id => read(join(dir(id), 'STATUS.json'));
  const start = (max_parallel, feature = 'sample', extra = {}) => f.call('hud_tickets', { op: 'run', feature, max_parallel, cwd: f.root, ...extra });
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
  const settleCli = (id, report) => {
    const jobDir = dir(id);
    const turnPath = join(jobDir, 'turn.json');
    if (!fs.existsSync(turnPath)) return false;
    const turn = read(turnPath);
    writeFixtureFile(join(jobDir, 'report.md'), report);
    const sig = reportSignature(jobDir);
    if (!sig) return false;
    writeFixtureFile(join(jobDir, 'done.json'), JSON.stringify({ seq: turn.seq, sent_at: turn.sent_at, report_sig: sig, at: new Date().toISOString() }));
    writeFixtureFile(join(jobDir, 'STATUS.json'), JSON.stringify({ state: 'closed', output_written: true, settled_at: new Date().toISOString() }));
    return true;
  };
  const settleReview = (id) => {
    const receipt = job(id), jobDir = dir(id);
    if (receipt.cli) return settleCli(id, 'Verdict: accept\n\nNo blocking findings.\n');
    if (Date.now() <= Date.parse(receipt.pi_sent_at ?? receipt.created_at) + 1) return false;
    writeFixtureFile(join(jobDir, 'report.md'), 'Verdict: accept\n\nNo blocking findings.\n');
    writeFixtureFile(join(jobDir, 'STATUS.json'), JSON.stringify({ state: 'closed', output_written: true, settled_at: new Date().toISOString() }));
    return true;
  };
  const settledAux = new Set();
  const end = async id => {
    await until(() => {
      const q = flow(id);
      if (q.state !== 'working') return true;
      if (q.review_job && !settledAux.has(q.review_job) && fs.existsSync(join(dir(q.review_job), 'job.json'))) {
        if (settleReview(q.review_job)) settledAux.add(q.review_job);
      }
      if (q.active_lead?.job && !settledAux.has(q.active_lead.job) && fs.existsSync(join(dir(q.active_lead.job), 'turn.json'))) {
        if (settleCli(q.active_lead.job, 'Decision: finish\nReason: Accepted synthetic feature.\n')) settledAux.add(q.active_lead.job);
      }
      return false;
    }, 20_000);
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
  assert.deepEqual(result.changes, [`${flow} (ticket queue sample) — completed. Landed: sample/01, sample/02, sample/03. Verdict: finish: Accepted synthetic feature.`]);
  assert.equal((await f.call('hud_read', { job: flow })).changes, undefined);
});

test('ticket queue lands in the registered target and records the landing only in its tracker', { timeout: 45_000 }, async t => {
  const f = await project(t);
  const repo = join(f.root, 'target');
  fs.mkdirSync(repo);
  f.git(repo, 'init', '-qb', 'target-base');
  f.git(repo, 'config', 'user.name', 'Synthetic');
  f.git(repo, 'config', 'user.email', 'synthetic@example.invalid');
  fs.mkdirSync(join(repo, '.hud'));
  const config = { base: 'target-base', gate: ['test -f cross-01.txt'], after: [], push: false };
  fs.writeFileSync(join(repo, '.hud/project.json'), JSON.stringify({ land: config }));
  fs.writeFileSync(join(f.root, '.hud/project.json'), '{}'); // Only the target needs a land block.
  f.git(f.root, 'commit', '-qm', 'Tracker without land config', '--', '.hud/project.json');
  fs.writeFileSync(join(f.env.HUD_HOME, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: f.root }, { root: repo }] }));
  const draft = { title: 'Tracker ticket', what: 'Write the sample in the target.', blocked_by: [], acceptance: ['File exists.'] };
  const add = (cwd, ticket) => f.call('hud_tickets', { op: 'add', feature: 'cross', cwd, tickets: [ticket] });
  const { tickets: [{ path }] } = await add(f.root, { ...draft, repo });
  const { tickets: [{ path: decoy }] } = await add(repo, { ...draft, title: 'Unrelated same-ref ticket' });
  f.git(repo, 'add', '.hud');
  f.git(repo, 'commit', '-qm', 'Synthetic target');
  const trackerHead = f.git(f.root, 'rev-parse', 'HEAD');
  const { flow } = await f.start(1, 'cross');
  const [id] = await f.jobs(flow, 1);
  const job = f.job(id);
  assert.equal(job.worktree.main_root, repo);
  assert.equal(job.cwd, job.worktree.root);
  assert.equal(job.project_root, repo);
  assert.equal(job.ticket_root, f.root);
  assert.ok(f.git(repo, 'worktree', 'list', '--porcelain').includes(`worktree ${job.cwd}\n`));
  assert.match(fs.readFileSync(join(f.dir(id), 'brief.md'), 'utf8'), /Write the sample in the target/);
  const ready = await f.call('hud_tickets', { op: 'ready', cwd: f.root });
  assert.ok(!ready.tickets.some(t => t.ticket === 'cross/01'));

  await f.settle(id);
  const run = await f.end(flow);
  assert.equal(run.state, 'completed', JSON.stringify(run));
  const [item] = run.tickets;
  assert.equal(item.landed, true);
  const land = f.flow(item.land);
  assert.deepEqual(land.config, config);
  assert.equal(f.git(repo, 'show', 'target-base:cross-01.txt'), 'Synthetic implementation.');
  const [ticket] = read(path).tickets;
  assert.equal(ticket.status, 'done');
  assert.equal(ticket.acceptance[0].done, true);
  assert.deepEqual(ticket.landing, { at: land.landed_at, job: id, flow: item.land, replay_base: land.base_sha, gates: 1, commit: land.landed_sha });
  assert.equal(read(decoy).tickets[0].status, 'ready-for-agent');
  assert.equal(f.git(f.root, 'rev-parse', 'HEAD'), trackerHead);
});

test('Execution collects a future same-feature dependency and keeps repair rounds after its blocker lands', { timeout: 45_000 }, async t => {
  const f = await setupWorkflowProject(t);
  const config = '.hud/project.json';
  const projectConfig = read(join(f.root, config));
  projectConfig.land.gate = ['test -f fix-1 && test -f fix-2'];
  writeFixtureFile(join(f.root, config), JSON.stringify(projectConfig));
  f.git(f.root, 'add', config); f.git(f.root, 'commit', '-qm', 'Synthetic gate');
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 2, cwd: f.root });
  const [first] = await f.jobs(flow, 1);
  assert.deepEqual(f.flow(flow).tickets.map(t => t.ticket), ['sample/01']);
  const collect = () => readExecutionRuns(f.home, { root: f.root, pane: null }, new Map()).find(r => r.flow === flow);
  const station = ticket => collect().metro.stations.find(s => s.id === `sample/${ticket}`);
  const future = station('02');
  assert.equal(future.state, 'waiting');
  assert.equal(future.jobId, undefined);
  assert.deepEqual(future.blockers, ['sample/01']);
  assert.ok(collect().metro.edges.some(e => e.from === 'sample/01' && e.to === 'sample/02'));
  await f.settle(first);
  const land = () => {
    const id = f.flow(flow).tickets[0].land;
    return id && f.flow(id);
  };
  const repairs = [];
  for (const round of [1, 2]) {
    const attempt = () => land()?.repairs?.[round - 1];
    await until(() => attempt()?.outcome === 'waiting for worker', 15_000);
    const job = attempt().job, receipt = f.job(job);
    assert.notEqual(job, first);
    assert.equal(receipt.role, f.job(first).role);
    repairs.push(job);
    const host = station('01');
    assert.equal(host.jobId, first);
    assert.equal(host.repairs[round - 1].jobId, job);
    const fix = `fix-${round}`;
    fs.writeFileSync(join(receipt.cwd, fix), 'Synthetic repair.\n');
    f.git(receipt.cwd, 'add', fix); f.git(receipt.cwd, 'commit', '-qm', fix);
    await f.settleReview(job);
  }
  await f.jobs(flow, 2);
  assert.deepEqual(f.flow(flow).tickets.map(t => t.ticket), ['sample/01', 'sample/02']);
  assert.match(f.git(f.root, 'show', `base:${f.ticketPath(1)}`), /\*\*Status:\*\* done/);
  await until(() => f.flow(flow).tickets[0].landed, 15_000);
  const landed = station('01');
  assert.equal(landed.state, 'done');
  assert.equal(landed.jobId, first);
  assert.deepEqual(landed.repairs.map(r => [r.id, r.jobId]), [['sample/01↻', repairs[0]], ['sample/01↻2', repairs[1]]]);
});

test('ticket queue runs ready work and releases a queued ticket when another feature lands', { timeout: 45_000 }, async t => {
  const f = await project(t, { thirdBlocker: 'upstream/01', done: [2], upstream: ['ready-for-agent'] });
  const { flow, queued } = await f.start(1);
  assert.deepEqual(queued, [{ ticket: 'sample/03', blockers: ['upstream/01'] }]);
  const [first] = await f.jobs(flow, 1);
  assert.equal(f.job(first).ticket, 'sample/01');
  await f.settle(first);
  await until(() => f.flow(flow).tickets[0].landed === true, 15_000);
  const waiting = await f.call('hud_read', { job: flow });
  assert.equal(waiting.state, 'working');
  assert.deepEqual(waiting.queued, queued);
  assert.match(waiting.reason, /sample\/03 waiting on upstream\/01/);
  assert.deepEqual(waiting.landed, ['sample/01']);
  assert.equal(waiting.jobs.length, 1);

  const upstream = await f.start(1, 'upstream');
  const [blocker] = await f.jobs(upstream.flow, 1);
  await f.settle(blocker);
  const [, dependent] = await f.jobs(flow, 2);
  assert.equal(f.job(dependent).ticket, 'sample/03');
  assert.equal((await f.end(upstream.flow)).state, 'completed');
  await f.settle(dependent);
  const completed = await f.end(flow);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.queued, undefined);
});

test('a running queue waits for a cross-feature wontfix blocker’s replacement to be done', { timeout: 30_000 }, async t => {
  const f = await project(t, { thirdBlocker: 'upstream/01, upstream/02', done: [1, 2], upstream: ['needs-triage', 'ready-for-human'] });
  await f.call('hud_tickets', { op: 'add', feature: 'revisions', tickets: [{ title: 'Synthetic replacement',
    what: 'Supersedes upstream/02, which is no longer being worked on.', status: 'ready-for-human', blocked_by: [], acceptance: ['Checked'] }] });
  const { flow } = await f.start(1);
  const read = () => f.call('hud_read', { job: flow });
  const update = (ticket, status) => f.call('hud_tickets', { op: 'update', feature: 'upstream', ticket, status });
  await until(() => f.flow(flow).pid, 15_000);
  const waiting = await read();
  assert.equal(waiting.state, 'working');
  assert.deepEqual(waiting.queued, [{ ticket: 'sample/03', blockers: ['upstream/01', 'upstream/02'] }]);
  assert.deepEqual(waiting.jobs, []);
  await update(1, 'done');
  await until(() => f.flow(flow).queued?.[0]?.blockers.length === 1, 10_000);
  const stillWaiting = await read();
  assert.equal(stillWaiting.state, 'working');
  assert.deepEqual(stillWaiting.queued, [{ ticket: 'sample/03', blockers: ['upstream/02'] }]);
  assert.deepEqual(stillWaiting.jobs, []);
  await update(2, 'wontfix');
  await until(() => f.flow(flow).queued?.[0]?.blockers.includes('revisions/01'), 10_000);
  assert.equal(f.flow(flow).state, 'working');
  assert.deepEqual(f.flow(flow).tickets, []);
  assert.deepEqual((await f.call('hud_tickets', { op: 'ready' })).tickets, []);
  await f.call('hud_tickets', { op: 'update', feature: 'revisions', ticket: 1, status: 'done' });
  const [dependent] = await f.jobs(flow, 1);
  assert.equal(f.job(dependent).ticket, 'sample/03');
});

test('run rejects a missing cross-feature blocker before creating a queue', { timeout: 30_000 }, async t => {
  const f = await project(t, { thirdBlocker: 'upstream/99', upstream: ['ready-for-agent'] });
  const { result } = await f.rpc('tools/call', {
    name: 'hud_tickets', arguments: { op: 'run', feature: 'sample', max_parallel: 1 },
  });
  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.content[0].text).error, /sample\/03: unknown blocked_by ticket: upstream\/99/);
  const flowsDir = join(f.env.HUD_HOME, 'flows');
  assert.ok(!fs.existsSync(flowsDir) || fs.readdirSync(flowsDir).every(file => !/^q[a-f0-9]{16}\.json$/.test(file)));
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
  assert.deepEqual(all.filter(id => f.job(id).role === 'imp').sort(), [first, second, third].sort());
});

test('ticket queue hands back on a worker question without stopping its peer', { timeout: 30_000 }, async t => {
  const f = await project(t);
  const { flow } = await f.start(2, 'sample', { handback_to: 'main' });
  const [first, peer] = await f.jobs(flow, 2);
  const qa = join(f.dir(first), 'qa');
  fs.mkdirSync(qa, { recursive: true });
  writeFixtureFile(join(qa, 'q1.md'), '# Question q1 from Synthetic\n\nChoose a synthetic path.\n');
  writeFixtureFile(join(f.dir(first), 'STATUS.json'), JSON.stringify({ state: 'waiting_orchestrator' }));
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

  // The answer to the stopping question resumes the queue with the same jobs, also through the batch form.
  const batch = await f.call('hud_respond', { answers: [{ job: first, request_id: 'q1', answer: 'Take the synthetic path.' }] });
  const answered = { queue_resumed: batch.queues_resumed?.[0] };
  assert.match(answered.queue_resumed, /^q[0-9a-f]{16}$/);
  const resumed = f.flow(answered.queue_resumed);
  assert.equal(resumed.state, 'working');
  assert.deepEqual(resumed.tickets.map(x => x.job), [first, peer]);
  const answerDecision = resumed.decisions.find(d => d.kind === 'question' && d.decision === 'answer' && d.question === 'q1');
  assert.equal(answerDecision?.job, 'main');
  assert.equal(answerDecision?.ticket, 'sample/01');
  assert.equal(answerDecision?.worker_job, first);
  assert.equal(f.status(first).state, 'waiting_orchestrator', 'the worker has not yet picked up the answer');
  const run = readExecutionRuns(f.env.HUD_HOME, { root: f.root, pane: null }, new Map()).find(r => r.flow === resumed.flow);
  const station = run.metro.stations.find(s => s.jobId === first);
  assert.equal(station.state, 'working');
  assert.equal(station.changedAt, Date.parse(resumed.tickets[0].answered_at));
});

test('a note sent to a working queue job keeps the job in its queue', { timeout: 30_000 }, async t => {
  const f = await project(t);
  const { flow } = await f.start();
  const [first] = await f.jobs(flow, 1);
  await f.call('hud_send', { job: first, text: 'Synthetic constraint for the current turn.' });
  assert.equal(f.job(first).ticket_queue, flow);
  await f.settle(first);
  const [, second] = await f.jobs(flow, 2);
  await f.settle(second);
  const [, , third] = await f.jobs(flow, 3);
  await f.settle(third);
  assert.equal((await f.end(flow)).state, 'completed');
});

test('a resumed queue waits for a launch still in flight instead of failing it', { timeout: 30_000 }, async t => {
  const f = await project(t);
  // Keep ticket 2 queued until the simulated in-flight launch settles.
  const { flow } = await f.start(1);
  const [first] = await f.jobs(flow, 1);
  // A runner that takes over mid-launch sees the job before its first status.
  fs.rmSync(join(f.dir(first), 'STATUS.json'), { force: true });
  writeFixtureFile(join(f.dir(first), 'job.json'), JSON.stringify({ ...f.job(first), dispatch_exit_code: null }));
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(f.flow(flow).state, 'working');
  await f.settle(first);
  const [, second] = await f.jobs(flow, 2);
  await f.settle(second);
  const [, , third] = await f.jobs(flow, 3);
  await f.settle(third);
  assert.equal((await f.end(flow)).state, 'completed');
});

test('a queue fails a launch whose launching process is gone', { timeout: 30_000 }, async t => {
  const f = await project(t);
  const { flow } = await f.start();
  const [first] = await f.jobs(flow, 1);
  const gone = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  fs.rmSync(join(f.dir(first), 'STATUS.json'), { force: true });
  writeFixtureFile(join(f.dir(first), 'job.json'), JSON.stringify({ ...f.job(first), dispatch_exit_code: null, launcher: { pid: Number(gone) } }));
  const ended = await f.end(flow);
  assert.equal(ended.state, 'failed');
  assert.match(ended.reason, /dispatch interrupted before worker status was recorded/);
});

test('a resumed queue redispatches a launch failure with the original dispatcher', { timeout: 30_000 }, async t => {
  const f = await project(t);
  const start = async threadId => resultValue((await f.rpc('tools/call', {
    name: 'hud_tickets', arguments: { op: 'run', feature: 'sample', max_parallel: 1 }, _meta: { threadId },
  })).result);
  const dispatcher = { harness: 'codex', id: '00000000-0000-4000-8000-000000000042' };
  const { flow } = await start(dispatcher.id);
  const [first] = await f.jobs(flow, 1);
  assert.deepEqual(f.job(first).dispatcher, dispatcher);
  writeFixtureFile(join(f.dir(first), 'STATUS.json'), JSON.stringify({ state: 'failed', exit_reason: 'dispatch_failed', error: 'synthetic checkout timeout', ended_at: new Date().toISOString() }));
  assert.equal((await f.end(flow)).state, 'failed');
  const { flow: resumed } = await start('00000000-0000-4000-8000-000000000043');
  const [again] = await f.jobs(resumed, 1);
  assert.notEqual(again, first);
  assert.equal(f.job(again).ticket, 'sample/01');
  assert.deepEqual(f.job(again).dispatcher, dispatcher);
});

test('a recovered queue intent with an old scratch path dispatches by ticket ID', { timeout: 30_000 }, async t => {
  const f = await project(t, { thirdBlocker: 'upstream/01', done: [1, 2], upstream: ['needs-triage'] });
  const home = f.env.HUD_HOME;
  const { flow, queued } = await f.start(1);
  assert.deepEqual(queued, [{ ticket: 'sample/03', blockers: ['upstream/01'] }]);
  const legacyPath = join(f.root, f.ticketPath(3)), path = ticketFeaturePath(f.root, 'sample');
  await runLock(home, flow, () => {
    const persisted = f.flow(flow);
    assert.equal(persisted.tickets.length, 0);
    persisted.tickets.push({ ticket: 'sample/03', path: legacyPath, role: 'imp' });
    const doc = readTicketFeature(f.root, 'sample');
    Object.assign(doc.tickets[2], { title: 'Migrated ticket', what: 'Use the typed brief.', blocked_by: [] });
    fs.mkdirSync(join(path, '..'), { recursive: true });
    writeFixtureFile(path, serializeTicketFeature(doc));
    writeTicketQueue(home, persisted);
  });
  const [id] = await f.jobs(flow, 1);
  assert.equal(f.flow(flow).tickets[0].path, path);
  assert.equal(f.job(id).ticket, 'sample/03');
  assert.match(fs.readFileSync(join(f.dir(id), 'brief.md'), 'utf8'), /^# 03: Migrated ticket[\s\S]*\*\*What to build:\*\* Use the typed brief\./);
});

test('a resumed queue drops a ticket that was closed since the queue failed', { timeout: 30_000 }, async t => {
  const f = await project(t);
  const { flow } = await f.start(1);
  const [first] = await f.jobs(flow, 1);
  writeFixtureFile(join(f.dir(first), 'STATUS.json'), JSON.stringify({ state: 'stopped', ended_at: new Date().toISOString() }));
  assert.equal((await f.end(flow)).state, 'failed');
  // The ticket landed through another job while the queue was stopped.
  const ticket = join(f.root, f.ticketPath(1));
  fs.writeFileSync(ticket, fs.readFileSync(ticket, 'utf8').replace('ready-for-agent', 'done'));
  const { flow: resumed } = await f.start(1);
  const [next] = await f.jobs(resumed, 1);
  assert.notEqual(next, first);
  assert.equal(f.job(next).ticket, 'sample/02');
  assert.ok(f.flow(resumed).tickets.every(item => item.job !== first));
});

test('ticket queue keeps going past an answered worker question', { timeout: 30_000 }, async t => {
  const f = await project(t);
  // Each settlement must release exactly one next job for the staged assertions below.
  const { flow } = await f.start(1);
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

test('resumeQueueAfterAnswer keys question dedupe on worker_job across reviewer rounds, keeps repeats idempotent, and honors legacy decisions', async t => {
  const base = fs.mkdtempSync(join(tmpdir(), 'hud-q-answer-dedupe-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'hud');
  const root = join(base, 'repo');
  fs.mkdirSync(join(home, 'flows'), { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  const now = '2026-01-01T00:00:00.000Z';

  // Two different reviewer jobs on one run both ask q1 and are answered directly.
  const reviewFlow = 'q00000000000000d1';
  const reviewer1 = 'j00000000000000r1';
  const reviewer2 = 'j00000000000000r2';
  writeTicketQueue(home, {
    flow: reviewFlow, root, cwd: root, project_root: root, feature: 'sample', pane: '',
    task: false, max_parallel: 1, created_at: now, updated_at: now, state: 'paused',
    handback: { step: 'review', choices: ['resume', 'stop'], kind: 'question', job: reviewer1, question: 'q1' },
    review_job: reviewer1,
    steps: { tickets: { state: 'done' }, review: { state: 'failed' }, accept: { state: 'waiting' } },
    tickets: [],
  }, true);

  await resumeQueueAfterAnswer(home, reviewer1, 'q1', null, root);
  await resumeQueueAfterAnswer(home, reviewer1, 'q1', null, root);
  let saved = readTicketQueue(home, reviewFlow);
  assert.deepEqual(
    saved.decisions.map(d => ({ step: d.step, kind: d.kind, job: d.job, decision: d.decision, worker_job: d.worker_job, question: d.question })),
    [{ step: 'review', kind: 'question', job: 'main', decision: 'answer', worker_job: reviewer1, question: 'q1' }],
  );

  // Repair-round reviewer on the same run also asks q1 and gets its own answer decision.
  saved.review_job = reviewer2;
  saved.handback = { step: 'review', choices: ['resume', 'stop'], kind: 'question', job: reviewer2, question: 'q1' };
  writeTicketQueue(home, saved);
  await resumeQueueAfterAnswer(home, reviewer2, 'q1', null, root);
  await resumeQueueAfterAnswer(home, reviewer2, 'q1', null, root);
  saved = readTicketQueue(home, reviewFlow);
  assert.deepEqual(
    saved.decisions.map(d => ({ step: d.step, kind: d.kind, job: d.job, decision: d.decision, worker_job: d.worker_job, question: d.question })),
    [
      { step: 'review', kind: 'question', job: 'main', decision: 'answer', worker_job: reviewer1, question: 'q1' },
      { step: 'review', kind: 'question', job: 'main', decision: 'answer', worker_job: reviewer2, question: 'q1' },
    ],
  );

  // Ticket-item branch: repeat for same job is idempotent, second job on same ticket records its own decision.
  const ticketFlow = 'q00000000000000d2';
  const worker1 = 'j00000000000000w1';
  const worker2 = 'j00000000000000w2';
  writeTicketQueue(home, {
    flow: ticketFlow, root, cwd: root, project_root: root, feature: 'sample', pane: '',
    task: false, max_parallel: 1, created_at: now, updated_at: now, state: 'paused',
    handback: { step: 'tickets', choices: ['resume', 'stop'], kind: 'question', ticket: 'sample/01', job: worker1, question: 'q1' },
    steps: { tickets: { state: 'failed' }, review: { state: 'waiting' }, accept: { state: 'waiting' } },
    tickets: [{ ticket: 'sample/01', path: join(root, '.scratch/sample/issues/01.md'), role: 'imp', job: worker1 }],
  }, true);

  await resumeQueueAfterAnswer(home, worker1, 'q1', null, root);
  await resumeQueueAfterAnswer(home, worker1, 'q1', null, root);
  saved = readTicketQueue(home, ticketFlow);
  assert.deepEqual(
    saved.decisions.map(d => ({ step: d.step, ticket: d.ticket, worker_job: d.worker_job, question: d.question })),
    [{ step: 'tickets', ticket: 'sample/01', worker_job: worker1, question: 'q1' }],
  );

  saved.tickets[0].job = worker2;
  saved.handback = { step: 'tickets', choices: ['resume', 'stop'], kind: 'question', ticket: 'sample/01', job: worker2, question: 'q1' };
  writeTicketQueue(home, saved);
  await resumeQueueAfterAnswer(home, worker2, 'q1', null, root);
  await resumeQueueAfterAnswer(home, worker2, 'q1', null, root);
  saved = readTicketQueue(home, ticketFlow);
  assert.deepEqual(
    saved.decisions.map(d => ({ step: d.step, ticket: d.ticket, worker_job: d.worker_job, question: d.question })),
    [
      { step: 'tickets', ticket: 'sample/01', worker_job: worker1, question: 'q1' },
      { step: 'tickets', ticket: 'sample/01', worker_job: worker2, question: 'q1' },
    ],
  );

  // Legacy receipts without worker_job: ticket-item dedupe stays ticket+question;
  // review dedupe only matches when the legacy decision cannot predate the current reviewer job.
  const legacyFlow = 'q00000000000000d3';
  const legacyWorker = 'j00000000000000l1';
  const legacyReviewer = 'j00000000000000l2';
  const upgradedReviewer = 'j00000000000000l3';
  const round0CreatedAt = '2026-01-01T00:00:00.000Z';
  const round0AnswerAt = '2026-01-01T00:01:00.000Z';
  const round1CreatedAt = '2026-01-01T00:05:00.000Z';
  fs.mkdirSync(join(home, 'jobs', legacyReviewer), { recursive: true });
  fs.writeFileSync(join(home, 'jobs', legacyReviewer, 'job.json'), JSON.stringify({ job: legacyReviewer, created_at: round0CreatedAt }));
  fs.mkdirSync(join(home, 'jobs', upgradedReviewer), { recursive: true });
  fs.writeFileSync(join(home, 'jobs', upgradedReviewer, 'job.json'), JSON.stringify({ job: upgradedReviewer, created_at: round1CreatedAt }));
  writeTicketQueue(home, {
    flow: legacyFlow, root, cwd: root, project_root: root, feature: 'sample', pane: '',
    task: false, max_parallel: 1, created_at: now, updated_at: now, state: 'paused',
    handback: { step: 'tickets', choices: ['resume', 'stop'], kind: 'question', ticket: 'sample/02', job: legacyWorker, question: 'q1' },
    review_job: legacyReviewer,
    steps: { tickets: { state: 'failed' }, review: { state: 'failed' }, accept: { state: 'waiting' } },
    tickets: [{ ticket: 'sample/02', path: join(root, '.scratch/sample/issues/02.md'), role: 'imp', job: legacyWorker }],
    decisions: [
      { step: 'tickets', kind: 'question', job: 'main', decision: 'answer', ticket: 'sample/02', question: 'q1', at: round0AnswerAt },
      { step: 'review', kind: 'question', job: 'main', decision: 'answer', question: 'q1', at: round0AnswerAt },
    ],
  }, true);

  // Ticket-item legacy rule unchanged: legacy decision without worker_job suppresses repeat for same ticket+question.
  await resumeQueueAfterAnswer(home, legacyWorker, 'q1', null, root);
  saved = readTicketQueue(home, legacyFlow);
  assert.equal(saved.decisions.length, 2);

  // Repeat delivery for the same current reviewer when earlier record lacks worker_job: not double-recorded.
  saved.handback = { step: 'review', choices: ['resume', 'stop'], kind: 'question', job: legacyReviewer, question: 'q1' };
  writeTicketQueue(home, saved);
  await resumeQueueAfterAnswer(home, legacyReviewer, 'q1', null, root);
  saved = readTicketQueue(home, legacyFlow);
  assert.equal(saved.decisions.length, 2);

  // Mixed-version sequence: round-0 legacy review/q1 decision predates round-1 reviewer, so round-1's q1 answer is recorded once.
  saved.repair_rounds = 1;
  saved.review_job = upgradedReviewer;
  saved.handback = { step: 'review', choices: ['resume', 'stop'], kind: 'question', job: upgradedReviewer, question: 'q1' };
  writeTicketQueue(home, saved);
  await resumeQueueAfterAnswer(home, upgradedReviewer, 'q1', null, root);
  await resumeQueueAfterAnswer(home, upgradedReviewer, 'q1', null, root);
  saved = readTicketQueue(home, legacyFlow);
  assert.deepEqual(
    saved.decisions.map(d => ({ step: d.step, kind: d.kind, job: d.job, decision: d.decision, ticket: d.ticket, worker_job: d.worker_job, question: d.question })),
    [
      { step: 'tickets', kind: 'question', job: 'main', decision: 'answer', ticket: 'sample/02', worker_job: undefined, question: 'q1' },
      { step: 'review', kind: 'question', job: 'main', decision: 'answer', ticket: undefined, worker_job: undefined, question: 'q1' },
      { step: 'review', kind: 'question', job: 'main', decision: 'answer', ticket: undefined, worker_job: upgradedReviewer, question: 'q1' },
    ],
  );
});

test('Execution projects a lead-answered review question as working at the answer time and restores asking on a newer open question', { timeout: 45_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 1 });
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root });
  const [first] = await f.jobs(flow, 1);
  await f.settle(first);
  await until(() => !!f.flow(flow).review_job, 15_000);
  const reviewJob = f.flow(flow).review_job;
  const reviewDir = f.dir(reviewJob);
  await until(() => fs.existsSync(join(reviewDir, 'STATUS.json')), 10_000);

  const qaDir = join(reviewDir, 'qa');
  fs.mkdirSync(qaDir, { recursive: true });
  writeFixtureFile(join(qaDir, 'q1.md'), '# Question q1 from reviewer\n\nShould review enforce the synthetic contract?\n');
  writeFixtureFile(join(reviewDir, 'STATUS.json'), JSON.stringify({
    ...read(join(reviewDir, 'STATUS.json')),
    state: 'waiting_orchestrator',
  }));
  await until(() => f.flow(flow).active_lead?.kind === 'question' && f.flow(flow).active_lead.step === 'review', 15_000);

  const collectReview = () => readExecutionRuns(f.home, { root: f.root, pane: null }, new Map())
    .find(r => r.flow === flow).metro.stations.find(s => s.id === 'review');
  assert.equal(collectReview().state, 'asking');

  await f.settleLead(f.flow(flow).active_lead.job, 'Decision: answer\nReason: Enforce the synthetic contract.\nAnswer: Yes, enforce the synthetic contract.\n');
  await until(() => f.flow(flow).decisions?.some(d => d.step === 'review' && d.kind === 'question' && d.decision === 'answer'), 15_000);
  assert.equal(fs.existsSync(join(qaDir, 'q1.answer.md')), true);
  assert.equal(read(join(reviewDir, 'STATUS.json')).state, 'waiting_orchestrator');

  const answerDecision = f.flow(flow).decisions.find(d => d.step === 'review' && d.kind === 'question' && d.decision === 'answer');
  const answered = collectReview();
  assert.equal(answered.state, 'working', 'answered reviewer leaves ? while STATUS is still waiting_orchestrator');
  assert.equal(answered.changedAt, Date.parse(answerDecision.at));

  writeFixtureFile(join(qaDir, 'q2.md'), '# Question q2 from reviewer\n\nWhat about the second synthetic invariant?\n');
  assert.equal(collectReview().state, 'asking', 'a newer open question overrides the earlier delivered answer');

  await f.call('hud_tickets', { op: 'run', feature: 'sample', cancel: true, cwd: f.root });
  await until(() => f.flow(flow).state !== 'working', 15_000);
});
