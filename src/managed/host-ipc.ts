import { createConnection } from 'node:net';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ownerKey, type NativeOwner } from './relations.js';
export interface NativeHostPort {
  invoke(owner: NativeOwner, method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
export function hostSocket(home: string, owner: NativeOwner): string {
  const directory = join(home, 'native-hosts');
  return join(directory, `${ownerKey(owner).slice(0, 32)}.sock`);
}
export class NativeHostClient implements NativeHostPort {
  constructor(readonly home: string) {}
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
    return this.exchange(owner, method, args, signal);
  }
}
