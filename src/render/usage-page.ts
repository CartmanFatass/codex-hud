/** Local Codex usage. Rendering and navigation use only the supplied memory snapshot. */
import type { UsageBucket, UsagePeriod, UsageSnapshot, UsageTotals } from '../usage-types.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import { colors, theme, visualLength, truncateAnsi } from './colors.js';
import { flowLines, monitorText } from './monitor-text.js';
import { t } from './i18n.js';

export type UsageTab = 'overview' | 'tasks' | 'models' | 'efforts' | 'roles';
export interface UsagePageState { period: UsagePeriod; scope: 'all' | 'task'; tab: UsageTab; scroll: number }
type ControlKind = 'back' | 'period' | 'scope' | 'refresh' | UsageTab;
export interface UsageControl { kind: ControlKind; x: number; y: number; width: number }
export interface UsageFrame { lines: string[]; controls: UsageControl[]; state: UsagePageState; count: number; total: number }
const TABS: UsageTab[] = ['overview','tasks','models','efforts','roles'];
const LABELS: Record<UsageTab,string> = {overview:'Overview',tasks:'Tasks',models:'Models',efforts:'Effort',roles:'Roles'};
const PERIODS: UsagePeriod[] = ['today','7d','30d'];
const PERIOD_LABELS: Record<UsagePeriod,string> = {today:'Today','7d':'7 days','30d':'30 days'};
export const initialUsagePageState = (): UsagePageState => ({period:'today',scope:'all',tab:'overview',scroll:0});
type UsageLine = string | {text:string;paint:(text:string)=>string};
const dim=(text:string):UsageLine=>({text,paint:colors.dim});
const strong=(text:string):UsageLine=>({text,paint:theme.strong});
const accent=(text:string):UsageLine=>({text,paint:theme.accent});

/** Exact counts stay readable and unknown counters never become zero. */
export function usageNumber(value: number | null): string {
  return value === null ? t('Unknown') : value.toLocaleString('en-US');
}
function totalsRows(totals: UsageTotals): UsageLine[] {
  return [strong(`${t('Total tokens')}  ${usageNumber(totals.total)}`),
    `${t('Input')}  ${usageNumber(totals.input)}`,
    `${t('Cached input (part of input)')}  ${usageNumber(totals.cachedInput)}`,
    `${t('Output')}  ${usageNumber(totals.output)}`,
    `${t('Reasoning (part of output)')}  ${usageNumber(totals.reasoningOutput)}`,
    dim(t('{events} events · {threads} threads',{events:totals.events,threads:totals.threads}))];
}
function bucketRows(buckets: UsageBucket[]): UsageLine[] {
  return buckets.flatMap(bucket => [strong(monitorText(bucket.key ?? t('Unknown'))),...totalsRows(bucket.totals),'']);
}
function bodyRows(snapshot: UsageSnapshot, state: UsagePageState, width: number): UsageLine[] {
  const stamp=(ms:number)=>new Date(ms).toISOString().slice(5,16).replace('T',' ');
  const empty=t(snapshot.status==='ready' && snapshot.totals.events===0
    ? 'No usage events in this range' : 'No indexed rows available for this view');
  const rows:UsageLine[] = [dim(t('Source: {source}',{source:monitorText(snapshot.source.label)})),
    dim(t('UTC range: {start} → {end}',{start:stamp(snapshot.range.startMs),end:stamp(snapshot.range.endMs)})),
    dim(t('As of: {time}',{time:snapshot.updatedAtMs===null?t('Unknown'):`${stamp(snapshot.updatedAtMs)} UTC`})),
    dim(t('Local rollout counters; no billing estimate'))];
  if (snapshot.status !== 'ready') rows.push({paint:theme.warning,text:t(snapshot.status === 'loading' ? 'Indexing local history…'
    : snapshot.status === 'partial' ? 'Partial history — coverage below' : 'Local usage unavailable')});
  if (snapshot.message) rows.push(monitorText(t(snapshot.message)));
  if (state.tab === 'overview') {
    rows.push('',...totalsRows(snapshot.totals),'',strong(t('Daily tokens')));
    const max = Math.max(1,...snapshot.daily.map(day=>day.totals.total ?? 0));
    const barWidth = Math.max(1,Math.min(20,width-14));
    for (const day of snapshot.daily) {
      const n = day.totals.total;
      // Unknown days have no bar; zero is a known empty day.
      const bar = n === null ? '' : '━'.repeat(Math.round(n/max*barWidth));
      rows.push(`${monitorText(day.day)}  ${usageNumber(n)}`);
      if (bar) rows.push(accent(`  ${bar}`));
    }
    if (!snapshot.daily.length && snapshot.status !== 'loading') rows.push(dim(empty));
  } else if (state.tab === 'tasks') {
    rows.push('',dim(t('Each task includes its descendants once')));
    for (const task of snapshot.tasks) rows.push('',strong(monitorText(task.rootId)),
      `${t('Self')}  ${usageNumber(task.self.total)}`,
      `${t('Descendants')}  ${usageNumber(task.descendants.total)}`,
      `${t('Task total')}  ${usageNumber(task.total.total)}`);
    if (!snapshot.tasks.length && snapshot.status !== 'loading') rows.push(dim(empty));
  } else {
    const buckets = state.tab === 'models' ? snapshot.models : state.tab === 'efforts' ? snapshot.efforts : snapshot.roles;
    rows.push('',...bucketRows(buckets));
    if (!buckets.length && snapshot.status !== 'loading') rows.push(dim(empty));
  }
  const c = snapshot.coverage;
  rows.push('',strong(t('Coverage')),
    t('{indexed}/{found} files indexed',{indexed:c.filesIndexed,found:c.filesDiscovered}),
    t('{unreadable} unreadable · {malformed} malformed lines',{unreadable:c.filesUnreadable,malformed:c.malformedLines}),
    t('{parents} unresolved parents · {events} ambiguous events',{parents:c.unresolvedParents,events:c.ambiguousEvents}),
    dim(t('Source: {source}',{source:monitorText(snapshot.source.label)})),
    dim(monitorText(snapshot.source.codexHome)),
    dim(t('Range: {start} → {end}',{start:new Date(snapshot.range.startMs).toISOString(),end:new Date(snapshot.range.endMs).toISOString()})),
    dim(t('Local calendar: {zone}',{zone:monitorText(snapshot.range.timeZone)})),
    dim(t('As of: {time}',{time:snapshot.updatedAtMs === null ? t('Unknown') : new Date(snapshot.updatedAtMs).toISOString()})));
  return rows;
}

