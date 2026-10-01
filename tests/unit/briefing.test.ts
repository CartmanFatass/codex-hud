import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Briefer, briefingCommand, briefingInput, briefingRequest, completionText, parseBrief, briefSystemPrompt } from '../../src/collectors/briefing.js';
import { initialMonitorState, renderMonitor, handleMonitorInput } from '../../src/render/monitor.js';
import { stripAnsi, visualLength, theme, colors } from '../../src/render/colors.js';
import { WorkbenchInputDecoder } from '../../src/utils/workbench-input.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';

const now = Date.parse('2026-10-01T10:00:00Z');
const node = (id: string, name: string, status: SubagentTreeNode['status'], extra: Partial<SubagentTreeNode> = {}): SubagentTreeNode =>
  ({ id, name, status, depth: 1, children: [], ...extra });
const tree = (nodes: SubagentTreeNode[], rootId = 'root'): SubagentTree => ({ rootId, nodes, totalCount: nodes.length, updatedAt: new Date(now) });

test('the brief covers live, failed and recently finished agents, in that order, and nothing long finished', () => {
  const input = briefingInput(tree([
    node('a', 'old_done', 'completed', { statusAt: new Date(now - 3 * 3600_000) }),
    node('b', 'just_done', 'completed', { statusAt: new Date(now - 60_000), lastReport: { text: 'Result is in', kind: 'reply', at: new Date(now - 60_000) } }),
    node('c', 'worker', 'running', { turnStartedAt: new Date(now - 600_000), lastEventAt: new Date(now - 6 * 60_000), task: 'Review the package',
      lastReport: { text: 'Checking   the\nreader', kind: 'update', at: new Date(now - 30_000) } }),
    node('d', 'broken', 'error'),
  ]), now)!;
  const lines = input.prompt.split('\n');
  assert.equal(lines[0], '<agents>');
  assert.equal(lines.at(-1), '</agents>');
  const order = lines.filter(line => line.startsWith('- ')).map(line => line.slice(2).split(':')[0]);
  assert.deepEqual(order, ['broken', 'worker', 'just_done']);
  assert.match(input.prompt, /worker: status running, turn running 10m, last event 6m ago \(quiet\)/);
  assert.match(input.prompt, /task: Review the package/);
  assert.match(input.prompt, /latest update \(30s ago\): Checking the reader/);
  assert.doesNotMatch(input.prompt, /old_done/);
  assert.equal(briefingInput(tree([node('a', 'old_done', 'completed', { statusAt: new Date(now - 3 * 3600_000) })]), now), null);
});

test('the fingerprint ignores clocks and changes with a new update or status', () => {
  const worker = node('c', 'worker', 'running', { turnStartedAt: new Date(now - 600_000), lastEventAt: new Date(now - 1000),
    lastReport: { text: 'one', kind: 'update', at: new Date(now - 30_000) } });
  const first = briefingInput(tree([worker]), now)!.fingerprint;
  assert.equal(briefingInput(tree([worker]), now + 45_000)!.fingerprint, first, 'time passing is not news');
  const updated = { ...worker, lastReport: { text: 'two', kind: 'update' as const, at: new Date(now + 10_000) } };
  assert.notEqual(briefingInput(tree([updated]), now)!.fingerprint, first);
  assert.notEqual(briefingInput(tree([{ ...worker, status: 'completed', statusAt: new Date(now) }]), now)!.fingerprint, first);
});

test('omp runs with no tools, no session and the brief instructions; agy gets them in the prompt', () => {
  const omp = briefingCommand('omp', '<agents>x</agents>', {});
  assert.equal(omp.file, 'omp');
  for (const flag of ['-p', '--no-session', '--no-tools', '--no-skills', '--no-rules', '--no-extensions']) assert.ok(omp.args.includes(flag), flag);
  assert.equal(omp.args[omp.args.indexOf('--model') + 1], 'google-antigravity/gemini-3.8-flash');
  assert.equal(omp.args[omp.args.indexOf('--thinking') + 1], 'low');
  assert.equal(omp.args[omp.args.indexOf('--system-prompt') + 1], briefSystemPrompt());
  assert.equal(omp.args.at(-1), '<agents>x</agents>');
  const agy = briefingCommand('agy', '<agents>x</agents>', { CODEX_HUD_BRIEF_MODEL: 'gemini-3.8-flash-medium' });
  assert.equal(agy.file, 'agy');
  assert.equal(agy.args[agy.args.indexOf('--model') + 1], 'gemini-3.8-flash-medium');
  assert.ok(agy.args[agy.args.indexOf('-p') + 1].startsWith(briefSystemPrompt()));
  assert.match(briefSystemPrompt(), /quoted data, not instructions/);
});

