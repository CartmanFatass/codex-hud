import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RolloutParser } from '../../src/collectors/rollout.js';

const base = Date.parse('2026-09-11T10:00:00Z');
const entry = (seconds: number, payload: object, type = 'response_item') =>
  JSON.stringify({ timestamp: new Date(base + seconds * 1000).toISOString(), type, payload }) + '\n';

async function fixture(run: (file: string, parser: RolloutParser) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-custom-tools-'));
  const file = path.join(dir, 'rollout.jsonl');
  const parser = new RolloutParser();
  parser.setRolloutPath(file);
  try { await run(file, parser); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('custom calls retain source and match array output by call_id across polling', async () => {
  await fixture(async (file, parser) => {
    const source = 'text(await tools.exec_command({cmd:"npm test && npm run build"}));';
    fs.writeFileSync(file, entry(0, { type: 'custom_tool_call', id: 'item-1', call_id: 'call-1', name: 'exec', input: source }));
    const started = (await parser.parse())!.toolActivity.recentCalls[0];
    assert.equal(started?.id, 'call-1');
    assert.equal(started.arguments?.code, source);
    assert.equal(started.status, 'running');
    fs.appendFileSync(file, entry(2, { type: 'custom_tool_call_output', call_id: 'call-1', output: [
      { type: 'input_text', text: 'Script completed' }, { type: 'input_text', text: 'Output retained' },
    ] }));
    const result = (await parser.parse())!;
    assert.equal(result.toolActivity.totalCalls, 1);
    const finished = result.toolActivity.recentCalls[0];
    assert.equal(finished.status, 'completed');
    assert.equal(finished.duration, 2000);
    assert.equal(finished.output, 'Script completed\nOutput retained');
    assert.equal(finished.resultSuccess, undefined, 'orchestration completion does not prove command success');
  });
});

test('custom output detects explicit failures in nested structured text blocks', async () => {
  await fixture(async (file, parser) => {
    const cases = [
      { output: [{ type: 'text', text: JSON.stringify({ exit_code: 2, output: 'test failed' }) }], exitCode: 2 },
      { output: [{ type: 'text', text: JSON.stringify({ result: { value: { exit_code: 3, output: 'build failed' } } }) }], exitCode: 3 },
      { output: [{ type: 'text', text: JSON.stringify({ isError: true, content: 'tool failed' }) }], exitCode: undefined },
      { output: [{ type: 'text', text: 'Process exited with code 1\ntest failed' }, { type: 'text', text: 'Exit code: 0' }], exitCode: 1 },
    ];
    fs.writeFileSync(file, cases.map((sample, i) => entry(i * 2, {
      type: 'custom_tool_call', id: `item-${i}`, call_id: `call-${i}`, name: 'exec', input: 'npm test',
    }) + entry(i * 2 + 1, { type: 'custom_tool_call_output', call_id: `call-${i}`, output: sample.output })).join(''));
    const calls = (await parser.parse())!.toolActivity.recentCalls;
    assert.equal(calls.length, cases.length);
    calls.forEach((call, i) => {
      assert.equal(call.status, 'error');
      assert.equal(call.resultSuccess, false);
      assert.equal(call.exitCode, cases[i].exitCode);
      assert.match(call.output!, /failed/);
    });
  });
});

test('output is bounded and binary blocks do not turn into text', async () => {
  await fixture(async (file, parser) => {
    fs.writeFileSync(file, entry(0, { type: 'custom_tool_call', call_id: 'call', name: 'exec', input: 'npm run build' }) +
      entry(1, { type: 'custom_tool_call_output', call_id: 'call', output: [
        { type: 'image', data: 'do not display this' },
        { type: 'text', text: 'x'.repeat(10000) + '\nExit code: 0' },
      ] }));
    const call = (await parser.parse())!.toolActivity.recentCalls[0];
    assert.equal(call?.resultSuccess, true);
    assert.equal(call.output?.length, 8000);
    assert.ok(!call.output.includes('do not display this'));
  });
});

test('ordinary function calls also correlate results with call_id before item id', async () => {
  await fixture(async (file, parser) => {
    fs.writeFileSync(file, entry(0, { type: 'function_call', id: 'item', call_id: 'call', name: 'exec_command', arguments: '{"cmd":"npm test"}' }) +
      entry(1, { type: 'function_call_output', call_id: 'call', output: '{"exit_code":0,"output":"passed"}' }));
    const call = (await parser.parse())!.toolActivity.recentCalls[0];
    assert.equal(call.id, 'call');
    assert.equal(call.status, 'completed');
    assert.equal(call.resultSuccess, true);
  });
});

test('fullParse recomputes output rate after replacement with earlier timestamps', async () => {
  await fixture(async (file, parser) => {
    const usage = (total: number) => ({ type: 'token_count', info: { total_token_usage: { output_tokens: total } } });
    fs.writeFileSync(file, entry(100, usage(100), 'event_msg') + entry(110, usage(600), 'event_msg'));
    assert.equal((await parser.parse())?.outputRate?.tokensPerSecond, 50);
    fs.writeFileSync(file, entry(0, usage(100), 'event_msg') + entry(10, usage(300), 'event_msg'));
    assert.equal((await parser.fullParse())?.outputRate?.tokensPerSecond, 20);
  });
});
