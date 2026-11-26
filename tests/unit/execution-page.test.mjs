/** The Project Execution page (exec-page/01): synthetic jobs on disk and a fake herdr fork. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { executionJobs, fakeFork, tabPane, IDS, NOW, PANE } from '../fixtures/execution-page.mjs';
import { viewFor, withState } from '../fixtures/state-helpers.mjs';
import { PanelExecution } from '../../dist/panel/execution.js';
import { ScreenSampler, thumbnailLines } from '../../dist/collectors/execution-screens.js';
import { focusJobTab, hideJobTab } from '../../dist/cli/panel-pane.js';
import { handleMonitorInput, initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { acceptsMonitorInput } from '../../dist/render/monitor-state.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { encodePanelPlace } from '../../dist/utils/panel-reload.js';

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(what, probe, ms = 10000) {
  for (const end = Date.now() + ms; !probe();) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await pause(20);
  }
}
async function setup(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'exec-page-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const socket = join(root, 'h.sock');
  const fork = await fakeFork(t, socket);
  return { root, socket, fork, ...executionJobs(root, socket) };
}
/** Collect as the panel does with the page up, and wait for both tab workers' screens. */
async function opened(t, f) {
  const execution = new PanelExecution(f.hud, PANE, f.env, () => {});
  t.after(() => execution.dispose());
  execution.sync(f.project, true);
  await execution.refresh();
  await until('both screens', () => execution.view(f.project)?.screens.size === 2);
  return execution;
}
const onExecution = (nav) => withState(initialMonitorState(), { activeTab: 'project', project: { view: viewFor('execution'), ...(nav && { nav }) } });
function render(view, { state = onExecution(), width = 100, height = 80, lang = 'en', theme = 'none', icons = 'unicode', workboard } = {}) {
  const display = setDisplayConfig({ theme, icons }), language = setLanguage(lang);
  try { return renderMonitor({ state, width, height, nowMs: NOW, execution: view, workboard, projectName: 'demo-project' }); }
  finally { setDisplayConfig(display); setLanguage(language); }
}
const text = (frame) => frame.lines.map(stripAnsi).join('\n');
const itemsOf = (frame) => [...new Set(frame.workboard.rows.map((row) => row.item).filter(Boolean))];
const cards = (...names) => names.map((name) => `project:exec:${IDS[name]}`);

