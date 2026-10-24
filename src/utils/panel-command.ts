/**
 * The panel's commands, as the tmux prefix table sends them.
 *
 * `prefix` + a key in the session's `codex-hud-prefix` table (installed by
 * bin/codex-hud-keys) runs bin/codex-hud-command, which writes the command to
 * the panel's pane as a private APC string, `ESC _ codex-hud: <name> ESC \`.
 * No terminal sends that as input, so it cannot be mistaken for typing, and
 * it shares the pane's one input stream with typed keys, so it arrives in
 * the order it was pressed. A command is a name, never a key: `r` is the
 * status card's level on the panel but Reset on the settings page, and a
 * name keeps the two apart. Pure.
 */

/** The tag inside the APC string. */
export const PANEL_COMMAND_TAG = 'codex-hud:';

export const PANEL_COMMANDS = [
  'main',
  'brief',
  'older',
  'settings',
  'diagnostics',
  'help',
  'level',
  'pane-1',
  'pane-2',
  'pane-3',
  'pane-4',
  'close-pane',
  'next-pane',
  'previous-pane',
  'zoom',
  'filter',
  'order',
  'quit',
  'switch',
  'inspect',
  'first',
  'last',
  'back',
  'up',
  'down',
  'page-up',
  'page-down',
  'left',
  'right',
] as const;
export type PanelCommand = (typeof PANEL_COMMANDS)[number];

export function isPanelCommand(value: string): value is PanelCommand {
  return (PANEL_COMMANDS as readonly string[]).includes(value);
}

/** The monitor's own name for what each command does (handleMonitorInput's keys). */
const MONITOR_KEYS: Record<PanelCommand, string> = {
  main: 'main',
  brief: 'brief-toggle',
  older: 'show-all',
  settings: 'settings',
  diagnostics: 'diagnostics',
  help: 'help',
  level: 'reset',
  'pane-1': 'agents',
  'pane-2': 'timeline',
  'pane-3': 'changes',
  'pane-4': 'details',
  'close-pane': 'pane-close',
  'next-pane': 'tab',
  'previous-pane': 'shift-tab',
  zoom: 'zoom',
  filter: 'filter',
  order: 'sort',
  quit: 'close',
  switch: 'open-session',
  inspect: 'enter',
  first: 'home',
  last: 'end',
  back: 'escape',
  up: 'up',
  down: 'down',
  'page-up': 'page-up',
  'page-down': 'page-down',
  left: 'left',
  right: 'right',
};
export function monitorKey(command: PanelCommand): string {
  return MONITOR_KEYS[command];
}

/**
 * What an open overlay (the settings page, the help) makes of a command: its
 * own key when the command moves inside it or closes it, or null when the
 * command is for the panel, which then closes the overlay and runs it.
 */
export function overlayKey(command: PanelCommand, overlay: 'settings' | 'help'): string | null {
  switch (command) {
    case 'up':
    case 'down':
    case 'page-up':
    case 'page-down':
    case 'left':
    case 'right':
      return command;
    case 'first':
      return 'home';
    case 'last':
      return 'end';
    case 'back':
    case 'quit':
      return 'escape';
    case 'inspect':
      return 'enter';
    case 'settings':
      return overlay === 'settings' ? 'escape' : null;
    case 'help':
      return overlay === 'help' ? 'escape' : null;
    default:
      return null;
  }
}

/** What runs when the panel is closed: these do nothing, the rest open it first. */
export function needsOpenPanel(command: PanelCommand): boolean {
  return !['quit', 'back', 'up', 'down', 'page-up', 'page-down', 'first', 'last', 'left', 'right'].includes(command);
}

/** The prefix keys the settings offer, checked against Codex's own bindings (see README). */
export const PREFIX_KEYS = ['C-]', 'C-\\'] as const;
export type PrefixKey = (typeof PREFIX_KEYS)[number];

/** A tmux key name as people write it: `C-]` is "Ctrl+]". */
export function prefixName(key: string): string {
  return key.replace(/^C-/, 'Ctrl+').replace(/^M-/, 'Alt+');
}

/** The APC string that carries a command, for tests and for the bash side to agree on. */
export function commandSequence(command: PanelCommand): string {
  return `\x1b_${PANEL_COMMAND_TAG}${command}\x1b\\`;
}
