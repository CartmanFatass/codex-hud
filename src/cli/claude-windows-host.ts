import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readlinkSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { release } from 'node:os';
import { canonicalJson, digest } from '../core/canonical.js';
import { readProcess } from '../core/run/process.js';
import { installationRoot } from './compat.js';
import { nativeFile } from './claude-tmux.js';
import { observeWindowsInterop } from './claude-wsl-interop.js';
import type { RegistryResult, WindowsPolicyPorts, WindowsPolicySystem } from './claude-windows-policy.js';

const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
interface FileSnapshot {
  bytes: Buffer;
  identity: string;
}
const sameFile = (a: FileSnapshot, b: FileSnapshot) => a.identity === b.identity && a.bytes.equals(b.bytes);
export interface WindowsHostPorts {
  platform: string;
  kernel: string;
  arch: string;
  root: string;
  file(path: string, limit: number): FileSnapshot;
  interop(): { locator: string; identity: string };
  directory(path: string): string;
  run(path: string, locator: string): string;
}

function snapshot(path: string, limit: number, proc = false): FileSnapshot {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || (!proc && before.size > BigInt(limit)))
      throw new Error('configuration_windows_input_limit');
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const identity = (s: typeof before) => [
      String(s.dev),
      String(s.ino),
      String(s.size),
      String(s.mtimeNs),
      String(s.ctimeNs),
    ];
    if (length > limit || !equal(identity(before), identity(after)))
      throw new Error('configuration_windows_input_changed');
    return { bytes: bytes.subarray(0, length), identity: digest(identity(after)) };
  } finally {
    closeSync(fd);
  }
}

function protectedPath(path: string, owner: number, directory: boolean) {
  if (realpathSync(path) !== path) throw new Error('configuration_windows_path_alias');
  for (let current = path; ; current = dirname(current)) {
    const s = lstatSync(current);
    if (
      s.isSymbolicLink() ||
      (s.uid !== 0 && s.uid !== owner) ||
      (s.mode & 0o022) !== 0 ||
      (current !== path && !s.isDirectory()) ||
      (current === path && directory && !s.isDirectory())
    )
      throw new Error('configuration_windows_path_untrusted');
    if (current === '/') break;
  }
}

function interop(locator: string | undefined) {
  return observeWindowsInterop(locator, {
    uid: process.getuid!(),
    init: () => {
      protectedPath('/init', 0, false);
      return nativeFile('/init');
    },
    directory: () => {
      protectedPath('/run', 0, true);
      const s = lstatSync('/run/WSL', { bigint: true });
      if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('configuration_windows_path_untrusted');
      return {
        uid: Number(s.uid),
        mode: Number(s.mode),
        identity: digest([String(s.dev), String(s.ino), String(s.ctimeNs)]),
      };
    },
    socket: (path) => {
      const s = lstatSync(path, { bigint: true });
      if (!s.isSocket() || s.isSymbolicLink()) throw new Error('configuration_windows_interop_identity_unknown');
      return {
        uid: Number(s.uid),
        identity: digest([String(s.dev), String(s.ino), String(s.mode), String(s.ctimeNs), String(s.mtimeNs)]),
      };
    },
    process: readProcess,
    executable: (pid) => nativeFile(`/proc/${pid}/exe`),
    unix: (pid) => snapshot(`/proc/${pid}/net/unix`, 1048576, true).bytes.toString('utf8'),
    descriptors: (pid) => {
      const directory = opendirSync(`/proc/${pid}/fd`);
      const entries: { fd: string; target: string }[] = [];
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (entries.length === 512) throw new Error('configuration_windows_interop_listener_limit');
          entries.push({ fd: entry.name, target: readlinkSync(`/proc/${pid}/fd/${entry.name}`) });
        }
      } finally {
        directory.closeSync();
      }
      return entries;
    },
    format: () => snapshot('/proc/sys/fs/binfmt_misc/WSLInterop', 8192, true).bytes.toString('utf8'),
  });
}

const decode = (text: string) =>
  text.replace(/\\(040|011|012|134)/g, (_m, octal: string) => String.fromCharCode(parseInt(octal, 8)));
export function mapWindowsPath(path: string, mountinfo: string): string {
  if (Buffer.byteLength(mountinfo) > 1048576 || mountinfo.split('\n').length > 4096)
    throw new Error('configuration_windows_mount_limit');
  const match = /^([A-Za-z]):\\([^\0]+)$/.exec(path);
  if (!match || match[2].split('\\').some((part) => !part || part === '.' || part === '..' || /[:/]/.test(part)))
    throw new Error('configuration_windows_system_path_unknown');
  const rows = mountinfo
    .trim()
    .split('\n')
    .map((line) => {
      const [left, right] = line.split(' - ');
      const l = left?.split(' '),
        r = right?.split(' ');
      if (!l || l.length < 6 || !r || r.length < 3) throw new Error('configuration_windows_mount_unknown');
      return { root: decode(l[3]), target: decode(l[4]), type: r[0], source: decode(r[1]), options: decode(r[2]) };
    });
  const drive = `${match[1].toUpperCase()}:\\`;
  const matches = rows.filter(
    (row) =>
      row.root === '/' &&
      row.source.toUpperCase() === drive &&
      (row.type === 'drvfs' || (row.type === '9p' && /(?:^|,)aname=drvfs(?:;|,|$)/.test(row.options)))
  );
  if (matches.length !== 1) throw new Error('configuration_windows_mount_ambiguous');
  const selected = matches[0];
  if (!selected.target.startsWith('/') || selected.target.includes('\0') || selected.target.split('/').includes('..'))
    throw new Error('configuration_windows_mount_unknown');
  const result = join(selected.target, ...match[2].split('\\'));
  if (
    rows.some(
      (row) =>
        row !== selected &&
        row.target.startsWith(selected.target + '/') &&
        (result === row.target || result.startsWith(row.target + '/'))
    )
  )
    throw new Error('configuration_windows_mount_shadowed');
  return result;
}

