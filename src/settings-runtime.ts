import { resolveHudEnv } from './utils/hud-env.js';
import { existsSync } from 'node:fs';
import { loadSettings, defaultSettings, settingsPath, type HudSettings } from './settings.js';
import { resolveDisplayConfig, setDisplayConfig } from './render/hud-config.js';
export function runtimeSettings(): HudSettings {
  const display = resolveDisplayConfig();
  const settings = existsSync(settingsPath())
    ? loadSettings()
    : {
        ...defaultSettings(),
        theme: display.theme,
        icons: display.icons === 'text' ? ('text' as const) : ('unicode' as const),
        barStyle: display.barStyle,
        barFields: display.barFields,
      };
  if (!existsSync(settingsPath())) {
    const width = Number(resolveHudEnv(process.env, 'HUD_TREE_WIDTH'));
    if (Number.isInteger(width) && width >= 16 && width <= 200) settings.treeWidth = width;
  }
  return settings;
}
function displayOf(settings: HudSettings) {
  return {
    icons: settings.icons,
    glyphs: 'both' as const,
    look: 'tab' as const,
    motion: 'reduced' as const,
    barStyle: settings.barStyle,
    barFields: settings.barFields,
    theme: process.env.NO_COLOR ? ('none' as const) : settings.theme,
  };
}
export function applyDisplaySettings(settings: HudSettings): void {
  setDisplayConfig(displayOf(settings));
}
/** What `draw` returns drawn in the display settings of `settings`, the ones in use put back after. */
export function withDisplaySettings<T>(settings: HudSettings, draw: () => T): T {
  const previous = setDisplayConfig(displayOf(settings));
  try {
    return draw();
  } finally {
    setDisplayConfig(previous);
  }
}
export { applyBarSettings } from './bar-settings.js';
