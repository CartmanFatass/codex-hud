/** Synthetic producer files, read by the real panel pipeline (no external CLI). */
import fs from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { PanelJobPipeline } from '../../src/tree-page.js';
import { initialMonitorState, renderMonitor, type MonitorState } from '../../src/render/monitor.js';
import { stripAnsi } from '../../src/render/colors.js';
import type { SubagentTreeNode } from '../../src/types.js';
import { r5Fixture, ROOT_R5, FIXED_R5_NOW } from './r5-jobs.js';
export function p2Fixture(t: TestContext, corroborated: () => boolean = () => true) {
  const f = r5Fixture(t),
    workspace = join(f.home, 'workspace');
  fs.mkdirSync(join(workspace, 'tmp', 'tasks'), { recursive: true });
  // Simulated corroboration boundary only: the real sampler/observer runs, never an external CLI/process.
  const pipeline = new PanelJobPipeline(
    f.home,
    ROOT_R5,
    {
      now: f.now,
      herdr: async () =>
        JSON.stringify({
          result: {
            agents: corroborated()
              ? [{ name: 'synthetic-agent', tab_id: 'tab-1', pane_id: 'pane-1', agent_status: 'working' }]
              : [],
          },
        }),
      process: { alive: () => true, cmdline: () => '/synthetic/node\0/synthetic/dist/jev/runtime/entry.js\0' },
    },
    workspace
  );
  t.after(() => pipeline.dispose());
  const put = (file: string, value: unknown, at = f.now()) => {
    f.put(file, value);
    fs.utimesSync(file, new Date(at), new Date(at));
  };
  const task = (name = 'T1') => {
    const d = join(workspace, 'tmp', 'tasks', name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const status = (d: string, patch: Record<string, unknown> = {}, slot = 'primary') => {
    const value = {
      version: 1,
      task_dir: d,
      slot,
      role: slot === 'primary' ? 'implementer' : slot.startsWith('review-') ? 'reviewer' : slot.split('-')[0],
      model: 'synthetic-model',
      thinking: 'high',
      session_id: `synthetic-${slot}`,
      output_path: join(d, slot === 'primary' ? 'report.md' : `${slot}.md`),
      output_written: false,
      state: 'working',
      helper_pending: null,
      started_at: new Date(FIXED_R5_NOW - 60_000).toISOString(),
      settled_at: null,
      idle_deadline_at: null,
      ended_at: null,
      exit_reason: null,
      error: null,
      ...patch,
    };
    put(slot === 'primary' ? join(d, 'STATUS.json') : join(d, '.dispatch', slot, 'STATUS.json'), value);
    return value;
  };
  const collect = async (nodes: SubagentTreeNode[] = [], ticks = 40) => {
    for (let i = 0; i < ticks; i++) {
      await pipeline.refresh();
      await pipeline.live.settled();
    }
    const composition = pipeline.compose({ ...f.emptyTree(), nodes, totalCount: nodes.length }, null, f.now());
    return {
      board: pipeline.workboard(composition.tree, composition.legacy),
      tree: composition.tree,
      cost: pipeline.artifactCost!,
    };
  };
  const draw = async (
    state: MonitorState = { ...initialMonitorState(), mainTab: 'home' },
    width = 56,
    height = 40,
    nodes: SubagentTreeNode[] = []
  ) => {
    const data = await collect(nodes);
    const frame = renderMonitor({ ...data, workboard: data.board, state, width, height, nowMs: f.now() });
    return { ...data, frame, text: frame.lines.map(stripAnsi).join('\n') };
  };
  return { ...f, workspace, pipeline, put, task, status, collect, draw };
}
export function p2Native(name = 'Native synthetic', patch: Partial<SubagentTreeNode> = {}): SubagentTreeNode {
  return {
    id: name,
    name,
    status: 'running',
    depth: 1,
    children: [],
    startedAt: new Date(FIXED_R5_NOW - 60_000),
    turnStartedAt: new Date(FIXED_R5_NOW - 60_000),
    lastEventAt: new Date(FIXED_R5_NOW),
    ...patch,
  };
}
