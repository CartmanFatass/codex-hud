/** The Project Execution page (exec-page/01): synthetic jobs on disk and a fake herdr fork. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { executionJobs, fakeFork, IDS, NOW, PANE } from '../fixtures/execution-page.mjs';
import { viewFor, withState } from '../fixtures/state-helpers.mjs';
import { PanelExecution } from '../../dist/panel/execution.js';
import { countProjectLiveJobs, executionSnapshot } from '../../dist/collectors/execution.js';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { buildWorkboard } from '../../dist/collectors/workboard.js';
import { focusJobTab, hideJobTab, pinJobTab } from '../../dist/cli/panel-pane.js';
import { handleMonitorInput, initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { acceptsMonitorInput } from '../../dist/render/monitor-state.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi, theme, visualLength } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { encodePanelPlace, readPanelPlace } from '../../dist/utils/panel-reload.js';

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(what, probe, ms = 10000) {
  for (const end = Date.now() + ms; !probe();) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await pause(20);
  }
}
async function setup(t, forkOpts) {
  const root = fs.mkdtempSync(join(tmpdir(), 'exec-page-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const socket = join(root, 'h.sock');
  const fork = await fakeFork(t, socket, undefined, forkOpts);
  return { root, socket, fork, ...executionJobs(root, socket) };
}
/** Collect as the panel does with the page up (no periodic pane reads). */
async function opened(t, f) {
  const execution = new PanelExecution(f.hud, PANE);
  t.after(() => execution.dispose());
  execution.sync(f.project);
  await execution.refresh();
  return execution;
}
const onExecution = (nav) => withState(initialMonitorState(), { activeTab: 'execution', ...(nav && { execution: nav }) });
function render(view, { state = onExecution(), width = 100, height = 80, lang = 'en', theme = 'none', icons = 'unicode', workboard, projects, executionCount, homeWaiting, projectWaiting } = {}) {
  const display = setDisplayConfig({ theme, icons }), language = setLanguage(lang);
  try { return renderMonitor({ state, width, height, nowMs: NOW, execution: view, executionCount, workboard, projects, homeWaiting, projectWaiting, projectName: 'demo-project' }); }
  finally { setDisplayConfig(display); setLanguage(language); }
}
const text = (frame) => frame.lines.map(stripAnsi).join('\n');
const itemsOf = (frame) => [...new Set(frame.workboard.rows.map((row) => row.item).filter(Boolean))];
const cards = (...names) => names.map((name) => `project:exec:${IDS[name]}`);

