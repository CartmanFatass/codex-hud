import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { reportSignature } from '../../dist/roles/cli-turn.js';
import { cleanupFixture, stopChild } from '../helpers/process-cleanup.mjs';
import { fixture, resultValue, rpcClient, until } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

async function setupProject(t, tickets) {
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
  for (const [name, body] of Object.entries(tickets)) {
    fs.writeFileSync(join(f.root, issues, name), body);
  }
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
  const settleTicket = async (id, { report = 'Synthetic finished report.\n' } = {}) => {
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
  const settleLead = async (id, report) => {
    await until(() => settleCli(id, report), 10_000);
  };
  const end = async id => {
    await until(() => flow(id).state !== 'working', 20_000);
    return flow(id);
  };
  const fakeLog = () => fs.readFileSync(f.env.FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { ...f, dir, end, fakeLog, flow, git, home, issues, job, jobs, settleLead, settleReview, settleTicket };
}

const goodTicket = (n, blocked = 'none', liveTry = 'none') =>
  `# 0${n}: Synthetic ${n}\n\n**Status:** ready-for-agent\n**Owner try:** no\n**Live try:** ${liveTry}\n**Blocked by:** ${blocked}\n\n**What to build:** Synthetic change ${n}\n\n- [ ] Checked\n\n## Comments\n`;

test('ticket check refuses a run with gaps and lists every missing field', { timeout: 20_000 }, async t => {
  const f = await setupProject(t, {
    '01-gaps.md': '# 01: Missing pieces\n\n**Status:** ready-for-agent\n**Blocked by:** 99\n\n## Comments\n',
    '02-no-try.md': '# 02: Missing live try\n\n**Status:** ready-for-agent\n**Blocked by:** none\n\n**What to build:** Something.\n\n- [ ] One check\n\n## Comments\n',
  });
  const { result } = await f.rpc('tools/call', {
    name: 'hud_tickets', arguments: { op: 'run', feature: 'sample', cwd: f.root },
  });
  assert.equal(result.isError, true);
  const error = JSON.parse(result.content[0].text).error;
  assert.match(error, /ticket_check_failed/);
  assert.match(error, /sample\/01:.*missing goal \(What to build\).*missing acceptance items.*unknown blocked_by ticket: 99.*missing Live try/);
  assert.match(error, /sample\/02:.*missing Live try/);
  assert.equal(fs.existsSync(join(f.home, 'flows')), false);
});

test('Assumed: lines move to run todo; four assumptions or a scope assumption pause with no main wake', { timeout: 45_000 }, async t => {
  const f = await setupProject(t, {
    '01-two-assumed.md': goodTicket(1),
    '02-four-assumed.md': goodTicket(2, '01'),
  });
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root });
  const [first] = await f.jobs(flow, 1);
  // Brief includes the workflow run rule.
  assert.match(fs.readFileSync(join(f.dir(first), 'brief.md'), 'utf8'), /Workflow run rule:.*Assumed:.*Blockers:/);

  await f.settleTicket(first, {
    report: 'Synthetic done.\n\nAssumed: keep default timeout\nAssumed: preserve JSON field order\n',
  });
  const [, second] = await f.jobs(flow, 2);
  const midRead = await f.call('hud_read', { job: flow });
  assert.deepEqual(midRead.todo.map(x => x.text), ['keep default timeout', 'preserve JSON field order']);
  assert.equal(midRead.changes, undefined);

  // 4 assumptions trigger the assumption breaker -> paused with NO main wake.
  await f.settleTicket(second, {
    report: 'Synthetic done.\n\nAssumed: one\nAssumed: two\nAssumed: three\nAssumed: four\n',
  });
  const paused = await f.end(flow);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.no_wake, true);
  assert.deepEqual(paused.notices, {});
  assert.equal(paused.handback.kind, 'assumption');
  assert.equal(paused.todo.length, 6);
  const after = await f.call('hud_read', { job: flow });
  assert.equal(after.changes, undefined);
  assert.equal(after.todo.length, 6);
});

