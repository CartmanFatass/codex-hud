import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { adoptionAttention, failureUnobserved, jobRow } from '../../dist/collectors/thin-jobs.js';
import { JobIndexCache } from '../../dist/roles/job-index-cache.js';
import { adoptProjectJobs } from '../../dist/roles/job-project.js';
import { fixture } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

const FS_SPY_PROBE = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';

const jobsRoot = resolve(join(process.env.HUD_HOME, 'jobs'));
const logFile = join(process.env.HUD_HOME, 'fs-spy.jsonl');
const origAppend = fs.appendFileSync.bind(fs);
const WRITE_MASK = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT;
const isWriteOpen = (flags) =>
  typeof flags === 'string'
    ? /[wa+]/.test(flags)
    : typeof flags === 'number'
      ? (flags & WRITE_MASK) !== 0
      : false;
const log = (op, file, write = false) => {
  const p = typeof file === 'string' ? resolve(file) : null;
  if (!p || (p !== jobsRoot && !p.startsWith(jobsRoot + '/'))) return;
  const rel = p === jobsRoot ? '' : p.slice(jobsRoot.length + 1);
  origAppend(logFile, JSON.stringify({ op, rel, write }) + '\\n');
};
for (const op of ['readdirSync', 'readFileSync', 'openSync', 'statSync', 'lstatSync', 'existsSync']) {
  const orig = fs[op];
  fs[op] = (file, ...args) => {
    log(op, file, op === 'openSync' && isWriteOpen(args[0]));
    return orig(file, ...args);
  };
}
syncBuiltinESMExports();
`;

function summarizeFs(events) {
  const reads = events.filter((e) => !e.write);
  const c = {
    readdirJobs: 0,
    readJobJson: 0,
    readStatusJson: 0,
    readdirQa: 0,
    statReport: 0,
    readSession: 0,
    statTotal: 0,
    fsReadOps: reads.length,
    estSyscalls: 0,
  };
  for (const e of reads) {
    if (e.op === 'readdirSync') {
      c.estSyscalls += 3;
      if (e.rel === '') c.readdirJobs++;
      else if (e.rel.endsWith('/qa')) c.readdirQa++;
    } else if (e.op === 'readFileSync' || e.op === 'openSync') {
      c.estSyscalls += 4;
      if (e.rel.endsWith('/job.json')) c.readJobJson++;
      else if (e.rel.endsWith('/STATUS.json')) c.readStatusJson++;
      else if (e.rel.endsWith('/SESSION.txt')) c.readSession++;
    } else if (e.op === 'statSync' || e.op === 'lstatSync' || e.op === 'existsSync') {
      c.estSyscalls += 1;
      c.statTotal++;
      if (e.rel.endsWith('/report.md')) c.statReport++;
    }
  }
  return c;
}

function spyFs(t, method, onCall) {
  const original = fs[method];
  fs[method] = (...args) => onCall(original, ...args);
  syncBuiltinESMExports();
  t.after(() => {
    fs[method] = original;
    syncBuiltinESMExports();
  });
  return original;
}

function seedHistoricalJobs(f, count = 60) {
  const jobsRoot = join(f.env.HUD_HOME, 'jobs');
  for (let i = 1; i <= count; i++) {
    const id = `j${i.toString(16).padStart(16, '0')}`;
    const dir = join(jobsRoot, id);
    const onCaller = i <= 15;
    const active = i <= 6;
    const hasReport = !active && i <= 46;
    const createdAt = new Date(Date.UTC(2030, 0, 1, 0, 0, i)).toISOString();
    fs.mkdirSync(join(dir, 'qa'), { recursive: true });
    writeFixtureFile(
      join(dir, 'job.json'),
      JSON.stringify(
        {
          job: id,
          role: 'imp',
          request_key: `seed-${i}`,
          cwd: f.root,
          project_root: f.root,
          herdr_pane: onCaller ? 'w4E:p1' : 'w4E:p9',
          created_at: createdAt,
          ...(hasReport ? { read_at: '2030-01-02T00:00:00.000Z' } : {}),
          observed_at: '2030-01-02T00:00:00.000Z',
          ...(active ? {} : { reaped_at: '2030-01-02T00:00:00.000Z' }),
          dispatch_exit_code: 0,
          stderr_tail: '',
        },
        null,
        2
      )
    );
    if (i === 1) {
      writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'waiting_orchestrator', reason: 'question' }));
      writeFixtureFile(join(dir, 'qa', 'q1.md'), 'Which option should I take?\n');
    } else if (active) {
      writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working', started_at: createdAt }));
    } else {
      writeFixtureFile(
        join(dir, 'STATUS.json'),
        JSON.stringify({ state: 'closed', output_written: hasReport, settled_at: createdAt, ended_at: createdAt })
      );
    }
    if (hasReport) writeFixtureFile(join(dir, 'report.md'), `# Seed report ${i}\nSynthetic result.\n`);
    if (active) {
      writeFixtureFile(
        join(dir, 'SESSION.txt'),
        `TASK=${id}\nTAB=t${i}\nTAB_NAME=imp seed ${i}\nLEFT=w4E:p${i + 10}\nORCH=w4E:p1\nPRIMARY=${id}-primary\n`
      );
    }
  }
}

