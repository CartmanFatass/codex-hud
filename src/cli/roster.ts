/**
 * `hud roster` reads `$HUD_HOME/routing.toml` and the per-session selection.
 * It does not launch, wait, or retry.
 */

import type { HudIO } from './link-export.js';
import { CliError, privateHome } from './runtime.js';
import { liveCallerRoot } from '../roles/caller.js';
import {
  RoutingError,
  assertRoutingId,
  idValue,
  isSlot,
  knownPreset,
  loadRouting,
  loadRosterSelection,
  parseRosterRoot,
  resolveRoster,
  saveRosterSelection,
  formatRosterRoot,
  type ResolvedRoster,
  type RosterRoot,
  type RoutingFile,
  type Slot,
} from '../roles/index.js';

export const ROSTER_LIST_USAGE = 'hud roster list [--json]';
export const ROSTER_SHOW_USAGE = 'hud roster show [--root <id>] [--preset <name>] [--role <slot>] [--json]';
export const ROSTER_USE_USAGE = 'hud roster use <preset> [--root <id>] [--json]';

export const ROSTER_HELP = `Usage: ${ROSTER_LIST_USAGE}
       ${ROSTER_SHOW_USAGE}
       ${ROSTER_USE_USAGE}
       hud roster --help

List routing presets, show the preset a main session will use next, or select
one for that session. --root is <namespace>/<session-id>. When it is omitted,
show and use use the calling Codex, Claude, or Pi session. show then reports
"source: default (no session identity)" if that session cannot be established.
use fails and writes nothing. A selection is stored per session and applies to
later resolutions only. This command does not launch, wait, or retry.

--role <slot> is one of: oracle.propose, oracle.converge, imp, reviewer, sonic, jev.
HUD_HOME defaults to ~/.hud and must be an absolute, private directory owned by this uid.
--json prints one stable JSON document. Failures print one code line on stderr and no JSON.

Exit codes:
  0  Success or help
  1  Unexpected internal or output failure
  2  Invalid arguments or invalid routing
  3  Invalid, missing, inaccessible, or non-private HUD_HOME
`;

function jsonLine(value: unknown): string {
  return JSON.stringify(value) + '\n';
}

function listDocument(routing: RoutingFile): {
  schema: 1;
  default_preset: string;
  presets: { name: string; description: string; jev_decisions: string }[];
} {
  const names = Object.keys(routing.presets).sort();
  return {
    schema: 1,
    default_preset: routing.defaultPreset,
    presets: names.flatMap((name) => {
      const preset = idValue(routing.presets, name);
      return preset ? [{ name, description: preset.description, jev_decisions: preset.jevDecisions }] : [];
    }),
  };
}

function formatList(routing: RoutingFile): string {
  const document = listDocument(routing);
  const lines = [`schema: ${document.schema}`, `default_preset: ${document.default_preset}`];
  for (const preset of document.presets) {
    lines.push(
      `${preset.name} description=${JSON.stringify(preset.description)} jev_decisions=${preset.jev_decisions}`
    );
  }
  return lines.join('\n') + '\n';
}

function formatShow(resolved: {
  preset: string;
  source: string;
  root: string | null;
  jev_decisions: ResolvedRoster['jev_decisions'];
  roles: ResolvedRoster['roles'];
}): string {
  const decision = resolved.jev_decisions;
  const lines = [
    `preset: ${resolved.preset}`,
    `source: ${resolved.source}`,
    `root: ${resolved.root ?? '-'}`,
    `jev_decisions: ${decision.id} ${decision.provider} ${decision.model ?? '-'}`,
  ];
  for (const role of resolved.roles) {
    const backend = role.backend;
    const parts = [role.slot, backend.id, backend.executor];
    if (backend.executor === 'herdr') {
      parts.push(backend.harness ?? '-', backend.model ?? '-');
      if (backend.effort) parts.push(`effort=${backend.effort}`);
      if (backend.recipe) parts.push(`recipe=${backend.recipe}`);
      if (backend.env_profile) parts.push(`env_profile=${backend.env_profile}`);
    } else {
      parts.push(backend.target ?? '-');
      if (backend.mode) parts.push(`mode=${backend.mode}`);
      if (backend.model) parts.push(`model=${backend.model}`);
    }
    if (role.override) parts.push('override');
    lines.push(parts.join(' '));
  }
  return lines.join('\n') + '\n';
}

function formatUse(root: string, preset: string): string {
  return `root: ${root}\npreset: ${preset}\n`;
}

function parseList(args: readonly string[]): { json: boolean } {
  if (args.length === 0) return { json: false };
  if (args.length === 1 && args[0] === '--json') return { json: true };
  throw new CliError('invalid_arguments');
}

function takeValue(args: readonly string[], index: number): string {
  const value = args[index];
  if (value === undefined || value.startsWith('--')) throw new CliError('missing_option_value');
  return value;
}

