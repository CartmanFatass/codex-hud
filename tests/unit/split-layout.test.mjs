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
import { targetKey } from '../../dist/collectors/workboard-types.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { readPanelPlace } from '../../dist/utils/panel-reload.js';

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
  // The list gave its rows to the preview (it is compact there), so the card is higher now: a second click lands on it.
  const moved = d.pane('preview'), again = moved.y + moved.rows.findIndex((r) => stripAnsi(r.text).startsWith('✓ reviewer'));
  assert.ok(again < card);
  d.run({ type: 'mouse', x: 4, y: again, button: 'left' });
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

test('Project list rows use the same Enter path for two clicks and the keyboard', async (t) => {
  const { busy } = await fixtures(t);
  for (const [p, item, sub] of [[undefined, 'project:fold:waiting', 'project:wait:0'], ['control', 'project:role:imp', 'project:role:imp:0']]) {
    const d = driver(busy, { data: busy.control, height: 24 });
    const state = page(p, { projectCursor: p ? 'split:files' : undefined });
    d.at(state);
    const click = (id) => {
      const pane = d.pane('agents');
      d.run({ type: 'mouse', x: 4, y: pane.y + pane.rows.findIndex((r) => r.item === id) - pane.offset, button: 'left' });
    };
    click(item);
    assert.equal(d.state.projectCursor, item);
    assert.equal(d.state.splitFocus, undefined);
    click(item);
    assert.equal(d.state.splitFocus, 'preview');
    assert.equal(d.state.projectCursor, sub);
    const mouse = d.lines();
    d.at(page(p, { projectCursor: item }));
    d.run('enter');
    assert.deepEqual(d.lines(), mouse);
  }
});

test('Split Progress lets the owner select an older to-try slice and read its brief without changing layouts', async (t) => {
  const { busy } = await fixtures(t);
  const data = { ...busy.rich, ledger: busy.rich.ledger.map((r) => r.id === 'WATCH-LINK'
    ? { ...r, brief: { brief: 'Job rows remain visible.', steps: ['Open the synthetic project.'] } } : r) };
  const d = driver(busy, { data, height: 24 }).at(page(undefined));
  d.run('enter');
  for (let n = 0; n < 5; n++) d.run('down');
  assert.equal(d.state.projectCursor, 'project:slice:WATCH-LINK');
  assert.match(rule(d), /^WATCH-LINK ─+ to try · M4$/);
  assert.match(d.lines().join('\n'), /Job rows remain visible\.\n +1\. Open the synthetic project\.\n +the watcher survives a link loop/);
  assert.deepEqual(d.run('try-accept').action.target.slices.map((r) => r.id), ['WATCH-LINK']);
});

test('Split hub reveals an off-screen first pending slice before y/n can record it', async (t) => {
  const { busy } = await fixtures(t);
  for (const [height, key, action] of [[24, 'try-accept', 'accept'], [12, 'next-trouble', 'flag']]) {
    const d = driver(busy, { data: busy.control, height }).at(page(undefined));
    if (height === 24) d.run('page-down');
    assert.equal(d.state.projectCursor, 'project:page:progress');
    assert.doesNotMatch(d.lines().join('\n'), /◇ DATA-ONE/);
    assert.equal(d.run(key).action, undefined, 'the first press only reveals the target');
    assert.equal(d.state.splitFocus, 'preview');
    assert.match(d.lines().join('\n'), /◇ DATA-ONE/);
    const out = d.run(key).action;
    assert.deepEqual([out.type, out.action, out.target.slices[0].id], ['record-try', action, 'DATA-ONE']);
  }
});

