#!/usr/bin/env node
// Throwaway prototype of hud-run's visible mode (方案甲: wrapper).
//
// It is typed into a Herdr pane's interactive shell, runs the harness through
// `$SHELL -ic "<text>"` with the TTY inherited, writes a heartbeat every second
// and an exit receipt once the verified harness process group is empty. It is
// NOT the real hud-run.
//
// Usage:
//   node mini-hud-run.mjs --run <runId> --hud-home <dir> --shell "<text>"
//   node mini-hud-run.mjs --run <runId> --hud-home <dir> -- <argv...>
//
// Layout under <hud-home>:
//   runs/<runId>/{meta.json,heartbeat.json,signals.jsonl,exit.json,no-receipt.json,supervisor.log}
//
// Scope: the harness is discovered from the launch tree (the TTY foreground
// group under the intermediate shell), its pid/start/pgid are recorded in
// meta.json, and every signal is sent only after re-validating that stamp.
// exit.json is written only when no live process with that pgid is left; when
// the group cannot be shown empty, no-receipt.json says so instead.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SHELL_NAMES = new Set(['zsh', 'bash', 'sh', 'dash', 'fish', 'nu', 'ksh']);
const DISCOVERY_INTERVAL_MS = 100;
const WATCH_INTERVAL_MS = 200;
const DISCOVERY_TIMEOUT_MS = 60000;
// A candidate that is not the leader of a new foreground job group must be
// observed for this long, so a short shell-startup helper is not mistaken for
// the harness (the `exec` form keeps the harness in the shell's group).
const STABLE_MS = 600;
// After the verified group is empty, wait this long for the intermediate shell
// to report its status before writing a receipt with shellStatus: null.
const SHELL_STATUS_WAIT_MS = 10000;
// After the shell exits but the group is still alive, wait this long for the
// group to empty before writing no-receipt.json.
const GROUP_DRAIN_WAIT_MS = 15000;

function parseArgs(argv) {
  const options = {
    runId: '',
    hudHome: '',
    shell: '',
    argv: [],
    graceMs: 10000,
    termGraceMs: 2000,
    killWaitMs: 5000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--run') options.runId = argv[++i] || '';
    else if (arg === '--hud-home') options.hudHome = argv[++i] || '';
    else if (arg === '--shell') options.shell = argv[++i] || '';
    else if (arg === '--grace-ms') options.graceMs = Number(argv[++i]) || options.graceMs;
    else if (arg === '--term-grace-ms') options.termGraceMs = Number(argv[++i]) || options.termGraceMs;
    else if (arg === '--kill-wait-ms') options.killWaitMs = Number(argv[++i]) || options.killWaitMs;
    else if (arg === '--') {
      options.argv = argv.slice(i + 1);
      break;
    }
  }
  return options;
}

function readStat(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = text.lastIndexOf(')');
    const comm = text.slice(text.indexOf('(') + 1, close);
    const rest = text
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    // rest[0] is field 3 (state); field N is rest[N - 3].
    return {
      pid: Number(pid),
      comm,
      state: rest[0],
      ppid: Number(rest[1]),
      pgrp: Number(rest[2]),
      session: Number(rest[3]),
      ttyNr: Number(rest[4]),
      tpgid: Number(rest[5]),
      starttime: rest[19],
    };
  } catch {
    return null;
  }
}

function listProcs() {
  const table = new Map();
  let names = [];
  try {
    names = fs.readdirSync('/proc');
  } catch {
    return table;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const info = readStat(name);
    if (info) table.set(info.pid, info);
  }
  return table;
}

function descendantsOf(rootPid, table) {
  const children = new Map();
  for (const info of table.values()) {
    if (!children.has(info.ppid)) children.set(info.ppid, []);
    children.get(info.ppid).push(info);
  }
  const found = [];
  const queue = [[rootPid, 0]];
  const seen = new Set([rootPid]);
  while (queue.length) {
    const [pid, depth] = queue.shift();
    for (const child of children.get(pid) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push({ ...child, depth: depth + 1 });
      queue.push([child.pid, depth + 1]);
    }
  }
  return found;
}

