import { readJson } from './receipt.js';
import { getHudHome } from '../../hud-home.js';
import { join } from 'node:path';

/** Missing preference defaults on. Invalid/unreadable preference does not silently enable auto-open. */
export function autoOpenEnabled(env: NodeJS.ProcessEnv): boolean {
  const config = readJson(join(getHudHome(env), 'integration-config.json'));
  if (config === null) return true;
  if (
    !config ||
    typeof config !== 'object' ||
    typeof (config as { panelAutoOpen?: unknown }).panelAutoOpen !== 'boolean'
  )
    throw new Error('panel_preference_invalid');
  return (config as { panelAutoOpen: boolean }).panelAutoOpen;
}
