/**
 * A rolling recap of the main session, written by the small model: what the
 * session set out to do, what has been done, where it stands, and what it
 * needs from the person.
 *
 * Retrospective, not a live status line. Each run is given the previous
 * recap and only the conversation since it, so a run costs the same on the
 * hundredth turn as on the first, and the recap outlives Codex compacting the
 * conversation away. It is sent only when the person chose a brief scope
 * that includes the main session: it carries their prompts and the
 * assistant's public replies to the brief backend.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RolloutParseResult, TranscriptEntry } from './rollout.js';
import type { SubagentTree, SubagentTreeNode } from '../types.js';
import type { Language } from '../render/i18n.js';
import { writePrivateFile } from './small-model.js';

export type BriefingScope = 'agents' | 'main' | 'both';

/** The model-written part of a recap. */
export interface RecapPart {
  goal: string;
  /** Cumulative, merged and compressed: at most `MAX_DONE` items. */
  done: string[];
  now: string;
  /** Present only when the session waits on the person. */
  needs?: string;
}

export interface Recap extends RecapPart {
  /** When it was written, in ms. */
  at: number;
  /** The newest transcript entry folded in, in ms; 0 when none was. */
  coveredUntil: number;
  sessionId: string;
  language: Language;
  /** What the material looked like when it was written, so a new panel knows what is news. */
  fingerprint?: string;
  floorFingerprint?: string;
  /** The brief's line on the subagents from the same run, so a new panel has it without asking again. */
  overall?: string;
}

