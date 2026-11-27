import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { recordUnattendedAcceptance } from '../../dist/mcp/local-tickets.js';
import { landedNewest } from '../../dist/render/project-view.js';
import { writeReportMeta, cachedReportSignature } from '../../dist/roles/report-meta.js';
import { taskCall, taskRpc, until } from '../helpers/thin-mcp-harness.mjs';
import { assertLandingRecord, checkout, job, jobDir, seedJsonTickets } from '../helpers/thin-mcp-land.mjs';

const EMPTY_BOARD = { revision: 'synthetic', lanes: [], workers: [], decisions: [], coverage: { incomplete: false, diagnostics: [], workspace: '' } };

for (const dirty of [false, true]) test(`land ${dirty ? 'refuses to push dirty landed paths' : 'pushes only the approved commit'} after fast-forward`, async t => {
  const f = await checkout(t, ['true'], { after: ['while test ! -f "$HOME/release"; do sleep .05; done'] });
  const receipt = join(jobDir(f), 'job.json');
  fs.writeFileSync(receipt, JSON.stringify({ ...JSON.parse(fs.readFileSync(receipt)), ticket: 'feature/01' }));
  const ticket = seedJsonTickets(f, 'feature', [{ number: 1, title: 'Example ticket', status: 'claimed', acceptance: [] }]);
  f.git(f.main, 'add', ticket); f.git(f.main, 'commit', '-qm', 'seed records');
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).step.startsWith('after[1]'), t.signal);
  const { landed_sha, tested_sha, base_sha } = f.flowState(flow);
  assert.notEqual(landed_sha, tested_sha);
  fs.writeFileSync(join(f.main, 'unapproved'), 'unapproved code change\n');
  f.git(f.main, 'add', 'unapproved'); f.git(f.main, 'commit', '-qm', 'advance during after');
  const advanced = f.git(f.main, 'rev-parse', 'HEAD');
  if (dirty) fs.appendFileSync(join(f.main, 'tracked'), 'uncommitted owner edit\n');
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), t.signal);
  const done = f.flowState(flow);
  assert.equal(done.state, dirty ? 'failed' : 'completed', JSON.stringify(done));
  assert.equal(done.step, dirty ? 'push' : 'done');
  assert.equal(done.landed_sha, landed_sha);
  assert.equal(done.records_sha, undefined);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), advanced);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD^'), landed_sha);
  assertLandingRecord(f, ticket, base_sha, landed_sha);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), dirty ? f.base_head : landed_sha);
  assert.equal(fs.existsSync(f.worktree), dirty);
});

test('land fast-forwards a rebased worker branch with only its own commits beyond the base tip', async t => {
  const f = await checkout(t, ['true']);
  fs.writeFileSync(join(f.main, 'upstream'), 'new base\n');
  f.git(f.main, 'add', 'upstream'); f.git(f.main, 'commit', '-qm', 'advance base');
  const base = f.git(f.main, 'rev-parse', 'base');
  f.git(f.worktree, 'rebase', 'base');
  const source = f.git(f.worktree, 'rev-parse', 'HEAD');
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const done = f.flowState(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(done.landed_sha, source);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), source);
  assert.equal(f.git(f.main, 'log', '--reverse', '--format=%s', `${base}..base`), 'first\nsecond');
});

