import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
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
import { rememberClaudePane, claudePaneSession } from '../../dist-test/src/collectors/claude-pane-session.js';
import { panelSelection } from '../../dist-test/src/cli/panel.js';
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
  assert.ok(f.collector.bytes <= 4 * (32768 + 8192));
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
    assert.ok(f.collector.bytes <= 4 * (32768 + 8192));
  }
  f.claude();
  assert.equal(f.collector.bytes, 0, 'rotation finishes all changed bodies');
  for (let i = 0; i < 402; i++) f.put(join(f.dir, `unrelated-${i}`), 'synthetic');
  f.claude();
  assert.equal(f.collector.complete, false, 'discovery stops at its directory bound');
});
test('statusline pane binding writes only on semantic change; exact pane/session selection and stale fallback', async (t) => {
  const f = fixture(t),
    env = { HOME: f.home, HUD_HOME: f.home, HERDR_PANE_ID: 'synthetic-pane' };
  const input = { session_id: f.session, transcript_path: join(f.source, f.session + '.jsonl'), cwd: f.home };
  const statusline = () =>
    spawnSync(process.execPath, [resolve('bin/hud'), 'statusline', '--width', '80'], {
      env: { PATH: process.env.PATH, ...env },
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 10000,
    });
  assert.equal(statusline().status, 0);
  const record = join(f.home, 'panes/synthetic-pane.json'),
    first = fs.statSync(record);
  assert.equal(first.mode & 0o777, 0o600);
  assert.equal(statusline().status, 0);
  assert.equal(fs.statSync(record).ino, first.ino, 'unchanged input does not atomically replace/write the record');
  assert.deepEqual(claudePaneSession(env), { session: f.session, source: f.source });
  assert.equal(claudePaneSession({ ...env, HERDR_PANE_ID: 'other-pane' }), undefined);
  const bound = claudePaneSession(env),
    selected = panelSelection(['--harness', 'claude', '--session', bound.session, '--source', bound.source]);
  assert.equal(selected.harness, 'claude');
  assert.equal(selected.source, f.source);
  // Run the real foreground panel command + runLivePage with the implicit pane binding, synthetic HOME only.
  const runner = join(f.home, 'runner.mjs');
  fs.writeFileSync(
    runner,
    `import {panelCommand} from ${JSON.stringify(pathToFileURL(resolve('dist-test/src/cli/panel.js')).href)};await panelCommand({env:process.env,stdout:s=>process.stdout.write(s),stderr:s=>process.stderr.write(s)},['--here']);`
  );
  const child = spawn(process.execPath, [runner], {
    cwd: f.home,
    env: {
      PATH: process.env.PATH,
      ...env,
      CODEX_HOME: join(f.home, 'codex'),
      CLAUDE_CONFIG_DIR: join(f.home, 'empty-claude'),
      PI_CODING_AGENT_DIR: join(f.home, 'pi'),
      HUD_SETTINGS_PATH: join(f.home, 'settings.json'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '',
    errors = '';
  child.stdout.on('data', (b) => (output += b));
  child.stderr.on('data', (b) => (errors += b));
  t.after(async () => {
    if (child.exitCode === null) {
      child.stdin.end();
      await new Promise((r) => child.once('exit', r));
    }
  });
  const until = Date.now() + 6000;
  while (!stripAnsi(output).includes('Claude') && Date.now() < until && child.exitCode === null)
    await new Promise((r) => setTimeout(r, 20));
  assert.match(stripAnsi(output), /Claude/, errors);
  rememberClaudePane({ ...input, session_id: 'replacement' }, env);
  assert.notEqual(fs.statSync(record).ino, first.ino);
  fs.unlinkSync(input.transcript_path);
  assert.equal(claudePaneSession(env), undefined);
});
