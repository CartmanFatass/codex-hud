import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { CliPanelHerdr, PanelDeadline, type PanelHerdr } from '../../src/integrations/panel/herdr.js';
import { PanelStore, panelKey, displayTarget, type PanelReceipt } from '../../src/integrations/panel/receipt.js';
import { controlPanel } from '../../src/integrations/panel/control.js';
import { readProcess } from '../../src/core/run/process.js';
import { isolatePanelHerdr } from '../fixtures/panel-isolation.js';

const REPO = resolve(import.meta.dirname, '../../..');
function setup(t: TestContext) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-panel-entry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(dir, 'home'),
    HUD_HOME: join(dir, 'hud'),
    CODEX_HOME: join(dir, 'codex'),
    CLAUDE_CONFIG_DIR: join(dir, 'claude'),
    CODEX_HUD_CWD: dir,
  };
  for (const key of Object.keys(env))
    if (
      key.startsWith('HUD_PANEL_') ||
      ['NO_COLOR', 'FORCE_COLOR', 'HUD_SETTINGS_PATH', 'CODEX_HUD_SETTINGS_PATH', 'NODE_OPTIONS'].includes(key)
    )
      delete env[key];
  for (const part of ['home', 'hud', 'codex', 'claude', 'source']) fs.mkdirSync(join(dir, part), { mode: 0o700 });
  const fakeCalls = isolatePanelHerdr(env, dir);
  const store = new PanelStore(env);
  return { dir, env, store, fakeCalls };
}
async function until(predicate: () => boolean, ms = 15000) {
  const end = Date.now() + ms;
  while (!predicate() && Date.now() < end) await delay(20);
  assert.ok(predicate(), 'bounded synthetic panel observation');
}
for (const marker of [
  'HUD_PANEL_TOKEN',
  'HUD_PANEL_GENERATION',
  'HUD_PANEL_KEY',
  'HUD_PANEL_SOCKET',
  'HUD_PANEL_SERVER',
  'HUD_PANEL_HARNESS',
  'HUD_PANEL_UNKNOWN',
]) {
  test(`panel entry refuses single marker ${marker} before broad imports or paint`, (t) => {
    const f = setup(t);
    const out = spawnSync(
      process.execPath,
      [join(REPO, 'bin/hud'), 'panel', '--harness', 'pi', '--session', 'test', '--source', join(f.dir, 'source')],
      {
        env: { ...f.env, [marker]: 'incomplete' },
        encoding: 'utf8',
        timeout: 15000,
      }
    );
    assert.equal(out.status, 3, out.stderr);
    assert.equal(out.stdout, '');
    assert.equal(out.stderr, 'panel_registration_unavailable\n');
    assert.deepEqual(fs.readdirSync(f.env.CODEX_HOME!), []);
    assert.equal(fs.existsSync(f.store.directory), false);
  });
}
for (const variant of [
  'valid',
  'wrong-token',
  'missing-token',
  'wrong-socket',
  'wrong-stamp',
  'wrong-instance',
] as const) {
  test(
    `panel same-process entry ${variant}, actual workspace, lifetime finish and write isolation`,
    { timeout: 30000 },
    async (t) => {
      const f = setup(t);
      const socket = join(f.dir, 'herdr.sock');
      const methods: string[] = [];
      let panelPid = 0;
      let changedPane = false;
      const server = createServer((connection) => {
        let input = '';
        connection.on('data', (chunk) => {
          input += chunk.toString();
          if (!input.includes('\n')) return;
          const request = JSON.parse(input.trim());
          methods.push(request.method);
          const result =
            request.method === 'pane.get'
              ? {
                  pane: {
                    pane_id: 'panel',
                    tab_id: 'tab',
                    terminal_id: changedPane ? 'replacement-terminal' : 'terminal',
                    workspace_id: 'actual-workspace',
                  },
                }
              : request.method === 'pane.process_info'
                ? { process_info: { pane_id: 'panel', shell_pid: panelPid, foreground_process_group_id: panelPid } }
                : {};
          connection.end(JSON.stringify({ id: request.id, result }) + '\n');
        });
      });
      await new Promise<void>((r) => server.listen(socket, r));
      t.after(() => new Promise<void>((r) => server.close(() => r())));
      const stamp = readProcess(process.pid)!.stamp;
      const adapter = new CliPanelHerdr({ socket, server: stamp, env: f.env });
      const d = new PanelDeadline(4000);
      t.after(() => d.dispose());
      const instance = await adapter.instance(d);
      assert.ok(instance);
      const receipt: PanelReceipt = {
        schema: 1,
        kind: 'hud-panel-display',
        generation: randomUUID(),
        token: randomUUID(),
        phase: 'opening',
        target: displayTarget('pi', 'main-test', join(f.dir, 'source')),
        main: stamp,
        instance: instance!,
        origin: { pane: 'main', tab: 'tab', terminal: 'main-term', workspace: 'actual-workspace', process: stamp },
        runtime: { node: process.execPath, entry: join(REPO, 'bin/hud'), digest: 'a'.repeat(64) },
        createdPane: 'panel',
        createdWorkspace: 'actual-workspace',
        panel: null,
      };
      if (variant === 'wrong-instance') receipt.instance = 'different-instance';
      f.store.write(receipt);
      const launch = {
        ...f.env,
        HUD_PANEL_TOKEN: receipt.token,
        HUD_PANEL_KEY: panelKey(receipt),
        HUD_PANEL_GENERATION: receipt.generation,
        HUD_PANEL_SOCKET: socket,
        HUD_PANEL_SERVER: JSON.stringify(stamp),
        HERDR_SOCKET_PATH: '/ambient/never-used.sock',
      };
      if (variant === 'wrong-token') launch.HUD_PANEL_TOKEN = randomUUID();
      if (variant === 'missing-token') delete (launch as NodeJS.ProcessEnv).HUD_PANEL_TOKEN;
      if (variant === 'wrong-socket') launch.HUD_PANEL_SOCKET = join(f.dir, 'wrong.sock');
      if (variant === 'wrong-stamp') launch.HUD_PANEL_SERVER = JSON.stringify({ ...stamp, proc_start: '0' });
      // The loader fails if dispatch touches either general CLI entry, even after registration.
      const loader = join(f.dir, 'loader.mjs');
      fs.writeFileSync(
        loader,
        `export async function resolve(s,c,n){if(/\\/cli\\/(hud|hud-main)\\.js$/.test(s))throw Error('BROAD_CLI_LOADED');return n(s,c);}`
      );
      const argv = [
        process.execPath,
        receipt.runtime.entry,
        'panel',
        '--harness',
        'pi',
        '--session',
        receipt.target.ref.sessionId,
        '--source',
        receipt.target.source,
      ];
      const child = spawn('/usr/bin/python3', [join(REPO, 'tests/fakes/panel-pty.py'), JSON.stringify(argv)], {
        env: { ...launch, NODE_OPTIONS: `--loader=${loader}` },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        const match = stdout.match(/^PID=(\d+)/);
        if (match) panelPid = Number(match[1]);
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      t.after(() => {
        if (panelPid && child.exitCode === null) {
          try {
            process.kill(panelPid, 'SIGKILL');
          } catch {
            /* already exited */
          }
        }
        child.kill();
      });
      const exited = once(child, 'exit');
      if (variant !== 'valid') {
        const [code] = await exited;
        assert.equal(code, 3, stdout + stderr);
        assert.ok(stdout.includes('panel_registration_unavailable'));
        assert.ok(!stdout.includes('\x1b[?1049h'), 'refusal precedes paint');
        assert.equal(fs.existsSync(f.store.registration(receipt.token)), false);
        return;
      }
      await until(() => fs.existsSync(f.store.registration(receipt.token)));
      const registration = JSON.parse(fs.readFileSync(f.store.registration(receipt.token), 'utf8'));
      assert.equal(registration.panel.process.pid, panelPid, 'rendering and registration share the launched PID');
      assert.equal(registration.panel.workspace, 'actual-workspace');
      assert.ok(!methods.includes('workspace.list'), 'never query focused workspace');
      const herdr: PanelHerdr = {
        ...adapter,
        instance: (d) => adapter.instance(d),
        observe: (p, d, w) => adapter.observe(p, d, w),
        preflight: async () => {
          throw Error('must not split');
        },
        split: async () => {
          throw Error('must not split');
        },
        start: async () => {
          throw Error('must not run');
        },
        close: async () => {
          assert.fail('lifetime must not kill pane');
        },
      };
      const opened = await controlPanel('open', receipt, { env: f.env, herdr, native: null });
      assert.equal(opened.diagnostic, 'open', JSON.stringify(opened));
      assert.equal((await controlPanel('status', receipt, { env: f.env, herdr, native: null })).diagnostic, 'open');
      await until(() => stdout.includes('\x1b[?1049h'));
      const children = fs
        .readFileSync(`/proc/${panelPid}/task/${panelPid}/children`, 'utf8')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      for (const pid of children) {
        let image: string[] = [];
        try {
          image = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        } catch {
          /* short-lived Git probes may finish */
        }
        if (image[0] === process.execPath)
          assert.equal(
            image[1],
            join(f.env.PATH!, 'herdr'),
            'only the bounded fake observation CLI may be a Node child'
          );
      }
      assert.ok(!stdout.includes('BROAD_CLI_LOADED') && !stderr.includes('BROAD_CLI_LOADED'));
      // Entry really runs the panel; a receipt fence for an old generation cannot close it.
      f.store.fence({ ...receipt, generation: randomUUID() });
      await delay(1200);
      assert.equal(child.exitCode, null);
      // Actual ownership identity replacement takes the panel's existing finish path.
      changedPane = true;
      const [code] = await exited;
      assert.equal(code, 0, stdout + stderr);
      assert.ok(stdout.includes('\x1b[?1049l'), 'finish restores terminal');
      assert.deepEqual(fs.readdirSync(f.env.CODEX_HOME!), []);
      const sampled: string[][] = fs
        .readFileSync(f.fakeCalls, 'utf8')
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s));
      assert.ok(sampled.length > 0, 'independent panel sampler used only the fake CLI');
      assert.ok(sampled.every((args) => JSON.stringify(args) === JSON.stringify(['agent', 'list', '--json'])));
      assert.deepEqual(fs.readdirSync(f.env.PATH!).sort(), ['herdr', 'node']);
      assert.ok(!methods.some((m) => /close|split|run/.test(m)));
    }
  );
}
test('panel split forwards only its pinned endpoint fields, never ambient socket binding', async (t) => {
  const f = setup(t);
  const binary = join(f.dir, 'fake-herdr');
  const output = join(f.dir, 'args.json');
  fs.writeFileSync(
    binary,
    `#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({result:{pane:{pane_id:'panel',workspace_id:'reported'}}}));`,
    { mode: 0o700 }
  );
  // A .mjs suffix is unnecessary: the synthetic executable contains module syntax.
  const socket = join(f.dir, 'pinned.sock');
  const server = readProcess(process.pid)!.stamp;
  const adapter = new CliPanelHerdr({ socket, server, env: { ...f.env, HERDR_SOCKET_PATH: '/ambient.sock' }, binary });
  const deadline = new PanelDeadline(4000);
  t.after(() => deadline.dispose());
  const receipt = {
    target: displayTarget('pi', 'test', join(f.dir, 'source')),
    origin: { pane: 'main' },
  } as PanelReceipt;
  assert.deepEqual(await adapter.split(receipt, { HUD_PANEL_TOKEN: 'token' }, deadline), {
    pane: 'panel',
    workspace: 'reported',
  });
  const args: string[] = JSON.parse(fs.readFileSync(output, 'utf8'));
  const fields = args.flatMap((arg, n) => (arg === '--env' ? [args[n + 1]!] : []));
  assert.deepEqual(
    fields.sort(),
    [`HUD_PANEL_TOKEN=token`, `HUD_PANEL_SOCKET=${socket}`, `HUD_PANEL_SERVER=${JSON.stringify(server)}`].sort()
  );
  assert.ok(!fields.some((field) => field.startsWith('HERDR_SOCKET')));
});
test(
  'panel standalone without markers renders without registering a control receipt',
  { timeout: 30000 },
  async (t) => {
    const f = setup(t);
    const child = spawn(process.execPath, [join(REPO, 'bin/hud'), 'panel', '--root', 'synthetic/main'], {
      env: f.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.resume();
    t.after(() => child.kill('SIGKILL'));
    await until(() => out.includes('\x1b[?1049h'));
    const exited = once(child, 'exit');
    child.stdin.end();
    await exited;
    assert.equal(fs.existsSync(f.store.directory), false);
    assert.deepEqual(fs.readdirSync(f.env.CODEX_HOME!), []);
  }
);
