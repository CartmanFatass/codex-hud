import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { projectFixture, projectFrames, plain, onPage, PAGES, PROJECTS, NOW, TREE } from '../fixtures/project-page.mjs';
import { progressSegments } from '../../dist/render/project-view.js';
import { renderWorkCard } from '../../dist/render/work-card.js';
import { projectWorkCard } from '../../dist/collectors/work-card.js';
import { projectShown } from '../../dist/collectors/project-board.js';
import { initialMonitorState, handleMonitorInput } from '../../dist/render/monitor.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { openEditorPane } from '../../dist/cli/panel-pane.js';
import { readPanelPlace } from '../../dist/utils/panel-reload.js';
import { PANEL_COMMANDS, commandSequence, monitorKey, needsOpenPanel, overlayKey } from '../../dist/utils/panel-command.js';
const expected = JSON.parse(fs.readFileSync(new URL('../fixtures/project-frames.json', import.meta.url), 'utf8'));
async function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'project-page-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, ...(await projectFixture(root)) };
}
const ctx = (frame) => ({ tree: TREE, frame, nowMs: NOW, standalone: true });
const press = (frame, key) => handleMonitorInput(frame.state, { type: 'key', key }, ctx(frame));
test('Project frames: real synthetic project, roles, agents, credentials, STATE and reviews at 80/120 EN/ZH', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(projectFrames(f), expected);
  assert.equal(f.data.git.branch, 'synthetic-project');
  assert.equal(f.data.worktreeCount, 2);
  assert.match(plain(f.render(120)).join('\n'), /Working tree +synthetic-project · \d+ changed · 2 worktrees/);
  assert.match(f.data.last.text, /Synthetic Project baseline/);
  assert.equal(f.data.waiting.length, 2);
  assert.match(f.data.waiting[1].value, /after trying the synthetic setup/);
  assert.equal(f.data.editing.length, 1);
  assert.equal(f.data.docs[0].value, 'M3b · AI-THIN');
  assert.deepEqual(f.data.counts, { working: 2, blocked: 1, try: 1, todo: 1, accepted: 1, dropped: 1 });
  assert.deepEqual(f.data.ladder.ids, ['M1', 'M2', 'M3', 'M3b', 'M4']);
  assert.equal(f.data.ladder.current, 'M3b');
  assert.equal(f.data.summary, 'Synthetic milestone closing; pages building in worktrees');
  assert.equal(f.data.slices.find((s) => s.label === 'NATIVE-TREE').path, join(f.sliceJob, 'report.md'));
  assert.deepEqual(
    f.data.slices.filter((s) => s.drift).map((s) => [s.label, s.drift]),
    [
      ['ORPHAN', 'no worktree'],
      ['NO-JOB', 'not in ledger'],
    ]
  );
  assert.equal(f.data.slices.find((s) => s.label === 'BLOCKED').drift, undefined);
  assert.equal(f.data.next.length, 5);
  assert.equal(f.data.next[0].value, 'NATIVE-TREE: native subagents on Home beside package lanes');
  assert.match(f.data.docs[1].path, /2026-11-12-review.md$/);
  const first = (name) => f.data.roles.find((r) => r.role === name);
  assert.deepEqual(first('imp').places, [{ harness: 'pi', label: 'pi', model: 'synthetic/model', thinking: 'high', state: 'active' }]);
  assert.deepEqual(
    f.data.control.find((r) => r.label === 'invalid'),
    {
      label: 'invalid',
      value: 'unparseable JSON',
      path: join(f.hud, 'roles/bad.json'),
    }
  );
  assert.deepEqual(
    f.data.control.find((r) => r.label === 'ignored'),
    {
      label: 'ignored',
      value: '.hud',
      path: join(fs.realpathSync(f.cwd), '.hud'),
    }
  );
  assert.equal(
    f.data.control.some((r) => r.label === 'secret'),
    false
  );
  assert.equal(f.data.control.find((r) => r.label === 'convention').path, join(f.cwd, 'hud-convention.md'));
  // Roles live on `roles` now, grouped for the page: browser tasks apart, the project's own files marked.
  assert.deepEqual(f.data.roles.map((r) => [r.role, r.group]), [['imp', 'roles'], ['reviewer', 'roles'], ['sonic', 'roles'],
    ['architect', 'roles'], ['oracle', 'roles'], ['pro', 'browser'], ['flow', 'browser']]);
  assert.deepEqual(first('oracle').places.map((p) => [p.label, p.model, p.state]),
    [['claude', 'fable', 'missing'], ['pi', null, 'active']]);
  assert.deepEqual(first('pro').places.map((p) => [p.label, p.model, p.state]),
    [['chatgpt', '6 Pro', 'active'], ['gemini', null, 'standby'], ['aistudio', 'gemini-4-argon', 'missing']]);
  assert.deepEqual([first('flow').places[0].label, first('flow').places[0].kind, first('flow').places[0].state], ['flow', 'image', 'missing']);
  assert.deepEqual([first('imp').path, first('imp').source, first('sonic').source], [join(f.hud, 'roles/imp.json'), 'yours', 'default']);
  assert.equal(f.data.roleCount, 7);
  assert.deepEqual(f.data.harnesses.map((h) => [h.name, h.ok]), [['pi', true], ['agy', false], ['claude', false], ['codex', false],
    ['grok', false], ['jev-ask', true], ['jev-aistudio', false], ['jev-flow', false]]);
  assert.deepEqual(f.data.control.find((r) => r.label === 'pi role'), { label: 'pi role', value: 'implementer', path: join(f.root, 'roles/implementer.md') });
  assert.equal(f.data.agents.length, 3);
  assert.equal(f.data.browser, true);
  for (const width of [32, 40, 56, 80, 120])
    for (const lang of ['en', 'zh']) {
      const hub = f.render(width, lang),
        pages = Object.fromEntries(PAGES.map((page) => [page, f.render(width, lang, page)]));
      for (const frame of [hub, ...Object.values(pages)])
        for (const line of frame.lines) assert.equal(visualLength(line), width, stripAnsi(line));
      const text = (...frames) => frames.map((frame) => plain(frame).join('\n')).join('\n');
      // This project has no tickets: the hub has no Tickets entry and the Tickets page says so.
      assert.doesNotMatch(
        text(hub, pages.progress, pages.tree, pages.docs, pages.control),
        /NEVER_RENDER|unrelated bullet|Tickets|工单|INVISIBLE|M5|NOT-A-MILESTONE/
      );
      assert.match(text(pages.tickets), lang === 'en' ? /Project › Tickets\n\n  none/ : /项目 › 工单\n\n  无/);
      // The current milestone's bar and counts (STATE has no dates here, so older work is one row a milestone, newest first).
      assert.match(text(pages.progress), /^ {3}M3b {2}[█▓░]+ 0\/2$/m);
      assert.match(text(pages.progress), /^ {2}1 (working|工作中) {2}1 (to try|待试用)$/m);
      assert.match(text(pages.progress), /^ {2}▸ M3 +✓ 1/m);
      assert.match(text(pages.progress), /^ {2}▸ M3b +◇ 1/m);
      assert.match(text(pages.progress), lang === 'en' ? /^Next ─+ 5$/m : /^下一步 ─+ 5$/m);
      if (width >= 80) {
        assert.match(text(pages.progress), /Which synthetic option\?/);
        assert.match(text(pages.control), /unparseable JSON/);
        assert.match(text(pages.control), /bad\.json/);
      }
      if (lang === 'zh') {
        assert.match(text(hub), /^ 首页 1  项目 2/m);
        assert.doesNotMatch(text(hub, ...Object.values(pages)), /\bProject 2\b|3 agent\b/);
        assert.ok(pages.control.workboard.rows.some((r) => stripAnsi(r.text).startsWith('▸ 文件')));
      }
    }
  assert.doesNotMatch(JSON.stringify(f.data), /NEVER_RENDER/);
  assert.deepEqual(f.data.keys, [
    ['GEMINI_API_KEY', false],
    ['MISTRAL_API_KEY', true],
    ['OPENAI_API_KEY', false],
    ['TYPESAFE_API_KEY', true],
    ['SYNTHETIC_KEY', true],
  ]);
  assert.ok(
    [...f.collector.cache.get(join(f.hud, 'credentials.env')).value.values()].every((v) => typeof v === 'boolean')
  );
});
test('a registered project shows its roles, hides the rest and uses its convention', async (t) => {
  const f = await fixture(t);
  const root = fs.realpathSync(f.cwd);
  f.put(join(f.hud, 'projects.json'), { version: 1, projects: [{ root, registered_at: '2026-11-13T00:00:00.000Z' }] });
  f.put(join(f.cwd, '.hud/roles/frontend.json'), {
    role: 'frontend',
    harness: 'pi',
    pi_role: 'implementer',
    split: false,
    can_continue: true,
    model: 'project/model',
  });
  f.put(join(f.cwd, '.hud/roles/imp.json'), {
    role: 'imp',
    harness: 'pi',
    pi_role: 'implementer',
    split: false,
    can_continue: true,
    model: 'project/imp',
  });
  f.put(join(f.cwd, '.hud/roles/cli.json'), {
    role: 'local-cli',
    harness: 'cli',
    agent: 'grok',
    can_continue: true,
    note: 'NEVER_RENDER_CLI_BODY',
  });
  f.put(join(f.cwd, '.hud/project.json'), { version: 1, roles: ['imp', 'frontend', 'missing'] });
  f.put(join(f.cwd, '.hud/hud-convention.md'), '# Registered project convention');
  const data = await f.collector.collect(true, f.board, NOW + 1);
  const role = (name) => data.roles.find((r) => r.role === name);
  assert.deepEqual([role('frontend').group, role('frontend').path, role('frontend').places[0].model, role('frontend').places[0].thinking],
    ['project', join(root, '.hud/roles/frontend.json'), 'project/model', 'high']);
  assert.deepEqual([role('imp').group, role('imp').source, role('imp').path, role('imp').places[0].model], ['project', 'project', join(root, '.hud/roles/imp.json'), 'project/imp']);
  assert.equal(data.roles.some((r) => r.role === 'oracle' || r.role === 'pro' || r.role === 'secret'), false);
  assert.equal(data.control.some((r) => r.label === 'ignored'), false);
  assert.equal(data.control.find((r) => r.label === 'convention').value, 'project');
  assert.equal(data.control.find((r) => r.label === 'convention').path, join(root, '.hud/hud-convention.md'));
  assert.ok(
    data.control.some(
      (r) =>
        r.label === 'invalid' && r.value === 'project roles are pi only' && r.path === join(root, '.hud/roles/cli.json')
    )
  );
  assert.doesNotMatch(JSON.stringify(data), /NEVER_RENDER/);
});
test('Control plane page: what needs the owner first, healthy roles and files folded; Enter opens them, the agents fold inside Files', async (t) => {
  const f = await fixture(t);
  const render = (state) => f.render(80, 'en', state, 64);
  let frame = render('control');
  let text = plain(frame).join('\n');
  // flow has nowhere to run and bad.json does not load: they come first; the other roles are one folded row of names.
  assert.match(text, /^Needs attention ─+ 2$/m);
  assert.match(text, /^ {2}− flow +flow image not installed$/m);
  assert.match(text, /^ {2}! bad\.json +unparseable JSON$/m);
  assert.match(text, /^▸ Healthy ─+ 6$/m);
  assert.match(text, /^ {2}◉ imp reviewer sonic architect oracle pro$/m);
  assert.match(text, /^▸ Files ─+ 8$/m);
  assert.match(text, /^ {2}keys 3\/5 · browser ✓ · missing GEMINI OPENAI$/m);
  assert.doesNotMatch(text, /synthetic\/model|project-agent\.md|▸ agents/);
  frame.state.projectCursor = 'project:fold:healthy';
  frame = render(press(frame, 'enter').state);
  assert.match(plain(frame).join('\n'), /^Healthy ─+ 6$/m);
  assert.match(plain(frame).join('\n'), /synthetic\/model/);
  frame.state.projectCursor = 'project:fold:files';
  frame = render(press(frame, 'enter').state);
  assert.match(plain(frame).join('\n'), /▸ agents/);
  assert.doesNotMatch(plain(frame).join('\n'), /project-agent\.md/);
  frame.state.projectCursor = 'project:fold:agents';
  frame = render(press(frame, 'enter').state);
  for (const name of ['user-agent.md', 'project-agent.md', 'codex-agent.toml'])
    assert.match(plain(frame).join('\n'), new RegExp(name));
  frame.state.projectCursor = 'project:fold:agents';
  frame = render(press(frame, 'enter').state);
  assert.doesNotMatch(plain(frame).join('\n'), /project-agent\.md/);
  frame.state.projectCursor = 'project:fold:healthy';
  frame = render(press(frame, 'enter').state);
  assert.match(plain(frame).join('\n'), /^▸ Healthy ─+ 6$/m, 'a second Enter folds the roles again');
});
test('2 and arrows/Tab switch Home ⇄ Project with independent cursor/scroll; 3 stays Changes', async (t) => {
  const f = await fixture(t),
    decoder = new WorkbenchInputDecoder('workboard');
  const send = (frame, raw) => handleMonitorInput(frame.state, decoder.push(Buffer.from(raw))[0], ctx(frame));
  let frame = f.render(80, 'en', { ...initialMonitorState(), homeScroll: 3 });
  assert.equal(projectShown(frame.state), false);
  frame = f.render(80, 'en', send(frame, '2').state);
  assert.equal(frame.state.mainTab, 'project');
  assert.equal(projectShown(frame.state), true);
  frame.state.projectCursor = 'project:page:docs';
  for (const raw of ['\x1b[D', '\x1b[C', '\t', '\x1b[Z']) {
    frame = f.render(80, 'en', send(frame, raw).state);
    assert.equal(frame.state.mainTab, 'home');
    frame = f.render(80, 'en', send(frame, raw).state);
    assert.equal(frame.state.mainTab, 'project');
    assert.equal(frame.state.projectCursor, 'project:page:docs');
  }
  const homeControl = frame.controls.find((c) => c.kind === 'board-home');
  frame = f.render(
    80,
    'en',
    handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: homeControl.x, y: 0 }, ctx(frame)).state
  );
  assert.equal(frame.state.mainTab, 'home');
  const control = frame.controls.find((c) => c.kind === 'board-project');
  frame = f.render(
    80,
    'en',
    handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: control.x, y: 0 }, ctx(frame)).state
  );
  assert.equal(frame.state.mainTab, 'project');
  frame = f.render(80, 'en', send(frame, '3').state);
  assert.equal(frame.state.focus, 'changes');
  assert.equal(projectShown(frame.state), false);
});
test('Codex prefix 2 binds pane-2, selects Project, and opens a closed panel on that command', async (t) => {
  const f = await fixture(t),
    bin = join(f.root, 'bin'),
    log = join(f.root, 'tmux.jsonl');
  fs.writeFileSync(
    join(bin, 'tmux'),
    `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TMUX_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'display-message') console.log(process.env.TMUX_TEST_PANEL || '');
if (args.includes('@codex_hud_main_pane')) console.log('%1');
`,
    { mode: 0o700 }
  );
  const env = { ...process.env, ...f.env, PATH: `${bin}:${process.env.PATH}`, TMUX_TEST_LOG: log };
  const keys = spawnSync('bash', ['bin/codex-hud-keys', 'synthetic-session', 'C-\\'], { env, encoding: 'utf8' });
  assert.equal(keys.status, 0, keys.stderr);
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls().some((a) => a[0] === 'bind-key' && a[3] === '2' && a.at(-1).endsWith(' pane-2')));
  const decoder = new WorkbenchInputDecoder('workboard', { forward: true });
  const input = decoder.push(Buffer.from(commandSequence('pane-2')))[0];
  assert.deepEqual(input, { type: 'command', command: 'pane-2' });
  assert.equal(needsOpenPanel(input.command), true);
  const frame = f.render(80, 'en', initialMonitorState());
  assert.equal(press(frame, monitorKey(input.command)).state.mainTab, 'project');
  // Run the real command carrier with a synthetic tmux and a recording toggle boundary.
  fs.copyFileSync('bin/codex-hud-command', join(bin, 'codex-hud-command'));
  fs.writeFileSync(join(bin, 'codex-hud-toggle'), 'printf "%s\\n" "$@" > "$TOGGLE_TEST_LOG"\n');
  const toggled = join(f.root, 'toggle.txt');
  const closed = spawnSync('bash', [join(bin, 'codex-hud-command'), 'synthetic-session', 'pane-2'], {
    env: { ...env, TOGGLE_TEST_LOG: toggled },
    encoding: 'utf8',
  });
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(fs.readFileSync(toggled, 'utf8'), 'synthetic-session\n--command\npane-2\n');
  const open = spawnSync('bash', ['bin/codex-hud-command', 'synthetic-session', 'pane-2'], {
    env: { ...env, TMUX_TEST_PANEL: '%2' },
    encoding: 'utf8',
  });
  assert.equal(open.status, 0, open.stderr);
  const sent = calls().at(-1);
  assert.deepEqual(sent.slice(0, 4), ['send-keys', '-t', '%2', '-H']);
  assert.equal(Buffer.from(sent.slice(4).map((s) => parseInt(s, 16))).toString(), commandSequence('pane-2'));
});

