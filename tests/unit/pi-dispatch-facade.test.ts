import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { before } from 'node:test';
import { hudCreate, hudRead, hudSend, hudRespond, hudClose } from '../../src/roles/facade.js';
import { waitForJob } from '../../src/roles/job-wait.js';
import { observeDispatch } from '../../src/roles/pi-dispatch-status.js';
import { readDispatchSession, launchDispatch, reapDispatch } from '../../src/roles/pi-dispatch.js';
import { facadeRelease, captureFacadeRuntime } from '../../src/roles/pi-owned/facade-context.js';
import { readProcess } from '../../src/core/run/process.js';
import { CliHerdrTransport } from '../../src/integrations/herdr/transport.js';
import { JobObservationCollector } from '../../src/collectors/job-observations.js';
import { parseRosterRoot } from '../../src/roles/selection.js';
import { runHerdr } from '../../src/roles/herdr-run.js';
import type { CallerProbe } from '../../src/roles/caller.js';
import type { PanelHerdr } from '../../src/integrations/panel/herdr.js';
import { REPO_ROOT } from '../fixtures/paths.js';

test('PR4 cutover: hostile PATH tools are never invoked; installed release pin; removing tools changes nothing', async (t) => {
  const f = await fixture(t);
  const start = performance.now();
  const a = await f.create();
  assert.equal(a.ok, true, JSON.stringify(a));
  t.diagnostic(
    `host=${hostname()} cold facade create-to-ready=${(performance.now() - start).toFixed(1)}ms; startup STATUS writes=1 (extension publisher)`
  );
  const r = f.receipt(a.job);
  assert.equal(json(join(f.directory(a.job), '.dispatch/primary/status-writes.json')).statusWrites, 1);
  await hudRead(f.ctx, { job: a.job });
  await hudRead(f.ctx, { job: a.job });
  assert.equal(
    json(join(f.directory(a.job), '.dispatch/primary/status-writes.json')).statusWrites,
    1,
    'ordinary reads add zero STATUS writes'
  );
  assert.equal(r.pi_dispatch.contract_version, 2);
  assert.equal(r.pi_dispatch.transport, 'hud-owned');
  assert.deepEqual(r.pi_dispatch.release, { id: artifact.release.id, root: releaseRoot });
  assert.equal(readDispatchSession(f.directory(a.job))?.ORCH, '');
  assert.equal(fs.existsSync(f.hostile), false);
  for (const name of ['pi-dispatch', 'pi-role', 'pi-role-reap']) fs.unlinkSync(join(f.bin, name));
  const b = await f.create('without-path');
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(f.state().counts.tab, 2);
  assert.equal(f.state().counts.start, 2);
  for (const l of f.logs().filter((l) => l.step)) {
    assert.equal(l.intent, true);
    assert.equal(l.transaction, true);
  }
});

for (const [role, phase, mapped] of [
  ['imp', null, 'implementer'],
  ['sonic', null, 'sonic'],
  ['reviewer', null, 'reviewer'],
  ['oracle', 'propose', 'architect'],
  ['oracle', 'converge', 'architect'],
]) {
  test(`PR4 role ${role}.${phase}: frozen contract and owned argv`, async (t) => {
    const f = await fixture(t);
    const a = await f.create('mapping', { role, ...(phase ? { phase } : {}) });
    assert.equal(a.ok, true, JSON.stringify(a));
    const c = json(f.receipt(a.job).pi_dispatch.contract_path);
    assert.equal(c.role, mapped);
    assert.equal(c.cwd, f.work);
    assert.equal(c.output_path, join(f.directory(a.job), 'report.md'));
    assert.deepEqual(c.allowed_write_paths, [c.output_path]);
    assert.equal(c.model, 'synthetic/model');
    assert.equal(c.effort, 'high');
    assert.equal(f.state().counts.split ?? 0, role === 'imp' ? 1 : 0);
    const args = f.logs().find((l) => l.step === 'start').argv;
    assert.equal(args.includes('--no-approve'), true);
    assert.equal(args.includes('--no-mcp'), true);
    const assoc = json(join(f.home, 'assoc', `${a.job}.json`));
    assert.equal(assoc.native, undefined);
    assert.equal(fs.existsSync(join(f.directory(a.job), 'materials')), false);
  });
}

