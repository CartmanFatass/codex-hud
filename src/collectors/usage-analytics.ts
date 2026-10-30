import { promises as fs, createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import type { UsageBucket, UsageQuery, UsageSnapshot, UsageTask, UsageTotals } from '../usage-types.js';
import { object, parseUsageFile, validUsageFile } from './usage-records.js';
import type { Counts, UsageFile, UsageObservation } from './usage-records.js';
import { UsagePricing, type UsageCost } from './usage-pricing.js';
import { parseStoredTitle } from './recap.js';
import { createInterface } from 'node:readline';

const INDEX_VERSION = 3;
const fields = ['input', 'cachedInput', 'output', 'reasoningOutput', 'total'] as const;
type Coverage = UsageSnapshot['coverage'];
type CachedFile = { signature: string; parsed: UsageFile };
type Event = { at: number; owner: string; root: string | null; model: string | null;
  effort: string | null; role: string | null; project: string | null; counts: Counts; cost: UsageCost };
type Row = { day: string; owner: string; root: string | null; model: string | null;
  effort: string | null; role: string | null; project: string | null; totals: UsageTotals; maxAt: number; minAt: number; events: Event[] };
type Generation = { rows: Row[]; boundaries: number[]; coverage: Coverage; updatedAtMs: number;
  taskTitles: Map<string, { native?: string; enhanced?: string }>;
  sourceAvailable: boolean; incomplete: boolean; retainedFiles: number };
type Accumulator = { totals: UsageTotals; threads: Set<string> };

const emptyTotals = (): UsageTotals => ({ input: null, cachedInput: null, output: null,
  reasoningOutput: null, total: null, events: 0, threads: 0 });
const emptyCoverage = (): Coverage => ({ filesDiscovered: 0, filesIndexed: 0, filesUnreadable: 0,
  malformedLines: 0, unresolvedParents: 0, ambiguousEvents: 0 });
const accumulator = (): Accumulator => ({ totals: emptyTotals(), threads: new Set() });
const overflows = new WeakMap<UsageTotals, Set<number>>();
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const signature = (s: Stats): string => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const dayOf = (at: number): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function addCounts(acc: Accumulator, counts: Counts, owner: string, events = 1, cost?: UsageCost): void {
  for (let i = 0; i < fields.length; i++) {
    const value = counts[i];
    if (value === null) continue;
    if (overflows.get(acc.totals)?.has(i)) continue;
    const sum = (acc.totals[fields[i]] ?? 0) + value;
    // Do not turn untrusted large counters into rounded floating-point totals.
    acc.totals[fields[i]] = Number.isSafeInteger(sum) ? sum : null;
    if (!Number.isSafeInteger(sum)) {
      let bad = overflows.get(acc.totals);
      if (!bad) { bad = new Set(); overflows.set(acc.totals, bad); }
      bad.add(i);
    }
  }
  if(cost){
    const kept=acc.totals.cost??{usd:null,pricedEvents:0,unpricedEvents:0};
    const sum=(kept.usd??0)+(cost.usd??0);
    kept.usd=kept.usd===null&&cost.usd===null?null:Number.isFinite(sum)?sum:null;
    kept.pricedEvents+=cost.pricedEvents;kept.unpricedEvents+=cost.unpricedEvents;
    acc.totals.cost=kept;
  }
  acc.totals.events += events;
  acc.threads.add(owner);
  acc.totals.threads = acc.threads.size;
}

const countsOf = (totals: UsageTotals): Counts => fields.map(f => totals[f]) as Counts;
function addRow(acc: Accumulator, row: Row, now: number): void {
  if (row.maxAt <= now) addCounts(acc, countsOf(row.totals), row.owner, row.totals.events, row.totals.cost);
  else for (const event of row.events) if (event.at <= now) addCounts(acc, event.counts, event.owner, 1, event.cost);
}

/**
 * Local-only historical index. Construction and snapshot() perform no I/O.
 * This is an accelerator, not an archive: sources confirmed absent are removed.
 * Transient discovery failures retain known in-memory evidence, labelled partial.
 */
export class UsageAnalytics {
  private readonly codexHome: string;
  private readonly onChange?: () => void;
  private readonly indexDir: string;
  private files = new Map<string, CachedFile>();
  private generation: Generation | null = null;
  private flight: Promise<void> | null = null;
  private closed = false;
  private failure = false;
  private snapshots = new Map<string, UsageSnapshot>();
  private pricing: UsagePricing;

  constructor(options: { codexHome: string; onChange?: () => void; pricing?: UsagePricing }) {
    this.pricing=options.pricing??new UsagePricing();
    this.codexHome = path.resolve(options.codexHome);
    this.indexDir = path.join(this.codexHome, 'hud', 'usage-index');
    this.onChange = options.onChange;
  }

  /** Concurrent callers share the exact same promise and one coherent generation. */
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.flight) return this.flight;
    this.flight = this.collect().catch(() => {
      if (!this.closed) { this.failure = true; this.snapshots.clear(); }
    }).finally(() => {
      this.flight = null;
      if (!this.closed) { try { this.onChange?.(); } catch { /* UI callbacks cannot corrupt an index. */ } }
    });
    return this.flight;
  }

  close(): void { this.closed = true; }

  snapshot(query: UsageQuery): UsageSnapshot {
    const endMs = Number.isFinite(query.nowMs) ? query.nowMs : 0;
    const start = new Date(endMs);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (query.period === '30d' ? 29 : query.period === '7d' ? 6 : 0));
    const range = { startMs: start.getTime(), endMs, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    const gen = this.generation;
    if(query.period==='all'&&gen?.rows.length){
      const first=gen.boundaries[0]??endMs;start.setTime(first);start.setHours(0,0,0,0);range.startMs=start.getTime();
    }
    const source = { codexHome: this.codexHome, label: 'sessions + archived_sessions' };
    if (!gen) return { status: this.failure ? 'unavailable' : 'loading', updatedAtMs: null, range, source,
      totals: emptyTotals(), daily: [], models: [], efforts: [], roles: [], tasks: [], coverage: emptyCoverage(),
      ...(this.failure ? { message: 'Native usage history could not be read.' } : {}) };
    // Time changes only the aggregates when crossing a recorded event. Binary
    // search keeps clock/input repaints independent of the number of rows.
    let low = 0;
    let high = gen.boundaries.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (gen.boundaries[middle] <= endMs) low = middle + 1;
      else high = middle;
    }
    const key = JSON.stringify([range.startMs, query.rootId ?? null, low, this.failure, query.filter ?? null, query.enhancedTitles ?? false]);
    const cached = this.snapshots.get(key);
    if (cached) return { ...cached, range };
    const totals = accumulator();
    const previous = accumulator();
    const previousEndMs=range.startMs-1;
    const previousStart=new Date(range.startMs);
    previousStart.setDate(previousStart.getDate()-(query.period==='30d'?30:query.period==='7d'?7:1));
    const previousStartDay=dayOf(previousStart.getTime());
    const days = new Map<string, Accumulator>();
    const models = new Map<string | null, Accumulator>();
    const efforts = new Map<string | null, Accumulator>();
    const roles = new Map<string | null, Accumulator>();
    const projects = new Map<string | null, Accumulator>();
    const tasks = new Map<string, { self: Accumulator; descendants: Accumulator; total: Accumulator; project: string | null; firstAtMs: number; rootProject: boolean }>();
    const startDay = dayOf(range.startMs);
    const endDay = dayOf(endMs);
    const addBucket = <K>(map: Map<K, Accumulator>, key: K, row: Row): void => {
      let acc = map.get(key);
      if (!acc) { acc = accumulator(); map.set(key, acc); }
      addRow(acc, row, endMs);
    };
    for (const row of gen.rows) {
      if (query.rootId && row.root !== query.rootId) continue;
      if (query.filter && row[query.filter.by] !== query.filter.key) continue;
      if(query.period!=='all'&&row.day>=previousStartDay&&row.day<startDay)addRow(previous,row,previousEndMs);
      if (row.day < startDay || row.day > endDay || row.minAt > endMs) continue;
      addRow(totals, row, endMs);
      addBucket(days, row.day, row);
      addBucket(models, row.model, row);
      addBucket(efforts, row.effort, row);
      addBucket(roles, row.role, row);
      addBucket(projects, row.project, row);
      if (row.root !== null) {
        let task = tasks.get(row.root);
        if (!task) { task = { self: accumulator(), descendants: accumulator(), total: accumulator(), project: row.project,
          firstAtMs: row.minAt, rootProject: row.owner === row.root && row.project !== null }; tasks.set(row.root, task); }
        task.firstAtMs = Math.min(task.firstAtMs, row.minAt);
        if (row.project && (!task.project || (!task.rootProject && row.owner === row.root))) {
          task.project = row.project; task.rootProject = row.owner === row.root;
        }
        addRow(task.total, row, endMs);
        addRow(row.owner === row.root ? task.self : task.descendants, row, endMs);
      }
    }
    const buckets = (map: Map<string | null, Accumulator>): UsageBucket[] => Array.from(map, ([key, a]) => ({ key, totals: a.totals }))
      .sort((a, b) => (b.totals.total ?? -1) - (a.totals.total ?? -1) || (a.key ?? '').localeCompare(b.key ?? ''));
    const daily: UsageSnapshot['daily'] = [];
    if(query.period==='all'){
      for(const [day,acc] of [...days].sort(([a],[b])=>a.localeCompare(b)))daily.push({day,totals:acc.totals});
    }else{
      const cursor = new Date(range.startMs);
      while (cursor.getTime() <= endMs) {
        const day = dayOf(cursor.getTime());
        daily.push({ day, totals: days.get(day)?.totals ?? emptyTotals() });
        cursor.setDate(cursor.getDate() + 1);
      }
    }
    const taskList: UsageTask[] = Array.from(tasks, ([rootId, task]) => ({ rootId,
      title: (query.enhancedTitles ? gen.taskTitles.get(rootId)?.enhanced : undefined) ?? gen.taskTitles.get(rootId)?.native,
      project: task.project, firstAtMs: task.firstAtMs,
      self: task.self.totals, descendants: task.descendants.totals, total: task.total.totals }))
      .sort((a, b) => (b.total.total ?? -1) - (a.total.total ?? -1) || a.rootId.localeCompare(b.rootId));
    const incomplete = gen.incomplete || this.failure || overflows.has(totals.totals);
    const available = totals.totals.events > 0;
    const snapshot: UsageSnapshot = {
      status: available ? (incomplete ? 'partial' : 'ready') : 'unavailable',
      updatedAtMs: gen.updatedAtMs, range, source, totals: totals.totals, daily,
      models: buckets(models), efforts: buckets(efforts), roles: buckets(roles), projects: buckets(projects), tasks: taskList,
      ...(query.period!=='all'?{comparison:{previous:previous.totals,costChangePct:!gen.incomplete&&!this.failure&&!previous.totals.cost?.unpricedEvents&&!totals.totals.cost?.unpricedEvents
        &&previous.totals.cost?.usd&&totals.totals.cost?.usd!==null&&totals.totals.cost?.usd!==undefined
        ?(totals.totals.cost.usd/previous.totals.cost.usd-1)*100:null}}:{}),
      pricing:{source:this.pricing.source,revision:this.pricing.revision,updatedAtMs:this.pricing.updatedAtMs,
        rates:Object.fromEntries([...models.keys()].filter((key):key is string=>key!==null).map(key=>[key,this.pricing.list(key)]))},
      coverage: { ...gen.coverage },
      ...(!available ? { message: gen.sourceAvailable ? 'No attributable native usage events in this range.' : 'Native session directories are unavailable.' }
        : gen.retainedFiles > 0 ? { message: 'Includes retained index evidence from temporarily unreadable sources.' }
          : incomplete ? { message: 'Known usage subtotal; local evidence has gaps.' } : {}),
    };
    // Bound UI scope/date memoization. A normal redraw changes only range.endMs.
    if (this.snapshots.size >= 24) this.snapshots.delete(this.snapshots.keys().next().value!);
    this.snapshots.set(key, snapshot);
    return snapshot;
  }

  private async collect(): Promise<void> {
    const pricing=this.pricing.fresh();
    await pricing.load();
    const coverage = emptyCoverage();
    const paths: string[] = [];
    const inaccessible: string[] = [];
    const failedFiles = new Set<string>();
    let sourceAvailable = false;
    const discover = async (dir: string, top = false): Promise<void> => {
      if (this.closed) return;
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        if (top) sourceAvailable = true;
        for (const entry of entries) {
          if (this.closed) return;
          if (entry.isDirectory()) await discover(path.join(dir, entry.name));
          else if (entry.isFile() && entry.name.endsWith('.jsonl')) paths.push(path.join(dir, entry.name));
          await yieldImmediate();
        }
      } catch (error) {
        if (!top || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
          coverage.filesUnreadable++;
          inaccessible.push(dir);
        }
      }
    };
    await discover(path.join(this.codexHome, 'sessions'), true);
    await discover(path.join(this.codexHome, 'archived_sessions'), true);
    coverage.filesDiscovered = paths.length;
    const next = new Map<string, CachedFile>();
    for (const file of paths.sort()) {
      if (this.closed) return;
      try {
        const stat = await fs.stat(file);
        const before = signature(stat);
        let cached = this.files.get(file);
        if (!cached) cached = await this.loadCached(file);
        if (cached?.signature !== before) {
          let resume: { parsed: UsageFile; digest: string } | undefined;
          if (cached && stat.size > cached.parsed.bytes &&
            cached.signature.split(':').slice(0, 2).join(':') === before.split(':').slice(0, 2).join(':')) {
            const digest = await this.verifyAppend(file, cached.parsed);
            if (digest) resume = { parsed: cached.parsed, digest };
          }
          const parsed = await parseUsageFile(file, () => this.closed, resume);
          if (this.closed) return;
          if (signature(await fs.stat(file)) !== before) {
            coverage.filesUnreadable++; failedFiles.add(file); continue;
          }
          cached = { signature: before, parsed };
          await this.saveCached(file, cached);
        }
        next.set(file, cached);
        coverage.filesIndexed++;
        coverage.malformedLines += cached.parsed.malformed;
        coverage.ambiguousEvents += cached.parsed.ambiguous;
      } catch { if (!this.closed) { coverage.filesUnreadable++; failedFiles.add(file); } }
      await yieldImmediate();
    }
    let retainedFiles = 0;
    for (const [file, cached] of this.files) {
      if (!next.has(file) && (failedFiles.has(file) || inaccessible.some(dir => file.startsWith(`${dir}${path.sep}`)))) {
        next.set(file, cached);
        retainedFiles++;
      }
    }
    if (this.closed) return;
    const built = await this.buildRows(next, coverage, pricing);
    const taskTitles = await this.readTaskTitles(new Set(built.rows.flatMap(row => row.root ? [row.root] : [])));
    if (this.closed) return;
    this.files = next;
    this.pricing=pricing;
    this.generation = { rows: built.rows, boundaries: built.boundaries, taskTitles, coverage, updatedAtMs: Date.now(), sourceAvailable, retainedFiles,
      incomplete: built.incomplete || coverage.filesUnreadable > 0 || coverage.malformedLines > 0
        || coverage.unresolvedParents > 0 || coverage.ambiguousEvents > 0 };
    this.failure = false;
    this.snapshots.clear();
  }

  /** Display metadata stays outside the numeric rollout cache; renames refresh without reparsing history. */
  private async readTaskTitles(roots: Set<string>): Promise<Generation['taskTitles']> {
    const titles: Generation['taskTitles'] = new Map();
    const input = createReadStream(path.join(this.codexHome, 'session_index.jsonl'), { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    input.on('error', () => lines.close());
    try {
      for await (const line of lines) {
        if (this.closed) break;
        try {
          const row = object(JSON.parse(line));
          if (typeof row.id === 'string' && roots.has(row.id) && typeof row.thread_name === 'string'
            && row.thread_name.trim() && row.thread_name.trim() !== row.id) {
            titles.set(row.id, { native: row.thread_name.replace(/\s+/g, ' ').trim().slice(0, 160) });
          }
        } catch { /* A malformed title cannot change numeric usage coverage. */ }
      }
    } catch { /* Titles are optional. */ }
    finally { lines.close(); input.destroy(); }
    for (const id of roots) {
      if (this.closed) break;
      if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) continue;
      try {
        const stored = parseStoredTitle(JSON.parse(await fs.readFile(path.join(this.codexHome, 'hud', 'recaps', `${id}.title.json`), 'utf8')));
        if (stored?.sessionId === id && stored.title !== id) titles.set(id, { ...titles.get(id), enhanced: stored.title });
      } catch { /* Missing AI titles fall back to native names. No model work is scheduled here. */ }
    }
    return titles;
  }

  /** Prefix integrity needs a read, but only the appended tail needs JSON parsing. */
  private async verifyAppend(file: string, previous: UsageFile): Promise<string | undefined> {
    const stream = createReadStream(file, { highWaterMark: 64 * 1024 });
    const digest = createHash('sha256');
    let bytes = 0;
    let verified = previous.bytes === 0 && previous.digest === hash('');
    try {
      for await (const chunk of stream) {
        if (this.closed) throw new Error('closed');
        const data = chunk as Buffer;
        const boundary = previous.bytes - bytes;
        if (!verified && boundary >= 0 && boundary <= data.length) {
          digest.update(data.subarray(0, boundary));
          if (digest.copy().digest('hex') !== previous.digest) return;
          verified = true;
          digest.update(data.subarray(boundary));
        } else digest.update(data);
        bytes += data.length;
        await yieldImmediate();
      }
      return verified ? digest.digest('hex') : undefined;
    } finally { stream.destroy(); }
  }

  private async loadCached(file: string): Promise<CachedFile | undefined> {
    try {
      const value = object(JSON.parse(await fs.readFile(path.join(this.indexDir, `${hash(file)}.json`), 'utf8')));
      if (value.version !== INDEX_VERSION || typeof value.signature !== 'string' || !validUsageFile(value.parsed)) return;
      if (value.checksum !== hash(JSON.stringify(value.parsed))) return;
      return { signature: value.signature, parsed: value.parsed };
    } catch { return; }
  }

  private async saveCached(file: string, cached: CachedFile): Promise<void> {
    const destination = path.join(this.indexDir, `${hash(file)}.json`);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(this.indexDir, { recursive: true, mode: 0o700 });
      await fs.chmod(this.indexDir, 0o700);
      const encoded = JSON.stringify({ version: INDEX_VERSION, signature: cached.signature,
        checksum: hash(JSON.stringify(cached.parsed)), parsed: cached.parsed });
      if (this.closed) return;
      await fs.writeFile(temporary, encoded, { flag: 'wx', mode: 0o600 });
      if (!this.closed) await fs.rename(temporary, destination);
    } catch { /* Read-only Codex homes still have fully usable in-memory analytics. */ }
    finally { await fs.unlink(temporary).catch(() => {}); }
  }

  private async buildRows(files: Map<string, CachedFile>, coverage: Coverage, pricing: UsagePricing): Promise<{ rows: Row[]; boundaries: number[]; incomplete: boolean }> {
    const owners = new Map<string, { parent: string | null; hint: string | null; role: string | null; roleConflict: boolean;
      observations: UsageObservation[]; conflict: boolean }>();
    for (const { parsed } of files.values()) {
      if (!parsed.owner) continue;
      let owner = owners.get(parsed.owner);
      if (!owner) { owner = { parent: parsed.parent, hint: parsed.rootHint, role: parsed.role, roleConflict: false,
        observations: [], conflict: false }; owners.set(parsed.owner, owner); }
      else {
        if (owner.parent && parsed.parent && owner.parent !== parsed.parent) owner.conflict = true;
        if (owner.hint && parsed.rootHint && owner.hint !== parsed.rootHint) owner.conflict = true;
        owner.parent ??= parsed.parent;
        owner.hint ??= parsed.rootHint;
        if (!owner.roleConflict) {
          if (owner.role && parsed.role && owner.role !== parsed.role) {
            owner.role = null;
            owner.roleConflict = true;
            coverage.ambiguousEvents++;
          } else owner.role ??= parsed.role;
        }
      }
      for (let i = 0; i < parsed.observations.length; i++) {
        owner.observations.push(parsed.observations[i]);
        if (i % 512 === 0) await yieldImmediate();
      }
      await yieldImmediate();
    }
    const roots = new Map<string, string | null>();
    const rootOf = (id: string): string | null => {
      if (roots.has(id)) return roots.get(id)!;
      const seen = new Set<string>();
      let current = id;
      let resolved: string | null = null;
      while (!seen.has(current)) {
        seen.add(current);
        const owner = owners.get(current);
        if (!owner || owner.conflict) break;
        if (!owner.parent) { resolved = owner.hint ?? current; break; }
        if (!owners.has(owner.parent)) { resolved = owner.hint; break; }
        current = owner.parent;
      }
      roots.set(id, resolved);
      return resolved;
    };
    for (const [id, owner] of owners) {
      if (rootOf(id) === null || owner.conflict || (owner.parent && !owners.has(owner.parent))) coverage.unresolvedParents++;
    }
    const rows = new Map<string, Row>();
    const boundaries = new Set<number>();
    let incomplete = false;
    for (const [id, owner] of owners) {
      if (this.closed) break;
      const ordered = owner.observations.sort((a, b) => a.at - b.at
        || Number(a.attributable) - Number(b.attributable) || (a.total?.[4] ?? 0) - (b.total?.[4] ?? 0));
      const unique = new Map<string, { observation: UsageObservation; modelConflict: boolean; effortConflict: boolean; projectConflict: boolean; providerConflict: boolean; fastConflict: boolean }>();
      // Reconcile the labels of all copies before building rows. Counting the
      // first copy immediately would let directory order decide its dimensions.
      for (let i = 0; i < ordered.length; i++) {
        if (i % 128 === 0) { await yieldImmediate(); if (this.closed) break; }
        const observation = ordered[i];
        const identity = JSON.stringify([observation.at, observation.total, observation.last, observation.attributable]);
        const duplicate = unique.get(identity);
        if (!duplicate) {
          unique.set(identity, { observation: { ...observation }, modelConflict: false, effortConflict: false, projectConflict:false, providerConflict:false, fastConflict:false });
          continue;
        }
        for (const dimension of ['model', 'effort', 'project', 'provider'] as const) {
          const flag = `${dimension}Conflict` as const;
          if (duplicate[flag]) continue;
          const previous = duplicate.observation[dimension];
          const incoming = observation[dimension];
          if (previous != null && incoming != null && previous !== incoming) {
            duplicate[flag] = true;
            duplicate.observation[dimension] = null;
          } else duplicate.observation[dimension] ??= incoming ?? null;
        }
        if(!duplicate.fastConflict && (duplicate.observation.fast??false)!==(observation.fast??false)){
          duplicate.fastConflict=true;duplicate.observation.fast=null;
        }
      }
      const observations = [...unique.values()];
      let previous: Counts | null = null;
      let lastReport: string | null = null;
      let previousLast: Counts | null = null;
      let previousAttributable = false;
      for (let i = 0; i < observations.length; i++) {
        if (i % 128 === 0) { await yieldImmediate(); if (this.closed) break; }
        const { observation, modelConflict, effortConflict, projectConflict, providerConflict, fastConflict } = observations[i];
        if (modelConflict || effortConflict || projectConflict || providerConflict || fastConflict) coverage.ambiguousEvents++;
        const { total, last } = observation;
        if (!observation.attributable) {
          if (total) { previous = total; previousAttributable = false; previousLast = null; lastReport = null; }
          continue;
        }
        const report = JSON.stringify([total, last]);
        // Quota updates and re-emissions cannot create a second request. An
        // intervening quota-only record never clears the last report identity.
        if (total && previous && previousAttributable && JSON.stringify(total) === JSON.stringify(previous)) {
          if (last && previousLast && JSON.stringify(last) !== JSON.stringify(previousLast)) coverage.ambiguousEvents++;
          continue;
        }
        if (total && report === lastReport) continue;
        let delta: Counts | null = null;
        if (total && previous) {
          const regression = total.some((n, j) => n !== null && previous![j] !== null && n < previous![j]!);
          if (!regression) delta = total.map((n, j) => n !== null && previous![j] !== null ? n - previous![j]! : null) as Counts;
          else coverage.ambiguousEvents++;
        }
        // The first cumulative sample may contain many old turns. It is a
        // baseline, never all attributed to this sample's day/model.
        const used = last ? last.map((n, j) => n ?? delta?.[j] ?? null) as Counts : delta;
        if (last && delta && previousAttributable && last.some((n, j) => n !== null && delta![j] !== null && n !== delta![j])) coverage.ambiguousEvents++;
        if (total) { previous = total; lastReport = report; previousLast = last; previousAttributable = true; }
        if (!used || !used.some(n => n !== null)) { coverage.ambiguousEvents++; continue; }
        // An unchanged inherited baseline does not establish a new request.
        if (!last && used.every(n => n === null || n === 0)) continue;
        if (!total) coverage.ambiguousEvents++;
        if (used.some(n => n === null)) incomplete = true;
        const model=observation.model===null?null:observation.model+(observation.fast?':fast':'')
          +(observation.provider&&observation.provider!=='openai'?'::'+observation.provider:'');
        const cost=observation.fast===null?{usd:null,pricedEvents:0,unpricedEvents:1}:pricing.quote(model,used,observation.fast??false,observation.provider);
        const event: Event = { at: observation.at, owner: id, root: rootOf(id), model,
          effort: observation.effort, role: owner.role, project:observation.project??null, counts: used, cost };
        boundaries.add(event.at);
        const day = dayOf(event.at);
        const key = JSON.stringify([day, id, event.model, event.effort, event.role, event.project]);
        let row = rows.get(key);
        if (!row) { row = { day, owner: id, root: event.root, model: event.model, effort: event.effort,
          role: event.role, project:event.project, totals: emptyTotals(), maxAt: event.at, minAt: event.at, events: [] }; rows.set(key, row); }
        const acc = { totals: row.totals, threads: new Set([id]) };
        addCounts(acc, event.counts, id, 1, event.cost);
        row.maxAt = Math.max(row.maxAt, event.at);
        row.minAt = Math.min(row.minAt, event.at);
        row.events.push(event);
      }
    }
    return { rows: [...rows.values()], boundaries: [...boundaries].sort((a, b) => a - b),
      incomplete: incomplete || [...rows.values()].some(row => overflows.has(row.totals)) };
  }
}
