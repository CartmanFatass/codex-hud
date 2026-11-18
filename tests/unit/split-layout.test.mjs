/** The Split layout (spec §2.2 "Panel layouts"): a list above, the cursor row's preview below; frames at 40 columns and how the keys and the mouse move through it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitFixture, splitFrames, split } from '../fixtures/split-layout.mjs';
import { NOW, TREE, plain, onPage } from '../fixtures/project-page.mjs';
import { handleMonitorInput, initialMonitorState } from '../../dist/render/monitor.js';
import { defaultSettings, loadSettings } from '../../dist/settings.js';
import { renderSettingsPage, SETTING_ROWS } from '../../dist/render/settings-page.js';
import { withDisplaySettings } from '../../dist/settings-runtime.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';

const expected = JSON.parse(fs.readFileSync(new URL('../fixtures/split-frames.json', import.meta.url), 'utf8'));
async function fixtures(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'split-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { busy: await splitFixture(join(root, 'busy')), idle: await splitFixture(join(root, 'idle'), { idle: true }) };
}
const page = (p, extra) => split({ mainTab: 'project', projectPage: p, projectFolded: new Set(['agents', 'healthy', 'files']), ...extra });
/** One input against a frame, then the next frame from the state it left. */
function driver(f, { width = 40, height = 40, data = f.data } = {}) {
  let frame = f.render(width, 'en', height, undefined, data);
  const ctx = () => ({ tree: TREE, frame, nowMs: NOW, standalone: true });
  const run = (input) => {
    const out = handleMonitorInput(frame.state, typeof input === 'string' ? { type: 'key', key: input } : input, ctx());
    frame = f.render(width, 'en', height, out.state, data);
    return out;
  };
  const at = (state) => { frame = f.render(width, 'en', height, state, data); return driver_; };
  const driver_ = { run, at, get frame() { return frame; }, get state() { return frame.state; }, lines: () => plain(frame), pane: (id) => frame.panes.find((p) => p.id === id) };
  return driver_;
}
/** The preview's rule row: the one above the preview pane. */
const rule = (d) => d.lines()[d.pane('preview').y - 1];

test('Split frames at 40 columns, English and Chinese: Home busy, idle and short, the hub, Progress, the Control plane, the other pages', async (t) => {
  const { busy, idle } = await fixtures(t);
  assert.deepEqual(splitFrames(busy, idle), expected);
  // Every row of every frame is exactly as wide as the panel, at any width and in either language.
  for (const lang of ['en', 'zh']) for (const width of [40, 52, 80, 120]) for (const height of [12, 24, 40]) {
    const views = [[busy, undefined, busy.data], [idle, undefined, idle.data], [busy, page(undefined), busy.control], [busy, page('progress'), busy.rich],
      [busy, page('control'), busy.control], [busy, page('tickets'), busy.data], [busy, page('tree'), busy.data], [busy, page('docs'), busy.data]];
    for (const [f, state, data] of views) for (const line of f.render(width, lang, height, state, data).lines)
      assert.equal(visualLength(line), width, `${lang} ${width}x${height}: ${stripAnsi(line)}`);
  }
});

test('Home: the list has a row per lane and block, a question and a failure keep a reason row, and the cursor starts on the first row that needs the owner', async (t) => {
  const { busy, idle } = await fixtures(t);
  const d = driver(busy), lines = d.lines();
  // Needs first (asking, the failure), then what runs, then Waiting, Decided and Progress; the preview is the cursor lane's slab and cards.
  assert.deepEqual(lines.slice(2, 12).map((l) => l.slice(0, 14)), ['? NATIVE-TREE ', '┃ Question: Wh', '✗ EXPORT-CSV  ', '┃ HTTP 429, no', '◉ M4-PROJECT  ', '◉ AUTH-REFRESH', '◉ this session', '? Waiting for ', '◇ Decided for ', '◐ Progress  M3']);
  assert.match(rule(d), /^NATIVE-TREE ─+ asking · 2 jobs$/);
  assert.equal(d.state.splitCursor, d.frame.workboard.rows[0].item);
  // Idle: nothing runs, the first row that needs the owner is Waiting for you, whose preview lists the items and the latest slices.
  const calm = driver(idle), quiet = calm.lines();
  assert.match(quiet[2], /^\? Waiting for you +2 · 1 to try$/);
  assert.match(rule(calm), /^Waiting for you ─+ 2 · 1 to try$/);
  assert.ok(quiet.some((l) => /^Latest ─+ newest first$/.test(l)) && quiet.some((l) => /◇ LANDING/.test(l)));
});