for (const fault of ['tab:after', 'split:after', 'start:after', 'prompt:after']) {
  test(`PR4 ambiguous ${fault} never replays through facade restart`, async (t) => {
    const f = await fixture(t);
    const s = f.state();
    s.mode.fault = fault;
    put(join(f.root, 'herdr-state.json'), s);
    const a = await f.create();
    assert.equal(a.code, 'launch_unknown', JSON.stringify(a));
    const before = f.state().counts;
    assert.equal((await f.create()).code, 'launch_unknown');
    assert.deepEqual(f.state().counts, before, 'no repeated side effects after sent intent');
    const r = f.receipt(a.job);
    r.pi_dispatch.contract_version = 99;
    put(join(f.directory(a.job), 'receipt.json'), r);
    assert.equal((await f.create()).code, 'receipt_unreadable');
    assert.equal((await hudSend(f.ctx, { job: a.job, message_key: 'x', text: 'x' })).code, 'not_found');
    assert.deepEqual(f.state().counts, before);
  });
}

test('PR4 same-key, conflicts, isolation, routing changes and restart preserve ownership', async (t) => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.create(), f.create()]);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.job, a.job);
  assert.equal(f.state().counts.start, 1);
  assert.equal((await f.create('task', { task: 'Changed request' })).code, 'conflict');
  const other = { ...f.ctx, root: parseRosterRoot('synthetic/other') };
  assert.equal((await hudRead(other, { job: a.job })).code, 'not_found');
  assert.equal((await hudSend(other, { job: a.job, message_key: 'x', text: 'x' })).code, 'not_found');
  assert.equal((await hudClose(other, { job: a.job })).code, 'not_found');
  put(
    join(f.home, 'routing.toml'),
    ROUTING.replace('synthetic/model', 'synthetic/changed') +
      '\n[pi_helpers.sonic]\nmodel="synthetic/new-helper"\neffort="low"\n'
  );
  const next = await f.create('next');
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(json(f.receipt(next.job).pi_dispatch.contract_path).helpers.sonic.model, 'synthetic/new-helper');
  assert.notEqual(json(f.receipt(a.job).pi_dispatch.contract_path).helpers.sonic.model, 'synthetic/new-helper');
  fs.unlinkSync(join(f.home, 'routing.toml'));
  const retry = await hudCreate(
    { ...f.ctx },
    { role: 'imp', cwd: f.work, task: 'Synthetic task. Preserve scope.', request_key: 'task' }
  );
  assert.equal(retry.job, a.job);
  assert.equal(retry.ok, true);
  assert.equal(f.state().counts.start, 2);
});

