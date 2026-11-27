import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { JOB_RETENTION_MS, pruneLandFlows } from '../../dist/runtime/work-retention.js';
import { answerTicketQueueHandback, cancelTicketQueueRun, startTicketQueue } from '../../dist/mcp/ticket-queue.js';
import { writeTicketQueue } from '../../dist/mcp/ticket-queue-state.js';
import { countProjectWaitingRuns, executionSnapshot } from '../../dist/collectors/execution.js';
import { stripAnsi } from '../../dist/render/colors.js';
import { executionRows } from '../../dist/render/execution-view.js';
import { buildAcceptPacket, extractReportNotes } from '../../dist/mcp/workflow-lead.js';
import { pinnedQueueJobs } from '../../dist/unattended/state.js';
import { stopChild } from '../helpers/process-cleanup.mjs';
import { resultValue, rpcClient, until } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { goodTicket, setupWorkflowProject } from '../helpers/workflow-ticket-project.mjs';

function promptNotices(f, flow) {
  return f.fakeLog()
    .filter(c => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'prompt' && c.args[2] === f.env.HERDR_PANE_ID)
    .map(c => c.args[3])
    .filter(line => typeof line === 'string' && line.includes(flow));
}

async function collectDeliveredNotices(f, flow, read, expected = 1, signal = 5_000) {
  const fromChanges = (read.changes ?? []).filter(line => line.includes(flow));
  await until(() => fromChanges.length + promptNotices(f, flow).length >= expected, signal);
  return [...fromChanges, ...promptNotices(f, flow)];
}

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

  // hud_tickets op: add supports optional approved_removals and live_try extraction into JSON.
  const added = await f.call('hud_tickets', {
    op: 'add', cwd: f.root, feature: 'added',
    tickets: [
      { title: 'With removals', blocked_by: [], what: 'Remove old panel.', acceptance: ['Removed'], live_try: 'none', approved_removals: 'old-panel' },
      { title: 'Live try in multiline what', blocked_by: [], what: 'Update greeting text.\n\n**Live try:** run ./greet', acceptance: ['Updated'] },
      { title: 'Live try inline in what', blocked_by: [], what: 'Update banner text. **Live try:** none', acceptance: ['Updated'] },
      { title: 'Explicit live_try keeps what', blocked_by: [], what: 'Keep prose.\n**Live try:** ignored', acceptance: ['Kept'], live_try: 'run explicit' },
      { title: 'Prose mentioning live try', blocked_by: [], what: 'Add a Live try: parser rule.', acceptance: ['Added'] },
    ],
  });
  assert.equal(added.ok, true);
  const { feature: addedDoc } = await f.call('hud_tickets', { op: 'get', cwd: f.root, feature: 'added' });
  assert.deepEqual(addedDoc.tickets[0].approved_removals, ['old-panel']);
  assert.equal(addedDoc.tickets[1].live_try, 'run ./greet');
  assert.equal(addedDoc.tickets[1].what, 'Update greeting text.');
  assert.equal(addedDoc.tickets[2].live_try, 'none');
  assert.equal(addedDoc.tickets[2].what, 'Update banner text.');
  assert.equal(addedDoc.tickets[3].live_try, 'run explicit');
  assert.equal(addedDoc.tickets[3].what, 'Keep prose.\n**Live try:** ignored');
  assert.equal(addedDoc.tickets[4].live_try, 'none');
  assert.equal(addedDoc.tickets[4].what, 'Add a Live try: parser rule.');
});

test('Assumed: lines move to run todo; four assumptions pause a main hand-back asking, wake main, and hud_respond resume lands the item', { timeout: 45_000 }, async t => {
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

  // 4 assumptions trigger the report gate -> paused with step asking and a main wake notice.
  await f.settle(second, {
    report: 'Synthetic done.\n\nAssumed: one\nAssumed: two\nAssumed: three\nAssumed: four\n',
  });
  const paused = await f.end(flow);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.steps.tickets.state, 'asking');
  assert.equal('no_wake' in paused, false);
  assert.equal('pause_notice' in paused, false);
  assert.equal(paused.handback.kind, 'assumption');
  assert.deepEqual(paused.handback.choices, ['resume', 'stop']);
  assert.match(paused.notices['pause-0'], /Assumed: lines/);
  assert.match(paused.notices['pause-0'], new RegExp(`hud_respond job=${flow} answer=<resume\\|stop>`));
  assert.equal(paused.todo.length, 6);
  const after = await f.call('hud_read', { job: flow });
  assert.equal(after.todo.length, 6);
  const wakeNotices = await collectDeliveredNotices(f, flow, after, 1);
  assert.equal(wakeNotices.length, 1);
  assert.match(wakeNotices[0], /Assumed: lines/);

  // Answering resume via hud_respond approves that report and lands sample/02 in the same run.
  const resumed = await f.call('hud_respond', { job: flow, answer: 'resume: Reviewed all four defaults.' });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.flow, flow);
  assert.equal(resumed.state, 'working');
  await until(() => Boolean(f.flow(flow).review_job), 15_000);
  const q = f.flow(flow);
  assert.deepEqual(q.tickets.filter(x => x.landed).map(x => x.ticket), ['sample/01', 'sample/02']);
  assert.ok(q.decisions.some(d => d.kind === 'assumption' && d.decision === 'resume' && d.ticket === 'sample/02' && d.worker_job === second));
  await f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root, cancel: true });
});

for (const { label, handback_to, report, expectedKind } of [
  { label: 'a scope assumption on default hand-back', report: 'Done.\nAssumed: [scope] kept the old command.\n', expectedKind: 'assumption' },
  { label: 'four assumptions on explicit lead hand-back', handback_to: 'lead', report: 'Done.\nAssumed: one\nAssumed: two\nAssumed: three\nAssumed: four\n', expectedKind: 'assumption' },
  { label: 'a Blockers line on explicit lead hand-back', handback_to: 'lead', report: 'Done.\nBlockers: needs an owner decision on keeping the legacy flag.\n', expectedKind: 'blocker' },
]) {
  test(`${label} goes to a temporary lead and lands on continue without waking main`, { timeout: 45_000 }, async t => {
    const f = await setupWorkflowProject(t, { count: 1 });
    const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root, handback_to });
    const [first] = await f.jobs(flow, 1);
    await f.settle(first, { report });
    await until(() => f.flow(flow).active_lead?.kind === expectedKind, 15_000);
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

test('a report blocker goes to the assumption lead even with final acceptance to main; continue records it as a todo and lands', { timeout: 45_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 1 });
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root, handback_to: 'main' });
  const [job] = await f.jobs(flow, 1);
  const mixed = 'live try remains; needs a decision on the output contract';
  await f.settle(job, { report: `Blockers: none\nBlockers: ${mixed}\nAssumed: scope stays as written\n` });
  await until(() => f.flow(flow).active_lead?.kind === 'blocker', 15_000);
  const lead = f.flow(flow).active_lead.job;
  const packet = fs.readFileSync(join(f.dir(lead), 'brief.md'), 'utf8');
  assert.ok(packet.includes(`Worker Blockers: lines:\n- ${mixed}`));
  assert.match(packet, /Worker Assumed: lines:\n- scope stays as written/);
  assert.deepEqual(f.flow(flow).notices, {});
  assert.equal(f.flow(flow).tickets[0].land, undefined);

  await f.settleLead(lead, 'Decision: continue\nReason: The ticket already decides the output contract.\n');
  await until(() => f.flow(flow).tickets[0].landed, 15_000);
  const q = f.flow(flow);
  assert.ok(f.job(lead).reaped_at);
  assert.deepEqual(q.decisions.map(d => [d.kind, d.decision]), [['blocker', 'continue']]);
  assert.ok(q.todo.some(item => item.kind === 'blocker' && item.text === mixed));
  assert.deepEqual(q.notices, {});
});

test('a blocker escalation holds just its ticket and dependent; an independent try-note ticket dispatches and lands before resume', { timeout: 60_000 }, async t => {
  const f = await setupWorkflowProject(t, { tickets: {
    '01-synthetic.md': goodTicket(1),
    '02-synthetic.md': goodTicket(2, { blocked: '01' }),
    '03-synthetic.md': goodTicket(3),
  } });
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root, max_parallel: 1 });
  const [heldJob] = await f.jobs(flow, 1);
  const rule = fs.readFileSync(join(f.dir(heldJob), 'brief.md'), 'utf8');
  assert.match(rule, /Blockers: none.*pending live try or owner try is never a blocker.*Try:/);
  await f.settle(heldJob, { report: 'Blockers: needs an owner decision on deleting X\nRemoves: none\n' });
  await until(() => f.flow(flow).active_lead?.kind === 'blocker', 15_000);
  const lead = f.flow(flow).active_lead.job;
  await f.settleLead(lead, 'Decision: escalate\nReason: Deleting X needs owner approval.\nOwner approval: feature-deletion\n');
  const [, independent] = await f.jobs(flow, 2);
  assert.equal(f.job(independent).ticket, 'sample/03');
  const read = await f.call('hud_read', { job: flow });
  assert.equal(read.state, 'working');
  assert.equal(read.handback.ticket, 'sample/01');
  assert.equal(read.held_items[0].owner_approval, 'feature-deletion');
  assert.equal(read.held_items[0].request_id, lead);
  const delivered = await collectDeliveredNotices(f, flow, read, 1);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /held sample\/01: Deleting X needs owner approval/);
  assert.equal((await f.call('hud_read', { job: flow })).changes, undefined);

  await f.settle(independent, { report: 'Blockers: owner live try remains\n- **Blockers:** pending owner try\nBlockers: acceptance try is still pending\nTry: Reopen the synthetic panel.\nRemoves: none\n' });
  await until(() => f.flow(flow).tickets[1].landed, 15_000);
  const working = await f.call('hud_read', { job: flow });
  assert.equal(working.state, 'working');
  assert.deepEqual(working.landed, ['sample/03']);
  assert.deepEqual(working.blocked, [{ ticket: 'sample/02', blockers: ['sample/01'] }]);
  assert.deepEqual(working.todo.map(item => item.text), [
    'owner live try remains', 'pending owner try', 'acceptance try is still pending', 'Reopen the synthetic panel.',
  ]);
  assert.deepEqual(working.decisions.map(d => [d.kind, d.decision]), [['blocker', 'escalate']]);
  assert.equal(working.changes, undefined);

  const resumed = await f.call('hud_respond', { job: flow, request_id: read.handback.request_id, answer: 'resume: Owner approved X.' });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.flow, flow);
  assert.equal(resumed.state, 'working');
  assert.equal(resumed.handback, undefined);
  const [, , dependent] = await f.jobs(flow, 3);
  assert.equal(f.job(dependent).ticket, 'sample/02');
  assert.deepEqual(f.flow(flow).tickets.filter(x => x.landed).map(x => x.ticket), ['sample/01', 'sample/03']);
  assert.deepEqual(f.flow(flow).decisions.map(d => [d.kind, d.decision, d.worker_job]), [
    ['blocker', 'escalate', heldJob],
    ['blocker', 'resume', heldJob],
  ]);
});

