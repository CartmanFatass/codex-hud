/** Explicit opt-in for @earendil-works/pi-coding-agent 1.4.0, commit 4a080252.
 * Build HUD + hud-mcp, configure one pi_extension_v1 profile, then load with -e.
 * No settings writes, native tool interception, or capability promotion.
 */
import { VERSION, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import { createRequire } from 'node:module';
import { PiDelegationBridge } from '../../dist/harness/pi/delegation-bridge.js';
// Consume the single shipped schema set. hud-mcp intentionally emits no declarations.
const { TOOLS } = createRequire(import.meta.url)('../../packages/hud-mcp/dist/packages/hud-mcp/src/tools.js') as {
  TOOLS: { name: string; description: string; inputSchema: Record<string, unknown> }[];
};

export default function hudDelegate(pi: ExtensionAPI) {
  if (VERSION !== '1.4.0') throw new Error('HUD delegation requires Pi 1.4.0');
  let bridge: PiDelegationBridge | null = null;
  let root: string | null = null;
  let generation = 0;
  let stopping: Promise<void> = Promise.resolve();
  const stop = () => {
    const current = bridge;
    ++generation;
    stopping = Promise.all([stopping, current?.stop()]).then(() => {});
    return stopping;
  };
  pi.on('session_start', async (_event, ctx) => {
    // This event covers startup, reload, new, resume and fork in the pinned API.
    // The source directory comes from the host, never tool input or PI_SESSION_*.
    const closed = stop();
    const epoch = generation;
    await closed;
    if (epoch !== generation) return;
    const nextRoot = ctx.sessionManager.getSessionDir();
    if (!bridge || root !== nextRoot) {
      root = nextRoot;
      bridge = new PiDelegationBridge({ sourceRoot: root, env: process.env, cwd: ctx.cwd });
    }
    await bridge.start();
  });
  pi.on('session_before_switch', stop);
  pi.on('session_before_fork', stop);
  pi.on('session_before_tree', stop);
  pi.on('session_tree', async () => {
    await bridge?.start();
  });
  pi.on('session_shutdown', stop);
  pi.registerCommand('hud-delegate', {
    description: 'Reconnect a fenced HUD delegation bridge, or close it: /hud-delegate [reconnect|close]',
    handler: async (args, ctx) => {
      const command = args.trim() || 'reconnect';
      if (command === 'close') {
        await stop();
        return;
      }
      if (command !== 'reconnect') throw new Error('Usage: /hud-delegate [reconnect|close]');
      // A cancelled switch/fork/tree has no completion event. Only an explicit user
      // command or a subsequent session event re-enables its conservatively fenced bridge.
      const closed = stop();
      const epoch = generation;
      await closed;
      if (generation !== epoch) return;
      const nextRoot = ctx.sessionManager.getSessionDir();
      if (!bridge || root !== nextRoot) {
        root = nextRoot;
        bridge = new PiDelegationBridge({ sourceRoot: root, env: process.env, cwd: ctx.cwd });
      }
      await bridge.start();
    },
  });
  for (const tool of TOOLS) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as TSchema,
      async execute(callId, args, signal, _onUpdate, ctx) {
        if (!bridge) throw new Error('HUD delegation is inactive; start or reload the Pi session.');
        const result = await bridge.execute(tool.name, callId, args as Record<string, unknown>, signal, ctx);
        if (result.isError)
          throw new Error(JSON.stringify(result.structuredContent ?? { ok: false, code: 'identity_unverified' }));
        return { content: result.content, details: result.structuredContent };
      },
    });
  }
}
