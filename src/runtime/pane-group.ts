/** Best-effort main-session herdr sidebar project grouping, outside any paint path. */
import { getHudHome } from '../hud-home.js';
import { monitorText } from '../render/monitor-text.js';
import { herdrId } from '../roles/herdr-run.js';
import { registeredProjectName } from '../roles/projects.js';
import { herdrEndpoint, request as herdrRequest } from './herdr-socket.js';

const reported = new Set<string>();
const MAX_REPORTED = 64;

/** Report `hud_group` for a main-session pane in a registered project. Never touches workers or paint paths. */
export async function reportMainPaneGroup(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  hudHome?: string
): Promise<void> {
  if (env.HUD_JOB_DIR !== undefined) return;
  const paneId = env.HERDR_PANE_ID;
  const endpoint = herdrEndpoint(env);
  if (!herdrId(paneId) || !endpoint) return;
  const name = registeredProjectName(hudHome ?? getHudHome(env), cwd);
  const group = name ? monitorText(name.replace(/\s+/g, ' ')).trim() : '';
  if (!group) return;
  const key = `${endpoint}\0${paneId}\0${group}`;
  if (reported.has(key)) return;
  if (reported.size >= MAX_REPORTED) reported.clear();
  reported.add(key);
  try {
    const reply = await herdrRequest(
      'pane.report_metadata',
      { pane_id: paneId, source: 'hud', tokens: { hud_group: group } },
      { timeoutMs: 500, env }
    );
    if (!reply?.result || reply.error) reported.delete(key);
  } catch {
    reported.delete(key);
  }
}
