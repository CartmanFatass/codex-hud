import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripAnsi } from '../../dist/render/colors.js';
import { initialMonitorState } from '../../dist/render/monitor.js';
import { SETTING_ROWS } from '../../dist/render/settings-page.js';
import { loadSettings } from '../../dist/settings.js';
import { delay, until, live, encode, QUIET_MS } from '../helpers/panel-reload-fixture.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

for (const bound of [false, true]) for (const view of ['project', 'help', 'inspector']) test(`the live ${bound ? 'Claude-bound' : 'unbound'} panel restores ${view}, selection and show-all across replacements`, async (t) => {
  const f = live(t, ({ home }) => encode({ state: {
    mainTab: view === 'project' ? 'project' : 'home', help: view === 'help',
    focus: view === 'inspector' ? 'details' : 'agents', boardInspect: view === 'inspector' ? home.cursor.target : undefined,
    homeTarget: home.cursor.target, boardExpanded: home.expanded, boardToggled: home.toggled, tree: { showAll: home.showAll },
  }, settings: null }), { bound });
  await until(() => f.output().includes('models off') || f.output().includes('Home ›') || f.output().includes('Help'), 'first collected view did not render');
  for (let generation = 1; generation <= 2; generation++) {
    f.appendBuild(`\n// ${view} build ${generation}`);
    // The start event precedes PanelReload construction. Wait for the replacement
    // to enter its alternate screen so the next edit cannot become its baseline.
    await until(() => f.events().filter((e) => e.start).length === generation + 1 &&
      f.output().match(/\x1b\[\?1049h/g)?.length === generation + 1, `${view} did not restart`);
    const { schemaVersion, stateV2: state } = f.restarts()[generation - 1].restart;
    assert.equal(schemaVersion, 2);
    assert.equal(state.activeTab, view === 'project' ? 'project' : 'home');
    assert.equal(Boolean(state.help), view === 'help');
    assert.equal(state.subpage?.kind, view === 'inspector' ? 'inspector' : undefined);
    if (view === 'inspector') assert.deepEqual(state.subpage.target, f.state.home.cursor.target);
    assert.deepEqual(state.home.cursor, f.state.home.cursor);
    assert.equal(state.home.showAll, true);
    assert.deepEqual(state.home.toggled, [...f.state.home.toggled]);
    assert.equal(state.prefs.cardHideMinutes, undefined, 'settings-derived prefs do not travel');
  }
});

test('the 40-column Classic to-try view reloads with its cursor but without pending batch marks', async (t) => {
  const f = live(t, (state) => ({ state: { ...state, activeTab: 'project', project: { ...state.project, view: { kind: 'progress', onlyTry: { scroll: 0 } } } }, settings: null }), { columns: 40 });
  writeFixtureFile(join(f.env.CODEX_HUD_CWD, 'STATE.md'), 'Milestone: M4\n\n## Slices\n- try · M4 · RELOAD-ONE · Synthetic reload slice\n');
  await until(() => f.output().includes('1 slice'), 'the to-try view did not render');
  f.child.stdin.write('gjj ');
  await until(() => f.output().includes('▣'), 'the slice was not marked');
  const at = f.output().length;
  f.appendBuild('\n// marked try view build');
  await until(() => f.output().slice(at).includes('1 slice'), 'the marked page did not repaint after reload: ' + f.stderr());
  assert.equal(f.events().filter((e) => e.start).length, 2);
  const { project } = f.restarts()[0].restart.stateV2;
  assert.equal(project.nav.cursor, 'project:fold:task:milestone:M4');
  assert.ok(project.view.onlyTry);
  assert.equal(project.trySelection, undefined, 'pending marks are not transported');
  assert.doesNotMatch(f.output().slice(at), /▣/);
  f.child.stdin.write(' ');
  await until(() => f.output().slice(at).includes('▣'), 'could not mark the slice again after reload');
});

// Reload checks run on collection ticks; allow time for both detection and a later poll.
const LIVE_INPUT_BLOCK_WINDOW_MS = QUIET_MS + 1200;

test('live input: a batched / query and later keys survive a build until Enter keeps the filter', async (t) => {
  const f = live(t);
  await until(() => f.output().includes('SYNTHETIC reload job'), 'Home did not render');
  f.child.stdin.write('/relo');
  await until(() => stripAnsi(f.output()).includes('/ relo▌'), 'the batched slash and query did not reach the filter');
  f.appendBuild('\n// build during a filter edit');
  await delay(LIVE_INPUT_BLOCK_WINDOW_MS);
  assert.equal(f.restarts().length, 0, 'reload must wait for the filter editor');
  f.child.stdin.write('ad');
  await until(() => stripAnsi(f.output()).includes('/ reload▌'), 'typing did not continue in the same filter');
  f.child.stdin.write('\r');
  await until(() => f.events().filter((e) => e.start).length === 2, 'reload did not resume after Enter');
  await until(() => stripAnsi(f.output()).includes('esc clear'), 'kept filter was not drawn');
  const saved = f.restarts()[0].restart.stateV2;
  assert.equal(saved.home.filterQuery, 'reload');
  assert.equal(saved.project.filterQuery, undefined);
});

test('live input: g on a job reaches focus-job-tab after automatic reload', async (t) => {
  const f = live(t);
  await until(() => f.output().includes('SYNTHETIC reload job'), 'Home did not render');
  const at = f.output().length;
  f.appendBuild('\n// build on a selected job');
  await until(() => f.events().filter((e) => e.start).length === 2 && f.output().slice(at).includes('SYNTHETIC reload job'), 'Home did not return after reload');
  f.child.stdin.write('g');
  // The synthetic job has no SESSION.txt. Reaching this diagnostic proves the action ran without invoking herdr.
  await until(() => f.output().slice(at).includes('no tab recorded'), 'g never reached the tab-focus action', 3000);
});

test('live input: a build waits for the Harnesses Add back draft to close', async (t) => {
  const f = live(t, (state) => ({ state: { ...state, activeTab: 'control', control: { ...state.control, subTab: 'harnesses' } }, settings: null }));
  writeFixtureFile(join(f.env.HUD_HOME, 'harnesses.json'), JSON.stringify({ disabled: ['pi:xai'] }));
  await until(() => f.output().includes('i add back'), 'Harnesses did not render');
  f.child.stdin.write('ixa');
  await until(() => stripAnsi(f.output()).includes('/ xa▌'), 'the Add back draft did not render');
  f.appendBuild('\n// build during an Add back edit');
  await delay(LIVE_INPUT_BLOCK_WINDOW_MS);
  assert.equal(f.restarts().length, 0, 'reload must wait for Add back');
  f.child.stdin.write('i');
  await until(() => stripAnsi(f.output()).includes('/ xai▌'), 'the draft was not still editable');
  f.child.stdin.write('\x1b');
  await until(() => f.events().filter((e) => e.start).length === 2, 'reload did not resume after Esc');
  assert.equal(f.restarts()[0].restart.stateV2.control.subTab, 'harnesses');
  const returned = f.output().length;
  f.child.stdin.write('ixa\r');
  await until(() => stripAnsi(f.output().slice(returned)).includes('Restored pi:xai'), 'Add back did not restore the switch');
  const restored = f.output().length;
  f.child.stdin.write('h');
  await until(() => !stripAnsi(f.output().slice(restored)).includes('Restored pi:xai') && f.output().slice(restored).includes('Needs attention'), 'Roles did not render without the Harnesses notice');
  const roles = f.output().length;
  f.child.stdin.write('h');
  await until(() => f.output().slice(roles).includes('This machine'), 'Harnesses did not render again');
  assert.doesNotMatch(stripAnsi(f.output().slice(roles)), /Restored pi:xai/, 'the old notice does not reappear');
});

test('live input: a build waits for stop confirmation, and an unnamed key cancels it', async (t) => {
  const f = live(t);
  await until(() => f.output().includes('SYNTHETIC reload job'), 'Home did not render');
  f.child.stdin.write('X');
  await until(() => f.output().includes('y confirm'), 'stop prompt did not open');
  f.appendBuild('\n// build during stop confirmation');
  await delay(LIVE_INPUT_BLOCK_WINDOW_MS);
  assert.equal(f.restarts().length, 0, 'reload must wait for stop confirmation');
  f.child.stdin.write('z');
  await until(() => f.events().filter((e) => e.start).length === 2, 'unnamed z did not cancel the prompt and unblock reload');
});

test('v, f and Esc never rewrite hud-settings.json, even when it contains retired pane settings', async (t) => {
  const retired = { changesPane: 'folded', detailsPane: 'closed', monitorModes: {}, monitorPreferences: {} };
  const f = live(t, undefined, { settings: retired });
  const file = join(f.env.HUD_HOME, 'hud-settings.json'), mtime = () => statSync(file, { bigint: true }).mtimeNs;
  const before = mtime();
  assert.equal(loadSettings(f.env).language, 'en');
  for (const key of Object.keys(retired)) assert.ok(!(key in loadSettings(f.env)), key);
  await until(() => stripAnsi(f.output()).includes('v inspect'), 'Home did not draw its Inspect key');
  const press = async (key, text) => {
    const at = f.output().length;
    f.child.stdin.write(key);
    await until(() => stripAnsi(f.output().slice(at)).includes(text), `${text} did not render`);
    assert.equal(mtime(), before, `${JSON.stringify(key)} rewrote settings`);
    assert.equal(readFileSync(file, 'utf8'), f.settingsBody);
  };
  for (let i = 0; i < 2; i++) {
    await press('v', 'Home ›');
    await press('\x1b', 'v inspect');
    await press('f', '‹ Changes');
    await press('\x1b', 'v inspect');
  }
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
  const f = live(t, { state: { ...initialMonitorState(), activeTab: 'project' }, settings: { selected: 0, offset: 0 } });
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
  assert.equal(place.stateV2.activeTab, 'project');
  assert.equal('draft' in (place.settingsView ?? {}), false, 'drafts are not transported');
  assert.equal(Boolean(place.settingsView), action === 'save', 'saved Settings stays open; discarded overlay closes');
  const settings = JSON.parse(readFileSync(join(f.env.HUD_HOME, 'hud-settings.json'), 'utf8'));
  assert.equal(settings.theme, action === 'save' ? 'titanium' : 'terminal');
});
