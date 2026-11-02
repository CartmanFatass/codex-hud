import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  currentDomain,
  inspectGroup,
  launchGroup,
  launchNodeGroup,
  processState,
  proveGroupGone,
  readProcess,
  type GroupProcess,
} from '../../src/core/run/process.js';
import type { ProcessStamp } from '../../src/core/types/supervision.js';

const linux = process.platform === 'linux';
const python = '/usr/bin/python3';

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < end, 'bounded process fixture timed out');
    await delay(10);
  }
}

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'hud-run-process-'));
  const output = join(dir, 'output');
  const fd = openSync(output, 'a', 0o600);
  const groups: GroupProcess[] = [];
  const extra: ProcessStamp[] = [];
  t.after(async () => {
    for (const group of groups) {
      if (processState(group.helper) === 'alive') await group.signal('SIGKILL');
      group.close();
      if (group.command && processState(group.command) === 'alive') {
        try {
          process.kill(group.command.pid, 'SIGKILL');
        } catch {
          /* owned fixture already exited */
        }
      }
    }
    for (const stamp of extra) {
      if (processState(stamp) === 'alive') {
        try {
          process.kill(stamp.pid, 'SIGKILL');
        } catch {
          /* owned fixture already exited */
        }
      }
    }
    closeSync(fd);
    rmSync(dir, { force: true, recursive: true });
  });
  return {
    dir,
    output,
    extra,
    async launch(argv: string[], stdin: Buffer | null = null, native = false) {
      const group = await (native ? launchNodeGroup : launchGroup)({
        runId: 'synthetic-run',
        argv,
        cwd: dir,
        stdin,
        stdoutFd: fd,
        stderrFd: fd,
      });
      groups.push(group);
      return group;
    },
  };
}

test('process stamps preserve boot and PID namespace, and cross-domain state stays unknown', { skip: !linux }, () => {
  const self = readProcess(process.pid)!;
  assert.deepEqual({ boot_id: self.stamp.boot_id, pid_domain: self.stamp.pid_domain }, currentDomain());
  assert.equal(processState(self.stamp), 'alive');
  assert.equal(processState({ ...self.stamp, proc_start: '0' }), 'dead');
  assert.equal(processState({ ...self.stamp, pid_domain: 'synthetic-other-domain' }), 'unknown');
  assert.equal(processState({ ...self.stamp, boot_id: 'synthetic-other-boot' }), 'unknown');
  assert.equal(readProcess(-1), null);
});

test('one-shot group launch preserves argv and stdin EOF, waits for helper exit', { skip: !linux }, async (t) => {
  const fixture = setup(t);
  const group = await fixture.launch(
    [
      process.execPath,
      '-e',
      `let s=''; process.stdin.on('data',b=>s+=b); process.stdin.on('end',()=>{console.log(JSON.stringify({args:process.argv.slice(1),s})); process.exitCode=7});`,
      'a b',
      '$(synthetic)',
    ],
    Buffer.from('brief\n'),
    true
  );
  assert.ok(group.command);
  assert.ok(group.scope);
  assert.equal(readProcess(group.helper.pid)?.pgid, group.scope.pgid);
  assert.equal(readProcess(group.command.pid)?.pgid, group.scope.pgid);
  const exit = await group.exited;
  assert.equal(exit.code, 7);
  assert.equal(exit.signal, null);
  assert.equal(processState(group.helper), 'dead');
  assert.deepEqual(JSON.parse(readFileSync(fixture.output, 'utf8')), { args: ['a b', '$(synthetic)'], s: 'brief\n' });
  assert.equal(proveGroupGone(group.scope, group.command, [group.helper]), true);
});

test(
  'helper in its own group delivers INT then TERM; replacement-stamp simulation refuses control',
  { skip: !linux },
  async (t) => {
    const fixture = setup(t);
    const group = await fixture.launch([
      process.execPath,
      '-e',
      `process.on('SIGINT',()=>console.log('INT'));process.on('SIGTERM',()=>{console.log('TERM');process.exit(0)});console.log('ready');setInterval(()=>{},1000);`,
    ]);
    await until(() => readFileSync(fixture.output, 'utf8').includes('ready'));
    const start = group.helper.proc_start;
    group.helper.proc_start = 'synthetic-replacement';
    assert.equal(await group.signal('SIGINT'), false);
    group.helper.proc_start = start;
    assert.equal(await group.signal('SIGINT'), true);
    await until(() => readFileSync(fixture.output, 'utf8').includes('INT'));
    assert.equal(await group.signal('SIGTERM'), true);
    const exit = await group.exited;
    assert.equal(exit.source, 'native_unknown');
    assert.equal(exit.code, null);
    assert.equal(group.shellDiagnostic?.status, 0);
    assert.match(readFileSync(fixture.output, 'utf8'), /INT\nTERM/);
    assert.equal(await group.signal('SIGKILL'), false);
  }
);

test(
  'SIGKILL from inside helper group loses acknowledgement and never invents command wait status',
  { skip: !linux },
  async (t) => {
    const fixture = setup(t);
    const group = await fixture.launch([process.execPath, '-e', `console.log('ready');setInterval(()=>{},1000)`]);
    await until(() => readFileSync(fixture.output, 'utf8').includes('ready'));
    assert.equal(await group.signal('SIGKILL'), false);
    const exit = await group.exited;
    assert.equal(exit.code, null);
    assert.equal(exit.signal, null);
    assert.equal(processState(group.helper), 'dead');
  }
);

