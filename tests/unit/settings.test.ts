import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultCardVisibility } from '../../src/card-visibility.js';
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
      ...defaultCardVisibility(),
      density: 'balanced', theme: 'terminal', glyphs: 'both', motion: 'full', context: 'used', agentColors: 'name',
      statusline: true, sort: 'active', mouse: true, tasks: false, changes: true, activity: false,
      details: true, refreshMs: 1000, treeWidth: 48, finishedLingerMs: 180_000,
      agentsPane: 'open', changesPane: 'closed', detailsPane: 'closed', timelinePane: 'closed', panelStyle: 'rich',
      timelineStyle: 'rail', timelineHours: 3, importantRoles: '',
      worktreeRoot: '', briefing: 'off', briefingMs: 300_000, briefingPaused: false, language: 'auto',
      briefingApiBase: '', briefingApiModel: '', briefingApiKey: '', briefingApiReasoning: false,
      briefingApiLiteModel: 'gemini-3.5-flash-lite', briefingApiLowModel: 'gemini-3.8-flash-low', briefingApiMediumModel: 'gemini-3.8-flash-medium',
      briefAgents: true, briefMain: false, agentProgress: true, recapFloorMs: 900_000, statusCard: 'full', modelCallsPerHour: 60, agentLog: false, cardCorners: 'square', notify: false, notifyDesktop: false,
      resultDigest: false, agentLabels: true, labelAsName: true, failureCause: false, changeSummary: false, approvalDescription: false,
      art: 'off', artImage: '', prefixKey: 'C-\\', icons: 'unicode', look: 'tab', paneLayout: 'stack',
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
      ...defaultCardVisibility(),
      density: 'focus', theme: 'latte', glyphs: 'text', motion: 'reduced', context: 'used', agentColors: 'name',
      statusline: true, sort: 'created', mouse: false, tasks: true, changes: false, activity: true,
      details: false, refreshMs: 250, treeWidth: 40, finishedLingerMs: 0,
      agentsPane: 'open', changesPane: 'closed', detailsPane: 'closed', timelinePane: 'closed', panelStyle: 'rich',
      timelineStyle: 'rail', timelineHours: 3, importantRoles: '',
      worktreeRoot: '', briefing: 'off', briefingMs: 300_000, briefingPaused: false, language: 'auto',
      briefingApiBase: '', briefingApiModel: '', briefingApiKey: '', briefingApiReasoning: false,
      briefingApiLiteModel: 'gemini-3.5-flash-lite', briefingApiLowModel: 'gemini-3.8-flash-low', briefingApiMediumModel: 'gemini-3.8-flash-medium',
      briefAgents: true, briefMain: false, agentProgress: true, recapFloorMs: 900_000, statusCard: 'full', modelCallsPerHour: 60, agentLog: false, cardCorners: 'square', notify: false, notifyDesktop: false,
      resultDigest: false, agentLabels: true, labelAsName: true, failureCause: false, changeSummary: false, approvalDescription: false,
      art: 'off', artImage: '', prefixKey: 'C-]', icons: 'unicode', look: 'tab', paneLayout: 'stack',
    });
    fs.writeFileSync(file, JSON.stringify({
      density: 'huge', theme: {}, glyphs: null, motion: 'none', sort: 'recent',
      mouse: 'false', tasks: 1, changes: null, activity: [], details: {},
      refreshMs: 99, treeWidth: 15, finishedLingerMs: 5, unknown: true,
    }));
    // A file saved before Ctrl+\\ was the default keeps Ctrl+].
    assert.deepEqual(loadSettings(), { ...defaultSettings(), prefixKey: 'C-]' });
  });
});

test('monitor pane modes and worktreeRoot validate independently of legacy panel booleans', () => {
  withSettingsFile((file) => {
    fs.writeFileSync(file, JSON.stringify({
      agentsPane: 'closed', timelinePane: 'folded', changesPane: 'open', detailsPane: 'open',
      worktreeRoot: '/repo', details: true, changes: false,
    }));
    const loaded = loadSettings();
    assert.equal(loaded.agentsPane, 'closed');
    assert.equal(loaded.timelinePane, 'closed', 'folded, from an earlier version, is closed');
    assert.equal(loaded.changesPane, 'open');
    assert.equal(loaded.detailsPane, 'open');
    assert.equal(loaded.worktreeRoot, '/repo');
    assert.equal(loaded.details, true);
    assert.equal(loaded.changes, false);
    fs.writeFileSync(file, JSON.stringify({
      agentsPane: 'hidden', timelinePane: 1, changesPane: null, detailsPane: {},
      worktreeRoot: 'x\0y',
    }));
    const invalid = loadSettings();
    assert.equal(invalid.agentsPane, 'open');
    assert.equal(invalid.timelinePane, 'closed');
    assert.equal(invalid.changesPane, 'closed');
    assert.equal(invalid.detailsPane, 'closed');
    assert.equal(invalid.worktreeRoot, '');
  });
});