for (const [label, ownerTry, expectedStatus] of [
  ['false', false, 'done'],
  ['true', true, 'ready-for-human'],
]) test(`land folds ${expectedStatus} and its record into one commit without STATE.md change (owner_try ${label})`, async t => {
  const f = await checkout(t, ['true']), dir = jobDir(f), file = join(dir, 'job.json');
  // Squash the worker branch to one commit so we verify one commit on main per landed slice.
  f.git(f.worktree, 'reset', '--soft', f.base_head);
  f.git(f.worktree, 'commit', '-qm', 'single slice commit');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), ticket: 'feature/01', slice: 'FEATURE-01' }));
  fs.writeFileSync(join(dir, 'report.md'), '## Not done\n\n## Checks\n- Acceptance item 1 passed.\n');
  writeReportMeta(dir, cachedReportSignature(dir), { summary: 'Synthetic change.' });
  const initialState = '## Slices\n\n<!-- Row format -->\n\n- try · SAMPLE · SAMPLE-01 · Existing\n';
  const ticket = seedJsonTickets(f, 'feature', [
    {
      number: 1, title: 'Example ticket', status: 'ready-for-agent', owner_try: ownerTry,
      acceptance: [{ id: 1, text: 'first', done: false }, { id: 2, text: 'second', done: false }],
      comments: [{ at: '2026-01-01T00:00:00.000Z', author: 'main', text: 'preserve me' }],
    },
    {
      number: 2, title: 'Legacy ticket', status: 'ready-for-human', owner_try: true, acceptance: [],
      landing: { at: '2026-01-01T00:00:00.000Z', job: 'j0000000000000001', flow: 'f0000000000000001', replay_base: f.base_head, gates: 1, commit: f.base_head.slice(0, 8) },
    },
  ]);
  fs.writeFileSync(join(f.main, 'STATE.md'), initialState);
  f.git(f.main, 'add', '.hud/tickets', 'STATE.md'); f.git(f.main, 'commit', '-qm', 'seed tickets and state');
  const beforeBase = f.git(f.main, 'rev-parse', 'HEAD');
  fs.writeFileSync(join(f.main, 'owner'), 'unrelated staged edit'); f.git(f.main, 'add', 'owner');
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), t.signal);
  const done = f.flowState(flow); assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(done.records_sha, undefined);
  assert.equal(done.unfinished_acceptance, undefined);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), done.landed_sha);
  assert.equal(f.git(f.main, 'rev-parse', 'base'), done.landed_sha);
  assert.equal(f.git(f.remote, 'rev-list', '--count', `${beforeBase}..base`), '1');
  assert.equal(f.git(f.remote, 'log', '-1', '--format=%s', 'base'), 'single slice commit');
  assert.equal(f.git(f.main, 'diff', '--cached', '--name-only'), 'owner');
  assert.deepEqual(f.git(f.remote, 'diff', '--name-only', beforeBase, 'base').split('\n').sort(), [ticket, 'tracked']);
  const doc = JSON.parse(f.git(f.remote, 'show', `base:${ticket}`));
  const rec1 = doc.tickets.find(t => t.number === 1);
  assert.equal(rec1.status, expectedStatus);
  assert.deepEqual(rec1.acceptance.map(item => item.done), [true, true]);
  assert.equal(rec1.comments[0]?.text, 'preserve me');
  assertLandingRecord(f, ticket, beforeBase, done.landed_sha);
  assert.equal(f.git(f.remote, 'show', 'base:STATE.md') + '\n', initialState);
  const project = await new ProjectCollector(f.main, f.home, f.env, f.env.HOME).collect(true, EMPTY_BOARD, Date.now());
  const latest = landedNewest(project).map(({ r }) => r);
  const fresh = latest.find(r => r.id === 'FEATURE-01');
  assert.equal(fresh?.landed, true);
  assert.equal(fresh?.state, expectedStatus === 'done' ? 'accepted' : 'try');
  assert.equal(latest.find(r => r.id === 'FEATURE-02')?.state, 'try');
});

