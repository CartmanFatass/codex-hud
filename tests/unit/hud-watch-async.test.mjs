import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { runCommand } from '../../dist/roles/herdr-run.js';
import { WATCH_TAB_FACTS_LIMIT } from '../../dist/runtime/watch-runtime.js';
import { workSummaryPath } from '../../dist/collectors/work-summary-snapshot.js';
import { procStat } from '../../dist/roles/worker-tree.js';
import { git, initRepo } from '../fixtures/managed-worktree.mjs';
import { expired, fixture, hour, until } from '../helpers/job-retention-fixture.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

const text = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const json = (dir, file) => JSON.parse(text(join(dir, file)) || 'null');
const save = (dir, file, value) => writeFixtureFile(join(dir, file), JSON.stringify(value));
const status = (dir) => json(dir, 'STATUS.json');
const receipt = (dir) => json(dir, 'job.json');
const reaped = (dir) => receipt(dir)?.reaped_at;
const closed = () => ({ state: 'closed', ended_at: new Date().toISOString() });
function bin(f, name, body) {
  fs.writeFileSync(join(dirname(f.home), 'bin', name), `#!${process.execPath}
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
${body}\n`, { mode: 0o700 });
}
function reapStub(f, body) {
  bin(f, 'hud-reap', `const dir = process.argv[2];
fs.appendFileSync(join(process.env.HUD_HOME, 'reaps'), dir + '\\n');
${body}`);
}
const attempts = (f, dir) => text(join(f.home, 'reaps')).split('\n').filter((line) => line === dir).length;
const session = (dir, fields, endpoint = join(dir, '../../../herdr.sock')) =>
  writeFixtureFile(join(dir, 'SESSION.txt'), `${fields}HERDR_SOCKET_PATH=${endpoint}\n`);
const tab = (dir, name) => session(dir, `TAB=${name}\nPRIMARY=${name}-agent\n`);
function settled() {
  const now = Date.now();
  return {
    created: new Date(now - 2000).toISOString(),
    state: { state: 'idle_grace', output_written: true, settled_at: new Date(now - 500).toISOString() },
    reportTime: (now - 1000) / 1000,
  };
}
async function herdrSocket(t, f, answer, paneReply) {
  const path = join(dirname(f.home), 'herdr.sock');
  const sockets = new Set();
  const subscribed = Promise.withResolvers(), queried = Promise.withResolvers();
  let subscriber, subscriptions = 0, queries = 0, pending = 0;
  const vanished = new Set(), lookups = [];
  const emitTabClosed = (id) => subscriber.write(JSON.stringify({ event: 'tab.closed', data: { tab_id: id } }) + '\n');
  const emitTabsClosed = (ids) => subscriber.write(ids.map((id) => JSON.stringify({ event: 'tab.closed', data: { tab_id: id } }) + '\n').join(''));
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const lines = createInterface({ input: socket });
    // The watcher may abort a probe or preflight while Herdr is replying.
    lines.on('error', (error) => { if (error.code !== 'ECONNRESET') throw error; });
    lines.on('line', async (line) => {
      const { method, id, params } = JSON.parse(line);
      if (method === 'events.subscribe') {
        subscriber = socket; subscriptions++; subscribed.resolve();
        socket.write(JSON.stringify({ id, result: { type: 'subscribed' } }) + '\n');
      }
      if (method === 'pane.get' || method === 'tab.get') {
        const target = params.pane_id ?? params.tab_id;
        lookups.push(target);
        const reply = method === 'pane.get' && paneReply ? await paneReply(target) : vanished.has(target)
          ? { error: { code: method === 'pane.get' ? 'pane_not_found' : 'tab_not_found' } } : method === 'pane.get'
            ? { result: { pane: { pane_id: target } } } : { result: { tab: { tab_id: target } } };
        socket.write(JSON.stringify({ id, ...reply }) + '\n');
      }
      if (method === 'agent.get') {
        queried.resolve();
        queries++;
        pending++;
        socket.once('close', () => pending--);
        if (answer) socket.write(JSON.stringify({ id, result: { agent: { agent_status: answer } } }) + '\n');
      }
    });
  });
  server.listen(path);
  await once(server, 'listening');
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((done) => server.close(done));
  });
  return {
    preload: `process.env.HERDR_SOCKET_PATH = ${JSON.stringify(path)};`,
    preflight: Promise.all([subscribed.promise, queried.promise]),
    ready: () => Boolean(subscriber), subscriptions: () => subscriptions, queries: () => queries, pending: () => pending,
    lookups, emitTabClosed, emitTabsClosed, drop: () => subscriber.destroy(),
    hide: (id) => vanished.add(id),
    closeTab: (id, pane = id) => { vanished.add(pane); emitTabClosed(id); },
  };
}

