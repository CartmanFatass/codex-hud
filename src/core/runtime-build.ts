import { DEPENDENCIES as RUNTIME_DEPENDENCIES } from './runtime-dependencies.js';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import { canonicalJson } from './canonical.js';
import { parseCapabilityManifest, parseStrictJson } from './capability-manifest.js';
import type { CapabilityManifestV1 } from './types/capabilities.js';

const MAX_FILES = 12000;
const MAX_FILE = 4 * 1024 * 1024;
const MAX_TOTAL = 96 * 1024 * 1024;
export const RUNTIME_CAPABILITY_FILES = [
  'dist/core/launch/codex-cells.json',
  'dist/core/launch/managed-cells.json',
  'packages/hud-mcp/dist/src/core/launch/codex-cells.json',
  'packages/hud-mcp/dist/src/core/launch/managed-cells.json',
] as const;
export const MINIMUM_RUNTIME_FILES = [
  ...RUNTIME_CAPABILITY_FILES,
  'package.json',
  'packages/hud-mcp/package.json',
  'bin/hud-run',
  'packages/hud-mcp/bin/hud-mcp.mjs',
  'packages/hud-mcp/bin/surface.mjs',
  'dist/cli/roster.js',
  'dist/cli/setup.js',
  'dist/cli/wait.js',
  'dist/cli/hud-main.js',
  'dist/cli/private-home.js',
  'dist/cli/import.js',
  'dist/hud-home.js',
  'dist/roles/adapters.js',
  'dist/roles/association.js',
  'dist/roles/caller.js',
  'dist/roles/facade.js',
  'dist/roles/herdr-run.js',
  'dist/roles/index.js',
  'dist/roles/job-store.js',
  'dist/roles/job-receipt.js',
  'dist/roles/job-wait.js',
  'dist/roles/launch.js',
  'dist/roles/pi-dispatch.js',
  'dist/roles/pi-dispatch-status.js',
  'dist/roles/role-tools.js',
  'dist/roles/roles.js',
  'dist/roles/routing.js',
  'dist/roles/selection.js',
  'dist/jev/agent.js',
  'dist/jev/ask/chrome.js',
  'dist/jev/ask/config.js',
  'dist/jev/ask/error.js',
  'dist/jev/ask/lease.js',
  'dist/jev/ask/names.js',
  'dist/jev/ask/records.js',
  'dist/jev/browser.js',
  'dist/jev/cdp.js',
  'dist/jev/decide.js',
  'dist/jev/failover.js',
  'dist/jev/judge.js',
  'dist/jev/model.js',
  'dist/jev/providers/openai.js',
  'dist/jev/providers/typesafe.js',
  'dist/jev/questions.js',
  'dist/jev/runtime/aistudio-facts.js',
  'dist/jev/runtime/aistudio-state.js',
  'dist/jev/runtime/aistudio.js',
  'dist/jev/runtime/chatgpt-facts.js',
  'dist/jev/runtime/chatgpt.js',
  'dist/jev/runtime/client.js',
  'dist/jev/runtime/diagnostic.js',
  'dist/jev/runtime/oracle-read.js',
  'dist/jev/runtime/entry.js',
  'dist/jev/runtime/executor.js',
  'dist/jev/runtime/fake.js',
  'dist/jev/runtime/index.js',
  'dist/jev/runtime/ipc.js',
  'dist/jev/runtime/oracle.js',
  'dist/jev/runtime/types.js',
  'packages/hud-mcp/dist/src/hud-home.js',
  'packages/hud-mcp/dist/src/roles/adapters.js',
  'packages/hud-mcp/dist/src/roles/association.js',
  'packages/hud-mcp/dist/src/roles/caller.js',
  'packages/hud-mcp/dist/src/roles/facade.js',
  'packages/hud-mcp/dist/src/roles/herdr-run.js',
  'packages/hud-mcp/dist/src/roles/index.js',
  'packages/hud-mcp/dist/src/roles/job-store.js',
  'packages/hud-mcp/dist/src/roles/job-receipt.js',
  'packages/hud-mcp/dist/src/roles/job-wait.js',
  'packages/hud-mcp/dist/src/roles/launch.js',
  'packages/hud-mcp/dist/src/roles/pi-dispatch.js',
  'packages/hud-mcp/dist/src/roles/pi-dispatch-status.js',
  'packages/hud-mcp/dist/src/roles/role-tools.js',
  'packages/hud-mcp/dist/src/roles/roles.js',
  'packages/hud-mcp/dist/src/roles/routing.js',
  'packages/hud-mcp/dist/src/roles/selection.js',
  'packages/hud-mcp/dist/src/jev/agent.js',
  'packages/hud-mcp/dist/src/jev/ask/chrome.js',
  'packages/hud-mcp/dist/src/jev/ask/config.js',
  'packages/hud-mcp/dist/src/jev/ask/error.js',
  'packages/hud-mcp/dist/src/jev/ask/lease.js',
  'packages/hud-mcp/dist/src/jev/ask/names.js',
  'packages/hud-mcp/dist/src/jev/ask/records.js',
  'packages/hud-mcp/dist/src/jev/browser.js',
  'packages/hud-mcp/dist/src/jev/cdp.js',
  'packages/hud-mcp/dist/src/jev/decide.js',
  'packages/hud-mcp/dist/src/jev/failover.js',
  'packages/hud-mcp/dist/src/jev/judge.js',
  'packages/hud-mcp/dist/src/jev/model.js',
  'packages/hud-mcp/dist/src/jev/providers/openai.js',
  'packages/hud-mcp/dist/src/jev/providers/typesafe.js',
  'packages/hud-mcp/dist/src/jev/questions.js',
  'packages/hud-mcp/dist/src/jev/runtime/aistudio-facts.js',
  'packages/hud-mcp/dist/src/jev/runtime/aistudio-state.js',
  'packages/hud-mcp/dist/src/jev/runtime/aistudio.js',
  'packages/hud-mcp/dist/src/jev/runtime/chatgpt-facts.js',
  'packages/hud-mcp/dist/src/jev/runtime/chatgpt.js',
  'packages/hud-mcp/dist/src/jev/runtime/client.js',
  'packages/hud-mcp/dist/src/jev/runtime/diagnostic.js',
  'packages/hud-mcp/dist/src/jev/runtime/oracle-read.js',
  'packages/hud-mcp/dist/src/jev/runtime/executor.js',
  'packages/hud-mcp/dist/src/jev/runtime/fake.js',
  'packages/hud-mcp/dist/src/jev/runtime/index.js',
  'packages/hud-mcp/dist/src/jev/runtime/ipc.js',
  'packages/hud-mcp/dist/src/jev/runtime/oracle.js',
  'packages/hud-mcp/dist/src/jev/runtime/types.js',
  'packages/hud-mcp/dist/packages/hud-mcp/src/role-main.js',
  'packages/hud-mcp/dist/packages/hud-mcp/src/role-extension.js',
  'packages/hud-mcp/dist/packages/hud-mcp/src/surface.js',
  'dist/core/run/cli.js',
  'dist/core/run/control.js',
  'dist/core/run/process.js',
  'dist/harness/codex/profile.js',
  'dist/collectors/file-watcher.js',
  'packages/hud-mcp/dist/packages/hud-mcp/src/main.js',
  'packages/hud-mcp/dist/packages/hud-mcp/src/managed-runtime.js',
  'packages/hud-mcp/dist/packages/hud-mcp/src/delegation.js',
  'packages/hud-mcp/dist/src/core/runtime-build.js',
  'packages/hud-mcp/dist/src/core/capability-manifest.js',
  'packages/hud-mcp/dist/src/core/launch/capability.js',
  'packages/hud-mcp/dist/src/core/launch/supervisor.js',
  'packages/hud-mcp/dist/src/harness/codex/profile.js',
  ...Object.keys(RUNTIME_DEPENDENCIES).map((name) => `node_modules/${name}/package.json`),
  'node_modules/@iarna/toml/toml.js',
  'node_modules/chokidar/index.js',
  'node_modules/chokidar/handler.js',
  'node_modules/readdirp/index.js',
] as const;
export interface RuntimeEntry {
  path: string;
  bytes: number;
  sha256: string;
  mode: '0600' | '0700';
}
export interface RuntimeBuild {
  buildId: string;
  repositorySha: string;
  repositoryTree: string;
  lockfileSha256: string;
  bytes: number;
  files: number;
  capabilityManifests: ReadonlyMap<string, CapabilityManifestV1>;
}
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const fileStamp = (s: NonNullable<ReturnType<typeof lstatSync>>) =>
  JSON.stringify([s.dev, s.ino, s.size, s.mode, s.nlink, s.mtimeMs, s.ctimeMs]);
const relativePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 512 &&
  /^[A-Za-z0-9_@./-]+$/.test(value) &&
  !isAbsolute(value) &&
  value.split('/').every((part) => part !== '' && !part.startsWith('.'));
const dependencyPath = (path: string) => {
  if (!path.split('/').includes('node_modules')) return true;
  return Object.keys(RUNTIME_DEPENDENCIES).some((name) => {
    const root = `node_modules/${name}`;
    if (path === root || root.startsWith(`${path}/`)) return true;
    return (
      path.startsWith(`${root}/`) &&
      !path
        .slice(root.length + 1)
        .split('/')
        .includes('node_modules')
    );
  });
};
const fields = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => [...required, ...optional].includes(key));
const text = (value: unknown, limit: number): value is string =>
  typeof value === 'string' &&
  !value.includes('\0') &&
  Buffer.byteLength(value) > 0 &&
  Buffer.byteLength(value) <= limit &&
  new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value)) === value;
function validEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (
    !fields(
      v,
      ['schemaVersion', 'repositorySha', 'repositoryTree', 'dirty', 'lockfileSha256', 'entries'],
      [
        'platform',
        'nodeRequirement',
        'sourceContentSha256',
        'builtWithNode',
        'dependencies',
        'provenance',
        'capabilityLimitation',
      ]
    )
  )
    return false;
  if ('platform' in v && v.platform !== 'linux') return false;
  if ('nodeRequirement' in v && v.nodeRequirement !== '^22.13.0 || ^24.0.0') return false;
  if (
    'sourceContentSha256' in v &&
    (typeof v.sourceContentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.sourceContentSha256))
  )
    return false;
  if (
    'builtWithNode' in v &&
    (!text(v.builtWithNode, 128) ||
      !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
        v.builtWithNode
      ))
  )
    return false;
  if (typeof v.builtWithNode === 'string') {
    const prerelease = v.builtWithNode.split('+')[0].match(/^[^-]*-(.+)$/)?.[1];
    if (prerelease?.split('.').some((part) => /^[0-9]+$/.test(part) && !/^(0|[1-9][0-9]*)$/.test(part))) return false;
  }
  if ('dependencies' in v) {
    const d = v.dependencies as Record<string, unknown>;
    if (
      !d ||
      typeof d !== 'object' ||
      Array.isArray(d) ||
      !fields(d, Object.keys(RUNTIME_DEPENDENCIES)) ||
      Object.entries(RUNTIME_DEPENDENCIES).some(([name, version]) => d[name] !== version)
    )
      return false;
  }
  let total = 0;
  for (const key of ['provenance', 'capabilityLimitation'])
    if (key in v) {
      if (!text(v[key], 4096)) return false;
      total += Buffer.byteLength(v[key] as string);
    }
  if (!Array.isArray(v.entries) || v.entries.length < 1 || v.entries.length > MAX_FILES) return false;
  for (const entry of v.entries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      !fields(entry, ['path', 'bytes', 'sha256', 'mode'], ['origin', 'provenance'])
    )
      return false;
    for (const key of ['origin', 'provenance'])
      if (key in entry) {
        if (!text(entry[key], key === 'origin' ? 1024 : 4096)) return false;
        total += Buffer.byteLength(entry[key]);
      }
  }
  return total <= 3 * 1024 * 1024;
}

