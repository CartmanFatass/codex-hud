import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { stopChild } from '../helpers/process-cleanup.mjs';
import { resultValue, rpcClient, until } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { goodTicket, setupWorkflowProject } from '../helpers/workflow-ticket-project.mjs';

test('ticket check refuses a run with gaps including empty Approved removals and lists every missing field', { timeout: 20_000 }, async t => {
  const f = await setupWorkflowProject(t, {
    tickets: {
      '01-gaps.md': '# 01: Missing pieces\n\n**Status:** ready-for-agent\n**Blocked by:** 99\n\n## Comments\n',
      '02-no-try.md': '# 02: Missing live try\n\n**Status:** ready-for-agent\n**Approved removals:**\n**Blocked by:** none\n\n**What to build:** Something.\n\n- [ ] One check\n\n## Comments\n',
    },
  });
  const { result } = await f.rpc('tools/call', {
    name: 'hud_tickets', arguments: { op: 'run', feature: 'sample', cwd: f.root },
  });
  assert.equal(result.isError, true);
  const error = JSON.parse(result.content[0].text).error;
  assert.match(error, /ticket_check_failed/);
  assert.match(error, /sample\/01:.*missing goal \(What to build\).*missing acceptance items.*unknown blocked_by ticket: 99.*missing Live try/);
  assert.match(error, /sample\/02:.*missing Live try.*empty Approved removals/);
  assert.equal(fs.existsSync(join(f.home, 'flows')), false);

  // hud_tickets op: add supports optional approved_removals.
  const added = await f.call('hud_tickets', {
    op: 'add', cwd: f.root, feature: 'sample',
    tickets: [
      { title: 'With removals', blocked_by: [], what: 'Remove old panel.', acceptance: ['Removed'], live_try: 'none', approved_removals: 'old-panel' },
      { title: 'Live try in multiline what', blocked_by: [], what: 'Update greeting text.\n\n**Live try:** run ./greet', acceptance: ['Updated'] },
      { title: 'Live try inline in what', blocked_by: [], what: 'Update banner text. **Live try:** none', acceptance: ['Updated'] },
      { title: 'Explicit live_try keeps what', blocked_by: [], what: 'Keep prose.\n**Live try:** ignored', acceptance: ['Kept'], live_try: 'run explicit' },
      { title: 'Prose mentioning live try', blocked_by: [], what: 'Add a Live try: parser rule.', acceptance: ['Added'] },
    ],
  });
  assert.equal(added.ok, true);
  assert.match(fs.readFileSync(added.tickets[0].path, 'utf8'), /\*\*Approved removals:\*\* old-panel/);
  const movedMulti = fs.readFileSync(added.tickets[1].path, 'utf8');
  assert.match(movedMulti, /^\*\*Live try:\*\* run \.\/greet$/m);
  assert.match(movedMulti, /^\*\*What to build:\*\* Update greeting text\.$/m);
  const movedInline = fs.readFileSync(added.tickets[2].path, 'utf8');
  assert.match(movedInline, /^\*\*Live try:\*\* none$/m);
  assert.match(movedInline, /^\*\*What to build:\*\* Update banner text\.$/m);
  const keptExplicit = fs.readFileSync(added.tickets[3].path, 'utf8');
  assert.match(keptExplicit, /^\*\*Live try:\*\* run explicit$/m);
  assert.match(keptExplicit, /\*\*What to build:\*\* Keep prose\. \*\*Live try:\*\* ignored/);
  const proseOnly = fs.readFileSync(added.tickets[4].path, 'utf8');
  assert.doesNotMatch(proseOnly, /^\*\*Live try:\*\*/m);
  assert.match(proseOnly, /^\*\*What to build:\*\* Add a Live try: parser rule\.$/m);
});

