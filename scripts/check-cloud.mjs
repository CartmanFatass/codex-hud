#!/usr/bin/env node
/** Finite credential-free cloud checks. No provider, install, release or capability promotion. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const LIMIT = 2 * 1024 * 1024;
export const FOCUSED_TESTS = [
  'pi-reader',
  'pi-binding',
  'pi-cli',
  'pi-launch',
  'hud-pi-integration',
  'statusline-preview',
  'codex-exec-json',
  'codex-exec-transport',
  'codex-app-server',
  'codex-app-server-transport',
  'claude-print-transport',
  'm2-claude-contract-simulation',
  'pi-rpc-observation',
  'pi-rpc-transport',
  'd1-claude-visibility',
  'd1-claude-render',
  'claude-configuration',
  'c45-jev-fake',
  'workbench-events',
  'workbench-input',
  'workbench-layout',
  'workbench-live',
  'workbench',
];
export const DEMOS = [
  'demo-cloud-m1',
  'demo-codex-exec',
  'demo-codex-exec-transport',
  'demo-codex-app-server-transport',
  'demo-claude-print-transport',
  'demo-pi-rpc',
  'demo-pi-rpc-transport',
  'demo-jev-fake',
];
export function runtime() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (process.platform !== 'linux' || !((major === 22 && minor >= 13) || major === 24))
    throw new Error('cloud_checks_require_linux_node_22_13_or_24');
}
export function safeFile(relative) {
  if (
    typeof relative !== 'string' ||
    path.isAbsolute(relative) ||
    relative.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw new Error('invalid_package_path');
  let current = ROOT;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('symlink_input_refused');
  }
  if (!fs.statSync(current).isFile()) throw new Error('regular_input_required');
  return current;
}
export function git(...args) {
  return execFileSync('/usr/bin/git', ['-C', ROOT, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: LIMIT,
    env: { PATH: '/usr/bin:/bin', HOME: ROOT, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}
export function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
export function metadata() {
  return {
    schemaVersion: 1,
    repositorySha: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain', '--untracked-files=normal') !== '',
    node: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    git: git('--version'),
    lockfileSha256: sha(fs.readFileSync(safeFile('package-lock.json'))),
    evidence: 'cloud simulation; not live-provider or release qualification',
  };
}
export function outputDirectory(name) {
  // Only test-owned, ignored paths; reject symlink ancestors, never overwrite caller files.
  let parent = ROOT;
  for (const part of ['tmp', 'cloud-development']) {
    parent = path.join(parent, part);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent);
    if (fs.lstatSync(parent).isSymbolicLink() || !fs.statSync(parent).isDirectory())
      throw new Error('unsafe_output_directory');
  }
  return fs.mkdtempSync(path.join(parent, `${name}-`));
}
export function isolatedEnvironment(directory) {
  const home = path.join(directory, 'home');
  const temp = path.join(directory, 'temp');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  return {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    HUD_HOME: path.join(home, '.hud'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    TMPDIR: temp,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    CI: '1',
  };
}
export async function runStep(step, directory, env) {
  const started = Date.now();
  const chunks = [];
  let bytes = 0,
    reason = null,
    killTimer,
    reapTimer;
  let spawned = false,
    directExited = false,
    escalated = false,
    cleanupUncertain = false;
  const child = spawn(step.executable ?? process.execPath, step.args, {
    cwd: ROOT,
    env,
    shell: false,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.once('spawn', () => {
    spawned = true;
  });
  child.once('exit', () => {
    directExited = true;
  });
  const signalOwnedGroup = (signal) => {
    // Once our direct child exits, its PID/PGID may be reused. Do not guess group ownership.
    if (!spawned || directExited) {
      cleanupUncertain = true;
      return false;
    }
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      cleanupUncertain = true;
      return false;
    }
  };
  const stop = (why) => {
    if (reason) return;
    reason = why;
    signalOwnedGroup('SIGTERM');
    killTimer = setTimeout(() => {
      escalated = signalOwnedGroup('SIGKILL');
    }, 250);
  };
  const receive = (chunk) => {
    if (bytes < LIMIT) chunks.push(chunk.subarray(0, Math.max(0, LIMIT - bytes)));
    bytes += chunk.length;
    if (bytes > LIMIT) stop('output_limit');
  };
  child.stdout.on('data', receive);
  child.stderr.on('data', receive);
  child.stdout.on('error', () => stop('output_error'));
  child.stderr.on('error', () => stop('output_error'));
  const timer = setTimeout(() => stop('timeout'), step.timeoutMs ?? 120000);
  const interrupt = () => stop('interrupted');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const result = await new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    child.once('error', () => {
      reason = 'spawn_error';
      done({ code: null, signal: null, reaped: true, closeObserved: false });
    });
    child.once('close', (code, signal) => done({ code, signal, reaped: true, closeObserved: true }));
    reapTimer = setTimeout(
      () => {
        stop('timeout');
        cleanupUncertain = true;
        // An escaped descendant can keep inherited pipes open after the direct child exits.
        // Stop owning these observation handles so failure can return without waiting forever.
        child.stdout.removeListener('data', receive);
        child.stderr.removeListener('data', receive);
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        done({ code: null, signal: null, reaped: false, closeObserved: false });
      },
      (step.timeoutMs ?? 120000) + 2000
    );
  });
  clearTimeout(timer);
  clearTimeout(reapTimer);
  // Direct-child close does not prove group cleanup. If escalation lost ownership, report uncertainty.
  if (reason && !escalated && spawned) cleanupUncertain = true;
  clearTimeout(killTimer);
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  const log = `${step.name}.log`;
  fs.writeFileSync(path.join(directory, log), Buffer.concat(chunks));
  return {
    name: step.name,
    command: [step.executable ?? 'node', ...step.args],
    ...result,
    directChildExited: directExited,
    reason,
    cleanupUncertain,
    status: result.code === 0 && !reason && result.reaped && !cleanupUncertain ? 'PASS' : 'FAIL',
    elapsedMs: Date.now() - started,
    capturedBytes: Math.min(bytes, LIMIT),
    log,
  };
}
export const BUILD_STEPS = [
  { name: 'build', args: ['node_modules/typescript/bin/tsc'], timeoutMs: 180000 },
  { name: 'build-test', args: ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.test.json'], timeoutMs: 180000 },
  {
    name: 'build-mcp',
    args: ['node_modules/typescript/bin/tsc', '-p', 'packages/hud-mcp/tsconfig.json'],
    timeoutMs: 180000,
  },
];
export async function selfTest() {
  const out = outputDirectory('self-test');
  const env = isolatedEnvironment(out);
  try {
    assert.equal('ANTHROPIC_API_KEY' in env, false);
    assert.equal('NODE_OPTIONS' in env, false);
    const ok = await runStep({ name: 'ok', args: ['-e', 'console.log("synthetic")'] }, out, env);
    assert.equal(ok.status, 'PASS');
    assert.equal(ok.cleanupUncertain, false);
    assert.equal(ok.directChildExited, true);
    assert.equal(ok.closeObserved, true);
    const fail = await runStep({ name: 'fail', args: ['-e', 'process.exit(7)'] }, out, env);
    assert.equal(fail.code, 7);
    assert.equal(fail.status, 'FAIL');
    const timeout = await runStep(
      { name: 'timeout', args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 50 },
      out,
      env
    );
    assert.equal(timeout.reason, 'timeout');
    assert.equal(timeout.reaped, true);
    const pidFile = path.join(out, 'pipe-fixture.pid');
    const marker = `cloud-pipe-fixture-${path.basename(out)}`;
    const spawner = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setTimeout(()=>{},15000)',${JSON.stringify(marker)}],{detached:true,stdio:['ignore',1,2],env:process.env});const stat=fs.readFileSync('/proc/'+c.pid+'/stat','utf8');const startStamp=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:c.pid,startStamp}));c.unref();`;
    const helper = `import(${JSON.stringify(import.meta.url)}).then(async m=>{const r=await m.runStep({name:'inherited-pipe',args:['-e',${JSON.stringify(spawner)}],timeoutMs:1000},${JSON.stringify(out)},m.isolatedEnvironment(${JSON.stringify(out)}));console.log(JSON.stringify(r));});`;
    try {
      // The helper must naturally exit, not merely resolve its inner Promise while a pipe stays referenced.
      const nested = await runStep({ name: 'pipe-helper', args: ['-e', helper], timeoutMs: 6000 }, out, env);
      assert.equal(nested.status, 'PASS');
      const inner = JSON.parse(fs.readFileSync(path.join(out, 'pipe-helper.log'), 'utf8'));
      assert.equal(inner.status, 'FAIL');
      assert.equal(inner.reaped, false);
      assert.equal(inner.cleanupUncertain, true);
      assert.equal(inner.directChildExited, true);
      assert.equal(inner.closeObserved, false);
    } finally {
      if (fs.existsSync(pidFile)) {
        const { pid, startStamp } = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
        const proc = `/proc/${pid}`;
        // Both birth stamp and marker came from the test-owned spawn, never an arbitrary process search.
        if (Number.isSafeInteger(pid) && pid > 0 && fs.existsSync(`${proc}/cmdline`)) {
          const stat = fs.readFileSync(`${proc}/stat`, 'utf8');
          assert.match(startStamp, /^\d+$/);
          assert.equal(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], startStamp);
          assert.ok(fs.readFileSync(`${proc}/cmdline`, 'utf8').split('\0').includes(marker));
          process.kill(pid, 'SIGKILL');
          for (let i = 0; i < 40; i++) {
            if (!fs.existsSync(`${proc}/stat`) || /\) Z /.test(fs.readFileSync(`${proc}/stat`, 'utf8'))) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          assert.ok(!fs.existsSync(`${proc}/stat`) || /\) Z /.test(fs.readFileSync(`${proc}/stat`, 'utf8')));
        }
      }
    }
    assert.throws(() => safeFile('../package.json'));
    fs.symlinkSync(path.join(ROOT, 'package.json'), path.join(out, 'link'));
    assert.throws(() => safeFile(path.relative(ROOT, path.join(out, 'link'))));
    console.log('PASS: finite runner, failure receipt, owned timeout, path and environment isolation');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}
async function main() {
  runtime();
  if (process.argv.length === 3 && process.argv[2] === '--self-test') return selfTest();
  if (process.argv.length !== 2) throw new Error('usage: node scripts/check-cloud.mjs [--self-test]');
  const out = outputDirectory('checks');
  const env = isolatedEnvironment(out);
  const report = { ...metadata(), startedAt: new Date().toISOString(), status: 'RUNNING', results: [] };
  const steps = [
    ...BUILD_STEPS,
    {
      name: 'focused',
      args: ['--test', '--test-concurrency=1', ...FOCUSED_TESTS.map((name) => `dist-test/tests/unit/${name}.test.js`)],
      timeoutMs: 180000,
    },
    ...DEMOS.map((name) => ({ name, args: [`scripts/${name}.mjs`], timeoutMs: 30000 })),
  ];
  try {
    for (const step of steps) {
      const result = await runStep(step, out, env);
      report.results.push(result);
      console.log(`${result.status}: ${step.name}`);
      if (result.status !== 'PASS') break;
    }
    report.status =
      report.results.length === steps.length && report.results.every((r) => r.status === 'PASS') ? 'PASS' : 'FAIL';
    report.notRun = steps.slice(report.results.length).map((s) => s.name);
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    fs.rmSync(path.join(out, 'home'), { recursive: true, force: true });
    fs.rmSync(path.join(out, 'temp'), { recursive: true, force: true });
    console.log(`Cloud results: ${path.relative(ROOT, out)}/results.json`);
  }
  if (report.status !== 'PASS') process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
