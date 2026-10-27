/** A single pure activity modal. Parent owns collection, persistence and live-agent navigation. */
import type { ActivityAgent, ActivityEvent, ActivityReceipt, ActivityView } from '../collectors/activity-journal.js';
import { searchActivityAgents } from '../collectors/activity-journal.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import { theme, colors, visualLength, truncateAnsi } from './colors.js';
import { fit, monitorText, flowLines } from './monitor-text.js';
import { t } from './i18n.js';

export type ActivityHubTab = 'inbox' | 'updates' | 'find' | 'history' | 'sessions';
/** A recent session of this directory, for the Sessions tab: read from disk by the parent, never resumed by the HUD. */
export interface RecentSessionRow { id: string; modifiedAt: number; title?: string; current?: boolean }
export interface ActivityHubState { tab: ActivityHubTab; selected: number; query: string; querying: boolean; replayId?: string }
export type ActivityHubAction = {type:'close'} | {type:'target';agentId:string}
  | {type:'read';eventId:string;value:boolean} | {type:'snooze';eventId:string;until:number}
  | {type:'pin';agentId:string;value:boolean} | {type:'viewed';receipt:ActivityReceipt};
export interface ActivityHubRow {
  id: string; kind:'event'|'agent'|'snapshot'|'session'; text:string; detail?:string;
  agentId?:string; eventId?:string; snapshotId?:string; sessionId?:string; read?:boolean; pinned?:boolean; y?:number;
}
type ControlAction = ActivityHubAction | {type:'tab';tab:ActivityHubTab} | {type:'row';index:number} | {type:'back'} | {type:'query'};
export interface ActivityHubControl { x:number; y:number; width:number; action:ControlAction; label:string }
export interface ActivityHubFrame {
  lines:string[]; rows:ActivityHubRow[]; controls:ActivityHubControl[]; state:ActivityHubState;
  receipt:ActivityReceipt; nowMs:number;
}
// Sessions sits before History, so ← from the Inbox still reaches History.
const TABS: readonly ActivityHubTab[]=['inbox','updates','find','sessions','history'];
const TAB_LABELS: Record<ActivityHubTab,string>={inbox:'Inbox',updates:'Since viewed',find:'Find',history:'History',sessions:'Sessions'};
/** A session's age as the panel writes ages: 42s, 12m, 3h, 2d. */
function ago(at:number,now:number):string {
  const s=Math.max(0,Math.floor((now-at)/1000));
  return s<60 ? `${s}s` : s<3600 ? `${Math.floor(s/60)}m` : s<2*86_400 ? `${Math.floor(s/3600)}h` : `${Math.floor(s/86_400)}d`;
}
/**
 * A session's row, `room` wide: when it was last written, how long ago, its
 * title (or its id's head) and whether it is this one. Short of room the
 * date goes, then the title is cut; the age and the mark stay whole.
 */
function sessionRows(sessions:readonly RecentSessionRow[],now:number,room:number):ActivityHubRow[] {
  return sessions.map(s=>{
    const when=new Date(s.modifiedAt).toISOString().replace('T',' ').slice(5,16);
    const name=s.title ? monitorText(s.title) : s.id.slice(0,8);
    const head=[t('{age} ago',{age:ago(s.modifiedAt,now)})];
    const mark=s.current ? [t('this session')] : [];
    const join=(parts:string[])=>parts.join(' · ');
    let text=join([when,...head,name,...mark]);
    if(visualLength(text)>room) text=join([...head,name,...mark]);
    if(visualLength(text)>room) {
      const left=room-visualLength(join([...head,'',...mark]));
      text=join([...head,left>1 ? truncateAnsi(name,left) : '…',...mark]);
    }
    // The command, for the person to run where they choose: the HUD never runs it.
    return {id:`session:${s.id}`,kind:'session' as const,sessionId:s.id,text,detail:`codex resume ${s.id}`};
  });
}

/** The resume command, `width` wide, whole: the id on lines of its own when the line cannot hold it, never cut. */
function commandLines(id:string,width:number):string[] {
  if(visualLength(`$ codex resume ${id}`)<=width) return [`${colors.dim('$')} ${theme.accent(`codex resume ${id}`)}`];
  const room=Math.max(1,width-2); const lines=[`${colors.dim('$')} ${theme.accent('codex resume')}`];
  for(let i=0;i<id.length;i+=room) lines.push(`  ${theme.accent(id.slice(i,i+room))}`);
  return lines;
}
const EVENT_LABELS: Record<ActivityEvent['kind'],string>={approval:'Approval needed',failed:'Agent failed',completed:'Agent completed',
  'tool-failed':'Tool failed',health:'Health problem',mismatch:'State mismatch',git:'Git changed',summary:'Model summary changed',recovered:'Recovered'};
