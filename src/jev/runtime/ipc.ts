// Minimal local socket for the Jev runtime.
//
// host-ipc.ts serves NativeSessionHost and imports the general host, one socket
// per native owner. This runtime is one process per HUD home and must not load
// that host, so the framing is reimplemented here: one JSON line per connection.

import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export interface IpcError {
  code: string;
  message: string;
  variable?: string;
}

const MAX_BYTES = 1_048_576;

export function ensureSocketDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
}

export async function serveLine(
  file: string,
  onRequest: (method: string, args: Record<string, unknown>, signal: AbortSignal, socket: Socket) => Promise<unknown>
): Promise<Server> {
  ensureSocketDir(file);
  try {
    if (lstatSync(file).isSocket()) unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const open = new Set<Socket>();
  const server = createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    let submitted = false;
    const controller = new AbortController();
    socket.on('error', () => undefined);
    socket.on('close', () => controller.abort());
    socket.on('data', (chunk) => {
      if (submitted) return;
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > MAX_BYTES) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      submitted = true;
      void (async () => {
        try {
          const input = JSON.parse(buffer.slice(0, newline)) as { method?: unknown; args?: unknown };
          if (!input || typeof input.method !== 'string' || !input.args || typeof input.args !== 'object') {
            throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
          }
          const value = await onRequest(input.method, input.args as Record<string, unknown>, controller.signal, socket);
          if (!socket.destroyed) socket.end(JSON.stringify({ ok: true, value }) + '\n');
        } catch (error) {
          const body = errorBody(error);
          if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, error: body }) + '\n');
        }
      })();
    });
  });
  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    for (const socket of open) socket.destroy();
    return close(callback);
  }) as Server['close'];
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(file, () => {
      server.off('error', reject);
      chmodSync(file, 0o600);
      resolve();
    });
  });
  return server;
}

/** Codes the socket may carry. Anything else, including a filesystem errno, becomes `internal`. */
const PUBLIC_CODES = new Set([
  'invalid_request',
  'association_conflict',
  'conflict',
  'not_found',
  'jev_credentials_missing',
  'judge_unavailable',
  'internal',
  'already_running',
  'interrupted',
  'runtime_start_failed',
  'runtime_timeout',
  'observation_ended',
  'unsafe_jev_socket',
  'config',
  'jev_env_perms',
  'jev_env_empty',
  'jev_state_dir_missing',
  'already_attempted',
  'resend_needs_confirmation',
  'provider_mismatch',
  'browser_busy',
  'browser_unavailable',
  'lease_lost',
  'invalid_label',
  'empty_prompt',
  'invalid_key',
  'record_corrupt',
]);

export function isPublicIpcCode(code: string): boolean {
  return PUBLIC_CODES.has(code);
}

export function errorBody(error: unknown): IpcError {
  const value = error as { code?: unknown; message?: unknown; variable?: unknown };
  const code = typeof value?.code === 'string' && PUBLIC_CODES.has(value.code) ? value.code : 'internal';
  const variable = typeof value?.variable === 'string' ? value.variable : undefined;
  return {
    code,
    message: code === 'internal' ? 'internal' : typeof value?.message === 'string' ? value.message : code,
    ...(variable ? { variable } : {}),
  };
}

function assertSafeSocket(file: string): void {
  const stat = lstatSync(file);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || stat.mode & 0o077) {
    throw Object.assign(new Error('unsafe_jev_socket'), { code: 'unsafe_jev_socket' });
  }
}

/**
 * One request. A dropped connection rejects `runtime_timeout`.
 * A missed deadline rejects `runtime_timeout` with `deadline: true`. The job is not cancelled.
 */
export function jevCall(
  file: string,
  method: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs = 10_000
): Promise<unknown> {
  assertSafeSocket(file);
  return new Promise((resolve, reject) => {
    const socket = createConnection(file);
    let buffer = '';
    let settled = false;
    const finish = (error?: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(Object.assign(new Error('runtime_timeout'), { code: 'runtime_timeout', deadline: true }));
    }, timeoutMs);
    const onAbort = () => finish(Object.assign(new Error('observation_ended'), { code: 'observation_ended' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.on('error', (error) => finish(error));
    socket.on('close', () => finish(Object.assign(new Error('runtime_timeout'), { code: 'runtime_timeout' })));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, newline)) as { ok?: boolean; value?: unknown; error?: IpcError };
        if (reply.ok) finish(undefined, reply.value);
        else finish(Object.assign(new Error(reply.error?.message ?? 'internal'), reply.error ?? { code: 'internal' }));
      } catch (error) {
        finish(error);
      }
    });
    socket.on('connect', () => {
      socket.write(JSON.stringify({ method, args }) + '\n');
    });
  });
}
