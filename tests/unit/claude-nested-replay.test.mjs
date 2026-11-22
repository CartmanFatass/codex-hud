import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { longClaudeTranscript, nativeFixture, NOW } from '../fixtures/native-tree.mjs';
import { withState } from '../fixtures/state-helpers.mjs';
import { JobSentences } from '../../dist/collectors/job-sentences.js';
import { targetKey } from '../../dist/collectors/workboard-types.js';
import { initialMonitorState } from '../../dist/render/monitor.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';

const CHUNK = 1048576;
const TAIL = 65536;
const READ_BUDGET = 4 * (CHUNK + 8192) + 16 * (TAIL + 8192);
const message = (content, at = NOW - 60000) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    message: { content },
  }) + '\n';
const call = (id = 'nested-call', name = 'Agent') => message([{ type: 'tool_use', id, name }]);
const padding = () => message([{ type: 'text', text: 'Synthetic filler. '.repeat(256) }]).repeat(300);
function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'claude-replay-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const f = nativeFixture(home);
  return { ...f, file: join(f.dir, 'agent-lead.jsonl') };
}
function drain(f) {
  let tree;
  for (let pass = 0; pass < 10; pass++) {
    tree = f.claude();
    assert.ok(f.collector.bytes <= READ_BUDGET);
    if (!tree.incomplete) return tree;
  }
  assert.fail('a few-MB transcript must finish replay within ten refreshes');
}

test('5 MB Claude parent shows its latest step in the first frame, then fills in nesting without flashing back', (t) => {
  const f = fixture(t), body = longClaudeTranscript();
  assert.ok(Buffer.byteLength(body) > 4 * CHUNK && Buffer.byteLength(body) <= 5 * CHUNK);
  f.put(f.file, body);
  const first = f.claude();
  assert.equal(first.incomplete, true);
  assert.equal(first.nodes.length, 1, 'unresolved nested child is not a top-level card during replay');
  assert.equal(first.nodes[0].children.length, 0);
  assert.equal(first.nodes[0].startedAt, undefined);
  assert.equal(first.nodes[0].replaying, true);
  assert.equal(first.nodes[0].lastReport.text, 'SYNTH-LATEST');
  assert.equal(first.nodes[0].model, 'claude-sonnet-4-5');
  assert.equal(first.nodes[0].status, 'running', 'a preview end_turn is not a settlement');
  const mockModel = { submit: t.mock.fn() };
  const sentences = new JobSentences(mockModel, join(f.home, 'sentences.json'), () => {}, () => NOW);
  sentences.configure(true, 'en');
  sentences.update(f.board(first), f.home, first);
  assert.equal(mockModel.submit.mock.callCount(), 0, 'preview text is not model material');

  fs.appendFileSync(f.file, message([{ type: 'text', text: 'SYNTH-NEWER' }], NOW + 1000));
  let tree = first, attachedDuringReplay = false;
  for (let pass = 0; pass < 6 && tree.incomplete; pass++) {
    tree = f.claude();
    const parent = tree.nodes[0];
    assert.equal(parent.lastReport.text, tree.incomplete ? 'SYNTH-LATEST' : 'SYNTH-NEWER');
    if (parent.replaying && parent.children.length) attachedDuringReplay = true;
  }
  assert.ok(attachedDuringReplay, 'nesting fills in as forward replay passes the call, before it reaches the tail');
  assert.equal(tree.incomplete, false);
  assert.equal(tree.nodes[0].replaying, false);
  assert.equal(tree.nodes.length, 1);
  assert.equal(tree.nodes[0].children[0].ref.threadId, 'child');
  assert.equal(tree.nodes[0].children[0].depth, 2);
  const lead = f.board(first).workers[0];
  const expanded = withState(initialMonitorState(), {
    home: { expanded: new Set([targetKey({ kind: 'worker', laneId: lead.laneId, workerId: lead.id })]) },
  });
  for (const width of [80, 120])
    for (const lang of ['en', 'zh']) {
      const initial = f.render(width, lang, expanded, first);
      assert.match(initial.lines.map(stripAnsi).join('\n'), /SYNTH-LATEST/);
      for (const line of initial.lines) assert.equal(visualLength(line), width);
      const frame = f.render(width, lang, expanded, tree),
        lines = frame.lines.map(stripAnsi);
      for (const line of frame.lines) assert.equal(visualLength(line), width);
      assert.match(lines.join('\n'), /SYNTH-NEWER/);
      assert.match(lines.join('\n'), /Claude ·/);
      const parent = lines.findIndex((line) => /^◉ custom-builder/.test(line));
      const child = lines.findIndex((line) => /^  ✓ custom-tester/.test(line));
      assert.ok(child > parent && parent >= 0, `${width} ${lang}: child follows its parent card`);
      assert.equal(
        lines[child].indexOf('✓'),
        lines[parent].indexOf('◉') + 2,
        `${width} ${lang}: child indents two cells`
      );
    }
  fs.appendFileSync(f.file, padding());
  const grown = drain(f);
  assert.equal(grown.nodes[0].children.length, 1, 'old call survives subsequent tail growth');
});

