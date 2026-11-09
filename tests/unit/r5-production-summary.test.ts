import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { r5Fixture, idR5 } from '../fixtures/r5-jobs.js';
import { PanelJobPipeline } from '../../src/tree-page.js';
import { makeSourceId } from '../../src/core/identity.js';
import { SmallModel } from '../../src/collectors/small-model.js';
import { ModelJobs, NO_JOBS, labelSource, summaryTree } from '../../src/collectors/model-jobs.js';
import { AgentLog } from '../../src/collectors/agent-log.js';
import { Briefer, briefMaterial } from '../../src/collectors/briefing.js';
import { ProgressSummarizer, progressTargets } from '../../src/collectors/progress-summary.js';
import { RecapStore } from '../../src/collectors/recap.js';
import { ModelRuntimeStore } from '../../src/collectors/model-runtime-store.js';
import { legacyRequest } from '../../src/core/materials/request.js';
import { defaultSettings } from '../../src/settings.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';
import { buildVm } from '../fixtures/b10b-delegation.js';

async function until(check: () => boolean, why: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(check(), why);
}
function fixture(t: TestContext) {
  const f = r5Fixture(t);
  const codexHome = join(f.home, 'codex');
  fs.mkdirSync(join(codexHome, 'sessions'), { recursive: true });
  const source = makeSourceId('codex', fs.realpathSync(codexHome));
  const root = `${source}/main`;
  const dir = join(codexHome, 'hud', 'model-cache');
  const settings = {
    ...defaultSettings(),
    language: 'en' as const,
    briefing: 'api' as const,
    briefingPaused: false,
    briefingApiBase: 'http://synthetic.invalid/v1',
    agentLabels: true,
    resultDigest: true,
    failureCause: true,
    briefAgents: true,
    agentProgress: true,
  };
  f.put(join(codexHome, 'hud-settings.json'), settings);
  const rollout = (id: string, parent?: string) => {
    const file = join(codexHome, 'sessions', `${id}.jsonl`);
    f.put(
      file,
      JSON.stringify({ type: 'session_meta', payload: { id, ...(parent ? { parent_thread_id: parent } : {}) } }) + '\n'
    );
    return file;
  };
  const rootPath = rollout('main');
  const nativePath = rollout('native', 'main');
  const native: SubagentTreeNode = {
    id: 'native',
    name: 'Native original',
    status: 'completed',
    depth: 1,
    children: [],
    rolloutPath: nativePath,
    task: 'Improve the synthetic tokenizer',
    statusAt: new Date(f.now()),
    stages: [
      {
        startedAt: new Date(f.now() - 1000),
        endedAt: new Date(f.now()),
        status: 'done',
        result: 'Implemented and checked the tokenizer.',
      },
    ],
  };
  const tree: SubagentTree = { rootId: 'main', nodes: [native], totalCount: 1, updatedAt: new Date(f.now()) };
  const requests: string[] = [];
  const transport = (async (_url: any, init: RequestInit) => {
    const body = String(init.body);
    requests.push(body);
    const system = JSON.parse(body).messages[0].content as string;
    const text = system.includes('name subagents')
      ? '{"labels":[{"kind":"fix","name":"Tokenizer repair"}]}'
      : system.includes('digest the final answer')
        ? '{"conclusion":"Tokenizer repaired","basis":"Synthetic tests pass"}'
        : system.includes('status brief')
          ? '{"overall":"Tokenizer work completed","agents":[{"agent":"Native original","note":"Tokenizer is ready","attention":false,"label":"Tokenizer repair"}]}'
          : system.includes('current progress')
            ? 'Checking the tokenizer tests.'
            : 'Synthetic response';
    return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
  }) as typeof fetch;
  const model = () => {
    const m = new SmallModel({
      dir,
      env: { HOME: f.home, CODEX_HOME: codexHome, HUD_HOME: f.home },
      fetch: transport,
      clock: f.now,
    });
    m.configure({ backend: 'api', api: { base: settings.briefingApiBase, model: '', key: '' }, hourlyCap: 1000 });
    t.after(() => m.cancelAll());
    return m;
  };
  const log = () => {
    const l = new AgentLog(join(codexHome, 'hud', 'agent-log'));
    l.observe(tree);
    return l;
  };
  return { f, codexHome, source, root, rootPath, dir, settings, native, tree, requests, model, log };
}

