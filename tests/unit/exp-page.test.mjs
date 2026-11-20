import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultSettings, loadSettings, saveSettings } from '../../dist/settings.js';
import { knownExpProfiles, readExpConfig, readExpData, saveExpEdit } from '../../dist/collectors/exp-store.js';
import { handleMonitorInput, initialMonitorState, monitorSettings, renderMonitor } from '../../dist/render/monitor.js';
import {
  handleSettingsInput,
  renderSettingsPage,
  resetSettingsGroup,
  SETTING_ROWS,
} from '../../dist/render/settings-page.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';

const TREE = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(0) };
const NOW = Date.parse('2026-11-20T10:30:00Z');
const key = (name) => ({ type: 'key', key: name });
const plain = (frame) => frame.lines.map((line) => stripAnsi(line).trimEnd()).join('\n');
const draw = (state, expData, height = 24) =>
  renderMonitor({ tree: TREE, state, expData, width: 40, height, nowMs: NOW, modelEnabled: false });
const send = (frame, input) => handleMonitorInput(frame.state, input, { tree: TREE, frame, nowMs: NOW });
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'exp-unit-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { HOME: join(root, 'home'), HUD_HOME: join(root, 'hud'), CODEX_HOME: join(root, 'selected') };
  const profile = (dir, marker) => {
    fs.mkdirSync(dir, { recursive: true });
    if (marker) fs.writeFileSync(join(dir, marker), 'synthetic marker\n');
    return dir;
  };
  const main = profile(join(env.HOME, '.codex'), 'auth.json');
  const other = profile(join(env.HOME, '.codex-secondary'), 'config.toml');
  profile(join(env.HOME, '.codex-not-a-profile'));
  profile(join(env.HOME, 'not-codex'), 'config.toml');
  profile(env.CODEX_HOME, 'config.toml');
  return { env, main, other, dir: join(env.HUD_HOME, 'exp') };
}

function panel(f, state = { ...initialMonitorState(), mainTab: 'exp', experiments: true }) {
  const data = () => readExpData(f.env.HUD_HOME, f.env);
  const decoder = new WorkbenchInputDecoder('workboard');
  let expData = data(),
    frame = draw(state, expData);
  const press = (input) => {
    const out = send(frame, typeof input === 'string' ? key(input) : input);
    frame = draw(out.state, expData);
    if (out.action?.type === 'exp-save') {
      saveExpEdit(f.env.HUD_HOME, out.action.edit, NOW, f.env);
      expData = data();
      frame = draw({ ...out.state, expPage: { ...out.state.expPage, edit: undefined, notice: 'Saved' } }, expData);
    }
    return out.action;
  };
  const select = (id) => {
    press('home');
    for (let n = 0; n < 20 && frame.state.expPage.cursor !== id; n++) press('down');
    assert.equal(frame.state.expPage.cursor, id);
  };
  const type = (s) => {
    for (const input of decoder.push(Buffer.from(s))) press(input);
  };
  const edit = (id, value) => {
    select(id);
    press('enter');
    type(value);
    return press('enter');
  };
  return { press, select, type, edit, frame: () => frame };
}

