/** Private local activity facts. Never reads rollouts, calls models, or stores public/raw conversation. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { HudData, SubagentTree, SubagentStatus } from '../types.js';
import type { AgentLogEntry } from './agent-log.js';
import { MODEL_KINDS } from './agent-log.js';
import type { GitChanges } from './git-changes.js';
import { eachThread } from './subagent-tree.js';
import { writePrivateFile } from './small-model.js';

export const ACTIVITY_LIMITS = { events: 500, agents: 200, history: 48, pins: 200, text: 240, paths: 40,
  keepMs: 30 * 86_400_000, bytes: 4 * 1024 * 1024 } as const;
export type ActivityKind = 'approval' | 'failed' | 'completed' | 'tool-failed' | 'health' | 'mismatch' | 'git' | 'summary' | 'recovered';
export interface ActivityAgent { id: string; name: string; role?: string; agentPath?: string; status: SubagentStatus }
export interface ActivityEvent {
  id: string; seq: number; kind: ActivityKind; at: number; evidenceAt?: number;
  agentId?: string; source?: string; summary?: string; paths?: string[];
  attention: boolean; read: boolean; viewed: boolean; snoozedUntil?: number; resolvedAt?: number;
}
export interface ActivitySnapshot { id: string; at: number; agents: ActivityAgent[]; eventIds: string[]; gitPaths?: string[] }
export interface ActivityReceipt { rootId: string; eventIds: string[]; through: number }
export interface ActivityView {
  rootId: string; events: ActivityEvent[]; agents: ActivityAgent[]; history: ActivitySnapshot[];
  pinnedIds: string[]; seenThrough: number; receipt: ActivityReceipt;
  /** Last successful local persistence; a locked/unwritable store leaves pending operations intact. */
  persistence: 'memory' | 'saved' | 'pending';
  availability: {git: 'unknown' | 'fresh' | 'stale'; model: 'unknown' | 'available' | 'disabled'};
}
/** Use collector:tree/status/worktrees keys for explicit successful collector reads. */
export interface ActivityHealthSignal { key: string; kind: 'health' | 'mismatch'; active: boolean; agentId?: string; at?: number }
export interface ActivityObservation {
  tree?: SubagentTree; data?: HudData | null;
  logs?: ReadonlyMap<string, readonly AgentLogEntry[]>;
  /** Absent/null/stale Git input does not assert a clean repository. */
  git?: GitChanges | null; gitObservedAt?: number; gitFresh?: boolean;
  healthSignals?: readonly ActivityHealthSignal[];
  modelAvailable?: boolean;
}
interface Fact { key: string; kind: ActivityKind; agentId?: string; source?: string; summary?: string; paths?: string[]; evidenceAt?: number; attention: boolean }
interface Observation { at: number; agents?: ActivityAgent[]; facts: Fact[]; conditions: Array<{key: string; fact?: Fact; recoveredAt?: number}>; gitPaths?: string[]; gitAvailability?: 'unknown'|'fresh'|'stale'; modelAvailability?: 'unknown'|'available'|'disabled' }
interface Store {
  version: 1; rootId: string; seq: number; seenThrough: number; events: ActivityEvent[];
  agents: ActivityAgent[]; history: ActivitySnapshot[]; pins: string[];
  known: Record<string, string>; active: Record<string, string>; activeKeys: Record<string,string>; recoveries: Record<string,number>; latest: Record<string,string>;
  gitAvailability?: 'unknown'|'fresh'|'stale'; modelAvailability?: 'unknown'|'available'|'disabled'; gitAt?: number; observedAt?: number; signature?: string; gitPaths?: string[];
}
type Operation = {type: 'observe'; value: Observation} | {type: 'read'; id: string; value: boolean}
  | {type: 'snooze'; id: string; until: number} | {type: 'pin'; id: string; value: boolean}
  | {type: 'viewed'; receipt: ActivityReceipt};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const clean = (value: string, max: number = ACTIVITY_LIMITS.text) => value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max);
