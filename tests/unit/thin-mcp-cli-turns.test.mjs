import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test, { describe } from 'node:test';
import {
  workerFor,
  cardText,
  legacyFixture as fixture,
  until,
  statusQueries,
  assertCliStatus,
  writeCliRole,
  cliState,
  graceArmed,
} from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

describe('thin-mcp cli turns', { concurrency: 2 }, () => {
test('supervisor events: report then long summary, flapping, explicit continuation and rewritten report', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'event-cli', 4);
  const job = await f.call('hud_create', { role: 'event-cli', request_key: 'events', task: 'Synthetic event sequences.' });
  await until(() => cliState(job.task_dir)?.pid);
  writeFixtureFile(join(job.task_dir, 'report.md'), 'Report before the long summary.\n');
  await new Promise((r) => setTimeout(r, 750));
  assert.equal(cliState(job.task_dir).state, 'working');
  assert.equal(cliState(job.task_dir).quiet_decision, undefined);
  // Each transient done is immediately revoked. Sleeping while done could legitimately
  // exceed Grok's accelerated 2 s stability window when the test runner is descheduled.
  for (let i = 0; i < 3; i++) {
    f.push(job.job, 'done');
    f.push(job.job, 'working');
  }
  const queries = statusQueries(f, job);
  await until(() => statusQueries(f, job) > queries);
  assert.equal(cliState(job.task_dir).state, 'working');
  f.push(job.job, 'done');
  await until(() => cliState(job.task_dir)?.state === 'idle_grace');
  assert.equal(cliState(job.task_dir).output_written, true);
  assert.equal(cliState(job.task_dir).quiet_decision, undefined);
  const first = JSON.parse(fs.readFileSync(join(job.task_dir, 'turn.json')));
  const sent = await f.call('hud_send', { job: job.job, message_key: 'continue', text: 'Synthetic continuation.' });
  assert.equal(sent.sent, true);
  const second = JSON.parse(fs.readFileSync(join(job.task_dir, 'turn.json')));
  assert.equal(second.seq, first.seq + 1);
  assert.match(second.report_sig, /:/);
  await until(() => cliState(job.task_dir)?.state === 'working');
  await f.call('hud_send', { job: job.job, message_key: 'continue', text: 'Synthetic retry.' });
  assert.equal(JSON.parse(fs.readFileSync(join(job.task_dir, 'turn.json'))).seq, second.seq);
  writeFixtureFile(join(job.task_dir, 'report.md'), 'Report before the long summary.\n'); // same bytes, new signature
  await until(() => cliState(job.task_dir)?.state === 'idle_grace');
  assert.equal(cliState(job.task_dir).output_written, true);
  assert.equal(f.commands().some((c) => c.args[1] === 'prompt' && c.args[2] === 'w4E:p1'), false);
  assert.equal(f.commands().some((c) => c.args[1] === 'wait' && c.args.includes('blocked')), false);
});

test('supervisor events: a report with a missed status push settles on the safety tick', { timeout: 45000 }, async (t) => {
  // Live agy 2026-11-14: the push was never matched and a finished job stayed working for 10 minutes.
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'missed-push', 10);
  const job = await f.call('hud_create', { role: 'missed-push', request_key: 'missed-push', task: 'Synthetic missed push.' });
  await until(() => cliState(job.task_dir)?.pid, 20000);
  writeFixtureFile(join(job.task_dir, 'report.md'), 'Report, then herdr goes idle without a push.\n');
  f.silent(job.job, 'idle');
  await until(() => cliState(job.task_dir)?.state === 'idle_grace', 20000);
  assert.equal(cliState(job.task_dir).output_written, true);
});