function shallowest(list) {
  return [...list].sort((a, b) => a.depth - b.depth || a.pid - b.pid)[0];
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

const options = parseArgs(process.argv.slice(2));
if (!options.runId) {
  console.error('usage: mini-hud-run.mjs --run <runId> --hud-home <dir> (--shell "<text>" | -- <argv...>)');
  process.exit(2);
}
if (!options.shell && options.argv.length === 0) {
  console.error('mini-hud-run: one of --shell or -- <argv...> is required');
  process.exit(2);
}

const hudHome = options.hudHome || process.env.HUD_HOME || path.join(os.tmpdir(), 'mini-hud-home');
const runDir = path.join(hudHome, 'runs', options.runId);
fs.mkdirSync(runDir, { recursive: true });

const command = options.shell
  ? { file: process.env.SHELL || '/bin/sh', args: ['-ic', options.shell] }
  : { file: options.argv[0], args: options.argv.slice(1) };

const self = readStat(process.pid) || {};
const supervisorPid = process.pid;
const supervisorPgid = self.pgrp;
const supervisorPidStart = self.starttime;
const startedAt = new Date().toISOString();
const startedMs = Date.now();
const logFile = path.join(runDir, 'supervisor.log');
const log = (message) => appendLine(logFile, { at: new Date().toISOString(), message });

let child = null;
let childPid = null;
let childPidStart = null;
let harness = null;
let ended = false;
let heartbeatTimer = null;
let discoveryTimer = null;
let discoveryTimeout = null;
let watchTimer = null;
let shellExited = false;
let shellExitedAt = null;
let shellStatus = null;
let shellSignal = null;
let harnessExitCode = null;
let harnessSignal = null;
let harnessExitSource = null;
let lastSignal = null;
let cancel = null;
let groupEmptySince = null;
let pendingKey = null;
let pendingSince = 0;

function scopeJson() {
  if (!harness) return null;
  return {
    kind: 'pgid',
    pgid: harness.pgrp,
    harnessPid: harness.pid,
    harnessPidStart: harness.starttime,
    harnessComm: harness.comm,
    harnessState: harness.state,
    harnessTpgid: harness.tpgid,
    harnessIsGroupLeader: harness.pid === harness.pgrp,
    pgidLeaderStart: harness.pgidLeaderStart,
    sharedWithSupervisor: harness.pgrp === supervisorPgid,
    discoveredAt: harness.discoveredAt,
  };
}

function writeMeta() {
  writeJson(path.join(runDir, 'meta.json'), {
    schemaVersion: 1,
    runId: options.runId,
    mode: 'visible',
    supervisorPid,
    supervisorPidStart,
    supervisorPgid,
    startedAt,
    cwd: process.cwd(),
    shell: options.shell ? command.file : null,
    text: options.shell || null,
    argv: options.shell ? null : command.args,
    tty: { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
    cancelPolicy: {
      graceMs: options.graceMs,
      termGraceMs: options.termGraceMs,
      killWaitMs: options.killWaitMs,
    },
    scope: scopeJson(),
  });
}

function groupMembers(pgid, { liveOnly = false } = {}) {
  if (!Number.isInteger(pgid) || pgid <= 0) return [];
  const table = listProcs();
  const members = [];
  for (const info of table.values()) {
    if (info.pgrp !== pgid) continue;
    // In the `exec` form the harness can share the supervisor's group; the
    // supervisor itself is never part of the workload scope.
    if (pgid === supervisorPgid && info.pid === supervisorPid) continue;
    if (liveOnly && info.state === 'Z') continue;
    members.push(info);
  }
  return members;
}

function memberJson(info) {
  return { pid: info.pid, comm: info.comm, state: info.state, starttime: info.starttime };
}

function heartbeat(alive) {
  const live = harness ? groupMembers(harness.pgrp, { liveOnly: true }) : [];
  writeJson(path.join(runDir, 'heartbeat.json'), {
    runId: options.runId,
    at: new Date().toISOString(),
    supervisorPid,
    supervisorPidStart,
    childPid,
    childPidStart,
    harnessPid: harness ? harness.pid : null,
    harnessPidStart: harness ? harness.starttime : null,
    harnessPgid: harness ? harness.pgrp : null,
    harnessAlive: harness ? live.some((info) => info.pid === harness.pid) : false,
    groupAlive: live.length > 0,
    groupMembers: live.length,
    childAlive: alive,
    supervisorAlive: true,
  });
}

function stopTimers() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (discoveryTimer) clearInterval(discoveryTimer);
  if (discoveryTimeout) clearTimeout(discoveryTimeout);
  if (watchTimer) clearInterval(watchTimer);
  heartbeatTimer = null;
  discoveryTimer = null;
  discoveryTimeout = null;
  watchTimer = null;
}

function exitStatus() {
  if (typeof shellStatus === 'number') return shellStatus;
  if (shellSignal) return 128;
  return 1;
}

function reasonFor() {
  if (cancel) return lastSignal === 'SIGINT' ? 'cancel-confirmed' : 'supervisor-signal';
  if (lastSignal === 'SIGHUP' || lastSignal === 'SIGTERM') return 'supervisor-signal';
  if (shellSignal) return 'signalled';
  return 'exited';
}

function writeReceipt(reason) {
  if (ended) return;
  const live = harness ? groupMembers(harness.pgrp, { liveOnly: true }) : [];
  if (!harness || live.length > 0) {
    writeNoReceipt(harness ? 'group-not-empty' : 'harness-not-discovered', live);
    return;
  }
  ended = true;
  stopTimers();
  const endedAt = new Date().toISOString();
  const zombies = groupMembers(harness.pgrp).filter((info) => info.state === 'Z');
  writeJson(path.join(runDir, 'exit.json'), {
    schemaVersion: 1,
    runId: options.runId,
    mode: 'visible',
    reason,
    supervisorSignal: lastSignal,
    supervisorPid,
    supervisorPidStart,
    supervisorPgid,
    childPid,
    childPidStart,
    harnessPid: harness.pid,
    harnessPidStart: harness.starttime,
    harnessPgid: harness.pgrp,
    harnessIsGroupLeader: harness.pid === harness.pgrp,
    harnessPgidSharedWithSupervisor: harness.pgrp === supervisorPgid,
    shellStatus,
    shellSignal,
    shellExitObserved: shellExited,
    harnessExitCode,
    harnessSignal,
    harnessExitSource,
    startedAt,
    endedAt,
    durationMs: Date.now() - startedMs,
    group: {
      pgid: harness.pgrp,
      empty: true,
      checkedAt: endedAt,
      members: [],
      zombies: zombies.map(memberJson),
      excluded: harness.pgrp === supervisorPgid ? [supervisorPid] : [],
    },
    cancel: cancel
      ? {
          signal: cancel.signal,
          startedAt: cancel.startedAt,
          steps: cancel.steps,
          groupAlreadyEmpty: cancel.steps.length === 0,
          groupEmptyAt: endedAt,
        }
      : null,
  });
  heartbeat(false);
  log(
    `exit reason=${reason} shellStatus=${shellStatus} shellSignal=${shellSignal} ` +
      `harnessExitCode=${harnessExitCode} harnessSignal=${harnessSignal} group=${harness.pgrp} empty=true`
  );
  process.exit(exitStatus());
}

function writeNoReceipt(reason, members = []) {
  if (ended) return;
  ended = true;
  stopTimers();
  const at = new Date().toISOString();
  writeJson(path.join(runDir, 'no-receipt.json'), {
    schemaVersion: 1,
    runId: options.runId,
    mode: 'visible',
    reason,
    at,
    supervisorSignal: lastSignal,
    supervisorPid,
    supervisorPidStart,
    supervisorPgid,
    childPid,
    childPidStart,
    harnessPid: harness ? harness.pid : null,
    harnessPidStart: harness ? harness.starttime : null,
    harnessPgid: harness ? harness.pgrp : null,
    shellStatus,
    shellSignal,
    shellExitObserved: shellExited,
    harnessExitCode,
    harnessSignal,
    harnessExitSource,
    group: harness
      ? {
          pgid: harness.pgrp,
          empty: false,
          checkedAt: at,
          members: members.map(memberJson),
          excluded: harness.pgrp === supervisorPgid ? [supervisorPid] : [],
        }
      : null,
    cancel: cancel ? { signal: cancel.signal, startedAt: cancel.startedAt, steps: cancel.steps } : null,
    note: 'no exit receipt: the verified harness process group could not be shown empty',
  });
  heartbeat(false);
  log(
    `no receipt reason=${reason} members=${members.map((info) => `${info.pid}:${info.comm}:${info.state}`).join(',')}`
  );
  process.exit(1);
}

function writeSpawnFailed() {
  if (ended) return;
  ended = true;
  stopTimers();
  const endedAt = new Date().toISOString();
  writeJson(path.join(runDir, 'exit.json'), {
    schemaVersion: 1,
    runId: options.runId,
    mode: 'visible',
    reason: 'spawn-failed',
    supervisorSignal: lastSignal,
    supervisorPid,
    supervisorPidStart,
    supervisorPgid,
    childPid: null,
    childPidStart: null,
    harnessPid: null,
    harnessPidStart: null,
    harnessPgid: null,
    harnessIsGroupLeader: null,
    harnessPgidSharedWithSupervisor: null,
    shellStatus: null,
    shellSignal: null,
    harnessExitCode: null,
    harnessSignal: null,
    harnessExitSource: null,
    startedAt,
    endedAt,
    durationMs: Date.now() - startedMs,
    group: null,
    cancel: null,
    note: 'no child was spawned; this is a failure observation, not contract evidence N',
  });
  heartbeat(false);
  log('exit reason=spawn-failed code=null signal=null');
  process.exit(1);
}

function pickCandidate(table, childInfo) {
  // argv mode spawns the harness directly: the child is the harness by
  // construction, even when it forks its own children into the same group.
  if (options.argv.length > 0) return { candidate: childInfo, strong: true };
  const descendants = descendantsOf(childPid, table).filter((info) => info.state !== 'Z');
  if (childInfo.ttyNr > 0 && childInfo.tpgid > 0) {
    // 1. The shell handed the terminal to a new job group: its leader is the
    //    harness (the normal non-exec case).
    const leaders = descendants.filter(
      (info) => info.pid === info.pgrp && info.pgrp === childInfo.tpgid && info.pgrp !== childInfo.pgrp
    );
    if (leaders.length) return { candidate: shallowest(leaders), strong: true };
    // 2. A non-shell descendant in the foreground group: the exec/function form
    //    keeps the harness in the shell's (or supervisor's) group.
    const nonShell = descendants.filter((info) => info.pgrp === childInfo.tpgid && !SHELL_NAMES.has(info.comm));
    if (nonShell.length) return { candidate: shallowest(nonShell), strong: false };
    // 3. The child itself became the harness (exec of an external command).
    if (childInfo.pgrp === childInfo.tpgid && !SHELL_NAMES.has(childInfo.comm)) {
      return { candidate: childInfo, strong: true };
    }
    // 4. Fallback for the exec/function form when the shell did not hand the
    //    terminal to the job: a stable non-shell direct child of the shell.
    const direct = descendants.filter((info) => info.depth === 1 && !SHELL_NAMES.has(info.comm));
    if (direct.length) return { candidate: shallowest(direct), strong: false };
    return null;
  }
  // No controlling terminal: no job-control group; fall back to the tree.
  const nonShell = descendants.filter((info) => !SHELL_NAMES.has(info.comm));
  if (nonShell.length) return { candidate: shallowest(nonShell), strong: false };
  if (!SHELL_NAMES.has(childInfo.comm)) return { candidate: childInfo, strong: true };
  return null;
}

function discover() {
  if (ended || harness || !childPid) return;
  const table = listProcs();
  const childInfo = table.get(childPid);
  if (!childInfo) return;
  const picked = pickCandidate(table, childInfo);
  if (!picked) {
    pendingKey = null;
    return;
  }
  const key = `${picked.candidate.pid}:${picked.candidate.starttime}`;
  if (!picked.strong) {
    if (pendingKey !== key) {
      pendingKey = key;
      pendingSince = Date.now();
      return;
    }
    if (Date.now() - pendingSince < STABLE_MS) return;
  }
  const candidate = picked.candidate;
  const leader = table.get(candidate.pgrp);
  harness = {
    ...candidate,
    pgidLeaderStart: leader ? leader.starttime : candidate.starttime,
    discoveredAt: new Date().toISOString(),
  };
  if (discoveryTimer) clearInterval(discoveryTimer);
  if (discoveryTimeout) clearTimeout(discoveryTimeout);
  discoveryTimer = null;
  discoveryTimeout = null;
  writeMeta();
  log(
    `harness discovered pid=${harness.pid} start=${harness.starttime} pgid=${harness.pgrp} ` +
      `tpgid=${harness.tpgid} comm=${harness.comm} sharedWithSupervisor=${harness.pgrp === supervisorPgid}`
  );
  startWatch();
}

function startWatch() {
  if (watchTimer) return;
  watchTimer = setInterval(() => {
    if (ended || !harness) return;
    const live = groupMembers(harness.pgrp, { liveOnly: true });
    if (live.length === 0) {
      if (!groupEmptySince) groupEmptySince = Date.now();
      if (shellExited || Date.now() - groupEmptySince >= SHELL_STATUS_WAIT_MS) {
        writeReceipt(reasonFor());
      }
      return;
    }
    groupEmptySince = null;
    if (shellExited && shellExitedAt && Date.now() - shellExitedAt >= GROUP_DRAIN_WAIT_MS) {
      writeNoReceipt('group-not-empty', live);
    }
  }, WATCH_INTERVAL_MS);
}

function signalTarget() {
  if (!harness) return { ok: false, reason: 'harness-not-discovered' };
  const table = listProcs();
  const leader = table.get(harness.pgrp);
  if (leader && leader.starttime !== harness.pgidLeaderStart) {
    // The pgid number now belongs to a different process group instance.
    return { ok: false, reason: 'pgid-reused' };
  }
  const live = groupMembers(harness.pgrp, { liveOnly: true });
  if (live.length === 0) return { ok: false, reason: 'group-empty' };
  const info = table.get(harness.pid);
  const verified = Boolean(info && info.starttime === harness.starttime);
  if (harness.pgrp === supervisorPgid) {
    // Sending to the group would signal the supervisor itself.
    if (!verified) return { ok: false, reason: 'leader-gone-shared-group' };
    return { ok: true, kind: 'pid', pid: harness.pid, verified: true, leaderGone: false };
  }
  return { ok: true, kind: 'group', pgid: harness.pgrp, verified, leaderGone: !verified };
}

function sendSignal(signal, target) {
  try {
    if (target.kind === 'group') process.kill(-target.pgid, signal);
    else process.kill(target.pid, signal);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error.code || String(error.message || error) };
  }
}

