import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fixture, publishPiGrace, rpcClient, taskCall, taskJob, taskRpc, until } from '../helpers/thin-mcp-harness.mjs';
import { reapFixtureProcesses, stopChild, trackFixture } from '../helpers/process-cleanup.mjs';

test('a rebuild drains overlapping calls and a broken candidate leaves the old server connected', { timeout: 10000 }, async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-reload-drain-'));
  const untrack = trackFixture({ root });
  const bin = join(root, 'packages/hud-mcp/bin'), dist = join(root, 'dist');
  fs.mkdirSync(join(dist, 'mcp'), { recursive: true });
  fs.cpSync(resolve('packages/hud-mcp/bin'), bin, { recursive: true });
  fs.cpSync(resolve('scripts/dist-lock.mjs'), join(root, 'scripts/dist-lock.mjs'));
  fs.writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const publish = (version) => {
    fs.writeFileSync(join(dist, 'mcp/thin-main.js'), version === 'broken' ? 'syntax error' : `
      import fs from 'node:fs'; import {setTimeout as delay} from 'node:timers/promises';
      export function openRuntime() { let calls = 0;
        return {start(n = 0) { calls = n; }, snapshot() { return calls; }, stop() {}, async request(line) {
          const {id, method} = JSON.parse(line);
          if (method === 'hold') { fs.writeFileSync('entered', ''); while (!fs.existsSync('release')) await delay(5); }
          return {jsonrpc:'2.0', id, result: [${JSON.stringify(version)}, ++calls]};
        }};
      }`);
    fs.writeFileSync(join(dist, 'index.js'), version);
  };
  publish('old');
  const child = spawn(process.execPath, [join(bin, 'hud-mcp.mjs')], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', (data) => stderr += data);
  t.after(async () => {
    await stopChild(child, exit, { killMs: 500 });
    const survivors = await reapFixtureProcesses({ root });
    untrack();
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(survivors.length, 0);
  });
  const rpc = rpcClient(child), held = rpc('hold');
  await until(() => fs.existsSync(join(root, 'entered')));
  publish('new');
  const a = rpc('next'), b = rpc('next');
  fs.writeFileSync(join(root, 'release'), '');
  assert.deepEqual((await Promise.all([held, a, b])).map(r => r.result), [['old', 1], ['new', 2], ['new', 3]]);
  publish('broken');
  assert.deepEqual((await rpc('next')).result, ['new', 4]);
  assert.deepEqual((await rpc('next')).result, ['new', 5]);
  publish('fixed');
  assert.deepEqual((await rpc('next')).result, ['fixed', 6]);
  child.stdin.end();
  assert.deepEqual(await exit, [0, null]);
  assert.equal(stderr.match(/keeping previous build/g)?.length, 1);
});

// Publish only in a private copy; other running clients (including other tests) must not reload.
test('one connection and watcher keep their work across two published generations', { timeout: 20000 }, async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-reload-'));
  for (const name of ['dist', 'packages/hud-mcp', 'scripts/dist-lock.mjs', 'package.json'])
    fs.cpSync(resolve(name), join(root, name), { recursive: true });
  fs.symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
  const bin = join(root, 'packages/hud-mcp/bin');
  const fastTick = `if (process.argv[1]?.endsWith('/hud-watch.mjs')) {
    const interval = globalThis.setInterval; globalThis.setInterval = (fn, ms) => interval(fn, ms === 30000 ? 100 : ms);
  }`;
  const f = await fixture(t, { mcpEntry: join(bin, 'hud-mcp.mjs'),
    probe: `process.env.NODE_OPTIONS += ' --import=' + ${JSON.stringify('data:text/javascript,' + encodeURIComponent(fastTick))};` });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const task = await taskCall(rpc, 'hud_create', { role: 'imp', task: 'Synthetic reload test.' });
  const job = taskJob(f, task), marker = join(job.task_dir, 'mcp-task.json');
  const owner = fs.readFileSync(marker, 'utf8');
  const pidFile = join(f.env.HUD_HOME, 'watch.pid');
  await until(() => fs.existsSync(pidFile));
  const watcher = fs.readFileSync(pidFile, 'utf8');
  const statusline = async () => (await taskCall(rpc, 'hud_statusline')).content[0].text;
  const get = () => rpc('tasks/get', { taskId: task.taskId });
  assert.match(await statusline(), /codex-statusline$/);
  const dep = join(root, 'dist/mcp/codex-statusline.js'), original = fs.readFileSync(dep, 'utf8');
  const publish = (n) => {
    fs.writeFileSync(dep, original.replace('ui://myhud/codex-statusline', `ui://myhud/build-${n}`));
    fs.appendFileSync(join(root, 'dist/runtime/watch-runtime.js'), `\nfs.writeFileSync(join(home, 'watch-build'), '${n}');\n`);
    const now = new Date(); fs.utimesSync(join(root, 'dist/index.js'), now, now);
  };
  async function checkBuild(n) {
    // Same client, no new discover/initialize, and a transitive import actually changed.
    assert.match(await statusline(), new RegExp(`build-${n}$`));
    await until(() => fs.existsSync(join(f.env.HUD_HOME, 'watch-build')) &&
      fs.readFileSync(join(f.env.HUD_HOME, 'watch-build'), 'utf8') === String(n) &&
      (fs.readFileSync(join(f.env.HUD_HOME, 'watch.log'), 'utf8').match(/reloaded pid=/g) ?? []).length === n);
    assert.equal(fs.readFileSync(pidFile, 'utf8'), watcher);
  }
  publish(1);
  await checkBuild(1);
  assert.equal((await get()).status, 'working');
  assert.equal(fs.readFileSync(marker, 'utf8'), owner);
  await publishPiGrace(job);
  const notice = await get();
  assert.equal(notice.status, 'completed');
  assert.equal(notice.result.content.length, 1);
  assert.equal(fs.existsSync(marker), false);
  publish(2);
  await checkBuild(2);
  assert.deepEqual(await get(), notice, 'repeat polls keep the original terminal result and timestamp');
});

