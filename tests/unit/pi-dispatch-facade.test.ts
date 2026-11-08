import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test, { type TestContext } from 'node:test';
import {
  hudCreate,
  hudRead,
  hudSend,
  hudRespond,
  hudClose,
  waitForJob,
  type FacadeContext,
} from '../../src/roles/facade.js';
import { discoverDispatch, readDispatchSession, dispatchEnv } from '../../src/roles/pi-dispatch.js';
import { runCommand, type HerdrOutcome } from '../../src/roles/herdr-run.js';
import { parseRosterRoot } from '../../src/roles/selection.js';
import { withLock } from '../../src/roles/job-store.js';
import { setTimeout as delay } from 'node:timers/promises';
import { REPO_ROOT } from '../fixtures/paths.js';

const ROUTING = `schema = 1
default_preset = "daily"
[backends.pi]
executor = "herdr"
harness = "pi"
model = "synthetic/model"
effort = "high"
recipe = "pi-role"
[backends.browser]
executor = "jev"
target = "browser"
[jev_decisions.local]
provider = "typesafe"
[presets.daily]
description = "Synthetic preset"
jev_decisions = "local"
[presets.daily.roles]
"oracle.propose" = "pi"
"oracle.converge" = "pi"
imp = "pi"
sonic = "pi"
reviewer = "pi"
jev = "browser"
`;
const OK: HerdrOutcome = {
  ok: true,
  reason: 'ok',
  stdout: '{"result":{"agent":{"agent_status":"idle"}}}',
  stderr: '',
  exitCode: 0,
};
function quote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
function fixture(t: TestContext) {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-dispatch-')));
  const work = join(home, 'work ; $(data) space');
  const bin = join(home, 'bin');
  fs.mkdirSync(work);
  fs.mkdirSync(bin);
  fs.chmodSync(home, 0o700);
  fs.writeFileSync(join(home, 'routing.toml'), ROUTING, { mode: 0o600 });
  const fake = join(REPO_ROOT, 'tests/fakes/pi-dispatch.mjs');
  for (const name of ['pi-dispatch', 'pi-role-reap']) {
    fs.writeFileSync(join(bin, name), `#!/bin/bash\nexec ${quote(process.execPath)} ${quote(fake)} "$@"\n`, {
      mode: 0o755,
    });
  }
  const env: NodeJS.ProcessEnv = {
    PATH: bin,
    HOME: home,
    HUD_HOME: home,
    PI_CODING_AGENT_DIR: join(home, 'pi'),
    PI_ROLES_LEDGER: join(home, 'ledger/runs.jsonl'),
    PI_DISPATCH_LOG: join(home, 'dispatch.log'),
    HERDR_PANE_ID: 'caller-pane',
    PI_ORCHESTRATOR_PANE: 'other-caller',
    PI_ROLE_NOTIFY: 'do-not-call',
    HERDR_WORKSPACE_ID: 'inherited-workspace',
  };
  const calls: string[][] = [];
  const ctx: FacadeContext = {
    home,
    env,
    root: parseRosterRoot('synthetic/main'),
    run: async (argv) => {
      calls.push([...argv]);
      return OK;
    },
  };
  const log = () =>
    fs.existsSync(env.PI_DISPATCH_LOG!)
      ? fs
          .readFileSync(env.PI_DISPATCH_LOG!, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  const create = (key = 'task', extra = {}) =>
    hudCreate(ctx, { role: 'imp', request_key: key, cwd: work, task: 'Synthetic task.\nPreserve scope.', ...extra });
  const dir = (job: unknown) => join(home, 'jobs', String(job));
  const receipt = (job: unknown) => JSON.parse(fs.readFileSync(join(dir(job), 'receipt.json'), 'utf8'));
  const status = (job: unknown, patch: Record<string, unknown>) => {
    const file = join(dir(job), 'STATUS.json');
    const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...prior, ...patch }), { mode: 0o600 });
  };
  const settle = (job: unknown) => {
    fs.writeFileSync(join(dir(job), 'report.md'), 'Verdict: accept\nSynthetic report.\n');
    status(job, {
      state: 'idle_grace',
      output_written: true,
      settled_at: '2026-01-01T00:00:00Z',
      idle_deadline_at: '2099-01-01T00:00:00Z',
    });
  };
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, work, bin, env, ctx, calls, log, create, dir, receipt, status, settle };
}

