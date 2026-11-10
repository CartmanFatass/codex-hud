#!/usr/bin/env node
/** Synthetic cold-refusal hook + real pinned role-MCP startup measurements; no model/herdr. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
const [source] = process.argv.slice(2);
if (!path.isAbsolute(source ?? '')) throw Error('usage: node tests/integration/r6a-claude-cost.mjs ABS_PLUGIN');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-claude-cost-'));
fs.chmodSync(root, 0o700);
const home = path.join(root, 'home');
fs.mkdirSync(home, { mode: 0o700 });
for (const name of ['hud', 'codex', '.claude']) fs.mkdirSync(path.join(home, name), { mode: 0o700 });
const plugin = path.join(root, 'plugin with spaces');
fs.cpSync(source, plugin, { recursive: true });
const bindingFile = path.join(plugin, 'binding.json'),
  binding = JSON.parse(fs.readFileSync(bindingFile));
binding.hudHome = path.join(home, 'hud');
binding.parityInventory = null;
fs.writeFileSync(bindingFile, JSON.stringify(binding), { mode: 0o600 });
const env = {
  PATH: process.env.PATH,
  HOME: home,
  HUD_HOME: binding.hudHome,
  CODEX_HOME: path.join(home, 'codex'),
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  CLAUDE_PLUGIN_ROOT: plugin,
};
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
};
const result = {
  host: {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    cpus: os.cpus().length,
    node: process.version,
  },
  scope:
    '20 cold invocations per hook on this host; identity refusal (no live Claude/herdr); adapter real role initialize. Not WSL qualification.',
  hook: {},
  mcp: {},
};
for (const [name, input] of Object.entries({
  start: { hook_event_name: 'SessionStart', session_id: 'synthetic' },
  end: { hook_event_name: 'SessionEnd', session_id: 'synthetic' },
  command: {
    hook_event_name: 'UserPromptExpansion',
    expansion_type: 'slash_command',
    command_name: 'hud:hud',
    command_args: 'status',
    session_id: 'synthetic',
  },
})) {
  const hooks = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks/hooks.json')));
  const event = name === 'start' ? 'SessionStart' : name === 'end' ? 'SessionEnd' : 'UserPromptExpansion';
  const command = hooks.hooks[event][0].hooks[0].command;
  const values = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const out = spawnSync('/bin/sh', ['-c', command], {
      env,
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 5000,
    });
    if (out.status !== 0 || out.error) throw Error('hook_cost_failed');
    const reply = JSON.parse(out.stdout);
    if (
      name === 'command'
        ? reply.decision !== 'block' || !/^HUD: identity_unverified$/.test(reply.reason)
        : !/^HUD: identity_unverified$/.test(reply.systemMessage)
    )
      throw Error('hook_cost_wrong_path');
    values.push(performance.now() - start);
  }
  result.hook[name] = stats(values);
}
const startup = [],
  rss = [];
function memory(pid) {
  try {
    const kb = Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0);
    const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
    return kb + children.reduce((sum, p) => sum + memory(Number(p)), 0);
  } catch {
    return 0;
  }
}
for (let i = 0; i < 20; i++) {
  const start = performance.now();
  const child = spawn(binding.node, [path.join(plugin, 'scripts/mcp.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '',
    errors = '';
  child.stderr.on('data', (b) => (errors += b));
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error('mcp_cost_timeout'));
    }, 5000);
    child.stdout.on('data', (b) => {
      out += b;
      const line = out.split('\n').find((v) => v.startsWith('{') && v.includes('"id":1'));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line));
      }
    });
    child.once('error', reject);
  });
  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'synthetic-cost', version: '1' } },
    }) + '\n'
  );
  const initialized = await reply;
  if (!initialized.result) throw Error('mcp_initialize_failed: ' + errors);
  startup.push(performance.now() - start);
  rss.push(memory(child.pid));
  child.stdin.end();
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
result.mcp = {
  startupMs: stats(startup),
  rssKiB: stats(rss),
  rssScope: 'adapter + live descendants at initialize response, /proc VmRSS sum; not peak RSS',
};
console.log(JSON.stringify(result, null, 2));
