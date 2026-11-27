import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { main as cliMain } from '../../dist/cli/hud.js';
import { scanTicketStore } from '../../dist/collectors/ticket-store.js';
import { worktreeGit } from '../../dist/collectors/worktrees.js';
import { collectGateFlakes } from '../../dist/mcp/land-flakes.js';
import { retryableLand } from '../../dist/mcp/land-state.js';
import { recordUnattendedAcceptance } from '../../dist/mcp/local-tickets.js';
import { takeLease } from '../../dist/roles/lease.js';
import { commitArchiveFiles, sweepTicketWrites } from '../../dist/tickets/commit.js';
import { MAX_TICKET_BYTES, readJsonTicketFeature, readTicketWrites, serializeTicketFeature, ticketFeaturePath, ticketWritesPath } from '../../dist/tickets/store.js';
import { until } from '../helpers/thin-mcp-harness.mjs';
import { checkout, job, jobDir, settle } from '../helpers/thin-mcp-land.mjs';

const draft = (title, extra = {}) => ({
  title,
  what: `Change ${title}.`,
  acceptance: [`Verify ${title}.`],
  blocked_by: [],
  ...extra,
});

function setJobTicket(f, ticket, id = job) {
  const receipt = join(jobDir(f, id), 'job.json');
  fs.writeFileSync(receipt, JSON.stringify({ ...JSON.parse(fs.readFileSync(receipt, 'utf8')), ticket }));
}

function addWorkerJob(f, id, files, { ticket, start = f.base_head } = {}) {
  const label = `worker-${id.slice(-6)}`, root = join(`${f.main}-wt`, label), branch = `wt/${label}`;
  f.git(f.main, 'worktree', 'add', '-qb', branch, root, start);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    fs.mkdirSync(join(full, '..'), { recursive: true });
    fs.writeFileSync(full, body);
    f.git(root, 'add', rel);
  }
  f.git(root, 'commit', '-qm', `commit ${id}`);
  const dir = jobDir(f, id);
  fs.mkdirSync(dir, { recursive: true });
  const receipt = JSON.parse(fs.readFileSync(join(jobDir(f), 'job.json'), 'utf8'));
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({
    ...receipt, job: id, cwd: root, ...(ticket && { ticket }),
    worktree: { main_root: f.main, root, branch, base_head: start },
  }));
  settle(f, id, `Synthetic ${id} report.`);
  return { id, root, branch };
}

test('production ticket writes go through the archive planner, not the removed raw writer', () => {
  for (const rel of ['src/mcp/ticket-commits.ts', 'src/mcp/ticket-edit-queue.ts', 'src/mcp/ticket-edit-state.ts']) {
    assert.equal(fs.existsSync(rel), false, `${rel} must be removed`);
  }
  const rawPublishers = fs.readdirSync('src', { recursive: true }).filter(rel => rel.endsWith('.ts') &&
    /\b(?:prepareTicketWrites|writeTicketFeature)\b/.test(fs.readFileSync(join('src', rel), 'utf8')));
  assert.deepEqual(rawPublishers.sort(), ['tickets/archive.ts', 'tickets/store.ts']);
  const groupRefs = fs.readdirSync('src', { recursive: true }).filter(rel => rel.endsWith('.ts') &&
    /@groups/.test(fs.readFileSync(join('src', rel), 'utf8')));
  assert.deepEqual(groupRefs, ['tickets/store.ts'], 'only the ticket ledger reader may handle legacy @groups');
});

for (const ownerTry of [false, true]) test(`landing a JSON ticket folds landing record, status and ticks into one commit (owner_try=${ownerTry})`, { timeout: 25_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  f.git(f.worktree, 'reset', '--soft', f.base_head);
  f.git(f.worktree, 'commit', '-qm', 'single json slice');

  await f.call('hud_tickets', { op: 'add', feature: 'sample', tickets: [draft('Landed slice', { owner_try: ownerTry })] });
  const committed = await f.call('hud_tickets', { op: 'commit' });
  assert.equal(committed.committed, true);
  assert.deepEqual(committed.paths, ['.hud/tickets/sample.json']);
  const baseBeforeLand = f.git(f.main, 'rev-parse', 'HEAD');

  // Unrelated staged change must stay staged and never enter the landed commit.
  fs.writeFileSync(join(f.main, 'owner-staged'), 'staged owner work\n');
  f.git(f.main, 'add', 'owner-staged');
  setJobTicket(f, 'sample/01');

  const { flow } = await f.call('hud_land', { job });
  await until(() => ['completed', 'failed'].includes(f.flowState(flow).state), t.signal);
  const done = f.flowState(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(f.git(f.main, 'rev-parse', 'base'), done.landed_sha);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), done.landed_sha);
  assert.equal(f.git(f.remote, 'rev-list', '--count', `${baseBeforeLand}..base`), '1', 'one landed commit only, no separate tickets commit');
  assert.equal(f.git(f.remote, 'log', '-1', '--format=%s', 'base'), 'single json slice');
  assert.deepEqual(f.git(f.remote, 'diff', '--name-only', baseBeforeLand, 'base').split('\n').sort(), ['.hud/tickets/sample.json', 'tracked']);
  assert.equal(f.git(f.main, 'diff', '--cached', '--name-only'), 'owner-staged');
  assert.equal(f.git(f.main, 'status', '--porcelain', '--', '.hud/tickets/sample.json'), '');

  const stored = JSON.parse(f.git(f.remote, 'show', 'base:.hud/tickets/sample.json'));
  const ticket = stored.tickets[0];
  assert.equal(ticket.status, ownerTry ? 'ready-for-human' : 'done');
  assert.equal(ticket.acceptance[0].done, true);
  assert.equal(ticket.landing.job, job);
  assert.equal(ticket.landing.flow, flow);
  assert.equal(ticket.landing.replay_base, baseBeforeLand);
  assert.equal(ticket.landing.gates, 1);
  assert.ok(Date.parse(ticket.landing.at));
});

const at = '2026-01-01T00:00:00.000Z';
const record = (number, status, fields = {}) => ({ number, status, title: `Ticket ${number}`,
  owner_try: false, live_try: 'none', what: 'Synthetic slice.', approved_removals: [], blocked_by: [],
  acceptance: [{ id: 1, text: 'Verify the slice.', done: false }], comments: [], created_at: at, updated_at: at, ...fields });

function seedArchiveProject(f, docs) {
  fs.mkdirSync(join(f.main, '.hud/tickets'), { recursive: true });
  const objective = join(f.main, '.hud/objectives.md');
  fs.writeFileSync(objective, '## selected: Selected\n**State:** active\n**Features:** sample\n');
  for (const doc of docs) fs.writeFileSync(ticketFeaturePath(f.main, doc.feature), serializeTicketFeature(doc));
  f.git(f.main, 'add', '.hud/tickets', '.hud/objectives.md');
  f.git(f.main, 'commit', '-qm', 'Seed synthetic tickets');
  return objective;
}

function nearCap(feature, tickets, slack = 16) {
  const doc = { version: 1, feature, objective: 'selected', tickets };
  tickets[0].what += 'x'.repeat(MAX_TICKET_BYTES - slack - Buffer.byteLength(serializeTicketFeature(doc)));
  return doc;
}

