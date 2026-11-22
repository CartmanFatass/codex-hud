import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { PiRoleClient } from '../../dist/harness/pi/role-client.js';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { git, initRepo } from '../fixtures/managed-worktree.mjs';
import {
  workerFor,
  cardText,
  withoutHint,
  withoutCallerLookups,
  fixture,
  enableOptionalRoles,
  until,
  reapAttempts,
  publishPiGrace,
  fallbackPlaces,
  fallbackRole,
  waitFixtureJob,
  cliState,
  writeCliRole,
} from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

test('launch thinking facts map CLI efforts before opening the worker; unknown models pass through', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'phantom-working'), '');
  for (const [on, model, thinking, expected] of [
    ['claude', 'opus', 'ultra', 'max'], ['agy', 'gemini-4-hydrogen-high', 'minimal', 'low'],
    ['claude', 'haiku', 'minimal', 'low'], ['claude', 'claude-fable-5-2', 'ultra', 'max'],
    ['claude', 'claude-opus-5-5', 'ultra', 'max'], ['claude', 'claude-sonnet-5-5', 'ultra', 'max'],
    ['agy', 'gemini-3.8-flash-high', 'minimal', 'low'],
    ['codex', 'gpt-5.5', 'max', 'xhigh'], ['codex', 'gpt-6.1-sol', 'ultra', 'ultra'],
    ['claude', 'hud-unknown', 'ultra', 'ultra'], ['grok', 'grok-4.7', 'minimal', 'minimal'],
  ]) {
    const job = await f.call('hud_create', { role: 'imp', task: `Synthetic ${on} ${model}.`, on, model, thinking });
    assert.equal(job.thinking, expected, JSON.stringify(job));
    const { args } = f.commands().find(({ args }) => args[1] === 'start' && args[2] === job.agent);
    if (on === 'codex') assert.ok(args.includes(`model_reasoning_effort=${expected}`));
    else assert.equal(args[args.indexOf(on === 'grok' ? '--reasoning-effort' : '--effort') + 1], expected);
  }
});

test('a cwd that is not an existing directory is refused before dispatch instead of failing as a launcher ENOENT', async (t) => {
  const f = await fixture(t);
  const missing = join(f.root, 'no-such-worktree');
  const { result } = await f.rpc('tools/call', { name: 'hud_create', arguments: { role: 'imp', task: 'Synthetic task.', cwd: missing } });
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), { ok: false, code: 'tool_error', error: 'invalid_arguments: cwd is not an existing directory' });
  assert.deepEqual(withoutCallerLookups(f.commands()), []);
  assert.ok(!fs.existsSync(join(f.env.HUD_HOME, 'jobs')));
});

test('worktree isolation validates before dispatch, links dependencies and carries only the selected CLI grant', async (t) => {
  const f = await fixture(t), cwd = initRepo(f.root);
  fs.chmodSync(f.env.HUD_HOME, 0o700); // Trust backups require a private HUD home.
  const args = { role: 'imp', task: 'Synthetic task.', request_key: 'isolated', isolation: 'worktree', package: 'Demo Slice' };
  assert.equal((await f.call('hud_create', { ...args, on: 'pi', cwd: f.root })).code, 'invalid_arguments');
  assert.equal((await f.call('hud_create', { ...args, on: 'chatgpt', cwd })).code, 'invalid_arguments');
  assert.deepEqual(withoutCallerLookups(f.commands()), []);
  assert.ok(!fs.existsSync(join(f.env.HUD_HOME, 'jobs')));
  assert.ok(!fs.existsSync(join(f.root, 'demo-wt')));

  fs.mkdirSync(join(cwd, 'node_modules'));
  const trust = join(f.env.HOME, '.grok', 'trusted_folders.toml');
  const original = fs.readFileSync(trust, 'utf8');
  const claudeFile = join(f.env.CLAUDE_CONFIG_DIR, '.claude.json');
  const claude = fs.readFileSync(claudeFile, 'utf8');
  assert.equal((await f.call('hud_create', { ...args, request_key: 'isolated-untrusted', on: 'grok', cwd })).code, 'untrusted_cwd');
  assert.equal(fs.readFileSync(trust, 'utf8'), original);
  assert.ok(!fs.existsSync(join(f.root, 'demo-wt')));
  fs.appendFileSync(trust, `\n[folders.${JSON.stringify(cwd)}]\ntrusted = true\n`);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const create = { ...args, on: 'grok', cwd };
  const job = await f.call('hud_create', create);
  const name = `demo-slice-${job.job.slice(-6)}`, root = join(f.root, 'demo-wt', name);
  const branch = `wt/${name}`, base_head = git(cwd, 'rev-parse', 'HEAD');
  const record = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json')));
  assert.equal(record.dispatch_exit_code, 0, record.stderr_tail);
  assert.deepEqual(record.worktree, { main_root: cwd, root, branch, base_head });
  assert.equal(record.cwd, root);
  assert.equal(git(root, 'branch', '--show-current'), branch);
  assert.equal(git(root, 'rev-parse', 'HEAD'), base_head);
  assert.equal(fs.readlinkSync(join(root, 'node_modules')), join(cwd, 'node_modules'));
  assert.ok(fs.readFileSync(trust, 'utf8').includes(`[folders.${JSON.stringify(root)}]`));
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), claude);
  assert.equal((await f.call('hud_create', create)).job, job.job);
  assert.deepEqual(fs.readdirSync(join(f.root, 'demo-wt')), [name]);
  const tabs = f.commands().filter(({ args }) => args[0] === 'tab' && args[1] === 'create');
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].args[tabs[0].args.indexOf('--cwd') + 1], root);
  const project = await new ProjectCollector(cwd, f.env.HUD_HOME, f.env).collect(true, { workers: [] }, Date.now());
  assert.equal(project.slices.find((s) => s.label === name)?.jobId, job.job);
  assert.equal(project.slices.find((s) => s.label === name).drift, undefined);
});

test('hud_create closes a pre-input failure and starts the next place in the same job', async (t) => {
  const f = await fixture(t);
  fallbackRole(f, 'fallback-check');
  const reason = 'rate limit reached; retry after 5m';
  fs.writeFileSync(join(f.env.HOME, 'fail-start-grok'), reason);
  const job = await f.call('hud_create', { role: 'fallback-check', request_key: 'fallback', task: 'Synthetic fallback.' });
  assert.equal(job.state, 'working');
  assert.deepEqual(job.attempts, [
    { index: 0, place: 'cli/grok (synthetic-first)', reason },
    { index: 1, place: 'pi (synthetic/second)' },
  ]);
  assert.equal(job.used_place, 'pi (synthetic/second)');
  assert.deepEqual(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')), [job.job]);
  const receipt = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json')));
  assert.deepEqual(receipt.attempts, job.attempts);
  assert.equal(receipt.cli, undefined);
  const launches = f.commands().filter(({ args }) =>
    (args[0] === 'agent' && args[1] === 'start') || (args[0] === 'tab' && args[1] === 'close'));
  assert.deepEqual(launches.map(({ args }) => [args[1], args[2]]), [
    ['start', `${job.job}-primary`], ['close', 'w4E:t2'], ['start', `${job.job}-primary`],
  ]);
  const exhausted = JSON.parse(fs.readFileSync(join(f.env.HUD_HOME, 'exhausted.json'))).places;
  assert.deepEqual(Object.keys(exhausted), ['cli:grok:synthetic-first']);
  assert.equal(exhausted['cli:grok:synthetic-first'].reason, reason);
});

test('hud_create retry_of reuses a failed job brief and options on an available place', async (t) => {
  const f = await fixture(t);
  const places = ['synthetic/primary', 'synthetic/fallback'].map((model) => ({ harness: 'pi', pi_role: 'implementer', model }));
  fallbackRole(f, 'retry-check', places, [{ name: 'two', run: places }]);
  const cwd = join(f.root, 'retry-project');
  fs.mkdirSync(cwd);
  fs.writeFileSync(join(cwd, 'notes.md'), 'Synthetic notes.');
  const original = await f.call('hud_create', {
    role: 'retry-check', preset: 'two', cwd, task: 'Synthetic task: 重试.\n\n', context_files: ['notes.md'], tps: false, checks: ['true'],
  });
  const statusFile = join(original.task_dir, 'STATUS.json');
  writeFixtureFile(statusFile, JSON.stringify({ state: 'failed', exit_reason: 'rate limit reached; retry after 5m' }));
  const retry = { retry_of: original.job };
  const next = await f.call('hud_create', retry);
  assert.notEqual(next.job, original.job);
  assert.equal(next.used_place, 'pi (synthetic/fallback)');
  assert.equal(next.role, original.role);
  assert.equal(fs.readFileSync(join(next.task_dir, 'brief.md'), 'utf8'), fs.readFileSync(join(original.task_dir, 'brief.md'), 'utf8'));
  const receipt = JSON.parse(fs.readFileSync(join(next.task_dir, 'job.json'), 'utf8'));
  assert.equal(receipt.cwd, cwd);
  assert.equal(receipt.preset, 'two');
  assert.equal(receipt.retry_of, original.job);
  assert.ok(Date.parse(JSON.parse(fs.readFileSync(join(original.task_dir, 'job.json'))).observed_at));
  assert.equal(receipt.tps, false);
  assert.deepEqual(receipt.checks, ['true']);
  assert.equal((await f.call('hud_create', retry)).job, next.job);
});

test('hud_create retains every pre-input cause on one failed job and stays within the requested preset', async (t) => {
  const f = await fixture(t);
  fallbackRole(f, 'fallback-check', [{ harness: 'cli', agent: 'codex' }], [{ name: 'two', run: fallbackPlaces }]);
  const cwd = join(f.root, 'untrusted');
  fs.mkdirSync(cwd);
  const trust = `grok has not trusted ${cwd}; run hud trust ${cwd}`;
  fs.writeFileSync(join(f.env.HOME, 'fail-start-pi'), 'synthetic Pi launcher failure');
  const args = { role: 'fallback-check', preset: 'two', request_key: 'all-fail', task: 'Synthetic fallback.', cwd };
  const job = await f.call('hud_create', args);
  assert.equal(job.ok, false);
  assert.equal(job.state, 'failed');
  assert.equal(job.used_place, null);
  assert.deepEqual(job.attempts, [
    { index: 0, place: 'cli/grok (synthetic-first)', reason: trust },
    { index: 1, place: 'pi (synthetic/second)', reason: 'synthetic Pi launcher failure' },
  ]);
  assert.ok(job.reason.includes(trust) && job.reason.includes('synthetic Pi launcher failure'));
  assert.deepEqual(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')), [job.job]);
  assert.deepEqual(await f.call('hud_create', args), withoutHint(job));
  assert.equal(f.commands().filter(({ args }) => args[0] === 'agent' && args[1] === 'start').length, 1);
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'exhausted.json')), false);
});

