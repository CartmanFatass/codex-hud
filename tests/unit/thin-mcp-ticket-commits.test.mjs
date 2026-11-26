import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { assertLandingRecord, checkout, job, jobDir } from '../helpers/thin-mcp-land.mjs';
import { entry, rpcClient, resultValue, taskCall, taskRpc, until } from '../helpers/thin-mcp-harness.mjs';
import { findFixtureProcesses, stopChild } from '../helpers/process-cleanup.mjs';
import { takeLease } from '../../dist/roles/lease.js';

const draft = title => ({ title, what: 'Change the sample.', acceptance: ['Check the sample.'], blocked_by: [] });
const tickets = f => (op, args) => f.call('hud_tickets', { op, feature: 'sample', ...args });
const fileOf = (f, receipt) => join(f.home, 'flows', `${receipt}.json`);
const read = (f, receipt) => JSON.parse(fs.readFileSync(fileOf(f, receipt), 'utf8'));
const helpers = f => findFixtureProcesses({ root: f.root, hudHome: f.home })
  .filter(p => p.cmdline.includes('workflow-runner.mjs --ticket-edits'));
async function fast(promise) {
  const start = performance.now();
  const value = await promise;
  assert.ok(performance.now() - start < 2000, 'ticket edit reply must arrive within 2 seconds');
  return value;
}
function queued(result) {
  assert.equal(result.state, 'queued');
  assert.match(result.receipt, /^te[0-9a-f]{32}$/);
  assert.match(result.message, /No paths or item outcomes yet/);
  for (const name of ['path', 'tickets', 'updates']) assert.equal(result[name], undefined);
  return result.receipt;
}

