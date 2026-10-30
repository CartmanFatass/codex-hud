/** Codex adaptation of toktrack's dashboard: overview, composition, ranking, trend. */
import type { UsageBucket, UsagePeriod, UsageQuery, UsageSnapshot, UsageTotals } from '../usage-types.js';
import type { UsageCost } from '../collectors/usage-pricing.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { MonitorControl } from './monitor.js';
import { theme, visualLength, truncateAnsi } from './colors.js';
import { flowLines, monitorText } from './monitor-text.js';
import { iconSet } from './hud-config.js';
import { t } from './i18n.js';
import { usageTheme as ink, usageCells } from './usage-theme.js';

export type UsageTab='overview'|'tasks'|'models'|'efforts'|'roles';
type Group='models'|'efforts'|'roles'|'projects';
export interface UsagePageState {period:UsagePeriod;scope:'all'|'task';tab:UsageTab;scroll:number;details?:boolean;
  measure?:'tokens'|'cost';group?:Group;selected?:number;filter?:UsageQuery['filter']}
type ControlKind='back'|'period'|'scope'|'refresh'|'measure'|'group'|'bucket'|UsageTab;
export interface UsageControl {kind:ControlKind;x:number;y:number;width:number;index?:number}
export interface UsageFrame {lines:string[];controls:UsageControl[];navigationControls:MonitorControl[];state:UsagePageState;
  count:number;total:number;buckets:UsageBucket[];bucketRows:number[];group:Group}
const TABS:UsageTab[]=['overview','tasks','models','efforts','roles'];
const LABELS:Record<UsageTab,string>={overview:'Overview',tasks:'Tasks',models:'Models',efforts:'Effort',roles:'Roles'};
const SHORT:Record<UsageTab,string>={overview:'All',tasks:'Task',models:'Model',efforts:'Effort',roles:'Role'};
const GLYPHS:Record<UsageTab,string>={overview:'◫',tasks:'◇',models:'◈',efforts:'≋',roles:'♙'};
const GROUPS:Group[]=['models','projects','efforts','roles'];
const GROUP_LABELS:Record<Group,string>={models:'Models',projects:'Projects',efforts:'Effort',roles:'Roles'};
const GROUP_ICONS:Record<Group,string>={models:'◈',projects:'⌂',efforts:'≋',roles:'♙'};
const PERIODS:UsagePeriod[]=['today','7d','30d','all'];
const PERIOD_LABELS:Record<UsagePeriod,string>={today:'Today','7d':'7 days','30d':'30 days',all:'All time'};
export const initialUsagePageState=():UsagePageState=>({period:'today',scope:'all',tab:'overview',scroll:0});
const symbol=(glyph:string)=>iconSet()==='text'?'':glyph+' ';
const fit=(text:string,width:number)=>{const cut=truncateAnsi(text,Math.max(0,width));return cut+' '.repeat(Math.max(0,width-visualLength(cut)));};
const pair=(left:string,right:string,width:number)=>{const end=truncateAnsi(right,width),start=truncateAnsi(left,Math.max(0,width-visualLength(end)-1));
  return start+' '.repeat(Math.max(0,width-visualLength(start)-visualLength(end)))+end;};
