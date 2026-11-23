import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../.claude/skills/trace-review/extract.mjs', import.meta.url));
const cwd = '/home/example-person/projects/MyHUD';
const text = value => ({ type: 'text', text: value });
function sample(t, harness, rows, job) {
  const dir = mkdtempSync(path.join(tmpdir(), 'trace-review-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'synthetic-session.jsonl');
  writeFileSync(source, rows.map(JSON.stringify).join('\n') + '\n');
  const input = job ? ['--job', job] : [source];
  const hud = path.join(dir, 'hud');
  if (job) {
    const dir = path.join(hud, 'jobs', job);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'STATUS.json'), JSON.stringify({ harness, session_file: source }));
  }
  const result = spawnSync(process.execPath, [cli, harness, ...input, '--out', path.join(dir, 'out')],
    { encoding: 'utf8', cwd: dir, env: { ...process.env, HUD_HOME: hud } });
  assert.equal(result.status, 0, result.stderr);
  const run = path.join(dir, /^Output: (.+)\n/.exec(result.stdout)[1]);
  const raw = readFileSync(path.join(run, 'metrics.json'), 'utf8');
  assert.equal(JSON.parse(raw).schemaVersion, 1);
  assert.equal(readFileSync(path.join(run, 'summary.txt'), 'utf8').trim(), result.stdout.split('\n').slice(1).join('\n').trim());
  for (const value of ['example-person', 'synthetic-session', 'private-payload', 'j1111111111111111', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']) {
    assert.ok(!raw.includes(value), `leaked ${value}`);
    assert.ok(!result.stdout.includes(value), `leaked ${value}`);
  }
  return JSON.parse(raw).sessions[0];
}

const claudeCall = (id, name, input) => ({ type: 'tool_use', id, name, input });
const claudeResult = (id, content) => ({ type: 'tool_result', tool_use_id: id, content });
const claudeReply = (id, input, ...content) => ({ type: 'assistant', cwd, message: { id, content,
  usage: { input_tokens: input, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } } });
const claudeUser = (...content) => ({ type: 'user', message: { content } });

test('Claude links by ID, deduplicates streamed blocks and counts reads, injections, HUD changes and context', t => {
  const file = 'docs/notes.md';
  const notification = '<task-notification><task-id>j1111111111111111</task-id><summary>private-payload</summary></task-notification>';
  const reminder = '<system-reminder>Check synthetic notes.</system-reminder>';
  const first = claudeCall('c1', 'Read', { file_path: file });
  const hud = id => claudeCall(id, 'mcp__hud__hud_read', { job: 'j1111111111111111' });
  const result = JSON.stringify({ changes: ['synthetic event'] });
  const s = sample(t, 'claude', [
    { type: 'attachment', attachment: { type: 'environment' }, rendered: [{ content: reminder }] },
    claudeReply('m1', 10, first), claudeReply('m1', 10, first, hud('c2')),
    claudeUser(claudeResult('c2', [text(result)]), claudeResult('c1', '1\tone\n2\ttwó\n3\tthree\n4\tfour')),
    { type: 'attachment', attachment: { type: 'queued_command', source_uuid: 'u1', prompt: notification }, rendered: [text(notification)] },
    { ...claudeUser(text(notification)), uuid: 'u1' },
    claudeUser(text(reminder), text(notification)),
    claudeReply('m2', 15, claudeCall('c3', 'Read', { file_path: file, offset: 3, limit: 3 }), hud('c4')),
    claudeUser(claudeResult('c3', '3\tthree\n4\tfour\n5\tfive'), claudeResult('c4', [text(result)])),
    { type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 65, postTokens: 20 } },
    claudeReply('m3', 5, claudeCall('c5', 'Read', { limit: 3, offset: 3, file_path: file }),
      claudeCall('c6', 'Read', { file_path: '/home/example-person/.hud/jobs/j1111111111111111/report.md' })),
    claudeUser(claudeResult('c5', '3\tthree\n4\tfour\n5\tfive'))
  ]);
  assert.deepEqual(s.turns.map(t => [t.usage.contextTokens, t.contextDeltaTokens]), [[60, undefined], [65, 5], [55, undefined]]);
  assert.deepEqual(s.compactions, [{ afterTurn: 2, preTokens: 65, postTokens: 20 }]);
  assert.deepEqual(s.toolCalls.map(c => c.repeat), [false, false, false, true, true, false]);
  assert.equal(s.toolCalls[2].argsDigest, s.toolCalls[4].argsDigest);
  assert.equal(s.toolCalls[0].resultBytes, Buffer.byteLength('1\tone\n2\ttwó\n3\tthree\n4\tfour'));
  assert.equal(s.toolCalls[5].resultBytes, null);
  assert.deepEqual(s.fileReads.map(r => [r.file, r.wholeRequested, r.start, r.end, r.duplicatedLines]), [
    [file, true, 1, 4, 0], [file, false, 3, 5, 2], [file, false, 3, 5, 3], ['~/.hud/jobs/<job>/report.md', true, null, null, null]
  ]);
  assert.deepEqual(s.injectedBlocks.map(b => [b.kind, b.repeat]), [
    ['system-reminder', false], ['hud-notification', false], ['system-reminder', true], ['hud-notification', true]
  ]);
  assert.deepEqual(s.hud, { calls: 2, notifications: 2, changes: 2, duplicateChanges: 1 });
  assert.deepEqual(s.waitingTurns, [1, 2]);
});