test('watcher settles other jobs, starts checks and handles failures during a pending reap', { timeout: 30000 }, async (t) => {
  const f = fixture(t), herdr = await herdrSocket(t, f);
  const slow = f.job(closed(), {}, true), fast = f.job({ state: 'working' }, {}, true);
  const { created, state, reportTime } = settled();
  const checked = f.job({ state: 'working' }, { checks: ['true'], cwd: dirname(f.home), created_at: created });
  fs.utimesSync(join(checked, 'report.md'), reportTime, reportTime);
  const failed = f.job({ state: 'working' }), cli = f.job({ state: 'working' }, { cli: { agent: 'claude' } });
  tab(failed, 'external');
  const supervisor = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(supervisor, 'exit');
  const release = join(slow, 'release');
  reapStub(f, `if (dir === ${JSON.stringify(slow)}) {
    while (!fs.existsSync(${JSON.stringify(release)})) await delay(10);
  }`);
  const { child, exited } = f.start(herdr.preload + "process.env.HUD_WATCH_FAILED_RETENTION_MS = '0';");
  await until(() => attempts(f, slow) && herdr.ready(), t.signal);

  save(fast, 'STATUS.json', closed());
  save(checked, 'STATUS.json', { ...state, state: 'closed' });
  save(cli, 'STATUS.json', { state: 'working', supervisor_pid: supervisor.pid });
  herdr.closeTab('external');
  const storm = (async () => {
    for (let i = 0; i < 10; i++) {
      save(slow, 'job.json', { ...receipt(slow), update: i });
      save(slow, 'STATUS.json', closed());
      await delay(10);
    }
  })();
  // The contract is progress while another reap is blocked, not a 500 ms
  // allowance for spawning a check and scheduling the test observer.
  while (!reaped(fast) || json(checked, 'checks.json')?.state !== 'done' ||
         status(failed).exit_reason !== 'tab closed' || status(cli).state !== 'waiting_orchestrator')
    await delay(20, null, { signal: t.signal });
  await storm;
  assert.equal(json(checked, 'checks.json').results[0].exit_code, 0);
  assert.equal(reaped(slow), undefined, 'slow reap is still running');
  save(cli, 'STATUS.json', closed());
  fs.writeFileSync(release, '');
  const [code, signal] = await exited;
  assert.deepEqual([code, signal], [0, null]);
  assert.ok(reaped(slow));
  assert.equal(receipt(slow).update, 9, 'keep concurrent receipt updates');
  assert.equal(attempts(f, slow), 1, 'one reap despite repeated disk events');
  assert.equal(fs.existsSync(join(f.home, 'watch.pid')), false);
  assert.equal(child.exitCode, 0);
});

for (const kind of ['fresh Pi', 'fresh CLI', 'resumed Pi', 'resumed Pi after reload']) {
  test(`watcher ignores a buffered tab close for ${kind} but handles its own close`, { timeout: 30000 }, async (t) => {
    const f = fixture(t), herdr = await herdrSocket(t, f);
    const reused = 'w4E:t2';
    const prior = f.job(closed(), { role: 'imp', resume_s: 60, reaped_at: new Date().toISOString() });
    const launch = (dir, token) => session(dir, `TAB=${reused}\nLEFT=${token}-pane\nLAUNCH=${token}\n`);
    launch(prior, 'old-launch');
    let root;
    if (kind.endsWith('after reload')) {
      root = join(dirname(f.home), 'build');
      for (const name of ['dist', 'packages/hud-mcp', 'scripts/dist-lock.mjs', 'package.json'])
        fs.cpSync(resolve(name), join(root, name), { recursive: true });
      fs.symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
    }
    const keepOpen = f.job({ state: 'working' });
    const { child, exited } = f.start(herdr.preload, f.pi, root && join(root, 'packages/hud-mcp/bin/hud-watch.mjs'));
    await until(herdr.ready, t.signal);

    const cli = kind === 'fresh CLI';
    const dir = kind.startsWith('resumed') ? prior : f.job({ state: 'working' }, cli ? { cli: { agent: 'claude' } } : {});
    fs.unlinkSync(join(dir, 'report.md'));
    if (dir === prior) {
      // A resume retires the old SESSION and publishes working before the new tab receipt.
      save(dir, 'job.json', { ...receipt(dir), reaped_at: undefined });
      fs.unlinkSync(join(dir, 'SESSION.txt'));
      save(dir, 'STATUS.json', { state: 'working' });
    }
    launch(dir, 'new-launch');
    if (root) {
      // Deliver the buffered event even after a reload; only the replacement's state matters.
      fs.appendFileSync(join(root, 'dist/index.js'), '\n// synthetic reload\n');
      await until(() => herdr.subscriptions() === 2, t.signal);
      assert.match(f.log(), new RegExp(`reloaded pid=${child.pid}`));
    }
    const marker = f.job({ state: 'working' });
    tab(marker, 'marker');
    const checks = () => herdr.lookups.filter(pane => pane === 'new-launch-pane').length;
    const before = checks();
    herdr.emitTabClosed(reused); // Old close arrives after this launch, whose target is present.
    herdr.closeTab('marker');
    await until(() => status(marker)?.exit_reason === 'tab closed' && checks() > before, t.signal);
    assert.equal(status(dir).state, 'working', 'a prior occupant closed, not this launch');

    herdr.closeTab(reused, 'new-launch-pane');
    await until(() => status(dir)?.exit_reason === 'tab closed', t.signal);
    assert.equal(status(dir).state, 'failed');
    assert.deepEqual(receipt(dir).stop_origin, { actor: 'pane_vanished', prior_state: 'working', at: status(dir).ended_at });
    assert.equal(status(keepOpen).state, 'working');
    child.kill('SIGTERM');
    assert.deepEqual(await exited, [0, null]);
  });
}

