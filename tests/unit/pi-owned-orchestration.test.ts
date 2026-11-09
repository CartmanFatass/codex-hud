import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:net';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { readProcess, processState, sameStamp } from '../../src/core/run/process.js';
import { runCommand } from '../../src/roles/herdr-run.js';
import {
  HELPER_SKILL,
  WORKER_ENTRY,
  roleResource,
  slotPaths,
  type SlotContract,
} from '../../src/roles/pi-owned/contracts.js';
import {
  launchOwned,
  Deadline,
  resourceLock,
  readJournal,
  readOwner,
  jsonRead,
  jsonWrite,
  dispatchPath,
  type OwnedRuntime,
} from '../../src/roles/pi-owned/launch.js';
import { runHelper, type HelperRuntime } from '../../src/roles/pi-owned/helpers.js';
import { reapOwned, signalOwnedWorker, retireHelper } from '../../src/roles/pi-owned/reap.js';
import { runReaper } from '../../src/roles/pi-owned/reap-main.js';
import { REPO_ROOT } from '../fixtures/paths.js';

function put(file: string, value: unknown): void {
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value) + '\n', { mode: 0o600 });
}
function fixture(t: TestContext, role: SlotContract['role'] = 'implementer') {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-pr2-')));
  const home = join(root, 'home');
  const job = 'j0123456789abcdef';
  const directory = join(home, 'jobs', job);
  const cwd = join(root, 'work space ; $literal Ω');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cwd, { mode: 0o700 });
  const release = { id: 'synthetic-release', root: join(root, 'release'), resources: {} as Record<string, string> };
  for (const relative of [
    WORKER_ENTRY,
    HELPER_SKILL,
    ...(['implementer', 'sonic', 'reviewer', 'architect'] as const).map(roleResource),
  ]) {
    const text = `Synthetic resource ${relative}\n`;
    put(join(release.root, relative), text);
    release.resources[relative] = createHash('sha256').update(text).digest('hex');
  }
  const integration = join(root, 'herdr integration.ts');
  put(integration, '// HERDR_INTEGRATION_ID=pi\n// HERDR_INTEGRATION_VERSION=9\n');
  const paths = slotPaths(directory, 'primary');
  put(paths.brief, 'Synthetic task.\n');
  const c: SlotContract = {
    schema: 1,
    job,
    slot: 'primary',
    role,
    task_dir: directory,
    cwd,
    brief_path: paths.brief,
    output_path: paths.output,
    qa_dir: paths.qa,
    session_dir: paths.sessions,
    session_id: randomUUID(),
    release: { id: release.id, root: release.root },
    role_resource: { path: join(release.root, roleResource(role)), sha256: release.resources[roleResource(role)] },
    model: 'synthetic/provider',
    effort: 'high',
    allowed_write_paths: [paths.output],
    helpers: {
      sonic: { model: 'synthetic/sonic', effort: 'high' },
      reviewer: { model: 'synthetic/reviewer', effort: 'xhigh' },
    },
    herdr_integration: { path: integration, version: 9 },
  };
  put(paths.contract, c);
  put(join(directory, 'receipt.json'), { schema: 1, job, binding: { env_profile: null } });
  const index = join(home, 'jobs/index/synthetic/key.json');
  put(index, { job });
  put(join(home, 'assoc', `${job}.json`), { job });
  const bin = join(root, 'bin');
  fs.mkdirSync(bin, { mode: 0o700 });
  fs.symlinkSync(join(REPO_ROOT, 'tests/fakes/pi-owned-herdr.mjs'), join(bin, 'herdr'));
  fs.symlinkSync(process.execPath, join(bin, 'pi'));
  const env: NodeJS.ProcessEnv & { HERDR_FAKE_STATE: string; HERDR_FAKE_LOG: string } = {
    ...process.env,
    HOME: home,
    HUD_HOME: home,
    PATH: bin + ':' + process.env.PATH,
    HERDR_FAKE_STATE: join(root, 'state.json'),
    HERDR_FAKE_LOG: join(root, 'calls.jsonl'),
    HERDR_FAKE_JOB: directory,
    HERDR_FAKE_INTEGRATION: integration,
    HERDR_FAKE_WORKER_LOG: join(root, 'worker-pids.jsonl'),
    HERDR_FAKE_WORKER: join(REPO_ROOT, 'tests/fakes/pi-owned-worker.mjs'),
    HERDR_FAKE_PROCESS_MODULE: new URL('../../src/core/run/process.js', import.meta.url).href,
  };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  const socketPath = join(root, 'endpoint.sock');
  const server = createServer();
  server.listen(socketPath);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const runtime: OwnedRuntime = {
    endpoint: { socketPath, server: readProcess(process.pid)!.stamp },
    context: { jobDirectory: directory, cwd, release },
    env,
    indexPath: index,
    callerTab: 'caller-tab',
    budgetMs: 15_000,
  };
  const writes = { journal: 0, status: 0 };
  const journalWatch = fs.watch(dirname(paths.contract), (event, name) => {
    if (event === 'rename' && name?.toString() === 'launch.json') writes.journal++;
  });
  const statusWatch = fs.watch(directory, (event, name) => {
    if (event === 'rename' && name?.toString() === 'STATUS.json') writes.status++;
  });
  t.after(() => {
    journalWatch.close();
    statusWatch.close();
  });
  const calls = () =>
    fs.existsSync(env.HERDR_FAKE_LOG)
      ? fs
          .readFileSync(env.HERDR_FAKE_LOG, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  const state = () => JSON.parse(fs.readFileSync(env.HERDR_FAKE_STATE, 'utf8'));
  const saveState = (value: unknown) => put(env.HERDR_FAKE_STATE, value);
  t.after(async () => {
    if (fs.existsSync(env.HERDR_FAKE_WORKER_LOG!))
      for (const line of fs.readFileSync(env.HERDR_FAKE_WORKER_LOG!, 'utf8').trim().split('\n')) {
        try {
          const stamp = JSON.parse(line);
          if (sameStamp(stamp, readProcess(stamp.pid)!.stamp)) process.kill(stamp.pid, 'SIGTERM');
        } catch {}
      }
    await delay(25);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home, directory, c, runtime, paths, env, calls, state, saveState, writes };
}
function helperRuntime(f: ReturnType<typeof fixture>, extra: Partial<HelperRuntime> = {}): HelperRuntime {
  return {
    ...f.runtime,
    primarySlot: 'primary',
    onPending: async (pending) => {
      const path = join(f.directory, 'STATUS.json');
      const s = jsonRead(path, f.directory);
      jsonWrite(path, { ...s, state: pending ? 'waiting_helper' : 'working', helper_pending: pending }, f.directory);
    },
    helperBudgetMs: 15_000,
    cleanupBudgetMs: 1000,
    ...extra,
  };
}
async function launched(t: TestContext, role: SlotContract['role'] = 'implementer') {
  const f = fixture(t, role);
  const result = await launchOwned(f.runtime);
  assert.equal(result.state, 'acked', result.error);
  return f;
}
const effects = (f: ReturnType<typeof fixture>, step: string) => f.calls().filter((c) => c.step === step);

test('PR2 real subprocess launch: intents and facade files precede all effects, exact argv, private SESSION, unchanged reads', async (t) => {
  const f = await launched(t);
  const j = readJournal(f.c)!;
  assert.equal(f.state().tabs.length, 1);
  assert.equal(f.state().panes.length, 2);
  assert.equal(readOwner(f.c, j)?.session_id, f.c.session_id);
  for (const call of f.calls().filter((c) => c.step))
    for (const key of ['intent_before', 'receipt_before', 'index_before', 'association_before'])
      assert.equal(call[key], true, JSON.stringify(call));
  assert.match(fs.readFileSync(join(f.directory, 'SESSION.txt'), 'utf8'), /ORCH=\n/);
  assert.equal(fs.statSync(dispatchPath(f.directory, 'primary/launch.json')).mode & 0o777, 0o600);
  const before = fs.statSync(dispatchPath(f.directory, 'primary/launch.json')).mtimeMs;
  for (let i = 0; i < 10; i++) {
    readJournal(f.c);
    readOwner(f.c, j);
  }
  assert.equal(fs.statSync(dispatchPath(f.directory, 'primary/launch.json')).mtimeMs, before);
  await launchOwned(f.runtime);
  assert.equal(effects(f, 'tab').length, 1);
  assert.equal(effects(f, 'split').length, 1);
  assert.equal(effects(f, 'start').length, 1);
  assert.equal(effects(f, 'prompt').length, 1);
});

for (const step of ['tab', 'split', 'start', 'prompt', 'enter'])
  for (const window of ['before', 'after'])
    test(`PR2 crash matrix ${step}-${window}: same key never repeats an effect`, async (t) => {
      const f = fixture(t);
      f.runtime.env.HERDR_FAKE_MODE = `${step}-${window}`;
      f.runtime.budgetMs = 8000;
      const first = await launchOwned(f.runtime);
      f.runtime.env.HERDR_FAKE_MODE = 'ok';
      const second = await launchOwned(f.runtime);
      assert.equal(effects(f, step).length, 1, JSON.stringify(f.calls()));
      if (['tab', 'split'].includes(step) || window === 'before') assert.equal(first.state, 'launch_unknown');
      if (['tab', 'split'].includes(step)) {
        assert.equal(second.state, 'launch_unknown');
        assert.equal((await reapOwned({ ...f.runtime, budgetMs: 1500 })).state, 'close_unresolved');
      }
      if (step === 'enter' && window === 'before') {
        assert.equal(second.state, 'launch_unknown');
        assert.equal(effects(f, 'enter').length, 1);
      }
    });

test('PR2 stall: exactly one Enter; matching message requires no Enter; lost ack reconciles read-only', async (t) => {
  for (const mode of ['prompt-stalled', 'prompt-after', 'enter-after']) {
    const f = fixture(t);
    f.runtime.env.HERDR_FAKE_MODE = mode;
    const result = await launchOwned(f.runtime);
    assert.equal(result.state, 'acked', result.error);
    assert.equal(effects(f, 'enter').length, mode === 'prompt-after' ? 0 : 1);
    await launchOwned(f.runtime);
    assert.equal(effects(f, 'enter').length, mode === 'prompt-after' ? 0 : 1);
  }
});

test('PR2 helper reservations, pinned models, right pane reuse, closed STATUS and changed artifact', async (t) => {
  const f = await launched(t);
  const sonic = join(f.c.cwd, 'request.md');
  put(sonic, 'Synthetic small chore.');
  const first = await runHelper(helperRuntime(f), { kind: 'sonic', brief_path: sonic, thinking: 'low' });
  assert.equal(first.slot, 'sonic-1');
  assert.match(first.text, /Synthetic helper/);
  const second = await runHelper(helperRuntime(f), { kind: 'reviewer' });
  assert.equal(second.verdict, 'accept');
  assert.equal(f.state().panes.length, 2);
  assert.equal(effects(f, 'split').length, 1);
  assert.equal(jsonRead(slotPaths(f.directory, 'sonic-1').contract, f.directory).effort, 'low');
  assert.equal(jsonRead(dispatchPath(f.directory, 'current.json'), f.directory).state, 'closed');
  for (const call of f.calls().filter((c) => ['start', 'prompt', 'enter'].includes(c.step)))
    assert.equal(call.intent_before, true);
});

for (const mode of ['missing-output', 'bad-verdict', 'no-settlement', 'blocked'])
  test(`PR2 helper refuses ${mode}, consumes reservation and bounded cancellation`, async (t) => {
    const f = await launched(t);
    f.env.HERDR_FAKE_HELPER = mode;
    const controller = new AbortController();
    const pending = runHelper(
      helperRuntime(f, {
        helperBudgetMs: mode === 'blocked' || mode === 'no-settlement' ? 1800 : 10_000,
        signal: controller.signal,
      }),
      { kind: 'reviewer' }
    );
    await assert.rejects(pending, /helper_failed|deadline|aborted/);
    assert.ok(fs.existsSync(join(f.directory, 'review_brief-1.md')));
    assert.equal(effects(f, 'start').length, 2);
  });

test('PR2 foreign right occupant blocks helper; disappeared right creates split in same tab', async (t) => {
  const f = await launched(t);
  const s = f.state();
  const j = readJournal(f.c)!;
  s.agents.push({
    name: 'foreign',
    pane_id: j.right,
    tab_id: j.tab,
    agent_status: 'idle',
    session_id: 'foreign',
    session_file: '/synthetic/foreign',
  });
  f.saveState(s);
  await assert.rejects(runHelper(helperRuntime(f), { kind: 'reviewer' }), /helper_busy/);
  assert.equal(effects(f, 'start').length, 1);
  const next = f.state();
  next.agents = next.agents.filter((a: any) => a.name !== 'foreign');
  next.panes = next.panes.filter((p: any) => p.pane_id !== j.right);
  f.saveState(next);
  // Failed reservation was consumed; its unresolved current record is inspect/cleanup only.
  jsonWrite(dispatchPath(f.directory, 'current.json'), { schema: 1, state: 'closed' }, f.directory);
  const result = await runHelper(helperRuntime(f), { kind: 'reviewer' });
  assert.equal(result.slot, 'review-2');
  assert.equal(effects(f, 'split').length, 2);
  assert.equal(f.state().tabs.length, 1);
});

test('PR2 close establishes fence, reaps once, second close idempotent; stale SESSION grants no authority', async (t) => {
  const f = await launched(t);
  put(join(f.directory, 'SESSION.txt'), 'TAB=caller-tab\nPRIMARY=foreign\n');
  const result = await reapOwned(f.runtime);
  assert.equal(result.state, 'closed', JSON.stringify(result));
  assert.equal(f.state().tabs.length, 0);
  assert.equal((await reapOwned(f.runtime)).state, 'closed');
  assert.equal(effects(f, 'close').length, 1);
  assert.equal((await launchOwned(f.runtime)).state, 'launch_unknown');
  assert.equal(effects(f, 'start').length, 1);
});

for (const change of ['label', 'instance', 'foreign', 'session', 'pid', 'stamp', 'boot', 'unknown'])
  test(`PR2 ownership refuses ${change} reuse`, async (t) => {
    const f = await launched(t);
    const s = f.state();
    const j = readJournal(f.c)!;
    if (change === 'label') s.tabs[0].label = 'foreign-label';
    if (change === 'instance') f.runtime.endpoint.server = { ...f.runtime.endpoint.server, boot_id: 'changed' };
    if (change === 'foreign') s.agents.push({ ...s.agents[0], name: 'decoy', pane_id: j.right, session_id: 'foreign' });
    if (change === 'session') s.agents[0].agent_session.value = '/synthetic/reused-session';
    if (change === 'pid') s.agents[0].pid = process.pid;
    if (change === 'stamp' || change === 'boot') {
      const file = dispatchPath(f.directory, 'primary/owner.json');
      const owner = jsonRead(file, f.directory);
      owner.process[change === 'stamp' ? 'proc_start' : 'boot_id'] = 'changed';
      jsonWrite(file, owner, f.directory);
    }
    f.saveState(s);
    if (change === 'unknown') put(f.env.HERDR_FAKE_STATE, '{broken');
    const result = await reapOwned({ ...f.runtime, budgetMs: 2500 });
    assert.equal(result.state, 'close_unresolved');
    assert.equal(effects(f, 'close').length, 0);
  });

test('PR2 resource fence wins concurrent helper start and explicit close', async (t) => {
  const f = await launched(t);
  const deadline = new Deadline(10_000);
  let unlock!: () => void;
  let held!: () => void;
  const acquired = new Promise<void>((r) => (held = r));
  const release = new Promise<void>((r) => (unlock = r));
  const lock = resourceLock(f.directory, 'resource', deadline, undefined, async () => {
    held();
    await release;
  });
  await acquired;
  const close = reapOwned(f.runtime);
  await delay(30);
  const helper = runHelper(helperRuntime(f), { kind: 'reviewer' });
  unlock();
  await lock;
  await assert.rejects(helper, /closing/);
  assert.equal((await close).state, 'closed');
  assert.equal(effects(f, 'start').length, 1);
});

test('PR2 transport cancellation and shared deadlines dispose children/pipes/timers', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pidFile = join(root, 'pid');
  const controller = new AbortController();
  const pending = runCommand(
    process.execPath,
    ['-e', `require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)`, pidFile],
    process.env,
    { signal: controller.signal, budgetMs: 10_000 }
  );
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await delay(10);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  controller.abort();
  assert.equal((await pending).reason, 'lost');
  await delay(50);
  assert.equal(readProcess(pid), null);
  const f = fixture(t);
  f.env.HERDR_FAKE_MODE = 'hang';
  const start = performance.now();
  assert.equal((await launchOwned({ ...f.runtime, budgetMs: 150 })).state, 'launch_unknown');
  assert.ok(performance.now() - start < 1000);
  await delay(50);
  const handles = (process as any)
    ._getActiveHandles()
    .filter((h: any) => h.constructor.name === 'ChildProcess' && h.pid === pid);
  assert.equal(handles.length, 0);
});

