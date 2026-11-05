import { canonicalJson, digest } from '../core/canonical.js';
import { sameStamp, type ProcRecord } from '../core/run/process.js';
import type { NativeFile } from './claude-tmux.js';

export interface InteropDiagnostic {
  schema: 'wsl-interop-diagnostic-v1';
  authority: 'none';
  directoryMode: string | null;
  listenerOwnerObserved: boolean;
  reason: string;
}
export class InteropUnverified extends Error {
  constructor(readonly diagnostic: InteropDiagnostic) {
    super(diagnostic.reason);
  }
}
export interface InteropPorts {
  uid: number;
  init(): NativeFile | null;
  directory(): { uid: number; mode: number; identity: string };
  socket(path: string): { uid: number; identity: string };
  process(pid: number): ProcRecord | null;
  executable(pid: number): NativeFile | null;
  unix(pid: number): string;
  descriptors(pid: number): { fd: string; target: string }[];
  format(): string;
}
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

function listener(text: string, locator: string) {
  if (Buffer.byteLength(text) > 1048576 || text.split('\n').length > 4096)
    throw new Error('configuration_windows_interop_listener_limit');
  const rows = text.trim().split('\n');
  if (!/^Num\s+RefCount\s+Protocol\s+Flags\s+Type\s+St\s+Inode\s+Path/.test(rows.shift() ?? ''))
    throw new Error('configuration_windows_interop_listener_unknown');
  const matches = rows
    .map((row) => row.trim().split(/\s+/))
    .filter(
      (row) => row.length === 8 && row[7] === locator && row[3] === '00010000' && row[4] === '0001' && row[5] === '01'
    );
  if (matches.length !== 1 || matches[0][2] !== '00000000' || !/^[1-9][0-9]*$/.test(matches[0][6]))
    throw new Error('configuration_windows_interop_listener_unknown');
  return matches[0][6];
}

/** A detached tmux need not descend from the interop server. Instead join the
 * exact pathname listener's kernel inode to that live /init process's fd table.
 * This remains diagnostic-only on writable directories: /init opens the path
 * separately, so a pre/post observation is not a connection-bound peer proof.
 */
export function observeWindowsInterop(
  locator: string | undefined,
  ports: InteropPorts
): { locator: string; identity: string } {
  const diagnostic: InteropDiagnostic = {
    schema: 'wsl-interop-diagnostic-v1',
    authority: 'none',
    directoryMode: null,
    listenerOwnerObserved: false,
    reason: 'configuration_windows_interop_identity_unknown',
  };
  try {
    const match = locator && /^\/run\/WSL\/([1-9][0-9]*)_interop$/.exec(locator);
    if (!match || !Number.isSafeInteger(Number(match[1])))
      throw new Error('configuration_windows_interop_locator_unknown');
    const pid = Number(match[1]);
    const init = ports.init();
    if (!init) throw new Error('configuration_windows_interpreter_unknown');
    const directory = ports.directory();
    diagnostic.directoryMode = (directory.mode & 0o7777).toString(8).padStart(4, '0');
    if (directory.uid !== 0) throw new Error('configuration_windows_path_untrusted');
    const collect = () => {
      const process = ports.process(pid);
      const executable = ports.executable(pid);
      if (!process || ['Z', 'X', 'x'].includes(process.state) || !executable || !equal(executable, init))
        throw new Error('configuration_windows_interop_owner_unobserved');
      const socket = ports.socket(locator!);
      if (socket.uid !== 0 && socket.uid !== ports.uid)
        throw new Error('configuration_windows_interop_identity_unknown');
      // Confirm the pathname also names this inode from the server's mount view.
      if (!equal(socket, ports.socket(`/proc/${pid}/root${locator}`)))
        throw new Error('configuration_windows_interop_socket_namespace_unknown');
      const inode = listener(ports.unix(pid), locator!);
      const descriptors = ports.descriptors(pid);
      if (descriptors.length > 512 || descriptors.some((entry) => !/^[0-9]+$/.test(entry.fd)))
        throw new Error('configuration_windows_interop_listener_limit');
      const owned = descriptors
        .filter((entry) => entry.target === `socket:[${inode}]`)
        .map((entry) => entry.fd)
        .sort();
      if (!owned.length) throw new Error('configuration_windows_interop_owner_unobserved');
      const format = ports.format();
      if (!/^enabled\n/m.test(format) || !/^interpreter \/init\n/m.test(format) || !/^magic 4d5a/m.test(format))
        throw new Error('configuration_windows_binfmt_unknown');
      return { stamp: process.stamp, executable, socket, inode, owned, format };
    };
    const original = collect();
    const current = collect();
    if (
      !sameStamp(original.stamp, current.stamp) ||
      !equal(original, current) ||
      !equal(init, ports.init()) ||
      !equal(directory, ports.directory())
    )
      throw new Error('configuration_windows_interop_changed');
    diagnostic.listenerOwnerObserved = true;
    // Do not bless 0777 (or sticky variants) from a momentary listener snapshot.
    if ((directory.mode & 0o022) !== 0) throw new Error('configuration_windows_interop_writable_transport_unverified');
    return { locator: locator!, identity: digest({ init, directory, endpoint: original }) };
  } catch (error) {
    diagnostic.reason =
      error instanceof Error && /^configuration_[a-z_]+$/.test(error.message)
        ? error.message
        : 'configuration_windows_interop_owner_unobserved';
    throw new InteropUnverified(diagnostic);
  }
}
