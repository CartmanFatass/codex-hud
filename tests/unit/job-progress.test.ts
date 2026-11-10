import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { r5Fixture, ROOT_R5 } from '../fixtures/r5-jobs.js';
import { useDisplayFixture } from '../fixtures/display.js';
import { p2Fixture, p2Native } from '../fixtures/work-card-p2.js';
import { PanelJobPipeline } from '../../src/tree-page.js';
import { SmallModel } from '../../src/collectors/small-model.js';
import { JobProgress, parseJobProgress, JOB_PROGRESS_LIMITS } from '../../src/collectors/job-progress.js';
import {
  JobMaterialAuthority,
  jobReadBudget,
  jobFileMetrics,
  type JobReadBudget,
} from '../../src/core/materials/job.js';
import { DerivedMaterialStore } from '../../src/core/materials/derived.js';
import { initialMonitorState, renderMonitor } from '../../src/render/monitor.js';
import { handleMonitorInput } from '../../src/render/monitor-input.js';
import { jobInspectorTargets } from '../../src/render/work-visibility.js';
import { projectWorkCard } from '../../src/collectors/work-card.js';
import { renderWorkCard } from '../../src/render/work-card.js';
import { workInspectorRows } from '../../src/render/work-inspector.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { setLanguage } from '../../src/render/i18n.js';
import { SETTING_ROWS, renderSettingsPage, handleSettingsInput } from '../../src/render/settings-page.js';
import { defaultSettings, saveSettings } from '../../src/settings.js';
useDisplayFixture();
const tick = () => new Promise<void>((r) => setImmediate(r));
const response = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
const defaultReply = JSON.stringify({ line: 'Repairing the public parser boundary.', attention: false, basis: ['e1'] });
async function fixture(t: TestContext, count = 1, production = false) {
  const f = r5Fixture(t);
  const jobs = Array.from({ length: count }, (_, n) => {
    const a = f.association(n + 1, { created_at: '2026-11-09T00:00:00Z' });
    const directory = path.join(f.home, 'jobs', a.job);
    const session = path.join(directory, 'sessions', 'primary.jsonl');
    f.dispatch(a, 'working', { session_file: session });
    f.put(
      session,
      JSON.stringify({ type: 'session', version: 3, id: 'synthetic-primary', cwd: '/synthetic/work' }) +
        '\n' +
        JSON.stringify({
          type: 'message',
          id: 'm1',
          parentId: null,
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Public parser boundary.' },
              { type: 'thinking', thinking: 'PRIVATE_THINKING' },
              { type: 'toolCall', arguments: 'PRIVATE_TOOL' },
            ],
          },
        }) +
        '\n'
    );
    f.put(
      path.join(directory, 'brief.md'),
      '# Synthetic\n\n## Goal\nRepair the public parser.\n\n## Owned files\n- `src/parser.ts`\n\n## Test plan\n### Parser boundary\n'
    );
    f.put(path.join(directory, 'design.md'), 'PRIVATE_DESIGN');
    f.put(path.join(directory, 'qa', 'q1.answer.md'), 'PRIVATE_ANSWER');
    return { a, directory, session };
  });
  const pipeline = new PanelJobPipeline(f.home, ROOT_R5, { live: false, now: f.now });
  t.after(() => pipeline.dispose());
  for (let n = 0; n < 15; n++) await pipeline.refresh();
  let tree = pipeline.compose(f.emptyTree(), null, f.now()).tree;
  let board = pipeline.workboard(tree);
  assert.equal(board.workers.length, count);
  const state = { ...initialMonitorState(), mainTab: 'work' as const };
  const draw = (width = 56, height = 100, notes = progress.state()) =>
    renderMonitor({ tree, workboard: board, jobProgress: notes, state, width, height, nowMs: f.now() });
  let calls = 0;
  let payloads: string[] = [];
  let reply = defaultReply;
  let blocked = false;
  const releases: (() => void)[] = [];
  const env = { HOME: process.env.HOME, HUD_HOME: f.home, MISTRAL_API_KEY: 'synthetic-key-never-persist' };
  const modelDir = path.join(f.home, 'model');
  const makeModel = () => {
    const m = new SmallModel({
      dir: modelDir,
      ...(production ? {} : { account: 'synthetic-account' }),
      env,
      fetch: async (_url, init) => {
        calls++;
        payloads.push(String(init?.body));
        if (blocked) await new Promise<void>((resolve) => releases.push(resolve));
        return response(reply);
      },
    });
    m.configure({ backend: 'api', api: { base: 'https://api.mistral.ai/v1', model: 'synthetic-model' } });
    return m;
  };
  let model = makeModel();
  let authority = new JobMaterialAuthority(f.home);
  const store = new DerivedMaterialStore(path.join(f.home, 'derived'));
  let progress = new JobProgress(model, authority, store);
  t.after(() => {
    progress.dispose();
    model.cancelAll();
    for (const release of releases) release();
  });
  const grant = () => assert.equal(progress.consent('allow', f.now()), true);
  const poll = (
    budget: JobReadBudget = jobReadBudget(),
    language: 'en' | 'zh' = 'en',
    on = true,
    targets = new Set(board.workers.map((w) => w.id)),
    retainTargets?: ReadonlySet<string>
  ) => progress.update({ board, targets, retainTargets, budget, language, now: f.now(), on });
  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      await tick();
      if (!progress.outstanding) return;
    }
    assert.fail('requests did not settle');
  };
  const refresh = async () => {
    for (let i = 0; i < 12; i++) await pipeline.refresh();
    tree = pipeline.compose(f.emptyTree(), null, f.now()).tree;
    board = pipeline.workboard(tree);
  };
  return {
    f,
    jobs,
    pipeline,
    state,
    draw,
    poll,
    settle,
    grant,
    refresh,
    env,
    payloads,
    modelDir,
    get board() {
      return board;
    },
    get tree() {
      return tree;
    },
    get progress() {
      return progress;
    },
    get model() {
      return model;
    },
    get authority() {
      return authority;
    },
    get calls() {
      return calls;
    },
    reply: (text: string) => {
      reply = text;
    },
    block: () => {
      blocked = true;
    },
    release: () => {
      blocked = false;
      for (const release of releases.splice(0)) release();
    },
    restart: () => {
      progress.dispose();
      model.cancelAll();
      model = makeModel();
      authority = new JobMaterialAuthority(f.home);
      progress = new JobProgress(model, authority, store);
    },
  };
}

