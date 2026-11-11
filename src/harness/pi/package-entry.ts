/** Ordinary pi package: local controls, six thin-server proxies and the owned pi footer. */
import { PiRoleClient, PI_ROLE_TOOLS } from './role-client.js';
import { createPiSegment, isPiTui } from './segment.js';
import type { PiPackageBinding, PiPackageContext } from './package-context.js';
export type { PiPackageBinding, PiPackageContext } from './package-context.js';
import { displayTarget } from '../../integrations/panel/receipt.js';
import { controlPanel, type PanelControlOptions, type PanelOperation } from '../../integrations/panel/control.js';
import { autoOpenEnabled } from '../../integrations/panel/eligibility.js';
import { PanelDeadline, samePane } from '../../integrations/panel/herdr.js';
import { capturePiPanel } from './package-native.js';
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
type Capture = Awaited<ReturnType<typeof capturePiPanel>>;
export function installPiPackage(
  pi: PiPackageAPI,
  binding: PiPackageBinding,
  deps: {
    env?: NodeJS.ProcessEnv;
    footerHost?: () => Promise<FooterHost>;
    capture?: typeof capturePiPanel;
    panel?: typeof controlPanel;
    panelProbes?: Pick<PanelControlOptions, 'processInfo' | 'processLaunch' | 'registered'>;
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
    capture?: Capture;
    generation?: string;
    panelWork: Promise<void>;
    diagnostic: string;
    footerOn: boolean;
  };
  let active: State | null = null;
  // Binding epochs are disposable; the user's same-session footer choice is not.
  let footerChoice: { id: string; source: string; on: boolean } | undefined;
  let tree: { state: State; ticket: number; generation: string; confirmed: boolean } | undefined;
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
  async function panel(s: State, operation: PanelOperation, automatic = false) {
    if (!isPiTui(s.ctx)) {
      s.diagnostic = 'panel_noninteractive';
      return;
    }
    // Serialize operations, including a close queued behind an opening intent.
    const work = s.panelWork.then(async () => {
      if (operation !== 'close' && !current(s)) throw Error('stale_context');
      const captured =
        operation === 'close'
          ? s.capture
          : await (deps.capture ?? capturePiPanel)(binding, s.ctx, env, () => current(s));
      if (!captured || (operation === 'close' && !s.generation)) return;
      if (operation !== 'close') s.capture = captured;
      const opening = operation === 'open' || operation === 'toggle';
      let issuedGeneration: string | undefined;
      const herdr: typeof captured.herdr = opening
        ? {
            preflight: (...args) => captured.herdr.preflight(...args),
            instance: (...args) => captured.herdr.instance(...args),
            observe: (...args) => captured.herdr.observe(...args),
            start: (...args) => captured.herdr.start(...args),
            close: (...args) => captured.herdr.close(...args),
            split: (receipt, childEnv, deadline) => {
              // Observe A3's own intent before its first mutation; never infer ownership
              // from a receipt returned by a stale status/close operation.
              issuedGeneration = receipt.generation;
              return captured.herdr.split(receipt, childEnv, deadline);
            },
          }
        : captured.herdr;
      const result = await (deps.panel ?? controlPanel)(operation, captured.context, {
        ...deps.panelProbes,
        env,
        herdr,
        native: captured.native,
        isCurrent: () => current(s) && captured.isCurrent(),
        generation: s.generation,
        automatic,
      });
      const receipt = result.receipt;
      if (
        opening &&
        receipt &&
        receipt.target.root === captured.context.target.root &&
        receipt.target.harness === captured.context.target.harness &&
        receipt.target.ref.sourceId === captured.context.target.ref.sourceId &&
        receipt.target.ref.sessionId === captured.context.target.ref.sessionId &&
        (receipt.generation === issuedGeneration || (current(s) && result.diagnostic === 'open'))
      ) {
        // A fenced opening still owns its issued intent and must clean it up.
        // Observing/refusing another generation never transfers it to this state.
        s.generation = receipt.generation;
      }
      s.diagnostic = result.diagnostic;
    });
    s.panelWork = work.catch((error) => {
      s.diagnostic = reason(error);
    });
    await s.panelWork;
  }
  async function treeContinuity(s: State, ticket: number) {
    if (!s.capture || !s.generation || !isPiTui(s.ctx)) return;
    const marker = { state: s, ticket, generation: s.generation, confirmed: false };
    tree = marker;
    const captured = s.capture;
    const stillCurrent = () => {
      try {
        return (
          tree === marker &&
          epoch === ticket &&
          active === null &&
          s.generation === marker.generation &&
          s.ctx.sessionManager.getSessionId() === s.id &&
          s.ctx.sessionManager.getSessionDir() === s.source
        );
      } catch {
        return false;
      }
    };
    const deadline = new PanelDeadline(150);
    try {
      await deadline.run(() => s.panelWork);
      if (!stillCurrent()) return;
      const result = await deadline.run(() =>
        (deps.panel ?? controlPanel)('status', captured.context, {
          env,
          herdr: captured.herdr,
          native: captured.native,
          isCurrent: stillCurrent,
          budgetMs: 150,
        })
      );
      const r = result.receipt;
      if (
        !stillCurrent() ||
        r?.phase !== 'open' ||
        r.generation !== marker.generation ||
        !r.panel ||
        r.target.root !== captured.context.target.root ||
        r.target.harness !== captured.context.target.harness ||
        r.target.ref.sourceId !== captured.context.target.ref.sourceId ||
        r.target.ref.sessionId !== captured.context.target.ref.sessionId ||
        r.instance !== captured.context.instance
      )
        return;
      const instance = await deadline.run(() => captured.herdr.instance(deadline));
      if (instance !== r.instance || !stillCurrent()) return;
      const observed = await deadline.run(() => captured.herdr.observe(r.panel!.pane, deadline, r.panel!.workspace));
      deadline.remaining();
      if (stillCurrent() && observed && samePane(observed, r.panel)) marker.confirmed = true;
    } catch {
      // Bounded read-only observation is optional; uncertainty never grants continuation.
      s.diagnostic = 'panel_tree_continuity_unverified';
      if (stillCurrent()) s.ctx.ui.notify('HUD: panel_tree_continuity_unverified', 'info');
    } finally {
      deadline.dispose();
    }
  }
  function fence(forTree = false) {
    const ticket = ++epoch;
    tree = undefined;
    const old = active;
    active = null;
    segment.stop();
    footer?.stop();
    // Stop tool calls before asynchronous panel cleanup or live observation.
    const stopped = old?.client.stop();
    const closing = old
      ? (async () => {
          if (forTree) await treeContinuity(old, ticket);
          await panel(old, 'close');
        })()
      : undefined;
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
        if (!automatic || autoOpenEnabled(env)) await panel(s, 'open', automatic);
        else s.diagnostic = 'panel_auto_open_disabled';
      } catch (error) {
        s.diagnostic = reason(error);
      }
    }
  }
  function on(event: string, handler: (event: unknown, ctx: PiPackageContext) => void | Promise<void>) {
    const remove = pi.on(event, (value, ctx) => {
      if (event !== 'session_tree' && event !== 'session_before_tree') tree = undefined;
      return handler(value, ctx);
    });
    if (remove) removers.push(remove);
  }
  on('session_start', async (_event, ctx) => {
    await start(ctx, true);
  });
  for (const event of ['session_before_switch', 'session_before_fork']) on(event, () => fence());
  on('session_before_tree', () => fence(true));
  on('session_tree', async (_event, ctx) => {
    const marker = tree;
    tree = undefined; // one use, even if opening fails or another navigation races it
    const continuation =
      marker?.confirmed === true &&
      marker.ticket === epoch &&
      marker.state.generation === marker.generation &&
      isPiTui(ctx) &&
      !ctx.sessionManager.getHeader()?.parentSession &&
      autoOpenEnabled(env);
    await start(ctx, !continuation);
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
      tree = undefined;
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
