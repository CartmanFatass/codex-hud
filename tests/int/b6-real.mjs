// Owned real SQLite/hud-run fixture. All process IDs are captured before cleanup.
import { fixture, until } from './fixture.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RUN_NODE_FLAGS } from '../../dist-test/src/core/run/runtime.js';
import { launchDigest } from '../../dist-test/src/core/run/control.js';
import { processState, readProcess } from '../../dist-test/src/core/run/process.js';
import { ReadControlService } from '../../dist-test/packages/hud-mcp/src/read-control.js';
import { acceptIntent } from '../../dist-test/src/ledger/intents.js';
import { seedCaller, intent } from '../ledger/fixtures.mjs';
export { until };
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
export async function realRun(script = 'setTimeout(()=>{},60000)') {
  const f = await fixture([process.execPath, '-e', script]);
  const child = spawn(process.execPath, [...RUN_NODE_FLAGS, 'bin/hud-run', 'start'], {
    cwd: resolve('.'),
    env: { ...process.env, HUD_HOME: f.home, HUD_RUN_PORT_MODULE: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  child.stdout.resume();
  const done = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, stderr })));
  child.stdin.end(JSON.stringify({ input: f.input, ticket: f.ticket }));
  f.processes.push({ child, done });
  const service = new ReadControlService(f.ledger, f.home);
  const authority = f.prepared.authority;
  return {
    ...f,
    child,
    done,
    service,
    authority,
    ready: () =>
      until(async () => {
        const s = await f.port.read(f.input.runId);
        if (child.exitCode !== null) throw new Error('hud-run startup failed: ' + stderr);
        return s.run.state === 'running' && s.meta?.scope && s;
      }),
    cleanup: async () => {
      service.close();
      await f.cleanup();
    },
  };
}
export async function visibleRun() {
  const f = await fixture([process.execPath, '-e', '']);
  const prepared = intent('visible');
  prepared.requestKey = 'visible-request';
  const at = Date.now();
  const input = {
    runId: prepared.run.runId,
    mode: 'visible',
    launch: { argv: [process.execPath, '-e', 'setTimeout(()=>{},60000)'] },
    cwd: f.home,
    sourceId: prepared.run.sourceId,
    profileDigest: 'a'.repeat(64),
    stdin: 'tty',
    orphanPolicy: 'continue',
  };
  const ticket = 'synthetic-visible-ticket';
  prepared.params.mode = 'visible';
  prepared.params.launchCwd = f.home;
  prepared.link.createdAt = at;
  prepared.run = {
    ...prepared.run,
    mode: 'visible',
    supervisionStrategy: 'wrapper',
    launchCwd: f.home,
    createdAt: at,
    launchDigest: launchDigest(input),
    launchTokenHash: createHash('sha256').update(ticket).digest('hex'),
  };
  prepared.claim.issuedAt = at;
  prepared.claim.expiresAt = at + 1800000;
  await acceptIntent(f.ledger, prepared);
  const socket = 'b6-' + process.pid + '-' + at;
  const env = { ...process.env, HUD_HOME: f.home, TMUX_TMPDIR: f.home, HOME: f.home, SHELL: '/bin/bash' };
  delete env.HUD_RUN_PORT_MODULE;
  delete env.TMUX;
  const tmux = (...args) => {
    const r = spawnSync('/usr/bin/tmux', ['-L', socket, ...args], { env, encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) throw new Error('private tmux: ' + r.stderr);
    return r.stdout.trim();
  };
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'b6', '/bin/bash --noprofile --norc');
  const infrastructure = tmux('display-message', '-p', '-t', 'b6:0.0', '#{pid}:#{pane_pid}')
    .split(':')
    .map(Number)
    .map((pid) => readProcess(pid)?.stamp)
    .filter(Boolean);
  const file = join(f.home, 'visible-launch.json');
  writeFileSync(file, JSON.stringify({ input, ticket, visible: { expectedExecutable: process.execPath }, env }), {
    mode: 0o600,
  });
  tmux(
    'send-keys',
    '-t',
    'b6:0.0',
    `${quote(process.execPath)} ${RUN_NODE_FLAGS.join(' ')} ${quote(resolve('bin/hud-run'))} start --launch-fd 3 3<${quote(file)} 2>${quote(join(f.home, 'errors'))}`,
    'Enter'
  );
  let meta;
  const service = new ReadControlService(f.ledger, f.home);
  return {
    ...f,
    input,
    service,
    authority: prepared.authority,
    ready: () =>
      until(async () => {
        const s = await f.port.read(input.runId);
        meta = s.meta;
        return s.run.state === 'running' && meta?.scope && s;
      }, 20000),
    cleanup: async () => {
      meta ??= (await f.port.read(input.runId)).meta;
      for (const stamp of [meta?.harness, meta?.command_leader, meta?.supervisor])
        if (stamp && processState(stamp) === 'alive') {
          try {
            process.kill(stamp.pid, 'SIGKILL');
          } catch {}
        }
      try {
        tmux('kill-server');
      } catch {}
      await until(() =>
        [...infrastructure, meta?.harness, meta?.command_leader, meta?.supervisor]
          .filter(Boolean)
          .every((s) => processState(s) !== 'alive')
      );
      service.close();
      await f.cleanup();
    },
  };
}