test('warm MCP hud_roster, hud_read, hud_respond, hud_create and hud_send reuse JobIndexCache across 60 jobs', { timeout: 30000 }, async (t) => {
  const f = await fixture(t, { probe: FS_SPY_PROBE });
  const logFile = join(f.env.HUD_HOME, 'fs-spy.jsonl');
  const drain = () => {
    if (!fs.existsSync(logFile)) return [];
    const text = fs.readFileSync(logFile, 'utf8');
    fs.writeFileSync(logFile, '');
    return text.trim() ? text.trim().split('\n').map((line) => JSON.parse(line)) : [];
  };

  seedHistoricalJobs(f, 60);

  // Warm the shared cache (all 60 job.json, STATUS.json, qa/, plus active SESSION.txt via one create).
  await f.call('hud_roster', { cwd: f.root });
  await f.call('hud_read');
  const warmCreated = await f.call('hud_create', {
    role: 'imp',
    cwd: f.root,
    request_key: 'warm-session-cache',
    task: '# Warm session cache\nSynthetic.',
  });
  assert.ok(warmCreated.job);
  drain();

  // 1. hud_roster (warm): 0 readdir(jobs), 0 job.json/STATUS.json reads, 0 qa/ readdir.
  const roster = await f.call('hud_roster', { cwd: f.root });
  assert.equal(roster.convention_unchanged, true);
  const rosterStats = summarizeFs(drain());
  assert.equal(rosterStats.readdirJobs, 0, JSON.stringify(rosterStats));
  assert.equal(rosterStats.readJobJson, 0, JSON.stringify(rosterStats));
  assert.equal(rosterStats.readStatusJson, 0, JSON.stringify(rosterStats));
  assert.equal(rosterStats.readdirQa, 0, JSON.stringify(rosterStats));
  assert.ok(rosterStats.estSyscalls < 260, `expected <260 syscalls, got ${rosterStats.estSyscalls}`);

  // 2. hud_read() list (warm): 0 readdir(jobs), 0 job.json/STATUS.json reads, 0 qa/ readdir.
  const list = await f.call('hud_read');
  assert.ok(Array.isArray(list.jobs));
  const listStats = summarizeFs(drain());
  assert.equal(listStats.readdirJobs, 0, JSON.stringify(listStats));
  assert.equal(listStats.readJobJson, 0, JSON.stringify(listStats));
  assert.equal(listStats.readStatusJson, 0, JSON.stringify(listStats));
  assert.equal(listStats.readdirQa, 0, JSON.stringify(listStats));
  assert.ok(listStats.estSyscalls < 500, `expected <500 syscalls, got ${listStats.estSyscalls}`);

  // 3. hud_read({ job }) (warm, settled & already read): 0 readdir/read of job/STATUS/qa.
  const settledId = 'j0000000000000007';
  const single = await f.call('hud_read', { job: settledId });
  assert.equal(single.job, settledId);
  assert.equal(single.report_exists, true);
  assert.equal(single.report_unchanged, true);
  const singleStats = summarizeFs(drain());
  assert.equal(singleStats.readdirJobs, 0, JSON.stringify(singleStats));
  assert.equal(singleStats.readJobJson, 0, JSON.stringify(singleStats));
  assert.equal(singleStats.readStatusJson, 0, JSON.stringify(singleStats));
  assert.equal(singleStats.readdirQa, 0, JSON.stringify(singleStats));
  assert.ok(singleStats.estSyscalls < 260, `expected <260 syscalls, got ${singleStats.estSyscalls}`);

  // 4. hud_respond: writes q1.answer.md, refreshes only that one qa/ dir, 0 historical job/STATUS reads.
  const answered = await f.call('hud_respond', {
    job: 'j0000000000000001',
    request_id: 'q1',
    answer: 'Option A',
  });
  assert.equal(answered.ok, true);
  assert.equal(answered.written, true);
  assert.ok(
    answered.changes?.some((line) => line.startsWith('j0000000000000001 imp:') && !line.includes('QUESTION')),
    `expected cleared question in hud_respond changes: ${JSON.stringify(answered.changes)}`
  );
  const respondStats = summarizeFs(drain());
  assert.equal(respondStats.readdirJobs, 0, JSON.stringify(respondStats));
  assert.equal(respondStats.readJobJson, 0, JSON.stringify(respondStats));
  assert.equal(respondStats.readStatusJson, 0, JSON.stringify(respondStats));
  assert.equal(respondStats.readdirQa, 1, JSON.stringify(respondStats));
  assert.ok(respondStats.estSyscalls < 260, `expected <260 syscalls, got ${respondStats.estSyscalls}`);

  // 5. hud_create (warm): historical 60 jobs never re-read; active SESSION.txt hits cache.
  const created = await f.call('hud_create', {
    role: 'imp',
    cwd: f.root,
    request_key: 'warm-create-2',
    task: '# Second task\nSynthetic.',
  });
  assert.ok(created.job);
  const createStats = summarizeFs(drain());
  assert.ok(createStats.readdirJobs <= 1, JSON.stringify(createStats));
  assert.equal(createStats.readJobJson, 0, JSON.stringify(createStats));
  assert.ok(createStats.readStatusJson <= 1, JSON.stringify(createStats));
  assert.ok(createStats.readdirQa <= 1, JSON.stringify(createStats));
  assert.ok(createStats.readSession <= 2, JSON.stringify(createStats));

  // 6. hud_send (warm): 0 historical job/STATUS/qa reads.
  const sent = await f.call('hud_send', { job: created.job, text: 'Continue with step 2.' });
  assert.equal(sent.ok, true);
  assert.equal(sent.sent, true);
  const sendStats = summarizeFs(drain());
  assert.equal(sendStats.readdirJobs, 0, JSON.stringify(sendStats));
  assert.equal(sendStats.readJobJson, 0, JSON.stringify(sendStats));
  assert.equal(sendStats.readStatusJson, 0, JSON.stringify(sendStats));
  assert.equal(sendStats.readdirQa, 0, JSON.stringify(sendStats));

  t.diagnostic(
    `warm 60-job syscalls: roster=${rosterStats.estSyscalls}, read_list=${listStats.estSyscalls}, ` +
      `read_job=${singleStats.estSyscalls}, respond=${respondStats.estSyscalls}, ` +
      `create=${createStats.estSyscalls}, send=${sendStats.estSyscalls}`
  );
});

