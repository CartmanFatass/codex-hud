import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { agentPickerLabel, buildSubagentTree, resetSubagentLinkCache, summarizeSubagents, uniquePickerLabel } from '../../src/collectors/subagent-tree.js';
import { initialPanelState, visibleRows } from '../../src/render/panel-state.js';
import { renderPanelPlain } from '../../src/render/subagent-tree-view.js';
import { icons } from '../../src/render/colors.js';
import type { SubagentInfo, SubagentTree, SubagentTreeNode } from '../../src/types.js';

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
  const writeAgent = (id: string, parentId = 'root', meta: Record<string, unknown> = {}) => {
    const file = path.join(day, `rollout-${now.toISOString().slice(0, 10)}T00-00-00-${Buffer.from(id).toString('hex')}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: {
      id, source: { subagent: { thread_spawn: { parent_thread_id: parentId } } }, agent_nickname: id, timestamp: now.toISOString(),
      ...meta,
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
    fs.appendFileSync(child, JSON.stringify({
      timestamp: new Date(now.getTime() + 1500).toISOString(),
      type: 'event_msg', payload: { type: 'agent_message', message: 'FOUND_THE_CAUSE' },
    }) + '\n');
    fs.appendFileSync(child, JSON.stringify({
      timestamp: new Date(now.getTime() + 1600).toISOString(),
      type: 'event_msg', payload: { type: 'agent_reasoning', message: 'DO_NOT_SHOW' },
    }) + '\n');
    tree = build();
    assert.equal(worker().lastReport?.text, 'FOUND_THE_CAUSE');
    assert.equal(worker().lastReport?.kind, 'message');
    assert.equal(tree.nodes.find(node => node.id === 'unheard')?.lastReport, undefined);
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

    fs.appendFileSync(child, event('task_started', 8) + event('turn_aborted', 9));
    tree = build();
    assert.equal(worker().status, 'completed', 'an interrupted turn is over, not still running');
    assert.equal(summarizeSubagents(tree.nodes).active, 0);
  } finally {
    resetSubagentLinkCache();
    if (previous === undefined) delete process.env.CODEX_SESSIONS_PATH;
    else process.env.CODEX_SESSIONS_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agents are named by their task path, not the random nickname, and never by id prefix', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-agent-names-'));
  const previous = process.env.CODEX_SESSIONS_PATH;
  const now = new Date();
  const day = path.join(dir, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  process.env.CODEX_SESSIONS_PATH = dir;
  resetSubagentLinkCache();
  const write = (id: string, payload: Record<string, unknown>) => {
    fs.writeFileSync(path.join(day, `rollout-${now.toISOString().slice(0, 10)}T00-00-00-${id}.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { id, timestamp: now.toISOString(), ...payload } }) + '\n');
  };
  const root = '01a0c887-99ed-7bd1-83a1-af27abe6c4e4';
  try {
    // Codex 0.155 guardian review thread: same UUID prefix as the session it
    // reviews, no nickname, parent link only in the payload.
    write('01a0c887-9a7a-7cc1-b767-f1e0856f50f6', {
      session_id: root, parent_thread_id: root,
      source: { subagent: { other: 'guardian' } }, thread_source: 'guardian_review',
    });
    // A spawned agent whose nickname is missing still carries its task path.
    write('01a0c79c-f033-7703-9b16-5833eb6d2ef5', {
      source: { subagent: { thread_spawn: { parent_thread_id: root, depth: 1, agent_path: '/root/audit_code_paths', agent_nickname: null } } },
    });
    // The task path wins over the random nickname, which stays as a detail.
    // Codex 0.157 also repeats both at the top level of the payload.
    write('01a0c79d-1c88-7c30-8e7e-af8987f06081', {
      agent_path: '/root/audit_state_paths', agent_nickname: 'Meitner',
      source: { subagent: { thread_spawn: { parent_thread_id: root, depth: 1, agent_path: '/root/audit_state_paths', agent_nickname: 'Meitner', agent_role: null } } },
    });
    // A nested agent keeps only the last segment; the tree shows the rest.
    write('01a0c7a0-0000-7000-8000-000000000001', {
      source: { subagent: { thread_spawn: { parent_thread_id: '01a0c79d-1c88-7c30-8e7e-af8987f06081', depth: 2, agent_path: '/root/audit_state_paths/fixtures', agent_nickname: 'Noether' } } },
    });
    // No task path: the nickname and role are what is left.
    write('01a0c7a1-0000-7000-8000-000000000002', {
      source: { subagent: { thread_spawn: { parent_thread_id: root, depth: 1, agent_nickname: 'Robie', agent_role: 'explorer' } } },
    });
    // Nothing to go on: the id prefix remains the last resort.
    write('01a0c7ff-0000-7000-8000-000000000000', {
      source: { subagent: { thread_spawn: { parent_thread_id: root, depth: 1 } } },
    });
    const tree = buildSubagentTree(root);
    const all = new Map<string, SubagentTreeNode>();
    const walk = (nodes: SubagentTreeNode[]) => nodes.forEach(node => { all.set(node.id.slice(0, 13), node); walk(node.children); });
    walk(tree.nodes);
    assert.equal(all.get('01a0c887-9a7a')?.name, 'guardian');
    assert.equal(all.get('01a0c887-9a7a')?.kind, 'guardian');
    assert.equal(all.get('01a0c79c-f033')?.name, 'audit_code_paths');
    assert.equal(all.get('01a0c79d-1c88')?.name, 'audit_state_paths');
    assert.equal(all.get('01a0c79d-1c88')?.nickname, 'Meitner');
    assert.equal(all.get('01a0c79d-1c88')?.agentPath, '/root/audit_state_paths');
    assert.equal(all.get('01a0c7a0-0000')?.name, 'fixtures');
    assert.equal(all.get('01a0c7a1-0000')?.name, 'Robie');
    assert.equal(all.get('01a0c7a1-0000')?.role, 'explorer');
    assert.equal(all.get('01a0c7ff-0000')?.name, '01a0c7ff');
  } finally {
    resetSubagentLinkCache();
    if (previous === undefined) delete process.env.CODEX_SESSIONS_PATH;
    else process.env.CODEX_SESSIONS_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the picker label is what Codex prints in /subagents', () => {
  assert.equal(agentPickerLabel({ agentPath: '/root/audit_state_paths', nickname: 'Meitner' }, false), '/root/audit_state_paths');
  assert.equal(agentPickerLabel({ nickname: 'Robie', role: 'explorer' }, false), 'Robie [explorer]');
  assert.equal(agentPickerLabel({ nickname: 'Robie' }, false), 'Robie');
  assert.equal(agentPickerLabel({ role: 'explorer' }, false), '[explorer]');
  assert.equal(agentPickerLabel({}, false), 'Agent');
  assert.equal(agentPickerLabel({ agentPath: '/root/x' }, true), 'Main [default]');
});