test('each live job has one card without screen rows or read-interval notes in EN and ZH at 40 and 62+ columns', async (t) => {
  const f = await setup(t), execution = await opened(t, f), view = execution.view(f.project);
  // Asking first, then running by age, then queued; another pane's jobs and a worktree's Sonic child belong to the project too.
  assert.deepEqual(view.jobs.map((job) => job.jobId), ['reviewer', 'imp', 'sonic', 'quiet', 'queued'].map((name) => IDS[name]));
  assert.equal(f.fork.requests.length, 0, 'opening Execution reads no worker panes');
  for (const width of [40, 62, 100, 140]) for (const lang of ['en', 'zh']) {
    const frame = render(view, { width, lang }), shown = text(frame);
    for (const line of frame.lines) {
      assert.equal(visualLength(line), width, `${width} ${lang}: ${stripAnsi(line)}`);
      assert.equal(line, stripAnsi(line), 'the none theme paints no colour');
    }
    assert.deepEqual(itemsOf(frame).slice(0, 5), cards('reviewer', 'imp', 'sonic', 'quiet', 'queued'));
    assert.equal(itemsOf(frame).length, 6, 'five cards and one recent job (settled scout folds into live imp)');
    assert.equal(frame.workboard.rows.filter((row) => row.item === cards('imp')[0] && row.text.includes('┌')).length, 1);
    // Compact tab worker cards: no screen divider or 3-row thumbnail (4 rows freed per tab card).
    assert.equal(frame.workboard.rows.filter((row) => row.item === cards('reviewer')[0]).length, 4, `${width} ${lang} reviewer card height`);
    assert.equal(frame.workboard.rows.filter((row) => row.item === cards('imp')[0]).length, 5, `${width} ${lang} imp card height`);
    // Never show screen rows, read-interval note, or pane text.
    assert.doesNotMatch(shown, /画面|├─ screen|screens every|画面每|reading screen|screen unavailable|no screen yet|Review of the synthetic diff|Reading three files|One question for the main session|合成的中文屏幕内容|Edited src\/render\/execution-view\.ts/);
    assert.doesNotMatch(shown, /Reaped long ago|Another project|Delegation|派工关系|Running the build|finished with 0 errors|Workflow|工作流/);
    assert.match(shown, /Finished earlier/);
    if (width >= 62) {
      for (const part of ['Review the synthetic diff', 'Keep the synthetic shim', 'Build passes; writing', 'Found three callers', 'read docs/synthetic.md'])
        assert.ok(shown.includes(part), `${width} ${lang} shows ${part}`);
    }
    const words = lang === 'zh'
      ? (width >= 62 ? ['工作者', '无界面 · 进度', '无界面 · 输出', '提问中', '工作中', '排队 #1', '子任务: code 探路 ✓ · sonic ◉']
        : ['工作者', '无界面 · 进度', '无界面 · 输出', '提问中', '工作中', '排队 #1'])
      : (width >= 62 ? ['Workers', 'headless · progress', 'headless · output', 'asking', 'working', 'queued #1', 'Children: code prewalk scout ✓ · sonic ◉']
        : ['Workers', 'headless · progress', 'headless · output', 'asking', 'working', 'queued #1']);
    for (const word of words) assert.ok(shown.includes(word), `${width} ${lang} shows ${word}`);
    assert.equal(shown.split('\n').filter((line) => /子任务:|Children:/.test(line)).length, 1);
    assert.equal(shown.split('\n').filter((line) => line.includes('Collect the synthetic callers')).length, 1);
  }
  assert.match(text(render(view, { width: 60 })), /from imp j0a01000 .* headless j0a02000/);
  for (const line of render(view, { width: 100, theme: 'dark' }).lines) assert.equal(visualLength(line), 100);
  for (const width of [40, 62]) for (const lang of ['en', 'zh']) {
    for (const line of render(view, { width, height: 24, lang, theme: 'mocha' }).lines) assert.equal(visualLength(line), width);
  }
  const plain = render(view, { width: 40, icons: 'text', lang: 'zh' });
  for (const line of plain.lines) assert.equal(visualLength(line), 40);
  assert.doesNotMatch(text(plain), /[┌┐└┘├┤▸◉○]/);
  assert.doesNotMatch(text(plain), /派工关系|工作流|画面/);

  // With an open workflow above Workers, freed card rows leave room for the workflow and compact worker cards together.
  const withRun = {
    ...view,
    runs: [{
      flow: 'q1a2b3c4d5e6f708', kind: 'queue', label: 'retry-queue', state: 'working', createdAt: NOW - 10 * 60000,
      steps: [{ key: 'tickets', state: 'running' }, { key: 'review', state: 'waiting' }, { key: 'accept', state: 'waiting' }],
      tickets: [{ ticket: '01', title: 'Compact execution', stage: 'worker', role: 'imp', jobId: IDS.imp, since: NOW - 5 * 60000 }],
      queueWaves: {
        prefix: [], current: [{ ticket: '01', title: 'Compact execution', stage: 'worker', role: 'imp', jobId: IDS.imp, since: NOW - 5 * 60000 }], blocked: [],
      },
      todo: [], heldCount: 0, repairRounds: 0, reviews: [], decisions: [],
    }],
  };
  for (const width of [40, 62]) for (const lang of ['en', 'zh']) {
    const compact = text(render(withRun, { width, height: 20, lang }));
    assert.ok(compact.includes(lang === 'zh' ? '工作流' : 'Workflow'), `${width} ${lang} workflow visible`);
    assert.ok(compact.includes(lang === 'zh' ? '工作者' : 'Workers'), `${width} ${lang} workers visible`);
    assert.ok(compact.includes('Review the synthetic diff'), `${width} ${lang} first worker card fits under workflow`);
    assert.doesNotMatch(compact, /画面|├─ screen|screens every/);
  }
});

