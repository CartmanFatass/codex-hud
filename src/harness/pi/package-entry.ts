/** Ordinary pi package: local controls, six thin-server proxies and the owned pi footer. */
import { PiRoleClient, PI_ROLE_TOOLS } from './role-client.js';
import { createPiSegment, isPiTui } from './segment.js';
import type { PiPackageBinding, PiPackageContext } from './package-context.js';
export type { PiPackageBinding, PiPackageContext } from './package-context.js';
import { displayTarget } from '../../integrations/panel/receipt.js';
import { closePanelPane, panelPaneExists } from '../../cli/panel-pane.js';
import { autoOpenEnabled } from '../../integrations/panel/eligibility.js';
import { openPiPanel } from './package-native.js';
import { createP10kFooter } from './p10k-footer.js';
import type { FooterAPI, FooterHost } from './footer-host.js';
/** Structural host projection. SDK compatibility is checked against the installed declarations. */
export interface PiPackageAPI extends FooterAPI {
  on(event: string, handler: (event: unknown, ctx: PiPackageContext) => void | Promise<void>): (() => void) | void;
  registerCommand(
    name: string,
    options: { description: string; handler(args: string, ctx: PiPackageContext): Promise<void> }
  ): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(
      callId: string,
      args: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: PiPackageContext
    ): Promise<unknown>;
  }): void;
}
const reason = (error: unknown) =>
  error instanceof Error && /^[a-z_]{1,120}$/.test(error.message) ? error.message : 'local_operation_failed';
