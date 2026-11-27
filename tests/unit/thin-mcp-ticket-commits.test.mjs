import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { assertLandingRecord, checkout, job, jobDir, settle } from '../helpers/thin-mcp-land.mjs';
import { entry, rpcClient, resultValue, taskCall, taskRpc, until } from '../helpers/thin-mcp-harness.mjs';
import { findFixtureProcesses, stopChild } from '../helpers/process-cleanup.mjs';
import { setupWorkflowProject } from '../helpers/workflow-ticket-project.mjs';
import { takeLease } from '../../dist/roles/lease.js';
import { listColdArchive, readColdJobText } from '../../dist/roles/cold-archive.js';
import { cancelTicketQueue } from '../../dist/mcp/ticket-queue-state.js';
import { isProcAlive, procStat } from '../../dist/utils/proc.js';
import { wakeWorkflow } from '../../dist/workflows/wake.js';
import { withTicketStoreLock } from '../../dist/tickets/store.js';

const seed = '.scratch/sample/issues/01-existing.md';
async function legacyCheckout(t, gate, options) {
  const f = await checkout(t, gate, options);
  fs.mkdirSync(join(f.main, '.scratch/sample/issues'), { recursive: true });
  fs.writeFileSync(join(f.main, seed), '# 01: Existing\n\n**Status:** ready-for-agent\n**Blocked by:** none\n\n**What to build:** Change it.\n\n- [ ] Check it.\n');
  f.git(f.main, 'add', seed);
  f.git(f.main, 'commit', '-qm', 'Seed legacy ticket');
  return { ...f, seedHead: f.git(f.main, 'rev-parse', 'HEAD') };
}

function setLandTicket(f, ticket) {
  const receipt = join(jobDir(f), 'job.json');
  fs.writeFileSync(receipt, JSON.stringify({ ...JSON.parse(fs.readFileSync(receipt)), ticket }));
}

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

test('a Markdown ticket add or update batch commits only its changed ticket paths and preserves hand edits', async t => {
  const f = await legacyCheckout(t, ['true']), call = tickets(f);
  const feature = join(f.main, '.scratch/sample');
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
  assert.deepEqual(lastCommit(), ['tickets: sample/02 add', ...paths]);
  assert.equal(f.git(f.main, 'rev-list', '--count', `${f.seedHead}..HEAD`), '1');
  assert.equal(status(paths[0]), '');

  // Even if a hand-edited ticket is named, it must not be swept into the HUD commit.
  fs.appendFileSync(added[2].path, '\nHand-edited comment.\n');
  const { updates, state: updateState } = await fast(call('update', { updates: [
    { ticket: 2, status: 'claimed' }, { ticket: 4, status: 'done' },
    { ticket: 3, tick: [1] }, { ticket: 2, tick: [1] },
  ] }));
  assert.equal(updateState, undefined);
  assert.deepEqual(updates.map(item => item.ok), [true, false, true, true]);
  assert.match(updates[1].error, /uncommitted or hidden changes/);
  assert.match(fs.readFileSync(added[2].path, 'utf8'), /Hand-edited comment/);
  assert.doesNotMatch(fs.readFileSync(added[2].path, 'utf8'), /\*\*Status:\*\* done/);
  assert.deepEqual(lastCommit(), ['tickets: sample/02 update', ...paths.slice(0, 2)]);
  assert.equal(f.git(f.main, 'rev-list', '--count', `${f.seedHead}..HEAD`), '2');
  assert.match(f.git(f.main, 'show', `HEAD:${paths[0]}`), /\*\*Status:\*\* claimed[\s\S]*- \[x\]/);
  await call('update', { ticket: 2, tick: [1] });
  assert.equal(f.git(f.main, 'rev-list', '--count', `${f.seedHead}..HEAD`), '2', 'no change means no commit');
  assert.equal(f.git(f.main, 'diff', '--cached'), staged);
  assert.equal(f.git(f.main, 'diff', '--', 'tracked'), unstaged);
  assert.match(status('.scratch/sample/spec.md'), /^\?\?/);

  // A refused commit must not strand the new ticket or its intent-to-add entry.
  const lock = join(f.main, '.git/refs/heads/base.lock'), fourth = '.scratch/sample/issues/05-fourth.md';
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

test('updating existing Markdown does not take the tickets lock and the ticket still lands cleanly', { timeout: 20_000 }, async t => {
  const f = await legacyCheckout(t, ['true']);
  setLandTicket(f, 'sample/01');
  // A reverse lock order would make this call wait on the tickets lock we hold.
  await withTicketStoreLock(f.main, async () => {
    const updated = await fast(tickets(f)('update', { ticket: 1, status: 'claimed' }));
    assert.deepEqual(updated, { ok: true, number: 1, path: join(f.main, seed) });
  });
  const base = f.git(f.main, 'rev-parse', 'HEAD');
  assert.equal(f.git(f.main, 'log', '-1', '--format=%s'), 'tickets: sample/01 update');
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['completed', 'failed'].includes(f.flowState(flow).state), t.signal);
  const done = f.flowState(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assertLandingRecord(f, seed, base, done.landed_sha);
  assert.equal(f.git(f.main, 'status', '--porcelain', '--', seed), '');
});

test('land records a committed Markdown add and then drains queued Markdown edits in order', { timeout: 20000 }, async t => {
  const f = await legacyCheckout(t, ['while test ! -f "$HOME/release"; do sleep .05; done'], { after: [] });
  const call = tickets(f);
  const { tickets: [{ number, path }] } = await call('add', { tickets: [{ ...draft('First'), owner_try: true }] });
  const rel = relative(f.main, path);
  assert.equal(number, 2);
  assert.deepEqual(f.git(f.main, 'show', '--format=%s', '--name-only', 'HEAD').split('\n').filter(Boolean), ['tickets: sample/02 add', rel]);
  setLandTicket(f, 'sample/02');
  const base = f.git(f.main, 'rev-parse', 'HEAD');
  assert.equal(f.git(f.main, 'status', '--porcelain', '--', rel), '');
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).step.startsWith('gate[1]'), t.signal);
  const before = fs.readFileSync(path, 'utf8');
  const add = queued(await fast(call('add', { tickets: [draft('Second')] })));
  const update = queued(await fast(call('update', { updates: [
    { ticket: 2, status: 'done' }, { ticket: 3, tick: [1] },
  ] })));
  const missing = queued(await fast(call('update', { ticket: 4, status: 'done' })));
  assert.equal(queued(await f.call('hud_read', { job: add })), add);
  assert.equal(fs.statSync(fileOf(f, add)).mode & 0o777, 0o600);
  const second = '.scratch/sample/issues/03-second.md';
  assert.equal(fs.existsSync(join(f.main, second)), false);
  assert.equal(fs.readFileSync(path, 'utf8'), before, 'queued updates do not write during land');
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), base);

  fs.writeFileSync(join(f.env.HOME, 'release'), '');
  await until(() => read(f, missing).state === 'failed', t.signal);
  const added = await f.call('hud_read', { job: add });
  assert.equal(added.state, 'completed');
  assert.deepEqual(added.tickets, [{ number: 3, path: join(f.main, second) }]);
  for (const id of [add, update, missing]) assert.ok(added.changes.some(line => line.includes(id)));
  const updated = await f.call('hud_read', { job: update });
  assert.equal(updated.state, 'completed');
  assert.deepEqual(updated.updates, [
    { feature: 'sample', ok: true, number: 2, path },
    { feature: 'sample', ok: true, number: 3, path: join(f.main, second) },
  ]);
  assert.equal(updated.changes, undefined, 'notices are claimed once');
  const error = await f.call('hud_read', { job: missing });
  assert.equal(error.ok, false);
  assert.equal(error.state, 'failed');
  assert.match(error.error, /unknown ticket: 4/);
  const done = f.flowState(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  const show = rev => f.git(f.main, 'show', '--format=%s', '--name-only', rev).split('\n').filter(Boolean);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD~2'), done.landed_sha);
  assert.deepEqual(show('HEAD^'), ['tickets: sample/03 add', second]);
  assert.deepEqual(show('HEAD'), ['tickets: sample/02 update', rel, second]);
  assert.match(f.git(f.main, 'show', `${done.landed_sha}:${rel}`), /\*\*Status:\*\* ready-for-human/);
  assert.match(f.git(f.main, 'show', `HEAD:${rel}`), /\*\*Status:\*\* done/);
  assert.match(f.git(f.main, 'show', `HEAD:${second}`), /- \[x\]/);
  assertLandingRecord(f, rel, base, done.landed_sha);
  assert.equal(f.git(f.main, 'status', '--porcelain', '--', rel, second), '');
});

