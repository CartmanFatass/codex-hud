import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { main } from '../../dist/cli/hud.js';
import { scanTicketStore } from '../../dist/collectors/ticket-store.js';
import { collectGateFlakes } from '../../dist/mcp/land-flakes.js';
import { recordUnattendedAcceptance, ticketReadiness } from '../../dist/mcp/local-tickets.js';
import { JobIndexCache } from '../../dist/roles/job-index-cache.js';
import { takeLease } from '../../dist/roles/lease.js';
import { compactHomePath, expandHomePath, normalizeHomePaths, parseMarkdownRepairRefs, readTicketWrites, serializeTicketFeature, ticketWritesPath, validateTicketFeature } from '../../dist/tickets/store.js';
import { checkout, job } from '../helpers/thin-mcp-land.mjs';
import { until } from '../helpers/thin-mcp-harness.mjs';
import { goodTicket, setupWorkflowProject } from '../helpers/workflow-ticket-project.mjs';

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

test('an ordinary add reports receipt-save failure without changing the feature or duplicating tickets on retry', async t => {
  const f = await checkout(t, ['true'], { probe: `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to.endsWith('/ticket-writes.json') && fs.existsSync(join(process.env.HOME, 'fail-ticket-receipt'))) {
        throw new Error('synthetic receipt save failure');
      }
      return rename(from, to);
    };
    syncBuiltinESMExports();
  ` });
  const add = title => ({ op: 'add', feature: 'sample', tickets: [draft(title)] });
  const { tickets: [first] } = await f.call('hud_tickets', add('First'));
  const before = fs.readFileSync(first.path);
  const receipt = readTicketWrites(f.home, f.main);
  const marker = join(f.env.HOME, 'fail-ticket-receipt');
  fs.writeFileSync(marker, '');
  const { result } = await f.rpc('tools/call', { name: 'hud_tickets', arguments: add('Second') });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /synthetic receipt save failure/);
  assert.deepEqual(fs.readFileSync(first.path), before);
  assert.deepEqual(readTicketWrites(f.home, f.main), receipt);
  fs.unlinkSync(marker);
  const { tickets: [second] } = await f.call('hud_tickets', add('Second'));
  assert.equal(second.number, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(first.path, 'utf8')).tickets.map(t => t.title), ['First', 'Second']);
});

test('a synced GitHub JSON mirror is visible to the collector, hud board and hud_tickets ready', async t => {
  const f = await checkout(t, ['true']);
  assert.ok((await f.rpc('initialize')).result);
  const repo = 'example/sample', api = `repos/${repo}/issues`;
  const replies = {
    [`${api}?state=open&per_page=100`]: [{ number: 20, title: 'Mirror sample', state: 'open' }],
    [`${api}/20/sub_issues?per_page=100`]: [{ number: 21, title: 'Mirrored ready ticket', state: 'open',
      labels: [{ name: 'ready-for-agent' }], body: 'Keep this visible.\n\n- [ ] Verify it', comments: 0 }],
    [`${api}/21/dependencies/blocked_by?per_page=100`]: [],
  };
  f.overrideBin('gh', `#!${process.execPath}\nconst args = process.argv.slice(2);\n` +
    `const reply = args[0] === 'repo' ? { nameWithOwner: ${JSON.stringify(repo)} } : ${JSON.stringify(replies)}[args.at(-1)];\n` +
    `if (reply === undefined) process.exit(1);\nconsole.log(JSON.stringify(reply));\n`);
  const sync = await f.call('hud_tickets', { op: 'sync', cwd: f.main });
  assert.equal(sync.ok, true, JSON.stringify(sync));
  const rel = '.hud/tickets/mirror-sample.json', path = join(f.main, rel);
  assert.equal(f.git(f.main, 'check-ignore', rel), rel);
  assert.equal(fs.existsSync(join(f.main, '.scratch/mirror-sample/issues')), false);
  const scan = scanTicketStore(f.main);
  assert.equal(scan.sources.get('mirror-sample')?.doc?.mirror?.kind, 'github');
  assert.equal(scan.lookup('mirror-sample/21')?.title, 'Mirrored ready ticket');

  const board = join(f.root, 'sample-board.html');
  let stderr = '';
  assert.equal(await main(['board', '--cwd', f.main, '--out', board], {
    env: f.env, stdout: () => {}, stderr: text => { stderr += text; },
  }), 0, stderr);
  assert.match(fs.readFileSync(board, 'utf8'), /Mirrored ready ticket/);

  const ready = await f.call('hud_tickets', { op: 'ready', cwd: f.main });
  assert.deepEqual(ready, { ok: true, tickets: [{ ticket: 'mirror-sample/21', path,
    title: 'Mirrored ready ticket', what: 'Keep this visible.' }] });
  const edit = await f.rpc('tools/call', { name: 'hud_tickets', arguments: {
    op: 'add', cwd: f.main, feature: 'local', tickets: [draft('Local ticket')],
  } });
  assert.equal(edit.result.isError, true);
  assert.match(edit.result.content[0].text, /refusing local ticket edits.*GitHub mirror/);
  assert.equal(fs.existsSync(join(f.main, '.hud/tickets/local.json')), false);
});

