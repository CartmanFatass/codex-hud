/** home-compact/02 and /03: one row per job on Classic Home (glyph, id, stage strip, executor group, ⚡N, age, silence; a reason for a job that needs the owner), a running job's sentence under it, a header only for a lane of several jobs, folded queued and finished jobs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jobsBoard, jobFrame, jobFrames, narrowBoard, NOW } from '../fixtures/home-jobs.mjs';
import { initialMonitorState, renderMonitor, handleMonitorInput } from '../../dist/render/monitor.js';
import { withState } from '../fixtures/state-helpers.mjs';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { ticketTitle } from '../../dist/collectors/ticket-title.js';
import { targetKey } from '../../dist/collectors/workboard-types.js';
import { workStateGlyph } from '../../dist/render/work-card.js';
import { stageCells } from '../../dist/render/job-stages.js';
import { homeRows } from '../../dist/render/home-view.js';
import { theme } from '../../dist/render/colors.js';

const expected = JSON.parse(fs.readFileSync(new URL('../fixtures/home-jobs-frames.json', import.meta.url), 'utf8'));

test('a busy run of 14 jobs: frames in EN/ZH at 120, 80, 50 and 42 columns, none wider than the panel, no title on any job row', () => {
  const frames = jobFrames();
  assert.deepEqual(frames, expected);
  const titles = [...new Set(jobsBoard().workers.map((w) => w.ticketTitle))].filter((title) => title && title !== 'Queued synthetic ticket' && title !== 'Finished synthetic ticket');
  for (const [name, lines] of Object.entries(frames)) {
    const width = Number(name.split('-')[1]);
    for (const line of lines) assert.ok(visualLength(line) <= width, `${name}: ${line}`);
    assert.doesNotMatch(lines.join('\n'), /Implement the synthetic ticket/, `${name}: the raw task text is never a title`);
    if (name.startsWith('en-') && !name.endsWith('routes')) {
      const shown = titles.filter((title) => lines.some((l) => l.includes(title.slice(0, 12))));
      assert.deepEqual(shown, ['Cache the tsc project graph'], `${name}: only the lane header names a ticket`);
    }
  }
});

test('a job row is its state glyph, ticket id, stage strip, executor group, ⚡N and age (and silence); a child under a header repeats the id', () => {
  const lines = jobFrame(80);
  const row = (id) => lines.find((l) => l.includes(`${id} `) && /[●◐○]{5}/.test(l));
  assert.match(row('metrics-lite/01'), /^◉ {2}metrics-lite\/01 {2}●◐○○○ {2}✦◎◕ ⚡2 +6m quiet 4m$/);
  assert.match(lines.find((l) => /^ {2}◉ {2}perf-ts\/05 .*14m$/.test(l)), /^ {2}◉ {2}perf-ts\/05 {5}●●◐○○ {2}⚒◎◕ ⚡1 +14m$/, 'the imp under the header: id, strip, role + provider + effort, helper count');
  assert.match(lines.find((l) => /^ {2}◉ {2}perf-ts\/05 .*3m$/.test(l)), /^ {2}◉ {2}perf-ts\/05 {5}◐○○○○ {2}⚖✻● +3m$/, 'the reviewer: another role icon, the read cell current');
  assert.equal(lines.filter((l) => /^\S+\/\d\d /.test(l)).length, 1, 'a header only where a lane shows several jobs');
  const column = lines.filter((l) => /[●◐○]{5}/.test(l)).map((l) => visualLength(l.slice(0, l.search(/[●◐○]{5}/))));
  assert.equal(column.length, 7, 'seven rows carry a strip: the folded and the reasoned ones do not');
  assert.equal(new Set(column).size, 1, `one strip column: ${column}`);
  assert.doesNotMatch(lines.join('\n'), /gate\[|land ·|落地 ·|cherry-pick/, 'a land has no sub-row on Home');
  for (const id of ['stream-sync/05', 'stream-sync/06', 'auth-refresh/04']) assert.match(lines.find((l) => l.includes(`${id} `)), /●●●●◐/, `${id}: the land is the strip's 5th cell`);
});

test('the stage cells come from the report, the checks receipt, the land flow and the job’s stage; what the card cannot know is unknown', () => {
  const cells = (w) => stageCells(w).map((c) => ({ passed: '●', current: '◐', todo: '○', unknown: '?' })[c]).join('');
  const running = { state: 'working', settledAt: null };
  assert.equal(cells(running), '???○○', 'no stage: read, edit and test are unknown');
  for (const [stage, want] of [['read', '◐○○○○'], ['edit', '●◐○○○'], ['test', '●●◐○○']]) assert.equal(cells({ ...running, stage }), want, stage);
  assert.equal(cells({ ...running, files: [{ kind: 'report' }] }), '●●●◐○', 'a report written while the job still runs');
  assert.equal(cells({ ...running, stage: 'edit', settledAt: 1, state: 'done' }), '●●●●○', 'a settled job: the report is in, the land is not');
  const checks = (o) => ({ state: 'done', settledAt: 1, checks: { state: 'done', stale: false, passed: 2, total: 2, ...o } });
  assert.equal(cells(checks({})), '●●●●○');
  assert.equal(cells(checks({ passed: 1 })), '●●◐●○', 'a check failed: still in test');
  assert.equal(cells(checks({ state: 'running' })), '●●◐●○');
  assert.equal(cells(checks({ passed: 1, stale: true })), '●●●●○', 'a receipt of an older report says nothing');
  const flow = (state) => ({ state: 'done', settledAt: 1, flow: { kind: 'land', state, steps: [], updatedAt: 1 } });
  assert.equal(cells(flow('running')), '●●●●◐');
  assert.equal(cells(flow('queued')), '●●●●◐');
  assert.equal(cells(flow('completed')), '●●●●●');
  assert.equal(cells(flow('failed')), '●●●●○');
  assert.equal(cells({ state: 'queued', settledAt: null }), '○○○○○');
});

test('a job that needs the owner shows the reason where the strip would be: the question, the failure, the red gate, the unread report', () => {
  const board = jobsBoard(), byId = (id) => board.workers.find((w) => w.displayId === id);
  byId('cache-v1/06').reportUnread = true;
  Object.assign(byId('auth-refresh/04'), { flow: { kind: 'land', state: 'failed', steps: [{ key: 'gate', state: 'failed' }, { key: 'merge', state: 'pending' }], step: 'gate[2]: npm run test:mjs', updatedAt: NOW - 60_000 } });
  const lines = jobFrame(80, 'en', board);
  const asking = lines.findIndex((l) => l.startsWith('?  cache-v2/03'));
  assert.match(lines[asking], /^\? {2}cache-v2\/03 {2}asks 2 opts +⚡1 4m$/, 'the row: asks, its option count');
  assert.match(lines[asking + 1], /^ {3}Keep fallback TTL scan on startup\?\s*$/, 'and the question under it');
  assert.match(lines.find((l) => l.startsWith('✗  export-csv/02')), /^✗ {2}export-csv\/02 {4}✗ HTTP 429 rate limit; no report written +9m$/);
  assert.match(lines.find((l) => /^✓ {2}auth-refresh\/04/.test(l)), /^✓ {2}auth-refresh\/04 {2}✗ gate red +4m$/);
  assert.match(lines.find((l) => /^✓● cache-v1\/06/.test(l)), /^✓● cache-v1\/06 {6}● report unread +3m$/);
  const zh = jobFrame(80, 'zh', Object.assign(jobsBoard('zh'), {}));
  assert.match(zh.find((l) => l.startsWith('?  cache-v2/03')), /^\? {2}cache-v2\/03 {2}问 2选 +⚡1 4分$/);
  const unread = jobFrame(80, 'zh', (() => { const b = jobsBoard('zh'); b.workers.find((w) => w.displayId === 'cache-v1/06').reportUnread = true; return b; })());
  assert.match(unread.find((l) => /^✓● cache-v1\/06/.test(l)), /● 报告未读 +3分$/);
  for (const line of [...lines, ...zh]) if (/asks|问 |✗ |report unread/.test(line)) assert.doesNotMatch(line, /[●◐○]{5}/, 'no strip beside a reason');
  // Enter opens the question into the slab; a row of its own again once closed.
  const key = targetKey({ kind: 'worker', laneId: jobsBoard().lanes[0].id, workerId: jobsBoard().workers[0].id });
  const slab = jobFrame(80, 'en', jobsBoard(), withState(initialMonitorState(), { home: { expanded: new Set([key]) } }));
  assert.ok(slab.some((l) => l.startsWith('┃ Keep fallback TTL scan on startup?')) && !slab.some((l) => l.includes('asks 2 opts')), 'the opened question is the slab, not a row');
});

test('the silence shows from 3 minutes without output, dim, and amber once the card calls the job stalled', (t) => {
  const quietBoard = (minutes) => { const b = jobsBoard(); b.workers.find((w) => w.displayId === 'metrics-lite/01').work.activityAt = NOW - minutes * 60_000 - 5000; return b; };
  const row = (minutes, lang = 'en') => jobFrame(80, lang, quietBoard(minutes)).find((l) => l.includes('metrics-lite/01 '));
  assert.doesNotMatch(row(2), /quiet/, '2 minutes is not silence');
  assert.match(row(3), / 6m quiet 3m$/);
  assert.match(row(3, 'zh'), / 6分 静3分$/);
  assert.match(row(10), /○○○○○.*quiet 10m$/, 'the stall threshold hides a stage from the previous snapshot');
  assert.doesNotMatch(jobFrame(80).find((l) => l.includes('perf-ts/05 ') && l.endsWith('14m')), /quiet/, 'a job that just wrote has none');
  assert.doesNotMatch(jobFrame(80).find((l) => l.includes('stream-sync/05 ')), /quiet/, 'a settled job has none');
  const display = setDisplayConfig({ theme: 'terminal', icons: 'unicode' });
  t.after(() => setDisplayConfig(display));
  const raw = (board) => homeRows(board, initialMonitorState(), 80, NOW, { tree: { nodes: [] }, workboard: board, state: initialMonitorState(), width: 80, height: 40, nowMs: NOW }).map((r) => r.text);
  const { muted, stalled } = theme.board;
  assert.ok(raw(quietBoard(4)).some((l) => l.includes(muted('quiet 4m'))), '4 minutes: dim');
  assert.ok(raw(jobsBoard()).some((l) => l.includes(stalled('quiet 12m'))), '12 minutes: past the stalled limit, amber');
  assert.ok(!raw(jobsBoard()).some((l) => l.includes(muted('quiet 12m'))));
});

test('a running job’s current sentence sits dim under its row: one line, two from 100 columns, none without one, never the ticket title', () => {
  const at = (frame, id) => frame.findIndex((l) => l.includes(`${id} `) && /[●◐○]{5}/.test(l));
  const wide = jobFrame(120), narrow = jobFrame(80), tight = jobFrame(42, 'zh');
  const imp = at(wide, 'perf-ts/05');
  assert.deepEqual(wide.slice(imp + 1, imp + 3).map((l) => l.trimEnd()), ['     Rewriting the graph cache invalidation, then adding its eviction test to the tsc suite so a stale project graph can', '     never be served after a config change'], 'two lines at 120 columns');
  assert.match(narrow[at(narrow, 'perf-ts/05') + 1], /^ {5}Rewriting the graph cache invalidation, then adding its eviction test to t…\s*$/, 'one line at 80, cut with …');
  assert.match(narrow[at(narrow, 'metrics-lite/01') + 1], /^ {3}Trimming the idle poll interval in the watcher\s*$/, 'under the id, dim');
  assert.match(narrow[narrow.findIndex((l) => l.includes('perf-ts/05 ') && l.includes('3m')) + 1], /^ {5}Reading the cache diff against the ticket\s*$/, 'the job’s own latest progress line when no model sentence');
  const docs = at(narrow, 'docs-sweep/04');
  assert.match(narrow[docs + 1], /^✗ /, 'no sentence, no row');
  for (const id of ['stream-sync/05', 'auth-refresh/04', 'export-csv/02']) assert.match(narrow[at(narrow, id) + 1] ?? narrow[narrow.findIndex((l) => l.includes(id)) + 1], /^\S/, `${id}: a settled job keeps its folds, no sentence`);
  assert.match(tight[at(tight, 'perf-ts/05') + 1], /…\s*$/, 'cut to fit at 42');
  assert.ok(!narrow.some((l) => /^ {3,5}Cache the tsc project graph/.test(l)), 'never the ticket title');
});

test('as a row narrows the right side loses the route marks, the model, the role, ⚡N and the silence; the id, the strip and the age stay', () => {
  const board = narrowBoard();
  const rows = (width) => jobFrame(width, 'en', board);
  for (const width of [48, 42]) {
    const lines = rows(width);
    for (const id of ['auto-route/08', 'hud-doctor/01', 'statusline-workers/03', 'docs-sweep/04']) assert.match(lines.find((l) => l.includes(`${id} `)), /[●◐○]{5}.* \d+m(?: quiet \d+m)?$/, `${width} ${id}: id, strip and age stay`);
    assert.match(lines.find((l) => /export-csv\/02/.test(l)), / ✗ HTTP .* 9m$/, `${width}: the failure's reason stays`);
  }
  const [wide, narrow] = [rows(48), rows(42)], row = (lines, id) => lines.find((l) => l.includes(`${id} `));
  assert.match(row(wide, 'auto-route/08'), /●●◐○○ {2}⚒◎◕ ▆∅ ⚡2 +0m$/, '48: nothing dropped');
  assert.match(row(narrow, 'auto-route/08'), /●●◐○○ {2}⚒ ⚡2 +0m$/, '42: the route marks and the model went; the helper count and the role stay');
  assert.match(row(wide, 'statusline-workers/03'), /●◐○○○ {2}⚒◎◕ 6m quiet 5m$/, '48, a 21-cell id: the route marks went before the model');
  assert.match(row(narrow, 'statusline-workers/03'), /●◐○○○ +6m$/, '42: the model, the role and last the silence went');
  assert.match(row(narrow, 'docs-sweep/04'), /◐○○○○ +6m$/);
  assert.match(jobFrame(42).find((l) => l.includes('metrics-lite/01 ')), /●◐○○○ {2}⚡2 6m quiet 4m$/, '42, a quiet sonic parent: the role went, the helper count and the silence stay');
  assert.match(row(wide, 'docs-sweep/04'), /◐○○○○ {2}✦✻● 6m quiet 4m$/);
});

test('at 80 columns the 14 jobs take 16 rows (38 before 02), the sentences and the question included; folds list their ids', () => {
  const lines = jobFrame(80);
  assert.equal(lines.length - 2, 16, 'after the summary row and its blank line: 15 rows plus the asking job’s question');
  assert.equal(lines.find((l) => l.startsWith('○')), '○  queued 3 · cache-v2/04 · export-csv/03 · auth-refresh/05');
  assert.match(lines.find((l) => l.startsWith('✓  done')), /^✓ {2}done 2 · cache-v1\/06 · export-csv\/01/);
  assert.match(jobFrame(50).find((l) => l.startsWith('○')), / \+1$/, 'ids that do not fit are +N');
  assert.match(jobFrame(80, 'zh').find((l) => l.startsWith('○')), /^○ {2}排队 3 · /);
});

test('an unread report, a failed or asking job and the owner opening a fold keep their rows; Enter on a fold lists its jobs', () => {
  const board = jobsBoard(), done = board.workers.find((w) => w.displayId === 'cache-v1/06');
  done.reportUnread = true;
  const lines = jobFrame(80, 'en', board);
  assert.match(lines.find((l) => /cache-v1\/06/.test(l) && l.startsWith('✓●')), /^✓● cache-v1\/06 /, 'unread: its own row');
  assert.match(lines.find((l) => l.startsWith('✓  done')), /^✓ {2}done 1 · export-csv\/01/);
  const opened = jobsBoard(), key = (w) => targetKey({ kind: 'worker', laneId: opened.lanes.find((l) => l.workers.includes(w)).id, workerId: w.id });
  const kept = opened.workers.find((w) => w.displayId === 'export-csv/01');
  assert.ok(!jobFrame(80, 'en', opened).some((l) => /^✓ {2}export-csv\/01/.test(l)), 'folded while nobody opened it');
  const keptLines = jobFrame(80, 'en', opened, withState(initialMonitorState(), { home: { expanded: new Set([key(kept)]) } }));
  assert.ok(keptLines.some((l) => /^✓ {2}export-csv\/01 /.test(l)), 'a job the owner opened is not folded away under them');
  const open = jobFrame(80, 'en', jobsBoard(), withState(initialMonitorState(), { home: { expanded: new Set(['fold:queued']) } }));
  assert.equal(open.filter((l) => /^○ {2}\S+\/\d\d /.test(l)).length, 3, 'one row per queued job');
  assert.match(open.find((l) => /^○ {2}cache-v2\/04/.test(l)), /^○ {2}cache-v2\/04 {6}queued #1 +1m$/, 'a queued job’s queue place sits where its strip would');
  assert.match(open.find((l) => l.startsWith('○  queued')), /^○ {2}queued 3\s*$/, 'the opened fold drops its id list');
});

test('the cursor stops on a fold, Enter opens it into one row per job and Enter again closes it', (t) => {
  const display = setDisplayConfig({ theme: 'none', icons: 'unicode' });
  t.after(() => setDisplayConfig(display));
  const board = jobsBoard(), tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(NOW) };
  let state = initialMonitorState();
  const draw = () => renderMonitor({ tree, workboard: board, state, width: 80, height: 40, nowMs: NOW });
  const press = (key) => { const frame = draw(); state = handleMonitorInput(frame.state, { type: 'key', key }, { tree, frame, nowMs: NOW }).state; };
  for (let i = 0; i < 30 && state.home.cursor?.item !== 'fold:queued'; i++) press('down');
  assert.equal(state.home.cursor?.item, 'fold:queued');
  assert.equal(state.home.expanded.size, 0, 'arriving does not open it');
  press('enter');
  assert.equal(draw().lines.map(stripAnsi).filter((l) => /^○ {2}\S+\/\d\d .*queued #\d/.test(l)).length, 3);
  press('enter');
  assert.equal(state.home.expanded.size, 0);
});

test('text mode keeps the role icons, the two-cell glyph column and an ASCII strip', () => {
  const lines = jobFrame(80, 'en', undefined, undefined, 'text');
  assert.match(lines.find((l) => /^x {2}export-csv\/02/.test(l)), /^x {2}export-csv\/02 {4}x HTTP 429 rate limit; no report written +9m$/, 'a failure keeps its reason');
  assert.match(lines.find((l) => /^\+\* stream-sync\/05 {3}/.test(l)), /^\+\* stream-sync\/05 {3}\+\+\+\+@ {2}I OAI +2m$/, 'imp is I, then its provider tag; the land is @');
  assert.match(lines.find((l) => /^~ {2}docs-sweep\/04/.test(l)), /^~ {2}docs-sweep\/04 {4}ooooo {2}O Ant +21m quiet 12m$/, 'oracle is O; unknown and not reached are both o');
});

test('ticketTitle reads the heading of .scratch/<feature>/issues/NN-*.md, once per look, and never outside the project', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'ticket-title-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const issues = join(root, '.scratch', 'metrics-lite', 'issues');
  fs.mkdirSync(issues, { recursive: true });
  fs.writeFileSync(join(issues, '01-trim-idle-poll.md'), '# 01: Trim idle poll interval\n\n**Status:** ready\n');
  assert.equal(ticketTitle(root, 'metrics-lite/01', '', NOW), 'Trim idle poll interval');
  assert.equal(ticketTitle(root, '1', 'metrics-lite', NOW), 'Trim idle poll interval', 'a package and a bare number');
  fs.writeFileSync(join(issues, '01-trim-idle-poll.md'), '# 01: Changed\n');
  assert.equal(ticketTitle(root, 'metrics-lite/01', '', NOW + 1000), 'Trim idle poll interval', 'cached for a few seconds');
  assert.equal(ticketTitle(root, 'metrics-lite/01', '', NOW + 60_000), 'Changed');
  for (const bad of ['../../etc/passwd', 'metrics-lite/09', 'metrics-lite', '']) assert.equal(ticketTitle(root, bad, '', NOW), undefined, bad);
  assert.equal(ticketTitle(null, 'metrics-lite/01', '', NOW), undefined);
});

test('a queued job and a stalled job do not share a glyph, in icons or text mode', (t) => {
  const queued = { worker: { state: 'running' }, state: 'queued' }, stalled = { worker: { state: 'running' }, state: 'stalled' };
  for (const [icons, want] of [['unicode', ['○', '◷']], ['text', ['o', '~']]]) {
    const previous = setDisplayConfig({ theme: 'none', icons });
    t.after(() => setDisplayConfig(previous));
    assert.deepEqual([workStateGlyph(queued), workStateGlyph(stalled)], want, icons);
  }
});
