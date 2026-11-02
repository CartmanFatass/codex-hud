// tests/run/idle.mjs adapted to a real SQLite store; no fake data port.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fixture, until } from './fixture.mjs';
import { RUN_NODE_FLAGS } from '../../dist/core/run/runtime.js';
import { ledgerRuntimeSupported } from '../../dist/ledger/runtime.js';
if (!ledgerRuntimeSupported()) {
  console.log('SKIP: real-ledger idle needs Node 22 >=22.13 or >=24');
  process.exit(0);
}
const count = Number(process.argv[2] ?? 1),
  duration = Number(process.argv[3] ?? 60000),
  runs = [];
function stat(pid) {
  const raw = readFileSync(`/proc/${pid}/stat`, 'utf8'),
    fields = raw
      .slice(raw.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
  const status = readFileSync(`/proc/${pid}/status`, 'utf8'),
    io = readFileSync(`/proc/${pid}/io`, 'utf8');
  return {
    ticks: Number(fields[11]) + Number(fields[12]),
    rssKiB: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0),
    writeBytes: Number(/^write_bytes:\s+(\d+)/m.exec(io)?.[1] ?? 0),
    wchar: Number(/^wchar:\s+(\d+)/m.exec(io)?.[1] ?? 0),
  };
}
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] ?? null;
try {
  for (let i = 0; i < count; i++) {
    const f = await fixture([process.execPath, '-e', `setTimeout(()=>{},${duration + 15000})`]);
    runs.push(f);
    const child = spawn(process.execPath, [...RUN_NODE_FLAGS, 'bin/hud-run', 'start'], {
      cwd: resolve('.'),
      env: { ...process.env, HUD_HOME: f.home, HUD_RUN_PORT_MODULE: resolve('tests/int/perf-port.mjs') },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (x) => (stderr += x));
    f.done = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal, stderr })));
    f.processes.push({ child, done: f.done });
    child.stdin.end(JSON.stringify({ input: f.input, ticket: f.ticket }));
    f.initial = await until(async () => {
      const s = await f.port.read(f.input.runId);
      return s.meta?.scope && s.run.state === 'running' ? s : null;
    });
    f.before = {
      supervisor: stat(child.pid),
      helper: stat(f.initial.meta.scope.group_leader.pid),
      heartbeat: f.initial.run.heartbeatSeq,
      events: f.initial.events.length,
    };
  }
  await sleep(duration);
  const results = [];
  for (const f of runs) {
    const s = await f.port.read(f.input.runId),
      sup = stat(s.run.supervisor.pid),
      helper = stat(s.meta.scope.group_leader.pid);
    const measurements = {
      supervisor: {
        ticks: sup.ticks - f.before.supervisor.ticks,
        rssKiB: sup.rssKiB,
        writeBytes: sup.writeBytes - f.before.supervisor.writeBytes,
        wchar: sup.wchar - f.before.supervisor.wchar,
      },
      helper: { ticks: helper.ticks - f.before.helper.ticks, rssKiB: helper.rssKiB },
      heartbeatUpdates: s.run.heartbeatSeq - f.before.heartbeat,
      extraEvents: s.events.length - f.before.events,
    };
    await f.port.acceptCancel(
      f.input.runId,
      { kind: 'trusted_local', uid: process.getuid(), invocationId: 'synthetic-idle-cleanup' },
      0
    );
    const done = await f.done;
    if (done.code !== 0) throw new Error(JSON.stringify(done));
    const samples = JSON.parse(readFileSync(join(f.home, 'heartbeat-times.json'), 'utf8'));
    results.push({
      ...measurements,
      heartbeatMs: {
        samples: samples.length,
        p50: quantile(samples, 0.5),
        p95: quantile(samples, 0.95),
        max: Math.max(...samples),
      },
      rawHeartbeatMs: samples,
    });
  }
  console.log(
    JSON.stringify(
      { runs: count, durationMs: duration, node: process.versions.node, clockTicksPerSecond: 100, results },
      null,
      2
    )
  );
} finally {
  for (const f of runs) await f.cleanup();
}
