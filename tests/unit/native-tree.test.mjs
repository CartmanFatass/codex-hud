import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsMutable from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { nativeFixture, nativeFrames, NOW } from '../fixtures/native-tree.mjs';
import { JobSentences } from '../../dist-test/src/collectors/job-sentences.js';
import { SmallModel, modelHttpRequest } from '../../dist-test/src/collectors/small-model.js';
import { renderMonitor, initialMonitorState, handleMonitorInput } from '../../dist-test/src/render/monitor.js';
import { stripAnsi, visualLength, theme } from '../../dist-test/src/render/colors.js';
import { setDisplayConfig } from '../../dist-test/src/render/hud-config.js';
import { targetKey } from '../../dist-test/src/collectors/workboard-types.js';
import { collectionObservation, jobPanelObservation } from '../../dist-test/src/utils/collection-observation.js';
import { recordAdaptivePoll, createAdaptivePollState } from '../../dist-test/src/collectors/adaptive-poll.js';
import { claudeCallerSession } from '../../dist-test/src/collectors/claude-caller-session.js';
import { panelCommand, panelSelection } from '../../dist-test/src/cli/panel.js';
const tick = async () => {
  for (let i = 0; i < 15; i++) await new Promise(setImmediate);
};
function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'native-tree-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return nativeFixture(home);
}
test('Home: real Claude meta/transcript collection and Codex three-level tree, 80/120 columns EN/ZH', (t) => {
  const f = fixture(t),
    tree = f.combined(),
    board = f.board(tree);
  assert.equal(f.collector.complete, true);
  assert.equal(tree.nodes.length, 2);
  assert.equal(f.claude().nodes[0].children.length, 1);
  assert.equal(f.codex.nodes[0].children[0].children.length, 1);
  assert.equal(board.lanes.length, 2);
  assert.deepEqual(board.lanes.map((l) => l.workers.length).sort(), [2, 3]);
  const expected = JSON.parse(fs.readFileSync(new URL('../fixtures/native-tree-frames.json', import.meta.url)));
  assert.deepEqual(nativeFrames(f), expected);
  for (const width of [80, 120])
    for (const lang of ['en', 'zh']) {
      const frame = f.render(width, lang),
        text = frame.lines.map(stripAnsi).join('\n');
      for (const line of frame.lines) assert.equal(visualLength(line), width);
      assert.match(text, /Claude ·/);
      assert.match(text, /Codex ·/);
      assert.match(text, /  ✓ custom-tester/);
      assert.match(text, /Verify index ↳ Check migration/);
      assert.doesNotMatch(text, /PRIVATE-CLAUDE|PRIVATE-CHANNEL|Agents/);
    }
});
for (const finished of [undefined, false]) test(`Claude real-shaped running metadata (finished=${finished}) reaches its Home lane, then completes`, (t) => {
  const f = fixture(t), file = join(f.dir, 'agent-lead.meta.json');
  const meta = { agentType: 'frontend-implementer', description: 'Repair parser', toolUseId: 'root-call',
    spawnDepth: 1, requestShape: 'background', ...(finished === undefined ? {} : { finished }) };
  f.put(file, meta);
  const check = (completed) => {
    const tree = f.claude(), node = tree.nodes.find((n) => n.role === 'frontend-implementer');
    assert.ok(node, 'running agents must not be dropped as invalid_meta');
    assert.equal(tree.incomplete, false);
    assert.equal(node.status, completed ? 'completed' : 'running');
    assert.equal(f.board(tree).workers.find((w) => w.id === node.id).state, completed ? 'done' : 'working');
    const text = f.render(120, 'zh', initialMonitorState(), tree).lines.map(stripAnsi).join('\n');
    assert.match(text, /Claude · 本次会话/);
    assert.match(text, completed ? /✓ frontend-implementer/ : /◉ frontend-implementer/);
  };
  check(false); check(false);
  assert.equal(f.collector.bytes, 0, 'unchanged running metadata remains stat-only');
  f.put(file, { ...meta, finished: true });
  check(true);
  assert.equal(f.collector.bytes, fs.statSync(file).size, 'completion reads only changed metadata');
  check(true);
  assert.equal(f.collector.bytes, 0);
});

