import test from 'node:test';
import assert from 'node:assert/strict';
import { readBackupSkills } from '../../dist/collectors/backup-skills.js';
import { renderMonitor, initialMonitorState, handleMonitorInput } from '../../dist/render/monitor.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { commandSequence, monitorKey, needsOpenPanel } from '../../dist/utils/panel-command.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
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
      assert.match(stripAnsi(frame.lines[1]), lang === 'zh' ? /技能 › 备用技能/ : /Skills › Backup skills/);
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
        assert.ok(short.lines.map(stripAnsi).join('\n').includes('writing-for-'));
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
      assert.equal(frame.workboard.rows.length, 2);
      assert.equal(frame.workboard.rows[1].text, theme.board.muted('Skills catalog unavailable'));
      assert.ok(frame.lines.map(stripAnsi).join('\n').includes('Skills catalog unavailable'));
    }
  } finally { setDisplayConfig(display); setLanguage(before); }
});