/** toktrack services/dashboard.rs fmt_tokens, decimal SI with one decimal. */
export function usageNumber(value:number|null):string{
  if(value===null||!Number.isFinite(value))return t('Unknown');
  for(const [unit,suffix] of [[1e9,'B'],[1e6,'M'],[1e3,'K']] as const)if(value>=unit)return `${(value/unit).toFixed(1)}${suffix}`;
  return Math.round(value).toString();
}
/** toktrack's estimated-price marker; missing prices remain unknown. */
export function usageMoney(cost?:UsageCost):string{
  if(cost?.usd==null)return '—';const cents=Math.round(cost.usd*100);
  return `$${(cents/100).toFixed(2)}${cents?'*':''}`;
}
/** OpenAI/Codex branches of toktrack normalizer::display_name. Raw keys stay in filters/pricing. */
export function usageModelName(key:string):string{
  const model=key.split('::')[0];
  if(model.endsWith(':fast'))return usageModelName(model.slice(0,-5))+' · Fast';
  const cap=(s:string)=>s?s[0].toUpperCase()+s.slice(1):s;
  if(model.startsWith('gpt-')){
    const parts=model.slice(4).split('-'),minor=parts.length>1&&/^\d{1,2}$/.test(parts[1]);
    const version=parts[0]+(minor?'.'+parts[1]:'');const rest=parts.slice(minor?2:1);
    return 'GPT-'+version+(rest.length?' '+rest.map(cap).join(' '):'');
  }
  if(model.startsWith('codex-'))return 'Codex '+model.slice(6).replace(/-latest$/,'').split('-').map(cap).join(' ');
  if(/^o\d/.test(model)){const [version,...rest]=model.split('-');return version+(rest.length?' '+rest.map(cap).join(' '):'');}
  return model;
}
const exact=(n:number|null)=>n===null?t('Unknown'):Math.round(n).toLocaleString('en-US');
const percent=(n:number|null,total:number|null)=>n===null||total===null||total<=0?null:Math.max(0,Math.min(100,n/total*100));
const pct=(n:number|null)=>n===null?'—':`${n.toFixed(0)}%`;
const value=(totals:UsageTotals,state:UsagePageState)=>state.measure==='cost'?totals.cost?.usd??null:totals.total;
const formatted=(totals:UsageTotals,state:UsagePageState)=>state.measure==='cost'?usageMoney(totals.cost):usageNumber(totals.total);
function card(title:string,rows:string[],width:number,preserveCase=false):string[]{
  if(width<6)return [truncateAnsi(title,width),...rows.map(row=>truncateAnsi(row,width))];
  const label=truncateAnsi(` ${preserveCase?title:title.toUpperCase()} `,width-2);
  return [ink.border('╭')+ink.muted(label)+ink.border('─'.repeat(Math.max(0,width-2-visualLength(label)))+'╮'),
    ...rows.map(row=>ink.border('│')+' '+fit(row,width-4)+' '+ink.border('│')),ink.border('╰'+'─'.repeat(width-2)+'╯')];
}
function groupFor(state:UsagePageState):Group{return state.tab==='models'||state.tab==='efforts'||state.tab==='roles'?state.tab:state.group??'models';}
function bucketsFor(snapshot:UsageSnapshot,state:UsagePageState):UsageBucket[]{
  const buckets=snapshot[groupFor(state)]??[];
  return [...buckets].sort((a,b)=>(value(b.totals,state)??-1)-(value(a.totals,state)??-1)||(a.key??'').localeCompare(b.key??''));
}
function composition(totals:UsageTotals,width:number):string[]{
  const inner=Math.max(1,width-4),parts=[totals.input===null||totals.cachedInput===null?null:Math.max(0,totals.input-totals.cachedInput),
    totals.output===null||totals.reasoningOutput===null?null:Math.max(0,totals.output-totals.reasoningOutput),totals.cachedInput,0,totals.reasoningOutput];
  const names=['Input','Output','Cached','Cache write','Reasoning'];
  const cells=usageCells(parts.map(n=>n??0),inner);
  const bar=parts.every(n=>n===null)?ink.track('─'.repeat(inner)):cells.map((n,i)=>ink.parts[i]('█'.repeat(n))).join('');
  const rows=[bar];let line='';
  for(let i=0;i<parts.length;i++){
    if(parts[i]===0)continue;
    const item=ink.parts[i]('■ ')+ink.muted(t(names[i])+' ')+ink.ink(usageNumber(parts[i]));
    if(line&&visualLength(line)+2+visualLength(item)>inner){rows.push(line);line='';}
    line+=(line?'  ':'')+item;
  }
  if(line)rows.push(line);
  return card(t('Token mix'),rows,width);
}
function trend(snapshot:UsageSnapshot,state:UsagePageState,width:number,height:number):string[]{
  const inner=Math.max(1,width-4),axis=Math.min(8,Math.max(1,Math.floor(inner/4))),room=Math.max(1,inner-axis-2);
  const slots=Math.max(1,Math.floor(room/2)),days=snapshot.daily,chunk=Math.max(1,Math.ceil(days.length/slots));
  const points:Array<{label:string;end:string;n:number|null}>=[];
  for(let i=0;i<days.length;i+=chunk){const set=days.slice(i,i+chunk),values=set.map(day=>value(day.totals,state)).filter((n):n is number=>n!==null);
    points.push({label:set[0].day.slice(5),end:set.at(-1)!.day.slice(5),n:values.length?values.reduce((a,b)=>a+b,0):null});}
  const max=Math.max(1,...points.map(p=>p.n??0)),h=Math.max(3,Math.min(12,height-4));
  const barWidth=Math.min(10,Math.max(1,Math.floor((room-Math.max(0,points.length-1))/Math.max(1,points.length))));
  const levels=' ▁▂▃▄▅▆▇█';const rows:string[]=[];
  for(let y=h-1;y>=0;y--){
    const label=y===h-1?(state.measure==='cost'?'$':'')+usageNumber(max):'';
    const bars=points.map((point,i)=>{const units=point.n===null?0:Math.round(point.n/max*h*8);const fill=Math.max(0,Math.min(8,units-y*8));
      return (i===points.length-1?ink.teal:ink.series[i%5])(levels[fill].repeat(barWidth));}).join(' ');
    rows.push(fit(ink.muted(label),axis)+' '+ink.border('│')+bars);
  }
  rows.push(fit(ink.muted('0'),axis)+' '+ink.border('└'+'─'.repeat(room)));
  rows.push(pair(points[0]?.label??'',points.at(-1)?.end??'',inner));
  return card(t(state.measure==='cost'?'Cost trend':'Usage trend'),rows,width);
}
function bodyRows(snapshot:UsageSnapshot,state:UsagePageState,width:number,available:number,bucketRows:number[]):string[]{
  const rows:string[]=[],inner=Math.max(1,width-4);
  const empty=t(snapshot.status==='ready'&&snapshot.totals.events===0?'No usage events in this range':'No indexed rows available for this view');
  if(state.details){
    const totals=snapshot.totals,c=totals.cost;
    rows.push(...card(t('Exact counts'),[
      `${t('Total tokens')}  ${exact(totals.total)}`,`${t('Input')}  ${exact(totals.input)}`,
      `${t('Cached input (part of input)')}  ${exact(totals.cachedInput)}`,`${t('Output')}  ${exact(totals.output)}`,
      `${t('Reasoning (part of output)')}  ${exact(totals.reasoningOutput)}`,
      `${t('Cost')}  ${usageMoney(c)}`,`${t('Priced requests')}  ${c?.pricedEvents??0} / ${totals.events}`,
      t('Estimated at API list rates; not a subscription bill'),
    ].flatMap(line=>flowLines(line,inner)),width),'');
    if(snapshot.pricing){
      rows.push(...card(t('Price source'),[snapshot.pricing.source,...Object.entries(snapshot.pricing.rates).flatMap(([name,r])=>[
        monitorText(name),r?`${t('Input')} $${r.input.toFixed(2)} / M · ${t('Output')} $${r.output.toFixed(2)} / M`:'—',
        ...(r?[`${t('Cached')} $${r.cachedInput.toFixed(2)} / M`,...(r.firstTier?[`${t('Tier')} > ${usageNumber(r.firstTier)}`]:[])]:[]),
      ])].flatMap(line=>flowLines(line,inner)),width),'');
    }
    const cvr=snapshot.coverage;
    rows.push(...card(t('Coverage'),[
      t('{indexed}/{found} files indexed',{indexed:cvr.filesIndexed,found:cvr.filesDiscovered}),
      t('{unreadable} unreadable · {malformed} malformed lines',{unreadable:cvr.filesUnreadable,malformed:cvr.malformedLines}),
      t('{parents} unresolved parents · {events} ambiguous events',{parents:cvr.unresolvedParents,events:cvr.ambiguousEvents}),
      t('Source: {source}',{source:monitorText(snapshot.source.label)}),monitorText(snapshot.source.codexHome),
      t('Local calendar: {zone}',{zone:monitorText(snapshot.range.timeZone)}),
      t('As of: {time}',{time:snapshot.updatedAtMs===null?t('Unknown'):new Date(snapshot.updatedAtMs).toISOString()}),
      ...(snapshot.message?[monitorText(t(snapshot.message))]:[]),
    ].flatMap(line=>flowLines(line,inner)),width));return rows;
  }
  if(state.filter)rows.push(ink.teal(symbol('⌕')+monitorText(state.filter.key??t('Unknown'))));
  if(state.tab==='overview'){
    const summary=snapshot.totals;
    const change=snapshot.comparison?.costChangePct;
    const delta=change===null||change===undefined?'':' '+(change>=0?ink.warn:ink.mint)((change>=0?'▲':'▼')+Math.abs(change).toFixed(Math.abs(change)>=9.95?0:1)+'%');
    rows.push(...card(`${t('Overview')} · ${t(PERIOD_LABELS[state.period])}`,[
      pair(symbol('$')+t('Cost'),ink.gold(theme.bold(usageMoney(summary.cost)))+delta,inner),
      pair(symbol('Σ')+t('Tokens'),ink.ink(theme.bold(usageNumber(summary.total))),inner),
      pair(symbol('↺')+t('Cache hit'),ink.teal(theme.bold(pct(percent(summary.cachedInput,summary.input)))),inner),
    ],width),'',...composition(summary,width),'');
  }
  if(state.tab==='tasks'){
    for(const task of snapshot.tasks){
      const project=task.project?.replaceAll('\\','/').split('/').filter(Boolean).at(-1);
      const at=task.firstAtMs===undefined?null:new Date(task.firstAtMs);
      const date=at&&Number.isFinite(at.getTime())?`${at.getFullYear()}-${String(at.getMonth()+1).padStart(2,'0')}-${String(at.getDate()).padStart(2,'0')} ${String(at.getHours()).padStart(2,'0')}:${String(at.getMinutes()).padStart(2,'0')}`:'';
      const title=task.title?.trim()||[project||t('Task'),date].filter(Boolean).join(' · ');
      rows.push(...card(symbol('◇')+monitorText(title),[
      pair(t('Cost'),ink.gold(usageMoney(task.total.cost)),inner),pair(t('Task total'),usageNumber(task.total.total),inner),
      pair(symbol('•')+t('Self'),usageNumber(task.self.total),inner),pair(symbol('└')+t('Descendants'),usageNumber(task.descendants.total),inner),
    ],width,true),'');
    }
    if(!snapshot.tasks.length&&snapshot.status!=='loading')rows.push(ink.muted(empty));return rows;
  }
  const buckets=bucketsFor(snapshot,state),shown=state.tab==='overview'?buckets.slice(0,5):buckets;
  const ranking:string[]=[];
  for(let i=0;i<shown.length;i++){
    const bucket=shown[i],share=percent(value(bucket.totals,state),value(snapshot.totals,state));
    const selected=(state.selected??0)===i;
    bucketRows.push(rows.length+1+ranking.length);
    const label=bucket.key===null?t('Unknown'):groupFor(state)==='models'?usageModelName(bucket.key):bucket.key;
    ranking.push(pair((selected?'› ':'  ')+monitorText(label),(state.measure==='cost'?ink.gold:ink.ink)(formatted(bucket.totals,state)),inner));
    const bars=usageCells([share??0,100-(share??0)],Math.max(1,inner-6));
    ranking.push(pair(ink.series[i%5]('▆'.repeat(bars[0]))+ink.track('─'.repeat(bars[1])),pct(share),inner));
  }
  if(buckets.length>shown.length)ranking.push(ink.muted(`+${buckets.length-shown.length}`));
  if(!shown.length)ranking.push(ink.muted(snapshot.status==='loading'?'…':empty));
  rows.push(...card(`${t(GROUP_LABELS[groupFor(state)])} · ${t(state.measure==='cost'?'Cost':'Tokens')}`,ranking,width));
  if(state.tab==='overview')rows.push('',...trend(snapshot,state,width,Math.max(7,available-rows.length-1)));
  return rows;
}

