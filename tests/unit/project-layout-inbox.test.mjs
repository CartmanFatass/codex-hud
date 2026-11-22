import { withState, sliceState } from '../fixtures/state-helpers.mjs';
/** PROJECT-LAYOUTS 02: the Inbox project layout (Split and Classic, EN and ZH at 40 columns). */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripAnsi } from '../../dist/render/colors.js';
import { tryCount } from '../../dist/render/project-view.js';
import { splitFixture, split, layoutDriver, assertWidth, assertNoMidWordCut } from '../fixtures/split-layout.mjs';
import { listFixture } from '../fixtures/project-list.mjs';
import { NOW, onPage, plain } from '../fixtures/project-page.mjs';

let sharedRoot, busy, lists;
before(async () => {
  sharedRoot = fs.mkdtempSync(join(tmpdir(), 'project-inbox-'));
  [busy, lists] = await Promise.all([splitFixture(join(sharedRoot, 'busy')), listFixture(join(sharedRoot, 'lists'))]);
});
after(() => fs.rmSync(sharedRoot, { recursive: true, force: true }));
async function fixture() { return { root: sharedRoot, busy, lists }; }
const driver = (f, opts = {}) => layoutDriver(f, { height: 38, ...opts });

test('Inbox leaves Home, Control plane and Tickets identical to Timeline in both Split and Classic', async (t) => {
  const { busy } = await fixture(t);
  const control = { ...busy.control, radar: undefined };
  for (const panelLayout of ['classic', 'split']) {
    const base = (extra) => (withState(sliceState(), { project: { folded: new Set(['agents', 'healthy', 'files']) }, prefs: { panelLayout } }, extra));
    for (const [label, extra, snap] of [
      ['Home', { activeTab: 'home' }, busy.data],
      ['Tickets', { activeTab: 'project', project: { view: { kind: 'tickets' } } }, busy.data],
      ['Control plane', { activeTab: 'control' }, control],
    ]) {
      assert.deepEqual(
        plain(busy.render(40, 'en', 36, base(withState(extra, { prefs: { projectLayout: 'inbox' } })), snap)),
        plain(busy.render(40, 'en', 36, base(withState(extra, { prefs: { projectLayout: 'timeline' } })), snap)),
        `${panelLayout}: ${label} unchanged`,
      );
    }
  }
});

