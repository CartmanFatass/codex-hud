import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bridgeHealthPath,
  classifyPane,
  createBridge,
  readHerdrConfig,
  readNativePane,
  readTmuxPane,
  sendAgentReport,
} from '../../bin/codex-hud-herdr.mjs';

const SESSION = 'synthetic-hud-session';
const ENV = {
  HERDR_ENV: '1',
  HERDR_SOCKET_PATH: '/synthetic/unused.sock',
  HERDR_PANE_ID: 'outer-pane-42',
};
const pane = (title, command = 'codex', dead = '0', session = SESSION) => `${session}\n${command}\n${dead}\n${title}\n`;
const options = (overrides = {}) => ({
  session: SESSION,
  mainPaneId: '%17',
  parentPid: 12345,
  env: ENV,
  isParentAlive: () => true,
  ...overrides,
});

async function fakeHerdr(t, handle) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hud-herdr-'));
  const socketPath = path.join(root, 'api.sock');
  const clients = new Set();
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => clients.delete(socket));
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk.toString();
      if (!input.includes('\n')) return;
      socket.removeAllListeners('data');
      handle(JSON.parse(input.slice(0, input.indexOf('\n'))), socket);
    });
  });
  t.after(async () => {
    for (const client of clients) client.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return { socketPath, paneId: ENV.HERDR_PANE_ID };
}

function within(promise, ms = 1500) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('deadline exceeded')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

test('classifier uses only live Codex metadata from the exact session', () => {
  for (const spinner of '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏') {
    assert.equal(classifyPane(pane(`${spinner} Synthetic task`), SESSION), 'working');
    assert.equal(classifyPane(pane(`Synthetic ${spinner} task`), SESSION), 'working');
    assert.equal(classifyPane(pane(`Synthetic ${spinner}`), SESSION), 'working');
  }
  assert.equal(classifyPane(pane('⠋ Action Required'), SESSION), 'blocked');
  assert.equal(classifyPane(pane('Synthetic title'), SESSION), 'idle');
  assert.equal(classifyPane(pane('embedded⠋spinner'), SESSION), 'idle');
  assert.equal(classifyPane(pane('task\nAction Required'), SESSION), 'blocked');
  assert.equal(classifyPane(pane('task\nother field'), SESSION), 'idle');
  for (const title of ['', '  ', '\n']) {
    assert.equal(classifyPane(pane(title), SESSION), 'unknown');
  }
  for (const command of ['bash', 'node', 'not-codex', 'codex-helper', 'node /bin/codex']) {
    assert.equal(classifyPane(pane('⠋ Action Required', command), SESSION), 'unknown');
  }
  for (const command of [
    'codex',
    '/usr/local/bin/codex',
    'codex.exe',
    'codex-x86_64-unknown-linux-musl',
    'codex-aarch64-apple-darwin',
  ])
    assert.equal(classifyPane(pane('Synthetic idle', command), SESSION), 'idle');
  assert.equal(classifyPane(pane('Action Required', 'codex', '1'), SESSION), 'unknown');
  assert.equal(classifyPane(pane('Action Required', 'codex', 'garbage'), SESSION), 'unknown');
  assert.equal(classifyPane(pane('Action Required', 'codex', '0', 'reused-session'), SESSION), 'unknown');
  for (const output of [null, undefined, '', 'Action Required', `${SESSION}\ncodex\n0`]) {
    assert.equal(classifyPane(output, SESSION), 'unknown');
  }
});

test('environment gates and target validation fail closed without I/O', async () => {
  assert.deepEqual(readHerdrConfig(ENV), { socketPath: ENV.HERDR_SOCKET_PATH, paneId: ENV.HERDR_PANE_ID });
  const disabled = [
    {},
    { ...ENV, HERDR_ENV: '0' },
    { ...ENV, HERDR_ENV: 'true' },
    { ...ENV, HERDR_SOCKET_PATH: '' },
    { ...ENV, HERDR_PANE_ID: ' ' },
    { ...ENV, CODEX_HUD_HERDR_BRIDGE: '0' },
  ];
  let calls = 0;
  for (const env of disabled) {
    assert.equal(readHerdrConfig(env), null);
    const bridge = createBridge(options({ env, readPane: () => calls++, report: () => calls++ }));
    assert.equal(bridge.enabled, false);
    await bridge.poll();
    await bridge.start();
    await bridge.stop();
  }
  for (const override of [{ mainPaneId: 'active' }, { parentPid: 1 }, { parentPid: NaN }, { session: 'bad\n' }]) {
    const bridge = createBridge(options({ ...override, report: () => calls++ }));
    assert.equal(bridge.enabled, false);
    await bridge.stop();
  }
  assert.equal(calls, 0);
  assert.ok(readHerdrConfig({ ...ENV, CODEX_HUD_HERDR_BRIDGE: '1' }));
});

test('tmux probe is exact, read-only, shell-free and bounded', async () => {
  const output = await readTmuxPane('%17', {
    execFileImpl: (file, args, opts, callback) => {
      assert.equal(file, 'tmux');
      assert.deepEqual(args, [
        'display-message',
        '-p',
        '-t',
        '%17',
        '#{session_name}\n#{pane_current_command}\n#{pane_dead}\n#{pane_title}',
      ]);
      assert.equal(opts.shell, undefined);
      assert.equal(opts.timeout, 450);
      assert.equal(opts.killSignal, 'SIGKILL');
      assert.equal(opts.maxBuffer, 16 * 1024);
      callback(null, pane('Synthetic idle'));
    },
  });
  assert.equal(classifyPane(output, SESSION), 'idle');
  assert.equal(
    await readTmuxPane('%17', { execFileImpl: (_file, _args, _opts, cb) => cb(new Error('missing')) }),
    null
  );
  assert.equal(
    await readTmuxPane('%17', {
      execFileImpl: () => {
        throw new Error('missing');
      },
    }),
    null
  );
  assert.deepEqual(
    await readTmuxPane('%17', {
      execFileImpl: (_file, _args, _opts, cb) => cb(new Error('missing'), '', "can't find pane: %17"),
    }),
    { unavailable: 'target-missing' }
  );
  assert.equal(await readTmuxPane('active', { execFileImpl: () => assert.fail('must not execute') }), null);
  const abort = new AbortController();
  abort.abort();
  assert.equal(await readTmuxPane('%17', { signal: abort.signal }), null);
});

test('fake Unix socket receives minimal schema, current outer identity and safe sequence', async (t) => {
  const requests = [];
  const config = await fakeHerdr(t, (request, socket) => {
    requests.push(request);
    const reply = JSON.stringify({ id: request.id, ok: true });
    socket.write(reply.slice(0, 8));
    socket.end(`${reply.slice(8)}\n`);
  });
  const bridge = createBridge(
    options({
      env: { ...ENV, HERDR_SOCKET_PATH: config.socketPath },
      readPane: async () => pane('⠋ SECRET_SYNTHETIC_TASK'),
    })
  );
  await bridge.poll();
  await bridge.stop();
  assert.deepEqual(
    requests.map((r) => r.params.state),
    ['working', 'unknown']
  );
  for (const request of requests) {
    assert.deepEqual(Object.keys(request).sort(), ['id', 'method', 'params']);
    assert.equal(request.method, 'pane.report_agent');
    assert.deepEqual(Object.keys(request.params).sort(), ['agent', 'pane_id', 'seq', 'source', 'state']);
    assert.equal(request.params.pane_id, 'outer-pane-42');
    assert.equal(request.params.source, 'codex-hud:codex');
    assert.equal(request.params.agent, 'codex');
    assert.ok(Number.isSafeInteger(request.params.seq) && request.params.seq >= 0);
    assert.equal(JSON.stringify(request).includes('SECRET_SYNTHETIC_TASK'), false);
    assert.equal(JSON.stringify(request).includes('%17'), false);
  }
  assert.ok(requests[1].params.seq > requests[0].params.seq);
});

test('socket acknowledges only matching successful newline responses', async (t) => {
  const cases = [
    ['JSON-RPC success', (r) => JSON.stringify({ id: r.id, result: {} }) + '\n', true],
    ['malformed', () => '{not-json}\n', false],
    ['error', (r) => JSON.stringify({ id: r.id, error: { message: 'synthetic error' } }) + '\n', false],
    ['explicit failure', (r) => JSON.stringify({ id: r.id, ok: false, result: {} }) + '\n', false],
    ['wrong id', () => '{"id":"other","ok":true}\n', false],
    ['no acknowledgement', (r) => JSON.stringify({ id: r.id }) + '\n', false],
    ['no newline', (r) => JSON.stringify({ id: r.id, ok: true }), false],
    ['oversized', () => 'x'.repeat(2048) + '\n', false],
    ['disconnect', () => '', false],
  ];
  for (const [name, respond, expected] of cases) {
    await t.test(name, async (t) => {
      const config = await fakeHerdr(t, (request, socket) => socket.end(respond(request)));
      assert.equal(await sendAgentReport(config, { state: 'idle', seq: 123 }, { maxResponseBytes: 1024 }), expected);
    });
  }
});

test('socket timeout, absent endpoint and cancellation are quiet bounded failures', async (t) => {
  const config = await fakeHerdr(t, () => {});
  assert.equal(await within(sendAgentReport(config, { state: 'working', seq: 1 }, { timeoutMs: 30 })), false);
  assert.equal(
    await sendAgentReport({ ...config, socketPath: `${config.socketPath}.missing` }, { state: 'idle', seq: 2 }),
    false
  );
  const abort = new AbortController();
  const pending = sendAgentReport(config, { state: 'idle', seq: 3 }, { signal: abort.signal });
  abort.abort();
  assert.equal(await within(pending), false);
  assert.equal(await sendAgentReport(config, { state: 'idle', seq: 4 }, { signal: abort.signal }), false);
  assert.equal(await sendAgentReport(config, { state: 'invalid', seq: 4 }), false);
  assert.equal(await sendAgentReport(config, { state: 'idle', seq: Number.MAX_SAFE_INTEGER + 1 }), false);
});

test('controller deduplicates heartbeats and handles rapid working/idle/working without duplicate idle', async () => {
  let time = 1700000000000;
  let title = '⠋ Synthetic task';
  const reports = [];
  const bridge = createBridge(
    options({
      now: () => time,
      readPane: async () => pane(title),
      report: async (_config, report) => {
        reports.push(report);
        return true;
      },
    })
  );
  await bridge.poll();
  await bridge.poll();
  time += 4999;
  await bridge.poll();
  assert.equal(reports.length, 1);
  time++;
  await bridge.poll();
  title = 'Synthetic idle';
  await bridge.poll();
  await bridge.poll();
  title = '⠋ Second task';
  await bridge.poll();
  title = 'Synthetic idle';
  await bridge.poll();
  await bridge.stop();
  assert.deepEqual(
    reports.map((r) => r.state),
    ['working', 'working', 'idle', 'working', 'idle', 'unknown']
  );
  assert.ok(reports.every((r, i) => i === 0 || r.seq > reports[i - 1].seq));
});

test('short uncertain tmux failure preserves working then publishes observed completion', async () => {
  let time = 10000;
  let output = pane('⠋ Synthetic task');
  const states = [];
  const bridge = createBridge(
    options({
      now: () => time,
      readPane: async () => output,
      report: async (_config, { state }) => {
        states.push(state);
        return true;
      },
    })
  );
  await bridge.poll();
  output = null;
  await bridge.poll();
  time += 750;
  await bridge.poll();
  assert.equal(bridge.health().probe.status, 'retrying');
  assert.equal(bridge.health().publishedState, 'working');
  output = pane('Synthetic idle');
  await bridge.poll();
  await bridge.poll();
  assert.deepEqual(states, ['working', 'idle']);
  assert.equal(bridge.health().notificationGap, false);
  await bridge.stop();
});

test('prolonged probe failure releases unknown without inventing a completion', async () => {
  let time = 10000;
  let output = pane('⠋ Synthetic task');
  const states = [];
  const bridge = createBridge(
    options({
      now: () => time,
      readPane: async () => output,
      report: async (_config, { state }) => {
        states.push(state);
        return true;
      },
    })
  );
  await bridge.poll();
  output = null;
  await bridge.poll();
  time += 3000;
  await bridge.poll();
  assert.equal(bridge.health().probe.status, 'unavailable');
  assert.equal(bridge.health().notificationGap, true);
  output = pane('Synthetic idle');
  await bridge.poll();
  assert.deepEqual(states, ['working', 'unknown', 'idle']);
  await bridge.stop();
});

test('lost target, wrong process, dead pane and session reuse immediately release state', async () => {
  let output;
  const states = [];
  const bridge = createBridge(
    options({
      readPane: async () => output,
      report: async (_config, { state }) => {
        states.push(state);
        return true;
      },
    })
  );
  for (const lost of [
    { unavailable: 'target-missing' },
    pane('Action Required', 'bash'),
    pane('Action Required', 'codex', '1'),
    pane('Action Required', 'codex', '0', 'other-session'),
  ]) {
    output = pane('⠋ Synthetic task');
    await bridge.poll();
    output = lost;
    await bridge.poll();
    await bridge.poll();
  }
  assert.deepEqual(states, ['working', 'unknown', 'working', 'unknown', 'working', 'unknown', 'working', 'unknown']);
  await bridge.stop();
});

test('reconnect clears ambiguous reports then re-reads latest state without replaying missed turns', async () => {
  let title = '⠋ First task';
  let connected = true;
  const attempts = [],
    accepted = [];
  const bridge = createBridge(
    options({
      readPane: async () => pane(title),
      report: async (_config, { state }) => {
        attempts.push(state);
        if (connected) accepted.push(state);
        return connected;
      },
    })
  );
  await bridge.poll();
  connected = false;
  title = 'Synthetic idle';
  await bridge.poll();
  title = '⠋ Offline task';
  await bridge.poll();
  title = 'Synthetic idle';
  await bridge.poll();
  assert.equal(bridge.health().transport.status, 'disconnected');
  connected = true;
  await bridge.poll();
  // The state can change during reconnect; only the next fresh read is published.
  title = '⠋ Current task';
  await bridge.poll();
  title = 'Synthetic idle';
  await bridge.poll();
  await bridge.poll();
  assert.deepEqual(accepted, ['working', 'unknown', 'working', 'idle']);
  assert.deepEqual(attempts, ['working', 'idle', 'unknown', 'unknown', 'unknown', 'working', 'idle']);
  assert.equal(bridge.health().notificationGap, true);
  assert.equal(bridge.health().transport.status, 'connected');
  await bridge.stop();
});

test('private per-attach health files remain readable after stop and exclude title/socket text', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hud-health-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = bridgeHealthPath(root, '../odd/session', 100);
  const otherFile = bridgeHealthPath(root, '../odd/session', 101);
  assert.notEqual(file, otherFile);
  assert.equal(path.basename(path.dirname(file)), '.._odd_session');
  let time = 10000;
  const bridge = createBridge(
    options({
      now: () => time,
      healthFilePath: file,
      readPane: async () => pane('⠋ SECRET_SYNTHETIC_TASK'),
      report: async () => true,
    })
  );
  await bridge.poll();
  const read = async () => JSON.parse(await readFile(file, 'utf8'));
  assert.equal((await read()).lifecycle, 'running');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  time += 750;
  await bridge.poll();
  assert.equal((await read()).updatedAtMs, time);
  assert.equal(JSON.stringify(await read()).includes('SECRET'), false);
  assert.equal(JSON.stringify(await read()).includes(ENV.HERDR_SOCKET_PATH), false);
  await bridge.stop();
  assert.equal((await read()).lifecycle, 'stopped');
  assert.equal((await read()).publishedState, 'unknown');
});

