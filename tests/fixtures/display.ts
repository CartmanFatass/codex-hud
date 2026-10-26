import { beforeEach, afterEach } from 'node:test';
import { resolveDisplayConfig, setDisplayConfig, type HudDisplayConfig } from '../../src/render/hud-config.js';

/** Rendering expectations choose their own display, independent of the caller's terminal. */
export function useDisplayFixture(config: Partial<HudDisplayConfig> = {}): void {
  let previous: HudDisplayConfig;
  beforeEach(() => {
    previous = setDisplayConfig({ ...resolveDisplayConfig({}), ...config });
  });
  afterEach(() => { setDisplayConfig(previous); });
}
