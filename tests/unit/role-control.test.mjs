import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { projectFixture, pickerFrames, MAVERICK, plain, onPage, onControl, NOW, TREE, MODEL_LISTS, PROJECTS } from '../fixtures/project-page.mjs';
import { handleMonitorInput, initialMonitorState } from '../../dist/render/monitor.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { editPlaces, editPreset, placeItem } from '../../dist/roles/role-control.js';
import { build as controlSample } from '../../docs/design/control-tab/gen/frames.mjs';
import { finishChain } from '../../dist/render/chain-input.js';
import { setHarnessDisabled } from '../../dist/roles/harness-switches.js';
import { markExhausted, placeKey, roleRegistry, writeRolePlaces } from '../../dist/roles/roster.js';

function select(state, item) {
  return { ...state, controlChain: undefined, controlNav: { ...state.controlNav, projectCursor: item } };
}
function focus(s, name = 'imp', at = 0) {
  const role = s.session.snap.roles.find((r) => r.role === name);
  s.session.state = { ...select(s.session.state, `project:role:${name}`), controlChain: { role, at } };
}

/** The synthetic Project fixture with every CLI and browser tool but `codex` and `jev-flow` on PATH, and the shipped `imp`. */
async function setup(t, { shippedImp = true, healthyOpen = true } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'role-control-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await projectFixture(root);
  for (const name of ['herdr', 'agy', 'claude', 'grok', 'jev-aistudio'])
    fs.writeFileSync(join(root, 'bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  if (shippedImp) fs.rmSync(join(f.hud, 'roles/imp.json'));
  const session = { state: onControl(), snap: await f.collector.collect('control', f.board, NOW), done: null };
  if (healthyOpen) focus({ session });
  const decoder = new WorkbenchInputDecoder('workboard');
  const frame = (width = 80, lang = 'en', height = 64) => f.render(width, lang, session.state, height, session.snap);
  /** One key as the panel gets it: decoded, handled against the frame on screen, and a role edit applied as the panel does. */
  async function press(raw) {
    const view = frame();
    // A lone Escape is held until the panel's timer flushes it.
    const [input] = raw === '\x1b' ? (decoder.push(Buffer.from(raw)), decoder.flushEscape()) : decoder.push(Buffer.from(raw));
    const out = handleMonitorInput(view.state, input, { tree: TREE, frame: view, nowMs: NOW, standalone: true });
    session.state = out.state;
    session.done = null;
    if (out.action?.type === 'role-edit') {
      const { type: _type, ...edit } = out.action;
      session.done = editPlaces(f.hud, f.cwd, f.env, edit, NOW);
      f.collector.refreshRoles(session.snap, NOW);
    }
    if (out.action?.type === 'preset-edit') {
      session.done = editPreset(f.hud, f.cwd, f.env, out.action);
      if (session.done.ok && session.state.controlChain) session.state = finishChain(session.state);
      else if (!session.done.ok && session.state.controlChain) session.state.controlChain.error = session.done.message;
      f.collector.refreshRoles(session.snap, NOW);
    }
    return out;
  }
  /** Several keys in a row, a string of them typed or an array of raw keys (arrows and Enter are one key each). */
  async function keys(...raws) {
    for (const raw of raws.flatMap((r) => (typeof r === 'string' && !r.startsWith('\x1b') && r !== '\r' ? [...r] : [r]))) await press(raw);
  }
  const registry = () => roleRegistry(f.hud, f.cwd, f.env);
  const assignment = (name) => {
    const reg = registry();
    return reg.assignment(reg.roles().get(name), NOW);
  };
  const rows = (width = 80) => frame(width).workboard.rows.filter((r) => r.item?.startsWith('project:role:'));
  const text = (width = 80) => plain(frame(width)).join('\n');
  return { ...f, root, session, press, keys, frame, registry, assignment, rows, text };
}
const stored = (s, name) => JSON.parse(fs.readFileSync(join(s.hud, 'roles', `${name}.json`), 'utf8'));
const DOWN = '\x1b[B', ENTER = '\r', ESC = '\x1b', TAB = '\t', BACKSPACE = '\x7f', END = '\x1b[F', DEL = '\x1b[3~';
/** The model lists pi discovered (the cache the Control plane reads), synthetic ids shaped like the real ones. */
const discover = (s, pi = MODEL_LISTS.pi) => {
  s.put(join(s.hud, 'display/model-lists.json'), { version: 1, fetchedAt: NOW, pi });
  s.collector.refreshRoles(s.session.snap, NOW);
};

test('Control plane: what needs the owner first with the place the next job uses; healthy roles fold to names', async (t) => {
  const s = await setup(t, { healthyOpen: false });
  // reviewer gets a fallback; pro's first place is exhausted, so its next one is the one in use.
  writeRolePlaces(s.hud, 'reviewer', [{ harness: 'pi', pi_role: 'reviewer', split: false }, { harness: 'cli', agent: 'claude', model: 'opus', thinking: 'high' }]);
  markExhausted(s.hud, placeKey({ harness: 'bro', tool: 'jev-ask', provider: 'chatgpt', model: '6 Pro' }), 'quota exceeded', NOW);
  s.session.snap = await s.collector.collect(true, s.board, NOW);
  // Folded: a place at its limit (and where the next job goes), a role with nowhere to run, a role file that does not load; the rest are names.
  const lines = plain(s.frame(80, 'en', 64));
  const at = (re) => lines.findIndex((l) => re.test(l));
  assert.deepEqual([...new Set(s.rows().map((r) => r.item))], ['project:role:pro', 'project:role:flow']);
  assert.match(lines[at(/^Needs attention ─/)], / 3$/);
  assert.match(lines[at(/ pro /)], /^ {2}✗ pro \[Custom\] → gemini$/);
  assert.match(lines[at(/ pro /) + 1], /^ {6}chatgpt exhausted 60m$/);
  assert.match(lines[at(/ flow /)], /^ {2}− flow \[Custom\] → none$/);
  assert.match(lines[at(/bad\.json/)], /^ {2}! bad\.json +unparseable JSON$/);
  assert.match(lines[at(/^▸ Healthy ─/)], / 5$/);
  assert.match(lines[at(/^▸ Healthy ─/) + 1], /^ {2}◉ imp {2}reviewer {2}sonic {2}oracle {2}general$/);
  assert.ok(at(/^Needs attention ─/) < at(/^▸ Healthy ─/) && at(/^▸ Healthy ─/) < at(/^▸ Usage/));
  assert.doesNotMatch(lines.join('\n'), /synthetic\/model|^Harnesses ─/m);
  // One line a row at every width and language; at 40 columns a long model is cut in the middle, never the harness or the thinking.
  for (const lang of ['en', 'zh'])
    for (const width of [32, 40, 56, 80, 120])
      for (const state of [onControl(), onControl({ projectFolded: new Set(['agents']) })]) {
        s.session.state = state;
        const view = s.frame(width, lang, 64);
        for (const line of view.lines) assert.equal(visualLength(line), width, stripAnsi(line));
        for (const row of view.workboard.rows) assert.doesNotMatch(row.text, /\n/);
      }
  s.session.state = onControl();
  const narrow = plain(s.frame(40, 'zh', 64)).join('\n');
  assert.match(narrow, /^需要处理 ─+ 3$/m);
  assert.match(narrow, /^ {2}✗ pro \[自定义\] → gemini$/m);
  assert.match(narrow, /^ {6}chatgpt 已耗尽 60分钟$/m);
  assert.match(narrow, /^▸ 正常 ─+ 5$/m);
  s.session.state = select(s.session.state, 'project:fold:healthy');
  await s.press('\r');
  assert.deepEqual(s.rows().map((r) => r.item).filter((i) => !/role:(pro|flow)$/.test(i)), ['imp', 'reviewer', 'sonic', 'oracle', 'general'].map((x) => `project:role:${x}`));
  assert.match(s.text(), /^Healthy ─+ 5$/m);
  await s.press('\r');
  assert.match(s.text(), /^▸ Healthy ─+ 5$/m, 'Enter again folds them');
});
test('Control plane keeps the long model field usable when the role list scrolls', async (t) => {
  const s = await setup(t);
  const model = 'synthetic-provider/very-long-model-identifier-for-place-preview-20261117';
  const exhausted = { harness: 'cli', agent: 'claude', model, thinking: 'high' };
  writeRolePlaces(s.hud, 'reviewer', [exhausted, { harness: 'pi', pi_role: 'reviewer', split: false },
    { harness: 'cli', agent: 'agy', model: 'synthetic-fallback', thinking: 'low' }]);
  markExhausted(s.hud, placeKey(exhausted), 'quota exceeded', NOW);
  s.collector.refreshRoles(s.session.snap, NOW);
  const before = stored(s, 'reviewer');
  focus(s, 'reviewer');
  const draw = () => s.frame(40, 'en', 24);
  const choose = (frame, input) => {
    const out = handleMonitorInput(frame.state, input, { tree: TREE, frame, nowMs: NOW, standalone: true });
    assert.equal(out.action, undefined);
    s.session.state = out.state;
    return draw();
  };
  let frame = draw();
  assert.equal(frame.state.controlChain.at, 0);
  const lines = plain(frame), chain = lines.findIndex((line) => /^› +1 ✗/.test(line));
  assert.ok(chain > lines.findIndex((line) => /✗ reviewer/.test(line)));
  assert.match(lines.join('\n'), /source +yours · reviewer\.json/);
  const field = frame.controls.find((c) => c.item === placeItem('reviewer', 0) && c.kind === 'control-model');
  assert.equal(field.y, chain + 1, 'the long model field has its own row');
  assert.match(lines[field.y], /\[very-long.*….*preview ▾\]/);
  const picked = handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: field.x, y: field.y }, { tree: TREE, frame });
  assert.equal(picked.state.controlChain.sheet.field, 'model');
  assert.ok(picked.state.controlChain.sheet.choice, 'the CLI catalog opens inline');
  frame = choose(frame, { type: 'key', key: 'down' });
  assert.equal(frame.state.controlChain.at, 1);
  const y = plain(frame).findIndex((line) => /3 ○ agy/.test(line));
  assert.ok(y > 0);
  frame = choose(frame, { type: 'mouse', button: 'left', x: 4, y });
  assert.equal(frame.state.controlChain.at, 2);
  const zh = s.frame(38, 'zh', 24);
  assert.match(plain(zh).join('\n'), /^› +3 ○ agy +\[synthetic-fallback ▾\]/m);
  for (const line of zh.lines) assert.equal(visualLength(line), 38, stripAnsi(line));
  assert.deepEqual(stored(s, 'reviewer'), before);
});

