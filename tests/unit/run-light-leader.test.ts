import {
  validateStartup,
  startupStderr,
  retainCapture,
  type DiagnosticProfile,
} from '../int/node-startup-diagnostics.js';
import { launchNodeGroup } from '../run/native-group.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test, { before, type TestContext } from 'node:test';
import { HeadlessRunControl } from '../../src/core/run/control.js';
import { MemoryRunFactPort } from '../../src/core/run/fake-port.js';
import { createGroupPipe } from '../../src/core/run/group-pipe.js';
import { GROUP_LEADER_SCRIPT } from '../../src/core/run/group-leader.js';
import {
  encodeGroupEnvironment,
  launchGroup,
  launchShellGroup,
  preflightGroupEnvironment,
  processState,
  inspectGroup,
  proveGroupGone,
  readProcess,
  type GroupProcess,
} from '../../src/core/run/process.js';
import type { GroupExit, ProcessStamp } from '../../src/core/types/supervision.js';
import { seedRun } from '../run/fixtures.js';

function spawnRawLeader(command: string, args: string[], options: Parameters<typeof spawn>[2]) {
  const pipe = createGroupPipe();
  let child;
  try {
    child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'ignore', pipe.read, pipe.write],
    });
  } finally {
    pipe.close();
  }
  (child.stdio[4] as NodeJS.ReadableStream).on('data', (b) => {
    if (String(b).includes('WAIT ')) (child.stdio[3] as NodeJS.WritableStream).end();
  });
  return child;
}

let profile: DiagnosticProfile;
before(() => {
  profile = validateStartup();
});
const STDERR_SENTINEL = 'synthetic-workload-stderr\n';

const skip = process.platform !== 'linux';
const actor = { kind: 'trusted_local' as const, uid: process.getuid!(), invocationId: 'synthetic-light-leader' };
async function until(fn: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!fn()) {
    assert.ok(Date.now() < deadline, 'fixture deadline');
    await sleep(10);
  }
}
function auxiliaryStamps(group: GroupProcess): ProcessStamp[] {
  try {
    return readFileSync(`/proc/${group.helper.pid}/task/${group.helper.pid}/children`, 'utf8')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((pid) => pid !== group.command?.pid)
      .flatMap((pid) => {
        const p = readProcess(pid);
        return p ? [p.stamp] : [];
      });
  } catch {
    return [];
  }
}

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'hud-light-leader-'));
  const output = join(home, 'output');
  const fd = openSync(output, 'a', 0o600);
  const error = join(home, 'error');
  const errorFd = openSync(error, 'a', 0o600);
  const groups: GroupProcess[] = [];
  const auxiliaries: ProcessStamp[] = [];
  t.after(async () => {
    for (const g of groups) {
      for (const stamp of [g.command, ...auxiliaries, g.helper]) {
        if (stamp && processState(stamp) === 'alive') {
          try {
            process.kill(stamp.pid, 'SIGKILL');
          } catch {}
        }
      }
      g.close();
      await g.exited;
    }
    retainCapture(`run-light-leader-${basename(home)}`, {
      pid: process.pid,
      status: null,
      signal: null,
      stdout: readFileSync(output),
      stderr: readFileSync(error),
    });
    closeSync(fd);
    closeSync(errorFd);
    rmSync(home, { recursive: true, force: true });
  });
  return {
    home,
    output,
    error,
    async launch(argv: string[], env?: NodeJS.ProcessEnv) {
      const g = await launchGroup({
        runId: 'synthetic-light',
        argv,
        cwd: home,
        stdin: Buffer.from('$(touch forbidden);\n'),
        env,
        stdoutFd: fd,
        stderrFd: errorFd,
      });
      groups.push(g);
      auxiliaries.push(...auxiliaryStamps(g));
      return g;
    },
  };
}

for (const result of [0, 3, 137, 'SIGKILL', 'SIGTERM'] as const) {
  test(`light leader keeps ${result} sourced as native_unknown and completes scope`, { skip }, async (t) => {
    const f = fixture(t);
    const argv = [
      process.execPath,
      '-e',
      typeof result === 'number' ? `setTimeout(()=>process.exit(${result}),150)` : 'setTimeout(()=>{},60000)',
    ];
    const data = seedRun(f.home, argv);
    const port = new MemoryRunFactPort(data.seed);
    let group: GroupProcess | undefined, observed: GroupExit | undefined;
    const control = new HeadlessRunControl(port, f.home, actor, async (o) => {
      group = await launchGroup(o);
      group.exited.then((e) => {
        observed = e;
      });
      if (typeof result === 'string') setTimeout(() => process.kill(group!.command!.pid, result), 100);
      return group;
    });
    await control.start({ input: data.input, ticket: data.ticket });
    assert.equal(observed?.source, 'native_unknown');
    assert.equal(observed?.code, null);
    assert.equal(observed?.signal, null);
    assert.equal(group?.shellDiagnostic?.source, 'posix_shell_wait');
    assert.equal(
      group?.shellDiagnostic?.status,
      typeof result === 'number' ? result : result === 'SIGKILL' ? 137 : 143
    );
    const s = await port.read(data.input.runId);
    assert.equal(s.receipt?.native_exit, null);
    assert.equal(s.receipt?.shell_exit, null);
    assert.equal(s.receipt?.reason, 'scope_ended');
    assert.equal(s.run.state, 'ended');
    assert.equal(s.slotHeld, false);
    t.diagnostic(
      JSON.stringify({
        result,
        source: observed?.source,
        native_exit: s.receipt?.native_exit,
        shellDiagnostic: group?.shellDiagnostic?.status,
      })
    );
  });
}

