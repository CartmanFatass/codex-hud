/** Resident project strip: 7 synthetic projects at 40/62 cols (EN/ZH, no-colour & mocha), folding, clicks, +N, and 5 s cadence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { projectFixture, NOW, TREE, plain, onPage, onControl } from '../fixtures/project-page.mjs';
import { listFixture } from '../fixtures/project-list.mjs';
import { withState } from '../fixtures/state-helpers.mjs';
import { handleMonitorInput, initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { PROJECT_STRIP_MORE, projectStripRow } from '../../dist/render/project-strip.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi, theme, visualLength } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { encodePanelPlace } from '../../dist/utils/panel-reload.js';

const EMPTY_COUNTS = { working: 0, blocked: 0, try: 0, todo: 0, accepted: 0, dropped: 0 };
const makeProject = (name, { waiting = 0, running = 0 } = {}) => ({
  root: `/synthetic/${name}`,
  name,
  overview: { hasState: true, waiting, running, counts: EMPTY_COUNTS, open: 0, at: NOW - 60_000 },
});

// Seven synthetic projects matching the design scenario (orchard own project first, never re-sorted).
const SEVEN = [
  makeProject('orchard', { running: 2 }),
  makeProject('tide-lab', { waiting: 1, running: 1 }), // `?` takes precedence over `●`
  makeProject('quill'),
  makeProject('kiln', { running: 1 }),
  makeProject('lantern'),
  makeProject('sketchbook'),
  makeProject('paperboat'),
];

const EMPTY_EXEC = { root: SEVEN[0].root, jobs: [], sessions: [], complete: true, screens: new Map() };
const decoder = new WorkbenchInputDecoder('workboard');
const keyOf = (raw) => decoder.push(Buffer.from(raw))[0];

function paintStrip(projects, selectedProject, width, { theme: th = 'none', icons = 'unicode' } = {}) {
  const prev = setDisplayConfig({ theme: th, icons });
  try {
    const row = projectStripRow(projects, selectedProject, width);
    return { ...row, line: row.paint(false), focused: row.paint(true) };
  } finally {
    setDisplayConfig(prev);
  }
}

test('resident project strip: 7 synthetic projects at 40 and 62 columns, EN/ZH, no-colour & mocha, on Project and Execution only', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'project-strip-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await projectFixture(root);
  const execState = withState(initialMonitorState(), { activeTab: 'execution' });

  for (const tab of ['project', 'execution']) {
    for (const width of [40, 62]) {
      for (const lang of ['en', 'zh']) {
        const state = tab === 'project' ? onPage() : execState;
        const frame = f.render(width, lang, state, 24, f.data, true, 'unicode', 'none', {
          projects: SEVEN,
          projectName: SEVEN[0].name,
          execution: EMPTY_EXEC,
          executionCount: 2,
        });
        for (const line of frame.lines) {
          assert.equal(visualLength(line), width, `${tab} ${width} ${lang}: ${line}`);
          assert.equal(line, stripAnsi(line), 'no-colour emits zero ANSI');
        }
        const stripLine = frame.lines[1];
        if (width === 62) {
          assert.equal(stripLine, ' ● orchard  ? tide-lab  quill  ● kiln  lantern  +2 ───────────');
        } else {
          assert.equal(stripLine, ' ● orchard  ? tide-lab  ● kiln  +4 ─────');
        }
        assert.doesNotMatch(plain(frame).join('\n'), /▾ (project|项目) \d+\/\d+/, 'folded picker header is gone');

        // Mocha theme paints current on title surface, marks in attention/active, idle muted, rule in frame.
        const coloured = f.render(width, lang, state, 24, f.data, true, 'unicode', 'mocha', {
          projects: SEVEN,
          projectName: SEVEN[0].name,
          execution: EMPTY_EXEC,
          executionCount: 2,
        });
        for (const line of coloured.lines) assert.equal(visualLength(line), width, `mocha ${tab} ${width} ${lang}`);
        const prev = setDisplayConfig({ theme: 'mocha', icons: 'unicode' });
        try {
          const direct = projectStripRow(SEVEN, undefined, width).paint(false);
          assert.ok(direct.includes(theme.board.title(` ${theme.board.active('●')} orchard `)), 'current on title surface');
          assert.ok(coloured.lines[1].includes('\x1b[48;2;49;50;68;38;2;205;214;244m orchard '), 'framed current keeps title surface');
          assert.ok(coloured.lines[1].includes(theme.board.attention('?')), '? in attention ink');
          assert.ok(coloured.lines[1].includes(theme.board.active('●')), '● in active ink');
          if (width === 62) assert.ok(coloured.lines[1].includes(theme.board.muted('quill')), 'idle project muted');
          assert.ok(coloured.lines[1].includes(theme.board.frame('─'.repeat(width === 62 ? 11 : 5))), 'trailing rule in frame ink');
        } finally {
          setDisplayConfig(prev);
        }
      }
    }
  }

  // Strip is NOT shown on Home, Control, Project sub-pages, Help, or with a single project.
  const absentCases = [
    ['home', initialMonitorState()],
    ['control', onControl()],
    ['project-progress', onPage('progress')],
    ['help', withState(onPage(), { help: {} })],
  ];
  for (const [label, state] of absentCases) {
    const frame = f.render(62, 'en', state, 24, f.data, true, 'unicode', 'none', { projects: SEVEN, projectName: 'orchard' });
    assert.equal(frame.controls.some((c) => c.kind.startsWith('project-strip-')), false, `${label} has no strip`);
  }
  const single = f.render(62, 'en', onPage(), 24, f.data, true, 'unicode', 'none', { projects: SEVEN.slice(0, 1), projectName: 'orchard' });
  assert.equal(single.controls.some((c) => c.kind.startsWith('project-strip-')), false, 'single project has no strip');
});

test('folding order: idle from end -> names shorten to 8 cells -> marked fold with strongest mark on +N; current always stays', () => {
  // 1. Folded idle becomes current: paperboat stays visible, earlier idle sketchbook folds into +1.
  const s3 = paintStrip(SEVEN, SEVEN[6].root, 62);
  assert.equal(s3.line, ' ● orchard  ? tide-lab  quill  ● kiln  lantern  paperboat  +1 ');
  assert.equal(visualLength(s3.line), 62);

  // 2. Quiet scenario at 62 and 40 (no request on tide-lab): exact match to ov-quiet-62 and ov-quiet-40.
  const quietSeven = SEVEN.map((p, i) => (i === 1 ? makeProject('tide-lab') : p));
  assert.equal(paintStrip(quietSeven, undefined, 62).line, ' ● orchard  tide-lab  quill  ● kiln  lantern  sketchbook  +1  ');
  assert.equal(paintStrip(quietSeven, undefined, 40).line, ' ● orchard  tide-lab  quill  ● kiln  +3 ');

  // 3. Stage 2: after all non-current idle projects fold, names shorten to 8 cells before marked projects fold.
  const longMarked = [
    makeProject('orchard', { running: 1 }),
    makeProject('very-long-active-project', { waiting: 1 }),
    makeProject('kiln', { running: 1 }),
    makeProject('idle-tail'),
  ];
  const stage2 = paintStrip(longMarked, undefined, 40);
  assert.equal(visualLength(stage2.line), 40);
  assert.equal(stage2.line, ' ● orchard  ? very-lo…  ● kiln  +1 ─────');

  // 4. Stage 3: 6 marked projects at 40 cols -> marked fold from end, +N carries strongest mark (●+4, and ?+4 when a folded one asks).
  const sixLive = [
    makeProject('orchard', { running: 1 }),
    makeProject('tide-lab', { waiting: 1 }),
    makeProject('quill', { running: 1 }),
    makeProject('kiln', { running: 1 }),
    makeProject('lantern', { running: 1 }),
    makeProject('sketchbook', { running: 1 }),
    makeProject('paperboat'),
  ];
  assert.equal(paintStrip(sixLive, undefined, 40).line, ' ● orchard  ? tide-lab  ● quill  ●+4 ───');

  const foldedAsk = sixLive.map((p, i) => (i === 5 ? makeProject('sketchbook', { waiting: 1 }) : p));
  assert.equal(paintStrip(foldedAsk, undefined, 40).line, ' ● orchard  ? tide-lab  ● quill  ?+4 ───');

  // 5. All projects fit: no +N chip, rule fills rest.
  const two = SEVEN.slice(0, 2);
  const fits = paintStrip(two, undefined, 40);
  assert.equal(fits.hasMore, false);
  assert.equal(fits.line, ' ● orchard  ? tide-lab ─────────────────');

  // 6. Text and Nerd icon sets + CJK names keep exact width.
  assert.equal(paintStrip(sixLive, undefined, 40, { icons: 'text' }).line, ' * orchard  ? tide-lab  * quill  *+4 ---');
  const cjk = [makeProject('中文项目名称测试', { running: 1 }), makeProject('第二个长中文项目名', { waiting: 1 }), makeProject('三号项目')];
  const cjkStrip = paintStrip(cjk, undefined, 40);
  assert.equal(visualLength(cjkStrip.line), 40);
  assert.match(cjkStrip.line, /中文项…/);
});

test('click switches project, +N (click or Enter) opens Projects list from Project and Execution, and [ ] stay unchanged', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'project-strip-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await projectFixture(root);

  const draw = (state, width = 40) => f.render(width, 'en', state, 24, f.data, true, 'unicode', 'none', {
    projects: SEVEN,
    projectName: (SEVEN.find((p) => p.root === state.selectedProject) ?? SEVEN[0]).name,
    execution: EMPTY_EXEC,
    executionCount: 2,
  });
  const send = (frame, input) => handleMonitorInput(frame.state, typeof input === 'string' ? keyOf(input) : input, { tree: TREE, frame, nowMs: NOW });

  // On Project: click a visible name (`kiln`) switches directly; click own project (`orchard`) sets selectedProject undefined.
  let frame = draw(onPage());
  const kilnBtn = frame.controls.find((c) => c.kind === 'project-strip-pick' && c.item === SEVEN[3].root);
  assert.ok(kilnBtn && kilnBtn.y === 1);
  frame = draw(send(frame, { type: 'mouse', button: 'left', x: kilnBtn.x, y: kilnBtn.y }).state);
  assert.equal(frame.state.selectedProject, SEVEN[3].root);
  assert.equal(frame.state.activeTab, 'project');

  const ownBtn = frame.controls.find((c) => c.kind === 'project-strip-pick' && c.item === SEVEN[0].root);
  frame = draw(send(frame, { type: 'mouse', button: 'left', x: ownBtn.x, y: ownBtn.y }).state);
  assert.equal(frame.state.selectedProject, undefined);

  // Up from first body row focuses +N; Enter opens Projects list; Down returns to body.
  frame = draw(send(frame, '\x1b[A').state); // Up
  assert.equal(frame.state.project.nav.cursor, PROJECT_STRIP_MORE);
  const backDown = draw(send(frame, '\x1b[B').state); // Down
  assert.notEqual(backDown.state.project.nav.cursor, PROJECT_STRIP_MORE);

  let listed = draw(send(frame, '\r').state);
  assert.equal(listed.state.project.view.kind, 'projects-list');
  assert.match(plain(listed)[0], /^‹ Projects/);
  // Esc closes Projects list back to Project hub.
  frame = draw(send(listed, { type: 'key', key: 'escape' }).state);
  assert.equal(frame.state.project.view.kind, 'hub');
  assert.equal(frame.state.activeTab, 'project');

  // On Execution: click a project switches while staying on Execution; click +N opens Projects list and picking/Esc returns to Execution.
  let exec = draw(withState(initialMonitorState(), { activeTab: 'execution' }));
  const tideBtn = exec.controls.find((c) => c.kind === 'project-strip-pick' && c.item === SEVEN[1].root);
  exec = draw(send(exec, { type: 'mouse', button: 'left', x: tideBtn.x, y: tideBtn.y }).state);
  assert.equal(exec.state.activeTab, 'execution');
  assert.equal(exec.state.selectedProject, SEVEN[1].root);

  const moreBtn = exec.controls.find((c) => c.kind === 'project-strip-more');
  assert.ok(moreBtn);
  listed = draw(send(exec, { type: 'mouse', button: 'left', x: moreBtn.x, y: moreBtn.y }).state);
  assert.equal(listed.state.project.view.kind, 'projects-list');
  assert.equal(listed.state.project.view.from, 'execution');
  // Esc returns to Execution with same project.
  exec = draw(send(listed, { type: 'key', key: 'escape' }).state);
  assert.equal(exec.state.activeTab, 'execution');
  assert.equal(exec.state.selectedProject, SEVEN[1].root);

  // Reopen via Enter on +N on Execution (empty Execution starts cursor on +N when no body items exist), then pick paperboat.
  assert.equal(exec.state.execution.cursor, PROJECT_STRIP_MORE);
  listed = draw(send(exec, '\r').state);
  assert.equal(listed.state.project.view.kind, 'projects-list');
  const paperRow = listed.workboard.rows.findIndex((r) => r.item === `project:list:${SEVEN[6].root}`);
  assert.ok(paperRow >= 0);
  exec = draw(send(listed, { type: 'mouse', button: 'left', x: 3, y: paperRow + 1 }).state);
  assert.equal(exec.state.activeTab, 'execution');
  assert.equal(exec.state.selectedProject, SEVEN[6].root);

  // [ ] still cycle in registry order on Execution and Project.
  exec = draw(send(exec, ']').state);
  assert.equal(exec.state.selectedProject, undefined, 'wrapping from last project back to own');
  exec = draw(send(exec, '[').state);
  assert.equal(exec.state.selectedProject, SEVEN[6].root);
});

test('live panel keeps strip marks fresh at the 5 s cadence across tabs without extra reads while Help is open', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'project-strip-cadence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const l = await listFixture(root);
  const own = fs.realpathSync(l.cwd), others = l.projects.slice(1).map((p) => p.root);
  const clockFile = join(root, 'clock-offset.txt');
  fs.writeFileSync(clockFile, '0');
  l.put(join(l.hud, 'projects.json'), { version: 1, projects: others.map((r) => ({ root: r, registered_at: '2026-11-13T00:00:00.000Z' })) });
  l.put(join(l.hud, 'hud-settings.json'), { modelEnabled: false, refreshMs: 100, language: 'en', acceptance: 'slice' });

  const runner = join(root, 'cadence-runner.mjs');
  fs.writeFileSync(runner, `
import * as fs from 'node:fs';
const realNow = Date.now;
Date.now = () => realNow() + (Number(fs.readFileSync(${JSON.stringify(clockFile)}, 'utf8').trim()) || 0);
const { ProjectCollector } = await import(${JSON.stringify(pathToFileURL(resolve('dist/collectors/project-board.js')).href)});
const { runLivePage } = await import(${JSON.stringify(pathToFileURL(resolve('dist/tree-page.js')).href)});
const real = ProjectCollector.prototype.collect;
ProjectCollector.prototype.collect = function (shown, ...rest) {
  process.stderr.write('COLLECT ' + JSON.stringify({ cwd: this.cwd, shown }) + '\\n');
  return real.call(this, shown, ...rest);
};
await runLivePage();
`);

  const place = encodePanelPlace({ state: onPage(), settings: null });
  const child = spawn(process.execPath, [runner], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...l.env, CODEX_HUD_STANDALONE_PANEL: '1', CODEX_HUD_PANEL_ALL_DELEGATIONS: '1', CODEX_HUD_CWD: l.cwd, HUD_PANEL_RELOAD_PLACE: place },
  });
  let log = '', stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (b) => { stderr += b; log += b; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });

  const collects = () => log.split('\n').filter((x) => x.startsWith('COLLECT ')).map((x) => JSON.parse(x.slice(8)));
  const overviewCount = () => collects().filter((c) => c.shown === 'overview' && c.cwd === others[0]).length;
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (ok, what) => {
    for (const end = Date.now() + 15000; Date.now() < end; await pause(25)) if (ok()) return;
    assert.fail(`${what}: ${stderr}`);
  };
  let offset = 0;
  const advance = (ms) => { offset += ms; fs.writeFileSync(clockFile, String(offset)); };

  // 1. Project hub reads initial overviews once, then holds steady inside 5 s.
  await until(() => overviewCount() >= 1 && collects().some((c) => c.cwd === own && c.shown === true), 'initial Project overview + full');
  await pause(400);
  const afterStart = overviewCount();
  assert.equal(afterStart, 1, 'no extra overview read inside 5 s on Project');

  // 2. Switch to Execution tab, open Help (hidden behind modal), advance 6 s: zero overview reads while hidden.
  child.stdin.write('\x1b[C'); // → Execution
  await pause(200);
  child.stdin.write('?'); // Help modal hides the panel tabs/strip
  await pause(200);
  const whileHidden = overviewCount();
  advance(6000);
  await pause(400);
  assert.equal(overviewCount(), whileHidden, 'no overview reads while Help hides the strip');

  // 3. Close Help -> Execution is visible again and 5 s elapsed, so overviews refresh immediately.
  child.stdin.write('\x1b');
  await until(() => overviewCount() > whileHidden, 'overview refreshes on Execution once Help closes');
  const afterExec = overviewCount();

  // 4. Switch to Control tab and advance 6 s -> overviews refresh at 5 s cadence on Control too.
  child.stdin.write('\x1b[C'); // → Control
  await pause(200);
  advance(6000);
  await until(() => overviewCount() > afterExec, 'overview refreshes on Control at 5 s cadence');
});