test('Split Progress ignores Classic’s t shortcut, leaving the marked batch and cursor in place', async (t) => {
  const { busy } = await fixtures(t);
  const d = driver(busy, { data: busy.rich, height: 24 }).at(page('progress', { projectCursor: 'project:slice:DATA-ONE' }));
  d.run('space');
  d.run('down');
  d.run('space');
  const before = d.lines();
  assert.match(before.join('\n'), /▣ ◇ DATA-ONE/);
  assert.match(before.join('\n'), /▣ ◇ NATIVE-ROWS/);
  d.run({ type: 'key', key: 'settings-test', text: 't' });
  assert.equal(d.state.projectTry, undefined);
  assert.deepEqual(d.lines(), before);
  assert.deepEqual(d.run('try-accept').action.target.slices.map((r) => r.id), ['DATA-ONE', 'NATIVE-ROWS']);
  assert.equal(d.run('escape').state.projectPage, undefined);
});

test('Progress page: one ledger list, the cursor slice explained underneath; y and n work on any to-try row; Enter opens STATE.md; History is one folded row', async (t) => {
  const { busy } = await fixtures(t);
  const d = driver(busy, { data: busy.rich }).at(page('progress'));
  const list = d.pane('agents').rows.map((r) => stripAnsi(r.text));
  assert.deepEqual(list.slice(2, 10).map((l) => l.split(' ')[1]), ['PAGE-ONE', 'PAGE-TWO', 'DATA-ONE', 'NATIVE-ROWS', 'SENTENCE-CUT', 'WATCH-LINK', 'NO-HASH', 'LATER-ONE']);
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

/** The first lane named `label` says `sentence` about its job, as the model would. */
const sentence = (board, label, text) => {
  const lanes = board.lanes.map((l) => (l.label === label ? { ...l, workers: l.workers.map((w) => ({ ...w, modelSentence: text })) } : l));
  return { ...board, lanes, workers: lanes.flatMap((l) => l.workers) };
};
const agentsRows = (frame) => frame.panes.find((p) => p.id === 'agents').rows.map((r) => stripAnsi(r.text));
const lastCells = (d) => { const p = d.pane('preview'); return d.lines().slice(p.y, p.y + p.height).map((l) => [...l].at(-1)); };
const keysOf = (text) => new WorkbenchInputDecoder('workboard').push(Buffer.from(text));

test('Split V2 input: = + - and a drag of the rule are named by the decoder; the drag is only a motion with the left button held', () => {
  assert.deepEqual(keysOf('=+-'), [{ type: 'key', key: 'list-grow', text: '=' }, { type: 'key', key: 'place-add', text: '+' }, { type: 'key', key: 'place-remove', text: '-' }]);
  assert.deepEqual(keysOf('\x1b[<0;5;7M\x1b[<32;5;4M\x1b[<35;5;4M\x1b[<0;5;4m'), [{ type: 'mouse', button: 'left', x: 4, y: 6 }, { type: 'drag', x: 4, y: 3 }]);
});

test('Home: a working lane the cursor is not on shows its model keywords in the row’s free cells, only when the width allows', async (t) => {
  const { busy } = await fixtures(t);
  const board = sentence(busy.board, 'M4-PROJECT', '«parser» rewrite, «+tests» green, «-lint» red');
  const row = (frame) => agentsRows(frame).find((l) => /^◉ M4-PRO/.test(l));
  const at = (width, lang = 'en', state = split()) => busy.render(width, lang, 40, state, undefined, { workboard: board });
  assert.match(row(at(80)), /^◉ M4-PROJECT +build parser tests lint +imp 20m$/);
  assert.match(row(at(40)), /^◉ M4-PROJECT +build parser +imp 20m$/, 'only the keywords that fit');
  assert.doesNotMatch(row(at(26)), /parser/, 'no room, no cue');
  assert.equal(row(busy.render(80, 'en', 40)).includes('parser'), false, 'without a model sentence there is nothing to show');
  // The row under the cursor is previewed below, so it keeps the plain row.
  const lane = board.lanes.find((l) => l.label === 'M4-PROJECT');
  assert.doesNotMatch(row(at(80, 'en', split({ splitCursor: targetKey({ kind: 'lane', laneId: lane.id }) }))), /parser/);
  for (const lang of ['en', 'zh']) for (const width of [20, 26, 40, 52, 80, 120]) for (const line of at(width, lang).lines) assert.equal(visualLength(line), width, `${lang} ${width}`);
});

test('Split ratio: = and + grow the list, - grows the preview, a drag of the rule follows the pointer, and the share survives a reload', async (t) => {
  const { busy } = await fixtures(t);
  const d = driver(busy, { height: 24 });
  const rows = () => [d.pane('agents').height, d.pane('preview').height];
  const [list, preview] = rows();
  assert.equal(d.state.splitRatio, undefined, 'unset, the list is as tall as it needs');
  d.run('place-remove');
  assert.deepEqual(rows(), [list - 1, preview + 1], '- grows the preview by a row');
  d.run('place-remove');
  assert.deepEqual(rows(), [list - 2, preview + 2]);
  d.run('list-grow');
  assert.deepEqual(rows(), [list - 1, preview + 1], '= grows the list');
  d.run('place-add');
  assert.deepEqual(rows(), [list, preview], '+ does too');
  // The share is kept across the panel's reload, which hands its state over as JSON.
  d.run('place-remove'); d.run('place-remove'); d.run('place-remove');
  const saved = d.state.splitRatio, held = process.env.HUD_PANEL_RELOAD_PLACE;
  process.env.HUD_PANEL_RELOAD_PLACE = JSON.stringify({ state: d.state, settings: null });
  const place = readPanelPlace();
  if (held === undefined) delete process.env.HUD_PANEL_RELOAD_PLACE; else process.env.HUD_PANEL_RELOAD_PLACE = held;
  assert.equal(place.state.splitRatio, saved);
  const reloaded = driver(busy, { height: 24 }).at({ ...place.state, splitDrag: undefined });
  assert.deepEqual([reloaded.pane('agents').height, reloaded.pane('preview').height], [list - 3, preview + 3]);
  // Dragging the rule: the press is on it, the motion moves it, the list never goes below a fifth of the rows or above what it needs.
  const rule = () => d.pane('preview').y - 1, total = list + preview;
  d.run({ type: 'mouse', x: 5, y: rule(), button: 'left' });
  assert.equal(d.state.splitDrag, true);
  d.run({ type: 'drag', x: 5, y: d.pane('agents').y + 4 });
  assert.deepEqual(rows(), [4, total - 4 + 0], 'the rule is under the fourth list row');
  d.run({ type: 'drag', x: 5, y: 2 });
  assert.equal(d.pane('agents').height, Math.round(total * 0.2), 'a fifth of the rows at least');
  d.run({ type: 'drag', x: 5, y: 23 });
  assert.equal(d.pane('agents').height, list, 'no taller than the list needs');
  d.run('down');
  assert.equal(d.state.splitDrag, undefined, 'any other input ends the drag');
  const before = d.state.splitRatio;
  d.run({ type: 'drag', x: 5, y: 6 });
  assert.equal(d.state.splitRatio, before, 'a motion that did not start on the rule moves nothing');
  // A press on a list row is a click as ever, not a drag.
  d.run({ type: 'mouse', x: 5, y: d.pane('agents').y + 2, button: 'left' });
  assert.equal(d.state.splitDrag, undefined);
  // Classic has no rule: the same inputs change nothing there.
  const classic = busy.render(40, 'en', 24, initialMonitorState());
  for (const input of ['list-grow', 'place-remove', { type: 'drag', x: 2, y: 5 }]) {
    const out = handleMonitorInput(classic.state, typeof input === 'string' ? { type: 'key', key: input } : input, { tree: TREE, frame: classic, nowMs: NOW, standalone: true });
    assert.equal(out.state.splitRatio, undefined);
  }
});

test('Split ratio keys leave the Control plane’s + and - to its places', async (t) => {
  const { busy } = await fixtures(t);
  const d = driver(busy, { data: busy.control }).at(page('control'));
  assert.equal(d.run('place-add').action, undefined, 'from the role list + is the ratio key: no place is under it');
  assert.ok(d.state.splitRatio);
  const before = d.state.splitRatio;
  d.run('enter');
  assert.equal(d.run('place-add').action.op, 'add', 'on a place it adds one');
  assert.equal(d.run('place-remove').action.op, 'remove');
  assert.equal(d.state.splitRatio, before);
});

test('Preview focus compacts the list to three rows around the cursor, and Esc restores the chosen share', async (t) => {
  const { busy } = await fixtures(t);
  const d = driver(busy);
  d.run('place-remove'); d.run('place-remove');
  const [list, preview] = [d.pane('agents').height, d.pane('preview').height];
  assert.ok(list > 3);
  for (let i = 0; i < 2; i++) d.run('down');
  const cursor = d.state.splitCursor;
  d.run('enter');
  assert.equal(d.state.splitFocus, 'preview');
  assert.equal(d.pane('agents').height, 3);
  assert.equal(d.pane('preview').height, list + preview - 3, 'the preview has every row the list gave up');
  assert.ok(d.pane('agents').rows.slice(d.pane('agents').offset, d.pane('agents').offset + 3).some((r) => r.item === cursor), 'the cursor row stays in view');
  assert.equal(d.state.splitCursor, cursor);
  // The ratio keys do nothing in the preview, so the share Esc restores is the chosen one.
  const ratio = d.state.splitRatio;
  d.run('place-remove');
  assert.equal(d.state.splitRatio, ratio);
  d.run('escape');
  assert.deepEqual([d.pane('agents').height, d.pane('preview').height], [list, preview]);
});

test('Preview scrollbar: a thumb over a dim track in the last cell of the scrolling preview, ascii # over |, no extra column', async (t) => {
  const { busy } = await fixtures(t);
  const d = driver(busy, { height: 19 });
  const room = d.pane('preview').height, total = d.pane('preview').contentLength;
  assert.ok(total > room, 'the question’s preview is longer than the room');
  const top = lastCells(d);
  assert.equal(top.length, room);
  assert.equal(top[0], '┃', 'at the top the thumb is at the top');
  assert.ok(top.every((c) => c === '┃' || c === '│'));
  assert.equal(top.includes('│'), true, 'there is track below it');
  for (let i = 0; i < 6; i++) d.run('page-down');
  const end = lastCells(d);
  assert.equal(end.at(-1), '┃', 'at the end the thumb is at the bottom');
  assert.equal(end[0], '│');
  // The thumb is as long as the share in view (rounded), and the rows keep exactly the panel width.
  assert.equal(end.filter((c) => c === '┃').length, Math.max(1, Math.round((room * room) / total)));
  for (const line of d.frame.lines) assert.equal(visualLength(line), 40);
  const text = busy.render(40, 'en', 19, undefined, undefined, { icons: 'text' }), p = text.panes.find((x) => x.id === 'preview');
  assert.deepEqual([...new Set(plain(text).slice(p.y, p.y + p.height).map((l) => [...l].at(-1)))].sort(), ['#', '|']);
  // A preview that fits has no bar, and nothing is cut from a row that fills the panel: the rows are laid out one cell narrower.
  const tall = driver(busy);
  assert.ok(tall.pane('preview').contentLength <= tall.pane('preview').height);
  assert.ok(lastCells(tall).every((c) => c !== '┃' && c !== '│'));
  const hub = driver(busy, { data: busy.control, height: 24 }).at(page(undefined));
  assert.ok(hub.lines().some((l) => /^  ◇ DATA-ONE +to try 1d[┃│]$/.test(l)), 'a right-aligned age keeps its unit beside the bar');
  assert.ok(hub.lines().some((l) => /^    ledger history, live jobs and +│$/.test(l)), 'a wrapped line is wrapped one cell narrower, not cut');
  const zh = busy.render(40, 'zh', 40, page('progress'), busy.rich);
  for (const line of zh.lines) assert.equal(visualLength(line), 40);
});