for (const result of [0, 3, 137, 'SIGKILL', 'SIGTERM'] as const) {
  test(`compatibility native waiter retains exact ${result} with full subject stamp`, { skip }, async (t) => {
    const f = fixture(t);
    const data = seedRun(f.home, [
      process.execPath,
      '-e',
      typeof result === 'number' ? `setTimeout(()=>process.exit(${result}),150)` : 'setTimeout(()=>{},60000)',
    ]);
    const port = new MemoryRunFactPort(data.seed);
    let observed: GroupExit | undefined;
    const control = new HeadlessRunControl(port, f.home, actor, async (o) => {
      const group = await launchNodeGroup(o);
      group.exited.then((e) => {
        observed = e;
      });
      if (typeof result === 'string') setTimeout(() => process.kill(group.command!.pid, result), 100);
      return group;
    });
    await control.start({ input: data.input, ticket: data.ticket });
    const s = await port.read(data.input.runId);
    assert.equal(observed?.source, 'verified_wait');
    assert.deepEqual(observed?.subject, s.meta?.harness);
    assert.equal(s.receipt?.native_exit?.exit_code, typeof result === 'number' ? result : null);
    assert.equal(s.receipt?.native_exit?.signal, typeof result === 'string' ? result : null);
    assert.equal(s.receipt?.native_exit?.status_source, 'wait_status');
  });
}

test('native waiter subject mismatch cannot project either a harness or another shell result', { skip }, async (t) => {
  const f = fixture(t),
    data = seedRun(f.home, [process.execPath, '-e', 'setTimeout(()=>process.exit(3),150)']);
  const port = new MemoryRunFactPort(data.seed);
  const control = new HeadlessRunControl(port, f.home, actor, async (o) => {
    const g = await launchNodeGroup(o);
    return {
      ...g,
      exited: g.exited.then((e) =>
        e.source === 'verified_wait' ? { ...e, subject: { ...e.subject, proc_start: 'synthetic-mismatch' } } : e
      ),
    };
  });
  await control.start({ input: data.input, ticket: data.ticket });
  const s = await port.read(data.input.runId);
  assert.equal(s.receipt?.native_exit, null);
  assert.equal(s.receipt?.shell_exit, null);
  assert.equal(s.receipt?.reason, 'scope_ended');
});

test('environment transport is byte-exact, nonrecursive and absent from command lines', { skip }, async (t) => {
  const f = fixture(t);
  const sentinel = 'synthetic-secret-not-for-argv-4711';
  const values = [
    '${HUD_ENV_0}',
    '$',
    '\\c\\n\\_',
    '#',
    '\'"',
    '=',
    ' leading ',
    '\ntrailing\n',
    '',
    'x'.repeat(120000),
    '😀'.repeat(9000),
  ];
  const env: NodeJS.ProcessEnv = {
    '-u': 'x',
    '--': 'y',
    '-i': 'z',
    HUD_ENV_0: 'original-collision',
    'HUD.DOTTED': sentinel,
    PWD: '/synthetic/original-pwd',
    'BASH_FUNC_hud_synthetic%%': '() { printf synthetic-ok; }',
    NODE_OPTIONS: '--trace-warnings',
  };
  values.forEach((v, i) => {
    env[`SYNTHETIC_${i}`] = v;
  });
  const args = ['a b', 'line\nnext', '\u0080é', '$(touch forbidden)', '"\\$;'];
  const g = await f.launch(
    [
      process.execPath,
      '-e',
      'process.stdin.resume();console.log(JSON.stringify(process.argv.slice(1)));setTimeout(()=>process.exit(0),200)',
      ...args,
    ],
    env
  );
  for (const stamp of [g.helper, g.command!]) {
    const cmdline = readFileSync(`/proc/${stamp.pid}/cmdline`);
    assert.equal(cmdline.includes(sentinel), false);
    assert.equal(cmdline.includes('HUD.DOTTED'), false);
  }
  await until(() => readFileSync(f.output, 'utf8').includes('['));
  const actual = readFileSync(`/proc/${g.command!.pid}/environ`).subarray(0, -1).toString().split('\0').sort();
  assert.deepEqual(
    actual,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .sort()
  );
  await g.exited;
  assert.deepEqual(JSON.parse(readFileSync(f.output, 'utf8').trim()), args);
  assert.equal(existsSync(join(f.home, 'forbidden')), false);
});

