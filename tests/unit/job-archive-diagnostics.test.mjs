import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { stopJob } from '../../dist/cli/panel-pane.js';
import { answerJobQuestion } from '../../dist/collectors/panel-actions.js';
import { procStat } from '../../dist/mcp/cli-judge.js';
import { archiveJob } from '../../dist/roles/job-archive.js';
import { archiveJobLand } from '../../dist/roles/job-land.js';
import { recordJobUsage } from '../../dist/roles/job-usage.js';
import { defaultSettings } from '../../dist/settings.js';
import { ask } from '../../dist/worker/tools.js';
import { fixture as retentionFixture, until as watchUntil } from '../helpers/job-retention-fixture.mjs';
import { writeFixtureFile as write } from '../helpers/thin-mcp-files.mjs';
import { fixture, until } from '../helpers/thin-mcp-harness.mjs';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readJob = (dir) => readJson(join(dir, 'job.json'));
const readStatus = (dir) => readJson(join(dir, 'STATUS.json'));
const readArchive = (home, month = '2026-11') =>
  fs.readFileSync(join(home, 'archive', `${month}.jsonl`), 'utf8').trimEnd().split('\n').map(JSON.parse);

async function herdrSocket(t, rf, paneReply) {
  const path = join(dirname(rf.home), 'herdr.sock');
  const sockets = new Set();
  const subscribed = Promise.withResolvers();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    createInterface({ input: socket }).on('line', (line) => {
      const { method, id, params } = JSON.parse(line);
      if (method === 'ping') socket.write(JSON.stringify({ id, result: { type: 'pong', version: '0.9.5', protocol: 22 } }) + '\n');
      if (method === 'events.subscribe') subscribed.resolve();
      if (method === 'pane.get') socket.write(JSON.stringify({ id, ...paneReply(params.pane_id) }) + '\n');
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    path,
    preload: `process.env.HERDR_SOCKET_PATH = ${JSON.stringify(path)};\n`,
    ready: () => subscribed.promise,
  };
}

function initRepo(dir) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Synthetic');
  git('config', 'user.email', 'synthetic@hud.invalid');
  write(join(dir, 'README.md'), 'synthetic\n');
  git('add', 'README.md');
  git('commit', '-m', 'init');
}

function writeRoles(f) {
  const roles = join(f.env.HUD_HOME, 'roles');
  fs.mkdirSync(roles, { recursive: true });
  const pi = (model, role = 'implementer') => ({ harness: 'pi', pi_role: role, model, thinking: 'high', split: false });
  write(join(roles, 'imp.json'), JSON.stringify({
    role: 'imp', instructions: 'implementer', can_continue: true,
    run: [pi('synth/alpha')], active_preset: 'alpha',
    presets: [
      { name: 'alpha', run: [pi('synth/alpha')] },
      { name: 'beta', run: [pi('synth/beta')] },
    ],
  }));
  write(join(roles, 'sonic.json'), JSON.stringify({
    role: 'sonic', instructions: 'sonic', can_continue: false,
    run: [pi('synth/fast', 'sonic')],
  }));
}

