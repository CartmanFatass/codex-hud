// Fixed synthetic Pi runtime: no provider is invoked. The v3 session/context
// below belongs to this disposable fake, not an official Pi installation.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createLabPiExtensionContextGuard, makeLabPiContextExecute, PI_EXTENSION_CONTEXT_PROFILE } from './pi-extension-context.mjs';
const root=process.env.HUD_HOME, keys=Object.keys(process.env).sort();
writeFileSync(join(root,'observed-env.json'),JSON.stringify(keys),{mode:0o600});
if (keys.some((k)=>['NODE_OPTIONS','EXAMPLE_SECRET','OPENAI_API_KEY','ANTHROPIC_API_KEY'].includes(k))) process.exit(3);
let input=''; for await (const chunk of process.stdin) input+=chunk;
if (!input.includes('synthetic workbench brief')) process.exit(2);
if (input.includes('hold for cancellation')) { await delay(30000); process.exit(0); }
const id='synthetic-pi-session', sessionFile=join(root,'synthetic-pi-session.jsonl');
writeFileSync(sessionFile,JSON.stringify({type:'session',version:3,id,cwd:root,timestamp:new Date().toISOString()})+'\n',{mode:0o600});
const ctx={sessionManager:{getSessionId:()=>id,getSessionFile:()=>sessionFile,getSessionDir:()=>root}};
const guard=createLabPiExtensionContextGuard({profile:PI_EXTENSION_CONTEXT_PROFILE,canonicalSourceDir:root});
const lifecycle=guard.start();
const reporter=spawn(process.execPath,[process.env.HUD_LAB_PI_HELPER],{cwd:root,env:process.env,stdio:['pipe','pipe','pipe']});
reporter.stderr.resume(); let pending=Buffer.alloc(0), seq=0, waiter=null, failed=null;
reporter.stdout.on('data',(chunk)=>{
  pending=Buffer.concat([pending,chunk]); if(pending.length>16384) { failed=Error('channel_overflow'); reporter.kill('SIGTERM'); waiter?.reject(failed); return; }
  let at; while((at=pending.indexOf(10))>=0) {
    const line=pending.subarray(0,at);pending=pending.subarray(at+1);
    try {const reply=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line)); if(!waiter||reply.seq!==waiter.seq) throw Error('unexpected_reply'); const active=waiter;waiter=null;active.resolve(reply.result);}
    catch(error){failed=error;waiter?.reject(error);reporter.kill('SIGTERM');}
  }
});
reporter.on('error',(error)=>{failed=error;waiter?.reject(error)});
reporter.on('exit',()=>{if(waiter){waiter.reject(Error('reporter_closed'));waiter=null;}});
async function execute(tool,args,callId) {
  // This invokes the pinned extension-shaped execute signature; the capture
  // adapter ignores params and uses only trusted context + tool identity.
  const toolExecute=makeLabPiContextExecute({lifecycle,toolName:tool,onCapture:async (fresh)=>{
    if(fresh.status!=='ready') return {ok:false,code:'identity_source_missing'};
    if(failed||waiter) throw Error('source_unavailable');
    const current=++seq;
    const answer=new Promise((resolve,reject)=>{waiter={seq:current,resolve,reject};});
    const payload=Buffer.from(JSON.stringify({seq:current,tool,snapshot:fresh,args})+'\n');
    if(payload.length>16384) throw Error('channel_overflow');
    if(!reporter.stdin.write(payload)) await new Promise((resolve,reject)=>{reporter.stdin.once('drain',resolve);reporter.stdin.once('error',reject)});
    return Promise.race([answer,delay(12000,undefined,{ref:false}).then(()=>{throw Error('reporter_timeout')})]);
  }});
  return toolExecute(callId,args,undefined,undefined,ctx);
}
try {
  let bound;
  for(let i=0;i<150;i++) {
    const result=await execute('delegate_whoami',{},'synthetic-pi-whoami');
    if(result.ok&&result.state==='bound'){bound=true;break;}
    if(result.ok&&result.state==='pending' || ['busy','claim_not_armed','stale_context'].includes(result.code)){await delay(40);continue;}
    throw Error('pi_binding_refused:'+(typeof result.code==='string'?result.code:'unknown'));
  }
  if(!bound) throw Error('pi_binding_timeout');
  const report=await execute('delegate_report',{runId:process.env.HUD_RUN,status:'completed',summary:'SIMULATED Pi child report'},'synthetic-pi-report');
  if(!report.ok) throw Error('pi_report_refused');
  await delay(4000);
} finally {
  lifecycle.shutdown();
  reporter.stdin.end(JSON.stringify({kind:'shutdown'})+'\n');
  if(reporter.exitCode===null && reporter.signalCode===null) reporter.kill('SIGTERM');
}