test('Codex prefix [ and ] bind project-prev and project-next for both prefixes, step the Project tab, and a closed panel ignores them', async (t) => {
  const f = await fixture(t),
    bin = join(f.root, 'bin'),
    log = join(f.root, 'tmux.jsonl');
  fs.writeFileSync(
    join(bin, 'tmux'),
    `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TMUX_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'display-message') console.log(process.env.TMUX_TEST_PANEL || '');
if (args.includes('@codex_hud_main_pane')) console.log('%1');
`,
    { mode: 0o700 }
  );
  const env = { ...process.env, ...f.env, PATH: `${bin}:${process.env.PATH}`, TMUX_TEST_LOG: log };
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  for (const prefix of ['C-\\', 'C-]']) {
    fs.writeFileSync(log, '');
    const keys = spawnSync('bash', ['bin/codex-hud-keys', 'synthetic-session', prefix], { env, encoding: 'utf8' });
    assert.equal(keys.status, 0, keys.stderr);
    for (const [key, name] of [['[', 'project-prev'], [']', 'project-next']]) {
      const bound = calls().filter((a) => a[0] === 'bind-key' && a[3] === key);
      assert.equal(bound.length, 1, `${prefix} ${key}`);
      assert.deepEqual(bound[0].slice(0, 3), ['bind-key', '-T', 'codex-hud-prefix']);
      assert.ok(bound[0].at(-1).endsWith(` ${name}`), bound[0].at(-1));
    }
  }
  // The panel decodes what the carrier sends and the monitor steps the tab, in the order pressed, wrapping round.
  const decoder = new WorkbenchInputDecoder('workboard', { forward: true });
  const inputs = decoder.push(Buffer.from(commandSequence('project-next') + commandSequence('project-next') + commandSequence('project-prev')));
  assert.deepEqual(inputs.map((i) => i.command), ['project-next', 'project-next', 'project-prev']);
  const view = (state) => f.render(40, 'en', state, 24, f.data, true, 'unicode', 'none', { projects: PROJECTS, projectName: 'demo-project' });
  let frame = view(onPage());
  const roots = [];
  for (const input of inputs) {
    frame = view(press(frame, monitorKey(input.command)).state);
    roots.push(frame.state.projectRoot);
  }
  assert.deepEqual(roots, [PROJECTS[1].root, PROJECTS[2].root, PROJECTS[1].root]);
  // An open Help or Settings is closed by them and the command then runs, as with the other panel commands.
  for (const overlay of ['help', 'settings']) for (const command of ['project-prev', 'project-next']) assert.equal(overlayKey(command, overlay), null);
  // The real carrier: an open panel gets the APC string; a closed one ignores them, exactly where needsOpenPanel says so.
  fs.copyFileSync('bin/codex-hud-command', join(bin, 'codex-hud-command'));
  fs.writeFileSync(join(bin, 'codex-hud-toggle'), 'printf "%s\\n" "$@" > "$TOGGLE_TEST_LOG"\n');
  const toggled = join(f.root, 'toggle.txt');
  for (const command of PANEL_COMMANDS) {
    const closed = spawnSync('bash', [join(bin, 'codex-hud-command'), 'synthetic-session', command], {
      env: { ...env, TOGGLE_TEST_LOG: toggled },
      encoding: 'utf8',
    });
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal(fs.existsSync(toggled), needsOpenPanel(command), `${command}: the shell and needsOpenPanel agree`);
    fs.rmSync(toggled, { force: true });
  }
  assert.equal(needsOpenPanel('project-next'), false);
  const open = spawnSync('bash', ['bin/codex-hud-command', 'synthetic-session', 'project-next'], {
    env: { ...env, TMUX_TEST_PANEL: '%2' },
    encoding: 'utf8',
  });
  assert.equal(open.status, 0, open.stderr);
  const sent = calls().at(-1);
  assert.deepEqual(sent.slice(0, 4), ['send-keys', '-t', '%2', '-H']);
  assert.equal(Buffer.from(sent.slice(4).map((x) => parseInt(x, 16))).toString(), commandSequence('project-next'));
});

