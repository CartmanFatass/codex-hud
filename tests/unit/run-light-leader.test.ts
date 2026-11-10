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
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import nodeTest, { before, type TestContext, type TestOptions } from 'node:test';
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
  sameStamp,
  type GroupLaunchOptions,
  type GroupProcess,
} from '../../src/core/run/process.js';
import type { GroupExit, ProcessStamp } from '../../src/core/types/supervision.js';
import { seedRun } from '../run/fixtures.js';

function test(name: string, options: TestOptions, body: (t: TestContext) => void | Promise<void>) {
  return nodeTest(name, { timeout: 20000, ...options }, body);
}

function spawnRawLeader(t: TestContext, command: string, args: string[], options: Parameters<typeof spawn>[2]) {
  const f = fixture(t);
  const pipe = createGroupPipe();
  let child;
  try {
    child = spawn(command, args, {
      cwd: f.home,
      ...options,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'ignore', pipe.read, pipe.write],
    });
  } finally {
    pipe.close();
  }
  f.ownChild(child);
  let replies = '';
  (child.stdio[4] as NodeJS.ReadableStream).on('data', (b) => {
    replies += b;
    if (/\bWAIT [0-9]+\n/.test(replies)) (child.stdio[3] as NodeJS.WritableStream).end();
  });
  child.stdin!.on('error', () => {});
  return child;
}

let profile: DiagnosticProfile;
before(() => {
  profile = validateStartup();
});
const STDERR_SENTINEL = 'synthetic-workload-stderr\n';

const skip = process.platform !== 'linux';
const actor = { kind: 'trusted_local' as const, uid: process.getuid!(), invocationId: 'synthetic-light-leader' };
async function settleCleanup(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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

const fixtures = new WeakMap<TestContext, ReturnType<typeof createFixture>>();
function fixture(t: TestContext) {
  let f = fixtures.get(t);
  if (!f) {
    f = createFixture(t);
    fixtures.set(t, f);
  }
  return f;
}

function createFixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'hud-light-leader-'));
  const output = join(home, 'output');
  const fd = openSync(output, 'a', 0o600);
  const error = join(home, 'error');
  const errorFd = openSync(error, 'a', 0o600);
  const groups: GroupProcess[] = [];
  const sessions = new Set<number>();
  const owned = new Map<number, { stamp: ProcessStamp; argv: Buffer }>();
  const raw: ReturnType<typeof spawn>[] = [];
  const remember = (pid: number, sid?: number) => {
    const p = readProcess(pid);
    try {
      if (p && (sid === undefined || p.sid === sid) && readlinkSync(`/proc/${pid}/cwd`) === home) {
        owned.set(pid, { stamp: p.stamp, argv: readFileSync(`/proc/${pid}/cmdline`) });
        if (p.sid === pid && p.pgid === pid) sessions.add(pid);
      }
    } catch {}
  };
  const anchored = (sid: number) =>
    [...owned.values()].some(({ stamp }) => {
      const p = readProcess(stamp.pid);
      return p && p.sid === sid && sameStamp(p.stamp, stamp);
    });
  const retainSession = (sid: number) => {
    // A numeric SID is never evidence by itself, including when processing an
    // untrusted/malformed protocol PID. Require an independently stamped member.
    if (!sessions.has(sid) || !anchored(sid)) return;
    for (const name of readdirSync('/proc')) {
      if (/^\d+$/.test(name)) remember(Number(name), sid);
    }
  };
  const cleanup = () => {
    // A launch may fail before it returns a GroupProcess. Discover only our direct
    // children in this fixture's private cwd, with the exact synthetic leader argv.
    const children = readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8').trim().split(/\s+/);
    for (const child of children) {
      const pid = Number(child);
      try {
        const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (argv.includes(GROUP_LEADER_SCRIPT) || argv.includes('/tests/run/group-helper.js')) remember(pid);
      } catch {}
    }
    // Include grandchildren/decoy PGIDs even after leader death, but never use
    // a stale numeric SID after its last independently stamped anchor is gone.
    for (const sid of sessions) {
      if (anchored(sid)) retainSession(sid);
      else sessions.delete(sid);
    }
    for (const { stamp, argv } of owned.values()) {
      const p = readProcess(stamp.pid);
      try {
        if (
          !p ||
          !sameStamp(p.stamp, stamp) ||
          readlinkSync(`/proc/${stamp.pid}/cwd`) !== home ||
          !readFileSync(`/proc/${stamp.pid}/cmdline`).equals(argv)
        )
          continue;
        // Session membership cannot be joined from outside. A current stamped
        // member anchors the numeric PGID even when the original leader is dead.
        process.kill(sessions.has(p.sid) ? -p.pgid : stamp.pid, 'SIGKILL');
      } catch {}
    }
    for (const g of groups) g.close();
    for (const child of raw) {
      child.stdin?.destroy();
      (child.stdio[3] as NodeJS.WritableStream | null)?.end();
      child.stdout?.destroy();
      child.stderr?.destroy();
      (child.stdio[4] as Readable).destroy();
    }
  };
  const ownChildProcessGroup = (g: GroupProcess) => {
    groups.push(g);
    remember(g.helper.pid);
    if (g.command) remember(g.command.pid);
    for (const stamp of auxiliaryStamps(g)) remember(stamp.pid);
    if (t.signal.aborted) cleanup();
  };
  t.signal.addEventListener('abort', cleanup, { once: true });
  t.after(async () => {
    cleanup();
    // Never turn a timeout's cleanup into another unbounded wait.
    await settleCleanup(
      Promise.all([
        ...groups.map((g) => g.exited),
        ...raw.map((c) => (c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : once(c, 'exit'))),
      ])
    );
    t.signal.removeEventListener('abort', cleanup);
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
    stdoutFd: fd,
    stderrFd: errorFd,
    cleanup,
    ownChildProcessGroup,
    ownChild(child: ReturnType<typeof spawn>) {
      raw.push(child);
      remember(child.pid!);
      let pending = '';
      // Installed before callers' reply listeners: retain independent anchors at
      // STARTED/WAITER, and orphan descendants at WAIT BEFORE auto-closing fd3.
      (child.stdio[4] as Readable).on('data', (chunk: Buffer) => {
        pending += chunk.toString();
        const lines = pending.split('\n');
        pending = lines.pop()!;
        let retain = false;
        for (const line of lines) {
          const member = /^(?:STARTED|WAITER) ([1-9][0-9]*)$/.exec(line);
          if (member && sessions.has(child.pid!) && anchored(child.pid!)) remember(Number(member[1]), child.pid!);
          retain ||= member !== null || /^WAIT [0-9]+$/.test(line);
        }
        if (retain) retainSession(child.pid!);
      });
      if (t.signal.aborted) cleanup();
    },
    async launcher(options: GroupLaunchOptions, shell?: Parameters<typeof launchShellGroup>[1]) {
      const g = await (shell ? launchShellGroup(options, shell) : launchGroup(options));
      ownChildProcessGroup(g);
      return g;
    },
    async launch(argv: string[], env?: NodeJS.ProcessEnv) {
      return this.launcher({
        runId: 'synthetic-light',
        argv,
        cwd: home,
        stdin: Buffer.from('$(touch forbidden);\n'),
        env,
        stdoutFd: fd,
        stderrFd: errorFd,
      });
    },
  };
}

