import { withState } from '../fixtures/state-helpers.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMonitorInput, initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { acceptsRawText, blocksReload, hasUnsavedDraft } from '../../dist/render/monitor-state.js';
import { panelState, panelProjectFixture } from '../fixtures/panel-project.mjs';
import { NOW, PROJECTS, TREE, onControl, onPage } from '../fixtures/project-page.mjs';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'monitor-state-machine-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return panelProjectFixture(root);
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
  const cases = [initial, { ...initial, subpage: { kind: 'jobs', scroll: 0 } },
    { ...initial, overlay: { kind: 'confirm-stop', jobId: worker.id, role: 'imp', dir: '/synthetic/job' } },
    onPage(undefined, { project: { view: { kind: 'projects-list' } } }), onControl(), onControl({}, {}, { subTab: 'harnesses' }),
    onControl({}, { overlay: { kind: 'control-harness-add', text: '' } }, { subTab: 'harnesses' }),
    onControl({}, { overlay: { kind: 'control-chain', role: { ...role }, at: 0, mode: { kind: 'places' } } }),
    onControl({}, { overlay: { kind: 'control-preset', sheet: { mode: 'list', role: { ...role }, text: '', at: 0 } } }),
    onControl({}, { overlay: { kind: 'control-quick-model', role, index: 0, picker: { text: '', place: role.places[0] } } }),
    onControl({}, { help: {}, overlay: { kind: 'control-chain', role, draft: { run: [] }, at: 0, mode: { kind: 'places' } } }),
    onControl({}, {}, { subTab: 'resources' }),
    onControl({}, { exp: { detail: 'codex-help', scroll: 2 } }, { subTab: 'resources' }),
    onControl({}, { overlay: { kind: 'exp-edit', entryId: 'binding', draft: { text: '', pick: 0 } } }, { subTab: 'resources' }),
    withState(initial, { subpage: { kind: 'inspector', scroll: 0, target } }), withState(initial, { subpage: { kind: 'native-inspector', scroll: 0 } }),
    onPage('tickets', { help: {} }), onPage('tickets', { project: { filter: { query: 'try', editing: false } } }),
    ...[undefined, 'tickets', 'tree', 'docs', 'unlinked', 'waiting'].map((page) => onPage(page)),
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
  const initial = onPage('tickets');
  const project = key(draw(initial), 'end');
  const home = key(key(project, 'shift-tab'), 'down');
  const returnedProject = key(home, 'tab');
  const returnedHome = key(returnedProject, 'shift-tab');
  assert.equal(returnedProject.state.project.nav.cursor, project.state.project.nav.cursor);
  assert.equal(returnedProject.panes[0].offset, project.panes[0].offset);
  assert.equal(returnedHome.state.home.scroll, home.state.home.scroll);
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
  const kept = onPage('tickets', { project: { filter: { query: 'sonic', editing: false } } }), typing = withState(kept, { project: { filter: { editing: true } } });
  assert.deepEqual([blocksReload(kept), acceptsRawText(kept)], [false, false]);
  assert.deepEqual([blocksReload(typing), acceptsRawText(typing)], [true, true]);
});
