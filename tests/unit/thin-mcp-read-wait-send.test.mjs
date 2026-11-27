import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { constants } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { watchCommand } from '../../dist/cli/watch.js';
import { answerJobQuestion } from '../../dist/collectors/panel-actions.js';
import { projectWorkCard } from '../../dist/collectors/work-card.js';
import { cachedReportSignature, writeReportMeta } from '../../dist/roles/report-meta.js';
import { git, initRepo } from '../fixtures/managed-worktree.mjs';
import {
  workerFor,
  cardText,
  fixture,
  workerClient,
  until,
  publishLegacyPiGrace as publishPiGrace,
  waitFixtureJob,
  ownerOf,
  paneList,
  progressRecord,
  jsonLines,
  cliState,
  watchStats as readWatchStats,
  watchStatsProbe,
} from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

const readHint = (job) => `hud_read job=${job} (mode: "full" for the whole report)`;

test('lean main-pi delegation collects first and repeat reports through native watch without polling', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  await f.startCliSocket(); // Read-close checks fake Herdr's agent state after the report is collected.
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');
  const convention = '# Synthetic project convention\n' + '- Retain the scope and evidence for this project. 下一步: read the report before accepting.\n'.repeat(26);
  fs.writeFileSync(join(f.root, 'hud-convention.md'), convention);
  // Stub the pi host API, not the HUD registration, native watcher, MCP proxy or stdio server.
  // The synthetic launcher's basename is pi so the real pane/PID watcher check is exercised.
  const launcher = join(f.root, 'pi');
  fs.writeFileSync(launcher, `
import { createInterface } from 'node:readline';
import { installPiPackage } from ${JSON.stringify(resolve('dist/harness/pi/package-entry.js'))};
const tools = new Map(), hooks = new Map();
const send = (value) => console.log(JSON.stringify(value));
const ctx = { cwd: process.cwd(), sessionManager: { getSessionDir: () => 'synthetic', getSessionId: () => 'main',
  getSessionFile: () => undefined } };
installPiPackage({
  on: (name, fn) => { hooks.set(name, fn); },
  registerTool: (tool) => { tools.set(tool.name, tool); },
  sendMessage: ({ content }) => send({ notice: content }),
}, { release: ${JSON.stringify(resolve('.'))}, hudHome: process.env.HUD_HOME, node: process.execPath }, {}, 'delegate');
await hooks.get('session_start')({}, ctx);
try {
  for await (const line of createInterface({ input: process.stdin })) {
    const { name, args } = JSON.parse(line);
    send(await tools.get(name).execute('synthetic', args, undefined, undefined, ctx));
  }
} finally { await hooks.get('session_shutdown')(); }
`);
  const pi = spawn(process.execPath, [launcher], { cwd: f.root,
    env: { ...f.env, HUD_WATCH_SETTLEMENT_MS: '250' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(pi, 'close'), notices = [], calls = [];
  let stderr = '', reply;
  pi.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  createInterface({ input: pi.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.notice) notices.push(...message.notice.split('\n'));
    else reply(message);
  });
  const call = async (name, args) => {
    const result = await Promise.race([new Promise((done) => {
      reply = done;
      pi.stdin.write(JSON.stringify({ name, args }) + '\n');
    }), exited.then(() => assert.fail(stderr || 'Synthetic pi host exited'))]);
    assert.equal(result.isError, undefined);
    const { text } = result.content[0];
    calls.push([name, Buffer.byteLength(text, 'utf8')]);
    return JSON.parse(text);
  };
  try {
    const { result } = await f.rpc('tools/list');
    const tools = result.tools.filter(({ name }) => name !== 'hud_statusline');
    const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
    t.diagnostic(`tool declarations: ${bytes(tools)} B (create ${bytes(tools.find(({ name }) => name === 'hud_create'))} B)`);
    await until(() => fs.existsSync(join(f.env.HUD_HOME, 'watchers', 'w4E:p1.pid')), t.signal);
    const roster = await call('hud_roster', { cwd: f.root });
    assert.equal(roster.watcher_alive, true);
    assert.match(roster.hint, /^pi: native HUD notices/);
    assert.equal(roster.roles.length, 6);
    assert.equal(roster.convention.text, convention);
    const imp = roster.roles.find((r) => r.role === 'imp' && r.available);
    assert.equal(imp.can_continue, true);
    assert.deepEqual(imp.runs_on, { harness: 'pi', pi_role: 'implementer', model: 'openai/gpt-6.2-sol', thinking: 'high' });
    let repeated, collected;
    for (const request_key of ['lean-first', 'lean-repeat']) {
      const created = await call('hud_create', { role: imp.role, cwd: f.root, request_key, task: 'Synthetic task: 新 report.' });
      repeated = created.job;
      assert.equal(created.watcher_alive, true);
      assert.equal(created.hint, request_key === 'lean-first' ? roster.hint : undefined);
      assert.equal(created.role, 'imp');
      assert.equal(cliState(created.task_dir).state, 'working');
      assert.ok(f.commands().some(({ args }) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === created.agent));
      assert.equal(fs.existsSync(join(created.task_dir, 'report.md')), false, 'create waits for startup/prompt, not a report');
      // Simulate the worker finishing after create returns; the caller only awaits a native event.
      await publishPiGrace(t, created);
      await until(() => notices.includes(`${created.job} imp: idle_grace | report | ${readHint(created.job)}`), t.signal);
      const receipt = () => JSON.parse(fs.readFileSync(join(created.task_dir, 'job.json')));
      assert.equal(receipt().read_at, undefined, 'notification does not consume the report');
      assert.equal(cliState(created.task_dir).state, 'idle_grace');
      collected = await call('hud_read', { job: created.job });
      assert.equal(collected.digest.result, 'Synthetic settled pi report.');
      assert.ok(receipt().read_at);
      await until(() => cliState(created.task_dir)?.exit_reason === 'closed after report read', t.signal);
    }
    const normal = calls.splice(0);
    assert.deepEqual(normal.map(([name]) => name), ['hud_roster', 'hud_create', 'hud_read', 'hud_create', 'hud_read']);
    t.diagnostic(`monitored replies (B): cold ${JSON.stringify(normal.slice(0, 3))}; repeat ${JSON.stringify(normal.slice(3))}`);
    const refresh = await call('hud_roster', { cwd: f.root });
    assert.equal(refresh.convention_unchanged, true);
    assert.equal(refresh.convention, undefined);
    assert.ok([...(collected.changes ?? []), ...(refresh.changes ?? [])].some((line) => line.startsWith(`${repeated} imp: closed`)));
    const working = waitFixtureJob(f, 1, 'working', 'w4E:p9');
    writeFixtureFile(join(working.dir, 'job.json'), JSON.stringify({ ...working.receipt, model: 'openai/gpt-6.2-sol',
      thinking: 'high', model_source: 'pi_role:implementer', split: false, pi_args: [],
      dispatch_exit_code: 0, stderr_tail: '', role_skills: [], skipped_skills: [], worker_prompt: null }));
    const read = await call('hud_read', { job: working.job });
    assert.deepEqual(read, { job: working.job, role: 'imp', state: 'working', report_exists: false });
    t.diagnostic(`optional replies (B): roster refresh ${calls[0][1]}; working read ${calls[1][1]}`);
    const retry = await call('hud_create', { role: imp.role, cwd: f.root, request_key: 'lean-repeat', task: 'Do not run this.' });
    assert.equal(retry.job, repeated);
    assert.equal(f.commands().filter((c) => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'start').length, 2, 'retry never relaunches');
  } finally {
    pi.stdin.end();
    assert.deepEqual(await exited, [0, null], stderr);
    assert.equal(stderr, '');
  }
});

test('only a one-job read includes a bounded summary of committed and pending worktree changes', async (t) => {
  const f = await fixture(t), cwd = initRepo(f.root);
  fs.mkdirSync(join(cwd, 'node_modules'));
  const job = await f.call('hud_create', { role: 'imp', cwd, isolation: 'worktree', request_key: 'summary', task: 'Synthetic task.' });
  const { worktree: { root, branch, base_head } } = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json')));
  fs.writeFileSync(join(root, 'tracked.txt'), 'changed\n');
  git(root, 'commit', '-qam', 'tracked change');
  fs.appendFileSync(join(root, 'tracked.txt'), 'pending\n');
  fs.writeFileSync(join(root, 'new.txt'), 'untracked\n');
  const head = git(root, 'rev-parse', 'HEAD');
  const compact = await f.call('hud_read', { job: job.job });
  assert.deepEqual(compact.changed_files.sort(), ['new.txt', 'tracked.txt']);
  assert.equal(compact.git_summary, undefined);
  const read = await f.call('hud_read', { job: job.job, mode: 'full' });
  assert.equal(read.worktree.root, root);
  assert.deepEqual(read.git_summary, { branch, base_head, head, ahead_commits: 1, changed_files: 2, dirty: true, overlaps: [] });
  for (const result of [await f.call('hud_read'), await f.call('hud_read', { view: 'recent' }),
    await f.call('hud_wait', { jobs: [job.job], wait_ms: 0 })]) {
    assert.doesNotMatch(JSON.stringify(result), /git_summary/);
  }
});

test('one-job reads show managed sibling overlaps until the sibling file versions are integrated', { timeout: 15000 }, async (t) => {
  const f = await fixture(t), cwd = initRepo(f.root);
  const literal = 'a[1].txt';
  const write = (root, file, text) => fs.writeFileSync(join(root, file), text + '\n');
  write(cwd, literal, 'base');
  write(cwd, 'swap.txt', 'base');
  git(cwd, 'add', '--all');
  git(cwd, 'commit', '-qm', 'literal file');
  const create = (request_key) => f.call('hud_create', { role: 'imp', cwd, isolation: 'worktree', request_key, task: `Synthetic ${request_key}.` });
  const a = await create('overlap-a'), b = await create('overlap-b');
  assert.equal(a.git_summary, undefined);
  assert.equal(b.git_summary, undefined);
  const read = async ({ job }) => (await f.call('hud_read', { job, mode: 'full' })).git_summary;
  const checkout = ({ task_dir }) => JSON.parse(fs.readFileSync(join(task_dir, 'job.json'))).worktree;
  const { root: ar } = checkout(a), { root: br, branch, base_head } = checkout(b);
  const manual = join(f.root, 'manual');
  git(cwd, 'worktree', 'add', '-qb', 'manual', manual);
  write(manual, 'tracked.txt', 'unmanaged change');
  write(cwd, 'tracked.txt', 'main checkout pending change');
  write(ar, 'tracked.txt', 'change from A');
  write(ar, literal, 'literal change from A');
  write(ar, 'swap.txt', 'file change from A');
  git(ar, 'commit', '-qam', 'A');
  write(br, 'b.txt', 'disjoint change from B');
  assert.deepEqual((await read(a)).overlaps, []);
  assert.deepEqual((await read(b)).overlaps, []);

  write(br, 'tracked.txt', 'change from B');
  write(br, literal, 'literal change from B');
  fs.unlinkSync(join(br, 'swap.txt'));
  git(br, 'commit', '-qam', 'B');
  const shared = [literal, 'swap.txt', 'tracked.txt'];
  assert.deepEqual((await read(a)).overlaps, [{ job: b.job, files: shared }]);
  assert.deepEqual((await read(b)).overlaps, [{ job: a.job, files: shared }]);

  const receiptPath = join(b.task_dir, 'job.json');
  const receipt = { ...JSON.parse(fs.readFileSync(receiptPath)), worktree_kept_reason: 'unmerged commits' };
  writeFixtureFile(receiptPath, JSON.stringify(receipt));
  writeFixtureFile(join(b.task_dir, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
  assert.deepEqual((await read(a)).overlaps, [{ job: b.job, files: shared }]);
  git(cwd, 'restore', '--', 'tracked.txt');
  git(cwd, 'commit', '--allow-empty', '-qm', 'main checkout advances');
  const siblingHead = git(br, 'rev-parse', 'HEAD');
  git(cwd, 'cherry-pick', siblingHead);
  assert.notEqual(git(cwd, 'rev-parse', 'HEAD'), siblingHead);
  assert.deepEqual((await read(a)).overlaps, []);
  fs.mkdirSync(join(cwd, 'swap.txt'));
  write(cwd, 'swap.txt/nested.txt', 'not an overlapping path');
  git(cwd, 'add', '--all');
  git(cwd, 'commit', '-qm', 'directory replaces removed file');
  assert.deepEqual((await read(a)).overlaps, []);

  write(br, 'tracked.txt', 'pending B change after integration');
  assert.deepEqual((await read(a)).overlaps, [{ job: b.job, files: ['tracked.txt'] }]);
  writeFixtureFile(receiptPath, JSON.stringify({ ...receipt, worktree: { ...receipt.worktree, base_head: '0'.repeat(40) } }));
  const partial = await read(a);
  assert.deepEqual(partial.overlaps, []);
  assert.equal(partial.overlaps_incomplete, true);
  assert.equal(partial.changed_files, 3);
  writeFixtureFile(receiptPath, JSON.stringify(receipt));
  git(cwd, 'worktree', 'remove', '--force', br);
  const removed = await read(a);
  assert.deepEqual(removed.overlaps, []);
  assert.equal(removed.overlaps_incomplete, undefined);
  assert.deepEqual(await read(b), { branch, base_head, head: null, ahead_commits: null, changed_files: null, dirty: null, overlaps: null });
});

test('one-job reads cap the number of sibling worktrees and reported files', async (t) => {
  const f = await fixture(t, false), cwd = initRepo(f.root);
  const base_head = git(cwd, 'rev-parse', 'HEAD');
  const files = Array.from({ length: 21 }, (_, n) => `synthetic-${String(n).padStart(2, '0')}.txt`);
  const jobs = Array.from({ length: 10 }, (_, n) => {
    const job = waitFixtureJob(f, n + 1);
    const name = `synthetic-${job.job.slice(-6)}`, branch = `wt/${name}`, root = join(cwd + '-wt', name);
    git(cwd, 'worktree', 'add', '-qb', branch, root);
    for (const file of files) fs.writeFileSync(join(root, file), 'pending synthetic change\n');
    writeFixtureFile(join(job.dir, 'job.json'), JSON.stringify({ ...job.receipt, cwd: root, worktree: { main_root: cwd, root, branch, base_head } }));
    return job.job;
  });
  const compact = await f.call('hud_read', { job: jobs[0] });
  assert.deepEqual(compact.changed_files, [...files.slice(0, 20), '+1 more']);
  assert.deepEqual(compact.overlaps, jobs.slice(2).reverse());
  assert.equal(compact.overlaps_incomplete, true);
  const { git_summary } = await f.call('hud_read', { job: jobs[0], mode: 'full' });
  assert.equal(git_summary.overlaps_incomplete, true);
  assert.deepEqual(git_summary.overlaps, jobs.slice(2).reverse().map((job) => ({ job, files: files.slice(0, 20), more: 1 })));
});

test('hud_read lists and MCP changes include only current settled report summaries', async (t) => {
  const f = await fixture(t);
  const working = waitFixtureJob(f, 1), stale = waitFixtureJob(f, 2);
  const summary = 'Synthetic report summary: ' + '测'.repeat(115);
  for (const row of [working, stale]) {
    writeFixtureFile(join(row.dir, 'report.md'), 'Original synthetic report.');
    writeReportMeta(row.dir, cachedReportSignature(row.dir), { summary, files: ['src/synthetic.ts'] });
  }
  const before = await f.call('hud_read');
  assert.equal(before.jobs.length, 2);
  assert.ok(before.jobs.every((row) => !('summary' in row)));
  writeFixtureFile(join(stale.dir, 'report.md'), 'Revised synthetic report.');
  for (const row of [working, stale]) row.status('closed');
  const compact = await f.call('hud_read');
  const recent = await f.call('hud_read', { view: 'recent' });
  for (const list of [compact, recent]) {
    const valid = list.jobs.find((row) => row.job === working.job);
    assert.equal(valid.summary, [...summary].slice(0, 120).join(''));
    assert.doesNotMatch(JSON.stringify(list.jobs), /src\/synthetic\.ts|report_sig/);
    assert.equal(list.jobs.find((row) => row.job === stale.job).summary, undefined);
  }
  assert.ok(compact.changes.includes(`${working.job} imp: closed | report | ${[...summary].slice(0, 140).join('')} | ${readHint(working.job)}`));
  assert.ok(compact.changes.includes(`${stale.job} imp: closed | report | ${readHint(stale.job)}`));
  assert.equal(recent.changes, undefined, 'metadata does not trigger another change');
});

test('hud_read collects bounded report digests or full text, with independent batch results', async (t) => {
  const f = await fixture(t), current = waitFixtureJob(f, 1, 'closed'), stale = waitFixtureJob(f, 2, 'closed');
  const report = 'Synthetic first line.\n' + 'Synthetic evidence. 测试\n'.repeat(1900) + '**Verdict:** Accept\nBlockers: None\n';
  const path = join(current.dir, 'report.md');
  writeFixtureFile(path, report);
  const summary = 'Synthetic validation passed.';
  writeReportMeta(current.dir, cachedReportSignature(current.dir), { summary });
  const revised = join(stale.dir, 'report.md');
  writeFixtureFile(revised, 'Original synthetic text.');
  writeReportMeta(stale.dir, cachedReportSignature(stale.dir), { summary });
  writeFixtureFile(revised, '# Synthetic revision\n\nRevised synthetic text.\nDiscuss verdict and blockers without stating either.');
  await f.call('hud_read'); // Drain unrelated session events.
  const missing = 'j0000000000000099';
  const { jobs: [first, error, last] } = await f.call('hud_read', { jobs: [current.job, missing, stale.job] });
  assert.deepEqual(first.digest, { state: 'closed', result: summary, verdict: 'Accept', blockers: 'None', read_hint: readHint(current.job),
    report_bytes: Buffer.byteLength(report) });
  assert.doesNotMatch(JSON.stringify([first, last]), /report\.md/);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 1024);
  assert.equal(first.report, undefined);
  assert.deepEqual(error, { job: missing, ok: false, code: 'job_not_found' });
  assert.equal(last.digest.result, 'Revised synthetic text.');
  assert.equal(last.digest.verdict, undefined);
  assert.equal(last.digest.blockers, undefined);
  assert.ok(JSON.parse(fs.readFileSync(join(current.dir, 'job.json'))).read_at);
  assert.ok(JSON.parse(fs.readFileSync(join(stale.dir, 'job.json'))).read_at);
  const full = await f.call('hud_read', { jobs: [stale.job, current.job], mode: 'full' });
  assert.equal(full.jobs[0].report, fs.readFileSync(revised, 'utf8'));
  assert.equal(full.jobs[0].report_path, revised);
  assert.equal(full.jobs[0].report_bytes, undefined);
  assert.equal(full.jobs[0].next_offset, undefined);
  assert.equal(full.jobs[0].report_truncated, undefined);
  assert.ok(report.startsWith(full.jobs[1].report));
  assert.equal(full.jobs[1].report_path, path);
  assert.equal(full.jobs[1].report_bytes, Buffer.byteLength(report));
  assert.equal(full.jobs[1].next_offset, Buffer.byteLength(full.jobs[1].report));
});

test('hud_read full pages fit the JSON budget and reassemble the UTF-8 report', async (t) => {
  const f = await fixture(t), { job, dir } = waitFixtureJob(f, 1, 'closed');
  const path = join(dir, 'report.md'), limit = 24 * 1024;
  // Split the first raw byte limit inside an emoji, then force JSON escaping to shrink later pages.
  const lead = 'r'.repeat(limit - 1);
  const report = lead + '🙂' + '\r\n"\\\u0000测试🙂'.repeat(4000);
  const reportBytes = Buffer.byteLength(report);
  writeFixtureFile(path, report);
  let offset = 0, collected = '';
  for (;;) {
    const args = { job, mode: 'full', ...(offset ? { offset } : {}) };
    const { result } = await f.rpc('tools/call', { name: 'hud_read', arguments: args });
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    const page = JSON.parse(text);
    assert.ok(Buffer.byteLength(text) < 32 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(page.report)) - 2 <= limit);
    assert.equal(page.report_path, path);
    assert.equal(page.report_bytes, reportBytes);
    if (offset === 0) assert.equal(page.report, lead);
    collected += page.report;
    if (page.next_offset === undefined) {
      assert.equal(page.report_truncated, undefined);
      break;
    }
    assert.equal(page.report_truncated, true);
    assert.ok(page.next_offset > offset && page.next_offset < reportBytes);
    assert.equal(page.next_offset, Buffer.byteLength(collected));
    offset = page.next_offset;
  }
  assert.equal(collected, report);
  const eof = await f.call('hud_read', { job, full: true, offset: reportBytes });
  assert.equal(eof.report, '');
  assert.equal(eof.report_bytes, reportBytes);
  assert.equal(eof.next_offset, undefined);
});

test('hud_read compact keeps a busy project snapshot under 2 KiB without listing child jobs', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.call('hud_read'), { jobs: [] });
  paneList(f, 'w4E:p1', 'w4E:p2');
  const parent = waitFixtureJob(f, 1);
  const active = Array.from({ length: 3 }, (_, i) => waitFixtureJob(f, i + 2));
  const unread = Array.from({ length: 30 }, (_, i) => waitFixtureJob(f, i + 5, 'closed')).reverse();
  const other = waitFixtureJob(f, 35, 'closed', 'w4E:p2');
  const read = waitFixtureJob(f, 36, 'closed');
  const children = Array.from({ length: 101 }, (_, i) => waitFixtureJob(f, 37 + i, i < 100 ? 'closed' : 'working'));
  for (const { dir, receipt } of children)
    writeFixtureFile(join(dir, 'job.json'), JSON.stringify({ ...receipt, role: 'sonic', parent_job: parent.job }));
  for (const { dir } of [...unread, other, read, ...children.slice(0, 100)])
    writeFixtureFile(join(dir, 'report.md'), 'Synthetic report.');
  writeFixtureFile(join(read.dir, 'job.json'), JSON.stringify({ ...read.receipt, read_at: new Date(Date.now() + 1000).toISOString() }));
  await f.call('hud_roster'); // Advance the independent change stream.

  const response = await f.rpc('tools/call', { name: 'hud_read', arguments: {} });
  assert.equal(response.result.isError, undefined);
  const text = response.result.content[0].text;
  t.diagnostic(`hud_read compact: ${Buffer.byteLength(text)} bytes`);
  assert.ok(Buffer.byteLength(text) <= 2048);
  const compact = JSON.parse(text);
  const shown = unread.length - compact.older_unread_reports;
  assert.ok(shown > 0 && shown < unread.length);
  assert.deepEqual(compact.jobs.map(({ job }) => job), [...unread.slice(0, shown), ...active.reverse(), parent].map(({ job }) => job));
  assert.ok(compact.jobs.slice(0, shown).every(({ report_unread }) => report_unread === true));
  assert.deepEqual(compact.jobs.at(-1), { job: parent.job, role: 'imp', state: 'working', child_count: 101 });
  assert.deepEqual(await f.call('hud_read', { view: 'compact' }), compact);
  const recent = (await f.call('hud_read', { view: 'recent' })).jobs;
  assert.deepEqual(recent.map(({ job, parent_job }) => [job, parent_job]),
    children.slice(-20).reverse().map(({ job }) => [job, parent.job]));
  assert.ok(unread.every(({ dir }) => !JSON.parse(fs.readFileSync(join(dir, 'job.json'))).read_at));

  const newer = waitFixtureJob(f, 138, 'closed');
  assert.deepEqual(await f.call('hud_read', { view: 'compact' }), {
    ...compact, changes: [`${newer.job} imp: closed`],
  });
});

