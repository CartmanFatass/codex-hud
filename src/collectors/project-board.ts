/** On-demand, read-only Project facts. No MCP startup, models, browser IPC or writes. */
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { roleRegistry } from '../roles/roster.js';
import { neutralizeFilters, parseWorktreeList, parseWorktreeStatus, worktreeGit, type WorktreeInfo, type WorktreeStatus } from './worktrees.js';
import type { WorkboardSnapshot } from './workboard-types.js';
export interface ProjectItem {
  label: string;
  value: string;
  path?: string;
  at?: number;
}
export const SLICE_STATES = ['working', 'blocked', 'try', 'todo', 'accepted', 'dropped'] as const;
export type SliceState = typeof SLICE_STATES[number];
export interface ProjectTicket {
  number: string; title: string; path: string; at: number; status: string;
  checked: number; total: number; blockers: string[]; state: 'done' | 'dropped' | 'working' | 'blocked' | 'ready';
  job?: { role: string; state: string; at?: number; created: number };
}
export interface TicketFeature { slug: string; at: number; tickets: ProjectTicket[] }
export interface ProjectSnapshot {
  tickets: TicketFeature[];
  waiting: ProjectItem[];
  docs: ProjectItem[];
  control: ProjectItem[];
  agents: ProjectItem[];
  keys: [string, boolean][];
  browser: boolean;
  roleCount: number;
  git?: WorktreeStatus;
  ladder: { ids: string[]; current?: string };
  slices: (ProjectItem & { jobId?: string; role?: string; asking?: boolean; drift?: string; ledgerState?: string })[];
  counts: Record<SliceState, number>;
  summary: string;
  statePath?: string;
  updatedAt?: number;
  last?: { text: string; at: number };
  next: ProjectItem[];
  editing: ProjectItem[];
}
export const projectShown = (state: { mainTab?: string; focus: string; help: boolean }, modal = false) =>
  state.mainTab === 'project' && state.focus === 'agents' && !state.help && !modal;