test(
  'very large environments explicitly refuse instead of truncating, and missing env features never fall back',
  { skip },
  async (t) => {
    const f = fixture(t);
    assert.throws(() => preflightGroupEnvironment('/synthetic/missing-env'), /headless_env_features_unavailable/);
    await assert.rejects(
      () => f.launch([process.execPath, '-e', ''], { SYNTHETIC: 'x'.repeat(4000000) }),
      /headless_environment_too_large/
    );
    assert.throws(
      () =>
        encodeGroupEnvironment(Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`SYNTHETIC_${i}`, 'x']))),
      /headless_environment_too_large/
    );
  }
);

test(
  'light leader consumes RUN once, rejects control code, seals on EOF, and reaps after interrupted wait',
  { skip },
  async (t) => {
    const f = fixture(t);
    const c = spawnRawLeader(
      '/bin/sh',
      [
        '-c',
        GROUP_LEADER_SCRIPT,
        'synthetic',
        '/usr/bin/env',
        '--default-signal=INT,QUIT',
        process.execPath,
        '-e',
        "setTimeout(()=>{console.log('continued');process.exit(3)},350)",
      ],
      { detached: true, cwd: f.home, env: {}, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] }
    );
    let replies = '',
      output = '';
    (c.stdio[4] as NodeJS.ReadableStream).on('data', (b) => {
      replies += b;
    });
    c.stdout!.on('data', (b) => {
      output += b;
    });
    const control = c.stdio[3] as NodeJS.WritableStream;
    control.on('error', () => {});
    const done = once(c, 'exit');
    t.after(async () => {
      if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
      await done;
    });
    await until(() => replies.includes('READY'));
    control.write('RUN\n');
    await until(() => replies.includes('STARTED'));
    control.write('RUN\nINT; touch forbidden\nTERM 2 extra\nNOPE 4\nDONE 0\nSEAL\n');
    await until(() => (replies.match(/REFUSED/g) ?? []).length === 6);
    // EOF permanently leaves the read loop. A signal interrupts wait, which must retry.
    control.end();
    c.kill('SIGINT');
    assert.equal((await done)[0], 0);
    assert.match(replies, /WAIT 3/);
    assert.match(output, /continued/);
    assert.equal(existsSync(join(f.home, 'forbidden')), false);
    assert.equal(readProcess(c.pid!), null);
  }
);

test('light leader EOF before RUN launches nothing and never reopens submission', { skip }, async () => {
  const c = spawnRawLeader('/bin/sh', ['-c', GROUP_LEADER_SCRIPT, 'synthetic', '/bin/false'], {
    detached: true,
    env: {},
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
  });
  const done = once(c, 'exit');
  let replies = '';
  (c.stdio[4] as NodeJS.ReadableStream).on('data', (b) => {
    replies += b;
  });
  const control = c.stdio[3] as NodeJS.WritableStream;
  control.on('error', () => {});
  await until(() => replies.includes('READY'));
  control.end();
  const reopenError = await new Promise<string | undefined>((resolve) => {
    control.write('RUN\n', (error) => resolve((error as NodeJS.ErrnoException | null)?.code));
  });
  assert.equal(reopenError, 'ERR_STREAM_WRITE_AFTER_END');
  assert.equal((await done)[0], 0);
  assert.equal(replies.includes('STARTED'), false);
});

test(
  'exec-stop audit covers leader, env before exec, harness and failed exec without argv disclosure',
  { skip: skip || process.arch !== 'x64' || !existsSync('/usr/bin/python3') },
  () => {
    const result = spawnSync(
      '/usr/bin/python3',
      ['tests/int/b3ar1-env-audit.py', process.execPath, 'tests/int/b3ar1-env-driver.mjs'],
      { encoding: 'utf8', timeout: 15000 }
    );
    assert.equal(result.status, 0, result.stderr);
    const counts = JSON.parse(result.stdout);
    assert.equal(counts.leaderExecs, 2);
    assert.equal(counts.harnessExecs, 1);
    assert.ok(counts.envSyscallStops > 0);
    assert.ok(counts.failedExecPhaseExits > 0);
    assert.equal(counts.failedENOENTSyscalls, 1);
  }
);

test('leader death before a live harness refuses control and never proves scope gone', { skip }, async (t) => {
  const f = fixture(t);
  const g = await f.launch([process.execPath, '-e', 'console.log("ready");setTimeout(()=>{},60000)']);
  await until(() => readFileSync(f.output, 'utf8').includes('ready'));
  process.kill(g.helper.pid, 'SIGKILL');
  const exit = await g.exited;
  assert.equal(exit.source, 'native_unknown');
  assert.equal(processState(g.command!), 'alive');
  assert.equal(await g.signal('SIGINT'), false);
  assert.equal(inspectGroup(g.scope!).result, 'unknown');
  assert.equal(proveGroupGone(g.scope!, g.command!, [g.helper]), false);
});

