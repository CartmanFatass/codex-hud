import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { projectFixture, plain, onPage, NOW, TREE } from '../fixtures/project-page.mjs';
import { handleMonitorInput, initialMonitorState } from '../../dist/render/monitor.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { editPlaces, placeItem } from '../../dist/roles/role-control.js';
import { markExhausted, placeKey, roleRegistry, writeRolePlaces } from '../../dist/roles/roster.js';

const mcpEntry = resolve('packages/hud-mcp/bin/hud-mcp.mjs');

/** The synthetic Project fixture with every CLI and browser tool but `codex` and `jev-flow` on PATH, and the shipped `imp`. */
async function setup(t, { shippedImp = true } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'role-control-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await projectFixture(root);
  for (const name of ['herdr', 'agy', 'claude', 'grok', 'jev-aistudio'])
    fs.writeFileSync(join(root, 'bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  if (shippedImp) fs.rmSync(join(f.hud, 'roles/imp.json'));
  const session = { state: onPage('control', { projectCursor: placeItem('imp', 0) }), snap: await f.collector.collect(true, f.board, NOW), done: null };
  const decoder = new WorkbenchInputDecoder('workboard');
  const frame = (width = 80, lang = 'en', height = 64) => f.render(width, lang, session.state, height, session.snap);
  /** One key as the panel gets it: decoded, handled against the frame on screen, and a role edit applied as the panel does. */
  async function press(raw) {
    const view = frame();
    const [input] = decoder.push(Buffer.from(raw));
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
  const registry = () => roleRegistry(f.hud, f.cwd, f.env);
  const assignment = (name) => {
    const reg = registry();
    return reg.assignment(reg.roles().get(name), NOW);
  };
  const rows = (width = 80) => frame(width).workboard.rows.filter((r) => r.item?.startsWith('project:role:'));
  const text = (width = 80) => plain(frame(width)).join('\n');
  return { ...f, root, session, press, frame, registry, assignment, rows, text };
}
const stored = (s, name) => JSON.parse(fs.readFileSync(join(s.hud, 'roles', `${name}.json`), 'utf8'));

test('Control plane: each role once with its place and fallbacks, browser tasks apart, harnesses with their availability', async (t) => {
  const s = await setup(t);
  // reviewer gets a fallback; oracle's first place is exhausted, so its next one is the one in use.
  writeRolePlaces(s.hud, 'reviewer', [{ harness: 'pi', pi_role: 'reviewer', split: false }, { harness: 'cli', agent: 'claude', model: 'opus', thinking: 'high' }]);
  markExhausted(s.hud, placeKey({ harness: 'bro', tool: 'jev-ask', provider: 'chatgpt', model: '6 Pro' }), 'quota exceeded', NOW);
  s.session.snap = await s.collector.collect(true, s.board, NOW);
  assert.deepEqual(s.rows().map((r) => r.item), ['imp:0', 'reviewer:0', 'reviewer:1', 'sonic:0', 'architect:0', 'oracle:0', 'oracle:1', 'oracle:2', 'flow:0'].map((x) => `project:role:${x}`));
  const lines = plain(s.frame(80, 'en', 64));
  const at = (re) => lines.findIndex((l) => re.test(l));
  // Groups in order; oracle and flow only under Browser tasks; the harnesses after them.
  assert.ok(at(/^Roles ─/) < at(/ imp /) && at(/ architect /) < at(/^Browser tasks ─/));
  assert.ok(at(/^Browser tasks ─/) < at(/ oracle /) && at(/ flow /) < at(/^Harnesses ─/));
  // Wide rows say whose file is in force: the shipped one, or the owner's once a switch (or the reviewer's fallback) wrote it.
  assert.match(lines[at(/ imp /)], /◉ imp +pi +synthetic\/model +high +default$/);
  assert.match(lines[at(/ reviewer /)], /◉ reviewer +pi +default +yours$/);
  assert.match(lines[at(/ reviewer /) + 1], /○ ↳ +claude +opus +high/);
  assert.match(lines[at(/ oracle /)], /✗ oracle +chatgpt +6 Pro +exhausted 60m/);
  assert.match(lines[at(/ oracle /) + 1], /◉ ↳ +gemini/);
  assert.match(lines[at(/ oracle /) + 2], /○ ↳ +aistudio +gemini-4-argon/);
  assert.match(lines[at(/ flow /)], /− flow +flow +image +not installed/);
  assert.match(lines[at(/^Harnesses ─/) + 1], /pi ✓ +agy ✓ +claude ✓ +codex − +grok ✓ +jev-ask ✓ +jev-aistudio ✓ +jev-flow −/);
  assert.match(plain(s.frame(80)).join('\n'), /◉ in use +○ standby +✗ exhausted +− not installed/);
  // One line a place at every width and language; at 40 columns the exhausted time gives way, never the row's mark.
  for (const lang of ['en', 'zh'])
    for (const width of [32, 40, 56, 80, 120]) {
      const view = s.frame(width, lang, 64);
      for (const line of view.lines) assert.equal(visualLength(line), width, stripAnsi(line));
      for (const row of view.workboard.rows.filter((r) => r.item?.startsWith('project:role:'))) {
        assert.equal(visualLength(row.text), width);
        assert.doesNotMatch(row.text, /\n/);
      }
    }
  const narrow = plain(s.frame(40, 'zh', 64)).join('\n');
  assert.match(narrow, /^角色 ─+ 4$/m);
  assert.match(narrow, /^浏览器任务 ─+ 2$/m);
  assert.match(narrow, /✗ oracle +chatgpt 6 Pro$/m);
  assert.match(narrow, /◉ 使用中 +○ 备选 +✗ 已耗尽/);
  assert.match(plain(s.frame(120, 'zh', 64)).join('\n'), /✗ oracle +chatgpt +6 Pro +已耗尽 60分钟/);
  assert.match(plain(s.frame(120, 'en', 64)).join('\n'), /✗ oracle +chatgpt +6 Pro +exhausted 60m/);
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
  // m and e: the catalog's next model and thinking; capitals go back, and past the last comes "unset".
  await s.press('m');
  assert.equal(s.assignment('imp').model, 'gemini-4-hydrogen-high');
  await s.press('M');
  assert.equal(s.assignment('imp').model, 'gemini-4-argon-high');
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
  s.session.state = { ...s.session.state, projectCursor: placeItem('oracle', 0) };
  await s.press('p');
  assert.deepEqual([s.assignment('oracle').runs_on.provider, s.assignment('oracle').runs_on.tool], ['gemini', 'jev-ask']);
  await s.press('p');
  assert.equal(s.assignment('oracle').runs_on.tool, 'jev-aistudio');
  await s.press('P');
  await s.press('P');
  assert.equal(s.assignment('oracle').runs_on.provider, 'chatgpt');
  assert.equal(s.assignment('oracle').runs_on.model, '6 Pro');
  s.session.state = { ...s.session.state, projectCursor: placeItem('oracle', 1) };
  await s.press('K');
  assert.deepEqual(stored(s, 'oracle').run.map((p) => p.provider ?? p.tool), ['gemini', 'chatgpt', 'jev-aistudio']);
  assert.equal(s.assignment('oracle').runs_on.provider, 'gemini');
  // thinking has no meaning in the browser; a model with nothing to choose says so.
  await s.press('e');
  assert.equal(s.session.done.message, 'no thinking setting here');
  await s.press('m');
  assert.equal(s.session.done.message, 'no other model to pick');
  s.session.state = { ...s.session.state, projectCursor: placeItem('flow', 0) };
  await s.press('m');
  assert.equal(stored(s, 'flow').run[0].kind, 'video');
  assert.match(s.text(), /flow +flow +video/);
  await s.press('p');
  assert.equal(s.session.done.message, 'no other harness for this role');
});

test('Enter and o on a place open the role file in force, a fallback row included', async (t) => {
  const s = await setup(t);
  s.session.state = { ...s.session.state, projectCursor: placeItem('oracle', 2) };
  const shipped = resolve('packages/hud-mcp/roles/oracle.json');
  for (const raw of ['\r', 'o']) assert.deepEqual((await s.press(raw)).action, { type: 'open-files', files: [shipped] });
  // After a switch the file in force is the owner's.
  s.session.state = { ...s.session.state, projectCursor: placeItem('imp', 0) };
  await s.press('m');
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
  await s.press('m');
  const written = stored(s, 'imp');
  assert.equal(written.instructions, 'implementer');
  assert.equal(written.harness, undefined);
  assert.deepEqual(written.run, [{ harness: 'pi', pi_role: 'implementer', split: true, model: 'openai/gpt-6.1-sol' }]);
  assert.equal(written.can_continue, true);
  const imp = s.assignment('imp');
  assert.deepEqual([imp.instructions, imp.split, imp.model, imp.thinking], ['implementer', true, 'openai/gpt-6.1-sol', 'high']);
  // Keys the owner added to a place survive a model switch.
  fs.writeFileSync(join(s.hud, 'roles/imp.json'), JSON.stringify({ ...written, run: [{ ...written.run[0], note: 'keep-me' }] }));
  await s.press('m');
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
  // Elsewhere they do nothing: the hub, another page, a row of the Control plane that is not a place.
  for (const state of [onPage(), onPage('progress'), onPage('control', { projectCursor: 'project:fold:agents' })]) {
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
  const place = JSON.stringify({ state: { ...initialMonitorState(), mainTab: 'project', projectPage: 'control', projectCursor: placeItem('imp', 0) } },
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
  child.stdin.write('m');
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