test('a ticket add or update batch commits only its changed ticket paths and preserves hand edits', async t => {
  const f = await checkout(t, ['true']), call = tickets(f);
  const feature = join(f.main, '.scratch/sample');
  fs.mkdirSync(feature, { recursive: true });
  fs.writeFileSync(join(feature, 'spec.md'), 'Untracked planning notes.\n');
  fs.appendFileSync(join(f.main, 'tracked'), 'Staged owner change.\n');
  f.git(f.main, 'add', 'tracked');
  fs.appendFileSync(join(f.main, 'tracked'), 'Unstaged owner change.\n');
  const status = path => f.git(f.main, 'status', '--porcelain=v1', '--', path);
  const staged = f.git(f.main, 'diff', '--cached');
  const unstaged = f.git(f.main, 'diff');
  const { tickets: added, state: addState } = await fast(call('add', { tickets: ['First', 'Second', 'Third'].map(draft) }));
  assert.equal(addState, undefined);
  const paths = added.map(({ path }) => relative(f.main, path));
  const lastCommit = () => f.git(f.main, 'show', '--format=%s', '--name-only', 'HEAD').split('\n').filter(Boolean);
  assert.deepEqual(lastCommit(), ['tickets: sample/01 add', ...paths]);
  assert.equal(f.git(f.main, 'rev-list', '--count', `${f.base_head}..HEAD`), '1');
  assert.equal(status(paths[0]), '');

  // Even if a hand-edited ticket is named, it must not be swept into the HUD commit.
  fs.appendFileSync(added[2].path, '\nHand-edited comment.\n');
  const { updates, state: updateState } = await fast(call('update', { updates: [
    { ticket: 1, status: 'claimed' }, { ticket: 3, status: 'done' },
    { ticket: 2, tick: [1] }, { ticket: 1, tick: [1] },
  ] }));
  assert.equal(updateState, undefined);
  assert.deepEqual(updates.map(item => item.ok), [true, false, true, true]);
  assert.match(updates[1].error, /uncommitted or hidden changes/);
  assert.match(fs.readFileSync(added[2].path, 'utf8'), /Hand-edited comment/);
  assert.doesNotMatch(fs.readFileSync(added[2].path, 'utf8'), /\*\*Status:\*\* done/);
  assert.deepEqual(lastCommit(), ['tickets: sample/01 update', ...paths.slice(0, 2)]);
  assert.equal(f.git(f.main, 'rev-list', '--count', `${f.base_head}..HEAD`), '2');
  assert.match(f.git(f.main, 'show', `HEAD:${paths[0]}`), /\*\*Status:\*\* claimed[\s\S]*- \[x\]/);
  await call('update', { ticket: 1, tick: [1] });
  assert.equal(f.git(f.main, 'rev-list', '--count', `${f.base_head}..HEAD`), '2', 'no change means no commit');
  assert.equal(f.git(f.main, 'diff', '--cached'), staged);
  assert.equal(f.git(f.main, 'diff', '--', 'tracked'), unstaged);
  assert.match(status('.scratch/sample/spec.md'), /^\?\?/);

  // A refused commit must not strand the new ticket or its intent-to-add entry.
  const lock = join(f.main, '.git/refs/heads/base.lock'), fourth = '.scratch/sample/issues/04-fourth.md';
  fs.writeFileSync(lock, '', { flag: 'wx' });
  try {
    const { result } = await f.rpc('tools/call', { name: 'hud_tickets', arguments: {
      op: 'add', feature: 'sample', tickets: [draft('Fourth')],
    } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /cannot lock ref/);
  } finally { fs.unlinkSync(lock); }
  assert.equal(fs.existsSync(join(f.main, fourth)), false);
  assert.equal(status(fourth), '');
  assert.equal(f.git(f.main, 'diff', '--cached'), staged);
});

test('a held land lease admits multiple edits promptly, then revalidates and commits them in order', { timeout: 20000 }, async t => {
  const f = await checkout(t, ['while test ! -f "$HOME/release"; do sleep .05; done'], { after: [] });
  const call = tickets(f);
  const { tickets: [{ path }] } = await call('add', { tickets: [draft('First')] });
  const rel = relative(f.main, path), receipt = join(jobDir(f), 'job.json');
  fs.writeFileSync(receipt, JSON.stringify({ ...JSON.parse(fs.readFileSync(receipt)), ticket: 'sample/01' }));
  await call('update', { ticket: 1, status: 'claimed', owner_try: true });
  const base = f.git(f.main, 'rev-parse', 'HEAD');
  assert.equal(f.git(f.main, 'status', '--porcelain', '--', rel), '');
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).step.startsWith('gate[1]'), t.signal);
  const before = fs.readFileSync(path, 'utf8');
  const add = queued(await fast(call('add', { tickets: [draft('Second')] })));
  const update = queued(await fast(call('update', { updates: [
    { ticket: 1, status: 'done' }, { ticket: 2, tick: [1] },
  ] })));
  const missing = queued(await fast(call('update', { ticket: 3, status: 'done' })));
  assert.equal(queued(await f.call('hud_read', { job: add })), add);
  assert.equal(fs.statSync(fileOf(f, add)).mode & 0o777, 0o600);
  const second = '.scratch/sample/issues/02-second.md';
  assert.equal(fs.existsSync(join(f.main, second)), false);
  assert.equal(fs.readFileSync(path, 'utf8'), before, 'queued updates do not write during land');
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), base);

  fs.writeFileSync(join(f.env.HOME, 'release'), '');
  await until(() => read(f, missing).state === 'failed', t.signal);
  const added = await f.call('hud_read', { job: add });
  assert.equal(added.state, 'completed');
  assert.deepEqual(added.tickets, [{ number: 2, path: join(f.main, second) }]);
  for (const id of [add, update, missing]) assert.ok(added.changes.some(line => line.includes(id)));
  const updated = await f.call('hud_read', { job: update });
  assert.equal(updated.state, 'completed');
  assert.deepEqual(updated.updates, [
    { feature: 'sample', ok: true, number: 1, path },
    { feature: 'sample', ok: true, number: 2, path: join(f.main, second) },
  ]);
  assert.equal(updated.changes, undefined, 'notices are claimed once');
  const error = await f.call('hud_read', { job: missing });
  assert.equal(error.ok, false);
  assert.equal(error.state, 'failed');
  assert.match(error.error, /unknown ticket: 3/);
  const done = f.flowState(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  const show = rev => f.git(f.main, 'show', '--format=%s', '--name-only', rev).split('\n').filter(Boolean);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD~2'), done.landed_sha);
  assert.deepEqual(show('HEAD^'), ['tickets: sample/02 add', second]);
  assert.deepEqual(show('HEAD'), ['tickets: sample/01 update', rel, second]);
  assert.match(f.git(f.main, 'show', `${done.landed_sha}:${rel}`), /\*\*Status:\*\* ready-for-human/);
  assert.match(f.git(f.main, 'show', `HEAD:${rel}`), /\*\*Status:\*\* done/);
  assert.match(f.git(f.main, 'show', `HEAD:${second}`), /- \[x\]/);
  assertLandingRecord(f, rel, base, done.landed_sha);
  assert.equal(f.git(f.main, 'status', '--porcelain', '--', rel, second), '');
});