test('a picker name is offered for switching only when it picks out one thread', () => {
  const node = (id: string, identity: Partial<SubagentTreeNode>, children: SubagentTreeNode[] = []): SubagentTreeNode =>
    ({ id, name: id, status: 'running', children, ...identity }) as SubagentTreeNode;
  const tree: SubagentTree = { rootId: 'root', totalCount: 5, updatedAt: new Date(), nodes: [
    node('a', { agentPath: '/root/audit', nickname: 'Meitner' }, [node('a1', { agentPath: '/root/audit/fixtures' })]),
    node('b', { nickname: 'Robie', role: 'explorer' }),
    node('c', { nickname: 'Robie', role: 'explorer' }),
    node('g', { kind: 'guardian' }),
  ] };
  assert.equal(uniquePickerLabel(tree, 'root'), 'Main [default]');
  assert.equal(uniquePickerLabel(tree, 'a'), '/root/audit');
  assert.equal(uniquePickerLabel(tree, 'a1'), '/root/audit/fixtures');
  assert.equal(uniquePickerLabel(tree, 'b'), undefined, 'two threads print "Robie [explorer]"');
  assert.equal(uniquePickerLabel(tree, 'g'), undefined, 'a guardian prints only the generic "Agent"');
  assert.equal(uniquePickerLabel(tree, 'missing'), undefined);
});
