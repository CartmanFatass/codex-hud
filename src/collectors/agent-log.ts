/**
 * A log per subagent: what was observed about it and what the model wrote
 * about it, newest last, kept for the whole session.
 *
 * The brief used to be one picture of every agent, replaced whole each time:
 * a note read five minutes ago was gone, and the picture lagged the tree. The
 * log only grows. Observed entries are written on the same collection that
 * rebuilds the tree, so the log never lags it:
 *
 * - `started`, `finished`, `failed`: a status change, at the time the rollout
 *   gives for it (no time, no entry: nothing is guessed);
 * - `report`: a new public update from the agent, its excerpt.
 *
 * Model-written entries are marked as such where they are shown: `note` (the
 * brief's line for the agent), `digest` (its final answer in three lines) and
 * `cause` (why it failed, in one line).
 *
 * An entry is kept once: the same kind, time and text again is the same
 * entry, so a panel that rebuilds the log from a re-read rollout adds nothing.
 * Bounded per agent and per session, reset with the session, and saved per
 * session id so a panel opened again (a new process each time) has it all.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SubagentTree, SubagentTreeNode } from '../types.js';
import { writePrivateFile } from './small-model.js';

export type AgentLogKind = 'started' | 'finished' | 'failed' | 'report' | 'note' | 'digest' | 'cause';

export interface AgentLogEntry {
  /** When it happened, or when the model wrote it, in ms. */
  at: number;
  kind: AgentLogKind;
  text: string;
  /** A note that says the agent needs a look. */
  attention?: boolean;
}

/** Entries written by a model rather than observed. */
export const MODEL_KINDS: ReadonlySet<AgentLogKind> = new Set(['note', 'digest', 'cause']);
const KINDS: ReadonlySet<string> = new Set(['started', 'finished', 'failed', 'report', 'note', 'digest', 'cause']);

export const ENTRIES_PER_AGENT = 30;
export const AGENTS_PER_SESSION = 200;
const MAX_TEXT_CHARS = 600;
/** Logs not written for this long are removed when another is written. */
export const AGENT_LOG_KEEP_MS = 30 * 86_400_000;

function walk(nodes: SubagentTreeNode[], visit: (node: SubagentTreeNode) => void): void {
  for (const node of nodes) { visit(node); walk(node.children, visit); }
}

function time(at: Date | undefined): number | undefined {
  const ms = at?.getTime();
  return ms !== undefined && Number.isFinite(ms) ? ms : undefined;
}

/**
 * The observed entries one node's current state implies. Each is keyed by
 * its own time, so seeing the same state again yields the same entries.
 */
export function observedEntries(node: SubagentTreeNode): AgentLogEntry[] {
  const entries: AgentLogEntry[] = [];
  const started = time(node.turnStartedAt ?? node.startedAt);
  if (started !== undefined) entries.push({ at: started, kind: 'started', text: '' });
  const ended = time(node.statusAt ?? node.lastEventAt);
  if (node.status === 'completed' && ended !== undefined) entries.push({ at: ended, kind: 'finished', text: '' });
  if (node.status === 'error' && ended !== undefined) entries.push({ at: ended, kind: 'failed', text: '' });
  const report = node.lastReport;
  const reportAt = time(report?.at);
  if (report && reportAt !== undefined && report.text.trim()) entries.push({ at: reportAt, kind: 'report', text: report.text });
  return entries;
}

function key(entry: AgentLogEntry): string {
  return `${entry.kind}\u0000${entry.at}\u0000${entry.text}`;
}

function clean(entry: AgentLogEntry): AgentLogEntry {
  const text = entry.text.replace(/\s+/g, ' ').trim();
  return { at: entry.at, kind: entry.kind, text: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text,
    ...(entry.attention ? { attention: true } : {}) };
}

/** Add entries to one agent's list, oldest first, without repeats, bounded. True when anything was added. */
export function appendEntries(list: AgentLogEntry[], added: readonly AgentLogEntry[]): boolean {
  const seen = new Set(list.map(key));
  let changed = false;
  for (const raw of added) {
    const entry = clean(raw);
    if (!Number.isFinite(entry.at) || seen.has(key(entry))) continue;
    seen.add(key(entry));
    list.push(entry);
    changed = true;
  }
  if (!changed) return false;
  list.sort((a, b) => a.at - b.at);
  if (list.length > ENTRIES_PER_AGENT) list.splice(0, list.length - ENTRIES_PER_AGENT);
  return true;
}