test('extractReportNotes parses heading/empty Blockers, qualified none, try notes with detail, and mixed blockers', () => {
  // Heading-plus-bullet and empty declarations never clear silently.
  assert.deepEqual(
    extractReportNotes('## Blockers:\n- Owner must decide on deleting X\n\nRemoves: none\n'),
    { blockers: ['Owner must decide on deleting X'], tries: [] },
  );
  assert.deepEqual(
    extractReportNotes('## Blockers\n\n- Owner must decide on deleting X\n- owner live try remains: reopen the panel\n\n## Checks\n- passed\n'),
    { blockers: ['Owner must decide on deleting X'], tries: ['owner live try remains: reopen the panel'] },
  );
  assert.equal(extractReportNotes('Blockers:\nRemoves: none\n').blockers.length, 1);
  assert.equal(extractReportNotes('## Blockers\n\nRemoves: none\n').blockers.length, 1);
  assert.deepEqual(extractReportNotes('## Blockers\n- none\n'), { blockers: [], tries: [] });

  // Qualified none clears and preserves any try note.
  assert.deepEqual(extractReportNotes('Blockers: none requiring an owner decision.\n'), { blockers: [], tries: [] });
  assert.deepEqual(
    extractReportNotes('Blockers: none (owner live try remains)\n'),
    { blockers: [], tries: ['owner live try remains'] },
  );
  assert.deepEqual(
    extractReportNotes('Blockers: none - only the live try\n'),
    { blockers: [], tries: ['only the live try'] },
  );
  assert.deepEqual(
    extractReportNotes('Blockers: none (owner live try remains: reopen the panel)\n'),
    { blockers: [], tries: ['owner live try remains: reopen the panel'] },
  );
  // Caveated none naming an owner decision still blocks.
  assert.deepEqual(
    extractReportNotes('Blockers: none - owner must decide on deleting X\n'),
    { blockers: ['none - owner must decide on deleting X'], tries: [] },
  );

  // Pending-try phrase with detail is a try note; mixed decision text still blocks.
  assert.deepEqual(
    extractReportNotes('Blockers: owner live try remains: reopen the panel\n'),
    { blockers: [], tries: ['owner live try remains: reopen the panel'] },
  );
  assert.deepEqual(
    extractReportNotes('Blockers: live try remains and the owner must decide on deleting X\n'),
    { blockers: ['live try remains and the owner must decide on deleting X'], tries: [] },
  );
  assert.deepEqual(
    extractReportNotes('Blockers: owner live try remains: owner must decide on deleting X\n'),
    { blockers: ['owner live try remains: owner must decide on deleting X'], tries: [] },
  );
});

test('qualified none and try-with-detail Blockers land without a lead while recording try notes in run todo', { timeout: 60_000 }, async t => {
  const f = await setupWorkflowProject(t, { tickets: {
    '01-qualified-none.md': goodTicket(1),
    '02-try-detail.md': goodTicket(2, { blocked: 'none' }),
  } });
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root, max_parallel: 2, handback_to: 'main' });
  const [job1, job2] = await f.jobs(flow, 2);
  await f.settle(job1, { report: 'Done.\nBlockers: none requiring an owner decision.\nRemoves: none\n' });
  await f.settle(job2, {
    report: 'Done.\nBlockers: none (owner live try remains)\nBlockers: owner live try remains: reopen the synthetic panel\nRemoves: none\n',
  });
  await until(() => f.flow(flow).tickets.filter(x => x.landed).length === 2, t.signal);
  const q = f.flow(flow);
  const leads = fs.readdirSync(join(f.home, 'jobs')).filter(id => /^j[a-f0-9]{16}$/.test(id)).map(f.job).filter(j => j.role === 'lead');
  assert.equal(leads.length, 0, 'qualified none and try-with-detail must land without launching a lead');
  assert.deepEqual(
    q.todo.filter(item => item.kind === 'try').map(item => item.text),
    ['owner live try remains', 'owner live try remains: reopen the synthetic panel'],
  );
  await f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root, cancel: true });
});

test('heading-plus-bullet and mixed-try Blockers reach the lead; item-hold resume requires request_id and targets only that hold', { timeout: 60_000 }, async t => {
  const f = await setupWorkflowProject(t, { tickets: {
    '01-heading-blocker.md': goodTicket(1),
    '02-mixed-try-blocker.md': goodTicket(2, { blocked: 'none' }),
  } });
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root, max_parallel: 2 });
  const [job1, job2] = await f.jobs(flow, 2);

  await f.settle(job1, { report: '## Blockers:\n- Owner must decide on deleting legacy flag X\n\nRemoves: none\n' });
  await until(() => f.flow(flow).active_lead?.kind === 'blocker' && f.flow(flow).active_lead.ticket === 'sample/01', 15_000);
  const lead1 = f.flow(flow).active_lead.job;
  assert.match(fs.readFileSync(join(f.dir(lead1), 'brief.md'), 'utf8'), /Worker Blockers: lines:\n- Owner must decide on deleting legacy flag X/);
  await f.settleLead(lead1, 'Decision: escalate\nReason: Deleting X needs owner decision.\nOwner approval: feature-deletion\n');
  await until(() => f.flow(flow).tickets.find(x => x.ticket === 'sample/01')?.held?.request_id === lead1, 15_000);

  await f.settle(job2, { report: 'Blockers: live try remains and the owner must decide on deleting Y\nRemoves: none\n' });
  await until(() => f.flow(flow).active_lead?.kind === 'blocker' && f.flow(flow).active_lead.ticket === 'sample/02', 15_000);
  const lead2 = f.flow(flow).active_lead.job;
  assert.match(fs.readFileSync(join(f.dir(lead2), 'brief.md'), 'utf8'), /Worker Blockers: lines:\n- live try remains and the owner must decide on deleting Y/);
  await f.settleLead(lead2, 'Decision: escalate\nReason: Deleting Y needs owner decision.\nOwner approval: feature-deletion\n');
  await until(() => f.flow(flow).tickets.find(x => x.ticket === 'sample/02')?.held?.request_id === lead2, 15_000);

  // Two holds are open: ID-less resume must be refused and leave both holds untouched.
  const noIdTwo = await f.call('hud_respond', { job: flow, answer: 'resume: Approved.' });
  assert.equal(noIdTwo.ok, false);
  assert.equal(noIdTwo.code, 'invalid_arguments');
  assert.deepEqual(
    f.flow(flow).tickets.filter(x => x.held).map(x => [x.ticket, x.held.request_id]),
    [['sample/01', lead1], ['sample/02', lead2]],
  );

  // Explicit request_id resumes only the second hold and leaves the first held.
  const resumedSecond = await f.call('hud_respond', { job: flow, request_id: lead2, answer: 'resume: Owner approved Y.' });
  assert.equal(resumedSecond.ok, true);
  assert.equal(resumedSecond.handback.request_id, lead1);
  await until(() => f.flow(flow).tickets.find(x => x.ticket === 'sample/02')?.landed === true, 15_000);
  assert.equal(f.flow(flow).tickets.find(x => x.ticket === 'sample/01')?.held?.request_id, lead1);
  assert.equal(f.flow(flow).tickets.find(x => x.ticket === 'sample/01')?.landed, undefined);

  // Even with one hold left, ID-less resume is still refused.
  const noIdOne = await f.call('hud_respond', { job: flow, answer: 'resume' });
  assert.equal(noIdOne.ok, false);
  assert.equal(noIdOne.code, 'invalid_arguments');
  assert.equal(f.flow(flow).tickets.find(x => x.ticket === 'sample/01')?.held?.request_id, lead1);

  // Resuming with lead1 clears the remaining hold and lands ticket 01.
  const resumedFirst = await f.call('hud_respond', { job: flow, request_id: lead1, answer: 'resume: Owner approved X.' });
  assert.equal(resumedFirst.ok, true);
  assert.equal(resumedFirst.handback, undefined);
  await until(() => f.flow(flow).tickets.find(x => x.ticket === 'sample/01')?.landed === true, 15_000);
  await f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root, cancel: true });
});