for (const source of ['report', 'lead', 'owner try']) test(`land lists and leaves unticked the JSON acceptance item named by ${source}`, async t => {
  const f = await checkout(t, ['true']), dir = jobDir(f);
  const ticket = '.hud/tickets/feature.json', id = 7;
  const queue = 'q0000000000000001', lead = 'j0000000000000002', ownerTry = source === 'owner try';
  const receipt = join(dir, 'job.json');
  fs.writeFileSync(receipt, JSON.stringify({ ...JSON.parse(fs.readFileSync(receipt)), ticket: 'feature/01',
    ...(source === 'lead' && { ticket_queue: queue }),
  }));
  if (source === 'lead') {
    fs.mkdirSync(join(f.home, 'flows'), { recursive: true });
    fs.writeFileSync(join(f.home, 'flows', `${queue}.json`), JSON.stringify({
      flow: queue, tickets: [{ ticket: 'feature/01', job }, { ticket: 'feature/02' }],
      todo: [
        { kind: 'lead', source: `lead (${lead})`, text: 'feature/01: leave “Test the `fallback` path.” unticked.' },
        { kind: 'lead', source: `lead (${lead})`, text: 'feature/02: leave item 2 unticked until feature/01 lands.' },
      ],
    }));
  }
  fs.writeFileSync(join(dir, 'report.md'), source === 'report'
    ? `## Not done\n- Acceptance item ${id}: fallback still pending.\n\n## Checks\n- Acceptance item 2 passed.\n`
    : ownerTry ? `3. **Not done:** #${id}: pending owner try.\n4. Open questions: none.\n` : '## Not done\n');
  const file = join(f.main, ticket);
  seedJsonTickets(f, 'feature', [{
    number: 1, title: 'Example', status: 'ready-for-agent', owner_try: ownerTry, what: 'Support a fallback.',
    acceptance: [{ id, text: 'Test the `fallback` path.', done: false }, { id: 2, text: 'Test the common path.', done: false }],
  }]);
  f.git(f.main, 'add', ticket); f.git(f.main, 'commit', '-qm', 'seed ticket');
  // The commit subject alone must not let the board infer a completed ticket.
  f.git(f.worktree, 'commit', '--amend', '-qm', 'feature/01: implement');
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const done = await f.call('hud_read', { job: flow });
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.deepEqual(done.unfinished_acceptance, [{ id, text: 'Test the `fallback` path.' }]);
  assert.ok(done.changes.find(line => line.includes(flow))?.includes(`Acceptance left unticked: #${id} Test the \`fallback\` path.`));
  const expectedStatus = ownerTry ? 'ready-for-human' : 'ready-for-agent';
  const body = f.git(f.remote, 'show', `base:${ticket}`);
  const [record] = JSON.parse(body).tickets;
  assert.equal(record.status, expectedStatus);
  assert.equal(record.landing.flow, flow);
  assert.equal(record.landing.replay_base, f.flowState(flow).base_sha);
  assert.deepEqual(record.acceptance.map(item => [item.id, item.done]), [[id, false], [2, true]]);
  const project = await new ProjectCollector(f.main, f.home, f.env, f.env.HOME).collect(true, EMPTY_BOARD, Date.now());
  const row = project.ledger.find(r => r.id === 'FEATURE-01');
  assert.equal(row?.state, ownerTry ? 'try' : 'todo');
  assert.equal(row?.landed, true);
  const ready = await f.call('hud_tickets', { op: 'ready' });
  assert.equal(ready.tickets.some(t => t.ticket === 'feature/01'), !ownerTry);
  await recordUnattendedAcceptance(f.main, f.home, () => [{ path: file, ticket: 'feature/01' }], queue, 'accept');
  assert.equal(fs.readFileSync(file, 'utf8').trimEnd(), body, 'lead acceptance cannot close the unfinished ticket');
});

