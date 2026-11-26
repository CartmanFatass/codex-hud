/** Private, bounded handoff from one-shot native statuslines to their existing HUD MCP connection. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getHudHome } from '../hud-home.js';
import { mainStripTarget, ownMainPaneStrip } from '../main-pane-strip.js';
import { displayConfig, setDisplayConfig, type HudDisplayConfig } from '../render/hud-config.js';
import type { BarFacts } from '../render/layout/bar-fields.js';
import { paneStripEnabled, type StripClient } from '../settings.js';
import { readJsonBounded, writePrivateFile } from '../utils/atomic-fs.js';
import { renderCompactStatusline } from './render.js';

type Client = Exclude<StripClient, 'pi'>;
const LIMIT = 16 * 1024;
type Sample = { key: string; at: number; facts: BarFacts; display: HudDisplayConfig };

function mailbox(client: Client, env: NodeJS.ProcessEnv) {
  const target = mainStripTarget(env);
  if (!target) return;
  const key = createHash('sha256').update(JSON.stringify([target.endpoint, target.pane, client])).digest('hex');
  // 256 fixed slots, never use another pane's record even on a slot collision.
  return { key, file: join(getHudHome(env), 'display', 'pane-strip-v1', key.slice(0, 2) + '.json') };
}

export function publishStripFacts(client: Client, env: NodeJS.ProcessEnv, facts: BarFacts, now: number): void {
  const box = mailbox(client, env);
  if (!box || !paneStripEnabled(client, env)) return;
  try {
    // Only facts already prepared for the compact renderer, never statusline stdin or transcript contents.
    const value: Sample = { key: box.key, at: now, facts, display: displayConfig() };
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) <= LIMIT) writePrivateFile(box.file, data);
  } catch { /* Strip failure does not change native stdout. */ }
}

export function ownStatuslineStrip(client: Client, env: NodeJS.ProcessEnv, allowed: () => boolean) {
  const box = mailbox(client, env);
  if (!box) return;
  const since = Date.now();
  let latest: Sample | undefined;
  return ownMainPaneStrip(client, env, () => {
    if (!allowed()) return;
    try {
      const candidate = readJsonBounded(box.file, LIMIT) as Sample;
      if (candidate?.key === box.key && candidate.at >= (latest?.at ?? since) && candidate.at <= Date.now() &&
          candidate.facts && candidate.display) latest = candidate;
    } catch { /* It is normal to start before the first statusline refresh. */ }
    const frame = latest;
    if (!frame) return;
    return (width) => {
      const previous = setDisplayConfig(frame.display);
      try { return renderCompactStatusline(frame.facts, width, frame.at); }
      finally { setDisplayConfig(previous); }
    };
  });
}