test('a single scope assumption pauses the run with no main wake', { timeout: 30_000 }, async t => {
  const f = await setupProject(t, { '01-scope.md': goodTicket(1) });
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root });
  const [first] = await f.jobs(flow, 1);
  await f.settleTicket(first, { report: 'Done.\n\nAssumed: [scope] added a new public command\n' });
  const paused = await f.end(flow);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.no_wake, true);
  assert.deepEqual(paused.notices, {});
  assert.equal(paused.handback.kind, 'assumption');
  assert.match(paused.reason, /scope assumption/);
  assert.equal((await f.call('hud_read', { job: flow })).changes, undefined);
});

test('worker question starts a temporary lead that answers and closes; two hand-backs start two separate leads with none alive between decisions', { timeout: 45_000 }, async t => {
  const f = await setupProject(t, { '01-question.md': goodTicket(1) });
  // Set a tight cap of 1 on lead to verify lead runs outside role caps.
  writeFixtureFile(f.env.HUD_SETTINGS_PATH, JSON.stringify({ autoPrewalk: false, roleCaps: { lead: 1, imp: 1 } }));
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root });
  const [first] = await f.jobs(flow, 1);

  // Worker asks a question -> temporary lead starts, main is NOT woken.
  const qa = join(f.dir(first), 'qa');
  fs.mkdirSync(qa, { recursive: true });
  writeFixtureFile(join(qa, 'q1.md'), '# Question q1 from Synthetic\n\nShould we keep format A or B?\n');
  await until(() => f.flow(flow).active_lead?.kind === 'question', 15_000);
  const lead1 = f.flow(flow).active_lead.job;
  assert.equal(f.job(lead1).role, 'lead');
  assert.equal(f.job(lead1).cli.agent, 'claude');
  assert.equal(f.job(lead1).model, 'claude-opus-5-5');
  assert.equal(f.job(lead1).thinking, 'high');
  assert.equal((await f.call('hud_read', { job: flow })).changes, undefined);

  // Verify the lead job has main-session HUD MCP tools + hud_report (and NOT hud_ask).
  const leadMcp = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-mcp.mjs')], {
    cwd: f.root, env: { ...f.env, HUD_JOB_DIR: f.dir(lead1) }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const leadMcpExit = once(leadMcp, 'exit');
  f.onCleanup(() => stopChild(leadMcp, leadMcpExit, { closeStdin: true }));
  const leadRpc = rpcClient(leadMcp);
  const listed = (await leadRpc('tools/list')).result.tools.map(tool => tool.name);
  assert.ok(listed.includes('hud_read') && listed.includes('hud_tickets') && listed.includes('hud_report'));
  assert.ok(!listed.includes('hud_ask'));
  const leadReadFlow = resultValue((await leadRpc('tools/call', { name: 'hud_read', arguments: { job: flow } })).result);
  assert.equal(leadReadFlow.flow, flow);
  assert.equal(leadReadFlow.changes, undefined);

  // Lead 1 answers the question and must be closed immediately before work resumes.
  await f.settleLead(lead1, 'Decision: answer\nReason: Format A matches the spec.\nAnswer: Use format A.\nTodo: Document format A in reference\n');
  await until(() => !f.flow(flow).active_lead && fs.existsSync(join(qa, 'q1.answer.md')), 15_000);
  assert.equal(fs.readFileSync(join(qa, 'q1.answer.md'), 'utf8'), 'Use format A.');
  assert.ok(f.job(lead1).reaped_at, 'question lead closed immediately after answering');
  assert.ok(f.fakeLog().some(c => c.command === 'hud-reap' && c.args[0] === f.dir(lead1)));

  // Between decisions: assert NO lead job is un-reaped/alive.
  const leadJobsBetween = fs.readdirSync(join(f.home, 'jobs'))
    .filter(id => /^j[a-f0-9]{16}$/.test(id))
    .map(id => f.job(id))
    .filter(j => j.role === 'lead');
  assert.equal(leadJobsBetween.length, 1);
  assert.ok(leadJobsBetween.every(j => Boolean(j.reaped_at)), 'no lead alive between decisions');

  // Ticket 01 settles and lands -> milestone reviewer -> acceptance starts Lead 2 (separate job!).
  await f.settleTicket(first);
  await until(() => Boolean(f.flow(flow).review_job), 15_000);
  await f.settleReview(f.flow(flow).review_job);
  await until(() => f.flow(flow).active_lead?.kind === 'accept', 15_000);
  const lead2 = f.flow(flow).active_lead.job;
  assert.notEqual(lead2, lead1);
  assert.equal(f.job(lead2).role, 'lead');

  await f.settleLead(lead2, 'Decision: finish\nReason: Clean acceptance.\n');
  const done = await f.end(flow);
  assert.equal(done.state, 'completed');
  assert.ok(f.job(lead2).reaped_at, 'acceptance lead closed after answering');
  assert.ok(f.fakeLog().some(c => c.command === 'hud-reap' && c.args[0] === f.dir(lead2)));
  assert.equal(done.decisions.length, 2);
  assert.deepEqual(done.decisions.map(d => d.job), [lead1, lead2]);
  const mainRead = await f.call('hud_read', { job: flow });
  assert.equal(mainRead.changes.length, 1);
  assert.match(mainRead.changes[0], /Verdict: finish: Clean acceptance\. Todo: 1\./);
});