test('P3b production-shaped end to end: real collection, allowlisted material, model, persisted provenance, Work and Inspector', async (t) => {
  const f = await fixture(t, 1, true);
  assert.equal(f.progress.consentState(), 'denied');
  f.grant();
  f.poll();
  await f.settle();
  assert.equal(f.calls, 1);
  const sent = f.payloads.join('\n');
  for (const privateText of ['PRIVATE_THINKING', 'PRIVATE_TOOL', 'PRIVATE_DESIGN', 'PRIVATE_ANSWER'])
    assert.ok(!sent.includes(privateText));
  assert.ok(sent.includes('Repair the public parser'));
  const note = f.progress.state().get(f.board.workers[0].id)?.note;
  assert.equal(note?.line, 'Repairing the public parser boundary.');
  assert.match(f.draw().lines.map(stripAnsi).join('\n'), /Repairing the public parser/);
  const detail = workInspectorRows(f.board.workers[0], f.state, 56, f.f.now(), true, { note })
    .map((r) => stripAnsi(r.text))
    .join('\n');
  assert.match(detail, /brief.md/);
  assert.match(detail, /src\/parser.ts/);
  const files = fs.readdirSync(path.join(f.f.home, 'derived', 'jobs-v1'));
  assert.equal(files.length, 1);
  const saved = fs.readFileSync(path.join(f.f.home, 'derived', 'jobs-v1', files[0]), 'utf8');
  assert.match(saved, /recordFingerprint/);
  assert.ok(!saved.includes('synthetic-key-never-persist'));
  f.restart();
  f.poll();
  await f.settle();
  assert.equal(f.calls, 1, 'restart restores a matching authorized note, no new transport');
  assert.equal(f.progress.state().get(f.board.workers[0].id)?.note?.line, note?.line);
});

test('P3b default deny, off/pause, recipient change, revocation and real restart leave deterministic cards', async (t) => {
  const f = await fixture(t, 1, true);
  const deterministic = f.draw(56, 100, new Map()).lines;
  for (let n = 0; n < 5; n++) f.poll();
  assert.equal(f.calls, 0);
  assert.deepEqual(f.draw().lines, deterministic);
  f.grant();
  f.poll(undefined, 'en', false);
  assert.equal(f.calls, 0);
  f.poll();
  await f.settle();
  assert.equal(f.calls, 1);
  f.progress.consent('deny', f.f.now());
  assert.equal(f.progress.state().size, 0);
  assert.deepEqual(f.draw().lines, deterministic);
  f.restart();
  f.poll();
  await f.settle();
  assert.equal(f.calls, 1);
  assert.equal(f.progress.state().size, 0);
  f.grant();
  f.env.MISTRAL_API_KEY = 'synthetic-rotated-key';
  assert.equal(f.model.jobCardRecipient(), null);
  f.poll();
  assert.equal(f.calls, 1);
  assert.equal(f.progress.state().size, 0);
});

