import * as fs from 'node:fs';
import { join } from 'node:path';
import { nativeFixture, NOW } from './native-tree.mjs';
import { readThinJobs } from '../../dist-test/src/collectors/thin-jobs.js';
import { renderMonitor, initialMonitorState } from '../../dist-test/src/render/monitor.js';
import { setDisplayConfig } from '../../dist-test/src/render/hud-config.js';
import { setLanguage } from '../../dist-test/src/render/i18n.js';
import { stripAnsi } from '../../dist-test/src/render/colors.js';
export { NOW };
export function cardFixture(home) {
  const f = nativeFixture(home), tree = f.combined();
  const dir = join(home, 'jobs', 'j0123456789abcdef');
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries({
    'job.json': JSON.stringify({ job: 'j0123456789abcdef', herdr_pane: 'synthetic-main', role: 'imp', package: 'SYNTHETIC', created_at: new Date(NOW - 240_000).toISOString() }),
    'brief.md': '# SYNTHETIC: keyword colours',
    'STATUS.json': JSON.stringify({ state: 'working' }),
    'report.md': 'Factual details from report.md with enough words to wrap at a narrow width.',
  })) {
    fs.writeFileSync(join(dir, file), body);
    fs.utimesSync(join(dir, file), new Date(NOW - 240_000), new Date(NOW - 240_000));
  }
  const jobs = readThinJobs(home, { pane: 'synthetic-main', project: null });
  const native = f.board(tree);
  const lanes = [...jobs, ...native.lanes];
  const board = { ...native, lanes, workers: lanes.flatMap((l) => l.workers), decisions: [] };
  const render = (state = initialMonitorState(), width = 80, lang = 'en') => {
    const display = setDisplayConfig({ theme: 'terminal', icons: 'unicode' }), language = setLanguage(lang);
    try {
      return renderMonitor({ tree, workboard: board, state, width, height: 28, nowMs: NOW });
    } finally { setDisplayConfig(display); setLanguage(language); }
  };
  return { ...f, tree, board, render };
}
export function colourFrame(f, width, lang) {
  const sentences = lang === 'zh'
    ? ['正在检查report.md和src/tree-page.ts。', '评审«+批准»变更。', '评审«-拒绝»变更。', '评审«!认为更简单»。', '正在检查«解析器»。']
    : ['Checking report.md and src/tree-page.ts.', 'Review «+approves» the change.', 'Review «-rejects» the change.', 'Review «!recommends simplicity».', 'Checking «parser» boundaries.'];
  f.board.workers.forEach((w, i) => { w.modelSentence = sentences[i % sentences.length]; });
  return f.render(initialMonitorState(), width, lang);
}
export const colourFrames = (f) => Object.fromEntries([80, 120].flatMap((width) => ['en', 'zh'].map((lang) =>
  [`${lang}-${width}`, colourFrame(f, width, lang).lines.map(stripAnsi)])));
