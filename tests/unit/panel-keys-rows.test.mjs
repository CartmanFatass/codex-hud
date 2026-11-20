/** PANEL-UX-02: one meaning per key, a row says its state once, 40-column rows keep the part that identifies them, the fixed words follow the panel language. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitFixture, split } from '../fixtures/split-layout.mjs';
import { NOW, TREE, plain, onPage } from '../fixtures/project-page.mjs';
import { handleMonitorInput, initialMonitorState } from '../../dist/render/monitor.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { defaultSettings } from '../../dist/settings.js';
import { renderSettingsPage, SETTING_ROWS } from '../../dist/render/settings-page.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
import { targetKey } from '../../dist/collectors/workboard-types.js';

const decode = (raw) => new WorkbenchInputDecoder('workboard').push(Buffer.from(raw));
async function fixtures(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'keys-rows-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { busy: await splitFixture(join(root, 'busy')), idle: await splitFixture(join(root, 'idle'), { idle: true }) };
}
/** One input against a frame, then the next frame from the state it left. */
function driver(f, { width = 40, height = 40, data = f.data, state = split(), board } = {}) {
  let frame = f.render(width, 'en', height, state, data, undefined, board ? { workboard: board } : {});
  const run = (input) => {
    const out = handleMonitorInput(frame.state, typeof input === 'string' ? { type: 'key', key: input } : input, { tree: TREE, frame, nowMs: NOW, standalone: true });
    frame = f.render(width, 'en', height, out.state, data);
    return out;
  };
  return { run, get frame() { return frame; }, get state() { return frame.state; }, lines: () => plain(frame) };
}

test('a printable key is one decoder name, and the Help page lists no key twice', async (t) => {
  // Lower case n flags, while the upper-case preset management keys act only on role rows.
  assert.deepEqual([...'n<>'].map((c) => decode(c)[0].key), ['try-flag', 'previous-trouble', 'next-trouble']);
  assert.deepEqual([...'NIRDgpPeE'].map((c) => decode(c)[0].key), ['preset-copy', 'preset-empty', 'preset-rename', 'preset-delete', '', 'preset-list', '', '', '']);
  assert.deepEqual(['i', '\x1b[3~', '+', '-', '='].map((c) => decode(c)[0].key), ['place-add', 'place-remove', 'list-grow', 'list-shrink', 'list-grow']);
  // `+` and `=` are one physical key and one meaning; no key besides them names the same action.
  const named = new Map();
  for (let c = 33; c < 127; c++) {
    const name = decode(String.fromCharCode(c))[0]?.key;
    if (name) named.set(name, [...(named.get(name) ?? []), String.fromCharCode(c)]);
  }
  for (const name of ['try-flag', 'next-trouble', 'previous-trouble', 'place-add', 'list-shrink']) assert.equal(named.get(name)?.length, 1, `${name} is on one key`);
  assert.deepEqual(named.get('list-grow'), ['+', '=']);
  // The Help page: every key it names is on one row, in either layout and language.
  const { busy } = await fixtures(t);
  for (const panelLayout of ['split', 'classic']) {
    const help = plain(busy.render(120, 'en', 60, { ...split({ panelLayout }), help: true }));
    const start = help.findIndex((l) => /^Keys ─/.test(l)), end = help.findIndex((l, i) => i > start && /^\s*$/.test(l));
    const tokens = help.slice(start + 1, end < 0 ? undefined : end).flatMap((l) => l.slice(0, 7).trim().split(/\s+/).filter(Boolean));
    assert.ok(tokens.length > 20, 'the key column was read');
    const twice = tokens.filter((tok, i) => tokens.indexOf(tok) !== i);
    assert.deepEqual(twice, [], `${panelLayout}: keys named on two Help rows`);
  }
});

test('n flags a to-try row and does nothing on Home; > and < are Home’s next and previous card that needs the owner', async (t) => {
  const { busy } = await fixtures(t);
  // Home (Split): `n` moves nothing; `>` goes to the next card that asks or stalled, `<` back.
  const home = driver(busy), start = home.state.splitCursor;
  const flag = home.run({ type: 'key', key: 'try-flag', text: 'n' });
  assert.equal(flag.action, undefined);
  assert.equal(home.state.splitCursor, start, 'n does not jump on Home');
  home.run({ type: 'key', key: 'next-trouble', text: '>' });
  assert.notEqual(home.state.splitCursor, start, '> moves to the next card that needs the owner');
  home.run({ type: 'key', key: 'previous-trouble', text: '<' });
  assert.equal(home.state.splitCursor, start, '< comes back');
  // The hub's to-try rows (Split): `n` flags, `>` and `<` do nothing.
  const hub = driver(busy, { data: busy.control, state: onPage(undefined, { panelLayout: 'split' }) });
  for (const input of [{ type: 'key', key: 'next-trouble', text: '>' }, { type: 'key', key: 'previous-trouble', text: '<' }]) {
    const out = hub.run(input);
    assert.equal(out.action, undefined);
  }
  assert.equal(hub.run({ type: 'key', key: 'try-flag', text: 'n' }).action?.action, 'flag');
});