test('health write failure never interrupts state reporting', async () => {
  const states = [];
  const bridge = createBridge(
    options({
      healthFilePath: '/synthetic/unused.json',
      readPane: async () => pane('Synthetic idle'),
      writeHealth: async () => {
        throw new Error('fixture');
      },
      report: async (_config, { state }) => {
        states.push(state);
        return true;
      },
    })
  );
  await bridge.poll();
  assert.equal(bridge.health().healthWriteError, true);
  await bridge.stop();
  assert.deepEqual(states, ['idle', 'unknown']);
});

test('stop aborts an in-flight report before one final unknown; repeated stop is idempotent', async () => {
  const events = [];
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const bridge = createBridge(
    options({
      readPane: async () => pane('⠋ Synthetic task'),
      report: async (_config, { state }, { signal }) => {
        events.push(`start:${state}`);
        if (state === 'working') {
          entered();
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        }
        events.push(`end:${state}`);
        return true;
      },
    })
  );
  const poll = bridge.poll();
  assert.equal(bridge.poll(), poll, 'polling is nonoverlapping');
  await started;
  const stop = bridge.stop();
  assert.equal(bridge.stop(), stop);
  await within(stop);
  await bridge.poll();
  await bridge.done;
  assert.deepEqual(events, ['start:working', 'end:working', 'start:unknown', 'end:unknown']);
});

