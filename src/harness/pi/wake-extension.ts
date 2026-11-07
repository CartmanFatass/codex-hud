/** Session-scoped pi extension. Loads directly through pi's extension loader. */
import { chmod, lstat, mkdir, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { nativeWakeMessage, type NativeWakeDetails as Details } from '../../managed/wake-message.js';

const REQUEST_BYTES = 65536;
const MESSAGE_BYTES = 512;
interface WakeRequest {
  parentSessionId: string;
  content: string;
  details: Details;
  command: 'read native session';
}
interface WakeContext {
  sessionManager: { getSessionId(): string };
}
/** The documented pi API subset; avoids a runtime/package dependency in HUD. */
export interface PiWakeAPI {
  on(
    event: 'session_start' | 'session_shutdown',
    handler: (event: unknown, ctx: WakeContext) => void | Promise<void>
  ): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean; details: Details },
    options: { triggerTurn: true; deliverAs: 'followUp' }
  ): void;
}

function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function id(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\s\x00-\x1f\x7f/\\]/.test(value)) return false;
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}
function seq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
export function validWakeRequest(value: unknown): value is WakeRequest {
  if (
    !record(value, ['parentSessionId', 'content', 'details', 'command']) ||
    !id(value.parentSessionId) ||
    value.command !== 'read native session' ||
    typeof value.content !== 'string' ||
    !value.content ||
    Buffer.byteLength(value.content) > MESSAGE_BYTES ||
    /[\x00-\x1f\x7f]/.test(value.content)
  )
    return false;
  const d = value.details as Details;
  if (
    !d ||
    typeof d !== 'object' ||
    !record(d, ['connectionId', 'nativeRef', 'eventSeq', 'kind', ...(d.kind === 'request' ? ['requestId'] : [])]) ||
    !id(d.connectionId) ||
    !seq(d.eventSeq) ||
    !['result', 'request'].includes(d.kind) ||
    (d.kind === 'request' ? !id(d.requestId) : d.requestId !== undefined)
  )
    return false;
  if (d.nativeRef !== null) {
    const ref = d.nativeRef;
    if (
      !ref ||
      !['codex', 'claude', 'pi'].includes(ref.harness) ||
      !(ref.harness === 'codex' ? id(ref.threadId) : id(ref.sessionId))
    )
      return false;
  }
  return value.content === nativeWakeMessage(d);
}

/** The extension's synchronous native API boundary, also usable with a synthetic Pi API. */
export function deliverPiWake(
  pi: PiWakeAPI,
  request: WakeRequest,
  boundSessionId: string,
  ctx: WakeContext
): { result: 'accepted' | 'rejected' | 'unknown'; reason?: string } {
  if (request.parentSessionId !== boundSessionId || boundSessionId !== ctx.sessionManager.getSessionId())
    return { result: 'rejected', reason: 'stale_session' };
  try {
    pi.sendMessage(
      { customType: 'hud_wake', content: request.content, display: true, details: request.details },
      { triggerTurn: true, deliverAs: 'followUp' }
    );
    return { result: 'accepted' };
  } catch {
    return { result: 'unknown', reason: 'send_failed' };
  }
}

/** No session/state/key files are opened: procfs supplies only our process start stamp. */
export async function piWakeSocketPath(hudHome = process.env.HUD_HOME ?? join(homedir(), '.hud')): Promise<string> {
  if (!isAbsolute(hudHome)) throw new Error('HUD_HOME must be absolute');
  const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  const start = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/)[19];
  if (!/^\d+$/.test(start ?? '')) throw new Error('process start unavailable');
  return join(hudHome, 'wake', `pi-${process.pid}-${start}.sock`);
}

export default function hudWake(pi: PiWakeAPI): void {
  let server: Server | undefined;
  let endpoint: string | undefined;
  let socketIdentity: { dev: number; ino: number } | undefined;
  let current: WakeContext | undefined;
  const clients = new Set<Socket>();

  const shutdown = async () => {
    current = undefined;
    for (const client of clients) client.destroy();
    clients.clear();
    const closing = server;
    const path = endpoint;
    const identity = socketIdentity;
    server = undefined;
    endpoint = undefined;
    socketIdentity = undefined;
    if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
    if (path && identity) {
      try {
        const stat = await lstat(path);
        if (stat.isSocket() && stat.dev === identity.dev && stat.ino === identity.ino) await unlink(path);
      } catch {
        /* Another lifecycle may already have removed it. */
      }
    }
  };

  pi.on('session_shutdown', shutdown);
  pi.on('session_start', async (_event, ctx) => {
    const boundSessionId = ctx.sessionManager.getSessionId();
    await shutdown();
    const path = await piWakeSocketPath();
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const dir = await lstat(directory);
    if (!dir.isDirectory() || (dir.mode & 0o077) !== 0 || (process.getuid && dir.uid !== process.getuid()))
      throw new Error('wake directory must be private');
    // Never unlink an existing endpoint: an unexpected live listener is not ours.
    const listening = createServer((socket) => {
      clients.add(socket);
      let input = Buffer.alloc(0);
      let replied = false;
      const timer = setTimeout(() => {
        reply('rejected', 'timeout');
        socket.destroy();
      }, 2000);
      timer.unref();
      const reply = (result: 'accepted' | 'rejected' | 'unknown', reason?: string) => {
        if (replied) return;
        replied = true;
        clearTimeout(timer);
        socket.end(JSON.stringify({ result, ...(reason ? { reason } : {}) }) + '\n', () => socket.destroy());
      };
      socket.on('error', () => {});
      socket.once('close', () => {
        clearTimeout(timer);
        clients.delete(socket);
      });
      socket.on('data', (chunk: Buffer) => {
        if (replied) return;
        if (input.length + chunk.length > REQUEST_BYTES) {
          reply('rejected', 'request_too_large');
          return;
        }
        input = Buffer.concat([input, chunk]);
        if (!input.includes(10)) return;
        let request: unknown;
        try {
          request = JSON.parse(input.toString('utf8'));
        } catch {
          reply('rejected', 'invalid_request');
          return;
        }
        if (!validWakeRequest(request)) {
          reply('rejected', 'invalid_request');
          return;
        }
        // No await between the fresh binding check and the turn-triggering API.
        if (
          current !== ctx ||
          request.parentSessionId !== boundSessionId ||
          boundSessionId !== ctx.sessionManager.getSessionId()
        ) {
          reply('rejected', 'stale_session');
          return;
        }
        const delivered = deliverPiWake(pi, request, boundSessionId, ctx);
        reply(delivered.result, delivered.reason);
      });
    });
    listening.maxConnections = 16;
    await new Promise<void>((resolve, reject) => {
      listening.once('error', reject);
      listening.listen(path, () => {
        listening.removeListener('error', reject);
        resolve();
      });
    });
    server = listening;
    endpoint = path;
    try {
      const stat = await lstat(path);
      socketIdentity = { dev: stat.dev, ino: stat.ino };
      await chmod(path, 0o600);
      current = ctx;
      listening.on('error', () => {
        void shutdown();
      });
    } catch (error) {
      await shutdown();
      throw error;
    }
  });
}
