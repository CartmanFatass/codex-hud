import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitFixture, split } from '../fixtures/split-layout.mjs';
import { NOW, TREE, PROJECTS, onPage, onControl } from '../fixtures/project-page.mjs';
import { handleMonitorInput } from '../../dist/render/monitor.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { renderSettingsPage } from '../../dist/render/settings-page.js';
import { defaultSettings } from '../../dist/settings.js';
import { defaultExpConfig } from '../../dist/exp-config.js';

// Literal footers from the 40-cell design, without the leading alignment spaces.
const narrow = {
  'split Home job': ['✓ 1    g job tab  X stop  ⏎ open  ? help', '✓ 1     g 任务页  X 停止  ⏎ 打开  ? 帮助'],
  'split Home block': ['✓ 5      ⏎ open  / filter  a all  ? help', '✓ 5       ⏎ 打开  / 筛选  a 全部  ? 帮助'],
  'classic Home card': ['✓ 3  ⏎ expand  o file  v inspect  ? help', '✓ 3       ⏎ 展开  o 文件  v 详情  ? 帮助'],
  'split Project hub': ['Space mark  y accept  n flag  ? help', 'Space 勾选  y 验收  n 标记  ? 帮助'],
  'classic Project hub': ['⏎ open  ? help', '⏎ 打开  ? 帮助'],
  'classic Project switch': ['⏎ open  [ ] project  ? help', '⏎ 打开  [ ] 项目  ? 帮助'],
  'classic Progress': ['t to try  ⏎ open  Esc back  ? help', 't 待试用  ⏎ 打开  Esc 返回  ? 帮助'],
  'split Progress': ['⏎ open file  Esc back  / filter  ? help', '⏎ 打开文件  Esc 返回  / 筛选  ? 帮助'],
  Roles: ['m model  c C preset  p presets  ? help', 'm 模型  c C 预设  p 选预设  ? 帮助'],
  Harnesses: ['Space on/off  i add back  ? help', 'Space 开关  i 添加回  h 角色  ? 帮助'],
  Inspector: ['⏎ open  Esc back  ? help', '⏎ 打开  Esc 返回  ? 帮助'],
  Settings: ['←→ change  s save  Esc back  ? help', '←→ 修改  s 保存  Esc 返回  ? 帮助'],
  EXP: ['⏎ edit  ? help', '⏎ 编辑  ? 帮助'],
};

// One spelling for each action. Contextual verbs are explicit for Enter, Space and the page toggles.
const words = [
  ['g job tab', 'g 任务页'], ['X stop', 'X 停止'], ['o file', 'o 文件'], ['v inspect', 'v 详情'],
  ['/ filter', '/ 筛选'], ['a all', 'a 全部'], ['[ ] project', '[ ] 项目'], ['? help', '? 帮助'],
  ['Space mark', 'Space 勾选'], ['y accept', 'y 验收'], ['n flag', 'n 标记'], ['t to try', 't 待试用'],
  ['⏎ open', '⏎ 打开'], ['⏎ open file', '⏎ 打开文件'], ['⏎ expand', '⏎ 展开'],
  ['⏎ chain', '⏎ 备选链'], ['⏎ edit', '⏎ 编辑'], ['Esc back', 'Esc 返回'],
  ['c C preset', 'c C 预设'], ['p presets', 'p 选预设'], ['N copy', 'N 复制'], ['I empty', 'I 空白'],
  ['h harnesses', 'h 宿主'], ['r refresh', 'r 刷新'], ['m model', 'm 模型'], ['x clear', 'x 清除'],
  ['i add', 'i 添加'], ['K J move', 'K J 移动'], ['Del remove', 'Del 删除'],
  ['Space on/off', 'Space 开关'], ['i add back', 'i 添加回'], ['h roles', 'h 角色'],
  ['←→ change', '←→ 修改'], ['s save', 's 保存'], ['r reset', 'r 重置'],
];