test(
  'lightweight scope cancellation covers an INT-ignoring harness and forked grandchild through KILL',
  { skip },
  async (t) => {
    const f = fixture(t);
    const data = seedRun(f.home, [
      process.execPath,
      '-e',
      `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',"process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});console.log('grandchild');setTimeout(()=>{},60000)"],{stdio:'inherit'});require('fs').writeFileSync('grandchild.pid',String(c.pid));process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setTimeout(()=>{},60000)`,
    ]);
    const port = new MemoryRunFactPort(data.seed);
    const control = new HeadlessRunControl(port, f.home, actor);
    const running = control.start({ input: data.input, ticket: data.ticket });
    let stamps: ProcessStamp[] = [];
    try {
      await until(() => {
        try {
          return control.logs(data.input.runId, 'stdout').data.toString().includes('grandchild');
        } catch {
          return false;
        }
      });
      const snap = await port.read(data.input.runId);
      const child = readProcess(Number(readFileSync(join(f.home, 'grandchild.pid'), 'utf8')))!.stamp;
      stamps = [child, snap.meta!.harness!, snap.meta!.scope!.group_leader];
      await control.cancel(data.input.runId, 20);
      await running;
      const after = await port.read(data.input.runId);
      assert.deepEqual(
        after.events.filter((e) => e.kind === 'cancel.step').map((e) => e.payload.signal),
        ['SIGINT', 'SIGTERM', 'SIGKILL']
      );
      for (const stamp of stamps) assert.equal(processState(stamp), 'dead');
      assert.equal(after.receipt?.native_exit ?? null, null);
    } finally {
      for (const stamp of stamps)
        if (processState(stamp) === 'alive') {
          try {
            process.kill(stamp.pid, 'SIGKILL');
          } catch {}
        }
      await running.catch(() => {});
    }
  }
);

test(
  'the harness cannot move the real session leader into an owned decoy group',
  { skip: skip || !existsSync('/usr/bin/python3') },
  async (t) => {
    const f = fixture(t);
    const script = `import os,signal,time,errno\nleader=os.getsid(0)\nopen('targeted-leader','w').write(str(leader))\ndecoy=os.fork()\nif decoy==0:\n os.setpgid(0,0)\n signal.signal(signal.SIGINT,lambda a,b:open('decoy-int','w').write('yes'))\n open('decoy','w').write(str(os.getpid()))\n time.sleep(10)\n os._exit(0)\nwhile not os.path.exists('decoy'): time.sleep(.01)\ntry:\n os.setpgid(leader,decoy)\n open('moved','w').write('bad')\nexcept OSError as e: open('refused','w').write(str(e.errno))\nsignal.signal(signal.SIGINT,lambda a,b:open('harness-int','w').write('yes'))\nsignal.signal(signal.SIGTERM,lambda a,b:None)\nopen('ready','w').write('yes')\ntry:\n end=time.monotonic()+4\n while time.monotonic()<end and not os.path.exists('harness-int'): time.sleep(.01)\nfinally:\n os.kill(decoy,signal.SIGKILL)\n os.waitpid(decoy,0)\n`;
    const g = await f.launch(['/usr/bin/python3', '-c', script]);
    await until(() => existsSync(join(f.home, 'ready')));
    assert.equal(existsSync(join(f.home, 'moved')), false);
    assert.equal(Number(readFileSync(join(f.home, 'targeted-leader'), 'utf8')), g.helper.pid);
    assert.ok(existsSync(join(f.home, 'refused')));
    assert.equal(readProcess(g.helper.pid)?.pgid, g.helper.pid);
    assert.equal(readProcess(g.helper.pid)?.sid, g.helper.pid);
    assert.equal(await g.signal('SIGINT'), true);
    await g.exited;
    assert.equal(existsSync(join(f.home, 'harness-int')), true);
    assert.equal(existsSync(join(f.home, 'decoy-int')), false);
  }
);

test(
  'empty environment and a real sh workload are confirmed after exec, never in the pre-env fork',
  { skip },
  async (t) => {
    const f = fixture(t);
    const g = await f.launch(['/bin/sh', '-c', 'printf ready; sleep 0.2'], {});
    assert.ok(g.command);
    assert.ok(g.scope);
    assert.equal(readFileSync(`/proc/${g.command.pid}/environ`).length, 0);
    await g.exited;
    assert.match(readFileSync(f.output, 'utf8'), /ready/);
  }
);

test('failed workload exec never fixes the temporary env process as a harness', { skip }, async (t) => {
  const f = fixture(t);
  await assert.rejects(
    () => f.launch(['/synthetic/exec-will-fail'], {}),
    /before confirmed submission|exec unconfirmed/
  );
});

test('equals in executable is refused before registration with no reserved-intent effects', { skip }, async (t) => {
  const f = fixture(t),
    data = seedRun(f.home, ['/synthetic/executable=assignment', '/usr/bin/printf', 'forbidden']);
  const port = new MemoryRunFactPort(data.seed);
  const before = structuredClone(data.seed);
  const control = new HeadlessRunControl(port, f.home, actor);
  await assert.rejects(
    () => control.start({ input: data.input, ticket: data.ticket }),
    /headless_executable_assignment_unsupported/
  );
  assert.deepEqual(data.seed, before);
  assert.equal(existsSync(join(f.home, 'runs')), false);
  await assert.rejects(
    () => f.launch(['/synthetic/executable=assignment']),
    /headless_executable_assignment_unsupported/
  );
});

