/**
 * Live popup page for the subagent directory tree.
 * Does not change the 2-line HUD pane.
 */

import { findMostRecentRollout } from './collectors/session-finder.js';
import { RolloutParser } from './collectors/rollout.js';
import { buildSubagentTree } from './collectors/subagent-tree.js';
import { renderSubagentTreePage } from './render/subagent-tree-view.js';
import type { SubagentTree } from './types.js';

// Rollout parsing is the expensive step; the ⇄ marker only needs re-rendering.
const DATA_REFRESH_MS = 1000;
const RENDER_MS = 250;

// Persistent incremental parser: each data tick reads only new bytes instead
// of re-parsing the whole rollout from offset 0.
const rolloutParser = new RolloutParser(10);
let parserPath: string | null = null;
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CURSOR_HOME = '\x1b[H';
const CLEAR_SCREEN = '\x1b[2J';

function shouldClose(chunk: Buffer): boolean {
  if (chunk.length === 0) {
    return false;
  }
  const first = chunk[0];
  if (first === 0x03 || first === 0x04 || first === 0x1b || first === 0x14 || first === 0x0d || first === 0x0a) {
    return true;
  }
  const text = chunk.toString('utf8');
  return /q/i.test(text);
}

function restoreStdin(): void {
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
}

function paint(text: string): void {
  const body = text.endsWith('\n') ? text : `${text}\n`;
  process.stdout.write(`${HIDE_CURSOR}${CURSOR_HOME}${CLEAR_SCREEN}${body}`);
}

async function collectTree(cwd: string): Promise<SubagentTree | null> {
  const recent = findMostRecentRollout(30, cwd);
  if (!recent) {
    return null;
  }

  if (parserPath !== recent.path) {
    rolloutParser.setRolloutPath(recent.path);
    parserPath = recent.path;
  }
  const result = await rolloutParser.parse();
  const rootId = result?.session?.id ?? recent.sessionId;
  return buildSubagentTree(rootId, result?.subagents ?? []);
}

async function runLivePage(): Promise<void> {
  const cwd = process.env.CODEX_HUD_CWD || process.cwd();
  let closed = false;
  let collecting = false;
  let tree: SubagentTree | null = null;
  let collectError: string | null = null;
  let noSession = false;
  let lastPaint = '';
  let dataTimer: ReturnType<typeof setInterval> | null = null;
  let renderTimer: ReturnType<typeof setInterval> | null = null;

  const render = () => {
    if (closed) {
      return;
    }
    let page: string;
    if (collectError) {
      page = `Failed to refresh tree.\n${collectError}\n\nPress q to close.`;
    } else if (noSession || !tree) {
      page = 'No Codex session found.\nPress q to close.';
    } else {
      // In side-panel mode the pane is narrow: clamp every line to its width.
      const columns = Number(process.stdout.columns);
      const maxWidth = Number.isFinite(columns) && columns > 0 ? columns : undefined;
      page = renderSubagentTreePage(tree, maxWidth).join('\n');
    }
    if (page === lastPaint) {
      return;
    }
    lastPaint = page;
    paint(page);
  };

  const finish = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (dataTimer) {
      clearInterval(dataTimer);
      dataTimer = null;
    }
    if (renderTimer) {
      clearInterval(renderTimer);
      renderTimer = null;
    }
    process.stdin.off('data', onData);
    restoreStdin();
    process.stdout.write(SHOW_CURSOR);
    resolveReady();
  };

  const onData = (chunk: Buffer) => {
    if (shouldClose(chunk)) {
      finish();
    }
  };

  const collect = async () => {
    if (closed || collecting) {
      return;
    }
    collecting = true;
    try {
      const collected = await collectTree(cwd);
      tree = collected;
      noSession = collected === null;
      collectError = null;
    } catch (error) {
      collectError = error instanceof Error ? error.message : String(error);
    } finally {
      collecting = false;
    }
    render();
  };

  let resolveReady: () => void = () => {};

  await new Promise<void>((resolve) => {
    resolveReady = resolve;

    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    process.stdout.on('resize', () => {
      lastPaint = '';
      render();
    });

    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on('data', onData);

    void collect();
    dataTimer = setInterval(() => {
      void collect();
    }, DATA_REFRESH_MS);
    // The ⇄/⇆ traffic marker and elapsed times advance between data
    // refreshes, so re-render the cached tree at a higher cadence.
    renderTimer = setInterval(render, RENDER_MS);
  });
}

runLivePage()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreStdin();
    process.stdout.write(SHOW_CURSOR);
    process.exit(process.exitCode ?? 0);
  });