test('an assumption lead hold records head/sig; same-report resume stays paused with resolution notice; corrected turn re-judges and lands', { timeout: 60_000 }, async t => {
  const f = await setupWorkflowProject(t, { tickets: { '01-scope.md': goodTicket(1) } });
  const runArgs = { op: 'run', feature: 'sample', cwd: f.root };
  const { flow } = await f.call('hud_tickets', runArgs);
  const [first] = await f.jobs(flow, 1);
  await f.settle(first, { report: 'Done.\nAssumed: [scope] removed the old command.\n' });
  const initialHead = f.git(f.job(first).worktree.root, 'rev-parse', 'HEAD');
  await until(() => f.flow(flow).active_lead?.kind === 'assumption', 15_000);
  const lead1 = f.flow(flow).active_lead.job;
  await f.settleLead(lead1, 'Decision: hold\nReason: Deletes a user-visible command.\nOwner approval: feature-deletion\n');
  const paused = await f.end(flow);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.handback.kind, 'escalate');
  assert.equal(paused.handback.owner_approval, 'feature-deletion');
  assert.equal(paused.tickets[0].land, undefined);
  assert.equal(paused.tickets[0].held.owner_approval, 'feature-deletion');
  assert.equal(paused.tickets[0].held.head, initialHead);
  assert.ok(paused.tickets[0].held.report_sig, 'hold records report signature');
  assert.equal(paused.review_job, undefined);
  assert.equal(paused.verdict, undefined);
  assert.equal(Object.keys(paused.notices).length, 1);
  const initialSig = paused.tickets[0].held.report_sig;

  // Resuming with the same report keeps the item held and pauses with the manual-resolution notice; no review/accept/finish.
  const sameResume = await f.call('hud_tickets', runArgs);
  assert.notEqual(sameResume.flow, flow);
  const stillPaused = await f.end(sameResume.flow);
  assert.equal(stillPaused.state, 'paused', JSON.stringify(stillPaused));
  assert.equal(stillPaused.handback.kind, 'escalate');
  assert.equal(stillPaused.handback.owner_approval, 'feature-deletion');
  assert.equal(stillPaused.tickets[0].land, undefined);
  assert.equal(stillPaused.tickets[0].landed, undefined);
  assert.equal(stillPaused.tickets[0].held.owner_approval, 'feature-deletion');
  assert.equal(stillPaused.tickets[0].held.head, initialHead);
  assert.equal(stillPaused.tickets[0].held.report_sig, initialSig);
  assert.equal(stillPaused.review_job, undefined);
  assert.equal(stillPaused.verdict, undefined);
  assert.equal(stillPaused.steps.review.state, 'waiting');
  assert.equal(stillPaused.steps.accept.state, 'waiting');
  const leadsAfterSame = fs.readdirSync(join(f.home, 'jobs')).filter(id => /^j[a-f0-9]{16}$/.test(id)).map(f.job).filter(j => j.role === 'lead');
  assert.equal(leadsAfterSame.length, 1, 'same-report resume must not launch review/accept or duplicate leads');
  const readSame = await f.call('hud_read', { job: sameResume.flow });
  const sameNotices = await collectDeliveredNotices(f, sameResume.flow, readSame, 1);
  assert.equal(sameNotices.length, 1);
  assert.match(sameNotices[0], /worker correction.*hud_land.*stop/i);
  assert.deepEqual(readSame.landed, []);

  // A new worker turn that still triggers an assumption is re-judged (never blanket-approved) and can hold again.
  const sentAt2 = new Date().toISOString();
  writeFixtureFile(join(f.dir(first), 'job.json'), JSON.stringify({ ...f.job(first), pi_sent_at: sentAt2 }));
  await f.settle(first, { body: 'Updated synthetic implementation.\n', report: 'Updated.\nAssumed: [scope] altered output contract.\n' });
  const head2 = f.git(f.job(first).worktree.root, 'rev-parse', 'HEAD');
  assert.notEqual(head2, initialHead);
  const rejudgeResume = await f.call('hud_tickets', runArgs);
  await until(() => f.flow(rejudgeResume.flow).active_lead?.kind === 'assumption', 15_000);
  const lead2 = f.flow(rejudgeResume.flow).active_lead.job;
  assert.notEqual(lead2, lead1);
  await f.settleLead(lead2, 'Decision: hold\nReason: Still requires a docs/spec.md change.\nOwner approval: spec-change\n');
  const heldAgain = await f.end(rejudgeResume.flow);
  assert.equal(heldAgain.state, 'paused', JSON.stringify(heldAgain));
  assert.equal(heldAgain.tickets[0].held.owner_approval, 'spec-change');
  assert.equal(heldAgain.tickets[0].held.head, head2);
  assert.notEqual(heldAgain.tickets[0].held.report_sig, initialSig);
  assert.equal(heldAgain.verdict, undefined);

  // Worker publishes a clean corrected report -> resume un-holds, re-judges, lands, reviews and accepts cleanly.
  const sentAt3 = new Date().toISOString();
  writeFixtureFile(join(f.dir(first), 'job.json'), JSON.stringify({ ...f.job(first), pi_sent_at: sentAt3 }));
  await f.settle(first, { body: 'Restored synthetic command.\n', report: 'Restored the old command cleanly.\nRemoves: none\n' });
  const cleanResume = await f.call('hud_tickets', runArgs);
  await until(() => f.flow(cleanResume.flow).tickets[0]?.landed === true, 15_000);
  assert.equal(f.flow(cleanResume.flow).tickets[0].held, undefined);
  await until(() => Boolean(f.flow(cleanResume.flow).review_job), 15_000);
  await f.settleReview(f.flow(cleanResume.flow).review_job);
  await until(() => f.flow(cleanResume.flow).active_lead?.kind === 'accept', 15_000);
  await f.settleLead(f.flow(cleanResume.flow).active_lead.job, 'Decision: finish\nReason: Verified corrected turn.\n');
  const done = await f.end(cleanResume.flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(done.tickets[0].landed, true);
  assert.equal(done.tickets[0].held, undefined);
  assert.equal(done.verdict, 'finish: Verified corrected turn.');
});

test('a single held ticket manually landed before resume survives retention past JOB_RETENTION_MS and is reviewed and accepted by the successor', { timeout: 60_000 }, async t => {
  const f = await setupWorkflowProject(t, { tickets: { '01-synthetic.md': goodTicket(1, { ownerTry: 'yes' }) } });
  const runArgs = { op: 'run', feature: 'sample', cwd: f.root };
  const { flow } = await f.call('hud_tickets', runArgs);
  const [job] = await f.jobs(flow, 1);
  await f.settle(job, { report: 'Done.\nAssumed: [scope] removed the old command.\n' });
  await until(() => f.flow(flow).active_lead?.kind === 'assumption', 15_000);
  await f.settleLead(f.flow(flow).active_lead.job, 'Decision: hold\nReason: Deletes a user-visible command.\nOwner approval: feature-deletion\n');
  const paused = await f.end(flow);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.tickets[0].held.owner_approval, 'feature-deletion');

  const manual = await f.call('hud_land', { job });
  await until(() => f.flow(manual.flow).state === 'completed', 20_000);
  assert.equal(f.ticketRecord(1, 'sample', 'base')?.status, 'ready-for-human');
  assert.equal(f.flow(flow).tickets[0].landed, undefined, 'the paused run has not observed the land');

  // Seed an unrelated completed job so the shifted retention pass proves ordinary retention ran.
  const expiredJob = 'j00000000000000e1', expiredDir = f.dir(expiredJob), nowIso = new Date().toISOString();
  fs.mkdirSync(expiredDir, { recursive: true });
  writeFixtureFile(join(expiredDir, 'job.json'), JSON.stringify({ job: expiredJob, role: 'imp', cwd: f.root, created_at: nowIso, reaped_at: nowIso }));
  writeFixtureFile(join(expiredDir, 'STATUS.json'), JSON.stringify({ state: 'closed', output_written: true, ended_at: nowIso, settled_at: nowIso }));
  writeFixtureFile(join(expiredDir, 'report.md'), 'Expired report.\n');

  const shiftImport = `data:text/javascript,${encodeURIComponent(`const realNow = Date.now; Date.now = () => realNow() + ${2 * JOB_RETENTION_MS};`)}`;
  const runFutureRetention = async () => {
    await until(() => Boolean(f.job(job).reaped_at) && !fs.existsSync(join(f.home, 'watch.pid')), 15_000);
    const watcher = spawnSync(process.execPath, ['--import', shiftImport, resolve('packages/hud-mcp/bin/hud-watch.mjs')], {
      env: f.env, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(watcher.status, 0, watcher.stderr || String(watcher.error));
  };

  // Retention pass past JOB_RETENTION_MS must prune ordinary expired jobs while keeping the manual land receipt and source report.
  const reportPath = join(f.dir(job), 'report.md');
  const landPath = join(f.home, 'flows', `${manual.flow}.json`);
  await runFutureRetention();
  assert.equal(fs.existsSync(expiredDir), false, 'ordinary completed job without a hold ages out');
  assert.ok(fs.existsSync(reportPath), 'source job report survives retention until successor consumes it');
  assert.ok(fs.existsSync(landPath), 'manual land receipt survives retention until successor consumes it');

  const resumed = await f.call('hud_tickets', runArgs);
  assert.notEqual(resumed.flow, flow);
  await until(() => Boolean(f.flow(resumed.flow).review_job), 15_000);
  const q = f.flow(resumed.flow);
  assert.deepEqual(q.tickets.map(x => [x.ticket, x.job, x.land, x.landed, x.held]), [['sample/01', job, manual.flow, true, undefined]]);
  assert.equal(f.flow(flow).superseded_by, resumed.flow);
  const pins = pinnedQueueJobs(f.home);
  assert.equal(pins.held.has(job), false, 'the resolved hold no longer pins the worktree or logs');
  assert.ok(pins.evidence.has(job), 'the successor keeps the adopted report and receipt through review and acceptance');
  const reviewBrief = fs.readFileSync(join(f.dir(q.review_job), 'brief.md'), 'utf8');
  assert.match(reviewBrief, /Landed tickets and design intent:\s+- sample\/01:/);
  assert.ok(reviewBrief.includes(reportPath), 'review brief cites the retained worker report');
  assert.ok(fs.existsSync(reportPath), 'report cited by review still exists');
  await f.settleReview(q.review_job);
  await until(() => f.flow(resumed.flow).active_lead?.kind === 'accept', 15_000);
  const lead = f.flow(resumed.flow).active_lead.job;
  const acceptBrief = fs.readFileSync(join(f.dir(lead), 'brief.md'), 'utf8');
  assert.match(acceptBrief, /Tickets, Live Try & Reports\s+- sample\/01:/);
  assert.ok(acceptBrief.includes(reportPath), 'accept brief cites the retained worker report');
  assert.ok(fs.existsSync(reportPath), 'report cited by accept still exists');
  await f.settleLead(lead, 'Decision: finish\nReason: Verified manual land.\n');
  const done = await f.end(resumed.flow);
  assert.equal(done.state, 'completed');
  assert.equal(done.verdict, 'finish: Verified manual land.');
  assert.match(done.notices['end-0'], /Landed: sample\/01\./);

  // Once the successor completes, normal retention releases both the retained report and land receipt.
  await runFutureRetention();
  assert.equal(fs.existsSync(f.dir(job)), false, 'source job directory is released after successor completes');
  assert.equal(fs.existsSync(landPath), false, 'manual land receipt is released after successor completes');
});

test('a temporarily missing ticket file keeps an ordinary hold pinned across retention and resume', { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { tickets: { '01-synthetic.md': goodTicket(1) } });
  const flow = 'q0000000000000002', job = 'j0000000000000002';
  const flows = join(f.home, 'flows'), oldAt = new Date(Date.now() - 48 * 3600_000).toISOString();
  const ticketFile = join(f.root, f.ticketPath(1));
  fs.mkdirSync(flows, { recursive: true });
  fs.mkdirSync(f.dir(job), { recursive: true });
  writeFixtureFile(join(f.dir(job), 'job.json'), JSON.stringify({
    job, role: 'imp', cwd: f.root, ticket: 'sample/01', ticket_queue: flow, created_at: oldAt, reaped_at: oldAt,
  }));
  writeFixtureFile(join(f.dir(job), 'STATUS.json'), JSON.stringify({ state: 'closed', output_written: true, ended_at: oldAt, settled_at: oldAt }));
  writeFixtureFile(join(f.dir(job), 'report.md'), 'Held report.\n');
  writeFixtureFile(join(flows, `${flow}.json`), JSON.stringify({
    flow, root: f.root, pane: f.env.HERDR_PANE_ID, feature: 'sample', task: false, max_parallel: 1,
    state: 'paused', created_at: oldAt, updated_at: oldAt,
    tickets: [{
      ticket: 'sample/01', path: ticketFile, role: 'imp', job,
      held: { reason: 'Owner approval', at: oldAt, owner_approval: 'feature-deletion' },
    }],
  }));

  // Simulate a branch switch hiding the ticket file during a retention pass.
  fs.unlinkSync(ticketFile);
  assert.ok(pinnedQueueJobs(f.home).held.has(job), 'retention treats a missing ticket file as not closed');
  const watcher = spawnSync(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], {
    env: f.env, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(watcher.status, 0, watcher.stderr || String(watcher.error));
  assert.ok(fs.existsSync(join(f.dir(job), 'report.md')), 'held job survives retention while ticket file is missing');

  // Resume agrees the item is not closed: it carries the held item forward and pauses awaiting resolution.
  const resumed = await f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root });
  const pausedAgain = await f.end(resumed.flow);
  assert.equal(pausedAgain.state, 'paused');
  assert.equal(pausedAgain.tickets.length, 1);
  assert.equal(pausedAgain.tickets[0].job, job);
  assert.ok(pausedAgain.tickets[0].held);
  assert.match(pausedAgain.reason, /stays held.*hud_land/);
});

