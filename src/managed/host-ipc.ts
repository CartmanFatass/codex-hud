import { createConnection } from 'node:net';
import { lstatSync, unlinkSync, writeFileSync, readFileSync, openSync, closeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownerKey, privateDirectory, type NativeOwner } from './relations.js';
export interface NativeHostPort {
  invoke(owner: NativeOwner, method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
export function hostSocket(home: string, owner: NativeOwner): string {
  const directory = join(home, 'native-hosts');
  return join(directory, `${ownerKey(owner).slice(0, 32)}.sock`);
}
/** Detached lifetime is intentional: the parent owns only its own IPC observer. */
export function spawnDetachedHost(entry: string, home: string, owner: NativeOwner) {
  privateDirectory(home);
  privateDirectory(join(home, 'native-hosts'));
  const log = openSync(
    hostSocket(home, owner) + '.stderr.log',
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600
  );
  try {
    const child = spawn(process.execPath, [entry, home, JSON.stringify(owner)], {
      detached: true,
      stdio: ['ignore', 'ignore', log],
      env: process.env,
    });
    child.unref();
    return child;
  } finally {
    closeSync(log);
  }
}
/** Spawned process entry. Nothing imports it, so callers must use this path rather than a module graph. */
export function nativeHostEntryPath(): string {
  return fileURLToPath(new URL('./host-entry.js', import.meta.url));
}
export class NativeHostClient implements NativeHostPort {
  constructor(
    readonly home: string,
    private readonly launch: boolean = true,
    private readonly entry = nativeHostEntryPath()
  ) {}
  private async exchange(
    owner: NativeOwner,
    method: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const path = hostSocket(this.home, owner);
    const stat = lstatSync(path);
    if (!stat.isSocket() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
      throw new Error('unsafe_native_host_socket');
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      socket.setEncoding('utf8');
      let buffer = '';
      let finished = false;
      const cleanup = () => {
        signal?.removeEventListener('abort', abort);
        socket.destroy();
      };
      const fail = (error: Error) => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(error);
      };
      const abort = () => fail(new Error('native_observation_cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      socket.once('error', fail);
      socket.once('connect', () => socket.write(JSON.stringify({ owner, method, args }) + '\n'));
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (Buffer.byteLength(buffer) > 8_388_608) {
          fail(new Error('native_response_too_large'));
          return;
        }
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline));
          finished = true;
          cleanup();
          if (response.ok) resolve(response.value);
          else {
            const detail = response.error;
            const error = new Error(typeof detail === 'string' ? detail : detail.message);
            Object.assign(error, { nativeError: detail });
            reject(error);
          }
        } catch (error) {
          fail(error as Error);
        }
      });
      socket.once('end', () => {
        if (!finished) fail(new Error('native_host_response_lost'));
      });
    });
  }
  async invoke(
    owner: NativeOwner,
    method: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    try {
      return await this.exchange(owner, method, args, signal);
    } catch (error) {
      // Only failures before connect are safe to retry. Lost dispatch replies are never replayed.
      const code = (error as NodeJS.ErrnoException).code;
      if (!this.launch || !['ENOENT', 'ECONNREFUSED'].includes(code ?? '')) throw error;
      privateDirectory(this.home);
      privateDirectory(join(this.home, 'native-hosts'));
      const path = hostSocket(this.home, owner);
      // Serialize endpoint startup only. This lock contains a process PID, never session/task state.
      const lock = `${path}.start`;
      let locked = false;
      for (let attempt = 0; attempt < 100 && !locked; attempt++) {
        try {
          writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
          locked = true;
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code !== 'EEXIST') throw lockError;
          try {
            const pid = Number(readFileSync(lock, 'utf8'));
            if (Number.isSafeInteger(pid) && pid > 0) {
              try {
                process.kill(pid, 0);
              } catch (dead) {
                if ((dead as NodeJS.ErrnoException).code === 'ESRCH') unlinkSync(lock);
              }
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 50));
          try {
            return await this.exchange(owner, method, args, signal);
          } catch (retryError) {
            if (!['ENOENT', 'ECONNREFUSED'].includes((retryError as NodeJS.ErrnoException).code ?? ''))
              throw retryError;
          }
        }
      }
      if (!locked) throw new Error('native_host_start_in_progress');
      try {
        // Another frontend may have finished startup before this lock was acquired.
        try {
          return await this.exchange(owner, method, args, signal);
        } catch (checkError) {
          const checkCode = (checkError as NodeJS.ErrnoException).code;
          if (!['ENOENT', 'ECONNREFUSED'].includes(checkCode ?? '')) throw checkError;
          if (checkCode === 'ECONNREFUSED') {
            const st = lstatSync(path);
            if (!st.isSocket() || st.uid !== process.getuid?.() || st.mode & 0o077)
              throw new Error('unsafe_native_host_socket');
            unlinkSync(path);
          }
        }
        const child = spawnDetachedHost(this.entry, this.home, owner);
        let spawnError: Error | undefined;
        child.once('error', (error) => {
          spawnError = error;
        });
        for (let attempt = 0; attempt < 100; attempt++) {
          if (spawnError) throw spawnError;
          if (signal?.aborted) throw new Error('native_observation_cancelled');
          await new Promise((resolve) => setTimeout(resolve, 50));
          try {
            return await this.exchange(owner, method, args, signal);
          } catch (retryError) {
            if (!['ENOENT', 'ECONNREFUSED'].includes((retryError as NodeJS.ErrnoException).code ?? ''))
              throw retryError;
          }
        }
        throw new Error(`native_host_start_failed: ${path}.stderr.log`);
      } finally {
        try {
          unlinkSync(lock);
        } catch {}
      }
    }
  }
}
