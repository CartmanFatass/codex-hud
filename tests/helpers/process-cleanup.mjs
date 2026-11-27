import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const activeFixtures = new Set();
let processHooksInstalled = false;
let guardian;

function canonical(dir) {
  if (!dir) return [];
  const abs = resolve(dir);
  const out = [abs];
  try {
    const real = fs.realpathSync(abs);
    if (real !== abs) out.push(real);
  } catch {}
  return out;
}

const tmpRoots = canonical(tmpdir());

function isWithin(target, prefix) {
  return target === prefix || target.startsWith(`${prefix}/`);
}

function isTempPath(path) {
  return tmpRoots.some((base) => path !== base && isWithin(path, base));
}

function readStat(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = raw.lastIndexOf(')');
    if (end < 0) return null;
    const fields = raw.slice(end + 2).split(' ');
    return { state: fields[0], ppid: Number(fields[1]), start: fields[19] };
  } catch {
    return null;
  }
}

function selfAndAncestors() {
  const skip = new Set([0, 1, process.pid]);
  let current = process.pid;
  for (let depth = 0; depth < 64; depth++) {
    const stat = readStat(current);
    if (!stat || !Number.isInteger(stat.ppid) || stat.ppid <= 1 || skip.has(stat.ppid)) break;
    skip.add(stat.ppid);
    current = stat.ppid;
  }
  return skip;
}

function normalizedPrefixes(dir) {
  return canonical(dir).filter(isTempPath);
}

/**
 * Find live (non-zombie) processes whose environment or argv belongs to a single temporary fixture.
 * Only matches paths strictly beneath tmpdir() and never matches this process or its ancestors.
 */
