import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { handshakeFixture, hashClaim } from '../../dist-test/tests/unit/b45-handshake-fixture.js';
import { DelegationService } from '../../dist-test/packages/hud-mcp/src/delegation.js';
import { scopeSnapshot } from '../../dist-test/src/ledger/call-context.js';
import { makeLabPiPreparer } from '../../scripts/workbench/pi-preparer.mjs';

async function setup(preparer) {
  const f=await handshakeFixture(); const executable=join(f.root,'synthetic-pi');
  writeFileSync(executable,'#!/bin/sh\nexit 0\n',{mode:0o700});
  const brief=join(f.root,'brief'); writeFileSync(brief,'synthetic workbench brief');
  const profile={name:'synthetic-pi',harness:'pi',source:{root:f.root,label:'SIMULATED'},launch:{argv:[executable]},headless:{argv:[executable,'--session-dir',f.root]},resume:null,resumeHeadless:null,host:{kind:'none',layout:'none'},env:{},mcpServerName:'hud',claimTransport:'config_env',clientToolTimeoutMs:60000,responseMarginMs:2000,orphan_policy:'continue',managedShellVerified:false,roles:{implementer:{model:'synthetic-model'}}};
  let launches=0, capabilities=0;
  const service=new DelegationService({ledger:f.ledger,home:f.root,config:{version:1,profiles:[profile]},registration:f.parent.registration,reader:f.reader,env:{},hudRunPath:resolve('bin/hud-run'),...(preparer?{launchPreparers:{pi:preparer(f.root,executable)}}:{}),capability:{verify:()=>{capabilities++;return {ok:true,reason:null}}},launch:async()=>{launches++;return {pid:1,completion:Promise.resolve({code:0,signal:null})}}});
  const args={backend:'synthetic-pi',role:'implementer',brief,cwd:f.root,mode:'headless',request_key:'new-pi'};
  const before=f.ledger.snapshot((tx)=>tx.get('SELECT count(*) AS n FROM runs').n);
  async function invoke() {
    for(let i=0;i<10;i++) {
      const source={ok:true,callId:'synthetic-call',sessionRef:f.parent.ref,processKey:f.parent.authority.evidence.processKey,evidenceDigest:hashClaim('synthetic-source'),scopePremise:f.ledger.snapshot((tx)=>scopeSnapshot(tx,f.ledger.ledgerId,f.parent.authority.evidence.processKey))};
      try{return await service.invoke(source,'delegate_spawn',args)}catch(e){if(e.code!=='ledger_busy'||i===9)throw e;await delay(20)}
    }
  }
  return {...f,service,invoke,before,stats:()=>({launches,capabilities,runs:f.ledger.snapshot((tx)=>tx.get('SELECT count(*) AS n FROM runs').n)}),cleanup:async()=>{await service.close();await f.close()}};
}
test('default Pi preparer refuses an unconfigured extension profile before capability or dispatch',async()=>{
  const f=await setup(); try {await assert.rejects(f.invoke(),{message:'pi_managed_extension_required'});assert.deepEqual(f.stats(),{launches:0,capabilities:0,runs:f.before})} finally {await f.cleanup()}
});
for(const field of ['harness','sourceRoot','sourceId','cwd','profile','keyHarness','keySource','keyMode','keyOperation','keyHost','keyLayout','inputRun','inputSource','inputProfile','inputCwd','inputMode']) {
 test(`trusted Pi preparer mismatch ${field} is rejected before capability and dispatch`,async()=>{
  const f=await setup((root,executable)=>{
   const prepare=makeLabPiPreparer(root,executable);
   return async(options)=>{
    const p=await prepare(options), result={...p};
    if(field==='harness')result.harness='codex'; if(field==='sourceRoot')result.sourceRoot='/tmp';
    if(field==='sourceId')result.sourceId='invalid'; if(field==='cwd')result.cwd='/tmp'; if(field==='profile')result.profileDigest='invalid';
    if(field.startsWith('key'))result.capabilityRequest=(...args)=>{const r=p.capabilityRequest(...args);return {...r,sourceId:field==='keySource'?'invalid':r.sourceId,key:{...r.key,...(field==='keyHarness'?{harness:'codex'}:{}),...(field==='keyMode'?{mode:'visible'}:{}),...(field==='keyOperation'?{operation:'resume'}:{}),...(field==='keyHost'?{hostKind:'tmux'}:{}),...(field==='keyLayout'?{layout:'pane'}:{})}}};
    if(field.startsWith('input'))result.forRun=(...args)=>{const launch=p.forRun(...args), input={...launch.input,...(field==='inputRun'?{runId:'bad'}:{}),...(field==='inputSource'?{sourceId:'bad'}:{}),...(field==='inputProfile'?{profileDigest:'bad'}:{}),...(field==='inputCwd'?{cwd:'/tmp'}:{}),...(field==='inputMode'?{mode:'visible'}:{})};return {...launch,input,payload:{...launch.payload,input}}};
    return result;
   };
  });
  try {await assert.rejects(f.invoke(),/launch_preparation_mismatch/);assert.deepEqual(f.stats(),{launches:0,capabilities:0,runs:f.before})} finally {await f.cleanup()}
 });
}

test('Pi lab preparer refuses model and effort overrides',async()=>{
  const f=await setup();
  try {
    const executable=join(f.root,'synthetic-pi'), prepare=makeLabPiPreparer(f.root,executable);
    const options={profile:{name:'synthetic-pi',harness:'pi',source:{root:f.root},headless:{argv:[executable,'--session-dir',f.root]},host:{kind:'none',layout:'none'}},cwd:f.root,operation:'spawn',mode:'headless',role:'implementer',briefPath:join(f.root,'brief')};
    await assert.rejects(prepare({...options,model:'other'}),/unsupported_lab_pi_profile/);
    await assert.rejects(prepare({...options,effort:'high'}),/unsupported_lab_pi_profile/);
  } finally {await f.cleanup()}
});