const portableShells = [
  { path: '/bin/sh' },
  { path: '/bin/bash', argv0: '/bin/sh' },
  { path: '/bin/bash', args: ['--posix'] },
];

// FIONREAD observes that read consumed the prefix, without stealing any bytes.
function queuedBytes(fd: number) {
  const p = spawnSync(
    '/usr/bin/python3',
    ['-c', 'import array,fcntl,termios; n=array.array("i",[0]); fcntl.ioctl(3,termios.FIONREAD,n); print(n[0])'],
    { stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8', timeout: 2000 }
  );
  assert.equal(p.status, 0, p.stderr);
  return Number(p.stdout.trim());
}

for (const shell of portableShells) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    test(
      `mid-read ${signal} preserves DONE bytes under ${JSON.stringify(shell)}`,
      { skip: skip || !existsSync(shell.path) || !existsSync('/usr/bin/python3') },
      async (t) => {
        const f = fixture(t),
          pipe = createGroupPipe();
        t.after(() => pipe.close());
        // Only the writer is replaced: drive the real protocol reader with a
        // fragmented completion, holding the remainder until after the signal.
        const script = GROUP_LEADER_SCRIPT.replace(` printf '%s\\n' "DONE $status" >&7`, ':');
        assert.notEqual(script, GROUP_LEADER_SCRIPT);
        const c = spawn(shell.path, [...(shell.args ?? []), '-c', script, 'synthetic', '/bin/false'], {
          argv0: shell.argv0,
          detached: true,
          cwd: f.home,
          env: {},
          stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe', 'ignore', pipe.read, pipe.write],
        });
        f.ownChild(c);
        let replies = '';
        const input = c.stdio[3] as NodeJS.WritableStream;
        input.on('error', () => {});
        (c.stdio[4] as NodeJS.ReadableStream).on('data', (b) => {
          replies += b;
        });
        const done = once(c, 'exit');
        await until(() => replies.includes('READY'));
        input.write('RUN\n');
        await until(() => replies.includes('STARTED'));
        writeSync(pipe.write, 'DONE ');
        await until(() => queuedBytes(pipe.read) === 0);
        c.kill(signal);
        // A bounded scheduling turn lets the old caught-signal path return from
        // read before the tail arrives; ignored signals cannot interrupt read.
        await sleep(30);
        writeSync(pipe.write, '1\n');
        await until(() => /WAIT 1|REFUSED/.test(replies));
        assert.match(replies, /WAIT 1\n/);
        assert.equal(replies.includes('REFUSED'), false);
        input.end();
        assert.equal((await done)[0], 0);
      }
    );
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    test(
      `mid-read ${signal} preserves forwarder control bytes under ${JSON.stringify(shell)}`,
      { skip: skip || !existsSync(shell.path) || !existsSync('/usr/bin/python3') },
      async (t) => {
        const f = fixture(t),
          events = createGroupPipe(),
          control = createGroupPipe();
        let controlClosed = false;
        const closeControl = () => {
          if (!controlClosed) {
            controlClosed = true;
            control.close();
          }
        };
        t.after(() => {
          events.close();
          closeControl();
        });
        const script = GROUP_LEADER_SCRIPT.replace(` printf '%s\\n' "DONE $status" >&7`, ':');
        assert.notEqual(script, GROUP_LEADER_SCRIPT);
        const c = spawn(shell.path, [...(shell.args ?? []), '-c', script, 'synthetic', '/bin/false'], {
          argv0: shell.argv0,
          detached: true,
          cwd: f.home,
          env: {},
          stdio: ['ignore', 'ignore', 'ignore', control.read, 'pipe', 'ignore', events.read, events.write],
        });
        f.ownChild(c);
        let replies = '';
        (c.stdio[4] as NodeJS.ReadableStream).on('data', (b) => {
          replies += b;
        });
        const done = once(c, 'exit');
        await until(() => replies.includes('READY'));
        writeSync(control.write, 'RUN\n');
        await until(() => replies.includes('STARTED') && replies.includes('WAITER'));
        const waiter = Number(/WAITER ([0-9]+)/.exec(replies)![1]);
        const reader = readFileSync(`/proc/${c.pid}/task/${c.pid}/children`, 'utf8')
          .trim()
          .split(/\s+/)
          .map(Number)
          .find((pid) => pid !== waiter)!;
        assert.ok(reader);
        writeSync(control.write, 'TERM ');
        await until(() => queuedBytes(control.read) === 0);
        process.kill(reader, signal);
        await sleep(30);
        writeSync(control.write, '1\n');
        await until(() => /ACK 1|REFUSED/.test(replies));
        assert.match(replies, /ACK 1\n/);
        assert.equal(replies.includes('REFUSED'), false);
        writeSync(events.write, 'DONE 1\n');
        await until(() => replies.includes('WAIT 1'));
        closeControl();
        assert.equal((await done)[0], 0);
      }
    );
  }
  test(
    `repeated group signals preserve exact wait status at stopped-waiter exit boundary ${JSON.stringify(shell)}`,
    { skip: skip || !existsSync(shell.path) },
    async (t) => {
      const f = fixture(t);
      const g = await f.launcher(
        {
          runId: 'synthetic-wait-boundary',
          argv: [
            process.execPath,
            '-e',
            "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});console.log('ready');const fs=require('fs');const timer=setInterval(()=>{if(fs.existsSync('release')){clearInterval(timer);process.exit(3)}},10)",
          ],
          cwd: f.home,
          env: {},
          stdin: null,
          stdoutFd: f.stdoutFd,
          stderrFd: f.stderrFd,
        },
        shell
      );
      await until(() => readFileSync(f.output, 'utf8').includes('ready'));
      const waiter = readProcess(readProcess(g.command!.pid)!.ppid)!.stamp;
      const signalWaiter = (signal: 'SIGSTOP' | 'SIGCONT') => {
        const current = readProcess(waiter.pid)!;
        assert.ok(sameStamp(current.stamp, waiter));
        assert.equal(current.ppid, g.helper.pid);
        assert.equal(current.sid, g.scope!.sid);
        assert.equal(readlinkSync(`/proc/${waiter.pid}/cwd`), f.home);
        assert.ok(readFileSync(`/proc/${waiter.pid}/cmdline`, 'utf8').includes(GROUP_LEADER_SCRIPT));
        process.kill(waiter.pid, signal);
      };
      await until(() => /wait|sigsuspend/.test(readFileSync(`/proc/${waiter.pid}/wchan`, 'utf8')));
      for (let n = 0; n < 3; n++) {
        assert.equal(await g.signal('SIGINT'), true);
        assert.equal(await g.signal('SIGTERM'), true);
      }
      // Force child exit and both pending signals to coincide with resuming a
      // real wait. No wait result or completion frame is replaced by the test.
      signalWaiter('SIGSTOP');
      await until(() => readProcess(waiter.pid)?.state === 'T');
      for (let n = 0; n < 2; n++) {
        assert.equal(await g.signal('SIGINT'), true);
        assert.equal(await g.signal('SIGTERM'), true);
      }
      writeFileSync(join(f.home, 'release'), 'go');
      await until(() => processState(g.command!) === 'dead');
      signalWaiter('SIGCONT');
      const exit = await g.exited;
      assert.equal(g.shellDiagnostic?.status, 3);
      assert.deepEqual(
        { source: exit.source, code: exit.code, signal: exit.signal },
        { source: 'native_unknown', code: null, signal: null }
      );
      assert.equal(proveGroupGone(g.scope!, g.command!, [g.helper]), true);
    }
  );
  test(
    `signals after real wait returns preserve exact completion status ${JSON.stringify(shell)}`,
    { skip: skip || !existsSync(shell.path) },
    async (t) => {
      const f = fixture(t);
      // Preserve the real wait and its captured status. Deliver actual group
      // signals before the old interrupted-loop decision, once only. Whether an
      // old retry retains3 depends on Bash's internal async-job cache; this is
      // real post-wait ordering coverage, not a fabricated bad return value.
      const script = GROUP_LEADER_SCRIPT.replace(
        /^( *)status=\$\?$/m,
        '$&\n$1if [ "${probe_signalled:-0}" = 0 ]; then probe_signalled=1; kill -s INT 0; kill -s TERM 0; fi'
      );
      assert.notEqual(script, GROUP_LEADER_SCRIPT);
      const c = spawnRawLeader(
        t,
        shell.path,
        [
          ...(shell.args ?? []),
          '-c',
          script,
          'synthetic',
          '/usr/bin/env',
          '--default-signal=INT,QUIT',
          process.execPath,
          '-e',
          "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});console.log('ready');const fs=require('fs');const timer=setInterval(()=>{if(fs.existsSync('release')){clearInterval(timer);process.exit(3)}},10)",
        ],
        { argv0: shell.argv0, env: {} }
      );
      let replies = '',
        output = '';
      (c.stdio[4] as NodeJS.ReadableStream).on('data', (b) => {
        replies += b;
      });
      c.stdout!.on('data', (b) => {
        output += b;
      });
      const input = c.stdio[3] as NodeJS.WritableStream;
      input.on('error', () => {});
      const done = once(c, 'exit');
      await until(() => replies.includes('READY'));
      input.write('RUN\n');
      await until(() => replies.includes('WAITER') && output.includes('ready'));
      const waiter = Number(/WAITER ([0-9]+)/.exec(replies)![1]);
      await until(() => /wait|sigsuspend/.test(readFileSync(`/proc/${waiter}/wchan`, 'utf8')));
      for (let seq = 1; seq <= 4; seq++) {
        input.write(`${seq % 2 ? 'INT' : 'TERM'} ${seq}\n`);
        await until(() => replies.includes(`ACK ${seq}\n`));
      }
      writeFileSync(join(f.home, 'release'), 'go');
      await until(() => /WAIT [0-9]+\n/.test(replies));
      assert.match(replies, /WAIT 3\n/);
      assert.equal((await done)[0], 0);
    }
  );
  for (const observation of ['before', 'after'] as const) {
    test(
      `waiter ignore is post-fork and preserves ${observation}-ignore workload and exec defaults ${JSON.stringify(shell)}`,
      { skip: skip || !existsSync(shell.path) || !existsSync('/usr/bin/python3') },
      async (t) => {
        const f = fixture(t);
        const script =
          observation === 'before'
            ? GROUP_LEADER_SCRIPT.replace(
                ' command=$!\n',
                ' command=$!\n while [ ! -f waiter-release ]; do /bin/sleep .01; done\n'
              )
            : GROUP_LEADER_SCRIPT;
        const defaults =
          'print(json.dumps([signal.getsignal(signal.SIGINT)==signal.default_int_handler,signal.getsignal(signal.SIGQUIT)==signal.SIG_DFL,signal.getsignal(signal.SIGTERM)==signal.SIG_DFL]),flush=True)';
        const imports = 'import os,signal,json,time\n';
        const observerGate = observation === 'after' ? "while not os.path.exists('observe'): time.sleep(.01)\n" : '';
        const descendant = `${imports}${defaults}\nwhile not os.path.exists('exit'): time.sleep(.01)\n`;
        const code = `${imports}${observerGate}${defaults}\nos.execv('/usr/bin/python3',['/usr/bin/python3','-c',${JSON.stringify(descendant)}])`;
        const c = spawnRawLeader(
          t,
          shell.path,
          [
            ...(shell.args ?? []),
            '-c',
            script,
            'synthetic',
            '/usr/bin/env',
            '--default-signal=INT,QUIT',
            '/usr/bin/python3',
            '-c',
            code,
          ],
          { argv0: shell.argv0, env: {} }
        );
        let replies = '',
          output = '';
        (c.stdio[4] as NodeJS.ReadableStream).on('data', (b) => {
          replies += b;
        });
        c.stdout!.on('data', (b) => {
          output += b;
        });
        const input = c.stdio[3] as NodeJS.WritableStream;
        input.on('error', () => {});
        const done = once(c, 'exit');
        await until(() => replies.includes('READY'));
        input.write('RUN\n');
        if (observation === 'before') {
          await until(() => output.trim().split('\n').length === 2);
          writeFileSync(join(f.home, 'waiter-release'), 'go');
        }
        await until(() => replies.includes('WAITER') && replies.includes('STARTED'));
        const waiter = Number(/WAITER ([0-9]+)/.exec(replies)![1]);
        const mask = BigInt(`0x${/^SigIgn:\s*([0-9a-f]+)/m.exec(readFileSync(`/proc/${waiter}/status`, 'utf8'))![1]}`);
        const intTerm = (1n << 1n) | (1n << 14n);
        assert.equal(mask & intTerm, intTerm);
        if (observation === 'after') writeFileSync(join(f.home, 'observe'), 'go');
        await until(() => output.trim().split('\n').length === 2);
        assert.deepEqual(
          output
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)),
          [
            [true, true, true],
            [true, true, true],
          ]
        );
        writeFileSync(join(f.home, 'exit'), 'go');
        await until(() => replies.includes('WAIT 0'));
        assert.equal((await done)[0], 0);
      }
    );
  }
  test(
    `terminal-style group SIGINT reaches default workload ${JSON.stringify(shell)}`,
    { skip: skip || !existsSync(shell.path) || !existsSync('/usr/bin/python3') },
    async (t) => {
      const f = fixture(t);
      const g = await f.launcher(
        {
          runId: 'synthetic-group-ctrl-c',
          argv: ['/usr/bin/python3', '-c', "import time;print('ready',flush=True);time.sleep(60)"],
          cwd: f.home,
          env: {},
          stdin: null,
          stdoutFd: f.stdoutFd,
          stderrFd: f.stderrFd,
        },
        shell
      );
      await until(() => readFileSync(f.output, 'utf8').includes('ready'));
      const leader = readProcess(g.helper.pid)!;
      assert.ok(sameStamp(leader.stamp, g.helper));
      assert.equal(leader.pgid, g.scope!.pgid);
      assert.equal(leader.sid, g.scope!.sid);
      assert.equal(leader.pgid, g.helper.pid);
      assert.equal(leader.sid, g.helper.pid);
      assert.equal(readlinkSync(`/proc/${leader.stamp.pid}/cwd`), f.home);
      assert.ok(readFileSync(`/proc/${leader.stamp.pid}/cmdline`, 'utf8').includes(GROUP_LEADER_SCRIPT));
      // TTY Ctrl-C delivers SIGINT to the foreground PGID. Exercise that kernel
      // delivery directly, without requiring a real terminal or tmux session.
      process.kill(-leader.pgid, 'SIGINT');
      assert.equal((await g.exited).source, 'native_unknown');
      assert.equal(g.shellDiagnostic?.status, 130);
    }
  );
  for (const fork of ['before', 'after'] as const) {
    test(
      `reader ignores do not leak to ${fork}-ignore workload or exec descendant ${JSON.stringify(shell)}`,
      { skip: skip || !existsSync(shell.path) || !existsSync('/usr/bin/python3') },
      async (t) => {
        const f = fixture(t);
        const waitForRelease = 'while [ ! -f release ]; do /bin/sleep .01; done';
        // Force both sides of the fork ordering, rather than trusting scheduling.
        const script =
          fork === 'after'
            ? GROUP_LEADER_SCRIPT.replace(' "$@" <&5', ` ${waitForRelease}\n "$@" <&5`)
            : GROUP_LEADER_SCRIPT.replace(
                '# Only this reader ignores signals',
                `${waitForRelease}\n# Only this reader ignores signals`
              );
        const observation =
          'import os,signal,json; print(json.dumps([int(signal.getsignal(s)==signal.SIG_IGN) for s in [signal.SIGINT,signal.SIGQUIT,signal.SIGTERM]]),flush=True)';
        const code = `${observation}; os.execv('/usr/bin/python3',['/usr/bin/python3','-c',${JSON.stringify(observation)}])`;
        const c = spawnRawLeader(
          t,
          shell.path,
          [
            ...(shell.args ?? []),
            '-c',
            script,
            'synthetic',
            '/usr/bin/env',
            '--default-signal=INT,QUIT',
            '/usr/bin/python3',
            '-c',
            code,
          ],
          { argv0: shell.argv0, env: {} }
        );
        let replies = '',
          output = '';
        (c.stdio[4] as NodeJS.ReadableStream).on('data', (b) => {
          replies += b;
        });
        c.stdout!.on('data', (b) => {
          output += b;
        });
        const input = c.stdio[3] as NodeJS.WritableStream;
        input.on('error', () => {});
        const done = once(c, 'exit');
        await until(() => replies.includes('READY'));
        input.write('RUN\n');
        if (fork === 'after') {
          await until(() => {
            const status = readFileSync(`/proc/${c.pid}/status`, 'utf8');
            const mask = BigInt(`0x${/^SigIgn:\s*([0-9a-f]+)/m.exec(status)![1]}`);
            return (mask & (1n << 14n)) !== 0n;
          });
        } else {
          await until(() => output.includes('[0, 0, 0]'));
        }
        writeFileSync(join(f.home, 'release'), 'go');
        assert.equal((await done)[0], 0);
        assert.deepEqual(
          output
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)),
          [
            [0, 0, 0],
            [0, 0, 0],
          ]
        );
      }
    );
  }
}

