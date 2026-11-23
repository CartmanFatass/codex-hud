/** Explicit STATE waiting items (with the first one's text), from `hud watch --mod`'s `band` record. */
export type Band = { lang: 'en' | 'zh'; waiting: number; first: string };

declare module 'claude-code' {
  interface PluginState {
    'hud-mod': {
      wake: { busy: string | null; aborted: boolean; pending: string[]; seed: string[]; seen: string[]; lastDelivery?: number };
      band: Band;
      /** The HUD MCP server's name as the engine connected it, for `$.mcp.call`. */
      server: string;
    };
  }
}
