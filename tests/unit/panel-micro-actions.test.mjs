import { withState } from '../fixtures/state-helpers.mjs';
/** The owner's micro-actions on a HUD job from the panel (spec §2.2): `g` its tab, `1`–`4` / `d` on its expanded question to answer, `X` to stop. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOW, TREE, plain } from '../fixtures/project-page.mjs';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { answerJobQuestion, PanelActionLog, PANEL_ACTIONS_FILE } from '../../dist/collectors/panel-actions.js';
import { focusJobTab, stopJob } from '../../dist/cli/panel-pane.js';
import { watchCommand } from '../../dist/cli/watch.js';
import { renderMonitor, initialMonitorState, handleMonitorInput } from '../../dist/render/monitor.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { targetKey } from '../../dist/collectors/workboard-types.js';

const PANE = 'w4E:p1', ASKING = 'j0123456789abcdef', RUNNING = 'j1111111111111111', DONE = 'j2222222222222222';
const QUESTION = '# Question q1 from imp@demo\n\nKeep the v1 shim for one more release?\n\nOptions:\n- keep it\n- remove it now\n\nDefault if unanswered: keep it\n\nContext: the parser still reads v1\n';
const decoder = new WorkbenchInputDecoder('workboard');
/** What the panel's own keyboard hands over for these bytes. */
const key = (bytes) => decoder.push(Buffer.from(bytes))[0];

function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'micro-actions-'));
  const display = setDisplayConfig({ theme: 'terminal', icons: 'unicode' });
  t.after(() => { setDisplayConfig(display); fs.rmSync(home, { recursive: true, force: true }); });
  const put = (id, role, status, extra = {}) => {
    const dir = join(home, 'jobs', id);
    fs.mkdirSync(join(dir, 'qa'), { recursive: true });
    const files = { 'job.json': { job: id, herdr_pane: PANE, role, package: role.toUpperCase(), created_at: new Date(NOW - 240_000).toISOString() },
      'STATUS.json': status, 'brief.md': `# ${role.toUpperCase()}: synthetic job`, ...extra };
    for (const [file, body] of Object.entries(files)) {
      fs.mkdirSync(join(dir, file, '..'), { recursive: true });
      fs.writeFileSync(join(dir, file), typeof body === 'string' ? body : JSON.stringify(body));
      fs.utimesSync(join(dir, file), new Date(NOW - 240_000), new Date(NOW - 240_000));
    }
    return dir;
  };
  put(ASKING, 'imp', { state: 'working' }, { 'qa/q1.md': QUESTION });
  put(RUNNING, 'reviewer', { state: 'working' });
  put(DONE, 'sonic', { state: 'closed' }, { 'report.md': 'Done.' });
  const lanes = readThinJobs(home, { pane: PANE, project: null });
  const board = { revision: 'micro', lanes, workers: lanes.flatMap((l) => l.workers), decisions: [], coverage: { incomplete: false, diagnostics: [], workspace: null } };
  const worker = (id) => board.workers.find((w) => w.id === `thin-job:${id}`);
  const render = (state = initialMonitorState(), width = 60, lang = 'en', height = 30) => {
    const language = setLanguage(lang);
    try { return renderMonitor({ tree: TREE, workboard: board, state, width, height, nowMs: NOW }); } finally { setLanguage(language); }
  };
  /** Select a job's card, draw, press one key and draw again: the outcome and the frame it leaves. */
  const press = (id, bytes, state = {}) => {
    const w = worker(id);
    const frame = render(withState(initialMonitorState(), { home: { cursor: { kind: 'work', target: { kind: 'worker', laneId: w.laneId, workerId: w.id } } } }, state));
    const out = handleMonitorInput(frame.state, typeof bytes === 'string' ? key(bytes) : bytes, { tree: TREE, frame, nowMs: NOW });
    return { out, frame: render(out.state, 60, 'en') };
  };
  return { home, board, worker, render, press, dir: (id) => join(home, 'jobs', id) };
}

