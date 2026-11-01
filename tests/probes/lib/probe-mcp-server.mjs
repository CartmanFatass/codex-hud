#!/usr/bin/env node
// Minimal stdio MCP server used by the A3 probes.
//
// It answers initialize / tools/list / tools/call for one tool, probe_whoami,
// and appends one JSON line per lifecycle event to $PROBE_OUT (and, when set,
// $PROBE_OUT_SHARED). Each line records the server process, its parent chain up
// to pid 1, a small allowlist of environment keys and, for calls, the full
// request params (including params._meta).
//
// The output path is run-owned: $PROBE_OUT comes from the harness's MCP env
// table, and when the harness clears the environment the probe passes the path
// as the second command-line argument (absolute paths only; a relative second
// argument is a per-run config token, not a path). There is no shared fallback
// path, so one run can never read or delete another run's records.
//
// No dependencies: newline-delimited JSON-RPC over stdin/stdout.
import fs from 'node:fs';
import path from 'node:path';

const ARG_OUT = process.argv[2] && path.isAbsolute(process.argv[2]) ? process.argv[2] : '';
const OUT = process.env.PROBE_OUT || ARG_OUT;
const SHARED = process.env.PROBE_OUT_SHARED || '';
const SELECTED_ENV = /^(HUD_|PROBE_|HERDR_)/;
// Credential-looking keys are always redacted, whatever their value.
const CREDENTIAL_KEY = /(claim|token|secret|password|passwd|credential|key|auth)/i;
// Values are recorded only when they are probe-owned synthetic sentinels: the
// `probe-` prefix the probes set, or this server's own output paths. Everything
// else is recorded name-only (the key stays in `env` with a redacted value and
// in `envNames`), so a credential in the environment cannot reach the evidence.
const SENTINEL = /^probe-/;
const CHAIN_LIMIT = 24;

function redactValue(key, value) {
  if (CREDENTIAL_KEY.test(key)) return '<redacted>';
  if (SENTINEL.test(value) || value === OUT || value === SHARED) return value;
  return '<redacted>';
}

function selectedEnv() {
  const env = {};
  const claudeKeys = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('CLAUDE')) {
      // Never record CLAUDE* values, only their names.
      claudeKeys.push(key);
      continue;
    }
    if (SELECTED_ENV.test(key) || key === 'CODEX_HOME' || key === 'TMUX_PANE') {
      env[key] = redactValue(key, value);
    }
  }
  claudeKeys.sort();
  return { env, claudeKeys };
}

function procInfo(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const open = stat.indexOf('(');
    const close = stat.lastIndexOf(')');
    const comm = stat.slice(open + 1, close);
    // Fields after "comm)": state ppid ... (field 3 is state, field 4 is ppid).
    const rest = stat.slice(close + 2).split(' ');
    const ppid = Number(rest[1]);
    let argv0 = '';
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      argv0 = (cmdline.split('\0')[0] || '').slice(0, 160);
    } catch {
      argv0 = '';
    }
    return { pid, comm, argv0, ppid: Number.isFinite(ppid) ? ppid : null };
  } catch {
    return null;
  }
}

function parentChain() {
  const chain = [];
  const self = procInfo(process.pid);
  let cursor = self ? self.ppid : null;
  for (let i = 0; i < CHAIN_LIMIT && cursor && cursor > 1; i += 1) {
    const info = procInfo(cursor);
    if (!info) break;
    chain.push({ pid: info.pid, comm: info.comm, argv0: info.argv0 });
    cursor = info.ppid;
  }
  return chain;
}

function currentCwd() {
  try {
    return process.cwd();
  } catch {
    return '';
  }
}

function record(kind, extra) {
  const self = procInfo(process.pid);
  const line = JSON.stringify({
    probe: 'probe-mcp-server',
    kind,
    at: new Date().toISOString(),
    pid: process.pid,
    ppid: self ? self.ppid : null,
    chain: parentChain(),
    argv: process.argv,
    cwd: currentCwd(),
    envNames: Object.keys(process.env).sort(),
    ...selectedEnv(),
    ...extra,
  });
  for (const file of [OUT, SHARED]) {
    if (!file) continue;
    try {
      fs.appendFileSync(file, `${line}\n`);
    } catch {
      // A probe that cannot write its evidence is useless, but must not crash
      // the harness under test.
    }
  }
}

const TOOL = {
  name: 'probe_whoami',
  description: 'Probe tool: report which process launched this MCP server. Call it exactly once when asked, then stop.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (Array.isArray(message)) {
    for (const item of message) handleMessage(item);
    return;
  }
  const { id, method, params } = message;
  if (typeof method !== 'string') return; // a response from the client; ignore
  const isNotification = id === undefined || id === null;

  const extra = {
    method,
    requestKeys: Object.keys(message),
    params: params ?? null,
  };
  if (!isNotification) extra.id = id;
  record('request', extra);

  if (isNotification) return;

  switch (method) {
    case 'initialize': {
      const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
      reply(id, {
        protocolVersion: requested || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'probe-mcp-server', version: '1.0.0' },
      });
      return;
    }
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: [TOOL] });
      return;
    case 'tools/call': {
      const name = params && typeof params.name === 'string' ? params.name : '';
      const text = JSON.stringify({ ok: true, tool: name, pid: process.pid, ppid: process.ppid });
      reply(id, { content: [{ type: 'text', text }], isError: name !== TOOL.name });
      return;
    }
    case 'resources/list':
      reply(id, { resources: [] });
      return;
    case 'resources/templates/list':
      reply(id, { resourceTemplates: [] });
      return;
    case 'prompts/list':
      reply(id, { prompts: [] });
      return;
    case 'logging/setLevel':
      reply(id, {});
      return;
    default:
      replyError(id, -32601, `method not found: ${method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        handleMessage(JSON.parse(line));
      } catch {
        // Ignore malformed input; the harness under test owns the protocol.
      }
    }
    index = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

record('start');
