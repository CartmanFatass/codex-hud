import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { takeLease } from '../../dist/roles/lease.js';
import { readTicketWrites, serializeTicketFeature, ticketWritesPath, validateTicketFeature } from '../../dist/tickets/store.js';
import { checkout, job } from '../helpers/thin-mcp-land.mjs';
import { until } from '../helpers/thin-mcp-harness.mjs';

const draft = title => ({ title, what: 'Change the sample.', acceptance: ['Check the sample.'], blocked_by: [] });
const sha256 = text => createHash('sha256').update(text).digest('hex');
async function fast(call) {
  const start = performance.now();
  const value = await call();
  assert.ok(performance.now() - start < 1000, 'ticket store reply must arrive within one second');
  return value;
}

function seedMarkdown(f) {
  const rel = '.scratch/legacy/issues/01-existing.md', path = join(f.main, rel);
  fs.mkdirSync(join(f.main, '.scratch/legacy/issues'), { recursive: true });
  fs.writeFileSync(path, '# 01: Existing\n\n**Status:** ready-for-agent\n**Blocked by:** none\n\n**What to build:** Change it.\n\n- [ ] Check it.\n');
  f.git(f.main, 'add', rel);
  f.git(f.main, 'commit', '-qm', 'Seed legacy ticket');
  return { rel, path };
}

test('ticket documents have deterministic nested keys, sorted ticket numbers and a 64 KiB limit', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const first = { number: 1, title: 'One', status: 'done', owner_try: false, approved_removals: [], blocked_by: [], live_try: 'none',
    what: 'Change it.', acceptance: [{ id: 1, text: 'Checked', done: true }], comments: [], updated_at: at, created_at: at };
  const second = { ...first, number: 2, title: 'Two', blocked_by: ['sample/01'] };
  const doc = { feature: 'sample', version: 1, tickets: [second, first] };
  const reverseKeys = object => Object.fromEntries(Object.entries(object).reverse());
  const reordered = { version: 1, feature: 'sample', tickets: [{ ...reverseKeys(first), acceptance: [reverseKeys(first.acceptance[0])] }, reverseKeys(second)] };
  const bytes = serializeTicketFeature(doc);
  assert.equal(bytes, serializeTicketFeature(reordered));
  assert.deepEqual(JSON.parse(bytes).tickets.map(t => t.number), [1, 2]);
  assert.deepEqual(doc.tickets.map(t => t.number), [2, 1]);
  assert.throws(() => validateTicketFeature(doc, 'other'), /does not match filename/);
  assert.throws(() => serializeTicketFeature({ ...doc, tickets: [first, first] }), /duplicate ticket number/);
  assert.throws(() => serializeTicketFeature({ ...doc, tickets: [{ ...first, what: '界'.repeat(24_000) }] }), /exceeds 64 KiB/);
});

test('ticket add, update, get and mixed ready work from a linked checkout with the main-checkout lease held and no Git', async t => {
  const f = await checkout(t, ['true']);
  seedMarkdown(f);
  const base = f.git(f.main, 'rev-parse', 'HEAD');
  assert.ok((await f.rpc('initialize')).result);
  const call = (op, args) => f.call('hud_tickets', { op, feature: 'sample', cwd: f.worktree, ...args });
  const lease = { cwd: f.main, home: f.home, holder: 'synthetic-land' };
  assert.deepEqual(await takeLease({ name: 'main-checkout', wait_s: 0 }, lease), { granted: true });
  const gitLog = join(f.root, 'git-attempt'), shim = join(f.root, 'bin/git');
  f.overrideBin('git', `#!/bin/sh\nprintf '%s\\n' "$*" >> '${gitLog}'\nexit 7\n`);
  const path = join(f.main, '.hud/tickets/sample.json');
  try {
    const add = await fast(() => call('add', { tickets: [draft('First'), { ...draft('Second'), blocked_by: [1] },
      { ...draft('Third'), blocked_by: [1, 2] }] }));
    assert.deepEqual(add, { ok: true, tickets: [1, 2, 3].map(number => ({ number, path })) });
    assert.deepEqual(await fast(() => call('update', { ticket: 1, status: 'done', tick: [1] })), { ok: true, number: 1, path });
    const { ticket } = await fast(() => call('get', { ticket: 'sample/01' }));
    assert.equal(ticket.status, 'done');
    assert.equal(ticket.acceptance[0].done, true);
    const { feature } = await fast(() => call('get'));
    assert.equal(feature.version, 1);
    assert.deepEqual(feature.tickets.map(t => t.number), [1, 2, 3]);
    assert.deepEqual((await fast(() => call('ready'))).tickets.map(t => t.ticket).sort(), ['legacy/01', 'sample/02']);
    assert.equal(fs.existsSync(gitLog) ? fs.readFileSync(gitLog, 'utf8') : '', '', 'JSON operations never invoke Git');
  } finally {
    fs.unlinkSync(shim);
    await takeLease({ name: 'main-checkout', release: true }, lease);
  }
  const bytes = fs.readFileSync(path, 'utf8');
  assert.match(bytes, /^\{\n  "version": 1,\n  "feature": "sample",\n  "tickets": \[/);
  assert.deepEqual(readTicketWrites(f.home, f.main), { sample: sha256(bytes) });
  assert.equal(fs.statSync(ticketWritesPath(f.home, f.main)).mode & 0o777, 0o600);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), base);
  assert.match(f.git(f.main, 'status', '--porcelain', '--', '.hud/tickets'), /^\?\?/);
  assert.equal(fs.existsSync(join(f.worktree, '.hud/tickets')), false);

  fs.writeFileSync(path, bytes.replace('Change the sample.', 'Hand-edited prose.'));
  await call('update', { ticket: 1, tick: [1] });
  assert.match(fs.readFileSync(path, 'utf8'), /Hand-edited prose/);
  assert.deepEqual(readTicketWrites(f.home, f.main), { sample: sha256(bytes) }, 'no-op edit does not claim a hand edit');
});