test('native hide rules: done 10m, failed/stopped 30m; a reveals in place and native Inspector opens transcript', (t) => {
  const f = fixture(t),
    tree = f.combined();
  const n = tree.nodes[1];
  n.status = 'completed';
  n.statusAt = new Date(NOW - 11 * 60_000);
  n.children[0].children[0].status = 'error';
  n.children[0].children[0].statusAt = new Date(NOW - 31 * 60_000);
  let frame = f.render(120, 'en', initialMonitorState(), tree);
  assert.doesNotMatch(frame.lines.map(stripAnsi).join('\n'), /Review schema|Verify index/);
  assert.match(frame.lines.map(stripAnsi).join('\n'), /Check migration/);
  const ctx = (frame) => ({ frame, tree, nowMs: NOW, standalone: true });
  const all = handleMonitorInput(frame.state, { type: 'key', key: 'show-all' }, ctx(frame)).state;
  frame = f.render(120, 'en', all, tree);
  assert.match(frame.lines.map(stripAnsi).join('\n'), /Review schema|Verify index ↳ Check migration/);
  f.claude();
  const native = tree.nodes[0];
  native.contextUsage = { percent: 42 };
  native.outputRate = { tokensPerSecond: 37.5, sampledAt: new Date(NOW), sampleMs: 1000 };
  native.tokensSpent = { input: 1200, cached: 200, output: 300 };
  const worker = f.board(tree).workers.find((w) => w.task === 'Repair parser');
  const target = { kind: 'worker', laneId: worker.laneId, workerId: worker.id };
  frame = f.render(120, 'en', { ...all, homeTarget: target }, tree);
  const nativeOpen = handleMonitorInput(frame.state, { type: 'key', key: 'open-session' }, ctx(frame));
  assert.deepEqual(nativeOpen.action.files, [join(f.dir, 'agent-lead.jsonl')]);
  const inspect = handleMonitorInput(frame.state, { type: 'key', key: 'inspect' }, ctx(frame));
  assert.deepEqual(inspect.state.boardInspect, target);
  frame = f.render(120, 'en', inspect.state, tree);
  assert.match(frame.lines.map(stripAnsi).join('\n'), /Files|custom-builder|claude-sonnet-4-5/);
  assert.match(frame.lines.map(stripAnsi).join('\n'), /42% · ~38 tok\/s · 1\.5K tokens spent/);
  assert.equal(f.collector.bytes, 0, 'painting/inspecting does not read a transcript');
  assert.deepEqual(
    handleMonitorInput(frame.state, { type: 'key', key: 'open-session' }, ctx(frame)).action.files,
    nativeOpen.action.files
  );
  assert.equal(handleMonitorInput(frame.state, { type: 'key', key: 'escape' }, ctx(frame)).state.focus, 'agents');
  // Exact expiry boundaries, including stopped, use the same projector as jobs.
  for (const [state, minutes, visible] of [
    ['done', 9, true],
    ['done', 10, false],
    ['failed', 29, true],
    ['failed', 30, false],
    ['stopped', 29, true],
    ['stopped', 30, false],
  ]) {
    const w = {
      ...worker,
      state,
      settledAt: NOW - minutes * 60000,
      work: { ...worker.work, failed: state === 'failed', facadeClosed: true },
    };
    const board = {
      ...f.board(tree),
      lanes: [{ ...f.board(tree).lanes[0], workers: [w] }],
      workers: [w],
      decisions: [],
    };
    const draw = renderMonitor({
      tree,
      workboard: board,
      state: initialMonitorState(),
      width: 120,
      height: 28,
      nowMs: NOW,
    });
    assert.equal(draw.workboard.snapshot.workers.length > 0, visible, state + ' ' + minutes);
  }
});
test('native cards without a transcript offer no open-files action on Home or in Inspector', (t) => {
  const f = fixture(t), tree = f.claude();
  tree.nodes[0].rolloutPath = undefined;
  const worker = f.board(tree).workers.find((w) => w.task === 'Repair parser');
  const target = { kind: 'worker', laneId: worker.laneId, workerId: worker.id };
  let frame = f.render(120, 'en', { ...initialMonitorState(), homeTarget: target }, tree);
  const press = (key) => handleMonitorInput(frame.state, { type: 'key', key }, { frame, tree, nowMs: NOW, standalone: true });
  assert.equal(press('open-session').action, undefined);
  frame = f.render(120, 'en', press('inspect').state, tree);
  for (const key of ['enter', 'open-session']) assert.equal(press(key).action, undefined);
  assert.equal(frame.workboard.rows.some((r) => r.files?.length), false);
});