test('Claude reads one bounded tail, then exact forward byte ranges; warm and metadata-only reads skip bodies', (t) => {
  const f = fixture(t);
  f.put(f.file, padding() + call() + padding());
  const { ino, size } = fs.statSync(f.file),
    child = fs.statSync(join(f.dir, 'agent-child.jsonl')),
    reads = [],
    childReads = [],
    original = fs.readSync;
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    const n = original(fd, buffer, offset, length, position), opened = fs.fstatSync(fd);
    if (opened.ino === ino) reads.push({ position, length, n });
    if (opened.ino === child.ino) childReads.push({ position, length, n });
    return n;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  drain(f);
  assert.deepEqual(reads.shift(), { position: size - TAIL, length: TAIL, n: TAIL });
  assert.deepEqual(childReads, [{ position: 0, length: child.size, n: child.size }], 'small files are forward-only');
  assert.ok(reads.length >= 3);
  let end = 0;
  for (const read of reads) {
    assert.equal(read.position, end, 'never reread an earlier body range');
    assert.ok(read.length <= CHUNK);
    end += read.n;
  }
  assert.equal(end, fs.statSync(f.file).size);
  const count = reads.length;
  f.claude();
  assert.equal(f.collector.bytes, 0);
  assert.equal(reads.length, count);
  const meta = join(f.dir, 'agent-lead.meta.json');
  f.put(meta, { ...JSON.parse(fs.readFileSync(meta, 'utf8')), finished: true });
  assert.equal(f.claude().nodes[0].status, 'completed');
  assert.equal(reads.length, count, 'metadata-only updates do not reread transcript');
  const addition = message([{ type: 'text', text: 'Only newly appended bytes.' }]);
  fs.appendFileSync(f.file, addition);
  assert.equal(f.claude().nodes[0].lastReport.text, 'Only newly appended bytes.');
  assert.deepEqual(reads.at(-1), {
    position: end,
    length: Buffer.byteLength(addition),
    n: Buffer.byteLength(addition),
  });
});

for (const kind of ['truncate', 'rotate', 'same-size rewrite'])
  test(`Claude ${kind} clears obsolete parent calls and replays from the start`, (t) => {
    const f = fixture(t);
    f.put(f.file, call() + padding());
    assert.equal(drain(f).nodes[0].children.length, 1);
    const replacement = call('replacement-call');
    if (kind === 'rotate') {
      fs.renameSync(f.file, f.file + '.old');
      f.put(f.file, replacement + padding());
    } else if (kind === 'same-size rewrite') {
      const size = fs.statSync(f.file).size;
      fs.writeFileSync(f.file, replacement + ' '.repeat(size - Buffer.byteLength(replacement) - 1) + '\n');
    } else f.put(f.file, replacement);
    let tree;
    for (let pass = 0; pass < 5; pass++) tree = f.claude();
    assert.equal(tree.incomplete, true, 'missing parent remains uncertain after replay');
    assert.equal(tree.nodes.length, 2, 'read-to-end fallback shows the still-unmatched working/native child');
    assert.ok(
      tree.nodes.every((n) => n.children.length === 0),
      'stale call cannot misattribute the child'
    );
    const child = join(f.dir, 'agent-child.meta.json');
    f.put(child, { ...JSON.parse(fs.readFileSync(child, 'utf8')), toolUseId: 'replacement-call' });
    assert.equal(f.claude().nodes[0].children.length, 1, 'replacement call was read from the beginning');
  });