function waitForEmpty(ms) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (ended || !harness || groupMembers(harness.pgrp, { liveOnly: true }).length === 0) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - started >= ms) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
  });
}

function waitForShellExit(ms) {
  return new Promise((resolve) => {
    if (shellExited) {
      resolve(true);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      if (shellExited || ended) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - started >= ms) {
        clearInterval(timer);
        resolve(false);
      }
    }, 50);
  });
}

async function runCancel(signal) {
  if (cancel || ended) return;
  cancel = { signal, startedAt: new Date().toISOString(), steps: [] };
  recordSignal(signal);
  const steps = [
    { signal: 'SIGINT', waitMs: options.graceMs },
    { signal: 'SIGTERM', waitMs: options.termGraceMs },
    { signal: 'SIGKILL', waitMs: options.killWaitMs },
  ];
  for (const step of steps) {
    if (ended) return;
    if (harness && groupMembers(harness.pgrp, { liveOnly: true }).length === 0) break;
    const target = signalTarget();
    if (!target.ok) {
      cancel.steps.push({ at: new Date().toISOString(), step: step.signal, sent: false, reason: target.reason });
      break;
    }
    const result = sendSignal(step.signal, target);
    cancel.steps.push({
      at: new Date().toISOString(),
      step: step.signal,
      sent: result.ok,
      target: target.kind,
      harnessVerified: target.verified,
      leaderGone: target.leaderGone,
      error: result.error,
    });
    if (!result.ok) break;
    await waitForEmpty(step.waitMs);
  }
  if (ended) return;
  const live = harness ? groupMembers(harness.pgrp, { liveOnly: true }) : [];
  if (live.length === 0) {
    // The group is empty; give the intermediate shell a bounded moment to
    // report its own status so shellStatus/shellSignal are not needlessly null.
    await waitForShellExit(SHELL_STATUS_WAIT_MS);
    writeReceipt(reasonFor());
  } else {
    writeNoReceipt('group-not-empty', live);
  }
}

