import { withState } from '../fixtures/state-helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const NOW = Date.parse('2026-11-12T12:35:00Z');
import { initialMonitorState, handleMonitorInput } from '../../dist/render/monitor.js';
import { jobSentenceRows, identifiers, paintSentence, workJobDetail as workCardDetail } from '../../dist/render/work-job-detail.js';
import { projectWorkCard } from '../../dist/collectors/work-card.js';
import { workInspectorRows } from '../../dist/render/work-inspector.js';
import { targetKey } from '../../dist/collectors/workboard-types.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { theme, stripAnsi, visualLength } from '../../dist/render/colors.js';
import { keywordMarks, markedTitle } from '../../dist/utils/keyword-marks.js';
test('all mark inks and deterministic unmarked files in EN and ZH', (t) => {
  const display = setDisplayConfig({ theme: 'terminal', icons: 'unicode' });
  t.after(() => setDisplayConfig(display));
  for (const language of ['en', 'zh']) {
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
  }
});
test('flag marks retain prefixes as identifiers, stance marks still work in EN and ZH', (t) => {
  const display = setDisplayConfig({ theme: 'terminal', icons: 'unicode' });
  t.after(() => setDisplayConfig(display));
  for (const language of ['en', 'zh']) {
    const lead = language === 'en' ? 'Use ' : '使用';
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
    }
    const words = language === 'en' ? ['reject', 'approve', 'recommends simplicity'] : ['拒绝', '批准', '认为更简单'];
    const raw = `«-${words[0]}» «+${words[1]}» «!${words[2]}»`;
    assert.equal(paintSentence(raw), [theme.board.danger(words[0]), theme.board.success(words[1]), theme.board.opinion(words[2])].join(' '));
  }
});
test('malformed, prefix-only, five marks and nesting strip syntax without colouring keywords; old grammar still paints', (t) => {
  const display = setDisplayConfig({ theme: 'terminal', icons: 'unicode' });
  t.after(() => setDisplayConfig(display));
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
  const display = setDisplayConfig({ theme: 'terminal', icons: 'unicode' });
  t.after(() => setDisplayConfig(display));
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
test('decision title eight-word cap does not count prefixes or break marks', (t) => {
  const display = setDisplayConfig({ theme: 'terminal', icons: 'unicode' });
  t.after(() => setDisplayConfig(display));
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
test('settled cards drop stale still-working or prompt-report quiet_decision while unsettled and quiet-failed keep it', (t) => {
  const base = { role: 'imp', task: 'Synthetic job', state: 'working', startedAt: NOW - 60000, settledAt: null, laneId: 'synthetic', work: { reason: 'Synthetic detail', phases: [] } };
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
    const inspector = (worker) => workInspectorRows(worker, 110, NOW).map((r) => stripAnsi(r.text)).join('\n');
    assert.doesNotMatch(inspector(settled), new RegExp(choice), 'the Inspector follows the card');
    assert.doesNotMatch(workInspectorRows(settled, 80, NOW).map(r => stripAnsi(r.text)).join('\n'), /still-working|prompt-report|wait/);

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
  assert.match(workInspectorRows(failedByQuiet, 110, NOW).map((r) => stripAnsi(r.text)).join('\n'), /quiet\s+failed 96% → fail/);
});
