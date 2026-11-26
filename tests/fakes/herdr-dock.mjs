import { createServer } from 'node:net';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

/** Wire-level fork stand-in; no subprocess or split inventory. */
export async function listenDock(t, path, { capable = true } = {}) {
  const calls = [];
  let shown = false;
  let options = {};
  const server = createServer((socket) => {
    const lines = createInterface({ input: socket });
    lines.once('line', (line) => {
      const { id, method, params } = JSON.parse(line);
      calls.push({ method, params });
      let result, action;
      if (method === 'ping') result = { type: 'pong', version: 'test-hud', capabilities: { dock: capable } };
      else if (capable && ['dock.open', 'dock.toggle', 'dock.close', 'dock.status', 'dock.configure'].includes(method)) {
        if (method === 'dock.close' || (method === 'dock.toggle' && shown)) {
          shown = false;
          if (method === 'dock.toggle') action = 'closed';
        } else if (method === 'dock.open' || method === 'dock.toggle') {
          action = shown ? 'unchanged' : 'opened';
          shown = true;
          options = { mode: params.mode, width: params.width };
        } else if (method === 'dock.configure' && shown) options = params;
        result = { type: 'dock', shown, ...(shown ? options : {}), action };
      }
      socket.end(JSON.stringify(result ? { id, result } : { id, error: { code: 'unknown_method' } }) + '\n');
    });
    socket.on('error', () => {});
  });
  server.listen(path);
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { calls, operations: () => calls.filter(({ method }) => method.startsWith('dock.')), state: () => ({ shown, ...options }) };
}