const stamp = (value?: Date) => value && Number.isFinite(value.getTime()) ? value.getTime() : undefined;
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8.64e15;
const KINDS = new Set<ActivityKind>(['approval','failed','completed','tool-failed','health','mismatch','git','summary','recovered']);
const STATUSES = new Set(['starting','running','completed','error','unknown']);
const empty = (rootId: string): Store => ({version:1,rootId,seq:0,seenThrough:0,events:[],agents:[],history:[],pins:[],known:{},active:{},activeKeys:{},recoveries:{},latest:{}});
function agent(raw: ActivityAgent): ActivityAgent {
  return {id:clean(raw.id,128),name:clean(raw.name,80),status:STATUSES.has(raw.status) ? raw.status : 'unknown',
    ...(raw.role ? {role:clean(raw.role,80)} : {}), ...(raw.agentPath ? {agentPath:clean(raw.agentPath,240)} : {})};
}
/** Allow-list disk content as carefully as live inputs: old/corrupt files cannot inject raw fields. */
function parse(raw: unknown, rootId: string): Store {
  const out = empty(rootId); const value = raw as Partial<Store> | null;
  if (!value || value.version !== 1 || value.rootId !== rootId) return out;
  out.seq = validTime(value.seq) ? Math.floor(value.seq) : 0;
  out.seenThrough = validTime(value.seenThrough) ? Math.min(out.seq,value.seenThrough) : 0;
  const agents = (rows: unknown): ActivityAgent[] => Array.isArray(rows) ? rows.filter((a): a is ActivityAgent => !!a
    && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.status === 'string').slice(-ACTIVITY_LIMITS.agents).map(agent) : [];
  out.agents = agents(value.agents);
  if (Array.isArray(value.events)) for (const e of value.events.slice(-ACTIVITY_LIMITS.events)) {
    if (!e || !KINDS.has(e.kind) || typeof e.id !== 'string' || !validTime(e.seq) || !validTime(e.at)) continue;
    out.events.push({id:clean(e.id,128),seq:e.seq,at:e.at,kind:e.kind,attention:e.attention === true,read:e.read === true,viewed:e.viewed === true,
      ...(typeof e.agentId === 'string' ? {agentId:clean(e.agentId,128)} : {}),
      ...(typeof e.source === 'string' ? {source:clean(e.source,80)} : {}),
      ...(e.kind === 'summary' && typeof e.summary === 'string' ? {summary:clean(e.summary)} : {}),
      ...(Array.isArray(e.paths) ? {paths:e.paths.filter(p => typeof p === 'string').slice(0,ACTIVITY_LIMITS.paths).map(p=>clean(p))} : {}),
      ...(validTime(e.evidenceAt) ? {evidenceAt:e.evidenceAt} : {}),
      ...(validTime(e.snoozedUntil) ? {snoozedUntil:e.snoozedUntil} : {}),
      ...(validTime(e.resolvedAt) ? {resolvedAt:e.resolvedAt} : {})});
  }
  out.seq = Math.max(out.seq,...out.events.map(e=>e.seq));
  out.pins = Array.isArray(value.pins) ? [...new Set(value.pins.filter(p=>typeof p === 'string').map(p=>clean(p,128)))].slice(0,ACTIVITY_LIMITS.pins) : [];
  for (const key of ['known','active','activeKeys','latest'] as const) if (value[key] && typeof value[key] === 'object') {
    for (const [k,v] of Object.entries(value[key]!)) if (typeof v === 'string' && /^[a-f0-9]{32}$/.test(k)) out[key][k] = clean(v,128);
  }
  if(value.recoveries && typeof value.recoveries==='object') for(const [key,at] of Object.entries(value.recoveries).slice(-ACTIVITY_LIMITS.events)) {
    if(/^[a-f0-9]{32}$/.test(key) && validTime(at)) out.recoveries[key]=at;
  }
  if (['unknown','fresh','stale'].includes(value.gitAvailability ?? '')) out.gitAvailability=value.gitAvailability;
  if (['unknown','available','disabled'].includes(value.modelAvailability ?? '')) out.modelAvailability=value.modelAvailability;
  if (validTime(value.gitAt)) out.gitAt=value.gitAt;
  if (validTime(value.observedAt)) out.observedAt=value.observedAt;
  if (Array.isArray(value.gitPaths)) out.gitPaths = value.gitPaths.filter(p=>typeof p === 'string').slice(0,ACTIVITY_LIMITS.paths).map(p=>clean(p));
  if (typeof value.signature === 'string') out.signature = clean(value.signature,32);
  if (Array.isArray(value.history)) for (const h of value.history.slice(-ACTIVITY_LIMITS.history)) {
    if (!h || typeof h.id !== 'string' || !validTime(h.at)) continue;
    out.history.push({id:clean(h.id,128),at:h.at,agents:agents(h.agents),eventIds:Array.isArray(h.eventIds)
      ? h.eventIds.filter(id=>typeof id === 'string').slice(-ACTIVITY_LIMITS.events).map(id=>clean(id,128)) : [],
      ...(Array.isArray(h.gitPaths) ? {gitPaths:h.gitPaths.filter(p=>typeof p === 'string').slice(0,ACTIVITY_LIMITS.paths).map(p=>clean(p))} : {})});
  }
  return out;
}
function distilled(input: ActivityObservation, at: number, rootId: string): Observation {
  const value: Observation = {at,facts:[],conditions:[],
    ...(input.gitFresh === false || input.git?.error ? {gitAvailability:'stale' as const} : {}),
    ...(input.modelAvailable !== undefined ? {modelAvailability:input.modelAvailable ? 'available' as const : 'disabled' as const}
      : input.logs !== undefined ? {modelAvailability:'available' as const} : {})};
  const condition = (key: string, fact?: Fact, recoveredAt?:number) => value.conditions.push({key:hash(key),fact,...(validTime(recoveredAt) ? {recoveredAt} : {})});
  // A stale HudData may contain the last good tree. It cannot assert a new lifecycle state,
  // even when the caller separately passes that same cached tree.
  const tree = input.data?.stale ? undefined : input.tree ?? input.data?.subagentTree;
  if (tree?.rootId === rootId) {
    value.agents = [];
    eachThread(tree.nodes, n=>{
      if (value.agents!.length >= ACTIVITY_LIMITS.agents) return;
      const a = agent(n); value.agents!.push(a);
      const evidenceAt = stamp(n.statusAt ?? n.lastEventAt);
      const fact: Fact = {key:`agent:${a.id}:${n.status}:${evidenceAt ?? ''}`,kind:n.status === 'error' ? 'failed' : 'completed',agentId:a.id,evidenceAt,attention:n.status === 'error'};
      if(n.status!=='unknown') condition(`agent:${a.id}`,n.status === 'error' ? fact : undefined);
      if (n.status === 'completed') value.facts.push(fact);
    });
  }
  const data = input.data;
  if (data && !data.stale) {
    if(data.activity) condition('session-state',data.activity.state==='error'
      ? {key:`session:${stamp(data.activity.updatedAt) ?? ''}`,kind:'failed',agentId:rootId,evidenceAt:stamp(data.activity.updatedAt),attention:true} : undefined);
    const approval = data.pendingApproval;
    condition('approval',approval ? {key:`approval:${approval.callId ?? ''}:${stamp(approval.since) ?? ''}:${approval.kind}`,
      kind:'approval',agentId:rootId,source:approval.kind,evidenceAt:stamp(approval.since),attention:true} : undefined);
    for (const c of data.toolActivity?.recentCalls ?? []) if (c.status === 'error') value.facts.push({key:`tool:${c.id}:${stamp(c.timestamp) ?? ''}`,
      kind:'tool-failed',agentId:rootId,source:clean(c.name,80),evidenceAt:stamp(c.timestamp),attention:true});
    if (data.bridgeHealth) {
      const bridgeState=data.bridgeHealth.state==='connected' ? false
        : data.bridgeHealth.state==='disconnected' || data.bridgeHealth.state==='unresponsive' ? true : undefined;
      for (const [key,on] of [['state',bridgeState],
        ['mismatch',data.bridgeHealth.stateMismatch],['probe',data.bridgeHealth.probeFailed],['notifications',data.bridgeHealth.notificationGap]] as const) {
        // Missing optional values remain unknown; they cannot resolve an earlier failure.
        if (on === undefined) continue;
        condition(`bridge:${key}`,on ? {key:`bridge:${key}`,kind:key === 'mismatch' ? 'mismatch' : 'health',source:`bridge:${key}`,attention:true} : undefined);
      }
    }
    if (data.modelHealth) {
      const failure = data.modelHealth.lastFailure;
      condition('model',failure && !(data.modelHealth.lastSuccessAt && data.modelHealth.lastSuccessAt > failure.at)
        ? {key:`model:${failure.at}:${failure.feature}`,kind:'health',source:'model',evidenceAt:failure.at,attention:true} : undefined);
    }
  }
  // Collector health is itself current evidence even when the displayed payload is stale.
  const error = data?.health?.lastError;
  const gitRecovered=error?.source==='git' && input.gitFresh===true && input.git && !input.git.error && input.git.root!==null && validTime(input.gitObservedAt);
  if (error) condition(`collector:${clean(error.source,80)}`,gitRecovered || ['session','rollout'].includes(error.source) && data?.health?.lastReadAt && data?.health.lastReadAt > error.at ? undefined
      : {key:`health:${error.source}:${stamp(error.at)}`,kind:'health',source:clean(error.source,80),evidenceAt:stamp(error.at),attention:true},gitRecovered ? input.gitObservedAt : ['session','rollout'].includes(error.source) ? stamp(data?.health?.lastReadAt) : undefined);
  for (const signal of input.healthSignals ?? []) condition(signal.key.startsWith('collector:') ? clean(signal.key) : `signal:${clean(signal.key)}`, signal.active
    ? {key:`signal:${clean(signal.key)}`,kind:signal.kind,source:clean(signal.key,80),agentId:signal.agentId && clean(signal.agentId,128),evidenceAt:signal.at,attention:true} : undefined, !signal.active && signal.key.startsWith('collector:') ? signal.at ?? at : undefined);
  for (const [id,entries] of input.logs ?? []) {
    // Only the last stored model summary per kind/language. Public reports are never copied.
    const latest = new Map<string,AgentLogEntry>();
    for (const e of entries) if (MODEL_KINDS.has(e.kind) && validTime(e.at)) latest.set(`${e.kind}:${e.lang ?? ''}`,e);
    for (const [kind,e] of latest) if (e.text.trim()) value.facts.push({key:`summary:${clean(id,128)}:${kind}:${hash(e.text)}`,
      kind:'summary',agentId:clean(id,128),source:kind,summary:clean(e.text),evidenceAt:e.generatedAt ?? e.at,attention:false});
  }
  if (input.git && input.gitFresh === true && !input.git.error && input.git.root !== null && validTime(input.gitObservedAt)) {
    condition('collector:git',undefined,input.gitObservedAt);
    value.gitAvailability = 'fresh';
    value.gitPaths = input.git.files.map(f=>clean(f.path)).sort().slice(0,ACTIVITY_LIMITS.paths);
    const fingerprint = hash(input.git.files.map(f=>[f.path,f.previousPath,f.index,f.worktree,f.added,f.removed,f.binary,f.conflict]).sort());
    value.facts.push({key:`git:${fingerprint}`,kind:'git',source:fingerprint,paths:value.gitPaths,evidenceAt:input.gitObservedAt,attention:false});
  }
  return value;
}
function bound(store: Store, now: number): void {
  const activeIds=new Set(Object.values(store.active));
  const activeEvents=store.events.filter(e=>activeIds.has(e.id)).slice(-ACTIVITY_LIMITS.events);
  const recent=store.events.filter(e=>!activeIds.has(e.id) && e.at>=now-ACTIVITY_LIMITS.keepMs)
    .slice(-Math.max(0,ACTIVITY_LIMITS.events-activeEvents.length));
  store.events = [...activeEvents,...(activeEvents.length<ACTIVITY_LIMITS.events ? recent : [])].sort((a,b)=>a.seq-b.seq);
  store.history = store.history.filter(h=>h.at >= now-ACTIVITY_LIMITS.keepMs).slice(-ACTIVITY_LIMITS.history);
  const ids = new Set(store.events.map(e=>e.id));
  for (const key of Object.keys(store.known)) if (!ids.has(store.known[key])) delete store.known[key];
  // Active conditions remain deduplicated even after history expires, with a hard cap.
  store.recoveries=Object.fromEntries(Object.entries(store.recoveries).slice(-ACTIVITY_LIMITS.events));
  store.latest=Object.fromEntries(Object.entries(store.latest).slice(-ACTIVITY_LIMITS.events));
  store.activeKeys=Object.fromEntries(Object.entries(store.activeKeys).slice(-ACTIVITY_LIMITS.events));
  store.active = Object.fromEntries(Object.entries(store.active).slice(-ACTIVITY_LIMITS.events));
  // A maximally populated path list/agent catalog can hit the byte limit before the row limits.
  while(Buffer.byteLength(JSON.stringify(store),'utf8')>ACTIVITY_LIMITS.bytes) {
    if(store.history.length) store.history.shift();
    else if(store.events.length) {
      const disposable=store.events.findIndex(e=>!activeIds.has(e.id));
      const [removed]=store.events.splice(disposable<0 ? 0 : disposable,1);
      for(const key of Object.keys(store.known)) if(store.known[key]===removed.id) delete store.known[key];
    } else break;
  }
}
function apply(store: Store, op: Operation): void {
  if (op.type === 'read') { const e=store.events.find(e=>e.id===op.id); if(e) e.read=op.value; return; }
  if (op.type === 'snooze') { const e=store.events.find(e=>e.id===op.id); if(e) e.snoozedUntil=op.until; return; }
  if (op.type === 'pin') { store.pins=store.pins.filter(id=>id!==op.id); if(op.value) store.pins.push(op.id); store.pins=store.pins.slice(-ACTIVITY_LIMITS.pins); return; }
  if (op.type === 'viewed') {
    if(op.receipt.rootId!==store.rootId) return;
    const ids=new Set(op.receipt.eventIds);
    for(const e of store.events) if(ids.has(e.id) && e.seq<=op.receipt.through) e.viewed=true;
    // The cursor never skips an event which the user has not actually acknowledged.
    const first=store.events.find(e=>!e.viewed);
    store.seenThrough=Math.max(store.seenThrough,first ? first.seq-1 : store.seq); return;
  }
  const v=op.value;
  // A delayed writer cannot apply an older state sample over a more recent panel's observations.
  if(store.observedAt!==undefined && v.at<store.observedAt) return;
  store.observedAt=v.at;
  const add=(fact: Fact, salt='') => {
    const key=hash(fact.key+salt); if(store.known[key]) return store.known[key];
    const id=hash([store.rootId,key]);
    const {key:_,...fields}=fact;
    store.events.push({...fields,id,seq:++store.seq,at:v.at,read:false,viewed:false}); store.known[key]=id; return id;
  };
  for(const c of v.conditions) {
    const previous=store.active[c.key];
    if(c.recoveredAt!==undefined && previous) store.recoveries[c.key]=Math.max(store.recoveries[c.key] ?? 0,c.recoveredAt);
    if(c.fact) {
      if(c.fact.evidenceAt!==undefined && (store.recoveries[c.key] ?? -1)>=c.fact.evidenceAt) continue;
      const prior=store.events.find(e=>e.id===previous);
      const fingerprint=hash(c.fact.key);
      if(previous && store.activeKeys[c.key]===fingerprint) continue;
      if(previous && prior && prior.resolvedAt===undefined) prior.resolvedAt=v.at;
      store.active[c.key]=add(c.fact,`:${store.seq+1}`);
      store.activeKeys[c.key]=fingerprint;
    } else if(previous) {
      const prior=store.events.find(e=>e.id===previous);
      if(c.recoveredAt!==undefined && prior?.evidenceAt!==undefined && c.recoveredAt<prior.evidenceAt) continue;
      if(prior) prior.resolvedAt=v.at;
      add({key:`recovered:${c.key}:${previous}`,kind:'recovered',source:prior?.source ?? prior?.kind,agentId:prior?.agentId,attention:false}); delete store.active[c.key]; delete store.activeKeys[c.key];
    }
  }
  for(const fact of v.facts) {
    if(fact.kind==='git' || fact.kind==='summary') {
      const subject=hash(fact.kind==='git' ? 'git' : `summary:${fact.agentId}:${fact.source}`);
      const fingerprint=hash(fact.key);
      if(store.latest[subject]===fingerprint) continue;
      const first=store.latest[subject]===undefined;
      store.latest[subject]=fingerprint;
      if(fact.kind==='git' && first && !fact.paths?.length) continue;
      add(fact,`:${store.seq+1}`);
    } else add(fact);
  }
  if(v.gitAvailability) store.gitAvailability=v.gitAvailability;
  if(v.gitAvailability==='fresh') store.gitAt=v.at;
  if(v.modelAvailability) store.modelAvailability=v.modelAvailability;
  if(v.agents) store.agents=v.agents;
  if(v.gitPaths) store.gitPaths=v.gitPaths;
  const signature=hash([store.agents,store.gitPaths,store.events.at(-1)?.id,store.active]);
  if(signature!==store.signature) {
    store.signature=signature;
    store.history.push({id:hash([store.rootId,v.at,signature]),at:v.at,agents:structuredClone(store.agents),eventIds:store.events.map(e=>e.id),
      ...(store.gitPaths ? {gitPaths:[...store.gitPaths]} : {})});
  }
  bound(store,v.at);
}

