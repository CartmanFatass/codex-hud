/** Read-only worktree monitoring. Never attribute workspace files to agents. */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

export interface WorktreeStatus {
  changed: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
  ahead: number | null;
  behind: number | null;
  branch: string | null;
}
export interface WorktreeInfo {
  path: string;
  head?: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked?: string;
  prunable?: string;
  status?: WorktreeStatus;
  observedAt?: number;
  error?: string;
}
export interface WorktreesSnapshot {
  sourcePath: string | null;
  entries: WorktreeInfo[];
  updatedAt: number;
  error?: string;
  truncated?: boolean;
}
export type WorktreeGit = (cwd: string, args: string[]) => Promise<string>;
export const WORKTREE_LIMIT = 128;
export const PROBES_PER_REFRESH = 4;
export const WORKTREE_STALE_MS = 30_000;

/** All invocations have bounded output/time, no shell, no lazy object fetch. */
export const worktreeGit: WorktreeGit = (cwd, args) => new Promise((yes, no) => {
  const env = {...process.env};
  // A process launched from another Git operation must not redirect these reads.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_EXTERNAL_DIFF']) delete env[key];
  execFile('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'color.ui=false',
    '-c', 'core.quotePath=true', ...args], {
    cwd, encoding: 'utf8', shell: false, timeout: 5000, maxBuffer: 1024 * 1024,
    windowsHide: true,
    env: {...env, LC_ALL:'C', GIT_OPTIONAL_LOCKS:'0', GIT_NO_LAZY_FETCH:'1', GIT_LITERAL_PATHSPECS:'1', GIT_TERMINAL_PROMPT:'0'},
  }, (error, stdout) => error ? no(error) : yes(stdout));
});

function failure(error: unknown): string {
  const err = error as {code?: string | number; killed?: boolean; message?: string; stderr?: string};
  if (err?.code === 'ENOENT') return 'Git or worktree path unavailable';
  if (err?.killed || err?.code === 'ETIMEDOUT') return 'Git timed out';
  if (err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'Git output limit reached';
  const text = `${err?.message ?? ''}\n${err?.stderr ?? ''}`;
  if (/not a git repository/i.test(text)) return 'No Git repository at this path';
  if (/permission|dubious ownership/i.test(text)) return 'Repository access denied';
  if (/filter/i.test(text)) return 'Could not disable Git filters';
  return 'Worktree read failed';
}

/** NUL is the ONLY record delimiter. Paths and lock reasons may contain newlines. */
export function parseWorktreeList(text: string): WorktreeInfo[] {
  if (text && !text.endsWith('\0\0')) throw new Error('Incomplete worktree list');
  const result: WorktreeInfo[] = [];
  let entry: WorktreeInfo | undefined;
  for (const field of text.split('\0')) {
    if (!field) { if (entry) result.push(entry); entry = undefined; continue; }
    const space = field.indexOf(' ');
    const key = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? '' : field.slice(space + 1);
    if (key === 'worktree') {
      if (entry || !value) throw new Error('Invalid worktree list');
      entry = {path:value, branch:null, bare:false, detached:false};
    } else if (entry) {
      if (key === 'HEAD') entry.head = value;
      else if (key === 'branch') entry.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'bare') entry.bare = true;
      else if (key === 'detached') entry.detached = true;
      else if (key === 'locked') entry.locked = value;
      else if (key === 'prunable') entry.prunable = value;
    } else throw new Error('Worktree record missing path');
  }
  return result;
}

/** Porcelain v2 -z; a rename's extra source record must not be counted as a file. */
export function parseWorktreeStatus(text: string): WorktreeStatus {
  if (text && !text.endsWith('\0')) throw new Error('Incomplete worktree status');
  const out: WorktreeStatus = {changed:0, staged:0, unstaged:0, untracked:0, conflicts:0, ahead:null, behind:null, branch:null};
  const records = text.split('\0');
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row || row.startsWith('! ')) continue;
    if (row.startsWith('# branch.head ')) {
      const branch = row.slice(14);
      out.branch = branch === '(detached)' ? null : branch;
      continue;
    }
    if (row.startsWith('# branch.ab ')) {
      const pair = /^# branch.ab \+(\d+) -(\d+)$/.exec(row);
      if (!pair) throw new Error('Invalid branch status');
      out.ahead = Number(pair[1]); out.behind = Number(pair[2]); continue;
    }
    if (row.startsWith('# ')) continue;
    if (row.startsWith('? ')) { out.changed++; out.untracked++; continue; }
    if (!/^[12u] [A-Z.]{2} /.test(row)) throw new Error('Unknown status record');
    out.changed++;
    if (row[0] === 'u') out.conflicts++;
    else {
      if (row[2] !== '.') out.staged++;
      if (row[3] !== '.') out.unstaged++;
    }
    if (row[0] === '2' && !records[++i]) throw new Error('Missing rename source');
  }
  return out;
}

