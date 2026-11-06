import test from 'node:test';
import assert from 'node:assert/strict';
import { runNativeScenario } from '../fixtures/managed-native-runner.js';
test(
  'SIMULATED strict production matcher → DelegationService → hud-run → whoami/report → scope end and exact-session resume',
  { timeout: 50000, skip: process.platform !== 'linux' },
  async (t) => {
    const result = await runNativeScenario(true);
    assert.equal(result.dispatches, 2);
    t.diagnostic(JSON.stringify(result));
  }
);

import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readProcess } from '../../src/core/run/process.js';
for (const kind of ['missing', 'malformed'] as const)
  test(`default main keeps MCP available with ${kind} bundled capability JSON`, { timeout: 15000 }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'managed-native-default-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const output = join(root, 'packages/hud-mcp/dist');
    mkdirSync(output, { recursive: true, mode: 0o700 });
    cpSync(resolve('packages/hud-mcp/dist'), output, {
      recursive: true,
      filter: (path) => !path.includes('/dist/tests'),
    });
    cpSync(resolve('bin'), join(root, 'bin'), { recursive: true });
    cpSync(resolve('extensions'), join(root, 'extensions'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}', { mode: 0o600 });
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
    for (const name of ['codex', 'managed']) {
      const file = join(output, `src/core/launch/${name}-cells.json`);
      if (kind === 'missing') rmSync(file);
      else writeFileSync(file, '{malformed');
    }
    const home = join(root, 'hud');
    mkdirSync(home, { mode: 0o700 });
    const child = spawn(process.execPath, [join(output, 'packages/hud-mcp/src/main.js')], {
      cwd: root,
      env: { HOME: root, HUD_HOME: home, PATH: process.env.PATH },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stamp = child.pid ? readProcess(child.pid)?.stamp : null;
    const deadlineAt = Date.now() + 10000;
    const exit = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    let stderr = '';
    child.stderr.on('data', (b) => (stderr += b));
    const lines = createInterface({ input: child.stdout });
    const frames = new Map<number, any>();
    const response = new Promise<Map<number, any>>((resolve, reject) => {
      lines.on('line', (line) => {
        try {
          const frame = JSON.parse(line);
          frames.set(frame.id, frame);
          if (frames.size === 3) resolve(frames);
        } catch (error) {
          reject(error);
        }
      });
      child.once('close', (code) => reject(Error(`main_closed:${code}:${stderr}`)));
    });
    const timer = setTimeout(() => {
      if (child.pid && readProcess(child.pid)?.stamp.proc_start === stamp?.proc_start) child.kill('SIGTERM');
    }, 10000);
    try {
      for (const [id, method, params] of [
        [
          1,
          'initialize',
          { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'SIMULATED', version: '1' } },
        ],
        [2, 'ping', {}],
        [3, 'tools/list', {}],
      ] as const)
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const received = await response;
      assert.ok(received.get(1)?.result.serverInfo);
      assert.deepEqual(received.get(2)?.result, {});
      const frame = received.get(3);
      assert.ok(frame.result.tools.some((tool: { name: string }) => tool.name === 'delegate_list'));
      assert.ok(frame.result.tools.some((tool: { name: string }) => tool.name === 'delegate_status'));
      child.stdin.end();
      const end = await exit;
      assert.deepEqual(end, { code: 0, signal: null });
      assert.equal(child.pid ? readProcess(child.pid) : null, null);
      t.diagnostic(
        JSON.stringify({ synthetic: true, kind, pid: child.pid, start: stamp, deadlineAt, end, alive: false })
      );
    } finally {
      clearTimeout(timer);
      lines.close();
    }
  });
