import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { currentDomain, inspectGroup, processState, proveGroupGone, readProcess } from '../../src/core/run/process.js';
import {
  linuxCensusAccess,
  parseProcessStat,
  procVisibility,
  procMountWitness,
  proveZombieSessionGone,
  readProcessCensus,
  type CensusAccess,
} from '../../src/core/run/process-census.js';
import type { ProcessScope, ProcessStamp } from '../../src/core/types/supervision.js';
import { MemoryRunFactPort } from '../../src/core/run/fake-port.js';
import { HeadlessRunControl } from '../../src/core/run/control.js';
import { seedRun } from '../run/fixtures.js';

const linux = process.platform === 'linux' && existsSync('/usr/bin/python3');
const waitCell = new Int32Array(new SharedArrayBuffer(4));
function until(check: () => boolean): void {
  const end = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < end, 'bounded synthetic process transition');
    Atomics.wait(waitCell, 0, 0, 2);
  }
}
async function fixture(t: TestContext, mode = 'zombie') {
  const home = mkdtempSync(join(tmpdir(), 'hud-runz1-'));
  const child = spawn('/usr/bin/python3', [resolve('tests/unit/runz1-fixture.py'), home, mode], {
    detached: true,
    env: { ...process.env, HOME: home, HUD_HOME: join(home, 'hud') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = once(child, 'exit');
  t.after(async () => {
    child.stdin.end('cleanup\n');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    const [code, signal] = await exited;
    clearTimeout(timeout);
    assert.equal(code, 0, `${signal}: ${stderr}`);
    rmSync(home, { recursive: true, force: true });
  });
  const readyTimeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      exited.then(() => {
        throw new Error(`fixture exited before ready: ${stderr}`);
      }),
    ]);
  } finally {
    clearTimeout(readyTimeout);
  }
  const pid = (name: string) => Number(readFileSync(join(home, name), 'utf8'));
  const leader = readProcess(pid('leader'))!;
  assert.ok(leader);
  const scope: ProcessScope = {
    scope_id: 'synthetic-runz1',
    scope_kind: 'pgid',
    ...currentDomain(),
    pgid: leader.pgid,
    sid: leader.sid,
    group_leader: leader.stamp,
  };
  const mark = (name: string) => writeFileSync(join(home, name), 'go');
  mark('terminate');
  until(() => readProcess(leader.stamp.pid)?.state === 'Z');
  return {
    home,
    child,
    pid,
    leader,
    scope,
    mark,
    step(n: number) {
      mark(`step${n}`);
      until(() => existsSync(join(home, `step${n}-done`)));
    },
    proof(options?: Parameters<typeof proveGroupGone>[3]) {
      return proveGroupGone(scope, leader.stamp, [leader.stamp], options);
    },
    async reap() {
      child.stdin.write('reap\n');
      until(() => existsSync(join(home, 'reaped')));
    },
  };
}

async function recoveryFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  harness: ProcessStamp,
  commandLeader: ProcessStamp
) {
  const mode = f.scope.sid === f.scope.pgid ? 'headless' : 'visible';
  const data = seedRun(f.home, ['/synthetic/harness'], { mode, stdin: mode === 'headless' ? 'closed' : 'tty' });
  const port = new MemoryRunFactPort(data.seed);
  await port.register(data.input.runId, data.ticket, data.seed.snapshot.run.launchDigest, f.leader.stamp);
  await port.phase(data.input.runId, f.leader.stamp, 'submitting');
  await port.phase(data.input.runId, f.leader.stamp, 'submitted');
  await port.startup(data.input.runId, f.leader.stamp, {
    schema_version: 1,
    run_id: data.input.runId,
    link_id: data.seed.snapshot.run.linkId,
    source_id: data.input.sourceId,
    binding_generation: data.seed.snapshot.run.expectedGeneration,
    mode,
    supervision_strategy: mode === 'headless' ? 'headless' : 'wrapper',
    supervisor: f.leader.stamp,
    command_leader: commandLeader,
    harness,
    scope: f.scope,
    launch_digest: data.seed.snapshot.run.launchDigest,
    profile_digest: data.input.profileDigest,
    launch_call_id: 'synthetic-call',
    launch_correlation_id: 'synthetic-correlation',
    created_at: Date.now(),
    stdin_mode: mode === 'headless' ? 'closed' : 'tty',
    capture: mode === 'headless' ? 'file' : 'tty_passthrough',
    launch_cwd: f.home,
    project_origin: null,
  });
  const control = new HeadlessRunControl(port, f.home, {
    kind: 'trusted_local',
    uid: process.getuid!(),
    invocationId: 'synthetic-runz1',
  });
  return { data, port, control };
}