test('PR4 real extension artifacts: QA consumed:false, independent waiters, helper remains within one job, collector read-only', async (t) => {
  const f = await fixture(t);
  const a = await f.create();
  assert.equal(a.ok, true, JSON.stringify(a));
  await f.probe(
    a.job,
    {
      tool: 'ask_orchestrator',
      params: { question: 'Synthetic decision?', options: ['A', 'B'], default: 'A', context: 'Synthetic only' },
    },
    false
  );
  await until(() => fs.existsSync(join(f.directory(a.job), 'qa/q1.md')));
  assert.equal((await hudRead(f.ctx, { job: a.job })).event, 'QUESTION');
  const answer = { job: a.job, request_id: 'q1', answer: 'B' };
  assert.equal((await hudRespond(f.ctx, answer)).consumed, false);
  assert.equal((await hudRespond(f.ctx, answer)).idempotent, true);
  assert.equal((await hudRespond(f.ctx, { ...answer, answer: 'A' })).code, 'conflict');
  await until(() => fs.existsSync(join(f.directory(a.job), '.dispatch/primary/probe-result.json')));
  const request = join(f.work, 'sonic-request.md');
  put(request, 'Fully specified synthetic helper work. Write only the fixed artifact.');
  await f.probe(a.job, { tool: 'call_sonic', params: { brief_path: request } }, false);
  await until(() => f.state().agents.some((agent: any) => agent.slot === 'sonic-1'));
  const helper = f.state().agents.find((agent: any) => agent.slot === 'sonic-1');
  const helperProbe = async (value: object) => {
    const result = join(f.directory(a.job), '.dispatch/sonic-1/probe-result.json');
    if (fs.existsSync(result)) fs.unlinkSync(result);
    assert.equal((await runHerdr(['test', 'probe', helper.name, JSON.stringify(value)], f.env)).ok, true);
    await until(() => fs.existsSync(result));
  };
  await helperProbe({ event: 'before_agent_start' });
  await helperProbe({ builtinWrite: true });
  await helperProbe({ event: 'agent_settled' });
  await until(() => fs.existsSync(join(f.directory(a.job), '.dispatch/primary/probe-result.json')));
  assert.equal(observeDispatch(f.directory(a.job), f.receipt(a.job).pi_dispatch).helpers[0]?.slot, 'sonic-1');
  const [one, two] = [waitForJob(f.home, f.env, String(a.job), 15000), waitForJob(f.home, f.env, String(a.job), 15000)];
  await f.settle(a.job);
  assert.equal((await one).event, 'DONE');
  assert.equal((await two).event, 'DONE');
  const status = json(join(f.directory(a.job), 'STATUS.json'));
  assert.equal(status.output_written, true);
  const view = observeDispatch(f.directory(a.job), f.receipt(a.job).pi_dispatch);
  assert.equal(view.event, 'DONE');
  assert.deepEqual(view.pending, []);
  const collector = new JobObservationCollector(f.home, { root: 'synthetic/main', live: false });
  t.after(() => collector.dispose());
  let snapshot: any;
  for (let i = 0; i < 30; i++) {
    snapshot = await collector.refresh({ maxFiles: 200, maxEntries: 1000, maxBytes: 4 * 1024 * 1024 });
    if (snapshot.jobs?.length) break;
  }
  assert.equal(snapshot.jobs.length, 1, JSON.stringify(snapshot));
  assert.equal(snapshot.jobs[0].native, null);
  assert.equal(snapshot.jobs[0].helpers.length, 1);
  assert.equal(fs.existsSync(f.hostile), false);
});

