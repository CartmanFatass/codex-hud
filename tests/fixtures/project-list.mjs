/** Synthetic projects for the Projects list, read from disk by the same light overview the panel uses. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { ProjectOverviews } from '../../dist/collectors/project-visits.js';
import { projectFixture, NOW, plain, onPage } from './project-page.mjs';
const DAY = 1440;
/** The panel's own project plus five: one waiting, one with two running jobs (and a settled one), one quiet, one with no STATE.md, one old. */
export async function listFixture(root) {
  const f = await projectFixture(root);
  const dir = (name) => { fs.mkdirSync(join(root, name), { recursive: true }); return fs.realpathSync(join(root, name)); };
  const state = (path, milestone, waiting, slices, age) => f.put(join(path, 'STATE.md'),
    `# State\n\nMilestone: ${milestone}\n\n## Waiting for the owner\n${waiting.map((w) => `- ${w}\n`).join('')}\n## Slices\n${slices.map((s) => `- ${s}\n`).join('')}`, age);
  const job = (id, cwd, status) => {
    f.put(join(f.hud, 'jobs', id, 'job.json'), { job: id, role: 'imp', cwd, created_at: new Date(NOW - 30 * 60000).toISOString() });
    f.put(join(f.hud, 'jobs', id, 'STATUS.json'), { state: status });
  };
  const quiet = dir('quiet-project'), waiting = dir('waiting-project'), busy = dir('busy-project'), bare = dir('bare-project'), old = dir('old-project');
  state(quiet, '0.2', [], ['accepted · 0.2 · A-ONE · done (a1b2c3d)', 'accepted · 0.2 · A-TWO · done (b2c3d4e)', 'working · 0.2 · A-THREE · going', 'todo · 0.2 · A-FOUR · later'], 3 * DAY + 0.5);
  state(waiting, 'M5', ['Choose the synthetic option', 'Answer the synthetic question'], ['try · M5 · B-ONE · landed (c3d4e5f)', 'try · M5 · B-TWO · landed (d4e5f6a)', 'todo · M5 · B-THREE · later'], 5 * 60 + 0.5);
  state(busy, 'M2', [], ['working · M2 · C-ONE · going', 'working · M2 · C-TWO · going', 'accepted · M2 · C-THREE · done (e5f6a7b)'], 20.5);
  state(old, 'M1', [], ['accepted · M1 · D-ONE · done (f6a7b8c)'], 40 * DAY + 0.5);
  f.put(join(bare, '.scratch/feature/issues/01-first.md'), '# 01: First\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n\n- [ ] One\n', 2 * DAY + 0.5);
  fs.mkdirSync(join(busy, 'sub'));
  job('j00000000000000c1', busy, 'working');
  job('j00000000000000c2', join(busy, 'sub'), 'waiting_orchestrator');
  job('j00000000000000c3', busy, 'done');
  job('j00000000000000c4', old, 'idle_grace');
  const own = fs.realpathSync(f.cwd);
  const places = [[own, 'demo-project'], [quiet, 'quiet-project'], [waiting, 'waiting-project'], [busy, 'busy-project'], [bare, 'bare-project'], [old, 'old-project']];
  const pool = () => new ProjectOverviews((r) => new ProjectCollector(r, f.hud, f.env, f.home), own);
  const overview = await pool().read(places.map(([r]) => r), f.board, NOW);
  const projects = places.map(([root, name]) => ({ root, name, overview: overview.get(root) }));
  const list = (width, lang = 'en', state = onPage(undefined, { projectList: true }), height = 24, icons = 'unicode', choices = projects) =>
    f.render(width, lang, state, height, f.data, true, icons, 'none', { projects: choices, projectName: 'demo-project' });
  return { ...f, projects, places, pool, list, overview };
}
/** The list at 40, 80 and 120 columns EN and ZH, and in text icons at 40. */
export function listFrames(l) {
  const frames = {};
  for (const lang of ['en', 'zh']) for (const width of [40, 80, 120]) frames[`list-${width}-${lang}`] = plain(l.list(width, lang));
  frames['list-40-text'] = plain(l.list(40, 'en', undefined, 24, 'text'));
  return frames;
}
