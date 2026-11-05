import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('one synthetic ledger drives panel, inspector, logs, jobs, replay and owned cancel',()=>{
 const r=spawnSync(process.execPath,[resolve('scripts/workbench/unified.mjs'),'--json'],{cwd:resolve('.'),encoding:'utf8',timeout:70000,env:{...process.env,OPENAI_API_KEY:'must-not-propagate',EXAMPLE_SECRET:'must-not-propagate'}});
 assert.equal(r.status,0,r.stderr);const v=JSON.parse(r.stdout);
 assert.match(v.label,/SIMULATED unified/); assert.ok(v.replaySame);assert.equal(v.dispatchCount,3);
 assert.equal(v.before.ledgerId,v.after.ledgerId);assert.ok(v.before.ledgerId);
 assert.ok(v.before.relations.every((r)=>['codex','pi'].includes(r.harness)));
 for(const h of ['codex','pi']) assert.ok(v.before.relations.some((r)=>r.harness===h&&r.bound&&r.label===`SIMULATED ${h==='pi'?'Pi':'Codex'}`));
 assert.ok(v.before.agents.some((s)=>s.includes('main')));assert.ok(v.before.agents.some((s)=>s.includes('SIMULATED Codex')));assert.ok(v.before.agents.some((s)=>s.includes('SIMULATED Pi')));
 assert.equal(v.before.ordinary.harness,'pi');assert.equal(v.before.ordinary.loaded,true);assert.match(v.before.ordinary.provenance,/sample not committed/);
 assert.equal(v.before.jobs.length,1);assert.deepEqual(v.before.jobs[0],{provenance:'SIMULATED',state:'uncertain',holder:'synthetic-owner',generation:1});
 assert.ok(v.before.jobLines.some((s)=>s.includes('SIMULATED Jev')&&s.includes('uncertain')));
 assert.ok(v.inspected.details.some((s)=>s.includes('SIMULATED Pi')));assert.ok(v.codexInspected.details.some((s)=>s.includes('SIMULATED Codex')));assert.match(v.codexLog,/SIMULATED child received brief/);
 assert.equal(v.cancel.accepted,true);assert.equal(v.unownedRefused,true);
 assert.ok(v.before.relations.find((r)=>r.runId===v.holdRun && !r.bound));
 assert.doesNotMatch(JSON.stringify(v),/must-not-propagate/);
});
