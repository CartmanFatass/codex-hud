/** On-demand, read-only Project facts. No MCP startup, models, browser IPC or writes. */
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { readFileBounded } from '../utils/atomic-fs.js';
import { executable, roleRegistry } from '../roles/roster.js';
import { getJobIndexCache, JOB_ID_RE } from '../roles/job-index-cache.js';
import { controlFacts, type HarnessFact, type HarnessSwitchFact, type ModelLists, type RoleFact } from '../roles/role-control.js';
import { HarnessSwitchError } from '../roles/harness-switches.js';
import { neutralizeFilters, parseWorktreeList, parseWorktreeStatus, worktreeGit, type WorktreeInfo, type WorktreeStatus } from './worktrees.js';
import type { WorkboardSnapshot } from './workboard-types.js';
import { STATE_BYTES, WAITING_HEADING, requestFields, stateBullets, statePaths } from './state-ledger.js';
import { objectivePath, readObjectives, type ObjectiveRecord } from './objectives.js';
import { ResultReceipts, resultDate } from './result-receipts.js';
import { DiffStatCollector, type DiffStatSummary } from './diff-stat.js';
import { collectControlRadar, type ControlRadar } from './control-radar.js';
import { collectControlJobStats, jobSettledAt, type ControlJobStats } from './job-stats.js';
import { epoch } from '../roles/job-usage.js';
import { targetKey, ticketFileEvidence, ticketHeading } from './ticket-evidence.js';
import { readOpenHolds } from '../unattended/state.js';
import { TryLog } from './try-records.js';
import { SETTLED_JOB_STATES, TicketRollup, ticketIds, ticketJobState } from './ticket-rollup.js';
import { readActiveLeases, stripJobPrefix, type LeaseRecord } from './thin-jobs.js';
/** A placeholder bullet such as "- Nothing open." in an empty Waiting section is not a request. */
const EMPTY_WAITING = /^(?:none|nothing(?: open| pending)?|n\/a|—|-|无|没有|暂无)[.。]?$/i;
const ticketPathId = (path: string) => {
  const match = /^\.scratch\/([^/]+)\/issues\/(\d+)-[^/]+\.md$/.exec(path);
  return match && targetKey(`${match[1]}/${match[2]}`);
};
const landingStatus = /^(ready-for-human|done)$/i;
const landingLogBoundary = /\0\0(?=(?:[a-f0-9]{40}|[a-f0-9]{64})\0)/;

export { SETTLED_JOB_STATES } from './ticket-rollup.js';
export interface ProjectItem {
  label: string;
  value: string;
  path?: string;
  at?: number;
  /** A waiting item's full display text; `value` is the same words on one line. */
  text?: string;
  /** The owner's request prose, without the date, ID, Objective link or work-waits marker. */
  sentence?: string;
  request?: string;
  objective?: string;
  waitedOn?: boolean;
}
export const SLICE_STATES = ['working', 'blocked', 'try', 'todo', 'accepted', 'dropped'] as const;
export type SliceState = typeof SLICE_STATES[number];
export interface LedgerSlice {
  id: string; state: SliceState; milestone: string; release?: string; text: string; commit?: string; at?: number;
  diff?: DiffStatSummary;
  landed?: true;
  /** Relative ticket path for ticket-derived slices (HTML board). */
  ticketPath?: string;
  /** Absolute file path for ticket-derived slices (opened on `o`). */
  path?: string;
}
export interface ActiveJob {
  jobId: string; role: string; state: string; package?: string; title?: string; at?: number; asking: boolean;
  /** The report, else the brief: what Enter opens on the job's row. */
  path?: string;
}
export interface TicketItem { done: boolean; text: string }
export interface ProjectTicket {
  number: string; title: string; path: string; at: number; status: string;
  checked: number; total: number; items: TicketItem[]; comment?: string; commit?: string; recordedLanding?: boolean;
  blockers: string[]; ownerTry?: boolean;
  state: 'done' | 'dropped' | 'try' | 'working' | 'blocked' | 'ready' | 'queued';
  job?: { id?: string; role: string; state: string; at?: number; created: number };
}
export interface TicketFeature { slug: string; at: number; tickets: ProjectTicket[]; partial?: true }
export interface ProjectSnapshot {
  objectives?: ObjectiveRecord & { path: string; acceptance: Record<string, { checked: number; total: number }>; resultDates?: Record<string, number> };
  /** Scanned Objective features, including ones outside the Tickets page's finished-feature preview. */
  objectiveTickets?: TicketFeature[];
  /** With an Objective record: features it does not list that have open tickets or live jobs; live ones first. */
  unlinked?: TicketFeature[];
  tickets: TicketFeature[];
  ticketTotals?: { doneTickets: number; totalTickets: number; doneFeatures: number; totalFeatures: number; partial?: true };
  waiting: ProjectItem[];
  docs: ProjectItem[];
  control: ProjectItem[];
  /** Role places and installed harnesses. Full Project and Control collection only. */
  roles: RoleFact[];
  harnesses: HarnessFact[];
  harnessSwitches?: HarnessSwitchFact[];
  harnessSwitchError?: string;
  /** The merged model lists behind the Control plane's typed model input (the same ones `m` cycles). */
  models: ModelLists;
  agents: ProjectItem[];
  keys: [string, boolean][];
  browser: boolean;
  roleCount: number;
  radar?: ControlRadar;
  jobStats?: ControlJobStats;
  leases?: LeaseRecord[];
  git?: WorktreeStatus;
  gitDiff?: DiffStatSummary;
  /** Linked worktrees besides the main one; with `git`, one Git read per five seconds. */
  worktreeCount?: number;
  ladder: { ids: string[]; current?: string };
  slices: (ProjectItem & { jobId?: string; role?: string; asking?: boolean; drift?: 'no linked ticket'; ledgerState?: SliceState })[];
  ledger: LedgerSlice[];
  active: ActiveJob[];
  counts: Record<SliceState, number>;
  summary: string;
  statePath?: string;
  stateTruncated?: boolean;
  specTruncated?: boolean;
  updatedAt?: number;
  objectivesAt?: number;
  /** Latest observed job activity in the bounded Home window, when neither record exists. */
  lastJobAt?: number;
  /** Latest observed start or settlement in the bounded Home window, even with records. */
  jobActivityAt?: number;
  idle?: true;
  last?: { text: string; at: number };
  next: ProjectItem[];
  editing: ProjectItem[];
}
const waitRefs = (text: string) => [...text.matchAll(/[（(]waits on ([^()（）]+)[）)]/gi)].at(-1)?.[1]
  .split(/,|\s+and\s+/i).map((r) => r.trim()).filter(Boolean) ?? [];

/** Waits can name tickets (either spelling) or a legacy acceptance ID. Unknown references keep the item open. */
export function waitSettled(text: string, settled: ReadonlySet<string>): boolean {
  const refs = waitRefs(text);
  return refs.length > 0 && refs.every((ref) => settled.has(targetKey(ref)));
}