test('parent death aborts a pending probe and terminates without a late working report', async () => {
  let alive = true;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const states = [];
  const bridge = createBridge(
    options({
      pollMs: 5,
      parentCheckMs: 5,
      isParentAlive: () => alive,
      readPane: async (_pane, { signal }) => {
        entered();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        return pane('⠋ Synthetic task');
      },
      report: async (_config, { state }) => {
        states.push(state);
        return true;
      },
    })
  );
  bridge.start();
  await started;
  alive = false;
  await within(bridge.done);
  assert.deepEqual(states, ['unknown']);
  await bridge.stop();
});

test('already-dead parent releases once without probing tmux', async () => {
  const states = [];
  const bridge = createBridge(
    options({
      isParentAlive: () => false,
      readPane: () => assert.fail('orphan must not probe'),
      report: async (_config, { state }) => {
        states.push(state);
        return true;
      },
    })
  );
  bridge.start();
  await within(bridge.done);
  assert.deepEqual(states, ['unknown']);
});

test('stop with a silent fake server cancels the active request and bounds the final release', async (t) => {
  const states = [];
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const config = await fakeHerdr(t, (request) => {
    states.push(request.params.state);
    if (request.params.state === 'working') entered();
  });
  const bridge = createBridge(
    options({
      env: { ...ENV, HERDR_SOCKET_PATH: config.socketPath },
      readPane: async () => pane('⠋ Synthetic task'),
    })
  );
  void bridge.poll();
  await within(started);
  await within(bridge.stop());
  await bridge.done;
  assert.deepEqual(states, ['working', 'unknown']);
});

