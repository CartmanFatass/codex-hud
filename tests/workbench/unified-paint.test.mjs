import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaintGate } from '../../scripts/workbench/unified-paint.mjs';
test('a late frame never writes after shutdown',async()=>{
 let finish;let writes=0;const pending=new Promise((r)=>{finish=r});
 const gate=createPaintGate(()=>pending,()=>writes++,()=>false);
 const first=gate.paint();assert.strictEqual(gate.paint(),first);gate.stop();finish('late');await first;
 assert.equal(writes,0);assert.equal(await gate.drain(50),true);
});
test('bounded drain reports an unfinished frame and still suppresses its later write',async()=>{
 let finish;let writes=0;const pending=new Promise((r)=>{finish=r});
 const gate=createPaintGate(()=>pending,()=>writes++,()=>false);const first=gate.paint();gate.stop();
 assert.equal(await gate.drain(20),false);finish('late');await first;assert.equal(writes,0);
});
