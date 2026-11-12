import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsMutable from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JobSentences } from '../../dist/collectors/job-sentences.js';
import { DecisionTitles } from '../../dist/collectors/decision-titles.js';
import { decisionRows, decisionTitle } from '../../dist/render/workboard-rows.js';
import { targetKey } from '../../dist/collectors/workboard-types.js';
import { SmallModel, modelHttpRequest } from '../../dist/collectors/small-model.js';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { projectWorkCard } from '../../dist/collectors/work-card.js';
import { renderWorkCard, jobSentenceLine } from '../../dist/render/work-card.js';
import { laneRows } from '../../dist/render/work-lanes.js';
import { initialMonitorState, renderMonitor, handleMonitorInput } from '../../dist/render/monitor.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi, theme, visualLength } from '../../dist/render/colors.js';
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise(setImmediate);
};
function fixture(t, mode = 'on', language = 'en') {
  const home = fs.mkdtempSync(join(tmpdir(), 'job-sentence-')),
    id = 'j0123456789abcdef',
    dir = join(home, 'jobs', id);
  const put = (name, v) => {
    fs.mkdirSync(join(dir, name, '..'), { recursive: true });
    fs.writeFileSync(join(dir, name), typeof v === 'string' ? v : JSON.stringify(v));
  };
  const f = { home, dir, put, now: Date.parse('2026-11-11T12:00:00Z'), calls: [], fail: false, hold: null };
  const env = { HUD_HOME: home, MISTRAL_API_KEY: mode === 'no-key' ? '' : 'synthetic-key' };
  const model = new SmallModel({
    env,
    clock: () => f.now,
    fetch: async (_url, init) => {
      f.calls.push(JSON.parse(init.body));
      if (f.hold) await f.hold;
      return new Response(
        f.fail
          ? '{}'
          : JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      f.reply ??
                      (f.calls.at(-1).messages[0].content.includes('sentence in Simplified Chinese')
                        ? '正在检查«解析器»边界。'
                        : 'Checking «parser» boundaries.'),
                  },
                },
              ],
            }),
        { status: f.fail ? 503 : 200 }
      );
    },
  });
  model.configure({ backend: mode === 'off' ? 'off' : 'api' });
  f.model = model;
  f.file = join(home, 'display/model-cache/job-sentences.json');
  f.service = new JobSentences(
    model,
    f.file,
    () => {},
    () => f.now
  );
  f.on =
    mode !== 'off' &&
    !('error' in modelHttpRequest({ base: '', model: '' }, { feature: 'job-sentence', system: '', prompt: '' }, env));
  f.service.configure(f.on, language);
  put('job.json', { job: id, role: 'imp', package: 'SYNTHETIC', created_at: new Date(f.now).toISOString(), herdr_pane: 'w4E:p1' });
  put('brief.md', '# SYNTHETIC: check parser\nGoal: repair boundaries.');
  put('STATUS.json', { state: 'working' });
  put('report.md', 'Factual progress');
  f.activity = (text) =>
    put(
      'sessions/session.jsonl',
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'PRIVATE-REASONING' },
            { type: 'text', text },
            { type: 'toolCall', name: 'read', arguments: { path: 'synthetic.ts' } },
          ],
        },
      }) + '\n'
    );
  f.board = () => {
    const lanes = readThinJobs(home, { pane: 'w4E:p1', project: null });
    return {
      lanes,
      workers: lanes.flatMap((l) => l.workers),
      decisions: lanes.flatMap((l) => l.decisions),
      revision: '1',
      coverage: { incomplete: false, diagnostics: [], workspace: null },
    };
  };
  f.update = async () => {
    f.service.update(f.board(), home);
    await settle();
    return f.service.apply(f.board());
  };
  f.render = (board, width = 56) =>
    renderWorkCard(projectWorkCard(board.workers[0], f.now), { ...initialMonitorState(), mainTab: 'home' }, width).join(
      '\n'
    );
  const previous = setDisplayConfig({ theme: 'terminal', icons: 'unicode' });
  t.after(async () => {
    f.service.stop();
    model.cancelAll();
    await settle();
    setDisplayConfig(previous);
    fs.rmSync(home, { recursive: true, force: true });
  });
  return f;
}
test('thin job: real file collection, keyword card, coalescing, cached reopen, and exactly one successful final', async (t) => {
  const f = fixture(t);
  f.activity('Reading parser');
  let board = await f.update();
  assert.equal(f.calls.length, 1);
  assert.match(f.render(board), new RegExp(theme.board.identifier('parser').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(stripAnsi(f.render(board)), /Checking parser boundaries\./);
  assert.doesNotMatch(f.render(board), /[«»]/);
  assert.match(f.calls[0].messages[1].content, /Reading parser|synthetic.ts/);
  assert.doesNotMatch(JSON.stringify(f.calls), /PRIVATE-REASONING/);
  f.now += 60_000;
  f.activity('Testing parser');
  await f.update();
  assert.equal(f.calls.length, 1);
  f.now += 60_001;
  await f.update();
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].messages[1].content, /Testing parser/);
  f.service = new JobSentences(
    f.model,
    f.file,
    () => {},
    () => f.now
  );
  f.service.configure(true, 'en');
  assert.match(f.render(f.service.apply(f.board())), /Checking/);
  f.now += 120_001;
  await f.update();
  assert.equal(f.calls.length, 2);
  f.now += 120_001;
  f.put('STATUS.json', { state: 'closed' });
  f.put('report.md', 'Parser fixed\n12 tests passed');
  await f.update();
  assert.equal(f.calls.length, 3);
  assert.match(f.calls[2].messages[1].content, /Parser fixed/);
  assert.match(stripAnsi(f.render(f.service.apply(f.board()))), /Checking parser boundaries\./);
  f.now += 240_000;
  f.put('report.md', 'A later report edit');
  f.service = new JobSentences(
    f.model,
    f.file,
    () => {},
    () => f.now
  );
  f.service.configure(true, 'en');
  await f.update();
  assert.equal(f.calls.length, 3);
});
for (const language of ['en', 'zh']) {
  test(`short job titles: heading, same-call name, fallback, Home/Inspector/Project frames (${language})`, async (t) => {
    const f = fixture(t, 'on', language);
    const previous = setLanguage(language);
    t.after(() => setLanguage(previous));
    const heading = language === 'en' ? 'CLAUDE-BIND: bind the caller' : 'CLAUDE-BIND: 绑定调用会话';
    const name = language === 'en' ? 'Bind caller' : '绑定调用会话';
    f.reply = JSON.stringify({ name, sentence: language === 'en' ? 'Checking bindings.' : '正在检查绑定。' });
    f.put('brief.md', `# ${heading}\n\nRead and carry out the brief /synthetic/brief.md\n\n## Later heading`);
    let board = await f.update();
    assert.equal(board.workers[0].task, heading, 'brief heading outranks the generated name');
    assert.equal(f.calls.length, 1, 'name and sentence use one existing request');
    assert.match(f.calls[0].messages[0].content, /Reply as JSON.*short task name/);
    const tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(f.now) };
    const renderFrames = (board, expected) => {
      const worker = board.workers[0];
      const target = { kind: 'worker', laneId: worker.laneId, workerId: worker.id };
      const project = {
        waiting: [], docs: [], control: [], agents: [], keys: [], editing: [], roleCount: 0,
        ladder: { ids: [] }, counts: { working: 1, blocked: 0, try: 0, accepted: 0, todo: 0, dropped: 0 },
        slices: [{ label: 'CLAUDE-BIND', value: 'bind the caller', jobId: worker.evidence[0].sourceId }],
        next: [], summary: '',
      };
      for (const width of [80, 120]) {
        const home = renderMonitor({ tree, workboard: board, state: initialMonitorState(), width, height: 30, nowMs: f.now });
        const state = handleMonitorInput({ ...home.state, homeTarget: target }, { type: 'key', key: 'inspect' }, { tree, frame: home }).state;
        const inspector = renderMonitor({ tree, workboard: board, state, width, height: 30, nowMs: f.now });
        for (const frame of [home, inspector]) {
          const text = frame.lines.map(stripAnsi).join('\n');
          assert.ok(text.includes(expected), text);
          assert.doesNotMatch(text, /Read and carry out|\/synthetic\/brief/);
          for (const line of frame.lines) assert.equal(visualLength(line), width);
        }
        const progress = renderMonitor({ tree, workboard: board, project, state: { ...initialMonitorState(), mainTab: 'project' }, width, height: 30, nowMs: f.now });
        assert.match(progress.lines.map(stripAnsi).join('\n'), /CLAUDE-BIND/);
        assert.doesNotMatch(progress.lines.map(stripAnsi).join('\n'), /Read and carry out|\/synthetic\/brief/);
        for (const line of progress.lines) assert.equal(visualLength(line), width);
        if (process.env.PANEL_DUMPS)
          fs.writeFileSync(join(process.env.PANEL_DUMPS, `short-title-${language}-${width}-${expected === heading ? 'heading' : 'name'}.txt`), home.lines.map(stripAnsi).join('\n') + '\n');
      }
    };
    renderFrames(board, heading);
    f.service.configure(false, language);
    assert.equal(f.service.apply(f.board()).workers[0].task, heading, 'heading remains with master off');
    const task = 'Read and carry out the brief /synthetic/brief.md';
    f.put('brief.md', task + '\nThis second line is not the title.');
    assert.equal(f.service.apply(f.board()).workers[0].task, task, 'off uses first task line');
    f.service.configure(true, language);
    board = f.service.apply(f.board());
    assert.equal(board.workers[0].task, name, 'without a heading use the same-response name');
    renderFrames(board, name);
    const reads = t.mock.method(fsMutable, 'readSync');
    f.board();
    assert.equal(reads.mock.callCount(), 0, 'warm heading/fallback collection adds no file reads');
    f.service = new JobSentences(f.model, f.file);
    f.service.configure(true, language);
    assert.equal(f.service.apply(f.board()).workers[0].task, name, 'cached name survives reopen');
    assert.equal(f.calls.length, 1);
  });
}
test('unnamed thin job: pending, plain and blank-name replies keep the first line cut to fit', async (t) => {
  const f = fixture(t);
  const task = 'Read and carry out the brief /synthetic/' + 'long-path/'.repeat(20) + 'brief.md';
  f.put('brief.md', task + '\nSECOND-LINE-MUST-NOT-BE-A-TITLE');
  for (const reply of ['Checking boundaries.', JSON.stringify({ name: '  ', sentence: 'Checking boundaries.' })]) {
    f.reply = reply;
    assert.equal(f.service.apply(f.board()).workers[0].task, task);
    const board = await f.update();
    assert.equal(board.workers[0].task, task);
    for (const width of [80, 120]) {
      const title = stripAnsi(f.render(board, width)).split('\n')[0];
      assert.match(title, /Read and carry out.*…/);
      assert.equal(visualLength(title), width);
      assert.doesNotMatch(title, /SECOND-LINE/);
    }
    f.now += 120_001;
    f.put('report.md', 'Changed factual progress');
  }
});
test('ordinary cards expand the whole marked sentence and factual detail, then collapse on Home', async (t) => {
  const f = fixture(t);
  f.reply = 'Checking «parser boundaries» while preserving the complete sentence through its very last word.';
  const board = await f.update(),
    worker = board.workers[0];
  const tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(f.now) };
  const target = { kind: 'worker', laneId: worker.laneId, workerId: worker.id };
  {
    let state = { ...initialMonitorState(), mainTab: 'home', homeTarget: target };
    const render = () => renderMonitor({ tree, workboard: board, state, width: 32, height: 40, nowMs: f.now });
    const enter = () => {
      const frame = render();
      state = handleMonitorInput(frame.state, { type: 'key', key: 'enter' }, { tree, frame }).state;
    };
    const text = () =>
      render()
        .lines.map((line) => stripAnsi(line).replace(/^┃ /, ''))
        .join(' ');
    assert.match(text().replace(/\s+/g, ' '), /very last word\./);
    enter();
    assert.doesNotMatch(text(), /last word|Factual progress/);
    enter();
    assert.match(text().replace(/\s+/g, ' '), /very last word\./);
    assert.match(text(), /Factual progress/);
    assert.doesNotMatch(text(), /[«»]/);
    assert.ok(render().lines.some((line) => line.includes(theme.board.identifier('parser boundaries'))));
    enter();
    assert.doesNotMatch(text(), /last word|Factual progress/);
    board.workers[0].modelSentence = undefined;
    enter();
    assert.match(text(), /Factual progress/);
    board.workers[0].modelSentence = f.reply;
  }
});
test('a second settlement gets a fresh final sentence after the shared floor', async (t) => {
  const f = fixture(t);
  f.put('STATUS.json', { state: 'closed', settled_at: new Date(f.now).toISOString() });
  await f.update();
  f.now += 10_000;
  f.put('STATUS.json', { state: 'working' });
  await f.update();
  f.now += 10_000;
  f.put('STATUS.json', { state: 'failed', settled_at: new Date(f.now).toISOString() });
  f.put('report.md', 'Correction failed');
  await f.update();
  assert.equal(f.calls.length, 1);
  f.now += 100_001;
  await f.update();
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].messages[1].content, /Correction failed/);
});
test('unchanged running material renews the read window without another call', async (t) => {
  const f = fixture(t);
  await f.update();
  const board = f.board();
  f.now += 120_001;
  f.service.update(board, f.home);
  const reads = t.mock.method(fsMutable, 'readSync');
  f.now += 1_000;
  f.service.update(board, f.home);
  assert.equal(reads.mock.callCount(), 0);
  assert.equal(f.calls.length, 1);
});
test('language changes share the same per-job two-minute floor', async (t) => {
  const f = fixture(t);
  await f.update();
  f.service.configure(true, 'zh');
  f.now += 60_000;
  f.activity('New activity');
  await f.update();
  assert.equal(f.calls.length, 1);
  f.now += 60_001;
  const board = await f.update();
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].messages[0].content, /Simplified Chinese/);
  assert.match(stripAnsi(f.render(board)), /正在检查解析器边界/);
});
for (const mode of ['off', 'no-key'])
  test(`thin job factual fallback: ${mode}`, async (t) => {
    const f = fixture(t, mode),
      board = await f.update();
    assert.equal(f.calls.length, 0);
    assert.match(stripAnsi(f.render(board)), /Factual progress/);
    assert.equal(board.workers[0].modelSentence, undefined);
    assert.equal(board.workers[0].task, 'SYNTHETIC: check parser');
    f.put('brief.md', 'First task line\nSecond task line');
    assert.equal((await f.update()).workers[0].task, 'First task line');
    assert.equal(f.calls.length, 0);
  });