test('R5 material sentinels never enter production label/cause/brief/progress text or cache-key inputs; native enrichment remains eligible', async (t) => {
  const x = fixture(t),
    { f } = x;
  const sentinel = 'R5_DENIED_JOB_SENTINEL_7B9';
  const denied = f.association(1, { root: x.root, task_label: sentinel });
  f.dispatch(denied);
  f.put(join(f.home, 'jobs', denied.job, 'report.md'), sentinel);
  f.put(join(f.home, 'jobs', denied.job, 'qa', 'q1.md'), sentinel);
  f.receipt(
    f.association(2, {
      root: x.root,
      native: { harness: 'codex', sourceId: x.source, sessionId: 'native', threadId: null },
      task_label: sentinel,
    })
  );
  const p = new PanelJobPipeline(f.home, x.root, { live: false, now: f.now });
  t.after(() => p.dispose());
  for (let i = 0; i < 16; i++) await p.refresh();
  const tree = p.compose(x.tree, null, f.now(), x.root).tree;
  assert.equal(tree.nodes.find((node) => node.id === 'native')!.job!.jobId, idR5(2));
  const job = tree.nodes.find((node) => node.id === `role-job:${denied.job}`)!;
  // Even legacy-looking fields attached by a caller must not revive the fallback.
  Object.assign(job, {
    task: sentinel,
    charge: sentinel,
    lastReport: { text: sentinel, at: new Date(f.now()) },
    status: 'running',
  });
  assert.equal(labelSource(job), undefined);
  assert.equal(summaryTree(tree).nodes.length, 1);
  const m = x.model();
  const log = x.log();
  const composed: string[] = [];
  const submit = m.submit;
  t.mock.method(m, 'submit', function (this: SmallModel, request: Parameters<SmallModel['submit']>[0]) {
    const plan = request.materials;
    return submit.call(
      this,
      plan
        ? {
            ...request,
            materials: {
              ...plan,
              compose: (envelope) => {
                const built = plan.compose(envelope);
                composed.push(JSON.stringify(built));
                return built;
              },
            },
          }
        : request
    );
  });
  const jobs = new ModelJobs({ model: m, log, labelsFile: join(x.dir, 'labels.json') });
  const brief = new Briefer(() => {}, { model: m, log });
  const progress = new ProgressSummarizer(m, log);
  t.after(() => {
    jobs.stop();
    brief.stop();
    progress.stop();
  });
  jobs.apply(tree, { ...NO_JOBS, agentLabels: true }, 'en');
  jobs.update({
    tree,
    main: null,
    switches: { ...NO_JOBS, agentLabels: true, resultDigest: true, failureCause: true },
    language: 'en',
    on: true,
    digestLabels: { basis: 'Basis', caveats: 'Caveats' },
    now: f.now(),
  });
  brief.update(tree, 'api', 1, 'en', f.now());
  progress.update({ tree, targets: new Set([job.id]), language: 'en', on: true, now: f.now() });
  await until(
    () => x.requests.length >= 3 && !m.diagnostics().running && !m.diagnostics().queued,
    'native label, digest and brief execute'
  );
  jobs.apply(tree, { ...NO_JOBS, agentLabels: true }, 'en');
  await until(() => tree.nodes[0]!.label === 'Tokenizer repair', 'native enriched label applies unchanged');
  assert.equal(progressTargets(tree, new Set([job.id])).size, 0);
  assert.ok(composed.length >= 3);
  assert.ok(!JSON.stringify([...x.requests, ...composed]).includes(sentinel));
  const material = briefMaterial(tree, {
    scope: 'agents',
    language: 'en',
    main: null,
    recap: null,
    since: null,
    now: f.now(),
  });
  assert.ok(material);
  assert.ok(!JSON.stringify(material.write()).includes(sentinel));
  await m.flushTelemetry();
  const scan = (dir: string): string =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .map((e) => (e.isDirectory() ? scan(join(dir, e.name)) : fs.readFileSync(join(dir, e.name), 'utf8')))
      .join('\n');
  assert.ok(!scan(join(x.codexHome, 'hud')).includes(sentinel));
});

