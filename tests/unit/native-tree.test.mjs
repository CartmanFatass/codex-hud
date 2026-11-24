import { withState } from '../fixtures/state-helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { nativeFixture, nativeFrames, NOW } from '../fixtures/native-tree.mjs';
import { renderMonitor, initialMonitorState, handleMonitorInput } from '../../dist/render/monitor.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { targetKey } from '../../dist/collectors/workboard-types.js';
import { collectionObservation, jobPanelObservation } from '../../dist/utils/collection-observation.js';
import { recordAdaptivePoll, createAdaptivePollState } from '../../dist/collectors/adaptive-poll.js';
import { callerSession, claudeCallerSession } from '../../dist/collectors/claude-caller-session.js';
import { panelCommand, panelSelection } from '../../dist/cli/panel.js';
const nativePage = () => ({ ...initialMonitorState(), subpage: { kind: 'native-inspector', scroll: 0 } });
function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'native-tree-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return nativeFixture(home);
}
test('Inspector: real Claude meta/transcript collection and Codex three-level tree, 80/120 columns EN/ZH', (t) => {
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
      const frame = f.render(width, lang, nativePage()),
        text = frame.lines.map(stripAnsi).join('\n');
      for (const line of frame.lines) assert.equal(visualLength(line), width);
      assert.match(text, /Repair parser/);
      assert.match(text, /Review schema/);
      assert.match(text, /^ +Check parser tests/m);
      assert.match(text, /^ +Verify index/m);
      assert.doesNotMatch(text, /PRIVATE-CLAUDE|PRIVATE-CHANNEL|Agents/);
    }
});
for (const finished of [undefined, false]) test(`Claude real-shaped running metadata (finished=${finished}) reaches the native Inspector, then completes`, (t) => {
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
    const text = f.render(120, 'zh', nativePage(), tree).lines.map(stripAnsi).join('\n');
    assert.match(text, /Repair parser/);
  };
  check(false); check(false);
  assert.equal(f.collector.bytes, 0, 'unchanged running metadata remains stat-only');
  f.put(file, { ...meta, finished: true });
  check(true);
  assert.equal(f.collector.bytes, fs.statSync(file).size, 'completion reads only changed metadata');
  check(true);
  assert.equal(f.collector.bytes, 0);
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
test('finished Claude metadata survives multi-pass replay and retains the original final reply', (t) => {
  const f = resumedFixture(t), settledAt = NOW - 9 * 60 * 60_000;
  f.metadata(true, settledAt);
  f.put(f.file, [0, 1, 2].map((i) => f.record(
    [{ type: 'text', text: 'x'.repeat(800_000) + (i === 2 ? 'FINAL-REPLAY-RESULT' : 'Historical progress') }],
    settledAt - (2 - i) * 1000, 'end_turn'
  )).join(''));
  fs.utimesSync(f.file, new Date(settledAt), new Date(settledAt));
  let passes = 0, tree;
  do {
    tree = f.claude();
    const node = tree.nodes[0], board = f.board(tree);
    assert.equal(node.status, 'completed', 'replay does not reopen metadata completion');
    assert.equal(node.statusAt.getTime(), settledAt);
    assert.equal(board.workers[0].state, 'done');
    assert.equal(board.workers[0].settledAt, settledAt);
    passes++;
    if (tree.incomplete) assert.equal(node.replaying, true);
    assert.ok(passes <= 4);
  } while (tree.incomplete);
  assert.equal(passes, 4, 'one tail preview followed by three forward chunks');
  assert.match(tree.nodes[0].lastReport.text, /FINAL-REPLAY-RESULT$/);
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
async function foregroundCaller(t, f, args = ['--here'], ready = 'Native tree unavailable') {
  const runner = join(f.home, 'runner.mjs');
  const scanFile = join(f.home, 'native-scans'), probe = join(f.home, 'native-probe.mjs');
  fs.rmSync(scanFile, { force: true });
  fs.writeFileSync(probe, `import {appendFileSync} from 'node:fs';
import {ClaudeNativeTree} from ${JSON.stringify(pathToFileURL(resolve('dist/collectors/claude-native-tree.js')).href)};
const refresh=ClaudeNativeTree.prototype.refresh;
ClaudeNativeTree.prototype.refresh=function(...args){appendFileSync(${JSON.stringify(scanFile)},'scan\\n');return refresh.apply(this,args);};`);
  fs.writeFileSync(runner, `import {panelCommand} from ${JSON.stringify(pathToFileURL(resolve('dist/cli/panel.js')).href)};process.exitCode=await panelCommand({env:process.env,stdout:s=>process.stdout.write(s),stderr:s=>process.stderr.write(s)},${JSON.stringify(args)});`);
  // --here uses a separate panel executable. Preload the probe there as well as in the CLI process.
  const env = { ...f.env, NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(probe).href}`.trim() };
  const child = spawn(process.execPath, [runner], { cwd: f.home, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', b => output += b);
  child.stderr.on('data', b => errors += b);
  const exited = new Promise(r => child.once('exit', r));
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await t.waitFor(() => assert.match(stripAnsi(output), /Nothing needs you/), { timeout: 10_000 });
  assert.equal(fs.existsSync(scanFile), false, 'Home must not scan Claude native transcripts');
  child.stdin.write('v');
  await t.waitFor(() => assert.match(stripAnsi(output), /n subagents/), { timeout: 10_000 });
  assert.equal(fs.existsSync(scanFile), false, 'Jobs must not scan Claude native transcripts');
  child.stdin.write('n');
  await t.waitFor(() => assert.match(stripAnsi(output), new RegExp(ready), errors), { timeout: 10_000 });
  if (ready === 'Repair parser') assert.ok(fs.existsSync(scanFile));
  child.stdin.end();
  assert.equal(await exited, 0, errors);
  return stripAnsi(output);
}
test('current w4E:p1 binds before splitting; real foreground panel scans the Claude tree on demand; statusline writes no binding', async t => {
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
  assert.match(await foregroundCaller(t, f, ['--here'], 'Repair parser'), /Repair parser/);
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

test('Codex caller binds via herdr pane current or CODEX_THREAD_ID, passes --harness codex --session --source, and renders Codex in panel', async t => {
  const f = callerFixture(t);
  const codexSession = '22222222-2222-4222-8222-222222222222';
  const childSession = '33333333-3333-4333-8333-333333333333';
  const codexHome = f.env.CODEX_HOME;
  f.env.TZ = process.env.TZ;
  const started = new Date(2026, 10, 17, 23, 29);
  const stamp = started.toISOString();
  // Codex puts rollouts under the local calendar date, even though event timestamps are UTC.
  const pad = (n) => String(n).padStart(2, '0');
  const date = [String(started.getFullYear()), pad(started.getMonth() + 1), pad(started.getDate())];
  const time = [started.getHours(), started.getMinutes(), started.getSeconds()].map(pad).join('-');
  const sessionDir = join(codexHome, 'sessions', ...date);
  fs.mkdirSync(sessionDir, { recursive: true });
  const writeRollout = (id, lines) => {
    const file = join(sessionDir, `rollout-${date.join('-')}T${time}-${id}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    fs.utimesSync(file, started, started);
  };
  writeRollout(codexSession, [
    JSON.stringify({ type: 'session_meta', timestamp: stamp, payload: { id: codexSession, cwd: f.home, model: 'gpt-5' } }),
    JSON.stringify({ type: 'event_msg', timestamp: stamp, payload: { type: 'task_started' } }),
  ]);
  writeRollout(childSession, [
    JSON.stringify({ type: 'session_meta', timestamp: stamp, payload: {
      id: childSession, cwd: f.home, model: 'gpt-5',
      source: { subagent: { thread_spawn: { parent_thread_id: codexSession, depth: 1 } } },
      parent_thread_id: codexSession, agent_nickname: 'codex-sub', agent_role: 'reviewer',
    } }),
    JSON.stringify({ type: 'event_msg', timestamp: stamp, payload: { type: 'task_started' } }),
  ]);

  // 1) pane.agent_session reports codex (even if pane.agent is omitted or 'codex')
  f.setReply({ result: { type: 'pane_current', pane: { pane_id: 'w4E:p1', cwd: f.home, agent_session: { agent: 'codex', kind: 'id', source: 'herdr:codex', value: codexSession } } } });
  const bound = await callerSession(f.env);
  assert.deepEqual(bound, { harness: 'codex', session: codexSession, source: codexHome });
  const selected = panelSelection(['--harness', bound.harness, '--session', bound.session, '--source', bound.source]);
  assert.equal(selected.harness, 'codex');
  assert.equal(selected.source, codexHome);
  assert.ok(selected.root?.endsWith('/' + codexSession), selected.root);

  await panelCommand({ env: f.env, stdout: () => {}, stderr: () => {} });
  const runCmd = f.calls().findLast(c => c[1] === 'run')[3];
  assert.ok(runCmd.includes("'--harness' 'codex'"), runCmd);
  assert.ok(runCmd.includes(`'--session' '${codexSession}'`), runCmd);
  assert.ok(runCmd.includes(`'--source' '${codexHome}'`), runCmd);

  // Pin only the child clock so the parent's foreground wait still has a real timeout.
  for (const [day, hour] of [[17, 23], [18, 0]]) {
    const now = new Date(2026, 10, day, hour, 30).getTime();
    const clock = encodeURIComponent(`import { mock } from 'node:test';
mock.timers.enable({ apis: ['Date'], now: ${now} });`);
    const env = { ...f.env, NODE_OPTIONS: `--import=data:text/javascript,${clock}` };
    assert.match(await foregroundCaller(t, { ...f, env }, ['--here'], 'codex-sub'), /codex-sub/,
      `Codex lane at ${pad(hour)}:30 local time`);
  }

  // 2) Fallback via CODEX_THREAD_ID inside a herdr pane when agent_session is absent
  f.setReply({ result: { type: 'pane_current', pane: { pane_id: 'w4E:p1', cwd: f.home } } });
  assert.deepEqual(await callerSession({ ...f.env, CODEX_THREAD_ID: codexSession }), {
    harness: 'codex', session: codexSession, source: codexHome,
  });

  // 3) Outside herdr, callerSession returns undefined without querying herdr
  const outside = { ...f.env, CODEX_THREAD_ID: codexSession };
  delete outside.HERDR_PANE_ID;
  assert.equal(await callerSession(outside), undefined);
});
