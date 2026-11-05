// Lab-only MCP-side stand-in. The session identity and Codex label are simulated;
// the reader otherwise uses the actual Linux process stamps and ancestry.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LinuxProcessReader } from '../../packages/hud-mcp/dist/packages/hud-mcp/src/process.js';
import { registerCaller } from '../../packages/hud-mcp/dist/packages/hud-mcp/src/registry.js';
import { createLedgerCallerRegistry } from '../../packages/hud-mcp/dist/packages/hud-mcp/src/ledger-registry.js';
import { HandshakeService } from '../../packages/hud-mcp/dist/packages/hud-mcp/src/handshake.js';
import { authorizeRootCall, scopeSnapshot } from '../../packages/hud-mcp/dist/src/ledger/call-context.js';
import { makeProcessKey } from '../../packages/hud-mcp/dist/src/core/identity.js';
const root=realpathSync(process.env.HUD_HOME);
const native=new LinuxProcessReader();
const self=native.get(process.pid), parent=native.get(self.ppid);
const expected=realpathSync(join(root,'synthetic-codex'));
if (!parent.argv[1] || realpathSync(parent.argv[1])!==expected || realpathSync(parent.env.CODEX_HOME)!==root) throw Error('not_owned_lab_child');
const parentStart=parent.procStart;
const reader={domain:()=>native.domain(),get:(pid)=>{
  const p=native.get(pid);
  if (pid===parent.pid) {
    if (p.procStart!==parentStart || !p.argv[1] || realpathSync(p.argv[1])!==expected || realpathSync(p.env.CODEX_HOME)!==root) throw Error('lab_parent_changed');
    return {...p,argv:['/synthetic/codex',...p.argv.slice(1)]};
  }
  return p;
}};
const registry=await createLedgerCallerRegistry(root);
try {
  const registration=await registerCaller({reader,registry,profile:{harness:'codex',source:{root,label:'SIMULATED Codex child'}},pid:process.pid,cwd:()=>process.cwd(),envPane:null,nowMs:Date.now()});
  if (!registration.source || registration.harnessPid!==parent.pid) throw Error('lab_registration_failed');
  const processKey=makeProcessKey('codex',registration.source.sourceId,reader.domain().pidDomain,parent.pid,parentStart);
  const ref={harness:'codex',sourceId:registration.source.sourceId,sessionId:'synthetic-codex-child',threadId:null};
  const authority=await authorizeRootCall(registry.ledger,{callerId:registration.caller.callerId,processKey,sessionRef:ref,evidenceDigest:createHash('sha256').update('SIMULATED source session').digest('hex'),premise:registry.ledger.snapshot((tx)=>scopeSnapshot(tx,registry.ledger.ledgerId,processKey)),at:Date.now()});
  const service=new HandshakeService({ledger:registry.ledger,registration,reader,home:root,env:process.env});
  let binding;
  for (let i=0;i<150;i++) {
    try { binding=await service.whoami({},authority); if (binding.ok && binding.state==='bound') break; }
    catch(error) { if (!['claim_not_armed','stale_context','ledger_busy'].includes(error.message) && error.code!=='ledger_busy') throw error; }
    await delay(40);
  }
  if (!binding?.ok || binding.state!=='bound') throw Error('lab_binding_unavailable');
  const report=await service.report({runId:process.env.HUD_RUN,status:'completed',summary:'SIMULATED child report'},authority);
  if (!report.ok) throw Error('lab_report_rejected');
  console.log(JSON.stringify({binding:binding.state,report:report.ok}));
} finally { await registry.ledger.close(); }