test('working worker STATUS survives a nonzero prompt result', { timeout: 7000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'fail-prompt'), '');
  const job = await f.call('hud_create', { role: 'imp', request_key: 'prompt-timeout', task: 'Synthetic task.' });
  const receipt = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json')));
  assert.equal(receipt.dispatch_exit_code, 1);
  assert.match(receipt.stderr_tail, /synthetic prompt timeout/);
  assert.equal(job.attempts.length, 1, 'uncertain input must not be retried on another place');
  assert.equal(
    fs.readFileSync(join(job.task_dir, 'STATUS.json'), 'utf8'),
    JSON.stringify({ state: 'working', exit_reason: null })
  );
  assert.equal((await f.call('hud_read', { job: job.job })).state, 'working');
});

test('pi dispatch preserves explicit MCP switches and the launcher default for nonempty or unreadable config', async (t) => {
  const f = await fixture(t);
  const cwd = join(f.root, 'project');
  fs.mkdirSync(join(cwd, '.pi'), { recursive: true });
  const project = join(cwd, '.pi', 'mcp.json');
  const args = async (key, mcp) => {
    const job = await f.call('hud_create', { role: 'imp', request_key: key, task: 'Synthetic task.', cwd, mcp });
    assert.equal(job.state, 'working', JSON.stringify(job));
    return f.commands().filter(c => c.command === 'pi-role').at(-1).args.filter(arg => ['--mcp', '--no-mcp'].includes(arg));
  };
  fs.writeFileSync(project, '{"mcpServers":{}}');
  assert.deepEqual(await args('empty'), ['--no-mcp']);
  assert.deepEqual(await args('forced-on', true), ['--mcp']);
  fs.writeFileSync(project, '{"mcpServers":{"synthetic":{"command":"unused"}}}');
  assert.deepEqual(await args('project-server'), []);
  assert.deepEqual(await args('forced-off', false), ['--no-mcp']);
  fs.writeFileSync(project, 'unparseable');
  assert.deepEqual(await args('unknown'), []);
});

test('request and place pi_args cannot override the inherited caller notification binding', async (t) => {
  const f = await fixture(t);
  for (const pi_args of [
    ['--orchestrator', 'wBAD:p99'],
    ['--orchestrator=wBAD:p99'],
    ['--notify', 'fake command'],
    ['--notify=fake command'],
  ]) {
    const result = await f.call('hud_create', {
      role: 'imp',
      request_key: 'reserved-' + pi_args[0],
      task: 'Synthetic task',
      pi_args,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_arguments');
    assert.match(result.error, /caller binding/);
  }
  fallbackRole(f, 'reserved-place', [{ harness: 'pi', pi_role: 'implementer', pi_args: ['--notify=fake command'] }]);
  const place = { role: 'reserved-place', task: 'Synthetic configured binding.' };
  assert.match((await f.call('hud_create', place)).error, /caller binding/);
  assert.deepEqual(withoutCallerLookups(f.commands()), [], 'no launcher or herdr mutation for a rejected binding');
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'jobs')), false);
});

test('pi dispatch falls back to the role name for HUD instructions and passes the bound HUD home to the tab', async (t) => {
  const f = await fixture(t);
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'));
  fs.writeFileSync(join(f.env.HUD_HOME, 'roles', 'general.json'), JSON.stringify({
    role: 'general', can_continue: true, run: [{ harness: 'pi', pi_role: 'implementer' }],
  }));
  const env = { ...f.env };
  delete env.HUD_HOME;
  const client = new PiRoleClient({ release: resolve('.'), node: process.execPath, hudHome: f.env.HUD_HOME }, env, f.root);
  try {
    const result = await client.call('hud_create', { role: 'general', request_key: 'bound-home', task: 'Synthetic task.' });
    const job = JSON.parse(result.content[0].text);
    assert.match(job.job, /^j[0-9a-f]{16}$/);
    const argv = f.commands().find(({ command }) => command === 'pi-role').args;
    const instructions = argv.indexOf('--hud-instructions');
    assert.notEqual(instructions, -1);
    assert.equal(argv[instructions + 1], resolve('packages/hud-mcp/instructions/general.md'));
    const tab = f.commands().find(({ command, args }) => command === 'herdr' && args[0] === 'tab' && args[1] === 'create').args;
    const at = tab.indexOf('--env');
    assert.deepEqual(tab.slice(at, at + 4), ['--env', `HUD_JOB_DIR=${job.task_dir}`, '--env', `HUD_HOME=${f.env.HUD_HOME}`]);
  } finally {
    await client.stop();
  }
});

