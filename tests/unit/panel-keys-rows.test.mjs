import { withState } from '../fixtures/state-helpers.mjs';
import { homeTarget } from '../../dist/render/monitor-state.js';
/** PANEL-UX-02: one meaning per key, a row says its state once, 40-column rows keep the part that identifies them, the fixed words follow the panel language. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitFixture, split } from '../fixtures/split-layout.mjs';
import { NOW, TREE, plain, chainOverlay, onControl, onPage } from '../fixtures/project-page.mjs';
import { handleMonitorInput, initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { skillsRows } from '../../dist/render/skills-view.js';
import { defaultSettings } from '../../dist/settings.js';
import { defaultExpConfig } from '../../dist/exp-config.js';
import { renderSettingsPage, SETTING_ROWS } from '../../dist/render/settings-page.js';
import { visualLength, stripAnsi, truncateAnsi } from '../../dist/render/colors.js';

const decode = (raw) => {
  const decoder = new WorkbenchInputDecoder('workboard');
  return [...decoder.push(Buffer.from(raw)), ...decoder.flushEscape()];
};
let sharedRoot, busy, idle;
before(async () => {
  sharedRoot = fs.mkdtempSync(join(tmpdir(), 'keys-rows-'));
  busy = await splitFixture(join(sharedRoot, 'busy'));
  idle = await splitFixture(join(sharedRoot, 'idle'), { idle: true });
});
after(() => fs.rmSync(sharedRoot, { recursive: true, force: true }));
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

test('a printable key is one decoder name, and Help covers the decoder with each key once per section', async (t) => {
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
  // Walk the standalone decoder: ASCII (including control keys) and the terminal forms for navigation.
  const ascii = Array.from({ length: 128 }, (_, c) => String.fromCharCode(c));
  const terminals = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].flatMap((end) => [`\x1b[${end}`, `\x1bO${end}`]);
  const numbered = Array.from({ length: 24 }, (_, n) => `\x1b[${n}~`);
  const names = new Set([...ascii, ...terminals, ...numbered].flatMap((raw) => decode(raw).map(({ key }) => key)).filter(Boolean));
  const raw = {
    '↑': '\x1b[A', '↓': '\x1b[B', '←': '\x1b[D', '→': '\x1b[C',
    Tab: '\t', 'Shift+Tab': '\x1b[Z', Home: '\x1b[H', End: '\x1b[F', PgUp: '\x1b[5~', PgDn: '\x1b[6~',
    '⏎': '\r', Esc: '\x1b', Space: ' ', Del: '\x1b[3~', Backspace: '\x7f', '^R': '\x12',
  };
  const headings = { en: ['Everywhere', 'Home', 'Project', 'Control', 'Split'], zh: ['通用', '首页', '项目', '控制', '分栏'] };
  const display = setDisplayConfig({ theme: 'none', icons: 'unicode' });
  try {
    for (const panelLayout of ['split', 'classic']) for (const lang of ['en', 'zh']) {
      const prev = setLanguage(lang);
      try {
        const draw = (width) => renderMonitor({ tree: TREE, state: withState(initialMonitorState(), { prefs: { panelLayout }, help: {} }), width, height: 40, nowMs: NOW });
        const read = (width) => {
          const rows = draw(width).workboard.rows;
          const body = rows.slice(0, rows.findIndex((r) => /(?:Backup skills|备用技能) ─/.test(r.text)));
          // The extra cell is the space replacing the cropped right column; trim it with the padding.
          return body.map(({ text }) => (width < 80 ? text : truncateAnsi(text, (width - 4) / 2 + 1, ' ')).trimEnd());
        };
        const lines = read(40), marksAt = lines.findIndex((l) => /^(?:Marks|图例) ─/.test(l));
        assert.ok(marksAt > 0);
        const keys = lines.slice(0, marksAt), sections = new Map();
        let seen;
        for (const line of keys) {
          const heading = headings[lang].find((label) => line.startsWith(label + ' ─'));
          if (heading) { seen = new Set(); sections.set(heading, seen); continue; }
          if (!line || line.startsWith(' ')) continue;
          const label = line.match(/^(Shift\+Tab|Home End|Backspace|点击)(?= )/)?.[1] ?? line.slice(0, 7).trim();
          const tokens = label.split(/\s+/).flatMap((key) => key === '1-4' ? [...'1234'] : [key === 'Dn' ? 'PgDn' : key]);
          if (label === '↑ ↓ j k') tokens.push(...(line.match(/PgUp|PgDn/g) ?? []));
          for (const key of tokens) {
            assert.ok(!seen.has(key), `${panelLayout} ${lang}: ${key} repeated in ${[...sections.keys()].at(-1)}`);
            seen.add(key);
          }
        }
        assert.deepEqual([...sections.keys()], headings[lang].slice(0, panelLayout === 'split' ? 5 : 4));
        const covered = new Set([...sections.values()].flatMap((keys) => [...keys]).flatMap((key) => decode(raw[key] ?? key).map((event) => event.key)));
        const expected = panelLayout === 'split' ? [...names] : [...names].filter((key) => !['list-grow', 'list-shrink'].includes(key));
        assert.deepEqual(expected.filter((key) => !covered.has(key)), [], `${panelLayout} ${lang}: decoder keys missing in Help`);
        // At 40 columns the columns fit, and wrapping retains the same words as the wide left column.
        const text = (rows) => rows.join('').replace(/[─\s]/gu, '');
        assert.equal(text(keys), text(read(120)), `${panelLayout} ${lang}: no lost or clipped descriptions`);
        for (const { text } of draw(40).workboard.rows) assert.ok(visualLength(text) <= 40, text);
        assert.doesNotMatch(lines.join('\n'), /…|┃/);
      } finally { setLanguage(prev); }
    }
  } finally { setDisplayConfig(display); }
});

test('Help opens at the source tab, scrolls back to Everywhere, and leaves the skills rows intact', () => {
  const display = setDisplayConfig({ theme: 'none', icons: 'unicode' });
  try {
    for (const panelLayout of ['classic', 'split']) for (const width of [40, 120]) for (const height of [24, 160]) {
      for (const [lang, titles] of [['en', ['Everywhere', 'Project', 'Control', 'Everywhere']], ['zh', ['通用', '项目', '控制', '通用']]]) {
        const previous = setLanguage(lang);
        try {
          for (const [i, mainTab] of ['home', 'project', 'control', 'exp'].entries()) {
            const backupSkills = [{ name: 'synthetic', en: 'A short test description.', zh: '用于测试的说明。' }];
            const draw = (state) => renderMonitor({ tree: TREE, width, height, state, nowMs: NOW, backupSkills });
            const press = (frame, raw) => handleMonitorInput(frame.state, decode(raw)[0], { tree: TREE, frame, nowMs: NOW }).state;
            const from = draw(withState(initialMonitorState(), { activeTab: mainTab, prefs: { panelLayout, experiments: true } }));
            const help = draw(press(from, '?'));
            assert.equal(help.state.activeTab, mainTab);
            const anchored = i === 1 || i === 2;
            assert.match(help.lines[anchored ? 1 : 2], new RegExp(`^${titles[i]} ─`));
            if (!anchored) assert.equal(help.lines[1].trim(), '');
            const skills = skillsRows(backupSkills, width);
            assert.deepEqual(help.workboard.rows.slice(-skills.length), skills);
            const top = draw(press(help, '\x1b[H'));
            assert.match(top.lines[2], new RegExp(`^${titles[0]} ─`));
            for (const key of ['\x1b', '?', '\r']) {
              const closed = press(help, key);
              assert.equal(!!closed.help, false);
              assert.equal(closed.activeTab, mainTab);
            }
          }
        } finally { setLanguage(previous); }
      }
    }
  } finally { setDisplayConfig(display); }
});

test('Help scrolls over a Control draft and closes back to the same place without a write or discard', () => {
  for (const panelLayout of ['classic', 'split']) {
    const state = onControl({ cursor: 'project:role:imp' }, { prefs: { panelLayout } });
    const d = driver(busy, { state, data: busy.control, height: 24 });
    const press = (raw) => d.run(decode(raw)[0]);
    press('N');
    assert.equal(press('?').state.overlay.sheet.text, '?');
    assert.equal(!!d.state.help, false);
    press('\x1b');
    press('\r');
    press('J');
    const { overlay: chain, control: { roles } } = d.state;
    const original = d.lines();
    assert.ok(chain.draft);
    assert.equal(chain.at, 1);
    assert.match(original.at(-1), /\? help$/);

    for (const back of ['\x1b', '?', '\r']) {
      const opened = press('?');
      assert.equal(opened.action, undefined);
      assert.equal(!!d.state.help, true);
      assert.equal(d.state.overlay.mode.kind, 'places');
      assert.match(d.lines()[1], /^Control ─/);
      press('\x1b[H');
      assert.match(d.lines()[2], /^Everywhere ─/);
      assert.equal(d.state.overlay.at, chain.at);
      const returned = press(back);
      assert.equal(returned.action, undefined);
      assert.equal(!!d.state.help, false);
      assert.deepEqual(d.state.overlay, chain);
      assert.deepEqual(d.state.control.roles, roles);
      assert.deepEqual(d.lines(), original);
    }

    press('i');
    press('\r');
    assert.equal(press('?').state.overlay.mode.input.text, '?');
    assert.equal(!!d.state.help, false);
    press('\x1b');
    press('\x1b');
    for (const [raw, key] of [['\t', 'tab'], [']', 'project-next'], ['q', 'close']]) {
      if (key === 'close') press('?');
      const leaving = press(raw);
      assert.equal(leaving.close, false);
      assert.equal(leaving.action, undefined);
      assert.equal(leaving.state.overlay.mode.kind, 'confirm-leave');
      assert.equal(leaving.state.overlay.mode.leave.key, key);
      assert.match(d.lines().join('\n'), /Discard edits\?/);
      press('\x1b');
    }
  }
});

test('top row names each tab once and shows a model-text switch only when off and it fits', () => {
  for (const [lang, tabs, off] of [['en', 'Home Project Control', 'models off'], ['zh', '首页 项目 控制', '模型 关']]) {
    const previous = setLanguage(lang);
    try {
      for (const panelLayout of ['classic', 'split']) for (const experiments of [false, true]) for (const width of [40, 80, 120]) {
        const state = withState(initialMonitorState(), { prefs: { panelLayout, experiments } });
        for (const modelEnabled of [true, false]) {
          const frame = renderMonitor({ tree: TREE, state, modelEnabled, width, height: 16, nowMs: NOW });
          assert.equal(visualLength(frame.lines[0]), width);
          assert.equal(stripAnsi(frame.lines[0]).trim().replace(/ +/g, ' '),
            tabs + (experiments ? ' EXP' : '') + (modelEnabled ? '' : ` ${off}`));
          const ctx = { tree: TREE, frame, nowMs: NOW };
          const press = (raw) => handleMonitorInput(frame.state, decode(raw)[0], ctx);
          assert.equal(press('b').action?.type, 'brief-toggle');
          assert.equal(press(',').action?.type, 'settings');
          assert.deepEqual(press('S').state, frame.state);
          const hint = frame.controls.find((c) => c.kind === 'brief');
          assert.equal(hint?.x, modelEnabled ? undefined : width - visualLength(off));
          const click = handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: width - 1, y: 0 }, ctx);
          assert.equal(click.action?.type, modelEnabled ? undefined : 'brief-toggle');
        }
      }
    } finally { setLanguage(previous); }
  }
  const narrow = renderMonitor({ tree: TREE, state: withState(initialMonitorState(), { prefs: { experiments: true } }),
    modelEnabled: false, projectWaiting: 2, width: 40, height: 16, nowMs: NOW });
  assert.equal(stripAnsi(narrow.lines[0]).trim(), 'Home  Project ?2  Control  EXP');
  assert.equal(narrow.controls.some((c) => c.kind === 'brief'), false);
});

test('Esc at every tab root leaves the cursor and tab unchanged; q closes the panel', () => {
  const expData = { config: defaultExpConfig(), profiles: [] };
  for (const panelLayout of ['classic', 'split']) for (const mainTab of ['home', 'project', 'control', 'exp']) {
    const render = (state) => busy.render(40, 'en', 40, state, busy.control, { expData });
    const press = (frame, raw) => handleMonitorInput(frame.state, decode(raw)[0], { tree: TREE, frame, nowMs: NOW, standalone: true });
    const root = render(withState(initialMonitorState(), { activeTab: mainTab, prefs: { panelLayout, experiments: true } }));
    const moved = render(press(root, '\x1b[B').state);
    const cursor = ({ home: panelLayout === 'split' ? (s) => s.home.split.listCursor : (s) => homeTarget(s.home),
      project: (s) => s.project.nav.cursor, control: (s) => s.control.roles.nav.cursor, exp: (s) => s.exp.cursor })[mainTab];
    assert.ok(cursor(moved.state), `${panelLayout} ${mainTab} has a cursor`);
    assert.notDeepEqual(cursor(moved.state), cursor(root.state), `${panelLayout} ${mainTab} moved off its first row`);
    const escaped = press(moved, '\x1b');
    assert.equal(escaped.close, false);
    assert.equal(escaped.action, undefined);
    assert.deepEqual(escaped.state, moved.state, `${panelLayout} ${mainTab} root is unchanged`);
    assert.equal(press(moved, 'q').close, true);
  }
});

test('n flags a to-try row and does nothing on Home; > and < are Home’s next and previous card that needs the owner', () => {
  // Home (Split): `n` moves nothing; `>` goes to the next card that asks or stalled, `<` back.
  const home = driver(busy), start = home.state.home.split.listCursor;
  const flag = home.run({ type: 'key', key: 'try-flag', text: 'n' });
  assert.equal(flag.action, undefined);
  assert.equal(home.state.home.split.listCursor, start, 'n does not jump on Home');
  home.run({ type: 'key', key: 'next-trouble', text: '>' });
  assert.notEqual(home.state.home.split.listCursor, start, '> moves to the next card that needs the owner');
  home.run({ type: 'key', key: 'previous-trouble', text: '<' });
  assert.equal(home.state.home.split.listCursor, start, '< comes back');
  // The hub's to-try rows (Split): `n` flags, `>` and `<` do nothing.
  const hub = driver(busy, { data: busy.control, state: onPage(undefined, { prefs: { panelLayout: 'split' } }) });
  for (const input of [{ type: 'key', key: 'next-trouble', text: '>' }, { type: 'key', key: 'previous-trouble', text: '<' }]) {
    const out = hub.run(input);
    assert.equal(out.action, undefined);
  }
  assert.equal(hub.run({ type: 'key', key: 'try-flag', text: 'n' }).action?.action, 'flag');
});

const STATE_WORDS = { en: ['asking', 'failed', 'done', 'stopped', 'stalled', 'report ready'], zh: ['提问中', '失败', '完成', '已停止', '停滞', '报告待阅'] };
/** The state words a row says more than once (a word as a whole, not inside a title). */
const repeated = (line, lang) => STATE_WORDS[lang].filter((word) => line.split(word).length > 2);
test('a row says its state once: Home’s lane rows, its cards and their model marks, in both layouts and languages', () => {
  // The finished job carries the model's outcome mark `done`, the same word as its state.
  const marked = (f) => {
    const workers = f.board.workers.map((w) => (w.state === 'done' || w.settledAt !== null ? { ...w, labels: { ...w.labels, outcome: { value: w.state === 'failed' ? 'failed' : 'done', confidence: 1 } } } : w));
    const lanes = f.board.lanes.map((l) => ({ ...l, workers: l.workers.map((w) => workers.find((x) => x.id === w.id) ?? w) }));
    return { ...f.board, lanes, workers: lanes.flatMap((l) => l.workers) };
  };
  for (const f of [busy, idle]) for (const lang of ['en', 'zh']) for (const width of [40, 56, 80]) for (const layout of ['split', 'classic']) {
    const state = withState(split(), { prefs: { panelLayout: layout } }), board = marked(f);
    const frame = f.render(width, lang, 40, state, f.data, undefined, { workboard: board });
    for (const line of plain(frame)) assert.deepEqual(repeated(line, lang), [], `${layout} ${lang} ${width}: ${line}`);
    if (layout === 'classic') for (const line of plain(frame)) assert.doesNotMatch(line, /\[(done|failed|完成|失败)\] (done|failed|完成|失败)/);
  }
  // The lane that asks carries its role icon, not its state again; a finished lane shows its job cleanly.
  const lines = plain(busy.render(40, 'en', 40, split(), busy.data));
  assert.match(lines.find((l) => /^\? NATIVE-TREE/.test(l)), /^\? NATIVE-TREE +⚒ asking 0m$/);
  const idleDone = plain(idle.render(40, 'en', 40, split({ prefs: { cardHideMinutes: 15 } }), idle.data)).find((l) => /^✓●? NATIVE-TREE/.test(l));
  assert.match(idleDone, /^✓●? NATIVE-TREE +2 jobs +\S+ \d+m$/);
});

