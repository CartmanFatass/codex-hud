import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { reportSignature } from '../../dist/roles/cli-turn.js';
import { loadGraph } from '../../dist/workflows/graph.js';
import { pruneLandFlows } from '../../dist/runtime/work-retention.js';
import { cleanupFixture, stopChild } from '../helpers/process-cleanup.mjs';
import { fixture, resultValue, rpcClient, until } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const runner = resolve('packages/hud-mcp/bin/workflow-runner.mjs');

async function project(t, { secondBlocker = '01', count = 2 } = {}) {
  const f = await fixture(t, { failedRetentionMs: 30_000 });
  cleanupFixture(t, { root: `${f.root}-wt` });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: f.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(f.root, 'init', '-qb', 'base');
  git(f.root, 'config', 'user.name', 'Synthetic');
  git(f.root, 'config', 'user.email', 'synthetic@example.invalid');
  fs.mkdirSync(join(f.root, '.hud'));
  fs.writeFileSync(join(f.root, '.hud/project.json'), JSON.stringify({ land: { base: 'base', gate: ['true'], after: [], push: false } }));
  fs.writeFileSync(join(f.root, '.hud/brief.md'), 'Synthetic standing brief.\n');
  fs.writeFileSync(join(f.env.HUD_HOME, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: f.root }] }));
  const issues = join('.scratch', 'sample', 'issues');
  fs.mkdirSync(join(f.root, issues), { recursive: true });
  const ticketPath = n => join(issues, `0${n}-synthetic.md`);
  for (let n = 1; n <= count; n++) fs.writeFileSync(join(f.root, ticketPath(n)),
    `# 0${n}: Synthetic ${n}\n\n**Status:** ready-for-agent\n**Owner try:** no\n**Live try:** none\n**Blocked by:** ${n === 2 ? secondBlocker : 'none'}\n\n**What to build:** Synthetic change ${n}\n\n- [ ] Checked\n\n## Comments\n`);
  git(f.root, 'add', '.scratch', '.hud');
  git(f.root, 'commit', '-qm', 'synthetic tickets');
  const home = f.env.HUD_HOME;
  const flow = id => read(join(home, 'flows', `${id}.json`));
  const dir = id => join(home, 'jobs', id);
  const job = id => read(join(dir(id), 'job.json'));
  const jobs = async (id, n) => {
    await until(() => {
      const q = flow(id);
      assert.equal(q.state, 'working', JSON.stringify(q));
      return q.tickets.filter(x => x.job).length === n;
    }, 15_000);
    return flow(id).tickets.map(x => x.job);
  };
  const settle = async (id, { report = 'Synthetic finished report.\n' } = {}) => {
    const receipt = job(id), root = receipt.worktree.root, file = `${receipt.ticket.replace('/', '-')}.txt`;
    fs.writeFileSync(join(root, file), 'Synthetic implementation.\n');
    git(root, 'add', file); git(root, 'commit', '-qm', file);
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
  const settleReview = async id => {
    const receipt = job(id), jobDir = dir(id);
    if (receipt.cli) {
      await until(() => settleCli(id, 'Verdict: accept\n\nNo blocking findings.\n'), 10_000);
      return;
    }
    await until(() => Date.now() > Date.parse(receipt.pi_sent_at ?? receipt.created_at) + 1, t.signal);
    writeFixtureFile(join(jobDir, 'report.md'), 'Verdict: accept\n\nNo blocking findings.\n');
    writeFixtureFile(join(jobDir, 'STATUS.json'), JSON.stringify({ state: 'closed', output_written: true, settled_at: new Date().toISOString() }));
  };
  const settleLead = async (id, report = 'Decision: finish\nReason: Accepted synthetic feature.\n') => {
    await until(() => settleCli(id, report), 10_000);
  };
  const end = async id => {
    await until(() => flow(id).state !== 'working', 20_000);
    return flow(id);
  };
  return { ...f, dir, end, flow, git, home, job, jobs, settle, settleLead, settleReview, ticketPath };
}

