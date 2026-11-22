import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initialMonitorState } from '../../dist-test/src/render/monitor.js';
import { SETTING_ROWS } from '../../dist-test/src/render/settings-page.js';
import { delay, until, live, QUIET_MS } from '../helpers/panel-reload-fixture.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

for (const bound of [false, true]) for (const view of ['project', 'help', 'inspector']) test(`the live ${bound ? 'Claude-bound' : 'unbound'} panel restores ${view}, selection and show-all across replacements`, async (t) => {
  const f = live(t, (state) => ({ state: { ...state,
    mainTab: view === 'project' ? 'project' : 'home', help: view === 'help',
    focus: view === 'inspector' ? 'details' : 'agents', boardInspect: view === 'inspector' ? state.homeTarget : undefined,
  }, settings: null }), { bound });
  await until(() => f.output().includes('models off') || f.output().includes('Home ›') || f.output().includes('Help'), 'first collected view did not render');
  for (let generation = 1; generation <= 2; generation++) {
    f.appendBuild(`\n// ${view} build ${generation}`);
    await until(() => f.events().filter((e) => e.start).length === generation + 1, `${view} did not restart`);
    await delay(300);
    const state = f.restarts()[generation - 1].restart.state;
    assert.equal(state.mainTab, view === 'project' ? 'project' : 'home');
    assert.equal(state.help, view === 'help');
    assert.equal(state.focus, view === 'inspector' ? 'details' : 'agents');
    if (view === 'inspector') assert.deepEqual(state.boardInspect, f.state.homeTarget);
    assert.deepEqual(state.homeTarget, f.state.homeTarget);
    assert.equal(state.tree.showAll, true);
    assert.deepEqual(state.boardToggled.panelSet, [...f.state.boardToggled]);
    assert.equal(state.cardHideMinutes, 15, 'missing handoff fields get configured defaults');
  }
});

test('the 40-column Classic to-try view reloads with its cursor but without pending batch marks', async (t) => {
  const f = live(t, (state) => ({ state: { ...state, mainTab: 'project', projectPage: 'progress', projectTry: { scroll: 0 } }, settings: null }), { columns: 40 });
  writeFixtureFile(join(f.env.CODEX_HUD_CWD, 'STATE.md'), 'Milestone: M4\n\n## Slices\n- try · M4 · RELOAD-ONE · Synthetic reload slice\n');
  await until(() => f.output().includes('1 slice'), 'the to-try view did not render');
  f.child.stdin.write('gjj ');
  await until(() => f.output().includes('▣'), 'the slice was not marked');
  const at = f.output().length;
  f.appendBuild('\n// marked try view build');
  await until(() => f.output().slice(at).includes('1 slice'), 'the marked page did not repaint after reload: ' + f.stderr());
  assert.equal(f.events().filter((e) => e.start).length, 2);
  const saved = f.restarts()[0].restart.state;
  assert.equal(saved.projectCursor, 'project:fold:task:milestone:M4');
  assert.ok(saved.projectTry);
  assert.doesNotMatch(f.output().slice(at), /▣/);
  f.child.stdin.write(' ');
  await until(() => f.output().slice(at).includes('▣'), 'could not mark the slice again after reload');
});

test('saving Width 64 from opening width 56 keeps 64 across real panel replacements', async (t) => {
  const f = live(t, (state) => ({ state, settings: { selected: SETTING_ROWS.findIndex((r) => r.key === 'treeWidth'), offset: 0 } }), { width: true });
  await until(() => f.output().includes('Settings'), 'Settings did not open');
  f.child.stdin.write('\x1b[Cs');
  await until(() => Math.abs(f.geometry().width - 64) < 0.01, 'saved width was not applied: ' + f.stderr());
  assert.equal(JSON.parse(readFileSync(join(f.env.HUD_HOME, 'hud-settings.json'), 'utf8')).treeWidth, 64);
  for (let generation = 1; generation <= 2; generation++) {
    f.appendBuild(`\n// saved width build ${generation}`);
    await until(() => f.events().filter((e) => e.start).length === generation + 1, 'panel did not replace itself');
    await delay(700);
    assert.ok(Math.abs(f.geometry().width - 64) < 0.01, JSON.stringify(f.geometry()));
    assert.equal(f.geometry().resizes.length, 1, 'no reload-time shrink to opening width');
  }
});

for (const action of ['save', 'discard']) test(`the live panel waits for Settings ${action} before restarting`, async (t) => {
  const f = live(t, { state: { ...initialMonitorState(), mainTab: 'project' }, settings: { selected: 0, offset: 0 } });
  await until(() => f.output().includes('Settings'), 'Settings overlay did not resume');
  f.child.stdin.write('\x1b[C');
  await until(() => f.output().includes('unsaved'), 'Settings edit was not dirty');
  f.appendBuild('\n// settings build');
  await delay(QUIET_MS + 350);
  assert.equal(f.restarts().length, 0);
  if (action === 'save') f.child.stdin.write('s');
  else { f.child.stdin.write('\x1b'); await delay(150); f.child.stdin.write('\x1b[D\r'); }
  await until(() => f.events().filter((e) => e.start).length === 2, `no reload after ${action}`);
  assert.equal(f.restarts().length, 1);
  const place = f.restarts()[0].restart;
  assert.equal(place.state.mainTab, 'project');
  assert.equal('draft' in (place.settings ?? {}), false, 'drafts are not transported');
  assert.equal(Boolean(place.settings), action === 'save', 'saved Settings stays open; discarded overlay closes');
  const settings = JSON.parse(readFileSync(join(f.env.HUD_HOME, 'hud-settings.json'), 'utf8'));
  assert.equal(settings.theme, action === 'save' ? 'titanium' : 'terminal');
});