function stableProof(proof: () => boolean): boolean {
  // This is a bounded *test* retry for unrelated host churn, not product polling.
  for (let attempt = 0; attempt < 20; attempt++) if (proof()) return true;
  return false;
}

test('RUNZ1 true zombie-only own session ends while the kernel still holds its PGID', { skip: !linux }, async (t) => {
  const f = await fixture(t);
  assert.equal(processState(f.leader.stamp), 'dead');
  assert.doesNotThrow(() => process.kill(-f.scope.pgid, 0));
  assert.ok(procVisibility(f.scope), 'host must establish unrestricted procfs for this positive test');
  assert.equal(
    stableProof(() => f.proof()),
    true
  );
});

test('RUNZ1 fork after the first census snapshot cannot end a live group', { skip: !linux }, async (t) => {
  const f = await fixture(t, 'fork');
  let boundary = false;
  assert.equal(
    f.proof({
      afterSnapshot(scan) {
        if (scan === 1) {
          f.step(1);
          until(() => readProcess(f.pid('worker'))?.state === 'Z');
          boundary = true;
        }
      },
    }),
    false
  );
  assert.equal(boundary, true);
  assert.equal(readProcess(f.pid('child'))?.sid, f.scope.sid);
  assert.equal(processState(readProcess(f.pid('child'))!.stamp), 'alive');
});

test('RUNZ1 same-session outsider can join a zombie-held PGID and never produces gone', { skip: !linux }, async (t) => {
  const f = await fixture(t, 'join');
  assert.notEqual(readProcess(f.pid('worker'))?.pgid, f.scope.pgid);
  assert.equal(f.proof(), false, 'outside-target live session member blocks zombie corroboration');
  f.step(1);
  assert.equal(readProcess(f.pid('worker'))?.pgid, f.scope.pgid);
  assert.equal(f.proof(), false);
});

test('RUNZ1 full census rejects the fork then setsid escape after the second snapshot', { skip: !linux }, async (t) => {
  const f = await fixture(t, 'escape');
  const reached: number[] = [];
  assert.equal(
    f.proof({
      afterSnapshot(scan) {
        reached.push(scan);
        f.step(scan);
        if (scan === 1) until(() => readProcess(f.pid('worker'))?.state === 'Z');
      },
    }),
    false
  );
  assert.deepEqual(reached, [1, 2]);
  assert.notEqual(readProcess(f.pid('child'))?.sid, f.scope.sid);
  assert.equal(readProcess(f.pid('grandchild'))?.sid, f.scope.sid);
  assert.equal(readProcess(f.pid('grandchild'))?.pgid, f.scope.pgid);
  assert.equal(processState(readProcess(f.pid('grandchild'))!.stamp), 'alive');
});

test('RUNZ1 zombie thread-group leader with a live sibling never proves gone', { skip: !linux }, async (t) => {
  const f = await fixture(t, 'thread');
  assert.equal(readProcess(f.leader.stamp.pid)?.state, 'Z');
  assert.equal(readProcess(f.pid('tid'))?.state, 'S');
  assert.equal(f.proof(), false);
});

test(
  'RUNZ1 visible shared-session zombie stays unknown until ESRCH despite a living session outsider',
  { skip: !linux },
  async (t) => {
    const f = await fixture(t, 'visible');
    assert.notEqual(f.scope.sid, f.scope.pgid);
    assert.equal(inspectGroup(f.scope).result, 'unknown');
    assert.equal(f.proof(), false);
    const { data, port, control } = await recoveryFixture(f, f.leader.stamp, f.leader.stamp);
    assert.equal((await control.reconcile(data.input.runId)).currentRun?.state, 'uncertain');
    assert.equal((await port.read(data.input.runId)).slotHeld, true);
    await f.reap();
    assert.throws(() => process.kill(-f.scope.pgid, 0), { code: 'ESRCH' });
    assert.equal(readProcess(f.child.pid!)?.sid, f.scope.sid);
    assert.equal(f.proof(), true, 'ESRCH does not require the terminal session to end');
    assert.equal((await control.reconcile(data.input.runId)).currentRun?.state, 'ended');
    assert.equal((await port.read(data.input.runId)).slotHeld, false);
  }
);

