import { createServer } from 'node:net';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

/** Wire-level fork stand-in; no subprocess or split inventory. */
export async function listenDock(t, path, { capable = true } = {}) {
  const calls = [];
  let exists = false;
  let hidden = false;
  let options = {};
  const subscribers = new Set();
  const applyOptions = (params = {}) => {
    const next = { ...options };
    for (const key of ['mode', 'side', 'width', 'height']) {
      if (params[key] !== undefined) next[key] = params[key];
    }
    options = next;
  };
  const server = createServer((socket) => {
    const lines = createInterface({ input: socket });
    lines.once('line', (line) => {
      const { id, method, params } = JSON.parse(line);
      calls.push({ method, params });
      if (method === 'events.subscribe' && capable) {
        const wantsResize = Array.isArray(params?.subscriptions) &&
          params.subscriptions.some((sub) => sub?.type === 'dock.resized');
        if (wantsResize) {
          subscribers.add(socket);
          socket.write(JSON.stringify({ id, result: { type: 'subscription_started' } }) + '\n');
          const drop = () => subscribers.delete(socket);
          socket.once('close', drop);
          socket.once('error', drop);
          return;
        }
      }
      let result, action;
      if (method === 'ping') result = { type: 'pong', version: 'test-hud', capabilities: { dock: capable } };
      else if (capable && ['dock.open', 'dock.toggle', 'dock.hide', 'dock.show', 'dock.close', 'dock.status', 'dock.configure'].includes(method)) {
        if (method === 'dock.close') {
          if (exists) action = 'closed';
          exists = false;
          hidden = false;
          options = {};
        } else if (method === 'dock.hide') {
          if (exists && !hidden) {
            hidden = true;
            action = 'hidden';
          } else action = 'unchanged';
        } else if (method === 'dock.show') {
          if (exists) {
            const wasHidden = hidden;
            hidden = false;
            applyOptions(params);
            action = wasHidden ? 'shown' : 'unchanged';
          } else action = 'unchanged';
        } else if (method === 'dock.toggle') {
          if (exists) {
            if (hidden) {
              hidden = false;
              applyOptions(params);
              action = 'shown';
            } else {
              hidden = true;
              action = 'hidden';
            }
          } else {
            exists = true;
            hidden = false;
            options = { mode: 'overlay', side: 'right', width: 56, height: 12 };
            applyOptions(params);
            action = 'opened';
          }
        } else if (method === 'dock.open') {
          if (exists) {
            const wasHidden = hidden;
            hidden = false;
            applyOptions(params);
            action = wasHidden ? 'shown' : 'unchanged';
          } else {
            exists = true;
            hidden = false;
            options = { mode: 'overlay', side: 'right', width: 56, height: 12 };
            applyOptions(params);
            action = 'opened';
          }
        } else if (method === 'dock.configure' && exists) {
          applyOptions(params);
        }
        const shown = exists && !hidden;
        result = {
          type: 'dock',
          shown,
          hidden: exists && hidden,
          ...(exists ? options : {}),
          ...(action ? { action } : {}),
        };
      }
      socket.end(JSON.stringify(result ? { id, result } : { id, error: { code: 'unknown_method' } }) + '\n');
    });
    socket.on('error', () => {});
  });
  server.listen(path);
  await once(server, 'listening');
  t.after(() => {
    for (const peer of subscribers) peer.destroy();
    subscribers.clear();
    return new Promise((resolve) => server.close(resolve));
  });
  return {
    calls,
    operations: () => calls.filter(({ method }) => method.startsWith('dock.')),
    state: () => ({ shown: exists && !hidden, hidden: exists && hidden, ...(exists ? options : {}) }),
    subscribers: () => subscribers.size,
    emitResized(side, size) {
      if (exists) {
        if (side === 'bottom') options = { ...options, height: size };
        else options = { ...options, width: size };
      }
      const line = JSON.stringify({ event: 'dock_resized', data: { type: 'dock_resized', side, size } }) + '\n';
      for (const peer of subscribers) peer.write(line);
    },
  };
}
