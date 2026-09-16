import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAgentReport } from '../../src/collectors/agent-report.js';
const timestamp = '2026-09-16T09:00:00Z';
const message = (text: string, extra: Record<string, unknown> = {}) => ({timestamp,type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text}],...extra}});

test('public assistant updates and replies retain exact words, not inferred progress',()=>{
  assert.deepEqual(extractAgentReport(message('I found the cause.',{phase:'commentary'})),{text:'I found the cause.',at:new Date(timestamp),kind:'update'});
  assert.equal(extractAgentReport(message('My test passed.',{phase:'final_answer'}))?.kind,'reply');
  assert.equal(extractAgentReport(message('My test passed.'))?.text,'My test passed.');
});
test('public event messages are accepted, tools/token/plan events are not reports',()=>{
  assert.equal(extractAgentReport({timestamp,type:'event_msg',payload:{type:'agent_message',message:'Checking the boundary.'}})?.text,'Checking the boundary.');
  for (const type of ['token_count','plan_update','agent_reasoning','turn_started','task_complete','function_call_output']) {
    assert.equal(extractAgentReport({timestamp,type:'event_msg',payload:{type,message:'private or irrelevant',output:'anything'}}),undefined);
  }
});
test('reasoning, user text, private and unknown channels never leak into reports',()=>{
  for (const extra of [{channel:'analysis'},{channel:'reasoning'},{channel:'future_private'},{phase:'analysis'},{phase:'future_private'},{role:'user'},{role:'developer'},{type:'reasoning'}]) {
    assert.equal(extractAgentReport(message('DO_NOT_SHOW',extra)),undefined);
  }
});
test('malformed or undated messages do not invent freshness',()=>{
  for (const value of [null,[],{}, {type:'response_item',payload:{}}, {...message('x'),timestamp:'invalid'},message('   ')]) assert.equal(extractAgentReport(value),undefined);
});
test('retained excerpts are bounded by code points without splitting Unicode',()=>{
  const report=extractAgentReport(message('界'.repeat(800)))!;
  assert.equal(Array.from(report.text).length,601);
  assert.ok(report.text.endsWith('…'));
  assert.equal(extractAgentReport(message('first\nsecond\tthird'))?.text,'first second third');
});
test('message records do not create status, progress, success or file ownership',()=>{
  const report=extractAgentReport(message('done, 100%, changed foo.ts'))!;
  assert.deepEqual(Object.keys(report).sort(),['at','kind','text']);
});
