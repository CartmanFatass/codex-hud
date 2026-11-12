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
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { Notifier } from '../../dist/notify.js';
import { frameDiff } from '../../dist/render/frame-diff.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { targetKey } from '../../dist/collectors/workboard-types.js';
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
    HERDR_PANE_ID: 'w4E:p1',
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
  const job = (n, pkg, title, state, age, settled = null, pane = 'w4E:p1', extra = {}) => {
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
  job(5, 'PANEL-THIN', 'width flag', 'working', 1, null, 'w4E:p1', { harness: 'codex' });
  job(6, 'TEST-CUT', 'Folded old success', 'closed', 15, 15);
  job(7, 'WRONG-PANE', 'Never show another session', 'working', 1, null, 'w4E:p9');
  const pipeline = new PanelJobPipeline(env.HUD_HOME, null, { live: false }, null, { project: home, pane: 'w4E:p1' });
  const display = setDisplayConfig({ theme: 'none', icons: 'unicode', glyphs: 'glyph' }),
    language = setLanguage('en');
  t.after(() => {
    pipeline.dispose();
    setDisplayConfig(display);
    setLanguage(language);
    rmSync(home, { recursive: true, force: true });
  });
  const tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(now) };
  const render = (board, height = 180, width = 56, state = initialMonitorState()) =>
    renderMonitor({ tree, workboard: board, state, width, height, nowMs: now });
  return { env, pipeline, tree, render, put, askDir, ready };
}
const plain = (frame) => frame.lines.map(stripAnsi);
// Everything starts collapsed; this is the state of a panel where every card and decision was expanded with Enter.
const expandAll = (board, from = initialMonitorState()) => ({
  ...from,
  boardExpanded: new Set([
    ...board.workers.map((w) => targetKey({ kind: 'worker', laneId: w.laneId, workerId: w.id })),
    ...board.decisions.map((d) => targetKey({ kind: 'decision', laneId: d.laneId, decisionId: d.id })),
  ]),
});
const joined = (frame) =>
  plain(frame)
    .map((l) => l.replace(/^[┃|]\s?/, '').trim())
    .join(' ')
    .replace(/\s+/g, ' ');
