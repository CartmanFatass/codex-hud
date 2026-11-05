// Lab-only private reporter. One fixed direct child per extension epoch.
// Context evidence is independently checked; no argv/PID/ancestry is substituted.
import { createHash } from 'node:crypto';
import { fstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { LinuxProcessReader, inferHarness, actualSourceRoot } from '../../packages/hud-mcp/dist/packages/hud-mcp/src/process.js';
import { registerCaller } from '../../packages/hud-mcp/dist/packages/hud-mcp/src/registry.js';
import { createLedgerCallerRegistry } from '../../packages/hud-mcp/dist/packages/hud-mcp/src/ledger-registry.js';
import { DelegationService } from '../../packages/hud-mcp/dist/packages/hud-mcp/src/delegation.js';
import { HudMcpServer } from '../../packages/hud-mcp/dist/packages/hud-mcp/src/server.js';
import { makeProcessKey } from '../../packages/hud-mcp/dist/src/core/identity.js';
import { scopeSnapshot } from '../../packages/hud-mcp/dist/src/ledger/call-context.js';
import { readProcess } from '../../packages/hud-mcp/dist/src/core/run/process.js';
import { sameProcessStamp } from '../../packages/hud-mcp/dist/src/core/supervision.js';
import { validateSnapshot } from './pi-extension-context.mjs';
import { createLabPiChannelState } from './pi-channel-state.mjs';
const root=realpathSync(process.env.HUD_HOME), reader=new LinuxProcessReader();
for (const fd of [0,1]) {
  const stat=fstatSync(fd);
  if ((!stat.isFIFO() && !stat.isSocket()) || stat.uid!==process.getuid()) throw Error('private_channel_required');
}
const self=reader.get(process.pid), parent=reader.get(self.ppid);
const expected=realpathSync(join(root,'pi-coding-agent','synthetic-pi'));
if (inferHarness(parent)!=='pi' || parent.argv[1]!==expected || actualSourceRoot(parent,'pi')!==root) throw Error('not_owned_lab_child');
const parentPid=parent.pid, parentStart=parent.procStart, domain=reader.domain(), parentStamp=readProcess(parent.pid)?.stamp;
if (!parentStamp || parentStamp.proc_start!==parentStart || parentStamp.boot_id!==domain.bootId || parentStamp.pid_domain!==domain.runPidDomain) throw Error('lab_parent_stamp_unverified');
const registry=await createLedgerCallerRegistry(root); let service;
try {
  const registration=await registerCaller({reader,registry,profile:{harness:'pi',source:{root,label:'SIMULATED Pi child'}},pid:process.pid,cwd:()=>process.cwd(),envPane:null,nowMs:Date.now()});
  if (!registration.source || registration.harnessPid!==parentPid || registration.harnessProcStart!==parentStart) throw Error('lab_registration_failed');
  const processKey=makeProcessKey('pi',registration.source.sourceId,domain.pidDomain,parentPid,parentStart);
  service=new DelegationService({ledger:registry.ledger,home:root,config:{version:1,profiles:[]},registration,reader,env:process.env,hudRunPath:join(root,'no-launch'),capability:{verify:()=>({ok:false,reason:'unsupported'})}});
  const channel=createLabPiChannelState();
  let pending=Buffer.alloc(0), closed=false;
  let activeFrame=null;
  const source={resolve:async (_meta,tool)=>{
    try {
    const value=activeFrame;
    if (!value || value.tool!==tool) return {ok:false,code:'identity_unverified'};
    if (!value || value.snapshot.toolName!==value.tool) throw Error('invalid_channel_request');
    const assertOwnedParent=()=>{
      const current=reader.get(parentPid), child=reader.get(process.pid), currentDomain=reader.domain();
      if (!sameProcessStamp(readProcess(parentPid)?.stamp??null,parentStamp) || current.procStart!==parentStart || child.ppid!==parentPid || child.procStart!==self.procStart || child.pidNamespace!==current.pidNamespace ||
          currentDomain.pidDomain!==domain.pidDomain || currentDomain.runPidDomain!==domain.runPidDomain ||
          inferHarness(current)!=='pi' || current.argv[1]!==expected || actualSourceRoot(current,'pi')!==root) throw Error('lab_parent_changed');
    };
    assertOwnedParent();
    const validated=await validateSnapshot(value.snapshot,root);
    if (validated.status!=='ready') return {ok:false,code:'identity_source_missing'};
    if (validated.headerDigest!==value.snapshot.headerDigest) throw Error('pi_header_changed_in_transit');
    assertOwnedParent();
    channel.pin(validated);
    const sessionRef={harness:'pi',sourceId:registration.source.sourceId,sessionId:validated.sessionId,threadId:null};
    return {ok:true,callId:validated.toolCallId,sessionRef,processKey,evidenceDigest:createHash('sha256').update(JSON.stringify({implementation:'pi_extension_source_v1',apiCommit:'781152fc24841dc54b22284514604048ebe5e2c9',epoch:validated.epoch,seq:value.seq,toolCallId:validated.toolCallId,toolName:value.tool,sessionRef,headerDigest:validated.headerDigest,parentStamp})).digest('hex'),scopePremise:registry.ledger.snapshot((tx)=>scopeSnapshot(tx,registry.ledger.ledgerId,processKey))};
    } catch (error) { channel.shutdown(); closed=true; throw error; }
  }};
  const server=new HudMcpServer(source,service);
  async function handle(value) {
    channel.admit(value); activeFrame=value;
    try {
      const reply=await server.handle({jsonrpc:'2.0',id:value.seq,method:'tools/call',params:{name:value.tool,arguments:value.args??{}}});
      return reply?.result?.structuredContent ?? {ok:false,code:'invalid_channel_request'};
    } finally { activeFrame=null; }
  }
  for await (const chunk of process.stdin) {
    pending=Buffer.concat([pending,chunk]); if (pending.length>16384) throw Error('channel_overflow');
    let index;
    while ((index=pending.indexOf(10))>=0) {
      const line=pending.subarray(0,index); pending=pending.subarray(index+1);
      if (!line.length) throw Error('empty_channel_request');
      const frame=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));
      if (frame.kind==='shutdown') { channel.shutdown(); closed=true; break; }
      const result=await handle(frame);
      if (!process.stdout.write(JSON.stringify({seq:frame.seq,result})+'\n')) await new Promise((r)=>process.stdout.once('drain',r));
    }
    if (closed) break;
  }
  if (!closed && pending.length) throw Error('truncated_channel_request');
} finally { await service?.close(); await registry.ledger.close(); }