function parseLog(raw: unknown, rootId: string): Map<string, AgentLogEntry[]> {
  const logs = new Map<string, AgentLogEntry[]>();
  const value = raw as { rootId?: unknown; agents?: unknown } | null;
  if (!value || value.rootId !== rootId || !value.agents || typeof value.agents !== 'object') return logs;
  for (const [id, list] of Object.entries(value.agents as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const entries: AgentLogEntry[] = [];
    appendEntries(entries, list.filter((entry): entry is AgentLogEntry => Boolean(entry) && typeof entry.at === 'number'
      && typeof entry.kind === 'string' && KINDS.has(entry.kind) && typeof entry.text === 'string'));
    if (entries.length) logs.set(id, entries);
  }
  return logs;
}

export class AgentLog {
  private rootId = '';
  private logs = new Map<string, AgentLogEntry[]>();
  private dirty = false;

  /** `dir` null keeps the log in memory only. */
  constructor(private readonly dir: string | null = null, private readonly clock: () => number = Date.now) {}

  private file(rootId: string): string | null {
    return this.dir && /^[A-Za-z0-9-]{1,128}$/.test(rootId) ? path.join(this.dir, `${rootId}.json`) : null;
  }

  /** Follow the session: another root starts from its own saved log, or an empty one. */
  attach(rootId: string): void {
    if (rootId === this.rootId) return;
    this.flush();
    this.rootId = rootId;
    this.logs = new Map();
    const file = this.file(rootId);
    if (!file) return;
    try { this.logs = parseLog(JSON.parse(fs.readFileSync(file, 'utf8')), rootId); } catch { /* none yet */ }
  }

  /** Record what the tree shows. True when an entry was added. */
  observe(tree: SubagentTree): boolean {
    this.attach(tree.rootId);
    let changed = false;
    walk(tree.nodes, node => { if (this.add(node.id, observedEntries(node))) changed = true; });
    return changed;
  }

  /** Add entries to one agent's log. True when anything was new. */
  add(id: string, entries: readonly AgentLogEntry[]): boolean {
    if (!entries.length) return false;
    const list = this.logs.get(id) ?? [];
    if (!appendEntries(list, entries)) return false;
    this.logs.set(id, list);
    if (this.logs.size > AGENTS_PER_SESSION) {
      // The agents heard from least recently go first.
      const order = [...this.logs.entries()].sort((a, b) => (a[1].at(-1)?.at ?? 0) - (b[1].at(-1)?.at ?? 0));
      for (const [drop] of order.slice(0, this.logs.size - AGENTS_PER_SESSION)) this.logs.delete(drop);
    }
    this.dirty = true;
    return true;
  }

  /** One agent's entries, oldest first. */
  entries(id: string): readonly AgentLogEntry[] {
    return this.logs.get(id) ?? [];
  }

  /** Every agent's entries, for the renderer. */
  snapshot(): ReadonlyMap<string, readonly AgentLogEntry[]> {
    return this.logs;
  }

  /** The newest entry of a kind, for "is there news since the last note". */
  latest(id: string, kinds: ReadonlySet<AgentLogKind>): AgentLogEntry | undefined {
    const list = this.logs.get(id) ?? [];
    for (let i = list.length - 1; i >= 0; i--) if (kinds.has(list[i].kind)) return list[i];
    return undefined;
  }

  /** Write the log if anything was added since the last write. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const file = this.file(this.rootId);
    if (!file || !this.logs.size) return;
    try {
      writePrivateFile(file, `${JSON.stringify({ rootId: this.rootId, agents: Object.fromEntries(this.logs) })}\n`);
      this.prune();
    } catch { /* kept in memory; written next time */ }
  }

  private prune(): void {
    if (!this.dir) return;
    const cutoff = this.clock() - AGENT_LOG_KEEP_MS;
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.dir, name);
      try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch { /* gone already */ }
    }
  }
}
