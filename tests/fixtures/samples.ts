/**
 * Prints the status bar and the monitor frame from the fixed fixture, so the
 * samples in `docs/BASELINE.md` and the READMEs are regenerated rather than
 * hand-written. Run with `node dist-test/tests/fixtures/samples.js` after
 * `npm run build:test`.
 *
 * The clock is pinned to `FIXED_NOW`: the bar carries a session timer, and a
 * sample recorded against the wall clock would differ every time it was taken.
 */

import { buildBarModules } from '../../src/render/layout/bar-modules.js';
import { fitModules } from '../../src/render/layout/engine.js';
import { renderMonitor, initialMonitorState } from '../../src/render/monitor.js';
import { stripAnsi, theme } from '../../src/render/colors.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { DEFAULT_LAYOUT } from '../../src/types.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';
import type { WorktreesSnapshot } from '../../src/collectors/worktrees.js';
import { makeHudData, FIXED_NOW } from './hud-data.js';

const NOW = FIXED_NOW.getTime();

/** The same assembly `renderStatusHeader` performs, with the clock pinned. */
function statusBar(width: number): string {
  const modules = buildBarModules(makeHudData(), { nowMs: NOW, barWidth: DEFAULT_LAYOUT.barWidth ?? 10 });
  return fitModules(modules, { width, separator: theme.separator(' │ '), groupSeparator: '  ' }).line;
}

// The monitor fixture from tests/unit/monitor.test.ts.
const monitorNow = Date.parse('2026-09-16T10:00:00Z');
const agent = (id: string, name: string, status: SubagentTreeNode['status']): SubagentTreeNode => ({
  id, name, status, depth: 1, children: [],
  startedAt: new Date(monitorNow - 120_000),
  turnStartedAt: new Date(monitorNow - 30_000),
  lastEventAt: new Date(monitorNow - 1000),
});
const monitorNodes = [
  agent('00000000-0000-4000-8000-000000000002', 'Hegel', 'completed'),
  agent('00000000-0000-4000-8000-000000000003', 'Pasteur', 'completed'),
];
const monitorTree: SubagentTree = {
  rootId: '00000000-0000-4000-8000-000000000001',
  nodes: monitorNodes,
  totalCount: monitorNodes.length,
  updatedAt: new Date(monitorNow),
};
const monitorWorktrees: WorktreesSnapshot = {
  sourcePath: '/demo', updatedAt: monitorNow,
  entries: [
    { path: '/demo/main', branch: 'main', bare: false, detached: false, observedAt: monitorNow,
      status: { changed: 3, staged: 1, unstaged: 2, untracked: 0, conflicts: 0, branch: 'main', ahead: 0, behind: 0 } },
    { path: '/demo/docs', branch: 'docs', bare: false, detached: false, observedAt: monitorNow,
      status: { changed: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, branch: 'docs', ahead: null, behind: null } },
  ],
};

const previous = setDisplayConfig({ theme: 'terminal', glyphs: 'both', density: 'balanced', motion: 'reduced' });
try {
  // Given widths, print those bars and nothing else, so the output can be
  // pasted straight into a document about the bar.
  const barWidths = process.argv.slice(2).map(Number).filter(Number.isFinite);
  for (const width of barWidths.length ? barWidths : [40, 60, 80, 100, 120, 160, 220]) {
    console.log(`${String(width).padStart(3)}  ${stripAnsi(statusBar(width))}`);
  }
  for (const width of barWidths.length ? [] : [16, 20]) {
    console.log(`\n--- monitor ${width}x24 ---`);
    const frame = renderMonitor({
      tree: monitorTree, worktrees: monitorWorktrees,
      state: initialMonitorState(), width, height: 24, nowMs: monitorNow,
    });
    for (const line of frame.lines) {
      console.log(stripAnsi(line).replace(/\s+$/, ''));
    }
  }
} finally {
  setDisplayConfig(previous);
}
