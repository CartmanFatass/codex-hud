import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PanelJobPipeline } from '../../dist-test/src/tree-page.js';
import { NativeCallCollector } from '../../dist-test/src/collectors/native-calls.js';
import {
  createAdaptivePollState,
  recordAdaptivePoll,
  adaptivePollDue,
  forceAdaptivePoll,
} from '../../dist-test/src/collectors/adaptive-poll.js';

const tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date() };
function fixture(t, count = 1) {
  const root = mkdtempSync(join(tmpdir(), 'hud-backoff-test-'));
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    HUD_HOME: join(root, 'hud'),
    CODEX_HOME: join(root, 'codex'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    PI_CODING_AGENT_DIR: join(root, 'pi'),
    HERDR_SOCKET_PATH: join(root, 'absent.sock'),
    TZ: 'UTC',
    CODEX_HUD_CWD: join(root, 'project'),
    CODEX_HUD_STANDALONE_PANEL: '1',
    CODEX_HUD_PANEL_ALL_DELEGATIONS: '1',
    HUD_PANEL_CALLER_PANE: 'w4E:p1',
  };
  for (const k of ['HOME', 'HUD_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'CODEX_HUD_CWD'])
    mkdirSync(env[k], { recursive: true });
  const put = (p, v) => {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v));
  };
  put(join(env.HUD_HOME, 'hud-settings.json'), { modelEnabled: false, refreshMs: 1000, language: 'en', theme: 'none' });
  mkdirSync(join(env.HUD_HOME, 'jobs'), { recursive: true });
  const dir = join(env.HUD_HOME, 'jobs', 'j0000000000000000');
  for (let i = 0; i < count; i++) {
    const id = 'j' + i.toString(16).padStart(16, '0'),
      d = join(env.HUD_HOME, 'jobs', id);
    put(join(d, 'job.json'), {
      job: id,
      role: 'imp',
      herdr_pane: 'w4E:p1',
      created_at: new Date(1000 + i).toISOString(),
    });
    put(join(d, 'STATUS.json'), { state: 'done', settled_at: new Date().toISOString() });
    put(join(d, 'brief.md'), '# SYNTHETIC: backoff');
  }
  const pipeline = new PanelJobPipeline(env.HUD_HOME, null, { live: false }, null, {
    project: null,
    pane: 'w4E:p1',
  }, Date.now() - 60000);
  t.after(() => {
    pipeline.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  const observe = async (nativeQuiet = true) => {
    await pipeline.refresh();
    return pipeline.observation(tree, null, nativeQuiet);
  };
  const cadence = async (nativeQuiet = true) => {
    let state = createAdaptivePollState(1000);
    for (let i = 0; i < 12; i++)
      state = recordAdaptivePoll(state, {
        scopeKey: 'w4E:p1',
        nowMs: i * 5000,
        ...(await observe(nativeQuiet)),
      });
    return state;
  };
  return { root, env, dir, put, pipeline, observe, cadence };
}

test('completely observed empty and settled job scopes reach the existing 5s maximum; changes reset it', async (t) => {
  for (const count of [0, 1]) {
    const f = fixture(t, count);
    const state = await f.cadence();
    assert.equal(state.intervalMs, 5000);
    assert.equal(adaptivePollDue(state, 'w4E:p1', state.nextDueAt - 1), false);
    assert.equal(adaptivePollDue(state, 'w4E:p1', state.nextDueAt), true);
    assert.equal(forceAdaptivePoll(state).intervalMs, 1000);
    if (count) {
      f.put(join(f.dir, 'STATUS.json'), { state: 'closed', settled_at: new Date(100000).toISOString() });
      assert.equal(
        recordAdaptivePoll(state, { scopeKey: 'w4E:p1', nowMs: state.nextDueAt, ...(await f.observe()) })
          .intervalMs,
        1000
      );
    }
  }
});

test('working jobs, unanswered questions, failed reads, missing evidence and uncertain native coverage stay at base', async (t) => {
  for (const variant of ['working', 'question', 'failed-read', 'missing-status', 'native', 'native-content', 'cap']) {
    await t.test(variant, async (t) => {
      const f = fixture(t, variant === 'cap' ? 201 : 1);
      let nativeQuiet = true;
      if (variant === 'working') f.put(join(f.dir, 'STATUS.json'), { state: 'working' });
      if (variant === 'question') f.put(join(f.dir, 'qa/q1.md'), '# Question\n\nSynthetic pending?');
      if (variant === 'failed-read') {
        rmSync(join(f.dir, 'STATUS.json'));
        mkdirSync(join(f.dir, 'STATUS.json'));
      }
      if (variant === 'missing-status') rmSync(join(f.dir, 'STATUS.json'));
      if (variant.startsWith('native')) {
        const collector = new NativeCallCollector(f.env.HUD_HOME);
        assert.equal(collector.emptyAndComplete, false, 'unobserved is not idle');
        await collector.collect();
        assert.equal(collector.emptyAndComplete, true, 'successfully observed empty native scope');
        await collector.collectCodex(undefined, f.env.CODEX_HOME);
        assert.equal(collector.emptyAndComplete, false, 'skipped native coverage is not idle');
        const relations = join(f.env.HUD_HOME, 'native-relations');
        mkdirSync(relations, { mode: variant === 'native' ? 0o755 : 0o700 });
        if (variant === 'native-content') {
          await collector.collect();
          assert.equal(collector.emptyAndComplete, true, 'physically empty native directory is complete');
          for (let i = 0; i < 513; i++) f.put(join(relations, `ignored-${i}.txt`), 'synthetic');
        }
        await collector.collect();
        nativeQuiet = collector.emptyAndComplete;
        assert.equal(nativeQuiet, false, 'failed native collection with no retained rows is uncertain');
      }
      assert.equal((await f.cadence(nativeQuiet)).intervalMs, 1000);
      assert.equal(
        (await f.observe(nativeQuiet)).fingerprint,
        undefined,
        'nonquiet polls do not serialize board history'
      );
    });
  }
});

function live(t, f) {
  const runner = join(f.root, 'runner.mjs');
  const module = (name) => pathToFileURL(resolve('dist-test/src/' + name + '.js')).href;
  // Delay, never replace, one actual collection to exercise force-during-await.
  f.put(
    runner,
    `import {runLivePage,PanelJobPipeline} from ${JSON.stringify(module('tree-page'))};
import {ProfileRecorder,useProfileRecorder} from ${JSON.stringify(module('utils/profile'))};
let gate=false,release;const original=PanelJobPipeline.prototype.refresh;
PanelJobPipeline.prototype.refresh=async function(...args){if(gate){gate=false;process.send({type:'waiting'});await new Promise(r=>release=r);}return original.apply(this,args);};
process.on('message',m=>{if(m==='gate')gate=true;if(m==='release')release?.();});
const r=new ProfileRecorder('panel',()=>{});r.record=(stage)=>{if(stage==='collect')process.send({type:'collected',at:Date.now()});};useProfileRecorder(r);
await runLivePage();process.exit(0);`
  );
  const child = spawn(process.execPath, [runner], {
    cwd: f.env.CODEX_HUD_CWD,
    env: f.env,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  let output = '',
    stderr = '';
  const events = [];
  child.stdout.on('data', (b) => (output += b.toString()));
  child.stderr.on('data', (b) => (stderr += b.toString()));
  child.on('message', (m) => events.push(m));
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
    }
  });
  const until = async (condition, ms = 15000) => {
    const end = Date.now() + ms;
    while (!condition() && Date.now() < end && child.exitCode === null) await new Promise((r) => setTimeout(r, 5));
    assert.ok(condition(), `condition timed out; stderr=${stderr}`);
  };
  const collections = () => events.filter((e) => e.type === 'collected');
  return { child, events, until, collections, output: () => output };
}

test('live working and capped scopes retain the original nonquiet base-tick timing', { timeout: 12000 }, async (t) => {
  await Promise.all(
    [1, 201].map(async (count) => {
      const f = fixture(t, count);
      if (count === 1) f.put(join(f.dir, 'STATUS.json'), { state: 'working' });
      const p = live(t, f);
      await p.until(() => p.collections().length >= 4, 10000);
      const times = p.collections().map((e) => e.at);
      for (let i = 1; i < times.length; i++) {
        const gap = times[i] - times[i - 1];
        assert.ok(gap >= 1800 && gap < 2600, `${count === 1 ? 'working' : 'capped'} base interval: ${gap}ms`);
      }
    })
  );
});

test(
  'live panel: input wakes immediately, force during await is retained, and a new question appears within 5s',
  { timeout: 35000 },
  async (t) => {
    await Promise.all([
      (async () => {
        const f = fixture(t),
          p = live(t, f);
        await p.until(() => p.collections().length >= 5);
        assert.ok(
          p.collections().at(-1).at - p.collections().at(-2).at >= 3900,
          'quiet curve reached max after base-grid observations, then 2s and 4s'
        );
        p.child.send('gate');
        const start = Date.now();
        p.child.stdin.write('a');
        await p.until(() => p.events.some((e) => e.type === 'waiting'), 1000);
        assert.ok(Date.now() - start < 1000, 'input started collection without waiting for the backed-off timer');
        p.child.stdin.write('a');
        await new Promise((r) => setTimeout(r, 50));
        p.child.send('release');
        await p.until(() => p.collections().length >= 7, 1000);
        assert.ok(
          p.collections().at(-1).at - p.collections().at(-2).at < 500,
          'second forced collection was not lost during await'
        );
      })(),
      (async () => {
        const f = fixture(t),
          p = live(t, f);
        await p.until(() => p.collections().length >= 7, 22000);
        const gap = p.collections().at(-1).at - p.collections().at(-2).at;
        assert.ok(gap >= 4900 && gap < 5500, `continued polling at max interval: ${gap}ms`);
        const start = Date.now(),
          beforeQuestion = p.collections().length;
        f.put(join(f.dir, 'STATUS.json'), { state: 'working' });
        f.put(join(f.dir, 'qa/q1.md'), '# Question\n\nSYNTHETIC_BACKOFF_QUESTION?\n\nDefault if unanswered: yes\n');
        await p.until(() => p.output().includes('SYNTHETIC_BACKOFF_QUESTION'), 5500);
        const elapsed = Date.now() - start;
        assert.ok(
          elapsed >= 4500 && elapsed <= 5500,
          `visible after one 5s interval plus collection/scheduler overhead: ${elapsed}ms`
        );
        await p.until(() => p.collections().length >= beforeQuestion + 2, 2600);
        const baseGap = p.collections().at(-1).at - p.collections().at(-2).at;
        assert.ok(
          baseGap >= 1800 && baseGap < 2600,
          `question/working job restores original base-grid cadence: ${baseGap}ms`
        );
      })(),
    ]);
  }
);