test('archive and sweep preserve a staged owner edit even when worktree bytes match the HUD receipt', { timeout: 25_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  seedArchiveProject(f, [nearCap('sample', [record(1, 'done'), record(2, 'ready-for-agent')])]);
  const rel = '.hud/tickets/sample.json', path = join(f.main, rel);
  const head = f.git(f.main, 'rev-parse', 'HEAD');
  await f.call('hud_tickets', { op: 'update', ticket: 'sample/02', title: 'HUD note' });
  assert.ok(readTicketWrites(f.home, f.main).sample);
  const hudBytes = fs.readFileSync(path, 'utf8');
  fs.writeFileSync(path, hudBytes.replace('HUD note', 'Owner edit'));
  f.git(f.main, 'add', '--', rel);
  const ownerBlob = f.git(f.main, 'rev-parse', `:${rel}`);
  fs.writeFileSync(path, hudBytes);
  assert.match(f.git(f.main, 'status', '--porcelain', '--', rel), /^MM /);

  const { result } = await f.rpc('tools/call', { name: 'hud_tickets', arguments: {
    op: 'add', feature: 'sample', tickets: [draft('Overflow slice')],
  } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /sample\.json: uncommitted hand edit present/);
  assert.equal(fs.existsSync(ticketFeaturePath(f.main, 'sample-done')), false);
  const assertPreserved = () => {
    assert.equal(f.git(f.main, 'rev-parse', `:${rel}`), ownerBlob);
    assert.equal(fs.readFileSync(path, 'utf8'), hudBytes);
    assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), head);
  };
  assertPreserved();
  assert.deepEqual(await f.call('hud_tickets', { op: 'commit' }), { ok: true, committed: false, paths: [], skipped: [rel] });
  assertPreserved();
});

test('legacy grouped ledger refuses commit, archive and local land without changing ticket files or HEAD', { timeout: 25_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  seedArchiveProject(f, [nearCap('sample', [record(1, 'done'), record(2, 'ready-for-agent')])]);
  const head = f.git(f.main, 'rev-parse', 'HEAD'), remoteHead = f.git(f.remote, 'rev-parse', 'base');
  await f.call('hud_tickets', { op: 'update', ticket: 'sample/02', title: 'HUD note' });
  const path = ticketFeaturePath(f.main, 'sample'), bytes = fs.readFileSync(path);
  const ledger = ticketWritesPath(f.home, f.main);
  const legacy = JSON.stringify({ ...readTicketWrites(f.home, f.main), '@groups': [['sample', 'sample-done']] });
  fs.writeFileSync(ledger, legacy);
  const assertRecovery = message => {
    assert.ok(message.includes(ledger), message);
    assert.match(message, /commit or revert the listed files by hand, then delete the @groups key/);
  };
  for (const args of [{ op: 'commit' }, { op: 'add', feature: 'sample', tickets: [draft('Overflow slice')] }]) {
    const { result } = await f.rpc('tools/call', { name: 'hud_tickets', arguments: args });
    assert.equal(result.isError, true);
    assertRecovery(result.content[0].text);
  }

  const { flow } = await f.call('hud_land', { job });
  await until(() => ['completed', 'failed'].includes(f.flowState(flow).state), t.signal);
  const state = f.flowState(flow);
  assert.equal(state.state, 'failed', JSON.stringify(state));
  assertRecovery(state.error);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), head);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), remoteHead);
  assert.deepEqual(fs.readFileSync(path), bytes);
  assert.equal(fs.existsSync(ticketFeaturePath(f.main, 'sample-done')), false);
  assert.equal(fs.readFileSync(ledger, 'utf8'), legacy);
});

for (const fullArchive of [false, true]) test(`an overflowing repair add archives eligible tickets and commits immediately in one commit (full archive=${fullArchive})`, { timeout: 25_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  const archive = fullArchive ? 'sample-done-2' : 'sample-done';
  const replacementNote = { at, author: 'owner', text: 'Replaced by sample/03' };
  const objective = seedArchiveProject(f, [
    nearCap('sample', [record(1, 'wontfix', { blocked_by: ['sample/03'] }),
      record(2, 'wontfix', { comments: [replacementNote] }), record(3, 'done')]),
    { version: 1, feature: 'other', tickets: [
      record(1, 'ready-for-agent', { blocked_by: ['sample/02'], repairs: ['sample/01'] }),
      record(2, 'done', { blocked_by: ['sample/01'] }),
    ] },
    ...(fullArchive ? [nearCap('sample-done', [record(8, 'done')])] : []),
  ]);
  const baseBeforeAdd = f.git(f.main, 'rev-parse', 'HEAD');
  const call = (op, args) => f.call('hud_tickets', { op, ...args });
  const assertReady = async () => assert.ok((await call('ready')).tickets.some(t => t.ticket === 'other/01'));
  await assertReady();
  const add = await call('add', { feature: 'sample', tickets: [draft('Repair slice', { repairs: ['sample/01'] })] });
  assert.equal(add.tickets[0].number, 4);
  await assertReady();
  assert.deepEqual(readJsonTicketFeature(f.main, 'sample').tickets.map(t => t.number), [2, 4]);
  assert.deepEqual(readJsonTicketFeature(f.main, 'sample').tickets[0].comments, [replacementNote]);
  assert.deepEqual(readJsonTicketFeature(f.main, archive).tickets.map(t => t.number), [1, 3]);
  assert.equal(readJsonTicketFeature(f.main, archive).objective, 'selected');
  assert.deepEqual(readJsonTicketFeature(f.main, archive).tickets[0].blocked_by, [`${archive}/03`]);
  assert.deepEqual(readJsonTicketFeature(f.main, 'sample').tickets.at(-1).repairs, [`${archive}/01`]);
  const [open, closed] = readJsonTicketFeature(f.main, 'other').tickets;
  assert.deepEqual(open.blocked_by, ['sample/02']);
  assert.deepEqual(open.repairs, [`${archive}/01`]);
  assert.deepEqual(closed.blocked_by, [`${archive}/01`]);
  assert.match(fs.readFileSync(objective, 'utf8'), new RegExp(`^\\*\\*Features:\\*\\* sample, ${archive}$`, 'm'));
  // Archive move committed immediately in one commit; nothing left pending.
  const paths = ['.hud/objectives.md', `.hud/tickets/${archive}.json`, '.hud/tickets/other.json', '.hud/tickets/sample.json'].sort();
  assert.equal(f.git(f.main, 'rev-list', '--count', `${baseBeforeAdd}..HEAD`), '1');
  assert.equal(f.git(f.main, 'log', '-1', '--format=%s'), 'tickets: archive sample');
  assert.deepEqual(f.git(f.main, 'show', '--format=', '--name-only', 'HEAD').split('\n').sort(), paths);
  assert.equal(f.git(f.main, 'status', '--porcelain', '--', ...paths), '');
  assert.deepEqual(readTicketWrites(f.home, f.main), {});

  // `git restore` on the shard keeps moved tickets retrievable.
  const archivePath = ticketFeaturePath(f.main, archive);
  fs.writeFileSync(archivePath, fs.readFileSync(archivePath, 'utf8').replace('Ticket 1', 'Temporary edit'));
  f.git(f.main, 'restore', '--', `.hud/tickets/${archive}.json`);
  const found = await call('get', { ticket: 'sample/01' });
  assert.equal(found.feature, archive);
  assert.equal(found.ticket.status, 'wontfix');
  assert.equal(found.ticket.title, 'Ticket 1');
  assert.equal(scanTicketStore(f.main).lookup('sample/01').title, 'Ticket 1');
  assert.equal((await call('add', { feature: 'sample', tickets: [draft('Next slice', { blocked_by: ['sample/01'] })] })).tickets[0].number, 5);
  assert.deepEqual((await call('get', { ticket: 'sample/05' })).ticket.blocked_by, [`${archive}/01`]);
});

