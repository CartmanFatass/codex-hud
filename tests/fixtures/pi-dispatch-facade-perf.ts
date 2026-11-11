import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { before, type TestContext } from 'node:test';
import { hudCreate, type FacadeContext } from '../../src/roles/facade.js';
import { readProcess } from '../../src/core/run/process.js';
import { parseRosterRoot } from '../../src/roles/selection.js';
import { runHerdr } from '../../src/roles/herdr-run.js';
import { REPO_ROOT } from './paths.js';

const ROUTING = `schema=1
default_preset="daily"
[backends.pi]
executor="herdr"
harness="pi"
model="synthetic/model"
effort="high"
recipe="pi-role"
[backends.browser]
executor="jev"
target="browser"
[jev_decisions.local]
provider="typesafe"
[presets.daily]
description="Synthetic preset"
jev_decisions="local"
[presets.daily.roles]
"oracle.propose"="pi"
"oracle.converge"="pi"
imp="pi"
sonic="pi"
reviewer="pi"
jev="browser"
`;
function put(file: string, value: unknown) {
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
}
function json(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
async function until(body: () => boolean, ms = 10000) {
  const end = performance.now() + ms;
  while (!body()) {
    if (performance.now() >= end) throw new Error('fixture condition timed out');
    await pause(10);
  }
}
let artifact: any;
let releaseRoot: string;
let piPackage: string;
before(async (t) => {
  artifact = await (
    await import(pathToFileURL(join(REPO_ROOT, 'tests/fakes/pi-owned-release.mjs')).href)
  ).stagedWorker(t);
  const installer = await import(pathToFileURL(join(REPO_ROOT, 'scripts/runtime-package/installer.mjs')).href);
  const { PI_WORKER_FILES } = await import(pathToFileURL(join(REPO_ROOT, 'scripts/runtime-package/manifest.mjs')).href);
  assert.ok(
    PI_WORKER_FILES.includes('dist/roles/pi-owned/facade-context.js'),
    'owned acquisition module must be required inventory'
  );
  const plan = installer.planInstall(artifact.bundle, artifact.prefix);
  installer.executeInstall(artifact.bundle, artifact.prefix, plan.planDigest);
  releaseRoot = join(artifact.prefix, 'releases', artifact.release.id);
  piPackage = (await (await import(pathToFileURL(join(REPO_ROOT, 'tests/fakes/pi-package.mjs')).href)).piPackage())
    ?.root;
  assert.ok(piPackage, 'provider-free installed pi loader required');
});
async function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-pr4-')));
  const home = join(root, 'home');
  const work = join(root, "work space ' ; $() Ω");
  const bin = join(root, 'bin');
  for (const dir of [home, work, bin]) fs.mkdirSync(dir, { mode: 0o700 });
  put(join(home, 'routing.toml'), ROUTING);
  fs.symlinkSync(join(REPO_ROOT, 'tests/fakes/pi-owned-herdr.mjs'), join(bin, 'herdr'));
  put(join(bin, 'pi'), '#!/bin/sh\nexit 99\n');
  fs.chmodSync(join(bin, 'pi'), 0o700);
  const hostile = join(root, 'hostile.log');
  for (const name of ['pi-dispatch', 'pi-role', 'pi-role-reap']) {
    put(join(bin, name), `#!/bin/sh\necho ${name} >> '${hostile}'\nexit 91\n`);
    fs.chmodSync(join(bin, name), 0o700);
  }
  const integration = join(root, 'integration.ts');
  put(
    integration,
    '// HERDR_INTEGRATION_ID=pi\n// HERDR_INTEGRATION_VERSION=9\nexport default function(pi) { pi.on("session_start", () => {}); }\n'
  );
  const statePath = join(root, 'herdr-state.json');
  put(statePath, { n: 0, tabs: [], panes: [], agents: [], mode: { startup: 'real-loader' }, counts: {} });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    HUD_HOME: home,
    CODEX_HOME: join(root, 'codex'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    OWNED_PI_PACKAGE: piPackage,
    JITI_FS_CACHE: '0',
    HUD_KEEP_TAB: '1',
    OWNED_FAKE_TTL: '600',
  };
  for (const key of [
    'NO_COLOR',
    'FORCE_COLOR',
    'HUD_SETTINGS_PATH',
    'CODEX_HUD_SETTINGS_PATH',
    'HERDR_SOCKET',
    'HERDR_SOCKET_PATH',
    'HERDR_PANE_ID',
    'HERDR_ENV',
  ])
    delete env[key];
  const socketPath = join(root, 'socket');
  const server = fork(
    join(REPO_ROOT, 'tests/fakes/pi-owned-herdr.mjs'),
    ['--server', socketPath, root, '-', integration],
    { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
  );
  let errors = '';
  server.stderr!.on('data', (b) => (errors += b));
  await once(server, 'message');
  const runtime = { endpoint: { socketPath, server: readProcess(server.pid!)!.stamp }, callerTabId: 'caller-tab' };
  env.HERDR_SOCKET_PATH = socketPath;
  const ctx: FacadeContext = {
    home,
    env,
    root: parseRosterRoot('synthetic/main'),
    piOwned: { releaseRoot, runtime },
    herdrBudgetMs: 15000,
  };
  const directory = (job: unknown) => join(home, 'jobs', String(job));
  const receipt = (job: unknown) => json(join(directory(job), 'receipt.json'));
  const state = () => json(statePath);
  const logs = () =>
    fs.existsSync(join(root, 'herdr-calls.jsonl'))
      ? fs
          .readFileSync(join(root, 'herdr-calls.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((s) => JSON.parse(s))
      : [];
  const create = (key = 'task', extra = {}) =>
    hudCreate(ctx, { role: 'imp', cwd: work, task: 'Synthetic task. Preserve scope.', request_key: key, ...extra });
  const probeSlot = async (job: unknown, slot: string, value: object, wait = true) => {
    const r = receipt(job);
    const j = json(join(directory(job), `.dispatch/${slot}/launch.json`));
    const result = join(directory(job), `.dispatch/${slot}/probe-result.json`);
    if (fs.existsSync(result)) fs.unlinkSync(result);
    assert.equal(
      (await runHerdr(['test', 'probe', j.name, JSON.stringify(value)], { ...env, HERDR_SOCKET_PATH: socketPath })).ok,
      true
    );
    if (wait) await until(() => fs.existsSync(result));
    return r;
  };
  const probe = (job: unknown, value: object, wait = true) => probeSlot(job, 'primary', value, wait);
  const settle = async (job: unknown) => {
    await probe(job, { event: 'before_agent_start' });
    put(join(directory(job), 'report.md'), 'Synthetic completed report.\n');
    await probe(job, { event: 'agent_settled' });
    assert.equal(json(join(directory(job), 'STATUS.json')).state, 'idle_grace');
  };
  t.after(async () => {
    if (server.exitCode === null) {
      const exit = once(server, 'exit');
      server.kill('SIGTERM');
      await exit;
    }
    assert.equal(errors, '');
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    home,
    bin,
    env,
    ctx,
    runtime,
    work,
    directory,
    receipt,
    state,
    logs,
    create,
    hostile,
    probe,
    probeSlot,
    settle,
  };
}
export { ROUTING, put, json, until, artifact, releaseRoot, piPackage, fixture };
