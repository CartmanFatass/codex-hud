import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { main as hudMain } from '../../dist/cli/hud.js';
import { reportSignature } from '../../dist/roles/cli-turn.js';
import {
  archiveJobCold,
  coldRawCapBytes,
  enforceColdRawCap,
  extractColdArchive,
  listColdArchive,
  mergeColdMember,
  readColdJobText,
} from '../../dist/roles/cold-archive.js';
import { writeReportMeta } from '../../dist/roles/report-meta.js';
import { pruneJobLogs, pruneLandFlows } from '../../dist/runtime/work-retention.js';
import { decodeTarZst, encodeTarZst } from '../../dist/utils/tar-zst.js';
import { fixture as retentionFixture, hour, until } from '../helpers/job-retention-fixture.mjs';
import { cleanupFixture } from '../helpers/process-cleanup.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { fixture as mcpFixture } from '../helpers/thin-mcp-harness.mjs';

const day = 24 * hour;
const put = (file, body) => {
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
};
const exists = (p) => Boolean(fs.lstatSync(p, { throwIfNoEntry: false }));
const modeOf = (p) => fs.lstatSync(p).mode & 0o777;

async function runCli(args, env) {
  let out = '';
  let err = '';
  const code = await hudMain(['archive', ...args], {
    env,
    stdout: (text) => { out += text; },
    stderr: (text) => { err += text; },
  });
  return { code, out, err };
}

test('tar-zst round-trips binary, UTF-8, empty and long-path entries byte-identically and rejects unsafe paths', () => {
  const longName = `flows/${'segment-'.repeat(18)}gate-1.log`;
  const utf8Name = 'qa/问题-1.md';
  const bin = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const entries = [
    { name: 'empty.txt', data: Buffer.alloc(0), mode: 0o600, mtime: 1700000000 },
    { name: 'binary.dat', data: bin, mode: 0o600, mtime: 1700000001 },
    { name: longName, data: Buffer.from('Synthetic long path content.\n'), mode: 0o600, mtime: 1700000002 },
    { name: utf8Name, data: Buffer.from('Synthetic UTF-8 问题 body.\n'), mode: 0o600, mtime: 1700000003 },
  ];
  const compressed = encodeTarZst(entries);
  const decoded = decodeTarZst(compressed);
  assert.equal(decoded.length, entries.length);
  for (let i = 0; i < entries.length; i++) {
    assert.equal(decoded[i].name, entries[i].name);
    assert.ok(decoded[i].data.equals(entries[i].data), `byte mismatch for ${entries[i].name}`);
    assert.equal(decoded[i].mtime, entries[i].mtime);
  }
  for (const bad of ['../escape', '/abs/path', 'a/../b', 'a\\b', 'a\0b', '']) {
    assert.throws(() => encodeTarZst([{ name: bad, data: Buffer.from('x') }]));
  }
  assert.throws(() => encodeTarZst([
    { name: 'dup.txt', data: Buffer.from('a') },
    { name: 'dup.txt', data: Buffer.from('b') },
  ]));
});

