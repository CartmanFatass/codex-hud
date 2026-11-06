import './managed-native-scenario.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProcess } from '../../src/core/run/process.js';
export async function runNativeScenario(integration: boolean, parentVersion = '0.166.0', targetVersion = '0.166.0') {
  const root = mkdtempSync(join(tmpdir(), 'managed-native-owned-'));
  mkdirSync(join(root, 'source'));
  mkdirSync(join(root, 'home'));
  const executable = join(root, 'codex');
  const compilerReceipts: unknown[] = [];
  const compile = async (args: string[]) => {
    const child = spawn('cc', args, {
      env: { HOME: join(root, 'home'), PATH: process.env.PATH },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const start = child.pid ? readProcess(child.pid)?.stamp : null;
    const deadlineAt = Date.now() + 10000;
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      if (child.pid && readProcess(child.pid)?.stamp.proc_start === start?.proc_start) child.kill('SIGTERM');
    }, 10000);
    try {
      const end = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res, rej) => {
        child.once('error', rej);
        child.once('close', (code, signal) => res({ code, signal }));
      });
      assert.equal(end.code, 0, stderr);
      const alive = child.pid ? readProcess(child.pid)?.stamp.proc_start === start?.proc_start : false;
      assert.equal(alive, false);
      compilerReceipts.push({ pid: child.pid, start, deadlineAt, end, alive });
    } finally {
      clearTimeout(timer);
    }
  };
  await compile([
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    `-DSIMULATED_VERSION="${parentVersion}"`,
    resolve('tests/fixtures/managed-native-codex.c'),
    '-o',
    executable,
  ]);
  {
    mkdirSync(join(root, 'target-bin'));
    await compile([
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      `-DSIMULATED_VERSION="${targetVersion}"`,
      resolve('tests/fixtures/managed-native-codex.c'),
      '-o',
      join(root, 'target-bin', 'codex'),
    ]);
  }
  const start = Date.now(),
    deadlineAt = start + 45000;
  const child = spawn(
    executable,
    [
      '--scenario',
      root,
      parentVersion !== '0.166.0'
        ? 'parent-mismatch'
        : targetVersion !== '0.166.0'
          ? 'target-mismatch'
          : integration
            ? 'integration'
            : 'unit',
    ],
    {
      cwd: resolve('.'),
      env: {
        HOME: join(root, 'home'),
        PATH: process.env.PATH,
        CODEX_HOME: join(root, 'source'),
        SYNTHETIC_NATIVE_NODE: process.execPath,
        SYNTHETIC_NATIVE_DRIVER: fileURLToPath(new URL('./managed-native-scenario.js', import.meta.url)),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const stamp = child.pid ? readProcess(child.pid)?.stamp : null;
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (b) => (stdout += b));
  child.stderr.on('data', (b) => (stderr += b));
  const timer = setTimeout(() => {
    if (child.pid && readProcess(child.pid)?.stamp.proc_start === stamp?.proc_start) child.kill('SIGTERM');
  }, 45000);
  try {
    const end = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res, rej) => {
      child.once('error', rej);
      child.once('close', (code, signal) => res({ code, signal }));
    });
    assert.equal(end.code, 0, JSON.stringify({ stdout, stderr, end, root }));
    const result = JSON.parse(stdout.trim());
    assert.equal(child.pid ? readProcess(child.pid) : null, null);
    return {
      ...result,
      compilerReceipts,
      ownedParent: {
        pid: child.pid,
        start: stamp,
        startedAt: start,
        deadlineAt,
        end,
        endedAt: Date.now(),
        alive: false,
      },
    };
  } finally {
    clearTimeout(timer);
    rmSync(root, { recursive: true, force: true });
  }
}