test('watcher reconciles a new receipt whose tab disappeared before publication', { timeout: 15000 }, async (t) => {
  const f = fixture(t), herdr = await herdrSocket(t, f);
  const dir = f.job({ state: 'working' });
  const { child, exited } = f.start(herdr.preload);
  await until(herdr.ready, t.signal);
  herdr.hide('early-close'); // No close event is required once the receipt exists.
  tab(dir, 'early-close');
  await until(() => status(dir)?.exit_reason === 'tab closed', t.signal);
  assert.equal(status(dir).state, 'failed');
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
});

test('watcher reconciles a missing tab on resubscribe without a close event', { timeout: 15000 }, async (t) => {
  const f = fixture(t), herdr = await herdrSocket(t, f);
  const dir = f.job({ state: 'working' });
  tab(dir, 'gap-tab');
  const { child, exited } = f.start(herdr.preload + "process.env.HUD_WATCH_CLI_CHECK_MS = '60000';");
  await until(() => herdr.ready() && herdr.lookups.includes('gap-tab'), t.signal);
  herdr.drop();
  herdr.hide('gap-tab'); // The disappearance happened without a subscribed watcher.
  await until(() => herdr.subscriptions() === 2 && status(dir)?.exit_reason === 'tab closed', t.signal);
  assert.equal(status(dir).state, 'failed');
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
});

test('watcher retries an unknown Herdr answer without another close event', { timeout: 6000 }, async (t) => {
  const f = fixture(t), probes = [];
  let gone = false;
  const herdr = await herdrSocket(t, f, null, pane => {
    if (!gone) return { result: { pane: { pane_id: pane } } };
    probes.push(Date.now());
    // The wrong method's absence code is not proof that this pane is missing.
    return { error: { code: probes.length === 1 ? 'tab_not_found' : 'pane_not_found' } };
  });
  f.job({ state: 'working' });
  const { child, exited } = f.start(herdr.preload + "process.env.HUD_WATCH_CLI_CHECK_MS = '60000';");
  await until(herdr.ready, t.signal);
  const dir = f.job({ state: 'working' });
  session(dir, 'TAB=lost-tab\nLEFT=lost-pane\n');
  await until(() => herdr.lookups.includes('lost-pane'), t.signal);
  gone = true;
  herdr.emitTabClosed('lost-tab');
  await until(() => status(dir)?.exit_reason === 'tab closed', t.signal);
  assert.equal(probes.length, 2);
  assert.ok(probes[1] - probes[0] >= 200, 'the next probe must back off');
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
});

test('watcher does not probe a receipt from another Herdr socket', { timeout: 6000 }, async (t) => {
  const f = fixture(t), herdr = await herdrSocket(t, f);
  const other = f.job({ state: 'working' }), local = f.job({ state: 'working' });
  session(other, 'TAB=foreign-tab\nLEFT=foreign-pane\n', join(dirname(f.home), 'other-herdr.sock'));
  tab(local, 'local-tab');
  const { child, exited } = f.start(herdr.preload);
  await until(() => herdr.ready() && herdr.lookups.includes('local-tab'), t.signal);
  herdr.closeTab('foreign-tab', 'foreign-pane');
  assert.equal(herdr.lookups.includes('foreign-pane'), false);
  herdr.closeTab('local-tab');
  await until(() => status(local)?.exit_reason === 'tab closed', t.signal);
  assert.equal(herdr.lookups.includes('foreign-pane'), false);
  assert.equal(status(other).state, 'working');
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
});