test('Inbox hub at 40 cols EN and ZH (Split and Classic): exact width, no mid-word cut, counts equal Timeline, ranked Needs you, Running, last accepted, Space/y/n', async (t) => {
  const { busy } = await fixture(t);
  const briefed = {
    ...busy.control,
    ledger: busy.control.ledger.map((r) => (r.id === 'DATA-ONE'
      ? { ...r, brief: { brief: 'Inbox layout ranks what needs you first. Older slices fold cleanly.', steps: ['Open Project tab', 'Check Needs you'] } }
      : r)),
  };
  const tries = tryCount(briefed, 'slice');
  for (const lang of ['en', 'zh']) {
    for (const layout of ['split', 'classic']) {
      const state = layout === 'split'
        ? split({ activeTab: 'project', project: { folded: new Set(['agents', 'healthy', 'files', 'inbox:more']) }, prefs: { projectLayout: 'inbox' } })
        : onPage(undefined, { project: { folded: new Set(['agents', 'healthy', 'files', 'inbox:more']) }, prefs: { projectLayout: 'inbox' } });
      const timelineState = layout === 'split' ? split({ activeTab: 'project', prefs: { projectLayout: 'timeline' } }) : onPage(undefined, { prefs: { projectLayout: 'timeline' } });
      const frame = busy.render(40, lang, 42, state, briefed);
      const timeline = busy.render(40, lang, 42, timelineState, briefed);
      assertWidth(frame, 40, `hub ${layout} ${lang}`);
      const lines = plain(frame), text = lines.join('\n'), tText = plain(timeline).join('\n');
      const corpus = [
        briefed.summary, ...briefed.waiting.map((w) => w.value), ...briefed.active.map((j) => j.title ?? ''),
        ...briefed.ledger.map((r) => `${r.text} ${r.brief?.brief ?? ''}`), ...briefed.tickets.flatMap((f) => f.tickets.map((tk) => tk.title)),
      ].join(' ');
      assertNoMidWordCut(lines, corpus, `hub ${layout} ${lang}`);
      // Spec rule 1: tab badge ?N and Needs-you N · M to try match Timeline identically (never adding blocked/tickets/roles into a new total).
      assert.equal(lines[0], plain(timeline)[0], `${layout} ${lang}: tab row identical`);
      const figures = lang === 'zh' ? `${briefed.waiting.length} · ${tries} 待试用` : `${briefed.waiting.length} · ${tries} to try`;
      assert.ok(tText.includes(figures) && text.includes(figures), `${layout} ${lang}: header figures match Timeline (${figures})`);
      // Ranked order in Needs you: waiting -> to-try newest first -> asking tickets -> blocked -> exhausted roles.
      const order = ['Try the Project tab', 'DATA-ONE', 'WATCH-LINK', 'Vocabulary', 'PAGE-TWO', 'imp'].map((s) => text.indexOf(s));
      assert.ok(order.every((i) => i >= 0) && order.every((v, i) => i === 0 || order[i - 1] < v), `${layout} ${lang}: Needs you ranked order`);
      // Brief's first sentence on DATA-ONE; Running and last accepted present; blocked slice not duplicated in Running.
      assert.match(text, /Inbox layout ranks what needs you\s+first\./);
      assert.match(text, lang === 'zh' ? /运行中/ : /Running/);
      assert.match(text, lang === 'zh' ? /✓ 最近验收 REVIEW-ONE 8天/ : /✓ last accepted REVIEW-ONE 8d/);
      assert.match(text, lang === 'zh' ? /pi 已耗尽 42分/ : /pi out 42m/);
      if (lang === 'zh') assert.doesNotMatch(text, /\b(Needs you|Running|last accepted|to try|blocked|working|Control plane|Working tree|pi out)\b/);
    }
  }

  // Asking jobs rank ahead of STATE's waiting items and are not duplicated in Running.
  const askingSnap = {
    ...briefed,
    active: [...briefed.active, { jobId: 'j00000000000000bb', role: 'reviewer', state: 'waiting_orchestrator', title: 'Approve synthetic migration', at: NOW - 3 * 60000, asking: true }],
  };
  for (const lang of ['en', 'zh']) {
    const askFrame = busy.render(40, lang, 36, split({ activeTab: 'project', prefs: { projectLayout: 'inbox' } }), askingSnap);
    assertWidth(askFrame, 40, `hub asking ${lang}`);
    const listLines = askFrame.panes.find((p) => p.id === 'agents').rows.map((r) => stripAnsi(r.text).trimEnd()).join('\n');
    const askPos = listLines.indexOf('Approve synthetic');
    const waitPos = listLines.indexOf('Try the Project tab');
    assert.ok(askPos >= 0 && waitPos > askPos, `${lang}: asking job ranks ahead of STATE waiting items`);
    assert.match(listLines, lang === 'zh' ? /提问中/ : /asking/);
    assert.equal(listLines.split('Approve synthetic').length, 2, `${lang}: asking job not duplicated in Running`);
  }

  // Default cap (7) shows `▸ N more` and Enter unfolds the remaining ranked items.
  const capped = driver(busy, { data: briefed, height: 38, state: split({ activeTab: 'project', project: { nav: { cursor: 'project:fold:inbox:more' } }, prefs: { projectLayout: 'inbox' } }) });
  assert.match(capped.lines().join('\n'), /▸ 6 more/);
  capped.run('enter');
  assert.match(capped.lines().join('\n'), /PAGE-TWO\s+blocked/);
  assert.match(capped.lines().join('\n'), /imp\s+pi out 42m/);

  // Split hub: Space/y/n act directly on Inbox Needs-you to-try rows; preview shows brief, steps and folded Ledger line.
  const sp = driver(busy, { data: briefed, height: 42, state: split({ activeTab: 'project', project: { nav: { cursor: 'project:slice:DATA-ONE' } }, prefs: { projectLayout: 'inbox' } }) });
  const spText = sp.lines().join('\n');
  assert.match(spText, /How to try/);
  assert.match(spText, /1\. Open Project tab/);
  assert.match(spText, /▸ Ledger line/);
  sp.run('space');
  assert.match(sp.lines().join('\n'), /▣ ◇ DATA-ONE/);
  assert.deepEqual(sp.run('try-accept').action.target.slices.map((s) => s.id), ['DATA-ONE']);
  assert.equal(sp.run({ type: 'key', key: 'try-flag', text: 'n' }).action.action, 'flag');

  // Classic hub: Enter expands to-try row with brief + steps + folded Ledger line; Space/y/n act directly.
  const cl = driver(busy, { data: briefed, height: 44, state: onPage(undefined, { project: { nav: { cursor: 'project:fold:hist:DATA-ONE' } }, prefs: { projectLayout: 'inbox' } }) });
  cl.run('enter');
  assert.match(cl.lines().join('\n'), /How to try/);
  assert.match(cl.lines().join('\n'), /▸ Ledger line/);
  cl.run('space');
  assert.deepEqual(cl.run('try-accept').action.target.slices.map((s) => s.id), ['DATA-ONE']);
  assert.equal(cl.run({ type: 'key', key: 'try-flag', text: 'n' }).action.action, 'flag');
});