test('ready tickets are dispatchable briefs and live jobs claim them in MCP, Home, and Project', async (t) => {
  const f = await fixture(t, false);
  const ready = () => f.call('hud_tickets', { op: 'ready' });
  assert.deepEqual(await ready(), { ok: true, tickets: [] });
  const draft = { title: 'First slice', what: 'Build the first slice.', acceptance: ['It works.'], blocked_by: [] };
  const { tickets: [first] } = await f.call('hud_tickets', { op: 'add', feature: 'alpha', tickets: [draft] });
  const { tickets: [second] } = await f.call('hud_tickets', { op: 'add', feature: 'beta', tickets: [
    { ...draft, title: 'Second slice', blocked_by: ['alpha/01'] },
    { ...draft, title: 'Legacy claim', status: 'claimed' },
    { ...draft, title: 'Owner question', status: 'needs-info' },
  ] });
  assert.deepEqual((await ready()).tickets, [{ ticket: 'alpha/01', path: first.path, title: draft.title, what: draft.what }]);
  const original = fs.readFileSync(first.path, 'utf8');
  const receipt = (n, cwd, state, worktree) => {
    const dir = join(f.env.HUD_HOME, 'jobs', `j${String(n).padStart(16, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ cwd, role: 'imp', ticket: 'alpha/01', worktree,
      created_at: new Date(n * 1000).toISOString() }));
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state }));
    return dir;
  };
  receipt(3, resolve(f.root, '..'), 'working');
  assert.equal((await ready()).tickets.length, 1);
  const tree = join(f.env.HOME, 'isolated');
  const live = receipt(1, tree, 'working', { root: tree, main_root: f.root, branch: 'wt/synthetic' });
  receipt(2, f.root, 'failed'); // The newer failed attempt does not end the older live claim.
  assert.deepEqual((await ready()).tickets, []);
  const collector = new ProjectCollector(f.root, f.env.HUD_HOME, f.env, f.env.HOME);
  for (const mode of ['home', true]) {
    const data = await collector.collect(mode, { workers: [] }, Date.now());
    const [ticket] = data.tickets.find(feature => feature.slug === 'alpha').tickets;
    assert.deepEqual([ticket.state, ticket.status], ['working', 'claimed']);
    assert.equal(data.ledger.find(row => row.id === 'ALPHA-01')?.state, 'working');
  }
  assert.equal(fs.readFileSync(first.path, 'utf8'), original);
  writeFixtureFile(join(live, 'STATUS.json'), JSON.stringify({ state: 'closed' }));
  assert.deepEqual((await ready()).tickets.map(row => row.ticket), ['alpha/01']);
  await f.call('hud_tickets', { op: 'update', feature: 'alpha', ticket: 1, status: 'ready-for-human' });
  assert.deepEqual((await ready()).tickets, [{ ticket: 'beta/01', path: second.path, title: 'Second slice', what: draft.what }]);
});

test('thin roles MCP main path over stdio', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const initialized = await f.rpc('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(initialized.result.capabilities.tools !== undefined, true);
  const listed = await f.rpc('tools/list');
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ['hud_roster', 'hud_create', 'hud_read', 'hud_wait', 'hud_peek', 'hud_send', 'hud_respond', 'hud_close', 'hud_land', 'hud_lease', 'hud_tickets', 'hud_statusline']
  );
  const feature = 'synthetic-feature';
  const drafts = [
    { title: 'First slice', what: 'Write the data.', blocked_by: [], acceptance: ['Data is written.', 'Data is visible.'] },
    { title: 'Second slice', what: 'Read the data.', blocked_by: [1], acceptance: ['Data is read.'], status: 'needs-info' },
  ];
  const ticketCall = (args) => f.call('hud_tickets', { feature, ...args });
  const refusedTicketCall = async (args, error) => {
    const { result } = await f.rpc('tools/call', { name: 'hud_tickets', arguments: { feature, ...args } });
    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.content[0].text).error, error);
  };
  const scratch = join(f.root, '.scratch');
  await refusedTicketCall({ op: 'add', tickets: [drafts[0], { ...drafts[1], blocked_by: [999] }] }, /unknown blocked_by ticket: 999/);
  assert.equal(fs.existsSync(scratch), false);
  const issues = join(scratch, feature, 'issues');
  const first = join(issues, '01-first-slice.md'), second = join(issues, '02-second-slice.md');
  assert.deepEqual(await ticketCall({ op: 'add', tickets: drafts }), {
    ok: true, tickets: [{ number: 1, path: first }, { number: 2, path: second }],
  });
  const collector = new ProjectCollector(f.root, f.env.HUD_HOME, f.env, f.env.HOME);
  const { tickets: [{ tickets }] } = await collector.collect('home', { workers: [] }, Date.now());
  assert.deepEqual(tickets.map(({ number, status, blockers, items }) => ({ number, status, blockers, items })), [
    { number: '01', status: 'ready-for-agent', blockers: [], items: drafts[0].acceptance.map((text) => ({ text, done: false })) },
    { number: '02', status: 'needs-info', blockers: ['01'], items: [{ text: 'Data is read.', done: false }] },
  ]);
  fs.appendFileSync(first, '\n- [ ] Synthetic comment, not acceptance.\n');
  const original = fs.readFileSync(first, 'utf8');
  await refusedTicketCall({ op: 'update', ticket: 1, status: 'wontfix', tick: [1, 3] }, /unknown acceptance item: 3/);
  assert.equal(fs.readFileSync(first, 'utf8'), original);
  assert.deepEqual(await ticketCall({ op: 'update', ticket: 1, status: 'ready-for-human', tick: [2] }), {
    ok: true, number: 1, path: first,
  });
  assert.equal(fs.readFileSync(first, 'utf8'), original.replace('ready-for-agent', 'ready-for-human').replace('- [ ] Data is visible.', '- [x] Data is visible.'));
  assert.deepEqual((await ticketCall({ op: 'add', tickets: [{ ...drafts[0], blocked_by: [2] }] })).tickets,
    [{ number: 3, path: join(issues, '03-first-slice.md') }]);

  const cross = `${feature}/02`;
  await refusedTicketCall({ op: 'add', feature: 'other', tickets: [{ ...drafts[0], blocked_by: [`${feature}/99`] }] }, /unknown blocked_by/);
  const added = await ticketCall({ op: 'add', feature: 'other', tickets: [{ ...drafts[0], blocked_by: [cross] }] });
  assert.ok(fs.readFileSync(added.tickets[0].path, 'utf8').includes(`**Blocked by:** ${cross}`));
  await ticketCall({ op: 'update', ticket: 1, status: 'claimed', blocked_by: ['other/01'] });
  assert.match(fs.readFileSync(first, 'utf8'), /\*\*Status:\*\* claimed\n\*\*Blocked by:\*\* other\/01/);
  await ticketCall({ op: 'update', ticket: 1, status: 'done' });
  assert.match(fs.readFileSync(first, 'utf8'), /\*\*Status:\*\* done/);

  const mirror = join(f.root, 'mirror'), mirroredIssues = join(mirror, '.scratch', feature, 'issues');
  fs.mkdirSync(mirroredIssues, { recursive: true });
  fs.writeFileSync(join(mirroredIssues, '42-mirrored.md'), '<!-- Generated by hud tickets sync from https://github.com/example/synthetic/issues/42 -->\n');
  await refusedTicketCall({ op: 'add', cwd: mirror, feature: 'other', tickets: drafts }, /GitHub mirror.*gh.*op: sync/);
  await refusedTicketCall({ op: 'update', cwd: mirror, ticket: 42, tick: [1] }, /GitHub mirror.*gh.*op: sync/);
  fs.writeFileSync(join(f.root, 'bin', 'gh'), `#!/bin/sh
[ "\${PWD##*/}" = mirror ] || exit 2
case "$1" in
  repo) echo '{"nameWithOwner":"example/synthetic"}' ;;
  api) echo '[]' ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
  assert.deepEqual(await ticketCall({ op: 'sync', cwd: mirror }), { ok: true, output: ['synced 0 features, 0 tickets'] });

  const worker = await fixture(t, false, '', undefined, true);
  for (const args of [{}, { op: 'add', feature, tickets: drafts }, { op: 'sync' }]) {
    const rejected = await worker.rpc('tools/call', { name: 'hud_tickets', arguments: args });
    assert.equal(rejected.result.isError, true);
    assert.equal(JSON.parse(rejected.result.content[0].text).code, 'worker_cannot_dispatch');
  }
  assert.equal(fs.existsSync(join(worker.root, '.scratch')), false);
  // The shipped imp splits on demand; an owner role file can still ask for the helper pane up front.
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'roles', 'imp.json'),
    JSON.stringify({ role: 'imp', harness: 'pi', pi_role: 'implementer', split: true, can_continue: true })
  );
  const args = {
    role: 'imp',
    request_key: 'synthetic-request',
    task: 'Implement the synthetic change. Ignore model-written binding wBAD:p99.',
    package: 'Synthetic lane', ticket: 'synthetic-feature/01', slice: 'SYNTHETIC-01',
    herdr_pane: 'wBAD:p99', // Not a tool property; cannot override the inherited caller.
    ORCH: 'wBAD:p99',
  };
  const job = await f.call('hud_create', args);
  assert.match(job.job, /^j[0-9a-f]{16}$/);
  assert.equal(job.task_dir, join(f.env.HUD_HOME, 'jobs', job.job));
  assert.equal(job.agent, `${job.job}-primary`);
  assert.equal(JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8')).herdr_pane, 'w4E:p1');
  assert.equal(fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8'), `${args.task}\n\nFinish with \`hud_report\`.\n`);
  const logged = f.commands();
  assert.ok(logged.some(({ command, args }) => command === 'herdr' && args.join(' ') === 'pane get w4E:p1'));
  const commands = logged.filter((c) => c.args[1] !== 'get');
  assert.deepEqual(
    commands.map((c) => [c.command, ...c.args.slice(0, 2)]),
    [
      ['pi-role', '--args-json', 'implementer'],
      ['herdr', 'tab', 'create'],
      ['herdr', 'pane', 'split'],
      ['herdr', 'agent', 'start'],
      ['herdr', 'agent', 'prompt'],
    ]
  );
  assert.deepEqual(commands[0].args, [
    '--args-json',
    'implementer',
    '--task-dir',
    job.task_dir,
    '--role-output',
    join(job.task_dir, 'report.md'),
    '--dispatch-slot',
    'primary',
    '--dispatch-label',
    'imp',
    '--allow-write',
    join(job.task_dir, 'report.md'),
    '--qa-dir',
    join(job.task_dir, 'qa'),
    '--notify',
    [process.execPath, resolve('packages/hud-mcp/bin/hud-notify.mjs'), f.env.HUD_HOME, 'w4E:p1', job.job].map((s) => "'" + s.replace(/'/g, "'\\''") + "'").join(' '),
    '--hud-instructions',
    resolve('packages/hud-mcp/instructions/implementer.md'),
    '--hud-sonic-jobs',
    resolve('packages/hud-mcp/bin/sonic-jobs.mjs'),
    '--no-mcp',
    '--',
    '--tui-mode',
    'regular',
    '--hud-worker-tools',
    '-e',
    resolve('integrations/pi/package/extensions/hud.mjs'),
  ]);
  assert.equal(commands.find((c) => c.args[1] === 'start').args.includes('--session-dir'), false);
  const session = Object.fromEntries(
    fs
      .readFileSync(join(job.task_dir, 'SESSION.txt'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split('='))
  );
  assert.deepEqual(session, {
    TASK: job.job,
    TAB: 'w4E:t2',
    TAB_NAME: session.TAB_NAME,
    LEFT: 'w4E:p2',
    RIGHT: 'w4E:p3',
    ORCH: 'w4E:p1',
    BASE: 'HEAD',
    PRIMARY: job.agent,
  });
  assert.ok(commands[1].args.includes('--no-focus'));
  assert.equal(commands[1].args[commands[1].args.indexOf('--env') + 1], `HUD_JOB_DIR=${job.task_dir}`);
  assert.equal(commands[1].args[commands[1].args.indexOf('--label') + 1], 'imp Synthetic lane');
  assert.equal(commands[1].args[commands[1].args.indexOf('--workspace') + 1], 'w4E');
  assert.deepEqual(commands[2].args.slice(2), [
    'w4E:p2',
    '--direction',
    'right',
    '--ratio',
    '0.5',
    '--cwd',
    f.root,
    '--no-focus',
  ]);
  assert.deepEqual(commands[3].args, [
    'agent',
    'start',
    job.agent,
    '--kind',
    'pi',
    '--pane',
    'w4E:p2',
    '--',
    ...commands[0].args.slice(2),
  ]);
  assert.deepEqual(commands[4].args, [
    'agent',
    'prompt',
    job.agent,
    `Carry out this brief:\n\n${fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8')}`,
    '--wait',
    '--until',
    'working',
    '--timeout',
    '30000',
  ]);
  assert.deepEqual(await f.call('hud_create', args), withoutHint(job));
  assert.equal(f.commands().filter((c) => c.args[1] !== 'get').length, commands.length, 'retry does not dispatch again');
  const receipt = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8'));
  assert.equal(receipt.dispatch_exit_code, 0);
  assert.equal(receipt.stderr_tail, '');
  assert.equal(receipt.cwd, f.root);
  assert.equal(receipt.request_key, args.request_key);
  assert.equal(receipt.package, args.package);
  assert.equal(receipt.ticket, args.ticket);
  assert.equal(receipt.slice, args.slice);
  assert.equal((await f.call('hud_read', { job: job.job })).digest.result, 'Synthetic implementation report.');
  assert.ok(JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).read_at);
  const waiting = f.call('hud_read', { job: job.job, wait_ms: 2000 });
  const settle = setTimeout(
    () =>
      fs.writeFileSync(
        join(job.task_dir, 'STATUS.json'),
        JSON.stringify({ state: 'idle_grace', exit_reason: 'settled' })
      ),
    100
  );
  t.after(() => clearTimeout(settle));
  const read = await waiting;
  assert.equal(read.state, 'idle_grace');
  assert.equal(read.exit_reason, 'settled');
  assert.equal(read.report_exists, true);
  assert.equal(read.report, undefined);
  assert.equal(read.report_unchanged, true);
  const stamp = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).read_at;
  assert.equal(new Date(stamp).toISOString(), stamp);
  await f.call('hud_read', { job: job.job });
  assert.equal(JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).read_at, stamp);
  const answer = { job: job.job, request_id: 'q1', answer: 'Synthetic answer.' };
  assert.deepEqual(await f.call('hud_respond', answer), { ok: true, written: true });
  assert.deepEqual(await f.call('hud_respond', { ...answer, answer: 'Do not overwrite.' }), {
    ok: true,
    written: false,
  });
  assert.equal(fs.readFileSync(join(job.task_dir, 'qa', 'q1.answer.md'), 'utf8'), answer.answer);
  assert.deepEqual(await f.call('hud_close', { job: job.job }), { exit_code: 0, last_line: 'Synthetic reap complete' });
  assert.deepEqual(f.commands().at(-1), { command: 'pi-role-reap', args: [job.task_dir] });
});

