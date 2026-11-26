/** Tab-only worker UI entry: mounts HUD's own footer (`createP10kFooter`) with native t/s. Headless never loads this module. */
import { createP10kFooter } from '../p10k-footer.js';
import type { FooterAPI, FooterContext, FooterHost } from '../footer-host.js';

export interface WorkerUiApi extends FooterAPI {
  on(event: string, handler: (event: unknown, ctx: FooterContext) => void): (() => void) | void;
}

export function installWorkerUi(
  pi: WorkerUiApi,
  host: FooterHost,
  env: NodeJS.ProcessEnv = process.env,
  deps?: Parameters<typeof createP10kFooter>[3]
) {
  const footer = createP10kFooter(pi, host, env, deps);
  const removers: (() => void)[] = [];
  const on = (event: string, handler: (event: unknown, ctx: FooterContext) => void) => {
    const remove = pi.on(event, handler);
    if (remove) removers.push(remove);
  };
  on('session_start', (_event, ctx) => {
    if (ctx.mode === 'tui' && ctx.hasUI) footer.start(ctx);
  });
  for (const event of ['session_before_switch', 'session_before_fork', 'session_before_tree']) {
    on(event, () => footer.stop());
  }
  on('session_tree', (_event, ctx) => {
    if (ctx.mode === 'tui' && ctx.hasUI) footer.start(ctx);
  });
  on('session_shutdown', () => {
    footer.dispose();
    for (const remove of removers.splice(0)) remove();
  });
  for (const event of [
    'thinking_level_select',
    'agent_settled',
    'message_end',
    'turn_end',
    'context',
    'session_compact',
    'session_compact_failed',
    'session_info_changed',
  ]) {
    on(event, () => footer.update());
  }
  on('model_select', () => {
    footer.modelChanged();
    footer.update();
  });
  on('before_provider_request', (_event, ctx) => footer.requestStarted(ctx));
  on('after_provider_response', (event, ctx) => footer.requestWindows(ctx, event, false));
  on('provider_stream_event', (event, ctx) => footer.requestWindows(ctx, event, true));
  on('agent_start', () => footer.working());
  on('agent_end', () => footer.settled());
  return footer;
}
