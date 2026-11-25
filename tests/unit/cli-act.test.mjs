/** `hud act`: the owner's panel actions from a command (including the Claude mod's slash commands). Synthetic data only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main } from '../../dist/cli/hud-main.js';
import { PanelActionLog, PANEL_ACTIONS_FILE } from '../../dist/collectors/panel-actions.js';
import { TRIES_FILE } from '../../dist/collectors/try-records.js';

const JOB = 'j0123456789abcdef', QUEUED = 'j1111111111111111';
const QUESTION = '# Question q1 from imp@demo\n\nKeep the v1 shim?\n\nOptions:\n- keep it\n- remove it\n\nDefault if unanswered: keep it\n';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'cli-act-')), hud = join(root, 'hud'), cwd = join(root, 'project');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (path, text) => { fs.mkdirSync(join(path, '..'), { recursive: true }); fs.writeFileSync(path, typeof text === 'string' ? text : JSON.stringify(text)); };
  put(join(hud, 'jobs', JOB, 'job.json'), { job: JOB, role: 'imp', created_at: '2026-01-01T00:00:00Z' });
  put(join(hud, 'jobs', JOB, 'STATUS.json'), { state: 'working' });
  put(join(hud, 'jobs', JOB, 'qa/q1.md'), QUESTION);
  put(join(hud, 'jobs', QUEUED, 'job.json'), { job: QUEUED, role: 'imp', created_at: '2026-01-01T00:00:00Z' });
  put(join(hud, 'jobs', QUEUED, 'STATUS.json'), { state: 'queued' });
  ['resolved', 'try', 'try', 'ready-for-agent'].forEach((status, i) =>
    put(join(cwd, '.scratch/export/issues', `0${i + 1}-sample.md`), `# 0${i + 1}: Sample ${i + 1}\n**Status:** ${status}\n**Blocked by:** none\n`));
  const env = { HOME: root, HUD_HOME: hud, LANG: 'en_US.UTF-8', HUD_SETTINGS_PATH: join(root, 'settings.json') };
  const run = async (...args) => {
    let stdout = '', stderr = '';
    const code = await main(['act', ...args], { env, stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
    return { code, stdout, stderr };
  };
  const lines = (name) => fs.readFileSync(join(hud, name), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { hud, cwd, env, run, lines, dir: (id) => join(hud, 'jobs', id) };
}

test('hud act try still accepts legacy pending tickets in one record and says when nothing is left', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.run('try', '--cwd', f.cwd), { code: 0, stdout: 'Accepted 2 to try\n', stderr: '' });
  const [record, ...more] = f.lines(TRIES_FILE);
  assert.deepEqual([record.action, record.slices, more.length, fs.statSync(join(f.hud, TRIES_FILE)).mode & 0o777], ['accept', ['EXPORT-02', 'EXPORT-03'], 0, 0o600]);
  assert.equal((await f.run('try', '--cwd', f.cwd)).stdout, 'Nothing to try\n');
  assert.equal(f.lines(TRIES_FILE).length, 1);
  assert.equal((await f.run('try', '--cwd')).code, 2);
});

test('answer writes qa/qN.answer.md once and the session hears it; a second answer changes nothing', async (t) => {
  const f = fixture(t), file = join(f.dir(JOB), 'qa/q1.answer.md'), log = new PanelActionLog(f.hud);
  assert.deepEqual(await f.run('answer', JOB, 'q1', 'keep', 'it now'), { code: 0, stdout: `Answered q1 for ${JOB}\n`, stderr: '' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep it now');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(f.lines(PANEL_ACTIONS_FILE).map(({ at, ...rest }) => rest), [{ type: 'answer', job: JOB, qid: 'q1', role: null, answer: 'keep it now' }]);
  assert.equal((await f.run('answer', JOB, 'q1', 'remove it')).stdout, 'q1 was already answered\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep it now');
  assert.equal(f.lines(PANEL_ACTIONS_FILE).length, 1);
  assert.deepEqual(log.changes(new Set([JOB])), [`[job@${JOB}] ANSWERED q1 from panel: keep it now`]);
  const missing = await f.run('answer', JOB, 'q9', 'x');
  assert.deepEqual([missing.code, missing.stderr], [1, 'could not answer: no such question\n']);
});

test('retry records the request the session hears and decides on; stop reaps a queued job', async (t) => {
  const f = fixture(t), log = new PanelActionLog(f.hud);
  assert.deepEqual(await f.run('retry', JOB), { code: 0, stdout: `Retry requested for ${JOB}\n`, stderr: '' });
  assert.deepEqual(f.lines(PANEL_ACTIONS_FILE).map(({ at, ...rest }) => rest), [{ type: 'retry', job: JOB }]);
  assert.equal(fs.existsSync(f.dir(JOB)), true, 'a retry is an intent: nothing else moves');
  assert.deepEqual(log.changes(new Set([JOB])), [`[${JOB}] Retry requested from panel`]);
  assert.deepEqual(await f.run('stop', QUEUED), { code: 0, stdout: `Stopped ${QUEUED}\n`, stderr: '' });
  assert.equal(fs.existsSync(f.dir(QUEUED)), false);
});

test('stop --queued cancels only never-started jobs', async t => {
  const f = fixture(t);
  const done = await f.run('stop', '--queued', JOB, QUEUED);
  assert.equal(done.code, 0);
  assert.match(done.stdout, new RegExp(`Skipped ${JOB}`));
  assert.match(done.stdout, new RegExp(`Cancelled ${QUEUED} .*no worker`));
  assert.equal(fs.existsSync(f.dir(QUEUED)), false);
  assert.equal(fs.existsSync(f.dir(JOB)), true);
});

test('stop --package requires --queued and selects only the current pane/project', async t => {
  const f = fixture(t);
  for (const job of [JOB, QUEUED]) fs.writeFileSync(join(f.dir(job), 'job.json'), JSON.stringify({
    job, caller_pane: 'demo:p1', cwd: process.cwd(), package: 'demo',
  }));
  assert.equal((await f.run('stop', '--package', 'demo')).code, 2);
  assert.equal((await f.run('stop', '--package', 'demo', '--queued')).code, 1);
  f.env.HERDR_PANE_ID = 'demo:p2';
  assert.equal((await f.run('stop', '--package', 'demo', '--queued')).stdout, '0 cancelled, 0 skipped, 0 failed\n');
  f.env.HERDR_PANE_ID = 'demo:p1';
  const done = await f.run('stop', '--package', 'demo', '--queued');
  assert.equal(done.code, 0);
  assert.match(done.stdout, new RegExp(`Skipped ${JOB}`));
  assert.match(done.stdout, new RegExp(`Cancelled ${QUEUED}`));
  assert.equal(fs.existsSync(f.dir(JOB)), true);
  assert.equal(fs.existsSync(f.dir(QUEUED)), false);
});

test('bad arguments and unknown jobs are refused before anything is written', async (t) => {
  const f = fixture(t);
  for (const args of [[], ['nope'], ['answer', JOB, 'q1'], ['answer', JOB, 'x1', 'a'], ['retry'], ['retry', '../x'], ['stop', JOB, 'now'], ['try', 'extra']]) {
    const done = await f.run(...args);
    assert.deepEqual([args.join(' '), done.code, done.stdout, done.stderr.startsWith('Usage: hud act')], [args.join(' '), 2, '', true]);
  }
  const unknown = await f.run('retry', 'j9999999999999999');
  assert.deepEqual([unknown.code, unknown.stderr], [1, 'no such job: j9999999999999999\n']);
  assert.equal(fs.existsSync(join(f.hud, PANEL_ACTIONS_FILE)), false);
  assert.match((await f.run('--help')).stdout, /^Usage: hud act answer/);
});