/** Startup integrity observation, not publisher authentication or a capability grant.
 * Root is supplied only by trusted composition (fixed installed location in production).
 */
export function observeRuntimeBuild(root: string): RuntimeBuild | null {
  try {
    if (!isAbsolute(root) || realpathSync(root) !== root) return null;
    const directory = lstatSync(root);
    if (!directory.isDirectory() || (directory.mode & 0o7777) !== 0o700) return null;
    const rootStamp = fileStamp(directory);
    const read = (relative: string) => {
      const path = join(root, relative);
      let parent = root;
      for (const part of relative.split('/').slice(0, -1)) {
        parent = join(parent, part);
        const stat = lstatSync(parent);
        if (!stat.isDirectory() || (stat.mode & 0o7777) !== 0o700 || realpathSync(parent) !== parent)
          throw new Error('runtime_directory');
      }
      const before = lstatSync(path);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE || realpathSync(path) !== path)
        throw new Error('runtime_file');
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (fileStamp(fstatSync(fd)) !== fileStamp(before)) throw new Error('runtime_replaced');
        const bytes = Buffer.alloc(before.size + 1);
        let length = 0;
        while (length < bytes.length) {
          const count = readSync(fd, bytes, length, bytes.length - length, length);
          if (!count) break;
          length += count;
        }
        if (
          length !== before.size ||
          fileStamp(fstatSync(fd)) !== fileStamp(before) ||
          fileStamp(lstatSync(path)) !== fileStamp(before)
        )
          throw new Error('runtime_changed');
        return { bytes: bytes.subarray(0, length), mode: (before.mode & 0o7777).toString(8).padStart(4, '0') };
      } finally {
        closeSync(fd);
      }
    };
    const manifestFile = read('RUNTIME-MANIFEST.json');
    if (manifestFile.mode !== '0600') return null;
    const manifest = parseStrictJson(manifestFile.bytes, MAX_FILE) as {
      schemaVersion: number;
      repositorySha: string;
      repositoryTree: string;
      dirty: boolean;
      lockfileSha256: string;
      entries: RuntimeEntry[];
    };
    if (
      !validEnvelope(manifest) ||
      !manifest ||
      manifest.schemaVersion !== 1 ||
      manifest.dirty !== false ||
      typeof manifest.repositorySha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(manifest.repositorySha) ||
      typeof manifest.repositoryTree !== 'string' ||
      !/^[a-f0-9]{40}$/.test(manifest.repositoryTree) ||
      typeof manifest.lockfileSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(manifest.lockfileSha256) ||
      !Array.isArray(manifest.entries) ||
      manifest.entries.length > MAX_FILES
    )
      return null;
    let total = 0;
    const paths = new Set<string>();
    for (const entry of manifest.entries) {
      if (
        !entry ||
        !relativePath(entry.path) ||
        !dependencyPath(entry.path) ||
        entry.path === 'RUNTIME-MANIFEST.json' ||
        paths.has(entry.path) ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        entry.bytes > MAX_FILE ||
        typeof entry.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !['0600', '0700'].includes(entry.mode)
      )
        return null;
      total += entry.bytes;
      paths.add(entry.path);
    }
    if (total > MAX_TOTAL || MINIMUM_RUNTIME_FILES.some((path) => !paths.has(path))) return null;
    const inventory = () => {
      const found: [string, string][] = [];
      let directories = 0;
      const walk = (relative: string, depth: number) => {
        if (depth > 32 || ++directories > MAX_FILES) throw new Error('runtime_directory_limit');
        for (const name of readdirSync(join(root, relative))) {
          const path = relative ? `${relative}/${name}` : name;
          if (!relativePath(path) || !dependencyPath(path)) throw new Error('runtime_path');
          const stat = lstatSync(join(root, path));
          if (stat.isDirectory() && (stat.mode & 0o7777) === 0o700) walk(path, depth + 1);
          else if (stat.isFile()) {
            found.push([path, fileStamp(stat)]);
            if (found.length > MAX_FILES + 1) throw new Error('runtime_file_limit');
          } else throw new Error('runtime_special_file');
        }
      };
      walk('', 0);
      return found.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    };
    const before = inventory();
    if (JSON.stringify(before.map(([path]) => path)) !== JSON.stringify([...paths, 'RUNTIME-MANIFEST.json'].sort()))
      return null;
    const capabilityManifests = new Map<string, CapabilityManifestV1>();
    const packages = new Map<string, unknown>();
    for (const entry of manifest.entries) {
      const file = read(entry.path);
      if (file.bytes.length !== entry.bytes || file.mode !== entry.mode || sha256(file.bytes) !== entry.sha256)
        return null;
      if (
        entry.path === 'package.json' ||
        entry.path === 'packages/hud-mcp/package.json' ||
        Object.keys(RUNTIME_DEPENDENCIES).some((name) => entry.path === `node_modules/${name}/package.json`)
      )
        packages.set(entry.path, parseStrictJson(file.bytes, MAX_FILE));
      if ((RUNTIME_CAPABILITY_FILES as readonly string[]).includes(entry.path)) {
        const cells = parseCapabilityManifest(file.bytes);
        if (!cells) return null;
        capabilityManifests.set(entry.path, cells);
      }
    }
    const packageObject = (path: string) => {
      const value = packages.get(path);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('runtime_package_object');
      return value as Record<string, unknown>;
    };
    for (const [path, name] of [
      ['package.json', 'codex-hud'],
      ['packages/hud-mcp/package.json', '@myhud/hud-mcp'],
    ]) {
      const pkg = packageObject(path);
      if (pkg.name !== name || pkg.type !== 'module') return null;
    }
    for (const [name, version] of Object.entries(RUNTIME_DEPENDENCIES)) {
      const pkg = packageObject(`node_modules/${name}/package.json`);
      if (pkg.name !== name.split('/node_modules/').at(-1) || pkg.version !== version) return null;
      if (name === '@iarna/toml') {
        if (
          pkg.main !== 'toml.js' ||
          (pkg.type !== undefined && pkg.type !== 'commonjs') ||
          Object.hasOwn(pkg, 'exports')
        )
          return null;
      } else if (name === 'chokidar' || name === 'readdirp') {
        const exports =
          name === 'chokidar'
            ? { '.': { default: './index.js' }, './handler.js': { default: './handler.js' } }
            : { '.': './index.js' };
        if (pkg.type !== 'module' || pkg.main !== './index.js' || canonicalJson(pkg.exports) !== canonicalJson(exports))
          return null;
      }
    }
    for (const [anchor, name, expected] of [
      ['dist/harness/codex/profile.js', '@iarna/toml', 'node_modules/@iarna/toml/toml.js'],
      ['packages/hud-mcp/dist/src/harness/codex/profile.js', '@iarna/toml', 'node_modules/@iarna/toml/toml.js'],
      ['dist/collectors/file-watcher.js', 'chokidar', 'node_modules/chokidar/index.js'],
      ['node_modules/chokidar/index.js', 'readdirp', 'node_modules/readdirp/index.js'],
    ]) {
      const resolved = createRequire(join(root, anchor)).resolve(name);
      if (!paths.has(expected) || realpathSync(resolved) !== join(root, expected)) return null;
    }
    if (JSON.stringify(inventory()) !== JSON.stringify(before) || fileStamp(lstatSync(root)) !== rootStamp) return null;
    const selected = manifest.entries
      .filter((entry) => !(RUNTIME_CAPABILITY_FILES as readonly string[]).includes(entry.path))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((entry) => [entry.path, entry.mode, entry.bytes, entry.sha256]);
    return {
      buildId: 'sha256:' + sha256(JSON.stringify(['hud-runtime-build-v1', selected])),
      repositorySha: manifest.repositorySha,
      repositoryTree: manifest.repositoryTree,
      lockfileSha256: manifest.lockfileSha256,
      bytes: total,
      files: paths.size,
      capabilityManifests,
    };
  } catch {
    return null;
  }
}