test('PR4 nested sonic QA follows only bounded active parent-linked extension artifacts', async (t) => {
  const f = await fixture(t);
  const a = await f.create();
  assert.equal(a.ok, true, JSON.stringify(a));
  const directory = f.directory(a.job);
  await f.probe(a.job, { tool: 'call_reviewer' }, false);
  await until(() => f.state().agents.some((agent: any) => agent.slot === 'review-1'));
  await until(() => json(join(directory, '.dispatch/review-1/launch.json')).steps.prompt?.state === 'acked');
  const request = join(f.work, 'nested-request.md');
  put(request, 'Synthetic read-only task; use only your report grant.');
  await f.probeSlot(a.job, 'review-1', { tool: 'call_sonic', params: { brief_path: request } }, false);
  await until(() => f.state().agents.some((agent: any) => agent.slot === 'sonic-1'));
  await f.probeSlot(
    a.job,
    'sonic-1',
    { tool: 'ask_orchestrator', params: { question: 'Nested decision?', default: 'A' } },
    false
  );
  await until(() => fs.existsSync(join(directory, 'qa/q1.md')));
  const nestedFile = join(directory, '.dispatch/sonic-1/STATUS.json');
  const nestedQuestion = json(nestedFile);
  const observed = observeDispatch(directory, f.receipt(a.job).pi_dispatch);
  assert.equal(observed.event, 'QUESTION');
  assert.equal(observed.asking_slot, 'sonic-1');
  assert.equal((await waitForJob(f.home, f.env, String(a.job), 1000)).asking_slot, 'sonic-1');
  const collector = new JobObservationCollector(f.home, {
    root: 'synthetic/main',
    herdr: async () => JSON.stringify({ result: { agents: f.state().agents } }),
  });
  t.after(() => collector.dispose());
  let snapshot: any;
  for (let i = 0; i < 30; i++) {
    snapshot = await collector.refresh({ maxFiles: 200, maxEntries: 1000, maxBytes: 4 * 1024 * 1024 });
    await collector.live.settled();
    if (snapshot.jobs[0]?.requests?.some((q: any) => q.current)) break;
  }
  assert.equal(snapshot.jobs.length, 1);
  assert.equal(snapshot.jobs[0].requests[0].current, true);
  assert.equal(snapshot.jobs[0].helpers.find((h: any) => h.role === 'sonic').lifecycle, 'waiting_orchestrator');
  // Corrupt copies of real producer bytes: never chase a third edge, a cycle, a foreign path or a wrong parent.
  for (const patch of [
    {
      helper_pending: { kind: 'review', n: 1, status_file: join(directory, '.dispatch/review-1/STATUS.json') },
      state: 'waiting_helper',
    },
    { parent: 'primary' },
  ]) {
    put(nestedFile, { ...nestedQuestion, ...patch });
    const bad = observeDispatch(directory, f.receipt(a.job).pi_dispatch);
    assert.equal(bad.event, undefined);
    assert.ok(bad.diagnostics.some((d) => d.reason === 'active_helper_unknown'));
  }
  put(nestedFile, nestedQuestion);
  const primaryFile = join(directory, 'STATUS.json');
  const primary = json(primaryFile);
  put(primaryFile, { ...primary, helper_pending: { ...primary.helper_pending, status_file: '/outside/STATUS.json' } });
  assert.equal(observeDispatch(directory, f.receipt(a.job).pi_dispatch).event, undefined);
  put(primaryFile, primary);
  assert.equal((await hudRespond(f.ctx, { job: a.job, request_id: 'q1', answer: 'A' })).consumed, false);
  await until(() => fs.existsSync(join(directory, '.dispatch/sonic-1/probe-result.json')));
  assert.equal(json(nestedFile).state, 'working');
  for (let i = 0; i < 30; i++) {
    snapshot = await collector.refresh({ maxFiles: 200, maxEntries: 1000, maxBytes: 4 * 1024 * 1024 });
    if (snapshot.jobs[0]?.requests?.[0]?.current === false) break;
  }
  assert.equal(snapshot.jobs[0].requests[0].current, false);
  await f.probeSlot(a.job, 'sonic-1', { event: 'before_agent_start' });
  await f.probeSlot(a.job, 'sonic-1', { builtinWrite: true });
  await f.probeSlot(a.job, 'sonic-1', { event: 'agent_settled' });
  await until(() => fs.existsSync(join(directory, '.dispatch/review-1/probe-result.json')));
  await f.probeSlot(a.job, 'review-1', { event: 'before_agent_start' });
  put(join(directory, 'review-1.md'), 'Verdict: accept\nSynthetic independent review.\n');
  await f.probeSlot(a.job, 'review-1', { event: 'agent_settled' });
  await until(() => fs.existsSync(join(directory, '.dispatch/primary/probe-result.json')));
  assert.equal(json(primaryFile).state, 'working');
  put(nestedFile, nestedQuestion); // A historical waiting snapshot is not an active request.
  assert.equal(observeDispatch(directory, f.receipt(a.job).pi_dispatch).event, undefined);
});

