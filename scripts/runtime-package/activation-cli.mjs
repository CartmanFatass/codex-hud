/** Shared bundle-bootstrap and HUD CLI parser. No prompts or client launches. */
import * as path from 'node:path';
import { planActivation, applyActivation, planDeactivation, restoreActivation } from './activation.mjs';
export const ACTIVATION_HELP = `Reversible activation (Linux, Node 22.13+ within 22.x, or 24.x).
hud install preview --prefix ABS --release DIGEST [--hud-home ABS] [--shim-dir ABS] [--rc-file ABS]
hud install apply --plan ID (repeat the exact preview options)
hud install restore --receipt ABS
hud uninstall preview --receipt ABS
hud uninstall apply --receipt ABS --plan ID
First install: node BUNDLE/install-runtime.mjs preview --prefix ABS --stage-only yes;
node BUNDLE/install-runtime.mjs stage --prefix ABS --expect ID;
node BUNDLE/activate-runtime.mjs install preview|apply (same activation options).
Prefix must exist privately (0700). HUD_HOME defaults to ~/.hud; shims to ~/.local/bin.
No rc edit by default. Plans are read-only; receipts/backups under HUD_HOME/installation
are retained by restore/uninstall. Only hud, hud-statusline and hud-mcp are published.
No client configuration, model, panel, browser, dependency or credential setup.
`;
export function activationCommand(args, env = process.env) {
  if (args.length === 0 || args.at(-1) === '--help') return ACTIVATION_HELP;
  const [operation, command, ...rest] = args;
  if (
    !['install', 'uninstall'].includes(operation) ||
    !['preview', 'apply', ...(operation === 'install' ? ['restore'] : [])].includes(command) ||
    rest.length % 2
  )
    throw new Error('invalid_activation_arguments; use --help');
  const options = {};
  const allowed =
    operation === 'uninstall' || command === 'restore'
      ? ['--receipt', '--plan']
      : ['--prefix', '--release', '--hud-home', '--shim-dir', '--rc-file', '--plan'];
  for (let i = 0; i < rest.length; i += 2) {
    if (!allowed.includes(rest[i]) || Object.hasOwn(options, rest[i]) || !rest[i + 1])
      throw new Error('invalid_activation_option');
    options[rest[i]] = rest[i + 1];
  }
  if ((command === 'apply' && !options['--plan']) || (command !== 'apply' && options['--plan']))
    throw new Error('exact_plan_required_for_apply_only');
  if (operation === 'uninstall' || command === 'restore') {
    if (!options['--receipt']) throw new Error('receipt_required');
    return command === 'preview'
      ? planDeactivation(options['--receipt'])
      : restoreActivation(options['--receipt'], options['--plan'], { recoverLocks: command === 'restore' });
  }
  if (!env.HOME || !options['--prefix'] || !options['--release']) throw new Error('home_prefix_release_required');
  const input = {
    prefix: options['--prefix'],
    release: options['--release'],
    hudHome: options['--hud-home'] ?? env.HUD_HOME ?? path.join(env.HOME, '.hud'),
    shimDir: options['--shim-dir'] ?? path.join(env.HOME, '.local/bin'),
    ...(options['--rc-file'] ? { rcFile: options['--rc-file'] } : {}),
    path: env.PATH ?? '',
  };
  return command === 'preview' ? planActivation(input) : applyActivation(input, options['--plan']);
}
