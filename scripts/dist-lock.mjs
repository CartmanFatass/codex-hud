import { createHash } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';

const releaseRoot = new URL('..', import.meta.url);

// Published (or touched for a script-only rebuild) by each successful main build.
export function buildStamp() {
  try {
    const s = fs.statSync(new URL('../dist/index.js', import.meta.url), { bigint: true });
    return `${s.ino}:${s.ctimeNs}`;
  } catch { return null; }
}

// Best-effort evidence for doctor, not a lock or source of runtime state. Publish only
// after a generation starts successfully; a failed reload keeps the old receipt.
const generationStart = (pid) => {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
  } catch { return undefined; }
};
let registeredGenerationExit = false;
export function publishGeneration(kind, stamp) {
  if (!stamp) return;
  const pid = process.pid, start = generationStart(pid);
  const home = (process.env.HUD_HOME || join(process.env.HOME || homedir(), '.hud')).replace(/\/+$/, '');
  if (!start || !isAbsolute(home)) return;
  const dir = join(home, 'generations'), file = join(dir, `${pid}.json`), temp = join(dir, `${pid}.tmp`);
  try {
    const privateDirectory = (path) => {
      const st = fs.lstatSync(path);
      return st.isDirectory() && st.uid === process.getuid() && !(st.mode & 0o077);
    };
    if (!privateDirectory(home) || fs.realpathSync(home) !== home) return;
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') return; }
    if (!privateDirectory(dir)) return;
    if (!fs.existsSync(file)) {
      // A crash can strand receipts. Keep a fixed ceiling without evicting live services.
      const entries = fs.readdirSync(dir).filter((name) => /^\d+\.(?:json|tmp)$/.test(name));
      if (entries.length >= 256) {
        for (const name of entries) if (!generationStart(Number.parseInt(name, 10))) try { fs.unlinkSync(join(dir, name)); } catch {}
        if (fs.readdirSync(dir).length >= 256) return;
      }
    }
    try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') return; }
    fs.writeFileSync(temp, JSON.stringify({ kind, stamp, start }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
    if (!registeredGenerationExit) {
      registeredGenerationExit = true;
      process.once('exit', () => { try { fs.unlinkSync(file); } catch {} });
    }
  } catch { /* An unavailable receipt must not affect the service. */ }
}

const distLockName = (kind, root = releaseRoot) =>
  `\0myhud-${kind}-${createHash('sha256').update(fs.realpathSync(root)).digest('hex')}`;

function nudgeDrain(name) {
  const socket = createConnection(name);
  socket.on('error', () => {});
  socket.on('connect', () => {
    socket.end('D\n', () => socket.destroy());
  });
}

export async function acquireBuildLock(kind, root = releaseRoot) {
  const name = distLockName(kind, root);
  // Linux/WSL releases abstract sockets even after SIGKILL. No files or daemon to clean up.
  const lock = createServer((socket) => {
    socket.on('error', () => {});
    socket.end('W\n');
  });
  const deadline = performance.now() + 15_000;
  let attempts = 0;
  for (;;) {
    const listening = once(lock, 'listening');
    lock.listen(name);
    try {
      await listening;
      return lock;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      if (kind === 'dist') nudgeDrain(name);
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for the HUD ${kind === 'build' ? 'build lock' : 'dist lock'}`);
      attempts++;
      await delay(Math.min(remaining, Math.min(50, 10 + attempts * 5)));
    }
  }
}

function joinSharedReader(name, timeoutMs) {
  return new Promise((resolve) => {
    const socket = createConnection(name);
    let settled = false;
    let buf = '';
    const finish = (joined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onFail);
      socket.removeListener('end', onFail);
      socket.removeListener('close', onFail);
      if (joined) {
        socket.on('error', () => {});
        resolve(socket);
      } else {
        socket.destroy();
        resolve(null);
      }
    };
    const onFail = () => finish(false);
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl !== -1) finish(buf.slice(0, nl) === 'R');
    };
    const timer = setTimeout(onFail, Math.max(1, timeoutMs));
    socket.on('data', onData);
    socket.on('error', onFail);
    socket.on('end', onFail);
    socket.on('close', onFail);
  });
}

async function acquireSharedDistLock(root) {
  const name = distLockName('dist', root);
  const peers = new Set();
  let accepting = true;
  let hostDone = false;
  let closed = false;
  let drainTimer;
  const maybeClose = () => {
    if (!hostDone || peers.size > 0 || closed) return;
    closed = true;
    clearTimeout(drainTimer);
    lock.close();
  };
  const lock = createServer((socket) => {
    socket.on('error', () => {});
    if (!accepting) {
      socket.end('W\n');
      return;
    }
    peers.add(socket);
    socket.on('data', (chunk) => {
      // An exclusive publisher nudges with 'D' to stop admitting new readers and drain.
      if (chunk.includes(0x44)) {
        accepting = false;
        socket.destroy();
      }
    });
    socket.once('end', () => socket.destroy());
    socket.once('close', () => {
      peers.delete(socket);
      maybeClose();
    });
    socket.write('R\n');
  });
  const deadline = performance.now() + 15_000;
  let attempts = 0;
  for (;;) {
    const listening = once(lock, 'listening');
    lock.listen(name);
    try {
      await listening;
      return () => {
        hostDone = true;
        if (peers.size === 0) {
          maybeClose();
          return;
        }
        // Keep accepting peers briefly during bursts unless a writer nudges, without stalling the host.
        drainTimer = setTimeout(() => {
          accepting = false;
          maybeClose();
        }, 1000);
        drainTimer.unref();
      };
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error('Timed out waiting for the HUD dist lock');
      const peer = await joinSharedReader(name, Math.min(2000, remaining));
      if (peer) return () => { peer.destroy(); };
      const left = deadline - performance.now();
      if (left <= 0) throw new Error('Timed out waiting for the HUD dist lock');
      attempts++;
      await delay(Math.min(left, Math.min(50, 10 + attempts * 5)));
    }
  }
}

// Take the same lock on both sides: a check alone can race the first rename.
// Readers share the lock concurrently; publishers take it exclusively.
export async function withDistLock(load, root = releaseRoot, { exclusive = false } = {}) {
  const release = exclusive
    ? await acquireBuildLock('dist', root).then((lock) => () => lock.close())
    : await acquireSharedDistLock(root);
  try {
    return await load();
  } finally {
    await release();
  }
}

const HEAP_CAPS = {
  panel: { old: 128, semi: 4 },
  watch: { old: 96, semi: 2 },
  mcp: { old: 96, semi: 2 },
};

function hasHeapFlag(name, execArgv, nodeOptions) {
  const flag = name.replace(/-/g, '[-_]');
  if (execArgv.some((arg) => new RegExp(`^--${flag}(?:=|$)`).test(arg))) return true;
  return typeof nodeOptions === 'string' && new RegExp(`(?:^|\\s)--${flag}(?:=|\\s|$)`).test(nodeOptions);
}

/** Resolve V8 heap cap flags for a long-lived process; HUD_HEAP_CAPS=off/0/default restores Node defaults. */
export function v8HeapArgs(profile, env = process.env, execArgv = []) {
  const raw = env.HUD_HEAP_CAPS?.trim().toLowerCase();
  if (raw && /^(?:0|off|false|default|none)$/.test(raw)) return [];
  const custom = raw ? /^([1-9]\d*)(?:\/([1-9]\d*))?$/.exec(raw) : null;
  const cap = custom ? { old: Number(custom[1]), semi: custom[2] ? Number(custom[2]) : undefined } : HEAP_CAPS[profile];
  if (!cap) return [];
  const args = [];
  if (cap.old && !hasHeapFlag('max-old-space-size', execArgv, env.NODE_OPTIONS)) args.push(`--max-old-space-size=${cap.old}`);
  if (cap.semi && !hasHeapFlag('max-semi-space-size', execArgv, env.NODE_OPTIONS)) args.push(`--max-semi-space-size=${cap.semi}`);
  return args;
}

/** Re-exec in-place with V8 heap caps when launched directly (e.g. shebang) without them. */
export function applyV8HeapCaps(profile) {
  if (['win32', 'os400'].includes(process.platform) || typeof process.execve !== 'function') return;
  const args = v8HeapArgs(profile, process.env, process.execArgv);
  if (!args.length) return;
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
  process.execve(process.execPath, [process.execPath, ...args, ...process.execArgv, ...process.argv.slice(1)], env);
}