test('dispatched, settled and archived jobs carry placement and worktree facts', async (t) => {
  const f = await fixture(t);
  initRepo(f.root);
  writeRoles(f);
  write(f.env.HUD_SETTINGS_PATH, JSON.stringify({ ...defaultSettings(), autoPrewalk: false, impPlacement: 'even', impEvenPool: ['beta', 'alpha'] }));
  const ended = '2026-11-24T10:00:00.000Z';

  // 1. General job with explicit requested_on and requested_model.
  const general = await f.call('hud_create', {
    role: 'general', on: 'pi', model: 'synth/override', task: 'Synthetic override task.',
  });
  assert.equal(general.ok ?? true, true);
  write(join(general.task_dir, 'STATUS.json'), JSON.stringify({ state: 'closed', started_at: ended, settled_at: ended, ended_at: ended, output_written: true }));
  archiveJob(f.env.HUD_HOME, general.task_dir, general.job, readJson(join(general.task_dir, 'job.json')), readJson(join(general.task_dir, 'STATUS.json')), Date.parse(ended), (m) => assert.fail(m));

  // 2. Imp job with even preset + worktree (removed) and a second worktree (kept).
  const imp = await f.call('hud_create', { role: 'imp', isolation: 'worktree', task: 'Synthetic worktree task.' });
  const impReceipt = { ...readJson(join(imp.task_dir, 'job.json')), worktree_removed_at: '2026-11-24T10:05:00.000Z' };
  write(join(imp.task_dir, 'job.json'), JSON.stringify(impReceipt, null, 2));
  write(join(imp.task_dir, 'STATUS.json'), JSON.stringify({ state: 'closed', started_at: ended, settled_at: ended, ended_at: ended, output_written: true }));
  archiveJob(f.env.HUD_HOME, imp.task_dir, imp.job, impReceipt, readJson(join(imp.task_dir, 'STATUS.json')), Date.parse(ended), (m) => assert.fail(m));

  const kept = await f.call('hud_create', { role: 'imp', isolation: 'worktree', task: 'Synthetic dirty worktree task.' });
  const keptReceipt = { ...readJson(join(kept.task_dir, 'job.json')), worktree_kept_reason: 'worktree is dirty: "draft.txt"' };
  write(join(kept.task_dir, 'job.json'), JSON.stringify(keptReceipt, null, 2));
  write(join(kept.task_dir, 'STATUS.json'), JSON.stringify({ state: 'closed', started_at: ended, settled_at: ended, ended_at: ended, output_written: true }));
  archiveJob(f.env.HUD_HOME, kept.task_dir, kept.job, keptReceipt, readJson(join(kept.task_dir, 'STATUS.json')), Date.parse(ended), (m) => assert.fail(m));

  // 3. Sonic job records thinking_source and model_source.
  const sonic = await f.call('hud_create', { role: 'sonic', task: 'Synthetic sonic task.' });
  write(join(sonic.task_dir, 'STATUS.json'), JSON.stringify({ state: 'done', started_at: ended, settled_at: ended, ended_at: ended, output_written: true }));
  archiveJob(f.env.HUD_HOME, sonic.task_dir, sonic.job, readJson(join(sonic.task_dir, 'job.json')), readJson(join(sonic.task_dir, 'STATUS.json')), Date.parse(ended), (m) => assert.fail(m));

  const byId = new Map(readArchive(f.env.HUD_HOME).map((row) => [row.job, row]));
  const genRow = byId.get(general.job);
  assert.equal(genRow.requested_on, 'pi');
  assert.equal(genRow.requested_model, 'synth/override');
  assert.equal(genRow.model_source, 'hud_create');
  assert.equal(genRow.had_worktree, false);
  assert.equal(genRow.imp_preset, undefined);

  const impRow = byId.get(imp.job);
  assert.equal(impRow.imp_preset, 'beta');
  assert.equal(impRow.had_worktree, true);
  assert.equal(impRow.worktree_removed_at, '2026-11-24T10:05:00.000Z');
  assert.equal(impRow.worktree_kept_reason, undefined);
  assert.equal(impRow.requested_on, undefined);
  assert.equal(impRow.requested_model, undefined);
  assert.ok(impRow.model_source);

  const keptRow = byId.get(kept.job);
  assert.equal(keptRow.imp_preset, 'alpha');
  assert.equal(keptRow.had_worktree, true);
  assert.equal(keptRow.worktree_removed_at, undefined);
  assert.equal(keptRow.worktree_kept_reason, 'worktree is dirty: "draft.txt"');

  const sonicRow = byId.get(sonic.job);
  assert.equal(sonicRow.thinking_source, 'default');
  assert.ok(sonicRow.model_source);
  assert.equal(sonicRow.had_worktree, false);
});

