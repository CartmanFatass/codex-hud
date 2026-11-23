/** Project Inbox in Classic and Split, in English and Chinese. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripAnsi } from '../../dist/render/colors.js';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { sonicChildrenRunning } from '../../dist/render/worker-roster.js';
import { tryCount } from '../../dist/render/project-view.js';
import { loadSettings } from '../../dist/settings.js';
import { viewPrefs } from '../../dist/render/monitor-state.js';
import { SETTING_ROWS } from '../../dist/render/settings-page.js';
import { splitFixture, split, layoutDriver, assertWidth, assertNoMidWordCut } from '../fixtures/split-layout.mjs';
import { listFixture } from '../fixtures/project-list.mjs';
import { NOW, onPage, plain, projectFixture } from '../fixtures/project-page.mjs';

let sharedRoot, busy, lists;
before(async () => {
  sharedRoot = fs.mkdtempSync(join(tmpdir(), 'project-inbox-'));
  [busy, lists] = await Promise.all([splitFixture(join(sharedRoot, 'busy')), listFixture(join(sharedRoot, 'lists'))]);
});
after(() => fs.rmSync(sharedRoot, { recursive: true, force: true }));
async function fixture() { return { root: sharedRoot, busy, lists }; }
const driver = (f, opts = {}) => layoutDriver(f, { height: 38, ...opts });

test('Project uses Inbox for old saved layouts and no longer offers a layout setting', () => {
  const path = join(sharedRoot, 'hud-settings.json');
  const env = { ...process.env, HUD_SETTINGS_PATH: path };
  assert.ok(!SETTING_ROWS.some((row) => row.key === 'projectLayout'));
  for (const panelLayout of ['classic', 'split']) for (const projectLayout of ['timeline', 'board', 'inbox']) {
    const saved = JSON.stringify({ panelLayout, acceptance: 'slice', projectLayout });
    fs.writeFileSync(path, saved);
    const settings = loadSettings(env);
    assert.equal(settings.panelLayout, panelLayout);
    assert.ok(!Object.hasOwn(settings, 'projectLayout'));
    assert.equal(fs.readFileSync(path, 'utf8'), saved, 'loading does not rewrite owner settings');
    const frame = busy.render(40, 'en', 36, onPage(undefined, { prefs: viewPrefs(settings) }));
    assert.match(plain(frame).join('\n'), /^Needs you ─/m);
    assert.equal(frame.panes.some((pane) => pane.id === 'preview'), panelLayout === 'split');
  }
});

test('Inbox hub at 40 cols EN and ZH (Split and Classic): width, ranked Needs you, Running, last accepted and one Accept all action', async (t) => {
  const { busy } = await fixture(t), data = busy.control, tries = tryCount(data);
  for (const lang of ['en', 'zh']) {
    for (const layout of ['split', 'classic']) {
      const state = onPage(undefined, { project: { folded: new Set(['inbox:more']) }, prefs: { panelLayout: layout } });
      const d = driver(busy, { data, state, height: 42, lang });
      const frame = d.frame;
      assertWidth(frame, 40, `hub ${layout} ${lang}`);
      const lines = plain(frame), text = lines.join('\n');
      const corpus = [data.summary, ...data.waiting.map((w) => w.value), ...data.active.map((j) => j.title ?? ''),
        ...data.ledger.map((r) => r.text), ...data.tickets.flatMap((f) => f.tickets.map((tk) => tk.title))].join(' ');
      assertNoMidWordCut(lines, corpus, `hub ${layout} ${lang}`);
      assert.match(text, new RegExp(`^${lang === 'zh' ? '需要你处理' : 'Needs you'} ─+ ${data.waiting.length}$`, 'm'));
      assert.match(text, new RegExp(`^${lang === 'zh' ? '全部验收' : 'Accept all'} +${tries} ${lang === 'zh' ? '待试用' : 'to try'}$`, 'm'));
      const order = ['Try the Project tab', 'Vocabulary', 'PAGE-TWO', 'imp'].map((s) => text.indexOf(s));
      assert.ok(order.every((i) => i >= 0) && order.every((v, i) => i === 0 || order[i - 1] < v), `${layout} ${lang}: Needs you ranked order`);
      assert.doesNotMatch(text, /DATA-ONE|WATCH-LINK|How to try|Space mark/);
      assert.match(text, lang === 'zh' ? /运行中/ : /Running/);
      assert.match(text, lang === 'zh' ? /✓ 最近验收 REVIEW-ONE 8天/ : /✓ last accepted REVIEW-ONE 8d/);
      assert.match(text, lang === 'zh' ? /pi 已耗尽 42分/ : /pi out 42m/);
      if (lang === 'zh') assert.doesNotMatch(text, /\b(Needs you|Running|last accepted|to try|blocked|working|Control plane|Working tree|pi out)\b/);
      const click = () => {
        const pane = d.frame.panes.find(p => p.id === 'agents');
        const y = pane.y + pane.rows.findIndex(r => r.item === 'project:accept-all') - pane.offset;
        return d.run({ type: 'mouse', button: 'left', x: 4, y }).action;
      };
      assert.equal(click(), undefined, 'first click only selects');
      assert.equal(d.state.project.nav.cursor, 'project:accept-all');
      assert.deepEqual(click(), { type: 'accept-all' });
      const partial = busy.render(40, lang, 42, state, { ...data, stateTruncated: true });
      const action = partial.workboard.rows.find(r => r.item === 'project:accept-all');
      assert.match(stripAnsi(action.text), lang === 'zh' ? /^全部验收 +不完整 · / : /^Accept all +Partial · /);
    }
  }

  // Asking jobs rank ahead of STATE's waiting items and are not duplicated in Running.
  const askingSnap = {
    ...data,
    active: [...data.active, { jobId: 'j00000000000000bb', role: 'reviewer', state: 'waiting_orchestrator', title: 'Approve synthetic migration', at: NOW - 3 * 60000, asking: true }],
  };
  for (const lang of ['en', 'zh']) {
    const askFrame = busy.render(40, lang, 36, split({ activeTab: 'project' }), askingSnap);
    assertWidth(askFrame, 40, `hub asking ${lang}`);
    const listLines = askFrame.panes.find((p) => p.id === 'agents').rows.map((r) => stripAnsi(r.text).trimEnd()).join('\n');
    const askPos = listLines.indexOf('Approve synthetic');
    const waitPos = listLines.indexOf('Try the Project tab');
    assert.ok(askPos >= 0 && waitPos > askPos, `${lang}: asking job ranks ahead of STATE waiting items`);
    assert.match(listLines, lang === 'zh' ? /提问中/ : /asking/);
    assert.equal(listLines.split('Approve synthetic').length, 2, `${lang}: asking job not duplicated in Running`);
  }

  const capped = driver(busy, { data, height: 38, state: split({ activeTab: 'project', project: { nav: { cursor: 'project:fold:inbox:more' } } }) });
  assert.match(capped.lines().join('\n'), /▸ 1 more/);
  capped.run('enter');
  assert.match(capped.lines().join('\n'), /PAGE-TWO\s+blocked/);
  assert.match(capped.lines().join('\n'), /imp\s+pi out 42m/);
});

test('Inbox Running is one row per running job: an imp in a worktree with two sonic children is one row (role, ticket title, ⚡2, age), never a worktree, slice or sonic row', async () => {
  const f = await projectFixture(join(sharedRoot, 'running')), iso = (m) => new Date(NOW - m * 60000).toISOString();
  // The base fixture's imp works in the NATIVE-TREE worktree: give it a ticket and no open question, then run two sonic children in that tree.
  f.put(join(f.cwd, '.scratch/native-tree/issues/02-home-lanes.md'), '# 02: Home lanes, one per session\n\n**Status:** claimed\n');
  f.put(join(f.sliceJob, 'job.json'), { job: 'j0000000000000002', role: 'imp', cwd: f.linked[0], herdr_pane: 'w4E:p1', ticket: 'native-tree/02', created_at: iso(12),
    worktree: { root: f.linked[0], branch: 'wt/NATIVE-TREE', main_root: f.cwd } });
  fs.rmSync(join(f.sliceJob, 'qa'), { recursive: true, force: true });
  for (const n of [3, 4]) {
    const id = `j000000000000000${n}`;
    f.put(join(f.hud, 'jobs', id, 'job.json'), { job: id, role: 'sonic', cwd: f.linked[0], herdr_pane: 'w4E:p1', parent_job: 'j0000000000000002', created_at: iso(2) });
    f.put(join(f.hud, 'jobs', id, 'STATUS.json'), { state: 'working', started_at: iso(2) });
  }
  const lanes = readThinJobs(f.hud, { project: f.cwd, pane: 'w4E:p1' }), board = { ...f.board, lanes, workers: lanes.flatMap((l) => l.workers) };
  const data = await new ProjectCollector(f.cwd, f.hud, f.env, f.home).collect(true, board, NOW);
  // A sonic never labels its parent's worktree.
  assert.deepEqual(['jobId', 'role'].map((k) => data.slices.find((x) => x.label === 'NATIVE-TREE')[k]), ['j0000000000000002', 'imp']);
  assert.equal(sonicChildrenRunning(board.workers, board.workers.find((w) => w.evidence[0].sourceId === 'j0000000000000002').id), 2, 'Home folds the same two');
  const running = (lines, header) => { const at = lines.findIndex((l) => header.test(l)); return lines.slice(at, lines.findIndex((l, i) => i > at && l === '')); };
  const age = { en: ['12m', '20m'], zh: ['12分', '20分'] };
  for (const lang of ['en', 'zh']) {
    const header = lang === 'zh' ? /^运行中/ : /^Running/;
    const frames = [f.render(60, lang, onPage(), 40, data, true, 'unicode', 'none', { workboard: board }),
      f.render(60, lang, split({ activeTab: 'project', project: { nav: { cursor: 'project:job:j0000000000000002' } } }), 40, data, true, 'unicode', 'none', { workboard: board })];
    for (const frame of frames) {
      assertWidth(frame, 60, `running ${lang}`);
      const [head, ...below] = running(plain(frame), header), rows = below.filter((l) => !/last accepted|最近验收/.test(l));
      assert.match(head, / 2$/, `${lang}: two jobs, not one row per slice, worktree and sonic`);
      assert.equal(rows.length, 2);
      assert.match(rows[0], new RegExp(`^  ◉ imp  Home lanes, one per session\\s+⚡2 ${age[lang][0]}$`));
      assert.match(rows[1], new RegExp(`^  ◉ imp  Build the Project tab\\s+${age[lang][1]}$`));
      assert.doesNotMatch(rows.join('\n'), /sonic|NATIVE-TREE|ORPHAN/);
    }
    assert.match(plain(frames[1]).join('\n'), /^imp ─+\n  NATIVE-TREE: synthetic subagents$/m, `${lang}: Enter's preview is the job's`);
  }
});

test('Inbox Projects list at 40/80/120 cols EN and ZH: Needs you / Running / Quiet groups, quiet is one row, exact width', async (t) => {
  const { lists } = await fixture(t);
  for (const width of [40, 80, 120]) for (const lang of ['en', 'zh']) for (const icons of ['unicode', 'text']) {
    const frame = lists.list(width, lang, undefined, 22, icons);
    assertWidth(frame, width, `list ${width} ${lang} ${icons}`);
    const lines = plain(frame), text = lines.join('\n');
    const heads = (lang === 'zh' ? ['需要你处理', '运行中', '安静'] : ['Needs you', 'Running', 'Quiet']).map((h) => text.indexOf(h));
    assert.ok(heads.every((i) => i >= 0) && heads[0] < heads[1] && heads[1] < heads[2], `${width} ${lang}: group order`);
    // Quiet projects are one row each (bare-project, quiet-project, old-project).
    const quietStart = lines.findIndex((l) => l.startsWith(lang === 'zh' ? '安静' : 'Quiet'));
    const quietRows = lines.slice(quietStart + 1, quietStart + 4);
    assert.match(quietRows[0], lang === 'zh' ? /bare-project\s+无 STATE\.md\s+2天/ : /bare-project\s+no STATE\.md\s+2d/);
    assert.match(quietRows[1], lang === 'zh' ? /quiet-project\s+0\.2\s+3天/ : /quiet-project\s+0\.2\s+3d/);
    assert.match(quietRows[2], lang === 'zh' ? /old-project\s+M1\s+40天/ : /old-project\s+M1\s+40d/);
    // Counts come from the project overview.
    assert.match(text, lang === 'zh' ? /demo-project\s+M3b\s+2 待处理/ : /demo-project\s+M3b\s+2 waiting/);
    assert.match(text, lang === 'zh' ? /1 待试用 · 1 运行中/ : /1 to try · 1 running/);
    assert.match(text, lang === 'zh' ? /2 运行中/ : /2 running/);
    if (lang === 'zh') {
      const uiLines = lines.filter((l) => !/^\s*[a-z]+-project/.test(l)).join('\n');
      assert.doesNotMatch(uiLines, /\b(Needs you|Running|Quiet|waiting|to try|running|no STATE\.md)\b/);
    }
  }
});