test('Execution uses an AGY step log without a heartbeat, but still stalls a silent worker', async (t) => {
  const f = await setup(t), home = join(f.root, 'home');
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome; });
  const old = new Date(NOW - 18 * 60000), recent = new Date(NOW - 60000);
  const status = join(f.dir('imp'), 'STATUS.json'), receipt = join(f.dir('imp'), 'job.json');
  const progress = join(f.dir('imp'), 'progress.jsonl');
  fs.unlinkSync(progress);
  fs.writeFileSync(status, JSON.stringify({ state: 'working', harness: 'cli', agent: 'agy',
    agent_session_id: 'synthetic-agy-session', started_at: old.toISOString() }));
  fs.writeFileSync(receipt, JSON.stringify({ ...JSON.parse(fs.readFileSync(receipt, 'utf8')),
    created_at: old.toISOString(), ticket: 'demo/01' }));
  fs.utimesSync(status, old, old);
  const state = (expected) => {
    const scope = { root: f.project, pane: PANE, complete: true };
    const lanes = readThinJobs(f.hud, { project: f.project, pane: PANE, within: f.project });
    const board = buildWorkboard({ rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(NOW) }, lanes);
    const view = executionSnapshot(f.hud, board, scope, NOW);
    const card = render(view).workboard.rows.find((row) => row.item === cards('imp')[0]);
    assert.match(stripAnsi(card.text), new RegExp(`\\b${expected}\\b`));
    assert.equal(view.ticketActivity.find((item) => item.jobId === IDS.imp)?.state, expected);
    return view.jobs.find((job) => job.jobId === IDS.imp).worker;
  };

  state('stalled');
  const logs = join(home, '.gemini/antigravity-cli/brain/synthetic-agy-session/.system_generated/logs');
  const log = join(logs, 'transcript_full.jsonl');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(log, JSON.stringify({ type: 'GENERIC', content: 'synthetic test result' }) + '\n');
  fs.utimesSync(log, recent, recent);
  assert.equal(state('working').latest_progress, null);

  const stallBoundary = new Date(NOW - 10 * 60000);
  fs.utimesSync(log, stallBoundary, stallBoundary);
  state('stalled');
  fs.writeFileSync(progress, JSON.stringify({ at: recent.toISOString(), text: 'Synthetic milestone' }) + '\n');
  assert.equal(state('working').latest_progress.text, 'Synthetic milestone');
  assert.equal(f.fork.requests.length, 0);
});

test('before the first read the page says so, and a project with nothing live says that', () => {
  assert.match(text(render(undefined, { width: 60 })), /Reading jobs…/);
  const empty = { root: '/synthetic', jobs: [], complete: false };
  const shown = text(render(empty, { width: 60 }));
  assert.match(shown, /No running or waiting jobs +Partial/);
  assert.match(text(render(empty, { width: 60, lang: 'zh' })), /没有运行中或等待中的任务/);
});

test('Execution never reads worker panes across refreshes or paint', async (t) => {
  const f = await setup(t), execution = new PanelExecution(f.hud, PANE);
  t.after(() => execution.dispose());
  execution.sync(f.project);
  await execution.refresh();
  assert.equal(execution.view(f.project).jobs.length, 5);
  for (let i = 0; i < 50; i++) render(execution.view(f.project), { width: 40 + i });
  await pause(300);
  await execution.refresh();
  assert.equal(f.fork.requests.length, 0, 'no periodic pane.read or pane.get while Execution is open');
  assert.doesNotMatch(text(render(execution.view(f.project))), /reading screen|screens every|画面/);

  execution.sync(undefined);
  assert.equal(execution.view(f.project), undefined);
});