export class ProjectCollector {
  private cache = new Map<string, { stamp: string; value: unknown }>();
  private seen = new Set<string>();
  private gitAt = -Infinity;
  private git?: WorktreeStatus;
  private last?: ProjectSnapshot['last'];
  private worktrees: WorktreeInfo[] = [];
  constructor(private cwd: string, private hudHome: string, private env = process.env, private home = homedir()) {}
  private cached<T>(path: string, load: (st: fs.Stats) => T): T | null {
    try {
      const st = fs.lstatSync(path);
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
  private body<T>(path: string, parse: (buffer: Buffer, truncated: boolean) => T): T | null {
    return this.cached(path, (st) => {
      if (!st.isFile()) throw Error('not_file');
      const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const buffer = Buffer.alloc(65536), size = fs.readSync(fd, buffer, 0, buffer.length, 0);
        return parse(buffer.subarray(0, size), st.size > size);
      } finally { fs.closeSync(fd); }
    });
  }
  private read = (path: string, limit = 65536) => {
    const file = this.body(path, (b, truncated) => ({ text: b.toString('utf8'), truncated }));
    return file && { text: file.text.slice(0, limit), truncated: file.truncated || Buffer.byteLength(file.text) > limit };
  };
  private tickets(): TicketFeature[] {
    const root = join(this.cwd, '.scratch'), features: TicketFeature[] = [];
    for (const slug of this.names(root).slice(0, 16)) {
      const issues = join(root, slug, 'issues'), tickets: ProjectTicket[] = [];
      for (const name of this.names(issues).filter((n) => /^\d+-[^/]+\.md$/.test(n)).slice(0, 64)) {
        const path = join(issues, name);
        const ticket = this.body(path, (buffer, truncated): ProjectTicket | null => {
          if (truncated) return null;
          const text = buffer.toString('utf8'), heading = text.match(/^# (\d+):[ \t]*(\S[^\r\n]*)/m);
          const field = (key: string) => text.match(new RegExp(`^\\*\\*${key}:\\*\\*[ \\t]*([^\\r\\n]*)`, 'mi'))?.[1]?.trim();
          const status = field('Status'), blocked = field('Blocked by');
          if (!heading || !heading[2].trim() || Number(heading[1]) !== Number(name.split('-')[0]) || !status || blocked === undefined) return null;
          const boxes = [...text.matchAll(/^[ \t]*[-*] \[([ xX])\]/gm)];
          const checked = boxes.filter((b) => b[1].toLowerCase() === 'x').length;
          return { number: heading[1], title: heading[2].trim(), path, at: fs.lstatSync(path).mtimeMs, status,
            checked, total: boxes.length, blockers: /^none\b/i.test(blocked) ? [] : [blocked],
            state: /^wontfix$/i.test(status) ? 'dropped'
              : /^(done|closed|complete|resolved)$/i.test(status) || (boxes.length > 0 && checked === boxes.length) ? 'done'
              : /^claimed$/i.test(status) ? 'working' : 'ready' };
        });
        // Clone: dependency/job overlays must not mutate the signature-cached parse.
        if (ticket) tickets.push({ ...ticket, blockers: [...ticket.blockers] });
      }
      tickets.sort((a, b) => Number(a.number) - Number(b.number) || a.path.localeCompare(b.path));
      for (const ticket of tickets) {
        const references = ticket.blockers[0] ?? '';
        const title = (value: string) => value.trim().toLowerCase();
        const refs = tickets.some((t) => title(t.title) === title(references)) ? [references] : references.split(/[,;]|\s+and\s+/i);
        ticket.blockers = refs.filter((ref) => ref.trim()).flatMap((ref) => {
          const number = ref.trim().match(/^#?(\d+)\b/)?.[1];
          const target = (number ? tickets.find((t) => Number(t.number) === Number(number)) : undefined)
            ?? tickets.find((t) => title(t.title) === title(ref));
          return target && ['done', 'dropped'].includes(target.state) ? [] : [target?.number ?? ref.trim()];
        });
        if (ticket.state === 'ready' && ticket.blockers.length) ticket.state = 'blocked';
      }
      if (tickets.length) features.push({ slug, at: Math.max(...tickets.map((t) => t.at)), tickets });
    }
    return features.sort((a, b) => b.at - a.at || a.slug.localeCompare(b.slug));
  }
  async collect(shown: boolean | 'home', board: WorkboardSnapshot, now: number): Promise<ProjectSnapshot | undefined> {
    if (!shown) return;
    this.seen.clear();
    const out: ProjectSnapshot = {
      waiting: [], docs: [], control: [], agents: [], keys: [], browser: false, roleCount: 0, editing: [],
      ladder: { ids: [] }, slices: [], next: [], summary: '', tickets: this.tickets(),
      counts: { working: 0, blocked: 0, try: 0, todo: 0, accepted: 0, dropped: 0 },
    };
    const statePath = [join(this.cwd, 'docs/handoff/STATE.md'), join(this.cwd, 'STATE.md')].find((p) => this.read(p));
    const state = statePath ? this.read(statePath)!.text : '';
    const bullets = (heading: string) => {
      const section = state.split(new RegExp(`^## ${heading}[ \\t]*\\r?$`, 'm'))[1]?.split(/^## /m)[0] ?? '';
      return [...section.matchAll(/^[-*] (.+(?:\r?\n[ \t]+.+)*)/gm)].map((m) => ({
        label: '', value: m[1].replace(/\s+/g, ' ').trim(), path: statePath,
      }));
    };
    out.waiting = bullets('Waiting for the owner');
    out.next = bullets('Next');
    out.statePath = statePath;
    try { if (statePath) out.updatedAt = fs.lstatSync(statePath).mtimeMs; } catch { /* source disappeared */ }
    out.summary = state.match(/^## Now[^\r\n:]*:[ \t]*([^\r\n]*)/m)?.[1]?.trim() ?? '';
    const ledger = new Map<string, { state: string; text: string }>();
    for (const row of bullets('Slices')) {
      const parts = row.value.split(/\s+·\s+/);
      if (parts.length < 4) continue;
      const [status, , id, ...text] = parts;
      ledger.set(id, { state: status, text: text.join(' · ') });
      if (!SLICE_STATES.includes(status as SliceState)) continue;
      out.counts[status as SliceState]++;
      if (status === 'working' || status === 'blocked') out.slices.push({
        label: id, value: text.join(' · '), path: statePath, ledgerState: status,
      });
    }
    const milestone = state.match(/^Milestone:[ \t]*([^\r\n]+)$/m)?.[1]?.trim();
    out.ladder.current = milestone?.split(/\s+/)[0];
    if (shown === 'home') {
      for (const path of this.cache.keys()) if (!this.seen.has(path)) this.cache.delete(path);
      return out;
    }
    const spec = this.read(join(this.cwd, 'docs/spec.md'))?.text.split(/^## 5\. Milestones[ \t]*\r?$/m)[1]?.split(/^## /m)[0] ?? '';
    out.ladder.ids = [...spec.matchAll(/^[-*] \*\*(M[^,\s*]+),/gm)].map((m) => m[1]);
    if (milestone) out.docs.push({ label: 'spec', value: milestone, path: join(this.cwd, 'docs/spec.md') });
    const reviews = join(this.cwd, 'docs/reviews');
    const review = this.names(reviews).filter((n) => n.endsWith('.md')).reverse().slice(0, 12)
      .flatMap((n) => {
        const path = join(reviews, n);
        try {
          const st = fs.lstatSync(path);
          return st.isFile() ? [{ path, at: st.mtimeMs }] : [];
        } catch { return []; }
      }).sort((a, b) => b.at - a.at)[0];
    if (review) out.docs.push({ label: 'review', value: basename(review.path), ...review });
    const registry = roleRegistry(this.hudHome, this.cwd, this.env, this.read, this.names, undefined, (path) => {
      const file = this.read(path);
      return file && !file.truncated ? JSON.parse(file.text) : null;
    });
    try {
      for (const role of registry.roles().values()) {
        const a = registry.assignment(role);
        out.control.push({
          label: a.role, value: [a.harness, a.model, a.thinking ?? a.effort].filter(Boolean).join('  '), path: a.source_file,
        });
        if (a.pi_role_file) out.control.push({ label: '', value: basename(a.pi_role_file), path: a.pi_role_file });
        out.roleCount++;
      }
      const c = registry.convention();
      const source = c.path === join(this.cwd, 'hud-convention.md') ? 'project'
        : c.path === join(this.hudHome, 'hud-convention.md') ? 'yours' : 'default';
      out.control.push({ label: 'convention', value: source, path: c.path });
    } catch { /* Invalid/unavailable registry is not an invented assignment. */ }
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
    try { out.browser = fs.statSync(join(this.hudHome, 'jev-runtime/runtime.json')).isFile(); }
    catch { /* not set up */ }
    for (const w of board.workers.filter((w) => w.state === 'working')) {
      const id = w.evidence[0]?.sourceId;
      if (!id || !/^j[0-9a-f]{16}$/.test(id)) continue;
      const job = this.read(join(this.hudHome, 'jobs', id, 'job.json'));
      try {
        if (job && !job.truncated && resolve(JSON.parse(job.text).cwd) === resolve(this.cwd)) {
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
          ...filters, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal',
        ]));
        this.worktrees = parseWorktreeList(await worktreeGit(this.cwd, ['worktree', 'list', '--porcelain', '-z'])).slice(1);
        const [hash, at, subject] = (await worktreeGit(this.cwd, [
          'log', '-1', '--no-show-signature', '--format=%h%x00%ct%x00%s',
        ])).trim().split('\0');
        if (hash && at && Number.isFinite(Number(at))) this.last = { text: `${hash} ${subject}`, at: Number(at) * 1000 };
      } catch { /* No repo, unborn HEAD or failed probe: unknown, not zero. */ }
    }
    out.git = this.git;
    out.last = this.last;
    const canonical = (path: string) => { try { return fs.realpathSync(path); } catch { return resolve(path); } };
    const jobsRoot = join(this.hudHome, 'jobs');
    const jobs = this.names(jobsRoot, Infinity).filter((id) => /^j[0-9a-f]{16}$/.test(id)).flatMap((id) => {
      try {
        const st = fs.lstatSync(join(jobsRoot, id));
        return st.isDirectory() ? [{ id, at: st.mtimeMs }] : [];
      } catch { return []; }
    }).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).slice(0, 64);
    const byTree = new Map<string, { jobId: string; role: string; asking: boolean; path?: string; at?: number; created: number }>();
    const json = (path: string) => {
      const file = this.read(path);
      try { return file && !file.truncated ? JSON.parse(file.text) : null; } catch { return null; }
    };
    for (const { id } of jobs) {
      const dir = join(jobsRoot, id), job = json(join(dir, 'job.json'));
      if (!job || typeof job.cwd !== 'string') continue;
      const cwd = canonical(job.cwd);
      const created = Date.parse(job.created_at) || 0;
      const feature = out.tickets.find((f) => f.slug === job.package);
      if (!feature && (byTree.get(cwd)?.created ?? -Infinity) >= created) continue;
      const s = json(join(dir, 'STATUS.json')) ?? {};
      const report = join(dir, 'report.md'), brief = join(dir, 'brief.md');
      if (feature) {
        const worker = board.workers.find((w) => w.evidence[0]?.sourceId === id);
        const material = [job.task, job.brief_path, worker?.task, this.read(brief)?.text].filter((v) => typeof v === 'string').join('\n');
        for (const ticket of feature.tickets) {
          if ((ticket.job?.created ?? -Infinity) >= created) continue;
          const mentions = material.includes(basename(ticket.path)) || new RegExp(`(^|[^\\w])${ticket.number}(?![\\w])`).test(material);
          if (!mentions) continue;
          const at = Date.parse(s.settled_at ?? s.ended_at ?? s.started_at ?? job.created_at);
          ticket.job = { role: typeof job.role === 'string' ? job.role : '', state: typeof s.state === 'string' ? s.state : 'working',
            created, ...(Number.isFinite(at) ? { at } : {}) };
        }
      }
      if ((byTree.get(cwd)?.created ?? -Infinity) >= created) continue;
      const path = [report, brief].find((p) => { try { return fs.lstatSync(p).isFile(); } catch { return false; } });
      const at = Date.parse(s.started_at ?? job.created_at);
      byTree.set(cwd, { jobId: id, role: typeof job.role === 'string' ? job.role : '', created,
        asking: s.state === 'waiting_orchestrator', path, ...(Number.isFinite(at) ? { at } : {}) });
    }
    for (const slice of out.slices) if (ledger.get(slice.label)?.state === 'working' &&
      !this.worktrees.some((tree) => basename(tree.path) === slice.label)) slice.drift = 'no worktree';
    for (const tree of this.worktrees) {
      const id = basename(tree.path), job = byTree.get(canonical(tree.path)), entry = ledger.get(id);
      let slice = out.slices.find((r) => r.label === id);
      if (!slice) {
        slice = { label: id, value: entry?.text ?? '', path: statePath,
          drift: entry ? 'ledger' : 'not in ledger', ledgerState: entry?.state };
        out.slices.push(slice);
      }
      if (job) Object.assign(slice, job, { path: job.path ?? statePath });
    }
    for (const path of this.cache.keys()) if (!this.seen.has(path)) this.cache.delete(path);
    return out;
  }
}