test('PR4 continuation suppresses old DONE; no replacement; explicit close is idempotent', async (t) => {
  const f = await fixture(t);
  const a = await f.create();
  assert.equal(a.ok, true, JSON.stringify(a));
  await f.settle(a.job);
  const args = { job: a.job, message_key: 'repair', text: 'Repair the synthetic issue.' };
  assert.equal((await hudSend(f.ctx, args)).ok, true);
  assert.equal((await hudSend(f.ctx, args)).idempotent, true);
  assert.equal((await hudSend(f.ctx, { ...args, text: 'Different' })).code, 'conflict');
  assert.equal((await hudRead(f.ctx, { job: a.job })).continuation, 'unconfirmed');
  assert.equal((await waitForJob(f.home, f.env, String(a.job), 20)).event, 'TIMEOUT');
  await f.probe(a.job, { event: 'before_agent_start' });
  put(join(f.directory(a.job), 'report.md'), 'Changed report after repair.\n');
  await f.probe(a.job, { event: 'agent_settled' });
  assert.equal((await waitForJob(f.home, f.env, String(a.job), 20)).event, 'DONE');
  assert.equal((await hudClose(f.ctx, { job: a.job })).ok, true);
  assert.equal((await hudClose(f.ctx, { job: a.job })).idempotent, true);
  assert.equal(f.state().counts.start, 1);
  assert.equal(f.state().tabs.length, 0);
  assert.equal(fs.existsSync(f.hostile), false);
});

test('PR4 QA response rechecks the owner under the mutation lock', async (t) => {
  const f = await fixture(t);
  const a = await f.create();
  assert.equal(a.ok, true, JSON.stringify(a));
  await f.probe(a.job, { tool: 'ask_orchestrator', params: { question: 'Synthetic decision?', default: 'A' } }, false);
  await until(() => fs.existsSync(join(f.directory(a.job), 'qa/q1.md')));
  const response = hudRespond(f.ctx, { job: a.job, request_id: 'q1', answer: 'A' });
  // Synchronously replace the receipt after admission, before the lock body resumes.
  const r = f.receipt(a.job);
  r.pi_dispatch = {
    contract_version: 1,
    role: 'implementer',
    executable: '/legacy/pi-dispatch',
    reaper: '/legacy/pi-role-reap',
    launch: 'acked',
  };
  put(join(f.directory(a.job), 'receipt.json'), r);
  assert.equal((await response).code, 'legacy_owner_required');
  assert.equal(fs.existsSync(join(f.directory(a.job), 'qa/q1.answer.md')), false);
});

test('PR4 wrapped brief boundary is checked before any job, key or association publication', async (t) => {
  const f = await fixture(t);
  const small = await f.create('brief-size-probe', { task: 'x' });
  assert.equal(small.ok, true, JSON.stringify(small));
  const overhead = fs.statSync(join(f.directory(small.job), 'brief.md')).size - 1;
  const task = 'x'.repeat(64 * 1024 - overhead);
  const largest = await f.create('largest-brief', { task });
  assert.equal(largest.ok, true, JSON.stringify(largest));
  assert.equal(fs.statSync(join(f.directory(largest.job), 'brief.md')).size, 64 * 1024);
  const index = join(f.home, 'jobs/index', fs.readdirSync(join(f.home, 'jobs/index'))[0]!);
  const before = {
    jobs: fs.readdirSync(join(f.home, 'jobs')).sort(),
    keys: fs.readdirSync(index).sort(),
    associations: fs.readdirSync(join(f.home, 'assoc')).sort(),
    counts: f.state().counts,
  };
  for (const oversized of [task + 'x', 'x'.repeat(64 * 1024)]) {
    const refused = await f.create('oversized-brief', { task: oversized });
    assert.equal(refused.code, 'invalid_arguments');
    assert.equal(refused.field, 'task');
    assert.equal(refused.reason, 'too_large');
    assert.deepEqual(
      {
        jobs: fs.readdirSync(join(f.home, 'jobs')).sort(),
        keys: fs.readdirSync(index).sort(),
        associations: fs.readdirSync(join(f.home, 'assoc')).sort(),
        counts: f.state().counts,
      },
      before
    );
  }
});