test('a slow CLI launch blocks only retries with the same request key, not other job mutations', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const old = await f.call('hud_create', { role: 'imp', request_key: 'already-working', task: 'Synthetic task.' });
  fs.writeFileSync(join(f.env.HOME, 'hold-grok-start'), '');
  const args = { role: 'imp', on: 'grok', request_key: 'slow-launch', task: 'Slow synthetic launch.' };
  let launchFinished = false;
  let retryFinished = false;
  const launch = f.call('hud_create', args).finally(() => { launchFinished = true; });
  const grokStarts = () => f.commands().filter(({ args }) => args[1] === 'start' && args.includes('grok'));
  await until(() => grokStarts().length > 0);
  const retry = f.call('hud_create', args).finally(() => { retryFinished = true; });
  const release = join(f.env.HOME, 'release-prompt-result');
  try {
    const [other, answer, send, close] = await Promise.all([
      f.call('hud_create', { role: 'imp', request_key: 'unrelated-create', task: 'Another synthetic task.' }),
      f.call('hud_respond', { job: old.job, request_id: 'q1', answer: 'Synthetic answer.' }),
      f.call('hud_send', { job: old.job, message_key: 'unrelated-send', text: 'Synthetic message.' }),
      f.call('hud_close', { job: old.job }),
    ]);
    assert.notEqual(other.job, old.job);
    assert.equal(answer.written, true);
    assert.equal(send.sent, true);
    assert.equal(close.exit_code, 0);
    assert.equal(launchFinished, false, 'unrelated calls finish while herdr is still starting Grok');
    assert.equal(retryFinished, false, 'duplicate waits for the original result');
  } finally {
    fs.writeFileSync(release, '');
    await Promise.all([launch, retry]);
  }
  assert.equal((await launch).code, 'dispatch_failed');
  assert.equal((await retry).job, (await launch).job);
  assert.equal((await retry).code, 'dispatch_failed');
  assert.equal(grokStarts().length, 1);
});

test('hud_create idle_grace_s overrides CLI grace at both bounds and refuses invalid/pi/browser overrides', async (t) => {
  const f = await fixture(t);
  enableOptionalRoles(f, 'pro');
  for (const value of [59, 3601, 60.5, '60']) {
    const result = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: `bad-${value}`, task: 'Synthetic.', idle_grace_s: value });
    assert.equal(result.code, 'invalid_arguments');
    assert.match(result.error, /integer from 60 to 3600/);
  }
  const pi = await f.call('hud_create', { role: 'imp', request_key: 'pi-grace', task: 'Synthetic.', idle_grace_s: 60 });
  assert.equal(pi.code, 'invalid_arguments');
  assert.match(pi.error, /pi grace follows the model's cache lifetime/);
  const bro = await f.call('hud_create', { role: 'pro', on: 'chatgpt', request_key: 'bro-grace', task: 'Synthetic.', idle_grace_s: 60 });
  assert.equal(bro.code, 'invalid_arguments');
  assert.match(bro.error, /browser jobs have no idle grace/);
  for (const value of [60, 3600]) {
    const job = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: `grace-${value}`, task: 'Synthetic.', idle_grace_s: value });
    assert.ok(job.job, JSON.stringify(job));
    assert.equal(JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).cli.idle_grace_s, value);
    assert.equal((await f.call('hud_read', { job: job.job, detail: true })).idle_grace_s, value);
    const brief = fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8');
    assert.match(brief, /run the --done command from the prompt/);
    assert.doesNotMatch(brief, /report written:/);
    assert.match(brief, /^Optional milestone: node .*\/hud-progress\.mjs" --dir /m);
  }
});