test('watcher discards a pane_not_found reply when the SESSION changes during the query', { timeout: 15000 }, async (t) => {
  const f = fixture(t), reply = Promise.withResolvers();
  const herdr = await herdrSocket(t, f, null, (pane) => pane === 'old-pane' ? reply.promise : { result: { pane: { pane_id: pane } } });
  const dir = f.job({ state: 'working' });
  const bind = (pane) => session(dir, `TAB=reused-tab\nLEFT=${pane}\n`);
  bind('old-pane');
  const { child, exited } = f.start(herdr.preload);
  await until(() => herdr.lookups.includes('old-pane'), t.signal);
  bind('new-pane');
  reply.resolve({ error: { code: 'pane_not_found' } });
  await until(() => herdr.lookups.includes('new-pane'), t.signal);
  assert.equal(status(dir).state, 'working');
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
});

test('watcher recovers an evicted tab close wake through a full tab pass', { timeout: 15000 }, async (t) => {
  const f = fixture(t);
  let hold = null, gone = false;
  const herdr = await herdrSocket(t, f, null, (pane) => {
    if (pane === 'blocker-pane' && hold) return hold.promise;
    if (pane === 'evicted-pane' && gone) return { error: { code: 'pane_not_found' } };
    return { result: { pane: { pane_id: pane } } };
  });
  const blocker = f.job({ state: 'working' }), evicted = f.job({ state: 'working' });
  session(blocker, 'TAB=blocker-tab\nLEFT=blocker-pane\n');
  session(evicted, 'TAB=evicted-tab\nLEFT=evicted-pane\n');
  const { child, exited } = f.start(herdr.preload + "process.env.HUD_WATCH_CLI_CHECK_MS = '60000';");
  const lookups = (pane) => herdr.lookups.filter((id) => id === pane).length;
  await until(() => herdr.ready() && lookups('blocker-pane') >= 1 && lookups('evicted-pane') >= 1, t.signal);

  const beforeBlocker = lookups('blocker-pane');
  hold = Promise.withResolvers();
  herdr.emitTabClosed('blocker-tab');
  await until(() => lookups('blocker-pane') > beforeBlocker, t.signal);

  const summary = workSummaryPath(f.home);
  const revisionBefore = json(f.home, 'jobs-revision.json')?.notice ?? 0;
  gone = true;
  fs.rmSync(summary, { force: true });
  herdr.emitTabsClosed(['evicted-tab', ...Array.from({ length: WATCH_TAB_FACTS_LIMIT + 10 }, (_, i) => `n${i}`)]);
  await until(() => fs.existsSync(summary), t.signal);

  const release = hold;
  hold = null;
  release.resolve({ result: { pane: { pane_id: 'blocker-pane' } } });
  await until(() => status(evicted)?.exit_reason === 'tab closed' &&
    (json(f.home, 'jobs-revision.json')?.notice ?? 0) > revisionBefore &&
    json(f.home, 'jobs-revision.json')?.jobs?.[basename(evicted)] > 0, t.signal);
  assert.equal(status(evicted).state, 'failed');
  assert.deepEqual(receipt(evicted).stop_origin, { actor: 'pane_vanished', prior_state: 'working', at: status(evicted).ended_at });
  assert.equal(status(blocker).state, 'working');
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
});

test('watcher settles an unreported Pi exit on its safety tick once the pane is also gone', { timeout: 30000 }, async (t) => {
  const f = fixture(t), panes = [];
  let paneGone = false;
  const herdr = await herdrSocket(t, f, null, (id) => {
    panes.push(id);
    return paneGone ? { error: { code: 'pane_not_found' } } : { result: { pane: { pane_id: id } } };
  });
  const worker = spawn(process.execPath, ['-e', 'process.stdin.resume()']);
  const ended = once(worker, 'exit');
  t.after(async () => { worker.kill(); await ended; });
  const dir = f.job({ state: 'working', slot: 'primary', pid: worker.pid, pid_start_time: procStat(worker.pid).start });
  fs.unlinkSync(join(dir, 'report.md'));
  session(dir, 'TAB=synthetic-tab\nLEFT=synthetic-worker\n');
  const { exited } = f.start(herdr.preload + "process.env.HUD_WATCH_CLI_CHECK_MS = '75';");
  await until(() => herdr.ready() && panes.length > 0, t.signal);
  assert.equal(status(dir).state, 'working');
  worker.stdin.end();
  await ended;
  const baseline = panes.length;
  // No job file changes, tab-close event or stop request: only the liveness tick can notice.
  await until(() => panes.length > baseline, t.signal);
  assert.equal(panes[0], 'synthetic-worker');
  assert.equal(status(dir).state, 'working', 'a remaining pane is not evidence of closure');
  paneGone = true;
  await until(() => status(dir).state === 'stopped', t.signal);
  assert.equal(status(dir).exit_reason, 'process exited without a report');
  assert.ok(status(dir).ended_at);
  assert.deepEqual(await exited, [0, null]);
  assert.ok(reaped(dir));
  assert.deepEqual(receipt(dir).stop_origin, { actor: 'pane_vanished', prior_state: 'working', at: status(dir).ended_at });
});

