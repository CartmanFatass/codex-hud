import type { DecisionProviderId } from './jev/decide.js';
import { readHudConfig, resolveDecisions } from './jev/ask/config.js';
import { resolveHudEnv } from './utils/hud-env.js';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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
import { DEFAULT_WIDTH } from './utils/pane-width.js';
import type { DockMode } from './runtime/herdr-socket.js';

export interface HudSettings extends Omit<HudDisplayConfig, 'density' | 'glyphs' | 'motion' | 'context' | 'look'> {
  statusline: boolean;
  claudePaneStrip: boolean;
  piPaneStrip: boolean;
  agyPaneStrip: boolean;
  mouse: boolean;
  details: boolean;
  refreshMs: number;
  treeWidth: number;
  dockMode: DockMode;
  worktreeRoot: string;
  /** Draft-only; persisted solely as config.json decisions.primary. */
  decisionApi: DecisionProviderId;
  quietJobDecision: boolean;
  sonicAutoThinking: boolean;
  autoPrewalk: boolean;
  poolPick: boolean;
  /** Recommend skills and check owner rules in main sessions (shown only, never injected). */
  advisorShadow: boolean;
  /** Absolute directories scanned for SKILL.md files when advisorShadow is on. */
  advisorSkillDirs: string[];
  /** Absolute Markdown rules file, or empty to disable rule checks. */
  advisorRulesFile: string;
  impPlacement: 'fixed' | 'even' | 'auto';
  impEvenPool: string[];
  sonicPlacement: 'fixed' | 'even';
  sonicEvenPool: string[];
  /** Panel UI language; auto follows the locale. */
  language: 'auto' | 'en' | 'zh';
  decisionCallsPerHour: number;
  /** Notifications in tmux on approvals and failures. CODEX_HUD_NOTIFY, when set, wins. */
  notify: boolean;
  /** Also notify outside the terminal. CODEX_HUD_NOTIFY_DESKTOP, when set, wins. */
  notifyDesktop: boolean;
  openPreviews: boolean;
  /** Nerd Font glyphs (the default), Unicode marks or their ASCII/text equivalents. An old or unknown value loads as the default. */
  icons: IconMode;
  /** Per-role soft caps on concurrently working jobs; 0 or omitted means uncapped. */
  roleCaps: Record<string, number>;
  /** Start an imp create as general when imp is at its cap and general has a free slot. */
  impOverflow: boolean;
}

export const DEFAULT_ROLE_CAPS: Readonly<Record<string, number>> = Object.freeze({ imp: 3, general: 3 });

