import { withState } from '../fixtures/state-helpers.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { chainOverlay, projectFixture, pickerFrames, flatPickerFrames, MAVERICK, plain, onPage, onControl, NOW, TREE, MODEL_LISTS, PROJECTS } from '../fixtures/project-page.mjs';
import { handleMonitorInput, initialMonitorState } from '../../dist/render/monitor.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { editPlaces, editPreset, placeItem } from '../../dist/roles/role-control.js';
import { build as controlSample } from '../../docs/design/control-tab/gen/frames.mjs';
import { finishChain } from '../../dist/render/chain-input.js';
import { modelInput } from '../../dist/render/model-input.js';
import { setHarnessDisabled } from '../../dist/roles/harness-switches.js';
import { markExhausted, placeKey, roleRegistry } from '../../dist/roles/roster.js';
import { createPanelActions } from '../../dist/panel/actions.js';
import { cleanupFixture, stopChild } from '../helpers/process-cleanup.mjs';

const saveRun = (s, role, run) => assert.equal(editPreset(s.hud, s.cwd, s.env, { role, op: 'run', run }).ok, true);

function select(state, item) {
  const { control } = state, { roles } = control;
  return { ...state, overlay: undefined, control: { ...control, roles: { ...roles, nav: { ...roles.nav, cursor: item } } } };
}
function focus(s, name = 'imp', at = 0) {
  const role = s.session.snap.roles.find((r) => r.role === name);
  s.session.state = { ...select(s.session.state, `project:role:${name}`), overlay: chainOverlay(role, at) };
}

/** The synthetic Project fixture with every CLI and browser tool but `codex` and `jev-flow` on PATH, and the shipped `imp`. */
async function setup(t, { shippedImp = true, healthyOpen = true, browserRoles = false } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'role-control-'));
  const stops = [];
  cleanupFixture(t, { root }, () => Promise.all(stops.map((stop) => stop())));
  const f = await projectFixture(root);
  for (const name of ['herdr', 'agy', 'claude', 'grok', 'jev-aistudio'])
    fs.writeFileSync(join(root, 'bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  if (shippedImp) fs.rmSync(join(f.hud, 'roles/imp.json'));
  if (browserRoles) f.put(join(f.hud, 'role-switches.json'), { pro: true, flow: true });
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
      if (out.action.modelIndex === undefined && session.state.overlay?.kind === 'control-chain') {
        if (session.done.ok) session.state = finishChain(session.state);
        else session.state.overlay.error = session.done.message;
      }
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
  return { ...f, root, session, press, keys, frame, registry, assignment, rows, text, stops };
}
const stored = (s, name) => JSON.parse(fs.readFileSync(join(s.hud, 'roles', `${name}.json`), 'utf8'));
const DOWN = '\x1b[B', ENTER = '\r', ESC = '\x1b', TAB = '\t', BACKSPACE = '\x7f', END = '\x1b[F', DEL = '\x1b[3~';
/** The model lists pi discovered (the cache the Control plane reads), synthetic ids shaped like the real ones. */
const discover = (s, pi = MODEL_LISTS.pi) => {
  s.put(join(s.hud, 'display/model-lists.json'), { version: 1, fetchedAt: NOW, pi });
  s.collector.refreshRoles(s.session.snap, NOW);
};

test('Control plane: what needs the owner first with the place the next job uses; healthy roles fold to names', async (t) => {
  const s = await setup(t, { healthyOpen: false, browserRoles: true });
  // reviewer gets a fallback; pro's first place is exhausted, so its next one is the one in use.
  saveRun(s, 'reviewer', [{ harness: 'pi', pi_role: 'reviewer', split: false }, { harness: 'cli', agent: 'claude', model: 'opus', thinking: 'high' }]);
  markExhausted(s.hud, placeKey({ harness: 'bro', tool: 'jev-ask', provider: 'chatgpt', model: '6 Pro' }), 'quota exceeded', NOW);
  s.session.snap = await s.collector.collect(true, s.board, NOW);
  // Folded: a place at its limit (and where the next job goes), a role with nowhere to run, a role file that does not load; the rest are names.
  const lines = plain(s.frame(80, 'en', 64));
  const at = (re) => lines.findIndex((l) => re.test(l));
  assert.deepEqual([...new Set(s.rows().map((r) => r.item))], ['project:role:pro', 'project:role:flow', 'project:role:council']);
  assert.match(lines[at(/^Needs attention ─/)], / 3$/);
  assert.match(lines[at(/ pro /)], /^ {2}✗ pro → gemini +on$/);
  assert.match(lines[at(/ pro /) + 1], /^ {6}chatgpt exhausted 60m$/);
  assert.match(lines[at(/ flow /)], /^ {2}− flow → none +on$/);
  assert.match(lines[at(/bad\.json/)], /^ {2}! bad\.json +unparseable JSON$/);
  assert.match(lines[at(/^▸ Healthy ─/)], / 5$/);
  assert.match(lines[at(/^▸ Healthy ─/) + 1], /^ {2}◉ imp {2}reviewer {2}sonic {2}oracle {2}general$/);
  assert.ok(at(/^Needs attention ─/) < at(/^▸ Healthy ─/) && at(/^▸ Healthy ─/) < at(/^▸ Usage/));
  assert.doesNotMatch(lines.join('\n'), /synthetic\/model|^Harnesses ─/m);
  // One line a row at every width and language; at 40 columns a long model is cut in the middle, never the harness or the thinking.
  for (const lang of ['en', 'zh'])
    for (const width of [32, 40, 56, 80, 120])
      for (const state of [onControl(), onControl({ folded: new Set(['agents']) })]) {
        s.session.state = state;
        const view = s.frame(width, lang, 64);
        for (const line of view.lines) assert.equal(visualLength(line), width, stripAnsi(line));
        for (const row of view.workboard.rows) assert.doesNotMatch(row.text, /\n/);
      }
  s.session.state = onControl();
  const narrow = plain(s.frame(40, 'zh', 64)).join('\n');
  assert.match(narrow, /^需要处理 ─+ 3$/m);
  assert.match(narrow, /^ {2}✗ pro → gemini +开$/m);
  assert.match(narrow, /^ {6}chatgpt 已耗尽 60分$/m);
  assert.match(narrow, /^▸ 正常 ─+ 5$/m);
  s.session.state = select(s.session.state, 'project:fold:healthy');
  await s.press('\r');
  assert.deepEqual(s.rows().map((r) => r.item).filter((i) => !/role:(pro|flow|council)$/.test(i)), ['imp', 'reviewer', 'sonic', 'oracle', 'general'].map((x) => `project:role:${x}`));
  assert.match(s.text(), /^Healthy ─+ 5$/m);
  await s.press('\r');
  assert.match(s.text(), /^▸ Healthy ─+ 5$/m, 'Enter again folds them');
});
test('Control switches optional roles on with Space and off with the footer in both layouts', async (t) => {
  const s = await setup(t, { healthyOpen: false });
  const visit = { collector: s.collector, control: s.session.snap };
  const host = { state: s.session.state, shownRoot: () => s.cwd, notice: (text) => assert.equal(text, '') };
  const actions = createPanelActions(s.hud, s.cwd, { visit: () => visit }, host);
  const role = () => visit.control.roles.find((r) => r.role === 'pro');
  for (const panelLayout of ['classic']) {
    s.session.state = onControl({ cursor: 'project:role:pro' }, { prefs: { panelLayout } });
    assert.equal(role().optionalEnabled, false);
    assert.equal(role().editor, undefined);
    const out = await s.press(' ');
    assert.deepEqual(out.action, { type: 'role-switch', role: 'pro', enabled: true });
    actions.execute(out.action, out.state);
    assert.equal(role().places[0].state, 'active');
    assert.equal(visit.control.roleCount, 6);
    const frame = s.frame();
    const target = frame.controls.find((c) => c.kind === 'role-toggle');
    assert.ok(target, panelLayout);
    const click = handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: target.x, y: target.y }, { tree: TREE, frame, standalone: true });
    assert.deepEqual(click.action, { type: 'role-switch', role: 'pro', enabled: false });
    actions.execute(click.action, click.state);
    assert.deepEqual(role().places, []);
    assert.equal(visit.control.roleCount, 5);
  }
  assert.equal(fs.existsSync(join(s.hud, 'roles/pro.json')), false);
});

