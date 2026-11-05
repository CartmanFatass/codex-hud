// Render only from the real delegation view; synthetic Jobs stay separate.
import { delegationView, delegationAgentsRows } from '../../dist/render/delegation/panel.js';
import { resolveSelection } from '../../dist/render/delegation/selection.js';
import { inspectorRows } from '../../dist/render/monitor-inspector.js';
import { initialMonitorState } from '../../dist/render/monitor.js';
import { stripAnsi } from '../../dist/render/colors.js';

export function buildUnifiedFrame(vm,jobs,selected=null,width=88,ordinary=null) {
  const nowMs=Date.now(), view=delegationView(vm,{nowMs,style:'rich',showHistory:true});
  const jobRows=jobs.map((j)=>({key:'job:'+JSON.stringify(j.identity.ref),job:j}));
  const isJob=jobRows.some((j)=>j.key===selected);
  const selectedId=isJob?selected:resolveSelection(selected,view.proj,view.plan,view.dest);
  const agents=delegationAgentsRows(vm,{width,nowMs,style:'rich',showHistory:true,selectedId:isJob?null:selectedId}).map((r)=>stripAnsi(r.text));
  const jobLines=jobRows.map(({key,job})=>`${key===selectedId?'›':' '} SIMULATED Jev ${job.identity.ref.key} · ${job.fakeState} · holder ${job.holderLabel??'none'} · generation ${job.holderGeneration??'none'}`);
  let details=[];
  if(isJob){const job=jobRows.find((j)=>j.key===selectedId).job; details=[`SIMULATED Job ${job.identity.ref.key}`,`State: ${job.fakeState}`,`Holder: ${job.holderLabel??'none'} · generation ${job.holderGeneration??'none'}`,`Dispatches: ${job.dispatches} · reconciled: ${job.reconciled}`, 'No real browser or provider action.'];}
  else {const state=initialMonitorState();state.tree.selectedId=selectedId;state.preview='agent';details=inspectorRows({},state,width,nowMs,view).map((r)=>stripAnsi(r.text));}
  const destinations=[...view.dest.rows.map((r)=>r.key),...jobRows.map((j)=>j.key)];
  const node=vm.tree.nodes.find((n)=>n.key===selectedId);
  return {ledgerId:vm.tree.ledger.ledgerId,selectedId,destinations,agents,jobLines,details,ordinary,selectedRunId:node?.currentRun?.runId??null,relations:vm.tree.relations.map((r)=>({label:r.link.label,harness:r.currentRun?.harness??null,state:r.currentRun?.state??null,bound:r.link.childRef!==null,runId:r.currentRun?.runId??null})),jobs:jobs.map((j)=>({provenance:j.provenance,state:j.fakeState,holder:j.holderLabel??null,generation:j.holderGeneration??null}))};
}
export function moveUnifiedSelection(frame,delta){const rows=frame.destinations;if(!rows.length)return null;const at=Math.max(0,rows.indexOf(frame.selectedId));return rows[Math.max(0,Math.min(rows.length-1,at+delta))];}
