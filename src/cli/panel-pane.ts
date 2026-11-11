/** Simple local herdr pane operations shared by the CLI and pi package. */
import { runHerdr, herdrResult, isRecord } from '../roles/herdr-run.js';

async function command(argv: string[], env: NodeJS.ProcessEnv) {
  const result = await runHerdr(argv, env);
  if (!result.ok) throw Error(`herdr_${result.reason}`);
  return herdrResult(result.stdout);
}

export async function openEditorPane(files: string[], env: NodeJS.ProcessEnv): Promise<void> {
  if (!env.HERDR_PANE_ID) throw Error('panel_requires_herdr');
  const result = await command(
    ['pane', 'split', env.HERDR_PANE_ID, '--direction', 'right', '--focus', '--cwd', process.cwd()],
    env
  );
  const pane = isRecord(result?.pane) ? result.pane.pane_id : undefined;
  if (typeof pane !== 'string') throw Error('panel_split_unknown');
  const paths = files.map((file) => `'${file.replaceAll("'", "'\\''")}'`).join(' ');
  await command(['pane', 'run', pane, `${env.EDITOR || 'vim'} ${paths}`], env);
}

export async function closePanelPane(pane: string, env: NodeJS.ProcessEnv): Promise<void> {
  await command(['pane', 'close', pane], env);
}

export async function panelPaneExists(pane: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const result = await runHerdr(['pane', 'get', pane], env);
  return result.ok && isRecord(herdrResult(result.stdout)?.pane);
}

export async function openPanelPane(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  width = 56,
  columns = process.stdout.isTTY ? process.stdout.columns : Number(env.COLUMNS)
): Promise<string> {
  if (!env.HERDR_PANE_ID) throw Error('panel_requires_herdr');
  const result = await command(
    [
      'pane',
      'split',
      env.HERDR_PANE_ID,
      '--direction',
      'right',
      '--ratio',
      String(Number.isFinite(columns) && columns > 0 ? Math.max(0.1, Math.min(0.9, 1 - width / columns)) : 0.7),
      '--no-focus',
      '--cwd',
      cwd,
      '--env',
      `HUD_PANEL_CALLER_PANE=${env.HERDR_PANE_ID}`,
    ],
    env
  );
  const pane = isRecord(result?.pane) ? result.pane.pane_id : undefined;
  if (typeof pane !== 'string' || !pane) throw Error('panel_split_unknown');
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