for (const outcome of ['closed tab', 'missing or renamed tab']) test(`watcher reaps an exited root without a snapshot once (${outcome}), idles, then archives it at retention`, { timeout: 60000 }, async (t) => {
  const f = fixture(t);
  const root = spawn(process.execPath, ['-e', 'process.stdin.resume()']);
  const start = procStat(root.pid).start;
  root.stdin.end();
  await once(root, 'exit');
  const dir = f.job({ ...expired(), state: 'stopped' });
  save(dir, 'STATUS.json', { ...status(dir), slot: 'primary', task_dir: dir, pid: root.pid, pid_start_time: start });
  writeFixtureFile(join(dir, 'SESSION.txt'), 'TAB=synthetic-tab\nLEFT=synthetic-worker\nORCH=synthetic-caller\n');
  assert.equal(fs.existsSync(join(dir, 'worker-tree.json')), false);
  if (outcome === 'missing or renamed tab') reapStub(f, `
console.error('hud-reap: ' + dir + ': TAB synthetic-tab name changed or missing; not closing');
process.exitCode = 1;`);
  const { child, exited } = f.start("process.env.HUD_WATCH_CLI_CHECK_MS = '30';");
  await until(() => child.exitCode !== null || attempts(f, dir) >= 2, t.signal);
  assert.equal(attempts(f, dir), 1, f.log());
  assert.deepEqual(await exited, [0, null]);
  const stamp = reaped(dir);
  assert.ok(stamp);
  assert.equal(f.log().match(/worker-tree snapshot unresolved/g)?.length, 1);
  assert.match(f.log(), /exit pid=\d+: no open jobs or failed deadlines/);
  assert.equal(fs.existsSync(join(f.home, 'watch.pid')), false);

  assert.deepEqual(await f.start(`Date.now = () => ${Date.parse(stamp) + 25 * hour};`).exited, [0, null]);
  assert.equal(fs.existsSync(dir), false);
  const [archive] = fs.readdirSync(join(f.home, 'archive'));
  assert.equal(json(join(f.home, 'archive'), archive).reaped_at, stamp);
  assert.equal(attempts(f, dir), 1);
  assert.equal(f.log().match(/worker-tree snapshot unresolved/g)?.length, 1);
});

test('unresolved worker-tree warnings are logged once per job across changing reap outcomes and watcher restart', { timeout: 60000 }, async (t) => {
  const f = fixture(t);
  const root = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const start = procStat(root.pid).start;
  await once(root, 'exit');
  const dirs = Array.from({ length: 2 }, () => {
    const dir = f.job(closed());
    save(dir, 'STATUS.json', { ...status(dir), slot: 'primary', task_dir: dir, pid: root.pid, pid_start_time: start });
    writeFixtureFile(join(dir, 'SESSION.txt'), 'TAB=synthetic-tab\nLEFT=synthetic-worker\nORCH=synthetic-caller\n');
    fs.mkdirSync(join(dir, 'worker-tree.json')); // A read error keeps cleanup retryable.
    return dir;
  });
  reapStub(f, `if (fs.existsSync(join(dir, 'worker-tree.json'))) process.exitCode = fs.existsSync(join(dir, 'change-outcome')) ? 2 : 1;`);
  const retry = "process.env.HUD_WATCH_CLI_CHECK_MS = '50';";
  const log = () => text(join(f.home, 'watch.log'));
  const count = dir => log().split('\n').filter(line => line.includes(`reap ${basename(dir)} `) && line.includes('worker-tree snapshot unresolved')).length;
  const changed = dir => `reap ${basename(dir)} state=closed exit=2`;
  const first = f.start(retry);
  await until(() => dirs.every(dir => count(dir) >= 1), t.signal);
  for (const dir of dirs) fs.writeFileSync(join(dir, 'change-outcome'), '');
  await until(() => dirs.every(dir => log().includes(changed(dir))), t.signal);
  assert.deepEqual(dirs.map(count), [1, 1]);
  first.child.kill('SIGTERM');
  assert.deepEqual(await first.exited, [0, null]);

  const second = f.start(retry);
  await until(() => {
    const current = log();
    return dirs.every(dir => current.lastIndexOf(changed(dir)) > current.lastIndexOf('start pid='));
  }, t.signal);
  for (const dir of dirs) fs.rmdirSync(join(dir, 'worker-tree.json'));
  assert.deepEqual(await second.exited, [0, null]);
  assert.ok(dirs.every(dir => reaped(dir) && attempts(f, dir) >= 3));
  assert.deepEqual(dirs.map(count), [1, 1]);
});