test('Classic and Split footers keep whole localized hints and pin Help at 40, 56, 80 and 120 columns', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'panel-footers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await splitFixture(root), role = f.control.roles.find((r) => r.role === 'imp');
  const running = f.board.workers.find((w) => w.id.endsWith('32'));
  const native = f.board.workers.find((w) => w.id === 'native-synthetic');
  const done = f.board.workers.find((w) => w.state === 'done');
  const target = (worker) => ({ kind: 'worker', workerId: worker.id, laneId: worker.laneId });
  const withDone = (n) => ({ ...f.board, workers: [...f.board.workers,
    ...Array.from({ length: n - 1 }, (_, i) => ({ ...done, id: `synthetic-settled-${i}` }))] });
  const harnessData = { ...f.control, harnessSwitches: [
    { id: 'pi', name: 'pi', group: 'runner', present: true, off: false, uses: [] },
    { id: 'pi:synthetic', name: 'synthetic', group: 'provider', present: true, off: true, uses: [] },
  ] };
  const expData = { config: defaultExpConfig(), profiles: [] };
  for (const panelLayout of ['split', 'classic']) for (const [i, lang] of ['en', 'zh'].entries()) for (const width of [40, 56, 80, 120]) {
    const layout = { panelLayout }, state = split(layout), draw = (s, snapshot, extra) => f.render(width, lang, 50, s, snapshot, extra);
    const page = (p, extra = {}) => onPage(p, { ...layout, ...extra });
    const harnesses = onControl(undefined, { ...layout, controlHarnesses: true });
    const exp = { ...state, mainTab: 'exp', experiments: true };
    const settings = () => {
      const old = setLanguage(lang);
      try { return renderSettingsPage({ draft: defaultSettings(), selected: 0, offset: 0, message: '' }, width, 50); }
      finally { setLanguage(old); }
    };
    const scenes = {
      ...(panelLayout === 'split' ? {
        'split Home job': draw({ ...state, splitCursor: JSON.stringify(['lane', running.laneId]) }),
        'split Home block': draw({ ...state, splitCursor: 'home-progress:waiting' }, f.data, { workboard: withDone(5) }),
      } : {
        'classic Home card': draw({ ...state, homeTarget: target(native) }, f.data, { workboard: withDone(3) }),
        'classic Project switch': draw(page(undefined), f.data, { projects: PROJECTS }),
      }),
      [`${panelLayout} Project hub`]: draw(page(undefined), f.control),
      [`${panelLayout} Progress`]: draw(page('progress'), f.rich),
      Tickets: draw(page('tickets')), 'Working tree': draw(page('tree')), Docs: draw(page('docs')),
      Roles: draw(onControl({ projectCursor: 'project:role:imp' }, layout), f.control),
      Chain: draw(onControl({ projectCursor: 'project:role:imp' }, { ...layout, controlChain: { role, at: 0 } }), f.control),
      Harnesses: draw(harnesses, harnessData),
      Inspector: draw({ ...state, focus: 'details', boardInspect: target(running) }),
      Settings: settings(), EXP: draw(exp, f.data, { expData }),
      Changes: draw({ ...state, focus: 'changes' }),
    };
    const word = (en) => words.find((pair) => pair[0] === en)[i];
    const help = word('? help'), known = new Set(words.map((pair) => pair[i]));
    for (const [name, frame] of Object.entries(scenes)) {
      const at = `${panelLayout}, ${name}, ${width}, ${lang}`;
      assert.ok(frame.lines.every((line) => visualLength(line) === width), at);
      const footer = stripAnsi(frame.lines.at(-1));
      assert.ok(footer.endsWith(help), `${at}: ${footer}`);
      assert.doesNotMatch(footer, /↑↓|←→ (tab|切页)|, (settings|设置)/, at);
      const hints = footer.trim().split(/ {2,}/).filter((part) => !part.startsWith('✓ '));
      assert.ok(hints.every((h) => known.has(h)), `${at}: ${hints.filter((h) => !known.has(h)).join(', ')}`);
      assert.equal(hints.length, new Set(hints.map((h) => h.split(' ')[0])).size, `${at}: duplicate key`);
      if (width === 40 && narrow[name]) {
        const exact = narrow[name][i];
        assert.equal(footer, ' '.repeat(width - visualLength(exact)) + exact, at);
      }
      if (name.includes('Home')) {
        assert.equal(footer.includes(lang === 'en' ? 'done today' : '今日完成'), width >= 56, at);
        if (name === 'split Home job' && width === 120)
          assert.deepEqual(hints, ['g job tab', 'X stop', '⏎ open', 'o file', 'v inspect', '/ filter', 'a all', '? help'].map(word), at);
      }
    }
    const harnessFrame = scenes.Harnesses, footer = stripAnsi(harnessFrame.lines.at(-1));
    for (const [kind, label] of [['harness-toggle', word('Space on/off')], ['harness-add', word('i add back')], ['help', help]]) {
      const control = harnessFrame.controls.find((c) => c.kind === kind && c.y === harnessFrame.lines.length - 1);
      assert.ok(footer.includes(label), label);
      assert.deepEqual([control?.x, control?.width], [visualLength(footer.slice(0, footer.indexOf(label))), visualLength(label)]);
      const result = handleMonitorInput(harnessFrame.state, { type: 'mouse', button: 'left', x: control.x, y: control.y }, { tree: TREE, frame: harnessFrame, nowMs: NOW });
      if (kind === 'help') assert.equal(result.state.help, true);
      else if (kind === 'harness-add') assert.ok(result.state.controlHarnessAdd);
      else assert.deepEqual(result.action, { type: 'harness-switch', id: 'pi', off: true });
    }
    const read = (frame) => stripAnsi(frame.lines.at(-1)).trim();
    assert.equal(read(draw({ ...state, help: true })), word('Esc back'));
    for (const modal of [draw({ ...state, filterOpen: true }),
      draw({ ...harnesses, controlHarnessAdd: { text: '' } }, harnessData),
      draw(onControl(undefined, { ...layout, controlPresetInput: { mode: 'list', role, text: '', at: 0 } }), f.control),
      draw({ ...exp, expPage: { cursor: 'binding', edit: { text: '', pick: 0 } } }, f.data, { expData })]) {
      assert.ok(!read(modal).includes(help), 'keyboard-owning modal');
      assert.doesNotMatch(read(modal), /↑↓|\besc\b/);
    }
  }
});

test('normal panel footers have no raw movement hints or assembled help suffixes at call sites', () => {
  const render = new URL('../../src/render/', import.meta.url);
  // The model picker owns its footer; do not require its parallel slice to have landed.
  const pickerFiles = new Set(['i18n.ts', 'model-input.ts', 'model-picker-view.ts']);
  for (const file of fs.readdirSync(render).filter((name) => name.endsWith('.ts') && !pickerFiles.has(name))) {
    const source = fs.readFileSync(new URL(file, render), 'utf8');
    assert.doesNotMatch(source, /['`"]↑↓ | {2}\? help\b(?!Rows)/, file);
  }
});
