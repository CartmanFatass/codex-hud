import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { seedRun } from '../../dist-test/tests/run/fixtures.js';
import { launchDigest, HeadlessRunControl } from '../../dist/core/run/control.js';
import { FileRunFactPort } from '../../dist/core/run/fake-port.js';
import { readProcess, processState } from '../../dist/core/run/process.js';
import { signalVisibleScope } from '../../dist/core/run/visible-process.js';
const repo = resolve('.');
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
async function until(fn, timeout = 18000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    let value;
    try {
      value = await fn();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (value) return value;
    await sleep(40);
  }
  throw new Error('visible terminal event deadline');
}
async function manager(action) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (error.message !== 'fake_port_busy' || attempt >= 20) throw error;
      await sleep(40);
    }
  }
}
function json(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
function create(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hud-visible-test-'));
  const home = mkdtempSync(join(root, 'home-'));
  const socket = `visible-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HERDR_') && k !== 'TMUX'));
  Object.assign(env, {
    TMUX_TMPDIR: root,
    HOME: home,
    SHELL: options.shellPath ?? '/bin/bash',
    HUD_HOME: home,
    HUD_RUN_PORT_MODULE: resolve(options.supervisorPort ?? 'tests/run/file-port.mjs'),
  });
  const tmux = (...args) => {
    const result = spawnSync('/usr/bin/tmux', ['-L', socket, ...args], { env, encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0) throw new Error(`private tmux ${args[0]}: ${result.stderr}`);
    return result.stdout.trim();
  };
  tmux(
    '-f',
    '/dev/null',
    'new-session',
    '-d',
    '-s',
    'visible',
    '-x',
    '100',
    '-y',
    '28',
    '/bin/bash --noprofile --norc'
  );
  const infrastructure = tmux('display-message', '-p', '-t', 'visible:0.0', '#{pid}:#{pane_pid}')
    .split(':')
    .map(Number)
    .map((pid) => readProcess(pid)?.stamp)
    .filter(Boolean);
  const audit = (record) => {
    if (process.env.HUD_VISIBLE_AUDIT) appendFileSync(process.env.HUD_VISIBLE_AUDIT, `${JSON.stringify(record)}\n`);
  };
  audit({ event: 'created', root, socket, infrastructure });
  const data = seedRun(home, [], {
    mode: 'visible',
    stdin: 'tty',
    launch: { shell: 'context_harness; exit $?', shellPath: options.shellPath ?? '/bin/bash' },
  });
  data.seed.snapshot.run.supervisionStrategy = 'wrapper';
  const harnessEnv = {
    ...env,
    HERDR_ENV: '1',
    HERDR_WORKSPACE_ID: 'synthetic-workspace',
    HERDR_TAB_ID: 'synthetic-tab',
    HERDR_PANE_ID: 'synthetic-pane',
    ...options.harnessEnv,
  };
  writeFileSync(
    join(home, '.bashrc'),
    `context_harness() { export SYNTHETIC_CONTEXT=function-preserved; ${quote(process.execPath)} ${quote(resolve('tests/run/visible-harness.mjs'))}; }\n`,
    { mode: 0o600 }
  );
  writeFileSync(join(home, '.zshrc'), readFileSync(join(home, '.bashrc')), { mode: 0o600 });
  if (options.argv) data.input.launch = { argv: options.argv };
  const payload = {
    input: data.input,
    ticket: data.ticket,
    env: harnessEnv,
    managedShellVerified: true,
    visible: { expectedExecutable: realpathSync(process.execPath) },
    ...options.payload,
  };
  if (options.shortShell) payload.input.launch.shell = 'true';
  data.seed.snapshot.run.launchDigest = launchDigest(payload.input);
  writeFileSync(join(home, 'facts.json'), JSON.stringify(data.seed), { mode: 0o600 });
  writeFileSync(join(home, 'launch.json'), JSON.stringify(payload), { mode: 0o600 });
  const command = `${options.realLedger && !options.supervisorPort ? '/usr/bin/env -u HUD_RUN_PORT_MODULE ' : ''}${quote(process.execPath)} ${quote(join(repo, 'bin/hud-run'))} start ${options.omitFd ? '' : `--launch-fd 3 3<${quote(join(home, 'launch.json'))}`}  2>${quote(join(home, 'errors'))}`;
  const launch = () =>
    tmux(
      'send-keys',
      '-t',
      'visible:0.0',
      options.background === 'foreground-wrapper'
        ? `/bin/sh -c ${quote(`printf '%s' "$$" > ${quote(join(home, 'launcher.pid'))}; ${command} < /dev/tty; :`)}`
        : options.background === 'job-control-tty'
          ? `/bin/bash --noprofile --norc -mc ${quote(`${command} < /dev/tty & /bin/sleep 2 & sleeper=$!; printf '%s' "$sleeper" > ${quote(join(home, 'sleeper.pid'))}; wait "$sleeper"`)}`
          : options.background === 'surviving-tty'
            ? `/bin/sh -c ${quote(`printf '%s' "$$" > ${quote(join(home, 'launcher.pid'))}; ${command} < /dev/tty & /bin/sleep 2 & sleeper=$!; printf '%s' "$sleeper" > ${quote(join(home, 'sleeper.pid'))}; wait "$sleeper"`)}`
            : options.background === 'sh'
              ? `/bin/sh -c ${quote(`${command} &`)}`
              : options.background
                ? `${command} &`
                : command,
      'Enter'
    );
  const snapshot = () => json(join(home, 'facts.json'))?.snapshot;
  const input = (text) => tmux('send-keys', '-t', 'visible:0.0', text, 'Enter');
  const owned = new Map();
  const remember = () => {
    for (const pid of [
      snapshot()?.run.supervisor?.pid,
      snapshot()?.meta?.command_leader?.pid,
      json(join(home, 'harness.json'))?.pid,
      json(join(home, 'harness.json'))?.parent,
      Number(json(join(home, 'launcher.pid'))),
      Number(json(join(home, 'sleeper.pid'))),
      json(join(home, 'member.json'))?.pid,
    ]) {
      if (pid && !owned.has(pid)) {
        const stamp = readProcess(pid)?.stamp;
        if (stamp) owned.set(pid, stamp);
      }
    }
  };
  const control = () =>
    new HeadlessRunControl(new FileRunFactPort(join(home, 'facts.json')), home, {
      kind: 'trusted_local',
      uid: process.getuid(),
      invocationId: 'synthetic-visible-manager',
    });
  return {
    root,
    home,
    socket,
    env,
    data,
    payload,
    tmux,
    launch,
    snapshot,
    input,
    remember,
    track: (stamps) => {
      for (const stamp of stamps) if (stamp) owned.set(stamp.pid, stamp);
    },
    control,
    ready: async () => {
      await until(() => snapshot()?.meta?.scope);
      await until(() => snapshot().run.state === 'running');
      remember();
      return snapshot().meta;
    },
    ended: async () => {
      await until(() => snapshot()?.run.state === 'ended' || snapshot()?.run.state === 'cancelled');
      return await until(() => json(join(home, 'runs', data.input.runId, 'exit.json')));
    },
    cleanup: async () => {
      remember();
      for (const stamp of owned.values())
        if (processState(stamp) === 'alive') {
          try {
            process.kill(stamp.pid, 'SIGKILL');
          } catch {}
        }
      try {
        tmux('kill-server');
      } catch {}
      await sleep(100);
      const probe = spawnSync('/usr/bin/tmux', ['-L', socket, 'list-sessions'], { env, encoding: 'utf8' });
      assert.notEqual(probe.status, 0, 'private server survived cleanup');
      for (const stamp of [...owned.values(), ...infrastructure])
        await until(() => {
          const current = readProcess(stamp.pid);
          return !current || current.stamp.proc_start !== stamp.proc_start;
        }, 5000);
      rmSync(root, { recursive: true, force: true });
      audit({ event: 'cleaned', root, socket, processes: [...owned.values(), ...infrastructure] });
      assert.equal(existsSync(root), false);
    },
  };
}

for (const ending of ['normal', 'exit137', 'kill9', 'ctrl-c'])
  test(`visible foreground -ic function / ${ending}: R scope and separate shell status`, async () => {
    const s = create();
    try {
      s.launch();
      const meta = await s.ready();
      const harness = json(join(s.home, 'harness.json'));
      const record = readProcess(meta.harness.pid);
      assert.equal(harness.tty, true);
      assert.equal(harness.context, 'function-preserved');
      assert.equal(harness.env.HERDR_PANE_ID, 'synthetic-pane');
      assert.equal(record.foregroundPgid, meta.scope.pgid);
      assert.notEqual(meta.harness.pid, meta.command_leader.pid);
      assert.notEqual(meta.scope.pgid, readProcess(meta.supervisor.pid).pgid);
      if (ending === 'kill9') process.kill(meta.harness.pid, 'SIGKILL');
      else if (ending === 'ctrl-c') s.tmux('send-keys', '-t', 'visible:0.0', 'C-c');
      else s.input(ending === 'normal' ? 'quit' : 'exit137');
      const receipt = await s.ended();
      assert.equal(receipt.native_exit, null);
      assert.equal(receipt.reason, 'scope_ended');
      if (ending === 'ctrl-c') assert.ok([1, 130].includes(receipt.shell_exit.exit_code));
      else assert.equal(receipt.shell_exit.exit_code, { normal: 0, exit137: 137, kill9: 137 }[ending]);
      assert.equal(receipt.logs.capture, 'tty_passthrough');
      assert.equal(readFileSync(join(s.home, 'runs', s.data.input.runId, 'stdout.log')).length, 0);
      assert.equal(s.snapshot().slotHeld, false);
    } finally {
      await s.cleanup();
    }
  });

test('visible background form is refused before registration or dispatch', async () => {
  const s = create({ background: true });
  try {
    s.launch();
    await until(() => readFileSync(join(s.home, 'errors'), 'utf8').includes('unsupported_visible_background'));
    assert.equal(s.snapshot().events.length, 0);
    assert.equal(existsSync(join(s.home, 'harness.json')), false);
  } finally {
    await s.cleanup();
  }
});

test('visible short-lived undiscovered harness stays unknown and same-ticket restart dispatches zero copies', async () => {
  const s = create({ shortShell: true });
  try {
    s.launch();
    await until(() => s.snapshot()?.meta && s.snapshot().run.state === 'uncertain');
    assert.equal(s.snapshot().meta.scope, null);
    assert.equal(s.snapshot().slotHeld, true);
    s.launch();
    await until(() => readFileSync(join(s.home, 'errors'), 'utf8').includes('ticket_refused'));
    assert.equal(s.snapshot().events.filter((e) => e.kind === 'supervisor.registered').length, 1);
    assert.equal(s.snapshot().receipt, null);
  } finally {
    await s.cleanup();
  }
});

test('visible leader exit with live INT-ignoring member blocks R and unsafe cancellation', async () => {
  const s = create({ harnessEnv: { VISIBLE_MEMBER: '1' } });
  try {
    s.launch();
    const meta = await s.ready();
    const member = json(join(s.home, 'member.json')).pid;
    assert.equal(readProcess(member).pgid, meta.scope.pgid);
    s.input('quit');
    await until(() => processState(meta.command_leader) === 'dead' && processState(meta.supervisor) === 'dead');
    assert.equal(signalVisibleScope(meta.scope, 'SIGINT'), false);
    assert.notEqual(readProcess(member)?.state, 'Z');
    await manager(() => s.control().reconcile(s.data.input.runId));
    assert.equal(s.snapshot().slotHeld, true);
    assert.equal(s.snapshot().receipt, null);
    assert.equal(existsSync(join(s.home, 'runs', s.data.input.runId, 'exit.json')), false);
  } finally {
    await s.cleanup();
  }
});

test('visible cancellation without stable group delivery stays unconfirmed with INT-ignoring members alive', async () => {
  const s = await realFixture({ harnessEnv: { VISIBLE_MEMBER: '1', VISIBLE_IGNORE: '1' } });
  try {
    s.launch();
    const meta = await s.ready();
    const member = readProcess(json(join(s.home, 'member.json')).pid).stamp;
    await s.control().cancel(s.data.input.runId);
    await s.control().cancel(s.data.input.runId, 0);
    const snapshot = await until(async () => {
      const current = await s.port.read(s.data.input.runId);
      return current.events.some((e) => e.kind === 'cancel.unconfirmed') && current;
    });
    assert.deepEqual(
      snapshot.events
        .filter((e) => e.kind === 'cancel.step')
        .map((e) => ({ signal: e.payload.signal, ack: e.payload.ack })),
      [{ signal: 'SIGINT', ack: false }]
    );
    assert.equal(snapshot.events.filter((e) => e.kind === 'cancel.accepted').length, 1);
    assert.equal(snapshot.events.find((e) => e.kind === 'cancel.accepted').payload.graceMs, 10000);
    assert.equal(
      snapshot.events.find((e) => e.kind === 'cancel.unconfirmed').payload.reason,
      'visible_scope_control_unavailable'
    );
    assert.equal(snapshot.slotHeld, true);
    assert.equal(snapshot.receipt, null);
    assert.equal(processState(meta.harness), 'alive');
    assert.equal(processState(member), 'alive');
    assert.equal(existsSync(join(s.home, 'signals')), false);
    // Explicit test teardown of one owned member is not a supervisor fallback.
    process.kill(member.pid, 'SIGTERM');
    await until(() => !readProcess(member.pid));
    s.input('quit');
    const final = await s.ended();
    assert.equal(final.run.state, 'ended');
    assert.equal(final.status.terminalNote, 'cancel_timing_unknown');
    assert.equal(final.receipt.native_exit, null);
    assert.equal(final.events.filter((e) => e.kind === 'cancel.step').length, 1);
  } finally {
    await s.cleanup();
  }
});

for (const profile of [{ strategy: 'sidecar' }, { capture: 'pty' }, { dispatch: 'unknown' }])
  test(`visible ${JSON.stringify(profile)} is unsupported with zero dispatch`, async () => {
    const s = create({ payload: { visible: { expectedExecutable: process.execPath, ...profile } } });
    try {
      s.launch();
      await until(() => readFileSync(join(s.home, 'errors'), 'utf8').includes('unsupported_visible_profile'));
      assert.equal(s.snapshot().events.length, 0);
      assert.equal(existsSync(join(s.home, 'harness.json')), false);
    } finally {
      await s.cleanup();
    }
  });

test('visible supervisor SIGKILL holds slot without receipt; independent Q never dispatches or writes dead files', async () => {
  const s = create();
  try {
    s.launch();
    const meta = await s.ready();
    process.kill(meta.supervisor.pid, 'SIGKILL');
    await until(() => processState(meta.supervisor) === 'dead');
    await manager(() => s.control().reconcile(s.data.input.runId));
    assert.equal(s.snapshot().run.state, 'uncertain');
    assert.equal(s.snapshot().slotHeld, true);
    assert.deepEqual(s.snapshot().status.interaction, { focus: false, input: false, resume: false });
    const before = readFileSync(join(s.home, 'runs', s.data.input.runId, 'meta.json'), 'utf8');
    // Explicit test cleanup ends old processes; recovery itself sends no input or signal.
    for (const stamp of [meta.harness, meta.command_leader])
      if (processState(stamp) === 'alive') process.kill(stamp.pid, 'SIGKILL');
    await until(() => processState(meta.harness) === 'dead' && processState(meta.command_leader) === 'dead');
    await manager(() => s.control().reconcile(s.data.input.runId));
    assert.equal(s.snapshot().run.state, 'ended');
    assert.equal(s.snapshot().slotHeld, false);
    assert.equal(existsSync(join(s.home, 'runs', s.data.input.runId, 'exit.json')), false);
    assert.equal(readFileSync(join(s.home, 'runs', s.data.input.runId, 'meta.json'), 'utf8'), before);
    assert.equal(s.snapshot().events.filter((e) => e.kind === 'supervisor.registered').length, 1);
  } finally {
    await s.cleanup();
  }
});

test('visible sh -c background negative form has zero dispatch', async () => {
  const s = create({ background: 'sh' });
  try {
    s.launch();
    await until(() => readFileSync(join(s.home, 'errors'), 'utf8').includes('unsupported_visible_background'));
    assert.equal(s.snapshot().events.length, 0);
    assert.equal(existsSync(join(s.home, 'harness.json')), false);
  } finally {
    await s.cleanup();
  }
});

test('visible argv passes literal arguments through the interactive shell without interpretation', async () => {
  const args = ['a b', '; literal', '$(never-execute)', 'quote"and\'apostrophe', 'é'];
  const s = create({ argv: [process.execPath, resolve('tests/run/visible-harness.mjs'), ...args] });
  try {
    s.launch();
    await s.ready();
    assert.deepEqual(json(join(s.home, 'harness.json')).argv, args);
    assert.equal(json(join(s.home, 'harness.json')).cwd, s.home);
    s.input('quit');
    await s.ended();
  } finally {
    await s.cleanup();
  }
});

test('visible parent launcher disconnect continues foreground input and normal R wrap-up', async () => {
  const parent = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
  const done = new Promise((resolve) => parent.once('exit', resolve));
  const stamp = await until(() => readProcess(parent.pid)?.stamp);
  const s = create({ payload: { parent: { process: stamp, contextId: 'synthetic-parent', generation: 1 } } });
  try {
    s.launch();
    const meta = await s.ready();
    parent.kill('SIGTERM');
    await done;
    await until(() => s.snapshot().events.some((e) => e.kind === 'parent.offline'));
    assert.equal(s.snapshot().run.cancelRequestedAt, null);
    assert.equal(readProcess(meta.harness.pid).foregroundPgid, meta.scope.pgid);
    s.input('hello-after-parent-exit');
    await until(() => readFileSync(join(s.home, 'input.log'), 'utf8').includes('hello-after-parent-exit'));
    s.input('quit');
    const receipt = await s.ended();
    assert.equal(receipt.shell_exit.exit_code, 0);
    assert.equal(receipt.native_exit, null);
    assert.equal(s.snapshot().slotHeld, false);
  } finally {
    parent.kill('SIGKILL');
    await done;
    await s.cleanup();
  }
});

test('visible pane/session SIGHUP closes harness and writes only scope-proven R', async () => {
  const s = create();
  try {
    s.launch();
    const meta = await s.ready();
    s.tmux('kill-session', '-t', 'visible');
    await until(() => processState(meta.harness) === 'dead');
    const receipt = await s.ended();
    assert.equal(receipt.native_exit, null);
    assert.equal(receipt.scope_check.result, 'gone');
    assert.equal(receipt.reason, 'scope_ended');
    assert.equal(s.snapshot().slotHeld, false);
  } finally {
    await s.cleanup();
  }
});

async function realFixture(options = {}) {
  const { openLedger } = await import('../../dist/ledger/ledger.js');
  const { acceptIntent } = await import('../../dist/ledger/intents.js');
  const { createRunFactPort } = await import('../../dist/core/run/ledger-port.js');
  const { PrivateLedgerGate } = await import('../../dist/ledger/local-manager.js');
  const { seedCaller, intent } = await import('../ledger/fixtures.mjs');
  const { createHash } = await import('node:crypto');
  const s = create({ ...options, realLedger: true });
  const ledger = await openLedger(join(s.home, 'ledger.sqlite'));
  await seedCaller(ledger);
  const prepared = intent(s.data.input.runId);
  const now = Date.now();
  s.data.input.runId = prepared.run.runId;
  s.data.input.sourceId = prepared.run.sourceId;
  prepared.params.mode = 'visible';
  prepared.params.launchCwd = s.home;
  prepared.link.createdAt = now;
  prepared.run = {
    ...prepared.run,
    mode: 'visible',
    supervisionStrategy: 'wrapper',
    launchCwd: s.home,
    createdAt: now,
    launchDigest: launchDigest(s.data.input),
    launchTokenHash: createHash('sha256').update(s.data.ticket).digest('hex'),
  };
  prepared.claim.issuedAt = now;
  prepared.claim.expiresAt = now + 1800000;
  await acceptIntent(ledger, prepared).catch(async (error) => {
    await ledger.close();
    await s.cleanup();
    throw error;
  });
  writeFileSync(join(s.home, 'launch.json'), JSON.stringify(s.payload), { mode: 0o600 });
  const port = await createRunFactPort(s.home);
  const control = new HeadlessRunControl(port, s.home, new PrivateLedgerGate(s.home).actor());
  let meta;
  return {
    ...s,
    port,
    ledger,
    control: () => control,
    ready: async () => {
      meta = await until(async () => {
        const snapshot = await port.read(s.data.input.runId);
        return snapshot.run.state === 'running' && snapshot.meta;
      });
      s.track([meta.supervisor, meta.command_leader, meta.harness]);
      s.remember();
      return meta;
    },
    ended: async () =>
      await until(async () => {
        const snapshot = await port.read(s.data.input.runId);
        return (snapshot.run.state === 'ended' || snapshot.run.state === 'cancelled') && snapshot;
      }),
    cleanup: async () => {
      meta ??= (await port.read(s.data.input.runId)).meta;
      for (const stamp of [meta?.harness, meta?.command_leader, meta?.supervisor])
        if (stamp && processState(stamp) === 'alive') process.kill(stamp.pid, 'SIGKILL');
      await port.close();
      await ledger.close();
      await s.cleanup();
    },
  };
}

test('visible real SQLite CLI commits R and releases slot with native unknown and shell wait', async () => {
  const s = await realFixture();
  try {
    s.launch();
    const meta = await s.ready();
    assert.equal(meta.scope.pgid, readProcess(meta.harness.pid).foregroundPgid);
    s.input('quit');
    const final = await s.ended();
    assert.equal(final.slotHeld, false);
    assert.equal(final.claimState, 'revoked');
    assert.equal(final.receipt.native_exit, null);
    assert.equal(final.receipt.shell_exit.exit_code, 0);
    assert.equal(final.receipt.strategy, 'wrapper');
    assert.equal(final.receipt.logs.capture, 'tty_passthrough');
    assert.equal(final.events.filter((e) => e.kind === 'exit.receipt').length, 1);
    await until(() => processState(meta.supervisor) === 'dead');
    assert.doesNotMatch(readFileSync(join(s.home, 'errors'), 'utf8'), /hud-run:/);
  } finally {
    await s.cleanup();
  }
});

test('visible real SQLite supervisor death reconciles Q without receipt or replacement', async () => {
  const s = await realFixture();
  try {
    s.launch();
    const meta = await s.ready();
    process.kill(meta.supervisor.pid, 'SIGKILL');
    await until(() => processState(meta.supervisor) === 'dead');
    assert.equal((await s.control().reconcile(s.data.input.runId)).currentRun.state, 'uncertain');
    assert.equal((await s.port.read(s.data.input.runId)).slotHeld, true);
    await until(() => readProcess(meta.harness.pid).foregroundPgid !== meta.scope.pgid);
    for (const stamp of [meta.harness, meta.command_leader])
      if (processState(stamp) === 'alive') process.kill(stamp.pid, 'SIGKILL');
    await until(async () => (await s.control().reconcile(s.data.input.runId)).currentRun.state === 'ended');
    const final = await s.port.read(s.data.input.runId);
    assert.equal(final.slotHeld, false);
    assert.equal(final.receipt, null);
    assert.deepEqual(final.status.interaction, { focus: false, input: false, resume: false });
    assert.equal(final.events.filter((e) => e.kind === 'launch.submitting').length, 1);
    assert.equal(existsSync(join(s.home, 'runs', s.data.input.runId, 'exit.json')), false);
    assert.equal(existsSync(join(s.home, 'input.log')), false);
  } finally {
    await s.cleanup();
  }
});

test('visible reused scope stamp refuses signal against a new real foreground group', async () => {
  const s = create();
  try {
    s.launch();
    const meta = await s.ready();
    const old = { ...meta.scope, group_leader: { ...meta.scope.group_leader, proc_start: '0' } };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL']) assert.equal(signalVisibleScope(old, signal), false);
    assert.equal(processState(meta.harness), 'alive');
    s.input('still-reading');
    await until(() => readFileSync(join(s.home, 'input.log'), 'utf8').includes('still-reading'));
    s.input('quit');
    await s.ended();
  } finally {
    await s.cleanup();
  }
});

if (process.env.HUD_VISIBLE_IDLE === '1')
  test('visible real SQLite R=1 idle 60s supervisor ticks RSS and heartbeats', async () => {
    const s = await realFixture();
    try {
      s.launch();
      const meta = await s.ready();
      const metaPath = join(s.home, 'runs', s.data.input.runId, 'meta.json');
      const stableMeta = readFileSync(metaPath, 'utf8');
      const sample = async () => {
        const fields = readFileSync(`/proc/${meta.supervisor.pid}/stat`, 'utf8').split(') ')[1].split(' ');
        const snapshot = await s.port.read(s.data.input.runId);
        return {
          ticks: Number(fields[11]) + Number(fields[12]),
          rssKiB: Number(readFileSync(`/proc/${meta.supervisor.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]),
          heartbeatSeq: snapshot.run.heartbeatSeq,
          events: snapshot.events.length,
          facts: snapshot.facts.length,
        };
      };
      const before = await sample();
      await sleep(60000);
      const after = await sample();
      console.log(
        JSON.stringify({
          idleSeconds: 60,
          R: 1,
          backend: 'SQLite',
          before,
          after,
          deltaTicks: after.ticks - before.ticks,
          heartbeatWrites: after.heartbeatSeq - before.heartbeatSeq,
        })
      );
      assert.equal(after.events, before.events);
      assert.equal(after.facts, before.facts);
      assert.equal(readFileSync(metaPath, 'utf8'), stableMeta);
      assert.ok(after.heartbeatSeq - before.heartbeatSeq >= 11);
      s.input('quit');
      await s.ended();
    } finally {
      await s.cleanup();
    }
  });

