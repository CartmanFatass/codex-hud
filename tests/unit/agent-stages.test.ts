import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { actionText, applyLedgerEntry, currentAction, headTail, newLedger, STAGE_INTENT_CHARS, STAGE_RESULT_CHARS, STAGES_KEPT } from '../../src/collectors/agent-stages.js';
import { buildSubagentTree, resetSubagentLinkCache } from '../../src/collectors/subagent-tree.js';

const start = Date.parse('2026-09-20T10:00:00Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const event = (seconds: number, payload: Record<string, unknown>) => ({ timestamp: at(seconds), type: 'event_msg', payload });
const item = (seconds: number, payload: Record<string, unknown>) => ({ timestamp: at(seconds), type: 'response_item', payload });
const header = (type: string, sender: string) => item(0, { type: 'agent_message', author: sender, recipient: '/root/lead',
  content: [{ type: 'input_text', text: `Message Type: ${type}\nTask name: lead\nSender: ${sender}\n` }, { type: 'encrypted', text: 'gAAAA…' }] });
const said = (seconds: number, words: string, phase = 'commentary') => item(seconds, { type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text: words }] });

test('a stage is who asked, what the agent said it would do, and what it returned', () => {
  const ledger = newLedger();
  for (const entry of [
    { ...header('NEW_TASK', '/root'), timestamp: at(0) },
    event(1, { type: 'task_started', turn_id: 't1' }),
    said(2, 'I will compare  the two\nbaselines.'),
    said(3, 'Second update, not the intent.'),
    item(4, { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'const r = await tools.exec_command({cmd:"npm test -- --grep \\"cache\\""});\nreturn r;' }),
    item(5, { type: 'function_call', call_id: 'c2', name: 'spawn_agent', arguments: JSON.stringify({ task_name: 'check_cache', agent_type: 'scout', message: 'gAAAA' }) }),
  ]) applyLedgerEntry(entry, ledger);
  assert.equal(ledger.count, 1);
  const stage = ledger.stages[0];
  assert.deepEqual(stage.by, { type: 'NEW_TASK', sender: '/root' }, 'the message that came in before the turn is its cause');
  assert.equal(stage.intent, 'I will compare the two baselines.', 'the first update, flattened; later ones are progress');
  assert.equal(stage.status, 'running');
  assert.equal(currentAction(ledger)?.text, 'check_cache (scout)', 'the newest open call');
  applyLedgerEntry(item(6, { type: 'function_call_output', call_id: 'c2', output: 'ok' }), ledger);
  assert.equal(currentAction(ledger)?.text, 'npm test -- --grep "cache"', 'a script says the first command it runs');
  applyLedgerEntry({ ...header('MESSAGE', '/root/peer'), timestamp: at(7) }, ledger);
  applyLedgerEntry({ ...header('MESSAGE', '/root/peer'), timestamp: at(8) }, ledger);
  assert.deepEqual(stage.peers, { '/root/peer': 2 });
  assert.equal(stage.by?.sender, '/root', 'a message mid-stage does not change its cause');
  applyLedgerEntry(event(9, { type: 'task_complete', turn_id: 't1', last_agent_message: '  Baseline B is 4% faster.  ' }), ledger);
  assert.equal(stage.status, 'done');
  assert.equal(stage.result, 'Baseline B is 4% faster.');
  assert.equal(stage.endedAt?.toISOString(), at(9));
  assert.equal(currentAction(ledger), undefined, 'a finished turn runs nothing');
  assert.deepEqual(Object.fromEntries(ledger.peers), { '/root': 1, '/root/peer': 2 });
});

test('a stage that started again ends the one before it; the same start read twice is one stage', () => {
  const ledger = newLedger();
  applyLedgerEntry(event(0, { type: 'task_started', turn_id: 't1' }), ledger);
  applyLedgerEntry(event(5, { type: 'task_started', turn_id: 't2' }), ledger);
  applyLedgerEntry(event(6, { type: 'task_started', turn_id: 't2' }), ledger);
  assert.deepEqual(ledger.stages.map(s => [s.turnId, s.status]), [['t1', 'aborted'], ['t2', 'running']]);
  assert.equal(ledger.stages[0].endedAt?.toISOString(), at(5));
  applyLedgerEntry(event(7, { type: 'turn_aborted', turn_id: 't2' }), ledger);
  assert.equal(ledger.stages[1].status, 'aborted');
  // An end whose start the scan never read: a stage of its own, started when the record says.
  applyLedgerEntry(event(20, { type: 'task_complete', turn_id: 't3', started_at: (start + 12_000) / 1000, last_agent_message: null }), ledger);
  assert.deepEqual(ledger.stages.map(s => s.status), ['aborted', 'aborted', 'done']);
  assert.equal(ledger.stages[2].startedAt.toISOString(), at(12));
  assert.equal(ledger.stages[2].result, undefined, 'no answer, no result');
  // A message between stages is the next stage's cause.
  applyLedgerEntry({ ...header('FINAL_ANSWER', '/root/helper'), timestamp: at(21) }, ledger);
  applyLedgerEntry(event(22, { type: 'task_started', turn_id: 't4' }), ledger);
  assert.deepEqual(ledger.stages.at(-1)?.by, { type: 'FINAL_ANSWER', sender: '/root/helper' });
  for (let i = 0; i < 10; i++) {
    applyLedgerEntry(event(30 + i * 2, { type: 'task_started', turn_id: `n${i}` }), ledger);
    applyLedgerEntry(event(31 + i * 2, { type: 'task_complete', turn_id: `n${i}` }), ledger);
  }
  assert.equal(ledger.stages.length, STAGES_KEPT, 'the newest stages only');
  assert.equal(ledger.count, 14, 'every stage counted');
  assert.equal(ledger.stages.at(-1)?.turnId, 'n9');
});