test('Assumed: lines move to run todo; four assumptions pause a main hand-back without waking main', { timeout: 45_000 }, async t => {
  const f = await setupWorkflowProject(t, {
    tickets: {
      '01-two-assumed.md': goodTicket(1),
      '02-four-assumed.md': goodTicket(2, { blocked: '01' }),
    },
  });
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root, handback_to: 'main' });
  const [first] = await f.jobs(flow, 1);
  // Brief includes the workflow run rule and Removes: instruction.
  assert.match(fs.readFileSync(join(f.dir(first), 'brief.md'), 'utf8'), /Workflow run rule:.*Assumed:.*Blockers:.*Removes:/);

  await f.settle(first, {
    report: 'Synthetic done.\n\nAssumed: keep default timeout\nAssumed: preserve JSON field order\n',
  });
  const [, second] = await f.jobs(flow, 2);
  const midRead = await f.call('hud_read', { job: flow });
  assert.deepEqual(midRead.todo.map(x => x.text), ['keep default timeout', 'preserve JSON field order']);
  assert.equal(midRead.changes, undefined);

  // 4 assumptions trigger the assumption breaker -> paused with NO main wake (empty notices, no stored no_wake).
  await f.settle(second, {
    report: 'Synthetic done.\n\nAssumed: one\nAssumed: two\nAssumed: three\nAssumed: four\n',
  });
  const paused = await f.end(flow);
  assert.equal(paused.state, 'paused');
  assert.equal('no_wake' in paused, false);
  assert.equal('pause_notice' in paused, false);
  assert.deepEqual(paused.notices, {});
  assert.equal(paused.handback.kind, 'assumption');
  assert.equal(paused.todo.length, 6);
  const after = await f.call('hud_read', { job: flow });
  assert.equal(after.changes, undefined);
  assert.equal(after.todo.length, 6);
  assert.match(after.pause_notice, /Assumed: lines/);
});

for (const { label, handback_to, report } of [
  { label: 'a scope assumption on default hand-back', report: 'Done.\nAssumed: [scope] kept the old command.\n' },
  { label: 'four assumptions on explicit lead hand-back', handback_to: 'lead', report: 'Done.\nAssumed: one\nAssumed: two\nAssumed: three\nAssumed: four\n' },
]) {
  test(`${label} goes to a temporary lead and lands on continue without waking main`, { timeout: 45_000 }, async t => {
    const f = await setupWorkflowProject(t, { count: 1 });
    const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root, handback_to });
    const [first] = await f.jobs(flow, 1);
    await f.settle(first, { report });
    await until(() => f.flow(flow).active_lead?.kind === 'assumption', 15_000);
    const waiting = f.flow(flow);
    const lead = waiting.active_lead.job;
    assert.equal(waiting.unattended, undefined);
    assert.equal(waiting.state, 'working');
    assert.equal(waiting.active_lead.worker_job, first);
    assert.equal(waiting.tickets[0].land, undefined);
    assert.equal(f.job(lead).role, 'lead');
    assert.deepEqual(waiting.notices, {});
    assert.equal((await f.call('hud_read', { job: flow })).changes, undefined);

    await f.settleLead(lead, 'Decision: continue\nReason: The assumptions fit the current spec.\n');
    await until(() => f.flow(flow).tickets[0].landed, 15_000);
    assert.ok(f.job(lead).reaped_at, 'the assumption lead closes before land');
    assert.deepEqual(f.flow(flow).notices, {});
    assert.equal((await f.call('hud_read', { job: flow })).changes, undefined);
  });
}

test('an assumption lead hold for visible deletion becomes an owner hand-back in an ordinary queue', { timeout: 45_000 }, async t => {
  const f = await setupWorkflowProject(t, { tickets: { '01-scope.md': goodTicket(1) } });
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root });
  const [first] = await f.jobs(flow, 1);
  await f.settle(first, { report: 'Done.\nAssumed: [scope] removed the old command.\n' });
  await until(() => f.flow(flow).active_lead?.kind === 'assumption', 15_000);
  const lead = f.flow(flow).active_lead.job;
  await f.settleLead(lead, 'Decision: hold\nReason: Deletes a user-visible command.\nOwner approval: feature-deletion\n');
  const paused = await f.end(flow);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.handback.kind, 'escalate');
  assert.equal(paused.handback.owner_approval, 'feature-deletion');
  assert.equal(paused.tickets[0].land, undefined);
  assert.equal(paused.tickets[0].held.owner_approval, 'feature-deletion');
  assert.equal(Object.keys(paused.notices).length, 1);
});