test('Claude replay keeps Agent/Task ids after hundreds of ordinary calls, across split JSONL/UTF-8 and appends', (t) => {
  const f = fixture(t);
  const ordinary = Array.from({ length: 220 }, (_, i) => call(`tool-${i}`, 'Read')).join('');
  // Put a multi-byte character across the one-MiB read boundary inside the Agent record.
  const head =
    ordinary +
    '{"type":"assistant","timestamp":"2026-11-12T11:59:00Z","message":{"content":[{"type":"tool_use","id":"nested-call","name":"Task","input":"';
  const split = head + 'x'.repeat(CHUNK - Buffer.byteLength(head) - 1) + '中"}]}}\n';
  f.put(f.file, split);
  assert.equal(f.claude().nodes.length, 1, 'partial record is not evidence');
  assert.equal(drain(f).nodes[0].children.length, 1);
  const extra = call('later-call');
  fs.appendFileSync(f.file, extra.slice(0, -2));
  assert.equal(f.claude().incomplete, true);
  fs.appendFileSync(f.file, extra.slice(-2));
  const child = join(f.dir, 'agent-child.meta.json');
  f.put(child, { ...JSON.parse(fs.readFileSync(child, 'utf8')), toolUseId: 'later-call' });
  assert.equal(f.claude().nodes[0].children.length, 1);
});

test('Claude replay shares a four-agent byte cap fairly across multiple growing parent transcripts', (t) => {
  const f = fixture(t),
    body = padding() + call() + padding();
  f.put(f.file, body);
  for (let i = 0; i < 5; i++) {
    f.put(join(f.dir, `agent-extra${i}.meta.json`), {
      agentType: 'tester',
      description: `Synthetic parent ${i}`,
      toolUseId: `root-${i}`,
      spawnDepth: 1,
      finished: false,
    });
    f.put(join(f.dir, `agent-extra${i}.jsonl`), body.replace('nested-call', `extra-call-${i}`));
  }
  const tree = drain(f);
  assert.equal(tree.nodes.length, 6);
  assert.equal(tree.nodes.find((n) => n.ref.threadId === 'lead').children.length, 1);
  assert.ok(tree.nodes.every((n) => n.lastReport?.text.startsWith('Synthetic filler.')));
  f.claude();
  assert.equal(f.collector.bytes, 0);
});

test('Claude previews at most 16 new large agents per refresh and leaves the rest for later', (t) => {
  const f = fixture(t);
  for (const id of ['lead', 'child']) fs.unlinkSync(join(f.dir, `agent-${id}.meta.json`));
  const body = message([{ type: 'text', text: 'Synthetic filler. '.repeat(256) }]).repeat(16) +
    message([{ type: 'text', text: 'SYNTH-LATEST' }]);
  const meta = JSON.stringify({ spawnDepth: 1, finished: false });
  for (let i = 0; i < 20; i++) {
    f.put(join(f.dir, `agent-${i}.meta.json`), meta);
    f.put(join(f.dir, `agent-${i}.jsonl`), body);
  }
  const first = f.claude();
  assert.equal(first.nodes.length, 16);
  assert.equal(first.incomplete, true);
  assert.ok(first.nodes.every((n) => n.replaying && n.lastReport?.text === 'SYNTH-LATEST'));
  assert.equal(f.collector.bytes, 16 * (TAIL + Buffer.byteLength(meta)));
  const second = f.claude();
  assert.equal(second.nodes.length, 20);
  assert.equal(second.nodes.filter((n) => !n.replaying).length, 4, 'the forward budget is independent');
  assert.ok(f.collector.bytes <= READ_BUDGET);
  assert.equal(drain(f).nodes.length, 20);
});

