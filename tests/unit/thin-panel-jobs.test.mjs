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
  const ready = job(4, 'TEST-CUT', 'check the cut list', 'idle_grace', 20, 20);
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
  const render = (board, tab, height = 180) => {
    const state = { ...initialMonitorState(), mainTab: tab };
    return renderMonitor({ tree, workboard: board, state, width: 56, height, nowMs: now });
  };
  return { env, pipeline, tree, render, put, askDir, ready };
}
const plain = (frame) => frame.lines.map(stripAnsi);
const joined = (frame) =>
  plain(frame)
    .map((l) => l.replace(/^[┃|]\s?/, '').trim())
    .join(' ')
    .replace(/\s+/g, ' ');
test('v7 Home: whole Tier-1 text, exact EN/ZH cells, attention lanes, decision order and ten-minute fold', async (t) => {
  const f = fixture(t);
  await f.pipeline.refresh();
  const board = f.pipeline.workboard(f.tree);
  assert.equal(board.workers.length, 6, 'pane, not project, selects the jobs');
  for (const lang of ['en', 'zh']) {
    setLanguage(lang);
    const frame = f.render(board, 'home');
    const text = joined(frame);
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
    assert.ok(!text.includes('…'));
    if (process.env.PANEL_DUMPS)
      for (const tab of ['home', 'work'])
        writeFileSync(
          join(process.env.PANEL_DUMPS, `${tab}-${lang}.txt`),
          plain(f.render(board, tab, 64)).join('\n') + '\n'
        );
  }
  const home = f.render(board, 'home');
  const decision = board.decisions.find((d) => d.departure);
  const state = { ...home.state, homeTarget: { kind: 'decision', laneId: decision.laneId, decisionId: decision.id } };
  const opened = handleMonitorInput(state, { type: 'key', key: 'enter' }, { tree: f.tree, frame: home });
  assert.deepEqual(opened.action.files, [join(f.askDir, 'qa/q2.md'), join(f.askDir, 'qa/q2.answer.md')]);
  const notifier = new Notifier({ enabled: true, cooldownMs: 0, deliver() {} });
  assert.ok(notifier.update({}, now, board).some((e) => e.message.includes(question)));
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
  assert.match(joined(painted), /build ✓ › review r1 2 major › review r2 accept › accept/);
  assert.ok(painted.lines.some((line) => line.includes(theme.board.success('accept'))));
  for (const line of plain(painted)) {
    assert.equal(visualLength(line), 56);
    assert.doesNotMatch(line, /\x1b|\[38;2;/);
  }
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
  assert.match(result.stdout, /Work: 1 needs you · 1 stalled · 1 failed · 1 report ready · 1 running/);
});