test('the Control plane’s place keys are not the Split ratio’s: i and Delete add and remove, + - = leave the places alone', async (t) => {
  const { busy } = await fixtures(t);
  const d = driver(busy, { data: busy.control, state: split({ mainTab: 'control' }) });
  d.run('enter');
  assert.equal(d.state.controlChain.at, 0, 'the keys are on the places');
  const ratio = d.state.splitRatio;
  for (const key of ['list-grow', 'list-shrink']) {
    const out = d.run(key);
    assert.equal(out.action, undefined, `${key} edits no place`);
  }
  assert.equal(d.state.splitRatio, ratio, 'and in the preview the ratio keys leave the share alone');
  assert.equal(d.run('place-add').state.controlChain.sheet.field, 'target');
  d.run('escape');
  assert.equal(d.run('place-remove').state.controlChain.draft.run.length, 2);
});

test('g means one thing: a HUD job’s tab; the top of the list is the Home key', async (t) => {
  const { busy } = await fixtures(t);
  const d = driver(busy), at = d.state.splitCursor, key = (state, raw) => handleMonitorInput(state, decode(raw)[0], { tree: TREE, frame: d.frame, nowMs: NOW, standalone: true });
  // On a HUD job's row g opens its tab.
  assert.equal(key(d.state, 'g').action?.type, 'focus-job-tab');
  // Elsewhere it does nothing (it does not jump to the top, as it once did).
  while (d.state.splitCursor !== 'home-progress:waiting') d.run('down');
  const here = d.state.splitCursor, out = key(d.state, 'g');
  assert.equal(out.action, undefined);
  assert.equal(out.state.splitCursor, here);
  // The top of the list is the Home key.
  assert.equal(key(d.state, '\x1b[H').state.splitCursor, at, 'the Home key goes to the top');
});

test('the footer shows the keys the selected row accepts', async (t) => {
  const { busy } = await fixtures(t);
  const foot = (d) => d.lines().at(-1).trim();
  // Home: a HUD job row offers its tab and stop; the Waiting block offers neither.
  const home = driver(busy, { width: 80 });
  assert.match(foot(home), /⏎ open {2}g job tab {2}X stop {2}\? help/);
  while (home.state.splitCursor !== 'home-progress:waiting') home.run('down');
  assert.doesNotMatch(foot(home), /g job tab|X stop|o open|v inspect/);
  assert.match(foot(home), /⏎ open {2}\? help/);
  // The hub: the Progress row's to-try slices take Space, y and n; the other rows' pages do not.
  const hub = driver(busy, { width: 80, data: busy.control, state: onPage(undefined, { panelLayout: 'split' }) });
  assert.match(foot(hub), /Space mark {2}y accept {2}n flag/, 'the Progress row previews the to-try slices');
  hub.run('down');
  assert.doesNotMatch(foot(hub), /y accept|n flag|Space mark/, 'Tickets takes none of them');
  // The Control plane: a role takes presets, the Usage and Harnesses rows do not; a place takes its own keys.
  const control = driver(busy, { width: 120, data: busy.control, state: split({ mainTab: 'control' }) });
  assert.match(foot(control), /c C preset/);
  while (control.state.controlNav.projectCursor !== 'project:fold:usage') control.run('down');
  assert.doesNotMatch(foot(control), /c C preset|⏎ places/);
  const places = driver(busy, { width: 120, data: busy.control, state: split({ mainTab: 'control' }) });
  places.run('enter');
  assert.match(foot(places), /i add.*Del remove/);
  assert.doesNotMatch(foot(places), /\+ -/);
});