test('watch.log carries the reaper refusal reason on exit 1', { timeout: 60000 }, async (t) => {
  const f = fixture(t), dir = f.job(closed(), {}, true);
  reapStub(f, `
console.error('hud-reap: ' + dir + ': active post-worker process remains in shell session; not closing');
process.exitCode = 1;`);
  const { child, exited } = f.start("process.env.HUD_WATCH_CLI_CHECK_MS = '30';");
  const log = () => text(join(f.home, 'watch.log'));
  await until(() => log().includes(`reap ${basename(dir)} state=closed exit=1;`), t.signal);
  const line = log().split('\n').find(l => l.includes(`reap ${basename(dir)} state=closed exit=1;`));
  assert.ok(line, log());
  assert.match(line, /active post-worker process remains in shell session; not closing/);
  assert.doesNotMatch(line, /hud-reap:/);
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
});

test('overlapping watcher startups publish only one ready PID', async (t) => {
  const f = fixture(t);
  f.job({ state: 'working' });
  const runs = [f.start(), f.start()];
  await until(() => runs.some(({ child }) => child.exitCode === 0) && fs.existsSync(join(f.home, 'watch.pid')), 15000);
  const pid = Number(text(join(f.home, 'watch.pid')));
  const live = runs.find(({ child }) => child.pid === pid);
  assert.ok(live);
  assert.equal(f.log().match(/start pid=/g)?.length, 1);
  live.child.kill('SIGTERM');
  assert.deepEqual(await Promise.all(runs.map(({ exited }) => exited)), [[0, null], [0, null]]);
  assert.equal(fs.existsSync(join(f.home, 'watch.pid')), false);
});

test('watcher dispatches at most four concurrent reaps and resumes the backlog', { timeout: 30000 }, async (t) => {
  const f = fixture(t), dirs = Array.from({ length: 6 }, () => f.job(closed(), {}, true));
  reapStub(f, `while (!fs.existsSync(join(process.env.HUD_HOME, 'release'))) await delay(10);`);
  const { exited } = f.start();
  const count = () => text(join(f.home, 'reaps')).trim().split('\n').filter(Boolean).length;
  await until(() => count() >= 4, t.signal);
  // Finish a new scan while all four reaps remain pinned in their helpers.
  const summary = workSummaryPath(f.home);
  fs.rmSync(summary, { force: true });
  save(dirs[0], 'STATUS.json', closed());
  await until(() => fs.existsSync(summary), t.signal);
  assert.equal(count(), 4);
  fs.writeFileSync(join(f.home, 'release'), '');
  assert.deepEqual(await exited, [0, null]);
  assert.ok(dirs.every((dir) => reaped(dir) && attempts(f, dir) === 1));
});

for (const [answer, event] of [['idle', 'self close'], ['working', 'no spin'], [null, 'external close']]) {
  test(`read-close preflight: ${event}`, { timeout: 30000 }, async (t) => {
    const f = fixture(t), herdr = await herdrSocket(t, f, answer);
    const { created, state, reportTime } = settled();
    const dir = f.job(state, { created_at: created, read_at: new Date().toISOString() });
    fs.utimesSync(join(dir, 'report.md'), reportTime, reportTime);
    tab(dir, 'pi');
    reapStub(f, `while (!fs.existsSync(join(dir, 'release'))) await delay(10);`);
    const { child, exited } = f.start(herdr.preload);
    await herdr.preflight; // Startup (including the shared dist lock) is not part of the query budget.
    const summary = workSummaryPath(f.home);
    if (event === 'no spin') {
      // Observe a scan after the preflight socket has consumed the working reply.
      await until(() => herdr.pending() === 0, t.signal);
      fs.rmSync(summary, { force: true });
      save(dir, 'STATUS.json', state);
      await until(() => fs.existsSync(summary), t.signal);
      assert.equal(herdr.queries(), 1);
      assert.equal(attempts(f, dir), 0);
      child.kill('SIGTERM');
    } else if (event === 'self close') {
      await until(() => attempts(f, dir) === 1, t.signal);
      fs.rmSync(summary, { force: true });
      herdr.closeTab('pi');
      await until(() => fs.existsSync(summary), t.signal);
      assert.equal(status(dir).state, 'idle_grace');
      fs.writeFileSync(join(dir, 'release'), '');
      await until(() => reaped(dir), t.signal);
      assert.equal(status(dir).state, 'closed');
      assert.equal(status(dir).exit_reason, 'closed after report read');
    } else {
      assert.equal(herdr.pending(), 1);
      const start = performance.now();
      herdr.closeTab('pi');
      await until(() => herdr.pending() === 0 && status(dir).state === 'failed', t.signal);
      assert.ok(performance.now() - start < 1000, 'cancel the query without waiting for its 2 s budget');
      assert.equal(status(dir).exit_reason, 'tab closed');
      assert.equal(attempts(f, dir), 0, 'failed tab is still in retention');
      child.kill('SIGTERM');
    }
    assert.deepEqual(await exited, [0, null]);
  });
}

