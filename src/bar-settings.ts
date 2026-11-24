/** Bar-only preferences: no panel defaults or credential discovery on this path. */
import { join } from 'node:path';
import { getHudHome } from './hud-home.js';
import { readFileBounded } from './utils/atomic-fs.js';
import { resolveHudEnv } from './utils/hud-env.js';
import { BAR_FIELDS, barStyleOf, resolveDisplayConfig, setDisplayConfig } from './render/hud-config.js';

export function readBarSettings(env = process.env) {
  let { barStyle, barFields, theme, icons } = resolveDisplayConfig(env);
  try {
    const file = resolveHudEnv(env, 'HUD_SETTINGS_PATH') || join(getHudHome(env), 'hud-settings.json');
    const { bytes, truncated } = readFileBounded(file, 65_536, { followSymlinks: true });
    if (truncated) return;
    const raw = JSON.parse(bytes.toString('utf8'));
    const values = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    barStyle = barStyleOf(values.barStyle);
    // Preserve the environment's palette unless the owner explicitly disables colour.
    if (values.theme === 'none') theme = 'none';
    if (values.icons === 'nerd' || values.icons === 'unicode' || values.icons === 'text') icons = values.icons;
    barFields = Array.isArray(values.barFields) && values.barFields.every((f: unknown) => BAR_FIELDS.includes(f as never))
      ? values.barFields : [...BAR_FIELDS];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  return { barStyle, barFields, theme, icons };
}

export function applyBarSettings(env = process.env): void {
  const settings = readBarSettings(env);
  if (settings) setDisplayConfig(settings);
}