test('Classic expands only the selected role’s numbered chain; o opens a role’s file without expanding', async (t) => {
  const s = await setup(t, { healthyOpen: false });
  await s.press(DOWN); // invalid file
  await s.press(DOWN); // Healthy
  await s.press(ENTER);
  await s.press(DOWN); // imp
  assert.match(s.text(), /imp \[default\] → pi\/synthetic/);
  assert.doesNotMatch(s.text(), /^› 1 ◉/m);
  assert.deepEqual((await s.press('o')).action, { type: 'open-files', files: [resolve('packages/hud-mcp/roles/imp.json')] });
  await s.press(ENTER);
  assert.match(s.text(), /^› 1 ◉ pi\/synthetic +\[default ▾\] +high$/m);
  assert.match(s.text(), /^ {2}2 ○/m);
  assert.match(s.text(), /source +default · imp\.json/);
  await s.press(ESC);
  assert.doesNotMatch(s.text(), /^› 1 ◉/m);
});
test('x clears a real quota mark immediately, but never from a draft index', async (t) => {
  const s = await setup(t);
  const first = { harness: 'cli', agent: 'agy', model: 'demo/cli' };
  writeRolePlaces(s.hud, 'imp', [first, { harness: 'pi', pi_role: 'implementer', model: 'demo/pi' }]);
  markExhausted(s.hud, placeKey(first), 'HTTP 429', NOW);
  s.collector.refreshRoles(s.session.snap, NOW);
  focus(s);
  const before = stored(s, 'imp');
  assert.equal(s.assignment('imp').runs_on.harness, 'pi');
  await s.keys('J', 'K', 'x');
  assert.equal(s.assignment('imp').exhausted.length, 1);
  await s.keys(ESC, ENTER, ENTER, 'x');
  assert.equal(s.assignment('imp').runs_on.agent, 'agy');
  assert.deepEqual(stored(s, 'imp'), before);
  assert.equal((await s.press('x')).action, undefined);
});

