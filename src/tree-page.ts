/**
 * Live side panel for the subagent directory tree.
 * Replaces the 2-line HUD pane while tree mode is active.
 */

import { spawn } from 'child_process';
import { SessionFinder } from './collectors/session-finder.js';
import { RolloutParser } from './collectors/rollout.js';
import { buildSubagentTree } from './collectors/subagent-tree.js';
import { renderSubagentTreePage, renderTreeUnboundPage } from './render/subagent-tree-view.js';
import { parseTreeKey } from './utils/tree-keys.js';
import * as fs from 'fs';
import type { SubagentTree } from './types.js';

const DATA_REFRESH_MS = 1000;
const RENDER_MS = 250;
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CURSOR_HOME = '\x1b[H';
const CLEAR_SCREEN = '\x1b[2J';

const HUD_CWD = process.env.CODEX_HUD_CWD || process.cwd();
const HUD_CWD_REAL = (() => {
  try {
    return fs.realpathSync(HUD_CWD);
  } catch {
    return HUD_CWD;
  }
})();

const HUD_SESSION_START = (() => {
  const raw = process.env.CODEX_HUD_SESSION_START;
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return parsed > 1_000_000_000_000 ? new Date(parsed) : new Date(parsed * 1000);
})();

function restoreStdin(): void {
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
}

function paint(lines: string[]): void {
  process.stdout.write(`${HIDE_CURSOR}${CURSOR_HOME}${CLEAR_SCREEN}${lines.join('\n')}`);
}

function windowPage(lines: string[], height: number, scroll: number): { lines: string[]; scroll: number } {
  if (height <= 0 || lines.length <= height) {
    return { lines, scroll: 0 };
  }
  const headerCount = Math.min(1, lines.length);
  const header = lines.slice(0, headerCount);
  const body = lines.slice(headerCount);
  const visible = Math.max(1, height - header.length);
  const maxScroll = Math.max(0, body.length - visible);
  const off = Math.min(Math.max(0, scroll), maxScroll);
  return {
    lines: [...header, ...body.slice(off, off + visible)],
    scroll: off,
  };
}

const sessionFinder = new SessionFinder(HUD_CWD_REAL, undefined, HUD_SESSION_START);
const rolloutParser = new RolloutParser(10);
let parserPath: string | null = null;
let lastParseSig: { path: string; size: number; mtimeMs: number } | null = null;

async function collectTree(): Promise<{ tree: SubagentTree | null; bound: boolean }> {
  const session = sessionFinder.check();
  if (!session) {
    return { tree: null, bound: false };
  }

  if (parserPath !== session.path) {
    rolloutParser.setRolloutPath(session.path);
    parserPath = session.path;
    lastParseSig = null;
  }

  let sig: { path: string; size: number; mtimeMs: number } | null = null;
  try {
    const stats = fs.statSync(session.path);
    sig = { path: session.path, size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    sig = null;
  }
  const unchanged =
    sig !== null &&
    lastParseSig !== null &&
    lastParseSig.path === sig.path &&
    lastParseSig.size === sig.size &&
    lastParseSig.mtimeMs === sig.mtimeMs;

  let result: Awaited<ReturnType<typeof rolloutParser.parse>> = rolloutParser.getCached();
  if (!unchanged || !result) {
    result = await rolloutParser.parse();
    lastParseSig = sig;
  }
  const rootId = result?.session?.id ?? session.sessionId;
  return { tree: buildSubagentTree(rootId, result?.subagents ?? []), bound: true };
}

function requestEnsureSingle(): void {
  const toggle = process.env.CODEX_HUD_TOGGLE_CMD;
  const session = process.env.CODEX_HUD_TMUX_SESSION;
  if (!toggle || !session) {
    return;
  }
  try {
    const child = spawn('bash', [toggle, session, '--ensure-single'], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
  } catch {
    // restore is best-effort; the pane is exiting anyway
  }
}

async function runLivePage(): Promise<void> {
  let closed = false;
  let collecting = false;
  let tree: SubagentTree | null = null;
  let bound = false;
  let collectError: string | null = null;
  let lastPaint = '';
  let scroll = 0;
  let dataTimer: ReturnType<typeof setInterval> | null = null;
  let renderTimer: ReturnType<typeof setInterval> | null = null;
  let closedByUser = false;

  const render = () => {
    if (closed) {
      return;
    }
    const columns = Number(process.stdout.columns);
    const rows = Number(process.stdout.rows);
    const maxWidth = Number.isFinite(columns) && columns > 0 ? columns : 24;
    const maxHeight = Number.isFinite(rows) && rows > 0 ? rows : 24;
    let page: string[];
    if (collectError) {
      page = [
        'Failed to refresh tree.',
        collectError,
      ];
    } else if (!bound) {
      page = renderTreeUnboundPage(maxWidth);
    } else if (!tree) {
      page = renderTreeUnboundPage(maxWidth);
    } else {
      page = renderSubagentTreePage(tree, maxWidth);
    }
    const windowed = windowPage(page, maxHeight, scroll);
    scroll = windowed.scroll;
    const painted = windowed.lines.join('\n');
    if (painted === lastPaint) {
      return;
    }
    lastPaint = painted;
    paint(windowed.lines);
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
    const key = parseTreeKey(chunk);
    if (key === 'up') {
      scroll = Math.max(0, scroll - 1);
      lastPaint = '';
      render();
      return;
    }
    if (key === 'down') {
      scroll += 1;
      lastPaint = '';
      render();
      return;
    }
    if (key === 'close') {
      closedByUser = true;
      requestEnsureSingle();
      finish();
    }
  };

  const collect = async () => {
    if (closed || collecting) {
      return;
    }
    collecting = true;
    try {
      const collected = await collectTree();
      tree = collected.tree;
      bound = collected.bound;
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

    process.once('SIGINT', () => {
      if (!closedByUser) {
        finish();
      }
    });
    process.once('SIGTERM', () => {
      if (!closedByUser) {
        finish();
      }
    });
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
