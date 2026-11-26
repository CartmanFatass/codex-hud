import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMonitor, initialMonitorState, handleMonitorInput } from '../../dist/render/monitor.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { readPanelPlace } from '../../dist/utils/panel-reload.js';
import { setLanguage } from '../../dist/render/i18n.js';
const tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(0) };
const render = (state, extra = {}) => renderMonitor({ tree, state, width: 160, height: 25, nowMs: 0, ...extra });
const send = (frame, input) => handleMonitorInput(frame.state, input, { tree, frame, nowMs: 0, standalone: true });
const key = (frame, key) => send(frame, { type: 'key', key });

test('main tabs cycle Home → Project → Execution → Control; 5 does not switch and old Skills reloads onto Home', (t) => {
  for (const [direction, order] of [
    ['right', ['project', 'execution', 'control', 'home']], ['tab', ['project', 'execution', 'control', 'home']],
    ['left', ['control', 'execution', 'project', 'home']], ['shift-tab', ['control', 'execution', 'project', 'home']],
  ]) {
    let frame = render(initialMonitorState());
    for (const tab of order) {
      frame = render(key(frame, direction).state);
      assert.equal(frame.state.activeTab, tab);
    }
  }
  const frame = render(initialMonitorState(), { width: 40 });
  assert.deepEqual(frame.controls.filter((c) => c.y === 0 && c.kind.startsWith('board-')).map((c) => c.kind), ['board-home', 'board-project', 'board-execution', 'board-control']);
  const decoder = new WorkbenchInputDecoder('workboard');
  const five = send(frame, decoder.push(Buffer.from('5'))[0]);
  assert.equal(five.state.activeTab, 'home');
  assert.equal(!!five.state.help, false);
  const previous = process.env.HUD_PANEL_RELOAD_PLACE;
  t.after(() => {
    if (previous === undefined) delete process.env.HUD_PANEL_RELOAD_PLACE;
    else process.env.HUD_PANEL_RELOAD_PLACE = previous;
  });
  process.env.HUD_PANEL_RELOAD_PLACE = JSON.stringify({ state: { mainTab: 'skills' } });
  assert.equal(readPanelPlace().state.activeTab, 'home');
  const before = setLanguage('en');
  try {
    const narrow = render(initialMonitorState(), { width: 35 });
    assert.deepEqual(narrow.controls.filter((c) => c.y === 0).map((c) => c.kind), ['board-home', 'board-project', 'board-execution', 'board-control']);
  } finally { setLanguage(before); }
});