test('c/C select from the role row and keep its cursor when attention changes; marks stay per place', async (t) => {
  const s = await setup(t), item = 'project:role:imp';
  const raw = JSON.parse(fs.readFileSync(resolve('packages/hud-mcp/roles/imp.json'), 'utf8')).run;
  s.session.state = select(s.session.state, item);
  assert.match(s.text(), /imp \[default\]/);
  assert.match(plain(s.frame(120)).at(-1), /c C preset/);
  await s.press('c');
  assert.deepEqual(s.session.done, { ok: true, index: 0, preset: 'grok' });
  assert.equal(s.assignment('imp').preset, 'grok');
  assert.deepEqual(stored(s, 'imp').run, raw);
  assert.match(s.text(), /imp \[grok\]/);
  markExhausted(s.hud, 'pi:xai/grok-4.7', 'quota exceeded', NOW);
  await s.press('c');
  assert.match(s.text(), /imp \[hydrogen\]/);
  await s.press('C');
  assert.match(s.text(), /− imp \[grok\] → none/);
  assert.equal(s.assignment('imp').exhausted.length, 1);
  await s.press('C');
  assert.equal(s.frame().state.controlNav.projectCursor, item);
  assert.equal(s.assignment('imp').preset, 'default');
  assert.match(s.text(), /sonic \[Custom\]/);
  s.session.state = select(s.session.state, 'project:role:sonic');
  await s.press('c');
  assert.equal(fs.existsSync(join(s.hud, 'roles/sonic.json')), false, 'no presets writes nothing');
});

test('browser fields use the actual adapter: site/effort, AI Studio model/thinking, and Flow kind', async (t) => {
  const s = await setup(t);
  focus(s, 'pro');
  await s.press(ENTER);
  assert.match(s.text(), /target +chatgpt\n +Effort +6 Pro/);
  assert.doesNotMatch(s.text(), /thinking/);
  await s.keys(ENTER, 'aistudio', ENTER);
  assert.match(s.text(), /target +aistudio\n +model +gemini-4-argon\n +thinking +default/);
  assert.equal(s.assignment('pro').runs_on.provider, 'chatgpt');
  await s.keys(ESC, DOWN, 'Ks');
  assert.equal(s.assignment('pro').runs_on.provider, 'gemini');
  focus(s, 'flow');
  await s.press(ENTER);
  assert.match(s.text(), /Flow kind +image/);
  assert.doesNotMatch(s.text(), /thinking|Effort/);
  await s.keys(DOWN, ENTER, 'video', ENTER, END, ENTER, 's');
  assert.equal(stored(s, 'flow').run[0].kind, 'video');
});

