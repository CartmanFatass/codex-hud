import { readHudCredentials } from './jev/ask/config.js';
import { resolveHudEnv } from './utils/hud-env.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BAR_FIELDS,
  BAR_STYLES,
  DEFAULT_BAR_FIELDS,
  LOOKS,
  type HudDisplayConfig,
  type IconMode,
} from './render/hud-config.js';
import { getHudHome } from './hud-home.js';
import { defaultCardVisibility, type CardVisibility } from './card-visibility.js';
import { PREFIX_KEYS, type PrefixKey } from './utils/panel-command.js';

/** The prefix before Ctrl+\ was the default, kept by settings files saved without one. */
export const LEGACY_PREFIX_KEY: PrefixKey = 'C-]';

export interface HudSettings extends HudDisplayConfig, CardVisibility {
  statusline: boolean;
  sort: 'active' | 'created';
  mouse: boolean;
  tasks: boolean;
  details: boolean;
  refreshMs: number;
  treeWidth: number;
  /**
   * How long a finished agent stays in the tree's default view, in ms. 0
   * keeps every agent; the panel can still reveal hidden ones on demand.
   */
  finishedLingerMs: number;
  // Monitor visibility is independent of legacy boolean panel preferences.
  agentsPane: 'open' | 'closed';
  changesPane: 'open' | 'closed';
  detailsPane: 'open' | 'closed';
  /**
   * The roles of the agents an L1 starts (`reviewer`, `critic`) that the
   * saved important-scope summary policy includes, a comma list; a name
   * also matches a role ending in it after a dash (`critic`, a
   * `team-platform-critic`). The rest are counts on their L1's line and
   * card; a failed or flagged one always gets its line.
   */
  importantRoles: string;
  /**
   * How the panel shows the agents: `rich`, a card per agent with the recap
   * as a card above them; `compact`, the tree with the brief and log under it.
   */
  panelStyle: 'rich' | 'compact';
  worktreeRoot: string;
  modelEnabled: boolean;
  /** The tree panel's and the brief's language; auto follows the locale. */
  language: 'auto' | 'en' | 'zh';
  /** `api` brief: the endpoint's base URL, up to `/v1`; empty is Mistral's. */
  briefingApiBase: string;
  model: string;
  /** Show each agent's log under the tree even with the model backend off (observed entries only). */
  agentLog: boolean;
  /** The cards' corners: square (`┌ └`) or round (`╭ ╰`). */
  cardCorners: 'square' | 'round';
  /** Display-only inactivity threshold, never an execution deadline. */
  cardStallMinutes: number;
  /**
   * How much the status card at the foot of the panel shows: `min`, its top
   * edge alone, the session's state on it; `status`, the bar's fields;
   * `full`, those and the main session's brief under them (rich only:
   * compact shows the brief above).
   */
  statusCard: 'min' | 'status' | 'full';
  /** Model calls allowed per hour, over every feature; past it requests are refused with a reason. */
  modelCallsPerHour: number;
  /** Notifications in tmux on approvals, failures and finished agents. CODEX_HUD_NOTIFY, when set, wins. */
  notify: boolean;
  /** Also notify outside the terminal. CODEX_HUD_NOTIFY_DESKTOP, when set, wins. */
  notifyDesktop: boolean;
  /** A picture drawn in text in the panel's empty space, and its style. */
  art: 'off' | 'dots' | 'color' | 'ascii';
  /** The picture: any image ffmpeg can read. `codex-hud-art <image>` sets it. */
  artImage: string;
  /**
   * The tmux key in front of every panel command (`Ctrl+\` then `,` opens
   * settings; `Ctrl+]` for files saved before it was the default). Only keys checked against Codex's own bindings are offered;
   * see PREFIX_KEYS. bin/codex-hud-keys installs it.
   */
  prefixKey: PrefixKey;
  /**
   * The control bar's buttons and the panes' titles: Unicode icons
   * (`unicode`, the default), Nerd Font icons (`nerd`, for a terminal with
   * one), emoji for the panes (`emoji`), each beside its word where it fits,
   * or the words alone (`text`), there and wherever else a mark could stand
   * for a word. The model badge has its own setting, `glyphs`.
   */
  icons: IconMode;
}

/** Built-in defaults; callers apply environment or runtime display overrides. */
export function defaultSettings(): HudSettings {
  return {
    ...defaultCardVisibility(),
    density: 'balanced',
    theme: 'terminal',
    glyphs: 'both',
    motion: 'full',
    context: 'used',
    barStyle: 'line',
    barFields: [...DEFAULT_BAR_FIELDS],
    agentColors: 'name',
    look: 'tab',
    statusline: true,
    sort: 'active',
    mouse: true,
    tasks: false,
    details: true,
    refreshMs: 1000,
    treeWidth: 48,
    finishedLingerMs: 180_000,
    agentsPane: 'open',
    changesPane: 'closed',
    detailsPane: 'closed',
    panelStyle: 'rich',
    importantRoles: '',
    worktreeRoot: '',
    modelEnabled: (() => {
      try {
        const c = readHudCredentials();
        return !!(c.mistralApiKey?.trim() || c.openaiApiKey?.trim());
      } catch {
        return false;
      }
    })(),
    language: 'auto',
    briefingApiBase: 'https://api.mistral.ai/v1',
    model: 'deepseek-v4-1-flash-1017',
    statusCard: 'full',
    modelCallsPerHour: 60,
    agentLog: false,
    cardCorners: 'square',
    cardStallMinutes: 10,
    notify: false,
    notifyDesktop: false,
    art: 'off',
    artImage: '',
    prefixKey: 'C-\\',
    icons: 'unicode',
  };
}