for (const [role, phase, mapped] of [
  ['imp', undefined, 'implementer'],
  ['sonic', undefined, 'sonic'],
  ['reviewer', undefined, 'reviewer'],
  ['oracle', 'propose', 'architect'],
  ['oracle', 'converge', 'architect'],
]) {
  test(`dispatch facade maps ${role}.${phase ?? ''} with frozen task contract`, async (t) => {
    const f = fixture(t);
    const made = await f.create('role', { role, ...(phase ? { phase } : {}) });
    assert.equal(made.ok, true, JSON.stringify(made));
    const [launch] = f.log();
    assert.equal(launch.argv[0], mapped);
    assert.equal(launch.argv.includes('--split'), role === 'imp');
    assert.equal(launch.work, f.work);
    assert.equal(launch.task, f.dir(made.job));
    assert.equal(launch.output, join(f.dir(made.job), 'report.md'));
    assert.deepEqual(launch.checks, { receipt: true, index: true, association: true, brief: true });
    assert.equal(launch.notify + launch.herdrPane + launch.orchestrator, '');
    assert.equal(launch.argv[launch.argv.indexOf('--model') + 1], 'synthetic/model');
    assert.equal(launch.argv[launch.argv.indexOf('--thinking') + 1], 'high');
    assert.equal(f.calls.length, 0, 'no direct herdr launch or first prompt');
    assert.equal(f.receipt(made.job).pi_dispatch.launch, 'acked');
    assert.equal(made.prompted, true);
    assert.deepEqual(made.executor, {
      kind: 'herdr',
      tab_id: 'tab1',
      pane_id: 'pane1',
      agent: `${made.job}-primary`,
      workspace_id: null,
    });
    assert.equal(f.receipt(made.job).label, `${made.job}-fake`);
    const brief = fs.readFileSync(join(f.dir(made.job), 'brief.md'), 'utf8');
    assert.match(brief, /Write the final artifact/);
    assert.match(brief, new RegExp(`# ${role}`));
    for (const name of ['brief.md', 'receipt.json'])
      assert.equal(fs.statSync(join(f.dir(made.job), name)).mode & 0o777, 0o600);
    assert.equal(made.acceptance, null);
  });
}

test('same-key concurrent creates launch once; changed input conflicts; brief and adapter survive routing removal', async (t) => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.create(), f.create()]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.job, b.job);
  assert.equal(f.log().length, 1);
  assert.equal((await f.create('task', { task: 'different' })).code, 'conflict');
  const brief = fs.readFileSync(join(f.dir(a.job), 'brief.md'), 'utf8');
  fs.unlinkSync(join(f.home, 'routing.toml'));
  fs.unlinkSync(join(f.bin, 'pi-dispatch'));
  const again = await f.create();
  assert.equal(again.ok, true);
  assert.equal(again.job, a.job);
  assert.equal(f.log().length, 1);
  assert.equal(fs.readFileSync(join(f.dir(a.job), 'brief.md'), 'utf8'), brief);
});

for (const mode of ['lost', 'missing-session', 'bad-session']) {
  test(`ambiguous ${mode} dispatch never replays; no false prompt or cleanup claim`, async (t) => {
    const f = fixture(t);
    f.env.PI_DISPATCH_MODE = mode;
    const a = await f.create();
    assert.equal(a.ok, false);
    assert.equal(a.code, 'launch_unknown');
    assert.equal(a.prompted, false);
    assert.equal(f.receipt(a.job).pi_dispatch.launch, 'sent');
    const again = await f.create();
    assert.equal(again.code, 'launch_unknown');
    assert.equal(f.log().length, 1);
    if (mode === 'lost') {
      f.settle(a.job);
      const done = await f.create();
      assert.equal(done.ok, true);
      assert.equal(done.state, 'done');
      assert.equal(done.prompted, false);
      assert.equal((await hudClose(f.ctx, { job: a.job })).ok, true);
    } else {
      const closed = await hudClose(f.ctx, { job: a.job });
      assert.equal(closed.code, 'close_unresolved');
      assert.notEqual(f.receipt(a.job).state, 'closed');
    }
    assert.equal(f.calls.length, 0);
  });
}

