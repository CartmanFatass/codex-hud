import { withState, sliceState } from '../fixtures/state-helpers.mjs';
import { projectPageOf } from '../../dist/render/project-view.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { projectFixture, projectFrames, plain, onPage, onControl, PAGES, PROJECTS, NOW, TREE } from '../fixtures/project-page.mjs';
import { progressSegments } from '../../dist/render/project-view.js';
import { workInspectorRows } from '../../dist/render/work-inspector.js';
import { projectWorkCard } from '../../dist/collectors/work-card.js';
import { projectShown } from '../../dist/collectors/project-board.js';
import { STATE_BYTES } from '../../dist/collectors/state-ledger.js';
import { handleMonitorInput } from '../../dist/render/monitor.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { openEditorPane, openGitShowPane } from '../../dist/cli/panel-pane.js';
import { encodePanelPlace, readPanelPlace } from '../../dist/utils/panel-reload.js';
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
  assert.match(plain(f.render(120)).join('\n'), /Worktree +synthetic-project · \d+ changed · 1 unlisted worktree · 2 worktrees/);
  assert.match(f.data.last.text, /Synthetic Project baseline/);
  assert.equal(f.data.waiting.length, 2);
  assert.match(f.data.waiting[1].value, /after trying the synthetic setup/);
  assert.equal(f.data.editing.length, 2);
  assert.equal(f.data.docs[0].value, 'M3b · AI-THIN');
  assert.deepEqual(f.data.counts, { working: 2, blocked: 1, try: 1, todo: 1, accepted: 1, dropped: 1 });
  assert.deepEqual(f.data.ladder.ids, ['M1', 'M2', 'M3', 'M3b', 'M4']);
  assert.equal(f.data.ladder.current, 'M3b');
  assert.equal(f.data.summary, 'Synthetic milestone closing; pages building in worktrees');
  assert.equal(f.data.slices.find((s) => s.label === 'NATIVE-TREE-01').path, join(f.sliceJob, 'report.md'));
  assert.deepEqual(
    f.data.slices.filter((s) => s.drift).map((s) => [s.label, s.drift]),
    [
      ['NO-JOB', 'no linked ticket'],
    ]
  );
  assert.equal(f.data.next.length, 5);
  assert.equal(f.data.next[0].value, 'NATIVE-TREE: native subagents on Home beside package lanes');
  assert.match(f.data.docs[1].path, /2026-11-12-review.md$/);
  const first = (name) => f.data.roles.find((r) => r.role === name);
  assert.deepEqual(first('imp').places, [{ harness: 'pi', label: 'pi', model: 'synthetic/model', thinking: 'high', inheritedThinking: true, state: 'active', provider: 'synthetic',
    piModel: { current: 'synthetic/model', isDefault: true, defaultId: 'synthetic/model', defaultSource: 'from pi role', defaultOff: false } }]);
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
    ['oracle', 'roles'], ['pro', 'browser'], ['flow', 'browser'], ['council', 'roles'], ['general', 'roles']]);
  assert.deepEqual(first('oracle').places.map((p) => [p.label, p.model, p.state]),
    [['claude', 'fable', 'missing'], ['pi', null, 'active']]);
  for (const name of ['pro', 'flow', 'council']) {
    assert.equal(first(name).optionalEnabled, false);
    assert.deepEqual(first(name).places, []);
  }
  assert.deepEqual([first('imp').path, first('imp').source, first('sonic').source], [join(f.hud, 'roles/imp.json'), 'yours', 'default']);
  assert.equal(f.data.roleCount, 5);
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
      assert.doesNotMatch(text(hub, pages.progress, pages.tree, pages.docs, pages.control), /NEVER_RENDER|unrelated bullet|M5|NOT-A-MILESTONE/);
      assert.match(text(pages.tickets), lang === 'en' ? /Project › Tickets/ : /项目 › 工单/);
      assert.match(text(pages.progress), /^ {2}◐ native-tree +◐ 1 {2}◇ 1/m);
      assert.match(text(pages.progress), lang === 'en' ? /^Next ─+ 5$/m : /^下一步 ─+ 5$/m);
      if (width >= 80) {
        const detail = f.render(width, lang, onPage('progress', { project: { folded: new Set(['task:milestone:native-tree']) } }));
        assert.match(text(detail), /Which synthetic option\?/);
        assert.match(text(pages.control), lang === 'en' ? /unparseable JSON/ : /JSON 无法解析/);
        assert.match(text(pages.control), /bad\.json/);
      }
      if (lang === 'zh') {
        assert.match(text(hub), /^ 首页  项目 \?2/m);
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
test('the Project milestone ladder matches a numeric version from STATE', async (t) => {
  const f = await fixture(t);
  f.put(join(f.cwd, 'docs/spec.md'), '# Synthetic spec\n\n## 5. Milestones\n\n- **M1, start.**\n- **0.2.0, sample release.**\n');
  f.put(join(f.cwd, 'docs/handoff/STATE.md'), '# Synthetic state\n\nMilestone: 0.2.0 · sample release\n');
  const data = await f.collector.collect(true, f.board, NOW + 1);
  assert.deepEqual(data.ladder, { ids: ['M1', '0.2.0'], current: '0.2.0' });
  assert.ok(data.ledger.every(row => row.release === '0.2.0'));
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
    can_continue: true,
    run: [{ harness: 'cli', agent: 'grok', model: 'project-cli', thinking: 'high' }],
  });
  f.put(join(f.cwd, '.hud/project.json'), { version: 1, roles: ['imp', 'frontend', 'local-cli', 'missing'] });
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
  const cli = role('local-cli');
  assert.deepEqual([cli.group, cli.source, cli.path, cli.editor], ['project', 'project', join(root, '.hud/roles/cli.json'), undefined]);
  assert.deepEqual(cli.places.map((p) => [p.harness, p.label, p.model, p.thinking]), [['cli', 'grok', 'project-cli', 'high']]);
  assert.equal(data.control.some((r) => r.label === 'invalid' && r.path === cli.path), false);
  assert.doesNotMatch(JSON.stringify(data), /NEVER_RENDER/);
});
test('Control plane page: what needs the owner first, healthy roles and files folded; Enter opens them, the agents fold inside Files', async (t) => {
  const f = await fixture(t);
  const render = (state) => f.render(80, 'en', state, 64);
  let frame = render('control');
  let text = plain(frame).join('\n');
  // Intentionally off roles have their own section, not an alert alongside bad.json.
  assert.match(text, /^Needs attention ─+ 1$/m);
  assert.match(text, /^ {2}! bad\.json +unparseable JSON$/m);
  assert.match(text, /^▸ Healthy ─+ 5$/m);
  assert.match(text, /^ {2}◉ imp {2}reviewer {2}sonic {2}oracle {2}general$/m);
  assert.match(text, /^Optional roles ─+\n {2}⊘ pro +Off\n {2}⊘ flow +Off$/m);
  assert.match(text, /^▸ Files ─+ keys 3\/5 · browser ✓$/m);
  assert.doesNotMatch(text, /synthetic\/model|project-agent\.md|▸ agents/);
  frame.state.control.roles.nav.cursor = 'project:fold:healthy';
  frame = render(press(frame, 'enter').state);
  assert.match(plain(frame).join('\n'), /^Healthy ─+ 5$/m);
  assert.match(plain(frame).join('\n'), /imp → synthetic\/model/);
  frame.state.control.roles.nav.cursor = 'project:fold:files';
  frame = render(press(frame, 'enter').state);
  assert.match(plain(frame).join('\n'), /▸ agents/);
  assert.doesNotMatch(plain(frame).join('\n'), /project-agent\.md/);
  frame.state.control.roles.nav.cursor = 'project:fold:agents';
  frame = render(press(frame, 'enter').state);
  for (const name of ['user-agent.md', 'project-agent.md', 'codex-agent.toml'])
    assert.match(plain(frame).join('\n'), new RegExp(name));
  frame.state.control.roles.nav.cursor = 'project:fold:agents';
  frame = render(press(frame, 'enter').state);
  assert.doesNotMatch(plain(frame).join('\n'), /project-agent\.md/);
  frame.state.control.roles.nav.cursor = 'project:fold:healthy';
  frame = render(press(frame, 'enter').state);
  assert.match(plain(frame).join('\n'), /^▸ Healthy ─+ 5$/m, 'a second Enter folds the roles again');
});
test('arrows/Tab cycle main tabs with independent Project cursor/scroll; digits and retired f switch no view', async (t) => {
  const f = await fixture(t),
    decoder = new WorkbenchInputDecoder('workboard');
  const send = (frame, raw) => handleMonitorInput(frame.state, decoder.push(Buffer.from(raw))[0], ctx(frame));
  let frame = f.render(80, 'en', withState(sliceState(), { home: { scroll: 3 } }));
  assert.equal(projectShown(frame.state), false);
  frame = f.render(80, 'en', send(frame, '2').state);
  assert.equal(frame.state.activeTab, 'home', 'a digit is no tab key');
  frame = f.render(80, 'en', send(frame, '\x1b[C').state);
  assert.equal(frame.state.activeTab, 'project');
  assert.equal(projectShown(frame.state), true);
  frame.state.project.nav.cursor = 'project:page:docs';
  for (const [raw, order] of [['\x1b[D', ['home', 'control', 'project']], ['\x1b[C', ['control', 'home', 'project']], ['\t', ['control', 'home', 'project']], ['\x1b[Z', ['home', 'control', 'project']]]) {
    for (const tab of order) {
      frame = f.render(80, 'en', send(frame, raw).state);
      assert.equal(frame.state.activeTab, tab);
    }
    assert.equal(frame.state.project.nav.cursor, 'project:page:docs');
  }
  const homeControl = frame.controls.find((c) => c.kind === 'board-home');
  frame = f.render(
    80,
    'en',
    handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: homeControl.x, y: 0 }, ctx(frame)).state
  );
  assert.equal(frame.state.activeTab, 'home');
  const control = frame.controls.find((c) => c.kind === 'board-project');
  frame = f.render(
    80,
    'en',
    handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: control.x, y: 0 }, ctx(frame)).state
  );
  assert.equal(frame.state.activeTab, 'project');
  frame = f.render(80, 'en', send(frame, '3').state);
  assert.equal(frame.state.subpage, undefined, 'a digit opens no page');
  frame = f.render(80, 'en', send(frame, 'f').state);
  assert.equal(frame.state.subpage, undefined);
  assert.equal(projectShown(frame.state), true);
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
  // Files open from the hub's Waiting items (with o: Enter reads the item on its page) and from every page (the to-try count too: Enter filters there).
  const found = [undefined, 'progress', 'tree', 'docs', 'control'].flatMap((page) => {
    const frame = f.render(80, 'en', page === 'control' ? onControl({ folded: new Set(['agents']) }) : page, 80);
    return frame.workboard.rows.filter((r) => r.files).map((row) => ({ frame, row }));
  });
  assert.ok(found.length > 20);
  for (const { frame, row } of found) {
    if (frame.state.activeTab === 'control') frame.state.control.roles.nav.cursor = row.item;
    else frame.state.project.nav.cursor = row.item;
    for (const key of /^(?:project:(?:wait:|try$|role:[^:]+$|fold:)|inbox:ask:)/.test(row.item) ? ['open-session'] : ['enter', 'open-session'])
      assert.deepEqual(press(frame, key).action, { type: 'open-files', files: row.files });
  }
  const { frame, row: file } = found.find(({ row }) => row.files[0] === f.data.docs[1].path);
  frame.state.project.nav.cursor = file.item;
  await openEditorPane(press(frame, 'enter').action.files, env);
  assert.deepEqual(calls(), [
    ['pane', 'get', 'w4E:p2'],
    ['tab', 'create', '--workspace', 'w4E', '--cwd', process.cwd(), '--label', '2026-11-12-review.md', '--focus'],
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
test('Commit evidence opens git show in the Objective project’s focused tab', async (t) => {
  const f = await fixture(t), { env, calls } = editorHerdr(f);
  await assert.rejects(openGitShowPane(f.cwd, '123abcd; exit', env), /invalid_commit_hash/);
  await openGitShowPane(f.cwd, '123abcd', env);
  assert.deepEqual(calls().slice(0, 2), [
    ['pane', 'get', 'w4E:p2'],
    ['tab', 'create', '--workspace', 'w4E', '--cwd', f.cwd, '--label', '123abcd', '--focus'],
  ]);
  assert.deepEqual(calls()[2].slice(0, 3), ['pane', 'run', 'w4E:p3']);
  assert.match(calls()[2][3], /git .* show --no-ext-diff --no-textconv 123abcd --$/);
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
    sliceState(),
    { activeTab: 'project', subpage: { kind: 'inspector', target: { kind: 'lane', laneId: 'synthetic' }, scroll: 0 }, help: undefined },
    { activeTab: 'project', subpage: undefined, help: {} },
  ]) {
    assert.equal(await f.collector.collect(projectShown(state), f.board, NOW + 1), undefined);
  }
  assert.equal(projectShown({ activeTab: 'project', subpage: undefined, help: undefined }, true), false);
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
test('Hub: project name, first attention row, one entry per page; Enter opens a page; Esc and the crumb return to the hub', async (t) => {
  const f = await fixture(t);
  let frame = f.render(80);
  assert.match(plain(frame).join('\n'), /^demo-project ─/m);
  assert.deepEqual(hubEntries(frame), ['tickets', 'progress', 'tree', 'docs'].map((p) => `project:page:${p}`));
  assert.equal(frame.state.project.nav.cursor, 'project:wait:0', 'the cursor starts on the first explicit request');
  assert.match(plain(frame).join('\n'), /Try the Project tab/);
  assert.match(plain(frame).join('\n'), /^Progress +M3b · \d+ working · \d+ to do/m);
  assert.doesNotMatch(plain(frame).join('\n'), /Accept all|\d+ to try/);
  assert.doesNotMatch(plain(frame).join('\n'), /^Control plane /m);
  // Down visits each page entry once.
  frame.state.project.nav.cursor = 'project:page:tickets';
  const visited = [];
  for (let i = 0; i < 3; i++) {
    frame = f.render(80, 'en', press(frame, 'down').state);
    visited.push(frame.state.project.nav.cursor);
  }
  assert.deepEqual(visited, ['project:page:progress', 'project:page:tree', 'project:page:docs']);
  for (const page of ['progress', 'tickets', 'tree', 'docs']) {
    frame.state.project.nav.cursor = `project:page:${page}`;
    frame = f.render(80, 'en', press(frame, 'enter').state);
    assert.equal(projectPageOf(frame.state), page);
    assert.equal(projectShown(frame.state), true, 'a page is Project: collection runs');
    assert.match(frame.lines[0] && stripAnsi(frame.lines[0]), /^‹ Project › /);
    const crumb = frame.controls.find((c) => c.kind === 'board-back');
    assert.deepEqual([crumb.x, crumb.y, crumb.width], [0, 0, 80], 'the whole crumb row goes back');
    frame = f.render(80, 'en', press(frame, 'escape').state);
    assert.equal(projectPageOf(frame.state), undefined);
    assert.equal(frame.state.project.nav.cursor, `project:page:${page}`);
    assert.match(stripAnsi(frame.lines[0]), /^ Home  Project \?2/);
    frame = f.render(80, 'en', press(frame, 'enter').state);
    frame = f.render(80, 'en', click(frame, 33, 0).state);
    assert.equal(projectPageOf(frame.state), undefined, 'a click anywhere on the crumb returns');
    assert.equal(frame.state.activeTab, 'project', 'to the hub, not to Home');
  }
  // Esc on the hub is not consumed: the panel decides what it means there.
  assert.equal(projectPageOf(press(frame, 'escape').state), undefined);
  assert.equal(press(frame, 'escape').state.activeTab, 'project');
  // One click opens a hub entry; no editor or execution action.
  for (const page of ['docs', 'progress']) {
    const rows = frame.workboard.rows, index = rows.findIndex((r) => r.item === `project:page:${page}`);
    const result = click(frame, 10, index + 1);
    assert.equal(projectPageOf(result.state), page);
    assert.equal(result.action, undefined);
  }
});
test('Each Project page keeps its own cursor and scroll, leaving it and across a panel reload', async (t) => {
  const f = await fixture(t), height = 8;
  let frame = f.render(80, 'en', onPage('progress'), height, f.rich);
  const draw = (state) => f.render(80, 'en', state, height, f.rich);
  for (let i = 0; i < 12; i++) frame = draw(press(frame, 'down').state);
  const { project: { nav: { cursor, scroll } } } = frame.state;
  assert.ok(scroll > 0 && cursor.startsWith('project:') && !cursor.startsWith('project:page:'), 'a short panel scrolls the page with the cursor');
  const before = plain(frame);
  frame = draw(press(frame, 'escape').state);
  assert.equal(frame.state.project.nav.cursor, 'project:page:progress');
  frame.state.project.nav.cursor = 'project:page:docs';
  frame = draw(press(frame, 'enter').state);
  frame = draw(press(frame, 'down').state);
  assert.equal(frame.state.project.nav.cursor.endsWith(':1'), true, 'Docs has its own cursor');
  frame = draw(press(frame, 'escape').state);
  frame.state.project.nav.cursor = 'project:page:progress';
  frame = draw(press(frame, 'enter').state);
  assert.deepEqual([frame.state.project.nav.cursor, frame.state.project.nav.scroll], [cursor, scroll]);
  assert.deepEqual(plain(frame), before);
  // The panel restarts itself with the whole state, sets included.
  process.env.HUD_PANEL_RELOAD_PLACE = encodePanelPlace({ state: frame.state, settings: null });
  const place = readPanelPlace(frame.state.prefs);
  assert.equal(projectPageOf(place.state), 'progress');
  frame = draw(place.state);
  assert.deepEqual([frame.state.project.nav.cursor, frame.state.project.nav.scroll], [cursor, scroll]);
  assert.deepEqual(plain(frame), before);
  // Esc, then the same page again from the hub, still finds its place; so does a reload on the hub.
  frame = f.render(80, 'en', press(frame, 'escape').state, height);
  assert.equal(projectPageOf(frame.state), undefined);
  assert.equal(frame.state.project.savedPages.progress.cursor, cursor);
});
test('Next text aligns without filename tails', async (t) => {
  const f = await fixture(t);
  for (const width of [80, 120])
    for (const lang of ['en', 'zh']) {
      // Two bullets and a `more` row; Enter on it shows all five (and `fewer` folds them again).
      const short = f.render(width, lang, 'progress');
      assert.equal(short.workboard.rows.filter((r) => /:next:\d+$/.test(r.item ?? '')).length, 2);
      const more = short.workboard.rows.find((r) => r.item === 'project:fold:next');
      assert.match(stripAnsi(more.text).trimEnd(), lang === 'en' ? /^ {2}▸ 3 more$/ : /^ {2}▸ 还有 3 项$/);
      short.state.project.nav.cursor = 'project:fold:next';
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
        frame.state.project.nav.cursor = row.item;
        for (const key of ['enter', 'open-session'])
          assert.deepEqual(press(frame, key).action.files, [join(f.cwd, 'docs/handoff/STATE.md')]);
      }
    }
});
test('bar proportions fill the allotted cells; the Progress task counts use only states present', async (t) => {
  const f = await fixture(t);
  for (const width of [32, 80, 120]) {
    const segments = progressSegments(f.data.counts, width);
    assert.equal(
      segments.reduce((sum, s) => sum + s.width, 0),
      width
    );
    for (const s of segments) assert.ok(Math.abs(s.width - (width * f.data.counts[s.state]) / 7) <= 1);
  }
  const ascii = f.render(80, 'en', 'progress', 56, f.data, true, 'text');
  assert.match(plain(ascii).join('\n'), /^  @ native-tree +@ 1 {2}o 1/m);
  assert.doesNotMatch(plain(ascii).join('\n'), /[█▒░●]/);
  assert.equal(progressSegments({ working: 2, blocked: 0, try: 0, todo: 1, accepted: 0, dropped: 0 }, 80).find((s) => s.state === 'blocked').width, 0);
});
test('Progress dates STATE notes but does not flag working tickets that have no worktree', async (t) => {
  const f = await fixture(t), state = join(f.cwd, 'docs/handoff/STATE.md');
  fs.utimesSync(state, new Date(NOW - 86400000), new Date(NOW - 86400000));
  const data = await f.collector.collect(true, f.board, NOW + 1);
  const opened = onPage('progress', { project: { folded: new Set(['task:milestone:queue']) } });
  const text = plain(f.render(120, 'en', opened, 56, data)).join('\n');
  assert.match(text, /updated 2026-11-11/);
  assert.match(text, /◐ QUEUE-04 +working/);
  assert.doesNotMatch(text, /no worktree|not in ledger|NO-JOB/);
});
test('ticket lines use worker facts and declared summaries, retain older jobs and open ticket files', async (t) => {
  const f = await fixture(t),
    worker = f.board.workers.find((w) => w.evidence[0]?.sourceId === 'j0000000000000002');
  const home = workInspectorRows(worker, 120, NOW).map(r => stripAnsi(r.text)).join('\n');
  assert.match(home, /Question: Which synthetic option\?/);
  const opened = onPage('progress', { project: { folded: new Set(['task:milestone:native-tree']) } });
  assert.match(plain(f.render(120, 'en', opened)).join('\n'), /Which synthetic option\?/);
  worker.state = 'done';
  worker.settledAt = NOW - 3600000;
  worker.homeNeedsHuman = false;
  worker.reportMeta = { summary: 'Built «synthetic agents».' };
  const hidden = f.render(120, 'en', opened);
  assert.equal(
    hidden.workboard.snapshot.workers.some((w) => w.id === worker.id),
    true
  );
  assert.match(plain(hidden).join('\n'), /Built «synthetic agents»\./);
  fs.unlinkSync(join(f.sliceJob, 'report.md'));
  let data = await f.collector.collect(true, f.board, NOW + 1);
  assert.equal(data.slices.find((s) => s.label === 'NATIVE-TREE-01').path, join(f.sliceJob, 'brief.md'));
  fs.unlinkSync(join(f.sliceJob, 'brief.md'));
  data = await f.collector.collect(true, f.board, NOW + 2);
  const ticket = join(f.cwd, '.scratch/native-tree/issues/01-sample.md');
  assert.equal(data.slices.find((s) => s.label === 'NATIVE-TREE-01').path, ticket);
  const frame = f.render(120, 'en', opened, 56, data);
  frame.state.project.nav.cursor = 'project:fold:task:milestone:native-tree';
  assert.ok(press(frame, 'open-session').action.files[0].startsWith(join(f.cwd, '.scratch/native-tree/issues/')));
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
      ...(i < 2 ? { worktree: { root: f.linked[0], main_root: f.cwd, branch: 'wt/NATIVE-TREE-01' }, ticket: 'native-tree/01' } : {}),
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
  assert.equal(data.slices.find((s) => s.label === 'NATIVE-TREE-01').jobId, ids[0]);
  const readIds = new Set(opened.map((p) => p.match(/\/jobs\/(j[0-9a-f]+)\//)[1]));
  assert.equal(readIds.size, 64);
  assert.equal(readIds.has(ids[64]), false);
  assert.equal(readIds.has(ids[65]), false);
  assert.ok(
    opened.every((p) => /\/(job|STATUS)\.json$/.test(p)),
    'no question, brief or report body reads'
  );
});
test('Project Docs finds the newest dated review beyond the first 128 entries', async (t) => {
  const f = await fixture(t), reviews = join(f.cwd, 'docs/reviews');
  const names = Array.from({ length: 200 }, (_, i) => `${new Date(Date.UTC(2026, 4, 1 + i)).toISOString().slice(0, 10)}-review.md`);
  const newest = names.at(-1), order = [...names];
  let seed = 42;
  for (let i = order.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const name of order) f.put(join(reviews, name), '# Synthetic review', name === newest ? 5 : 60);
  f.put(join(reviews, 'README.md'), '# Not a review');
  f.put(join(reviews, 'notes.md'), '# Also not a review');

  // Replay the shuffled creation order so the regression does not depend on the filesystem's enumeration order.
  const opendir = fs.opendirSync;
  fs.opendirSync = (path, ...args) => {
    const dir = opendir(path, ...args);
    if (path !== reviews) return dir;
    const entries = new Map();
    for (let entry; (entry = dir.readSync());) entries.set(entry.name, entry);
    const ordered = ['README.md', 'notes.md', ...order].map((name) => entries.get(name)).values();
    dir.readSync = () => ordered.next().value ?? null;
    return dir;
  };
  syncBuiltinESMExports();
  let data;
  try { data = await f.collector.collect(true, f.board, NOW + 1); }
  finally { fs.opendirSync = opendir; syncBuiltinESMExports(); }
  assert.equal(data.docs.find((d) => d.label === 'review')?.value, newest);
  assert.ok(plain(f.render(80, 'en', 'docs', 56, data)).some((line) => line.includes(newest)));
});
test('Project warns in EN and ZH when STATE or spec exceeds the byte cap', async (t) => {
  const f = await fixture(t), statePath = join(f.cwd, 'docs/handoff/STATE.md'), specPath = join(f.cwd, 'docs/spec.md');
  const stateHead = '# 合成状态\n\nMilestone: M4\n';
  const stateAtLimit = stateHead + 'x'.repeat(STATE_BYTES - Buffer.byteLength(stateHead) - 1) + '\n';
  f.put(statePath, stateAtLimit);
  let data = await f.collector.collect(true, f.board, NOW + 1);
  assert.equal(data.ladder.current, 'M4');
  assert.doesNotMatch(plain(f.render(80, 'en', 'progress', 56, data)).join('\n'), /Truncated:/);

  f.put(statePath, stateAtLimit + '## Slices\n- todo · M4 · SYNTHETIC-TAIL · Beyond the cap\n');
  data = await f.collector.collect(true, f.board, NOW + 2);
  assert.deepEqual(data.ledger.map(r => r.id), f.data.ledger.map(r => r.id));
  assert.match(plain(f.render(80, 'en', 'progress', 56, data)).join('\n'), /Truncated: STATE\.md *\n/);
  assert.match(plain(f.render(80, 'zh', undefined, 56, data)).join('\n'), /已截断：STATE\.md/);

  f.put(statePath, stateAtLimit);
  f.put(specPath, 'x'.repeat(STATE_BYTES) + '\n## 5. Milestones\n- **M4, beyond the cap**\n');
  data = await f.collector.collect(true, f.board, NOW + 3);
  assert.deepEqual(data.ladder.ids, []);
  assert.match(plain(f.render(80, 'en', undefined, 56, data)).join('\n'), /Truncated: spec\.md/);
  assert.match(plain(f.render(80, 'zh', 'docs', 56, data)).join('\n'), /已截断：spec\.md/);
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
