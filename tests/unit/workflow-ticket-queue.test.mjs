import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { isProcAlive, procStat, readBootId, readProcEnviron } from '../../dist/utils/proc.js';
import { HomePortfolioCollector } from '../../dist/collectors/home-portfolio.js';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { readMachineWork } from '../../dist/collectors/work-summary-snapshot.js';
import { reportSignature } from '../../dist/roles/cli-turn.js';
import { homeRows } from '../../dist/render/home-view.js';
import { initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { machineWorkForms } from '../../dist/render/work-summary.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { loadGraph } from '../../dist/workflows/graph.js';
import { taskNoticeSource, workflowEvents } from '../../dist/workflows/events.js';
import { permissionStatus } from '../../dist/mcp/worker-permissions.js';
import { pruneLandFlows } from '../../dist/runtime/work-retention.js';
import { MAX_TICKET_BYTES, readJsonTicketFeature, serializeTicketFeature, ticketFeaturePath } from '../../dist/tickets/store.js';
import { pinnedQueueJobs, readOpenHolds } from '../../dist/unattended/state.js';
import { stopChild } from '../helpers/process-cleanup.mjs';
import { fallbackRole, resultValue, rpcClient, until } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { collectDeliveredNotices, goodTicket, readJson, setupWorkflowProject } from '../helpers/workflow-ticket-project.mjs';

const runner = resolve('packages/hud-mcp/bin/workflow-runner.mjs');
const sonicEntry = resolve('packages/hud-mcp/bin/hud-sonic.mjs');
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
  assert.equal(initial.tickets[0].round, 0);
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
  assert.equal(f.job(reviewJob).reviewed, undefined);
  const reviewHead = f.git(f.root, 'rev-parse', 'HEAD');
  assert.notEqual(reviewHead, initial.start_head);
  await f.settleReview(reviewJob);

  await until(() => f.flow(flow).active_lead?.kind === 'accept', 15_000);
  assert.deepEqual(f.flow(flow).reviews[0].reviewed, { base: initial.start_head, head: reviewHead });
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
  assert.equal(f.ticketRecord(1, 'sample', 'base')?.status, 'done');
});

for (const mode of ['ordinary', 'unattended']) {
  test(`${mode} ticket queue waits for native permissions and lands after auto-approval`, { timeout: 35_000 }, async t => {
    const f = await setupWorkflowProject(t, { count: 1, fixtureOptions: {
      clockScale: 1, watcherTickMs: 350,
      onPermissionKeys: () => fs.unlinkSync(join(f.env.HOME, 'cli-blocked')),
    } });
    fs.chmodSync(f.home, 0o700);
    fallbackRole(f, 'imp', [{ harness: 'cli', agent: 'claude', model: 'synthetic-claude' }]);
    const hold = name => writeFixtureFile(join(f.env.HOME, name), '');
    const release = name => fs.unlinkSync(join(f.env.HOME, name));
    hold('hold-turn');
    hold('missing-report');
    const u = mode === 'unattended' ? unattended(f) : undefined;
    if (u) { f.onCleanup(() => u.cmd('off')); u.cmd('on', '--objective', 'selected'); }
    const flow = u ? await u.findRun('selected') : (await f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root })).flow;
    const [job] = await f.jobs(flow, 1), dir = f.dir(job);
    const statusFile = join(dir, 'STATUS.json');
    const status = () => fs.existsSync(statusFile) ? readJson(statusFile) : {};
    const active = () => permissionStatus(dir).active;
    const watcherReads = () => f.socketRequests.filter(req => req.method === 'pane.read' && req.params.source === 'visible').length;
    const keys = () => f.socketRequests.filter(req => req.method === 'pane.send_keys').map(req => req.params.keys);
    const stillWorking = () => {
      const queue = f.flow(flow);
      assert.equal(queue.state, 'working', JSON.stringify(queue));
      assert.equal(queue.tickets[0].failed, undefined);
      assert.equal(queue.tickets[0].held, undefined);
    };
    await until(() => status().state === 'working' && status().supervisor_pid, 6000)
      .catch(error => { throw Error(`${error.message}: ${JSON.stringify({ status: status(), job: f.job(job), queue: f.flow(flow) })}`); });
    const blockWhileWatching = async text => {
      const before = watcherReads();
      hold('pane-read-timeout');
      writeFixtureFile(join(f.env.HOME, 'pane-read'), text);
      hold('cli-blocked');
      await until(() => status().blocked && watcherReads() > before, 6000);
      await delay(300, undefined, { signal: t.signal }); // Let the queue sample the block before releasing the watcher.
      assert.equal(active(), undefined);
      stillWorking();
      release('pane-read-timeout');
    };
    const menu = command => `Bash command\n${command}\nDo you want to proceed?\n❯ 1. Yes\n2. No\nEsc to cancel`;
    const boxed = command => `╭─────────────────╮\n${menu(command)}\n╰─────────────────╯`;
    await blockWhileWatching(`${boxed('pwd')}\n${boxed('git status -s')}`);
    await until(() => active()?.action === 'main', 6000);
    const entry = active();
    assert.equal(entry.outcome, 'pending');
    assert.deepEqual(entry.options, []);
    // Age the same block past the 45 s grace and wake the queue without waiting it out.
    const blockedAt = new Date(Date.now() - 60_000).toISOString();
    const reads = watcherReads();
    writeFixtureFile(statusFile, JSON.stringify({ ...status(), blocked_at: blockedAt }));
    await until(() => watcherReads() > reads + 1, 6000);
    assert.equal(status().blocked_at, blockedAt);
    assert.equal(status().blocked, true);
    assert.deepEqual(readJson(join(dir, 'permissions.json')).entries, [entry]);
    assert.deepEqual(keys(), []);
    if (u) {
      await until(() => f.flow(flow).notices[`handback-${entry.id}`], 6000);
      assert.deepEqual(workflowEvents(f.home, null, false, tmpdir()).lines, []);
      const notices = taskNoticeSource(f.home, f.env.HERDR_PANE_ID, f.root)();
      assert.equal(notices.length, 1);
      assert.ok(notices[0].line.includes(`Open pane ${entry.pane}`), notices[0].line);
      assert.doesNotMatch(notices[0].line, /hud_respond/);
      assert.deepEqual(workflowEvents(f.home, f.env.HERDR_PANE_ID, false, f.root).lines, []);
    }
    stillWorking();

    release('cli-blocked'); // Simulate main resolving the manual menu in the pane.
    await until(() => !status().blocked && !active(), 6000);
    const scratch = join(dir, 'scratchpad');
    fs.mkdirSync(scratch);
    await blockWhileWatching(menu(`rm -f ${scratch}/*.png`));
    await until(() => permissionStatus(dir).latest?.outcome === 'answered', 6000);
    assert.deepEqual(keys(), [['Enter']]);
    stillWorking();

    const root = f.job(job).worktree.root;
    writeFixtureFile(join(root, 'synthetic.txt'), 'Synthetic implementation.\n');
    f.git(root, 'add', 'synthetic.txt');
    f.git(root, 'commit', '-qm', 'synthetic implementation');
    writeFixtureFile(join(dir, 'report.md'), 'Synthetic finished report.\nRemoves: none\n');
    const { seq, sent_at } = readJson(join(dir, 'turn.json'));
    writeFixtureFile(join(dir, 'done.json'), JSON.stringify({ seq, sent_at, report_sig: reportSignature(dir), at: new Date().toISOString() }));
    release('hold-turn');
    await until(() => f.flow(flow).tickets[0].landed, 12_000);
    assert.equal(f.git(f.root, 'show', 'base:synthetic.txt'), 'Synthetic implementation.');
    if (u) await u.accept(flow);
    else {
      await until(() => f.flow(flow).review_job, 6000);
      await f.settleReview(f.flow(flow).review_job);
      await until(() => f.flow(flow).active_lead?.kind === 'accept', 6000);
      await f.settleLead(f.flow(flow).active_lead.job);
    }
    assert.equal((await f.end(flow)).state, 'completed');
  });
}

