import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { launchGroup, processState, proveGroupGone, type GroupProcess } from '../../src/core/run/process.js';
import {
  assertRawResult,
  diagnosticProfile,
  retainCapture,
  startupStderr,
  validateStartup,
  type DiagnosticProfile,
  type RawCapture,
} from '../int/node-startup-diagnostics.js';

const empty = Buffer.alloc(0);
const profile22: DiagnosticProfile = { version: '22.23.4', release: 'node', proxyStartup: true };

test('source-backed startup profiles preserve raw streams and validate the minimal no-HUD child', () => {
  validateStartup();
  assert.equal(startupStderr({ ...profile22, proxyStartup: false }, 731).length, 0);
  assert.equal(startupStderr({ ...profile22, version: '24.22.1' }, 731).length, 0);
  assert.equal(
    startupStderr(profile22, 731, '/synthetic/node.exe').toString(),
    '(node:731) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.\n' +
      '(Use `node --trace-warnings ...` to show where the warning was created)\n'
  );
});

test('closed diagnostic matcher rejects altered missing duplicate and unrelated warning bytes', () => {
  const expected = startupStderr(profile22, 731);
  const actual = { pid: 731, status: 0, signal: null, stdout: empty, stderr: expected };
  assertRawResult(actual, actual);
  const altered = [
    empty,
    Buffer.concat([expected, expected]),
    Buffer.concat([Buffer.from('unexpected-before\n'), expected]),
    Buffer.concat([expected, Buffer.from('unexpected-after\n')]),
    Buffer.from(expected.toString().replace('UNDICI-EHPA', 'UNDICI-OTHER')),
    Buffer.from(expected.toString().replace('expect them', 'expect it')),
    startupStderr(profile22, 732),
    Buffer.from(expected.toString().replace('node --trace', 'other --trace')),
    expected.subarray(0, -1),
  ];
  for (const stderr of altered) assert.throws(() => assertRawResult({ ...actual, stderr }, actual));
});

test('strict raw result rejects parseable stdout corruption and reason-line status changes', () => {
  const startup = startupStderr(profile22, 731);
  const expected = {
    pid: 731,
    status: 4,
    signal: null,
    stdout: empty,
    stderr: Buffer.concat([startup, Buffer.from('ledger_missing\n')]),
  };
  for (const reason of ['', 'ledger_other\n', 'ledger_missing\nledger_missing\n']) {
    assert.throws(() =>
      assertRawResult({ ...expected, stderr: Buffer.concat([startup, Buffer.from(reason)]) }, expected)
    );
  }
  assert.throws(() => assertRawResult({ ...expected, status: 0 }, expected));
  const output = { ...expected, status: 0, stdout: Buffer.from('{"synthetic":1}\n'), stderr: startup };
  for (const stdout of [Buffer.from('{"synthetic":2}\n'), Buffer.from('{"synthetic":1}')]) {
    assert.doesNotThrow(() => JSON.parse(stdout.toString()));
    assert.throws(() => assertRawResult({ ...output, stdout }, output));
  }
});

test('declared profile rejects inherited warning suppression redirection preloads and unknown opt-ins', () => {
  for (const key of ['NODE_OPTIONS', 'NODE_NO_WARNINGS', 'NODE_REDIRECT_WARNINGS']) {
    assert.throws(() =>
      diagnosticProfile({ ...process.env, [key]: key === 'NODE_OPTIONS' ? '--trace-warnings' : '1' })
    );
  }
  assert.throws(() => diagnosticProfile({ ...process.env, NODE_USE_ENV_PROXY: '0' }));
  for (const flag of [
    '--no-warnings',
    '--disable-warning=UNDICI-EHPA',
    '--trace-warnings',
    '--require=synthetic',
    '--use-env-proxy',
  ]) {
    assert.throws(() => diagnosticProfile(process.env, [flag]));
  }
});

const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY'];
const brief = 'synthetic route stdin\0$(not-a-command)\n';
// No HUD import, explicit dispatcher, proxy override, or environment dump in this workload.
const childProgram = `
const chunks=[];
process.stdin.on('data',b=>chunks.push(b));
process.stdin.on('end',async()=>{
  try {
    const [url,id,arg]=process.argv.slice(1);
    const response=await fetch(url,{headers:{'x-synthetic-request':id},signal:AbortSignal.timeout(4000)});
    if(response.status!==200) throw new Error('synthetic target status');
    const body=await response.text();
    const env=Object.fromEntries(${JSON.stringify(keys)}.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
    process.stdout.write(JSON.stringify({id,arg,stdin:Buffer.concat(chunks).toString(),body,env})+'\\n');
    setTimeout(()=>process.exit(0),60);
  } catch { process.stderr.write('synthetic_route_failure\\n'); process.exitCode=1; }
});`;