test('Experiments is a saved Panel switch, and arrows, Tab and clicks reach EXP but digits do not', (t) => {
  const f = fixture(t);
  for (const name of ['HOME', 'HUD_HOME', 'CODEX_HOME', 'HUD_SETTINGS_PATH']) {
    const old = process.env[name];
    t.after(() => {
      if (old === undefined) delete process.env[name];
      else process.env[name] = old;
    });
    if (f.env[name]) process.env[name] = f.env[name];
    else delete process.env[name];
  }
  const settings = loadSettings();
  assert.equal(settings.experiments, false);
  const expData = readExpData(f.env.HUD_HOME, f.env);
  let frame = draw({ ...initialMonitorState(), ...monitorSettings(settings), mainTab: 'exp' }, expData);
  assert.equal(frame.state.mainTab, 'home');
  assert.equal(frame.expData, undefined);
  assert.deepEqual(
    frame.controls.filter((c) => c.kind.startsWith('board-')).map((c) => c.kind),
    ['board-home', 'board-project']
  );
  assert.equal(send(frame, key('left')).state.mainTab, 'project');

  const selected = SETTING_ROWS.findIndex((row) => row.key === 'experiments');
  assert.equal(SETTING_ROWS[selected].group, 'Panel');
  const settingsFrame = renderSettingsPage({ draft: settings, selected, offset: 0, message: '' }, 40, 24);
  assert.match(plain(settingsFrame), /Experiments\s+‹ off ›/);
  const enabled = handleSettingsInput(settingsFrame.state, key('right'), settingsFrame).state.draft;
  assert.equal(enabled.experiments, true);
  assert.equal(resetSettingsGroup(enabled, 'Panel').experiments, false);
  saveSettings(enabled);
  assert.equal(loadSettings().experiments, true);
  frame = draw({ ...initialMonitorState(), ...monitorSettings(loadSettings()) }, expData);
  const go = (input) => {
    frame = draw(send(frame, input).state, expData);
    return frame.state.mainTab;
  };
  assert.equal(go(key('right')), 'project');
  assert.equal(go(key('tab')), 'exp');
  assert.match(plain(frame), /Codex native status line/);
  const decoder = new WorkbenchInputDecoder('workboard');
  for (const input of decoder.push(Buffer.from('1234567890'))) assert.equal(go(input), 'exp');
  assert.equal(go(key('right')), 'home');
  assert.equal(go(key('shift-tab')), 'exp');
  assert.equal(go(key('left')), 'project');
  const { x, y } = frame.controls.find((c) => c.kind === 'board-exp');
  assert.equal(go({ type: 'mouse', button: 'left', x, y }), 'exp');
  assert.equal(go(key('escape')), 'home');
  assert.equal(fs.existsSync(f.dir), false, 'showing EXP does not write');
  saveSettings({ experiments: false });
  frame = draw({ ...frame.state, ...monitorSettings(loadSettings()) }, expData);
  assert.equal(
    frame.controls.some((c) => c.kind === 'board-exp'),
    false
  );
});

test('EXP edits every group, Esc drops drafts, and another project sees the same saved values', (t) => {
  const f = fixture(t);
  assert.deepEqual(knownExpProfiles(f.env), [
    { home: f.main, name: '.codex' },
    { home: f.other, name: '.codex-secondary' },
    { home: f.env.CODEX_HOME, name: 'selected' },
  ]);
  assert.throws(
    () => saveExpEdit(f.env.HUD_HOME, { field: 'binding', value: 'codex --profile other' }, NOW, f.env),
    /Invalid EXP/
  );
  assert.throws(
    () =>
      saveExpEdit(f.env.HUD_HOME, { field: 'binding', value: join(f.env.HOME, '.codex-not-a-profile') }, NOW, f.env),
    /Invalid EXP/
  );
  const p = panel(f);
  p.select(`alias:${f.other}`);
  p.press('enter');
  p.type('discard this');
  p.press('escape');
  assert.equal(fs.existsSync(f.dir), false);
  p.edit(`alias:${f.other}`, 'Second profile');
  for (const id of ['codex-enabled', 'proxy-enabled']) {
    p.select(id);
    p.press('enter');
    p.press('down');
    p.press('enter');
    assert.match(plain(p.frame()), /^Saved$/m);
  }
  p.select('binding');
  p.press('enter');
  p.press('down');
  p.press('down');
  p.press('enter');
  assert.equal(readExpConfig(f.env.HUD_HOME).proxy.profile, f.other);
  p.press('enter');
  p.press('up');
  p.press('up');
  p.press('enter');
  assert.equal(readExpConfig(f.env.HUD_HOME).proxy.profile, null);
  p.press('enter');
  p.press('down');
  p.press('down');
  p.press('enter');
  assert.equal(readExpConfig(f.env.HUD_HOME).proxy.intervalMinutes, 15);
  assert.equal(p.edit('interval', '4'), undefined);
  assert.match(plain(p.frame()), /Invalid value/);
  p.press('escape');
  p.edit('interval', '60');
  p.select('anthropic-api');
  p.press('enter');
  p.select('grant-enabled');
  p.press('enter');
  p.press('down');
  p.press('enter');
  p.edit('grant', '20');
  p.edit('renewal', '18');
  p.edit('zone', 'Asia/Shanghai');
  p.press('escape');
  p.select('openai-api');
  p.press('enter');
  p.edit('grant', '12.345678');
  const cfg = readExpConfig(f.env.HUD_HOME);
  assert.deepEqual(cfg.codex, { enabled: true, aliases: { [f.other]: 'Second profile' } });
  assert.deepEqual(cfg.proxy, { enabled: true, profile: f.other, intervalMinutes: 60 });
  assert.deepEqual(cfg.grants['anthropic-api'], {
    enabled: true,
    grantMicros: 20_000_000,
    renewalDay: 18,
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(cfg.grants['openai-api'].grantMicros, 12_345_678);
  assert.equal(cfg.grants['openai-api'].enabled, false);
  const reloaded = panel(f, {
    ...initialMonitorState(),
    mainTab: 'exp',
    experiments: true,
    projectRoot: '/synthetic/other-project',
    projectLayout: 'inbox',
    panelLayout: 'split',
  });
  assert.match(plain(reloaded.frame()), /Second profile \(\.codex-secondary\)/);
  assert.match(plain(reloaded.frame()), /60 min/);
  assert.match(plain(reloaded.frame()), /anthropic-api\s+on · not connected/);
  reloaded.select('anthropic-api');
  reloaded.press('enter');
  assert.match(plain(reloaded.frame()), /Grant per period\s+\$20\.00/);
  assert.match(plain(reloaded.frame()), /Time zone\s+Asia\/Shanghai/);
  assert.equal(fs.readFileSync(join(f.main, 'auth.json'), 'utf8'), 'synthetic marker\n');
  assert.equal(fs.readFileSync(join(f.other, 'config.toml'), 'utf8'), 'synthetic marker\n');
});

test('calibration previews before any write, cancels cleanly, then appends one private timestamped line per save', (t) => {
  const f = fixture(t);
  const p = panel(f);
  p.select('openai-api');
  p.press('enter');
  const file = join(f.dir, 'ledger-openai-api.jsonl');
  assert.equal(p.edit('calibration', '13.40'), undefined);
  assert.match(plain(p.frame()), /Old estimate → new base\nnot connected → \$13\.40/);
  p.press('escape');
  assert.equal(fs.existsSync(file), false);
  p.edit('grant', '20');
  const configFile = join(f.dir, 'config.json');
  const first = fs.statSync(configFile);
  p.edit('renewal', '30');
  const second = fs.statSync(configFile);
  assert.notEqual(second.ino, first.ino, 'config is atomically replaced');
  const before = fs.readFileSync(configFile, 'utf8');
  for (const amount of ['13.40', '0']) {
    p.edit('calibration', amount);
    assert.equal(p.press('enter')?.edit.field, 'calibration');
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines.pop(), '');
  const events = lines.map(JSON.parse);
  assert.equal(events.length, 2);
  assert.notEqual(events[0].id, events[1].id);
  assert.deepEqual(
    events.map(({ type, at, remainingMicros }) => ({ type, at, remainingMicros })),
    [
      { type: 'calibration', at: new Date(NOW).toISOString(), remainingMicros: 13_400_000 },
      { type: 'calibration', at: new Date(NOW).toISOString(), remainingMicros: 0 },
    ]
  );
  assert.equal(fs.readFileSync(configFile, 'utf8'), before);
  assert.equal(fs.existsSync(join(f.dir, 'ledger-anthropic-api.jsonl')), false);
  for (const path of [configFile, file]) assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.dir).mode & 0o777, 0o700);
});