export function initialActivityHubState(tab:ActivityHubTab='inbox'):ActivityHubState {
  return {tab,selected:0,query:'',querying:tab==='find'};
}
function eventRow(e:ActivityEvent,agents:readonly ActivityAgent[],pins:readonly string[],at:number):ActivityHubRow {
  const a=agents.find(a=>a.id===e.agentId);
  const name=a ? a.name : e.agentId;
  const status=e.resolvedAt!==undefined && e.resolvedAt<=at ? ` · ${t('Resolved')}` : e.read ? ` · ${t('Read')}` : '';
  const source=e.source && e.kind!=='git' ? ` · ${monitorText(e.source)}` : '';
  return {id:e.id,kind:'event',eventId:e.id,agentId:e.agentId,read:e.read,pinned:!!e.agentId && pins.includes(e.agentId),
    text:`${t(EVENT_LABELS[e.kind])}${name ? ` · ${monitorText(name)}` : ''}${source}${status}`,
    detail:e.summary ? `${t('Model-written')}: ${monitorText(e.summary)}` : e.paths?.length ? e.paths.map(p=>monitorText(p)).join(' · ') : undefined};
}
function rowsFor(view:ActivityView,state:ActivityHubState,now:number,sessions:readonly RecentSessionRow[],width:number):ActivityHubRow[] {
  if(state.tab==='sessions') return sessionRows(sessions,now,Math.max(1,width-2));
  if(state.tab==='find') return searchActivityAgents(view,state.query).map(a=>({id:a.id,kind:'agent',agentId:a.id,pinned:view.pinnedIds.includes(a.id),
    text:`${view.pinnedIds.includes(a.id) ? `${t('Pinned')} · ` : ''}${monitorText(a.name)} · ${t(a.status)}`,
    detail:[a.role,a.agentPath].filter(Boolean).map(v=>monitorText(v!)).join(' · ')}));
  if(state.tab==='history') {
    const snapshot=view.history.find(s=>s.id===state.replayId);
    if(snapshot) {
      const agents:ActivityHubRow[]=snapshot.agents.map(a=>({id:`agent:${a.id}`,kind:'agent',agentId:a.id,pinned:view.pinnedIds.includes(a.id),
        text:`${monitorText(a.name)} · ${t(a.status)}`,detail:[a.role,a.agentPath].filter(Boolean).map(s=>monitorText(s!)).join(' · ')}));
      const ids=new Set(snapshot.eventIds);
      const events=view.events.filter(e=>ids.has(e.id) && e.at<=snapshot.at).reverse().map(e=>eventRow(e,snapshot.agents,view.pinnedIds,snapshot.at));
      return [...agents,...events];
    }
    return [...view.history].reverse().map(s=>({id:s.id,kind:'snapshot',snapshotId:s.id,
      text:`${new Date(s.at).toISOString().replace('T',' ').slice(0,19)} · ${t('{n} agents',{n:s.agents.length})}`}));
  }
  const events=state.tab==='inbox' ? view.events.filter(e=>e.attention && !e.read && e.resolvedAt===undefined && (e.snoozedUntil ?? 0)<=now)
    : view.events.filter(e=>!e.viewed);
  return events.slice().reverse().map(e=>eventRow(e,view.agents,view.pinnedIds,now));
}

/**
 * `receipt` includes only events on this actual frame. Opening, painting and closing perform no writes.
 * `sessions` are this directory's recent sessions, for the Sessions tab; the parent reads them only while it is open.
 */