export function findFixtureProcesses({ root, hudHome } = {}) {
  const rootPrefixes = normalizedPrefixes(root);
  const hudPrefixes = normalizedPrefixes(hudHome);
  const allPrefixes = [...new Set([...rootPrefixes, ...hudPrefixes])];
  if (!allPrefixes.length) return [];

  const skip = selfAndAncestors();
  const matches = [];
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return [];
  }

  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (skip.has(pid)) continue;
    const stat = readStat(pid);
    if (!stat || /^[ZXx]$/.test(stat.state)) continue;

    let matched = false;
    let envHudHome = '';
    try {
      const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      for (const entry of env) {
        if (entry.startsWith('HUD_HOME=')) {
          envHudHome = entry.slice(9);
          if (allPrefixes.some((prefix) => isWithin(envHudHome, prefix))) matched = true;
        } else if (rootPrefixes.length && entry.startsWith('HOME=')) {
          const envHome = entry.slice(5);
          if (rootPrefixes.some((prefix) => isWithin(envHome, prefix))) matched = true;
        }
      }
    } catch {
      continue;
    }

    let args = [];
    try {
      args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    } catch {}
    if (!matched && args.some((arg) => allPrefixes.some((prefix) => isWithin(arg, prefix)))) {
      matched = true;
    }

    if (matched) {
      matches.push({ pid, state: stat.state, hudHome: envHudHome, cmdline: args.join(' ') });
    }
  }
  return matches;
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitExited(exited, ms) {
  if (ms <= 0) return null;
  let timer;
  try {
    return await Promise.race([
      exited.then((result) => ({ done: true, result })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ done: false, result: null }), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stop a direct ChildProcess cleanly without ever hanging teardown.
 * Optionally closes stdin first, then escalates SIGTERM -> SIGKILL if needed.
 */
export async function stopChild(child, exited, { closeStdin = false, graceMs = 1500, killMs = 400 } = {}) {
  const alreadyDead = () => child.exitCode !== null || child.signalCode !== null;
  if (alreadyDead()) return { forced: false, result: await exited };

  if (closeStdin && child.stdin && !child.stdin.destroyed) {
    try { child.stdin.end(); } catch {}
    const waited = await waitExited(exited, graceMs);
    if (waited?.done) return { forced: false, result: waited.result };
  }

  if (!alreadyDead()) {
    try { child.kill('SIGTERM'); } catch {}
    const waited = await waitExited(exited, killMs);
    if (waited?.done) return { forced: closeStdin, result: waited.result };
  }

  if (!alreadyDead()) {
    try { child.kill('SIGKILL'); } catch {}
    const waited = await waitExited(exited, 1000);
    return { forced: true, result: waited?.result ?? null };
  }
  return { forced: false, result: await exited };
}

/**
 * Reap every process belonging to a temporary fixture (SIGTERM -> grace -> SIGKILL).
 * Returns any processes still alive after the kill deadline (empty on success).
 */
// Allow a SIGKILLed process blocked in uninterruptible kernel I/O (`D`) under parallel load to exit.
export async function reapFixtureProcesses({ root, hudHome, graceMs = 500, killTimeoutMs = 10000 } = {}) {
  let procs = findFixtureProcesses({ root, hudHome });
  if (!procs.length) return [];

  for (const proc of procs) {
    const signal = /^[Tt]$/.test(proc.state) ? 'SIGKILL' : 'SIGTERM';
    try { process.kill(proc.pid, signal); } catch {}
  }

  const graceEnd = performance.now() + graceMs;
  while (performance.now() < graceEnd) {
    await delay(25);
    procs = findFixtureProcesses({ root, hudHome });
    if (!procs.length) return [];
  }

  const killEnd = performance.now() + killTimeoutMs;
  while (procs.length && performance.now() < killEnd) {
    for (const proc of procs) {
      try { process.kill(proc.pid, 'SIGKILL'); } catch {}
    }
    await delay(25);
    procs = findFixtureProcesses({ root, hudHome });
  }
  return procs;
}

export function reapFixtureProcessesSync({ root, hudHome } = {}) {
  for (const proc of findFixtureProcesses({ root, hudHome })) {
    try { process.kill(proc.pid, 'SIGKILL'); } catch {}
  }
}

export function assertNoFixtureProcesses({ root, hudHome } = {}) {
  const survivors = findFixtureProcesses({ root, hudHome });
  assert.equal(
    survivors.length,
    0,
    `Fixture left live process(es) for ${hudHome ?? root}: ${survivors
      .map((p) => `${p.pid} (${p.state}${p.hudHome ? `, HUD_HOME=${p.hudHome}` : ''}) ${p.cmdline}`)
      .join('; ')}`
  );
}

export function removeFixtureRoot({ root }) {
  assert.ok(normalizedPrefixes(root).length, `Not a fixture directory under tmpdir(): ${root}`);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// Register before fixture setup can throw. Always reap detached children before deleting HUD_HOME.
export function cleanupFixture(t, spec, stop) {
  let untrack;
  t.after(async () => {
    try {
      await stop?.();
    } finally {
      const survivors = await reapFixtureProcesses(spec);
      assert.deepEqual(survivors, [], `Fixture left live processes for ${spec.hudHome ?? spec.root}`);
      removeFixtureRoot(spec);
      untrack?.();
    }
  });
  untrack = trackFixture(spec);
}

function sweepAllSync() {
  for (const spec of activeFixtures) reapFixtureProcessesSync(spec);
}

function installProcessHooks() {
  if (processHooksInstalled) return;
  processHooksInstalled = true;
  process.on('exit', sweepAllSync);
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const handler = () => {
      sweepAllSync();
      process.off(signal, handler);
      try { process.kill(process.pid, signal); } catch { process.exit(128 + (signal === 'SIGINT' ? 2 : 15)); }
    };
    process.on(signal, handler);
  }
}

export function trackFixture({ root, hudHome }) {
  const spec = { root, hudHome };
  activeFixtures.add(spec);
  installProcessHooks();
  // JS exit hooks cannot run on SIGKILL. One detached guardian per test worker can still reap
  // detached HUD children when the worker or its node --test coordinator dies.
  if (!guardian) {
    const identity = (pid) => ({ pid, start: readStat(pid)?.start });
    const owner = process.env.NODE_TEST_CONTEXT === 'child-v8' && process.ppid > 1 ? identity(process.ppid) : undefined;
    guardian = fork(new URL('./fixture-guardian.mjs', import.meta.url), [JSON.stringify({ worker: identity(process.pid), owner })], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
    });
    guardian.unref();
    guardian.channel.unref();
  }
  guardian.send({ spec, active: true }, () => {});
  return () => {
    activeFixtures.delete(spec);
    guardian.send({ spec, active: false }, () => {});
  };
}
