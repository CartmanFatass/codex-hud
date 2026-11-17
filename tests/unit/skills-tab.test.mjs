import test from 'node:test';
import assert from 'node:assert/strict';
import { readBackupSkills } from '../../dist/collectors/backup-skills.js';
import { renderMonitor, initialMonitorState, handleMonitorInput } from '../../dist/render/monitor.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { commandSequence, monitorKey, needsOpenPanel } from '../../dist/utils/panel-command.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { setDisplayConfig, THEMES } from '../../dist/render/hud-config.js';
import { stripAnsi, visualLength, theme } from '../../dist/render/colors.js';
const tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(0) };
const catalog = readBackupSkills();
const render = (state, extra = {}) => renderMonitor({ tree, state, backupSkills: catalog, width: 160, height: 20, nowMs: 0, ...extra });
const send = (frame, input) => handleMonitorInput(frame.state, input, { tree, frame, nowMs: 0, standalone: true });
const key = (frame, key) => send(frame, { type: 'key', key });
const skills = () => ({ ...initialMonitorState(), mainTab: 'skills' });

test('main tabs cycle in both directions; Skills opens by header, keyboard and Codex command', () => {
  for (const [direction, order] of [
    ['right', ['project', 'skills', 'home']], ['tab', ['project', 'skills', 'home']],
    ['left', ['skills', 'project', 'home']], ['shift-tab', ['skills', 'project', 'home']],
  ]) {
    let frame = render(initialMonitorState());
    for (const tab of order) {
      frame = render(key(frame, direction).state);
      assert.equal(frame.state.mainTab, tab);
    }
  }
  const frame = render(initialMonitorState()), control = frame.controls.find((c) => c.kind === 'board-skills');
  assert.equal(send(frame, { type: 'mouse', button: 'left', x: control.x, y: control.y }).state.mainTab, 'skills');
  const decoder = new WorkbenchInputDecoder('workboard');
  assert.equal(send(frame, decoder.push(Buffer.from('5'))[0]).state.mainTab, 'skills');
  const command = decoder.push(Buffer.from(commandSequence('pane-5')))[0];
  assert.equal(key(frame, monitorKey(command.command)).state.mainTab, 'skills');
  assert.equal(needsOpenPanel(command.command), true);
  assert.match(render({ ...initialMonitorState(), help: true }, { width: 160, height: 50 }).lines.map(stripAnsi).join('\n'), /1 2 5 +Home · Project · Skills/);
  const before = setLanguage('en');
  try {
    const narrow = render(initialMonitorState(), { width: 30 }), brief = narrow.controls.find((c) => c.kind === 'brief');
    assert.ok(narrow.controls.filter((c) => c.kind.startsWith('board-')).every((c) => c.x + c.width < brief.x));
    assert.deepEqual(send(narrow, { type: 'mouse', button: 'left', x: brief.x, y: 0 }).action, { type: 'brief-toggle' });
  } finally { setLanguage(before); }
});

