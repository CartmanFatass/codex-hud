/** Scoped pinned owner-request area: tab scoping, 24-cell inline/2-row layout, ordering, folding, Up navigation, ?N badges, and hud_objective round-trip. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { HomePortfolioCollector } from '../../dist/collectors/home-portfolio.js';
import { overviewOf } from '../../dist/collectors/project-visits.js';
import { editObjectives } from '../../dist/mcp/local-objectives.js';
import { projectList } from '../../dist/roles/projects.js';
import { handleMonitorInput, initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { HOME_REQUEST_MORE, PROJECT_REQUEST_MORE, requestAreaRows } from '../../dist/render/request-area.js';
import { projectPageOf } from '../../dist/render/project-view.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi, theme, visualLength } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { onControl, onPage, plain } from '../fixtures/project-page.mjs';
import { withState } from '../fixtures/state-helpers.mjs';

const NOW = Date.parse('2026-11-26T12:00:00Z');
const BOARD = { revision: 'synthetic', lanes: [], workers: [], decisions: [], coverage: { incomplete: false, diagnostics: [], workspace: null } };
const decoder = new WorkbenchInputDecoder('workboard');
const keyOf = (raw) => decoder.push(Buffer.from(raw))[0];

function drawWith(input, { lang = 'en', theme: th = 'none', icons = 'unicode' } = {}) {
  const prevLang = setLanguage(lang);
  const prevDisp = setDisplayConfig({ theme: th, icons });
  try {
    return renderMonitor({ nowMs: NOW, workboard: BOARD, ...input });
  } finally {
    setLanguage(prevLang);
    setDisplayConfig(prevDisp);
  }
}

function assertExactFrame(frame, width, noColour = false) {
  for (const line of frame.lines) {
    assert.equal(visualLength(line), width, `width ${width}: ${stripAnsi(line)}`);
    if (noColour) assert.equal(line, stripAnsi(line), 'no-colour emits zero ANSI');
  }
}

test('request row shape: inline when >= 24 cells remain, second row cut to one row when < 24, flag drops before name < 8, age stays', () => {
  const req = {
    root: '/synthetic/tide-lab',
    projectName: 'tide-lab',
    index: 0,
    item: {
      label: '',
      value: '合并冲突以服务端为准？',
      sentence: '合并冲突以服务端为准？',
      request: 'r1',
      objective: 'offline-sync',
      waitedOn: true,
      at: NOW - 3 * 3600_000,
      path: '/synthetic/tide-lab/docs/handoff/STATE.md',
    },
  };

  for (const lang of ['zh', 'en']) {
    const prevLang = setLanguage(lang);
    const prevDisp = setDisplayConfig({ theme: 'none', icons: 'unicode' });
    try {
      // 62 columns ZH on Home: exactly 24 cells remain -> one row matching tab-roles/README.md §4.
      if (lang === 'zh') {
        const home62 = requestAreaRows([req], { showProject: true, width: 62, now: NOW, expanded: false });
        assert.equal(home62.length, 1);
        assert.equal(home62[0].text, '? tide-lab › offline-sync  合并冲突以服务端为准？   在等你 3时');
        assert.equal(visualLength(home62[0].text), 62);
      }

      // 62 columns on Project (no project name): >= 24 cells remain in both EN and ZH -> one row without project name.
      const proj62 = requestAreaRows([req], { showProject: false, width: 62, now: NOW, expanded: false });
      assert.equal(proj62.length, 1);
      assert.equal(visualLength(proj62[0].text), 62);
      assert.doesNotMatch(proj62[0].text, /tide-lab/);
      assert.match(proj62[0].text, lang === 'zh'
        ? /^\? offline-sync  合并冲突以服务端为准？ +在等你 3时$/
        : /^\? offline-sync  合并冲突以服务端为准？ +work waits 3h$/);

      // 40 columns on Home and Project: < 24 cells remain -> second row cut to one row, still shows what is asked.
      for (const showProject of [true, false]) {
        const rows40 = requestAreaRows([req], { showProject, width: 40, now: NOW, expanded: false });
        assert.equal(rows40.length, 2);
        for (const r of rows40) assert.equal(visualLength(r.text), 40);
        assert.equal(rows40[0].item, rows40[1].item);
        assert.equal(rows40[0].text.includes('tide-lab'), showProject);
        assert.match(rows40[1].text, /^  合并冲突以服务端为准？/);
      }

      // Narrow width: work waits flag drops before cutting a name below 8 cells; age always stays.
      const longReq = {
        ...req,
        projectName: 'long-project-alpha',
        item: { ...req.item, objective: 'long-objective-beta', sentence: 'Choose the conflict policy now' },
      };
      const narrow = requestAreaRows([longReq], { showProject: true, width: 30, now: NOW, expanded: false });
      assert.equal(narrow.length, 2);
      assert.equal(visualLength(narrow[0].text), 30);
      assert.doesNotMatch(narrow[0].text, lang === 'zh' ? /在等你/ : /work waits/);
      assert.match(narrow[0].text, lang === 'zh' ? /3时$/ : /3h$/);
      assert.match(narrow[1].text, /^  Choose the conflict/);
    } finally {
      setLanguage(prevLang);
      setDisplayConfig(prevDisp);
    }
  }

  // Mocha theme paints ? and work waits in attention, age in muted, and keeps exact width.
  const prevDisp = setDisplayConfig({ theme: 'mocha', icons: 'unicode' });
  const prevLang = setLanguage('zh');
  try {
    const coloured = requestAreaRows([req], { showProject: true, width: 62, now: NOW, expanded: false });
    assert.equal(visualLength(coloured[0].text), 62);
    assert.ok(coloured[0].text.includes(theme.board.attention('?')));
    assert.ok(coloured[0].text.includes(theme.board.attention('在等你')));
    assert.ok(coloured[0].text.includes(theme.board.muted('3时')));
  } finally {
    setDisplayConfig(prevDisp);
    setLanguage(prevLang);
  }
});

test('per-tab scoping, ?N badges, empty zero-row behavior, and hud_objective request/resolve round-trip', async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-req-scope-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hud = join(dir, 'hud');
  const orchard = join(dir, 'orchard');
  const tide = join(dir, 'tide-lab');
  const put = (file, body) => {
    fs.mkdirSync(join(file, '..'), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  };
  put(join(orchard, '.hud/objectives.md'), '**Stance:** active · **Priority:** high\n\n## ingest: Nightly batch import without restarts\n**State:** active\n');
  put(join(tide, '.hud/objectives.md'), '**Stance:** active · **Priority:** normal\n\n## offline-sync: Conflict resolution after reconnect\n**State:** active\n');
  put(join(hud, 'projects.json'), { version: 1, projects: [{ root: orchard }, { root: tide }] });

  const collectAll = async () => {
    const listed = projectList(hud, orchard);
    const portfolio = await new HomePortfolioCollector(hud).read(listed, BOARD, NOW);
    const snapOrchard = await new ProjectCollector(orchard, hud).collect(true, BOARD, NOW);
    const snapTide = await new ProjectCollector(tide, hud).collect(true, BOARD, NOW);
    const choices = listed.map((p) => {
      const snap = p.root === orchard ? snapOrchard : snapTide;
      return { root: p.root, name: p.name, overview: overviewOf(snap, 0) };
    });
    return { portfolio, snapOrchard, snapTide, choices };
  };

  // 1. With NO open requests: Project starts with Objectives right under the strip; zero request rows everywhere.
  const empty = await collectAll();
  for (const width of [40, 62]) for (const lang of ['en', 'zh']) {
    const proj = drawWith({
      state: onPage(), width, height: 24,
      homePortfolio: empty.portfolio, project: empty.snapOrchard, projectDisplayRoot: orchard,
      projectName: 'orchard', projects: empty.choices,
    }, { lang, theme: 'none' });
    assertExactFrame(proj, width, true);
    assert.equal(proj.workboard.requests, undefined, 'no request rows when empty');
    const lines = plain(proj);
    assert.doesNotMatch(lines.join('\n'), /Needs you|需要你处理|Nothing needs you|没有需要你处理/);
    // Line 0 = tabs (no ? badge), line 1 = strip (no ? mark), line 2 = identity, line 3 = Objectives.
    assert.doesNotMatch(lines[0], /\?\d/);
    assert.doesNotMatch(lines[1], /\?/);
    assert.match(lines[3], lang === 'zh' ? /^目标 ─/ : /^Objectives ─/);

    const home = drawWith({
      state: initialMonitorState(), width, height: 24,
      homePortfolio: empty.portfolio, project: empty.snapOrchard, projectDisplayRoot: orchard,
      projectName: 'orchard', projects: empty.choices,
    }, { lang, theme: 'none' });
    assertExactFrame(home, width, true);
    assert.equal(home.workboard.requests, undefined);
    assert.doesNotMatch(plain(home).join('\n'), /^(?:Waiting|等你处理) ─/m);
  }

  // 2. Add a synthetic request to tide-lab via hud_objective op: "request".
  const opened = await editObjectives(tide, hud, {
    op: 'request', objective: 'offline-sync', waits: true, text: 'Prefer server copy on reconnect conflict?',
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.request, 'r1');

  const withReq = await collectAll();
  const emptyExec = { root: tide, jobs: [], sessions: [], complete: true, screens: new Map() };
  for (const width of [40, 62]) for (const lang of ['en', 'zh']) {
    const zh = lang === 'zh';
    const base = { width, height: 24, homePortfolio: withReq.portfolio, projects: withReq.choices, execution: emptyExec };

    // Home: shows tide-lab's request with `tide-lab › offline-sync`; Home ?1, Project (orchard selected) has no badge.
    const home = drawWith({ ...base, state: initialMonitorState(), project: withReq.snapOrchard, projectDisplayRoot: orchard, projectName: 'orchard' }, { lang, theme: 'none' });
    assertExactFrame(home, width, true);
    assert.ok(home.workboard.requests?.length >= 1);
    const homeLines = plain(home);
    assert.match(homeLines[0], zh ? /首页 \?1 +项目 +执行 +控制/ : /Home \?1 +Project +Execution +Control/);
    assert.match(homeLines[1], /^\? tide-lab › offline-sync/);
    assert.match(homeLines.slice(1, 3).join('\n'), /Prefer server copy/);

    // Project tab on orchard (other project): ZERO request rows, strip shows `? tide-lab`, Home ?1, Project has no badge.
    const projOrchard = drawWith({ ...base, state: onPage(), project: withReq.snapOrchard, projectDisplayRoot: orchard, projectName: 'orchard' }, { lang, theme: 'none' });
    assertExactFrame(projOrchard, width, true);
    assert.equal(projOrchard.workboard.requests, undefined, 'orchard Project tab does not show tide-lab request');
    assert.match(plain(projOrchard)[0], zh ? /首页 \?1 +项目 +执行 +控制/ : /Home \?1 +Project +Execution +Control/);
    assert.match(plain(projOrchard)[1], /\? tide-lab/);
    assert.doesNotMatch(plain(projOrchard).join('\n'), /Prefer server copy/);

    // Project tab on tide-lab: shows tide-lab's request WITHOUT project name; strip shows `? tide-lab`; badges Home ?1, Project ?1.
    const tideState = onPage(undefined, { selectedProject: tide });
    const projTide = drawWith({ ...base, state: tideState, project: withReq.snapTide, projectDisplayRoot: tide, projectName: 'tide-lab' }, { lang, theme: 'none' });
    assertExactFrame(projTide, width, true);
    assert.ok(projTide.workboard.requests?.length >= 1);
    const tideLines = plain(projTide);
    if (width === 62 || zh) {
      assert.match(tideLines[0], zh ? /首页 \?1 +项目 \?1/ : /Home \?1 +Project \?1/);
    } else {
      assert.match(tideLines[0], /Project \?1/);
    }
    assert.match(tideLines[1], /\? tide-lab/);
    assert.match(tideLines[2], /^\? offline-sync/);
    assert.doesNotMatch(tideLines[2], /tide-lab/);
    assert.match(tideLines.slice(2, 4).join('\n'), /Prefer server copy/);

    // Objective sub-page for tide-lab's offline-sync: shows tide-lab's request without project name.
    const objState = withState(tideState, {
      subpage: { kind: 'objective', scroll: 0, target: { root: tide, objective: withReq.snapTide.objectives.objectives[0], blocked: true } },
    });
    const objFrame = drawWith({ ...base, state: objState, project: withReq.snapTide, projectDisplayRoot: tide, projectName: 'tide-lab' }, { lang, theme: 'none' });
    assertExactFrame(objFrame, width, true);
    assert.ok(objFrame.workboard.requests?.length >= 1);
    assert.match(plain(objFrame)[1], /^\? offline-sync/);
    assert.doesNotMatch(plain(objFrame)[1], /tide-lab/);

    // Execution and Control on tide-lab: ZERO request rows; ?N badges still count per tab.
    for (const tabState of [
      withState(initialMonitorState(), { activeTab: 'execution', selectedProject: tide }),
      onControl({}, { selectedProject: tide }),
    ]) {
      const frame = drawWith({ ...base, state: tabState, project: withReq.snapTide, projectDisplayRoot: tide, projectName: 'tide-lab' }, { lang, theme: 'none' });
      assertExactFrame(frame, width, tabState.activeTab !== 'control');
      assert.equal(frame.workboard.requests, undefined, `${tabState.activeTab} shows no request rows`);
      assert.doesNotMatch(plain(frame).join('\n'), /Prefer server copy/);
    }
  }

  // 3. Resolve the request via hud_objective op: "resolve" -> every request row, strip `?` and `?N` badge disappear.
  const resolved = await editObjectives(tide, hud, { op: 'resolve', request: 'r1' });
  assert.equal(resolved.ok, true);
  const after = await collectAll();
  for (const state of [initialMonitorState(), onPage(undefined, { selectedProject: tide })]) {
    const frame = drawWith({
      state, width: 62, height: 24, homePortfolio: after.portfolio,
      project: after.snapTide, projectDisplayRoot: tide, projectName: 'tide-lab', projects: after.choices,
    }, { lang: 'zh', theme: 'none' });
    assert.equal(frame.workboard.requests, undefined);
    assert.doesNotMatch(plain(frame)[0], /\?\d/);
    assert.doesNotMatch(plain(frame).join('\n'), /Prefer server copy/);
  }
});

test('spec ordering, four-request cap with 另 N 个请求 expand/fold, Up from first body row, Enter and o', async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-req-nav-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hud = join(dir, 'hud'), alpha = join(dir, 'alpha'), beta = join(dir, 'beta');
  const put = (file, body) => {
    fs.mkdirSync(join(file, '..'), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  };
  put(join(alpha, '.hud/objectives.md'), '**Stance:** active · **Priority:** high\n\n## core: Core work\n**State:** active\n**Evidence:** docs/note.md\n');
  put(join(beta, '.hud/objectives.md'), '**Stance:** active · **Priority:** low\n\n## ui: UI work\n**State:** active\n');
  // 5 requests on alpha + 1 on beta = 6 total; test spec §2.2 ordering across projects and 4-row cap.
  put(join(alpha, 'docs/handoff/STATE.md'), [
    '## Waiting for the owner',
    '- 2026-11-24 [r1] Optional alpha newer (objective core)',
    '- 2026-11-25 [r2] Waited alpha newer (objective core) (work waits)',
    '- 2026-11-20 [r3] Waited alpha oldest (objective core) (work waits)',
    '- 2026-11-21 [r4] Optional alpha oldest (objective core)',
    '- 2026-11-22 [r5] Optional alpha middle (objective core)',
  ].join('\n') + '\n');
  put(join(beta, 'docs/handoff/STATE.md'), [
    '## Waiting for the owner',
    '- 2026-11-19 [r1] Waited beta low-priority (objective ui) (work waits)',
  ].join('\n') + '\n');
  put(join(hud, 'projects.json'), { version: 1, projects: [{ root: alpha }, { root: beta }] });

  const listed = projectList(hud, alpha);
  const portfolio = await new HomePortfolioCollector(hud).read(listed, BOARD, NOW);
  const snapAlpha = await new ProjectCollector(alpha, hud).collect(true, BOARD, NOW);
  const snapBeta = await new ProjectCollector(beta, hud).collect(true, BOARD, NOW);
  const choices = [
    { root: alpha, name: 'alpha', overview: overviewOf(snapAlpha, 0) },
    { root: beta, name: 'beta', overview: overviewOf(snapBeta, 0) },
  ];

  // Spec §2.2 order on Home: work waits (high priority oldest -> newer -> low priority), then non-waits (high oldest -> middle -> newer).
  assert.deepEqual(
    portfolio.requests.map((r) => `${r.project.name}:${r.item.request}`),
    ['alpha:r3', 'alpha:r2', 'beta:r1', 'alpha:r4', 'alpha:r5', 'alpha:r1'],
  );

  const send = (frame, raw) => handleMonitorInput(frame.state, typeof raw === 'string' ? keyOf(raw) : raw, { frame, nowMs: NOW });

  // Home: 4 requests then `另 2 个请求` (ZH) / `2 more requests` (EN); Enter expands and folds in place.
  for (const lang of ['zh', 'en']) {
    const drawHome = (state = initialMonitorState(), width = 62) => drawWith({
      state, width, height: 28, homePortfolio: portfolio, project: snapAlpha, projectDisplayRoot: alpha, projectName: 'alpha', projects: choices,
    }, { lang, theme: 'none' });
    let frame = drawHome();
    assertExactFrame(frame, 62, true);
    assert.equal(frame.workboard.requests.length, 5, '4 requests + 1 fold row');
    assert.match(plain(frame)[5], lang === 'zh' ? /▸ 另 2 个请求/ : /▸ 2 more requests/);
    assert.doesNotMatch(plain(frame).join('\n'), /Optional alpha newer/);

    // Move Down through 4 requests to fold row, then Down to first body row, then Up back to fold row (last request row).
    for (let i = 0; i < 4; i++) frame = drawHome(send(frame, '\x1b[B').state);
    assert.equal(frame.state.home.cursor, HOME_REQUEST_MORE);
    frame = drawHome(send(frame, '\x1b[B').state); // first body row (project header)
    assert.equal(frame.state.home.cursor, `home:project:${alpha}`);
    frame = drawHome(send(frame, '\x1b[A').state); // Up from first body row -> last request row!
    assert.equal(frame.state.home.cursor, HOME_REQUEST_MORE);

    // Enter on fold row expands in place to show all 6 requests + fewer/收起; Enter folds back.
    frame = drawHome(send(frame, '\r').state);
    assert.equal(frame.state.home.requestsExpanded, true);
    assert.equal(frame.workboard.requests.length, 7, '6 requests + fewer row');
    assert.match(plain(frame).join('\n'), /Optional alpha newer/);
    assert.match(plain(frame)[7], lang === 'zh' ? /▾ 收起/ : /▾ fewer/);
    frame = drawHome(send(frame, '\r').state);
    assert.equal(frame.state.home.requestsExpanded, false);
    assert.equal(frame.workboard.requests.length, 5);

    // Move to first request: `o` opens STATE.md; Enter opens Waiting page on that project.
    frame = drawHome(initialMonitorState());
    assert.deepEqual(send(frame, 'o').action, { type: 'open-files', files: [snapAlpha.statePath] });
    const opened = send(frame, '\r');
    assert.equal(opened.state.activeTab, 'project');
    assert.equal(projectPageOf(opened.state), 'waiting');
    assert.equal(opened.state.project.view.request, 'r3');
  }

  // Project hub: 5 requests on alpha -> 4 shown + `另 1 个请求`; Up from first body row reaches fold row; Enter expands; Enter on request opens Waiting page.
  const drawProj = (state = onPage(), lang = 'zh') => drawWith({
    state, width: 62, height: 28, homePortfolio: portfolio, project: snapAlpha, projectDisplayRoot: alpha, projectName: 'alpha', projects: choices,
  }, { lang, theme: 'none' });
  let proj = drawProj();
  assert.equal(proj.workboard.requests.length, 5);
  assert.match(plain(proj)[6], /▸ 另 1 个请求/);
  for (let i = 0; i < 4; i++) proj = drawProj(send(proj, '\x1b[B').state);
  assert.equal(proj.state.project.nav.cursor, PROJECT_REQUEST_MORE);
  proj = drawProj(send(proj, '\x1b[B').state); // first body row (Objective)
  assert.equal(proj.state.project.nav.cursor, `project:objective:${alpha}:core`);
  proj = drawProj(send(proj, '\x1b[A').state); // Up from first body row -> last request row!
  assert.equal(proj.state.project.nav.cursor, PROJECT_REQUEST_MORE);
  proj = drawProj(send(proj, '\r').state); // expand in place
  assert.equal(proj.workboard.requests.length, 6);
  assert.match(plain(proj).join('\n'), /Optional alpha newer/);

  // Objective sub-page: starts on first body row (evidence); Up reaches last request row; Enter on request opens Waiting page.
  const objState = withState(onPage(), {
    subpage: { kind: 'objective', scroll: 0, target: { root: alpha, objective: snapAlpha.objectives.objectives[0], blocked: true } },
  });
  let obj = drawProj(objState, 'en');
  assert.equal(obj.state.subpage.cursor, 'objective:evidence:0');
  obj = drawProj(send(obj, '\x1b[A').state, 'en'); // Up from first body row -> last request row (fold row)
  assert.equal(obj.state.subpage.cursor, PROJECT_REQUEST_MORE);
  obj = drawProj(send(obj, '\x1b[A').state, 'en'); // Up to 4th request
  assert.equal(obj.state.subpage.cursor, 'project:wait:3');
  assert.deepEqual(send(obj, 'o').action, { type: 'open-files', files: [snapAlpha.statePath] });
  const fromObj = send(obj, '\r');
  assert.equal(fromObj.state.subpage, undefined);
  assert.equal(fromObj.state.activeTab, 'project');
  assert.equal(projectPageOf(fromObj.state), 'waiting');
  assert.equal(fromObj.state.project.view.request, 'r5');
});

test('Objective and Feature opened via Execution -> Inspector expand/fold more requests without changing Home flag', async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-req-exec-subpage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hud = join(dir, 'hud'), alpha = join(dir, 'alpha');
  const put = (file, body) => {
    fs.mkdirSync(join(file, '..'), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  };
  put(join(alpha, '.hud/objectives.md'), '**Stance:** active · **Priority:** high\n\n## core: Core work\n**State:** active\n**Features:** nav-fix\n');
  put(join(alpha, '.scratch/nav-fix/issues/01-item.md'), '# 01: Fix navigation state\n**Status:** ready-for-agent\n**Blocked by:** none\n\n- [ ] Done\n');
  put(join(alpha, 'docs/handoff/STATE.md'), [
    '## Waiting for the owner',
    '- 2026-11-20 [r1] Request one (objective core) (work waits)',
    '- 2026-11-21 [r2] Request two (objective core)',
    '- 2026-11-22 [r3] Request three (objective core)',
    '- 2026-11-23 [r4] Request four (objective core)',
    '- 2026-11-24 [r5] Fifth alpha request (objective core)',
  ].join('\n') + '\n');
  put(join(hud, 'projects.json'), { version: 1, projects: [{ root: alpha }] });

  const snapAlpha = await new ProjectCollector(alpha, hud).collect(true, BOARD, NOW);
  const worker = {
    id: 'thin-job:j0000000000000901',
    laneId: 'thin-job:package:nav-fix',
    role: 'imp',
    state: 'working',
    displayId: 'j0000000',
    task: 'Fix navigation state',
    startedAt: NOW - 60_000,
    settledAt: null,
    homeNeedsHuman: false,
    projectRoot: alpha,
    objective: { id: 'core', title: 'Core work' },
  };
  const board = { ...BOARD, lanes: [{ id: worker.laneId, label: 'nav-fix', workers: [worker] }], workers: [worker] };
  const draw = (state) => drawWith({
    state, width: 62, height: 28, workboard: board,
    project: snapAlpha, projectDisplayRoot: alpha, projectName: 'alpha',
  }, { lang: 'en', theme: 'none' });
  const send = (frame, input) => handleMonitorInput(frame.state, typeof input === 'string' ? keyOf(input) : input, { frame, nowMs: NOW });

  // Open Objective via Execution -> Inspector -> Objective.
  const insp = draw(withState(initialMonitorState(), {
    activeTab: 'execution',
    subpage: {
      kind: 'inspector',
      target: { kind: 'worker', laneId: worker.laneId, workerId: worker.id },
      from: 'execution',
      cursor: 'inspector:objective',
      scroll: 0,
    },
  }));
  let obj = draw(send(insp, '\r').state);
  assert.equal(obj.state.activeTab, 'execution');
  assert.equal(obj.state.subpage?.kind, 'objective');
  assert.equal(obj.workboard.requests.length, 5, '4 requests + 1 more-requests fold row');
  assert.doesNotMatch(plain(obj).join('\n'), /Fifth alpha request/);

  // Up to 'more requests' and Enter expands in place; Home's requestsExpanded stays unchanged.
  obj = draw(send(obj, '\x1b[A').state);
  assert.equal(obj.state.subpage.cursor, PROJECT_REQUEST_MORE);
  obj = draw(send(obj, '\r').state);
  assert.equal(obj.workboard.requests.length, 6, 'all 5 requests + fewer row');
  assert.match(plain(obj).join('\n'), /Fifth alpha request/);
  assert.equal(obj.state.home.requestsExpanded, undefined, 'Home flag unchanged');

  // Mouse click on 'fewer' folds back on Objective; Home's flag still unchanged.
  const objMoreCtrl = obj.controls.find((c) => c.kind === 'request-more');
  assert.ok(objMoreCtrl, 'request-more control present');
  obj = draw(send(obj, { type: 'mouse', button: 'left', x: objMoreCtrl.x, y: objMoreCtrl.y }).state);
  assert.equal(obj.workboard.requests.length, 5);
  assert.doesNotMatch(plain(obj).join('\n'), /Fifth alpha request/);
  assert.equal(obj.state.home.requestsExpanded, undefined, 'Home flag unchanged');

  // Open Feature from that Objective (still under activeTab: 'execution') and test click + Enter on 'more requests'.
  obj = draw({ ...obj.state, subpage: { ...obj.state.subpage, cursor: 'objective:feature:nav-fix' } });
  let feat = draw(send(obj, '\r').state);
  assert.equal(feat.state.activeTab, 'execution');
  assert.equal(feat.state.subpage?.kind, 'feature');
  assert.equal(feat.workboard.requests.length, 5);
  assert.doesNotMatch(plain(feat).join('\n'), /Fifth alpha request/);

  const featMoreCtrl = feat.controls.find((c) => c.kind === 'request-more');
  assert.ok(featMoreCtrl, 'request-more control present on Feature');
  feat = draw(send(feat, { type: 'mouse', button: 'left', x: featMoreCtrl.x, y: featMoreCtrl.y }).state);
  assert.equal(feat.workboard.requests.length, 6);
  assert.match(plain(feat).join('\n'), /Fifth alpha request/);
  assert.equal(feat.state.home.requestsExpanded, undefined, 'Home flag unchanged');

  feat = draw(send(feat, '\r').state);
  assert.equal(feat.workboard.requests.length, 5);
  assert.doesNotMatch(plain(feat).join('\n'), /Fifth alpha request/);
  assert.equal(feat.state.home.requestsExpanded, undefined, 'Home flag unchanged');
});