test('native readback validates exact outer pane and status without claiming lifecycle authority', async (t) => {
  const requests = [];
  const config = await fakeHerdr(t, (request, socket) => {
    requests.push(request);
    socket.end(
      JSON.stringify({
        id: request.id,
        result: {
          pane: {
            pane_id: config.paneId,
            agent_status: 'done',
            agent: 'codex',
            agent_session: { source: 'herdr:codex', value: 'synthetic-native-session' },
          },
        },
      }) + '\n'
    );
  });
  assert.equal(await readNativePane(config), 'done');
  assert.deepEqual(
    requests.map((r) => [r.method, r.params]),
    [['pane.get', { pane_id: config.paneId }]]
  );
});

test('native observer reads projected completion and stops without unknown or lifecycle writes', async () => {
  let output = pane('⠋ Synthetic task');
  let nativeState = 'working';
  const bridge = createBridge(
    options({
      mode: 'native',
      readPane: async () => output,
      readNative: async () => nativeState,
      report: () => assert.fail('native observer must never write'),
    })
  );
  await bridge.poll();
  assert.equal(bridge.health().stateMatches, true);
  output = pane('Synthetic idle');
  nativeState = 'done';
  await bridge.poll();
  await bridge.poll();
  assert.equal(bridge.health().nativeState, 'done');
  assert.equal(bridge.health().publishedState, 'idle');
  assert.equal(bridge.health().stateMatches, true);
  await bridge.stop();
  assert.equal(bridge.health().nativeState, 'done');
  assert.equal(bridge.health().lifecycle, 'stopped');
});

