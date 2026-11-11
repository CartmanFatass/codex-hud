import { type TestContext } from 'node:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { PanelJobPipeline } from '../../src/tree-page.js';
import { initialMonitorState, renderMonitor, type MonitorState } from '../../src/render/monitor.js';
import { stripAnsi } from '../../src/render/colors.js';
import { r5Fixture, ROOT_R5, FIXED_R5_NOW } from './r5-jobs.js';

function fixture(t: TestContext) {
  const f = r5Fixture(t),
    workspace = join(f.home, 'workspace');
  fs.mkdirSync(join(workspace, 'tmp', 'tasks'), { recursive: true });
  const pipeline = new PanelJobPipeline(f.home, ROOT_R5, { live: false, now: f.now }, workspace);
  t.after(() => pipeline.dispose());
  const task = (name = 'T1') => {
    const directory = join(workspace, 'tmp', 'tasks', name);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  };
  const put = (file: string, text: unknown, at = FIXED_R5_NOW - 60000) => {
    f.put(file, text);
    fs.utimesSync(file, new Date(at), new Date(at));
  };
  const qa = (
    directory: string,
    n: number,
    answer: string,
    options = ['A) Keep a shim', 'B) Remove the shim'],
    suggested = 'A'
  ) => {
    put(
      join(directory, 'qa', `q${n}.md`),
      `# Question q${n} from implementer\n\nWhich approach?\n\nOptions:\n${options.map((o) => '- ' + o).join('\n')}\n\nDefault if unanswered: ${suggested}\n\nContext: Synthetic compatibility constraint.\n\nAnswer: write elsewhere (not a locator)\n`,
      FIXED_R5_NOW - 120000
    );
    put(join(directory, 'qa', `q${n}.answer.md`), answer);
  };
  const status = (directory: string, patch: Record<string, unknown> = {}) =>
    put(join(directory, 'STATUS.json'), {
      version: 1,
      task_dir: directory,
      slot: 'primary',
      role: 'implementer',
      model: 'synthetic-model',
      thinking: 'high',
      session_id: 'synthetic-primary',
      output_path: join(directory, 'report.md'),
      output_written: false,
      state: 'working',
      helper_pending: null,
      started_at: '2026-11-09T11:30:00Z',
      settled_at: null,
      idle_deadline_at: null,
      ended_at: null,
      exit_reason: null,
      error: null,
      ...patch,
    });
  const collect = async (ticks = 30) => {
    for (let i = 0; i < ticks; i++) await pipeline.refresh();
    const composition = pipeline.compose(f.emptyTree(), null, f.now());
    return {
      board: pipeline.workboard(composition.tree, composition.legacy),
      tree: composition.tree,
      cost: pipeline.artifactCost!,
    };
  };
  const draw = async (state: MonitorState = initialMonitorState(), width = 56, height = 80) => {
    const data = await collect();
    const frame = renderMonitor({ tree: data.tree, workboard: data.board, state, width, height, nowMs: f.now() });
    return { ...data, frame, text: frame.lines.map(stripAnsi).join('\n') };
  };
  return { ...f, workspace, pipeline, task, put, qa, status, collect, draw };
}
export { fixture };