test('PR2 process signaling requires full stamp and exact argv; reused identity never signaled', async (t) => {
  const f = await launched(t);
  const j = readJournal(f.c)!;
  assert.equal(signalOwnedWorker(f.c, j), false); // synthetic fixture has no pi argv
  const o = readOwner(f.c, j)!;
  const path = dispatchPath(f.directory, 'primary/owner.json');
  jsonWrite(path, { ...o, process: { ...o.process, pid: process.pid } }, f.directory);
  assert.equal(signalOwnedWorker(f.c, j), false);
});

test('PR2 finite reaper refuses missing loader/release/root; never waits indefinitely for live primary', async (t) => {
  const f = await launched(t, 'sonic');
  const j = readJournal(f.c)!;
  const o = readOwner(f.c, j)!;
  const now = new Date().toISOString();
  const status = jsonRead(join(f.directory, 'STATUS.json'), f.directory);
  put(join(f.directory, 'STATUS.json'), {
    ...status,
    state: 'closed',
    output_written: true,
    settled_at: now,
    ended_at: now,
  });
  const options = { runtime: f.runtime, expectedRelease: f.c.release, expectedProcess: o.process };
  await assert.rejects(runReaper(options), /trusted_release_loader_unavailable/);
  await assert.rejects(runReaper({ ...options, loadRelease: async () => null }), /release_unavailable/);
  await assert.rejects(
    runReaper({ ...options, loadRelease: async () => ({ ...f.runtime.context.release, root: f.root }) }),
    /release_unavailable/
  );
  const start = performance.now();
  const result = await runReaper({ ...options, loadRelease: async () => f.runtime.context.release, exitWaitMs: 30 });
  assert.equal(result.state, 'close_unresolved');
  assert.ok(performance.now() - start < 1000);
  const cli = spawnSync(
    process.execPath,
    [new URL('../../src/roles/pi-owned/reap-main.js', import.meta.url).pathname],
    { env: f.env, encoding: 'utf8' }
  );
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /trusted_release_loader_unavailable/);
  assert.equal(effects(f, 'close').length, 0);
});

