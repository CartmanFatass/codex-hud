import { withState, sliceState } from '../fixtures/state-helpers.mjs';
import { projectPageOf } from '../../dist/render/project-view.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homeFixture } from '../fixtures/home-progress.mjs';
import { NOW, TREE, plain } from '../fixtures/project-page.mjs';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { targetKey } from '../../dist/collectors/workboard-types.js';
import { handleMonitorInput } from '../../dist/render/monitor.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
async function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'home-progress-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, ...await homeFixture(root) };
}

test('Home joins cached STATE, spec, tickets, HEAD and jobs; no control or agents; only changed bodies refresh', async (t) => {
  const f = await fixture(t), opened = [], listed = [], spawned = [];
  const original = { openSync: fs.openSync, opendirSync: fs.opendirSync, execFile: childProcess.execFile };
  fs.openSync = (path, ...args) => { opened.push(String(path)); return original.openSync(path, ...args); };
  fs.opendirSync = (path, ...args) => { listed.push(String(path)); return original.opendirSync(path, ...args); };
  childProcess.execFile = (...args) => { spawned.push(args[0]); return original.execFile(...args); };
  syncBuiltinESMExports();
  t.after(() => { fs.openSync = original.openSync; fs.opendirSync = original.opendirSync; childProcess.execFile = original.execFile; syncBuiltinESMExports(); });
  const collector = new ProjectCollector(f.cwd, f.hud, f.env, f.home);
  let data = await collector.collect('home', f.board, NOW);
  assert.ok(opened.length > 0);
  assert.ok(opened.every((p) => /\/(STATE|spec)\.md$|\/\.git\/|\/jobs\/j[0-9a-f]+\/(job\.json|STATUS\.json|brief\.md)$|\/\.scratch\/[^/]+\/issues\/[^/]+\.md$/.test(p)), opened.join('\n'));
  assert.ok(listed.every((p) => /\/(\.scratch|jobs|worktrees)$|\/\.scratch\/[^/]+\/issues$/.test(p)));
  assert.deepEqual(spawned, ['git']);
  assert.equal(data.git, undefined);
  assert.deepEqual(data.control, []);
  assert.deepEqual(data.agents, []);
  assert.equal(data.tickets[0].tickets[0].state, 'working');
  opened.length = 0; listed.length = 0;
  await collector.collect('home', f.board, NOW + 60000);
  assert.deepEqual(opened, [], 'unchanged files cost no body reread');
  assert.deepEqual(listed, [], 'unchanged directory membership reused');
  f.issue('native-tree', '02', 'home-lanes', 'Home lanes', 'done');
  opened.length = 0;
  data = await collector.collect('home', f.board, NOW + 60001);
  assert.equal(data.tickets[0].tickets[0].state, 'done');
  assert.deepEqual(opened, [f.paths.working]);
  assert.deepEqual(spawned, ['git'], 'no git call without a HEAD change, even past the Project gate');
  assert.equal(await collector.collect(false, f.board, NOW + 60002), undefined);
});
test('live panel stays Home-only: only the HEAD-keyed subject scan invokes git', async (t) => {
  const f = await fixture(t), runner = join(f.root, 'home-only.mjs'), log = join(f.root, 'git-spawns');
  f.put(join(f.root, 'bin/git'), `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(log)}, 'git\\n'); process.exit(1);\n`);
  fs.chmodSync(join(f.root, 'bin/git'), 0o700);
  f.put(runner, `
import { ProjectCollector } from ${JSON.stringify(pathToFileURL(resolve('dist/collectors/project-board.js')).href)};
import { runLivePage } from ${JSON.stringify(pathToFileURL(resolve('dist/tree-page.js')).href)};
const collect = ProjectCollector.prototype.collect;
let calls = 0;
ProjectCollector.prototype.collect = async function(mode, ...args) {
  if (mode !== 'home') throw Error('unexpected collection mode: ' + mode);
  const result = await collect.call(this, mode, ...args);
  if (++calls === 2) { process.stdout.write('HOME_ONLY'); process.exit(0); }
  return result;
};
await runLivePage();
`);
  const settings = join(f.root, 'settings.json');
  f.put(settings, { modelEnabled: false, refreshMs: 100 });
  const child = childProcess.spawn(process.execPath, [runner], { env: { ...process.env, ...f.env,
    PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, CODEX_HUD_CWD: f.cwd, HUD_SETTINGS_PATH: settings,
    CODEX_HUD_STANDALONE_PANEL: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (b) => { stdout += b; });
  child.stderr.on('data', (b) => { stderr += b; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill('SIGKILL'); });
  const code = await new Promise((done) => child.once('exit', done));
  clearTimeout(timeout);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /HOME_ONLY/);
  assert.equal(fs.readFileSync(log, 'utf8'), 'git\n', 'one cold subject scan for two collections');
});
