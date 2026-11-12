import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { PanelJobPipeline } from '../../dist/tree-page.js';
import { initialMonitorState, renderMonitor, handleMonitorInput } from '../../dist/render/monitor.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi, visualLength, theme } from '../../dist/render/colors.js';
import { Notifier } from '../../dist/notify.js';
import { frameDiff } from '../../dist/render/frame-diff.js';
const now = new Date().setHours(12, 0, 0, 0);
const question =
  'Where should the model chip go on a card whose phase strip is longer than one complete line at 56 columns, without hiding any of the important results?';
const blocked =
  'The card layout cannot be finished until the model chip has a place at 56 columns; 中文宽度必须保持正确。';
const instead =
  'a) use only --width with no settings key, keeping the original worker default even when this explanation wraps onto several more lines';
const chosen =
  'b) add the optional settings key as well, preserving all of this deliberately long decision headline instead of silently cutting its tail';
const asked =
  'Should the default panel width live only in a --width flag, or also in the settings file so every later invocation can reuse the owner choice without a repeated command?';
const reason =
  'The provider returned HTTP 429 (rate limit) on the second request. The worker stopped without retrying and no report was written. This entire failure reason must stay visible.';
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'hud-v7-'));
  const env = {
    ...process.env,
    HOME: join(home, 'home'),
    HUD_HOME: join(home, 'hud'),
    CODEX_HOME: join(home, 'codex'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    PI_CODING_AGENT_DIR: join(home, 'pi'),
    HERDR_PANE_ID: 'main',
  };
  for (const key of ['HOME', 'HUD_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR'])
    mkdirSync(env[key], { recursive: true });
  const ago = (m) => new Date(now - m * 60000);
  const put = (file, value, age = 1) => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    utimesSync(file, ago(age), ago(age));
  };
  const qa = (
    ask,
    fallback = 'a) separate model line',
    options = ['a) separate model line', 'b) beside the phase strip']
  ) =>
    `# Question\n\n${ask}\n\nOptions:\n${options.map((o) => '- ' + o).join('\n')}\n\nDefault if unanswered: ${fallback}\n\nContext: ${blocked}\n`;
  const job = (n, pkg, title, state, age, settled = null, pane = 'main', extra = {}) => {
    const id = `j${String(n).padStart(16, '0')}`,
      dir = join(env.HUD_HOME, 'jobs', id);
    put(
      join(dir, 'job.json'),
      {
        job: id,
        role: 'imp',
        cwd: join(home, 'unrelated-project'),
        package: pkg,
        herdr_pane: pane,
        created_at: ago(40).toISOString(),
        ...extra,
      },
      40
    );
    put(join(dir, 'brief.md'), '# ' + title, 40);
    put(
      join(dir, 'STATUS.json'),
      {
        state,
        model: n === 1 ? 'openai/gpt-6.1-sol' : 'zhipu/glm-5.3',
        thinking: n === 1 ? 'high' : 'max',
        provider: 'gateway',
        started_at: ago(40).toISOString(),
        ...(settled === null ? {} : { settled_at: ago(settled).toISOString() }),
        ...(state === 'failed' ? { exit_reason: reason } : {}),
      },
      age
    );
    return dir;
  };
  const askDir = job(1, 'PANEL-THIN', 'thin job cards in the panel', 'working', 1);
  put(join(askDir, 'qa/q1.md'), qa('Keep the card at three lines?', 'yes', ['yes', 'no']), 9);
  put(join(askDir, 'qa/q1.answer.md'), 'yes', 8);
  put(join(askDir, 'qa/q2.md'), qa(asked, instead, [instead, chosen]), 7);
  put(join(askDir, 'qa/q2.answer.md'), chosen, 6);
  put(join(askDir, 'qa/q3.md'), qa(question), 4);
  put(join(askDir, 'report.md'), 'Build complete; tests green', 10);
  put(join(askDir, 'review-1.md'), 'Verdict: changes-required\n\n2 major: preserve complete Tier-1 text', 5);
  const stalled = job(2, 'TEST-CUT', 'review card renderer', 'working', 14);
  put(join(stalled, 'report.md'), 'Comparing card widths and checking all remaining tests', 14);
  job(3, 'TEST-CUT', 'list the slowest tests', 'failed', 9, 9);
  const ready = job(4, 'TEST-CUT', 'check the cut list', 'idle_grace', 20, 5);
  put(join(ready, 'report.md'), 'Accepts the cuts; all tests pass', 2);
  job(5, 'PANEL-THIN', 'width flag', 'working', 1, null, 'main', { harness: 'codex' });
  job(6, 'TEST-CUT', 'Folded old success', 'closed', 15, 15);
  job(7, 'WRONG-PANE', 'Never show another session', 'working', 1, null, 'elsewhere');
  const pipeline = new PanelJobPipeline(env.HUD_HOME, null, { live: false }, null, { project: home, pane: 'main' });
  const display = setDisplayConfig({ theme: 'none', icons: 'unicode', glyphs: 'glyph' }),
    language = setLanguage('en');
  t.after(() => {
    pipeline.dispose();
    setDisplayConfig(display);
    setLanguage(language);
    rmSync(home, { recursive: true, force: true });
  });
  const tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(now) };
  const render = (board, tab, height = 180, width = 56, from = initialMonitorState()) =>
    renderMonitor({ tree, workboard: board, state: { ...from, mainTab: tab }, width, height, nowMs: now });
  return { env, pipeline, tree, render, put, askDir, ready };
}
const plain = (frame) => frame.lines.map(stripAnsi);
const joined = (frame) =>
  plain(frame)
    .map((l) => l.replace(/^[┃|]\s?/, '').trim())
    .join(' ')
    .replace(/\s+/g, ' ');