export function renderUsagePage(state:UsagePageState,snapshot:UsageSnapshot,width:number,height:number,
  navigation?:{lines:string[];controls:MonitorControl[]}):UsageFrame{
  width=Math.max(1,width);height=Math.max(1,height);
  const lines=(navigation?.lines??[]).slice(0,Math.max(0,height-1)).map(line=>fit(line,width));
  const navigationControls=(navigation?.controls??[]).filter(c=>c.y<lines.length),controls:UsageControl[]=[];
  const row=(items:Array<{kind:ControlKind;label:string;active?:boolean}>,tabs=false)=>{
    let text='';const push=()=>{if(lines.length<height)lines.push(fit(text,width));text='';};
    for(const item of items){const label=truncateAnsi(item.active?`[› ${item.label}]`:tabs?item.label:`[${item.label}]`,width);
      if(text&&visualLength(text)+1+visualLength(label)>width)push();if(lines.length>=height)break;if(text)text+=' ';
      controls.push({kind:item.kind,x:visualLength(text),y:lines.length,width:visualLength(label)});text+=(item.active?ink.teal:ink.muted)(label);
    }if(text)push();
  };
  if(!navigation&&lines.length<height)lines.push(fit(ink.ink(symbol('▥')+t('Codex usage')),width));
  const group=groupFor(state),compact=width<40;
  row([{kind:'back',label:iconSet()==='text'?t('Back'):'←'},{kind:'period',label:t(PERIOD_LABELS[state.period])},
    {kind:'scope',label:t(state.scope==='all'?'All':'Task')},{kind:'measure',label:compact?(state.measure==='cost'?'$':'Σ'):t(state.measure==='cost'?'Cost':'Tokens')},
    ...(state.tab==='overview'?[{kind:'group' as const,label:compact?GROUP_ICONS[group]:t(GROUP_LABELS[group])}]:[]),
    {kind:'refresh',label:iconSet()==='text'?t('Refresh'):'↻'}]);
  let tabs:Array<{kind:UsageTab;label:string;active:boolean}>=[];
  for(const level of ['icons','words','short'] as const){
    tabs=TABS.map(tab=>({kind:tab,label:(level==='icons'||tab===state.tab?symbol(GLYPHS[tab]):'')
      +t(level==='short'?SHORT[tab]:tab==='efforts'?'Intensity':LABELS[tab]),active:!state.details&&tab===state.tab}));
    if(tabs.reduce((n,tab)=>n+visualLength(tab.label)+(tab.active?4:0),TABS.length-1)<=width)break;
  }row(tabs,true);
  const count=Math.max(0,height-lines.length-1),bucketRows:number[]=[];
  const body=bodyRows(snapshot,state,width,count,bucketRows),buckets=bucketsFor(snapshot,state);
  const scroll=Math.max(0,Math.min(state.scroll,Math.max(0,body.length-count))),top=lines.length;
  lines.push(...body.slice(scroll,scroll+count).map(line=>fit(line,width)));
  for(let i=0;i<bucketRows.length;i++)for(const offset of [0,1]){
    const y=top+bucketRows[i]+offset-scroll;if(y>=top&&y<height-1)controls.push({kind:'bucket',index:i,x:0,y,width});
  }
  while(lines.length<height-1)lines.push(fit('',width));
  const status=snapshot.status==='ready'?(snapshot.totals.cost?.unpricedEvents?symbol('!')+t('Unpriced requests'):'')
    :symbol(snapshot.status==='loading'?'◌':'!')+t(snapshot.status==='loading'?'Indexing…':snapshot.status==='partial'?'Partial history':'Unavailable');
  if(lines.length<height)lines.push(fit(ink.muted(pair(status,body.length>count?`${scroll+1}–${Math.min(body.length,scroll+count)}/${body.length}`:'',width)),width));
  return {lines,controls,navigationControls,state:{...state,scroll},count,total:body.length,buckets,bucketRows,group};
}