test('fixture cleanup owns a group even when production startup rejects before returning it', { skip }, async (t) => {
  const f = fixture(t),
    shell = join(f.home, 'startup-shell');
  // The synthetic shell accepts RUN but never confirms exec. Production must
  // retain its ordinary startup refusal; only the fixture is allowed to kill it.
  writeFileSync(
    shell,
    '#!/bin/sh\nprintf "READY\\n" >&4\nIFS= read -r run <&3\nprintf "%s" "$$" > startup.pid\nsleep 60\n',
    { mode: 0o700 }
  );
  const fd = openSync(f.output, 'a', 0o600);
  try {
    const starting = f.launcher(
      {
        runId: 'synthetic-startup',
        argv: ['/bin/false'],
        cwd: f.home,
        stdin: null,
        stdoutFd: fd,
        stderrFd: fd,
        env: {},
      },
      { path: shell }
    );
    await until(() => existsSync(join(f.home, 'startup.pid')));
    const stamp = readProcess(Number(readFileSync(join(f.home, 'startup.pid'), 'utf8')))!.stamp;
    await assert.rejects(starting, /group startup unconfirmed/);
    assert.equal(processState(stamp), 'alive');
    f.cleanup();
    await until(() => processState(stamp) === 'dead');
    assert.equal(processState(stamp), 'dead');
  } finally {
    closeSync(fd);
  }
});