test('a scope assumption on main hand-back pauses without waking main; one resume accepts that report and lands', { timeout: 45_000 }, async t => {
  const f = await setupWorkflowProject(t, { tickets: { '01-scope.md': goodTicket(1) } });
  const args = { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root, handback_to: 'main' };
  const { flow } = await f.call('hud_tickets', args);
  const [first] = await f.jobs(flow, 1);
  const assumed = '[scope] added a new public command';
  await f.settle(first, { report: `Done.\n\nAssumed: ${assumed}\n` });
  const paused = await f.end(flow);
  assert.equal(paused.state, 'paused');
  assert.equal('no_wake' in paused, false);
  assert.deepEqual(paused.notices, {});
  assert.equal(paused.handback.kind, 'assumption');
  assert.match(paused.reason, /scope assumption/);
  assert.equal((await f.call('hud_read', { job: flow })).changes, undefined);
  const leads = fs.readdirSync(join(f.home, 'jobs')).filter(id => /^j[a-f0-9]{16}$/.test(id)).map(f.job).filter(j => j.role === 'lead');
  assert.equal(leads.length, 0, 'main-handback runs keep the breaker with zero leads');

  const resumed = await f.call('hud_tickets', args);
  assert.notEqual(resumed.flow, flow);
  await until(() => {
    const q = f.flow(resumed.flow);
    assert.equal(q.state, 'working', JSON.stringify(q));
    return Boolean(q.review_job);
  }, 15_000);
  const landed = await f.call('hud_read', { job: resumed.flow });
  assert.deepEqual(landed.landed, ['sample/01']);
  assert.equal(landed.jobs[0].job, first);
  assert.deepEqual(landed.todo, [{ source: `sample/01 (${first})`, kind: 'assumed', text: assumed }]);
});

for (const change of ['report', 'head']) {
  test(`a changed source ${change} is judged again on resuming an assumption hand-back`, { timeout: 45_000 }, async t => {
    const f = await setupWorkflowProject(t, { count: 1 });
    const args = { op: 'run', feature: 'sample', cwd: f.root, handback_to: 'main' };
    const { flow } = await f.call('hud_tickets', args);
    const [first] = await f.jobs(flow, 1);
    const report = 'Done.\nAssumed: [scope] kept the old command\n';
    await f.settle(first, { report });
    assert.equal((await f.end(flow)).handback.kind, 'assumption');

    if (change === 'report') {
      // A new turn settled while the queue was paused, keeping the source and Assumed: line unchanged.
      const sentAt = new Date().toISOString();
      writeFixtureFile(join(f.dir(first), 'job.json'), JSON.stringify({ ...f.job(first), pi_sent_at: sentAt }));
      await until(() => Date.now() > Date.parse(sentAt) + 1, t.signal);
      writeFixtureFile(join(f.dir(first), 'report.md'), report.replace('Done.', 'Updated.'));
      writeFixtureFile(join(f.dir(first), 'STATUS.json'), JSON.stringify({ state: 'closed', output_written: true, settled_at: new Date().toISOString() }));
    } else {
      // Move the source before resuming, leaving the report and its signature untouched.
      f.git(f.job(first).worktree.root, 'commit', '--allow-empty', '-qm', 'Updated synthetic source');
    }
    const resumed = await f.call('hud_tickets', args);
    assert.notEqual(resumed.flow, flow);
    const paused = await f.end(resumed.flow);
    assert.equal(paused.state, 'paused', JSON.stringify(paused));
    assert.equal(paused.handback.kind, 'assumption');
    assert.equal(paused.handback.job, first);
    assert.equal(paused.tickets[0].land, undefined);
  });
}