test('an answered question clears immediately in the next hud_read and its changes with no stale window', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const id = 'j00000000000000aa';
  const dir = join(f.env.HUD_HOME, 'jobs', id);
  fs.mkdirSync(join(dir, 'qa'), { recursive: true });
  writeFixtureFile(
    join(dir, 'job.json'),
    JSON.stringify({
      job: id,
      role: 'imp',
      request_key: 'qa-freshness',
      cwd: f.root,
      project_root: f.root,
      herdr_pane: 'w4E:p1',
      created_at: '2030-01-01T00:00:00.000Z',
      dispatch_exit_code: 0,
      stderr_tail: '',
    })
  );
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'waiting_orchestrator', reason: 'question' }));
  writeFixtureFile(join(dir, 'qa', 'q1.md'), 'Pick A or B?\n');

  // Prime cache and cursor with q1 open.
  const before = await f.call('hud_read', { job: id });
  assert.deepEqual(
    before.questions.map((q) => q.id),
    ['q1']
  );

  // Path 1: external answer (e.g. panel) written directly to disk -> next hud_read clears q1 immediately in both payload and changes.
  writeFixtureFile(join(dir, 'qa', 'q1.answer.md'), 'Pick A');
  const afterExternal = await f.call('hud_read', { job: id });
  assert.equal(afterExternal.questions, undefined, 'q1 cleared immediately on next hud_read');
  assert.ok(
    afterExternal.changes?.some((line) => line.startsWith(`${id} imp:`) && !line.includes('QUESTION')),
    `expected cleared QUESTION in hud_read changes: ${JSON.stringify(afterExternal.changes)}`
  );

  // Path 2: new question q2 answered via hud_respond -> immediate next hud_read has no open questions and no stale QUESTION in changes.
  writeFixtureFile(join(dir, 'qa', 'q2.md'), 'Pick C or D?\n');
  const withQ2 = await f.call('hud_read', { job: id });
  assert.deepEqual(
    withQ2.questions.map((q) => q.id),
    ['q2']
  );
  assert.ok(withQ2.changes?.some((line) => line.includes(`${id} imp:`) && line.includes('QUESTION')));

  const resp = await f.call('hud_respond', { job: id, request_id: 'q2', answer: 'Pick C' });
  assert.equal(resp.written, true);
  assert.ok(
    resp.changes?.some((line) => line.startsWith(`${id} imp:`) && !line.includes('QUESTION')),
    `expected cleared QUESTION in hud_respond changes: ${JSON.stringify(resp.changes)}`
  );

  const afterRespond = await f.call('hud_read', { job: id });
  assert.equal(afterRespond.questions, undefined);
  assert.equal(afterRespond.changes, undefined, 'no stale changes after hud_respond already cleared q2');
});