test('texts are kept to their bounds: a result its head and tail, an intent its first characters', () => {
  const long = `${'a'.repeat(6000)}MIDDLE${'z'.repeat(6000)}`;
  const cut = headTail(long, STAGE_RESULT_CHARS);
  assert.equal(cut.length, STAGE_RESULT_CHARS);
  assert.ok(cut.startsWith('aaa') && cut.endsWith('zzz') && cut.includes('\n[…]\n') && !cut.includes('MIDDLE'));
  assert.equal(headTail('short', 10), 'short');
  const ledger = newLedger();
  applyLedgerEntry(event(0, { type: 'task_started', turn_id: 't1' }), ledger);
  applyLedgerEntry(said(1, 'x'.repeat(1000)), ledger);
  assert.equal(Array.from(ledger.stages[0].intent!).length, STAGE_INTENT_CHARS);
  assert.ok(ledger.stages[0].intent!.endsWith('…'));
  applyLedgerEntry(said(2, 'The final answer, not an update.', 'final_answer'), ledger);
  assert.ok(ledger.stages[0].intent!.startsWith('xxx'));
});

test('an action is the command run, the agent a collaboration call is about, or the tool', () => {
  assert.equal(actionText('exec_command', JSON.stringify({ cmd: 'git status' })), 'git status');
  assert.equal(actionText('shell', { command: ['rg', '-n', 'TODO'] }), 'rg -n TODO');
  assert.equal(actionText('exec', "await tools.exec_command({ cmd: 'pytest -q' })"), 'pytest -q');
  assert.equal(actionText('exec', '\n  const files = await tools.list();\n'), 'const files = await tools.list();');
  assert.equal(actionText('send_message', JSON.stringify({ target: '/root/reviewer', message: 'gAAAA' })), '→ /root/reviewer');
  assert.equal(actionText('wait_agent', '{}'), 'wait_agent');
  assert.equal(actionText('exec_command', JSON.stringify({ cmd: `echo ${'y'.repeat(300)}` })).length, 200);
});

test('the tree carries each agent\'s stages, read once as its rollout grows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-agent-stages-'));
  const previous = process.env.CODEX_SESSIONS_PATH;
  const now = new Date();
  const day = path.join(dir, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  process.env.CODEX_SESSIONS_PATH = dir;
  resetSubagentLinkCache();
  const line = (value: object) => `${JSON.stringify(value)}\n`;
  const near = (seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();
  const file = path.join(day, `rollout-${now.toISOString().slice(0, 10)}T00-00-00-${Buffer.from('lead').toString('hex')}.jsonl`);
  fs.writeFileSync(file, line({ type: 'session_meta', payload: { id: 'lead', source: { subagent: { thread_spawn: { parent_thread_id: 'root', agent_path: '/root/lead' } } },
    agent_nickname: 'lead', timestamp: now.toISOString() } }));
  try {
    fs.appendFileSync(file, line({ ...header('NEW_TASK', '/root'), timestamp: near(1) })
      + line({ ...event(2, { type: 'task_started', turn_id: 't1' }), timestamp: near(2) })
      + line({ ...said(3, 'Taking the parser rewrite.'), timestamp: near(3) })
      + line({ ...item(4, { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm run build' }) }), timestamp: near(4) }));
    const build = () => buildSubagentTree('root', [], 3, now.getTime() + 5000);
    let lead = build().nodes.find(node => node.id === 'lead')!;
    assert.equal(lead.stageCount, 1);
    assert.deepEqual(lead.stages?.map(s => [s.status, s.by?.sender, s.intent]), [['running', '/root', 'Taking the parser rewrite.']]);
    assert.equal(lead.action?.text, 'npm run build');
    assert.deepEqual(lead.peers, { '/root': 1 });
    lead = build().nodes.find(node => node.id === 'lead')!;
    assert.equal(lead.stageCount, 1, 'nothing read twice');
    fs.appendFileSync(file, line({ ...item(5, { type: 'function_call_output', call_id: 'c1', output: 'ok' }), timestamp: near(5) })
      + line({ ...event(6, { type: 'task_complete', turn_id: 't1', last_agent_message: 'Parser rewritten; 3 tests added.' }), timestamp: near(6) }));
    lead = buildSubagentTree('root', [], 3, now.getTime() + 7000).nodes.find(node => node.id === 'lead')!;
    assert.deepEqual(lead.stages?.map(s => [s.status, s.result]), [['done', 'Parser rewritten; 3 tests added.']]);
    assert.equal(lead.action, undefined);
    lead.stages![0].result = 'changed by a reader';
    lead = buildSubagentTree('root', [], 3, now.getTime() + 8000).nodes.find(node => node.id === 'lead')!;
    assert.equal(lead.stages?.[0].result, 'Parser rewritten; 3 tests added.', 'a node holds copies, not the ledger');
  } finally {
    if (previous === undefined) delete process.env.CODEX_SESSIONS_PATH; else process.env.CODEX_SESSIONS_PATH = previous;
    resetSubagentLinkCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
