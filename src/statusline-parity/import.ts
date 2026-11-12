/** Administrative import; never loaded by ordinary statusline rendering. */
import { join, isAbsolute } from 'node:path';
import { getHudHome } from '../hud-home.js';
import { readJson, record, saveJson } from './storage.js';
import { UPSTREAM_DEFAULTS } from './upstream-defaults.js';
import { wrapperJobs } from './wrapper.js';
import { paritySettings, displayKeys, gitKeys, type ParitySettings } from './settings.js';
/** Fails rather than silently losing any explicit unsupported non-default value. */
export function importedSettings(value: unknown): { statusline: ParitySettings; defaultsOutsideSubset: string[] } {
  const v = record(value);
  const ignored: string[] = [];
  const check = (input: Record<string, unknown>, defaults: Record<string, unknown>, prefix = '') => {
    for (const [key, val] of Object.entries(input)) {
      const name = prefix + key;
      const supported =
        (!prefix && ['lineLayout', 'showSeparators'].includes(key)) ||
        (prefix === 'display.' && (displayKeys as readonly string[]).includes(key)) ||
        (prefix === 'gitStatus.' && (gitKeys as readonly string[]).includes(key));
      if (supported) continue;
      if (!prefix && ['display', 'gitStatus'].includes(key)) check(record(val), record(defaults[key]), key + '.');
      else if (Object.hasOwn(defaults, key) && JSON.stringify(val) === JSON.stringify(defaults[key]))
        ignored.push(name);
      else throw new Error(`unsupported_nondefault: ${name}`);
    }
  };
  check(v, UPSTREAM_DEFAULTS);
  return { statusline: paritySettings(v), defaultsOutsideSubset: ignored.sort() };
}
export function importStatusline(args: readonly string[], env: NodeJS.ProcessEnv): object {
  let from: string | undefined,
    settingsFile: string | undefined,
    apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && from === undefined && isAbsolute(args[i + 1] ?? '')) from = args[++i];
    else if (args[i] === '--settings' && settingsFile === undefined && isAbsolute(args[i + 1] ?? ''))
      settingsFile = args[++i];
    else if (args[i] === '--apply' && !apply) apply = true;
    else throw new Error('usage: hud statusline import --from ABS [--settings ABS] [--apply]');
  }
  if (!from) throw new Error('absolute --from required');
  const source = readJson(from);
  if (!source) throw new Error('import_source_missing');
  const result = importedSettings(source);
  const file = join(getHudHome(env), 'config.json');
  const before = readJson(file) ?? {};
  // Keep locally authored wrapper configuration; never import commands from a plugin.
  const old = record(before.statusline);
  let wrapper: { widthMargin: number; forward: string[] } | null = null;
  if (settingsFile) {
    const command = record(record(readJson(settingsFile)).statusLine).command;
    wrapper = typeof command === 'string' ? wrapperJobs(command, env.HOME ?? '') : null;
    if (!wrapper) throw new Error('unsupported_statusline_wrapper: only the audited width/tee jobs can be imported');
  }
  result.statusline = paritySettings({
    ...result.statusline,
    widthMargin: old.widthMargin,
    forward: old.forward,
    ...wrapper,
  });
  if (apply) saveJson(file, { ...before, statusline: result.statusline });
  return {
    mode: apply ? 'applied' : 'preview',
    target: file,
    wrapper: wrapper ? 'imported' : 'not imported (use explicit --settings ABS)',
    ...result,
  };
}
