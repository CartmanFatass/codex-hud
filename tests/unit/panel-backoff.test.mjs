import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PanelJobPipeline } from '../../dist/tree-page.js';
import { makeSourceId } from '../../dist/core/identity.js';
import {
  createAdaptivePollState,
  recordAdaptivePoll,
  adaptivePollDue,
  forceAdaptivePoll,
} from '../../dist/collectors/adaptive-poll.js';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

const LIVE_BASE_MS = 200;
const LIVE_MAX_MS = 5 * LIVE_BASE_MS;
// The next base tick waits one interval, then aligns to the grid. Measure at
// its start so slower collection work is not mistaken for extra backoff.
function assertBaseCadence(previous, next, label) {
  const gap = next.startedAt - previous.at;
  assert.ok(gap >= LIVE_BASE_MS * 0.98 && gap < LIVE_BASE_MS * 2.6, `${label}: ${gap}ms`);
}
const tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date() };
function fixture(t, count = 1, refreshMs = 1000) {
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
    HUD_PANEL_CALLER_PANE: 'w4E:p1',
  };
  for (const k of ['HOME', 'HUD_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'CODEX_HUD_CWD'])
    mkdirSync(env[k], { recursive: true });
  const put = (p, v) => {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFixtureFile(p, typeof v === 'string' ? v : JSON.stringify(v));
  };
  put(join(env.HUD_HOME, 'hud-settings.json'), { modelEnabled: false, refreshMs, language: 'en', theme: 'none' });
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
  const pipeline = new PanelJobPipeline(env.HUD_HOME, {
    project: null,
    pane: 'w4E:p1',
  }, Date.now() - 60000);
  t.after(() => {
    pipeline.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  const observe = async () => {
    await pipeline.refresh();
    return pipeline.observation(tree, true);
  };
  const cadence = async () => {
    let state = createAdaptivePollState(1000);
    for (let i = 0; i < 12; i++)
      state = recordAdaptivePoll(state, {
        scopeKey: 'w4E:p1',
        nowMs: i * 5000,
        ...(await observe()),
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

test('working jobs, unanswered questions, failed reads, missing evidence and capped jobs stay at base', async (t) => {
  for (const variant of ['working', 'question', 'failed-read', 'missing-status', 'cap']) {
    await t.test(variant, async (t) => {
      const f = fixture(t, variant === 'cap' ? 201 : 1);
      if (variant === 'working') f.put(join(f.dir, 'STATUS.json'), { state: 'working' });
      if (variant === 'question') f.put(join(f.dir, 'qa/q1.md'), '# Question\n\nSynthetic pending?');
      if (variant === 'failed-read') {
        rmSync(join(f.dir, 'STATUS.json'));
        mkdirSync(join(f.dir, 'STATUS.json'));
      }
      if (variant === 'missing-status') rmSync(join(f.dir, 'STATUS.json'));
      assert.equal((await f.cadence()).intervalMs, 1000);
      assert.equal(
        (await f.observe()).fingerprint,
        undefined,
        'nonquiet polls do not serialize board history'
      );
    });
  }
});

function live(t, f) {
  const runner = join(f.root, 'runner.mjs');
  const module = (name) => pathToFileURL(resolve('dist/' + name + '.js')).href;
  const bin = join(f.root, 'bin'), herdrLog = join(f.root, 'herdr.log');
  mkdirSync(bin);
  writeFileSync(herdrLog, '');
  writeFileSync(join(bin, 'herdr'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HERDR_LOG"\nprintf "[]\\n"\n', { mode: 0o700 });
  // Delay, never replace, one actual collection to exercise force-during-await.
  f.put(
    runner,
    `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {resolve,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
// Record probes even when the target is absent or the panel swallows a failed read.
const retired = ['assoc', 'native-relations', 'jev-runtime'].map(name => join(process.env.HUD_HOME, name));
for (const io of [fs, fs.promises]) {
  for (const name of ['access', 'exists', 'lstat', 'open', 'opendir', 'readdir', 'readFile', 'realpath', 'stat', 'watch', 'watchFile']) {
    for (const method of [name, name + 'Sync']) {
      const original = io[method];
      if (!original) continue;
      io[method] = new Proxy(original, {apply(fn, receiver, args) {
        const [file] = args;
        if (typeof file === 'string' || file instanceof URL || Buffer.isBuffer(file)) {
          const path = resolve(file instanceof URL ? fileURLToPath(file) : String(file));
          if (retired.some(root => path === root || path.startsWith(root + sep))) {
            process.send({type: 'retired-probe', method, path});
          }
        }
        return Reflect.apply(fn, receiver, args);
      }});
    }
  }
}
syncBuiltinESMExports();
const {runLivePage,PanelJobPipeline} = await import(${JSON.stringify(module('tree-page'))});
const {ProfileRecorder,useProfileRecorder} = await import(${JSON.stringify(module('utils/profile'))});
let gate=false,release,startedAt;
const original=PanelJobPipeline.prototype.refresh;
PanelJobPipeline.prototype.refresh=async function(...args){
  startedAt=Date.now();
  if(gate){gate=false;process.send({type:'waiting',at:startedAt});await new Promise(r=>release=r);}
  return original.apply(this,args);
};
process.on('message',m=>{
  if(m==='gate'){gate=true;process.send({type:'armed'});}
  if(m==='release')release?.();
});
process.stdin.on('data',()=>process.send({type:'input'}));
const r=new ProfileRecorder('panel',()=>{});
r.record=(stage)=>{
  if(stage==='session.find')process.send({type:'session.find'});
  if(stage==='collect')process.send({type:'collected',at:Date.now(),startedAt});
};useProfileRecorder(r);
await runLivePage();process.exit(0);`
  );
  const child = spawn(process.execPath, [runner], {
    cwd: f.env.CODEX_HUD_CWD,
    env: { ...f.env, PATH: `${bin}:${f.env.PATH}`, HERDR_LOG: herdrLog, HUD_PANEL_ADAPTIVE_MAX_MS: String(LIVE_MAX_MS) },
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
  return { child, events, until, collections, output: () => output, herdrCalls: () => readFileSync(herdrLog, 'utf8') };
}

test('Claude and pi skip the Codex finder and back off when their observed boards are quiet', { timeout: 15000 }, async (t) => {
  await Promise.all(['claude', 'pi', 'incomplete-claude'].map(async (variant) => {
    const f = fixture(t, 0, LIVE_BASE_MS);
    const harness = variant === 'pi' ? 'pi' : 'claude';
    const source = join(f.root, 'transcripts'), session = 'synthetic-session';
    const agents = join(source, session, 'subagents');
    mkdirSync(agents, { recursive: true });
    mkdirSync(join(f.env.CODEX_HOME, 'sessions'));
    Object.assign(f.env, {
      CODEX_HUD_PANEL_HARNESS: harness,
      CODEX_HUD_PANEL_SOURCE: source,
      CODEX_HUD_PANEL_ROOT: `${makeSourceId(harness, source)}/${session}`,
    });
    if (harness === 'claude') {
      f.put(join(source, `${session}.jsonl`), '{"type":"user"}\n');
      f.put(join(agents, 'agent-a.jsonl'), '');
      f.put(join(agents, 'agent-a.meta.json'), variant === 'claude' ? { finished: true } : 'invalid');
    }
    const p = live(t, f);
    await p.until(() => p.collections().length >= 5);
    assert.equal(p.events.some((e) => e.type === 'session.find'), false, variant);
    const [previous, latest] = p.collections().slice(-2);
    if (variant === 'incomplete-claude') assertBaseCadence(previous, latest, variant);
    else assert.ok(latest.startedAt - previous.at >= LIVE_BASE_MS * 3.9, `${variant} did not back off`);
  }));
});

test('an unset harness only runs the finder when Codex sessions exist', { timeout: 15000 }, async (t) => {
  await Promise.all([false, true].map(async (hasCodex) => {
    const f = fixture(t, 0, LIVE_BASE_MS);
    if (hasCodex) mkdirSync(join(f.env.CODEX_HOME, 'sessions'));
    const p = live(t, f);
    await p.until(() => p.collections().length >= 2);
    assert.equal(p.events.some((e) => e.type === 'session.find'), hasCodex);
  }));
});

test('live working and capped scopes retain the original nonquiet base-tick timing', { timeout: 30000 }, async (t) => {
  await Promise.all(
    [1, 201].map(async (count) => {
      const f = fixture(t, count, LIVE_BASE_MS);
      if (count === 1) f.put(join(f.dir, 'STATUS.json'), { state: 'working' });
      const p = live(t, f);
      await p.until(() => p.collections().length >= 4, 10000);
      const polls = p.collections();
      for (let i = 1; i < polls.length; i++) {
        assertBaseCadence(polls[i - 1], polls[i], `${count === 1 ? 'working' : 'capped'} base interval`);
      }
    })
  );
});

test(
  'live panel: input wakes immediately, force during await is retained, and questions appear without retired observers',
  { timeout: 35000 },
  async (t) => {
    await Promise.all([
      (async () => {
        const f = fixture(t, 1, LIVE_BASE_MS),
          p = live(t, f);
        await p.until(() => p.collections().length >= 5);
        assert.ok(
          p.collections().at(-1).at - p.collections().at(-2).at >= LIVE_BASE_MS * 3.9,
          `quiet curve reached backoff after base-grid observations, then 2× and 4×; collected at +${p.collections().map((e) => e.at - p.collections()[0].at).join(', +')}ms`
        );
        p.child.send('gate');
        await p.until(() => p.events.some((e) => e.type === 'armed'), 1000);
        const start = Date.now(), beforeInput = p.collections().length;
        p.child.stdin.write('a');
        await p.until(() => p.events.some((e) => e.type === 'waiting'), 1000);
        const latency = p.events.find((e) => e.type === 'waiting').at - start;
        assert.ok(latency >= 0 && latency < LIVE_BASE_MS, 'input started collection without waiting for the backed-off timer');
        p.child.stdin.write('a');
        // The second key must reach the panel while the first collection is still awaiting release.
        await p.until(() => p.events.filter((e) => e.type === 'input').length === 2, 1000);
        p.child.send('release');
        await p.until(() => p.collections().length >= beforeInput + 2, 1000);
        assert.ok(
          p.collections()[beforeInput + 1].startedAt - p.collections()[beforeInput].at < LIVE_BASE_MS / 2,
          'second forced collection was not lost during await'
        );
      })(),
      (async () => {
        const f = fixture(t, 1, LIVE_BASE_MS),
          p = live(t, f);
        await p.until(() => p.collections().length >= 7);
        const gap = p.collections().at(-1).at - p.collections().at(-2).at;
        assert.ok(gap >= LIVE_MAX_MS * 0.98 && gap < LIVE_MAX_MS * 1.1, `continued polling at max interval: ${gap}ms`);
        const start = Date.now(),
          beforeQuestion = p.collections().length;
        f.put(join(f.dir, 'STATUS.json'), { state: 'working' });
        f.put(join(f.dir, 'qa/q1.md'), '# Question\n\nBACKOFF_QUESTION?\n\nDefault if unanswered: yes\n');
        await p.until(() => p.output().includes('BACKOFF_QUESTION'), LIVE_MAX_MS * 1.1);
        const elapsed = Date.now() - start;
        assert.ok(
          elapsed >= LIVE_MAX_MS * 0.9 && elapsed <= LIVE_MAX_MS * 1.1,
          `visible after one scaled maximum interval plus collection/scheduler overhead: ${elapsed}ms`
        );
        await p.until(() => p.collections().length >= beforeQuestion + 2, LIVE_BASE_MS * 2.6);
        const polls = p.collections();
        assertBaseCadence(polls[beforeQuestion], polls[beforeQuestion + 1], 'question/working job restores original base-grid cadence');
        // Reuse these real polling cycles (past the old 5s sampler cadence) instead of adding a sleep.
        assert.doesNotMatch(p.herdrCalls(), /^agent list(?:\s|$)/m, 'live collection never lists herdr agents');
        assert.deepEqual(p.events.filter((e) => e.type === 'retired-probe'), [], 'live collection never probes retired HUD home paths');
      })(),
    ]);
  }
);