for (const mode of ['bound', 'paneless']) {
  test(`${mode} queue-owned land repair waits for native permission prompts, delivers notice for repair job ID, and lands`, { timeout: 45_000 }, async t => {
    const f = await setupWorkflowProject(t, { count: 1, fixtureOptions: {
      clockScale: 1, watcherTickMs: 350,
      onPermissionKeys: () => fs.unlinkSync(join(f.env.HOME, 'cli-blocked')),
    } });
    fs.chmodSync(f.home, 0o700);
    // Gate fails until the repair worker writes "fixed" to synthetic.txt.
    fs.writeFileSync(join(f.root, '.hud/project.json'), JSON.stringify({
      land: { base: 'base', gate: ['grep -q fixed synthetic.txt'], after: [], push: false },
    }));
    f.git(f.root, 'add', '.hud/project.json');
    f.git(f.root, 'commit', '-qm', 'require fixed in land gate');
    fallbackRole(f, 'imp', [{ harness: 'cli', agent: 'claude', model: 'synthetic-claude' }]);

    const hold = name => writeFixtureFile(join(f.env.HOME, name), '');
    const release = name => { try { fs.unlinkSync(join(f.env.HOME, name)); } catch {} };
    hold('hold-turn');
    hold('missing-report');
    let flow;
    if (mode === 'paneless') {
      const env = { ...f.env };
      delete env.HERDR_PANE_ID;
      const started = execFileSync(process.execPath, [
        '--input-type=module', '-e',
        `import { startTicketQueue } from ${JSON.stringify(resolve('dist/mcp/ticket-queue.js'))};
        const q = await startTicketQueue(process.env.HUD_HOME, process.argv[1], null, false, { feature: 'sample', max_parallel: 1 });
        console.log(JSON.stringify({ flow: q.flow }));`,
        f.root,
      ], { env, encoding: 'utf8' });
      ({ flow } = JSON.parse(started));
    } else {
      ({ flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', cwd: f.root }));
    }
    const [job] = await f.jobs(flow, 1), dir = f.dir(job);
    await until(() => fs.existsSync(join(dir, 'STATUS.json')) && readJson(join(dir, 'STATUS.json')).state === 'working', 6000);

    // Mark source as tier: 'light' so dispatchLandRepair spawns a replacement repair job ID (repairId !== job).
    const srcJob = readJson(join(dir, 'job.json'));
    writeFixtureFile(join(dir, 'job.json'), JSON.stringify({
      ...srcJob,
      route: { tier: 'light', mode: 'single', reason: 'synthetic', source: 'default' },
    }));
    const wtRoot = f.job(job).worktree.root;
    writeFixtureFile(join(wtRoot, 'synthetic.txt'), 'Initial draft.\n');
    f.git(wtRoot, 'add', 'synthetic.txt');
    f.git(wtRoot, 'commit', '-qm', 'initial draft');
    writeFixtureFile(join(dir, 'report.md'), 'Synthetic initial report.\nRemoves: none\n');
    const { seq, sent_at } = readJson(join(dir, 'turn.json'));
    writeFixtureFile(join(dir, 'done.json'), JSON.stringify({ seq, sent_at, report_sig: reportSignature(dir), at: new Date().toISOString() }));
    release('hold-turn');
    await until(() => ['idle_grace', 'done', 'closed'].includes(readJson(join(dir, 'STATUS.json')).state), 10_000);

    // Hold the replacement repair worker turn so we can drive native permission prompts during repairLand.
    hold('hold-turn');
    let landId, repairId;
    await until(() => {
      const q = f.flow(flow);
      landId = q.tickets[0]?.land;
      if (!landId || !fs.existsSync(join(f.home, 'flows', `${landId}.json`))) return false;
      const land = readJson(join(f.home, 'flows', `${landId}.json`));
      repairId = land.repairs?.at(-1)?.job;
      return Boolean(repairId && repairId !== job);
    }, 15_000);

    const repairDir = f.dir(repairId);
    const repairStatusFile = join(repairDir, 'STATUS.json');
    const repairStatus = () => fs.existsSync(repairStatusFile) ? readJson(repairStatusFile) : {};
    const landState = () => readJson(join(f.home, 'flows', `${landId}.json`));
    const active = () => permissionStatus(repairDir).active;
    const watcherReads = () => f.socketRequests.filter(req => req.method === 'pane.read' && req.params.source === 'visible').length;
    const keys = () => f.socketRequests.filter(req => req.method === 'pane.send_keys').map(req => req.params.keys);
    await until(() => repairStatus().state === 'working' && repairStatus().supervisor_pid, 8_000);

    const menu = command => `Bash command\n${command}\nDo you want to proceed?\n❯ 1. Yes\n2. No\nEsc to cancel`;
    const boxed = command => `╭─────────────────╮\n${menu(command)}\n╰─────────────────╯`;

    // 1. Repair worker hits a native permission block before watcher classifies it: repairLand must wait across multiple 250ms polls.
    const readsBefore = watcherReads();
    hold('pane-read-timeout');
    writeFixtureFile(join(f.env.HOME, 'pane-read'), `${boxed('pwd')}\n${boxed('git status -s')}`);
    hold('cli-blocked');
    await until(() => repairStatus().blocked && watcherReads() > readsBefore, 6_000);
    await delay(650, undefined, { signal: t.signal });
    assert.equal(active(), undefined);
    assert.equal(landState().state, 'running', JSON.stringify(landState()));
    assert.equal(f.flow(flow).state, 'working');
    assert.equal(f.flow(flow).tickets[0].failed, undefined);
    release('pane-read-timeout');

    // 2. Watcher classifies manual permission on repairId: land step reflects permission ID and notice names repairId.
    await until(() => active()?.action === 'main', 6_000);
    const entry = active();
    assert.equal(entry.outcome, 'pending');
    await until(() => landState().step === `repair 1: waiting for main (${entry.id})`, 6_000);
    assert.equal(landState().state, 'running');
    if (mode === 'paneless') {
      await until(() => f.flow(flow).notices[`handback-${entry.id}`], 6_000);
      const notice = f.flow(flow).notices[`handback-${entry.id}`];
      assert.ok(notice.includes(repairId), `expected repair job ID ${repairId} in notice: ${notice}`);
      const delivered = taskNoticeSource(f.home, f.env.HERDR_PANE_ID, f.root)();
      assert.equal(delivered.length, 1);
      assert.ok(delivered[0].line.includes(repairId));
      assert.ok(delivered[0].line.includes(`Open pane ${entry.pane}`));
    } else {
      await until(() => fs.existsSync(join(repairDir, `${entry.id}.noticed`)), 6_000);
    }

    // 3. Resolve manual menu, then hit an auto-approvable prompt on the repair worker -> watcher auto-approves and repair stays running.
    release('cli-blocked');
    await until(() => !repairStatus().blocked && !active(), 6_000);
    const scratch = join(repairDir, 'scratchpad');
    fs.mkdirSync(scratch);
    const readsBeforeAuto = watcherReads();
    hold('pane-read-timeout');
    writeFixtureFile(join(f.env.HOME, 'pane-read'), menu(`rm -f ${scratch}/*.png`));
    hold('cli-blocked');
    await until(() => repairStatus().blocked && watcherReads() > readsBeforeAuto, 6_000);
    await delay(550, undefined, { signal: t.signal });
    assert.equal(landState().state, 'running');
    release('pane-read-timeout');
    await until(() => permissionStatus(repairDir).latest?.outcome === 'answered', 6_000);
    assert.deepEqual(keys(), [['Enter']]);
    assert.equal(landState().state, 'running');

    // 4. Repair commits the fix and settles -> land re-triages and lands cleanly!
    writeFixtureFile(join(wtRoot, 'synthetic.txt'), 'fixed\n');
    f.git(wtRoot, 'add', 'synthetic.txt');
    f.git(wtRoot, 'commit', '-qm', 'apply repair fix');
    writeFixtureFile(join(repairDir, 'report.md'), 'Synthetic repair report.\nRemoves: none\n');
    const rTurn = readJson(join(repairDir, 'turn.json'));
    writeFixtureFile(join(repairDir, 'done.json'), JSON.stringify({ seq: rTurn.seq, sent_at: rTurn.sent_at, report_sig: reportSignature(repairDir), at: new Date().toISOString() }));
    release('hold-turn');

    await until(() => f.flow(flow).tickets[0].landed, 20_000);
    assert.equal(f.git(f.root, 'show', 'base:synthetic.txt'), 'fixed');
    await until(() => f.flow(flow).review_job, 8_000);
    await f.settleReview(f.flow(flow).review_job);
    await until(() => f.flow(flow).active_lead?.kind === 'accept', 8_000);
    await f.settleLead(f.flow(flow).active_lead.job);
    assert.equal((await f.end(flow)).state, 'completed');
  });
}

test('unattended Objective run lands tickets in one run (N + 2 sessions), records durable owner-try acceptance, and wakes on fs watch for next run', { timeout: 60_000 }, async t => {
  const f = await setupWorkflowProject(t, {
    tickets: {
      '01-synthetic.md': goodTicket(1, { ownerTry: 'yes', approvedRemovals: 'legacy-banner' }),
      '02-synthetic.md': goodTicket(2, { blocked: '01' }).replace('**Live try:** none\n', '').replace('- [ ] Checked', '- [ ] Checked\n- [ ] Live try: none'),
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
  assert.equal(fs.existsSync(join(f.home, 'flows')), false, 'first admission creates the flow directory after watch startup');
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
  assert.equal(f.job(w1).caller_pane, undefined);
  const session = Object.fromEntries(fs.readFileSync(join(f.dir(w1), 'SESSION.txt'), 'utf8').trimEnd().split('\n').map(line => line.split('=')));
  const workerEnv = readProcEnviron(Number(session.PID));
  assert.equal(workerEnv.HERDR_PANE_ID, session.LEFT);
  assert.equal(workerEnv.HERDR_TAB_ID, session.TAB);
  assert.notEqual(workerEnv.HERDR_PANE_ID, f.env.HERDR_PANE_ID);
  const sonic = (...args) => runFile(process.execPath, [sonicEntry, ...args, '--dir', f.dir(w1)], {
    cwd: f.job(w1).cwd, env: workerEnv, timeout: 15_000,
  });
  const child = (await sonic('start', '--task', 'Inspect synthetic input.')).stdout.trim();
  assert.equal(f.job(child).parent_job, w1);
  assert.equal(f.job(child).caller_pane, session.LEFT);
  assert.match((await sonic('wait', '--job', child, '--timeout', '10')).stdout, /Synthetic implementation report/);

  // Brief asks for Removes: declaration.
  assert.match(fs.readFileSync(join(f.dir(w1), 'brief.md'), 'utf8'), /Removes:/);
  // Named removal matching ticket Approved removals: passes deterministically without pre-land lead!
  await f.settle(w1, { report: 'Synthetic finished.\nRemoves: legacy-banner\n' });
  await until(() => f.flow(flow1).tickets.find(x => x.ticket === 'sample/01')?.landed === true, 15_000);
  // Owner try: yes landed as ready-for-human until lead acceptance.
  assert.equal(f.ticketRecord(1, 'sample', 'base')?.status, 'ready-for-human');

  const w2 = await u.ticketJob(flow1, 'sample/02');
  await f.settle(w2, { report: 'Synthetic finished.\n- **Blockers:** NoNe!\nRemoves: NONE;\n' });
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

  // Durable acceptance recorded on landed Owner try: yes ticket (status done + accepted receipt).
  const accepted = f.ticketRecord(1);
  assert.equal(accepted?.status, 'done');
  assert.equal(accepted?.accepted?.flow, flow1);
  assert.equal(accepted?.accepted?.verdict, 'finish: Verified both slices cleanly.');
  assert.equal(f.git(f.root, 'log', '-1', '--format=%s'), 'tickets: sample/01 accept');
  assert.deepEqual(f.git(f.root, 'show', '--format=', '--name-only', 'HEAD').split('\n'), ['.hud/tickets/sample.json']);
  assert.equal(f.git(f.root, 'status', '--porcelain', '--', '.hud/tickets'), '');

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

test('a headless worker without an orchestrator pane can start and collect Sonic', { timeout: 25_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 0 });
  const job = 'j0000000000000001', dir = f.dir(job);
  fs.mkdirSync(dir, { recursive: true });
  writeFixtureFile(join(dir, 'job.json'), JSON.stringify({ job, role: 'imp', cwd: f.root, headless: true }));
  const env = { ...f.env, HUD_JOB_DIR: dir };
  delete env.HERDR_PANE_ID;
  const sonic = (...args) => runFile(process.execPath, [sonicEntry, ...args, '--dir', dir], { cwd: f.root, env, timeout: 15_000 });
  const child = (await sonic('start', '--task', 'Inspect synthetic input.')).stdout.trim();
  assert.equal(f.job(child).parent_job, job);
  assert.equal(f.job(child).caller_pane, undefined);
  assert.match((await sonic('wait', '--job', child, '--timeout', '10')).stdout, /Synthetic implementation report/);
});

test('unattended on preflights land fields and trust for the lead and imp pool before writing control', { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 0 });
  const enable = () => runFile(process.execPath, [resolve('bin/hud'), 'unattended', 'on', '--objective', 'selected'], {
    cwd: f.root, env: f.env, timeout: 15_000,
  });
  const config = join(f.root, '.hud', 'project.json'), { land } = readJson(config);
  for (const [field, value] of Object.entries({ base: '-bad', gate: [''], after: undefined, push: 'no', wrapper: 3, timeout_s: 0 })) {
    writeFixtureFile(config, JSON.stringify({ land: { ...land, [field]: value } }));
    await assert.rejects(enable(), error => error.code === 2 && error.stderr.includes(`land.${field} must be`));
  }
  writeFixtureFile(config, JSON.stringify({ land }));
  // Remove the reviewer's agy fallback: agy is now reachable only through imp's even pool.
  const roles = join(f.root, '.hud', 'roles');
  fs.mkdirSync(roles);
  writeFixtureFile(join(roles, 'reviewer.json'), JSON.stringify({ role: 'reviewer', can_continue: false, run: [{ harness: 'pi', pi_role: 'reviewer' }] }));
  writeFixtureFile(f.env.HUD_SETTINGS_PATH, JSON.stringify({ impPlacement: 'even', impEvenPool: ['hydrogen'] }));
  const agy = join(f.env.HOME, '.gemini', 'antigravity-cli', 'settings.json');
  const claude = join(f.env.CLAUDE_CONFIG_DIR, '.claude.json');
  const claudeGrant = fs.readFileSync(claude, 'utf8');
  writeFixtureFile(agy, '{}');
  writeFixtureFile(claude, '{}');
  await assert.rejects(enable(), error => error.code === 2 &&
    error.stderr.includes('not trusted for: agy, claude') && error.stderr.trimEnd().endsWith(`\nhud trust ${f.root}`));
  assert.equal(fs.readFileSync(claude, 'utf8'), '{}');

  // Restore the shipped reviewer fallback and disable imp routing: standby agy still needs trust.
  fs.unlinkSync(join(roles, 'reviewer.json'));
  writeFixtureFile(f.env.HUD_SETTINGS_PATH, JSON.stringify({ impPlacement: 'fixed' }));
  writeFixtureFile(claude, claudeGrant);
  await assert.rejects(enable(), error => error.code === 2 && error.stderr.includes(`not trusted for: agy\nhud trust ${f.root}`));
  assert.equal(fs.readFileSync(agy, 'utf8'), '{}');
  assert.equal(fs.existsSync(join(f.home, 'unattended.json')), false);
  assert.equal(unattended(f).status().on, false);
});

test('unattended on preflights the frontend role for selected Objectives only', { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 0, extraFeatures: {
    detached: { '01-synthetic.md': goodTicket(1, { objective: 'selected' })
      .replace('**Blocked by:** none', '**Blocked by:** none\n**Role:** frontend-imp') },
  } });
  const config = join(f.root, '.hud', 'project.json');
  writeFixtureFile(config, JSON.stringify({ ...readJson(config), roles: ['imp', 'reviewer', 'lead'] }));
  await assert.rejects(runFile(process.execPath, [resolve('bin/hud'), 'unattended', 'on', '--objective', 'selected'], {
    cwd: f.root, env: f.env, timeout: 15_000,
  }), error => error.code === 2 && /frontend-imp.*Run `hud setup` to enable frontend-imp/.test(error.stderr));
  assert.equal(fs.existsSync(join(f.home, 'unattended.json')), false);
  assert.equal(fs.existsSync(join(f.home, 'flows')), false);
  assert.equal(fs.existsSync(join(f.home, 'jobs')), false);

  const u = unattended(f);
  f.onCleanup(() => u.cmd('off'));
  assert.deepEqual(u.cmd('on', '--objective', 'other').objectives, ['other']);
});

test('unattended holds an item whose imp dispatch refuses trust after preflight', { timeout: 30_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 0 });
  const roles = join(f.root, '.hud', 'roles');
  fs.mkdirSync(roles);
  writeFixtureFile(join(roles, 'imp.json'), JSON.stringify({ role: 'imp', instructions: 'implementer', can_continue: true, run: [{ harness: 'cli', agent: 'agy' }] }));
  const u = unattended(f);
  f.onCleanup(() => u.cmd('off'));
  u.cmd('on', '--objective', 'selected');
  writeFixtureFile(join(f.env.HOME, '.gemini', 'antigravity-cli', 'settings.json'), '{}');
  f.writeJsonTicket(1);
  const flow = await u.findRun('selected');
  const job = await u.ticketJob(flow, 'sample/01');
  const done = await f.end(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(readJson(join(f.dir(job), 'STATUS.json')).exit_reason, 'untrusted_cwd');
  assert.equal(done.tickets[0].failed, undefined);
  assert.equal(done.tickets[0].held.kind, 'dispatch');
  assert.ok(u.status().handbacks.some(h => h.job === job && h.reason.includes(`hud trust ${f.root}`)));
});

