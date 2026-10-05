import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSubagentTree, resetSubagentLinkCache, useTreeScanStore, flushTreeScans } from '../../src/collectors/subagent-tree.js';
import { TreeScanStore, SAVE_MIN_BYTES, SCAN_VERSION } from '../../src/collectors/tree-scan-store.js';
import type { SubagentTreeNode } from '../../src/types.js';

const line = (value: object) => `${JSON.stringify(value)}\n`;

/**
 * A sessions folder with one agent's rollout: a stage asked for by the main
 * session, its first update, more than SAVE_MIN_BYTES of reasoning the scan
 * passes over, and its answer at the end.
 */
function session(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-tree-scan-'));
  const previous = process.env.CODEX_SESSIONS_PATH;
  const now = new Date();
  const day = path.join(dir, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  process.env.CODEX_SESSIONS_PATH = path.join(dir, 'sessions');
  resetSubagentLinkCache();
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_SESSIONS_PATH; else process.env.CODEX_SESSIONS_PATH = previous;
    useTreeScanStore(undefined);
    resetSubagentLinkCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const near = (seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();
  const file = path.join(day, `rollout-${now.toISOString().slice(0, 10)}T00-00-00-${Buffer.from('lead').toString('hex')}.jsonl`);
  const filler = Array.from({ length: 300 }, (_, i) => line({ timestamp: near(3), type: 'response_item',
    payload: { type: 'reasoning', summary: [], encrypted_content: `${i}`.padEnd(1000, 'x') } })).join('');
  fs.writeFileSync(file, line({ type: 'session_meta', payload: { id: 'lead', source: { subagent: { thread_spawn: { parent_thread_id: 'root', agent_path: '/root/lead' } } },
    agent_nickname: 'lead', timestamp: now.toISOString() } })
    + line({ timestamp: near(1), type: 'response_item', payload: { type: 'agent_message', author: '/root', recipient: '/root/lead',
      content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: lead\nSender: /root\n' }] } })
    + line({ timestamp: near(2), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } })
    + line({ timestamp: near(3), type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Taking the parser rewrite.' }] } })
    + filler
    + line({ timestamp: near(4), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'First answer.' } }));
  assert.ok(fs.statSync(file).size > SAVE_MIN_BYTES);
  const build = (seconds = 5): SubagentTreeNode => buildSubagentTree('root', [], 3, now.getTime() + seconds * 1000).nodes.find(node => node.id === 'lead')!;
  /** Rewrites bytes in place, the file's length kept, as a check on whether they are read again. */
  const rewrite = (from: string, to: string) => {
    assert.equal(from.length, to.length);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes(from));
    fs.writeFileSync(file, text.replace(from, to));
  };
  const append = (seconds: number, answer: string) => fs.appendFileSync(file,
    line({ timestamp: near(seconds), type: 'event_msg', payload: { type: 'task_started', turn_id: `t${seconds}` } })
    + line({ timestamp: near(seconds + 1), type: 'event_msg', payload: { type: 'task_complete', turn_id: `t${seconds}`, last_agent_message: answer } }));
  return { dir, file, scan: path.join(dir, 'hud', 'scan'), build, rewrite, append };
}

const told = (node: SubagentTreeNode) => node.stages!.map(stage => [stage.status, stage.intent ?? null, stage.result ?? null]);

test('a process started again resumes the scan the last one saved, and reads only what was written since', (t) => {
  const s = session(t);
  useTreeScanStore(new TreeScanStore(s.scan));
  assert.deepEqual(told(s.build()), [['done', 'Taking the parser rewrite.', 'First answer.']]);
  flushTreeScans();
  const saved = fs.readdirSync(s.scan);
  assert.equal(saved.length, 1);
  assert.equal(fs.statSync(path.join(s.scan, saved[0])).mode & 0o777, 0o600);
  const record = JSON.parse(fs.readFileSync(path.join(s.scan, saved[0]), 'utf8'));
  assert.deepEqual([record.version, record.path, record.id, record.ino, record.offset], [SCAN_VERSION, s.file, 'lead', fs.statSync(s.file).ino, fs.statSync(s.file).size]);

  // Started again: the early bytes changed would show if they were read again; they are not.
  resetSubagentLinkCache();
  useTreeScanStore(new TreeScanStore(s.scan));
  s.rewrite('Taking the parser rewrite.', 'Taking the parser REWRITE.');
  s.append(10, 'Second answer.');
  const lead = s.build(12);
  assert.deepEqual(told(lead), [['done', 'Taking the parser rewrite.', 'First answer.'], ['done', null, 'Second answer.']]);
  assert.equal(lead.stageCount, 2);
  assert.deepEqual(lead.peers, { '/root': 1 }, 'the ledger came back whole');
});

/** Builds and saves a scan, then starts again with `change` made to the file or the saved scan. */
function restarted(t: { after: (fn: () => void) => void }, change: (s: ReturnType<typeof session>, saved: string) => void) {
  const s = session(t);
  useTreeScanStore(new TreeScanStore(s.scan));
  s.build();
  flushTreeScans();
  resetSubagentLinkCache();
  useTreeScanStore(new TreeScanStore(s.scan));
  change(s, path.join(s.scan, fs.readdirSync(s.scan)[0]));
  // Read again from the start, the early change shows.
  s.rewrite('Taking the parser rewrite.', 'Taking the parser REWRITE.');
  return s.build();
}

test('a saved scan whose last bytes changed is not used: the file is read again from the start', (t) => {
  const lead = restarted(t, s => s.rewrite('First answer.', 'First ANSWER.'));
  assert.deepEqual(told(lead), [['done', 'Taking the parser REWRITE.', 'First ANSWER.']]);
});

test('nor is one for a file now shorter than the scan', (t) => {
  const lead = restarted(t, s => fs.truncateSync(s.file, fs.statSync(s.file).size - 200));
  assert.deepEqual(told(lead), [['running', 'Taking the parser REWRITE.', null]]);
});

test('nor one for another file put in its place, though it ends in the same bytes', (t) => {
  const lead = restarted(t, (s) => {
    fs.writeFileSync(`${s.file}.new`, fs.readFileSync(s.file));
    fs.renameSync(`${s.file}.new`, s.file);
  });
  assert.deepEqual(told(lead), [['done', 'Taking the parser REWRITE.', 'First answer.']]);
});

test('nor one saved under another reading of the lines, or with a part that does not read', (t) => {
  const lead = restarted(t, (s, saved) => {
    const record = JSON.parse(fs.readFileSync(saved, 'utf8'));
    fs.writeFileSync(saved, JSON.stringify({ ...record, version: SCAN_VERSION + 1 }));
    assert.equal(new TreeScanStore(s.scan).load(s.file), undefined);
    fs.writeFileSync(saved, JSON.stringify({ ...record, ledger: { ...record.ledger, stages: [{ status: 'done' }] } }));
    assert.ok(new TreeScanStore(s.scan).load(s.file), 'it loads; a part of it does not read');
  });
  assert.deepEqual(told(lead), [['done', 'Taking the parser REWRITE.', 'First answer.']], 'read again, nothing taken from it');
});

test('checking a growing rollout again keeps its scan while the bytes it ended on hold', (t) => {
  const s = session(t);
  assert.deepEqual(told(s.build(5)), [['done', 'Taking the parser rewrite.', 'First answer.']]);
  s.rewrite('Taking the parser rewrite.', 'Taking the parser REWRITE.');
  s.append(10, 'Second answer.');
  // Half a minute on, the file is checked again: same thread, grown, the bytes before the scan's end as they were.
  const lead = s.build(45);
  assert.deepEqual(told(lead), [['done', 'Taking the parser rewrite.', 'First answer.'], ['done', null, 'Second answer.']], 'not read from its first byte');
  s.rewrite('Second answer.', 'Second ANSWER.');
  s.append(50, 'Third answer.');
  assert.deepEqual(told(s.build(90)), [['done', 'Taking the parser REWRITE.', 'First answer.'], ['done', null, 'Second ANSWER.'],
    ['done', null, 'Third answer.']], 'the bytes it ended on changed: read again from the start');
});

test('a read-only store writes nothing, and a saved scan neither used nor written for a week goes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-tree-scan-store-'));
  try {
    const scan = path.join(dir, 'scan');
    const readOnly = new TreeScanStore(scan, { readOnly: true });
    readOnly.mark('/x.jsonl', () => ({ version: SCAN_VERSION, path: '/x.jsonl', id: 'x', offset: 1, print: 'p', fields: {} }));
    readOnly.flush();
    assert.equal(fs.existsSync(scan), false);
    const store = new TreeScanStore(scan);
    store.mark('/x.jsonl', () => ({ version: SCAN_VERSION, path: '/x.jsonl', id: 'x', offset: 1, print: 'p', fields: {} }));
    store.mark('/y.jsonl', () => ({ version: SCAN_VERSION, path: '/y.jsonl', id: 'y', offset: 1, print: 'p', fields: {} }));
    store.flushDue(Date.now());
    assert.equal(fs.existsSync(scan), false, 'not yet: writes go out once a minute');
    store.flushDue(Date.now() + 61_000);
    assert.equal(store.load('/x.jsonl')?.id, 'x');
    const week = Date.now() / 1000 - 8 * 24 * 3600;
    for (const name of fs.readdirSync(scan)) fs.utimesSync(path.join(scan, name), week, week);
    readOnly.used('/y.jsonl');
    store.used('/x.jsonl');
    new TreeScanStore(scan);
    assert.deepEqual(fs.readdirSync(scan).map((name) => JSON.parse(fs.readFileSync(path.join(scan, name), 'utf8')).id), ['x'],
      'the one used this week stays; a dry run\'s use keeps nothing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