const lines40 = (s, lang = 'en', height = 20) => plain(s.frame(40, lang, height));
test('pi picker chooses exact qualified IDs in one list, and hiding/restoring a provider never rewrites a role or filters the cache', async (t) => {
  const s = await setup(t);
  const config = join(s.hud, 'harnesses.json');
  const legacy = { catalog: { pi: { include: { openai: ['only-an-obsolete-pattern'] } } } };
  s.put(config, legacy);
  discover(s);
  const cacheFile = join(s.hud, 'display/model-lists.json'), cacheBefore = fs.readFileSync(cacheFile);
  await s.press('m');
  assert.equal(fs.existsSync(join(s.hud, 'roles/imp.json')), false, 'opening writes nothing');
  let page = lines40(s).join('\n');
  assert.match(page, /Model ─+ pi · list 0m old/);
  assert.match(page, /default → synthetic\/model\n +from pi role/);
  assert.match(page, /\? ctx {2}\? out {2}think \? {2}img \?/, 'legacy caches still populate the picker, without invented facts');
  assert.match(page, new RegExp(`/ ▌ +${MODEL_LISTS.pi.length}$`, 'm'));
  await s.keys('ANTH');
  page = lines40(s, 'en', 24).join('\n');
  assert.match(page, /\/ ANTH▌ +8 matches/);
  assert.match(page, /^▾ anthropic ─+ 7\n[\s\S]*^▾ arena ─+ 1/m);
  assert.match(page, /claude-opus-5-5-20261101/);
  assert.doesNotMatch(page, /openai/);
  await s.keys(ESC, 'XAI/GROK-4.7', ENTER);
  assert.equal(s.session.state.controlChain.sheet.place.raw.model, 'xai/grok-4.7');
  assert.ok(!fs.existsSync(join(s.hud, 'roles/imp.json')), 'filling a field writes nothing');
  await s.keys(END, ENTER, 's');
  assert.equal(s.session.done.ok, true);
  assert.equal(stored(s, 'imp').run[0].model, 'xai/grok-4.7');
  assert.equal(s.assignment('imp').model, 'xai/grok-4.7');
  assert.equal(s.session.state.projectInput, undefined);
  assert.equal(s.session.state.controlNav.projectCursor, 'project:role:imp');
  assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')), legacy);
  const roleFile = join(s.hud, 'roles/imp.json'), before = fs.readFileSync(roleFile);
  setHarnessDisabled(s.hud, 'pi:xai', true);
  s.collector.refreshRoles(s.session.snap, NOW);
  assert.equal(s.assignment('imp').places[0].state, 'off');
  focus(s);
  await s.keys('m', 'grok');
  page = lines40(s).join('\n');
  assert.match(page, /current  xai\/grok-4.7 +⊘/);
  assert.match(page, /\/ grok▌ +2 matches/);
  assert.doesNotMatch(page, /^▾ xai ─/m);
  assert.equal(s.registry().routing(NOW).byId.get('grok-4.7'), null, 'attribution still sees both providers');
  await s.keys(ESC, ESC, ESC);
  setHarnessDisabled(s.hud, 'pi:xai', false);
  s.collector.refreshRoles(s.session.snap, NOW);
  await s.keys('m', 'grok', DOWN, DOWN, DOWN);
  page = lines40(s).join('\n');
  assert.match(page, /\/ grok▌ +5 matches/);
  assert.match(page, /^▾ arena ─+ 2\n[\s\S]*^▾ xai ─+ 3\n  ◉ grok-4.7\n›   grok-4.7-fast/m);
  const closed = await s.press('\x03');
  assert.equal(closed.close, false);
  assert.equal(s.session.state.projectInput, undefined);
  assert.deepEqual(fs.readFileSync(roleFile), before);
  assert.deepEqual(fs.readFileSync(cacheFile), cacheBefore);
});
test('pi picker keeps no-match text, owns printable keys, and does not offer an off default', async (t) => {
  const s = await setup(t);
  const long = 'new-provider/' + 'a'.repeat(115);
  assert.equal(long.length, 128);
  discover(s, [...MODEL_LISTS.pi, long]);
  await s.keys('m', 'new-provider/aaa', TAB, ENTER, END, ENTER, 's');
  assert.equal(stored(s, 'imp').run[0].model, long, 'the full 128-character ID survives the edit');
  focus(s);
  await s.keys('m', 'custom/pi-next', ENTER);
  assert.match(lines40(s).join('\n'), /0 matches\n +No matching models/);
  assert.equal(s.session.state.projectInput.text, 'custom/pi-next');
  assert.equal(stored(s, 'imp').run[0].model, long);
  await s.press(BACKSPACE);
  assert.equal(s.session.state.projectInput.text, 'custom/pi-nex');
  await s.press(ESC);
  assert.equal(s.session.state.projectInput.text, '');
  assert.equal(s.session.state.projectInput.pick, undefined);
  assert.equal(stored(s, 'imp').run[0].model, long);
  await s.press(ESC);
  assert.equal(s.session.state.projectInput, undefined);
  assert.equal(stored(s, 'imp').run[0].model, long);
  await s.press(ESC); // Cancel the place form after leaving the picker.
  setHarnessDisabled(s.hud, 'pi:synthetic', true);
  s.collector.refreshRoles(s.session.snap, NOW);
  await s.keys('m', '\x1b[H');
  assert.doesNotMatch(lines40(s).join('\n'), /default →|from pi role/);
  await s.keys(ESC, ESC);
  setHarnessDisabled(s.hud, 'pi:synthetic', false);
  s.collector.refreshRoles(s.session.snap, NOW);
  await s.keys('m', END, ENTER, END, ENTER, 's');
  assert.equal(stored(s, 'imp').run[0].model, undefined);
  assert.equal(s.assignment('imp').model, 'synthetic/model');
  focus(s);
  await s.press('m');
  for (const raw of ['q', 'p', 'e', 'i', 'r', 'K', 'o', 'j']) {
    const out = await s.press(raw);
    assert.deepEqual([out.action, out.close], [undefined, false], raw);
  }
  assert.equal(s.session.state.projectInput.text, 'qpeirKoj');
  const view = s.frame();
  const tab = view.controls.find((c) => c.kind === 'board-project');
  const click = handleMonitorInput(view.state, { type: 'mouse', button: 'left', x: tab.x, y: tab.y }, { tree: TREE, frame: view, nowMs: NOW, standalone: true });
  assert.ok(click.state.projectInput, 'the model field owns input until it is cancelled');
  assert.equal(click.action, undefined);
});
test('CLI model and thinking fields list catalog entries inline and a miss leaves the place alone', async (t) => {
  const s = await setup(t);
  discover(s);
  writeRolePlaces(s.hud, 'imp', [{ harness: 'cli', agent: 'agy', model: 'gemini-4-argon-high' }]);
  s.collector.refreshRoles(s.session.snap, NOW);
  await s.press('m');
  const page = lines40(s).join('\n');
  assert.match(page, /model +\/ ▌ +4/);
  assert.match(page, /gemini-4-argon-high[\s\S]*gemini-4-hydrogen-high[\s\S]*gemini-3\.8-flash-high/);
  await s.keys('next-one', ENTER);
  assert.match(lines40(s).join('\n'), /No matching choices/);
  assert.equal(stored(s, 'imp').run[0].model, 'gemini-4-argon-high');
  await s.keys(ESC, ENTER, 'flash', ENTER, DOWN, ENTER, 'xhigh', ENTER, END, ENTER, 's');
  assert.equal(stored(s, 'imp').run[0].model, 'gemini-3.8-flash-high');
  assert.equal(stored(s, 'imp').run[0].thinking, 'xhigh');
  // Width and cursor invariants for both languages/layouts, with long Latin and wide queries.
  const inputs = ['', '探'.repeat(90), 'maverick', 'openai'];
  for (const pi of [false, true]) {
    if (pi) {
      writeRolePlaces(s.hud, 'imp', [{ harness: 'pi', pi_role: 'implementer', split: false, model: 'openai/gpt-6.1-sol' }]);
      s.collector.refreshRoles(s.session.snap, NOW);
      assert.equal(s.assignment('imp').harness, 'pi');
    }
    for (const text of inputs) for (const panelLayout of ['classic', 'split']) for (const lang of ['en', 'zh']) for (const width of [32, 40, 56, 80, 120]) {
      s.session.state = select(onControl(undefined, { panelLayout, projectInput: { role: 'imp', index: 0, text } }), placeItem('imp', 0));
      const view = s.frame(width, lang, 14);
      for (const line of view.lines) assert.equal(visualLength(line), width, stripAnsi(line));
      for (const row of view.workboard.rows) assert.doesNotMatch(row.text, /\n/);
      assert.equal(view.lines.length, 14);
      assert.equal(view.workboard.rows.filter((r) => r.item === 'project:pick').length <= 1, true);
    }
  }
  s.session.state = select(onControl(undefined, { projectInput: { role: 'imp', index: 0, text: 'openai' } }), placeItem('imp', 0));
  const zh = plain(s.frame(40, 'zh', 14));
  assert.match(zh.join('\n'), /^模型 ─+ pi · 列表 0分钟前$/m);
  assert.match(zh[0], /首页.*项目.*控制/);
  assert.match(zh.at(-1), /↑↓ 选择 +⏎ 设为 +esc 清除 +\^R 刷新/);
  assert.match(plain(s.frame(40, 'en', 14)).at(-1), /↑↓ pick +⏎ set +esc clear +\^R refresh/);
  assert.doesNotMatch(plain(s.frame(120, 'en', 14)).at(-1), /tab all|← back/);
  s.session.state = { ...initialMonitorState(), help: true };
  const help = plain(s.frame(80, 'en', 52)).join('\n').replace(/\n {8}/g, ' ');
  assert.doesNotMatch(help, /^p P |^e E /m);
  assert.match(help, /^p +role: filter and choose a preset/m);
  assert.match(help, /^m +place: open the model field/m);
  assert.match(help, /^r \^R +refresh: Control \/ picker/m);
  assert.match(help, /^Esc +back; confirm discarding a draft/m);
});
test('40-column picker preserves defaults, full IDs and capability strips in Classic and Split', async (t) => {
  const s = await setup(t);
  for (const layout of ['classic', 'split']) for (const lang of ['en', 'zh']) {
    const frames = pickerFrames(s, undefined, layout);
    const grouped = frames[`pick-grouped-40-${lang}`].join('\n');
    assert.match(grouped, /openai\/gpt-6.1-sol\n +(?:来自 pi 设置|from pi settings)/);
    assert.ok(grouped.indexOf('anthropic ─') < grouped.indexOf('arena ─'));
    const filtered = frames[`pick-filter-40-${lang}`].join('\n');
    assert.match(filtered, /\/ grok▌ +5 (?:个匹配|matches)/);
    assert.match(filtered, /▾ arena ─+ 2[\s\S]*▾ xai ─+ 3\n  ◉ grok-4.7\n›   grok-4.7-fast/);
    const long = frames[`pick-long-40-${lang}`];
    assert.match(long.join('\n'), /^› +meta-llama\/.*….*-fp8$/m);
    const detail = long.findIndex((row) => /^(Selected|所选) ─/.test(row));
    assert.equal(long.slice(detail + 1, -3).map((row) => row.trim()).join(''), `${MAVERICK}-fp8`);
    assert.match(long.at(-3), lang === 'en' ? /1M ctx {2}16K out {2}think – {2}img ✓/ : /1M 上下文 {2}16K 输出 {2}思考 – {2}图片 ✓/);
  }
});