test('an add returns its JSON ticket number while the land gate is still running', { timeout: 20_000 }, async t => {
  const release = 'release-gate';
  const f = await checkout(t, [`while test ! -f "$HOME/${release}"; do sleep .05; done`], { after: [] });
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).step.startsWith('gate[1]'), t.signal);
  try {
    const add = await fast(() => f.call('hud_tickets', { op: 'add', feature: 'sample', tickets: [draft('Gate-time ticket')] }));
    assert.deepEqual(add.tickets, [{ number: 1, path: join(f.main, '.hud/tickets/sample.json') }]);
    assert.ok(f.flowState(flow).step.startsWith('gate[1]'));
    assert.deepEqual(fs.readdirSync(join(f.home, 'flows')).filter(name => /^te/.test(name)), []);
  } finally {
    fs.writeFileSync(join(f.env.HOME, release), '');
  }
  await until(() => ['completed', 'failed'].includes(f.flowState(flow).state), t.signal);
  assert.equal(f.flowState(flow).state, 'completed');
});

test('a mixed update queues only the Markdown items while JSON updates finish', { timeout: 20_000 }, async t => {
  const f = await checkout(t, ['true']);
  const { rel, path } = seedMarkdown(f);
  const call = (op, args) => f.call('hud_tickets', { op, feature: 'sample', cwd: f.worktree, ...args });
  const { tickets: [added] } = await call('add', { tickets: [draft('JSON ticket')] });
  const lease = { cwd: f.main, home: f.home, holder: 'synthetic-land' };
  assert.deepEqual(await takeLease({ name: 'main-checkout', wait_s: 0 }, lease), { granted: true });
  let receipt;
  try {
    const { updates } = await call('update', { updates: [
      { feature: 'legacy', ticket: 1, status: 'claimed' },
      { ticket: 1, status: 'done' },
      { feature: 'legacy', ticket: 1, tick: [1] },
    ] });
    receipt = updates[0].receipt;
    assert.match(receipt, /^te[0-9a-f]{32}$/);
    const queued = { ok: true, feature: 'legacy', ticket: 1, state: 'queued', receipt };
    assert.deepEqual(updates, [queued, { ok: true, feature: 'sample', number: 1, path: added.path }, queued]);
    assert.equal((await call('get', { ticket: 1 })).ticket.status, 'done');
    assert.match(fs.readFileSync(path, 'utf8'), /Status:\*\* ready-for-agent/);
  } finally { await takeLease({ name: 'main-checkout', release: true }, lease); }
  const state = () => JSON.parse(fs.readFileSync(join(f.home, 'flows', `${receipt}.json`), 'utf8')).state;
  await until(() => ['completed', 'failed'].includes(state()), t.signal);
  const result = await f.call('hud_read', { job: receipt });
  assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.deepEqual(result.updates, Array.from({ length: 2 }, () => ({ ok: true, feature: 'legacy', number: 1, path })));
  assert.match(f.git(f.main, 'show', `HEAD:${rel}`), /Status:\*\* claimed[\s\S]*- \[x\]/);
  assert.deepEqual(f.git(f.main, 'show', '--format=%s', '--name-only', 'HEAD').split('\n').filter(Boolean), ['tickets: legacy/01 update', rel]);
});