test('ticket-queue template validates tickets, review, and accept steps with cheap cost and rejects invalid shapes', () => {
  const roles = new Map([
    ['imp', { optionalEnabled: true, run: [{ harness: 'pi' }] }],
    ['sonic', { optionalEnabled: true, run: [{ harness: 'pi' }] }],
    ['reviewer', { optionalEnabled: true, run: [{ harness: 'pi' }] }],
    ['lead', { optionalEnabled: true, run: [{ harness: 'cli' }] }],
  ]);
  const source = fs.readFileSync(new URL('../../packages/hud-mcp/workflows/ticket-queue.toml', import.meta.url), 'utf8');
  const plan = loadGraph(source, 'toml', { roles, bindings: { feature: 'sample', max_parallel: 2 } });
  assert.equal(plan.name, 'ticket-queue');
  assert.equal(plan.policy.breaker, 'first');
  assert.equal(plan.cost, 'cheap');
  assert.deepEqual(plan.steps.tickets, {
    kind: 'batch', needs: [], from: [], optional: false, role: 'imp',
    tickets: 'sample', each: ['job', 'land'], pilot: false, max_parallel: 2,
  });
  assert.equal(plan.steps.review.kind, 'job');
  assert.equal(plan.steps.review.role, 'reviewer');
  assert.deepEqual(plan.steps.review.needs, ['tickets']);
  assert.equal(plan.steps.accept.kind, 'handback');
  assert.deepEqual(plan.steps.accept.needs, ['review']);
  assert.deepEqual(plan.steps.accept.options, ['finish', 'repair', 'escalate']);
  const uncapped = loadGraph(source, 'toml', { roles, bindings: { feature: 'sample', max_parallel: undefined } });
  assert.equal(uncapped.steps.tickets.max_parallel, undefined);
  for (const bad of [
    { tickets: 'Bad_Slug' },
    { tickets: 'sample', items: [{ task: 'x' }] },
    { tickets: 'sample', manifest: 'manifest.json' },
    { tickets: 'sample', each: ['land'] },
    { tickets: 'sample', each: ['land', 'job'] },
    { tickets: 'sample', pilot: 'no' },
    { items: [{ task: 'x' }], each: ['job', 'land'] },
  ]) assert.throws(() => loadGraph({ version: 1, name: 'ticket-queue', steps: { t: { kind: 'batch', role: 'imp', ...bad } } }, 'json', { roles }), /invalid_workflow/);
  assert.throws(() => loadGraph({
    version: 1, name: 'bad-handback',
    steps: { a: { kind: 'handback', ask: 'Go?', options: ['go', 'stop'], to: 'nobody' } },
  }, 'json', { roles }), /invalid_workflow/);
});

