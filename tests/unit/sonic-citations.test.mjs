import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { archiveJob } from '../../dist/roles/job-archive.js';
import {
  checkReportCitations,
  checkSonicReportCitations,
  MAX_CITATION_FAILURES,
  MAX_CITATION_REPORT_BYTES,
  MAX_CITATIONS,
  shouldCheckSonicCitations,
} from '../../dist/roles/sonic-citations.js';
import { git, initRepo } from '../fixtures/managed-worktree.mjs';
import { cliState, fixture, until } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile as write } from '../helpers/thin-mcp-files.mjs';

const workerTools = new URL('../../packages/hud-mcp/bin/worker-tools.mjs', import.meta.url).href;
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function sampleSourceLines() {
  return [
    'export function alpha(a: number, b: number) {', // 1
    '  const   sum  =  a + b;', // 2
    '  return sum;', // 3
    '}', // 4
    '', // 5
    'export function beta() {', // 6
    '  return "beta-value";', // 7
    '}', // 8
    '', // 9
    'export const gamma = 42;', // 10
  ].join('\n') + '\n';
}

test('checkReportCitations verifies path:line, ranges, quotes within +-3 lines, worktree/cwd bounds, and ignores non-citations', (t) => {
  const base = fs.mkdtempSync(join(tmpdir(), 'hud-citations-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cwd = join(base, 'repo');
  const worktree = join(base, 'wt');
  const outside = join(base, 'outside.ts');
  fs.mkdirSync(join(cwd, 'src'), { recursive: true });
  fs.mkdirSync(join(worktree, 'src'), { recursive: true });

  const samplePath = join(cwd, 'src', 'sample.ts');
  const wtFile = join(worktree, 'src', 'extra.ts');
  fs.writeFileSync(samplePath, sampleSourceLines());
  fs.writeFileSync(wtFile, 'export const inWorktree = true;\n');
  fs.writeFileSync(outside, 'export const secret = 1;\n');
  fs.symlinkSync(outside, join(cwd, 'src', 'escape.ts'));

  // Three-citation fixture: one correct, one wrong line, one quote not there.
  const threeReport = [
    '# Findings',
    '- `src/sample.ts:2` computes `const sum = a + b;`',
    '- src/sample.ts:99 claims an out-of-range line',
    '- `src/sample.ts:1` claims `doesNotExistHere()`',
  ].join('\n');
  assert.deepEqual(checkReportCitations(threeReport, { cwd }), {
    total: 3,
    verified: 1,
    failed: [
      { ref: 'src/sample.ts:99', reason: 'line_out_of_range' },
      { ref: 'src/sample.ts:1', reason: 'quote_not_found' },
    ],
  });

  // Edge cases: range, +-3 window boundary, absolute paths, worktree, outside root, symlink escape, missing file.
  const edgeReport = [
    `- ${samplePath}:1-3 — \`const sum = a + b; return sum;\``, // valid absolute + multi-line ws-normalized quote
    '- `src/sample.ts:5`: `const sum = a + b;`', // line 2 is -3 from line 5 -> passes
    '- `src/sample.ts:6`: `const sum = a + b;`', // line 2 is -4 from line 6 -> fails
    `- ${wtFile}:1 — \`inWorktree = true\``, // valid inside worktree
    `- ${outside}:1`, // outside cwd & worktree
    '- ../outside.ts:1', // relative traversal outside root
    '- src/escape.ts:1', // symlink escaping root
    '- src/missing.ts:1', // missing file inside root
    '- src/sample.ts:5-2', // reversed range
    '- Ignore https://example.com:8080/src/sample.ts:1 and 12:30 and total:3 and 127.0.0.1:8080.',
    '```ts',
    '// src/not-a-citation.ts:999 inside a code fence is ignored',
    '```',
  ].join('\n');
  assert.deepEqual(checkReportCitations(edgeReport, { cwd, worktreeRoot: worktree }), {
    total: 9,
    verified: 3,
    failed: [
      { ref: 'src/sample.ts:6', reason: 'quote_not_found' },
      { ref: `${outside}:1`, reason: 'outside_root' },
      { ref: '../outside.ts:1', reason: 'outside_root' },
      { ref: 'src/escape.ts:1', reason: 'outside_root' },
      { ref: 'src/missing.ts:1', reason: 'missing_file' },
      { ref: 'src/sample.ts:5-2', reason: 'invalid_line_range' },
    ],
  });

  // Report with no citations records total: 0.
  assert.deepEqual(checkReportCitations('# Summary\n\nNo file citations; port:3000 at 10:15.\n', { cwd }), {
    total: 0,
    verified: 0,
    failed: [],
  });
});

test('checkReportCitations bounds work to 256 KiB, 200 citations, 20 failures, and finishes within 100 ms', (t) => {
  const base = fs.mkdtempSync(join(tmpdir(), 'hud-citations-perf-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(join(base, 'src'), { recursive: true });
  const lines = Array.from({ length: 500 }, (_, i) => `export const value${i + 1} = ${i + 1};`).join('\n') + '\n';
  fs.writeFileSync(join(base, 'src', 'big.ts'), lines);

  // Citation only past 256 KiB is not checked.
  const onlyAfterCap = 'a'.repeat(MAX_CITATION_REPORT_BYTES + 100) + '\nsrc/big.ts:1\n';
  assert.deepEqual(checkReportCitations(onlyAfterCap, { cwd: base }), { total: 0, verified: 0, failed: [] });

  // 256+ KiB report with 250 citations (180 valid, 70 invalid).
  const rows = [];
  for (let i = 1; i <= 180; i++) rows.push(`- \`src/big.ts:${i}\` defines \`export const value${i} = ${i};\``);
  for (let i = 1; i <= 70; i++) rows.push(`- \`src/big.ts:${900 + i}\` bad line`);
  const padding = 'Synthetic prose filler without citations. '.repeat(6500);
  const bigReport = rows.join('\n') + '\n' + padding;
  assert.ok(Buffer.byteLength(bigReport, 'utf8') > MAX_CITATION_REPORT_BYTES);

  const started = performance.now();
  const result = checkReportCitations(bigReport, { cwd: base });
  const elapsedMs = performance.now() - started;

  assert.equal(result.total, MAX_CITATIONS);
  assert.equal(result.verified, 180);
  assert.equal(result.failed.length, MAX_CITATION_FAILURES);
  assert.ok(result.failed.every((item) => item.reason === 'line_out_of_range'));
  assert.ok(elapsedMs < 100, `expected < 100 ms on >256 KiB report, took ${elapsedMs.toFixed(2)} ms`);
});

test('settled sonic job records citations once on job.json and archive, without model calls', async (t) => {
  const f = await fixture(t);
  fs.mkdirSync(join(f.root, 'src'), { recursive: true });
  write(join(f.root, 'src', 'target.ts'), sampleSourceLines());

  const fixtureReport = [
    '# Sonic report',
    '- `src/target.ts:2` sets `const sum = a + b;`',
    '- src/target.ts:999 wrong line',
    '- `src/target.ts:7` says `missingQuoteText`',
  ].join('\n');

  f.overrideBin('pi', `#!${process.execPath}
import * as fs from 'node:fs';
import { join } from 'node:path';
if (!process.argv.includes('--print')) process.exit(1);
const { callWorkerTool } = await import(${JSON.stringify(workerTools)});
const brief = fs.readFileSync(join(process.env.HUD_JOB_DIR, 'brief.md'), 'utf8');
const text = brief.includes('empty-citations') ? '# Sonic report\\n\\nNo line citations here.\\n' : ${JSON.stringify(fixtureReport)};
await callWorkerTool('hud_report', { text });
`);

  const sonic = await f.call('hud_create', { role: 'sonic', task: 'Check three citations.' });
  await until(() => cliState(sonic.task_dir)?.state === 'closed' && readJson(join(sonic.task_dir, 'job.json')).reaped_at, t.signal);

  const expected = {
    total: 3,
    verified: 1,
    failed: [
      { ref: 'src/target.ts:999', reason: 'line_out_of_range' },
      { ref: 'src/target.ts:7', reason: 'quote_not_found' },
    ],
  };
  assert.deepEqual(readJson(join(sonic.task_dir, 'job.json')).citations, expected);

  // Reading the report stamps read_at without dropping citations.
  await f.call('hud_read', { job: sonic.job });
  assert.deepEqual(readJson(join(sonic.task_dir, 'job.json')).citations, expected);

  // Removing the target file and triggering another watcher scan must NOT re-check the settled report.
  fs.rmSync(join(f.root, 'src', 'target.ts'));
  const second = await f.call('hud_create', { role: 'sonic', task: 'empty-citations' });
  await until(() => cliState(second.task_dir)?.state === 'closed' && readJson(join(second.task_dir, 'job.json')).reaped_at, t.signal);

  assert.deepEqual(readJson(join(sonic.task_dir, 'job.json')).citations, expected);
  assert.deepEqual(readJson(join(second.task_dir, 'job.json')).citations, { total: 0, verified: 0, failed: [] });

  // Archive carries the recorded citations facts verbatim.
  const ended = '2026-11-24T12:00:00.000Z';
  const logs = [];
  archiveJob(f.env.HUD_HOME, sonic.task_dir, sonic.job, readJson(join(sonic.task_dir, 'job.json')), cliState(sonic.task_dir), Date.parse(ended), (m) => logs.push(m));
  archiveJob(f.env.HUD_HOME, second.task_dir, second.job, readJson(join(second.task_dir, 'job.json')), cliState(second.task_dir), Date.parse(ended), (m) => logs.push(m));
  assert.deepEqual(logs, []);
  const archived = fs.readFileSync(join(f.env.HUD_HOME, 'archive', '2026-11.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(archived.find((row) => row.job === sonic.job).citations, expected);
  assert.deepEqual(archived.find((row) => row.job === second.job).citations, { total: 0, verified: 0, failed: [] });
});

function gitInitAndTrack(repo, files) {
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo });
  for (const [rel, body] of Object.entries(files)) {
    const full = join(repo, rel);
    fs.mkdirSync(join(full, '..'), { recursive: true });
    fs.writeFileSync(full, body);
  }
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
}

test('checkReportCitations resolves unique tracked basenames/partial paths, fails ambiguous_path, and resolves repo-root citations when worktree cwd is absent', (t) => {
  const base = fs.mkdtempSync(join(tmpdir(), 'hud-citations-git-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  gitInitAndTrack(repo, {
    'src/deep/unique.ts': sampleSourceLines(),
    'src/a/shared.ts': 'export const side = "a";\n',
    'src/b/shared.ts': 'export const side = "b";\n',
  });
  // Untracked file must NOT be matched via bare basename (tracked files only), though direct path still works.
  fs.mkdirSync(join(repo, 'scratch'), { recursive: true });
  fs.writeFileSync(join(repo, 'scratch', 'untracked.ts'), 'export const temp = 1;\n');

  const report = [
    '- `unique.ts:2` computes `const sum = a + b;`', // unique tracked basename -> verifies
    '- `./unique.ts:6` defines `export function beta()`', // leading ./ unique basename -> verifies
    '- `a/shared.ts:1` sets `side = "a"`', // unique partial path -> verifies
    '- `shared.ts:1` matches two tracked files', // ambiguous tracked basename -> ambiguous_path
    '- `nique.ts:2` is not a path-segment match', // partial filename -> missing_file
    '- `untracked.ts:1` is untracked', // untracked basename -> missing_file
    '- `scratch/untracked.ts:1` sets `temp = 1`', // direct untracked path -> verifies
    '- `../outside.ts:1` escapes root', // lexical escape -> outside_root
  ].join('\n');

  assert.deepEqual(checkReportCitations(report, { cwd: repo }), {
    total: 8,
    verified: 4,
    failed: [
      { ref: 'shared.ts:1', reason: 'ambiguous_path' },
      { ref: 'nique.ts:2', reason: 'missing_file' },
      { ref: 'untracked.ts:1', reason: 'missing_file' },
      { ref: '../outside.ts:1', reason: 'outside_root' },
    ],
  });

  // Prewalk scout whose worktree cwd does not exist yet (or was removed) resolves against project_root.
  const jobDir = join(base, 'job');
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(join(jobDir, 'report.md'), [
    '- `src/deep/unique.ts:2` computes `const sum = a + b;`',
    '- `unique.ts:6` defines `export function beta()`',
    '- `shared.ts:1` ambiguous',
  ].join('\n'));
  const missingWorktree = join(base, 'repo-wt', 'imp-missing');
  assert.deepEqual(
    checkSonicReportCitations(jobDir, {
      role: 'sonic',
      cwd: missingWorktree,
      project_root: repo,
    }),
    {
      total: 3,
      verified: 2,
      failed: [{ ref: 'shared.ts:1', reason: 'ambiguous_path' }],
    },
  );

  // Already-reaped sonic jobs are never checked retroactively.
  assert.equal(shouldCheckSonicCitations({ role: 'sonic', reaped_at: '2026-11-24T00:00:00.000Z' }, { state: 'closed', output_written: true }), false);
  assert.equal(shouldCheckSonicCitations({ role: 'sonic' }, { state: 'closed', output_written: true }), true);
});

test('prewalk scout verifies unique basename and repo-root files at settlement and flags ambiguous_path', async (t) => {
  const f = await fixture(t, { autoPrewalk: true });
  const repo = initRepo(f.root);
  for (const dir of ['src/core', 'src/one', 'src/two']) fs.mkdirSync(join(repo, dir), { recursive: true });
  write(join(repo, 'src', 'core', 'only-one.ts'), sampleSourceLines());
  write(join(repo, 'src', 'one', 'dup.ts'), 'export const kind = "one";\n');
  write(join(repo, 'src', 'two', 'dup.ts'), 'export const kind = "two";\n');
  git(repo, 'add', 'src');
  git(repo, 'commit', '-m', 'add sources');
  // Untracked context file in the repo root (not present in the linked worktree).
  write(join(repo, 'repo-context.md'), 'Synthetic repo-root context line.\n');

  const scoutReport = [
    '# Prewalk findings',
    '- `only-one.ts:2` computes `const sum = a + b;`',
    '- `one/dup.ts:1` sets `kind = "one"`',
    '- `repo-context.md:1` notes `Synthetic repo-root context line.`',
    '- `dup.ts:1` matches two tracked files',
  ].join('\n');

  f.overrideBin('pi', `#!${process.execPath}
import * as fs from 'node:fs';
import { join } from 'node:path';
if (!process.argv.includes('--print')) process.exit(1);
const { callWorkerTool } = await import(${JSON.stringify(workerTools)});
await callWorkerTool('hud_report', { text: ${JSON.stringify(scoutReport)} });
`);

  const target = await f.call('hud_create', {
    role: 'imp',
    cwd: repo,
    task: 'Inspect tracked files and repo-root context.',
    isolation: 'worktree',
    context_files: ['repo-context.md'],
    scouts: [{ kind: 'code', ask: 'Locate unique, duplicate, and context files.' }],
  });

  const jobsDir = join(f.env.HUD_HOME, 'jobs');
  let scoutDir;
  await until(() => {
    if (!fs.existsSync(jobsDir)) return false;
    scoutDir = fs.readdirSync(jobsDir)
      .map((id) => join(jobsDir, id))
      .find((dir) => fs.existsSync(join(dir, 'job.json')) && readJson(join(dir, 'job.json')).parent_job === target.job);
    return Boolean(scoutDir && cliState(scoutDir)?.state === 'closed' && readJson(join(scoutDir, 'job.json')).reaped_at);
  }, t.signal);
  await until(() => readJson(join(target.task_dir, 'job.json')).dispatch_exit_code !== null, t.signal);

  const scoutReceipt = readJson(join(scoutDir, 'job.json'));
  assert.equal(scoutReceipt.prewalk_kind, 'code');
  assert.deepEqual(scoutReceipt.citations, {
    total: 4,
    verified: 3,
    failed: [{ ref: 'dup.ts:1', reason: 'ambiguous_path' }],
  });
});
