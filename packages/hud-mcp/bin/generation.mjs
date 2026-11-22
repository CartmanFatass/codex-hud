// Source-only bootstrap: hud-mcp imports this before the Node guard and dist lock.
/** A fresh ESM graph in a worker thread for a reloadable service. The stdio
 * owner stays on the main thread and never pins a service graph. Callers
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

const RETIRE_GRACE_MS = 100;

export async function openGeneration(url, onEvent) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { hudGeneration: url.href } });
  const pending = new Map();
  let serial = 0, dead, retiring = false, shuttingDown = false, exitResolve, graceTimer;
  const exited = new Promise((resolve) => { exitResolve = resolve; });
  const response = (id) => new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  const ready = response(0);
  const finishRetire = () => {
    if (!retiring || shuttingDown || pending.size > 0) return;
    shuttingDown = true;
    if (dead) return;
    try { worker.postMessage({ method: 'retire' }); } catch {}
    // Guarantee retired worker threads exit even if a ref'd handle remains open.
    graceTimer = setTimeout(() => { void worker.terminate(); }, RETIRE_GRACE_MS);
    graceTimer.unref();
  };
  worker.on('message', ({ event, id, value, error }) => {
    if (event !== undefined) return onEvent?.(event);
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (error) request.reject(new Error(error)); else request.resolve(value);
    finishRetire();
  });
  const fail = (error) => {
    dead ??= error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', (code) => {
    clearTimeout(graceTimer);
    fail(new Error(`HUD generation exited (${code})`));
    exitResolve();
  });
  const timer = setTimeout(() => void worker.terminate(), 15000);
  try {
    await ready;
  } catch (error) {
    await worker.terminate();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return {
    call(method, ...args) {
      if (dead) return Promise.reject(dead);
      if (retiring) return Promise.reject(new Error('HUD generation retiring'));
      const id = ++serial;
      worker.postMessage({ id, method, args });
      return response(id);
    },
    retire() {
      retiring = true;
      finishRetire();
      return exited;
    },
  };
}