// Two independent turns each settle through the configured grace and real /quit subprocess.
test('done without report keeps the job open and a later report settles it', { timeout: 45000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'short-cli', 4, true);
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  const job = await f.call('hud_create', { role: 'short-cli', request_key: 'grok-missing', task: 'Synthetic missing.' });
  await until(() => cliState(job.task_dir)?.state === 'working' && cliState(job.task_dir)?.pid, 15000);
  assertCliStatus(cliState(job.task_dir), job.task_dir);
  assert.equal(cliState(job.task_dir).output_written, false);
  assert.equal(cliState(job.task_dir).reason, null);
  assert.equal(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'), false);
  assert.equal(f.commands().filter((c) => c.args[1] === 'prompt').length, 1);
  // done -> working -> done + report
  fs.unlinkSync(join(f.env.HOME, 'missing-report'));
  fs.writeFileSync(join(f.env.HOME, 'wake-turn'), '');
  await until(() => cliState(job.task_dir)?.state === 'closed', 25000);
  const closed = cliState(job.task_dir);
  assert.equal(closed.exit_reason, 'settled');
  assert.equal(closed.output_written, true);
  assert.equal(fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8'), 'Synthetic grok report.\n');
  // A report written directly while done (without a self-wake) also settles the turn.
  fs.unlinkSync(join(f.env.HOME, 'wake-turn'));
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  const job2 = await f.call('hud_create', { role: 'short-cli', request_key: 'grok-late-report', task: 'Synthetic late report.' });
  await until(() => cliState(job2.task_dir)?.state === 'working' && cliState(job2.task_dir)?.pid, 15000);
  writeFixtureFile(join(job2.task_dir, 'report.md'), 'Synthetic direct report.\n');
  await until(() => cliState(job2.task_dir)?.state === 'closed', 25000);
  assert.equal(cliState(job2.task_dir).output_written, true);
});

test("a cli continuation in grace is judged against the report at that turn's start", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'hold-grace'), '');
  const job = await f.call('hud_create', {
    role: 'general',
    on: 'grok',
    request_key: 'grok-cont',
    task: 'Synthetic continuation.',
  });
  await until(() => graceArmed(f.env, job.task_dir), 5000);
  const sent = await f.call('hud_send', { job: job.job, message_key: 'more', text: 'Synthetic continuation.' });
  assert.equal(sent.sent, true);
  assert.equal(sent.queued, undefined);
  await until(() => fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8').includes('two'), 5000);
  await until(
    () => cliState(job.task_dir)?.state === 'idle_grace' && cliState(job.task_dir)?.output_written === true,
    5000
  );
});

for (const mode of ['rejected-prompt', 'fast-ambiguous-prompt']) {
  test(`hud_send: preserves the right turn on ${mode}`, { timeout: 30000 }, async (t) => {
    const f = await fixture(t);
    t.after(() => { try { fs.writeFileSync(join(f.env.HOME, 'release-prompt-result'), ''); } catch {} });
    fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
    writeCliRole(f, 'cli-send-outcome', 60);
    const job = await f.call('hud_create', { role: 'cli-send-outcome', request_key: mode, task: 'Synthetic task.' });
    const dir = job.task_dir, turn = () => JSON.parse(fs.readFileSync(join(dir, 'turn.json'), 'utf8'));
    const receipt = () => JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8'));
    await until(() => cliState(dir)?.agent_session_id, 15000);
    writeFixtureFile(join(dir, 'report.md'), 'Synthetic first report.\n');
    f.push(job.job, 'idle');
    await until(() => cliState(dir)?.state === 'idle_grace', 15000);
    const prior = turn(), grace = cliState(dir);
    const args = { job: job.job, message_key: 'cont', text: 'Synthetic continuation.' };
    fs.writeFileSync(join(f.env.HOME, mode), '');
    const prompts = () => f.commands().filter((c) => c.args[1] === 'prompt' && c.args[3]?.split('\n')[0] === args.text);
    const sent = f.call('hud_send', args);
    await until(() => prompts().length > 0, 15000);
    const provisional = turn();
    assert.equal(provisional.seq, prior.seq + 1);
    assert.equal(receipt().send_outcomes.at(-1).exit_code, null);
    const pendingQueries = statusQueries(f, job);
    await until(() => statusQueries(f, job) > pendingQueries, 15000); // Sample while Herdr has not replied yet.
    assert.equal(cliState(dir).settled_at, grace.settled_at);
    fs.writeFileSync(join(f.env.HOME, 'release-prompt-result'), '');
    assert.equal((await sent).code, 'send_failed');
    assert.equal((await f.call('hud_send', args)).code, 'send_failed');
    assert.equal(prompts().length, 1);
    assert.equal(receipt().send_outcomes.at(-1).exit_code, 1);
    if (mode === 'rejected-prompt') {
      assert.deepEqual(turn(), prior);
      const queries = statusQueries(f, job);
      await until(() => statusQueries(f, job) > queries, 15000);
      const listing = (await f.call('hud_read')).jobs.find((row) => row.job === job.job);
      assert.equal(listing.report_unread, true);
      assert.equal(listing.state, 'idle_grace');
      assert.equal(cliState(dir).settled_at, grace.settled_at);
      assert.equal(cliState(dir).idle_deadline_at, grace.idle_deadline_at);
    } else {
      assert.deepEqual(turn(), provisional);
      await until(() => cliState(dir)?.state === 'idle_grace' && cliState(dir).settled_at !== grace.settled_at, 15000);
      assert.equal(cliState(dir).output_written, true);
      assert.match((await f.call('hud_read', { job: job.job })).digest.result, /fast report after input/);
    }
  });
}

