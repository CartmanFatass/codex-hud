import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { isProcAlive, procStat, readBootId } from '../../dist/utils/proc.js';
import { HomePortfolioCollector } from '../../dist/collectors/home-portfolio.js';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { readMachineWork } from '../../dist/collectors/work-summary-snapshot.js';
import { homeRows } from '../../dist/render/home-view.js';
import { machineWorkForms } from '../../dist/render/work-summary.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { loadGraph } from '../../dist/workflows/graph.js';
import { pruneLandFlows } from '../../dist/runtime/work-retention.js';
import { pinnedHeldJobs } from '../../dist/unattended/state.js';
import { stopChild } from '../helpers/process-cleanup.mjs';
import { resultValue, rpcClient, until } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { goodTicket, readJson, setupWorkflowProject } from '../helpers/workflow-ticket-project.mjs';

const runner = resolve('packages/hud-mcp/bin/workflow-runner.mjs');
const runFile = promisify(execFile);

function unattended(f, extraEnv = {}) {
  const env = { ...f.env, HUD_UNATTENDED_RECONCILE_MS: '300000', ...extraEnv };
  const cmd = (...args) => JSON.parse(execFileSync(process.execPath, [resolve('bin/hud'), 'unattended', ...args], {
    cwd: f.root, env, encoding: 'utf8', timeout: 18_000,
  }));
  const status = () => cmd('status');
  const findRun = async (objective, exclude = new Set()) => {
    const index = join(f.home, 'unattended-runs.json');
    let q;
    await until(() => {
      const ids = fs.existsSync(index) ? readJson(index) : [];
      q = ids.filter(id => !exclude.has(id) && fs.existsSync(join(f.home, 'flows', `${id}.json`)))
        .map(f.flow).find(r => r.unattended?.objective === objective && r.tickets.some(t => t.job));
      return !!q;
    }, 15_000);
    return q.flow;
  };
  const ticketJob = async (flow, ticket) => {
    let jobId;
    await until(() => {
      jobId = f.flow(flow).tickets.find(t => t.ticket === ticket)?.job;
      return Boolean(jobId);
    }, 15_000);
    return jobId;
  };
  const accept = async (flow, report = 'Decision: finish\nReason: Accepted synthetic Objective run.\n') => {
    await until(() => Boolean(f.flow(flow).review_job), 15_000);
    await f.settleReview(f.flow(flow).review_job);
    await until(() => f.flow(flow).active_lead?.kind === 'accept', 15_000);
    await f.settleLead(f.flow(flow).active_lead.job, report);
  };
  return { cmd, status, findRun, ticketJob, accept };
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
  const f = await setupWorkflowProject(t);
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
  await runFile(process.execPath, [runner, flow], { env: f.env, cwd: f.root, timeout: 4000 });
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

  await until(() => Boolean(f.flow(flow).review_job), 15_000);
  const reviewJob = f.flow(flow).review_job;
  assert.equal(f.job(reviewJob).role, 'reviewer');
  assert.equal(f.job(reviewJob).herdr_pane, undefined);
  await f.settleReview(reviewJob);

  await until(() => f.flow(flow).active_lead?.kind === 'accept', 15_000);
  const leadId = f.flow(flow).active_lead.job;
  const leadReceipt = f.job(leadId);
  assert.equal(leadReceipt.role, 'lead');
  assert.equal(leadReceipt.cli.agent, 'claude');
  assert.equal(leadReceipt.herdr_pane, undefined);
  assert.equal(leadReceipt.herdr_workspace, 'w4E');

  const commands = f.fakeLog();
  const leadTabCreate = commands.find(c => c.command === 'herdr' && c.args[0] === 'tab' && c.args[1] === 'create' &&
    c.args.includes(`HUD_JOB_DIR=${f.dir(leadId)}`));
  assert.ok(leadTabCreate, 'lead tab create logged');
  assert.equal(leadTabCreate.args[leadTabCreate.args.indexOf('--workspace') + 1], 'w4E');

  await f.settleLead(leadId, 'Decision: finish\nReason: Verified checks and review.\nTodo: Revisit edge case later\n');
  const done = await f.end(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(done.steps.tickets.state, 'done');
  assert.equal(done.steps.review.state, 'done');
  assert.equal(done.steps.accept.state, 'done');
  assert.equal(done.steps.accept.answer, 'finish');
  assert.ok(f.job(leadId).reaped_at, 'lead job closed via normal HUD closure');
  assert.ok(f.fakeLog().some(c => c.command === 'hud-reap' && c.args[0] === f.dir(leadId)), 'hud-reap closed lead');

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
  const f = await setupWorkflowProject(t, { count: 1 });
  const env = { ...f.env }; delete env.HERDR_PANE_ID;
  const { stdout: started } = await runFile(process.execPath, [
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

test('unattended Objective run lands tickets in one run (N + 2 sessions), records durable owner-try acceptance, and wakes on fs watch for next run', { timeout: 60_000 }, async t => {
  const f = await setupWorkflowProject(t, {
    tickets: {
      '01-synthetic.md': goodTicket(1, { ownerTry: 'yes', approvedRemovals: 'legacy-banner' }),
      '02-synthetic.md': goodTicket(2, { blocked: '01' }),
    },
    extraFeatures: {
      downstream: {
        '01-synthetic.md': goodTicket(1, { blocked: 'sample/01', objective: 'selected' }),
      },
    },
  });
  const u = unattended(f);
  f.onCleanup(() => u.cmd('off'));
  assert.equal(u.status().on, false);
  const firstOn = u.cmd('on', '--objective', 'other');
  assert.equal(firstOn.on, true);
  assert.equal(firstOn.start, procStat(firstOn.pid)?.start);
  assert.equal(firstOn.boot_id, readBootId());
  for (const file of ['unattended.json', 'unattended.pid.json']) assert.equal(fs.statSync(join(f.home, file)).mode & 0o777, 0o600);
  await f.stopMcp();

  // Second `on` updates selection without starting another service.
  const updated = u.cmd('on', '--objective', 'selected', '--objective', 'other');
  assert.equal(updated.pid, firstOn.pid);
  assert.deepEqual(updated.objectives, ['selected', 'other']);

  // ONE Objective run handles both sample/01 and sample/02.
  const flow1 = await u.findRun('selected');
  const q1 = f.flow(flow1);
  assert.equal(q1.pane, '');
  assert.equal(q1.origin_mcp, undefined);
  assert.deepEqual(q1.unattended, { objective: 'selected' });
  assert.match(q1.escalation_rule, /only.*user-visible feature.*docs\/spec\.md/);

  const w1 = await u.ticketJob(flow1, 'sample/01');
  // Brief asks for Removes: declaration.
  assert.match(fs.readFileSync(join(f.dir(w1), 'brief.md'), 'utf8'), /Removes:/);
  // Named removal matching ticket Approved removals: passes deterministically without pre-land lead!
  await f.settle(w1, { report: 'Synthetic finished.\nRemoves: legacy-banner\n' });
  await until(() => f.flow(flow1).tickets.find(x => x.ticket === 'sample/01')?.landed === true, 15_000);
  // Owner try: yes landed as ready-for-human until lead acceptance.
  assert.match(f.git(f.root, 'show', `base:${f.ticketPath(1)}`), /\*\*Status:\*\* ready-for-human/);

  const w2 = await u.ticketJob(flow1, 'sample/02');
  await f.settle(w2, { report: 'Synthetic finished.\nRemoves: none\n' });
  await u.accept(flow1, 'Decision: finish\nReason: Verified both slices cleanly.\n');
  const done1 = await f.end(flow1);
  assert.equal(done1.state, 'completed', JSON.stringify(done1));
  assert.deepEqual(done1.tickets.map(x => x.ticket), ['sample/01', 'sample/02']);

  // Baseline session count for N = 2 clean slices: N + 2 = 4 (2 imp + 1 reviewer + 1 accept lead; 0 pre-land leads).
  const run1Jobs = fs.readdirSync(join(f.home, 'jobs'))
    .filter(id => /^j[a-f0-9]{16}$/.test(id))
    .map(f.job)
    .filter(j => j.ticket_queue === flow1);
  assert.equal(run1Jobs.length, 4, `expected N+2=4 sessions, got ${run1Jobs.map(j => j.role).join(', ')}`);
  assert.deepEqual(run1Jobs.map(j => j.role).sort(), ['imp', 'imp', 'lead', 'reviewer']);

  // Durable acceptance recorded on landed Owner try: yes ticket (status done + run id/verdict comment).
  const acceptedText = fs.readFileSync(join(f.root, f.ticketPath(1)), 'utf8');
  assert.match(acceptedText, /\*\*Status:\*\* done/);
  assert.match(acceptedText, new RegExp(`Accepted by unattended lead \\(${flow1}\\): finish: Verified both slices cleanly\\.`));

  // Board (ProjectCollector) reads the durable acceptance as done, not try.
  const snap = await new ProjectCollector(f.root, f.home, f.env).collect(true, { workers: [], lanes: [] }, Date.now());
  const sample01 = snap.tickets.find(feat => feat.slug === 'sample')?.tickets.find(t => t.number === '01');
  assert.equal(sample01?.state, 'done');

  // Newly unblocked cross-feature ticket wakes the service via fs watch (reconcile is 5 min!) and starts run 2.
  const flow2 = await u.findRun('selected', new Set([flow1]));
  assert.notEqual(flow2, flow1);
  const w3 = await u.ticketJob(flow2, 'downstream/01');
  await f.settle(w3);
  await u.accept(flow2);
  assert.equal((await f.end(flow2)).state, 'completed');
  assert.ok(machineWorkForms(readMachineWork(f.home, Date.now()), Date.now()).some(form => form.includes('Unatt')));
});

test('held item stays on Home, excludes itself and dependents from shared admission, allows manual owner land, while unrelated ticket drains and off kills nothing', { timeout: 60_000 }, async t => {
  const f = await setupWorkflowProject(t, {
    tickets: {
      '01-synthetic.md': goodTicket(1),
      '02-synthetic.md': goodTicket(2, { blocked: '01' }),
      '03-synthetic.md': goodTicket(3, { blocked: 'none' }),
    },
  });
  const u = unattended(f);
  f.onCleanup(() => u.cmd('off'));
  const { pid, start } = u.cmd('on', '--objective', 'selected');
  const flow = await u.findRun('selected');
  const w1 = await u.ticketJob(flow, 'sample/01');
  const w3 = await u.ticketJob(flow, 'sample/03');

  // Worker 1 omits required Removes: line -> held deterministically (missing line != none).
  await f.settle(w1, { report: 'Synthetic finished without removals line.\n' });
  await until(() => Boolean(f.flow(flow).tickets.find(x => x.ticket === 'sample/01')?.held), 15_000);
  const heldItem = f.flow(flow).tickets.find(x => x.ticket === 'sample/01');
  assert.match(heldItem.held.reason, /missing required Removes:/i);
  assert.equal(heldItem.land, undefined);

  // Shared admission excludes held sample/01 AND its dependent sample/02 everywhere!
  const ready = await f.call('hud_tickets', { op: 'ready', cwd: f.root });
  assert.ok(!ready.tickets.some(x => x.ticket === 'sample/01' || x.ticket === 'sample/02'), JSON.stringify(ready));
  // Even an ordinary feature queue sees sample/02 as blocked, not ready.
  assert.ok(f.flow(flow).blocked?.some(b => b.ticket === 'sample/02'), JSON.stringify(f.flow(flow).blocked));

  // Land guard: direct startLand without queue/approved head refuses for unattended job;
  // tampered HEAD after approval refuses too.
  await assert.rejects(
    runFile(process.execPath, [
      '--input-type=module', '-e',
      `import { startLand } from './dist/mcp/land.js';
       import { findJob } from './dist/mcp/store/job-store.js';
       const job = findJob(process.argv[1]);
       await startLand(process.env.HUD_HOME, job.job, job, 'closed', null, false);`,
      w3,
    ], { env: f.env }),
    /Unattended job requires its run and an approved commit/,
  );

  // Unrelated sample/03 declares ambiguous removal -> temporary ambiguity lead -> approves exact SHA!
  await f.settle(w3, { report: 'Synthetic done.\nRemoves: ambiguous: maybe changes hint wording\n' });
  await until(() => f.flow(flow).active_lead?.kind === 'ambiguity', 15_000);
  const ambLead = f.flow(flow).active_lead.job;
  assert.equal(f.job(ambLead).role, 'lead');

  // Home displays held item while service is running.
  const now = Date.now(), portfolio = await new HomePortfolioCollector(f.home).read([], {}, now);
  assert.deepEqual(portfolio.unattended, { objectives: ['selected'], running: 1, handbacks: 1 });
  const rows = homeRows(portfolio, 80, now, 24, false, undefined, { sorted: [], overdue: 0, today: 0 });
  assert.match(stripAnsi(rows[0].text), /Unattended · Runs: 1 · Hand-backs: 1 · selected/);
  assert.ok(rows.every(r => visualLength(r.text) === 80));
  assert.ok(rows.some(r => stripAnsi(r.text).includes('sample/01')));

  // `off` stops the resident service without killing the live run and admits no new run.
  assert.equal(u.cmd('off').on, false);
  await until(() => !isProcAlive(pid, start), 5000);
  assert.equal(f.flow(flow).state, 'working');

  // Ambiguity lead approves sample/03 -> lands -> milestone review -> acceptance lead finishes run!
  await f.settleLead(ambLead, 'Decision: finish\nReason: Wording tweak only, no feature removed.\n');
  await until(() => f.flow(flow).tickets.find(x => x.ticket === 'sample/03')?.landed === true, 15_000);
  await u.accept(flow);
  const done = await f.end(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.match(f.git(f.root, 'show', `base:${f.ticketPath(3)}`), /\*\*Status:\*\* done/);

  // Adding a fresh ready ticket after `off` starts no new run.
  fs.writeFileSync(join(f.root, f.ticketPath(4)), goodTicket(4));
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(u.status().runs.map(r => r.flow), [flow]);

  // After run closes and service is off, held sample/01 STAYS on Home.
  const off = await new HomePortfolioCollector(f.home).read([], {}, Date.now());
  assert.equal(off.unattended, undefined);
  assert.equal(off.requests.length, 1);
  assert.match(off.requests[0].item.value, /sample\/01/);

  // Explicit owner manual `hud_land` on held item succeeds and clears the hold!
  const manualLand = await f.call('hud_land', { job: w1 });
  assert.match(manualLand.flow, /^f[0-9a-f]{16}/);
  await until(() => readJson(join(f.home, 'flows', `${manualLand.flow}.json`)).state === 'completed', 20_000);
  const afterResolve = await new HomePortfolioCollector(f.home).read([], {}, Date.now());
  assert.equal(afterResolve.requests.length, 0);
});

test('unattended deterministic gates hold spec edits and unapproved removals with zero pre-land leads; exact-SHA guard blocks tampered commits', { timeout: 60_000 }, async t => {
  const f = await setupWorkflowProject(t, {
    tickets: {
      '01-synthetic.md': goodTicket(1).replace('**Live try:** none\n', ''),
      '02-synthetic.md': goodTicket(2, { blocked: 'none' }),
    },
  });
  const u = unattended(f);
  f.onCleanup(() => u.cmd('off'));

  // Remove ticket 02 temporarily so only invalid ticket 01 exists -> diagnostic recorded, no run started.
  const t2Path = join(f.root, f.ticketPath(2)), t2Body = fs.readFileSync(t2Path, 'utf8');
  fs.unlinkSync(t2Path);
  u.cmd('on', '--objective', 'selected');
  await until(() => {
    const file = join(f.home, 'unattended-diagnostics.json');
    return fs.existsSync(file) && readJson(file).some(d => d.ticket === 'sample/01' && /missing Live try/.test(d.reason));
  }, 8_000);
  assert.deepEqual(u.status().runs, []);

  // Restore both valid tickets -> one Objective run starts.
  fs.writeFileSync(join(f.root, f.ticketPath(1)), goodTicket(1));
  fs.writeFileSync(t2Path, t2Body);
  f.git(f.root, 'add', '.scratch'); f.git(f.root, 'commit', '-qm', 'valid tickets');

  const flow = await u.findRun('selected');
  const w1 = await u.ticketJob(flow, 'sample/01');
  const w2 = await u.ticketJob(flow, 'sample/02');

  // Worker 1 modifies docs/spec.md -> deterministic spec gate holds item with zero leads.
  await f.settle(w1, { file: 'docs/spec.md', body: '# Unauthorized spec change\n', report: 'Done.\nRemoves: none\n' });
  // Worker 2 declares unapproved removal -> deterministic removal gate holds item with zero leads.
  await f.settle(w2, { report: 'Done.\nRemoves: owner-toolbar\n' });

  const done = await f.end(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(f.git(f.root, 'show', 'base:docs/spec.md'), '# Synthetic spec');
  const h1 = done.tickets.find(x => x.ticket === 'sample/01').held;
  const h2 = done.tickets.find(x => x.ticket === 'sample/02').held;
  assert.equal(h1.owner_approval, 'spec-change');
  assert.equal(h2.owner_approval, 'feature-deletion');
  assert.match(h2.reason, /Unapproved removal declared: owner-toolbar/);
  // Zero lead jobs were launched!
  const leads = fs.readdirSync(join(f.home, 'jobs'))
    .filter(id => /^j[a-f0-9]{16}$/.test(id))
    .map(f.job)
    .filter(j => j.role === 'lead');
  assert.equal(leads.length, 0);
  assert.deepEqual(u.status().handbacks.map(h => h.ticket).sort(), ['sample/01', 'sample/02']);

  // Exact-SHA guard: startLand refuses when source HEAD differs from approvedHead.
  const r2 = f.job(w2);
  const oldHead = f.git(r2.worktree.root, 'rev-parse', 'HEAD');
  fs.writeFileSync(join(r2.worktree.root, 'tamper.txt'), 'tampered\n');
  f.git(r2.worktree.root, 'add', 'tamper.txt');
  f.git(r2.worktree.root, 'commit', '-qm', 'tamper');
  // Patch approved_head to oldHead and verify startLand refuses tampered commit.
  const qPatch = f.flow(flow);
  qPatch.tickets.find(x => x.ticket === 'sample/02').approved_head = oldHead;
  writeFixtureFile(join(f.home, 'flows', `${flow}.json`), JSON.stringify(qPatch));
  await assert.rejects(
    runFile(process.execPath, [
      '--input-type=module', '-e',
      `import { startLand } from './dist/mcp/land.js';
       import { findJob } from './dist/mcp/store/job-store.js';
       const job = findJob(process.argv[1]);
       await startLand(process.env.HUD_HOME, job.job, job, 'closed', null, false, process.argv[2], undefined, process.argv[3]);`,
      w2, flow, oldHead,
    ], { env: f.env }),
    /Source changed after unattended approval/,
  );
});

test('unattended repair admits repair tickets inside the same run, bounded to 2 rounds then holds for owner; failed ticket dependents show in blocked', { timeout: 60_000 }, async t => {
  const f = await setupWorkflowProject(t, {
    tickets: {
      '01-synthetic.md': goodTicket(1),
      '02-synthetic.md': goodTicket(2, { blocked: 'none' }),
      '03-synthetic.md': goodTicket(3, { blocked: '02' }),
    },
  });
  const u = unattended(f);
  f.onCleanup(() => u.cmd('off'));
  u.cmd('on', '--objective', 'selected');

  const flow = await u.findRun('selected');
  const w1 = await u.ticketJob(flow, 'sample/01');
  const w2 = await u.ticketJob(flow, 'sample/02');

  // Ticket 01 lands cleanly; ticket 02 fails operationally -> ticket 03 shows in blocked!
  await f.settle(w1);
  writeFixtureFile(join(f.dir(w2), 'STATUS.json'), JSON.stringify({ state: 'failed', exit_reason: 'synthetic crash', ended_at: new Date().toISOString() }));

  await until(() => Boolean(f.flow(flow).review_job), 15_000);
  assert.ok(f.flow(flow).tickets.find(x => x.ticket === 'sample/02')?.failed);
  assert.ok(f.flow(flow).blocked?.some(b => b.ticket === 'sample/03'), JSON.stringify(f.flow(flow).blocked));

  // Run 2 repair rounds inside the SAME run, then 3rd repair hits the bound and holds for owner (not completed).
  let prevReview;
  let prevLead;
  for (let round = 0; round < 3; round++) {
    await until(() => f.flow(flow).review_job && f.flow(flow).review_job !== prevReview, 15_000);
    prevReview = f.flow(flow).review_job;
    await f.settleReview(prevReview);
    await until(() => f.flow(flow).active_lead?.kind === 'accept' && f.flow(flow).active_lead.job !== prevLead, 15_000);
    prevLead = f.flow(flow).active_lead.job;
    if (round < 2) {
      await f.call('hud_tickets', {
        op: 'add', cwd: f.root, feature: 'sample', objective: 'selected',
        tickets: [{ title: `Repair ${round + 1}`, blocked_by: [], what: `Fix round ${round + 1}.`, acceptance: ['Fixed'], live_try: 'none' }],
      });
    }
    await f.settleLead(prevLead, `Decision: repair\nReason: Repair round ${round + 1}.\n`);
    if (round < 2) {
      const repairTicket = `sample/0${round + 4}`;
      const rw = await u.ticketJob(flow, repairTicket);
      await f.settle(rw);
    }
  }
  const held = await f.end(flow);
  assert.equal(held.state, 'paused', JSON.stringify(held));
  assert.equal(held.repair_rounds, 2);
  assert.ok(held.held, 'run held for owner after 2 repair rounds');
  assert.match(held.held.reason, /max repair rounds \(2\) reached/);
  assert.ok(u.status().handbacks.some(h => h.flow === flow && /max repair rounds/.test(h.reason)));
});

test('to: main question hand-back auto-resumes on hud_respond and Blockers: pauses without waking main', { timeout: 45_000 }, async t => {
  const f = await setupWorkflowProject(t, { secondBlocker: 'none', count: 2 });
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

  // A Blockers: report pauses the run with empty notices (no stored no_wake) and NO wake to main.
  await f.settle(first, { report: 'Synthetic finished report.\n\nBlockers: requires spec change\n' });
  const blocked = await f.end(reply.queue_resumed);
  assert.equal(blocked.state, 'paused');
  assert.equal('no_wake' in blocked, false);
  assert.equal('pause_notice' in blocked, false);
  assert.deepEqual(blocked.notices, {});
  assert.deepEqual(blocked.handback, {
    step: 'tickets', choices: ['resume', 'stop'], kind: 'blocker', ticket: 'sample/01', job: first,
  });
  const readAfter = resultValue((await rpc('tools/call', { name: 'hud_read', arguments: { job: reply.queue_resumed } })).result);
  assert.equal(readAfter.state, 'paused');
  assert.equal(readAfter.changes, undefined);
  assert.match(readAfter.pause_notice, /Blockers:/);
});

test('workflow-runner adopts a pre-upgrade legacy q receipt without template or graph.json', { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 1 });
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

test('retention prunes expired terminal receipts and pins open held item job and receipt until hold clears', t => {
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-q-retain-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const flow = 'q000000000000000a', heldFlow = 'q000000000000000b';
  const flows = join(home, 'flows'), dir = join(flows, flow), receipt = join(flows, `${flow}.json`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'graph.json'), JSON.stringify({ version: 1, name: 'ticket-queue' }));
  fs.writeFileSync(receipt, JSON.stringify({ flow, state: 'completed' }));
  fs.writeFileSync(`${receipt}.noticed`, '');
  const ticketFile = join(home, '01-held.md');
  fs.writeFileSync(ticketFile, goodTicket(1));
  const heldReceipt = join(flows, `${heldFlow}.json`);
  fs.writeFileSync(heldReceipt, JSON.stringify({
    flow: heldFlow, root: home, feature: 'selected', state: 'completed',
    unattended: { objective: 'selected' },
    tickets: [{ ticket: 'sample/01', path: ticketFile, role: 'imp', job: 'j0000000000000001', held: { reason: 'spec change', at: new Date().toISOString() } }],
  }));
  fs.writeFileSync(join(home, 'unattended-runs.json'), JSON.stringify([heldFlow]));
  const old = new Date(Date.now() - 48 * 3600_000);
  fs.utimesSync(receipt, old, old);
  fs.utimesSync(heldReceipt, old, old);

  // While hold is open, pinnedHeldJobs includes the held source job and pruneLandFlows keeps the held receipt.
  assert.ok(pinnedHeldJobs(home).has('j0000000000000001'));
  pruneLandFlows(home, Date.now());
  assert.equal(fs.existsSync(receipt), false);
  assert.equal(fs.existsSync(`${receipt}.noticed`), false);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.existsSync(heldReceipt), true);

  // Once the ticket is closed (wontfix), hold clears -> job is unpinned and unindexed receipt can be pruned.
  fs.writeFileSync(ticketFile, goodTicket(1, { status: 'wontfix' }));
  assert.equal(pinnedHeldJobs(home).has('j0000000000000001'), false);
  fs.writeFileSync(join(home, 'unattended-runs.json'), JSON.stringify([]));
  pruneLandFlows(home, Date.now());
  assert.equal(fs.existsSync(heldReceipt), false);
});
