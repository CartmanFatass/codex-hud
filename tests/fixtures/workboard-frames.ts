/** Synthetic disk → live panel pipeline → frame fixtures, without model/execution calls. */
import type { TestContext } from 'node:test';
import { join } from 'node:path';
import { mkdirSync, utimesSync } from 'node:fs';
import { PanelJobPipeline } from '../../src/tree-page.js';
import { initialMonitorState, renderMonitor } from '../../src/render/monitor.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { setLanguage } from '../../src/render/i18n.js';
import { stripAnsi } from '../../src/render/colors.js';
import { r5Fixture, ROOT_R5, FIXED_R5_NOW } from './r5-jobs.js';

export async function workboardFrames(t: Pick<TestContext, 'after'>): Promise<Record<string, string>> {
  const f = r5Fixture(t as TestContext),
    workspace = join(f.home, 'workspace');
  mkdirSync(join(workspace, 'tmp', 'tasks'), { recursive: true });
  let pipeline = new PanelJobPipeline(f.home, ROOT_R5, { live: false, now: f.now }, workspace);
  t.after(() => pipeline.dispose());
  const put = (path: string, value: unknown, age = 2) => {
    f.put(path, value);
    const at = new Date(FIXED_R5_NOW - age * 60000);
    utimesSync(path, at, at);
  };
  const task = (name: string, role: string, title: string, state: string) => {
    const dir = join(workspace, 'tmp', 'tasks', name);
    put(join(dir, 'brief.md'), `# ${title}`);
    put(join(dir, 'STATUS.json'), {
      version: 1,
      task_dir: dir,
      slot: 'primary',
      role,
      model: role === 'reviewer' ? 'gpt-synthetic-review' : 'gpt-synthetic',
      thinking: 'high',
      session_id: `synthetic-${name}`,
      output_path: join(dir, 'report.md'),
      output_written: state === 'idle_grace',
      state,
      helper_pending: null,
      started_at: '2026-11-09T11:30:00Z',
      settled_at: state === 'idle_grace' ? '2026-11-09T11:55:00Z' : null,
      idle_deadline_at: null,
      ended_at: null,
      exit_reason: null,
      error: null,
    });
    if (state === 'idle_grace') put(join(dir, 'report.md'), 'Synthetic work is ready for acceptance.');
    return dir;
  };
  const qa = (dir: string, n: number, answer: string) => {
    const questions = [
      ['Should compatibility stay?', 'Keep the boundary', 'drop the shim'],
      ['Should IDs stay opaque?', 'Retain UUID identifiers', 'Use a sequence'],
      ['Should audit events stay?', 'Keep audit events', 'Discard old events'],
      ['Which retry ceiling applies?', 'Use a 30 second ceiling', 'Retry indefinitely'],
      ['Should previews be passive?', 'Keep previews read-only', 'Add steering controls'],
      ['Which source stays authoritative?', 'Use the explicit source', 'Infer a name-based join'],
    ];
    const [question, a, b] = questions[n - 1];
    put(
      join(dir, 'qa', `q${n}.md`),
      `# Question\n\n${question}\n\nOptions:\n- A) ${a}\n- B) ${b}\n\nDefault if unanswered: A\n\nContext: Synthetic public fixture.`,
      4
    );
    put(join(dir, 'qa', `q${n}.answer.md`), answer);
  };
  const one = task('UI-1', 'implementer', '首页与被动工作记录 Home and passive records', 'working');
  for (let n = 1; n <= 6; n++)
    qa(one, n, n === 1 ? 'B\n\nInstead: Keep the boundary\nRationale: The explicit source is sufficient.' : 'A');
  const design = task('DESIGN', 'architect', 'Source boundaries 来源边界', 'idle_grace');
  put(
    join(design, 'architect-1.md'),
    '# Design\n\n## Recommendation\n\nKeep one explicit source boundary.\n\nOne-way: true\nAlternative: Infer a name-based join\nRationale: Never guess task ownership.'
  );
  const review = task('CHECK', 'reviewer', 'Review the synthetic path', 'working');
  put(join(review, 'review-2.md'), 'Verdict: changes-required\n\nSynthetic revision request.');
  const scratch = join(workspace, 'tmp', 'tasks', 'MOCKUP');
  put(join(scratch, 'brief.md'), '# Scratch layout experiment');
  const web = {
    id: 'web',
    executor: 'jev' as const,
    harness: null,
    model: 'synthetic-web',
    effort: null,
    env_profile: null,
    recipe: null,
  };
  f.jev(
    f.association(1, { backend: web, role: 'jev', task_label: 'Synthetic browser handoff' }),
    'completed',
    { status: 'needs_human' },
    false,
    { run: { startedAt: '2026-11-09T11:00:00Z', endedAt: '2026-11-09T11:50:00Z' } }
  );
  const frames: Record<string, string> = {};
  const save = async (mode: 'busy' | 'calm') => {
    for (let n = 0; n < 60; n++) await pipeline.refresh();
    const composed = pipeline.compose(f.emptyTree(), null, f.now()),
      board = pipeline.workboard(composed.tree);
    for (const language of ['en', 'zh'] as const)
      for (const width of [44, 56, 110])
        for (const mainTab of ['home', 'work'] as const) {
          const previous = setLanguage(language),
            display = setDisplayConfig({ theme: 'none', icons: 'unicode' });
          try {
            const frame = renderMonitor({
              tree: composed.tree,
              workboard: board,
              state: { ...initialMonitorState(), mainTab },
              width,
              height: 44,
              nowMs: f.now(),
            });
            frames[`${mode}-${mainTab}-${language}-${width}`] = frame.lines.map(stripAnsi).join('\n') + '\n';
          } finally {
            setDisplayConfig(display);
            setLanguage(previous);
          }
        }
    if (mode === 'busy') {
      const language = setLanguage('en'),
        display = setDisplayConfig({ theme: 'titanium', icons: 'unicode' });
      try {
        frames['busy-home-en-56-ansi'] =
          renderMonitor({
            tree: composed.tree,
            workboard: board,
            state: initialMonitorState(),
            width: 56,
            height: 44,
            nowMs: f.now(),
          }).lines.join('\n') + '\n';
      } finally {
        setDisplayConfig(display);
        setLanguage(language);
      }
    }
  };
  await save('busy');
  // A new, explicitly rebound workspace has only calm, completed observations.
  const calm = join(f.home, 'calm');
  mkdirSync(join(calm, 'tmp', 'tasks', 'DONE'), { recursive: true });
  put(join(calm, 'tmp', 'tasks', 'DONE', 'brief.md'), '# Synthetic completed work');
  pipeline.dispose();
  pipeline = new PanelJobPipeline(f.home, ROOT_R5, { live: false, now: f.now }, calm);
  f.jev(
    f.association(1, { backend: web, role: 'jev', task_label: 'Synthetic browser finished', closed: true }),
    'completed',
    { status: 'answered', answer: 'Synthetic completed reply' },
    true,
    { run: { endedAt: '2026-11-09T11:50:00Z' } }
  );
  await save('calm');
  return frames;
}