test('an unchanged cli report after continuation stays open without failing', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'short-cont', 1, true);
  fs.writeFileSync(join(f.env.HOME, 'hold-grace'), '');
  fs.writeFileSync(join(f.env.HOME, 'unchanged-report'), '');
  const job = await f.call('hud_create', { role: 'short-cont', request_key: 'grok-same', task: 'Synthetic same.' });
  await until(() => graceArmed(f.env, job.task_dir), 5000);
  await f.call('hud_send', { job: job.job, message_key: 'same', text: 'Synthetic continuation.' });
  await until(() => cliState(job.task_dir)?.state === 'working' && cliState(job.task_dir)?.output_written === false, 5000);
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator', 5000);
  assert.equal(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'), false);
  writeFixtureFile(join(job.task_dir, 'report.md'), 'Synthetic grok report two.\n');
  await until(() => cliState(job.task_dir)?.state === 'idle_grace' && cliState(job.task_dir)?.output_written === true, 5000);
});

test('quiet past grace turns waiting_orchestrator without pane notices and self-wake returns to working', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'quiet-cli', 1, false);
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  const notices = () =>
    f.commands().filter((c) => c.args[1] === 'prompt' && String(c.args.at(-1)).includes('quiet without a report'));
  const job = await f.call('hud_create', { role: 'quiet-cli', request_key: 'quiet-grace', task: 'Synthetic quiet grace.' });
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator', 5000);
  assert.equal(notices().length, 0);
  const asking = workerFor(f, job.job);
  assert.equal(asking.homeNeedsHuman, true);
  assert.equal(asking.phase, 'asking');
  assert.match(cardText(asking), /quiet without a report/);
  assert.equal(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'), false);
  assert.equal(f.commands().filter((c) => c.args[1] === 'prompt' && c.args[2] !== 'w4E:p1').length, 1);
  await new Promise((done) => setTimeout(done, 350));
  assert.equal(notices().length, 0);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  fs.writeFileSync(join(f.env.HOME, 'wake-turn'), '');
  await until(() => cliState(job.task_dir)?.state === 'working' && cliState(job.task_dir)?.reason === null, 5000);
  assert.equal(workerFor(f, job.job).homeNeedsHuman, false);
  fs.unlinkSync(join(f.env.HOME, 'missing-report'));
  fs.writeFileSync(join(f.env.HOME, 'release-turn'), '');
  await until(() => cliState(job.task_dir)?.state === 'closed', 5000);
  assert.equal(notices().length, 0);
});

test('hud_send queues into a working cli job', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const job = await f.call('hud_create', { role: 'general', on: 'grok', request_key: 'grok-queue', task: 'Synthetic queue.' });
  await until(() => cliState(job.task_dir)?.state === 'working');
  const sent = await f.call('hud_send', { job: job.job, message_key: 'q', text: 'Synthetic addendum.' });
  assert.equal(sent.queued, true);
  assert.equal(sent.sent, true);
  assert.equal(
    f
      .commands()
      .filter((c) => c.args[1] === 'prompt')
      .at(-1)
      .args[3].split('\n')[0],
    'Synthetic addendum.'
  );
});