test('resume does not treat closed held tickets as landed without a completed receipt for their own job', { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { tickets: {
    '01-synthetic.md': goodTicket(1, { status: 'done' }),
    '02-synthetic.md': goodTicket(2, { status: 'ready-for-human' }),
    '03-synthetic.md': goodTicket(3, { status: 'done' }),
  } });
  const flow = 'q0000000000000001', flows = join(f.home, 'flows'), at = new Date().toISOString();
  fs.mkdirSync(flows, { recursive: true });
  const tickets = [1, 2, 3].map(n => ({
    ticket: `sample/0${n}`, path: join(f.root, f.ticketPath(n)), role: 'imp',
    job: `j000000000000000${n}`, held: { reason: 'Owner approval', at, owner_approval: 'feature-deletion' },
  }));
  writeFixtureFile(join(flows, `${flow}.json`), JSON.stringify({
    flow, root: f.root, pane: f.env.HERDR_PANE_ID, feature: 'sample', task: false, max_parallel: 1,
    state: 'paused', created_at: at, updated_at: at, tickets,
  }));
  // No receipt for 01; 02's land failed; the completed receipt in 03's family belongs to another job.
  for (const [n, job, state] of [[2, tickets[1].job, 'failed'], [3, 'j0000000000000009', 'completed']]) {
    const land = `f000000000000000${n}`;
    writeFixtureFile(join(flows, `${land}.json`), JSON.stringify({ flow: land, job, state, step: 'done' }));
  }
  const resumed = await f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root });
  const done = await f.end(resumed.flow);
  assert.equal(done.state, 'completed');
  assert.deepEqual(done.tickets, []);
  assert.equal(done.review_job, undefined);
  assert.equal(done.verdict, undefined);
});

test('an ordinary run with a landed ticket and a held item never reaches review or finish; head-only change re-judges on resume', { timeout: 60_000 }, async t => {
  const f = await setupWorkflowProject(t, {
    tickets: {
      '01-clean.md': goodTicket(1),
      '02-held.md': goodTicket(2, { blocked: 'none' }),
    },
  });
  const runArgs = { op: 'run', feature: 'sample', max_parallel: 2, cwd: f.root };
  const { flow } = await f.call('hud_tickets', runArgs);
  const [first, second] = await f.jobs(flow, 2);
  await f.settle(first);
  await until(() => f.flow(flow).tickets.find(x => x.ticket === 'sample/01')?.landed === true, t.signal);
  await f.settle(second, { report: 'Done.\nAssumed: [scope] removed legacy flag.\n' });
  await until(() => f.flow(flow).active_lead?.kind === 'assumption', t.signal);
  const lead1 = f.flow(flow).active_lead.job;
  await f.settleLead(lead1, 'Decision: hold\nReason: Deletes a user-visible flag.\nOwner approval: feature-deletion\n');
  const paused = await f.end(flow);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.tickets.find(x => x.ticket === 'sample/01').landed, true);
  assert.equal(paused.tickets.find(x => x.ticket === 'sample/02').held.owner_approval, 'feature-deletion');
  assert.equal(paused.review_job, undefined);
  assert.equal(paused.verdict, undefined);

  // Resuming with sample/02 unchanged must stay paused and never advance to review/accept/finish despite sample/01 landing.
  const sameResume = await f.call('hud_tickets', runArgs);
  const stillPaused = await f.end(sameResume.flow);
  assert.equal(stillPaused.state, 'paused', JSON.stringify(stillPaused));
  assert.equal(stillPaused.tickets.find(x => x.ticket === 'sample/01').landed, true);
  assert.equal(stillPaused.tickets.find(x => x.ticket === 'sample/02').held.owner_approval, 'feature-deletion');
  assert.equal(stillPaused.review_job, undefined);
  assert.equal(stillPaused.verdict, undefined);
  const readSame = await f.call('hud_read', { job: sameResume.flow });
  const sameNotices = await collectDeliveredNotices(f, sameResume.flow, readSame, 1, t.signal);
  assert.equal(sameNotices.length, 1);
  assert.match(sameNotices[0], /worker correction.*hud_land.*stop/i);

  // Moving only the worker worktree HEAD (same report) un-holds and re-judges via a new assumption lead.
  const wt2 = f.job(second).worktree.root;
  fs.writeFileSync(join(wt2, 'sample-02.txt'), 'Restored legacy flag.\n');
  f.git(wt2, 'add', 'sample-02.txt');
  f.git(wt2, 'commit', '-qm', 'Restore legacy flag');
  const headResume = await f.call('hud_tickets', runArgs);
  await until(() => f.flow(headResume.flow).active_lead?.kind === 'assumption', t.signal);
  const lead2 = f.flow(headResume.flow).active_lead.job;
  assert.notEqual(lead2, lead1);
  await f.settleLead(lead2, 'Decision: continue\nReason: Legacy flag restored in new commit.\n');
  await until(() => f.flow(headResume.flow).tickets.find(x => x.ticket === 'sample/02')?.landed === true, t.signal);
  await until(() => Boolean(f.flow(headResume.flow).review_job), t.signal);
  await f.settleReview(f.flow(headResume.flow).review_job);
  await until(() => f.flow(headResume.flow).active_lead?.kind === 'accept', t.signal);
  await f.settleLead(f.flow(headResume.flow).active_lead.job, 'Decision: finish\nReason: Both tickets landed cleanly.\n');
  const done = await f.end(headResume.flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.deepEqual(done.tickets.filter(x => x.landed).map(x => x.ticket).sort(), ['sample/01', 'sample/02']);
});

test('a scope assumption on main hand-back pauses asking and wakes main; hud_respond resume lands it and stop cancels cleanly', { timeout: 60_000 }, async t => {
  const f = await setupWorkflowProject(t, { tickets: { '01-scope.md': goodTicket(1) } });
  const args = { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root, handback_to: 'main' };
  const { flow } = await f.call('hud_tickets', args);
  const [first] = await f.jobs(flow, 1);
  const assumed = '[scope] added a new public command';
  await f.settle(first, { report: `Done.\n\nAssumed: ${assumed}\n` });
  const paused = await f.end(flow);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.steps.tickets.state, 'asking');
  assert.equal('no_wake' in paused, false);
  assert.equal(paused.handback.kind, 'assumption');
  assert.deepEqual(paused.handback.choices, ['resume', 'stop']);
  assert.match(paused.reason, /scope assumption/);
  assert.match(paused.notices['pause-0'], /scope assumption/);
  assert.match(paused.notices['pause-0'], new RegExp(`hud_respond job=${flow} answer=<resume\\|stop>`));
  const readPaused = await f.call('hud_read', { job: flow });
  const delivered = await collectDeliveredNotices(f, flow, readPaused, 1);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /scope assumption/);
  const leads = fs.readdirSync(join(f.home, 'jobs')).filter(id => /^j[a-f0-9]{16}$/.test(id)).map(f.job).filter(j => j.role === 'lead');
  assert.equal(leads.length, 0, 'main-handback runs keep the breaker with zero leads');

  // hud_respond resume approves the exact report/commit and continues to land in the same run.
  const resumed = await f.call('hud_respond', { job: flow, answer: 'resume' });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.flow, flow);
  assert.equal(resumed.state, 'working');
  await until(() => {
    const q = f.flow(flow);
    assert.equal(q.state, 'working', JSON.stringify(q));
    return Boolean(q.review_job);
  }, 15_000);
  const landed = await f.call('hud_read', { job: flow });
  assert.deepEqual(landed.landed, ['sample/01']);
  assert.equal(landed.jobs[0].job, first);
  assert.deepEqual(landed.todo, [{ source: `sample/01 (${first})`, kind: 'assumed', text: assumed }]);
  await f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root, cancel: true });

  // hud_respond stop cancels a report-gate pause cleanly.
  f.writeJsonTicket(1, {}, 'stopgate');
  f.git(f.root, 'add', '.hud/tickets/stopgate.json');
  f.git(f.root, 'commit', '-qm', 'stopgate feature');
  const { flow: stopFlow } = await f.call('hud_tickets', { op: 'run', feature: 'stopgate', max_parallel: 1, cwd: f.root, handback_to: 'main' });
  const [stopJob] = await f.jobs(stopFlow, 1);
  await f.settle(stopJob, { report: 'Done.\nAssumed: [scope] changed public flag.\n' });
  const pausedStop = await f.end(stopFlow);
  assert.equal(pausedStop.state, 'paused');
  assert.equal(pausedStop.steps.tickets.state, 'asking');
  const stopped = await f.call('hud_respond', { job: stopFlow, answer: 'stop: Owner rejected scope change.' });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.state, 'cancelled');
  assert.match(stopped.reason, /stopped: Owner rejected scope change\./);
  assert.equal(f.flow(stopFlow).steps.tickets.state, 'cancelled');
});