test(
  'stopped direct workload keeps leader control across stop/continue CHLD notifications',
  { skip: skip || !existsSync('/usr/bin/python3') },
  async (t) => {
    const f = fixture(t);
    const g = await f.launch([
      '/usr/bin/python3',
      '-c',
      `import os,signal,time,ctypes;ctypes.CDLL(None).prctl(15,b'odd) \\nname',0,0,0);time.sleep(.1);os.kill(os.getpid(),signal.SIGSTOP);time.sleep(60)`,
    ]);
    await until(() => readProcess(g.command!.pid)?.state === 'T');
    assert.equal(await g.signal('SIGINT'), true);
    process.kill(g.command!.pid, 'SIGCONT');
    await g.exited;
    assert.equal(g.shellDiagnostic?.status, 130);
  }
);

test(
  'a stopped harness remains reachable by every cancellation step through group KILL',
  { skip: skip || !existsSync('/usr/bin/python3') },
  async (t) => {
    const f = fixture(t);
    const g = await f.launch([
      '/usr/bin/python3',
      '-c',
      'import os,signal,time;time.sleep(.1);os.kill(os.getpid(),signal.SIGSTOP);time.sleep(60)',
    ]);
    await until(() => readProcess(g.command!.pid)?.state === 'T');
    assert.equal(await g.signal('SIGINT'), true);
    assert.equal(await g.signal('SIGTERM'), true);
    assert.equal(await g.signal('SIGKILL'), false);
    assert.equal((await g.exited).source, 'native_unknown');
    assert.equal(processState(g.helper), 'dead');
    await until(() => processState(g.command!) === 'dead');
  }
);

test('light leader preserves exact brief bytes and EOF on workload fd0', { skip }, async (t) => {
  const f = fixture(t);
  const g = await f.launch([
    process.execPath,
    '-e',
    `const a=[];process.stdin.on('data',b=>a.push(b));process.stdin.on('end',()=>{process.stdout.write(Buffer.concat(a));process.stderr.write(${JSON.stringify(STDERR_SENTINEL)});setTimeout(()=>process.exit(0),60)});`,
  ]);
  await g.exited;
  const stdout = readFileSync(f.output);
  const stderr = readFileSync(f.error);
  assert.deepEqual(stdout, Buffer.from('$(touch forbidden);\n'));
  assert.equal(stdout.includes(STDERR_SENTINEL), false);
  assert.ok(g.command);
  assert.deepEqual(stderr, Buffer.concat([startupStderr(profile, g.command.pid), Buffer.from(STDERR_SENTINEL)]));
  assert.equal(existsSync(join(f.home, 'forbidden')), false);
});

test(
  'workload signal dispositions match a direct spawn before installing handlers',
  { skip: skip || !existsSync('/usr/bin/python3') },
  async (t) => {
    const f = fixture(t);
    const code =
      'import signal,time,json;print(json.dumps(["handler" if callable(signal.getsignal(s)) else int(signal.getsignal(s)) for s in [signal.SIGINT,signal.SIGQUIT,signal.SIGTERM]]),flush=True);time.sleep(.1)';
    const expected = spawnSync('/usr/bin/python3', ['-c', code], { encoding: 'utf8' });
    assert.equal(expected.status, 0, expected.stderr);
    const g = await f.launch(['/usr/bin/python3', '-c', code]);
    await g.exited;
    assert.equal(readFileSync(f.output, 'utf8'), expected.stdout);
  }
);

test('waiter completion before the leader read loop remains buffered without control EOF', { skip }, async (t) => {
  const f = fixture(t);
  const script = GROUP_LEADER_SCRIPT.replace('sealed=0', () => 'kill -STOP $$\nsealed=0');
  const c = spawnRawLeader('/bin/sh', ['-c', script, 'synthetic', '/bin/false'], {
    detached: true,
    cwd: f.home,
    env: {},
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
  });
  let replies = '';
  (c.stdio[4] as NodeJS.ReadableStream).on('data', (b) => {
    replies += b;
  });
  const input = c.stdio[3] as NodeJS.WritableStream;
  input.on('error', () => {});
  const done = once(c, 'exit');
  t.after(async () => {
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    input.end();
    await done;
  });
  await until(() => replies.includes('READY'));
  input.write('RUN\n');
  await until(() => readProcess(c.pid!)?.state === 'T');
  await sleep(50);
  c.kill('SIGCONT');
  await until(() => replies.includes('WAIT 1'));
  assert.equal((await done)[0], 0);
});