test('gate-flake collection commits archives immediately and defers non-blockingly when main-checkout lease is held', { timeout: 25_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  seedArchiveProject(f, [
    nearCap('new-list', [record(1, 'done'), record(2, 'ready-for-agent')]),
    nearCap('open-list', [record(1, 'done'), record(2, 'needs-triage', { kind: 'flake-list' })]),
  ]);
  const config = join(f.main, '.hud/project.json');
  const initial = JSON.parse(fs.readFileSync(config, 'utf8'));

  // When main-checkout lease is held, a cap-crossing flake add defers with wait_s: 0 without writing anything.
  fs.writeFileSync(config, JSON.stringify({ ...initial, flakes: { feature: 'new-list' } }));
  const lease = { home: f.home, cwd: f.main, holder: 'synthetic-land' };
  assert.deepEqual(await takeLease({ name: 'main-checkout', wait_s: 0 }, lease), { granted: true });
  const beforeDefer = fs.readFileSync(ticketFeaturePath(f.main, 'new-list'), 'utf8');
  try {
    const t0 = performance.now();
    const deferred = await collectGateFlakes(f.home, f.main, [
      { name: 'Synthetic flaky case', file: 'tests/unit/example.test.mjs', step: 'gate[1]', flow: 'f0000000000000099' },
    ], null);
    assert.ok(performance.now() - t0 < 2000, 'flake archive deferral must not wait on busy lease');
    assert.equal(deferred.pending?.stage, 'edit');
    assert.match(deferred.pending?.error ?? '', /main-checkout lease is busy/);
    assert.equal(fs.readFileSync(ticketFeaturePath(f.main, 'new-list'), 'utf8'), beforeDefer);
    assert.equal(fs.existsSync(ticketFeaturePath(f.main, 'new-list-done')), false);
  } finally {
    await takeLease({ name: 'main-checkout', release: true }, lease);
  }

  for (const [feature, created, number] of [['new-list', true, 3], ['open-list', false, 2]]) {
    fs.writeFileSync(config, JSON.stringify({ ...initial, flakes: { feature } }));
    const base = f.git(f.main, 'rev-parse', 'HEAD');
    const result = await collectGateFlakes(f.home, f.main, [
      { name: 'Synthetic flaky case', file: 'tests/unit/example.test.mjs', step: 'gate[1]', flow: 'f0000000000000099' },
    ], null);
    assert.equal(result.pending, undefined, JSON.stringify(result));
    assert.equal(result.created, created);
    assert.equal(result.ticket, `${feature}/0${number}`);
    assert.equal(f.git(f.main, 'rev-list', '--count', `${base}..HEAD`), '1');
    assert.equal(f.git(f.main, 'log', '-1', '--format=%s'), `tickets: archive ${feature}`);
    assert.deepEqual(f.git(f.main, 'show', '--format=', '--name-only', 'HEAD').split('\n').sort(), [
      '.hud/objectives.md', `.hud/tickets/${feature}-done.json`, `.hud/tickets/${feature}.json`,
    ]);
    f.git(f.main, 'restore', '--', `.hud/tickets/${feature}-done.json`);
    assert.deepEqual(readJsonTicketFeature(f.main, `${feature}-done`).tickets.map(t => t.number), [1]);
    const latest = readJsonTicketFeature(f.main, feature).tickets.at(-1);
    assert.equal(latest.number, number);
    assert.equal(latest.cases[0].case_name, 'Synthetic flaky case');
  }
});

test('an overflowing comment keeps the highest-numbered ticket and leaves protected inputs intact on failure', { timeout: 25_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  const objective = seedArchiveProject(f, [nearCap('sample', [record(1, 'done'), record(2, 'done')]),
    { version: 1, feature: 'other', tickets: [record(1, 'needs-info', { blocked_by: ['sample/01'] })] }]);
  const path = ticketFeaturePath(f.main, 'sample');
  const before = fs.readFileSync(path, 'utf8'), features = fs.readFileSync(objective, 'utf8');
  const args = { op: 'update', ticket: 'sample/02', comment: 'Add a synthetic follow-up.' };
  const { result } = await f.rpc('tools/call', { name: 'hud_tickets', arguments: args });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Ticket feature sample exceeds 64 KiB/);
  assert.equal(fs.readFileSync(path, 'utf8'), before);
  assert.equal(fs.readFileSync(objective, 'utf8'), features);
  assert.equal(fs.existsSync(ticketFeaturePath(f.main, 'sample-done')), false);
  await f.call('hud_tickets', { op: 'update', ticket: 'other/01', blocked_by: [] });
  const updated = await f.call('hud_tickets', args);
  assert.equal(updated.path, path);
  assert.deepEqual(readJsonTicketFeature(f.main, 'sample').tickets.map(t => t.number), [2]);
  assert.equal(readJsonTicketFeature(f.main, 'sample').tickets[0].comments[0].text, args.comment);
  assert.equal((await f.call('hud_tickets', { op: 'add', feature: 'sample', tickets: [draft('Next slice')] })).tickets[0].number, 3);
});

test('a cap-crossing landing record archives and publishes all changes with the landed commit', { timeout: 25_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  seedArchiveProject(f, [nearCap('sample', [record(1, 'done'), record(2, 'ready-for-agent')])]);
  const base = f.git(f.main, 'rev-parse', 'HEAD');
  setJobTicket(f, 'sample/02');
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['completed', 'failed'].includes(f.flowState(flow).state), t.signal);
  const state = f.flowState(flow);
  assert.equal(state.state, 'completed', JSON.stringify(state));
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), state.landed_sha);
  assert.deepEqual(f.git(f.remote, 'diff', '--name-only', base, 'base').split('\n').sort(),
    ['.hud/objectives.md', '.hud/tickets/sample-done.json', '.hud/tickets/sample.json', 'tracked']);
  const { tickets: [landed] } = JSON.parse(f.git(f.remote, 'show', 'base:.hud/tickets/sample.json'));
  assert.equal(landed.number, 2);
  assert.equal(landed.status, 'done');
  assert.equal(landed.landing.flow, flow);
  assert.equal(JSON.parse(f.git(f.remote, 'show', 'base:.hud/tickets/sample-done.json')).tickets[0].number, 1);
  assert.match(f.git(f.remote, 'show', 'base:.hud/objectives.md'), /Features:\*\* sample, sample-done/);
});

test('cap-crossing land with an unrelated objectives.md change lands when shard is already linked and refuses when a new Features link is needed', { timeout: 35_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  seedArchiveProject(f, [
    nearCap('sample', [record(1, 'done'), record(2, 'ready-for-agent')]),
    { version: 1, feature: 'sample-done', objective: 'selected', tickets: [record(9, 'done')] },
  ]);
  // Link sample-done in .hud/objectives.md on main so the target shard is already linked.
  const objective = join(f.main, '.hud/objectives.md');
  fs.writeFileSync(objective, '## selected: Selected\n**State:** active\n**Features:** sample, sample-done\n');
  f.git(f.main, 'add', '.hud/objectives.md');
  f.git(f.main, 'commit', '-qm', 'Link sample-done shard');
  f.git(f.main, 'push', '-q', 'origin', 'base');
  const linkedBase = f.git(f.main, 'rev-parse', 'HEAD');

  // 1. Incoming land edits .hud/objectives.md (unrelated Next line) while keeping sample-done linked -> lands cleanly.
  const okWorker = addWorkerJob(f, 'j0000000000000611', {
    '.hud/objectives.md': '## selected: Selected\n**State:** active\n**Next:** Ship v2\n**Features:** sample, sample-done\n',
    'feature.txt': 'ok\n',
  }, { ticket: 'sample/02', start: linkedBase });
  const { flow: okFlow } = await f.call('hud_land', { job: okWorker.id });
  await until(() => ['completed', 'failed'].includes(f.flowState(okFlow).state), t.signal);
  const okState = f.flowState(okFlow);
  assert.equal(okState.state, 'completed', JSON.stringify(okState));
  assert.match(f.git(f.remote, 'show', 'base:.hud/objectives.md'), /\*\*Next:\*\* Ship v2/);
  assert.deepEqual(JSON.parse(f.git(f.remote, 'show', 'base:.hud/tickets/sample.json')).tickets.map(item => item.number), [2]);
  assert.deepEqual(JSON.parse(f.git(f.remote, 'show', 'base:.hud/tickets/sample-done.json')).tickets.map(item => item.number), [1, 9]);

  // 2. Incoming land edits .hud/objectives.md and needs a new Features link (sample-done not linked in incoming) -> refused.
  const doc2 = nearCap('sample', [record(2, 'done'), record(3, 'ready-for-agent')]);
  fs.writeFileSync(ticketFeaturePath(f.main, 'sample'), serializeTicketFeature(doc2));
  fs.writeFileSync(objective, '## selected: Selected\n**State:** active\n**Features:** sample\n');
  f.git(f.main, 'add', '.hud/tickets/sample.json', '.hud/objectives.md');
  f.git(f.main, 'commit', '-qm', 'Unlink shard and refill sample');
  f.git(f.main, 'push', '-q', 'origin', 'base');
  const unlinkedBase = f.git(f.main, 'rev-parse', 'HEAD');

  const conflictWorker = addWorkerJob(f, 'j0000000000000612', {
    '.hud/objectives.md': '## selected: Selected\n**State:** active\n**Next:** Unrelated edit\n**Features:** sample\n',
    'conflict.txt': 'no\n',
  }, { ticket: 'sample/03', start: unlinkedBase });
  const { flow: conflictFlow } = await f.call('hud_land', { job: conflictWorker.id });
  await until(() => ['completed', 'failed'].includes(f.flowState(conflictFlow).state), t.signal);
  const conflictState = f.flowState(conflictFlow);
  assert.equal(conflictState.state, 'failed', JSON.stringify(conflictState));
  assert.match(conflictState.error, /Cannot archive tickets while the same land changes \.hud\/objectives\.md/);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), unlinkedBase);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), unlinkedBase);

  // 3. Incoming land unlinks an already-linked shard from .hud/objectives.md -> compared against incoming contents, refused.
  fs.writeFileSync(objective, '## selected: Selected\n**State:** active\n**Features:** sample, sample-done\n');
  f.git(f.main, 'add', '.hud/objectives.md');
  f.git(f.main, 'commit', '-qm', 'Relink shard on main');
  f.git(f.main, 'push', '-q', 'origin', 'base');
  const relinkedBase = f.git(f.main, 'rev-parse', 'HEAD');

  const unlinkWorker = addWorkerJob(f, 'j0000000000000613', {
    '.hud/objectives.md': '## selected: Selected\n**State:** active\n**Features:** sample\n',
    'unlink.txt': 'no\n',
  }, { ticket: 'sample/03', start: relinkedBase });
  const { flow: unlinkFlow } = await f.call('hud_land', { job: unlinkWorker.id });
  await until(() => ['completed', 'failed'].includes(f.flowState(unlinkFlow).state), t.signal);
  const unlinkState = f.flowState(unlinkFlow);
  assert.equal(unlinkState.state, 'failed', JSON.stringify(unlinkState));
  assert.match(unlinkState.error, /Cannot archive tickets while the same land changes \.hud\/objectives\.md/);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), relinkedBase);
});