test('40 columns in EN and ZH: both layouts show whole labels, offline data, and the calibration preview', (t) => {
  const f = fixture(t);
  const oldLanguage = setLanguage('en');
  const oldDisplay = setDisplayConfig({ theme: 'terminal', icons: 'unicode' });
  t.after(() => {
    setLanguage(oldLanguage);
    setDisplayConfig(oldDisplay);
  });
  saveExpEdit(
    f.env.HUD_HOME,
    { field: 'alias', profile: f.other, value: 'Secondary work profile for documentation' },
    NOW,
    f.env
  );
  for (const lang of ['en', 'zh'])
    for (const panelLayout of ['classic', 'split']) {
      setLanguage(lang);
      const p = panel(f, { ...initialMonitorState(), mainTab: 'exp', experiments: true, panelLayout });
      const exact = () => {
        const frame = p.frame();
        assert.equal(frame.lines.length, 24);
        for (const line of frame.lines) assert.equal(visualLength(line), 40, stripAnsi(line));
        assert.doesNotMatch(plain(frame), /…/);
        return plain(frame);
      };
      const overview = exact();
      assert.match(overview, lang === 'en' ? /Home\s+Project\s+EXP exp/ : /首页\s+项目\s+EXP 实验/);
      assert.match(overview, /Secondary work profile for\s+documentation\s+\(\.codex-secondary\)/);
      assert.match(overview, /openai-api/);
      p.select('proxy-status');
      p.press('enter');
      assert.match(exact(), lang === 'en' ? /Next attempt\s+not connected/ : /下次尝试\s+未接入/);
      p.press('escape');
      p.select('openai-api');
      p.press('enter');
      assert.match(exact(), lang === 'en' ? /Unpriced requests\s+not connected/ : /未计价请求数\s+未接入/);
      p.edit('calibration', '13.40');
      assert.match(exact(), lang === 'en' ? /Old estimate → new base/ : /旧估算 → 新基准/);
    }
});