test('Enter opens the job’s Inspector and Esc returns; g, P and H peek, pin and hide that job’s own tab only', async (t) => {
  const f = await setup(t), execution = await opened(t, f), view = execution.view(f.project);
  const decoder = new WorkbenchInputDecoder('workboard');
  /** Draw, pass one key through the panel's own filter, and handle it. */
  const press = (state, bytes) => {
    const frame = render(view, { state, workboard: state.subpage && execution.board() });
    const input = bytes === '\x1b' ? { type: 'key', key: 'escape' } : decoder.push(Buffer.from(bytes))[0];
    assert.ok(acceptsMonitorInput(frame.state, input), `the panel lets ${JSON.stringify(bytes)} through`);
    return handleMonitorInput(frame.state, input, { frame, nowMs: NOW });
  };
  const tabCalls = () => f.fork.calls('tab.get', 'tab.focus', 'tab.set_hidden').map((r) => [r.method, r.params.tab_id, r.params.hidden].filter((v) => v !== undefined));
  const expectedType = { g: 'focus-job-tab', P: 'pin-job-tab', H: 'hide-job-tab' };
  const act = async (state, bytes, name, run) => {
    const { action } = press(state, bytes);
    assert.deepEqual(action, { type: expectedType[bytes], dir: f.dir(name) });
    const before = tabCalls().length;
    assert.deepEqual(await run(action.dir, f.env), { ok: true });
    return tabCalls().slice(before);
  };

  let state = render(view).state;
  assert.match(text(render(view, { state })), /⏎ details {2}g job tab {2}P pin tab {2}H hide tab {2}\? help/);
  assert.match(text(render(view, { state, lang: 'zh' })), /⏎ 详情 {2}g 任务页 {2}P 固定页 {2}H 隐藏页 {2}\? 帮助/);
  // g sends focus only: the hidden tab peeks and re-hides once focus leaves.
  assert.deepEqual(await act(state, 'g', 'reviewer', focusJobTab), [['tab.get', 'w4E:t4'], ['tab.focus', 'w4E:t4']]);
  assert.deepEqual([f.fork.panes.get('w4E:p4').hidden, f.fork.panes.get('w4E:p4').peek], [false, true]);
  f.fork.leaveFocus();
  assert.deepEqual([f.fork.panes.get('w4E:p4').hidden, f.fork.panes.get('w4E:p4').peek], [true, false]);
  // g then P: P sends set_hidden false only, pinning the tab visible after focus leaves.
  assert.deepEqual(await act(state, 'g', 'reviewer', focusJobTab), [['tab.get', 'w4E:t4'], ['tab.focus', 'w4E:t4']]);
  assert.deepEqual(await act(state, 'P', 'reviewer', pinJobTab), [['tab.get', 'w4E:t4'], ['tab.set_hidden', 'w4E:t4', false]]);
  assert.deepEqual([f.fork.panes.get('w4E:p4').hidden, f.fork.panes.get('w4E:p4').peek], [false, false]);
  f.fork.leaveFocus();
  assert.deepEqual([f.fork.panes.get('w4E:p4').hidden, f.fork.panes.get('w4E:p4').peek], [false, false]);
  // H sends set_hidden true only.
  assert.deepEqual(await act(state, 'H', 'reviewer', hideJobTab), [['tab.get', 'w4E:t4'], ['tab.set_hidden', 'w4E:t4', true]]);
  assert.deepEqual([f.fork.panes.get('w4E:p4').hidden, f.fork.panes.get('w4E:p4').peek], [true, false]);

  state = press(state, 'j').state;
  assert.equal(state.execution.cursor, cards('imp')[0]);
  assert.deepEqual(await act(state, 'g', 'imp', focusJobTab), [['tab.get', 'w4E:t3'], ['tab.focus', 'w4E:t3']]);
  assert.deepEqual([f.fork.panes.get('w4E:p3').hidden, f.fork.panes.get('w4E:p3').peek], [false, true]);
  assert.equal(f.fork.panes.get('w4E:p4').hidden, true, 'no other job’s tab moved');
  assert.deepEqual(await act(state, 'P', 'imp', pinJobTab), [['tab.get', 'w4E:t3'], ['tab.set_hidden', 'w4E:t3', false]]);
  assert.equal(f.fork.panes.get('w4E:p4').hidden, true, 'pin touches only the selected job’s tab');

  // Reused public tab_id with another launch_id: g, P and H all refuse without mutating the replacement tab.
  f.fork.panes.get('w4E:p4').launch_id = 'launch_replacement';
  const beforeStale = f.fork.calls('tab.focus', 'tab.set_hidden').length;
  for (const run of [focusJobTab, pinJobTab, hideJobTab]) {
    assert.deepEqual(await run(f.dir('reviewer'), f.env), { ok: false, reason: 'tab closed' });
  }
  assert.equal(f.fork.calls('tab.focus', 'tab.set_hidden').length, beforeStale);

  // Enter: that job's Inspector, with the same three actions, then back to the same card.
  const inspector = press(state, '\r').state;
  assert.deepEqual([inspector.subpage.kind, inspector.subpage.from, inspector.subpage.target.workerId], ['inspector', 'execution', `thin-job:${IDS.imp}`]);
  const detail = text(render(view, { state: inspector, workboard: execution.board() }));
  assert.match(detail, /EXEC-01|synthetic page/);
  assert.match(detail, /Sonic children/);
  assert.match(detail, /Scout the synthetic code/);
  assert.match(detail, /Collect the synthetic callers/);
  assert.deepEqual(press(inspector, 'g').action, { type: 'focus-job-tab', dir: f.dir('imp') });
  assert.deepEqual(press(inspector, 'P').action, { type: 'pin-job-tab', dir: f.dir('imp') });
  assert.deepEqual(press(inspector, 'H').action, { type: 'hide-job-tab', dir: f.dir('imp') });
  const back = press(inspector, '\x1b').state;
  assert.equal(back.subpage, undefined);
  assert.equal(back.activeTab, 'execution');
  assert.equal(back.execution.cursor, cards('imp')[0]);

  // A headless or queued job has no tab: the keys do nothing and the footer does not offer them.
  for (const name of ['sonic', 'queued']) {
    const on = onExecution({ cursor: cards(name)[0] });
    assert.doesNotMatch(text(render(view, { state: on })), /job tab|pin tab|hide tab/);
    assert.equal(press(on, 'g').action, undefined);
    assert.equal(press(on, 'P').action, undefined);
    assert.equal(press(on, 'H').action, undefined);
  }
  assert.ok(itemsOf(render(view)).every((item) => !item.startsWith('project:exec-tree:')));
  // Elsewhere in the panel the letters stay inert.
  assert.equal(acceptsMonitorInput(initialMonitorState(), { type: 'key', text: 'P' }), false);
  assert.equal(acceptsMonitorInput(initialMonitorState(), { type: 'key', text: 'H' }), false);
});