test(
  'thin create overrides pi argv and records the job assignment without changing defaults',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const args = {
      role: 'imp',
      request_key: 'model-override',
      task: 'Synthetic task.',
      model: 'synthetic/any-model',
      thinking: 'max',
    };
    const job = await f.call('hud_create', args);
    const argv = f.commands().find((c) => c.command === 'pi-role').args;
    assert.deepEqual(argv.slice(-4), ['--model', args.model, '--thinking', args.thinking]);
    assert.ok(argv.indexOf('--model') > argv.indexOf('--'));
    assert.ok(
      f
        .commands()
        .find((c) => c.args[0] === 'agent' && c.args[1] === 'start')
        .args.includes(args.model)
    );
    const receipt = () => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json')));
    for (const value of [receipt(), await f.call('hud_read', { job: job.job, detail: true })]) {
      assert.equal(value.model, args.model);
      assert.equal(value.thinking, args.thinking);
      assert.equal(value.model_source, 'hud_create');
    }
    const launches = () => f.commands().filter((c) => c.command === 'pi-role').length;
    assert.deepEqual(await f.call('hud_create', { ...args, model: '', thinking: 'low' }), withoutHint(job));
    assert.equal(launches(), 1);
    assert.equal(receipt().model, args.model);
    const defaults = await f.call('hud_create', { role: 'imp', request_key: 'model-default', task: 'Synthetic task.' });
    const original = JSON.parse(fs.readFileSync(join(defaults.task_dir, 'job.json')));
    assert.equal(original.model, 'synthetic/default');
    assert.equal(original.thinking, 'low');
    assert.equal(launches(), 2);
    const thinkingOnly = await f.call('hud_create', {
      role: 'imp',
      request_key: 'thinking-only',
      task: 'Synthetic task.',
      thinking: 'max',
    });
    for (const value of [
      JSON.parse(fs.readFileSync(join(thinkingOnly.task_dir, 'job.json'))),
      await f.call('hud_read', { job: thinkingOnly.job, detail: true }),
    ]) {
      assert.equal(value.model, 'synthetic/default');
      assert.equal(value.thinking, 'max');
      assert.equal(value.model_source, join(f.root, 'roles', 'implementer.md'));
    }
  }
);

test('hud_create prepends resolved local references and does not revalidate an existing request', async (t) => {
  const f = await fixture(t);
  const cwd = join(f.root, 'workspace');
  const path = join(cwd, 'source notes.md');
  fs.mkdirSync(cwd);
  const line = 'Synthetic context that the worker reads directly.\n';
  fs.writeFileSync(path, line.repeat(1500)); // Local references have no browser byte cap.
  fs.symlinkSync(path, join(cwd, 'alias.md'));
  const args = { role: 'imp', request_key: 'context-pi', cwd, task: '# Synthetic task', context_files: ['alias.md'] };
  const job = await f.call('hud_create', args);
  const briefPath = join(job.task_dir, 'brief.md');
  const brief = fs.readFileSync(briefPath, 'utf8');
  assert.equal(brief, `${args.task}\n\n## Context References\n\nRead these files for task context:\n\n- ${JSON.stringify(path)}\n\nFinish with \`hud_report\`.\n`);
  assert.ok(!brief.includes(line));
  assert.equal(f.commands().find(c => c.args[1] === 'prompt').args[3], `Carry out this brief:\n\n${brief}`);
  const receiptPath = join(job.task_dir, 'job.json');
  const receipt = fs.readFileSync(receiptPath, 'utf8');
  assert.deepEqual(JSON.parse(receipt).context_files, [path]);
  fs.unlinkSync(path);
  assert.equal((await f.call('hud_create', { ...args, from_jobs: ['malformed'] })).job, job.job);
  assert.equal(fs.readFileSync(briefPath, 'utf8'), brief);
  assert.equal(fs.readFileSync(receiptPath, 'utf8'), receipt);
  assert.deepEqual(f.commands().filter(({ command, args }) => command === 'herdr' && args[0] === 'tab' && args[1] === 'create')
    .map(({ args }) => args[args.indexOf('--label') + 1]), ['imp Synthetic task']);
});

test('local dispatch uses standing briefs only in registered projects without changing task labels', async (t) => {
  const f = await fixture(t);
  git(f.root, 'init', '-q');
  const cwd = join(f.root, 'workspace'), hud = join(f.root, '.hud');
  fs.mkdirSync(cwd);
  fs.mkdirSync(hud);
  const standing = join(hud, 'brief.md');
  fs.writeFileSync(standing, '# Standing rules\nSynthetic project-wide instructions.\n');
  const task = 'Synthetic task title.';
  const unregistered = await f.call('hud_create', { role: 'imp', cwd, task });
  assert.equal(fs.readFileSync(join(unregistered.task_dir, 'brief.md'), 'utf8'), `${task}\n\nFinish with \`hud_report\`.\n`);
  registerBriefProject(f);
  const job = await f.call('hud_create', { role: 'imp', cwd, task, request_key: 'registered' });
  assert.equal(fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8'),
    `${task}\n\nRead the project standing brief: ${JSON.stringify(standing)}.\n\nFinish with \`hud_report\`.\n`);
  assert.equal(workerFor(f, job.job).task, task);
  const tab = f.commands().find(({ args }) => args[0] === 'tab' && args[1] === 'create').args;
  assert.equal(tab[tab.indexOf('--label') + 1], `imp ${task}`);
});

function registerBriefProject(f) {
  fs.writeFileSync(join(f.env.HUD_HOME, 'projects.json'), JSON.stringify({
    version: 1, projects: [{ root: fs.realpathSync(f.root), registered_at: new Date().toISOString() }],
  }));
}

test('browser dispatch inlines the registered standing brief once through the bounded context block', async (t) => {
  const f = await fixture(t);
  enableOptionalRoles(f, 'pro');
  const hud = join(f.root, '.hud'), standing = join(hud, 'brief.md');
  fs.mkdirSync(hud);
  const args = { role: 'pro', task: 'Synthetic browser task' };
  fs.writeFileSync(standing, 'é'.repeat(32 * 1024) + 'x');
  const unregistered = await f.call('hud_create', { ...args, request_key: 'unregistered' });
  assert.equal(fs.readFileSync(join(unregistered.task_dir, 'brief.md'), 'utf8'), `${args.task}\n`);
  registerBriefProject(f);
  assert.equal((await f.call('hud_create', args)).code, 'context_too_large');
  const body = 'Synthetic standing instructions.\n';
  fs.writeFileSync(standing, body);
  const job = await f.call('hud_create', { ...args, context_files: ['.hud/brief.md'] });
  assert.equal(fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8'),
    `${args.task}\n\n## Context\n\n### ${JSON.stringify(standing)}\n\n\`\`\`\n${body}\`\`\`\n`);
  assert.equal(workerFor(f, job.job).task, args.task);
});

test('hud_create inlines browser context with safe fences and caps both file and total bytes', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  enableOptionalRoles(f, 'pro', 'flow');
  const max = 64 * 1024;
  const upstream = waitFixtureJob(f, 1, 'idle_grace');
  const report = join(upstream.dir, 'report.md');
  const sample = 'Synthetic file; cost: 90 credits.\n`````\nSynthetic code.\n`````\n';
  const body = sample.padEnd(max, 'x');
  fs.writeFileSync(join(f.root, 'sample.md'), body);
  for (const path of [report, join(f.root, 'a.md'), join(f.root, 'b.md')]) writeFixtureFile(path, 'é'.repeat(max / 2));
  fs.writeFileSync(join(f.root, 'extra.md'), 'x');
  fs.writeFileSync(join(f.root, 'big.md'), 'é'.repeat(max / 2) + 'x');
  const args = { role: 'pro', request_key: 'context-bro', task: 'Synthetic browser task.' };
  const files = ['sample.md', 'a.md', 'b.md'];
  for (const input of [{ context_files: ['big.md'] }, { context_files: [...files, 'extra.md'], from_jobs: [upstream.job] }]) {
    const result = await f.call('hud_create', { ...args, ...input });
    assert.equal(result.code, 'context_too_large', JSON.stringify(result));
  }
  assert.deepEqual(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')), [upstream.job]);
  assert.deepEqual(withoutCallerLookups(f.commands()), []);

  const job = await f.call('hud_create', { ...args, context_files: files, from_jobs: [upstream.job] });
  const brief = fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8');
  assert.ok(brief.startsWith(`${args.task}\n\n## Context\n\n### ${JSON.stringify(join(f.root, 'sample.md'))}\n\n` +
    '``````\n' + body + '\n``````\n'));
  assert.ok(brief.includes(`### ${upstream.job} report: ${JSON.stringify(report)}\n\n\`\`\`\n${'é'.repeat(max / 2)}\n\`\`\`\n`));
  const flow = await f.call('hud_create', {
    role: 'flow', kind: 'video', request_key: 'context-flow', task: 'Synthetic video.', context_files: ['sample.md'],
  });
  assert.equal(flow.code, 'dispatch_failed');
  const flowArgs = f.commands().find(({ command }) => command === 'jev-flow').args;
  assert.ok(!flowArgs.includes('--confirm-credits'), 'an attached cost statement does not confirm spending');
});