type PanelOperation = 'open' | 'close' | 'toggle' | 'status';
export function installPiPackage(
  pi: PiPackageAPI,
  binding: PiPackageBinding,
  deps: {
    env?: NodeJS.ProcessEnv;
    footerHost?: () => Promise<FooterHost>;
    segment?: Partial<Pick<Parameters<typeof createPiSegment>[0], 'now' | 'schedule'>>;
  } = {}
) {
  const env = { ...(deps.env ?? process.env), HUD_HOME: binding.hudHome };
  const segment = createPiSegment({ env, ...deps.segment });
  let footer: ReturnType<typeof createP10kFooter> | undefined;
  type State = {
    ctx: PiPackageContext;
    id: string;
    source: string;
    client: PiRoleClient;
    pane?: string;
    panelWork: Promise<void>;
    diagnostic: string;
    footerOn: boolean;
  };
  let active: State | null = null;
  // Binding epochs are disposable; the user's same-session footer choice is not.
  let footerChoice: { id: string; source: string; on: boolean } | undefined;
  let epoch = 0;
  let cleanup: Promise<void> = Promise.resolve();
  const removers: (() => void)[] = [];
  const current = (s: State) => {
    try {
      return (
        active === s &&
        s.ctx.sessionManager.getSessionId() === s.id &&
        s.ctx.sessionManager.getSessionDir() === s.source
      );
    } catch {
      return false;
    }
  };
  async function panel(s: State, operation: PanelOperation) {
    // Keep an off/shutdown queued behind an in-flight open.
    const work = s.panelWork.then(async () => {
      if (operation !== 'close' && !current(s)) throw Error('stale_context');
      if (s.pane && !(await panelPaneExists(s.pane, env))) s.pane = undefined;
      if (operation === 'close' || (operation === 'toggle' && s.pane)) {
        if (s.pane) await closePanelPane(s.pane, env);
        s.pane = undefined;
      } else if (operation !== 'status' && !s.pane) {
        s.pane = await openPiPanel(binding, s.ctx, env);
      }
      s.diagnostic = s.pane ? `open (${s.pane})` : 'closed';
    });
    s.panelWork = work.catch((error) => {
      s.diagnostic = reason(error);
    });
    await s.panelWork;
  }
  function fence() {
    ++epoch;
    const old = active;
    active = null;
    segment.stop();
    footer?.stop();
    // Stop tool calls before asynchronous panel cleanup or live observation.
    const stopped = old?.client.stop();
    const closing = old ? panel(old, 'close') : undefined;
    cleanup = Promise.all([cleanup, stopped, closing]).then(() => {});
    return cleanup;
  }
  async function start(ctx: PiPackageContext, automatic: boolean) {
    const closed = fence(),
      ticket = epoch;
    await closed;
    if (ticket !== epoch) return;
    const source = ctx.sessionManager.getSessionDir(),
      id = ctx.sessionManager.getSessionId();
    if (!footerChoice || footerChoice.id !== id || footerChoice.source !== source)
      footerChoice = { id, source, on: true };
    const s: State = {
      ctx,
      id,
      source,
      client: new PiRoleClient(binding, env, ctx.cwd),
      panelWork: Promise.resolve(),
      diagnostic: 'panel_not_open',
      footerOn: footerChoice.on,
    };
    active = s;
    if (!current(s) || ticket !== epoch) return;
    if (isPiTui(ctx) && deps.footerHost) {
      const host = footer ? undefined : await deps.footerHost();
      if (!current(s) || ticket !== epoch) return;
      if (!footer && host) footer = createP10kFooter(pi, host, env);
      if (s.footerOn) footer?.start(ctx);
    }
    segment.start(ctx, displayTarget('pi', id, source).root, () => current(s));
    if (isPiTui(ctx)) {
      try {
        if (!automatic || autoOpenEnabled(env)) await panel(s, 'open');
        else s.diagnostic = 'panel_auto_open_disabled';
      } catch (error) {
        s.diagnostic = reason(error);
      }
    }
  }
  function on(event: string, handler: (event: unknown, ctx: PiPackageContext) => void | Promise<void>) {
    const remove = pi.on(event, handler);
    if (remove) removers.push(remove);
  }
  on('session_start', async (_event, ctx) => {
    await start(ctx, true);
  });
  for (const event of ['session_before_switch', 'session_before_fork', 'session_before_tree']) on(event, () => fence());
  on('session_tree', async (_event, ctx) => {
    await start(ctx, true);
  });
  on('session_shutdown', () => {
    const result = fence();
    footer?.dispose();
    footer = undefined;
    for (const remove of removers.splice(0)) remove();
    return result;
  });
  for (const event of [
    'model_select',
    'thinking_level_select',
    'agent_start',
    'agent_end',
    'agent_settled',
    'message_end',
    // message_end runs before native persistence. context runs after persistence,
    // before every provider request, so the working band includes the new prompt.
    'context',
    'session_compact',
    'session_compact_failed',
    'session_info_changed',
  ])
    on(event, () => {
      segment.refresh();
      footer?.update();
    });
  on('turn_start', (event) => footer?.turnStart((event as { timestamp?: number }).timestamp));
  on('turn_end', () => footer?.turnEnd());
  pi.registerCommand('hud', {
    description: 'Local HUD panel: on|off|toggle|status|reconnect|help; footer on|off or footer <segment options>',
    async handler(args, ctx) {
      if (/^footer(?:\s|$)/.test(args.trim())) {
        const options = args.trim().slice('footer'.length).trim();
        if (options === 'on' || options === 'off') {
          const s = active;
          if (!s || !current(s)) ctx.ui.notify('HUD: session_unbound; use /hud reconnect', 'info');
          else if (!isPiTui(ctx)) ctx.ui.notify('HUD: footer_noninteractive', 'info');
          else {
            const show = options === 'on';
            if (show !== s.footerOn) {
              s.footerOn = show;
              footerChoice = { id: s.id, source: s.source, on: show };
              if (show) footer?.start(ctx);
              else footer?.stop();
            }
            ctx.ui.notify('HUD: footer_' + options, 'info');
          }
        } else await footer?.command(options, ctx);
        return;
      }
      let message: string;
      const command = args.trim() || 'status';
      try {
        if (!['on', 'off', 'toggle', 'status', 'reconnect', 'help'].includes(command))
          message = 'unknown_subcommand; use on|off|toggle|status|reconnect|help';
        else if (command === 'help')
          message =
            'Panel: on|off|toggle|status|reconnect|help. Footer: footer on|off restores/hides the HUD frame independently; footer <segment options>. off is session-local; reconnect rebinds a canceled transition.';
        else if (command === 'reconnect') {
          await start(ctx, false);
          message = active ? 'reconnected; ' + active.diagnostic : 'session_unbound';
        } else {
          const s = active;
          if (!s || !current(s)) message = 'session_unbound; use /hud reconnect';
          else if (!isPiTui(ctx)) message = 'panel_noninteractive; role_tools_available';
          else {
            await panel(s, command === 'on' ? 'open' : command === 'off' ? 'close' : (command as PanelOperation));
            message = s.diagnostic;
          }
        }
      } catch (error) {
        message = reason(error);
      }
      ctx.ui.notify('HUD: ' + message, 'info');
    },
  });
  for (const tool of PI_ROLE_TOOLS)
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(_callId, args, signal, _onUpdate, ctx) {
        const s = active;
        if (!s || !current(s) || ctx.sessionManager !== s.ctx.sessionManager) throw Error('pi_session_inactive');
        signal?.throwIfAborted();
        const result = await s.client.call(tool.name, args);
        try {
          return { ...result, details: JSON.parse(result.content[0].text) };
        } catch {
          throw Error('invalid_mcp_response');
        }
      },
    });
}