test('a task-capable caller receives a queued edit completion without polling', { timeout: 15000 }, async t => {
  const f = await checkout(t, ['true']), rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const lease = { cwd: f.main, home: f.home, holder: 'synthetic-land' };
  assert.deepEqual(await takeLease({ name: 'main-checkout', wait_s: 0 }, lease), { granted: true });
  const receipt = queued(resultValue(await taskCall(rpc, 'hud_tickets', { op: 'add', feature: 'sample', tickets: [draft('First')] })));
  await takeLease({ name: 'main-checkout', release: true }, lease);
  const notices = () => f.commands().filter(({ command, args }) => command === 'herdr' && args[0] === 'agent' && args[1] === 'prompt'
    && args[2] === f.env.HERDR_PANE_ID && args[3].includes(receipt));
  await until(() => notices().length > 0, t.signal);
  const result = resultValue(await taskCall(rpc, 'hud_read', { job: receipt }));
  assert.equal(result.state, 'completed');
  assert.equal(result.changes, undefined);
  assert.equal(notices().length, 1);
});

test('the MCP re-drives a helper killed during land without another submission or read', { timeout: 20000 }, async t => {
  const f = await checkout(t, ['while test ! -f "$HOME/release"; do sleep .05; done'], { after: [] });
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).step.startsWith('gate[1]'), t.signal);
  const receipt = queued(await tickets(f)('add', { tickets: [draft('First')] }));
  const helper = () => helpers(f)[0];
  await until(helper, t.signal);
  process.kill(helper().pid, 'SIGKILL');
  assert.equal(read(f, receipt).state, 'queued');
  fs.writeFileSync(join(f.env.HOME, 'release'), '');

  await until(() => read(f, receipt).state === 'completed', t.signal);
  const result = await f.call('hud_read', { job: receipt });
  assert.equal(result.state, 'completed');
  assert.equal(f.flowState(flow).state, 'completed');
  const path = relative(f.main, result.tickets[0].path);
  assert.match(f.git(f.main, 'show', `HEAD:${path}`), /First/);
  assert.match(f.git(f.main, 'log', '-1', '--format=%B'), new RegExp(`HUD-Ticket-Edit: ${receipt}`));
});

