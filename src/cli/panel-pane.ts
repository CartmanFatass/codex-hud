/** Simple local herdr pane operations shared by the CLI and pi package. */
import { runHerdr, herdrResult, isRecord } from '../roles/herdr-run.js';

async function command(argv: string[], env: NodeJS.ProcessEnv) {
  const result = await runHerdr(argv, env);
  if (!result.ok) throw Error(`herdr_${result.reason}`);
  return herdrResult(result.stdout);
}

export async function closePanelPane(pane: string, env: NodeJS.ProcessEnv): Promise<void> {
  await command(['pane', 'close', pane], env);
}

export async function panelPaneExists(pane: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const result = await runHerdr(['pane', 'get', pane], env);
  return result.ok && isRecord(herdrResult(result.stdout)?.pane);
}

export async function openPanelPane(argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (!env.HERDR_PANE_ID) throw Error('panel_requires_herdr');
  const result = await command(
    ['pane', 'split', env.HERDR_PANE_ID, '--direction', 'right', '--no-focus', '--cwd', cwd],
    env
  );
  const pane = isRecord(result?.pane) ? result.pane.pane_id : undefined;
  if (typeof pane !== 'string' || !pane) throw Error('panel_split_unknown');
  try {
    const text = argv.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
    await command(['pane', 'run', pane, text], env);
    return pane;
  } catch (error) {
    await closePanelPane(pane, env).catch(() => {});
    throw error;
  }
}