test('pruned clean job leaves private text and raw members with byte-identical round-trip extraction via hud archive', async (t) => {
  const f = retentionFixture(t);
  const ended = '2030-01-02T12:00:00.000Z';
  const now = Date.parse(ended) + 25 * hour;
  const dir = f.job(
    { state: 'closed', ended_at: ended, output_written: true },
    { role: 'imp', cli: { agent: 'claude' }, resume_s: 3600, reaped_at: ended, project_root: '/synthetic/proj' },
  );
  const id = basename(dir);
  const hex = id.slice(1);

  const briefBytes = Buffer.from('# Synthetic brief\n\nPreserve everything.\n');
  const reportBytes = Buffer.from('# Synthetic report\n\nVerdict: pass\nBlockers: none\n\nDetails: 合成数据.\n');
  const usageBytes = Buffer.from(JSON.stringify({ key: ended, usage: { input: 10, output: 20, cost_usd: 0.01 } }) + '\n');
  const qaQBytes = Buffer.from('Question: synthetic choice?\nDefault if unanswered: keep\n');
  const qaABytes = Buffer.from('keep\n');
  const treeBytes = Buffer.from(JSON.stringify({ root: 1234, children: [] }) + '\n');
  const stdoutBytes = Buffer.from('{"type":"init","session_id":"synthetic"}\n{"type":"result","ok":true}\n');
  const stderrBytes = Buffer.from('synthetic stderr line\n');
  const sessionCopyBytes = Buffer.from('{"type":"session","id":"synthetic-copy"}\n');

  put(join(dir, 'brief.md'), briefBytes);
  put(join(dir, 'report.md'), reportBytes);
  put(join(dir, 'usage.json'), usageBytes);
  put(join(dir, 'qa', 'q1.md'), qaQBytes);
  put(join(dir, 'qa', 'q1.answer.md'), qaABytes);
  put(join(dir, 'worker-tree.json'), treeBytes);
  put(join(dir, 'stdout.jsonl'), stdoutBytes);
  put(join(dir, 'stderr.log'), stderrBytes);
  put(join(dir, 'sessions', 'copy.jsonl'), sessionCopyBytes);
  writeReportMeta(dir, reportSignature(dir), { summary: 'Synthetic clean summary.', files: ['src/example.ts'] });

  const jobJsonBytes = fs.readFileSync(join(dir, 'job.json'));
  const statusJsonBytes = fs.readFileSync(join(dir, 'STATUS.json'));
  const reportMetaBytes = fs.readFileSync(join(dir, 'report-meta.json'));

  const flowJsonBytes = Buffer.from(JSON.stringify({ flow: `f${hex}`, job: id, state: 'completed', landed_at: ended, updated_at: ended }));
  const gateLogBytes = Buffer.from('gate[1]: synthetic build passed\n');
  const graphBytes = Buffer.from(JSON.stringify({ nodes: ['cherry-pick', 'gate'] }));
  const oldSec = Date.parse(ended) / 1000;
  for (const [rel, body] of [
    [`f${hex}.json`, flowJsonBytes],
    [`f${hex}.json.gate-1.log`, gateLogBytes],
    [`f${hex}/graph.json`, graphBytes],
  ]) {
    const file = put(join(f.home, 'flows', rel), body);
    fs.utimesSync(file, oldSec, oldSec);
  }
  fs.utimesSync(join(f.home, 'flows', `f${hex}`), oldSec, oldSec);

  const run = f.start(`Date.now = () => ${now};`);
  await run.exited;
  assert.equal(run.child.exitCode, 0, run.stderr());

  assert.equal(exists(dir), false, 'live job directory removed');
  assert.deepEqual(fs.readdirSync(join(f.home, 'flows')), [], 'expired flow files removed');

  const archiveDir = join(f.home, 'archive');
  const coldDir = join(archiveDir, 'cold');
  const monthDir = join(coldDir, '2030-01');
  const textMember = join(monthDir, `${id}.text.tar.zst`);
  const rawMember = join(monthDir, `${id}.raw.tar.zst`);
  assert.equal(modeOf(archiveDir), 0o700);
  assert.equal(modeOf(coldDir), 0o700);
  assert.equal(modeOf(monthDir), 0o700);
  assert.equal(modeOf(textMember), 0o600);
  assert.equal(modeOf(rawMember), 0o600);

  fs.chmodSync(f.home, 0o700);
  const list = await runCli(['list', '--json'], { ...process.env, HUD_HOME: f.home });
  assert.equal(list.code, 0, list.err);
  const parsedList = JSON.parse(list.out);
  assert.equal(parsedList.items.length, 1);
  assert.equal(parsedList.items[0].id, id);
  assert.equal(parsedList.items[0].month, '2030-01');
  assert.ok(parsedList.items[0].text.size > 0);
  assert.ok(parsedList.items[0].raw.size > 0);

  const outDir = join(f.home, 'extracted');
  const ext = await runCli(['extract', id, '--out', outDir], { ...process.env, HUD_HOME: f.home });
  assert.equal(ext.code, 0, ext.err);
  assert.match(ext.out, /Extracted \d+ files \(text\+raw\)/);

  const expected = [
    ['job.json', jobJsonBytes],
    ['STATUS.json', statusJsonBytes],
    ['usage.json', usageBytes],
    ['brief.md', briefBytes],
    ['report.md', reportBytes],
    ['report-meta.json', reportMetaBytes],
    ['qa/q1.md', qaQBytes],
    ['qa/q1.answer.md', qaABytes],
    ['worker-tree.json', treeBytes],
    [`flows/f${hex}.json`, flowJsonBytes],
    [`flows/f${hex}.json.gate-1.log`, gateLogBytes],
    [`flows/f${hex}/graph.json`, graphBytes],
    ['stdout.jsonl', stdoutBytes],
    ['stderr.log', stderrBytes],
    ['sessions/copy.jsonl', sessionCopyBytes],
  ];
  for (const [rel, bytes] of expected) {
    const file = join(outDir, rel);
    assert.ok(exists(file), `missing extracted ${rel}`);
    assert.equal(modeOf(file), 0o600, `mode 0600 for ${rel}`);
    assert.ok(fs.readFileSync(file).equals(bytes), `byte-identical mismatch for ${rel}`);
  }
  assert.equal(exists(join(outDir, '.archived')), false, '.archived marker is not archived');
});

test('early raw-log pruning moves logs into raw member and later expiry merges remaining raw files without loss', async (t) => {
  const f = retentionFixture(t);
  const ended = '2030-01-04T12:00:00.000Z';
  const endedMs = Date.parse(ended);
  const dir = f.job(
    { state: 'closed', ended_at: ended, output_written: true },
    { role: 'imp', cli: { agent: 'claude' }, resume_s: 60, reaped_at: ended },
  );
  const id = basename(dir);
  const stdoutBytes = Buffer.from('{"type":"assistant","text":"early pruned stdout"}\n');
  const stderrBytes = Buffer.from('early pruned stderr\n');
  const extraSessionBytes = Buffer.from('{"type":"session","id":"later-session"}\n');
  put(join(dir, 'stdout.jsonl'), stdoutBytes);
  put(join(dir, 'stderr.log'), stderrBytes);
  put(join(dir, 'sessions', 'extra.jsonl'), extraSessionBytes);

  // Sweep 1: right after resume_s (60s) -> early raw log move.
  const first = f.start(`Date.now = () => ${endedMs + 60_000};`);
  await first.exited;
  assert.equal(first.child.exitCode, 0, first.stderr());
  assert.equal(exists(join(dir, 'stdout.jsonl')), false);
  assert.equal(exists(join(dir, 'stderr.log')), false);
  assert.ok(exists(join(dir, 'report.md')), 'live job dir still retained before 1 day');

  const rawPath = join(f.home, 'archive', 'cold', '2030-01', `${id}.raw.tar.zst`);
  assert.ok(exists(rawPath), 'early raw member created');
  const earlyEntries = new Map(decodeTarZst(fs.readFileSync(rawPath)).map((e) => [e.name, e.data]));
  assert.ok(earlyEntries.get('stdout.jsonl')?.equals(stdoutBytes));
  assert.ok(earlyEntries.get('stderr.log')?.equals(stderrBytes));

  // Sweep 2: after 1 day -> full job expiry merges remaining session copy while preserving early logs.
  const second = f.start(`Date.now = () => ${endedMs + day + 1};`);
  await second.exited;
  assert.equal(second.child.exitCode, 0, second.stderr());
  assert.equal(exists(dir), false);

  const finalRaw = new Map(decodeTarZst(fs.readFileSync(rawPath)).map((e) => [e.name, e.data]));
  assert.ok(finalRaw.get('stdout.jsonl')?.equals(stdoutBytes), 'early stdout preserved');
  assert.ok(finalRaw.get('stderr.log')?.equals(stderrBytes), 'early stderr preserved');
  assert.ok(finalRaw.get('sessions/extra.jsonl')?.equals(extraSessionBytes), 'remaining session merged');
  assert.ok(exists(join(f.home, 'archive', 'cold', '2030-01', `${id}.text.tar.zst`)));
});