test('ticket queue repair round adds a ticket and finishes cleanly on second verdict with exactly one end notice', { timeout: 45_000 }, async t => {
  const f = await setupProject(t, { '01-initial.md': goodTicket(1, 'none', 'Run synthetic smoke') });
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root });
  const [first] = await f.jobs(flow, 1);
  await f.settleTicket(first);

  await until(() => Boolean(f.flow(flow).review_job), 15_000);
  const review1 = f.flow(flow).review_job;
  await f.settleReview(review1);

  await until(() => f.flow(flow).active_lead?.kind === 'accept', 15_000);
  const lead1 = f.flow(flow).active_lead.job;
  assert.match(fs.readFileSync(join(f.dir(lead1), 'brief.md'), 'utf8'), /Live try: Run synthetic smoke/);

  // Lead 1 adds a repair ticket via hud_tickets and reports Decision: repair.
  await f.call('hud_tickets', {
    op: 'add', cwd: f.root, feature: 'sample',
    tickets: [{ title: 'Repair edge case', blocked_by: [1], what: 'Fix reviewer finding.', acceptance: ['Edge case fixed'], live_try: 'none' }],
  });
  await f.settleLead(lead1, 'Decision: repair\nReason: Fix reviewer finding in ticket 02.\nTodo: Consider refactor later\n');

  // Repair round 1 dispatches ticket 02 with NO wake to main.
  const [, repairTicketJob] = await f.jobs(flow, 2);
  assert.equal(f.job(repairTicketJob).ticket, 'sample/02');
  assert.equal(f.flow(flow).repair_rounds, 1);
  assert.ok(f.job(lead1).reaped_at, 'round 1 lead closed before repair round');
  assert.equal((await f.call('hud_read', { job: flow })).changes, undefined);

  await f.settleTicket(repairTicketJob);
  await until(() => f.flow(flow).review_job && f.flow(flow).review_job !== review1, 15_000);
  const review2 = f.flow(flow).review_job;
  await f.settleReview(review2);

  await until(() => f.flow(flow).active_lead?.kind === 'accept', 15_000);
  const lead2 = f.flow(flow).active_lead.job;
  assert.notEqual(lead2, lead1);
  await f.settleLead(lead2, 'Decision: finish\nReason: Repair verified and clean.\n');

  const done = await f.end(flow);
  assert.equal(done.state, 'completed');
  assert.ok(f.job(lead2).reaped_at);
  assert.equal(done.reviews.length, 2);
  assert.equal(done.decisions.length, 2);
  const read1 = await f.call('hud_read', { job: flow });
  assert.deepEqual(read1.landed, ['sample/01', 'sample/02']);
  assert.equal(read1.changes.length, 1);
  assert.match(read1.changes[0], /Verdict: finish: Repair verified and clean\. Todo: 1\./);
  assert.equal((await f.call('hud_read', { job: flow })).changes, undefined);
});

