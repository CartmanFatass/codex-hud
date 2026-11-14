import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { jobChanges, jobRow, readThinJobRows, readThinJobs } from '../../dist/collectors/thin-jobs.js';
test('newest 200 jobs: unchanged scan parses no receipts; a changed job appears next scan', (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'thin-scan-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const scope = { project: null, pane: 'w4E:p1' };
  let parses = 0;
  const parse = (text) => {
    const value = JSON.parse(text);
    if (value?.job) parses++;
    return value;
  };
  for (let n = 0; n < 300; n++) {
    const job = `j${n.toString(16).padStart(16, '0')}`;
    const dir = join(home, 'jobs', job);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      join(dir, 'job.json'),
      JSON.stringify({
        job,
        role: 'imp',
        herdr_pane: scope.pane,
        created_at: new Date(n * 1000).toISOString(),
      })
    );
    for (const [name, text] of [
      ['STATUS.json', '{"state":"closed"}'],
      ['brief.md', '# Synthetic'],
      ['report.md', 'Synthetic result'],
    ])
      fs.writeFileSync(join(dir, name), text);
    fs.utimesSync(dir, n, n);
  }
  const workers = () => readThinJobs(home, scope, parse).flatMap((lane) => lane.workers);
  const first = workers();
  assert.equal(first.length, 200);
  assert.equal(parses, 200);
  parses = 0;
  assert.deepEqual(workers(), first);
  assert.equal(parses, 0);
  const file = join(home, 'jobs', 'j000000000000012b', 'job.json');
  const changed = { ...JSON.parse(fs.readFileSync(file)), model: 'synthetic-new-model' };
  fs.writeFileSync(file + '.tmp', JSON.stringify(changed));
  fs.renameSync(file + '.tmp', file);
  assert.equal(workers()[0].model, changed.model);
  assert.equal(parses, 1);
  const cutoff = Date.now() + 60000;
  assert.deepEqual(readThinJobs(home, scope, parse, { settledBefore: cutoff }), []);
  for (const [suffix, status] of [['012b', '{"state":"working"}'], ['012a', '{}'], ['0129', '{"state":"closed","settled_at":"2999-01-01"}']])
    fs.writeFileSync(join(home, 'jobs', `j000000000000${suffix}`, 'STATUS.json'), status);
  const retained = readThinJobs(home, scope, parse, { settledBefore: cutoff }).flatMap(l => l.workers);
  assert.equal(retained.length, 3, 'old working and unknown jobs plus recent settlement remain');
  assert.equal(retained.filter(w => w.state === 'working').length, 2);
});

test('1,000 old jobs: cold invocations reuse persisted facts, bounded bodies, changed STATUS is seen', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'thin-cold-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const scope = { project: null, pane: 'w4E:p1' };
  for (let n = 0; n < 1000; n++) {
    const job = `j${n.toString(16).padStart(16, '0')}`, dir = join(home, 'jobs', job);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job, role: 'imp', herdr_pane: 'w4E:p2', created_at: new Date(n * 1000).toISOString() }));
    fs.writeFileSync(join(dir, 'STATUS.json'), '{"state":"closed"}');
    fs.writeFileSync(join(dir, 'brief.md'), '# Synthetic retained brief');
    fs.writeFileSync(join(dir, 'report.md'), 'Synthetic retained report');
    fs.utimesSync(dir, n, n);
  }
  let parses = 0, artifacts = 0, lists = 0;
  const stats = new Map(), originals = { openSync: fs.openSync, lstatSync: fs.lstatSync, readdirSync: fs.readdirSync };
  fs.openSync = (file, ...args) => {
    if (/\/(brief|report|review-\d+|q\d+(?:\.answer)?)\.md$/.test(String(file))) artifacts++;
    return originals.openSync(file, ...args);
  };
  fs.lstatSync = (file, ...args) => {
    if (/\/jobs\/j[0-9a-f]{16}$/.test(String(file))) stats.set(String(file), (stats.get(String(file)) ?? 0) + 1);
    return originals.lstatSync(file, ...args);
  };
  fs.readdirSync = (file, ...args) => { if (String(file) === join(home, 'jobs')) lists++; return originals.readdirSync(file, ...args); };
  syncBuiltinESMExports();
  t.after(() => { Object.assign(fs, originals); syncBuiltinESMExports(); });
  const parse = (s) => { parses++; return JSON.parse(s); };
  const options = { settledBefore: Date.now() + 60000 };
  const first = await import('../../dist/collectors/thin-jobs.js?cold1');
  assert.deepEqual(first.readThinJobs(home, scope, parse, options), []);
  assert.ok(parses <= 200, String(parses));
  assert.equal(artifacts, 0, 'no artifacts for the other pane');
  assert.equal(lists, 1); assert.equal(stats.size, 1000); assert.ok([...stats.values()].every((n) => n === 1));
  stats.clear(); lists = 0;
  const cacheFile = join(home, 'display/thin-jobs.json');
  const stamp = fs.statSync(cacheFile).mtimeMs;
  parses = 0;
  const second = await import('../../dist/collectors/thin-jobs.js?cold2');
  assert.deepEqual(second.readThinJobs(home, scope, parse, options), []);
  assert.ok(parses <= 3, String(parses));
  assert.equal(artifacts, 0, 'cold invocation still reads no other-pane artifacts');
  assert.equal(lists, 1); assert.ok([...stats.values()].every((n) => n === 1));
  assert.equal(fs.statSync(cacheFile).mtimeMs, stamp, 'unchanged refresh does not rewrite cache');
  const dir = join(home, 'jobs', 'j00000000000003e7');
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job: 'j00000000000003e7', role: 'imp', herdr_pane: scope.pane, created_at: new Date(999000).toISOString() }));
  fs.writeFileSync(join(dir, 'STATUS.json'), '{"state":"working","model":"changed-status"}');
  const changed = second.readThinJobs(home, scope, parse, options).flatMap((l) => l.workers);
  assert.equal(changed[0].model, 'changed-status');
  fs.writeFileSync(cacheFile, '{broken');
  const third = await import('../../dist/collectors/thin-jobs.js?cold3');
  assert.equal(third.readThinJobs(home, scope, parse, options).flatMap((l) => l.workers)[0].model, 'changed-status');
});