test('pi picker paints live quota, off and unknown facts without offering off or unattributable IDs', async (t) => {
  const s = await setup(t);
  const model = (id) => ({ harness: 'pi', pi_role: 'implementer', split: false, model: id });
  const current = (id) => {
    writeRolePlaces(s.hud, 'imp', [model(id)]);
    s.collector.refreshRoles(s.session.snap, NOW);
  };
  const exhausted = 'openai/gpt-6.1-sol';
  setHarnessDisabled(s.hud, 'pi:deepseek', true);
  markExhausted(s.hud, placeKey(model(exhausted)), 'quota exceeded; retry in 42m', NOW);
  s.put(join(s.hud, 'display/model-lists.json'), { version: 1, fetchedAt: NOW, pi: [...MODEL_LISTS.pi, 'deepseek/deepseek-synthetic'],
    piFacts: { [exhausted]: ['272K', '128K', true, false], 'deepseek/deepseek-synthetic': ['1M', '96K', false, true] } });
  current('xai/grok-4.7');
  await s.keys('m', 'openai/gpt-6.1-sol');
  const refresh = await s.press('\x12');
  assert.deepEqual(refresh.action, { type: 'refresh-models' });
  assert.equal(s.session.state.projectInput.text, exhausted);
  let page = lines40(s).join('\n');
  assert.match(page, /^›   gpt-6.1-sol +✗ 42m$/m, 'a target not in the chain can be exhausted');
  assert.match(page, /Selected ─+\n +openai\/gpt-6.1-sol\n +272K ctx {2}128K out {2}think ✓ {2}img –\n +✗ exhausted · resets in 42m/);
  const exact = () => {
    for (const lang of ['en', 'zh']) for (const panelLayout of ['classic', 'split']) {
      const frame = s.render(40, lang, { ...s.session.state, panelLayout }, 16, s.session.snap, true, 'unicode', 'mocha');
      assert.equal(frame.lines.length, 16);
      assert.ok(frame.lines.every((line) => visualLength(line) === 40));
      assert.match(stripAnsi(frame.lines.at(-5)), /^(Selected|所选) ─/);
    }
  };
  exact();
  assert.match(lines40(s, 'en', 9).join('\n'), /✗ exhausted · resets in 42m/, 'a short pane gives the strip room before the list');
  const expired = plain(s.render(40, 'en', s.session.state, 20, s.session.snap, true, 'unicode', 'none', { nowMs: NOW + 42 * 60000 })).join('\n');
  assert.doesNotMatch(expired, /✗|resets in/);
  await s.keys(ENTER, END, ENTER, 's');
  assert.equal(stored(s, 'imp').run[0].model, exhausted, 'an exhausted target remains selectable');
  for (const [id, row, status] of [
    ['grok-4.7', /^› ◉ grok-4\.7 +\?$/m, /\n +\? unknown\n/],
    ['deepseek/deepseek-synthetic', /^› ◉ deepseek\/deepseek-synthetic +⊘$/m, /\n +⊘ off\n/],
  ]) {
    current(id);
    focus(s);
    await s.press('m');
    page = lines40(s).join('\n');
    assert.match(page, row);
    assert.match(page, status);
    assert.ok(page.split('\n').includes(`  ${id}`), 'the strip keeps the whole ID');
    if (id.startsWith('deepseek/')) assert.match(page, /1M ctx {2}96K out {2}think – {2}img ✓/);
    assert.equal(page.match(/^⊘ off, not listed: deepseek$/gm)?.length, 1);
    exact();
    const frame = s.frame(40, 'en', 20);
    assert.equal(frame.workboard.rows.find((r) => r.text.includes('not listed')).item, undefined);
    assert.equal((await s.press(ENTER)).action, undefined);
    assert.equal(stored(s, 'imp').run[0].model, id);
    assert.ok(s.session.state.projectInput, 'Enter on the read-only reference does not close');
    await s.press(ESC);
  }
});