test('the timeline\'s style, window and roles keep to what the panel draws', () => {
  withSettingsFile((file) => {
    fs.writeFileSync(file, JSON.stringify({ timelineStyle: 'lanes', timelineHours: 12, importantRoles: 'reviewer, critic' }));
    const loaded = loadSettings();
    assert.deepEqual([loaded.timelineStyle, loaded.timelineHours, loaded.importantRoles], ['lanes', 12, 'reviewer, critic']);
    fs.writeFileSync(file, JSON.stringify({ timelineStyle: 'zigzag', timelineHours: 2, importantRoles: 'a\nb' }));
    const invalid = loadSettings();
    assert.deepEqual([invalid.timelineStyle, invalid.timelineHours, invalid.importantRoles], ['rail', 3, '']);
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
      assert.equal(loadSettings().treeWidth, 48);
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
    assert.equal(saved.treeWidth, 48);
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

test('legacy OMP settings migrate to API deterministically and task models validate', () => {
  withSettingsFile(file => {
    assert.equal(defaultSettings().briefing, 'off');
    assert.equal(defaultSettings().briefingApiBase, '');
    fs.writeFileSync(file, JSON.stringify({ briefing: 'omp', briefingApiModel: 'legacy-override', briefingApiLiteModel: 'custom-lite' }));
    const loaded = loadSettings();
    assert.equal(loaded.briefing, 'api');
    assert.equal(loaded.briefingApiModel, 'legacy-override');
    assert.equal(loaded.briefingApiLiteModel, 'custom-lite');
    assert.equal(loaded.briefingApiLowModel, 'gemini-3.8-flash-low');
    assert.equal(loaded.briefingApiMediumModel, 'gemini-3.8-flash-medium');
    const saved = saveSettings({ briefingApiLowModel: 'custom-low', briefingApiMediumModel: 'custom-medium' });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).briefing, 'api');
    assert.equal(saved.briefingApiLowModel, 'custom-low');
    assert.equal(saved.briefingApiMediumModel, 'custom-medium');
    const invalid = saveSettings({ briefingApiLiteModel: 'bad\nmodel', briefingApiLowModel: 'x'.repeat(201), briefingApiMediumModel: 42 } as unknown as Partial<HudSettings>);
    assert.equal(invalid.briefingApiLiteModel, 'custom-lite');
    assert.equal(invalid.briefingApiLowModel, 'custom-low');
    assert.equal(invalid.briefingApiMediumModel, 'custom-medium');
  });
});


test('flat card visibility and progress defaults validate independently; legacy notes are ignored', () => {
  withSettingsFile(file => {
    const cards = defaultCardVisibility();
    const defaults = defaultSettings();
    for (const [key,value] of Object.entries(cards)) assert.equal(defaults[key as keyof HudSettings],value,key);
    assert.equal(defaults.agentProgress,true);
    const booleanKeys = Object.keys(cards).filter(key => key !== 'cardSubagentScope') as Array<keyof HudSettings>;
    assert.equal(booleanKeys.length,13);
    const toggled = Object.fromEntries(booleanKeys.map(key => [key,!defaults[key]]));
    fs.writeFileSync(file,JSON.stringify({...toggled,cardSubagentScope:'all',agentProgress:false,briefAgents:true,cardNotes:5}));
    const loaded = loadSettings();
    for (const key of booleanKeys) assert.equal(loaded[key],toggled[key],key);
    assert.equal(loaded.cardSubagentScope,'all');
    assert.equal(loaded.agentProgress,false);
    assert.equal(loaded.briefAgents,true);
    assert.equal('cardNotes' in loaded,false);
    fs.writeFileSync(file,JSON.stringify({...Object.fromEntries(booleanKeys.map(key => [key,'off'])),cardSubagentScope:'finished',agentProgress:1}));
    assert.deepEqual(loadSettings(),{...defaults,prefixKey:'C-]'},'a file without a prefix keeps the old default');
    for (const scope of ['live','important','all'] as const) assert.equal(saveSettings({cardSubagentScope:scope}).cardSubagentScope,scope);
    assert.equal(saveSettings({briefAgents:false,agentProgress:true}).agentProgress,true);
    assert.equal(loadSettings().briefAgents,false);
    assert.equal('cardNotes' in JSON.parse(fs.readFileSync(file,'utf8')),false);
  });
});

test('saving display preferences retains synthetic API credentials and task routing', () => {
  withSettingsFile(file => {
    const credentials = {briefingApiKey:'synthetic-test-secret',briefingApiBase:'https://synthetic.invalid/v1',
      briefingApiModel:'synthetic-model',briefingApiLiteModel:'synthetic-lite',briefingApiLowModel:'synthetic-low',briefingApiMediumModel:'synthetic-medium',briefingApiReasoning:true};
    saveSettings(credentials);
    const saved = saveSettings({cardLabel:false,cardSummary:false,briefAgents:false,agentProgress:true});
    for (const [key,value] of Object.entries(credentials)) assert.equal(saved[key as keyof HudSettings],value,key);
    assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),saved);
    assert.deepEqual(loadSettings(),saved);
  });
});

test('the prefix: Ctrl+\\ on a fresh install, Ctrl+] kept by a file saved without one, a saved choice kept either way', () => {
  withSettingsFile((file) => {
    assert.equal(defaultSettings().prefixKey, 'C-\\');
    assert.equal(loadSettings().prefixKey, 'C-\\', 'no file: the new default');
    fs.writeFileSync(file, JSON.stringify({ theme: 'mocha' }));
    assert.equal(loadSettings().prefixKey, 'C-]', 'saved before it existed: the old default');
    // Saving something else writes the kept prefix down, so it stays.
    saveSettings({ theme: 'latte' });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).prefixKey, 'C-]');
    fs.writeFileSync(file, JSON.stringify({ prefixKey: 'C-\\' }));
    assert.equal(loadSettings().prefixKey, 'C-\\');
    fs.writeFileSync(file, JSON.stringify({ prefixKey: 'C-]' }));
    assert.equal(loadSettings().prefixKey, 'C-]');
    // A malformed prefix in a file that has one is invalid, not legacy: the default.
    fs.writeFileSync(file, JSON.stringify({ prefixKey: 'C-x' }));
    assert.equal(loadSettings().prefixKey, 'C-\\');
  });
});
