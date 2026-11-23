import { withState } from '../fixtures/state-helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSettings } from '../../dist/settings.js';
import { knownExpProfiles, readExpConfig, readExpData, saveExpEdit } from '../../dist/collectors/exp-store.js';
import { appendExpEvent } from '../../dist/collectors/exp-ledger.js';
import { handleMonitorInput, initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { SETTING_ROWS } from '../../dist/render/settings-page.js';
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

const onResources = (patch) => {
  const base = initialMonitorState();
  return withState(base, { activeTab: 'control', control: { ...base.control, subTab: 'resources' } }, patch);
};

function panel(f, state = onResources()) {
  const data = () => readExpData(f.env.HUD_HOME, f.env, NOW);
  const decoder = new WorkbenchInputDecoder('workboard');
  let expData = data(),
    frame = draw(state, expData);
  const press = (input) => {
    const out = send(frame, typeof input === 'string' ? key(input) : input);
    frame = draw(out.state, expData);
    if (out.action?.type === 'exp-save') {
      const saved = () => {
        expData = data();
        frame = draw({ ...out.state, overlay: undefined, exp: { ...out.state.exp, notice: 'Saved' } }, expData);
        return out.action;
      };
      const pending = saveExpEdit(f.env.HUD_HOME, out.action.edit, NOW, f.env);
      return pending ? pending.then(saved) : saved();
    }
    return out.action;
  };
  const select = (id) => {
    press('home');
    for (let n = 0; n < 20 && frame.state.exp.cursor !== id; n++) press('down');
    assert.equal(frame.state.exp.cursor, id);
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

test('Control Resources returns to its detail and cursor after visiting another main tab', (t) => {
  const f = fixture(t), expData = readExpData(f.env.HUD_HOME, f.env, NOW);
  const state = onResources({ exp: { detail: 'openai-api', cursor: 'calibration', scroll: 0 } });
  const before = draw(state, expData);
  const project = draw(send(before, key('shift-tab')).state, expData);
  assert.equal(project.state.activeTab, 'project');
  const after = draw(send(project, key('tab')).state, expData);
  assert.deepEqual(after.state.exp, before.state.exp);
  assert.deepEqual(after.lines, before.lines);
  const edit = send(after, key('enter'));
  assert.equal(edit.state.overlay?.kind, 'exp-edit');
  assert.equal(edit.state.overlay.entryId, 'calibration');
});

test('legacy Experiments settings add no tab; keyboard and mouse open Control Resources', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.env.HUD_HOME);
  const path = join(f.env.HUD_HOME, 'hud-settings.json');
  const legacy = JSON.stringify({ experiments: true });
  fs.writeFileSync(path, legacy);
  const settings = loadSettings(f.env);
  assert.equal(settings.experiments, undefined);
  assert.ok(!SETTING_ROWS.some((row) => row.key === 'experiments'));
  const expData = readExpData(f.env.HUD_HOME, f.env);
  let frame = draw(initialMonitorState(), expData);
  const go = (input) => { frame = draw(send(frame, input).state, expData); };
  const press = (name) => go(key(name));
  assert.deepEqual(frame.controls.filter((c) => c.y === 0 && c.kind.startsWith('board-')).map((c) => c.kind),
    ['board-home', 'board-project', 'board-control']);
  assert.equal(frame.expData, undefined);
  press('shift-tab');
  assert.equal(frame.state.activeTab, 'control');
  const h = new WorkbenchInputDecoder('workboard').push(Buffer.from('h'))[0];
  for (const view of ['harnesses', 'resources', 'roles']) {
    go(h);
    assert.equal(frame.state.control.subTab, view);
  }
  const { x, y } = frame.controls.find((c) => c.kind === 'control-resources');
  go({ type: 'mouse', button: 'left', x, y });
  assert.equal(frame.state.control.subTab, 'resources');
  assert.match(plain(frame), /Track native status line\s+off/);
  assert.equal(fs.existsSync(f.dir), false, 'showing Resources does not write');
  assert.equal(fs.readFileSync(path, 'utf8'), legacy);
  press('tab');
  assert.equal(frame.state.activeTab, 'home');
});

test('Resources edits every group, Esc drops drafts, and another project sees the same saved values', (t) => {
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
  assert.deepEqual(cfg.proxy, {
    enabled: true,
    profile: f.other,
    intervalMinutes: 60,
    bindingVersion: cfg.proxy.bindingVersion,
  });
  assert.match(cfg.proxy.bindingVersion, /^[a-f0-9-]{36}$/);
  assert.equal(cfg.grants['anthropic-api'].enabled, true);
  assert.equal(cfg.grants['anthropic-api'].grantMicros, 20_000_000);
  assert.equal(cfg.grants['anthropic-api'].renewalDay, 18);
  assert.equal(cfg.grants['anthropic-api'].timeZone, 'Asia/Shanghai');
  assert.ok(cfg.grants['anthropic-api'].schedule.startsAt > NOW);
  assert.equal(cfg.grants['openai-api'].grantMicros, 12_345_678);
  assert.equal(cfg.grants['openai-api'].enabled, false);
  const reloaded = panel(f, onResources({ selectedProject: '/synthetic/other-project' }));
  assert.match(plain(reloaded.frame()), /Second profile \(\.codex-secondary\)/);
  assert.match(plain(reloaded.frame()), /60 min/);
  assert.match(plain(reloaded.frame()), /anthropic-api\s+on · uncalibrated/);
  reloaded.select('anthropic-api');
  reloaded.press('enter');
  assert.match(plain(reloaded.frame()), /Grant per period\s+\$20\.00/);
  assert.match(plain(reloaded.frame()), /Time zone\s+Asia\/Shanghai/);
  assert.equal(fs.readFileSync(join(f.main, 'auth.json'), 'utf8'), 'synthetic marker\n');
  assert.equal(fs.readFileSync(join(f.other, 'config.toml'), 'utf8'), 'synthetic marker\n');
});

test('calibration previews before any write, cancels cleanly, then appends one private timestamped line per save', async (t) => {
  const f = fixture(t);
  const p = panel(f);
  p.select('openai-api');
  p.press('enter');
  const file = join(f.dir, 'ledger-openai-api.jsonl');
  assert.equal(p.edit('calibration', '13.40'), undefined);
  assert.match(plain(p.frame()), /Old estimate → new base\nuncalibrated → \$13\.40/);
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
    assert.equal((await p.press('enter'))?.edit.field, 'calibration');
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

test('40-column Resources form indents its rows and gives up blanks before sections in both languages', (t) => {
  const f = fixture(t);
  const data = readExpData(f.env.HUD_HOME, f.env, NOW);
  const expData = { ...data, profiles: data.profiles.slice(0, 1) };
  const oldLanguage = setLanguage('en');
  const oldDisplay = setDisplayConfig({ theme: 'terminal', icons: 'unicode' });
  t.after(() => {
    setLanguage(oldLanguage);
    setDisplayConfig(oldDisplay);
  });
  for (const lang of ['en', 'zh']) {
    setLanguage(lang);
    const en = lang === 'en';
    {
      const state = onResources();
      const frame = draw(state, expData);
      const lines = plain(frame).split('\n');
      assert.ok(frame.lines.every((line) => visualLength(line) === 40));
      assert.equal(lines[2], en ? 'This machine · all projects' : '本机 · 所有项目');
      assert.deepEqual([lines[3], lines[8], lines[14]], ['', '', '']);
      assert.match(lines[4], en ? /^Codex native status line ─+$/ : /^Codex 原生栏 ─+$/);
      assert.match(lines[5], en ? /^  Track native status line +off$/ : /^  记录原生状态栏 +关$/);
      assert.match(lines[6], en ? /^  \.codex +bar not seen yet$/ : /^  \.codex +尚未见到原生栏$/);
      assert.match(lines[9], en ? /^pi subscription proxy ─+$/ : /^pi 订阅代理 ─+$/);
      assert.match(lines[12], en ? /^  Interval +15 min$/ : /^  刷新间隔 +15 分$/);
      assert.match(lines[15], en ? /^API grants ─+$/ : /^API 赠额 ─+$/);
      assert.match(lines[17], en ? /^  openai-api +off · uncalibrated$/ : /^  openai-api +关 · 未校准$/);
      assert.match(lines.at(-1), en ? /⏎ edit  h roles  \? help$/ : /⏎ 编辑  h 角色  \? 帮助$/);

      const short = draw(state, expData, 17);
      assert.equal(short.lines.length, 17);
      assert.ok(short.lines.every((line) => visualLength(line) === 40));
      const compact = plain(short).split('\n');
      assert.deepEqual(compact.filter(Boolean), lines.filter(Boolean));
      assert.equal(compact.filter((line) => !line).length, 1);

      const observed = { ...expData, profiles: [{ ...expData.profiles[0], lastNativeSeenAt: NOW - 18 * 60_000 }] };
      assert.match(plain(draw(state, observed)), en ? /^  \.codex +seen 11-20 10:12$/m : /^  \.codex +已见 11-20 10:12$/m);
    }
  }
});

test('Resources options show every profile with a count and separate cursor/current marks; a second click saves', (t) => {
  const f = fixture(t);
  saveExpEdit(f.env.HUD_HOME, {
    field: 'alias', profile: f.other, value: 'Documentation Account for Model Experiments',
  }, NOW, f.env);
  const expData = readExpData(f.env.HUD_HOME, f.env, NOW);
  const oldLanguage = setLanguage('en');
  const oldDisplay = setDisplayConfig({ theme: 'terminal', icons: 'unicode' });
  t.after(() => {
    setLanguage(oldLanguage);
    setDisplayConfig(oldDisplay);
  });
  for (const lang of ['en', 'zh']) {
    setLanguage(lang);
    const en = lang === 'en';
    {
      const state = onResources({ exp: { cursor: 'binding', scroll: 0 } });
      const opened = send(draw(state, expData), key('enter'));
      assert.equal(opened.action, undefined);
      const sheet = draw(opened.state, expData, 16);
      const lines = plain(sheet).split('\n');
      assert.ok(sheet.lines.every((line) => visualLength(line) === 40));
      assert.match(lines[2], en ? /^Codex profile ─+ 4$/ : /^Codex 配置 ─+ 4$/);
      assert.deepEqual(lines.slice(3, 5), [en ? '› ◉ Unbound' : '› ◉ 未绑定', '    .codex']);
      assert.match(lines[5], /^    Documentation Account…[^…]+secondary\)$/);
      assert.equal(lines[6], '    selected');
      assert.match(lines.at(-1), en ? /⏎ save  Esc cancel$/ : /⏎ 保存  Esc 取消$/);
      const clicked = { type: 'mouse', button: 'left', x: 4, y: 5 };
      assert.equal(send(sheet, { ...clicked, y: 3 }).action, undefined, 'even the initial choice requires confirmation');
      const selected = send(sheet, clicked);
      assert.equal(selected.action, undefined, 'the first click only moves the cursor');
      const moved = draw(selected.state, expData, 16);
      assert.match(plain(moved), en ? /^  ◉ Unbound$/m : /^  ◉ 未绑定$/m);
      assert.match(plain(moved), /^›   Documentation Account…[^…]+secondary\)$/m);
      assert.deepEqual(send(moved, clicked).action, { type: 'exp-save', edit: { field: 'binding', value: f.other } });
      assert.equal(send(moved, key('escape')).state.overlay, undefined);
    }
  }

  const crowded = { ...expData, profiles: Array.from({ length: 20 }, (_, i) => ({ home: `/synthetic/profile-${i}`, name: `profile-${i}` })) };
  const state = onResources({ exp: { cursor: 'binding', scroll: 0 } });
  const sheet = draw(send(draw(state, crowded), key('enter')).state, crowded, 16);
  const wrapped = draw(send(sheet, key('up')).state, crowded, 16);
  assert.match(plain(wrapped), /^Codex 配置 ─+ 21$/m);
  assert.match(plain(wrapped), /^›   profile-19$/m);
});

test('40 columns in EN and ZH: Resources shows whole control labels, both ledgers, and the calibration preview', async (t) => {
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
  for (const [account, value] of [['anthropic-api', 8_000_000], ['openai-api', 12_750_000]]) {
    saveExpEdit(f.env.HUD_HOME, { field: 'grant-enabled', account, value: true }, NOW - 1000, f.env);
    await saveExpEdit(f.env.HUD_HOME, { field: 'calibration', account, value }, NOW - 1000, f.env);
  }
  await appendExpEvent(f.env.HUD_HOME, 'anthropic-api', {
    type: 'cost', id: 'synthetic-cost', at: new Date(NOW).toISOString(), model: 'synthetic-claude',
    tokens: { input: 10, output: 3, cacheRead: 2, cacheWrite: 5 }, source: 'priced', costMicros: 350_000,
  });
  for (const lang of ['en', 'zh']) {
      setLanguage(lang);
      const p = panel(f);
      const exact = () => {
        const frame = p.frame();
        assert.equal(frame.lines.length, 24);
        for (const line of frame.lines) assert.equal(visualLength(line), 40, stripAnsi(line));
        return plain(frame);
      };
      const overview = exact();
      assert.match(overview, lang === 'en' ? /Home\s+Project\s+Control.*\n Roles\s+Harnesses\s+Resources/ : /首页\s+项目\s+控制.*\n 角色\s+宿主\s+资源/);
      assert.match(overview, /^  Secondary wor?…[^…]+\) +(?:bar not seen yet|尚未见到原生栏)$/m);
      assert.match(overview, /anthropic-api\s+(on|开) · ≈\$7\.65\s+openai-api\s+(on|开) · ≈\$12\.75/);
      p.select('proxy-status');
      p.press('enter');
      const proxy = exact();
      assert.match(proxy, lang === 'en' ? /Next attempt\s+—/ : /下次尝试\s+—/);
      assert.doesNotMatch(proxy, /…/);
      p.press('escape');
      for (const [account, remaining, billed] of [['anthropic-api', '7.65', '0.35'], ['openai-api', '12.75', '0.00']]) {
        p.select(account);
        p.press('enter');
        const detail = exact();
        assert.ok(detail.includes(`≈$${remaining}`));
        assert.match(detail, lang === 'en' ? /Unpriced requests\s+0/ : /未计价请求数\s+0/);
        assert.doesNotMatch(detail, /…/);
        const line = detail.split('\n').find((row) => row.startsWith(lang === 'en' ? '  Billed this period' : '  本期已计费用'));
        assert.ok(line?.endsWith(`$${billed}`), line);
        p.edit('calibration', '13.40');
        const preview = exact();
        assert.match(preview, lang === 'en' ? /Old estimate → new base/ : /旧估算 → 新基准/);
        assert.ok(preview.includes(`≈$${remaining} → $13.40`));
        p.press('escape');
        p.press('escape');
      }
    }
});