test('native observer diagnoses ignored custom authority rather than treating an API ACK as delivery', async () => {
  const bridge = createBridge(
    options({
      mode: 'native',
      readPane: async () => pane('Synthetic idle'),
      readNative: async () => 'working',
      report: () => assert.fail('must not overwrite native owner'),
    })
  );
  await bridge.poll();
  assert.equal(bridge.health().transport.status, 'connected');
  assert.equal(bridge.health().probe.status, 'mismatch');
  assert.equal(bridge.health().stateMatches, false);
  assert.equal(bridge.health().nativeState, 'working');
  await bridge.stop();
});

test('native observer recovery only reads current state and keeps diagnostic gap visible', async () => {
  let nativeState = 'working';
  let output = pane('⠋ Synthetic task');
  const bridge = createBridge(
    options({
      mode: 'native',
      readPane: async () => output,
      readNative: async () => nativeState,
      report: () => assert.fail('no replay writes'),
    })
  );
  await bridge.poll();
  nativeState = null;
  output = pane('Synthetic idle');
  await bridge.poll();
  assert.equal(bridge.health().transport.status, 'disconnected');
  assert.equal(bridge.health().stateMatches, null);
  nativeState = 'done';
  await bridge.poll();
  assert.equal(bridge.health().nativeState, 'done');
  assert.equal(bridge.health().notificationGap, true);
  assert.equal(bridge.health().stateMatches, true);
  await bridge.stop();
});

test('native readback never certifies another pane or agent as this Codex', async (t) => {
  const replies = [
    { pane_id: 'other-pane', agent: 'codex', agent_status: 'working' },
    { pane_id: ENV.HERDR_PANE_ID, agent: 'claude', agent_status: 'working' },
    { pane_id: ENV.HERDR_PANE_ID, agent: 'codex', agent_status: 'unrecognized' },
  ];
  const config = await fakeHerdr(t, (request, socket) => {
    socket.end(JSON.stringify({ id: request.id, result: { pane: replies.shift() } }) + '\n');
  });
  assert.equal(await readNativePane(config), null);
  assert.equal(await readNativePane(config), 'unknown');
  assert.equal(await readNativePane(config), null);
});
