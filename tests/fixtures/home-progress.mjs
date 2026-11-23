import { sliceState, withState } from './state-helpers.mjs';
/** Home's spare-row progress: synthetic questions, decisions, HUD and native cards. */
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { renderMonitor } from '../../dist/render/monitor.js';
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
  const render = (width, lang = 'en', height = 56, state = sliceState(), snapshot = data, extras = {}) => {
    const display = setDisplayConfig({ theme: 'none', icons: 'unicode' }), previous = setLanguage(lang);
    try { return renderMonitor({ tree: TREE, workboard: board, project: snapshot, state, width, height, nowMs: NOW, modelEnabled: false, ...extras }); }
    finally { setDisplayConfig(display); setLanguage(previous); }
  };
  return { ...f, board, collector, data, render };
}
export function homeFrames(f) {
  const frames = Object.fromEntries([52, 80, 120].flatMap((width) => ['en', 'zh'].flatMap((lang) => {
    // The cards and the top line (two rows) STATE's waiting items add.
    const base = f.render(width, lang, 100, undefined, null).workboard.rows.length;
    // Spare rows after the cards: everything, tickets cut, legend only, bar only, block gone.
    return [['tall', 14], ['tickets-short', 9], ['legend-short', 6], ['bar-short', 4], ['gone', 2]]
      .map(([size, spare]) => [`home-${width}-${lang}-${size}`, plain(f.render(width, lang, base + 2 + spare))]);
  })));
  // At default task detail, show the project's totals (including finished features no longer retained),
  // a started feature, and one folded row for the two plans. No individual ticket titles on Home.
  const plan = f.data.tickets[0].tickets.filter(t => t.number === '03' || t.number === '04');
  const milestone = '0.4.0';
  const ledger = [['accepted', 14], ['try', 4], ['working', 2], ['todo', 6]].flatMap(([state, n]) => Array.from({ length: n }, (_, i) => ({
    state, id: `SYNC-${state}-${i}`, milestone: `batch-${i % 2}`, release: milestone, text: 'Synthetic release slice',
  })));
  const data = { ...f.data, summary: '', ladder: { current: milestone, ids: [milestone] }, ledger,
    tickets: [...f.data.tickets, ...['plan-a', 'plan-b'].map(slug => ({ slug, tickets: plan }))],
    ticketTotals: { doneFeatures: 31, totalFeatures: 34, doneTickets: 124, totalTickets: 138 } };
  for (const lang of ['en', 'zh']) {
    const state = withState(sliceState(), { prefs: { panelLayout: 'split' }, home: { split: { listCursor: 'home-progress:progress' } } });
    frames[`rollup-40-${lang}`] = plain(f.render(40, lang, 36, state, data));
  }
  return frames;
}
