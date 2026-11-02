import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [major, minor] = process.versions.node.split('.').map(Number);
if (!((major === 22 && minor >= 13) || major >= 24)) {
  console.log('SKIP hud-mcp process benchmark: Node 22.x >=22.13 or Node >=24 required (23 unsupported)');
  process.exit(0);
}
const home = mkdtempSync(join(tmpdir(), 'hud-mcp-bench-'));
const children = new Set();
const stop = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.stdin.end();
  });
  children.delete(child);
};
function client() {
  const started = performance.now();
  const child = spawn(process.execPath, ['packages/hud-mcp/bin/hud-mcp.mjs'], {
    env: { ...process.env, HUD_HOME: home, HUD_MCP_PROFILE: '', HUD_MCP_REGISTRY_DIR: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  let buffer = '';
  let sequence = 0;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const row = JSON.parse(line);
      const resolve = pending.get(row.id);
      pending.delete(row.id);
      resolve?.(row);
    }
  });
  let error = '';
  child.stderr.on('data', (data) => (error += data));
  child.on('exit', (code) => {
    if (code) for (const resolve of pending.values()) resolve({ error: { message: error } });
  });
  return {
    child,
    started,
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => reject(new Error(`MCP deadline: ${method}: ${error}`)), 5000);
        pending.set(id, (row) => {
          clearTimeout(timer);
          if (row.error) reject(new Error(row.error.message));
          else resolve(row.result);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      }),
  };
}
const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
try {
  const cold = [];
  for (let i = 0; i < 30; i++) {
    const c = client();
    await c.request('initialize', { protocolVersion: '2025-06-18' });
    cold.push(performance.now() - c.started);
    await stop(c.child);
  }
  const c = client();
  await c.request('initialize', { protocolVersion: '2025-06-18' });
  const list = [],
    whoami = [];
  for (let i = 0; i < 200; i++) {
    let start = performance.now();
    const tools = await c.request('tools/list', {});
    list.push(performance.now() - start);
    if (tools.tools.length !== 7) throw new Error('tool count');
    start = performance.now();
    const result = await c.request('tools/call', { name: 'delegate_whoami', arguments: {} });
    whoami.push(performance.now() - start);
    if (result.structuredContent.code !== 'identity_source_missing') throw new Error('fail-closed stub missing');
  }
  await stop(c.child);
  const result = {
    node: process.version,
    coldSamples: cold.length,
    callsPerMethod: 200,
    coldP95Ms: p95(cold),
    coldMaxMs: Math.max(...cold),
    toolsListP95Ms: p95(list),
    whoamiRefusalP95Ms: p95(whoami),
    profile: 'default unconfigured; physical registration plus fail-closed whoami stub',
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.coldP95Ms >= 200 || result.toolsListP95Ms >= 50 || result.whoamiRefusalP95Ms >= 50)
    throw new Error('performance gate exceeded');
} finally {
  for (const child of children) {
    child.kill('SIGKILL');
  }
  rmSync(home, { recursive: true, force: true });
}
