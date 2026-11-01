#!/usr/bin/env node
// Throwaway prototype of the 方案乙 sidecar.
//
// It runs outside the pane, polls Herdr's read-only pane API and records the
// moment the pane's foreground harness process disappears. Herdr's API exposes
// the foreground pid/name and agent_status, but no exit code; when the code is
// unavailable the sidecar writes no exit receipt (the run must stay uncertain).
// It is NOT the real hud-run.
//
// Usage:
//   node mini-sidecar.mjs --run <runId> --hud-home <dir> --pane <paneId> [--interval 300]
//
// Layout under <hud-home>: runs/<runId>/sidecar/{meta.json,heartbeat.json,observations.jsonl,observed-exit.json}
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const options = { runId: '', hudHome: '', pane: '', interval: 300 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--run') options.runId = argv[++i] || '';
    else if (arg === '--hud-home') options.hudHome = argv[++i] || '';
    else if (arg === '--pane') options.pane = argv[++i] || '';
    else if (arg === '--interval') options.interval = Number(argv[++i]) || 300;
  }
  return options;
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function appendLine(file, value) {
  try {
    fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
  } catch {
    // the probe must not crash the harness
  }
}

function herdrJson(args) {
  try {
    const output = execFileSync('herdr', args, { encoding: 'utf8', timeout: 5000 });
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function paneProcessInfo(pane) {
  const response = herdrJson(['pane', 'process-info', '--pane', pane]);
  return response?.result?.process_info ?? null;
}

function paneGet(pane) {
  const response = herdrJson(['pane', 'get', pane]);
  return response?.result?.pane ?? null;
}

const SHELL_NAMES = new Set(['zsh', 'bash', 'sh', 'fish', 'nu', 'dash', 'ksh']);

const options = parseArgs(process.argv.slice(2));
if (!options.runId || !options.pane) {
  console.error('usage: mini-sidecar.mjs --run <runId> --hud-home <dir> --pane <paneId>');
  process.exit(2);
}

const hudHome = options.hudHome || process.env.HUD_HOME || path.join(os.tmpdir(), 'mini-hud-home');
const runDir = path.join(hudHome, 'runs', options.runId, 'sidecar');
fs.mkdirSync(runDir, { recursive: true });
const observations = path.join(runDir, 'observations.jsonl');
const startedAt = new Date().toISOString();
const startedMs = Date.now();

writeJson(path.join(runDir, 'meta.json'), {
  schemaVersion: 1,
  runId: options.runId,
  mode: 'sidecar',
  sidecarPid: process.pid,
  pane: options.pane,
  startedAt,
  intervalMs: options.interval,
});

let harness = null;
let lastState = '';
let stopped = false;
let heartbeatTimer = null;

function heartbeat(alive, extra) {
  writeJson(path.join(runDir, 'heartbeat.json'), {
    runId: options.runId,
    at: new Date().toISOString(),
    sidecarPid: process.pid,
    pane: options.pane,
    sidecarAlive: true,
    harnessPid: harness?.pid ?? null,
    harnessName: harness?.name ?? null,
    ...extra,
  });
  if (!alive) {
    // keep the last observation in the file; sidecarAlive is the liveness bit
    writeJson(path.join(runDir, 'heartbeat.json'), {
      runId: options.runId,
      at: new Date().toISOString(),
      sidecarPid: process.pid,
      pane: options.pane,
      sidecarAlive: false,
      harnessPid: harness?.pid ?? null,
      harnessName: harness?.name ?? null,
      ...extra,
    });
  }
}

function stop(reason, extra) {
  if (stopped) return;
  stopped = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  appendLine(observations, { at: new Date().toISOString(), event: 'sidecar-stop', reason, ...extra });
  heartbeat(false, extra);
  process.exit(0);
}

function observe() {
  if (stopped) return;
  const info = paneProcessInfo(options.pane);
  if (!info) {
    appendLine(observations, { at: new Date().toISOString(), event: 'pane-gone', pane: options.pane });
    writeJson(path.join(runDir, 'observed-pane-gone.json'), {
      runId: options.runId,
      pane: options.pane,
      observedAt: new Date().toISOString(),
      receiptWritten: false,
      reason: 'pane process-info unavailable (pane closed or Herdr unreachable)',
    });
    stop('pane-gone');
    return;
  }

  const pane = paneGet(options.pane);
  const processes = info.foreground_processes || [];
  const foreground = processes[0] || null;
  const state = JSON.stringify({
    pid: foreground?.pid ?? null,
    name: foreground?.name ?? null,
    pgid: info.foreground_process_group_id ?? null,
    agent: pane?.agent ?? null,
    status: pane?.agent_status ?? null,
  });

  if (state !== lastState) {
    appendLine(observations, {
      at: new Date().toISOString(),
      event: 'state',
      foregroundPid: foreground?.pid ?? null,
      foregroundName: foreground?.name ?? null,
      foregroundPgid: info.foreground_process_group_id ?? null,
      agent: pane?.agent ?? null,
      agentStatus: pane?.agent_status ?? null,
      processes: processes.map((item) => ({ pid: item.pid, name: item.name })),
    });
    lastState = state;
  }

  if (foreground && !SHELL_NAMES.has(foreground.name || '')) {
    if (!harness || harness.pid !== foreground.pid) {
      harness = { pid: foreground.pid, name: foreground.name, seenAt: new Date().toISOString() };
      appendLine(observations, { at: new Date().toISOString(), event: 'harness-seen', ...harness });
    }
  } else if (harness && !stopped) {
    // The foreground process is gone (the shell is back, or another process
    // took the pane). Herdr exposes no exit code, so no exit receipt is written.
    const observedAt = new Date().toISOString();
    appendLine(observations, {
      at: observedAt,
      event: 'foreground-exit',
      lastHarnessPid: harness.pid,
      lastHarnessName: harness.name,
      foregroundPid: foreground?.pid ?? null,
      foregroundName: foreground?.name ?? null,
      agentStatus: pane?.agent_status ?? null,
      exitCode: null,
      exitCodeSource: null,
    });
    writeJson(path.join(runDir, 'observed-exit.json'), {
      schemaVersion: 1,
      runId: options.runId,
      pane: options.pane,
      harnessPid: harness.pid,
      harnessName: harness.name,
      observedAt,
      durationMs: Date.now() - startedMs,
      exitCode: null,
      signal: null,
      receiptWritten: false,
      reason: 'Herdr pane API exposes no exit code or signal; a missing receipt leaves the run uncertain',
    });
    stop('foreground-exit');
  }
}

heartbeat(true);
heartbeatTimer = setInterval(() => {
  heartbeat(true);
  observe();
}, options.interval);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(`signal-${signal}`));
}

observe();