test('Chinese request, question/review/answer changes, one request per job in flight, failed final retry', async (t) => {
  const f = fixture(t, 'on', 'zh');
  f.activity('Checking parser');
  let release;
  f.hold = new Promise((r) => {
    release = r;
  });
  await f.update();
  assert.equal(f.calls.length, 1);
  f.now += 180_000;
  f.put('qa/q1.md', '# Question\n\nUse parser B?\n\nDefault if unanswered: yes');
  await f.update();
  assert.equal(f.calls.length, 1);
  release();
  f.hold = null;
  await settle();
  assert.match(f.calls[0].messages[0].content, /Simplified Chinese/);
  f.now += 120_001;
  const asking = await f.update();
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].messages[1].content, /Use parser B/);
  const home = laneRows({}, asking.lanes[0], { ...initialMonitorState(), mainTab: 'home' }, 56, f.now)
    .map((r) => r.text)
    .join('\n');
  assert.match(stripAnsi(home), /正在检查解析器边界/);
  assert.doesNotMatch(home, /[«»]/);
  f.put('qa/q1.answer.md', 'yes');
  f.put('review-1.md', 'Verdict: changes-required\nSynthetic finding');
  f.now += 120_001;
  await f.update();
  assert.equal(f.calls.length, 3);
  assert.match(f.calls[2].messages[1].content, /changes-required/);
  f.put('STATUS.json', { state: 'closed' });
  f.fail = true;
  f.now += 120_001;
  await f.update();
  assert.equal(f.calls.length, 4);
  f.now += 60_000;
  await f.update();
  assert.equal(f.calls.length, 4);
  f.fail = false;
  f.now += 60_001;
  await f.update();
  assert.equal(f.calls.length, 5);
  f.now += 240_000;
  await f.update();
  assert.equal(f.calls.length, 5);
});
test('single line word cut, malformed/unmarked text, and job-local symlink refusal', async (t) => {
  const f = fixture(t);
  assert.match(stripAnsi(jobSentenceLine('Checking «parser» boundaries carefully.', 24)), /Checking parser…/);
  for (const raw of ['Plain sentence.', 'Bad «parser sentence.', '«one» «two» «three» «four»']) {
    const line = jobSentenceLine(raw, 24);
    assert.doesNotMatch(stripAnsi(line), /[«»]/);
    assert.equal(visualLength(line), 24);
  }
  const external = join(f.home, 'external');
  fs.mkdirSync(external);
  fs.writeFileSync(
    join(external, 'secret.jsonl'),
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'OUTSIDE-SECRET' }] } })
  );
  fs.symlinkSync(external, join(f.dir, 'sessions'));
  await f.update();
  assert.doesNotMatch(JSON.stringify(f.calls), /OUTSIDE-SECRET/);
  f.service.configure(false, 'en');
  assert.match(stripAnsi(f.render(f.service.apply(f.board()))), /Factual progress/);
});
function decisionFixture(t, mode = 'on') {
  const f = fixture(t, mode);
  f.file = join(f.home, 'display/model-cache/decision-titles.json');
  f.service = new DecisionTitles(f.model, f.file);
  f.service.configure(f.on, 'en');
  f.put(
    'qa/q1.md',
    '# Question\n\nWhich parser?\n\nOptions:\nA) fast parser\nB) durable parser\n\nDefault if unanswered: A'
  );
  f.put('qa/q1.answer.md', 'B');
  f.reply = 'Use the durable parser for all future input processing tasks';
  return f;
}
test('decision title: eight words, row and expanded block, dedupe, persisted reopen, new answer and Chinese', async (t) => {
  const f = decisionFixture(t),
    factual = decisionTitle(f.board().decisions[0]);
  assert.equal(decisionTitle(f.service.apply(f.board()).decisions[0]), factual);
  let b = await f.update();
  const title = 'Use the durable parser for all future input',
    d = b.decisions[0],
    state = initialMonitorState();
  assert.equal(decisionTitle(d), title);
  const row = () =>
    decisionRows(d, b.lanes[0], state, 160, f.now)
      .map((r) => stripAnsi(r.text))
      .join('\n');
  assert.match(row(), /Use the durable parser for all future input/);
  state.boardExpanded = new Set([targetKey({ kind: 'decision', laneId: d.laneId, decisionId: d.id })]);
  assert.match(row(), /Use the durable parser for all future input[\s\S]*asked Which parser\?[\s\S]*instead of A/);
  await f.update();
  f.service = new DecisionTitles(f.model, f.file);
  f.service.configure(true, 'en');
  b = await f.update();
  assert.equal(f.calls.length, 1);
  assert.equal(decisionTitle(b.decisions[0]), title);
  assert.match(f.calls[0].messages[0].content, /up to 2 keywords/);
  assert.match(f.calls[0].messages[1].content, /Which parser/);
  assert.match(f.calls[0].messages[1].content, /"answer":"B"/);
  f.put('qa/q1.answer.md', 'A');
  fs.utimesSync(join(f.dir, 'qa/q1.answer.md'), new Date(), new Date(Date.now() + 1000));
  await f.update();
  assert.equal(f.calls.length, 2);
  f.reply = '选择耐用解析器。';
  f.service.configure(true, 'zh');
  b = await f.update();
  assert.match(f.calls[2].messages[0].content, /Simplified Chinese/);
  assert.equal(decisionTitle(b.decisions[0]), f.reply);
  f.service.configure(false, 'zh');
  assert.equal(decisionTitle(f.service.apply(f.board()).decisions[0]), 'fast parser');
});
for (const language of ['en', 'zh']) {
  test(`typed job current/result/cause and persisted old grammar: ${language}`, async (t) => {
    const f = fixture(t, 'on', language);
    for (const state of ['working', 'closed', 'failed']) {
      f.now += 120_001;
      f.put('STATUS.json', { state, settled_at: state === 'working' ? undefined : new Date(f.now).toISOString() });
      f.reply = language === 'en'
        ? 'Review «+accepts» or «-rejects» report.md and «!recommends simplicity».'
        : '评审「+批准」或「-拒绝」report.md并「!认为更简单」。';
      const board = await f.update(), ansi = f.render(board, 120);
      assert.ok(ansi.includes(theme.board.success(language === 'en' ? 'accepts' : '批准')));
      assert.ok(ansi.includes(theme.board.danger(language === 'en' ? 'rejects' : '拒绝')));
      assert.ok(ansi.includes(theme.board.opinion(language === 'en' ? 'recommends simplicity' : '认为更简单')));
      assert.ok(ansi.includes(theme.board.identifier('report.md')));
      assert.doesNotMatch(stripAnsi(ansi), /[«»「」!+]/);
    }
    assert.equal(f.calls.length, 3);
    assert.match(f.calls[0].messages[0].content, /up to 4 keywords/);
    assert.match(f.calls[0].messages[0].content, /Use «…» keyword delimiters in every language, including Simplified Chinese/);
  });
  test(`typed decision model response survives word cap, painting and cache: ${language}`, async (t) => {
    const f = decisionFixture(t);
    f.service.configure(true, language);
    f.reply = language === 'en' ? '«+Accept» the «!simpler report.md»' : '「+批准」使用「!更简单的report.md」。';
    let board = await f.update();
    const paint = () => decisionRows(board.decisions[0], board.lanes[0], initialMonitorState(), 160, f.now).map((r) => r.text).join('\n');
    assert.ok(paint().includes(theme.board.success(language === 'en' ? 'Accept' : '批准')));
    assert.ok(paint().includes(theme.board.identifier('report.md')));
    assert.doesNotMatch(stripAnsi(paint()), /[«»「」!+]/);
    assert.match(f.calls[0].messages[0].content, /up to 2 keywords/);
    assert.match(f.calls[0].messages[0].content, /Use «…» keyword delimiters in every language, including Simplified Chinese/);
    f.service = new DecisionTitles(f.model, f.file);
    f.service.configure(true, language);
    board = await f.update();
    assert.equal(f.calls.length, 1);
    assert.ok(paint().includes(theme.board.success(language === 'en' ? 'Accept' : '批准')));
  });
}
test('Chinese corner keywords from model paint without brackets and survive cached reopen', async (t) => {
  const f = fixture(t, 'on', 'zh');
  f.reply = '「bar-fields.ts」以「835行」完成检查。';
  let board = await f.update();
  const check = () => {
    const ansi = f.render(board, 120);
    assert.match(stripAnsi(ansi), /bar-fields.ts以835行完成检查。/);
    for (const word of ['bar-fields.ts', '835行']) assert.ok(ansi.includes(theme.board.identifier(word)));
    assert.doesNotMatch(ansi, /[«»「」]/);
  };
  check();
  f.service = new JobSentences(f.model, f.file, () => {}, () => f.now);
  f.service.configure(true, 'zh');
  board = await f.update();
  check();
  assert.equal(f.calls.length, 1);
});
for (const mode of ['off', 'no-key'])
  test(`decision factual fallback: ${mode}`, async (t) => {
    const f = decisionFixture(t, mode),
      before = decisionTitle(f.board().decisions[0]),
      b = await f.update();
    assert.equal(f.calls.length, 0);
    assert.equal(decisionTitle(b.decisions[0]), before);
  });