test(
  'physical parent MCP death with continue policy preserves the same lightweight run through final reconciliation',
  { skip },
  async (t) => {
    const f = fixture(t);
    const parent = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
    const parentDone = once(parent, 'exit');
    t.after(async () => {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
      await parentDone;
    });
    const parentStamp = readProcess(parent.pid!)!.stamp;
    const data = seedRun(f.home, [process.execPath, '-e', "console.log('ready');setTimeout(()=>process.exit(0),5500)"]);
    const port = new MemoryRunFactPort(data.seed),
      control = new HeadlessRunControl(port, f.home, actor);
    const running = control.start({
      input: data.input,
      ticket: data.ticket,
      parent: { process: parentStamp, contextId: 'synthetic-parent', generation: 1 },
    });
    await until(() => {
      try {
        return control.logs(data.input.runId, 'stdout').data.toString().includes('ready');
      } catch {
        return false;
      }
    });
    const original = (await port.read(data.input.runId)).meta!.harness;
    parent.kill('SIGKILL');
    await parentDone;
    assert.equal(processState(original!), 'alive');
    await running;
    const final = await port.read(data.input.runId);
    assert.deepEqual(final.meta!.harness, original);
    assert.ok(final.events.some((e) => e.kind === 'parent.offline'));
    assert.equal(
      final.events.some((e) => e.kind === 'cancel.accepted'),
      false
    );
    assert.equal(final.run.state, 'ended');
    assert.equal(final.receipt?.native_exit, null);
    assert.equal(final.receipt?.reason, 'scope_ended');
    assert.equal(final.slotHeld, false);
  }
);

test('waiter completion between loop check and read is buffered independently of CHLD traps', { skip }, async (t) => {
  const f = fixture(t);
  const script = GROUP_LEADER_SCRIPT.replace(
    ' interrupted=0\n if IFS',
    () => ' interrupted=0\n kill -STOP $$\n if IFS'
  );
  const c = spawnRawLeader('/bin/sh', ['-c', script, 'synthetic', '/bin/sh', '-c', 'sleep .03; exit 3'], {
    detached: true,
    cwd: f.home,
    env: {},
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
  });
  const input = c.stdio[3] as NodeJS.WritableStream;
  input.on('error', () => {});
  let replies = '';
  (c.stdio[4] as NodeJS.ReadableStream).on('data', (b) => {
    replies += b;
  });
  const done = once(c, 'exit');
  t.after(async () => {
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    input.end();
    await done;
  });
  await until(() => replies.includes('READY'));
  input.write('RUN\n');
  await until(() => readProcess(c.pid!)?.state === 'T');
  await sleep(80);
  c.kill('SIGCONT');
  await until(() => replies.includes('WAIT 3'));
  assert.equal((await done)[0], 0);
  assert.match(replies, /WAIT 3/);
});

test('aggregate exec environment exceeding kernel ARG_MAX refuses explicitly', { skip }, async (t) => {
  const f = fixture(t);
  await assert.rejects(
    () =>
      f.launch(
        [process.execPath, '-e', ''],
        Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`SYNTHETIC_BULK_${i}`, 'x'.repeat(60000)]))
      ),
    /headless_environment_too_large/
  );
});

for (const shell of [
  { path: '/bin/sh' },
  { path: '/bin/bash', argv0: '/bin/sh' },
  { path: '/bin/bash', args: ['--posix'] },
]) {
  test(
    `portable waiter topology completes, preserves stdin, and controls scope under ${JSON.stringify(shell)}`,
    { skip: skip || !existsSync(shell.path) },
    async (t) => {
      const f = fixture(t),
        fd = openSync(f.output, 'a', 0o600);
      let g: GroupProcess | undefined;
      try {
        g = await launchShellGroup(
          {
            runId: 'synthetic-portable',
            argv: [
              process.execPath,
              '-e',
              "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>process.exit(3));process.stdin.pipe(process.stdout);console.log('ready');setTimeout(()=>{},60000)",
            ],
            cwd: f.home,
            env: { 'SYNTHETIC.DOTTED': 'value', PWD: '/synthetic/original', HUD_ENV_0: 'collision' },
            stdin: Buffer.from('portable-brief'),
            stdoutFd: fd,
            stderrFd: fd,
          },
          shell
        );
        await until(() => readFileSync(f.output, 'utf8').includes('portable-brief'));
        assert.equal(readProcess(g.helper.pid)?.pgid, g.helper.pid);
        assert.equal(await g.signal('SIGINT'), true);
        assert.equal(await g.signal('SIGTERM'), true);
        const exit = await g.exited;
        assert.equal(exit.source, 'native_unknown');
        assert.equal(g.shellDiagnostic?.status, 3);
        assert.notEqual(g.shellDiagnostic?.observer.pid, g.helper.pid);
        assert.equal(proveGroupGone(g.scope!, g.command!, [g.helper]), true);
      } finally {
        if (g) {
          for (const st of [g.command, g.helper])
            if (st && processState(st) === 'alive') {
              try {
                process.kill(st.pid, 'SIGKILL');
              } catch {}
            }
          g.close();
          await g.exited;
        }
        closeSync(fd);
      }
    }
  );
}

