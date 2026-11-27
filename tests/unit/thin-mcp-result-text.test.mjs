import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { compactResult } from '../../dist/mcp/mcp/result-text.js';
import { ids, results } from '../../integrations/claude-mod/tests/fixtures.ts';
import { fixture, waitFixtureJob } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

test('MCP compaction matches the Claude mod sample savings and keeps actionable facts', (t) => {
  const expected = [
    [510, [ids.a1, 'role: imp', 'state: working', 'task_dir: ', 'watcher_alive: true', '`hud watch` is live under Monitor', '`hud_read`', 'Imp routing is off']],
    [567, [ids.a2, 'state: closed', ids.summary, JSON.stringify(ids.readHint(ids.a2)), '"verdict":"Accept"', 'changed_files: 16: src/billing/invoice-total.ts', 'report_exists: true']],
    [2529, [ids.a2, 'state: closed', '**Verdict:** Accept', '## Evidence', 'report_path', 'wrote the report', 'base_head']],
    [492, ['f00000000000000b1', 'state: completed', 'landed_sha', 'timings', 'pass 411']],
  ];
  let before = 0, after = 0;
  for (const [i, { name, value }] of results.entries()) {
    const [previousBytes, keep] = expected[i];
    const text = compactResult(value);
    const jsonBytes = Buffer.byteLength(JSON.stringify(value)), compactBytes = Buffer.byteLength(text);
    assert.ok(compactBytes <= previousBytes, name);
    for (const needle of keep) assert.ok(text.includes(needle), `${name} omitted ${needle}`);
    assert.doesNotMatch(text, /: null|blocked: false|open_questions: 0/);
    before += jsonBytes;
    after += compactBytes;
    t.diagnostic(`${name}: ${jsonBytes} -> ${compactBytes} bytes`);
  }
  t.diagnostic(`Total: ${before} -> ${after} bytes (${(100 * (before - after) / before).toFixed(1)}% smaller)`);

  const many = Array.from({ length: 20 }, (_, i) => `src/m${i}.ts`);
  assert.equal(compactResult({ changed_files: [...many, '+3 more'] }),
    'changed_files: 23: src/m0.ts, src/m1.ts, src/m2.ts, src/m3.ts, src/m4.ts +18 more');
  assert.equal(compactResult({ changed_files: ['a.ts', 'b.ts'] }), 'changed_files: ["a.ts","b.ts"]');
  assert.equal(compactResult({ job: 'j0000000000000001', open_questions: null, reason: null }),
    'job: j0000000000000001\nopen_questions: null');
});

test('default MCP text carries single and batch report pages while errors remain JSON', async (t) => {
  const f = await fixture(t, { mcpJson: false });
  await f.rpc('initialize', { clientInfo: { name: 'codex' } });
  const call = async (name, args = {}) => {
    const { result } = await f.rpc('tools/call', { name, arguments: args });
    return result;
  };
  const text = async (name, args) => (await call(name, args)).content[0].text;
  assert.equal(await text('hud_read'), 'jobs: []');

  const { job, dir } = waitFixtureJob(f, 1, 'closed');
  const path = join(dir, 'report.md');
  const lead = 'r'.repeat(24 * 1024 - 2) + '\n', tail = '🙂\n'.repeat(1000);
  const reportBytes = Buffer.byteLength(lead + tail);
  writeFixtureFile(path, lead + tail);

  const page = await text('hud_read', { job, mode: 'full' });
  const field = (name) => page.split('\n').find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
  assert.equal(field('report_path'), path);
  assert.equal(Number(field('report_bytes')), reportBytes);
  const offset = Number(field('next_offset'));
  assert.equal(offset, Buffer.byteLength(lead));
  assert.equal(JSON.parse(field('report')), lead);

  const missing = 'j0000000000000002';
  const error = { ok: false, code: 'job_not_found' };
  const batch = (await text('hud_read', { jobs: [job, missing], mode: 'full' })).split('\n')[0];
  assert.match(batch, /^jobs: /);
  const [first, second] = JSON.parse(batch.slice('jobs: '.length));
  assert.deepEqual([first.report_path, first.report_bytes, first.next_offset], [path, reportBytes, offset]);
  assert.equal(first.report, lead);
  assert.deepEqual(second, { job: missing, ...error });

  const last = await text('hud_read', { job, mode: 'full', offset });
  assert.ok(last.includes(`report: ${JSON.stringify(tail)}`));
  assert.doesNotMatch(last, /^next_offset:/m);
  assert.deepEqual(JSON.parse(await text('hud_read', { job: missing })), error);
  const bad = await call('hud_read', { job, mode: 'bad' });
  assert.equal(bad.isError, true);
  assert.deepEqual(JSON.parse(bad.content[0].text), { ok: false, code: 'tool_error', error: 'invalid_arguments: mode' });
});
