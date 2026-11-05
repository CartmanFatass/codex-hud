// SYNTHETIC native Claude 2.1.305 protocol driver. No provider or installed client.
// The parent C fixture owns every hook spawn. This Node process must NOT spawn
// hooks itself: its long-lived ancestry would falsify the outermost-hook timing.
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.env.SYNTHETIC_CLAUDE_REPO;
if (!repo?.startsWith('/')) throw new Error('synthetic_repository_required');
const { deriveProcessDomain, readProcessDomainInputs } = await import(
  pathToFileURL(join(repo, 'dist/core/process-domain.js'))
);
const argv = process.argv.slice(2);
const after = (flag) => argv[argv.indexOf(flag) + 1];
const resumed = argv.includes('--resume');
const sessionId = resumed ? after('--resume') : randomUUID();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId))
  throw new Error('synthetic_invalid_session');
const source = process.env.CLAUDE_CONFIG_DIR;
const parent = process.ppid;
const parentStart = readFileSync(`/proc/${parent}/stat`, 'utf8').split(') ').at(-1).trim().split(/\s+/)[19];
const domain = deriveProcessDomain(readProcessDomainInputs());
mkdirSync(join(source, 'sessions'), { recursive: true, mode: 0o700 });
writeFileSync(
  join(source, 'sessions', `${parent}.json`),
  JSON.stringify({
    pid: parent,
    procStart: parentStart,
    pidDomain: domain.claudePidDomain,
    sessionId,
    cwd: process.cwd(),
  }),
  { mode: 0o600, flag: 'wx' }
);
let briefBytes = 0;
for await (const chunk of process.stdin) {
  briefBytes += chunk.length;
  if (briefBytes > 400000) throw new Error('synthetic_brief_limit');
}
const config = JSON.parse(readFileSync(after('--mcp-config'), 'utf8'));
const named = Object.entries(config.mcpServers);
if (named.length !== 1) throw new Error('synthetic_expected_one_overlay');
const [serverName, server] = named[0];
const authority = server.env;
const hookPath = authority.HUD_CLAUDE_HOOK_CONFIG;
if (typeof hookPath !== 'string' || hookPath.includes('\n')) throw new Error('synthetic_hook_path_required');
const hook = JSON.parse(readFileSync(hookPath, 'utf8'));
if (hook.serverName !== serverName) throw new Error('synthetic_hook_server_mismatch');
if (!server?.command || !argv.includes('--settings')) throw new Error('synthetic_launch_missing_artifact');
const requests = createWriteStream('', { fd: 3, autoClose: true });
const replies = createInterface({ input: createReadStream('', { fd: 4, autoClose: true }) });
const hookReplies = replies[Symbol.asyncIterator]();
const mcp = spawn(server.command, server.args ?? [], {
  cwd: process.cwd(),
  env: { ...process.env, ...server.env },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
mcp.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-8192);
});
const closed = new Promise((resolve) => mcp.once('close', (code, signal) => resolve({ code, signal })));
const lines = createInterface({ input: mcp.stdout });
const pending = new Map();
let id = 0;
lines.on('line', (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  const waiter = pending.get(frame.id);
  if (waiter) {
    pending.delete(frame.id);
    waiter(frame);
  }
});
function rpc(method, params) {
  const request = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(request);
      reject(new Error('synthetic_mcp_response_unknown'));
    }, 5000);
    pending.set(request, (frame) => {
      clearTimeout(timer);
      resolve(frame);
    });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: request, method, params }) + '\n');
  });
}
async function call(name, args = {}) {
  const callId = randomUUID();
  requests.write(
    hookPath +
      '\n' +
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_use_id: callId,
        tool_name: `mcp__${hook.serverName}__${name}`,
        session_id: sessionId,
      }) +
      '\n'
  );
  const reply = await hookReplies.next();
  if (reply.done || reply.value !== '0') throw new Error('synthetic_hook_failed');
  const result = await rpc('tools/call', { name, arguments: args, _meta: { 'claudecode/toolUseId': callId } });
  if (result.error || !result.result?.structuredContent) throw new Error('synthetic_mcp_outcome_unknown');
  return result.result.structuredContent;
}
let output;
try {
  const initialized = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'synthetic-claude', version: '2.1.305' },
  });
  if (initialized.error) throw new Error('synthetic_initialize_failed');
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  let who;
  for (let attempt = 0; attempt < 8; attempt++) {
    who = await call('delegate_whoami');
    if (who.ok && who.state === 'bound') break;
    if (!who.ok || who.state !== 'pending') throw new Error(`synthetic_whoami_refused:${who.code ?? who.reason}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (who?.state !== 'bound' || who.runId !== authority.HUD_RUN) throw new Error('synthetic_bind_unconfirmed');
  const nested = await call('delegate_spawn', {
    backend: authority.HUD_MCP_PROFILE,
    role: 'worker',
    brief: join(source, '.claude.json'),
    cwd: process.cwd(),
    mode: 'headless',
    request_key: `nested-${randomUUID()}`,
  });
  const report = await call('delegate_report', {
    runId: authority.HUD_RUN,
    status: 'completed',
    summary: 'Synthetic managed Claude complete',
  });
  if (!report.ok) throw new Error(`synthetic_report_refused:${report.code}`);
  output = { synthetic: true, sessionId, resumed, briefBytes, who, report, nested };
} catch (error) {
  output = { synthetic: true, sessionId, resumed, error: String(error.message), mcpStderr: stderr };
  process.exitCode = 1;
} finally {
  mcp.stdin.end();
  const settled = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(null), 2000))]);
  if (!settled) {
    if (mcp.exitCode === null && mcp.signalCode === null) mcp.kill('SIGTERM');
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
    if (mcp.exitCode === null && mcp.signalCode === null) mcp.kill('SIGKILL');
    output.cleanupUnconfirmed = true;
    process.exitCode = 1;
  } else if (settled.code !== 0 || settled.signal !== null) {
    output.mcpExit = settled;
    process.exitCode = 1;
  }
  requests.end();
  replies.close();
  process.stdout.write(JSON.stringify(output) + '\n');
}