export function renderActivityHub(view:ActivityView,state:ActivityHubState,width:number,height:number,nowMs:number,sessions:readonly RecentSessionRow[]=[]):ActivityHubFrame {
  width=Math.max(0,Math.floor(width)); height=Math.max(0,Math.floor(height));
  const rows=rowsFor(view,state,nowMs,sessions,width); const selected=Math.max(0,Math.min(state.selected,rows.length-1));
  state={...state,selected};
  const lines:string[]=[]; const controls:ActivityHubControl[]=[];
  const push=(text:string)=>{if(lines.length<height) lines.push(text);};
  const button=(label:string,action:ControlAction,selected=false)=>({label,action,text:selected ? theme.selected(` ${label} `) : ` ${label} `});
  const buttons=(items:Array<ReturnType<typeof button>>) => {
    let line=''; let x=0; let planned:Array<{item:ReturnType<typeof button>;x:number}>=[];
    const finish=()=>{
      if(!line || lines.length>=height) return;
      const y=lines.length; push(line);
      for(const p of planned) controls.push({x:p.x,y,width:Math.min(width-p.x,visualLength(p.item.text)),action:p.item.action,label:p.item.label});
      line=''; x=0; planned=[];
    };
    for(const item of items) {
      if(x && x+visualLength(item.text)>width) finish();
      if(lines.length>=height) break;
      planned.push({item,x}); line+=item.text; x+=visualLength(item.text);
    }
    finish();
  };
  push(theme.strong(t('Activity hub')));
  buttons(TABS.map(tab=>button(t(TAB_LABELS[tab]),{type:'tab',tab},tab===state.tab)));
  if(state.tab==='find') {
    const label=t('Search name, role or path'); const y=lines.length;
    push(`${state.querying ? '› ' : ''}${label}: ${monitorText(state.query)}`);
    if(y<height) controls.push({x:0,y,width,action:{type:'query'},label});
  }
  if(state.tab==='updates') {
    const labels=[view.availability.git==='unknown' ? t('Git unavailable') : view.availability.git==='stale' ? t('Git stale') : t('Git observed'),
      view.availability.model==='disabled' ? t('Model off; stored summaries only') : view.availability.model==='unknown' ? t('Model summaries unavailable') : t('Stored model summaries')];
    push(labels.join(' · '));
  }
  if(state.replayId && state.tab==='history') {
    push(theme.strong(t('Historical observation')));
    buttons([button(t('Back'),{type:'back'})]);
  }
  if(state.tab==='sessions') for(const line of flowLines(t(rows.length ? 'Started here; run the command to resume one' : 'No session started here in the last 7 days'),Math.max(1,width))) push(colors.dim(line));
  if(view.persistence==='pending') push(theme.warning(t('Activity save pending')));
  const selectedRow=rows[selected];
  const actionLabels=[...(selectedRow?.snapshotId ? [t('Replay')] : []),...(selectedRow?.agentId ? [t('Inspect')] : []),
    ...(selectedRow?.eventId ? [t(selectedRow.read ? 'Unread' : 'Read'),t('Snooze')] : []),
    ...(selectedRow?.agentId ? [t(selectedRow.pinned ? 'Unpin' : 'Pin')] : []),
    ...(state.tab==='updates' ? [t('Mark viewed')] : []),t('Close')];
  let actionRows=1; let actionWidth=0;
  for(const label of actionLabels) {
    const size=visualLength(` ${label} `);
    if(actionWidth && actionWidth+size>width) { actionRows++; actionWidth=0; }
    actionWidth+=size;
  }
  // A session's detail is its resume command, whole on as many lines as it takes; another row's, one line.
  const detailLines=selectedRow?.sessionId ? commandLines(selectedRow.sessionId,width) : selectedRow?.detail ? [selectedRow.detail] : [];
  const detailRows=detailLines.length && height-lines.length-actionRows>=detailLines.length+(selectedRow?.sessionId ? 1 : 2) ? detailLines.length : 0;
  const rowRoom=Math.max(0,height-lines.length-Math.min(actionRows,Math.max(0,height-lines.length-1))-detailRows);
  const start=Math.max(0,Math.min(selected-Math.floor(rowRoom/2),rows.length-rowRoom));
  const visible=rows.slice(start,start+rowRoom);
  for(let index=0;index<visible.length;index++) {
    const row=visible[index]; const actual=start+index; row.y=lines.length;
    controls.push({x:0,y:lines.length,width,action:{type:'row',index:actual},label:row.text});
    push(actual===selected ? theme.selected(`› ${row.text}`) : `  ${row.text}`);
  }
  const receipt:ActivityReceipt={rootId:view.rootId,through:view.receipt.through,eventIds:visible.flatMap(r=>r.eventId ? [r.eventId] : [])};
  const row=rows[selected];
  const actions:Array<ReturnType<typeof button>>=[];
  if(row?.snapshotId) actions.push(button(t('Replay'),{type:'row',index:selected}));
  if(row?.agentId) actions.push(button(t('Inspect'),{type:'target',agentId:row.agentId}));
  if(row?.eventId) {
    actions.push(button(t(row.read ? 'Unread' : 'Read'),{type:'read',eventId:row.eventId,value:!row.read}));
    actions.push(button(t('Snooze'),{type:'snooze',eventId:row.eventId,until:nowMs+10*60_000}));
  }
  if(row?.agentId) actions.push(button(t(row.pinned ? 'Unpin' : 'Pin'),{type:'pin',agentId:row.agentId,value:!row.pinned}));
  if(state.tab==='updates' && receipt.eventIds.length) actions.push(button(t('Mark viewed'),{type:'viewed',receipt}));
  actions.push(button(t('Close'),{type:'close'}));
  // Multiple actions remain reachable at narrow widths; scroll the rows rather than hiding controls.
  // The last line shows the selected row's primary actions; all actions also have keyboard equivalents.
  if(detailRows) for(const line of detailLines) push(line);
  buttons(actions);
  while(lines.length<height) lines.push('');
  return {lines:lines.map(line=>fit(line,width)),rows,controls,state,receipt,nowMs};
}

