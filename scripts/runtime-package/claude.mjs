/** A4: deterministic generated client steps from an already verified immutable bundle. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { digest, json } from './safety.mjs';
export const CLAUDE_TEMPLATES = [
  'plugin.template.json',
  'mcp.template.json',
  'hooks/hooks.template.json',
  'binding.template.json',
  'commands/hud.md',
  'commands/setup.md',
  'scripts/hook.mjs',
  'scripts/mcp.mjs',
  'scripts/binding.mjs',
].map((name) => 'integrations/claude/' + name);
function parse(bytes) {
  try {
    return JSON.parse(bytes);
  } catch {
    throw new Error('invalid_claude_template');
  }
}
const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
const absolute = (s) =>
  typeof s === 'string' && path.isAbsolute(s) && path.resolve(s) === s && !/[\x00-\x1f\x7f]/.test(s);
export function claudeSteps(bundle, options) {
  const config = options.claude;
  if (
    !config ||
    !absolute(config.node) ||
    fs.realpathSync(config.node) !== config.node ||
    !fs.statSync(config.node).isFile()
  )
    throw new Error('approved_node_required');
  if (config.parityInventory && !absolute(config.parityInventory)) throw new Error('invalid_parity_inventory_path');
  const template = (name) => bundle.directory.read('integrations/claude/' + name).data.toString('utf8');
  const binding = parse(template('binding.template.json'));
  Object.assign(binding, {
    version: 1,
    release: path.join(options.prefix, 'releases', options.release),
    digest: options.release,
    releaseVersion: bundle.manifest.releaseVersion ?? parse(bundle.directory.read('package.json').data).version,
    node: config.node,
    hudHome: options.hudHome,
    parityInventory: config.parityInventory ?? null,
  });
  const integrationId = digest(json(binding));
  const root = path.join(options.hudHome, 'installation/integrations', integrationId);
  const plugin = path.join(root, 'claude');
  const files = new Map();
  const manifest = parse(template('plugin.template.json'));
  manifest.version = binding.releaseVersion;
  if (manifest.name !== 'hud' || 'statusLine' in manifest || 'hooks' in manifest)
    throw new Error('invalid_claude_manifest');
  files.set('.claude-plugin/plugin.json', json(manifest).toString());
  const mcp = parse(template('mcp.template.json'));
  mcp.mcpServers['hud-mcp'].command = binding.node;
  files.set('.mcp.json', json(mcp).toString());
  const hooks = parse(template('hooks/hooks.template.json'));
  for (const groups of Object.values(hooks.hooks))
    for (const group of groups)
      for (const hook of group.hooks) hook.command = hook.command.replace('APPROVED_NODE_QUOTED', quote(binding.node));
  files.set('hooks/hooks.json', json(hooks).toString());
  files.set('binding.json', json(binding).toString());
  files.set('README.md', bundle.directory.read('integrations/claude/README.md').data.toString('utf8'));
  for (const name of [
    'commands/hud.md',
    'commands/setup.md',
    'scripts/hook.mjs',
    'scripts/mcp.mjs',
    'scripts/binding.mjs',
  ])
    files.set(name, template(name));
  files.set(
    'skills/hud-delegate/SKILL.md',
    bundle.directory.read('integrations/skills/hud-delegate/SKILL.md').data.toString('utf8')
  );
  const directories = new Set([root, plugin]);
  for (const name of files.keys())
    for (let p = path.dirname(path.join(plugin, name)); p.startsWith(plugin); p = path.dirname(p)) directories.add(p);
  const steps = [...directories]
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .map((p) => ({ kind: 'private-dir', path: p }));
  for (const [name, content] of files)
    steps.push({ kind: 'owned-file', path: path.join(plugin, name), content, mode: 0o600 });
  if (config.alias) throw new Error('alias_NOT_VERIFIED_use_separate_alias_preview');
  return { integrationId, plugin, steps, binding, skillHash: digest(files.get('skills/hud-delegate/SKILL.md')) };
}
/** Separate alias owner step. Evidence is emitted only by the isolated real-CLI probe. */
export function aliasStep(home, evidence, plugin) {
  if (
    !absolute(home) ||
    evidence?.status !== 'PASS' ||
    !['missingBinding', 'missingModule', 'nonzero', 'missingNode'].every(
      (k) => evidence?.negativeControls?.[k] === true
    ) ||
    !['canonical', 'alias', 'setup'].every((k) => evidence?.commands?.[k] === 0) ||
    !Number.isSafeInteger(evidence?.ordinaryRequests) ||
    evidence.ordinaryRequests < 1 ||
    evidence?.plugin !== plugin ||
    !evidence.pluginHashes ||
    Object.entries(evidence.pluginHashes).some(
      ([file, hash]) =>
        ![
          '.claude-plugin/plugin.json',
          'hooks/hooks.json',
          'commands/hud.md',
          'scripts/hook.mjs',
          'scripts/binding.mjs',
          'scripts/mcp.mjs',
          '.mcp.json',
        ].includes(file) || digest(fs.readFileSync(path.join(plugin, file))) !== hash
    ) ||
    ![
      '.claude-plugin/plugin.json',
      'hooks/hooks.json',
      'commands/hud.md',
      'scripts/hook.mjs',
      'scripts/binding.mjs',
      'scripts/mcp.mjs',
      '.mcp.json',
    ].every((file) => evidence.pluginHashes[file])
  )
    throw new Error('alias_NOT_VERIFIED');
  const target = path.join(home, '.claude/commands/hud.md');
  try {
    fs.lstatSync(target);
    throw new Error('alias_collision');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (fs.existsSync(path.dirname(target)) && fs.lstatSync(path.dirname(target)).isSymbolicLink())
    throw new Error('alias_collision');
  return {
    kind: 'owned-file',
    path: target,
    content: fs.readFileSync(path.join(plugin, 'commands/hud.md'), 'utf8'),
    mode: 0o600,
  };
}
