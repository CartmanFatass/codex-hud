/** auto-route/04: a job's route as marks on Home, the reason and a headless job's live output in the Inspector, `g` on a headless card. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOW, TREE } from '../fixtures/project-page.mjs';
import { withState } from '../fixtures/state-helpers.mjs';
import { initialMonitorState, renderMonitor, handleMonitorInput } from '../../dist/render/monitor.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { outputLines, readHeadlessOutput } from '../../dist/collectors/headless-output.js';
import { PanelJobPipeline } from '../../dist/tree-page.js';
import { routeBadge } from '../../dist/render/worker-roster.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';

const route = (tier, mode, extra = {}) => ({ tier, mode, source: 'decision', reason: `${tier} work; ${mode} run`, ...extra });
const OUTPUT = { bytes: 900, lines: [
  { kind: 'tool', text: 'read src/synthetic.ts' }, { kind: 'say', text: 'The interval is read once at start.' },
  { kind: 'tool', text: 'bash npm run build' }, { kind: 'error', text: 'bash failed' }, { kind: 'say', text: 'Fixing the type error, then building again.' }] };

test('routeBadge is empty without a route or headless flag, and a route that chose headless marks it even without the flag', (t) => {
  const display = setDisplayConfig({ theme: 'none', icons: 'unicode' });
  t.after(() => setDisplayConfig(display));
  assert.equal(routeBadge({}), '');
  assert.equal(stripAnsi(routeBadge({ route: route('light', 'tab') })), '▂');
  assert.equal(stripAnsi(routeBadge({ route: route('hard', 'headless') })), '▆∅');
  assert.equal(stripAnsi(routeBadge({ headless: true })), '∅');
});

test('the Inspector shows the route words and reason, then a headless job\'s output with its last lines, live while it runs', (t) => {
  const display = setDisplayConfig({ theme: 'none', icons: 'unicode' });
  t.after(() => setDisplayConfig(display));
  const draw = (worker, board, lang, width, height = 40) => {
    const lane = board.lanes.find((l) => l.workers.includes(worker)), previous = setLanguage(lang);
    const state = withState(initialMonitorState(), { subpage: { kind: 'inspector', scroll: 0, target: { kind: 'worker', laneId: lane.id, workerId: worker.id } } });
    try { return renderMonitor({ tree: TREE, workboard: board, state, width, height, nowMs: NOW }).lines.map(stripAnsi); } finally { setLanguage(previous); }
  };
  for (const lang of ['en', 'zh']) for (const width of [100, 50]) {
    const f = fixture(t), board = f.board, worker = f.worker(HEADLESS);
    worker.output = { ...OUTPUT, lines: [...OUTPUT.lines, ...Array.from({ length: 20 }, (_, i) => ({ kind: 'say', text: `Later line ${i}` }))] };
    const lines = draw(worker, board, lang, width);
    for (const line of lines) assert.equal(visualLength(line), width, `${lang} ${width}: ${line}`);
    const text = lines.join('\n');
    assert.match(text, lang === 'en' ? /Route: light · headless/ : /分流：轻量 · 无界面/);
    if (width === 100) assert.match(text, / — light work; headless run/, 'the reason');
    assert.match(text, lang === 'en' ? /^Output ─+ live$/m : /^输出 ─+ 运行中$/m);
    assert.match(text, /▂∅/, 'the card header carries the marks');
    const shown = lines.filter((l) => /^ {2}Later line/.test(l));
    assert.equal(shown.length, 12, 'the newest 12 output rows');
    assert.match(shown.at(-1), /Later line 19/);
    assert.doesNotMatch(text, /read src\/synthetic/, 'older lines scroll off');
  }
  const f = fixture(t), board = f.board, worker = f.worker(HEADLESS);
  worker.output = OUTPUT;
  const text = draw(worker, board, 'en', 100).join('\n');
  assert.match(text, /^▸ read src\/synthetic\.ts/m);
  assert.match(text, /^ {2}The interval is read once at start\./m);
  assert.match(text, /^✗ bash failed/m);
  worker.output = { lines: [], bytes: 0 };
  assert.match(draw(worker, board, 'en', 100).join('\n'), /^ {2}No output yet/m);
  worker.output = { lines: [], bytes: 80 };
  assert.match(draw(worker, board, 'en', 100).join('\n'), /^ {2}Nothing displayable/m);
  worker.output = OUTPUT;
  Object.assign(worker, { settledAt: NOW - 60_000, state: 'done' });
  assert.doesNotMatch(draw(worker, board, 'en', 100).join('\n'), /^Output ─+ live$/m, 'a settled job is no longer live');
  assert.match(draw(worker, board, 'en', 100).join('\n'), /^Output ─+$/m);
  // A tab job has no Output section, and neither does a headless job whose output has not been read.
  delete worker.output;
  assert.doesNotMatch(draw(worker, board, 'en', 100).join('\n'), /Output/);
  const tab = f.worker(TAB);
  assert.doesNotMatch(draw(tab, board, 'en', 100).join('\n'), /Output/);
  assert.match(draw(tab, board, 'en', 100).join('\n'), /Route: hard · tab — hard work; tab run/);
});

/** Real job dirs, collected by the real collector: a headless job, a tab job and a settled headless job. */
const PANE = 'w4E:p1', HEADLESS = 'j00000000000000a1', TAB = 'j00000000000000b2', SETTLED = 'j00000000000000c3';
function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'headless-cards-'));
  const display = setDisplayConfig({ theme: 'terminal', icons: 'unicode' });
  t.after(() => { setDisplayConfig(display); fs.rmSync(home, { recursive: true, force: true }); });
  const put = (id, extra, status = { state: 'working' }, files = {}) => {
    const dir = join(home, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    const all = { 'job.json': { job: id, [id === HEADLESS ? 'caller_pane' : 'herdr_pane']: PANE, role: 'imp', package: id.slice(-2), created_at: new Date(NOW - 240_000).toISOString(), ...extra },
      'STATUS.json': status, 'brief.md': `# ${id.slice(-2).toUpperCase()}: synthetic job`, ...files };
    for (const [file, body] of Object.entries(all)) fs.writeFileSync(join(dir, file), typeof body === 'string' ? body : JSON.stringify(body));
    return dir;
  };
  put(HEADLESS, { headless: true, route: route('light', 'headless') }, { state: 'working' }, { 'stdout.jsonl': '' });
  put(TAB, { route: route('hard', 'tab') });
  put(SETTLED, { headless: true }, { state: 'closed', settled_at: new Date(NOW - 120_000).toISOString() }, { 'report.md': 'Done.' });
  const lanes = readThinJobs(home, { pane: PANE, project: null });
  const board = { revision: 'headless', lanes, workers: lanes.flatMap((l) => l.workers), decisions: [], coverage: { incomplete: false, diagnostics: [], workspace: null } };
  const worker = (id) => board.workers.find((w) => w.id === `thin-job:${id}`);
  const render = (state = initialMonitorState(), width = 80, lang = 'en') => {
    const previous = setLanguage(lang);
    try { return renderMonitor({ tree: TREE, workboard: board, state, width, height: 30, nowMs: NOW }); } finally { setLanguage(previous); }
  };
  return { home, board, worker, render, dir: (id) => join(home, 'jobs', id) };
}