test('external quota failure marks exhaustion through cache and updates subsequent hud_roster without re-marking', { timeout: 30000 }, async (t) => {
  const f = await fixture(t, { probe: FS_SPY_PROBE });
  const logFile = join(f.env.HUD_HOME, 'fs-spy.jsonl');
  const drain = () => {
    if (!fs.existsSync(logFile)) return [];
    const text = fs.readFileSync(logFile, 'utf8');
    fs.writeFileSync(logFile, '');
    return text.trim() ? text.trim().split('\n').map((line) => JSON.parse(line)) : [];
  };

  const id = 'j00000000000000bb';
  const dir = join(f.env.HUD_HOME, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  writeFixtureFile(
    join(dir, 'job.json'),
    JSON.stringify({
      job: id,
      role: 'imp',
      request_key: 'quota-test',
      cwd: f.root,
      project_root: f.root,
      herdr_pane: 'w4E:p1',
      created_at: '2030-01-01T00:00:00.000Z',
      place: { harness: 'pi', pi_role: 'implementer', model: 'synthetic/default', thinking: 'low' },
      model: 'synthetic/default',
      dispatch_exit_code: 0,
      stderr_tail: '',
    })
  );
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working', started_at: '2030-01-01T00:00:00.000Z' }));

  // Warm cache while working.
  const working = await f.call('hud_read', { job: id });
  assert.equal(working.state, 'working');

  // External worker writes a quota failure into STATUS.json.
  writeFixtureFile(
    join(dir, 'STATUS.json'),
    JSON.stringify({
      state: 'failed',
      exit_reason: 'HTTP 429 rate limit exceeded, try again in 30 minutes',
      ended_at: '2030-01-01T00:01:00.000Z',
    })
  );

  const failed = await f.call('hud_read', { job: id });
  assert.equal(failed.state, 'failed');
  assert.match(failed.reason, /429 rate limit/i);
  assert.match(failed.reason, /no fallback place available|next dispatch will use/);

  const diskJob = JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8'));
  assert.equal(diskJob.exhaustion_marked, true);
  const diskStatus = JSON.parse(fs.readFileSync(join(dir, 'STATUS.json'), 'utf8'));
  assert.equal(diskStatus.exit_reason, failed.reason);

  // Next hud_roster sees the updated status via cache (0 STATUS.json re-reads!) and marks the place exhausted.
  drain();
  const roster = await f.call('hud_roster', { cwd: f.root });
  const imp = roster.roles.find((r) => r.role === 'imp');
  assert.ok(imp.places.some((p) => p.state === 'exhausted'), JSON.stringify(imp.places));
  const stats = summarizeFs(drain());
  assert.equal(stats.readStatusJson, 0, `expected cached STATUS.json write-through, got ${JSON.stringify(stats)}`);
  assert.equal(stats.readJobJson, 0, `expected cached job.json, got ${JSON.stringify(stats)}`);
});

test('jobRow JobRowExtras, failureUnobserved statusAt, and adoptProjectJobs reuse JobIndexCache cleanly', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'mcp-job-cache-unit-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const id = 'j00000000000000cc';
  const dir = join(home, 'jobs', id);
  fs.mkdirSync(join(dir, 'qa'), { recursive: true });
  writeFixtureFile(
    join(dir, 'job.json'),
    JSON.stringify({
      job: id,
      role: 'imp',
      cwd: home,
      project_root: home,
      herdr_pane: 'w4E:p9',
      created_at: '2030-01-01T00:00:00.000Z',
    })
  );
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ state: 'failed', exit_reason: 'boom' }));
  writeFixtureFile(join(dir, 'qa', 'q1.md'), 'Open?\n');
  writeFixtureFile(join(dir, 'report.md'), 'Report body\n');

  const cache = new JobIndexCache(home, { freezeCachedValues: true });
  let qaReaddirs = 0;
  let reportStats = 0;
  let statusStats = 0;
  spyFs(t, 'readdirSync', (orig, file, ...args) => {
    if (String(file) === join(dir, 'qa')) qaReaddirs++;
    return orig(file, ...args);
  });
  spyFs(t, 'existsSync', (orig, file, ...args) => {
    if (String(file) === join(dir, 'report.md')) reportStats++;
    return orig(file, ...args);
  });
  spyFs(t, 'statSync', (orig, file, ...args) => {
    if (String(file) === join(dir, 'report.md')) reportStats++;
    if (String(file) === join(dir, 'STATUS.json')) statusStats++;
    return orig(file, ...args);
  });
  spyFs(t, 'lstatSync', (orig, file, ...args) => {
    if (String(file) === join(dir, 'report.md')) reportStats++;
    return orig(file, ...args);
  });

  const jobRes = cache.readJob(id);
  const statusRes = cache.readStatus(id);
  assert.equal(jobRes.status, 'ok');
  assert.equal(statusRes.status, 'ok');

  // First jobRow with cache: 1 qa readdir, 1 single lstat for report.md (not existsSync + statSync).
  const r1 = jobRow(jobRes.value, statusRes.value, { dir, cache });
  assert.deepEqual(r1.question_ids, ['q1']);
  assert.equal(r1.report_present, true);
  assert.equal(qaReaddirs, 1);
  assert.equal(reportStats, 1);

  // Second jobRow with cache: 0 qa readdir (cache hit!), 1 single lstat for report.md.
  const r2 = jobRow(jobRes.value, statusRes.value, { dir, cache });
  assert.deepEqual(r2, r1);
  assert.equal(qaReaddirs, 1);
  assert.equal(reportStats, 2);

  // Third jobRow with explicit questionIds + reportPresent + reportAt: 0 qa readdir, 0 report stats.
  const r3 = jobRow(jobRes.value, statusRes.value, {
    dir,
    cache,
    questionIds: r1.question_ids,
    reportPresent: r1.report_present,
    reportAt: r1.report_mtime,
  });
  assert.deepEqual(r3, r1);
  assert.equal(qaReaddirs, 1);
  assert.equal(reportStats, 2);

  // failureUnobserved with statusAt performs 0 statSync calls.
  assert.equal(failureUnobserved(dir, '2000-01-01T00:00:00.000Z', statusRes.at), true);
  assert.equal(failureUnobserved(dir, '2099-01-01T00:00:00.000Z', statusRes.at), false);
  assert.equal(failureUnobserved(dir, '2000-01-01T00:00:00.000Z', null), false);
  assert.equal(statusStats, 0);

  // adoptionAttention with cache works with frozen cached values and reuses cached STATUS.json.
  const owes = adoptionAttention(home, [jobRes.value], home, cache);
  assert.equal(owes(dir, jobRes.value), true);
  assert.equal(statusStats, 0);

  // adoptProjectJobs with fake herdr writes through to cache (0 openSync on subsequent readJob).
  const fakeBin = join(home, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const herdrPath = join(fakeBin, 'herdr');
  fs.writeFileSync(
    herdrPath,
    '#!/bin/sh\nprintf \'{"result":{"panes":[{"pane_id":"w4E:p1"}]}}\\n\'\n',
    { mode: 0o700 }
  );
  let jobOpens = 0;
  spyFs(t, 'openSync', (orig, file, ...args) => {
    const flags = args[0];
    const isRead = typeof flags === 'number' && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) === 0;
    if (isRead && String(file) === join(dir, 'job.json')) jobOpens++;
    return orig(file, ...args);
  });
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };
  const adopted = await adoptProjectJobs(home, 'w4E:p1', home, [jobRes.value], env, owes, cache);
  assert.equal(adopted, true);
  const afterAdopt = cache.readJob(id);
  assert.equal(afterAdopt.status, 'ok');
  assert.equal(afterAdopt.hit, true, 'adoptProjectJobs wrote through to JobIndexCache');
  assert.equal(afterAdopt.value.herdr_pane, 'w4E:p1');
  assert.equal(jobOpens, 0);
});
