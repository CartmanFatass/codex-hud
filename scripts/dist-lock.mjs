import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const releaseRoot = new URL('..', import.meta.url);

// Published (or touched for a script-only rebuild) by each successful main build.
export function buildStamp() {
  try {
    const s = statSync(new URL('../dist/index.js', import.meta.url), { bigint: true });
    return `${s.ino}:${s.ctimeNs}`;
  } catch { return null; }
}

export async function acquireBuildLock(kind, root = releaseRoot) {
  const name = `\0myhud-${kind}-${createHash('sha256').update(realpathSync(root)).digest('hex')}`;
  // Linux/WSL releases abstract sockets even after SIGKILL. No files or daemon to clean up.
  const lock = createServer((socket) => socket.destroy());
  const deadline = performance.now() + 15_000;
  for (;;) {
    const listening = once(lock, 'listening');
    lock.listen(name);
    try {
      await listening;
      return lock;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for the HUD ${kind === 'build' ? 'build lock' : 'dist lock'}`);
      await delay(Math.min(10, remaining));
    }
  }
}

// Take the same lock on both sides: a check alone can race the first rename.
// Release it after the startup imports, never hold it while running a command.
export async function withDistLock(load, root = releaseRoot) {
  const lock = await acquireBuildLock('dist', root);
  try {
    return await load();
  } finally {
    lock.close();
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