test('worker and reviewer questions use temporary leads with no hud_land; owner-try outside unattended stays ready-for-human', { timeout: 60_000 }, async t => {
  const f = await setupWorkflowProject(t, { tickets: { '01-question.md': goodTicket(1, { ownerTry: 'yes' }) } });
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

  // Verify the lead job has HUD MCP tools + hud_report, and NOT hud_ask OR hud_land.
  const leadMcp = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-mcp.mjs')], {
    cwd: f.root, env: { ...f.env, HUD_JOB_DIR: f.dir(lead1) }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const leadMcpExit = once(leadMcp, 'exit');
  f.onCleanup(() => stopChild(leadMcp, leadMcpExit, { closeStdin: true }));
  const leadRpc = rpcClient(leadMcp);
  const listed = (await leadRpc('tools/list')).result.tools.map(tool => tool.name);
  assert.ok(listed.includes('hud_read') && listed.includes('hud_tickets') && listed.includes('hud_report'));
  assert.ok(!listed.includes('hud_ask'));
  assert.ok(!listed.includes('hud_land'), 'lead must not be given hud_land');
  const landCall = await leadRpc('tools/call', { name: 'hud_land', arguments: { job: first } });
  assert.equal(landCall.result.isError, true);
  assert.equal(JSON.parse(landCall.result.content[0].text).code, 'worker_cannot_dispatch');
  const leadReadFlow = resultValue((await leadRpc('tools/call', { name: 'hud_read', arguments: { job: flow } })).result);
  assert.equal(leadReadFlow.flow, flow);
  assert.equal(leadReadFlow.changes, undefined);

  // Lead 1 answers the question and closes immediately.
  await f.settleLead(lead1, 'Decision: answer\nReason: Format A matches the spec.\nAnswer: Use format A.\nTodo: Document format A in reference\n');
  await until(() => !f.flow(flow).active_lead && fs.existsSync(join(qa, 'q1.answer.md')), 15_000);
  assert.equal(fs.readFileSync(join(qa, 'q1.answer.md'), 'utf8'), 'Use format A.');
  assert.ok(f.job(lead1).reaped_at, 'question lead closed immediately after answering');
  assert.ok(f.fakeLog().some(c => c.command === 'hud-reap' && c.args[0] === f.dir(lead1)));

  // Ticket 01 settles and lands -> milestone reviewer asks a question!
  await f.settle(first);
  await until(() => Boolean(f.flow(flow).review_job), 15_000);
  const reviewJob = f.flow(flow).review_job;
  const revQa = join(f.dir(reviewJob), 'qa');
  fs.mkdirSync(revQa, { recursive: true });
  writeFixtureFile(join(revQa, 'q1.md'), '# Question q1 from Reviewer\n\nWas format A intentional?\n');

  // Reviewer question routes through the SAME temporary-lead handler!
  await until(() => f.flow(flow).active_lead?.kind === 'question' && f.flow(flow).active_lead.worker_job === reviewJob, 15_000);
  const revLead = f.flow(flow).active_lead.job;
  assert.notEqual(revLead, lead1);
  await f.settleLead(revLead, 'Decision: answer\nReason: Intentional per prior decision.\nAnswer: Yes, format A is intentional.\n');
  await until(() => !f.flow(flow).active_lead && fs.existsSync(join(revQa, 'q1.answer.md')), 15_000);
  assert.equal(fs.readFileSync(join(revQa, 'q1.answer.md'), 'utf8'), 'Yes, format A is intentional.');
  assert.ok(f.job(revLead).reaped_at, 'reviewer question lead closed immediately');

  // Between decisions: assert NO lead job is un-reaped/alive.
  const leadJobsBetween = fs.readdirSync(join(f.home, 'jobs'))
    .filter(id => /^j[a-f0-9]{16}$/.test(id))
    .map(id => f.job(id))
    .filter(j => j.role === 'lead');
  assert.equal(leadJobsBetween.length, 2);
  assert.ok(leadJobsBetween.every(j => Boolean(j.reaped_at)), 'no lead alive between decisions');

  // Reviewer finishes -> acceptance starts Lead 3 (separate job).
  await f.settleReview(reviewJob);
  await until(() => f.flow(flow).active_lead?.kind === 'accept', 15_000);
  const lead3 = f.flow(flow).active_lead.job;
  assert.notEqual(lead3, revLead);
  await f.settleLead(lead3, 'Decision: finish\nReason: Clean acceptance.\n');
  const done = await f.end(flow);
  assert.equal(done.state, 'completed');
  assert.ok(f.job(lead3).reaped_at, 'acceptance lead closed after answering');
  assert.equal(done.decisions.length, 3);
  assert.deepEqual(done.decisions.map(d => d.job), [lead1, revLead, lead3]);

  // Outside unattended runs, Owner try: yes ticket stays ready-for-human!
  assert.match(fs.readFileSync(join(f.root, '.scratch/sample/issues/01-question.md'), 'utf8'), /\*\*Status:\*\* ready-for-human/);
  const mainRead = await f.call('hud_read', { job: flow });
  assert.equal(mainRead.changes.length, 1);
  assert.match(mainRead.changes[0], /Verdict: finish: Clean acceptance\. Todo: 1\./);
});

