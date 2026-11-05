// Disposable lab composition. All parent authority and capability evidence is synthetic.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openLedger } from '../../dist/ledger/ledger.js';
import { insertRecord } from '../../dist/ledger/records.js';
import { scopeSnapshot } from '../../dist/ledger/call-context.js';
import { makeSourceId, makeProcessKey, sessionRefKey } from '../../dist/core/identity.js';
import { deriveProcessDomain } from '../../dist/core/process-domain.js';
import { DelegationService } from '../../packages/hud-mcp/dist/packages/hud-mcp/src/delegation.js';
import { launchPreparedRun } from '../../packages/hud-mcp/dist/src/core/launch/supervisor.js';
import { openLinkLedgerReader } from '../../dist/core/link-ledger-read.js';
import { LinkTickCollector } from '../../dist/core/link/tick.js';
import { loadLimits } from '../../dist/core/link/limits.js';
import { delegationAgentsRows } from '../../dist/render/delegation/panel.js';
import { stripAnsi } from '../../dist/render/colors.js';
import { createRunFactPort } from '../../dist/core/run/ledger-port.js';
import { readProcess, processState } from '../../dist/core/run/process.js';
import { sameProcessStamp } from '../../dist/core/supervision.js';
import { mergeStatus, STATUS_RULE_VERSION } from '../../dist/core/status/merge.js';
import { makeLabPiPreparer } from './pi-preparer.mjs';
import { digest } from '../../packages/hud-mcp/dist/src/core/canonical.js';
import { launchProfileDigest } from '../../packages/hud-mcp/dist/src/core/capabilities.js';