const response = (type, payload) => ({ type: 'response_item', payload: { type, ...payload } });
const event = (type, payload) => ({ type: 'event_msg', payload: { type, ...payload } });
const shellResult = body => `Chunk ID: synthetic\nWall time: 0.1 seconds\nProcess exited with code 0\nFinal output:\n${body}`;

test('Codex pairs function and custom calls separately, with native turns and one usage stream', t => {
  const other = '/home/example-person/projects/example-repo/private-payload.md';
  const file = `${cwd}/docs/notes.md`;
  const instruction = response('message', { role: 'developer', content: [{ type: 'input_text', text: 'private-payload' }] });
  const shell = (id, cmd) => response('function_call', { call_id: id, name: 'exec_command', arguments: JSON.stringify({ cmd }) });
  const output = (id, text) => response('function_call_output', { call_id: id, output: shellResult(text) });
  const s = sample(t, 'codex', [
    { type: 'session_meta', payload: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cwd, base_instructions: { text: 'private-payload' } } },
    event('task_started', { turn_id: 't1' }), instruction,
    shell('a', `cat ${file}`), shell('b', `sed -n '2,3p' ${file}`),
    output('b', 'two\nthree\n'), output('a', 'one\ntwo\nthree\n'),
    event('token_count', { info: { last_token_usage: { input_tokens: 40 } } }),
    { type: 'token_usage_record', payload: { turn_id: 't1', response_id: 'r1', usage: { input_tokens: 50, cached_input_tokens: 25 } } },
    event('item_completed', { item: { type: 'ContextCompaction', id: 'compact' } }),
    event('task_started', { turn_id: 't2' }), instruction,
    shell('c', `sed -n '2,3p' ${file}`), shell('d', `cat ${other}`),
    output('c', 'two\nthree\n'), output('d', 'other\n'),
    response('custom_tool_call', { call_id: 'e', name: 'exec', input: 'private-payload' }),
    response('custom_tool_call_output', { call_id: 'e', output: [text('é')] }),
    event('token_count', { info: { last_token_usage: { input_tokens: 22 } } })
  ]);
  assert.deepEqual(s.turns.map(t => t.requests.map(r => r.contextTokens)), [[50], [22]]);
  assert.equal(s.turns[1].contextDeltaTokens, undefined);
  assert.deepEqual(s.compactions, [{ afterTurn: 1 }]);
  assert.deepEqual(s.toolCalls.map(c => c.repeat), [false, false, true, false, false]);
  assert.equal(s.toolCalls[4].resultBytes, 2);
  assert.deepEqual(s.fileReads.map(r => [r.file, r.duplicatedLines]), [['docs/notes.md', 0], ['docs/notes.md', 2], ['docs/notes.md', 2], ['<other-repo>', 0]]);
  assert.deepEqual(s.injectedBlocks.map(b => [b.kind, b.repeat]), [
    ['base-instructions', false], ['codex-developer', false], ['codex-developer', true]
  ]);
});

const piCall = (id, offset) => ({ type: 'toolCall', id, name: 'read', arguments: { path: '/home/example-person/private-payload.md', offset } });
const piMsg = (role, content, fields = {}) => ({ type: 'message', message: { role, content, ...fields } });
const piResult = (id, output) => piMsg('toolResult', [text(output)], { toolCallId: id, toolName: 'read' });

