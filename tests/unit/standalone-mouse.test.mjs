import { sliceState } from '../fixtures/state-helpers.mjs';
import { homeAnchor, homeTarget } from '../../dist/render/monitor-state.js';
import { projectPageOf } from '../../dist/render/project-view.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { renderMonitor, handleMonitorInput } from '../../dist/render/monitor.js';
import { renderSettingsPage, handleSettingsInput, SETTING_ROWS } from '../../dist/render/settings-page.js';
import { defaultSettings } from '../../dist/settings.js';
import { stripAnsi } from '../../dist/render/colors.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { nativeFixture, NOW } from '../fixtures/native-tree.mjs';
import { projectFixture } from '../fixtures/project-page.mjs';

const sgrPress = (button, x1, y1) => `\x1b[<${button};${x1};${y1}M`;
const sgrRelease = (button, x1, y1) => `\x1b[<${button};${x1};${y1}m`;

test('WorkbenchInputDecoder decodes SGR mouse press, release, wheel, and split chunks cleanly', () => {
  const decoder = new WorkbenchInputDecoder('workboard');
  assert.deepEqual(decoder.push(Buffer.from(sgrPress(0, 12, 5))), [{ type: 'mouse', button: 'left', x: 11, y: 4 }]);
  assert.deepEqual(decoder.push(Buffer.from(sgrRelease(0, 12, 5))), []);
  assert.deepEqual(decoder.push(Buffer.from(sgrPress(64, 8, 9))), [{ type: 'mouse', button: 'wheel-up', x: 7, y: 8 }]);
  assert.deepEqual(decoder.push(Buffer.from(sgrPress(65, 8, 9))), [{ type: 'mouse', button: 'wheel-down', x: 7, y: 8 }]);
  // Wheel with Shift modifier bit (4): button 68 -> wheel-up, 69 -> wheel-down
  assert.deepEqual(decoder.push(Buffer.from(sgrPress(68, 3, 2))), [{ type: 'mouse', button: 'wheel-up', x: 2, y: 1 }]);
  assert.deepEqual(decoder.push(Buffer.from(sgrPress(69, 3, 2))), [{ type: 'mouse', button: 'wheel-down', x: 2, y: 1 }]);
  // Split SGR packet across multiple chunks
  assert.deepEqual(decoder.push(Buffer.from('\x1b[<0;')), []);
  assert.deepEqual(decoder.push(Buffer.from('15;3M')), [{ type: 'mouse', button: 'left', x: 14, y: 2 }]);
  // Bracketed paste inside panel is swallowed silently
  assert.deepEqual(decoder.push(Buffer.from('\x1b[200~pasted text\x1b[201~')), []);
});

