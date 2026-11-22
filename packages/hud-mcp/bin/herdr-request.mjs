import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';

// Herdr subscription sockets cannot carry requests; each query gets its own connection.
export function request(method, params, { timeoutMs = 2000, signal } = {}) {
  const path = process.env.HERDR_SOCKET_PATH;
  if (!path || signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const lines = createInterface({ input: socket });
    let settled = false;
    const done = (body = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      lines.close();
      socket.destroy();
      resolve(body);
    };
    const abort = () => done();
    const timer = setTimeout(done, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'hud-request', method, params }) + '\n'));
    lines.once('line', (line) => { try { done(JSON.parse(line)); } catch { done(); } });
    lines.on('error', abort);
    socket.on('error', abort);
    socket.on('close', abort);
  });
}