test('PR4 retained prior inventory permits acquisition, upgrade and existing owned-job mutation', async (t) => {
  const f = await fixture(t);
  const a = await f.create();
  assert.equal(a.ok, true, JSON.stringify(a));
  const { priorInventoryFixture } = await import(
    pathToFileURL(join(REPO_ROOT, 'scripts/runtime-package/test-fixture.mjs')).href
  );
  const prior = priorInventoryFixture(t);
  const publisher = await import(pathToFileURL(join(prior.bundle, 'runtime-package/installer.mjs')).href);
  const oldPlan = publisher.planInstall(prior.bundle, artifact.prefix);
  const old = publisher.executeInstall(prior.bundle, artifact.prefix, oldPlan.planDigest);
  assert.equal((await facadeRelease(releaseRoot)).id, artifact.release.id);
  const installer = await import(pathToFileURL(join(REPO_ROOT, 'scripts/runtime-package/installer.mjs')).href);
  const upgrade = installer.planInstall(artifact.bundle, artifact.prefix);
  assert.equal(installer.executeInstall(artifact.bundle, artifact.prefix, upgrade.planDigest).status, 'SELECTED');
  assert.equal((await facadeRelease(releaseRoot)).id, artifact.release.id);
  await assert.rejects(
    facadeRelease(join(artifact.prefix, 'releases', old.manifestDigest)),
    /pi_owned_release_unverified/
  );
  assert.equal(
    (await hudSend(f.ctx, { job: a.job, message_key: 'after-upgrade', text: 'Synthetic follow-up.' })).ok,
    true
  );
  assert.equal((await hudClose(f.ctx, { job: a.job })).ok, true);
  assert.equal(f.state().counts.start, 1, 'retention/upgrade never replaces the job');
});

test('PR4 missing pinned release never falls back to the current checkout or activated release', async (t) => {
  const f = await fixture(t);
  const a = await f.create();
  assert.equal(a.ok, true, JSON.stringify(a));
  const r = f.receipt(a.job);
  r.pi_dispatch.release = { id: 'f'.repeat(64), root: join(artifact.prefix, 'releases', 'f'.repeat(64)) };
  put(join(f.directory(a.job), 'receipt.json'), r);
  assert.equal((await f.create()).code, 'pi_owned_owner_unavailable');
  assert.equal((await hudSend(f.ctx, { job: a.job, message_key: 'x', text: 'x' })).code, 'pi_owned_owner_unavailable');
  assert.equal((await hudClose(f.ctx, { job: a.job })).code, 'pi_owned_owner_unavailable');
  assert.equal(f.state().counts.start, 1);
});

test('PR4 legacy receipts drain read-only; every mutation and relaunch is refused before writes', async (t) => {
  const f = await fixture(t);
  const a = await f.create();
  assert.equal(a.ok, true, JSON.stringify(a));
  await f.settle(a.job);
  const r = f.receipt(a.job);
  r.pi_dispatch = {
    contract_version: 1,
    role: 'implementer',
    executable: join(f.bin, 'pi-dispatch'),
    reaper: join(f.bin, 'pi-role-reap'),
    launch: 'acked',
  };
  put(join(f.directory(a.job), 'receipt.json'), r);
  const before = fs.readFileSync(join(f.directory(a.job), 'receipt.json'), 'utf8');
  assert.equal((await hudRead(f.ctx, { job: a.job })).event, 'DONE');
  assert.equal((await waitForJob(f.home, f.env, String(a.job), 20)).event, 'DONE');
  for (const op of [
    () => f.create(),
    () => hudSend(f.ctx, { job: a.job, message_key: 'x', text: 'x' }),
    () => hudRespond(f.ctx, { job: a.job, request_id: 'q1', answer: 'x' }),
    () => hudClose(f.ctx, { job: a.job }),
  ])
    assert.equal((await op()).code, 'legacy_owner_required');
  assert.equal(
    fs.readFileSync(join(f.directory(a.job), 'receipt.json'), 'utf8'),
    before,
    'legacy receipt must remain byte-identical'
  );
  assert.equal(fs.existsSync(join(f.directory(a.job), 'qa/q1.answer.md')), false);
  assert.equal(fs.existsSync(f.hostile), false);
  assert.throws(
    () => launchDispatch(r.pi_dispatch, f.directory(a.job), f.work, null, null, f.env),
    /legacy_owner_required/
  );
  assert.throws(() => reapDispatch(r.pi_dispatch, f.directory(a.job), f.env), /legacy_owner_required/);
  delete r.pi_dispatch;
  r.state = 'launch_unknown';
  put(join(f.directory(a.job), 'receipt.json'), r);
  assert.equal((await f.create()).code, 'legacy_owner_required');
  assert.equal((await hudClose(f.ctx, { job: a.job })).code, 'legacy_owner_required');
});

