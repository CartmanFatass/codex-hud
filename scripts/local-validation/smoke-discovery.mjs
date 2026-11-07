/** Stdio discovery for hud-mcp. Does not call managed_create or start a native host. */
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setupHome, REPO_ROOT, CODEX_MODEL, CODEX_EFFORT } from './setup-home.mjs';

const MCP = join(REPO_ROOT, 'packages/hud-mcp/bin/hud-mcp.mjs');
const MANAGED = [
  'managed_create',
  'managed_send',
  'managed_ask',
  'managed_wait',
  'managed_read',
  'managed_status',
  'managed_list',
  'managed_requests',
  'managed_respond',
  'managed_cancel',
  'managed_close',
];
const JEV = ['jev_create', 'jev_run', 'jev_snapshot', 'jev_command', 'jev_close', 'jev_list'];
const DROP = [
  'HUD_CALLER_ID',
  'HUD_CONTEXT_ID',
  'HUD_CONTEXT_GENERATION',
  'HUD_PI_EVIDENCE_FD',
  'HUD_PI_DELEGATION_FD',
  'HUD_MCP_REGISTRY_DIR',
  'HUD_RUN_PORT_MODULE',
  'HUD_CLAIM',
  'HUD_RUN',
  'HUD_LINK',
  'HUD_OWNER_ID',
  'HUD_CONTEXT',
  'HUD_NATIVE_SOURCE',
  'HUD_NATIVE_SOURCE_FILE',
  'HUD_CLAUDE_HOOK_CONFIG',
  'HUD_MCP_PROFILE',
];
const children = new Set();