test('PR2 cold launch cost: n=20 fake subprocess runs, no warmup; journal/STATUS write counts', async (t) => {
  const times: number[] = [];
  const counts: number[] = [];
  const journals: number[] = [];
  const statuses: number[] = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const f = await launched(t);
    times.push(performance.now() - start);
    counts.push(f.calls().filter((c) => c.step).length);
    await delay(10);
    journals.push(f.writes.journal);
    statuses.push(f.writes.status);
    const owner = readOwner(f.c, readJournal(f.c)!)!;
    process.kill(owner.process.pid, 'SIGTERM');
    assert.equal(fs.statSync(join(f.directory, 'STATUS.json')).mode & 0o777, 0o600);
  }
  times.sort((a, b) => a - b);
  t.diagnostic(
    JSON.stringify({
      host: hostname(),
      role: 'implementer',
      n: 20,
      warmup: 0,
      p50_ms: times[9],
      p95_ms: times[18],
      max_ms: times[19],
      mutating_calls_per_launch: counts,
      STATUS_writes_per_launch: statuses,
      journal_writes_per_launch: journals,
      method:
        'create-to-ready; independent synthetic worker writes startup STATUS once; atomic replacements counted with fs.watch rename events',
    })
  );
});

test('PR2 closing fence before initial launch admits zero effects', async (t) => {
  const f = fixture(t);
  jsonWrite(dispatchPath(f.directory, 'control.json'), { schema: 1, closing: true, generation: 1 }, f.directory);
  assert.equal((await launchOwned(f.runtime)).state, 'launch_unknown');
  assert.equal(f.calls().filter((c) => c.step).length, 0);
});