test('older forks without hidden_tabs_peek keep today’s g/H behaviour and refuse P without calling tab.set_hidden', async (t) => {
  // Fork with hidden_tabs only (no hidden_tabs_peek).
  {
    const f = await setup(t, { hiddenTabs: true, hiddenTabsPeek: false });
    assert.deepEqual(await focusJobTab(f.dir('reviewer'), f.env), { ok: true });
    assert.equal(f.fork.panes.get('w4E:p4').hidden, false);
    assert.deepEqual(await pinJobTab(f.dir('reviewer'), f.env), { ok: false, reason: 'tab pinning unavailable' });
    assert.equal(f.fork.calls('tab.set_hidden').length, 0);
    assert.deepEqual(await hideJobTab(f.dir('reviewer'), f.env), { ok: true });
    assert.equal(f.fork.panes.get('w4E:p4').hidden, true);
    assert.deepEqual(f.fork.calls('tab.focus', 'tab.set_hidden').map((r) => [r.method, r.params]),
      [['tab.focus', { tab_id: 'w4E:t4' }], ['tab.set_hidden', { tab_id: 'w4E:t4', hidden: true }]]);
  }
  // Older fork without hidden_tabs at all.
  {
    const f = await setup(t, { hiddenTabs: false, hiddenTabsPeek: false });
    assert.deepEqual(await focusJobTab(f.dir('reviewer'), f.env), { ok: true });
    assert.deepEqual(await pinJobTab(f.dir('reviewer'), f.env), { ok: false, reason: 'tab pinning unavailable' });
    assert.deepEqual(await hideJobTab(f.dir('reviewer'), f.env), { ok: false, reason: 'hidden tabs unavailable' });
    assert.equal(f.fork.calls('tab.set_hidden').length, 0);
  }
});