test('hud_tickets add/update validates and stores repairs on JSON and Markdown features', { timeout: 20_000 }, async t => {
  const f = await checkout(t, ['true']);
  seedMarkdown(f);
  const call = (op, args) => f.call('hud_tickets', { op, cwd: f.worktree, ...args });
  const rpcErr = async (op, args) => {
    const { result } = await f.rpc('tools/call', { name: 'hud_tickets', arguments: { op, cwd: f.worktree, ...args } });
    assert.equal(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text).error;
  };

  // JSON feature with sibling slices A (sample/01) and B (sample/02).
  await call('add', { feature: 'sample', tickets: [draft('Slice A'), draft('Slice B')] });
  const addRepair = await call('add', {
    feature: 'sample',
    tickets: [{ ...draft('Fix B'), repairs: ['sample/02'] }],
  });
  assert.equal(addRepair.ok, true);
  assert.deepEqual((await call('get', { ticket: 'sample/03' })).ticket.repairs, ['sample/02']);
  assert.equal((await call('get', { ticket: 'sample/01' })).ticket.repairs, undefined);

  // Update repairs to another valid ref (including cross-feature Markdown) and clear with [].
  await call('update', { feature: 'sample', ticket: 3, repairs: ['sample/02', 'legacy/01'] });
  assert.deepEqual((await call('get', { ticket: 'sample/03' })).ticket.repairs, ['sample/02', 'legacy/01']);
  await call('update', { feature: 'sample', ticket: 3, repairs: [] });
  assert.equal((await call('get', { ticket: 'sample/03' })).ticket.repairs, undefined);

  // Reject unknown and malformed repairs refs on JSON without writing.
  assert.match(await rpcErr('add', { feature: 'sample', tickets: [{ ...draft('Unknown'), repairs: ['sample/99'] }] }), /unknown repairs ticket: sample\/99/);
  assert.match(await rpcErr('add', { feature: 'sample', tickets: [{ ...draft('Missing feature'), repairs: ['missing/01'] }] }), /unknown repairs ticket: missing\/01/);
  for (const bad of [['not-a-ref'], ['sample/1'], ['01'], [1], ['sample/00'], ['Sample/01'], 'sample/01']) {
    assert.match(await rpcErr('add', { feature: 'sample', tickets: [{ ...draft('Bad'), repairs: bad }] }), /invalid_arguments: repairs/);
  }
  assert.equal((await call('get', { feature: 'sample' })).feature.tickets.length, 3);
  assert.throws(() => validateTicketFeature({
    version: 1, feature: 'sample',
    tickets: [{ number: 1, title: 'Bad', status: 'done', owner_try: false, live_try: 'none', approved_removals: [],
      blocked_by: [], repairs: ['sample/1'], what: 'x', acceptance: [], comments: [],
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }],
  }), /Invalid ticket store field: feature\.tickets\[0\]\.repairs\[0\]/);

  // Markdown path: add, update, read back, and reject unknown/malformed repairs.
  await call('add', { feature: 'legacy', tickets: [draft('Legacy B')] });
  const mdRepair = await call('add', {
    feature: 'legacy',
    tickets: [{ ...draft('Fix Legacy B'), repairs: ['legacy/02'] }],
  });
  assert.equal(mdRepair.ok, true);
  assert.match(fs.readFileSync(mdRepair.tickets[0].path, 'utf8'), /^\*\*Repairs:\*\* legacy\/02$/m);
  assert.deepEqual((await call('get', { ticket: 'legacy/03' })).ticket.repairs, ['legacy/02']);
  await call('update', { feature: 'legacy', ticket: 3, repairs: ['legacy/01', 'sample/02'] });
  assert.deepEqual((await call('get', { ticket: 'legacy/03' })).ticket.repairs, ['legacy/01', 'sample/02']);
  await call('update', { feature: 'legacy', ticket: 3, repairs: [] });
  assert.equal((await call('get', { ticket: 'legacy/03' })).ticket.repairs, undefined);
  assert.match(await rpcErr('add', { feature: 'legacy', tickets: [{ ...draft('Bad'), repairs: ['legacy/99'] }] }), /unknown repairs ticket: legacy\/99/);
  assert.match(await rpcErr('add', { feature: 'legacy', tickets: [{ ...draft('Bad'), repairs: ['legacy/1'] }] }), /invalid_arguments: repairs/);
});
