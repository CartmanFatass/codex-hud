import { createUnifiedWorld } from './unified-world.mjs';
import { buildUnifiedFrame, moveUnifiedSelection } from './unified-panel.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { createPaintGate } from './unified-paint.mjs';
const json=process.argv.includes('--json');
if(!json&&(!process.stdin.isTTY||!process.stdout.isTTY))throw Error('interactive_terminal_required');
let done=false; const stop=()=>{done=true;};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
const world=await createUnifiedWorld(); let selected=null, viewMode='inspector', notice='';
async function frame(){const vm=await world.view();if(!vm)throw Error('ledger_unavailable');return buildUnifiedFrame(vm,world.jobs(),selected,Math.max(50,Math.min(120,process.stdout.columns||88)),world.ordinary());}
async function selectRun(runId){const vm=await world.view();const node=vm.tree.nodes.find((n)=>n.currentRun?.runId===runId);if(!node)throw Error('selection_missing');selected=node.key;}
try {
 if(json && !done) {
  const before=await frame();
  await selectRun(world.piRun);const inspected=await frame();
  const piLog=world.logs(inspected.selectedRunId);
  await selectRun(world.codexRun);const codexInspected=await frame();
  const codexLog=world.logs(codexInspected.selectedRunId);
  await selectRun(world.holdRun);const selectedHold=await frame();
  const cancel=await world.cancel(selectedHold.selectedRunId);
  let unownedRefused=false;try{await world.cancel('unowned-run')}catch{unownedRefused=true;}
  await delay(200);
  const after=await frame();
  console.log(JSON.stringify({label:'SIMULATED unified workbench',before,inspected,codexInspected,piLog,codexLog,cancel:{ok:cancel.ok,accepted:cancel.accepted},unownedRefused,after,codexRun:world.codexRun,piRun:world.piRun,holdRun:world.holdRun,replaySame:world.codexRun===world.replayRun,dispatchCount:world.dispatchCount()}));
 } else if (!done) {
  const wasRaw=process.stdin.isRaw;process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');
  let handling=Promise.resolve();
  const gate=createPaintGate(async()=>{const f=await frame();selected=f.selectedId;let details=f.details;if(viewMode==='logs'&&f.selectedRunId){try{details=['Owned run stdout',...world.logs(f.selectedRunId).split('\n')]}catch{details=['Log unavailable'];}}return '\x1b[H\x1b[2J'+'SIMULATED unified HUD · j/k select · i inspect · l logs · c cancel · r refresh · q quit\n'+f.agents.join('\n')+'\n\nOrdinary Pi observation: '+JSON.stringify(f.ordinary)+'\n\nSIMULATED Jobs (separate from sessions)\n'+f.jobLines.join('\n')+'\n\nInspector\n'+details.join('\n')+'\n\n'+notice+'\n';},(text)=>process.stdout.write(text),()=>done);
  const paint=()=>gate.paint();
  const onData=(key)=>{handling=handling.then(async()=>{if(done)return;if(key==='q'||key==='\u0003'){stop();return;}const f=await frame();selected=f.selectedId;if(key==='j'||key==='\x1b[B')selected=moveUnifiedSelection(f,1);else if(key==='k'||key==='\x1b[A')selected=moveUnifiedSelection(f,-1);else if(key==='i')viewMode='inspector';else if(key==='l')viewMode='logs';else if(key==='c'){if(!f.selectedRunId)notice='No owned run selected.';else {const result=await world.cancel(f.selectedRunId);notice='Cancellation request: '+(result.accepted?'accepted':(result.code??'not accepted'))+'; final outcome remains observed separately.';}}await paint();}).catch(()=>{notice='Action unavailable; no retry.';});};
  process.stdin.on('data',onData);
  const timer=setInterval(()=>void paint().catch(()=>{notice='View unavailable.';}),1000);
  try{await paint();while(!done)await delay(100);await handling;}finally{clearInterval(timer);gate.stop();await gate.drain();process.stdin.off('data',onData);process.stdin.setRawMode(Boolean(wasRaw));process.stdin.pause();process.stdout.write('\x1b[0m\n');}
 }
} finally {await world.close();process.off('SIGTERM',stop);process.off('SIGINT',stop);}
