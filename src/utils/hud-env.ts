/** Presentation aliases only. Raw selection is separate from each consumer's parsing. */
const legacyNames = {
  HUD_SETTINGS_PATH: 'CODEX_HUD_SETTINGS_PATH',
  HUD_THEME: 'CODEX_HUD_THEME',
  HUD_DENSITY: 'CODEX_HUD_DENSITY',
  HUD_GLYPHS: 'CODEX_HUD_GLYPHS',
  HUD_ICONS: 'CODEX_HUD_ICONS',
  HUD_LOOK: 'CODEX_HUD_LOOK',
  HUD_REDUCED_MOTION: 'CODEX_HUD_REDUCED_MOTION',
  HUD_CONTEXT: 'CODEX_HUD_CONTEXT',
  HUD_BAR_STYLE: 'CODEX_HUD_BAR_STYLE',
  HUD_BAR_FIELDS: 'CODEX_HUD_BAR_FIELDS',
  HUD_TREE_WIDTH: 'CODEX_HUD_TREE_WIDTH',
  HUD_CLEAR_SCROLLBACK: 'CODEX_HUD_CLEAR_SCROLLBACK',
} as const;

export type HudEnvironmentName = keyof typeof legacyNames;

/** A present neutral value wins, even empty or invalid. Unknown names never map. */
export function resolveHudEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: HudEnvironmentName
): string | undefined {
  if (!Object.hasOwn(legacyNames, name)) return undefined;
  const neutral = env[name];
  return neutral !== undefined ? neutral : env[legacyNames[name]];
}
