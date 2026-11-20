import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { projectFixture, pickerFrames, MAVERICK, plain, onPage, onControl, NOW, TREE, MODEL_LISTS } from '../fixtures/project-page.mjs';
import { handleMonitorInput, initialMonitorState } from '../../dist/render/monitor.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { editPlaces, placeItem } from '../../dist/roles/role-control.js';
import { setHarnessDisabled } from '../../dist/roles/harness-switches.js';
import { markExhausted, placeKey, roleRegistry, writeRolePlaces } from '../../dist/roles/roster.js';

const mcpEntry = resolve('packages/hud-mcp/bin/hud-mcp.mjs');
function select(state, item) {
  const projectFolded = new Set(state.controlNav?.projectFolded ?? ['healthy', 'usage', 'files', 'agents']);
  const role = /^project:role:([^:]+):\d+$/.exec(item)?.[1];
  if (role) projectFolded.add(`role:${role}`);
  return { ...state, controlNav: { ...state.controlNav, projectCursor: item, projectFolded } };
}

/** The synthetic Project fixture with every CLI and browser tool but `codex` and `jev-flow` on PATH, and the shipped `imp`. */
async function setup(t, { shippedImp = true, healthyOpen = true } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'role-control-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await projectFixture(root);
  for (const name of ['herdr', 'agy', 'claude', 'grok', 'jev-aistudio'])
    fs.writeFileSync(join(root, 'bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  if (shippedImp) fs.rmSync(join(f.hud, 'roles/imp.json'));
  const session = { state: healthyOpen ? select(onControl(), placeItem('imp', 0)) : onControl(), snap: await f.collector.collect(true, f.board, NOW), done: null };
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
      if (session.done.ok) session.state = select(session.state, placeItem(edit.role, session.done.index));
      // As the panel does: the roles are read again at once, the full collection follows the key.
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
const UP = '\x1b[A', DOWN = '\x1b[B', ENTER = '\r', ESC = '\x1b', TAB = '\t', BACKSPACE = '\x7f';
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
test('Control plane previews the selected place in full, even when the role list scrolls', async (t) => {
  const s = await setup(t);
  const model = 'synthetic-provider/very-long-model-identifier-for-place-preview-20261117';
  const exhausted = { harness: 'cli', agent: 'claude', model, thinking: 'high' };
  writeRolePlaces(s.hud, 'reviewer', [exhausted, { harness: 'pi', pi_role: 'reviewer', split: false },
    { harness: 'cli', agent: 'agy', model: 'synthetic-fallback', thinking: 'low' }]);
  markExhausted(s.hud, placeKey(exhausted), 'quota exceeded', NOW);
  s.collector.refreshRoles(s.session.snap, NOW);
  const before = stored(s, 'reviewer');
  s.session.state = select(onControl(), placeItem('reviewer', 0));
  const draw = () => s.frame(40, 'en', 24);
  const choose = (frame, input) => {
    const out = handleMonitorInput(frame.state, input, { tree: TREE, frame, nowMs: NOW, standalone: true });
    assert.equal(out.action, undefined);
    s.session.state = out.state;
    return draw();
  };
  let frame = draw();
  assert.equal(frame.state.controlNav.projectCursor, placeItem('reviewer', 0));
  const lines = plain(frame), chain = lines.findIndex((line) => /^ {4}1 ✗/.test(line));
  assert.ok(chain > lines.findIndex((line) => /✗ reviewer/.test(line)));
  assert.match(lines.join('\n'), /source +yours · reviewer\.json/);
  assert.ok(lines.slice(chain).map((line) => line.trim()).join('').includes(model), 'the entire long model wraps in the chain');
  frame = choose(frame, { type: 'key', key: 'down' });
  assert.equal(frame.state.controlNav.projectCursor, placeItem('reviewer', 1));
  const y = plain(frame).findIndex((line) => /3 ○ agy/.test(line));
  assert.ok(y > 0);
  frame = choose(frame, { type: 'mouse', button: 'left', x: 4, y });
  assert.equal(frame.state.controlNav.projectCursor, placeItem('reviewer', 2));
  const zh = s.frame(38, 'zh', 24);
  assert.match(plain(zh).join('\n'), /^ {4}3 ○ agy synthetic-fallback low$/m);
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
  assert.doesNotMatch(s.text(), /^ {4}1 ◉/m);
  assert.deepEqual((await s.press('o')).action, { type: 'open-files', files: [resolve('packages/hud-mcp/roles/imp.json')] });
  await s.press(ENTER);
  assert.match(s.text(), /^ {4}1 ◉ pi synthetic\/model high$/m);
  assert.match(s.text(), /^ {4}2 ○/m);
  assert.match(s.text(), /source +default · imp\.json/);
  await s.press(ESC);
  assert.doesNotMatch(s.text(), /^ {4}1 ◉/m);
});
test('a key on a place is written to the role file and is what the roster, hud_roster and so the next hud_create use', async (t) => {
  const s = await setup(t);
  assert.equal(s.assignment('imp').runs_on.harness, 'pi');
  // Keep this place-edit exercise on one primary; presets themselves are exercised below.
  s.session.state = select(s.session.state, placeItem('imp', 1));
  await s.press('\x1b[3~');
  // p: the harness of the primary place. The shipped table gives the agent its model; a CLI place has no pi role.
  await s.press('p');
  assert.deepEqual(s.session.done, { ok: true, index: 0 });
  let imp = s.assignment('imp');
  assert.deepEqual([imp.harness, imp.agent, imp.model, imp.runs_on.agent, imp.available], ['cli', 'agy', 'gemini-4-argon-high', 'agy', true]);
  assert.equal(imp.source_file, join(s.hud, 'roles/imp.json'));
  assert.match(s.text(), /◉ imp \[Custom\] → agy/);
  assert.match(s.text(), /1 ◉ agy gemini-4-argon-high/);
  const file = join(s.hud, 'roles/imp.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(join(s.hud, 'roles')).filter((n) => n.endsWith('.tmp')), []);
  // m opens the model picker over the page and writes nothing; the arrows pick, Enter sets the model, Esc leaves it as it was.
  await s.press('m');
  assert.deepEqual([s.session.state.projectInput.role, s.session.state.projectInput.index], ['imp', 0]);
  assert.equal(s.assignment('imp').model, 'gemini-4-argon-high', 'opening the picker writes nothing');
  assert.match(s.text(), /^imp · agy ─+ model$/m);
  await s.keys(DOWN, ENTER);
  assert.deepEqual(s.session.done, { ok: true, index: 0 });
  assert.equal(s.assignment('imp').model, 'gemini-4-hydrogen-high');
  assert.equal(s.session.state.projectInput, undefined, 'Enter closes the picker');
  await s.keys('M', UP, ESC);
  assert.equal(s.assignment('imp').model, 'gemini-4-hydrogen-high');
  assert.equal(s.session.state.projectInput, undefined, 'Esc closes it too, and M opened it the same as m');
  await s.keys('m', UP, ENTER);
  assert.equal(s.assignment('imp').model, 'gemini-4-argon-high');
  // e: the catalog's next thinking; the capital goes back, and past the first comes "unset".
  await s.press('e');
  assert.equal(s.assignment('imp').thinking, 'low');
  await s.press('E');
  assert.equal(s.assignment('imp').thinking, null);
  assert.equal(stored(s, 'imp').run[0].thinking, undefined);
  await s.press('p');
  imp = s.assignment('imp');
  assert.deepEqual([imp.agent, imp.model, imp.thinking], ['claude', 'opus', 'high']);
  await s.press('P');
  assert.equal(s.assignment('imp').agent, 'agy');
  // +: a fallback after the last place, the cursor on it; K and J move it; - removes it.
  await s.press('i');
  assert.deepEqual(s.session.done, { ok: true, index: 1 });
  assert.equal(s.session.state.controlNav.projectCursor, placeItem('imp', 1));
  assert.equal(s.frame().state.controlNav.projectCursor, placeItem('imp', 1), 'the cursor is on the new row in the very next frame');
  assert.deepEqual(stored(s, 'imp').run.map((p) => p.harness === 'pi' ? 'pi' : p.agent), ['agy', 'pi']);
  assert.match(s.text(), /2 ○ pi synthetic\/model high/);
  await s.press('K');
  assert.deepEqual(stored(s, 'imp').run.map((p) => p.harness === 'pi' ? 'pi' : p.agent), ['pi', 'agy']);
  assert.equal(s.session.state.controlNav.projectCursor, placeItem('imp', 0));
  imp = s.assignment('imp');
  assert.deepEqual([imp.harness, imp.runs_on.harness], ['pi', 'pi']);
  await s.press('K');
  assert.deepEqual(s.session.done, { ok: true, index: 0 }, 'at the top K stays and writes nothing');
  await s.press('J');
  assert.equal(s.session.state.controlNav.projectCursor, placeItem('imp', 1));
  await s.press('\x1b[3~');
  assert.equal(stored(s, 'imp').run.length, 1);
  await s.press('\x1b[3~');
  assert.equal(s.session.done.message, 'keep at least one place');
  assert.equal(stored(s, 'imp').run.length, 1);
  // x: an exhausted mark goes, and the place is in use again.
  await s.press('i');
  const first = stored(s, 'imp').run[0];
  markExhausted(s.hud, placeKey({ harness: 'cli', agent: first.agent, model: first.model }), 'HTTP 429', NOW);
  s.session.snap = await s.collector.collect(true, s.board, NOW);
  assert.equal(s.assignment('imp').runs_on.harness, 'pi', 'the next place is in use while the first is exhausted');
  assert.match(s.text(), /✗ imp \[[^\]]+\] → pi/);
  s.session.state = select(s.session.state, placeItem('imp', 0));
  await s.press('x');
  assert.equal(s.assignment('imp').runs_on.agent, 'agy');
  assert.match(s.text(), /◉ imp \[[^\]]+\] → agy/);
  await s.press('x');
  assert.equal(s.session.done.message, 'not marked exhausted');
  // The MCP reads the same files: hud_roster shows what the page shows.
  const other = join(s.root, 'plain-cwd');
  fs.mkdirSync(other);
  const child = spawn(process.execPath, [mcpEntry], { cwd: other, env: { ...process.env, HUD_MCP_SURFACE: 'roles', HUD_HOME: s.hud, PATH: s.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { child.stdin.end(); await once(child, 'exit'); });
  const reply = new Promise((done) => createInterface({ input: child.stdout }).once('line', (line) => done(JSON.parse(line))));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hud_roster', arguments: { detail: true } } }) + '\n');
  const roster = JSON.parse((await reply).result.content[0].text).roles.find((r) => r.role === 'imp');
  assert.deepEqual([roster.harness, roster.agent, roster.model, roster.available, roster.runs_on.agent], ['cli', 'agy', 'gemini-4-argon-high', true, 'agy']);
  assert.equal(roster.run.length, 2);
});

test('c/C apply a whole role preset through the real key path; rows show default, named and custom; marks stay per place', async (t) => {
  const s = await setup(t);
  assert.match(s.text(), /imp \[default\]/);
  assert.match(plain(s.frame(120)).at(-1), /c C preset/);
  await s.press('c');
  assert.deepEqual(s.session.done, { ok: true, index: 0 });
  assert.equal(s.assignment('imp').preset, 'grok');
  assert.deepEqual(stored(s, 'imp').run, s.assignment('imp').presets[1].run);
  assert.match(s.text(), /imp \[grok\]/);
  markExhausted(s.hud, 'pi:xai/grok-4.7', 'quota exceeded', NOW);
  await s.press('c');
  assert.match(s.text(), /imp \[hydrogen\]/);
  await s.press('C');
  assert.match(s.text(), /− imp \[grok\] → none/);
  assert.equal(s.assignment('imp').exhausted.length, 1);
  await s.press('C');
  await s.press('e');
  assert.match(s.text(), /imp \[Custom\]/);
  await s.press('c');
  assert.equal(s.assignment('imp').preset, 'default', 'custom starts at first');
  assert.match(s.text(), /sonic \[Custom\]/);
  s.session.state = select(s.session.state, placeItem('sonic', 0));
  await s.press('c');
  assert.equal(fs.existsSync(join(s.hud, 'roles/sonic.json')), false, 'no presets writes nothing');
});

test('browser places: p walks the web models, a second place can be promoted, a Flow place cycles its kind', async (t) => {
  const s = await setup(t);
  s.session.state = select(s.session.state, placeItem('pro', 0));
  await s.press('p');
  assert.deepEqual([s.assignment('pro').runs_on.provider, s.assignment('pro').runs_on.tool], ['gemini', 'jev-ask']);
  await s.press('p');
  assert.equal(s.assignment('pro').runs_on.tool, 'jev-aistudio');
  await s.press('P');
  await s.press('P');
  assert.equal(s.assignment('pro').runs_on.provider, 'chatgpt');
  assert.equal(s.assignment('pro').runs_on.model, '6 Pro');
  s.session.state = select(s.session.state, placeItem('pro', 1));
  await s.press('K');
  assert.deepEqual(stored(s, 'pro').run.map((p) => p.provider ?? p.tool), ['gemini', 'chatgpt', 'jev-aistudio']);
  assert.equal(s.assignment('pro').runs_on.provider, 'gemini');
  // thinking has no meaning in the browser; a model with nothing to choose says so.
  await s.press('e');
  assert.equal(s.session.done.message, 'no thinking setting here');
  await s.press('m');
  assert.equal(s.session.done.message, 'no other model to pick');
  s.session.state = select(s.session.state, placeItem('flow', 0));
  await s.press('m');
  assert.equal(stored(s, 'flow').run[0].kind, 'video');
  assert.match(s.text(), /flow video\n +not installed/);
  await s.press('p');
  assert.equal(s.session.done.message, 'no other harness for this role');
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
  assert.match(page, new RegExp(`/ ▌ +${MODEL_LISTS.pi.length} matches`));
  await s.keys('ANTH');
  page = lines40(s).join('\n');
  assert.match(page, /\/ ANTH▌ +8 matches/);
  assert.match(page, /^anthropic ─+ 7\n[\s\S]*^arena ─+ 1/m);
  assert.match(page, /claude-opus-5-5-20261101/);
  assert.doesNotMatch(page, /openai/);
  await s.keys(ESC, 'm', 'XAI/GROK-4.7', ENTER);
  assert.deepEqual(s.session.done, { ok: true, index: 0 });
  assert.equal(stored(s, 'imp').run[0].model, 'xai/grok-4.7');
  assert.equal(s.assignment('imp').model, 'xai/grok-4.7');
  assert.equal(s.session.state.projectInput, undefined);
  assert.equal(s.session.state.controlNav.projectCursor, placeItem('imp', 0));
  assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')), legacy);
  const roleFile = join(s.hud, 'roles/imp.json'), before = fs.readFileSync(roleFile);
  setHarnessDisabled(s.hud, 'pi:xai', true);
  s.collector.refreshRoles(s.session.snap, NOW);
  assert.equal(s.assignment('imp').places[0].state, 'off');
  await s.keys('m', 'grok');
  page = lines40(s).join('\n');
  assert.match(page, /current  xai\/grok-4.7/);
  assert.match(page, /\/ grok▌ +2 matches/);
  assert.doesNotMatch(page, /^xai ─/m);
  assert.equal(s.registry().routing(NOW).byId.get('grok-4.7'), null, 'attribution still sees both providers');
  await s.press(ESC);
  setHarnessDisabled(s.hud, 'pi:xai', false);
  s.collector.refreshRoles(s.session.snap, NOW);
  await s.keys('m', 'grok', DOWN, DOWN, DOWN);
  page = lines40(s).join('\n');
  assert.match(page, /\/ grok▌ +5 matches/);
  assert.match(page, /^arena ─+ 2\n[\s\S]*^xai ─+ 3\n  ◉ grok-4.7\n›   grok-4.7-fast/m);
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
  await s.keys('m', 'new-provider/aaa', TAB, ENTER);
  assert.equal(stored(s, 'imp').run[0].model, long, 'the full 128-character ID survives the edit');
  await s.keys('m', 'custom/pi-next', ENTER);
  assert.match(lines40(s).join('\n'), /0 matches\n +No matching models/);
  assert.equal(s.session.state.projectInput.text, 'custom/pi-next');
  assert.equal(stored(s, 'imp').run[0].model, long);
  await s.press(BACKSPACE);
  assert.equal(s.session.state.projectInput.text, 'custom/pi-nex');
  await s.press(ESC);
  setHarnessDisabled(s.hud, 'pi:synthetic', true);
  s.collector.refreshRoles(s.session.snap, NOW);
  await s.keys('m', '\x1b[H');
  assert.doesNotMatch(lines40(s).join('\n'), /default →|from pi role/);
  await s.press(ESC);
  setHarnessDisabled(s.hud, 'pi:synthetic', false);
  s.collector.refreshRoles(s.session.snap, NOW);
  await s.keys('m', '\x1b[H', ENTER);
  assert.equal(stored(s, 'imp').run[0].model, undefined);
  assert.equal(s.assignment('imp').model, 'synthetic/model');
  await s.press('m');
  for (const raw of ['q', 'p', 'e', 'i', 'r', 'K', 'o', 'j']) {
    const out = await s.press(raw);
    assert.deepEqual([out.action, out.close], [undefined, false], raw);
  }
  assert.equal(s.session.state.projectInput.text, 'qpeirKoj');
  const view = s.frame();
  const click = handleMonitorInput(view.state, { type: 'mouse', button: 'left', x: 3, y: 3 }, { tree: TREE, frame: view, nowMs: NOW, standalone: true });
  assert.equal(click.state.projectInput, undefined);
  assert.equal(click.action, undefined);
});
test('the model picker on a CLI place lists that harness\'s models at once, one line each; a long line, a narrow panel and Chinese keep every row exact', async (t) => {
  const s = await setup(t);
  discover(s);
  await s.press('p');
  assert.equal(s.assignment('imp').agent, 'agy');
  await s.press('m');
  let page = lines40(s).join('\n');
  assert.match(page, /^imp · agy ─+ model$/m, 'no provider level for agy: its models at once');
  assert.match(page, /^ {4}default\n› ◉ gemini-4-argon-high\n {4}gemini-4-hydrogen-high\n {4}gemini-3\.8-flash-high$/m);
  // The list filters on any part of a model; Enter on a match sets it, a miss sets what was typed.
  await s.keys('flash', ENTER);
  assert.equal(stored(s, 'imp').run[0].model, 'gemini-3.8-flash-high');
  await s.keys('m', 'next-one', ENTER);
  assert.equal(stored(s, 'imp').run[0].model, 'next-one');
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
  assert.match(zh.at(-1), /输入筛选 +↑↓ 选择 +⏎ 设置 +esc 取消/);
  assert.match(plain(s.frame(40, 'en', 14)).at(-1), /type filter +↑↓ pick +⏎ set +esc cancel/);
  assert.doesNotMatch(plain(s.frame(120, 'en', 14)).at(-1), /tab all|← back/);
  // Help says what m does now, and the key row for p e.
  s.session.state = { ...initialMonitorState(), help: true };
  const help = plain(s.frame(80, 'en', 40)).join('\n').replace(/\n {8}/g, ' ');
  assert.match(help, /^p e +place: harness, thinking \(capitals go back\)/m);
  assert.match(help, /^m +pick model; pi groups; type to filter/m);
});
test('40-column picker sample: same grouped, filtered and long-ID frames in Classic and Split', async (t) => {
  const s = await setup(t);
  const frames = pickerFrames(s);
  assert.deepEqual(frames, pickerFrames(s, undefined, 'classic'));
  for (const lang of ['en', 'zh']) {
    const grouped = frames[`pick-grouped-40-${lang}`].join('\n');
    assert.match(grouped, /openai\/gpt-6.1-sol\n +(?:来自 pi 设置|from pi settings)/);
    assert.ok(grouped.indexOf('anthropic ─') < grouped.indexOf('arena ─'));
    const filtered = frames[`pick-filter-40-${lang}`].join('\n');
    assert.match(filtered, /\/ grok▌ +5 (?:个匹配|matches)/);
    assert.match(filtered, /arena ─+ 2[\s\S]*xai ─+ 3\n  ◉ grok-4.7\n›   grok-4.7-fast/);
    const long = frames[`pick-long-40-${lang}`];
    assert.match(long.join('\n'), /^› +meta-llama\/.*….*-fp8$/m);
    const detail = long.findIndex((row) => /full ID under the cursor|所选的完整 ID/.test(row));
    assert.equal(long.slice(detail + 1, -1).map((row) => row.trim()).join(''), `${MAVERICK}-fp8`);
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
  assert.match(empty, /0 matches[\s\S]*No discovered models/);
  assert.doesNotMatch(empty, /Limited offline catalog|new-model|Refresh failed/);
});

test('editPlaces sets a model id exactly as typed, clears it with an empty one, and refuses what is no model id or no model place', async (t) => {
  const s = await setup(t);
  const edit = (role, value, index = 0) => editPlaces(s.hud, s.cwd, s.env, { role, index, op: 'model', value }, NOW);
  assert.deepEqual(edit('imp', 'anthropic/claude-opus-5-5'), { ok: true, index: 0 });
  assert.equal(stored(s, 'imp').run[0].model, 'anthropic/claude-opus-5-5');
  assert.deepEqual(edit('imp', '  openai/gpt-6.1-sol  '), { ok: true, index: 0 });
  assert.equal(stored(s, 'imp').run[0].model, 'openai/gpt-6.1-sol');
  assert.deepEqual(edit('imp', ''), { ok: true, index: 0 });
  assert.equal('model' in stored(s, 'imp').run[0], false, 'an empty one drops the model: the role is on its default');
  for (const bad of ['x'.repeat(129), 'a\nb', 'a\x1b[31mb', 'a\x00b']) {
    const done = edit('imp', bad);
    assert.deepEqual([done.ok, done.message], [false, 'not a model id'], JSON.stringify(bad));
  }
  assert.equal('model' in stored(s, 'imp').run[0], false, 'a refused edit writes nothing');
  assert.equal(edit('flow', 'whatever').ok, false, 'a Flow place has a kind, not a model');
  assert.equal(edit('flow', 'whatever').message, 'no model for this place');
  assert.equal(edit('nobody', 'x').ok, false);
  assert.equal(edit('imp', 'x', 5).ok, false);
});
test('Enter and o on a place open the role file in force, a fallback row included', async (t) => {
  const s = await setup(t);
  s.session.state = select(s.session.state, placeItem('pro', 2));
  const shipped = resolve('packages/hud-mcp/roles/pro.json');
  for (const raw of ['\r', 'o']) assert.deepEqual((await s.press(raw)).action, { type: 'open-files', files: [shipped] });
  // After a switch the file in force is the owner's.
  s.session.state = select(s.session.state, placeItem('imp', 0));
  await s.press('e');
  for (const raw of ['\r', 'o']) assert.deepEqual((await s.press(raw)).action, { type: 'open-files', files: [join(s.hud, 'roles/imp.json')] });
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
  s.session.state = select(s.session.state, placeItem('imp', 0));
  for (const raw of ['p', 'm', 'e', 'i', '\x1b[3~', 'K', 'c', 'C']) {
    await s.press(raw);
    assert.deepEqual(s.session.done, { ok: false, message: 'the project file is in force: o opens it' }, raw);
  }
  // A mark is not in a role file: clearing one works on a project role too.
  markExhausted(s.hud, placeKey({ harness: 'pi', model: 'project/model' }), 'HTTP 429', NOW);
  s.session.snap = await s.collector.collect(true, s.board, NOW + 1);
  s.session.state = select(s.session.state, placeItem('frontend', 0));
  assert.match(s.text(), /− frontend/);
  await s.press('x');
  assert.deepEqual(s.session.done, { ok: true, index: 0 });
  assert.match(s.text(), /◉ frontend/);
  assert.equal(fs.readFileSync(join(s.cwd, '.hud/roles/imp.json'), 'utf8'), before);
  assert.equal(fs.existsSync(join(s.hud, 'roles/imp.json')), false);
  assert.equal(fs.existsSync(join(s.hud, 'roles/frontend.json')), false);
  s.session.state = select(s.session.state, placeItem('imp', 0));
  assert.deepEqual((await s.press('o')).action, { type: 'open-files', files: [join(root, '.hud/roles/imp.json')] });
});

test('the first switch of an older single-place role file keeps its instructions and launch options, and refuses to rebuild them', async (t) => {
  const s = await setup(t, { shippedImp: false });
  // The fixture's imp is the old format: one place at the top level, split on.
  assert.equal(s.assignment('imp').instructions, 'implementer');
  await s.press('p');
  assert.equal(s.session.done.message, 'launch options are set in the file: o opens it');
  assert.equal(stored(s, 'imp').run, undefined, 'a refused key writes nothing');
  await s.keys('m', 'openai/gpt-6.1-sol', ENTER);
  const written = stored(s, 'imp');
  assert.equal(written.instructions, 'implementer');
  assert.equal(written.harness, undefined);
  assert.deepEqual(written.run, [{ harness: 'pi', pi_role: 'implementer', split: true, model: 'openai/gpt-6.1-sol' }]);
  assert.equal(written.can_continue, true);
  const imp = s.assignment('imp');
  assert.deepEqual([imp.instructions, imp.split, imp.model, imp.thinking], ['implementer', true, 'openai/gpt-6.1-sol', 'high']);
  // Keys the owner added to a place survive a model switch.
  fs.writeFileSync(join(s.hud, 'roles/imp.json'), JSON.stringify({ ...written, run: [{ ...written.run[0], note: 'keep-me' }] }));
  await s.keys('m', 'openai/gpt-6-astra', ENTER);
  assert.equal(stored(s, 'imp').run[0].note, 'keep-me');
  assert.equal(stored(s, 'imp').run[0].model, 'openai/gpt-6-astra');
});

test('Control plane keys: decoded names, only on a place row of the Control plane, Settings letters unchanged', async (t) => {
  const s = await setup(t);
  const decoder = new WorkbenchInputDecoder('workboard');
  const names = (raw) => decoder.push(Buffer.from(raw)).map((i) => i.key);
  assert.deepEqual([...'pPmMeEiKJx', '\x1b[3~'].map((c) => names(c)[0]), ['place-harness', 'place-harness-prev', 'place-model', 'place-model-prev',
    'place-thinking', 'place-thinking-prev', 'place-add', 'place-up', 'place-down', 'place-clear', 'place-remove']);
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

test('the live panel applies a Control plane key to the role files, and says why one cannot', async (t) => {
  const s = await setup(t);
  const root = fs.realpathSync(s.cwd);
  s.put(join(s.hud, 'projects.json'), { version: 1, projects: [{ root, registered_at: '2026-11-13T00:00:00.000Z' }] });
  s.put(join(s.cwd, '.hud/roles/frontend.json'), { role: 'frontend', harness: 'pi', pi_role: 'implementer', split: false, can_continue: true, model: 'project/model' });
  s.put(join(s.cwd, '.hud/project.json'), { version: 1, roles: ['imp', 'frontend', 'sonic'] });
  s.put(join(s.hud, 'hud-settings.json'), { modelEnabled: false, refreshMs: 100, language: 'en' });
  const place = JSON.stringify({ state: { ...initialMonitorState(), mainTab: 'project', projectPage: 'control', projectCursor: placeItem('imp', 0), projectFolded: new Set(['agents', 'files']) } },
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
  // m opens the grouped picker; Enter sets the model and only then writes a file.
  child.stdin.write('m');
  await until(() => /Model ─/.test(stripAnsi(out)), 'the picker');
  assert.equal(fs.existsSync(join(s.hud, 'roles/imp.json')), false, 'opening it writes nothing');
  child.stdin.write('openai/gpt-6.1-sol\r');
  await until(() => fs.existsSync(join(s.hud, 'roles/imp.json')) && stored(s, 'imp').run[0].model === 'openai/gpt-6.1-sol', 'the model written');
  // Down to the project's own role: imp's fallback, sonic, then frontend; open its chain and attempt an edit.
  const mark = out.length;
  child.stdin.write('jjj\rjp');
  // The panel here is 30 columns wide, so the notice is cut to what fits.
  await until(() => /the project file is in/.test(stripAnsi(out.slice(mark))), 'the notice');
  assert.equal(fs.existsSync(join(s.hud, 'roles/frontend.json')), false);
  child.stdin.write('q');
  await once(child, 'exit');
  assert.equal(err, '');
});