function reloadCopy(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-reload-tools-'));
  for (const name of ['dist', 'packages/hud-mcp', 'scripts/dist-lock.mjs', 'package.json'])
    fs.cpSync(resolve(name), join(root, name), { recursive: true });
  fs.symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let step = 0;
  const stamp = () => {
    const tmp = join(root, `dist/index.js.${++step}.tmp`);
    fs.writeFileSync(tmp, fs.readFileSync(join(root, 'dist/index.js')));
    fs.renameSync(tmp, join(root, 'dist/index.js'));
  };
  return { root, mcpEntry: join(root, 'packages/hud-mcp/bin/hud-mcp.mjs'), stamp };
}

test('reload advertises tools.listChanged and notifies once only when tools/list changes', { timeout: 15000 }, async (t) => {
  const copy = reloadCopy(t);
  const f = await fixture(t, { mcpEntry: copy.mcpEntry });
  const init = await f.rpc('initialize', { protocolVersion: '2024-11-05' });
  assert.deepEqual(init.result.capabilities.tools, { listChanged: true });
  const initial = (await f.rpc('tools/list')).result.tools;
  assert.equal(f.notifications.length, 0);

  // Unchanged tools/list across a reload: no notification.
  const thinMain = join(copy.root, 'dist/mcp/thin-main.js');
  fs.appendFileSync(thinMain, '\n// synthetic unchanged-tools reload\n');
  copy.stamp();
  assert.deepEqual((await f.rpc('ping')).result, {});
  assert.deepEqual((await f.rpc('tools/list')).result.tools, initial);
  assert.equal(f.notifications.length, 0);

  // Schema change in tool-definitions: notify once and serve the updated schema.
  const defs = join(copy.root, 'dist/roles/tool-definitions.js');
  const originalDefs = fs.readFileSync(defs, 'utf8');
  const changed = originalDefs.replace(
    "package: { ...text, description: 'Display label.' },",
    "package: { ...text, description: 'Display label.' }, synthetic_flag: { ...bool, description: 'Synthetic test flag.' },"
  );
  assert.notEqual(changed, originalDefs);
  fs.writeFileSync(defs, changed);
  copy.stamp();
  assert.deepEqual((await f.rpc('ping')).result, {});
  assert.deepEqual(f.notifications, [{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }]);
  const refreshed = (await f.rpc('tools/list')).result.tools;
  assert.deepEqual(refreshed.find((tool) => tool.name === 'hud_create').inputSchema.properties.synthetic_flag, {
    type: 'boolean',
    description: 'Synthetic test flag.',
  });
  assert.equal(f.notifications.length, 1);

  // Subsequent unchanged reload still sends no extra notification.
  copy.stamp();
  assert.deepEqual((await f.rpc('ping')).result, {});
  assert.equal(f.notifications.length, 1);
});

test('task client reload notifies only when its filtered tools/list payload changes', { timeout: 15000 }, async (t) => {
  const copy = reloadCopy(t);
  const f = await fixture(t, { mcpEntry: copy.mcpEntry });
  const rpc = taskRpc(f.rpc);
  const discovered = await rpc('server/discover');
  assert.deepEqual(discovered.capabilities.tools, { listChanged: true });
  const initial = await rpc('tools/list');
  assert.equal(initial.tools.some((tool) => tool.name === 'hud_wait'), false);
  assert.equal(f.notifications.length, 0);

  // Editing only hud_wait does not change a task client's tools/list payload.
  const defs = join(copy.root, 'dist/roles/tool-definitions.js');
  const originalDefs = fs.readFileSync(defs, 'utf8');
  const waitOnly = originalDefs.replace(
    'Wait for settlement or attention without reading reports.',
    'Wait for synthetic settlement or attention without reading reports.'
  );
  assert.notEqual(waitOnly, originalDefs);
  fs.writeFileSync(defs, waitOnly);
  copy.stamp();
  await rpc('ping');
  assert.equal(f.notifications.length, 0);

  // Editing a visible tool emits notifications/tools/list_changed once.
  const visible = waitOnly.replace('Display label.', 'Synthetic updated display label.');
  assert.notEqual(visible, waitOnly);
  fs.writeFileSync(defs, visible);
  copy.stamp();
  await rpc('ping');
  assert.deepEqual(f.notifications, [{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }]);
  const updated = await rpc('tools/list');
  const create = updated.tools.find((tool) => tool.name === 'hud_create');
  assert.equal(create.inputSchema.properties.package.description, 'Synthetic updated display label.');
  assert.deepEqual(create.execution, { taskSupport: 'optional' });
  assert.equal(f.notifications.length, 1);
});
