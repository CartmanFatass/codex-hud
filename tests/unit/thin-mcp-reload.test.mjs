import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { openGeneration } from '../../packages/hud-mcp/bin/generation.mjs';
import { fixture, legacyFixture, publishPiGrace, rpcClient, taskCall, taskJob, taskRpc, until } from '../helpers/thin-mcp-harness.mjs';
import { reapFixtureProcesses, stopChild, trackFixture } from '../helpers/process-cleanup.mjs';

const generation = (home, pid) => JSON.parse(fs.readFileSync(join(home, `generations/${pid}.json`), 'utf8'));
const buildStamp = (root) => {
  const { ino, ctimeNs } = fs.statSync(join(root, 'dist/index.js'), { bigint: true });
  return `${ino}:${ctimeNs}`;
};

test('a rebuild waits for idle without blocking overlapping calls and survives a broken candidate', { timeout: 10000 }, async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-reload-idle-'));
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
          if (method === 'hold') {
            fs.appendFileSync('entered', id + '\\n');
            while (!fs.existsSync('release')) await delay(5);
          }
          return {jsonrpc:'2.0', id, result: [${JSON.stringify(version)}, ++calls]};
        }};
      }`);
    fs.writeFileSync(join(dist, 'index.js'), version);
  };
  publish('old');
  const home = join(root, 'hud');
  fs.mkdirSync(home, { mode: 0o700 });
  const child = spawn(process.execPath, [join(bin, 'hud-mcp.mjs')], {
    cwd: root, env: { ...process.env, HUD_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
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
  const entered = join(root, 'entered');
  await until(() => fs.existsSync(entered), t.signal);
  const old = generation(home, child.pid);
  assert.equal(old.stamp, buildStamp(root));
  publish('new');
  const sent = performance.now();
  const replies = await Promise.race([
    Promise.all([
      rpc('tools/call', { name: 'hud_tickets', arguments: { op: 'guide' } }),
      rpc('tools/call', { name: 'hud_peek' }),
      rpc('ping'),
    ]),
    delay(50, undefined, { ref: false }).then(() => assert.fail('guide, peek and ping did not reply within 50 ms')),
  ]);
  const elapsed = performance.now() - sent;
  assert.ok(elapsed < 50, `guide, peek and ping took ${elapsed.toFixed(1)} ms`);
  assert.deepEqual(replies.map(r => r.result), [['old', 1], ['old', 2], ['old', 3]]);
  assert.deepEqual(generation(home, child.pid), old);

  fs.writeFileSync(join(root, 'release'), '');
  const heldReply = await held;
  assert.deepEqual(heldReply.result, ['old', 4]);
  const published = buildStamp(root);
  // The idle handoff must finish without another line prompting it.
  await until(() => generation(home, child.pid).stamp === published, t.signal);
  assert.deepEqual((await rpc('next')).result, ['new', 5]);
  const current = generation(home, child.pid);
  publish('broken');
  assert.deepEqual((await rpc('next')).result, ['new', 6]);
  assert.deepEqual((await rpc('next')).result, ['new', 7]);
  assert.deepEqual(generation(home, child.pid), current);
  publish('fixed');
  assert.deepEqual((await rpc('next')).result, ['fixed', 8]);
  assert.equal(generation(home, child.pid).stamp, buildStamp(root));
  child.stdin.end();
  assert.deepEqual(await exit, [0, null]);
  assert.equal(fs.readFileSync(entered, 'utf8'), `${heldReply.id}\n`, 'the held mutation ran exactly once');
  assert.equal(stderr.match(/keeping previous build/g)?.length, 1);
});

// Publish only in a private copy; other running clients (including other tests) must not reload.
test('one connection and watcher keep their work across two published generations', { timeout: 20000 }, async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-reload-'));
  for (const name of ['dist', 'packages/hud-mcp', 'integrations/pi/worker', 'scripts/dist-lock.mjs', 'package.json'])
    fs.cpSync(resolve(name), join(root, name), { recursive: true });
  fs.symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
  const bin = join(root, 'packages/hud-mcp/bin');
  // Keep the watcher alive after task settlement so the same PID can reload again.
  const f = await legacyFixture(t, { mcpEntry: join(bin, 'hud-mcp.mjs') });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const task = await taskCall(rpc, 'hud_create', { role: 'imp', task: 'Synthetic reload test.' });
  const job = taskJob(f, task), marker = join(job.task_dir, 'mcp-task.json');
  const owner = fs.readFileSync(marker, 'utf8');
  const pidFile = join(f.env.HUD_HOME, 'watch.pid');
  await until(() => fs.existsSync(pidFile), t.signal);
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
      (fs.readFileSync(join(f.env.HUD_HOME, 'watch.log'), 'utf8').match(/reloaded pid=/g) ?? []).length === n, t.signal);
    assert.equal(fs.readFileSync(pidFile, 'utf8'), watcher);
  }
  publish(1);
  await checkBuild(1);
  assert.equal((await get()).status, 'working');
  assert.equal(fs.readFileSync(marker, 'utf8'), owner);
  await publishPiGrace(t, job);
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
  for (const name of ['dist', 'packages/hud-mcp', 'integrations/pi/worker', 'scripts/dist-lock.mjs', 'package.json'])
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
    'Await settlement/attention; no report reads.',
    'Await synthetic settlement/attention; no report reads.'
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

function readProcPssMB(pid) {
  try {
    const match = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)\s+kB/m);
    return match ? Number(match[1]) / 1024 : null;
  } catch { return null; }
}

function readProcThreads(pid) {
  try {
    const match = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^Threads:\s+(\d+)/m);
    return match ? Number(match[1]) : null;
  } catch { return null; }
}

test('generation.mjs runs generation 0 off the main thread and terminates retired workers after draining', { timeout: 10000 }, async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-gen-retire-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mod = join(root, 'runtime.mjs');
  const gate = join(root, 'release');
  const entered = join(root, 'entered');
  fs.writeFileSync(mod, `
    import fs from 'node:fs';
    import { isMainThread, threadId } from 'node:worker_threads';
    import { setTimeout as delay } from 'node:timers/promises';
    export function openRuntime() {
      // A leaked ref'd interval would keep the worker alive forever without forced termination.
      setInterval(() => {}, 1000);
      return {
        info() { return { isMainThread, threadId }; },
        async slow() {
          fs.writeFileSync(${JSON.stringify(entered)}, '');
          while (!fs.existsSync(${JSON.stringify(gate)})) await delay(5);
          return 'drained';
        },
      };
    }
  `);
  const gen = await openGeneration(pathToFileURL(mod));
  const info = await gen.call('info');
  assert.equal(info.isMainThread, false);
  assert.ok(info.threadId > 0);
  const inFlight = gen.call('slow');
  await until(() => fs.existsSync(entered), t.signal);
  const retired = gen.retire();
  await assert.rejects(() => gen.call('info'), /retiring/);
  fs.writeFileSync(gate, '');
  assert.equal(await inFlight, 'drained');
  await retired;
});

test('hud-mcp answers across reloads and terminates retired worker threads holding ref handles', { timeout: 15000 }, async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-mcp-workers-'));
  const untrack = trackFixture({ root });
  const bin = join(root, 'packages/hud-mcp/bin'), dist = join(root, 'dist');
  fs.mkdirSync(join(dist, 'mcp'), { recursive: true });
  fs.cpSync(resolve('packages/hud-mcp/bin'), bin, { recursive: true });
  fs.cpSync(resolve('scripts/dist-lock.mjs'), join(root, 'scripts/dist-lock.mjs'));
  fs.writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const publish = (version) => {
    fs.writeFileSync(join(dist, 'mcp/thin-main.js'), `
      import { isMainThread, threadId } from 'node:worker_threads';
      export function openRuntime() {
        setInterval(() => {}, 1000); // Ref'd handle must not pin retired workers.
        return {
          start() {},
          snapshot() { return {}; },
          stop() {},
          request(line) {
            const { id } = JSON.parse(line);
            return { jsonrpc: '2.0', id, result: { version: ${JSON.stringify(version)}, isMainThread, threadId } };
          },
        };
      }
    `);
    fs.writeFileSync(join(dist, 'index.js'), String(version));
  };
  publish(0);
  const child = spawn(process.execPath, [join(bin, 'hud-mcp.mjs')], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  t.after(async () => {
    await stopChild(child, exit, { killMs: 500 });
    const survivors = await reapFixtureProcesses({ root });
    untrack();
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(survivors.length, 0);
  });
  const rpc = rpcClient(child);
  const first = (await rpc('ping')).result;
  assert.equal(first.version, 0);
  assert.equal(first.isMainThread, false);
  const baselineThreads = readProcThreads(child.pid);
  let lastThread = first.threadId;
  for (let i = 1; i <= 5; i++) {
    publish(i);
    const res = (await rpc('ping')).result;
    assert.equal(res.version, i);
    assert.equal(res.isMainThread, false);
    assert.notEqual(res.threadId, lastThread);
    lastThread = res.threadId;
  }
  if (baselineThreads !== null) {
    assert.ok(readProcThreads(child.pid) <= baselineThreads + 1,
      `retired workers did not exit: baseline=${baselineThreads}, after=${readProcThreads(child.pid)}`);
  }
  child.stdin.end();
  assert.deepEqual(await exit, [0, null]);
});

test('hud-watch survives a broken build and keeps PSS within 10 MB across 15 execve reloads', { timeout: 30000 }, async (t) => {
  const copy = reloadCopy(t);
  const hudHome = join(copy.root, 'hud');
  const jobDir = join(hudHome, 'jobs', 'j0000000000000001');
  fs.mkdirSync(hudHome, { mode: 0o700 });
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(join(jobDir, 'job.json'), JSON.stringify({ job: 'j0000000000000001', role: 'imp', dispatch_exit_code: 0 }));
  fs.writeFileSync(join(jobDir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
  const untrack = trackFixture({ root: copy.root, hudHome });
  const childEnv = { ...process.env, HUD_HOME: hudHome };
  delete childEnv.HUD_HEAP_CAPS;
  const child = spawn(process.execPath, [join(copy.root, 'packages/hud-mcp/bin/hud-watch.mjs')], {
    cwd: copy.root,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = once(child, 'exit');
  t.after(async () => {
    await stopChild(child, exit, { killMs: 500 });
    const survivors = await reapFixtureProcesses({ root: copy.root, hudHome });
    untrack();
    assert.equal(survivors.length, 0);
  });
  const pidFile = join(hudHome, 'watch.pid'), logFile = join(hudHome, 'watch.log');
  await until(() => fs.existsSync(pidFile) && fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('start pid='), t.signal);
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  const freshPss = readProcPssMB(pid), current = generation(hudHome, pid);
  assert.equal(current.stamp, buildStamp(copy.root));

  // Broken candidate keeps the previous watcher alive with the same PID.
  const runtimePath = join(copy.root, 'dist/runtime/watch-runtime.js');
  const originalRuntime = fs.readFileSync(runtimePath, 'utf8');
  fs.writeFileSync(runtimePath, 'export syntax error !');
  copy.stamp();
  await until(() => fs.readFileSync(logFile, 'utf8').includes('keeping previous build:'), t.signal);
  assert.equal(Number(fs.readFileSync(pidFile, 'utf8').trim()), pid);
  assert.equal((fs.readFileSync(logFile, 'utf8').match(/reloaded pid=/g) ?? []).length, 0);
  assert.deepEqual(generation(hudHome, pid), current);

  // Recover and perform 15 synthetic reloads via execve.
  fs.writeFileSync(runtimePath, originalRuntime);
  for (let i = 1; i <= 15; i++) {
    copy.stamp();
    await until(() => (fs.readFileSync(logFile, 'utf8').match(/reloaded pid=/g) ?? []).length === i, t.signal);
    assert.equal(Number(fs.readFileSync(pidFile, 'utf8').trim()), pid);
    assert.equal(generation(hudHome, pid).stamp, buildStamp(copy.root));
  }
  assert.equal(fs.existsSync(join(hudHome, 'watch-handoff.json')), false);
  if (typeof process.execve === 'function' && !['win32', 'os400'].includes(process.platform) && fs.existsSync(`/proc/${pid}/cmdline`)) {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    assert.ok(cmdline.includes('--max-old-space-size=96'), JSON.stringify(cmdline));
    assert.ok(cmdline.includes('--max-semi-space-size=2'), JSON.stringify(cmdline));
  }
  const afterPss = readProcPssMB(pid);
  if (freshPss !== null && afterPss !== null) {
    assert.ok(afterPss - freshPss <= 10, `watcher PSS grew by ${(afterPss - freshPss).toFixed(2)} MB (fresh=${freshPss.toFixed(2)}, after=${afterPss.toFixed(2)})`);
  }
  child.kill('SIGTERM');
  assert.deepEqual(await exit, [0, null]);
  assert.equal(fs.existsSync(pidFile), false);
});

test('MCP flow-task reload preserves owned receipts and rejects missing receipts with foreign or absent queue markers', { timeout: 15000 }, async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-flow-task-reload-'));
  const hudHome = join(root, 'hud');
  fs.mkdirSync(join(hudHome, 'flows'), { recursive: true, mode: 0o700 });
  const untrack = trackFixture({ root, hudHome });
  t.after(async () => {
    const survivors = await reapFixtureProcesses({ root, hudHome });
    untrack();
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(survivors.length, 0);
  });

  const script = `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import * as fs from 'node:fs';
    import { join, resolve } from 'node:path';
    import { pathToFileURL } from 'node:url';
    import { openGeneration } from ${JSON.stringify(pathToFileURL(resolve('packages/hud-mcp/bin/generation.mjs')).href)};
    import { procStat } from ${JSON.stringify(pathToFileURL(resolve('dist/utils/proc.js')).href)};

    const home = process.env.HUD_HOME;
    const pane = process.env.HERDR_PANE_ID;
    const ownStart = procStat(process.pid)?.start;
    assert.ok(ownStart, 'current process start time should be readable');
    const now = Date.now();
    const iso = new Date(now).toISOString();
    const callerHash = createHash('sha256').update(JSON.stringify([pane, null, null])).digest('hex').slice(0, 32);
    const receiptPath = (id) => join(home, 'mcp-tasks', id + '.' + callerHash + '.json');
    const stopPath = (id) => join(home, 'flows', id + '.json.cancel');
    const writeFlow = (id, data) => {
      fs.mkdirSync(join(home, 'flows', id), { recursive: true, mode: 0o700 });
      fs.writeFileSync(join(home, 'flows', id + '.json'), JSON.stringify(data));
    };
    const writeMarker = (id, marker) => {
      fs.writeFileSync(join(home, 'flows', id, 'task.json'), JSON.stringify(marker));
    };

    const qForeign = 'q0000000000000001';
    const qAbsent = 'q0000000000000002';
    const qWrongStart = 'q0000000000000003';
    const qOwnedNew = 'q0000000000000004';
    const qOwnedLegacy = 'q0000000000000005';
    const qDiskOnly = 'q0000000000000006';
    const fOwned = 'f0000000000000001';
    const fLegacyMissing = 'f0000000000000002';
    const fDiskOnly = 'f0000000000000003';
    const baseQueue = (flow, epoch, extra = {}) => ({
      flow, root: ${JSON.stringify(root)}, cwd: ${JSON.stringify(root)}, project_root: ${JSON.stringify(root)},
      feature: 'sample', pane, task: true, max_parallel: 1, created_at: iso, updated_at: iso,
      epoch, state: 'working', tickets: [], notices: {}, ...extra,
    });
    const baseLand = (flow) => ({
      flow, job: 'j0000000000000001', pane, task: true,
      wt: { main_root: ${JSON.stringify(root)}, root: ${JSON.stringify(root)}, branch: 'b' },
      config: { base: 'main', gate: [], after: [], push: false },
      state: 'running', step: 'gate[1]', pid: process.pid, start: ownStart,
      source_sha: '0000000000000000000000000000000000000000', created_at: iso, updated_at: iso,
    });

    const ownedExpiry = now + 90_000;
    const legacyExpiry = now + 120_000;
    const landExpiry = now + 150_000;

    writeFlow(qForeign, baseQueue(qForeign, 1));
    writeMarker(qForeign, { flow: qForeign, epoch: 1, pane: 'w4E:p2', pid: process.pid + 100000, start: 'foreign', expires: now + 60_000 });
    writeFlow(qAbsent, baseQueue(qAbsent, 1));
    writeFlow(qWrongStart, baseQueue(qWrongStart, 0));
    writeMarker(qWrongStart, { flow: qWrongStart, epoch: 0, pane, pid: process.pid, start: ownStart + '-mismatch', expires: now + 60_000 });
    writeFlow(qOwnedNew, baseQueue(qOwnedNew, 2, { state: 'paused', notices: { 'pause-2': 'synthetic owned pause' } }));
    writeFlow(qOwnedLegacy, baseQueue(qOwnedLegacy, 1, { state: 'paused', notices: { 'pause-1': 'synthetic legacy pause' } }));
    writeMarker(qOwnedLegacy, { flow: qOwnedLegacy, epoch: 1, pane, pid: process.pid, start: ownStart, expires: legacyExpiry });
    writeFlow(qDiskOnly, baseQueue(qDiskOnly, 0, { state: 'paused', notices: { 'pause-0': 'synthetic disk-only pause' } }));
    fs.mkdirSync(join(home, 'mcp-tasks'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(receiptPath(qDiskOnly), JSON.stringify({ id: qDiskOnly, epoch: 0, expiresAt: now + 60_000 }));
    writeFlow(fOwned, baseLand(fOwned));
    writeFlow(fLegacyMissing, baseLand(fLegacyMissing));
    writeFlow(fDiskOnly, baseLand(fDiskOnly));
    fs.writeFileSync(receiptPath(fDiskOnly), JSON.stringify({ id: fDiskOnly, expiresAt: now + 60_000 }));

    const entryUrl = pathToFileURL(resolve('dist/mcp/thin-main.js'));
    let rpcId = 0;
    const req = async (gen, method, params) => {
      const reply = await gen.call('request', JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }));
      assert.equal(reply.error, undefined, method + ' error: ' + JSON.stringify(reply.error));
      return reply.result;
    };
    const discover = (gen) => req(gen, 'server/discover', {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/tasks': {} } },
      },
    });

    // 1. New snapshot() carries flowTasks Map (not landTasks Set); stale epochs stay unknown, owned tasks survive.
    const gen1 = await openGeneration(entryUrl);
    await gen1.call('start');
    await discover(gen1);
    const snap1 = await gen1.call('snapshot');
    await gen1.call('stop');
    await gen1.retire();
    assert.ok(snap1.flowTasks instanceof Map);
    assert.equal('landTasks' in snap1, false);

    const newState = {
      ...snap1,
      flowTasks: new Map([
        [qForeign, { id: qForeign, epoch: 0, expiresAt: now + 60_000 }],
        [qAbsent, { id: qAbsent, epoch: 0, expiresAt: now + 60_000 }],
        [qOwnedNew, { id: qOwnedNew, epoch: 2, expiresAt: ownedExpiry }],
        [fOwned, { id: fOwned, expiresAt: landExpiry }],
      ]),
    };
    const gen2 = await openGeneration(entryUrl);
    await gen2.call('start', newState);
    for (const id of [qForeign, qAbsent]) {
      const got = await req(gen2, 'tasks/get', { taskId: id });
      assert.equal(got.status, 'failed');
      assert.match(got.statusMessage, /Unknown or expired task.*hud_read/);
      const cancelled = await req(gen2, 'tasks/cancel', { taskId: id });
      assert.equal(cancelled.status, 'failed');
      assert.match(cancelled.statusMessage, /Unknown or expired task.*hud_read/);
      assert.equal(fs.existsSync(receiptPath(id)), false, id + ' must not fabricate caller receipt');
      assert.equal(fs.existsSync(stopPath(id)), false, id + ' must not be cancelled');
    }
    const ownedGet = await req(gen2, 'tasks/get', { taskId: qOwnedNew });
    assert.equal(ownedGet.status, 'completed');
    assert.match(ownedGet.result.content[0].text, /synthetic owned pause/);
    const landGet = await req(gen2, 'tasks/get', { taskId: fOwned });
    assert.equal(landGet.status, 'working');

    // Disk-only receipt allows polling (tasks/get) but not tasks/cancel (needs in-memory authority).
    const diskGet = await req(gen2, 'tasks/get', { taskId: qDiskOnly });
    assert.equal(diskGet.status, 'completed');
    const diskCancel = await req(gen2, 'tasks/cancel', { taskId: qDiskOnly });
    assert.equal(diskCancel.status, 'failed');
    assert.match(diskCancel.statusMessage, /Unknown or expired task.*hud_read/);
    assert.equal(fs.existsSync(stopPath(qDiskOnly)), false);
    const landDiskGet = await req(gen2, 'tasks/get', { taskId: fDiskOnly });
    assert.equal(landDiskGet.status, 'working');
    const landDiskCancel = await req(gen2, 'tasks/cancel', { taskId: fDiskOnly });
    assert.equal(landDiskCancel.status, 'failed');
    assert.match(landDiskCancel.statusMessage, /Unknown or expired task.*hud_read/);
    assert.equal(fs.existsSync(stopPath(fDiskOnly)), false);

    // Owned tasks retain exact epoch & expiry across another snapshot -> reload, and keep cancel authority.
    const snap2 = await gen2.call('snapshot');
    await gen2.call('stop');
    await gen2.retire();
    assert.deepEqual(snap2.flowTasks.get(qOwnedNew), { id: qOwnedNew, epoch: 2, expiresAt: ownedExpiry });
    assert.deepEqual(snap2.flowTasks.get(fOwned), { id: fOwned, expiresAt: landExpiry });
    const gen2b = await openGeneration(entryUrl);
    await gen2b.call('start', snap2);
    const landCancel = await req(gen2b, 'tasks/cancel', { taskId: fOwned });
    assert.equal(landCancel.status, 'working');
    assert.equal(fs.existsSync(stopPath(fOwned)), true, 'owned flow keeps in-memory cancel authority after reload');
    await gen2b.call('stop');
    await gen2b.retire();

    // 2. Legacy landTasks Set (upgrade reload) backfills only from an unexpired own-process queue marker matching pid, start & epoch.
    const legacyState = { ...snap1, landTasks: new Set([qForeign, qAbsent, qWrongStart, qOwnedLegacy, fLegacyMissing]) };
    delete legacyState.flowTasks;
    const gen3 = await openGeneration(entryUrl);
    await gen3.call('start', legacyState);
    for (const id of [qForeign, qAbsent, qWrongStart, fLegacyMissing]) {
      const got = await req(gen3, 'tasks/get', { taskId: id });
      assert.equal(got.status, 'failed', id + ' should be unknown on get');
      assert.match(got.statusMessage, /Unknown or expired task.*hud_read/);
      const cancelled = await req(gen3, 'tasks/cancel', { taskId: id });
      assert.equal(cancelled.status, 'failed', id + ' should be unknown on cancel');
      assert.match(cancelled.statusMessage, /Unknown or expired task.*hud_read/);
      assert.equal(fs.existsSync(receiptPath(id)), false, id + ' must not fabricate caller receipt');
      assert.equal(fs.existsSync(stopPath(id)), false, id + ' must not be cancelled');
    }
    const legacyOwnedGet = await req(gen3, 'tasks/get', { taskId: qOwnedLegacy });
    assert.equal(legacyOwnedGet.status, 'completed');
    assert.match(legacyOwnedGet.result.content[0].text, /synthetic legacy pause/);
    const snap3 = await gen3.call('snapshot');
    await gen3.call('stop');
    await gen3.retire();
    assert.deepEqual(snap3.flowTasks.get(qOwnedLegacy), { id: qOwnedLegacy, epoch: 1, expiresAt: legacyExpiry });
  `;

  const scriptPath = join(root, 'reload-flow-tasks.mjs');
  fs.writeFileSync(scriptPath, script);
  const child = spawn(process.execPath, [scriptPath], {
    cwd: resolve('.'),
    env: { ...process.env, HUD_HOME: hudHome, HERDR_PANE_ID: 'w4E:p1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code, signal] = await once(child, 'exit');
  assert.deepEqual([code, signal], [0, null], stderr);
});