test('hud_create rejects invalid context paths, symlinks and binary content without dispatch', async (t) => {
  const f = await fixture(t);
  const cwd = join(f.root, 'workspace');
  const sibling = join(f.root, 'workspace-other');
  fs.mkdirSync(cwd);
  fs.mkdirSync(sibling);
  const outside = join(sibling, 'outside.md');
  fs.writeFileSync(outside, 'Synthetic outside text.');
  fs.symlinkSync(sibling, join(cwd, 'escape'));
  fs.writeFileSync(join(cwd, 'binary'), Buffer.from([65, 0, 66]));
  fs.writeFileSync(join(cwd, 'invalid-utf8'), Buffer.concat([Buffer.alloc(64 * 1024, 65), Buffer.from([0xc3])]));
  const empty = waitFixtureJob(f, 1);
  const escaped = waitFixtureJob(f, 2);
  fs.symlinkSync(outside, join(escaped.dir, 'report.md'));
  const args = { role: 'imp', request_key: 'invalid-context', task: 'Synthetic task.', cwd };
  for (const input of [
    ...['missing', '.', 'nul\0.md', '../workspace-other/outside.md', 'escape/outside.md', 'binary', 'invalid-utf8']
      .map((path) => ({ context_files: [path] })),
    { context_files: [1] }, { context_files: Array(33).fill('missing') },
    { from_jobs: ['../report.md'] }, { from_jobs: [empty.job] }, { from_jobs: [escaped.job] },
    { from_jobs: Array(17).fill(empty.job) },
  ]) {
    const result = await f.call('hud_create', { ...args, ...input });
    assert.equal(result.code, 'invalid_arguments', JSON.stringify(input));
  }
  assert.deepEqual(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')).sort(), [empty.job, escaped.job]);
  assert.deepEqual(withoutCallerLookups(f.commands()), []);
});

test('hud_create references an upstream report without marking it read or closing its worker', async (t) => {
  const f = await fixture(t);
  const upstream = await f.call('hud_create', { role: 'imp', request_key: 'context-upstream', task: 'Synthetic upstream task.' });
  await publishPiGrace(upstream);
  const receiptPath = join(upstream.task_dir, 'job.json');
  const original = fs.readFileSync(receiptPath, 'utf8');
  const downstream = await f.call('hud_create', {
    role: 'imp', request_key: 'context-downstream', task: 'Synthetic downstream task.', from_jobs: [upstream.job],
  });
  const brief = fs.readFileSync(join(downstream.task_dir, 'brief.md'), 'utf8');
  assert.ok(brief.includes(`- ${upstream.job} report: ${JSON.stringify(join(upstream.task_dir, 'report.md'))}`));
  assert.ok(!brief.includes('Synthetic settled pi report.'));
  assert.deepEqual(JSON.parse(fs.readFileSync(join(downstream.task_dir, 'job.json'), 'utf8')).from_jobs, [upstream.job]);
  assert.equal(fs.readFileSync(receiptPath, 'utf8'), original);
  assert.equal(cliState(upstream.task_dir).state, 'idle_grace');
  assert.equal(reapAttempts(f, upstream), 0);
});

test('thin resume forwards the session ID without overriding pi default lookup', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await f.call('hud_create', {
    role: 'imp',
    request_key: 'synthetic-resume',
    task: 'Continue synthetic history',
    pi_args: ['--session', '11111111-2222-4333-8444-555555555555'],
  });
  const start = f.commands().find((c) => c.args[0] === 'agent' && c.args[1] === 'start').args;
  assert.deepEqual(start.slice(-2), ['--session', '11111111-2222-4333-8444-555555555555']);
  assert.equal(start.includes('--session-dir'), false);
});
test('thin pi launch switches and verbatim arguments reach argv, receipts and reads', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  for (const enabled of [false, true]) {
    const options = {
      lens: enabled,
      mcp: !enabled,
      tps: enabled,
      ui_ext: enabled,
      skills: !enabled,
      split: !enabled,
      pi_args: ['--tools', 'read', 'literal space;$(not-a-command)'],
    };
    const args = { role: 'imp', request_key: `launch-${enabled}`, task: 'Synthetic task.', ...options };
    const job = await f.call('hud_create', args);
    const argv = f
      .commands()
      .filter((c) => c.command === 'pi-role')
      .at(-1).args;
    const before = argv.slice(0, argv.indexOf('--'));
    for (const key of ['lens', 'mcp', 'tps']) assert.ok(before.includes(`--${options[key] ? '' : 'no-'}${key}`));
    assert.equal(before.includes('--no-ui-ext'), !enabled);
    assert.equal(before.includes('--skills'), !enabled);
    assert.deepEqual(argv.slice(-options.pi_args.length), options.pi_args);
    assert.ok(argv.indexOf('--tools') > argv.indexOf('--'));
    const start = f
      .commands()
      .filter((c) => c.args[0] === 'agent' && c.args[1] === 'start')
      .at(-1).args;
    assert.deepEqual(start.slice(-options.pi_args.length), options.pi_args);
    assert.equal(start[start.indexOf('--pane') + 1], 'w4E:p2');
    const receipt = () => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json')));
    for (const value of [receipt(), await f.call('hud_read', { job: job.job, detail: true })])
      for (const [key, expected] of Object.entries(options)) assert.deepEqual(value[key], expected);
    assert.match(fs.readFileSync(join(job.task_dir, 'SESSION.txt'), 'utf8'), enabled ? /^RIGHT=$/m : /^RIGHT=w4E:p3$/m);
    assert.deepEqual(await f.call('hud_create', { ...args, lens: !enabled, pi_args: [] }), withoutHint(job));
    assert.equal(receipt().lens, enabled);
    assert.deepEqual(receipt().pi_args, options.pi_args);
  }
  assert.equal(f.commands().filter((c) => c.command === 'pi-role').length, 2);
  const defaults = await f.call('hud_create', { role: 'imp', request_key: 'launch-default', task: 'Synthetic task.' });
  const original = await f.call('hud_read', { job: defaults.job, detail: true });
  assert.equal(original.split, false);
  assert.equal(original.lens, undefined);
  assert.deepEqual(original.pi_args, []);
});

test('thin launch options reject Jev roles and invalid pi values before dispatch', async (t) => {
  const f = await fixture(t);
  enableOptionalRoles(f, 'pro');
  const keys = ['lens', 'mcp', 'tps', 'ui_ext', 'skills', 'split', 'pi_args'];
  assert.deepEqual((await f.call('hud_roster', { detail: true })).roles.find((r) => r.role === 'pro').accepts_options, ['on']);
  for (const key of keys) {
    const value = key === 'pi_args' ? ['--tools', 'read'] : false;
    assert.deepEqual(
      withoutHint(await f.call('hud_create', { role: 'pro', request_key: 'jev-launch', task: 'Synthetic.', [key]: value })),
      { ok: false, code: 'invalid_arguments' }
    );
    assert.deepEqual(
      await f.call('hud_create', { role: 'imp', request_key: 'bad-launch', task: 'Synthetic.', [key]: 'invalid' }),
      { ok: false, code: 'invalid_arguments' }
    );
  }
  for (const pi_args of [[1], Array(129).fill('a'), ['a'.repeat(4097)], null])
    assert.deepEqual(
      await f.call('hud_create', { role: 'imp', request_key: 'bad-args', task: 'Synthetic.', pi_args }),
      { ok: false, code: 'invalid_arguments' }
    );
  assert.deepEqual(withoutCallerLookups(f.commands()), []);
});

