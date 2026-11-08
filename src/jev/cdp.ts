// Direct Chrome DevTools Protocol transport for the Jev port (github.com/browser-use/jev-ultrafast @ 1231850a).
// Replaces browser-harness. Loopback CDP uses node:net plus a private http(s).Agent, so it does not
// follow HTTP(S)_PROXY even when Node is started with --use-env-proxy. Decision HTTP stays on global fetch.
// Node's global WebSocket does follow that proxy unless NO_PROXY lists the CDP host, so this client stays.

import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export class CdpClosed extends Error {
  constructor(message = 'cdp_closed') {
    super(message);
    this.name = 'CdpClosed';
  }
}

/** Browser discovery/connection failed; never expose network diagnostics to IPC callers. */
export class BrowserUnavailable extends Error {
  readonly code = 'browser_unavailable';
  constructor() {
    super('browser_unavailable');
    this.name = 'BrowserUnavailable';
  }
}

export interface DirectSocket {
  send(text: string): void;
  close(): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: (error?: Error) => void): void;
}

/** HTTP GET that does not consult the environment proxy. `agent: false` skips the global agent that `--use-env-proxy` replaces. */
export function loopbackJson(urlString: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const url = new URL(urlString);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return Promise.reject(new Error('cdp_url_unsupported'));
  }
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };
    const req = request(url, { method: 'GET', agent: false, headers: { Accept: 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.once('aborted', () => finish(new Error('cdp_http_aborted')));
      res.once('error', () => finish(new Error('cdp_http_closed')));
      res.once('close', () => {
        if (!res.complete) finish(new Error('cdp_http_closed'));
      });
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 400) {
          finish(new Error(`cdp_http_${res.statusCode}`));
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            finish(new Error('cdp_http_invalid'));
            return;
          }
          finish(undefined, parsed as Record<string, unknown>);
        } catch {
          finish(new Error('cdp_http_invalid'));
        }
      });
    });
    // Settle independently of socket events: destroying an already-closed
    // request need not emit another error. Only settlement clears this deadline.
    timer = setTimeout(() => {
      finish(new Error('cdp_http_timeout'));
      req.destroy();
    }, timeoutMs);
    req.once('close', () => finish(new Error('cdp_http_closed')));
    req.on('error', () => finish(new Error('cdp_http_closed')));
    req.end();
  });
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  let header: Buffer;
  const first = 0x80 | opcode;
  if (payload.length < 126) header = Buffer.from([first, 0x80 | payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

/** WebSocket client on a direct TCP socket. No Origin header, no proxy. */
export function connectDirectWebSocket(urlString: string, timeoutMs: number): Promise<DirectSocket> {
  const url = new URL(urlString);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return Promise.reject(new Error('cdp_websocket_unsupported'));
  const secure = url.protocol === 'wss:';
  const port = Number(url.port || (secure ? 443 : 80));
  const host = url.hostname;
  return new Promise((resolve, reject) => {
    const socket: Socket = secure ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
    let settled = false;
    let opened = false;
    const fail = (error: Error) => {
      if (settled && opened) {
        closeHandler?.(error);
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('cdp_connect_timeout')), timeoutMs);
    let buffer = Buffer.alloc(0);
    let messageHandler: ((text: string) => void) | undefined;
    let closeHandler: ((error?: Error) => void) | undefined;
    const queued: string[] = [];
    const fragments: Buffer[] = [];
    let fragmentOpcode = 0;

    const readFrames = () => {
      for (;;) {
        if (buffer.length < 2) return;
        const first = buffer[0];
        const second = buffer[1];
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const wide = buffer.readBigUInt64BE(2);
          if (wide > BigInt(32 * 1024 * 1024)) {
            fail(new Error('cdp_frame_too_large'));
            return;
          }
          length = Number(wide);
          offset = 10;
        }
        const maskLength = masked ? 4 : 0;
        if (buffer.length < offset + maskLength + length) return;
        let payload = buffer.subarray(offset + maskLength, offset + maskLength + length);
        if (masked) {
          const mask = buffer.subarray(offset, offset + 4);
          const copy = Buffer.from(payload);
          for (let i = 0; i < copy.length; i++) copy[i] ^= mask[i & 3];
          payload = copy;
        } else payload = Buffer.from(payload);
        buffer = buffer.subarray(offset + maskLength + length);
        if (opcode === 0x9) {
          socket.write(encodeFrame(0xa, payload));
          continue;
        }
        if (opcode === 0x8) {
          socket.end();
          closeHandler?.();
          return;
        }
        if (opcode === 0xa) continue;
        if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
          if (opcode !== 0x0) fragmentOpcode = opcode;
          fragments.push(payload);
          if (fin) {
            const message = Buffer.concat(fragments);
            fragments.length = 0;
            if (fragmentOpcode === 0x1) {
              const text = message.toString('utf8');
              if (messageHandler) messageHandler(text);
              else queued.push(text);
            }
            fragmentOpcode = 0;
          }
        }
      }
    };

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!opened) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const header = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + 4);
        if (!/^HTTP\/1\.[01] 101\b/.test(header)) {
          fail(new Error('cdp_websocket_rejected'));
          return;
        }
        opened = true;
        settled = true;
        clearTimeout(timer);
        resolve({
          send(text: string) {
            socket.write(encodeFrame(0x1, Buffer.from(text)));
          },
          close() {
            try {
              socket.end(encodeFrame(0x8, Buffer.alloc(0)));
            } catch {
              socket.destroy();
            }
            // A peer that does not answer the close frame must not keep the process alive.
            socket.unref();
          },
          onMessage(handler) {
            messageHandler = handler;
            for (const text of queued) handler(text);
            queued.length = 0;
          },
          onClose(handler) {
            closeHandler = handler;
          },
        });
      }
      readFrames();
    });
    socket.once('error', (error) => fail(error));
    socket.once('close', () => {
      if (!settled) fail(new Error('cdp_connect_closed'));
      else closeHandler?.(new CdpClosed());
    });
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      const key = randomBytes(16).toString('base64');
      const path = `${url.pathname || '/'}${url.search}`;
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
  });
}