test('hud_close stops a working cli job and closes an idle-grace one', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const working = await f.call('hud_create', { role: 'general', on: 'grok', request_key: 'grok-stop', task: 'Synthetic stop.' });
  await until(() => cliState(working.task_dir)?.state === 'working');
  assert.equal(typeof cliState(working.task_dir).pid, 'number');
  assert.match(cliState(working.task_dir).pid_start_time, /^\d+$/);
  const { exit_code, last_line } = await f.call('hud_close', { job: working.job });
  assert.equal(exit_code, 0);
  assert.equal(last_line, 'Synthetic reap complete');
  await until(() => cliState(working.task_dir)?.state === 'stopped');
  assert.equal(cliState(working.task_dir).exit_reason, 'stop requested');
  assert.equal(fs.existsSync(join(working.task_dir, 'STATUS.json.stop-requested')), true);
  fs.unlinkSync(join(f.env.HOME, 'hold-turn'));
  fs.writeFileSync(join(f.env.HOME, 'hold-grace'), '');
  const grace = await f.call('hud_create', { role: 'general', on: 'grok', request_key: 'grok-close', task: 'Synthetic close.' });
  await until(() => cliState(grace.task_dir)?.state === 'idle_grace');
  await f.call('hud_close', { job: grace.job });
  await until(() => cliState(grace.task_dir)?.state === 'closed');
  assert.equal(cliState(grace.task_dir).exit_reason, 'settled');
  assert.equal(fs.existsSync(join(grace.task_dir, 'STATUS.json.close-requested')), true);
});

test('a blocked CLI turn needs the owner once, then returns to working', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'cli-blocked'), '');
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const job = await f.call('hud_create', { role: 'general', on: 'grok', request_key: 'grok-blocked', task: 'Synthetic blocked.' });
  assert.match(
    fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8'),
    /node ".*\/hud-ask\.mjs" --dir ".*" --question/
  );
  const notices = () =>
    f.commands().filter((c) => c.args[1] === 'prompt' && String(c.args.at(-1)).includes('BLOCKED:'));
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator');
  const blocked = cliState(job.task_dir);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.harness, 'cli');
  assert.equal(notices().length, 0);
  const worker = workerFor(f, job.job);
  assert.equal(worker.homeNeedsHuman, true);
  assert.equal(worker.phase, 'asking');
  assert.equal(worker.ask, 'grok needs input in its pane');
  assert.match(cardText(worker), /grok needs input in its pane/);
  assert.match(cardText(worker), /asking/);
  fs.writeFileSync(join(f.env.HOME, 'release-blocked'), '');
  await until(() => cliState(job.task_dir)?.state === 'working' && cliState(job.task_dir)?.blocked === false, 5000);
  assert.equal(notices().length, 0);
  const resumed = workerFor(f, job.job);
  assert.equal(resumed.homeNeedsHuman, false);
  assert.equal(resumed.ask, undefined);
  fs.writeFileSync(join(f.env.HOME, 'release-turn'), '');
  await until(() => cliState(job.task_dir)?.state === 'closed', 5000);
});

test('idle and unknown with a live agent settle only a stable new report', { timeout: 45000 }, async (t) => {
  const f = await fixture(t);
  for (const status of ['idle', 'unknown']) {
    writeFixtureFile(join(f.env.HOME, 'quiet-hold'), status);
    const job = await f.call('hud_create', {
      role: 'general',
      on: 'grok',
      request_key: 'quiet-' + status,
      task: 'Synthetic quiet.',
    });
    await until(() => cliState(job.task_dir)?.state === 'closed', 20000);
    assert.equal(cliState(job.task_dir).error, null);
    assert.equal(cliState(job.task_dir).exit_reason, 'settled');
    assert.equal(f.commands().some((c) => c.args[1] === 'wait' && c.args.includes('blocked')), false);
  }
});

test('unknown while the agent is gone settles the job', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'cli-unknown'), '');
  const job = await f.call('hud_create', { role: 'general', on: 'grok', request_key: 'unknown-gone', task: 'Synthetic unknown.' });
  await until(() => cliState(job.task_dir)?.state === 'failed');
  assert.equal(cliState(job.task_dir).error, 'worker exited');
});