test('every running and waiting job of the project has a card and a place in the delegation tree, at exact width in 60, 100 and 140 columns', async (t) => {
  const f = await setup(t), execution = await opened(t, f), view = execution.view(f.project);
  // Asking first, then running by age, then queued; another pane's jobs and a worktree's Sonic child belong to the project too.
  assert.deepEqual(view.jobs.map((job) => job.jobId), ['reviewer', 'imp', 'sonic', 'quiet', 'queued'].map((name) => IDS[name]));
  for (const width of [60, 100, 140]) for (const lang of ['en', 'zh']) {
    const frame = render(view, { width, lang }), shown = text(frame);
    for (const line of frame.lines) {
      assert.equal(visualLength(line), width, `${width} ${lang}: ${stripAnsi(line)}`);
      assert.equal(line, stripAnsi(line), 'the none theme paints no colour');
    }
    assert.deepEqual(itemsOf(frame).slice(0, 5), cards('reviewer', 'imp', 'sonic', 'quiet', 'queued'));
    assert.equal(itemsOf(frame).length, 11, 'five cards and six tree rows: the settled scout is in the tree only');
    // Tab workers show their last screen lines; headless ones their progress, else their output.
    for (const part of ['Review of the synthetic diff', 'One question for the main session', '• Running the build', '    tsc finished with 0 errors',
      '合成的中文屏幕内容', 'Keep the synthetic shim', 'Build passes; writing', 'Found three callers', 'read docs/synthetic.md'])
      assert.ok(shown.includes(part), `${width} ${lang} shows ${part}`);
    assert.doesNotMatch(shown, /Finished earlier|Reaped long ago|Another project/);
    const words = lang === 'zh' ? ['工作者', '派工关系', '画面', '无界面 · 进度', '无界面 · 输出', '提问中', '工作中', '排队 #1', '本窗格', '侦察']
      : ['Workers', 'Delegation', '├─ screen', 'headless · progress', 'headless · output', 'asking', 'working', 'queued #1', 'this pane', 'code scout'];
    for (const word of words) assert.ok(shown.includes(word), `${width} ${lang} shows ${word}`);
    // Who started whom: the main sessions, their jobs, and what those started.
    const tree = shown.slice(shown.indexOf(lang === 'zh' ? '派工关系' : 'Delegation')).split('\n').map((line) => line.trimEnd());
    const at = (pattern) => tree.findIndex((line) => pattern.test(line));
    const order = [/^ {2}Claude 5e55a0de/, /^ {2}├─ \S imp {2}EXEC-01/, /^ {2}│ {2}├─ \S sonic · code .*Scout/, /^ {2}│ {2}└─ \S sonic {2}Collect/,
      /^ {2}└─ \? reviewer/, /^ {2}Codex c0de0000/, /^ {2}├─ \S imp {2}EXEC-02/, /^ {2}└─ \S sonic {2}Check/].map(at);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), tree.join('\n'));
    assert.ok(order.every((row) => row > 0), tree.join('\n'));
  }
  assert.match(text(render(view, { width: 60 })), /from imp j0a01000 .* headless j0a02000/);
  for (const line of render(view, { width: 100, theme: 'dark' }).lines) assert.equal(visualLength(line), 100);
  const plain = render(view, { width: 40, icons: 'text', lang: 'zh' });
  for (const line of plain.lines) assert.equal(visualLength(line), 40);
  assert.doesNotMatch(text(plain), /[┌┐└┘├┤▸◉○]/);
  assert.match(text(plain), /\|- /);
});

test('before the first read the page says so, and a project with nothing live says that', () => {
  assert.match(text(render(undefined, { width: 60 })), /Reading jobs…/);
  const empty = { root: '/synthetic', jobs: [], sessions: [], complete: false, screens: new Map() };
  const shown = text(render(empty, { width: 60 }));
  assert.match(shown, /No running or waiting jobs +Partial/);
  assert.match(text(render(empty, { width: 60, lang: 'zh' })), /没有运行中或等待中的任务/);
});

test('paint asks herdr nothing, and nothing is read while the page is closed', async (t) => {
  const f = await setup(t), execution = new PanelExecution(f.hud, PANE, f.env, () => {});
  t.after(() => execution.dispose());
  // An Inspector opened from the page keeps its jobs, without screens.
  execution.sync(f.project, false);
  await execution.refresh();
  assert.equal(execution.view(f.project).jobs.length, 5);
  for (let i = 0; i < 20; i++) render(execution.view(f.project));
  await pause(300);
  assert.equal(f.fork.requests.length, 0);
  assert.match(text(render(execution.view(f.project))), /reading screen/);

  execution.sync(f.project, true);
  await until('both screens', () => execution.view(f.project).screens.size === 2);
  const read = f.fork.requests.length;
  for (let i = 0; i < 50; i++) render(execution.view(f.project), { width: 60 + i });
  await pause(300);
  assert.equal(f.fork.requests.length, read, 'painting reads no screen, and the next round is not due');
  // Only the two live tab workers' panes, and only to read and to check whose they are.
  assert.deepEqual([...new Set(f.fork.requests.map((r) => `${r.method} ${r.params.pane_id}`))].sort(),
    ['pane.get w4E:p3', 'pane.get w4E:p4', 'pane.read w4E:p3', 'pane.read w4E:p4']);
  assert.deepEqual(f.fork.calls('pane.read')[0].params, { pane_id: 'w4E:p4', source: 'visible', format: 'text', strip_ansi: true });

  execution.sync(f.project, false);
  await pause(2300);
  assert.equal(f.fork.requests.length, read, 'no reads once the page is left');
  assert.equal(execution.view(f.project).screens.size, 0, 'an old screen does not come back as a live one');
  execution.sync(undefined, false);
  assert.equal(execution.view(f.project), undefined);
});

