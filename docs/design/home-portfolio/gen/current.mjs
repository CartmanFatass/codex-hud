// The real renderer (dist/) over the synthetic fixture: Current Home and Current Project frames.
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const dist = (p) => import(pathToFileURL(join(fileURLToPath(new URL('../../../../dist/', import.meta.url)), p)).href);
const [{ HomePortfolioCollector }, { ProjectCollector }, { readThinJobs }, { projectList }, mon, { setDisplayConfig }, { setLanguage }, colors] = await Promise.all([
  dist('collectors/home-portfolio.js'), dist('collectors/project-board.js'), dist('collectors/thin-jobs.js'), dist('roles/projects.js'),
  dist('render/monitor.js'), dist('render/hud-config.js'), dist('render/i18n.js'), dist('render/colors.js'),
]);
export { colors, setDisplayConfig, setLanguage };
export const { visualLength, stripAnsi } = colors;

export async function collectAll(fx, now) {
  const own = fx.roots.harbor;
  const board = { revision: 'x', lanes: [], workers: [], decisions: [], coverage: { incomplete: false, diagnostics: [], workspace: own } };
  const list = projectList(fx.home, own);
  const collector = new HomePortfolioCollector(fx.home);
  const portfolio = await collector.read(list, board, now);
  const lanes = readThinJobs(fx.home, { project: own, pane: 'w1:p1' });
  const pboard = { ...board, lanes, workers: lanes.flatMap((l) => l.workers) };
  const env = { HOME: join(fx.dir, 'h'), HUD_HOME: fx.home, PATH: '/nonexistent', CODEX_HOME: join(fx.dir, 'h/.codex'), CLAUDE_CONFIG_DIR: join(fx.dir, 'h/.claude') };
  const pc = new ProjectCollector(own, fx.home, env, join(fx.dir, 'h'));
  const project = await pc.collect(true, pboard, now);
  return { portfolio, project, board: pboard, own };
}

export function renderCurrent(ctx, { tab, width, height, lang, now }) {
  const prevCfg = setDisplayConfig({ theme: 'mocha', icons: 'nerd' }), prevLang = setLanguage(lang);
  try {
    const state = mon.initialMonitorState();
    if (tab === 'project') { state.activeTab = 'project'; state.selectedProject = ctx.own; }
    const frame = mon.renderMonitor({
      state, width, height, nowMs: now, homePortfolio: ctx.portfolio, homeWaiting: ctx.portfolio.projects.find((p) => p.root === ctx.own).snapshot.waiting,
      paneLoad: { running: 2, queued: 0 }, workboard: ctx.board, project: ctx.project, projectName: 'harbor-api',
      projects: ctx.portfolio.projects.map(({ root, name }) => ({ root, name })), modelEnabled: false,
    });
    return frame.lines;
  } finally { setDisplayConfig(prevCfg); setLanguage(prevLang); }
}
