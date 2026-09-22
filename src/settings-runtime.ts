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
export function applyDisplaySettings(settings:HudSettings):void {
  setDisplayConfig({density:settings.density,glyphs:settings.glyphs,motion:settings.motion,context:settings.context,
    theme:process.env.NO_COLOR ? 'none' : settings.theme});
}
