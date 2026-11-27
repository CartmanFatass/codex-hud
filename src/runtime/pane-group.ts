/** Best-effort main-session herdr sidebar project grouping, outside any paint path. */
import { getHudHome } from '../hud-home.js';
import { ensureJobWatcher } from '../mcp/watch-pid.js';
import { monitorText } from '../render/monitor-text.js';
import { herdrId } from '../roles/herdr-run.js';
import { registeredProjectName } from '../roles/projects.js';
import { hasHerdrSidebar, herdrEndpoint, request as herdrRequest } from './herdr-socket.js';

const reported = new Set<string>();
const sidebar = new Set<string>();
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
  const home = hudHome ?? getHudHome(env);
  const name = registeredProjectName(home, cwd);
  const group = name ? monitorText(name.replace(/\s+/g, ' ')).trim() : '';
  // Unregistered main sessions must not contact herdr from delegation or footer startup.
  if (!group) return;
  const session = `${home}\0${endpoint}`;
  if (!sidebar.has(session)) {
    if (sidebar.size >= MAX_REPORTED) sidebar.clear();
    sidebar.add(session);
    void hasHerdrSidebar(env).then(supported => {
      if (supported) ensureJobWatcher(home, () => true, endpoint);
      else sidebar.delete(session);
    }).catch(() => sidebar.delete(session));
  }
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
