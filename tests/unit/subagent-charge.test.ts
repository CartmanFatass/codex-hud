/**
 * The words a parent wrote before it spawned someone, kept for the details
 * page. The sealed spawn payload is not those words.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSubagentTree, resetSubagentLinkCache } from '../../src/collectors/subagent-tree.js';

test('a child keeps the plaintext its parent wrote before the spawn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-charge-'));
  const old = process.env.CODEX_SESSIONS_PATH;
  process.env.CODEX_SESSIONS_PATH = dir;
  const now = new Date();
  const day = path.join(dir, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  const stamp = now.toISOString().slice(0, 10);
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const message = (role: 'user' | 'assistant', text: string) => line({
    timestamp: now.toISOString(), type: 'response_item',
    payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
  });
  const started = line({
    type: 'event_msg',
    payload: { type: 'item_completed', item: { type: 'SubAgentActivity', kind: 'started', agent_thread_id: 'child' } },
  });
  try {
    fs.writeFileSync(path.join(day, `rollout-${stamp}T00-00-00-a11ce001.jsonl`), [
      line({ type: 'session_meta', payload: { id: 'root', timestamp: now.toISOString() } }),
      message('user', 'Please bind the session before the first send'),
      message('assistant', 'Message Type: NEW_TASK\nTask name: binder\n'),
      message('assistant', 'I am handing the binding to a subagent'),
      message('assistant', 'gAAAAAsealed-spawn-payload'),
      line({ timestamp: now.toISOString(), type: 'response_item', payload: {
        type: 'message', role: 'assistant', channel: 'analysis',
        content: [{ type: 'output_text', text: 'PRIVATE_REASONING_SYNTHETIC' }],
      } }),
      line({ timestamp: now.toISOString(), type: 'response_item', payload: {
        type: 'message', role: 'assistant', channel: 'future_private',
        content: [{ type: 'output_text', text: 'UNKNOWN_CHANNEL_SYNTHETIC' }],
      } }),
      line({ timestamp: now.toISOString(), type: 'response_item', payload: {
        type: 'message', role: 'assistant', channel: 'commentary', phase: 'analysis',
        content: [{ type: 'output_text', text: 'PRIVATE_PHASE_SYNTHETIC' }],
      } }),
      line({ timestamp: now.toISOString(), type: 'response_item', payload: {
        type: 'message', role: 'assistant', channel: 'commentary',
        content: [{ type: 'output_text', text: 'Public progress' }, { type: 'reasoning_text', text: 'PRIVATE_BLOCK_SYNTHETIC' }],
      } }),
      started,
      message('assistant', 'This came after the spawn'),
    ].join(''));
    fs.writeFileSync(path.join(day, `rollout-${stamp}T00-00-01-c11d0001.jsonl`),
      line({ type: 'session_meta', payload: { id: 'child', parent_thread_id: 'root', timestamp: now.toISOString(), source: { subagent: { thread_spawn: { parent_thread_id: 'root', depth: 1, agent_path: '/root/binder' } } } } }));
    resetSubagentLinkCache();
    const child = buildSubagentTree('root').nodes.find(node => node.id === 'child');
    assert.ok(child, 'the child is in the tree');
    assert.match(child.charge ?? '', /Please bind the session before the first send/);
    assert.match(child.charge ?? '', /handing the binding to a subagent/);
    assert.match(child.charge ?? '', /Public progress/);
    assert.doesNotMatch(child.charge ?? '', /Message Type|gAAAAA|after the spawn|PRIVATE_|UNKNOWN_CHANNEL/);
  } finally {
    if (old === undefined) delete process.env.CODEX_SESSIONS_PATH;
    else process.env.CODEX_SESSIONS_PATH = old;
    resetSubagentLinkCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
