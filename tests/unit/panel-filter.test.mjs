import { tabState, viewFor, withState, sliceState } from '../fixtures/state-helpers.mjs';
import { projectPageOf } from '../../dist/render/project-view.js';
/** Tickets `/` filtering: typing, Enter, Esc, and the keys it swallows. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { panelProjectFixture, panelState } from '../fixtures/panel-project.mjs';
import { NOW, TREE, plain } from '../fixtures/project-page.mjs';
import { handleMonitorInput } from '../../dist/render/monitor.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { encodePanelPlace, readPanelPlace } from '../../dist/utils/panel-reload.js';

const decoder = new WorkbenchInputDecoder('workboard');
const page = (p, extra) => (withState(sliceState(), { activeTab: 'project', project: { folded: new Set(['agents', 'healthy', 'files']), view: viewFor(p) } }, extra));
async function busy(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'panel-filter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return panelProjectFixture(join(root, 'busy'));
}
/** One input at a time against the frame it was drawn on, then the next frame from the state it left. */
function drive(f, state, { width = 40, height = 30, lang = 'en', data = f.data } = {}) {
  let frame = f.render(width, lang, height, state, data), last;
  const press = (input) => {
    for (const one of typeof input === 'string' ? decoder.push(Buffer.from(input)) : [input]) {
      last = handleMonitorInput(frame.state, one, { tree: TREE, frame, nowMs: NOW });
      frame = f.render(width, lang, height, last.state, data);
    }
    return last;
  };
  return { press, type: (text) => [...text].forEach((c) => press(c)), esc: () => press({ type: 'key', key: 'escape' }), enter: () => press('\r'),
    get frame() { return frame; }, get state() { return frame.state; }, get out() { return last; }, lines: () => plain(frame),
    bar: () => plain(frame)[1 + (frame.workboard?.requests?.length ?? 0)] };
}

test('Esc stops typing, then clears the filter, and only then leaves the page', async (t) => {
  const f = await busy(t);
  const d = drive(f, page('tickets'));
  d.press('/'); d.type('inspector');
  assert.match(d.bar(), /^\/ inspector▌ +1 match$/);
  d.esc();
  assert.deepEqual([tabState(d.state)?.filter?.editing, tabState(d.state)?.filter?.query, projectPageOf(d.state)], [false, 'inspector', 'tickets'], 'the first Esc stops typing and keeps the filter');
  assert.match(d.bar(), /^\/ inspector +1 match · esc clear$/);
  d.esc();
  assert.deepEqual([tabState(d.state)?.filter?.editing, tabState(d.state)?.filter?.query, projectPageOf(d.state)], [undefined, undefined, 'tickets'], 'the second clears it, on the same page');
  assert.doesNotMatch(d.bar(), /^\//);
  d.esc();
  assert.equal(projectPageOf(d.state), undefined, 'the third leaves the page');
  // An empty bar has nothing to keep: Esc closes it at once.
  const e = drive(f, page('tickets'));
  e.press('/'); e.esc();
  assert.deepEqual([tabState(e.state)?.filter?.editing, tabState(e.state)?.filter?.query], [undefined, undefined]);
});

test('Tickets filters by feature, number, title, status and blocker, in both layouts', async (t) => {
  const f = await busy(t);
  const count = (state, data, query) => {
    const d = drive(f, state, { data, height: 40 });
    d.press('/'); d.type(query);
    return { n: Number(/(\d+) match/.exec(d.bar())?.[1] ?? NaN), text: d.lines().join('\n') };
  };
  for (const layout of [{}, { prefs: { panelLayout: 'split' } }]) {
    const tickets = (q) => count(page('tickets', layout), f.data, q);
    assert.equal(tickets('nothing like this').n, 0);
    assert.equal(tickets('retired-tools').n, 1, 'feature');
    assert.equal(tickets('04').n, 1, 'number');
    assert.match(tickets('04').text, /native-tree/);
    assert.equal(tickets('shortcuts').n, 1, 'title');
    assert.equal(tickets('triaging').n, 1, 'status');
    assert.equal(tickets('03').n, 1, 'number and blockers match the same feature');
    assert.equal(tickets('Inspector').n, 1);
    assert.doesNotMatch(tickets('03').text, /retired-tools/);
  }
});

test('every row is exactly the panel\'s width with the bar up, in English and Chinese, and the filter is kept across the reload', async (t) => {
  const f = await busy(t);
  for (const lang of ['en', 'zh']) for (const width of [30, 40, 52, 80]) for (const query of ['', 'e', 'zzzz']) {
    const d = drive(f, page('tickets'), { width, height: 24, lang });
    d.press('/'); d.type(query);
    assert.match(d.bar(), /^\/ /, 'the bar is the row under the header');
    for (const line of d.frame.lines) assert.equal(visualLength(line), width, `${lang} ${width} "${query}": ${stripAnsi(line)}`);
    d.enter();
    for (const line of d.frame.lines) assert.equal(visualLength(line), width, `${lang} ${width} "${query}" kept: ${stripAnsi(line)}`);
  }
  const d = drive(f, page('tickets'));
  d.press('/'); d.type('inspector'); d.enter();
  const held = process.env.HUD_PANEL_RELOAD_PLACE;
  process.env.HUD_PANEL_RELOAD_PLACE = encodePanelPlace({ state: d.state, settings: null });
  const place = readPanelPlace();
  if (held === undefined) delete process.env.HUD_PANEL_RELOAD_PLACE; else process.env.HUD_PANEL_RELOAD_PLACE = held;
  assert.equal(tabState(place.state)?.filter?.query, 'inspector');
  assert.match(drive(f, place.state).bar(), /^\/ inspector +1 match · esc clear$/);
});
