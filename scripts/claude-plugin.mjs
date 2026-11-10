#!/usr/bin/env node
/** Owner-facing A4 activation preview. No native plugin manager or live activation by import. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planActivation, applyActivation, planDeactivation, restoreActivation } from './runtime-package/activation.mjs';
import { aliasStep } from './runtime-package/claude.mjs';
export function claudePluginCommand(args, env = process.env) {
  const [verb = 'preview', ...rest] = args;
  if (!['preview', 'apply', 'restore-preview', 'restore'].includes(verb) || rest.length % 2)
    throw new Error('invalid_claude_activation_arguments');
  const o = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (
      ![
        '--prefix',
        '--release',
        '--hud-home',
        '--shim-dir',
        '--node',
        '--parity-inventory',
        '--alias-proof',
        '--alias-home',
        '--plan',
        '--receipt',
      ].includes(rest[i]) ||
      Object.hasOwn(o, rest[i])
    )
      throw new Error('invalid_claude_activation_option');
    o[rest[i]] = rest[i + 1];
  }
  if (verb.startsWith('restore')) {
    if (!o['--receipt']) throw new Error('explicit_receipt_required');
    if (verb === 'restore' && !o['--plan']) throw new Error('explicit_restore_plan_required');
    return verb === 'restore-preview'
      ? planDeactivation(o['--receipt'])
      : restoreActivation(o['--receipt'], o['--plan']);
  }
  if (!env.HOME || !o['--prefix'] || !o['--release'] || !o['--node'])
    throw new Error('explicit_prefix_release_node_required');
  const options = {
    prefix: o['--prefix'],
    release: o['--release'],
    hudHome: o['--hud-home'] ?? env.HUD_HOME ?? path.join(env.HOME, '.hud'),
    shimDir: o['--shim-dir'] ?? path.join(env.HOME, '.local/bin'),
    path: env.PATH ?? '',
    claude: { node: o['--node'], parityInventory: o['--parity-inventory'] ?? null },
  };
  if (o['--alias-proof']) {
    const file = o['--alias-proof'];
    if (!path.isAbsolute(file) || fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 1024 * 1024)
      throw new Error('invalid_alias_proof');
    let evidence;
    try {
      evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error('invalid_alias_proof');
    }
    const base = planActivation(options);
    const step = aliasStep(o['--alias-home'] ?? env.HOME, evidence, base.plugin);
    const directory = path.dirname(step.path);
    options.steps = [...(fs.existsSync(directory) ? [] : [{ kind: 'private-dir', path: directory }]), step];
  } else if (o['--alias-home']) throw new Error('alias_proof_required');
  if (verb === 'apply') {
    if (!o['--plan']) throw new Error('explicit_plan_required');
    return applyActivation(options, o['--plan']);
  }
  if (o['--plan']) throw new Error('preview_has_no_plan_argument');
  return planActivation(options);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--help')
      console.log(
        'node RELEASE/claude-plugin.mjs preview|apply --prefix ABS --release DIGEST --node ABS [--hud-home ABS] [--shim-dir ABS] [--parity-inventory ABS] [--alias-proof ABS --alias-home ABS] [--plan ID]\nrestore-preview|restore --receipt ABS [--plan ID]\nOnly materializes a HUD-owned plugin and public shims. Native plugin installation is a separate owner step after write-set rehearsal. Bare alias requires a fresh zero-model proof from the isolated CLI probe; collisions are refused.'
      );
    else console.log(JSON.stringify(claudePluginCommand(args), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