test('uncommitted hand edits on any archive-touched file refuse before writing, clean Objective links sweep flatly, and Git commit failures roll back disk and index', { timeout: 35_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  const objective = seedArchiveProject(f, [
    nearCap('sample', [record(1, 'done'), record(2, 'ready-for-agent')]),
    { version: 1, feature: 'other', tickets: [record(1, 'done', { blocked_by: ['sample/01'] })] },
  ]);
  const samplePath = ticketFeaturePath(f.main, 'sample');
  const otherPath = ticketFeaturePath(f.main, 'other');
  const shardPath = ticketFeaturePath(f.main, 'sample-done');
  const cleanSample = fs.readFileSync(samplePath, 'utf8');
  const cleanOther = fs.readFileSync(otherPath, 'utf8');
  const cleanObj = fs.readFileSync(objective, 'utf8');

  // 1. Hand edit on source, ref-rewritten feature, or Objective each refuse before any file is written.
  for (const [label, path, clean, edited, rel] of [
    ['source', samplePath, cleanSample, cleanSample.replace('Ticket 2', 'Hand edit 2'), '.hud/tickets/sample.json'],
    ['ref-rewritten feature', otherPath, cleanOther, cleanOther.replace('Ticket 1', 'Hand other 1'), '.hud/tickets/other.json'],
    ['objectives', objective, cleanObj, cleanObj + '\n<!-- hand edit -->\n', '.hud/objectives.md'],
  ]) {
    const headBefore = f.git(f.main, 'rev-parse', 'HEAD');
    fs.writeFileSync(path, edited);
    const { result } = await f.rpc('tools/call', {
      name: 'hud_tickets',
      arguments: { op: 'add', feature: 'sample', tickets: [draft(`Blocked by ${label}`)] },
    });
    assert.equal(result.isError, true, `${label} hand edit must refuse`);
    assert.match(result.content[0].text, new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(fs.existsSync(shardPath), false, `${label} refusal must not create shard`);
    assert.equal(fs.readFileSync(samplePath, 'utf8'), path === samplePath ? edited : cleanSample);
    assert.equal(fs.readFileSync(otherPath, 'utf8'), path === otherPath ? edited : cleanOther);
    assert.equal(fs.readFileSync(objective, 'utf8'), path === objective ? edited : cleanObj);
    assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), headBefore);
    fs.writeFileSync(path, clean);
  }

  // 2. Cap-crossing hud_land with a hand edit on .hud/objectives.md also refuses before fast-forward.
  const objHand = cleanObj + '\n<!-- land hand edit -->\n';
  fs.writeFileSync(objective, objHand);
  const landBase = f.git(f.main, 'rev-parse', 'HEAD');
  setJobTicket(f, 'sample/02');
  const { flow: refusedLand } = await f.call('hud_land', { job });
  await until(() => f.flowState(refusedLand).state === 'failed', t.signal);
  assert.match(f.flowState(refusedLand).error, /Cannot record landing in \.hud\/objectives\.md: uncommitted hand edit present/);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), landBase);
  assert.equal(fs.existsSync(shardPath), false);
  assert.equal(fs.readFileSync(objective, 'utf8'), objHand);
  fs.writeFileSync(objective, cleanObj);

  // 3. Git commit failure after --intent-to-add restores pre-write bytes, deletes new shard, and resets index.
  const failingGit = async (args) => {
    if (args.includes('commit')) throw new Error('synthetic git commit failure');
    return worktreeGit(f.main, args);
  };
  await assert.rejects(
    () => commitArchiveFiles(f.main, f.home, [
      { key: 'sample', bytes: cleanSample.replace('Ticket 2', 'Rolled back 2') },
      { key: 'sample-done', bytes: serializeTicketFeature({ version: 1, feature: 'sample-done', tickets: [record(1, 'done')] }) },
    ], failingGit, { mode: 'commit', message: 'tickets: archive sample' }),
    /synthetic git commit failure/,
  );
  assert.equal(fs.readFileSync(samplePath, 'utf8'), cleanSample);
  assert.equal(fs.existsSync(shardPath), false);
  assert.equal(f.git(f.main, 'status', '--porcelain', '--', '.hud/tickets'), '');

  // 4. Clean archive commits immediately; a later ordinary add with objective sweeps @objectives flatly.
  await f.call('hud_tickets', { op: 'add', feature: 'sample', tickets: [draft('Overflow slice')] });
  assert.equal(f.git(f.main, 'log', '-1', '--format=%s'), 'tickets: archive sample');
  await f.call('hud_tickets', { op: 'add', feature: 'third', objective: 'selected', tickets: [draft('Linked feature')] });
  assert.ok(readTicketWrites(f.home, f.main)['@objectives']);
  assert.ok(readTicketWrites(f.home, f.main).third);
  const committed = await f.call('hud_tickets', { op: 'commit' });
  assert.equal(committed.committed, true, JSON.stringify(committed));
  assert.deepEqual(committed.paths.sort(), ['.hud/objectives.md', '.hud/tickets/third.json']);
  assert.match(f.git(f.main, 'show', 'HEAD:.hud/objectives.md'), /^\*\*Features:\*\* sample, sample-done, third$/m);
  assert.deepEqual(readTicketWrites(f.home, f.main), {});
});