for (const [name, reply, valid] of [
  ['empty', { line: '', attention: false, basis: [] }, true],
  ['attention without line', { line: '', attention: true, basis: ['e1'] }, false],
  ['foreign basis', { line: 'Parser repaired.', attention: false, basis: ['other'] }, false],
  ['five basis IDs', { line: 'Parser repaired.', attention: false, basis: ['e1', 'e2', 'e3', 'e4', 'e5'] }, false],
  ['oversized', { line: 'x'.repeat(161), attention: false, basis: ['e1'] }, false],
  ['extra field', { line: 'Parser repaired.', attention: false, basis: ['e1'], action: 'execute' }, false],
  ['Markdown', { line: '**Parser repaired.**', attention: false, basis: ['e1'] }, false],
  ['wrong language', { line: '正在修复公开解析器边界问题。', attention: false, basis: ['e1'] }, false],
] as const)
  test(`P3b strict reply: ${name}`, async (t) => {
    assert.equal(!!parseJobProgress(JSON.stringify(reply), new Set(['e1', 'e2', 'e3', 'e4', 'e5']), 'en'), valid);
    const f = await fixture(t);
    f.reply(JSON.stringify(reply));
    f.grant();
    f.poll();
    await f.settle();
    assert.equal(!!f.progress.state().get(f.board.workers[0].id)?.note, valid);
    for (let n = 0; n < 50; n++) {
      f.f.advance(61000);
      f.poll();
    }
    await f.settle();
    assert.equal(f.calls, 1, 'empty and failed fingerprints do not retry on a timer');
  });

test('P3b inspected sentence survives real Work-to-Inspector collection ticks without new requests', async (t) => {
  const f = await fixture(t);
  f.grant();
  f.poll();
  await f.settle();
  const worker = f.board.workers[0];
  f.state.workTarget = { kind: 'worker', laneId: worker.laneId, workerId: worker.id };
  const work = f.draw();
  Object.assign(
    f.state,
    handleMonitorInput(work.state, { type: 'key', key: 'inspect' }, { tree: f.tree, frame: work, nowMs: f.f.now() })
      .state
  );
  let inspector = f.draw();
  assert.match(inspector.lines.map(stripAnsi).join('\n'), /src\/parser.ts/);
  for (let i = 0; i < 3; i++) {
    f.poll(
      undefined,
      'en',
      true,
      new Set(inspector.workboard?.sentenceTargets),
      jobInspectorTargets(f.board, inspector.state)
    );
    await f.settle();
    inspector = f.draw();
  }
  assert.match(inspector.lines.map(stripAnsi).join('\n'), /Repairing the public parser/);
  assert.match(inspector.lines.map(stripAnsi).join('\n'), /src\/parser.ts/);
  const brief = path.join(f.jobs[0].directory, 'brief.md');
  fs.writeFileSync(
    brief,
    fs.readFileSync(brief, 'utf8').replace('Repair the public parser.', 'Repair the revised public parser.')
  );
  f.f.advance(61001);
  f.poll(undefined, 'en', true, new Set(), jobInspectorTargets(f.board, inspector.state));
  await f.settle();
  assert.equal(f.calls, 1, 'even changed eligible material cannot start an Inspector-only request');
  f.progress.consent('deny', f.f.now());
  f.poll(undefined, 'en', true, new Set(), jobInspectorTargets(f.board, inspector.state));
  assert.equal(f.progress.state().size, 0, 'revocation also removes retained Inspector material');
});

test('P3b ten visible jobs finish fairly with one remaining file per collection slice', async (t) => {
  const f = await fixture(t, 10);
  f.grant();
  let ticks = 0;
  for (; ticks < 160 && f.calls < 10; ticks++) {
    const budget = { ...jobReadBudget(), maxFiles: 1, maxProbes: 512 };
    f.poll(budget);
    await f.settle();
    assert.ok(budget.files <= 1 && (budget.probes ?? 0) <= 512);
  }
  console.log(
    'P3B constrained fairness',
    JSON.stringify({ ticks, calls: f.calls, reasons: [...f.progress.state()].map(([id, v]) => [id, v.reason]) })
  );
  assert.equal(f.calls, 10, 'all ten ordinary jobs complete without cache-churn declines');
  assert.equal([...f.progress.state().values()].filter((v) => v.note).length, 10);
});