const STATE_WORDS = { en: ['asking', 'failed', 'done', 'stopped', 'stalled', 'report ready'], zh: ['提问中', '失败', '完成', '已停止', '停滞', '报告待阅'] };
/** The state words a row says more than once (a word as a whole, not inside a title). */
const repeated = (line, lang) => STATE_WORDS[lang].filter((word) => line.split(word).length > 2);
test('a row says its state once: Home’s lane rows, its cards and their model marks, in both layouts and languages', async (t) => {
  const { busy, idle } = await fixtures(t);
  // The finished job carries the model's outcome mark `done`, the same word as its state.
  const marked = (f) => {
    const workers = f.board.workers.map((w) => (w.state === 'done' || w.settledAt !== null ? { ...w, labels: { ...w.labels, outcome: { value: w.state === 'failed' ? 'failed' : 'done', confidence: 1 } } } : w));
    const lanes = f.board.lanes.map((l) => ({ ...l, workers: l.workers.map((w) => workers.find((x) => x.id === w.id) ?? w) }));
    return { ...f.board, lanes, workers: lanes.flatMap((l) => l.workers) };
  };
  for (const f of [busy, idle]) for (const lang of ['en', 'zh']) for (const width of [40, 56, 80]) for (const layout of ['split', 'classic']) {
    const state = { ...split(), panelLayout: layout }, board = marked(f);
    const frame = f.render(width, lang, 40, state, f.data, undefined, { workboard: board });
    for (const line of plain(frame)) assert.deepEqual(repeated(line, lang), [], `${layout} ${lang} ${width}: ${line}`);
    if (layout === 'classic') for (const line of plain(frame)) assert.doesNotMatch(line, /\[(done|failed|完成|失败)\] (done|failed|完成|失败)/);
  }
  // The lane that asks names its role in the middle, not its state again; a finished lane of several jobs counts them.
  const lines = plain(busy.render(40, 'en', 40, split(), busy.data));
  assert.match(lines.find((l) => /^\? NATIVE-TREE/.test(l)), /^\? NATIVE-TREE +imp +asking 0m$/);
  assert.match(plain(idle.render(40, 'en', 40, split(), idle.data)).find((l) => /^✓ NATIVE-TREE/.test(l)), /^✓ NATIVE-TREE +2 jobs +done \d+m$/);
});

test('at 40 columns the role row retains the next target without a placeholder tag; detail retains full place names', async (t) => {
  const { busy } = await fixtures(t);
  const control = { ...busy.control, radar: undefined };
  for (const lang of ['en', 'zh']) for (const panelLayout of ['split', 'classic']) {
    const state = split({ mainTab: 'control', panelLayout, controlNav: { projectCursor: 'project:role:imp', projectFolded: new Set(['agents', 'usage', 'files']) },
      ...(panelLayout === 'classic' ? { controlChain: { role: control.roles.find((r) => r.role === 'imp'), at: 0 } } : {}) });
    const frame = busy.render(40, lang, 60, state, control), text = plain(frame).join('\n');
    assert.match(text, /imp → agy/);
    assert.match(text, /pi\/openai +\[gpt-6\.1-sol ▾\]/);
    assert.match(text, /agy +\[gemini-4-hydrogen-high ▾\]/);
    assert.match(text, lang === 'en' ? /frontend → pi\/project +project/ : /frontend → pi\/project +项目/);
    for (const line of frame.lines) assert.equal(visualLength(line), 40);
  }
});

test('fixed words follow the panel language: the invalid role file’s reason, the Usage block with what is left, the Settings (no key) mark', async (t) => {
  const { busy } = await fixtures(t);
  const control = { ...busy.control, radar: { quotas: { codex: [{ label: '5h', remaining: 71 }], claude: [{ label: '7d', remaining: 7 }] }, roleStats: {} } };
  const zh = plain(busy.render(40, 'zh', 60, split({ mainTab: 'control' }), control)).join('\n');
  assert.match(zh, /JSON 无法解析/);
  assert.doesNotMatch(zh, /unparseable|雷达/);
  assert.match(zh, /用量 ─+ Codex 剩余 71%/, 'the figure says it is what is left');
  const en = plain(busy.render(80, 'en', 60, split({ mainTab: 'control' }), control)).join('\n');
  assert.match(en, /Usage ─+ codex 71% left · claude 7% left/);
  assert.match(en, /unparseable JSON/);
  // Settings: the mark on a Decision API without a key is the panel's language too.
  const row = SETTING_ROWS.findIndex((r) => r.key === 'decisionApi'), state = { draft: defaultSettings(), selected: row, offset: 0, message: '', decisionKeys: {} };
  for (const [lang, mark] of [['zh', '\\(无 key\\)'], ['en', '\\(no key\\)']]) {
    const previous = setLanguage(lang);
    try { assert.match(plain(renderSettingsPage(state, 60, 40)).join('\n'), new RegExp(mark), lang); } finally { setLanguage(previous); }
  }
});