test('Skills renders shipped catalog in EN/ZH, fits narrow rows, scrolls, and has no row actions', () => {
  assert.ok(catalog?.length);
  const before = setLanguage('en'), display = setDisplayConfig({ theme: 'terminal' });
  try {
    for (const lang of ['en', 'zh']) {
      setLanguage(lang);
      const frame = render(skills());
      const text = frame.lines.map(stripAnsi).join('\n');
      assert.equal(stripAnsi(frame.lines[1]).trim(), '', 'a blank row under the tabs, as Home and Project have');
      assert.match(stripAnsi(frame.lines[2]), lang === 'zh' ? /^备用技能 ─+ 12$/ : /^Backup skills ─+ 12$/);
      for (const line of frame.lines.slice(1, -1)) assert.doesNotMatch(line, /\x1b\[48;/);
      for (const skill of catalog) {
        assert.ok(text.includes(skill.name), skill.name);
        assert.ok(text.includes(skill[lang]), skill[lang]);
      }
      for (const width of [16, 40, 80]) {
        let short = render(skills(), { width, height: 6 });
        for (const line of short.lines) assert.equal(visualLength(line), width);
        short = render(key(short, 'end').state, { width, height: 6 });
        assert.equal(short.panes[0].offset, short.panes[0].contentLength - short.panes[0].height);
        assert.ok(short.lines.map(stripAnsi).join('\n').includes(catalog.at(-1)[lang].split(/\s+/).at(-1)), 'the end of the last description');
        short = render(key(short, 'home').state, { width, height: 6 });
        assert.equal(short.panes[0].offset, 0);
        assert.ok(send(short, { type: 'mouse', button: 'wheel-down', x: 0, y: 3 }).state.skillsScroll > 0);
        assert.ok(key(short, 'page-down').state.skillsScroll > 0);
      }
      for (const k of ['enter', 'open-session', 'inspect']) assert.equal(key(frame, k).action, undefined);
      assert.equal(send(frame, { type: 'mouse', button: 'left', x: 5, y: 3 }).action, undefined);
      assert.ok(frame.workboard.rows.every((r) => !r.item && !r.files));
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
        const frame = render(skills(), { backupSkills, width });
        const last = frame.workboard.rows.at(-1);
        assert.equal(stripAnsi(last.text).trim(), 'Skills catalog unavailable');
        assert.ok(last.text.includes(theme.board.muted('Skills catalog unavailable')));
        assert.ok(frame.workboard.rows.every((r) => !r.item && !r.files));
        assert.match(stripAnsi(frame.lines[2]), /^Backup skills ─+$/, 'no count over a catalog that was not read');
        assert.ok(frame.lines.map(stripAnsi).join('\n').includes('Skills catalog unavailable'));
        for (const line of frame.lines) assert.equal(visualLength(line), width);
      }
      // Narrower than the notice, it wraps like the rest of the tab instead of being cut.
      const narrow = render(skills(), { backupSkills, width: 20 }).workboard.rows.map((r) => stripAnsi(r.text).trim());
      assert.ok(narrow.includes('Skills catalog') && narrow.includes('unavailable'));
    }
  } finally { setDisplayConfig(display); setLanguage(before); }
});

/**
 * The tab's skills as the panel painted them: a name in the identifier ink, then the description rows (the first of them
 * on the name's row when the layout is side by side). A name too long for its row wraps onto the next, with no
 * description between, and is joined back here.
 */
