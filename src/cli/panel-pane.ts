/** Simple local herdr pane operations shared by the CLI and pi package. */
import { basename } from 'node:path';
import { loadSettings } from '../settings.js';
import { panelWidth, DEFAULT_WIDTH } from '../utils/pane-width.js';
import { truncateAnsi } from '../render/colors.js';
import { runHerdr, herdrResult, isRecord, herdrId } from '../roles/herdr-run.js';

async function command(argv: string[], env: NodeJS.ProcessEnv) {
  const result = await runHerdr(argv, env);
  if (!result.ok) throw Error(`herdr_${result.reason}`);
  return herdrResult(result.stdout);
}

export async function openEditorPane(files: string[], env: NodeJS.ProcessEnv): Promise<void> {
  if (!files.length) return;
  if (!herdrId(env.HERDR_PANE_ID)) throw Error('panel_requires_herdr');
  const panel = await command(['pane', 'get', env.HERDR_PANE_ID], env).catch(() => null);
  const workspace = isRecord(panel?.pane) ? panel.pane.workspace_id : undefined;
  const inTab = herdrId(workspace);
  const result = await command(
    inTab
      ? [
          'tab', 'create', '--workspace', workspace, '--cwd', process.cwd(),
          '--label', truncateAnsi(basename(files[0]), 24), '--focus',
        ]
      : ['pane', 'split', env.HERDR_PANE_ID, '--direction', 'right', '--focus', '--cwd', process.cwd()],
    env
  );
  const root = inTab ? result?.root_pane : result?.pane;
  const pane = isRecord(root) ? root.pane_id : undefined;
  if (!herdrId(pane)) throw Error(inTab ? 'panel_tab_unknown' : 'panel_split_unknown');
  const paths = files.map((file) => `'${file.replaceAll("'", "'\\''")}'`).join(' ');
  await command(['pane', 'run', pane, `${env.EDITOR || 'vim'} ${paths}; exit`], env);
}

export async function closePanelPane(pane: string, env: NodeJS.ProcessEnv): Promise<void> {
  await command(['pane', 'close', pane], env);
}

export async function panelPaneExists(pane: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const result = await runHerdr(['pane', 'get', pane], env);
  return result.ok && isRecord(herdrResult(result.stdout)?.pane);
}

/** Only an authoritative missing-pane reply ends the panel, not a failed transport. */
export function watchPanelCaller(env: NodeJS.ProcessEnv, onMissing: () => void): () => void {
  const caller = env.HUD_PANEL_CALLER_PANE;
  if (!herdrId(caller) || !herdrId(env.HERDR_PANE_ID) || caller === env.HERDR_PANE_ID) return () => {};
  const abort = new AbortController();
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void runHerdr(['pane', 'get', caller], env, { budgetMs: 1000, signal: abort.signal })
      .then((result) => {
        if (abort.signal.aborted) return;
        if (result.reason === 'unavailable') clearInterval(timer);
        const error = herdrResult(result.stderr)?.error;
        if (result.reason === 'failed' && isRecord(error) && error.code === 'not_found') {
          clearInterval(timer);
          onMissing();
        }
      })
      .finally(() => { busy = false; });
  }, 3000);
  return () => {
    clearInterval(timer);
    abort.abort();
  };
}

export async function openPanelPane(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  width = (() => { try { return loadSettings(env).treeWidth; } catch { return DEFAULT_WIDTH; } })(),
  columns = process.stdout.isTTY ? process.stdout.columns : Number(env.COLUMNS)
): Promise<string> {
  if (!herdrId(env.HERDR_PANE_ID)) throw Error('panel_requires_herdr');
  if (!Number.isFinite(columns) || columns <= 0) {
    const layout = await command(['pane', 'layout', '--pane', env.HERDR_PANE_ID], env).catch(() => null);
    const panes = isRecord(layout?.layout) ? layout.layout.panes : null;
    const caller = Array.isArray(panes) ? panes.find((p) => p.pane_id === env.HERDR_PANE_ID) : null;
    columns = isRecord(caller?.rect) ? Number(caller.rect.width) : NaN;
    if (!Number.isFinite(columns) || columns <= 0) columns = 120;
  }
  const requested = width;
  width = panelWidth(width, columns);
  const result = await command(
    [
      'pane',
      'split',
      env.HERDR_PANE_ID,
      '--direction',
      'right',
      '--ratio',
      String(Math.max(0.1, Math.min(0.9, 1 - width / columns))),
      '--no-focus',
      '--cwd',
      cwd,
      '--env',
      `HUD_PANEL_CALLER_PANE=${env.HERDR_PANE_ID}`,
      '--env',
      `HUD_PANEL_WIDTH=${requested}`,
    ],
    env
  );
  const pane = isRecord(result?.pane) ? result.pane.pane_id : undefined;
  if (!herdrId(pane)) throw Error('panel_split_unknown');
  try {
    await command(['pane', 'rename', pane, 'hud panel'], env);
    const text = argv.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
    await command(['pane', 'run', pane, text], env);
    return pane;
  } catch (error) {
    await closePanelPane(pane, env).catch(() => {});
    throw error;
  }
}
