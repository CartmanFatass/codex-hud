import { withState } from '../fixtures/state-helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { PanelJobPipeline } from '../../dist/tree-page.js';
import { initialMonitorState, renderMonitor, handleMonitorInput } from '../../dist/render/monitor.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { Notifier } from '../../dist/notify.js';
import { frameDiff } from '../../dist/render/frame-diff.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { targetKey } from '../../dist/collectors/workboard-types.js';
import { collectJobLanes } from '../../dist/collectors/job-snapshot.js';
import { buildWorkboard } from '../../dist/collectors/workboard.js';
import { flowLine, flowSummary } from '../../dist/render/work-job-detail.js';
const now = new Date().setHours(12, 0, 0, 0);
const question =
  'Where should the model chip go on a card whose phase strip is longer than one complete line at 56 columns, without hiding any of the important results?';
const blocked =
  'The card layout cannot be finished until the model chip has a place at 56 columns; 中文宽度必须保持正确。';
const instead =
  'a) use only --width with no settings key, keeping the original worker default even when this explanation wraps onto several more lines';
const chosen =
  'b) add the optional settings key as well, preserving all of this deliberately long decision headline instead of silently cutting its tail';
const asked =
  'Should the default panel width live only in a --width flag, or also in the settings file so every later invocation can reuse the owner choice without a repeated command?';
const reason =
  'The provider returned HTTP 429 (rate limit) on the second request. The worker stopped without retrying and no report was written. This entire failure reason must stay visible.';
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'hud-v7-'));
  const env = {
    ...process.env,
    HOME: join(home, 'home'),
    HUD_HOME: join(home, 'hud'),
    CODEX_HOME: join(home, 'codex'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    PI_CODING_AGENT_DIR: join(home, 'pi'),
    HERDR_PANE_ID: 'w4E:p1',
  };
  for (const key of ['HOME', 'HUD_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR'])
    mkdirSync(env[key], { recursive: true });
  const ago = (m) => new Date(now - m * 60000);
  const put = (file, value, age = 1) => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    utimesSync(file, ago(age), ago(age));
  };
  const qa = (
    ask,
    fallback = 'a) separate model line',
    options = ['a) separate model line', 'b) beside the phase strip']
  ) =>
    `# Question\n\n${ask}\n\nOptions:\n${options.map((o) => '- ' + o).join('\n')}\n\nDefault if unanswered: ${fallback}\n\nContext: ${blocked}\n`;
  const job = (n, pkg, title, state, age, settled = null, pane = 'w4E:p1', extra = {}) => {
    const id = `j${String(n).padStart(16, '0')}`,
      dir = join(env.HUD_HOME, 'jobs', id);
    put(
      join(dir, 'job.json'),
      {
        job: id,
        role: 'imp',
        cwd: join(home, 'unrelated-project'),
        package: pkg,
        herdr_pane: pane,
        created_at: ago(40).toISOString(),
        ...extra,
      },
      40
    );
    put(join(dir, 'brief.md'), '# ' + title, 40);
    put(
      join(dir, 'STATUS.json'),
      {
        state,
        model: n === 1 ? 'openai/gpt-6.1-sol' : 'zhipu/glm-5.3',
        thinking: n === 1 ? 'high' : 'max',
        provider: 'gateway',
        started_at: ago(40).toISOString(),
        ...(settled === null ? {} : { settled_at: ago(settled).toISOString() }),
        ...(state === 'failed' ? { exit_reason: reason } : {}),
      },
      age
    );
    return dir;
  };
  const askDir = job(1, 'PANEL-THIN', 'thin job cards in the panel', 'working', 1);
  put(join(askDir, 'qa/q1.md'), qa('Keep the card at three lines?', 'yes', ['yes', 'no']), 9);
  put(join(askDir, 'qa/q1.answer.md'), 'yes', 8);
  put(join(askDir, 'qa/q2.md'), qa(asked, instead, [instead, chosen]), 7);
  put(join(askDir, 'qa/q2.answer.md'), chosen, 6);
  put(join(askDir, 'qa/q3.md'), qa(question), 4);
  put(join(askDir, 'report.md'), 'Build complete; tests green', 10);
  put(join(askDir, 'review-1.md'), 'Verdict: changes-required\n\n2 major: preserve complete Tier-1 text', 5);
  const stalled = job(2, 'TEST-CUT', 'review card renderer', 'working', 14);
  put(join(stalled, 'report.md'), 'Comparing card widths and checking all remaining tests', 14);
  job(3, 'TEST-CUT', 'list the slowest tests', 'failed', 9, 9);
  const ready = job(4, 'TEST-CUT', 'check the cut list', 'idle_grace', 20, 4);
  put(join(ready, 'report.md'), 'Accepts the cuts; all tests pass', 2);
  job(5, 'PANEL-THIN', 'width flag', 'working', 1, null, 'w4E:p1', { harness: 'codex' });
  job(6, 'TEST-CUT', 'Folded old success', 'closed', 15, 15);
  job(7, 'WRONG-PANE', 'Never show another session', 'working', 1, null, 'w4E:p9');
  const pipeline = new PanelJobPipeline(env.HUD_HOME, { project: home, pane: 'w4E:p1' }, now - 60 * 60000);
  const display = setDisplayConfig({ theme: 'none', icons: 'unicode', glyphs: 'glyph' }),
    language = setLanguage('en');
  t.after(() => {
    pipeline.dispose();
    setDisplayConfig(display);
    setLanguage(language);
    rmSync(home, { recursive: true, force: true });
  });
  const tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(now) };
  const render = (board, height = 180, width = 56, state = initialMonitorState()) =>
    renderMonitor({ tree, workboard: board, state, width, height, nowMs: now });
  return { env, pipeline, tree, render, put, job, askDir, ready };
}
test('native subagent completion stays quiet, but native approvals still notify', () => {
  const delivered = [];
  const notifier = new Notifier({ enabled: true, cooldownMs: 0, deliver: event => delivered.push(event) });
  const snapshot = (status) => ({ subagentTree: { nodes: [{ id: 'agent-a', name: 'Example agent', depth: 1, status, children: [] }] } });
  notifier.update(snapshot('running'), now);
  assert.deepEqual(notifier.update(snapshot('completed'), now + 1000), []);
  assert.deepEqual(delivered, []);
  notifier.update({ ...snapshot('completed'), pendingApproval: { kind: 'exec', since: new Date(now + 2000), summary: 'Example command' } }, now + 2000);
  assert.deepEqual(delivered.map(({ message }) => message), ['approval needed: Example command']);
});
const plain = (frame) => frame.lines.map(stripAnsi);
// Everything starts collapsed; this is the state of a panel where every card was expanded with Enter.
const expandAll = (board, from = initialMonitorState()) => (withState(from, { home: { expanded: new Set([
    ...board.workers.map((w) => targetKey({ kind: 'worker', laneId: w.laneId, workerId: w.id })),
  ]) } }));
