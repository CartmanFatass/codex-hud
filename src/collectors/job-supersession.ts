/** Read-only evidence that another attempt owns a failed job's target. Never infer identity from free prose. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { parseLedger, statePaths } from './state-ledger.js';
import { targetKey, ticketFileEvidence } from './ticket-evidence.js';
import { TryLog } from './try-records.js';
import { sharedRoot } from '../roles/projects.js';

export interface Receipt {
  job?: unknown; role?: unknown; created_at?: unknown; herdr_pane?: unknown; project_root?: unknown; cwd?: unknown;
  package?: unknown; ticket?: unknown; slice?: unknown; target_hint?: unknown; title?: unknown; task_length?: unknown;
  retry_of?: unknown; repair_of?: unknown; from_jobs?: unknown; worktree?: unknown;
}
const text = (s: unknown) => typeof s === 'string' ? s.trim() : '';
// A ticket and its slice are two spellings of the same target. Keep the number, not just the feature lane.
function identifier(s: string): string {
  const token = s.replace(/^(?:slice|ticket|task|package)\s+/i, '').split(/[\s:(]/, 1)[0];
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*[/#-]\d+$/i.test(token)) return targetKey(token);
  return /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/.test(token) ? token.toLowerCase() : '';
}
export function taskTarget(brief: string): string {
  const lines = brief.split(/\r?\n/);
  return identifier((lines.find((line) => /^#{1,6}\s/.test(line)) ?? lines.find((line) => line.trim()) ?? '').replace(/^#{1,6}\s+/, '').trim());
}
function target(j: Receipt, title: () => string): string {
  const pkg = text(j.package), ticket = String(j.ticket ?? '');
  if (pkg && /^\d+$/.test(ticket)) return `${pkg.toLowerCase()}/${Number(ticket)}`;
  const slice = text(j.slice), pkgId = identifier(pkg);
  return identifier(ticket) || identifier(slice) || slice.toLowerCase() || (pkgId.includes('/') ? pkgId : '') ||
    text(j.target_hint) || identifier(text(j.title)) || (j.target_hint === undefined ? title() : '') || pkg.toLowerCase();
}

let log: TryLog | undefined, logHome: string;
/** Build the per-project indexes lazily: an ordinary scan with no failures never opens project or legacy brief files. */
export function supersession(home: string, jobs: Receipt[], read: (path: string) => string | undefined,
  fallbackRoot: string | null, title: (job: Receipt) => string = (j) => {
    if (!/^j[0-9a-f]{16}$/.test(text(j.job))) return '';
    const brief = read(join(home, 'jobs', text(j.job), 'brief.md'));
    return brief ? taskTarget(typeof j.task_length === 'number' ? brief.slice(0, j.task_length) : brief) : '';
  }) {
  const legacyRoots = new Map<string, string>();
  const rootOf = (j: Receipt) => {
    const root = text(j.project_root) || text((j.worktree as { main_root?: unknown } | null)?.main_root);
    const cwd = text(j.cwd);
    if (root || !cwd) return root;
    if (!legacyRoots.has(cwd)) legacyRoots.set(cwd, sharedRoot(cwd));
    return legacyRoots.get(cwd)!;
  };
  const scope = (j: Receipt) => rootOf(j) || `pane:${text(j.herdr_pane)}`;
  const byTarget = new Map<string, number>();
  let replaced: Map<string, number> | undefined;
  const targets = new Map<Receipt, string>(), indexed = new Set<string>(), landed = new Map<string, Set<string>>();
  function landedIds(root: string) {
    if (!landed.has(root)) {
      if (!log || logHome !== home) { log = new TryLog(home); logHome = home; }
      let rows: ReturnType<typeof parseLedger> = [];
      for (const path of statePaths(root)) {
        const body = read(path);
        if (body === undefined) continue;
        rows = parseLedger(body);
        break;
      }
      const ids = new Set(log.accepted(root, rows).map(targetKey));
      for (const row of rows) if (['try', 'accepted', 'done', 'dropped'].includes(row.state)) ids.add(targetKey(row.id));
      landed.set(root, ids);
    }
    return landed.get(root)!;
  }
  return (j: Receipt): boolean => {
    const created = Date.parse(text(j.created_at));
    // Explicit links are job IDs, not lane labels: a retry can override cwd, package or role.
    if (!replaced) {
      replaced = new Map();
      for (const other of jobs) {
        const at = Date.parse(text(other.created_at));
        if (!Number.isFinite(at)) continue;
        for (const ref of [other.retry_of, other.repair_of, ...(Array.isArray(other.from_jobs) ? other.from_jobs : [])]) {
          if (typeof ref === 'string' && ref !== other.job) replaced.set(ref, Math.max(at, replaced.get(ref) ?? -Infinity));
        }
      }
    }
    if ((replaced.get(text(j.job)) ?? -Infinity) >= created) return true;
    const group = scope(j);
    const key = (role: unknown, id: string) => JSON.stringify([group, role, id]);
    if (!indexed.has(group)) {
      indexed.add(group);
      for (const other of jobs) if (scope(other) === group) {
        const at = Date.parse(text(other.created_at)), id = target(other, () => title(other));
        targets.set(other, id);
        if (!Number.isFinite(at)) continue;
        const k = key(other.role, id);
        if (id) byTarget.set(k, Math.max(at, byTarget.get(k) ?? -Infinity));
      }
    }
    const id = targets.get(j) ?? target(j, () => title(j));
    if ((byTarget.get(key(j.role, id)) ?? -Infinity) > created) return true;
    const root = rootOf(j) || fallbackRoot;
    if (!root || !id) return false;
    const ids = landedIds(root);
    if (ids.has(id) || (text(j.slice) && ids.has(targetKey(text(j.slice))))) return true;
    const ticket = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/(\d+)$/.exec(id);
    if (!ticket) return false;
    // Look at just this ticket, even in a finished feature outside Project's visible window.
    const dir = join(root, '.scratch', ticket[1], 'issues');
    try {
      if (fs.realpathSync(dir) !== dir) return false;
      const files = fs.readdirSync(dir).filter((name) => /^\d+-.+\.md$/.test(name) && Number(name.split('-')[0]) === Number(ticket[2]));
      const body = files.length === 1 && read(join(dir, files[0]));
      return !!body && !!ticketFileEvidence(body).landed;
    } catch { return false; }
  };
}