const MAX_SETTINGS_BYTES = 65_536;
const isBoolean = (value: unknown): boolean => typeof value === 'boolean';
const isIntegerBetween = (value: unknown, min: number, max: number): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const oneOf =
  (...allowed: string[]) =>
  (value: unknown): boolean =>
    typeof value === 'string' && allowed.includes(value);

const isText =
  (max: number) =>
  (value: unknown): boolean =>
    typeof value === 'string' && value.length <= max && !/[\0\r\n]/.test(value);

const validators: Record<keyof HudSettings, (value: unknown) => boolean> = {
  statusline: isBoolean,
  density: oneOf('focus', 'balanced', 'full'),
  theme: oneOf('terminal', 'mocha', 'latte', 'titanium', 'none'),
  glyphs: oneOf('glyph', 'text', 'both'),
  motion: oneOf('full', 'reduced'),
  context: oneOf('used', 'remaining'),
  barStyle: oneOf(...BAR_STYLES),
  barFields: (value) =>
    Array.isArray(value) && value.every((field) => (BAR_FIELDS as readonly unknown[]).includes(field)),
  agentColors: oneOf('name', 'mark', 'off'),
  sort: oneOf('active', 'created'),
  mouse: isBoolean,
  tasks: isBoolean,
  details: isBoolean,
  refreshMs: (value) => isIntegerBetween(value, 100, 60_000),
  treeWidth: (value) => value === 0 || isIntegerBetween(value, 16, 200),
  finishedLingerMs: (value) => value === 0 || isIntegerBetween(value, 10_000, 86_400_000),
  agentsPane: oneOf('open', 'closed'),
  changesPane: oneOf('open', 'closed'),
  detailsPane: oneOf('open', 'closed'),
  importantRoles: isText(1000),
  panelStyle: oneOf('rich', 'compact'),
  look: oneOf(...LOOKS),
  worktreeRoot: (value) => typeof value === 'string' && value.length <= 4096 && !value.includes('\0'),
  modelEnabled: isBoolean,
  language: oneOf('auto', 'en', 'zh'),
  briefingApiBase: (value) => isText(2048)(value) && (value === '' || /^https?:\/\/\S+$/.test(value as string)),
  model: isText(200),
  statusCard: oneOf('min', 'status', 'full'),
  agentLog: isBoolean,
  cardCorners: oneOf('square', 'round'),
  cardStallMinutes: (value) => isIntegerBetween(value, 1, 120),
  cardRoleCounts: isBoolean,
  cardLabel: isBoolean,
  cardOriginalName: isBoolean,
  cardSummary: isBoolean,
  cardRelations: isBoolean,
  cardAction: isBoolean,
  cardSubagents: isBoolean,
  cardSubagentSummary: isBoolean,
  cardSubagentScope: oneOf('live', 'important', 'all'),
  cardModel: isBoolean,
  cardReviews: isBoolean,
  cardClock: isBoolean,
  cardRate: isBoolean,
  cardContext: isBoolean,
  notify: isBoolean,
  notifyDesktop: isBoolean,
  modelCallsPerHour: (value) => isIntegerBetween(value, 1, 1000),
  art: oneOf('off', 'dots', 'color', 'ascii'),
  artImage: isText(4096),
  prefixKey: oneOf(...PREFIX_KEYS),
  icons: oneOf('unicode', 'nerd', 'emoji', 'text'),
};

const PANE_KEYS = ['agentsPane', 'changesPane', 'detailsPane'] as const;

function mergeValidated(base: HudSettings, raw: unknown): HudSettings {
  const result = { ...base };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  const values = { ...(raw as Record<string, unknown>) };
  // A pane is open or closed; one saved folded, as earlier versions could, is closed.
  for (const key of PANE_KEYS) if (values[key] === 'folded') values[key] = 'closed';
  for (const key of Object.keys(validators) as Array<keyof HudSettings>) {
    if (Object.hasOwn(values, key) && validators[key](values[key])) {
      Object.assign(result, { [key]: values[key] });
    }
  }
  return result;
}

/** Known validated keys only; removed/unknown legacy fields never enter an import. */
export function importableSettings(raw: unknown): Partial<HudSettings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_settings');
  const values = raw as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(validators)
      .filter(([key, valid]) => Object.hasOwn(values, key) && valid(values[key]))
      .map(([key]) => [key, values[key]])
  );
}

export function settingsPath(): string {
  return resolveHudEnv(process.env, 'HUD_SETTINGS_PATH') || path.join(getHudHome(), 'hud-settings.json');
}

function readSettings(file: string): HudSettings {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultSettings();
    throw error;
  }
  try {
    const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_SETTINGS_BYTES) throw new Error('HUD settings file is too large (maximum 64 KiB).');
    const raw: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    // Ctrl+\ became the default prefix when Codex 0.160 took Ctrl+] for Skip
    // Question. A settings file saved before that, with no prefix of its own,
    // keeps the Ctrl+] its owner has been using: only a fresh install moves.
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && !Object.hasOwn(raw, 'prefixKey')) {
      return mergeValidated(defaultSettings(), { ...(raw as Record<string, unknown>), prefixKey: LEGACY_PREFIX_KEY });
    }
    return mergeValidated(defaultSettings(), raw);
  } finally {
    fs.closeSync(fd);
  }
}

/** Missing files use defaults. Malformed JSON and I/O failures belong to the caller. */
export function loadSettings(): HudSettings {
  return readSettings(settingsPath());
}

/** Validate a patch against existing preferences and atomically replace the file. */
export function saveSettings(patch: Partial<HudSettings>): HudSettings {
  const file = settingsPath();
  const settings = mergeValidated(readSettings(file), patch);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* Renamed successfully, or cleanup failed after the original error. */
    }
  }
  return settings;
}