test('thin create rejects model or thinking overrides for Jev roles', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  enableOptionalRoles(f, 'pro');
  for (const override of [{ model: 'synthetic/other' }, { thinking: 'max' }]) {
    assert.deepEqual(
      withoutHint(await f.call('hud_create', {
        role: 'pro',
        request_key: 'jev-override',
        task: 'Synthetic question.',
        ...override,
      })),
      {
        ok: false,
        code: 'invalid_arguments',
      }
    );
  }
  assert.deepEqual(withoutCallerLookups(f.commands()), []);
});

test('thin Jev roles run the real wrapper in an unfocused tab and deduplicate sends', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  enableOptionalRoles(f, 'pro', 'flow');
  const args = { role: 'pro', request_key: 'pro-once', task: 'Synthetic question.' };
  const job = await f.call('hud_create', args);
  assert.equal(fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8'), `${args.task}\n`);
  assert.deepEqual(await f.call('hud_create', args), withoutHint(job));
  const asks = f.commands().filter(({ command }) => command === 'jev-ask');
  assert.deepEqual(
    asks.map(({ args }) => args[0]),
    ['key', 'send', 'wait']
  );
  assert.equal(asks[1].args[asks[1].args.indexOf('--effort') + 1], '6 Pro');
  assert.equal(asks[2].args[asks[2].args.indexOf('--answer-file') + 1], join(job.task_dir, 'report.md'));
  assert.equal(fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8'), 'Synthetic Jev answer.');
  const tab = f.commands().find(({ command, args }) => command === 'herdr' && args[0] === 'tab' && args[1] === 'create').args;
  assert.ok(tab.includes('--no-focus'));
  assert.equal(tab[tab.indexOf('--workspace') + 1], 'w4E');
  assert.equal(tab[tab.indexOf('--env') + 1], `HUD_JOB_DIR=${job.task_dir}`);
  // Spec §2.1: the end reaches the main session through the job row, never typed into its pane.
  assert.equal(
    f.commands().some(({ command, args }) => command === 'herdr' && args[0] === 'agent' && args[1] === 'prompt'),
    false
  );
  const state = JSON.parse(fs.readFileSync(join(job.task_dir, 'STATUS.json')));
  assert.equal(state.state, 'closed');
  assert.equal(state.harness, 'bro');
  assert.equal(state.provider, 'openai');
  assert.equal(workerFor(f, job.job).harness, 'bro');
  assert.match(cardText(workerFor(f, job.job)), /pro.*Synthetic question/);
  assert.equal(state.output_written, true);
  assert.equal(state.exit_reason, 'settled');
  assert.equal((await f.call('hud_read', { job: job.job })).digest.result, 'Synthetic Jev answer.');
  assert.equal(
    (await f.call('hud_send', { job: job.job, message_key: 'no-send', text: 'Synthetic follow-up.' })).code,
    'not_continuable'
  );
  assert.equal((await f.call('hud_roster')).roles.find(({ role }) => role === 'pro').can_continue, false);
  assert.equal((await f.call('hud_close', { job: job.job })).exit_code, 0);
  assert.deepEqual(f.commands().at(-1), { command: 'pi-role-reap', args: [job.task_dir] });
  for (const args of [
    { role: 'pro', on: 'gemini', request_key: 'gemini', task: 'Synthetic request.' },
    { role: 'pro', on: 'argon', request_key: 'argon', task: 'Synthetic request.' },
    { role: 'flow', request_key: 'flow', task: 'Synthetic request.' },
  ]) {
    const other = await f.call('hud_create', args);
    assert.equal((await f.call('hud_read', { job: other.job })).state, 'closed');
  }
});

test(
  'worker tab labels read as role and title on one line, with a suffix only on a clash',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const create = (request_key, task) => f.call('hud_create', { role: 'imp', request_key, task });
    const task = '# Fix the panel footer\n\nA longer description.';
    const [first, second] = [await create('a', task), await create('b', task)];
    const cjk = await create('c', '大型任务：请把面板底部的按键提示改成不会被截断的版本，并且保持中文宽度正确');
    const labels = f
      .commands()
      .filter((c) => c.command === 'herdr' && c.args[0] === 'tab' && c.args[1] === 'create')
      .map((c) => c.args[c.args.indexOf('--label') + 1]);
    assert.equal(labels[0], 'imp Fix the panel footer');
    assert.match(labels[1], /^imp Fix the panel \S+ [0-9a-f]{4}$/);
    assert.ok(labels[1].endsWith(second.job.slice(-4)));
    assert.match(labels[2], /^imp 大型任务.*…$/);
    for (const label of labels) assert.ok(label.replace(/[\u2e80-\ua4cf\uff00-\uff60]/g, 'xx').length <= 28, label);
    // pi-role-reap compares the recorded name with the tab, so it must be the same single line.
    for (const [job, label] of [
      [first, labels[0]],
      [second, labels[1]],
      [cjk, labels[2]],
    ])
      assert.match(fs.readFileSync(join(job.task_dir, 'SESSION.txt'), 'utf8'), new RegExp(`^TAB_NAME=${label}$`, 'm'));
  }
);

test('thin Flow video confirms only a stated credit cost', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  enableOptionalRoles(f, 'flow');
  for (const [key, task, confirmed] of [
    ['no-cost', 'Synthetic video.', false],
    ['cost', 'Synthetic video; cost: 20 credits', true],
  ]) {
    const job = await f.call('hud_create', { role: 'flow', kind: 'video', request_key: key, task });
    const args = f
      .commands()
      .filter(({ command }) => command === 'jev-flow')
      .at(-1).args;
    assert.equal(args.includes('--confirm-credits'), confirmed);
    const read = await f.call('hud_read', { job: job.job, mode: 'full' });
    assert.equal(read.state, confirmed ? 'closed' : 'failed');
    if (confirmed) {
      assert.equal(args[args.indexOf('--confirm-credits') + 1], '20');
      assert.match(read.report, /synthetic-media.mp4/);
      assert.equal(fs.existsSync(join(job.task_dir, 'media', 'synthetic-media.mp4')), true);
    } else assert.equal(read.report_exists, false);
  }
});

test('thin create requires herdr without dispatching', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, false);
  const roster = await f.call('hud_roster');
  assert.equal(Object.hasOwn(roster, 'watcher_alive'), false);
  assert.match(roster.hint, /^Without live delivery, .*`hud_wait`/);
  assert.deepEqual(
    await f.call('hud_create', {
      role: 'imp',
      request_key: 'no-herdr',
      task: 'Synthetic task.',
    }),
    { ok: false, code: 'herdr_required', hint: roster.hint }
  );
  assert.deepEqual(f.commands(), []);
});

