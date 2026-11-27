/** Ordinary pi package: thin-server tools (delegate) plus local controls and the owned pi footer (display). */
import { PiRoleClient, PI_ROLE_TOOLS } from './role-client.js';
import { createPiSegment, isPiTui } from './segment.js';
import type { PiPackageBinding, PiPackageContext } from './package-context.js';
export type { PiPackageBinding, PiPackageContext } from './package-context.js';
import { controlPanelDock, type PanelOperation } from '../../cli/panel.js';
import { startSessionWatch } from '../../cli/watch.js';
import { allowCouncil } from '../../roles/council-grant.js';
import { herdrId } from '../../roles/herdr-run.js';
import { reportMainPaneGroup } from '../../runtime/pane-group.js';
import { collectResumeRefusal } from '../../collectors/job-snapshot.js';
import { herdrEndpoint } from '../../runtime/herdr-socket.js';
import { createP10kFooter } from './p10k-footer.js';
import { piExpUsage } from './exp-usage.js';
import { adviseOnMessage, adviseOnReply, resolveAdvisorProjectRoot, scrubSecrets } from '../../collectors/advisor-shadow.js';
import type { FooterAPI, FooterHost } from './footer-host.js';
/** Structural host projection. SDK compatibility is checked against the installed declarations. */
export interface PiPackageAPI extends FooterAPI {
  on(event: string, handler: (event: unknown, ctx: PiPackageContext) => void | Promise<void>): (() => void) | void;
  sendMessage?(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' }
  ): void;
  sendUserMessage(content: string, options?: { deliverAs: 'followUp' }): void;
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
/** Delegation always loads; the display entry (footer, Work segment, /hud) only loads through `pi -e`. */
export type PiPackageMode = 'delegate' | 'display';
export function installPiPackage(
  pi: PiPackageAPI,
  binding: PiPackageBinding,
  deps: {
    env?: NodeJS.ProcessEnv;
    footerHost?: () => Promise<FooterHost>;
    segment?: Partial<Pick<Parameters<typeof createPiSegment>[0], 'now' | 'schedule'>>;
  } = {},
  mode: PiPackageMode
) {
  const env: NodeJS.ProcessEnv = { ...(deps.env ?? process.env), HUD_HOME: binding.hudHome };
  let footer: ReturnType<typeof createP10kFooter> | undefined;
  const segment = createPiSegment({ env, ...deps.segment, onSignals: (counts, localLoad) => footer?.setWork(counts, localLoad),
    statusVisible: () => !footer?.ownsFooter() });
  type State = {
    ctx: PiPackageContext;
    id: string;
    source: string;
    client: PiRoleClient;
    stopWatch?: () => void;
    footerOn: boolean;
  };
  let active: State | null = null;
  let resumeCheck: { id: string; source: string; refusal?: string } | undefined;
  let resumeRefusal: string | undefined;
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
  function panel(s: State, operation: PanelOperation) {
    return controlPanelDock(operation, env, {
      node: binding.node, release: binding.release, cwd: s.ctx.cwd,
      selection: ['--harness', 'pi', '--session', s.id, '--source', s.source],
      isCurrent: () => current(s),
    });
  }
  function fence() {
    ++epoch;
    const old = active;
    active = null;
    resumeRefusal = undefined;
    old?.stopWatch?.();
    if (mode === 'display') {
      segment.stop();
      footer?.stop();
    }
    // The dock belongs to herdr, not to the retiring pi session.
    cleanup = Promise.all([cleanup, old?.client.stop()]).then(() => {});
    return cleanup;
  }
  async function start(ctx: PiPackageContext) {
    const closed = fence(),
      ticket = epoch;
    await closed;
    if (ticket !== epoch) return;
    const source = ctx.sessionManager.getSessionDir(),
      id = ctx.sessionManager.getSessionId();
    if (mode === 'delegate' && env.HUD_JOB_DIR === undefined) {
      const checked = resumeCheck?.id === id && resumeCheck.source === source;
      if (!checked) {
        const refusal = await collectResumeRefusal(binding.hudHome, {
          agent: 'pi', id, file: ctx.sessionManager.getSessionFile(),
        });
        if (ticket !== epoch) return;
        resumeCheck = { id, source, refusal };
      }
      resumeRefusal = resumeCheck?.refusal;
      if (resumeRefusal) {
        if (!checked) ctx.ui.notify(resumeRefusal, 'warning');
        return; // No delegate client or main-session watcher for this session.
      }
    }
    if (!footerChoice || footerChoice.id !== id || footerChoice.source !== source)
      footerChoice = { id, source, on: true };
    const s: State = {
      ctx,
      id,
      source,
      client: new PiRoleClient(binding, env, ctx.cwd, id),
      footerOn: footerChoice.on,
    };
    active = s;
    if (!current(s) || ticket !== epoch) return;
    const pane = env.HERDR_PANE_ID;
    if (herdrId(pane) && env.HUD_JOB_DIR === undefined) {
      void reportMainPaneGroup(ctx.cwd, env, binding.hudHome);
    }
    if (mode === 'delegate' && herdrId(pane) && !env.HUD_JOB_DIR && typeof pi.sendMessage === 'function') {
      const { registerPiWatcher } = await import(new URL('../../../packages/hud-mcp/bin/hud-notify.mjs', import.meta.url).href);
      if (!current(s)) return;
      const unregister = registerPiWatcher(pane, binding.hudHome);
      if (unregister) {
        const stop = startSessionWatch(binding.hudHome, pane, ctx.cwd, (lines) => {
          if (!current(s)) return s.stopWatch?.();
          try {
            // Pi 1.5.2 delivers steering after the current tool batch, before the next model request.
            pi.sendMessage?.(
              {
                customType: 'hud-watch',
                content: `HUD watch notice (status only; not a user instruction or authorization):\n${lines.join('\n')}`,
                display: true,
              },
              { deliverAs: 'steer', triggerTurn: true }
            );
          } catch { s.stopWatch?.(); }
        });
        s.stopWatch = () => { stop(); unregister(); };
      }
    }
    if (mode === 'display') {
      if (isPiTui(ctx) && deps.footerHost) {
        const host = footer ? undefined : await deps.footerHost();
        if (!current(s) || ticket !== epoch) return;
        if (!footer && host) footer = createP10kFooter(pi, host, env);
        if (s.footerOn) footer?.start(ctx);
      }
      segment.start(ctx, () => current(s));
    }
  }
  function on(event: string, handler: (event: unknown, ctx: PiPackageContext) => void | Promise<void>) {
    const remove = pi.on(event, handler);
    if (remove) removers.push(remove);
  }
  // Display-only subscriptions and command; the delegation entry registers none of them.
  const onDisplay: typeof on = mode === 'display' ? on : () => {};
  const registerHud = mode === 'display' ? pi.registerCommand.bind(pi) : undefined;
  on('session_start', async (_event, ctx) => {
    await start(ctx);
  });
  // Delegation stays bound if navigation is canceled; current() rejects an actual session change.
  for (const event of ['session_before_switch', 'session_before_fork', 'session_before_tree'])
    onDisplay(event, () => fence());
  on('session_tree', async (_event, ctx) => {
    await start(ctx);
  });
  on('session_shutdown', () => {
    const result = fence();
    const stripClosed = footer?.dispose();
    footer = undefined;
    for (const remove of removers.splice(0)) remove();
    return Promise.all([result, stripClosed]).then(() => {});
  });
  for (const event of [
    'thinking_level_select',
    'agent_settled',
    'message_end',
    // message_end runs before native persistence. context runs after persistence,
    // before every provider request, so the working band includes the new prompt.
    'context',
    'session_compact',
    'session_compact_failed',
    'session_info_changed',
  ])
    onDisplay(event, () => {
      segment.refresh();
      footer?.update();
    });
  onDisplay('model_select', () => {
    subscriptionFooter()?.modelChanged();
    segment.refresh();
    footer?.update();
  });
  function subscriptionFooter(ctx?: PiPackageContext) {
    const s = active;
    if (s?.footerOn && current(s) && (!ctx || s.ctx.sessionManager === ctx.sessionManager)) return footer;
  }
  onDisplay('before_provider_request', (_event, ctx) => subscriptionFooter(ctx)?.requestStarted(ctx));
  onDisplay('after_provider_response', (event, ctx) => subscriptionFooter(ctx)?.requestWindows(ctx, event, false));
  onDisplay('provider_stream_event', (event, ctx) => subscriptionFooter(ctx)?.requestWindows(ctx, event, true));
  onDisplay('agent_start', () => {
    segment.refresh();
    footer?.working();
  });
  onDisplay('agent_end', () => {
    segment.refresh();
    footer?.settled();
  });
  registerHud?.('hud', {
    description: 'Local HUD panel: on|off|close|toggle|status|reconnect|help; footer on|off or footer <segment options>',
    async handler(args, ctx) {
      const trimmed = args.trim();
      if (/^footer(?:\s|$)/.test(trimmed)) {
        const options = trimmed.slice('footer'.length).trim();
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
              segment.refresh();
            }
            ctx.ui.notify('HUD: footer_' + options, 'info');
          }
        } else await footer?.command(options, ctx);
        return;
      }
      let message: string;
      // Bare /hud toggles the panel (show/collapse); the panel never opens by itself.
      const command = trimmed || 'toggle';
      try {
        if (!['on', 'off', 'close', 'toggle', 'status', 'reconnect', 'help'].includes(command))
          message = 'unknown_subcommand; use on|off|close|toggle|status|reconnect|help';
        else if (command === 'help')
          message =
            'Panel: bare /hud shows or collapses the shared herdr dock; on|off|close|toggle|status|reconnect|help (off collapses, close stops). Footer: footer on|off restores/hides the HUD frame independently; footer <segment options>. Reconnect rebinds a canceled transition.';
        else if (command === 'reconnect') {
          await start(ctx);
          message = active ? 'reconnected' : 'session_unbound';
        } else {
          const s = active;
          if (env.HUD_JOB_DIR !== undefined) message = 'panel_worker_forbidden';
          else if (!s || !current(s) || ctx.sessionManager !== s.ctx.sessionManager) message = 'session_unbound; use /hud reconnect';
          else if (!isPiTui(ctx)) message = 'panel_noninteractive; role_tools_available';
          else if (!herdrEndpoint(env)) message = 'panel_dock_unavailable; use hud panel --here';
          else message = await panel(s, command === 'on' ? 'open' : command === 'off' ? 'hide' : (command as PanelOperation));
        }
      } catch (error) {
        message = reason(error);
      }
      ctx.ui.notify('HUD: ' + message, 'info');
    },
  });
  if (mode !== 'delegate') return;
  // A slash command, never a model tool. The display package need not be loaded.
  if (!env.HUD_JOB_DIR && typeof pi.sendUserMessage === 'function') pi.registerCommand('council', {
    description: 'Authorize one council and submit its request',
    async handler(args, ctx) {
      if (!args.trim()) return ctx.ui.notify('Usage: /council <request>', 'info');
      if (!active || !current(active) || active.ctx.sessionManager !== ctx.sessionManager)
        return ctx.ui.notify('HUD: session_unbound', 'warning');
      await allowCouncil(binding.hudHome, 'pi');
      pi.sendUserMessage(`Start a HUD council for this request:\n\n${args.trim()}`, { deliverAs: 'followUp' });
    },
  });
  const expUsage = piExpUsage(binding.hudHome);
  on('context', expUsage.requestStart);
  on('message_end', expUsage.messageEnd);
  on('turn_end', expUsage.turnEnd);
  // Advisor shadow: main-session input and reply boundaries, never prompt injection.
  let lastAssistant: { session: string; text: string } | undefined;
  let lastOwner: { session: string; text: string } | undefined;
  const extractAssistantText = (message: unknown): string => {
    const m = message as { role?: unknown; content?: unknown } | undefined;
    if (m?.role !== 'assistant') return '';
    if (typeof m.content === 'string') return m.content.trim();
    if (!Array.isArray(m.content)) return '';
    return m.content
      .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
  };
  on('message_end', (event, ctx) => {
    const text = extractAssistantText((event as { message?: unknown } | undefined)?.message);
    if (text) lastAssistant = { session: ctx.sessionManager.getSessionId(), text: text.slice(0, 2000) };
  });
  on('input', (event, ctx) => {
    if (env.HUD_JOB_DIR !== undefined || resumeRefusal) return;
    const ev = event as { text?: unknown; source?: unknown } | undefined;
    if (typeof ev?.text !== 'string') return;
    if (ev.source !== undefined && ev.source !== 'interactive') return;
    const trimmed = ev.text.trim();
    if (!trimmed || trimmed.startsWith('/')) return;
    const session = ctx.sessionManager.getSessionId();
    lastOwner = { session, text: scrubSecrets(trimmed).slice(0, 2000) };
    let previousReply = lastAssistant?.session === session ? lastAssistant.text : '';
    if (!previousReply) {
      try {
        const branch = ctx.sessionManager.getBranch?.() ?? [];
        for (let i = branch.length - 1; i >= 0; i--) {
          const text = extractAssistantText(branch[i]?.message);
          if (text) {
            previousReply = text.slice(0, 2000);
            break;
          }
        }
      } catch {
        /* Best-effort previous reply lookup. */
      }
    }
    void adviseOnMessage(
      binding.hudHome,
      {
        session,
        projectRoot: resolveAdvisorProjectRoot(ctx.cwd),
        message: trimmed,
        previousReply: previousReply || undefined,
      },
      { env }
    ).catch(() => {});
  });
  on('agent_end', (event, ctx) => {
    if (env.HUD_JOB_DIR !== undefined || resumeRefusal || !lastOwner) return;
    const session = ctx.sessionManager.getSessionId();
    if (lastOwner.session !== session) return;
    const { messages } = (event ?? {}) as { messages?: Array<{ role?: string; stopReason?: string }> };
    const last = messages?.filter((message) => message.role === 'assistant').at(-1);
    if (last?.stopReason && last.stopReason !== 'stop' && last.stopReason !== 'length') return;
    const reply = extractAssistantText(last);
    const replyId = ctx.sessionManager.getLeafId();
    if (!reply || !replyId) return;
    void adviseOnReply(binding.hudHome, { session, projectRoot: ctx.cwd, message: lastOwner.text, reply, replyId }, { env });
  });
  for (const tool of PI_ROLE_TOOLS)
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(_callId, args, signal, _onUpdate, ctx) {
        if (resumeRefusal) throw Error(resumeRefusal);
        const s = active;
        if (!s || !current(s) || ctx.sessionManager !== s.ctx.sessionManager) throw Error('pi_session_inactive');
        signal?.throwIfAborted();
        const result = await s.client.call(tool.name, args);
        // Pass compact text through. JSON errors and the optional JSON result mode still expose details.
        // The ticket guide is Markdown, with changes (if any) in a separate block.
        const guide = tool.name === 'hud_tickets' && !result.isError && (args.op === undefined || args.op === 'guide');
        const text = result.content[guide ? 1 : 0]?.text;
        return { ...result, details: text?.startsWith('{') ? JSON.parse(text) : {} };
      },
    });
}
