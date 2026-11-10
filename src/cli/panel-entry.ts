/** Same-process registered panel entry. Imported by bin/hud before the general CLI. */
import { join } from 'node:path';
import { getHudHome } from '../hud-home.js';
import { resolveHudEnv } from '../utils/hud-env.js';
import { registerPanel } from '../integrations/panel/control.js';
import { PanelStore, absolute, clean, validStamp } from '../integrations/panel/receipt.js';
import { CliPanelHerdr, PanelDeadline } from '../integrations/panel/herdr.js';
import { installPanelLifetime } from '../integrations/panel/lifetime.js';

export async function registeredPanelMain(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let dispose: (() => void) | undefined;
  const deadline = new PanelDeadline(1500);
  try {
    if (
      !env.HUD_PANEL_TOKEN ||
      !env.HUD_PANEL_GENERATION ||
      !env.HUD_PANEL_KEY ||
      !absolute(env.HUD_PANEL_SOCKET) ||
      !env.HUD_PANEL_SERVER ||
      env.HUD_PANEL_SERVER.length > 2048
    )
      throw new Error('panel_launch_invalid');
    const server: unknown = JSON.parse(env.HUD_PANEL_SERVER);
    if (!validStamp(server)) throw new Error('panel_endpoint_invalid');
    const herdr = new CliPanelHerdr({ socket: env.HUD_PANEL_SOCKET, server, env });
    const store = new PanelStore(env);
    const pending = store.read(env.HUD_PANEL_KEY);
    if (!pending || pending.token !== env.HUD_PANEL_TOKEN || pending.generation !== env.HUD_PANEL_GENERATION)
      throw new Error('panel_registration_refused');
    if ((await deadline.run(() => herdr.instance(deadline))) !== pending.instance)
      throw new Error('panel_instance_changed');
    const paneId = pending.createdPane ?? env.HERDR_PANE_ID;
    if (!clean(paneId, 256)) throw new Error('panel_pane_unknown');
    // observe gets workspace_id from pane.get, never a focused-workspace query.
    const actual = await deadline.run(() => herdr.observe(paneId, deadline, pending.createdWorkspace));
    if (
      !actual ||
      !clean(actual.workspace, 256) ||
      (await deadline.run(() => herdr.instance(deadline))) !== pending.instance
    )
      throw new Error('panel_identity_lost');
    const receipt = registerPanel(env, actual);
    deadline.dispose();
    Object.assign(env, {
      HUD_SETTINGS_PATH: resolveHudEnv(env, 'HUD_SETTINGS_PATH') || join(getHudHome(env), 'hud-settings.json'),
      HUD_PANEL_HARNESS: receipt.target.harness,
      HUD_PANEL_SOURCE: receipt.target.source,
      HUD_PANEL_SESSION: receipt.target.ref.sessionId,
      CODEX_HUD_PANEL_ROOT: receipt.target.root,
      CODEX_HUD_PANEL_ALL_DELEGATIONS: '0',
      CODEX_HUD_STANDALONE_PANEL: '1',
    });
    const { runLivePage } = await import('../tree-page.js');
    await runLivePage({
      installCleanup: (end) => {
        const lifetime = installPanelLifetime({ env, receipt, herdr, end });
        dispose = () => lifetime.dispose();
        return dispose;
      },
    });
    return 0;
  } catch {
    process.stderr.write('panel_registration_unavailable\n');
    return 3;
  } finally {
    deadline.dispose();
    dispose?.();
  }
}
