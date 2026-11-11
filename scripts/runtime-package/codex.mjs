/** Row 9 only: lossless TOML append and collision-free skill, using A1's unchanged transaction. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { digest } from './safety.mjs';
export const CODEX_LIMITATION =
  'HUD role calls are unavailable in this Codex connection because HUD cannot verify the calling thread. Passive HUD observation remains available.';
const absolute = (s) =>
  typeof s === 'string' && path.isAbsolute(s) && path.resolve(s) === s && !/[\x00-\x1f\x7f]/.test(s);
const atOrBelow = (child, parent) =>
  child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
export function codexSteps(bundle, options, observe) {
  const { codexHome, skillDirectory, proof, node, executable } = options.codex ?? {};
  for (const p of [options.hudHome, codexHome, skillDirectory, node, executable])
    if (!absolute(p)) throw Error('explicit_canonical_codex_targets_required');
  if (atOrBelow(options.hudHome, codexHome) || atOrBelow(codexHome, options.hudHome))
    throw Error('hud_codex_home_overlap_refused');
  if (fs.realpathSync(node) !== node || !fs.statSync(node).isFile()) throw Error('approved_node_required');
  if (
    proof?.status !== 'PASS' ||
    proof.schema !== 1 ||
    proof.executable !== executable ||
    proof.executableHash !== digest(fs.readFileSync(executable)) ||
    proof.codexHome !== codexHome ||
    proof.skillDirectory !== skillDirectory ||
    proof.scope !== 'user' ||
    proof.nativeDiscovery !== true ||
    !proof.version
  )
    throw Error('codex_skill_probe_required');
  // Client-owned config is the sole Codex-home write. Skill resources live in the independently probed user directory.
  if (atOrBelow(skillDirectory, codexHome)) throw Error('hud_resources_under_codex_home_refused');
  const file = path.join(codexHome, 'config.toml');
  const state = observe(file);
  if (!['file', 'absent'].includes(state.kind)) throw Error('codex_config_file_required');
  const bytes = state.kind === 'file' ? fs.readFileSync(file) : Buffer.alloc(0);
  if (state.kind === 'file' && digest(bytes) !== state.sha256) throw Error('codex_config_changed');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw Error('codex_config_utf8_required');
  // Use the already locked parser; never serialize the user's document.
  const { parse } = createRequire(import.meta.url)('@iarna/toml');
  let value;
  try {
    value = parse(text);
  } catch {
    throw Error('invalid_or_duplicate_codex_toml');
  }
  const contains = (v) =>
    v && typeof v === 'object' && (Object.hasOwn(v.mcp_servers ?? {}, 'hud-mcp') || Object.values(v).some(contains));
  if (contains(value)) throw Error('codex_server_name_collision');
  const skillRoot = path.join(skillDirectory, 'hud-delegate');
  if (observe(skillRoot).kind !== 'absent') throw Error('codex_skill_collision');
  const skill = bundle.directory.read('integrations/skills/hud-delegate/SKILL.md').data;
  if (
    bundle.manifest.entries.find((e) => e.path === 'integrations/skills/hud-delegate/SKILL.md')?.sha256 !==
    digest(skill)
  )
    throw Error('codex_skill_hash_mismatch');
  const release = path.join(options.prefix, 'releases', options.release);
  const q = JSON.stringify;
  const content =
    text +
    (text && !text.endsWith('\n') ? '\n' : '') +
    `\n# Universal HUD: pinned roles surface; restore with the activation receipt.\n[mcp_servers.hud-mcp]\ncommand = ${q(node)}\nargs = [${q(path.join(release, 'packages/hud-mcp/bin/hud-mcp.mjs'))}]\n[mcp_servers.hud-mcp.env]\nHUD_HOME = ${q(options.hudHome)}\nHUD_MCP_SURFACE = "roles"\n`;
  try {
    parse(content);
  } catch {
    throw Error('unsupported_codex_toml_layout');
  }
  const steps = [];
  const directories = new Set();
  for (const target of [codexHome, skillDirectory, skillRoot])
    for (let p = target; observe(p).kind === 'absent'; p = path.dirname(p)) directories.add(p);
  for (const p of [...directories].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)))
    steps.push({ kind: 'private-dir', path: p });
  steps.push({
    kind: 'owned-file',
    path: file,
    content,
    mode: state.identity?.mode ?? 0o600,
    expectedOriginalHash: state.sha256 ?? null,
    confirmation: `Row 9: selected Codex config only. ${CODEX_LIMITATION}`,
  });
  steps.push({
    kind: 'owned-file',
    path: path.join(skillRoot, 'SKILL.md'),
    content: skill.toString('utf8'),
    mode: 0o600,
  });
  return { steps, limitation: CODEX_LIMITATION, skillHash: digest(skill) };
}