test('planner leaves a ticket in source when its number already exists in the archive family so old refs stay unique', { timeout: 25_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  const t1 = record(1, 'done');
  const t2 = record(2, 'done');
  const t3 = record(3, 'ready-for-agent');
  const sampleDoc = { version: 1, feature: 'sample', objective: 'selected', tickets: [t1, t2, t3] };
  t2.what += 'x'.repeat(MAX_TICKET_BYTES - 16 - Buffer.byteLength(serializeTicketFeature(sampleDoc)));
  seedArchiveProject(f, [
    sampleDoc,
    { version: 1, feature: 'sample-done', objective: 'selected', tickets: [record(1, 'done', { title: 'Old archived 1' })] },
  ]);

  await f.call('hud_tickets', { op: 'add', feature: 'sample', tickets: [draft('Trigger archive')] });
  assert.deepEqual(readJsonTicketFeature(f.main, 'sample').tickets.map(item => item.number), [1, 3, 4]);
  assert.deepEqual(readJsonTicketFeature(f.main, 'sample-done').tickets.map(item => item.number), [1, 2]);
  assert.equal(fs.existsSync(ticketFeaturePath(f.main, 'sample-done-2')), false, 'must not create a duplicate number in a later shard');

  const got1 = await f.call('hud_tickets', { op: 'get', ticket: 'sample/01' });
  assert.equal(got1.feature, 'sample');
  assert.equal(got1.ticket.title, 'Ticket 1');
  const got2 = await f.call('hud_tickets', { op: 'get', ticket: 'sample/02' });
  assert.equal(got2.feature, 'sample-done');
  assert.equal(scanTicketStore(f.main).lookup('sample/01').title, 'Ticket 1');
  assert.equal(scanTicketStore(f.main).lookup('sample/02').title, 'Ticket 2');
});

test('a cap-crossing write moves every eligible ticket and the next small write does not archive again', { timeout: 25_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  seedArchiveProject(f, [
    nearCap('sample', [record(1, 'done'), record(2, 'done'), record(3, 'wontfix'), record(4, 'ready-for-agent')]),
  ]);

  await f.call('hud_tickets', { op: 'add', feature: 'sample', tickets: [draft('Cap crossing slice')] });
  assert.deepEqual(readJsonTicketFeature(f.main, 'sample').tickets.map(item => item.number), [4, 5]);
  assert.deepEqual(readJsonTicketFeature(f.main, 'sample-done').tickets.map(item => item.number), [1, 2, 3]);

  assert.deepEqual(await f.call('hud_tickets', { op: 'commit' }), { ok: true, committed: false, paths: [] });
  // Make ticket 4 eligible, then perform a small write; it must NOT rerun archiving.
  await f.call('hud_tickets', { op: 'update', ticket: 'sample/04', status: 'done' });
  await f.call('hud_tickets', { op: 'add', feature: 'sample', tickets: [draft('Small follow-up')] });
  assert.deepEqual(readJsonTicketFeature(f.main, 'sample').tickets.map(item => item.number), [4, 5, 6]);
  assert.deepEqual(readJsonTicketFeature(f.main, 'sample-done').tickets.map(item => item.number), [1, 2, 3]);
  const rawWrites = JSON.parse(fs.readFileSync(ticketWritesPath(f.home, f.main), 'utf8'));
  assert.equal(Object.hasOwn(rawWrites, '@groups'), false);
  assert.deepEqual(Object.keys(rawWrites), ['sample']);
});

test('gate-time hud_tickets edits fold with the landing into one commit; dirty HUD writes never block land; hand edits are never swept', { timeout: 30_000 }, async t => {
  const f = await checkout(t, ['while test ! -f "$HOME/release"; do sleep .05; done'], { after: [] });
  f.git(f.worktree, 'reset', '--soft', f.base_head);
  f.git(f.worktree, 'commit', '-qm', 'slice with concurrent edits');

  // Create ticket 01 as an UNCOMMITTED HUD-written JSON file before land starts!
  await f.call('hud_tickets', { op: 'add', feature: 'sample', tickets: [draft('First slice')] });
  assert.match(f.git(f.main, 'status', '--porcelain', '--', '.hud/tickets/sample.json'), /^\?\?/);
  setJobTicket(f, 'sample/01');

  // Create another JSON feature and then hand-edit it so its hash does NOT match ticket-writes.json.
  await f.call('hud_tickets', { op: 'add', feature: 'hand', tickets: [draft('Hand feature')] });
  const handPath = ticketFeaturePath(f.main, 'hand');
  const handBytes = fs.readFileSync(handPath, 'utf8').replace('Change Hand feature.', 'Owner hand edit.');
  fs.writeFileSync(handPath, handBytes);

  const baseBeforeLand = f.git(f.main, 'rev-parse', 'HEAD');
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).step.startsWith('gate[1]'), t.signal);

  // During the running gate: edit the landing feature AND create a second HUD-written feature.
  const addedSame = await f.call('hud_tickets', { op: 'add', feature: 'sample', tickets: [draft('Gate-time sibling')] });
  assert.equal(addedSame.tickets[0].number, 2);
  await f.call('hud_tickets', { op: 'add', feature: 'other', tickets: [draft('Gate-time other')] });
  assert.deepEqual(fs.readdirSync(join(f.home, 'flows')).filter(name => /^te/.test(name)), [], 'no receipt queue files');

  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => ['completed', 'failed'].includes(f.flowState(flow).state), t.signal);
  const done = f.flowState(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(f.git(f.remote, 'rev-list', '--count', `${baseBeforeLand}..base`), '1', 'one landed commit carries all swept ticket edits');
  assert.equal(f.git(f.remote, 'log', '-1', '--format=%s', 'base'), 'slice with concurrent edits');

  const changed = f.git(f.remote, 'diff', '--name-only', baseBeforeLand, 'base').split('\n').sort();
  assert.deepEqual(changed, ['.hud/tickets/other.json', '.hud/tickets/sample.json', 'tracked']);

  const sampleDoc = JSON.parse(f.git(f.remote, 'show', 'base:.hud/tickets/sample.json'));
  assert.deepEqual(sampleDoc.tickets.map(item => [item.number, item.status]), [[1, 'done'], [2, 'ready-for-agent']]);
  assert.equal(sampleDoc.tickets[0].landing.flow, flow);
  const otherDoc = JSON.parse(f.git(f.remote, 'show', 'base:.hud/tickets/other.json'));
  assert.equal(otherDoc.tickets[0].title, 'Gate-time other');

  // Hand-edited ticket file was NEVER swept and remains intact on disk.
  assert.equal(fs.readFileSync(handPath, 'utf8'), handBytes);
  assert.match(f.git(f.main, 'status', '--porcelain', '--', '.hud/tickets/hand.json'), /^\?\?/);
  assert.equal(f.git(f.main, 'status', '--porcelain', '--', '.hud/tickets/sample.json', '.hud/tickets/other.json'), '');
});

test('landing with a valid or malformed hand edit in the landing feature refuses before main moves and stays retryable', { timeout: 35_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  await f.call('hud_tickets', { op: 'add', feature: 'sample', tickets: [draft('Hand-edited landing feature')] });
  await f.call('hud_tickets', { op: 'commit' });
  const samplePath = ticketFeaturePath(f.main, 'sample');
  const cleanBytes = fs.readFileSync(samplePath, 'utf8');
  setJobTicket(f, 'sample/01');

  // 1. Valid hand edit on the landing feature refuses before moving main, preserves bytes, leaves no publish_pending.
  const handEdited = cleanBytes.replace('Change Hand-edited landing feature.', 'Owner local hand edit.');
  fs.writeFileSync(samplePath, handEdited);
  const baseBeforeLand = f.git(f.main, 'rev-parse', 'HEAD');
  const remoteBeforeLand = f.git(f.remote, 'rev-parse', 'base');
  const { flow: flow1 } = await f.call('hud_land', { job });
  await until(() => ['completed', 'failed'].includes(f.flowState(flow1).state), t.signal);
  const res1 = f.flowState(flow1);
  assert.equal(res1.state, 'failed', JSON.stringify(res1));
  assert.match(res1.error, /\.hud\/tickets\/sample\.json/);
  assert.equal(res1.landed_sha, undefined);
  assert.equal(res1.publish_pending, undefined);
  assert.equal(retryableLand(res1), true);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), baseBeforeLand, 'main must not move on valid hand edit');
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), remoteBeforeLand, 'remote must not move on valid hand edit');
  assert.equal(fs.readFileSync(samplePath, 'utf8'), handEdited, 'valid hand edit preserved on disk');

  // 2. Malformed JSON hand edit on the landing feature refuses before moving main, leaves no publish_pending.
  const malformed = '{ broken json\n';
  fs.writeFileSync(samplePath, malformed);
  const { flow: flow2 } = await f.call('hud_land', { job });
  assert.notEqual(flow2, flow1, 'previous failure is retryable with a fresh attempt');
  await until(() => ['completed', 'failed'].includes(f.flowState(flow2).state), t.signal);
  const res2 = f.flowState(flow2);
  assert.equal(res2.state, 'failed', JSON.stringify(res2));
  assert.match(res2.error, /\.hud\/tickets\/sample\.json/);
  assert.equal(res2.landed_sha, undefined);
  assert.equal(res2.publish_pending, undefined);
  assert.equal(retryableLand(res2), true);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), baseBeforeLand, 'main must not move on malformed hand edit');
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), remoteBeforeLand, 'remote must not move on malformed hand edit');
  assert.equal(fs.readFileSync(samplePath, 'utf8'), malformed, 'malformed bytes preserved on disk');

  // 3. Restoring clean JSON lets a retry complete with the ticket recorded done.
  fs.writeFileSync(samplePath, cleanBytes);
  const { flow: flow3 } = await f.call('hud_land', { job });
  await until(() => ['completed', 'failed'].includes(f.flowState(flow3).state), t.signal);
  const res3 = f.flowState(flow3);
  assert.equal(res3.state, 'completed', JSON.stringify(res3));
  const stored = JSON.parse(f.git(f.remote, 'show', 'base:.hud/tickets/sample.json'));
  assert.equal(stored.tickets[0].status, 'done');
  assert.equal(stored.tickets[0].landing.flow, flow3);
});