function recordSignal(name) {
  lastSignal = name;
  appendLine(path.join(runDir, 'signals.jsonl'), {
    at: new Date().toISOString(),
    signal: name,
    childPid,
    harnessPid: harness ? harness.pid : null,
    harnessPgid: harness ? harness.pgrp : null,
  });
  log(`signal ${name}`);
}

writeMeta();

try {
  child = spawn(command.file, command.args, {
    stdio: 'inherit',
    env: process.env,
    cwd: process.cwd(),
  });
} catch (error) {
  log(`spawn failed: ${error instanceof Error ? error.message : String(error)}`);
  writeSpawnFailed();
}

childPid = child.pid || null;
childPidStart = childPid ? (readStat(childPid) || {}).starttime || null : null;
// A successful spawn always has a pid; without one the 'error' event below is
// the only outcome, so do not claim a child started.
if (childPid) log(`child started pid=${childPid} file=${command.file}`);
heartbeat(true);
heartbeatTimer = setInterval(
  () => heartbeat(child ? child.exitCode === null && child.signalCode === null : false),
  1000
);
if (childPid) {
  discoveryTimer = setInterval(discover, DISCOVERY_INTERVAL_MS);
  discoveryTimeout = setTimeout(() => {
    if (!harness && !ended) log(`harness not discovered within ${DISCOVERY_TIMEOUT_MS} ms`);
  }, DISCOVERY_TIMEOUT_MS);
}

