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
import { parseLedger, STATE_BYTES, stateBullets, statePaths } from './state-ledger.js';
import { DiffStatCollector, type DiffStatSummary } from './diff-stat.js';
import { collectControlRadar, type ControlRadar } from './control-radar.js';
import { ticketFileEvidence, ticketHeading } from './ticket-evidence.js';
import { TryLog } from './try-records.js';
import { SETTLED_JOB_STATES, TicketRollup, ticketIds, ticketJobState } from './ticket-rollup.js';
import { readActiveLeases, stripJobPrefix, type LeaseRecord } from './thin-jobs.js';
export { SETTLED_JOB_STATES } from './ticket-rollup.js';
export interface ProjectItem {
  label: string;
  value: string;
  original?: string;
  path?: string;
  at?: number;
  /** A waiting item's whole bullet as STATE writes it (continuation lines kept, one per line); `value` is the same words on one line. */
  text?: string;
}
export const SLICE_STATES = ['working', 'blocked', 'try', 'todo', 'accepted', 'dropped'] as const;
export type SliceState = typeof SLICE_STATES[number];
/** What a to-try slice's model brief says (spec §2.2): what changed in plain words, and how to try it. Display only. */
export interface TryBrief { brief: string; steps: string[] }
export interface LedgerSlice {
  id: string; state: SliceState; milestone: string; release?: string; text: string; commit?: string; at?: number;
  /** Laid on by the panel from its stored briefs (`TryBriefs.apply`), never collected. */
  brief?: TryBrief;
  diff?: DiffStatSummary;
}
export interface ActiveJob {
  jobId: string; role: string; state: string; package?: string; title?: string; at?: number; asking: boolean;
  /** The report, else the brief: what Enter opens on the job's row. */
  path?: string;
}
export interface TicketItem { done: boolean; text: string }
export interface ProjectTicket {
  number: string; title: string; originalTitle?: string; path: string; at: number; status: string;
  checked: number; total: number; items: TicketItem[]; comment?: string;
  blockers: string[]; state: 'done' | 'dropped' | 'try' | 'working' | 'blocked' | 'ready' | 'queued';
  job?: { role: string; state: string; at?: number; created: number };
}
export interface TicketFeature { slug: string; at: number; tickets: ProjectTicket[] }
export interface ProjectSnapshot {
  tickets: TicketFeature[];
  ticketTotals?: { doneTickets: number; totalTickets: number; doneFeatures: number; totalFeatures: number };
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
  leases?: LeaseRecord[];
  git?: WorktreeStatus;
  gitDiff?: DiffStatSummary;
  /** Linked worktrees besides the main one; with `git`, one Git read per five seconds. */
  worktreeCount?: number;
  ladder: { ids: string[]; current?: string };
  slices: (ProjectItem & { jobId?: string; role?: string; asking?: boolean; drift?: string; ledgerState?: string })[];
  ledger: LedgerSlice[];
  active: ActiveJob[];
  counts: Record<SliceState, number>;
  summary: string;
  statePath?: string;
  stateTruncated?: boolean;
  specTruncated?: boolean;
  updatedAt?: number;
  last?: { text: string; at: number };
  next: ProjectItem[];
  editing: ProjectItem[];
}
/**
 * A waiting item that ends with `(waits on ID, feature/NN)` is settled once every reference is: a ledger slice
 * `accepted` or `dropped`, a ticket done or dropped. Unknown references keep the item; so does an item naming none.
 */