test('Project collection failure is caught and the live panel re-arms collection', async (t) => {
  const f = await fixture(t),
    runner = join(f.root, 'collect-fault.mjs');
  fs.writeFileSync(
    runner,
    `
import { ProjectCollector } from ${JSON.stringify(pathToFileURL(resolve('dist/collectors/project-board.js')).href)};
import { runLivePage } from ${JSON.stringify(pathToFileURL(resolve('dist/tree-page.js')).href)};
let calls = 0;
ProjectCollector.prototype.collect = async function () {
  if (++calls === 1) throw Error('synthetic-project-fault');
  process.stdout.write('REARMED'); process.exit(0);
};
await runLivePage();
`
  );
  const settings = join(f.root, 'settings.json');
  f.put(settings, { modelEnabled: false });
  const child = spawn(process.execPath, [runner], {
    env: { ...process.env, ...f.env, HUD_SETTINGS_PATH: settings, CODEX_HUD_STANDALONE_PANEL: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (b) => {
    stdout += b;
  });
  child.stderr.on('data', (b) => {
    stderr += b;
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  t.after(() => {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  const code = await new Promise((done) => child.once('exit', done));
  clearTimeout(timeout);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /REARMED/);
});

function editorHerdr(f) {
  const log = join(f.root, 'editor.jsonl'),
    bin = join(f.root, 'bin');
  fs.writeFileSync(
    join(bin, 'herdr'),
    `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.EDITOR_LOG, JSON.stringify(args) + '\\n');
const operation = args.slice(0, 2).join(' ');
if (operation === 'pane get' && process.env.EDITOR_LOOKUP === 'fail') process.exit(1);
const result = operation === 'pane get'
  ? {pane: {pane_id: 'w4E:p2', workspace_id: process.env.EDITOR_LOOKUP === 'missing' ? undefined : 'w4E'}}
  : operation === 'tab create'
    ? {type: 'tab_created', tab: {tab_id: 'w4E:t2'}, root_pane: {pane_id: 'w4E:p3'}}
    : {pane: {pane_id: 'w4E:p4'}};
console.log(JSON.stringify({result}));
`,
    { mode: 0o700 }
  );
  return {
    env: { ...f.env, PATH: `${bin}:${dirname(process.execPath)}`, HERDR_PANE_ID: 'w4E:p2', EDITOR_LOG: log },
    calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse),
  };
}
test('Enter and o open the exact Project file in its own focused workspace tab; default editor is vim', async (t) => {
  const f = await fixture(t),
    { env, calls } = editorHerdr(f);
  // Files open from the hub's Waiting items and from every page.
  const found = [undefined, 'progress', 'tree', 'docs', 'control'].flatMap((page) => {
    const frame = f.render(80, 'en', page === 'control' ? onPage('control', { projectFolded: new Set(['agents']) }) : page, 80);
    return frame.workboard.rows.filter((r) => r.files).map((row) => ({ frame, row }));
  });
  assert.ok(found.length > 20);
  for (const { frame, row } of found) {
    frame.state.projectCursor = row.item;
    for (const key of ['enter', 'open-session'])
      assert.deepEqual(press(frame, key).action, { type: 'open-files', files: row.files });
  }
  const { frame, row: file } = found.find(({ row }) => row.files[0] === join(f.sliceJob, 'report.md'));
  frame.state.projectCursor = file.item;
  await openEditorPane(press(frame, 'enter').action.files, env);
  assert.deepEqual(calls(), [
    ['pane', 'get', 'w4E:p2'],
    ['tab', 'create', '--workspace', 'w4E', '--cwd', process.cwd(), '--label', 'report.md', '--focus'],
    ['pane', 'run', 'w4E:p3', `vim '${file.files[0]}'; exit`],
  ]);
  await openEditorPane([join(f.root, "a file's name.md"), join(f.root, 'second file.md')], {
    ...env,
    EDITOR: 'synthetic-editor --wait',
  });
  assert.deepEqual(calls().slice(-2), [
    ['tab', 'create', '--workspace', 'w4E', '--cwd', process.cwd(), '--label', "a file's name.md", '--focus'],
    [
      'pane',
      'run',
      'w4E:p3',
      `synthetic-editor --wait '${f.root}/a file'\\''s name.md' '${f.root}/second file.md'; exit`,
    ],
  ]);
});
test('empty editor file lists are inert even without a herdr pane', async () => {
  await openEditorPane([], {});
});

test('Editor tab label is the first basename, capped at 24 display cells', async (t) => {
  const f = await fixture(t),
    { env, calls } = editorHerdr(f);
  for (const name of ['a'.repeat(40) + '.md', '界'.repeat(20) + '.md']) {
    await openEditorPane([join(f.root, name), join(f.root, 'ignored.md')], env);
    const create = calls().at(-2),
      label = create[create.indexOf('--label') + 1];
    assert.equal(label, name.startsWith('a') ? 'a'.repeat(23) + '…' : '界'.repeat(11) + '…');
    assert.ok(visualLength(label) <= 24);
  }
});
for (const mode of ['fail', 'missing'])
  test(`Editor falls back to a split when workspace lookup is ${mode}`, async (t) => {
    const f = await fixture(t),
      { env, calls } = editorHerdr(f);
    await openEditorPane([join(f.root, 'report.md')], { ...env, EDITOR_LOOKUP: mode });
    assert.deepEqual(calls(), [
      ['pane', 'get', 'w4E:p2'],
      ['pane', 'split', 'w4E:p2', '--direction', 'right', '--focus', '--cwd', process.cwd()],
      ['pane', 'run', 'w4E:p4', `vim '${f.root}/report.md'; exit`],
    ]);
  });
test('Home and overlays collect nothing; warm Project uses signatures and git waits five seconds', async (t) => {
  const f = await fixture(t),
    originals = Object.fromEntries(['readSync', 'lstatSync', 'opendirSync'].map((k) => [k, fs[k]]));
  const calls = { readSync: 0, lstatSync: 0, opendirSync: 0 };
  for (const key of Object.keys(calls))
    fs[key] = (...args) => {
      calls[key]++;
      return originals[key](...args);
    };
  syncBuiltinESMExports();
  t.after(() => {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  });
  for (const state of [
    initialMonitorState(),
    { mainTab: 'project', focus: 'details', help: false },
    { mainTab: 'project', focus: 'agents', help: true },
  ]) {
    assert.equal(await f.collector.collect(projectShown(state), f.board, NOW + 1), undefined);
  }
  assert.equal(projectShown({ mainTab: 'project', focus: 'agents', help: false }, true), false);
  assert.deepEqual(calls, { readSync: 0, lstatSync: 0, opendirSync: 0 });
  fs.renameSync(join(f.cwd, '.git'), join(f.cwd, '.git-hidden'));
  const warm = await f.collector.collect(true, f.board, NOW + 4999);
  assert.equal(
    warm.git.branch,
    'synthetic-project',
    'no git probe before five seconds, even when repository disappears'
  );
  assert.equal(calls.readSync, 0);
  assert.equal(calls.opendirSync, 0);
  assert.ok(calls.lstatSync > 0);
  assert.equal(
    warm.slices.some((s) => s.label === 'NO-JOB'),
    true,
    'worktree list shares the git gate'
  );
  const expired = await f.collector.collect(true, f.board, NOW + 5000);
  assert.equal(expired.git, undefined, 'a failed git refresh is unknown, not stale success');
  assert.equal(
    expired.slices.some((s) => s.label === 'NO-JOB'),
    false
  );
});
const hubEntries = (frame) => [...new Set(frame.workboard.rows.map((r) => r.item).filter((i) => i?.startsWith('project:page:')))];
const click = (frame, x, y) => handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x, y }, ctx(frame));
test('Hub: project name, Waiting folds, one entry per page; Enter opens a page; Esc and the crumb return to the hub', async (t) => {
  const f = await fixture(t);
  let frame = f.render(80);
  assert.match(plain(frame).join('\n'), /^demo-project ─/m);
  assert.deepEqual(hubEntries(frame), ['progress', 'tree', 'docs', 'control'].map((p) => `project:page:${p}`), 'no tickets: no Tickets entry');
  assert.equal(frame.state.projectCursor, 'project:page:progress', 'the cursor starts on a page, not on the Waiting fold');
  assert.match(plain(frame).join('\n'), /Try the Project tab/);
  assert.match(plain(frame).join('\n'), /Progress +M3b · 1 working · 1 to try/);
  assert.match(plain(frame).join('\n'), /Control plane +7 roles · keys 3\/5 · browser ✓/);
  frame.state.projectCursor = 'project:fold:waiting';
  frame = f.render(80, 'en', press(frame, 'enter').state);
  assert.match(plain(frame).join('\n'), /▸ Waiting for you/);
  assert.doesNotMatch(plain(frame).join('\n'), /Try the Project tab/);
  frame = f.render(80, 'en', press(frame, 'enter').state);
  assert.match(plain(frame).join('\n'), /Try the Project tab/);
  // Down visits each entry once: the Progress bar row below its entry does not trap the cursor.
  frame.state.projectCursor = 'project:page:progress';
  const visited = [];
  for (let i = 0; i < 4; i++) {
    frame = f.render(80, 'en', press(frame, 'down').state);
    visited.push(frame.state.projectCursor);
  }
  assert.deepEqual(visited, ['tree', 'docs', 'control', 'control'].map((p) => `project:page:${p}`));
  for (const page of ['progress', 'tree', 'docs', 'control']) {
    frame.state.projectCursor = `project:page:${page}`;
    frame = f.render(80, 'en', press(frame, 'enter').state);
    assert.equal(frame.state.projectPage, page);
    assert.equal(projectShown(frame.state), true, 'a page is Project: collection runs');
    assert.match(frame.lines[0] && stripAnsi(frame.lines[0]), /^‹ Project › /);
    const crumb = frame.controls.find((c) => c.kind === 'board-back');
    assert.deepEqual([crumb.x, crumb.y, crumb.width], [0, 0, 80], 'the whole crumb row goes back');
    frame = f.render(80, 'en', press(frame, 'escape').state);
    assert.equal(frame.state.projectPage, undefined);
    assert.equal(frame.state.projectCursor, `project:page:${page}`);
    assert.match(stripAnsi(frame.lines[0]), /^ Home 1  Project 2/);
    frame = f.render(80, 'en', press(frame, 'enter').state);
    frame = f.render(80, 'en', click(frame, 33, 0).state);
    assert.equal(frame.state.projectPage, undefined, 'a click anywhere on the crumb returns');
    assert.equal(frame.state.mainTab, 'project', 'to the hub, not to Home');
  }
  // Esc on the hub is not consumed: the panel decides what it means there.
  assert.equal(press(frame, 'escape').state.projectPage, undefined);
  assert.equal(press(frame, 'escape').state.mainTab, 'project');
  // One click opens a hub entry, the Progress bar included; no editor or execution action.
  for (const [page, at] of [['docs', 'project:page:docs'], ['progress', 'project:page:progress']]) {
    const rows = frame.workboard.rows, index = rows.findIndex((r) => r.item === at) + (page === 'progress' ? 1 : 0);
    const result = click(frame, 10, index + 1);
    assert.equal(result.state.projectPage, page);
    assert.equal(result.action, undefined);
  }
});
test('Hub timeline: Waiting for you, Now, Latest newest first with ages, then a row a page; a short panel loses Latest first, then the bar and the gaps, never the rest', async (t) => {
  const f = await fixture(t), hub = (width, height, lang = 'en', data = f.rich) => f.render(width, lang, undefined, height, data);
  for (const lang of ['en', 'zh']) {
    const frame = hub(40, 40, lang), text = plain(frame).join('\n'), word = (en, zh) => (lang === 'en' ? en : zh);
    for (const line of frame.lines) assert.equal(visualLength(line), 40, stripAnsi(line));
    const at = (re) => text.search(re);
    const order = [/^demo-project ─+ 0\.1\.3$/m, new RegExp(`^${word('Waiting for you', '等你处理')} ─+ 2$`, 'm'), new RegExp(`^${word('Now', '现在')} ─+ 3$`, 'm'),
      new RegExp(`^${word('Latest', '最近完成')} ─+ ${word('newest first', '最新在前')}$`, 'm'), /^(Progress|进度) /m, /^(Working tree|工作区) /m, /^(Docs|文档) /m, /^(Control plane|控制面) /m].map(at);
    assert.ok(order.every((n, i) => n >= 0 && (!i || order[i - 1] < n)), `${lang}: ${order}`);
    // Now: a slice with its text when it fits whole and the word for its state; a job no slice shows with its role and minutes.
    assert.match(text, new RegExp(`^ {2}◐ PAGE-ONE {10,}${word('working', '工作中')}$`, 'm'));
    assert.match(text, new RegExp(`^ {2}◆ PAGE-TWO {2}waits for page one +${word('blocked', '受阻')}$`, 'm'));
    assert.match(text, new RegExp(`^ {2}◉ imp {2}Tidy the synthetic docs.* 5${word('m', '分钟')}$`, 'm'));
    // Latest: the three newest landed slices by commit date, each with its state and age.
    assert.deepEqual(text.match(/^ {2}[◇✓] [A-Z-]+/gm), ['  ◇ DATA-ONE', '  ◇ WATCH-LINK', '  ◇ SENTENCE-CUT']);
    assert.match(text, new RegExp(`^ {2}◇ DATA-ONE {10,}${word('to try 1d', '待试用 1天')}$`, 'm'));
    assert.match(text, new RegExp(`^ {2}◇ SENTENCE-CUT {10,}${word('to try 7d', '待试用 7天')}$`, 'm'));
    assert.match(text, /^[█▓░]{40}$/m, 'the current milestone\'s bar under Progress');
    // The four rows under Latest each open their page.
    assert.deepEqual([...new Set(frame.workboard.rows.map((r) => r.item).filter((i) => i?.startsWith('project:page:')))], ['progress', 'tree', 'docs', 'control'].map((p) => `project:page:${p}`));
  }
  // Wider: five rows of Latest, accepted ones with their word; an accepted slice and its text on one row.
  const wide = plain(hub(120, 40)).join('\n');
  assert.deepEqual(wide.match(/^ {2}[◇✓] [A-Z-]+/gm), ['  ◇ DATA-ONE', '  ◇ WATCH-LINK', '  ◇ SENTENCE-CUT', '  ✓ REVIEW-ONE', '  ◇ NATIVE-ROWS']);
  assert.match(wide, /^ {2}✓ REVIEW-ONE {2}the whole-project review, changes required {10,}accepted 8d$/m);
  // A short panel: `room` is the height less the tab row and the footer. Latest gives up its oldest rows one by one, then goes;
  // then the bar, then the blank rows; Waiting for you, Now and the page rows stay (the page scrolls for the rest).
  const shape = (height) => {
    const rows = hub(40, height).workboard.rows, plainRows = rows.map((r) => stripAnsi(r.text).trimEnd());
    return { rows: rows.length, latest: plainRows.filter((r) => /^ {2}[◇✓] /.test(r)).length, bar: plainRows.some((r) => /^[█▓░]+$/.test(r)), blank: plainRows.filter((r) => !r).length,
      kept: ['Waiting for you', 'Now', 'Progress', 'Working tree', 'Docs', 'Control plane'].every((h) => plainRows.some((r) => r.startsWith(h))) && plainRows.filter((r) => /^([?!]|  [◐◆◉]) /.test(r)).length === 5 };
  };
  const shapes = Object.fromEntries([40, 23, 22, 21, 20, 18, 17, 16, 12, 6].map((h) => [h, shape(h)]));
  assert.deepEqual([40, 23, 22, 21, 20].map((h) => shapes[h].latest), [3, 3, 2, 1, 0], 'Latest folds to its newest rows first');
  assert.ok([40, 23, 22, 21, 20, 18].every((h) => shapes[h].bar), 'the bar stays while Latest folds');
  assert.deepEqual([18, 17, 16, 12, 6].map((h) => [shapes[h].bar, shapes[h].blank]), [[true, 3], [false, 3], [false, 0], [false, 0], [false, 0]], 'then the bar, then the gaps');
  for (const h of [40, 23, 22, 21, 20, 18, 17, 16, 12, 6]) {
    assert.ok(shapes[h].kept, `${h}: Waiting for you, Now and the pages stay`);
    if (h >= 17) assert.ok(shapes[h].rows <= h - 2, `${h}: the hub fits the room it has`);
  }
  assert.equal(shapes[40].rows, 21);
  // Nothing landed: no Latest section; nothing waiting: no Waiting for you; the pages never go.
  const quiet = plain(hub(40, 40, 'en', { ...f.rich, ledger: [], waiting: [] })).join('\n');
  assert.doesNotMatch(quiet, /Latest|Waiting for you/);
  assert.match(quiet, /^Control plane /m);
  // The shortest panel scrolls: the cursor goes down to the last page row and the view follows it.
  let frame = hub(40, 8);
  frame.state.projectCursor = 'project:page:control';
  frame = f.render(40, 'en', frame.state, 8, f.rich);
  assert.match(plain(frame).join('\n'), /^Control plane /m);
});
test('Each Project page keeps its own cursor and scroll, leaving it and across a panel reload', async (t) => {
  const f = await fixture(t), height = 8;
  // The healthy roles and the files are open, so the page is longer than the panel.
  let frame = f.render(80, 'en', onPage('control', { projectFolded: new Set(['agents']) }), height);
  for (let i = 0; i < 12; i++) frame = f.render(80, 'en', press(frame, 'down').state, height);
  const { projectCursor: cursor, projectScroll: scroll } = frame.state;
  assert.ok(scroll > 0 && cursor.startsWith('project:') && !cursor.startsWith('project:page:'), 'a short panel scrolls the page with the cursor');
  const before = plain(frame);
  frame = f.render(80, 'en', press(frame, 'escape').state, height);
  assert.equal(frame.state.projectCursor, 'project:page:control');
  frame.state.projectCursor = 'project:page:docs';
  frame = f.render(80, 'en', press(frame, 'enter').state, height);
  frame = f.render(80, 'en', press(frame, 'down').state, height);
  assert.equal(frame.state.projectCursor.endsWith(':1'), true, 'Docs has its own cursor');
  frame = f.render(80, 'en', press(frame, 'escape').state, height);
  frame.state.projectCursor = 'project:page:control';
  frame = f.render(80, 'en', press(frame, 'enter').state, height);
  assert.deepEqual([frame.state.projectCursor, frame.state.projectScroll], [cursor, scroll]);
  assert.deepEqual(plain(frame), before);
  // The panel restarts itself with the whole state, sets included.
  process.env.HUD_PANEL_RELOAD_PLACE = JSON.stringify({ state: frame.state }, (_k, v) => (v instanceof Set ? { panelSet: [...v] } : v));
  const place = readPanelPlace();
  assert.equal(place.state.projectPage, 'control');
  frame = f.render(80, 'en', place.state, height);
  assert.deepEqual([frame.state.projectCursor, frame.state.projectScroll], [cursor, scroll]);
  assert.deepEqual(plain(frame), before);
  // Esc, then the same page again from the hub, still finds its place; so does a reload on the hub.
  frame = f.render(80, 'en', press(frame, 'escape').state, height);
  assert.equal(frame.state.projectPage, undefined);
  assert.equal(frame.state.projectSaved.control.cursor, cursor);
});
test('polish: Next text aligns without filename tails and slice states use the bar colours', async (t) => {
  const f = await fixture(t);
  for (const width of [80, 120])
    for (const lang of ['en', 'zh']) {
      // Two bullets and a `more` row; Enter on it shows all five (and `fewer` folds them again).
      const short = f.render(width, lang, 'progress');
      assert.equal(short.workboard.rows.filter((r) => /:next:\d+$/.test(r.item ?? '')).length, 2);
      const more = short.workboard.rows.find((r) => r.item === 'project:fold:next');
      assert.match(stripAnsi(more.text).trimEnd(), lang === 'en' ? /^ {2}▸ 3 more$/ : /^ {2}▸ 还有 3 项$/);
      short.state.projectCursor = 'project:fold:next';
      const frame = f.render(width, lang, press(short, 'enter').state),
        next = frame.workboard.rows.filter((r) => /:next:\d+$/.test(r.item ?? ''));
      assert.match(stripAnsi(frame.workboard.rows.find((r) => r.item === 'project:fold:next').text).trimEnd(), lang === 'en' ? /^ {2}▾ fewer$/ : /^ {2}▾ 收起$/);
      // Every bullet is one row here (they fit), after a two-cell bullet mark and no filename tail; one that fits has no fold,
      // so Enter and o both open STATE.md.
      assert.equal(next.length, 5);
      for (const [i, row] of next.entries()) {
        const text = stripAnsi(row.text);
        assert.equal(text.indexOf(f.data.next[i].value), 4);
        assert.match(text, /^  → /);
        assert.doesNotMatch(text, /STATE\.md/);
        frame.state.projectCursor = row.item;
        for (const key of ['enter', 'open-session'])
          assert.deepEqual(press(frame, key).action.files, [join(f.cwd, 'docs/handoff/STATE.md')]);
      }
    }
  const coloured = f.render(120, 'en', 'progress', 56, f.data, true, 'unicode', 'mocha');
  // The hub's bar counts the whole ledger when no milestone is current: working first, then blocked.
  const whole = f.render(120, 'en', undefined, 56, { ...f.data, ladder: { ...f.data.ladder, current: undefined } }, true, 'unicode', 'mocha');
  const bar = whole.workboard.rows.find((r) => /^[█▓░]+$/.test(stripAnsi(r.text).trimEnd())).text;
  const inks = [...bar.matchAll(/(\x1b\[[0-9;]+m)[█▓░]+/g)].map((m) => m[1]);
  const row = (frame, id) =>
    frame.workboard.rows.find((r) => stripAnsi(r.text).includes(id) && /:slice:\d+$/.test(r.item ?? '')).text;
  assert.ok(row(coloured, 'NATIVE-TREE').includes(inks[0] + '◐'));
  assert.ok(row(coloured, 'BLOCKED').includes(inks[1] + '◆'));
  for (const id of ['ORPHAN', 'NO-JOB']) assert.match(stripAnsi(row(coloured, id)), /^  ! /);
  const ascii = f.render(80, 'en', 'progress', 56, f.data, true, 'text');
  assert.match(stripAnsi(row(ascii, 'NATIVE-TREE')), /^  @ /);
  assert.match(stripAnsi(row(ascii, 'BLOCKED')), /^  ! /);
});
test('bar proportions fill the hub row in EN/ZH and text icons; the Progress page names only the states that have slices', async (t) => {
  const f = await fixture(t);
  for (const width of [32, 80, 120]) {
    const segments = progressSegments(f.data.counts, width);
    assert.equal(
      segments.reduce((sum, s) => sum + s.width, 0),
      width
    );
    for (const s of segments) assert.ok(Math.abs(s.width - (width * f.data.counts[s.state]) / 7) <= 1);
    // The hub's bar is the current milestone's (M3b: one working, one landed), up to 60 cells, and the row is the panel's width.
    for (const lang of ['en', 'zh']) {
      const bar = f.render(width, lang).workboard.rows.find((r) => /^[█▓░]+$/.test(stripAnsi(r.text).trimEnd()));
      assert.equal(visualLength(bar.text), width);
      assert.equal(stripAnsi(bar.text).trimEnd().length, Math.min(width, 60));
      assert.equal(bar.item, 'project:page:progress');
    }
  }
  const ascii = f.render(80, 'en', undefined, 56, f.data, true, 'text');
  assert.ok(ascii.workboard.rows.some((r) => stripAnsi(r.text).trimEnd() === '#'.repeat(60)));
  assert.doesNotMatch(plain(ascii).join('\n'), /[█▓░●]/);
  assert.doesNotMatch(plain(f.render(80, 'en', 'progress', 56, f.data, true, 'text')).join('\n'), /[█▓░●]/);
  // The Progress page's counts name the states that have slices in the current milestone, none with a zero.
  const text = plain(f.render(120, 'en', 'progress', 56)).join('\n');
  assert.match(text, /^ {2}1 working {2}1 to try$/m);
  assert.doesNotMatch(text, /blocked 0|accepted 0|dropped|\b0 (working|to try)/);
  assert.equal(progressSegments({ working: 2, blocked: 0, try: 0, todo: 1, accepted: 0, dropped: 0 }, 80).find((s) => s.state === 'blocked').width, 0);
});
test('drift distinguishes a missing worktree, an unlisted tree and a landed tree; blocked may have no tree', async (t) => {
  const f = await fixture(t),
    state = join(f.cwd, 'docs/handoff/STATE.md');
  const original = fs.readFileSync(state, 'utf8');
  f.put(state, original.replace('## Now', '- try · M4 · NO-JOB · landed but worktree remains (abcdef0)\n\n## Now'));
  const data = await f.collector.collect(true, f.board, NOW + 1);
  assert.equal(data.counts.try, 2);
  assert.equal(data.slices.find((s) => s.label === 'NO-JOB').drift, 'ledger');
  assert.equal(data.slices.find((s) => s.label === 'NO-JOB').ledgerState, 'try');
  const text = plain(f.render(120, 'en', 'progress', 56, data)).join('\n');
  assert.match(text, /updated 12:35 · ! 2/);
  assert.match(text, /! NO-JOB.*ledger: try/);
  assert.match(text, /! ORPHAN.*no worktree/);
  assert.doesNotMatch(text, /! BLOCKED/);
  f.put(state, original.replace('Milestone: M3b', 'Milestone: UNMATCHED'));
  const noMatch = await f.collector.collect(true, f.board, NOW + 2);
  assert.doesNotMatch(plain(f.render(80, 'en', 'progress', 56, noMatch)).join('\n'), /\[M1\]|\(M3b\)/);
  fs.utimesSync(state, new Date(NOW - 86400000), new Date(NOW - 86400000));
  const old = await f.collector.collect(true, f.board, NOW + 3);
  assert.match(plain(f.render(120, 'en', 'progress', 56, old)).join('\n'), /updated 2026-11-11/);
});
test('slice lines use the same Home worker fact/model and keep hidden jobs available; files fall back to STATE', async (t) => {
  const f = await fixture(t),
    worker = f.board.workers.find((w) => w.evidence[0]?.sourceId === 'j0000000000000002');
  const home = renderWorkCard(projectWorkCard(worker, NOW), initialMonitorState(), 120).map(stripAnsi).join('\n');
  assert.match(home, /Question: Which synthetic option\?/);
  assert.match(plain(f.render(120, 'en', 'progress')).join('\n'), /now: Question: Which synthetic option\?/);
  worker.modelSentence = 'Building «synthetic agents» in the Home lane.';
  assert.match(plain(f.render(120, 'en', 'progress')).join('\n'), /now: Building synthetic agents in the Home lane\./);
  const coloured = f.render(120, 'en', 'progress', 56, f.data, true, 'unicode', 'mocha');
  assert.match(
    coloured.workboard.rows.find((r) => stripAnsi(r.text).includes('now: Building')).text,
    /\x1b\[[0-9;]+msynthetic agents\x1b\[0m/
  );
  assert.doesNotMatch(plain(f.render(120, 'en', 'progress', 56, f.data, false)).join('\n'), /Building synthetic agents/);
  assert.match(
    plain(f.render(120, 'en', 'progress', 56, f.data, false)).join('\n'),
    /now: Question: Which synthetic option\?/
  );
  worker.state = 'done';
  worker.settledAt = NOW - 3600000;
  worker.homeNeedsHuman = false;
  const hidden = f.render(120, 'en', 'progress');
  assert.equal(
    hidden.workboard.snapshot.workers.some((w) => w.id === worker.id),
    false
  );
  assert.match(plain(hidden).join('\n'), /now: Building synthetic agents/);
  fs.unlinkSync(join(f.sliceJob, 'report.md'));
  let data = await f.collector.collect(true, f.board, NOW + 1);
  assert.equal(data.slices.find((s) => s.label === 'NATIVE-TREE').path, join(f.sliceJob, 'brief.md'));
  fs.unlinkSync(join(f.sliceJob, 'brief.md'));
  data = await f.collector.collect(true, f.board, NOW + 2);
  assert.equal(data.slices.find((s) => s.label === 'NATIVE-TREE').path, join(f.cwd, 'docs/handoff/STATE.md'));
  const frame = f.render(120, 'en', 'progress', 56, data);
  for (const suffix of ['summary', 'bar', 'slice:0']) {
    frame.state.projectCursor = frame.workboard.rows.find((r) => r.item?.endsWith(suffix)).item;
    assert.deepEqual(press(frame, 'enter').action.files, [join(f.cwd, 'docs/handoff/STATE.md')]);
  }
});
test('job lookup reads only job/STATUS in the newest 64 directories and resolves cwd aliases', async (t) => {
  const f = await fixture(t),
    alias = join(f.root, 'linked-alias');
  fs.symlinkSync(f.linked[0], alias);
  for (const id of ['j0000000000000001', 'j0000000000000002'])
    fs.utimesSync(join(f.hud, 'jobs', id), new Date(NOW - 86400000), new Date(NOW - 86400000));
  const ids = [];
  for (let i = 0; i < 66; i++) {
    const id = `j${(100 + i).toString(16).padStart(16, '0')}`,
      dir = join(f.hud, 'jobs', id);
    ids.push(id);
    f.put(join(dir, 'job.json'), {
      job: id,
      role: 'imp',
      cwd: i < 2 ? alias : join(f.root, `unrelated-${i}`),
      created_at: new Date(NOW - i * 1000).toISOString(),
    });
    f.put(join(dir, 'STATUS.json'), { state: 'working' });
    fs.utimesSync(dir, new Date(NOW - i * 1000), new Date(NOW - i * 1000));
  }
  const original = fs.openSync,
    opened = [];
  fs.openSync = (path, ...args) => {
    if (String(path).includes('/jobs/')) opened.push(String(path));
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  let data;
  try {
    data = await f.collector.collect(true, f.board, NOW + 1);
  } finally {
    fs.openSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(data.slices.find((s) => s.label === 'NATIVE-TREE').jobId, ids[0]);
  const readIds = new Set(opened.map((p) => p.match(/\/jobs\/(j[0-9a-f]+)\//)[1]));
  assert.equal(readIds.size, 64);
  assert.equal(readIds.has(ids[64]), false);
  assert.equal(readIds.has(ids[65]), false);
  assert.ok(
    opened.every((p) => /\/(job|STATUS)\.json$/.test(p)),
    'no question, brief or report body reads'
  );
});
test('changed/oversized sources, missing milestone and source fallback never invent facts', async (t) => {
  const f = await fixture(t);
  f.put(
    join(f.cwd, 'docs/handoff/STATE.md'),
    '# No milestone\n\n## Waiting for the owner\n- New owner item\n\n## Other\n- Not waiting\n'
  );
  f.put(
    join(f.hud, 'credentials.env'),
    "MISTRAL_API_KEY=\nOPENAI_API_KEY=   \nTYPESAFE_API_KEY=''\nOTHER_NAME=synthetic\n"
  );
  let data = await f.collector.collect(true, f.board, NOW + 1);
  assert.deepEqual(
    data.waiting.map((i) => i.value),
    ['New owner item']
  );
  assert.equal(
    data.docs.some((i) => i.label === 'spec'),
    false
  );
  assert.deepEqual(data.ladder.ids, ['M1', 'M2', 'M3', 'M3b', 'M4']);
  const noMilestone = plain(f.render(80, 'en', 'progress', 56, data)).join('\n');
  // Nothing says which milestone is current, and the ledger is gone: no bar, no milestone rows, only what is running.
  assert.doesNotMatch(noMilestone, /M1|M3b|▸ M|\[M1\]|\(M3b\)|0\/\d/);
  assert.deepEqual(data.keys, [
    ['GEMINI_API_KEY', false],
    ['MISTRAL_API_KEY', false],
    ['OPENAI_API_KEY', false],
    ['TYPESAFE_API_KEY', false],
    ['OTHER_NAME', true],
  ]);
  f.put(join(f.cwd, 'docs/handoff/STATE.md'), 'Milestone:\n\n## Waiting for the owner\n- Still waiting\n');
  data = await f.collector.collect(true, f.board, NOW + 1);
  assert.equal(
    data.docs.some((i) => i.label === 'spec'),
    false,
    'an empty milestone must not consume the next heading'
  );
  fs.unlinkSync(join(f.env.PATH, 'google-chrome'));
  fs.unlinkSync(join(f.cwd, 'hud-convention.md'));
  f.put(join(f.hud, 'hud-convention.md'), '# User convention');
  f.put(join(f.cwd, 'docs/handoff/STATE.md'), 'x'.repeat(65536) + '\nMilestone: NEVER_READ_TAIL\n');
  data = await f.collector.collect(true, f.board, NOW + 2);
  assert.equal(
    data.docs.some((i) => i.label === 'spec'),
    false
  );
  assert.equal(data.control.find((i) => i.label === 'convention').value, 'yours');
  assert.equal(data.browser, false);
  assert.doesNotMatch(JSON.stringify(data), /NEVER_READ_TAIL/);
  f.put(join(f.hud, 'roles/imp.json'), {
    role: 'imp',
    harness: 'pi',
    pi_role: 'implementer',
    split: true,
    can_continue: true,
    model: 'override/model',
    thinking: 'low',
  });
  data = await f.collector.collect(true, f.board, NOW + 3);
  assert.deepEqual(data.roles.find((r) => r.role === 'imp').places.map((p) => [p.model, p.thinking]), [['override/model', 'low']]);
});
