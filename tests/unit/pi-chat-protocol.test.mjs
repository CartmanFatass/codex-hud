import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PiChatProtocol } from '../../dist/harness/pi/chat-protocol.js';
const frame = o => Buffer.from(JSON.stringify(o)+'\n');
test('correlation, split UTF-8 and idless boundary do not imply consumption', () => {
 const p=new PiChatProtocol(); const wire=JSON.parse(p.encode('hello','turn1')); assert.equal(wire.streamingBehavior,'steer');
 assert.throws(()=>p.encode('second','turn2'),/unavailable/);
 assert.deepEqual(p.consume(frame({type:'agent_end'})),[{type:'boundary'}]);
 assert.deepEqual(p.consume(frame({type:'response',id:'turn1',command:'prompt',success:true})),[{type:'accepted',turnId:'turn1'}]);
 const bytes=frame({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'中文'}}), split=bytes.indexOf(Buffer.from('中'))+1;
 assert.deepEqual(p.consume(bytes.subarray(0,split)),[]); assert.deepEqual(p.consume(bytes.subarray(split)),[{type:'delta',text:'中文'}]);
 assert.throws(()=>p.encode('retry','turn1'),/invalid_input/);
});
test('refusals are explicit, unknown/mismatched and extension UI poison channel', () => {
 const p=new PiChatProtocol(); p.encode('hello','a'); assert.deepEqual(p.consume(frame({type:'response',id:'a',command:'prompt',success:false})),[{type:'error',code:'rejected',turnId:'a'}]);
 p.encode('again','b'); assert.deepEqual(p.consume(frame({type:'response',id:'wrong',command:'prompt',success:true})),[{type:'error',code:'uncorrelated_response',turnId:'b'}]); assert.throws(()=>p.encode('third','c'),/unavailable/);
 const q=new PiChatProtocol(); q.encode('x','id'); assert.deepEqual(q.consume(frame({type:'extension_ui_request',id:'x'})),[{type:'error',code:'unsupported_ui_request',turnId:'id'}]);
});
test('codec operates against an actual synthetic child pipe', async () => {
 const {spawn}=await import('node:child_process'); const {resolve}=await import('node:path');
 const p=new PiChatProtocol(); const child=spawn(resolve('tests/fixtures/pi-chat/fake-pi.mjs'),['--mode','rpc','--no-session'],{env:{PATH:process.env.PATH},stdio:'pipe'});
 try {
  const events=[]; const got=new Promise((ok,fail)=>{const t=setTimeout(()=>fail(new Error('timeout')),2000); child.stdout.on('data',chunk=>{events.push(...p.consume(chunk)); if(events.some(e=>e.type==='boundary')) {clearTimeout(t);ok();}});child.on('error',fail);});
  child.stdin.write(p.encode('hello','realpipe')); await got;
  assert.ok(events.some(e=>e.type==='accepted' && e.turnId==='realpipe')); assert.ok(events.some(e=>e.type==='delta' && e.text==='你好')); assert.ok(events.some(e=>e.type==='boundary'));
 } finally { child.kill('SIGTERM'); await new Promise(r=>child.once('close',r)); }
});