test('Control plane keeps the long model field usable when the role list scrolls', async (t) => {
  const s = await setup(t);
  const model = 'synthetic-provider/very-long-model-identifier-for-place-preview-20261117';
  const exhausted = { harness: 'cli', agent: 'claude', model, thinking: 'high' };
  saveRun(s, 'reviewer', [exhausted, { harness: 'pi', pi_role: 'reviewer', split: false },
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
  assert.equal(frame.state.overlay.at, 0);
  const lines = plain(frame), chain = lines.findIndex((line) => /^› +1 ✗/.test(line));
  assert.ok(chain > lines.findIndex((line) => /✗ reviewer/.test(line)));
  assert.match(lines.join('\n'), /source +yours · reviewer\.json/);
  const field = frame.controls.find((c) => c.item === placeItem('reviewer', 0) && c.kind === 'control-model');
  assert.equal(field.y, chain + 1, 'the long model field has its own row');
  assert.match(lines[field.y], /\[very-long.*….*preview ▾\]/);
  const picked = handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: field.x, y: field.y }, { tree: TREE, frame });
  assert.equal(picked.state.overlay.mode.kind, 'quick-model');
  assert.equal(picked.state.overlay.mode.index, 0);
  assert.equal(picked.state.overlay.mode.picker.place.label, 'claude');
  frame = choose(frame, { type: 'key', key: 'down' });
  assert.equal(frame.state.overlay.at, 1);
  const y = plain(frame).findIndex((line) => /3 ○ agy/.test(line));
  assert.ok(y > 0);
  frame = choose(frame, { type: 'mouse', button: 'left', x: 4, y });
  assert.equal(frame.state.overlay.at, 2);
  const zh = s.frame(38, 'zh', 24);
  assert.match(plain(zh).join('\n'), /^› +3 ○ agy +\[synthetic-fallback ▾\]/m);
  for (const line of zh.lines) assert.equal(visualLength(line), 38, stripAnsi(line));
  assert.deepEqual(stored(s, 'reviewer'), before);
});

test('Classic expands only the selected role’s numbered chain; o opens a role’s file without expanding', async (t) => {
  const s = await setup(t, { healthyOpen: false });
  await s.press(DOWN); // Healthy (initial cursor is the invalid file)
  await s.press(ENTER);
  await s.press(DOWN); // imp
  assert.match(s.text(), /imp → synthetic\/model/);
  assert.doesNotMatch(s.text(), /^› 1 ◉/m);
  assert.deepEqual((await s.press('o')).action, { type: 'open-files', files: [resolve('packages/hud-mcp/roles/imp.json')] });
  saveRun(s, 'imp', [{ harness: 'pi', pi_role: 'implementer' }, { harness: 'pi', model: 'synthetic/backup' }]);
  s.collector.refreshRoles(s.session.snap, NOW);
  await s.press(ENTER);
  assert.match(s.text(), /^› 1 ◉ pi\/synthetic +\[model ▾\] +high$/m);
  assert.match(s.text(), /^ {2}2 ○/m);
  assert.match(s.text(), /source +yours · imp\.json/);
  await s.press(ESC);
  assert.doesNotMatch(s.text(), /^› 1 ◉/m);
});
test('focused editable and project-pinned chains report unknown providers without blocking assignment', async (t) => {
  const s = await setup(t);
  const model = 'ambiguous-model';
  discover(s, [`alpha/${model}`, `beta/${model}`]);
  const role = { role: 'imp', can_continue: true, run: [{ harness: 'pi', pi_role: 'implementer', model }] };
  saveRun(s, 'imp', role.run);
  for (const pinned of [false, true]) {
    if (pinned) {
      s.put(join(s.hud, 'projects.json'), { version: 1, projects: [{ root: fs.realpathSync(s.cwd) }] });
      s.put(join(s.cwd, '.hud/project.json'), { version: 1, roles: ['imp', 'secret'] });
      s.put(join(s.cwd, '.hud/roles/imp.json'), role);
    }
    s.collector.refreshRoles(s.session.snap, NOW);
    const fact = s.session.snap.roles.find((r) => r.role === 'imp');
    assert.equal(fact.source, pinned ? 'project' : 'yours');
    assert.equal(fact.places[0].provider, null);
    assert.equal(fact.places[0].state, 'active');
    assert.equal(s.assignment('imp').model, model);
    assert.equal(s.assignment('imp').available, true);
    for (const panelLayout of ['classic']) for (const lang of ['en', 'zh']) {
      s.session.state = onControl(undefined, { prefs: { panelLayout } });
      focus(s);
      const frame = s.frame(40, lang, 22), rows = plain(frame).join('\n');
      assert.ok(frame.lines.every((line) => visualLength(line) === 40));
      assert.match(rows, lang === 'en' ? /^ +provider unknown$/m : /^ +提供方未知$/m);
      assert.match(rows, /◉ pi.*ambiguous-model/);
      assert.equal(frame.controls.some((c) => c.kind === 'control-model'), !pinned);
      if (process.env.CONTROL_REVIEW_FRAMES && panelLayout === 'classic') t.diagnostic(`${lang} ${pinned ? 'locked' : 'editable'}:\n${rows}`);
    }
  }
});

