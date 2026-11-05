import test from 'node:test';
import assert from 'node:assert/strict';
import { observeWindowsInterop, InteropUnverified, type InteropPorts } from '../../src/cli/claude-wsl-interop.js';
import { observeWindowsPolicy } from '../../src/cli/claude-windows-policy.js';
import type { ProcRecord } from '../../src/core/run/process.js';
import { safeConfigurationReason } from '../../src/cli/claude-diagnostics.js';

function fixture() {
  const locator = '/run/WSL/10_interop';
  const init = { path: '/init', file: { dev: '1', ino: '2', size: '3', mtimeNs: '4', ctimeNs: '5' } };
  const server: ProcRecord = {
    stamp: { pid: 10, proc_start: '100', boot_id: 'synthetic-boot', pid_domain: 'synthetic-domain' },
    state: 'S',
    flags: 0,
    pgid: 10,
    sid: 10,
    ppid: 1,
    tty: 0,
    foregroundPgid: -1,
  };
  const directory = { uid: 0, mode: 0o755, identity: 'synthetic-directory' };
  const socket = { uid: 0, identity: 'synthetic-path-inode-and-ctime' };
  const header = 'Num RefCount Protocol Flags Type St Inode Path\n';
  const row = `00000000: 00000002 00000000 00010000 0001 01 987 ${locator}\n`;
  const calls: number[] = [];
  const ports: InteropPorts = {
    uid: 1000,
    init: () => structuredClone(init),
    directory: () => ({ ...directory }),
    socket: (path) => {
      assert.ok([locator, `/proc/10/root${locator}`].includes(path));
      return { ...socket };
    },
    process: (pid) => {
      calls.push(pid);
      return structuredClone(server);
    },
    executable: () => structuredClone(init),
    unix: () => header + row,
    descriptors: () => [{ fd: '4', target: 'socket:[987]' }],
    format: () => 'enabled\ninterpreter /init\nflags: PF\nmagic 4d5a\n',
  };
  return { locator, init, server, directory, socket, header, row, ports, calls };
}

test('Claude detached tmux interop uses live listener ownership without requiring launcher ancestry', () => {
  const f = fixture();
  const first = observeWindowsInterop(f.locator, f.ports);
  assert.equal(first.locator, f.locator);
  assert.match(first.identity, /^[a-f0-9]{64}$/);
  // Server is reparented to PID 1; only its own identity is queried. No launcher
  // ancestor traversal is needed, and tmux/pane foreground checks stay separate.
  assert.deepEqual(f.calls, [10, 10]);
  assert.deepEqual(observeWindowsInterop(f.locator, f.ports), first);
});

test('Claude normal 0777 WSL transport retains diagnostic evidence and cannot authorize helper execution', () => {
  const f = fixture();
  f.directory.mode = 0o777;
  let queries = 0,
    files = 0;
  const result = observeWindowsPolicy('2.1.305', {
    system: () => {
      observeWindowsInterop(f.locator, f.ports);
      throw new Error('must not execute helper');
    },
    registry: () => {
      queries++;
      return { state: 'missing', code: 2 };
    },
    read: () => {
      files++;
      throw new Error('must not read Windows files');
    },
  });
  assert.equal(result.observation, null);
  assert.equal(result.reason, 'configuration_windows_interop_writable_transport_unverified');
  assert.deepEqual(result.interop, {
    schema: 'wsl-interop-diagnostic-v1',
    authority: 'none',
    directoryMode: '0777',
    listenerOwnerObserved: true,
    reason: result.reason,
  });
  assert.equal(queries, 0);
  assert.equal(files, 0);
  assert.equal(safeConfigurationReason(result.reason), result.reason);
  f.ports.descriptors = () => {
    throw new Error('EACCES private process detail');
  };
  assert.throws(
    () => observeWindowsInterop(f.locator, f.ports),
    (error: unknown) => {
      assert.ok(error instanceof InteropUnverified);
      assert.equal(error.diagnostic.directoryMode, '0777');
      assert.equal(error.diagnostic.authority, 'none');
      assert.equal(error.diagnostic.listenerOwnerObserved, false);
      assert.equal(error.message, 'configuration_windows_interop_owner_unobserved');
      return true;
    }
  );
});

test('Claude interop rejects wrong listener, executable, namespace, socket owner and replacement races', () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.ports.unix = () => f.header + f.row + f.row;
    },
    (f: ReturnType<typeof fixture>) => {
      f.ports.unix = () => f.header + f.row.replace('00010000', '00000000');
    },
    (f: ReturnType<typeof fixture>) => {
      f.ports.descriptors = () => [{ fd: '4', target: 'socket:[999]' }];
    },
    (f: ReturnType<typeof fixture>) => {
      f.ports.descriptors = () => Array.from({ length: 513 }, (_, n) => ({ fd: String(n), target: 'socket:[987]' }));
    },
    (f: ReturnType<typeof fixture>) => {
      f.ports.executable = () => ({ ...f.init, file: { ...f.init.file, ino: '999' } });
    },
    (f: ReturnType<typeof fixture>) => {
      f.ports.socket = (path) => ({
        ...f.socket,
        identity: path.startsWith('/proc/') ? 'another-mount' : f.socket.identity,
      });
    },
    (f: ReturnType<typeof fixture>) => {
      f.socket.uid = 2000;
    },
    (f: ReturnType<typeof fixture>) => {
      f.server.state = 'Z';
    },
    (f: ReturnType<typeof fixture>) => {
      let calls = 0;
      f.ports.process = () => ({
        ...structuredClone(f.server),
        stamp: { ...f.server.stamp, proc_start: String(++calls) },
      });
    },
    (f: ReturnType<typeof fixture>) => {
      let calls = 0;
      f.ports.directory = () => ({ ...f.directory, identity: String(++calls) });
    },
    (f: ReturnType<typeof fixture>) => {
      let calls = 0;
      f.ports.socket = () => ({ ...f.socket, identity: String(Math.floor(calls++ / 2)) });
    },
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => observeWindowsInterop(f.locator, f.ports), InteropUnverified);
  }
});