test('unreadable and unknown-version discriminators never enter the direct path', async (t) => {
  const f = fixture(t);
  const a = await f.create();
  const r = f.receipt(a.job);
  r.pi_dispatch.contract_version = 2;
  fs.writeFileSync(join(f.dir(a.job), 'receipt.json'), JSON.stringify(r));
  assert.equal((await f.create()).code, 'receipt_unreadable');
  assert.equal((await hudRead(f.ctx, { job: a.job })).code, 'not_found');
  assert.equal(f.calls.length, 0);
  assert.equal(f.log().length, 1);
});

test('list and same-key presentation project live STATUS; unknown snapshots never become DONE', async (t) => {
  const f = fixture(t);
  const a = await f.create();
  f.settle(a.job);
  const list = await hudRead(f.ctx, {});
  assert.equal((list.jobs as { state: string }[])[0]!.state, 'done');
  assert.equal((await f.create()).state, 'done');
  assert.equal((await hudRead(f.ctx, { job: a.job })).report, join(f.dir(a.job), 'report.md'));
  f.status(a.job, { version: 99 });
  assert.equal((await hudRead(f.ctx, { job: a.job })).status, 'unreadable');
  assert.equal((await hudRead(f.ctx, { job: a.job })).report, null);
});

test('dispatch answers primary and helper questions idempotently with stale/empty eligibility and ownership', async (t) => {
  const f = fixture(t);
  const a = await f.create();
  const qa = join(f.dir(a.job), 'qa');
  fs.writeFileSync(join(qa, 'q1.md'), 'Primary question');
  fs.writeFileSync(join(qa, 'q2.md'), 'Helper question');
  fs.writeFileSync(join(qa, 'q1.answer.md'), '');
  f.status(a.job, { state: 'waiting_orchestrator' });
  const read = await hudRead(f.ctx, { job: a.job });
  assert.equal(read.event, 'QUESTION');
  assert.equal((read.pending as unknown[]).length, 2);
  const args = { job: a.job, request_id: 'q1', answer: 'Synthetic answer' };
  assert.equal((await hudRespond(f.ctx, args)).consumed, false);
  assert.equal((await hudRespond(f.ctx, args)).idempotent, true);
  assert.equal((await hudRespond(f.ctx, { ...args, answer: 'Changed answer' })).code, 'conflict');
  const old = new Date('2000-01-01');
  fs.writeFileSync(join(qa, 'q2.answer.md'), 'stale');
  fs.utimesSync(join(qa, 'q2.answer.md'), old, old);
  assert.equal((await hudRespond(f.ctx, { ...args, request_id: 'q2' })).ok, true);
  assert.deepEqual((await hudRead(f.ctx, { job: a.job })).pending, []);
  f.status(a.job, { state: 'working' });
  assert.equal((await hudRead(f.ctx, { job: a.job })).event, undefined);
  const other = { ...f.ctx, root: parseRosterRoot('synthetic/other') };
  assert.equal((await hudRespond(other, args)).code, 'not_found');
  assert.equal((await hudRespond(f.ctx, { ...args, answer: '  ' })).code, 'invalid_arguments');
});

test('maximum-size normalized answers stay eligible, idempotent and conflict-protected', async (t) => {
  const f = fixture(t);
  const a = await f.create();
  const qa = join(f.dir(a.job), 'qa');
  fs.writeFileSync(join(qa, 'q1.md'), 'Synthetic boundary question');
  const args = { job: a.job, request_id: 'q1', answer: 'a'.repeat(16 * 1024) };
  assert.equal((await hudRespond(f.ctx, args)).ok, true);
  assert.equal(fs.statSync(join(qa, 'q1.answer.md')).size, 16 * 1024 + 1);
  assert.deepEqual((await hudRead(f.ctx, { job: a.job })).pending, []);
  assert.equal((await hudRespond(f.ctx, args)).idempotent, true);
  assert.equal((await hudRespond(f.ctx, { ...args, answer: 'different' })).code, 'conflict');
  fs.writeFileSync(join(qa, 'q1.answer.md'), 'b'.repeat(20 * 1024));
  assert.equal(
    (await hudRespond(f.ctx, { ...args, answer: 'must not overwrite unreadable evidence' })).code,
    'conflict'
  );
  assert.equal(fs.statSync(join(qa, 'q1.answer.md')).size, 20 * 1024);
});