export function handleUsageInput(state:UsagePageState,input:WorkbenchInput,frame:UsageFrame):{state:UsagePageState;action?:'close'|'refresh'}{
  const hit=input.type==='mouse'&&input.button==='left'?frame.controls.find(c=>input.y===c.y&&input.x>=c.x&&input.x<c.x+c.width):undefined;
  const kind=hit?.kind,key=input.type==='key'?input.key:input.type==='mouse'?input.button==='wheel-up'?'up':input.button==='wheel-down'?'down':'':'';
  if(['details','diagnostics'].includes(key))return {state:{...state,details:!state.details,scroll:0}};
  if(key==='escape'&&state.details)return {state:{...state,details:false,scroll:0}};
  if(key==='escape'&&state.filter)return {state:{...state,filter:undefined,selected:0,scroll:0}};
  if(key==='escape'||key==='close'||kind==='back')return {state,action:'close'};
  if(kind==='refresh'||key==='reset')return {state,action:'refresh'};
  if(kind==='period'||key==='filter')return {state:{...state,period:PERIODS[(PERIODS.indexOf(state.period)+1)%PERIODS.length],scroll:0,selected:0}};
  if(kind==='scope'||key==='sort')return {state:{...state,scope:state.scope==='all'?'task':'all',scroll:0,selected:0}};
  if(kind==='measure'||key==='main')return {state:{...state,measure:state.measure==='cost'?'tokens':'cost',scroll:0,selected:0}};
  if(kind==='group'||key==='detail-toggle')return {state:{...state,group:GROUPS[(GROUPS.indexOf(frame.group)+1)%GROUPS.length],tab:'overview',selected:0,scroll:0}};
  if(kind&&TABS.includes(kind as UsageTab))return {state:{...state,tab:kind as UsageTab,details:false,selected:0,scroll:0}};
  if(['tab','right','shift-tab','left'].includes(key)){const delta=key==='left'||key==='shift-tab'?-1:1;
    return {state:{...state,tab:TABS[(TABS.indexOf(state.tab)+delta+TABS.length)%TABS.length],details:false,selected:0,scroll:0}};
  }
  if((key==='enter'||kind==='bucket')&&!state.details){
    const selected=hit?.index??state.selected??0,bucket=frame.buckets[selected];
    if(bucket){const by=({models:'model',efforts:'effort',roles:'role',projects:'project'} as const)[frame.group];
      return {state:{...state,filter:{by,key:bucket.key},selected:0,scroll:0}};}
  }
  const max=Math.max(0,frame.total-frame.count);
  if(input.type==='key'&&!state.details&&['up','down'].includes(key)&&frame.bucketRows.length){
    const selected=Math.max(0,Math.min((state.selected??0)+(key==='down'?1:-1),frame.bucketRows.length-1)),at=frame.bucketRows[selected];
    return {state:{...state,selected,scroll:Math.max(0,Math.min(max,at<state.scroll?at:at>=state.scroll+frame.count?at-frame.count+2:state.scroll))}};
  }
  const delta=key==='up'?-1:key==='down'?1:key==='page-up'?-Math.max(1,frame.count):key==='page-down'?Math.max(1,frame.count):0;
  return {state:{...state,scroll:key==='home'?0:key==='end'?max:Math.max(0,Math.min(max,state.scroll+delta))}};
}
