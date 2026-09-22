import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RolloutParser, parseRolloutFile } from '../../src/collectors/rollout.js';
import { buildContextUsage } from '../../src/collectors/context-usage.js';
import { renderHud } from '../../src/render/header.js';
import { stripAnsi } from '../../src/render/colors.js';
import { makeHudData } from '../fixtures/hud-data.js';

test('Ctx retains the latest usage through idle polls and partial token updates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-context-retention-'));
  const file = path.join(dir, 'rollout.jsonl');
  const event = (payload: Record<string, unknown>) => JSON.stringify({
    timestamp: new Date().toISOString(), type: 'event_msg', payload,
  }) + '\n';
  const usage = { total_tokens: 50000, input_tokens: 49000, output_tokens: 1000 };
  fs.writeFileSync(file, event({ type: 'token_count', info: {
    model_context_window: 200000, last_token_usage: usage, total_token_usage: usage,
  } }));
  const parser = new RolloutParser();
  parser.setRolloutPath(file);
  const context = async () => {
    const result = await parser.parse();
    return buildContextUsage(result?.tokenUsage ?? undefined, result?.compactCount, result?.lastCompactTime);
  };
  try {
    const initial = await context();
    assert.equal(initial?.used, 38000);
    assert.deepEqual(await context(), initial, 'no new bytes keeps the snapshot');
    fs.appendFileSync(file, event({ type: 'task_complete' }) + event({ type: 'token_count', info: null }));
    assert.deepEqual(await context(), initial, 'idle and quota-only events keep the snapshot');

    fs.appendFileSync(file, event({ type: 'task_started', model_context_window: 200000 }));
    assert.deepEqual(await context(), initial, 'window-only events must not erase last_token_usage');
    fs.appendFileSync(file, event({ type: 'token_count', info: { model_context_window: 200000 } }));
    const retained = await context();
    assert.deepEqual(retained, initial, 'partial token reports keep the last known usage');
    const line = stripAnsi(renderHud(makeHudData({ contextUsage: retained }), { width: 200, showDetails: false })[0]);
    assert.match(line, /Ctx.*20%/);

    const replay = await parseRolloutFile(file);
    assert.deepEqual(buildContextUsage(replay.result.tokenUsage ?? undefined, 0, null), initial,
      'a full replay retains usage exactly like incremental polling');

    fs.appendFileSync(file, event({ type: 'token_count', info: { last_token_usage: { total_tokens: 10000 } } }));
    assert.equal((await context())?.used, 0, 'new measurements replace old usage, including decreases');
    const emptySession = path.join(dir, 'other.jsonl');
    fs.writeFileSync(emptySession, event({ type: 'task_started', model_context_window: 200000 }));
    parser.setRolloutPath(emptySession);
    assert.equal(await context(), undefined, 'another session must not inherit the old context');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plan progress remains visible after tool-only or idle updates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-plan-retention-'));
  const file = path.join(dir, 'rollout.jsonl');
  const event = (payload: Record<string, unknown>) => JSON.stringify({timestamp: new Date().toISOString(), type:'event_msg', payload}) + '\n';
  try {
    fs.writeFileSync(file, event({type:'plan_update', plan:[{step:'Run checks',status:'in_progress'}]}));
    const parser = new RolloutParser(); parser.setRolloutPath(file);
    const first = await parser.parse();
    assert.equal(first?.planProgress?.totalSteps, 1);
    fs.appendFileSync(file, event({type:'token_count',info:null}));
    assert.deepEqual((await parser.parse())?.planProgress, first?.planProgress);
    assert.deepEqual((await parser.parse())?.planProgress, first?.planProgress);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('check commands retain arguments and report nonzero exit codes as failures', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-command-results-'));
  const file = path.join(dir, 'rollout.jsonl');
  const event = (payload: Record<string, unknown>) => JSON.stringify({timestamp:new Date().toISOString(), type:'response_item',payload}) + '\n';
  try {
    fs.writeFileSync(file, event({type:'function_call',name:'exec_command',call_id:'check',arguments:JSON.stringify({cmd:'npm test'})}) +
      event({type:'function_call_output',call_id:'check',output:JSON.stringify({exit_code:1,output:'1 failing test'})}));
    const result = (await parseRolloutFile(file)).result;
    const call = result.toolActivity.recentCalls[0];
    assert.equal(call.arguments?.cmd, 'npm test');
    assert.equal(call.status, 'error');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
