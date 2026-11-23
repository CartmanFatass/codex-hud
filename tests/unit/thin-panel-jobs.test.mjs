import { withState } from '../fixtures/state-helpers.mjs';
import { homeTarget } from '../../dist/render/monitor-state.js';
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
import { collectJobLanes } from '../../dist/collectors/job-snapshot.js';
import { buildWorkboard } from '../../dist/collectors/workboard.js';
import { flowLine, flowSummary } from '../../dist/render/work-card.js';
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
  const ready = job(4, 'TEST-CUT', 'check the cut list', 'idle_grace', 20, 4);
  put(join(ready, 'report.md'), 'Accepts the cuts; all tests pass', 2);
  job(5, 'PANEL-THIN', 'width flag', 'working', 1, null, 'w4E:p1', { harness: 'codex' });
  job(6, 'TEST-CUT', 'Folded old success', 'closed', 15, 15);
  job(7, 'WRONG-PANE', 'Never show another session', 'working', 1, null, 'w4E:p9');
  const pipeline = new PanelJobPipeline(env.HUD_HOME, { project: home, pane: 'w4E:p1' }, now - 60 * 60000);
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
  return { env, pipeline, tree, render, put, job, askDir, ready };
}
const plain = (frame) => frame.lines.map(stripAnsi);
// Everything starts collapsed; this is the state of a panel where every card was expanded with Enter.
const expandAll = (board, from = initialMonitorState()) => (withState(from, { home: { expanded: new Set([
    ...board.workers.map((w) => targetKey({ kind: 'worker', laneId: w.laneId, workerId: w.id })),
  ]) } }));
const joined = (frame) =>
  plain(frame)
    .map((l) => l.replace(/^\s*[┃|]\s?/, '').trim())
    .join(' ')
    .replace(/\s+/g, ' ');
test('Home: expanded Tier-1 text, exact EN/ZH cells, attention lanes and ten-minute fold', async (t) => {
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
      reason,
    ])
      assert.ok(text.replace(/\s/g, '').includes(full.replace(/\s/g, '')), full);
    for (const line of plain(frame)) assert.equal(visualLength(line), 56, line);
    assert.ok(
      plain(frame).findIndex((l) => l.startsWith('PANEL-THIN')) <
        plain(frame).findIndex((l) => l.startsWith('TEST-CUT'))
    );
    for (const hidden of [asked, chosen.slice(3), instead]) assert.ok(!text.includes(hidden));
    assert.ok(!text.includes('Folded old succ'));
    assert.ok(!text.includes('WRONG-PANE'));
    // A job row carries its lane's short name as its id (a child under a lane header: the head of its brief's heading), never the title.
    for (const id of ['review car', 'list the s', 'check the ', 'PANEL-THIN']) {
      const band = plain(frame).find((l) => l.includes(id) && !/asks|问/.test(l));
      assert.match(band, lang === 'en' ? /\d+m(?: quiet \d+m)?\s*$/ : /\d+分(?: 静\d+分)?\s*$/);
    }
    if (process.env.PANEL_DUMPS)
      writeFileSync(join(process.env.PANEL_DUMPS, `home-${lang}.txt`), plain(f.render(board, 64)).join('\n') + '\n');
  }
  const home = f.render(board);
  assert.ok(board.decisions.some((d) => d.departure));
  assert.ok(![...home.workboard.targets.values()].some((target) => target.kind === 'decision'));
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
test('Home frame folds a running sonic child into ⚡1 on its parent row with no sonic row or card', async (t) => {
  const f = fixture(t);
  f.job(8, 'SONIC-PRIVATE-LABEL', 'Inspect synthetic fixtures', 'working', 0, null, 'w4E:p1', {
    role: 'sonic', parent_job: 'j0000000000000005', created_at: new Date(now - 2000).toISOString(),
  });
  await f.pipeline.refresh();
  const board = f.pipeline.workboard(f.tree);
  const frame = f.render(board, 45);
  const lines = plain(frame);
  const parent = lines.find((line) => /^⚒ +PANEL-THIN/.test(line));
  assert.ok(parent && parent.includes('⚡1'), lines.join('\n'));
  assert.ok(!lines.some((line) => line.includes('Inspect synthetic')));
  assert.ok(!lines.some((line) => line.includes('SONIC-PRIVATE-LABEL')));
  assert.ok(lines.every((line) => visualLength(line) === 56));
});

