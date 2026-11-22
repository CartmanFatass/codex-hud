/** The Split layout's synthetic scene: several package lanes (one asks, one failed, one with a finished report), a native lane, decisions, tickets. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { renderMonitor, initialMonitorState } from '../../dist/render/monitor.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { ticketFixture } from './project-tickets.mjs';
import { NOW, TREE, plain, onControl, richProgress, richControl } from './project-page.mjs';

export const split = (extra) => ({ ...initialMonitorState(), panelLayout: 'split', ...extra });
/** `idle`: every job has settled and nothing asks, so Home's list is what finished plus Waiting and Progress. */
export async function splitFixture(root, { idle = false } = {}) {
  const f = await ticketFixture(root);
  const job = (n, role, title, status, age, files = {}) => {
    const id = `j00000000000000${n}`, dir = join(f.hud, 'jobs', id), iso = (m) => new Date(NOW - m * 60000).toISOString();
    f.put(join(dir, 'job.json'), { job: id, role, cwd: f.cwd, herdr_pane: 'w4E:p1', created_at: iso(age + 20) }, age + 20);
    f.put(join(dir, 'STATUS.json'), { started_at: iso(age + 20), ...status }, age);
    f.put(join(dir, 'brief.md'), `# ${title}\n`, age + 20);
    for (const [name, text] of Object.entries(files)) f.put(join(dir, name), text, age);
  };
  job('30', 'reviewer', 'NATIVE-TREE: retry tests', { state: 'done' }, 2, { 'report.md': 'tests pass; two minor items left\n' });
  job('31', 'sonic', 'EXPORT-CSV: slow tests', idle ? { state: 'done' } : { state: 'failed', reason: 'HTTP 429, no report was written' }, 9);
  job('32', 'reviewer', 'AUTH-REFRESH: token rotation', idle ? { state: 'done' } : { state: 'working' }, 6, idle ? { 'report.md': 'rotation window checked\n' } : {});
  if (idle) {
    for (const id of ['1', '2', '10']) f.put(join(f.hud, 'jobs', `j${id.padStart(16, '0')}`, 'STATUS.json'), { state: 'done' }, 8);
    f.put(join(f.sliceJob, 'qa/q1.answer.md'), 'compact\n');
    f.put(join(f.sliceJob, 'STATUS.json'), { state: 'done' }, 8);
  }
  f.put(join(f.job, 'qa/q1.md'), 'Question: Use the synthetic layout?\n\nOptions:\n- compact\n- wide\n\nDefault if unanswered: compact\n');
  f.put(join(f.job, 'qa/q1.answer.md'), 'compact\n');
  const lanes = readThinJobs(f.hud, { project: f.cwd, pane: 'w4E:p1' });
  const native = { ...lanes[0].workers[0], id: 'native-synthetic', laneId: 'native-session', task: 'Synthetic native card', nativeDepth: 1, homeNeedsHuman: false };
  lanes.push({ ...lanes[0], id: 'native-session', identity: { kind: 'native' }, label: 'this session', workers: idle ? [] : [native], decisions: [] });
  const board = { ...f.board, lanes, workers: lanes.flatMap((l) => l.workers), decisions: lanes.flatMap((l) => l.decisions) };
  const data = await new ProjectCollector(f.cwd, f.hud, f.env, f.home).collect(true, board, NOW);
  const rich = { ...richProgress(data), tickets: data.tickets, waiting: data.waiting };
  const render = (width, lang = 'en', height = 40, state = split(), snapshot = data, { icons = 'unicode', ...extras } = {}) => {
    const display = setDisplayConfig({ theme: 'none', icons }), previous = setLanguage(lang);
    try { return renderMonitor({ tree: TREE, workboard: board, project: snapshot, projectName: 'demo-project', state: { acceptance: 'slice', ...state }, width, height, nowMs: NOW, modelEnabled: false, ...extras }); }
    finally { setDisplayConfig(display); setLanguage(previous); }
  };
  return { ...f, board, data, rich, control: richControl(rich), render };
}
/** The frames the snapshot keeps: Home busy, idle and short, the hub, and the pages, at 40 columns in both languages (80 and 120 for Home busy). */
export function splitFrames(busy, idle) {
  const frames = {}, page = (p, extra) => split({ mainTab: 'project', projectPage: p, projectFolded: new Set(['agents', 'healthy', 'files']), ...extra });
  for (const lang of ['en', 'zh']) {
    frames[`home-busy-40-${lang}`] = plain(busy.render(40, lang, 40));
    frames[`home-short-40-${lang}`] = plain(busy.render(40, lang, 24));
    frames[`home-idle-40-${lang}`] = plain(idle.render(40, lang, 40));
    frames[`hub-40-${lang}`] = plain(busy.render(40, lang, 40, page(undefined), busy.control));
    frames[`hub-short-40-${lang}`] = plain(busy.render(40, lang, 24, page(undefined), busy.control));
    frames[`progress-40-${lang}`] = plain(busy.render(40, lang, 40, page('progress'), busy.rich));
    const control = { ...busy.control, radar: undefined };
    frames[`control-40-${lang}`] = plain(busy.render(40, lang, 40, onControl(undefined, split({ mainTab: 'control' })), control));
    const unfolded = onControl({ cursor: 'project:role:reviewer', folded: new Set(['agents', 'usage', 'files']) }, split({ mainTab: 'control' }));
    frames[`control-unfolded-40-${lang}`] = plain(busy.render(40, lang, 40, unfolded, control));
    frames[`tickets-40-${lang}`] = plain(busy.render(40, lang, 40, page('tickets')));
    frames[`tree-40-${lang}`] = plain(busy.render(40, lang, 40, page('tree')));
    frames[`docs-40-${lang}`] = plain(busy.render(40, lang, 40, page('docs')));
  }
  for (const width of [80, 120]) frames[`home-busy-${width}-en`] = plain(busy.render(width, 'en', 40));
  return frames;
}