test('Home: the list keeps its height whatever the preview does, and gives way last (24 rows)', async (t) => {
  const { busy } = await fixtures(t);
  const tall = driver(busy), short = driver(busy, { height: 24 });
  const list = (d) => d.pane('agents').rows.map((r) => stripAnsi(r.text));
  assert.deepEqual(list(short), list(tall), 'the list is the same rows at 24 rows as at 40');
  assert.equal(short.lines().length, 24);
  // Moving the cursor changes the preview, never the list; expanding a card in the preview does not move a list row either.
  const before = list(tall);
  tall.run('down'); tall.run('down');
  assert.deepEqual(list(tall), before);
  assert.notEqual(rule(tall), rule(driver(busy)));
  const tiny = driver(busy, { height: 12 });
  assert.equal(tiny.lines().length, 12);
  assert.ok(tiny.lines().some((l) => /^✗ EXPORT-CSV/.test(l)), 'a short panel scrolls the list with its cursor, and keeps the failure reachable');
});

test('Home keys: ↑↓ move the list, PgUp/PgDn and the wheel over the preview scroll it, Enter enters the preview, Enter expands, Esc comes back', async (t) => {
  const { busy } = await fixtures(t);
  const d = driver(busy, { height: 24 });
  d.run('down');
  assert.match(d.state.splitCursor, /EXPORT-CSV/);
  d.run('up');
  // The question's preview is longer than the room a 24-row panel leaves under a list this tall: PgDn moves its window, PgUp back.
  const small = driver(busy, { height: 19 }), top = small.lines().join('\n');
  small.run('page-down');
  assert.ok(small.state.splitScroll > 0);
  assert.notEqual(small.lines().join('\n'), top);
  assert.equal(small.lines()[2], top.split('\n')[2], 'the list did not move');
  small.run('page-up');
  assert.equal(small.lines().join('\n'), top);
  const wheel = small.pane('preview'), y = wheel.y;
  small.run({ type: 'mouse', x: 3, y, button: 'wheel-down' });
  assert.ok(small.state.splitScroll > 0, 'the wheel over the preview scrolls it');
  small.run({ type: 'mouse', x: 3, y: 3, button: 'wheel-down' });
  assert.match(small.state.splitCursor, /EXPORT-CSV/, 'the wheel over the list moves the cursor');
  // Enter moves into the preview; there Enter expands the card under the cursor and Esc returns.
  d.run('enter');
  assert.equal(d.state.splitFocus, 'preview');
  const sub = d.state.splitSub;
  assert.ok(sub);
  d.run('enter');
  assert.ok(d.state.boardExpanded.has(sub), 'Enter in the preview expands the slab');
  assert.match(d.lines().join('\n'), /Use the synthetic layout|Which synthetic option/);
  d.run('escape');
  assert.equal(d.state.splitFocus, undefined);
  d.run('escape');
  assert.equal(d.state.mainTab, 'home', 'Esc on the list does what it did');
});

test('Home mouse: a click selects the row, a second click is Enter; a click on a preview card selects it, again expands it', async (t) => {
  const { busy } = await fixtures(t);
  const d = driver(busy), row = (text) => d.pane('agents').y + d.pane('agents').rows.findIndex((r) => stripAnsi(r.text).startsWith(text));
  d.run({ type: 'mouse', x: 4, y: row('◉ M4-PROJECT'), button: 'left' });
  assert.match(d.state.splitCursor, /M4-PROJECT/);
  assert.equal(d.state.splitFocus, undefined);
  d.run({ type: 'mouse', x: 4, y: row('◉ M4-PROJECT'), button: 'left' });
  assert.equal(d.state.splitFocus, 'preview', 'the second click is Enter');
  d.run('escape');
  d.run({ type: 'mouse', x: 4, y: row('? NATIVE-TREE'), button: 'left' });
  const preview = d.pane('preview'), card = preview.y + preview.rows.findIndex((r) => stripAnsi(r.text).startsWith('✓ reviewer'));
  d.run({ type: 'mouse', x: 4, y: card, button: 'left' });
  assert.equal(d.state.splitFocus, 'preview');
  assert.match(d.state.splitSub, /worker/);
  d.run({ type: 'mouse', x: 4, y: card, button: 'left' });
  assert.ok(d.state.boardToggled?.has(d.state.splitSub), 'a second click toggles it, as Enter does (the newest result starts open)');
});

