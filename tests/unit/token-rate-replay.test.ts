import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RolloutParser } from '../../src/collectors/rollout.js';
import { buildBarModules } from '../../src/render/layout/bar-modules.js';
import { makeHudData } from '../fixtures/hud-data.js';
import { stripAnsi } from '../../src/render/colors.js';

test('real rollout timestamps determine output speed across full replay, polling and new turns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'hud-rate-replay-'));
  const file = path.join(dir,'rollout.jsonl');
  const base = Date.parse('2026-09-11T10:00:00Z');
  const event = (seconds: number, payload: object) => JSON.stringify({timestamp:new Date(base+seconds*1000).toISOString(),type:'event_msg',payload})+'\n';
  const usage = (output: number) => ({type:'token_count',info:{total_token_usage:{output_tokens:output,input_tokens:999999}}});
  try {
    fs.writeFileSync(file,event(0,usage(100))+event(10,usage(600)));
    const parser = new RolloutParser(); parser.setRolloutPath(file);
    const first = await parser.parse();
    assert.equal(first?.outputRate?.tokensPerSecond,50);
    assert.deepEqual((await parser.parse())?.outputRate,first?.outputRate);
    fs.appendFileSync(file,event(110,{type:'task_started',model_context_window:200000})+event(120,usage(1600)));
    const next = await parser.parse();
    assert.equal(next?.outputRate?.tokensPerSecond,100,'idle gap is excluded at new turn');
    const modules = buildBarModules(makeHudData({outputRate:next?.outputRate}),{density:'balanced',nowMs:base+140000});
    const rate = modules.find(module => module.id==='speed');
    assert.match(stripAnsi(rate?.variants.full ?? ''), /last ~100\.0 tok\/s/);
    const other = path.join(dir,'other.jsonl'); fs.writeFileSync(other,event(120,usage(1)));
    parser.setRolloutPath(other);
    assert.equal((await parser.parse())?.outputRate,undefined,'session switching clears rate');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