export function waitSettled(text: string, ledger: ReadonlyMap<string, { state: string }>, tickets: readonly TicketFeature[]): boolean {
  const refs = [...text.matchAll(/[（(]waits on ([^()（）]+)[）)]/gi)].at(-1)?.[1].split(/,|\s+and\s+/i).map((r) => r.trim()).filter(Boolean) ?? [];
  return refs.length > 0 && refs.every((ref) => {
    const ticket = ref.match(/^([\w.-]+)[/#](\d+)$/);
    if (ticket) {
      const found = tickets.find((f) => f.slug === ticket[1])?.tickets.find((t) => Number(t.number) === Number(ticket[2]));
      return !!found && (found.state === 'done' || found.state === 'dropped');
    }
    const slice = ledger.get(ref);
    return !!slice && (slice.state === 'accepted' || slice.state === 'dropped');
  });
}
const canonicalPath = (path: string) => { try { return fs.realpathSync(path); } catch { return resolve(path); } };
export const insideRoot = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
interface JobReceipt {
  cwd?: unknown;
  worktree?: { root?: unknown; branch?: unknown; main_root?: unknown };
  created_at?: unknown;
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
}
interface JobStatus {
  state?: unknown;
  started_at?: unknown;
  settled_at?: unknown;
  ended_at?: unknown;
}
const firstFile = (...paths: string[]) => paths.find((p) => { try { return fs.lstatSync(p).isFile(); } catch { return false; } });
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
  private homeTryDates = new Map<string, number>();
  private homePendingHashes = '';
  private diffs = new DiffStatCollector();
  private tries: TryLog;
  private head = '';
  private packedHead?: { key: string; sha: string };
  private landed = new Set<string>();
  constructor(private cwd: string, private hudHome: string, private env = process.env, private home = homedir()) { this.tries = new TryLog(hudHome); }
  private cached<T>(path: string, load: (st: fs.Stats) => T): T | null {
    try {
      const st = fs.lstatSync(path, { throwIfNoEntry: false });
      if (!st) { this.cache.delete(path); return null; }
      this.seen.add(path);
      if (!st.isFile() && !st.isDirectory()) return null;
      const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
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
  private orderedNames(path: string, limit: number, keep: (entry: fs.Dirent) => boolean, descending = false): string[] {
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
    }) ?? [];
  }
  private body<T>(path: string, parse: (buffer: Buffer, truncated: boolean) => T): T | null {
    return this.cached(path, (st) => {
      if (!st.isFile()) throw Error('not_file');
      const { bytes, truncated } = readFileBounded(path, STATE_BYTES);
      return parse(bytes, truncated || st.size > bytes.length);
    });
  }
  private read = (path: string, limit = 65536) => {
    const file = this.body(path, (b, truncated) => ({ text: b.toString('utf8'), truncated }));
    return file && { text: file.text.slice(0, limit), truncated: file.truncated || Buffer.byteLength(file.text) > limit };
  };
  /** Features by when their issues folder last changed (a ticket added or renamed), name breaking ties. */
  private recentFeatures(root: string, limit: number): string[] {
    const at = (slug: string) => fs.lstatSync(join(root, slug, 'issues'), { throwIfNoEntry: false })?.mtimeMs ?? -1;
    return this.orderedNames(root, 256, (entry) => entry.isDirectory()).map((slug) => ({ slug, at: at(slug) }))
      .sort((a, b) => b.at - a.at || (a.slug < b.slug ? -1 : 1)).slice(0, limit).map((x) => x.slug);
  }
  private tickets(): TicketFeature[] {
    const root = join(this.cwd, '.scratch'), features: TicketFeature[] = [];
    // Bound the scan, not the totals to the subset of features displayed.
    let budget = 512;
    for (const slug of this.recentFeatures(root, 64)) {
      if (budget <= 0) break;
      const issues = join(root, slug, 'issues'), tickets: ProjectTicket[] = [];
      const names = this.orderedNames(issues, 64, (entry) => entry.isFile() && /^\d+-[^/]+\.md$/.test(entry.name)).slice(0, budget);
      budget -= names.length;
      for (const name of names) {
        const path = join(issues, name);
        const ticket = this.body(path, (buffer, truncated): ProjectTicket | null => {
          if (truncated) return null;
          const text = buffer.toString('utf8'), heading = ticketHeading(text, Number(name.split('-')[0]));
          const { status, blocked, items, checked, landed } = ticketFileEvidence(text);
          if (!heading || !status || blocked === undefined) return null;
          const commentsSection = text.split(/^## Comments[ \t]*\r?$/m)[1]?.split(/^## /m)[0] ?? '';
          const commentRaw = [...commentsSection.matchAll(/^[-*] (.+(?:\r?\n[ \t]+.+)*)/gm)].at(-1)?.[1]?.replace(/\s+/g, ' ').trim();
          const comment = commentRaw ? commentRaw.slice(0, 600) : undefined;
          return { ...heading, path, at: fs.lstatSync(path).mtimeMs, status,
            checked, total: items.length, items, ...(comment !== undefined ? { comment } : {}),
            blockers: /^none\b/i.test(blocked) ? [] : [blocked],
            state: landed ?? (/^claimed\b/i.test(status) ? 'working' : 'ready') };
        });
        // Clone: dependency/job overlays must not mutate the signature-cached parse.
        if (ticket) tickets.push({ ...ticket, blockers: [...ticket.blockers] });
      }
      tickets.sort((a, b) => Number(a.number) - Number(b.number) || a.path.localeCompare(b.path));
      if (tickets.length) features.push({ slug, at: Math.max(...tickets.map((t) => t.at)), tickets });
    }
    features.sort((a, b) => b.at - a.at || a.slug.localeCompare(b.slug));
    return features;
  }
  /** The newest 64 job directories: the one lookup behind Project's Now section and the Projects list. */
  private recentJobs(cache = getJobIndexCache(this.hudHome)) {
    return cache.listJobDirsByMtime({ limit: 64 }).dirs;
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
        harnessSwitchError: undefined, models: facts.models, roleCount: facts.roles.length });
    } catch (error) { this.switchError(snapshot, error); }
  }
  private switchError(snapshot: ProjectSnapshot, error: unknown): void {
    if (error instanceof HarnessSwitchError)
      Object.assign(snapshot, { roles: [], harnessSwitches: [], roleCount: 0, harnessSwitchError: error.path });
  }
  private collectControl(out: ProjectSnapshot, now: number, showLeases = false): void {
    const radar = collectControlRadar(this.hudHome, this.env, now);
    if (radar) out.radar = radar;
    const registry = this.registry();
    if (showLeases) out.leases = readActiveLeases(this.hudHome, registry.project().root);
    try {
      const facts = controlFacts(registry, this.hudHome, now, this.readJson, this.names);
      out.roles = facts.roles;
      out.harnesses = facts.harnesses;
      out.harnessSwitches = facts.harnessSwitches;
      out.models = facts.models;
      out.roleCount = facts.roles.length;
      for (const bad of registry.invalid()) out.control.push({ label: 'invalid', value: bad.reason, path: bad.path });
      const ignored = registry.projectConfigIgnored();
      if (ignored) out.control.push({ label: 'ignored', value: '.hud', path: join(ignored, '.hud') });
      const c = registry.convention();
      const root = registry.project().root;
      const source = c.path === join(root, '.hud', 'hud-convention.md') || c.path === join(this.cwd, 'hud-convention.md') ? 'project'
        : c.path === join(this.hudHome, 'hud-convention.md') ? 'yours' : 'default';
      out.control.push({ label: 'convention', value: source, path: c.path });
      for (const path of facts.piRoleFiles) out.control.push({ label: 'pi role', value: basename(path, '.md'), path });
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
      if (!SETTLED_JOB_STATES.has(ticketJobState(job, status))) cwds.push(canonicalPath(job.cwd));
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

  /** Read the loose/detached HEAD or the shared ref of a linked checkout without starting Git. */
  private async landedTickets(rollup: TicketRollup) {
    const dot = join(this.cwd, '.git');
    const pointer = fs.lstatSync(dot, { throwIfNoEntry: false })?.isFile() && this.read(dot)?.text.match(/^gitdir: (.+)\s*$/)?.[1];
    const dir = pointer ? resolve(this.cwd, pointer.trim()) : dot;
    const common = pointer ? resolve(dir, this.read(join(dir, 'commondir'))?.text.trim() ?? '.') : dir;
    const trees = join(common, 'worktrees');
    for (const name of this.names(trees, 64)) {
      const branch = this.read(join(trees, name, 'HEAD'))?.text.trim().match(/^ref: refs\/heads\/wt\/(.+)$/)?.[1];
      if (!branch || !ticketIds(branch).length) continue;
      const back = this.read(join(trees, name, 'gitdir'))?.text.trim();
      if (back && basename(back) === '.git' && fs.lstatSync(back, { throwIfNoEntry: false })?.isFile()) rollup.worktree(branch);
    }
    let sha = this.read(join(dir, 'HEAD'))?.text.trim() ?? '';
    if (sha.startsWith('ref: refs/') && !sha.includes('..')) {
      const ref = sha.slice(5);
      sha = this.read(join(common, ref))?.text.trim() ?? '';
      if (!sha) {
        const path = join(common, 'packed-refs'), packed = this.read(path);
        sha = packed?.text.split('\n').find(l => l.endsWith(' ' + ref))?.split(' ')[0] ?? '';
        if (!sha && packed?.truncated) {
          // A ref beyond our bounded file read: ask Git once for this ref/file signature, not on each tick.
          const key = `${ref}:${this.cache.get(path)?.stamp}`;
          if (this.packedHead?.key !== key) this.packedHead = { key, sha: (await worktreeGit(this.cwd, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim() };
          sha = this.packedHead.sha;
        }
      }
    }
    if (sha !== this.head) {
      this.head = sha;
      this.landed.clear();
      if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) try {
        const subjects = await worktreeGit(this.cwd, ['log', '-n', '64', '--no-show-signature', '--format=%s', sha, '--']);
        this.landed = new Set(ticketIds(subjects));
      } catch { /* Git unavailable: rely on the ledger. */ }
    }
    return this.landed;
  }

  async collect(shown: boolean | 'home' | 'home-tasks' | 'export' | 'control' | 'overview', board: WorkboardSnapshot, now: number): Promise<ProjectSnapshot | undefined> {
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
    out.tickets = this.tickets();
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
    out.waiting = bullets('Waiting for the owner', true).filter(item => !/^Owner 20\d\d-\d\d-\d\d\b/i.test(item.value));
    out.next = bullets('Next');
    try { if (statePath) out.updatedAt = fs.lstatSync(statePath).mtimeMs; } catch { /* source disappeared */ }
    out.summary = state.match(/^## Now[^\r\n:]*:[ \t]*([^\r\n]*)/m)?.[1]?.trim()
      ?? state.match(/^## Now(?: \([^\r\n]+\))?[ \t]*\r?\n\s*[-*] ([^\r\n]+)/m)?.[1]?.trim() ?? '';
    const ledger = new Map<string, { state: string; text: string }>();
    const parsed = parseLedger(state), marks = this.tries.marks(this.cwd, parsed, true);
    for (const { state: raw, milestone, id, text } of parsed) {
      const status = raw === 'done' || marks.get(id) === 'accept' ? 'accepted' : raw;
      if (marks.get(id) === 'flag') out.waiting.push({ label: id, value: `⚑ ${id} · ${text}`, path: statePath });
      ledger.set(id, { state: status, text });
      if (!SLICE_STATES.includes(status as SliceState)) continue;
      const state = status as SliceState;
      out.counts[state]++;
      const commit = [...text.matchAll(/\b[0-9a-f]{7,40}\b/gi)].at(-1)?.[0];
      out.ledger.push({ id, state, milestone, text, ...(commit ? { commit } : {}) });
      if (state === 'working' || state === 'blocked') out.slices.push({
        label: id, value: text, path: statePath, ledgerState: state,
      });
    }
    // Accepted tries still settle their named waits and tickets after their STATE rows are archived.
    for (const [id, action] of marks) if (action === 'accept' && !ledger.has(id)) ledger.set(id, { state: 'accepted', text: '' });
    const milestone = state.match(/^Milestone:[ \t]*([^\r\n]+)$/m)?.[1]?.trim();
    out.ladder.current = milestone?.split(/\s+/)[0];
    const specPath = join(this.cwd, 'docs/spec.md'), specFile = shown === 'overview' ? null : this.read(specPath);
    if (specFile?.truncated) out.specTruncated = true;
    const spec = specFile?.text.split(/^## 5\. Milestones[ \t]*\r?$/m)[1]?.split(/^## /m)[0] ?? '';
    out.ladder.ids = [...spec.matchAll(/^[-*] \*\*(M\d+[a-z]?|\d+\.\d+\.\d+),/gm)].map((m) => m[1]);
    // Keep the raw scope for task grouping and TryLog identity, separately attribute the release bar.
    let activeBlock = true;
    for (const r of out.ledger) {
      const prefix = r.milestone.split('/')[0];
      if (out.ladder.ids.includes(prefix) || /^(?:M\d+[a-z]?|\d+\.\d+\.(?:\d+|x))$/i.test(prefix)) {
        if (prefix !== r.milestone) r.release = prefix;
        if (out.ladder.current && out.ladder.ids.includes(prefix)) activeBlock = out.ladder.ids.indexOf(prefix) >= out.ladder.ids.indexOf(out.ladder.current);
      } else if (activeBlock && out.ladder.current) r.release = out.ladder.current;
    }
    const home = shown === 'home' || shown === 'home-tasks' || shown === 'overview';
    if (!home) await this.fullDetails(out, board, now, shown === 'export', specPath, milestone);
    const rollup = new TicketRollup(out.tickets);
    const liveSlices = shown === 'overview' ? [] : this.joinJobs(out, board, home, shown === 'export', rollup, ledger);
    const { totals, visible, running } = rollup.derive(out.ledger, shown !== 'overview' && out.tickets.length ? await this.landedTickets(rollup) : new Set(), now, marks);
    for (const row of [...running, ...liveSlices]) {
      const old = out.ledger.find(r => r.id === row.id);
      if (old) {
        if (old.state === row.state || !['todo', 'working'].includes(old.state)) continue;
        out.counts[old.state]--;
        old.state = row.state;
      } else out.ledger.push({ ...row, release: out.ladder.current });
      out.counts[row.state]++;
      const entry = out.slices.find(s => s.label === row.id);
      if (entry) entry.ledgerState = row.state;
      else out.slices.push({ label: row.id, value: row.text, ledgerState: row.state });
    }
    out.ticketTotals = totals;
    out.waiting = out.waiting.filter((item) => !waitSettled(item.value, ledger, out.tickets));
    out.tickets = visible;
    if (shown === 'home-tasks') {
      const tries = out.ledger.filter((r) => r.state === 'try');
      const hashes = [...new Set(tries.flatMap((r) => r.commit ? [r.commit.toLowerCase()] : []))]
        .filter((hash) => !this.homeTryDates.has(hash)).sort();
      const key = hashes.join(' ');
      if (key !== this.homePendingHashes) {
        // Unknown commits stay undated; don't retry an unchanged set of misses on the clock.
        for (const [hash, at] of await this.commitDates(hashes)) this.homeTryDates.set(hash, at);
        this.homePendingHashes = hashes.filter((hash) => !this.homeTryDates.has(hash)).join(' ');
      }
      for (const row of tries) {
        const at = row.commit ? this.homeTryDates.get(row.commit.toLowerCase()) : undefined;
        if (at !== undefined) row.at = at;
      }
    }
    for (const path of this.cache.keys()) if (!this.seen.has(path)) this.cache.delete(path);
    return out;
  }

  private async fullDetails(out: ProjectSnapshot, board: WorkboardSnapshot, now: number, exporting: boolean, specPath: string, milestone?: string) {
    if (milestone) out.docs.push({ label: 'spec', value: milestone, path: specPath });
    const reviews = join(this.cwd, 'docs/reviews');
    const review = this.orderedNames(reviews, 12, (entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}-.+\.md$/.test(entry.name), true)
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
    if (now - this.gitAt >= 5000) {
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
      const hashes = [...new Set(out.ledger.map((r) => r.commit?.toLowerCase()).filter((c): c is string => !!c))];
      this.commitAt = await this.commitDates(hashes);
    }
    for (const row of out.ledger) {
      const at = row.commit ? this.commitAt.get(row.commit.toLowerCase()) : undefined;
      if (at !== undefined) row.at = at;
    }
    out.git = this.git;
    const toTry = out.ledger.filter((r) => r.state === 'try').reverse()
      .sort((a, b) => (b.at ?? -1) - (a.at ?? -1));
    const attachDiff = async (row: LedgerSlice) => {
      const diff = await this.diffs.commits(this.cwd, row.text, now);
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
    out.worktreeCount = this.git ? this.worktrees.length : undefined;
    out.last = this.last;
  }

  private joinJobs(out: ProjectSnapshot, board: WorkboardSnapshot, home: boolean, exporting: boolean, rollup: TicketRollup, ledger: Map<string, {state: string; text: string}>) {
    const statePath = out.statePath;
    const canonical = canonicalPath, root = canonical(this.cwd);
    const inRoot = (path: string) => insideRoot(root, path);
    const jobCache = getJobIndexCache(this.hudHome);
    const jobsRoot = jobCache.jobsRoot;
    const workersByJob = new Map(board.workers.map((w) => [w.evidence[0]?.sourceId, w]));
    // An export only joins receipts for the caller's already pane-scoped workers.
    const jobs = exporting ? [...workersByJob.keys()].filter((id): id is string => !!id && JOB_ID_RE.test(id)).map((id) => ({ id })) : this.recentJobs(jobCache);
    const byTree = new Map<string, { jobId: string; role: string; asking: boolean; path?: string; at?: number; created: number }>();
    const managed = new Map<string, string>();
    const active: { created: number; entry: ActiveJob }[] = [];
    const liveSlices = new Map<string, LedgerSlice>();
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
      if (!inside && (home || exporting)) continue;
      const created = Date.parse(String(job.created_at ?? '')) || 0;
      if (!inside && (byTree.get(cwd)?.created ?? -Infinity) >= created) continue;
      const statusRes = jobCache.readStatus<JobStatus>(id);
      const s = statusRes.status === 'ok' ? statusRes.value : {};
      const state = ticketJobState(job, s);
      const worker = workersByJob.get(id);
      if (inside && !SETTLED_JOB_STATES.has(state) && !job.reaped_at) {
        const at = Date.parse(String(s.started_at ?? job.created_at ?? ''));
        // The workboard's description, the job's own title or task; a job of another pane has neither, so its brief says.
        const title = [
          worker?.task && worker.task !== id.slice(-6) ? worker.task : undefined,
          job.title, job.task,
        ].find((v): v is string => typeof v === 'string' && v.trim().length > 0)?.replace(/\s+/g, ' ').trim()
          ?? (home ? undefined : this.briefTitle(join(dir, 'brief.md'), job.task_length));
        const file = home ? undefined : firstFile(join(dir, 'report.md'), join(dir, 'brief.md'));
        if (typeof job.slice === 'string' && job.slice && !job.ticket && !rollup.hasTicket(job.slice)) {
          liveSlices.set(job.slice, { id: job.slice, state: ['waiting_orchestrator', 'blocked'].includes(state) ? 'blocked' : 'working',
            milestone: job.package ?? '—', text: title || job.slice });
        }
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
      const report = join(dir, 'report.md'), brief = join(dir, 'brief.md');
      if (inside && out.tickets.length) {
        const material = job.ticket || job.slice ? '' : job.task ?? job.brief_path ?? this.read(brief, 4096)?.text.slice(0, typeof job.task_length === 'number' ? job.task_length : 4096) ?? worker?.task ?? '';
        const at = Date.parse(String(s.settled_at ?? s.ended_at ?? s.started_at ?? job.created_at ?? ''));
        rollup.link(job, String(material), { role: typeof job.role === 'string' ? job.role : '',
          state: job.reaped_at && !SETTLED_JOB_STATES.has(state) ? 'closed' : state,
          created, ...(Number.isFinite(at) ? { at } : {}) });
      }
      if (home) continue;
      if ((byTree.get(cwd)?.created ?? -Infinity) >= created) continue;
      const path = firstFile(report, brief);
      const at = Date.parse(String(s.started_at ?? job.created_at ?? ''));
      byTree.set(cwd, { jobId: id, role: typeof job.role === 'string' ? job.role : '', created,
        asking: s.state === 'waiting_orchestrator', path, ...(Number.isFinite(at) ? { at } : {}) });
    }
    out.active = active.sort((a, b) => b.created - a.created || a.entry.jobId.localeCompare(b.entry.jobId)).map((a) => a.entry);
    if (home) return liveSlices.values();
    for (const slice of out.slices) if (ledger.get(slice.label)?.state === 'working' &&
      !this.worktrees.some((tree) => basename(tree.path) === slice.label)) slice.drift = 'no worktree';
    for (const tree of this.worktrees) {
      const path = canonical(tree.path), id = basename(path), job = byTree.get(path), entry = ledger.get(id);
      let slice = out.slices.find((r) => r.label === id);
      if (!slice) {
        slice = { label: id, value: entry?.text ?? '', path: statePath,
          drift: managed.get(path) === tree.branch ? undefined : entry ? 'ledger' : 'not in ledger', ledgerState: entry?.state };
        out.slices.push(slice);
      }
      if (job) Object.assign(slice, job, { path: job.path ?? statePath });
    }
    return liveSlices.values();
  }
}
