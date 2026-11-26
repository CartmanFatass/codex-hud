/** Project overview and diagnostic navigation in English and Chinese. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripAnsi } from '../../dist/render/colors.js';
import { tryCount } from '../../dist/render/project-view.js';
import { loadSettings } from '../../dist/settings.js';
import { SETTING_ROWS } from '../../dist/render/settings-page.js';
import { panelProjectFixture, panelState, layoutDriver, assertWidth, assertNoMidWordCut } from '../fixtures/panel-project.mjs';
import { listFixture } from '../fixtures/project-list.mjs';
import { onPage, plain } from '../fixtures/project-page.mjs';

let sharedRoot, busy, lists;
before(async () => {
  sharedRoot = fs.mkdtempSync(join(tmpdir(), 'project-inbox-'));
  [busy, lists] = await Promise.all([panelProjectFixture(join(sharedRoot, 'busy')), listFixture(join(sharedRoot, 'lists'))]);
});
after(() => fs.rmSync(sharedRoot, { recursive: true, force: true }));
async function fixture() { return { root: sharedRoot, busy, lists }; }
const driver = (f, opts = {}) => layoutDriver(f, { height: 38, ...opts });

test('Project uses its overview for old saved layouts and no longer offers a layout setting', () => {
  const path = join(sharedRoot, 'hud-settings.json');
  const env = { ...process.env, HUD_SETTINGS_PATH: path };
  assert.ok(!SETTING_ROWS.some((row) => row.key === 'projectLayout'));
  for (const panelLayout of ['classic', 'split']) for (const projectLayout of ['timeline', 'board', 'inbox']) {
    const saved = JSON.stringify({ panelLayout, acceptance: 'slice', projectLayout });
    fs.writeFileSync(path, saved);
    const settings = loadSettings(env);
    assert.equal('panelLayout' in settings, false);
    assert.ok(!Object.hasOwn(settings, 'projectLayout'));
    assert.equal(fs.readFileSync(path, 'utf8'), saved, 'loading does not rewrite owner settings');
    const frame = busy.render(40, 'en', 36, onPage());
    assert.match(plain(frame).join('\n'), /^Needs you ─/m);
    assert.equal(frame.panes.some((pane) => pane.id === 'preview'), false);
  }
});

test('Project overview at 40 cols: explicit needs and links, with Accept all only in ticket diagnostics', async (t) => {
  const { busy } = await fixture(t), data = busy.control, tries = tryCount(data);
  for (const lang of ['en', 'zh']) {
    for (const layout of ['split', 'classic']) {
      const state = onPage(undefined, { prefs: { panelLayout: layout } });
      const d = driver(busy, { data, state, height: 42, lang });
      const frame = d.frame;
      assertWidth(frame, 40, `hub ${layout} ${lang}`);
      const lines = plain(frame), text = lines.join('\n');
      const corpus = [data.summary, ...data.waiting.map((w) => w.value), ...data.active.map((j) => j.title ?? ''),
        ...data.ledger.map((r) => r.text), ...data.tickets.flatMap((f) => f.tickets.map((tk) => tk.title))].join(' ');
      assertNoMidWordCut(lines, corpus, `hub ${layout} ${lang}`);
      assert.match(text, new RegExp(`^${lang === 'zh' ? '需要你处理' : 'Needs you'} ─+ ${data.waiting.length}$`, 'm'));
      assert.doesNotMatch(text, /Accept all|全部验收|\d+\/\d+ (?:accepted|已验收)/);
      assert.match(text, /Try the Project tab/);
      assert.doesNotMatch(text, /DATA-ONE|WATCH-LINK|How to try|Space mark|PAGE-TWO|pi out|已耗尽|Running|运行中|last accepted|最近验收/);
      assert.ok(frame.workboard.rows.every((r) => !r.item?.startsWith('inbox:')));
      if (lang === 'zh') assert.doesNotMatch(text, /\b(Needs you|Running|last accepted|to try|blocked|working|Control plane|Working tree|pi out)\b/);
      const tickets = onPage('tickets', { prefs: { panelLayout: layout } });
      const td = driver(busy, { data, state: tickets, height: 42, lang });
      assert.match(td.lines().join('\n'), new RegExp(`^${lang === 'zh' ? '全部验收' : 'Accept all'} +${tries} ${lang === 'zh' ? '待试用' : 'to try'}$`, 'm'));
      const click = () => {
        const pane = td.frame.panes.find(p => p.id === 'agents');
        const y = pane.y + pane.rows.findIndex(r => r.item === 'project:accept-all') - pane.offset;
        return td.run({ type: 'mouse', button: 'left', x: 4, y }).action;
      };
      assert.equal(click(), undefined, 'first click only selects');
      assert.equal(td.state.project.nav.cursor, 'project:accept-all');
      assert.deepEqual(click(), { type: 'accept-all' });
      const partial = busy.render(40, lang, 42, tickets, { ...data, ticketTotals: { ...data.ticketTotals, partial: true } });
      const action = partial.workboard.rows.find(r => r.item === 'project:accept-all');
      assert.match(stripAnsi(action.text), lang === 'zh' ? /^全部验收 +不完整 · / : /^Accept all +Partial · /);
    }
  }

});

test('Project overview expands remaining explicit requests', async () => {
  const { busy } = await fixture();
  const waiting = Array.from({ length: 8 }, (_, i) => ({ label: '', value: `Explicit request ${i + 1}` }));
  const d = driver(busy, { data: { ...busy.control, waiting },
    state: panelState({ activeTab: 'project', project: { nav: { cursor: 'project:fold:waiting:more' } } }) });
  assert.match(d.lines().join('\n'), /▸ 1 more/);
  assert.doesNotMatch(d.lines().join('\n'), /Explicit request 8/);
  d.run('enter');
  assert.match(d.lines().join('\n'), /Explicit request 8/);
});

test('Projects list at 40/80/120 cols EN and ZH: Needs you / Running / Quiet groups, quiet is one row, exact width', async (t) => {
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
    assert.match(quietRows[0], lang === 'zh' ? /bare-project\s+2天/ : /bare-project\s+2d/);
    assert.match(quietRows[1], lang === 'zh' ? /quiet-project\s+0\.2\s+3天/ : /quiet-project\s+0\.2\s+3d/);
    assert.match(quietRows[2], lang === 'zh' ? /old-project\s+M1\s+40天/ : /old-project\s+M1\s+40d/);
    // Counts come from the project overview.
    assert.match(text, lang === 'zh' ? /demo-project\s+M3b\s+2 待处理/ : /demo-project\s+M3b\s+2 waiting/);
    assert.doesNotMatch(text, /\d+ to try|\d+ 待试用/);
    assert.match(text, lang === 'zh' ? /2 运行中/ : /2 running/);
    if (lang === 'zh') {
      const uiLines = lines.filter((l) => !/^\s*[a-z]+-project/.test(l)).join('\n');
      assert.doesNotMatch(uiLines, /\b(Needs you|Running|Quiet|waiting|to try|running|no STATE\.md)\b/);
    }
  }
});