/** Built-in defaults; callers apply environment or runtime display overrides. */
export function defaultSettings(): HudSettings {
  return {
    theme: 'terminal',
    barStyle: 'line',
    barFields: [...DEFAULT_BAR_FIELDS],
    statusline: true,
    claudePaneStrip: false,
    piPaneStrip: false,
    agyPaneStrip: false,
    mouse: true,
    details: true,
    refreshMs: 1000,
    treeWidth: DEFAULT_WIDTH,
    dockMode: 'overlay',
    worktreeRoot: '',
    language: 'auto',
    decisionApi: 'openai',
    quietJobDecision: true,
    sonicAutoThinking: false,
    autoPrewalk: true,
    poolPick: true,
    advisorShadow: false,
    advisorSkillDirs: [],
    advisorRulesFile: '',
    impPlacement: 'fixed',
    impEvenPool: [],
    sonicPlacement: 'fixed',
    sonicEvenPool: [],
    decisionCallsPerHour: 0,
    notify: false,
    notifyDesktop: false,
    openPreviews: true,
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

const validEvenPool = (value: unknown): boolean =>
  Array.isArray(value) && value.every((name) => typeof name === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(name));

const validators: Record<keyof HudSettings, (value: unknown) => boolean> = {
  statusline: isBoolean,
  claudePaneStrip: isBoolean,
  piPaneStrip: isBoolean,
  agyPaneStrip: isBoolean,
  theme: oneOf(...THEMES),
  barStyle: oneOf(...BAR_STYLES),
  barFields: (value) =>
    Array.isArray(value) && value.every((field) => (BAR_FIELDS as readonly unknown[]).includes(field)),
  mouse: isBoolean,
  details: isBoolean,
  refreshMs: (value) => isIntegerBetween(value, 100, 60_000),
  treeWidth: (value) => value === 0 || isIntegerBetween(value, 16, 200),
  dockMode: oneOf('overlay', 'push'),
  worktreeRoot: (value) => typeof value === 'string' && value.length <= 4096 && !value.includes('\0'),
  decisionApi: oneOf('gemini', 'openai', 'anthropic', 'typesafe'),
  quietJobDecision: isBoolean,
  sonicAutoThinking: isBoolean,
  autoPrewalk: isBoolean,
  poolPick: isBoolean,
  advisorShadow: isBoolean,
  advisorSkillDirs: (value) =>
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every((dir) => typeof dir === 'string' && dir.length > 0 && dir.length <= 4096 && !dir.includes('\0') && path.isAbsolute(dir)),
  advisorRulesFile: (value) =>
    typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && (value === '' || path.isAbsolute(value)),
  impPlacement: oneOf('fixed', 'even', 'auto'),
  impEvenPool: validEvenPool,
  sonicPlacement: oneOf('fixed', 'even'),
  sonicEvenPool: validEvenPool,
  language: oneOf('auto', 'en', 'zh'),
  notify: isBoolean,
  notifyDesktop: isBoolean,
  openPreviews: isBoolean,
  decisionCallsPerHour: (value) => isIntegerBetween(value, 0, 2000),
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
  const result: HudSettings = {
    ...base,
    advisorSkillDirs: [...base.advisorSkillDirs],
    roleCaps: { ...base.roleCaps },
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  const values = raw as Record<string, unknown>;
  if (!validators.impPlacement(values.impPlacement) && typeof values.impRouting === 'boolean')
    result.impPlacement = values.impRouting ? 'auto' : 'fixed';
  for (const key of Object.keys(validators) as Array<keyof HudSettings>) {
    if (Object.hasOwn(values, key) && validators[key](values[key])) {
      if (key === 'roleCaps') {
        result.roleCaps = { ...base.roleCaps, ...(values.roleCaps as Record<string, number>) };
      } else if (key === 'advisorSkillDirs') {
        result.advisorSkillDirs = [...(values.advisorSkillDirs as string[])];
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

function readSettings(file: string, absentBase?: Partial<HudSettings>): HudSettings {
  try {
    const { bytes, truncated } = readFileBounded(file, MAX_SETTINGS_BYTES, { followSymlinks: true });
    if (truncated) throw new Error('HUD settings file is too large (maximum 64 KiB).');
    return mergeValidated(defaultSettings(), JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return absentBase ? mergeValidated(defaultSettings(), absentBase) : defaultSettings();
    }
    throw error;
  }
}

function decisionApi(env = process.env): DecisionProviderId {
  try { return resolveDecisions(readHudConfig(path.join(getHudHome(env), 'config.json'))).primary; }
  catch { return 'openai'; }
}
const STRIP_PREFERENCES = { claude: 'claudePaneStrip', pi: 'piPaneStrip', agy: 'agyPaneStrip' } as const;
export type StripClient = keyof typeof STRIP_PREFERENCES;
export function paneStripEnabled(client: StripClient, env = process.env): boolean {
  try { return readSettings(settingsPath(env))[STRIP_PREFERENCES[client]]; }
  catch { return false; }
}

/** Missing files use defaults. Malformed preference JSON and I/O failures belong to the caller. */
export function loadSettings(env = process.env): HudSettings {
  return { ...readSettings(settingsPath(env)), decisionApi: decisionApi(env) };
}

/** Compare a Settings draft with the values it started from, not with the latest file. */
export function settingsPatch(original: HudSettings, draft: HudSettings): Partial<HudSettings> {
  const patch: Partial<HudSettings> = {};
  for (const key of Object.keys(validators) as Array<keyof HudSettings>) {
    if (key === 'roleCaps') {
      // The page edits individual caps; omitted entries are not deletions.
      const changed = Object.entries(draft.roleCaps).filter(([role, cap]) => original.roleCaps[role] !== cap);
      if (changed.length) patch.roleCaps = Object.fromEntries(changed);
    } else if (!isDeepStrictEqual(original[key], draft[key])) {
      Object.assign(patch, { [key]: draft[key] });
    }
  }
  return patch;
}

/** Validate a patch against existing preferences (or absentBase when no file exists) and atomically replace the file. */
export function saveSettings(patch: Partial<HudSettings>, absentBase?: Partial<HudSettings>): HudSettings {
  const file = settingsPath();
  let current: HudSettings;
  try { current = { ...readSettings(file, absentBase), decisionApi: decisionApi() }; }
  catch { current = { ...defaultSettings(), decisionApi: decisionApi() }; }
  const settings = mergeValidated(current, patch);
  if (settings.decisionApi !== current.decisionApi) {
    const configFile = path.join(getHudHome(), 'config.json'), root = readHudConfig(configFile);
    root.decisions = { ...(root.decisions as object ?? {}), primary: settings.decisionApi };
    writePrivateFile(configFile, JSON.stringify(root, null, 2) + '\n');
  }
  writePrivateFile(file, JSON.stringify(settings, (key, value) => key === 'decisionApi' ? undefined : value, 2) + '\n');
  return settings;
}