test('a task-capable caller receives a queued edit completion without polling', { timeout: 15000 }, async t => {
  const f = await legacyCheckout(t, ['true']), rpc = taskRpc(f.rpc);
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

test('Markdown ticket edit admission at the receipt limit archives the oldest settled receipt and keeps it on failure', { timeout: 15000 }, async t => {
  const f = await legacyCheckout(t, ['true']);
  const flows = join(f.home, 'flows');
  fs.mkdirSync(flows, { recursive: true });
  const id = seq => `te${seq.toString(16).padStart(16, '0')}${'0'.repeat(16)}`;
  for (let seq = 1; seq <= 128; seq++) {
    fs.writeFileSync(fileOf(f, id(seq)), JSON.stringify({
      receipt: id(seq), cwd: f.main, checkout: f.main, project: f.main, pane: 'synthetic-other-pane', origin: f.main,
      op: 'add', state: 'completed', result: { ok: true },
    }) + '\n');
  }
  const oldest = fileOf(f, id(1)), sidecars = [`${oldest}.noticed`, `${oldest}.observed`];
  for (const file of sidecars) fs.writeFileSync(file, `Synthetic ${file.split('.').at(-1)} marker.\n`);
  const original = [oldest, ...sidecars].map(file => [file, fs.readFileSync(file)]);
  const count = () => fs.readdirSync(flows).filter(name => /^te[0-9a-f]{32}\.json$/.test(name)).length;
  const blocker = join(f.home, 'archive', 'cold');
  fs.mkdirSync(join(f.home, 'archive'), { recursive: true });
  fs.writeFileSync(blocker, 'Block the cold directory.\n');
  const args = { op: 'add', feature: 'sample', tickets: [draft('First')] };
  const lease = { cwd: f.main, home: f.home, holder: 'synthetic-land' };
  assert.deepEqual(await takeLease({ name: 'main-checkout', wait_s: 0 }, lease), { granted: true });
  let admitted;
  try {
    const { result } = await f.rpc('tools/call', { name: 'hud_tickets', arguments: args });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Ticket edit receipt limit: could not archive and evict/);
    for (const [file, bytes] of original) assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(count(), 128, 'refused admission does not add a receipt');

    fs.unlinkSync(blocker);
    admitted = queued(await f.call('hud_tickets', args));
    assert.equal(count(), 128);
    assert.equal(read(f, id(2)).state, 'completed', 'only the oldest receipt was evicted');
    const archive = await readColdJobText(f.home, id(1));
    assert.ok(listColdArchive(f.home).some(item => item.id === id(1) && item.text));
    for (const [file, bytes] of original) {
      assert.equal(fs.existsSync(file), false);
      assert.deepEqual(archive?.entries.get(basename(file)), bytes);
    }
  } finally {
    await takeLease({ name: 'main-checkout', release: true }, lease);
  }
  await until(() => read(f, admitted).state === 'completed', t.signal);
});

test('the MCP re-drives a helper killed during land without another submission or read', { timeout: 20000 }, async t => {
  const f = await legacyCheckout(t, ['while test ! -f "$HOME/release"; do sleep .05; done'], { after: [] });
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
  const f = await legacyCheckout(t, ['true'], {
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
  assert.equal(f.git(f.main, 'rev-list', '--count', `${f.seedHead}..HEAD`), committed ? '1' : '0');
  if (committed) {
    assert.match(f.git(f.main, 'log', '-1', '--format=%B'), new RegExp(`HUD-Ticket-Edit: ${receipt}`));
    assert.deepEqual(fs.readdirSync(join(f.main, '.scratch/sample/issues')).sort(), ['01-existing.md', '02-first.md']);
  } else {
    assert.match(result.error, /after 3 attempts: exited with code 73: Synthetic helper import failure/);
    assert.deepEqual(fs.readdirSync(join(f.main, '.scratch/sample/issues')), ['01-existing.md']);
  }
});

test('MCP startup drains pending ticket receipts and reconciles a committed receipt without a duplicate', { timeout: 20000 }, async t => {
  const f = await legacyCheckout(t, ['true'], { inHerdr: false }), call = tickets(f);
  const lease = { cwd: f.main, home: f.home, holder: 'synthetic-land' };
  assert.deepEqual(await takeLease({ name: 'main-checkout', wait_s: 0 }, lease), { granted: true });
  const one = queued(await call('add', { tickets: [draft('First')] }));
  const two = queued(await call('add', { tickets: [{ ...draft('Second'), blocked_by: [2] }] }));
  await f.stopMcp();
  for (const { pid } of helpers(f)) process.kill(pid, 'SIGKILL');
  await until(() => helpers(f).length === 0, t.signal);
  assert.equal(read(f, one).state, 'queued');
  assert.equal(read(f, two).state, 'queued');
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.seedHead);

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
  assert.equal(firstResult.tickets[0].number, 2);
  assert.equal((await first.read(two)).tickets[0].number, 3);
  assert.equal(f.git(f.main, 'log', '--reverse', '--format=%s', `${f.seedHead}..HEAD`), 'tickets: sample/02 add\ntickets: sample/03 add');
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
  assert.deepEqual(fs.readdirSync(join(f.main, '.scratch/sample/issues')).sort(), ['01-existing.md', '02-first.md', '03-second.md']);
});

function makeWorkerDir(f, id, role, cwd = f.main) {
  const dir = join(f.home, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({
    job: id, role, cwd, project_root: cwd, created_at: new Date().toISOString(),
  }));
  return dir;
}

async function startWorkerMcp(f, dir, { mcpEntry = entry, cwd = f.main } = {}) {
  const child = spawn(process.execPath, [mcpEntry], {
    cwd, env: { ...f.env, HUD_JOB_DIR: dir }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = once(child, 'exit');
  const stop = () => stopChild(child, exited, { closeStdin: true });
  f.onCleanup(stop);
  const rpc = rpcClient(child);
  assert.ok((await rpc('initialize')).result);
  return {
    pid: child.pid,
    rpc,
    stop,
    call: async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result,
  };
}

test('lead MCP resumes ticket edit supervision across hot swap and cold start with admission parity', { timeout: 25000 }, async t => {
  const copy = fs.mkdtempSync(join(tmpdir(), 'hud-lead-ticket-reload-'));
  for (const name of ['dist', 'packages/hud-mcp', 'scripts/dist-lock.mjs', 'package.json'])
    fs.cpSync(resolve(name), join(copy, name), { recursive: true });
  fs.symlinkSync(resolve('node_modules'), join(copy, 'node_modules'));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));

  const f = await legacyCheckout(t, ['true'], { inHerdr: false });
  await f.stopMcp();
  fs.chmodSync(f.home, 0o700);
  const leadDir = makeWorkerDir(f, 'j00000000000001a1', 'lead');
  const impDir = makeWorkerDir(f, 'j00000000000001b1', 'imp');
  const lease = { cwd: f.main, home: f.home, holder: 'synthetic-land' };
  const mcpEntry = join(copy, 'packages/hud-mcp/bin/hud-mcp.mjs');
  const generation = pid => JSON.parse(fs.readFileSync(join(f.home, `generations/${pid}.json`), 'utf8')).stamp;

  // 1. Hot swap preserves supervision for a lead-admitted receipt.
  assert.deepEqual(await takeLease({ name: 'main-checkout', wait_s: 0 }, lease), { granted: true });
  const lead = await startWorkerMcp(f, leadDir, { mcpEntry });
  const initialStamp = generation(lead.pid);
  const first = queued(resultValue(await lead.call('hud_tickets', { op: 'add', feature: 'sample', tickets: [draft('HotSwap')] })));
  await until(() => helpers(f).length > 0, t.signal);

  // Trigger a hot swap in the private copy before killing the detached helper.
  const index = join(copy, 'dist/index.js');
  const nextTime = new Date(Date.now() + 2000);
  fs.utimesSync(index, nextTime, nextTime);
  assert.ok((await lead.rpc('ping')).result);
  await until(() => generation(lead.pid) !== initialStamp, t.signal);

  for (const { pid } of helpers(f)) process.kill(pid, 'SIGKILL');
  assert.equal(read(f, first).state, 'queued');
  await takeLease({ name: 'main-checkout', release: true }, lease);

  await until(() => read(f, first).state === 'completed', t.signal);
  assert.match(f.git(f.main, 'log', '-1', '--format=%B'), new RegExp(`HUD-Ticket-Edit: ${first}`));
  await lead.stop();
  await until(() => helpers(f).length === 0, t.signal);

  // 2. Cold start matches admission eligibility: imp workers do not resume; lead workers do.
  assert.deepEqual(await takeLease({ name: 'main-checkout', wait_s: 0 }, lease), { granted: true });
  const admitter = await startWorkerMcp(f, leadDir);
  const second = queued(resultValue(await admitter.call('hud_tickets', { op: 'add', feature: 'sample', tickets: [draft('ColdStart')] })));
  await admitter.stop();
  for (const { pid } of helpers(f)) process.kill(pid, 'SIGKILL');
  await until(() => helpers(f).length === 0, t.signal);
  await takeLease({ name: 'main-checkout', release: true }, lease);

  const imp = await startWorkerMcp(f, impDir);
  const denied = await imp.call('hud_tickets', { op: 'add', feature: 'sample', tickets: [draft('Denied')] });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /worker_cannot_dispatch/);
  await delay(300);
  assert.equal(read(f, second).state, 'queued');
  assert.equal(helpers(f).length, 0);
  await imp.stop();

  const coldLead = await startWorkerMcp(f, leadDir);
  await until(() => read(f, second).state === 'completed', t.signal);
  assert.match(f.git(f.main, 'log', '-1', '--format=%B'), new RegExp(`HUD-Ticket-Edit: ${second}`));
  const head = f.git(f.main, 'rev-parse', 'HEAD');
  await coldLead.stop();
  await until(() => helpers(f).length === 0, t.signal);

  // 3. Cold-started lead reconciles a committed applying receipt without re-applying.
  const committed = read(f, second);
  fs.writeFileSync(fileOf(f, second), JSON.stringify({ ...committed, state: 'applying' }));
  const reconcilingLead = await startWorkerMcp(f, leadDir);
  await until(() => read(f, second).state === 'completed', t.signal);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), head);
  await reconcilingLead.stop();
});