test('matched nested Claude parents are complete; unmatched parents remain incomplete on warm refreshes', (t) => {
  const f = fixture(t), meta = join(f.dir, 'agent-lead.meta.json');
  f.put(meta, { ...JSON.parse(fs.readFileSync(meta, 'utf8')), finished: true });
  for (let i = 0; i < 2; i++) {
    const tree = f.claude();
    assert.equal(tree.nodes[0].children.length, 1);
    assert.equal(tree.nodes[0].children[0].depth, 2);
    assert.equal(tree.incomplete, false);
    assert.equal(f.collector.complete, true);
  }
  const child = join(f.dir, 'agent-child.meta.json');
  f.put(child, { ...JSON.parse(fs.readFileSync(child, 'utf8')), toolUseId: 'unmatched-parent' });
  for (let i = 0; i < 2; i++) {
    assert.equal(f.claude().incomplete, true);
    assert.equal(f.collector.complete, false);
  }
});

for (const mode of ['off', 'no-key', 'on'])
  for (const language of ['en', 'zh'])
    test(`native sentences use the job queue, master/key gate and two-minute floor: ${mode} ${language}`, async (t) => {
      const f = fixture(t),
        tree = f.claude();
      tree.nodes[0].children = [];
      tree.totalCount = 1;
      let now = NOW,
        calls = [];
      const env = { HOME: f.home, HUD_HOME: f.home, MISTRAL_API_KEY: mode === 'no-key' ? '' : 'synthetic-key' };
      const model = new SmallModel({
        env,
        clock: () => now,
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          calls.push(body);
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify(
                      language === 'zh'
                        ? { name: '解析器修复', sentence: '检查「解析器」和report.md，「+批准」或「-拒绝」，「!认为更简单」。' }
                        : { name: 'Parser repair', sentence: 'Checking «parser» and report.md, «+accept» or «-reject» with «!simpler design».' }
                    ),
                  },
                },
              ],
            })
          );
        },
      });
      const enabled =
        mode !== 'off' &&
        !(
          'error' in modelHttpRequest({ base: '', model: '' }, { feature: 'job-sentence', system: '', prompt: '' }, env)
        );
      model.configure({ backend: enabled ? 'api' : 'off' });
      const file = join(f.home, 'sentences.json');
      const service = new JobSentences(
        model,
        file,
        () => {},
        () => now
      );
      service.configure(enabled, language);
      t.after(() => {
        service.stop();
        model.cancelAll();
      });
      const update = async () => {
        service.update(f.board(tree), f.home, tree);
        await tick();
        return service.apply(f.board(tree));
      };
      let board = await update();
      assert.equal(calls.length, enabled ? 1 : 0);
      assert.doesNotMatch(JSON.stringify(calls), /PRIVATE-CLAUDE|PRIVATE-CHANNEL/);
      if (!enabled) {
        assert.equal(board.workers[0].modelSentence, undefined);
        assert.equal(board.workers[0].task, 'Repair parser');
        return;
      }
      assert.equal(board.workers[0].task, language === 'en' ? 'Parser repair' : '解析器修复');
      const display = setDisplayConfig({ theme: 'titanium', icons: 'unicode' });
      t.after(() => setDisplayConfig(display));
      const frame = renderMonitor({
        tree,
        workboard: board,
        state: initialMonitorState(),
        width: 120,
        height: 28,
        nowMs: now,
      });
      const checkPaint = (board) => {
        const ansi = renderMonitor({ tree, workboard: board, state: initialMonitorState(), width: 120, height: 28, nowMs: now }).lines.join('\n');
        for (const span of [theme.board.identifier(language === 'en' ? 'parser' : '解析器'), theme.board.identifier('report.md'),
          theme.board.success(language === 'en' ? 'accept' : '批准'), theme.board.danger(language === 'en' ? 'reject' : '拒绝'),
          theme.board.opinion(language === 'en' ? 'simpler design' : '认为更简单')]) assert.ok(ansi.includes(span));
        assert.doesNotMatch(ansi, /[«»「」]/);
      };
      checkPaint(board);
      assert.match(calls[0].messages[0].content, /up to 4 keywords/);
      assert.match(calls[0].messages[0].content, /Use «…» keyword delimiters in every language, including Simplified Chinese/);
      now += 119999;
      tree.nodes[0].status = 'completed';
      tree.nodes[0].statusAt = new Date(now);
      await update();
      assert.equal(calls.length, 1);
      now += 2;
      board = await update();
      assert.equal(calls.length, 2);
      assert.match(calls[1].messages[1].content, /"state":"done"/);
      checkPaint(board);
      now += 300000;
      await update();
      assert.equal(calls.length, 2, 'successful final freezes only that settlement');
      const reopened = new JobSentences(
        model,
        file,
        () => {},
        () => now
      );
      reopened.configure(true, language);
      reopened.update(f.board(tree), f.home, tree);
      await tick();
      assert.equal(calls.length, 2, 'reopened native text is cached');
      reopened.stop();
      tree.nodes[0].status = 'error';
      tree.nodes[0].statusAt = new Date(now);
      board = await update();
      checkPaint(board);
      assert.equal(calls.length, 3);
      assert.match(calls[2].messages[1].content, /"state":"failed"/);
      service.configure(false, language);
      assert.equal(service.apply(f.board(tree)).workers[0].modelSentence, undefined);
      assert.equal(service.apply(f.board(tree)).workers[0].task, 'Repair parser');
    });
