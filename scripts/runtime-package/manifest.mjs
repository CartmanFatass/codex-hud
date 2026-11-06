import { Directory, digest, inventory, relative, MAX_FILE, MAX_TOTAL, MAX_ENTRIES } from './safety.mjs';

export const COMMANDS = {
  hud: 'bin/hud',
  'hud-run': 'bin/hud-run',
  'hud-statusline': 'bin/hud-statusline',
  'codex-hud': 'bin/codex-hud',
  'hud-mcp': 'packages/hud-mcp/bin/hud-mcp.mjs',
};
export const HELPERS = [
  'bin/codex-hud-toggle',
  'bin/codex-hud-tree',
  'bin/codex-hud-resize',
  'bin/codex-hud-herdr.mjs',
  'bin/codex-with-herdr-context',
  'bin/codex-hud-keys',
  'bin/codex-hud-command',
  'bin/codex-hud-paste',
];
export const INSTALLER_FILES = [
  'install-runtime.mjs',
  'runtime-package/safety.mjs',
  'runtime-package/manifest.mjs',
  'runtime-package/installer.mjs',
];
export const DEPENDENCIES = { '@iarna/toml': '2.2.5', chokidar: '5.0.0', readdirp: '5.0.0' };
export const CELLS = [
  'dist/core/launch/codex-cells.json',
  'dist/core/launch/managed-cells.json',
  'packages/hud-mcp/dist/src/core/launch/codex-cells.json',
  'packages/hud-mcp/dist/src/core/launch/managed-cells.json',
];
export const REQUIRED = [
  ...Object.values(COMMANDS),
  ...HELPERS,
  ...INSTALLER_FILES,
  ...CELLS,
  'extensions/pi/hud-footer.ts',
  'extensions/pi/hud-delegate.ts',
  'package.json',
  'packages/hud-mcp/package.json',
  'dist/index.js',
  'dist/tree-page.js',
  'dist/cli/hud.js',
  'dist/cli/statusline.js',
  ...Object.keys(DEPENDENCIES).map((name) => `node_modules/${name}/package.json`),
];
const ROOT_FIELDS = [
  'schemaVersion',
  'repositorySha',
  'repositoryTree',
  'dirty',
  'lockfileSha256',
  'entries',
  'platform',
  'nodeRequirement',
  'sourceContentSha256',
  'builtWithNode',
  'dependencies',
  'provenance',
  'capabilityLimitation',
];
const ENTRY_FIELDS = ['path', 'bytes', 'sha256', 'mode', 'origin', 'provenance'];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('unknown_or_invalid_manifest_fields');
}
function annotation(value, limit) {
  if (typeof value !== 'string' || !value.length || value.includes('\0'))
    throw new Error('invalid_manifest_annotation');
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('invalid_manifest_unicode');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('invalid_manifest_unicode');
  }
  const length = Buffer.byteLength(value);
  if (length > limit) throw new Error('manifest_annotation_limit');
  return length;
}
export function parseManifest(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_FILE) throw new Error('manifest_byte_limit');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  fields(value, ROOT_FIELDS);
  if (
    value.schemaVersion !== 1 ||
    !hex(value.repositorySha, 40) ||
    !hex(value.repositoryTree, 40) ||
    typeof value.dirty !== 'boolean' ||
    !hex(value.lockfileSha256, 64) ||
    !Array.isArray(value.entries) ||
    value.entries.length < 1 ||
    value.entries.length > MAX_ENTRIES
  )
    throw new Error('invalid_runtime_manifest');
  if (
    ('platform' in value && value.platform !== 'linux') ||
    ('nodeRequirement' in value && value.nodeRequirement !== '^22.13.0 || ^24.0.0') ||
    ('sourceContentSha256' in value && !hex(value.sourceContentSha256, 64))
  )
    throw new Error('invalid_runtime_metadata');
  if (
    'builtWithNode' in value &&
    (typeof value.builtWithNode !== 'string' ||
      Buffer.byteLength(value.builtWithNode) > 128 ||
      !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
        value.builtWithNode
      ))
  )
    throw new Error('invalid_node_metadata');
  if ('builtWithNode' in value) {
    const core = value.builtWithNode.split('+', 1)[0];
    const separator = core.indexOf('-');
    if (
      separator !== -1 &&
      core
        .slice(separator + 1)
        .split('.')
        .some((part) => /^[0-9]+$/.test(part) && !/^(0|[1-9][0-9]*)$/.test(part))
    )
      throw new Error('invalid_node_metadata');
  }
  if ('dependencies' in value) {
    fields(value.dependencies, Object.keys(DEPENDENCIES));
    if (
      Object.keys(value.dependencies).length !== 3 ||
      Object.entries(DEPENDENCIES).some(([name, version]) => value.dependencies[name] !== version)
    )
      throw new Error('invalid_dependency_metadata');
  }
  let textBytes = 0;
  for (const key of ['provenance', 'capabilityLimitation']) if (key in value) textBytes += annotation(value[key], 4096);
  let total = 0;
  const names = new Set();
  for (const entry of value.entries) {
    fields(entry, ENTRY_FIELDS);
    relative(entry.path);
    if (entry.path === 'RUNTIME-MANIFEST.json' || names.has(entry.path)) throw new Error('duplicate_or_reserved_entry');
    if (
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > MAX_FILE ||
      !hex(entry.sha256, 64) ||
      !['0600', '0700'].includes(entry.mode)
    )
      throw new Error('invalid_runtime_entry');
    if ('origin' in entry) textBytes += annotation(entry.origin, 1024);
    if ('provenance' in entry) textBytes += annotation(entry.provenance, 4096);
    if (textBytes > 262144) throw new Error('manifest_annotation_total_limit');
    names.add(entry.path);
    total += entry.bytes;
  }
  if (total > MAX_TOTAL) throw new Error('bundle_size_limit');
  for (const name of REQUIRED) if (!names.has(name)) throw new Error(`missing_required_entry: ${name}`);
  return value;
}
export function verifyBundle(root) {
  const directory = new Directory(root, true);
  try {
    const manifestFile = directory.read('RUNTIME-MANIFEST.json');
    if (manifestFile.mode !== 0o600 || manifestFile.identity.uid !== process.getuid())
      throw new Error('unsafe_manifest_mode');
    const raw = manifestFile.data;
    const manifest = parseManifest(raw);
    const listed = [...manifest.entries.map((entry) => entry.path), 'RUNTIME-MANIFEST.json'].sort();
    if (JSON.stringify(inventory(directory, listed)) !== JSON.stringify(listed))
      throw new Error('unlisted_or_missing_bundle_entry');
    for (const entry of manifest.entries) {
      const { data, mode } = directory.read(entry.path);
      if (
        data.length !== entry.bytes ||
        digest(data) !== entry.sha256 ||
        mode.toString(8).padStart(4, '0') !== entry.mode
      )
        throw new Error(`bundle_integrity_mismatch: ${entry.path}`);
    }
    for (const [name, version] of Object.entries(DEPENDENCIES)) {
      const pkg = JSON.parse(directory.read(`node_modules/${name}/package.json`).data);
      if (pkg.name !== name || pkg.version !== version) throw new Error('dependency_identity_mismatch');
    }
    if (JSON.stringify(inventory(directory, listed)) !== JSON.stringify(listed))
      throw new Error('bundle_changed_during_verification');
    directory.assert();
    return { root, manifest, raw, digest: digest(raw), directory };
  } catch (error) {
    directory.close();
    throw error;
  }
}
export function copyBundle(bundle, destination) {
  const target = new Directory(destination, true);
  try {
    const directories = new Set();
    for (const entry of bundle.manifest.entries) {
      const parts = entry.path.split('/');
      parts.pop();
      let name = '';
      for (const part of parts) {
        name = name ? `${name}/${part}` : part;
        if (!directories.has(name)) {
          target.mkdir(name);
          directories.add(name);
        }
      }
      const { data, mode } = bundle.directory.read(entry.path);
      if (
        data.length !== entry.bytes ||
        digest(data) !== entry.sha256 ||
        mode.toString(8).padStart(4, '0') !== entry.mode
      )
        throw new Error('source_changed_during_copy');
      target.write(entry.path, data, mode);
    }
    if (digest(bundle.directory.read('RUNTIME-MANIFEST.json').data) !== bundle.digest)
      throw new Error('manifest_changed_during_copy');
    target.write('RUNTIME-MANIFEST.json', bundle.raw);
  } finally {
    target.close();
  }
  const staged = verifyBundle(destination);
  try {
    if (staged.digest !== bundle.digest) throw new Error('staged_digest_mismatch');
  } finally {
    staged.directory.close();
  }
}