test('pi resolves HUD session_file, pairs read results, strips continuation notice and retains native cost', t => {
  const note = { type: 'custom_message', customType: 'hud-sonic-ready', content: [text('Synthetic readiness')] };
  const s = sample(t, 'pi', [
    { type: 'session', id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cwd }, note,
    piMsg('assistant', [piCall('p1', 1)], { usage: { input: 3, output: 5, cacheRead: 6, cacheWrite: 2, cost: { total: 0.012 } } }),
    piResult('p1', 'one\ntwo\nthree\n\n[Showing lines 1-3 of 10. 7 more lines in file. Use offset=4 to continue.]'),
    note, piMsg('assistant', [piCall('p2', 2), piCall('p3', 2)]), piResult('p2', 'two\nthree\nfour'), piResult('p3', 'two\nthree\nfour'),
    { type: 'compaction', tokensBefore: 11, summary: 'Synthetic summary' }
  ], 'j1111111111111111');
  assert.deepEqual(s.toolCalls.map(c => c.repeat), [false, false, true]);
  assert.ok(s.toolCalls[0].resultBytes > s.toolCalls[1].resultBytes);
  assert.deepEqual(s.fileReads.map(r => [r.file, r.start, r.end, r.duplicatedLines]), [
    ['~/<private>', 1, 3, 0], ['~/<private>', 2, 4, 2], ['~/<private>', 2, 4, 3]
  ]);
  assert.deepEqual(s.injectedBlocks.map(b => b.repeat), [false, true, false]);
  assert.equal(s.turns[0].usage.costUsd, 0.012);
  assert.equal(s.turns[0].usage.contextTokens, 11);
  assert.deepEqual(s.compactions, [{ afterTurn: 2, preTokens: 11 }]);
});

const planner = (...tool_calls) => ({ type: 'PLANNER_RESPONSE', input_tokens: 10, cache_read_tokens: 7, output_tokens: 2, tool_calls });
const generic = content => ({ type: 'GENERIC', status: 'DONE', content });

test('Antigravity pairs only planner calls to GENERIC results in order and attributes the native reminder', t => {
  const file = `${cwd}/docs/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.md`;
  const read = args => ({ name: 'read_file', args: { Path: file, ...args } });
  const reminder = { type: 'SYSTEM_MESSAGE', content: 'Reminder: work efficiently (synthetic).' };
  const hud = { name: 'call_mcp_tool', args: { ServerName: 'hud', ToolName: 'hud_read', Arguments: {} } };
  const envelope = 'Created At: time\nCompleted At: time\nCreated At: time\nCompleted At: time\n';
  const s = sample(t, 'agy', [
    reminder, planner(read(), hud), generic('Showing lines 1-3 of 4\n1: one\n2: two\n3: three'),
    generic(envelope + '{"changes":["synthetic event"]}'),
    reminder, planner(hud, read({ StartLine: 3, EndLine: 4 })), generic(envelope + '{"changes":["synthetic event"]}'),
    generic('Partial read (lines 3-4 of 4). Showing bytes 0-4.\n3: three\n4: four'),
    planner(read()), generic('Showing lines 1-4 of 4\n1: one\n2: two\n3: three\n4: four')
  ]);
  assert.deepEqual(s.toolCalls.map(c => c.repeat), [false, false, true, false, true]);
  assert.equal(s.toolCalls[0].resultBytes, Buffer.byteLength('Showing lines 1-3 of 4\n1: one\n2: two\n3: three'));
  assert.equal(s.toolCalls[1].resultBytes, Buffer.byteLength(envelope + '{"changes":["synthetic event"]}'));
  assert.deepEqual(s.fileReads.map(r => [r.file, r.duplicatedLines]), [['docs/<id>.md', 0], ['docs/<id>.md', 1], ['docs/<id>.md', 4]]);
  assert.deepEqual(s.injectedBlocks.map(b => [b.kind, b.repeat]), [['agy-efficiency-reminder', false], ['agy-efficiency-reminder', true]]);
  assert.equal(s.coverage.unmatchedResults, 0);
  assert.equal(s.coverage.compactionMarkers, false);
  assert.deepEqual(s.hud, { calls: 2, notifications: 0, changes: 2, duplicateChanges: 1 });
});
