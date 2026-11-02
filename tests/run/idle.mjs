import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { seedRun } from '../../dist-test/tests/run/fixtures.js';
import { RUN_NODE_FLAGS } from '../../dist/core/run/runtime.js';
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || major === 23 || (major === 22 && minor < 13)) {
  console.log('SKIP: idle CLI measurement requires Node 22 >=22.13 or >=24');
  process.exit(0);
}
const count = Number(process.argv[2] ?? 1),
  duration = Number(process.argv[3] ?? 60000),
  runs = [];
function stat(pid) {
  const parts = readFileSync(`/proc/${pid}/stat`, 'utf8')
    .slice(readFileSync(`/proc/${pid}/stat`, 'utf8').lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  let pssKiB = null;
  try {
    pssKiB = Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))?.[1] ?? 0);
  } catch {}

  const io = readFileSync(`/proc/${pid}/io`, 'utf8');
  return {
    start: parts[19],
    ticks: Number(parts[11]) + Number(parts[12]),
    userTicks: Number(parts[11]),
    systemTicks: Number(parts[12]),
    peakRssKiB: Number(/^VmHWM:\s+(\d+)/m.exec(status)?.[1] ?? 0),
    pssKiB,
    rssKiB: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0),
    writeBytes: Number(/^write_bytes:\s+(\d+)/m.exec(io)?.[1] ?? 0),
    wchar: Number(/^wchar:\s+(\d+)/m.exec(io)?.[1] ?? 0),
  };
}
try {
  for (let i = 0; i < count; i++) {
    const home = mkdtempSync(join(tmpdir(), 'hud-idle-')),
      data = seedRun(home, [process.execPath, '-e', `setTimeout(()=>process.exit(0),${duration + 15000})`]);
    writeFileSync(join(home, 'facts.json'), JSON.stringify(data.seed), { mode: 0o600 });
    const launchAt = performance.now();
    const child = spawn(process.execPath, [...RUN_NODE_FLAGS, 'bin/hud-run', 'start'], {
      cwd: resolve('.'),
      env: { ...process.env, HUD_HOME: home, HUD_RUN_PORT_MODULE: resolve('tests/run/file-port.mjs') },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (x) => (err += x));
    const done = new Promise((r) => child.once('exit', r));
    child.stdin.end(JSON.stringify({ input: data.input, ticket: data.ticket }));
    const run = { home, data, child, done, err: () => err };
    runs.push(run);
    for (let n = 0; n < 400; n++) {
      run.snapshot = JSON.parse(readFileSync(join(home, 'facts.json'), 'utf8')).snapshot;
      if (run.snapshot.meta?.scope && run.snapshot.run.state === 'running') break;
      await sleep(20);
    }
    if (!run.snapshot.meta?.scope) throw new Error(`no scope ${err}`);
    run.startedMs = performance.now() - launchAt;
  }
  for (const r of runs) r.snapshot = JSON.parse(readFileSync(join(r.home, 'facts.json'), 'utf8')).snapshot;
  const before = runs.map((r) => ({
    supervisor: stat(r.child.pid),
    helper: stat(r.snapshot.meta.scope.group_leader.pid),
    shells: readFileSync(
      `/proc/${r.snapshot.meta.scope.group_leader.pid}/task/${r.snapshot.meta.scope.group_leader.pid}/children`,
      'utf8'
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((pid) => pid !== r.snapshot.meta.command_leader.pid)
      .map((pid) => ({
        pid,
        role:
          Number(
            readFileSync(`/proc/${r.snapshot.meta.command_leader.pid}/stat`, 'utf8').split(') ').at(-1).split(/\s+/)[1]
          ) === pid
            ? 'waiter'
            : 'forwarder',
        stat: stat(pid),
      })),
    heartbeat: r.snapshot.run.heartbeatSeq,
    events: r.snapshot.events.length,
  }));
  await sleep(duration);
  const result = runs.map((r, i) => {
    const s = JSON.parse(readFileSync(join(r.home, 'facts.json'), 'utf8')).snapshot;
    const sup = stat(r.child.pid),
      helper = stat(r.snapshot.meta.scope.group_leader.pid);
    const shells = before[i].shells.map(({ pid, role, stat: previous }) => {
      const current = stat(pid);
      if (current.start !== previous.start) throw new Error('owned auxiliary shell changed instance');
      return {
        ...current,
        role,
        userTicks: current.userTicks - previous.userTicks,
        systemTicks: current.systemTicks - previous.systemTicks,
        ticks: current.ticks - previous.ticks,
        writeBytes: current.writeBytes - previous.writeBytes,
        wchar: current.wchar - previous.wchar,
      };
    });
    const shellTotal = { count: shells.length, processes: shells };
    for (const key of ['rssKiB', 'peakRssKiB', 'pssKiB', 'userTicks', 'systemTicks', 'ticks'])
      shellTotal[key] = shells.some((s) => s[key] === null) ? null : shells.reduce((sum, s) => sum + s[key], 0);
    return {
      supervisor: {
        ...sup,
        count: 1,
        userTicks: sup.userTicks - before[i].supervisor.userTicks,
        systemTicks: sup.systemTicks - before[i].supervisor.systemTicks,
        ticks: sup.ticks - before[i].supervisor.ticks,
        rssKiB: sup.rssKiB,
        writeBytes: sup.writeBytes - before[i].supervisor.writeBytes,
        wchar: sup.wchar - before[i].supervisor.wchar,
      },
      helper: {
        ...helper,
        count: 1,
        userTicks: helper.userTicks - before[i].helper.userTicks,
        systemTicks: helper.systemTicks - before[i].helper.systemTicks,
        ticks: helper.ticks - before[i].helper.ticks,
      },
      shell: shellTotal,
      startedMs: r.startedMs,
      heartbeatUpdates: s.run.heartbeatSeq - before[i].heartbeat,
      extraEvents: s.events.length - before[i].events,
    };
  });
  console.log(
    JSON.stringify(
      {
        runs: count,
        durationMs: duration,
        node: process.versions.node,
        backend: process.env.HUD_IDLE_LABEL ?? 'current',
        unit: 'KiB and Linux clock ticks (getconf CLK_TCK)',
        results: result,
      },
      null,
      2
    )
  );
} finally {
  for (const r of runs) {
    if (r.child.exitCode === null) {
      // owned workload only, request graceful scoped cancellation through CLI
      const cancel = spawn(process.execPath, ['bin/hud-run', 'cancel', r.data.input.runId, '--grace', '0'], {
        cwd: resolve('.'),
        env: { ...process.env, HUD_HOME: r.home, HUD_RUN_PORT_MODULE: resolve('tests/run/file-port.mjs') },
        stdio: 'ignore',
      });
      await new Promise((done) => cancel.once('exit', done));
    }
    await r.done;
    rmSync(r.home, { recursive: true, force: true });
  }
}