test('queue workflow runner re-drives a lead-admitted receipt after lead exit with no main MCP, then stops when the run ends', { timeout: 30000 }, async t => {
  const f = await setupWorkflowProject(t, { count: 1 });
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'sample', max_parallel: 1, cwd: f.root });
  await f.jobs(flow, 1);
  const runnerPid = f.flow(flow).pid;
  const runnerStart = f.flow(flow).start;
  assert.ok(runnerPid && isProcAlive(runnerPid, runnerStart), 'queue workflow runner must be alive');

  // Stop the main MCP so only the detached queue workflow runner remains alive.
  await f.stopMcp();

  const leadDir = makeWorkerDir(f, 'j00000000000001e1', 'lead', f.root);
  const lease = { cwd: f.root, home: f.home, holder: 'synthetic-land' };
  assert.deepEqual(await takeLease({ name: 'main-checkout', wait_s: 0 }, lease), { granted: true });

  const lead = await startWorkerMcp(f, leadDir, { cwd: f.root });
  const receipt = queued(resultValue(await lead.call('hud_tickets', {
    op: 'add', feature: 'sample', tickets: [draft('LeadQueued')],
  })));
  await until(() => helpers(f).length > 0, t.signal);

  // Lead reports and closes; its MCP exits, then the detached helper is killed.
  await lead.stop();
  for (const { pid } of helpers(f)) process.kill(pid, 'SIGKILL');
  assert.equal(read(f, receipt).state, 'queued');

  // Releasing the lease settles the receipt via the live queue runner with no further RPC.
  await takeLease({ name: 'main-checkout', release: true }, lease);
  await until(() => read(f, receipt).state === 'completed', t.signal);
  const settled = read(f, receipt);
  assert.equal(settled.state, 'completed');
  const addedPath = relative(f.root, settled.result.tickets[0].path);
  assert.match(f.git(f.root, 'show', `HEAD:${addedPath}`), /LeadQueued/);
  assert.match(f.git(f.root, 'log', '-1', '--format=%B'), new RegExp(`HUD-Ticket-Edit: ${receipt}`));
  const head = f.git(f.root, 'rev-parse', 'HEAD');

  // An applying receipt is still decided by the commit-marker check and never applied twice.
  await until(() => helpers(f).length === 0, t.signal);
  const tmp = `${fileOf(f, receipt)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...settled, state: 'applying' }));
  fs.renameSync(tmp, fileOf(f, receipt));
  await until(() => read(f, receipt).state === 'completed', t.signal);
  assert.equal(f.git(f.root, 'rev-parse', 'HEAD'), head);
  await until(() => helpers(f).length === 0, t.signal);

  // A receipt for another project is not touched by this queue runner or its lead MCP.
  const otherReceipt = 'te000000000000ffff0000000000000001';
  fs.writeFileSync(fileOf(f, otherReceipt), JSON.stringify({
    receipt: otherReceipt, cwd: '/nonexistent/other', checkout: '/nonexistent/other', project: '/nonexistent/other',
    pane: null, origin: '/nonexistent/other', op: 'add', state: 'queued', args: { op: 'add', feature: 'sample', tickets: [] },
  }));

  // When the queue run ends while a ticket edit is active, the runner stops its supervisor and exits cleanly.
  assert.deepEqual(await takeLease({ name: 'main-checkout', wait_s: 0 }, lease), { granted: true });
  try {
    const secondLead = await startWorkerMcp(f, leadDir, { cwd: f.root });
    const pending = queued(resultValue(await secondLead.call('hud_tickets', {
      op: 'add', feature: 'sample', tickets: [draft('AfterEnd')],
    })));
    await secondLead.stop();
    await until(() => helpers(f).length > 0, t.signal);
    const q = f.flow(flow);
    cancelTicketQueue(f.home, q);
    wakeWorkflow(f.home, q);
    await until(() => f.flow(flow).state === 'cancelled', t.signal);
    await until(() => !isProcAlive(runnerPid, runnerStart), t.signal);
    assert.equal(read(f, otherReceipt).state, 'queued');
    assert.equal(read(f, pending).state, 'queued');
  } finally {
    await takeLease({ name: 'main-checkout', release: true }, lease);
  }
});

function addLandJob(f, id, name, start = f.base_head) {
  const label = `${name}-${id.slice(-6)}`, root = join(`${f.main}-wt`, label), branch = `wt/${label}`;
  f.git(f.main, 'worktree', 'add', '-qb', branch, root, start);
  fs.writeFileSync(join(root, name), `${name}\n`);
  f.git(root, 'add', name);
  f.git(root, 'commit', '-qm', name);
  const dir = jobDir(f, id);
  fs.mkdirSync(dir, { recursive: true });
  const receipt = JSON.parse(fs.readFileSync(join(jobDir(f), 'job.json'), 'utf8'));
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({
    ...receipt, job: id, cwd: root, worktree: { main_root: f.main, root, branch, base_head: start },
  }));
  settle(f, id, `Synthetic ${name} result.`);
  return { id, root, branch, baseHead: start };
}

function drainPauseProbe(marker = 'drain-entered', release = 'drain-release') {
  const preload = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
if (process.argv[1]?.includes('workflow-runner') && process.argv[2] !== '--ticket-edits') {
  const rename = fs.renameSync;
  const sab = new Int32Array(new SharedArrayBuffer(4));
  fs.renameSync = (from, to) => {
    const out = rename(from, to);
    const entered = process.env.HOME + '/' + ${JSON.stringify(marker)};
    const go = process.env.HOME + '/' + ${JSON.stringify(release)};
    if (/\\/te[0-9a-f]{32}\\.json$/.test(to) && !fs.existsSync(entered)) {
      try {
        if (JSON.parse(fs.readFileSync(to, 'utf8')).state === 'applying') {
          fs.writeFileSync(entered, to);
          const deadline = performance.now() + 15000;
          while (!fs.existsSync(go) && performance.now() < deadline) Atomics.wait(sab, 0, 0, 20);
        }
      } catch {}
    }
    return out;
  };
  syncBuiltinESMExports();
}`;
  return `process.env.NODE_OPTIONS += ${JSON.stringify(' --import=data:text/javascript,' + encodeURIComponent(preload))};`;
}