test('PR2 stall evidence rejects unreadable session, changed editor, busy worker and generic failure', async (t) => {
  for (const mode of ['stall-unreadable', 'stall-editor-mismatch', 'stall-busy', 'prompt-before']) {
    const f = fixture(t);
    f.env.HERDR_FAKE_MODE = mode;
    const result = await launchOwned(f.runtime);
    assert.equal(result.state, 'launch_unknown', mode + ': ' + result.error);
    assert.equal(effects(f, 'enter').length, 0);
    f.env.HERDR_FAKE_MODE = 'ok';
    await launchOwned(f.runtime);
    assert.equal(effects(f, 'enter').length, 0);
  }
  const f = fixture(t);
  f.env.HERDR_FAKE_MODE = 'stall-message';
  assert.equal((await launchOwned(f.runtime)).state, 'acked');
  assert.equal(effects(f, 'enter').length, 0);
});

test('PR2 helper numbering counts failed/gapped reservations and enforces inherited limits', async (t) => {
  const f = await launched(t);
  put(join(f.directory, 'review_brief-3.md'), 'Failed reservation.');
  await assert.rejects(runHelper(helperRuntime(f), { kind: 'reviewer' }), /helper_limit/);
  put(join(f.directory, 'sonic-10.md'), 'Failed numbered artifact.');
  const request = join(f.c.cwd, 'small.md');
  put(request, 'Small chore.');
  await assert.rejects(runHelper(helperRuntime(f), { kind: 'sonic', brief_path: request }), /helper_limit/);
  assert.equal(effects(f, 'start').length, 1);
  const other = await launched(t, 'reviewer');
  await assert.rejects(runHelper(helperRuntime(other), { kind: 'reviewer' }), /helper_ineligible/);
});