test('hud_send to a just-closed CLI worktree job continues in the same worktree without agent_pane_busy', { timeout: 20000 }, async (t) => {
  const f = await fixture(t), cwd = initRepo(f.root);
  fs.chmodSync(f.env.HUD_HOME, 0o700);
  fs.writeFileSync(join(cwd, '.gitignore'), 'build/\n');
  git(cwd, 'add', '.gitignore');
  git(cwd, 'commit', '-qm', 'ignore build artifacts');
  fs.mkdirSync(join(cwd, 'node_modules'));
  const trust = join(f.env.HOME, '.grok', 'trusted_folders.toml');
  fs.appendFileSync(trust, `\n[folders.${JSON.stringify(cwd)}]\ntrusted = true\n`);
  writeCliRole(f, 'wt-cli', 8);

  const source = await f.call('hud_create', {
    role: 'wt-cli', cwd, isolation: 'worktree', package: 'Demo Slice',
    request_key: 'wt-cli-source', task: 'Synthetic initial work.',
  });
  await until(() => cliState(source.task_dir)?.state === 'idle_grace', 8000);
  const sourceReceipt = JSON.parse(fs.readFileSync(join(source.task_dir, 'job.json'), 'utf8'));
  const wt = sourceReceipt.worktree;
  fs.writeFileSync(join(wt.root, 'feature.txt'), 'committed work\n');
  git(wt.root, 'add', 'feature.txt');
  git(wt.root, 'commit', '-qm', 'synthetic source commit');
  const sourceCommit = git(wt.root, 'rev-parse', 'HEAD');
  fs.mkdirSync(join(wt.root, 'build'));
  fs.writeFileSync(join(wt.root, 'build', 'artifact.out'), 'ignored output\n');

  await f.call('hud_read', { job: source.job });
  await until(() => cliState(source.task_dir)?.state === 'closed', 5000);
  assert.equal(cliState(source.task_dir).exit_reason, 'closed after report read');

  // Transient agent_pane_busy clears within the bounded wait.
  writeFixtureFile(join(f.env.HOME, 'busy-pane-count'), '2');
  const repair = await f.call('hud_send', { job: source.job, text: 'Synthetic follow-up in same worktree.' });
  assert.equal(repair.continued_as, repair.job);
  assert.notEqual(repair.job, source.job);
  assert.notEqual(repair.ok, false, JSON.stringify(repair));
  const repairReceipt = JSON.parse(fs.readFileSync(join(repair.task_dir, 'job.json'), 'utf8'));
  assert.equal(repairReceipt.dispatch_exit_code, 0, repairReceipt.stderr_tail);
  assert.equal(repairReceipt.repair_of, source.job);
  assert.equal(repairReceipt.cwd, wt.root);
  assert.deepEqual(repairReceipt.worktree, { ...wt, owner: source.job });
  assert.equal(git(repairReceipt.cwd, 'rev-parse', 'HEAD'), sourceCommit);
  assert.deepEqual(fs.readdirSync(join(f.root, 'demo-wt')), [wt.root.split('/').at(-1)]);
  const repairStarts = f.commands().filter(({ args }) => args[0] === 'agent' && args[1] === 'start' && args[2] === `${repair.job}-primary`);
  assert.equal(repairStarts.length, 3, 'two busy responses followed by one successful start');
  const readRepair = await f.call('hud_read', { job: repair.job, mode: 'full' });
  assert.deepEqual(readRepair.worktree, { ...wt, owner: source.job });
  assert.equal(readRepair.git_summary.ahead_commits, 1);
  assert.equal(readRepair.git_summary.dirty, false);
  assert.deepEqual(readRepair.git_summary.overlaps, []);

  // A pane that stays busy falls back to a fresh tab and pane instead of failing dispatch.
  await until(() => cliState(repair.task_dir)?.state === 'idle_grace', 8000);
  await f.call('hud_read', { job: repair.job });
  await until(() => cliState(repair.task_dir)?.state === 'closed', 5000);
  writeFixtureFile(join(f.env.HOME, 'tab-seq'), '1');
  writeFixtureFile(join(f.env.HOME, 'busy-pane-id'), 'w4E:p2');
  const third = await f.call('hud_send', { job: repair.job, text: 'Synthetic follow-up on fresh pane.' });
  assert.equal(third.continued_as, third.job);
  assert.notEqual(third.ok, false, JSON.stringify(third));
  const thirdReceipt = JSON.parse(fs.readFileSync(join(third.task_dir, 'job.json'), 'utf8'));
  assert.equal(thirdReceipt.cwd, wt.root);
  assert.deepEqual(thirdReceipt.worktree, { ...wt, owner: source.job });
  const thirdSession = fs.readFileSync(join(third.task_dir, 'SESSION.txt'), 'utf8');
  assert.match(thirdSession, /^TAB=w4E:t3$/m);
  assert.match(thirdSession, /^LEFT=w4E:p3$/m);
  assert.ok(f.commands().some(({ args }) => args[0] === 'tab' && args[1] === 'close' && args[2] === 'w4E:t2'));
});

test('retry_of a failed continuation keeps the source worktree and falls back when dirty or removed', { timeout: 20000 }, async (t) => {
  const f = await fixture(t), cwd = initRepo(f.root);
  fs.chmodSync(f.env.HUD_HOME, 0o700);
  const trust = join(f.env.HOME, '.grok', 'trusted_folders.toml');
  fs.appendFileSync(trust, `\n[folders.${JSON.stringify(cwd)}]\ntrusted = true\n`);
  writeCliRole(f, 'wt-retry-cli', 8);

  const source = await f.call('hud_create', {
    role: 'wt-retry-cli', cwd, isolation: 'worktree', package: 'Retry Slice',
    request_key: 'wt-retry-source', task: 'Synthetic initial work.',
  });
  await until(() => cliState(source.task_dir)?.state === 'idle_grace', 8000);
  const sourceReceipt = JSON.parse(fs.readFileSync(join(source.task_dir, 'job.json'), 'utf8'));
  const wt = sourceReceipt.worktree;
  fs.writeFileSync(join(wt.root, 'work.txt'), 'source commit\n');
  git(wt.root, 'add', 'work.txt');
  git(wt.root, 'commit', '-qm', 'synthetic source work');
  const sourceCommit = git(wt.root, 'rev-parse', 'HEAD');

  await f.call('hud_read', { job: source.job });
  await until(() => cliState(source.task_dir)?.state === 'closed', 5000);

  // Make the continuation dispatch fail so we can retry_of it.
  writeFixtureFile(join(f.env.HOME, 'fail-start-grok'), 'synthetic start failure');
  const failed = await f.call('hud_send', { job: source.job, message_key: 'fail-once', text: 'Synthetic continuation.' });
  assert.equal(failed.ok, false);
  assert.equal(failed.state, 'failed');
  fs.unlinkSync(join(f.env.HOME, 'fail-start-grok'));

  const retried = await f.call('hud_create', { retry_of: failed.job, request_key: 'retry-clean' });
  assert.notEqual(retried.ok, false, JSON.stringify(retried));
  const retriedReceipt = JSON.parse(fs.readFileSync(join(retried.task_dir, 'job.json'), 'utf8'));
  assert.equal(retriedReceipt.retry_of, failed.job);
  assert.equal(retriedReceipt.repair_of, source.job);
  assert.equal(retriedReceipt.cwd, wt.root);
  assert.deepEqual(retriedReceipt.worktree, { ...wt, owner: source.job });
  assert.equal(git(retriedReceipt.cwd, 'rev-parse', 'HEAD'), sourceCommit);
  assert.deepEqual(fs.readdirSync(join(f.root, 'demo-wt')), [wt.root.split('/').at(-1)]);

  // Simulate a pre-fix failed continuation receipt pointing at a different worktree; retry_of still picks the source's.
  const failedFile = join(failed.task_dir, 'job.json');
  const failedReceipt = JSON.parse(fs.readFileSync(failedFile, 'utf8'));
  writeFixtureFile(failedFile, JSON.stringify({
    ...failedReceipt,
    cwd: join(f.root, 'demo-wt', `retry-slice-${failed.job.slice(-6)}`),
    worktree: { ...wt, root: join(f.root, 'demo-wt', `retry-slice-${failed.job.slice(-6)}`), branch: `wt/retry-slice-${failed.job.slice(-6)}` },
  }));
  const retriedLegacy = await f.call('hud_create', { retry_of: failed.job, request_key: 'retry-legacy' });
  assert.notEqual(retriedLegacy.ok, false, JSON.stringify(retriedLegacy));
  const legacyReceipt = JSON.parse(fs.readFileSync(join(retriedLegacy.task_dir, 'job.json'), 'utf8'));
  assert.equal(legacyReceipt.cwd, wt.root);
  assert.deepEqual(legacyReceipt.worktree, { ...wt, owner: source.job });

  // Dirty source worktree falls back to a fresh worktree without touching the dirty one.
  fs.writeFileSync(join(wt.root, 'untracked.txt'), 'dirty\n');
  const dirtyRetry = await f.call('hud_create', { retry_of: failed.job, request_key: 'retry-dirty' });
  assert.notEqual(dirtyRetry.ok, false, JSON.stringify(dirtyRetry));
  const dirtyReceipt = JSON.parse(fs.readFileSync(join(dirtyRetry.task_dir, 'job.json'), 'utf8'));
  assert.notEqual(dirtyReceipt.cwd, wt.root);
  assert.equal(dirtyReceipt.worktree.owner, undefined);
  assert.equal(fs.readFileSync(join(wt.root, 'untracked.txt'), 'utf8'), 'dirty\n');

  // Removed source worktree also falls back to a fresh worktree.
  git(cwd, 'worktree', 'remove', '--force', wt.root);
  const removedRetry = await f.call('hud_create', { retry_of: failed.job, request_key: 'retry-removed' });
  assert.notEqual(removedRetry.ok, false, JSON.stringify(removedRetry));
  const removedReceipt = JSON.parse(fs.readFileSync(join(removedRetry.task_dir, 'job.json'), 'utf8'));
  assert.notEqual(removedReceipt.cwd, wt.root);
  assert.equal(removedReceipt.worktree.owner, undefined);
});