test('failed question delivery retries up to bound instead of looping on closed lead; refused lead close is not presented as closed', { timeout: 60_000 }, async t => {
  // Part 1: Failed delivery (headless worker not waiting -> question_not_open/worker_not_waiting) does NOT record success or loop.
  const f = await setupWorkflowProject(t, { tickets: { '01-delivery.md': goodTicket(1) } });
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root });
  const [first] = await f.jobs(flow, 1);
  // Make the worker appear headless with state=idle_grace (not waiting_orchestrator) so answerWorkerQuestion returns worker_not_waiting.
  writeFixtureFile(join(f.dir(first), 'job.json'), JSON.stringify({ ...f.job(first), headless: true }));
  writeFixtureFile(join(f.dir(first), 'STATUS.json'), JSON.stringify({ state: 'idle_grace', output_written: false }));
  const qa = join(f.dir(first), 'qa');
  fs.mkdirSync(qa, { recursive: true });
  writeFixtureFile(join(qa, 'q1.md'), '# Question q1\n\nAnswer me?\n');

  await until(() => f.flow(flow).active_lead?.kind === 'question', 15_000);
  const qLead = f.flow(flow).active_lead.job;
  await f.settleLead(qLead, 'Decision: answer\nReason: Trying to answer.\nAnswer: Go ahead.\n');

  // Delivery fails -> bounded retries -> escalates with delivery_failed, never spawning a 2nd lead or looping!
  const stopped = await f.end(flow);
  assert.equal(stopped.state, 'paused', JSON.stringify(stopped));
  assert.match(stopped.reason, /answer delivery failed.*worker_not_waiting/);
  assert.ok(stopped.decisions.some(d => d.decision === 'delivery_failed' && d.job === qLead));
  assert.ok(!stopped.decisions.some(d => d.decision === 'answer'));
  const allLeads = fs.readdirSync(join(f.home, 'jobs')).filter(id => /^j[a-f0-9]{16}$/.test(id)).map(f.job).filter(j => j.role === 'lead');
  assert.equal(allLeads.length, 1, 'no duplicate lead spawned on delivery failure');

  // Part 2: Refused lead close (herdr/hud-reap returns non-zero) -> lead NOT marked reaped_at, run records unclosed_leads and pauses.
  const f2 = await setupWorkflowProject(t, { tickets: { '01-closefail.md': goodTicket(1) } });
  const { flow: flow2 } = await f2.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f2.root });
  const [job2] = await f2.jobs(flow2, 1);
  await f2.settle(job2);
  await until(() => Boolean(f2.flow(flow2).review_job), 15_000);
  await f2.settleReview(f2.flow(flow2).review_job);
  await until(() => f2.flow(flow2).active_lead?.kind === 'accept', 15_000);
  const lead2 = f2.flow(flow2).active_lead.job;
  f2.overrideBin('hud-reap', '#!/usr/bin/env node\nconsole.error("herdr refused close"); process.exit(1);\n');
  await f2.settleLead(lead2, 'Decision: finish\nReason: Looks good.\n');
  const paused2 = await f2.end(flow2);
  assert.equal(paused2.state, 'paused', JSON.stringify(paused2));
  assert.equal(f2.job(lead2).reaped_at, undefined, 'lead must not be marked closed when herdr refused');
  assert.ok(paused2.unclosed_leads?.some(u => u.job === lead2), JSON.stringify(paused2));
  assert.match(paused2.reason, /close refused/);
});

test('ticket queue repair round adds a ticket and finishes cleanly on second verdict with exactly one end notice', { timeout: 45_000 }, async t => {
  const f = await setupWorkflowProject(t, { tickets: { '01-initial.md': goodTicket(1, { liveTry: 'Run synthetic smoke' }) } });
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root });
  const [first] = await f.jobs(flow, 1);
  await f.settle(first);

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

  const [, repairTicketJob] = await f.jobs(flow, 2);
  assert.equal(f.job(repairTicketJob).ticket, 'sample/02');
  assert.equal(f.flow(flow).repair_rounds, 1);
  assert.ok(f.job(lead1).reaped_at, 'round 1 lead closed before repair round');
  assert.equal((await f.call('hud_read', { job: flow })).changes, undefined);

  await f.settle(repairTicketJob);
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
  const f = await setupWorkflowProject(t, { tickets: { '01-item.md': goodTicket(1) } });
  const rule = 'Escalate only an item that would delete a user-visible feature or change the spec.';
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root, escalation_rule: rule });
  const [first] = await f.jobs(flow, 1);
  await f.settle(first);
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
  await f.settle(dJob);
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
  const f = await setupWorkflowProject(t, { tickets: { '01-first.md': goodTicket(1) } });
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root });
  let prevReview;
  let prevLead;
  for (let round = 0; round < 3; round++) {
    const ticketJobs = await f.jobs(flow, round + 1);
    await f.settle(ticketJobs[round]);
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