test('land cleanup removes clean source worktree when picked patch differs from source commit', async t => {
  const f = await checkout(t, ['true']);
  fs.writeFileSync(join(f.main, 'ticket.md'), 'status: open\n\nline 1\nline 2\nline 3\nitem: a\n');
  f.git(f.main, 'add', 'ticket.md'); f.git(f.main, 'commit', '-qm', 'add ticket');
  f.git(f.worktree, 'rebase', 'base');
  // Base advances the status line that the source commit also changes to the same value.
  fs.writeFileSync(join(f.main, 'ticket.md'), 'status: ready\n\nline 1\nline 2\nline 3\nitem: a\n');
  f.git(f.main, 'commit', '-qam', 'advance status on base');
  fs.writeFileSync(join(f.worktree, 'ticket.md'), 'status: ready\n\nline 1\nline 2\nline 3\nitem: b\n');
  f.git(f.worktree, 'commit', '-qam', 'update ticket and item');
  const sourceSha = f.git(f.worktree, 'rev-parse', 'HEAD');
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const done = await f.call('hud_read', { job: flow });
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(done.step, 'done');
  assert.equal(done.error, undefined);
  assert.equal(done.cleanup_note, undefined);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), done.landed_sha);
  assert.equal(f.git(f.main, 'show', 'base:ticket.md'), 'status: ready\n\nline 1\nline 2\nline 3\nitem: b');
  assert.equal(f.git(f.main, 'rev-list', '--cherry-pick', '--right-only', '-1', `${done.landed_sha}...${sourceSha}`), sourceSha);
  assert.equal(fs.existsSync(f.worktree), false);
  assert.equal(f.git(f.main, 'branch', '--list', f.branch), '');
  assert.equal(f.git(f.main, 'worktree', 'list', '--porcelain').split('worktree ').length, 2);
  const receipt = JSON.parse(fs.readFileSync(join(jobDir(f), 'job.json'), 'utf8'));
  assert.ok(receipt.worktree_removed_at);
  assert.equal(receipt.worktree_kept_reason, undefined);
});

test('a cleanup error after push completes as landed with a cleanup note, not failed', async t => {
  const f = await checkout(t, ['true']);
  fs.writeFileSync(join(f.worktree, 'untracked-note.txt'), 'keep me\n');
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const done = await f.call('hud_read', { job: flow });
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(done.step, 'done');
  assert.equal(done.error, undefined);
  assert.match(done.cleanup_note ?? '', /dirty/);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), done.landed_sha);
  assert.equal(done.changes.filter(s => s.includes(flow)).length, 1);
  assert.match(done.changes.find(s => s.includes(flow)) ?? '', new RegExp(`completed: done ${done.landed_sha} \\| Cleanup note: .*dirty`));
  assert.equal(fs.readFileSync(join(f.worktree, 'untracked-note.txt'), 'utf8'), 'keep me\n');
  assert.equal(f.git(f.main, 'branch', '--list', '--format=%(refname:short)', f.branch), f.branch);
  assert.equal(f.git(f.main, 'worktree', 'list', '--porcelain').split('worktree ').length, 3);
  const receipt = JSON.parse(fs.readFileSync(join(jobDir(f), 'job.json'), 'utf8'));
  assert.match(receipt.worktree_kept_reason ?? '', /dirty/);
  assert.equal((await f.call('hud_land', { job })).flow, flow);
});

test('land cleanup preserves commits added to the source worktree after landing and still reports completed with a note', async t => {
  const f = await checkout(t, ['true']);
  const configFile = join(f.main, '.hud/project.json'), config = JSON.parse(fs.readFileSync(configFile));
  config.land.after = [`echo extra > ${JSON.stringify(join(f.worktree, 'extra'))} && git -C ${JSON.stringify(f.worktree)} add extra && git -C ${JSON.stringify(f.worktree)} commit -qm extra`];
  fs.writeFileSync(configFile, JSON.stringify(config));
  const rpc = taskRpc(f.rpc); await rpc('server/discover');
  const { taskId: flow } = await taskCall(rpc, 'hud_land', { job });
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const state = f.flowState(flow);
  assert.equal(state.state, 'completed', JSON.stringify(state));
  assert.equal(state.error, undefined);
  assert.match(state.cleanup_note ?? '', /unmerged commits/);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), state.landed_sha);
  const done = await rpc('tasks/get', { taskId: flow });
  assert.equal(done.status, 'completed');
  assert.match(done.result.content[0].text, new RegExp(`completed: done ${state.landed_sha}\\nCleanup note: .*unmerged commits`));
  assert.equal(fs.existsSync(join(f.worktree, 'extra')), true);
  assert.equal(f.git(f.main, 'branch', '--list', '--format=%(refname:short)', f.branch), f.branch);
});