test('at 40 columns the role row retains the next target without a placeholder tag; detail retains full place names', () => {
  const control = { ...busy.control, radar: undefined };
  for (const lang of ['en', 'zh']) for (const panelLayout of ['split', 'classic']) {
    const state = split(withState({ activeTab: 'control', prefs: { panelLayout }, control: onControl({ cursor: 'project:role:imp', folded: new Set(['agents', 'usage', 'files']) }).control }, (panelLayout === 'classic' ? { overlay: chainOverlay(control.roles.find((r) => r.role === 'imp')) } : {})));
    const frame = busy.render(40, lang, 60, state, control), text = plain(frame).join('\n');
    assert.match(text, /imp → agy/);
    assert.match(text, /pi\/openai +\[gpt-6\.1-sol ▾\]/);
    assert.match(text, /agy +\[gemini-4-hydrogen-high ▾\]/);
    assert.match(text, lang === 'en' ? /frontend → pi\/project +project/ : /frontend → pi\/project +项目/);
    for (const line of frame.lines) assert.equal(visualLength(line), 40);
  }
});

test('fixed words follow the panel language: the invalid role file’s reason, the Usage block with what is left, the Settings (no key) mark', () => {
  const control = { ...busy.control, radar: { quotas: { codex: [{ label: '5h', remaining: 71 }], claude: [{ label: '7d', remaining: 7 }] }, roleStats: {} } };
  const zh = plain(busy.render(40, 'zh', 60, split({ activeTab: 'control' }), control)).join('\n');
  assert.match(zh, /JSON 无法解析/);
  assert.doesNotMatch(zh, /unparseable|雷达/);
  assert.match(zh, /用量 ─+ Codex 剩余 71%/, 'the figure says it is what is left');
  const en = plain(busy.render(80, 'en', 60, split({ activeTab: 'control' }), control)).join('\n');
  assert.match(en, /Usage ─+ codex 71% left · claude 7% left/);
  assert.match(en, /unparseable JSON/);
  // Settings: the mark on a Decision API without a key is the panel's language too.
  const row = SETTING_ROWS.findIndex((r) => r.key === 'decisionApi'), state = { draft: defaultSettings(), selected: row, offset: 0, message: '', decisionKeys: {} };
  for (const [lang, mark] of [['zh', '\\(无 key\\)'], ['en', '\\(no key\\)']]) {
    const previous = setLanguage(lang);
    try { assert.match(plain(renderSettingsPage(state, 60, 40)).join('\n'), new RegExp(mark), lang); } finally { setLanguage(previous); }
  }
});