if (process.env.HUD_LIGHT_CLEANUP_PROBE) {
  test('fixture cleanup probe', { skip, timeout: 3000 }, async (t) => {
    const f = fixture(t);
    const c = spawnRawLeader(
      t,
      '/bin/sh',
      [
        '-c',
        GROUP_LEADER_SCRIPT,
        'synthetic',
        '/usr/bin/env',
        '--default-signal=INT,QUIT',
        process.execPath,
        '-e',
        `const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit'});require('fs').writeFileSync('grandchild',String(c.pid));console.log('probe-ready');setTimeout(()=>{},60000)`,
      ],
      { env: {} }
    );
    let replies = '',
      output = '';
    (c.stdio[4] as NodeJS.ReadableStream).on('data', (b) => {
      replies += b;
    });
    c.stdout!.on('data', (b) => {
      output += b;
    });
    const input = c.stdio[3] as NodeJS.WritableStream;
    input.on('error', () => {});
    await until(() => replies.includes('READY'));
    input.write('RUN\n');
    await until(() => replies.includes('STARTED') && replies.includes('WAITER') && output.includes('probe-ready'));
    const pids = [
      c.pid!,
      Number(/STARTED ([0-9]+)/.exec(replies)![1]),
      Number(readFileSync(join(f.home, 'grandchild'), 'utf8')),
    ];
    writeFileSync(
      process.env.HUD_LIGHT_CLEANUP_RECORD!,
      JSON.stringify(
        pids.map((pid) => ({
          stamp: readProcess(pid)!.stamp,
          cwd: readlinkSync(`/proc/${pid}/cwd`),
          argv: readFileSync(`/proc/${pid}/cmdline`, 'utf8'),
        }))
      )
    );
    if (process.env.HUD_LIGHT_CLEANUP_PROBE!.startsWith('leader-')) {
      const leader = readProcess(c.pid!)!;
      assert.equal(leader.sid, c.pid);
      assert.equal(leader.pgid, c.pid);
      assert.equal(readlinkSync(`/proc/${c.pid}/cwd`), f.home);
      assert.ok(readFileSync(`/proc/${c.pid}/cmdline`, 'utf8').includes(GROUP_LEADER_SCRIPT));
      const reaped = once(c, 'exit');
      c.kill('SIGKILL');
      await reaped;
      assert.equal(processState(leader.stamp), 'dead');
      for (const pid of pids.slice(1)) assert.equal(processState(readProcess(pid)!.stamp), 'alive');
    }
    if (process.env.HUD_LIGHT_CLEANUP_PROBE!.endsWith('failure')) assert.fail('synthetic fixture failure');
    await new Promise<void>(() => {});
  });
}
for (const mode of ['failure', 'timeout', 'leader-failure', 'leader-timeout'] as const) {
  test(`fixture cleanup kills its entire synthetic group after ${mode}`, { skip }, async (t) => {
    const f = fixture(t),
      record = join(f.home, 'owned.json');
    const home = mkdtempSync(join(f.home, 'child-home-'));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      HUD_HOME: join(home, 'hud'),
      CODEX_HOME: join(home, 'codex'),
      HUD_LIGHT_CLEANUP_PROBE: mode,
      HUD_LIGHT_CLEANUP_RECORD: record,
    };
    for (const key of ['NODE_TEST_CONTEXT', 'NO_COLOR', 'FORCE_COLOR', 'HUD_SETTINGS_PATH', 'CODEX_HUD_SETTINGS_PATH'])
      delete env[key];
    const p = spawnSync(
      process.execPath,
      [
        '--test',
        '--test-reporter=tap',
        '--test-name-pattern=^fixture cleanup probe$',
        new URL(import.meta.url).pathname,
      ],
      { env, encoding: 'utf8', timeout: 8000 }
    );
    const owned = (existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : []) as {
      stamp: ProcessStamp;
      cwd: string;
      argv: string;
    }[];
    // Install fallback cleanup before asserting the worker's result: an external
    // guard failure must not leak the group whose identity was already recorded.
    t.after(() => {
      for (const { stamp, cwd, argv } of owned) {
        const current = readProcess(stamp.pid);
        try {
          if (
            current &&
            sameStamp(current.stamp, stamp) &&
            current.sid === owned[0]!.stamp.pid &&
            [cwd, `${cwd} (deleted)`].includes(readlinkSync(`/proc/${stamp.pid}/cwd`)) &&
            readFileSync(`/proc/${stamp.pid}/cmdline`, 'utf8') === argv
          )
            process.kill(-current.pgid, 'SIGKILL');
        } catch {
          /* A successful cleanup already removed the process. */
        }
      }
    });
    assert.equal(p.error, undefined, p.stderr);
    assert.equal(p.status, 1, p.stdout + p.stderr);
    assert.match(p.stdout + p.stderr, mode.endsWith('failure') ? /synthetic fixture failure/ : /testTimeoutFailure/);
    assert.equal(owned.length, 3, 'worker recorded leader, workload and grandchild');
    for (const { stamp } of owned) assert.equal(processState(stamp), 'dead');
  });
}