test('P3b waiting revalidation jobs drop attention but retain prose under a constrained ten-job backlog', async (t) => {
  const f = await fixture(t, 10);
  f.grant();
  f.reply(JSON.stringify({ line: 'The public parser needs another look.', attention: true, basis: ['e1'] }));
  for (let n = 0; n < 30 && f.calls < 10; n++) {
    f.poll();
    await f.settle();
  }
  assert.equal(f.calls, 10);
  assert.ok([...f.progress.state().values()].some((v) => v.note?.attention));
  const deterministic = JSON.stringify(f.board);
  for (const job of f.jobs) {
    const file = path.join(job.directory, 'brief.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('src/parser.ts', 'src/other-parser.ts'));
  }
  f.poll({ ...jobReadBudget(), maxFiles: 1, maxProbes: 512 });
  assert.ok([...f.progress.state().values()].every((v) => !v.note?.attention));
  assert.ok([...f.progress.state().values()].some((v) => v.note?.line === 'The public parser needs another look.'));
  assert.equal(JSON.stringify(f.board), deterministic);
});

test('P3b malformed raw reply is never displayed', async (t) => {
  const f = await fixture(t);
  f.reply('RAW_MALFORMED');
  f.grant();
  f.poll();
  await f.settle();
  assert.ok(!f.draw().lines.join('\n').includes('RAW_MALFORMED'));
  assert.equal(f.progress.state().get(f.board.workers[0].id)?.note, undefined);
});

test('P3b attention is display only, basis-bound, cannot suppress a deterministic question or promote Home', async (t) => {
  const f = await fixture(t);
  f.reply(JSON.stringify({ line: 'The public parser boundary needs another look.', attention: true, basis: ['e1'] }));
  f.grant();
  f.poll();
  await f.settle();
  const worker = f.board.workers[0],
    before = JSON.stringify(worker),
    note = f.progress.state().get(worker.id)!.note!;
  assert.equal(projectWorkCard(worker, f.f.now(), 10, note).state, 'needs-you');
  assert.equal(projectWorkCard(worker, f.f.now(), 10, note).modelAttention, true);
  assert.equal(JSON.stringify(worker), before);
  assert.equal(worker.homeNeedsHuman, false);
  assert.match(f.draw().lines.map(stripAnsi).join('\n'), /Model assessment/);
  const question = {
    ...worker,
    work: {
      ...worker.work!,
      request: true,
      requestId: 'q2',
      requestInfo: { id: 'q2', question: 'Keep the parser?', suggested: 'A', options: ['A', 'B'] },
    },
  };
  assert.match(
    renderWorkCard(projectWorkCard(question, f.f.now(), 10, note), f.state, 110, note.line)
      .map(stripAnsi)
      .join('\n'),
    /answer q2/
  );
  const brief = path.join(f.jobs[0].directory, 'brief.md');
  fs.writeFileSync(brief, fs.readFileSync(brief, 'utf8').replace('src/parser.ts', 'src/new-parser.ts'));
  f.poll();
  assert.equal(f.progress.state().get(worker.id)?.note, undefined, 'changed basis clears promotion immediately');
});

test('P3b no redraw/resize/fold call; shared physical viewport targets exclude offscreen and dedupe peek', async (t) => {
  const f = await fixture(t, 10);
  f.grant();
  const frame = f.draw(56, 8);
  const targets = frame.workboard!.sentenceTargets!;
  assert.ok(targets.size > 0 && targets.size < 10);
  for (let n = 0; n < 50; n++) {
    f.state.boardFolded = n % 2 ? new Set([f.board.lanes[0].id]) : new Set();
    f.draw(n % 2 ? 110 : 44, 8);
  }
  assert.equal(f.calls, 0, 'rendering never schedules');
  f.state.boardFolded = new Set();
  f.poll(undefined, 'en', true, new Set(targets));
  await f.settle();
  assert.equal(f.calls, targets.size);
  assert.ok([...f.progress.state().keys()].every((id) => targets.has(id)));
  const home = renderMonitor({
    tree: f.tree,
    workboard: f.board,
    state: { ...initialMonitorState(), mainTab: 'home' },
    width: 110,
    height: 100,
    nowMs: f.f.now(),
  });
  assert.equal(
    home.workboard!.sentenceTargets!.size,
    1,
    'Home worker rows are not model targets; only actual peek card'
  );
});

test('P3b queue cap, fair 10-job admission, minute throttle and append-heavy snapshot completion', async (t) => {
  const f = await fixture(t, 10);
  f.grant();
  f.block();
  f.poll();
  assert.equal(f.progress.outstanding, 3);
  await tick();
  assert.equal(f.calls, 1, 'SmallModel has one transport slot');
  for (let n = 0; n < 4; n++) {
    fs.appendFileSync(
      f.jobs[0].session,
      JSON.stringify({
        type: 'message',
        id: `a${n}`,
        parentId: n ? `a${n - 1}` : 'm1',
        message: { role: 'assistant', content: [{ type: 'text', text: `Public append ${n}.` }] },
      }) + '\n'
    );
    f.poll();
  }
  f.release();
  await f.settle();
  assert.ok(f.progress.state().get(f.board.workers[0].id)?.note, 'same-episode snapshot finishes');
  for (let n = 0; n < 10 && f.calls < 10; n++) {
    f.poll();
    await f.settle();
  }
  assert.equal(f.calls, 10, 'every visible job gets its fair share');
  f.poll();
  await f.settle();
  assert.equal(f.calls, 10, 'same job is minute throttled');
  f.f.advance(60001);
  for (let n = 0; n < Math.ceil(10 / JOB_PROGRESS_LIMITS.outstanding) && f.calls < 11; n++) {
    f.poll();
    await f.settle();
  }
  assert.equal(f.calls, 11, 'changed material is revisited within its bounded round-robin share');
});

test('P3b redraw visibility, pause and language switches do not bypass the per-job minute throttle', async (t) => {
  const f = await fixture(t);
  f.grant();
  let admissions = 0;
  f.model.submit = new Proxy(f.model.submit, {
    apply(target, receiver, args) {
      admissions++;
      return Reflect.apply(target, receiver, args);
    },
  });
  f.poll();
  await f.settle();
  assert.equal(admissions, 1);
  f.poll(undefined, 'en', true, new Set());
  f.poll();
  await f.settle();
  assert.equal(admissions, 1);
  f.poll(undefined, 'en', false);
  f.poll();
  await f.settle();
  assert.equal(admissions, 1);
  f.reply(JSON.stringify({ line: '正在修复公开解析器边界。', attention: false, basis: ['e1'] }));
  f.poll(undefined, 'zh');
  await f.settle();
  assert.equal(admissions, 1);
  f.f.advance(60001);
  f.poll(undefined, 'zh');
  await f.settle();
  assert.equal(admissions, 2);
});

test('P3b a pause cancels an in-flight attempt without permanently consuming its unchanged fingerprint', async (t) => {
  const f = await fixture(t);
  f.grant();
  f.block();
  f.poll();
  await tick();
  assert.equal(f.calls, 1);
  f.poll(undefined, 'en', false);
  assert.equal(f.progress.state().size, 0);
  f.release();
  await tick();
  assert.equal(f.progress.state().size, 0);
  f.f.advance(60001);
  f.poll();
  await f.settle();
  assert.equal(f.calls, 2);
  assert.ok([...f.progress.state().values()][0]?.note);
});

test('P3b policy/language/root/episode changes cancel obsolete replies, including queued work', async (t) => {
  const f = await fixture(t, 3);
  f.grant();
  f.block();
  f.poll();
  await tick();
  assert.equal(f.progress.outstanding, 3);
  f.progress.consent('deny', f.f.now());
  f.release();
  await tick();
  assert.equal(f.progress.state().size, 0);
  assert.equal(f.calls, 1, 'queued work dropped');
  f.grant();
  f.block();
  f.f.advance(61000);
  f.poll();
  await tick();
  f.poll(undefined, 'zh');
  f.release();
  await f.settle();
  assert.ok(
    [...f.progress.state().values()].every((v) => !v.note),
    'English late reply fenced'
  );
  f.f.advance(61000);
  f.poll(undefined, 'en');
  await f.settle();
  f.f.status(f.jobs[0].a, 'working', { session_id: 'replacement', session_file: f.jobs[0].session });
  await f.refresh();
  f.poll();
  assert.equal(f.progress.state().get(f.board.workers[0].id)?.note, undefined);
  f.poll(undefined, 'en', true, new Set());
  assert.equal(f.progress.state().size, 0);
});

test('P3b material budget defers over ticks and fixed cumulative cap declines visibly', async (t) => {
  const f = await fixture(t);
  f.grant();
  const costs: { probes: number; files: number; bytes: number }[] = [];
  for (let i = 0; i < 20 && !f.calls; i++) {
    const budget = { ...jobReadBudget(), maxFiles: 1, maxProbes: 512 };
    f.poll(budget);
    costs.push({ probes: budget.probes ?? 0, files: budget.files, bytes: budget.bytes });
    await tick();
  }
  await f.settle();
  assert.equal(f.calls, 1);
  assert.ok(costs.length > 1);
  console.log('P3B cold slices', JSON.stringify(costs));
  const g = await fixture(t);
  g.grant();
  for (let n = 0; n < Math.ceil(JOB_PROGRESS_LIMITS.probes / 8) + 10; n++)
    g.poll({ ...jobReadBudget(), maxProbes: 24 });
  assert.equal(g.calls, 0);
  const reason = g.progress.state().get(g.board.workers[0].id)?.reason;
  assert.equal(reason, 'Job material probe cap exceeded');
  const rows = workInspectorRows(g.board.workers[0], g.state, 56, g.f.now(), true, { reason });
  assert.match(rows.map((r) => r.text).join('\n'), /probe cap exceeded/);
});

test('P3b auto-discovered workspace tasks never acquire a job grant or material read', async (t) => {
  const f = await fixture(t);
  f.grant();
  const task = {
    ...f.board.lanes[0],
    identity: {
      kind: 'task-directory' as const,
      workspace: '/synthetic',
      directory: '/synthetic/tmp/tasks/j0000000000000001',
    },
  };
  f.authority.policy();
  const readBefore = { ...f.authority.reads };
  f.progress.update({
    board: { ...f.board, lanes: [task] },
    targets: new Set(task.workers.map((w) => w.id)),
    on: true,
    language: 'en',
    now: f.f.now(),
    budget: jobReadBudget(),
  });
  await f.settle();
  assert.equal(f.calls, 0);
  assert.deepEqual(f.authority.reads, readBefore);
});

test('P3b consent row is explicit, unavailable does not grant, preferences never store consent', () => {
  const index = SETTING_ROWS.findIndex((r) => r.key === 'jobMaterialConsent');
  assert.ok(index >= 0);
  const state = {
    draft: defaultSettings(),
    original: defaultSettings(),
    selected: index,
    offset: 0,
    message: '',
    jobConsent: 'denied' as const,
  };
  const frame = renderSettingsPage(state, 56, 30);
  const changed = handleSettingsInput(state, { type: 'key', key: 'enter' }, frame);
  assert.equal(changed.action, 'job-consent');
  assert.deepEqual(changed.state.draft, state.draft);
});

test('P3b Settings consent is fenced to the displayed concrete recipient', async (t) => {
  const f = await fixture(t, 1, true);
  const displayed = f.model.jobCardRecipient()!;
  f.env.MISTRAL_API_KEY = '';
  assert.notEqual(f.model.jobCardRecipient()?.recipientId, displayed.recipientId);
  assert.equal(f.progress.consent('allow', f.f.now(), displayed.recipientId), false);
  assert.equal(fs.existsSync(path.join(f.f.home, 'job-materials-v1', 'policy.json')), false);
  f.poll();
  assert.equal(f.calls, 0);
});

test('P3b saving all preferences untouched never grants or serializes job consent', async (t) => {
  const f = await fixture(t, 1, true);
  const file = path.join(f.f.home, 'synthetic-settings.json');
  const previous = process.env.HUD_SETTINGS_PATH;
  process.env.HUD_SETTINGS_PATH = file;
  try {
    saveSettings(defaultSettings());
  } finally {
    if (previous === undefined) delete process.env.HUD_SETTINGS_PATH;
    else process.env.HUD_SETTINGS_PATH = previous;
  }
  const bytes = fs.readFileSync(file, 'utf8');
  assert.ok(!bytes.includes('jobMaterialConsent'));
  assert.ok(!bytes.includes('jobConsent'));
  assert.equal(fs.existsSync(path.join(f.f.home, 'job-materials-v1', 'policy.json')), false);
  f.poll();
  assert.equal(f.calls, 0);
});

test('P3b deep path measured admission completes over ticks, using only shared pipeline remainder', async (t) => {
  const f = await fixture(t);
  f.grant();
  const deep = path.join(f.f.home, ...Array<string>(12).fill('d'));
  fs.mkdirSync(deep, { recursive: true });
  for (const part of ['assoc', 'jobs', 'job-materials-v1'])
    fs.cpSync(path.join(f.f.home, part), path.join(deep, part), { recursive: true });
  const replacePaths = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) replacePaths(file);
      else if (entry.name.endsWith('.json'))
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split(f.f.home).join(deep));
    }
  };
  replacePaths(path.join(deep, 'assoc'));
  replacePaths(path.join(deep, 'jobs'));
  const authority = new JobMaterialAuthority(deep);
  const progress = new JobProgress(f.model, authority, new DerivedMaterialStore(path.join(deep, 'derived')));
  t.after(() => progress.dispose());
  const admissionProbeStart = jobFileMetrics.probes;
  const costs: { files: number; bytes: number; probes: number }[] = [];
  for (let i = 0; i < 50 && !f.calls; i++) {
    const budget = { ...jobReadBudget(), maxFiles: 2, maxProbes: 512 };
    progress.update({
      board: f.board,
      targets: new Set(f.board.workers.map((w) => w.id)),
      on: true,
      language: 'en',
      now: f.f.now(),
      budget,
    });
    costs.push({ files: budget.files, bytes: budget.bytes, probes: budget.probes ?? 0 });
    await tick();
  }
  for (let i = 0; i < 30 && progress.outstanding; i++) await tick();
  console.log(
    'P3B deep12 admission',
    JSON.stringify({
      costs,
      state: [...progress.state()],
      cumulativeProbes: costs.reduce((n, c) => n + c.probes, 0),
      allAdmissionProbes: jobFileMetrics.probes - admissionProbeStart,
      cap: JOB_PROGRESS_LIMITS.probes,
    })
  );
  assert.equal(f.calls, 1);
  assert.ok(progress.state().get(f.board.workers[0].id)?.note);
  assert.ok(costs.length > 1);
  const beyond = path.join(f.f.home, ...Array<string>(43).fill('b'));
  fs.mkdirSync(beyond, { recursive: true });
  for (const part of ['assoc', 'jobs', 'job-materials-v1'])
    fs.cpSync(path.join(f.f.home, part), path.join(beyond, part), { recursive: true });
  const rewrite = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) rewrite(file);
      else if (entry.name.endsWith('.json'))
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split(f.f.home).join(beyond));
    }
  };
  rewrite(path.join(beyond, 'assoc'));
  rewrite(path.join(beyond, 'jobs'));
  const declined = new JobProgress(
    f.model,
    new JobMaterialAuthority(beyond),
    new DerivedMaterialStore(path.join(beyond, 'derived'))
  );
  t.after(() => declined.dispose());
  const globalProbeStart = jobFileMetrics.probes;
  let declineProbes = 0,
    declineTicks = 0;
  for (
    ;
    declineTicks < 100 && declined.state().get(f.board.workers[0].id)?.reason !== 'Job material probe cap exceeded';
    declineTicks++
  ) {
    const budget = { ...jobReadBudget(), maxFiles: 2, maxProbes: 512 };
    declined.update({
      board: f.board,
      targets: new Set(f.board.workers.map((w) => w.id)),
      on: true,
      language: 'en',
      now: f.f.now(),
      budget,
    });
    declineProbes += budget.probes ?? 0;
    await tick();
  }
  assert.equal(declined.state().get(f.board.workers[0].id)?.reason, 'Job material probe cap exceeded');
  assert.equal(f.calls, 1, 'deep dispatch deferrals never make a provider request');
  const allDeclineProbes = jobFileMetrics.probes - globalProbeStart;
  assert.ok(
    allDeclineProbes <= JOB_PROGRESS_LIMITS.probes,
    `all admission and private-fence probes ${allDeclineProbes} exceed the cumulative cap`
  );
  console.log(
    'P3B deep43 declined',
    JSON.stringify({ declineProbes, allDeclineProbes, declineTicks, cap: JOB_PROGRESS_LIMITS.probes })
  );
  const budgets: JobReadBudget[] = [];
  f.pipeline.sentenceCollection = (budget) => {
    const remaining = budget.maxFiles - budget.files;
    assert.ok(remaining >= 0 && remaining <= 32);
    f.progress.update({
      board: f.pipeline.workboard(f.tree),
      targets: new Set(f.board.workers.map((w) => w.id)),
      on: true,
      language: 'en',
      now: f.f.now(),
      budget,
    });
    assert.ok(budget.files <= 32);
    assert.ok(budget.bytes <= 1024 * 1024);
    assert.ok((budget.entries ?? 0) <= 128);
    budgets.push({ ...budget });
  };
  f.f.status(f.jobs[0].a, 'waiting_orchestrator');
  await f.refresh();
  assert.ok(budgets.length > 0);
  assert.equal(
    f.board.workers[0].work?.request,
    true,
    'deterministic work stays current while material collection runs'
  );
});

