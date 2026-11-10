/** Fixed producer files -> real Workboard -> Home, Work, real handoff and Inspector. */
import fs from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { p2Fixture, p2Native } from './work-card-p2.js';
import { defaultSettings } from '../../src/settings.js';
import {
  initialMonitorState,
  monitorSettings,
  renderMonitor,
  handleMonitorInput,
  type MonitorState,
} from '../../src/render/monitor.js';
import { setLanguage } from '../../src/render/i18n.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import type { WorkTarget } from '../../src/collectors/workboard-types.js';
export async function workCardFrames(t: TestContext): Promise<Record<string, string>> {
  const f = p2Fixture(t);
  const privateHome = join(f.home, 'private');
  for (const [name, value] of Object.entries({
    HOME: privateHome,
    HUD_HOME: join(privateHome, 'hud'),
    CODEX_HOME: join(privateHome, 'codex'),
    HUD_SETTINGS_PATH: join(privateHome, 'settings.json'),
  })) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const make = (id: string, title: string, patch: Record<string, unknown> = {}) => {
    const d = f.task(id);
    f.put(join(d, 'brief.md'), `# ${title}`);
    f.status(d, patch);
    return d;
  };
  const build = make('BUILD', 'P2 · shared lane renderer 共享泳道');
  f.put(
    join(build, 'qa/q1.md'),
    '# Question\n\nShould the explicit boundary stay?\n\nOptions:\n- A) Keep the explicit boundary\n- B) Change the synthetic boundary\n\nDefault if unanswered: A\n\nContext: Synthetic public visual fixture.'
  );
  f.put(
    join(build, 'qa/q1.answer.md'),
    'B\n\nInstead: Keep the explicit boundary\nRationale: This long synthetic one-way decision keeps its context and alternative in the Inspector.\nOne-way: true'
  );
  const waiting = make('NEEDS-YOU', 'Answer the boundary question 答复边界问题', { state: 'waiting_orchestrator' });
  f.put(
    join(waiting, 'qa/q1.md'),
    '# Question\n\nWhich boundary applies?\n\nOptions:\n- A) Keep\n- B) Change\n\nDefault if unanswered: A'
  );
  make('STALLED', 'No new evidence for twenty minutes 暂无进展', {
    started_at: new Date(f.now() - 20 * 60000).toISOString(),
  });
  const ready = make('TO-ACCEPT', 'Primary result ready 等待验收');
  f.put(
    join(ready, 'report.md'),
    '# Primary report\n\n## Files changed\n- `src/synthetic.ts` one synthetic file\n\n## Checks\n# tests 12\n# suites 0\n# pass 12\n# fail 0\n'
  );
  f.status(ready, { state: 'idle_grace', output_written: true, settled_at: new Date(f.now()).toISOString() });
  make('DESIGN', 'One source boundary 来源边界', { role: 'architect' });
  const chores = make('CHORES', 'Mechanical documentation 同步文档', {
    state: 'waiting_helper',
    helper_pending: { kind: 'sonic', n: 1, status_file: null },
  });
  f.status(chores, {}, 'sonic-1');
  const review = make('REVIEW', 'Validated review round 真实评审', {
    state: 'waiting_helper',
    helper_pending: { kind: 'review', n: 1, status_file: null },
  });
  f.put(join(review, 'review-1.md'), 'Verdict: accept\n\nSynthetic review, never card prose.');
  f.status(review, { state: 'closed', output_written: true, settled_at: new Date(f.now()).toISOString() }, 'review-1');
  const a = f.association(851, { task_label: 'Facade-closed result 已关闭结果' });
  f.dispatch(a, 'closed', { output_written: true, settled_at: new Date(f.now() - 60000).toISOString() });
  f.put(join(f.home, 'jobs', a.job, 'report.md'), '# Synthetic completed output');
  f.put(
    join(f.home, 'jobs', a.job, 'qa/q1.md'),
    '# Question\n\nShould the explicit source stay?\n\nOptions:\n- A) Keep one source\n- B) Infer a join\n\nDefault if unanswered: A\n\nContext: Synthetic invocation context.'
  );
  f.put(join(f.home, 'jobs', a.job, 'qa/q1.answer.md'), 'A\n\nRationale: Preserve the existing source boundary.');
  f.association(851, { closed: true, task_label: a.task_label });
  // Rejected local path contributes explicit partial coverage, not an invented worker.
  fs.symlinkSync('../missing-private-task', join(f.workspace, 'tmp/tasks/UNAVAILABLE'));
  const native = p2Native('Native owner 原生代理', {
    label: 'Native-only short card 原生简卡',
    model: 'Very long observed model '.repeat(10),
    effort: 'max',
  });
  const data = await f.collect([native], 300);
  const decision = data.board.decisions.find((d) => d.kind === 'answer' && d.oneWay)!;
  if (!decision || !data.board.coverage.incomplete) throw new Error('P2 visual producer facts did not settle');
  const target: WorkTarget = { kind: 'decision', laneId: decision.laneId, decisionId: decision.id };
  const finished = data.board.lanes.find((l) => l.identity.kind === 'invocation')!;
  const call = finished.decisions.find((d) => d.kind === 'answer')!;
  const inspector: WorkTarget = { kind: 'decision', laneId: finished.id, decisionId: call.id };
  const logs = new Map([
    [
      native.id,
      [
        {
          at: f.now(),
          kind: 'note' as const,
          text: 'One allowed native sentence. Full native detail stays available only after expansion.',
        },
      ],
    ],
  ]);
  const result: Record<string, string> = {};
  for (const language of ['en', 'zh'] as const)
    for (const width of [44, 56, 110])
      for (const theme of ['none', 'titanium'] as const) {
        const oldLanguage = setLanguage(language),
          oldDisplay = setDisplayConfig({ theme, icons: 'unicode', glyphs: 'text', look: 'tab', motion: 'reduced' });
        try {
          const base: MonitorState = {
            ...initialMonitorState(),
            ...monitorSettings(defaultSettings()),
            mainTab: 'work',
            workTarget: target,
            homeTarget: target,
          };
          const draw = (state: MonitorState) =>
            renderMonitor({
              tree: data.tree,
              workboard: data.board,
              agentLog: logs,
              state,
              width,
              height: 54,
              nowMs: f.now(),
            });
          const home = draw({ ...base, mainTab: 'home' }),
            work = draw(base);
          const handoff = draw(
            handleMonitorInput(
              home.state,
              { type: 'key', key: 'enter' },
              { tree: data.tree, frame: home, nowMs: f.now() }
            ).state
          );
          const owner = draw({ ...base, workTarget: inspector });
          const inspected = draw(
            handleMonitorInput(
              owner.state,
              { type: 'key', key: 'inspect' },
              { tree: data.tree, frame: owner, nowMs: f.now() }
            ).state
          );
          if (handoff.state.mainTab !== 'work' || inspected.state.focus !== 'details' || !inspected.state.boardInspect)
            throw new Error('P2 real handoff/Inspector did not activate');
          for (const [page, frame] of Object.entries({ home, work, handoff, inspector: inspected })) {
            if (frame.lines.some((line) => visualLength(line) !== width))
              throw new Error(`bad P2 visual width: ${page}/${language}/${width}/${theme}`);
            result[`${page}-${language}-${width}-${theme}`] =
              frame.lines.map((line) => (theme === 'none' ? stripAnsi(line) : line)).join('\n') + '\n';
          }
        } finally {
          setDisplayConfig(oldDisplay);
          setLanguage(oldLanguage);
        }
      }
  return result;
}