function resumedFixture(t) {
  const f = fixture(t), meta = join(f.dir, 'agent-lead.meta.json'), file = join(f.dir, 'agent-lead.jsonl');
  fs.unlinkSync(join(f.dir, 'agent-child.meta.json'));
  fs.unlinkSync(join(f.dir, 'agent-child.jsonl'));
  const metadata = (finished, at = NOW) => {
    f.put(meta, { agentType: 'tester', description: 'Wait for background work', finished, spawnDepth: 1 });
    fs.utimesSync(meta, new Date(at), new Date(at));
  };
  const record = (content, at, stop_reason, type = 'assistant') => JSON.stringify({
    type, timestamp: new Date(at).toISOString(), message: { role: type, content, stop_reason },
  }) + '\n';
  const append = (content, at, stop, type) => fs.appendFileSync(file, record(content, at, stop, type));
  metadata(true);
  f.put(file, record([{ type: 'text', text: 'Waiting 40 seconds in the background.' }], NOW - 1000, 'end_turn'));
  return { ...f, meta, file, metadata, append, record };
}
test('Claude resumes after background wait: running card, fresh last-reply final under floor/cap, unchanged reopen is free', async (t) => {
  const f = resumedFixture(t);
  let now = NOW, calls = [];
  const model = new SmallModel({
    env: { HOME: f.home, HUD_HOME: f.home, MISTRAL_API_KEY: 'synthetic-key' },
    clock: () => now,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const input = JSON.parse(body.messages[1].content.slice('<job>\n'.length, -'\n</job>'.length));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        name: 'Background check', sentence: input.result.includes('FINAL-RESULT') ? 'Background check passed.' : 'Waiting in the background.',
      }) } }] }));
    },
  });
  model.configure({ backend: 'api', hourlyCap: 2 });
  const cache = join(f.home, 'sentences.json');
  let service = new JobSentences(model, cache, () => {}, () => now);
  service.configure(true, 'en');
  t.after(() => { service.stop(); model.cancelAll(); });
  const update = async () => {
    const tree = f.claude(), board = f.board(tree);
    service.update(board, f.home, tree);
    await tick();
    return { tree, board: service.apply(board) };
  };
  let current = await update();
  assert.equal(current.board.workers[0].state, 'done');
  assert.equal(calls.length, 1);
  assert.match(current.board.workers[0].modelSentence, /Waiting/);
  now += 20_000;
  f.append([{ type: 'tool_use', id: 'background-read', name: 'Read', input: {} }], now);
  current = await update();
  assert.equal(current.tree.nodes[0].status, 'running');
  assert.equal(current.tree.nodes[0].statusAt, undefined);
  assert.equal(current.board.workers[0].state, 'working');
  assert.match(f.render(120, 'en', initialMonitorState(), current.tree).lines.map(stripAnsi).join('\n'), /◉ tester/);
  assert.equal(calls.length, 1, 'resumption cannot bypass the two-minute floor');
  f.append([{ type: 'tool_result', tool_use_id: 'background-read', content: 'Finished' }], now + 1000, undefined, 'user');
  now += 20_000;
  f.append([{ type: 'text', text: 'Background completed. ' + 'checked '.repeat(1500) + 'FINAL-RESULT: all passed.' }], now, 'end_turn');
  current = await update();
  const settlement = current.board.workers[0].settledAt;
  assert.equal(current.board.workers[0].state, 'done');
  assert.equal(settlement, now);
  assert.equal(calls.length, 1, 'new settlement also respects the floor');
  now = NOW + 120_001;
  current = await update();
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[1].content, /FINAL-RESULT: all passed/);
  assert.doesNotMatch(calls[1].messages[1].content, /Waiting 40 seconds/);
  const input = JSON.parse(calls[1].messages[1].content.slice('<job>\n'.length, -'\n</job>'.length));
  assert.ok(input.result.length <= 8000);
  assert.ok(input.report.length <= 600);
  assert.equal(current.board.workers[0].modelSentence, 'Background check passed.');
  service = new JobSentences(model, cache, () => {}, () => now);
  service.configure(true, 'en');
  now += 300_000;
  const reads = t.mock.method(fsMutable, 'readSync');
  current = await update();
  assert.equal(f.collector.bytes, 0);
  assert.equal(reads.mock.callCount(), 0, 'finished unchanged transcript and sentence are stat/cache-only');
  assert.equal(calls.length, 2);
  assert.equal(current.board.workers[0].settledAt, settlement);
  assert.equal(current.board.workers[0].modelSentence, 'Background check passed.');
  f.append([{ type: 'text', text: 'Another completed result.' }], now, 'end_turn');
  await update();
  assert.equal(calls.length, 2, 'a further settlement cannot bypass the shared hourly cap');
});
test('Claude resumed settlement needs the last public end_turn and no open tools; fresh metadata also settles', (t) => {
  const f = resumedFixture(t);
  assert.equal(f.claude().nodes[0].status, 'completed');
  f.append([{ type: 'tool_use', id: 'sleep', name: 'Bash', input: { command: 'sleep 40' } }], NOW + 1000);
  assert.equal(f.claude().nodes[0].status, 'running');
  f.append([{ type: 'text', text: 'Not finished while tool is open.' }], NOW + 2000, 'end_turn');
  assert.equal(f.claude().nodes[0].status, 'running');
  f.append([{ type: 'tool_result', tool_use_id: 'sleep', content: 'Done' }], NOW + 3000, undefined, 'user');
  assert.equal(f.claude().nodes[0].status, 'running', 'a tool result after end_turn is not a settlement');
  fs.appendFileSync(f.file, JSON.stringify({ type: 'assistant', timestamp: new Date(NOW + 4000).toISOString(),
    message: { channel: 'analysis', content: [{ type: 'text', text: 'PRIVATE-RESUMED' }], stop_reason: 'end_turn' } }) + '\n');
  assert.equal(f.claude().nodes[0].status, 'running', 'private end_turn cannot settle');
  const final = f.record([{ type: 'text', text: 'Final public reply.' }], NOW + 5000, 'end_turn');
  fs.appendFileSync(f.file, final.slice(0, -1));
  assert.notEqual(f.claude().nodes[0].status, 'completed', 'partial JSONL is not a settlement');
  fs.appendFileSync(f.file, '\n');
  let tree = f.claude();
  assert.equal(tree.nodes[0].status, 'completed');
  assert.equal(tree.nodes[0].statusAt.getTime(), NOW + 5000);
  assert.equal(tree.nodes[0].lastReport.text, 'Final public reply.');
  f.append([{ type: 'text', text: 'Another continuation.' }], NOW + 6000);
  assert.equal(f.claude().nodes[0].status, 'running', 'later growth reopens an end_turn settlement too');
  f.metadata(true, NOW + 7000);
  tree = f.claude();
  assert.equal(tree.nodes[0].status, 'completed');
  assert.equal(tree.nodes[0].statusAt.getTime(), NOW + 7000);
  assert.equal(f.collector.bytes, fs.statSync(f.meta).size, 'metadata-only settlement does not reread transcript');
  assert.equal(f.claude().nodes[0].status, 'completed');
  assert.equal(f.collector.bytes, 0);
  f.metadata(false, NOW + 8000);
  assert.equal(f.claude().nodes[0].status, 'running');
  f.append([{ type: 'text', text: 'Settled without another metadata write.' }], NOW + 9000, 'end_turn');
  assert.equal(f.claude().nodes[0].status, 'completed');
});
test('finished Claude metadata survives multi-pass replay, hides by settlement age and makes no premature model call', async (t) => {
  const f = resumedFixture(t), settledAt = NOW - 9 * 60 * 60_000;
  f.metadata(true, settledAt);
  f.put(f.file, [0, 1, 2].map((i) => f.record(
    [{ type: 'text', text: 'x'.repeat(800_000) + (i === 2 ? 'FINAL-REPLAY-RESULT' : 'Historical progress') }],
    settledAt - (2 - i) * 1000, 'end_turn'
  )).join(''));
  fs.utimesSync(f.file, new Date(settledAt), new Date(settledAt));
  const calls = [];
  const model = new SmallModel({
    env: { HOME: f.home, HUD_HOME: f.home, MISTRAL_API_KEY: 'synthetic-key' }, clock: () => NOW,
    fetch: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Replay completed.' } }] }));
    },
  });
  model.configure({ backend: 'api' });
  const service = new JobSentences(model, join(f.home, 'sentences.json'), () => {}, () => NOW);
  service.configure(true, 'en');
  t.after(() => { service.stop(); model.cancelAll(); });
  let passes = 0, tree;
  do {
    tree = f.claude();
    const node = tree.nodes[0], board = f.board(tree);
    assert.equal(node.status, 'completed', 'replay does not reopen metadata completion');
    assert.equal(node.statusAt.getTime(), settledAt);
    assert.equal(board.workers[0].state, 'done');
    assert.equal(board.workers[0].settledAt, settledAt);
    const frame = f.render(120, 'en', initialMonitorState(), tree);
    assert.equal(frame.workboard.snapshot.workers.length, 0, 'normal ten-minute expiry applies during replay');
    assert.doesNotMatch(frame.lines.map(stripAnsi).join('\n'), /Wait for background work|stalled/);
    service.update(board, f.home, tree);
    await tick();
    passes++;
    if (tree.incomplete) {
      assert.equal(node.replaying, true);
      assert.equal(calls.length, 0);
    }
    assert.ok(passes <= 4);
  } while (tree.incomplete);
  assert.equal(passes, 3);
  assert.equal(calls.length, 1, 'caught-up material can use the existing final-sentence path');
  assert.match(calls[0].messages[1].content, /FINAL-REPLAY-RESULT/);
  assert.equal(tree.nodes[0].replaying, false);
  assert.equal(f.claude().nodes[0].status, 'completed');
  assert.equal(f.collector.bytes, 0);
});
test('Claude resumed end_turn waits for bounded transcript catch-up', (t) => {
  const f = resumedFixture(t);
  f.claude();
  f.append([{ type: 'text', text: 'x'.repeat(1048576 + 100) + 'Final reply.' }], NOW + 1000, 'end_turn');
  let tree = f.claude();
  assert.notEqual(tree.nodes[0].status, 'completed');
  assert.equal(tree.incomplete, true);
  assert.ok(f.collector.bytes <= 1048576);
  tree = f.claude();
  assert.equal(tree.nodes[0].status, 'completed');
  assert.equal(tree.nodes[0].statusAt.getTime(), NOW + 1000);
  assert.match(tree.nodes[0].lastReport.text, /Final reply\.$/);
  assert.ok(tree.nodes[0].lastReport.text.length <= 8000);
  f.claude();
  assert.equal(f.collector.bytes, 0);
});
test('Claude reader bounds/unchanged reads, incremental tails, nesting and uncertain evidence never back off working natives', (t) => {
  const f = fixture(t);
  f.claude();
  f.claude();
  assert.equal(f.collector.bytes, 0, 'unchanged files are stat-only');
  const file = join(f.dir, 'agent-lead.jsonl');
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(NOW).toISOString(),
      message: { content: [{ type: 'text', text: 'New public evidence.' }] },
    }) + '\n'
  );
  const tree = f.claude();
  assert.equal(tree.nodes[0].lastReport.text, 'New public evidence.');
  assert.ok(f.collector.bytes <= 4 * (1048576 + 8192));
  const board = f.board(tree);
  assert.equal(board.workers[0].state, 'working');
  let poll = createAdaptivePollState(1000);
  for (let i = 0; i < 10; i++)
    poll = recordAdaptivePoll(poll, {
      scopeKey: 'native',
      nowMs: NOW + i * 5000,
      ...jobPanelObservation(board, true, false),
    });
  assert.equal(poll.intervalMs, 1000);
  assert.equal(collectionObservation(undefined, tree).activity, 'active');
  fs.unlinkSync(join(f.dir, 'agent-lead.meta.json'));
  f.claude();
  assert.equal(f.collector.complete, false, 'nested agent without parent evidence is not complete quiet history');
  for (let i = 0; i < 8; i++) {
    f.put(join(f.dir, `agent-extra${i}.meta.json`), {
      agentType: 'tester',
      description: `Check ${i}`,
      toolUseId: `root-${i}`,
      spawnDepth: 1,
      finished: false,
    });
    f.put(join(f.dir, `agent-extra${i}.jsonl`), '');
  }
  f.claude();
  assert.equal(f.collector.complete, false, 'deferred changed files do not count as complete');
  for (let i = 0; i < 8; i++) {
    f.claude();
    assert.ok(f.collector.bytes <= 4 * (1048576 + 8192));
  }
  f.claude();
  assert.equal(f.collector.bytes, 0, 'rotation finishes all changed bodies');
  for (let i = 0; i < 402; i++) f.put(join(f.dir, `unrelated-${i}`), 'synthetic');
  f.claude();
  assert.equal(f.collector.complete, false, 'discovery stops at its directory bound');
});
function callerFixture(t) {
  const f = fixture(t), session = '12345678-1234-1234-1234-123456789abc';
  const cwd = join(f.home, 'repo.with.dots');
  const config = join(f.home, '.claude'), projects = join(config, 'projects');
  const source = join(projects, cwd.replace(/[/.]/g, '-'));
  fs.mkdirSync(projects, { recursive: true });
  fs.renameSync(f.source, source);
  fs.renameSync(join(source, f.session), join(source, session));
  fs.renameSync(join(source, f.session + '.jsonl'), join(source, session + '.jsonl'));
  const bin = join(f.home, 'bin'), log = join(f.home, 'herdr.log'), reply = join(f.home, 'reply.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, 'herdr'), `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[1] === 'current') {
  const reply = JSON.parse(fs.readFileSync(${JSON.stringify(reply)}, 'utf8'));
  if (reply.fail) process.exit(1);
  else if (reply.hang) setInterval(() => {}, 10000);
  else console.log(JSON.stringify(reply));
} else console.log(JSON.stringify({result: {pane: {pane_id: 'w4E:p2'}}}));
`, { mode: 0o700 });
  const pane = { agent: 'claude', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: session }, cwd, pane_id: 'w4E:p1' };
  const setReply = (value = { result: { type: 'pane_current', pane } }) => fs.writeFileSync(reply, JSON.stringify(value));
  setReply();
  const env = { HOME: f.home, HUD_HOME: join(f.home, 'hud'), HERDR_PANE_ID: 'w4E:p1',
    CLAUDE_CONFIG_DIR: config, CODEX_HOME: join(f.home, 'codex'), PI_CODING_AGENT_DIR: join(f.home, 'pi'),
    PATH: `${bin}:${process.env.PATH}`, COLUMNS: '120', HUD_SETTINGS_PATH: join(f.home, 'settings.json') };
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { ...f, session, source, projects, env, pane, setReply, calls };
}
async function foregroundCaller(t, f, args = ['--here'], ready = 'Nothing needs you') {
  const runner = join(f.home, 'runner.mjs');
  fs.writeFileSync(runner, `import {panelCommand} from ${JSON.stringify(pathToFileURL(resolve('dist-test/src/cli/panel.js')).href)};process.exitCode=await panelCommand({env:process.env,stdout:s=>process.stdout.write(s),stderr:s=>process.stderr.write(s)},${JSON.stringify(args)});`);
  const child = spawn(process.execPath, [runner], { cwd: f.home, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', b => output += b);
  child.stderr.on('data', b => errors += b);
  const exited = new Promise(r => child.once('exit', r));
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const until = Date.now() + 10000;
  while (!stripAnsi(output).includes(ready) && Date.now() < until && child.exitCode === null)
    await new Promise(r => setTimeout(r, 20));
  assert.match(stripAnsi(output), /Home/, errors);
  child.stdin.end();
  assert.equal(await exited, 0, errors);
  return stripAnsi(output);
}
test('current w4E:p1 binds before splitting; real foreground panel shows the Claude lane; statusline writes no binding', async t => {
  const f = callerFixture(t);
  const input = { session_id: f.session, transcript_path: join(f.source, f.session + '.jsonl'), cwd: f.home };
  for (const pane of ['w4E:p1', 'old-valid-pane']) {
    const result = spawnSync(process.execPath, [resolve('bin/hud'), 'statusline', '--width', '80'], {
      env: { ...f.env, HERDR_PANE_ID: pane }, input: JSON.stringify(input), encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'panes')), false);
  const bound = await claudeCallerSession(f.env);
  assert.deepEqual(bound, { session: f.session, source: f.source });
  assert.equal(panelSelection(['--harness', 'claude', '--session', bound.session, '--source', bound.source]).source, f.source);
  assert.match(await foregroundCaller(t, f, ['--here'], 'Claude'), /Claude/);
  await panelCommand({ env: f.env, stdout: () => {}, stderr: () => {} });
  const calls = f.calls(), split = calls.findIndex(c => c[1] === 'split');
  assert.deepEqual(calls[split - 1], ['pane', 'current']);
  assert.equal(calls[split][2], 'w4E:p1');
  assert.match(calls.at(-1)[3], new RegExp(`'--session' '${f.session}'`));
  assert.ok(calls.at(-1)[3].includes(`'--source' '${f.source}'`));
});
test('slug miss scans only 256 immediate projects; default HOME config is supported', async t => {
  const f = callerFixture(t);
  for (let n = 0; n < 260; n++) fs.mkdirSync(join(f.projects, `project-${n}`));
  const directory = fs.opendirSync(f.projects), names = [];
  try { let entry; while ((entry = directory.readSync())) names.push(entry.name); } finally { directory.closeSync(); }
  const within = names[0], beyond = names[256];
  const target = join(f.projects, beyond);
  fs.renameSync(join(f.source, f.session + '.jsonl'), join(target, f.session + '.jsonl'));
  f.pane.cwd = '/slug/missing'; f.setReply();
  assert.equal(await claudeCallerSession(f.env), undefined, 'the 257th directory is not probed');
  fs.renameSync(join(target, f.session + '.jsonl'), join(f.projects, within, f.session + '.jsonl'));
  const env = { ...f.env }; delete env.CLAUDE_CONFIG_DIR;
  assert.deepEqual(await claudeCallerSession(env), { session: f.session, source: join(f.projects, within) });
});
for (const reason of ['other agent', 'no agent', 'path session', 'invalid uuid', 'missing transcript', 'herdr failure', 'timeout', 'outside herdr'])
  test(`caller lookup ${reason}: real foreground panel stays unbound`, async t => {
    const f = callerFixture(t);
    if (reason === 'other agent') f.pane.agent = 'pi';
    if (reason === 'no agent') delete f.pane.agent;
    if (reason === 'path session') f.pane.agent_session.kind = 'path';
    if (reason === 'invalid uuid') f.pane.agent_session.value = '../../invalid';
    if (reason === 'missing transcript') fs.unlinkSync(join(f.source, f.session + '.jsonl'));
    if (reason === 'outside herdr') delete f.env.HERDR_PANE_ID;
    f.setReply(reason === 'herdr failure' ? { fail: true } : reason === 'timeout' ? { hang: true } : undefined);
    assert.equal(await claudeCallerSession(f.env), undefined);
    assert.doesNotMatch(await foregroundCaller(t, f), /Claude/);
    if (reason === 'outside herdr') assert.deepEqual(f.calls(), [], 'never query the focused pane');
  });
test('explicit --root and harness/session/source win without querying current pane', async t => {
  const f = callerFixture(t);
  for (const selection of [['--root', 'synthetic/explicit'], ['--harness', 'claude', '--session', f.session, '--source', f.source]]) {
    await panelCommand({ env: f.env, stdout: () => {}, stderr: () => {} }, selection);
    assert.ok(f.calls().at(-1)[3].includes(selection.map(s => `'${s}'`).join(' ')));
  }
  assert.equal(f.calls().some(c => c[1] === 'current'), false);
});
