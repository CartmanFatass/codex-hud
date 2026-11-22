import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';

interface Reply {
  error?: { code: string };
  result?: {
    agent?: { agent_status?: string; agent_session?: { kind: string; value: string } };
    process_info?: { shell_pid: number; foreground_processes?: { pid: number }[] };
  };
}

// Herdr subscription sockets cannot carry requests; each query gets its own connection.
export function request(method: string, params: Record<string, unknown>, { timeoutMs = 2000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Reply | null> {
  const path = process.env.HERDR_SOCKET_PATH;
  if (!path || signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const lines = createInterface({ input: socket });
    let settled = false;
    const done = (body: Reply | null = null) => {
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