test('ticket queue keeps going after origin MCP and pane exit; lead opens in project workspace, closes, and delivers end notice to next main', { timeout: 45_000 }, async t => {
  const f = await project(t);
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root });
  const [first] = await f.jobs(flow, 1);
  const initial = f.flow(flow);
  assert.equal(initial.template, 'ticket-queue');
  assert.equal(initial.host, 'detached');
  assert.equal(initial.workspace, 'w4E');
  assert.equal(initial.steps.tickets.state, 'running');
  assert.equal(f.job(first).workflow, flow);
  assert.equal(f.job(first).ticket_queue, flow);
  assert.equal(fs.statSync(join(f.home, 'flows', flow, 'graph.json')).mode & 0o777, 0o600);

  // Concurrent detached driver loses election without modifying the receipt.
  execFileSync(process.execPath, [runner, flow], { env: f.env, cwd: f.root, timeout: 4000 });
  assert.equal(f.flow(flow).pid, initial.pid);

  // Origin main session closes (pane gone, MCP killed). The run keeps going, lands all tickets, reviews, and runs lead acceptance.
  const { pane, origin_mcp: { pid } } = initial;
  f.overrideBin('herdr', `#!/bin/sh\nif [ "$1 $2 $3" = 'pane get ${pane}' ]; then exit 1; fi\nexec node "$FAKE_BIN" herdr "$@"\n`);
  assert.ok(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`HUD_HOME=${f.home}`));
  process.kill(pid, 'SIGKILL');
  await f.stopMcp();

  await f.settle(first);
  const [, second] = await f.jobs(flow, 2);
  assert.equal(f.job(second).ticket, 'sample/02');
  await f.settle(second);

  // Wait for milestone reviewer step and settle it.
  await until(() => Boolean(f.flow(flow).review_job), 15_000);
  const reviewJob = f.flow(flow).review_job;
  assert.equal(f.job(reviewJob).role, 'reviewer');
  assert.equal(f.job(reviewJob).herdr_pane, undefined);
  await f.settleReview(reviewJob);

  // Wait for lead acceptance step; verify lead opened in project workspace w4E, not the dead main pane.
  await until(() => f.flow(flow).active_lead?.kind === 'accept', 15_000);
  const leadId = f.flow(flow).active_lead.job;
  const leadReceipt = f.job(leadId);
  assert.equal(leadReceipt.role, 'lead');
  assert.equal(leadReceipt.cli.agent, 'claude');
  assert.equal(leadReceipt.herdr_pane, undefined);
  assert.equal(leadReceipt.herdr_workspace, 'w4E');

  const commands = fs.readFileSync(f.env.FAKE_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const leadTabCreate = commands.find(c => c.command === 'herdr' && c.args[0] === 'tab' && c.args[1] === 'create' &&
    c.args.includes(`HUD_JOB_DIR=${f.dir(leadId)}`));
  assert.ok(leadTabCreate, 'lead tab create logged');
  const wsIdx = leadTabCreate.args.indexOf('--workspace');
  assert.equal(leadTabCreate.args[wsIdx + 1], 'w4E');

  await f.settleLead(leadId, 'Decision: finish\nReason: Verified checks and review.\nTodo: Revisit edge case later\n');
  const done = await f.end(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(done.steps.tickets.state, 'done');
  assert.equal(done.steps.review.state, 'done');
  assert.equal(done.steps.accept.state, 'done');
  assert.equal(done.steps.accept.answer, 'finish');
  assert.ok(f.job(leadId).reaped_at, 'lead job closed via normal HUD closure');
  const afterLog = fs.readFileSync(f.env.FAKE_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(afterLog.some(c => c.command === 'hud-reap' && c.args[0] === f.dir(leadId)), 'hud-reap closed lead');

  const line = done.notices['end-0'];
  assert.equal(line, `${flow} (ticket queue sample) — completed. Landed: sample/01, sample/02. Verdict: finish: Verified checks and review. Todo: 1.`);
  const marker = join(f.home, 'flows', `${flow}.json.noticed`);
  assert.ok(!fs.existsSync(marker));

  function nextMain(cwd) {
    const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-mcp.mjs')], {
      cwd, env: { ...f.env, HERDR_PANE_ID: 'w4E:p8' }, stdio: ['pipe', 'pipe', 'inherit'],
    });
    const exited = once(child, 'exit');
    f.onCleanup(() => stopChild(child, exited, { closeStdin: true }));
    const rpc = rpcClient(child);
    return async () => resultValue((await rpc('tools/call', { name: 'hud_read', arguments: { job: flow } })).result);
  }
  const unrelated = fs.mkdtempSync(join(tmpdir(), 'hud-other-'));
  t.after(() => fs.rmSync(unrelated, { recursive: true, force: true }));
  const stranger = await nextMain(unrelated)();
  assert.equal(stranger.code, 'flow_not_found');
  assert.ok(!stranger.changes?.includes(line));
  assert.ok(!fs.existsSync(marker));

  const readMain = nextMain(f.root), firstRead = await readMain();
  assert.deepEqual(firstRead.landed, ['sample/01', 'sample/02']);
  assert.equal(firstRead.verdict, 'finish: Verified checks and review.');
  assert.deepEqual(firstRead.todo, [{ source: `lead (${leadId})`, kind: 'lead', text: 'Revisit edge case later' }]);
  assert.deepEqual(firstRead.changes.filter(l => l === line), [line]);
  assert.ok(fs.existsSync(marker));
  assert.ok(!(await readMain()).changes?.includes(line));
});

