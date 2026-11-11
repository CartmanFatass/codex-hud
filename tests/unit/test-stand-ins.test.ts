import assert from 'node:assert/strict';
import { fork, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { hudHome } from '../fixtures/hud-home.js';
import { REPO_ROOT } from '../fixtures/paths.js';
const fake = (name: string) => join(REPO_ROOT, 'tests/fakes', name);
const { createHerdr, herdrState } = await import(pathToFileURL(fake('herdr-model.mjs')).href);
const value = (out: { exit: number; stdout: string }) => {
  assert.equal(out.exit, 0, JSON.stringify(out));
  return JSON.parse(out.stdout).result;
};

for (const profile of ['role', 'panel', 'owned']) {
  test(`shared herdr ${profile}: create, split, agent, list and close`, async () => {
    const f = createHerdr({ profile });
    const { tab, root_pane } = value(await f.invoke(['tab', 'create', '--label', 'synthetic', '--workspace', 'w']));
    const split = value(
      await f.invoke(['pane', 'split', root_pane.pane_id, '--direction', 'down', '--env', 'TOKEN=a;$(not-shell)'])
    ).pane;
    assert.equal(split.tab_id, tab.tab_id);
    assert.deepEqual(f.state.env[split.pane_id], { TOKEN: 'a;$(not-shell)' });
    if (profile !== 'owned')
      value(await f.invoke(['pane', 'run', root_pane.pane_id, 'literal command; no evaluation']));
    value(await f.invoke(['agent', 'start', 'synthetic', '--pane', root_pane.pane_id]));
    assert.equal(value(await f.invoke(['agent', 'list'])).agents[0].name, 'synthetic');
    assert.equal(value(await f.invoke(['agent', 'get', 'synthetic'])).agent.agent_status, 'idle');
    value(await f.invoke(['pane', 'close', split.pane_id]));
    if (profile === 'owned') {
      assert.equal((await f.invoke(['tab', 'close', tab.tab_id])).exit, 1);
      // Worker exit is an external observation, never inferred from a quit acknowledgement.
      f.state.agents = [];
    }
    value(await f.invoke(['tab', 'close', tab.tab_id]));
    assert.deepEqual(value(await f.invoke(['pane', 'list'])).panes, []);
    assert.deepEqual(value(await f.invoke(['tab', 'list'])).tabs, []);
  });
}
test('shared herdr refuses unknown commands and identities without effects', async () => {
  const f = createHerdr();
  for (const args of [
    ['shell', 'eval', 'touch nope'],
    ['agent', 'prompt', 'foreign', 'x'],
    ['pane', 'run', 'foreign', 'x'],
    ['tab', 'close', 'foreign'],
  ]) {
    assert.equal((await f.invoke(args)).exit, 1);
  }
  assert.deepEqual(f.state, herdrState());
});
test(
  'shared herdr owned socket refuses every mutation without journal/transaction admission',
  { timeout: 5000 },
  async (t) => {
    const home = hudHome();
    const socket = join(home.root, 'socket');
    const state = herdrState({
      tabs: [{ tab_id: 'main-tab' }],
      panes: [{ pane_id: 'main', tab_id: 'main-tab' }],
      agents: [{ name: 'worker', pane_id: 'main', tab_id: 'main-tab', slot: 'primary' }],
      mode: {},
    });
    const file = home.write('herdr-state.json', JSON.stringify(state));
    const server = fork(
      fake('pi-owned-herdr.mjs'),
      ['--server', socket, home.root, home.tasks, 'synthetic-integration'],
      { env: home.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
    );
    const ended = once(server, 'exit');
    t.after(async () => {
      server.kill('SIGTERM');
      await ended;
      home.cleanup();
    });
    await once(server, 'message');
    for (const argv of [
      ['tab', 'create', '--label', 'unowned'],
      ['pane', 'split', 'main'],
      ['agent', 'start', 'foreign', '--pane', 'main'],
      ['agent', 'prompt', 'worker', 'unrecorded'],
      ['agent', 'prompt', 'worker', '/quit'],
      ['pane', 'send-keys', 'main', 'Enter'],
      ['pane', 'close', 'main'],
      ['tab', 'close', 'main-tab'],
      ['pane', 'run', 'main', 'unrecorded'],
      ['agent', 'rename', 'main', 'foreign'],
      ['tab', 'rename', 'main-tab', 'foreign'],
    ]) {
      const out = spawnSync(process.execPath, [fake('pi-owned-herdr.mjs'), ...argv], {
        env: { ...home.env, HERDR_SOCKET_PATH: socket },
        encoding: 'utf8',
        timeout: 1000,
      });
      assert.equal(out.status, 1, argv.join(' ') + out.stdout + out.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), state, argv.join(' '));
    }
  }
);
test('shared herdr barrier/deadline loses a reply but preserves its late effect', async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = createHerdr({ scripts: [{ command: 'tab create', barrier, deadlineMs: 5 }] });
  assert.equal((await f.invoke(['tab', 'create'])).stderr, 'deadline\n');
  assert.equal(f.state.tabs.length, 0);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.tabs.length, 1);
  value(await f.invoke(['tab', 'create']));
  assert.equal(f.state.tabs.length, 2);
});
test('shared herdr CLI and memory consume the same before/after-loss sequence once per call', async (t) => {
  const home = hudHome({ after: (fn) => t.after(fn) });
  const scripts = [
    { command: 'tab create', before: 'lost' },
    { command: 'tab create', after: 'lost' },
  ];
  const memory = createHerdr({ scripts });
  for (let n = 0; n < 3; n++) {
    const argv = ['tab', 'create', '--label', `synthetic-${n}`, '--workspace', 'w'];
    const expected = await memory.invoke(argv);
    const cli = spawnSync(process.execPath, [fake('herdr.mjs'), ...argv], {
      env: {
        ...home.env,
        HERDR_FAKE_STATE: join(home.root, 'state.json'),
        HERDR_FAKE_SCRIPTS: JSON.stringify(scripts),
      },
      encoding: 'utf8',
    });
    assert.equal(cli.status, expected.exit);
    assert.equal(cli.stderr, expected.stderr ?? '');
    const { scenario, ...inventory } = JSON.parse(fs.readFileSync(join(home.root, 'state.json'), 'utf8'));
    assert.deepEqual(inventory, memory.state);
    assert.equal(inventory.tabs.length, [0, 1, 2][n]);
    assert.equal(scenario.remaining.length, Math.max(1 - n, 0));
  }
});
test(
  'shared herdr concurrent delayed CLI creates preserve all successful IDs and a late effect',
  { timeout: 5000 },
  async (t) => {
    const home = hudHome({ after: (fn) => t.after(fn) });
    const state = join(home.root, 'state.json');
    const call = async (label: string, extra: NodeJS.ProcessEnv = {}) => {
      const child = spawn(process.execPath, [fake('herdr.mjs'), 'tab', 'create', '--label', label], {
        env: { ...home.env, HERDR_FAKE_STATE: state, ...extra },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      t.after(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const [exit] = await once(child, 'exit');
      return { exit, stdout, stderr };
    };
    const successes = await Promise.all(['a', 'b'].map((label) => call(label, { HERDR_FAKE_DELAY_MS: '100' })));
    const ids = successes.map((out) => value(out).tab.tab_id);
    assert.equal(new Set(ids).size, 2);
    assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).tabs.length, 2);
    const scripts = JSON.stringify([{ command: 'tab create', delayMs: 100, deadlineMs: 5 }]);
    const outcomes = await Promise.all(
      ['late-a', 'late-b'].map((label) => call(label, { HERDR_FAKE_SCRIPTS: scripts }))
    );
    assert.deepEqual(outcomes.map((out) => out.exit).sort(), [0, 1]);
    const inventory = JSON.parse(fs.readFileSync(state, 'utf8'));
    assert.equal(inventory.tabs.length, 4);
    assert.equal(new Set(inventory.tabs.map((tab: { tab_id: string }) => tab.tab_id)).size, 4);
  }
);
test(
  'shared pi worker owns a real synthetic process, lazy session and settled artifact',
  { timeout: 5000 },
  async (t) => {
    const home = hudHome({ after: (fn) => t.after(fn) });
    const slot = 'hud/jobs/jsynthetic/.dispatch/primary';
    const task = join(home.jobs, 'jsynthetic'),
      path = join(home.root, slot, 'contract.json');
    const contract = {
      role: 'sonic',
      model: 'synthetic/model',
      effort: 'high',
      job: 'jsynthetic',
      slot: 'primary',
      cwd: home.source,
      task_dir: task,
      session_dir: home.sessions,
      session_id: 'synthetic-worker',
      output_path: join(task, 'report.md'),
    };
    home.write(slot + '/contract.json', JSON.stringify(contract));
    home.write(
      slot + '/launch.json',
      JSON.stringify({ instance: 'synthetic', tab: 'tab1', pane: 'pane1', name: 'worker' })
    );
    const child = fork(fake('pi-owned-worker.mjs'), ['--hud-role-contract', path], {
      env: {
        ...home.env,
        OWNED_PROCESS_MODULE: pathToFileURL(join(REPO_ROOT, 'dist-test/src/core/run/process.js')).href,
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    const ended = once(child, 'exit');
    const [ready] = await once(child, 'message');
    assert.equal(fs.existsSync(ready.session), false);
    const owner = JSON.parse(fs.readFileSync(join(home.root, slot, 'owner.json'), 'utf8'));
    assert.equal(owner.process.pid, child.pid);
    child.send({ type: 'prompt', text: 'Synthetic prompt', finish: true });
    assert.equal((await ended)[0], 0);
    assert.match(fs.readFileSync(ready.session, 'utf8'), /Synthetic prompt/);
    assert.equal(JSON.parse(fs.readFileSync(join(task, 'STATUS.json'), 'utf8')).output_written, true);
    assert.match(fs.readFileSync(contract.output_path, 'utf8'), /Synthetic result/);
  }
);
test('shared pi package-host uses the real package entry and rejects unknown actions', { timeout: 5000 }, async (t) => {
  const home = hudHome({ after: (fn) => t.after(fn) });
  const child = spawn(process.execPath, [join(REPO_ROOT, 'tests/fixtures/pi-package-host.mjs')], {
    env: { ...home.env, HUD_TEST_REPO: REPO_ROOT, HUD_TEST_SESSIONS: home.sessions, HUD_TEST_UNASSIGNED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  const ended = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const ready = JSON.parse((await iterator.next()).value!);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.tools, ['hud_roster', 'hud_create', 'hud_read', 'hud_send', 'hud_respond', 'hud_close']);
  child.stdin.write(JSON.stringify({ id: 1, kind: 'unknown' }) + '\n');
  assert.equal(JSON.parse((await iterator.next()).value!).error, 'unknown_action');
  child.stdin.end();
  assert.equal((await ended)[0], 0);
});
test('shared pi profiles fail without prerequisites; discovery never invents a package', (t) => {
  const home = hudHome({ after: (fn) => t.after(fn) });
  for (const [entry, args, extra] of [
    ['pi-owned-worker.mjs', ['--hud-role-contract', join(home.root, 'missing')], {}],
    ['../fixtures/pi-package-host.mjs', [], { HUD_TEST_REPO: join(home.root, 'missing') }],
  ] as const) {
    const out = spawnSync(process.execPath, [fake(entry), ...args], {
      env: { ...home.env, ...extra },
      encoding: 'utf8',
    });
    assert.notEqual(out.status, 0, entry);
  }
  const out = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {piPackage} from ${JSON.stringify(pathToFileURL(fake('pi-package.mjs')).href)}; console.log(JSON.stringify(piPackage()));`,
    ],
    { env: { ...home.env, PATH: '', PI_PACKAGE_DIR: home.root }, encoding: 'utf8' }
  );
  assert.equal(out.status, 0);
  assert.equal(out.stdout.trim(), 'null');
});
test('hud-home isolates paths and env, seeds private files and cleans only its root', () => {
  const parent = {
    HERDR_SOCKET_PATH: 'foreign',
    HERDR_UNKNOWN: 'foreign',
    FORCE_COLOR: '1',
    NO_COLOR: '1',
    HUD_SETTINGS_PATH: 'foreign',
    CODEX_HUD_SETTINGS_PATH: 'foreign',
    SYNTHETIC_API_KEY: 'not-a-secret',
  };
  const a = hudHome({ env: parent, files: { 'hud/settings.json': '{}' } }),
    b = hudHome({ env: parent });
  try {
    for (const key of ['HOME', 'HUD_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'] as const)
      assert.notEqual(a.env[key], b.env[key]);
    assert.notEqual(a.env, b.env);
    assert.equal(
      Object.keys(a.env).some((key) => key.startsWith('HERDR_')),
      false
    );
    assert.equal(a.env.FORCE_COLOR, undefined);
    assert.equal(a.env.HUD_SETTINGS_PATH, undefined);
    assert.equal(a.env.SYNTHETIC_API_KEY, undefined);
    assert.equal(parent.HERDR_UNKNOWN, 'foreign');
    assert.equal(fs.statSync(join(a.HUD_HOME, 'settings.json')).mode & 0o777, 0o600);
    fs.symlinkSync(b.root, join(a.HOME, 'escape'));
    assert.throws(() => a.write('home/escape/foreign', 'no'), /symlink/);
    assert.equal(fs.existsSync(join(b.root, 'foreign')), false);
    a.cleanup();
    a.cleanup();
    assert.equal(fs.existsSync(a.root), false);
    assert.equal(fs.existsSync(b.HOME), true);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});
test('hud-home rejects seed escapes and cleans up on setup failure', () => {
  let cleanup: (() => void) | undefined;
  assert.throws(
    () =>
      hudHome({
        after: (fn) => {
          cleanup = fn;
        },
        files: { '../escape': 'no' },
      }),
    /seed escapes/
  );
  assert.doesNotThrow(() => cleanup!());
});