test('PR4 production acquisition: checkout and missing installed owner refuse', async () => {
  await assert.rejects(facadeRelease(REPO_ROOT), /pi_owned_release_unverified/);
  await assert.rejects(
    facadeRelease(releaseRoot, { id: 'f'.repeat(64), root: join(artifact.prefix, 'releases', 'f'.repeat(64)) }),
    /pi_owned_owner_unavailable/
  );
  assert.equal((await facadeRelease(releaseRoot)).id, artifact.release.id);
});

test('PR4 production acquisition: env-only endpoint, wrong instance and foreign pane refuse; corroborated ancestry succeeds', async (t) => {
  const f = await fixture(t);
  const main = readProcess(process.pid)!;
  const server = readProcess(f.runtime.endpoint.server.pid)!;
  let parent = server.stamp.pid;
  const probe = {
    ppid: main.stamp.pid,
    env: {},
    read: (pid: number) =>
      pid === main.stamp.pid ? { pid, ppid: parent, procStart: main.stamp.proc_start, argv: ['pi'], env: {} } : null,
  } as unknown as CallerProbe;
  const info = ((pid: number) =>
    pid === main.stamp.pid
      ? { ...main, ppid: parent }
      : pid === server.stamp.pid
        ? server
        : null) as typeof readProcess;
  const launch = (pid: number) => ({ argv: [pid === server.stamp.pid ? 'herdr' : 'pi'], env: {} });
  const raw = new CliHerdrTransport(f.runtime.endpoint.socketPath, f.env, 'herdr', 1500, server.stamp);
  let foreign = false;
  let instance = true;
  const herdr = {
    instance: () => (instance ? raw.instance() : Promise.resolve(null)),
    observe: async () => ({
      pane: 'caller-pane',
      tab: 'caller-tab',
      terminal: 'caller-terminal',
      workspace: 'w0',
      process: foreign ? server.stamp : main.stamp,
      shell: main.stamp,
      atPrompt: false,
    }),
  } as unknown as PanelHerdr;
  const env = { ...f.env, HERDR_PANE_ID: 'caller-pane' };
  const deps = { probe, processInfo: info, launch, herdr };
  assert.deepEqual(await captureFacadeRuntime(env, deps), f.runtime);
  const other = await fixture(t);
  await assert.rejects(
    captureFacadeRuntime(
      { ...env, HERDR_SOCKET_PATH: other.runtime.endpoint.socketPath },
      { ...deps, herdr: undefined }
    ),
    /herdr_unavailable/
  );
  foreign = true;
  await assert.rejects(captureFacadeRuntime(env, deps), /caller_pane_unverified/);
  foreign = false;
  instance = false;
  await assert.rejects(captureFacadeRuntime(env, deps), /herdr_unavailable/);
  instance = true;
  parent = 1;
  await assert.rejects(captureFacadeRuntime(env, deps), /herdr_unavailable/);
  parent = server.stamp.pid;
  await assert.rejects(captureFacadeRuntime({ ...env, HERDR_SOCKET_PATH: 'relative' }, deps), /herdr_unavailable/);
  await assert.rejects(captureFacadeRuntime({ ...env, HERDR_PANE_ID: undefined }, deps), /caller_pane_unverified/);
  await assert.rejects(
    captureFacadeRuntime(env, { ...deps, probe: { ...probe, read: () => null } }),
    /caller_pane_unverified/
  );
});
import { ROUTING, put, json, until, artifact, releaseRoot, fixture } from '../fixtures/pi-dispatch-facade-perf.js';
