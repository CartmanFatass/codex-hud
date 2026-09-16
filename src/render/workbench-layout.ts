/** Pure presentation policy. No rollout I/O, Git processes or terminal input. */
import type { GitChanges } from '../collectors/git-changes.js';
import type { ToolCall } from '../types.js';
import type { PaneId, PaneRect, WorkbenchState } from './workbench-state.js';

export const FILE_LIST_MIN_CONTENT_WIDTH = 36;
export function panePadding(width: number): number { return width >= 6 ? 1 : 0; }
export function paneContentWidth(width: number): number {
  return Math.max(0, width - 2 - 2 * panePadding(width));
}
export function summaryOnly(width: number): boolean {
  return paneContentWidth(width) < FILE_LIST_MIN_CONTENT_WIDTH;
}
export function canPreviewDiff(panes: PaneRect[]): boolean {
  return panes.some(pane => pane.id === 'details' && pane.height > 2 && !summaryOnly(pane.width));
}

/** Screen lines are not list indices: cards can occupy two lines; summaries none. */
export function paneItemAt(pane: PaneRect, x: number, y: number): number | undefined {
  const pad = panePadding(pane.width);
  if (x < pane.x + 1 + pad || x >= pane.x + pane.width - 1 - pad ||
      y <= pane.y || y >= pane.y + pane.height - 1) return undefined;
  const line = pane.offset + y - pane.y - 1;
  if (line < 0 || line >= pane.contentLength) return undefined;
  return pane.rowItems ? pane.rowItems[line] ?? undefined : line;
}
export function panePageSize(pane?: PaneRect): number {
  const lines = Math.max(1, (pane?.height ?? 5) - 2);
  if (!pane?.rowItems || pane.summary) return lines;
  const items = pane.rowItems.slice(pane.offset, pane.offset + lines).filter(item => item !== null);
  return Math.max(1, new Set(items).size);
}

export function workspaceCounts(git: GitChanges) {
  // Staged and unstaged overlap. Neither their sum nor tool activity is a file count.
  const changed = (status: string) => status !== ' ' && status !== '.' && status !== '?';
  return {
    files: git.files.length,
    staged: git.files.filter(file => !file.conflict && changed(file.index)).length,
    unstaged: git.files.filter(file => !file.conflict && changed(file.worktree)).length,
    untracked: git.files.filter(file => file.index === '?' && file.worktree === '?').length,
    conflicts: git.files.filter(file => file.conflict).length,
    binary: git.files.filter(file => file.binary).length,
  };
}
/** Keep native spawn/Git stderr out of the HUD even if a caller stored it. */
export function gitFailureNotice(error?: string | null): string | undefined {
  if (!error) return undefined;
  if (/command failed:|spawn git|execfile |git --no-optional-locks|\bgit\b.*-c |fatal:|not a git repository|enoent|etimedout/i.test(error)) {
    return 'Git could not complete the request';
  }
  return error;
}

export function workspaceSummary(git?: GitChanges | null): string[] {
  if (!git) return ['Loading Git…'];
  if (!git.root) return [git.error ? 'Git unavailable' : 'No Git repository'];
  const count = workspaceCounts(git);
  if (!count.files) return [git.error ? 'Git incomplete' : 'Working tree clean'];
  return [
    ...(git.error ? ['Git incomplete'] : []),
    ...(count.conflicts ? [`! ${count.conflicts} conflict${count.conflicts === 1 ? '' : 's'}`] : []),
    `${count.files} files`, `${count.staged} staged`, `${count.unstaged} unstaged`, `${count.untracked} untracked`,
  ];
}

/** Completion alone is not success. No inferred pass rate or agent progress. */
export function toolResult(call: ToolCall): string {
  if (call.exitCode !== undefined) return `exit ${call.exitCode}`;
  if (call.resultSuccess === false || call.status === 'error') return 'reported error';
  if (call.resultSuccess === true) return 'reported success';
  return call.status === 'running' ? 'recorded running' : 'result unknown';
}
export function toolCommand(call: ToolCall, expanded = false): string {
  const args = call.arguments;
  const explicit = typeof args?.cmd === 'string' ? args.cmd : typeof args?.command === 'string' ? args.command : undefined;
  if (explicit) return explicit;
  if (typeof args?.code === 'string') return expanded ? args.code : `${call.name} · inline code`;
  return call.target ?? call.name;
}

export function layoutWorkbench(width: number, height: number, state: WorkbenchState, agentCount: number, summaryRows = 4): PaneRect[] {
  const available = Math.max(0, height - 2);
  const make = (id: PaneId, x: number, y: number, w: number, h: number): PaneRect => ({
    id, x, y, width: w, height: h, offset: 0, contentLength: 0,
    summary: id === 'changes' && summaryOnly(w),
  });
  if (width <= 0 || !available) return [];
  if (state.zoom || available < 12 || width < 12) {
    return [make(state.focus, 0, 1, width, state.collapsed[state.focus] ? 1 : available)];
  }
  const stack = (ids: PaneId[], x: number, w: number): PaneRect[] => {
    const sizes = ids.map(id => state.collapsed[id] ? 1 : 3);
    let remaining = available - sizes.reduce((sum, n) => sum + n, 0);
    const card = paneContentWidth(w) >= 16 ? 2 : 1;
    const target: Record<PaneId, number> = {
      agents: Math.min(12, Math.max(6, agentCount * card + 2)),
      // Team reports need a status line plus an excerpt per agent. Inspector
      // is explicit; do not reserve task/command/result rows by default.
      details: state.detailExpanded ? 10 : Math.min(14, Math.max(6, agentCount * 2 + 2)),
      changes: summaryOnly(w) ? Math.min(8, summaryRows + 2) : 7,
      activity: 5,
    };
    const minimum: Record<PaneId, number> = {
      agents: 6,
      details: state.detailExpanded ? 9 : 6,
      changes: Math.min(target.changes, 8),
      activity: 3,
    };
    for (const id of ['agents', 'details', 'changes', 'activity'] as PaneId[]) {
      const index = ids.indexOf(id);
      if (index < 0 || state.collapsed[id]) continue;
      const extra = Math.min(remaining, Math.max(0,minimum[id]-sizes[index]));
      sizes[index] += extra; remaining -= extra;
    }
    while (remaining > 0) {
      let grew = false;
      for (let i = 0; i < ids.length && remaining > 0; i++) {
        if (!state.collapsed[ids[i]] && sizes[i] < target[ids[i]]) {
          sizes[i]++; remaining--; grew = true;
        }
      }
      if (!grew) break;
    }
    const flexible = ids.map((id, i) => ({id, i})).filter(({id}) => !state.collapsed[id] && (id === 'agents' || id === 'details'));
    const fill = flexible.length ? flexible : ids.map((id, i) => ({id, i})).filter(({id}) => !state.collapsed[id]);
    for (let i = 0; remaining > 0 && fill.length; i++, remaining--) sizes[fill[i % fill.length].i]++;
    let y = 1;
    return ids.map((id, i) => { const pane = make(id, x, y, w, sizes[i]); y += sizes[i]; return pane; });
  };
  if (width >= 70) {
    const left = Math.min(40, Math.floor((width - 1) * 0.38));
    // File names and their preview share the wider column; a gutter separates borders.
    return [...stack(['agents', 'activity'], 0, left), ...stack(['details', 'changes'], left + 1, width - left - 1)];
  }
  return stack(['agents', 'details', 'changes', 'activity'], 0, width);
}
