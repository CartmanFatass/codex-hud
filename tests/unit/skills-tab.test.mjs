import test from 'node:test';
import assert from 'node:assert/strict';
import { readBackupSkills } from '../../dist/collectors/backup-skills.js';
import { renderMonitor, initialMonitorState, handleMonitorInput } from '../../dist/render/monitor.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { readPanelPlace } from '../../dist/utils/panel-reload.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { setDisplayConfig, THEMES } from '../../dist/render/hud-config.js';
import { stripAnsi, visualLength, theme } from '../../dist/render/colors.js';
const tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(0) };
const catalog = readBackupSkills();
const render = (state, extra = {}) => renderMonitor({ tree, state, backupSkills: catalog, width: 160, height: 25, nowMs: 0, ...extra });
const send = (frame, input) => handleMonitorInput(frame.state, input, { tree, frame, nowMs: 0, standalone: true });
const key = (frame, key) => send(frame, { type: 'key', key });
const help = () => key(render(initialMonitorState()), 'help').state;
const skillHeader = /^(Backup |备用技)/; // The heading itself can be clipped at 12 columns.
const skillSection = (frame) => {
  const rows = frame.workboard.rows;
  const at = rows.findIndex((r) => skillHeader.test(stripAnsi(r.text)));
  assert.ok(at > 0, 'Help includes a Backup skills section');
  return rows.slice(at);
};

test('main tabs cycle Home → Project → Control; 5 does not switch and old Skills reloads onto Home', (t) => {
  for (const [direction, order] of [
    ['right', ['project', 'control', 'home']], ['tab', ['project', 'control', 'home']],
    ['left', ['control', 'project', 'home']], ['shift-tab', ['control', 'project', 'home']],
  ]) {
    let frame = render(initialMonitorState());
    for (const tab of order) {
      frame = render(key(frame, direction).state);
      assert.equal(frame.state.mainTab, tab);
    }
  }
  const frame = render(initialMonitorState(), { width: 40 });
  assert.deepEqual(frame.controls.filter((c) => c.kind.startsWith('board-')).map((c) => c.kind), ['board-home', 'board-project', 'board-control']);
  const decoder = new WorkbenchInputDecoder('workboard');
  const five = send(frame, decoder.push(Buffer.from('5'))[0]);
  assert.equal(five.state.mainTab, 'home');
  assert.equal(five.state.help, false);
  const previous = process.env.HUD_PANEL_RELOAD_PLACE;
  t.after(() => {
    if (previous === undefined) delete process.env.HUD_PANEL_RELOAD_PLACE;
    else process.env.HUD_PANEL_RELOAD_PLACE = previous;
  });
  process.env.HUD_PANEL_RELOAD_PLACE = JSON.stringify({ state: { ...frame.state, mainTab: 'skills' } });
  assert.equal(readPanelPlace().state.mainTab, 'home');
  const before = setLanguage('en');
  try {
    const narrow = render(initialMonitorState(), { width: 36, modelEnabled: false }), brief = narrow.controls.find((c) => c.kind === 'brief');
    assert.ok(narrow.controls.filter((c) => c.kind.startsWith('board-')).every((c) => c.x + c.width < brief.x));
    assert.deepEqual(send(narrow, { type: 'mouse', button: 'left', x: brief.x, y: 0 }).action, { type: 'brief-toggle' });
  } finally { setLanguage(before); }
});