test('pi picker distinguishes the aged last-good list, offline catalog, and an authoritative empty result', async (t) => {
  const s = await setup(t);
  const file = join(s.hud, 'display/model-lists.json');
  const collected = (payload) => {
    s.put(file, { version: 1, fetchedAt: NOW, ...payload });
    s.collector.refreshRoles(s.session.snap, NOW);
    return lines40(s).join('\n');
  };
  await s.press('m');
  assert.match(lines40(s).join('\n'), /Limited offline catalog/);
  setHarnessDisabled(s.hud, 'pi:openai', true);
  assert.doesNotMatch(collected({ status: { pi: { failed: true } } }), /openai ─/);
  const age = NOW - 2 * 3600000;
  const failed = collected({ pi: ['new-provider/new-model'], status: { pi: { failed: true, fetchedAt: age } } });
  assert.match(failed, /list 2h old\n +Refresh failed/);
  assert.match(failed, /new-provider ─+ 1/);
  assert.doesNotMatch(failed, /Limited offline catalog/);
  const empty = collected({ pi: [] });
  assert.match(empty, /\/ ▌ +0\n[\s\S]*No discovered models/);
  assert.doesNotMatch(empty, /Limited offline catalog|new-model|Refresh failed/);
});

test('an empty, stale or invalid run never writes half a chain, and a failed Save retains the draft', async (t) => {
  const s = await setup(t, { shippedImp: false });
  const file = join(s.hud, 'roles/imp.json'), original = fs.readFileSync(file, 'utf8');
  await s.keys(DEL, 's');
  assert.match(s.text(), /Not saved · needs a place to save/);
  assert.deepEqual(s.session.state.controlChain.draft.run, []);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  await s.keys(ESC, ENTER, 'Nnightly', ENTER);
  const revision = s.session.state.controlChain.role.revision;
  const invalid = editPreset(s.hud, s.cwd, s.env, { role: 'imp', revision, op: 'create', name: 'nightly', run: [
    { harness: 'pi', pi_role: 'implementer' }, { harness: 'cli', agent: 'not-a-supported-target' },
  ] });
  assert.match(invalid.reason, /bad cli fields/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), ownerChange: true }));
  const changed = fs.readFileSync(file, 'utf8'), inode = fs.statSync(file).ino;
  await s.press('s');
  assert.match(s.text(), /Role changed on disk; reopen the action/);
  assert.equal(s.session.state.controlChain.draft.name, 'nightly');
  assert.equal(s.session.state.controlChain.role.revision, revision);
  assert.equal(fs.readFileSync(file, 'utf8'), changed);
  assert.equal(fs.statSync(file).ino, inode);
  assert.deepEqual(fs.readdirSync(join(s.hud, 'roles')).sort(), ['bad.json', 'imp.json']);
});

test('a project role file in force is shown apart and never written past', async (t) => {
  const s = await setup(t);
  const root = fs.realpathSync(s.cwd);
  s.put(join(s.hud, 'projects.json'), { version: 1, projects: [{ root, registered_at: '2026-11-13T00:00:00.000Z' }] });
  const own = { role: 'frontend', harness: 'pi', pi_role: 'implementer', split: false, can_continue: true, model: 'project/model' };
  s.put(join(s.cwd, '.hud/roles/frontend.json'), own);
  s.put(join(s.cwd, '.hud/roles/imp.json'), { ...own, role: 'imp', model: 'project/imp' });
  s.put(join(s.cwd, '.hud/project.json'), { version: 1, roles: ['imp', 'frontend', 'reviewer', 'sonic'] });
  s.session.snap = await s.collector.collect(true, s.board, NOW + 1);
  const lines = plain(s.frame(80));
  assert.ok(lines.findIndex((l) => /frontend.*project$/.test(l)) > lines.findIndex((l) => / sonic /.test(l)));
  assert.match(s.text(), /◉ frontend \[Custom\] → pi\/project +project/);
  assert.match(s.text(), /◉ imp \[[^\]]+\] → pi\/project +project/);
  const before = fs.readFileSync(join(s.cwd, '.hud/roles/imp.json'), 'utf8');
  s.session.state = select(s.session.state, 'project:role:imp');
  for (const raw of ['c', 'C', 'p', 'N', 'I', 'R', 'D']) {
    assert.equal((await s.press(raw)).action, undefined, raw);
    assert.equal(s.session.state.controlPresetInput, undefined);
  }
  await s.press(ENTER);
  assert.match(s.text(), /pinned +project file · read-only here/);
  for (const raw of [ENTER, 'm', 'i', DEL, 'K', 's']) {
    assert.equal((await s.press(raw)).action, undefined, raw);
    assert.equal(s.session.state.controlChain.sheet, undefined);
  }
  // A mark is not in a role file: clearing one works on a project role too.
  markExhausted(s.hud, placeKey({ harness: 'pi', model: 'project/model' }), 'HTTP 429', NOW);
  s.session.snap = await s.collector.collect(true, s.board, NOW + 1);
  focus(s, 'frontend');
  assert.match(s.text(), /− frontend/);
  await s.press('x');
  assert.deepEqual(s.session.done, { ok: true, index: 0 });
  assert.match(s.text(), /◉ frontend/);
  assert.equal(fs.readFileSync(join(s.cwd, '.hud/roles/imp.json'), 'utf8'), before);
  assert.equal(fs.existsSync(join(s.hud, 'roles/imp.json')), false);
  assert.equal(fs.existsSync(join(s.hud, 'roles/frontend.json')), false);
  focus(s);
  assert.deepEqual((await s.press('o')).action, { type: 'open-files', files: [join(root, '.hud/roles/imp.json')] });
});