test('a Blockers-line report-gate pause on main hand-back (without lead) leaves tickets asking, wakes main, and hud_respond resume lands it', { timeout: 45_000 }, async t => {
  const f = await setupWorkflowProject(t, { tickets: { '01-blocker.md': goodTicket(1) } });
  const projectJson = join(f.root, '.hud', 'project.json');
  const baseConfig = JSON.parse(fs.readFileSync(projectJson, 'utf8'));
  writeFixtureFile(projectJson, JSON.stringify({ ...baseConfig, roles: ['imp', 'reviewer'] }));

  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root, handback_to: 'main' });
  const [first] = await f.jobs(flow, 1);
  const blockerText = 'needs an owner decision on removing legacy output';
  await f.settle(first, { report: `Done.\nBlockers: ${blockerText}\nRemoves: none\n` });

  const paused = await f.end(flow);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.steps.tickets.state, 'asking');
  assert.equal(paused.handback.kind, 'blocker');
  assert.deepEqual(paused.handback.choices, ['resume', 'stop']);
  assert.match(paused.notices['pause-0'], /Blockers:/);
  assert.match(paused.notices['pause-0'], new RegExp(`hud_respond job=${flow} answer=<resume\\|stop>`));
  const readPaused = await f.call('hud_read', { job: flow });
  const delivered = await collectDeliveredNotices(f, flow, readPaused, 1);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /Blockers:/);
  const leads = fs.readdirSync(join(f.home, 'jobs')).filter(id => /^j[a-f0-9]{16}$/.test(id)).map(f.job).filter(j => j.role === 'lead');
  assert.equal(leads.length, 0);

  const resumed = await f.call('hud_respond', { job: flow, answer: 'resume: Approved legacy output removal.' });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.flow, flow);
  assert.equal(resumed.state, 'working');
  await until(() => Boolean(f.flow(flow).review_job), 15_000);
  const q = f.flow(flow);
  assert.deepEqual(q.tickets.filter(x => x.landed).map(x => x.ticket), ['sample/01']);
  assert.ok(q.todo.some(item => item.kind === 'blocker' && item.text === blockerText));
  assert.ok(q.decisions.some(d => d.kind === 'blocker' && d.decision === 'resume' && d.ticket === 'sample/01'));
  await f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root, cancel: true });
});

test('hud_tickets run superseding a paused run keeps an in-flight land and adopts a land that completed while paused', { timeout: 60_000 }, async t => {
  const f = await setupWorkflowProject(t, {
    tickets: {
      '01-inflight.md': goodTicket(1),
      '02-gate.md': goodTicket(2, { blocked: 'none' }),
    },
  });
  const gateStarted = join(f.home, 'gate-started');
  const gateRelease = join(f.home, 'gate-release');
  t.after(() => { try { fs.writeFileSync(gateRelease, '1'); } catch {} });
  const projectJson = join(f.root, '.hud', 'project.json');
  const baseConfig = JSON.parse(fs.readFileSync(projectJson, 'utf8'));
  const waitScript = `const fs=require('fs');if(!fs.existsSync(${JSON.stringify(gateStarted)})){fs.writeFileSync(${JSON.stringify(gateStarted)},'1');while(!fs.existsSync(${JSON.stringify(gateRelease)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);}`;
  writeFixtureFile(projectJson, JSON.stringify({
    ...baseConfig,
    land: { ...baseConfig.land, gate: [`${JSON.stringify(process.execPath)} -e ${JSON.stringify(waitScript)}`] },
  }));

  const runArgs = { op: 'run', feature: 'sample', max_parallel: 2, cwd: f.root, handback_to: 'main' };
  const { flow } = await f.call('hud_tickets', runArgs);
  const [job1, job2] = await f.jobs(flow, 2);

  // Start ticket 01 landing and hold its gate open so the land is genuinely in flight.
  await f.settle(job1);
  await until(() => fs.existsSync(gateStarted) && Boolean(f.flow(flow).tickets.find(x => x.ticket === 'sample/01')?.land), 15_000);
  const inFlightLand = f.flow(flow).tickets.find(x => x.ticket === 'sample/01').land;

  // Ticket 02 pauses the run on a report gate while ticket 01's land is still in flight.
  await f.settle(job2, { report: 'Done.\nAssumed: one\nAssumed: two\nAssumed: three\nAssumed: four\n' });
  const paused = await f.end(flow);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.steps.tickets.state, 'asking');
  assert.equal(f.flow(inFlightLand).state, 'running');

  // Supersede the paused run while ticket 01's land is still in flight: new run's jobs keep it.
  const superseded = await f.call('hud_tickets', runArgs);
  assert.notEqual(superseded.flow, flow);
  assert.equal(f.flow(flow).superseded_by, superseded.flow);
  assert.deepEqual(
    superseded.jobs.map(j => [j.ticket, j.job, j.land]),
    [['sample/01', job1, inFlightLand], ['sample/02', job2, undefined]],
  );

  // Release the gate: both ticket 01 (carried in-flight land) and ticket 02 finish landing and reach review.
  fs.writeFileSync(gateRelease, '1');
  await until(() => Boolean(f.flow(superseded.flow).review_job), 20_000);
  const after = f.flow(superseded.flow);
  assert.deepEqual(after.tickets.filter(x => x.landed).map(x => x.ticket).sort(), ['sample/01', 'sample/02']);
  assert.equal(after.tickets.find(x => x.ticket === 'sample/01').land, inFlightLand);
  await f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root, cancel: true });

  // Also verify: a non-held in-flight land that already completed (closing the ticket) while the predecessor was paused is adopted, not dropped.
  f.writeJsonTicket(1, {}, 'donepause');
  f.writeJsonTicket(2, { blocked: 'none' }, 'donepause');
  f.git(f.root, 'add', '.hud/tickets/donepause.json');
  f.git(f.root, 'commit', '-qm', 'donepause feature');
  fs.rmSync(gateStarted, { force: true });
  fs.rmSync(gateRelease, { force: true });

  const doneArgs = { op: 'run', feature: 'donepause', max_parallel: 2, cwd: f.root, handback_to: 'main' };
  const { flow: flow2 } = await f.call('hud_tickets', doneArgs);
  const [dj1, dj2] = await f.jobs(flow2, 2);
  await f.settle(dj1);
  await until(() => fs.existsSync(gateStarted) && Boolean(f.flow(flow2).tickets.find(x => x.ticket === 'donepause/01')?.land), 15_000);
  const land2 = f.flow(flow2).tickets.find(x => x.ticket === 'donepause/01').land;
  await f.settle(dj2, { report: 'Done.\nAssumed: [scope] changed option.\n' });
  const paused2 = await f.end(flow2);
  assert.equal(paused2.state, 'paused');
  assert.equal(paused2.tickets.find(x => x.ticket === 'donepause/01').landed, undefined);

  // Let ticket 01's land finish (and mark the ticket done on base) while flow2 is paused.
  fs.writeFileSync(gateRelease, '1');
  await until(() => f.flow(land2).state === 'completed', 20_000);
  assert.equal(f.flow(flow2).tickets.find(x => x.ticket === 'donepause/01').landed, undefined);

  const superseded2 = await f.call('hud_tickets', doneArgs);
  assert.notEqual(superseded2.flow, flow2);
  assert.ok(superseded2.jobs.some(j => j.ticket === 'donepause/01' && j.job === dj1 && j.land === land2), JSON.stringify(superseded2));
  assert.ok(superseded2.landed.includes('donepause/01'), JSON.stringify(superseded2));
  await until(() => Boolean(f.flow(superseded2.flow).review_job), 20_000);
  assert.deepEqual(f.flow(superseded2.flow).tickets.filter(x => x.landed).map(x => x.ticket).sort(), ['donepause/01', 'donepause/02']);
  await f.call('hud_tickets', { op: 'run', feature: 'donepause', cwd: f.root, cancel: true });
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
  assert.equal(f.ticketRecord(1)?.status, 'ready-for-human');
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
  const escNotices = await collectDeliveredNotices(f, flow, readEsc, 1);
  assert.equal(escNotices.length, 1);
  assert.match(escNotices[0], /escalated: Would delete a user-visible feature/);
  assert.equal((await f.call('hud_read', { job: flow })).changes, undefined);

  // Separate feature with handback_to: main wakes main directly at accept with zero lead jobs.
  f.writeJsonTicket(1, {}, 'direct');
  f.git(f.root, 'add', '.hud/tickets/direct.json');
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
  const directNotices = await collectDeliveredNotices(f, directFlow, readDirect, 1);
  assert.equal(directNotices.length, 1);
  assert.match(directNotices[0], /hand-back at accept/);
  assert.match(directNotices[0], new RegExp(`hud_respond job=${directFlow} answer=<finish\\|repair\\|escalate>`));
});

