/** Two finished HUD jobs (real thin-job reader) and one finished native agent, settled at NOW, for CARD-FOLD. */
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { readThinJobs } from '../../dist-test/src/collectors/thin-jobs.js';
import { renderMonitor } from '../../dist-test/src/render/monitor.js';
import { setLanguage } from '../../dist-test/src/render/i18n.js';
import { setDisplayConfig } from '../../dist-test/src/render/hud-config.js';
import { targetKey } from '../../dist-test/src/collectors/workboard-types.js';
import { nativeFixture } from './native-tree.mjs';
export { NOW } from './native-tree.mjs';
import { NOW } from './native-tree.mjs';
export const MIN = 60000;
const SENTENCE =
  'Added the retry helper with bounded backoff; the unit tests cover the 429 and 503 replies and the cap stays at 30 seconds.';
/** `job1` settled at NOW, `job2` a minute earlier: `job1` is the newest result. */
export function jobBoard(home) {
  const ago = (m) => new Date(NOW - m * MIN);
  const put = (file, text, m) => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text));
    utimesSync(file, ago(m), ago(m));
  };
  for (const [n, title, settled] of [[1, 'Add the retry helper', 0], [2, 'Write the migration notes', 1]]) {
    const id = `j${String(n).padStart(16, '0')}`, dir = join(home, 'jobs', id);
    put(join(dir, 'job.json'), { job: id, role: 'imp', package: 'FOLD', herdr_pane: 'w1:p1', created_at: ago(30).toISOString() }, 30);
    put(join(dir, 'brief.md'), '# ' + title, 30);
    put(join(dir, 'report.md'), 'Done; tests pass.', settled);
    put(join(dir, 'STATUS.json'), { state: 'done', started_at: ago(30).toISOString(), settled_at: ago(settled).toISOString() }, settled);
  }
  const lanes = readThinJobs(home, { project: '/synthetic/repo', pane: 'w1:p1' }).map((l) => ({
    ...l,
    workers: l.workers.map((w) => ({ ...w, modelSentence: SENTENCE })),
  }));
  return {
    revision: 'synthetic',
    lanes,
    workers: lanes.flatMap((l) => l.workers),
    decisions: [],
    coverage: { incomplete: false, diagnostics: [], workspace: '/synthetic/repo' },
  };
}
/** The finished Claude subagent of the native fixture, settled at NOW. */
export function nativeBoard(home) {
  const f = nativeFixture(home), tree = f.combined();
  tree.nodes[0].children[0].statusAt = new Date(NOW);
  return { tree, board: f.board(tree) };
}
export const EMPTY_TREE = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(NOW) };
export function drawAt(board, state, minutes, width = 80, lang = 'en', tree = EMPTY_TREE) {
  const display = setDisplayConfig({ theme: 'none', icons: 'unicode' }), language = setLanguage(lang);
  try {
    return renderMonitor({ tree, workboard: board, state, width, height: 60, nowMs: NOW + minutes * MIN, modelEnabled: false });
  } finally {
    setDisplayConfig(display);
    setLanguage(language);
  }
}
export const rowsOf = (frame, worker) =>
  frame.workboard.rows.filter((r) => r.item === targetKey({ kind: 'worker', laneId: worker.laneId, workerId: worker.id }));
