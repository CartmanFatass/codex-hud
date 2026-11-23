import type { DecisionProviderId } from './jev/decide.js';
import { readHudConfig, resolveDecisions, readHudCredentials } from './jev/ask/config.js';
import { resolveHudEnv } from './utils/hud-env.js';
import * as path from 'node:path';
import { readFileBounded, writePrivateFile } from './utils/atomic-fs.js';
import {
  BAR_FIELDS,
  BAR_STYLES,
  DEFAULT_BAR_FIELDS,
  THEMES,
  type HudDisplayConfig,
  type IconMode,
} from './render/hud-config.js';
import { getHudHome } from './hud-home.js';
import { SHIPPED_MODELS_CATALOG } from './models/catalog.js';
import { DEFAULT_WIDTH } from './utils/pane-width.js';

export interface HudSettings extends Omit<HudDisplayConfig, 'density' | 'glyphs' | 'motion' | 'context' | 'look'> {
  statusline: boolean;
  mouse: boolean;
  tasks: boolean;
  details: boolean;
  refreshMs: number;
  treeWidth: number;
  worktreeRoot: string;
  modelEnabled: boolean;
  /** How Home and Project are laid out (owner, 2026-11-17): the layouts being tried, one of which stays. */
  panelLayout: 'classic' | 'split';
  acceptance: 'task' | 'slice';
  experiments: boolean;
  /** Draft-only; persisted solely as config.json decisions.primary. */
  decisionApi: DecisionProviderId;
  sonicAutoThinking: boolean;
  impRouting: boolean;
  /** The tree panel's and the brief's language; auto follows the locale. */
  language: 'auto' | 'en' | 'zh';
  /** `api` brief: the endpoint's base URL, up to `/v1`; empty is Mistral's. */
  briefingApiBase: string;
  model: string;
  /** Display-only inactivity threshold, never an execution deadline. */
  cardStallMinutes: number;
  /** A settled job or native agent folds to one Home row after this many minutes, and leaves Home (show-all keeps it) after the hide time. */
  cardFoldMinutes: number;
  cardHideMinutes: number;
  /** Model calls allowed per hour, over every feature; past it requests are refused with a reason. */
  modelCallsPerHour: number;
  decisionCallsPerHour: number;
  summaryIntervalMinutes: number;
  /** Notifications in tmux on approvals, failures and finished agents. CODEX_HUD_NOTIFY, when set, wins. */
  notify: boolean;
  /** Also notify outside the terminal. CODEX_HUD_NOTIFY_DESKTOP, when set, wins. */
  notifyDesktop: boolean;
  /** Nerd Font glyphs (the default), Unicode marks or their ASCII/text equivalents. An old or unknown value loads as the default. */
  icons: IconMode;
  /** Per-role soft caps on concurrently working jobs; 0 or omitted means uncapped. */
  roleCaps: Record<string, number>;
  /** Start an imp create as general when imp is at its cap and general has a free slot. */
  impOverflow: boolean;
}

export const DEFAULT_ROLE_CAPS: Readonly<Record<string, number>> = Object.freeze({ imp: 3, general: 3 });

/** Display defaults shared by settings and the pure panel initializer. */
export const DEFAULT_PANEL_VIEW = {
  panelLayout: 'classic', acceptance: 'task', experiments: false,
  cardStallMinutes: 10, cardFoldMinutes: 5, cardHideMinutes: 5,
} as const;