test('a mid-gate hand edit in the landing feature refuses before fast-forward without leaving publish_pending', { timeout: 30_000 }, async t => {
  const f = await checkout(t, ['while test ! -f "$HOME/release"; do sleep .05; done'], { after: [] });
  await f.call('hud_tickets', { op: 'add', feature: 'sample', tickets: [draft('Mid-gate hand edit')] });
  await f.call('hud_tickets', { op: 'commit' });
  const samplePath = ticketFeaturePath(f.main, 'sample');
  setJobTicket(f, 'sample/01');

  const baseBeforeLand = f.git(f.main, 'rev-parse', 'HEAD');
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).step.startsWith('gate[1]'), t.signal);

  const handEdited = fs.readFileSync(samplePath, 'utf8').replace('Change Mid-gate hand edit.', 'Edited during gate.');
  fs.writeFileSync(samplePath, handEdited);
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');

  await until(() => ['completed', 'failed'].includes(f.flowState(flow).state), t.signal);
  const done = f.flowState(flow);
  assert.equal(done.state, 'failed', JSON.stringify(done));
  assert.match(done.error, /\.hud\/tickets\/sample\.json/);
  assert.equal(done.landed_sha, undefined);
  assert.equal(done.publish_pending, undefined);
  assert.equal(retryableLand(done), true);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), baseBeforeLand);
  assert.equal(fs.readFileSync(samplePath, 'utf8'), handEdited);
});

test('replay onto a ticket-amended head or objectives.md skips the gate as metadata-only', { timeout: 25_000 }, async t => {
  const f = await checkout(t, ['echo run >> "$HOME/gate-count"; while test ! -f "$HOME/release"; do sleep .05; done'], { after: [] });
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).step.startsWith('gate[1]'), t.signal);

  // Advance main during the gate with only .hud/tickets/*.json and .hud/objectives.md.
  fs.mkdirSync(join(f.main, '.hud/tickets'), { recursive: true });
  fs.writeFileSync(join(f.main, '.hud/tickets/meta.json'), JSON.stringify({
    version: 1, feature: 'meta', tickets: [],
  }, null, 2) + '\n');
  fs.writeFileSync(join(f.main, '.hud/objectives.md'), '# Objectives\n\n## obj: Objective\n**State:** active\n');
  f.git(f.main, 'add', '.hud/tickets/meta.json', '.hud/objectives.md');
  f.git(f.main, 'commit', '-qm', 'ticket and objective metadata');
  const movedBase = f.git(f.main, 'rev-parse', 'HEAD');

  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => ['completed', 'failed'].includes(f.flowState(flow).state), t.signal);
  const done = f.flowState(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(done.replayed_onto, movedBase);
  assert.equal(fs.readFileSync(join(f.env.HOME, 'gate-count'), 'utf8'), 'run\n', 'gate ran only once (metadata-only replay skipped re-gate)');
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), done.landed_sha);
});

test('worker diffs touching .hud/tickets/** are rejected in prepare and excluded from train', { timeout: 45_000 }, async t => {
  const f = await checkout(t, [`if test ! -f "$HOME/started"; then
    touch "$HOME/started"; while test ! -f "$HOME/release"; do sleep .05; done
  fi`], { after: [] });

  // Single land prepare refusal: worker branch modifies .hud/tickets/rogue.json.
  const rogue = addWorkerJob(f, 'j0000000000000601', {
    'code.txt': 'ok\n',
    '.hud/tickets/rogue.json': '{"version":1,"feature":"rogue","tickets":[]}\n',
  });
  // Train scenario: hold land with blocker job, queue both a clean peer and rogue together.
  const clean = addWorkerJob(f, 'j0000000000000602', { 'clean.txt': 'clean\n' });

  const { flow: blocker } = await f.call('hud_land', { job });
  await until(() => fs.existsSync(join(f.env.HOME, 'started')), t.signal);
  const { flow: cleanFlow } = await f.call('hud_land', { job: clean.id });
  const { flow: rogueFlow } = await f.call('hud_land', { job: rogue.id });
  assert.equal(f.flowState(cleanFlow).state, 'queued');
  assert.equal(f.flowState(rogueFlow).state, 'queued');

  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => [blocker, cleanFlow, rogueFlow].every(id => ['completed', 'failed'].includes(f.flowState(id).state)), t.signal);

  assert.equal(f.flowState(blocker).state, 'completed');
  assert.equal(f.flowState(cleanFlow).state, 'completed', 'clean peer still lands cleanly');
  const rejected = f.flowState(rogueFlow);
  assert.equal(rejected.state, 'failed');
  assert.match(rejected.error, /\.hud\/tickets\/\*\*/);
  assert.equal(rejected.landed_sha, undefined);
  assert.equal(fs.existsSync(join(f.main, '.hud/tickets/rogue.json')), false);
});