test('screen sampling is bounded: a batch per round, a rate that reopening cannot beat, and a repaint only for a change', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'exec-screens-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const socket = join(root, 'h.sock'), list = Array.from({ length: 10 }, (_, i) => tabPane(i + 10, `w${i}`, `worker ${i}\n`));
  const fork = await fakeFork(t, socket, list);
  const targets = list.map((p, i) => ({ jobId: `j${i}`, pane: p.pane_id, launchId: p.launch_id, terminalId: p.terminal_id }));
  const rounds = [];
  const sampler = new ScreenSampler({ HERDR_SOCKET_PATH: socket }, () => rounds.push({ reads: fork.calls('pane.read').length, screens: sampler.current().size }), 150);
  t.after(() => sampler.stop());
  sampler.watch(targets);
  await pause(100);
  assert.equal(fork.requests.length, 0, 'watching alone reads nothing');
  const started = performance.now();
  sampler.start();
  await until('every screen', () => sampler.current().size === 10);
  await pause(500);
  assert.deepEqual(rounds, [{ reads: 8, screens: 8 }, { reads: 16, screens: 10 }], 'eight a round, the rest next; unchanged rounds repaint nothing');
  const reads = fork.calls('pane.read').length;
  assert.ok(reads <= 8 * (Math.floor((performance.now() - started) / 150) + 1), `${reads} reads`);

  // A reused pane ID or a vanished pane is not the job's screen.
  fork.panes.get('w4E:p10').launch_id = 'launch_someone_else';
  fork.panes.delete('w4E:p11');
  await until('closed screens', () => ['j0', 'j1'].every((id) => sampler.current().get(id)?.state === 'closed'));
  assert.deepEqual(sampler.current().get('j2'), { state: 'ok', lines: ['worker 2'] });
  sampler.stop();
  assert.equal(sampler.current().size, 0);

  const slow = new ScreenSampler({ HERDR_SOCKET_PATH: socket }, () => {}, 60000);
  t.after(() => slow.stop());
  slow.watch(targets.slice(2, 3));
  slow.start();
  await until('the first screen', () => slow.current().size === 1);
  const once = fork.requests.length;
  for (let i = 0; i < 5; i++) { slow.stop(); slow.start(); }
  await pause(300);
  assert.equal(fork.requests.length, once);
});

test('a thumbnail keeps the last six lines that say something', () => {
  const screen = ['one', '', 'two\r', '──────', '|   |', 'three', 'four', '\tfive', 'six   ', 'seven', '╰────╯', '   '].join('\n');
  assert.deepEqual(thumbnailLines(screen), ['two', 'three', 'four', '    five', 'six', 'seven']);
});