/** Built-in defaults; callers apply environment or runtime display overrides. */
export function defaultSettings(): HudSettings {
  return {
    theme: 'terminal',
    barStyle: 'line',
    barFields: [...DEFAULT_BAR_FIELDS],
    statusline: true,
    mouse: true,
    tasks: false,
    details: true,
    refreshMs: 1000,
    treeWidth: DEFAULT_WIDTH,
    worktreeRoot: '',
    modelEnabled: (() => {
      try {
        const c = readHudCredentials();
        return !!(c.mistralApiKey?.trim() || c.openaiApiKey?.trim() || c.geminiApiKey?.trim());
      } catch {
        return false;
      }
    })(),
    ...DEFAULT_PANEL_VIEW,
    language: 'auto',
    briefingApiBase: SHIPPED_MODELS_CATALOG.defaults.summary.apiBase,
    model: SHIPPED_MODELS_CATALOG.defaults.summary.model,
    decisionApi: 'openai',
    sonicAutoThinking: false,
    impRouting: false,
    modelCallsPerHour: 60,
    decisionCallsPerHour: 0,
    summaryIntervalMinutes: 5,
    notify: false,
    notifyDesktop: false,
    icons: 'nerd',
    roleCaps: { ...DEFAULT_ROLE_CAPS },
    impOverflow: true,
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
  theme: oneOf(...THEMES),
  barStyle: oneOf(...BAR_STYLES),
  barFields: (value) =>
    Array.isArray(value) && value.every((field) => (BAR_FIELDS as readonly unknown[]).includes(field)),
  mouse: isBoolean,
  tasks: isBoolean,
  details: isBoolean,
  refreshMs: (value) => isIntegerBetween(value, 100, 60_000),
  treeWidth: (value) => value === 0 || isIntegerBetween(value, 16, 200),
  worktreeRoot: (value) => typeof value === 'string' && value.length <= 4096 && !value.includes('\0'),
  modelEnabled: isBoolean,
  panelLayout: oneOf('classic', 'split'),
  acceptance: oneOf('task', 'slice'),
  experiments: isBoolean,
  decisionApi: oneOf('gemini', 'openai', 'typesafe'),
  sonicAutoThinking: isBoolean,
  impRouting: isBoolean,
  language: oneOf('auto', 'en', 'zh'),
  briefingApiBase: (value) => isText(2048)(value) && (value === '' || /^https?:\/\/\S+$/.test(value as string)),
  model: isText(200),
  cardStallMinutes: (value) => isIntegerBetween(value, 1, 120),
  cardFoldMinutes: (value) => isIntegerBetween(value, 1, 1440),
  cardHideMinutes: (value) => isIntegerBetween(value, 1, 1440),
  notify: isBoolean,
  notifyDesktop: isBoolean,
  modelCallsPerHour: (value) => isIntegerBetween(value, 0, 1000),
  decisionCallsPerHour: (value) => isIntegerBetween(value, 0, 2000),
  summaryIntervalMinutes: (value) => isIntegerBetween(value, 1, 120),
  icons: oneOf('nerd', 'unicode', 'text'),
  roleCaps: (value) =>
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value as Record<string, unknown>).length <= 32 &&
    Object.entries(value as Record<string, unknown>).every(
      ([role, cap]) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(role) && isIntegerBetween(cap, 0, 100)
    ),
  impOverflow: isBoolean,
};

function mergeValidated(base: HudSettings, raw: unknown): HudSettings {
  const result: HudSettings = { ...base, roleCaps: { ...base.roleCaps } };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  const values = raw as Record<string, unknown>;
  for (const key of Object.keys(validators) as Array<keyof HudSettings>) {
    if (Object.hasOwn(values, key) && validators[key](values[key])) {
      if (key === 'roleCaps') {
        result.roleCaps = { ...base.roleCaps, ...(values.roleCaps as Record<string, number>) };
      } else {
        Object.assign(result, { [key]: values[key] });
      }
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
      .filter(([key, valid]) => key !== 'decisionApi' && Object.hasOwn(values, key) && valid(values[key]))
      .map(([key]) => [key, values[key]])
  );
}

export function settingsPath(env = process.env): string {
  return resolveHudEnv(env, 'HUD_SETTINGS_PATH') || path.join(getHudHome(env), 'hud-settings.json');
}

function readSettings(file: string): HudSettings {
  try {
    const { bytes, truncated } = readFileBounded(file, MAX_SETTINGS_BYTES, { followSymlinks: true });
    if (truncated) throw new Error('HUD settings file is too large (maximum 64 KiB).');
    return mergeValidated(defaultSettings(), JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultSettings();
    throw error;
  }
}

export const experimentsEnabled = (env = process.env): boolean => readSettings(settingsPath(env)).experiments;

function decisionApi(env = process.env): DecisionProviderId {
  try { return resolveDecisions(readHudConfig(path.join(getHudHome(env), 'config.json'))).primary; }
  catch { return 'openai'; }
}
/** Missing files use defaults. Malformed preference JSON and I/O failures belong to the caller. */
export function loadSettings(env = process.env): HudSettings {
  return { ...readSettings(settingsPath(env)), decisionApi: decisionApi(env) };
}

/** Validate a patch against existing preferences and atomically replace the file. */
export function saveSettings(patch: Partial<HudSettings>): HudSettings {
  const file = settingsPath();
  let current: HudSettings;
  try { current = loadSettings(); } catch { current = { ...defaultSettings(), decisionApi: decisionApi() }; }
  const settings = mergeValidated(current, patch);
  if (settings.decisionApi !== current.decisionApi) {
    const configFile = path.join(getHudHome(), 'config.json'), root = readHudConfig(configFile);
    root.decisions = { ...(root.decisions as object ?? {}), primary: settings.decisionApi };
    writePrivateFile(configFile, JSON.stringify(root, null, 2) + '\n');
  }
  writePrivateFile(file, JSON.stringify(settings, (key, value) => key === 'decisionApi' ? undefined : value, 2) + '\n');
  return settings;
}
