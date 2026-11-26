import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { turnToken } from '../../dist/mcp/cli-judge.js';
import { archiveJob } from '../../dist/roles/job-archive.js';
import { extractReviewDeclaration, parseReviewedRange, parseReviewFindings } from '../../dist/roles/report-meta.js';
import { finishReport, workerTools } from '../../dist/worker/tools.js';
import { writeFixtureFile as write } from '../helpers/thin-mcp-files.mjs';
import { fixture, resultValue, runProgress, waitFixtureJob, workerClient } from '../helpers/thin-mcp-harness.mjs';

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const ENDED = '2026-11-24T12:00:00.000Z';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readArchive = (home) =>
  fs.readFileSync(join(home, 'archive', '2026-11.jsonl'), 'utf8').trimEnd().split('\n').map(JSON.parse);

function makeCliJob(f, n, role) {
  const { job, dir, receipt } = waitFixtureJob(f, n, 'working', undefined, f.root);
  const full = { ...receipt, role, cli: { agent: 'agy', can_continue: false, idle_grace_s: 20 } };
  write(join(dir, 'job.json'), JSON.stringify(full, null, 2));
  const turn = { seq: 1, sent_at: receipt.created_at, report_sig: null };
  write(join(dir, 'turn.json'), JSON.stringify(turn));
  return { job, dir, turn, token: turnToken(turn) };
}

function archiveOne(home, dir, id) {
  archiveJob(
    home,
    dir,
    id,
    readJson(join(dir, 'job.json')),
    { state: 'closed', started_at: ENDED, settled_at: ENDED, ended_at: ENDED, output_written: true },
    Date.parse(ENDED),
    (msg) => assert.fail(msg),
  );
  return readArchive(home).find((row) => row.job === id);
}

