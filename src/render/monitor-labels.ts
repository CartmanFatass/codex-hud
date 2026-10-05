/**
 * What the panel says about an agent, a worktree or a changed file beside
 * its name: its status icon, how long ago, the turn clock, its own colour,
 * what a worktree is called and where it is, and what happened to a file.
 */
import type { SubagentTreeNode } from '../types.js';
import type { WorktreeInfo } from '../collectors/worktrees.js';
import type { GitChangedFile } from '../collectors/git-changes.js';
import { theme, colors } from './colors.js';
import { palette } from './palette.js';
import { displayConfig } from './hud-config.js';
import { t } from './i18n.js';

/**
 * Icons stand in for the panel's words (a brief field's label, "ago" after a
 * time) unless the reader set glyphs to text; then the words stay.
 */
export function iconic(): boolean {
  return displayConfig().glyphs !== 'text';
}
/** How long ago, as the panel says it: "12d" where icons stand in for words, else "12d ago". */
export function agoText(at: Date | undefined, now: number): string {
  return iconic() ? age(at,now) : t('{age} ago',{age:age(at,now)});
}
/**
 * Seconds, minutes, hours or days since `at`, the coarsest unit that is not
 * zero; days past two of them, where "308h" is a sum the reader has to do.
 * The panel's one relative-time formatter: cards, timeline, inspector and
 * status card all say a time this way.
 */