test('failed Pi read-close retries its live root after the tab disappears', async (t) => {
  const f = fixture(t), herdr = await herdrSocket(t, f, 'idle');
  const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const ended = once(worker, 'exit');
  t.after(async () => { worker.kill(); await ended; });
  const { created, state, reportTime } = settled();
  const dir = f.job({ ...state, pid: worker.pid, pid_start_time: procStat(worker.pid).start },
    { created_at: created, read_at: new Date().toISOString() });
  fs.utimesSync(join(dir, 'report.md'), reportTime, reportTime);
  tab(dir, 'pi');
  fs.appendFileSync(join(dir, 'SESSION.txt'), 'LEFT=pi-worker\n');
  reapStub(f, `if (!fs.existsSync(join(dir, 'tab-gone'))) {
    fs.writeFileSync(join(dir, 'waiting-for-tab-close'), '');
    while (!fs.existsSync(join(dir, 'tab-gone'))) await delay(10);
    process.exit(1);
  }
  while (!fs.existsSync(join(dir, 'allow-retry-to-finish'))) await delay(10);`);
  const { exited } = f.start(herdr.preload);
  // The shared attempts log records entry, not which branch the reaper took.
  await until(() => herdr.ready() && fs.existsSync(join(dir, 'waiting-for-tab-close')), t.signal);
  herdr.closeTab('pi', 'pi-worker');
  fs.writeFileSync(join(dir, 'tab-gone'), '');
  await until(() => f.log().includes('state=idle_grace exit=1'), t.signal);
  assert.equal(status(dir).state, 'idle_grace');
  fs.writeFileSync(join(dir, 'allow-retry-to-finish'), '');
  await until(() => reaped(dir), t.signal);
  assert.deepEqual(await exited, [0, null]);
  assert.equal(attempts(f, dir), 2);
  assert.equal(herdr.queries(), 1, 'the missing tab cannot answer another preflight');
  assert.equal(status(dir).exit_reason, 'closed after report read');
});

test('watcher removes two merged worktrees from the same checkout', { timeout: 60000 }, async (t) => {
  const f = fixture(t), parent = dirname(f.home), main_root = initRepo(parent);
  const base_head = git(main_root, 'rev-parse', 'HEAD');
  const trees = Array.from({ length: 2 }, () => {
    const dir = f.job(closed(), {}, true), name = `imp-${basename(dir).slice(-6)}`;
    const root = join(parent, 'demo-wt', name), branch = `wt/${name}`;
    git(main_root, 'worktree', 'add', '-qb', branch, root, base_head);
    save(dir, 'job.json', { ...receipt(dir), cwd: root, worktree: { root, branch, main_root, base_head } });
    return { dir, root, branch };
  });
  assert.deepEqual(await f.start().exited, [0, null]);
  for (const { dir, root, branch } of trees) {
    assert.ok(receipt(dir).worktree_removed_at);
    assert.equal(receipt(dir).worktree_kept_reason, undefined);
    assert.equal(fs.existsSync(root), false);
    assert.equal(git(main_root, 'branch', '--list', branch), '');
  }
});

for (const stubborn of [false, true]) {
  test(`watcher SIGTERM drains ${stubborn ? 'TERM-resistant' : 'cooperative'} reap group without live orphans`, { timeout: 60000 }, async (t) => {
    const f = fixture(t), dir = f.job(closed(), {}, true);
    bin(f, 'herdr', `if (${stubborn}) process.on('SIGTERM', () => {});
fs.writeFileSync(join(process.env.HUD_HOME, 'herdr-pid'), String(process.pid));
await delay(30000);`);
    reapStub(f, `fs.writeFileSync(join(process.env.HUD_HOME, 'reap-pid'), String(process.pid));
if (${stubborn}) spawnSync('herdr', [], { stdio: 'ignore' });
else {
  process.on('SIGTERM', () => {}); // Exit after libuv has reaped the cooperative child.
  spawn('herdr', [], { stdio: 'ignore' });
}`);
    const { child, exited } = f.start();
    const helpers = [];
    const alive = ({ pid, start }) => {
      const current = procStat(pid);
      return current?.start === start && !/^[ZXx]$/.test(current.state);
    };
    t.after(() => { for (const helper of helpers) if (alive(helper)) process.kill(helper.pid, 'SIGKILL'); });
    const herdrPid = join(f.home, 'herdr-pid');
    await until(() => text(herdrPid), t.signal);
    for (const name of ['reap-pid', 'herdr-pid']) {
      const pid = Number(text(join(f.home, name)));
      helpers.push({ pid, start: procStat(pid).start });
    }
    const start = performance.now();
    child.kill('SIGTERM');
    assert.deepEqual(await exited, [0, null]);
    const elapsed = Math.round(performance.now() - start);
    t.diagnostic(`SIGTERM (${stubborn ? 'escalated' : 'cooperative'}): ${elapsed} ms`);
    assert.ok(stubborn ? elapsed >= 1900 && elapsed < 3000 : elapsed < 300);
    assert.ok(helpers.every((helper) => !alive(helper)));
    assert.equal(fs.existsSync(join(f.home, 'watch.pid')), false);
    assert.equal(reaped(dir), undefined);
    assert.match(f.log(), /reap .* state=closed exit=aborted;/);
    assert.match(f.log(), /exit pid=\d+: signal=SIGTERM/);
  });
}

