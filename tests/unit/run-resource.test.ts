import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { RUN_NODE_FLAGS } from '../../src/core/run/runtime.js';
import { processState } from '../../src/core/run/process.js';
import type { ProcessStamp } from '../../src/core/types/supervision.js';
import { seedRun } from '../run/fixtures.js';
const [major, minor] = process.versions.node.split('.').map(Number);
const skip =
  process.platform !== 'linux' || major < 22 || (major === 22 && minor < 5)
    ? 'hud-run executable requires Linux and Node >=22.5'
    : false;
const inheritedFunction = '() { printf synthetic-ok; }';

for (const flagged of [false, true])
  test(
    `${flagged ? 'B4 flagged Node argv' : 'plain executable'} preserves inherited environment; HUD flags never change harness argv or env`,
    { skip },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'hud-run-resource-'));
      const data = seedRun(home, [
        process.execPath,
        '-e',
        `process.stdout.write(JSON.stringify({execArgv:process.execArgv,nodeOptions:process.env.NODE_OPTIONS,dotted:process.env['HUD.SYNTHETIC'],func:process.env['BASH_FUNC_hud_synthetic%%'],pwd:process.env.PWD}));setTimeout(()=>process.exit(0),1200);`,
      ]);
      writeFileSync(join(home, 'facts.json'), JSON.stringify(data.seed), { mode: 0o600 });
      const executable = flagged ? process.execPath : resolve('bin/hud-run');
      const args = flagged ? [...RUN_NODE_FLAGS, 'bin/hud-run', 'start'] : ['start'];
      const child = spawn(executable, args, {
        cwd: resolve('.'),
        env: {
          ...process.env,
          NODE_OPTIONS: '--trace-warnings',
          'HUD.SYNTHETIC': 'preserved',
          'BASH_FUNC_hud_synthetic%%': inheritedFunction,
          PWD: '/synthetic/inherited-pwd',
          HUD_HOME: home,
          HUD_RUN_PORT_MODULE: resolve('tests/run/file-port.mjs'),
        },
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let errors = '';
      child.stderr.on('data', (b) => (errors += b));
      const exited = new Promise((r) => child.once('exit', r));
      // Omit StartOptions.env: this is the supported inherited-environment path.
      child.stdin.end(JSON.stringify({ input: data.input, ticket: data.ticket }));
      let owned: ProcessStamp[] = [];
      try {
        let snapshot;
        for (let i = 0; i < 400; i++) {
          snapshot = JSON.parse(readFileSync(join(home, 'facts.json'), 'utf8')).snapshot;
          if (snapshot.run.state === 'running') break;
          if (child.exitCode !== null) break;
          await sleep(20);
        }
        assert.equal(snapshot.run.state, 'running', errors);
        assert.equal(snapshot.run.supervisor.pid, child.pid);
        const helper = snapshot.meta.scope.group_leader,
          command = snapshot.meta.command_leader;
        owned = [helper, command];
        const supervisorArgv = readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0');
        for (const flag of RUN_NODE_FLAGS) assert.equal(supervisorArgv.includes(flag), flagged);
        const helperArgv = readFileSync(`/proc/${helper.pid}/cmdline`, 'utf8').split('\0');
        for (const flag of RUN_NODE_FLAGS) assert.ok(helperArgv.includes(flag));
        const harnessArgv = readFileSync(`/proc/${command.pid}/cmdline`, 'utf8').split('\0');
        for (const flag of RUN_NODE_FLAGS) assert.equal(harnessArgv.includes(flag), false);
        assert.equal(await exited, 0, errors);
        const observed = JSON.parse(readFileSync(join(home, 'runs', data.input.runId, 'stdout.log'), 'utf8'));
        for (const flag of RUN_NODE_FLAGS) assert.equal(observed.execArgv.includes(flag), false);
        assert.equal(observed.nodeOptions, '--trace-warnings');
        assert.equal(observed.dotted, 'preserved');
        assert.equal(observed.func, inheritedFunction);
        assert.equal(observed.pwd, '/synthetic/inherited-pwd');
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
        for (const stamp of owned)
          if (processState(stamp) === 'alive') {
            try {
              process.kill(stamp.pid, 'SIGKILL');
            } catch {}
          }
        rmSync(home, { recursive: true, force: true });
      }
    }
  );

test(
  'plain executable preserves an inherited exported Bash function without an explicit launch env',
  { skip: skip || (!existsSync('/bin/bash') ? 'synthetic shell fixture requires bash' : false) },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'hud-run-function-'));
    const data = seedRun(home, ['/bin/bash', '--noprofile', '--norc', '-c', 'sleep 0.3; hud_synthetic']);
    writeFileSync(join(home, 'facts.json'), JSON.stringify(data.seed), { mode: 0o600 });
    const child = spawn(resolve('bin/hud-run'), ['start'], {
      env: {
        ...process.env,
        BASH_ENV: '',
        ENV: '',
        'BASH_FUNC_hud_synthetic%%': inheritedFunction,
        HUD_HOME: home,
        HUD_RUN_PORT_MODULE: resolve('tests/run/file-port.mjs'),
      },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let errors = '';
    child.stderr.on('data', (b) => (errors += b));
    const exited = new Promise((r) => child.once('exit', r));
    child.stdin.end(JSON.stringify({ input: data.input, ticket: data.ticket }));
    try {
      assert.equal(await exited, 0, errors);
      const snap = JSON.parse(readFileSync(join(home, 'facts.json'), 'utf8')).snapshot;
      assert.equal(snap.run.exitCode, 0, errors);
      assert.equal(readFileSync(join(home, 'runs', data.input.runId, 'stdout.log'), 'utf8'), 'synthetic-ok');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      rmSync(home, { recursive: true, force: true });
    }
  }
);
