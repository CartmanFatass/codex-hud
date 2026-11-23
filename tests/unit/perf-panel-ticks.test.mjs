import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { appendTry } from '../../dist/collectors/try-records.js';
import { clearJobIndexCaches, JobIndexCache } from '../../dist/roles/job-index-cache.js';
import { truncateAnsi, visualWidth } from '../../dist/render/colors.js';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const EMPTY_BOARD = {
  revision: 'synthetic',
  lanes: [],
  workers: [],
  decisions: [],
  coverage: { incomplete: false, diagnostics: [], workspace: '' },
};

const ZERO_WIDTH_RANGES = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0x20d0, 0x20f0],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
];
const WIDE_RANGES = [
  [0x1100, 0x115f],
  [0x26a1, 0x26a1],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function refCodePointWidth(cp) {
  if (cp < 0x0300) return 1;
  for (const [lo, hi] of ZERO_WIDTH_RANGES) if (cp >= lo && cp <= hi) return 0;
  for (const [lo, hi] of WIDE_RANGES) if (cp >= lo && cp <= hi) return 2;
  return 1;
}

function refTruncateAnsi(text, maxWidth, ellipsis = '…') {
  if (maxWidth <= 0) return '';
  let w = 0;
  for (let i = 0; i < text.length; ) {
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      const end = text.indexOf('m', i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    const cp = text.codePointAt(i) ?? 0;
    w += refCodePointWidth(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  if (w <= maxWidth) return text;
  const limit = Math.max(0, maxWidth - refCodePointWidth(ellipsis.codePointAt(0) ?? 0));
  let out = '', visible = 0, i = 0, sawAnsi = false;
  while (i < text.length && visible < limit) {
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      const end = text.indexOf('m', i + 2);
      if (end === -1) break;
      out += text.slice(i, end + 1);
      sawAnsi = true;
      i = end + 1;
      continue;
    }
    const cp = text.codePointAt(i) ?? 0;
    const cw = refCodePointWidth(cp);
    if (visible + cw > limit) break;
    const sz = cp > 0xffff ? 2 : 1;
    out += text.slice(i, i + sz);
    visible += cw;
    i += sz;
  }
  return sawAnsi ? out + ellipsis + '\x1b[0m' : out + ellipsis;
}

test('visualWidth and truncateAnsi match reference across full codepoint range, CJK, emoji, ANSI and edge widths', () => {
  for (let cp = 0; cp <= 0x3ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const s = String.fromCodePoint(cp);
    assert.equal(visualWidth(s), refCodePointWidth(cp), `cp 0x${cp.toString(16)}`);
  }
  // Lone surrogates and control/ESC edge cases.
  for (const weird of ['\ud800', '\udfff', '\x1b', '\x1bX', '\x1b[31unterminated', '\x00\x07\x1b[32mok\x1b[0m']) {
    let expectedW = 0;
    for (let i = 0; i < weird.length; ) {
      if (weird[i] === '\x1b' && weird[i + 1] === '[') {
        const end = weird.indexOf('m', i + 2);
        if (end === -1) break;
        i = end + 1;
        continue;
      }
      const cp = weird.codePointAt(i) ?? 0;
      expectedW += refCodePointWidth(cp);
      i += cp > 0xffff ? 2 : 1;
    }
    assert.equal(visualWidth(weird), expectedW, JSON.stringify(weird));
  }
  const cases = [
    'plain ascii statusline 0123456789',
    '\x1b[38;2;166;227;161m✓\x1b[0m \x1b[33m中文标题\x1b[0m + ⚡🎉 e\u0301',
    '\x1b[31mhello\x1b[0m\x1b[32m世界\x1b[0m',
    'a\u200bb\ufe0fc\u0301中文🚀end',
    '\x1b[31munterminated',
    '\x1bnot-csi',
  ];
  for (const s of cases) {
    for (const width of [-1, 0, 1, 2, 3, 4.5, 5, 8, 10.5, 16, 40]) {
      for (const ellipsis of ['…', '', ' ', '中']) {
        assert.equal(truncateAnsi(s, width, ellipsis), refTruncateAnsi(s, width, ellipsis), `${JSON.stringify(s)} @ ${width}`);
      }
    }
  }
});

test('monitor-text keeps Intl.Segmenter lazy on import and ASCII flowLines, constructing once for CJK', async (t) => {
  const OrigSegmenter = Intl.Segmenter;
  let constructed = 0;
  Intl.Segmenter = class SpySegmenter extends OrigSegmenter {
    constructor(...args) {
      constructed++;
      super(...args);
    }
  };
  t.after(() => {
    Intl.Segmenter = OrigSegmenter;
  });
  const mod = await import(`../../dist/render/monitor-text.js?lazy=${Date.now()}`);
  assert.equal(constructed, 0, 'module import must not instantiate Intl.Segmenter');
  assert.deepEqual(mod.flowLines('plain ascii prose that wraps across lines', 18), [
    'plain ascii prose',
    'that wraps across',
    'lines',
  ]);
  assert.equal(constructed, 0, 'ASCII-only flowLines must not instantiate Intl.Segmenter');
  const zh = mod.flowLines('中文换行测试，需要正确断行。', 10);
  assert.equal(constructed, 1, 'non-ASCII flowLines instantiates Intl.Segmenter lazily once');
  assert.deepEqual(mod.flowLines('中文换行测试，需要正确断行。', 10), zh);
  assert.equal(constructed, 1, 'subsequent CJK calls reuse the cached segmenter');
});

test('thin-jobs skips exportFacts and display/thin-jobs.json reads when unchanged, and refreshes on job or cache changes', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'thin-skip-'));
  t.after(() => {
    clearJobIndexCaches();
    fs.rmSync(home, { recursive: true, force: true });
  });
  clearJobIndexCaches();
  const scope = { project: null, pane: 'w4E:p1' };
  const id = 'j0000000000000001';
  const dir = join(home, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job: id, role: 'imp', herdr_pane: scope.pane, created_at: new Date(NOW).toISOString() }));
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working', started_at: new Date(NOW).toISOString() }));

  let exportsCount = 0;
  const origExport = JobIndexCache.prototype.exportFacts;
  JobIndexCache.prototype.exportFacts = function (...args) {
    exportsCount++;
    return origExport.apply(this, args);
  };
  t.after(() => {
    JobIndexCache.prototype.exportFacts = origExport;
  });

  // First call exports and persists.
  assert.equal(readThinJobs(home, scope).length, 1);
  assert.equal(exportsCount, 1);

  // Unchanged second call skips exportFacts and does not open display/thin-jobs.json.
  const cacheFile = join(home, 'display/thin-jobs.json');
  const opens = [];
  const origOpen = fs.openSync;
  fs.openSync = (file, ...args) => {
    if (String(file) === cacheFile) opens.push(String(file));
    return origOpen(file, ...args);
  };
  syncBuiltinESMExports();
  try {
    assert.equal(readThinJobs(home, scope).length, 1);
  } finally {
    fs.openSync = origOpen;
    syncBuiltinESMExports();
  }
  assert.equal(exportsCount, 1, 'unchanged scan skips exportFacts');
  assert.deepEqual(opens, [], 'unchanged scan skips reading display/thin-jobs.json');

  // Changing STATUS.json triggers exportFacts and updates cache.
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'done', settled_at: new Date(NOW + 1000).toISOString() }));
  assert.equal(readThinJobs(home, scope)[0].workers[0].state, 'done');
  assert.equal(exportsCount, 2);

  // Removing display/thin-jobs.json externally causes the next scan to recreate it.
  fs.unlinkSync(cacheFile);
  assert.equal(readThinJobs(home, scope).length, 1);
  assert.equal(exportsCount, 3);
  assert.equal(fs.existsSync(cacheFile), true);

  // Cold start restoring a current display/thin-jobs.json with unchanged jobs skips exportFacts too.
  clearJobIndexCaches();
  const cold = await import(`../../dist/collectors/thin-jobs.js?skip-cold=${Date.now()}`);
  assert.equal(cold.readThinJobs(home, scope).length, 1);
  assert.equal(exportsCount, 3, 'cold restore with unchanged facts skips exportFacts');
});