test('unattended does not reap a question lead that never started', { timeout: 35_000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 1 });
  const u = unattended(f);
  f.onCleanup(() => u.cmd('off'));
  u.cmd('on', '--objective', 'selected');
  const flow = await u.findRun('selected');
  const worker = await u.ticketJob(flow, 'sample/01');
  writeFixtureFile(join(f.env.CLAUDE_CONFIG_DIR, '.claude.json'), '{}');
  writeFixtureFile(join(f.dir(worker), 'qa', 'q1.md'), '# Question q1\n\nChoose a synthetic path.\n');
  const done = await f.end(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  const lead = fs.readdirSync(join(f.home, 'jobs')).filter(id => /^j[a-f0-9]{16}$/.test(id)).map(f.job).find(j => j.role === 'lead');
  assert.equal(readJson(join(f.dir(lead.job), 'STATUS.json')).exit_reason, 'untrusted_cwd');
  assert.equal(fs.existsSync(join(f.dir(lead.job), 'SESSION.txt')), false);
  assert.ok(!f.fakeLog().some(c => c.command === 'hud-reap' && c.args[0] === f.dir(lead.job)));
  assert.equal(done.unclosed_leads, undefined);
  assert.match(done.tickets[0].held.reason, /question lead failed.*hud trust/);
  assert.ok(done.tickets[0].held.reason.includes(`hud_respond job=${worker} request_id=q1`));
});