test('hud_report schema exposes findings and reviewed only for reviewer in both pi and MCP', async (t) => {
  const f = await fixture(t);
  const reviewer = makeCliJob(f, 1, 'reviewer');
  const imp = makeCliJob(f, 2, 'imp');

  const mcpReviewer = (await workerClient(t, f, reviewer.dir).rpc('tools/list')).result.tools.find(({ name }) => name === 'hud_report');
  const mcpImp = (await workerClient(t, f, imp.dir).rpc('tools/list')).result.tools.find(({ name }) => name === 'hud_report');

  assert.equal(mcpImp.inputSchema.properties.findings, undefined);
  assert.equal(mcpImp.inputSchema.properties.reviewed, undefined);

  assert.deepEqual(mcpReviewer.inputSchema.properties.findings.required, ['blocker', 'major', 'minor']);
  assert.equal(mcpReviewer.inputSchema.properties.findings.additionalProperties, false);
  assert.deepEqual(mcpReviewer.inputSchema.properties.reviewed.required, ['base', 'head']);
  assert.equal(mcpReviewer.inputSchema.properties.reviewed.additionalProperties, false);
  assert.ok(mcpReviewer.inputSchema.properties.findings.description.length <= 80);
  assert.ok(mcpReviewer.inputSchema.properties.reviewed.description.length <= 80);
  assert.equal(mcpReviewer.inputSchema.required.includes('findings'), false);
  assert.equal(mcpReviewer.inputSchema.required.includes('reviewed'), false);

  // Verify the pi worker's tool registration uses the same role-gated schema.
  const checkPiSchema = (dir) => {
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { workerTools } from ${JSON.stringify(new URL('../../dist/harness/pi/worker/tools.js', import.meta.url).href)};
      const tools = new Map();
      await workerTools({ on() {}, registerTool(tool) { tools.set(tool.name, tool); } }, process.env.HUD_JOB_DIR, true);
      process.stdout.write(JSON.stringify(tools.get('hud_report').parameters));
    `], { env: { ...f.env, HUD_JOB_DIR: dir }, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  };
  const piReviewer = checkPiSchema(reviewer.dir);
  const piImp = checkPiSchema(imp.dir);
  assert.deepEqual(piReviewer.properties.findings, mcpReviewer.inputSchema.properties.findings);
  assert.deepEqual(piReviewer.properties.reviewed, mcpReviewer.inputSchema.properties.reviewed);
  assert.equal(piImp.properties.findings, undefined);
  assert.equal(piImp.properties.reviewed, undefined);

  // Direct workerTools() without HUD_JOB_DIR omits reviewer-only fields.
  const prev = process.env.HUD_JOB_DIR;
  delete process.env.HUD_JOB_DIR;
  try {
    const fallbackSchema = (await workerTools(false)).find(({ name }) => name === 'hud_report').inputSchema;
    assert.equal(fallbackSchema.properties.findings, undefined);
    assert.equal(fallbackSchema.properties.reviewed, undefined);
  } finally {
    if (prev !== undefined) process.env.HUD_JOB_DIR = prev;
  }
});

test('hud_report records valid reviewer findings and reviewed on job.json and archive, and preserves them across receipt rewrites', async (t) => {
  const f = await fixture(t);

  // 1. Both fields present (non-zero counts).
  const r1 = makeCliJob(f, 1, 'reviewer');
  const findings = { blocker: 1, major: 2, minor: 3 };
  const reviewed = { base: BASE_SHA, head: HEAD_SHA };
  const res1 = resultValue(await workerClient(t, f, r1.dir)('hud_report', {
    text: 'Verdict: changes-required\nSynthetic findings.\n',
    turn: r1.token,
    findings,
    reviewed,
  }));
  assert.deepEqual(res1, { path: join(r1.dir, 'report.md') });
  const job1 = readJson(join(r1.dir, 'job.json'));
  assert.deepEqual(job1.findings, findings);
  assert.deepEqual(job1.reviewed, reviewed);

  // Trigger a job.json rewrite via hud_read (stamps read_at through job-store save()) and ensure both fields survive.
  write(join(r1.dir, 'STATUS.json'), JSON.stringify({ state: 'closed', output_written: true }));
  await f.call('hud_read', { job: r1.job });
  const job1AfterRead = readJson(join(r1.dir, 'job.json'));
  assert.ok(job1AfterRead.read_at);
  assert.deepEqual(job1AfterRead.findings, findings);
  assert.deepEqual(job1AfterRead.reviewed, reviewed);

  const row1 = archiveOne(f.env.HUD_HOME, r1.dir, r1.job);
  assert.deepEqual(row1.findings, findings);
  assert.deepEqual(row1.reviewed, reviewed);

  // 2. Explicit zero counts are kept (accept review).
  const r2 = makeCliJob(f, 2, 'reviewer');
  const zeros = { blocker: 0, major: 0, minor: 0 };
  const res2 = resultValue(await workerClient(t, f, r2.dir)('hud_report', {
    text: 'Verdict: accept\n',
    turn: r2.token,
    findings: zeros,
  }));
  assert.deepEqual(res2, { path: join(r2.dir, 'report.md') });
  const job2 = readJson(join(r2.dir, 'job.json'));
  assert.deepEqual(job2.findings, zeros);
  assert.equal(Object.hasOwn(job2, 'reviewed'), false);
  const row2 = archiveOne(f.env.HUD_HOME, r2.dir, r2.job);
  assert.deepEqual(row2.findings, zeros);
  assert.equal(Object.hasOwn(row2, 'reviewed'), false);

  // 3. Omitted fields leave neither key on job.json nor archive (not zero, not null).
  const r3 = makeCliJob(f, 3, 'reviewer');
  const res3 = resultValue(await workerClient(t, f, r3.dir)('hud_report', {
    text: 'Verdict: accept\n',
    turn: r3.token,
  }));
  assert.deepEqual(res3, { path: join(r3.dir, 'report.md') });
  const job3 = readJson(join(r3.dir, 'job.json'));
  assert.equal(Object.hasOwn(job3, 'findings'), false);
  assert.equal(Object.hasOwn(job3, 'reviewed'), false);
  const row3 = archiveOne(f.env.HUD_HOME, r3.dir, r3.job);
  assert.equal(Object.hasOwn(row3, 'findings'), false);
  assert.equal(Object.hasOwn(row3, 'reviewed'), false);
});

test('invalid findings or reviewed drop only the invalid field with one warn and still publish', async (t) => {
  const f = await fixture(t);

  const invalidFindingsCases = [
    { blocker: -1, major: 0, minor: 0 },
    { blocker: 0, major: 1.5, minor: 0 },
    { blocker: 0, major: 0, minor: '0' },
    { blocker: 0, major: 0 },
    { blocker: 0, major: 0, minor: 0, nit: 1 },
    null,
    [0, 0, 0],
    '0,0,0',
  ];
  for (const bad of invalidFindingsCases) {
    assert.equal(parseReviewFindings(bad), undefined, JSON.stringify(bad));
    const res = extractReviewDeclaration('reviewer', { findings: bad, reviewed: { base: BASE_SHA, head: HEAD_SHA } });
    assert.equal(res.findings, undefined);
    assert.deepEqual(res.reviewed, { base: BASE_SHA, head: HEAD_SHA });
    assert.equal(res.warnings.length, 1);
  }

  const invalidReviewedCases = [
    { base: BASE_SHA.slice(0, 39), head: HEAD_SHA },
    { base: BASE_SHA + 'a', head: HEAD_SHA },
    { base: 'g'.repeat(40), head: HEAD_SHA },
    { base: 'A'.repeat(40), head: HEAD_SHA },
    { base: BASE_SHA },
    { base: BASE_SHA, head: HEAD_SHA, extra: 'x' },
    null,
    `${BASE_SHA}..${HEAD_SHA}`,
  ];
  for (const bad of invalidReviewedCases) {
    assert.equal(parseReviewedRange(bad), undefined, JSON.stringify(bad));
    const res = extractReviewDeclaration('reviewer', { findings: { blocker: 0, major: 1, minor: 0 }, reviewed: bad });
    assert.deepEqual(res.findings, { blocker: 0, major: 1, minor: 0 });
    assert.equal(res.reviewed, undefined);
    assert.equal(res.warnings.length, 1);
  }

  // End-to-end hud_report tool path: invalid findings dropped with one warn, valid reviewed kept, report still publishes.
  const r1 = makeCliJob(f, 10, 'reviewer');
  const warnings = [];
  const origError = console.error;
  console.error = (...args) => warnings.push(args.join(' '));
  t.after(() => { console.error = origError; });

  const out1 = await finishReport(
    { dir: r1.dir, root: join(f.env.HUD_HOME, 'jobs'), job: readJson(join(r1.dir, 'job.json')) },
    r1.token,
    'Verdict: changes-required\n',
    { findings: { blocker: -1, major: 0, minor: 0 }, reviewed: { base: BASE_SHA, head: HEAD_SHA } },
  );
  assert.equal(out1.path, join(r1.dir, 'report.md'));
  assert.equal(out1.warnings?.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /dropped invalid findings/);
  const job1 = readJson(join(r1.dir, 'job.json'));
  assert.equal(Object.hasOwn(job1, 'findings'), false);
  assert.deepEqual(job1.reviewed, { base: BASE_SHA, head: HEAD_SHA });
  const row1 = archiveOne(f.env.HUD_HOME, r1.dir, r1.job);
  assert.equal(Object.hasOwn(row1, 'findings'), false);
  assert.deepEqual(row1.reviewed, { base: BASE_SHA, head: HEAD_SHA });

  // End-to-end hud_report MCP path: valid findings kept, invalid reviewed (short sha) dropped, report still publishes.
  const r2 = makeCliJob(f, 11, 'reviewer');
  const mcpOut = resultValue(await workerClient(t, f, r2.dir)('hud_report', {
    text: 'Verdict: accept\n',
    turn: r2.token,
    findings: { blocker: 0, major: 0, minor: 2 },
    reviewed: { base: 'abc1234', head: HEAD_SHA },
  }));
  assert.equal(mcpOut.path, join(r2.dir, 'report.md'));
  assert.equal(mcpOut.warnings?.length, 1);
  assert.match(mcpOut.warnings[0], /dropped invalid reviewed/);
  const job2 = readJson(join(r2.dir, 'job.json'));
  assert.deepEqual(job2.findings, { blocker: 0, major: 0, minor: 2 });
  assert.equal(Object.hasOwn(job2, 'reviewed'), false);

  // Non-reviewer declaring valid findings + reviewed gets both dropped with warnings and never recorded.
  const imp = makeCliJob(f, 12, 'imp');
  const impOut = resultValue(await workerClient(t, f, imp.dir)('hud_report', {
    text: 'Synthetic imp report.\n',
    turn: imp.token,
    findings: { blocker: 0, major: 0, minor: 0 },
    reviewed: { base: BASE_SHA, head: HEAD_SHA },
  }));
  assert.equal(impOut.path, join(imp.dir, 'report.md'));
  assert.equal(impOut.warnings?.length, 2);
  const impJob = readJson(join(imp.dir, 'job.json'));
  assert.equal(Object.hasOwn(impJob, 'findings'), false);
  assert.equal(Object.hasOwn(impJob, 'reviewed'), false);
  // Even if manually injected on a non-reviewer job.json, archiveJob omits them.
  write(join(imp.dir, 'job.json'), JSON.stringify({ ...impJob, findings: { blocker: 1, major: 0, minor: 0 }, reviewed: { base: BASE_SHA, head: HEAD_SHA } }));
  const impRow = archiveOne(f.env.HUD_HOME, imp.dir, imp.job);
  assert.equal(Object.hasOwn(impRow, 'findings'), false);
  assert.equal(Object.hasOwn(impRow, 'reviewed'), false);
});

test('CLI fallback hud-progress --done supports findings and reviewed for reviewers and enforces validation', async (t) => {
  const f = await fixture(t);

  // 1. Reject --findings / --reviewed without --done.
  const r0 = makeCliJob(f, 20, 'reviewer');
  for (const flag of ['--findings', '--reviewed']) {
    const rejected = runProgress(f, r0.dir, flag, '{}', 'milestone');
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, new RegExp(`${flag} requires --done`));
  }

  // 2. Valid reviewer declaration via fallback.
  const r1 = makeCliJob(f, 21, 'reviewer');
  write(join(r1.dir, 'report.md'), 'Verdict: changes-required\n');
  const findings = { blocker: 0, major: 1, minor: 4 };
  const reviewed = { base: BASE_SHA, head: HEAD_SHA };
  const ok = runProgress(
    f,
    r1.dir,
    '--done',
    '--turn',
    r1.token,
    '--findings',
    JSON.stringify(findings),
    '--reviewed',
    JSON.stringify(reviewed),
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stderr, '');
  const job1 = readJson(join(r1.dir, 'job.json'));
  assert.deepEqual(job1.findings, findings);
  assert.deepEqual(job1.reviewed, reviewed);
  const row1 = archiveOne(f.env.HUD_HOME, r1.dir, r1.job);
  assert.deepEqual(row1.findings, findings);
  assert.deepEqual(row1.reviewed, reviewed);

  // 3. Reviewer fallback without fields leaves keys absent.
  const r2 = makeCliJob(f, 22, 'reviewer');
  write(join(r2.dir, 'report.md'), 'Verdict: accept\n');
  const plain = runProgress(f, r2.dir, '--done', '--turn', r2.token);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stderr, '');
  assert.equal(Object.hasOwn(readJson(join(r2.dir, 'job.json')), 'findings'), false);
  assert.equal(Object.hasOwn(readJson(join(r2.dir, 'job.json')), 'reviewed'), false);
  const row2 = archiveOne(f.env.HUD_HOME, r2.dir, r2.job);
  assert.equal(Object.hasOwn(row2, 'findings'), false);
  assert.equal(Object.hasOwn(row2, 'reviewed'), false);

  // 4. Reviewer fallback with malformed JSON findings + valid reviewed drops only findings with one warn and publishes.
  const r3 = makeCliJob(f, 23, 'reviewer');
  write(join(r3.dir, 'report.md'), 'Verdict: accept\n');
  const partial = runProgress(
    f,
    r3.dir,
    '--done',
    '--turn',
    r3.token,
    '--findings',
    '{not-json',
    '--reviewed',
    JSON.stringify(reviewed),
  );
  assert.equal(partial.status, 0, partial.stderr);
  assert.equal(partial.stderr.trim().split('\n').length, 1);
  assert.match(partial.stderr, /dropped invalid findings/);
  const job3 = readJson(join(r3.dir, 'job.json'));
  assert.equal(Object.hasOwn(job3, 'findings'), false);
  assert.deepEqual(job3.reviewed, reviewed);
  const row3 = archiveOne(f.env.HUD_HOME, r3.dir, r3.job);
  assert.equal(Object.hasOwn(row3, 'findings'), false);
  assert.deepEqual(row3.reviewed, reviewed);

  // 5. Non-reviewer fallback drops both fields with warnings and still publishes.
  const imp = makeCliJob(f, 24, 'imp');
  write(join(imp.dir, 'report.md'), 'Synthetic imp fallback report.\n');
  const nonRev = runProgress(
    f,
    imp.dir,
    '--done',
    '--turn',
    imp.token,
    '--findings',
    JSON.stringify(findings),
    '--reviewed',
    JSON.stringify(reviewed),
  );
  assert.equal(nonRev.status, 0, nonRev.stderr);
  assert.equal(nonRev.stderr.trim().split('\n').length, 2);
  assert.match(nonRev.stderr, /reviewer role only/);
  const impJob = readJson(join(imp.dir, 'job.json'));
  assert.equal(Object.hasOwn(impJob, 'findings'), false);
  assert.equal(Object.hasOwn(impJob, 'reviewed'), false);
});

test('the shared reviewer instructions explain how and when to declare findings and reviewed', () => {
  const body = fs.readFileSync(resolve('packages/hud-mcp/instructions/reviewer.md'), 'utf8');
  assert.match(body, /findings:\s*\{blocker,\s*major,\s*minor\}/);
  assert.match(body, /reviewed:\s*\{base,\s*head\}/);
  assert.match(body, /40-hex/);
  assert.match(body, /never guess/i);
});