test('listed jobs disappearing before or during read are omitted and forgotten by the persisted cache', async (t) => {
  for (const bar of [false, true]) for (const duringOpen of [false, true]) {
    const home = fs.mkdtempSync(join(tmpdir(), 'thin-vanished-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const scope = { project: null, pane: 'w4E:p1' };
    const id = 'j0000000000000001', dir = join(home, 'jobs', id);
    const survivor = 'j0000000000000002';
    for (const job of [id, survivor]) {
      const directory = join(home, 'jobs', job);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(join(directory, 'job.json'), JSON.stringify({ job, role: 'imp', herdr_pane: scope.pane, created_at: '2030-01-01' }));
      fs.writeFileSync(join(directory, 'STATUS.json'), '{"state":"working"}');
    }
    const options = bar ? { settledBefore: Date.now() } : undefined;
    assert.equal(readThinJobs(home, scope, JSON.parse, options).flatMap((l) => l.workers).length, 2);
    const cacheFile = join(home, 'display/thin-jobs.json');
    assert.ok(fs.readFileSync(cacheFile, 'utf8').includes(id));
    // Force a body read despite the warm receipt cache, then remove the real directory at the I/O boundary.
    fs.appendFileSync(join(dir, 'job.json'), '\n');
    const method = duringOpen ? 'openSync' : 'lstatSync', original = fs[method];
    let removed = false;
    fs[method] = (file, ...args) => {
      if (String(file) === join(dir, 'job.json')) {
        removed = true;
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return original(file, ...args);
    };
    syncBuiltinESMExports();
    try {
      const workers = readThinJobs(home, scope, JSON.parse, options).flatMap((l) => l.workers);
      assert.equal(removed, true, 'exercised disappearance after directory listing');
      assert.deepEqual(workers.map((w) => w.id), [`thin-job:${survivor}`]);
      const rows = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      assert.ok(rows.every(([rel]) => !rel.startsWith(id + '/')), 'no persisted facts for vanished job');
      assert.equal(rows.length, 2, 'other job receipt and STATUS remain cached');
    } finally {
      fs[method] = original;
      syncBuiltinESMExports();
    }
    const cold = await import(`../../dist/collectors/thin-jobs.js?vanished-${bar}-${duringOpen}`);
    assert.deepEqual(cold.readThinJobs(home, scope, JSON.parse, options).flatMap((l) => l.workers).map((w) => w.id), [`thin-job:${survivor}`]);
  }
});

test('settled HUD card age is time since settlement, not run duration', async (t) => {
  const { projectWorkCard } = await import('../../dist/collectors/work-card.js');
  const now = Date.parse('2030-01-01T12:00:00Z');
  for (const state of ['done', 'failed', 'stopped']) {
    const worker = { id: 'thin-job:j0000000000000001', state, startedAt: now - 3600000, settledAt: now - 120000,
      work: { facadeClosed: true, failed: state === 'failed', activityAt: now - 120000 } };
    assert.equal(projectWorkCard(worker, now).elapsedMinutes, 2);
  }
});

test('a job stopped after writing its report shows as done; one stopped without it stays stopped', (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'thin-stop-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const scope = { project: null, pane: 'w4E:p1' };
  for (const [n, written] of [[1, true], [2, false]]) {
    const job = `j${n.toString(16).padStart(16, '0')}`, dir = join(home, 'jobs', job);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job, role: 'imp', herdr_pane: scope.pane, created_at: new Date(n * 1000).toISOString() }));
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'stopped', exit_reason: 'stop requested', output_written: written }));
  }
  const states = Object.fromEntries(readThinJobs(home, scope).flatMap((l) => l.workers).map((w) => [w.id.slice(-1), w.state]));
  assert.deepEqual(states, { 1: 'done', 2: 'stopped' });
});

