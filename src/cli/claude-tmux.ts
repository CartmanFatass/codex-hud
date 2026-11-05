import { execFile } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';
import { release } from 'node:os';
import { canonicalJson } from '../core/canonical.js';
import { readProcess, sameStamp, type ProcRecord } from '../core/run/process.js';

export interface NativeFile {
  path: string;
  file: { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string };
}

/** Exact integer metadata, including on filesystems whose inode exceeds 2^53. */
export function nativeFile(path: string): NativeFile | null {
  let fd: number | undefined;
  try {
    const canonical = realpathSync(path);
    fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd, { bigint: true });
    const header = Buffer.alloc(4);
    if (
      !stat.isFile() ||
      !(stat.mode & 0o111n) ||
      readSync(fd, header, 0, 4, 0) !== 4 ||
      !header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    )
      return null;
    return {
      path: canonical,
      file: {
        dev: String(stat.dev),
        ino: String(stat.ino),
        size: String(stat.size),
        mtimeNs: String(stat.mtimeNs),
        ctimeNs: String(stat.ctimeNs),
      },
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function trustedTmux(): NativeFile | null {
  for (const path of ['/usr/bin/tmux', '/bin/tmux']) {
    const identity = nativeFile(path);
    if (!identity) continue;
    let directory = identity.path;
    let safe = true;
    for (;;) {
      const stat = lstatSync(directory);
      if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
        safe = false;
        break;
      }
      if (directory === '/') break;
      directory = dirname(directory);
    }
    if (safe) return identity;
  }
  return null;
}

export type ProcessReceipt = Pick<ProcRecord, 'stamp' | 'ppid' | 'pgid' | 'sid' | 'tty' | 'foregroundPgid'>;
export interface TmuxStartup {
  topology: 'linux-tmux-existing-pane-foreground-argv-v1';
  host: NativeFile & { version: string };
  shell: NativeFile & { version: string };
  node: NativeFile & { version: string };
  platform: 'linux';
  kernel: string;
  receipt: {
    socket: { path: string; dev: string; ino: string };
    pane: string;
    tty: string;
    terminalDevice: string;
    server: ProcessReceipt;
    ancestry: ProcessReceipt[];
  };
}

/** Trusted injectable I/O only, never selected by CLI/configuration/environment. */
export interface TmuxObserverPorts {
  platform: string;
  kernel: string;
  pid: number;
  nodeVersion: string;
  tmux(): NativeFile | null;
  native(path: string): NativeFile | null;
  process(pid: number): ProcRecord | null;
  socket(path: string): { path: string; dev: string; ino: string } | null;
  terminal(path: string): string | null;
  query(path: string, args: string[]): Promise<string | null>;
}

const production: TmuxObserverPorts = {
  platform: process.platform,
  kernel: release(),
  pid: process.pid,
  nodeVersion: process.versions.node,
  tmux: trustedTmux,
  native: nativeFile,
  process: readProcess,
  socket(path) {
    try {
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isSocket() || stat.uid !== BigInt(process.getuid!()) || realpathSync(path) !== path) return null;
      return { path, dev: String(stat.dev), ino: String(stat.ino) };
    } catch {
      return null;
    }
  },
  terminal(path) {
    try {
      const stat = statSync(path, { bigint: true });
      if (!stat.isCharacterDevice()) return null;
      // Linux new_encode_dev: /proc stat's tty_nr is a signed 32-bit encoding.
      const major = ((stat.rdev >> 8n) & 0xfffn) | ((stat.rdev >> 32n) & 0xfffff000n);
      const minor = (stat.rdev & 0xffn) | ((stat.rdev >> 12n) & 0xffffff00n);
      if (major > 0xfffn || minor > 0xfffffn) return null;
      return String((minor & 0xffn) | (major << 8n) | ((minor & ~0xffn) << 12n));
    } catch {
      return null;
    }
  },
  query(path, args) {
    return new Promise((resolve) => {
      execFile(
        path,
        args,
        {
          // No inherited loader/shell hooks or environment-selected binary.
          env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
          timeout: 1000,
          killSignal: 'SIGKILL',
          maxBuffer: 8192,
          encoding: 'utf8',
        },
        (error, stdout) => resolve(error ? null : stdout.trim())
      );
    });
  },
};

function receipt(record: ProcRecord): ProcessReceipt {
  const { stamp, ppid, pgid, sid, tty, foregroundPgid } = record;
  return { stamp, ppid, pgid, sid, tty, foregroundPgid };
}
function live(record: ProcRecord | null): record is ProcRecord {
  return !!record && !['Z', 'X', 'x'].includes(record.state);
}
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const FORMAT = '#{pid}\t#{socket_path}\t#{pane_id}\t#{pane_pid}\t#{pane_tty}\t#{version}';