function writeQueuedFlow(f, templateFlow, addedJob, createdAt = '2020-01-01T00:00:00.000Z') {
  const base = f.flowState(templateFlow);
  const flowId = `f${addedJob.id.slice(1)}`;
  const source = f.git(addedJob.root, 'rev-parse', 'HEAD');
  const queuedFlow = {
    flow: flowId,
    job: addedJob.id,
    pane: base.pane,
    task: false,
    wt: { main_root: f.main, root: addedJob.root, branch: addedJob.branch, base_head: addedJob.baseHead },
    config: base.config,
    source_sha: source,
    pid: process.pid,
    start: procStat(process.pid).start,
    state: 'queued',
    step: 'main-checkout lease',
    created_at: createdAt,
    updated_at: createdAt,
    step_started_at: createdAt,
  };
  fs.writeFileSync(join(f.home, 'flows', `${flowId}.json`), JSON.stringify(queuedFlow) + '\n', { mode: 0o600 });
  return flowId;
}

test('back-to-back lands drain edits queued during the first gate between the two lands without a gate rerun', { timeout: 30000 }, async t => {
  const f = await legacyCheckout(t, [`if test ! -f "$HOME/started"; then
    touch "$HOME/started"; while test ! -f "$HOME/release"; do sleep .05; done
  fi
  git rev-parse HEAD >> "$HOME/gate-heads"`], { after: [] });
  const call = tickets(f);
  const second = addLandJob(f, 'j0000000000000456', 'beta');

  const { flow: flow1 } = await f.call('hud_land', { job });
  await until(() => fs.existsSync(join(f.env.HOME, 'started')), t.signal);
  const { flow: flow2 } = await f.call('hud_land', { job: second.id });
  assert.equal(f.flowState(flow2).state, 'queued');

  const add = queued(await fast(call('add', { tickets: [draft('Between')] })));
  const update = queued(await fast(call('update', { ticket: 2, status: 'claimed' })));
  assert.equal(f.flowState(flow1).step.startsWith('gate[1]'), true, 'running land is not interrupted mid-gate');
  assert.equal(read(f, add).state, 'queued');
  assert.equal(read(f, update).state, 'queued');
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.seedHead);

  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => f.flowState(flow1).state === 'completed' && f.flowState(flow2).state === 'completed', t.signal);
  const done1 = f.flowState(flow1), done2 = f.flowState(flow2);
  assert.equal(read(f, add).state, 'completed');
  assert.equal(read(f, update).state, 'completed');

  const subjects = f.git(f.main, 'log', '--reverse', '--format=%s', `${f.seedHead}..base`).split('\n');
  assert.deepEqual(subjects, ['first', 'second', 'tickets: sample/02 add', 'tickets: sample/02 update', 'beta']);
  const editTip = f.git(f.main, 'rev-parse', `${done2.landed_sha}^`);
  assert.equal(f.git(f.main, 'rev-parse', `${done2.landed_sha}~3`), done1.landed_sha);
  assert.match(f.git(f.main, 'log', '-1', '--format=%B', `${done2.landed_sha}~2`), new RegExp(`HUD-Ticket-Edit: ${add}`));
  assert.match(f.git(f.main, 'log', '-1', '--format=%B', editTip), new RegExp(`HUD-Ticket-Edit: ${update}`));

  // The waiting land starts from the post-drain tip and runs its gate once, with no extra rerun or base-move replay.
  assert.equal(done2.base_sha, editTip);
  assert.equal(done2.base_moves, undefined);
  assert.equal(done2.replayed_onto, undefined);
  assert.equal(done2.reruns, undefined);
  assert.equal(done2.timings.filter(e => e.step.startsWith('gate[')).length, 1);
  const gateHeads = fs.readFileSync(join(f.env.HOME, 'gate-heads'), 'utf8').trim().split('\n');
  assert.deepEqual(gateHeads, [done1.landed_sha, done2.landed_sha]);
});

