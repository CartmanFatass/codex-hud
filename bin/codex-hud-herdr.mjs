#!/usr/bin/env node
// This bridge observes only the launcher's main pane, never terminal output.
import { execFile } from 'node:child_process';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const TMUX_FORMAT = '#{session_name}\n#{pane_current_command}\n#{pane_dead}\n#{pane_title}';
const CODEX_BINARY =
  /^codex(?:-(?:x86_64|aarch64)-(?:unknown-linux-(?:musl|gnu)|apple-darwin|pc-windows-msvc))?(?:\.exe)?$/;
const STATES = new Set(['idle', 'working', 'blocked', 'unknown']);

export function readHerdrConfig(env = process.env) {
  if (
    env.HERDR_ENV !== '1' ||
    env.CODEX_HUD_HERDR_BRIDGE === '0' ||
    !env.HERDR_SOCKET_PATH?.trim() ||
    !env.HERDR_PANE_ID?.trim()
  )
    return null;
  // Capture the outer pane identity before entering the nested tmux session.
  return { socketPath: env.HERDR_SOCKET_PATH, paneId: env.HERDR_PANE_ID };
}

export function classifyPane(output, session) {
  if (typeof output !== 'string' || !session) return 'unknown';
  const fields = output.split('\n');
  if (fields.length < 4 || fields[0] !== session || fields[2] !== '0') return 'unknown';
  const command = fields[1];
  if (/\s|\0/.test(command) || !CODEX_BINARY.test(command.slice(command.lastIndexOf('/') + 1))) {
    return 'unknown';
  }
  // The title may itself contain newlines; only the first three fields are metadata.
  const title = fields.slice(3).join('\n');
  if (title.includes('Action Required')) return 'blocked';
  if (/(^| )[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]( |$)/.test(title.replace(/\n$/, ''))) return 'working';
  return title.trim() ? 'idle' : 'unknown';
}

export function readTmuxPane(mainPaneId, { signal, execFileImpl = execFile } = {}) {
  if (!/^%\d+$/.test(mainPaneId) || signal?.aborted) return Promise.resolve(null);
  return new Promise((resolveOutput) => {
    try {
      execFileImpl(
        'tmux',
        ['display-message', '-p', '-t', mainPaneId, TMUX_FORMAT],
        { encoding: 'utf8', timeout: 450, killSignal: 'SIGKILL', maxBuffer: 16 * 1024, signal },
        (error, stdout, stderr) =>
          resolveOutput(
            error
              ? /can't find pane|no such pane|no server running|error connecting to/i.test(stderr || '')
                ? { unavailable: 'target-missing' }
                : null
              : stdout
          )
      );
    } catch {
      resolveOutput(null);
    }
  });
}