// Never delete a caller-supplied directory: own a new private child root even
// when someone directly executes this runner with a valid-looking environment.
if (Object.keys(process.env).some((k)=>!['HOME','HUD_HOME','CODEX_HOME','PATH','LANG','TMPDIR'].includes(k))) throw Error('lab_environment_not_isolated');
const root=mkdtempSync(join(tmpdir(),'hud-vertical-owned-'));
Object.assign(process.env,{HOME:root,HUD_HOME:root,CODEX_HOME:root,TMPDIR:root});
const hash = (s) => createHash('sha256').update(s).digest('hex');
const isPi=process.argv.includes('--pi');
const harness=isPi?'pi':'codex', childLabel=isPi?'Pi':'Codex';
const executable = join(root, `synthetic-${harness}`);
const fixture = readFileSync(resolve(`scripts/workbench/synthetic-${harness}.mjs`), 'utf8');
writeFileSync(executable, `#!${process.execPath}\n${fixture}`, { mode: 0o700 });
const brief = join(root, 'brief.txt');
writeFileSync(brief, 'synthetic workbench brief\n', { mode: 0o600 });
const db = await openLedger(join(root, 'ledger.sqlite'));
let service, collector; const dispatches = [], pendingDispatches = [], runIds = [];
try {
  const parentRoot = join(root, 'synthetic-claude'); mkdirSync(parentRoot, { mode: 0o700 });
  const parentId = makeSourceId('claude', parentRoot);
  const childId = makeSourceId(harness, root);
  const source = { sourceId: parentId, harness: 'claude', rootPath: parentRoot, label: 'SIMULATED Claude parent' };
  const domain = deriveProcessDomain({ machineId: 'synthetic-machine', bootId: 'synthetic-boot', pidNamespace: 'synthetic-pid-ns' });
  const pid = 990001, callerPid = 990002, start = '990001';
  const processKey = makeProcessKey('claude', parentId, domain.pidDomain, pid, start);
  const ref = { harness: 'claude', sourceId: parentId, sessionId: 'synthetic-claude-parent', threadId: null };
  const now = Date.now();
  const caller = { callerId:'lab-parent', instanceKind:'dedicated', harness:'claude', sourceId:parentId, pid:callerPid, procStart:'990002', ppid:pid, parentProcStart:start, cwd:root, envPane:null, startedAt:now, lastSeenAt:now, retiredAt:null };
  const scope = { processKey, generation:1, harness:'claude', sourceId:parentId, pidDomain:domain.pidDomain, harnessPid:pid, harnessProcStart:start, sessionRef:ref, boundBy:'trusted_session', bindingEvidenceId:'synthetic-parent-evidence', createdAt:now, closedAt:null };
  const context = { contextId:'lab-parent-context', generation:1, callerId:caller.callerId, kind:'dedicated', contextKey:'stdio', harness:'claude', sourceId:parentId, processKey, procGeneration:1, sessionRef:ref, boundBy:'trusted_session', bindingEvidenceId:'synthetic-parent-evidence', selectionEvidenceId:'synthetic-parent-evidence', createdAt:now, closedAt:null };
  await db.transaction((tx) => {
    insertRecord(tx, 'sources', source);
    tx.run('INSERT INTO sessions(session_ref,harness,source_id,session_id,thread_id) VALUES(?,?,?,?,?)', sessionRefKey(ref), 'claude', parentId, ref.sessionId, '');
    insertRecord(tx, 'evidence', { evidenceId:'synthetic-parent-evidence', runId:null, linkId:null, kind:'trusted_session', producer:'reconciler', fingerprint:hash('synthetic-parent-evidence'), payload:{ simulated:true }, observedAt:now, validatedAt:now, validation:'accepted' });
    insertRecord(tx, 'callers', caller); insertRecord(tx, 'caller_scopes', scope); insertRecord(tx, 'caller_contexts', context);
  });
  const processes = new Map([[pid, {pid, ppid:1, procStart:start, argv:['/synthetic/claude'], env:{}, pidNamespace:'synthetic-pid-ns'}], [callerPid, {pid:callerPid, ppid:pid, procStart:'990002', argv:['/synthetic/node'], env:{}, pidNamespace:'synthetic-pid-ns'}]]);
  const reader = { domain:() => domain, get:(id) => { const p=processes.get(id); if (!p) throw Error('process_missing'); return structuredClone(p); } };
  const profile = { name:`synthetic-${harness}`, harness, source:{root,label:`SIMULATED ${childLabel} child`}, launch:{argv:[executable]}, headless:{argv:[executable]}, resume:{argv:[executable,'{{sessionId}}']}, resumeHeadless:{argv:[executable,'{{sessionId}}']}, host:{kind:'none',layout:'none'}, env:{CODEX_HOME:root,HUD_LAB_HELPER:resolve('scripts/workbench/synthetic-handshake.mjs')}, mcpServerName:'hud', claimTransport:'config_env', clientToolTimeoutMs:60000, responseMarginMs:2000, orphan_policy:'continue', managedShellVerified:false, roles:{implementer:{model:'synthetic-model',effort:'low'}} };
  if (isPi) { profile.env={}; profile.resume=null; profile.resumeHeadless=null; }
  const registration = { caller, source, harnessPid:pid, harnessProcStart:start };
  let dispatchCount = 0, allowPiCapability = true;
  service = new DelegationService({ ledger:db, home:root, config:{version:1,profiles:[profile]}, registration, reader, env:{HOME:root,PATH:'/usr/bin:/bin',CODEX_HOME:root}, codexConfig:{mcp_servers:{hud:{command:'/synthetic/node'}}}, hudRunPath:resolve('bin/hud-run'), ...(isPi?{launchPreparers:{pi:makeLabPiPreparer(root,executable)}}:{}), capability:{verify:(request) => (!isPi || allowPiCapability) && request.executableIdentity.path === executable && request.sourceId === childId && request.key.harness === harness && request.key.mode === 'headless' && request.key.operation === 'spawn' && request.key.hostKind==='none' && request.key.layout==='none' && (!isPi || (request.profileFingerprint===digest({lab:'fixed-synthetic-pi',root,executable}) && request.key.profileDigest===launchProfileDigest(profile) && request.executableIdentity.version==='synthetic-lab')) ? {ok:true,reason:null} : {ok:false,reason:'lab_scope_only'}}, launch:async (prepared, ticket, options) => { dispatchCount++; const pending=launchPreparedRun(prepared,ticket,options); pendingDispatches.push(pending); const dispatched = await pending; dispatches.push(dispatched); return dispatched; } });
  const resolution = { ok:true, callId:'synthetic-call', sessionRef:ref, processKey, evidenceDigest:hash('synthetic-source'), scopePremise:db.snapshot((tx) => scopeSnapshot(tx, db.ledgerId, processKey)) };
  const args = { backend:`synthetic-${harness}`, role:'implementer', name:`SIMULATED ${childLabel} child`, brief, cwd:root, mode:'headless', request_key:'synthetic-workbench' };
  async function invoke(tool, values) {
    for (let i=0; i<12; i++) {
      try { return await service.invoke({...resolution, scopePremise:db.snapshot((tx)=>scopeSnapshot(tx,db.ledgerId,processKey))}, tool, values); }
      catch (error) { if (error.code !== 'ledger_busy' || i === 11) throw error; await delay(25); }
    }
  }
  const accepted = await invoke('delegate_spawn',args);
  if (!accepted.ok) throw Error('spawn rejected: '+JSON.stringify(accepted));
  runIds.push(accepted.runId);
  if (isPi) allowPiCapability=false;
  const replay = await invoke('delegate_spawn',args);
  if (isPi) allowPiCapability=true;
  if (replay.runId !== accepted.runId || replay.linkId !== accepted.linkId) throw Error('replay_mismatch');
  collector = new LinkTickCollector(await openLinkLedgerReader(join(root,'ledger.sqlite')),root,loadLimits(root));
  // The lab supplies only a synthetic parent observation. All relationship and
  // run facts below are read from SQLite, not fabricated native transcript data.
  const identity={kind:'session',ref};
  const statusProjection=mergeStatus({target:{nodeIdentity:identity,sourceGeneration:1},sources:[],asOfSeq:null,observationStamp:null,history:{continuity:'unknown'}},null,STATUS_RULE_VERSION,Date.now()).projection;
  const unknown={value:null,quality:'unknown',source:'synthetic:unavailable',asOf:Date.now()};
  const coverage={state:'complete',skipped:{},gaps:[],loaded:true};
  const parentSession={evidence:{ref,observation:{nodeIdentity:identity,statusProjection,conflict:null,spent:{tokens:unknown,costUsd:unknown},workspace:null,coverage,loaded:true,depth:0,evidenceStamp:'SIMULATED'},cwd:null,cwdSource:'unknown',cwdAsOf:null,startedAt:now,version:null,model:unknown,context:unknown,reports:[],native:[],linkEvidence:[],caps:{}},sourceGeneration:1,linkEvidenceCurrent:true,bytesRead:0,recordsRead:0,loaded:true,topology:{ref,sourceGeneration:1,children:[],loaded:true,bytesRead:0,recordsRead:0,coverage}};
  const readState = (id) => db.snapshot((tx)=>({run:tx.get('SELECT state,launch_phase,exit_code,harness FROM runs WHERE run_id=?',id), events:tx.all('SELECT kind FROM events WHERE run_id=? ORDER BY seq',id).map((e)=>e.kind), slotHeld:Number(tx.get('SELECT count(*) AS n FROM slots WHERE run_id=?',id).n)>0}));
  async function waitFor(id,predicate) {
    const deadline=Date.now()+20000;
    while (Date.now()<deadline) { const current=readState(id); if (predicate(current)) return current; await delay(40); }
    throw Error('run_state_timeout: '+JSON.stringify(readState(id)));
  }
  async function frame(label) {
    const vm=await collector.tick({roots:[identity],sessions:[parentSession],nowMs:Date.now()});
    if (!vm || vm.tree.ledger.state !== 'available') throw Error('panel_unavailable');
    return {label, panel:delegationAgentsRows(vm,{width:80,nowMs:Date.now(),style:'rich'}).map((row)=>stripAnsi(row.text)), relations:vm.tree.relations.map((r)=>({label:r.link.label,attribution:r.attribution,runId:r.currentRun?.runId??null,harness:r.currentRun?.harness??null,state:r.currentRun?.state??null,childBound:r.link.childRef!==null}))};
  }
  const frames=[];
  const active=await waitFor(accepted.runId,(s)=>s.run?.state==='running');
  frames.push(await frame('accepted / active'));
  let reports=[], reportedState=null;
  if (!isPi) {
    const reportDeadline=Date.now()+12000;
    while (Date.now()<reportDeadline && !db.snapshot((tx)=>tx.get('SELECT 1 FROM reports WHERE run_id=?',accepted.runId))) await delay(40);
    reports=db.snapshot((tx)=>tx.all('SELECT status,summary FROM reports WHERE run_id=?',accepted.runId));
    if (reports.length!==1) throw Error('lab_report_missing');
    reportedState=readState(accepted.runId);
    if (reportedState.run?.state!=='running' || !reportedState.slotHeld) throw Error('report_did_not_preserve_live_scope');
    frames.push(await frame('bound / reported'));
  }
  const ended=await waitFor(accepted.runId,(s)=>['ended','failed','cancelled'].includes(s.run?.state));
  frames.push(await frame('scope ended'));
  const secondBrief=join(root,'hold-brief.txt'); writeFileSync(secondBrief,'synthetic workbench brief: hold for cancellation\n',{mode:0o600});
  const second=await invoke('delegate_spawn',{...args,brief:secondBrief,request_key:'synthetic-cancel',name:`SIMULATED ${childLabel} cancellation`});
  if (!second.ok) throw Error('second_spawn_rejected');
  runIds.push(second.runId);
  const secondActive=await waitFor(second.runId,(s)=>s.run?.state==='running' && s.events.includes('scope.recorded'));
  frames.push(await frame('second run active'));
  const cancel=await invoke('delegate_cancel',{runId:second.runId,grace:0});
  const cancelled=await waitFor(second.runId,(s)=>['ended','failed','cancelled'].includes(s.run?.state));
  frames.push(await frame('cancellation outcome'));
  if (dispatches.length!==2) throw Error('unexpected_dispatch_count');
  const exits=await Promise.all(dispatches.map((d)=>d.completion));
  const output={label:`SIMULATED Claude parent → SIMULATED ${childLabel} child`,childEnvironment:JSON.parse(readFileSync(join(root,'observed-env.json'),'utf8')),first:{runId:accepted.runId,linkId:accepted.linkId,replayRunId:replay.runId,replayWithCapabilityDenied:isPi,active,reports,reportedState,ended},second:{runId:second.runId,active:secondActive,cancel:{accepted:cancel.accepted,ok:cancel.ok},cancelled},dispatchCount,supervisorExits:exits,frames};
  if (process.argv.includes('--json')) console.log(JSON.stringify(output));
  else {
    console.log(output.label+' (synthetic parent authority; no provider clients)');
    for (const item of frames) { console.log('\n--- '+item.label+' ---'); console.log(item.panel.join('\n')); console.log(JSON.stringify(item.relations)); }
    console.log('\nReplay same run: '+(accepted.runId===replay.runId)+'; total dispatches: '+dispatchCount+' (two distinct requests).');
    console.log('First terminal: '+JSON.stringify(ended)+'\nCancellation: '+JSON.stringify({cancel,cancelled}));
    console.log(isPi?'Pi intent remains unbound; native exit may be unknown.':'Binding/report use SIMULATED identity evidence; native exit may be unknown.');
  }
} finally {
  // If the lab fails mid-run, only signal exact, still-matching stamps owned by
  // these runs. Never signal a process name or an uncorroborated numeric group.
  await Promise.allSettled(pendingDispatches);
  let port;
  try {
    port=await createRunFactPort(root);
    for (const id of runIds) {
      const snap=await port.read(id).catch(()=>null); const meta=snap?.meta;
      if (meta?.scope && sameProcessStamp(readProcess(meta.scope.group_leader.pid)?.stamp ?? null,meta.scope.group_leader)) {
        try { process.kill(-meta.scope.pgid,'SIGKILL'); } catch {}
      }
      for (const stamp of [meta?.harness,meta?.supervisor]) {
        if (stamp && processState(stamp)==='alive' && sameProcessStamp(readProcess(stamp.pid)?.stamp ?? null,stamp)) {
          try { process.kill(stamp.pid,'SIGKILL'); } catch {}
        }
      }
    }
    await Promise.allSettled(dispatches.map((d)=>d.completion));
  } finally {
    await port?.close(); collector?.close(); await service?.close(); await db.close(); rmSync(root,{recursive:true,force:true});
  }
}