test('the collector marks a headless job and keeps its route; a tab job has neither flag', (t) => {
  const f = fixture(t);
  assert.equal(f.worker(HEADLESS).headless, true);
  assert.deepEqual(f.worker(HEADLESS).route, route('light', 'headless'));
  assert.equal(f.worker(TAB).headless, undefined);
  assert.equal(f.worker(TAB).route.tier, 'hard');
});

test('outputLines reads pi events, Claude stream-json and plain text, and skips what it does not know', () => {
  const pi = [
    { type: 'session', id: 'synthetic' }, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } },
    { type: 'tool_execution_start', toolName: 'read', args: { path: 'src/a.ts', limit: 5 } },
    { type: 'tool_execution_start', toolName: 'bash', args: { command: 'npm   run\nbuild' } },
    { type: 'tool_execution_end', toolName: 'bash', isError: true },
    { type: 'tool_execution_end', toolName: 'read', isError: false },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'First.\n\nSecond.' }, { type: 'toolCall', name: 'read' }] } },
    { type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: 'not shown' }] } },
    { type: 'message_end', message: { role: 'assistant', content: [], errorMessage: 'rate limited' } },
  ].map((e) => JSON.stringify(e)).join('\n');
  assert.deepEqual(outputLines(pi), [
    { kind: 'tool', text: 'read src/a.ts' }, { kind: 'tool', text: 'bash npm run build' }, { kind: 'error', text: 'bash failed' },
    { kind: 'say', text: 'First.' }, { kind: 'say', text: 'Second.' }, { kind: 'error', text: 'rate limited' }]);
  const claude = [
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Read', input: { file_path: 'a.md' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'not shown' }] } },
    { type: 'result', is_error: true, result: 'Stopped by a synthetic limit' },
  ].map((e) => JSON.stringify(e)).join('\n');
  assert.deepEqual(outputLines(claude), [{ kind: 'tool', text: 'Read a.md' }, { kind: 'say', text: 'Looking.' }, { kind: 'error', text: 'Stopped by a synthetic limit' }]);
  assert.deepEqual(outputLines('plain line one\n\nplain line two\n{"unknown":"event"}'), [{ kind: 'say', text: 'plain line one' }, { kind: 'say', text: 'plain line two' }]);
  const many = Array.from({ length: 90 }, (_, i) => JSON.stringify({ type: 'tool_execution_start', toolName: 'read', args: { path: `f${i}` } })).join('\n');
  assert.equal(outputLines(many).length, 12);
  assert.equal(outputLines(many).at(-1).text, 'read f89');
  assert.ok(outputLines(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1000) }] } }))[0].text.length <= 240);
});

