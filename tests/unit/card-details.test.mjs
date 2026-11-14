import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cardFixture, colourFrame, colourFrames, NOW } from '../fixtures/card-details.mjs';
import { initialMonitorState, handleMonitorInput } from '../../dist-test/src/render/monitor.js';
import { cardExpanded, jobSentenceRows, identifiers, paintSentence, workCardDetail, renderWorkCard } from '../../dist-test/src/render/work-card.js';
import { projectWorkCard } from '../../dist-test/src/collectors/work-card.js';
import { decisionRows } from '../../dist-test/src/render/workboard-rows.js';
import { workInspectorRows } from '../../dist-test/src/render/work-inspector.js';
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
test('Home opens only the newest current result by itself; running cards stay two rows; owner choices survive', (t) => {
  const f = fixture(t), [job, native] = f.board.workers;
  assert.match(job.id, /^thin-job:/);
  assert.equal(native.nativeDepth, 1);
  for (const w of f.board.workers) {
    w.modelSentence = 'A complete sentence with enough words to wrap and end at the final word.';
    w.work.activityAt = NOW - 5000;
    if (w.settledAt !== null) w.settledAt = NOW - 5000;
  }
  native.work.activityAt = NOW - 1000; // the most recent activity is a running card: it must not open
  let frame = f.render(initialMonitorState(), 32);
  const rows = (w) => frame.workboard.rows.filter((r) => r.item === key(w));
  const running = f.board.workers.filter((w) => w.settledAt === null);
  assert.ok(running.length >= 2);
  for (const w of running) {
    assert.ok(!cardExpanded(frame.state, key(w)), w.id);
    assert.equal(rows(w).length, 3, `${w.id}: a collapsed card is its title plus two sentence rows`);
  }
  const newest = f.board.workers.find((w) => key(w) === frame.state.boardNewest);
  assert.ok(newest && newest.settledAt !== null, 'the newest result opens');
  job.settledAt = NOW - 500; // the job settles: it is now the newest result
  frame = f.render(frame.state);
  assert.equal(frame.state.boardNewest, key(job));
  assert.ok(cardExpanded(frame.state, key(job)));
  assert.match(rows(job).map((r) => stripAnsi(r.text)).join(' '), /final word/);
  let state = enter(f, frame, job); // explicitly fold the newest
  frame = f.render(state);
  assert.ok(!cardExpanded(frame.state, key(job)));
  state = enter(f, frame, native); // explicitly open a running card
  frame = f.render(state);
  assert.ok(cardExpanded(frame.state, key(native)));
  native.work.activityAt = NOW; // activity alone changes nothing
  frame = f.render(frame.state);
  assert.ok(cardExpanded(frame.state, key(native)));
  assert.ok(!cardExpanded(frame.state, key(job)));
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
for (const language of ['en', 'zh']) test(`flag marks retain prefixes as identifiers, stance marks still work: ${language}`, (t) => {
  const f = fixture(t), lead = language === 'en' ? 'Use ' : '使用';
  for (const [raw, plain] of [
    ['«--orchestrator»', '--orchestrator'], ['«--notify»', '--notify'],
    ['`«-x»`', '`-x`'], ['«`-x`»', '`-x`'],
    ['«++value»', '++value'], ['«!!value»', '!!value'], ['«!-value»', '!-value'],
  ]) {
    const parsed = keywordMarks(lead + raw);
    assert.equal(parsed.valid, true, raw);
    assert.equal(parsed.plain, lead + plain, raw);
    assert.equal(parsed.spans[0].type, '', raw);
    const painted = paintSentence(lead + raw);
    assert.equal(stripAnsi(painted), lead + plain);
    assert.equal(painted, lead + theme.board.identifier(plain));
    const title = markedTitle(lead + raw, language);
    assert.equal(keywordMarks(title).plain, lead + plain);
    assert.equal(paintSentence(title), painted);
    const lane = f.board.lanes[0];
    const d = { id: 'flag-decision', laneId: lane.id, title: 'Fallback', modelTitle: title,
      departure: false, evidence: [{ at: NOW, relativePath: 'qa/q1.md', sourceId: 'j0123456789abcdef' }], at: NOW };
    for (const expanded of [false, true]) {
      const state = initialMonitorState();
      if (expanded) state.boardExpanded = new Set([targetKey({ kind: 'decision', laneId: lane.id, decisionId: d.id })]);
      const row = decisionRows(d, lane, state, 120, NOW).map((r) => r.text).join('\n');
      assert.ok(row.includes(theme.board.identifier(plain)), row);
      assert.ok(stripAnsi(row).includes(plain));
    }
  }
  const words = language === 'en' ? ['reject', 'approve', 'recommends simplicity'] : ['拒绝', '批准', '认为更简单'];
  const raw = `«-${words[0]}» «+${words[1]}» «!${words[2]}»`;
  assert.equal(paintSentence(raw), [theme.board.danger(words[0]), theme.board.success(words[1]), theme.board.opinion(words[2])].join(' '));
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
test('corner keyword grammar preserves ordinary quotations and shares the four-mark limit', (t) => {
  fixture(t);
  assert.deepEqual(keywordMarks('「bar-fields.ts」以「835行」'), keywordMarks('«bar-fields.ts»以«835行»'));
  assert.deepEqual(keywordMarks('「+批准」「-拒绝」「!更简单」'), keywordMarks('«+批准»«-拒绝»«!更简单»'));
  for (const quote of [
    '「普通引用，保留原文」', '「这是一整句中文。」', '「真的吗？」', '「请保留！」',
    '「甲；乙」', '「甲：乙」', '「甲,乙」', '「甲;乙」', '「甲:乙」', '「yes!」', '「why?」',
    '「two words」', '「甲\t乙」', '「甲\n乙」', '「」', '「+」', '「unfinished', 'unopened」',
    '「外层「内层」「另一层」」', `「${'字'.repeat(25)}」`, '「sentence.」',
  ]) {
    assert.deepEqual(keywordMarks(quote), { plain: quote, spans: [], valid: true }, quote);
    if (!/[\t\n]/.test(quote)) assert.equal(paintSentence(quote), quote, quote);
  }
  for (const word of ['字'.repeat(24), '😀'.repeat(24)]) {
    assert.equal(keywordMarks(`「${word}」`).spans.length, 1);
    assert.equal(keywordMarks(`「${word}字」`).spans.length, 0);
  }
  const four = '«甲»「乙」«+丙»「!丁」';
  assert.equal(keywordMarks(four).spans.length, 4);
  const five = keywordMarks(four + '「戊」');
  assert.equal(five.valid, false);
  assert.deepEqual(five.spans, []);
  assert.equal(five.plain, '甲乙丙丁戊');
  assert.equal(paintSentence('「普通引用，保留原文」和「关键词」'),
    '「普通引用，保留原文」和' + theme.board.identifier('关键词'));
  assert.equal(markedTitle('「+批准」使用「!更简单」', 'zh'), '«+批准»使用«!更简单»');
  assert.equal(markedTitle('「甲，乙」', 'zh'), '「甲，乙」');
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

test('settled cards drop stale still-working or prompt-report quiet_decision while unsettled and quiet-failed keep it', (t) => {
  const f = fixture(t);
  const base = f.board.workers[0];
  const state = { ...initialMonitorState(), mainTab: 'home' };
  for (const [choice, action] of [['still-working', 'wait'], ['finished-no-report', 'prompt-report']]) {
    const settled = {
      ...base,
      state: 'closed',
      settledAt: NOW - 1000,
      modelSentence: undefined,
      quietDecision: { choice, probability: 0.92, action },
      work: { ...base.work, failed: false, result: true, reason: 'settled' },
    };
    const card = projectWorkCard(settled, NOW);
    assert.doesNotMatch(workCardDetail(card), /still-working|prompt-report|wait/);
    const inspector = (worker) => workInspectorRows(worker, state, 110, NOW).map((r) => stripAnsi(r.text)).join('\n');
    assert.doesNotMatch(inspector(settled), new RegExp(choice), 'the Inspector follows the card');
    assert.doesNotMatch(renderWorkCard(card, state, 80).map(stripAnsi).join('\n'), /still-working|prompt-report|wait/);

    const unsettled = { ...settled, state: 'working', settledAt: null, work: { ...base.work, failed: false, result: false, reason: 'quiet' } };
    assert.match(workCardDetail(projectWorkCard(unsettled, NOW)), new RegExp(`${choice} 92%`));
  }
  const failedByQuiet = {
    ...base,
    state: 'failed',
    settledAt: NOW - 1000,
    modelSentence: undefined,
    quietDecision: { choice: 'failed', probability: 0.96, action: 'fail' },
    work: { ...base.work, failed: true, result: false, reason: '429 rate limit' },
  };
  assert.match(workCardDetail(projectWorkCard(failedByQuiet, NOW)), /failed 96% → fail/);
  assert.match(workInspectorRows(failedByQuiet, state, 110, NOW).map((r) => stripAnsi(r.text)).join('\n'), /quiet\s+failed 96% → fail/);
});