test('handoff drain is bounded to edits pending at the handoff so a steady stream of edits cannot starve lands', { timeout: 30000 }, async t => {
  const f = await legacyCheckout(t, [`if test ! -f "$HOME/started"; then
    touch "$HOME/started"; while test ! -f "$HOME/release"; do sleep .05; done
  fi
  git rev-parse HEAD >> "$HOME/gate-heads"`], { after: [], probe: drainPauseProbe() });
  t.after(() => { try { fs.writeFileSync(join(f.env.HOME, 'drain-release'), 'cleanup'); } catch {} });
  const call = tickets(f);
  const second = addLandJob(f, 'j0000000000000789', 'gamma');

  const { flow: flow1 } = await f.call('hud_land', { job });
  await until(() => fs.existsSync(join(f.env.HOME, 'started')), t.signal);
  const { flow: flow2 } = await f.call('hud_land', { job: second.id });
  assert.equal(f.flowState(flow2).state, 'queued');

  const initial = [];
  for (const title of ['Pending One', 'Pending Two', 'Pending Three']) {
    initial.push(queued(await fast(call('add', { tickets: [draft(title)] }))));
  }

  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  // Synchronize deterministically inside the first snapshot drain while initial[0] is applying.
  await until(() => fs.existsSync(join(f.env.HOME, 'drain-entered')), t.signal);
  assert.equal(read(f, initial[0]).state, 'applying');
  assert.equal(read(f, initial[1]).state, 'queued');
  assert.equal(f.flowState(flow2).state, 'queued');

  const duringDrain = queued(await fast(call('add', { tickets: [draft('During Drain')] })));
  assert.equal(read(f, duringDrain).state, 'queued');

  const stream = [duringDrain];
  fs.writeFileSync(join(f.env.HOME, 'drain-release'), 'go');
  const streamLoop = (async () => {
    for (let i = 1; i <= 8; i++) {
      if (f.flowState(flow2).state === 'completed') break;
      const reply = await call('add', { tickets: [draft(`Stream ${i}`)] });
      if (reply.receipt) stream.push(reply.receipt);
      await delay(10);
    }
  })();

  await until(() => f.flowState(flow2).state === 'completed', t.signal);
  await streamLoop;

  await until(() => stream.every(id => read(f, id).state === 'completed'), t.signal);

  const done1 = f.flowState(flow1), done2 = f.flowState(flow2);
  assert.equal(done1.state, 'completed');
  assert.equal(done2.state, 'completed');
  assert.equal(done2.timings.filter(e => e.step.startsWith('gate[')).length, 1);

  const between = f.git(f.main, 'log', '--reverse', '--format=%B', `${done1.landed_sha}..${done2.landed_sha}^`);
  for (const id of initial) {
    assert.match(between, new RegExp(`HUD-Ticket-Edit: ${id}`), 'pending batch drains between the two lands');
  }
  for (const id of stream) {
    assert.doesNotMatch(between, new RegExp(`HUD-Ticket-Edit: ${id}`), 'post-snapshot edit must not jump ahead of the waiting land');
  }
  const afterSecond = f.git(f.main, 'log', '--reverse', '--format=%B', `${done2.landed_sha}..base`);
  for (const id of stream) {
    assert.match(afterSecond, new RegExp(`HUD-Ticket-Edit: ${id}`), 'post-snapshot edits drain after the waiting land');
  }
});