test('hud_tickets commit and hud tickets commit sweep only HUD-written ticket files and leave other changes alone', { timeout: 25_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  const baseHead = f.git(f.main, 'rev-parse', 'HEAD');

  // Nothing written yet -> no-op.
  const noop = await f.call('hud_tickets', { op: 'commit' });
  assert.deepEqual(noop, { ok: true, committed: false, paths: [] });
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), baseHead);

  // Set up unrelated staged, unstaged, untracked, and hand-edited ticket files.
  fs.appendFileSync(join(f.main, 'tracked'), 'staged owner line\n');
  f.git(f.main, 'add', 'tracked');
  fs.appendFileSync(join(f.main, 'tracked'), 'unstaged owner line\n');
  fs.writeFileSync(join(f.main, 'notes.txt'), 'untracked owner note\n');
  const stagedBefore = f.git(f.main, 'diff', '--cached');
  const unstagedBefore = f.git(f.main, 'diff');

  await f.call('hud_tickets', { op: 'add', cwd: f.worktree, feature: 'alpha', tickets: [draft('Alpha one')] });
  await f.call('hud_tickets', { op: 'add', cwd: f.worktree, feature: 'beta', tickets: [draft('Beta one')] });
  // Hand-edit beta so it must NOT be swept.
  const betaPath = ticketFeaturePath(f.main, 'beta');
  const betaHand = fs.readFileSync(betaPath, 'utf8').replace('Change Beta one.', 'Owner hand beta.');
  fs.writeFileSync(betaPath, betaHand);

  const res = await f.call('hud_tickets', { op: 'commit', cwd: f.worktree });
  assert.equal(res.ok, true);
  assert.equal(res.committed, true);
  assert.deepEqual(res.paths, ['.hud/tickets/alpha.json']);
  assert.deepEqual(res.skipped, ['.hud/tickets/beta.json']);
  assert.equal(res.commit, f.git(f.main, 'rev-parse', 'HEAD'));
  assert.deepEqual(f.git(f.main, 'show', '--format=', '--name-only', 'HEAD').split('\n'), ['.hud/tickets/alpha.json']);
  assert.equal(f.git(f.main, 'diff', '--cached'), stagedBefore);
  assert.equal(f.git(f.main, 'diff', '--', 'tracked'), unstagedBefore);
  assert.match(f.git(f.main, 'status', '--porcelain', '--', 'notes.txt'), /^\?\?/);
  assert.equal(fs.readFileSync(betaPath, 'utf8'), betaHand);
  assert.match(f.git(f.main, 'status', '--porcelain', '--', '.hud/tickets/beta.json'), /^\?\?/);

  // CLI `hud tickets commit --cwd <dir>` commits subsequent HUD-written edits too.
  await f.call('hud_tickets', { op: 'update', feature: 'alpha', ticket: 1, status: 'done', tick: [1] });
  let out = '', err = '';
  const code = await cliMain(['tickets', 'commit', '--cwd', f.worktree], {
    env: f.env,
    stdout: text => { out += text; },
    stderr: text => { err += text; },
  });
  assert.equal(code, 0, err);
  assert.match(out, /committed 1 ticket file.*: \.hud\/tickets\/alpha\.json/);
  assert.deepEqual(f.git(f.main, 'show', '--format=', '--name-only', 'HEAD').split('\n'), ['.hud/tickets/alpha.json']);
  assert.equal(readTicketWrites(f.home, f.main).alpha, undefined, 'committed entry pruned from ticket-writes.json');

  // Second CLI call reports nothing to commit.
  out = ''; err = '';
  const code2 = await cliMain(['tickets', 'commit', '--cwd', f.main], {
    env: f.env,
    stdout: text => { out += text; },
    stderr: text => { err += text; },
  });
  assert.equal(code2, 0, err);
  assert.equal(out, 'nothing to commit\n');
});

test('unattended acceptance writes accepted receipt to JSON store and attempts non-blocking commit at run end', { timeout: 25_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  await f.call('hud_tickets', { op: 'add', feature: 'unatt', tickets: [
    draft('First', { owner_try: true }),
    draft('Second', { owner_try: true }),
  ] });
  await f.call('hud_tickets', { op: 'commit' });
  const path = ticketFeaturePath(f.main, 'unatt');

  // Part 1: when main-checkout lease is free, acceptance writes JSON and commits immediately.
  const flow1 = 'q00000000000000a1';
  await recordUnattendedAcceptance(f.main, f.home, () => [{ path, ticket: 'unatt/01' }], flow1, 'finish: Verified slice 1.');
  const doc1 = readJsonTicketFeature(f.main, 'unatt');
  assert.equal(doc1.tickets[0].status, 'done');
  assert.equal(doc1.tickets[0].accepted?.by, 'lead');
  assert.equal(doc1.tickets[0].accepted?.flow, flow1);
  assert.equal(doc1.tickets[0].accepted?.verdict, 'finish: Verified slice 1.');
  assert.ok(Date.parse(doc1.tickets[0].accepted?.at));
  assert.equal(f.git(f.main, 'log', '-1', '--format=%s'), 'tickets: unatt/01 accept');
  assert.equal(f.git(f.main, 'status', '--porcelain', '--', '.hud/tickets/unatt.json'), '');

  // Part 2: when main-checkout lease is held, acceptance still writes JSON and returns immediately without blocking.
  const lease = { home: f.home, cwd: f.main, holder: 'synthetic-land' };
  assert.deepEqual(await takeLease({ name: 'main-checkout', wait_s: 0 }, lease), { granted: true });
  const headWhileHeld = f.git(f.main, 'rev-parse', 'HEAD');
  try {
    const t0 = performance.now();
    const flow2 = 'q00000000000000a2';
    const acc2 = await recordUnattendedAcceptance(f.main, f.home, () => [{ path, ticket: 'unatt/02' }], flow2, 'finish: Verified slice 2.');
    assert.ok(performance.now() - t0 < 2000, 'commit attempt must be non-blocking when lease is held');
    assert.deepEqual(acc2, { persisted: ['unatt/02'], failed: [], committed: false, deferred: true });
    const doc2 = readJsonTicketFeature(f.main, 'unatt');
    assert.equal(doc2.tickets[1].status, 'done');
    assert.equal(doc2.tickets[1].accepted?.flow, flow2);
    assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), headWhileHeld, 'no commit while lease is held');
    assert.match(f.git(f.main, 'status', '--porcelain', '--', relative(f.main, path)), /^M /);
  } finally {
    await takeLease({ name: 'main-checkout', release: true }, lease);
  }

  // Part 3: accept in one batch so an archive rewrite of a second edited feature survives.
  // A feature containing only the protected highest ticket still fails without blocking the rest.
  seedArchiveProject(f, [
    nearCap('sample', [record(1, 'done'), record(2, 'ready-for-human')]),
    { version: 1, feature: 'other', tickets: [record(1, 'ready-for-human', { blocked_by: ['sample/01'] })] },
    nearCap('huge', [record(1, 'ready-for-human')]),
  ]);
  const hugePath = ticketFeaturePath(f.main, 'huge'), nearCapBytes = fs.readFileSync(hugePath);
  const acc3Base = f.git(f.main, 'rev-parse', 'HEAD');
  const flow3 = 'q00000000000000a3';
  const acc3 = await recordUnattendedAcceptance(f.main, f.home, () => ['sample/02', 'other/01', 'huge/01']
    .map(ticket => ({ ticket, path: ticketFeaturePath(f.main, ticket.split('/')[0]) })), flow3, 'finish: Verified the slices.');
  assert.deepEqual(acc3.persisted, ['sample/02', 'other/01']);
  assert.equal(acc3.committed, true);
  assert.deepEqual(acc3.failed, [{ ticket: 'huge/01', error: 'Ticket feature huge exceeds 64 KiB' }]);
  assert.deepEqual(fs.readFileSync(hugePath), nearCapBytes);
  assert.equal(f.git(f.main, 'rev-list', '--count', `${acc3Base}..HEAD`), '1');
  assert.equal(f.git(f.main, 'log', '-1', '--format=%s'), 'tickets: archive sample');
  assert.deepEqual(f.git(f.main, 'show', '--format=', '--name-only', 'HEAD').split('\n').sort(), [
    '.hud/objectives.md', '.hud/tickets/other.json', '.hud/tickets/sample-done.json', '.hud/tickets/sample.json',
  ]);
  f.git(f.main, 'restore', '--', '.hud/tickets/sample-done.json');
  assert.deepEqual(readJsonTicketFeature(f.main, 'sample-done').tickets.map(t => t.number), [1]);
  assert.equal(readJsonTicketFeature(f.main, 'sample').tickets[0].accepted.flow, flow3);
  const [other] = readJsonTicketFeature(f.main, 'other').tickets;
  assert.equal(other.accepted.flow, flow3);
  assert.deepEqual(other.blocked_by, ['sample-done/01']);
});