test('pane-less unattended ticket queue dispatches, lands, reviews, accepts, and completes with no main pane', { timeout: 45_000 }, async t => {
  const f = await project(t, { count: 1 });
  const env = { ...f.env }; delete env.HERDR_PANE_ID;
  const started = execFileSync(process.execPath, [
    '--input-type=module', '-e',
    `import { startTicketQueue } from './dist/mcp/ticket-queue.js';
     const q = await startTicketQueue(process.env.HUD_HOME, process.argv[1], null, false, { feature: 'sample', max_parallel: 1 });
     process.stdout.write(JSON.stringify(q));`,
    f.root,
  ], { env, encoding: 'utf8' });
  const { flow } = JSON.parse(started);
  assert.match(flow, /^q[0-9a-f]{16}$/);
  assert.equal(f.flow(flow).pane, '');
  const [first] = await f.jobs(flow, 1);
  assert.equal(f.job(first).ticket, 'sample/01');
  await f.settle(first);
  await until(() => Boolean(f.flow(flow).review_job), 15_000);
  await f.settleReview(f.flow(flow).review_job);
  await until(() => f.flow(flow).active_lead?.kind === 'accept', 15_000);
  await f.settleLead(f.flow(flow).active_lead.job);
  const done = await f.end(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.match(f.git(f.root, 'show', `base:${f.ticketPath(1)}`), /\*\*Status:\*\* done/);
});

test('to: main question hand-back auto-resumes on hud_respond and Blockers: pauses without waking main', { timeout: 45_000 }, async t => {
  const f = await project(t, { secondBlocker: 'none', count: 2 });
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root, handback_to: 'main' });
  const [first] = await f.jobs(flow, 1);
  const qa = join(f.dir(first), 'qa');
  fs.mkdirSync(qa, { recursive: true });
  writeFixtureFile(join(qa, 'q1.md'), '# Question q1 from Synthetic\n\nChoose a synthetic path.\n');
  const stopped = await f.end(flow);
  assert.equal(stopped.state, 'failed');
  assert.deepEqual(stopped.handback, {
    step: 'tickets', choices: ['resume', 'stop'], kind: 'question', ticket: 'sample/01', job: first, question: 'q1',
  });

  // Origin main exits; a fresh project main in another pane answers and resumes the queue.
  await f.stopMcp();
  const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-mcp.mjs')], {
    cwd: f.root, env: { ...f.env, HERDR_PANE_ID: 'w4E:p9' }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = once(child, 'exit');
  f.onCleanup(() => stopChild(child, exited, { closeStdin: true }));
  const rpc = rpcClient(child);
  const reply = resultValue((await rpc('tools/call', {
    name: 'hud_respond', arguments: { job: first, request_id: 'q1', answer: 'Take the synthetic path.' },
  })).result);
  assert.match(reply.queue_resumed, /^q[0-9a-f]{16}$/);
  assert.notEqual(reply.queue_resumed, flow);
  assert.equal(f.flow(reply.queue_resumed).state, 'working');
  assert.deepEqual(f.flow(reply.queue_resumed).tickets.map(x => x.job), [first]);

  // A Blockers: report pauses the run with structured blocker metadata and NO wake to main.
  await f.settle(first, { report: 'Synthetic finished report.\n\nBlockers: requires spec change\n' });
  const blocked = await f.end(reply.queue_resumed);
  assert.equal(blocked.state, 'paused');
  assert.equal(blocked.no_wake, true);
  assert.deepEqual(blocked.notices, {});
  assert.deepEqual(blocked.handback, {
    step: 'tickets', choices: ['resume', 'stop'], kind: 'blocker', ticket: 'sample/01', job: first,
  });
  const readAfter = resultValue((await rpc('tools/call', { name: 'hud_read', arguments: { job: reply.queue_resumed } })).result);
  assert.equal(readAfter.state, 'paused');
  assert.equal(readAfter.changes, undefined);
});

test('workflow-runner adopts a pre-upgrade legacy q receipt without template or graph.json', { timeout: 30_000 }, async t => {
  const f = await project(t, { count: 1 });
  const flow = 'q0000000000000009';
  const now = new Date().toISOString();
  fs.mkdirSync(join(f.home, 'flows'), { recursive: true });
  writeFixtureFile(join(f.home, 'flows', `${flow}.json`), JSON.stringify({
    flow, root: f.root, feature: 'sample', pane: f.env.HERDR_PANE_ID, task: false, max_parallel: 1,
    created_at: now, updated_at: now, state: 'working', tickets: [],
  }));
  const child = spawn(process.execPath, [runner, flow], { cwd: f.root, env: f.env, stdio: 'ignore' });
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const [first] = await f.jobs(flow, 1);
  assert.equal(f.flow(flow).template, 'ticket-queue');
  assert.ok(fs.existsSync(join(f.home, 'flows', flow, 'graph.json')));
  await f.settle(first);
  const done = await f.end(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.deepEqual(await exited, [0, null]);
});

test('retention prunes an expired terminal ticket-queue receipt together with its workflow directory and sidecars', t => {
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-q-retain-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const flow = 'q000000000000000a', flows = join(home, 'flows'), dir = join(flows, flow), receipt = join(flows, `${flow}.json`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'graph.json'), JSON.stringify({ version: 1, name: 'ticket-queue' }));
  fs.writeFileSync(receipt, JSON.stringify({ flow, state: 'completed' }));
  fs.writeFileSync(`${receipt}.noticed`, '');
  const old = new Date(Date.now() - 48 * 3600_000);
  fs.utimesSync(receipt, old, old);
  pruneLandFlows(home, Date.now());
  assert.equal(fs.existsSync(receipt), false);
  assert.equal(fs.existsSync(`${receipt}.noticed`), false);
  assert.equal(fs.existsSync(dir), false);
});
