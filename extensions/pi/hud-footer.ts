/** Pi v1.4.0 public UI contract, source 4a080252f06caf63a525d7873c5d94d3c23887e0.
 * Build HUD first, then explicitly load: pi -e /path/to/codex-hud/extensions/pi/hud-footer.ts
 * This entry never installs itself, changes settings or grants managed capabilities.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createPiFooterController, createPiDelegationSummaryProvider } from '../../dist/harness/pi/footer.js';

export default function hudFooter(pi: ExtensionAPI) {
  // Explicit HUD_HOME + HUD_PI_SOURCE_ROOT, corroborated against the current native session location.
  const footer = createPiFooterController({ summary: createPiDelegationSummaryProvider(process.env) });
  pi.on('session_start', (_event, ctx) => footer.start(ctx));
  pi.on('session_tree', (_event, ctx) => footer.update(ctx));
  pi.on('session_compact', (_event, ctx) => footer.update(ctx));
  pi.on('message_end', (_event, ctx) => footer.update(ctx));
  pi.on('model_select', (_event, ctx) => footer.update(ctx));
  pi.on('thinking_level_select', (_event, ctx) => footer.update(ctx));
  pi.on('agent_start', (_event, ctx) => footer.update(ctx));
  pi.on('agent_end', (_event, ctx) => footer.update(ctx));
  pi.on('session_shutdown', () => footer.shutdown());
  pi.registerCommand('hud-footer', {
    description: 'Toggle the read-only HUD footer: /hud-footer [on|off]',
    handler: async (args, ctx) => {
      if (ctx.mode !== 'tui' || !ctx.hasUI) return;
      const command = args.trim();
      if (command && command !== 'on' && command !== 'off') {
        ctx.ui.notify('Usage: /hud-footer [on|off]', 'warning');
        return;
      }
      const enabled = command === 'on' || (command !== 'off' && !footer.isEnabled());
      footer.setEnabled(enabled, ctx);
      ctx.ui.notify(enabled ? 'HUD footer enabled' : 'Default footer restored', 'info');
    },
  });
}