test('partial train where the lease owner is excluded drains one snapshot before the owner single attempt', { timeout: 30000 }, async t => {
  const f = await legacyCheckout(t, [`if test -f alpha && test ! -f "$HOME/train-gate-started"; then
    touch "$HOME/train-gate-started"
    while test ! -f "$HOME/release-train-gate"; do sleep .05; done
  fi`], { after: [], probe: drainPauseProbe() });
  t.after(() => {
    for (const file of ['release-train-gate', 'drain-release']) {
      try { fs.writeFileSync(join(f.env.HOME, file), 'cleanup'); } catch {}
    }
  });
  const call = tickets(f);
  const lease = { cwd: f.main, home: f.home, holder: 'synthetic-hold' };
  assert.deepEqual(await takeLease({ name: 'main-checkout', wait_s: 0 }, lease), { granted: true });
  t.after(() => takeLease({ name: 'main-checkout', release: true }, lease).catch(() => {}));

  const jobA = addLandJob(f, 'j0000000000000801', 'alpha');
  const jobB = addLandJob(f, 'j0000000000000802', 'beta');
  // Start only jobB's helper so flowB is guaranteed to own the lease; seed flowA as an eligible queued peer.
  const { flow: flowB } = await f.call('hud_land', { job: jobB.id });
  assert.equal(f.flowState(flowB).state, 'queued');
  const flowA = writeQueuedFlow(f, flowB, jobA);

  // Temporarily make jobB fail checkSource so train() excludes the lease owner's pick while publishing flowA.
  const statusB = join(jobDir(f, jobB.id), 'STATUS.json');
  const closedStatus = fs.readFileSync(statusB, 'utf8');
  fs.writeFileSync(statusB, JSON.stringify({ state: 'working' }));

  await takeLease({ name: 'main-checkout', release: true }, lease);
  await until(() => fs.existsSync(join(f.env.HOME, 'train-gate-started')), t.signal);
  assert.equal(f.flowState(flowA).boarded?.flow, flowB);

  const beforeDrain = queued(await fast(call('add', { tickets: [draft('Before Train Drain')] })));
  fs.writeFileSync(statusB, closedStatus);
  fs.writeFileSync(join(f.env.HOME, 'release-train-gate'), 'go');

  await until(() => fs.existsSync(join(f.env.HOME, 'drain-entered')), t.signal);
  assert.equal(read(f, beforeDrain).state, 'applying');
  const duringDrain = queued(await fast(call('add', { tickets: [draft('During Train Drain')] })));
  assert.equal(read(f, duringDrain).state, 'queued');
  fs.writeFileSync(join(f.env.HOME, 'drain-release'), 'go');

  await until(() => f.flowState(flowA).state === 'completed' && f.flowState(flowB).state === 'completed', t.signal);
  await until(() => read(f, beforeDrain).state === 'completed' && read(f, duringDrain).state === 'completed', t.signal);

  const doneA = f.flowState(flowA), doneB = f.flowState(flowB);
  assert.equal(doneA.train, flowA);
  assert.equal(doneA.boarded?.flow, flowB);
  assert.equal(doneB.train, undefined);

  const subjects = f.git(f.main, 'log', '--reverse', '--format=%s', `${f.seedHead}..base`).split('\n');
  assert.deepEqual(subjects, ['alpha', 'tickets: sample/02 add', 'beta', 'tickets: sample/03 add']);
  const commits = f.git(f.main, 'rev-list', '--reverse', `${f.seedHead}..base`).split('\n');
  assert.equal(doneA.landed_sha, commits[0]);
  assert.equal(doneB.base_sha, commits[1]);
  assert.equal(doneB.landed_sha, commits[2]);
  assert.match(f.git(f.main, 'log', '-1', '--format=%B', commits[1]), new RegExp(`HUD-Ticket-Edit: ${beforeDrain}`));
  assert.match(f.git(f.main, 'log', '-1', '--format=%B', commits[3]), new RegExp(`HUD-Ticket-Edit: ${duringDrain}`));
});

