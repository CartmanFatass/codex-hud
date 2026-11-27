import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listenDock } from '../fakes/herdr-dock.mjs';
import { createCollectionScheduler } from '../../dist/panel/scheduler.js';

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

test('hud panel toggles collapse/expand, close stops, and status reports shown/hidden/closed', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(f.settings, JSON.stringify({ treeWidth: 80, dockHeight: 14, dockMode: 'push', dockSide: 'left' }));
  const flags = ['--harness', 'claude', '--session', 'synthetic-session', '--source', f.cwd];
  assert.equal((await f.run(['status'])).stdout, 'HUD panel closed\n');
  assert.equal((await f.run(flags)).stdout, 'HUD panel opened\n');
  assert.equal((await f.run(['status'])).stdout, 'HUD panel shown\n');
  const { method, params } = f.fake.operations()[1];
  assert.equal(method, 'dock.toggle');
  assert.deepEqual(params, {
    executable: process.execPath, argv: [resolve('bin/hud'), 'panel', '--here', ...flags], cwd: f.cwd,
    env: { HUD_HOME: f.env.HUD_HOME, HUD_SETTINGS_PATH: f.settings, HUD_DOCK_CALLER_PANE: 'w4E:p1' },
    mode: 'push', side: 'left', width: 80, height: 14,
  });
  // Second bare toggle collapses without stopping the dock.
  assert.equal((await f.run(['--width', '40', '--root', 'synthetic/session'])).stdout, 'HUD panel hidden\n');
  assert.equal(f.fake.operations().at(-1).params.width, 40);
  assert.equal((await f.run(['status'])).stdout, 'HUD panel hidden\n');
  // `open` (and bar/band [Open]) expands a collapsed dock without toggling it closed.
  assert.equal((await f.run(['open', '--root', 'synthetic/session'])).stdout, 'HUD panel shown\n');
  assert.equal((await f.run(['open', '--root', 'synthetic/session'])).stdout, 'HUD panel shown\n');
  // `hide` collapses; `toggle` expands again.
  assert.equal((await f.run(['hide'])).stdout, 'HUD panel hidden\n');
  assert.equal((await f.run(['toggle', '--root', 'synthetic/session'])).stdout, 'HUD panel shown\n');
  // `close` stops the dock process.
  assert.equal((await f.run(['close'])).stdout, 'HUD panel closed\n');
  assert.equal((await f.run(['status'])).stdout, 'HUD panel closed\n');
  assert.deepEqual(f.fake.operations().map(({ method }) => method), [
    'dock.status', 'dock.toggle', 'dock.status', 'dock.toggle', 'dock.status',
    'dock.open', 'dock.open', 'dock.hide', 'dock.toggle', 'dock.close', 'dock.status',
  ]);
});

test('hud panel defaults to overlay/right/56/12 even with a legacy zero or broken settings file', async (t) => {
  const f = await fixture(t);
  for (const bytes of ['{"treeWidth":0,"dockMode":"unknown","dockSide":"top","dockHeight":0}', '{ invalid']) {
    fs.writeFileSync(f.settings, bytes);
    await f.run(['open', '--root', 'synthetic/session']);
    const { params } = f.fake.operations().at(-1);
    assert.equal(params.mode, 'overlay');
    assert.equal(params.side, 'right');
    assert.equal(params.width, 56);
    assert.equal(params.height, 12);
  }
});

test('Claude/Codex /hud skill and command prompt invoke hud panel toggle, hide and close', () => {
  const skill = fs.readFileSync(resolve('integrations/skills/hud/SKILL.md'), 'utf8');
  assert.match(skill, /`hud panel`/);
  assert.match(skill, /`hud panel open`/);
  assert.match(skill, /`hud panel hide`/);
  assert.match(skill, /`hud panel close`/);
  assert.match(skill, /`hud panel status`/);
  const claudeInstall = fs.readFileSync(resolve('install.d/claude.sh'), 'utf8');
  assert.match(claudeInstall, /hud_claude_command_line=.*hud panel.*open.*hide.*close.*status/);
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

test('collection scheduler stops periodic work while dock is collapsed and refreshes once on show', async (t) => {
  let hidden = false;
  let closed = false;
  let collects = 0;
  let repaints = 0;
  let shows = 0;
  const scheduler = createCollectionScheduler(50, {
    isClosed: () => closed,
    isHidden: async () => hidden,
    onShow: () => { shows++; },
    pollReload: async () => false,
    restart: async () => {},
    collectStep: async () => { collects++; },
    observation: () => ({ scopeKey: 'test', nowMs: Date.now(), activity: 'active', complete: true, succeeded: true }),
    repaint: () => { repaints++; },
    repaintDelay: () => 50,
    isWorkingTreeOpen: () => false,
    worktreeSources: () => [],
    onWorktrees: () => {},
    onWorktreeError: () => {},
  });
  t.after(() => {
    closed = true;
    scheduler.stop();
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  scheduler.start(50);
  await sleep(140);
  assert.ok(collects >= 2, `expected periodic collection while shown, got ${collects}`);
  // Collapse the dock: periodic collection and repaints must stop.
  hidden = true;
  await sleep(90);
  const pausedCollects = collects;
  const pausedRepaints = repaints;
  assert.equal(scheduler.isPaused(), true, 'scheduler entered collapsed state');
  await sleep(260);
  assert.equal(collects, pausedCollects, 'no periodic collection while collapsed');
  assert.equal(repaints, pausedRepaints, 'no periodic repaint while collapsed');
  // Show again: refreshes once promptly and resumes collection.
  hidden = false;
  await sleep(120);
  assert.equal(scheduler.isPaused(), false, 'scheduler resumed on show');
  assert.equal(shows, 1);
  assert.ok(collects >= pausedCollects + 1, `expected refresh on show, got ${collects} vs ${pausedCollects}`);
});
