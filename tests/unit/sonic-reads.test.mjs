import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { archiveJob } from '../../dist/roles/job-archive.js';
import { ensureJobWatcher } from '../../dist/mcp/watch-pid.js';
import {
  countSonicSessionReads,
  MAX_SONIC_BY_TOOL,
  MAX_SONIC_READS_BYTES,
} from '../../dist/roles/sonic-reads.js';
import { cliState, fixture, until } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile as write } from '../helpers/thin-mcp-files.mjs';

const workerTools = new URL('../../packages/hud-mcp/bin/worker-tools.mjs', import.meta.url).href;
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const sessionHeader = (id = 'sess-synthetic-1', cwd = '/tmp/synthetic') =>
  JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-11-25T10:00:00.000Z', cwd });

const toolCallMsg = (calls, timestamp = '2026-11-25T10:00:01.000Z') =>
  JSON.stringify({
    type: 'message',
    timestamp,
    message: {
      role: 'assistant',
      content: calls.map(({ id, name }) => ({ type: 'toolCall', id, name, arguments: {} })),
    },
  });

const toolResultMsg = (toolName, text, { id, timestamp = '2026-11-25T10:00:02.000Z', omitToolName = false } = {}) =>
  JSON.stringify({
    type: 'message',
    timestamp,
    message: {
      role: 'toolResult',
      ...(id ? { toolCallId: id } : {}),
      ...(omitToolName ? {} : { toolName }),
      content: [{ type: 'text', text }],
      isError: false,
    },
  });