test('historical QA files do not end a wait for a later helper', async (t) => {
  const f = fixture(t);
  const a = await f.create();
  fs.writeFileSync(join(f.dir(a.job), 'qa', 'q1.md'), 'Expired question');
  f.status(a.job, { state: 'waiting_helper', helper_pending: { kind: 'sonic', n: 2, status_file: null } });
  const statusFile = join(f.dir(a.job), '.dispatch', 'sonic-2', 'STATUS.json');
  fs.mkdirSync(join(statusFile, '..'), { recursive: true });
  const primary = JSON.parse(fs.readFileSync(join(f.dir(a.job), 'STATUS.json'), 'utf8'));
  fs.writeFileSync(
    statusFile,
    JSON.stringify({
      ...primary,
      role: 'sonic',
      slot: 'sonic-2',
      state: 'working',
      output_path: join(f.dir(a.job), 'sonic-2.md'),
      helper_pending: null,
    })
  );
  const result = await hudRead(f.ctx, { job: a.job, wait_ms: 30 });
  assert.equal(result.event, 'timeout');
  assert.equal((result.pending as unknown[]).length, 1);
  assert.equal((await waitForJob(f.home, f.env, String(a.job), 0)).event, 'timeout');
  fs.writeFileSync(
    statusFile,
    JSON.stringify({
      ...primary,
      role: 'sonic',
      slot: 'sonic-2',
      state: 'waiting_orchestrator',
      output_path: join(f.dir(a.job), 'sonic-2.md'),
      helper_pending: null,
    })
  );
  assert.equal((await hudRead(f.ctx, { job: a.job, wait_ms: 30 })).event, 'QUESTION');
});

test('fix round sends SESSION.PRIMARY once and suppresses old settlement across restart until a fresh timestamp', async (t) => {
  const f = fixture(t);
  const a = await f.create();
  f.settle(a.job);
  const args = { job: a.job, message_key: 'fix-1', text: 'Fix synthetic finding.' };
  const [sent, duplicate] = await Promise.all([hudSend(f.ctx, args), hudSend(f.ctx, args)]);
  assert.equal(sent.ok, true);
  assert.equal(duplicate.idempotent, true);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], ['agent', 'prompt', `${a.job}-primary`, args.text]);
  assert.equal((await hudSend(f.ctx, { ...args, text: 'changed' })).code, 'conflict');
  const restarted = { ...f.ctx };
  const view = await hudRead(restarted, { job: a.job });
  assert.equal(view.state, 'open');
  assert.equal(view.report, null);
  assert.equal(view.event, undefined);
  assert.equal(view.continuation, 'unconfirmed');
  assert.equal((await hudRead(restarted, { job: a.job, wait_ms: 20 })).event, 'timeout');
  f.status(a.job, { settled_at: '2026-01-01T00:00:01Z' });
  const fresh = await hudRead(restarted, { job: a.job });
  assert.equal(fresh.event, 'DONE');
  assert.equal(fresh.state, 'done');
  assert.equal(fresh.acceptance, null);
});

test('same-key recovery reloads after the job lock, preserving a concurrent continuation intent', async (t) => {
  const f = fixture(t);
  const a = await f.create();
  f.settle(a.job);
  let replay: ReturnType<typeof f.create> | undefined;
  await withLock(f.home, `job-${a.job}`, async () => {
    replay = f.create();
    await delay(30); // Recovery has read under the key lock and is queued for this job lock.
    const receipt = f.receipt(a.job);
    receipt.pi_dispatch.continuation = {
      message_key: 'concurrent-fix',
      previous_session_id: 'synthetic-session-1',
      previous_settled_at: '2026-01-01T00:00:00Z',
    };
    fs.writeFileSync(join(f.dir(a.job), 'receipt.json'), JSON.stringify(receipt));
  });
  assert.equal((await replay!).continuation, 'unconfirmed');
  assert.equal(f.receipt(a.job).pi_dispatch.continuation.message_key, 'concurrent-fix');
});