for (const shell of [
  { path: '/bin/bash', argv0: '/bin/sh' },
  { path: '/bin/bash', args: ['--posix'] },
]) {
  for (const result of [0, 3, 137, 'SIGKILL', 'SIGTERM'] as const) {
    test(
      `portable Bash source matrix ${JSON.stringify(shell)} ${result}`,
      { skip: skip || !existsSync(shell.path) },
      async (t) => {
        const f = fixture(t),
          data = seedRun(f.home, [
            process.execPath,
            '-e',
            typeof result === 'number' ? `setTimeout(()=>process.exit(${result}),150)` : 'setTimeout(()=>{},60000)',
          ]);
        const port = new MemoryRunFactPort(data.seed);
        let g: GroupProcess | undefined;
        const control = new HeadlessRunControl(port, f.home, actor, async (o) => {
          g = await launchShellGroup(o, shell);
          if (typeof result === 'string') setTimeout(() => process.kill(g!.command!.pid, result), 80);
          return g;
        });
        await control.start({ input: data.input, ticket: data.ticket });
        const status = await port.read(data.input.runId);
        assert.equal(status.receipt?.native_exit, null);
        assert.equal(status.receipt?.shell_exit, null);
        assert.equal(status.receipt?.reason, 'scope_ended');
        assert.equal(status.run.state, 'ended');
        assert.equal(status.slotHeld, false);
        assert.equal(
          g?.shellDiagnostic?.status,
          typeof result === 'number' ? result : result === 'SIGKILL' ? 137 : 143
        );
      }
    );
  }
  test(
    `portable Bash environment multiset and EOF sealing ${JSON.stringify(shell)}`,
    { skip: skip || !existsSync(shell.path) },
    async (t) => {
      const f = fixture(t),
        fd = openSync(f.output, 'a', 0o600);
      const env = {
        '-u': 'x',
        '--': 'y',
        '-i': 'z',
        HUD_ENV_0: 'original-collision',
        'HUD.DOTTED': 'synthetic-secret-portable',
        'BASH_FUNC_hud_synthetic%%': '() { printf synthetic-ok; }',
        PWD: '/synthetic/original',
        NODE_OPTIONS: '--trace-warnings',
        SYNTHETIC: ' \c\n\_ ${HUD_ENV_0} $ # \" =\n ',
      };
      const argv = [
        process.execPath,
        '-e',
        "process.stdin.on('data',b=>process.stdout.write(b));setTimeout(()=>process.exit(0),250)",
        'a b',
        'line\nnext',
        'é\u0080',
        '$(touch forbidden)',
      ];
      let g: GroupProcess | undefined;
      try {
        g = await launchShellGroup(
          {
            runId: 'synthetic-portable-env',
            argv,
            env,
            cwd: f.home,
            stdin: Buffer.from('bytes\0$()\n'),
            stdoutFd: fd,
            stderrFd: fd,
          },
          shell
        );
        assert.deepEqual(
          readFileSync(`/proc/${g.command!.pid}/environ`).subarray(0, -1).toString().split('\0').sort(),
          Object.entries(env)
            .map(([k, v]) => `${k}=${v}`)
            .sort()
        );
        for (const st of [g.helper, ...auxiliaryStamps(g), g.command!])
          assert.equal(readFileSync(`/proc/${st.pid}/cmdline`).includes('synthetic-secret-portable'), false);
        assert.deepEqual(readFileSync(`/proc/${g.command!.pid}/cmdline`), Buffer.from(argv.join('\0') + '\0'));
        g.close();
        assert.equal(await g.signal('SIGINT'), false);
        await g.exited;
        assert.deepEqual(readFileSync(f.output), Buffer.from('bytes\0$()\n'));
        assert.equal(proveGroupGone(g.scope!, g.command!, [g.helper]), true);
      } finally {
        if (g) {
          for (const st of [g.command, ...auxiliaryStamps(g), g.helper])
            if (st && processState(st) === 'alive') {
              try {
                process.kill(st.pid, 'SIGKILL');
              } catch {}
            }
          g.close();
          await g.exited;
        }
        closeSync(fd);
      }
    }
  );
}

for (const role of ['waiter', 'forwarder'] as const) {
  test(`only ${role} death retains honest state and safe scoped control outcome`, { skip }, async (t) => {
    const f = fixture(t);
    const g = await f.launch([
      process.execPath,
      '-e',
      "process.on('SIGINT',()=>{});console.log('ready');setTimeout(()=>process.exit(0),350)",
    ]);
    await until(() => readFileSync(f.output, 'utf8').includes('ready'));
    const fields = readFileSync(`/proc/${g.command!.pid}/stat`, 'utf8').split(') ').at(-1)!.split(/\s+/);
    const waiter = Number(fields[1]);
    const aux = auxiliaryStamps(g);
    const target = aux.find((s) => (role === 'waiter' ? s.pid === waiter : s.pid !== waiter))!;
    assert.ok(target);
    process.kill(target.pid, 'SIGKILL');
    if (role === 'forwarder') {
      assert.equal(await g.signal('SIGINT'), false);
      await g.exited;
      assert.equal(g.shellDiagnostic?.status, 0);
      assert.equal(proveGroupGone(g.scope!, g.command!, [g.helper]), true);
    } else {
      let ended = false;
      g.exited.then(() => {
        ended = true;
      });
      await sleep(450);
      assert.equal(ended, false);
      assert.equal(processState(g.command!), 'dead');
      assert.equal(await g.signal('SIGINT'), true);
      assert.equal(await g.signal('SIGKILL'), false);
      await g.exited;
      assert.equal(g.shellDiagnostic, null);
    }
  });
}