test('first edit of an older single-place file preserves instructions and advanced fields; replacing a target refuses file-only options', async (t) => {
  const s = await setup(t, { shippedImp: false });
  const file = join(s.hud, 'roles/imp.json');
  assert.equal(s.assignment('imp').instructions, 'implementer');
  await s.keys(ENTER, ENTER, 'agy', ENTER);
  assert.match(s.text(), /launch options are set in the file: o opens it/);
  assert.deepEqual((await s.press('o')).action, { type: 'open-files', files: [file] });
  assert.equal(stored(s, 'imp').run, undefined, 'a refused replacement writes nothing');
  await s.keys('m', 'openai/gpt-6.1-sol', ENTER, END, ENTER, 's');
  const written = stored(s, 'imp');
  assert.equal(written.instructions, 'implementer');
  assert.equal(written.harness, undefined);
  assert.deepEqual(written.run, [{ harness: 'pi', pi_role: 'implementer', split: true, model: 'openai/gpt-6.1-sol' }]);
  assert.equal(written.can_continue, true);
  const imp = s.assignment('imp');
  assert.deepEqual([imp.instructions, imp.split, imp.model, imp.thinking], ['implementer', true, 'openai/gpt-6.1-sol', 'high']);
  for (const extra of [{ skills: ['demo'] }, { pi_args: ['--synthetic'] }, { nested: { keep: true } }, { args: ['demo'] }]) {
    const raw = extra.args ? { harness: 'cli', agent: 'agy', ...extra } : { ...written.run[0], split: false, ...extra };
    s.put(file, { ...written, run: [raw] });
    s.collector.refreshRoles(s.session.snap, NOW);
    focus(s);
    await s.keys(ENTER, ENTER, extra.args ? 'pi' : 'agy', ENTER);
    assert.match(s.text(), /launch options are set in the file/);
    await s.keys('m', extra.args ? 'hydrogen' : 'openai/gpt-6-astra', ENTER, END, ENTER, 's');
    assert.deepEqual(stored(s, 'imp').run[0], { ...raw, model: extra.args ? 'gemini-4-hydrogen-high' : 'openai/gpt-6-astra' });
  }
});

test('Control plane keys: decoded names, only on a place row of the Control plane, Settings letters unchanged', async (t) => {
  const s = await setup(t);
  const decoder = new WorkbenchInputDecoder('workboard');
  const names = (raw) => decoder.push(Buffer.from(raw)).map((i) => i.key);
  assert.deepEqual([...'pPmMeEIiKJx', DEL].map((c) => names(c)[0]), ['preset-list', '', 'place-model', '', '', '', 'preset-empty',
    'place-add', 'place-up', 'place-down', 'place-clear', 'place-remove']);
  assert.deepEqual([...'srtjkq'].map((c) => names(c)[0]), ['settings-save', 'reset', 'settings-test', 'down', 'up', 'close']);
  // The panel's own keyboard also types: a printable key carries its character (named or not), and a control key has none.
  const decoded = (raw, profile = 'workboard') => new WorkbenchInputDecoder(profile).push(Buffer.from(raw));
  assert.deepEqual(decoded('m'), [{ type: 'key', key: 'place-model', text: 'm' }]);
  assert.deepEqual(decoded('Z'), [{ type: 'key', key: '', text: 'Z' }]);
  assert.deepEqual(decoded('é-'), [{ type: 'key', key: '', text: 'é' }, { type: 'key', key: 'list-shrink', text: '-' }]);
  assert.deepEqual(decoded('\x7f'), [{ type: 'key', key: 'backspace' }]);
  assert.deepEqual(decoded('\r'), [{ type: 'key', key: 'enter' }]);
  assert.deepEqual(decoded('\x1b[B'), [{ type: 'key', key: 'down' }]);
  assert.deepEqual(decoded('Z', 'monitor'), []);
  // Elsewhere they do nothing: the hub, another page, a row of the Control plane that is not a place.
  for (const state of [onPage(), onPage('progress'), onControl({ projectCursor: 'project:fold:healthy' })]) {
    s.session.state = state;
    for (const raw of ['p', 'm', 'x', 'i']) assert.equal((await s.press(raw)).action, undefined);
  }
  s.session.state = initialMonitorState();
  assert.equal((await s.press('p')).action, undefined);
  assert.equal(s.session.state.mainTab, 'home');
});

test('40-col EN/ZH frames 5a–5e follow the Control sample; Classic and Split use the same sheet', async (t) => {
  const s = await setup(t), nav = { projectCursor: 'project:role:imp' };
  const pi = { harness: 'pi', model: 'xai/grok-4.7', thinking: 'high' };
  const cli = { harness: 'cli', agent: 'agy', model: 'gemini-4-hydrogen-high' };
  for (const [role, preset, run] of [['frontend-imp', 'default', [cli]], ['imp', 'daily', [pi, cli]],
    ['oracle', 'fable', [{ harness: 'cli', agent: 'claude', model: 'fable' }]]]) {
    s.put(join(s.hud, 'roles', `${role}.json`), { role, instructions: 'implementer', can_continue: true, run, active_preset: preset, presets: [{ name: preset, run }] });
  }
  setHarnessDisabled(s.hud, 'cli:grok', true);
  discover(s, [pi.model]);
  const roles = ['frontend-imp', 'imp', 'oracle'].map((name) => s.session.snap.roles.find((role) => role.role === name));
  s.session.snap.roles = roles;
  s.session.snap.control = [];
  const shots = [['5a', 'Inightly'], ['5b', ENTER], ['5c', 'i'], ['5d', ENTER],
    ['5e', [ENTER, DOWN, ENTER, pi.model, ENTER, DOWN, ENTER, 'high', ENTER, END, ENTER, 'i', ENTER, 'agy', ENTER, DOWN, ENTER, 'hydrogen', ENTER, END, ENTER]]];
  const normalize = (row) => row.trim().replace(/^[›>] +/, '').replace(/─+/g, '─').replace(/’/g, "'").replace(/ +/g, ' ').replace(/ Off$/, ' off');
  const body = (rows) => rows.slice(rows.findIndex((row) => /^imp ─/.test(row)), -1).filter((row) => row.trim()).map(normalize);
  for (const panelLayout of ['split', 'classic']) {
    s.session.state = onControl(nav, { panelLayout, experiments: true });
    for (const [id, keys] of shots) {
      await s.keys(...[keys].flat());
      for (const lang of ['en', 'zh']) {
        const expected = controlSample(lang).frames.find((f) => f.id === id).frame.rows.map((row) => row.segs.map((s) => s.t).join(''));
        const view = s.render(40, lang, s.session.state, panelLayout === 'split' ? expected.length : 28, s.session.snap, true, 'unicode', 'none', {
          projectName: 'harbor-api', projects: PROJECTS, projectWaiting: 2,
        });
        assert.ok(view.lines.every((line) => visualLength(line) === 40));
        const actual = body(plain(view));
        if (panelLayout === 'split') assert.deepEqual(actual, body(expected), `${id} ${lang}`);
        else assert.deepEqual(actual.slice(0, body(expected).length), body(expected), `${id} ${lang} Classic sheet`);
        if (panelLayout === 'split' && process.env.HUD_CHAIN_REPORT_FRAMES) console.log(`${lang} ${id}\n${view.lines.map(stripAnsi).join('\n')}\n`);
      }
    }
  }
});

