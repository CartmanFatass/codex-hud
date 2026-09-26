import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultSettings, loadSettings, saveSettings } from '../../src/settings.js';
import type { HudSettings } from '../../src/settings.js';

function withSettingsFile(run: (file: string, directory: string) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-settings-test-'));
  const file = path.join(directory, 'settings.json');
  const previousPath = process.env.CODEX_HUD_SETTINGS_PATH;
  process.env.CODEX_HUD_SETTINGS_PATH = file;
  try {
    run(file, directory);
  } finally {
    if (previousPath === undefined) delete process.env.CODEX_HUD_SETTINGS_PATH;
    else process.env.CODEX_HUD_SETTINGS_PATH = previousPath;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('missing settings keep display defaults and hide optional tasks and activity', () => {
  withSettingsFile((file) => {
    assert.deepEqual(loadSettings(), {
      density: 'balanced', theme: 'terminal', glyphs: 'both', motion: 'full', context: 'used',
      statusline: true, sort: 'active', mouse: true, tasks: false, changes: true, activity: false,
      details: true, refreshMs: 1000, treeWidth: 0, finishedLingerMs: 180_000,
      agentsPane: 'open', worktreesPane: 'open', changesPane: 'closed', detailsPane: 'closed',
      worktreeRoot: '',
    });
    assert.equal(fs.existsSync(file), false, 'reading defaults does not create files');
    const changed = defaultSettings();
    changed.tasks = true;
    assert.equal(defaultSettings().tasks, false, 'defaults are independent objects');
  });
});

test('status bar and context display preferences persist and validate', () => {
  withSettingsFile(file => {
    assert.equal(loadSettings().statusline, true);
    saveSettings({ statusline: false, context: 'remaining' });
    assert.equal(loadSettings().statusline, false);
    assert.equal(loadSettings().context, 'remaining');
    fs.writeFileSync(file, JSON.stringify({ statusline: 'off', context: 'auto' }));
    assert.equal(loadSettings().statusline, true);
    assert.equal(loadSettings().context, 'used');
  });
});

test('load validates known settings without importing unknown or invalid values', () => {
  withSettingsFile((file) => {
    fs.writeFileSync(file, JSON.stringify({
      density: 'focus', theme: 'latte', glyphs: 'text', motion: 'reduced', context: 'used',
      statusline: true, sort: 'created', mouse: false, tasks: true, changes: false, activity: true,
      details: false, refreshMs: 250, treeWidth: 40, finishedLingerMs: 0, unknown: 'ignored',
    }));
    assert.deepEqual(loadSettings(), {
      density: 'focus', theme: 'latte', glyphs: 'text', motion: 'reduced', context: 'used',
      statusline: true, sort: 'created', mouse: false, tasks: true, changes: false, activity: true,
      details: false, refreshMs: 250, treeWidth: 40, finishedLingerMs: 0,
      agentsPane: 'open', worktreesPane: 'open', changesPane: 'closed', detailsPane: 'closed',
      worktreeRoot: '',
    });
    fs.writeFileSync(file, JSON.stringify({
      density: 'huge', theme: {}, glyphs: null, motion: 'none', sort: 'recent',
      mouse: 'false', tasks: 1, changes: null, activity: [], details: {},
      refreshMs: 99, treeWidth: 15, finishedLingerMs: 5, unknown: true,
    }));
    assert.deepEqual(loadSettings(), defaultSettings());
  });
});

test('monitor pane modes and worktreeRoot validate independently of legacy panel booleans', () => {
  withSettingsFile((file) => {
    fs.writeFileSync(file, JSON.stringify({
      agentsPane: 'closed', worktreesPane: 'folded', changesPane: 'open', detailsPane: 'open',
      worktreeRoot: '/repo', details: true, changes: false,
    }));
    const loaded = loadSettings();
    assert.equal(loaded.agentsPane, 'closed');
    assert.equal(loaded.worktreesPane, 'folded');
    assert.equal(loaded.changesPane, 'open');
    assert.equal(loaded.detailsPane, 'open');
    assert.equal(loaded.worktreeRoot, '/repo');
    assert.equal(loaded.details, true);
    assert.equal(loaded.changes, false);
    fs.writeFileSync(file, JSON.stringify({
      agentsPane: 'hidden', worktreesPane: 1, changesPane: null, detailsPane: {},
      worktreeRoot: 'x\0y',
    }));
    const invalid = loadSettings();
    assert.equal(invalid.agentsPane, 'open');
    assert.equal(invalid.worktreesPane, 'open');
    assert.equal(invalid.changesPane, 'closed');
    assert.equal(invalid.detailsPane, 'closed');
    assert.equal(invalid.worktreeRoot, '');
  });
});

test('refresh intervals and widths accept only bounded integer values', () => {
  withSettingsFile((file) => {
    for (const refreshMs of [100, 60_000]) {
      fs.writeFileSync(file, JSON.stringify({ refreshMs }));
      assert.equal(loadSettings().refreshMs, refreshMs);
    }
    for (const refreshMs of [-1, 0, 99, 60_001, 250.5, '1000']) {
      fs.writeFileSync(file, JSON.stringify({ refreshMs }));
      assert.equal(loadSettings().refreshMs, 1000);
    }
    for (const treeWidth of [0, 16, 20, 45, 70, 200]) {
      fs.writeFileSync(file, JSON.stringify({ treeWidth }));
      assert.equal(loadSettings().treeWidth, treeWidth);
    }
    for (const treeWidth of [-1, 1, 15, 201, 40.5, '40']) {
      fs.writeFileSync(file, JSON.stringify({ treeWidth }));
      assert.equal(loadSettings().treeWidth, 0);
    }
  });
});

test('partial saves retain previous preferences and publish a complete JSON document', () => {
  withSettingsFile((file, directory) => {
    const first = saveSettings({ theme: 'mocha', tasks: true });
    assert.equal(first.theme, 'mocha');
    assert.equal(first.tasks, true);
    const second = saveSettings({ treeWidth: 50, tasks: false });
    assert.equal(second.theme, 'mocha');
    assert.equal(second.tasks, false);
    assert.equal(second.treeWidth, 50);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), second);
    assert.deepEqual(loadSettings(), second);
    assert.deepEqual(fs.readdirSync(directory), ['settings.json'], 'atomic write removes temporary files');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

test('save ignores invalid patches and strips unknown fields from existing files', () => {
  withSettingsFile((file) => {
    fs.writeFileSync(file, JSON.stringify({ refreshMs: 500, theme: 'latte', extra: true }));
    const saved = saveSettings({
      theme: 'wrong', refreshMs: Infinity, treeWidth: NaN, mouse: 'no', injected: true,
    } as unknown as Partial<HudSettings>);
    assert.equal(saved.theme, 'latte');
    assert.equal(saved.refreshMs, 500);
    assert.equal(saved.treeWidth, 0);
    assert.equal(saved.mouse, true);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal('extra' in raw, false);
    assert.equal('injected' in raw, false);
  });
});

test('saving creates a missing settings parent directory', () => {
  withSettingsFile((_file, directory) => {
    process.env.CODEX_HUD_SETTINGS_PATH = path.join(directory, 'nested', 'preferences.json');
    saveSettings({ density: 'full' });
    assert.equal(loadSettings().density, 'full');
  });
});

test('malformed JSON and inaccessible settings errors propagate without overwriting the file', () => {
  withSettingsFile((file, directory) => {
    fs.writeFileSync(file, '{bad json');
    assert.throws(() => loadSettings(), SyntaxError);
    assert.throws(() => saveSettings({ theme: 'mocha' }), SyntaxError);
    assert.equal(fs.readFileSync(file, 'utf8'), '{bad json');
    process.env.CODEX_HUD_SETTINGS_PATH = directory;
    assert.throws(() => loadSettings());
  });
});

test('nonobject JSON cannot become settings and oversized files are rejected', () => {
  withSettingsFile((file) => {
    for (const contents of ['null', '[]', 'true', '42', '"theme"']) {
      fs.writeFileSync(file, contents);
      assert.deepEqual(loadSettings(), defaultSettings());
    }
    fs.writeFileSync(file, ' '.repeat(65_537));
    assert.throws(() => loadSettings(), /too large/i);
  });
});