for (const committed of [false, true]) test(committed
  ? 'after the retry bound, a committed applying receipt is reconciled without rewriting tickets'
  : 'after the retry bound, a queued edit fails with the helper error and sends its completion notice', { timeout: 15000 }, async t => {
  // Inject failures only into the detached helper, before it imports dist. In the
  // applying case let the first helper commit, then lose its terminal receipt write.
  const preload = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
if (process.argv[2] === '--ticket-edits') {
  const log = process.env.HOME + '/ticket-helper-attempts';
  const first = !fs.existsSync(log);
  fs.appendFileSync(log, 'attempt\\n');
  if (${committed} && first) {
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (/\\/te[0-9a-f]{32}\\.json$/.test(to) && JSON.parse(fs.readFileSync(from)).state === 'completed') process.exit(74);
      return rename(from, to);
    };
    syncBuiltinESMExports();
  } else {
    process.stderr.write('Synthetic helper import failure\\n', () => process.exit(73));
  }
}`;
  const f = await checkout(t, ['true'], {
    probe: `process.env.NODE_OPTIONS += ${JSON.stringify(' --import=data:text/javascript,' + encodeURIComponent(preload))};`,
  });
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const lease = { cwd: f.main, home: f.home, holder: 'synthetic-land' };
  assert.deepEqual(await takeLease({ name: 'main-checkout', wait_s: 0 }, lease), { granted: true });
  const receipt = queued(resultValue(await taskCall(rpc, 'hud_tickets', { op: 'add', feature: 'sample', tickets: [draft('First')] })));
  await takeLease({ name: 'main-checkout', release: true }, lease);

  const notices = () => f.commands().filter(({ command, args }) => command === 'herdr' && args[0] === 'agent' && args[1] === 'prompt'
    && args[2] === f.env.HERDR_PANE_ID && args[3].includes(receipt));
  await until(() => notices().length > 0, t.signal);
  const result = resultValue(await taskCall(rpc, 'hud_read', { job: receipt }));
  const state = committed ? 'completed' : 'failed';
  assert.equal(result.state, state);
  assert.match(notices()[0].args[3], new RegExp(`Ticket add ${state}`));
  assert.equal(notices().length, 1);
  assert.equal(result.changes, undefined);
  assert.equal(fs.readFileSync(join(f.env.HOME, 'ticket-helper-attempts'), 'utf8'), 'attempt\n'.repeat(3));
  assert.equal(f.git(f.main, 'rev-list', '--count', `${f.base_head}..HEAD`), committed ? '1' : '0');
  if (committed) {
    assert.match(f.git(f.main, 'log', '-1', '--format=%B'), new RegExp(`HUD-Ticket-Edit: ${receipt}`));
    assert.deepEqual(fs.readdirSync(join(f.main, '.scratch/sample/issues')), ['01-first.md']);
  } else {
    assert.match(result.error, /after 3 attempts: exited with code 73: Synthetic helper import failure/);
    assert.equal(fs.existsSync(join(f.main, '.scratch/sample/issues')), false);
  }
});

test('MCP startup drains pending ticket receipts and reconciles a committed receipt without a duplicate', { timeout: 20000 }, async t => {
  const f = await checkout(t, ['true'], { inHerdr: false }), call = tickets(f);
  const lease = { cwd: f.main, home: f.home, holder: 'synthetic-land' };
  assert.deepEqual(await takeLease({ name: 'main-checkout', wait_s: 0 }, lease), { granted: true });
  const one = queued(await call('add', { tickets: [draft('First')] }));
  const two = queued(await call('add', { tickets: [{ ...draft('Second'), blocked_by: [1] }] }));
  await f.stopMcp();
  for (const { pid } of helpers(f)) process.kill(pid, 'SIGKILL');
  await until(() => helpers(f).length === 0, t.signal);
  assert.equal(read(f, one).state, 'queued');
  assert.equal(read(f, two).state, 'queued');
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.base_head);

  async function restart() {
    const child = spawn(process.execPath, [entry], { cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'inherit'] });
    const exited = once(child, 'exit');
    const stop = () => stopChild(child, exited, { closeStdin: true });
    f.onCleanup(stop);
    const rpc = rpcClient(child);
    assert.ok((await rpc('initialize')).result);
    return { stop, read: async job => resultValue((await rpc('tools/call', { name: 'hud_read', arguments: { job } })).result) };
  }
  const first = await restart();
  await takeLease({ name: 'main-checkout', release: true }, lease);
  await until(() => read(f, two).state === 'completed', t.signal);
  const firstResult = await first.read(one);
  assert.equal(firstResult.tickets[0].number, 1);
  assert.equal((await first.read(two)).tickets[0].number, 2);
  assert.equal(f.git(f.main, 'log', '--reverse', '--format=%s', `${f.base_head}..HEAD`), 'tickets: sample/01 add\ntickets: sample/02 add');
  const head = f.git(f.main, 'rev-parse', 'HEAD');
  await first.stop();
  await until(() => helpers(f).length === 0, t.signal);

  // Recreate the last durable receipt state if the helper died just after the commit.
  const written = read(f, one);
  fs.writeFileSync(fileOf(f, one), JSON.stringify({ ...written, state: 'applying' }));
  const recovered = await restart();
  await until(() => read(f, one).state === 'completed', t.signal);
  assert.deepEqual((await recovered.read(one)).tickets, firstResult.tickets);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(fs.readdirSync(join(f.main, '.scratch/sample/issues')).sort(), ['01-first.md', '02-second.md']);
});
