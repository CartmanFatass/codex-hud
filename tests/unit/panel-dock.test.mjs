import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listenDock } from '../fakes/herdr-dock.mjs';

async function fixture(t, capable) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-panel-dock-'));
  const cwd = join(dir, "workspace with 'quotes'");
  const home = join(dir, 'hud'), settings = join(home, 'synthetic-settings.json');
  fs.mkdirSync(cwd);
  fs.mkdirSync(home);
  const env = { HOME: dir, HUD_HOME: home, PATH: process.env.PATH, HUD_SETTINGS_PATH: settings,
    HERDR_SOCKET_PATH: join(dir, 'dock.sock'), HERDR_PANE_ID: 'w4E:p1', SYNTHETIC_PRIVATE: 'not forwarded' };
  const fake = await listenDock(t, env.HERDR_SOCKET_PATH, { capable });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (args, extra = {}) => promisify(execFile)(process.execPath, [resolve('bin/hud'), 'panel', ...args],
    { cwd, env: { ...env, ...extra }, timeout: 10000 });
  return { cwd, env, settings, fake, run };
}

test('hud panel toggles one server dock, launches direct argv, and reports the reply', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(f.settings, JSON.stringify({ treeWidth: 80, dockMode: 'push' }));
  const flags = ['--harness', 'claude', '--session', 'synthetic-session', '--source', f.cwd];
  assert.equal((await f.run(flags)).stdout, 'HUD panel opened\n');
  assert.equal((await f.run(['status'])).stdout, 'HUD panel open\n');
  const { method, params } = f.fake.operations()[0];
  assert.equal(method, 'dock.toggle');
  assert.deepEqual(params, {
    executable: process.execPath, argv: [resolve('bin/hud'), 'panel', '--here', ...flags], cwd: f.cwd,
    env: { HUD_HOME: f.env.HUD_HOME, HUD_SETTINGS_PATH: f.settings, HUD_DOCK_CALLER_PANE: 'w4E:p1' },
    mode: 'push', width: 80,
  });
  assert.equal((await f.run(['open', '--root', 'synthetic/session'])).stdout, 'HUD panel open\n');
  assert.equal((await f.run(['--width', '40', '--root', 'synthetic/session'])).stdout, 'HUD panel closed\n');
  assert.equal(f.fake.operations().at(-1).params.width, 40);
  assert.equal((await f.run(['close'])).stdout, 'HUD panel closed\n');
  assert.deepEqual(f.fake.operations().map(({ method }) => method), ['dock.toggle', 'dock.status', 'dock.open', 'dock.toggle', 'dock.close']);
});

test('hud panel defaults to overlay/56 even with a legacy zero or broken settings file', async (t) => {
  const f = await fixture(t);
  for (const bytes of ['{"treeWidth":0,"dockMode":"unknown"}', '{ invalid']) {
    fs.writeFileSync(f.settings, bytes);
    await f.run(['open', '--root', 'synthetic/session']);
    const { params } = f.fake.operations().at(-1);
    assert.equal(params.mode, 'overlay');
    assert.equal(params.width, 56);
  }
});

test('a worker cannot control or run the panel, even with --here or an empty job marker', async (t) => {
  const f = await fixture(t);
  for (const args of [[], ['--here'], ['status']])
    await assert.rejects(f.run(args, { HUD_JOB_DIR: '' }), { code: 2, stderr: 'panel_worker_forbidden\n' });
  assert.deepEqual(f.fake.calls, []);
});

test('a herdr without the dock capability refuses without trying a split or foreground', async (t) => {
  const f = await fixture(t, false);
  await assert.rejects(f.run(['--root', 'synthetic/session']), { code: 1, stderr: 'panel_dock_unavailable\n' });
  assert.deepEqual(f.fake.calls, [{ method: 'ping', params: {} }]);
});