test('hand edit to ticket A followed by HUD write to ticket B never sweeps the owner edit on commit', { timeout: 25_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  const cfgPath = join(f.main, '.hud/project.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, flakes: { feature: 'flaky' } }));

  // 1. Committed feature: hand-edit ticket A, then HUD updates ticket B via hud_tickets update + unattended acceptance.
  await f.call('hud_tickets', { op: 'add', feature: 'shared', tickets: [draft('Ticket A'), draft('Ticket B', { owner_try: true })] });
  await f.call('hud_tickets', { op: 'add', feature: 'flaky', tickets: [draft('Manual flake note')] });
  await f.call('hud_tickets', { op: 'commit' });

  const sharedPath = ticketFeaturePath(f.main, 'shared');
  fs.writeFileSync(sharedPath, fs.readFileSync(sharedPath, 'utf8').replace('Change Ticket A.', 'Owner hand edit A.'));

  // HUD updates ticket B in the same feature.
  await f.call('hud_tickets', { op: 'update', feature: 'shared', ticket: 2, status: 'done', tick: [1] });
  assert.equal(readTicketWrites(f.home, f.main).shared, undefined, 'hand-edited input must not be marked sweepable');

  // Unattended acceptance on ticket B must also never mark shared sweepable or commit A.
  const acc = await recordUnattendedAcceptance(f.main, f.home, () => [{ path: sharedPath, ticket: 'shared/02' }], 'q00000000000000b1', 'finish: Verified B.');
  assert.deepEqual(acc, { persisted: ['shared/02'], failed: [], committed: false });
  assert.equal(readTicketWrites(f.home, f.main).shared, undefined);

  // Flake collection into a hand-edited flake feature must also never mark it sweepable.
  const flakyPath = ticketFeaturePath(f.main, 'flaky');
  fs.writeFileSync(flakyPath, fs.readFileSync(flakyPath, 'utf8').replace('Change Manual flake note.', 'Owner flaky hand edit.'));
  await collectGateFlakes(f.home, f.main, [
    { name: 'flaky case', file: 'tests/unit/a.test.mjs', step: 'gate[1]', flow: 'f0000000000000099' },
  ], null);
  assert.equal(readTicketWrites(f.home, f.main).flaky, undefined);

  // Uncommitted HUD-written feature hand-edited before a second HUD write must drop its sweep eligibility too.
  await f.call('hud_tickets', { op: 'add', feature: 'uncom', tickets: [draft('Uncom A'), draft('Uncom B')] });
  const uncomPath = ticketFeaturePath(f.main, 'uncom');
  fs.writeFileSync(uncomPath, fs.readFileSync(uncomPath, 'utf8').replace('Change Uncom A.', 'Owner uncom edit A.'));
  await f.call('hud_tickets', { op: 'update', feature: 'uncom', ticket: 2, status: 'done' });
  assert.equal(readTicketWrites(f.home, f.main).uncom, undefined);

  // Add a clean unrelated feature, then `hud tickets commit` commits only the clean feature; none of the hand edits enter git.
  await f.call('hud_tickets', { op: 'add', feature: 'clean', tickets: [draft('Clean feature')] });
  const committed = await f.call('hud_tickets', { op: 'commit' });
  assert.equal(committed.committed, true);
  assert.deepEqual(committed.paths, ['.hud/tickets/clean.json']);
  assert.doesNotMatch(f.git(f.main, 'show', 'HEAD:.hud/tickets/shared.json'), /Owner hand edit A\./);
  assert.doesNotMatch(f.git(f.main, 'show', 'HEAD:.hud/tickets/flaky.json'), /Owner flaky hand edit\./);
  assert.throws(() => f.git(f.main, 'show', 'HEAD:.hud/tickets/uncom.json'));
  assert.match(fs.readFileSync(sharedPath, 'utf8'), /Owner hand edit A\./);
  assert.equal(readJsonTicketFeature(f.main, 'shared').tickets[1].accepted?.flow, 'q00000000000000b1');
  assert.match(fs.readFileSync(flakyPath, 'utf8'), /Owner flaky hand edit\./);
  assert.match(fs.readFileSync(uncomPath, 'utf8'), /Owner uncom edit A\./);
});

test('hud_tickets ready surfaces malformed canonical features as partial/unreadable while keeping healthy features', { timeout: 20_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  await f.call('hud_tickets', { op: 'add', feature: 'healthy', tickets: [draft('Healthy ready ticket')] });
  const brokenPath = ticketFeaturePath(f.main, 'broken');
  fs.writeFileSync(brokenPath, '{ broken json\n');

  const mixed = await f.call('hud_tickets', { op: 'ready' });
  assert.equal(mixed.ok, true);
  assert.deepEqual(mixed.tickets.map(item => item.ticket), ['healthy/01']);
  assert.equal(mixed.partial, true);
  assert.equal(mixed.unreadable.length, 1);
  assert.equal(mixed.unreadable[0].feature, 'broken');
  assert.equal(mixed.unreadable[0].path, brokenPath);
  assert.match(mixed.unreadable[0].error, /Cannot read ticket feature broken/);

  // Even with zero healthy tickets, ready does not fabricate a plain empty ok result.
  fs.unlinkSync(ticketFeaturePath(f.main, 'healthy'));
  const onlyBroken = await f.call('hud_tickets', { op: 'ready' });
  assert.equal(onlyBroken.ok, true);
  assert.deepEqual(onlyBroken.tickets, []);
  assert.equal(onlyBroken.partial, true);
  assert.deepEqual(onlyBroken.unreadable.map(u => u.feature), ['broken']);
});

test('sweepTicketWrites amend refuses when HEAD moved from expectedTip', { timeout: 15_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  await f.call('hud_tickets', { op: 'add', feature: 'tipcheck', tickets: [draft('Tip check')] });
  const headBefore = f.git(f.main, 'rev-parse', 'HEAD');
  const git = args => worktreeGit(f.main, args);
  await assert.rejects(
    () => sweepTicketWrites(f.main, f.home, git, { mode: 'amend', expectedTip: '0'.repeat(40) }),
    /Main checkout HEAD moved/,
  );
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), headBefore);
  assert.match(f.git(f.main, 'status', '--porcelain', '--', '.hud/tickets/tipcheck.json'), /^\?\?/);
});

test('unreadable source or archive sibling blocks Replaced by in ready (matching get), keeps waitSettled open, and fails hud tickets show', { timeout: 25_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  seedArchiveProject(f, [
    { version: 1, feature: 'sample', objective: 'selected', tickets: [record(2, 'ready-for-agent')] },
    { version: 1, feature: 'sample-done', objective: 'selected', tickets: [record(1, 'done'), record(3, 'done')] },
    { version: 1, feature: 'sample-done-2', objective: 'selected', tickets: [record(4, 'done')] },
    { version: 1, feature: 'other', tickets: [
      record(1, 'ready-for-agent', { blocked_by: ['other/02'] }),
      record(2, 'wontfix', { comments: [{ at, author: 'owner', text: 'Replaced by sample/03' }] }),
    ] },
  ]);
  const showTicket = async (arg) => {
    const cwd = process.cwd();
    let out = '', err = '';
    try {
      process.chdir(f.main);
      const code = await cliMain(['tickets', 'show', arg], { env: f.env, stdout: s => { out += s; }, stderr: s => { err += s; } });
      return { code, out, err };
    } finally {
      process.chdir(cwd);
    }
  };

  // Baseline: complete readable family resolves Replaced by, scanTicketStore, get, and hud tickets show.
  assert.ok((await f.call('hud_tickets', { op: 'ready' })).tickets.some(item => item.ticket === 'other/01'));
  assert.equal((await f.call('hud_tickets', { op: 'get', ticket: 'sample/03' })).feature, 'sample-done');
  assert.equal(scanTicketStore(f.main).resolve('sample/1'), 'sample-done/1');
  assert.equal((await showTicket('sample/01')).code, 0);

  for (const brokenSlug of ['sample', 'sample-done-2']) {
    const brokenPath = ticketFeaturePath(f.main, brokenSlug);
    const clean = fs.readFileSync(brokenPath, 'utf8');
    fs.writeFileSync(brokenPath, '{ broken json\n');
    try {
      const ready = await f.call('hud_tickets', { op: 'ready' });
      assert.equal(ready.tickets.some(item => item.ticket === 'other/01'), false, `${brokenSlug}: other/01 must stay blocked`);
      assert.ok(ready.blocked?.some(item => item.ticket === 'other/01'), `${brokenSlug}: other/01 listed in blocked`);
      const getRes = await f.rpc('tools/call', { name: 'hud_tickets', arguments: { op: 'get', ticket: 'sample/03' } });
      assert.equal(getRes.result.isError, true, `${brokenSlug}: get must fail`);
      assert.equal(scanTicketStore(f.main).resolve('sample/1'), undefined, `${brokenSlug}: resolve must refuse fallback`);
      const shown = await showTicket('sample/01');
      assert.notEqual(shown.code, 0, `${brokenSlug}: hud tickets show must fail`);
    } finally {
      fs.writeFileSync(brokenPath, clean);
    }
  }
});