const skillBlocks = (frame) => {
  const blocks = [], ink = /^ {2}\x1b\[[0-9;]*m([^\x1b]*)\x1b\[[0-9;]*m( *)(.*)$/;
  for (const raw of frame.workboard.rows.map((r) => r.text)) {
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
        const frame = render(skills(), { width, height: 24 });
        for (const line of frame.lines) assert.equal(visualLength(line), width, `${lang} ${width}`);
        assert.ok(frame.workboard.rows.slice(2).every((r) => !stripAnsi(r.text).includes('…')), `${lang} ${width}: nothing under the header is cut`);
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

test('Skills at 40 columns: a description wraps in 36 cells under its name, names stand alone and the tab scrolls', () => {
  const before = setLanguage('en'), display = setDisplayConfig({ theme: 'terminal' });
  try {
    for (const lang of ['en', 'zh']) {
      setLanguage(lang);
      const frame = render(skills(), { width: 40, height: 24 }), blocks = skillBlocks(frame), lines = frame.lines.map(stripAnsi);
      assert.equal(blocks.length, catalog.length);
      assert.ok(lines[3].startsWith('  ') && lines[3].trim(), 'the intro sits under the header, indented, and is kept on a panel the list cannot fit');
      assert.ok(blocks.every((b, i) => !b.side && b.desc.length >= 1 && b.desc.every((row) => visualLength(row) <= 36) && b.name === catalog[i].name));
      assert.ok(blocks.some((b) => b.desc.length >= 2), 'long descriptions take more than one row');
      assert.ok(frame.panes[0].contentLength > frame.panes[0].height, 'wrapped, the tab is longer than the panel and scrolls');
      for (const line of frame.lines.slice(1, -1)) assert.doesNotMatch(line, /\x1b\[48;/);
    }
    // A name over the row (29 cells at 30 columns, which leave 28) breaks after a hyphen, whole.
    setLanguage('en');
    const rows = render(skills(), { width: 30, height: 24 }).workboard.rows.map((r) => stripAnsi(r.text).trimEnd());
    const at = rows.indexOf('  improve-codebase-');
    assert.equal(rows[at + 1], '  architecture');
  } finally { setDisplayConfig(display); setLanguage(before); }
});

test('Skills drops its intro, then the blank row, only when that lets the tab fit; otherwise it scrolls with its intro', () => {
  const before = setLanguage('en'), display = setDisplayConfig({ theme: 'terminal' });
  try {
    const text = (frame) => frame.lines.map(stripAnsi);
    const intro = /Matt Pocock skills kept as backups/;
    // At 160 columns the tab is 16 rows (blank, header, intro, blank, 12 skills); `room` is the panel's height less 2.
    assert.match(text(render(skills(), { width: 160, height: 18 })).join('\n'), intro);
    const noIntro = render(skills(), { width: 160, height: 16 });
    assert.doesNotMatch(text(noIntro).join('\n'), intro);
    assert.equal(text(noIntro)[1].trim(), '');
    assert.match(text(noIntro)[2], /^Backup skills/);
    const tight = render(skills(), { width: 160, height: 15 });
    assert.match(text(tight)[1], /^Backup skills/);
    assert.equal(tight.panes[0].contentLength, catalog.length + 1);
    // Too short for even that: the tab keeps its shape and scrolls.
    const scrolls = render(skills(), { width: 160, height: 8 });
    assert.match(text(scrolls).join('\n'), intro);
    assert.equal(scrolls.panes[0].contentLength, catalog.length + 4);
    // At 40 columns the wrapped list never fits a panel this size, so the intro stays.
    const narrow = render(skills(), { width: 40, height: 30 });
    assert.match(text(narrow).join('\n'), intro);
    assert.equal(text(narrow)[1].trim(), '');
  } finally { setDisplayConfig(display); setLanguage(before); }
});

test('Skills in every theme uses theme inks only, and with no colour emits no escape', () => {
  const before = setLanguage('en'), display = setDisplayConfig({ theme: 'terminal' });
  try {
    for (const name of THEMES) {
      setDisplayConfig({ theme: name });
      for (const width of [40, 80]) {
        const frame = render(skills(), { width, height: 24 }), lines = frame.lines;
        if (name === 'none') for (const line of lines) assert.doesNotMatch(line, /\x1b/);
        else assert.ok(lines.some((l) => l.includes(theme.board.identifier('wayfinder'))), name);
        const all = stripSpace(frame.workboard.rows.map((r) => stripAnsi(r.text)).join(''));
        for (const skill of catalog) assert.ok(all.includes(stripSpace(skill.en)), `${name} ${width}: ${skill.name} in full`);
      }
    }
    setDisplayConfig({ theme: 'terminal' });
    // A catalog with no skills is not the unreadable one.
    const empty = render(skills(), { backupSkills: [], width: 80, height: 24 });
    assert.equal(stripAnsi(empty.workboard.rows.at(-1).text).trim(), 'No backup skills listed');
    assert.match(stripAnsi(empty.lines[2]), /^Backup skills ─+$/);
    setLanguage('zh');
    assert.equal(stripAnsi(render(skills(), { backupSkills: [], width: 80, height: 24 }).workboard.rows.at(-1).text).trim(), '目录里没有备用技能');
    assert.equal(stripAnsi(render(skills(), { backupSkills: null, width: 80, height: 24 }).workboard.rows.at(-1).text).trim(), '技能目录缺失或无法读取');
  } finally { setDisplayConfig(display); setLanguage(before); }
});