test('an add and an update after a sweep prunes the digest succeed while land holds main-checkout', { timeout: 20_000 }, async t => {
  const release = 'release-gate';
  const f = await checkout(t, [`while test ! -f "$HOME/${release}"; do sleep .05; done`], { after: [] });
  const { tickets: [existing] } = await f.call('hud_tickets', { op: 'add', feature: 'swept', tickets: [draft('Existing ticket')] });
  assert.ok(readTicketWrites(f.home, f.main).swept);
  assert.equal((await f.call('hud_tickets', { op: 'commit' })).committed, true);
  assert.equal(readTicketWrites(f.home, f.main).swept, undefined);
  const head = f.git(f.main, 'rev-parse', 'HEAD');
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).step.startsWith('gate[1]'), t.signal);
  try {
    const probe = { cwd: f.main, home: f.home, holder: 'synthetic-contender' };
    const lease = await takeLease({ name: 'main-checkout', wait_s: 0 }, probe);
    if (lease.granted) await takeLease({ name: 'main-checkout', release: true }, probe);
    assert.equal(lease.granted, false, 'land must be holding the lease during the gate');

    const add = await fast(() => f.call('hud_tickets', { op: 'add', feature: 'sample', tickets: [draft('Gate-time ticket')] }));
    assert.deepEqual(add.tickets, [{ number: 1, path: join(f.main, '.hud/tickets/sample.json') }]);
    const updated = await fast(() => f.call('hud_tickets', { op: 'update', ticket: 'swept/01', status: 'done' }));
    assert.deepEqual(updated, { ok: true, number: 1, path: existing.path });
    const bytes = fs.readFileSync(existing.path, 'utf8');
    assert.equal(JSON.parse(bytes).tickets[0].status, 'done');
    assert.equal(readTicketWrites(f.home, f.main).swept, sha256(bytes));
    assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), head);
    assert.ok(f.flowState(flow).step.startsWith('gate[1]'));
    assert.deepEqual(fs.readdirSync(join(f.home, 'flows')).filter(name => /^te/.test(name)), []);
  } finally {
    fs.writeFileSync(join(f.env.HOME, release), '');
  }
  await until(() => ['completed', 'failed'].includes(f.flowState(flow).state), t.signal);
  assert.equal(f.flowState(flow).state, 'completed');
});

test('a mixed update refuses legacy Markdown items while applying JSON items without the main-checkout lease', { timeout: 20_000 }, async t => {
  const f = await checkout(t, ['true']);
  const { path } = seedMarkdown(f);
  const originalMd = fs.readFileSync(path, 'utf8');
  const call = (op, args) => f.call('hud_tickets', { op, feature: 'sample', cwd: f.worktree, ...args });
  const { tickets: [added] } = await call('add', { tickets: [draft('JSON ticket')] });
  const lease = { cwd: f.main, home: f.home, holder: 'synthetic-land' };
  assert.deepEqual(await takeLease({ name: 'main-checkout', wait_s: 0 }, lease), { granted: true });
  try {
    const { updates } = await fast(() => call('update', { updates: [
      { feature: 'legacy', ticket: 1, status: 'claimed' },
      { ticket: 1, status: 'done' },
      { feature: 'legacy', ticket: 1, tick: [1] },
    ] }));
    assert.equal(updates[0].ok, false);
    assert.match(updates[0].error, /still uses legacy Markdown tickets; run "hud tickets migrate" first/);
    assert.deepEqual(updates[1], { ok: true, feature: 'sample', number: 1, path: added.path });
    assert.equal(updates[2].ok, false);
    assert.match(updates[2].error, /still uses legacy Markdown tickets; run "hud tickets migrate" first/);
    assert.equal((await call('get', { ticket: 1 })).ticket.status, 'done');
    assert.equal(fs.readFileSync(path, 'utf8'), originalMd, 'legacy Markdown file stays untouched');
    const flowsDir = join(f.home, 'flows');
    assert.deepEqual(fs.existsSync(flowsDir) ? fs.readdirSync(flowsDir).filter(name => /^te/.test(name)) : [], []);
  } finally { await takeLease({ name: 'main-checkout', release: true }, lease); }
  const committed = await call('commit', {});
  assert.equal(committed.committed, true);
  assert.deepEqual(committed.paths, ['.hud/tickets/sample.json']);
  assert.equal(f.git(f.main, 'status', '--porcelain', '--', '.hud/tickets/sample.json'), '');
});

