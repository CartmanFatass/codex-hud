import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import installRoleExtension, {
  WorkerSession,
  type WorkerAPI,
  type WorkerClock,
  type WorkerContext,
} from '../../src/harness/pi/role-extension.js';
import { askQuestion } from '../../src/roles/pi-owned/qa.js';
import {
  QA_WAIT_MS,
  QA_TIMEOUT_TEXT,
  ROLE_TOOLS,
  type SlotContract,
  type ContractContext,
} from '../../src/roles/pi-owned/contracts.js';
import { reserveHelper } from '../../src/roles/pi-owned/lifecycle.js';
import { reviewTaskText } from '../../src/roles/pi-owned/helpers.js';
import { guardTool } from '../../src/roles/pi-owned/guard.js';
import { autocloseEligible } from '../../src/roles/pi-owned/reap-main.js';
import type { DispatchStatus } from '../../src/roles/pi-dispatch-status.js';
import type { RuntimeOptions } from '../../src/roles/pi-owned/runtime.js';
test('worker adapter subscribes settlement not agent_end; agent_end followed retry is not completion', () => {
  const names: string[] = [];
  const pi: WorkerAPI = {
    on(name) {
      names.push(name);
    },
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    registerTool() {},
    setActiveTools() {},
    getSettings: () => ({}),
  };
  const mask = process.umask();
  try {
    installRoleExtension(pi);
    assert.equal(names.includes('agent_end'), false);
    assert.equal(names.includes('agent_settled'), true);
  } finally {
    process.umask(mask);
  }
});
function setup(t: TestContext, role: SlotContract['role'] = 'implementer') {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-worker-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(join(root, '.dispatch/primary'), { recursive: true, mode: 0o700 });
  let now = 1000;
  let id = 0;
  const timers = new Map<number, () => void>();
  const time: WorkerClock = {
    now: () => now,
    timer: (cb) => {
      timers.set(++id, cb);
      return id;
    },
    clear: (n) => {
      timers.delete(n as number);
    },
    defer: async () => {},
  };
  const c = {
    task_dir: root,
    cwd: root,
    slot: 'primary',
    role,
    session_id: 'session',
    model: 'synthetic/model',
    effort: 'high',
    output_path: join(root, 'report.md'),
    allowed_write_paths: [join(root, 'report.md')],
    qa_dir: join(root, 'qa'),
  } as SlotContract;
  const context = { jobDirectory: root, cwd: root, release: { id: 'test', root, resources: {} } } as ContractContext;
  const options = {
    env: {},
    callerTabId: 'caller',
    endpoint: { socketPath: join(root, 'socket'), server: {} },
  } as RuntimeOptions;
  let shuts = 0;
  let attempts = 0;
  let aborted = 0;
  let pending = false;
  let idle = true;
  const ctx: WorkerContext = {
    cwd: root,
    model: { provider: 'synthetic', id: 'model', promptCache: { short: 30 } },
    thinkingLevel: 'high',
    sessionManager: {
      getSessionId: () => 'session',
      getSessionFile: () => join(root, 'session.jsonl'),
      getHeader: () => ({ type: 'session', id: 'session', cwd: root }),
    },
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    abort: () => {
      aborted++;
    },
    shutdown: () => {
      shuts++;
    },
  };
  const settings = { cacheWarming: 'streaming', cacheRetention: 'short' };
  const pi: WorkerAPI = {
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    on() {},
    registerTool() {},
    setActiveTools() {},
    getSettings: () => settings,
  };
  const worker = new WorkerSession(c, context, options, pi, time, async (_c, o) => {
    if (!o.keepTab) attempts++;
    return !o.keepTab;
  });
  worker.status.session_file = ctx.sessionManager.getSessionFile();
  worker.publish();
  const write = (text = 'changed output') => fs.writeFileSync(c.output_path, text, { mode: 0o600 });
  const fire = async () => {
    const callbacks = [...timers.values()];
    timers.clear();
    for (const cb of callbacks) cb();
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    root,
    c,
    worker,
    ctx,
    write,
    settings,
    options,
    timers,
    fire,
    time,
    setNow: (n: number) => {
      now = n;
    },
    get shuts() {
      return shuts;
    },
    get attempts() {
      return attempts;
    },
    get aborted() {
      return aborted;
    },
    setPending: (b: boolean) => {
      pending = b;
    },
    setIdle: (b: boolean) => {
      idle = b;
    },
  };
}
test('worker settlement: only settled, retries and queued work do not complete', async (t) => {
  const f = setup(t);
  f.worker.begin(f.ctx);
  f.write();
  f.worker.message({ message: { role: 'assistant', stopReason: 'error' } });
  assert.equal(f.worker.status.state, 'working'); // agent_end is not an adapter completion hook.
  f.worker.message({ message: { role: 'assistant', stopReason: 'stop' } });
  f.setPending(true);
  await f.worker.settle({}, f.ctx);
  assert.equal(f.worker.status.state, 'working');
  f.setPending(false);
  f.setIdle(false);
  await f.worker.settle({}, f.ctx);
  assert.equal(f.worker.status.state, 'working');
  f.setIdle(true);
  await f.worker.settle({}, f.ctx);
  assert.equal(f.worker.status.state, 'idle_grace');
  assert.equal(f.worker.status.output_written, true);
});
for (const kind of ['missing', 'empty', 'unchanged', 'aborted', 'error'] as const)
  test(`worker settlement refuses ${kind} output/final outcome`, async (t) => {
    const f = setup(t, 'sonic');
    if (kind === 'unchanged') f.write('same');
    f.worker.begin(f.ctx);
    if (kind === 'empty') f.write(' \n');
    else if (!['missing', 'unchanged'].includes(kind)) f.write();
    if (kind === 'error') f.worker.message({ message: { role: 'assistant', stopReason: 'error' } });
    await f.worker.settle({ aborted: kind === 'aborted' }, f.ctx);
    assert.equal(f.worker.status.state, 'failed');
    assert.equal(f.attempts, 0);
  });