test('fixture cleanup retains orphan ownership after normal raw completion', { skip }, async (t) => {
  const f = fixture(t);
  const c = spawnRawLeader(
    t,
    '/bin/sh',
    [
      '-c',
      GROUP_LEADER_SCRIPT,
      'synthetic',
      '/usr/bin/env',
      '--default-signal=INT,QUIT',
      process.execPath,
      '-e',
      "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit'});require('fs').writeFileSync('grandchild',String(c.pid));console.log('orphan-ready');setTimeout(()=>process.exit(0),100)",
    ],
    { env: {} }
  );
  let replies = '';
  (c.stdio[4] as NodeJS.ReadableStream).on('data', (b) => {
    replies += b;
  });
  const input = c.stdio[3] as NodeJS.WritableStream;
  input.on('error', () => {});
  const done = once(c, 'exit');
  await until(() => replies.includes('READY'));
  input.write('RUN\n');
  await until(() => existsSync(join(f.home, 'grandchild')));
  const grandchild = readProcess(Number(readFileSync(join(f.home, 'grandchild'), 'utf8')))!;
  const argv = readFileSync(`/proc/${grandchild.stamp.pid}/cmdline`);
  // An old-cleanup negative control must not leave its deliberately orphaned
  // grandchild behind when the assertion fails and the fixture dir is removed.
  t.after(async () => {
    const current = readProcess(grandchild.stamp.pid);
    try {
      if (
        current &&
        sameStamp(current.stamp, grandchild.stamp) &&
        current.sid === c.pid &&
        [f.home, `${f.home} (deleted)`].includes(readlinkSync(`/proc/${current.stamp.pid}/cwd`)) &&
        readFileSync(`/proc/${current.stamp.pid}/cmdline`).equals(argv)
      )
        process.kill(-current.pgid, 'SIGKILL');
    } catch {
      /* Already reaped. */
    }
    await until(() => processState(grandchild.stamp) === 'dead');
  });
  assert.equal((await done)[0], 0);
  assert.match(replies, /WAIT 0\n/);
  assert.equal(processState(grandchild.stamp), 'alive');
  f.cleanup();
  await until(() => processState(grandchild.stamp) === 'dead');
  assert.equal(processState(grandchild.stamp), 'dead');
});

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
      group = await f.launcher(o);
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
      f.ownChildProcessGroup(group);
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
    f.ownChildProcessGroup(g);
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
      t,
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

