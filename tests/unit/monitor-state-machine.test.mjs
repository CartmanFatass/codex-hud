import { withState } from '../fixtures/state-helpers.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMonitorInput, initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { acceptsRawText, applyViewPrefs, blocksReload, hasUnsavedDraft } from '../../dist/render/monitor-state.js';
import { defaultSettings } from '../../dist/settings.js';
import { split, splitFixture } from '../fixtures/split-layout.mjs';
import { NOW, PROJECTS, TREE, onControl, onPage } from '../fixtures/project-page.mjs';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'monitor-state-machine-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return splitFixture(root);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (value instanceof Set || value instanceof Map) {
    for (const entry of value) deepFreeze(entry);
    for (const method of value instanceof Set ? ['add', 'delete', 'clear'] : ['set', 'delete', 'clear']) {
      Object.defineProperty(value, method, { value: () => assert.fail(`Render called ${method} on input state`) });
    }
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

test('painting twice gives the same frame without modifying the supplied state', async (t) => {
  const f = await fixture(t), initial = initialMonitorState();
  const worker = f.board.workers[0], target = { kind: 'worker', laneId: worker.laneId, workerId: worker.id };
  const role = f.control.roles.find((r) => r.role === 'imp');
  const marked = new Map([['project:slice:DATA-ONE', { milestone: '0.1.3', slices: [f.rich.ledger[0]] }]]);
  const cases = [initial, withState(initial, { home: { filter: { query: 'imp', editing: true } } }),
    split({ home: { split: { listCursor: 'home-progress:waiting', focus: 'preview', previewCursor: 'home-progress:wait:0', previewScroll: 5 },
      expandedTasks: new Set(['task:milestone:M4']), trySelection: marked } }),
    { ...initial, overlay: { kind: 'confirm-stop', jobId: worker.id, role: 'imp', dir: '/synthetic/job' } },
    onPage(undefined, { project: { view: { kind: 'projects-list' } } }), onControl(), onControl({}, {}, { subTab: 'harnesses' }),
    onControl({}, { overlay: { kind: 'control-harness-add', text: '' } }, { subTab: 'harnesses' }),
    onControl({}, { overlay: { kind: 'control-chain', role: { ...role }, at: 0, mode: { kind: 'places' } } }),
    onControl({}, { overlay: { kind: 'control-preset', sheet: { mode: 'list', role: { ...role }, text: '', at: 0 } } }),
    onControl({}, { overlay: { kind: 'control-quick-model', role, index: 0, picker: { text: '', place: role.places[0] } } }),
    onControl({}, { help: {}, overlay: { kind: 'control-chain', role, draft: { run: [] }, at: 0, mode: { kind: 'places' } } }),
    withState(initial, { activeTab: 'exp', prefs: { experiments: true } }),
    withState(initial, { activeTab: 'exp', prefs: { experiments: true }, exp: { detail: 'codex-help', scroll: 2 } }),
    withState(initial, { activeTab: 'exp', prefs: { experiments: true }, overlay: { kind: 'exp-edit', entryId: 'binding', draft: { text: '', pick: 0 } } }),
    withState(initial, { subpage: { kind: 'inspector', scroll: 0, target } }), withState(initial, { subpage: { kind: 'changes', scroll: 0 } }),
    onPage('progress', { help: {} }), onPage('progress', { project: { trySelection: marked, filter: { query: 'try', editing: false } } }),
    ...['timeline', 'board', 'inbox'].flatMap((projectLayout) => [undefined, 'progress', 'tickets', 'tree', 'docs', 'waiting']
      .map((page) => onPage(page, { prefs: { projectLayout } }))),
  ];
  for (const panelLayout of ['classic', 'split']) for (const candidate of cases) {
    const state = structuredClone(withState(candidate, { prefs: { panelLayout } })), before = structuredClone(state);
    const draw = () => renderMonitor({ tree: TREE, workboard: f.board, project: f.control, projects: PROJECTS,
      state: deepFreeze(state), width: 40, height: 18, nowMs: NOW });
    const first = draw(), second = draw();
    assert.deepEqual(state, before);
    assert.deepEqual(second.state, first.state);
    assert.deepEqual(second.lines, first.lines);
  }
});

test('Classic Home and Project keep their selected rows across tab changes', async (t) => {
  const f = await fixture(t), draw = (state) => f.render(40, 'en', 24, state, f.rich);
  const key = (frame, key) => draw(handleMonitorInput(frame.state, { type: 'key', key }, { tree: TREE, frame, nowMs: NOW }).state);
  const initial = onPage('progress', { prefs: { acceptance: 'slice' } });
  const project = key(draw(initial), 'end');
  const home = key(key(project, 'shift-tab'), 'down');
  const returnedProject = key(home, 'tab');
  const returnedHome = key(returnedProject, 'shift-tab');
  assert.equal(returnedProject.state.project.nav.cursor, project.state.project.nav.cursor);
  assert.equal(returnedProject.panes[0].offset, project.panes[0].offset);
  assert.deepEqual(returnedHome.workboard.selected, home.workboard.selected);
});

