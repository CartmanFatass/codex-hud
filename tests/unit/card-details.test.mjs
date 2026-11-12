import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cardFixture, colourFrame, colourFrames, NOW } from '../fixtures/card-details.mjs';
import { initialMonitorState, handleMonitorInput } from '../../dist-test/src/render/monitor.js';
import { cardExpanded, jobSentenceRows, identifiers, paintSentence } from '../../dist-test/src/render/work-card.js';
import { decisionRows } from '../../dist-test/src/render/workboard-rows.js';
import { targetKey } from '../../dist-test/src/collectors/workboard-types.js';
import { setDisplayConfig } from '../../dist-test/src/render/hud-config.js';
import { theme, stripAnsi, visualLength } from '../../dist-test/src/render/colors.js';
import { keywordMarks, markedTitle } from '../../dist-test/src/utils/keyword-marks.js';
const key = (w) => targetKey({ kind: 'worker', laneId: w.laneId, workerId: w.id });
function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'card-details-'));
  const display = setDisplayConfig({ theme: 'terminal', icons: 'unicode' });
  t.after(() => { setDisplayConfig(display); fs.rmSync(home, { recursive: true, force: true }); });
  return cardFixture(home);
}
function enter(f, frame, worker) {
  return handleMonitorInput({ ...frame.state, homeTarget: { kind: 'worker', laneId: worker.laneId, workerId: worker.id } },
    { type: 'key', key: 'enter' }, { frame, tree: f.tree, nowMs: NOW }).state;
}
test('Home chooses activity/settlement newest across native and job cards; owner choices survive newer arrivals', (t) => {
  const f = fixture(t), [job, native] = f.board.workers;
  assert.match(job.id, /^thin-job:/);
  assert.equal(native.nativeDepth, 1);
  for (const w of f.board.workers) {
    w.modelSentence = 'A complete sentence with enough words to wrap and end at the final word.';
    w.work.activityAt = NOW - 5000;
    if (w.settledAt !== null) w.settledAt = NOW - 5000;
  }
  native.work.activityAt = NOW - 2000;
  let frame = f.render(initialMonitorState(), 32);
  const body = (w) => frame.workboard.rows.filter((r) => r.item === key(w)).map((r) => stripAnsi(r.text)).join(' ');
  assert.match(body(native), /final word/);
  assert.doesNotMatch(body(job), /final word/);
  assert.equal(frame.state.boardNewest, key(native));
  assert.deepEqual(f.board.workers.filter((w) => cardExpanded(frame.state, key(w))), [native]);
  let state = enter(f, frame, native); // explicitly fold the newest
  job.work.activityAt = NOW - 1000;
  frame = f.render(state);
  assert.equal(frame.state.boardNewest, key(job));
  assert.ok(cardExpanded(frame.state, key(job)));
  assert.ok(!cardExpanded(frame.state, key(native)));
  state = enter(f, frame, native); // explicitly open the older native
  frame = f.render(state);
  state = enter(f, frame, job); // explicitly fold the newest job
  frame = f.render(state);
  assert.ok(!cardExpanded(frame.state, key(job)));
  const added = { ...native, id: 'synthetic-new-native', task: 'New native', work: { ...native.work, activityAt: NOW } };
  const lane = f.board.lanes.find((l) => l.id === native.laneId);
  lane.workers.push(added); f.board.workers.push(added);
  frame = f.render(frame.state);
  assert.equal(frame.state.boardNewest, key(added));
  assert.deepEqual(f.board.workers.filter((w) => cardExpanded(frame.state, key(w))), [native, added]);
  job.settledAt = NOW + 1; // settlement can make an older job newest; explicit fold still wins
  frame = f.render(frame.state);
  assert.equal(frame.state.boardNewest, key(job));
  assert.ok(!cardExpanded(frame.state, key(job)));
  assert.ok(!cardExpanded(frame.state, key(added)));
  assert.ok(cardExpanded(frame.state, key(native)));
  // No default expansion for the separate question slab.
  job.homeNeedsHuman = true;
  job.ask = 'Synthetic question?';
  job.work.requestInfo = { question: job.ask, options: ['A) first', 'B) second'], context: 'QUESTION-CONTEXT', suggested: 'A' };
  frame = f.render(initialMonitorState());
  assert.doesNotMatch(frame.lines.map(stripAnsi).join('\n'), /QUESTION-CONTEXT/);
  frame = f.render(enter(f, frame, job));
  assert.match(frame.lines.map(stripAnsi).join('\n'), /QUESTION-CONTEXT/);
});
for (const language of ['en', 'zh']) test(`all mark inks and deterministic unmarked files: ${language}`, (t) => {
  fixture(t);
  const words = language === 'en' ? ['keyword', 'accept', 'reject', 'recommends X'] : ['关键词', '批准', '拒绝', '认为更简单'];
  const raw = `«${words[0]}» «+${words[1]}» «-${words[2]}» «!${words[3]}» report.md src/tree-page.ts`;
  const painted = paintSentence(raw);
  assert.equal(painted, [theme.board.identifier(words[0]), theme.board.success(words[1]), theme.board.danger(words[2]),
    theme.board.opinion(words[3]), theme.board.identifier('report.md'), theme.board.identifier('src/tree-page.ts')].join(' '));
  assert.ok(identifiers('检查report.md，修改src/tree-page.ts。').includes(theme.board.identifier('report.md')));
  assert.ok(identifiers('检查report.md，修改src/tree-page.ts。').includes(theme.board.identifier('src/tree-page.ts')));
  assert.equal(paintSentence('«!prefer report.md»'), theme.board.opinion('prefer ') + theme.board.identifier('report.md'));
  for (const width of [16, 40, 80]) for (const full of [false, true]) {
    const rows = jobSentenceRows(raw, width, theme.board.muted, full);
    assert.ok(rows.every((r) => visualLength(r) === width));
    assert.doesNotMatch(rows.map(stripAnsi).join(''), /[«»!+]/);
  }
});
test('malformed, prefix-only, five marks and nesting strip syntax without colouring keywords; old grammar still paints', (t) => {
  fixture(t);
  for (const raw of ['«+»', '«-»', '«!»', '«»', '«+accept', '«+outer «!inner»»', '«a» «+b» «-c» «!d» «e»']) {
    const parsed = keywordMarks(raw);
    assert.equal(parsed.valid, false, raw);
    assert.equal(parsed.spans.length, 0, raw);
    assert.doesNotMatch(parsed.plain, /[«»+!-]/);
    const rows = jobSentenceRows(raw, 80, (s) => s, false);
    assert.equal(rows.length, 1);
    assert.equal(jobSentenceRows(raw, 8, (s) => s, true).length, 1);
    assert.doesNotMatch(rows[0], /\x1b/);
  }
  assert.equal(paintSentence('Old «cached keyword».'), `Old ${theme.board.identifier('cached keyword')}.`);
  assert.equal(paintSentence('«+yes» «-no» «!prefer» «plain»'),
    `${theme.board.success('yes')} ${theme.board.danger('no')} ${theme.board.opinion('prefer')} ${theme.board.identifier('plain')}`);
  setDisplayConfig({ theme: 'none', icons: 'unicode' });
  assert.equal(paintSentence('«+yes» «-no» «!prefer» report.md'), 'yes no prefer report.md');
  setDisplayConfig({ theme: 'terminal', icons: 'text' });
  assert.equal(paintSentence('«!prefer»'), 'prefer');
});
test('decision titles share paint in collapsed/expanded rows; visible eight-word cap does not count prefixes or break marks', (t) => {
  const f = fixture(t), lane = f.board.lanes[0];
  const d = { id: 'synthetic-decision', laneId: lane.id, title: 'Fallback', modelTitle: '«+Accept» «!simpler report.md»',
    departure: false, evidence: [{ at: NOW - 1000, relativePath: 'qa/q1.md', sourceId: 'j0123456789abcdef' }], at: NOW - 1000 };
  for (const expanded of [false, true]) {
    const state = initialMonitorState();
    if (expanded) state.boardExpanded = new Set([targetKey({ kind: 'decision', laneId: lane.id, decisionId: d.id })]);
    const rows = decisionRows(d, lane, state, 120, NOW).map((r) => r.text).join('\n');
    for (const expected of [theme.board.success('Accept'), theme.board.opinion('simpler '), theme.board.identifier('report.md')])
      assert.ok(rows.includes(expected), expected);
    assert.doesNotMatch(stripAnsi(rows), /[«»!+]/);
  }
  for (const [language, raw, expected] of [
    ['en', '«+Accept» «design» «!today» «-instead»', '«+Accept» «design» today instead'],
    ['zh', '«+批准»«设计»«!今天»«-替代»', '«+批准»«设计»今天替代'],
  ]) {
    const title = markedTitle(raw, language);
    assert.equal(title, expected);
    assert.equal(keywordMarks(title).spans.length, 2);
  }
  assert.equal(markedTitle('One two three four five six «!seven eight nine ten»', 'en'), 'One two three four five six «!seven eight»');
  for (const language of ['en', 'zh']) {
    const title = markedTitle(language === 'en' ? '«+Accept» one two three four five six seven eight nine' : '«+批准»使用更简单的解析器并保留文件检查和结果验证。', language);
    const parsed = keywordMarks(title);
    assert.equal(parsed.valid, true);
    assert.ok([...new Intl.Segmenter(language, { granularity: 'word' }).segment(parsed.plain)].filter((s) => s.isWordLike).length <= 8);
  }
});
test('Home frames EN/ZH at 80/120 columns retain all colour kinds (ANSI assertion plus stripped snapshots)', (t) => {
  const f = fixture(t);
  const expected = JSON.parse(fs.readFileSync(new URL('../fixtures/card-details-frames.json', import.meta.url)));
  assert.deepEqual(colourFrames(f), expected);
  for (const width of [80, 120]) for (const lang of ['en', 'zh']) {
    const frame = colourFrame(f, width, lang);
    assert.ok(frame.lines.every((line) => visualLength(line) === width));
    const ansi = frame.lines.join('\n');
    // Keep ANSI here: snapshot stripping must not hide a lost category colour.
    assert.ok([theme.board.identifier('report.md'), theme.board.success(lang === 'en' ? 'approves' : '批准'),
      theme.board.danger(lang === 'en' ? 'rejects' : '拒绝'), theme.board.opinion(lang === 'en' ? 'recommends simplicity' : '认为更简单'),
      theme.board.identifier(lang === 'en' ? 'parser' : '解析器')].every((span) => ansi.includes(span)));
  }
});
