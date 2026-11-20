import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { projectFixture, onControl, onPage, plain, richControl, NOW, TREE, PROJECTS } from '../fixtures/project-page.mjs';
import { handleMonitorInput } from '../../dist/render/monitor.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { readPanelPlace } from '../../dist/utils/panel-reload.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';

async function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'control-tab-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, ...await projectFixture(root) };
}
const send = (frame, key) => handleMonitorInput(frame.state, typeof key === 'string' ? { type: 'key', key } : key, { tree: TREE, frame, nowMs: NOW });
const tabClick = (frame, id) => {
  const tab = frame.controls.find((c) => c.kind === `board-${id}`);
  assert.ok(tab?.width > 0, id);
  return { type: 'mouse', button: 'left', x: tab.x + tab.width - 1, y: tab.y };
};

test('Control is the third whole tab at 40 columns, with arrows, Tab, click and separate navigation', async (t) => {
  const f = await fixture(t), data = richControl(f.data);
  for (const lang of ['en', 'zh']) for (const experiments of [false, true]) for (const panelLayout of ['classic', 'split']) {
    const draw = (state) => f.render(40, lang, state, 36, data, true, 'unicode', 'none', { projects: PROJECTS });
    let frame = draw(onPage(undefined, { experiments, panelLayout, projectCursor: 'project:page:docs', projectRoot: PROJECTS[1].root }));
    const keys = ['home', 'project', 'control', ...(experiments ? ['exp'] : [])];
    assert.deepEqual(frame.controls.filter((c) => c.kind.startsWith('board-')).map((c) => c.kind), keys.map((key) => `board-${key}`));
    frame = draw(send(frame, 'tab').state);
    assert.equal(frame.state.mainTab, 'control');
    assert.equal(frame.state.projectRoot, PROJECTS[1].root);
    assert.match(plain(frame)[0], lang === 'zh' ? /首页.*项目.*控制/ : /Home.*Project.*Control/);
    if (experiments) assert.match(plain(frame)[0], /EXP/);
    const decoder = new WorkbenchInputDecoder('workboard');
    for (const input of decoder.push(Buffer.from('1234567890'))) assert.equal(send(frame, input).state.mainTab, 'control');
    assert.equal(send(frame, 'filter').state.filterOpen, undefined, 'the Home filter is not a Control view');
    assert.deepEqual(send(frame, 'export-board').action, { type: 'export-board' });
    assert.ok(frame.lines.every((line) => visualLength(line) === 40));
    assert.equal(send(frame, 'right').state.mainTab, experiments ? 'exp' : 'home');
    assert.equal(send(frame, 'shift-tab').state.mainTab, 'project');
    const ctrl = draw(send(frame, 'end').state);
    const project = draw(send(ctrl, 'left').state);
    assert.equal(project.state.projectCursor, 'project:page:docs');
    const again = draw(send(project, tabClick(project, 'control')).state);
    assert.deepEqual(again.state.controlNav, ctrl.state.controlNav);
  }
});

test('Project hubs have no Control row; Inbox alert links to its role on the same root in both layouts', async (t) => {
  const f = await fixture(t), data = { ...richControl(f.data), ledger: [], waiting: [], tickets: [], slices: [] };
  const root = PROJECTS[1].root;
  for (const panelLayout of ['classic', 'split']) for (const projectLayout of ['timeline', 'board', 'inbox']) {
    const draw = (state, projectDisplayRoot = root) => f.render(40, 'en', state, 36, data, true, 'unicode', 'none', { projects: PROJECTS, projectDisplayRoot });
    const state = onPage(undefined, { panelLayout, projectLayout, projectRoot: root, projectCursor: 'inbox:role:pro' });
    const frame = draw(state);
    assert.ok(!frame.workboard.rows.some((r) => r.item === 'project:page:control'));
    if (projectLayout !== 'inbox') continue;
    assert.deepEqual(send(frame, 'open-session').action, { type: 'open-files', files: ['/synthetic/default/roles/pro.json'] });
    const next = send(frame, 'enter');
    assert.equal(next.action, undefined);
    assert.equal(next.state.mainTab, 'control');
    assert.equal(next.state.projectRoot, root);
    assert.equal(draw(next.state).state.controlNav.projectCursor, 'project:role:pro');
    assert.equal(send(draw(state, PROJECTS[0].root), 'enter').state.mainTab, 'project', 'no stale-root alert opens on the new root');
  }
});

test('legacy Project/control continuation reopens the selected role place on Control, in Classic and Split', async (t) => {
  const f = await fixture(t), data = richControl(f.data);
  for (const panelLayout of ['classic', 'split']) {
    const projectCursor = 'project:role:reviewer:0';
    process.env.HUD_PANEL_RELOAD_PLACE = JSON.stringify({ state: onPage('control', { panelLayout, projectRoot: PROJECTS[1].root, projectCursor }) },
      (_k, value) => value instanceof Set ? { panelSet: [...value] } : value);
    const place = readPanelPlace();
    assert.equal(place.state.mainTab, 'control');
    assert.equal(place.state.projectPage, undefined);
    assert.equal(place.state.projectRoot, PROJECTS[1].root);
    assert.equal(f.render(40, 'en', place.state, 36, data).state.controlNav.projectCursor, projectCursor);
  }
});