// An API acknowledgement confirms transport only. Herdr can return Ok for a
// lifecycle report ignored because another source owns the native session.
let requestSerial = 0;
function requestHerdr(config, method, params, { signal, timeoutMs = 450, maxResponseBytes = 16 * 1024 } = {}) {
  if (!config || signal?.aborted) return Promise.resolve(null);
  return new Promise((resolveRequest) => {
    const id = `codex-hud-${process.pid}-${++requestSerial}`;
    const socket = new net.Socket();
    let settled = false;
    let response = Buffer.alloc(0);
    const finish = (reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      resolveRequest(reply);
    };
    const abort = () => finish(null);
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('error', abort);
    socket.on('end', abort);
    socket.on('close', abort);
    socket.on('data', (chunk) => {
      if (response.length + chunk.length > maxResponseBytes) return finish(null);
      response = Buffer.concat([response, chunk]);
      const newline = response.indexOf(10);
      if (newline < 0) return;
      try {
        const reply = JSON.parse(response.subarray(0, newline).toString('utf8'));
        finish(
          reply &&
            reply.id === id &&
            reply.error == null &&
            (reply.ok === true || (reply.ok === undefined && Object.hasOwn(reply, 'result')))
            ? reply
            : null
        );
      } catch {
        finish(null);
      }
    });
    try {
      socket.connect(config.socketPath, () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    } catch {
      finish(null);
    }
  });
}

// Legacy report mode is retained for bounded protocol regression tests. The
// launcher uses the read-only native observer below, never lifecycle reports.
export async function sendAgentReport(config, { state, seq }, options = {}) {
  if (!STATES.has(state) || !Number.isSafeInteger(seq) || seq < 0) return false;
  return Boolean(
    await requestHerdr(
      config,
      'pane.report_agent',
      { pane_id: config?.paneId, source: 'codex-hud:codex', agent: 'codex', state, seq },
      options
    )
  );
}

export async function readNativePane(config, options = {}) {
  const reply = await requestHerdr(config, 'pane.get', { pane_id: config?.paneId }, options);
  const pane = reply?.result?.pane;
  if (
    !pane ||
    pane.pane_id !== config.paneId ||
    !['idle', 'working', 'blocked', 'done', 'unknown'].includes(pane.agent_status)
  )
    return null;
  return pane.agent === 'codex' ? pane.agent_status : 'unknown';
}

function parentIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Sidecars belong to one outer attach client. Never share an owner file across attaches.
export function bridgeHealthPath(codexHome, session, pid = process.pid) {
  return join(codexHome, 'hud', 'herdr', session.replace(/[^A-Za-z0-9._-]/g, '_'), `${pid}.json`);
}

export async function writeBridgeHealth(file, health) {
  const directory = dirname(file);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(dirname(directory), 0o700);
    await chmod(directory, 0o700);
    await writeFile(temporary, `${JSON.stringify(health)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

// Manual poll() is useful for deterministic tests. start() adds the CLI timers.
// All I/O is single-flight, including the final release after an aborted poll.
export function createBridge({
  session,
  mainPaneId,
  parentPid,
  env = process.env,
  readPane = readTmuxPane,
  report = sendAgentReport,
  readNative = readNativePane,
  mode = 'report',
  now = Date.now,
  isParentAlive = parentIsAlive,
  pollMs = 750,
  heartbeatMs = 5000,
  parentCheckMs = 500,
  probeGraceMs = 3000,
  healthFilePath,
  writeHealth = writeBridgeHealth,
}) {
  const config = readHerdrConfig(env);
  const enabled = Boolean(
    config &&
    ['native', 'report'].includes(mode) &&
    session &&
    !/[\n\r\0]/.test(session) &&
    /^%\d+$/.test(mainPaneId) &&
    Number.isSafeInteger(parentPid) &&
    parentPid > 1
  );
  let stopping = !enabled;
  let started = false;
  let timer;
  let parentTimer;
  let inFlight;
  let activeAbort;
  let stopPromise;
  let lastState;
  let lastSuccessMs = 0;
  let probeFailureSince;
  let resetBeforePublish = false;
  let seq = 0;
  let finishDone;
  const health = {
    schemaVersion: 1,
    mode,
    nativeState: null,
    stateMatches: null,
    session,
    mainPaneId,
    parentPid,
    bridgePid: process.pid,
    herdrPaneId: config?.paneId ?? null,
    startedAtMs: now(),
    updatedAtMs: now(),
    lifecycle: enabled ? 'running' : 'stopped',
    observedState: 'unknown',
    publishedState: null,
    probe: { status: 'unavailable', consecutiveFailures: 0, lastSuccessAtMs: null },
    transport: { status: 'pending', consecutiveFailures: 0, lastSuccessAtMs: null },
    notificationGap: false,
    healthWriteError: false,
  };
  const done = new Promise((resolveDone) => {
    finishDone = resolveDone;
  });
  if (!enabled) finishDone();

  async function saveHealth() {
    health.updatedAtMs = now();
    if (!healthFilePath) return;
    try {
      health.healthWriteError = false;
      await writeHealth(healthFilePath, health);
    } catch {
      health.healthWriteError = true;
    }
  }

  async function publish(state, signal) {
    seq = Math.max(seq + 1, now() * 1000);
    let success = false;
    try {
      success = await report(config, { state, seq }, { signal });
    } catch {
      /* Retry next poll. */
    }
    if (success) {
      lastState = state;
      lastSuccessMs = now();
      health.publishedState = state;
      health.transport = { status: 'connected', consecutiveFailures: 0, lastSuccessAtMs: now() };
    } else if (!stopping) {
      health.transport.status = 'disconnected';
      health.transport.consecutiveFailures++;
      health.notificationGap = true;
      // An acknowledgement can be lost after Herdr applied a report. Clear that
      // ambiguous baseline before publishing fresh observations after recovery.
      resetBeforePublish = true;
    } else {
      health.transport.status = 'disconnected';
      health.transport.consecutiveFailures++;
    }
    return success;
  }

  async function observeNative(signal) {
    let nativeState = null;
    try {
      nativeState = await readNative(config, { signal });
    } catch {
      /* Retry next poll. */
    }
    if (stopping) return;
    health.nativeState = nativeState;
    if (nativeState == null) {
      health.transport.status = 'disconnected';
      health.transport.consecutiveFailures++;
      health.notificationGap = true;
      health.stateMatches = null;
      return;
    }
    health.transport = { status: 'connected', consecutiveFailures: 0, lastSuccessAtMs: now() };
    health.publishedState = nativeState === 'done' ? 'idle' : nativeState;
    health.stateMatches = health.observedState === health.publishedState;
    if (health.probe.status === 'ok' && !health.stateMatches) health.probe.status = 'mismatch';
  }

  function poll() {
    if (stopping) return Promise.resolve();
    if (inFlight) return inFlight;
    activeAbort = new AbortController();
    const { signal } = activeAbort;
    inFlight = Promise.resolve()
      .then(async () => {
        if (stopping) return;
        if (!isParentAlive(parentPid)) {
          void stop();
          return;
        }
        let output = null;
        try {
          output = await readPane(mainPaneId, { signal });
        } catch {
          /* Uncertain probe failure. */
        }
        if (stopping) return;
        let state;
        if (output == null) {
          probeFailureSince ??= now();
          health.probe.consecutiveFailures++;
          const withinGrace = now() - probeFailureSince < probeGraceMs;
          health.probe.status = withinGrace ? 'retrying' : 'unavailable';
          // Do not insert unknown between working and a subsequent observed idle
          // for a brief timeout. Never convert missing evidence into completion.
          if (withinGrace) {
            if (mode === 'native') await observeNative(signal);
            return;
          }
          health.notificationGap = true;
          state = 'unknown';
        } else {
          probeFailureSince = undefined;
          state = classifyPane(output, session);
          health.probe.status = typeof output === 'string' ? 'ok' : 'unavailable';
          health.probe.consecutiveFailures = 0;
          if (typeof output === 'string') health.probe.lastSuccessAtMs = now();
        }
        health.observedState = state;
        if (mode === 'native') {
          await observeNative(signal);
          return;
        }
        if (resetBeforePublish) {
          if (await publish('unknown', signal)) resetBeforePublish = false;
          // Re-read the exact pane on the next poll; do not retain a replay queue.
          return;
        }
        if (state !== lastState || now() - lastSuccessMs >= heartbeatMs) await publish(state, signal);
      })
      .catch(() => {})
      .finally(async () => {
        await saveHealth();
        inFlight = undefined;
        activeAbort = undefined;
      });
    return inFlight;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    clearTimeout(timer);
    clearInterval(parentTimer);
    activeAbort?.abort();
    stopPromise = (async () => {
      await inFlight;
      if (enabled && mode === 'report') await publish('unknown');
      health.lifecycle = 'stopped';
      await saveHealth();
      finishDone();
    })();
    return stopPromise;
  }

  function start() {
    if (started || stopping) return done;
    started = true;
    parentTimer = setInterval(() => {
      if (!isParentAlive(parentPid)) void stop();
    }, parentCheckMs);
    const tick = async () => {
      const began = now();
      await poll();
      if (!stopping) timer = setTimeout(tick, Math.max(0, pollMs - (now() - began)));
    };
    void tick();
    return done;
  }

  return { enabled, poll, start, stop, done, health: () => structuredClone(health) };
}

async function main() {
  const [session, mainPaneId, parentPid, codexHome, mode = 'native'] = process.argv.slice(2);
  const bridge = createBridge({
    session,
    mainPaneId,
    parentPid: Number(parentPid),
    mode,
    healthFilePath: session && codexHome ? bridgeHealthPath(codexHome, session) : undefined,
  });
  if (!bridge.enabled) return;
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  const stop = () => {
    void bridge.stop();
  };
  for (const signal of signals) process.on(signal, stop);
  try {
    await bridge.start();
  } finally {
    for (const signal of signals) process.off(signal, stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {});
}