for (const [mode, shell] of [
  ['bash-sh', { path: '/bin/bash', argv0: '/bin/sh' }],
  ['bash-posix', { path: '/bin/bash', args: ['--posix'] }],
] as const) {
  test(
    `portable ${mode} exec audit covers original env bytes and all argv phases`,
    { skip: skip || process.arch !== 'x64' || !existsSync('/usr/bin/python3') || !existsSync('/bin/bash') },
    () => {
      const result = spawnSync(
        '/usr/bin/python3',
        ['tests/int/b3ar1-env-audit.py', process.execPath, 'tests/int/b3ar1-env-driver.mjs', mode],
        { encoding: 'utf8', timeout: 15000 }
      );
      assert.equal(result.status, 0, result.stderr);
      const count = JSON.parse(result.stdout);
      assert.equal(count.leaderExecs, 2);
      assert.equal(count.failedENOENTSyscalls, 1);
      assert.equal(count.harnessExecs, 1);
    }
  );
  test(
    `portable ${mode} EOF before RUN cannot launch or reopen`,
    { skip: skip || !existsSync('/bin/bash') },
    async (t) => {
      const f = fixture(t),
        c = spawnRawLeader(
          shell.path,
          [
            ...('args' in shell ? shell.args : []),
            '-c',
            GROUP_LEADER_SCRIPT,
            'synthetic',
            '/bin/sh',
            '-c',
            'touch forbidden',
          ],
          { cwd: f.home, env: {}, argv0: 'argv0' in shell ? shell.argv0 : undefined }
        );
      const input = c.stdio[3] as NodeJS.WritableStream;
      input.on('error', () => {});
      let replies = '';
      (c.stdio[4] as NodeJS.ReadableStream).on('data', (b) => {
        replies += b;
      });
      const done = once(c, 'exit');
      t.after(async () => {
        if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
        input.end();
        await done;
      });
      await until(() => replies.includes('READY'));
      input.end();
      assert.equal(
        await new Promise((resolve) => input.write('RUN\n', (e) => resolve((e as NodeJS.ErrnoException)?.code))),
        'ERR_STREAM_WRITE_AFTER_END'
      );
      assert.equal((await done)[0], 0);
      assert.equal(replies.includes('STARTED'), false);
      assert.equal(existsSync(join(f.home, 'forbidden')), false);
    }
  );
  test(
    `portable ${mode} exported function and signal dispositions match direct launch`,
    { skip: skip || !existsSync('/bin/bash') || !existsSync('/usr/bin/python3') },
    async (t) => {
      const f = fixture(t),
        fd = openSync(f.output, 'a', 0o600);
      let g: GroupProcess | undefined;
      try {
        g = await launchShellGroup(
          {
            runId: 'synthetic-portable-function',
            argv: ['/bin/bash', '--noprofile', '--norc', '-c', 'sleep .1; hud_synthetic'],
            cwd: f.home,
            env: { BASH_ENV: '', ENV: '', 'BASH_FUNC_hud_synthetic%%': '() { printf synthetic-ok; }' },
            stdin: null,
            stdoutFd: fd,
            stderrFd: fd,
          },
          shell
        );
        await g.exited;
        assert.equal(readFileSync(f.output, 'utf8'), 'synthetic-ok');
        const code =
          "import signal,json,time;print(json.dumps(['handler' if callable(signal.getsignal(s)) else int(signal.getsignal(s)) for s in [signal.SIGINT,signal.SIGQUIT,signal.SIGTERM]]),flush=True);time.sleep(.1)";
        const expected = spawnSync('/usr/bin/python3', ['-c', code], { encoding: 'utf8' });
        assert.equal(expected.status, 0);
        g = await launchShellGroup(
          {
            runId: 'synthetic-portable-signals',
            argv: ['/usr/bin/python3', '-c', code],
            cwd: f.home,
            env: {},
            stdin: null,
            stdoutFd: fd,
            stderrFd: fd,
          },
          shell
        );
        await g.exited;
        assert.equal(readFileSync(f.output, 'utf8'), 'synthetic-ok' + expected.stdout);
      } finally {
        if (g) {
          for (const st of [g.command, ...auxiliaryStamps(g), g.helper])
            if (st && processState(st) === 'alive') {
              try {
                process.kill(st.pid, 'SIGKILL');
              } catch {}
            }
          g.close();
          await g.exited;
        }
        closeSync(fd);
      }
    }
  );
}
