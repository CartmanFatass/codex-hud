import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { defaultSettings } from '../../dist/settings.js';
import { SmallModel } from '../../dist/collectors/small-model.js';
import { WorktreeCollector } from '../../dist/collectors/worktrees.js';
import { renderSettingsPage, SETTING_ROWS } from '../../dist/render/settings-page.js';
import { renderMonitor, initialMonitorState, handleMonitorInput } from '../../dist/render/monitor.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';

const tree = { rootId: 'synthetic', nodes: [], totalCount: 0, updatedAt: new Date(0) };
test('Settings → LLM shows real hourly usage/cap, including zero and with model text off, in EN/ZH', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hud-settings-calls-'));
  const previous = setLanguage('en');
  t.after(() => {
    setLanguage(previous);
    rmSync(dir, { recursive: true, force: true });
  });
  const now = 1_700_000_000_000;
  const model = new SmallModel({ dir, clock: () => now });
  model.configure({ backend: 'off', hourlyCap: 7 });
  const draft = { ...defaultSettings(), modelEnabled: false, modelCallsPerHour: 7 };
  for (const calls of [[], [now - 3_600_001, now - 1000, now]]) {
    writeFileSync(join(dir, 'calls.json'), JSON.stringify(calls));
    for (const language of ['en', 'zh']) {
      setLanguage(language);
      for (const width of [32, 40, 56]) {
        const state = { draft, selected: SETTING_ROWS.findIndex((r) => r.key === 'modelCallsPerHour'), offset: 0 };
        const health = { state: undefined, modelCalls: model.usage() };
        const frame = renderSettingsPage(state, width, 24, health);
        assert.ok(frame.lines.every((line) => visualLength(line) === width));
        const text = frame.lines.map(stripAnsi).join('\n');
        assert.match(text, calls.length ? /2\/7/ : /0\/7/);
        assert.match(text, language === 'en' ? /Model calls this hour/ : /近一小时模型调用/);
        const display = renderSettingsPage({ ...state, selected: 0 }, width, 24, health);
        assert.doesNotMatch(display.lines.map(stripAnsi).join('\n'), /Model calls this hour|近一小时模型调用/);
      }
    }
  }
});

test('Changes keeps key 3 and repository/worktree summary; no file selection, previews or diffs', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hud-changes-'));
  const previous = setLanguage('en');
  t.after(() => {
    setLanguage(previous);
    rmSync(dir, { recursive: true, force: true });
  });
  const repo = join(dir, 'repo'),
    side = join(dir, 'side');
  mkdirSync(repo);
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', ...args], {
      cwd: repo,
      stdio: 'pipe',
    });
  git('init', '-b', 'trunk');
  writeFileSync(join(repo, 'tracked.txt'), 'before\n');
  git('add', '.');
  git('commit', '-m', 'synthetic');
  git('worktree', 'add', '-b', 'side', side);
  git('branch', '--set-upstream-to=side', 'trunk');
  writeFileSync(join(repo, 'tracked.txt'), 'staged\n');
  git('add', '.');
  writeFileSync(join(repo, 'tracked.txt'), 'unstaged\n');
  writeFileSync(join(repo, 'untracked.txt'), 'not displayed\n');
  const worktrees = await new WorktreeCollector().refresh([repo]);
  assert.equal(worktrees.entries.length, 2);
  assert.equal(worktrees.entries[0].status.staged, 1);
  assert.equal(worktrees.entries[0].status.unstaged, 1);
  assert.equal(worktrees.entries[0].status.untracked, 1);
  const home = renderMonitor({
    tree,
    workboard: { lanes: [], workers: [], decisions: [], needsYou: [], coverage: { incomplete: false } },
    state: initialMonitorState(),
    width: 56,
    height: 24,
  });
  const [key] = new WorkbenchInputDecoder('workboard').push(Buffer.from('3'));
  const state = handleMonitorInput(home.state, key, { tree, frame: home }).state;
  assert.equal(state.focus, 'changes');
  const frame = renderMonitor({ tree, worktrees, state, width: 120, height: 30 });
  const pane = frame.panes.find((p) => p.id === 'changes');
  const text = pane.rows.map((row) => stripAnsi(row.text)).join('\n');
  for (const fact of [
    'Branch: trunk',
    'HEAD:',
    '0 ahead',
    '0 behind',
    '1 staged',
    '1 unstaged',
    '1 untracked',
    'trunk · dirty',
    'side · clean',
  ])
    assert.ok(text.includes(fact), fact);
  assert.ok(text.includes(repo) && text.includes(side));
  assert.doesNotMatch(text, /tracked\.txt|not displayed/);
  assert.ok(pane.rows.every((row) => !row.item && !row.controls));
  assert.deepEqual(handleMonitorInput(frame.state, { type: 'key', key: 'enter' }, { tree, frame }).state, frame.state);
  for (const width of [32, 40, 56]) {
    const narrow = renderMonitor({ tree, worktrees, state, width, height: 30 });
    assert.ok(narrow.lines.every((line) => visualLength(line) === width));
    const rows = narrow.panes.find((p) => p.id === 'changes').rows;
    assert.ok(rows.some((row) => stripAnsi(row.text).includes('trunk · dirty')));
  }
  // Starting in a linked worktree's subdirectory (also through a symlink) must
  // summarize that worktree, never silently fall back to the first list entry.
  mkdirSync(join(side, 'src'));
  writeFileSync(join(side, 'tracked.txt'), 'side edit\n');
  symlinkSync(side, join(dir, 'alias'), 'dir');
  for (const source of [join(side, 'src'), join(dir, 'alias', 'src')]) {
    const nested = await new WorktreeCollector().refresh([source]);
    const detail = renderMonitor({ tree, worktrees: nested, state, width: 120, height: 30 });
    const summary = detail.panes
      .find((p) => p.id === 'changes')
      .rows.map((r) => stripAnsi(r.text))
      .join('\n');
    assert.match(summary, /Branch: side/);
    assert.match(summary, /1 unstaged/);
    assert.match(summary, /0 staged/);
    assert.doesNotMatch(summary, /Branch: trunk/);
  }
});
