// Loopback CDP stand-in. Speaks just enough HTTP and WebSocket for Browser.open and CdpConnection.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface FakeCdp {
  httpUrl: string;
  paths: string[];
  methods: string[];
  closedTargets: string[];
  navigated: string[];
  created: Record<string, unknown>[];
  expressions: string[];
  close(): Promise<void>;
}

export function startFakeCdp(
  options: {
    reply?: boolean;
    reportedHref?: (navigated: string) => string;
    port?: number;
    delayMs?: Record<string, number>;
    hang?: string[];
  } = {}
): Promise<FakeCdp> {
  const reply = options.reply !== false;
  const paths: string[] = [];
  const methods: string[] = [];
  const closedTargets: string[] = [];
  const navigated: string[] = [];
  const created: Record<string, unknown>[] = [];
  const expressions: string[] = [];
  const sockets = new Set<Duplex>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let navigatedUrl = 'about:blank';

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    paths.push(req.url ?? '');
    if ((req.url ?? '').startsWith('/json/version')) {
      const address = server.address();
      const port = address && typeof address !== 'string' ? address.port : 0;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/unit` }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  server.on('upgrade', (req, socket) => {
    paths.push(req.url ?? '');
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    const key = String(req.headers['sec-websocket-key'] ?? '');
    const accept = createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    let buffer: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      buffer = consume(buffer, (text) => {
        if (!reply) return;
        let message: { id?: number; method?: string; params?: Record<string, unknown> };
        try {
          message = JSON.parse(text) as typeof message;
        } catch {
          return;
        }
        if (typeof message.id !== 'number' || typeof message.method !== 'string') return;
        methods.push(message.method);
        const reportedHref = (options.reportedHref ?? ((url: string) => url))(navigatedUrl);
        const result = resultFor(message.method, message.params ?? {}, navigatedUrl, reportedHref);
        if (message.method === 'Target.createTarget') created.push(message.params ?? {});
        if (message.method === 'Runtime.evaluate' && typeof message.params?.expression === 'string') {
          expressions.push(message.params.expression);
        }
        if (message.method === 'Page.navigate' && typeof message.params?.url === 'string') {
          navigatedUrl = message.params.url;
          navigated.push(message.params.url);
        }
        const respond = () => {
          if (socket.destroyed) return;
          if (message.method === 'Target.closeTarget' && typeof message.params?.targetId === 'string') {
            closedTargets.push(message.params.targetId);
          }
          socket.write(textFrame(JSON.stringify({ id: message.id, result })));
        };
        if (options.hang?.includes(message.method)) return;
        const delay = options.delayMs?.[message.method] ?? 0;
        if (!delay) respond();
        else {
          const timer = setTimeout(() => {
            timers.delete(timer);
            respond();
          }, delay);
          timers.add(timer);
        }
      });
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen({ port: options.port ?? 0, host: '127.0.0.1', exclusive: true }, () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('fake_cdp_no_port'));
        return;
      }
      resolve({
        httpUrl: `http://127.0.0.1:${address.port}`,
        paths,
        methods,
        closedTargets,
        navigated,
        created,
        expressions,
        close: () =>
          new Promise((done) => {
            for (const timer of timers) clearTimeout(timer);
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

function unquote(quoted: string): string {
  if (quoted.startsWith('"')) return JSON.parse(quoted) as string;
  return quoted.slice(1, -1);
}

/** Evaluate the readyState and location.href clause. An unrecognised href clause is not ready. */
function locationReady(expression: string, href: string): boolean | undefined {
  if (!expression.includes('document.readyState')) return undefined;
  const equals = [...expression.matchAll(/location\.href === ("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g)];
  const differs = [...expression.matchAll(/location\.href !== ("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g)];
  if (equals.length === 0 && differs.length === 0) return false;
  const hrefOk =
    equals.every((match) => href === unquote(match[1])) && differs.every((match) => href !== unquote(match[1]));
  return hrefOk;
}

function resultFor(
  method: string,
  params: Record<string, unknown>,
  navigatedUrl: string,
  reportedHref: string
): unknown {
  if (method === 'Target.createTarget') return { targetId: 'jev1-owned-tab' };
  if (method === 'Target.attachToTarget') return { sessionId: 'jev1-session' };
  if (method === 'Runtime.evaluate') {
    const expression = typeof params.expression === 'string' ? params.expression : '';
    if (expression.trim() === 'document.readyState') return { result: { value: 'complete' } };
    const ready = locationReady(expression, reportedHref);
    if (ready !== undefined) return { result: { value: ready } };
    return {
      result: {
        value: {
          url: navigatedUrl,
          title: 'Synthetic',
          text: 'Hello',
          scroll: { y: 0 },
          marker: [
            1,
            navigatedUrl,
            0,
            0,
            1280,
            900,
            'Synthetic',
            'Hello',
            [{ id: 'e1', kind: 'click', label: 'Land', role: 'link', node: 1 }],
            0,
          ],
          actions: [{ id: 'e1', kind: 'click', label: 'Land', role: 'link', node: 1 }],
        },
      },
    };
  }
  return {};
}

function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function consume(buffer: Buffer, onText: (text: string) => void): Buffer {
  while (buffer.length >= 2) {
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return buffer;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return buffer;
      length = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }
    const maskLength = masked ? 4 : 0;
    if (buffer.length < offset + maskLength + length) return buffer;
    let payload = buffer.subarray(offset + maskLength, offset + maskLength + length);
    if (masked) {
      const mask = buffer.subarray(offset, offset + 4);
      const copy = Buffer.from(payload);
      for (let i = 0; i < copy.length; i++) copy[i] ^= mask[i & 3];
      payload = copy;
    }
    buffer = buffer.subarray(offset + maskLength + length);
    if (opcode === 0x8) return buffer;
    if (opcode === 0x1) onText(payload.toString('utf8'));
  }
  return buffer;
}