export function renderUsagePage(state: UsagePageState, snapshot: UsageSnapshot, width: number, height: number): UsageFrame {
  width = Math.max(1,width); height = Math.max(1,height);
  const lines: string[] = [], controls: UsageControl[] = [];
  const fit = (text: string) => { const cut=truncateAnsi(text,width); return cut+' '.repeat(Math.max(0,width-visualLength(cut))); };
  // Wrap controls whole, keeping every action labelled and reachable even at 32 columns.
  const row = (items: Array<{kind:ControlKind;label:string;active?:boolean}>) => {
    let text = '';
    const push = () => { if (lines.length < height) lines.push(fit(text)); text=''; };
    for (const item of items) {
      const label = truncateAnsi(`[${item.active?'› ':''}${item.label}]`,width);
      if (text && visualLength(text)+1+visualLength(label)>width) push();
      if (lines.length >= height) break;
      if (text) text+=' ';
      controls.push({kind:item.kind,x:visualLength(text),y:lines.length,width:visualLength(label)});
      text += item.active ? theme.accent(label) : colors.dim(label);
    }
    if (text) push();
  };
  row([{kind:'back',label:t('Back')},{kind:'refresh',label:t('Refresh')}]);
  if (lines.length<height) lines.push(fit(theme.strong(t('Codex usage'))));
  row([{kind:'period',label:t(PERIOD_LABELS[state.period])},{kind:'scope',label:t(state.scope==='all'?'All local history':'Current task')}]);
  row(TABS.map(tab=>({kind:tab,label:t(LABELS[tab]),active:tab===state.tab})));
  // Wrap plain text first: flowLines must never split the renderer's ANSI escapes.
  const body = bodyRows(snapshot,state,width).flatMap(row=>flowLines(typeof row==='string'?row:row.text,width)
    .map(line=>typeof row==='string'?line:row.paint(line)));
  const count = Math.max(0,height-lines.length-1);
  const scroll = Math.max(0,Math.min(state.scroll,Math.max(0,body.length-count)));
  lines.push(...body.slice(scroll,scroll+count).map(fit));
  while (lines.length<height-1) lines.push(fit(''));
  if (lines.length<height) lines.push(fit(colors.dim(t('Rows {from}–{to}/{total}',{from:body.length?scroll+1:0,to:Math.min(body.length,scroll+count),total:body.length}))));
  return {lines,controls,state:{...state,scroll},count,total:body.length};
}

export function handleUsageInput(state: UsagePageState, input: WorkbenchInput, frame: UsageFrame):
  {state:UsagePageState;action?:'close'|'refresh'} {
  let kind: ControlKind | undefined;
  if (input.type==='mouse' && input.button==='left') kind=frame.controls.find(c=>input.y===c.y && input.x>=c.x && input.x<c.x+c.width)?.kind;
  const key = input.type==='key' ? input.key : input.type==='mouse' ? input.button==='wheel-up'?'up':input.button==='wheel-down'?'down':'' : '';
  if (key==='escape' || key==='close' || kind==='back') return {state,action:'close'};
  if (kind==='refresh' || key==='reset') return {state,action:'refresh'};
  if (kind==='period' || key==='filter') return {state:{...state,period:PERIODS[(PERIODS.indexOf(state.period)+1)%PERIODS.length],scroll:0}};
  if (kind==='scope' || key==='sort') return {state:{...state,scope:state.scope==='all'?'task':'all',scroll:0}};
  if (kind && TABS.includes(kind as UsageTab)) return {state:{...state,tab:kind as UsageTab,scroll:0}};
  if (['tab','right','shift-tab','left'].includes(key)) {
    const delta=key==='left'||key==='shift-tab'?-1:1;
    return {state:{...state,tab:TABS[(TABS.indexOf(state.tab)+delta+TABS.length)%TABS.length],scroll:0}};
  }
  const max=Math.max(0,frame.total-frame.count);
  const delta=key==='up'?-1:key==='down'?1:key==='page-up'?-Math.max(1,frame.count):key==='page-down'?Math.max(1,frame.count):0;
  return {state:{...state,scroll:key==='home'?0:key==='end'?max:Math.max(0,Math.min(max,state.scroll+delta))}};
}