for (const step of ['review', 'accept']) {
  test(`unattended ${step} escalation does not offer a replaying queue resume`, { timeout: 45_000 }, async t => {
    const f = await setupWorkflowProject(t, { count: 1, tickets: { '01-synthetic.md': goodTicket(1, { ownerTry: 'yes' }) } });
    const u = unattended(f);
    f.onCleanup(() => u.cmd('off'));
    u.cmd('on', '--objective', 'selected');
    const flow = await u.findRun('selected');
    await f.settle(await u.ticketJob(flow, 'sample/01'));
    const report = 'Decision: escalate\nReason: The owner needs to pick a layout.\n';
    let reviewer;
    if (step === 'review') {
      await until(() => Boolean(f.flow(flow).review_job), 15_000);
      reviewer = f.flow(flow).review_job;
      writeFixtureFile(join(f.dir(reviewer), 'qa', 'q1.md'), '# Question q1\n\nWhich synthetic layout should ship?\n');
      await until(() => f.flow(flow).active_lead?.kind === 'question', 15_000);
      await f.settleLead(f.flow(flow).active_lead.job, report);
    } else {
      await u.accept(flow, report);
    }

    const paused = await f.end(flow);
    assert.equal(paused.state, 'paused');
    assert.equal(paused.handback.step, step);
    assert.doesNotMatch(paused.notices['pause-0'], /answer=<resume/);
    const rejected = await f.call('hud_respond', { job: flow, answer: 'resume' });
    assert.equal(rejected.ok, false);
    if (reviewer) {
      const target = `hud_respond job=${reviewer} request_id=q1`;
      assert.deepEqual(paused.handback.choices, []);
      assert.ok(paused.notices['pause-0'].includes(target));
      assert.ok(rejected.error.includes(target));
      const response = await f.call('hud_respond', { job: reviewer, request_id: 'q1', answer: 'Use the compact layout.' });
      assert.equal(response.ok, true);
      assert.equal(response.queue_resumed, undefined);
      assert.equal(fs.readFileSync(join(f.dir(reviewer), 'qa', 'q1.answer.md'), 'utf8'), 'Use the compact layout.');
    } else {
      assert.deepEqual(paused.handback.choices, ['manual']);
      assert.equal(paused.handback.question, undefined);
      assert.doesNotMatch(paused.notices['pause-0'], /Answer the worker/);
    }
    assert.equal(f.flow(flow).state, 'paused');
    assert.equal(f.flow(flow).verdict, undefined);
    assert.equal(f.ticketRecord(1).status, 'ready-for-human');
  });
}