test('dead command and group leader with a living member never prove scope gone', { skip: !linux }, async (t) => {
  const fixture = setup(t);
  const group = await fixture.launch([
    process.execPath,
    '-e',
    `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync('member',String(c.pid));c.unref();process.exit(0);`,
  ]);
  assert.ok(group.scope);
  assert.ok(group.command);
  await group.exited;
  const member = readProcess(Number(readFileSync(join(fixture.dir, 'member'), 'utf8')))!.stamp;
  fixture.extra.push(member);
  assert.equal(processState(group.helper), 'dead');
  assert.equal(processState(group.command), 'dead');
  const inspection = inspectGroup(group.scope);
  assert.equal(inspection.result, 'unknown');
  assert.ok(inspection.members.length > 0);
  assert.equal(inspection.complete, false);
  assert.equal(proveGroupGone(group.scope, group.command, [group.helper]), false);
  assert.equal(await group.signal('SIGTERM'), false);
});

test(
  'fork during actual /proc enumeration is partial evidence, never complete scope proof',
  { skip: !linux },
  async (t) => {
    const fixture = setup(t);
    const group = await fixture.launch([
      process.execPath,
      '-e',
      `const {spawn}=require('node:child_process');process.on('SIGUSR1',()=>{const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync('forked',String(c.pid));});console.log('ready');setInterval(()=>{},1000)`,
    ]);
    assert.ok(group.command);
    assert.ok(group.scope);
    await until(() => readFileSync(fixture.output, 'utf8').includes('ready'));
    const inspection = inspectGroup(group.scope, () => {
      process.kill(group.command!.pid, 'SIGUSR1');
      const waited = spawnSync(process.execPath, [
        '-e',
        `const fs=require('node:fs');const end=Date.now()+3000;while(!fs.existsSync(process.argv[1])&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);if(!fs.existsSync(process.argv[1]))process.exit(1)`,
        join(fixture.dir, 'forked'),
      ]);
      assert.equal(waited.status, 0);
    });
    fixture.extra.push(readProcess(Number(readFileSync(join(fixture.dir, 'forked'), 'utf8')))!.stamp);
    assert.equal(inspection.complete, false);
    assert.equal(inspection.result, 'alive');
    assert.ok(inspection.members.length > 0);
  }
);

test(
  'real member leaving group during enumeration keeps original harness alive outside scope',
  { skip: !linux || !existsSync(python) },
  async (t) => {
    const fixture = setup(t);
    const group = await fixture.launch([
      python,
      '-c',
      `import os,signal,time\ndef leave(a,b):\n os.setpgid(0,0)\n open('left','w').write('yes')\nsignal.signal(signal.SIGUSR1,leave)\nopen('ready','w').write('yes')\nwhile True: time.sleep(1)\n`,
    ]);
    assert.ok(group.command);
    assert.ok(group.scope);
    await until(() => existsSync(join(fixture.dir, 'ready')));
    const inspection = inspectGroup(group.scope, () => {
      process.kill(group.command!.pid, 'SIGUSR1');
      assert.equal(
        spawnSync(process.execPath, [
          '-e',
          `const fs=require('node:fs');const end=Date.now()+3000;while(!fs.existsSync(process.argv[1])&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);if(!fs.existsSync(process.argv[1]))process.exit(1)`,
          join(fixture.dir, 'left'),
        ]).status,
        0
      );
    });
    assert.equal(inspection.complete, false);
    assert.ok(!inspection.members.some((member) => member.stamp.pid === group.command!.pid));
    assert.equal(processState(group.command), 'alive');
    assert.equal(proveGroupGone(group.scope, group.command, [group.helper]), false);
  }
);

test('IPC disconnect seals helper while the existing command continues', { skip: !linux }, async (t) => {
  const fixture = setup(t);
  const group = await fixture.launch([
    process.execPath,
    '-e',
    `setTimeout(()=>{console.log('continued');process.exit(0)},150)`,
  ]);
  assert.ok(group.command);
  group.close();
  assert.equal(await group.signal('SIGTERM'), false);
  assert.equal(processState(group.command), 'alive');
  await group.exited;
  assert.match(readFileSync(fixture.output, 'utf8'), /continued/);
});

test(
  'crash/disconnect before scope fixation seals unsubmitted helper with zero command spawn',
  { skip: !linux },
  async () => {
    const helper = spawn(
      process.execPath,
      [fileURLToPath(new URL('../../src/core/run/group-helper.js', import.meta.url))],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }
    );
    const [ready] = await once(helper, 'message');
    assert.equal(ready.type, 'ready');
    const exited = once(helper, 'exit');
    helper.disconnect();
    assert.equal((await exited)[0], 0);
    assert.equal(processState(ready.helper), 'dead');
  }
);

test('private helper accepts exactly one submission and refuses a second launch', { skip: !linux }, async (t) => {
  const fixture = setup(t);
  const helper = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../src/core/run/group-helper.js', import.meta.url))],
    {
      detached: true,
      cwd: fixture.dir,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    }
  );
  t.after(() => {
    if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGKILL');
  });
  const [ready] = await once(helper, 'message');
  const stamp = ready.helper as ProcessStamp;
  const record = readProcess(stamp.pid)!;
  const submit = {
    type: 'submit',
    helper: stamp,
    scope: {
      scope_id: 'synthetic-one-shot',
      scope_kind: 'pgid',
      ...currentDomain(),
      pgid: record.pgid,
      sid: record.sid,
      group_leader: stamp,
    },
    argv: [process.execPath, '-e', 'setTimeout(()=>process.exit(0),100)'],
    cwd: fixture.dir,
    env: process.env,
  };
  const started = once(helper, 'message');
  helper.send(submit);
  assert.equal((await started)[0].type, 'started');
  helper.send({
    ...submit,
    argv: [process.execPath, '-e', `require('node:fs').writeFileSync('second-submission','forbidden')`],
  });
  await once(helper, 'exit');
  assert.equal(existsSync(join(fixture.dir, 'second-submission')), false);
});