test('Enter opens the job’s Inspector and Esc returns; g and H reveal and hide that job’s own tab only', async (t) => {
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
  const act = async (state, bytes, name, run) => {
    const { action } = press(state, bytes);
    assert.deepEqual(action, { type: bytes === 'g' ? 'focus-job-tab' : 'hide-job-tab', dir: f.dir(name) });
    const before = tabCalls().length;
    assert.deepEqual(await run(action.dir, f.env), { ok: true });
    return tabCalls().slice(before);
  };

  let state = render(view).state;
  assert.match(text(render(view, { state })), /Esc back {2}g job tab {2}H hide tab {2}⏎ details/);
  assert.deepEqual(await act(state, 'g', 'reviewer', focusJobTab), [['tab.get', 'w4E:t4'], ['tab.focus', 'w4E:t4']]);
  assert.equal(f.fork.panes.get('w4E:p4').hidden, false);
  assert.deepEqual(await act(state, 'H', 'reviewer', hideJobTab), [['tab.get', 'w4E:t4'], ['tab.set_hidden', 'w4E:t4', true]]);
  assert.equal(f.fork.panes.get('w4E:p4').hidden, true);

  state = press(state, 'j').state;
  assert.equal(state.project.nav.cursor, cards('imp')[0]);
  assert.deepEqual(await act(state, 'g', 'imp', focusJobTab), [['tab.get', 'w4E:t3'], ['tab.focus', 'w4E:t3']]);
  assert.equal(f.fork.panes.get('w4E:p3').hidden, false);
  assert.equal(f.fork.panes.get('w4E:p4').hidden, true, 'no other job’s tab moved');

  // Enter: that job's Inspector, with the same two actions, then back to the same card.
  const inspector = press(state, '\r').state;
  assert.deepEqual([inspector.subpage.kind, inspector.subpage.from, inspector.subpage.target.workerId], ['inspector', 'execution', `thin-job:${IDS.imp}`]);
  assert.match(text(render(view, { state: inspector, workboard: execution.board() })), /EXEC-01|synthetic page/);
  assert.deepEqual(press(inspector, 'g').action, { type: 'focus-job-tab', dir: f.dir('imp') });
  const back = press(inspector, '\x1b').state;
  assert.equal(back.subpage, undefined);
  assert.equal(back.project.view.kind, 'execution');
  assert.equal(back.project.nav.cursor, cards('imp')[0]);

  // A headless or queued job has no tab: the keys do nothing and the footer does not offer them.
  for (const name of ['sonic', 'queued']) {
    const on = onExecution({ cursor: cards(name)[0] });
    assert.doesNotMatch(text(render(view, { state: on })), /job tab|hide tab/);
    assert.equal(press(on, 'g').action, undefined);
    assert.equal(press(on, 'H').action, undefined);
  }
  // A tree row stands for its job.
  assert.deepEqual(press(onExecution({ cursor: `project:exec-tree:${IDS.reviewer}` }), 'g').action, { type: 'focus-job-tab', dir: f.dir('reviewer') });
  // Elsewhere in the panel the letters stay inert.
  assert.equal(acceptsMonitorInput(initialMonitorState(), { type: 'key', text: 'H' }), false);
});

test('the live panel reads screens only with the page up, and its keys reach the fork', { timeout: 60000 }, async (t) => {
  const f = await setup(t), home = join(f.root, 'home'), bin = join(f.root, 'bin'), settings = join(f.root, 'settings.json');
  for (const dir of [home, bin]) fs.mkdirSync(dir);
  fs.writeFileSync(settings, JSON.stringify({ modelEnabled: false }));
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
  const reads = () => f.fork.calls('pane.read').length;
  /** No further read in a window longer than the sampling interval. */
  const quiet = async (why) => {
    await pause(300);
    const before = reads();
    await pause(2300);
    assert.equal(reads(), before, why);
  };

  await until('the first screen on the page', () => stripAnsi(stdout).includes('Reading three files'));
  child.stdin.write('g');
  await until('the tab to come forward', () => f.fork.calls('tab.focus').length === 1);
  child.stdin.write('H');
  await until('the tab to hide', () => f.fork.calls('tab.set_hidden').length === 1);
  assert.deepEqual([...f.fork.calls('tab.focus', 'tab.set_hidden')].map((r) => r.params), [{ tab_id: 'w4E:t4' }, { tab_id: 'w4E:t4', hidden: true }]);

  child.stdin.write('\r');
  await quiet('no screens are read under an Inspector');
  let before = reads();
  child.stdin.write('\x1b');
  await until('sampling back on the page', () => reads() > before);
  await pause(100);
  child.stdin.write('\x1b');
  await quiet('no screens are read once the page is closed');
  assert.equal(stderr, '');
});