export function handleActivityHubInput(state:ActivityHubState,input:WorkbenchInput,frame:ActivityHubFrame):{state:ActivityHubState;action?:ActivityHubAction} {
  state={...frame.state,...state,selected:Math.max(0,Math.min(state.selected,frame.rows.length-1))};
  const row=frame.rows[state.selected];
  const act=(action:ControlAction):{state:ActivityHubState;action?:ActivityHubAction}=>{
    if(action.type==='tab') return {state:{...state,tab:action.tab,selected:0,querying:action.tab==='find',replayId:undefined}};
    if(action.type==='query') return {state:{...state,querying:true}};
    if(action.type==='back') return {state:{...state,replayId:undefined,selected:0}};
    if(action.type==='row') {
      const selected=frame.rows[action.index]; const next={...state,selected:action.index,querying:false};
      if(selected?.snapshotId) return {state:{...next,replayId:selected.snapshotId,selected:0}};
      return {state:next};
    }
    return {state,action};
  };
  if(input.type==='mouse') {
    if(input.button==='wheel-up' || input.button==='wheel-down') return {state:{...state,selected:Math.max(0,Math.min(frame.rows.length-1,state.selected+(input.button==='wheel-up' ? -1 : 1)))}};
    const c=frame.controls.find(c=>input.y===c.y && input.x>=c.x && input.x<c.x+c.width);
    return c ? act(c.action) : {state};
  }
  if(input.type==='paste') return state.tab==='find' ? {state:{...state,query:(state.query+input.text.replace(/[\x00-\x1f\x7f-\x9f]/g,'')).slice(0,240),selected:0,querying:true}} : {state};
  if(input.type!=='key') return {state};
  const {key,raw}=input;
  if(key==='escape' || raw==='\x1b') return state.replayId ? {state:{...state,replayId:undefined,selected:0}} : {state,action:{type:'close'}};
  if(state.tab==='find' && state.querying) {
    if(raw==='\x7f' || raw==='\b' || key==='backspace') return {state:{...state,query:[...state.query].slice(0,-1).join(''),selected:0}};
    if(raw && !/[\x00-\x1f\x7f-\x9f]/.test(raw)) return {state:{...state,query:(state.query+raw).slice(0,240),selected:0}};
  }
  if(key==='tab' || key==='shift-tab' || key==='left' || key==='right' || key==='next-tab' || key==='previous-tab') {
    const delta=['shift-tab','left','previous-tab'].includes(key) ? -1 : 1;
    return act({type:'tab',tab:TABS[(TABS.indexOf(state.tab)+delta+TABS.length)%TABS.length]});
  }
  if(key==='up' || key==='down' || key==='page-up' || key==='page-down' || key==='home' || key==='end') {
    const next=key==='home' ? 0 : key==='end' ? frame.rows.length-1 : state.selected+(key.startsWith('page-') ? 10 : 1)*(key==='up' || key==='page-up' ? -1 : 1);
    return {state:{...state,selected:Math.max(0,Math.min(frame.rows.length-1,next))}};
  }
  if(key==='enter' || key==='space') {
    if(row?.snapshotId) return {state:{...state,replayId:row.snapshotId,selected:0}};
    return row?.agentId ? {state,action:{type:'target',agentId:row.agentId}} : {state};
  }
  if(raw==='\x06' || raw==='/') return act({type:'tab',tab:'find'});
  if((raw==='r' || raw==='\x12' || key==='reset') && row?.eventId) return {state,action:{type:'read',eventId:row.eventId,value:!row.read}};
  if((raw==='s' || raw==='\x13' || key==='sort') && row?.eventId) return {state,action:{type:'snooze',eventId:row.eventId,until:frame.nowMs+10*60_000}};
  if((raw==='p' || raw==='\x10') && row?.agentId) return {state,action:{type:'pin',agentId:row.agentId,value:!row.pinned}};
  if((raw==='v' || raw==='\x16' || key==='detail-toggle') && state.tab==='updates') return {state,action:{type:'viewed',receipt:frame.receipt}};
  if(key==='close') return {state,action:{type:'close'}};
  return {state};
}