test('terminal ticket queues keep their text member and only unlink after the fact event is confirmed', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-cold-queue-')));
  cleanupFixture(t, { root });
  const home = join(root, 'hud');
  const flows = join(home, 'flows');
  fs.mkdirSync(flows, { recursive: true });

  const flowId = 'q00000000000000a1';
  const updated = '2030-02-10T08:00:00.000Z';
  const oldSec = Date.parse(updated) / 1000;
  const now = Date.parse(updated) + 25 * hour;

  const receiptBytes = Buffer.from(JSON.stringify({
    flow: flowId,
    state: 'completed',
    root: '/synthetic/proj',
    feature: 'cold-archive',
    created_at: '2030-02-10T07:00:00.000Z',
    updated_at: updated,
    tickets: [],
  }));
  const graphBytes = Buffer.from(JSON.stringify({ template: 'ticket-queue' }));
  const noticeBytes = Buffer.from('1\n');
  const sidecarBytes = Buffer.from('noticed\n');

  const receiptFile = put(join(flows, `${flowId}.json`), receiptBytes);
  const graphFile = put(join(flows, flowId, 'graph.json'), graphBytes);
  const endNotice = put(join(flows, flowId, 'end-1.noticed'), noticeBytes);
  const sidecarFile = put(join(flows, `${flowId}.json.noticed`), sidecarBytes);
  const marker = put(join(flows, `${flowId}.json.archived`), '');
  const events = join(home, 'events', '2030-02.jsonl');
  const member = join(home, 'archive', 'cold', '2030-02', `${flowId}.text.tar.zst`);
  for (const p of [receiptFile, graphFile, endNotice, sidecarFile]) fs.utimesSync(p, oldSec, oldSec);

  pruneLandFlows(home, now);
  assert.ok(exists(member), 'an unconfirmed event claim does not block the cold archive');
  assert.ok(exists(receiptFile), 'an unconfirmed event claim prevents unlink');
  assert.ok(!exists(events));

  fs.unlinkSync(marker); // This synthetic claim never attempted an append.
  pruneLandFlows(home, now);
  assert.deepEqual(fs.readFileSync(events, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line).flow), [flowId]);
  assert.equal(exists(receiptFile), false);
  assert.equal(exists(join(flows, flowId)), false);
  assert.equal(exists(sidecarFile), false);

  assert.equal(modeOf(member), 0o600);
  const entries = new Map(decodeTarZst(fs.readFileSync(member)).map((e) => [e.name, e.data]));
  assert.ok(entries.get(`${flowId}.json`)?.equals(receiptBytes));
  assert.ok(entries.get(`${flowId}/graph.json`)?.equals(graphBytes));
  assert.ok(entries.get(`${flowId}/end-1.noticed`)?.equals(noticeBytes));
  assert.ok(entries.get(`${flowId}.json.noticed`)?.equals(sidecarBytes));
  assert.equal(entries.has(`${flowId}.json.archived`), false);
});

test('retention.coldRawCapGB deletes oldest raw members first and never deletes text members', async (t) => {
  const f = retentionFixture(t);
  // Create 3 expired jobs with distinct incompressible raw payloads (~32 KiB each).
  const dates = [
    { id: 'j0000000000000001', ended: '2029-11-15T10:00:00.000Z', month: '2029-11' },
    { id: 'j0000000000000002', ended: '2029-12-01T10:00:00.000Z', month: '2029-12' },
    { id: 'j0000000000000003', ended: '2029-12-20T10:00:00.000Z', month: '2029-12' },
  ];
  for (const item of dates) {
    const dir = f.job(
      { state: 'failed', ended_at: item.ended, exit_reason: 'synthetic' },
      { role: 'imp', cli: { agent: 'claude' }, reaped_at: item.ended },
      false,
      item.id,
    );
    put(join(dir, 'stdout.jsonl'), randomBytes(32 * 1024));
  }
  // Set cap to ~50 KiB (~1.5 raw members -> only the newest 1 raw member fits, oldest 2 dropped).
  const capGB = (50 * 1024) / (1024 ** 3);
  put(join(f.home, 'config.json'), JSON.stringify({ retention: { coldRawCapGB: capGB } }));
  assert.equal(coldRawCapBytes(f.home), 50 * 1024);

  const now = Date.parse('2029-12-25T10:00:00.000Z');
  const run = f.start(`Date.now = () => ${now};`);
  await run.exited;
  assert.equal(run.child.exitCode, 0, run.stderr());

  const cold = join(f.home, 'archive', 'cold');
  // Text members are NEVER deleted.
  for (const item of dates) {
    assert.ok(exists(join(cold, item.month, `${item.id}.text.tar.zst`)), `text member kept for ${item.id}`);
  }
  // Oldest 2 raw members deleted; newest survives.
  assert.equal(exists(join(cold, '2029-11', 'j0000000000000001.raw.tar.zst')), false, 'oldest month raw deleted');
  assert.equal(exists(join(cold, '2029-12', 'j0000000000000002.raw.tar.zst')), false, 'second oldest raw deleted');
  assert.ok(exists(join(cold, '2029-12', 'j0000000000000003.raw.tar.zst')), 'newest raw kept');

  // Even with cap 0, all raw members are dropped and all text members stay.
  const trimmed = enforceColdRawCap(f.home, 0);
  assert.equal(trimmed.deleted.length, 1);
  assert.equal(exists(join(cold, '2029-12', 'j0000000000000003.raw.tar.zst')), false);
  for (const item of dates) {
    assert.ok(exists(join(cold, item.month, `${item.id}.text.tar.zst`)), `text member still kept at cap=0 for ${item.id}`);
  }
});