test('hud_read starts the watcher and settles a dead stop-requested job without a dispatch', async (t) => {
  const f = await fixture(t);
  const { dir, receipt } = waitFixtureJob(f, 1);
  const dead = 2 ** 31 - 1;
  writeFixtureFile(join(dir, 'job.json'), JSON.stringify({ ...receipt, cli: { agent: 'codex' } }));
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working', pid: dead, supervisor_pid: dead }));
  writeFixtureFile(join(dir, 'STATUS.json.stop-requested'), '');
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')), false);
  await f.call('hud_read', {});
  await until(() => cliState(dir).state === 'stopped', t.signal);
  assert.equal(cliState(dir).exit_reason, 'stop requested');
});

test('hud_read rejects invalid views and paging arguments', async (t) => {
  const f = await fixture(t), job = 'j0000000000000001';
  const offsetError = 'invalid_arguments: offset requires a nonnegative integer and one full job read';
  for (const [args, error] of [
    [{ view: 'history' }, 'invalid_arguments: view'],
    [{ view: null }, 'invalid_arguments: view'],
    [{ view: 'recent', job }, 'invalid_arguments: view is list-only'],
    [{ job, offset: 1 }, offsetError],
    [{ jobs: [job], mode: 'full', offset: 1 }, offsetError],
    [{ job, mode: 'full', offset: -1 }, offsetError],
    [{ job, mode: 'full', offset: 1.5 }, offsetError],
    [{ job, mode: 'full', offset: '1' }, offsetError],
  ]) {
    const response = await f.rpc('tools/call', { name: 'hud_read', arguments: args });
    assert.equal(response.result.isError, true);
    assert.deepEqual(JSON.parse(response.result.content[0].text), { ok: false, code: 'tool_error', error });
  }
});

