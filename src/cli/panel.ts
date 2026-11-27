import { isAbsolute, join, resolve } from 'node:path';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { callerSession } from '../collectors/claude-caller-session.js';
import { makeSourceId } from '../core/identity.js';
import { hasHerdrDock, herdrEndpoint, request as herdrRequest } from '../runtime/herdr-socket.js';
import { defaultSettings, loadSettings, settingsPath } from '../settings.js';
import { DEFAULT_HEIGHT, DEFAULT_WIDTH } from '../utils/pane-width.js';
import { getHudHome } from '../hud-home.js';
import { resolveHudEnv } from '../utils/hud-env.js';
import type { Harness } from '../core/types/identity.js';
import { foreground, installationRoot } from './compat.js';
import type { HudIO } from './hud.js';
import type { SidebarDestination } from '../panel/sidebar-navigation.js';
import { parseRosterRoot, formatRosterRoot } from '../roles/selection.js';
import { v8HeapArgs } from '../../scripts/dist-lock.mjs';
import { CliError } from './private-home.js';

const PANEL_HELP = `Usage: hud panel [toggle|open] [--width N] [--root <namespace/session-id>]
       hud panel hide|close|status
       hud panel --here [--root <namespace/session-id>]
       hud panel [--here] --harness claude|pi|codex --session ID --source ABS

Show or collapse the shared HUD dock in herdr, or run it here outside herdr.
\`hide\` collapses the dock without stopping it; \`close\` stops its process.
\`status\` reports shown, hidden, or closed.
--here runs in the current terminal without using the dock.
--width overrides saved Settings → Panel → Width for this opening (default 56).
--root selects observations only, never execution/control identity.
Without --root the existing all-delegations view is unchanged.
Presentation aliases: HUD_THEME, HUD_DENSITY, HUD_GLYPHS, HUD_ICONS, HUD_LOOK,
HUD_REDUCED_MOTION, HUD_CONTEXT, HUD_TREE_WIDTH.
HUD_SETTINGS_PATH selects the existing settings file. Present HUD_* values win
over their CODEX_HUD_* counterparts, including empty values. Saved display
settings retain priority; NO_COLOR still disables color.
`;

/** A source-qualified observation root, not a caller credential. */
export function displayTarget(harness: Harness, session: string, source: string) {
  if (!['claude', 'pi', 'codex'].includes(harness) || !source || source.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(source) || !isAbsolute(source) || resolve(source) !== source)
    throw new Error('panel_target_invalid');
  const sourceId = makeSourceId(harness, source);
  const root = formatRosterRoot(parseRosterRoot(`${sourceId}/${session}`));
  return { harness, source, ref: { harness, sourceId, sessionId: session, threadId: null }, root };
}

/** Display selection only. Explicit source is a transcript root, never job authority. */
export function panelSelection(args: readonly string[]): { root: string | null; source?: string; harness?: Harness } {
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
    return { root: displayTarget(harness, session, source).root, source, harness };
  } catch {
    throw new CliError('invalid_arguments');
  }
}

/** Shared CLI validation; no caller identity, routing selection or storage writes. */
export function panelRoot(args: readonly string[]): string | null {
  return panelSelection(args).root;
}

export type PanelOperation = 'open' | 'hide' | 'close' | 'toggle' | 'status';
const panelOperations: readonly string[] = ['open', 'hide', 'close', 'toggle', 'status'];

function requirePanelOwner(env: NodeJS.ProcessEnv): void {
  if (env.HUD_JOB_DIR !== undefined) throw new CliError('panel_worker_forbidden');
}

