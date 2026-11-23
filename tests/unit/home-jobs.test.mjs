/** home-compact/02: one row per job on Classic Home, a header only for a lane of several jobs, one sub-row per landing job, folded queued and finished jobs. */
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

const expected = JSON.parse(fs.readFileSync(new URL('../fixtures/home-jobs-frames.json', import.meta.url), 'utf8'));
const laneRows = (lines) => lines.slice(lines.findIndex((l) => l.startsWith('✗  export-csv/02')));

test('a busy run of 14 jobs: frames in EN/ZH at 120, 80 and 50 columns, none wider than the panel', () => {
  const frames = jobFrames();
  assert.deepEqual(frames, expected);
  for (const [name, lines] of Object.entries(frames)) {
    const width = Number(name.split('-')[1]);
    for (const line of lines) assert.ok(visualLength(line) <= width, `${name}: ${line}`);
    assert.doesNotMatch(lines.join('\n'), /Implement the synthetic ticket/, `${name}: the raw task text is never a title`);
  }
});

test('at 42 and 48 columns a job row keeps 16 title cells (15 and the …) while the marks narrow, and the state word stays', () => {
  const board = narrowBoard(), titleOf = (id) => board.workers.find((w) => w.displayId === id).ticketTitle;
  for (const width of [48, 42]) {
    const lines = jobFrame(width, 'en', board);
    for (const id of ['auto-route/08', 'hud-doctor/01', 'stream-sync/05', 'docs-sweep/04']) {
      const row = lines.find((l) => l.includes(`${id}  `)), from = row.indexOf(id) + id.length + 2;
      assert.equal(row.slice(from, from + 15), titleOf(id).slice(0, 15), `${width} ${id}: ${row}`);
    }
    assert.match(lines.find((l) => /export-csv\/02/.test(l)), / failed 9m$/, `${width}: failed is never narrowed away`);
  }
  const narrow = jobFrame(42, 'en', board), wide = jobFrame(48, 'en', board);
  assert.match(wide.find((l) => /auto-route\/08/.test(l)), / ⚒ ◎ ▆∅ ⚡2 0m$/, '48: the model mark is gone, the route marks and the helper count stay');
  assert.match(narrow.find((l) => /auto-route\/08/.test(l)), / ⚡2 0m$/, '42: the route marks, the provider and the role icon narrow away before the title; the helper count stays');
  assert.match(narrow.find((l) => /statusline-workers\/03/.test(l)), / ⚒ 6m$/, 'a 21-cell id leaves no room: the role icon and the age are what stay');
});

test('at 80 columns the 14 jobs take 15 rows (38 before); a header only where a lane shows several jobs; folds list their ids', () => {
  const lines = jobFrame(80);
  assert.equal(laneRows(lines).length, 15);
  assert.equal(lines.filter((l) => /^perf-ts\/05 /.test(l)).length, 1);
  assert.equal(lines.filter((l) => /^\S+\/\d\d /.test(l)).length, 1, 'no other lane has a header');
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
  assert.match(open.find((l) => l.startsWith('○  queued')), /^○ {2}queued 3\s*$/, 'the opened fold drops its id list');
  assert.equal(laneRows(jobFrame(80)).filter((l) => /asking|Keep fallback/.test(l)).length, 0, 'the asking job is the slab, not a lane row');
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

test('text mode keeps the role icons and the two-cell glyph column', () => {
  const lines = jobFrame(80, 'en', undefined, undefined, 'text');
  assert.match(lines.find((l) => /^x {2}export-csv\/02/.test(l)), / G .*failed 9m$/, 'general is G');
  assert.match(lines.find((l) => /^\+\* stream-sync\/05 {2}/.test(l)), / I .*2m$/, 'imp is I');
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