test('hud_read lists only the caller project, including its linked worktrees', async (t) => {
  const f = await fixture(t);
  git(f.root, 'init', '-qb', 'trunk');
  git(f.root, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@invalid', 'commit', '--allow-empty', '-qm', 'base');
  const linked = join(f.root, 'linked');
  git(f.root, 'worktree', 'add', '-qb', 'linked', linked);
  const foreign = waitFixtureJob(f, 1, 'working', 'w4E:p1', initRepo(f.root));
  const legacy = waitFixtureJob(f, 2, 'working', 'w4E:p8', linked);
  const created = await f.call('hud_create', { role: 'imp', cwd: linked, task: 'Synthetic worktree job.' });
  await f.waitForWorkerMetadata(created, t.signal);
  assert.equal(JSON.parse(fs.readFileSync(join(created.task_dir, 'job.json'))).project_root, fs.realpathSync(f.root));
  assert.equal(created.changes, undefined, 'foreign project changes do not ride on this pane’s response');
  for (const args of [{}, { view: 'recent' }]) {
    assert.deepEqual((await f.call('hud_read', args)).jobs.map(({ job }) => job), [created.job, legacy.job]);
  }
  assert.equal((await f.call('hud_read', { job: foreign.job })).job, foreign.job);
});

test('MCP adopts same-project orphan jobs in one scan and pushes questions to the new pane', async (t) => {
  const f = await fixture(t);
  const adopted = [waitFixtureJob(f, 1, 'working', 'w4E:p8'), waitFixtureJob(f, 2, 'working', 'w4E:p7')];
  const live = waitFixtureJob(f, 3, 'working', 'wOTHER:p1');
  const foreign = waitFixtureJob(f, 4, 'working', 'w4E:p8', initRepo(f.root));
  const unread = waitFixtureJob(f, 5, 'closed', 'w4E:p8');
  const unseen = waitFixtureJob(f, 6, 'failed', 'w4E:p8');
  const read = waitFixtureJob(f, 7, 'closed', 'w4E:p8');
  const observed = waitFixtureJob(f, 8, 'failed', 'w4E:p8');
  const question = waitFixtureJob(f, 9, 'closed', 'w4E:p8');
  for (const { dir } of [unread, read]) writeFixtureFile(join(dir, 'report.md'), 'Synthetic report.');
  writeFixtureFile(join(question.dir, 'qa/q1.md'), 'Synthetic question.');
  const at = new Date(Date.now() + 1000).toISOString();
  writeFixtureFile(join(read.dir, 'job.json'), JSON.stringify({ ...read.receipt, read_at: at }));
  writeFixtureFile(join(observed.dir, 'job.json'), JSON.stringify({ ...observed.receipt, observed_at: at }));
  writeFixtureFile(join(adopted[0].dir, 'SESSION.txt'), 'ORCH=w4E:p8\n');
  writeFixtureFile(join(f.env.HOME, 'pane-list.json'), '{"result":{"panes":[{"pane_id":"w4E:p1"},{}]}}');
  await f.call('hud_read');
  assert.deepEqual(adopted.map(ownerOf), ['w4E:p8', 'w4E:p7'], 'incomplete pane list cannot transfer ownership');

  const lists = () => f.socketRequests.filter(req => req.method === 'pane.list').length;
  const before = lists();
  paneList(f, 'w4E:p1', 'wOTHER:p1');
  const handoff = await f.call('hud_read');
  assert.equal(lists() - before, 1);
  const owed = [...adopted, unread, unseen, question];
  assert.deepEqual(handoff.changes.map((line) => line.split(' ')[0]).sort(), owed.map(({ job }) => job).sort());
  assert.ok(owed.every((job) => ownerOf(job) === 'w4E:p1'));
  assert.deepEqual([read, observed].map(ownerOf), ['w4E:p8', 'w4E:p8']);
  assert.equal(ownerOf(live), 'wOTHER:p1');
  assert.equal(ownerOf(foreign), 'w4E:p8');

  await f.startCliSocket();
  const ask = workerClient(t, f, adopted[0].dir, '0');
  const answer = await ask('hud_ask', { question: 'Which synthetic layout?', default: 'Rows.' });
  assert.equal(answer.isError, undefined, JSON.stringify(answer));
  const pi = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-notify.mjs'), f.env.HUD_HOME, 'w4E:p8',
    adopted[0].job, '[imp@demo] QUESTION q99: Another question'], { env: f.env, stdio: 'inherit' });
  assert.deepEqual(await once(pi, 'close'), [0, null]);
  assert.deepEqual(f.commands().filter(({ args }) => args[0] === 'agent' && args[1] === 'prompt')
    .map(({ args }) => args[2]), ['w4E:p1', 'w4E:p1']);
});

