import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HudDisplayConfig } from './render/hud-config.js';
import { getCodexHome } from './utils/codex-path.js';

export interface HudSettings extends HudDisplayConfig {
  statusline: boolean;
  sort: 'active' | 'created';
  mouse: boolean;
  tasks: boolean;
  changes: boolean;
  activity: boolean;
  details: boolean;
  refreshMs: number;
  treeWidth: number;
  // Monitor visibility is independent of legacy boolean panel preferences.
  agentsPane: 'open' | 'folded' | 'closed';
  worktreesPane: 'open' | 'folded' | 'closed';
  changesPane: 'open' | 'folded' | 'closed';
  detailsPane: 'open' | 'folded' | 'closed';
  worktreeRoot: string;
}

/** Built-in defaults; callers apply environment or runtime display overrides. */
export function defaultSettings(): HudSettings {
  return {
    density: 'balanced', theme: 'terminal', glyphs: 'both', motion: 'full', context: 'used',
    statusline: true, sort: 'active', mouse: true, tasks: false, changes: true, activity: false,
    details: true, refreshMs: 1000, treeWidth: 0,
    agentsPane: 'open', worktreesPane: 'open', changesPane: 'closed', detailsPane: 'closed',
    worktreeRoot: '',
  };
}

const MAX_SETTINGS_BYTES = 65_536;
const isBoolean = (value: unknown): boolean => typeof value === 'boolean';
const isIntegerBetween = (value: unknown, min: number, max: number): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const oneOf = (...allowed: string[]) => (value: unknown): boolean =>
  typeof value === 'string' && allowed.includes(value);

const validators: Record<keyof HudSettings, (value: unknown) => boolean> = {
  statusline: isBoolean,
  density: oneOf('focus', 'balanced', 'full'),
  theme: oneOf('terminal', 'mocha', 'latte', 'none'),
  glyphs: oneOf('glyph', 'text', 'both'),
  motion: oneOf('full', 'reduced'),
  context: oneOf('used', 'remaining'),
  sort: oneOf('active', 'created'),
  mouse: isBoolean, tasks: isBoolean, changes: isBoolean,
  activity: isBoolean, details: isBoolean,
  refreshMs: (value) => isIntegerBetween(value, 100, 60_000),
  treeWidth: (value) => value === 0 || isIntegerBetween(value, 16, 200),
  agentsPane: oneOf('open', 'folded', 'closed'),
  worktreesPane: oneOf('open', 'folded', 'closed'),
  changesPane: oneOf('open', 'folded', 'closed'),
  detailsPane: oneOf('open', 'folded', 'closed'),
  worktreeRoot: value => typeof value === 'string' && value.length <= 4096 && !value.includes('\0'),
};

function mergeValidated(base: HudSettings, raw: unknown): HudSettings {
  const result = { ...base };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  const values = raw as Record<string, unknown>;
  for (const key of Object.keys(validators) as Array<keyof HudSettings>) {
    if (Object.hasOwn(values, key) && validators[key](values[key])) {
      Object.assign(result, { [key]: values[key] });
    }
  }
  return result;
}

export function settingsPath(): string {
  return process.env.CODEX_HUD_SETTINGS_PATH || path.join(getCodexHome(), 'hud-settings.json');
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
    return mergeValidated(defaultSettings(), JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
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
    try { fs.unlinkSync(temporary); } catch { /* Renamed successfully, or cleanup failed after the original error. */ }
  }
  return settings;
}