const joined = (frame) =>
  plain(frame)
    .map((l) => l.replace(/^\s*[┃|]\s?/, '').trim())
    .join(' ')
    .replace(/\s+/g, ' ');
test('answered QA remains collected for retained jobs without appearing on Home', async (t) => {
  const f = fixture(t);
  f.put(join(f.ready, 'qa/q1.md'), '# Question\n\nKeep this choice?\n\nDefault if unanswered: yes', 5);
  f.put(join(f.ready, 'qa/q1.answer.md'), 'yes', 5);
  await f.pipeline.refresh();
  const board = f.pipeline.workboard(f.tree);
  const frame = renderMonitor({
    tree: f.tree,
    workboard: board,
    state: initialMonitorState(),
    width: 56,
    height: 180,
    nowMs: now + 10 * 60000,
  });
  assert.ok(frame.workboard.snapshot.workers.some((w) => w.id.endsWith('4')));
  assert.ok(frame.workboard.snapshot.decisions.some((d) => d.question === 'Keep this choice?'));
  assert.doesNotMatch(plain(frame).join('\n'), /TEST-CUT · imp q1|Keep this choice/);
});
test('Claude compact and detail lines omit HUD job counts without a fresh census', (t) => {
  const f = fixture(t);
  assert.equal(existsSync(join(f.env.HUD_HOME, 'display/role-summary')), false);
  const clock = join(f.env.HOME, 'clock.mjs');
  writeFileSync(clock, `Date.now=()=>${now};`);
  const run = (args = []) => spawnSync(process.execPath, ['--import', clock, resolve('bin/hud'), 'statusline', '--width', '160', ...args], {
    env: f.env,
    input: JSON.stringify({ session_id: 'synthetic', model: { display_name: 'Synthetic' } }),
    encoding: 'utf8',
    timeout: 10000,
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(stripAnsi(result.stdout), /⚒\d|\uF0AD\d|!1|thin job cards|asks/);
  const details = run(['--details']);
  assert.equal(details.status, 0, details.stderr);
  assert.doesNotMatch(details.stdout, /⚒\d|\uF0AD\d|Work:|needs you/);
});

test('a queued land names the job it waits on: its ticket id, else the holder’s flow id (panel-polish/04)', async (t) => {
  const f = fixture(t);
  const wait = (holder) => ({ flow: 'f0000000000000092', job: 'j0000000000000092', pane: 'w4E:p1', task: false, state: 'queued', step: `waiting for ${holder} (gate step 2, 3 min)`,
    wt: { main_root: '/synthetic/repo', root: '/synthetic/wt', branch: 'wt/wait', base_head: 'aaaaaaa' }, config: { base: 'main', gate: ['npm test'], after: [], push: false },
    source_sha: 'bbbbbbb', pid: 999999, start: '1', created_at: new Date(now - 60000).toISOString(), updated_at: new Date(now - 10000).toISOString() });
  f.job(91, 'HOLD', 'HOLD-07: keep the lease', 'closed', 3, 3);
  f.job(92, 'WAIT', 'WAIT-02: land behind it', 'closed', 3, 3);
  const flowFile = join(f.env.HUD_HOME, 'flows', 'f0000000000000092.json');
  // Project each written receipt directly: this tests the label, not when the panel's watch invalidates its cache.
  const waiting = async () => buildWorkboard(f.tree, (await collectJobLanes(f.env.HUD_HOME,
    { project: null, pane: f.env.HERDR_PANE_ID })).lanes).workers.find((w) => w.flow?.state === 'queued').flow;
  f.put(flowFile, wait('f0000000000000091'), 0);
  let flow = await waiting();
  assert.equal(flow.waitsOn, 'HOLD-07');
  for (const [lang, narrow, wide] of [['en', 'wait HOLD-07 · gate 2, 3m', 'waiting for HOLD-07 (gate step 2, 3 min)'], ['zh', '等待 HOLD-07 · 门禁 2，3分', '等待 HOLD-07（门禁第 2 步，3 分钟）']]) {
    setLanguage(lang);
    assert.ok(stripAnsi(flowLine(flow, 80, (x) => x)).includes(wide), `${lang}: ${stripAnsi(flowLine(flow, 80, (x) => x))}`);
    assert.ok(stripAnsi(flowLine(flow, 30, (x) => x)).includes(narrow), `${lang} narrow`);
    assert.ok(flowSummary(flow).includes(wide), `${lang}: the Inspector's flow row`);
  }
  setLanguage('en');
  f.put(flowFile, wait('f0000000000000077-2'), 0);
  flow = await waiting();
  assert.equal(flow.waitsOn, undefined, 'a holder this board does not have stays its flow id');
  assert.ok(flowSummary(flow).includes('waiting for f0000000000000077-2'));
});

test('Inspector keeps collected land and scout flow steps and final outcomes in EN and ZH', async (t) => {
  const f = fixture(t);
  // Test each on-disk transition, not whether a watch notification beats the next request.
  const project = async () => buildWorkboard(f.tree, (await collectJobLanes(f.env.HUD_HOME,
    { project: null, pane: f.env.HERDR_PANE_ID })).lanes);
  const landId = 'j0000000000000081', flowId = 'f0000000000000081';
  const flowFile = join(f.env.HUD_HOME, 'flows', `${flowId}.json`);
  // An already settled job can still have a running land.
  f.job(81, 'FLOW-LAND', 'land synthetic slice', 'closed', 10, 10);
  const firstRun = {
    flow: flowId, job: landId, pane: 'w4E:p1', task: false,
    wt: { main_root: '/synthetic/repo', root: '/synthetic/wt', branch: 'wt/flow', base_head: 'aaaaaaa' },
    config: { base: 'main', gate: ['npm test'], after: [], push: true },
    source_sha: 'bbbbbbb', pid: 999999, start: '1',
    state: 'running', step: 'gate[1]: npm test',
    created_at: new Date(now - 60000).toISOString(),
    updated_at: new Date(now - 10000).toISOString(),
  };
  f.put(flowFile, firstRun, 0);
  // Scouted job: scouting -> run -> done.
  const scoutDir = f.job(82, 'FLOW-SCOUT', 'scout synthetic slice', 'working', 0, null, 'w4E:p1', { scout_state: 'scouting' });
  f.put(join(scoutDir, 'STATUS.json'), { state: 'working', reason: 'scouting', started_at: new Date(now - 60000).toISOString() }, 0);

  let board = await project();
  const show = (worker, width) => {
    const target = { kind: 'worker', laneId: worker.laneId, workerId: worker.id };
    const state = { ...initialMonitorState(), subpage: { kind: 'inspector', target, scroll: 0 } };
    const lines = plain(renderMonitor({ state, workboard: board, width, height: 30, nowMs: now }));
    assert.ok(lines.every((line) => visualLength(line) === width));
    return lines.join('\n');
  };
  const previous = setLanguage('en');
  t.after(() => setLanguage(previous));
  assert.match(show(board.workers.find(w => w.flow?.kind === 'land'), 80), /gate\[1\]: npm test/);
  assert.match(show(board.workers.find(w => w.flow?.kind === 'scout'), 80), /scout.*run/);

  const retryFile = join(f.env.HUD_HOME, 'flows', `${flowId}-2.json`);
  f.put(flowFile, { ...firstRun, state: 'failed', error: 'timeout' }, 0);
  const queued = { ...firstRun, flow: `${flowId}-2`, state: 'queued', step: 'waiting for f0000000000000099 (gate step 2, 3 min)' };
  f.put(retryFile, queued, 0);
  board = await project();
  for (const [lang, narrow, wide] of [
    ['en', 'wait f0000000000000099 · gate 2, 3m', queued.step],
    ['zh', '等待 f0000000000000099 · 门禁 2，3分', '等待 f0000000000000099（门禁第 2 步，3 分钟）'],
  ]) {
    setLanguage(lang);
    const waiting = board.workers.find((w) => w.flow?.state === 'queued').flow;
    for (const [width, detail] of [[40, narrow], [80, wide]]) {
      assert.ok(stripAnsi(flowLine(waiting, width, (s) => s)).includes(detail), `${lang} ${width}: wait identifies the lease holder`);
      assert.ok(show(board.workers.find(w => w.flow === waiting), width).includes(detail));
    }
  }

  // Advance land to completed with SHA, and scouted job to running after scout finished.
  f.put(retryFile, { ...queued, landed_sha: '1234567890abcdef', state: 'completed', step: 'done',
    updated_at: new Date(now - 5000).toISOString() }, 0);
  f.put(join(scoutDir, 'job.json'), {
    job: 'j0000000000000082', role: 'imp', cwd: '/synthetic/repo', package: 'FLOW-SCOUT', herdr_pane: 'w4E:p1',
    created_at: new Date(now - 60000).toISOString(), scout_state: 'done',
  }, 0);
  f.put(join(scoutDir, 'STATUS.json'), { state: 'working', started_at: new Date(now - 60000).toISOString() }, 0);
  board = await project();
  for (const [lang, landedText, runText] of [
    ['en', '✓ gate ▸ ✓ merge ▸ ✓ push · landed 1234567', '✓ scout ▸ ◉ run'],
    ['zh', '✓ 门禁 ▸ ✓ 合并 ▸ ✓ 推送 · 已落地 1234567', '✓ 侦察 ▸ ◉ 运行'],
  ]) {
    setLanguage(lang);
    const summaries = board.workers.flatMap((w) => (w.flow ? [flowSummary(w.flow)] : [])).join('\n');
    assert.ok(summaries.includes(landedText), `${lang}\n${summaries}`);
    assert.ok(summaries.includes(runText), `${lang}\n${summaries}`);
  }

  // Failed land reports the failing stage and error.
  f.put(retryFile, { ...queued, config: { ...queued.config, push: false }, state: 'failed', step: 'fast-forward', error: 'base moved',
    updated_at: new Date(now - 2000).toISOString() }, 0);
  board = await project();
  for (const [lang, failedText] of [
    ['en', '✓ gate ▸ ✗ merge · failed: base moved'],
    ['zh', '✓ 门禁 ▸ ✗ 合并 · 失败：base moved'],
  ]) {
    setLanguage(lang);
    assert.ok(flowSummary(board.workers.find((w) => w.flow?.state === 'failed').flow).includes(failedText), `${lang}: the chain is the card's`);
  }
});
