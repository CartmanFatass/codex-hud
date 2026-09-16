import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSubagentTree, resetSubagentLinkCache, summarizeSubagents } from '../../src/collectors/subagent-tree.js';
import { initialPanelState, visibleRows } from '../../src/render/panel-state.js';
import { renderPanelPlain } from '../../src/render/subagent-tree-view.js';
import { icons } from '../../src/render/colors.js';
import type { SubagentInfo } from '../../src/types.js';

test('tree follows child lifecycle events, including completion and follow-up turns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-agent-status-'));
  const previous = process.env.CODEX_SESSIONS_PATH;
  const now = new Date();
  const day = path.join(dir, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  process.env.CODEX_SESSIONS_PATH = dir;
  resetSubagentLinkCache();
  const event = (type: string, seconds: number) => JSON.stringify({
    timestamp: new Date(now.getTime() + seconds * 1000).toISOString(),
    type: 'event_msg', payload: { type, turn_id: 'turn-1' },
  }) + '\n';
  const writeAgent = (id: string, parentId = 'root') => {
    const file = path.join(day, `rollout-${now.toISOString().slice(0, 10)}T00-00-00-${Buffer.from(id).toString('hex')}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: {
      id, source: { subagent: { thread_spawn: { parent_thread_id: parentId } } }, agent_nickname: id, timestamp: now.toISOString(),
    } }) + '\n');
    return file;
  };
  try {
    const child = writeAgent('worker');
    const nested = writeAgent('nested', 'worker');
    writeAgent('unheard');
    fs.appendFileSync(child, event('task_started', 1));
    fs.appendFileSync(nested, event('task_started', 2) + event('task_complete', 3));
    const build = (known: SubagentInfo[] = [], tick = now.getTime()) => buildSubagentTree('root', known, 3, tick);
    let tree = build();
    const worker = () => tree.nodes.find(node => node.id === 'worker')!;
    assert.equal(worker().status, 'running');
    assert.equal(worker().children[0].status, 'completed');
    assert.equal(tree.nodes.find(node => node.id === 'unheard')?.status, 'unknown');
    assert.equal(summarizeSubagents(tree.nodes).active, 1);
    const state = initialPanelState();
    const panel = renderPanelPlain({ tree, state, maxWidth: 80 });
    assert.match(panel, new RegExp(`${icons.running} worker`));
    assert.match(panel, new RegExp(`${icons.check} nested`));
    assert.deepEqual(visibleRows(tree.nodes, { ...state, filter: 'active' }).map(row => row.node.id), ['worker']);

    const stale: SubagentInfo[] = [{ id: 'worker', name: 'worker', status: 'running', lastActivityAt: now }];
    fs.appendFileSync(child, event('task_complete', 4));
    tree = build(stale);
    assert.equal(worker().status, 'completed', 'own completion supersedes an old parent spawn');
    assert.equal(summarizeSubagents(tree.nodes).active, 0);
    tree = build(stale, now.getTime() + 31_000);
    assert.equal(worker().status, 'completed', 'scheduled metadata revalidation retains lifecycle state');

    const restart = event('task_started', 5);
    fs.appendFileSync(child, restart.slice(0, -8));
    tree = build();
    assert.equal(worker().status, 'completed', 'a partial event cannot change status');
    fs.appendFileSync(child, restart.slice(-8));
    tree = build();
    assert.equal(worker().status, 'running', 'follow-up turn reactivates a finished agent');

    tree = build([{ ...stale[0], status: 'error', lastActivityAt: new Date(now.getTime() + 6000) }]);
    assert.equal(worker().status, 'error', 'newer parent status supersedes older child activity');
    fs.appendFileSync(child, event('task_complete', 7));
    tree = build();
    assert.equal(worker().status, 'completed');
    fs.writeFileSync(child, fs.readFileSync(child, 'utf8').split('\n')[0] + '\n');
    tree = build();
    assert.equal(worker().status, 'unknown', 'file truncation discards cached lifecycle state');
  } finally {
    resetSubagentLinkCache();
    if (previous === undefined) delete process.env.CODEX_SESSIONS_PATH;
    else process.env.CODEX_SESSIONS_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