test('worker settlement generation change during deferral fences old result', async (t) => {
  const f = setup(t);
  let resume!: () => void;
  f.time.defer = () =>
    new Promise<void>((r) => {
      resume = r;
    });
  f.worker.begin(f.ctx);
  f.write();
  const settled = f.worker.settle({}, f.ctx);
  f.worker.begin(f.ctx);
  resume();
  await settled;
  assert.equal(f.worker.status.state, 'working');
  assert.equal(f.timers.size, 0);
});
test('worker grace early timer, shorter TTL never extends and unused expiry autocloses once', async (t) => {
  const f = setup(t);
  f.worker.begin(f.ctx);
  f.write();
  await f.worker.settle({}, f.ctx);
  assert.equal(f.worker.status.idle_deadline_at, new Date(31_000).toISOString());
  await f.fire();
  assert.equal(f.worker.status.state, 'idle_grace');
  assert.equal(f.timers.size, 1);
  f.ctx.model!.promptCache!.short = 5;
  f.worker.modelChanged(f.ctx);
  assert.equal(f.worker.status.idle_deadline_at, new Date(6000).toISOString());
  f.ctx.model!.promptCache!.short = 60;
  f.worker.modelChanged(f.ctx);
  assert.equal(f.worker.status.idle_deadline_at, new Date(6000).toISOString());
  f.setNow(6000);
  await f.fire();
  assert.equal(f.worker.status.exit_reason, 'idle_grace_expired');
  assert.equal(f.attempts, 1);
  await f.fire();
  assert.equal(f.attempts, 1);
});
test('worker unknown TTL is zero; continuation cancels generation timer and never auto attempts after use', async (t) => {
  const f = setup(t);
  f.ctx.model!.promptCache = undefined;
  f.worker.begin(f.ctx);
  f.write();
  await f.worker.settle({}, f.ctx);
  assert.equal(f.worker.status.idle_deadline_at, new Date(1000).toISOString());
  f.worker.begin(f.ctx);
  assert.equal(f.timers.size, 0);
  f.write('continuation output');
  await f.worker.settle({}, f.ctx);
  await f.fire();
  assert.equal(f.worker.status.exit_reason, 'idle_grace_expired_used');
  assert.equal(f.attempts, 0);
});
test('worker quit during grace keeps tab; shutdown while working fails; keep-tab suppresses attempt', async (t) => {
  const f = setup(t);
  f.worker.begin(f.ctx);
  f.write();
  await f.worker.settle({}, f.ctx);
  await f.worker.shutdown(f.ctx, 'quit');
  assert.equal(f.worker.status.state, 'closed');
  assert.equal(f.worker.status.exit_reason, 'shutdown_quit');
  assert.equal(f.attempts, 0);
  await f.fire();
  assert.equal(f.attempts, 0);
  const g = setup(t);
  g.worker.begin(g.ctx);
  await g.worker.shutdown(g.ctx, 'quit');
  assert.equal(g.worker.status.state, 'failed');
  assert.equal(g.attempts, 0);
  const h = setup(t);
  h.options.env.HUD_KEEP_TAB = '1';
  h.worker.begin(h.ctx);
  h.write();
  await h.worker.settle({}, h.ctx);
  h.setNow(31_000);
  await h.fire();
  assert.equal(h.attempts, 0);
});
test('implementer autoclose eligibility excludes quit during grace, used continuation and failure', (t) => {
  const f = setup(t);
  const status: DispatchStatus = {
    ...f.worker.status,
    state: 'closed',
    output_written: true,
    settled_at: new Date(0).toISOString(),
    error: null,
    exit_reason: 'idle_grace_expired',
  };
  assert.equal(autocloseEligible(f.c, status), true);
  for (const exit_reason of ['shutdown_quit', 'shutdown_reload', 'idle_grace_expired_used'])
    assert.equal(autocloseEligible(f.c, { ...status, exit_reason }), false);
  assert.equal(autocloseEligible(f.c, { ...status, state: 'failed' }), false);
  assert.equal(autocloseEligible(f.c, { ...status, output_written: false }), false);
});
test('worker multiple outstanding QA calls block final settlement and abort cancels both', async (t) => {
  const f = setup(t);
  f.worker.begin(f.ctx);
  f.write();
  const a = new AbortController();
  const b = new AbortController();
  const questions = [
    f.worker.ask({ question: 'a', default: 'stop' }, a.signal),
    f.worker.ask({ question: 'b', default: 'stop' }, b.signal),
  ];
  await f.worker.settle({}, f.ctx);
  assert.equal(f.worker.status.state, 'waiting_orchestrator');
  a.abort();
  await questions[0];
  assert.equal(f.worker.status.state, 'waiting_orchestrator');
  b.abort();
  await questions[1];
  await f.worker.settle({}, f.ctx);
  assert.equal(f.worker.status.state, 'idle_grace');
});
test('worker execute-time sonic helper eligibility fails even with accidental activation', async (t) => {
  const f = setup(t, 'sonic');
  await assert.rejects(f.worker.helper({ kind: 'sonic', brief_path: 'ignored' }), /helper_ineligible/);
  const g = setup(t, 'reviewer');
  await assert.rejects(g.worker.helper({ kind: 'reviewer' }), /helper_ineligible/);
});
test('worker warming admission budgets, native-disabled, helper priority, no lifetime extension', async (t) => {
  const f = setup(t);
  f.worker.begin(f.ctx);
  f.worker.status.helper_pending = { kind: 'review', n: 1, status_file: 'test' };
  assert.deepEqual(f.worker.warm({ warmCost: 0.2, action: 'stop' }), { action: 'warm' });
  assert.deepEqual(f.worker.warm({ warmCost: 0.3, action: 'warm' }), { action: 'warm' });
  assert.deepEqual(f.worker.warm({ warmCost: 0, action: 'warm' }), { action: 'stop' });
  for (const invalid of [NaN, Infinity, -1])
    assert.deepEqual(f.worker.warm({ warmCost: invalid, action: 'warm' }), { action: 'stop' });
  const g = setup(t);
  g.worker.status.helper_pending = { kind: 'sonic', n: 1, status_file: 'test' };
  g.settings.cacheWarming = 'off';
  assert.deepEqual(g.worker.warm({ warmCost: 0, action: 'warm' }), { action: 'stop' });
  const h = setup(t);
  h.worker.begin(h.ctx);
  h.write();
  await h.worker.settle({}, h.ctx);
  const deadline = h.worker.status.idle_deadline_at;
  assert.deepEqual(h.worker.warm({ warmCost: 0.01, action: 'warm' }), { action: 'stop' });
  assert.equal(h.worker.status.idle_deadline_at, deadline);
});
test('worker closed generation refuses a new provider/tool admission while shutdown/reaper is pending', async (t) => {
  const f = setup(t, 'sonic');
  f.worker.begin(f.ctx);
  f.write();
  await f.worker.settle({}, f.ctx);
  assert.equal(f.worker.status.state, 'closed');
  assert.equal(f.worker.matches(f.ctx), false);
  f.worker.begin(f.ctx);
  assert.equal(f.aborted, 1);
  assert.equal(f.worker.status.state, 'closed');
  assert.equal(f.attempts, 1);
});
test('worker STATUS writes only semantic change; unchanged publish/read does not replace inode', (t) => {
  const f = setup(t);
  const before = fs.statSync(f.worker.statusFile, { bigint: true });
  for (let n = 0; n < 100; n++) {
    f.setNow(2000 + n);
    f.worker.publish();
    fs.readFileSync(f.worker.statusFile);
  }
  const after = fs.statSync(f.worker.statusFile, { bigint: true });
  assert.equal(before.ino, after.ino);
  assert.equal(before.mtimeNs, after.mtimeNs);
  f.worker.begin(f.ctx); // same semantic working state, no artificial timestamp update.
  assert.equal(fs.statSync(f.worker.statusFile, { bigint: true }).ino, before.ino);
});
test('every non-sonic slot can reserve sonic; sonic never gets helper tools; reviewer implementer only', () => {
  const state = { sonicCalls: 0, reviewRounds: 0, active: false };
  for (const [role, slot] of [
    ['implementer', 'primary'],
    ['reviewer', 'primary'],
    ['architect', 'primary'],
    ['reviewer', 'review-1'],
  ] as const) {
    assert.equal(reserveHelper(role, slot, 'sonic', state).sonicCalls, 1);
    assert.match(ROLE_TOOLS[role], /call_sonic/);
  }
  assert.doesNotMatch(ROLE_TOOLS.sonic, /call_sonic|call_reviewer/);
  for (const role of ['sonic', 'reviewer', 'architect'] as const)
    assert.throws(() => reserveHelper(role, 'primary', 'reviewer', state), /helper_ineligible/);
  assert.throws(() => reserveHelper('sonic', 'sonic-1', 'sonic', state), /helper_ineligible/);
  assert.throws(() => reserveHelper('reviewer', 'review-1', 'sonic', { ...state, sonicCalls: 10 }), /helper_limit/);
});
test('review brief separates full-suite evidence and focused reruns by round', (t) => {
  const f = setup(t);
  for (const n of [1, 2, 3]) {
    const text = reviewTaskText(f.root, f.c, 'HEAD', n);
    assert.match(text, /do not rerun the full suites in any round/);
    assert.match(text, /orchestrator reruns the full gate/);
    assert.match(text, /exit=<code>/);
    assert.match(
      text,
      /Focused-check logs: a missing, failing, or older-than-the-newest-changed-file focused log counts as not run; rerun that focused check yourself/
    );
    assert.doesNotMatch(text, /log counts as not run: run that check yourself/);
    assert.match(text, /other focused or diagnostic checks.*never full suites/);
    if (n === 1) {
      assert.match(
        text,
        /Round 1: report missing, failing or stale full-suite evidence as a finding; never rerun those full suites/
      );
      assert.match(text, /Run the focused tests for the changed code/);
      assert.doesNotMatch(text, /full-suite logs after fixes are expected/);
    } else {
      assert.match(
        text,
        new RegExp(`Round ${n}: stale full-suite logs after fixes are expected; note them, never rerun full suites`)
      );
      assert.match(
        text,
        /Run regression tests for earlier findings plus focused tests for files changed since the previous review/
      );
      assert.ok(text.includes(join(f.root, `review-${n - 1}.md`)));
      assert.doesNotMatch(text, /full-suite evidence as a finding/);
    }
  }
});
test('read-only sonic guard may write only own report and inherited exceptions', (t) => {
  const f = setup(t, 'sonic');
  const guard = {
    role: 'reviewer' as const,
    cwd: f.root,
    allowedWritePaths: [f.c.output_path],
    qaDirectory: f.c.qa_dir,
    temporaryDirectory: join(f.root, 'scratch'),
  };
  assert.equal(guardTool(guard, 'edit', { path: f.c.output_path }).allowed, false);
  assert.equal(guardTool(guard, 'write', { path: f.c.output_path }).allowed, true);
  assert.equal(guardTool(guard, 'write', { path: join(f.root, 'code.ts') }).allowed, false);
});
test('QA actual files: competing writers, gaps, answer-only; polls stop on answer and abort', async (t) => {
  const f = setup(t);
  fs.mkdirSync(f.c.qa_dir, { mode: 0o700 });
  fs.writeFileSync(join(f.c.qa_dir, 'q2.answer.md'), 'old', { mode: 0o600 });
  const controllers = [new AbortController(), new AbortController()];
  let polls = 0;
  const calls = controllers.map((c, n) =>
    askQuestion(
      f.root,
      { question: `question ${n}`, proposedDefault: 'stop' },
      {
        signal: c.signal,
        pause: async () => {
          polls++;
          if (n === 0) {
            fs.writeFileSync(join(f.c.qa_dir, 'q3.answer.md'), 'answer', { mode: 0o600 });
          } else c.abort();
        },
      }
    )
  );
  const answers = await Promise.all(calls);
  assert.deepEqual(answers, [{ kind: 'answered', text: 'answer' }, { kind: 'interrupted' }]);
  assert.equal(polls, 2);
  assert.equal(fs.existsSync(join(f.c.qa_dir, 'q3.md')), true);
  assert.equal(fs.existsSync(join(f.c.qa_dir, 'q4.md')), true);
});
test('QA timeout returns inherited default instruction, not action, and uses fixed 1200 seconds', async (t) => {
  const f = setup(t);
  let now = 0;
  let polls = 0;
  const answer = await askQuestion(
    f.root,
    { question: 'question', proposedDefault: 'keep' },
    {
      now: () => now,
      pause: async (ms) => {
        polls++;
        now += ms;
      },
    }
  );
  assert.deepEqual(answer, { kind: 'timeout', text: QA_TIMEOUT_TEXT });
  assert.equal(now, QA_WAIT_MS);
  assert.equal(polls, 600);
  assert.equal(fs.existsSync(join(f.c.qa_dir, 'q1.answer.md')), false);
});
test('QA stale/empty answers wait; oversized answer refuses; abort wins competing answer', async (t) => {
  const f = setup(t);
  let now = 0;
  const answer = await askQuestion(
    f.root,
    { question: 'q' },
    {
      now: () => now,
      pause: async () => {
        const path = join(f.c.qa_dir, 'q1.answer.md');
        fs.writeFileSync(path, now === 0 ? 'stale' : ' ', { mode: 0o600 });
        fs.utimesSync(path, 0, 0);
        now = QA_WAIT_MS;
      },
    }
  );
  assert.equal(answer.kind, 'timeout');
  await assert.rejects(
    askQuestion(
      f.root,
      { question: 'q' },
      {
        pause: async () => {
          fs.writeFileSync(join(f.c.qa_dir, 'q2.answer.md'), 'x'.repeat(65537), { mode: 0o600 });
        },
      }
    ),
    /file_too_large/
  );
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await askQuestion(f.root, { question: 'q' }, { signal: controller.signal }), {
    kind: 'interrupted',
  });
});