/** The helper is part of the trusted HUD installation, not a host-discovered
 * executable. Its source/artifact hashes and exact file identity are checked
 * before and after invocation. Build receipts do not verify any product cell.
 */
export function observeWindowsHost(ports: WindowsHostPorts): {
  system: WindowsPolicySystem;
  registry: { HKLM: RegistryResult; HKCU: RegistryResult };
} {
  if (ports.platform !== 'linux' || !/microsoft|wsl/i.test(ports.kernel))
    throw new Error('configuration_windows_host_not_wsl');
  const arch = ports.arch === 'x64' ? 'amd64' : ports.arch === 'arm64' ? 'arm64' : null;
  if (!arch) throw new Error('configuration_windows_arch_uncovered');
  const transport = ports.interop();
  const binary = join(ports.root, 'dist/windows-policy', `observer-${arch}.exe`);
  let receipt, source, artifact;
  try {
    receipt = ports.file(binary + '.json', 8192);
    source = ports.file(join(ports.root, 'tools/windows-policy/main.go'), 65536);
    artifact = ports.file(binary, 8388608);
  } catch {
    throw new Error('configuration_windows_helper_unavailable');
  }
  const metadata = JSON.parse(receipt.bytes.toString('utf8'));
  if (
    metadata.protocol !== 1 ||
    metadata.arch !== arch ||
    metadata.sourceSha256 !== hash(source.bytes) ||
    metadata.artifactSha256 !== hash(artifact.bytes) ||
    artifact.bytes.toString('ascii', 0, 2) !== 'MZ'
  )
    throw new Error('configuration_windows_helper_identity_mismatch');
  const mount = ports.file(`/proc/${process.pid}/mountinfo`, 1048576);
  let output;
  try {
    output = ports.run(binary, transport.locator);
  } catch {
    throw new Error('configuration_windows_interop_unknown');
  }
  if (Buffer.byteLength(output) > 1048576) throw new Error('configuration_windows_registry_limit');
  const result = JSON.parse(output);
  if (
    result.protocol !== 1 ||
    typeof result.systemDirectory !== 'string' ||
    typeof result.programFiles !== 'string' ||
    !/\\System32$/i.test(result.systemDirectory)
  )
    throw new Error('configuration_windows_helper_protocol_unknown');
  const systemDirectory = mapWindowsPath(result.systemDirectory, mount.bytes.toString('utf8'));
  const managedRoot = join(mapWindowsPath(result.programFiles, mount.bytes.toString('utf8')), 'ClaudeCode');
  const systemIdentity = ports.directory(systemDirectory);
  if (
    !equal(transport, ports.interop()) ||
    !sameFile(mount, ports.file(`/proc/${process.pid}/mountinfo`, 1048576)) ||
    !sameFile(artifact, ports.file(binary, 8388608)) ||
    !sameFile(receipt, ports.file(binary + '.json', 8192)) ||
    !sameFile(source, ports.file(join(ports.root, 'tools/windows-policy/main.go'), 65536))
  )
    throw new Error('configuration_windows_system_changed');
  return {
    system: {
      observerExe: binary,
      managedRoot,
      executableIdentity: digest({
        artifact: artifact.identity,
        receipt: receipt.identity,
        source: source.identity,
        hash: metadata.artifactSha256,
      }),
      interopIdentity: digest({
        transport,
        mount: mount.identity,
        mountHash: hash(mount.bytes),
        systemIdentity,
        result,
      }),
    },
    registry: { HKLM: result.hklm, HKCU: result.hkcu },
  };
}

export function productionWindowsPolicyPorts(
  read: WindowsPolicyPorts['read'],
  env: NodeJS.ProcessEnv = process.env
): WindowsPolicyPorts {
  const ports: WindowsHostPorts = {
    platform: process.platform,
    kernel: release(),
    arch: process.arch,
    root: installationRoot(),
    file: (path, limit) => {
      if (!path.startsWith('/proc/')) protectedPath(path, process.getuid!(), false);
      return snapshot(path, limit, path.startsWith('/proc/'));
    },
    interop: () => interop(env.WSL_INTEROP),
    directory: (path) => {
      if (realpathSync(path) !== path) throw new Error('configuration_windows_path_alias');
      const s = lstatSync(path, { bigint: true });
      if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('configuration_windows_system_path_unknown');
      return digest([path, String(s.dev), String(s.ino)]);
    },
    run: (path, locator) =>
      execFileSync(path, [], {
        timeout: 2000,
        maxBuffer: 1048576,
        encoding: 'utf8',
        cwd: '/',
        env: { WSL_INTEROP: locator, WSLENV: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
  };
  let observed: ReturnType<typeof observeWindowsHost> | undefined;
  return {
    system: () => {
      observed = observeWindowsHost(ports);
      return observed.system;
    },
    registry: (hive) => {
      if (!observed) throw new Error('configuration_windows_system_identity_unobserved');
      return structuredClone(observed.registry[hive]);
    },
    read,
  };
}