test('hud_respond answers main hand-back (finish, repair bounded to 2 rounds, escalate) and rejects invalid choices or non-asking runs', { timeout: 60_000 }, async t => {
  // 1. finish (colon reason) + invalid choice + wrong step + unknown run + already-completed run.
  const f = await setupWorkflowProject(t, { tickets: { '01-finish.md': goodTicket(1) } });
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root, handback_to: 'main' });

  // Not paused yet -> no_pending_handback.
  const whileWorking = await f.call('hud_respond', { job: flow, answer: 'finish' });
  assert.equal(whileWorking.ok, false);
  assert.equal(whileWorking.code, 'no_pending_handback');

  const [first] = await f.jobs(flow, 1);
  await f.settle(first);
  await until(() => Boolean(f.flow(flow).review_job), 15_000);
  await f.settleReview(f.flow(flow).review_job);
  const paused = await f.end(flow);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.steps.accept.state, 'asking');

  // Unknown run ID -> flow_not_found.
  const unknown = await f.call('hud_respond', { job: 'q0000000000000000', answer: 'finish' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'flow_not_found');

  // Invalid choices and mismatched request_id leave the hand-back open.
  for (const badAnswer of ['approve', 'finish without colon', '  ']) {
    const bad = await f.call('hud_respond', { job: flow, answer: badAnswer });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'invalid_choice');
    assert.match(bad.error, /finish, repair, escalate/);
  }
  const wrongStep = await f.call('hud_respond', { job: flow, request_id: 'review', answer: 'finish' });
  assert.equal(wrongStep.ok, false);
  assert.equal(wrongStep.code, 'invalid_arguments');
  assert.equal(f.flow(flow).steps.accept.state, 'asking');

  // repair without adding tickets refuses clearly and keeps accept open.
  const noRepair = await f.call('hud_respond', { job: flow, answer: 'repair: Need fix' });
  assert.equal(noRepair.ok, false);
  assert.equal(noRepair.code, 'no_repair_tickets');
  assert.equal(f.flow(flow).steps.accept.state, 'asking');

  // finish settles the asking step, records verdict & decision, and completes the run.
  const finished = await f.call('hud_respond', { job: flow, answer: 'finish: Verified checks and review.' });
  assert.equal(finished.ok, true);
  assert.equal(finished.state, 'completed');
  assert.equal(finished.verdict, 'finish: Verified checks and review.');
  assert.deepEqual(finished.landed, ['sample/01']);
  const doneRun = f.flow(flow);
  assert.equal(doneRun.steps.accept.state, 'done');
  assert.equal(doneRun.steps.accept.answer, 'finish');
  assert.equal(doneRun.handback, undefined);
  assert.equal(doneRun.decisions.length, 1);
  assert.equal(doneRun.decisions[0].job, 'main');
  assert.equal(doneRun.decisions[0].decision, 'finish');
  assert.equal('worker_job' in doneRun.decisions[0], false);

  // Answering again after completion returns no_pending_handback.
  const afterDone = await f.call('hud_respond', { job: flow, answer: 'finish' });
  assert.equal(afterDone.ok, false);
  assert.equal(afterDone.code, 'no_pending_handback');

  // 2. escalate (newline reason) pauses for the owner like a lead escalation.
  f.writeJsonTicket(1, {}, 'esc');
  f.git(f.root, 'add', '.hud/tickets/esc.json');
  f.git(f.root, 'commit', '-qm', 'escalate feature');
  const { flow: escFlow } = await f.call('hud_tickets', { op: 'run', feature: 'esc', max_parallel: 1, cwd: f.root, handback_to: 'main' });
  const [escJob] = await f.jobs(escFlow, 1);
  await f.settle(escJob);
  await until(() => Boolean(f.flow(escFlow).review_job), 15_000);
  await f.settleReview(f.flow(escFlow).review_job);
  await f.end(escFlow);

  const escalated = await f.call('hud_respond', { job: escFlow, answer: 'escalate\nWould delete a user-visible option.' });
  assert.equal(escalated.ok, true);
  assert.equal(escalated.state, 'paused');
  assert.equal(escalated.handback.kind, 'escalate');
  assert.match(escalated.reason, /escalated: Would delete a user-visible option\./);
  assert.equal(f.flow(escFlow).steps.accept.state, 'failed');
  assert.equal(f.flow(escFlow).decisions[0].decision, 'escalate');

  const afterEsc = await f.call('hud_respond', { job: escFlow, answer: 'finish' });
  assert.equal(afterEsc.ok, false);
  assert.equal(afterEsc.code, 'no_pending_handback');

  // 3. repair loops tickets -> review -> accept in the SAME run, bounded to 2 repair rounds.
  f.writeJsonTicket(1, {}, 'rep');
  f.git(f.root, 'add', '.hud/tickets/rep.json');
  f.git(f.root, 'commit', '-qm', 'repair feature');
  const { flow: repFlow } = await f.call('hud_tickets', { op: 'run', feature: 'rep', max_parallel: 1, cwd: f.root, handback_to: 'main' });
  let prevReview;
  let repChangeNotices = 0;
  for (let round = 0; round < 3; round++) {
    const ticketJobs = await f.jobs(repFlow, round + 1);
    await f.settle(ticketJobs[round]);
    await until(() => f.flow(repFlow).review_job && f.flow(repFlow).review_job !== prevReview, 15_000);
    prevReview = f.flow(repFlow).review_job;
    await f.settleReview(prevReview);
    const pausedRound = await f.end(repFlow);
    assert.equal(pausedRound.state, 'paused');
    assert.equal(pausedRound.steps.accept.state, 'asking');
    const readPaused = await f.call('hud_read', { job: repFlow });
    const roundChanges = (readPaused.changes ?? []).filter(line => line.includes(repFlow));
    repChangeNotices += roundChanges.length;
    await until(() => repChangeNotices + promptNotices(f, repFlow).length >= round + 1, 5_000);
    const roundNotices = [...roundChanges, ...promptNotices(f, repFlow)];
    assert.equal(repChangeNotices + promptNotices(f, repFlow).length, round + 1, JSON.stringify(readPaused));
    assert.ok(roundNotices.some(line => line.includes(`hud_respond job=${repFlow} answer=<finish|repair|escalate>`)), JSON.stringify(roundNotices));
    if (round < 2) {
      await f.call('hud_tickets', {
        op: 'add', cwd: f.root, feature: 'rep',
        tickets: [{ title: `Repair ${round + 1}`, blocked_by: [], what: `Fix round ${round + 1}.`, acceptance: ['Fixed'], live_try: 'none' }],
      });
      const sep = round === 0 ? ': ' : '\n';
      const repaired = await f.call('hud_respond', { job: repFlow, answer: `repair${sep}Round ${round + 1} fix.` });
      assert.equal(repaired.ok, true);
      assert.equal(repaired.flow, repFlow);
      assert.equal(repaired.state, 'working');
      assert.equal(repaired.repair_rounds, round + 1);
    } else {
      // Round 2 already used both repair rounds: a 3rd repair escalates like a lead decision.
      const bounded = await f.call('hud_respond', { job: repFlow, answer: 'repair: Still broken.' });
      assert.equal(bounded.ok, true);
      assert.equal(bounded.state, 'paused');
      assert.equal(bounded.repair_rounds, 2);
      assert.equal(bounded.handback.kind, 'escalate');
      assert.match(bounded.reason, /max repair rounds \(2\) reached: Still broken\./);
    }
  }
  assert.equal(f.flow(repFlow).reviews.length, 3);
  assert.equal(f.flow(repFlow).decisions.length, 3);
});

test('restarting a paused run clears its Execution wait and hud_respond cannot revive it', { timeout: 45_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 1 });
  const start = () => f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root, handback_to: 'main' });
  const pauseAtAccept = async (flow, jobs) => {
    await f.settle((await f.jobs(flow, jobs)).at(-1), { report: 'Done.\nAssumed: keep the default.\n' });
    await until(() => Boolean(f.flow(flow).review_job), 15_000);
    await f.settleReview(f.flow(flow).review_job);
    assert.equal((await f.end(flow)).steps.accept.state, 'asking');
  };
  const addRepair = title => f.call('hud_tickets', {
    op: 'add', cwd: f.root, feature: 'sample',
    tickets: [{ title, blocked_by: [], what: 'Make the synthetic fix.', acceptance: ['Fixed'], live_try: 'none' }],
  });
  const repair = job => f.call('hud_respond', { job, answer: 'repair' });
  const working = () => fs.readdirSync(join(f.home, 'flows')).filter(file => /^q[a-f0-9]{16}\.json$/.test(file))
    .map(file => f.flow(file.slice(0, -5))).filter(q => q.feature === 'sample' && q.state === 'working').map(q => q.flow);

  const execution = () => executionSnapshot(f.home, { workers: [], lanes: [] },
    { root: f.root, pane: null, complete: true });
  const readout = (view) => executionRows(view, undefined, 80, Date.now()).map(row => stripAnsi(row.text)).join('\n');
  const { flow } = await start();
  await pauseAtAccept(flow, 1);
  await addRepair('First repair');
  const waitingBefore = countProjectWaitingRuns(f.home, f.root);
  assert.equal(waitingBefore, 1);
  assert.match(readout(execution()), /1 waiting/);
  const restarted = await start();
  const successor = restarted.flow;
  assert.notEqual(successor, flow);
  assert.deepEqual(restarted.todo.map(({ text }) => text), ['keep the default.']);
  assert.equal(countProjectWaitingRuns(f.home, f.root), waitingBefore - 1);
  const view = execution();
  assert.deepEqual(view.runs.filter(run => run.kind === 'queue' && run.endedAt === undefined).map(run => run.flow), [successor]);
  const shown = readout(view);
  assert.doesNotMatch(shown, /1 waiting/);
  assert.match(shown.split('Recently ended')[1], /superseded · 1 landed/);
  const rejected = await repair(flow);
  assert.equal(rejected.code, 'superseded_run');
  assert.match(rejected.error, new RegExp(successor));
  const old = await f.call('hud_read', { job: flow });
  assert.equal(old.state, 'superseded');
  assert.equal(old.superseded_by, successor);
  assert.equal(f.flow(flow).steps.accept.state, 'asking');
  assert.equal(f.flow(flow).repair_rounds, undefined);
  assert.deepEqual(working(), [successor]);

  // A simultaneous answer and explicit start can choose either path, but not both.
  await pauseAtAccept(successor, 2);
  await addRepair('Second repair');
  const [started, answered] = await Promise.all([start(), repair(successor)]);
  assert.deepEqual(working(), [started.flow]);
  if (started.flow === successor) {
    assert.equal(answered.ok, true);
    assert.equal(answered.flow, successor);
  } else {
    assert.equal(answered.code, 'superseded_run');
    assert.equal(f.flow(successor).state, 'superseded');
  }
});

test('hud_tickets run preflights the frontend role of a dependency successor before dispatch', async t => {
  const f = await setupWorkflowProject(t, { tickets: {
    '01-synthetic.md': goodTicket(1),
    '02-synthetic.md': goodTicket(2, { blocked: '01' }).replace('**Blocked by:** 01', '**Blocked by:** 01 · **Who:** frontend-implementer'),
  } });
  const config = join(f.root, '.hud', 'project.json');
  writeFixtureFile(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, 'utf8')), roles: ['imp', 'reviewer', 'lead'] }));
  const { result } = await f.rpc('tools/call', {
    name: 'hud_tickets', arguments: { op: 'run', feature: 'sample', cwd: f.root },
  });
  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.content[0].text).error, /frontend-imp.*Run `hud setup` to enable frontend-imp/);
  assert.equal(fs.existsSync(join(f.home, 'flows')), false);
  assert.equal(fs.existsSync(join(f.home, 'jobs')), false);
});