test('Home shows questions and lanes with cards without duplicating asking cards; Enter reveals the whole question', async (t) => {
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
    const at = home.findIndex((l) => /^⚒ \? {2}PANEL-THIN/.test(l)), card = home.slice(at, at + 2);
    assert.match(card[0], /asks 3 opts +\d+m$/, `${width} columns: the question is a row with its option count`);
    assert.match(card[1], /^ {5}Where should the model chip go/, 'and its text under it');
    assert.match(card[1], /…\s*$/, 'a long question is cut with an ellipsis');
    assert.doesNotMatch(card.join('\n'), /blocked|b\) beside|qa\/q3\.md|⏎|default:/);
    const row = home.findIndex((l) => /^⚒ +PANEL-THIN/.test(l)); // one job left in the lane: its row, no lane header
    assert.ok(at < row);
    assert.doesNotMatch(home.join('\n'), /Decided for you|PANEL-THIN · imp q[12]/);
    assert.equal(home.filter((l) => /asks 3 opts/.test(l)).length, 1, 'asking job stays in its row above, never duplicated in the lane');
    assert.match(home[0], /^ Home \?1\s+Project\s+Control\s*$/);
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
    const state = withState(frame.state, { home: { cursor: { kind: 'work', target: target } } });
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
  for (const width of [56, 40, 30, 20]) {
    const row = foot(width);
    assert.equal(visualLength(row), width);
    assert.match(row, width >= 56 ? /^✓ 2 done today +/ : /^✓ 2 +/);
    assert.match(row, /  \? help$/);
    assert.ok(!row.includes('…'), row);
  }
  // The row is erased before it is written: a full-width row would lose its last cell to an erase after it.
  const painted = frameDiff(null, ['abc']);
  assert.ok(painted.indexOf('\x1b[K') < painted.indexOf('abc') && !painted.endsWith('\x1b[K'));
});
test('Home Enter toggles cards and lanes; navigation opens Project; a reveals older cards only', async (t) => {
  const f = fixture(t);
  f.put(join(f.askDir, 'qa/q0.md'), '# Question\n\nOlder choice?\n\nDefault if unanswered: yes', 1500);
  f.put(join(f.askDir, 'qa/q0.answer.md'), 'yes', 1500);
  await f.pipeline.refresh();
  const board = f.pipeline.workboard(f.tree), w = board.workers[0];
  const rendered = (state) => f.render(board, 180, 56, state);
  const text = (state) => plain(rendered(state)).join('\n');
  const press = (state, bytes) => {
    const frame = rendered(state),
      [input] = new WorkbenchInputDecoder('workboard').push(Buffer.from(bytes));
    return handleMonitorInput(frame.state, input, { tree: f.tree, frame, nowMs: now }).state;
  };
  const at = (target) => (withState(initialMonitorState(), { activeTab: 'home', home: { cursor: { kind: 'work', target: target } } }));
  const card = at({ kind: 'worker', laneId: w.laneId, workerId: w.id });
  assert.doesNotMatch(text(card), /cannot be finished/);
  assert.match(text(press(card, '\r')), /cannot be finished/);
  assert.doesNotMatch(text(press(press(card, '\r'), '\r')), /cannot be finished/);
  // PANEL-THIN has one job left and no lane header; the TEST-CUT lane folds.
  const lane = at({ kind: 'lane', laneId: board.lanes.find((l) => l.label === 'TEST-CUT').id }),
    folded = press(lane, '\r');
  assert.doesNotMatch(text(folded), /review card ren…/);
  assert.match(text(press(folded, '\r')), /review card ren…/);
  const before = rendered(card).state;
  for (const [key, tab] of [['\x1b[D', 'control'], ['\x1b[C', 'project'], ['\t', 'project'], ['\x1b[Z', 'control']]) {
    assert.equal(press(before, key).activeTab, tab);
    assert.deepEqual(homeTarget(press(before, key).home), homeTarget(before.home));
  }
  for (const digit of ['1', '2']) assert.equal(press(before, digit).activeTab, 'home', 'the digits switch no tab');
  assert.equal(press(before, 'n').activeTab, 'home');
  assert.equal(press(before, 'N').activeTab, 'home');
  assert.doesNotMatch(text(before), /imp q0/);
  assert.doesNotMatch(text(press(before, 'a')), /imp q0|Older choice/);
  assert.match(text(press(before, 'a')), /Folded old succ…/);
});
test('an answered question is still collected after the finished job hides', async (t) => {
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
    nowMs: now + 10 * 60000,
  });
  assert.ok(!frame.workboard.snapshot.workers.some((w) => w.id.endsWith('4')));
  assert.ok(frame.workboard.snapshot.decisions.some((d) => d.question === 'Keep this choice?'));
  assert.doesNotMatch(plain(frame).join('\n'), /TEST-CUT · imp q1|Keep this choice/);
});
test('a folded lane header ends in one state glyph per job it shows, oldest first, without sonic; a lane with one job has no header', async (t) => {
  const f = fixture(t);
  const dispatch = (n, pkg, state, started, settled) => {
    const id = `j${String(n).padStart(16, '0')}`,
      dir = join(f.env.HUD_HOME, 'jobs', id),
      at = (m) => new Date(now - m * 60000).toISOString();
    // Distinct targets in one display lane: the stopped card has not been retried.
    f.put(join(dir, 'job.json'), { job: id, role: 'imp', package: pkg, ticket: n, herdr_pane: 'w4E:p1', created_at: at(started) });
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
  await f.pipeline.refresh();
  const board = f.pipeline.workboard(f.tree);
  const folded = withState(initialMonitorState(), { home: { foldedLanes: new Set(board.lanes.map((l) => l.id)) } });
  const lines = (width = 40, state = folded) => {
    const out = plain(f.render(board, 180, width, state));
    for (const line of out) assert.equal(visualLength(line), width, line);
    return out;
  };
  const row = (label) => lines().find((l) => l.startsWith(label + ' '));
  assert.match(row('STRIP'), /^STRIP\s+− ◉$/, 'the closed job is in the finished row, not the strip');
  assert.equal(row('BAD'), undefined, 'one job: its own row, no header to fold');
  assert.match(lines(40, initialMonitorState()).find((l) => /^⚒ ✗ +BAD /.test(l)), /✗ failed/);
  const home = lines(40, initialMonitorState());
  assert.match(home[home.findIndex((l) => /^STRIP\s+/.test(l)) + 1], /^ {2}\S( \S)? +STRIP job/, 'its jobs follow the header');
  setDisplayConfig({ theme: 'none', icons: 'text', glyphs: 'text' });
  assert.match(row('STRIP'), /^STRIP\s+- @$/);
});
test('Home → thin-job Inspector → Changes preserves summary mouse controls with the production sidecar', async (t) => {
  const f = fixture(t);
  await f.pipeline.refresh();
  const board = f.pipeline.workboard(f.tree);
  const worker = board.workers[0];
  const target = { kind: 'worker', laneId: worker.laneId, workerId: worker.id };
  let frame = f.render(board, 24, 56, withState(initialMonitorState(), { home: { cursor: { kind: 'work', target: target } } }));
  const act = (input) => handleMonitorInput(frame.state, input, { tree: f.tree, frame, nowMs: now }).state;
  const inspecting = act({ type: 'key', key: 'inspect' });
  assert.ok(inspecting.subpage?.target, 'exercise the thin-job Inspector, not a native agent');
  frame = f.render(board, 24, 56, inspecting);
  const changes = act({ type: 'key', key: 'changes' });
  assert.equal(changes.subpage?.target, undefined);
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
  assert.ok(act({ type: 'mouse', button: 'wheel-down', x: pane.x + 1, y: pane.y + 1 }).subpage.scroll > 0);
  const title = frame.controls.find((c) => c.kind === 'board-back');
  assert.equal(act({ type: 'mouse', button: 'left', x: title.x, y: title.y }).subpage, undefined);
  frame = render(act({ type: 'key', key: 'escape' }));
  assert.equal(frame.state.subpage, undefined);
});

test('Claude compact and detail lines omit HUD job counts without a fresh census', (t) => {
  const f = fixture(t);
  assert.equal(existsSync(join(f.env.HUD_HOME, 'display/role-summary')), false);
  const clock = join(f.env.HOME, 'clock.mjs');
  writeFileSync(clock, `Date.now=()=>${now};`);
  const run = (args = []) => spawnSync(process.execPath, ['--import', clock, resolve('bin/hud'), 'statusline', '--width', '160', ...args], {
    env: f.env,
    input: JSON.stringify({ session_id: 'synthetic', model: { display_name: 'Synthetic' } }),
    encoding: 'utf8',
    timeout: 10000,
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(stripAnsi(result.stdout), /HUD \(OS\)|!1|thin job cards|asks/);
  const details = run(['--details']);
  assert.equal(details.status, 0, details.stderr);
  assert.doesNotMatch(details.stdout, /HUD \(OS\)|Work:|needs you/);
});

test('a queued land names the job it waits on: its ticket id, else the holder’s flow id (panel-polish/04)', async (t) => {
  const f = fixture(t);
  const wait = (holder) => ({ flow: 'f0000000000000092', job: 'j0000000000000092', pane: 'w4E:p1', task: false, state: 'queued', step: `waiting for ${holder} (gate step 2, 3 min)`,
    wt: { main_root: '/synthetic/repo', root: '/synthetic/wt', branch: 'wt/wait', base_head: 'aaaaaaa' }, config: { base: 'main', gate: ['npm test'], after: [], push: false },
    source_sha: 'bbbbbbb', pid: 999999, start: '1', created_at: new Date(now - 60000).toISOString(), updated_at: new Date(now - 10000).toISOString() });
  f.job(91, 'HOLD', 'HOLD-07: keep the lease', 'closed', 3, 3);
  f.job(92, 'WAIT', 'WAIT-02: land behind it', 'closed', 3, 3);
  const flowFile = join(f.env.HUD_HOME, 'flows', 'f0000000000000092.json');
  const waiting = async () => (await f.pipeline.refresh(), f.pipeline.workboard(f.tree).workers.find((w) => w.flow?.state === 'queued').flow);
  f.put(flowFile, wait('f0000000000000091'), 0);
  let flow = await waiting();
  assert.equal(flow.waitsOn, 'HOLD-07');
  for (const [lang, narrow, wide] of [['en', 'wait HOLD-07 · gate 2, 3m', 'waiting for HOLD-07 (gate step 2, 3 min)'], ['zh', '等待 HOLD-07 · 门禁 2，3分', '等待 HOLD-07（门禁第 2 步，3 分钟）']]) {
    setLanguage(lang);
    assert.ok(stripAnsi(flowLine(flow, 80, (x) => x)).includes(wide), `${lang}: ${stripAnsi(flowLine(flow, 80, (x) => x))}`);
    assert.ok(stripAnsi(flowLine(flow, 30, (x) => x)).includes(narrow), `${lang} narrow`);
    assert.ok(flowSummary(flow).includes(wide), `${lang}: the Inspector's flow row`);
  }
  setLanguage('en');
  f.put(flowFile, wait('f0000000000000077-2'), 0);
  flow = await waiting();
  assert.equal(flow.waitsOn, undefined, 'a holder this board does not have stays its flow id');
  assert.ok(flowSummary(flow).includes('waiting for f0000000000000077-2'));
});

test('work cards show land and scout flow steps and final outcomes in EN and ZH', async (t) => {
  const f = fixture(t);
  // Test each on-disk transition, not whether a watch notification beats the next request.
  const project = async () => buildWorkboard(f.tree, (await collectJobLanes(f.env.HUD_HOME,
    { project: null, pane: f.env.HERDR_PANE_ID }, { openedAt: f.pipeline.openedAt })).lanes);
  const landId = 'j0000000000000081', flowId = 'f0000000000000081';
  const flowFile = join(f.env.HUD_HOME, 'flows', `${flowId}.json`);
  // Settled 10 minutes ago (past the 5m fold window): an active land must keep it visible and unfolded.
  f.job(81, 'FLOW-LAND', 'land synthetic slice', 'closed', 10, 10);
  const firstRun = {
    flow: flowId, job: landId, pane: 'w4E:p1', task: false,
    wt: { main_root: '/synthetic/repo', root: '/synthetic/wt', branch: 'wt/flow', base_head: 'aaaaaaa' },
    config: { base: 'main', gate: ['npm test'], after: [], push: true },
    source_sha: 'bbbbbbb', pid: 999999, start: '1',
    state: 'running', step: 'gate[1]: npm test',
    created_at: new Date(now - 60000).toISOString(),
    updated_at: new Date(now - 10000).toISOString(),
  };
  f.put(flowFile, firstRun, 0);
  // Scouted job: scouting -> run -> done.
  const scoutDir = f.job(82, 'FLOW-SCOUT', 'scout synthetic slice', 'working', 0, null, 'w4E:p1', { scout_state: 'scouting' });
  f.put(join(scoutDir, 'STATUS.json'), { state: 'working', reason: 'scouting', started_at: new Date(now - 60000).toISOString() }, 0);

  let board = await project();
  for (const [lang, scoutStep] of [['en', 'scouting'], ['zh', '侦察中']]) {
    setLanguage(lang);
    for (const width of [40, 80]) {
      const lines = plain(f.render(board, 180, width));
      for (const line of lines) assert.equal(visualLength(line), width, `${lang} ${width}: ${line}`);
      const text = lines.join('\n');
      // A land has no sub-row on Home (the gate step is the Inspector's): the fifth stage cell is current. A scout keeps its row.
      assert.ok(lines.some((l) => l.includes('●●●●◐')), `${lang} ${width}\n${text}`);
      assert.doesNotMatch(text, /gate\[1\]|落地 ·|land ·/, `${lang} ${width}`);
      assert.ok(text.includes(scoutStep), `${lang} ${width}\n${text}`);
    }
  }

  const retryFile = join(f.env.HUD_HOME, 'flows', `${flowId}-2.json`);
  f.put(flowFile, { ...firstRun, state: 'failed', error: 'timeout' }, 0);
  const queued = { ...firstRun, flow: `${flowId}-2`, state: 'queued', step: 'waiting for f0000000000000099 (gate step 2, 3 min)' };
  f.put(retryFile, queued, 0);
  board = await project();
  for (const [lang, narrow, wide] of [
    ['en', 'wait f0000000000000099 · gate 2, 3m', queued.step],
    ['zh', '等待 f0000000000000099 · 门禁 2，3分', '等待 f0000000000000099（门禁第 2 步，3 分钟）'],
  ]) {
    setLanguage(lang);
    const waiting = board.workers.find((w) => w.flow?.state === 'queued').flow;
    for (const [width, detail] of [[40, narrow], [80, wide]]) {
      const lines = plain(f.render(board, 180, width));
      assert.doesNotMatch(lines.join('\n'), /f0000000000000099/, 'Home does not say whom the land waits for');
      assert.ok(lines.some((l) => l.includes('●●●●◐')), 'the land is still the fifth cell');
      assert.ok(stripAnsi(flowLine(waiting, width, (s) => s)).includes(detail), `${lang} ${width}: the card (Inspector) keeps the wait line`);
      assert.ok(lines.every(line => visualLength(line) === width));
    }
  }

  // Advance land to completed with SHA, and scouted job to running after scout finished.
  f.put(retryFile, { ...queued, landed_sha: '1234567890abcdef', state: 'completed', step: 'done',
    updated_at: new Date(now - 5000).toISOString() }, 0);
  f.put(join(scoutDir, 'job.json'), {
    job: 'j0000000000000082', role: 'imp', cwd: '/synthetic/repo', package: 'FLOW-SCOUT', herdr_pane: 'w4E:p1',
    created_at: new Date(now - 60000).toISOString(), scout_state: 'done',
  }, 0);
  f.put(join(scoutDir, 'STATUS.json'), { state: 'working', started_at: new Date(now - 60000).toISOString() }, 0);
  board = await project();
  for (const [lang, landedText, runText] of [
    ['en', '✓ gate ▸ ✓ merge ▸ ✓ push · landed 1234567', '✓ scout ▸ ◉ run'],
    ['zh', '✓ 门禁 ▸ ✓ 合并 ▸ ✓ 推送 · 已落地 1234567', '✓ 侦察 ▸ ◉ 运行'],
  ]) {
    setLanguage(lang);
    // A finished flow leaves Home's job rows; the Inspector's flow row (flowSummary) keeps its steps and outcome.
    assert.doesNotMatch(plain(f.render(board, 180, 80)).join('\n'), /▸/, lang);
    const summaries = board.workers.flatMap((w) => (w.flow ? [flowSummary(w.flow)] : [])).join('\n');
    assert.ok(summaries.includes(landedText), `${lang}\n${summaries}`);
    assert.ok(summaries.includes(runText), `${lang}\n${summaries}`);
  }

  // Failed land reports the failing stage and error.
  f.put(retryFile, { ...queued, config: { ...queued.config, push: false }, state: 'failed', step: 'fast-forward', error: 'base moved',
    updated_at: new Date(now - 2000).toISOString() }, 0);
  board = await project();
  for (const [lang, failedText] of [
    ['en', '✓ gate ▸ ✗ merge · failed: base moved'],
    ['zh', '✓ 门禁 ▸ ✗ 合并 · 失败：base moved'],
  ]) {
    setLanguage(lang);
    const text = plain(f.render(board, 180, 80)).join('\n');
    assert.ok(text.includes(lang === 'en' ? '✗ merge red' : '✗ 合并红'), `${lang}: Home names the red step\n${text}`);
    assert.ok(flowSummary(board.workers.find((w) => w.flow?.state === 'failed').flow).includes(failedText), `${lang}: the chain is the card's`);
  }
});
