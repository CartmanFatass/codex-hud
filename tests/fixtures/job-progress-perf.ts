import { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { r5Fixture, ROOT_R5 } from './r5-jobs.js';
import { PanelJobPipeline } from '../../src/tree-page.js';
import { SmallModel } from '../../src/collectors/small-model.js';
import { JobProgress } from '../../src/collectors/job-progress.js';
import { JobMaterialAuthority, jobReadBudget, type JobReadBudget } from '../../src/core/materials/job.js';
import { DerivedMaterialStore } from '../../src/core/materials/derived.js';
import { initialMonitorState, renderMonitor } from '../../src/render/monitor.js';

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
export { tick, response, defaultReply, fixture };
