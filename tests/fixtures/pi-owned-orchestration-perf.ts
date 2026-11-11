import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { REPO_ROOT } from './paths.js';
import { readProcess, processState } from '../../src/core/run/process.js';
import { type LaunchOptions } from '../../src/roles/pi-owned/launch.js';
import { Deadline, Runtime, type Journal, type Owner } from '../../src/roles/pi-owned/runtime.js';
import {
  WORKER_ENTRY,
  HELPER_SKILL,
  roleResource,
  slotPaths,
  type ContractContext,
  type SlotContract,
} from '../../src/roles/pi-owned/contracts.js';
import { PI_ROLE_DEFAULTS } from '../../src/roles/routing.js';
import type { DispatchRole } from '../../src/roles/pi-dispatch.js';

function put(file: string, value: unknown): void {
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
}
function read<T = any>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}
async function until(body: () => boolean, ms = 4000): Promise<void> {
  const end = performance.now() + ms;
  while (!body()) {
    if (performance.now() >= end) throw new Error('test condition timed out');
    await pause(10);
  }
}
async function fixture(t: TestContext, role: DispatchRole = 'implementer', staged = false) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hpo-')));
  const home = join(root, 'home');
  const directory = join(home, 'jobs', 'j0123456789abcdef');
  const cwd = join(root, "work ' ; $() Ω");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cwd, { mode: 0o700 });
  const releaseRoot = join(root, 'release space');
  const resources: Record<string, string> = {};
  for (const path of [
    WORKER_ENTRY,
    HELPER_SKILL,
    ...(['implementer', 'sonic', 'reviewer', 'architect'] as const).map(roleResource),
  ]) {
    const text = `synthetic ${path}\n`;
    put(join(releaseRoot, path), text);
    resources[path] = createHash('sha256').update(text).digest('hex');
  }
  const integration = join(root, 'herdr integration.ts');
  put(
    integration,
    '// managed by herdr\n// HERDR_INTEGRATION_ID=pi\n// HERDR_INTEGRATION_VERSION=9\nexport default function reporter(pi) { pi.on("session_start", () => {}); }\n'
  );
  const artifact = staged
    ? await (await import(pathToFileURL(join(REPO_ROOT, 'tests/fakes/pi-owned-release.mjs')).href)).stagedWorker(t)
    : null;
  const context: ContractContext = {
    jobDirectory: directory,
    cwd,
    release: artifact?.release ?? { id: 'synthetic-release', root: releaseRoot, resources },
  };
  const paths = slotPaths(directory, 'primary');
  put(paths.brief, 'Synthetic task.\n');
  const contract: SlotContract = {
    schema: 1,
    job: 'j0123456789abcdef',
    slot: 'primary',
    role,
    task_dir: directory,
    cwd,
    brief_path: paths.brief,
    output_path: paths.output,
    qa_dir: paths.qa,
    session_dir: paths.sessions,
    session_id: 'synthetic-primary',
    release: { id: context.release.id, root: context.release.root },
    role_resource: {
      path: join(context.release.root, roleResource(role)),
      sha256: context.release.resources[roleResource(role)]!,
    },
    model: PI_ROLE_DEFAULTS[role].model,
    effort: PI_ROLE_DEFAULTS[role].effort,
    allowed_write_paths: [paths.output],
    helpers: { sonic: { ...PI_ROLE_DEFAULTS.sonic }, reviewer: { ...PI_ROLE_DEFAULTS.reviewer } },
    herdr_integration: { path: integration, version: 9 },
  };
  put(paths.contract, contract);
  const indexPath = join(home, 'jobs/index/key.json');
  const associationPath = join(home, 'assoc', `${contract.job}.json`);
  for (const path of [join(directory, 'receipt.json'), indexPath, associationPath]) put(path, { job: contract.job });
  const bin = join(root, 'bin');
  fs.mkdirSync(bin, { mode: 0o700 });
  fs.symlinkSync(join(REPO_ROOT, 'tests/fakes/pi-owned-herdr.mjs'), join(bin, 'herdr'));
  put(join(bin, 'pi'), '#!/bin/sh\nexit 99\n');
  fs.chmodSync(join(bin, 'pi'), 0o700);
  const socketPath = join(root, 'socket');
  const statePath = join(root, 'herdr-state.json');
  const logPath = join(root, 'herdr-calls.jsonl');
  put(statePath, { n: 0, tabs: [], panes: [], agents: [], mode: {}, counts: {} });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    HUD_HOME: home,
    CODEX_HOME: join(home, 'codex'),
    PATH: `${bin}:${process.env.PATH}`,
    OWNED_PROCESS_MODULE: pathToFileURL(join(REPO_ROOT, 'dist-test/src/core/run/process.js')).href,
    OWNED_HELPERS_MODULE: pathToFileURL(join(REPO_ROOT, 'dist-test/src/roles/pi-owned/helpers.js')).href,
    OWNED_PI_PACKAGE: staged
      ? (await (await import(pathToFileURL(join(REPO_ROOT, 'tests/fakes/pi-package.mjs')).href)).piPackage())?.root
      : undefined,
    JITI_FS_CACHE: '0',
  };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  const server = fork(
    join(REPO_ROOT, 'tests/fakes/pi-owned-herdr.mjs'),
    ['--server', socketPath, root, directory, integration],
    { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
  );
  let stderr = '';
  server.stderr!.on('data', (chunk) => {
    stderr += String(chunk);
  });
  await once(server, 'message');
  const stamp = readProcess(server.pid!)!.stamp;
  const options: LaunchOptions = {
    endpoint: { socketPath, server: stamp },
    env,
    callerTabId: 'caller-tab',
    indexPath,
    associationPath,
    budgetMs: 15000,
  };
  const state = () => read(statePath);
  const update = (body: (state: any) => void) => {
    const s = state();
    body(s);
    put(statePath, s);
  };
  const mode = (value: Record<string, unknown>) =>
    update((s) => {
      s.mode = value;
    });
  const journal = (slot = 'primary') => read<Journal>(join(directory, '.dispatch', slot, 'launch.json'));
  const owner = (slot = 'primary') => read<Owner>(join(directory, '.dispatch', slot, 'owner.json'));
  const logs = () =>
    fs.existsSync(logPath)
      ? fs
          .readFileSync(logPath, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const writeCounts = { journal: 0, status: 0 };
  const journalWatch = fs.watch(join(directory, '.dispatch/primary'), { persistent: false }, (event, name) => {
    if (event === 'rename' && name === 'launch.json') writeCounts.journal++;
  });
  const statusWatch = fs.watch(directory, { persistent: false }, (event, name) => {
    if (event === 'rename' && name === 'STATUS.json') writeCounts.status++;
  });
  const pending: unknown[] = [];
  const helperOptions = {
    ...options,
    waitingHelper: async (value: unknown) => {
      pending.push(value);
    },
  };
  t.after(async () => {
    journalWatch.close();
    statusWatch.close();
    const processes = fs.existsSync(directory)
      ? fs
          .readdirSync(join(directory, '.dispatch'))
          .filter((name) => /^(primary|sonic-\d+|review-\d+)$/.test(name))
          .flatMap((name) => {
            try {
              return [owner(name).process];
            } catch {
              return [];
            }
          })
      : [];
    if (server.exitCode === null) {
      const exit = once(server, 'exit');
      server.kill('SIGTERM');
      await exit;
    }
    await until(() => processes.every((p) => processState(p) !== 'alive'));
    assert.equal(stderr, '');
    await until(() =>
      logs().every(
        (l) => !l.transport_pid || !readProcess(l.transport_pid) || readProcess(l.transport_pid)!.state === 'Z'
      )
    );
    fs.rmSync(root, { recursive: true, force: true });
  });
  const runtime = (budget = 5000, signal?: AbortSignal) => new Runtime(context, options, new Deadline(budget, signal));
  return {
    root,
    artifact,
    home,
    directory,
    context,
    contract,
    paths,
    options,
    server,
    env,
    mode,
    state,
    update,
    journal,
    owner,
    logs,
    pending,
    helperOptions,
    runtime,
    writeCounts,
  };
}

const installedPi = async () =>
  (await import(pathToFileURL(join(REPO_ROOT, 'tests/fakes/pi-package.mjs')).href)).piPackage();
export { put, read, until, fixture, installedPi };