test('Inbox Progress at 40 cols EN and ZH (Split and Classic): To try newest first across milestones, Blocked, Working, Next, Done folded to one row, Space/y/n', async (t) => {
  const { busy } = await fixture(t);
  const briefed = {
    ...busy.rich,
    ledger: busy.rich.ledger.map((r) => (r.id === 'DATA-ONE'
      ? { ...r, brief: { brief: 'Inbox progress groups by owner priority. Accepted slices fold away.', steps: ['Open Progress', 'Try Space, y and n'] } }
      : r)),
  };
  const tries = tryCount(briefed, 'slice');
  for (const lang of ['en', 'zh']) {
    for (const layout of ['split', 'classic']) {
      const state = layout === 'split' ? split({ activeTab: 'project', prefs: { projectLayout: 'inbox' }, project: { view: { kind: 'progress' } } }) : onPage('progress', { prefs: { projectLayout: 'inbox' } });
      const frame = busy.render(40, lang, 44, state, briefed);
      assertWidth(frame, 40, `progress ${layout} ${lang}`);
      const lines = plain(frame), text = lines.join('\n');
      const corpus = [briefed.summary, ...briefed.active.map((j) => j.title ?? ''), ...briefed.next.map((n) => n.value), ...briefed.ledger.map((r) => `${r.text} ${r.brief?.brief ?? ''}`)].join(' ');
      assertNoMidWordCut(lines, corpus, `progress ${layout} ${lang}`);
      // Section order: To try -> Blocked -> Working -> Next -> Done.
      const heads = (lang === 'zh'
        ? [/^待试用 ─/m, /^受阻 ─/m, /^工作中 ─/m, /^(?:→ )?下一步/m, /^(?:▸ )?已完成/m]
        : [/^To try ─/m, /^Blocked ─/m, /^Working ─/m, /^(?:→ )?Next/m, /^(?:▸ )?Done/m]
      ).map((re) => text.search(re));
      assert.ok(heads.every((i) => i >= 0) && heads.every((v, i) => i === 0 || heads[i - 1] < v), `${layout} ${lang}: section order`);
      // To try lists every milestone newest first (0.1.3 DATA-ONE, M4 WATCH-LINK, M4 SENTENCE-CUT, M3b NATIVE-ROWS, M4 NO-HASH) and header count equals tryCount.
      const tryOrder = ['DATA-ONE', 'WATCH-LINK', 'SENTENCE-CUT', 'NATIVE-ROWS', 'NO-HASH'].map((id) => text.indexOf(id));
      assert.ok(tryOrder.every((i) => i >= 0) && tryOrder.every((v, i) => i === 0 || tryOrder[i - 1] < v), `${layout} ${lang}: to-try newest first across milestones`);
      assert.match(text, new RegExp(`${lang === 'zh' ? '待试用' : 'To try'} ─+ ${tries}`));
      assert.match(text, /Inbox progress groups by owner\s+priority\./);
      // Done is folded (older accepted slice BAR-LINES is hidden until opened/previewed).
      assert.doesNotMatch(text, /BAR-LINES/);
      assert.match(text, /REVIEW-ONE/);
      // No state word repeated twice on any row.
      for (const line of lines) for (const word of ['working', 'blocked', 'to try', '工作中', '受阻', '待试用']) {
        assert.ok(line.split(word).length <= 2, `${layout} ${lang}: duplicate "${word}" in "${line}"`);
      }
      if (lang === 'zh') assert.doesNotMatch(text, /\b(To try|Blocked|Working|Next|Done|latest|accepted|to try|working|blocked)\b/);
    }
  }

  // Split Progress: Space/y/n on to-try row, preview of Done shows accepted slices.
  const sp = driver(busy, { data: briefed, height: 42, state: split({ activeTab: 'project', project: { nav: { cursor: 'project:slice:DATA-ONE' }, view: { kind: 'progress' } }, prefs: { projectLayout: 'inbox' } }) });
  assert.match(sp.lines().join('\n'), /How to try/);
  sp.run('space');
  assert.match(sp.lines().join('\n'), /▣ ◇ DATA-ONE/);
  assert.deepEqual(sp.run('try-accept').action.target.slices.map((s) => s.id), ['DATA-ONE']);
  assert.equal(sp.run({ type: 'key', key: 'try-flag', text: 'n' }).action.action, 'flag');
  const spDone = driver(busy, { data: briefed, height: 42, state: split({ activeTab: 'project', project: { nav: { cursor: 'split:done' }, view: { kind: 'progress' } }, prefs: { projectLayout: 'inbox' } }) });
  assert.match(spDone.lines().join('\n'), /BAR-LINES/);

  // Classic Progress: Space/y/n on to-try row; Enter on Done unfolds accepted slices.
  const cl = driver(busy, { data: briefed, height: 46, state: onPage('progress', { project: { nav: { cursor: 'project:fold:hist:DATA-ONE' } }, prefs: { projectLayout: 'inbox' } }) });
  cl.run('enter');
  assert.match(cl.lines().join('\n'), /▸ Ledger line/);
  cl.run('space');
  assert.deepEqual(cl.run('try-accept').action.target.slices.map((s) => s.id), ['DATA-ONE']);
  const clDone = driver(busy, { data: briefed, height: 50, state: onPage('progress', { project: { nav: { cursor: 'project:fold:inbox:done' } }, prefs: { projectLayout: 'inbox' } }) });
  clDone.run('enter');
  assert.match(clDone.lines().join('\n'), /BAR-LINES/);
});

test('Inbox Projects list at 40 and 80 cols EN and ZH: Needs you / Running / Quiet groups, quiet is one row, exact width', async (t) => {
  const { lists } = await fixture(t);
  for (const width of [40, 80]) for (const lang of ['en', 'zh']) for (const icons of ['unicode', 'text']) {
    const frame = lists.list(width, lang, onPage(undefined, { prefs: { projectLayout: 'inbox' }, project: { view: { kind: 'projects-list' } } }), 22, icons);
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
    // Counts equal ProjectOverview (Timeline).
    assert.match(text, lang === 'zh' ? /demo-project\s+M3b\s+2 待处理/ : /demo-project\s+M3b\s+2 waiting/);
    assert.match(text, lang === 'zh' ? /1 待试用 · 1 运行中/ : /1 to try · 1 running/);
    assert.match(text, lang === 'zh' ? /2 运行中/ : /2 running/);
    if (lang === 'zh') {
      const uiLines = lines.filter((l) => !/^\s*[a-z]+-project/.test(l)).join('\n');
      assert.doesNotMatch(uiLines, /\b(Needs you|Running|Quiet|waiting|to try|running|no STATE\.md)\b/);
    }
  }
});