test('R5 display-only legacy native-root wrapper never enters material planning; ambient native brief remains eligible', async (t) => {
  const x = fixture(t),
    { f } = x;
  const legacy = buildVm([{ id: 'foreign', root: true }]).vm;
  const identity = legacy.tree.nodes[0]!.identity;
  assert.equal(identity.kind, 'session');
  const root = identity.kind === 'session' ? `${identity.ref.sourceId}/${identity.ref.sessionId}` : '';
  f.receipt(f.association(1, { root, task_label: 'FOREIGN_JOB_NOT_MATERIAL' }));
  const p = new PanelJobPipeline(f.home, null, { live: false, now: f.now });
  t.after(() => p.dispose());
  for (let n = 0; n < 10; n++) await p.refresh();
  const result = p.compose(x.tree, legacy, f.now(), x.root);
  const wrapper = result.tree.nodes.find((node) => node.id === legacy.tree.nodes[0]!.key)!;
  assert.ok(wrapper && wrapper.children.length === 1);
  assert.equal(labelSource(wrapper), undefined);
  const filtered = summaryTree(result.tree);
  assert.deepEqual(
    filtered.nodes.map((node) => node.id),
    ['native']
  );
  const material = briefMaterial(result.tree, {
    scope: 'agents',
    language: 'en',
    main: null,
    recap: null,
    since: null,
    now: f.now(),
  });
  assert.ok(material);
  const model = x.model(),
    log = x.log();
  const submit = model.submit;
  t.mock.method(model, 'submit', function (this: SmallModel, request: Parameters<SmallModel['submit']>[0]) {
    assert.deepEqual(
      request.materials?.legacy?.map((subject) => subject.sessionId),
      ['native']
    );
    return submit.call(this, request);
  });
  const briefer = new Briefer(() => {}, { model, log });
  t.after(() => briefer.stop());
  briefer.update(result.tree, 'api', 1, 'en', f.now());
  await until(
    () => x.requests.length > 0 && !model.diagnostics().running,
    'ambient native brief produced with foreign metadata wrapper present'
  );
  assert.ok(x.requests.some((request) => request.includes('status brief')));
  assert.ok(!JSON.stringify(x.requests).includes('FOREIGN_JOB_NOT_MATERIAL'));
  assert.ok(!JSON.stringify(result.tree).includes('display-only-job-root'));
});