test('countSonicSessionReads streams tool results, ranks top 10 by_tool, enforces byte cap, and returns null when missing or unreadable', (t) => {
  assert.equal(MAX_SONIC_READS_BYTES, 50 * 1024 * 1024);
  assert.equal(MAX_SONIC_BY_TOOL, 10);

  const base = fs.mkdtempSync(join(tmpdir(), 'hud-sonic-reads-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  // Missing and empty/unreadable sessions return null.
  assert.equal(countSonicSessionReads(join(base, 'missing.jsonl')), null);
  const emptyPath = join(base, 'empty.jsonl');
  fs.writeFileSync(emptyPath, '');
  assert.equal(countSonicSessionReads(emptyPath), null);
  assert.equal(countSonicSessionReads(base), null);

  // 12 distinct tools: total includes all 12, by_tool keeps top 10 by result bytes.
  const twelveLines = [sessionHeader('sess-12')];
  let expectedTotalBytes = 0;
  for (let i = 1; i <= 12; i++) {
    const payload = 'x'.repeat(i * 10);
    expectedTotalBytes += Buffer.byteLength(payload, 'utf8');
    twelveLines.push(toolResultMsg(`tool_${String(i).padStart(2, '0')}`, payload));
  }
  const twelvePath = join(base, 'twelve.jsonl');
  fs.writeFileSync(twelvePath, twelveLines.join('\n') + '\n');
  const twelve = countSonicSessionReads(twelvePath);
  assert.equal(twelve.tool_calls, 12);
  assert.equal(twelve.tool_result_bytes, expectedTotalBytes);
  assert.equal(twelve.truncated, undefined);
  assert.deepEqual(Object.keys(twelve.by_tool), [
    'tool_12', 'tool_11', 'tool_10', 'tool_09', 'tool_08',
    'tool_07', 'tool_06', 'tool_05', 'tool_04', 'tool_03',
  ]);
  assert.deepEqual(twelve.by_tool.tool_12, { calls: 1, bytes: 120 });

  // Truncation boundary: stop counting past maxBytes with truncated: true and drop incomplete tail line.
  const line1 = sessionHeader('sess-trunc');
  const line2 = toolResultMsg('read', 'alpha-é'); // 8 UTF-8 bytes
  const line3 = toolResultMsg('bash', 'beta-output'); // 11 UTF-8 bytes
  const truncPath = join(base, 'trunc.jsonl');
  fs.writeFileSync(truncPath, `${line1}\n${line2}\n${line3}\n`);
  const afterTwo = Buffer.byteLength(`${line1}\n${line2}\n`, 'utf8');
  const truncatedResult = countSonicSessionReads(truncPath, { maxBytes: afterTwo + 10 });
  assert.deepEqual(truncatedResult, {
    tool_calls: 1,
    tool_result_bytes: Buffer.byteLength('alpha-é', 'utf8'),
    by_tool: { read: { calls: 1, bytes: Buffer.byteLength('alpha-é', 'utf8') } },
    truncated: true,
  });

  // Exact file length at maxBytes without trailing bytes is NOT truncated.
  const exactBytes = fs.statSync(truncPath).size;
  const exactResult = countSonicSessionReads(truncPath, { maxBytes: exactBytes });
  assert.deepEqual(exactResult, {
    tool_calls: 2,
    tool_result_bytes: Buffer.byteLength('alpha-é', 'utf8') + Buffer.byteLength('beta-output', 'utf8'),
    by_tool: {
      bash: { calls: 1, bytes: Buffer.byteLength('beta-output', 'utf8') },
      read: { calls: 1, bytes: Buffer.byteLength('alpha-é', 'utf8') },
    },
  });

  // Fallback to assistant toolCall name when toolName is omitted, and retry sinceMs filtering.
  const fallbackPath = join(base, 'fallback.jsonl');
  fs.writeFileSync(
    fallbackPath,
    [
      sessionHeader('sess-fallback'),
      toolCallMsg([{ id: 'c1', name: 'grep' }], '2026-11-25T09:00:00.000Z'),
      toolResultMsg('grep', 'old-result', { id: 'c1', timestamp: '2026-11-25T09:00:01.000Z' }),
      toolCallMsg([{ id: 'c2', name: 'find' }], '2026-11-25T10:00:01.000Z'),
      toolResultMsg('', 'new-result', { id: 'c2', omitToolName: true, timestamp: '2026-11-25T10:00:02.000Z' }),
    ].join('\n') + '\n',
  );
  assert.deepEqual(
    countSonicSessionReads(fallbackPath, { sinceMs: Date.parse('2026-11-25T10:00:00.000Z') }),
    {
      tool_calls: 1,
      tool_result_bytes: Buffer.byteLength('new-result', 'utf8'),
      by_tool: { find: { calls: 1, bytes: Buffer.byteLength('new-result', 'utf8') } },
    },
  );
});

test('headless sonic job with three tool calls records reads, brief_bytes and report_bytes on job.json and archive; missing session records reads null', async (t) => {
  const f = await fixture(t);

  const readOne = 'first synthetic file contents\n';
  const readTwo = 'second synthetic file with café utf8\n';
  const bashOut = 'src/a.ts\nsrc/b.ts\n';
  const reportBody = '# Sonic report\n\nSynthetic findings.\n';
  const sessionLines = [
    sessionHeader('sess-headless-1', f.root),
    toolCallMsg([
      { id: 't1', name: 'read' },
      { id: 't2', name: 'read' },
      { id: 't3', name: 'bash' },
    ]),
    toolResultMsg('read', readOne, { id: 't1' }),
    toolResultMsg('read', readTwo, { id: 't2' }),
    toolResultMsg('bash', bashOut, { id: 't3' }),
  ].join('\n') + '\n';

  f.overrideBin('pi', `#!${process.execPath}
import * as fs from 'node:fs';
import { join } from 'node:path';
if (!process.argv.includes('--print')) process.exit(1);
const { callWorkerTool } = await import(${JSON.stringify(workerTools)});
const dir = process.env.HUD_JOB_DIR;
const brief = fs.readFileSync(join(dir, 'brief.md'), 'utf8');
if (!brief.includes('no-session')) {
  fs.writeFileSync(join(dir, 'sonic-session.jsonl'), ${JSON.stringify(sessionLines)});
}
await callWorkerTool('hud_report', { text: ${JSON.stringify(reportBody)} });
`);

  const sonic = await f.call('hud_create', { role: 'sonic', task: 'Count three synthetic tool calls.' });
  await until(() => cliState(sonic.task_dir)?.state === 'closed' && readJson(join(sonic.task_dir, 'job.json')).reaped_at, t.signal);

  const readOneBytes = Buffer.byteLength(readOne, 'utf8');
  const readTwoBytes = Buffer.byteLength(readTwo, 'utf8');
  const bashBytes = Buffer.byteLength(bashOut, 'utf8');
  const expectedReads = {
    tool_calls: 3,
    tool_result_bytes: readOneBytes + readTwoBytes + bashBytes,
    by_tool: {
      read: { calls: 2, bytes: readOneBytes + readTwoBytes },
      bash: { calls: 1, bytes: bashBytes },
    },
  };
  const expectedBriefBytes = fs.statSync(join(sonic.task_dir, 'brief.md')).size;
  const expectedReportBytes = fs.statSync(join(sonic.task_dir, 'report.md')).size;

  const receipt = readJson(join(sonic.task_dir, 'job.json'));
  assert.deepEqual(receipt.reads, expectedReads);
  assert.equal(receipt.brief_bytes, expectedBriefBytes);
  assert.equal(receipt.report_bytes, expectedReportBytes);

  // Reading the report preserves reads, brief_bytes and report_bytes.
  await f.call('hud_read', { job: sonic.job });
  const afterRead = readJson(join(sonic.task_dir, 'job.json'));
  assert.deepEqual(afterRead.reads, expectedReads);
  assert.equal(afterRead.brief_bytes, expectedBriefBytes);
  assert.equal(afterRead.report_bytes, expectedReportBytes);

  // Missing sonic-session.jsonl records reads: null with no error, and preserves it across hud_read.
  const missing = await f.call('hud_create', { role: 'sonic', task: 'no-session fixture' });
  await until(() => cliState(missing.task_dir)?.state === 'closed' && readJson(join(missing.task_dir, 'job.json')).reaped_at, t.signal);

  const missingReceipt = readJson(join(missing.task_dir, 'job.json'));
  assert.equal(missingReceipt.reads, null);
  assert.equal(missingReceipt.brief_bytes, fs.statSync(join(missing.task_dir, 'brief.md')).size);
  assert.equal(missingReceipt.report_bytes, fs.statSync(join(missing.task_dir, 'report.md')).size);

  await f.call('hud_read', { job: missing.job });
  assert.equal(readJson(join(missing.task_dir, 'job.json')).reads, null);

  // Deleting the session file afterwards does not overwrite already-recorded reads on a later watcher scan.
  fs.rmSync(join(sonic.task_dir, 'sonic-session.jsonl'));
  const ended = '2026-11-25T12:00:00.000Z';
  const logs = [];
  archiveJob(f.env.HUD_HOME, sonic.task_dir, sonic.job, readJson(join(sonic.task_dir, 'job.json')), cliState(sonic.task_dir), Date.parse(ended), (m) => logs.push(m));
  archiveJob(f.env.HUD_HOME, missing.task_dir, missing.job, readJson(join(missing.task_dir, 'job.json')), cliState(missing.task_dir), Date.parse(ended), (m) => logs.push(m));
  assert.deepEqual(logs, []);

  const archived = fs.readFileSync(join(f.env.HUD_HOME, 'archive', '2026-11.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const sonicArchive = archived.find((row) => row.job === sonic.job);
  assert.deepEqual(sonicArchive.reads, expectedReads);
  assert.equal(sonicArchive.brief_bytes, expectedBriefBytes);
  assert.equal(sonicArchive.report_bytes, expectedReportBytes);

  const missingArchive = archived.find((row) => row.job === missing.job);
  assert.equal(missingArchive.reads, null);
  assert.equal(missingArchive.brief_bytes, missingReceipt.brief_bytes);
  assert.equal(missingArchive.report_bytes, missingReceipt.report_bytes);
});

test('tab-mode sonic fixture records reads from its session file, and missing session records reads null', async (t) => {
  const f = await fixture(t);
  const ended = '2026-11-25T13:00:00.000Z';

  // Tab-mode sonic with a readable session file.
  const tabId = 'j1111111111111111';
  const tabDir = join(f.env.HUD_HOME, 'jobs', tabId);
  fs.mkdirSync(tabDir, { recursive: true });
  const tabSession = join(f.root, 'tab-sonic-session.jsonl');
  const grepOut = 'src/foo.ts:10:match\n';
  const readOut = 'export const ok = true;\n';
  const lsOut = 'a.ts\nb.ts\nc.ts\n';
  write(
    tabSession,
    [
      sessionHeader('sess-tab-1', f.root),
      toolResultMsg('grep', grepOut),
      toolResultMsg('read', readOut),
      toolResultMsg('ls', lsOut),
    ].join('\n') + '\n',
  );
  const tabBrief = 'Tab sonic brief.\n';
  const tabReport = '# Tab sonic report\n\nAll done.\n';
  write(join(tabDir, 'brief.md'), tabBrief);
  write(join(tabDir, 'report.md'), tabReport);
  write(
    join(tabDir, 'job.json'),
    JSON.stringify({
      job: tabId,
      role: 'sonic',
      request_key: 'tab-sonic-1',
      cwd: f.root,
      headless: false,
      created_at: ended,
      dispatch_exit_code: 0,
      stderr_tail: '',
    }, null, 2),
  );
  write(
    join(tabDir, 'STATUS.json'),
    JSON.stringify({
      state: 'done',
      slot: 'primary',
      role: 'sonic',
      harness: 'pi',
      session_id: 'sess-tab-1',
      session_file: tabSession,
      started_at: ended,
      settled_at: ended,
      ended_at: ended,
      output_written: true,
    }),
  );

  // Tab-mode sonic whose session file is missing.
  const missingId = 'j2222222222222222';
  const missingDir = join(f.env.HUD_HOME, 'jobs', missingId);
  fs.mkdirSync(missingDir, { recursive: true });
  const missingBrief = 'Tab sonic missing session brief.\n';
  write(join(missingDir, 'brief.md'), missingBrief);
  write(
    join(missingDir, 'job.json'),
    JSON.stringify({
      job: missingId,
      role: 'sonic',
      request_key: 'tab-sonic-2',
      cwd: f.root,
      headless: false,
      created_at: ended,
      dispatch_exit_code: 0,
      stderr_tail: '',
    }, null, 2),
  );
  write(
    join(missingDir, 'STATUS.json'),
    JSON.stringify({
      state: 'closed',
      slot: 'primary',
      role: 'sonic',
      harness: 'pi',
      session_id: 'sess-tab-missing',
      session_file: join(f.root, 'does-not-exist.jsonl'),
      started_at: ended,
      settled_at: ended,
      ended_at: ended,
      output_written: false,
    }),
  );

  // Non-sonic job with injected fields: archive must omit them.
  const impId = 'j3333333333333333';
  const impDir = join(f.env.HUD_HOME, 'jobs', impId);
  fs.mkdirSync(impDir, { recursive: true });
  write(
    join(impDir, 'job.json'),
    JSON.stringify({
      job: impId,
      role: 'imp',
      request_key: 'imp-1',
      cwd: f.root,
      created_at: ended,
      dispatch_exit_code: 0,
      stderr_tail: '',
      reads: { tool_calls: 1, tool_result_bytes: 5, by_tool: { read: { calls: 1, bytes: 5 } } },
      brief_bytes: 10,
      report_bytes: 20,
    }, null, 2),
  );
  write(join(impDir, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: ended }));

  // Start the on-demand watcher and wait for it to record both tab-mode sonic jobs.
  ensureJobWatcher(f.env.HUD_HOME);
  await until(
    () => readJson(join(tabDir, 'job.json')).reads !== undefined && readJson(join(missingDir, 'job.json')).reads !== undefined,
    t.signal,
  );

  const expectedTabReads = {
    tool_calls: 3,
    tool_result_bytes: Buffer.byteLength(grepOut, 'utf8') + Buffer.byteLength(readOut, 'utf8') + Buffer.byteLength(lsOut, 'utf8'),
    by_tool: {
      read: { calls: 1, bytes: Buffer.byteLength(readOut, 'utf8') },
      grep: { calls: 1, bytes: Buffer.byteLength(grepOut, 'utf8') },
      ls: { calls: 1, bytes: Buffer.byteLength(lsOut, 'utf8') },
    },
  };
  const tabReceipt = readJson(join(tabDir, 'job.json'));
  assert.deepEqual(tabReceipt.reads, expectedTabReads);
  assert.equal(tabReceipt.brief_bytes, Buffer.byteLength(tabBrief, 'utf8'));
  assert.equal(tabReceipt.report_bytes, Buffer.byteLength(tabReport, 'utf8'));

  const missingReceipt = readJson(join(missingDir, 'job.json'));
  assert.equal(missingReceipt.reads, null);
  assert.equal(missingReceipt.brief_bytes, Buffer.byteLength(missingBrief, 'utf8'));
  assert.equal(missingReceipt.report_bytes, undefined);

  const logs = [];
  archiveJob(f.env.HUD_HOME, tabDir, tabId, tabReceipt, cliState(tabDir), Date.parse(ended), (m) => logs.push(m));
  archiveJob(f.env.HUD_HOME, missingDir, missingId, missingReceipt, cliState(missingDir), Date.parse(ended), (m) => logs.push(m));
  archiveJob(f.env.HUD_HOME, impDir, impId, readJson(join(impDir, 'job.json')), cliState(impDir), Date.parse(ended), (m) => logs.push(m));
  assert.deepEqual(logs, []);

  const archived = fs.readFileSync(join(f.env.HUD_HOME, 'archive', '2026-11.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const tabArchive = archived.find((row) => row.job === tabId);
  assert.deepEqual(tabArchive.reads, expectedTabReads);
  assert.equal(tabArchive.brief_bytes, Buffer.byteLength(tabBrief, 'utf8'));
  assert.equal(tabArchive.report_bytes, Buffer.byteLength(tabReport, 'utf8'));

  const missingArchive = archived.find((row) => row.job === missingId);
  assert.equal(missingArchive.reads, null);
  assert.equal(missingArchive.brief_bytes, Buffer.byteLength(missingBrief, 'utf8'));
  assert.equal('report_bytes' in missingArchive, false);

  const impArchive = archived.find((row) => row.job === impId);
  assert.equal('reads' in impArchive, false);
  assert.equal('brief_bytes' in impArchive, false);
  assert.equal('report_bytes' in impArchive, false);
});