test('ProjectCollector.collect memoizes Home and Overview on .scratch, ledger, tries, git, job and board stamps', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'proj-memo-'));
  t.after(() => {
    clearJobIndexCaches();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cwd = join(root, 'project'), hud = join(root, 'hud'), home = join(root, 'home');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(hud, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const put = (p, c) => {
    fs.mkdirSync(join(p, '..'), { recursive: true });
    fs.writeFileSync(p, typeof c === 'string' ? c : JSON.stringify(c));
  };
  const git = (args) =>
    execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@invalid', ...args], {
      cwd, stdio: 'pipe', encoding: 'utf8',
    }).trim();
  git(['init', '-b', 'main']);
  put(join(cwd, 'a.txt'), 'v1\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);

  const ticketFile = join(cwd, '.scratch/demo/issues/01-item.md');
  const claimedFile = join(cwd, '.scratch/demo/issues/02-claim.md');
  const stateFile = join(cwd, 'docs/handoff/STATE.md');
  const jobDir = join(hud, 'jobs/j0000000000000001');
  put(ticketFile, '# 01: First ticket\n**Status:** ready-for-agent\n**Blocked by:** none\n');
  put(claimedFile, '# 02: Claimed ticket\n**Status:** claimed\n**Blocked by:** none\n');
  fs.utimesSync(claimedFile, new Date(NOW - 1000), new Date(NOW - 1000));
  put(stateFile, '# State\nMilestone: M4\n');
  put(join(jobDir, 'job.json'), { job: 'j0000000000000001', role: 'imp', cwd, created_at: new Date(NOW).toISOString() });
  put(join(jobDir, 'STATUS.json'), { state: 'working', started_at: new Date(NOW).toISOString() });

  const env = { HOME: home, HUD_HOME: hud, PATH: process.env.PATH ?? '' };
  const collector = new ProjectCollector(cwd, hud, env, home);
  const board = { ...EMPTY_BOARD, workers: [{ id: 'thin-job:j0000000000000001', laneId: 'l1', task: 'Initial task', evidence: [{ sourceId: 'j0000000000000001' }] }] };

  const first = await collector.collect('home', board, NOW);
  assert.equal(first.tickets[0].tickets[0].state, 'ready');
  assert.equal(first.tickets[0].tickets[1].state, 'working');
  assert.equal(first.active[0].title, 'Initial task');

  // Unchanged second tick returns memoized snapshot with zero openSync / opendirSync calls.
  let opens = 0, opendirs = 0;
  const origOpen = fs.openSync, origOpendir = fs.opendirSync;
  fs.openSync = (...args) => { opens++; return origOpen(...args); };
  fs.opendirSync = (...args) => { opendirs++; return origOpendir(...args); };
  syncBuiltinESMExports();
  try {
    const second = await collector.collect('home', board, NOW + 1000);
    assert.strictEqual(second, first, 'unchanged tick returns memoized snapshot');
  } finally {
    fs.openSync = origOpen;
    fs.opendirSync = origOpendir;
    syncBuiltinESMExports();
  }
  assert.equal(opens, 0);
  assert.equal(opendirs, 0);

  // Overview also memoizes and returns identical reference when unchanged.
  const ov1 = await collector.collect('overview', EMPTY_BOARD, NOW + 1000);
  const ov2 = await collector.collect('overview', EMPTY_BOARD, NOW + 2000);
  assert.strictEqual(ov2, ov1);

  // In-place ticket edit invalidates memo.
  put(ticketFile, '# 01: First ticket\n**Status:** try\n**Blocked by:** none\n');
  const afterTicket = await collector.collect('home', board, NOW + 2000);
  assert.notStrictEqual(afterTicket, first);
  assert.equal(afterTicket.tickets[0].tickets[0].state, 'try');

  // In-place STATE.md edit invalidates memo.
  put(stateFile, '# State\nMilestone: M4\n## Waiting for the owner\n- Check new item\n');
  const afterState = await collector.collect('home', board, NOW + 3000);
  assert.equal(afterState.waiting.length, 1);

  // TryLog append invalidates memo.
  appendTry(hud, cwd, 'accept', { milestone: 'demo', slices: [{ id: 'DEMO-01', text: 'First ticket' }] });
  const afterTry = await collector.collect('home', board, NOW + 4000);
  assert.equal(afterTry.counts.accepted, 1);

  // In-place STATUS.json update invalidates memo.
  put(join(jobDir, 'STATUS.json'), { state: 'done', settled_at: new Date(NOW + 4500).toISOString() });
  const afterJob = await collector.collect('home', board, NOW + 5000);
  assert.deepEqual(afterJob.active, []);

  // In-place board.workers mutation invalidates memo.
  put(join(jobDir, 'STATUS.json'), { state: 'working', started_at: new Date(NOW).toISOString() });
  const beforeBoardMut = await collector.collect('home', board, NOW + 6000);
  assert.equal(beforeBoardMut.active[0].title, 'Initial task');
  board.workers[0].task = 'Mutated task';
  const afterBoardMut = await collector.collect('home', board, NOW + 7000);
  assert.equal(afterBoardMut.active[0].title, 'Mutated task');

  // Advancing `now` past claimed ticket's 2-hour expiry invalidates memo even with zero file changes.
  const expired = await collector.collect('home', board, NOW + 7200000);
  assert.equal(expired.tickets[0].tickets[1].state, 'blocked');
});