export class ActivityJournal {
  private state: Store;
  private pending: Operation[]=[];
  private readonly file: string | null;
  private readonly now: ()=>number;
  private lastObservationFingerprint?: string;
  private lastRefreshAt=0;
  constructor(options: {codexHome?: string | null; rootId: string; now?: ()=>number}) {
    this.state=empty(clean(options.rootId,128)); this.now=options.now ?? Date.now;
    this.file=options.codexHome && this.state.rootId ? path.join(options.codexHome,'hud','activity',`${hash(this.state.rootId)}.json`) : null;
    this.state=this.read();
  }
  private read(): Store {
    if(this.file) try { if(fs.statSync(this.file).size<=ACTIVITY_LIMITS.bytes) return parse(JSON.parse(fs.readFileSync(this.file,'utf8')),this.state.rootId); } catch { /* first run/corrupt file */ }
    return empty(this.state.rootId);
  }
  private change(op: Operation): void { apply(this.state,op); this.pending.push(op); this.flush(); }
  observe(input: ActivityObservation): void {
    const now=this.now(); const value=distilled(input,now,this.state.rootId);
    const failures=new Map(value.conditions.flatMap(c=>c.fact?.evidenceAt!==undefined ? [[c.key,c.fact.evidenceAt] as const] : []));
    // Preserve the crossing of a known failure timestamp while ignoring success-only clock churn.
    // lastError can remain in HudData after recovery, so use its actual timestamp as a stable basis.
    const error=input.data?.health?.lastError;
    const errorAt=stamp(error?.at);
    if(error && errorAt!==undefined) failures.set(hash(`collector:${clean(error.source,80)}`),errorAt);
    for(const [key,id] of Object.entries(this.state.active)) {
      const event=this.state.events.find(e=>e.id===id);
      if(event?.evidenceAt!==undefined && !failures.has(key)) failures.set(key,event.evidenceAt);
    }
    const fingerprint=hash({...value,at:undefined,conditions:value.conditions.map(c=>({...c,recoveredAt:undefined,
      ...(c.recoveredAt!==undefined && failures.has(c.key) ? {recoversFailure:c.recoveredAt>=failures.get(c.key)!} : {})})),
      facts:value.facts.map(f=>f.kind==='git' ? {...f,evidenceAt:undefined} : f)});
    if(fingerprint===this.lastObservationFingerprint) {
      if(this.pending.length) this.flush();
      // A second panel's pins/read state becomes visible, without a lock or write on quiet ticks.
      else if(this.file && now-this.lastRefreshAt>=5000) { this.state=this.read(); this.lastRefreshAt=now; }
      if(value.gitAvailability==='fresh') this.state.gitAt=now;
      return;
    }
    this.lastObservationFingerprint=fingerprint; this.lastRefreshAt=now;
    this.change({type:'observe',value});
  }
  markRead(id: string, value=true): void { this.change({type:'read',id,value}); }
  snooze(id: string, until: number): void { if(validTime(until)) this.change({type:'snooze',id,until}); }
  pin(id: string, value=true): void { if(id) this.change({type:'pin',id:clean(id,128),value}); }
  markViewed(receipt: ActivityReceipt): void { this.change({type:'viewed',receipt:structuredClone(receipt)}); }
  /** No waiting or dropped writes: a competing writer leaves the queue for the next tick/close flush. */
  flush(): boolean {
    if(!this.file) { this.pending=[]; return true; }
    if(!this.pending.length) return true;
    const lock=`${this.file}.lock`; let held=false;
    try {
      fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
      try { fs.mkdirSync(lock,{mode:0o700}); held=true; }
      catch {
        // A crashed process leaves a recoverable lock. Never steal a live writer's lock.
        try {
          const owner=JSON.parse(fs.readFileSync(path.join(lock,'owner'),'utf8')) as {pid:number};
          if(!Number.isInteger(owner.pid) || owner.pid<=0) return false;
          try { process.kill(owner.pid,0); return false; } catch(e) { if((e as NodeJS.ErrnoException).code!=='ESRCH') return false; }
          fs.rmSync(lock,{recursive:true}); fs.mkdirSync(lock,{mode:0o700}); held=true;
        } catch {
          try {
            if(fs.existsSync(path.join(lock,'owner')) || this.now()-fs.statSync(lock).mtimeMs<300_000) return false;
            fs.rmSync(lock,{recursive:true}); fs.mkdirSync(lock,{mode:0o700}); held=true;
          } catch { return false; }
        }
      }
      fs.writeFileSync(path.join(lock,'owner'),JSON.stringify({pid:process.pid,nonce:randomUUID()}),{mode:0o600});
      const merged=this.read(); const before=JSON.stringify(merged);
      for(const op of this.pending) apply(merged,op);
      bound(merged,this.now()); const after=JSON.stringify(merged);
      if(after!==before) writePrivateFile(this.file,after);
      this.state=merged; this.pending=[]; return true;
    } catch { return false; }
    finally { if(held) try { fs.rmSync(lock,{recursive:true}); } catch { /* next flush retains pending changes */ } }
  }
  view(now=this.now()): ActivityView {
    bound(this.state,now);
    return structuredClone({rootId:this.state.rootId,events:this.state.events,agents:this.state.agents,history:this.state.history,
      pinnedIds:this.state.pins,seenThrough:this.state.seenThrough,
      receipt:{rootId:this.state.rootId,eventIds:this.state.events.map(e=>e.id),through:this.state.seq},
      availability:{git:this.state.gitAvailability==='fresh' && this.state.gitAt!==undefined && now-this.state.gitAt>15_000 ? 'stale' : this.state.gitAvailability ?? 'unknown', model:this.state.modelAvailability ?? 'unknown'},
      persistence:this.file ? this.pending.length ? 'pending' : 'saved' : 'memory'});
  }
  inbox(now=this.now()): ActivityEvent[] { return this.view(now).events.filter(e=>e.attention && !e.read && (e.snoozedUntil ?? 0)<=now && e.resolvedAt===undefined).reverse(); }
  sinceViewed(): ActivityEvent[] { return this.view().events.filter(e=>!e.viewed).reverse(); }
  search(query: string): ActivityAgent[] { return searchActivityAgents(this.view(),query); }
  replay(snapshotId: string): ActivitySnapshot | undefined { return this.view().history.find(h=>h.id===snapshotId); }
}
export function searchActivityAgents(view: ActivityView, query: string): ActivityAgent[] {
  const words=clean(query).toLocaleLowerCase().split(/\s+/).filter(Boolean); const pins=new Set(view.pinnedIds);
  return view.agents.filter(a=>words.every(q=>[a.id,a.name,a.role,a.agentPath].some(s=>s?.toLocaleLowerCase().includes(q))))
    .sort((a,b)=>Number(pins.has(b.id))-Number(pins.has(a.id)) || a.name.localeCompare(b.name));
}
