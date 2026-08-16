/**
 * Live popup page for the subagent directory tree.
 * Does not change the 2-line HUD pane.
 */

import { findMostRecentRollout } from './collectors/session-finder.js';
import { parseRolloutFile } from './collectors/rollout.js';
import { buildSubagentTree } from './collectors/subagent-tree.js';
import { renderSubagentTreePage } from './render/subagent-tree-view.js';

const REFRESH_MS = 1000;
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

async function collectPage(cwd: string): Promise<string> {
  const recent = findMostRecentRollout(30, cwd);
  if (!recent) {
    return 'No Codex session found.\nPress q to close.';
  }

  const { result } = await parseRolloutFile(recent.path, 0, 10);
  const rootId = result.session?.id ?? recent.sessionId;
  const tree = buildSubagentTree(rootId, result.subagents ?? []);
  return renderSubagentTreePage(tree).join('\n');
}

async function runLivePage(): Promise<void> {
  const cwd = process.env.CODEX_HUD_CWD || process.cwd();
  let closed = false;
  let refreshing = false;
  let lastPaint = '';
  let timer: ReturnType<typeof setInterval> | null = null;

  await new Promise<void>((resolve) => {
    const finish = () => {
      if (closed) {
        return;
      }
      closed = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      process.stdin.off('data', onData);
      restoreStdin();
      process.stdout.write(SHOW_CURSOR);
      resolve();
    };

    const onData = (chunk: Buffer) => {
      if (shouldClose(chunk)) {
        finish();
      }
    };

    const refresh = async () => {
      if (closed || refreshing) {
        return;
      }
      refreshing = true;
      try {
        const page = await collectPage(cwd);
        if (closed || page === lastPaint) {
          return;
        }
        lastPaint = page;
        paint(page);
      } catch (error) {
        if (closed) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        const page = `Failed to refresh tree.\n${message}\n\nPress q to close.`;
        if (page !== lastPaint) {
          lastPaint = page;
          paint(page);
        }
      } finally {
        refreshing = false;
      }
    };

    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    process.stdout.on('resize', () => {
      lastPaint = '';
      void refresh();
    });

    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on('data', onData);

    void refresh().then(() => {
      if (!closed) {
        timer = setInterval(() => {
          void refresh();
        }, REFRESH_MS);
      }
    });
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