test('a listed shell cannot adopt a working job before its permission appears', async t => {
  const f = await fixture(t), orphan = waitFixtureJob(f, 1, 'working', 'w4E:p8');
  writeFixtureFile(join(f.env.HOME, 'pane-list.json'), JSON.stringify({ result: { panes: [{ pane_id: 'w4E:p1', cwd: f.root }] } }));
  await f.call('hud_read');
  assert.equal(ownerOf(orphan), 'w4E:p8');
  writeFixtureFile(join(orphan.dir, 'SESSION.txt'), 'LEFT=w4E:p1\n');
  paneList(f, 'w4E:p1');
  await f.call('hud_read');
  assert.equal(ownerOf(orphan), 'w4E:p8', 'a listed worker agent is not a main either');
});

test('a fallback watch receives a batch member question even while the original pane is listed', { timeout: 10000 }, async t => {
  const f = await fixture(t), member = waitFixtureJob(f, 1, 'working', 'w4E:p8'), flow = 'b0000000000000001';
  paneList(f, 'w4E:p1', 'w4E:p8');
  writeFixtureFile(join(member.dir, 'job.json'), JSON.stringify({ ...member.receipt, batch_flow: flow }));
  fs.mkdirSync(join(f.env.HUD_HOME, 'flows'), { recursive: true });
  writeFixtureFile(join(f.env.HUD_HOME, 'flows', `${flow}.json`), JSON.stringify({ flow, pane: 'w4E:p8', project_root: f.root,
    origin_mcp: { pid: process.pid, start: 'stale' }, state: 'working', notices: {} }));
  const child = spawn(process.execPath, [resolve('bin/hud'), 'watch'], { cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill(); await exited; });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', text => { output += text; });
  await until(() => fs.existsSync(join(f.env.HUD_HOME, 'watchers/w4E:p1.pid')), t.signal);
  const ask = await workerClient(t, f, member.dir, '0')('hud_ask', { question: 'Which layout?', default: 'Rows.' });
  assert.match(ask.content[0].text, /delivered by hud watch/);
  await until(() => output.includes(`reply: hud_respond job=${member.job} request_id=q1`), 3000);
});

test('hud watch adopts on catch-up and delivers an already pending question', async (t) => {
  const f = await fixture(t);
  const orphan = waitFixtureJob(f, 1, 'working', 'w4E:p8');
  paneList(f, 'w4E:p1');
  writeFixtureFile(join(orphan.dir, 'qa/q1.md'), '# Question q1 from imp@demo\n\nWhich layout?\n\nDefault if unanswered: Rows.\n');
  const child = spawn(process.execPath, [resolve('bin/hud'), 'watch'], { cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill(); await exited; });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (text) => { output += text; });
  await until(() => output.includes(`reply: hud_respond job=${orphan.job} request_id=q1`), t.signal);
  assert.equal(ownerOf(orphan), 'w4E:p1');
});

test('single-job reads and the panel get progress without changes or narration in list/wait rows', async (t) => {
  const f = await fixture(t);
  const { dir, job, status } = waitFixtureJob(f, 1);
  await f.call('hud_roster');
  const streamed = [], ac = new AbortController();
  const watching = watchCommand(['--verbose'], { env: f.env, stdout: (s) => streamed.push(s.trim()), stderr: () => {} },
    { signal: ac.signal, rescanMs: 60 });
  try {
    const records = Array.from({ length: 12 }, (_, i) => progressRecord(`Step ${i}`));
    const log = join(dir, 'progress.jsonl');
    fs.writeFileSync(log, jsonLines(records.slice(0, -1)));
    assert.deepEqual(workerFor(f, job).latest_progress, records.at(-2));
    fs.appendFileSync(log, jsonLines(records.slice(-1)));
    const ordinary = await f.call('hud_read', { job });
    assert.deepEqual(ordinary.latest_progress, records.at(-1));
    assert.equal(ordinary.progress, undefined);
    const detail = await f.call('hud_read', { job, mode: 'full' });
    assert.deepEqual(detail.progress, records.slice(-10));
    assert.deepEqual(detail.latest_progress, records.at(-1));
    assert.equal(detail.changes, undefined);
    assert.deepEqual(workerFor(f, job).progress, detail.progress);
    const compact = [{ job, role: 'imp', state: 'working' }];
    assert.deepEqual(await f.call('hud_read'), { jobs: compact });
    assert.deepEqual((await f.call('hud_wait', { jobs: [job], wait_ms: 0 })).jobs, compact);
    status('done');
    await until(() => streamed.length > 0, t.signal);
    assert.deepEqual(streamed, [`${job} imp: done`]);
  } finally {
    ac.abort(); await watching;
  }
});

test('hud_peek returns a bounded pane tail and does not acknowledge, exhaust or close jobs', async (t) => {
  const f = await fixture(t);
  const { dir, job } = waitFixtureJob(f, 1, 'idle_grace');
  const fault = waitFixtureJob(f, 2, 'failed');
  const faultStatus = JSON.stringify({ state: 'failed', reason: 'HTTP 429 quota' });
  writeFixtureFile(join(fault.dir, 'STATUS.json'), faultStatus);
  writeFixtureFile(join(fault.dir, 'job.json'), JSON.stringify({ ...fault.receipt, place_key: 'synthetic-quota' }));
  writeFixtureFile(join(dir, 'report.md'), 'Synthetic report not read.');
  writeFixtureFile(join(dir, 'SESSION.txt'), 'PRIMARY=synthetic\nLEFT=w4E:p2\nRIGHT=w4E:p3\n');
  const milestone = progressRecord('Tested the change');
  writeFixtureFile(join(dir, 'progress.jsonl'), jsonLines([milestone]));
  const pane = Array.from({ length: 121 }, (_, i) => `pane line ${i}`);
  writeFixtureFile(join(f.env.HOME, 'pane-read'), pane.join('\r\n') + '\r\n');
  const paths = [join(dir, 'job.json'), join(dir, 'STATUS.json'), join(fault.dir, 'job.json'), join(fault.dir, 'STATUS.json')];
  const before = paths.map((path) => fs.readFileSync(path, 'utf8'));
  const peek = await f.call('hud_peek', { job });
  assert.deepEqual(peek.status, { job, role: 'imp', state: 'idle_grace', report_unread: true });
  assert.deepEqual(peek.progress, [milestone]);
  assert.equal(Object.hasOwn(peek, 'pane_lines'), false);
  assert.deepEqual(f.commands(), [], 'status and progress do not fetch the pane');
  const rich = await f.call('hud_peek', { job, detail: true });
  assert.equal(rich.diagnostics.display_state, 'done');
  assert.equal(rich.status.report_unread, true);
  assert.equal(Object.hasOwn(rich, 'report'), false);
  assert.deepEqual(f.commands(), [], 'diagnostics do not fetch the pane either');
  assert.deepEqual((await f.call('hud_peek', { job, lines: 40 })).pane_lines, pane.slice(-40));
  assert.deepEqual((await f.call('hud_peek', { job, lines: 120 })).pane_lines, pane.slice(-120));
  const noPane = await f.call('hud_peek', { job: fault.job, lines: 1 });
  assert.equal(noPane.pane_lines, null);
  assert.equal(noPane.pane_reason, 'no pane');
  assert.equal(noPane.status.reason, 'HTTP 429 quota');
  for (const lines of [0, 121, 2.5, '3']) {
    const response = await f.rpc('tools/call', { name: 'hud_peek', arguments: { job, lines } });
    assert.equal(response.result.isError, true);
    assert.equal(JSON.parse(response.result.content[0].text).error, 'invalid_arguments: lines');
  }
  assert.deepEqual(paths.map((path) => fs.readFileSync(path, 'utf8')), before);
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'exhausted.json')), false);
  assert.deepEqual(f.commands(), Array.from({ length: 2 }, () => ({
    command: 'herdr', args: ['pane', 'read', 'w4E:p2', '--source', 'recent'],
  })));
});