for (const dirty of [false, true]) test(`land publishes completed and done in one atomic flow write (${dirty ? 'with cleanup note' : 'clean worktree'})`, async t => {
  const preload = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.renameSync;
const pause = new Int32Array(new SharedArrayBuffer(4));
fs.renameSync = (from, to) => {
  rename(from, to);
  const target = String(to);
  if (!target.startsWith(process.env.HUD_HOME + '/flows/') || !target.endsWith('.json')) return;
  const flow = JSON.parse(fs.readFileSync(target, 'utf8'));
  const receipt = JSON.parse(fs.readFileSync(process.env.HUD_HOME + '/jobs/' + flow.job + '/job.json', 'utf8'));
  fs.appendFileSync(process.env.HOME + '/flow-writes.jsonl', JSON.stringify({
    state: flow.state,
    step: flow.step,
    cleanup_note: flow.cleanup_note ?? null,
    cleanup_timed: Boolean(flow.timings?.some(e => e.step === 'cleanup' && e.ok)),
    worktree_removed_at: Boolean(receipt.worktree_removed_at),
    worktree_kept_reason: receipt.worktree_kept_reason ?? null,
  }) + '\\n');
  const seen = process.env.HOME + '/completed-seen';
  const release = process.env.HOME + '/completed-release';
  if (flow.state === 'completed' && !fs.existsSync(seen)) {
    fs.writeFileSync(seen, '1');
    for (let i = 0; i < 1000 && !fs.existsSync(release); i++) Atomics.wait(pause, 0, 0, 10);
  }
};
syncBuiltinESMExports();`;
  const f = await checkout(t, ['true'], {
    probe: `process.env.NODE_OPTIONS += ${JSON.stringify(' --import=data:text/javascript,' + encodeURIComponent(preload))};`,
  });
  if (dirty) fs.writeFileSync(join(f.worktree, 'untracked-note.txt'), 'keep me\n');
  const seen = join(f.env.HOME, 'completed-seen'), release = join(f.env.HOME, 'completed-release');
  const { flow } = await f.call('hud_land', { job });
  let firstRead, firstReceipt;
  try {
    await until(() => {
      if (fs.existsSync(seen)) return true;
      const state = f.flowState(flow);
      assert.notEqual(state.state, 'failed', JSON.stringify(state));
      assert.notEqual(state.state, 'cancelled', JSON.stringify(state));
      return false;
    }, t.signal);
    firstRead = await f.call('hud_read', { job: flow });
    firstReceipt = JSON.parse(fs.readFileSync(join(jobDir(f), 'job.json'), 'utf8'));
  } finally {
    fs.writeFileSync(release, 'go');
  }
  assert.equal(firstRead.state, 'completed', JSON.stringify(firstRead));
  assert.equal(firstRead.step, 'done', JSON.stringify(firstRead));
  assert.equal(firstRead.timings?.some(e => e.step === 'cleanup' && e.ok), true, JSON.stringify(firstRead.timings));
  if (dirty) {
    assert.match(firstRead.cleanup_note ?? '', /dirty/);
    assert.match(firstReceipt.worktree_kept_reason ?? '', /dirty/);
    assert.equal(firstReceipt.worktree_removed_at, undefined);
  } else {
    assert.equal(firstRead.cleanup_note, undefined);
    assert.ok(firstReceipt.worktree_removed_at);
    assert.equal(firstReceipt.worktree_kept_reason, undefined);
  }
  assert.equal((await f.call('hud_lease', { name: 'main-checkout', wait_s: 5 })).granted, true);
  const writes = fs.readFileSync(join(f.env.HOME, 'flow-writes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const completed = writes.filter(row => row.state === 'completed');
  assert.equal(completed.length, 1, JSON.stringify(completed));
  assert.equal(completed[0].step, 'done', JSON.stringify(completed[0]));
  assert.equal(completed[0].cleanup_timed, true, JSON.stringify(completed[0]));
  if (dirty) assert.match(completed[0].cleanup_note ?? '', /dirty/);
  else assert.equal(completed[0].worktree_removed_at, true);
});

test('a main commit on unrelated paths including STATE.md during the gate replays tested commits and ticket update without rerunning the gate', async t => {
  const f = await checkout(t, ['echo run >> "$HOME/gate-count"; while test ! -f "$HOME/release"; do sleep .05; done']);
  const dir = jobDir(f), file = join(dir, 'job.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), ticket: 'feature/01', slice: 'FEATURE-01' }));
  fs.writeFileSync(join(dir, 'report.md'), 'Report'); writeReportMeta(dir, cachedReportSignature(dir), { summary: 'Synthetic change.' });
  const ticket = seedJsonTickets(f, 'feature', [{ number: 1, title: 'Example ticket', status: 'claimed', acceptance: [{ id: 1, text: 'first', done: false }] }]);
  fs.writeFileSync(join(f.main, 'STATE.md'), '## Slices\n\n<!-- Row format -->\n\n- try · SAMPLE · SAMPLE-01 · Existing\n');
  f.git(f.main, 'add', ticket, 'STATE.md'); f.git(f.main, 'commit', '-qm', 'seed records');
  const beforeBase = f.git(f.main, 'rev-parse', 'HEAD');
  const rpc = taskRpc(f.rpc); await rpc('server/discover');
  const { taskId: flow } = await taskCall(rpc, 'hud_land', { job });
  await until(() => f.flowState(flow).step.startsWith('gate[1]'), t.signal);
  // Commit an unrelated ticket and STATE.md milestone edit on main while the gate is running.
  const other = seedJsonTickets(f, 'other', [{ number: 2, title: 'Unrelated', status: 'claimed', acceptance: [] }]);
  fs.appendFileSync(join(f.main, 'STATE.md'), '\nMilestone boundary note\n');
  fs.mkdirSync(join(f.main, 'docs/handoff'), { recursive: true });
  fs.writeFileSync(join(f.main, 'docs/handoff/STATE.md'), 'Milestone handoff\n');
  f.git(f.main, 'add', other, 'STATE.md', 'docs/handoff/STATE.md');
  f.git(f.main, 'commit', '-qm', 'unrelated ticket and state');
  const movedBase = f.git(f.main, 'rev-parse', 'HEAD');
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const state = f.flowState(flow);
  assert.equal(state.state, 'completed', JSON.stringify(state));
  assert.equal(state.step, 'done');
  assert.equal(state.repairs, undefined);
  assert.equal(state.records_sha, undefined);
  assert.equal(state.replayed_onto, movedBase);
  assert.equal(state.tested_tree, f.git(f.main, 'rev-parse', `${state.tested_sha}^{tree}`));
  assert.equal(state.published_tree, f.git(f.remote, 'rev-parse', 'base^{tree}'));
  assert.notEqual(state.tested_tree, state.published_tree);
  assert.equal(fs.readFileSync(join(f.env.HOME, 'gate-count'), 'utf8'), 'run\n');
  const done = await rpc('tasks/get', { taskId: flow });
  assert.equal(done.status, 'completed');
  assert.match(done.result.content[0].text, new RegExp(`Replayed onto ${movedBase} \\(base moved from ${beforeBase}\\)`));
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), state.landed_sha);
  assert.equal(f.git(f.main, 'rev-parse', 'base'), state.landed_sha);
  assert.equal(f.git(f.remote, 'rev-list', '--count', `${movedBase}..base`), '2');
  assert.equal(f.git(f.main, 'merge-base', movedBase, state.landed_sha), movedBase);
  assert.match(f.git(f.remote, 'show', `base:${other}`), /Unrelated/);
  assertLandingRecord(f, ticket, movedBase, state.landed_sha);
  assert.match(f.git(f.remote, 'show', 'base:STATE.md'), /Milestone boundary note/);
  assert.doesNotMatch(f.git(f.remote, 'show', 'base:STATE.md'), /FEATURE-01/);
  assert.equal(fs.readFileSync(join(f.main, 'after-ran'), 'utf8').trim(), f.main);
  assert.equal(fs.existsSync(f.worktree), false);
  assert.equal(f.git(f.main, 'branch', '--list', f.branch), '');
  assert.equal(f.git(f.main, 'worktree', 'list', '--porcelain').split('worktree ').length, 2);
});

for (const green of [true, false]) test(`land re-gates disjoint code changes and ${green ? 'pushes the gated candidate' : 'stops when they break the gate'}`, async t => {
  const f = await checkout(t, ['git rev-parse HEAD >> "$HOME/gate-heads"; while test ! -f "$HOME/release"; do sleep .05; done; test "$(tail -1 tracked)" = "$(cat contract)"']);
  // The source's change to tracked depends on a contract in a different file.
  const receipt = join(jobDir(f), 'job.json');
  fs.writeFileSync(receipt, JSON.stringify({ ...JSON.parse(fs.readFileSync(receipt)), ticket: 'feature/01' }));
  const ticket = seedJsonTickets(f, 'feature', [{ number: 1, title: 'Example ticket', status: 'claimed', acceptance: [] }]);
  fs.writeFileSync(join(f.main, 'contract'), 'second\n');
  f.git(f.main, 'add', 'contract', ticket); f.git(f.main, 'commit', '-qm', 'seed contract and ticket');
  const { flow } = await f.call('hud_land', { job });
  await until(() => fs.existsSync(join(f.env.HOME, 'gate-heads')), t.signal);
  fs.writeFileSync(join(f.main, 'contract'), green ? 'second\n\n' : 'incompatible\n');
  f.git(f.main, 'commit', '-qam', 'change contract on base');
  const movedBase = f.git(f.main, 'rev-parse', 'HEAD');
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const state = f.flowState(flow);
  const heads = fs.readFileSync(join(f.env.HOME, 'gate-heads'), 'utf8').trim().split('\n');
  const [initial, candidate] = heads;
  assert.notEqual(candidate, initial);
  if (green) {
    assert.equal(state.state, 'completed', JSON.stringify(state));
    assert.deepEqual(heads, [initial, candidate]);
    const view = await f.call('hud_read', { job: flow });
    assert.equal(view.base_moves, 1);
    assert.match(view.changes.find(line => line.includes(flow)), /Base moves absorbed: 1/);
    assert.equal(state.replayed_onto, movedBase);
    assert.equal(state.tested_tree, f.git(f.main, 'rev-parse', `${candidate}^{tree}`));
    assert.equal(state.published_tree, f.git(f.remote, 'rev-parse', 'base^{tree}'));
    assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), state.landed_sha);
    assert.equal(f.git(f.remote, 'rev-parse', 'base'), state.landed_sha);
    assertLandingRecord(f, ticket, movedBase, state.landed_sha);
  } else {
    assert.equal(state.published_tree, f.git(f.main, 'rev-parse', `${candidate}^{tree}`));
    assert.equal(state.state, 'failed', JSON.stringify(state));
    assert.match(state.step, /^gate\[1\]:/);
    assert.deepEqual(heads, [initial, candidate, candidate]); // One immediate retry of the failed command.
    assert.equal(state.tested_tree, f.git(f.main, 'rev-parse', `${initial}^{tree}`));
    assert.notEqual(state.tested_tree, state.published_tree);
    assert.equal(state.landed_sha, undefined);
    assert.equal(state.repairs, undefined);
    assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), movedBase);
    assert.equal(f.git(f.remote, 'rev-parse', 'base'), f.base_head);
  }
});

for (const moves of [2, 3]) test(`land ${moves === 2 ? 'absorbs another move during the replay gate' : 'stops at the base move limit'}`, { timeout: 30_000 }, async t => {
  const f = await checkout(t, [`run=1; while test -f "$HOME/gate-$run"; do run=$((run+1)); done
    git rev-parse HEAD > "$HOME/gate-$run"
    while test ! -f "$HOME/release-$run"; do sleep .05; done`]);
  const { flow } = await f.call('hud_land', { job });
  for (const run of [1, 2, 3]) {
    await until(() => fs.existsSync(join(f.env.HOME, `gate-${run}`)), t.signal);
    if (run <= moves) {
      fs.writeFileSync(join(f.main, `unrelated-${run}`), `Synthetic ${run}\n`);
      f.git(f.main, 'add', `unrelated-${run}`);
      f.git(f.main, 'commit', '-qm', `base move ${run}`);
    }
    fs.writeFileSync(join(f.env.HOME, `release-${run}`), 'go');
  }
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), t.signal);
  const state = f.flowState(flow);
  assert.equal(state.base_moves, 2);
  assert.equal(fs.existsSync(join(f.env.HOME, 'gate-4')), false);
  if (moves === 2) {
    assert.equal(state.state, 'completed', JSON.stringify(state));
    assert.equal(state.landed_sha, fs.readFileSync(join(f.env.HOME, 'gate-3'), 'utf8').trim());
    assert.equal(f.git(f.remote, 'rev-parse', 'base'), state.landed_sha);
    for (const n of [1, 2]) assert.equal(f.git(f.remote, 'show', `base:unrelated-${n}`), `Synthetic ${n}`);
  } else {
    assert.equal(state.state, 'failed', JSON.stringify(state));
    assert.match(state.error, /base move retry limit reached/);
    assert.equal(state.landed_sha, undefined);
    assert.equal(f.git(f.main, 'log', '-1', '--format=%s'), 'base move 3');
    assert.equal(f.git(f.remote, 'rev-parse', 'base'), f.base_head);
  }
});

test('a main commit touching the landing ticket path during the gate replays without rerunning the gate and preserves the concurrent edit', async t => {
  const f = await checkout(t, ['echo run >> "$HOME/gate-count"; while test ! -f "$HOME/release"; do sleep .05; done']);
  const dir = jobDir(f), file = join(dir, 'job.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), ticket: 'feature/01', slice: 'FEATURE-01' }));
  fs.writeFileSync(join(dir, 'report.md'), 'Report'); writeReportMeta(dir, cachedReportSignature(dir), { summary: 'Synthetic change.' });
  const ticket = seedJsonTickets(f, 'feature', [{ number: 1, title: 'Example ticket', status: 'ready-for-agent', acceptance: [{ id: 1, text: 'first', done: false }] }]);
  f.git(f.main, 'add', ticket); f.git(f.main, 'commit', '-qm', 'seed ticket');
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).step.startsWith('gate[1]'), t.signal);
  const edited = JSON.parse(fs.readFileSync(join(f.main, ticket), 'utf8'));
  edited.tickets[0].comments.push({ at: '2026-01-01T00:01:00.000Z', author: 'main', text: 'Concurrent ticket note' });
  fs.writeFileSync(join(f.main, ticket), JSON.stringify(edited, null, 2) + '\n');
  f.git(f.main, 'commit', '-qam', 'edit ticket during gate');
  const movedBase = f.git(f.main, 'rev-parse', 'HEAD');
  fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const state = f.flowState(flow);
  assert.equal(state.state, 'completed', JSON.stringify(state));
  assert.equal(state.step, 'done');
  assert.equal(state.replayed_onto, movedBase);
  assert.equal(fs.readFileSync(join(f.env.HOME, 'gate-count'), 'utf8'), 'run\n');
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), state.landed_sha);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), state.landed_sha);
  assert.match(f.git(f.remote, 'show', `base:${ticket}`), /Concurrent ticket note/);
  assertLandingRecord(f, ticket, movedBase, state.landed_sha);
});