test('hud_tickets add/update validates and stores repairs on JSON features and refuses writes to legacy Markdown', { timeout: 20_000 }, async t => {
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

  // Update repairs to another valid ref (including cross-feature legacy Markdown reader fallback) and clear with [].
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

  // Legacy Markdown feature refuses writes until migrated.
  assert.match(await rpcErr('add', { feature: 'legacy', tickets: [draft('Legacy B')] }), /still uses legacy Markdown tickets; run "hud tickets migrate" first/);
  assert.match(await rpcErr('update', { feature: 'legacy', ticket: 1, status: 'done' }), /still uses legacy Markdown tickets; run "hud tickets migrate" first/);
});

test('repairs and flake-list cases are collected in full and hud tickets show matches hud_create brief byte for byte', { timeout: 20_000 }, async t => {
  const f = await checkout(t, ['true']);
  const cfgPath = join(f.main, '.hud/project.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, flakes: { feature: 'sample' } }));

  const add = await f.call('hud_tickets', {
    op: 'add',
    feature: 'sample',
    cwd: f.main,
    tickets: [
      draft('Base slice'),
      { ...draft('Repair slice'), repairs: ['sample/01'], comment: 'Follow-up after review.' },
    ],
  });
  assert.equal(add.ok, true);

  const flakes = await collectGateFlakes(f.home, f.main, [
    { name: 'recovers cleanly', file: 'tests/unit/alpha.test.mjs', step: 'gate[1]', flow: 'f0000000000000001', log: '~/.hud/flows/f0000000000000001.gate-1.log' },
    { name: 'gate[2]', file: 'tests/unit/beta.test.mjs', step: 'gate[2]', flow: 'f0000000000000002', unidentified: true },
  ]);
  assert.equal(flakes.ticket, 'sample/03');

  // Collector reads the whole feature without dropping it or marking partial.
  const scan = scanTicketStore(f.main);
  assert.equal(scan.partial, false);
  const feat = scan.features.find(item => item.slug === 'sample');
  assert.ok(feat, 'sample feature collected');
  assert.equal(feat.partial, undefined);
  assert.deepEqual(feat.tickets.map(ticket => ticket.number), ['01', '02', '03']);
  assert.equal(scan.lookup('sample/02')?.title, 'Repair slice');
  assert.equal(scan.lookup('sample/03')?.title, 'Gate flakes collected after sample/02');

  const cwd = process.cwd();
  const show = async arg => {
    let out = '', err = '';
    const code = await main(['tickets', 'show', arg], { env: f.env, stdout: s => { out += s; }, stderr: s => { err += s; } });
    return { code, out, err };
  };
  let showAll, showRepair, showFlake;
  try {
    process.chdir(f.main);
    showAll = await show('sample');
    showRepair = await show('sample/02');
    showFlake = await show('sample/03');
  } finally {
    process.chdir(cwd);
  }

  assert.equal(showAll.code, 0, showAll.err);
  assert.match(showAll.out, /\*\*Repairs:\*\* sample\/01/);
  assert.match(showAll.out, /### Cases\n\n- `recovers cleanly` \(tests\/unit\/alpha\.test\.mjs\) — flow `f0000000000000001`, log `~\/\.hud\/flows\/f0000000000000001\.gate-1\.log`/);
  assert.match(showAll.out, /- unidentified failure \(`gate\[2\]`, tests\/unit\/beta\.test\.mjs\) — flow `f0000000000000002`/);

  for (const [ticket, shown] of [['sample/02', showRepair], ['sample/03', showFlake]]) {
    assert.equal(shown.code, 0, shown.err);
    const created = await f.call('hud_create', { role: 'general', cwd: f.main, ticket, request_key: `brief-${ticket}` });
    const brief = fs.readFileSync(join(created.task_dir, 'brief.md'), 'utf8');
    assert.equal(brief, shown.out + '\nFinish with `hud_report`.\n');
  }
});

test('parseMarkdownRepairRefs skips standalone none sentinel and keeps none-prefixed canonical refs and bare numbers', () => {
  assert.deepEqual(parseMarkdownRepairRefs(undefined, 'sample'), []);
  assert.deepEqual(parseMarkdownRepairRefs('', 'sample'), []);
  assert.deepEqual(parseMarkdownRepairRefs('none', 'sample'), []);
  assert.deepEqual(parseMarkdownRepairRefs('None (not a repair)', 'sample'), []);
  assert.deepEqual(parseMarkdownRepairRefs('none-theme/01', 'other'), ['none-theme/01']);
  assert.deepEqual(parseMarkdownRepairRefs('none/01', 'other'), ['none/01']);
  assert.deepEqual(
    parseMarkdownRepairRefs('none-theme/01 (spec finding), none, 02, #3', 'none-theme'),
    ['none-theme/01', 'none-theme/02', 'none-theme/03'],
  );
});

test('none-theme/01 Markdown repair ref survives both fallback readers and queue admission while Repairs: none yields no repairs', { timeout: 30_000 }, async t => {
  const withRepairsLine = (body, value) => body.replace('**Blocked by:** none\n', `**Blocked by:** none\n**Repairs:** ${value}\n`);
  const f = await setupWorkflowProject(t, {
    legacy: true,
    extraFeatures: {
      'none-theme': {
        '01-base.md': withRepairsLine(goodTicket(1, { status: 'done', title: 'Base theme slice' }), 'none (not a repair)'),
        '02-no-repairs.md': withRepairsLine(goodTicket(2, { status: 'ready-for-agent', title: 'Unrelated theme slice' }), 'none'),
        '03-repair.md': withRepairsLine(goodTicket(3, { status: 'ready-for-agent', title: 'Repair none-theme 01' }), 'none-theme/01'),
      },
    },
    objectives: '## selected: Selected\n**State:** active\n**Features:** sample, none-theme\n',
  });

  // Reader 1: src/tickets/store.ts (readLegacyTicket via hud_tickets get).
  assert.deepEqual((await f.call('hud_tickets', { op: 'get', ticket: 'none-theme/03', cwd: f.root })).ticket.repairs, ['none-theme/01']);
  assert.equal((await f.call('hud_tickets', { op: 'get', ticket: 'none-theme/02', cwd: f.root })).ticket.repairs, undefined);
  assert.equal((await f.call('hud_tickets', { op: 'get', ticket: 'none-theme/01', cwd: f.root })).ticket.repairs, undefined);

  // Reader 2: src/mcp/local-tickets.ts (parseTicketForReadiness via ticketReadiness).
  const ready = ticketReadiness(f.root, new JobIndexCache(f.home), 'none-theme', { home: f.home });
  assert.deepEqual(ready.tickets.find(item => item.ticket === 'none-theme/03')?.repairs, ['none-theme/01']);
  assert.equal(ready.tickets.find(item => item.ticket === 'none-theme/02')?.repairs, undefined);

  // Queue admission preserves repairs on q.tickets[].repairs and keeps Repairs: none empty.
  const { flow } = await f.call('hud_tickets', { op: 'run', feature: 'none-theme', max_parallel: 2, cwd: f.root });
  try {
    await f.jobs(flow, 2);
    const q = f.flow(flow);
    assert.deepEqual(q.tickets.find(item => item.ticket === 'none-theme/03')?.repairs, ['none-theme/01']);
    assert.equal(q.tickets.find(item => item.ticket === 'none-theme/02')?.repairs, undefined);
  } finally {
    await f.call('hud_tickets', { op: 'run', cancel: true, run: flow, cwd: f.root });
    assert.equal((await f.end(flow)).state, 'cancelled');
  }
});

test('hud_tickets add/update/comment and land-written ticket comments normalize $HOME paths to ~/ while leaving paths outside $HOME verbatim', { timeout: 25_000 }, async t => {
  const f = await checkout(t, ['true']);
  seedMarkdown(f);
  const homePath = `${f.env.HOME}/.hud/jobs/x/report.md`;
  const siblingPath = `${f.env.HOME}-other/.hud/jobs/x/report.md`;
  const outsidePath = '/var/tmp/outside/jobs/x/report.md';
  const nestedPath = `/mnt${f.env.HOME}/.hud/jobs/x/report.md`;

  // Direct helper edge cases.
  assert.equal(normalizeHomePaths(`read (${homePath}) and \`${f.env.HOME}\``, f.env.HOME), 'read (~/.hud/jobs/x/report.md) and `~`');
  assert.equal(normalizeHomePaths(`${siblingPath} ${outsidePath} ${nestedPath}`, f.env.HOME), `${siblingPath} ${outsidePath} ${nestedPath}`);
  assert.equal(compactHomePath(`${f.env.HOME}/projects/target`, f.env.HOME), '~/projects/target');
  assert.equal(compactHomePath('~/projects/target/', f.env.HOME), '~/projects/target');
  assert.equal(compactHomePath(siblingPath, f.env.HOME), siblingPath);
  assert.equal(compactHomePath(outsidePath, f.env.HOME), outsidePath);
  assert.equal(expandHomePath('~/projects/target', f.env.HOME), `${f.env.HOME}/projects/target`);
  assert.equal(expandHomePath('~other/projects/target', f.env.HOME), '~other/projects/target');
  assert.equal(expandHomePath(outsidePath, f.env.HOME), outsidePath);

  const call = (op, args) => f.call('hud_tickets', { op, cwd: f.main, ...args });

  // JSON add (including extracted live_try) and update/comment.
  const jsonAdd = await call('add', {
    feature: 'norm-json',
    tickets: [
      {
        title: `Review ${homePath} vs ${outsidePath}`,
        what: `Read ${homePath} and ${outsidePath} and ${siblingPath}.`,
        live_try: `Open ${homePath} and ${outsidePath}`,
        acceptance: [`Verify ${homePath}`, `Keep ${outsidePath}`],
        blocked_by: [],
        comment: `Initial note (${homePath}, ${outsidePath})`,
      },
      {
        title: 'Extracted live try',
        what: `Inspect ${homePath}.\nLive try: inspect ${homePath} and ${outsidePath}`,
        acceptance: [`Check ${homePath}`],
        blocked_by: [],
      },
    ],
  });
  assert.equal(jsonAdd.ok, true);
  const { ticket: t1 } = await call('get', { ticket: 'norm-json/01' });
  assert.equal(t1.title, `Review ~/.hud/jobs/x/report.md vs ${outsidePath}`);
  assert.equal(t1.what, `Read ~/.hud/jobs/x/report.md and ${outsidePath} and ${siblingPath}.`);
  assert.equal(t1.live_try, `Open ~/.hud/jobs/x/report.md and ${outsidePath}`);
  assert.deepEqual(t1.acceptance.map(a => a.text), ['Verify ~/.hud/jobs/x/report.md', `Keep ${outsidePath}`]);
  assert.equal(t1.comments[0].text, `Initial note (~/.hud/jobs/x/report.md, ${outsidePath})`);

  const { ticket: t2 } = await call('get', { ticket: 'norm-json/02' });
  assert.equal(t2.what, 'Inspect ~/.hud/jobs/x/report.md.');
  assert.equal(t2.live_try, `inspect ~/.hud/jobs/x/report.md and ${outsidePath}`);

  await call('update', {
    feature: 'norm-json',
    ticket: 1,
    title: `Updated ${homePath}`,
    what: `Updated what: ${homePath} and ${outsidePath}`,
    live_try: `Updated try: ${homePath}`,
    acceptance: [{ id: 1, text: `Updated acceptance: ${homePath} and ${outsidePath}` }],
    comment: `Updated comment: ${homePath} and ${outsidePath}`,
  });
  const { ticket: t1Updated } = await call('get', { ticket: 'norm-json/01' });
  assert.equal(t1Updated.title, 'Updated ~/.hud/jobs/x/report.md');
  assert.equal(t1Updated.what, `Updated what: ~/.hud/jobs/x/report.md and ${outsidePath}`);
  assert.equal(t1Updated.live_try, 'Updated try: ~/.hud/jobs/x/report.md');
  assert.equal(t1Updated.acceptance[0].text, `Updated acceptance: ~/.hud/jobs/x/report.md and ${outsidePath}`);
  assert.equal(t1Updated.comments[1].text, `Updated comment: ~/.hud/jobs/x/report.md and ${outsidePath}`);

  const rawJson = fs.readFileSync(join(f.main, '.hud/tickets/norm-json.json'), 'utf8');
  assert.equal(rawJson.includes(`${f.env.HOME}/`), false, 'stored JSON must not contain $HOME/ paths');
  assert.equal(rawJson.includes(outsidePath), true);

  // Unattended acceptance comments normalize $HOME paths in JSON.
  const procHome = process.env.HOME;
  assert.ok(procHome, 'test runner must have HOME set');
  const procHomePath = `${procHome}/.hud/jobs/x/report.md`;

  const acc = await recordUnattendedAcceptance(
    f.main,
    f.home,
    () => [
      { path: join(f.main, '.hud/tickets/norm-json.json'), ticket: 'norm-json/01' },
    ],
    'q00000000000000c1',
    `finish: verified ${procHomePath} and ${outsidePath}`,
  );
  assert.deepEqual(acc.failed, []);
  const { ticket: acceptedJson } = await call('get', { ticket: 'norm-json/01' });
  assert.equal(acceptedJson.accepted?.verdict, `finish: verified ~/.hud/jobs/x/report.md and ${outsidePath}`);
});

test('hud_tickets single-form update accepts numeric, numeric-string and feature/NN targets for JSON, matches updates[] and refuses unmigrated Markdown', { timeout: 25_000 }, async t => {
  const f = await checkout(t, ['true']);
  const call = (op, args) => f.call('hud_tickets', { op, cwd: f.main, ...args });
  const rpcErr = async (op, args) => {
    const { result } = await f.rpc('tools/call', { name: 'hud_tickets', arguments: { op, cwd: f.main, ...args } });
    assert.equal(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };

  const mdTemplate = [
    '# 31: Synthetic Markdown slice',
    '',
    '**Status:** ready-for-agent',
    '**Owner try:** no',
    '**Live try:** none',
    '**Blocked by:** none',
    '',
    '**What to build:** Verify single-form update.',
    '',
    '- [ ] First check',
    '- [ ] Second check',
    '- [ ] Third check',
    '- [ ] Fourth check',
    '',
    '## Comments',
    '',
  ].join('\n');
  const seedMdFeature = slug => {
    const rel = `.scratch/${slug}/issues/31-synthetic-markdown-slice.md`, path = join(f.main, rel);
    fs.mkdirSync(join(f.main, `.scratch/${slug}/issues`), { recursive: true });
    fs.writeFileSync(path, mdTemplate);
    f.git(f.main, 'add', rel);
    return path;
  };
  const mdSinglePath = seedMdFeature('md-single');
  const mdBatchPath = seedMdFeature('md-batch');
  const mdStringPath = seedMdFeature('md-str');
  const mdRefPath = seedMdFeature('md-ref');
  f.git(f.main, 'commit', '-qm', 'Seed synthetic Markdown features');

  const at = '2026-01-01T00:00:00.000Z';
  const seedJsonFeature = slug => {
    const rel = `.hud/tickets/${slug}.json`, path = join(f.main, rel);
    fs.mkdirSync(join(f.main, '.hud/tickets'), { recursive: true });
    fs.writeFileSync(path, serializeTicketFeature({
      version: 1,
      feature: slug,
      tickets: [{
        number: 31,
        title: 'Synthetic JSON slice',
        status: 'ready-for-agent',
        owner_try: false,
        live_try: 'none',
        approved_removals: [],
        blocked_by: [],
        what: 'Verify single-form update.',
        acceptance: [
          { id: 1, text: 'First check', done: false },
          { id: 2, text: 'Second check', done: false },
          { id: 3, text: 'Third check', done: false },
          { id: 4, text: 'Fourth check', done: false },
        ],
        comments: [],
        created_at: at,
        updated_at: at,
      }],
    }));
    f.git(f.main, 'add', rel);
    return path;
  };
  const jsonSinglePath = seedJsonFeature('json-single');
  const jsonBatchPath = seedJsonFeature('json-batch');
  const jsonStringPath = seedJsonFeature('json-str');
  const jsonRefPath = seedJsonFeature('json-ref');
  f.git(f.main, 'commit', '-qm', 'Seed synthetic JSON features');

  // 1. Single form with feature + numeric ticket + status + tick succeeds for JSON; unmigrated Markdown is refused.
  const legacy = /still uses legacy Markdown tickets; run "hud tickets migrate" first/;
  const mdSingleBytes = fs.readFileSync(mdSinglePath, 'utf8');
  assert.match((await rpcErr('update', { feature: 'md-single', ticket: 31, status: 'done', tick: [1, 2, 3, 4] })).error, legacy);
  const jsonSingleRes = await call('update', { feature: 'json-single', ticket: 31, status: 'done', tick: [1, 2, 3, 4] });
  assert.deepEqual(jsonSingleRes, { ok: true, number: 31, path: jsonSinglePath });

  // 2. Numeric string ("31") and feature/NN ref (".../31") resolve the same way: JSON succeeds, Markdown is refused.
  assert.match((await rpcErr('update', { feature: 'md-str', ticket: '31', status: 'done', tick: [1, 2, 3, 4] })).error, legacy);
  assert.match((await rpcErr('update', { ticket: 'md-ref/31', status: 'done', tick: [1, 2, 3, 4] })).error, legacy);
  assert.deepEqual(
    await call('update', { feature: 'json-str', ticket: '31', status: 'done', tick: [1, 2, 3, 4] }),
    { ok: true, number: 31, path: jsonStringPath },
  );
  assert.deepEqual(
    await call('update', { ticket: 'json-ref/31', status: 'done', tick: [1, 2, 3, 4] }),
    { ok: true, number: 31, path: jsonRefPath },
  );
  assert.equal((await call('get', { feature: 'json-str', ticket: '31' })).ticket.status, 'done');

  // 3. Same edit through updates[] produces identical JSON files; a Markdown item is refused per item.
  const mdBatchRes = await call('update', { updates: [{ feature: 'md-batch', ticket: 31, status: 'done', tick: [1, 2, 3, 4] }] });
  assert.equal(mdBatchRes.updates.length, 1);
  assert.match(mdBatchRes.updates[0].error, legacy);
  const jsonBatchRes = await call('update', { updates: [{ feature: 'json-batch', ticket: 31, status: 'done', tick: [1, 2, 3, 4] }] });
  assert.deepEqual(jsonBatchRes, { updates: [{ feature: 'json-batch', ok: true, number: 31, path: jsonBatchPath }] });

  for (const path of [mdSinglePath, mdBatchPath, mdStringPath, mdRefPath]) assert.equal(fs.readFileSync(path, 'utf8'), mdSingleBytes, 'refused Markdown edits leave the file untouched');

  const normalizeJsonBytes = (bytes, slug) => bytes
    .replace(`"feature": "${slug}"`, '"feature": "<slug>"')
    .replace(/"updated_at": "[^"]+"/, '"updated_at": "<ts>"');
  const jsonSingleBytes = fs.readFileSync(jsonSinglePath, 'utf8');
  assert.equal(
    normalizeJsonBytes(jsonSingleBytes, 'json-single'),
    normalizeJsonBytes(fs.readFileSync(jsonBatchPath, 'utf8'), 'json-batch'),
    'JSON single form and updates[] must produce identical files (modulo feature slug and updated_at)',
  );
  assert.equal(
    normalizeJsonBytes(jsonSingleBytes, 'json-single'),
    normalizeJsonBytes(fs.readFileSync(jsonStringPath, 'utf8'), 'json-str'),
  );
  assert.equal(
    normalizeJsonBytes(jsonSingleBytes, 'json-single'),
    normalizeJsonBytes(fs.readFileSync(jsonRefPath, 'utf8'), 'json-ref'),
  );

  // 4. Invalid ticket targets and feature/ticket mismatches still fail with invalid_arguments without touching files.
  for (const bad of [0, -1, 1.5, '0', 'abc', 'md-single/0']) {
    const err = await rpcErr('update', { feature: 'md-single', ticket: bad, status: 'claimed' });
    assert.equal(err.code, 'invalid_arguments');
    assert.match(err.error, /^invalid_arguments: ticket/);
  }
  const mismatch = await rpcErr('update', { feature: 'json-single', ticket: 'md-single/31', status: 'claimed' });
  assert.equal(mismatch.code, 'invalid_arguments');
  assert.match(mismatch.error, /ticket does not match feature/);
  assert.equal(fs.readFileSync(mdSinglePath, 'utf8'), mdSingleBytes);
  assert.equal(fs.readFileSync(jsonSinglePath, 'utf8'), jsonSingleBytes);
});