test('unknown fix send never replays; expiry race and one-shot continuation refuse a new DONE', async (t) => {
  const f = fixture(t);
  const a = await f.create();
  f.settle(a.job);
  let sends = 0;
  const ctx = {
    ...f.ctx,
    run: async () => {
      sends++;
      return { ...OK, ok: false, reason: 'timeout' as const };
    },
  };
  const args = { job: a.job, message_key: 'fix', text: 'Repair.' };
  assert.equal((await hudSend(ctx, args)).code, 'send_unknown');
  assert.equal((await hudSend(ctx, args)).code, 'send_unknown');
  assert.equal(sends, 1);
  f.status(a.job, { state: 'closed', ended_at: '2026-01-01T00:01:00Z' });
  const view = await hudRead(f.ctx, { job: a.job });
  assert.equal(view.event, 'BLOCKED');
  assert.equal(view.continuation, 'unavailable');
  assert.equal(view.report, null);
  assert.equal((await hudSend(f.ctx, { ...args, message_key: 'another' })).code, 'continuation_unavailable');
  const shot = await f.create('shot', { role: 'sonic' });
  f.status(shot.job, { state: 'closed', output_written: true, settled_at: '2026-01-01T00:00:00Z' });
  assert.equal((await hudSend(f.ctx, { ...args, job: shot.job })).code, 'continuation_unavailable');
});

test('wait ignores immediate herdr idle and artifact presence; bounded timeout is observation only', async (t) => {
  const f = fixture(t);
  const a = await f.create();
  f.status(a.job, { state: 'waiting_helper', helper_pending: { kind: 'review', n: null, status_file: null } });
  fs.writeFileSync(join(f.dir(a.job), 'report.md'), 'Not settled');
  const started = performance.now();
  const timed = await hudRead(f.ctx, { job: a.job, wait_ms: 40 });
  assert.equal(timed.event, 'timeout');
  assert.ok(performance.now() - started >= 30);
  assert.ok(f.calls.length <= 2);
  assert.equal(f.log().length, 1);
  assert.equal(f.receipt(a.job).state, 'open');
  f.settle(a.job);
  const [one, two] = await Promise.all([
    hudRead(f.ctx, { job: a.job, wait_ms: 50 }),
    hudRead(f.ctx, { job: a.job, wait_ms: 50 }),
  ]);
  assert.equal(one.event, 'DONE');
  assert.equal(two.event, 'DONE');
  assert.equal((await waitForJob(f.home, f.env, String(a.job), 30)).event, 'DONE');
});

test('facade and CLI share event wake; zero CLI timeout is an observation timeout', async (t) => {
  const f = fixture(t);
  const a = await f.create();
  assert.equal((await waitForJob(f.home, f.env, String(a.job), 0)).event, 'timeout');
  const started = performance.now();
  const waiting = hudRead(f.ctx, { job: a.job, wait_ms: 2000 });
  const timer = setTimeout(() => f.settle(a.job), 40);
  t.after(() => clearTimeout(timer));
  assert.equal((await waiting).event, 'DONE');
  assert.ok(performance.now() - started < 800);
  assert.equal(f.calls.length, 1);
});

for (const event of ['FAILED', 'QUESTION', 'BLOCKED']) {
  test(`wait returns actionable ${event}`, async (t) => {
    const f = fixture(t);
    const a = await f.create();
    if (event === 'FAILED') f.status(a.job, { state: 'failed', error: 'synthetic failure' });
    if (event === 'QUESTION') f.status(a.job, { state: 'waiting_orchestrator' });
    const ctx =
      event === 'BLOCKED'
        ? { ...f.ctx, run: async () => ({ ...OK, stdout: '{"result":{"agent_status":"blocked"}}' }) }
        : f.ctx;
    assert.equal((await hudRead(ctx, { job: a.job, wait_ms: 40 })).event, event);
  });
}