export const ownerRequestKey = (item: ProjectItem) => item.request ?? item.text ?? item.value;
export const blockedObjectives = (waiting: readonly ProjectItem[]) =>
  new Set(waiting.flatMap(({ objective, waitedOn }) => objective && waitedOn ? [objective] : []));
/** A live job is linked to one of the feature's tickets, or names the feature as its package. */
function unlinkedFeatures(features: readonly TicketFeature[], { objectives }: ObjectiveRecord, active: readonly ActiveJob[]) {
  const listed = new Set(objectives.flatMap((o) => o.features)), packages = new Set(active.map((job) => job.package));
  const live = ({ slug, tickets }: TicketFeature) =>
    packages.has(slug) || tickets.some(({ job }) => job && !SETTLED_JOB_STATES.has(job.state));
  return features.filter((f) => !listed.has(f.slug) &&
    (live(f) || f.tickets.some(({ state }) => state !== 'done' && state !== 'dropped')))
    .sort((a, b) => Number(live(b)) - Number(live(a)));
}
type RequestOrder = Pick<ProjectItem, 'waitedOn' | 'at'>;
/** Larger project priority comes first. Stable sorting preserves file order for equal age or undated requests. */
export function compareOwnerRequests(a: RequestOrder, b: RequestOrder, priorityA = 0, priorityB = 0): number {
  const rank = Number(!!b.waitedOn) - Number(!!a.waitedOn) || priorityB - priorityA;
  if (rank) return rank;
  return a.at === b.at ? 0 : (a.at ?? Infinity) - (b.at ?? Infinity);
}

function requestOrder(value: string, waits?: boolean): RequestOrder {
  const date = /^\d{4}-\d{2}-\d{2}(?=\s|$)/.exec(value)?.[0];
  const at = date ? Date.parse(date) : NaN;
  return {
    waitedOn: waits ?? /[（(]work waits[）)]/i.test(value),
    at: date && Number.isFinite(at) && new Date(at).toISOString().startsWith(date) ? at : undefined,
  };
}
const canonicalPath = (path: string) => { try { return fs.realpathSync(path); } catch { return resolve(path); } };
export const insideRoot = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
interface JobReceipt {
  cwd?: unknown;
  project_root?: unknown;
  worktree?: { root?: unknown; branch?: unknown; main_root?: unknown };
  created_at?: unknown;
  started_at?: unknown;
  dispatch_exit_code?: unknown;
  reaped_at?: unknown;
  title?: unknown;
  task?: unknown;
  task_length?: unknown;
  slice?: string;
  ticket?: string | number;
  package?: string;
  role?: unknown;
  brief_path?: unknown;
  target_hint?: string;
  parent_job?: unknown;
}
interface JobStatus {
  state?: unknown;
  started_at?: unknown;
  settled_at?: unknown;
  ended_at?: unknown;
}
const firstFile = (...paths: string[]) => paths.find((p) => { try { return fs.lstatSync(p).isFile(); } catch { return false; } });
const lstat = (path: string) => { try { return fs.lstatSync(path, { throwIfNoEntry: false }); } catch { return undefined; } };
const stampOf = (st: fs.Stats) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
const statKey = (path: string) => { const st = lstat(path); return st && (st.isFile() || st.isDirectory()) ? stampOf(st) : ''; };
const cloneTickets = (features: TicketFeature[]): TicketFeature[] =>
  features.map((f) => ({ ...f, tickets: f.tickets.map((t) => ({ ...t, blockers: [...t.blockers] })) }));
/** The same bounded job window as Project, shared by all roots on a Home tick. */
export function projectJobWindow(hudHome: string) {
  const cache = getJobIndexCache(hudHome);
  let complete = true;
  const incomplete = () => { complete = false; };
  const { dirs } = cache.listJobDirsByMtime({ onDirError: incomplete, onStatError: incomplete });
  const jobs = cache.recentJobFamilies(dirs, 64);
  return { jobs, complete: complete && jobs.length === dirs.length };
}

export const projectShown = (state: Pick<import('../render/monitor-state.js').MonitorState, 'activeTab' | 'subpage' | 'help'>, modal = false) =>
  state.activeTab === 'project' && !state.subpage && !state.help && !modal;
