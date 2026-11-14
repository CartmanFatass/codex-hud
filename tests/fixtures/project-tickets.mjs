/** Local to-tickets fixtures; all files, jobs and times are synthetic. */
import { join } from 'node:path';
import { projectFixture, NOW, plain } from './project-page.mjs';
export const ticketVocabulary = [
  ['07', 'resolved', 'done', [' '], 'None'],
  ['08', 'wontfix', 'dropped', ['x'], 'None'],
  ['09', 'claimed', 'working', [' '], 'None'],
  ['10', 'needs-triage', 'ready', [' '], '07'],
  ['11', 'needs-info', 'ready', [' '], 'Vocabulary wontfix'],
  ['12', 'ready-for-human', 'ready', [' '], 'None'],
  ['13', 'ready-for-agent', 'ready', [' '], '08'],
];
export async function ticketFixture(root) {
  const f = await projectFixture(root);
  const issue = (feature, number, slug, title, status = 'ready-for-agent', blocked = 'None (can start immediately)', boxes = [' '], age = 1) => {
    const path = join(f.cwd, '.scratch', feature, 'issues', `${number}-${slug}.md`);
    f.put(path, `# ${number}: ${title}\n\n**What to build:** A synthetic vertical slice.\n\n**Blocked by:** ${blocked}\n\n**Status:** ${status}\n\n${boxes.map((x, i) => `- [${x}] Criterion ${i + 1}`).join('\n')}\n`, age);
    return path;
  };
  const paths = {
    working: issue('native-tree', '02', 'home-lanes', 'Home lanes', 'ready-for-agent', 'None (can start immediately)', ['x', ' ', ' ', ' ']),
    ready: issue('native-tree', '03', 'inspector', 'Inspector', 'ready-for-agent', 'None (can start immediately)', [' ', ' ', ' ']),
    number: issue('native-tree', '04', 'settings', 'Settings cleanup', 'ready-for-agent', '02, 03', [' ', ' ']),
    title: issue('native-tree', '05', 'shortcuts', 'Shortcuts', 'ready-for-agent', 'Inspector', [' ']),
    unknown: issue('native-tree', '06', 'polish', 'Polish', 'triaging', 'None (can start immediately)', []),
    status: issue('retired-tools', '01', 'collector', 'Claude collector', 'DoNe', 'None (can start immediately)', [' ', ' '], 30),
    boxes: issue('retired-tools', '02', 'cleanup', 'Legacy cleanup', 'ready-for-agent', '01', ['x', 'X'], 30),
  };
  for (const [number, status, , boxes, blocked] of ticketVocabulary)
    issue('native-tree', number, status, `Vocabulary ${status}`, status, blocked, boxes);
  f.put(join(f.cwd, '.scratch/native-tree/issues/99-malformed.md'), '# Not a ticket\n**Status:** done\n');
  const job = join(f.hud, 'jobs/j0000000000000010');
  f.put(join(job, 'job.json'), { job: 'j0000000000000010', role: 'imp', cwd: f.cwd, package: 'native-tree',
    created_at: new Date(NOW - 12 * 60000).toISOString() });
  f.put(join(job, 'STATUS.json'), { state: 'working', started_at: new Date(NOW - 12 * 60000).toISOString() });
  f.put(join(job, 'brief.md'), '# Build Home lanes\nImplement .scratch/native-tree/issues/02-home-lanes.md\n');
  const data = await f.collector.collect(true, f.board, NOW + 1);
  const render = (width, lang = 'en', state, snapshot = data, theme = 'none', height = 72) => f.render(width, lang, state, height, snapshot, false, 'unicode', theme);
  return { ...f, data, paths, issue, ticketJob: job, render };
}
/** The hub (now with its Tickets entry) and the Tickets page. */
export function ticketFrames(f) {
  const frames = {};
  for (const lang of ['en', 'zh']) for (const width of [40, 80, 120]) {
    frames[`tickets-${width}-${lang}`] = plain(f.render(width, lang, 'tickets'));
    if (width !== 80) frames[`hub-${width}-${lang}`] = plain(f.render(width, lang, undefined, f.data, 'none', 24));
  }
  return frames;
}