test('visible zsh -ic preserves shell function and synthetic context wrapper', async () => {
  const s = create({ shellPath: '/usr/bin/zsh' });
  try {
    s.launch();
    const meta = await s.ready();
    assert.equal(json(join(s.home, 'harness.json')).context, 'function-preserved');
    assert.equal(readProcess(meta.harness.pid).foregroundPgid, meta.scope.pgid);
    s.input('quit');
    const receipt = await s.ended();
    assert.equal(receipt.native_exit, null);
    assert.equal(receipt.shell_exit.exit_code, 0);
  } finally {
    await s.cleanup();
  }
});

test('visible start without private launch fd refuses without reading the terminal', async () => {
  const s = create({ omitFd: true });
  try {
    s.launch();
    await until(() =>
      readFileSync(join(s.home, 'errors'), 'utf8').includes('visible_start_requires_private_launch_fd')
    );
    assert.equal(s.snapshot().events.length, 0);
    assert.equal(existsSync(join(s.home, 'harness.json')), false);
  } finally {
    await s.cleanup();
  }
});

test('visible real short-lived TTY harness exits before discovery and is never redispatched', async () => {
  const s = create({ harnessEnv: { VISIBLE_SHORT: '1' } });
  try {
    s.launch();
    await until(() => s.snapshot()?.run.state === 'uncertain' && s.snapshot()?.meta);
    const first = readFileSync(join(s.home, 'harness.json'), 'utf8');
    assert.equal(s.snapshot().meta.harness, null);
    assert.equal(s.snapshot().meta.scope, null);
    assert.equal(s.snapshot().receipt, null);
    assert.equal(s.snapshot().slotHeld, true);
    s.launch();
    await until(() => readFileSync(join(s.home, 'errors'), 'utf8').includes('ticket_refused'));
    assert.equal(readFileSync(join(s.home, 'harness.json'), 'utf8'), first);
    assert.equal(s.snapshot().events.filter((e) => e.kind === 'supervisor.registered').length, 1);
  } finally {
    await s.cleanup();
  }
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  test(`visible supervisor-directed ${signal} records unconfirmed cancellation without forwarding`, async () => {
    const s = await realFixture();
    try {
      s.launch();
      const meta = await s.ready();
      process.kill(meta.supervisor.pid, signal);
      const snapshot = await until(async () => {
        const current = await s.port.read(s.data.input.runId);
        return current.events.some((event) => event.kind === 'cancel.unconfirmed') && current;
      });
      const facts = snapshot.events.filter((e) => e.kind === 'supervisor.signal');
      assert.equal(facts.length, 1);
      assert.equal(facts[0].payload.signal, signal);
      assert.ok(Number.isSafeInteger(facts[0].payload.observedAt));
      assert.ok(facts[0].payload.observedAt <= facts[0].at);
      assert.equal(
        snapshot.events.some((e) => e.kind === 'command.exited'),
        false
      );
      const stableMeta = readFileSync(join(s.home, 'runs', s.data.input.runId, 'meta.json'), 'utf8');
      process.kill(meta.supervisor.pid, signal);
      await until(
        async () =>
          (await s.port.read(s.data.input.runId)).events.filter((e) => e.kind === 'supervisor.signal').length === 2
      );
      const duplicate = await s.port.read(s.data.input.runId);
      assert.equal(duplicate.events.filter((e) => e.kind === 'cancel.accepted').length, 1);
      assert.equal(duplicate.events.filter((e) => e.kind === 'cancel.step').length, 1);
      assert.equal(readFileSync(join(s.home, 'runs', s.data.input.runId, 'meta.json'), 'utf8'), stableMeta);
      assert.equal(processState(meta.harness), 'alive');
      assert.equal(readProcess(meta.harness.pid).foregroundPgid, meta.scope.pgid);
      assert.equal(snapshot.slotHeld, true);
      assert.equal(snapshot.receipt, null);
      assert.equal(snapshot.events.filter((e) => e.kind === 'cancel.accepted').length, 1);
      assert.deepEqual(
        snapshot.events.filter((e) => e.kind === 'cancel.step').map((e) => e.payload.ack),
        [false]
      );
      s.input('quit');
      const final = await s.ended();
      assert.equal(final.receipt.native_exit, null);
      assert.equal(final.slotHeld, false);
      assert.equal(final.run.state, 'ended');
    } finally {
      await s.cleanup();
    }
  });

test('visible background launcher retaining /dev/tty and surviving briefly has zero registration and dispatch', async () => {
  const s = create({ background: 'surviving-tty' });
  try {
    s.launch();
    const launcher = await until(() => readProcess(Number(json(join(s.home, 'launcher.pid'))))?.stamp);
    s.remember();
    await until(
      () =>
        existsSync(join(s.home, 'harness.json')) ||
        readFileSync(join(s.home, 'errors'), 'utf8').includes('unsupported_visible_background'),
      4000
    );
    assert.equal(processState(launcher), 'alive', 'the background launcher must still survive at refusal');
    assert.equal(s.snapshot().events.filter((event) => event.kind === 'supervisor.registered').length, 0);
    assert.equal(existsSync(join(s.home, 'harness.json')), false);
  } finally {
    await s.cleanup();
  }
});

for (const background of ['foreground-wrapper', 'job-control-tty'])
  test(`visible unsupported ${background} with explicit /dev/tty has zero dispatch`, async () => {
    const s = create({ background });
    try {
      s.launch();
      await until(() => readFileSync(join(s.home, 'errors'), 'utf8').includes('unsupported_visible_background'));
      assert.equal(s.snapshot().events.length, 0);
      assert.equal(existsSync(join(s.home, 'harness.json')), false);
    } finally {
      await s.cleanup();
    }
  });

test('visible H07 HUP during terminal import records only supervisor receipt with normal ended scope', async () => {
  const s = await realFixture({ supervisorPort: 'tests/run/b3h-terminal-port.mjs' });
  try {
    s.launch();
    const meta = await s.ready();
    s.input('quit');
    await until(() => existsSync(join(s.home, 'terminal-import')));
    assert.equal(processState(meta.harness), 'dead');
    process.kill(meta.supervisor.pid, 'SIGHUP');
    const partial = await until(async () => {
      const snapshot = await s.port.read(s.data.input.runId);
      return snapshot.events.some((e) => e.kind === 'supervisor.signal') && snapshot;
    });
    assert.equal(partial.receipt, null);
    assert.equal(partial.slotHeld, true);
    assert.equal(
      partial.events.some((e) => e.kind === 'cancel.step'),
      false
    );
    writeFileSync(join(s.home, 'release-import'), '', { mode: 0o600 });
    const final = await s.ended();
    assert.equal(final.run.state, 'ended');
    assert.equal(final.receipt.reason, 'scope_ended');
    assert.equal(final.receipt.native_exit, null);
    assert.equal(final.receipt.shell_exit.exit_code, 0);
    assert.equal(final.events.filter((e) => e.kind === 'supervisor.signal').length, 1);
    assert.equal(final.slotHeld, false);
    await until(() => processState(meta.supervisor) === 'dead');
  } finally {
    writeFileSync(join(s.home, 'release-import'), '', { mode: 0o600 });
    await s.cleanup();
  }
});
