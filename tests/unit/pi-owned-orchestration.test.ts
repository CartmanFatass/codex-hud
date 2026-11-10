import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import { tmpdir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { REPO_ROOT } from '../fixtures/paths.js';
import { readProcess, processState } from '../../src/core/run/process.js';
import { runCommand } from '../../src/roles/herdr-run.js';
import { launchOwned, type LaunchOptions } from '../../src/roles/pi-owned/launch.js';
import { callHelper } from '../../src/roles/pi-owned/helpers.js';
import { reapOwned } from '../../src/roles/pi-owned/reap.js';
import { Deadline, Runtime, locked, type Journal, type Owner } from '../../src/roles/pi-owned/runtime.js';
import { editorHasPrompt } from '../../src/roles/pi-owned/prompt.js';
import {
  WORKER_ENTRY,
  HELPER_SKILL,
  ROLE_TOOLS,
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

async function launched(t: TestContext, role: DispatchRole = 'implementer', staged = false) {
  const f = await fixture(t, role, staged);
  const result = await launchOwned(f.context, f.options);
  assert.equal(result.state, 'acked', result.reason);
  return f;
}

test('owned launch: intent/outer transaction precede effects; structured argv; passive reads write nothing', async (t) => {
  const f = await launched(t);
  const j = f.journal();
  assert.ok(j.right);
  assert.notEqual(j.left, j.right);
  assert.equal(f.state().counts.tab, 1);
  assert.equal(f.state().counts.split, 1);
  assert.equal(f.state().counts.start, 1);
  assert.equal(f.state().counts.prompt, 1);
  for (const call of f.logs().filter((c) => c.step)) {
    assert.equal(call.intent, true);
    assert.equal(call.transaction, true);
  }
  const start = f.logs().find((c) => c.argv[0] === 'agent' && c.argv[1] === 'start').argv;
  assert.equal(start[start.indexOf('--hud-role-contract') + 1], f.paths.contract);
  assert.equal(start.includes('--no-approve'), true);
  const session = fs.readFileSync(join(f.directory, 'SESSION.txt'), 'utf8');
  assert.match(session, /ORCH=\n/);
  assert.equal(fs.existsSync(join(f.directory, 'STATUS.json')), false, 'launcher is not STATUS writer');
  const before = fs.statSync(join(f.directory, '.dispatch/primary/launch.json')).mtimeMs;
  await f.runtime().tab(j);
  await f.runtime().tab(j);
  assert.equal(fs.statSync(join(f.directory, '.dispatch/primary/launch.json')).mtimeMs, before);
  assert.equal((await launchOwned(f.context, f.options)).state, 'acked');
  assert.equal(f.state().counts.prompt, 1);
  const closed = await reapOwned(f.context, { ...f.options, graceMs: 200 });
  assert.equal(closed.state, 'closed', closed.remaining.join(','));
  assert.equal((await reapOwned(f.context, f.options)).state, 'closed');
});

for (const step of ['tab', 'split', 'start', 'prompt', 'enter'])
  for (const window of ['before', 'after']) {
    test(`owned crash matrix: lost ${step} reply ${window}; same-key retry has zero duplicates`, async (t) => {
      const f = await fixture(t);
      f.mode({ fault: `${step}:${window}`, ...(step === 'enter' ? { stall: 'editor' } : {}) });
      const first = await launchOwned(f.context, f.options);
      assert.equal(first.state, 'launch_unknown');
      assert.equal(f.state().counts[step], 1);
      f.mode({});
      const second = await launchOwned(f.context, f.options);
      assert.equal(f.state().counts[step], 1, `${step} must not be repeated`);
      const canReconcile = window === 'after' && ['start', 'prompt', 'enter'].includes(step);
      assert.equal(second.state, canReconcile ? 'acked' : 'launch_unknown', second.reason);
      const close = await reapOwned(f.context, { ...f.options, graceMs: 100 });
      if (['tab', 'split'].includes(step)) assert.equal(close.state, 'close_unresolved');
      for (const log of f.logs().filter((l) => l.step)) assert.equal(log.intent, true);
    });
  }

test('stall: only specific error eligible; persisted message does nothing; complete editor sends exactly one Enter', async (t) => {
  for (const stall of ['persisted', 'editor', 'unreadable']) {
    const f = await fixture(t);
    f.mode({ stall });
    const result = await launchOwned(f.context, f.options);
    assert.equal(result.state, stall === 'unreadable' ? 'launch_unknown' : 'acked', result.reason);
    assert.equal(f.state().counts.enter ?? 0, stall === 'editor' ? 1 : 0);
  }
  assert.equal(editorHasPrompt('transcript Read /task\n───\nwrong\n───\nfooter', 'Read /task'), false);
  assert.equal(editorHasPrompt('───\nRead /ta\nsk\n───\nfooter', 'Read /task'), true);
});

test('ownership: stale SESSION ignored; reused tab/label, foreign pane/session and unknown inventory refuse mutation', async (t) => {
  for (const variant of ['tab-label', 'tab-id', 'pane', 'session', 'terminal', 'agents', 'panes', 'tabs', 'parent']) {
    const f = await launched(t);
    put(join(f.directory, 'SESSION.txt'), 'TAB=caller-tab\nRIGHT=foreign\n');
    if (variant === 'parent') f.options.callerTabId = f.journal().tab!;
    else
      f.update((s) => {
        if (variant === 'tab-label') s.tabs[0].label = 'foreign-label';
        if (variant === 'tab-id') s.tabs[0].tab_id = 'reused-other-id';
        if (variant === 'pane') s.agents[0].pane_id = f.journal().right;
        if (variant === 'terminal') s.panes[0].terminal_id = 'reused-terminal';
        if (variant === 'session') s.agents[0].agent_session.value = join(f.directory, 'sessions/foreign.jsonl');
        if (['agents', 'panes', 'tabs'].includes(variant)) s.mode.unknown = variant;
      });
    const result = await reapOwned(f.context, { ...f.options, graceMs: 50 });
    assert.equal(result.state, 'close_unresolved', variant);
    assert.equal(f.state().counts.close ?? 0, 0, variant);
    assert.equal(
      f.logs().filter((c) => c.argv[0] === 'agent' && c.argv[1] === 'prompt' && c.argv[3] === '/quit').length,
      0,
      `${variant}: foreign ownership must not authorize quit`
    );
    assert.equal(processState(f.owner().process), 'alive', `${variant}: foreign ownership must not authorize a signal`);
  }
});

test('ownership: changed process start/boot/PID-domain never authorizes signal or close', async (t) => {
  for (const field of ['proc_start', 'boot_id', 'pid_domain'] as const) {
    const f = await launched(t);
    const o = f.owner();
    o.process[field] += '-reused';
    put(join(f.directory, '.dispatch/primary/owner.json'), o);
    const result = await reapOwned(f.context, { ...f.options, graceMs: 50 });
    assert.equal(result.state, 'close_unresolved');
    assert.equal(processState(readProcess(o.process.pid)!.stamp), 'alive');
    assert.equal(f.state().counts.close ?? 0, 0);
  }
});

test('helpers: numbered reservations, fixed limits, one at a time, wrappers, exact closed STATUS/verdict', async (t) => {
  const f = await launched(t);
  const request = join(f.context.cwd, 'small request.md');
  put(request, 'Perform a synthetic chore. Output elsewhere is not authoritative.');
  const sonic = await callHelper(f.context, f.helperOptions, { kind: 'sonic', brief_path: request, thinking: 'low' });
  assert.equal(sonic.ok, true, sonic.reason);
  assert.equal(sonic.n, 1);
  assert.equal(f.journal('sonic-1').pane, f.journal().right);
  const c = read<SlotContract>(slotPaths(f.directory, 'sonic-1').contract);
  assert.equal(c.effort, 'low');
  await until(() => !f.state().agents.some((a: any) => a.slot === 'sonic-1'));
  const review = await callHelper(f.context, f.helperOptions, { kind: 'reviewer' });
  assert.equal(review.ok, true, review.reason);
  assert.match(review.text!, /^Verdict: accept\n/);
  const failed = await launched(t);
  const foreign = failed.journal().right;
  failed.update((s) =>
    s.agents.push({
      name: 'foreign',
      pane_id: foreign,
      tab_id: failed.journal().tab,
      agent: 'pi',
      agent_status: 'idle',
    })
  );
  const blocked = await callHelper(failed.context, failed.helperOptions, { kind: 'reviewer' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.n, 1);
  assert.ok(fs.existsSync(join(failed.directory, 'review_brief-1.md')));
  failed.update((s) => {
    s.agents = s.agents.filter((a: any) => a.name !== 'foreign');
  });
  const next = await callHelper(failed.context, failed.helperOptions, { kind: 'reviewer' });
  assert.equal(next.n, 2);
  assert.equal(next.ok, true, next.reason);
  put(join(failed.directory, 'review_brief-3.md'), 'reserved failed round');
  const limit = await callHelper(failed.context, failed.helperOptions, { kind: 'reviewer' });
  assert.match(limit.reason!, /helper_limit/);
  put(join(failed.directory, 'sonic_brief-10.md'), 'reserved failed round');
  assert.match(
    (await callHelper(failed.context, failed.helperOptions, { kind: 'sonic', brief_path: request })).reason!,
    /helper_limit/
  );
  assert.ok(f.pending.some((value) => value && typeof value === 'object' && 'n' in value));
  const closed = await reapOwned(f.context, { ...f.options, graceMs: 200 });
  assert.equal(closed.state, 'closed', closed.remaining.join(','));
});

test('helpers: disappeared right pane is split only inside owned tab; foreign occupant is never adopted', async (t) => {
  const f = await launched(t);
  const original = f.journal().right;
  f.update((s) => {
    s.panes = s.panes.filter((p: any) => p.pane_id !== original);
  });
  const result = await callHelper(f.context, f.helperOptions, { kind: 'reviewer' });
  assert.equal(result.ok, true, result.reason);
  assert.notEqual(f.journal().right, original);
  assert.equal(f.journal('review-1').tab, f.journal().tab);
  assert.equal(f.state().counts.helper_split_1, 1);
  const replacement = f.journal().right;
  await until(() => !f.state().agents.some((a: any) => a.slot === 'review-1'));
  const replay = await launchOwned(f.context, f.options);
  assert.equal(replay.state, 'acked', replay.reason);
  assert.equal(f.journal().right, replacement);
  assert.match(fs.readFileSync(join(f.directory, 'SESSION.txt'), 'utf8'), new RegExp(`RIGHT=${replacement}\\n`));
  const next = await callHelper(f.context, f.helperOptions, { kind: 'reviewer' });
  assert.equal(next.ok, true, next.reason);
  assert.equal(f.journal('review-2').pane, replacement);
  assert.equal(f.state().counts.helper_split_2 ?? 0, 0);
  assert.equal(f.state().panes.length, 2);
});

test('helpers: invalid settlement and verdict fail; concurrent call is busy; abort cleans exact helper', async (t) => {
  for (const mode of ['missing-output', 'invalid-verdict']) {
    const f = await launched(t);
    f.mode({ helper: mode });
    const result = await callHelper(f.context, f.helperOptions, { kind: 'reviewer' });
    assert.equal(result.ok, false);
    assert.match(result.reason!, /artifact_unsettled|invalid_verdict/);
  }
  const f = await launched(t);
  f.mode({ helper: 'unsettled' });
  const controller = new AbortController();
  const first = callHelper(f.context, { ...f.helperOptions, signal: controller.signal }, { kind: 'reviewer' });
  await until(() => f.state().agents.length === 2);
  const second = await callHelper(f.context, f.helperOptions, { kind: 'reviewer' });
  assert.match(second.reason!, /helper_busy/);
  controller.abort();
  const result = await first;
  assert.equal(result.ok, false);
  await until(() => f.state().agents.length === 1);
  assert.equal(f.state().agents[0].slot, 'primary');
});

test('a durable closing fence before launch admits no resource', async (t) => {
  const f = await fixture(t);
  put(join(f.directory, '.dispatch/control.json'), { closing: true, generation: 1 });
  const result = await launchOwned(f.context, f.options);
  assert.equal(result.state, 'launch_unknown');
  assert.equal(f.state().counts.tab ?? 0, 0);
  assert.equal(f.state().counts.start ?? 0, 0);
});

test('closing fence wins future steps and accounts for an already-admitted bounded start', async (t) => {
  const f = await fixture(t);
  f.mode({ delay: 25 });
  const launch = launchOwned(f.context, f.options);
  await until(() => f.logs().some((l) => l.step === 'start'));
  const close = reapOwned(f.context, { ...f.options, graceMs: 200 });
  const [l, c] = await Promise.all([launch, close]);
  assert.equal(c.state, 'closed', c.remaining.join(','));
  assert.equal(l.state, 'launch_unknown');
  assert.equal(f.state().counts.prompt ?? 0, 0);
  const counts = f.state().counts;
  const retry = await launchOwned(f.context, f.options);
  assert.equal(retry.state, 'launch_unknown');
  assert.equal(f.state().counts.start, counts.start);
  assert.equal(f.state().counts.tab, counts.tab);
});

test('one monotonic budget bounds metadata chain, partial cleanup and finite post-exit adapter', async (t) => {
  const f = await fixture(t);
  f.mode({ delay: 100 });
  const start = performance.now();
  const result = await launchOwned(f.context, { ...f.options, budgetMs: 230 });
  assert.equal(result.state, 'launch_unknown');
  assert.ok(performance.now() - start < 1500);
  const g = await launched(t, 'sonic');
  g.mode({ ignoreQuit: true, delay: 100 });
  const began = performance.now();
  const cleanup = await reapOwned(g.context, { ...g.options, budgetMs: 240 });
  assert.equal(cleanup.state, 'close_unresolved');
  assert.ok(performance.now() - began < 1500);
  const h = await launched(t, 'sonic', true);
  const status = {
    version: 1,
    task_dir: h.directory,
    slot: 'primary',
    role: 'sonic',
    session_id: h.contract.session_id,
    output_path: h.paths.output,
    model: h.contract.model,
    thinking: h.contract.effort,
    output_written: true,
    state: 'closed',
    helper_pending: null,
    settled_at: new Date().toISOString(),
    idle_deadline_at: null,
    ended_at: null,
    exit_reason: 'complete',
    error: null,
  };
  put(join(h.directory, 'STATUS.json'), status);
  const postStart = performance.now();
  const post = await h.artifact.reaper.runPostExitReaper(
    {
      context: h.context,
      endpoint: h.options.endpoint,
      callerTabId: h.options.callerTabId,
      primary: h.owner().process,
      waitMs: 50,
      budgetMs: 200,
    },
    h.env
  );
  assert.equal(post.state, 'close_unresolved');
  assert.deepEqual(post.remaining, ['primary_not_exited']);
  assert.ok(performance.now() - postStart < 1000);
});

test('SIGTERM requires full process stamp and exact contract/session argv; no workload SIGKILL', async (t) => {
  const f = await launched(t, 'sonic');
  f.mode({ ignoreQuit: true });
  const owner = f.owner();
  const closed = await reapOwned(f.context, { ...f.options, graceMs: 0 });
  assert.equal(closed.state, 'closed', closed.remaining.join(','));
  assert.equal(processState(owner.process), 'dead');
  const g = await launched(t, 'sonic');
  g.mode({ ignoreQuit: true });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const stamp = readProcess(unrelated.pid!)!.stamp;
  try {
    const o = g.owner();
    o.process = stamp;
    put(join(g.directory, '.dispatch/primary/owner.json'), o);
    const refused = await reapOwned(g.context, { ...g.options, graceMs: 0 });
    assert.equal(refused.state, 'close_unresolved');
    assert.match(refused.remaining.join(','), /process_arguments_unknown/);
    assert.equal(processState(stamp), 'alive');
  } finally {
    const exited = once(unrelated, 'exit');
    unrelated.kill('SIGTERM');
    await exited;
  }
});

test('process-instance locks: live/old refuses; dead and reused PID stamp reclaimed without signalling', async (t) => {
  const f = await fixture(t);
  const file = join(f.directory, '.dispatch/resources.lock');
  const alive = readProcess(process.pid)!.stamp;
  put(file, { process: alive, nonce: 'live' });
  fs.utimesSync(file, new Date(0), new Date(0));
  await assert.rejects(
    locked(f.directory, 'resources', new Deadline(40), async () => 1),
    /deadline/
  );
  assert.equal(processState(alive), 'alive');
  const reused = { ...alive, proc_start: alive.proc_start + '9' };
  put(file, { process: reused, nonce: 'reused' });
  assert.equal(await locked(f.directory, 'resources', new Deadline(200), async () => 7), 7);
  assert.equal(processState(alive), 'alive');
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const stamp = readProcess(child.pid!)!.stamp;
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  await exit;
  put(file, { process: stamp, nonce: 'dead' });
  assert.equal(await locked(f.directory, 'resources', new Deadline(200), async () => 8), 8);
  put(file, 'unreadable');
  await assert.rejects(
    locked(f.directory, 'resources', new Deadline(200), async () => 1),
    /lock_unknown/
  );
});

test('transport cancellation kills only its synthetic CLI, disposes pipes/timers and preabort does not spawn', async () => {
  const handles = () => (process as unknown as { _getActiveHandles(): object[] })._getActiveHandles();
  const before = new Set(handles());
  const controller = new AbortController();
  const operation = runCommand(
    process.execPath,
    ['-e', 'process.stdout.write(String(process.pid)); setInterval(()=>{},1000)'],
    process.env,
    { signal: controller.signal, budgetMs: 3000 }
  );
  await pause(100);
  controller.abort();
  const result = await operation;
  assert.equal(result.reason, 'aborted');
  if (result.stdout)
    await until(() => !readProcess(Number(result.stdout)) || readProcess(Number(result.stdout))!.state === 'Z');
  assert.equal(
    (await runCommand('never-spawn-this', [], process.env, { signal: controller.signal })).reason,
    'aborted'
  );
  await pause(20);
  assert.deepEqual(
    handles().filter((handle) => !before.has(handle)),
    [],
    'no new child, pipe or IPC handles survive'
  );
});

test('preflight/startup gate refuses unsupported env, missing transaction/dependency and missing/mismatched owner before any prompt', async (t) => {
  for (const variant of ['environment', 'transaction', 'integration', 'missing', 'mismatch']) {
    const f = await fixture(t, 'sonic');
    if (variant === 'environment') f.options.envProfile = 'unsupported';
    if (variant === 'transaction') fs.unlinkSync(f.options.indexPath);
    if (variant === 'integration') f.mode({ integration: 'outdated' });
    if (['missing', 'mismatch'].includes(variant)) {
      f.mode({ startup: variant });
      f.options.budgetMs = 1300;
    }
    const result = await launchOwned(f.context, f.options);
    assert.equal(result.state, 'launch_unknown', variant);
    assert.equal(f.state().counts.prompt ?? 0, 0, variant);
    if (['environment', 'transaction', 'integration'].includes(variant))
      assert.equal(f.state().counts.tab ?? 0, 0, variant);
  }
});

test('explicit unsent intent can execute once; already-sent steps never become retry queues', async (t) => {
  const f = await fixture(t, 'sonic');
  f.mode({ fault: 'tab:before' });
  await launchOwned(f.context, f.options);
  const j = f.journal();
  // Represents an intent saved before admission, not a dispatched/lost step.
  j.steps.tab = { state: 'intent' };
  put(join(f.directory, '.dispatch/primary/launch.json'), j);
  f.mode({});
  const result = await launchOwned(f.context, f.options);
  assert.equal(result.state, 'acked', result.reason);
  assert.equal(f.state().tabs.length, 1);
  assert.equal((await launchOwned(f.context, f.options)).state, 'acked');
  assert.equal(f.state().counts.tab, 2);
});

test('integration discovery is cached but a byte-identical replaced managed hook is refused', async (t) => {
  const f = await launched(t, 'sonic');
  const path = f.contract.herdr_integration.path;
  put(path + '.replacement', fs.readFileSync(path, 'utf8'));
  fs.renameSync(path + '.replacement', path);
  const result = await launchOwned(f.context, f.options);
  assert.equal(result.state, 'launch_unknown');
  assert.match(result.reason!, /herdr_pi_integration_missing/);
  assert.equal(f.state().counts['integration status'], 1);
  assert.equal(f.state().counts.start, 1);
});

test('helpers run process-local managed-integration preflight before pane/start mutations', async (t) => {
  const f = await launched(t);
  f.mode({ integration: 'outdated' });
  const module = pathToFileURL(join(REPO_ROOT, 'dist-test/src/roles/pi-owned/helpers.js')).href;
  const payload = {
    context: f.context,
    options: { endpoint: f.options.endpoint, callerTabId: f.options.callerTabId, budgetMs: 5000 },
  };
  // Helpers really run inside a different pi process from the original launcher;
  // execute the real module in a fresh process so discovery has no inherited cache.
  const script = `const {callHelper}=await import(process.argv[1]); const p=JSON.parse(process.argv[2]); const result=await callHelper(p.context,{...p.options,env:process.env,waitingHelper:async()=>{}},{kind:'reviewer'}); console.log(JSON.stringify(result));`;
  const child = await runCommand(
    process.execPath,
    ['--input-type=module', '-e', script, module, JSON.stringify(payload)],
    f.env,
    { budgetMs: 7000 }
  );
  assert.equal(child.ok, true, child.stderr);
  const result = JSON.parse(child.stdout) as { ok: boolean; reason: string };
  assert.equal(result.ok, false);
  assert.match(result.reason, /herdr_pi_integration_missing/);
  assert.equal(f.state().counts.start, 1);
  assert.equal(f.state().counts.split, 1);
  const g = await launched(t);
  const path = g.contract.herdr_integration.path;
  put(path + '.replacement', fs.readFileSync(path, 'utf8'));
  fs.renameSync(path + '.replacement', path);
  const replaced = await callHelper(g.context, g.helperOptions, { kind: 'reviewer' });
  assert.equal(replaced.ok, false);
  assert.match(replaced.reason!, /herdr_pi_integration_missing/);
  assert.equal(g.state().counts.start, 1);
  assert.equal(g.state().counts.split, 1);
});

test('editor matching preserves exact whitespace in paths while accepting only display wraps', () => {
  const prompt = 'Read /tmp/job space/brief.md and do exactly what it asks.';
  assert.equal(
    editorHasPrompt(`───\nRead /tmp/job \nspace/brief.md and do exactly what it asks.\n───\nfooter`, prompt),
    true
  );
  assert.equal(
    editorHasPrompt(`───\nRead /tmp/jobspace/brief.md and do exactly what it asks.\n───\nfooter`, prompt),
    false
  );
  assert.equal(
    editorHasPrompt(`───\nRead /tmp/job  space/brief.md and do exactly what it asks.\n───\nfooter`, prompt),
    false
  );
});

test('stall unknown session/editor/working evidence never sends Enter', async (t) => {
  for (const stall of ['bad-session', 'wrong-editor', 'working', 'whitespace-altered']) {
    const f = await fixture(t, 'sonic');
    f.mode({ stall });
    assert.equal((await launchOwned(f.context, f.options)).state, 'launch_unknown');
    assert.equal(f.state().counts.enter ?? 0, 0, stall);
  }
});

test('helper own idle occupant may retire, but unchanged artifact and orphan reservation cannot succeed', async (t) => {
  const f = await launched(t);
  f.mode({ helper: 'stay-alive' });
  const first = await callHelper(f.context, f.helperOptions, { kind: 'reviewer' });
  assert.equal(first.ok, true, first.reason);
  await until(() => f.state().agents.some((a: any) => a.slot === 'review-1' && a.agent_status === 'idle'));
  f.mode({});
  const next = await callHelper(f.context, f.helperOptions, { kind: 'reviewer' });
  assert.equal(next.ok, true, next.reason);
  assert.equal(f.journal('review-2').pane, f.journal('review-1').pane);
  assert.notEqual(f.journal('review-2').session_id, f.journal('review-1').session_id);
  const g = await launched(t);
  g.mode({ helper: 'unchanged-output' });
  const unchanged = await callHelper(
    g.context,
    {
      ...g.helperOptions,
      waitingHelper: async (pending) => {
        if (pending) put(join(g.directory, `review-${pending.n}.md`), 'Verdict: accept\nUnchanged artifact.\n');
      },
    },
    { kind: 'reviewer' }
  );
  assert.equal(unchanged.ok, false);
  assert.match(unchanged.reason!, /artifact_unsettled/);
  put(join(g.directory, '.dispatch/current.json'), {
    kind: 'review',
    n: 1,
    slot: 'review-1',
    status_file: '',
    state: 'reserved',
  });
  const orphan = await callHelper(g.context, g.helperOptions, { kind: 'reviewer' });
  assert.match(orphan.reason!, /helper_busy/);
  assert.equal(fs.existsSync(join(g.directory, 'review_brief-2.md')), false);
});

test('finite reaper executable exits when primary never exits; autoclose and explicit close are one idempotent operation', async (t) => {
  const f = await launched(t, 'sonic', true);
  const status = {
    version: 1,
    task_dir: f.directory,
    slot: 'primary',
    role: 'sonic',
    session_id: f.contract.session_id,
    output_path: f.paths.output,
    model: f.contract.model,
    thinking: f.contract.effort,
    output_written: true,
    state: 'closed',
    helper_pending: null,
    settled_at: new Date().toISOString(),
    idle_deadline_at: null,
    ended_at: null,
    exit_reason: 'complete',
    error: null,
  };
  put(join(f.directory, 'STATUS.json'), status);
  const request = {
    context: f.context,
    endpoint: f.options.endpoint,
    callerTabId: f.options.callerTabId,
    primary: f.owner().process,
    waitMs: 50,
    budgetMs: 4000,
  };
  const executable = join(f.context.release.root, 'dist/roles/pi-owned/reap-main.js');
  const finite = await runCommand(
    process.execPath,
    [executable, '--owned-reap', Buffer.from(JSON.stringify(request)).toString('base64url')],
    f.env,
    { budgetMs: 1500 }
  );
  assert.equal(finite.exitCode, 1, finite.stderr);
  assert.match(finite.stdout, /primary_not_exited/);
  const { spawnPostExitReaper, runPostExitReaper } = f.artifact.reaper;
  // Spawn intent is exclusive even if the pinned entry later fails; no second attempt.
  assert.equal(await spawnPostExitReaper(f.context, { ...f.options, keepTab: true }), false);
  assert.equal(await spawnPostExitReaper(f.context, f.options), true);
  assert.equal(await spawnPostExitReaper(f.context, f.options), false);
  const owner = f.owner();
  process.kill(owner.process.pid, 'SIGTERM');
  await until(() => processState(owner.process) === 'dead' && f.state().agents.length === 0);
  const [auto, explicit] = await Promise.all([runPostExitReaper(request, f.env), reapOwned(f.context, f.options)]);
  assert.equal(auto.state, 'closed', auto.remaining.join(','));
  assert.equal(explicit.state, 'closed', explicit.remaining.join(','));
  assert.equal(f.state().counts.close, 1);
  assert.equal(read(join(f.directory, 'STATUS.json')).state, 'closed');
});

test('cost: cold fake launch n=20; launcher STATUS writes=0, unchanged journal reads=0 writes', async (t) => {
  const times: number[] = [];
  const journalWrites: number[] = [];
  for (let n = 0; n < 20; n++) {
    const f = await fixture(t, 'sonic');
    const started = performance.now();
    const result = await launchOwned(f.context, f.options);
    times.push(performance.now() - started);
    assert.equal(result.state, 'acked', result.reason);
    assert.equal(fs.existsSync(join(f.directory, 'STATUS.json')), false);
    await pause(10);
    journalWrites.push(f.writeCounts.journal);
    assert.equal(f.writeCounts.status, 0);
    const resultClose = await reapOwned(f.context, { ...f.options, graceMs: 200 });
    assert.equal(resultClose.state, 'closed', resultClose.remaining.join(','));
  }
  times.sort((a, b) => a - b);
  t.diagnostic(
    `host=${hostname()} n=20 warmup=0 cold fake launch p50=${times[9]!.toFixed(1)}ms p95=${times[18]!.toFixed(1)}ms STATUS writes=0; observed atomic journal replacements=${Math.min(...journalWrites)}..${Math.max(...journalWrites)}`
  );
});

for (const role of ['reviewer', 'architect'] as const)
  test(`nested sonic: primary ${role} splits down, read-only grant, shared numbering, closed pane`, async (t) => {
    const f = await launched(t, role);
    const brief = join(f.directory, 'source.md');
    put(brief, 'small chore');
    for (let n = 1; n <= 2; n++) {
      const answer = await callHelper(f.context, f.helperOptions, { kind: 'sonic', brief_path: brief });
      if (!answer.ok)
        t.diagnostic(
          JSON.stringify({ answer, calls: f.logs().slice(-12), state: f.state(), journal: f.journal(`sonic-${n}`) })
        );
      assert.equal(answer.ok, true, answer.reason);
      assert.equal(answer.n, n);
      const c = read<SlotContract>(slotPaths(f.directory, `sonic-${n}`).contract);
      assert.equal(c.parent_slot, 'primary');
      assert.equal(c.read_only, true);
      assert.deepEqual(c.allowed_write_paths, [join(f.directory, `sonic-${n}.md`)]);
    }
    const splits = f.logs().filter((c) => c.argv[0] === 'pane' && c.argv[1] === 'split');
    assert.equal(splits.length, 2);
    for (const split of splits) {
      assert.equal(split.argv[2], f.journal().pane);
      assert.equal(split.argv[4], 'down');
    }
    assert.equal(f.state().panes.length, 1);
    assert.equal(f.logs().filter((c) => c.argv[0] === 'pane' && c.argv[1] === 'close').length, 2);
  });
test('nested sonic: helper reviewer borrows child reservation without job mutex or right-pane claim', async (t) => {
  const f = await fixture(t);
  put(join(f.directory, 'sonic-source.md'), 'small chore');
  f.mode({ helper: 'nested-sonic' });
  const launched = await launchOwned(f.context, f.options);
  assert.equal(launched.state, 'acked', launched.reason);
  const file = join(f.directory, '.dispatch/primary/helper-outcome.json');
  await until(() => fs.existsSync(file), 20000);
  const answer = read(file);
  if (!answer.ok)
    t.diagnostic(
      JSON.stringify({
        answer,
        calls: f.logs().slice(-20),
        state: f.state(),
        nested: fs.existsSync(join(f.directory, '.dispatch/review-1/helper-outcome.json'))
          ? read(join(f.directory, '.dispatch/review-1/helper-outcome.json'))
          : null,
      })
    );
  assert.equal(answer.ok, true, answer.reason);
  const nested = read(join(f.directory, '.dispatch/review-1/helper-outcome.json'));
  assert.equal(nested.ok, true, nested.reason);
  const split = f.logs().find((c) => c.argv[0] === 'pane' && c.argv[1] === 'split' && c.argv[4] === 'down');
  assert.ok(split);
  assert.equal(split.argv[2], f.journal('review-1').pane);
  assert.notEqual(f.journal('sonic-1').pane, f.journal().right);
  assert.equal(read<SlotContract>(slotPaths(f.directory, 'sonic-1').contract).parent_slot, 'review-1');
  assert.equal(f.state().panes.length, 2);
  assert.equal(f.state().counts.start, 3);
  // The implementer resumes its original lane after the reviewer has returned;
  // numbering and the ten-call cap are shared with the nested caller above.
  f.mode({});
  const next = await callHelper(f.context, f.helperOptions, {
    kind: 'sonic',
    brief_path: join(f.directory, 'sonic-source.md'),
  });
  assert.equal(next.ok, true, next.reason);
  assert.equal(next.n, 2);
  assert.equal(f.journal('sonic-2').pane, f.journal().right);
  assert.equal(read<SlotContract>(slotPaths(f.directory, 'sonic-2').contract).parent_slot, 'primary');
  for (let n = 3; n <= 10; n++) put(join(f.directory, `sonic_brief-${n}.md`), 'reserved failed synthetic call');
  const calls = f.state().counts.start;
  const capped = await callHelper(f.context, f.helperOptions, {
    kind: 'sonic',
    brief_path: join(f.directory, 'sonic-source.md'),
  });
  assert.equal(capped.ok, false);
  assert.match(capped.reason ?? '', /helper_limit/);
  assert.equal(f.state().counts.start, calls);
});
for (const outcome of ['closed', 'failed', 'crash'])
  test(`borrowed sonic child is cleaned before ${outcome} reviewer release`, async (t) => {
    const f = await fixture(t);
    put(join(f.directory, 'sonic-source.md'), 'small chore');
    f.mode({ helper: outcome === 'closed' ? 'orphan-child' : `orphan-child-${outcome}` });
    assert.equal((await launchOwned(f.context, f.options)).state, 'acked');
    const resultFile = join(f.directory, '.dispatch/primary/helper-outcome.json');
    await until(() => fs.existsSync(resultFile), 25000);
    const result = read(resultFile);
    assert.equal(result.ok, outcome === 'closed', result.reason);
    assert.equal(processState(read(join(f.directory, '.dispatch/sonic-1/owner.json')).process), 'dead');
    assert.equal(
      f.state().panes.some((p: { pane_id: string }) => p.pane_id === f.journal('sonic-1').pane),
      false
    );
    assert.equal(read(join(f.directory, '.dispatch/review-1/current.json')).state, 'failed');
    assert.equal(read(join(f.directory, '.dispatch/current.json')).state, outcome === 'closed' ? 'complete' : 'failed');
    f.mode({});
    const next = await callHelper(f.context, f.helperOptions, {
      kind: 'sonic',
      brief_path: join(f.directory, 'sonic-source.md'),
    });
    assert.equal(next.ok, true, next.reason);
    assert.equal(next.n, 2);
  });
test('unknown borrowed child cleanup retains outer reservation; both helper kinds refuse until explicit reap', async (t) => {
  const f = await fixture(t);
  put(join(f.directory, 'sonic-source.md'), 'small chore');
  f.mode({ helper: 'orphan-child-unknown' });
  assert.equal((await launchOwned(f.context, f.options)).state, 'acked');
  const resultFile = join(f.directory, '.dispatch/primary/helper-outcome.json');
  await until(() => fs.existsSync(resultFile), 20000);
  assert.equal(read(resultFile).ok, false);
  assert.match(read(resultFile).reason, /helper_unresolved:sonic-1/);
  const outer = read(join(f.directory, '.dispatch/current.json'));
  assert.equal(outer.state, 'reserved');
  assert.equal(outer.unresolved_child, 'sonic-1');
  assert.equal(processState(read(join(f.directory, '.dispatch/sonic-1/owner.json')).process), 'alive');
  const starts = f.state().counts.start;
  for (const kind of ['sonic', 'reviewer'] as const) {
    const next = await callHelper(f.context, f.helperOptions, {
      kind,
      brief_path: join(f.directory, 'sonic-source.md'),
    });
    assert.equal(next.ok, false);
    assert.match(next.reason ?? '', /helper_unresolved:sonic-1/);
  }
  assert.equal(f.state().counts.start, starts);
  const uncertain = await reapOwned(f.context, f.options);
  assert.equal(uncertain.state, 'close_unresolved');
  f.mode({});
  const closed = await reapOwned(f.context, f.options);
  assert.equal(closed.state, 'closed', closed.remaining.join(','));
  assert.equal(f.state().panes.length, 0);
  assert.equal(f.state().agents.length, 0);
});
test('reap covers an acknowledged leftover nested pane after helper close failure', async (t) => {
  const f = await launched(t, 'architect');
  const brief = join(f.directory, 'source.md');
  put(brief, 'chore');
  f.mode({ blockPaneClose: true });
  const answer = await callHelper(f.context, f.helperOptions, { kind: 'sonic', brief_path: brief });
  assert.equal(answer.ok, false);
  assert.equal(f.state().panes.length, 2);
  f.mode({});
  const result = await reapOwned(f.context, f.options);
  assert.equal(result.state, 'closed', result.remaining.join(','));
  assert.equal(f.state().panes.length, 0);
});
test('nested sonic lost split reply leaves unresolved reservation, no second split, reap covers leftover', async (t) => {
  const f = await launched(t, 'architect');
  const brief = join(f.directory, 'source.md');
  put(brief, 'chore');
  f.mode({ fault: 'split:after' });
  const first = await callHelper(f.context, f.helperOptions, { kind: 'sonic', brief_path: brief });
  assert.equal(first.ok, false);
  f.mode({});
  const second = await callHelper(f.context, f.helperOptions, { kind: 'sonic', brief_path: brief });
  assert.match(second.reason ?? '', /^helper_busy/);
  assert.equal(f.state().counts.split, 1);
  assert.equal(f.state().panes.length, 2);
  const reap = await reapOwned(f.context, f.options);
  assert.equal(reap.state, 'close_unresolved');
  assert.match(reap.remaining.join(','), /terminal_changed|split_outcome_unknown/);
});
for (const mode of ['wrong-model', 'wrong-effort'])
  test(`helper STATUS ${mode} fails contract validation`, async (t) => {
    const f = await launched(t);
    const brief = join(f.directory, 'source.md');
    put(brief, 'chore');
    f.mode({ helper: mode });
    const answer = await callHelper(f.context, f.helperOptions, { kind: 'sonic', brief_path: brief });
    assert.equal(answer.reason, 'helper_binding_mismatch');
  });
test('stall lazy session: missing first file requires full editor and after Enter persistence; foreign prompt result refused', async (t) => {
  const f = await fixture(t);
  f.mode({ stall: 'editor', noEnterPersist: true });
  const answer = await launchOwned(f.context, f.options);
  assert.equal(answer.state, 'launch_unknown');
  assert.equal(f.state().counts.enter, 1);
  assert.notEqual(f.journal().steps.prompt?.state, 'acked');
  const g = await fixture(t);
  g.mode({ promptAgentMismatch: true });
  const mismatch = await launchOwned(g.context, g.options);
  assert.equal(mismatch.reason, 'prompt_owner_mismatch');
  assert.equal(g.state().counts.enter ?? 0, 0);
});

test('runtime binding is immutable and callerTabId is protection, never cleanup authority', async (t) => {
  const f = await launched(t);
  const file = join(f.directory, '.dispatch/runtime.json');
  const binding = read(file);
  assert.deepEqual(binding, { endpoint: f.options.endpoint, callerTabId: f.options.callerTabId });
  const again = await launchOwned(f.context, { ...f.options, callerTabId: 'tampered' });
  assert.equal(again.reason, 'runtime_binding_changed');
  put(file, { ...binding, callerTabId: f.journal().tab });
  const denied = await reapOwned(f.context, { ...f.options, callerTabId: f.journal().tab! });
  assert.equal(denied.state, 'close_unresolved');
  assert.equal(f.state().tabs.length, 1);
  assert.equal(
    f.logs().some((c) => c.argv[0] === 'tab' && c.argv[1] === 'close' && c.argv[2] === 'caller-tab'),
    false
  );
});

const installedPi = async () =>
  (await import(pathToFileURL(join(REPO_ROOT, 'tests/fakes/pi-package.mjs')).href)).piPackage();
for (const role of ['implementer', 'reviewer', 'architect', 'sonic'] as const)
  test(`real pi loader worker ${role} startup and two-entry ownership`, async (t) => {
    const pkg = await installedPi();
    if (!pkg) {
      t.skip('pi package loader unavailable on PATH and PI_PACKAGE_DIR');
      return;
    }
    t.diagnostic(`pi ${pkg.version}; provider-free installed loader, real SessionManager, staged A1 worker`);
    const f = await fixture(t, role, true);
    f.mode({ startup: 'real-loader' });
    const answer = await launchOwned(f.context, { ...f.options, budgetMs: 20000 });
    assert.equal(answer.state, 'acked', answer.reason);
    const proof = read(join(f.directory, '.dispatch/primary/loader-evidence.json'));
    assert.deepEqual(proof.errors, []);
    assert.equal(proof.extensions, 2);
    assert.equal(proof.ownerWriters, 1);
    assert.equal(proof.sessionPersisted, false);
    assert.deepEqual(proof.active, ROLE_TOOLS[role].split(','));
    assert.deepEqual(
      proof.tools.sort(),
      ROLE_TOOLS[role]
        .split(',')
        .filter((x) => x.startsWith('call_') || x === 'ask_orchestrator')
        .sort()
    );
    assert.equal(f.owner().model, f.contract.model);
    assert.equal(f.owner().effort, f.contract.effort);
    const out = await f
      .runtime()
      .call([
        'test',
        'probe',
        f.journal().name,
        JSON.stringify({ event: 'tool_call', payload: { toolName: 'hud_create', input: {} } }),
      ]);
    assert.equal(out.ok, true);
    const resultFile = join(f.directory, '.dispatch/primary/probe-result.json');
    await until(() => fs.existsSync(resultFile));
    assert.equal(read(resultFile).answer.block, true);
    fs.unlinkSync(resultFile);
    await f.runtime().call(['test', 'probe', f.journal().name, JSON.stringify({ builtinWrite: true })]);
    await until(() => fs.existsSync(resultFile));
    assert.equal(read(resultFile).answer.isError ?? false, false);
    assert.equal(fs.readFileSync(f.paths.output, 'utf8'), 'native tool report\n');
    for (const path of [f.paths.output, f.owner().session_file, join(f.directory, 'STATUS.json')])
      assert.equal(fs.statSync(path).mode & 0o077, 0);
    if (role === 'sonic') assert.equal(proof.tools.includes('call_sonic'), false);
    if (role === 'implementer') {
      fs.unlinkSync(resultFile);
      await f.runtime().call(['test', 'probe', f.journal().name, JSON.stringify({ event: 'agent_end' })]);
      await until(() => fs.existsSync(resultFile));
      assert.equal(read(join(f.directory, 'STATUS.json')).state, 'working');
    }
  });
for (const mode of ['real-model-mismatch', 'real-effort-mismatch', 'loader-failure'])
  test(`real pi loader ${mode} fails before prompt`, async (t) => {
    const pkg = await installedPi();
    if (!pkg) {
      t.skip('pi package loader unavailable');
      return;
    }
    t.diagnostic(`pi ${pkg.version}`);
    const f = await fixture(t, 'sonic', true);
    if (mode === 'loader-failure') {
      const invalid = join(f.root, 'invalid.ts');
      put(invalid, 'this is not TypeScript }');
      f.artifact.copy(WORKER_ENTRY, invalid);
      put(join(f.context.release.root, 'RUNTIME-MANIFEST.json'), f.artifact.manifest);
      f.context.release = await f.artifact.releaseModule.loadWorkerRelease();
      f.contract.release = { id: f.context.release.id, root: f.context.release.root };
      put(f.paths.contract, f.contract);
    }
    f.mode({ startup: mode });
    const answer = await launchOwned(f.context, { ...f.options, budgetMs: 6000 });
    assert.equal(answer.state, 'launch_unknown');
    assert.equal(f.state().counts.prompt ?? 0, 0);
    const proof = read(join(f.directory, '.dispatch/primary/loader-evidence.json'));
    assert.equal(proof.shutdown || proof.errors.length > 0, true);
    assert.equal(fs.existsSync(join(f.directory, '.dispatch/primary/owner.json')), false);
  });

test('implementer unused grace expiry spawns one real pinned reaper; quit/failure/used grace no attempt; explicit close race', async (t) => {
  const f = await launched(t, 'implementer', true);
  const status = {
    version: 1,
    task_dir: f.directory,
    slot: 'primary',
    role: 'implementer',
    session_id: f.contract.session_id,
    model: f.contract.model,
    thinking: f.contract.effort,
    output_path: f.paths.output,
    output_written: true,
    state: 'closed',
    helper_pending: null,
    settled_at: new Date().toISOString(),
    idle_deadline_at: null,
    ended_at: new Date().toISOString(),
    exit_reason: 'idle_grace_expired',
    error: null,
  };
  put(f.paths.output, 'settled output');
  const marker = join(f.directory, '.dispatch/primary/autoclose.json');
  for (const reason of ['shutdown_quit', 'shutdown_reload', 'idle_grace_expired_used']) {
    put(join(f.directory, 'STATUS.json'), { ...status, exit_reason: reason });
    assert.equal(await f.artifact.reaper.spawnPostExitReaper(f.context, f.options), false);
    assert.equal(fs.existsSync(marker), false);
  }
  put(join(f.directory, 'STATUS.json'), { ...status, state: 'failed' });
  assert.equal(await f.artifact.reaper.spawnPostExitReaper(f.context, f.options), false);
  put(join(f.directory, 'STATUS.json'), status);
  assert.equal(await f.artifact.reaper.spawnPostExitReaper(f.context, { ...f.options, keepTab: true }), false);
  assert.equal(await f.artifact.reaper.spawnPostExitReaper(f.context, f.options), true);
  assert.equal(await f.artifact.reaper.spawnPostExitReaper(f.context, f.options), false);
  const primary = f.owner().process;
  process.kill(primary.pid, 'SIGTERM');
  await until(() => processState(primary) === 'dead' && f.state().agents.length === 0);
  const request = {
    context: f.context,
    endpoint: f.options.endpoint,
    callerTabId: 'tampered-unrelated-tab',
    primary,
    waitMs: 50,
    budgetMs: 5000,
  };
  const [automatic, explicit] = await Promise.all([
    f.artifact.reaper.runPostExitReaper(request, f.env),
    reapOwned(f.context, f.options),
  ]);
  assert.equal(automatic.state, 'closed', automatic.remaining.join(','));
  assert.equal(explicit.state, 'closed', explicit.remaining.join(','));
  assert.equal(f.state().counts.close, 1);
  assert.equal(f.state().tabs.length, 0);
});
test('trusted A1 inventory rejects replaced worker/reaper bytes, never composition-supplied hashes', async (t) => {
  const f = await fixture(t, 'sonic', true);
  const entry = join(f.context.release.root, 'dist/roles/pi-owned/reap-main.js');
  fs.appendFileSync(entry, '\n// replaced\n');
  await assert.rejects(f.artifact.releaseModule.loadWorkerRelease(), /bundle_integrity_mismatch/);
  await assert.rejects(f.artifact.reaper.spawnPostExitReaper(f.context, f.options), /bundle_integrity_mismatch/);
  assert.equal(f.state().counts.start ?? 0, 0);
});
test('lazy session first-write header mismatch refuses acknowledgment; missing runtime binding never falls back', async (t) => {
  const f = await fixture(t);
  f.mode({ helper: 'header-mismatch' });
  const result = await launchOwned(f.context, f.options);
  assert.equal(result.state, 'launch_unknown');
  assert.match(result.reason ?? '', /session_unknown/);
  assert.notEqual(f.journal().steps.prompt?.state, 'acked');
  const g = await launched(t);
  const brief = join(g.directory, 'source.md');
  put(brief, 'chore');
  fs.unlinkSync(join(g.directory, '.dispatch/runtime.json'));
  const helper = await callHelper(g.context, g.helperOptions, { kind: 'sonic', brief_path: brief });
  assert.match(helper.reason ?? '', /runtime_binding_invalid/);
  assert.equal(g.state().counts.start, 1);
  const replay = await launchOwned(g.context, g.options);
  assert.equal(replay.reason, 'runtime_binding_missing');
});
test('cost: cold real pi loader worker start n=20 and semantic STATUS write count', async (t) => {
  const pkg = await installedPi();
  if (!pkg) {
    t.skip('pi loader unavailable on PATH and PI_PACKAGE_DIR');
    return;
  }
  const times: number[] = [];
  const writes: number[] = [];
  for (let n = 0; n < 20; n++) {
    const f = await fixture(t, 'sonic', true);
    f.mode({ startup: 'real-loader' });
    const start = performance.now();
    const outcome = await launchOwned(f.context, { ...f.options, budgetMs: 20000 });
    times.push(performance.now() - start);
    assert.equal(outcome.state, 'acked', outcome.reason);
    await pause(10);
    writes.push(f.writeCounts.status);
    assert.equal(f.writeCounts.status, 1);
    const inode = fs.statSync(join(f.directory, 'STATUS.json'), { bigint: true }).ino;
    for (let i = 0; i < 10; i++) fs.readFileSync(join(f.directory, 'STATUS.json'));
    assert.equal(fs.statSync(join(f.directory, 'STATUS.json'), { bigint: true }).ino, inode);
    const closed = await reapOwned(f.context, { ...f.options, graceMs: 200 });
    assert.equal(closed.state, 'closed', closed.remaining.join(','));
  }
  times.sort((a, b) => a - b);
  t.diagnostic(
    `host=${hostname()} pi=${pkg.version} n=20 warmup=0 cold fake-herdr real-loader worker startup p50=${times[9]!.toFixed(1)}ms p95=${times[18]!.toFixed(1)}ms startup STATUS writes=${Math.min(...writes)}..${Math.max(...writes)}; unchanged reads=0 writes`
  );
});
