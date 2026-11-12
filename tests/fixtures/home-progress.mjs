/** Home's spare-row progress: synthetic questions, decisions, HUD and native cards. */
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { renderMonitor, initialMonitorState } from '../../dist/render/monitor.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { ticketFixture } from './project-tickets.mjs';
import { NOW, TREE, plain } from './project-page.mjs';
import { join } from 'node:path';
export async function homeFixture(root) {
  const f = await ticketFixture(root);
  f.put(join(f.job, 'qa/q1.md'), 'Question: Use the synthetic layout?\n\nOptions:\n- compact\n- wide\n\nDefault if unanswered: compact\n');
  f.put(join(f.job, 'qa/q1.answer.md'), 'compact\n');
  const lanes = readThinJobs(f.hud, { project: f.cwd, pane: 'w4E:p1' });
  const native = { ...lanes[0].workers[0], id: 'native-synthetic', laneId: 'native-session',
    task: 'Synthetic native card', nativeDepth: 1, homeNeedsHuman: false };
  lanes.push({ ...lanes[0], id: 'native-session', identity: { kind: 'native' }, label: 'this session', workers: [native], decisions: [] });
  const board = { ...f.board, lanes, workers: lanes.flatMap((l) => l.workers), decisions: lanes.flatMap((l) => l.decisions) };
  const collector = new ProjectCollector(f.cwd, f.hud, f.env, f.home);
  const data = await collector.collect('home', board, NOW);
  const render = (width, lang = 'en', height = 56, state = initialMonitorState(), snapshot = data, extras = {}) => {
    const display = setDisplayConfig({ theme: 'none', icons: 'unicode' }), previous = setLanguage(lang);
    try { return renderMonitor({ tree: TREE, workboard: board, project: snapshot, state, width, height, nowMs: NOW, modelEnabled: false, ...extras }); }
    finally { setDisplayConfig(display); setLanguage(previous); }
  };
  return { ...f, board, collector, data, render };
}
export function homeFrames(f) {
  return Object.fromEntries([80, 120].flatMap((width) => ['en', 'zh'].flatMap((lang) => {
    const base = f.render(width, lang, 100, undefined, undefined).workboard.rows.filter((r) => !r.item?.startsWith('home-progress:')).length;
    return [['tall', base + 24], ['tickets-short', base + 10], ['legend-short', base + 5], ['gone', base + 4]]
      .map(([size, height]) => [`home-${width}-${lang}-${size}`, plain(f.render(width, lang, height))]);
  })));
}