test('light leader EOF before RUN launches nothing and never reopens submission', { skip }, async (t) => {
  const c = spawnRawLeader(t, '/bin/sh', ['-c', GROUP_LEADER_SCRIPT, 'synthetic', '/bin/false'], {
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
      // KILL acknowledgement is not kernel scheduling of every group member's
      // death. Observe that transition, keeping the original dead assertions.
      await until(() => stamps.every((stamp) => processState(stamp) === 'dead'));
      for (const stamp of stamps) assert.equal(processState(stamp), 'dead');
      assert.equal(after.receipt?.native_exit ?? null, null);
    } finally {
      f.cleanup();
      await settleCleanup(running.catch(() => {}));
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
  const c = spawnRawLeader(t, '/bin/sh', ['-c', script, 'synthetic', '/bin/false'], {
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
    const parentStamp = readProcess(parent.pid!)!.stamp;
    const parentArgv = Buffer.from([process.execPath, '-e', 'setTimeout(()=>{},60000)', ''].join('\0'));
    const parentCwd = process.cwd();
    t.after(async () => {
      const current = readProcess(parent.pid!);
      try {
        if (
          current &&
          sameStamp(current.stamp, parentStamp) &&
          readlinkSync(`/proc/${parent.pid}/cwd`) === parentCwd &&
          readFileSync(`/proc/${parent.pid}/cmdline`).equals(parentArgv)
        )
          parent.kill('SIGKILL');
      } catch {
        /* Already reaped. */
      }
      await settleCleanup(parentDone);
    });
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
  const c = spawnRawLeader(t, '/bin/sh', ['-c', script, 'synthetic', '/bin/sh', '-c', 'sleep .03; exit 3'], {
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
        g = await f.launcher(
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
        f.cleanup();
        if (g) await settleCleanup(g.exited);
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
          g = await f.launcher(o, shell);
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
        g = await f.launcher(
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
        f.cleanup();
        if (g) await settleCleanup(g.exited);
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
          t,
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
        g = await f.launcher(
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
        g = await f.launcher(
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
        f.cleanup();
        if (g) await settleCleanup(g.exited);
        closeSync(fd);
      }
    }
  );
}