test('answerJobQuestion writes qN.answer.md once with mode 0600 and records it; bad ids, a missing question and a second answer change nothing', (t) => {
  const f = fixture(t), file = join(f.dir(ASKING), 'qa/q1.answer.md');
  assert.deepEqual(answerJobQuestion(f.home, ASKING, 'q1', ' keep it \n', 'imp'), { ok: true, written: true });
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep it');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(answerJobQuestion(f.home, ASKING, 'q1', 'remove it now'), { ok: true, written: false });
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep it', 'the first answer stands');
  for (const [job, qid, answer] of [['../x', 'q1', 'a'], [ASKING, 'q1/../../x', 'a'], [ASKING, 'q9', 'a'], [ASKING, 'q1', '  ']])
    assert.equal(answerJobQuestion(f.home, job, qid, answer).ok, false, `${job} ${qid}`);
  assert.equal(fs.existsSync(join(f.dir(ASKING), 'qa/q9.answer.md')), false);
  const log = fs.readFileSync(join(f.home, PANEL_ACTIONS_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 1, 'only the answer that was written is recorded');
  assert.deepEqual({ ...log[0], at: undefined }, { at: undefined, type: 'answer', job: ASKING, qid: 'q1', role: 'imp', answer: 'keep it' });
  assert.equal(fs.statSync(join(f.home, PANEL_ACTIONS_FILE)).mode & 0o777, 0o600);
});

test('PanelActionLog tells only of answers made after it started, for the jobs it follows, once', (t) => {
  const f = fixture(t);
  fs.writeFileSync(join(f.dir(ASKING), 'qa/q2.md'), QUESTION);
  assert.equal(answerJobQuestion(f.home, ASKING, 'q1', 'before', 'imp').ok, true);
  const log = new PanelActionLog(f.home);
  assert.deepEqual(log.changes(new Set([ASKING])), []);
  assert.equal(answerJobQuestion(f.home, ASKING, 'q2', 'remove it now\nnow', 'imp').ok, true);
  assert.deepEqual(log.changes(new Set([RUNNING])), [], 'another session\'s job is not this one\'s news');
  assert.deepEqual(log.changes(new Set([ASKING])), [], 'and it is read once');
  fs.writeFileSync(join(f.dir(ASKING), 'qa/q3.md'), QUESTION);
  answerJobQuestion(f.home, ASKING, 'q3', 'keep it', 'imp');
  assert.deepEqual(log.changes(new Set([ASKING])), [`[imp@${ASKING}] ANSWERED q3 from panel: keep it`]);
  // A line still being written waits for its newline.
  fs.appendFileSync(join(f.home, PANEL_ACTIONS_FILE), JSON.stringify({ type: 'answer', job: ASKING, qid: 'q4', role: null, answer: 'late' }));
  assert.deepEqual(log.changes(new Set([ASKING])), []);
  fs.appendFileSync(join(f.home, PANEL_ACTIONS_FILE), '\n');
  assert.deepEqual(log.changes(new Set([ASKING])), [`[job@${ASKING}] ANSWERED q4 from panel: late`]);
});

test('hud watch tells the main session what the owner answered from the panel', { timeout: 10000 }, async (t) => {
  const f = fixture(t), lines = [], ac = new AbortController();
  t.after(() => ac.abort());
  const running = watchCommand([], { env: { HUD_HOME: f.home, HERDR_PANE_ID: PANE }, stdout: (s) => lines.push(s.trim()), stderr: () => {} }, { signal: ac.signal, rescanMs: 60 });
  await new Promise((r) => setTimeout(r, 200));
  lines.length = 0;
  answerJobQuestion(f.home, ASKING, 'q1', 'remove it now', 'imp');
  const end = Date.now() + 4000;
  while (!lines.some((l) => l.includes('ANSWERED')) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  ac.abort();
  await running;
  assert.deepEqual(lines.filter((l) => l.includes('ANSWERED')), [`[imp@${ASKING}] ANSWERED q1 from panel: remove it now`]);
});

function stubs(t, { herdr = 0, reap = 0 } = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'micro-stubs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = (name, code) => { fs.writeFileSync(join(dir, name), `#!/bin/sh\necho "$@" >> "${join(dir, name)}.log"\nexit ${code}\n`, { mode: 0o700 }); };
  make('herdr', herdr);
  make('pi-role-reap', reap);
  const log = (name) => { try { return fs.readFileSync(join(dir, `${name}.log`), 'utf8').trim().split('\n'); } catch { return []; } };
  return { env: { PATH: dir }, log };
}

test('focusJobTab runs herdr tab focus with the TAB of SESSION.txt and says why it could not', async (t) => {
  const f = fixture(t), s = stubs(t), dir = f.dir(RUNNING);
  assert.deepEqual(await focusJobTab(dir, s.env), { ok: false, reason: 'no tab' });
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'TASK=x\nTAB=w4E:t7\nTAB_NAME=job\n');
  assert.deepEqual(await focusJobTab(dir, s.env), { ok: true });
  assert.deepEqual(s.log('herdr'), ['tab focus w4E:t7']);
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'TAB=\x07bad\n');
  assert.deepEqual(await focusJobTab(dir, s.env), { ok: false, reason: 'no tab' });
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'TAB=w4E:t7\n');
  assert.deepEqual(await focusJobTab(dir, stubs(t, { herdr: 1 }).env), { ok: false, reason: 'tab closed' });
  assert.deepEqual(await focusJobTab(dir, { PATH: join(f.home, 'nowhere') }), { ok: false, reason: 'unavailable' });
});

test('stopJob reaps the job directory, and first asks a CLI job already in its idle grace to quit', async (t) => {
  const f = fixture(t), s = stubs(t), dir = f.dir(RUNNING);
  assert.deepEqual(await stopJob(dir, s.env), { ok: true });
  assert.deepEqual(s.log('pi-role-reap'), [dir]);
  assert.equal(fs.existsSync(join(dir, 'STATUS.json.close-requested')), false, 'a working job is only reaped');
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job: RUNNING, cli: { agent: 'claude' } }));
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
  assert.deepEqual(await stopJob(dir, s.env), { ok: true });
  assert.equal(fs.statSync(join(dir, 'STATUS.json.close-requested')).mode & 0o777, 0o600);
  assert.deepEqual(await stopJob(dir, s.env), { ok: true }, 'a close request that is already there is fine');
  assert.deepEqual(await stopJob(dir, stubs(t, { reap: 3 }).env), { ok: false, reason: 'reap failed' });
});