test('standalone mouse: tabs switch, first row click selects, second click acts as Enter, wheel scrolls without moving selection, crumb goes back', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'mouse-panel-'));
  const projRoot = fs.mkdtempSync(join(tmpdir(), 'mouse-proj-'));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(projRoot, { recursive: true, force: true });
  });
  const prevLang = setLanguage('en');
  t.after(() => setLanguage(prevLang));

  const f = nativeFixture(home);
  const pf = await projectFixture(projRoot);
  const tree = f.combined();
  const board = f.board(tree);
  const draw = (state, height = 36) => renderMonitor({ tree, workboard: board, project: pf.data, state, width: 90, height, nowMs: NOW, mouse: true });
  const send = (frame, input) => handleMonitorInput(frame.state, input, { tree, frame, nowMs: NOW });

  // 1. Tab click switches main tabs
  let frame = draw(sliceState());
  for (const [kind, tab] of [['board-project', 'project'], ['board-home', 'home']]) {
    const control = frame.controls.find((c) => c.kind === kind);
    assert.ok(control, `missing control ${kind}`);
    frame = draw(send(frame, { type: 'mouse', button: 'left', x: control.x, y: control.y }).state);
    assert.equal(frame.state.activeTab, tab);
  }

  // 2. Crumb click on row 0 closes Help back to Home
  frame = draw(send(frame, { type: 'key', key: 'help' }).state);
  assert.equal(!!frame.state.help, true);
  frame = draw(send(frame, { type: 'mouse', button: 'left', x: 2, y: 0 }).state);
  assert.equal(!!frame.state.help, false);

  // 3. Hub link opens in one click; crumb click returns; elsewhere first click selects and second click acts as Enter
  const projectTab = frame.controls.find((c) => c.kind === 'board-project');
  frame = draw(send(frame, { type: 'mouse', button: 'left', x: projectTab.x, y: projectTab.y }).state);
  assert.equal(frame.state.activeTab, 'project');
  const pane = () => frame.panes[0];
  const progressPageRow = pane().rows
    .map((r, i) => ({ item: r.item, y: pane().y + i - pane().offset }))
    .find((d) => d.item === 'project:page:progress');
  assert.ok(progressPageRow, 'need Progress hub link');
  frame = draw(send(frame, { type: 'mouse', button: 'left', x: 4, y: progressPageRow.y }).state);
  assert.equal(projectPageOf(frame.state), 'progress', 'hub link opens subpage in one click');
  // Crumb click on row 0 returns to the Project hub
  frame = draw(send(frame, { type: 'mouse', button: 'left', x: 4, y: 0 }).state);
  assert.equal(projectPageOf(frame.state), undefined);
  // First click on an unselected non-hub row (project:fold:...) selects it without folding; second click toggles fold (Enter)
  const foldRow = pane().rows
    .map((r, i) => ({ item: r.item, y: pane().y + i - pane().offset }))
    .find((d) => d.item?.startsWith('project:fold:') && d.item !== frame.state.project.nav.cursor);
  assert.ok(foldRow, 'need an unselected fold row');
  const foldId = foldRow.item.slice('project:fold:'.length);
  const foldedBefore = frame.state.project.folded?.has(foldId) ?? false;
  frame = draw(send(frame, { type: 'mouse', button: 'left', x: 4, y: foldRow.y }).state);
  assert.equal(frame.state.project.nav.cursor, foldRow.item);
  assert.equal(frame.state.project.folded?.has(foldId) ?? false, foldedBefore, 'first click selects without toggling fold');
  const sameIndex = pane().rows.findIndex((r) => r.item === foldRow.item);
  frame = draw(send(frame, { type: 'mouse', button: 'left', x: 4, y: pane().y + sameIndex - pane().offset }).state);
  assert.equal(frame.state.project.folded?.has(foldId) ?? false, !foldedBefore, 'second click performs Enter action');

  // 4. Wheel scroll on Home scrolls viewport without moving selection
  const homeTab = frame.controls.find((c) => c.kind === 'board-home');
  frame = draw(send(frame, { type: 'mouse', button: 'left', x: homeTab.x, y: homeTab.y }).state);
  const shortFrame = draw(frame.state, 6);
  const beforeTarget = homeTarget(shortFrame.state.home);
  const beforeAnchor = homeAnchor(shortFrame.state.home);
  const beforeScroll = shortFrame.state.home.scroll ?? 0;
  const scrolled = send(shortFrame, { type: 'mouse', button: 'wheel-down', x: 4, y: 3 });
  assert.deepEqual(homeTarget(scrolled.state.home), beforeTarget);
  assert.equal(homeAnchor(scrolled.state.home), beforeAnchor);
  assert.ok((scrolled.state.home.scroll ?? 0) > beforeScroll);
});