function synthetic() {
  const domain = { boot_id: 'synthetic-boot', pid_domain: 'synthetic-domain' };
  const stamp = { pid: 100, proc_start: '10', ...domain };
  const scope: ProcessScope = {
    scope_id: 'synthetic',
    scope_kind: 'pgid',
    pgid: 100,
    sid: 100,
    group_leader: stamp,
    ...domain,
  };
  function stat(pid: number, state = 'Z', sid = 100, start = '10', threads = 1) {
    const fields = [
      state,
      '1',
      String(sid),
      String(sid),
      '0',
      '-1',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      String(threads),
      '0',
      start,
    ];
    return `${pid} (synthetic name) ${fields.join(' ')}\n`;
  }
  const files = new Map([
    ['/proc/100/stat', stat(100)],
    ['/proc/100/task/100/stat', stat(100)],
  ]);
  const access: CensusAccess = {
    list(path) {
      if (path === '/proc') return ['100'];
      if (path === '/proc/100/task') return ['100'];
      throw new Error('missing directory');
    },
    text(path) {
      const value = files.get(path);
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return value;
    },
    visibility: () => 'synthetic-unrestricted-procfs',
  };
  const subjects = [stamp];
  return {
    subjects,
    domain,
    stamp,
    scope,
    stat,
    files,
    access,
    proof: () => proveZombieSessionGone(scope, subjects, { access }),
  };
}

test('RUNZ1 synthetic control and vanished identities: stable or shrinking census is accepted', () => {
  const f = synthetic();
  assert.equal(f.proof(), true);
  let scans = 0;
  const list = f.access.list;
  f.access.list = (path) => (path === '/proc' ? (++scans === 1 ? ['100', '200'] : ['100']) : list(path));
  f.files.set('/proc/200/stat', f.stat(200, 'S', 200));
  assert.equal(f.proof(), true);
});

for (const change of [
  'new',
  'reused',
  'ENOENT',
  'ESRCH',
  'EACCES',
  'malformed',
  'visibility',
  'remount',
  'thread',
  'task-list',
  'subject-thread',
] as const)
  test(`RUNZ1 ${change} evidence cannot certify zombie absence`, () => {
    const f = synthetic();
    const originalList = f.access.list,
      originalText = f.access.text;
    let scans = 0,
      visibilityReads = 0;
    f.access.list = (path) => {
      if (path !== '/proc') return change === 'task-list' ? ['100', '101'] : originalList(path);
      scans++;
      return (change === 'new' && scans === 2) || change === 'reused' ? ['100', '200'] : ['100'];
    };
    f.access.text = (path) => {
      if (path === '/proc/200/stat' && change === 'new') return f.stat(200, 'S', 200);
      if (path === '/proc/200/stat' && change === 'reused') return f.stat(200, 'S', 200, scans === 1 ? '10' : '11');
      if (path === '/proc/100/stat' && scans === 2) {
        if (['ENOENT', 'ESRCH', 'EACCES'].includes(change))
          throw Object.assign(new Error('synthetic read failure'), { code: change });
        if (change === 'malformed') return f.stat(100).replace('Z 1 100', 'Z 1 NaN');
      }
      return originalText(path);
    };
    if (change === 'visibility') f.access.visibility = () => null;
    if (change === 'remount') f.access.visibility = () => String(++visibilityReads);
    if (change === 'thread') f.files.set('/proc/100/stat', f.stat(100, 'Z', 100, '10', 2));
    if (change === 'subject-thread') {
      f.files.set('/proc/200/stat', f.stat(200, 'Z', 200, '10', 2));
      f.subjects.push({ ...f.stamp, pid: 200 });
      f.access.list = (path) => (path === '/proc' ? ['100', '200'] : [path.split('/')[2]]);
    }
    assert.equal(f.proof(), false);
  });

test('RUNZ1 stat validation rejects invalid identity, state, membership, thread and start fields', () => {
  const f = synthetic();
  const valid = f.stat(100);
  for (const bad of [
    valid.replace('100 (', '101 ('),
    valid.replace('Z 1', '? 1'),
    valid.replace('Z 1 100', 'Z 1 nope'),
    valid.replace(' 1 0 10', ' 0 0 10'),
    valid.replace(/10\n$/, 'NaN\n'),
  ])
    assert.throws(() => parseProcessStat(100, bad, f.domain));
  assert.equal(
    parseProcessStat(100, valid.replace('synthetic name', 'nested ) name'), f.domain).stamp.proc_start,
    '10'
  );
});

test('RUNZ1 a failed census read throws instead of silently dropping an enumerated PID', () => {
  const f = synthetic();
  f.access.list = () => ['100', '200'];
  assert.throws(() => readProcessCensus(f.domain, f.access), { code: 'ENOENT' });
});

