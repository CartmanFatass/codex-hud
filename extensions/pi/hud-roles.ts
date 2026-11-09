/** Six canonical role proxies over the session-owned private fd3 MCP channel.
 * A5 packages this entry; never also register hud-mcp via generic mcp.json.
 * No footer, panel, native-tool interception or execution-host ownership here.
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import { PiDelegationBridge } from '../../dist/harness/pi/delegation-bridge.js';
import { ROLE_TOOLS } from '../../dist/roles/role-tools.js';

export default function hudRoles(pi: ExtensionAPI) {
  let bridge: PiDelegationBridge | null = null;
  let root: string | null = null;
  let generation = 0;
  let closing: Promise<void> = Promise.resolve();
  let active = false;
  const stop = () => {
    ++generation;
    active = false;
    closing = Promise.all([closing, bridge?.stop()]).then(() => {});
    return closing;
  };
  const start = async (ctx: ExtensionContext) => {
    const closed = stop();
    const epoch = generation;
    await closed;
    if (epoch !== generation) return;
    const nextRoot = ctx.sessionManager.getSessionDir();
    if (!bridge || root !== nextRoot) {
      root = nextRoot;
      bridge = new PiDelegationBridge({ sourceRoot: root, env: process.env, cwd: ctx.cwd, surface: 'roles' });
    }
    const next = bridge;
    await next.start();
    if (epoch === generation && bridge === next) active = true;
  };
  pi.on('session_start', async (_event, ctx) => start(ctx));
  pi.on('session_shutdown', stop);
  pi.on('session_before_switch', stop);
  pi.on('session_before_fork', stop);
  pi.on('session_before_tree', stop);
  pi.on('session_tree', async (_event, ctx) => start(ctx));
  pi.registerCommand('hud-roles', {
    description: 'Reconnect after a cancelled session transition: /hud-roles [reconnect|close]',
    handler: async (args, ctx) => {
      const action = args.trim() || 'reconnect';
      if (action === 'close') await stop();
      else if (action === 'reconnect') await start(ctx);
      else throw new Error('Usage: /hud-roles [reconnect|close]');
    },
  });
  for (const tool of ROLE_TOOLS) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as TSchema,
      async execute(callId, args, signal, _onUpdate, ctx) {
        // There is no public cancellation-complete signal. Fresh file evidence alone
        // cannot prove a pending transition cancelled; explicit reconnect is safe.
        if (!active || !bridge) throw new Error('stale_context: /hud-roles reconnect');
        const result = await bridge.execute(tool.name, callId, args as Record<string, unknown>, signal, ctx);
        if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
        return { content: result.content, details: result.structuredContent };
      },
    });
  }
}
