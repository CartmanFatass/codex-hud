import { ProjectCollector } from '../../dist/collectors/project-board.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { defaultSettings } from '../../dist/settings.js';
import { ModelRuntimeStore, callsByFeature } from '../../dist/collectors/model-runtime-store.js';
import { WorktreeCollector } from '../../dist/collectors/worktrees.js';
import { renderSettingsPage, SETTING_ROWS } from '../../dist/render/settings-page.js';
import { renderMonitor, initialMonitorState, handleMonitorInput } from '../../dist/render/monitor.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';

const tree = { rootId: 'synthetic', nodes: [], totalCount: 0, updatedAt: new Date(0) };
test('Settings shows hourly execution decision usage and cap, including zero, in EN/ZH', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hud-settings-calls-'));
  const previous = setLanguage('en');
  t.after(() => {
    setLanguage(previous);
    rmSync(dir, { recursive: true, force: true });
  });
  const now = 1_700_000_000_000;
  const store = new ModelRuntimeStore(dir);
  const draft = { ...defaultSettings(), decisionCallsPerHour: 7 };
  for (const calls of [[], [now - 3_600_001, now - 1000, now]]) {
    writeFileSync(join(dir, 'calls.json'), JSON.stringify(calls));
    const byFeature = callsByFeature(store.calls(), now);
    const health = { decisionCalls: { byFeature, lastHour: Object.values(byFeature).reduce((sum, n) => sum + n, 0) } };
    for (const language of ['en', 'zh']) {
      setLanguage(language);
      for (const width of [32, 40, 56]) {
        const state = { draft, selected: SETTING_ROWS.findIndex((r) => r.key === 'decisionCallsPerHour'), offset: 0 };
        const height = 12;
        const frame = renderSettingsPage(state, width, height, health);
        assert.ok(frame.lines.every((line) => visualLength(line) === width));
        const text = frame.lines.map(stripAnsi).join('\n');
        assert.match(text, calls.length ? /2\/7/ : /0\/7/);
        assert.match(text, language === 'en' ? /Decision calls this hour/ : /本小时决策调用/);
        const themeRow = SETTING_ROWS.findIndex((r) => r.key === 'theme');
        const display = renderSettingsPage({ ...frame.state, selected: themeRow }, width, height, health);
        assert.ok(display.state.offset < frame.state.offset, 'selecting Theme scrolls back to Display');
        assert.ok(display.rows.includes(themeRow));
        assert.doesNotMatch(display.lines.map(stripAnsi).join('\n'), /Decision calls this hour|本小时决策调用/);
      }
    }
  }
});

test('Project Working tree includes repository/worktree summary; f does not open a standalone panel', async (t) => {
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
  const [key] = new WorkbenchInputDecoder('workboard').push(Buffer.from('f'));
  assert.equal(handleMonitorInput(home.state, key, { frame: home }).state.subpage, undefined);
  const state = { ...home.state, activeTab: 'project', project: { ...home.state.project, view: { kind: 'tree' } } };
  const project = await new ProjectCollector(repo, join(dir, 'hud')).collect('home', { workers: [], lanes: [] }, Date.now());
  const frame = renderMonitor({ tree, project, worktrees, state, width: 120, height: 30 });
  const pane = frame.panes.find((p) => p.id === 'agents');
  const text = pane.rows.map((row) => stripAnsi(row.text)).join('\n');
  for (const fact of [
    'branch     trunk',
    'HEAD',
    'ahead      0',
    'behind     0',
    'staged     1',
    'unstaged   1',
    'untracked  1',
    'trunk · dirty',
    'side · clean',
  ])
    assert.ok(text.includes(fact), fact);
  assert.ok(text.includes(repo) && text.includes(side));
  assert.doesNotMatch(text, /tracked\.txt|not displayed/);
  assert.ok(pane.rows.every((row) => !row.item && !row.controls));
  assert.deepEqual(handleMonitorInput(frame.state, { type: 'key', key: 'enter' }, { tree, frame }).state, frame.state);
  for (const width of [32, 40, 56]) {
    const narrow = renderMonitor({ tree, project, worktrees, state, width, height: 30 });
    assert.ok(narrow.lines.every((line) => visualLength(line) === width));
    const rows = narrow.panes.find((p) => p.id === 'agents').rows;
    assert.ok(rows.some((row) => stripAnsi(row.text).includes('trunk · dirty')));
  }
  // Starting in a linked worktree's subdirectory (also through a symlink) must
  // summarize that worktree, never silently fall back to the first list entry.
  mkdirSync(join(side, 'src'));
  writeFileSync(join(side, 'tracked.txt'), 'side edit\n');
  symlinkSync(side, join(dir, 'alias'), 'dir');
  for (const source of [join(side, 'src'), join(dir, 'alias', 'src')]) {
    const nested = await new WorktreeCollector().refresh([source]);
    const detail = renderMonitor({ tree, project, worktrees: nested, state, width: 120, height: 30 });
    const summary = detail.panes
      .find((p) => p.id === 'agents')
      .rows.map((r) => stripAnsi(r.text))
      .join('\n');
    assert.match(summary, /branch\s+side/);
    assert.match(summary, /unstaged\s+1/);
    assert.match(summary, /staged\s+0/);
    assert.doesNotMatch(summary, /branch\s+trunk/);
  }
});