child.on('error', (error) => {
  log(`child error: ${error.message}`);
  if (childPid) {
    // A running child's error (for example a failed signal delivery) is not a
    // spawn failure; the 'exit' event still finalises this run.
    return;
  }
  // Asynchronous spawn failure (for example an unavailable $SHELL or argv[0]):
  // no 'exit' event follows, so finalise here through the same guarded path.
  // The record has no child pid and is an honest failure observation, not
  // contract evidence N.
  writeSpawnFailed();
});

child.on('exit', (code, signal) => {
  shellExited = true;
  shellExitedAt = Date.now();
  shellStatus = typeof code === 'number' ? code : null;
  shellSignal = signal || null;
  if (harness && harness.pid === childPid) {
    // argv mode, or a shell that exec'd the harness in place: the supervisor is
    // the direct parent and observes the native code/signal.
    harnessExitCode = shellStatus;
    harnessSignal = shellSignal;
    harnessExitSource = 'wait';
  }
  log(`child exit code=${code} signal=${signal}`);
  if (!harness) {
    writeNoReceipt('harness-not-discovered');
    return;
  }
  const live = groupMembers(harness.pgrp, { liveOnly: true });
  if (live.length === 0) writeReceipt(reasonFor());
  else log(`shell exited but group ${harness.pgrp} still has ${live.length} member(s); waiting for drain`);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (ended) return;
    if (cancel) {
      // A second signal must not restart the grace clock.
      recordSignal(signal);
      return;
    }
    runCancel(signal).catch((error) => {
      log(`cancel error: ${error instanceof Error ? error.message : String(error)}`);
      writeNoReceipt('cancel-error', harness ? groupMembers(harness.pgrp, { liveOnly: true }) : []);
    });
  });
}

process.on('SIGWINCH', () => {
  // The child is in the pane's foreground group and receives SIGWINCH directly.
});