async function neutralizeFilters(run: WorktreeGit, cwd: string): Promise<string[]> {
  let text: string;
  try { text = await run(cwd, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|required)$']); }
  catch (error) { if ((error as {code?: number}).code === 1) return []; throw error; }
  const names = new Set<string>();
  for (const key of text.split('\0').filter(Boolean)) {
    const match = /^filter\.([\s\S]+)\.(?:clean|process|required)$/.exec(key);
    if (!match || match[1].includes('=')) throw new Error('Unsafe filter configuration');
    names.add(match[1]);
  }
  return [...names].flatMap(name => ['-c', `filter.${name}.clean=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`]);
}

/** Only explicit settings/env or verified session/launch cwd are candidates. No log scraping. */
export function worktreeSources(launchCwd: string, sessionCwd?: string, configuredRoot = '', envRoot = ''): string[] {
  const explicit = envRoot || configuredRoot;
  if (explicit) return [resolve(launchCwd, explicit)]; // Invalid explicit roots never silently fall back.
  return [...new Set([sessionCwd, launchCwd].filter((x): x is string => Boolean(x)).map(x => resolve(launchCwd, x)))];
}

/** A bounded round-robin probe keeps big repositories from blocking the renderer. */
export class WorktreeCollector {
  private cache = new Map<string, WorktreeInfo>();
  private source: string | null = null;
  private cursor = 0;
  private inFlight?: Promise<WorktreesSnapshot>;
  constructor(private readonly run: WorktreeGit = worktreeGit, private readonly now: () => number = Date.now) {}

  refresh(candidates: string[]): Promise<WorktreesSnapshot> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.collect(candidates).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private async collect(candidates: string[]): Promise<WorktreesSnapshot> {
    let source: string | null = null;
    let entries: WorktreeInfo[] = [];
    let error = 'No repository configured';
    for (const candidate of [...new Set(candidates)].slice(0, 2)) {
      try {
        entries = parseWorktreeList(await this.run(candidate, ['worktree', 'list', '--porcelain', '-z']));
        if (!entries.length) throw new Error('Empty worktree list');
        source = candidate; break;
      } catch (err) { error = failure(err); }
    }
    if (!source) {
      this.cache.clear(); this.source = null; this.cursor = 0;
      return {sourcePath:null, entries:[], error, updatedAt:this.now()};
    }
    if (source !== this.source) { this.cache.clear(); this.cursor = 0; this.source = source; }
    const truncated = entries.length > WORKTREE_LIMIT;
    entries = entries.slice(0, WORKTREE_LIMIT).map(entry => {
      const old = this.cache.get(entry.path);
      // A metadata change invalidates old branch/clean status immediately.
      return old && old.head === entry.head && old.branch === entry.branch && old.bare === entry.bare &&
        old.locked === entry.locked && old.prunable === entry.prunable
        ? {...entry, status:old.status, observedAt:old.observedAt, error:old.error} : entry;
    });
    const readable = entries.filter(entry => !entry.bare && entry.prunable === undefined);
    const count = Math.min(PROBES_PER_REFRESH, readable.length);
    const selected = Array.from({length:count}, (_, i) => readable[(this.cursor+i) % readable.length]);
    this.cursor = readable.length ? (this.cursor+count) % readable.length : 0;
    const probe = async (entry: WorktreeInfo) => {
      try {
        const overrides = await neutralizeFilters(this.run, entry.path);
        const text = await this.run(entry.path, [...overrides, '-c', 'status.renames=true', 'status',
          '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignore-submodules=all']);
        entry.status = parseWorktreeStatus(text);
        // Prefer the branch reported by this status read, not an earlier list snapshot.
        entry.branch = entry.status.branch;
        entry.observedAt = this.now(); entry.error = undefined;
      } catch (err) { entry.status = undefined; entry.observedAt = undefined; entry.error = failure(err); }
    };
    // Never more than two simultaneous Git processes; no unbounded fan-out.
    for (let i = 0; i < selected.length; i += 2) await Promise.all(selected.slice(i,i+2).map(probe));
    this.cache = new Map(entries.map(entry => [entry.path, {...entry}]));
    return {sourcePath:source, entries, updatedAt:this.now(), truncated};
  }
}
