import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { projectFixture, plain, onPage, NOW, TREE, MODEL_LISTS } from '../fixtures/project-page.mjs';
import { handleMonitorInput, initialMonitorState } from '../../dist/render/monitor.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { editPlaces, placeItem } from '../../dist/roles/role-control.js';
import { markExhausted, placeKey, roleRegistry, writeRolePlaces } from '../../dist/roles/roster.js';

const mcpEntry = resolve('packages/hud-mcp/bin/hud-mcp.mjs');

/** The synthetic Project fixture with every CLI and browser tool but `codex` and `jev-flow` on PATH, and the shipped `imp`. */
async function setup(t, { shippedImp = true, healthyOpen = true } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'role-control-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await projectFixture(root);
  for (const name of ['herdr', 'agy', 'claude', 'grok', 'jev-aistudio'])
    fs.writeFileSync(join(root, 'bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  if (shippedImp) fs.rmSync(join(f.hud, 'roles/imp.json'));
  // The page starts with the healthy roles folded; most of what is tried here is on a healthy role's row, so they start open.
  const folded = healthyOpen ? new Set(['agents', 'files']) : undefined;
  const session = { state: onPage('control', { projectCursor: placeItem('imp', 0), ...(folded ? { projectFolded: folded } : {}) }), snap: await f.collector.collect(true, f.board, NOW), done: null };
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
      if (session.done.ok) session.state = { ...session.state, projectCursor: placeItem(edit.role, session.done.index) };
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
  assert.deepEqual(s.rows().map((r) => r.item), ['pro:0', 'pro:1', 'flow:0'].map((x) => `project:role:${x}`));
  assert.match(lines[at(/^Needs attention ─/)], / 3$/);
  assert.match(lines[at(/ pro /)], /^ {2}✗ pro +chatgpt exhausted 60m$/);
  assert.match(lines[at(/ pro /) + 1], /^ {6}next job → ◉ gemini$/);
  assert.match(lines[at(/ flow /)], /^ {2}− flow +flow image not installed$/);
  assert.match(lines[at(/bad\.json/)], /^ {2}! bad\.json +unparseable JSON$/);
  assert.match(lines[at(/^▸ Healthy ─/)], / 5$/);
  assert.match(lines[at(/^▸ Healthy ─/) + 1], /^ {2}◉ imp reviewer sonic architect oracle$/);
  assert.ok(at(/^Needs attention ─/) < at(/^▸ Healthy ─/) && at(/^▸ Healthy ─/) < at(/^Harnesses ─/));
  assert.doesNotMatch(lines.join('\n'), /synthetic\/model|^Roles ─|^Browser tasks ─/m);
  assert.match(lines[at(/^Harnesses ─/) + 1], /pi ✓ +agy ✓ +claude ✓ +codex − +grok ✓ +jev-ask ✓ +jev-aistudio ✓ +jev-flow −/);
  assert.match(lines.join('\n'), /◉ in use +○ standby +✗ exhausted +− not installed/);
  // One line a row at every width and language; at 40 columns a long model is cut in the middle, never the harness or the thinking.
  for (const lang of ['en', 'zh'])
    for (const width of [32, 40, 56, 80, 120])
      for (const state of [onPage('control'), onPage('control', { projectFolded: new Set(['agents']) })]) {
        s.session.state = state;
        const view = s.frame(width, lang, 64);
        for (const line of view.lines) assert.equal(visualLength(line), width, stripAnsi(line));
        for (const row of view.workboard.rows) assert.doesNotMatch(row.text, /\n/);
      }
  s.session.state = onPage('control');
  const narrow = plain(s.frame(40, 'zh', 64)).join('\n');
  assert.match(narrow, /^需要处理 ─+ 3$/m);
  assert.match(narrow, /^ {2}✗ pro +chatgpt 已耗尽 60分钟$/m);
  assert.match(narrow, /^ {6}下个任务 → ◉ gemini$/m);
  assert.match(narrow, /^▸ 正常 ─+ 5$/m);
  assert.match(narrow, /◉ 使用中 +○ 备选 +✗ 已耗尽/);
  // `next job` is a stop that takes the place keys, for the place it names; the healthy roles are one Enter away.
  s.session.state = { ...s.session.state, projectCursor: placeItem('pro', 1) };
  await s.press('m');
  assert.deepEqual([s.session.done.message, s.session.state.projectInput], ['no other model to pick', undefined], 'a web place with no model to choose opens no picker');
  await s.press('p');
  assert.equal(s.assignment('pro').runs_on.tool, 'jev-aistudio', 'the key acts on the place the row names');
  // The healthy roles are one Enter away, and all one row a place again.
  s.session.state = { ...s.session.state, projectCursor: 'project:fold:healthy' };
  await s.press('\r');
  assert.deepEqual(s.rows().map((r) => r.item).filter((i) => !/role:(pro|flow):/.test(i)), ['imp:0', 'reviewer:0', 'reviewer:1', 'sonic:0', 'architect:0', 'oracle:0', 'oracle:1'].map((x) => `project:role:${x}`));
  assert.match(s.text(), /^Healthy ─+ 5$/m);
  await s.press('\r');
  assert.match(s.text(), /^▸ Healthy ─+ 5$/m, 'Enter again folds them');
});
test('Control plane, opened: each role once with its place and fallbacks, browser tasks apart', async (t) => {
  const s = await setup(t);
  writeRolePlaces(s.hud, 'reviewer', [{ harness: 'pi', pi_role: 'reviewer', split: false }, { harness: 'cli', agent: 'claude', model: 'opus', thinking: 'high' }]);
  s.session.snap = await s.collector.collect(true, s.board, NOW);
  // Nothing is exhausted here, but flow has nowhere to run: it is the one role up top; everyone else is a healthy place row.
  assert.deepEqual(s.rows().map((r) => r.item), ['flow:0', 'imp:0', 'reviewer:0', 'reviewer:1', 'sonic:0', 'architect:0', 'oracle:0', 'oracle:1', 'pro:0', 'pro:1', 'pro:2'].map((x) => `project:role:${x}`));
  const lines = plain(s.frame(80, 'en', 64));
  const at = (re) => lines.findIndex((l) => re.test(l));
  // Groups in order under Healthy; pro only under Browser tasks; the harnesses after them.
  assert.ok(at(/^Healthy ─/) < at(/^Roles ─/) && at(/^Roles ─/) < at(/ imp /) && at(/ oracle /) < at(/^Browser tasks ─/));
  assert.ok(at(/^Browser tasks ─/) < at(/ pro /) && at(/ pro /) < at(/^Harnesses ─/));
  // Wide rows say whose file is in force: the shipped one, or the owner's once a switch (or the reviewer's fallback) wrote it.
  assert.match(lines[at(/ imp /)], /◉ imp +pi +synthetic\/model +high +default$/);
  assert.match(lines[at(/ reviewer /)], /◉ reviewer +pi +default +yours$/);
  assert.match(lines[at(/ reviewer /) + 1], /○ ↳ +claude +opus +high/);
  assert.match(lines[at(/ oracle /)], /◉ oracle +claude +fable +default$/);
  assert.match(lines[at(/ oracle /) + 1], /○ ↳ +pi +default/);
  assert.match(lines[at(/ pro /)], /◉ pro +chatgpt +6 Pro/);
  assert.match(lines[at(/ pro /) + 1], /○ ↳ +gemini/);
  assert.match(lines[at(/ pro /) + 2], /○ ↳ +aistudio +gemini-4-argon/);
  // flow is a role with nowhere to run, so it is under Needs attention with the kind of its place, not among the healthy ones.
  assert.match(lines[at(/^Needs attention ─/) + 1], /^ {2}− flow +flow image not installed$/);
});
test('a key on a place is written to the role file and is what the roster, hud_roster and so the next hud_create use', async (t) => {
  const s = await setup(t);
  assert.equal(s.assignment('imp').runs_on.harness, 'pi');
  // p: the harness of the primary place. The shipped table gives the agent its model; a CLI place has no pi role.
  await s.press('p');
  assert.deepEqual(s.session.done, { ok: true, index: 0 });
  let imp = s.assignment('imp');
  assert.deepEqual([imp.harness, imp.agent, imp.model, imp.runs_on.agent, imp.available], ['cli', 'agy', 'gemini-4-argon-high', 'agy', true]);
  assert.equal(imp.source_file, join(s.hud, 'roles/imp.json'));
  assert.match(s.text(), /◉ imp +agy +gemini-4-argon-high/);
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
  await s.press('+');
  assert.deepEqual(s.session.done, { ok: true, index: 1 });
  assert.equal(s.session.state.projectCursor, placeItem('imp', 1));
  assert.equal(s.frame().state.projectCursor, placeItem('imp', 1), 'the cursor is on the new row in the very next frame');
  assert.deepEqual(stored(s, 'imp').run.map((p) => p.harness === 'pi' ? 'pi' : p.agent), ['agy', 'pi']);
  assert.match(s.text(), /○ ↳ +pi +synthetic\/model +high/);
  await s.press('K');
  assert.deepEqual(stored(s, 'imp').run.map((p) => p.harness === 'pi' ? 'pi' : p.agent), ['pi', 'agy']);
  assert.equal(s.session.state.projectCursor, placeItem('imp', 0));
  imp = s.assignment('imp');
  assert.deepEqual([imp.harness, imp.runs_on.harness], ['pi', 'pi']);
  await s.press('K');
  assert.deepEqual(s.session.done, { ok: true, index: 0 }, 'at the top K stays and writes nothing');
  await s.press('J');
  assert.equal(s.session.state.projectCursor, placeItem('imp', 1));
  await s.press('-');
  assert.equal(stored(s, 'imp').run.length, 1);
  await s.press('-');
  assert.equal(s.session.done.message, 'keep at least one place');
  assert.equal(stored(s, 'imp').run.length, 1);
  // x: an exhausted mark goes, and the place is in use again.
  await s.press('+');
  const first = stored(s, 'imp').run[0];
  markExhausted(s.hud, placeKey({ harness: 'cli', agent: first.agent, model: first.model }), 'HTTP 429', NOW);
  s.session.snap = await s.collector.collect(true, s.board, NOW);
  assert.equal(s.assignment('imp').runs_on.harness, 'pi', 'the next place is in use while the first is exhausted');
  assert.match(s.text(), /✗ imp +agy/);
  s.session.state = { ...s.session.state, projectCursor: placeItem('imp', 0) };
  await s.press('x');
  assert.equal(s.assignment('imp').runs_on.agent, 'agy');
  assert.match(s.text(), /◉ imp +agy/);
  await s.press('x');
  assert.equal(s.session.done.message, 'not marked exhausted');
  // The MCP reads the same files: hud_roster shows what the page shows.
  const other = join(s.root, 'plain-cwd');
  fs.mkdirSync(other);
  const child = spawn(process.execPath, [mcpEntry], { cwd: other, env: { ...process.env, HUD_MCP_SURFACE: 'roles', HUD_HOME: s.hud, PATH: s.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { child.stdin.end(); await once(child, 'exit'); });
  const reply = new Promise((done) => createInterface({ input: child.stdout }).once('line', (line) => done(JSON.parse(line))));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hud_roster', arguments: {} } }) + '\n');
  const roster = JSON.parse((await reply).result.content[0].text).roles.find((r) => r.role === 'imp');
  assert.deepEqual([roster.harness, roster.agent, roster.model, roster.available, roster.runs_on.agent], ['cli', 'agy', 'gemini-4-argon-high', true, 'agy']);
  assert.equal(roster.run.length, 2);
});

test('browser places: p walks the web models, a second place can be promoted, a Flow place cycles its kind', async (t) => {
  const s = await setup(t);
  s.session.state = { ...s.session.state, projectCursor: placeItem('pro', 0) };
  await s.press('p');
  assert.deepEqual([s.assignment('pro').runs_on.provider, s.assignment('pro').runs_on.tool], ['gemini', 'jev-ask']);
  await s.press('p');
  assert.equal(s.assignment('pro').runs_on.tool, 'jev-aistudio');
  await s.press('P');
  await s.press('P');
  assert.equal(s.assignment('pro').runs_on.provider, 'chatgpt');
  assert.equal(s.assignment('pro').runs_on.model, '6 Pro');
  s.session.state = { ...s.session.state, projectCursor: placeItem('pro', 1) };
  await s.press('K');
  assert.deepEqual(stored(s, 'pro').run.map((p) => p.provider ?? p.tool), ['gemini', 'chatgpt', 'jev-aistudio']);
  assert.equal(s.assignment('pro').runs_on.provider, 'gemini');
  // thinking has no meaning in the browser; a model with nothing to choose says so.
  await s.press('e');
  assert.equal(s.session.done.message, 'no thinking setting here');
  await s.press('m');
  assert.equal(s.session.done.message, 'no other model to pick');
  s.session.state = { ...s.session.state, projectCursor: placeItem('flow', 0) };
  await s.press('m');
  assert.equal(stored(s, 'flow').run[0].kind, 'video');
  assert.match(s.text(), /flow +flow video not installed/);
  await s.press('p');
  assert.equal(s.session.done.message, 'no other harness for this role');
});

const lines40 = (s, lang = 'en', height = 20) => plain(s.frame(40, lang, height));
test('the model picker: curated providers first, then one provider\'s newest models; typing filters, Enter sets through the role file, Esc cancels', async (t) => {
  const s = await setup(t);
  discover(s);
  // imp runs `synthetic/model`, a model nothing lists: it is still offered, under its own provider after the curated ones.
  await s.press('m');
  assert.equal(fs.existsSync(join(s.hud, 'roles/imp.json')), false, 'opening it writes nothing');
  let page = lines40(s).join('\n');
  assert.match(page, /^imp · pi ─+ provider$/m);
  assert.match(page, /^ {2}model {2}synthetic\/model$/m);
  assert.match(page, /^ {2}\/ ▌ +5\/5$/m, 'the filter line: nothing typed, the 5th of 5 picked (the current one)');
  // Include order, each provider with how many models it offers: arena whole, deepseek only, opus only, gpt-6 only, the current one's.
  assert.match(page, /^ {4}arena +4\n {4}mistral +1\n {4}anthropic +1\n {4}openai +3\n {2}◉ synthetic +1$/m);
  assert.doesNotMatch(page, /google/);
  // Typing filters the providers live (substring, any case); Enter opens the one picked.
  await s.keys('ANTH');
  page = lines40(s).join('\n');
  assert.match(page, /^ {2}\/ ANTH▌ +1\/1$/m);
  assert.match(page, /^ {4}anthropic +1$/m);
  assert.doesNotMatch(page, /arena|openai/);
  await s.press(ENTER);
  page = lines40(s).join('\n');
  assert.match(page, /^imp · pi › anthropic ─+ model$/m);
  // Opus: of claude-opus-4-5, 4-6, 5, 5-5 and the dated 5-5 only the undated newest. `default` unsets the model.
  assert.match(page, /^ {4}default\n {4}claude-opus-5-5$/m);
  assert.doesNotMatch(page, /claude-opus-4|20261101|sonnet|haiku/);
  // Backspace on an empty filter, or Left, goes back to the providers; the filter starts empty again.
  await s.press(BACKSPACE);
  assert.match(lines40(s).join('\n'), /^imp · pi ─+ provider$/m);
  await s.keys('open', ENTER);
  assert.match(lines40(s).join('\n'), /^ {4}default\n {4}gpt-6\.1-sol\n {4}gpt-6\.1-luna\n {4}gpt-6-astra$/m);
  await s.press('\x1b[D');
  assert.match(lines40(s).join('\n'), /^imp · pi ─+ provider$/m);
  // Arrows pick, Enter on a model sets `provider/model` through the role file, as `editPlaces` does.
  await s.keys('openai', ENTER, DOWN, DOWN, ENTER);
  assert.deepEqual(s.session.done, { ok: true, index: 0 });
  assert.equal(stored(s, 'imp').run[0].model, 'openai/gpt-6.1-luna');
  assert.equal(s.assignment('imp').model, 'openai/gpt-6.1-luna');
  assert.equal(s.session.state.projectInput, undefined);
  assert.equal(s.session.state.projectCursor, placeItem('imp', 0), 'the cursor is on the place again');
  // The role's current model is picked when the picker opens, and shown with ◉.
  await s.press('m');
  page = lines40(s).join('\n');
  assert.match(page, /^ {2}model {2}openai\/gpt-6\.1-luna$/m);
  assert.match(page, /^ {2}◉ openai +3$/m);
  assert.doesNotMatch(page, /synthetic/, 'a model that is no longer in use is not kept');
  // Esc cancels at either level and writes nothing; so does Ctrl+C, which does not close the panel.
  await s.keys(ENTER, DOWN, ESC);
  assert.equal(s.session.state.projectInput, undefined);
  assert.equal(stored(s, 'imp').run[0].model, 'openai/gpt-6.1-luna');
  await s.press('m');
  const closed = await s.press('\x03');
  assert.equal(closed.close, false);
  assert.equal(s.session.state.projectInput, undefined);
  assert.equal(stored(s, 'imp').run[0].model, 'openai/gpt-6.1-luna');
});
test('the model picker: Tab shows every provider and model, `default` unsets, a model the lists do not know is set as typed, the keys are all the picker\'s', async (t) => {
  const s = await setup(t);
  discover(s);
  // Tab: every provider (A to Z) with every model, and Tab again is the curated list.
  await s.keys('m', TAB);
  let page = lines40(s).join('\n');
  assert.match(page, /^imp · pi ─+ provider · all$/m);
  assert.match(page, /^ {4}anthropic +7\n {4}arena +4\n {4}google +1\n {4}mistral +3\n {4}openai +7\n {2}◉ synthetic +1$/m);
  await s.keys('openai', ENTER, 'o1');
  assert.match(lines40(s).join('\n'), /^ {4}o1$/m, 'o1 is there once all are shown');
  await s.keys(BACKSPACE, BACKSPACE, TAB);
  page = lines40(s).join('\n');
  assert.doesNotMatch(page, /o1|gpt-5-mini/);
  await s.press(BACKSPACE);
  assert.match(lines40(s).join('\n'), /^imp · pi ─+ provider$/m);
  // Typing something no model has: Enter sets it as typed, within the provider (a full `provider/model` stays as it is).
  await s.keys('arena', ENTER, 'zz-new');
  page = lines40(s).join('\n');
  assert.match(page, /^ {2}\/ zz-new▌ +as typed$/m);
  assert.match(page, /^ {2}⏎ arena\/zz-new$/m);
  await s.press(ENTER);
  assert.equal(stored(s, 'imp').run[0].model, 'arena/zz-new');
  // At the providers a whole `provider/model` that matches none is set as typed; a word that matches none does nothing.
  await s.keys('m', 'nobody', ENTER);
  assert.deepEqual([s.session.state.projectInput.text, stored(s, 'imp').run[0].model], ['nobody', 'arena/zz-new']);
  await s.keys(BACKSPACE, BACKSPACE, BACKSPACE, BACKSPACE, BACKSPACE, BACKSPACE, 'custom/pi-next', ENTER);
  assert.equal(stored(s, 'imp').run[0].model, 'custom/pi-next');
  // `default` leaves the role on its default: the model is dropped from the place.
  await s.keys('m', ENTER, UP, ENTER);
  assert.equal(stored(s, 'imp').run[0].model, undefined);
  assert.equal(s.assignment('imp').model, 'synthetic/model', 'the pi role\'s own model is what the next job gets');
  assert.match(s.text(), /◉ imp +pi +synthetic\/model +high +yours$/m, 'the row shows that model, and the owner\'s file is the one in force');
  // While the picker is open every key is its own: q, p, e, + and x type or move, and nothing else happens.
  await s.press('m');
  for (const raw of ['q', 'p', 'e', '+', 'x', 'K', 'o', 'j']) {
    const out = await s.press(raw);
    assert.deepEqual([out.action, out.close], [undefined, false], raw);
  }
  assert.equal(s.session.state.projectInput.text, 'qpe+xKoj');
  assert.equal(stored(s, 'imp').run.length, 1);
  assert.equal(stored(s, 'imp').run[0].harness, 'pi');
  // A click leaves it (the page is the same one underneath).
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
  assert.match(page, /^ {4}default\n {2}◉ gemini-4-argon-high\n {4}gemini-4-hydrogen-high\n {4}gemini-3\.8-flash-high$/m);
  // The list filters on any part of a model; Enter on a match sets it, a miss sets what was typed.
  await s.keys('flash', ENTER);
  assert.equal(stored(s, 'imp').run[0].model, 'gemini-3.8-flash-high');
  await s.keys('m', 'next-one', ENTER);
  assert.equal(stored(s, 'imp').run[0].model, 'next-one');
  // The panel's frames: every row is the panel's width, in both languages, at each size, for each level and a very long filter.
  const long = 'x'.repeat(90);
  const inputs = [{ role: 'imp', index: 0, text: '' }, { role: 'imp', index: 0, text: long }, { role: 'imp', index: 0, text: '', all: true }];
  for (const pi of [false, true]) {
    if (pi) {
      writeRolePlaces(s.hud, 'imp', [{ harness: 'pi', pi_role: 'implementer', split: false, model: 'openai/gpt-6.1-sol' }]);
      s.collector.refreshRoles(s.session.snap, NOW);
      assert.equal(s.assignment('imp').harness, 'pi');
    }
    for (const input of inputs) for (const extra of [{}, { provider: 'openai' }, { provider: 'arena', text: 'opus' }]) for (const lang of ['en', 'zh']) for (const width of [32, 40, 56, 80, 120]) {
      s.session.state = { ...onPage('control', { projectFolded: new Set(['agents', 'files']) }), projectCursor: placeItem('imp', 0), projectInput: { ...input, ...extra } };
      const view = s.frame(width, lang, 14);
      for (const line of view.lines) assert.equal(visualLength(line), width, stripAnsi(line));
      for (const row of view.workboard.rows) assert.doesNotMatch(row.text, /\n/);
      assert.equal(view.lines.length, 14);
      assert.equal(view.workboard.rows.filter((r) => r.item === 'project:pick').length <= 1, true);
    }
  }
  s.session.state = { ...onPage('control', { projectFolded: new Set(['agents', 'files']) }), projectCursor: placeItem('imp', 0), projectInput: { role: 'imp', index: 0, text: '', provider: 'openai' } };
  const zh = plain(s.frame(40, 'zh', 14));
  assert.match(zh.join('\n'), /^imp · pi › openai ─+ 模型$/m);
  assert.match(zh[0], /^‹ 项目 › 控制面/);
  assert.match(zh.at(-1), /输入筛选 +↑↓ 选择 +⏎ 设置 +esc 取消/);
  assert.match(plain(s.frame(40, 'en', 14)).at(-1), /type filter +↑↓ pick +⏎ set +esc cancel/);
  assert.match(plain(s.frame(120, 'en', 14)).at(-1), /type filter +↑↓ pick +⏎ set +esc cancel +tab all +← back/);
  // Help says what m does now, and the key row for p e.
  s.session.state = { ...initialMonitorState(), help: true };
  const help = plain(s.frame(80, 'en', 40)).join('\n').replace(/\n {8}/g, ' ');
  assert.match(help, /^p e +place: harness, thinking \(capitals go back\)/m);
  assert.match(help, /^m +place: pick a model \(provider, then model; type to filter\)/m);
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
  for (const bad of ['x'.repeat(121), 'a\nb', 'a\x1b[31mb', 'a\x00b']) {
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
  s.session.state = { ...s.session.state, projectCursor: placeItem('pro', 2) };
  const shipped = resolve('packages/hud-mcp/roles/pro.json');
  for (const raw of ['\r', 'o']) assert.deepEqual((await s.press(raw)).action, { type: 'open-files', files: [shipped] });
  // After a switch the file in force is the owner's.
  s.session.state = { ...s.session.state, projectCursor: placeItem('imp', 0) };
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
  s.put(join(s.cwd, '.hud/project.json'), { version: 1, roles: ['imp', 'frontend', 'reviewer', 'sonic', 'architect'] });
  s.session.snap = await s.collector.collect(true, s.board, NOW + 1);
  const lines = plain(s.frame(80));
  assert.ok(lines.findIndex((l) => /^Project roles ─+ 2$/.test(l)) > lines.findIndex((l) => / architect /.test(l)));
  assert.match(s.text(), /◉ frontend +pi +project\/model/);
  assert.match(s.text(), /◉ imp +pi +project\/imp/);
  const before = fs.readFileSync(join(s.cwd, '.hud/roles/imp.json'), 'utf8');
  s.session.state = { ...s.session.state, projectCursor: placeItem('imp', 0) };
  for (const raw of ['p', 'm', 'e', '+', '-', 'K']) {
    await s.press(raw);
    assert.deepEqual(s.session.done, { ok: false, message: 'the project file is in force: o opens it' }, raw);
  }
  // A mark is not in a role file: clearing one works on a project role too.
  markExhausted(s.hud, placeKey({ harness: 'pi', model: 'project/model' }), 'HTTP 429', NOW);
  s.session.snap = await s.collector.collect(true, s.board, NOW + 1);
  s.session.state = { ...s.session.state, projectCursor: placeItem('frontend', 0) };
  assert.match(s.text(), /✗ frontend/);
  await s.press('x');
  assert.deepEqual(s.session.done, { ok: true, index: 0 });
  assert.match(s.text(), /◉ frontend/);
  assert.equal(fs.readFileSync(join(s.cwd, '.hud/roles/imp.json'), 'utf8'), before);
  assert.equal(fs.existsSync(join(s.hud, 'roles/imp.json')), false);
  assert.equal(fs.existsSync(join(s.hud, 'roles/frontend.json')), false);
  s.session.state = { ...s.session.state, projectCursor: placeItem('imp', 0) };
  assert.deepEqual((await s.press('o')).action, { type: 'open-files', files: [join(root, '.hud/roles/imp.json')] });
});

test('the first switch of an older single-place role file keeps its instructions and launch options, and refuses to rebuild them', async (t) => {
  const s = await setup(t, { shippedImp: false });
  // The fixture's imp is the old format: one place at the top level, split on.
  assert.equal(s.assignment('imp').instructions, 'implementer');
  await s.press('p');
  assert.equal(s.session.done.message, 'launch options are set in the file: o opens it');
  assert.equal(stored(s, 'imp').run, undefined, 'a refused key writes nothing');
  // The model is picked: provider first (typing filters), then the model.
  await s.keys('m', 'openai', ENTER, 'sol', ENTER);
  const written = stored(s, 'imp');
  assert.equal(written.instructions, 'implementer');
  assert.equal(written.harness, undefined);
  assert.deepEqual(written.run, [{ harness: 'pi', pi_role: 'implementer', split: true, model: 'openai/gpt-6.1-sol' }]);
  assert.equal(written.can_continue, true);
  const imp = s.assignment('imp');
  assert.deepEqual([imp.instructions, imp.split, imp.model, imp.thinking], ['implementer', true, 'openai/gpt-6.1-sol', 'high']);
  // Keys the owner added to a place survive a model switch.
  fs.writeFileSync(join(s.hud, 'roles/imp.json'), JSON.stringify({ ...written, run: [{ ...written.run[0], note: 'keep-me' }] }));
  await s.keys('m', 'openai', ENTER, 'astra', ENTER);
  assert.equal(stored(s, 'imp').run[0].note, 'keep-me');
  assert.equal(stored(s, 'imp').run[0].model, 'openai/gpt-6-astra');
});

test('Control plane keys: decoded names, only on a place row of the Control plane, Settings letters unchanged', async (t) => {
  const s = await setup(t);
  const decoder = new WorkbenchInputDecoder('workboard');
  const names = (raw) => decoder.push(Buffer.from(raw)).map((i) => i.key);
  assert.deepEqual([...'pPmMeE+-KJx'].map((c) => names(c)[0]), ['place-harness', 'place-harness-prev', 'place-model', 'place-model-prev',
    'place-thinking', 'place-thinking-prev', 'place-add', 'place-remove', 'place-up', 'place-down', 'place-clear']);
  assert.deepEqual([...'srtjkq'].map((c) => names(c)[0]), ['settings-save', 'reset', 'settings-test', 'down', 'up', 'close']);
  // The panel's own keyboard also types: a printable key carries its character (named or not), a control key has none, and a
  // keyboard that forwards keys to Codex (or another profile) carries no text at all.
  const decoded = (raw, profile = 'workboard', options = {}) => new WorkbenchInputDecoder(profile, options).push(Buffer.from(raw));
  assert.deepEqual(decoded('m'), [{ type: 'key', key: 'place-model', text: 'm' }]);
  assert.deepEqual(decoded('Z'), [{ type: 'key', key: '', text: 'Z' }]);
  assert.deepEqual(decoded('é-'), [{ type: 'key', key: '', text: 'é' }, { type: 'key', key: 'place-remove', text: '-' }]);
  assert.deepEqual(decoded('\x7f'), [{ type: 'key', key: 'backspace' }]);
  assert.deepEqual(decoded('\r'), [{ type: 'key', key: 'enter' }]);
  assert.deepEqual(decoded('\x1b[B'), [{ type: 'key', key: 'down' }]);
  assert.deepEqual(decoded('Z', 'workboard', { forward: true }), [{ type: 'key', key: '', raw: 'Z' }]);
  assert.deepEqual(decoded('m', 'workboard', { forward: true }), [{ type: 'key', key: 'place-model', raw: 'm' }]);
  assert.deepEqual(decoded('Z', 'monitor'), []);
  // Elsewhere they do nothing: the hub, another page, a row of the Control plane that is not a place.
  for (const state of [onPage(), onPage('progress'), onPage('control', { projectCursor: 'project:fold:healthy' })]) {
    s.session.state = state;
    for (const raw of ['p', 'm', 'x', '+']) assert.equal((await s.press(raw)).action, undefined);
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
  s.put(join(s.cwd, '.hud/project.json'), { version: 1, roles: ['imp', 'frontend', 'reviewer', 'sonic', 'architect'] });
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
    assert.fail(`${what}: ${err}`);
  };
  await until(() => stripAnsi(out).includes('Control plane'), 'the Control plane page');
  // m opens the picker (providers first), typing filters, Enter goes in and Enter sets: only then is a file written.
  child.stdin.write('m');
  await until(() => /provider/.test(stripAnsi(out)), 'the picker');
  assert.equal(fs.existsSync(join(s.hud, 'roles/imp.json')), false, 'opening it writes nothing');
  child.stdin.write('openai\r');
  await until(() => / model\b/.test(stripAnsi(out)) && /gpt-6\.1-sol/.test(stripAnsi(out)), 'the models of the provider');
  child.stdin.write('sol\r');
  await until(() => fs.existsSync(join(s.hud, 'roles/imp.json')) && stored(s, 'imp').run[0].model === 'openai/gpt-6.1-sol', 'the model written');
  // Down to the project's own role: four place rows below imp (reviewer, sonic, architect, then frontend).
  const mark = out.length;
  child.stdin.write('jjjjp');
  // The panel here is 30 columns wide, so the notice is cut to what fits.
  await until(() => /the project file is in/.test(stripAnsi(out.slice(mark))), 'the notice');
  assert.equal(fs.existsSync(join(s.hud, 'roles/frontend.json')), false);
  child.stdin.write('q');
  await once(child, 'exit');
  assert.equal(err, '');
});