test('stopping a working job via hud_close, panel stopJob, and vanished pane records all three stop_origin actors once', async (t) => {
  const f = await fixture(t);
  const ended = '2026-11-24T11:00:00.000Z';

  // 1. MCP hud_close on a working job.
  const mcpJob = await f.call('hud_create', { role: 'imp', task: 'Stop via MCP.' });
  await until(() => readJson(join(mcpJob.task_dir, 'STATUS.json')).state === 'working', t.signal);
  const closed = await f.call('hud_close', { job: mcpJob.job });
  assert.equal(closed.exit_code, 0);
  const mcpReceipt = readJson(join(mcpJob.task_dir, 'job.json'));
  assert.equal(mcpReceipt.stop_origin?.actor, 'mcp');
  assert.equal(mcpReceipt.stop_origin?.prior_state, 'working');
  assert.ok(Date.parse(mcpReceipt.stop_origin.at));
  // Repeating stop via panel does not overwrite the first recorded stop_origin.
  write(join(mcpJob.task_dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
  assert.equal((await stopJob(mcpJob.task_dir, f.env)).ok, true);
  assert.deepEqual(readJson(join(mcpJob.task_dir, 'job.json')).stop_origin, mcpReceipt.stop_origin);
  archiveJob(f.env.HUD_HOME, mcpJob.task_dir, mcpJob.job, mcpReceipt, { state: 'stopped', ended_at: ended }, Date.parse(ended), (m) => assert.fail(m));

  // 2. Panel stopJob on a working job (and idle_grace does not record stop_origin).
  const panelJob = await f.call('hud_create', { role: 'imp', task: 'Stop via panel.' });
  await until(() => readJson(join(panelJob.task_dir, 'STATUS.json')).state === 'working', t.signal);
  assert.equal((await stopJob(panelJob.task_dir, f.env)).ok, true);
  const panelReceipt = readJson(join(panelJob.task_dir, 'job.json'));
  assert.equal(panelReceipt.stop_origin?.actor, 'panel');
  assert.equal(panelReceipt.stop_origin?.prior_state, 'working');
  assert.ok(Date.parse(panelReceipt.stop_origin.at));
  archiveJob(f.env.HUD_HOME, panelJob.task_dir, panelJob.job, panelReceipt, { state: 'stopped', ended_at: ended }, Date.parse(ended), (m) => assert.fail(m));

  const graceJob = await f.call('hud_create', { role: 'imp', task: 'Close in idle grace.' });
  write(join(graceJob.task_dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
  assert.equal((await stopJob(graceJob.task_dir, f.env)).ok, true);
  assert.equal(readJson(join(graceJob.task_dir, 'job.json')).stop_origin, undefined);

  const archived = new Map(readArchive(f.env.HUD_HOME).map((row) => [row.job, row]));
  assert.deepEqual(archived.get(mcpJob.job).stop_origin, mcpReceipt.stop_origin);
  assert.deepEqual(archived.get(panelJob.job).stop_origin, panelReceipt.stop_origin);

  // 3. Watcher finding the pane vanished while working.
  const rf = retentionFixture(t);
  let paneGone = false;
  const herdr = await herdrSocket(t, rf, (id) =>
    paneGone ? { error: { code: 'pane_not_found' } } : { result: { pane: { pane_id: id } } });
  const worker = spawn(process.execPath, ['-e', 'process.stdin.resume()']);
  const exited = once(worker, 'exit');
  t.after(async () => { worker.kill(); await exited; });
  const dir = rf.job({ state: 'working', slot: 'primary', pid: worker.pid, pid_start_time: procStat(worker.pid).start });
  fs.unlinkSync(join(dir, 'report.md'));
  write(join(dir, 'SESSION.txt'), `TAB=synthetic-tab\nLEFT=synthetic-pane\nHERDR_SOCKET_PATH=${herdr.path}\n`);
  const watch = rf.start(herdr.preload + "process.env.HUD_WATCH_CLI_CHECK_MS = '75';");
  await herdr.ready();
  worker.stdin.end();
  await exited;
  paneGone = true;
  await watchUntil(() => readStatus(dir).state === 'stopped', t.signal);
  await watch.exited;
  const vanishedReceipt = readJob(dir);
  assert.equal(vanishedReceipt.stop_origin?.actor, 'pane_vanished');
  assert.equal(vanishedReceipt.stop_origin?.prior_state, 'working');
  assert.ok(Date.parse(vanishedReceipt.stop_origin.at));
  archiveJob(rf.home, dir, vanishedReceipt.job, vanishedReceipt, readStatus(dir), Date.parse(ended), (m) => assert.fail(m));
  const [vanishedRow] = readArchive(rf.home, readStatus(dir).ended_at.slice(0, 7));
  assert.deepEqual(vanishedRow.stop_origin, vanishedReceipt.stop_origin);
});

test('questions archive answered_by (orchestrator, owner via panel or hud_respond by:owner) and used_default (matched, different, timed out)', async (t) => {
  const f = await fixture(t);
  const job = await f.call('hud_create', { role: 'imp', task: 'Ask synthetic questions.' });
  const dir = job.task_dir;
  const qa = join(dir, 'qa');
  fs.mkdirSync(qa, { recursive: true });
  const writeQ = (n, def) => {
    write(join(qa, `q${n}.md`), `# Question q${n} from imp@demo\n\nPick one?\n\nOptions:\n- ${def}\n- other choice\n\nDefault if unanswered: ${def}\n\nAnswer: write to qa/q${n}.answer.md\n`);
  };
  for (const [n, def] of [[1, 'keep it'], [2, 'keep it'], [3, 'keep it'], [4, 'keep it'], [5, 'keep it']]) writeQ(n, def);

  // q1: hud_respond (orchestrator) with whitespace-different match to default -> answered_by orchestrator, used_default true.
  const r1 = await f.call('hud_respond', { job: job.job, request_id: 'q1', answer: '  keep\n  it  ' });
  assert.equal(r1.written, true);
  // q2: hud_respond with by: 'owner' and non-default answer -> answered_by owner, used_default false.
  const r2 = await f.call('hud_respond', { job: job.job, request_id: 'q2', answer: 'other choice', by: 'owner' });
  assert.equal(r2.written, true);
  // q3 & q4: batch hud_respond answers[] with mixed by omitted / by: 'owner'.
  const batch = await f.call('hud_respond', {
    answers: [
      { job: job.job, request_id: 'q3', answer: 'other choice' },
      { job: job.job, request_id: 'q4', answer: 'keep   it', by: 'owner' },
    ],
  });
  assert.deepEqual(batch.answers.map((a) => ({ id: a.request_id, written: a.written })), [
    { id: 'q3', written: true },
    { id: 'q4', written: true },
  ]);
  // q5: panel answerJobQuestion -> answered_by owner, used_default false.
  assert.deepEqual(answerJobQuestion(f.env.HUD_HOME, job.job, 'q5', 'other choice', 'imp'), { ok: true, written: true });

  // Invalid by rejected (single and top-level with answers).
  assert.match((await f.rpc('tools/call', { name: 'hud_respond', arguments: { job: job.job, request_id: 'q1', answer: 'x', by: 'orchestrator' } })).result.content[0].text, /invalid_arguments: by/);
  assert.match((await f.rpc('tools/call', { name: 'hud_respond', arguments: { by: 'owner', answers: [{ job: job.job, request_id: 'q1', answer: 'x' }] } })).result.content[0].text, /invalid_arguments: answers/);

  // q6: real ask() timeout (1s) records timed_out_questions -> used_default true, no answered_by.
  const timedOut = await ask({ dir, job: readJson(join(dir, 'job.json')) }, { question: 'Timeout test?', default: 'use fallback' }, '1');
  assert.match(timedOut, /No answer to q6 within 1s/);
  assert.deepEqual(readJson(join(dir, 'job.json')).timed_out_questions, ['q6']);

  // q7: native-style unanswered question >= 20 min before clean settlement -> used_default true.
  writeQ(7, 'wait out');
  const askedOld = Date.parse('2026-11-24T09:00:00.000Z');
  fs.utimesSync(join(qa, 'q7.md'), askedOld / 1000, askedOld / 1000);

  // q8: unanswered question only 5 min before settlement (did not time out) -> used_default false.
  writeQ(8, 'not timed out');
  const askedRecent = Date.parse('2026-11-24T09:55:00.000Z');
  fs.utimesSync(join(qa, 'q8.md'), askedRecent / 1000, askedRecent / 1000);

  const ended = '2026-11-24T10:00:00.000Z';
  archiveJob(f.env.HUD_HOME, dir, job.job, readJson(join(dir, 'job.json')), { state: 'closed', settled_at: ended, ended_at: ended, output_written: true }, Date.parse(ended), (m) => assert.fail(m));
  const [archived] = readArchive(f.env.HUD_HOME);
  const byQ = Object.fromEntries(archived.questions.map((q) => [q.id, q]));

  assert.equal(byQ.q1.answered_by, 'orchestrator');
  assert.equal(byQ.q1.used_default, true);
  assert.equal(byQ.q2.answered_by, 'owner');
  assert.equal(byQ.q2.used_default, false);
  assert.equal(byQ.q3.answered_by, 'orchestrator');
  assert.equal(byQ.q3.used_default, false);
  assert.equal(byQ.q4.answered_by, 'owner');
  assert.equal(byQ.q4.used_default, true);
  assert.equal(byQ.q5.answered_by, 'owner');
  assert.equal(byQ.q5.used_default, false);
  assert.equal(byQ.q6.answered_at, undefined);
  assert.equal(byQ.q6.answered_by, undefined);
  assert.equal(byQ.q6.used_default, true);
  assert.equal(byQ.q7.answered_at, undefined);
  assert.equal(byQ.q7.answered_by, undefined);
  assert.equal(byQ.q7.used_default, true);
  assert.equal(byQ.q8.answered_at, undefined);
  assert.equal(byQ.q8.answered_by, undefined);
  assert.equal(byQ.q8.used_default, false);
});

test('archiveJobLand and archiveJob copy land.base_sha, land.source_sha, and usage.served_model while older records omit them cleanly', async (t) => {
  const f = await fixture(t);
  const ended = '2026-11-24T12:00:00.000Z';
  const base1 = '1'.repeat(40), src1 = '2'.repeat(40);
  const base2 = '3'.repeat(40), src2 = '4'.repeat(40), landedSha = '5'.repeat(40);

  // 1. Job with usage.served_model (+ served_models) and 2-attempt land flow carrying base_sha/source_sha.
  const modern = await f.call('hud_create', { role: 'imp', task: 'Synthetic served_model + land span.' });
  const piSession = join(modern.task_dir, 'session.jsonl');
  write(piSession, [
    JSON.stringify({ type: 'session' }),
    JSON.stringify({ type: 'message', timestamp: '2026-11-24T11:55:00.000Z', message: { role: 'assistant', provider: 'openai', model: 'gpt-6.2-sol', serviceTier: 'fast', usage: { input: 8, cacheRead: 2, cacheWrite: 0, output: 4 } } }),
    JSON.stringify({ type: 'message', timestamp: '2026-11-24T11:58:00.000Z', message: { role: 'assistant', provider: 'openai', model: 'gpt-6.2-sol-2026-11-24', usage: { input: 6, cacheRead: 1, cacheWrite: 0, output: 3 } } }),
  ].join('\n') + '\n');
  const modernStatus = { state: 'closed', started_at: '2026-11-24T11:50:00.000Z', settled_at: ended, ended_at: ended, session_file: piSession, output_written: true };
  recordJobUsage(modern.task_dir, readJob(modern.task_dir), modernStatus);

  const flowsDir = join(f.env.HUD_HOME, 'flows');
  fs.mkdirSync(flowsDir, { recursive: true });
  const flowBase = `f${modern.job.slice(1)}`;
  write(join(flowsDir, `${flowBase}.json`), JSON.stringify({
    job: modern.job, state: 'failed', created_at: '2026-11-24T12:01:00.000Z', updated_at: '2026-11-24T12:02:00.000Z',
    base_sha: base1, source_sha: src1,
  }));
  write(join(flowsDir, `${flowBase}-2.json`), JSON.stringify({
    job: modern.job, state: 'completed', created_at: '2026-11-24T12:03:00.000Z', updated_at: '2026-11-24T12:04:00.000Z',
    base_sha: base2, source_sha: src2, landed_sha: landedSha, landed_at: '2026-11-24T12:04:00.000Z',
  }));

  const projectedLand = archiveJobLand(f.env.HUD_HOME, modern.job);
  assert.equal(projectedLand?.sha, landedSha);
  assert.equal(projectedLand?.base_sha, base2);
  assert.equal(projectedLand?.source_sha, src2);

  archiveJob(f.env.HUD_HOME, modern.task_dir, modern.job, readJob(modern.task_dir), modernStatus, Date.parse(ended), (m) => assert.fail(m));

  // 2. Older job & flow lacking served_model, base_sha, and source_sha serialize without fabricated defaults.
  const legacy = await f.call('hud_create', { role: 'imp', task: 'Synthetic legacy job without new fields.' });
  const legacyStatus = { state: 'closed', started_at: '2026-11-24T11:50:00.000Z', settled_at: ended, ended_at: ended, output_written: true };
  write(join(legacy.task_dir, 'usage.json'), JSON.stringify({
    key: ended, usage: { input: 5, output: 2 },
  }));
  write(join(f.env.HUD_HOME, 'flows', `f${legacy.job.slice(1)}.json`), JSON.stringify({
    job: legacy.job, state: 'completed', created_at: '2026-11-24T12:01:00.000Z', updated_at: '2026-11-24T12:02:00.000Z',
    landed_sha: landedSha, landed_at: '2026-11-24T12:02:00.000Z',
  }));

  const legacyLand = archiveJobLand(f.env.HUD_HOME, legacy.job);
  assert.equal(legacyLand?.sha, landedSha);
  assert.equal('base_sha' in legacyLand, false);
  assert.equal('source_sha' in legacyLand, false);

  archiveJob(f.env.HUD_HOME, legacy.task_dir, legacy.job, readJob(legacy.task_dir), legacyStatus, Date.parse(ended), (m) => assert.fail(m));

  const byId = new Map(readArchive(f.env.HUD_HOME).map((row) => [row.job, row]));
  const modernRow = byId.get(modern.job);
  assert.deepEqual(modernRow.usage, {
    input: 14, cache_read: 3, cache_write: 0, output: 7,
    served_model: 'openai/gpt-6.2-sol-2026-11-24',
    served_models: ['openai/gpt-6.2-sol:fast', 'openai/gpt-6.2-sol-2026-11-24'],
  });
  assert.equal(modernRow.land.sha, landedSha);
  assert.equal(modernRow.land.base_sha, base2);
  assert.equal(modernRow.land.source_sha, src2);

  const legacyRow = byId.get(legacy.job);
  assert.deepEqual(legacyRow.usage, { input: 5, output: 2 });
  assert.equal('served_model' in legacyRow.usage, false);
  assert.equal('served_models' in legacyRow.usage, false);
  assert.equal(legacyRow.land.sha, landedSha);
  assert.equal('base_sha' in legacyRow.land, false);
  assert.equal('source_sha' in legacyRow.land, false);
});