test('Help shows the shipped Skills catalog in EN/ZH and scrolls without row actions', () => {
  assert.ok(catalog?.length);
  const before = setLanguage('en'), display = setDisplayConfig({ theme: 'terminal' });
  try {
    for (const lang of ['en', 'zh']) {
      setLanguage(lang);
      const frame = render(help(), { height: 80 });
      const text = frame.lines.map(stripAnsi).join('\n');
      assert.match(stripAnsi(skillSection(frame)[0].text), new RegExp(` ${catalog.length}$`));
      for (const line of frame.lines.slice(1, -1)) assert.doesNotMatch(line, /\x1b\[48;/);
      for (const skill of catalog) {
        assert.ok(text.includes(skill.name), skill.name);
        assert.ok(text.includes(skill[lang]), skill[lang]);
      }
      for (const width of [16, 40, 80]) {
        let short = render(help(), { width, height: 6 });
        for (const line of short.lines) assert.equal(visualLength(line), width);
        short = render(key(short, 'end').state, { width, height: 6 });
        assert.equal(short.panes[0].offset, short.panes[0].contentLength - short.panes[0].height);
        assert.ok(short.lines.map(stripAnsi).join('\n').includes(catalog.at(-1)[lang].split(/\s+/).at(-1)), 'the end of the last description');
        const click = send(short, { type: 'mouse', button: 'left', x: 5, y: 3 });
        assert.equal(click.action, undefined);
        assert.equal(click.state.helpScroll, short.state.helpScroll, 'clicking a skill row does not scroll or select it');
        short = render(key(short, 'home').state, { width, height: 6 });
        assert.equal(short.panes[0].offset, 0);
        assert.ok(send(short, { type: 'mouse', button: 'wheel-down', x: 0, y: 3 }).state.helpScroll > 0);
        assert.ok(key(short, 'page-down').state.helpScroll > 0);
      }
      for (const k of ['enter', 'open-session', 'inspect']) assert.equal(key(frame, k).action, undefined);
      assert.ok(skillSection(frame).every((r) => !r.item && !r.files));
    }
  } finally { setDisplayConfig(display); setLanguage(before); }
});

test('a missing or unreadable Skills catalog renders one muted notice, not a crash', () => {
  const before = setLanguage('en'), display = setDisplayConfig({ theme: 'terminal' });
  try {
    // Missing path and a directory both exercise the real reader's failure path without touching shipped data.
    for (const path of [new URL('../fixtures/no-skills-catalog.json', import.meta.url), new URL('../fixtures/', import.meta.url)]) {
      const backupSkills = readBackupSkills(path);
      assert.equal(backupSkills, null);
      for (const width of [40, 160]) {
        const frame = render(help(), { backupSkills, width, height: 120 });
        const rows = skillSection(frame);
        const last = rows.at(-1);
        assert.equal(stripAnsi(last.text).trim(), 'Skills catalog unavailable');
        assert.ok(last.text.includes(theme.board.muted('Skills catalog unavailable')));
        assert.ok(rows.every((r) => !r.item && !r.files));
        assert.match(stripAnsi(rows[0].text), /^Backup skills ─+$/, 'no count over a catalog that was not read');
        assert.ok(frame.lines.map(stripAnsi).join('\n').includes('Skills catalog unavailable'));
        for (const line of frame.lines) assert.equal(visualLength(line), width);
      }
      // Narrower than the notice, it wraps like the rest of the section instead of being cut.
      const narrow = skillSection(render(help(), { backupSkills, width: 20 })).map((r) => stripAnsi(r.text).trim());
      assert.ok(narrow.includes('Skills catalog') && narrow.includes('unavailable'));
    }
  } finally { setDisplayConfig(display); setLanguage(before); }
});

/**
 * Help's skills as the panel painted them: a name in the identifier ink, then the description rows (the first of them
 * on the name's row when the layout is side by side). A name too long for its row wraps onto the next, with no
 * description between, and is joined back here.
 */
const skillBlocks = (frame) => {
  const blocks = [], ink = /^ {2}\x1b\[[0-9;]*m([^\x1b]*)\x1b\[[0-9;]*m( *)(.*)$/;
  for (const raw of skillSection(frame).map((r) => r.text)) {
    const m = ink.exec(raw), line = stripAnsi(raw).trimEnd(), last = blocks.at(-1);
    if (m && raw.startsWith('  ' + theme.board.identifier(m[1]))) {
      assert.doesNotMatch(m[3], /\x1b/, 'the description is plain text');
      if (last && !last.desc.length && !m[3]) last.name += m[1];
      else blocks.push({ name: m[1], side: !!m[3], column: 2 + visualLength(m[1]) + m[2].length, desc: m[3] ? [m[3]] : [], indents: m[3] ? [2 + visualLength(m[1]) + m[2].length] : [] });
    } else if (last && line.trim()) {
      last.desc.push(line.trim());
      last.indents.push(line.length - line.trimStart().length);
    }
  }
  return blocks;
};
/** The width at which the side-by-side layout starts for the shipped catalog: the longest name, the description column and the gaps. */
const sideFrom = 2 + Math.max(...catalog.map((s) => s.name.length)) + 2 + 70;
const stripSpace = (text) => text.replace(/\s+/g, '');

test('Skills wraps each whole description under its name at every width from 12 to 170 columns in EN and ZH, never cutting', () => {
  const before = setLanguage('en'), display = setDisplayConfig({ theme: 'terminal' });
  try {
    for (const lang of ['en', 'zh']) {
      setLanguage(lang);
      for (let width = 12; width <= 170; width++) {
        const frame = render(help(), { width, height: 24 });
        for (const line of frame.lines) assert.equal(visualLength(line), width, `${lang} ${width}`);
        assert.ok(skillSection(frame).slice(1).every((r) => !stripAnsi(r.text).includes('…')), `${lang} ${width}: nothing under the header is cut`);
        const blocks = skillBlocks(frame);
        assert.deepEqual(blocks.map((b) => b.name), catalog.map((s) => s.name), `${lang} ${width}: whole names, in order`);
        blocks.forEach((b, i) => assert.equal(stripSpace(b.desc.join('')), stripSpace(catalog[i][lang]), `${lang} ${width}: ${b.name} in full`));
        if (width < sideFrom) {
          assert.ok(blocks.every((b) => !b.side && b.indents.every((n) => n === 4)), `${lang} ${width}: the description under its name, two cells in`);
        } else {
          assert.equal(new Set(blocks.map((b) => b.column)).size, 1, `${lang} ${width}: one description column`);
          assert.ok(blocks.every((b) => b.side && b.indents.every((n) => n === b.column)), `${lang} ${width}: wrapped rows hang under the first`);
        }
      }
    }
  } finally { setDisplayConfig(display); setLanguage(before); }
});

test('Help at 40 columns: full Skills descriptions wrap in 36 cells under their names', () => {
  const before = setLanguage('en'), display = setDisplayConfig({ theme: 'terminal' });
  try {
    for (const lang of ['en', 'zh']) {
      setLanguage(lang);
      let frame = render(help(), { width: 40, height: 24 });
      while (!frame.lines.some((line) => skillHeader.test(stripAnsi(line)))) {
        const page = key(frame, 'page-down').state;
        assert.ok(page.helpScroll > frame.state.helpScroll, 'can page down to the Skills section');
        frame = render(page, { width: 40, height: 24 });
      }
      const blocks = skillBlocks(frame);
      assert.equal(blocks.length, catalog.length);
      const intro = stripAnsi(skillSection(frame)[1].text);
      assert.ok(intro.startsWith('  ') && intro.trim(), 'the intro sits under the header, indented');
      blocks.forEach((b, i) => assert.equal(stripSpace(b.desc.join('')), stripSpace(catalog[i][lang])));
      assert.ok(blocks.every((b, i) => !b.side && b.desc.length >= 1 && b.desc.every((row) => visualLength(row) <= 36) && b.name === catalog[i].name));
      assert.ok(blocks.some((b) => b.desc.length >= 2), 'long descriptions take more than one row');
      assert.ok(skillSection(frame).length > frame.panes[0].height, 'Help scrolls through the wrapped list');
      for (const line of frame.lines.slice(1, -1)) assert.doesNotMatch(line, /\x1b\[48;/);
    }
    // A name over the row (29 cells at 30 columns, which leave 28) breaks after a hyphen, whole.
    setLanguage('en');
    const rows = skillSection(render(help(), { width: 30, height: 24 })).map((r) => stripAnsi(r.text).trimEnd());
    const at = rows.indexOf('  improve-codebase-');
    assert.equal(rows[at + 1], '  architecture');
  } finally { setDisplayConfig(display); setLanguage(before); }
});

test('Skills in every theme uses theme inks only, and with no colour emits no escape', () => {
  const before = setLanguage('en'), display = setDisplayConfig({ theme: 'terminal' });
  try {
    for (const name of THEMES) {
      setDisplayConfig({ theme: name });
      for (const width of [40, 80]) {
        const frame = render(help(), { width, height: 100 }), lines = frame.lines;
        if (name === 'none') for (const line of lines) assert.doesNotMatch(line, /\x1b/);
        else assert.ok(lines.some((l) => l.includes(theme.board.identifier('wayfinder'))), name);
        const all = stripSpace(skillSection(frame).map((r) => stripAnsi(r.text)).join(''));
        for (const skill of catalog) assert.ok(all.includes(stripSpace(skill.en)), `${name} ${width}: ${skill.name} in full`);
      }
    }
    setDisplayConfig({ theme: 'terminal' });
    // A catalog with no skills is not the unreadable one.
    const empty = skillSection(render(help(), { backupSkills: [], width: 80 }));
    assert.equal(stripAnsi(empty.at(-1).text).trim(), 'No backup skills listed');
    assert.match(stripAnsi(empty[0].text), /^Backup skills ─+$/);
    setLanguage('zh');
    assert.equal(stripAnsi(render(help(), { backupSkills: [], width: 80 }).workboard.rows.at(-1).text).trim(), '目录里没有备用技能');
    assert.equal(stripAnsi(render(help(), { backupSkills: null, width: 80 }).workboard.rows.at(-1).text).trim(), '技能目录缺失或无法读取');
  } finally { setDisplayConfig(display); setLanguage(before); }
});
