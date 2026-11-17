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
        assert.match(short.lines.map(stripAnsi).join('\n'), /writing-/);
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
      const frame = render(skills(), { backupSkills });
      const last = frame.workboard.rows.at(-1);
      assert.equal(stripAnsi(last.text).trim(), 'Skills catalog unavailable');
      assert.ok(last.text.includes(theme.board.muted('Skills catalog unavailable')));
      assert.ok(frame.workboard.rows.every((r) => !r.item && !r.files));
      assert.match(stripAnsi(frame.lines[2]), /^Backup skills ─+$/, 'no count over a catalog that was not read');
      assert.ok(frame.lines.map(stripAnsi).join('\n').includes('Skills catalog unavailable'));
    }
  } finally { setDisplayConfig(display); setLanguage(before); }
});

const rowsOf = (frame, lang, count = catalog.length) => {
  const lines = frame.lines.map(stripAnsi);
  const at = lines.findIndex((l) => lines.indexOf(l) > 1 && catalog[0].name === l.trim().split(/\s+/)[0]);
  assert.ok(at > 0, `${lang}: first skill row found`);
  return lines.slice(at, at + count);
};

test('Skills lays out aligned names and one-line descriptions at 40, 80 and 160 columns in EN and ZH', () => {
  const before = setLanguage('en'), display = setDisplayConfig({ theme: 'terminal' });
  try {
    for (const lang of ['en', 'zh']) {
      setLanguage(lang);
      for (const width of [40, 80, 160]) {
        const frame = render(skills(), { width, height: 24 });
        for (const line of frame.lines) assert.equal(visualLength(line), width, `${lang} ${width}`);
        const lines = frame.lines.map(stripAnsi);
        assert.ok(lines[3].startsWith('  ') && lines[3].trim(), 'the intro sits under the header, indented');
        const rows = rowsOf(frame, lang);
        assert.equal(rows.length, catalog.length);
        // One row a skill; the description starts in one column on every row.
        const starts = rows.map((row) => /^( {2}\S+ {2,})/.exec(row)[1].length);
        assert.equal(new Set(starts).size, 1, `${lang} ${width}: one description column`);
        rows.forEach((row, i) => {
          const skill = catalog[i], text = skill[lang];
          assert.ok(row.startsWith('  ' + (width >= 80 ? skill.name : skill.name.slice(0, 4))), `${lang} ${width}: ${skill.name}`);
          const description = row.slice(starts[0]).trimEnd();
          if (visualLength(description) < visualLength(text)) {
            assert.ok(description.endsWith('…'), `${lang} ${width}: a cut description says so`);
            assert.ok(text.startsWith(description.slice(0, -1).replace(/[\s,;:]+$/, '')), `${lang} ${width}: a cut keeps the text's start`);
          } else assert.equal(description, text);
        });
        if (width >= 80) assert.ok(rows.every((row, i) => row.includes(catalog[i].name)), 'whole names where the panel has room');
        if (width === 160) assert.ok(rows.every((row, i) => row.includes(catalog[i][lang])), 'whole descriptions on a wide panel');
        if (width === 40) {
          const long = rows[catalog.findIndex((s) => s.name === 'improve-codebase-architecture')];
          assert.match(long, /^ {2}improve-cod…ecture {2}\S/, 'only the one over-long name is cut, in the middle');
          assert.ok(rows.every((row, i) => i === 8 || row.includes(catalog[i].name)));
        }
        assert.ok(rows.every((row, i) => frame.lines[lines.indexOf(row)].includes(theme.board.identifier(row.trim().split(/\s+/)[0]))), 'names are the identifier ink');
        for (const line of frame.lines.slice(1, -1)) assert.doesNotMatch(line, /\x1b\[48;/);
      }
    }
  } finally { setDisplayConfig(display); setLanguage(before); }
});

test('Skills drops its intro, then the blank row, before a short panel scrolls; a narrow one shows names alone', () => {
  const before = setLanguage('en'), display = setDisplayConfig({ theme: 'terminal' });
  try {
    const text = (frame) => frame.lines.map(stripAnsi);
    const intro = /Matt Pocock skills kept as backups/;
    // The whole tab is 16 rows (blank, header, intro, blank, 12 skills): the intro goes when a panel has fewer to give, the blank row above the header below 14.
    assert.match(text(render(skills(), { width: 160, height: 18 })).join('\n'), intro);
    const noIntro = render(skills(), { width: 160, height: 16 });
    assert.doesNotMatch(text(noIntro).join('\n'), intro);
    assert.equal(text(noIntro)[1].trim(), '');
    assert.match(text(noIntro)[2], /^Backup skills/);
    const tight = render(skills(), { width: 160, height: 14 });
    assert.match(text(tight)[1], /^Backup skills/);
    assert.equal(tight.panes[0].contentLength, catalog.length + 1);
    // A panel too narrow for any description keeps the names, cut in the middle if they must be.
    for (const width of [12, 16, 20]) {
      const rows = rowsOf(render(skills(), { width, height: 24 }), `en ${width}`);
      assert.ok(rows.every((row) => !/[a-z] {2,}\S/.test(row.trim().replace(/…/g, 'x'))), `${width}: names only`);
      assert.ok(rows.some((row) => row.trim().includes('…')) || width >= 30);
    }
  } finally { setDisplayConfig(display); setLanguage(before); }
});

test('Skills in every theme uses theme inks only, and with no colour emits no escape', () => {
  const before = setLanguage('en'), display = setDisplayConfig({ theme: 'terminal' });
  try {
    for (const name of THEMES) {
      setDisplayConfig({ theme: name });
      const lines = render(skills(), { width: 80, height: 24 }).lines;
      if (name === 'none') for (const line of lines) assert.doesNotMatch(line, /\x1b/);
      else assert.ok(lines.some((l) => l.includes(theme.board.identifier('wayfinder'))), name);
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