type CaseName =
  | 'upper-proxy'
  | 'upper-bypass'
  | 'upper-disabled'
  | 'lower-proxy'
  | 'lower-bypass'
  | 'lower-disabled'
  | 'lost-environment-control';
const cases: CaseName[] = [
  'upper-proxy',
  'upper-bypass',
  'upper-disabled',
  'lower-proxy',
  'lower-bypass',
  'lower-disabled',
  'lost-environment-control',
];

function observeSockets(server: Server, sockets: Set<Socket>): void {
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.setTimeout(8000, () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening'); // EACCES/EPERM rejects, never becomes a skip.
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function captureDirect(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<RawCapture> {
  const child = spawn(argv[0], argv.slice(1), {
    env,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 8000,
    killSignal: 'SIGKILL',
  });
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  child.stdout.on('data', (b: Buffer) => stdout.push(b));
  child.stderr.on('data', (b: Buffer) => stderr.push(b));
  child.stdin.on('error', () => {});
  const closed = once(child, 'close');
  child.stdin.end(Buffer.from(brief));
  const [status, signal] = await closed;
  return { pid: child.pid!, status, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

async function captureGroup(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<RawCapture> {
  const output = join(cwd, 'stdout'),
    error = join(cwd, 'stderr');
  const stdoutFd = openSync(output, 'wx', 0o600),
    stderrFd = openSync(error, 'wx', 0o600);
  let group: GroupProcess | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    group = await launchGroup({
      runId: 'synthetic-proxy',
      argv,
      env,
      cwd,
      stdin: Buffer.from(brief),
      stdoutFd,
      stderrFd,
    });
    assert.ok(group.command);
    assert.ok(group.scope);
    await Promise.race([
      group.exited,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('routing group deadline')), 8000);
      }),
    ]);
    const result = {
      pid: group.command.pid,
      status: group.shellDiagnostic?.status ?? null,
      signal: null,
      stdout: readFileSync(output),
      stderr: readFileSync(error),
    };
    retainCapture('routing-group-before-cleanup', result);
    assert.equal(processState(group.helper), 'dead');
    assert.equal(proveGroupGone(group.scope, group.command, [group.helper]), true);
    return result;
  } finally {
    if (deadline) clearTimeout(deadline);
    if (group) {
      if (processState(group.helper) === 'alive') await group.signal('SIGKILL');
      if (group.command && processState(group.command) === 'alive') process.kill(group.command.pid, 'SIGKILL');
      group.close();
      // The owned workload has finite life; await helper/IPC cleanup rather than leave background work.
      await group.exited;
    }
    retainCapture('routing-group-final', {
      pid: group?.command?.pid ?? process.pid,
      status: group?.shellDiagnostic?.status ?? null,
      signal: null,
      stdout: readFileSync(output),
      stderr: readFileSync(error),
    });
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}

// A single bounded test stops at the first denied capability instead of retrying it for later cells.
test(
  'synthetic HTTP fetch routing NO_PROXY and native precedence through direct and production launch paths',
  { timeout: 290_000 },
  async (t) => {
    validateStartup();
    for (const route of ['direct', 'launchGroup'] as const) {
      for (const name of cases) {
        const home = mkdtempSync(join(tmpdir(), 'hud-proxy-route-'));
        const sockets = new Set<Socket>();
        const targetEvents: { id: string | undefined; route: string }[] = [];
        const violations: string[] = [];
        const upstreamPorts = new Map<number, string>();
        const hits = { upper: 0, lower: 0 };
        const id = `synthetic-${route}-${name}`;
        const target = createServer((req, res) => {
          const requestId = req.headers['x-synthetic-request'];
          targetEvents.push({
            id: typeof requestId === 'string' ? requestId : undefined,
            route: upstreamPorts.get(req.socket.remotePort!) ?? 'direct',
          });
          if (req.method !== 'GET' || req.url !== '/synthetic' || requestId !== id || targetEvents.length !== 1) {
            violations.push('target request outside declared singleton');
            res.writeHead(403).end();
            return;
          }
          res.setHeader('Connection', 'close');
          res.end('synthetic-target-response\n');
        });
        const servers: Server[] = [target];
        observeSockets(target, sockets);
        try {
          const targetPort = await listen(target);
          const authority = `127.0.0.1:${targetPort}`;
          const makeProxy = async (label: 'upper' | 'lower') => {
            const proxy = createServer((_req, res) => {
              violations.push('unexpected non-CONNECT proxy request');
              res.writeHead(403).end();
            });
            servers.push(proxy);
            observeSockets(proxy, sockets);
            proxy.on('connect', (req, client, head) => {
              if (req.url !== authority || hits[label] !== 0 || head.length !== 0) {
                violations.push('proxy request outside declared target/singleton');
                client.destroy();
                return;
              }
              hits[label]++;
              const upstream = connect({ host: '127.0.0.1', port: targetPort });
              sockets.add(upstream);
              upstream.setTimeout(8000, () => upstream.destroy());
              upstream.on('error', () => {
                violations.push('owned upstream connection failed');
                client.destroy();
              });
              upstream.on('close', () => {
                sockets.delete(upstream);
                client.destroy();
              });
              client.on('error', () => upstream.destroy());
              client.on('close', () => upstream.destroy());
              upstream.on('connect', () => {
                upstreamPorts.set(upstream.localPort!, label);
                client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                client.pipe(upstream);
                upstream.pipe(client);
              });
            });
            return `http://127.0.0.1:${await listen(proxy)}`;
          };
          const upper = await makeProxy('upper'),
            lower = await makeProxy('lower');
          const lowerCase = name.startsWith('lower');
          const disabled = name.endsWith('disabled');
          const bypass = name.endsWith('bypass');
          const declared: NodeJS.ProcessEnv = {
            HOME: home,
            HUD_HOME: home,
            HTTP_PROXY: upper,
            HTTPS_PROXY: lower,
            NO_PROXY: lowerCase
              ? bypass
                ? 'synthetic.invalid'
                : '127.0.0.1'
              : bypass
                ? '127.0.0.1'
                : 'synthetic.invalid',
          };
          if (!disabled) declared.NODE_USE_ENV_PROXY = '1';
          if (lowerCase)
            Object.assign(declared, {
              http_proxy: lower,
              https_proxy: upper,
              no_proxy: bypass ? '127.0.0.1' : 'synthetic.invalid',
            });
          const env = name === 'lost-environment-control' ? { HOME: home, HUD_HOME: home } : declared;
          const profile = validateStartup(env);
          const argv = [process.execPath, '-e', childProgram, `http://${authority}/synthetic`, id, 'a b $(synthetic)'];
          const actual = await (route === 'direct' ? captureDirect : captureGroup)(argv, env, home);
          retainCapture(`routing-${route}-${name}`, actual);
          const expectedBody = (environment: NodeJS.ProcessEnv) =>
            Buffer.from(
              JSON.stringify({
                id,
                arg: 'a b $(synthetic)',
                stdin: brief,
                body: 'synthetic-target-response\n',
                env: Object.fromEntries(
                  keys.filter((k) => environment[k] !== undefined).map((k) => [k, environment[k]])
                ),
              }) + '\n'
            );
          assertRawResult(actual, {
            status: 0,
            signal: null,
            stdout: expectedBody(env),
            stderr: startupStderr(profile, actual.pid),
          });
          const expectedRoute =
            disabled || bypass || name === 'lost-environment-control' ? 'direct' : lowerCase ? 'lower' : 'upper';
          assert.deepEqual(violations, []);
          assert.deepEqual(hits, {
            upper: Number(expectedRoute === 'upper'),
            lower: Number(expectedRoute === 'lower'),
          });
          assert.deepEqual(targetEvents, [{ id, route: expectedRoute }]);
          // These actual controls keep the same proxy addresses. Applying the missing feature's
          // positive expectation MUST fail, not be hidden by startup-diagnostic matching.
          if (disabled) assert.throws(() => assert.equal(hits[lowerCase ? 'lower' : 'upper'], 1));
          if (!disabled && !bypass && name !== 'lost-environment-control')
            assert.throws(() => assert.deepEqual(targetEvents, [{ id, route: 'direct' }]));
          if (name === 'lost-environment-control')
            assert.throws(() => assert.deepEqual(actual.stdout, expectedBody(declared)));
          t.diagnostic(JSON.stringify({ id, route, name, hits, targetEvents, status: actual.status, pid: actual.pid }));
        } finally {
          await Promise.all(
            [...sockets].map(
              (socket) =>
                new Promise<void>((resolve) => {
                  socket.once('close', () => resolve());
                  socket.destroy();
                })
            )
          );
          await Promise.all(
            servers.map(
              (server) =>
                new Promise<void>((resolve, reject) => {
                  if (!server.listening) {
                    resolve();
                    return;
                  }
                  server.close((error) => (error ? reject(error) : resolve()));
                })
            )
          );
          assert.equal(sockets.size, 0, 'all owned sockets closed');
          rmSync(home, { recursive: true, force: true });
        }
      }
    }
  }
);
