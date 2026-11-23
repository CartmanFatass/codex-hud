import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main } from '../../dist/cli/hud-main.js';
import { reportSignature, turnToken } from '../../dist/roles/cli-turn.js';
import { readProcStat } from '../../dist/utils/proc.js';

const id = 'j0000000000000001', sent_at = '2026-01-01T00:00:00Z';
function fixture(t, job = {}, status = { state: 'working', harness: 'pi' }) {
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-doctor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = join(home, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, text) => {
    const file = join(dir, name);
    fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text));
  };
  write('job.json', { job: id, role: 'imp', project_root: '/tmp/synthetic-project', ...job });
  write('STATUS.json', status);
  return { dir, write, run: async (args = ['doctor', id]) => {
    let stdout = '', stderr = '';
    const code = await main(args, { env: { HUD_HOME: home }, stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
    return { code, stdout, stderr };
  } };
}

function snapshot(root) {
  return ['', ...fs.readdirSync(root, { recursive: true }).sort()].map((name) => {
    const file = join(root, name), st = fs.statSync(file, { bigint: true });
    return { name, size: st.size, mtime: st.mtimeNs, contents: st.isFile() ? fs.readFileSync(file) : null };
  });
}

test('doctor shows stale and current CLI bindings and leaves a failed job untouched', async (t) => {
  const { dir, write, run } = fixture(t, {
    cli: { agent: 'claude' }, used_place: 'claude (synthetic/model)', checks: ['synthetic-check'],
    attempts: [{ index: 0, place: 'claude (synthetic/model)' }], worktree: { root: '/tmp/synthetic-worktree' },
  }, { state: 'failed', harness: 'cli', exit_reason: 'Synthetic failure', future_field: { nested: ['keep', 42] },
    pid: process.pid, pid_start_time: readProcStat(process.pid).start });
  const turn = { seq: 3, sent_at, report_sig: null };
  write('turn.json', turn);
  write('report.md', 'Synthetic initial report body.');
  const done = { ...turn, at: sent_at, report_sig: reportSignature(dir) };
  write('done.json', done);
  const checks = { turn: turnToken(turn), report_sig: done.report_sig, state: 'done',
    results: [{ command: 'synthetic-check', exit_code: 0 }] };
  write('checks.json', checks);
  write('report.md', 'Synthetic updated report body.');
  write('progress.jsonl', [JSON.stringify({ at: sent_at, text: 'Synthetic first' }),
    JSON.stringify({ at: sent_at, text: 'Synthetic last' })].join('\n') + '\n');
  write('supervisor.pid', String(process.pid));
  write('STATUS.json.stop-requested', '');
  fs.mkdirSync(join(dir, 'qa'));
  write('qa/q2.md', 'Synthetic question');
  write('qa/q3.md', 'Synthetic answered question');
  write('qa/q3.answer.md', 'Synthetic answer');
  const before = snapshot(dir);
  const { code, stdout, stderr } = await run();
  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.deepEqual(snapshot(dir), before);
  for (const expected of [/^identity: .*"agent":"claude".*"used_place":/m, /^shared: .*"display_state":"failed"/m,
    /^turn: .*"seq":3/m, /"changed_since_turn":true/, /"for_current_turn":true.*"matches_report_on_disk":false/,
    /^questions: \["q2"\]/m, /"bound_to_current_report":false/, /"future_field": \{\s+"nested": \[\s+"keep",\s+42/,
    /stop_requested":"present".*close_requested":"missing"/, /supervisor.*alive \(PID only\).*worker.*"liveness":"alive"/,
    /^progress: .*Synthetic last/m, /done\.json report_sig differs from the current report\.md signature/]) assert.match(stdout, expected);
  assert.doesNotMatch(stdout, /Synthetic (updated report body|first)/);
  const report_sig = reportSignature(dir);
  write('done.json', { ...done, seq: 2, report_sig });
  const wrongTurn = (await run()).stdout;
  assert.match(wrongTurn, /"for_current_turn":false.*"matches_report_on_disk":true/);
  assert.match(wrongTurn, /done\.json seq 2 differs from turn\.json seq 3/);
  write('done.json', { ...done, report_sig });
  write('checks.json', { ...checks, report_sig });
  const fresh = (await run()).stdout;
  assert.match(fresh, /"for_current_turn":true.*"matches_report_on_disk":true/);
  assert.match(fresh, /"bound_to_current_report":true/);
});

for (const [name, job, harness] of [
  ['pi', {}, 'pi'], ['headless sonic', { role: 'sonic', headless: true }, 'pi'], ['browser', { bro: {} }, 'bro'],
]) test(`doctor handles a ${name} job without CLI artifacts`, async (t) => {
  const { run } = fixture(t, job, { state: 'working', harness, ...(job.headless ? {
    pid: process.pid, pid_start_time: readProcStat(process.pid).start,
  } : {}) });
  const { code, stdout } = await run();
  assert.equal(code, 0);
  assert.match(stdout, /^shared: .*"display_state":"working"/m);
  assert.match(stdout, /^turn: n\/a\nreceipt: n\/a$/m);
  if (job.headless) {
    assert.match(stdout, /^identity: .*"role":"sonic".*"headless":true/m);
    assert.match(stdout, /supervisor_pid_file":"missing".*worker.*"liveness":"alive"/);
  }
  if (job.bro) assert.doesNotMatch(stdout, /^processes:/m);
});

test('doctor labels missing, corrupt and oversize records', async (t) => {
  const { dir, run, write } = fixture(t, { cli: { agent: 'claude' } });
  for (const body of ['{', ' '.repeat(64 * 1024) + '{}', null]) {
    if (body === null) fs.unlinkSync(join(dir, 'STATUS.json')); else write('STATUS.json', body);
    write('turn.json', '{');
    write('report.md', 'x'.repeat(64 * 1024 + 1));
    const { code, stdout, stderr } = await run();
    assert.equal(code, 0);
    assert.equal(stderr, '');
    assert.match(stdout, body === null ? /^status: missing$/m : /^status: unreadable$/m);
    assert.match(stdout, /^report: unreadable\nturn: unreadable\nreceipt: missing$/m);
  }
});

test('doctor validates its id and appears in help', async (t) => {
  const { run } = fixture(t);
  assert.match((await run(['help'])).stdout, /hud doctor <jobId>/);
  for (const [args, code, reason] of [[[], 2, /^Usage:/], [['../job'], 2, /^invalid_job_id:/],
    [['j0000000000000002'], 1, /^job_not_found:/]]) {
    const result = await run(['doctor', ...args]);
    assert.equal(result.code, code);
    assert.match(result.stderr, reason);
  }
});