test('Settings mouse: first click selects row without changing value, second click cycles value, wheel scrolls without moving selection, crumb goes back', () => {
  const prevLang = setLanguage('en');
  try {
    const draft = defaultSettings();
    let state = { draft, original: draft, selected: 0, offset: 0, message: '' };
    let frame = renderSettingsPage(state, 80, 14);
    const languageIndex = SETTING_ROWS.findIndex((r) => r.key === 'language');
    const rowY = frame.rows.indexOf(languageIndex);
    assert.ok(rowY >= 0, 'language visible in viewport');
    const beforeLanguage = state.draft.language;

    // First click selects Language without changing its value
    let res = handleSettingsInput(state, { type: 'mouse', button: 'left', x: 4, y: rowY }, frame);
    state = res.state;
    assert.equal(state.selected, languageIndex);
    assert.equal(state.draft.language, beforeLanguage);

    // Second click on the already-selected row cycles Language
    frame = renderSettingsPage(state, 80, 14);
    res = handleSettingsInput(state, { type: 'mouse', button: 'left', x: 4, y: frame.rows.indexOf(languageIndex) }, frame);
    state = res.state;
    assert.notEqual(state.draft.language, beforeLanguage);

    // Wheel scrolls without moving selected
    const selectedBeforeWheel = state.selected;
    frame = renderSettingsPage(state, 80, 14);
    const wheeled = handleSettingsInput(state, { type: 'mouse', button: 'wheel-down', x: 4, y: 4 }, frame).state;
    assert.equal(wheeled.selected, selectedBeforeWheel);
    assert.ok(wheeled.offset > 0, 'wheel-down scrolls viewport down');

    // Crumb click on row 0 left of Save goes back
    const back = handleSettingsInput(wheeled, { type: 'mouse', button: 'left', x: 2, y: 0 }, frame);
    assert.equal(back.action, 'back');
  } finally {
    setLanguage(prevLang);
  }
});

test('PTY smoke: mouse, Help above an unsaved Settings draft, and terminal restore', (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'pty-mouse-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const py = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (py.status !== 0) { t.skip('python3 not available'); return; }

  const script = `
import os, pty, select, subprocess, sys, time

env = dict(os.environ)
env["HOME"] = sys.argv[1]
env["HUD_HOME"] = os.path.join(sys.argv[1], "hud")
env["CODEX_HOME"] = os.path.join(sys.argv[1], "codex")
env["CLAUDE_CONFIG_DIR"] = os.path.join(sys.argv[1], "claude")
env["PI_CODING_AGENT_DIR"] = os.path.join(sys.argv[1], "pi")
env["TERM"] = "xterm-256color"
env["COLUMNS"] = "80"
env["LINES"] = "24"

master, slave = pty.openpty()
proc = subprocess.Popen(["node", sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True)
os.close(slave)

out = bytearray()
def drain(secs):
    end = time.time() + secs
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.05)
        if master in r:
            try:
                chunk = os.read(master, 65536)
                if not chunk:
                    break
                out.extend(chunk)
            except OSError:
                break

drain(0.6)
# Click Project tab roughly around x=11, y=1 (1-based), open Help '?', then click crumb at x=3, y=1, then press q
os.write(master, b"\\x1b[<0;11;1M\\x1b[<0;11;1m")
drain(0.25)
os.write(master, b"?")
drain(0.25)
os.write(master, b"\\x1b[<0;3;1M\\x1b[<0;3;1m")
drain(0.25)
# Open Settings, move to the second row, change its value, and open Help over it.
os.write(master, b",\\x1b[B\\x1b[C?")
drain(0.3)
os.write(master, b"\\x1b")
drain(0.25)
# Undo the draft change and exit: this works only with the original draft and row.
os.write(master, b"\\x1b[Dqq")
drain(0.6)
try:
    rc = proc.wait(timeout=3)
except subprocess.TimeoutExpired:
    proc.kill()
    rc = proc.wait()
os.close(master)
sys.stdout.buffer.write(out)
sys.stderr.write(f"EXIT={rc}\\n")
`;
  const run = spawnSync('python3', ['-c', script, home, resolve('dist/tree-page.js')], { encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /EXIT=0/);
  const screen = stripAnsi(run.stdout);
  assert.match(screen, /‹ Settings[^\r\n]*unsaved[\s\S]*‹ Help[\s\S]*‹ Settings[^\r\n]*unsaved/);
  assert.doesNotMatch(screen, /Save your changes before leaving/);
  assert.ok(run.stdout.includes('\x1b[?1000h\x1b[?1006h'), 'enables SGR mouse');
  assert.ok(run.stdout.includes('\x1b[?1000l\x1b[?1006l'), 'restores SGR mouse on exit');
  assert.ok(!run.stdout.includes('?1002'), 'asks for clicks and the wheel only, no motion reports');
});
