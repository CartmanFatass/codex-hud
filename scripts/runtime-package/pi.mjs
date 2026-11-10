/** A5 declarative materialization and separately approved personal settings/preference steps. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { digest, json } from './safety.mjs';
// observe() is supplied by activation to avoid a manifest -> generator -> activation cycle.
export const PI_TEMPLATES = ['package.template.json', 'binding.template.json', 'binding.mjs', 'extensions/hud.mjs'].map(
  (name) => 'integrations/pi/package/' + name
);
const absolute = (s) =>
  typeof s === 'string' && path.isAbsolute(s) && path.resolve(s) === s && !/[\x00-\x1f\x7f]/.test(s);
export function piSteps(bundle, options) {
  const node = options.pi?.node;
  if (!absolute(node) || fs.realpathSync(node) !== node || !fs.statSync(node).isFile())
    throw Error('approved_node_required');
  const template = (name) => bundle.directory.read('integrations/pi/package/' + name).data.toString('utf8');
  const binding = Object.assign(JSON.parse(template('binding.template.json')), {
    version: 1,
    release: path.join(options.prefix, 'releases', options.release),
    digest: options.release,
    releaseVersion: bundle.manifest.releaseVersion ?? JSON.parse(bundle.directory.read('package.json').data).version,
    node,
    hudHome: options.hudHome,
  });
  const integrationId = digest(json({ pi: binding }));
  const root = path.join(options.hudHome, 'installation/integrations', integrationId);
  const piPackage = path.join(root, 'pi');
  const manifest = JSON.parse(template('package.template.json'));
  manifest.version = binding.releaseVersion;
  if (
    manifest.name !== 'hud' ||
    !manifest.keywords.includes('pi-package') ||
    manifest.dependencies ||
    JSON.stringify(manifest.pi) !==
      JSON.stringify({ extensions: ['./extensions/hud.mjs'], skills: ['./skills/hud-delegate/SKILL.md'] })
  )
    throw Error('invalid_pi_manifest');
  const skillName = 'integrations/skills/hud-delegate/SKILL.md';
  const skill = bundle.directory.read(skillName).data;
  const skillHash = digest(skill);
  if (bundle.manifest.entries.find((e) => e.path === skillName)?.sha256 !== skillHash)
    throw Error('pi_skill_hash_mismatch');
  const files = new Map([
    ['package.json', json(manifest).toString()],
    ['binding.json', json(binding).toString()],
    ['binding.mjs', template('binding.mjs')],
    ['extensions/hud.mjs', template('extensions/hud.mjs')],
    ['skills/hud-delegate/SKILL.md', skill.toString('utf8')],
    ['README.md', bundle.directory.read('integrations/pi/package/README.md').data.toString('utf8')],
  ]);
  const directories = new Set([root, piPackage]);
  for (const name of files.keys())
    for (let p = path.dirname(path.join(piPackage, name)); p.startsWith(piPackage); p = path.dirname(p))
      directories.add(p);
  const steps = [...directories]
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .map((p) => ({ kind: 'private-dir', path: p }));
  for (const [name, content] of files)
    steps.push({ kind: 'owned-file', path: path.join(piPackage, name), content, mode: 0o600 });
  return { integrationId, piPackage, steps, binding, skillHash };
}
function object(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}
function document(file, observe) {
  const state = observe(file);
  if (!['absent', 'file'].includes(state.kind)) throw Error('client_config_file_required');
  let value = {};
  if (state.kind === 'file') {
    const bytes = fs.readFileSync(file);
    if (digest(bytes) !== state.sha256) throw Error('client_config_changed');
    value = JSON.parse(bytes);
    if (!object(value)) throw Error('unsupported_client_config');
  }
  return { state, value };
}
function step(file, value, state, confirmation) {
  return {
    kind: 'owned-file',
    path: file,
    content: json(value).toString(),
    mode: state.identity?.mode ?? 0o600,
    expectedOriginalHash: state.sha256 ?? null,
    confirmation,
  };
}
/** Row 7 only. Does not silently disable historical opt-ins, dereference symlinks, or add MCP. */
export function piSettingsStep(file, piPackage, observe) {
  if (!absolute(file) || !absolute(piPackage)) throw Error('canonical_absolute_target_required');
  const { state, value } = document(file, observe);
  const packages = value.packages ?? [];
  if (
    !Array.isArray(packages) ||
    packages.some((v) => !(typeof v === 'string' || (object(v) && typeof v.source === 'string')))
  )
    throw Error('unsupported_pi_packages');
  if (packages.some((v) => (typeof v === 'string' ? v : v.source) === piPackage))
    throw Error('pi_package_already_selected');
  // Resource selection belongs to an explicit separate owner edit. Refuse known conflicts, do not rewrite it.
  if (
    packages.some((v) =>
      /\/installation\/integrations\/[a-f0-9]{64}\/pi\/?$/.test(typeof v === 'string' ? v : v.source)
    )
  )
    throw Error('existing_hud_package_requires_owner_resource_preview');
  const text = JSON.stringify(value);
  if (/hud-footer\.[cm]?[jt]s|hud-delegate\.[cm]?[jt]s/.test(text))
    throw Error('conflicting_hud_opt_in_requires_owner_edit');
  return step(
    file,
    { ...value, packages: [...packages, piPackage] },
    state,
    'Row 7: add this exact pinned local pi package; no MCP entry; reload only at owner boundary.'
  );
}
/** Row 10 only, under HUD_HOME; no standalone footer activation in this slice. */
export function piPreferenceStep(hudHome, enabled, observe) {
  if (!absolute(hudHome) || typeof enabled !== 'boolean') throw Error('invalid_panel_preference');
  const file = path.join(hudHome, 'integration-config.json');
  const { state, value } = document(file, observe);
  return step(
    file,
    { ...value, panelAutoOpen: enabled },
    state,
    'Row 10: change only persistent panel auto-open; off command stays session-local.'
  );
}
