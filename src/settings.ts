import type { DecisionProviderId } from './jev/decide.js';
import { readHudConfig, resolveDecisions, readHudCredentials } from './jev/ask/config.js';
import { resolveHudEnv } from './utils/hud-env.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BAR_FIELDS,
  BAR_STYLES,
  DEFAULT_BAR_FIELDS,
  type HudDisplayConfig,
  type IconMode,
} from './render/hud-config.js';
import { getHudHome } from './hud-home.js';
import { PREFIX_KEYS, type PrefixKey } from './utils/panel-command.js';

/** The prefix before Ctrl+\ was the default, kept by settings files saved without one. */
export const LEGACY_PREFIX_KEY: PrefixKey = 'C-]';

export interface HudSettings extends Omit<HudDisplayConfig, 'density' | 'glyphs' | 'motion' | 'context' | 'look'> {
  statusline: boolean;
  mouse: boolean;
  tasks: boolean;
  details: boolean;
  refreshMs: number;
  treeWidth: number;
  // Monitor visibility is independent of legacy boolean panel preferences.
  changesPane: 'open' | 'closed';
  detailsPane: 'open' | 'closed';
  worktreeRoot: string;
  modelEnabled: boolean;
  /** Draft-only; persisted solely as config.json decisions.primary. */
  decisionApi: DecisionProviderId;
  /** The tree panel's and the brief's language; auto follows the locale. */
  language: 'auto' | 'en' | 'zh';
  /** `api` brief: the endpoint's base URL, up to `/v1`; empty is Mistral's. */
  briefingApiBase: string;
  model: string;
  /** Display-only inactivity threshold, never an execution deadline. */
  cardStallMinutes: number;
  /** Model calls allowed per hour, over every feature; past it requests are refused with a reason. */
  modelCallsPerHour: number;
  /** Notifications in tmux on approvals, failures and finished agents. CODEX_HUD_NOTIFY, when set, wins. */
  notify: boolean;
  /** Also notify outside the terminal. CODEX_HUD_NOTIFY_DESKTOP, when set, wins. */
  notifyDesktop: boolean;
  /**
   * The tmux key in front of every panel command (`Ctrl+\` then `,` opens
   * settings; `Ctrl+]` for files saved before it was the default). Only keys checked against Codex's own bindings are offered;
   * see PREFIX_KEYS. bin/codex-hud-keys installs it.
   */
  prefixKey: PrefixKey;
  /** Unicode marks or their ASCII/text equivalents. Old icon sets load as unicode. */
  icons: IconMode;
}

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
    treeWidth: 48,
    changesPane: 'closed',
    detailsPane: 'closed',
    worktreeRoot: '',
    modelEnabled: (() => {
      try {
        const c = readHudCredentials();
        return !!(c.mistralApiKey?.trim() || c.openaiApiKey?.trim() || c.geminiApiKey?.trim());
      } catch {
        return false;
      }
    })(),
    language: 'auto',
    briefingApiBase: 'https://api.mistral.ai/v1',
    model: 'deepseek-v4-1-flash-1017',
    decisionApi: 'openai',
    modelCallsPerHour: 60,
    cardStallMinutes: 10,
    notify: false,
    notifyDesktop: false,
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
  theme: oneOf('terminal', 'mocha', 'latte', 'titanium', 'none'),
  barStyle: oneOf(...BAR_STYLES),
  barFields: (value) =>
    Array.isArray(value) && value.every((field) => (BAR_FIELDS as readonly unknown[]).includes(field)),
  mouse: isBoolean,
  tasks: isBoolean,
  details: isBoolean,
  refreshMs: (value) => isIntegerBetween(value, 100, 60_000),
  treeWidth: (value) => value === 0 || isIntegerBetween(value, 16, 200),
  changesPane: oneOf('open', 'closed'),
  detailsPane: oneOf('open', 'closed'),
  worktreeRoot: (value) => typeof value === 'string' && value.length <= 4096 && !value.includes('\0'),
  modelEnabled: isBoolean,
  decisionApi: oneOf('gemini', 'openai', 'typesafe'),
  language: oneOf('auto', 'en', 'zh'),
  briefingApiBase: (value) => isText(2048)(value) && (value === '' || /^https?:\/\/\S+$/.test(value as string)),
  model: isText(200),
  cardStallMinutes: (value) => isIntegerBetween(value, 1, 120),
  notify: isBoolean,
  notifyDesktop: isBoolean,
  modelCallsPerHour: (value) => isIntegerBetween(value, 1, 1000),
  prefixKey: oneOf(...PREFIX_KEYS),
  icons: oneOf('unicode', 'text'),
};

const PANE_KEYS = ['changesPane', 'detailsPane'] as const;

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
      .filter(([key, valid]) => key !== 'decisionApi' && Object.hasOwn(values, key) && valid(values[key]))
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
  return { ...readSettings(settingsPath()), decisionApi: resolveDecisions(readHudConfig(path.join(getHudHome(), 'config.json'))).primary };
}

/** Validate a patch against existing preferences and atomically replace the file. */
export function saveSettings(patch: Partial<HudSettings>): HudSettings {
  const file = settingsPath();
  const settings = mergeValidated(loadSettings(), patch);
  if (patch.decisionApi !== undefined && validators.decisionApi(patch.decisionApi)) {
    const configFile = path.join(getHudHome(), 'config.json'), root = readHudConfig(configFile);
    root.decisions = { ...(root.decisions as object ?? {}), primary: settings.decisionApi };
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const temp = `${configFile}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(root, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, configFile); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(settings, (key, value) => key === 'decisionApi' ? undefined : value, 2)}\n`, { flag: 'wx', mode: 0o600 });
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