test('hud_tickets run and unattended on refuse to start when a needed role is not enabled, naming hud setup before dispatching anything', { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { tickets: { '01-rolecheck.md': goodTicket(1) } });
  const projectJson = join(f.root, '.hud', 'project.json');
  const baseConfig = JSON.parse(fs.readFileSync(projectJson, 'utf8'));

  // 1. Project hides lead (only imp and reviewer enabled): default lead hand-back and unattended on refuse; handback_to: main allowed.
  writeFixtureFile(projectJson, JSON.stringify({ ...baseConfig, roles: ['imp', 'reviewer'] }));
  const runNoLead = await f.rpc('tools/call', {
    name: 'hud_tickets', arguments: { op: 'run', feature: 'sample', cwd: f.root },
  });
  assert.equal(runNoLead.result.isError, true);
  const noLeadError = JSON.parse(runNoLead.result.content[0].text).error;
  assert.match(noLeadError, /lead/);
  assert.match(noLeadError, /hud setup/);
  assert.equal(fs.existsSync(join(f.home, 'flows')), false, 'no flow created when lead is disabled');
  assert.equal(fs.existsSync(join(f.home, 'jobs')), false, 'no job dispatched when lead is disabled');

  const unattNoLead = await new Promise(resolveDone => {
    const child = spawn(process.execPath, [resolve('bin/hud'), 'unattended', 'on', '--objective', 'selected'], {
      cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', code => resolveDone({ code, stderr }));
  });
  assert.equal(unattNoLead.code, 2);
  assert.match(unattNoLead.stderr, /lead/);
  assert.match(unattNoLead.stderr, /hud setup/);
  assert.equal(fs.existsSync(join(f.home, 'unattended.json')), false, 'unattended control not written');

  // 2. Project hides reviewer: even handback_to: main refuses before creating any flow or job.
  writeFixtureFile(projectJson, JSON.stringify({ ...baseConfig, roles: ['imp', 'lead'] }));
  const runNoReviewer = await f.rpc('tools/call', {
    name: 'hud_tickets', arguments: { op: 'run', feature: 'sample', cwd: f.root, handback_to: 'main' },
  });
  assert.equal(runNoReviewer.result.isError, true);
  const noReviewerError = JSON.parse(runNoReviewer.result.content[0].text).error;
  assert.match(noReviewerError, /reviewer/);
  assert.match(noReviewerError, /hud setup/);
  assert.equal(fs.existsSync(join(f.home, 'flows')), false);

  // 3. Project hides both imp and lead: error names both.
  writeFixtureFile(projectJson, JSON.stringify({ ...baseConfig, roles: ['reviewer'] }));
  const runMissingBoth = await f.rpc('tools/call', {
    name: 'hud_tickets', arguments: { op: 'run', feature: 'sample', cwd: f.root },
  });
  assert.equal(runMissingBoth.result.isError, true);
  const missingBothError = JSON.parse(runMissingBoth.result.content[0].text).error;
  assert.match(missingBothError, /imp, lead/);
  assert.match(missingBothError, /hud setup/);
  assert.equal(fs.existsSync(join(f.home, 'flows')), false);

  // 4. With imp and reviewer enabled (lead still hidden), handback_to: main starts normally.
  writeFixtureFile(projectJson, JSON.stringify({ ...baseConfig, roles: ['imp', 'reviewer'] }));
  const mainRun = await f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root, handback_to: 'main' });
  assert.match(mainRun.flow, /^q[0-9a-f]{16}$/);
  assert.equal(mainRun.state, 'working');
  await f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root, cancel: true });
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
  const escNotices = await collectDeliveredNotices(f, flow, readEsc, 1);
  assert.equal(escNotices.length, 1);
  assert.match(escNotices[0], /max repair rounds \(2\) reached/);
});

test('repair ticket repairs ref is admitted onto q.tickets[] and archived on ticket_queue event naming B, not A', { timeout: 60_000 }, async t => {
  const f = await setupWorkflowProject(t, { tickets: {} });
  // Use JSON ticket store with two sibling slices A (01) and B (02).
  await f.call('hud_tickets', {
    op: 'add', cwd: f.root, feature: 'jsonfeat',
    tickets: [
      { title: 'Slice A', blocked_by: [], what: 'Build A.', acceptance: ['A works'], live_try: 'none' },
      { title: 'Slice B', blocked_by: [], what: 'Build B.', acceptance: ['B works'], live_try: 'none' },
    ],
  });
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'jsonfeat', max_parallel: 2, cwd: f.root });
  const [jobA, jobB] = await f.jobs(flow, 2);
  await f.settle(jobA);
  await f.settle(jobB);

  await until(() => Boolean(f.flow(flow).review_job), 15_000);
  const review1 = f.flow(flow).review_job;
  await f.settleReview(review1);
  await until(() => f.flow(flow).active_lead?.kind === 'accept', 15_000);
  const lead1 = f.flow(flow).active_lead.job;

  // Lead adds repair ticket targeting slice B only (not sibling A).
  await f.call('hud_tickets', {
    op: 'add', cwd: f.root, feature: 'jsonfeat',
    tickets: [{ title: 'Repair B', blocked_by: [], repairs: ['jsonfeat/02'], what: 'Fix B.', acceptance: ['B fixed'], live_try: 'none' }],
  });
  await f.settleLead(lead1, 'Decision: repair\nReason: Fix slice B finding.\n');

  const [, , jobRepair] = await f.jobs(flow, 3);
  const mid = f.flow(flow);
  const repairItem = mid.tickets.find(item => item.ticket === 'jsonfeat/03');
  assert.equal(repairItem?.round, 1);
  assert.deepEqual(repairItem?.repairs, ['jsonfeat/02']);
  assert.equal(mid.tickets.find(item => item.ticket === 'jsonfeat/01')?.repairs, undefined);
  assert.equal(mid.tickets.find(item => item.ticket === 'jsonfeat/02')?.repairs, undefined);

  await f.settle(jobRepair);
  await until(() => f.flow(flow).review_job && f.flow(flow).review_job !== review1, 15_000);
  await f.settleReview(f.flow(flow).review_job);
  await until(() => f.flow(flow).active_lead?.kind === 'accept' && f.flow(flow).active_lead.job !== lead1, 15_000);
  const lead2 = f.flow(flow).active_lead.job;
  await f.settleLead(lead2, 'Decision: finish\nReason: Slice B repair verified.\n');
  const done = await f.end(flow);
  assert.equal(done.state, 'completed');
  assert.ok(done.decisions.every(d => d.kind === 'accept' && !('worker_job' in d)), JSON.stringify(done.decisions));

  // Archive expired receipt and verify monthly ticket_queue event carries repairs naming B, not A.
  const receiptPath = join(f.home, 'flows', `${flow}.json`);
  const staleAt = new Date(Date.now() - JOB_RETENTION_MS - 60_000);
  fs.utimesSync(receiptPath, staleAt, staleAt);
  pruneLandFlows(f.home, Date.now());
  const month = new Date(Date.parse(done.updated_at)).toISOString().slice(0, 7);
  const events = fs.readFileSync(join(f.home, 'events', `${month}.jsonl`), 'utf8').trimEnd().split('\n').map(JSON.parse);
  const ev = events.find(e => e.kind === 'ticket_queue' && e.flow === flow);
  assert.ok(ev, JSON.stringify(events));
  assert.deepEqual(ev.tickets.find(item => item.ticket === 'jsonfeat/03')?.repairs, ['jsonfeat/02']);
  assert.equal('repairs' in ev.tickets.find(item => item.ticket === 'jsonfeat/01'), false);
  assert.equal('repairs' in ev.tickets.find(item => item.ticket === 'jsonfeat/02'), false);
});

test('lead.md and buildAcceptPacket require repair tickets to set repairs on Decision: repair', () => {
  const leadMd = fs.readFileSync(resolve('packages/hud-mcp/instructions/lead.md'), 'utf8');
  assert.match(leadMd, /Decision: repair/);
  assert.match(leadMd, /`repairs`[^.\n]*slice/);

  const baseQueue = {
    flow: 'q0000000000000009', root: '/tmp/synthetic', feature: 'sample', pane: '', task: false,
    max_parallel: 1, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    state: 'working', tickets: [],
  };
  const step = { kind: 'handback', ask: 'Accept?', options: ['finish', 'repair', 'escalate'], needs: [], from: [], optional: false };
  const ordinaryPacket = buildAcceptPacket(baseQueue, step);
  assert.match(ordinaryPacket, /`repairs`[^.\n]*slice/);
  assert.match(ordinaryPacket, /Decision: repair/);
  const unattendedPacket = buildAcceptPacket({ ...baseQueue, unattended: { objective: 'obj-1' } }, step);
  assert.match(unattendedPacket, /unattended repair[^.\n]*`repairs`[^.\n]*slice/i);
});

test('subject-bearing tickets handback records worker_job while run-wide accept handback omits it', async t => {
  const f = await setupWorkflowProject(t, { count: 1 });
  const now = '2026-01-01T00:00:00.000Z';
  const subjectWorker = 'j00000000000000aa';
  const mkFlow = (flow, handback) => {
    fs.mkdirSync(join(f.home, 'flows', flow), { recursive: true });
    writeTicketQueue(f.home, {
      flow, root: f.root, cwd: f.root, project_root: f.root, feature: 'sample', pane: f.env.HERDR_PANE_ID,
      task: false, max_parallel: 1, created_at: now, updated_at: now, state: 'paused',
      steps: { [handback.step]: { state: 'asking', changed_at: now } },
      handback, tickets: [{ ticket: 'sample/01', path: join(f.root, f.ticketPath(1)), role: 'imp', job: subjectWorker }],
    }, true);
  };

  // Tickets-step handback with a subject worker records worker_job on non-resume/stop choices (e.g. finish / escalate).
  const flowTicketsFinish = 'q00000000000000a1';
  mkFlow(flowTicketsFinish, { step: 'tickets', choices: ['finish', 'escalate'], kind: 'assumption', ticket: 'sample/01', job: subjectWorker });
  const resTicketsFinish = await answerTicketQueueHandback(f.home, flowTicketsFinish, 'finish: Approved subject.', { pane: f.env.HERDR_PANE_ID, cwd: f.root });
  assert.equal(resTicketsFinish.ok, true);
  assert.equal(resTicketsFinish.queue.decisions[0].worker_job, subjectWorker);
  assert.equal(resTicketsFinish.queue.decisions[0].ticket, 'sample/01');

  const flowTicketsEsc = 'q00000000000000a2';
  mkFlow(flowTicketsEsc, { step: 'tickets', choices: ['finish', 'escalate'], kind: 'assumption', ticket: 'sample/01', job: subjectWorker });
  const resTicketsEsc = await answerTicketQueueHandback(f.home, flowTicketsEsc, 'escalate: Needs owner.', { pane: f.env.HERDR_PANE_ID, cwd: f.root });
  assert.equal(resTicketsEsc.ok, true);
  assert.equal(resTicketsEsc.queue.decisions[0].worker_job, subjectWorker);
  assert.equal(resTicketsEsc.queue.decisions[0].ticket, 'sample/01');

  // Run-wide accept handback leaves worker_job absent.
  const flowAccept = 'q00000000000000a3';
  mkFlow(flowAccept, { step: 'accept', choices: ['finish', 'repair', 'escalate'] });
  const resAccept = await answerTicketQueueHandback(f.home, flowAccept, 'finish: Run-wide accept.', { pane: f.env.HERDR_PANE_ID, cwd: f.root });
  assert.equal(resAccept.ok, true);
  assert.equal('worker_job' in resAccept.queue.decisions[0], false);
});

