/** A fresh ESM graph for a rebuilt service. The stdio/socket owner never moves.
 * Initial startup uses the main thread; only a rebuild needs a worker. Callers
 * hold the dist lock through import/ready, not through application requests. */
import { Worker, parentPort, workerData } from 'node:worker_threads';

if (parentPort && workerData?.hudGeneration) {
  const { openRuntime } = await import(workerData.hudGeneration);
  const runtime = openRuntime((event) => parentPort.postMessage({ event }));
  parentPort.on('message', async ({ id, method, args }) => {
    if (method === 'retire') { parentPort.close(); return; }
    try { parentPort.postMessage({ id, value: await runtime[method](...args) }); }
    catch (error) { parentPort.postMessage({ id, error: String(error) }); }
  });
  parentPort.postMessage({ id: 0 });
}

export async function openGeneration(url, onEvent, initial = false) {
  if (initial) {
    const runtime = (await import(url)).openRuntime(onEvent);
    return { call: async (method, ...args) => runtime[method](...args), retire() {} };
  }
  const worker = new Worker(new URL(import.meta.url), { workerData: { hudGeneration: url.href } });
  const pending = new Map();
  let serial = 0, dead;
  const response = (id) => new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  const ready = response(0);
  worker.on('message', ({ event, id, value, error }) => {
    if (event !== undefined) return onEvent(event);
    const request = pending.get(id);
    pending.delete(id);
    if (error) request.reject(new Error(error)); else request.resolve(value);
  });
  const fail = (error) => {
    dead = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', (code) => fail(new Error(`HUD generation exited (${code})`)));
  const timer = setTimeout(() => void worker.terminate(), 15000);
  try { await ready; } finally { clearTimeout(timer); }
  return {
    call(method, ...args) {
      if (dead) return Promise.reject(dead);
      const id = ++serial;
      worker.postMessage({ id, method, args });
      return response(id);
    },
    retire() { worker.postMessage({ method: 'retire' }); },
  };
}
