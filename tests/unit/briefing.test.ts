import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SmallModel } from '../../src/collectors/small-model.js';
import { Briefer, briefingCommand, briefingRequest, completionText, parseBrief, briefSystemPrompt } from '../../src/collectors/briefing.js';
import { initialMonitorState, renderMonitor, handleMonitorInput } from '../../src/render/monitor.js';
import { stripAnsi, visualLength, theme, colors } from '../../src/render/colors.js';
import { WorkbenchInputDecoder } from '../../src/utils/workbench-input.js';
import { AgentLog } from '../../src/collectors/agent-log.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';

const now = Date.parse('2026-10-01T10:00:00Z');
const node = (id: string, name: string, status: SubagentTreeNode['status'], extra: Partial<SubagentTreeNode> = {}): SubagentTreeNode =>
  ({ id, name, status, depth: 1, children: [], ...extra });
const tree = (nodes: SubagentTreeNode[], rootId = 'root'): SubagentTree => ({ rootId, nodes, totalCount: nodes.length, updatedAt: new Date(now) });

/** Exercise the shared service without binaries, environment changes or network calls. */
function stubModel(reply: string) {
  const asked: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const response = { status: 200 };
  const model = new SmallModel({ env: {}, fetch: (async (_url, init) => {
    asked.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(response.status === 200
      ? { choices: [{ message: { content: reply } }] }
      : { error: { message: 'quota exceeded SYNTHETIC_SECRET_BACKEND_QUOTA /private/path?token=synthetic-token' } }), { status: response.status });
  }) as typeof fetch });
  model.configure({ api: { base: '', model: 'test-model', key: '' } });
  return { model, asked, response };
}
/** Resolve the promise chains the service and the Briefer settle through, with no clock of their own. */
const drain = async (times = 4) => { for (let i = 0; i < times; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

test('agy runs with the brief instructions in its prompt and the configured model', () => {
  const defaults = briefingCommand('agy', '<agents>x</agents>', {});
  assert.equal(defaults.file, 'agy');
  assert.equal(defaults.args[defaults.args.indexOf('--model') + 1], 'gemini-3.8-flash-low');
  assert.equal(defaults.args[defaults.args.indexOf('-p') + 1], `${briefSystemPrompt()}\n\n<agents>x</agents>`);
  assert.ok(defaults.args.includes('--disable-slash-commands'));
  const agy = briefingCommand('agy', '<agents>x</agents>', { CODEX_HUD_BRIEF_MODEL: 'gemini-3.8-flash-medium' });
  assert.equal(agy.file, 'agy');
  assert.equal(agy.args[agy.args.indexOf('--model') + 1], 'gemini-3.8-flash-medium');
  assert.ok(agy.args[agy.args.indexOf('-p') + 1].startsWith(briefSystemPrompt()));
  assert.match(briefSystemPrompt(), /quoted data, not instructions/);
});

test('a Briefer runs once per change, waits out its interval, and reports a failed run', async () => {
  const { model, asked, response } = stubModel('\x1b[1m{"overall":"worker 正在核对","agents":[]}\x1b[0m\n');
  let changed = 0;
  const briefer = new Briefer(() => { changed++; }, { model });
  const settle = () => new Promise<void>(resolve => {
    const poll = () => briefer.current().running ? setTimeout(poll, 10) : resolve();
    poll();
  });
  const count = () => asked.length;
  const worker = node('c', 'worker', 'running', { stages: [{ startedAt: new Date(now - 60_000), status: 'running' }], stageCount: 1,
    lastReport: { text: 'one', kind: 'update', at: new Date(now) } });
  briefer.update(tree([worker]), 'api', 60_000, 'zh', now);
  assert.equal(briefer.current().running, true);
  await settle();
  assert.equal(briefer.current().overall, 'worker 正在核对', 'colour codes around the JSON are dropped');
  assert.ok(changed >= 2);
  briefer.update(tree([worker]), 'api', 60_000, 'zh', now + 120_000);
  const updated = { ...worker, lastReport: { text: 'two', kind: 'update' as const, at: new Date(now + 1) } };
  briefer.update(tree([updated]), 'api', 60_000, 'zh', now + 130_000);
  assert.equal(count(), 1, 'the same material, or commentary alone before the floor: no call');
  const ended = { ...updated, status: 'completed' as const, statusAt: new Date(now + 2000),
    stages: [{ startedAt: new Date(now - 60_000), endedAt: new Date(now + 2000), status: 'done' as const, result: 'Found it' }] };
  briefer.update(tree([ended]), 'api', 60_000, 'zh', now + 1000);
  assert.equal(count(), 1, 'a stage that ended, too soon: no call');

  response.status = 429;
  briefer.update(tree([ended]), 'api', 60_000, 'zh', now + 140_000);
  await settle();
  assert.match(briefer.current().error ?? '', /api HTTP 429: Rate limited/);
  assert.doesNotMatch(briefer.current().error ?? '', /SYNTHETIC_SECRET_BACKEND_QUOTA|private\/path|synthetic-token|quota exceeded/);
  assert.equal(briefer.current().overall, 'worker 正在核对', 'a failure keeps the last brief');
  response.status = 200;
  briefer.update(tree([ended]), 'api', 60_000, 'zh', now + 240_000);
  await settle();
  assert.equal(briefer.current().error, undefined, 'the same material is tried again after a failure');

  briefer.update(tree([ended], 'other-session'), 'api', 60_000, 'zh', now + 250_000);
  assert.equal(briefer.current().overall, undefined, 'another session starts from an empty brief');
  await settle();
  briefer.update(tree([ended], 'other-session'), 'off', 60_000, 'zh', now + 400_000);
  assert.deepEqual(briefer.current(), {});
});

test('the brief fills the room under the agents, wraps Chinese by character and English by word', () => {
  const agents = tree([node('00000000-0000-4000-8000-000000000001', 'worker', 'running', { turnStartedAt: new Date(now - 60_000) })]);
  const text = 'dm_parent_adaptation 静默 9 分钟且运行超 50 分钟，需留意其响应状态。\nsecond\x1b[2J line';
  const frame = renderMonitor({ tree: agents, state: initialMonitorState(), width: 30, height: 20, nowMs: now,
    brief: { text, at: now - 40_000 } });
  const lines = frame.lines.map(stripAnsi);
  const rule = lines.findIndex(line => line.startsWith('─ Brief ─'));
  assert.ok(rule > frame.panes[0].y, 'the brief sits under the agents');
  assert.match(lines[rule], /^─ Brief ─+$/, 'no age ticking on the rule, and no switch on it');
  assert.ok(lines[0].includes('ǁ'), 'the button is on the bar');
  assert.equal(lines[rule + 1].trimEnd(), ' dm_parent_adaptation 静默 9');
  assert.equal(lines[rule + 2].trimEnd(), ' 分钟且运行超 50 分钟，需留意');
  assert.match(lines.join('\n'), /second\\x1b\[2J line/, 'model text is sanitized like any external text');
  assert.ok(frame.lines.every(line => visualLength(line) <= 30));
  const writing = renderMonitor({ tree: agents, state: initialMonitorState(), width: 30, height: 20, nowMs: now, brief: { running: true } });
  assert.ok(writing.lines.map(stripAnsi).some(line => line.startsWith('─ Brief · writing…')));
  const none = renderMonitor({ tree: agents, state: initialMonitorState(), width: 30, height: 20, nowMs: now });
  assert.ok(!none.lines.map(stripAnsi).some(line => line.includes('Brief')), 'briefing off shows nothing');
  const empty = renderMonitor({ tree: agents, state: initialMonitorState(), width: 30, height: 20, nowMs: now, brief: {} });
  assert.ok(empty.lines.map(stripAnsi).some(line => /^─ Brief ─+$/.test(line)));
  assert.ok(stripAnsi(empty.lines[0]).includes('ǁ'), 'before the first brief, the button is already there');
  assert.ok(!stripAnsi(none.lines[0]).includes('ǁ') && !stripAnsi(none.lines[0]).includes('▶'), 'no brief, no button');
});

test('the brief switch pauses by key or click, and a paused brief steps back', () => {
  const agents = tree([node('00000000-0000-4000-8000-000000000001', 'worker', 'running', { turnStartedAt: new Date(now - 60_000) })]);
  const brief = { text: 'still here', at: now - 600_000, paused: true };
  const frame = renderMonitor({ tree: agents, state: initialMonitorState(), width: 30, height: 20, nowMs: now, brief });
  const lines = frame.lines.map(stripAnsi);
  const rule = lines.findIndex(line => line.startsWith('─ Brief · paused'));
  assert.ok(rule > 0);
  assert.match(lines[rule], /^─ Brief · paused ─+$/);
  assert.ok(lines[0].includes('▶'));
  assert.equal(lines[rule + 1].trimEnd(), ' still here', 'the last brief stays');
  assert.equal(frame.lines[rule + 1], colors.dim(' still here') + ' '.repeat(19));
  const control = frame.controls.find(c => c.kind === 'brief')!;
  assert.equal(control.y, 0, 'on the bar');
  assert.equal([...stripAnsi(frame.lines[0])].slice(control.x, control.x + control.width).join('').trim(), '▶', 'the whole chip, counted by columns');
  const ctx = { tree: agents, frame };
  assert.deepEqual(handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: control.x, y: 0 }, ctx).action, { type: 'brief-toggle' });
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
  assert.match(stripAnsi(frame.lines[pane.y]), /^ ▦ Agents {2}▸30 run +\d+–30\/30 $/, 'its title, and which rows are in view');
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

test('each agent in the log looks like its tree row, newest news first, and what needs a look is in the warning colour', () => {
  const quiet = node('00000000-0000-4000-8000-000000000001', 'quiet_one', 'running',
    { turnStartedAt: new Date(now - 20 * 60_000), lastEventAt: new Date(now - 8 * 60_000) });
  const busy = node('00000000-0000-4000-8000-000000000002', 'busy_one', 'running',
    { turnStartedAt: new Date(now - 30_000), lastEventAt: new Date(now - 1000) });
  const agentLog = new Map([
    [quiet.id, [{ at: now - 20 * 60_000, kind: 'started' as const, text: '' }, { at: now - 9 * 60_000, kind: 'note' as const, text: '停在保存结果' }]],
    [busy.id, [{ at: now - 30_000, kind: 'started' as const, text: '' }, { at: now - 10_000, kind: 'report' as const, text: 'Checking links' },
      { at: now - 5000, kind: 'note' as const, text: '正在核对链接' }]],
  ]);
  const state = initialMonitorState();
  state.tree.selectedId = null;
  const brief = { text: 'raw', at: now, overall: '两个在跑', items: [] };
  const tight = renderMonitor({ tree: tree([busy, quiet]), state, width: 30, height: 18, nowMs: now, brief, agentLog });
  const lines = tight.lines.map(stripAnsi);
  const rule = lines.findIndex(line => line.startsWith('─ Brief'));
  assert.equal(lines[rule + 1].trimEnd(), ' ▸ 两个在跑');
  assert.equal(lines[rule + 2].trim(), '', 'a blank line between the brief and the log');
  // Selected first, then newest news: the busy agent's note is newer.
  const sel = tight.state.tree.selectedId;
  const first = sel === busy.id ? 'busy_one' : 'quiet_one';
  assert.match(lines[rule + 3], new RegExp(`^.▸ ${first} +$`));
  const busyAt = lines.findIndex(line => /^ ▸ busy_one/.test(line));
  assert.ok(tight.lines[busyAt].includes(theme.strong('busy_one')));
  assert.equal(lines[busyAt + 1].trimEnd(), '   5s  ~ 正在核对链接', 'newest first, a model note marked, the ages in a column');
  assert.equal(lines[busyAt + 2].trimEnd(), '   10s Checking links');
  const quietAt = lines.findIndex(line => /^!▸ quiet_one/.test(line));
  assert.ok(quietAt > 0, 'the quiet agent is flagged although the model did not flag it');
  assert.ok(tight.lines[quietAt].includes(theme.warning('quiet_one')));
  assert.ok(tight.lines.every(line => visualLength(line) <= 30));
  // A click on a log line selects its agent.
  const control = tight.controls.find(c => c.kind === 'log' && c.item === quiet.id)!;
  const picked = handleMonitorInput(tight.state, { type: 'mouse', button: 'left', x: 2, y: control.y }, { tree: tree([busy, quiet]), frame: tight });
  assert.equal(picked.state.tree.selectedId, quiet.id);
  assert.equal(picked.action, undefined, 'selecting from the log does not switch the Codex session');
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
  // The stop takes the word before it down with it; how much that is depends on the segmenter.
  assert.ok(lines.some(line => /^ \S*四。后面$/.test(line)), lines.join('\n'));
});

test('the log follows the tree: what the tree hides it hides, a collapsed parent counts what is folded, the Inspector has it all', () => {
  const child = node('00000000-0000-4000-8000-000000000011', 'child_one', 'running', { depth: 2, turnStartedAt: new Date(now - 60_000) });
  const parent = node('00000000-0000-4000-8000-000000000010', 'parent_one', 'running', { turnStartedAt: new Date(now - 120_000), children: [child] });
  const old = node('00000000-0000-4000-8000-000000000012', 'old_one', 'completed', { statusAt: new Date(now - 3 * 3600_000) });
  const agentLog = new Map([
    [child.id, [{ at: now - 60_000, kind: 'started' as const, text: '' }]],
    [parent.id, [{ at: now - 120_000, kind: 'started' as const, text: '' }, { at: now - 30_000, kind: 'note' as const, text: 'Reading the **parser**' }]],
    [old.id, [{ at: now - 3 * 3600_000, kind: 'finished' as const, text: '' }]],
  ]);
  const agents = tree([parent, old]);
  const state = initialMonitorState();
  state.tree.selectedId = parent.id;
  state.tree.lingerMs = 180_000;
  const open = renderMonitor({ tree: agents, state, width: 30, height: 30, nowMs: now, brief: {}, agentLog }).lines.map(stripAnsi);
  assert.ok(open.some(line => /▸ child_one/.test(line) && !line.includes('├')), 'a shown child has its log');
  assert.ok(!open.slice(open.findIndex(line => line.startsWith('─ Brief'))).some(line => /old_one/.test(line)), 'put away by the linger window: not in the log');
  const collapsed = { ...state, tree: { ...state.tree, collapsed: new Set([parent.id]) } };
  const folded = renderMonitor({ tree: agents, state: collapsed, width: 30, height: 30, nowMs: now, brief: {}, agentLog }).lines.map(stripAnsi);
  const from = folded.findIndex(line => line.startsWith('─ Brief'));
  assert.ok(!folded.slice(from).some(line => /child_one/.test(line)));
  assert.ok(folded.slice(from).some(line => line.trim() === '+1 folded below'));
  const all = { ...state, tree: { ...state.tree, showAll: true } };
  const shown = renderMonitor({ tree: agents, state: all, width: 30, height: 30, nowMs: now, brief: {}, agentLog }).lines.map(stripAnsi);
  assert.ok(shown.slice(shown.findIndex(line => line.startsWith('─ Brief'))).some(line => /old_one/.test(line)), 'shown again with everything');
  const off = renderMonitor({ tree: agents, state, width: 30, height: 30, nowMs: now, agentLog }).lines.map(stripAnsi);
  assert.ok(off.some(line => line.startsWith('─ Agent log')), 'with no brief, the log has a rule of its own');
  assert.ok(!/[ǁ▶]/.test(off[0]), 'no brief, no switch on the bar');
  const inspect = { ...state, modes: { ...state.modes, details: 'open' as const }, focus: 'details' as const };
  const detail = renderMonitor({ tree: agents, state: inspect, width: 40, height: 40, nowMs: now, agentLog }).lines.map(stripAnsi);
  const summary = detail.findIndex(line => /── ~ Model summary /.test(line));
  assert.ok(summary > 0, detail.join('\n'));
  assert.equal(detail[summary + 1].trimEnd(), '│   Reading the parser', 'newest model note has its own section, markdown removed');
  assert.match(detail[summary + 2], /Recorded:/);
  assert.ok(!detail.some(line => /── Log /.test(line)), 'a start alone needs no duplicated history section');
  // Started alone says no more than the status line: no log.
  const childOnly = renderMonitor({ tree: agents, state: { ...inspect, tree: { ...inspect.tree, selectedId: child.id } }, width: 40, height: 40, nowMs: now, agentLog }).lines.map(stripAnsi);
  assert.ok(childOnly.some(line => /child_one/.test(line)) && !childOnly.some(line => /── Log /.test(line)));
});

test('the Inspector\'s log leaves out the update shown above it', () => {
  const at = new Date(now - 60_000);
  const reader = node('00000000-0000-4000-8000-000000000021', 'reader', 'running',
    { turnStartedAt: new Date(now - 120_000), lastReport: { text: 'Read **all** the files', kind: 'reply', at } });
  const agentLog = new Map([[reader.id, [{ at: now - 120_000, kind: 'started' as const, text: '' },
    { at: at.getTime(), kind: 'report' as const, text: 'Read **all** the files' }, { at: now - 30_000, kind: 'note' as const, text: 'Moving on to the tests' }]]]);
  const state = initialMonitorState();
  state.tree.selectedId = reader.id;
  const inspect = { ...state, modes: { ...state.modes, details: 'open' as const }, focus: 'details' as const };
  const frame = renderMonitor({ tree: tree([reader]), state: inspect, width: 40, height: 40, nowMs: now, agentLog }).lines.map(stripAnsi);
  const lines = frame.slice(frame.findIndex(line => line.includes('◫ Inspector')));
  assert.equal(lines.filter(line => line.includes('Read all the files')).length, 1, lines.join('\n'));
  assert.ok(lines.some(line => /── ~ Model summary /.test(line)), lines.join('\n'));
  assert.equal(lines.filter(line => /Moving on to the tests/.test(line)).length, 1, 'latest note is not duplicated in the log');
  assert.ok(lines.some(line => /Recorded:/.test(line)), 'legacy note time is recorded, not guessed coverage');
});

test('an api brief is one chat completions call: base, model and key fall back sensibly', () => {
  const request = briefingRequest({ base: 'http://localhost:8080/v1/', model: 'qwen', key: '' }, '<agents>x</agents>', { OPENAI_API_KEY: 'sk-env' }, 'en');
  assert.ok(!('error' in request));
  if ('error' in request) return;
  assert.equal(request.url, 'http://localhost:8080/v1/chat/completions');
  assert.equal(request.headers.authorization, undefined, 'custom endpoints must not inherit OPENAI_API_KEY');
  const hudKey = briefingRequest({ base: 'http://localhost:8080/v1', model: 'qwen', key: '' }, 'p', { CODEX_HUD_BRIEF_API_KEY: 'sk-hud' });
  assert.ok(!('error' in hudKey) && hudKey.headers.authorization === 'Bearer sk-hud');
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
  const defaults = briefingRequest({ base: '', model: '', key: '' }, 'p', {});
  assert.ok(!('error' in defaults));
  if (!('error' in defaults)) assert.equal(JSON.parse(defaults.body).model, 'gemini-3.8-flash-low');
  assert.equal(completionText({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }), 'ab');
  assert.equal(completionText({ choices: [] }), null);
});

test('a Briefer on an api endpoint reads the reply and reports a safe classification when refused', async () => {
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
        : JSON.stringify({ error: { message: 'invalid api key SYNTHETIC_SECRET_BACKEND_AUTH sk-test /private/path?token=synthetic-token' } }));
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
    const updated = { ...worker, status: 'completed' as const, statusAt: new Date(now + 1) };
    briefer.update(tree([updated]), 'api', 60_000, 'en', now + 120_000);
    await settle();
    assert.equal(briefer.current().error, 'api HTTP 401: Authentication failed');
    assert.doesNotMatch(briefer.current().error ?? '', /SYNTHETIC_SECRET_BACKEND_AUTH|sk-test|private\/path|synthetic-token|invalid api key/);
    assert.equal(briefer.current().overall, 'all fine', 'a failure keeps the last brief');
  } finally {
    server.close();
  }
});

test('switching language drops the brief in the old one and asks again at once', async () => {
  const { model } = stubModel('{"overall":"ok","agents":[]}');
  const briefer = new Briefer(() => {}, { model });
  const settle = () => new Promise<void>(resolve => {
    const poll = () => briefer.current().running ? setTimeout(poll, 10) : resolve();
    poll();
  });
  const worker = node('c', 'worker', 'running', { lastReport: { text: 'one', kind: 'update', at: new Date(now) } });
  briefer.update(tree([worker]), 'api', 600_000, 'zh', now);
  await settle();
  assert.equal(briefer.current().overall, 'ok');
  briefer.update(tree([worker]), 'api', 600_000, 'en', now + 1000);
  assert.equal(briefer.current().overall, undefined, 'the old-language brief is gone at once');
  assert.equal(briefer.current().running, true, 'and the new one is being written, interval or not');
  await settle();
});

test('the brief writes in the panel\'s language whatever the material is in, and asked to, names what each agent is on', () => {
  for (const language of ['en', 'zh'] as const) {
    assert.match(briefSystemPrompt(language), /whatever language the material is in.*translate/s, language);
    assert.match(briefSystemPrompt(language, 'both'), /translate/, 'the recap too');
  }
  assert.doesNotMatch(briefSystemPrompt('en'), /"label"/);
  assert.match(briefSystemPrompt('en', 'agents', true), /"label": string, "kind": string/);
  assert.match(briefSystemPrompt('zh', 'agents', true), /label: Simplified Chinese, about 10 Chinese characters/);
  assert.match(briefSystemPrompt('en', 'both', true), /"label": string/);
  assert.doesNotMatch(briefSystemPrompt('en', 'main', true), /"label"/, 'no agents asked for, no labels');
  const parsed = parseBrief(JSON.stringify({ overall: 'x', agents: [
    { agent: 'a', attention: false, note: 'n', label: ' "Cache  audit." ', kind: 'review' },
    { agent: 'b', attention: false, note: 'n', label: 'Cache tests', kind: 'nonsense' },
    { agent: 'c', attention: false, note: 'n', label: '  ' },
  ] }))!;
  assert.deepEqual(parsed.items.map(item => [item.label, item.kind]), [['Cache audit', 'review'], ['Cache tests', undefined], [undefined, undefined]]);
});

test('a brief\'s names land on its notes in its language, and a note in the other language is not handed back as the previous brief', async () => {
  const reply = JSON.stringify({ overall: 'One agent at work', agents: [{ agent: 'worker', attention: false, note: 'Reading the cache module', label: 'Cache audit', kind: 'research' }] });
  const { model, asked } = stubModel(reply);
  const log = new AgentLog();
  log.add('c', [{ at: now - 5000, kind: 'note', text: '正在核对缓存路径', lang: 'zh', label: '缓存核对' }]);
  const briefer = new Briefer(() => {}, { log, model });
  const settle = () => new Promise<void>(resolve => {
    const poll = () => briefer.current().running ? setTimeout(poll, 10) : resolve();
    poll();
  });
  const worker = node('c', 'worker', 'running', { lastReport: { text: 'one', kind: 'update', at: new Date(now) } });
  briefer.update(tree([worker]), 'api', 600_000, 'en', now, false, { scope: 'agents', main: null, floorMs: 900_000, labels: true });
  await settle();
  const request = asked[0].messages.map(message => message.content).join("\n");
  assert.match(request, /"label": string/);
  assert.doesNotMatch(request, /正在核对缓存路径|缓存核对/, 'the Chinese note is not the previous brief in English');
  assert.equal(briefer.current().overall, 'One agent at work');
  const note = log.entries('c').at(-1)!;
  assert.deepEqual([note.text, note.lang, note.label, note.taskKind], ['Reading the cache module', 'en', 'Cache audit', 'research']);
  assert.deepEqual(log.label('c', 'zh'), { name: '缓存核对' }, 'the Chinese name stays for the Chinese panel');
});

test('a run cancelled by a settings change is no failure: the last brief stays, the material is asked about again', async () => {
  const { model, asked } = stubModel('{"overall":"ok","agents":[]}');
  const briefer = new Briefer(() => {}, { model });
  const worker = node('c', 'worker', 'running', { lastReport: { text: 'one', kind: 'update', at: new Date(now) } });
  briefer.update(tree([worker]), 'api', 600_000, 'en', now);
  assert.equal(briefer.current().running, true);
  // Saving the settings cancels whatever is queued or running; the reply settles cancelled.
  model.configure({ api: { base: 'http://other.invalid/v1', model: 'test-model', key: '' } });
  await drain();
  const brief = briefer.current();
  assert.equal(brief.running, false);
  assert.equal(brief.error, undefined, 'a cancelled run is not a failed one');
  assert.equal(brief.overall, undefined, 'it wrote nothing');
  assert.equal(asked.length, 1, 'nothing was sent to the new destination either');
  // The same material is news again once the interval has passed.
  briefer.update(tree([worker]), 'api', 600_000, 'en', now + 600_000);
  assert.equal(briefer.current().running, true, 'asked about again, not held by a false failure');
  await drain();
  assert.equal(briefer.current().overall, 'ok');
  briefer.stop();
});