test('Claude tail-first ordering uses metadata birthtime until the first forward timestamp', (t) => {
  const f = fixture(t), birthtimes = { a: 0, b: 2000, c: 1000 };
  for (const id of ['lead', 'child']) fs.unlinkSync(join(f.dir, `agent-${id}.meta.json`));
  for (const [i, id] of ['a', 'b', 'c'].entries()) {
    f.put(join(f.dir, `agent-${id}.meta.json`), { spawnDepth: 1 });
    f.put(join(f.dir, `agent-${id}.jsonl`), message([{ type: 'text', text: id }], NOW - 3000 + i).repeat(1000));
  }
  const original = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (path, ...args) => {
    const stat = original(path, ...args), id = /agent-([abc])\.meta\.json$/.exec(path)?.[1];
    if (id) stat.birthtimeMs = birthtimes[id];
    return stat;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.deepEqual(f.claude().nodes.map((n) => n.ref.threadId), ['c', 'b', 'a']);
  assert.deepEqual(f.claude().nodes.map((n) => n.ref.threadId), ['a', 'b', 'c']);
});

test('Claude tail window drops the crossing line and does not let a previewed tool establish nesting', (t) => {
  const f = fixture(t);
  f.put(f.file, message([{ type: 'text', text: 'x'.repeat(CHUNK + TAIL) }]) + call());
  const first = f.claude();
  assert.equal(first.nodes[0].lastReport, undefined);
  assert.equal(first.nodes[0].action.name, 'Agent');
  assert.equal(first.nodes[0].children.length, 0);
  const lead = f.board(first).workers[0];
  const expanded = withState(initialMonitorState(), {
    home: { expanded: new Set([targetKey({ kind: 'worker', laneId: lead.laneId, workerId: lead.id })]) },
  });
  assert.match(f.render(80, 'en', expanded, first).lines.map(stripAnsi).join('\n'), /┃ Agent/);
  assert.equal(drain(f).nodes[0].children.length, 1, 'a partial preview line is not omitted forward evidence');
});

test('Claude skips oversized records with incomplete coverage but resumes parsing later Agent calls', (t) => {
  const f = fixture(t);
  f.put(f.file, message([{ type: 'text', text: 'x'.repeat(5 * CHUNK) }]) + call());
  let tree;
  for (let i = 0; i < 8; i++) {
    tree = f.claude();
    assert.ok(f.collector.bytes <= 4 * (CHUNK + 8192));
  }
  assert.equal(tree.incomplete, true, 'discarded oversized evidence never claims complete coverage');
  assert.equal(tree.nodes[0].children.length, 1);
  assert.equal(f.collector.bytes, 0, 'discarded record does not cause endless rereads');
});

test('Claude read-to-end fallback does not hide an orphan indefinitely, including no candidate parent', (t) => {
  const f = fixture(t),
    child = join(f.dir, 'agent-child.meta.json');
  f.put(child, { ...JSON.parse(fs.readFileSync(child, 'utf8')), toolUseId: 'absent-call', finished: false });
  f.put(f.file, padding() + padding());
  assert.equal(f.claude().nodes.length, 1);
  let tree;
  for (let i = 0; i < 5; i++) tree = f.claude();
  assert.equal(tree.nodes.length, 2);
  assert.equal(tree.incomplete, true);
  fs.unlinkSync(join(f.dir, 'agent-lead.meta.json'));
  tree = f.claude();
  assert.equal(tree.nodes.length, 1);
  assert.equal(tree.nodes[0].ref.threadId, 'child');
  assert.equal(tree.nodes[0].status, 'running');
});

test('a running Claude agent whose transcript still grows is in progress, not stalled, while replay lags', async (t) => {
  const { nativeWorker, projectWorkCard } = await import('../../dist/collectors/work-card.js');
  const f = fixture(t);
  const old = (text) =>
    JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - 20 * 60000).toISOString(), message: { content: [{ type: 'text', text }] } }) + '\n';
  f.put(f.file, old('Synthetic filler. '.repeat(256)).repeat(300) + message([{ type: 'text', text: 'Now.' }]));
  const lead = (tree) => tree.nodes.find((n) => n.ref.threadId === 'lead');
  const first = lead(f.claude());
  assert.equal(first.replaying, true, 'first chunk leaves the newest lines unread');
  assert.equal(first.lastEventAt.getTime(), NOW, 'the transcript mtime stands for activity');
  assert.equal(projectWorkCard(nativeWorker(first), NOW + 60000).state, 'in-progress');
});

test('Claude rows keep one order across refreshes while the read cursor rotates', (t) => {
  const f = fixture(t);
  for (const [id, minutes] of [['b1', 5], ['a2', 4], ['c3', 3], ['d4', 2], ['e5', 1]]) {
    f.put(join(f.dir, `agent-${id}.meta.json`), { agentType: 'synthetic', description: id, spawnDepth: 1 });
    f.put(join(f.dir, `agent-${id}.jsonl`), JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - minutes * 60000).toISOString(), message: { content: [{ type: 'text', text: id }] } }) + '\n');
  }
  drain(f);
  const orders = new Set();
  for (let pass = 0; pass < 6; pass++) orders.add(f.claude().nodes.map((n) => n.ref.threadId).join(','));
  assert.equal(orders.size, 1, [...orders].join(' | '));
});
