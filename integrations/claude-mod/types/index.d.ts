declare module 'claude-code' {
  interface PluginState {
    'hud-mod': {
      wake: { busy: string | null; aborted: boolean; pending: string[]; seed: string[]; seen: string[] };
    };
  }
}