// The reply must be event-driven (`timed_out: false`); MCP startup and ping are
// outside the product wait, so the aggregate test watchdog is only a hang guard.
test('hud_wait any wakes on a settlement among the caller’s initially unsettled jobs', { timeout: 45000 }, async (t) => {
  const f = await fixture(t);
  const first = waitFixtureJob(f, 1), second = waitFixtureJob(f, 2);
  waitFixtureJob(f, 3, 'done');
  const foreign = waitFixtureJob(f, 4, 'working', 'w4E:p9');
  await f.call('hud_roster'); // Advance the cursor before writing the settlement.
  const waiting = f.call('hud_wait', { wait_ms: 15000 });
  await f.rpc('ping'); // The wait is active and does not hold up another call.
  foreign.status('done');
  writeFixtureFile(join(second.dir, 'report.md'), 'Synthetic report.');
  second.status('idle_grace');
  const result = await waiting;
  result.jobs.sort((a, b) => a.job.localeCompare(b.job));
  assert.deepEqual(result, {
    ready: true, timed_out: false, triggered: [second.job],
    jobs: [
      { job: first.job, role: 'imp', state: 'working' },
      { job: second.job, role: 'imp', state: 'idle_grace', report_unread: true },
    ],
    changes: [`${second.job} imp: idle_grace | report | ${readHint(second.job)}`],
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(join(second.dir, 'job.json'), 'utf8')), second.receipt);
});

test('hud_wait all wakes after the last explicit target settles', { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  const first = waitFixtureJob(f, 1), second = waitFixtureJob(f, 2);
  const args = { jobs: [first.job, second.job], mode: 'all' };
  const waiting = f.call('hud_wait', { ...args, wait_ms: 15000 });
  await f.rpc('ping');
  first.status('stopped');
  assert.equal((await f.call('hud_wait', { ...args, wait_ms: 0 })).ready, false);
  second.status('done');
  const result = await waiting;
  assert.equal(result.ready, true);
  assert.equal(result.timed_out, false);
  assert.deepEqual(result.triggered, args.jobs);
  assert.deepEqual(result.jobs.map((job) => job.state), ['stopped', 'done']);
});

test('hud_wait all wakes early for a question and previews only its ID', { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  const first = waitFixtureJob(f, 1), second = waitFixtureJob(f, 2);
  const waiting = f.call('hud_wait', { jobs: [first.job, second.job], mode: 'all', wait_ms: 15000 });
  await f.rpc('ping');
  writeFixtureFile(join(first.dir, 'qa', 'q1.md'), 'Synthetic question.');
  const result = await waiting;
  assert.equal(result.ready, true);
  assert.equal(result.timed_out, false);
  assert.deepEqual(result.triggered, [first.job]);
  assert.deepEqual(result.jobs, [
    { job: first.job, role: 'imp', state: 'working', question_ids: ['q1'] },
    { job: second.job, role: 'imp', state: 'working' },
  ]);
});

test('hud_wait returns a compact snapshot on timeout and rejects invalid targets', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.call('hud_wait'), { ready: true, timed_out: false, triggered: [], jobs: [] });
  const { job } = waitFixtureJob(f, 1);
  await f.call('hud_roster');
  const start = performance.now();
  assert.deepEqual(await f.call('hud_wait', { jobs: [job], wait_ms: 100 }), {
    ready: false, timed_out: true, triggered: [], jobs: [{ job, role: 'imp', state: 'working' }],
  });
  assert.ok(performance.now() - start >= 100);
  for (const args of [{ jobs: ['../outside'] }, { jobs: ['j0000000000000002'] }, { mode: 'some' }, { wait_ms: 120001 }]) {
    const response = await f.rpc('tools/call', { name: 'hud_wait', arguments: args });
    assert.equal(response.result.isError, true);
    assert.match(JSON.parse(response.result.content[0].text).error, /^invalid_arguments:/);
  }
});

test('hud_read returns unread reports in idle grace, omits read bodies, supports full and observes a second report', async (t) => {
  const f = await fixture(t), id = 'j0000000000000099';
  const dir = join(f.env.HUD_HOME, 'jobs', id);
  fs.mkdirSync(join(dir, 'qa'), { recursive: true });
  writeFixtureFile(join(dir, 'job.json'), JSON.stringify({ job: id, role: 'imp', cwd: f.root, created_at: '2026-01-01', herdr_pane: 'w4E:p1', cli: { idle_grace_s: 120 } }));
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
  const report = join(dir, 'report.md'), mtime = new Date('2026-01-01T00:00:00Z');
  writeFixtureFile(report, 'First report.');
  fs.utimesSync(report, mtime, mtime);
  writeFixtureFile(join(dir, 'qa/q1.md'), 'Question?');
  const recent = (await f.call('hud_read', { view: 'recent' })).jobs[0];
  assert.equal(recent.open_questions, 1);
  assert.equal(recent.report_unread, true);
  assert.equal(recent.report, undefined);
  const first = await f.call('hud_read', { job: id, detail: true });
  assert.equal(first.digest.result, 'First report.');
  assert.equal(first.idle_grace_s, 120);
  const stamp = JSON.parse(fs.readFileSync(join(dir, 'job.json'))).read_at;
  assert.ok(stamp);
  const unchanged = await f.call('hud_read', { job: id });
  assert.equal(unchanged.report, undefined);
  assert.equal(unchanged.report_unchanged, true);
  assert.equal(unchanged.observed_at, undefined);
  assert.equal((await f.call('hud_read', { view: 'recent' })).jobs[0].report_unread, false);
  assert.deepEqual((await f.call('hud_read')).jobs, []);
  assert.equal((await f.call('hud_read', { job: id, full: true })).report, 'First report.');
  await until(() => Date.now() > Date.parse(stamp), t.signal);
  // Model an atomic replacement on the same filesystem clock tick as the original.
  writeFixtureFile(report, 'Second report.');
  fs.utimesSync(report, mtime, mtime);
  assert.equal((await f.call('hud_read', { job: id })).digest.result, 'Second report.');
  assert.ok(JSON.parse(fs.readFileSync(join(dir, 'job.json'))).read_at > stamp);
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'closed' }));
  assert.equal((await f.call('hud_read', { job: id })).report_unchanged, true);
});

test('failed job without a report catches up once, then hud_read marks attention seen without marking a report read', async (t) => {
  const f = await fixture(t), id = 'j0000000000000098', dir = join(f.env.HUD_HOME, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  writeFixtureFile(join(dir, 'job.json'), JSON.stringify({ job: id, role: 'imp', cwd: f.root, herdr_pane: 'w4E:p1', created_at: '2026-01-01' }));
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'failed', reason: 'worker gone' }));
  const catchup = async () => {
    const lines = [], ac = new AbortController(), scanned = Promise.withResolvers();
    const timer = globalThis.setTimeout;
    const mocked = t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
      if (ms === 60) scanned.resolve(); // The first catch-up scan has finished and armed its safety rescan.
      return timer(fn, ms, ...args);
    });
    const watching = watchCommand([], { env: f.env, stdout: (s) => lines.push(s.trim()), stderr: () => {} }, { signal: ac.signal, rescanMs: 60 });
    try { await scanned.promise; } finally { ac.abort(); mocked.mock.restore(); await watching; }
    const [, ignored] = fs.readFileSync('/proc/self/status', 'utf8').match(/^SigIgn:\s+([\da-f]+)$/m);
    const sigpipe = 1n << BigInt(constants.signals.SIGPIPE - 1);
    assert.equal(BigInt(`0x${ignored}`) & sigpipe, sigpipe, 'watchCommand must leave SIGPIPE ignored');
    return lines;
  };
  assert.deepEqual(await catchup(), [`${id} imp: failed | worker gone`]);
  assert.deepEqual((await f.call('hud_read')).jobs, []);
  assert.equal(JSON.parse(fs.readFileSync(join(dir, 'job.json'))).observed_at, undefined);
  const read = await f.call('hud_read', { job: id });
  assert.equal(read.report_exists, false);
  assert.equal(read.observed_at, undefined);
  const receipt = JSON.parse(fs.readFileSync(join(dir, 'job.json')));
  assert.ok(receipt.observed_at);
  assert.equal(receipt.read_at, undefined);
  assert.deepEqual(await catchup(), []);
  assert.deepEqual((await f.call('hud_read')).jobs, []);
  assert.equal((await f.call('hud_read', { view: 'recent' })).jobs[0].state, 'failed');
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'failed', reason: 'new failure' }));
  assert.deepEqual(await catchup(), [`${id} imp: failed | new failure`]);
  assert.deepEqual((await f.call('hud_read')).jobs, []);
});

