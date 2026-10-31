import { existsSync } from 'node:fs';
import { loadSettings, defaultSettings, settingsPath, type HudSettings } from './settings.js';
import { resolveDisplayConfig, setDisplayConfig } from './render/hud-config.js';
export function runtimeSettings():HudSettings {
  const settings = existsSync(settingsPath()) ? loadSettings() : {...defaultSettings(),...resolveDisplayConfig()};
  if (!existsSync(settingsPath())) {
    const width = Number(process.env.CODEX_HUD_TREE_WIDTH);
    if (Number.isInteger(width) && width >=16 && width <=200) settings.treeWidth = width;
  }
  return settings;
}
function displayOf(settings:HudSettings) {
  return {density:settings.density,glyphs:settings.glyphs,icons:settings.icons,look:settings.look,motion:settings.motion,context:settings.context,agentColors:settings.agentColors,
    theme:process.env.NO_COLOR ? 'none' as const : settings.theme};
}
export function applyDisplaySettings(settings:HudSettings):void {
  setDisplayConfig(displayOf(settings));
}
/** What `draw` returns drawn in the display settings of `settings`, the ones in use put back after. */
export function withDisplaySettings<T>(settings:HudSettings,draw:()=>T):T {
  const previous = setDisplayConfig(displayOf(settings));
  try { return draw(); } finally { setDisplayConfig(previous); }
}