function parseShow(args: readonly string[]): { json: boolean; root?: string; preset?: string; role?: string } {
  let json = false;
  const seen = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--json') {
      if (seen.has(token)) throw new CliError('invalid_arguments');
      seen.add(token);
      json = true;
      continue;
    }
    if (token === '--root' || token === '--preset' || token === '--role') {
      if (seen.has(token)) throw new CliError('invalid_arguments');
      seen.add(token);
      values.set(token, takeValue(args, ++index));
      continue;
    }
    throw new CliError('invalid_arguments');
  }
  return { json, root: values.get('--root'), preset: values.get('--preset'), role: values.get('--role') };
}

function parseUse(args: readonly string[]): { json: boolean; preset: string; root?: string } {
  let json = false;
  let preset: string | undefined;
  let root: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--json') {
      if (seen.has(token)) throw new CliError('invalid_arguments');
      seen.add(token);
      json = true;
      continue;
    }
    if (token === '--root') {
      if (seen.has(token)) throw new CliError('invalid_arguments');
      seen.add(token);
      root = takeValue(args, ++index);
      continue;
    }
    if (token.startsWith('--')) throw new CliError('invalid_arguments');
    if (preset !== undefined) throw new CliError('invalid_arguments');
    preset = token;
  }
  if (preset === undefined) throw new CliError('invalid_arguments');
  return { json, preset, root };
}

function showDocument(resolved: ResolvedRoster, slot?: Slot) {
  const source =
    resolved.source === 'default' && resolved.root === null ? 'default (no session identity)' : resolved.source;
  return {
    schema: resolved.schema,
    preset: resolved.preset,
    source,
    root: resolved.root,
    jev_decisions: resolved.jev_decisions,
    roles: slot ? resolved.roles.filter((role) => role.slot === slot) : resolved.roles,
  };
}

export interface RosterCallers {
  /** Test seam. Production uses the calling harness session. */
  root?: () => RosterRoot | null;
}

export async function rosterCommand(args: readonly string[], io: HudIO, callers: RosterCallers = {}): Promise<number> {
  try {
    if (args.length === 1 && args[0] === '--help') {
      await io.stdout(ROSTER_HELP);
      return 0;
    }
    const [sub, ...rest] = args;
    if (sub === 'list' && rest.length === 1 && rest[0] === '--help') {
      await io.stdout(`Usage: ${ROSTER_LIST_USAGE}\n`);
      return 0;
    }
    if (sub === 'show' && rest.length === 1 && rest[0] === '--help') {
      await io.stdout(`Usage: ${ROSTER_SHOW_USAGE}\n`);
      return 0;
    }
    if (sub === 'use' && rest.length === 1 && rest[0] === '--help') {
      await io.stdout(`Usage: ${ROSTER_USE_USAGE}\n`);
      return 0;
    }
    if (sub === 'list') {
      const parsed = parseList(rest);
      const routing = loadRouting(privateHome(io.env));
      await io.stdout(parsed.json ? jsonLine(listDocument(routing)) : formatList(routing));
      return 0;
    }
    if (sub === 'show') {
      const parsed = parseShow(rest);
      const slot = parsed.role === undefined ? undefined : isSlot(parsed.role) ? parsed.role : null;
      if (slot === null) throw new RoutingError('invalid_value', 'role');
      if (parsed.preset !== undefined) assertRoutingId(parsed.preset, 'preset');
      const root =
        parsed.root !== undefined
          ? parseRosterRoot(parsed.root)
          : parsed.preset !== undefined
            ? null
            : (callers.root ?? (() => liveCallerRoot(io.env)))();
      const home = privateHome(io.env);
      const routing = loadRouting(home);
      const selection = root && parsed.preset === undefined ? loadRosterSelection(home, root) : null;
      const resolved = resolveRoster(routing, { root, selection, preset: parsed.preset ?? null });
      await io.stdout(parsed.json ? jsonLine(showDocument(resolved, slot)) : formatShow(showDocument(resolved, slot)));
      return 0;
    }
    if (sub === 'use') {
      const parsed = parseUse(rest);
      assertRoutingId(parsed.preset, 'preset');
      const root =
        parsed.root !== undefined ? parseRosterRoot(parsed.root) : (callers.root ?? (() => liveCallerRoot(io.env)))();
      if (!root) throw new RoutingError('session_identity_missing', 'root');
      const home = privateHome(io.env);
      const routing = loadRouting(home);
      knownPreset(routing, parsed.preset, 'preset');
      saveRosterSelection(home, root, parsed.preset);
      const id = formatRosterRoot(root);
      await io.stdout(
        parsed.json ? jsonLine({ schema: 1, root: id, preset: parsed.preset }) : formatUse(id, parsed.preset)
      );
      return 0;
    }
    io.stderr('invalid_command: hud roster --help\n');
    return 2;
  } catch (error) {
    if (error instanceof RoutingError) {
      io.stderr(`${error.code}: ${error.field}\n`);
      return 2;
    }
    throw error;
  }
}