const MAX_DONE = 4;
const MAX_LINE_CHARS = 120;
/** The `<main>` section's budget: facts first, then the newest entries that fit. */
export const MAIN_MATERIAL_CHARS = 4000;
const MAX_PLAN_STEPS = 8;
const MAX_DELEGATED = 24;
/** Finished agents stay in the digest this long, like the brief's. */
const RECENT_FINISH_MS = 30 * 60_000;
/** Recap files older than this are removed when another is written. */
export const RECAP_KEEP_MS = 30 * 86_400_000;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function ago(at: Date | number | undefined, now: number): string {
  const ms = typeof at === 'number' ? at : at?.getTime();
  if (ms === undefined || !Number.isFinite(ms)) return 'unknown';
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${(seconds / 3600).toFixed(1)}h`;
}

function walk(nodes: SubagentTreeNode[], visit: (node: SubagentTreeNode) => void): void {
  for (const node of nodes) { visit(node); walk(node.children, visit); }
}

function isLive(node: SubagentTreeNode): boolean {
  return node.status === 'running' || node.status === 'starting';
}

/**
 * What the main session has delegated, as facts: per subagent its name,
 * status and how long its turn has run or when it finished. No task text and
 * no report text: those go only where the scope includes agents.
 */
export function delegationDigest(tree: SubagentTree, now: number): string[] {
  const picked: SubagentTreeNode[] = [];
  walk(tree.nodes, node => {
    const finished = node.status === 'completed' ? now - ((node.statusAt ?? node.lastEventAt)?.getTime() ?? 0) : Infinity;
    if (isLive(node) || node.status === 'error' || node.status === 'unknown' || finished < RECENT_FINISH_MS) picked.push(node);
  });
  const lines = picked.slice(0, MAX_DELEGATED).map(node => {
    const when = isLive(node) ? `turn running ${ago(node.turnStartedAt ?? node.startedAt, now)}`
      : node.status === 'completed' ? `finished ${ago(node.statusAt ?? node.lastEventAt, now)} ago`
        : node.status === 'error' ? `failed ${ago(node.statusAt ?? node.lastEventAt, now)} ago` : 'no status evidence';
    return `${node.name}: ${node.status}, ${when}`;
  });
  if (picked.length > lines.length) lines.push(`(${picked.length - lines.length} more not listed)`);
  return lines;
}

/** Facts about the main session that are not in its conversation. */
function mainFacts(main: RolloutParseResult, now: number): string[] {
  const facts: string[] = [];
  const activity = main.activity;
  if (activity?.state === 'working') facts.push(`turn running ${ago(activity.turnStartedAt ?? activity.updatedAt, now)}`);
  else if (activity) facts.push(`turn ${activity.state === 'idle' ? 'finished' : activity.state} ${ago(activity.updatedAt, now)} ago`);
  const plan = main.planProgress;
  if (plan?.steps.length) {
    facts.push(`plan ${plan.completedSteps}/${plan.totalSteps} steps done:`);
    for (const step of plan.steps.slice(0, MAX_PLAN_STEPS)) facts.push(`  [${step.status}] ${clip(step.step, 100)}`);
    if (plan.steps.length > MAX_PLAN_STEPS) facts.push(`  (${plan.steps.length - MAX_PLAN_STEPS} more steps)`);
  }
  if (main.compactCount) facts.push(`conversation compacted ${main.compactCount} time${main.compactCount === 1 ? '' : 's'}`);
  const approval = main.pendingApproval;
  if (approval) {
    const what = approval.kind === 'patch' ? 'patch approval' : approval.kind === 'input' ? 'an answer to a question' : 'command approval';
    facts.push(`waiting on the person for ${what}${approval.summary ? `: ${approval.summary}` : ''} (${ago(approval.since, now)})`);
  }
  return facts;
}

function entryLine(entry: TranscriptEntry, now: number): string {
  const who = entry.role === 'user' ? 'user' : entry.kind === 'reply' ? 'assistant final reply'
    : entry.kind === 'update' ? 'assistant commentary' : 'assistant';
  return `[${ago(entry.at, now)} ago, ${who}] ${entry.text}`;
}

export interface RecapInput {
  /** The `<main>` section. */
  section: string;
  /**
   * What makes a recap due at once: a new request from the person, a final
   * reply or a turn ending, a plan step completed, an approval asked for.
   * Commentary alone does not.
   */
  fingerprint: string;
  /**
   * What makes a recap due at the floor period: everything above, plus new
   * commentary and any change in what is delegated.
   */
  floorFingerprint: string;
  /** The newest entry this material covers, in ms; what `coveredUntil` becomes on success. */
  newestAt: number;
}

/**
 * The main-session material for one run, from the parse result, the tree and
 * the previous recap. Null when the session has said nothing yet.
 */
export function recapInput(main: RolloutParseResult, tree: SubagentTree, previous: RecapPart & { coveredUntil: number } | null,
  now: number): RecapInput | null {
  const transcript = main.transcript ?? [];
  if (!transcript.length && !main.firstUserMessage) return null;
  const covered = previous?.coveredUntil ?? 0;
  const fresh = transcript.filter(entry => entry.at.getTime() > covered);
  const newestAt = Math.max(covered, ...transcript.map(entry => entry.at.getTime()));

  const lines: string[] = ['<main>', ...mainFacts(main, now)];
  const digest = delegationDigest(tree, now);
  if (digest.length) lines.push('delegated to subagents:', ...digest.map(line => `  ${line}`));
  // With no recap to build on, the session's first request says what it set
  // out to do, even when it has long left the buffer.
  const first = main.firstUserMessage;
  if (!previous && first && !fresh.includes(first) && !fresh.some(entry => entry.at.getTime() === first.at.getTime())) {
    lines.push(`first request of the session (${ago(first.at, now)} ago): ${first.text}`);
  }
  // Entries the buffer let go of may never have been folded in.
  let omitted = main.transcriptDroppedAt !== undefined && main.transcriptDroppedAt.getTime() > covered;
  const budget = MAIN_MATERIAL_CHARS - lines.join('\n').length - 64;
  const kept: string[] = [];
  let used = 0;
  for (let i = fresh.length - 1; i >= 0; i--) {
    const line = entryLine(fresh[i], now);
    if (used + line.length + 1 > budget) { omitted = true; break; }
    kept.unshift(line);
    used += line.length + 1;
  }
  lines.push(fresh.length ? 'conversation since the previous recap:' : 'no new conversation since the previous recap');
  if (omitted) lines.push('(earlier entries omitted)');
  lines.push(...kept, '</main>');

  const approval = main.pendingApproval ? main.pendingApproval.callId ?? main.pendingApproval.since.getTime() : null;
  const turnEnded = main.activity && main.activity.state !== 'working' ? main.activity.updatedAt.getTime() : null;
  const fingerprint = JSON.stringify([main.lastUserMessageAt?.getTime() ?? 0, main.lastReplyAt?.getTime() ?? 0, turnEnded,
    main.planProgress?.completedSteps ?? 0, approval]);
  const delegated: unknown[] = [];
  walk(tree.nodes, node => delegated.push([node.id, node.status, node.statusAt?.getTime() ?? 0, node.lastReport?.at.getTime() ?? 0]));
  const floorFingerprint = JSON.stringify([fingerprint, transcript.at(-1)?.at.getTime() ?? 0, delegated]);
  return { section: lines.join('\n'), fingerprint, floorFingerprint, newestAt };
}

/** The previous recap as the model is shown it, or "none". */
export function previousRecapSection(previous: RecapPart | null): string {
  const body = previous ? JSON.stringify({ goal: previous.goal, done: previous.done, now: previous.now, needs: previous.needs ?? '' }) : 'none';
  return `<previous_recap>\n${body}\n</previous_recap>`;
}

/**
 * Read a reply's `main` object. Anything short of a goal and a state is not
 * a recap: the caller keeps the previous one.
 */
export function parseRecapPart(value: unknown): RecapPart | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { goal, done, now, needs } = value as Record<string, unknown>;
  if (typeof goal !== 'string' || !goal.trim() || typeof now !== 'string' || !now.trim()) return null;
  const items = Array.isArray(done) ? done.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
  return {
    goal: clip(goal, MAX_LINE_CHARS),
    done: items.slice(0, MAX_DONE).map(item => clip(item, MAX_LINE_CHARS)),
    now: clip(now, MAX_LINE_CHARS),
    ...(typeof needs === 'string' && needs.trim() ? { needs: clip(needs, MAX_LINE_CHARS) } : {}),
  };
}

/** A stored recap, if the file holds one; anything else reads as none. */
export function parseStoredRecap(raw: unknown): Recap | null {
  const part = parseRecapPart(raw);
  if (!part) return null;
  const { at, coveredUntil, sessionId, language, fingerprint, floorFingerprint, overall } = raw as Record<string, unknown>;
  if (typeof at !== 'number' || !Number.isFinite(at) || typeof coveredUntil !== 'number' || !Number.isFinite(coveredUntil)
    || typeof sessionId !== 'string' || (language !== 'en' && language !== 'zh')) return null;
  return { ...part, at, coveredUntil, sessionId, language,
    ...(typeof fingerprint === 'string' ? { fingerprint } : {}), ...(typeof floorFingerprint === 'string' ? { floorFingerprint } : {}),
    ...(typeof overall === 'string' && overall ? { overall } : {}) };
}

/**
 * Recaps on disk, one file per session id, so a panel opened again (it is a
 * new process each time) or a `codex resume` shows the last recap at once.
 */
/** The session's title, kept beside its recap for the bar to read. */
export interface SessionTitle {
  sessionId: string;
  title: string;
  /** Taken from the recap's goal, or written from the first prompt. */
  source: 'recap' | 'prompt';
  at: number;
}

export function parseStoredTitle(value: unknown): SessionTitle | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.sessionId !== 'string' || typeof raw.title !== 'string' || !raw.title.trim() || typeof raw.at !== 'number') return null;
  if (raw.source !== 'recap' && raw.source !== 'prompt') return null;
  return { sessionId: raw.sessionId, title: raw.title.replace(/\s+/g, ' ').trim().slice(0, 80), source: raw.source, at: raw.at };
}

function sessionFile(dir: string, sessionId: string, suffix: string): string | null {
  // Session ids are UUIDs; anything else is not a file name we write.
  return /^[A-Za-z0-9-]{1,128}$/.test(sessionId) ? path.join(dir, `${sessionId}${suffix}`) : null;
}

/** The stored title of a session, or null: what the bar reads. */
export function readSessionTitle(dir: string, sessionId: string): SessionTitle | null {
  const file = sessionFile(dir, sessionId, '.title.json');
  if (!file) return null;
  try {
    const title = parseStoredTitle(JSON.parse(fs.readFileSync(file, 'utf8')));
    return title?.sessionId === sessionId ? title : null;
  } catch { return null; }
}

export class RecapStore {
  constructor(private readonly dir: string, private readonly clock: () => number = Date.now) {}

  loadTitle(sessionId: string): SessionTitle | null {
    return readSessionTitle(this.dir, sessionId);
  }

  saveTitle(title: SessionTitle): void {
    const file = sessionFile(this.dir, title.sessionId, '.title.json');
    if (file) writePrivateFile(file, `${JSON.stringify(title)}\n`);
  }

  private file(sessionId: string): string | null {
    return sessionFile(this.dir, sessionId, '.json');
  }

  load(sessionId: string): Recap | null {
    const file = this.file(sessionId);
    if (!file) return null;
    try {
      const recap = parseStoredRecap(JSON.parse(fs.readFileSync(file, 'utf8')));
      return recap?.sessionId === sessionId ? recap : null;
    } catch { return null; }
  }

  save(recap: Recap): void {
    const file = this.file(recap.sessionId);
    if (!file) return;
    writePrivateFile(file, `${JSON.stringify(recap)}\n`);
    this.prune();
  }

  /** Remove recaps not written for `RECAP_KEEP_MS`. */
  prune(): void {
    const cutoff = this.clock() - RECAP_KEEP_MS;
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.dir, name);
      try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch { /* gone already, or not ours to judge */ }
    }
  }
}