test('jobRow derives raw state, display state, reason, blocked, open questions and report presence', (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'thin-row-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(join(dir, 'qa'), { recursive: true });
  fs.writeFileSync(join(dir, 'qa', 'q1.md'), 'Open?');
  fs.writeFileSync(join(dir, 'qa', 'q2.md'), 'Answered?');
  fs.writeFileSync(join(dir, 'qa', 'q2.answer.md'), 'yes');
  fs.writeFileSync(join(dir, 'report.md'), 'Done.');
  const row = jobRow(
    { job: 'j0000000000000001', role: 'imp', package: 'SUPERVISOR', cli: { agent: 'grok' } },
    { state: 'waiting_orchestrator', blocked: true, reason: null },
    { dir }
  );
  assert.deepEqual(row, {
    job: 'j0000000000000001',
    role: 'imp',
    package: 'SUPERVISOR',
    state: 'waiting_orchestrator',
    display_state: 'working',
    reason: 'grok needs input in its pane',
    blocked: true,
    open_questions: 1,
    report_present: true,
  });
});

test('jobChanges emits concise lines only for (state, reason, report_present, open_questions) changes', () => {
  const base = {
    job: 'j0000000000000001',
    role: 'imp',
    package: '02-changes',
    state: null,
    display_state: 'working',
    reason: null,
    blocked: false,
    open_questions: 0,
    report_present: false,
  };
  const sameWorking = { ...base, state: 'working' };
  assert.deepEqual(jobChanges([base], [sameWorking]), []);

  const waiting = {
    ...sameWorking,
    state: 'waiting_orchestrator',
    reason: 'claude   needs\ninput',
    blocked: true,
    open_questions: 1,
    report_present: true,
  };
  assert.deepEqual(jobChanges([sameWorking], [waiting]), [
    'j0000000000000001 imp 02-changes: waiting_orchestrator | claude needs input | report | QUESTION',
  ]);
  assert.deepEqual(jobChanges([waiting], [waiting]), []);

  const multiQ = { ...waiting, open_questions: 2, state: 'done', display_state: 'done', reason: null, blocked: false };
  assert.deepEqual(jobChanges([waiting], [multiQ]), [
    'j0000000000000001 imp 02-changes: done | report | QUESTION (2)',
  ]);
});

test('readThinJobRows caches unchanged files by signature without reading bodies or writing HUD_HOME', (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'thin-watch-rows-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const mk = (id, pane, state) => {
    const dir = join(home, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job: id, role: 'imp', package: pane, herdr_pane: pane }));
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state }));
    fs.writeFileSync(join(dir, 'brief.md'), 'Body should not be opened');
    return dir;
  };
  mk('j0000000000000001', 'w4E:p1', 'working');
  mk('j0000000000000002', 'w4E:p9', 'failed');

  assert.deepEqual(readThinJobRows(home, {}), []);
  const scoped = readThinJobRows(home, { pane: 'w4E:p1' });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].job, 'j0000000000000001');

  const all = readThinJobRows(home, { pane: null });
  assert.deepEqual(
    all.map((r) => r.job).sort(),
    ['j0000000000000001', 'j0000000000000002']
  );

  // Replace openSync spy to verify signature cache skips re-opening unchanged job.json/STATUS.json and brief.md.
  const opened = [];
  const origOpen = fs.openSync;
  fs.openSync = (file, ...rest) => {
    opened.push(String(file));
    return origOpen(file, ...rest);
  };
  try {
    assert.equal(readThinJobRows(home, { pane: null }).length, 2);
  } finally {
    fs.openSync = origOpen;
  }
  assert.deepEqual(opened, []);
  assert.equal(fs.existsSync(join(home, 'display')), false);
});
