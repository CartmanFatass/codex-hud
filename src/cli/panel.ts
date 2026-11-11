import { join } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { displayTarget } from '../integrations/panel/receipt.js';
import { getHudHome } from '../hud-home.js';
import { resolveHudEnv } from '../utils/hud-env.js';
import type { Harness } from '../core/types/identity.js';
import { foreground, installationRoot } from './compat.js';
import type { HudIO } from './hud.js';
import { parseRosterRoot, formatRosterRoot } from '../roles/selection.js';
import { CliError } from './private-home.js';
import { openPanelPane } from './panel-pane.js';

export const PANEL_HELP = `Usage: hud panel [--width N] [--here] [--root <namespace/session-id>]
       hud panel --harness claude|pi|codex --session ID --source ABS

Open the interactive HUD panel beside the caller in herdr, otherwise here.
--here renders in the current terminal without splitting.
--width sets the new panel width in columns (default 56).
--root selects observations only, never execution/control identity.
Without --root the existing all-delegations view is unchanged.
Presentation aliases: HUD_THEME, HUD_DENSITY, HUD_GLYPHS, HUD_ICONS, HUD_LOOK,
HUD_REDUCED_MOTION, HUD_CONTEXT, HUD_TREE_WIDTH, HUD_CLEAR_SCROLLBACK.
HUD_SETTINGS_PATH selects the existing settings file. Present HUD_* values win
over their CODEX_HUD_* counterparts, including empty values. Saved display
settings retain priority; NO_COLOR still disables color.
`;

/** Display selection only. Explicit source is a transcript root, never job authority. */
export function panelSelection(
  args: readonly string[],
  _env: NodeJS.ProcessEnv = process.env
): {
  root: string | null;
  target?: ReturnType<typeof displayTarget>;
} {
  if (!args.length) return { root: null };
  if (args[0] === '--root') {
    if (args.length !== 2) throw new CliError('invalid_arguments');
    try {
      return { root: formatRosterRoot(parseRosterRoot(args[1]!)) };
    } catch {
      throw new CliError('invalid_arguments');
    }
  }
  const flags = new Map<string, string>();
  for (let n = 0; n < args.length; n += 2) {
    const k = args[n]!;
    const v = args[n + 1];
    if (!['--harness', '--session', '--source'].includes(k) || flags.has(k) || !v)
      throw new CliError('invalid_arguments');
    flags.set(k, v);
  }
  const harness = flags.get('--harness') as Harness;
  const session = flags.get('--session');
  if (!['claude', 'pi', 'codex'].includes(harness) || !session) throw new CliError('invalid_arguments');
  const source = flags.get('--source');
  if (!source) throw new CliError('invalid_arguments');
  try {
    if (realpathSync(source) !== source || !statSync(source).isDirectory()) throw new Error('noncanonical');
    const target = displayTarget(harness, session, source);
    return { root: target.root, target };
  } catch {
    throw new CliError('invalid_arguments');
  }
}

/** Shared CLI validation; no caller identity, routing selection or storage writes. */
export function panelRoot(args: readonly string[]): string | null {
  return panelSelection(args).root;
}

/** Use the installed panel entry, with inherited terminal and normal signal handling. */
export async function panelCommand(io: HudIO, args: readonly string[] = []): Promise<number> {
  const rest = [...args];
  const at = rest.indexOf('--width');
  let width = 56;
  if (at >= 0) {
    if (!/^[1-9]\d*$/.test(rest[at + 1] ?? '')) throw new CliError('invalid_arguments');
    width = Number(rest[at + 1]);
    rest.splice(at, 2);
  }
  const here = rest[0] === '--here';
  const selection = here ? rest.slice(1) : rest;
  const { root } = panelSelection(selection, io.env);
  if (!here && io.env.HERDR_PANE_ID) {
    const pane = await openPanelPane(
      [process.execPath, join(installationRoot(), 'bin/hud'), 'panel', '--here', ...selection],
      process.cwd(),
      io.env,
      width
    );
    await io.stdout(pane + '\n');
    return 0;
  }
  return foreground(
    { argv: [process.execPath, join(installationRoot(), 'dist/tree-page.js')] },
    {
      ...io.env,
      HUD_SETTINGS_PATH: resolveHudEnv(io.env, 'HUD_SETTINGS_PATH') || join(getHudHome(io.env), 'hud-settings.json'),

      CODEX_HUD_PANEL_ALL_DELEGATIONS: root ? '0' : '1',
      ...(root ? { CODEX_HUD_PANEL_ROOT: root } : {}),
      CODEX_HUD_STANDALONE_PANEL: '1',
    }
  );
}