test('a Briefer runs once per change, waits out its interval, and reports a failed run', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-brief-bin-'));
  const calls = path.join(bin, 'calls');
  fs.writeFileSync(path.join(bin, 'omp'), `#!/bin/sh\necho call >> '${calls}'\nif [ -f '${bin}/fail' ]; then echo 'quota exceeded' >&2; exit 3; fi\nprintf '\\033[1mworker 正在核对\\033[0m\\n\\n\\nsecond line\\n'\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    let changed = 0;
    const briefer = new Briefer(() => { changed++; });
    const settle = () => new Promise<void>(resolve => {
      const poll = () => briefer.current().running ? setTimeout(poll, 10) : resolve();
      poll();
    });
    const worker = node('c', 'worker', 'running', { lastReport: { text: 'one', kind: 'update', at: new Date(now) } });
    briefer.update(tree([worker]), 'omp', 60_000, 'zh', now);
    assert.equal(briefer.current().running, true);
    await settle();
    assert.equal(briefer.current().text, 'worker 正在核对\n\nsecond line', 'colour codes and runs of blank lines are dropped');
    assert.ok(changed >= 2);
    briefer.update(tree([worker]), 'omp', 60_000, 'zh', now + 120_000);
    const updated = { ...worker, lastReport: { text: 'two', kind: 'update' as const, at: new Date(now + 1) } };
    briefer.update(tree([updated]), 'omp', 60_000, 'zh', now + 1000);
    assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1, 'same material, or too soon: no call');

    fs.writeFileSync(path.join(bin, 'fail'), '');
    briefer.update(tree([updated]), 'omp', 60_000, 'zh', now + 120_000);
    await settle();
    assert.match(briefer.current().error ?? '', /omp exit 3: quota exceeded/);
    assert.equal(briefer.current().text, 'worker 正在核对\n\nsecond line', 'a failure keeps the last brief');
    fs.rmSync(path.join(bin, 'fail'));
    briefer.update(tree([updated]), 'omp', 60_000, 'zh', now + 240_000);
    await settle();
    assert.equal(briefer.current().error, undefined, 'the same material is tried again after a failure');

    briefer.update(tree([updated], 'other-session'), 'omp', 60_000, 'zh', now + 250_000);
    assert.equal(briefer.current().text, undefined, 'another session starts from an empty brief');
    await settle();
    briefer.update(tree([updated], 'other-session'), 'off', 60_000, 'zh', now + 400_000);
    assert.deepEqual(briefer.current(), {});
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('the brief fills the room under the agents, wraps Chinese by character and English by word', () => {
  const agents = tree([node('00000000-0000-4000-8000-000000000001', 'worker', 'running', { turnStartedAt: new Date(now - 60_000) })]);
  const text = 'dm_parent_adaptation 静默 9 分钟且运行超 50 分钟，需留意其响应状态。\nsecond\x1b[2J line';
  const frame = renderMonitor({ tree: agents, state: initialMonitorState(), width: 30, height: 20, nowMs: now,
    brief: { text, at: now - 40_000 } });
  const lines = frame.lines.map(stripAnsi);
  const rule = lines.findIndex(line => line.startsWith('─ Brief ─'));
  assert.ok(rule > frame.panes[0].y, 'the brief sits under the agents');
  assert.match(lines[rule], /─ b pause $/, 'no age ticking on the rule; the switch at its end');
  assert.equal(lines[rule + 1].trimEnd(), ' dm_parent_adaptation 静默 9');
  assert.equal(lines[rule + 2].trimEnd(), ' 分钟且运行超 50 分钟，需留意');
  assert.match(lines.join('\n'), /second\\x1b\[2J line/, 'model text is sanitized like any external text');
  assert.ok(frame.lines.every(line => visualLength(line) <= 30));
  const writing = renderMonitor({ tree: agents, state: initialMonitorState(), width: 30, height: 20, nowMs: now, brief: { running: true } });
  assert.ok(writing.lines.map(stripAnsi).some(line => line.startsWith('─ Brief · writing…')));
  const none = renderMonitor({ tree: agents, state: initialMonitorState(), width: 30, height: 20, nowMs: now });
  assert.ok(!none.lines.map(stripAnsi).some(line => line.includes('Brief')), 'briefing off shows nothing');
  const empty = renderMonitor({ tree: agents, state: initialMonitorState(), width: 30, height: 20, nowMs: now, brief: {} });
  assert.ok(empty.lines.map(stripAnsi).some(line => /^─ Brief ─+ b pause $/.test(line)), 'before the first brief, the switch is already there');
});

test('the brief switch pauses by key or click, and a paused brief steps back', () => {
  const agents = tree([node('00000000-0000-4000-8000-000000000001', 'worker', 'running', { turnStartedAt: new Date(now - 60_000) })]);
  const brief = { text: 'still here', at: now - 600_000, paused: true };
  const frame = renderMonitor({ tree: agents, state: initialMonitorState(), width: 30, height: 20, nowMs: now, brief });
  const lines = frame.lines.map(stripAnsi);
  const rule = lines.findIndex(line => line.startsWith('─ Brief · paused'));
  assert.ok(rule > 0);
  assert.match(lines[rule], / b resume $/);
  assert.equal(lines[rule + 1].trimEnd(), ' still here', 'the last brief stays');
  assert.equal(frame.lines[rule + 1], colors.dim(' still here') + ' '.repeat(19));
  const control = frame.controls.find(c => c.kind === 'brief')!;
  assert.equal(control.y, rule);
  assert.equal(control.x + control.width, 30);
  const ctx = { tree: agents, frame };
  assert.deepEqual(handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: control.x + 1, y: rule }, ctx).action, { type: 'brief-toggle' });
  assert.deepEqual(handleMonitorInput(frame.state, { type: 'key', key: 'brief-toggle' }, ctx).action, { type: 'brief-toggle' });
  assert.deepEqual(new WorkbenchInputDecoder('monitor').push(Buffer.from('b')), [{ type: 'key', key: 'brief-toggle' }]);
});

test('the agents summary stays at the top while the list under it scrolls', () => {
  const many = tree(Array.from({ length: 30 }, (_, i) => node(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `agent-${i}`, 'running',
    { turnStartedAt: new Date(now - 1000), startedAt: new Date(now - i * 1000) })));
  const state = initialMonitorState();
  state.tree.selectedId = many.nodes[0].id; // started last, so listed last
  const frame = renderMonitor({ tree: many, state, width: 30, height: 12, nowMs: now });
  const pane = frame.panes[0];
  assert.match(stripAnsi(frame.lines[pane.y]), /30 run/);
  assert.ok(pane.offset > 0);
  assert.ok(frame.lines.some(line => /agent-0\b/.test(stripAnsi(line))), 'the selection is scrolled into view');
});

test('a brief reply is read as JSON when it is JSON, fenced or not, and refused otherwise', () => {
  const reply = '```json\n{"overall":"整体顺利","agents":[{"agent":"calm","attention":false,"note":"在读"},'
    + '{"agent":"alarm","attention":true,"note":"失败"},{"agent":"","note":"x"},{"agent":"bad","note":3}]}\n```';
  assert.deepEqual(parseBrief(reply), { overall: '整体顺利', items: [
    { agent: 'alarm', note: '失败', attention: true }, { agent: 'calm', note: '在读', attention: false }] });
  assert.equal(parseBrief('plain words'), null);
  assert.equal(parseBrief('{"agents": "nope"}'), null);
  assert.equal(parseBrief('{broken'), null);
  assert.equal(parseBrief(`{"agents":[{"agent":"a","note":"${'长'.repeat(500)}"}]}`)!.items[0].note.length, 121);
});

test('each agent in a brief looks like its tree row, and what needs a look leads in the warning colour', () => {
  const quiet = node('00000000-0000-4000-8000-000000000001', 'quiet_one', 'running',
    { turnStartedAt: new Date(now - 20 * 60_000), lastEventAt: new Date(now - 8 * 60_000) });
  const busy = node('00000000-0000-4000-8000-000000000002', 'busy_one', 'running',
    { turnStartedAt: new Date(now - 30_000), lastEventAt: new Date(now - 1000) });
  const brief = { text: 'raw', at: now, overall: '两个在跑',
    items: [{ agent: 'busy_one', note: '正在核对链接', attention: false }, { agent: 'quiet_one', note: '停在保存结果', attention: false },
      { agent: 'ghost', note: '不在树里', attention: false }] };
  const frame = renderMonitor({ tree: tree([busy, quiet]), state: initialMonitorState(), width: 30, height: 30, nowMs: now, brief });
  // Tight on room: blocks follow each other directly.
  const tight = renderMonitor({ tree: tree([busy, quiet]), state: initialMonitorState(), width: 30, height: 14, nowMs: now, brief });
  const lines = tight.lines.map(stripAnsi);
  const rule = lines.findIndex(line => line.startsWith('─ Brief'));
  assert.equal(lines[rule + 1].trimEnd(), ' 两个在跑');
  // The quiet agent leads although the model did not flag it.
  assert.match(lines[rule + 2], /^!▸ quiet_one +$/, 'no clock: the tree row above has it');
  assert.equal(lines[rule + 3].trimEnd(), '   停在保存结果');
  assert.ok(tight.lines[rule + 2].includes(theme.warning('quiet_one')));
  assert.match(lines[rule + 4], /^ ▸ busy_one +$/);
  assert.equal(lines[rule + 5].trimEnd(), '   正在核对链接');
  assert.ok(tight.lines[rule + 4].includes(theme.strong('busy_one')));
  assert.match(lines[rule + 6], /^ · ghost/, 'a name the tree does not know is still shown, without a status');
  // With room to spare, a blank line separates the blocks.
  const roomy = frame.lines.map(stripAnsi);
  const top = roomy.findIndex(line => line.startsWith('─ Brief'));
  assert.deepEqual(roomy.slice(top + 1, top + 5).map(line => line.trimEnd()), [' 两个在跑', '', '!▸ quiet_one', '   停在保存结果']);
  assert.equal(roomy[top + 5].trim(), '');
  assert.ok(frame.lines.every(line => visualLength(line) <= 30));
  const plain = renderMonitor({ tree: tree([busy]), state: initialMonitorState(), width: 30, height: 20, nowMs: now, brief: { text: 'just text', at: now } });
  assert.ok(plain.lines.map(stripAnsi).some(line => line.trimEnd() === ' just text'), 'a reply in another shape is shown as text');
});

test('closing punctuation never starts a brief line', () => {
  const agents = tree([node('00000000-0000-4000-8000-000000000001', 'worker', 'running', { turnStartedAt: new Date(now - 1000) })]);
  // 28 columns of text: the full stop would land alone on the next line.
  const text = '一二三四五六七八九十一二三四。后面';
  const frame = renderMonitor({ tree: agents, state: initialMonitorState(), width: 30, height: 20, nowMs: now, brief: { text, at: now } });
  const lines = frame.lines.map(line => stripAnsi(line).trimEnd());
  assert.ok(!lines.some(line => /^ *[。，]/.test(line)), lines.join('\n'));
  assert.ok(lines.includes(' 四。后面'));
});

test('the brief lists what needs a look, then live agents, then the rest, then finished ones', () => {
  const done = node('00000000-0000-4000-8000-000000000001', 'done_one', 'completed', { statusAt: new Date(now - 60_000) });
  const live = node('00000000-0000-4000-8000-000000000002', 'live_one', 'running', { turnStartedAt: new Date(now - 1000), lastEventAt: new Date(now) });
  const odd = node('00000000-0000-4000-8000-000000000003', 'odd_one', 'unknown');
  const items = ['done_one', 'odd_one', 'live_one', 'flagged_done'].map(agent => ({ agent, note: 'n', attention: agent === 'flagged_done' }));
  const flagged = node('00000000-0000-4000-8000-000000000004', 'flagged_done', 'completed', { statusAt: new Date(now) });
  const frame = renderMonitor({ tree: tree([done, live, odd, flagged]), state: initialMonitorState(), width: 30, height: 40, nowMs: now,
    brief: { text: 'raw', at: now, items } });
  const lines = frame.lines.map(stripAnsi);
  const order = lines.slice(lines.findIndex(line => line.startsWith('─ Brief'))).map(line => line.match(/^.. (\w+_(?:one|done))/)?.[1]).filter(Boolean);
  assert.deepEqual(order, ['flagged_done', 'live_one', 'odd_one', 'done_one']);
});

test('an api brief is one chat completions call: base, model and key fall back sensibly', () => {
  const request = briefingRequest({ base: 'http://localhost:8080/v1/', model: 'qwen', key: '' }, '<agents>x</agents>', { OPENAI_API_KEY: 'sk-env' }, 'en');
  assert.ok(!('error' in request));
  if ('error' in request) return;
  assert.equal(request.url, 'http://localhost:8080/v1/chat/completions');
  assert.equal(request.headers.authorization, 'Bearer sk-env');
  const body = JSON.parse(request.body);
  assert.equal(body.model, 'qwen');
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages.map((m: { role: string }) => m.role), ['system', 'user']);
  assert.equal(body.messages[0].content, briefSystemPrompt('en'));
  assert.equal(body.messages[1].content, '<agents>x</agents>');
  const full = briefingRequest({ base: 'https://x.example/api/chat/completions', model: 'm', key: 'sk-file' }, 'p', { OPENAI_API_KEY: 'sk-env' });
  assert.ok(!('error' in full) && full.url === 'https://x.example/api/chat/completions' && full.headers.authorization === 'Bearer sk-file');
  const openai = briefingRequest({ base: '', model: 'm', key: '' }, 'p', {});
  assert.ok(!('error' in openai) && openai.url === 'https://api.openai.com/v1/chat/completions' && !('authorization' in openai.headers),
    'no key at all: no header, for a local server');
  assert.deepEqual(briefingRequest({ base: '', model: '', key: '' }, 'p', {}), { error: 'api: set briefingApiModel' });
  assert.equal(completionText({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }), 'ab');
  assert.equal(completionText({ choices: [] }), null);
});

test('a Briefer on an api endpoint reads the reply, and reports what the server says when it refuses', async () => {
  const seen: Array<{ auth?: string; body: { model: string } }> = [];
  let status = 200;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status === 200
        ? JSON.stringify({ choices: [{ message: { content: '{"overall":"all fine","agents":[{"agent":"worker","attention":false,"note":"reading"}]}' } }] })
        : JSON.stringify({ error: { message: 'invalid api key' } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const briefer = new Briefer(() => {});
    briefer.configureApi({ base: `http://127.0.0.1:${port}/v1`, model: 'local-model', key: 'sk-test' });
    const settle = () => new Promise<void>(resolve => {
      const poll = () => briefer.current().running ? setTimeout(poll, 10) : resolve();
      poll();
    });
    const worker = node('c', 'worker', 'running', { lastReport: { text: 'one', kind: 'update', at: new Date(now) } });
    briefer.update(tree([worker]), 'api', 60_000, 'en', now);
    assert.equal(briefer.current().running, true);
    await settle();
    assert.equal(briefer.current().overall, 'all fine');
    assert.deepEqual(briefer.current().items, [{ agent: 'worker', note: 'reading', attention: false }]);
    assert.equal(seen[0].auth, 'Bearer sk-test');
    assert.equal(seen[0].body.model, 'local-model');

    status = 401;
    const updated = { ...worker, lastReport: { text: 'two', kind: 'update' as const, at: new Date(now + 1) } };
    briefer.update(tree([updated]), 'api', 60_000, 'en', now + 120_000);
    await settle();
    assert.equal(briefer.current().error, 'api HTTP 401: invalid api key');
    assert.equal(briefer.current().overall, 'all fine', 'a failure keeps the last brief');
  } finally {
    server.close();
  }
});

test('switching language drops the brief in the old one and asks again at once', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-brief-lang-'));
  fs.writeFileSync(path.join(bin, 'omp'), '#!/bin/sh\necho "{\\"overall\\":\\"ok\\",\\"agents\\":[]}"\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const briefer = new Briefer(() => {});
    const settle = () => new Promise<void>(resolve => {
      const poll = () => briefer.current().running ? setTimeout(poll, 10) : resolve();
      poll();
    });
    const worker = node('c', 'worker', 'running', { lastReport: { text: 'one', kind: 'update', at: new Date(now) } });
    briefer.update(tree([worker]), 'omp', 600_000, 'zh', now);
    await settle();
    assert.equal(briefer.current().overall, 'ok');
    briefer.update(tree([worker]), 'omp', 600_000, 'en', now + 1000);
    assert.equal(briefer.current().overall, undefined, 'the old-language brief is gone at once');
    assert.equal(briefer.current().running, true, 'and the new one is being written, interval or not');
    await settle();
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
