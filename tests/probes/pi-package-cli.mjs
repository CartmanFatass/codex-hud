/** Opt-in installed pi 1.5.1 PTY probe. Temporary homes; loopback recording provider only. */
import fs from 'node:fs';
import { tmpdir, hostname, cpus, release as osRelease } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import assert from 'node:assert/strict';
import { probeRelease } from '../fakes/pi-package-release.mjs';
import { piPackage } from '../fakes/pi-package.mjs';
const pkg = piPackage();
if (!pkg || pkg.version !== '1.5.1') throw Error('NOT_VERIFIED: installed pi 1.5.1 not found; set PI_PACKAGE_DIR');
const dir = fs.mkdtempSync(join(tmpdir(), 'hud-a5-cli-'));
let child, server, piPid;
try {
  const artifact = probeRelease(dir),
    home = join(dir, 'home'),
    agent = join(dir, 'agent'),
    cwd = join(dir, 'workspace'),
    codex = join(dir, 'codex');
  for (const p of [home, agent, cwd, codex]) fs.mkdirSync(p, { mode: 0o700 });
  let requests = [];
  server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (b) => (text += b));
    req.on('end', () => {
      const body = JSON.parse(text);
      requests.push(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const priorTool = body.messages?.some((v) => v.role === 'tool');
      const delta = priorTool
        ? { role: 'assistant', content: 'SYNTHETIC_REPLY' }
        : {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'a5_roster',
                type: 'function',
                function: { name: 'hud_roster', arguments: '{"action":"show"}' },
              },
            ],
          };
      res.end(
        `data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: priorTool ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`
      );
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  fs.writeFileSync(
    join(agent, 'models.json'),
    JSON.stringify({
      providers: {
        'a5-local': {
          baseUrl,
          apiKey: 'dummy-local-key',
          api: 'openai-completions',
          models: [
            {
              id: 'synthetic',
              name: 'Synthetic local',
              reasoning: false,
              input: ['text'],
              contextWindow: 32000,
              maxTokens: 256,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
    { mode: 0o600 }
  );
  fs.writeFileSync(
    join(agent, 'settings.json'),
    JSON.stringify({
      packages: [artifact.piPackage],
      defaultProvider: 'a5-local',
      defaultModel: 'synthetic',
      cacheWarming: 'off',
      enableInstallTelemetry: false,
      extensions: ['-builtin:mcp', '-builtin:llama.cpp', '-builtin:codemode', '-builtin:tool-search'],
      defaultProjectTrust: 'never',
      hideStartupBanner: true,
    }),
    { mode: 0o600 }
  );
  fs.mkdirSync(join(agent, 'extensions'), { mode: 0o700 });
  const evidence = join(dir, 'events.jsonl');
  fs.writeFileSync(
    join(agent, 'extensions/observer.ts'),
    `import fs from 'node:fs'; export default function(pi){pi.on('session_start',(_e,ctx)=>{fs.appendFileSync(${JSON.stringify(evidence)},JSON.stringify({pid:process.pid,mode:ctx.mode,tools:pi.getAllTools().map(t=>t.name),reason:_e.reason})+'\\n');});}`
  );
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    HUD_HOME: artifact.hudHome,
    CODEX_HOME: codex,
    PI_CODING_AGENT_DIR: agent,
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
  };
  const argv = [
    process.execPath,
    join(pkg.root, 'dist/bundle/cli.js'),
    '--provider',
    'a5-local',
    '--model',
    'synthetic',
  ];
  child = spawn('/usr/bin/python3', [resolve('tests/fakes/panel-pty.py'), JSON.stringify(argv)], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '',
    errors = '';
  child.stdin.on('error', () => {});
  child.stdout.on('data', (b) => {
    const s = b.toString();
    output += s;
    const m = /PID=(\d+)/.exec(output);
    if (m) piPid = Number(m[1]);
    if (s.includes('\x1b[6n')) child.stdin.write('\x1b[1;1R');
    if (s.includes('\x1b[?u')) child.stdin.write('\x1b[?0u');
  });
  child.stderr.on('data', (b) => (errors += b));
  const ended = new Promise((r) => child.once('close', (code, signal) => r({ code, signal })));
  const wait = async (predicate, why, ms = 15000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (predicate()) return;
      if (child.exitCode !== null) throw Error(why + ': child exited ' + output.slice(-4000) + errors);
      await new Promise((r) => setTimeout(r, 30));
    }
    throw Error(why + ': ' + output.slice(-6000) + errors);
  };
  const events = () =>
    fs.existsSync(evidence)
      ? fs
          .readFileSync(evidence, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((v) => JSON.parse(v))
      : [];
  await wait(() => events().length >= 1, 'package discovery');
  const first = events()[0];
  assert.equal(first.mode, 'tui');
  const names = ['hud_roster', 'hud_create', 'hud_read', 'hud_send', 'hud_respond', 'hud_close'];
  assert.deepEqual(
    first.tools.filter((v) => v.startsWith('hud_')),
    names
  );
  const send = async (s) => {
    child.stdin.write(s);
    await new Promise((r) => setTimeout(r, 80));
    child.stdin.write('\r');
  };
  let start = output.length;
  await send('/hud status');
  await wait(() => output.slice(start).includes('HUD:'), 'local command notification');
  assert.equal(requests.length, 0);
  const startupOnly = output.slice(start).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  start = output.length;
  await send('synthetic ordinary prompt');
  await wait(
    () => requests.length >= 2 && output.slice(start).includes('SYNTHETIC_REPLY'),
    'ordinary prompt/role bridge',
    30000
  );
  const roleResult = requests.at(-1).messages.filter((v) => v.role === 'tool');
  assert.ok(
    roleResult.some((v) => JSON.parse(v.content).ok === true),
    JSON.stringify(roleResult)
  );
  // Descendant ownership snapshot, not name-based process killing.
  const descendants = () => {
    const rows = [];
    for (const n of fs.readdirSync('/proc'))
      if (/^\d+$/.test(n)) {
        try {
          const s = fs.readFileSync('/proc/' + n + '/stat', 'utf8'),
            p = s.slice(s.lastIndexOf(')') + 2).split(' ');
          rows.push({
            pid: Number(n),
            ppid: Number(p[1]),
            state: p[0],
            argv: fs
              .readFileSync('/proc/' + n + '/cmdline', 'utf8')
              .split('\0')
              .filter(Boolean),
          });
        } catch {}
      }
    const selected = new Set([piPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const r of rows)
        if (selected.has(r.ppid) && !selected.has(r.pid)) {
          selected.add(r.pid);
          changed = true;
        }
    }
    return rows.filter((r) => r.pid !== piPid && selected.has(r.pid));
  };
  const before = descendants();
  assert.equal(before.filter((v) => v.argv.some((a) => a.endsWith('/hud-mcp.mjs'))).length, 1);
  const reloads = [];
  for (let i = 0; i < 5; i++) {
    const count = events().length;
    await send('/reload');
    await wait(() => events().length > count, 'reload ' + i);
    await new Promise((r) => setTimeout(r, 300));
    const rows = descendants();
    assert.equal(
      rows.filter((v) => v.argv.some((a) => /hud-mcp\.mjs$|pi-package-host|panel-entry/.test(a))).length,
      0,
      JSON.stringify(rows)
    );
    reloads.push(rows);
  }
  const count = requests.length;
  start = output.length;
  await send('/hud status');
  await wait(() => output.slice(start).includes('HUD:'), 'post-reload command');
  assert.equal(requests.length, count);
  child.stdin.write('\x04');
  const stop = await Promise.race([
    ended,
    new Promise((_, reject) => setTimeout(() => reject(Error('quit_deadline')), 10000)),
  ]);
  assert.equal(stop.code, 0, errors);
  console.log(
    JSON.stringify(
      {
        status: 'PASS',
        version: pkg.version,
        host: { hostname: hostname(), kernel: osRelease(), cpu: cpus()[0]?.model, node: process.version },
        artifact: 'clean-built isolated probe release (not distribution-pack verification)',
        packageDiscovery: 'PASS',
        commandProviderRequests: 0,
        ordinaryProviderRequests: requests.length,
        roleTools: names,
        roleCall: 'PASS',
        reloads: reloads.map((r) => r.length),
        descendantsBeforeReload: before.map((r) => ({ pid: r.pid, argv: r.argv })),
        noMcpConfig: !fs.existsSync(join(agent, 'mcp.json')),
        localNotification: startupOnly.slice(-500),
      },
      null,
      2
    )
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise((r) => child.once('close', r));
    child.stdin.end();
    // Only the exact child of our PTY driver is eligible for emergency cleanup.
    try {
      const stat = fs.readFileSync('/proc/' + piPid + '/stat', 'utf8');
      if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) === child.pid) process.kill(piPid, 'SIGTERM');
    } catch {}
    let timer;
    await Promise.race([
      closed,
      new Promise((r) => {
        timer = setTimeout(r, 3000);
      }),
    ]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await closed;
    }
  }
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
}