test('tab, project switch and quit ask before leaving a dirty chain; Esc resumes and Enter discards', async (t) => {
  const s = await setup(t);
  for (const [key, expected] of [['tab', 'home'], ['project-next', 'control'], ['close', 'control']]) {
    s.session.state = select(onControl(), 'project:role:imp');
    await s.keys('Idirty', ENTER);
    const send = (state, key) => {
      const frame = s.render(40, 'en', state, 24, s.session.snap, true, 'unicode', 'none', { projects: PROJECTS });
      return handleMonitorInput(frame.state, { type: 'key', key }, { tree: TREE, frame });
    };
    const initial = s.session.state, asking = send(initial, key);
    assert.equal(asking.close, false);
    assert.equal(asking.state.mainTab, 'control');
    assert.equal(asking.state.projectRoot, undefined);
    assert.equal(send(asking.state, 'escape').state.controlChain.draft.name, 'dirty');
    const discarded = send(asking.state, 'enter');
    assert.equal(discarded.state.controlChain, undefined);
    assert.equal(discarded.state.mainTab, expected);
    assert.equal(discarded.close, key === 'close');
    assert.equal(discarded.state.projectRoot, key === 'project-next' ? PROJECTS[1].root : undefined);
  }
  assert.equal(fs.existsSync(join(s.hud, 'roles/imp.json')), false);
});

test('the live panel applies explicit owner edits, including batched name input', async (t) => {
  const s = await setup(t);
  const root = fs.realpathSync(s.cwd);
  s.put(join(s.hud, 'projects.json'), { version: 1, projects: [{ root, registered_at: '2026-11-13T00:00:00.000Z' }] });
  s.put(join(s.cwd, '.hud/roles/frontend.json'), { role: 'frontend', harness: 'pi', pi_role: 'implementer', split: false, can_continue: true, model: 'project/model' });
  s.put(join(s.cwd, '.hud/project.json'), { version: 1, roles: ['imp', 'frontend', 'sonic'] });
  s.put(join(s.hud, 'hud-settings.json'), { modelEnabled: false, refreshMs: 100, language: 'en' });
  const place = JSON.stringify({ state: { ...initialMonitorState(), mainTab: 'project', projectPage: 'control', projectCursor: 'project:role:imp', projectFolded: new Set(['agents', 'files']) } },
    (_k, v) => (v instanceof Set ? { panelSet: [...v] } : v));
  const runner = join(s.root, 'live.mjs');
  fs.writeFileSync(runner, `import { runLivePage } from ${JSON.stringify(pathToFileURL(resolve('dist/tree-page.js')).href)};\nawait runLivePage();\nprocess.exit(0);\n`);
  const child = spawn(process.execPath, [runner], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...s.env, CODEX_HUD_STANDALONE_PANEL: '1', CODEX_HUD_CWD: s.cwd, HUD_PANEL_RELOAD_PLACE: place } });
  let out = '', err = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { err += b; });
  t.after(() => child.kill('SIGKILL'));
  const until = async (ok, what) => {
    for (const end = Date.now() + 15000; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (ok()) return;
    assert.fail(`${what}: ${err}\n${stripAnsi(out).slice(-2500)}`);
  };
  await until(() => stripAnsi(out).includes('Roles'), 'the migrated Control tab');
  child.stdin.write('Iqn7\r');
  await until(() => /Not saved/.test(stripAnsi(out)), 'the empty draft');
  child.stdin.write('\x1b');
  await until(() => /Discard edits\?/.test(stripAnsi(out)), 'the discard prompt');
  child.stdin.write('\r');
  assert.equal(fs.existsSync(join(s.hud, 'roles/imp.json')), false);
  child.stdin.write('\rm');
  await until(() => /Model ─/.test(stripAnsi(out)), 'the grouped picker in the place sheet');
  child.stdin.write('openai/gpt-6.1-sol\r\x1b[F\r');
  await until(() => /s save +esc discard +i add/.test(stripAnsi(out)), 'the change is in the draft');
  assert.equal(fs.existsSync(join(s.hud, 'roles/imp.json')), false);
  child.stdin.write('s');
  await until(() => fs.existsSync(join(s.hud, 'roles/imp.json')) && stored(s, 'imp').run[0].model === 'openai/gpt-6.1-sol', 'the whole edit saved');
  child.stdin.write('pgrok\r');
  await until(() => stored(s, 'imp').active_preset === 'grok', 'selected a preset');
  child.stdin.write('Nqjk7\rs');
  await until(() => stored(s, 'imp').active_preset === 'qjk7', 'copied the selected chain');
  child.stdin.write('D');
  await until(() => /Use file chain next/.test(stripAnsi(out).slice(-1200)), 'preview before deletion');
  assert.equal(stored(s, 'imp').active_preset, 'qjk7');
  child.stdin.write('\r');
  await until(() => stored(s, 'imp').active_preset === null, 'file chain selected after deletion');
  assert.equal(stored(s, 'imp').run[0].model, 'openai/gpt-6.1-sol');
  assert.equal(fs.existsSync(join(s.hud, 'roles/frontend.json')), false);
  child.stdin.write('q');
  await once(child, 'exit');
  assert.equal(err, '');
});