test('v7 Work: whole Tier-1 text, Home: exact EN/ZH cells, attention lanes, decision order and ten-minute fold', async (t) => {
  const f = fixture(t);
  await f.pipeline.refresh();
  const board = f.pipeline.workboard(f.tree);
  assert.equal(board.workers.length, 6, 'pane, not project, selects the jobs');
  for (const lang of ['en', 'zh']) {
    setLanguage(lang);
    const frame = f.render(board, 'home');
    const text = joined(f.render(board, 'work'));
    for (const full of [
      question,
      blocked,
      'a) separate model line',
      'b) beside the phase strip',
      asked,
      chosen.slice(3),
      instead,
      reason,
    ])
      assert.ok(text.replace(/\s/g, '').includes(full.replace(/\s/g, '')), full);
    for (const line of plain(frame)) assert.equal(visualLength(line), 56, line);
    assert.ok(
      plain(frame).findIndex((l) => l.startsWith('PANEL-THIN')) <
        plain(frame).findIndex((l) => l.startsWith('TEST-CUT'))
    );
    assert.ok(text.indexOf(chosen.slice(3)) < text.indexOf('yes'));
    assert.ok(!text.includes('Folded old success'));
    assert.ok(!text.includes('WRONG-PANE'));
    assert.match(text, lang === 'en' ? /3 done today/ : /3 今日完成/);
    for (const title of ['thin job cards', 'review card renderer', 'list the slowest', 'check the cut', 'width flag']) {
      const band = plain(frame).find((l) => l.includes(title));
      assert.match(band, lang === 'en' ? /\d+m\s*$/ : /\d+分钟\s*$/);
    }
    assert.ok(!text.includes('…'), 'Work cuts nothing');
    if (process.env.PANEL_DUMPS)
      for (const tab of ['home', 'work'])
        writeFileSync(
          join(process.env.PANEL_DUMPS, `${tab}-${lang}.txt`),
          plain(f.render(board, tab, 64)).join('\n') + '\n'
        );
  }
  const home = f.render(board, 'home');
  const decision = board.decisions.find((d) => d.departure);
  const target = { kind: 'decision', laneId: decision.laneId, decisionId: decision.id };
  const state = { ...home.state, homeTarget: target };
  // Home's Enter goes to Work with the decision selected and scrolled into view; there Enter opens its files.
  const opened = handleMonitorInput(state, { type: 'key', key: 'enter' }, { tree: f.tree, frame: home });
  assert.equal(opened.action, undefined);
  assert.deepEqual([opened.state.mainTab, opened.state.workTarget], ['work', target]);
  const work = f.render(board, 'work', 24, 56, opened.state);
  assert.ok(
    plain(work).some((l) => l.startsWith('◆ PANEL-THIN · imp q2')),
    'the decision is on screen'
  );
  const enter = handleMonitorInput(opened.state, { type: 'key', key: 'enter' }, { tree: f.tree, frame: work });
  assert.deepEqual(enter.action.files, [join(f.askDir, 'qa/q2.md'), join(f.askDir, 'qa/q2.answer.md')]);
  const notifier = new Notifier({ enabled: true, cooldownMs: 0, deliver() {} });
  assert.ok(notifier.update({}, now, board).some((e) => e.message.includes(question)));
});
test('Home is a scannable summary: a short question card and one row per decision; Work has the whole', async (t) => {
  const f = fixture(t);
  f.put(
    join(f.askDir, 'qa/q3.md'),
    `# Question\n\n${question}\n\nOptions:\n- a) separate model line\n- b) beside the phase strip\n- c) drop the chip\n\nDefault if unanswered: a) separate model line\n\nContext: ${blocked}\n`,
    4
  );
  await f.pipeline.refresh();
  const board = f.pipeline.workboard(f.tree);
  for (const width of [40, 56]) {
    const home = plain(f.render(board, 'home', 180, width));
    for (const line of home) assert.equal(visualLength(line), width, line);
    const at = home.findIndex((l) => l.startsWith('? imp · PANEL-THIN')),
      card = home.slice(at, home.findIndex((l, i) => i > at && l.includes('⏎ Work')) + 1);
    assert.ok(card.length >= 3 && card.length <= 6, `${width} columns: ${card.length} rows\n${card.join('\n')}`);
    assert.match(card.join('\n'), /┃ 3 options · default: a\)/);
    assert.doesNotMatch(card.join('\n'), /blocked|b\) beside/);
    if (width === 40) assert.match(card.at(-3), /…\s*$/, 'a long question is cut with an ellipsis');
    const decided = home.findIndex((l) => l.startsWith('Decided for you'));
    assert.match(home[decided + 1], /^◆ PANEL-THIN · imp q2 .*…/);
    assert.match(home[decided + 1], /\d+m\s*$/);
    assert.equal(home[decided + 2].trim(), '');
    assert.match(home[decided + 3], /^◇ PANEL-THIN · imp q1  yes\s+\d+m\s*$/);
    assert.doesNotMatch(home.join('\n'), /asked|instead of/);
  }
  const work = joined(f.render(board, 'work')).replace(/\s/g, '');
  for (const full of [
    question,
    'blocked ' + blocked,
    'a) separate model line',
    'b) beside the phase strip',
    'c) drop the chip',
    'default a) separate model line',
    asked,
    chosen.slice(3),
    'instead of ' + instead,
  ])
    assert.ok(work.includes(full.replace(/\s/g, '')), full);
});
test('v7 Work: file-derived phase chain and vendor/model/full effort chips', async (t) => {
  const f = fixture(t);
  await f.pipeline.refresh();
  const board = f.pipeline.workboard(f.tree),
    frame = f.render(board, 'work');
  const text = joined(frame);
  assert.match(text, /build ✓ › review r1 2 major › ▸asking/);
  assert.match(text, /◎ gpt-6\.1-sol high/);
  assert.doesNotMatch(text, /openai\/|zhipu\//);
  assert.match(text, /ℤ glm-5\.3 max/);
  assert.match(text, /glm-5\.3 max codex/);
  assert.doesNotMatch(text, /high pi|max pi/);
  assert.ok(!text.includes('Folded old success'), 'Work folds read/finished history, not unread reports');
  for (const line of plain(frame)) assert.equal(visualLength(line), 56);
  setDisplayConfig({ theme: 'none', icons: 'text', glyphs: 'text' });
  const ascii = joined(f.render(board, 'work'));
  assert.match(ascii, /OAI gpt-6\.1-sol high/);
  assert.match(ascii, /GLM glm-5\.3 max/);
  f.put(join(f.ready, 'review-1.md'), 'Verdict: changes-required\n2 major', 5);
  f.put(join(f.ready, 'review-2.md'), 'Verdict: accept', 1);
  await f.pipeline.refresh();
  setDisplayConfig({ theme: 'terminal', icons: 'unicode', glyphs: 'glyph' });
  const painted = f.render(f.pipeline.workboard(f.tree), 'work');
  assert.match(joined(painted), /build ✓ › review r1 2 major › review r2 accept › done/);
  for (const line of plain(painted)) {
    assert.equal(visualLength(line), 56);
    assert.doesNotMatch(line, /\x1b|\[38;2;/);
  }
});
test('Work: Enter opens a job card file, footer hints never cut a word', async (t) => {
  const f = fixture(t);
  await f.pipeline.refresh();
  const board = f.pipeline.workboard(f.tree),
    frame = f.render(board, 'work');
  const enter = (id, mainTab = 'work') => {
    const worker = board.workers.find((w) => w.id === 'thin-job:j' + String(id).padStart(16, '0'));
    const target = { kind: 'worker', laneId: worker.laneId, workerId: worker.id };
    const state = { ...frame.state, mainTab, workTarget: target, homeTarget: target };
    return handleMonitorInput(state, { type: 'key', key: 'enter' }, { tree: f.tree, frame });
  };
  const jobs = join(f.env.HUD_HOME, 'jobs', 'j');
  assert.deepEqual(enter(4).action, { type: 'job-files', files: [join(f.ready, 'report.md')] });
  assert.deepEqual(enter(3).action, { type: 'job-files', files: [jobs + '0000000000000003/brief.md'] });
  assert.equal(enter(4, 'home').action, undefined, 'on Home, Enter still goes to the Work tab');
  assert.equal(enter(4, 'home').state.mainTab, 'work');
  const foot = (width) =>
    plain(renderMonitor({ tree: f.tree, workboard: board, state: frame.state, width, height: 40, nowMs: now }))
      .at(-1)
      .replace(/^✓ 3 done today\s*/, '>');
  assert.deepEqual([56, 30, 28, 20].map(foot), ['>←→ tab  ↑↓ move  ⏎ open', '>←→ tab  ↑↓ move', '>←→ tab', '>']);
  // The row is erased before it is written: a full-width row would lose its last cell to an erase after it.
  const painted = frameDiff(null, ['abc']);
  assert.ok(painted.indexOf('\x1b[K') < painted.indexOf('abc') && !painted.endsWith('\x1b[K'));
});
test('a lane row ends in one glyph per job, oldest first, then the role of the newest running or asking one', async (t) => {
  const f = fixture(t);
  const dispatch = (n, pkg, state, started, settled) => {
    const id = `j${String(n).padStart(16, '0')}`,
      dir = join(f.env.HUD_HOME, 'jobs', id),
      at = (m) => new Date(now - m * 60000).toISOString();
    f.put(join(dir, 'job.json'), { job: id, role: 'imp', package: pkg, herdr_pane: 'main', created_at: at(started) });
    f.put(join(dir, 'brief.md'), `# ${pkg} job ${n}`);
    f.put(join(dir, 'STATUS.json'), {
      state,
      started_at: at(started),
      ...(settled ? { settled_at: at(settled) } : {}),
    });
  };
  dispatch(31, 'STRIP', 'stopped', 30, 5);
  dispatch(32, 'STRIP', 'closed', 20, 3);
  dispatch(33, 'STRIP', 'working', 10);
  dispatch(34, 'BAD', 'failed', 5, 2);
  for (let n = 0; n < 12; n++) dispatch(40 + n, 'MANY', 'closed', 25 - n, 2);
  await f.pipeline.refresh();
  const board = f.pipeline.workboard(f.tree);
  const row = (tab, label, width = 40) => {
    const lines = plain(f.render(board, tab, 180, width));
    for (const line of lines) assert.equal(visualLength(line), width, line);
    return lines.find((l) => l.startsWith(label + ' '));
  };
  for (const tab of ['home', 'work']) {
    assert.match(row(tab, 'STRIP'), /^STRIP  build\s+− ✓ ◉ imp$/);
    assert.match(row(tab, 'PANEL-THIN'), /\s\? ◉ imp$/, 'asking, then running: the newest of the two names the role');
    assert.match(row(tab, 'BAD'), /^BAD .*\s✗$/, 'no role when nothing runs or asks');
    assert.match(row(tab, 'MANY', 24), /^MANY  done\s+\+7 ✓ ✓ ✓ ✓ ✓$/, 'the newest keep their glyphs');
  }
  const work = plain(f.render(board, 'work'));
  const next = work[work.findIndex((l) => l.startsWith('STRIP  build')) + 1];
  assert.match(next, /^\S imp  STRIP job/, 'cards follow the row');
  setDisplayConfig({ theme: 'none', icons: 'text', glyphs: 'text' });
  assert.match(row('home', 'STRIP'), /^STRIP  build\s+- \+ @ imp$/);
  assert.match(row('work', 'BAD'), /^BAD .*\s+x$/);
});
test('statusline Work count reads job folders with no role-summary cache', (t) => {
  const f = fixture(t);
  assert.equal(existsSync(join(f.env.HUD_HOME, 'display/role-summary')), false);
  const clock = join(f.env.HOME, 'clock.mjs');
  writeFileSync(clock, `Date.now=()=>${now};`);
  const result = spawnSync(process.execPath, ['--import', clock, resolve('bin/hud'), 'statusline', '--width', '160'], {
    env: f.env,
    input: JSON.stringify({ session_id: 'synthetic', model: { display_name: 'Synthetic' } }),
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  // A settled job is done, read or not: no "report ready" count.
  assert.match(result.stdout, /Work: 1 needs you · 1 stalled · 1 failed · 1 running/);
});