test('P3b collection/paint architecture fence rejects scheduling from redraw', () => {
  const source = fs.readFileSync(
    new URL('../../src/tree-page.ts', import.meta.url.replace('/dist-test/tests/unit/', '/tests/unit/')),
    'utf8'
  );
  const render = source.slice(source.indexOf('  const render ='), source.indexOf('  modelChanged ='));
  assert.ok(render.length > 100, 'actual production render body located');
  assert.ok(
    !/jobProgress\??\.(?:update|consent|consentState)|sentenceCollection\s*\??\./.test(render),
    'render may consume display DTOs/targets only'
  );
  assert.equal((source.match(/jobProgress\??\.update\(/g) ?? []).length, 1, 'one collection-only scheduler call site');
});

test('P3b enriched native fallback rejects a note before the job episode', async (t) => {
  const f = p2Fixture(t);
  const ref = { harness: 'pi' as const, sourceId: 'a'.repeat(64), sessionId: 'synthetic-native', threadId: null };
  const native = p2Native('native-owner', { ref });
  const a = f.association(990, { native: ref });
  f.dispatch(a, 'working', { started_at: new Date(f.now() - 60000).toISOString() });
  const data = await f.collect([native]);
  const frame = renderMonitor({
    tree: data.tree,
    workboard: data.board,
    state: { ...initialMonitorState(), mainTab: 'work' },
    width: 56,
    height: 40,
    nowMs: f.now(),
    agentLog: new Map([
      [native.id, [{ at: f.now(), coverageAt: f.now() - 120000, kind: 'note' as const, text: 'OLD_NATIVE_NOTE' }]],
    ]),
  });
  assert.ok(!frame.lines.join('\n').includes('OLD_NATIVE_NOTE'));
});

test('P3b authorized job annotation, including empty, wins over a current exact-native note', async (t) => {
  const f = p2Fixture(t);
  const ref = { harness: 'pi' as const, sourceId: 'a'.repeat(64), sessionId: 'synthetic-native', threadId: null };
  const native = p2Native('native-owner', { ref });
  const a = f.association(991, { native: ref });
  f.dispatch(a, 'working', { started_at: new Date(f.now() - 60000).toISOString() });
  const data = await f.collect([native]);
  const worker = data.board.workers.find((w) => w.nodeId === native.id)!;
  for (const line of ['Current job sentence.', '']) {
    const note = {
      line,
      attention: false,
      basis: [],
      generatedAt: f.now(),
      fingerprint: 'synthetic',
      basisEvidence: [],
      coverage: [],
    };
    const frame = renderMonitor({
      tree: data.tree,
      workboard: data.board,
      state: { ...initialMonitorState(), mainTab: 'work' },
      width: 56,
      height: 40,
      nowMs: f.now(),
      agentLog: new Map([[native.id, [{ at: f.now(), kind: 'note' as const, text: 'CURRENT_NATIVE_NOTE' }]]]),
      jobProgress: new Map([[worker.id, { note }]]),
    });
    const text = frame.lines.map(stripAnsi).join('\n');
    assert.ok(!text.includes('CURRENT_NATIVE_NOTE'));
    if (line) assert.ok(text.includes(line));
  }
});

test('P3b unchanged render performance: 3 runs, exact widths and default <=3 rows', async (t) => {
  const f = await fixture(t);
  f.grant();
  f.poll();
  await f.settle();
  for (const lang of ['en', 'zh'] as const) {
    setLanguage(lang);
    for (const width of [44, 56, 110]) {
      const frame = f.draw(width);
      for (const line of frame.lines) assert.equal(visualLength(line), width);
      const worker = f.board.workers[0];
      const note = f.progress.state().get(worker.id)?.note;
      assert.ok(renderWorkCard(projectWorkCard(worker, f.f.now()), f.state, width, note?.line).length <= 3);
    }
  }
  for (let run = 0; run < 3; run++) {
    for (let i = 0; i < 100; i++) f.draw(110, 30);
    const samples: number[] = [];
    for (let i = 0; i < 300; i++) {
      const start = performance.now();
      f.draw(110, 30);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    console.log(
      'P3B unchanged render',
      JSON.stringify({ run, p50: samples[149], p95: samples[284], p99: samples[296], max: samples[299] })
    );
    assert.ok(samples[284] <= 2, `unchanged p95 ${samples[284]}ms`);
  }
});