test('x clears a real quota mark immediately, but never from a draft index', async (t) => {
  const s = await setup(t);
  const first = { harness: 'cli', agent: 'agy', model: 'demo/cli' };
  saveRun(s, 'imp', [first, { harness: 'pi', pi_role: 'implementer', model: 'demo/pi' }]);
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
  assert.match(s.text(), /imp → synthetic\/model/);
  assert.match(plain(s.frame(120)).at(-1), /c C preset/);
  await s.press('c');
  assert.deepEqual(s.session.done, { ok: true, index: 0, preset: 'hydrogen' });
  assert.equal(s.assignment('imp').preset, 'hydrogen');
  assert.deepEqual(stored(s, 'imp').run, raw);
  assert.match(s.text(), /imp \[hydrogen\]/);
  markExhausted(s.hud, placeKey(s.assignment('imp').runs_on), 'quota exceeded', NOW);
  await s.press('c');
  assert.equal(s.assignment('imp').preset, 'astra');
  await s.press('C');
  assert.match(s.text(), /− imp \[hydrogen\] → none/);
  assert.equal(s.assignment('imp').exhausted.length, 1);
  await s.press('C');
  assert.equal(s.frame().state.control.roles.nav.cursor, item);
  assert.equal(s.assignment('imp').preset, 'default');
  assert.match(s.text(), /sonic → pi/);
  s.session.state = select(s.session.state, 'project:role:sonic');
  await s.press('c');
  assert.equal(fs.existsSync(join(s.hud, 'roles/sonic.json')), false, 'no presets writes nothing');
});

