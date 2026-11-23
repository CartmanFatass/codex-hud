import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writePrivateFile } from '../../dist/utils/atomic-fs.js';
import {
  clearJobIndexCaches,
  DEFAULT_MAX_JSON_BYTES,
  DEFAULT_MAX_SESSION_BYTES,
  fileStampOf,
  getJobIndexCache,
  isFileStampCurrent,
  JobIndexCache,
  legacyFileStampOf,
  MAX_CACHED_HOMES,
  statsMtimeMs,
} from '../../dist/roles/job-index-cache.js';

function tempHome(t, prefix = 'job-index-cache-') {
  const home = fs.mkdtempSync(join(tmpdir(), prefix));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function jobId(n) {
  return `j${n.toString(16).padStart(16, '0')}`;
}

function seedJob(home, id, { job = {}, status = { state: 'working' }, qa = null, report = null, session = null } = {}) {
  const dir = join(home, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  writePrivateFile(
    join(dir, 'job.json'),
    JSON.stringify({ job: id, role: 'imp', herdr_pane: 'w1:p1', cwd: '/synthetic/repo', created_at: '2030-01-01T00:00:00Z', ...job }) + '\n',
    { mkdir: false }
  );
  if (status !== null) {
    writePrivateFile(join(dir, 'STATUS.json'), JSON.stringify(status) + '\n', { mkdir: false });
  }
  if (qa) {
    const qaDir = join(dir, 'qa');
    fs.mkdirSync(qaDir, { recursive: true });
    for (const [name, body] of Object.entries(qa)) {
      fs.writeFileSync(join(qaDir, name), body);
    }
  }
  if (report !== null) {
    fs.writeFileSync(join(dir, 'report.md'), report);
  }
  if (session !== null) {
    fs.writeFileSync(join(dir, 'SESSION.txt'), session);
  }
  return dir;
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

test('older children follow a selected parent; stale markers cannot pull in another family', (t) => {
  const home = tempHome(t), cache = new JobIndexCache(home);
  const other = seedJob(home, jobId(1)), parent = seedJob(home, jobId(2));
  const child = seedJob(home, jobId(3), { job: { parent_job: jobId(2) } });
  const unrelated = seedJob(home, jobId(4), { job: { parent_job: jobId(1) } });
  for (const id of [jobId(3), jobId(4)]) writePrivateFile(join(parent, '.sonic', id), '');
  [other, child, unrelated, parent].forEach((dir, i) => fs.utimesSync(dir, i + 10, i + 10));
  const selected = () => cache.recentJobFamilies(cache.listJobDirsByMtime().dirs, 1).map(d => d.id);
  assert.deepEqual(selected(), [jobId(2), jobId(3)]);
  let reads = 0;
  spyFs(t, 'openSync', (open, ...args) => { reads++; return open(...args); });
  assert.deepEqual(selected(), [jobId(2), jobId(3)]);
  assert.equal(reads, 0, 'unchanged receipts are not reopened');
});

test('S1.1 same-millisecond atomic replacement with identical byte length penetrates cache, and writeJsonAtomic writes through atomic-fs', (t) => {
  const home = tempHome(t);
  const id = jobId(1);
  const dir = seedJob(home, id, { status: null });
  const statusFile = join(dir, 'STATUS.json');
  const workingPayload = '{"state":"working"}'; // 19 bytes
  const stoppedPayload = '{"state":"stopped"}'; // 19 bytes
  assert.equal(Buffer.byteLength(workingPayload), Buffer.byteLength(stoppedPayload));

  writePrivateFile(statusFile, workingPayload, { mkdir: false });
  const cache = new JobIndexCache(home);

  let opens = 0;
  spyFs(t, 'openSync', (orig, file, ...args) => {
    if (String(file) === statusFile) opens++;
    return orig(file, ...args);
  });

  const first = cache.readStatus(id);
  assert.equal(first.status, 'ok');
  assert.equal(first.hit, false);
  assert.equal(first.value.state, 'working');
  assert.equal(opens, 1);

  const second = cache.readStatus(id);
  assert.equal(second.status, 'ok');
  assert.equal(second.hit, true);
  assert.equal(second.value.state, 'working');
  assert.equal(opens, 1);

  // Same-tick atomic replacement with identical byte length changes inode.
  writePrivateFile(statusFile, stoppedPayload, { mkdir: false });
  const third = cache.readStatus(id);
  assert.equal(third.status, 'ok');
  assert.equal(third.hit, false);
  assert.equal(third.value.state, 'stopped');
  assert.equal(opens, 2);

  // writeJsonAtomic writes via atomic-fs (0600 private mode) and writes through into the cache.
  const published = cache.writeJsonAtomic(statusFile, { state: 'closed', output_written: true }, { mkdir: false });
  assert.equal(fs.statSync(statusFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(statusFile).ino, published.ino);
  const afterWrite = cache.readStatus(id);
  assert.equal(afterWrite.status, 'ok');
  assert.equal(afterWrite.hit, true);
  assert.deepEqual(afterWrite.value, { state: 'closed', output_written: true });
  assert.equal(opens, 2, 'writeJsonAtomic populated cache without needing a re-read');
});

test('S1.2 same-millisecond utimesSync backdate and in-place overwrite are caught via ctimeNs', (t) => {
  const home = tempHome(t);
  const id = jobId(2);
  const dir = seedJob(home, id, { status: null });
  const statusFile = join(dir, 'STATUS.json');
  const fixedTime = 1_700_000_000;

  fs.writeFileSync(statusFile, '{"state":"working"}');
  fs.utimesSync(statusFile, fixedTime, fixedTime);

  const cache = new JobIndexCache(home);
  const first = cache.readStatus(id);
  assert.equal(first.status, 'ok');
  assert.equal(first.value.state, 'working');

  // In-place overwrite with same byte length and mtime pinned back to identical T.
  fs.writeFileSync(statusFile, '{"state":"stopped"}');
  fs.utimesSync(statusFile, fixedTime, fixedTime);

  const second = cache.readStatus(id);
  assert.equal(second.status, 'ok');
  assert.equal(second.hit, false);
  assert.equal(second.value.state, 'stopped');
});

test('S1.3 concurrent external write during writeJsonAtomic / recordAtomicJson evicts instead of poisoning cache', (t) => {
  const home = tempHome(t);
  const id = jobId(3);
  const dir = seedJob(home, id, { status: { state: 'initial' } });
  const statusFile = join(dir, 'STATUS.json');
  const cache = new JobIndexCache(home);

  // Prime cache with initial state.
  assert.equal(cache.readStatus(id).value.state, 'initial');

  // Race A: external writer replaces statusFile right after writeJsonAtomic's rename, before verification lstat.
  let injectedRace = false;
  spyFs(t, 'lstatSync', (orig, file, ...args) => {
    if (!injectedRace && String(file) === statusFile) {
      injectedRace = true;
      writePrivateFile(statusFile, JSON.stringify({ state: 'winner-from-peer' }) + '\n', { mkdir: false });
    }
    return orig(file, ...args);
  });

  cache.writeJsonAtomic(statusFile, { state: 'stale-from-a' }, { mkdir: false });
  assert.equal(injectedRace, true);

  const observedA = cache.readStatus(id);
  assert.equal(observedA.status, 'ok');
  assert.equal(observedA.hit, false, 'cache must have been evicted rather than storing stale-from-a');
  assert.equal(observedA.value.state, 'winner-from-peer');

  // Race B: external writePrivateFile + recordAtomicJson when a peer wins after publish.
  const publishedA = writePrivateFile(statusFile, JSON.stringify({ state: 'stale-b' }) + '\n', { mkdir: false });
  writePrivateFile(statusFile, JSON.stringify({ state: 'winner-b' }) + '\n', { mkdir: false });
  const accepted = cache.recordAtomicJson(statusFile, publishedA, { state: 'stale-b' });
  assert.equal(accepted, false);

  const observedB = cache.readStatus(id);
  assert.equal(observedB.status, 'ok');
  assert.equal(observedB.hit, false);
  assert.equal(observedB.value.state, 'winner-b');

  // Race C: rejected beforeRename throws without poisoning the existing valid cache entry.
  const abortErr = new Error('cas_rejected');
  assert.throws(
    () =>
      cache.writeJsonAtomic(
        statusFile,
        { state: 'never-published' },
        {
          mkdir: false,
          beforeRename() {
            throw abortErr;
          },
        }
      ),
    (err) => err === abortErr
  );
  const afterAbort = cache.readStatus(id);
  assert.equal(afterAbort.status, 'ok');
  assert.equal(afterAbort.hit, true);
  assert.equal(afterAbort.value.state, 'winner-b');
});

test('S1.4 qa/ visibility, dir-stamp caching, ENOENT non-caching, invalidateQa, and non-directory ENOTDIR', (t) => {
  const home = tempHome(t);
  const id = jobId(4);
  const dir = seedJob(home, id);
  const qaDir = join(dir, 'qa');
  const cache = new JobIndexCache(home);

  let qaReaddirs = 0;
  spyFs(t, 'readdirSync', (orig, target, ...args) => {
    if (String(target) === qaDir) qaReaddirs++;
    return orig(target, ...args);
  });

  // Missing qa/ returns empty snapshot without negative-caching ENOENT.
  const empty = cache.readQa(id);
  assert.deepEqual(empty, { exists: false, openIds: [], allQuestionFiles: [], stamp: null });
  assert.equal(qaReaddirs, 0);

  // Creating qa/ with numeric ordering (q1, q2, q10) is immediately visible.
  fs.mkdirSync(qaDir, { recursive: true });
  fs.writeFileSync(join(qaDir, 'q10.md'), 'Question 10');
  fs.writeFileSync(join(qaDir, 'q2.md'), 'Question 2');
  fs.writeFileSync(join(qaDir, 'q1.md'), 'Question 1');

  const first = cache.readQa(id);
  assert.equal(first.exists, true);
  assert.deepEqual(first.openIds, ['q1', 'q2', 'q10']);
  assert.deepEqual(first.allQuestionFiles, ['q1.md', 'q2.md', 'q10.md']);
  assert.equal(qaReaddirs, 1);

  // Second read hits qa/ directory stamp (0 readdirSync calls).
  const second = cache.readQa(dir);
  assert.deepEqual(second.openIds, ['q1', 'q2', 'q10']);
  assert.equal(qaReaddirs, 1);

  // Answering q1 updates qa/ directory stamp and is visible without manual invalidation.
  fs.writeFileSync(join(qaDir, 'q1.answer.md'), 'Answer 1');
  const third = cache.readQa(id);
  assert.deepEqual(third.openIds, ['q2', 'q10']);
  assert.deepEqual(third.allQuestionFiles, ['q1.md', 'q2.md', 'q10.md']);
  assert.equal(qaReaddirs, 2);

  // Explicit invalidateQa forces a readdirSync on the next read.
  cache.invalidateQa(id);
  const fourth = cache.readQa(id);
  assert.deepEqual(fourth.openIds, ['q2', 'q10']);
  assert.equal(qaReaddirs, 3);

  // Non-directory qa/ (file or symlink) evicts cache and throws ENOTDIR.
  fs.rmSync(qaDir, { recursive: true, force: true });
  fs.writeFileSync(qaDir, 'not a directory');
  assert.throws(() => cache.readQa(id), { code: 'ENOTDIR' });
  assert.equal(cache.stats().qaEntries, 0);

  fs.unlinkSync(qaDir);
  const targetDir = join(dir, 'real-qa');
  fs.mkdirSync(targetDir);
  fs.symlinkSync(targetDir, qaDir);
  assert.throws(() => cache.readQa(id), { code: 'ENOTDIR' });
});

test('S1.5 deleted directory reclamation via listJobIds and bounded LRU eviction for files and qa', (t) => {
  const home = tempHome(t);
  const cache = new JobIndexCache(home);

  for (let i = 1; i <= 60; i++) {
    seedJob(home, jobId(i), { qa: { 'q1.md': 'Synthetic question' } });
  }

  let rootReaddirs = 0;
  spyFs(t, 'readdirSync', (orig, target, ...args) => {
    if (String(target) === join(home, 'jobs')) rootReaddirs++;
    return orig(target, ...args);
  });

  const ids = cache.listJobIds();
  assert.equal(ids.length, 60);
  assert.equal(rootReaddirs, 1);
  // Second listJobIds hits jobsRoot dir stamp.
  assert.equal(cache.listJobIds().length, 60);
  assert.equal(rootReaddirs, 1);

  for (const id of ids) {
    assert.equal(cache.readJob(id).status, 'ok');
    assert.equal(cache.readStatus(id).status, 'ok');
    assert.deepEqual(cache.readQa(id).openIds, ['q1']);
  }
  assert.deepEqual(cache.stats(), { fileEntries: 120, qaEntries: 60 });

  // Delete 20 directories and re-list: dead job file and qa entries are reclaimed immediately.
  for (let i = 1; i <= 20; i++) {
    fs.rmSync(join(home, 'jobs', jobId(i)), { recursive: true, force: true });
  }
  const remaining = cache.listJobIds();
  assert.equal(remaining.length, 40);
  assert.equal(rootReaddirs, 2);
  assert.deepEqual(cache.stats(), { fileEntries: 80, qaEntries: 40 });

  // evictJob clears one specific job and forces list refresh.
  cache.evictJob(jobId(21));
  assert.deepEqual(cache.stats(), { fileEntries: 78, qaEntries: 39 });

  // Bounded LRU verification: hot entries stay cached while cold entries are evicted.
  const boundedHome = tempHome(t, 'job-index-lru-');
  const lru = new JobIndexCache(boundedHome, { maxFileEntries: 16, maxQaEntries: 8 });
  for (let i = 1; i <= 40; i++) {
    seedJob(boundedHome, jobId(i), { qa: { 'q1.md': 'Q' } });
  }

  // Prime first 16 job.json entries and 8 qa entries, then keep job 1 hot while inserting 17..40.
  for (let i = 1; i <= 40; i++) {
    assert.equal(lru.readJob(jobId(i)).status, 'ok');
    assert.equal(lru.readQa(jobId(i)).exists, true);
    // Keep jobId(1) hot on every iteration.
    assert.equal(lru.readJob(jobId(1)).status, 'ok');
    assert.equal(lru.readQa(jobId(1)).exists, true);
    assert.ok(lru.stats().fileEntries <= 16, `fileEntries=${lru.stats().fileEntries}`);
    assert.ok(lru.stats().qaEntries <= 8, `qaEntries=${lru.stats().qaEntries}`);
  }
  assert.equal(lru.readJob(jobId(1)).hit, true, 'hot file entry stayed in LRU');
  assert.equal(lru.readJob(jobId(2)).hit, false, 'cold file entry was evicted');

  // listJobDirsByMtime respects limit, descending mtime order, and skips symlinks.
  const orderHome = tempHome(t, 'job-index-order-');
  for (let i = 1; i <= 5; i++) {
    const dir = seedJob(orderHome, jobId(i));
    fs.utimesSync(dir, 1_700_000_000 + i * 10, 1_700_000_000 + i * 10);
  }
  fs.symlinkSync(join(orderHome, 'jobs', jobId(1)), join(orderHome, 'jobs', jobId(99)));
  const orderCache = new JobIndexCache(orderHome);
  const listed = orderCache.listJobDirsByMtime({ limit: 3 });
  assert.equal(listed.totalValid, 5);
  assert.deepEqual(
    listed.dirs.map((d) => d.id),
    [jobId(5), jobId(4), jobId(3)]
  );
  const byBirth = orderCache.listJobDirsByMtime({ sortBy: 'birthtime', limit: 2 });
  assert.equal(byBirth.totalValid, 5);
  assert.equal(byBirth.dirs.length, 2);

  // invalidateFile, invalidateJob, clear, and non-directory jobsRoot onError callback.
  orderCache.readJob(jobId(1));
  orderCache.readStatus(jobId(1));
  assert.equal(orderCache.stats().fileEntries, 2);
  orderCache.invalidateFile(join(orderHome, 'jobs', jobId(1), 'STATUS.json'));
  assert.equal(orderCache.stats().fileEntries, 1);
  orderCache.invalidateJob(jobId(1));
  assert.equal(orderCache.stats().fileEntries, 0);
  orderCache.readJob(jobId(2));
  orderCache.clear();
  assert.deepEqual(orderCache.stats(), { fileEntries: 0, qaEntries: 0 });

  const badRootHome = tempHome(t, 'job-index-badroot-');
  fs.writeFileSync(join(badRootHome, 'jobs'), 'not-a-dir');
  let dirErr = null;
  const badRootCache = new JobIndexCache(badRootHome);
  assert.deepEqual(
    badRootCache.listJobIds({
      onError(err) {
        dirErr = err;
      },
    }),
    []
  );
  assert.equal(dirErr?.code, 'ENOTDIR');
});

test('S1.6 per-HUD_HOME isolation and global registry LRU bound (MAX_CACHED_HOMES = 8)', (t) => {
  t.after(() => clearJobIndexCaches());
  clearJobIndexCaches();

  const homeA = tempHome(t, 'job-index-homeA-');
  const homeB = tempHome(t, 'job-index-homeB-');
  const sharedId = jobId(1);
  seedJob(homeA, sharedId, { job: { role: 'imp-a' }, status: { state: 'working' } });
  seedJob(homeB, sharedId, { job: { role: 'rev-b' }, status: { state: 'closed' } });

  const cacheA = getJobIndexCache(homeA);
  const cacheB = getJobIndexCache(homeB);
  assert.notEqual(cacheA, cacheB);
  assert.equal(getJobIndexCache(`${homeA}/`), cacheA, 'normalized paths share one instance');

  assert.equal(cacheA.readJob(sharedId).value.role, 'imp-a');
  assert.equal(cacheA.readStatus(sharedId).value.state, 'working');
  assert.equal(cacheB.readJob(sharedId).value.role, 'rev-b');
  assert.equal(cacheB.readStatus(sharedId).value.state, 'closed');

  // Alternating homes never cross-talk or clear each other's cache.
  const aAgain = getJobIndexCache(homeA).readJob(sharedId);
  const bAgain = getJobIndexCache(homeB).readJob(sharedId);
  assert.equal(aAgain.hit, true);
  assert.equal(aAgain.value.role, 'imp-a');
  assert.equal(bAgain.hit, true);
  assert.equal(bAgain.value.role, 'rev-b');

  // Creating 12 homes enforces MAX_CACHED_HOMES = 8 with LRU eviction.
  clearJobIndexCaches();
  const homes = Array.from({ length: 12 }, (_, i) => tempHome(t, `job-index-reg-${i}-`));
  const firstInstances = [];
  for (let i = 0; i < MAX_CACHED_HOMES; i++) {
    firstInstances.push(getJobIndexCache(homes[i]));
  }
  // Touch homes[0] so homes[1] becomes the least-recently-used entry.
  assert.equal(getJobIndexCache(homes[0]), firstInstances[0]);
  for (let i = MAX_CACHED_HOMES; i < homes.length; i++) {
    getJobIndexCache(homes[i]);
  }
  assert.equal(getJobIndexCache(homes[0]), firstInstances[0], 'touched home remains in registry');
  assert.notEqual(getJobIndexCache(homes[1]), firstInstances[1], 'cold home was evicted beyond MAX_CACHED_HOMES');
});

test('S1.7 freezeCachedValues mutation guard, readJobMutable isolation, projection full|facts, and exportFacts whitelist', (t) => {
  const home = tempHome(t);
  const id = jobId(7);
  const dir = seedJob(home, id, {
    job: {
      role: 'imp',
      cwd: '/synthetic/project',
      worktree: { main_root: '/synthetic/main' },
      cli: { agent: 'codex' },
      send_outcomes: [{ attempt: 1, ok: true }],
    },
    status: { state: 'working', harness: 'cli' },
  });
  const jobFile = join(dir, 'job.json');
  const jobSt = fs.lstatSync(jobFile, { bigint: true });

  const cache = new JobIndexCache(home, { freezeCachedValues: true });
  const factKeys = new Set(['job', 'role', 'herdr_pane', 'state', 'project_root']);

  // Hydrate pruned facts projection (lacks cwd, worktree, cli, send_outcomes).
  cache.hydrateFacts([
    {
      rel: `${id}/job.json`,
      stamp: fileStampOf(jobSt),
      at: statsMtimeMs(jobSt.mtimeNs),
      whole: true,
      json: { job: id, role: 'imp', herdr_pane: 'w1:p1' },
    },
  ]);

  let opens = 0;
  spyFs(t, 'openSync', (orig, file, ...args) => {
    if (String(file) === jobFile) opens++;
    return orig(file, ...args);
  });

  // acceptFacts: true hits hydrated entry with 0 disk reads.
  const factsHit = cache.readJob(id, { acceptFacts: true });
  assert.equal(factsHit.status, 'ok');
  assert.equal(factsHit.hit, true);
  assert.equal(factsHit.projection, 'facts');
  assert.equal(factsHit.value.cwd, undefined);
  assert.equal(opens, 0);

  // Default readJob (acceptFacts: false) misses facts, loads full job.json from disk, and upgrades projection.
  const fullLoad = cache.readJob(id);
  assert.equal(fullLoad.status, 'ok');
  assert.equal(fullLoad.hit, false);
  assert.equal(fullLoad.projection, 'full');
  assert.equal(fullLoad.value.cwd, '/synthetic/project');
  assert.deepEqual(fullLoad.value.cli, { agent: 'codex' });
  assert.equal(opens, 1);

  // Subsequent hydrateFacts must not overwrite an existing full entry.
  cache.hydrateFacts([
    {
      rel: `${id}/job.json`,
      stamp: fileStampOf(jobSt),
      at: statsMtimeMs(jobSt.mtimeNs),
      whole: true,
      json: { job: id, role: 'imp' },
    },
  ]);
  const stillFull = cache.readJob(id);
  assert.equal(stillFull.hit, true);
  assert.equal(stillFull.projection, 'full');
  assert.equal(stillFull.value.cwd, '/synthetic/project');

  // freezeCachedValues prevents accidental in-place mutation of cached references.
  assert.throws(() => {
    stillFull.value.role = 'mutated';
  }, TypeError);
  assert.throws(() => {
    stillFull.value.send_outcomes.push({ attempt: 2, ok: false });
  }, TypeError);

  // readJobMutable returns an independent unfrozen clone; mutating it never affects the cache.
  const mutable = cache.readJobMutable(id);
  assert.equal(mutable.status, 'ok');
  mutable.value.send_outcomes.push({ attempt: 2, ok: false });
  mutable.value.read_at = '2030-01-02T00:00:00Z';
  const cachedAfter = cache.readJob(id);
  assert.equal(cachedAfter.value.send_outcomes.length, 1);
  assert.equal(cachedAfter.value.read_at, undefined);

  // exportFacts enforces the factKeys whitelist and skips jobs with checks.
  const idWithChecks = jobId(8);
  seedJob(home, idWithChecks, { job: { checks: ['npm test'] } });
  cache.readJob(idWithChecks);
  cache.readStatus(id);

  const exported = cache.exportFacts(
    new Set([jobFile, join(dir, 'STATUS.json'), join(home, 'jobs', idWithChecks, 'job.json')]),
    factKeys,
    { factsVersion: 3 }
  );
  const byRel = new Map(exported.map(([rel, stamp, snap]) => [rel, { stamp, snap }]));
  assert.equal(byRel.has(`${idWithChecks}/job.json`), false, 'entries with checks are omitted');
  assert.equal(byRel.get(`${id}/job.json`).snap.factsVersion, 3);
  assert.deepEqual(byRel.get(`${id}/job.json`).snap.json, {
    job: id,
    role: 'imp',
    herdr_pane: 'w1:p1',
    project_root: '/synthetic/main',
  });
  assert.deepEqual(byRel.get(`${id}/STATUS.json`).snap.json, { state: 'working' });
});

test('S1.8 symlinks, oversized/corrupt negative caches, bit-exact report mtime, session/pid, and dual-format stamp compatibility', (t) => {
  const home = tempHome(t);
  const cache = new JobIndexCache(home);

  // 1) Symlinked job.json and report.md are refused and never cached.
  const symId = jobId(10);
  const symDir = join(home, 'jobs', symId);
  fs.mkdirSync(symDir, { recursive: true });
  const external = join(home, 'outside.json');
  fs.writeFileSync(external, JSON.stringify({ job: symId, role: 'imp' }));
  fs.symlinkSync(external, join(symDir, 'job.json'));
  fs.symlinkSync(external, join(symDir, 'report.md'));

  assert.equal(cache.readJob(symId).status, 'error');
  assert.equal(cache.stats().fileEntries, 0);
  assert.deepEqual(cache.readReportStat(symId), { present: false, mtimeMs: null, stamp: null });

  // 2) Oversized (>64 KiB) JSON returns truncated and negative-caches (0 openSync on second read).
  const bigId = jobId(11);
  const bigDir = join(home, 'jobs', bigId);
  fs.mkdirSync(bigDir, { recursive: true });
  const bigFile = join(bigDir, 'job.json');
  fs.writeFileSync(bigFile, JSON.stringify({ job: bigId, pad: 'x'.repeat(DEFAULT_MAX_JSON_BYTES + 128) }));

  // 3) Corrupt JSON returns invalid and negative-caches (0 openSync on second read).
  const badId = jobId(12);
  const badDir = join(home, 'jobs', badId);
  fs.mkdirSync(badDir, { recursive: true });
  const badFile = join(badDir, 'job.json');
  fs.writeFileSync(badFile, '{broken-json');

  const openCounts = new Map();
  spyFs(t, 'openSync', (orig, file, ...args) => {
    const key = String(file);
    openCounts.set(key, (openCounts.get(key) ?? 0) + 1);
    return orig(file, ...args);
  });

  assert.equal(cache.readJob(bigId).status, 'truncated');
  assert.equal(openCounts.get(bigFile), 1);
  assert.equal(cache.readJob(bigId).status, 'truncated');
  assert.equal(openCounts.get(bigFile), 1, 'truncated negative cache skips openSync');

  assert.equal(cache.readJob(badId).status, 'invalid');
  assert.equal(openCounts.get(badFile), 1);
  assert.equal(cache.readJob(badId).status, 'invalid');
  assert.equal(openCounts.get(badFile), 1, 'invalid negative cache skips openSync');

  // 4) report.md mtimeMs is bit-for-bit === fs.statSync(reportPath).mtimeMs.
  const repId = jobId(13);
  const repDir = seedJob(home, repId, {
    report: '# Synthetic report\nDone.\n',
    session: `TASK=${repId}\nTAB=t1\nTAB_NAME=imp slice 1\nLEFT=p1\nRIGHT=p2\nORCH=p0\nBASE=abc123\nPRIMARY=${repId}-primary\n`,
  });
  const reportPath = join(repDir, 'report.md');
  const repStat = cache.readReportStat(repId);
  assert.equal(repStat.present, true);
  assert.strictEqual(repStat.mtimeMs, fs.statSync(reportPath).mtimeMs);
  assert.ok(typeof repStat.stamp === 'string' && repStat.stamp.split(':').length === 5);

  // 5) readSession and readPid cache by stamp and refuse oversized SESSION.txt.
  const sessFile = join(repDir, 'SESSION.txt');
  const s1 = cache.readSession(repId);
  assert.deepEqual(s1?.fields, {
    task: repId,
    tab: 't1',
    tabName: 'imp slice 1',
    left: 'p1',
    right: 'p2',
    orch: 'p0',
    base: 'abc123',
    primary: `${repId}-primary`,
  });
  assert.equal(openCounts.get(sessFile), 1);
  assert.deepEqual(cache.readSession(repId)?.fields, s1.fields);
  assert.equal(openCounts.get(sessFile), 1);

  fs.writeFileSync(sessFile, `PRIMARY=${'x'.repeat(DEFAULT_MAX_SESSION_BYTES + 64)}\n`);
  assert.equal(cache.readSession(repId), null);

  const pidFile = join(repDir, 'supervisor.pid');
  fs.writeFileSync(pidFile, '42424\n');
  assert.equal(cache.readPid(pidFile), 42424);
  assert.equal(openCounts.get(pidFile), 1);
  assert.equal(cache.readPid(pidFile), 42424);
  assert.equal(openCounts.get(pidFile), 1);
  fs.writeFileSync(pidFile, 'not-a-pid\n');
  assert.equal(cache.readPid(pidFile), null);

  // 6) Dual-format stamp compatibility: isFileStampCurrent & hydrateFacts legacy stamp read.
  const jobPath = join(repDir, 'job.json');
  const normalSt = fs.lstatSync(jobPath);
  const bigSt = fs.lstatSync(jobPath, { bigint: true });
  const newStamp = fileStampOf(bigSt);
  const legacyStamp = `${normalSt.mtimeMs}:${normalSt.size}:${normalSt.ino}`;
  assert.equal(legacyStamp, legacyFileStampOf(bigSt));

  assert.equal(isFileStampCurrent(jobPath, newStamp), true);
  assert.equal(isFileStampCurrent(jobPath, legacyStamp), true);

  // Hydrating a legacy 3-field stamp hits with acceptFacts: true (0 openSync) and upgrades in memory to 5-field stamp.
  const dualCache = new JobIndexCache(home);
  dualCache.hydrateFacts([
    {
      rel: `${repId}/job.json`,
      stamp: legacyStamp,
      at: normalSt.mtimeMs,
      whole: true,
      json: { job: repId, role: 'imp' },
    },
  ]);
  const beforeOpens = openCounts.get(jobPath) ?? 0;
  const dualHit = dualCache.readJob(repId, { acceptFacts: true });
  assert.equal(dualHit.status, 'ok');
  assert.equal(dualHit.hit, true);
  assert.equal(dualHit.stamp, newStamp, 'legacy stamp upgraded to 5-field BigInt stamp on hit');
  assert.equal(openCounts.get(jobPath) ?? 0, beforeOpens, 'legacy stamp hit did not re-open file');

  // Modifying the file invalidates both new and legacy stamps.
  writePrivateFile(jobPath, JSON.stringify({ job: repId, role: 'imp', updated: true }) + '\n', { mkdir: false });
  assert.equal(isFileStampCurrent(jobPath, newStamp), false);
  assert.equal(isFileStampCurrent(jobPath, legacyStamp), false);

  const afterModify = dualCache.readJob(repId, { acceptFacts: true });
  assert.equal(afterModify.status, 'ok');
  assert.equal(afterModify.hit, false);
  assert.equal(afterModify.value.updated, true);

  // Invalid job IDs return missing/null without throwing.
  assert.equal(cache.readJob('../escape').status, 'missing');
  assert.equal(cache.readStatus('not-a-job').status, 'missing');
  assert.equal(cache.readSession('../escape'), null);
});