test('PR2 blocked helper abort cleans only owned helper, consumes reservation, and releases helper mutex', async (t) => {
  const f = await launched(t);
  f.env.HERDR_FAKE_HELPER = 'blocked';
  const controller = new AbortController();
  const first = runHelper(helperRuntime(f, { signal: controller.signal }), { kind: 'reviewer' });
  for (let i = 0; i < 300 && effects(f, 'start').length < 2; i++) await delay(10);
  await delay(150);
  controller.abort();
  await assert.rejects(first, /aborted|AbortError/);
  assert.equal(f.state().agents.length, 1);
  assert.equal(jsonRead(dispatchPath(f.directory, 'current.json'), f.directory).state, 'closed');
  delete f.env.HERDR_FAKE_HELPER;
  assert.equal((await runHelper(helperRuntime(f), { kind: 'reviewer' })).slot, 'review-2');
});

test('PR2 parent-tab locator is protected even when create returns a matching label', async (t) => {
  const f = fixture(t);
  f.runtime.callerTab = 'tab1';
  assert.equal((await launchOwned(f.runtime)).state, 'launch_unknown');
  assert.equal(effects(f, 'start').length, 0);
  assert.equal((await reapOwned(f.runtime)).state, 'close_unresolved');
  assert.equal(effects(f, 'close').length, 0);
});