interface PendingCall {
  sessionId?: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface CdpCallOptions {
  sessionId?: string;
  timeoutMs?: number;
}

/** One browser WebSocket. Flattened sessions are routed by sessionId. */
export class CdpConnection {
  private nextId = 0;
  private readonly pending = new Map<number, PendingCall>();
  private closed = false;

  private constructor(
    private readonly socket: DirectSocket,
    readonly timeoutMs: number
  ) {
    socket.onMessage((text) => this.receive(text));
    socket.onClose((error) => this.failAll(error ?? new CdpClosed()));
  }

  static async connect(cdpHttpUrl: string, timeoutMs: number): Promise<CdpConnection> {
    try {
      const versionUrl = new URL('/json/version', cdpHttpUrl);
      const version = await loopbackJson(versionUrl.href, timeoutMs);
      const websocketUrl = version.webSocketDebuggerUrl;
      if (typeof websocketUrl !== 'string' || !websocketUrl) throw new Error('cdp_browser_websocket_missing');
      const socket = await connectDirectWebSocket(websocketUrl, timeoutMs);
      return new CdpConnection(socket, timeoutMs);
    } catch {
      throw new BrowserUnavailable();
    }
  }

  call(method: string, params: Record<string, unknown> = {}, options: CdpCallOptions = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new CdpClosed());
    const id = ++this.nextId;
    const message: Record<string, unknown> = { id, method, params };
    if (options.sessionId) message.sessionId = options.sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`cdp_timeout:${method}`);
        error.name = 'CdpTimeoutError';
        reject(error);
      }, options.timeoutMs ?? this.timeoutMs);
      this.pending.set(id, { sessionId: options.sessionId, resolve, reject, timer });
      this.socket.send(JSON.stringify(message));
    });
  }

  close(): void {
    this.closed = true;
    this.socket.close();
    this.failAll(new CdpClosed());
  }

  private receive(text: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: { sessionId?: string };
      result?: unknown;
      error?: { message?: string };
      sessionId?: string;
    };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(`cdp_error:${message.error.message ?? 'unknown'}`);
        error.name = 'CdpError';
        pending.reject(error);
      } else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method === 'Target.detachedFromTarget' || message.method === 'Inspector.detached') {
      const sessionId = message.params?.sessionId ?? message.sessionId;
      for (const [id, pending] of this.pending) {
        if (!sessionId || pending.sessionId === sessionId) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(new CdpClosed('cdp_detached'));
        }
      }
    }
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}