function fail(message) {
  throw new Error(message);
}
function onPath(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    try {
      return realpathSync(join(directory, name));
    } catch {
      /* Next PATH entry. */
    }
  }
  fail(`${name} is not on PATH`);
}
function piEntrypoint() {
  const launcher = onPath('pi');
  const version = readFileSync(join(dirname(dirname(launcher)), 'install', 'current-version'), 'utf8').trim();
  if (!/^[\w.+-]+$/.test(version)) fail('installed pi current-version is not a single token');
  const entry = realpathSync(
    join(dirname(dirname(launcher)), 'install', 'releases', version, 'node_modules', '.bin', 'pi')
  );
  let directory = dirname(entry);
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (pkg.name === '@earendil-works/pi-coding-agent') {
        const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
        if (realpathSync(join(directory, bin)) !== entry) fail('pi package bin does not match the launcher');
        return entry;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && !String(error?.message ?? '').includes('package bin')) throw error;
    }
    directory = dirname(directory);
  }
  fail('could not resolve the installed pi package entrypoint');
}
function baseEnv() {
  const env = { ...process.env };
  for (const key of DROP) delete env[key];
  return env;
}
function codexEnv(home) {
  const env = {};
  for (const key of ['HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.HUD_HOME = home;
  env.HUD_MCP_PROFILE = 'codex';
  return env;
}
function claudeEnv(home, hookPath) {
  return { ...baseEnv(), HUD_HOME: home, HUD_MCP_PROFILE: 'claude', HUD_CLAUDE_HOOK_CONFIG: hookPath };
}
function piEnv(home) {
  return { ...baseEnv(), HUD_HOME: home, HUD_MCP_PROFILE: 'pi', HUD_PI_DELEGATION_FD: '3' };
}
function track(child) {
  if (typeof child.pid === 'number') children.add(child.pid);
  child.once('exit', () => {
    if (typeof child.pid === 'number') children.delete(child.pid);
  });
  return child;
}
function spawnGroup(command, args, options) {
  return track(spawn(command, args, { ...options, detached: true }));
}
async function reap(pid) {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* Already gone. */
      }
    }
    if (signal === 'SIGTERM') await new Promise((resolve) => setTimeout(resolve, 400));
  }
}
async function reapAll() {
  const leftover = [...children];
  for (const pid of leftover) await reap(pid);
  return leftover;
}
function requestTools(child, extraWritable) {
  const messages = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'lv-smoke', version: '0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ];
  return new Promise((resolve, reject) => {
    let buffer = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error('timed out waiting for tools/list')), 10000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onOut);
      child.off('exit', onExit);
      if (error) reject(Object.assign(error, { stderr }));
      else resolve(value);
    };
    const take = (line) => {
      if (!line.trim()) return false;
      try {
        const message = JSON.parse(line);
        if (message.id === 2) {
          child.stdin?.end();
          extraWritable?.end();
          finish(null, { message, pid: child.pid, stderr });
          return true;
        }
      } catch {
        /* Ignore non-JSON diagnostics on stdout. */
      }
      return false;
    };
    const onOut = (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (take(line)) return;
      }
    };
    const onExit = (code, signal) => {
      if (!take(buffer)) finish(new Error(`hud-mcp exited before tools/list (${code ?? signal})`));
    };
    child.stdout.on('data', onOut);
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('exit', onExit);
    child.stdin.on('error', () => {});
    child.stdin.write(`${messages.map((message) => JSON.stringify(message)).join('\n')}\n`);
  });
}
function namesFrom(message) {
  const tools = message?.result?.tools;
  if (!Array.isArray(tools)) fail(`tools/list did not return tools: ${JSON.stringify(message?.error ?? message)}`);
  return tools.map((tool) => tool?.name).filter((name) => typeof name === 'string');
}
function assertDiscovery(names) {
  const missing = [...MANAGED, ...JEV].filter((name) => !names.includes(name));
  const delegated = names.filter((name) => name.startsWith('delegate_'));
  if (
    missing.length ||
    delegated.length ||
    !names.some((name) => name.startsWith('managed_')) ||
    !names.some((name) => name.startsWith('jev_'))
  ) {
    fail(
      `discovery mismatch missing=${missing.join(',') || '-'} delegate=${delegated.join(',') || '-'} saw=${names.join(',')}`
    );
  }
}
async function waitExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  const code = await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000)),
  ]);
  if (code === 'timeout') {
    await reap(child.pid);
    fail(`pid ${child.pid} did not exit and was killed`);
  }
  return code;
}
async function probe(label, env) {
  const child = spawnGroup(process.execPath, [MCP], { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let result;
  try {
    result = await requestTools(child);
    const names = namesFrom(result.message);
    assertDiscovery(names);
    const code = await waitExit(child);
    process.stdout.write(`${label} stdio pid=${result.pid} exit=${code} tools=${names.join(',')}\n`);
    return names;
  } catch (error) {
    await reap(child.pid);
    const detail = error?.stderr ? ` stderr=${String(error.stderr).trim()}` : '';
    fail(`${label} stdio failed: ${error instanceof Error ? error.message : error}${detail}`);
  }
}
async function probePi(home) {
  const entry = piEntrypoint();
  const parent = spawnGroup(process.execPath, [fileURLToPath(import.meta.url), '--pi-parent', home, entry], {
    argv0: 'pi',
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  parent.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  parent.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await Promise.race([
    new Promise((resolve) => parent.once('exit', resolve)),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 12000)),
  ]);
  if (code === 'timeout') {
    await reap(parent.pid);
    fail(`pi stdio timed out stderr=${stderr.trim()}`);
  }
  if (code !== 0) {
    await reap(parent.pid);
    fail(`pi stdio parent exit=${code} stderr=${stderr.trim()} stdout=${stdout.trim()}`);
  }
  process.stdout.write(stdout.endsWith('\n') ? stdout : `${stdout}\n`);
}
async function piParent(home, entry) {
  const child = spawn(process.execPath, [MCP], {
    cwd: REPO_ROOT,
    env: piEnv(home),
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  if (typeof child.pid === 'number') children.add(child.pid);
  child.once('exit', () => {
    if (typeof child.pid === 'number') children.delete(child.pid);
  });
  const hello = {
    kind: 'host',
    profile: 'hud-pi-extension-v1',
    pid: process.pid,
    entrypoint: entry,
    sourceRoot: join(home, 'pi-sessions'),
    argv: ['pi', entry, '--session-dir', join(home, 'pi-sessions')],
  };
  child.stdio[3].write(`${JSON.stringify(hello)}\n`);
  const result = await requestTools(child, child.stdio[3]);
  const names = namesFrom(result.message);
  assertDiscovery(names);
  const code = await waitExit(child);
  process.stdout.write(`pi stdio pid=${child.pid} parent=${process.pid} exit=${code} tools=${names.join(',')}\n`);
}
function toml(value) {
  return JSON.stringify(value);
}
function modelPlan(layout) {
  const prompt = 'List the hud MCP tool names you can see. Reply with only the names, one per line.';
  const node = process.execPath;
  const wrapper = join(process.env.HOME ?? '', 'codex/codex-hud/bin/codex-with-herdr-context');
  const binary = join(process.env.HOME ?? '', '.local/bin/codex');
  return {
    codex: {
      command: wrapper,
      args: [
        binary,
        '-m',
        CODEX_MODEL,
        '-c',
        `model_reasoning_effort=${toml(CODEX_EFFORT)}`,
        '-c',
        `mcp_servers.hud.command=${toml(node)}`,
        '-c',
        `mcp_servers.hud.args=[${toml(MCP)}]`,
        '-c',
        `mcp_servers.hud.env.HUD_HOME=${toml(layout.home)}`,
        '-c',
        'mcp_servers.hud.env.HUD_MCP_PROFILE="codex"',
        'exec',
        prompt,
      ],
      env: { ...process.env, CODEX_HOME: layout.codexHome },
    },
    claude: {
      command: 'claude',
      args: [
        '-p',
        '--model',
        layout.claudeModel,
        '--mcp-config',
        layout.mcpPath,
        '--strict-mcp-config',
        '--settings',
        layout.settingsPath,
        prompt,
      ],
      env: claudeEnv(layout.home, layout.hookPath),
    },
    pi: {
      command: 'pi',
      args: [
        '--session-dir',
        layout.piSessions,
        '--no-extensions',
        '--no-mcp',
        '-e',
        join(REPO_ROOT, 'extensions/pi/hud-delegate.ts'),
        '-e',
        join(REPO_ROOT, 'integrations/pi/hud-wake.ts'),
        '-p',
        prompt,
      ],
      env: { ...baseEnv(), HUD_HOME: layout.home, HUD_MCP_PROFILE: 'pi' },
    },
  };
}
async function runModel(harness, spec) {
  const child = spawnGroup(spec.command, spec.args, {
    cwd: REPO_ROOT,
    env: spec.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 120000)),
  ]);
  if (code === 'timeout') await reap(child.pid);
  process.stdout.write(
    `${harness} model pid=${child.pid} exit=${code}\ncommand=${spec.command} ${spec.args.map((arg) => JSON.stringify(arg)).join(' ')}\n${stdout}\n${stderr}`
  );
  if (code !== 0) fail(`${harness} --with-model failed`);
}
function assertHookCovers(settingsPath, names) {
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    fail(`claude.settings.json is not readable JSON: ${error instanceof Error ? error.message : error}`);
  }
  const entries = settings?.hooks?.PreToolUse;
  if (!Array.isArray(entries) || entries.length === 0) fail('claude.settings.json has no PreToolUse matcher');
  const patterns = [];
  for (const entry of entries) {
    if (typeof entry?.matcher !== 'string') fail('claude.settings.json PreToolUse entry has no matcher');
    try {
      patterns.push(new RegExp(entry.matcher));
    } catch (error) {
      fail(`claude.settings.json matcher is not a regex: ${error instanceof Error ? error.message : error}`);
    }
  }
  const missed = names.filter((name) => !patterns.some((pattern) => pattern.test(`mcp__hud__${name}`)));
  if (missed.length) fail(`claude hook matcher misses tools/list names: ${missed.join(',')}`);
  process.stdout.write(`claude hook matcher covers ${names.length} tools/list names\n`);
}
async function verifyLoaders(layout) {
  const configUrl = pathToFileURL(join(REPO_ROOT, 'packages/hud-mcp/dist/packages/hud-mcp/src/config.js')).href;
  const recordUrl = pathToFileURL(join(REPO_ROOT, 'packages/hud-mcp/dist/packages/hud-mcp/src/hook/record.js')).href;
  const { loadNativeHostConfig, loadNativeSourceConfig } = await import(configUrl);
  const { hookProfileFingerprint: builtFingerprint } = await import(recordUrl);
  loadNativeHostConfig(layout.home);
  const sources = loadNativeSourceConfig(join(layout.home, 'delegate.json'));
  const claude = sources.profiles.find((profile) => profile.name === 'claude');
  const hook = JSON.parse(readFileSync(layout.hookPath, 'utf8'));
  if (!claude || hook.profileFingerprint !== builtFingerprint(claude))
    fail('claude hook fingerprint does not match the built profile');
}
async function main() {
  if (process.argv[2] === '--pi-parent') {
    await piParent(process.argv[3], process.argv[4]);
    return;
  }
  const withModel = process.argv.includes('--with-model');
  const positional = process.argv.slice(2).filter((arg) => arg !== '--with-model');
  if (positional.length > 1) fail('usage: node scripts/local-validation/smoke-discovery.mjs [HUD_HOME] [--with-model]');
  const layout = await setupHome(positional[0]);
  await verifyLoaders(layout);
  await probe('codex', codexEnv(layout.home));
  const claudeNames = await probe('claude', claudeEnv(layout.home, layout.hookPath));
  assertHookCovers(layout.settingsPath, claudeNames);
  await probePi(layout.home);
  if (withModel) {
    const plan = modelPlan(layout);
    for (const harness of ['codex', 'claude', 'pi']) await runModel(harness, plan[harness]);
  }
  const leftover = await reapAll();
  if (leftover.length) fail(`processes still live after reap: ${leftover.join(',')}`);
  process.stdout.write('reaped=none\n');
}
process.on('exit', () => {
  for (const pid of children) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* Already gone. */
      }
    }
  }
});
try {
  await main();
} catch (error) {
  await reapAll();
  process.stderr.write(`${error instanceof Error ? error.message : 'smoke failed'}\n`);
  process.exitCode = 1;
}
