import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bandReader } from '../../dist/cli/watch-band.js';
import { watchCommand } from '../../dist/cli/watch.js';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { renderMonitor } from '../../dist/render/monitor.js';
import { NOW, TREE, onPage, plain } from '../fixtures/project-page.mjs';

const STATE = (...items) => `# State\n\nMilestone: M1\n\n## Waiting for the owner\n\n${items.map((item) => `- ${item}\n`).join('')}\n## Next\n\n- Later\n`;

/** A synthetic project: STATE waiting items and export tickets (01 resolved, 02 and 03 to try, 04 open). */
function fixture(t, lang = 'en_US.UTF-8') {
  const root = fs.mkdtempSync(join(tmpdir(), 'watch-band-')), cwd = join(root, 'project'), hud = join(root, 'hud'), home = join(root, 'home');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(home);
  const put = (path, text) => { fs.mkdirSync(join(path, '..'), { recursive: true }); fs.writeFileSync(path, text); };
  const state = (...items) => put(join(cwd, 'docs/handoff/STATE.md'), STATE(...items));
  const ticket = (n, status) => put(join(cwd, '.scratch/export/issues', `0${n}-sample.md`), `# 0${n}: Sample ${n}\n**Status:** ${status}\n**Blocked by:** none\n`);
  state('Decide the export format', 'Pick a vendor (waits on export/01)', 'Send a sample file (waits on export/04)');
  ['resolved', 'try', 'try', 'ready-for-agent'].forEach((status, i) => ticket(i + 1, status));
  const env = { HOME: home, HUD_HOME: hud, LANG: lang, HUD_SETTINGS_PATH: join(root, 'settings.json') };
  return { cwd, hud, home, env, state, ticket, read: bandReader(cwd, hud, env) };
}
const board = { revision: 'synthetic', workers: [], lanes: [], decisions: [], coverage: { incomplete: false, diagnostics: [], workspace: null } };

test('the band holds what the Project Inbox counts: waiting items without the settled ones, and Accept all', async (t) => {
  const f = fixture(t), band = await f.read(NOW);
  assert.deepEqual(band, { type: 'band', lang: 'en', waiting: 2, first: 'Decide the export format', accept: 2, fresh: false });

  const project = await new ProjectCollector(f.cwd, f.hud, f.env, f.home).collect('home', board, NOW);
  assert.deepEqual(project.waiting.map((item) => item.value), ['Decide the export format', 'Send a sample file (waits on export/04)']);
  const hub = plain(renderMonitor({ state: onPage(undefined), tree: TREE, workboard: board, project, width: 60, height: 40, nowMs: NOW })).join('\n');
  assert.match(hub, new RegExp(`^Needs you ─+ ${band.waiting}$`, 'm'));
  assert.match(hub, new RegExp(`^Accept all +${band.accept} to try$`, 'm'));
});

test('the band is read again only when it changes, and announces only what is new', async (t) => {
  const f = fixture(t), at = { waiting: 2, accept: 2 };
  assert.deepEqual(await f.read(NOW), { type: 'band', lang: 'en', first: 'Decide the export format', fresh: false, ...at });
  assert.equal(await f.read(NOW), undefined);

  f.state('Decide the export format', 'Choose a locale', 'Send a sample file (waits on export/04)');
  assert.deepEqual(await f.read(NOW), { type: 'band', lang: 'en', first: 'Decide the export format', fresh: true, waiting: 3, accept: 2 });

  f.state('Choose a locale'); // Two items were handled and none added: nothing new to announce.
  assert.deepEqual(await f.read(NOW), { type: 'band', lang: 'en', first: 'Choose a locale', fresh: false, waiting: 1, accept: 2 });

  f.ticket(4, 'try');
  assert.deepEqual(await f.read(NOW), { type: 'band', lang: 'en', first: 'Choose a locale', fresh: true, waiting: 1, accept: 3 });

  f.state();
  ['resolved', 'resolved', 'resolved', 'resolved'].forEach((status, i) => f.ticket(i + 1, status));
  assert.deepEqual(await f.read(NOW), { type: 'band', lang: 'en', first: '', fresh: false, waiting: 0, accept: 0 });
});

test('the band carries the panel language, and a folder without STATE or tickets has an empty band', async (t) => {
  const f = fixture(t, 'zh_CN.UTF-8');
  assert.equal((await f.read(NOW)).lang, 'zh');
  fs.writeFileSync(join(f.cwd, '..', 'settings.json'), '{"language":"en"}');
  assert.equal((await f.read(NOW)).lang, 'en');
  const empty = bandReader(join(f.cwd, 'missing'), f.hud, f.env);
  assert.deepEqual(await empty(NOW), { type: 'band', lang: 'en', waiting: 0, first: '', accept: 0, fresh: false });
});

test('hud watch --mod sends the band after ready, again only when it changes, and not without the mod handshake', async (t) => {
  const f = fixture(t), run = (env) => {
    const records = [], ac = new AbortController();
    const done = watchCommand(['--mod'], { env: { ...f.env, HERDR_PANE_ID: 'w4E:p1', ...env }, stdout: (s) => records.push(JSON.parse(s)), stderr: (s) => assert.fail(s) },
      { signal: ac.signal, rescanMs: 50, settlementWindowMs: 40 });
    return { records, stop: () => { ac.abort(); return done; } };
  };
  const cwd = process.cwd();
  process.chdir(f.cwd);
  t.after(() => process.chdir(cwd));
  const until = async (check) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25)); assert.ok(check(), 'timed out'); };

  const legacy = run({});
  await new Promise((r) => setTimeout(r, 300));
  await legacy.stop();
  assert.deepEqual(legacy.records, []);

  const mod = run({ HUD_MOD_CURSOR: '' });
  await until(() => mod.records.length >= 2);
  assert.deepEqual(mod.records, [{ type: 'ready' }, { type: 'band', lang: 'en', waiting: 2, first: 'Decide the export format', accept: 2, fresh: false }]);
  f.state('Decide the export format', 'Choose a locale');
  await until(() => mod.records.length >= 3);
  await new Promise((r) => setTimeout(r, 200));
  await mod.stop();
  assert.deepEqual(mod.records.slice(2), [{ type: 'band', lang: 'en', waiting: 2, first: 'Decide the export format', accept: 2, fresh: true }]);
});