test('configurable escalation_rule reaches lead packet; escalate wakes main once; to: main skips lead and wakes main', { timeout: 45_000 }, async t => {
  const f = await setupProject(t, { '01-item.md': goodTicket(1) });
  const rule = 'Escalate only an item that would delete a user-visible feature or change the spec.';
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root, escalation_rule: rule });
  const [first] = await f.jobs(flow, 1);
  await f.settleTicket(first);
  await until(() => Boolean(f.flow(flow).review_job), 15_000);
  await f.settleReview(f.flow(flow).review_job);
  await until(() => f.flow(flow).active_lead?.kind === 'accept', 15_000);
  const leadId = f.flow(flow).active_lead.job;
  assert.ok(fs.readFileSync(join(f.dir(leadId), 'brief.md'), 'utf8').includes(rule));

  await f.settleLead(leadId, 'Decision: escalate\nReason: Would delete a user-visible feature.\n');
  const escalated = await f.end(flow);
  assert.equal(escalated.state, 'paused');
  assert.equal(escalated.handback.kind, 'escalate');
  assert.ok(f.job(leadId).reaped_at);
  const readEsc = await f.call('hud_read', { job: flow });
  assert.equal(readEsc.changes.length, 1);
  assert.match(readEsc.changes[0], /escalated: Would delete a user-visible feature/);
  assert.equal((await f.call('hud_read', { job: flow })).changes, undefined);

  // Separate feature with handback_to: main wakes main directly at accept with zero lead jobs.
  const mainIssues = join(f.root, '.scratch', 'direct', 'issues');
  fs.mkdirSync(mainIssues, { recursive: true });
  fs.writeFileSync(join(mainIssues, '01-direct.md'), goodTicket(1));
  f.git(f.root, 'add', '.scratch');
  f.git(f.root, 'commit', '-qm', 'direct feature');
  const { flow: directFlow } = await f.call('hud_tickets', { op: 'run', feature: 'direct', max_parallel: 1, cwd: f.root, handback_to: 'main' });
  const [dJob] = await f.jobs(directFlow, 1);
  await f.settleTicket(dJob);
  await until(() => Boolean(f.flow(directFlow).review_job), 15_000);
  await f.settleReview(f.flow(directFlow).review_job);
  const pausedMain = await f.end(directFlow);
  assert.equal(pausedMain.state, 'paused');
  assert.equal(pausedMain.steps.accept.state, 'asking');
  assert.deepEqual(pausedMain.handback, { step: 'accept', choices: ['finish', 'repair', 'escalate'] });
  assert.equal(pausedMain.decisions, undefined);
  const readDirect = await f.call('hud_read', { job: directFlow });
  assert.equal(readDirect.changes.length, 1);
  assert.match(readDirect.changes[0], /hand-back at accept/);
});

test('repair rounds are bounded to at most 2, then escalate and wake main once', { timeout: 60_000 }, async t => {
  const f = await setupProject(t, { '01-first.md': goodTicket(1) });
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root });
  let prevReview;
  let prevLead;
  for (let round = 0; round < 3; round++) {
    const ticketJobs = await f.jobs(flow, round + 1);
    await f.settleTicket(ticketJobs[round]);
    await until(() => f.flow(flow).review_job && f.flow(flow).review_job !== prevReview, 15_000);
    prevReview = f.flow(flow).review_job;
    await f.settleReview(prevReview);
    await until(() => f.flow(flow).active_lead?.kind === 'accept' && f.flow(flow).active_lead.job !== prevLead, 15_000);
    prevLead = f.flow(flow).active_lead.job;
    if (round < 2) {
      await f.call('hud_tickets', {
        op: 'add', cwd: f.root, feature: 'sample',
        tickets: [{ title: `Repair ${round + 1}`, blocked_by: [], what: `Fix round ${round + 1}.`, acceptance: ['Fixed'], live_try: 'none' }],
      });
    }
    await f.settleLead(prevLead, `Decision: repair\nReason: Still needs repair ${round + 1}.\n`);
  }
  const escalated = await f.end(flow);
  assert.equal(escalated.state, 'paused');
  assert.equal(escalated.repair_rounds, 2);
  assert.equal(escalated.handback.kind, 'escalate');
  assert.match(escalated.reason, /max repair rounds \(2\) reached/);
  assert.ok(f.job(prevLead).reaped_at);
  const readEsc = await f.call('hud_read', { job: flow });
  assert.equal(readEsc.changes.length, 1);
  assert.match(readEsc.changes[0], /max repair rounds \(2\) reached/);
});
