import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { basename, join } from 'node:path';
import test from 'node:test';
import { reportSignature } from '../../dist/roles/cli-turn.js';
import { writeReportMeta } from '../../dist/roles/report-meta.js';
import { fixture } from '../helpers/job-retention-fixture.mjs';

const now = Date.parse('2026-11-04T00:00:00Z');
const clock = `Date.now = () => ${now};`;
const ended = '2026-10-31T23:59:00Z', reaped = '2026-11-01T00:01:00Z';
const state = { state: 'closed', ended_at: ended };

test('retention appends one private facts-only line before removal, even if removal has to retry', async (t) => {
  const f = fixture(t), archive = join(f.home, 'archive'), file = join(archive, '2026-10.jsonl');
  const secret = 'Synthetic private body marker.';
  const longReason = 'é'.repeat(99) + '合'; // Crosses the byte limit inside a character.
  const dir = f.job({ ...state, exit_reason: longReason, started_at: ended, settled_at: ended, output_written: true }, {
    role: 'imp', cli: { agent: 'claude' }, model: 'example', thinking: 'high', project_root: '/synthetic/project',
    preset: 'default', used_place: 'claude example', attempts: [{ index: 0, place: 'pi example', reason: longReason, extra: secret }],
    checks: [secret], created_at: ended, read_at: ended, reaped_at: reaped, parent_job: 'j000000000000000a',
    repair_of: 'j000000000000000b', retry_of: 'j000000000000000c', package: 'archive', experiment: 'synthetic-speed', arm: 'control',
    sessions: [{ harness: 'claude', id: 'synthetic-claude', extra: secret }, { harness: 'pi', id: 'synthetic-pi', path: '/synthetic/history.jsonl' }],
    dispatcher: { harness: 'pi', session_id: 'synthetic-dispatcher', extra: secret },
    create_options: { task: secret }, request_key: secret,
    headless: true, ticket: 'sample/03', route: { tier: 'standard', mode: 'headless', reason: secret }, resume_s: 0,
  });
  const id = basename(dir);
  fs.mkdirSync(join(dir, 'qa'));
  for (const name of ['report.md', 'brief.md', 'qa/q1.md', 'qa/q1.answer.md']) fs.writeFileSync(join(dir, name), secret);
  const firstLand = '2026-11-01T00:00:00.000Z', secondLand = '2026-11-01T00:00:30.000Z';
  const asked = '2026-10-31T23:55:00.000Z', answered = '2026-10-31T23:57:00.000Z';
  for (const [name, at] of [['q1.md', asked], ['q1.answer.md', answered]]) {
    fs.utimesSync(join(dir, 'qa', name), Date.parse(at) / 1000, Date.parse(at) / 1000);
  }
  writeReportMeta(dir, reportSignature(dir), { summary: 'Delivered /home/synthetic/private.txt and ~/worker/report.md.' });
  fs.writeFileSync(join(dir, 'stdout.jsonl'), JSON.stringify({ type: 'result', result: secret, total_cost_usd: 0.12,
    usage: { input_tokens: 6, output_tokens: 9, cache_read_input_tokens: 0 } }) + '\n');
  fs.mkdirSync(join(f.home, 'flows'));
  const flow = `f${id.slice(1)}`, sha = 'abc1234'.repeat(5) + 'abc12';
  const flakyTest = 'npm run test:synthetic';
  for (const [name, facts] of [[flow, { state: 'failed', created_at: firstLand, repairs: [
    { step: 'cherry-pick', outcome: 'worker stopped', job: secret },
  ] }], [`${flow}-2`, { state: 'completed', created_at: secondLand, repairs: [{ step: 'gate[1]: build', outcome: 'gate passed' }], reruns: [
    { step: 'gate[1]: build', tests: [secret], rerun_ok: false, output_path: secret },
    { step: 'gate[2]: test', tests: [flakyTest], rerun_ok: true, output_path: secret },
    { step: 'gate[3]: check', tests: [], output_path: secret }, // No rerun verdict (e.g. timeout).
  ], landed_sha: sha, landed_at: reaped, updated_at: reaped }]]) {
    const receipt = join(f.home, 'flows', `${name}.json`);
    fs.writeFileSync(receipt, JSON.stringify({ job: id, ...facts }));
    fs.utimesSync(receipt, Date.parse(reaped) / 1000, Date.parse(reaped) / 1000);
  }
  fs.writeFileSync(join(dir, 'checks.json'), JSON.stringify({ state: 'done', turn: 'earlier', report_sig: 'earlier',
    results: [{ command: secret, exit_code: 1, output_tail: secret }] }));
  const labels = join(f.home, 'display', 'model-cache', 'decision-labels');
  fs.mkdirSync(labels, { recursive: true });
  const key = createHash('sha256').update(`thin-job:${id}:outcome`).digest('hex');
  fs.writeFileSync(join(labels, key + '.json'), JSON.stringify({ at: now, revision: String(Date.parse(ended)),
    answers: [{ kind: 'choice', name: 'outcome', choice: 'partial', confidence: 0.9, explanation: secret }] }));

  const first = f.start(clock + `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const rm = fs.rmSync;
fs.rmSync = (path, options) => {
  if (path === ${JSON.stringify(dir)}) {
    if (!fs.existsSync(${JSON.stringify(file)})) throw Error('archive missing at removal');
    throw Object.assign(Error('synthetic busy directory'), { code: 'EBUSY' });
  }
  return rm(path, options);
};
syncBuiltinESMExports();`);
  await first.exited;
  assert.equal(first.child.exitCode, 0);
  assert.match(f.log(), /synthetic busy directory/);
  assert.ok(fs.existsSync(join(dir, '.archived')));
  assert.equal(fs.statSync(archive).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const line = fs.readFileSync(file, 'utf8');
  assert.ok(line.endsWith('\n') && !line.includes(secret));
  assert.doesNotMatch(line, /\/home\/synthetic|~\/worker/);
  assert.equal(fs.statSync(join(dir, 'usage.json')).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(join(dir, 'stdout.jsonl')), false);
  assert.deepEqual(JSON.parse(line), {
    v: 1, job: id, archived_at: new Date(now).toISOString(), project: '/synthetic/project', role: 'imp',
    harness: 'claude', model: 'example', thinking: 'high', preset: 'default', used_place: 'claude example',
    attempts: [{ index: 0, place: 'pi example', reason: 'é'.repeat(99) }], dispatch_exit_code: 0,
    state: 'closed', exit_reason: 'é'.repeat(99), created_at: ended, started_at: ended, settled_at: ended,
    ended_at: ended, read_at: ended, reaped_at: reaped, checks: { passed: 0, total: 1, stale: true },
    repair_of: 'j000000000000000b', retry_of: 'j000000000000000c', parent_job: 'j000000000000000a', package: 'archive', outcome: 'partial',
    sessions: [{ harness: 'claude', id: 'synthetic-claude' }, { harness: 'pi', id: 'synthetic-pi', path: '/synthetic/history.jsonl' }],
    mode: 'headless', route: { tier: 'standard', mode: 'headless' }, ticket: 'sample/03', question_count: 1,
    dispatcher: { harness: 'pi', id: 'synthetic-dispatcher' }, output_written: true,
    questions: [{ id: 'q1', asked_at: asked, answered_at: answered }],
    experiment: 'synthetic-speed', arm: 'control',
    summary: 'Delivered <home path> and <home path>', usage: { input: 6, output: 9, cache_read: 0, cost_usd: 0.12 },
    land: { attempts: 2, state: 'completed', repairs: 2, reruns: 2, sha, created_at: secondLand, landed_at: reaped, updated_at: reaped,
      attempt_details: [
        { attempt: 1, state: 'failed', created_at: firstLand, repairs: 1, reruns: 0 },
        { attempt: 2, state: 'completed', created_at: secondLand, sha, landed_at: reaped, updated_at: reaped, repairs: 1, reruns: 2 },
      ],
      repair_details: [{ attempt: 1, step_kind: 'conflict', step: 'cherry-pick', outcome: 'worker stopped' },
        { attempt: 2, step_kind: 'gate', step: 'gate[1]: build', outcome: 'gate passed' }],
      rerun_details: [{ attempt: 2, step: 'gate[1]: build', passed_unchanged: false },
        { attempt: 2, step: 'gate[2]: test', passed_unchanged: true, tests: [flakyTest] }],
    },
  });
  const second = f.start(clock);
  await second.exited;
  assert.equal(second.child.exitCode, 0);
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(fs.readdirSync(join(f.home, 'flows')), []);
  assert.equal(fs.readFileSync(file, 'utf8'), line);
});

test('retention appends successive jobs without adding absent facts or changing earlier lines', async (t) => {
  const f = fixture(t), file = join(f.home, 'archive', '2026-11.jsonl');
  const dir = f.job({ state: 'failed', output_written: false }, { dispatch_exit_code: 1, dispatch_code: 'invalid_arguments', reaped_at: reaped });
  const other = f.job({ state: 'stopped' }, { model: null, thinking: null, bro: {} });
  fs.utimesSync(join(other, 'STATUS.json'), Date.parse(ended) / 1000, Date.parse(ended) / 1000);
  const run = f.start(clock);
  await run.exited;
  assert.equal(run.child.exitCode, 0);
  assert.ok(!fs.existsSync(dir) && !fs.existsSync(other));
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(lines, [
    { job: basename(dir), v: 1, archived_at: new Date(now).toISOString(), harness: 'pi',
      dispatch_exit_code: 1, dispatch_code: 'invalid_arguments', reaped_at: reaped, state: 'failed', question_count: 0, output_written: false },
    { job: basename(other), v: 1, archived_at: new Date(now).toISOString(), harness: 'bro', dispatch_exit_code: 0, state: 'stopped', question_count: 0 },
  ]);
});

test('failed archive append logs once per error and does not block either deletion', async (t) => {
  const f = fixture(t), dirs = [f.job(state), f.job(state)];
  fs.mkdirSync(join(f.home, 'archive', '2026-10.jsonl'), { recursive: true });
  const run = f.start(clock);
  await run.exited;
  assert.equal(run.child.exitCode, 0);
  assert.ok(dirs.every(dir => !fs.existsSync(dir)));
  assert.equal(f.log().split('\n').filter(line => /archive j\w+ failed: EISDIR/.test(line)).length, 1);
});