for (const settled of [false, true]) {
  test(`explicit reap ${settled ? 'after' : 'before'} settlement preserves artifact and closes once`, async (t) => {
    const f = fixture(t);
    const a = await f.create();
    if (settled) f.settle(a.job);
    const first = await hudClose(f.ctx, { job: a.job });
    const next = await hudClose(f.ctx, { job: a.job });
    assert.equal(first.ok, true);
    assert.equal(first.observation, 'reaped');
    assert.equal(next.idempotent, true);
    assert.equal(f.log().filter((row) => row.bin === 'pi-role-reap').length, 1);
    assert.equal(f.calls.length, 0);
    assert.equal(f.receipt(a.job).state, 'closed');
    assert.equal(JSON.parse(fs.readFileSync(join(f.home, 'assoc', `${a.job}.json`), 'utf8')).closed, true);
    if (settled) assert.equal((await hudRead(f.ctx, { job: a.job })).report, join(f.dir(a.job), 'report.md'));
    assert.equal(
      (await hudSend(f.ctx, { job: a.job, message_key: 'late', text: 'No.' })).code,
      'continuation_unavailable'
    );
  });
}

test('nonzero, missing, and timed-out reapers preserve unresolved cleanup for another explicit attempt', async (t) => {
  const f = fixture(t);
  const a = await f.create();
  f.env.PI_REAP_MODE = 'failed';
  assert.equal((await hudClose(f.ctx, { job: a.job })).code, 'close_unresolved');
  delete f.env.PI_REAP_MODE;
  const reaper = join(f.bin, 'pi-role-reap');
  const saved = fs.readFileSync(reaper, 'utf8');
  fs.unlinkSync(reaper);
  assert.equal((await hudClose(f.ctx, { job: a.job })).code, 'close_unresolved');
  fs.writeFileSync(reaper, '#!/bin/bash\nwhile :; do :; done\n', { mode: 0o755 });
  assert.equal((await hudClose({ ...f.ctx, herdrBudgetMs: 30 }, { job: a.job })).code, 'close_unresolved');
  assert.notEqual(f.receipt(a.job).state, 'closed');
  fs.writeFileSync(reaper, saved, { mode: 0o755 });
  assert.equal((await hudClose(f.ctx, { job: a.job })).ok, true);
});

test('send-close serialize on the job lock and close-first cannot prompt', async (t) => {
  const f = fixture(t);
  const a = await f.create();
  f.settle(a.job);
  const [closed, sent] = await Promise.all([
    hudClose(f.ctx, { job: a.job }),
    hudSend(f.ctx, { job: a.job, message_key: 'fix', text: 'Fix.' }),
  ]);
  assert.equal(closed.ok, true);
  // Whichever call wins the lock is legal; nothing can be sent after the reaper.
  if (sent.ok) assert.equal(f.calls.length, 1);
  else assert.equal(f.calls.length, 0);
  assert.equal(
    (await hudSend(f.ctx, { job: a.job, message_key: 'later', text: 'Fix later.' })).code,
    'continuation_unavailable'
  );
});