test('browser fields use the actual adapter: site/effort, AI Studio model/thinking, and Flow kind', async (t) => {
  const s = await setup(t, { browserRoles: true });
  focus(s, 'pro');
  await s.press(ENTER);
  assert.match(s.text(), /target +chatgpt\n +Effort +6 Pro/);
  assert.doesNotMatch(s.text(), /thinking/);
  await s.keys(ENTER, 'aistudio', ENTER);
  assert.match(s.text(), /target +aistudio\n +model +\[gemini-4-argon ▾\]\n +thinking$/m);
  assert.equal(s.assignment('pro').runs_on.provider, 'chatgpt');
  await s.keys(ESC, DOWN, 'Ks');
  assert.equal(s.assignment('pro').runs_on.provider, 'gemini');
  focus(s, 'pro', 2);
  await s.press('m');
  assert.equal(s.session.state.overlay.mode.kind, 'quick-model');
  assert.match(s.text(), /^pro #3 ─+ aistudio\n\/ ▌ +1\n› ◉ gemini-4-argon/m);
  await s.keys(DOWN, ENTER);
  assert.equal(s.session.done.ok, true);
  assert.equal(stored(s, 'pro').run[2].model, undefined);
  assert.equal(s.session.state.overlay.at, 2);
  s.session.state = select(s.session.state, 'project:role:flow');
  await s.press('m');
  assert.equal(s.session.state.overlay, undefined);
  assert.doesNotMatch(s.frame().lines.at(-1), /m model/);
  focus(s, 'flow');
  await s.press(ENTER);
  assert.match(s.text(), /Flow kind +image/);
  assert.doesNotMatch(s.text(), /thinking|Effort/);
  await s.keys(DOWN, ENTER, 'video', ENTER, END, ENTER, 's');
  assert.equal(stored(s, 'flow').run[0].kind, 'video');
});

const lines40 = (s, lang = 'en', height = 20) => plain(s.frame(40, lang, height));
test('Control uses inherited model and thinking when known and a clickable arrow when unknown', async (t) => {
  const s = await setup(t, { shippedImp: false });
  for (const known of [true, false]) {
    s.put(join(s.root, 'roles/implementer.md'), known ? '---\nmodel: xai/gpt-6.2-sol\nthinking: high\n---\nSynthetic role\n' : 'Synthetic role\n');
    s.collector.refreshRoles(s.session.snap, NOW);
    for (const panelLayout of ['classic']) for (const lang of ['en', 'zh']) {
      s.session.state = onControl(undefined, { prefs: { panelLayout } });
      focus(s);
      const draw = () => s.frame(40, lang, 32);
      const hit = (frame) => frame.controls.find((c) => c.kind === 'control-model' && c.item);
      const label = lang === 'en' ? 'thinking' : '思考';
      const button = known ? '[gpt-6.2-sol ▾]' : '[▾]';
      let view = draw();
      assert.ok(plain(view)[hit(view).y].includes(button), plain(view).join('\n'));
      await s.press(ENTER);
      view = draw();
      assert.ok(plain(view)[hit(view).y].includes(button));
      assert.equal(plain(view).find((row) => row.trimStart().startsWith(label)).trim().split(/ +/).join(' '), known ? `${label} high` : label);
      const { x, y } = hit(view);
      s.session.state = handleMonitorInput(view.state, { type: 'mouse', button: 'left', x, y }, { tree: TREE, frame: view }).state;
      assert.ok(modelInput(s.session.state.overlay));
      const clear = lang === 'en' ? (known ? "role's model (gpt-6.2-sol)" : 'clear') : (known ? '角色自带模型（gpt-6.2-sol）' : '清除');
      assert.ok(plain(draw()).some((row) => row.startsWith(`› ◉ ${clear}`)));
      const wide = s.render(120, lang, s.session.state, 36, s.session.snap);
      assert.ok(plain(wide).some((row) => row.startsWith(`› ◉ ${clear}`)));
      assert.match(plain(wide).join('\n'), lang === 'en' ? /clears the model override/ : /清除imp/);
      assert.equal(stored(s, 'imp').model, undefined);
    }
  }
});
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
  assert.match(page, /^imp #1 ─+ pi$/m);
  assert.doesNotMatch(page, /list 0m old/);
  assert.match(page, /role's model \(model\)\n +from pi role/);
  assert.match(page, /\? ctx {2}\? out {2}think \? {2}img \?/, 'legacy caches still populate the picker, without invented facts');
  assert.match(page, new RegExp(`/ ▌ +${MODEL_LISTS.pi.length}$`, 'm'));
  await s.keys('ANTH');
  page = lines40(s, 'en', 24).join('\n');
  assert.match(page, /^\/ ANTH▌ +8$/m);
  assert.match(page, /^› +anthropic\/claude-haiku-5[\s\S]*^ +arena\/anthropic.claude-opus-5-5$/m);
  assert.match(page, /20261101/);
  assert.doesNotMatch(page, /openai/);
  await s.keys(ESC, 'XAI/GROK-4.7', ENTER);
  assert.equal(s.session.state.overlay.at, 0);
  assert.equal(s.session.state.overlay.mode.kind, 'places');
  assert.equal(s.session.state.overlay.draft, undefined);
  assert.equal(s.session.done.ok, true);
  assert.equal(stored(s, 'imp').run[0].model, 'xai/grok-4.7');
  assert.equal(s.assignment('imp').model, 'xai/grok-4.7');
  assert.equal(s.session.state.control.roles.nav.cursor, 'project:role:imp');
  assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')), legacy);
  const roleFile = join(s.hud, 'roles/imp.json'), before = fs.readFileSync(roleFile);
  setHarnessDisabled(s.hud, 'pi:xai', true);
  s.collector.refreshRoles(s.session.snap, NOW);
  assert.equal(s.assignment('imp').places[0].state, 'off');
  focus(s);
  await s.keys('m', 'grok');
  page = lines40(s).join('\n');
  assert.match(page, /^\/ grok▌ +2$/m);
  assert.doesNotMatch(page, /xai\/grok/);
  assert.equal(s.registry().routing(NOW).byId.get('grok-4.7'), null, 'attribution still sees both providers');
  await s.keys(ESC, ESC, ESC);
  setHarnessDisabled(s.hud, 'pi:xai', false);
  s.collector.refreshRoles(s.session.snap, NOW);
  await s.keys('m', 'grok', DOWN);
  page = lines40(s).join('\n');
  assert.match(page, /^\/ grok▌ +5$/m);
  assert.match(page, /^  ◉ xai\/grok-4.7\n›   xai\/grok-4.7-fast[\s\S]*^ +arena\/grok-4.7$/m);
  const closed = await s.press('\x03');
  assert.equal(closed.close, false);
  assert.equal(s.session.state.overlay, undefined);
  assert.deepEqual(fs.readFileSync(roleFile), before);
  assert.deepEqual(fs.readFileSync(cacheFile), cacheBefore);
});
test('quick model on a role saves only the model in the active preset and targets its next place', async (t) => {
  const s = await setup(t), file = join(s.hud, 'roles/imp.json'), item = 'project:role:imp';
  const pi = (model, extra = {}) => ({ harness: 'pi', model, ...extra });
  const daily = [pi('xai/grok-4.7', { thinking: 'high', extra: { synthetic: true } }), pi('openai/gpt-6.1-sol', { split: true })];
  const original = { role: 'imp', instructions: 'implementer', can_continue: true, active_preset: 'daily', custom: ['keep'],
    run: [pi('xai/grok-4.7-mini')], presets: [{ name: 'daily', run: daily, note: 'keep' }, { name: 'other', run: [pi('openai/o1')] }] };
  const check = (index, model, before) => {
    const expected = structuredClone(before);
    expected.presets[0].run[index].model = model;
    assert.deepEqual(stored(s, 'imp'), expected);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(s.session.state.control.roles.nav.cursor, item);
    assert.equal(s.session.state.overlay, undefined);
  };
  for (const [panelLayout, model] of [['split', 'xai/grok-4.7-fast'], ['classic', 'xai/grok-4.7-mini']]) {
    s.put(file, original);
    discover(s);
    s.session.state = onControl({ cursor: item }, { prefs: { panelLayout } });
    await s.keys('m', model);
    assert.equal(s.session.state.overlay.kind, 'control-quick-model');
    assert.equal(s.session.state.overlay.index, 0);
    assert.deepEqual(stored(s, 'imp'), original);
    const out = await s.press(ENTER);
    assert.deepEqual([out.action.type, out.action.op, out.action.modelIndex], ['preset-edit', 'run', 0]);
    check(0, model, original);
    const after = fs.readFileSync(file);
    await s.press(ESC);
    assert.deepEqual(fs.readFileSync(file), after);
  }
  const beforeFallback = stored(s, 'imp');
  markExhausted(s.hud, placeKey(beforeFallback.presets[0].run[0]), 'quota exceeded', NOW);
  s.collector.refreshRoles(s.session.snap, NOW);
  s.session.state = onControl({ cursor: item }, { prefs: { panelLayout: 'split' } });
  assert.match(s.text(), /imp \[daily\] → openai\/gpt-6.1-sol/);
  await s.keys('m', 'openai/gpt-6-astra');
  assert.equal(s.session.state.overlay.index, 1);
  const fallback = await s.press(ENTER);
  assert.equal(fallback.action.modelIndex, 1);
  check(1, 'openai/gpt-6-astra', beforeFallback);
  const roster = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-mcp.mjs')], {
    cwd: s.cwd, env: { ...s.env, HUD_MCP_SURFACE: 'roles', HUD_MCP_JSON: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(roster, 'exit');
  s.stops.push(() => stopChild(roster, exited, { closeStdin: true }));
  const response = once(createInterface({ input: roster.stdout }), 'line');
  roster.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hud_roster', arguments: { detail: true } } }) + '\n');
  const [line] = await response;
  roster.stdin.end();
  assert.deepEqual(await exited, [0, null]);
  const imp = JSON.parse(JSON.parse(line).result.content[0].text).roles.find((r) => r.role === 'imp');
  assert.equal(imp.preset, 'daily');
  assert.equal(imp.run[1].model, 'openai/gpt-6-astra');

  focus(s, 'imp', 1);
  const beforeDraft = fs.readFileSync(file);
  await s.keys('K', 'm', 'openai/o1', ENTER);
  assert.deepEqual(fs.readFileSync(file), beforeDraft);
  const draft = s.session.state.overlay;
  assert.equal(draft.at, 0);
  assert.equal(draft.mode.kind, 'places');
  assert.equal(draft.draft.run[0].raw.model, 'openai/o1');
  await s.press('s');
  assert.equal(stored(s, 'imp').presets[0].run[0].model, 'openai/o1');

  for (const place of stored(s, 'imp').presets[0].run) markExhausted(s.hud, placeKey(place), 'quota exceeded', NOW);
  s.collector.refreshRoles(s.session.snap, NOW);
  assert.match(s.text(), /imp \[daily\] → none/);
  await s.press('m');
  assert.equal(s.session.state.overlay.index, 0, 'place 1 is editable when none can run');
});

test('pi picker keeps no-match text, owns printable keys, and does not offer an off default', async (t) => {
  const s = await setup(t);
  const long = 'new-provider/' + 'a'.repeat(115);
  assert.equal(long.length, 128);
  discover(s, [...MODEL_LISTS.pi, long]);
  await s.keys('m', 'new-provider/aaa', TAB, ENTER);
  assert.equal(stored(s, 'imp').run[0].model, long, 'the full 128-character ID survives the edit');
  focus(s);
  await s.keys('m', 'custom/pi-next', ENTER);
  assert.match(lines40(s).join('\n'), /▌ +0\nNo matching models/);
  const picker = () => s.session.state.overlay.mode.picker;
  assert.equal(picker().text, 'custom/pi-next');
  assert.equal(stored(s, 'imp').run[0].model, long);
  await s.press(BACKSPACE);
  assert.equal(picker().text, 'custom/pi-nex');
  await s.press(ESC);
  assert.equal(picker().text, '');
  assert.equal(picker().pick, undefined);
  assert.equal(stored(s, 'imp').run[0].model, long);
  await s.press(ESC);
  assert.equal(s.session.state.overlay.mode.kind, 'places');
  assert.equal(stored(s, 'imp').run[0].model, long);
  setHarnessDisabled(s.hud, 'pi:synthetic', true);
  s.collector.refreshRoles(s.session.snap, NOW);
  await s.keys('m', '\x1b[H');
  assert.doesNotMatch(lines40(s).join('\n'), /role's model|from pi role/);
  await s.press(ESC);
  setHarnessDisabled(s.hud, 'pi:synthetic', false);
  s.collector.refreshRoles(s.session.snap, NOW);
  await s.press('m');
  const window = s.frame().panes[0].rows.find((r) => r.modelWindow).modelWindow;
  const clear = window.entries.findIndex(({ id }) => id === 'default');
  assert.ok(clear > 0, 'the clear row precedes provider models');
  await s.keys(...Array(clear).fill(DOWN), ENTER);
  assert.equal(stored(s, 'imp').run[0].model, undefined);
  assert.equal(s.assignment('imp').model, 'synthetic/model');
  focus(s);
  await s.press('m');
  for (const raw of ['q', 'p', 'e', 'i', 'r', 'K', 'o', 'j', 'w']) {
    const out = await s.press(raw);
    assert.deepEqual([out.action, out.close], [undefined, false], raw);
  }
  assert.equal(picker().text, 'qpeirKojw');
  const view = s.frame();
  const tab = view.controls.find((c) => c.kind === 'board-project');
  const click = handleMonitorInput(view.state, { type: 'mouse', button: 'left', x: tab.x, y: tab.y }, { tree: TREE, frame: view, nowMs: NOW, standalone: true });
  assert.equal(click.state.overlay.mode.kind, 'quick-model', 'the model field owns input until it is cancelled');
  assert.equal(click.action, undefined);
});
test('m on oracle → claude opens the flat picker and Enter saves the active preset', async (t) => {
  const s = await setup(t);
  const item = 'project:role:oracle', claude = { harness: 'cli', agent: 'claude', model: 'fable', thinking: 'high' };
  const file = join(s.hud, 'roles/oracle.json'), before = { role: 'oracle', can_continue: true, active_preset: 'daily',
    run: [claude], presets: [{ name: 'daily', run: [claude] }], note: 'keep' };
  s.put(file, before);
  s.collector.refreshRoles(s.session.snap, NOW);
  s.session.state = onControl({ cursor: item }, { prefs: { panelLayout: 'split' } });
  assert.match(s.text(), /oracle \[daily\] → claude fable/);
  await s.press('m');
  assert.equal(s.session.state.overlay.kind, 'control-quick-model');
  const picker = s.frame(120);
  assert.deepEqual(picker.panes.map((pane) => [pane.id, pane.width]), [['agents', 120]]);
  assert.match(plain(picker).join('\n'), /^oracle #1 ─+ \[daily\] · claude\n\/ ▌ +4\n› ◉ fable +\[fable\]\n +clear\n +haiku\n +opus\n +sonnet$/m);
  await s.keys('OPUS');
  assert.deepEqual(stored(s, 'oracle'), before);
  const { action } = await s.press(ENTER);
  assert.deepEqual([action.type, action.op, action.modelIndex], ['preset-edit', 'run', 0]);
  assert.equal(s.session.done.ok, true);
  assert.deepEqual(stored(s, 'oracle'), { ...before, presets: [{ name: 'daily', run: [{ ...claude, model: 'opus' }] }] });
  assert.equal(s.session.state.control.roles.nav.cursor, item);
  assert.equal(s.session.state.overlay, undefined);

  const saved = stored(s, 'oracle');
  setHarnessDisabled(s.hud, 'cli:claude', true);
  s.collector.refreshRoles(s.session.snap, NOW);
  await s.keys('m', 'sonnet');
  assert.match(s.text(), /› +sonnet +⊘ off/);
  assert.equal((await s.press(ENTER)).action, undefined);
  assert.deepEqual(stored(s, 'oracle'), saved);

  const frames = flatPickerFrames(s);
  assert.deepEqual(flatPickerFrames(s, 'classic'), frames);
  for (const [name, lines] of Object.entries(frames)) {
    assert.ok(lines.every((line) => visualLength(line) === Number(name.split('-').at(-2))));
    assert.match(lines[2], /^\/ ▌ +4 *$/);
    assert.doesNotMatch(lines.slice(2).join('\n'), /│|─|ctx|输出|Edit place|编辑位置|\?/);
  }
});

test('CLI quick picker merges catalog and discovery; Edit place keeps inline Model and Thinking', async (t) => {
  const s = await setup(t);
  saveRun(s, 'imp', [{ harness: 'cli', agent: 'agy', model: 'gemini-4-argon-high' }]);
  s.put(join(s.hud, 'display/model-lists.json'), { version: 1, fetchedAt: NOW, pi: MODEL_LISTS.pi,
    cli: { agy: ['gemini-synthetic-mid', 'gemini-4-argon-high'] } });
  s.collector.refreshRoles(s.session.snap, NOW);
  await s.press('m');
  const page = lines40(s).join('\n');
  assert.match(page, /^\/ ▌ +4\n› ◉ gemini-4-argon-high\n +gemini-4-hydrogen-high +\[hydrogen\]\n +clear\n +gemini-3\.8-flash-high\n +gemini-synthetic-mid$/m);
  assert.deepEqual((await s.press('\x12')).action, { type: 'refresh-models' });
  await s.keys('next-one', ENTER);
  assert.match(lines40(s).join('\n'), /No matching models/);
  assert.equal(stored(s, 'imp').run[0].model, 'gemini-4-argon-high');
  await s.keys(ESC, ESC);
  s.session.state = select(s.session.state, 'project:role:imp');
  await s.keys('m', 'MID synthetic', ENTER);
  assert.equal(s.session.done.ok, true);
  assert.equal(stored(s, 'imp').run[0].model, 'gemini-synthetic-mid');
  assert.equal(s.session.state.overlay, undefined);
  focus(s);
  await s.keys(ENTER, DOWN, ENTER, 'flash', ENTER);
  assert.equal(s.session.state.overlay.mode.kind, 'sheet');
  assert.equal(s.session.state.overlay.mode.input, undefined);
  assert.equal(s.session.state.overlay.mode.place.raw.model, 'gemini-3.8-flash-high');
  assert.equal(stored(s, 'imp').run[0].model, 'gemini-synthetic-mid');
  await s.keys(DOWN, ENTER, 'xhigh', ENTER, END, ENTER, 's');
  assert.equal(stored(s, 'imp').run[0].thinking, 'xhigh');
  // Width and cursor invariants for both languages/layouts, with long Latin and wide queries.
  const inputs = ['', '探'.repeat(90), 'maverick', 'openai'];
  for (const pi of [false, true]) {
    if (pi) {
      saveRun(s, 'imp', [{ harness: 'pi', pi_role: 'implementer', split: false, model: 'openai/gpt-6.1-sol' }]);
      s.collector.refreshRoles(s.session.snap, NOW);
      assert.equal(s.assignment('imp').harness, 'pi');
    }
    for (const text of inputs) for (const panelLayout of ['classic']) {
      s.session.state = onControl(undefined, { prefs: { panelLayout } });
      focus(s);
      await s.press('m');
      if (text) {
        const frame = s.frame();
        s.session.state = handleMonitorInput(frame.state, { type: 'key', key: '', text }, { tree: TREE, frame, nowMs: NOW }).state;
      }
      for (const lang of ['en', 'zh']) for (const width of [32, 40, 56, 80, 120]) {
        const view = s.frame(width, lang, 14);
        for (const line of view.lines) assert.equal(visualLength(line), width, stripAnsi(line));
        const rows = view.panes.flatMap((pane) => pane.rows);
        for (const row of rows) assert.doesNotMatch(row.text, /\n/);
        assert.equal(view.lines.length, 14);
        assert.ok(rows.filter((r) => r.item === 'project:pick').length <= 1);
      }
    }
  }
  s.session.state = withState(s.session.state, { prefs: { panelLayout: 'classic' } });
  const zh = plain(s.frame(40, 'zh', 14));
  assert.match(zh[1], /^imp 第 1 位 ─+ pi$/);
  assert.match(zh[0], /首页.*项目.*控制/);
  assert.match(zh.at(-1), /^ *⏎ 设为 +esc 清除 +\^R 刷新$/);
  assert.match(plain(s.frame(40, 'en', 14)).at(-1), /^ *⏎ set +esc clear +\^R refresh$/);
  assert.doesNotMatch(plain(s.frame(120, 'en', 14)).at(-1), /tab all|← back/);
  s.session.state = { ...initialMonitorState(), help: {} };
  const help = plain(s.frame(80, 'en', 100)).join('\n').replace(/\n {8}/g, ' ');
  assert.doesNotMatch(help, /^p P |^e E /m);
  assert.match(help, /^p +role: choose a preset by name/m);
  assert.match(help, /^m +role\/place: picker in this pane/m);
  assert.match(help, /^r +refresh the model lists/m);
  assert.match(help, /^\^R +picker: refresh model lists/m);
  assert.match(help, /^Esc +picker: clear filter, then close/m);
});
test('40-column picker preserves defaults, full IDs and capability strips in Classic and Split', async (t) => {
  const s = await setup(t);
  const frames = pickerFrames(s);
  assert.deepEqual(pickerFrames(s, undefined, 'classic'), frames, 'both layouts paint the same picker body');
  for (const lang of ['en', 'zh']) {
    const grouped = frames[`pick-grouped-40-${lang}`].join('\n');
    assert.match(grouped, lang === 'en' ? /pi's model \(gpt-6.1-sol\)\n +from pi settings/ : /pi 自带模型（gpt-6.1-sol）\n +来自 pi 设置/);
    assert.match(grouped, /^openai ─+ 7[\s\S]*^▸ anthropic · arena/m);
    const filtered = frames[`pick-filter-40-${lang}`].join('\n');
    assert.match(filtered, /^\/ grok▌ +5$/m);
    assert.match(filtered, /^  ◉ xai\/grok-4.7\n›   xai\/grok-4.7-fast[\s\S]*^ +arena\/grok-4.7$/m);
    const long = frames[`pick-long-40-${lang}`];
    assert.match(long.join('\n'), /^› +arena\/meta-llama\/.*….*-fp8$/m);
    assert.equal(long.slice(-4, -2).map((row) => row.trim()).join(''), `${MAVERICK}-fp8`);
    assert.match(long.at(-2), lang === 'en' ? /^1M ctx {2}16K out {2}think – {2}img ✓$/ : /^1M 上下文 {2}16K 输出 {2}思考 – {2}图片 ✓$/);
  }
});

test('pi picker paints live quota, off and unknown facts without offering off or unattributable IDs', async (t) => {
  const s = await setup(t);
  const model = (id) => ({ harness: 'pi', pi_role: 'implementer', split: false, model: id });
  const current = (id) => {
    saveRun(s, 'imp', [model(id)]);
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
  assert.equal(s.session.state.overlay.mode.picker.text, exhausted);
  let page = lines40(s).join('\n');
  assert.match(page, /^›   openai\/gpt-6.1-sol +✗ 42m$/m, 'a target not in the chain can be exhausted');
  assert.match(page, /^272K ctx {2}128K out {2}think ✓ {2}img –$/m);
  assert.doesNotMatch(page, /Selected|resets in/);
  const exact = () => {
    for (const lang of ['en', 'zh']) for (const panelLayout of ['classic']) {
      const frame = s.render(40, lang, withState(s.session.state, { prefs: { panelLayout } }), 16, s.session.snap, true, 'unicode', 'mocha');
      assert.equal(frame.lines.length, 16);
      assert.ok(frame.lines.every((line) => visualLength(line) === 40));
      assert.match(stripAnsi(frame.lines.at(-2)), lang === 'en' ? / ctx / : / 上下文 /);
    }
  };
  exact();
  assert.match(lines40(s, 'en', 9).join('\n'), /✗ 42m[\s\S]*^272K ctx/m, 'a short pane still shows the cursor and strip');
  const expired = plain(s.render(40, 'en', s.session.state, 20, s.session.snap, true, 'unicode', 'none', { nowMs: NOW + 42 * 60000 })).join('\n');
  assert.doesNotMatch(expired, /✗|resets in/);
  await s.press(ENTER);
  assert.equal(stored(s, 'imp').run[0].model, exhausted, 'an exhausted target remains selectable');
  for (const [id, row] of [
    ['grok-4.7', /^› ◉ grok-4\.7 +\?$/m],
    ['deepseek/deepseek-synthetic', /^› ◉ deepseek\/deepseek-synthetic +⊘$/m],
  ]) {
    current(id);
    focus(s);
    await s.press('m');
    page = lines40(s).join('\n');
    assert.match(page, row);
    if (id.startsWith('deepseek/')) assert.match(page, /1M ctx {2}96K out {2}think – {2}img ✓/);
    exact();
    const frame = s.frame(40, 'en', 60);
    const off = frame.panes[0].rows.filter((r) => r.text.includes('off: deepseek'));
    assert.equal(off.length, 1);
    assert.equal(off[0].modelHit, undefined);
    assert.equal((await s.press(ENTER)).action, undefined);
    assert.equal(stored(s, 'imp').run[0].model, id);
    assert.equal(s.session.state.overlay.mode.kind, 'quick-model', 'Enter on the read-only reference does not close');
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
  assert.match(failed, /Refresh failed/);
  assert.doesNotMatch(failed, /list 2h old/);
  const wide = plain(s.frame(120, 'en', 24)).join('\n');
  assert.match(wide, /list 2h old/);
  assert.match(wide, /Refresh failed/);
  assert.match(failed, /new-provider ─+ 1/);
  assert.doesNotMatch(failed, /Limited offline catalog/);
  const stale = collected({ pi: ['new-provider/new-model'], status: { pi: { failed: false, fetchedAt: NOW - 25 * 3600000 } } });
  assert.match(stale, /List is stale/);
  const empty = collected({ pi: [] });
  assert.match(empty, /\/ ▌ +0\n[\s\S]*No discovered models/);
  assert.doesNotMatch(empty, /Limited offline catalog|new-model|Refresh failed/);
});

test('an empty, stale or invalid run never writes half a chain, and a failed Save retains the draft', async (t) => {
  const s = await setup(t, { shippedImp: false });
  const file = join(s.hud, 'roles/imp.json'), original = fs.readFileSync(file, 'utf8');
  await s.keys(DEL, 's');
  assert.match(s.text(), /Not saved · needs a place to save/);
  assert.deepEqual(s.session.state.overlay.draft.run, []);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  await s.keys(ESC, ENTER, 'Nnightly', ENTER);
  const revision = s.session.state.overlay.role.revision;
  const invalid = editPreset(s.hud, s.cwd, s.env, { role: 'imp', revision, op: 'create', name: 'nightly', run: [
    { harness: 'pi', pi_role: 'implementer' }, { harness: 'cli', agent: 'not-a-supported-target' },
  ] });
  assert.match(invalid.reason, /bad cli fields/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), ownerChange: true }));
  const changed = fs.readFileSync(file, 'utf8'), inode = fs.statSync(file).ino;
  await s.press('s');
  assert.match(s.text(), /Role changed on disk; reopen the action/);
  assert.equal(s.session.state.overlay.draft.name, 'nightly');
  assert.equal(s.session.state.overlay.role.revision, revision);
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
  assert.match(s.text(), /◉ frontend → pi\/project +project/);
  assert.match(s.text(), /◉ imp → pi\/project +project/);
  const before = fs.readFileSync(join(s.cwd, '.hud/roles/imp.json'), 'utf8');
  s.session.state = select(s.session.state, 'project:role:imp');
  for (const raw of ['c', 'C', 'p', 'N', 'I', 'R', 'D', 'm']) {
    assert.equal((await s.press(raw)).action, undefined, raw);
    assert.equal(s.session.state.overlay, undefined);
  }
  assert.doesNotMatch(s.frame().lines.at(-1), /m model/);
  await s.press(ENTER);
  assert.match(s.text(), /pinned +project file · read-only here/);
  for (const raw of [ENTER, 'm', 'i', DEL, 'K', 's']) {
    assert.equal((await s.press(raw)).action, undefined, raw);
    assert.equal(s.session.state.overlay.mode.kind, 'places');
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

test('Control plane keys: decoded names, scoped to Control, Settings letters unchanged', async (t) => {
  const s = await setup(t);
  const decoder = new WorkbenchInputDecoder('workboard');
  const names = (raw) => decoder.push(Buffer.from(raw)).map((i) => i.key);
  assert.deepEqual([...'pPmMeEIiKJx', DEL].map((c) => names(c)[0]), ['preset-list', '', 'place-model', '', '', '', 'preset-empty',
    'place-add', 'place-up', 'place-down', 'place-clear', 'place-remove']);
  assert.deepEqual([...'srtjkq'].map((c) => names(c)[0]), ['settings-save', 'reset', '', 'down', 'up', 'close']);
  // The panel's own keyboard also types: a printable key carries its character (named or not), and a control key has none.
  const decoded = (raw, profile = 'workboard') => new WorkbenchInputDecoder(profile).push(Buffer.from(raw));
  assert.deepEqual(decoded('m'), [{ type: 'key', key: 'place-model', text: 'm' }]);
  assert.deepEqual(decoded('Z'), [{ type: 'key', key: '', text: 'Z' }]);
  assert.deepEqual(decoded('é-'), [{ type: 'key', key: '', text: 'é' }, { type: 'key', key: '', text: '-' }]);
  assert.deepEqual(decoded('\x7f'), [{ type: 'key', key: 'backspace' }]);
  assert.deepEqual(decoded('\r'), [{ type: 'key', key: 'enter' }]);
  assert.deepEqual(decoded('\x1b[B'), [{ type: 'key', key: 'down' }]);
  assert.deepEqual(decoded('Z', 'monitor'), []);
  // Elsewhere they do nothing: the hub, another page, a row of the Control plane that is not a place.
  for (const state of [onPage(), onPage('progress'), onControl({ cursor: 'project:fold:healthy' })]) {
    s.session.state = state;
    for (const raw of ['p', 'm', 'x', 'i']) assert.equal((await s.press(raw)).action, undefined);
  }
  s.session.state = initialMonitorState();
  assert.equal((await s.press('p')).action, undefined);
  assert.equal(s.session.state.activeTab, 'home');
});

test('40-col EN/ZH frames 5a–5e follow the Control sample', async (t) => {
  const s = await setup(t), nav = { cursor: 'project:role:imp' };
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
  for (const panelLayout of ['classic']) {
    s.session.state = onControl(nav);
    for (const [id, keys] of shots) {
      await s.keys(...[keys].flat());
      for (const lang of ['en', 'zh']) {
        const expected = controlSample(lang).frames.find((f) => f.id === id).frame.rows.map((row) => row.segs.map((s) => s.t).join(''));
        const view = s.render(40, lang, s.session.state, panelLayout === 'split' ? expected.length : 28, s.session.snap, true, 'unicode', 'none', {
          projectName: 'harbor-api', projects: PROJECTS, projectWaiting: 2,
        });
        assert.ok(view.lines.every((line) => visualLength(line) === 40));
        const actual = body(plain(view));
        // The original diagram predates clickable draft fields. Keep its layout/content checks,
        // but require the newer model affordance on its editable rows.
        const wanted = body(expected).map((row) => id === '5e' ? row.replace(/\b(grok-4\.7|gemini-4-hydrogen-high)\b/, '[$1 ▾]')
          : row.replace(/^(thinking|思考) (?:default|默认)$/, '$1'));
        if (panelLayout === 'split') assert.deepEqual(actual, wanted, `${id} ${lang}`);
        else assert.deepEqual(actual.slice(0, wanted.length), wanted, `${id} ${lang} Classic sheet`);
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
    assert.equal(asking.state.activeTab, 'control');
    assert.equal(asking.state.selectedProject, undefined);
    assert.equal(send(asking.state, 'escape').state.overlay.draft.name, 'dirty');
    const discarded = send(asking.state, 'enter');
    assert.equal(discarded.state.overlay, undefined);
    assert.equal(discarded.state.activeTab, expected);
    assert.equal(discarded.close, key === 'close');
    assert.equal(discarded.state.selectedProject, key === 'project-next' ? PROJECTS[1].root : undefined);
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
  s.put(join(s.hud, 'display/model-lists.json'), { version: 1, fetchedAt: Date.now(), pi: MODEL_LISTS.pi });
  const place = JSON.stringify({ state: { mainTab: 'project', projectPage: 'control', projectCursor: 'project:role:imp', projectFolded: new Set(['agents', 'files']) } },
    (_k, v) => (v instanceof Set ? { panelSet: [...v] } : v));
  const runner = join(s.root, 'live.mjs');
  fs.writeFileSync(runner, `import { runLivePage } from ${JSON.stringify(pathToFileURL(resolve('dist/tree-page.js')).href)};\nprocess.stdout.columns = 80;\nawait runLivePage();\nprocess.exit(0);\n`);
  const child = spawn(process.execPath, [runner], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...s.env, CODEX_HUD_STANDALONE_PANEL: '1', CODEX_HUD_CWD: s.cwd, HUD_PANEL_RELOAD_PLACE: place } });
  let out = '', err = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { err += b; });
  const exited = once(child, 'exit');
  s.stops.push(() => stopChild(child, exited));
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
  child.stdin.write('mopenai/gpt-6.1-sol\r');
  await until(() => /✓ imp #1 → openai\/gpt-6.1-sol/.test(stripAnsi(out)), 'one immediate save from the role row');
  assert.equal(stored(s, 'imp').run[0].model, 'openai/gpt-6.1-sol');
  out = '';
  child.stdin.write('m');
  await until(() => /imp #1 ─/.test(stripAnsi(out)), 'the quick picker reopened');
  const file = join(s.hud, 'roles/imp.json');
  s.put(file, { ...stored(s, 'imp'), ownerChange: true });
  const changed = fs.readFileSync(file);
  child.stdin.write('xai/grok-4.7\r');
  await until(() => /Role changed on disk; reopen the action/.test(stripAnsi(out)), 'the stale quick write was refused');
  assert.deepEqual(fs.readFileSync(file), changed);
  child.stdin.write('phydrogen\r');
  await until(() => stored(s, 'imp').active_preset === 'hydrogen', 'selected a preset');
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
  await exited;
  assert.equal(err, '');
});