test('readHeadlessOutput reads from the end of the log, drops a half-read first line and an unfinished last line, and follows appends', (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'headless-output-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'stdout.jsonl'), call = (n) => JSON.stringify({ type: 'tool_execution_start', toolName: 'read', args: { path: `f${n}` } }) + '\n';
  assert.equal(readHeadlessOutput(dir), undefined, 'no log is unknown, not empty');
  fs.writeFileSync(file, '');
  assert.deepEqual(readHeadlessOutput(dir), { lines: [], bytes: 0 }, 'a log that exists and is empty is empty');
  fs.writeFileSync(file, call(1) + call(2) + call(3).slice(0, 20));
  assert.deepEqual(readHeadlessOutput(dir).lines.map((l) => l.text), ['read f1', 'read f2'], 'the line still being written waits');
  fs.appendFileSync(file, call(3).slice(20));
  assert.deepEqual(readHeadlessOutput(dir).lines.map((l) => l.text), ['read f1', 'read f2', 'read f3'], 'and shows once it is whole');
  assert.equal(readHeadlessOutput(dir), readHeadlessOutput(dir), 'an unchanged log is not read again');
  // A log far longer than the window: only the tail, and the line the window cut in half is not shown as text.
  fs.writeFileSync(file, JSON.stringify({ type: 'tool_execution_end', toolName: 'x', output: 'y'.repeat(300_000) }) + '\n' + call(7) + call(8));
  assert.deepEqual(readHeadlessOutput(dir).lines.map((l) => l.text), ['read f7', 'read f8']);
  fs.writeFileSync(file, call(1) + JSON.stringify({ type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: 'z'.repeat(300_000) }] } }) + '\n');
  assert.deepEqual(readHeadlessOutput(dir).lines, [], 'one event longer than the window leaves nothing to show, never half of it');
  // A symlink is not followed.
  fs.rmSync(file);
  fs.writeFileSync(join(dir, 'elsewhere'), call(9));
  fs.symlinkSync(join(dir, 'elsewhere'), file);
  assert.equal(readHeadlessOutput(dir), undefined);
});

test('the panel pipeline gives only the job open in the Inspector its output, and a new collect brings the new lines', async (t) => {
  const f = fixture(t), id = `thin-job:${HEADLESS}`, log = join(f.dir(HEADLESS), 'stdout.jsonl');
  const call = (n) => JSON.stringify({ type: 'tool_execution_start', toolName: 'read', args: { path: `f${n}` } }) + '\n';
  const pipeline = new PanelJobPipeline(f.home, { pane: PANE, project: null }, NOW - 3_600_000);
  t.after(() => pipeline.dispose());
  const collect = async (inspecting) => { await pipeline.refresh(inspecting); return pipeline.workboard(TREE).workers.find((w) => w.id === id); };
  fs.writeFileSync(log, call(1));
  assert.equal((await collect()).output, undefined, 'a job nobody inspects is not read');
  assert.equal((await collect(`thin-job:${TAB}`)).output, undefined);
  assert.deepEqual((await collect(id)).output.lines, [{ kind: 'tool', text: 'read f1' }]);
  assert.equal((await collect(id)).headless, true);
  const events = [
    { event: 'init', conversation_id: 'synthetic' },
    { event: 'step_update', step_update: { step_index: 1, tool_info: { name: 'read_file', parameters: { Path: 'f2' } } } },
    { event: 'step_update', step_update: { step_index: 2, text_delta: 'Read the file.' } },
    { event: 'result', result: { response: '', error: 'Synthetic interruption' } },
  ];
  fs.appendFileSync(log, events.map(e => JSON.stringify(e) + '\n').join(''));
  assert.deepEqual((await collect(id)).output.lines, [
    { kind: 'tool', text: 'read f1' }, { kind: 'tool', text: 'read_file f2' },
    { kind: 'say', text: 'Read the file.' }, { kind: 'error', text: 'Synthetic interruption' },
  ], 'the live Inspector follows Antigravity step and result records');
  await pipeline.refresh(`thin-job:${TAB}`);
  assert.equal(pipeline.workboard(TREE).workers.find((w) => w.id === `thin-job:${TAB}`).output, undefined, 'a tab job never gets one');
});
