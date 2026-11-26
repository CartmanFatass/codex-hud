import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { assertLandingRecord, checkout, job, jobDir } from '../helpers/thin-mcp-land.mjs';
import { until } from '../helpers/thin-mcp-harness.mjs';

const draft = title => ({ title, what: 'Change the sample.', acceptance: ['Check the sample.'], blocked_by: [] });
const tickets = f => (op, args) => f.call('hud_tickets', { op, feature: 'sample', ...args });

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
  const { tickets: added } = await call('add', { tickets: ['First', 'Second', 'Third'].map(draft) });
  const paths = added.map(({ path }) => relative(f.main, path));
  const lastCommit = () => f.git(f.main, 'show', '--format=%s', '--name-only', 'HEAD').split('\n').filter(Boolean);
  assert.deepEqual(lastCommit(), ['tickets: sample/01 add', ...paths]);
  assert.equal(f.git(f.main, 'rev-list', '--count', `${f.base_head}..HEAD`), '1');
  assert.equal(status(paths[0]), '');

  // Even if a hand-edited ticket is named, it must not be swept into the HUD commit.
  fs.appendFileSync(added[2].path, '\nHand-edited comment.\n');
  const { updates } = await call('update', { updates: [
    { ticket: 1, status: 'claimed' }, { ticket: 3, status: 'done' },
    { ticket: 2, tick: [1] }, { ticket: 1, tick: [1] },
  ] });
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

test('a land after a ticket update succeeds, and a concurrent ticket edit waits for that land', { timeout: 20000 }, async t => {
  // Observe the actual wait in the MCP process rather than guessing from its wall-clock latency.
  const probe = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    const watch = fs.watch;
    fs.watch = (path, ...args) => {
      if (path === join(process.env.HUD_HOME, 'leases')) fs.writeFileSync(join(process.env.HOME, 'ticket-waiting'), '');
      return watch(path, ...args);
    };
    syncBuiltinESMExports();
  `;
  const f = await checkout(t, ['while test ! -f "$HOME/release"; do sleep .05; done'], { probe, after: [] });
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
  let returned = false;
  const queued = call('update', { ticket: 1, status: 'done' }).finally(() => { returned = true; });
  await until(() => returned || fs.existsSync(join(f.env.HOME, 'ticket-waiting')), t.signal);
  assert.equal(returned, false);
  assert.equal(fs.readFileSync(path, 'utf8'), before, 'the waiting call has not written the ticket');
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), base);

  fs.writeFileSync(join(f.env.HOME, 'release'), '');
  assert.equal((await queued).ok, true);
  const done = f.flowState(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD^'), done.landed_sha);
  assert.equal(f.git(f.main, 'log', '-1', '--format=%s'), 'tickets: sample/01 update');
  assert.match(f.git(f.main, 'show', `${done.landed_sha}:${rel}`), /\*\*Status:\*\* ready-for-human/);
  assert.match(f.git(f.main, 'show', `HEAD:${rel}`), /\*\*Status:\*\* done/);
  assertLandingRecord(f, rel, base, done.landed_sha);
  assert.equal(f.git(f.main, 'status', '--porcelain', '--', rel), '');
});