/** Herdr owns the dock lifetime; never infer a failed toggle or retry it. */
export async function controlPanelDock(operation: PanelOperation, env: NodeJS.ProcessEnv, launch: {
  node: string;
  release: string;
  cwd: string;
  selection: readonly string[];
  width?: number;
  sidebar?: SidebarDestination;
  isCurrent?: () => boolean;
}): Promise<'opened' | 'shown' | 'hidden' | 'closed'> {
  requirePanelOwner(env);
  if (!herdrEndpoint(env) || !(await hasHerdrDock(env))) throw new CliError('panel_dock_unavailable', 1);
  if (launch.isCurrent && !launch.isCurrent()) throw new CliError('stale_context');
  let params: Record<string, unknown> = {};
  if (operation === 'open' || operation === 'toggle') {
    panelSelection(launch.selection);
    let settings = defaultSettings();
    try { settings = loadSettings(env); } catch { /* The panel can open Settings to repair a broken file. */ }
    const settingsFile = resolve(settingsPath(env));
    const hintedWidth = Number(resolveHudEnv(env, 'HUD_TREE_WIDTH'));
    const treeWidth = !existsSync(settingsFile) && Number.isInteger(hintedWidth) && hintedWidth >= 16 && hintedWidth <= 200
      ? hintedWidth : settings.treeWidth;
    // Only forward display configuration, not the caller's credentials or control environment.
    const dockEnv: Record<string, string> = { HUD_HOME: getHudHome(env), HUD_SETTINGS_PATH: settingsFile,
      HUD_DOCK_CALLER_PANE: env.HERDR_PANE_ID ?? '' };
    if (launch.sidebar) dockEnv.HUD_SIDEBAR_TARGET = JSON.stringify(launch.sidebar);
    for (const key of ['HUD_THEME', 'HUD_ICONS', 'HUD_BAR_STYLE', 'HUD_BAR_FIELDS', 'HUD_TREE_WIDTH'] as const) {
      const value = resolveHudEnv(env, key);
      if (value !== undefined) dockEnv[key] = value;
    }
    for (const key of ['NO_COLOR', 'HUD_HEAP_CAPS', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'EDITOR']) {
      const value = env[key];
      if (value !== undefined) dockEnv[key] = value;
    }
    params = {
      executable: launch.node, argv: [join(launch.release, 'bin/hud'), 'panel', '--here', ...launch.selection],
      cwd: launch.cwd, env: dockEnv, mode: settings.dockMode, side: settings.dockSide,
      width: Math.min(65535, launch.width ?? (treeWidth || DEFAULT_WIDTH)),
      height: settings.dockHeight || DEFAULT_HEIGHT,
      ...(launch.sidebar && { focus: true }),
    };
  }
  const reply = await herdrRequest(`dock.${operation}`, params, { env });
  const result = reply?.result;
  if (reply?.error || result?.type !== 'dock' || typeof result.shown !== 'boolean')
    throw new CliError(reply?.error?.code ?? 'panel_dock_request_failed', 1);
  if (result.shown) return result.action === 'opened' ? 'opened' : 'shown';
  return result.hidden ? 'hidden' : 'closed';
}

/** Use the dock or run the installed panel entry in the foreground. */
export async function panelCommand(io: HudIO, args: readonly string[] = []): Promise<number> {
  requirePanelOwner(io.env);
  if (args.length === 1 && args[0] === '--help') {
    await io.stdout(PANEL_HELP);
    return 0;
  }
  const rest = [...args];
  const op = panelOperations.includes(rest[0] ?? '') ? rest.shift() as PanelOperation : undefined;
  const at = rest.indexOf('--width');
  let width: number | undefined;
  if (at >= 0) {
    if (!/^[1-9]\d*$/.test(rest[at + 1] ?? '')) throw new CliError('invalid_arguments');
    width = Number(rest[at + 1]);
    rest.splice(at, 2);
  }
  const here = rest[0] === '--here';
  const query = op === 'hide' || op === 'close' || op === 'status';
  if ((op && here) || (query && args.length !== 1)) throw new CliError('invalid_arguments');
  const selection = here ? rest.slice(1) : rest;
  const bound = query || selection.length ? undefined : await callerSession(io.env);
  const selected = bound ? ['--harness', bound.harness, '--session', bound.session, '--source', bound.source] : selection;
  if (!here && (query || io.env.HERDR_SOCKET_PATH || io.env.HERDR_PANE_ID || io.env.HERDR_DOCK === '1')) {
    const state = await controlPanelDock(op ?? 'toggle', io.env, {
      node: process.execPath, release: installationRoot(), cwd: process.cwd(), selection: selected, width,
    });
    await io.stdout(`HUD panel ${state}\n`);
    return 0;
  }
  const { root, source, harness } = panelSelection(selected);
  return foreground(
    { argv: [process.execPath, ...v8HeapArgs('panel', io.env), join(installationRoot(), 'bin/hud-dist.mjs'), 'panel'] },
    {
      ...io.env,
      HUD_SETTINGS_PATH: settingsPath(io.env),
      ...(harness === 'codex' && source ? { CODEX_HOME: source } : {}),
      ...(root ? { CODEX_HUD_PANEL_ROOT: root } : {}),
      CODEX_HUD_PANEL_SOURCE: source ?? '',
      CODEX_HUD_PANEL_HARNESS: harness ?? '',
    },
    { replace: true }
  );
}