test('Home: Waiting for you opens its items, Enter on one reads it whole, Progress opens its page; o and v act on the lane under the cursor', async (t) => {
  const { busy } = await fixtures(t);
  const d = driver(busy);
  for (let i = 0; i < 5; i++) d.run('down');
  assert.equal(d.state.splitCursor, 'home-progress:waiting');
  assert.equal(d.state.boardAnchor, 'home-progress:waiting');
  d.run('enter');
  assert.equal(d.state.splitFocus, 'preview');
  assert.equal(d.state.splitSub, 'home-progress:wait:0');
  d.run('enter');
  assert.equal(d.state.mainTab, 'project');
  assert.equal(d.state.projectPage, 'waiting');
  const home = driver(busy);
  home.run('end');
  assert.equal(home.state.splitCursor, 'home-progress:progress');
  home.run('enter');
  assert.equal(home.state.projectPage, 'progress');
  // The lane's most important job is the one `o` opens and `v` inspects.
  const lane = driver(busy);
  assert.equal(lane.state.homeTarget.kind, 'worker');
  assert.match(lane.run('open-session').action?.type ?? '', /^open-files$/);
  assert.equal(lane.run('inspect').state.focus, 'details');
});

test('Project hub: a list of Waiting and the pages with the cursor page previewed; Enter opens a page; y and n act on the next slice to try', async (t) => {
  const { busy } = await fixtures(t);
  const d = driver(busy, { data: busy.control }).at(page(undefined));
  const lines = d.lines();
  assert.match(lines[5], /^◐ Progress/);
  assert.match(rule(d), /^Progress ─+ ⏎ open page$/);
  assert.equal(d.state.projectCursor, 'project:page:progress', 'it starts on the first page, as Classic does');
  assert.ok(lines.some((l) => /^To try {3}y accept {2}n flag/.test(l)) && lines.some((l) => /^Now$/.test(l)) && lines.some((l) => /^Latest accepted$/.test(l)));
  d.run('down');
  assert.equal(d.state.projectCursor, 'project:page:tickets');
  assert.match(rule(d), /^Tickets ─+ ⏎ open page$/);
  d.run('up');
  const out = d.run('try-accept');
  assert.deepEqual([out.action.type, out.action.action, out.action.target.slices[0].id], ['record-try', 'accept', 'DATA-ONE']);
  assert.equal(d.run('next-trouble').action.action, 'flag');
  d.run('enter');
  assert.equal(d.state.projectPage, 'progress');
  // A slice already marked leaves the queue: the next one is the one y acts on.
  const marked = driver(busy, { data: busy.control });
  marked.frame.workboard; // render once with the mark in force
  const again = busy.render(40, 'en', 40, page(undefined), busy.control, { tryMarks: new Map([['DATA-ONE', 'accept']]) });
  const next = handleMonitorInput(again.state, { type: 'key', key: 'try-accept' }, { tree: TREE, frame: again, nowMs: NOW, standalone: true });
  assert.equal(next.action.target.slices[0].id, 'WATCH-LINK');
});

test('Project hub: Waiting for you takes the keys into its items; Enter reads one, Esc lands back on the Waiting row', async (t) => {
  const { busy } = await fixtures(t);
  const d = driver(busy, { data: busy.control }).at(page(undefined, { projectCursor: 'project:fold:waiting' }));
  assert.match(rule(d), /^Waiting for you ─+ 2 · 1 to try$/);
  d.run('enter');
  assert.equal(d.state.splitFocus, 'preview');
  assert.equal(d.state.projectCursor, d.state.splitSub);
  d.run('enter');
  assert.equal(d.state.projectPage, 'waiting');
  d.run('escape');
  assert.equal(d.state.projectPage, undefined);
  assert.match(rule(d), /^Waiting for you ─+/, 'back on the Waiting row');
});

test('Progress page: one ledger list, the cursor slice explained underneath; y and n work on any to-try row; Enter opens STATE.md; History is one folded row', async (t) => {
  const { busy } = await fixtures(t);
  const d = driver(busy, { data: busy.rich }).at(page('progress'));
  const list = d.pane('agents').rows.map((r) => stripAnsi(r.text));
  assert.deepEqual(list.slice(2, 6).map((l) => l.split(' ')[1]), ['PAGE-ONE', 'PAGE-TWO', 'DATA-ONE', 'LATER-ONE'].slice(0, 4).map((x) => x));
  assert.match(rule(d), /^PAGE-ONE ─+ working · 0\.1\.3$/);
  assert.equal(d.run('try-accept').action, undefined, 'a working slice is not a to-try row');
  d.run('down'); d.run('down');
  assert.match(d.state.projectCursor, /DATA-ONE/);
  assert.match(rule(d), /^DATA-ONE ─+ to try · 0\.1\.3$/);
  assert.equal(d.run('try-accept').action.target.slices[0].id, 'DATA-ONE');
  assert.equal(d.run('open-session').action.type, 'open-files');
  d.run('end');
  assert.equal(d.state.projectCursor, 'split:history');
  assert.match(rule(d), /^History ─+ newest first$/);
  assert.equal(d.run('escape').state.projectPage, undefined, 'Esc goes back to the hub');
});