test('live panel: no discovery on Home or Project, Control reads only the displayed root, r refreshes', async (t) => {
  const f = await fixture(t), other = join(f.root, 'other-project'), own = f.cwd;
  const gate = join(f.root, 'released'), collects = join(f.root, 'collects'), probes = join(f.root, 'probes');
  f.put(join(f.hud, 'projects.json'), { version: 1, projects: [{ root: own }, { root: other }] });
  for (const [root, role] of [[own, 'own-role'], [other, 'other-role']]) {
    f.put(join(root, '.hud/project.json'), { version: 1, roles: [role] });
    f.put(join(root, `.hud/roles/${role}.json`), { role, harness: 'pi', pi_role: 'implementer', model: 'demo/model' });
  }
  f.put(join(other, 'STATE.md'), '# Other\n\n## Waiting for the owner\n\n- Only other root waits');
  f.put(join(f.hud, 'hud-settings.json'), { modelEnabled: false, refreshMs: 250, language: 'en', theme: 'none' });
  fs.writeFileSync(join(f.root, 'bin/pi'), `#!/bin/sh\nprintf 'pi\n' >> '${probes}'\nprintf 'provider model\ndemo model\n'\n`, { mode: 0o700 });
  // Hold back the new root's first Control read so we can examine the intervening frame.
  const runner = join(f.root, 'live.mjs');
  fs.writeFileSync(runner, `
    import fs from 'node:fs';
    import { ProjectCollector } from ${JSON.stringify(new URL('../../dist/collectors/project-board.js', import.meta.url).href)};
    import { runLivePage } from ${JSON.stringify(new URL('../../dist/tree-page.js', import.meta.url).href)};
    Object.defineProperties(process.stdout, { columns: { value: 40 }, rows: { value: 38 } });
    const collect = ProjectCollector.prototype.collect;
    ProjectCollector.prototype.collect = async function(mode, ...args) {
      if (mode === 'control' && this.cwd === ${JSON.stringify(other)}) {
        while (!fs.existsSync(${JSON.stringify(gate)})) await new Promise(r => setTimeout(r, 15));
      }
      const result = await collect.call(this, mode, ...args);
      if (mode) fs.appendFileSync(${JSON.stringify(collects)}, JSON.stringify([mode, this.cwd, !!result.git, result.tickets.length, result.waiting.length]) + '\\n');
      return result;
    };
    await runLivePage();
    process.exit(0);
  `);
  const child = spawn(process.execPath, [runner], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...f.env, CODEX_HUD_CWD: own, CODEX_HUD_STANDALONE_PANEL: '1' } });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', (b) => { stdout += b; });
  child.stderr.on('data', (b) => { stderr += b; });
  const calls = () => fs.existsSync(collects) ? fs.readFileSync(collects, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const count = () => fs.existsSync(probes) ? fs.readFileSync(probes, 'utf8').match(/pi/g)?.length ?? 0 : 0;
  const wait = async (predicate, what) => {
    for (const until = Date.now() + 10000; Date.now() < until && child.exitCode === null; await new Promise((r) => setTimeout(r, 20))) if (predicate()) return;
    assert.fail(`${what}: ${stderr}\n${stripAnsi(stdout).slice(-1500)}`);
  };
  await wait(() => calls().some(([mode]) => mode === 'home'), 'Home collected');
  child.stdin.write('r\t'); // Home r, then Project
  await wait(() => calls().some(([mode]) => mode === true), 'Project collected');
  child.stdin.write(']r'); // select the other project while on Project
  await wait(() => calls().some(([mode, root]) => mode === true && root === other), 'other Project collected');
  assert.equal(count(), 0);
  const before = stdout.length;
  child.stdin.write('\t'); // Control follows that Project root; the narrow read is held back
  await wait(() => /Loading/.test(stripAnsi(stdout.slice(before))) && count() === 1, 'Control loading (discovery started)');
  assert.doesNotMatch(stripAnsi(stdout.slice(before)), /own-role|other-role/);
  f.put(gate, 'go');
  await wait(() => /other-role/.test(stripAnsi(stdout.slice(before))), 'other role displayed');
  assert.deepEqual(calls().filter(([mode]) => mode === 'control').at(-1), ['control', other, false, 0, 0]);
  await wait(() => fs.existsSync(join(f.hud, 'display/model-lists.json')), 'first discovery finished');
  child.stdin.write('r');
  await wait(() => count() === 2, 'Control r refreshed discovery');
  const left = stdout.length;
  child.stdin.write('['); // Control can change the same choice without leaving
  await wait(() => /own-role/.test(stripAnsi(stdout.slice(left))), 'own role displayed');
  assert.deepEqual(calls().filter(([mode]) => mode === 'control').at(-1), ['control', own, false, 0, 0]);
  child.stdin.write(']');
  await wait(() => calls().filter(([mode]) => mode === 'control').at(-1)?.[1] === other, 'back on the other root');
  const n = calls().length;
  child.stdin.write('\t'); // wrap Control -> Home while Project still points to the other root
  await wait(() => calls().slice(n).some(([mode, root]) => mode === 'home' && root === own), 'Home still collects its own project');
  assert.equal(count(), 2);
  child.stdin.write('q');
  assert.deepEqual(await once(child, 'exit'), [0, null]);
});
