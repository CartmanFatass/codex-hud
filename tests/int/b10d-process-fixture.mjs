import { fork } from 'node:child_process';
import { once } from 'node:events';
export async function hudProcess(f, entry = 'bar', faults = false, sync = false) {
  const child = fork(new URL(sync ? './b10d-sync-process.mjs' : './b10d-hud-process.mjs', import.meta.url), [entry], {
    env: {
      ...process.env,
      HOME: f.home,
      HUD_HOME: f.home,
      CODEX_HOME: f.sourceRoot,
      CODEX_HUD_SETTINGS_PATH: f.home + '/synthetic-settings.json',
      B10D_SYNTHETIC_FIXTURE: JSON.stringify({
        home: f.home,
        sourceRoot: f.sourceRoot,
        parent: f.parent,
        rootFile: f.rootFile ?? f.file(f.parent.sessionId),
      }),
      B10D_SYNTHETIC_FAULTS: faults ? '1' : '0',
      B10D_SYNTHETIC_LEGACY: typeof faults === 'object' && faults.legacy ? '1' : '0',
      B10D_SYNTHETIC_PROBE: typeof faults === 'object' && faults.probe ? '1' : '0',
      B10D_SYNTHETIC_PIN_PROBE: typeof faults === 'object' && faults.pinProbe ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'advanced',
  });
  let sequence = 0,
    stderr = '',
    stdout = '';
  const waiting = new Map(),
    overruns = [];
  child.stdout.on('data', (chunk) => {
    stdout = (stdout + chunk).slice(-20000);
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-20000);
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('HUD process startup timeout ' + stderr)), 20000);
    child.on('message', (message) => {
      if (message.type === 'ready') {
        clearTimeout(timer);
        resolve();
      } else if (message.type === 'overrun') overruns.push(message.sample);
      else if (waiting.has(message.id)) {
        const w = waiting.get(message.id);
        waiting.delete(message.id);
        clearTimeout(w.timer);
        message.error ? w.reject(new Error(message.error)) : w.resolve(message.result);
      }
    });
  });
  child.on('exit', () => {
    for (const w of waiting.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('HUD exited ' + stderr));
    }
    waiting.clear();
  });
  const rpc = (command, values = {}, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const id = ++sequence,
        timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error('HUD RPC timeout ' + command + ' ' + stderr));
        }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      child.send({ id, command, ...values });
    });
  try {
    await ready;
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    throw error;
  }
  return {
    child,
    rpc,
    overruns,
    get stderr() {
      return stderr;
    },
    get stdout() {
      return stdout;
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      try {
        await rpc('close', {}, 5000);
      } catch {
        child.kill('SIGKILL');
      }
      await exited;
    },
    async kill(signal = 'SIGKILL') {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill(signal);
      await exited;
    },
  };
}