test('thin read lists and waits without opening discarded bodies, preserving observations', async (t) => {
  const f = await fixture(
    t,
    true,
    watchStatsProbe + `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.openSync;
fs.openSync = function(path, ...args) {
  if (/\\/(report\\.md|qa\\/q\\d+\\.md)$/.test(String(path)))
    fs.appendFileSync(process.env.HOME + '/reads', String(path) + '\\n');
  return open.call(this, path, ...args);
};
syncBuiltinESMExports();`
  );
  const job = 'j0000000000000001',
    dir = join(f.env.HUD_HOME, 'jobs', job);
  fs.mkdirSync(join(dir, 'qa'), { recursive: true });
  const receipt = { job, role: 'imp', cwd: f.root, created_at: '2026-01-01', dispatch_exit_code: 0, stderr_tail: '' };
  paneList(f, f.env.HERDR_PANE_ID); // The unbound receipt needs a verified project main to answer.
  // Atomic like the real writers: the polled hud_read must never see a half-written file.
  const put = (name, value) => writeFixtureFile(join(dir, name), JSON.stringify(value));
  const save = () => put('job.json', receipt);
  const status = (state) => put('STATUS.json', { state, exit_reason: null });
  const reads = () =>
    fs.existsSync(join(f.env.HOME, 'reads'))
      ? fs.readFileSync(join(f.env.HOME, 'reads'), 'utf8').trim().split('\n')
      : [];
  const read = (wait_ms = 0) => f.call('hud_read', { job, wait_ms, detail: true });
  save();
  status('working');
  writeFixtureFile(join(dir, 'report.md'), 'r'.repeat(65537));
  writeFixtureFile(join(dir, 'qa', 'q1.md'), 'Synthetic question.');
  assert.deepEqual((await f.call('hud_read')).jobs, [{
    job, role: 'imp', state: 'working', report_unread: true, question_ids: ['q1'],
  }]);
  assert.equal((await f.call('hud_read', { view: 'recent' })).jobs[0].open_questions, 1);
  assert.deepEqual(reads(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(dir, 'job.json'))), receipt);
  const question = await read();
  assert.deepEqual(question.questions, [{ id: 'q1', text: 'Synthetic question.' }]);
  await f.call('hud_respond', { job, request_id: 'q1', answer: 'Synthetic answer.' });
  const startRead = async (wait_ms) => {
    const before = readWatchStats(f).opened;
    const result = read(wait_ms);
    await until(() => readWatchStats(f).opened > before, t.signal);
    return { result };
  };
  const before = reads().length;
  const { result: waiting } = await startRead(1100);
  assert.equal(reads().length, before);
  const timeout = await waiting;
  const omitted = { ...question, questions: [], report_unread: false, report_unchanged: true };
  delete omitted.digest;
  assert.deepEqual(timeout, omitted);
  assert.equal(reads().length, before, 'already-read report is not reopened');
  assert.equal(question.digest.report_bytes, 65537);
  assert.ok(Buffer.byteLength(JSON.stringify(question.digest)) < 1024);
  const full = await f.call('hud_read', { job, mode: 'full' });
  assert.equal(full.report.length, 24 * 1024);
  assert.equal(full.report_truncated, true);
  assert.equal(full.report_bytes, 65537);
  assert.equal(full.next_offset, full.report.length);
  assert.ok(JSON.parse(fs.readFileSync(join(dir, 'job.json'))).read_at);
  const { result: newQuestion } = await startRead(3000);
  writeFixtureFile(join(dir, 'qa', 'q2.md'), 'New question.');
  assert.deepEqual(await newQuestion, { ...timeout, questions: [{ id: 'q2', text: 'New question.' }] });
  await f.call('hud_respond', { job, request_id: 'q2', answer: 'Answered.' });
  for (const [state, display_state] of [
    ['idle_grace', 'done'],
    ['closed', 'done'],
    ['failed', 'failed'],
    ['stopped', 'stopped'],
    [null, 'working'],
  ]) {
    save();
    status('working');
    const { result: pending } = await startRead(700);
    if (state === null) fs.unlinkSync(join(dir, 'STATUS.json'));
    else status(state);
    assert.deepEqual(await pending, { ...question, questions: [], state, display_state,
      digest: { ...question.digest, state: state ?? display_state } });
    assert.ok(JSON.parse(fs.readFileSync(join(dir, 'job.json'))).read_at);
  }
  receipt.dispatch_exit_code = 1;
  save();
  assert.deepEqual(await read(), { ...question, questions: [], state: 'failed', display_state: 'failed', dispatch_exit_code: 1,
    digest: { ...question.digest, state: 'failed' } });
});

