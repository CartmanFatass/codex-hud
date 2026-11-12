/** On-demand, read-only Project facts. No MCP startup, models, browser IPC or writes. */
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { roleRegistry } from '../roles/roster.js';
import { neutralizeFilters, parseWorktreeStatus, worktreeGit, type WorktreeStatus } from './worktrees.js';
import type { WorkboardSnapshot } from './workboard-types.js';
export interface ProjectItem {
  label: string;
  value: string;
  path?: string;
  at?: number;
}
export interface ProjectSnapshot {
  waiting: ProjectItem[];
  docs: ProjectItem[];
  control: ProjectItem[];
  agents: ProjectItem[];
  keys: [string, boolean][];
  browser: boolean;
  roleCount: number;
  git?: WorktreeStatus;
  last?: { text: string; at: number };
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
  private names = (path: string): string[] => this.cached(path, (st) => {
    if (!st.isDirectory()) return [];
    const dir = fs.opendirSync(path), names: string[] = [];
    try {
      for (let entry; names.length < 128 && (entry = dir.readSync());) names.push(entry.name);
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
  async collect(shown: boolean, board: WorkboardSnapshot, now: number): Promise<ProjectSnapshot | undefined> {
    if (!shown) return;
    this.seen.clear();
    const out: ProjectSnapshot = {
      waiting: [], docs: [], control: [], agents: [], keys: [], browser: false, roleCount: 0, editing: [],
    };
    const statePath = [join(this.cwd, 'docs/handoff/STATE.md'), join(this.cwd, 'STATE.md')].find((p) => this.read(p));
    const state = statePath ? this.read(statePath)!.text : '';
    const waiting = state.split(/^## Waiting for the owner[ \t]*\r?$/m)[1]?.split(/^## /m)[0] ?? '';
    out.waiting = [...waiting.matchAll(/^[-*] (.+(?:\r?\n[ \t]+.+)*)/gm)].map((m) => ({
      label: '', value: m[1].replace(/\s+/g, ' ').trim(), path: statePath,
    }));
    const milestone = state.match(/^Milestone:[ \t]*([^\r\n]+)$/m)?.[1]?.trim();
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
    out.keys = [...new Set(['MISTRAL_API_KEY', 'OPENAI_API_KEY', 'TYPESAFE_API_KEY', ...keys.keys()])]
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
      try {
        const filters = await neutralizeFilters(worktreeGit, this.cwd);
        this.git = parseWorktreeStatus(await worktreeGit(this.cwd, [
          ...filters, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal',
        ]));
        const [hash, at, subject] = (await worktreeGit(this.cwd, [
          'log', '-1', '--no-show-signature', '--format=%h%x00%ct%x00%s',
        ])).trim().split('\0');
        if (hash && Number.isFinite(Number(at))) this.last = { text: `${hash} ${subject}`, at: Number(at) * 1000 };
      } catch { /* No repo, unborn HEAD or failed probe: unknown, not zero. */ }
    }
    out.git = this.git;
    out.last = this.last;
    for (const path of this.cache.keys()) if (!this.seen.has(path)) this.cache.delete(path);
    return out;
  }
}