test('PR2 OS mutex survives old mtime and serializes processes; process death releases kernel lock', async (t) => {
  const f = fixture(t);
  const path = dispatchPath(f.directory, 'resource.lock');
  const ready = join(f.root, 'lock-ready');
  const module = new URL('../../src/roles/pi-owned/launch.js', import.meta.url).href;
  const script = `import {resourceLock,Deadline} from ${JSON.stringify(module)};import fs from 'node:fs';await resourceLock(process.argv[1],'resource',new Deadline(5000),undefined,async()=>{fs.writeFileSync(process.argv[2],'ready');await new Promise(()=>{setInterval(()=>{},1000);});});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.directory, ready], {
    stdio: 'ignore',
    env: f.env,
  });
  t.after(() => {
    try {
      child.kill('SIGTERM');
    } catch {}
  });
  for (let i = 0; i < 200 && !fs.existsSync(ready); i++) await delay(10);
  assert.equal(fs.existsSync(ready), true);
  fs.utimesSync(path, new Date(0), new Date(0));
  await assert.rejects(
    resourceLock(f.directory, 'resource', new Deadline(80), undefined, async () => {}),
    /deadline/
  );
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  await resourceLock(f.directory, 'resource', new Deadline(1000), undefined, async () => {});
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
});

test('PR2 finite reaper valid pin closes after exact primary exit; explicit/auto race is idempotent', async (t) => {
  const f = await launched(t, 'sonic');
  const j = readJournal(f.c)!;
  const owner = readOwner(f.c, j)!;
  const path = join(f.directory, 'STATUS.json');
  const now = new Date().toISOString();
  const status = jsonRead(path, f.directory);
  put(f.c.output_path, 'Synthetic successful artifact.');
  put(path, { ...status, state: 'closed', output_written: true, settled_at: now, ended_at: now });
  const pending = runReaper({
    runtime: f.runtime,
    expectedRelease: f.c.release,
    expectedProcess: owner.process,
    loadRelease: async () => f.runtime.context.release,
    exitWaitMs: 2000,
  });
  await delay(30);
  const s = f.state();
  s.agents = [];
  f.saveState(s);
  process.kill(owner.process.pid, 'SIGTERM');
  const explicit = reapOwned(f.runtime);
  const results = await Promise.all([pending, explicit]);
  for (const result of results) assert.equal(result.state, 'closed', JSON.stringify(result));
  assert.equal((await reapOwned(f.runtime)).state, 'closed');
  assert.equal(effects(f, 'close').length, 1);
});

test('PR2 signal positive case uses full stamp and exact contract/session argv', async (t) => {
  const f = await launched(t);
  const j = readJournal(f.c)!;
  const original = readOwner(f.c, j)!;
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)', '--', '--hud-role-contract', f.paths.contract, '--session-id', f.c.session_id],
    { stdio: 'ignore' }
  );
  assert.ok(child.pid);
  t.after(() => {
    try {
      child.kill('SIGTERM');
    } catch {}
  });
  for (let i = 0; i < 30 && !readProcess(child.pid!); i++) await delay(10);
  const stamp = readProcess(child.pid!)!.stamp;
  jsonWrite(dispatchPath(f.directory, 'primary/owner.json'), { ...original, process: stamp }, f.directory);
  assert.equal(signalOwnedWorker(f.c, j), true);
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  jsonWrite(dispatchPath(f.directory, 'primary/owner.json'), original, f.directory);
});

test('PR2 absent tab plus previous close intent cannot hide a live worker', async (t) => {
  const f = fixture(t);
  f.env.HERDR_FAKE_KEEP_PRIMARY = '1';
  assert.equal((await launchOwned(f.runtime)).state, 'acked');
  const state = f.state();
  state.tabs = [];
  state.panes = [];
  state.agents = [];
  f.saveState(state);
  jsonWrite(
    dispatchPath(f.directory, 'cleanup.json'),
    { schema: 1, state: 'closing', remaining: [], steps: { close: { state: 'sent' } } },
    f.directory
  );
  assert.equal((await reapOwned(f.runtime)).state, 'close_unresolved');
});

test('PR2 incomplete pane inventory stays unknown rather than splitting or closing', async (t) => {
  const f = await launched(t);
  const state = f.state();
  delete state.panes[1].tab_id;
  f.saveState(state);
  await assert.rejects(runHelper(helperRuntime(f), { kind: 'reviewer' }), /inventory unreadable/);
  assert.equal(effects(f, 'split').length, 1);
  assert.equal((await reapOwned(f.runtime)).state, 'close_unresolved');
  assert.equal(effects(f, 'close').length, 0);
});

test('PR2 explicit close overlap shares one operation and preserves closed outcome', async (t) => {
  const f = await launched(t);
  const results = await Promise.all([reapOwned(f.runtime), reapOwned(f.runtime)]);
  for (const result of results) assert.equal(result.state, 'closed', JSON.stringify(result));
  assert.equal(effects(f, 'close').length, 1);
  assert.equal(jsonRead(dispatchPath(f.directory, 'cleanup.json'), f.directory).state, 'closed');
});

test('PR2 cleanup revalidates queued helper identity under the mutation lock', async (t) => {
  const f = await launched(t);
  f.env.HERDR_FAKE_HELPER = 'blocked';
  const controller = new AbortController();
  const pending = runHelper(helperRuntime(f, { signal: controller.signal, cleanupBudgetMs: 500 }), {
    kind: 'reviewer',
  });
  pending.catch(() => {});
  const path = slotPaths(f.directory, 'review-1').contract;
  for (
    let i = 0;
    i < 400 && (!fs.existsSync(path) || !fs.existsSync(dispatchPath(f.directory, 'review-1/owner.json')));
    i++
  )
    await delay(10);
  await delay(200);
  const c = jsonRead(path, f.directory) as SlotContract;
  let unlock!: () => void;
  let held!: () => void;
  const acquired = new Promise<void>((r) => (held = r));
  const release = new Promise<void>((r) => (unlock = r));
  const lock = resourceLock(f.directory, 'resource', new Deadline(5000), undefined, async () => {
    held();
    await release;
  });
  await acquired;
  const before = f.calls().filter((c) => c.argv[0] === 'agent' && c.argv[1] === 'list').length;
  const retire = retireHelper(f.runtime, c, 2000);
  for (
    let i = 0;
    i < 200 && f.calls().filter((c) => c.argv[0] === 'agent' && c.argv[1] === 'list').length === before;
    i++
  )
    await delay(10);
  await delay(40);
  const state = f.state();
  const agent = state.agents.find((a: any) => a.name === readJournal(c)!.agent);
  agent.agent_session.value = '/synthetic/foreign-session';
  f.saveState(state);
  unlock();
  await lock;
  assert.equal(await retire, false);
  assert.equal(effects(f, 'quit').length, 0);
  controller.abort();
  await assert.rejects(pending);
});

test('PR2 owner loss after cleanup admission cannot erase the captured live process', async (t) => {
  const f = fixture(t);
  f.env.HERDR_FAKE_KEEP_PRIMARY = '1';
  assert.equal((await launchOwned(f.runtime)).state, 'acked');
  const owner = readOwner(f.c, readJournal(f.c)!)!;
  jsonWrite(
    dispatchPath(f.directory, 'cleanup.json'),
    { schema: 1, state: 'closing', remaining: [], steps: { close: { state: 'sent' } } },
    f.directory
  );
  const state = f.state();
  state.tabs = [];
  state.panes = [];
  state.agents = [];
  f.saveState(state);
  const barrier = join(f.root, 'inventory-barrier');
  f.env.HERDR_FAKE_BARRIER = barrier;
  put(barrier + '.arm', 'armed');
  const close = reapOwned(f.runtime);
  for (let i = 0; i < 400 && !fs.existsSync(barrier + '.reached'); i++) await delay(5);
  assert.equal(fs.existsSync(barrier + '.reached'), true);
  fs.unlinkSync(dispatchPath(f.directory, 'primary/owner.json'));
  put(barrier + '.release', 'release');
  const result = await close;
  assert.equal(result.state, 'close_unresolved', JSON.stringify(result));
  assert.match(result.remaining.join(' '), /worker exit unconfirmed/);
  assert.equal(processState(owner.process), 'alive');
  assert.equal(effects(f, 'close').length, 0);
});

test('PR2 primary shutdown can await helper cleanup while full reap waits for primary exit', async (t) => {
  const f = fixture(t);
  const marker = join(f.root, 'helper-shutdown-complete');
  f.env.HERDR_FAKE_SHUTDOWN_WAIT = marker;
  assert.equal((await launchOwned(f.runtime)).state, 'acked');
  f.env.HERDR_FAKE_HELPER = 'blocked';
  const regular = helperRuntime(f);
  const helper = runHelper(
    {
      ...regular,
      helperBudgetMs: 20_000,
      cleanupBudgetMs: 15_000,
      onPending: async (pending) => {
        await regular.onPending(pending);
        if (pending === null) put(marker, 'cleaned');
      },
    },
    { kind: 'reviewer' }
  );
  helper.catch(() => {});
  for (let i = 0; i < 400 && effects(f, 'start').length < 2; i++) await delay(10);
  await delay(150);
  const close = reapOwned({ ...f.runtime, budgetMs: 5000 });
  await assert.rejects(helper, /closing|launch_unknown/);
  const result = await close;
  assert.equal(result.state, 'closed', JSON.stringify(result));
  assert.equal(fs.existsSync(marker), true);
  assert.equal(jsonRead(dispatchPath(f.directory, 'cleanup.json'), f.directory).state, 'closed');
  assert.equal(effects(f, 'close').length, 1);
});
