import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { JOB_RETENTION_MS } from '../../dist/runtime/work-retention.js';
import { pinnedHeldJobs } from '../../dist/unattended/state.js';
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
  assert.equal(readSame.changes.length, 1);
  assert.match(readSame.changes[0], /worker correction.*hud_land.*stop/i);
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
  assert.match(f.git(f.root, 'show', `base:${f.ticketPath(1)}`), /\*\*Status:\*\* ready-for-human/);
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
  assert.ok(pinnedHeldJobs(f.home).has(job), 'retention treats a missing ticket file as not closed');
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
  await until(() => f.flow(flow).tickets.find(x => x.ticket === 'sample/01')?.landed === true, 15_000);
  await f.settle(second, { report: 'Done.\nAssumed: [scope] removed legacy flag.\n' });
  await until(() => f.flow(flow).active_lead?.kind === 'assumption', 15_000);
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
  assert.match(readSame.changes[0], /worker correction.*hud_land.*stop/i);

  // Moving only the worker worktree HEAD (same report) un-holds and re-judges via a new assumption lead.
  const wt2 = f.job(second).worktree.root;
  fs.writeFileSync(join(wt2, 'sample-02.txt'), 'Restored legacy flag.\n');
  f.git(wt2, 'add', 'sample-02.txt');
  f.git(wt2, 'commit', '-qm', 'Restore legacy flag');
  const headResume = await f.call('hud_tickets', runArgs);
  await until(() => f.flow(headResume.flow).active_lead?.kind === 'assumption', 15_000);
  const lead2 = f.flow(headResume.flow).active_lead.job;
  assert.notEqual(lead2, lead1);
  await f.settleLead(lead2, 'Decision: continue\nReason: Legacy flag restored in new commit.\n');
  await until(() => f.flow(headResume.flow).tickets.find(x => x.ticket === 'sample/02')?.landed === true, 15_000);
  await until(() => Boolean(f.flow(headResume.flow).review_job), 15_000);
  await f.settleReview(f.flow(headResume.flow).review_job);
  await until(() => f.flow(headResume.flow).active_lead?.kind === 'accept', 15_000);
  await f.settleLead(f.flow(headResume.flow).active_lead.job, 'Decision: finish\nReason: Both tickets landed cleanly.\n');
  const done = await f.end(headResume.flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.deepEqual(done.tickets.filter(x => x.landed).map(x => x.ticket).sort(), ['sample/01', 'sample/02']);
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
  assert.match(readDirect.changes[0], new RegExp(`hud_respond job=${directFlow} answer=<finish\\|repair\\|escalate>`));
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

  // Answering again after completion returns no_pending_handback.
  const afterDone = await f.call('hud_respond', { job: flow, answer: 'finish' });
  assert.equal(afterDone.ok, false);
  assert.equal(afterDone.code, 'no_pending_handback');

  // 2. escalate (newline reason) pauses for the owner like a lead escalation.
  const escIssues = join(f.root, '.scratch', 'esc', 'issues');
  fs.mkdirSync(escIssues, { recursive: true });
  fs.writeFileSync(join(escIssues, '01-esc.md'), goodTicket(1));
  f.git(f.root, 'add', '.scratch');
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
  const repIssues = join(f.root, '.scratch', 'rep', 'issues');
  fs.mkdirSync(repIssues, { recursive: true });
  fs.writeFileSync(join(repIssues, '01-rep.md'), goodTicket(1));
  f.git(f.root, 'add', '.scratch');
  f.git(f.root, 'commit', '-qm', 'repair feature');
  const { flow: repFlow } = await f.call('hud_tickets', { op: 'run', feature: 'rep', max_parallel: 1, cwd: f.root, handback_to: 'main' });
  let prevReview;
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
    assert.ok(readPaused.changes?.some(line => line.includes(`hud_respond job=${repFlow} answer=<finish|repair|escalate>`)), JSON.stringify(readPaused));
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

test('hud_respond cannot revive a superseded main hand-back', { timeout: 45_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 1 });
  const start = () => f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root, handback_to: 'main' });
  const pauseAtAccept = async (flow, jobs) => {
    await f.settle((await f.jobs(flow, jobs)).at(-1));
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

  const { flow } = await start();
  await pauseAtAccept(flow, 1);
  await addRepair('First repair');
  const { flow: successor } = await start();
  assert.notEqual(successor, flow);
  const rejected = await repair(flow);
  assert.equal(rejected.code, 'superseded_run');
  assert.match(rejected.error, new RegExp(successor));
  assert.equal(f.flow(flow).state, 'paused');
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
    assert.equal(f.flow(successor).state, 'paused');
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
  assert.equal(readEsc.changes.length, 1);
  assert.match(readEsc.changes[0], /max repair rounds \(2\) reached/);
});