test('Control plane: roles on top, the cursor role’s places below; Enter takes the place keys into them; c and C apply a preset from the list', async (t) => {
  const { busy } = await fixtures(t);
  const d = driver(busy, { data: busy.control }).at(page('control'));
  assert.match(d.state.projectCursor ?? '', /^project:role:imp$/);
  assert.match(rule(d), /^imp ─+ 3 places · preset: custom$/);
  const preset = d.run('role-preset');
  assert.deepEqual([preset.action.type, preset.action.role, preset.action.op], ['role-edit', 'imp', 'preset']);
  assert.equal(d.run('place-harness').action, undefined, 'a place key waits for a place');
  d.run('enter');
  assert.equal(d.state.splitFocus, 'preview');
  assert.equal(d.state.projectCursor, 'project:role:imp:0');
  d.run('down');
  const edit = d.run('place-harness');
  assert.deepEqual([edit.action.type, edit.action.role, edit.action.index, edit.action.op], ['role-edit', 'imp', 1, 'harness']);
  assert.equal(d.run('place-remove').action.op, 'remove');
  d.run('escape');
  assert.equal(d.state.splitFocus, undefined);
  assert.equal(d.state.projectCursor, 'project:role:imp');
});

test('Tickets, Working tree and Docs: a row each, the whole text or the checklist underneath; Enter opens the file', async (t) => {
  const { busy } = await fixtures(t);
  const tickets = driver(busy).at(page('tickets'));
  assert.match(rule(tickets), /^10 Vocabulary needs-triage +needs-triage$/);
  assert.equal(tickets.run('enter').action.type, 'open-files');
  const tree = driver(busy).at(page('tree')), docs = driver(busy).at(page('docs'));
  assert.match(rule(tree), /^branch ─+/);
  assert.equal(tree.pane('preview').rows.length > 0, true);
  assert.ok(docs.lines().length === 40);
});

test('a saved retired layout renders Classic, Split keeps its Home frame, and the 40-column Layout row offers only Classic and Split', async (t) => {
  const { busy } = await fixtures(t);
  const path = join(busy.hud, 'hud-settings.json');
  const env = { ...process.env, HUD_SETTINGS_PATH: path };
  const select = (panelLayout) => {
    fs.writeFileSync(path, JSON.stringify({ panelLayout, language: 'en', theme: 'none' }));
    return loadSettings(env);
  };
  const classic = select('inbox'), shown = select('split');
  assert.equal(classic.panelLayout, 'classic');
  const home = (settings) => plain(busy.render(40, 'en', 40, { ...initialMonitorState(), panelLayout: settings.panelLayout }));
  assert.deepEqual(home(classic), home(defaultSettings()));
  assert.deepEqual(home(shown), expected['home-busy-40-en']);
  const selected = SETTING_ROWS.findIndex((r) => r.key === 'panelLayout');
  assert.deepEqual(SETTING_ROWS[selected].values, ['classic', 'split']);
  for (const [draft, label] of [[classic, 'Classic'], [shown, 'Split']]) {
    const frame = withDisplaySettings(draft, () => renderSettingsPage({ draft, selected, offset: 0, message: '' }, 40, 24));
    const text = plain(frame).join('\n');
    assert.match(text, new RegExp(`Layout +‹ ${label} ›`));
    assert.match(text, /Classic is the\n┃ default; Split/);
    assert.doesNotMatch(text, /Inbox/);
  }
});

test('Classic is untouched: no layout set draws no preview pane, its Help has no Split rows, and the setting defaults to classic', async (t) => {
  const { busy } = await fixtures(t);
  assert.equal(defaultSettings().panelLayout, 'classic');
  const classic = busy.render(40, 'en', 40, initialMonitorState());
  assert.equal(classic.panes.some((p) => p.id === 'preview'), false);
  const help = (layout) => plain(busy.render(80, 'en', 40, { ...initialMonitorState(), help: true, panelLayout: layout })).join('\n');
  assert.doesNotMatch(help(undefined), /PgUp|Split/);
  assert.match(help('split'), /PgUp Dn.*scroll the preview/);
  // The pages Split leaves to Classic keep their frames: one waiting item's text, in either layout.
  const waiting = (layout) => plain(busy.render(40, 'en', 40, { ...initialMonitorState(), mainTab: 'project', projectPage: 'waiting', projectWait: 0, panelLayout: layout }));
  assert.deepEqual(waiting('split'), waiting(undefined));
});