/** Two matching tmux responses bracket a bounded, stable procfs ancestry sample. */
export async function observeClaudeTmux(
  env: NodeJS.ProcessEnv,
  ports: TmuxObserverPorts = production
): Promise<TmuxStartup | null> {
  try {
    if (ports.platform !== 'linux' || !ports.kernel || !ports.nodeVersion) return null;
    const locator = /^(\/[^\0\r\n\t]{1,4096}),(\d+),(\d+)$/.exec(env.TMUX ?? '');
    const pane = env.TMUX_PANE;
    if (!locator || !pane || !/^%\d+$/.test(pane)) return null;
    const socket = ports.socket(locator[1]);
    const tmux = ports.tmux();
    if (!socket || !tmux) return null;
    const args = ['-S', socket.path, 'display-message', '-p', '-t', pane, FORMAT];
    const answer = await ports.query(tmux.path, args);
    const parts = answer?.split('\t');
    if (!parts || parts.length !== 6) return null;
    const [serverText, observedSocket, observedPane, panePidText, tty, version] = parts;
    if (
      !/^[1-9]\d*$/.test(serverText) ||
      !/^[1-9]\d*$/.test(panePidText) ||
      !Number.isSafeInteger(Number(serverText)) ||
      !Number.isSafeInteger(Number(panePidText)) ||
      serverText !== locator[2] ||
      observedSocket !== socket.path ||
      observedPane !== pane ||
      !/^\/dev\/pts\/\d+$/.test(tty) ||
      !/^\d+\.\d+[a-z]?$/.test(version)
    )
      return null;
    const server = ports.process(Number(serverText));
    const launcher = ports.process(ports.pid);
    const device = ports.terminal(tty);
    if (
      !live(server) ||
      !live(launcher) ||
      !device ||
      device === '0' ||
      launcher.pgid !== launcher.foregroundPgid ||
      String(launcher.tty >>> 0) !== device ||
      ![0, 1, 2].every((fd) => ports.terminal(`/proc/${ports.pid}/fd/${fd}`) === device)
    )
      return null;
    const chain: ProcRecord[] = [];
    let current: ProcRecord | null = launcher;
    for (let depth = 0; depth < 32; depth++) {
      if (
        !live(current) ||
        chain.some((entry) => entry.stamp.pid === current!.stamp.pid) ||
        current.tty !== launcher.tty ||
        current.sid !== launcher.sid ||
        current.foregroundPgid !== launcher.foregroundPgid ||
        current.stamp.boot_id !== server.stamp.boot_id ||
        current.stamp.pid_domain !== server.stamp.pid_domain
      )
        return null;
      chain.push(current);
      if (current.stamp.pid === Number(panePidText)) break;
      current = ports.process(current.ppid);
    }
    const shellProcess = chain.at(-1)!;
    // Only the direct pane shell -> HUD topology is declared. Extra wrappers
    // would require their own executable/argv proof and a different capability.
    if (shellProcess.stamp.pid !== Number(panePidText) || shellProcess.ppid !== server.stamp.pid || chain.length !== 2)
      return null;
    const host = ports.native(`/proc/${server.stamp.pid}/exe`);
    const shell = ports.native(`/proc/${shellProcess.stamp.pid}/exe`);
    const node = ports.native(`/proc/${ports.pid}/exe`);
    if (
      !host ||
      !equal(host, tmux) ||
      !shell ||
      !node ||
      !isAbsolute(node.path) ||
      !['bash', 'zsh', 'fish'].includes(basename(shell.path))
    )
      return null;
    const hostVersion = await ports.query(tmux.path, ['-V']);
    const shellOutput = await ports.query(shell.path, ['--version']);
    const shellVersion = shellOutput?.match(
      /(?:^|\s)(\d+\.\d+(?:\.\d+)?(?:\(\d+\))?(?:[-+][A-Za-z0-9._-]+)?)(?:\s|$)/
    )?.[1];
    if (hostVersion !== `tmux ${version}` || !shellVersion) return null;
    if ((await ports.query(tmux.path, args)) !== answer || !equal(ports.socket(socket.path), socket)) return null;
    for (const original of [server, ...chain]) {
      const now = ports.process(original.stamp.pid);
      if (!live(now) || !sameStamp(original.stamp, now.stamp) || !equal(receipt(original), receipt(now))) return null;
    }
    if (
      !equal(ports.native(`/proc/${server.stamp.pid}/exe`), host) ||
      !equal(ports.native(`/proc/${shellProcess.stamp.pid}/exe`), shell) ||
      !equal(ports.native(`/proc/${ports.pid}/exe`), node) ||
      ![tty, ...[0, 1, 2].map((fd) => `/proc/${ports.pid}/fd/${fd}`)].every((path) => ports.terminal(path) === device)
    )
      return null;
    return {
      topology: 'linux-tmux-existing-pane-foreground-argv-v1',
      host: { ...host, version },
      shell: { ...shell, version: shellVersion },
      node: { ...node, version: ports.nodeVersion },
      platform: 'linux',
      kernel: ports.kernel,
      receipt: { socket, pane, tty, terminalDevice: device, server: receipt(server), ancestry: chain.map(receipt) },
    };
  } catch {
    return null;
  }
}

/** Compare with the original receipt; never replace the admitted identity on recheck. */
export function sameTmuxStartup(original: TmuxStartup, current: TmuxStartup | null): boolean {
  return current !== null && equal(original, current);
}