test('hud_read returns report digest and full paginated pages for a pruned job from the cold archive', async (t) => {
  const f = await mcpFixture(t);
  const id = 'j000000000000beef';
  const dir = join(f.env.HUD_HOME, 'jobs', id);
  const ended = '2030-03-01T10:00:00.000Z';
  fs.mkdirSync(dir, { recursive: true });
  const jobReceipt = {
    job: id,
    role: 'imp',
    cwd: f.root,
    project_root: f.root,
    created_at: '2030-03-01T09:00:00.000Z',
    read_at: '2030-03-01T10:05:00.000Z', // Already read before pruning!
    reaped_at: ended,
    dispatch_exit_code: 0,
    model: 'synthetic/model',
    thinking: 'high',
    place: 'claude synthetic',
    cli: { agent: 'claude' },
  };
  const statusReceipt = { state: 'closed', ended_at: ended, settled_at: ended, output_written: true };
  // Build a multi-page UTF-8 report (> 30 KiB, crossing 24 KiB on multi-byte characters).
  const reportText = [
    '# Cold Archive Report',
    '',
    'Verdict: pass',
    'Blockers: none',
    '',
    '内容块：' + '合成报告内容😀'.repeat(1800),
    '',
    'End of synthetic report.',
  ].join('\n');
  put(join(dir, 'job.json'), JSON.stringify(jobReceipt, null, 2));
  put(join(dir, 'STATUS.json'), JSON.stringify(statusReceipt));
  put(join(dir, 'report.md'), reportText);
  writeReportMeta(dir, reportSignature(dir), { summary: 'Archived synthetic digest summary.', files: ['src/cold.ts'] });

  archiveJobCold(f.env.HUD_HOME, dir, id, jobReceipt, statusReceipt, Date.parse(ended) + 25 * hour);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(exists(dir), false);

  // Default digest read works on pruned (and previously-read) job.
  const digestRes = await f.call('hud_read', { job: id });
  assert.equal(digestRes.job, id);
  assert.equal(digestRes.archived, true);
  assert.equal(digestRes.role, 'imp');
  assert.equal(digestRes.state, 'closed');
  assert.equal(digestRes.report_exists, true);
  assert.equal(digestRes.digest.result, 'Archived synthetic digest summary.');
  assert.equal(digestRes.digest.verdict, 'pass');
  assert.equal(digestRes.digest.blockers, 'none');
  assert.equal(digestRes.digest.report_bytes, Buffer.byteLength(reportText, 'utf8'));

  // Full paginated read reconstructs the exact UTF-8 report across pages.
  const page1 = await f.call('hud_read', { job: id, mode: 'full' });
  assert.equal(page1.archived, true);
  assert.equal(page1.report_truncated, true);
  assert.ok(typeof page1.next_offset === 'number' && page1.next_offset > 0);
  assert.equal(page1.report_bytes, Buffer.byteLength(reportText, 'utf8'));
  assert.equal(page1.report_meta.summary, 'Archived synthetic digest summary.');
  assert.match(page1.report_path, /archive\/cold\/2030-03\/j000000000000beef\.text\.tar\.zst#report\.md$/);

  let combined = page1.report;
  let nextOffset = page1.next_offset;
  let pages = 1;
  while (nextOffset !== undefined) {
    const next = await f.call('hud_read', { job: id, mode: 'full', offset: nextOffset });
    assert.equal(next.archived, true);
    combined += next.report;
    nextOffset = next.next_offset;
    pages++;
    assert.ok(pages < 10, 'pagination must terminate');
  }
  assert.equal(combined, reportText, 'paginated cold report matches original byte-for-byte');
  assert.ok(pages >= 2);

  // Non-existent job still returns job_not_found; list view ignores cold archive.
  const missing = await f.call('hud_read', { job: 'j000000000000dead' });
  assert.deepEqual(missing, { ok: false, code: 'job_not_found' });
  const list = await f.call('hud_read', { view: 'recent' });
  assert.equal(list.jobs.some((row) => row.job === id), false);
});

test('archive write failure keeps source across all prune paths and repeated sweeps never duplicate or truncate', async (t) => {
  const f = retentionFixture(t);
  const ended = '2030-04-01T12:00:00.000Z';
  const endedMs = Date.parse(ended);
  const now = endedMs + 25 * hour;

  // 1) Block archive/cold with a regular file -> job dir, early logs, and flows MUST stay.
  const dir = f.job(
    { state: 'closed', ended_at: ended, output_written: true },
    { role: 'imp', cli: { agent: 'claude' }, resume_s: 60, reaped_at: ended },
  );
  const id = basename(dir);
  const stdoutBytes = Buffer.from('synthetic stdout keep on failure\n');
  const reportBytes = Buffer.from('Synthetic report keep on failure.\n');
  put(join(dir, 'stdout.jsonl'), stdoutBytes);
  put(join(dir, 'report.md'), reportBytes);

  const flowId = 'q00000000000000f1';
  const qFile = put(join(f.home, 'flows', `${flowId}.json`), JSON.stringify({
    flow: flowId, root: '/synthetic/project', feature: 'sample', state: 'completed', created_at: ended, updated_at: ended, tickets: [],
  }));
  fs.utimesSync(qFile, endedMs / 1000, endedMs / 1000);

  const blocker = put(join(f.home, 'archive', 'cold'), 'blocking regular file');

  // Early raw log prune fails safely.
  assert.equal(pruneJobLogs(dir, JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8')), { state: 'closed', ended_at: ended, output_written: true }, endedMs + 60_000, f.home), false);
  assert.ok(exists(join(dir, 'stdout.jsonl')), 'stdout kept when cold archive write fails');

  // Watcher full sweep fails safely on job dir AND queue flow.
  const failedRun = f.start(`Date.now = () => ${now};`);
  await failedRun.exited;
  assert.equal(failedRun.child.exitCode, 0, failedRun.stderr());
  assert.ok(exists(dir), 'job dir kept when cold archive fails');
  assert.ok(exists(join(dir, 'report.md')));
  assert.ok(exists(join(dir, 'stdout.jsonl')));
  assert.ok(exists(qFile), 'queue flow kept when cold archive fails');
  assert.ok(!exists(join(f.home, 'events')), 'queue event waits for the cold archive');
  assert.match(f.log(), /keep j[0-9a-f]{16} cold archive:/);

  // 2) Remove blocker, simulate rmSync EBUSY on first sweep so a second sweep runs against existing archive members.
  fs.unlinkSync(blocker);
  const retryRun = f.start(`
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
Date.now = () => ${now};
const rm = fs.rmSync;
fs.rmSync = (path, options) => {
  if (path === ${JSON.stringify(dir)}) throw Object.assign(Error('synthetic busy'), { code: 'EBUSY' });
  return rm(path, options);
};
syncBuiltinESMExports();`);
  await retryRun.exited;
  assert.equal(retryRun.child.exitCode, 0, retryRun.stderr());
  assert.ok(exists(dir), 'dir still present after EBUSY');
  assert.equal(exists(qFile), false, 'queue flow archived and unlinked once unblocked');

  const textPath = join(f.home, 'archive', 'cold', '2030-04', `${id}.text.tar.zst`);
  const rawPath = join(f.home, 'archive', 'cold', '2030-04', `${id}.raw.tar.zst`);
  const firstTextBytes = fs.readFileSync(textPath);
  const firstRawBytes = fs.readFileSync(rawPath);

  // Second sweep finishes deleting dir; archive members remain byte-identical without duplication or truncation.
  const finalRun = f.start(`Date.now = () => ${now};`);
  await finalRun.exited;
  assert.equal(finalRun.child.exitCode, 0, finalRun.stderr());
  assert.equal(exists(dir), false);
  assert.ok(fs.readFileSync(textPath).equals(firstTextBytes), 'repeated sweep does not duplicate or rewrite text member');
  assert.ok(fs.readFileSync(rawPath).equals(firstRawBytes), 'repeated sweep does not duplicate or rewrite raw member');

  const textEntries = decodeTarZst(fs.readFileSync(textPath));
  assert.equal(new Set(textEntries.map((e) => e.name)).size, textEntries.length, 'no duplicate entry names');
  assert.ok(textEntries.find((e) => e.name === 'report.md')?.data.equals(reportBytes));

  // Direct idempotency check on mergeColdMember.
  const noop = mergeColdMember(f.home, '2030-04', id, 'text', [{ name: 'report.md', data: reportBytes }]);
  assert.equal(noop.written, false);
  assert.ok((await readColdJobText(f.home, id))?.entries.get('report.md')?.equals(reportBytes));
  assert.ok(listColdArchive(f.home).some((item) => item.id === flowId));
  const out = join(f.home, 'verify-extract');
  assert.ok((await extractColdArchive(f.home, id, out, 'text'))?.files.includes('report.md'));
});

test('watcher refresh scans never touch archive/cold and refresh cost is unchanged with 200 cold members', { timeout: 60000 }, async (t) => {
  async function measure(coldCount) {
    const f = retentionFixture(t);
    const open = f.job({ state: 'working' });
    for (let i = 0; i < coldCount; i++) {
      const month = `2029-${String((i % 12) + 1).padStart(2, '0')}`;
      const id = `j${(i + 1).toString(16).padStart(16, '0')}`;
      const dir = join(f.home, 'archive', 'cold', month);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(join(dir, `${id}.text.tar.zst`), 'placeholder', { mode: 0o600 });
      fs.writeFileSync(join(dir, `${id}.raw.tar.zst`), 'placeholder', { mode: 0o600 });
    }
    const probe = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const coldPrefix = process.env.HUD_HOME + '/archive/cold';
let coldOps = 0;
const check = (p) => { if (typeof p === 'string' && p.startsWith(coldPrefix)) coldOps++; };
const readdir = fs.readdirSync, lstat = fs.lstatSync, openSync = fs.openSync;
fs.readdirSync = (p, ...a) => { check(p); return readdir(p, ...a); };
fs.lstatSync = (p, ...a) => { check(p); return lstat(p, ...a); };
fs.openSync = (p, ...a) => { check(p); return openSync(p, ...a); };
process.on('exit', () => {
  fs.writeFileSync(process.env.HUD_HOME + '/cold-ops', String(coldOps));
});
syncBuiltinESMExports();`;
    const { child, exited, stderr } = f.start(probe);
    await until(() => child.exitCode !== null || fs.existsSync(join(f.home, 'watch.pid')), t.signal);
    assert.equal(child.exitCode, null, stderr());

    // Trigger 20 refresh scans by updating STATUS.json on the open job.
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) {
      writeFixtureFile(join(open, 'STATUS.json'), JSON.stringify({ state: 'working', progress: `step ${i}` }));
      await new Promise((r) => setTimeout(r, 5));
    }
    const elapsedMs = performance.now() - t0;
    writeFixtureFile(join(open, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: new Date().toISOString() }));
    await exited;
    assert.equal(child.exitCode, 0, stderr());
    const coldOps = Number(fs.readFileSync(join(f.home, 'cold-ops'), 'utf8'));
    return { coldOps, elapsedMs };
  }

  const empty = await measure(0);
  const populated = await measure(200);
  assert.equal(empty.coldOps, 0, 'zero cold archive syscalls with empty archive');
  assert.equal(populated.coldOps, 0, 'zero cold archive syscalls during watcher refresh with 200 cold entries');
  t.diagnostic(`watcher refresh (20 updates): 0 cold=${empty.elapsedMs.toFixed(1)}ms (0 cold ops), 200 cold=${populated.elapsedMs.toFixed(1)}ms (${populated.coldOps} cold ops)`);
});

function writePatternFile(file, totalBytes, pattern) {
  fs.mkdirSync(dirname(file), { recursive: true });
  const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(pattern.length, 64 * 1024)));
  for (let off = 0; off < chunk.length; off += pattern.length) {
    pattern.copy(chunk, off, 0, Math.min(pattern.length, chunk.length - off));
  }
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    let remaining = totalBytes;
    while (remaining > 0) {
      const slice = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
      fs.writeSync(fd, slice, 0, slice.length);
      hash.update(slice);
      remaining -= slice.length;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function hashFileSync(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(256 * 1024);
    let total = 0;
    while (true) {
      const count = fs.readSync(fd, buf, 0, buf.length, null);
      if (count <= 0) break;
      hash.update(buf.subarray(0, count));
      total += count;
    }
    return { size: total, sha256: hash.digest('hex') };
  } finally {
    fs.closeSync(fd);
  }
}

test('streaming multi-frame encode/merge/extract handles both sides of frame boundary, tar/PAX overhead, and oversized single-frame refusal', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-cold-bounds-')));
  cleanupFixture(t, { root });
  const home = join(root, 'hud');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  const idBelow = 'j000000000000b001';
  const idAbove = 'j000000000000b002';
  const month = '2030-05';
  const frameBytes = 4096;

  // Below frame boundary (raw + text payload + tar header + EOF blocks <= 4096).
  const smallData = Buffer.alloc(2000, 0x61);
  mergeColdMember(home, month, idBelow, 'raw', [{ name: 'stdout.jsonl', data: smallData, mtime: 1700000100 }], Date.parse('2030-05-01T00:00:00.000Z'), { frameBytes });
  mergeColdMember(home, month, idBelow, 'text', [{ name: 'report.md', data: smallData, mtime: 1700000100 }], Date.parse('2030-05-01T00:00:00.000Z'), { frameBytes });

  // Raw and text bytes below 4096, but PAX long-path header + tar headers + EOF blocks cross 4096 into multiple zstd frames.
  const longPath = `sessions/${'nested-'.repeat(18)}copy.jsonl`;
  const longTextPath = `flows/${'nested-'.repeat(18)}gate-1.log`;
  const boundaryData = Buffer.alloc(3072, 0x62);
  mergeColdMember(home, month, idAbove, 'raw', [{ name: longPath, data: boundaryData, mtime: 1700000101 }], Date.parse('2030-05-01T00:00:00.000Z'), { frameBytes });
  mergeColdMember(home, month, idAbove, 'text', [{ name: longTextPath, data: boundaryData, mtime: 1700000101 }], Date.parse('2030-05-01T00:00:00.000Z'), { frameBytes });

  // Idempotent no-op merge on multi-frame archive, then merge an additional file into it.
  const noop = mergeColdMember(home, month, idAbove, 'raw', [{ name: longPath, data: boundaryData, mtime: 1700000101 }], undefined, { frameBytes });
  assert.equal(noop.written, false, 'multi-frame merge is idempotent');
  const extraData = Buffer.alloc(5000, 0x63);
  const merged = mergeColdMember(home, month, idAbove, 'raw', [{ name: 'stderr.log', data: extraData, mtime: 1700000102 }], undefined, { frameBytes });
  assert.equal(merged.written, true);

  const outBelow = join(root, 'out-below');
  const outAbove = join(root, 'out-above');
  await extractColdArchive(home, idBelow, outBelow, 'all');
  await extractColdArchive(home, idAbove, outAbove, 'all');
  assert.ok(fs.readFileSync(join(outBelow, 'stdout.jsonl')).equals(smallData));
  assert.ok(fs.readFileSync(join(outBelow, 'report.md')).equals(smallData));
  assert.ok(fs.readFileSync(join(outAbove, longPath)).equals(boundaryData));
  assert.ok(fs.readFileSync(join(outAbove, longTextPath)).equals(boundaryData));
  assert.ok(fs.readFileSync(join(outAbove, 'stderr.log')).equals(extraData));

  // If an existing single-frame archive exceeds maxSyncFrameBytes, mergeColdMember refuses cleanly without corrupting the member.
  const idLegacy = 'j000000000000b003';
  const legacyPath = join(home, 'archive', 'cold', month, `${idLegacy}.raw.tar.zst`);
  const legacyBytes = encodeTarZst([{ name: 'stdout.jsonl', data: Buffer.alloc(16 * 1024, 0x7a) }]);
  put(legacyPath, legacyBytes);
  assert.throws(
    () => mergeColdMember(home, month, idLegacy, 'raw', [{ name: 'stderr.log', data: Buffer.from('new\n') }], undefined, { maxSyncFrameBytes: 4096 }),
    /maxOutputLength|Cannot create|limit|zstd_frame_too_large/i,
  );
  assert.ok(fs.readFileSync(legacyPath).equals(legacyBytes), 'refused merge leaves existing archive untouched');
});

test('raw member above 512 MiB and text member above 64 MiB (with tar overhead) archive, merge, and round-trip byte-identically; hud_read still finds report.md', { timeout: 60000 }, async (t) => {
  const f = await mcpFixture(t);
  fs.chmodSync(f.env.HUD_HOME, 0o700);
  const id = 'j000000000000c001';
  const hex = id.slice(1);
  const dir = join(f.env.HUD_HOME, 'jobs', id);
  const ended = '2030-06-01T10:00:00.000Z';
  const endedMs = Date.parse(ended);
  fs.mkdirSync(dir, { recursive: true });

  const jobReceipt = {
    job: id,
    role: 'imp',
    cwd: f.root,
    project_root: f.root,
    created_at: '2030-06-01T09:00:00.000Z',
    reaped_at: ended,
    resume_s: 60,
    dispatch_exit_code: 0,
    model: 'synthetic/model',
    thinking: 'high',
    place: 'claude synthetic',
    cli: { agent: 'claude' },
  };
  const statusReceipt = { state: 'closed', ended_at: ended, settled_at: ended, output_written: true };
  const reportText = '# Large Archive Report\n\nVerdict: pass\nBlockers: none\n\nSynthetic report body alongside >64 MiB gate log.\n';

  put(join(dir, 'job.json'), JSON.stringify(jobReceipt, null, 2));
  put(join(dir, 'STATUS.json'), JSON.stringify(statusReceipt));
  put(join(dir, 'report.md'), reportText);
  writeReportMeta(dir, reportSignature(dir), { summary: 'Readable despite oversized sibling entry.', files: ['src/roles/cold-archive.ts'] });

  // 1) Raw member just above the old 512 MiB bound (512 MiB file + tar headers/EOF > 512 MiB).
  const rawSize = 512 * 1024 * 1024;
  const stdoutPath = join(dir, 'stdout.jsonl');
  const expectedRawHash = writePatternFile(stdoutPath, rawSize, Buffer.from('{"type":"synthetic","line":"raw-log-entry-0123456789abcdef"}\n'));

  // Early prune moves the >512 MiB stdout.jsonl into <id>.raw.tar.zst and unlinks live copy.
  assert.equal(pruneJobLogs(dir, jobReceipt, statusReceipt, endedMs + 60_000, f.env.HUD_HOME), true);
  assert.equal(exists(stdoutPath), false, 'live stdout.jsonl unlinked after streaming archive');

  // Add a later raw session copy so full expiry must merge into the existing >512 MiB raw member.
  const sessionCopy = Buffer.from('{"type":"session","note":"merged-after-512mib"}\n');
  put(join(dir, 'sessions', 'extra.jsonl'), sessionCopy);

  // 2) Text member just above the old 64 MiB bound (64 MiB gate log + tar headers/report > 64 MiB).
  const gateSize = 64 * 1024 * 1024;
  const gatePath = join(f.env.HUD_HOME, 'flows', `f${hex}.json.gate-1.log`);
  const expectedGateHash = writePatternFile(gatePath, gateSize, Buffer.from('gate[1]: synthetic verbose test output line 0123456789\n'));

  const res = archiveJobCold(f.env.HUD_HOME, dir, id, jobReceipt, statusReceipt, endedMs + 25 * hour);
  assert.equal(res.wroteText, true);
  assert.equal(res.wroteRaw, true);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.unlinkSync(gatePath);

  // hud_read must still find report.md in the >64 MiB text member (not job_not_found!).
  const digest = await f.call('hud_read', { job: id });
  assert.equal(digest.archived, true);
  assert.equal(digest.job, id);
  assert.equal(digest.report_exists, true);
  assert.equal(digest.digest.result, 'Readable despite oversized sibling entry.');
  assert.equal(digest.digest.verdict, 'pass');

  const full = await f.call('hud_read', { job: id, mode: 'full' });
  assert.equal(full.archived, true);
  assert.equal(full.report, reportText);

  // hud archive extract must round-trip BOTH >64 MiB text and >512 MiB raw members byte-identically.
  const outDir = join(f.root, 'extracted-large');
  const ext = await runCli(['extract', id, '--out', outDir], { ...process.env, HUD_HOME: f.env.HUD_HOME });
  assert.equal(ext.code, 0, ext.err);
  assert.match(ext.out, /Extracted \d+ files \(text\+raw\)/);

  assert.equal(fs.readFileSync(join(outDir, 'report.md'), 'utf8'), reportText);
  assert.ok(fs.readFileSync(join(outDir, 'sessions', 'extra.jsonl')).equals(sessionCopy));
  assert.deepEqual(hashFileSync(join(outDir, 'flows', `f${hex}.json.gate-1.log`)), { size: gateSize, sha256: expectedGateHash });
  assert.deepEqual(hashFileSync(join(outDir, 'stdout.jsonl')), { size: rawSize, sha256: expectedRawHash });
});

test('hud archive extract drops --force, refuses existing paths, and never writes outside --out through symlinked intermediate dirs', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-cold-extract-safe-')));
  cleanupFixture(t, { root });
  const home = join(root, 'hud');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = { ...process.env, HUD_HOME: home };

  // Help text reflects final options and omits --force.
  const help = await runCli(['--help'], env);
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /hud archive extract <id> \[--out DIR\] \[--part all\|text\|raw\] \[--json\]/);
  assert.equal(help.out.includes('--force'), false, 'help text must not advertise --force');

  const id = 'j000000000000d001';
  mergeColdMember(home, '2030-07', id, 'text', [
    { name: 'brief.md', data: Buffer.from('# Brief\n'), mode: 0o600, mtime: 1700000200 },
    { name: 'qa/q1.md', data: Buffer.from('Sensitive question\n'), mode: 0o600, mtime: 1700000201 },
  ]);

  // 1) --force flag is rejected.
  const forceOut = join(root, 'force-out');
  const forceRes = await runCli(['extract', id, '--out', forceOut, '--force'], env);
  assert.notEqual(forceRes.code, 0, '--force must be rejected');
  assert.equal(exists(forceOut), false, 'rejected --force must not create outDir');

  // 2) Existing non-empty directory fails and leaves contents untouched.
  const existingNonEmpty = join(root, 'existing-non-empty');
  put(join(existingNonEmpty, 'keep.txt'), 'original\n');
  const nonEmptyRes = await runCli(['extract', id, '--out', existingNonEmpty], env);
  assert.notEqual(nonEmptyRes.code, 0, 'existing non-empty dir must fail');
  assert.equal(fs.readFileSync(join(existingNonEmpty, 'keep.txt'), 'utf8'), 'original\n');
  assert.equal(exists(join(existingNonEmpty, 'brief.md')), false);

  // 3) Existing empty directory also fails (extract requires a newly created directory).
  const existingEmpty = join(root, 'existing-empty');
  fs.mkdirSync(existingEmpty, { mode: 0o755 });
  const emptyRes = await runCli(['extract', id, '--out', existingEmpty], env);
  assert.notEqual(emptyRes.code, 0, 'existing empty dir must fail');

  // 4) Existing directory containing a symlinked intermediate directory never writes outside --out.
  const outside1 = join(root, 'outside-1');
  fs.mkdirSync(outside1, { mode: 0o700 });
  const preLinked = join(root, 'pre-linked');
  fs.mkdirSync(preLinked, { mode: 0o700 });
  fs.symlinkSync(outside1, join(preLinked, 'qa'));
  const preLinkedRes = await runCli(['extract', id, '--out', preLinked], env);
  assert.notEqual(preLinkedRes.code, 0, 'pre-existing symlinked target tree must fail');
  assert.deepEqual(fs.readdirSync(outside1), [], 'nothing written outside --out');

  // 5) Dangling symlink at --out fails and never creates outside target.
  const outsideDangling = join(root, 'outside-dangling');
  const danglingOut = join(root, 'dangling-out');
  fs.symlinkSync(outsideDangling, danglingOut);
  const danglingRes = await runCli(['extract', id, '--out', danglingOut], env);
  assert.notEqual(danglingRes.code, 0, 'dangling symlink target must fail');
  assert.equal(exists(outsideDangling), false, 'dangling symlink target must not be created');

  // 6) Mid-extraction symlinked intermediate directory (qa -> outside2) is blocked by O_NOFOLLOW and never writes outside --out.
  const outside2 = join(root, 'outside-2');
  fs.mkdirSync(outside2, { mode: 0o700 });
  const raceOut = join(root, 'race-out');
  const origMkdirSync = fs.mkdirSync;
  fs.mkdirSync = (p, opts) => {
    const out = origMkdirSync(p, opts);
    if (p === raceOut) fs.symlinkSync(outside2, join(raceOut, 'qa'));
    return out;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      () => extractColdArchive(home, id, raceOut, 'text'),
      (err) => err && (err.code === 'ELOOP' || err.code === 'ENOTDIR'),
      'symlinked intermediate directory must fail with ELOOP or ENOTDIR',
    );
  } finally {
    fs.mkdirSync = origMkdirSync;
    syncBuiltinESMExports();
  }
  assert.deepEqual(fs.readdirSync(outside2), [], 'mid-extraction symlinked qa/ must never write outside --out');

  // 7) Fresh destination succeeds with private 0700 dirs and 0600 files.
  const cleanOut = join(root, 'clean-out');
  const okRes = await runCli(['extract', id, '--out', cleanOut], env);
  assert.equal(okRes.code, 0, okRes.err);
  assert.equal(modeOf(cleanOut), 0o700);
  assert.equal(modeOf(join(cleanOut, 'qa')), 0o700);
  assert.equal(modeOf(join(cleanOut, 'qa', 'q1.md')), 0o600);
  assert.equal(fs.readFileSync(join(cleanOut, 'qa', 'q1.md'), 'utf8'), 'Sensitive question\n');
});