test('after a partial train publish, a cancelled single attempt still drains its pending batch before releasing the lease', { timeout: 30000 }, async t => {
  const f = await legacyCheckout(t, [`if test -f alpha && test ! -f "$HOME/train-gate-started"; then
    touch "$HOME/train-gate-started"
    while test ! -f "$HOME/release-train-gate"; do sleep .05; done
  elif test -f beta && test ! -f "$HOME/single-gate-started"; then
    touch "$HOME/single-gate-started"
    while test ! -f "$HOME/release-single-gate"; do sleep .05; done
  fi`], { after: [] });
  t.after(() => {
    for (const file of ['release-train-gate', 'release-single-gate']) {
      try { fs.writeFileSync(join(f.env.HOME, file), 'cleanup'); } catch {}
    }
  });
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const lease = { cwd: f.main, home: f.home, holder: 'synthetic-hold' };
  assert.deepEqual(await takeLease({ name: 'main-checkout', wait_s: 0 }, lease), { granted: true });
  t.after(() => takeLease({ name: 'main-checkout', release: true }, lease).catch(() => {}));

  const jobA = addLandJob(f, 'j0000000000000811', 'alpha');
  const jobB = addLandJob(f, 'j0000000000000812', 'beta');
  const jobC = addLandJob(f, 'j0000000000000813', 'gamma');

  const taskB = await taskCall(rpc, 'hud_land', { job: jobB.id });
  const flowB = taskB.taskId;
  assert.equal(f.flowState(flowB).state, 'queued');
  const flowA = writeQueuedFlow(f, flowB, jobA);

  const statusB = join(jobDir(f, jobB.id), 'STATUS.json');
  const closedStatus = fs.readFileSync(statusB, 'utf8');
  fs.writeFileSync(statusB, JSON.stringify({ state: 'working' }));

  await takeLease({ name: 'main-checkout', release: true }, lease);
  await until(() => fs.existsSync(join(f.env.HOME, 'train-gate-started')), t.signal);
  fs.writeFileSync(statusB, closedStatus);
  fs.writeFileSync(join(f.env.HOME, 'release-train-gate'), 'go');

  await until(() => fs.existsSync(join(f.env.HOME, 'single-gate-started')), t.signal);
  assert.equal(f.flowState(flowA).state, 'completed');
  assert.equal(f.flowState(flowB).state, 'running');

  // Queue a waiting land and a ticket edit while the single attempt runs, then cancel the single attempt.
  const taskC = await taskCall(rpc, 'hud_land', { job: jobC.id });
  const flowC = taskC.taskId;
  assert.equal(f.flowState(flowC).state, 'queued');
  const pending = queued(resultValue(await fast(taskCall(rpc, 'hud_tickets', {
    op: 'add', feature: 'sample', tickets: [draft('Drain On Cancel')],
  }))));
  assert.equal(read(f, pending).state, 'queued');

  await rpc('tasks/cancel', { taskId: flowB });
  fs.writeFileSync(join(f.env.HOME, 'release-single-gate'), 'go');

  await until(() => f.flowState(flowB).state === 'cancelled' && f.flowState(flowC).state === 'completed', t.signal);
  assert.equal(read(f, pending).state, 'completed');

  const subjects = f.git(f.main, 'log', '--reverse', '--format=%s', `${f.seedHead}..base`).split('\n');
  assert.deepEqual(subjects, ['alpha', 'tickets: sample/02 add', 'gamma']);
  const commits = f.git(f.main, 'rev-list', '--reverse', `${f.seedHead}..base`).split('\n');
  assert.equal(f.flowState(flowA).landed_sha, commits[0]);
  assert.equal(f.flowState(flowC).base_sha, commits[1]);
  assert.equal(f.flowState(flowC).landed_sha, commits[2]);
  assert.match(f.git(f.main, 'log', '-1', '--format=%B', commits[1]), new RegExp(`HUD-Ticket-Edit: ${pending}`));
});