test(
  'grace keeps its deadline when idle is not an exit, and unknown with the agent gone leaves',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    writeFixtureFile(join(f.env.HOME, 'grace-quiet'), 'idle');
    const held = await f.call('hud_create', { role: 'general', on: 'grok', request_key: 'grace-idle', task: 'Synthetic grace.' });
    await until(() => cliState(held.task_dir)?.state === 'closed', 8000);
    assert.equal(f.commands().some((c) => c.args[1] === 'wait' && c.args.includes('blocked')), false);
    assert.equal(cliState(held.task_dir).exit_reason, 'settled');
    assert.equal(cliState(held.task_dir).error, null);
    const seen = JSON.parse(fs.readFileSync(join(f.env.HOME, 'seen-grace.json'), 'utf8'));
    assert.equal(cliState(held.task_dir).idle_deadline_at, seen.idle_deadline_at);
    // A pushed unknown cannot override the /proc exit fact.
    writeFixtureFile(join(f.env.HOME, 'grace-quiet'), 'unknown');
    fs.writeFileSync(join(f.env.HOME, 'grace-quiet-gone'), '');
    const gone = await f.call('hud_create', {
      role: 'general',
      on: 'grok',
      request_key: 'grace-gone',
      task: 'Synthetic grace gone.',
    });
    await until(() => cliState(gone.task_dir)?.state === 'closed', 8000);
    assert.equal(cliState(gone.task_dir).exit_reason, 'settled');
    assert.equal(cliState(gone.task_dir).output_written, true);
  }
);

test('a blocked resume treats idle as present and unknown as gone', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'cli-blocked'), '');
  writeFixtureFile(join(f.env.HOME, 'blocked-quiet'), 'idle');
  const held = await f.call('hud_create', {
    role: 'general',
    on: 'grok',
    request_key: 'blocked-idle',
    task: 'Synthetic blocked quiet.',
  });
  await until(() => cliState(held.task_dir)?.state === 'waiting_orchestrator');
  fs.writeFileSync(join(f.env.HOME, 'release-blocked'), '');
  await until(() => cliState(held.task_dir)?.state === 'closed', 8000);
  assert.equal(cliState(held.task_dir).exit_reason, 'settled');
  assert.equal(cliState(held.task_dir).error, null);
  fs.unlinkSync(join(f.env.HOME, 'release-blocked'));
  // A missing worker on blocked resume still fails by its PID.
  writeFixtureFile(join(f.env.HOME, 'blocked-quiet'), 'unknown');
  fs.writeFileSync(join(f.env.HOME, 'blocked-quiet-gone'), '');
  const gone = await f.call('hud_create', {
    role: 'general',
    on: 'grok',
    request_key: 'blocked-gone',
    task: 'Synthetic blocked gone.',
  });
  await until(() => cliState(gone.task_dir)?.state === 'failed', 8000);
  assert.equal(cliState(gone.task_dir).error, 'worker exited');
});

test('report written while working settles only at turn end, not mid-turn slice timeout, for continuable and noncontinuable CLIs', { timeout: 15000 }, async (t) => {
  await Promise.all([
    (async () => {
      const f = await fixture(t);
      writeCliRole(f, 'mid-report-cli', 1, true);
      fs.writeFileSync(join(f.env.HOME, 'report-while-working'), '');
      const job = await f.call('hud_create', {
        role: 'mid-report-cli',
        request_key: 'mid-report',
        task: 'Write report mid-turn while still working.',
      });
      await until(() => fs.existsSync(join(job.task_dir, 'report.md')), 5000);
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(cliState(job.task_dir).state, 'working');
      assert.equal(cliState(job.task_dir).output_written, false);
      assert.equal(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'), false);
      fs.writeFileSync(join(f.env.HOME, 'release-done'), '');
      await until(() => cliState(job.task_dir)?.state === 'idle_grace' && cliState(job.task_dir)?.output_written === true, 5000);
      await until(() => cliState(job.task_dir)?.state === 'closed', 5000);
      assert.equal(cliState(job.task_dir).output_written, true);
      assert.equal(cliState(job.task_dir).exit_reason, 'settled');
    })(),
    (async () => {
      const f = await fixture(t);
      writeCliRole(f, 'no-cont-mid', 1, false);
      fs.writeFileSync(join(f.env.HOME, 'report-while-working'), '');
      const noCont = await f.call('hud_create', {
        role: 'no-cont-mid',
        request_key: 'no-quit-early',
        task: 'Must not send /quit before done.',
      });
      await until(() => fs.existsSync(join(noCont.task_dir, 'report.md')), 5000);
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(cliState(noCont.task_dir).state, 'working');
      assert.equal(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'), false);
      fs.writeFileSync(join(f.env.HOME, 'release-done'), '');
      await until(() => cliState(noCont.task_dir)?.state === 'closed', 5000);
      assert.equal(cliState(noCont.task_dir).output_written, true);
      assert.ok(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'));
    })(),
  ]);
});
});
