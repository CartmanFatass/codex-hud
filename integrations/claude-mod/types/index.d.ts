/** What needs the owner now, from `hud watch --mod`'s `band` record: STATE waiting items (with the first one's text) and slices to try. */
export type Band = { lang: 'en' | 'zh'; waiting: number; first: string; accept: number };

declare module 'claude-code' {
  interface PluginState {
    'hud-mod': {
      wake: { busy: string | null; aborted: boolean; pending: string[]; seed: string[]; seen: string[]; lastDelivery?: number };
      band: Band;
    };
  }
}