export function age(at: Date | undefined, now: number): string {
  if (!at || !Number.isFinite(at.getTime())) return '?';
  const seconds = Math.max(0, Math.floor((now-at.getTime())/1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds/60)}m`
    : seconds < 2*86_400 ? `${Math.floor(seconds/3600)}h` : `${Math.floor(seconds/86_400)}d`;
}

export function nodeStatus(node: SubagentTreeNode, now: number): {icon:string; label:string; paint:(s:string)=>string} {
  switch (node.status) {
    case 'running': return {icon:'▸',label:node.turnStartedAt ? age(node.turnStartedAt,now) : 'run',paint:theme.info};
    case 'starting': return {icon:'·',label:'start',paint:theme.info};
    case 'completed': return {icon:'✓',label:'done',paint:theme.success};
    case 'error': return {icon:'!',label:'error',paint:theme.error};
    default: return {icon:'?',label:'unknown',paint:colors.dim};
  }
}

export function worktreeLabel(entry: WorktreeInfo, now: number): string {
  if (entry.bare) return 'bare';
  if (entry.prunable !== undefined) return 'prunable';
  if (entry.error) return 'unreadable';
  if (!entry.status || entry.observedAt === undefined) return '?';
  if (now-entry.observedAt > 30_000) return 'stale';
  if (entry.status.conflicts) return `!${entry.status.conflicts}`;
  return entry.status.changed ? `${entry.status.changed} mod` : 'clean';
}
/** A file git does not track yet. */
export function isUntracked(file: GitChangedFile): boolean {
  return file.index === '?' && file.worktree === '?';
}
/** The changes list's one row for its untracked files, as an item: no path can hold a NUL. */
export const UNTRACKED_ROW = '\0untracked';
/** A worktree's row in the changes list, as an item: its path behind a NUL, so no file's path is one. */
const WORKTREE_ROW = '\0worktree:';
export function worktreeItem(path: string): string {
  return WORKTREE_ROW+path;
}
/** Whether the changes list heads its files with the worktrees: only where there is more than one to choose from. */
export function listsWorktrees(snapshot: {entries: readonly unknown[]} | null | undefined): boolean {
  return (snapshot?.entries.length ?? 0) > 1;
}
/** The worktree a changes item is the row of, or undefined for a file's. */
export function worktreeOfItem(item: string | null | undefined): string | undefined {
  return item?.startsWith(WORKTREE_ROW) ? item.slice(WORKTREE_ROW.length) : undefined;
}
/**
 * What happened to a changed file, as one letter in its colour: added
 * green, deleted red, renamed or copied blue, modified (and the rest)
 * yellow, and a conflict a red "!". Added, deleted, renamed or copied in the
 * index says more than an edit on top of it.
 */
export function changeLetter(file: GitChangedFile): string {
  if (file.conflict) return theme.error('!');
  const set = (code: string) => code !== ' ' && code !== '.';
  const code = set(file.index) && file.index !== 'M' ? file.index : set(file.worktree) ? file.worktree : file.index;
  return (code === 'A' ? theme.success : code === 'D' ? theme.error : code === 'R' || code === 'C' ? theme.info : theme.warning)(code);
}
/** The lines a changed file adds and removes, "+12 −3", a side with none left out. */
export function lineCounts(file: GitChangedFile): string {
  return [file.added ? theme.success(`+${file.added}`) : '',file.removed ? theme.error(`−${file.removed}`) : ''].filter(Boolean).join(' ');
}
/** A worktree label in the reader's language; the label itself stays a stable code. */
export function worktreeLabelText(label: string): string {
  const changed = label.match(/^(\d+) mod$/);
  return changed ? t('{n} mod',{n:changed[1]}) : label.startsWith('!') ? label : t(label);
}
/** A directory name that is an id, not a name: hex of 7 or more characters, or a UUID. */
export const ID_NAME = /^(?:[0-9a-f]{7,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
/**
 * What a worktree is called on screen: its branch; detached, its
 * directory's name, or, where that is an id, the nearest directory above it
 * that is neither an id nor `.git` (`atlas-launch-sources`, not a 32-digit
 * hash). No hash is ever shown.
 */
export function worktreeName(entry: WorktreeInfo): string {
  if (entry.branch) return entry.branch;
  const parts = entry.path.split(/[\\/]+/).filter(Boolean);
  for (let i = parts.length-1; i >= 0; i--) if (!ID_NAME.test(parts[i]) && parts[i] !== '.git') return parts[i];
  return t(entry.bare ? 'bare' : 'detached');
}
/**
 * Where a worktree is, relative to the repository's main worktree: up to its
 * first id directory, then "…" (`.git/atlas-launch-sources/…`). Empty for
 * the main worktree itself.
 */
export function worktreePlace(entry: WorktreeInfo, root: string | undefined): string {
  const path = entry.path.replace(/[\\/]+$/,'');
  const base = root?.replace(/[\\/]+$/,'');
  const relative = base && path.startsWith(base+'/') ? path.slice(base.length+1) : base === path ? '' : path;
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  const id = parts.findIndex(part => ID_NAME.test(part));
  return id < 0 ? parts.join('/') : [...parts.slice(0,id),'…'].join('/');
}

/**
 * How long the current turn has run, as a clock face rather than a number:
 * the hand sits in the quarter of the hour the turn has reached, an empty
 * face is a turn under a minute old and a filled one has run past the hour.
 * The exact figure is one Enter away in the Inspector. All six glyphs are
 * one column wide in CJK terminals too, and none is an effort glyph.
 */
export const TURN_CLOCKS: ReadonlyArray<readonly [number, string]> = [
  [60_000,'◌'],[900_000,'◷'],[1_800_000,'◶'],[2_700_000,'◵'],[3_600_000,'◴'],
];
export const TURN_CLOCK_LONG = '◉';

/** A running agent with no event of any kind for this long is quiet, not necessarily stuck. */
export const QUIET_MS = 5 * 60_000;
/** A finished row stays bright this long, then recedes until the linger window takes it. */
export const FRESH_FINISH_MS = 60_000;

export function isLive(node: SubagentTreeNode): boolean {
  return node.status === 'running' || node.status === 'starting';
}
export function isQuiet(node: SubagentTreeNode, now: number): boolean {
  const at = node.lastEventAt?.getTime();
  return isLive(node) && at !== undefined && Number.isFinite(at) && now-at > QUIET_MS;
}
export function turnClock(node: SubagentTreeNode, now: number): string {
  if (!isLive(node)) return '';
  const start = (node.turnStartedAt ?? node.startedAt)?.getTime();
  if (start === undefined || !Number.isFinite(start)) return '';
  const elapsed = Math.max(0,now-start);
  const glyph = TURN_CLOCKS.find(([limit]) => elapsed < limit)?.[1] ?? TURN_CLOCK_LONG;
  return isQuiet(node,now) ? theme.warning(glyph) : theme.info(glyph);
}

/** Past a clock's boundary, so the repaint lands after its second has turned. */
const REPAINT_SLACK_MS = 20;

/**
 * How long until the panel's text next changes with no new data. Nothing in
 * the panel animates faster than a second: its clocks and ages count whole
 * seconds ("4m07s", "12s ago", "↺45s") and the agent rows' clock glyphs move
 * on the quarter hour. So it repaints once a second, timed to just after the
 * main turn clock's second turns over while a turn runs (`anchorMs`, its
 * start: those are the digits a reader watches tick), otherwise after the
 * wall clock's. A fixed phase also keeps a clock from skipping a second
 * when a timer runs late.
 */
export function nextRepaintDelay(nowMs: number, anchorMs?: number): number {
  const origin = anchorMs !== undefined && Number.isFinite(anchorMs) ? anchorMs : 0;
  const into = (((nowMs - origin) % 1000) + 1000) % 1000;
  return 1000 - into + REPAINT_SLACK_MS;
}

/** When a finished agent finished: its completion event, else its last sign of life. */
export function finishedAt(node: SubagentTreeNode): Date | undefined {
  return node.statusAt ?? node.lastEventAt;
}

/**
 * An agent's own colour, the same on every repaint and in every pane: for
 * following one agent down the timeline and into the Inspector. Not on its
 * card, whose colour is its state.
 */
export function agentPaint(id: string): (s: string) => string {
  const colours = palette().agents;
  let hash = 0;
  for (const ch of id) hash = (hash*31+ch.charCodeAt(0)) >>> 0;
  return colours[hash%colours.length];
}

/** When something written once was written: no seconds ticking, days for an old one. */
export function writtenAge(at: number, now: number): string {
  const seconds = Math.max(0,Math.floor((now-at)/1000));
  if (seconds < 60) return t('just now');
  return t('{age} ago',{age:age(new Date(at),now)});
}