test('hud_create and hud_send derive keys for concurrent identical calls', async (t) => {
  const f = await fixture(t);
  const create = { role: 'imp', task: 'Synthetic task without a key.' };
  const [job, duplicate] = await Promise.all([f.call('hud_create', create), f.call('hud_create', create)]);
  assert.equal(duplicate.job, job.job);
  assert.deepEqual(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')), [job.job]);
  writeFixtureFile(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
  const send = { job: job.job, text: 'Synthetic message without a key.' };
  const [first, second] = await Promise.all([f.call('hud_send', send), f.call('hud_send', send)]);
  assert.equal(first.sent, true);
  assert.equal(second.sent, false);
  assert.equal(second.ok, true);
  const file = join(job.task_dir, 'job.json');
  const receipt = JSON.parse(fs.readFileSync(file));
  assert.equal(receipt.message_keys, undefined);
  assert.equal(receipt.send_outcomes.length, 1);
  writeFixtureFile(file, JSON.stringify({ ...receipt, message_keys: ['legacy-key'] }));
  assert.deepEqual(await f.call('hud_send', { ...send, message_key: 'legacy-key' }), { ok: false, sent: false, code: 'send_failed' });
  assert.equal(f.commands().filter(({ args }) => args[1] === 'prompt' && args[3] === send.text).length, 1);
});

test('hud_create starts a new job after the derived key window expires', async (t) => {
  const f = await fixture(t);
  const create = { role: 'imp', task: 'Synthetic task to run again later.' };
  const first = await f.call('hud_create', create);
  const file = join(first.task_dir, 'job.json');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  receipt.created_at = new Date(Date.now() - 11 * 60_000).toISOString();
  writeFixtureFile(file, JSON.stringify(receipt));
  const second = await f.call('hud_create', create);
  assert.notEqual(second.job, first.job);
  assert.deepEqual(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')).sort(), [first.job, second.job].sort());
  assert.equal((await f.call('hud_create', create)).job, second.job);
});

test('hud_send sends again after the derived key window expires', async (t) => {
  const f = await fixture(t);
  const job = await f.call('hud_create', { role: 'imp', task: 'Synthetic working task.' });
  writeFixtureFile(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
  const send = { job: job.job, text: 'Synthetic message to send again later.' };
  assert.equal((await f.call('hud_send', send)).sent, true);
  const file = join(job.task_dir, 'job.json');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  receipt.send_outcomes[0].recorded_at = new Date(Date.now() - 11 * 60_000).toISOString();
  writeFixtureFile(file, JSON.stringify(receipt));
  assert.equal((await f.call('hud_send', send)).sent, true);
  assert.deepEqual(await f.call('hud_send', send), { ok: true, sent: false });
  assert.equal(f.commands().filter(({ args }) => args[1] === 'prompt' && args[3] === send.text).length, 2);
});

test('hud_send to several jobs sends once per working job and skips read-closed jobs', async (t) => {
  const f = await fixture(t);
  await f.startCliSocket();
  const create = (task) => f.call('hud_create', { role: 'imp', task });
  const working = await create('Synthetic working task.');
  const closed = await create('Synthetic settled task.');
  writeFixtureFile(join(working.task_dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
  await publishPiGrace(t, closed);
  await f.call('hud_read', { job: closed.job });
  await until(() => cliState(closed.task_dir)?.exit_reason === 'closed after report read', t.signal);
  const text = 'Synthetic shared message.';
  const result = await f.call('hud_send', { jobs: [closed.job, working.job, working.job], text });
  assert.deepEqual(result.sent, [working.job]);
  assert.deepEqual(result.skipped, [{ job: closed.job, reason: 'not_continuable' }]);
  assert.equal(f.commands().filter(({ args }) => args[1] === 'prompt' && args[3] === text).length, 1);
  assert.equal(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')).length, 2);
});

test('thin send queues a message for a working pi job and refuses a finished one', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const job = await f.call('hud_create', { role: 'reviewer', request_key: 'send-queue', task: 'Synthetic task.' });
  writeFixtureFile(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
  const sent = await f.call('hud_send', { job: job.job, message_key: 'queued', text: 'Synthetic addendum.' });
  assert.equal(sent.sent, true);
  assert.equal(sent.queued, true);
  const prompted = f.commands().filter((c) => c.args[0] === 'agent' && c.args[1] === 'prompt').at(-1);
  assert.deepEqual(prompted.args, ['agent', 'prompt', job.agent, 'Synthetic addendum.']);
  writeFixtureFile(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'closed' }));
  const late = await f.call('hud_send', { job: job.job, message_key: 'late', text: 'Synthetic late.' });
  assert.equal(late.code, 'not_continuable');
});

test(
  'thin send records failed and successful outcomes without retrying a message key',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const job = await f.call('hud_create', { role: 'imp', request_key: 'send-outcomes', task: 'Synthetic task.' });
    const dispatches = () => f.commands().filter((c) => c.command === 'herdr' && c.args[0] !== 'pane');
    const before = dispatches().length;
    await f.call('hud_read', { job: job.job });
    const receiptFile = join(job.task_dir, 'job.json');
    const stamp = JSON.parse(fs.readFileSync(receiptFile)).read_at;
    assert.ok(stamp);
    // An earlier read stamp survives sends; a newer, unread settled report still permits continuation.
    await until(() => Date.now() > Date.parse(stamp), t.signal);
    writeFixtureFile(join(job.task_dir, 'report.md'), 'Unread settled report.');
    writeFixtureFile(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
    const fake = `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ command: 'herdr', args: process.argv.slice(2) }) + '\\n');
`;
    f.overrideBin('herdr', fake + "console.error('Synthetic prompt failure'); process.exit(9);\n");
    const args = { job: job.job, message_key: 'failed-send', text: 'Synthetic continuation.' };
    const failed = await f.call('hud_send', args);
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'send_failed');
    assert.equal(failed.exit_code, 9);
    assert.match(failed.stderr_tail, /Synthetic prompt failure/);
    assert.equal(JSON.parse(fs.readFileSync(receiptFile)).read_at, stamp);
    // The transport is now healthy, but retrying the failed key must not claim delivery or resend.
    f.overrideBin('herdr', fake);
    const retry = await f.call('hud_send', args);
    assert.equal(retry.ok, false);
    assert.equal(retry.sent, false);
    assert.equal(retry.code, 'send_failed');
    assert.equal(retry.exit_code, failed.exit_code);
    assert.equal(retry.stderr_tail, failed.stderr_tail);
    assert.equal(dispatches().length, before + 1);
    const success = await f.call('hud_send', { ...args, message_key: 'successful-send' });
    assert.equal(success.ok, true);
    assert.equal(success.sent, true);
    assert.equal(JSON.parse(fs.readFileSync(receiptFile)).read_at, stamp);
    writeFixtureFile(join(job.task_dir, 'report.md'), 'Second report after repairs.');
    const settled = Date.now();
    writeFixtureFile(
      join(job.task_dir, 'STATUS.json'),
      JSON.stringify({ state: 'idle_grace', settled_at: new Date(settled).toISOString() })
    );
    // Settled is done, read or not: the panel has no "report unread" stage (owner, 2026-11-11).
    const unread = workerFor(f, job.job);
    assert.equal(projectWorkCard(unread, settled).state, 'done');
    assert.doesNotMatch(cardText(unread), /report ready/);
    assert.equal((await f.call('hud_read', { job: job.job })).digest.result, 'Second report after repairs.');
    const secondStamp = JSON.parse(fs.readFileSync(receiptFile)).read_at;
    assert.ok(secondStamp);
    assert.deepEqual(await f.call('hud_send', { ...args, message_key: 'successful-send' }), { ok: true, sent: false });
    assert.equal(JSON.parse(fs.readFileSync(receiptFile)).read_at, secondStamp);
    assert.equal(dispatches().length, before + 2);
    const receipt = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8'));
    assert.deepEqual(
      receipt.send_outcomes.map(({ key, exit_code }) => ({ key, exit_code })),
      [
        { key: 'failed-send', exit_code: 9 },
        { key: 'successful-send', exit_code: 0 },
      ]
    );
  }
);

test('STATUS table matches across the panel reader and hud_read', async (t) => {
  const f = await fixture(t);
  const cases = [
    { name: 'working', status: { state: 'working', exit_reason: null }, display: 'working', raw: 'working', reason: null, blocked: false },
    {
      name: 'waiting-quiet',
      status: { state: 'waiting_orchestrator', blocked: false, reason: 'quiet', harness: 'cli' },
      display: 'working',
      raw: 'waiting_orchestrator',
      reason: 'quiet',
      blocked: false,
    },
    {
      name: 'waiting-blocked',
      status: { state: 'waiting_orchestrator', blocked: true, reason: null, harness: 'cli', agent: 'grok' },
      display: 'working',
      raw: 'waiting_orchestrator',
      reason: 'grok needs input in its pane',
      blocked: true,
    },
    { name: 'idle-grace', status: { state: 'idle_grace', exit_reason: 'settled' }, display: 'done', raw: 'idle_grace', reason: 'settled', blocked: false },
    { name: 'closed', status: { state: 'closed', exit_reason: 'settled' }, display: 'done', raw: 'closed', reason: 'settled', blocked: false },
    { name: 'done', status: { state: 'done', exit_reason: 'settled' }, display: 'done', raw: 'done', reason: 'settled', blocked: false },
    { name: 'stopped-empty', status: { state: 'stopped', output_written: false, exit_reason: 'stop requested' }, display: 'stopped', raw: 'stopped', reason: 'stop requested', blocked: false },
    { name: 'stopped-output', status: { state: 'stopped', output_written: true, exit_reason: 'stop requested' }, display: 'done', raw: 'stopped', reason: 'stop requested', blocked: false },
    { name: 'failed', status: { state: 'failed', exit_reason: 'tab closed' }, display: 'failed', raw: 'failed', reason: 'tab closed', blocked: false },
    { name: 'empty-status', status: {}, display: 'working', raw: null, reason: null, blocked: false },
    { name: 'missing-ok', status: null, dispatch_exit_code: 0, display: 'working', raw: null, reason: null, blocked: false },
    { name: 'missing-fail', status: null, dispatch_exit_code: 1, display: 'failed', raw: 'failed', reason: null, blocked: false },
  ];
  const ids = cases.map((entry, idx) => {
    const id = `j${(idx + 1).toString(16).padStart(16, '0')}`;
    const dir = join(f.env.HUD_HOME, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    writeFixtureFile(
      join(dir, 'job.json'),
      JSON.stringify({
        job: id,
        role: 'imp',
        herdr_pane: 'w4E:p1',
        cwd: f.root,
        created_at: new Date(1000 + idx * 1000).toISOString(),
        dispatch_exit_code: entry.dispatch_exit_code ?? 0,
        stderr_tail: '',
      })
    );
    if (entry.status !== null) writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify(entry.status));
    return { id, entry };
  });
  const listed = (await f.call('hud_read', { view: 'recent' })).jobs;
  const compact = (await f.call('hud_read')).jobs;
  for (const { id, entry } of ids) {
    if (entry.raw === 'waiting_orchestrator') {
      assert.deepEqual(compact.find((row) => row.job === id), {
        job: id, role: 'imp', state: entry.raw, reason: entry.reason,
        ...(entry.blocked ? { blocked: true } : {}),
      });
    }
    const panel = workerFor(f, id);
    const single = await f.call('hud_read', { job: id, detail: true });
    const row = listed.find((item) => item.job === id);
    assert.equal(panel.state, entry.display, `${entry.name} panel.state`);
    assert.equal(single.display_state, entry.display, `${entry.name} hud_read.display_state`);
    assert.equal(single.state, entry.raw, `${entry.name} hud_read.state`);
    assert.equal(single.reason, entry.reason, `${entry.name} hud_read.reason`);
    assert.equal(single.blocked, entry.blocked, `${entry.name} hud_read.blocked`);
    assert.equal(row.display_state, entry.display, `${entry.name} list.display_state`);
    assert.equal(row.state, entry.raw, `${entry.name} list.state`);
    assert.equal(row.reason, entry.reason, `${entry.name} list.reason`);
    assert.equal(row.blocked, entry.blocked, `${entry.name} list.blocked`);
  }
});

test('hud_read wait_ms wakes on waiting_orchestrator and session changes ride once per response', async (t) => {
  const f = await fixture(t, true, watchStatsProbe);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const created = await f.call('hud_create', {
    role: 'general',
    on: 'grok',
    request_key: 'wait-seed',
    task: 'Seed session cursor without self-reporting create.',
  });
  assert.equal('changes' in created, false);
  await until(() => cliState(created.task_dir)?.state === 'working', t.signal);
  await f.call('hud_close', { job: created.job });
  await until(() => cliState(created.task_dir)?.state === 'stopped', t.signal);

  const writeSyntheticJob = (id, pane, pkg, state) => {
    const dir = join(f.env.HUD_HOME, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    writeFixtureFile(
      join(dir, 'job.json'),
      JSON.stringify({
        job: id,
        role: 'imp',
        package: pkg,
        cwd: f.root,
        herdr_pane: pane,
        created_at: new Date().toISOString(),
        cli: { agent: 'grok' },
        dispatch_exit_code: 0,
        stderr_tail: '',
      })
    );
    writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state, exit_reason: null }));
    return dir;
  };

  const w1Dir = writeSyntheticJob('j00000000000001a1', 'w4E:p1', '02-wait', 'working');
  await f.call('hud_roster');
  const settledSeed = await f.call('hud_roster');
  assert.equal('changes' in settledSeed, false);

  const opened = readWatchStats(f).opened;
  const waitPromise = f.call('hud_read', { job: 'j00000000000001a1', wait_ms: 5000 });
  await until(() => readWatchStats(f).opened > opened, t.signal);
  writeFixtureFile(
    join(w1Dir, 'STATUS.json'),
    JSON.stringify({ state: 'waiting_orchestrator', blocked: false, reason: 'quiet', harness: 'cli' })
  );
  const waited = await waitPromise;
  assert.equal(waited.state, 'waiting_orchestrator');
  assert.equal(waited.blocked, undefined);
  assert.equal(waited.changes?.length, 1);
  assert.match(waited.changes[0], /^j00000000000001a1 imp 02-wait: waiting_orchestrator \| quiet$/);

  const afterWait = await f.call('hud_roster');
  assert.equal('changes' in afterWait, false);

  const w2Dir = writeSyntheticJob('j00000000000001a2', 'w4E:p1', '02-roster', 'working');
  const foreignDir = writeSyntheticJob('j00000000000001f9', 'w4E:p9', 'foreign-pane', 'working');
  const baseline = await f.call('hud_roster');
  assert.equal(baseline.changes?.length, 1);
  assert.match(baseline.changes[0], /^j00000000000001a2 imp 02-roster: working$/);

  writeFixtureFile(join(w2Dir, 'STATUS.json'), JSON.stringify({ state: 'waiting_orchestrator', exit_reason: null }));
  writeFixtureFile(
    join(foreignDir, 'STATUS.json'),
    JSON.stringify({ state: 'waiting_orchestrator', exit_reason: null })
  );

  const roster1 = await f.call('hud_roster');
  assert.equal(roster1.changes?.length, 1);
  assert.match(roster1.changes[0], /^j00000000000001a2 imp 02-roster: waiting_orchestrator\b/);

  const roster2 = await f.call('hud_roster');
  assert.equal('changes' in roster2, false);
});

test('an answer the owner gives from the panel rides on the next response as one change line', async (t) => {
  const f = await fixture(t);
  const dir = join(f.env.HUD_HOME, 'jobs', 'j00000000000001b1');
  fs.mkdirSync(join(dir, 'qa'), { recursive: true });
  writeFixtureFile(join(dir, 'job.json'), JSON.stringify({ job: 'j00000000000001b1', role: 'imp', package: '03-ask', cwd: f.root, herdr_pane: 'w4E:p1', created_at: new Date().toISOString(),
    cli: { agent: 'grok' }, dispatch_exit_code: 0, stderr_tail: '' }));
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
  writeFixtureFile(join(dir, 'qa/q1.md'), '# Question q1 from imp@demo\n\nKeep it?\n\nOptions:\n- keep it\n- drop it\n\nDefault if unanswered: keep it\n');
  await f.call('hud_roster');
  assert.equal('changes' in (await f.call('hud_roster')), false);
  assert.deepEqual(answerJobQuestion(f.env.HUD_HOME, 'j00000000000001b1', 'q1', 'drop it', 'imp'), { ok: true, written: true });
  const next = await f.call('hud_roster');
  assert.ok(next.changes.includes('[imp@j00000000000001b1] ANSWERED q1 from panel: drop it'), JSON.stringify(next.changes));
  assert.equal('changes' in (await f.call('hud_roster')), false, 'once');
});

test('hud_read wait_ms and hud_wait wake within 100 ms, resist sessions ELOOP, settle on timeout, and leak zero watchers', { timeout: 15000 }, async (t) => {
  // Measure the scheduled wake timer in-process (not OS cross-process scheduling under parallel load)
  // while still proving each wakeup came from a real fs.watch event with < 100 ms delay and zero fallback ticks.
  const wakeProbe = `{
    const fs = (await import('node:fs')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const watch = fs.watch, timer = globalThis.setTimeout, statsFile = process.env.HOME + '/watch-stats.json';
    let opened = 0, closed = 0, inWatchEvent = 0, longTimersFired = 0;
    const eventWakes = [];
    const record = () => {
      const tmp = statsFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ opened, closed, active: opened - closed, eventWakes, longTimersFired }));
      fs.renameSync(tmp, statsFile);
    };
    globalThis.setTimeout = function(fn, ms, ...tArgs) {
      const fromWatch = inWatchEvent > 0;
      const delay = Number(ms) || 0;
      if ((fromWatch || delay >= 100) && typeof fn === 'function') {
        const orig = fn;
        fn = function(...cbArgs) {
          if (opened - closed > 0) {
            if (fromWatch) eventWakes.push(delay);
            if (delay >= 100) longTimersFired++;
            record();
          }
          return orig.apply(this, cbArgs);
        };
      }
      return timer.call(this, fn, ms, ...tArgs);
    };
    fs.watch = function(...args) {
      const wrapped = args.map((arg) => typeof arg === 'function' ? function(...cbArgs) {
        inWatchEvent++;
        try { return arg.apply(this, cbArgs); }
        finally { inWatchEvent--; }
      } : arg);
      const w = watch.apply(this, wrapped);
      opened++;
      record();
      const close = w.close.bind(w);
      let done = false;
      w.close = function() {
        if (!done) { done = true; closed++; record(); }
        return close();
      };
      return w;
    };
    syncBuiltinESMExports();
  }`;
  const f = await fixture(t, true, wakeProbe);
  const watchStats = () => ({ eventWakes: [], longTimersFired: 0, ...readWatchStats(f) });
  const assertEventWakeUnder100ms = (before, label) => {
    const after = watchStats();
    const wakes = after.eventWakes.slice(before.eventWakes.length);
    assert.ok(wakes.length > 0, `${label}: expected real fs.watch event wakeup`);
    for (const ms of wakes) {
      assert.ok(ms >= 0 && ms < 100, `${label}: expected scheduled wakeup < 100 ms, got ${ms} ms`);
    }
    assert.equal(after.longTimersFired, before.longTimersFired, `${label}: fallback or timeout timer fired`);
    assert.equal(after.active, 0);
  };

  const first = waitFixtureJob(f, 1);
  // Seed a symlink cycle inside sessions/ to verify non-recursive job waits never hit ELOOP.
  fs.mkdirSync(join(first.dir, 'sessions'), { recursive: true });
  fs.symlinkSync(join(first.dir, 'sessions'), join(first.dir, 'sessions', 'loop'));
  await f.call('hud_roster');

  // 1. hud_read wait_ms wakes within 100 ms when qa/ and q1.md are created.
  const waitingQuestion = f.call('hud_read', { job: first.job, wait_ms: 5000 });
  await until(() => watchStats().active >= 2, t.signal);
  await f.rpc('ping');
  const beforeQuestion = watchStats();
  fs.mkdirSync(join(first.dir, 'qa'), { recursive: true });
  writeFixtureFile(join(first.dir, 'qa', 'q1.md'), 'Synthetic event question.');
  const qRead = await waitingQuestion;
  assert.deepEqual(qRead.questions, [{ id: 'q1', text: 'Synthetic event question.' }]);
  assertEventWakeUnder100ms(beforeQuestion, 'hud_read qa wakeup');

  await f.call('hud_respond', { job: first.job, request_id: 'q1', answer: 'Answered.' });

  // 2. hud_read wait_ms wakes within 100 ms on STATUS.json settlement.
  const waitingSettle = f.call('hud_read', { job: first.job, wait_ms: 5000 });
  await until(() => watchStats().active >= 2, t.signal);
  await f.rpc('ping');
  const beforeSettle = watchStats();
  writeFixtureFile(join(first.dir, 'report.md'), 'Synthetic fast report.');
  first.status('idle_grace');
  const settledRead = await waitingSettle;
  assert.equal(settledRead.state, 'idle_grace');
  assert.equal(settledRead.digest.result, 'Synthetic fast report.');
  assertEventWakeUnder100ms(beforeSettle, 'hud_read settle wakeup');

  // 3. hud_read wait_ms settles cleanly on timeout and leaves no open watchers.
  const second = waitFixtureJob(f, 2);
  fs.mkdirSync(join(second.dir, 'sessions'), { recursive: true });
  fs.symlinkSync(join(second.dir, 'sessions'), join(second.dir, 'sessions', 'loop'));
  const tStart = performance.now();
  const timedOutRead = await f.call('hud_read', { job: second.job, wait_ms: 120 });
  assert.equal(timedOutRead.state, 'working');
  assert.ok(performance.now() - tStart >= 120);
  assert.equal(watchStats().active, 0);

  // 4. hud_wait wakes within 100 ms despite sessions/ symlink cycle and leaves no open watchers.
  const waitingJob = f.call('hud_wait', { jobs: [second.job], wait_ms: 5000 });
  await until(() => watchStats().active >= 2, t.signal);
  await f.rpc('ping');
  const beforeWait = watchStats();
  second.status('done');
  const waited = await waitingJob;
  assert.equal(waited.ready, true);
  assert.equal(waited.timed_out, false);
  assert.deepEqual(waited.triggered, [second.job]);
  assertEventWakeUnder100ms(beforeWait, 'hud_wait wakeup');
  assert.equal(watchStats().closed, watchStats().opened);
});

test('project list, hud_wait and hud_peek stay usable with unknown question evidence when one receipt has an unreadable qa/', async (t) => {
  const f = await fixture(t);
  const healthy = waitFixtureJob(f, 1, 'working');
  const bad = waitFixtureJob(f, 2, 'idle_grace');
  writeFixtureFile(join(bad.dir, 'report.md'), 'Unreadable QA report.\n');
  fs.rmSync(join(bad.dir, 'qa'), { recursive: true, force: true });
  fs.writeFileSync(join(bad.dir, 'qa'), 'not a directory\n');

  const compact = await f.call('hud_read');
  assert.deepEqual(compact.jobs.map((row) => row.job).sort(), [healthy.job, bad.job]);
  assert.equal(compact.jobs.find((row) => row.job === bad.job)?.open_questions, null);
  assert.equal(compact.jobs.find((row) => row.job === healthy.job)?.open_questions, undefined);

  const recent = await f.call('hud_read', { view: 'recent' });
  assert.deepEqual(recent.jobs.map((row) => row.job).sort(), [healthy.job, bad.job]);
  assert.equal(recent.jobs.find((row) => row.job === bad.job)?.open_questions, null);
  assert.equal(recent.jobs.find((row) => row.job === healthy.job)?.open_questions, 0);

  const waited = await f.call('hud_wait', { jobs: [bad.job, healthy.job], wait_ms: 0 });
  assert.equal(waited.ready, true);
  assert.deepEqual(waited.triggered, [bad.job]);
  assert.equal(waited.jobs.find((row) => row.job === bad.job)?.open_questions, null);

  const peeked = await f.call('hud_peek', { job: bad.job });
  assert.equal(peeked.status.open_questions, null);
});