test('discovery absent versus broken pair, symlink pinning, and env refusal before launch receipt', async (t) => {
  const f = fixture(t);
  fs.unlinkSync(join(f.bin, 'pi-dispatch'));
  assert.equal(discoverDispatch(f.env, 'imp'), null);
  fs.symlinkSync(join(f.bin, 'missing'), join(f.bin, 'pi-dispatch'));
  assert.throws(() => discoverDispatch(f.env, 'imp'), /dispatch_unavailable/);
  fs.unlinkSync(join(f.bin, 'pi-dispatch'));
  const target = join(f.bin, 'real-dispatch');
  fs.writeFileSync(target, '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  fs.symlinkSync(target, join(f.bin, 'pi-dispatch'));
  assert.equal(discoverDispatch(f.env, 'imp')!.executable, target);
  fs.unlinkSync(join(f.bin, 'pi-role-reap'));
  assert.equal((await f.create()).code, 'dispatch_reaper_missing');
  fs.writeFileSync(join(f.bin, 'pi-role-reap'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(
    join(f.home, 'routing.toml'),
    ROUTING.replace('recipe = "pi-role"', 'recipe = "pi-role"\nenv_profile = "account"') +
      '\n[env_profiles.account]\nCODEX_HOME = "/tmp/synthetic-account"\n'
  );
  assert.equal((await f.create()).code, 'dispatch_env_unsupported');
  assert.equal(fs.readdirSync(join(f.home, 'jobs')).filter((name) => /^j[a-f0-9]{16}$/.test(name)).length, 0);
  assert.equal(f.log().length, 0);
  assert.equal(f.calls.length, 0);
});

test('mixed old/new receipts do not change adapters when dispatch is installed', async (t) => {
  const f = fixture(t);
  const a = await f.create();
  const r = f.receipt(a.job);
  delete r.pi_dispatch;
  fs.writeFileSync(join(f.dir(a.job), 'receipt.json'), JSON.stringify(r));
  const old = await f.create();
  assert.equal(old.ok, true);
  assert.equal(old.dispatch, undefined);
  assert.equal(f.log().length, 1);
  assert.equal(f.receipt(a.job).pi_dispatch, undefined);
  const fresh = await f.create('new');
  assert.equal(fresh.ok, true);
  assert.ok(f.receipt(fresh.job).pi_dispatch);
  assert.equal(fs.existsSync(f.env.PI_ROLES_LEDGER!), false);
  assert.equal(fs.existsSync(join(f.dir(fresh.job), 'STATUS.json.ledger-recorded')), false);
});

test('SESSION is bounded data with first-equals splitting; malformed newlines are refused', async (t) => {
  const f = fixture(t);
  const a = await f.create();
  const file = join(f.dir(a.job), 'SESSION.txt');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace('BASE=HEAD', 'BASE=value=still-data'));
  assert.equal(readDispatchSession(f.dir(a.job))!.BASE, 'value=still-data');
  fs.writeFileSync(file, original + 'RIGHT=pane3\nRIGHT_SPLIT=1\n');
  assert.equal(readDispatchSession(f.dir(a.job))!.RIGHT, 'pane3', 'upstream helper pane replacement appends RIGHT');
  for (const text of [
    original + 'not key-value\n',
    original + 'TAB=duplicate\n',
    original.replace('TAB=tab1', 'TAB=tab1\rjunk'),
    'x'.repeat(20000),
  ]) {
    fs.writeFileSync(file, text);
    assert.equal(readDispatchSession(f.dir(a.job)), null);
  }
  const clean = dispatchEnv(f.env);
  assert.equal(clean.HERDR_ENV, '1');
  assert.equal(clean.HERDR_WORKSPACE_ID, 'inherited-workspace');
  assert.equal(clean.HERDR_PANE_ID, undefined);
  assert.equal(f.env.HERDR_PANE_ID, 'caller-pane');
});

test('launch intent survives command timeout and runner returns even when a descendant holds a pipe', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    join(f.bin, 'pi-dispatch'),
    `#!${process.execPath}\nimport {spawn} from 'node:child_process';\nspawn(${JSON.stringify(process.execPath)}, ['-e','setTimeout(()=>{},2000)'], {stdio:['ignore',1,2]}).unref();\nsetTimeout(()=>{},2000);\n`,
    { mode: 0o755 }
  );
  const started = performance.now();
  const result = await hudCreate(
    { ...f.ctx, herdrBudgetMs: 40 },
    { role: 'imp', request_key: 'timeout', task: 'Synthetic timeout.', cwd: f.work }
  );
  assert.equal(result.code, 'launch_unknown');
  assert.equal(f.receipt(result.job).pi_dispatch.launch, 'sent');
  // Direct runner seam tests the retained-pipe timeout without starting any harness.
  const outcome = await runCommand(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {spawn} from 'node:child_process'; spawn(process.execPath,['-e','setTimeout(()=>{},500)'],{stdio:['ignore',1,2]}).unref(); setTimeout(()=>{},1000)`,
    ],
    f.env,
    { budgetMs: 60 }
  );
  assert.equal(outcome.reason, 'timeout');
  assert.ok(performance.now() - started < 1500);
});
