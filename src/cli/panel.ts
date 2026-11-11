import { join } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { displayTarget } from '../integrations/panel/receipt.js';
import { liveCallerIdentity } from '../roles/caller.js';
import { getHudHome } from '../hud-home.js';
import { resolveHudEnv } from '../utils/hud-env.js';
import type { Harness } from '../core/types/identity.js';
import { foreground, installationRoot } from './compat.js';
import type { HudIO } from './link-export.js';
import { parseRosterRoot, formatRosterRoot } from '../roles/selection.js';
import { CliError } from './runtime.js';
import { openPanelPane } from './panel-pane.js';

export const PANEL_HELP = `Usage: hud panel [--here] [--root <namespace/session-id>]
       hud panel --harness claude|pi|codex --session ID [--source ABS]
       hud panel open|close|toggle|status   # internal, bounded JSON stdin

Open the interactive HUD panel beside the caller in herdr, otherwise here.
--here renders in the current terminal without splitting.
--root selects observations only, never execution/control identity.
Without --root the existing all-delegations view is unchanged.
When a local ledger is available, the panel owns a bounded observation worker.
If the worker is unavailable, the panel continues with read-only observations.
Presentation aliases: HUD_THEME, HUD_DENSITY, HUD_GLYPHS, HUD_ICONS, HUD_LOOK,
HUD_REDUCED_MOTION, HUD_CONTEXT, HUD_TREE_WIDTH, HUD_CLEAR_SCROLLBACK.
HUD_SETTINGS_PATH selects the existing settings file. Present HUD_* values win
over their CODEX_HUD_* counterparts, including empty values. Saved display
settings retain priority; NO_COLOR still disables color.
`;

/** Display selection only. Explicit source is a transcript root, never job authority. */
export function panelSelection(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
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
  if (!source) {
    // Use current native evidence, never cwd or a harness-name namespace.
    const identity = liveCallerIdentity(env);
    if (!identity || identity.harness !== harness || identity.root.sessionId !== session)
      throw new CliError('panel_source_unverified', 3);
    return { root: formatRosterRoot(identity.root) };
  }
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
  if (args.length === 1 && ['open', 'close', 'toggle', 'status'].includes(args[0]!)) {
    const { panelControlMain } = await import('../integrations/panel/cli.js');
    return panelControlMain([...args], io.env);
  }
  const here = args[0] === '--here';
  const selection = here ? args.slice(1) : args;
  const { root, target } = panelSelection(selection, io.env);
  if (!here && io.env.HERDR_PANE_ID) {
    const pane = await openPanelPane(
      [process.execPath, join(installationRoot(), 'bin/hud'), 'panel', '--here', ...selection],
      process.cwd(),
      io.env
    );
    await io.stdout(pane + '\n');
    return 0;
  }
  return foreground(
    { argv: [process.execPath, join(installationRoot(), 'dist/tree-page.js')] },
    {
      ...io.env,
      HUD_SETTINGS_PATH: resolveHudEnv(io.env, 'HUD_SETTINGS_PATH') || join(getHudHome(io.env), 'hud-settings.json'),
      ...(target
        ? {
            HUD_PANEL_HARNESS: target.harness,
            HUD_PANEL_SOURCE: target.source,
            HUD_PANEL_SESSION: target.ref.sessionId,
          }
        : {}),
      CODEX_HUD_PANEL_ALL_DELEGATIONS: root ? '0' : '1',
      ...(root ? { CODEX_HUD_PANEL_ROOT: root } : {}),
      CODEX_HUD_STANDALONE_PANEL: '1',
    }
  );
}