test('RUNZ1 visibility witness rejects hidden, partial, unknown and overmounted proc views', () => {
  const mount = '42 1 0:1 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw';
  assert.equal(procMountWitness(mount, '42'), mount);
  assert.equal(procMountWitness(mount + ',hidepid=0', '42'), mount + ',hidepid=0');
  for (const option of [
    'hidepid=1',
    'hidepid=2',
    'hidepid=4',
    'hidepid=invisible',
    'hidepid=ptraceable',
    'unknown_filter=1',
  ])
    assert.equal(procMountWitness(mount + ',' + option, '42'), null);
  for (const invalid of [
    mount.replace('/ /proc', '/subset /proc'),
    mount.replace(' - proc ', ' - tmpfs '),
    mount.replace('rw,nosuid', 'rw,hidepid=2,nosuid'),
  ])
    assert.equal(procMountWitness(invalid, '42'), null);
  assert.equal(procMountWitness(mount, '43'), null);
  assert.equal(procMountWitness(mount + '\n' + mount, '42'), null);
  for (const path of ['/proc/123', '/proc/123/stat', '/proc/self/task', '/proc/thread-self/stat'])
    assert.equal(procMountWitness(mount + `\n43 42 0:2 / ${path} ro - tmpfs tmpfs ro`, '42'), null);
});

for (const role of ['harness', 'launcher'] as const)
  test(`RUNZ1 ESRCH cannot override escaped ${role} zombie TGID with a live sibling`, { skip: !linux }, async (t) => {
    const f = await fixture(t, 'escaped-thread');
    const writer = readProcess(f.pid('writer'))!.stamp;
    f.mark('writer-terminate');
    until(() => readProcess(writer.pid)?.state === 'Z');
    await f.reap();
    assert.throws(() => process.kill(-f.scope.pgid, 0), { code: 'ESRCH' });
    assert.equal(readProcess(f.pid('writer-tid'))?.state, 'S');
    const harness = role === 'harness' ? writer : f.leader.stamp;
    const launchers = role === 'launcher' ? [f.leader.stamp, writer] : [f.leader.stamp];
    assert.equal(proveGroupGone(f.scope, harness, launchers), false);
    const { data, port, control } = await recoveryFixture(f, harness, role === 'launcher' ? writer : f.leader.stamp);
    assert.equal((await control.reconcile(data.input.runId)).currentRun?.state, 'uncertain');
    assert.equal((await port.read(data.input.runId)).slotHeld, true);
    assert.equal((await port.read(data.input.runId)).receipt, null);
    process.kill(writer.pid, 'SIGKILL');
    until(() => parseProcessStat(writer.pid, readFileSync(`/proc/${writer.pid}/stat`, 'utf8'), writer).threads === 1);
    assert.equal(proveGroupGone(f.scope, harness, launchers), true);
    assert.equal((await control.reconcile(data.input.runId)).currentRun?.state, 'ended');
    assert.equal((await port.read(data.input.runId)).slotHeld, false);
  });

test(
  'RUNZ1 common subject proof rejects ambiguous tasks and wrong domains but accepts replaced originals',
  { skip: !linux },
  async (t) => {
    const f = await fixture(t);
    for (const fault of ['ENOENT', 'EACCES', 'malformed', 'identity', 'count']) {
      const access: CensusAccess = {
        ...linuxCensusAccess,
        list(path) {
          if (fault === 'count' && path.endsWith('/task')) return [String(f.leader.stamp.pid), '99999999'];
          return linuxCensusAccess.list(path);
        },
        text(path) {
          const text = linuxCensusAccess.text(path);
          if (!path.includes('/task/')) return text;
          if (fault === 'ENOENT' || fault === 'EACCES')
            throw Object.assign(new Error('synthetic task failure'), { code: fault });
          if (fault === 'malformed') return 'malformed';
          if (fault === 'identity') {
            const end = text.lastIndexOf(') ');
            const fields = text
              .slice(end + 2)
              .trim()
              .split(/\s+/);
            fields[19] = '0';
            return text.slice(0, end + 2) + fields.join(' ');
          }
          return text;
        },
      };
      assert.equal(f.proof({ access }), false, fault);
    }
    await f.reap();
    assert.equal(
      proveGroupGone(f.scope, { ...readProcess(process.pid)!.stamp, proc_start: '0' }, [f.leader.stamp]),
      true
    );
    for (const patch of [{ boot_id: 'synthetic-wrong-boot' }, { pid_domain: 'synthetic-wrong-domain' }])
      assert.equal(proveGroupGone(f.scope, { ...f.leader.stamp, ...patch }, [f.leader.stamp]), false);
  }
);