test('a clean unpublished train fallback drains one pending snapshot before the owner single attempt', { timeout: 30000 }, async t => {
  const f = await legacyCheckout(t, [`if test -f alpha && test -f beta && ! git cat-file -e base:alpha 2>/dev/null && ! git cat-file -e base:beta 2>/dev/null; then
    touch "$HOME/train-rejected"
    while test ! -f "$HOME/release-train-reject"; do sleep .05; done
    exit 7
  fi`], { after: [], probe: drainPauseProbe() });
  t.after(() => {
    for (const file of ['release-train-reject', 'drain-release']) {
      try { fs.writeFileSync(join(f.env.HOME, file), 'cleanup'); } catch {}
    }
  });
  const call = tickets(f);
  const lease = { cwd: f.main, home: f.home, holder: 'synthetic-hold' };
  assert.deepEqual(await takeLease({ name: 'main-checkout', wait_s: 0 }, lease), { granted: true });
  t.after(() => takeLease({ name: 'main-checkout', release: true }, lease).catch(() => {}));

  const jobA = addLandJob(f, 'j0000000000000821', 'alpha');
  const jobB = addLandJob(f, 'j0000000000000822', 'beta');
  const { flow: flowA } = await f.call('hud_land', { job: jobA.id });
  const { flow: flowB } = await f.call('hud_land', { job: jobB.id });
  assert.equal(f.flowState(flowA).state, 'queued');
  assert.equal(f.flowState(flowB).state, 'queued');

  await takeLease({ name: 'main-checkout', release: true }, lease);
  await until(() => fs.existsSync(join(f.env.HOME, 'train-rejected')), t.signal);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.seedHead);

  const beforeFallback = queued(await fast(call('add', { tickets: [draft('Before Fallback')] })));
  fs.writeFileSync(join(f.env.HOME, 'release-train-reject'), 'go');

  await until(() => fs.existsSync(join(f.env.HOME, 'drain-entered')), t.signal);
  assert.equal(read(f, beforeFallback).state, 'applying');
  const duringFallback = queued(await fast(call('add', { tickets: [draft('During Fallback')] })));
  assert.equal(read(f, duringFallback).state, 'queued');
  fs.writeFileSync(join(f.env.HOME, 'drain-release'), 'go');

  await until(() => f.flowState(flowA).state === 'completed' && f.flowState(flowB).state === 'completed', t.signal);
  await until(() => read(f, beforeFallback).state === 'completed' && read(f, duringFallback).state === 'completed', t.signal);

  const done = [f.flowState(flowA), f.flowState(flowB)];
  for (const row of done) assert.equal(row.train, undefined);
  assert.equal(done.flatMap(row => row.timings.filter(e => e.train && !e.ok)).length, 1);

  const subjects = f.git(f.main, 'log', '--reverse', '--format=%s', `${f.seedHead}..base`).split('\n');
  const commits = f.git(f.main, 'rev-list', '--reverse', `${f.seedHead}..base`).split('\n');
  assert.equal(commits.length, 4);
  assert.equal(subjects[0], 'tickets: sample/02 add');
  assert.equal(subjects[2], 'tickets: sample/03 add');
  assert.deepEqual([subjects[1], subjects[3]].sort(), ['alpha', 'beta']);

  const firstSingle = done.find(row => row.landed_sha === commits[1]);
  const secondSingle = done.find(row => row.landed_sha === commits[3]);
  assert.ok(firstSingle && secondSingle);
  assert.equal(firstSingle.base_sha, commits[0]);
  assert.equal(secondSingle.base_sha, commits[2]);
  assert.match(f.git(f.main, 'log', '-1', '--format=%B', commits[0]), new RegExp(`HUD-Ticket-Edit: ${beforeFallback}`));
  assert.match(f.git(f.main, 'log', '-1', '--format=%B', commits[2]), new RegExp(`HUD-Ticket-Edit: ${duringFallback}`));
});