export class ProjectCollector {
  private cache = new Map<string, { stamp: string; value: unknown }>();
  private seen = new Set<string>();
  private gitAt = -Infinity;
  private git?: WorktreeStatus;
  private last?: ProjectSnapshot['last'];
  private worktrees: WorktreeInfo[] = [];
  private commitAt = new Map<string, number>();
  private diffs = new DiffStatCollector();
  private tries: TryLog;
  private head = '';
  private packedHead?: { key: string; sha: string };
  private landed = new Set<string>();
  private ticketCommits = new Map<string, { sha: string; at: number }>();
  private ticketsMemo?: { stamp: string; features: TicketFeature[]; paths: string[]; claimTimes: number[]; partial: boolean };
  private collectMemo = new Map<string, { key: string; claimFloor: number; claimExpiry: number; snapshot: ProjectSnapshot }>();
  private resultReceipts: ResultReceipts;
  constructor(private cwd: string, private hudHome: string, private env = process.env, private home = homedir()) {
    this.tries = new TryLog(hudHome);
    this.resultReceipts = new ResultReceipts(join(hudHome, 'events'));
  }
  /** Test seam: cached Home to-try commit timestamps currently retained. */
  private cached<T>(path: string, load: (st: fs.Stats) => T, preStat?: fs.Stats | null): T | null {
    try {
      const st = preStat !== undefined ? preStat : fs.lstatSync(path, { throwIfNoEntry: false });
      if (!st) { this.cache.delete(path); return null; }
      this.seen.add(path);
      if (!st.isFile() && !st.isDirectory()) return null;
      const stamp = stampOf(st);
      const hit = this.cache.get(path);
      if (hit?.stamp === stamp) return hit.value as T;
      const value = load(st);
      this.cache.set(path, { stamp, value });
      return value;
    } catch { this.cache.delete(path); return null; }
  }
  private names = (path: string, limit = 128): string[] => this.cached(path, (st) => {
    if (!st.isDirectory()) return [];
    const dir = fs.opendirSync(path), names: string[] = [];
    try {
      for (let entry; names.length < limit && (entry = dir.readSync());) names.push(entry.name);
    } finally { dir.closeSync(); }
    return names.sort();
  }) ?? [];
  /** Rank the whole directory, retaining only the requested prefix of matching names. */
  private orderedNames(path: string, limit: number, keep: (entry: fs.Dirent) => boolean, descending = false, preStat?: fs.Stats | null): string[] | null {
    return this.cached(path, (st) => {
      if (!st.isDirectory()) return [];
      const dir = fs.opendirSync(path), names: string[] = [];
      const before = (a: string, b: string) => descending ? a > b : a < b;
      try {
        for (let entry; (entry = dir.readSync());) {
          if (!keep(entry)) continue;
          const name = entry.name;
          if (names.length === limit && !before(name, names[limit - 1])) continue;
          const index = names.findIndex((n) => before(name, n));
          names.splice(index < 0 ? names.length : index, 0, name);
          if (names.length > limit) names.pop();
        }
      } finally { dir.closeSync(); }
      return names;
    }, preStat);
  }
  private body<T>(path: string, parse: (buffer: Buffer, truncated: boolean, st: fs.Stats) => T, preStat?: fs.Stats | null): T | null {
    return this.cached(path, (st) => {
      if (!st.isFile()) throw Error('not_file');
      const { bytes, truncated } = readFileBounded(path, STATE_BYTES);
      return parse(bytes, truncated || st.size > bytes.length, st);
    }, preStat);
  }
  private read = (path: string, limit = 65536) => {
    const file = this.body(path, (b, truncated) => ({ text: b.toString('utf8'), truncated }));
    return file && { text: file.text.slice(0, limit), truncated: file.truncated || Buffer.byteLength(file.text) > limit };
  };
  /** Features by when their issues folder last changed (a ticket added or renamed), name breaking ties. */
  private scanTickets() {
    const root = join(this.cwd, '.scratch'), rootSt = lstat(root);
    if (!rootSt || !rootSt.isDirectory()) {
      this.cache.delete(root);
      return (this.ticketsMemo = { stamp: '', features: [], paths: [], claimTimes: [], partial: false });
    }
    // Retain an extra name to distinguish reaching a cap from omitting entries, without extra body reads.
    const slugs = this.orderedNames(root, 257, (entry) => entry.isDirectory(), false, rootSt);
    const ranked = (slugs ?? []).slice(0, 256)
      .map((slug) => { const issues = join(root, slug, 'issues'), st = lstat(issues); return { slug, issues, st, at: st?.mtimeMs ?? -1 }; })
      .sort((a, b) => b.at - a.at || (a.slug < b.slug ? -1 : 1));
    let partial = !slugs || slugs.length > 256 || ranked.slice(64).some(({ st }) => st?.isDirectory());
    let budget = 512;
    const stamps: string[] = [stampOf(rootSt)], paths: string[] = [root];
    const groups: { slug: string; partial: boolean; entries: { name: string; path: string; st: fs.Stats | undefined }[] }[] = [];
    for (const { slug, issues, st } of ranked.slice(0, 64)) {
      if (!st || !st.isDirectory()) { this.cache.delete(issues); continue; }
      if (budget <= 0) { partial = true; break; }
      paths.push(issues);
      stamps.push(`${slug}:${stampOf(st)}`);
      const limit = Math.min(64, budget);
      const names = this.orderedNames(issues, 65, (entry) => entry.isFile() && /^\d+-[^/]+\.md$/.test(entry.name), false, st);
      const incomplete = !names || names.length > limit;
      if (incomplete) partial = true;
      const selected = (names ?? []).slice(0, limit);
      budget -= selected.length;
      const entries = selected.map((name) => {
        const path = join(issues, name), fst = lstat(path);
        paths.push(path);
        stamps.push(`${name}:${fst?.isFile() ? stampOf(fst) : ''}`);
        return { name, path, st: fst };
      });
      groups.push({ slug, entries, partial: incomplete });
    }
    stamps.push(String(partial));
    const stamp = stamps.join('|');
    if (this.ticketsMemo?.stamp === stamp) {
      for (const p of this.ticketsMemo.paths) this.seen.add(p);
      return this.ticketsMemo;
    }
    const features: TicketFeature[] = [], claimTimes: number[] = [];
    for (const { slug, entries, partial: capped } of groups) {
      const tickets: ProjectTicket[] = [];
      let incomplete = capped;
      for (const { name, path, st } of entries) {
        const ticket = this.body(path, (buffer, truncated, stat): ProjectTicket | null | undefined => {
          if (truncated) return null;
          const text = buffer.toString('utf8'), heading = ticketHeading(text, Number(name.split('-')[0]));
          const { status, blocked, items, checked, ownerTry, landed, commit, recordedLanding } = ticketFileEvidence(text);
          if (!heading || !status || blocked === undefined) return undefined;
          const commentsSection = text.split(/^## Comments[ \t]*\r?$/m)[1]?.split(/^## /m)[0] ?? '';
          const commentRaw = [...commentsSection.matchAll(/^[-*] (.+(?:\r?\n[ \t]+.+)*)/gm)].at(-1)?.[1]?.replace(/\s+/g, ' ').trim();
          const comment = commentRaw ? commentRaw.slice(0, 600) : undefined;
          return { ...heading, path, at: stat.mtimeMs, status, ownerTry,
            checked, total: items.length, items, ...(comment !== undefined ? { comment } : {}),
            ...(commit !== undefined ? { commit } : {}), ...(recordedLanding ? { recordedLanding } : {}),
            blockers: /^none\b/i.test(blocked) ? [] : [blocked],
            state: landed ?? (/^claimed\b/i.test(status) ? 'working' : 'ready') };
        }, st ?? null);
        if (ticket) {
          tickets.push(ticket);
          if (/^claimed\b/i.test(ticket.status)) claimTimes.push(ticket.at);
        } else if (ticket === null) incomplete = true; // Unreadable or truncated, not a known invalid ticket.
      }
      if (incomplete) partial = true;
      tickets.sort((a, b) => Number(a.number) - Number(b.number) || a.path.localeCompare(b.path));
      if (tickets.length) features.push({ slug, at: Math.max(...tickets.map((t) => t.at)), tickets, ...(incomplete && { partial: true }) });
    }
    features.sort((a, b) => b.at - a.at || a.slug.localeCompare(b.slug));
    return (this.ticketsMemo = { stamp, features, paths, claimTimes, partial });
  }
  /** The newest 64 top-level jobs and their bounded children: the one lookup behind Project's Now section and the Projects list. */
  private recentJobs(cache = getJobIndexCache(this.hudHome)) {
    return cache.recentJobFamilies(cache.listJobDirsByMtime().dirs, 64);
  }
  /** A job's short factual title: the task's first heading, else its first line. Signature-cached, size-bounded. */
  private briefTitle(path: string, taskLength: unknown): string | undefined {
    const brief = this.read(path, 4096)?.text ?? '';
    const lines = (typeof taskLength === 'number' ? brief.slice(0, taskLength) : brief).split(/\r?\n/);
    const line = lines.find((l) => /^#{1,6}\s/.test(l)) ?? lines.find((l) => l.trim()) ?? '';
    const title = stripJobPrefix(line.replace(/^#{1,6}\s+/, '').replace(/\s+/g, ' ').trim());
    return title ? (title.length > 120 ? title.slice(0, 119) + '…' : title) : undefined;
  }
  private readJson = (path: string) => {
    const file = this.read(path);
    if (!file) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
    if (file.truncated) throw new SyntaxError('truncated');
    return JSON.parse(file.text);
  };
  private registry = () => roleRegistry(this.hudHome, this.cwd, this.env, this.read, this.names, undefined, this.readJson);
  /** The roles and harnesses again at once (signature-cached reads): a Control plane key shows its result before the next full collection. */
  refreshRoles(snapshot: ProjectSnapshot, now: number): void {
    try {
      const facts = controlFacts(this.registry(), this.hudHome, now, this.readJson, this.names);
      Object.assign(snapshot, { roles: facts.roles, harnesses: facts.harnesses, harnessSwitches: facts.harnessSwitches,
        harnessSwitchError: undefined, models: facts.models, roleCount: facts.roles.filter((r) => r.optionalEnabled !== false).length });
    } catch (error) { this.switchError(snapshot, error); }
  }
  private switchError(snapshot: ProjectSnapshot, error: unknown): void {
    if (error instanceof HarnessSwitchError)
      Object.assign(snapshot, { roles: [], harnessSwitches: [], roleCount: 0, harnessSwitchError: error.path });
  }
  private collectControl(out: ProjectSnapshot, now: number, controlPage = false): void {
    const radar = collectControlRadar(this.hudHome, this.env, now);
    if (radar) out.radar = radar;
    const registry = this.registry();
    if (controlPage) {
      out.leases = readActiveLeases(this.hudHome, registry.project().root);
      out.jobStats = collectControlJobStats(this.hudHome, now);
    }
    try {
      const facts = controlFacts(registry, this.hudHome, now, this.readJson, this.names);
      out.roles = facts.roles;
      out.harnesses = facts.harnesses;
      out.harnessSwitches = facts.harnessSwitches;
      out.models = facts.models;
      out.roleCount = facts.roles.filter((r) => r.optionalEnabled !== false).length;
      for (const bad of registry.invalid()) out.control.push({ label: 'invalid', value: bad.reason, path: bad.path });
      const ignored = registry.projectConfigIgnored();
      if (ignored) out.control.push({ label: 'ignored', value: '.hud', path: join(ignored, '.hud') });
      const c = registry.convention();
      const root = registry.project().root;
      const source = c.path === join(root, '.hud', 'hud-convention.md') || c.path === join(this.cwd, 'hud-convention.md') ? 'project'
        : c.path === join(this.hudHome, 'hud-convention.md') ? 'yours' : 'default';
      out.control.push({ label: 'convention', value: source, path: c.path });
    } catch (error) { this.switchError(out, error); }
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const path = join(this.cwd, name);
      try { if (fs.statSync(path).isFile()) out.control.push({ label: 'files', value: name, path }); }
      catch { /* absent */ }
    }
    for (const root of [
      join(this.env.CLAUDE_CONFIG_DIR || join(this.home, '.claude'), 'agents'),
      join(this.cwd, '.claude/agents'),
      join(this.env.CODEX_HOME || join(this.home, '.codex'), 'agents'),
    ]) {
      for (const name of this.names(root).filter((n) => /\.(md|toml|json)$/.test(n))) {
        const path = join(root, name);
        try { if (fs.statSync(path).isFile()) out.agents.push({ label: '', value: name, path }); }
        catch { /* absent */ }
      }
    }
    // Cache only names and booleans. RHS is checked for emptiness, never retained or returned.
    const keys = this.body(join(this.hudHome, 'credentials.env'), (buffer, truncated) => {
      const names = new Map<string, boolean>();
      const lines = buffer.toString('utf8').split('\n');
      if (truncated) lines.pop();
      for (const line of lines) {
        const name = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (name) names.set(name[1], !/^\s*(?:""|'')?\s*$/.test(line.slice(name[0].length)));
      }
      return names;
    }) ?? new Map<string, boolean>();
    // Names match CREDENTIAL_FIELDS in jev/ask/config.ts; no credential loader/value reader is called.
    out.keys = [...new Set(['GEMINI_API_KEY', 'MISTRAL_API_KEY', 'OPENAI_API_KEY', 'TYPESAFE_API_KEY', ...keys.keys()])]
      .map((n) => [n, keys.get(n) ?? false]);
    out.browser = !!executable('google-chrome', this.env) && !!executable('jev-ask', this.env);
  }
  /** Where each unsettled job of that lookup works (canonical paths), for the Projects list's per-root counts: no Git, no board. */
  liveCwds(): string[] {
    const cache = getJobIndexCache(this.hudHome);
    const cwds: string[] = [];
    for (const { id } of this.recentJobs(cache)) {
      const jobRes = cache.readJob<JobReceipt>(id);
      const job = jobRes.status === 'ok' ? jobRes.value : null;
      if (!job || typeof job.cwd !== 'string' || job.reaped_at) continue;
      const statusRes = cache.readStatus<JobStatus>(id);
      const status = statusRes.status === 'ok' ? statusRes.value : {};
      if (!SETTLED_JOB_STATES.has(ticketJobState(job, status))) {
        const cwd = canonicalPath(job.cwd);
        const wt = job.worktree;
        const root = wt?.root === cwd && typeof wt.main_root === 'string'
          ? canonicalPath(wt.main_root)
          : typeof job.project_root === 'string'
            ? canonicalPath(job.project_root)
            : cwd;
        cwds.push(root);
      }
    }
    return cwds;
  }
  private async commitDates(hashes: string[]): Promise<Map<string, number>> {
    const dates = new Map<string, number>();
    if (!hashes.length) return dates;
    try {
      const log = await worktreeGit(this.cwd, [
        'log', '--no-walk', '--ignore-missing', '--no-show-signature', '--format=%h%x00%ct', ...hashes, '--',
      ]);
      const resolved = log.trim().split('\n').filter(Boolean).map((line) => {
        const [h, ct] = line.split('\0');
        return [h?.toLowerCase() ?? '', Number(ct) * 1000] as const;
      }).filter(([h, ts]) => h && Number.isFinite(ts));
      for (const c of hashes) {
        const hit = resolved.find(([h]) => h === c || h.startsWith(c) || c.startsWith(h));
        if (hit) dates.set(c, hit[1]);
      }
    } catch { /* Unknown or unavailable commits: no at. */ }
    return dates;
  }

  private gitDirs() {
    const dot = join(this.cwd, '.git');
    const pointer = fs.lstatSync(dot, { throwIfNoEntry: false })?.isFile() && this.read(dot)?.text.match(/^gitdir: (.+)\s*$/)?.[1];
    const dir = pointer ? resolve(this.cwd, pointer.trim()) : dot;
    const common = pointer ? resolve(dir, this.read(join(dir, 'commondir'))?.text.trim() ?? '.') : dir;
    const root = pointer && basename(common) === '.git' ? canonicalPath(resolve(common, '..')) : canonicalPath(this.cwd);
    return { dir, common, root };
  }

  /** Read the loose/detached HEAD or the shared ref of a linked checkout without starting Git. */
  private probeGitRefs() {
    const { dir, common, root } = this.gitDirs();
    const trees = join(common, 'worktrees'), branches: string[] = [];
    for (const name of this.names(trees, 64)) {
      const branch = this.read(join(trees, name, 'HEAD'))?.text.trim().match(/^ref: refs\/heads\/wt\/(.+)$/)?.[1];
      if (!branch || !ticketIds(branch).length) continue;
      const back = this.read(join(trees, name, 'gitdir'))?.text.trim();
      if (back && basename(back) === '.git' && fs.lstatSync(back, { throwIfNoEntry: false })?.isFile()) branches.push(branch);
    }
    let sha = this.read(join(dir, 'HEAD'))?.text.trim() ?? '', packedKey: string | undefined;
    if (sha.startsWith('ref: refs/') && !sha.includes('..')) {
      const ref = sha.slice(5);
      sha = this.read(join(common, ref))?.text.trim() ?? '';
      if (!sha) {
        const path = join(common, 'packed-refs'), packed = this.read(path);
        sha = packed?.text.split('\n').find(l => l.endsWith(' ' + ref))?.split(' ')[0] ?? '';
        if (!sha && packed?.truncated) packedKey = `${ref}:${this.cache.get(path)?.stamp}`;
      }
    }
    return { sha, branches, packedKey, root, stamp: `${sha}\0${packedKey ?? ''}\0${branches.join('\0')}` };
  }

  private async landedTickets(rollup: TicketRollup, refs = this.probeGitRefs()) {
    for (const branch of refs.branches) rollup.worktree(branch);
    let sha = refs.sha;
    if (!sha && refs.packedKey) {
      // A ref beyond our bounded file read: ask Git once for this ref/file signature, not on each tick.
      if (this.packedHead?.key !== refs.packedKey) this.packedHead = { key: refs.packedKey, sha: (await worktreeGit(this.cwd, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim() };
      sha = this.packedHead.sha;
    }
    if (sha !== this.head) {
      this.head = sha;
      this.landed.clear();
      this.ticketCommits.clear();
      if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) try {
        const log = await worktreeGit(this.cwd, [
          'log', '-n', '64', '--no-show-signature', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-relative', '--no-color',
          '--name-status', '-z', '--format=%x00%x00%H%x00%ct%x00%s', sha, '--',
        ]);
        const commits = new Map<string, { at: number; ids: string[]; changed: Map<string, boolean> }>();
        const candidates: string[] = [], credited = new Set<string>();
        for (const chunk of log.split(landingLogBoundary)) {
          const [commitSha, ct, subject, ...fields] = chunk.split('\0');
          const at = Number(ct) * 1000;
          if (!commitSha || !Number.isFinite(at)) continue;
          let code = false;
          const changed = new Map<string, boolean>(); // Ticket ID -> newly added file.
          for (let i = 0; fields[i + 1]; i += 2) {
            const status = fields[i].trim(), path = fields[i + 1], id = ticketPathId(path);
            if (id && status !== 'D') changed.set(id, status === 'A');
            if (!path.startsWith('docs/') && !path.startsWith('.scratch/')) code = true;
          }
          if (/^Record landing\b/.test(subject)) {
            // Legacy records name the actual change in the ticket's Landed comment, not by this commit's SHA.
            for (const id of changed.keys()) this.landed.add(id);
            continue;
          }
          const ids = code ? ticketIds(subject) : [];
          // A direct landing in this or a newer commit already supplies this ticket's attribution.
          for (const id of ids) credited.add(id);
          for (const id of changed.keys()) if (credited.has(id)) changed.delete(id);
          if (changed.size) candidates.push(commitSha);
          if (ids.length || changed.size) commits.set(commitSha, { at, ids, changed });
        }
        if (candidates.length) {
          // Only unresolved ticket edits need content. No history traversal or patches outside tickets.
          const patches = await worktreeGit(this.cwd, [
            '--no-literal-pathspecs', '-c', `core.bigFileThreshold=${STATE_BYTES}`, 'log', '--no-walk',
            '--no-show-signature', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-relative', '--no-color',
            '--submodule=short', '--src-prefix=a/', '--dst-prefix=b/', '--patch', '-U0',
            '--ignore-matching-lines=^([^*]|[*][^*])+[*]?$|^\n', '--format=%x00%x00%H%x00',
            ...candidates, '--', ':(top,glob).scratch/*/issues/*.md',
          ]).catch(() => ''); // A failed patch read does not discard direct or legacy evidence.
          for (const chunk of patches.split(landingLogBoundary)) {
            const [commitSha, body] = chunk.split('\0', 2), commit = commits.get(commitSha);
            if (!body || !commit) continue;
            for (const patch of body.split(/^diff --git /m)) {
              const path = /^\+\+\+ "?b\/(.+?)"?\t?$/m.exec(patch)?.[1];
              const id = path && ticketPathId(path);
              if (!id || !commit.changed.has(id)) continue;
              const statuses = [...patch.matchAll(/^([+-])(?:[ \t]*|[^\r\n]*?·[ \t]*)\*\*Status:\*\*[ \t]*([^·\r\n]+)/gim)];
              const before = statuses.find(([, sign]) => sign === '-')?.[2].trim();
              const after = statuses.find(([, sign]) => sign === '+')?.[2].trim();
              if (after && landingStatus.test(after) && (commit.changed.get(id) || (before && !landingStatus.test(before)))) commit.ids.push(id);
            }
          }
        }
        // Apply both kinds of evidence in the original newest-first order, not the patch output order.
        for (const [commitSha, { at, ids }] of commits) for (const id of ids) {
          this.landed.add(id);
          if (!this.ticketCommits.has(id)) this.ticketCommits.set(id, { sha: commitSha, at });
        }
      } catch { /* Git unavailable: rely on ticket files. */ }
    }
    return { ids: this.landed, commits: this.ticketCommits };
  }

  private homeJobsProbe(board: WorkboardSnapshot, hasTickets: boolean, window = projectJobWindow(this.hudHome)) {
    const jobCache = getJobIndexCache(this.hudHome), canonCache = new Map<string, string>();
    const { jobs } = window;
    let { complete } = window;
    const canon = (p: string) => canonCache.get(p) ?? (canonCache.set(p, canonicalPath(p)), canonCache.get(p)!);
    const root = canon(this.cwd), inRoot = (p: string) => insideRoot(root, p), parts: string[] = [];
    for (const { id } of jobs) {
      const jobRes = jobCache.readJob<JobReceipt>(id);
      if (jobRes.status !== 'ok' || typeof jobRes.value.cwd !== 'string') { complete = false; continue; }
      const job = jobRes.value, cwd = canon(job.cwd as string), wt = job.worktree;
      const isolated = wt?.root === cwd && typeof wt.branch === 'string' && typeof wt.main_root === 'string';
      if (!inRoot(cwd) && !(isolated && inRoot(wt.main_root as string))) continue;
      const statusRes = jobCache.readStatus<JobStatus>(id);
      if (statusRes.status !== 'ok' && statusRes.status !== 'missing') complete = false;
      const briefKey = hasTickets && !job.ticket && !job.slice && job.task == null && job.brief_path == null
        ? statKey(join(jobCache.jobsRoot, id, 'brief.md')) : '';
      parts.push(`${id}:${jobRes.stamp}:${statusRes.status === 'ok' ? statusRes.stamp : statusRes.status}:${briefKey}`);
    }
    parts.push(board.workers.map((w) => `${w.evidence[0]?.sourceId ?? ''}\0${w.task ?? ''}`).join('\x1f'));
    return { stamp: JSON.stringify([complete, parts]), jobs, complete };
  }

  async collect(shown: boolean | 'home' | 'export' | 'control' | 'overview', board: WorkboardSnapshot, now: number,
    jobWindow?: ReturnType<typeof projectJobWindow>): Promise<ProjectSnapshot | undefined> {
    if (!shown) return;
    this.seen.clear();
    const out: ProjectSnapshot = {
      waiting: [], docs: [], control: [], roles: [], harnesses: [], models: { pi: [], cli: {}, bro: {} }, agents: [], keys: [], browser: false, roleCount: 0, editing: [],
      ladder: { ids: [] }, slices: [], ledger: [], active: [], next: [], summary: '', tickets: [],
      counts: { working: 0, blocked: 0, try: 0, todo: 0, accepted: 0, dropped: 0 },
    };
    if (shown === 'control') {
      this.collectControl(out, now, true);
      // This narrow read shares a collector with Project; keep its signature cache for the next Project visit.
      return out;
    }
    const home = shown === 'home' || shown === 'overview';
    const ticketsScan = this.scanTickets();
    let memoKey: string | undefined;
    let gitRefs: ReturnType<ProjectCollector['probeGitRefs']> | undefined;
    let jobsProbe: ReturnType<ProjectCollector['homeJobsProbe']> | undefined;
    const objectiveFile = objectivePath(this.cwd), objectiveStat = lstat(objectiveFile);
    const objectiveDir = lstat(join(this.cwd, '.hud'));
    if (home) {
      const stateStamps = statePaths(this.cwd).map(statKey).join('|');
      const specStamp = shown === 'overview' ? '' : statKey(join(this.cwd, 'docs/spec.md'));
      const triesStamp = statKey(join(this.hudHome, 'tries.jsonl'));
      const holdsStamp = statKey(join(this.hudHome, 'unattended-runs.json'));
      if (shown !== 'overview' && ticketsScan.features.length) gitRefs = this.probeGitRefs();
      if (shown !== 'overview') jobsProbe = this.homeJobsProbe(board, ticketsScan.features.length > 0, jobWindow);
      memoKey = [ticketsScan.stamp, stateStamps, objectiveStat && stampOf(objectiveStat), objectiveDir && stampOf(objectiveDir),
        specStamp, triesStamp, holdsStamp, gitRefs?.stamp, jobsProbe?.stamp].join('\x1e');
      const hit = this.collectMemo.get(shown);
      if (hit && hit.key === memoKey && now >= hit.claimFloor && now < hit.claimExpiry) return hit.snapshot;
    }
    out.tickets = cloneTickets(ticketsScan.features);
    const readObjectiveRecord = (): { record?: ObjectiveRecord; at?: number } | null => {
      if (objectiveStat && (!objectiveStat.isFile() || !objectiveDir?.isDirectory()))
        return { record: { stance: 'unknown', priority: 'normal', objectives: [], diagnostics: ['Invalid Objective file or .hud directory'] } };
      return this.cached(objectiveFile, (st) => ({ record: readObjectives(this.cwd), at: st.mtimeMs }), objectiveStat ?? null);
    };
    const objective = shown === 'overview' ? undefined : readObjectiveRecord();
    const objectives = objective?.record;
    if (objectives) {
      const linked = new Set(objectives.objectives.flatMap((item) => item.features));
      // Keep the linked features before the Tickets page folds away older finished ones.
      const objectiveTickets = out.tickets.filter(({ slug }) => linked.has(slug));
      if (!home) out.objectiveTickets = objectiveTickets;
      const acceptance = Object.fromEntries(objectiveTickets.filter((f) => !f.partial)
        .map(({ slug, tickets }) => [slug, tickets.reduce((n, t) => ({ checked: n.checked + t.checked, total: n.total + t.total }), { checked: 0, total: 0 })]));
      const results = shown === true ? objectives.objectives.filter((o) => o.state !== 'done' && o.result) : [];
      const receipts = results.length ? this.resultReceipts.read() : undefined;
      const resultDates = receipts && Object.fromEntries(results.flatMap(({ id, result }) => {
        const at = resultDate(receipts, this.cwd, id, result!);
        return at === undefined ? [] : [[id, at]];
      }));
      out.objectives = { ...objectives, path: objectiveFile, acceptance, ...(resultDates && { resultDates }) };
      out.objectivesAt = objective.at;
    }
    let stateFile;
    for (const path of statePaths(this.cwd)) {
      stateFile = this.read(path);
      if (stateFile) { out.statePath = path; break; }
    }
    const statePath = out.statePath, state = stateFile?.text ?? '';
    if (stateFile?.truncated) out.stateTruncated = true;
    const bullets = (heading: string, whole = false) => stateBullets(state, heading).map((text) => ({
      label: '', value: text.replace(/\s+/g, ' ').trim(), path: statePath, ...(whole ? { text: text.replace(/\r/g, '') } : {}),
    }));
    out.waiting = bullets(WAITING_HEADING, true).filter(item => !/^Owner 20\d\d-\d\d-\d\d\b/i.test(item.value) && !EMPTY_WAITING.test(item.value));
    out.next = bullets('Next');
    try { if (statePath) out.updatedAt = fs.lstatSync(statePath).mtimeMs; } catch { /* source disappeared */ }
    const nowHeading = /^## Now[^\r\n:]*:[ \t]*([^\r\n]*)/m.exec(state)?.[1];
    const nowBody = /^## Now(?: \([^\r\n]+\))?[ \t]*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(state)?.[1];
    out.summary = (nowHeading?.trim() || nowBody?.trim().replace(/^[-*] /, '') || '').replace(/\s+/g, ' ');
    const milestone = state.match(/^Milestone:[ \t]*([^\r\n]+)$/m)?.[1]?.trim();
    out.ladder.current = milestone?.split(/\s+/)[0];
    const specPath = join(this.cwd, 'docs/spec.md'), specFile = shown === 'overview' ? null : this.read(specPath);
    if (specFile?.truncated) out.specTruncated = true;
    const spec = specFile?.text.split(/^## 5\. Milestones[ \t]*\r?$/m)[1]?.split(/^## /m)[0] ?? '';
    out.ladder.ids = [...spec.matchAll(/^[-*] \*\*(M\d+[a-z]?|\d+\.\d+\.\d+),/gm)].map((m) => m[1]);
    const refreshedGit = !home ? await this.fullDetails(out, board, now, specPath, milestone) : false;
    const rollup = new TicketRollup(out.tickets);
    if (shown !== 'overview') this.joinJobs(out, board, home, shown === 'export', rollup, jobsProbe?.jobs);
    if (jobsProbe?.complete && !out.active.some(({ state }) => state !== 'queued')) out.idle = true;
    const refs = shown !== 'overview' && out.tickets.length ? (gitRefs ?? this.probeGitRefs()) : undefined;
    const landedInfo = refs ? await this.landedTickets(rollup, refs) : undefined;
    const heldTickets = out.tickets.length ? new Set(readOpenHolds(this.hudHome, refs?.root ?? this.gitDirs().root).flatMap(h => h.ticket ? [targetKey(h.ticket)] : [])) : undefined;
    const { totals, visible, rows, marks } = rollup.derive(now, landedInfo?.ids, landedInfo?.commits, (rows) => this.tries.marks(this.cwd, rows, true), heldTickets?.size ? heldTickets : undefined);
    const active = new Map(out.active.map((job) => [job.jobId, job]));
    const ticketJobs = new Map(out.tickets.flatMap(({ slug, tickets }) => tickets.map((t) => [targetKey(`${slug}/${t.number}`), t.job?.id] as const)));
    const settled = new Set([...marks].filter(([, action]) => action === 'accept').map(([id]) => targetKey(id)));
    out.ledger = rows;
    for (const row of rows) {
      if (out.ladder.current) row.release = out.ladder.current;
      out.counts[row.state]++;
      const key = targetKey(row.id);
      if (row.state === 'accepted' || row.state === 'dropped') settled.add(key);
      if (row.state === 'working' || row.state === 'blocked') {
        const job = active.get(ticketJobs.get(key) ?? '');
        out.slices.push({ label: row.id, value: row.text, path: job?.path ?? row.path, ledgerState: row.state,
          ...(job ? { jobId: job.jobId, role: job.role, asking: job.asking, at: job.at } : {}) });
      }
    }
    if (!home) await this.fullLedgerDetails(out, now, shown === 'export', refreshedGit);
    out.ticketTotals = ticketsScan.partial ? { ...totals, partial: true } : totals;
    if (out.objectives) out.unlinked = unlinkedFeatures(out.tickets, out.objectives, out.active);
    let objectiveTitles: Map<string, string> | undefined;
    out.waiting = out.waiting.filter((item) => !waitSettled(item.value, settled))
      .map((item) => {
        const fields = requestFields(item.text ?? item.value);
        return { item, fields, ...requestOrder(item.value, fields?.waits) };
      })
      .sort((a, b) => compareOwnerRequests(a, b))
      .map(({ item, fields, at, waitedOn }) => {
        const ordered = { ...item, ...(at !== undefined && { at }), ...(waitedOn && { waitedOn }) };
        if (!fields) {
          const body = item.text ?? item.value;
          const sentence = (at === undefined ? body : body.replace(/^\d{4}-\d{2}-\d{2}(?=\s|$)[ \t]*/, ''))
            .replace(/[ \t]*[（(]work waits[）)](?=[ \t]*(?:\n|$))/i, '');
          return { ...ordered, sentence };
        }
        if (fields.objective && !objectiveTitles) {
          objectiveTitles = new Map((shown === 'overview' ? readObjectiveRecord()?.record : objectives)?.objectives.map(({ id, title }) => [id, title]));
        }
        const text = fields.display(fields.objective ? objectiveTitles?.get(fields.objective) : undefined);
        return { ...ordered, request: fields.request, ...(fields.objective && { objective: fields.objective }),
          sentence: fields.sentence, text, value: text.replace(/\s+/g, ' ').trim() };
      });
    // Home summarizes linked features, not the Tickets page's preview of finished features.
    if (shown !== 'home') out.tickets = visible;
    if (home && memoKey !== undefined) {
      let claimFloor = -Infinity, claimExpiry = Infinity;
      for (const at of ticketsScan.claimTimes) {
        const edge = at + 7200000;
        if (now < edge) claimExpiry = Math.min(claimExpiry, edge);
        else claimFloor = Math.max(claimFloor, edge);
      }
      this.collectMemo.set(shown, { key: memoKey, claimFloor, claimExpiry, snapshot: out });
    }
    for (const path of this.cache.keys()) if (!this.seen.has(path)) this.cache.delete(path);
    return out;
  }

  private async fullDetails(out: ProjectSnapshot, board: WorkboardSnapshot, now: number, specPath: string, milestone?: string): Promise<boolean> {
    if (milestone) out.docs.push({ label: 'spec', value: milestone, path: specPath });
    const reviews = join(this.cwd, 'docs/reviews');
    const review = (this.orderedNames(reviews, 12, (entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}-.+\.md$/.test(entry.name), true) ?? [])
      .flatMap((n) => {
        const path = join(reviews, n);
        try {
          const st = fs.lstatSync(path);
          return st.isFile() ? [{ path, at: st.mtimeMs }] : [];
        } catch { return []; }
      }).sort((a, b) => b.at - a.at)[0];
    if (review) out.docs.push({ label: 'review', value: basename(review.path), ...review });
    this.collectControl(out, now);
    const jobCache = getJobIndexCache(this.hudHome);
    for (const w of board.workers.filter((w) => w.state === 'working')) {
      const id = w.evidence[0]?.sourceId;
      if (!id || !JOB_ID_RE.test(id)) continue;
      try {
        const res = jobCache.readJob<JobReceipt>(id);
        const record = res.status === 'ok' ? res.value : null;
        const target = record?.worktree?.main_root ?? record?.cwd;
        if (typeof target === 'string' && resolve(target) === resolve(this.cwd)) {
          const label = board.lanes.find((l) => l.id === w.laneId)?.label ?? '';
          out.editing.push({
            label: 'editing', value: `${w.role ?? ''} · ${label}  ${w.task}`,
            path: join(this.hudHome, 'jobs', id, 'brief.md'), at: w.startedAt ?? undefined,
          });
        }
      } catch { /* invalid job */ }
    }
    let refreshedGit = false;
    if (now - this.gitAt >= 5000) {
      refreshedGit = true;
      this.gitAt = now;
      this.git = undefined;
      this.last = undefined;
      this.worktrees = [];
      try {
        const filters = await neutralizeFilters(worktreeGit, this.cwd);
        this.git = parseWorktreeStatus(await worktreeGit(this.cwd, [
          ...filters, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal', '--ignore-submodules=dirty',
        ]));
        this.worktrees = parseWorktreeList(await worktreeGit(this.cwd, ['worktree', 'list', '--porcelain', '-z'])).slice(1);
        const [hash, at, subject] = (await worktreeGit(this.cwd, [
          'log', '-1', '--no-show-signature', '--format=%h%x00%ct%x00%s',
        ])).trim().split('\0');
        if (hash && at && Number.isFinite(Number(at))) this.last = { text: `${hash} ${subject}`, at: Number(at) * 1000 };
      } catch { /* No repo, unborn HEAD or failed probe: unknown, not zero. */ }
    }
    out.git = this.git;
    out.worktreeCount = this.git ? this.worktrees.length : undefined;
    out.last = this.last;
    return refreshedGit;
  }

  private async fullLedgerDetails(out: ProjectSnapshot, now: number, exporting: boolean, refreshedGit: boolean) {
    if (refreshedGit) {
      const hashes = [...new Set(out.ledger.map((r) => r.commit?.toLowerCase()).filter((c): c is string => !!c))];
      this.commitAt = await this.commitDates(hashes);
    }
    for (const row of out.ledger) {
      const at = row.commit ? this.commitAt.get(row.commit.toLowerCase()) : undefined;
      if (at !== undefined) row.at = at;
    }
    const toTry = out.ledger.filter((r) => r.state === 'try').reverse()
      .sort((a, b) => (b.at ?? -1) - (a.at ?? -1));
    const attachDiff = async (row: LedgerSlice) => {
      const diff = row.commit && await this.diffs.commits(this.cwd, row.commit, now);
      if (diff) row.diff = diff;
    };
    if (exporting) {
      // The one-shot export has no slice cap, but never starts more than four diff reads at once.
      for (let i = 0; i < toTry.length; i += 4) await Promise.all(toTry.slice(i, i + 4).map(attachDiff));
    } else {
      await Promise.all([
        ...(this.git && this.git.changed > 0 ? [this.diffs.workingTree(this.cwd, now).then((diff) => {
          if (diff) out.gitDiff = diff;
        })] : []),
        ...toTry.slice(0, 12).map(attachDiff),
      ]);
    }
  }

  private joinJobs(out: ProjectSnapshot, board: WorkboardSnapshot, home: boolean, exporting: boolean, rollup: TicketRollup, prefetchedJobs?: readonly { id: string }[]) {
    const canonCache = new Map<string, string>();
    const canonical = (p: string) => { let r = canonCache.get(p); if (r === undefined) { r = canonicalPath(p); canonCache.set(p, r); } return r; };
    const root = canonical(this.cwd);
    const inRoot = (path: string) => insideRoot(root, path);
    const jobCache = getJobIndexCache(this.hudHome);
    const jobsRoot = jobCache.jobsRoot;
    const workersByJob = new Map(board.workers.map((w) => [w.evidence[0]?.sourceId, w]));
    // An export only joins receipts for the caller's already pane-scoped workers.
    const jobs = exporting ? [...workersByJob.keys()].filter((id): id is string => !!id && JOB_ID_RE.test(id)).map((id) => ({ id })) : (prefetchedJobs ?? this.recentJobs(jobCache));
    const managed = new Map<string, string>();
    const active: { created: number; entry: ActiveJob }[] = [];
    const needsJobAge = home && !out.objectives && !out.statePath;
    for (const { id } of jobs) {
      const dir = join(jobsRoot, id);
      const jobRes = jobCache.readJob<JobReceipt>(id);
      const job = jobRes.status === 'ok' ? jobRes.value : null;
      if (!job || typeof job.cwd !== 'string') continue;
      const cwd = canonical(job.cwd);
      const wt = job.worktree;
      const isolated = wt?.root === cwd && typeof wt.branch === 'string' && typeof wt.main_root === 'string';
      if (isolated) managed.set(cwd, wt.branch as string);
      const inside = inRoot(cwd) || (isolated && inRoot(wt.main_root as string));
      if (!inside) continue;
      const created = Date.parse(String(job.created_at ?? '')) || 0;
      const statusRes = jobCache.readStatus<JobStatus>(id);
      const s = statusRes.status === 'ok' ? statusRes.value : {};
      const state = ticketJobState(job, s);
      const worker = workersByJob.get(id);
      if (!SETTLED_JOB_STATES.has(state) && !job.reaped_at) {
        const at = Date.parse(String(s.started_at ?? job.created_at ?? ''));
        // The workboard's description, the job's own title or task; a job of another pane has neither, so its brief says.
        const title = [
          worker?.task && worker.task !== id.slice(-6) ? worker.task : undefined,
          job.title, job.task,
        ].find((v): v is string => typeof v === 'string' && v.trim().length > 0)?.replace(/\s+/g, ' ').trim()
          ?? (home ? undefined : this.briefTitle(join(dir, 'brief.md'), job.task_length));
        const file = home ? undefined : firstFile(join(dir, 'report.md'), join(dir, 'brief.md'));
        active.push({
          created,
          entry: {
            jobId: id, role: typeof job.role === 'string' ? job.role : '', state,
            ...(typeof job.package === 'string' && job.package ? { package: job.package } : {}),
            ...(title ? { title: stripJobPrefix(title) } : {}), ...(Number.isFinite(at) ? { at } : {}), ...(file ? { path: file } : {}),
            asking: state === 'waiting_orchestrator',
          },
        });
      }
      if (home) {
        const at = Math.max(epoch(s.started_at) ?? epoch(job.started_at) ?? -Infinity, jobSettledAt(s) ?? -Infinity);
        if (at > (out.jobActivityAt ?? -Infinity)) out.jobActivityAt = at;
      }
      const linked = out.tickets.length > 0 && !job.parent_job;
      if (!linked && !needsJobAge) continue;
      const at = Date.parse(String(s.settled_at ?? s.ended_at ?? s.started_at ?? job.created_at ?? ''));
      if (needsJobAge && Number.isFinite(at) && at > (out.lastJobAt ?? -Infinity)) out.lastJobAt = at;
      if (linked) {
        const brief = join(dir, 'brief.md');
        const material = job.ticket || job.slice ? '' : job.task ?? job.brief_path ?? this.read(brief, 4096)?.text.slice(0, typeof job.task_length === 'number' ? job.task_length : 4096) ?? worker?.task ?? '';
        rollup.link(job, String(material), { id, role: typeof job.role === 'string' ? job.role : '',
          state: job.reaped_at && !SETTLED_JOB_STATES.has(state) ? 'closed' : state,
          created, ...(Number.isFinite(at) ? { at } : {}) });
      }
    }
    out.active = active.sort((a, b) => b.created - a.created || a.entry.jobId.localeCompare(b.entry.jobId)).map((a) => a.entry);
    if (!home) for (const tree of this.worktrees) {
      const path = canonical(tree.path), branch = tree.branch?.replace(/^wt\//, '') ?? '';
      if (!(managed.has(path) && managed.get(path) === tree.branch) && !rollup.hasTicket(branch)) out.slices.push({
        label: basename(path), value: '', drift: 'no linked ticket',
      });
    }
  }
}
