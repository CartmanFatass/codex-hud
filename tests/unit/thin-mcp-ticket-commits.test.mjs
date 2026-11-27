import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { main as cliMain } from '../../dist/cli/hud.js';
import { recordUnattendedAcceptance } from '../../dist/mcp/local-tickets.js';
import { takeLease } from '../../dist/roles/lease.js';
import { readJsonTicketFeature, readTicketWrites, ticketFeaturePath } from '../../dist/tickets/store.js';
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

test('removed ticket-commits and receipt-queue modules stay absent', () => {
  for (const rel of ['src/mcp/ticket-commits.ts', 'src/mcp/ticket-edit-queue.ts', 'src/mcp/ticket-edit-state.ts']) {
    assert.equal(fs.existsSync(rel), false, `${rel} must be removed`);
  }
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

test('an owner hand edit on the landing ticket feature itself is never overwritten or swept', { timeout: 25_000 }, async t => {
  const f = await checkout(t, ['true'], { after: [] });
  await f.call('hud_tickets', { op: 'add', feature: 'sample', tickets: [draft('Hand-edited landing feature')] });
  await f.call('hud_tickets', { op: 'commit' });
  const samplePath = ticketFeaturePath(f.main, 'sample');
  const handEdited = fs.readFileSync(samplePath, 'utf8').replace('Change Hand-edited landing feature.', 'Owner local hand edit.');
  fs.writeFileSync(samplePath, handEdited);
  setJobTicket(f, 'sample/01');

  const baseBeforeLand = f.git(f.main, 'rev-parse', 'HEAD');
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['completed', 'failed'].includes(f.flowState(flow).state), t.signal);
  const done = f.flowState(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(fs.readFileSync(samplePath, 'utf8'), handEdited, 'hand edit preserved on disk');
  assert.match(f.git(f.main, 'status', '--porcelain', '--', '.hud/tickets/sample.json'), /^M /);
  assert.deepEqual(f.git(f.remote, 'diff', '--name-only', baseBeforeLand, 'base').split('\n'), ['tracked']);
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
    await recordUnattendedAcceptance(f.main, f.home, () => [{ path, ticket: 'unatt/02' }], flow2, 'finish: Verified slice 2.');
    assert.ok(performance.now() - t0 < 2000, 'commit attempt must be non-blocking when lease is held');
    const doc2 = readJsonTicketFeature(f.main, 'unatt');
    assert.equal(doc2.tickets[1].status, 'done');
    assert.equal(doc2.tickets[1].accepted?.flow, flow2);
    assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), headWhileHeld, 'no commit while lease is held');
    assert.match(f.git(f.main, 'status', '--porcelain', '--', relative(f.main, path)), /^M /);
  } finally {
    await takeLease({ name: 'main-checkout', release: true }, lease);
  }
});
