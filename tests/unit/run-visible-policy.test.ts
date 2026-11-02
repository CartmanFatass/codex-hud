import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { visibleHostContext } from '../../src/core/run/visible-host.js';
import { preflightVisible, signalVisibleScope } from '../../src/core/run/visible-process.js';
import { readProcess } from '../../src/core/run/process.js';
import type { ProcessScope } from '../../src/core/types/supervision.js';
import type { HostAdapter } from '../../src/core/interfaces/host-adapter.js';

test('visible Herdr context is data consumed by HostAdapter without supervisor surface/input/focus actions', async () => {
  const context = visibleHostContext({
    HERDR_ENV: '1',
    HERDR_WORKSPACE_ID: 'synthetic-workspace',
    HERDR_TAB_ID: 'synthetic-tab',
    HERDR_PANE_ID: 'synthetic-pane',
    HERDR_FUTURE_KEY: 'preserved',
    OTHER: 'excluded',
  });
  const calls: string[] = [];
  const host = {
    kind: 'herdr',
    openSurface: async (_layout, options) => {
      calls.push('openSurface');
      assert.deepEqual(options.env, context.env);
      return {} as never;
    },
    runInSurface: async () => {
      calls.push('runInSurface');
    },
    locate: async () => null,
    checkLocator: async () => ({}) as never,
    focus: async () => {
      calls.push('focus');
    },
    sendKeys: async () => {
      calls.push('sendKeys');
    },
    attachIdentity: async () => {
      calls.push('attachIdentity');
    },
  } satisfies HostAdapter;
  assert.equal(context.kind, 'herdr');
  assert.equal(context.workspace, 'synthetic-workspace');
  assert.equal(context.tab, 'synthetic-tab');
  assert.equal(context.pane, 'synthetic-pane');
  assert.equal(context.env.HERDR_FUTURE_KEY, 'preserved');
  assert.equal(context.env.OTHER, undefined);
  assert.deepEqual(calls, []);
  await host.openSurface('pane', { cwd: '/synthetic', env: context.env, managed: null });
  assert.deepEqual(calls, ['openSurface']);
  assert.equal(visibleHostContext({}).kind, 'none');
});

test('visible unsupported sidecar, PTY, unknown dispatch and untrusted executable refuse preflight', () => {
  for (const patch of [
    { strategy: 'sidecar' },
    { capture: 'pty' },
    { dispatch: 'unknown' },
    { expectedExecutable: 'node' },
  ])
    assert.throws(
      () => preflightVisible({ expectedExecutable: process.execPath, ...patch } as never),
      /unsupported_visible/
    );
});

test('visible replaced leader, wrong boot/domain/SID and nonleader scope send zero signals', () => {
  const self = readProcess(process.pid)!;
  const scope: ProcessScope = {
    scope_id: 'synthetic-visible-instance',
    scope_kind: 'pgid',
    pgid: self.pgid,
    sid: self.sid,
    boot_id: self.stamp.boot_id,
    pid_domain: self.stamp.pid_domain,
    group_leader: { ...self.stamp, pid: self.pgid, proc_start: '0' },
  };
  for (const patch of [{}, { boot_id: 'other-boot' }, { pid_domain: 'other-domain' }, { sid: -1 }])
    assert.equal(signalVisibleScope({ ...scope, ...patch }, 'SIGINT'), false);
});

test('visible control without a stable delivery capability refuses even a matching live group', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},60000)'], { detached: true, stdio: 'ignore' });
  const done = new Promise((resolve) => child.once('exit', resolve));
  const leader = readProcess(child.pid!)!;
  const scope: ProcessScope = {
    scope_id: 'synthetic-live-visible-group',
    scope_kind: 'pgid',
    pgid: leader.pgid,
    sid: leader.sid,
    boot_id: leader.stamp.boot_id,
    pid_domain: leader.stamp.pid_domain,
    group_leader: leader.stamp,
  };
  const deliveries: unknown[][] = [];
  const original = process.kill;
  const spy = t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
    if (signal === 0) return original(pid, signal);
    deliveries.push([pid, signal]);
    return true;
  });
  try {
    assert.equal(leader.pgid, child.pid);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL'] as const)
      assert.equal(signalVisibleScope(scope, signal), false);
    assert.deepEqual(deliveries, [], 'no numeric-group or single-PID delivery may be attempted');
  } finally {
    spy.mock.restore();
    child.kill('SIGKILL');
    await done;
  }
});