test('Home: expanded Tier-1 text, exact EN/ZH cells, attention lanes, decision order and ten-minute fold', async (t) => {
  const f = fixture(t);
  await f.pipeline.refresh();
  const board = f.pipeline.workboard(f.tree);
  assert.equal(board.workers.length, 6, 'pane, not project, selects the jobs');
  for (const lang of ['en', 'zh']) {
    setLanguage(lang);
    const frame = f.render(board);
    const text = joined(f.render(board, 180, 56, expandAll(board)));
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
    for (const title of ['thin job cards', 'review card renderer', 'list the slowest', 'check the cut', 'width flag']) {
      const band = plain(frame).find((l) => l.includes(title));
      assert.match(band, lang === 'en' ? /\d+m\s*$/ : /\d+分钟\s*$/);
    }
    if (process.env.PANEL_DUMPS)
      writeFileSync(join(process.env.PANEL_DUMPS, `home-${lang}.txt`), plain(f.render(board, 64)).join('\n') + '\n');
  }
  const home = f.render(board);
  const decision = board.decisions.find((d) => d.departure);
  const target = { kind: 'decision', laneId: decision.laneId, decisionId: decision.id };
  const state = { ...home.state, homeTarget: target };
  // Enter expands the decision in place and the tab stays; `o` opens its files.
  const opened = handleMonitorInput(state, { type: 'key', key: 'enter' }, { tree: f.tree, frame: home });
  assert.equal(opened.action, undefined);
  assert.equal(opened.state.mainTab, 'home');
  const expanded = f.render(board, 24, 56, opened.state);
  assert.ok(
    plain(expanded).some((l) => l.startsWith('◆ PANEL-THIN · imp q2')),
    'the decision is on screen'
  );
  const enter = handleMonitorInput(
    expanded.state,
    { type: 'key', key: 'open-session' },
    { tree: f.tree, frame: expanded }
  );
  assert.deepEqual(enter.action.files, [join(f.askDir, 'qa/q2.md'), join(f.askDir, 'qa/q2.answer.md')]);
  const notifier = new Notifier({ enabled: true, cooldownMs: 0, deliver() {} });
  assert.deepEqual(notifier.update({}, now, board), [], 'existing questions and settled jobs are the baseline');
  f.put(join(f.askDir, 'qa/q3.answer.md'), 'a) separate model line', 0);
  f.put(join(f.askDir, 'qa/q4.md'), `# Question\n\n${question}\n\nDefault if unanswered: yes\n`, 0);
  await f.pipeline.refresh();
  const changed = f.pipeline.workboard(f.tree);
  const sent = notifier.update({}, now + 1, changed);
  assert.equal(sent.length, 1, 'only the later question notifies');
  assert.ok(sent[0].message.includes(question));
  assert.deepEqual(notifier.update({}, now + 2, changed), []);
});
test('Home shows questions, lanes with cards, then decisions; Enter reveals the whole question', async (t) => {
  const f = fixture(t);
  f.put(
    join(f.askDir, 'qa/q3.md'),
    `# Question\n\n${question}\n\nOptions:\n- a) separate model line\n- b) beside the phase strip\n- c) drop the chip\n\nDefault if unanswered: a) separate model line\n\nContext: ${blocked}\n`,
    4
  );
  await f.pipeline.refresh();
  const board = f.pipeline.workboard(f.tree);
  for (const width of [40, 56]) {
    const home = plain(f.render(board, 180, width));
    for (const line of home) assert.equal(visualLength(line), width, line);
    const at = home.findIndex((l) => l.startsWith('? imp · PANEL-THIN')),
      card = home.slice(at, home.findIndex((l, i) => i > at && l.includes('⏎ expand')) + 1);
    assert.ok(card.length >= 3 && card.length <= 6, `${width} columns: ${card.length} rows\n${card.join('\n')}`);
    assert.match(card.join('\n'), /┃ 3 options · default: a\)/);
    assert.match(card.at(-1), /┃ qa\/q3\.md\s+⏎ expand  o open$/);
    assert.doesNotMatch(card.join('\n'), /blocked|b\) beside/);
    if (width === 40) assert.match(card.at(-3), /…\s*$/, 'a long question is cut with an ellipsis');
    const lane = home.findIndex((l) => l.startsWith('PANEL-THIN  '));
    const decided = home.findIndex((l) => l.startsWith('Decided for you'));
    assert.ok(at < lane && lane < decided);
    assert.match(home[lane + 1], /thin job cards/);
    assert.match(home[0], /^ Home 1\s+Project\s+models on$/);
    assert.match(home[decided + 1], /^◆ PANEL-THIN · imp q2 .*…/);
    assert.match(home[decided + 1], /\d+m\s*$/);
    assert.equal(home[decided + 2].trim(), '');
    assert.match(home[decided + 3], /^◇ PANEL-THIN · imp q1  yes\s+\d+m\s*$/);
    assert.doesNotMatch(home.join('\n'), /asked|instead of/);
  }
  const expanded = joined(f.render(board, 180, 56, expandAll(board))).replace(/\s/g, '');
  for (const full of [
    question,
    'blocked ' + blocked,
    'a) separate model line',
    'b) beside the phase strip',
    'c) drop the chip',
    'default: a) separate model line',
    asked,
    chosen.slice(3),
    'instead of ' + instead,
  ])
    assert.ok(expanded.includes(full.replace(/\s/g, '')), full);
});
test('`o` opens a job card file on Home, footer hints never cut a word', async (t) => {
  const f = fixture(t);
  await f.pipeline.refresh();
  const board = f.pipeline.workboard(f.tree),
    frame = f.render(board);
  const open = (id, key = 'open-session') => {
    const worker = board.workers.find((w) => w.id === 'thin-job:j' + String(id).padStart(16, '0'));
    const target = { kind: 'worker', laneId: worker.laneId, workerId: worker.id };
    const state = { ...frame.state, homeTarget: target };
    return handleMonitorInput(state, { type: 'key', key }, { tree: f.tree, frame });
  };
  const jobs = join(f.env.HUD_HOME, 'jobs', 'j');
  assert.deepEqual(open(4).action, { type: 'open-files', files: [join(f.ready, 'report.md')] });
  assert.deepEqual(open(3).action, { type: 'open-files', files: [jobs + '0000000000000003/brief.md'] });
  assert.equal(open(4, 'enter').action, undefined, 'Enter opens no file');
  const foot = (width) =>
    plain(renderMonitor({ tree: f.tree, workboard: board, state: frame.state, width, height: 40, nowMs: now }))
      .at(-1)
      .trimEnd();
  assert.deepEqual([56, 40, 30, 20].map(foot), [
    '✓ 2 done today      ↑↓ move  ⏎ expand  o open  v inspect',
    '✓ 2 done today         ↑↓ move  ⏎ expand',
    '✓ 2 done today         ↑↓ move',
    '✓ 2 done today',
  ]);
  // The row is erased before it is written: a full-width row would lose its last cell to an erase after it.
  const painted = frameDiff(null, ['abc']);
  assert.ok(painted.indexOf('\x1b[K') < painted.indexOf('abc') && !painted.endsWith('\x1b[K'));
});
test('Home Enter toggles cards, decisions and lanes; navigation opens Project; a reveals older decisions', async (t) => {
  const f = fixture(t);
  f.put(join(f.askDir, 'qa/q0.md'), '# Question\n\nOlder choice?\n\nDefault if unanswered: yes', 1500);
  f.put(join(f.askDir, 'qa/q0.answer.md'), 'yes', 1500);
  await f.pipeline.refresh();
  const board = f.pipeline.workboard(f.tree),
    d = board.decisions.find((d) => d.departure),
    w = board.workers[0];
  const rendered = (state) => f.render(board, 180, 56, state);
  const text = (state) => plain(rendered(state)).join('\n');
  const press = (state, bytes) => {
    const frame = rendered(state),
      [input] = new WorkbenchInputDecoder('workboard').push(Buffer.from(bytes));
    return handleMonitorInput(frame.state, input, { tree: f.tree, frame, nowMs: now }).state;
  };
  const at = (target) => ({ ...initialMonitorState(), mainTab: 'home', homeTarget: target });
  const card = at({ kind: 'worker', laneId: w.laneId, workerId: w.id });
  for (const [state, shown] of [
    [card, /cannot be finished/],
    [at({ kind: 'decision', laneId: d.laneId, decisionId: d.id }), /^┃ instead of /m],
  ]) {
    assert.doesNotMatch(text(state), shown);
    assert.match(text(press(state, '\r')), shown);
    assert.doesNotMatch(text(press(press(state, '\r'), '\r')), shown);
  }
  const lane = at({ kind: 'lane', laneId: w.laneId }),
    folded = press(lane, '\r');
  assert.doesNotMatch(text(folded), /thin job cards/);
  assert.match(text(press(folded, '\r')), /thin job cards/);
  const before = rendered(card).state;
  for (const key of ['2', '\x1b[D', '\x1b[C', '\t', '\x1b[Z']) {
    assert.equal(press(before, key).mainTab, 'project');
    assert.deepEqual(press(before, key).homeTarget, before.homeTarget);
  }
  assert.equal(press(before, '1').mainTab, 'home');
  assert.equal(press(before, 'n').mainTab, 'home');
  assert.equal(press(before, 'N').mainTab, 'home');
  assert.doesNotMatch(text(before), /imp q0/);
  assert.match(text(press(before, 'a')), /imp q0/);
  assert.match(text(press(before, 'a')), /Folded old success/);
});
test('Home expiry thresholds and show-all use the real render/input path', async (t) => {
  const f = fixture(t);
  f.put(join(f.env.HUD_HOME, 'jobs/j0000000000000006/STATUS.json'), {
    state: 'stopped',
    settled_at: new Date(now - 15 * 60000).toISOString(),
  });
  await f.pipeline.refresh();
  const board = f.pipeline.workboard(f.tree),
    worker = (n) => board.workers.find((w) => w.id.endsWith(String(n)));
  const decision = (q) => board.decisions.find((d) => d.evidence[0].relativePath === `qa/${q}.md`);
  for (const [kind, item, minutes] of [
    ['workers', worker(4), 5],
    ['workers', worker(3), 21],
    ['workers', worker(6), 15],
    ['decisions', decision('q1'), 22],
    ['decisions', decision('q2'), 114],
  ]) {
    const draw = (at, state = initialMonitorState()) =>
      renderMonitor({ tree: f.tree, workboard: board, state, width: 56, height: 180, nowMs: at });
    const edge = now + minutes * 60000,
      has = (frame) => frame.workboard.snapshot[kind].some((v) => v.id === item.id);
    assert.ok(has(draw(edge - 1)), `${kind} visible before threshold`);
    const hidden = draw(edge);
    assert.ok(!has(hidden), `${kind} hidden at threshold`);
    assert.match(plain(hidden).join('\n'), /\+\d+ older · a/);
    const toggle = (frame) =>
      handleMonitorInput(frame.state, { type: 'key', key: 'show-all' }, { tree: f.tree, frame }).state;
    const shown = draw(edge, toggle(hidden));
    assert.ok(has(shown), `${kind} revealed by a`);
    const target =
      kind === 'workers'
        ? { kind: 'worker', laneId: item.laneId, workerId: item.id }
        : { kind: 'decision', laneId: item.laneId, decisionId: item.id };
    const rows = shown.workboard.rows.filter((r) => r.item === targetKey(target));
    assert.equal(rows.length, 1, 'old items start as one row');
    assert.doesNotMatch(stripAnsi(rows[0].text), /older/);
    assert.match(plain(shown).join('\n'), /\d+ older shown · a hide/);
    const state = { ...shown.state, homeTarget: target };
    const expanded = handleMonitorInput(state, { type: 'key', key: 'enter' }, { tree: f.tree, frame: shown }).state;
    assert.ok(expanded.boardExpanded.has(targetKey(target)));
    if (item !== worker(6))
      assert.ok(draw(edge, expanded).workboard.rows.filter((r) => r.item === targetKey(target)).length > 1, item.id);
    assert.ok(!has(draw(edge, toggle(shown))), `${kind} hidden again by a`);
  }
});
test('a current decision keeps its author after the finished job hides', async (t) => {
  const f = fixture(t);
  f.put(join(f.ready, 'qa/q1.md'), '# Question\n\nKeep this choice?\n\nDefault if unanswered: yes', 5);
  f.put(join(f.ready, 'qa/q1.answer.md'), 'yes', 5);
  await f.pipeline.refresh();
  const board = f.pipeline.workboard(f.tree);
  const frame = renderMonitor({
    tree: f.tree,
    workboard: board,
    state: initialMonitorState(),
    width: 56,
    height: 180,
    nowMs: now + 5 * 60000,
  });
  assert.ok(!frame.workboard.snapshot.workers.some((w) => w.id.endsWith('4')));
  assert.match(plain(frame).join('\n'), /TEST-CUT · imp q1/);
});
test('model button uses the master preference; b matches it and S is inert', async (t) => {
  const f = fixture(t);
  await f.pipeline.refresh();
  const board = f.pipeline.workboard(f.tree);
  let modelEnabled = true;
  const state = initialMonitorState();
  for (const enabled of [true, false]) {
    const frame = renderMonitor({ tree: f.tree, workboard: board, state, modelEnabled, width: 56, height: 40 });
    assert.equal(modelEnabled, enabled);
    assert.match(stripAnsi(frame.lines[0]), enabled ? /models on/ : /models off/);
    const control = frame.controls.find((c) => c.kind === 'brief');
    const ctx = { tree: f.tree, frame };
    const clicked = handleMonitorInput(
      frame.state,
      { type: 'mouse', button: 'left', x: control.x + 1, y: control.y },
      ctx
    );
    assert.equal(clicked.action.type, 'brief-toggle');
    assert.deepEqual(handleMonitorInput(frame.state, { type: 'key', key: 'brief-toggle' }, ctx).action, clicked.action);
    modelEnabled = !modelEnabled;
    const [input] = new WorkbenchInputDecoder('workboard', { forward: true }).push(Buffer.from('S'));
    assert.deepEqual(handleMonitorInput(frame.state, input, ctx).state, frame.state);
  }
  assert.deepEqual(new WorkbenchInputDecoder('workboard').push(Buffer.from('\x1b_codex-hud:summary\x1b\\')), []);
});
test('a lane row ends in one glyph per job, oldest first, then the role of the newest running or asking one', async (t) => {
  const f = fixture(t);
  const dispatch = (n, pkg, state, started, settled) => {
    const id = `j${String(n).padStart(16, '0')}`,
      dir = join(f.env.HUD_HOME, 'jobs', id),
      at = (m) => new Date(now - m * 60000).toISOString();
    f.put(join(dir, 'job.json'), { job: id, role: 'imp', package: pkg, herdr_pane: 'w4E:p1', created_at: at(started) });
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
  const row = (label, width = 40) => {
    const lines = plain(f.render(board, 180, width));
    for (const line of lines) assert.equal(visualLength(line), width, line);
    return lines.find((l) => l.startsWith(label + ' '));
  };
  assert.match(row('STRIP'), /^STRIP  build\s+− ✓ ◉ imp$/);
  assert.match(row('PANEL-THIN'), /\s\? ◉ imp$/, 'asking, then running: the newest of the two names the role');
  assert.match(row('BAD'), /^BAD .*\s✗$/, 'no role when nothing runs or asks');
  assert.match(row('MANY', 24), /^MANY  done\s+\+7 ✓ ✓ ✓ ✓ ✓$/, 'the newest keep their glyphs');
  const home = plain(f.render(board));
  const next = home[home.findIndex((l) => l.startsWith('STRIP  build')) + 1];
  assert.match(next, /^\S imp  STRIP job/, 'cards follow the row');
  setDisplayConfig({ theme: 'none', icons: 'text', glyphs: 'text' });
  assert.match(row('STRIP'), /^STRIP  build\s+- \+ @ imp$/);
  assert.match(row('BAD'), /^BAD .*\s+x$/);
});
test('Home → thin-job Inspector → Changes preserves summary mouse controls with the production sidecar', async (t) => {
  const f = fixture(t);
  await f.pipeline.refresh();
  const board = f.pipeline.workboard(f.tree);
  const worker = board.workers[0];
  const target = { kind: 'worker', laneId: worker.laneId, workerId: worker.id };
  let frame = f.render(board, 24, 56, { ...initialMonitorState(), homeTarget: target });
  const act = (input) => handleMonitorInput(frame.state, input, { tree: f.tree, frame, nowMs: now }).state;
  const inspecting = act({ type: 'key', key: 'inspect' });
  assert.ok(inspecting.boardInspect, 'exercise the thin-job Inspector, not a native agent');
  frame = f.render(board, 24, 56, inspecting);
  const changes = act({ type: 'key', key: 'changes' });
  assert.equal(changes.boardInspect, undefined);
  const worktrees = {
    sourcePath: '/synthetic/w0',
    updatedAt: now,
    entries: Array.from({ length: 40 }, (_, i) => ({
      path: `/synthetic/w${i}`,
      branch: `branch-${i}`,
      head: '1234567',
      status: { changed: 0, staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0 },
      observedAt: now,
    })),
  };
  const render = (state) =>
    renderMonitor({ tree: f.tree, workboard: board, worktrees, state, width: 56, height: 24, nowMs: now });
  frame = render(changes);
  assert.ok(frame.workboard, 'keep the production sidecar on every subsequent frame');
  const pane = frame.panes.find((p) => p.id === 'changes');
  assert.ok(act({ type: 'mouse', button: 'wheel-down', x: pane.x + 1, y: pane.y + 1 }).scroll.changes > 0);
  const title = frame.controls.find((c) => c.kind === 'board-back');
  assert.equal(act({ type: 'mouse', button: 'left', x: title.x, y: title.y }).focus, 'agents');
  frame = render(act({ type: 'key', key: 'home-tab' }));
  assert.equal(frame.state.focus, 'agents');
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