test('restarted runs carry repair_rounds across repair restarts (showing 2/2 in lead packet) and reset to 0 after a finish verdict', { timeout: 90_000 }, async t => {
  const f = await setupWorkflowProject(t, { tickets: { '01-first.md': goodTicket(1) } });

  // Run 1: ticket 01 lands -> review -> lead 1 requests repair without adding tickets -> pauses/escalates.
  const { flow: flow1 } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root });
  const [job1] = await f.jobs(flow1, 1);
  await f.settle(job1);
  await until(() => Boolean(f.flow(flow1).review_job), 15_000);
  await f.settleReview(f.flow(flow1).review_job);
  await until(() => f.flow(flow1).active_lead?.kind === 'accept', 15_000);
  const lead1 = f.flow(flow1).active_lead.job;
  assert.match(fs.readFileSync(join(f.dir(lead1), 'brief.md'), 'utf8'), /repair round 0\/2/);
  await f.settleLead(lead1, 'Decision: repair\nReason: Needs repair ticket 02.\n');
  const paused1 = await f.end(flow1);
  assert.equal(paused1.state, 'paused');
  assert.equal(paused1.handback.kind, 'escalate');
  assert.match(paused1.reason, /no ready tickets/);

  // Restart 1: add ticket 02 and start a new run -> inherits repair_rounds = 1.
  await f.call('hud_tickets', {
    op: 'add', cwd: f.root, feature: 'sample',
    tickets: [{ title: 'Repair 1', blocked_by: [], what: 'Apply first repair.', acceptance: ['First repair fixed'], live_try: 'none' }],
  });
  const { flow: flow2 } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root });
  assert.notEqual(flow2, flow1);
  assert.equal(f.flow(flow2).repair_rounds, 1);
  assert.deepEqual(f.flow(flow2).decisions, paused1.decisions);
  const [, job2] = await f.jobs(flow2, 2);
  assert.equal(f.job(job2).ticket, 'sample/02');
  await f.settle(job2);
  await until(() => Boolean(f.flow(flow2).review_job), 15_000);
  await f.settleReview(f.flow(flow2).review_job);
  await until(() => f.flow(flow2).active_lead?.kind === 'accept', 15_000);
  const lead2 = f.flow(flow2).active_lead.job;
  assert.match(fs.readFileSync(join(f.dir(lead2), 'brief.md'), 'utf8'), /repair round 1\/2/);

  // Lead 2 adds ticket 03 and declares repair (repair_rounds -> 2); then Run 2 is cancelled before ticket 03 lands.
  await f.call('hud_tickets', {
    op: 'add', cwd: f.root, feature: 'sample',
    tickets: [{ title: 'Repair 2', blocked_by: [], what: 'Apply second repair.', acceptance: ['Second repair fixed'], live_try: 'none' }],
  });
  await f.settleLead(lead2, 'Decision: repair\nReason: Needs second repair ticket 03.\n');
  const [, , job3Cancelled] = await f.jobs(flow2, 3);
  assert.equal(f.flow(flow2).repair_rounds, 2);
  await f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root, cancel: true });
  const cancelled2 = await f.end(flow2);
  assert.equal(cancelled2.state, 'cancelled');
  assert.equal(cancelled2.repair_rounds, 2);
  writeFixtureFile(join(f.dir(job3Cancelled), 'STATUS.json'), JSON.stringify({ state: 'stopped', ended_at: new Date().toISOString() }));

  // Restart 2 after cancelled run: Run 3 keeps repair_rounds = 2 and lead packet shows 2/2 limit reached.
  const { flow: flow3 } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root });
  assert.notEqual(flow3, flow2);
  assert.equal(f.flow(flow3).repair_rounds, 2);
  const [job3] = await f.jobs(flow3, 1);
  assert.equal(f.job(job3).ticket, 'sample/03');
  await f.settle(job3);
  await until(() => Boolean(f.flow(flow3).review_job), 15_000);
  await f.settleReview(f.flow(flow3).review_job);
  await until(() => f.flow(flow3).active_lead?.kind === 'accept', 15_000);
  const lead3 = f.flow(flow3).active_lead.job;
  const packet3 = fs.readFileSync(join(f.dir(lead3), 'brief.md'), 'utf8');
  assert.match(packet3, /Declared choices: finish, escalate \(repair limit 2\/2 reached\)/);
  await f.settleLead(lead3, 'Decision: finish\nReason: Second repair verified.\n');
  const done3 = await f.end(flow3);
  assert.equal(done3.state, 'completed');
  assert.equal(done3.verdict, 'finish: Second repair verified.');

  // Fresh milestone after a finish verdict starts at 0.
  await f.call('hud_tickets', {
    op: 'add', cwd: f.root, feature: 'sample',
    tickets: [{ title: 'Next milestone', blocked_by: [], what: 'Start next milestone.', acceptance: ['Next milestone works'], live_try: 'none' }],
  });
  const { flow: flow4 } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root });
  assert.equal(f.flow(flow4).repair_rounds, undefined);
  const [job4] = await f.jobs(flow4, 1);
  assert.equal(f.job(job4).ticket, 'sample/04');
  await f.settle(job4);
  await until(() => Boolean(f.flow(flow4).review_job), 15_000);
  await f.settleReview(f.flow(flow4).review_job);
  await until(() => f.flow(flow4).active_lead?.kind === 'accept', 15_000);
  const lead4 = f.flow(flow4).active_lead.job;
  assert.match(fs.readFileSync(join(f.dir(lead4), 'brief.md'), 'utf8'), /Declared choices: finish, repair, escalate \(repair round 0\/2\)/);
  await f.settleLead(lead4, 'Decision: finish\nReason: Fresh milestone verified.\n');
  assert.equal((await f.end(flow4)).state, 'completed');
});

test('startTicketQueue inherits repair_rounds across failed, cancelled, paused/escalated and unattended objective runs unless finished', { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { tickets: { '01-seed.md': goodTicket(1) } });
  const flowsDir = join(f.home, 'flows');
  fs.mkdirSync(flowsDir, { recursive: true });
  const seed = (flow, fields) => writeTicketQueue(f.home, {
    flow, root: f.root, cwd: f.root, project_root: f.root, feature: 'sample', pane: f.env.HERDR_PANE_ID,
    task: false, max_parallel: 1, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    state: 'failed', tickets: [], ...fields,
  }, true);

  for (const [idx, prior] of [
    { state: 'failed', repair_rounds: 1, expect: 1 },
    { state: 'cancelled', repair_rounds: 2, expect: 2 },
    { state: 'paused', handback: { step: 'accept', choices: ['resume', 'stop'], kind: 'escalate' }, repair_rounds: 2, expect: 2 },
    { state: 'completed', verdict: 'finish: Verified.', repair_rounds: 2, expect: undefined },
  ].entries()) {
    const prevId = `q000000000000010${idx}`;
    const createdAt = `2026-01-0${idx + 1}T00:00:00.000Z`;
    seed(prevId, {
      created_at: createdAt, updated_at: createdAt,
      state: prior.state, repair_rounds: prior.repair_rounds,
      ...(prior.handback && { handback: prior.handback }),
      ...(prior.verdict && { verdict: prior.verdict }),
    });
    const next = await startTicketQueue(f.home, f.root, f.env.HERDR_PANE_ID, false, { feature: 'sample', max_parallel: 1 });
    assert.ok(next);
    assert.equal(next.repair_rounds, prior.expect, `state=${prior.state} verdict=${prior.verdict}`);
    await cancelTicketQueueRun(f.home, next.flow, { pane: f.env.HERDR_PANE_ID, root: f.root, waitMs: 5_000 });
    fs.rmSync(join(flowsDir, `${next.flow}.json`), { force: true });
    fs.rmSync(join(flowsDir, next.flow), { recursive: true, force: true });
  }

  // Unattended objective runs inherit repair_rounds for the same objective unless finished with a finish verdict.
  writeFixtureFile(join(f.root, '.hud', 'objectives.md'), '# Objectives\n\n## obj-a — Objective A\n- State: active\n- Features: sample\n\n## obj-b — Objective B\n- State: active\n- Features: other\n');
  seed('q0000000000000201', {
    feature: 'obj-a', pane: '', unattended: { objective: 'obj-a' },
    created_at: '2026-02-01T00:00:00.000Z', updated_at: '2026-02-01T00:00:00.000Z',
    state: 'cancelled', repair_rounds: 2,
  });
  const u1 = await startTicketQueue(f.home, f.root, null, false, { feature: 'obj-a' }, undefined, {
    flow: 'q0000000000000202', objective: 'obj-a',
  });
  assert.equal(u1.repair_rounds, 2);
  await cancelTicketQueueRun(f.home, u1.flow, { unattendedOnly: true, waitMs: 5_000 });

  // Different objective does not inherit obj-a's repair_rounds.
  const uOther = await startTicketQueue(f.home, f.root, null, false, { feature: 'obj-b' }, undefined, {
    flow: 'q0000000000000203', objective: 'obj-b',
  });
  assert.equal(uOther.repair_rounds, undefined);
  await cancelTicketQueueRun(f.home, uOther.flow, { unattendedOnly: true, waitMs: 5_000 });

  // Unattended objective finished with a finish verdict resets to 0.
  const finishedAt = new Date(Date.now() + 1_000).toISOString();
  seed('q0000000000000204', {
    feature: 'obj-a', pane: '', unattended: { objective: 'obj-a' },
    created_at: finishedAt, updated_at: finishedAt,
    state: 'completed', verdict: 'finish: Objective milestone verified.', repair_rounds: 2,
  });
  const uReset = await startTicketQueue(f.home, f.root, null, false, { feature: 'obj-a' }, undefined, {
    flow: 'q0000000000000205', objective: 'obj-a',
  });
  assert.equal(uReset.repair_rounds, undefined);
  await cancelTicketQueueRun(f.home, uReset.flow, { unattendedOnly: true, waitMs: 5_000 });
});