test('the live panel makes zero periodic pane reads with Execution open across watcher ticks, while g/P/H reach the fork', { timeout: 60000 }, async (t) => {
  const f = await setup(t), home = join(f.root, 'home'), bin = join(f.root, 'bin'), settings = join(f.root, 'settings.json');
  for (const dir of [home, bin]) fs.mkdirSync(dir);
  fs.writeFileSync(settings, JSON.stringify({ modelEnabled: false, refreshMs: 250 }));
  // A closed environment: the only herdr it can reach is the fake, and no herdr command is on its PATH.
  const child = spawn(process.execPath, [resolve('dist/tree-page.js')], {
    env: { HOME: home, HUD_HOME: f.hud, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), PATH: bin, TZ: 'UTC',
      HUD_SETTINGS_PATH: settings, CODEX_HUD_STANDALONE_PANEL: '1', CODEX_HUD_CWD: f.project, HERDR_SOCKET_PATH: f.socket, HERDR_PANE_ID: PANE,
      HUD_PANEL_RELOAD_PLACE: encodePanelPlace({ state: onExecution(), settings: null }) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (b) => { stdout += b; });
  child.stderr.on('data', (b) => { stderr += b; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });

  await until('Execution page to paint', () => stripAnsi(stdout).includes('Review the synthetic diff'));
  assert.doesNotMatch(stripAnsi(stdout), /画面|├─ screen|screens every|Reading three files/);
  // Stay on Execution across multiple panel refresh/watcher ticks (refreshMs = 250 ms).
  await pause(1200);
  assert.equal(f.fork.calls('pane.read', 'pane.get').length, 0, 'no periodic pane reads while Execution is open');

  child.stdin.write('g');
  await until('the tab to come forward', () => f.fork.calls('tab.focus').length === 1);
  child.stdin.write('P');
  await until('the tab to pin', () => f.fork.calls('tab.set_hidden').length === 1);
  child.stdin.write('H');
  await until('the tab to hide', () => f.fork.calls('tab.set_hidden').length === 2);
  assert.deepEqual([...f.fork.calls('tab.focus', 'tab.set_hidden')].map((r) => r.params),
    [{ tab_id: 'w4E:t4' }, { tab_id: 'w4E:t4', hidden: false }, { tab_id: 'w4E:t4', hidden: true }]);

  child.stdin.write('\r');
  await pause(500);
  child.stdin.write('\x1b');
  await pause(600);
  child.stdin.write('\t');
  await pause(500);
  assert.equal(f.fork.calls('pane.read', 'pane.get').length, 0, 'still zero pane reads across Inspector, return, and tab switch');
  assert.equal(stderr, '');
});

test('Execution top tab shows live count at 40 and 62 columns (EN/ZH, no-colour & mocha), omits 0, keeps ?N badges, cycles 4 tabs and follows [ ] with Project', async (t) => {
  const f = await setup(t), execution = await opened(t, f), view = execution.view(f.project);
  const projects = [{ root: f.project, name: 'orchard' }, { root: '/synthetic/other', name: 'kiln' }];
  const empty = { root: f.project, jobs: [], complete: true };
  assert.equal(countProjectLiveJobs(f.hud, f.project), view.jobs.length, 'countProjectLiveJobs matches Execution live jobs');
  assert.equal(countProjectLiveJobs(f.hud, '/synthetic/other'), 0);

  for (const width of [40, 62]) for (const lang of ['en', 'zh']) {
    const busy = render(view, { width, height: 30, lang, theme: 'none', projects });
    for (const line of busy.lines) {
      assert.equal(visualLength(line), width, `busy ${width} ${lang}: ${line}`);
      assert.equal(line, stripAnsi(line), 'no-colour emits no ANSI');
    }
    assert.equal(
      stripAnsi(busy.lines[0]).trim().replace(/ +/g, ' '),
      lang === 'zh' ? '首页 项目 执行·5 控制' : 'Home Project Execution·5 Control',
    );
    assert.deepEqual(
      busy.controls.filter((c) => c.y === 0 && c.kind.startsWith('board-')).map((c) => c.kind),
      ['board-home', 'board-project', 'board-execution', 'board-control'],
    );
    const foot = stripAnsi(busy.lines.at(-1)).trim();
    if (width === 62) {
      assert.equal(foot, lang === 'zh'
        ? '⏎ 详情  [ ] 项目  g 任务页  P 固定页  H 隐藏页  ? 帮助'
        : '⏎ details  [ ] project  g job tab  P pin tab  ? help');
    } else {
      assert.ok(foot.includes(lang === 'zh' ? '[ ] 项目' : '[ ] project'), `40-col footer has project switch: ${foot}`);
      assert.ok(foot.endsWith(lang === 'zh' ? '? 帮助' : '? help'));
    }

    const idle = render(empty, { width, height: 20, lang, theme: 'none', projects });
    for (const line of idle.lines) {
      assert.equal(visualLength(line), width, `idle ${width} ${lang}: ${line}`);
      assert.equal(line, stripAnsi(line));
    }
    assert.equal(
      stripAnsi(idle.lines[0]).trim().replace(/ +/g, ' '),
      lang === 'zh' ? '首页 项目 执行 控制' : 'Home Project Execution Control',
    );

    const coloured = render(view, { width, height: 20, lang, theme: 'mocha', projects });
    for (const line of coloured.lines) assert.equal(visualLength(line), width, `mocha ${width} ${lang}`);
  }

  // Keep ?N request badges on Home and Project alongside Execution·N; inactive Execution paints N with board.active.
  const prevDisplay = setDisplayConfig({ theme: 'mocha', icons: 'unicode' });
  const prevLang = setLanguage('zh');
  try {
    const onProject = renderMonitor({
      state: withState(initialMonitorState(), { activeTab: 'project' }),
      width: 62, height: 20, nowMs: NOW, executionCount: 3, homeWaiting: [{ label: '', value: 'r1' }], projectWaiting: 2,
    });
    assert.equal(visualLength(onProject.lines[0]), 62);
    assert.equal(stripAnsi(onProject.lines[0]).trim().replace(/ +/g, ' '), '首页 ?1 项目 ?2 执行·3 控制');
    assert.ok(onProject.lines[0].includes(theme.board.active('3')));
    setLanguage('en');
    const onProjectEn = renderMonitor({
      state: withState(initialMonitorState(), { activeTab: 'project' }),
      width: 62, height: 20, nowMs: NOW, executionCount: 3, homeWaiting: [{ label: '', value: 'r1' }], projectWaiting: 2,
    });
    assert.equal(visualLength(onProjectEn.lines[0]), 62);
    assert.equal(stripAnsi(onProjectEn.lines[0]).trim().replace(/ +/g, ' '), 'Home ?1 Project ?2 Execution·3 Control');
    assert.ok(onProjectEn.lines[0].includes(theme.board.active('3')));
  } finally {
    setDisplayConfig(prevDisplay);
    setLanguage(prevLang);
  }

  // [ ] switches project on both Execution and Project, keeping both tabs in step; Tab/arrows/click cycle 4 tabs.
  const decoder = new WorkbenchInputDecoder('workboard');
  const step = (state, raw) => {
    const frame = render(view, { state, width: 62, height: 24, projects });
    const input = typeof raw === 'string' ? decoder.push(Buffer.from(raw))[0] : raw;
    return handleMonitorInput(frame.state, input, { frame, nowMs: NOW }).state;
  };
  let state = step(onExecution(), 'j');
  assert.equal(state.execution.cursor, cards('imp')[0]);
  state = step(state, ']');
  assert.equal(state.selectedProject, '/synthetic/other');
  assert.equal(state.activeTab, 'execution');
  assert.equal(state.execution.cursor, undefined, 'switching project resets Execution cursor');
  // Shift-Tab to Project sees the same switched project.
  state = step(state, '\x1b[Z');
  assert.equal(state.activeTab, 'project');
  assert.equal(state.selectedProject, '/synthetic/other');
  // [ on Project switches back to the first project (undefined), and Tab to Execution stays in step.
  state = step(state, '[');
  assert.equal(state.selectedProject, undefined);
  state = step(state, '\t');
  assert.equal(state.activeTab, 'execution');
  assert.equal(state.selectedProject, undefined);
  // Click board-control, then board-execution.
  const execFrame = render(view, { state, width: 62, height: 24, projects });
  const ctrlBtn = execFrame.controls.find((c) => c.kind === 'board-control');
  state = step(state, { type: 'mouse', button: 'left', x: ctrlBtn.x, y: ctrlBtn.y });
  assert.equal(state.activeTab, 'control');
  const execBtn = execFrame.controls.find((c) => c.kind === 'board-execution');
  state = step(state, { type: 'mouse', button: 'left', x: execBtn.x, y: execBtn.y });
  assert.equal(state.activeTab, 'execution');

  // Reload preserves Execution tab + cursor and migrates legacy Project/execution to the Execution tab.
  const prevReload = process.env.HUD_PANEL_RELOAD_PLACE;
  t.after(() => {
    if (prevReload === undefined) delete process.env.HUD_PANEL_RELOAD_PLACE;
    else process.env.HUD_PANEL_RELOAD_PLACE = prevReload;
  });
  const saved = onExecution({ cursor: cards('imp')[0], scroll: 2 });
  saved.selectedProject = '/synthetic/other';
  process.env.HUD_PANEL_RELOAD_PLACE = encodePanelPlace({ state: saved, settings: null });
  const restored = readPanelPlace().state;
  assert.equal(restored.activeTab, 'execution');
  assert.equal(restored.selectedProject, '/synthetic/other');
  assert.deepEqual([restored.execution.cursor, restored.execution.scroll], [cards('imp')[0], 2]);
  process.env.HUD_PANEL_RELOAD_PLACE = JSON.stringify({
    schemaVersion: 2,
    stateV2: { activeTab: 'project', project: { view: { kind: 'execution' }, nav: { cursor: cards('imp')[0], scroll: 3 } } },
  });
  const migrated = readPanelPlace().state;
  assert.equal(migrated.activeTab, 'execution');
  assert.equal(migrated.project.view.kind, 'hub');
  assert.deepEqual([migrated.execution.cursor, migrated.execution.scroll], [cards('imp')[0], 3]);
});