for (const token of [true, false]) test(`unexpected detached leader death: ${token ? 'drain verified helpers' : 'refuse unverified group'}`, async (t) => {
  const f = fixture(t), dir = f.job(closed(), {}, true);
  const env = { ...process.env, HUD_HOME: f.home, PATH: `${dirname(f.home)}/bin:${process.env.PATH}` };
  bin(f, 'herdr', `process.on('SIGTERM', () => {});
fs.writeFileSync(join(process.env.HUD_HOME, 'helper'), String(process.pid));
await delay(30000);`);
  reapStub(f, `fs.writeFileSync(join(dir, 'leader'), String(process.pid));
spawnSync('herdr', [], { stdio: 'ignore', env: ${token ? 'process.env' : "{ ...process.env, HUD_REAP_GROUP_TOKEN: 'unrelated' }"} });`);
  const run = runCommand('hud-reap', [dir], env, { killProcessGroup: true, killGraceMs: 100 });
  await until(() => text(join(f.home, 'helper')), t.signal);
  const pid = Number(text(join(f.home, 'helper'))), start = procStat(pid).start;
  const alive = () => { const s = procStat(pid); return s?.start === start && !/^[ZXx]$/.test(s.state); };
  t.after(() => { if (alive()) process.kill(pid, 'SIGKILL'); });
  process.kill(Number(text(join(dir, 'leader'))), 'SIGKILL');
  const result = await run;
  assert.equal(result.reason, 'lost');
  if (token) await until(() => !alive(), t.signal);
  else {
    assert.match(result.groupCleanupIssue, /ownership unverified; not signalling/);
    assert.ok(alive());
  }
});

for (const reason of ['timeout', 'unavailable']) {
  test(`watcher records exit=${reason} without marking the job reaped`, { timeout: 60000 }, async (t) => {
    const f = fixture(t), dir = f.job(closed(), {}, true);
    reapStub(f, 'await delay(30000);');
    const preload = reason === 'timeout' ? `
import timers from 'node:timers';
import { syncBuiltinESMExports } from 'node:module';
const raw = timers.setTimeout;
timers.setTimeout = (cb, ms, ...args) => raw(cb, ms === 135000 ? 150 : ms, ...args);
syncBuiltinESMExports();` : `// Keep the watcher itself running: only its child launch is unavailable.
process.env.HUD_HEAP_CAPS = 'off';
Object.defineProperty(process, 'execPath', { value: '/absent/synthetic-node' });`;
    const { child, exited } = f.start(preload);
    await until(() => text(join(f.home, 'watch.log')).includes(`state=closed exit=${reason};`), t.signal);
    assert.equal(reaped(dir), undefined);
    child.kill('SIGINT');
    assert.deepEqual(await exited, [0, null]);
    assert.match(f.log(), /exit pid=\d+: signal=SIGINT/);
  });
}

test('runCommand uses wall time and preserves the timeout reason through SIGKILL', async () => {
  const raw = globalThis.setTimeout;
  globalThis.setTimeout = (cb, ms, ...args) => raw(cb, ms / 20, ...args);
  try {
    const start = performance.now();
    const result = await runCommand(process.execPath, ['-e', `
process.on('SIGTERM', () => process.stdout.write('TERM observed'));
setInterval(() => {}, 1000);`], process.env, { budgetMs: 400, killGraceMs: 80 });
    assert.equal(result.reason, 'timeout');
    assert.equal(result.exitCode, null);
    assert.equal(result.stdout, 'TERM observed');
    assert.ok(performance.now() - start >= 450);
  } finally { globalThis.setTimeout = raw; }
});

test('runCommand bounds combined UTF-8 output and stops a TERM-resistant overflow', async () => {
  const result = await runCommand(process.execPath, ['-e', `
process.on('SIGTERM', () => {});
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
process.stderr.write('synthetic stderr');
process.stdout.write('€'.repeat(800_000));
setInterval(() => {}, 1000);`], process.env, { budgetMs: 3000, killGraceMs: 40 });
  const combined = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
  assert.ok(combined <= 1024 * 1024 && combined >= 1024 * 1024 - 3);
  assert.equal(result.stdout.includes('\ufffd'), false);
  assert.equal(result.reason, 'lost');
  assert.equal(result.exitCode, null);
});