test('unattended reserves a paused Objective and does not re-admit its failed job under another Objective', { timeout: 35_000 }, async t => {
  const f = await setupWorkflowProject(t, { tickets: {
    '01-synthetic.md': goodTicket(1, { objective: 'other' }),
    '02-synthetic.md': goodTicket(2),
    '03-synthetic.md': goodTicket(3, { objective: 'other' }),
  } });
  const paused = 'q0000000000000001', job = 'j0000000000000001', at = new Date().toISOString();
  fs.mkdirSync(join(f.home, 'flows'), { recursive: true });
  fs.mkdirSync(f.dir(job), { recursive: true });
  writeFixtureFile(join(f.dir(job), 'job.json'), JSON.stringify({
    job, role: 'imp', cwd: f.root, ticket: 'sample/01', ticket_queue: paused, created_at: at, dispatch_exit_code: 1,
  }));
  writeFixtureFile(join(f.dir(job), 'STATUS.json'), JSON.stringify({ state: 'failed', exit_reason: 'synthetic failure', ended_at: at }));
  writeFixtureFile(join(f.home, 'flows', `${paused}.json`), JSON.stringify({
    flow: paused, root: f.root, feature: 'selected', pane: '', task: false, max_parallel: 1,
    created_at: at, updated_at: at, state: 'paused', unattended: { objective: 'selected' },
    tickets: [{ ticket: 'sample/01', path: join(f.root, f.ticketPath(1)), job, failed: { reason: 'synthetic failure', at } }],
  }));
  writeFixtureFile(join(f.home, 'unattended-runs.json'), JSON.stringify([paused]));
  const u = unattended(f);
  f.onCleanup(() => u.cmd('off'));
  u.cmd('on', '--objective', 'selected', '--objective', 'other');
  const other = await u.findRun('other');
  assert.ok(await u.ticketJob(other, 'sample/03'));
  assert.deepEqual(u.status().runs.map(({ flow, state }) => [flow, state]), [[paused, 'paused'], [other, 'working']]);
  assert.deepEqual(f.flow(other).tickets.map(t => t.ticket), ['sample/03']);
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
  const frame = renderMonitor({ state: initialMonitorState(), homePortfolio: portfolio, width: 80, height: 24, nowMs: now });
  assert.ok((frame.workboard.requests ?? []).some(r => stripAnsi(r.text).includes('sample/01')));

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
  assert.equal(f.ticketRecord(3, 'sample', 'base')?.status, 'done');

  // Adding a fresh ready ticket after `off` starts no new run.
  await f.call('hud_tickets', {
    op: 'add', feature: 'sample', cwd: f.root,
    tickets: [{ title: 'Synthetic 4', blocked_by: [], what: 'Synthetic change 4', acceptance: ['Checked'], live_try: 'none' }],
  });
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
    return fs.existsSync(file) && readJson(file).some(d => d.ticket === 'sample/01' && d.reason.includes('`**Live try:** none`'));
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

  // The approval fence rejects a changed source head even when the report is unchanged.
  const r2 = f.job(w2);
  const oldHead = f.git(r2.worktree.root, 'rev-parse', 'HEAD');
  fs.writeFileSync(join(r2.worktree.root, 'tamper.txt'), 'tampered\n');
  f.git(r2.worktree.root, 'add', 'tamper.txt');
  f.git(r2.worktree.root, 'commit', '-qm', 'tamper');
  // Patch approved_head to oldHead and verify startLand refuses tampered commit.
  const qPatch = f.flow(flow);
  const approval = { head: oldHead, report_sig: reportSignature(f.dir(w2)), job: w2 };
  Object.assign(qPatch.tickets.find(x => x.ticket === 'sample/02'), { approved_head: approval.head, approved_report_sig: approval.report_sig });
  writeFixtureFile(join(f.home, 'flows', `${flow}.json`), JSON.stringify(qPatch));
  await assert.rejects(
    runFile(process.execPath, [
      '--input-type=module', '-e',
      `import { startLand } from './dist/mcp/land.js';
       import { findJob } from './dist/mcp/store/job-store.js';
       const job = findJob(process.argv[1]);
       await startLand(process.env.HUD_HOME, job.job, job, 'closed', null, false, process.argv[2], undefined, JSON.parse(process.argv[3]));`,
      w2, flow, JSON.stringify(approval),
    ], { env: f.env }),
    /Source commit or report changed after approval/,
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
      assert.equal(f.flow(flow).tickets.find(x => x.job === rw).round, round + 1);
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

test('to: main question hand-back auto-resumes on hud_respond; the successor can be cancelled by run ID', { timeout: 45_000 }, async t => {
  const f = await setupWorkflowProject(t, { secondBlocker: 'none', count: 3 });
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root, handback_to: 'main' });
  const [held] = await f.jobs(flow, 1);
  await f.settle(held, { report: 'Blockers: The owner must choose whether to remove X.\n' });
  await until(() => f.flow(flow).active_lead?.kind === 'blocker', 15_000);
  const request = f.flow(flow).active_lead.job;
  await f.settleLead(request, 'Decision: escalate\nReason: Owner must choose whether to remove X.\nOwner approval: feature-deletion\n');
  const [, independent] = await f.jobs(flow, 2);
  const original = await f.call('hud_read', { job: flow });
  assert.deepEqual(await collectDeliveredNotices(f, flow, original), [
    `${flow} held sample/01: Owner must choose whether to remove X. — reply hud_respond job=${flow} request_id=${request} answer=resume`,
  ]);
  await f.settle(independent);
  const [, , first] = await f.jobs(flow, 3);
  assert.deepEqual(f.flow(flow).tickets.filter(item => item.landed).map(item => item.ticket), ['sample/02']);
  const qa = join(f.dir(first), 'qa');
  fs.mkdirSync(qa, { recursive: true });
  writeFixtureFile(join(qa, 'q1.md'), '# Question q1 from Synthetic\n\nChoose a synthetic path.\n');
  const stopped = await f.end(flow);
  assert.equal(stopped.state, 'failed');
  assert.deepEqual(stopped.handback, {
    step: 'tickets', choices: ['resume', 'stop'], kind: 'question', ticket: 'sample/03', job: first, question: 'q1',
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
  const successor = reply.queue_resumed;
  assert.equal(f.flow(flow).superseded_by, successor);
  assert.deepEqual(f.flow(successor).tickets.map(x => x.job), [held, independent, first]);
  const read = async () => resultValue((await rpc('tools/call', { name: 'hud_read', arguments: { job: successor } })).result);
  const current = await read();
  assert.equal(current.handback.request_id, request);
  // Either RPC can claim the notice, or the watcher can prompt the successor's pane.
  const changes = [...(reply.changes ?? []), ...(current.changes ?? [])];
  assert.deepEqual(await collectDeliveredNotices(f, successor, { changes }), [
    `${successor} held sample/01: Owner must choose whether to remove X. — reply hud_respond job=${successor} request_id=${request} answer=resume`,
  ]);
  assert.ok(!(await read()).changes?.some(line => line.includes('held sample/01')), 'hold notice only delivered once');
  assert.deepEqual(readOpenHolds(f.home, f.root).map(h => [h.flow, h.ticket]), [[successor, 'sample/01']]);

  await f.settle(first, { report: 'Synthetic finished report.\nBlockers: none\n' });
  await until(() => f.flow(successor).tickets[2].landed, 15_000);
  const answered = resultValue((await rpc('tools/call', {
    name: 'hud_respond', arguments: { job: successor, request_id: request, answer: 'resume: The owner made the decision.' },
  })).result);
  assert.equal(answered.ok, true);
  assert.deepEqual(readOpenHolds(f.home, f.root), []);

  const cancelled = resultValue((await rpc('tools/call', {
    name: 'hud_tickets', arguments: { op: 'run', cancel: true, run: reply.queue_resumed, cwd: f.root },
  })).result);
  assert.equal(cancelled.flow, reply.queue_resumed);
  assert.equal(cancelled.cancel_requested, true);
  assert.equal((await f.end(reply.queue_resumed)).state, 'cancelled');
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
  const at = new Date().toISOString();
  fs.writeFileSync(receipt, JSON.stringify({ flow, root: home, feature: 'sample', created_at: at, updated_at: at, state: 'completed', tickets: [] }));
  fs.writeFileSync(`${receipt}.noticed`, '');
  const ticketFile = join(home, '01-held.md');
  fs.writeFileSync(ticketFile, goodTicket(1));
  const heldReceipt = join(flows, `${heldFlow}.json`);
  fs.writeFileSync(heldReceipt, JSON.stringify({
    flow: heldFlow, root: home, feature: 'selected', created_at: at, updated_at: at, state: 'completed',
    unattended: { objective: 'selected' },
    tickets: [{ ticket: 'sample/01', path: ticketFile, role: 'imp', job: 'j0000000000000001', held: { reason: 'spec change', at: new Date().toISOString() } }],
  }));
  fs.writeFileSync(join(home, 'unattended-runs.json'), JSON.stringify([heldFlow]));
  const old = new Date(Date.now() - 48 * 3600_000);
  fs.utimesSync(receipt, old, old);
  fs.utimesSync(heldReceipt, old, old);
  const archived = () => fs.readFileSync(join(home, 'events', `${at.slice(0, 7)}.jsonl`), 'utf8')
    .trimEnd().split('\n').map(line => JSON.parse(line).flow);

  // While the hold is open, its source job is pinned and pruneLandFlows keeps the held receipt.
  assert.ok(pinnedQueueJobs(home).held.has('j0000000000000001'));
  pruneLandFlows(home, Date.now());
  assert.equal(fs.existsSync(receipt), false);
  assert.equal(fs.existsSync(`${receipt}.noticed`), false);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.existsSync(heldReceipt), true);
  assert.deepEqual(archived(), [flow]);

  // Once the ticket is closed (wontfix), hold clears -> job is unpinned and unindexed receipt can be pruned.
  fs.writeFileSync(ticketFile, goodTicket(1, { status: 'wontfix' }));
  assert.equal(pinnedQueueJobs(home).held.has('j0000000000000001'), false);
  fs.writeFileSync(join(home, 'unattended-runs.json'), JSON.stringify([]));
  pruneLandFlows(home, Date.now());
  assert.equal(fs.existsSync(heldReceipt), false);
  assert.deepEqual(archived(), [flow, heldFlow]);
});

test('unattended scope and >3 assumptions go to a temporary lead: continue lands, deletion/spec hold becomes owner hold, non-deletion hold becomes repair', { timeout: 60_000 }, async t => {
  const f = await setupWorkflowProject(t, {
    tickets: {
      '01-synthetic.md': goodTicket(1),
      '02-synthetic.md': goodTicket(2, { blocked: 'none' }),
      '03-synthetic.md': goodTicket(3, { blocked: 'none' }),
      '04-synthetic.md': goodTicket(4, { blocked: 'none' }),
      '05-synthetic.md': goodTicket(5, { blocked: 'none' }),
    },
  });
  const u = unattended(f);
  f.onCleanup(() => u.cmd('off'));
  u.cmd('on', '--objective', 'selected');

  const flow = await u.findRun('selected');
  const w1 = await u.ticketJob(flow, 'sample/01');
  const w2 = await u.ticketJob(flow, 'sample/02');

  // 1. Scope-tagged assumption -> temporary lead -> Decision: continue -> lands cleanly!
  await f.settle(w1, {
    report: 'Synthetic done.\nAssumed: scope — the requested wording replaces old text without removing the feature.\nRemoves: none\n',
  });
  await until(() => f.flow(flow).active_lead?.kind === 'assumption' && f.flow(flow).active_lead.ticket === 'sample/01', 15_000);
  const lead1 = f.flow(flow).active_lead.job;
  assert.equal(f.job(lead1).role, 'lead');
  await f.settleLead(lead1, 'Decision: continue\nReason: Wording change within current spec, no deletion.\n');
  await until(() => f.flow(flow).tickets.find(x => x.ticket === 'sample/01')?.landed === true, 15_000);
  assert.ok(f.job(lead1).reaped_at, 'assumption lead closed immediately after decision');
  assert.equal(f.flow(flow).decisions.find(d => d.job === lead1)?.worker_job, w1);

  // 2. Scope-tagged assumption -> temporary lead -> Decision: hold naming deletion -> owner hold!
  await f.settle(w2, {
    report: 'Synthetic done.\nAssumed: scope — drop legacy greeting command.\nRemoves: none\n',
  });
  await until(() => f.flow(flow).active_lead?.kind === 'assumption' && f.flow(flow).active_lead.ticket === 'sample/02', 15_000);
  const lead2 = f.flow(flow).active_lead.job;
  await f.settleLead(lead2, 'Decision: hold\nReason: Deletes the user-visible legacy greeting command.\n');
  await until(() => Boolean(f.flow(flow).tickets.find(x => x.ticket === 'sample/02')?.held), 15_000);
  const item2 = f.flow(flow).tickets.find(x => x.ticket === 'sample/02');
  assert.equal(item2.held.owner_approval, 'feature-deletion');
  assert.equal(item2.landed, undefined);
  assert.ok(f.job(lead2).reaped_at);

  const w3 = await u.ticketJob(flow, 'sample/03');
  const w4 = await u.ticketJob(flow, 'sample/04');

  // 3. More than 3 Assumed: lines -> same temporary lead path -> Decision: continue -> lands cleanly!
  await f.settle(w3, {
    report: 'Synthetic done.\nAssumed: a\nAssumed: b\nAssumed: c\nAssumed: d\nRemoves: none\n',
  });
  await until(() => f.flow(flow).active_lead?.kind === 'assumption' && f.flow(flow).active_lead.ticket === 'sample/03', 15_000);
  const lead3 = f.flow(flow).active_lead.job;
  await f.settleLead(lead3, 'Decision: continue\nReason: Four routine defaults within spec.\n');
  await until(() => f.flow(flow).tickets.find(x => x.ticket === 'sample/03')?.landed === true, 15_000);
  assert.ok(f.job(lead3).reaped_at);

  // 4. Scope-tagged assumption -> lead answers hold WITHOUT deletion/spec reason -> repair (failed item), NOT owner hold!
  await f.settle(w4, {
    report: 'Synthetic done.\nAssumed: scope — picked helper layout.\nRemoves: none\n',
  });
  await until(() => f.flow(flow).active_lead?.kind === 'assumption' && f.flow(flow).active_lead.ticket === 'sample/04', 15_000);
  const lead4 = f.flow(flow).active_lead.job;
  await f.settleLead(lead4, 'Decision: hold\nReason: Needs cleaner validation for empty inputs.\n');
  await until(() => Boolean(f.flow(flow).tickets.find(x => x.ticket === 'sample/04')?.failed), 15_000);
  const item4 = f.flow(flow).tickets.find(x => x.ticket === 'sample/04');
  assert.equal(item4.held, undefined, 'non-deletion hold must not become an owner hold');
  assert.match(item4.failed.reason, /Needs cleaner validation/);
  assert.ok(f.job(lead4).reaped_at);

  // 5. >3 Assumed: lines -> lead answers hold naming spec change -> spec-change owner hold!
  const w5 = await u.ticketJob(flow, 'sample/05');
  await f.settle(w5, {
    report: 'Synthetic done.\nAssumed: one\nAssumed: two\nAssumed: three\nAssumed: four\nRemoves: none\n',
  });
  await until(() => f.flow(flow).active_lead?.kind === 'assumption' && f.flow(flow).active_lead.ticket === 'sample/05', 15_000);
  const lead5 = f.flow(flow).active_lead.job;
  await f.settleLead(lead5, 'Decision: hold\nReason: Requires changing docs/spec.md for the output contract.\nOwner approval: spec-change\n');
  await until(() => Boolean(f.flow(flow).tickets.find(x => x.ticket === 'sample/05')?.held), 15_000);
  const item5 = f.flow(flow).tickets.find(x => x.ticket === 'sample/05');
  assert.equal(item5.held.owner_approval, 'spec-change');
  assert.equal(item5.landed, undefined);
  assert.ok(f.job(lead5).reaped_at);

  // Milestone review and accept run over landed slices and failed ticket 04.
  await u.accept(flow, 'Decision: finish\nReason: Landed slices verified.\n');
  const done = await f.end(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.deepEqual(done.tickets.filter(x => x.landed).map(x => x.ticket).sort(), ['sample/01', 'sample/03']);
  assert.deepEqual(
    u.status().handbacks.map(h => [h.ticket, h.owner_approval]).sort((a, b) => a[0].localeCompare(b[0])),
    [['sample/02', 'feature-deletion'], ['sample/05', 'spec-change']],
  );
});

test('unattended cancel stops a paused or working run without signalling, keeps holds visible, and frees the Objective', { timeout: 60_000 }, async t => {
  const f = await setupWorkflowProject(t, {
    tickets: {
      '01-synthetic.md': goodTicket(1),
      '02-synthetic.md': goodTicket(2, { blocked: 'none' }),
      '03-synthetic.md': goodTicket(3, { blocked: 'none' }),
    },
  });

  // Part 1: Cancel a paused unattended run with both an item hold and a run-level hold via `hud unattended cancel <run>`.
  const pausedFlow = 'q00000000000000c1';
  const pausedFlow2 = 'q00000000000000c2';
  const heldJob = 'j00000000000000c1';
  const at = new Date().toISOString();
  fs.mkdirSync(join(f.home, 'flows'), { recursive: true });
  fs.mkdirSync(f.dir(heldJob), { recursive: true });
  writeFixtureFile(join(f.dir(heldJob), 'job.json'), JSON.stringify({
    job: heldJob, role: 'imp', cwd: f.root, ticket: 'sample/01', ticket_queue: pausedFlow, created_at: at,
  }));
  writeFixtureFile(join(f.dir(heldJob), 'STATUS.json'), JSON.stringify({ state: 'closed', output_written: true, settled_at: at }));
  writeFixtureFile(join(f.home, 'flows', `${pausedFlow}.json`), JSON.stringify({
    flow: pausedFlow, root: f.root, project_root: f.root, feature: 'selected', pane: '', task: false, max_parallel: 1,
    created_at: at, updated_at: at, state: 'paused', reason: 'max repair rounds (2) reached',
    unattended: { objective: 'selected' },
    held: { reason: 'max repair rounds (2) reached', at, kind: 'escalate' },
    tickets: [{
      ticket: 'sample/01', path: join(f.root, f.ticketPath(1)), role: 'imp', job: heldJob,
      held: { reason: 'Unapproved removal declared: legacy-banner', at, kind: 'escalate', owner_approval: 'feature-deletion' },
    }],
  }));
  writeFixtureFile(join(f.home, 'flows', `${pausedFlow2}.json`), JSON.stringify({
    flow: pausedFlow2, root: f.root, project_root: f.root, feature: 'other', pane: '', task: false, max_parallel: 1,
    created_at: at, updated_at: at, state: 'paused', reason: 'lead escalated',
    unattended: { objective: 'other' },
    held: { reason: 'lead escalated', at, kind: 'escalate' },
    tickets: [],
  }));
  writeFixtureFile(join(f.home, 'unattended-runs.json'), JSON.stringify([pausedFlow, pausedFlow2]));

  const u = unattended(f);
  f.onCleanup(() => u.cmd('off'));
  const cancelPaused = u.cmd('cancel', pausedFlow);
  assert.equal(cancelPaused.cancelled.flow, pausedFlow);
  assert.equal(cancelPaused.cancelled.state, 'cancelled');
  assert.equal(f.flow(pausedFlow).state, 'cancelled');
  // Holds (item-level + run-level) and evidence remain visible and pinned.
  assert.ok(cancelPaused.handbacks.some(h => h.flow === pausedFlow && h.ticket === 'sample/01' && h.owner_approval === 'feature-deletion'));
  assert.ok(cancelPaused.handbacks.some(h => h.flow === pausedFlow && !h.ticket && /max repair rounds/.test(h.reason)));
  assert.ok(pinnedQueueJobs(f.home).held.has(heldJob));
  const logged = () => fs.existsSync(f.env.FAKE_LOG) ? f.fakeLog() : [];
  assert.equal(logged().some(c => c.command === 'hud-reap'), false, 'cancel never reaps or signals');

  // Also verify main's `hud_tickets run cancel` with the run id cancels a paused unattended run directly.
  const mcpCancelPaused = await f.call('hud_tickets', { op: 'run', cancel: true, run: pausedFlow2, cwd: f.root });
  assert.equal(mcpCancelPaused.flow, pausedFlow2);
  assert.equal(mcpCancelPaused.state, 'cancelled');
  assert.equal(mcpCancelPaused.cancel_requested, true);
  assert.equal(f.flow(pausedFlow2).state, 'cancelled');

  // Objective is now free: turning unattended on starts a new run for sample/02 & sample/03 (sample/01 stays excluded by its hold).
  u.cmd('on', '--objective', 'selected');
  const workingFlow = await u.findRun('selected', new Set([pausedFlow, pausedFlow2]));
  assert.notEqual(workingFlow, pausedFlow);
  const w2 = await u.ticketJob(workingFlow, 'sample/02');
  assert.ok(!f.flow(workingFlow).tickets.some(x => x.ticket === 'sample/01'), 'held ticket stays excluded');
  const workerSession = Object.fromEntries(fs.readFileSync(join(f.dir(w2), 'SESSION.txt'), 'utf8').trimEnd().split('\n').map(l => l.split('=')));
  assert.ok(isProcAlive(Number(workerSession.PID)), 'worker process running before cancel');

  // Part 2: Cancel the working unattended run from main's `hud_tickets run cancel` with the run id.
  const mcpCancel = await f.call('hud_tickets', { op: 'run', cancel: true, run: workingFlow, cwd: f.root });
  assert.equal(mcpCancel.flow, workingFlow);
  assert.equal(mcpCancel.cancel_requested, true);
  const stopped = await f.end(workingFlow);
  assert.equal(stopped.state, 'cancelled', JSON.stringify(stopped));
  // Running worker was NOT signalled or stopped, and no hud-reap ran.
  assert.equal(fs.existsSync(join(f.dir(w2), 'STATUS.json.stop-requested')), false);
  assert.equal(readJson(join(f.dir(w2), 'STATUS.json')).state, 'working');
  assert.ok(isProcAlive(Number(workerSession.PID)), 'worker process untouched by cancel');
  assert.equal(logged().some(c => c.command === 'hud-reap'), false, 'cancel never signals or reaps');
  // Holds from pausedFlow are still visible.
  assert.ok(u.status().handbacks.some(h => h.flow === pausedFlow && h.ticket === 'sample/01'));
  assert.ok(u.status().handbacks.some(h => h.flow === pausedFlow && !h.ticket));

  // Settle w2 so ticket 02 is no longer claimed by a live job, and verify Objective can start a fresh run for sample/03.
  writeFixtureFile(join(f.dir(w2), 'STATUS.json'), JSON.stringify({ state: 'closed', output_written: false, ended_at: new Date().toISOString() }));
  const nextFlow = await u.findRun('selected', new Set([pausedFlow, pausedFlow2, workingFlow]));
  assert.notEqual(nextFlow, workingFlow);
  const wNext = await u.ticketJob(nextFlow, 'sample/03');
  assert.ok(wNext);

  // Also verify `hud unattended cancel <run>` cancels a working run directly and returns cancelled state.
  const cliCancelWorking = u.cmd('cancel', nextFlow);
  assert.equal(cliCancelWorking.cancelled.flow, nextFlow);
  assert.equal(cliCancelWorking.cancelled.state, 'cancelled');
  assert.equal(f.flow(nextFlow).state, 'cancelled');
  assert.equal(fs.existsSync(join(f.dir(wNext), 'STATUS.json.stop-requested')), false);
});

test('unattended run holds with ticket ID when acceptance receipt cannot be persisted', { timeout: 60_000 }, async t => {
  const f = await setupWorkflowProject(t, { tickets: {} });
  await f.call('hud_tickets', {
    op: 'add',
    feature: 'sample',
    cwd: f.root,
    objective: 'selected',
    tickets: [{ title: 'Oversized acceptance slice', what: 'Build the slice.', acceptance: ['Check it.'], blocked_by: [], owner_try: true }],
  });
  await f.call('hud_tickets', { op: 'commit', cwd: f.root });

  const u = unattended(f);
  f.onCleanup(() => u.cmd('off'));
  u.cmd('on', '--objective', 'selected');
  const flow = await u.findRun('selected');
  const w1 = await u.ticketJob(flow, 'sample/01');
  await f.settle(w1, { report: 'Synthetic finished.\nRemoves: none\n' });
  await until(() => f.flow(flow).tickets.find(x => x.ticket === 'sample/01')?.landed === true, 15_000);

  // Pad sample.json just under 64 KiB so persisting the accepted receipt + verdict crosses the limit.
  const samplePath = ticketFeaturePath(f.root, 'sample');
  const doc = readJsonTicketFeature(f.root, 'sample');
  assert.equal(doc.tickets[0].status, 'ready-for-human');
  const baseBytes = Buffer.byteLength(serializeTicketFeature(doc));
  doc.tickets[0].what = 'x'.repeat(MAX_TICKET_BYTES - baseBytes - 40);
  const padded = serializeTicketFeature(doc);
  assert.ok(Buffer.byteLength(padded) <= MAX_TICKET_BYTES);
  fs.writeFileSync(samplePath, padded);

  await u.accept(flow, 'Decision: finish\nReason: Verified slice 1 cleanly with enough verdict text to exceed the 64 KiB cap.\n');
  await until(() => ['completed', 'paused', 'failed'].includes(f.flow(flow).state), 15_000);
  const held = f.flow(flow);
  assert.equal(held.state, 'paused', JSON.stringify(held));
  assert.equal(held.verdict, undefined);
  assert.match(held.held?.reason ?? '', /sample\/01/);
  assert.match(held.held?.reason ?? '', /exceeds 64 KiB/);
  assert.equal(held.handback?.ticket, 'sample/01');
  assert.match(held.tickets[0].held?.reason ?? '', /acceptance receipt could not be persisted/);
  assert.equal(readJsonTicketFeature(f.root, 'sample').tickets[0].accepted, undefined);
});
