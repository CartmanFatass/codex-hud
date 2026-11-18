import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';

// Herdr subscription sockets cannot carry requests; each query gets its own connection.
export function request(method, params) {
  const path = process.env.HERDR_SOCKET_PATH;
  if (!path) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const lines = createInterface({ input: socket });
    const done = (body = null) => { clearTimeout(timer); lines.close(); socket.destroy(); resolve(body); };
    const timer = setTimeout(done, 2000);
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'hud-request', method, params }) + '\n'));
    lines.once('line', (line) => { try { done(JSON.parse(line)); } catch { done(); } });
    lines.on('error', () => done());
    socket.on('error', () => done());
    socket.on('end', () => done());
  });
}