test('Home keeps its Split preview and task folds across a tab, project or Project-layout switch', async (t) => {
  const f = await fixture(t);
  const project = { ...f.rich, ledger: [
    { id: 'ONE', milestone: 'M-TEST', text: 'First synthetic slice', state: 'try', at: NOW - 2000 },
    { id: 'TWO', milestone: 'M-TEST', text: 'Second synthetic slice', state: 'try', at: NOW - 1000 },
  ], waiting: Array.from({ length: 12 }, (_, i) => ({ value: `Synthetic waiting item ${i}` })) };
  const draw = (state) => f.render(40, 'en', 14, state, project, { projects: PROJECTS });
  const press = (frame, key) => handleMonitorInput(frame.state, { type: 'key', key }, { tree: TREE, frame, nowMs: NOW }).state;
  const step = (frame, key) => draw(press(frame, key));
  const initial = split({ selectedProject: PROJECTS[0].root, prefs: { acceptance: 'task' },
    home: { split: { listCursor: 'home-progress:waiting' } } });
  let frame = step(draw(initial), 'enter');
  assert.equal(frame.state.home.split.focus, 'preview');
  frame = step(frame, 'end');
  const fold = frame.state.home.split.previewCursor;
  assert.match(fold, /^project:fold:task:/);
  frame = step(frame, 'enter');
  assert.ok(frame.state.home.split.previewScroll > 0);
  const home = frame.state.home;
  assert.ok(home.expandedTasks.has(fold.slice('project:fold:'.length)));
  assert.equal(frame.state.project.folded.size, 0);

  const other = step(step(frame, 'tab'), 'enter');
  assert.equal(other.state.activeTab, 'project');
  assert.deepEqual(other.state.home.split, home.split);
  assert.deepEqual(other.state.home.expandedTasks, home.expandedTasks);
  const switched = press(other, 'project-next');
  assert.equal(switched.selectedProject, PROJECTS[1].root);
  assert.equal(switched.project.nav.split.focus, 'list');
  assert.equal(switched.project.nav.split.previewScroll, 0);
  assert.deepEqual(switched.home, other.state.home);
  const prefs = applyViewPrefs(switched, { ...defaultSettings(), panelLayout: 'split', projectLayout: 'board' });
  assert.deepEqual(prefs.home, switched.home);
  const back = step(draw(prefs), 'shift-tab');
  assert.equal(back.state.activeTab, 'home');
  assert.deepEqual(back.state.home.split, home.split);
  assert.deepEqual(back.state.home.expandedTasks, home.expandedTasks);
});

test('overlay policy distinguishes a reload blocker from a draft and a raw-text consumer', () => {
  const role = { role: 'synthetic' }, picker = { text: '', place: {} };
  const places = { kind: 'places' }, form = { kind: 'sheet', index: 0, field: 'target' };
  const chain = (mode, draft) => ({ kind: 'control-chain', role, at: 0, mode, draft });
  const preset = (mode, text = '') => ({ kind: 'control-preset', sheet: { role, mode, ...(mode === 'delete' ? {} : { text }), ...(mode === 'list' ? { at: 0 } : {}) } });
  const cases = [
    [undefined, false, false, false],
    [{ kind: 'confirm-stop', role: role.role, jobId: 'j0000000000000000', dir: 'synthetic' }, false, true, true],
    [{ kind: 'control-quick-model', role, index: 0, picker }, true, true, true],
    [{ kind: 'control-harness-add', text: '' }, true, true, true],
    [{ kind: 'exp-edit', entryId: 'alias', draft: { text: '', pick: 0 } }, true, true, true],
    [preset('list'), false, true, true],
    [preset('list', 'x'), true, true, true],
    [preset('copy'), true, true, true],
    [preset('empty'), true, true, true],
    [preset('rename'), true, true, true],
    [preset('delete'), true, true, false],
    [chain(places), false, false, false],
    [chain(places, { run: [] }), true, true, false],
    [chain({ kind: 'confirm-leave', leave: { type: 'key', key: 'escape' }, resume: places }, { run: [] }), true, true, false],
    [chain(form), true, true, false],
    [chain({ ...form, input: { kind: 'choice', text: '', at: 0 } }), true, true, true],
    [chain({ ...form, field: 'model', input: { kind: 'pi-model-picker', picker } }), true, true, true],
    [chain({ kind: 'quick-model', index: 0, picker }), true, true, true],
  ];
  const initial = initialMonitorState();
  for (const [overlay, draft, blocked, raw] of cases) {
    const state = { ...initial, overlay };
    assert.deepEqual([hasUnsavedDraft(state), blocksReload(state), acceptsRawText(state)], [draft, blocked, raw], JSON.stringify(overlay));
  }
  const help = { ...initial, overlay: chain(places, { run: [] }), help: {} };
  assert.deepEqual([blocksReload(help), acceptsRawText(help)], [true, false]);
  const kept = withState(initial, { home: { filter: { query: 'sonic', editing: false } } }), typing = withState(kept, { home: { filter: { editing: true } } });
  assert.deepEqual([blocksReload(kept), acceptsRawText(kept)], [false, false]);
  assert.deepEqual([blocksReload(typing), acceptsRawText(typing)], [true, true]);
});