test('R5 real SmallModel/ModelRuntimeStore restore labels, notes, digests and response cache with jobs present; off and denied leave legacy cache intact', async (t) => {
  const x = fixture(t),
    { f } = x;
  f.receipt(f.association(1, { root: x.root, task_label: 'Not model material' }));
  const enriched = f.association(2, {
    root: x.root,
    native: { harness: 'codex', sourceId: x.source, sessionId: 'native', threadId: null },
  });
  f.dispatch(enriched);
  f.status(enriched, 'working', {}, 'sonic-1');
  const p = new PanelJobPipeline(f.home, x.root, { live: false, now: f.now });
  t.after(() => p.dispose());
  for (let i = 0; i < 10; i++) await p.refresh();
  const tree = p.compose(x.tree, null, f.now(), x.root).tree;
  assert.ok(tree.nodes[0]!.children.some((node) => node.id.startsWith('role-job:') && node.id.includes('sonic-1')));
  assert.notEqual(
    summaryTree(tree).nodes[0],
    tree.nodes[0],
    'material filtering copies a native ancestor, not its display identity'
  );
  const switches = { ...NO_JOBS, agentLabels: true, resultDigest: true };
  const m = x.model(),
    log = x.log();
  const jobs = new ModelJobs({ model: m, log, labelsFile: join(x.dir, 'labels.json') });
  const brief = new Briefer(() => {}, { model: m, log });
  jobs.update({
    tree,
    main: null,
    switches,
    language: 'en',
    on: true,
    now: f.now(),
    digestLabels: { basis: 'Basis', caveats: 'Caveats' },
  });
  brief.update(tree, 'api', 1, 'en', f.now());
  await until(
    () =>
      log.entries('native').some((e) => e.kind === 'digest') && log.entries('native').some((e) => e.kind === 'note'),
    'production summaries saved'
  );
  await m.flushTelemetry();
  jobs.stop();
  brief.stop();
  m.cancelAll();
  const file = join(x.dir, 'cache.json');
  assert.ok(fs.existsSync(file));
  const before = fs.readFileSync(file);
  const restoredLog = x.log();
  const restoredModel = x.model();
  const fresh = p.compose(x.tree, null, f.now(), x.root).tree;
  const restoredJobs = new ModelJobs({
    model: restoredModel,
    log: restoredLog,
    labelsFile: join(x.dir, 'labels.json'),
    onChange: () => restoredJobs.apply(fresh, switches, 'en'),
  });
  restoredJobs.apply(fresh, switches, 'en');
  await until(() => fresh.nodes[0]!.label === 'Tokenizer repair', 'label cache restoration');
  assert.match(fresh.nodes[0]!.digest!, /Tokenizer repaired/);
  assert.ok(restoredLog.entries('native').some((e) => e.kind === 'note' && e.text === 'Tokenizer is ready'));
  assert.equal(fresh.nodes[0]!.taskKind, 'fix');
  restoredJobs.apply(fresh, NO_JOBS, 'en');
  assert.equal(fresh.nodes[0]!.label, undefined, 'summaries off clears original native ancestor label');
  assert.equal(fresh.nodes[0]!.taskKind, undefined, 'summaries off clears original native ancestor task kind');
  assert.equal(fresh.nodes[0]!.digest, undefined, 'summaries off clears original native ancestor digest');
  restoredJobs.apply(fresh, switches, 'en');
  assert.equal(fresh.nodes[0]!.label, 'Tokenizer repair');
  const subject = [{ sessionId: 'native', parentSessionId: 'main', rolloutPath: x.native.rolloutPath }];
  const request = legacyRequest('digest', subject, () => ({
    feature: 'digest',
    language: 'en',
    system: 'Synthetic cache probe',
    prompt: 'Public native evidence',
    cacheKey: 'r5-restoration',
  }));
  const first = await restoredModel.submit(request).result;
  assert.ok(first.ok);
  await restoredModel.flushTelemetry();
  restoredModel.cancelAll();
  const next = x.model();
  const count = x.requests.length;
  const hit = await next.submit(request).result;
  assert.ok(hit.ok && hit.cached);
  assert.equal(x.requests.length, count);
  // Read the original production store, not the B17 test double or a moved cache.
  assert.ok(new ModelRuntimeStore(x.dir));
  const cacheBeforeDenied = fs.readFileSync(file);
  const deniedOnly = { ...tree, nodes: tree.nodes.filter((node) => node.id.startsWith('role-job:')) };
  const deniedJobs = new ModelJobs({ model: next, log: restoredLog, labelsFile: join(x.dir, 'labels.json') });
  const deniedBrief = new Briefer(() => {}, { model: next, log: restoredLog });
  deniedJobs.update({
    tree: deniedOnly,
    main: null,
    switches,
    language: 'en',
    on: true,
    now: f.now(),
    digestLabels: { basis: 'Basis', caveats: 'Caveats' },
  });
  deniedBrief.update(deniedOnly, 'api', 1, 'en', f.now());
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(fs.readFileSync(file), cacheBeforeDenied);
  assert.equal(x.requests.length, count);
  next.configure({ backend: 'off' });
  deniedJobs.update({
    tree: fresh,
    main: null,
    switches,
    language: 'en',
    on: false,
    now: f.now(),
    digestLabels: { basis: 'Basis', caveats: 'Caveats' },
  });
  deniedBrief.update(fresh, 'off', 1, 'en', f.now());
  assert.equal(x.requests.length, count);
  assert.ok(before.length > 0);
  restoredJobs.stop();
  deniedJobs.stop();
  deniedBrief.stop();
});
