import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { projectFixture, onControl, onPage, plain, presetFrames, quickModelFrames, richControl, NOW, TREE, PROJECTS } from '../fixtures/project-page.mjs';
import { build } from '../../docs/design/control-tab/gen/frames.mjs';
import { handleMonitorInput } from '../../dist/render/monitor.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { readPanelPlace } from '../../dist/utils/panel-reload.js';
import { finishChain } from '../../dist/render/chain-input.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { setHarnessDisabled } from '../../dist/roles/harness-switches.js';
import { editPreset } from '../../dist/roles/role-control.js';

async function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'control-tab-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, ...await projectFixture(root) };
}
const send = (frame, key) => handleMonitorInput(frame.state, typeof key === 'string' ? { type: 'key', key } : key, { tree: TREE, frame, nowMs: NOW });
const tabClick = (frame, id) => {
  const tab = frame.controls.find((c) => c.kind === `board-${id}`);
  assert.ok(tab?.width > 0, id);
  return { type: 'mouse', button: 'left', x: tab.x + tab.width - 1, y: tab.y };
};

test('Control is the third whole tab at 40 columns, with arrows, Tab, click and separate navigation', async (t) => {
  const f = await fixture(t), data = richControl(f.data);
  for (const lang of ['en', 'zh']) for (const experiments of [false, true]) for (const panelLayout of ['classic', 'split']) {
    const draw = (state) => f.render(40, lang, state, 36, data, true, 'unicode', 'none', { projects: PROJECTS });
    let frame = draw(onPage(undefined, { experiments, panelLayout, projectCursor: 'project:page:docs', projectRoot: PROJECTS[1].root }));
    const keys = ['home', 'project', 'control', ...(experiments ? ['exp'] : [])];
    assert.deepEqual(frame.controls.filter((c) => c.kind.startsWith('board-')).map((c) => c.kind), keys.map((key) => `board-${key}`));
    frame = draw(send(frame, 'tab').state);
    assert.equal(frame.state.mainTab, 'control');
    assert.equal(frame.state.projectRoot, PROJECTS[1].root);
    assert.match(plain(frame)[0], lang === 'zh' ? /首页.*项目.*控制/ : /Home.*Project.*Control/);
    if (experiments) assert.match(plain(frame)[0], /EXP/);
    const decoder = new WorkbenchInputDecoder('workboard');
    for (const input of decoder.push(Buffer.from('1234567890'))) assert.equal(send(frame, input).state.mainTab, 'control');
    assert.equal(send(frame, 'filter').state.filterOpen, undefined, 'the Home filter is not a Control view');
    assert.deepEqual(send(frame, 'export-board').action, { type: 'export-board' });
    assert.ok(frame.lines.every((line) => visualLength(line) === 40));
    assert.equal(send(frame, 'right').state.mainTab, experiments ? 'exp' : 'home');
    assert.equal(send(frame, 'shift-tab').state.mainTab, 'project');
    const ctrl = draw(send(frame, 'end').state);
    const project = draw(send(ctrl, 'left').state);
    assert.equal(project.state.projectCursor, 'project:page:docs');
    const again = draw(send(project, tabClick(project, 'control')).state);
    assert.deepEqual(again.state.controlNav, ctrl.state.controlNav);
  }
});

test('Project hubs have no Control row; Inbox alert links to its role on the same root in both layouts', async (t) => {
  const f = await fixture(t), data = { ...richControl(f.data), ledger: [], waiting: [], tickets: [], slices: [] };
  const root = PROJECTS[1].root;
  for (const panelLayout of ['classic', 'split']) for (const projectLayout of ['timeline', 'board', 'inbox']) {
    const draw = (state, projectDisplayRoot = root) => f.render(40, 'en', state, 36, data, true, 'unicode', 'none', { projects: PROJECTS, projectDisplayRoot });
    const state = onPage(undefined, { panelLayout, projectLayout, projectRoot: root, projectCursor: 'inbox:role:pro' });
    const frame = draw(state);
    assert.ok(!frame.workboard.rows.some((r) => r.item === 'project:page:control'));
    if (projectLayout !== 'inbox') continue;
    assert.deepEqual(send(frame, 'open-session').action, { type: 'open-files', files: ['/synthetic/default/roles/pro.json'] });
    const next = send(frame, 'enter');
    assert.equal(next.action, undefined);
    assert.equal(next.state.mainTab, 'control');
    assert.equal(next.state.projectRoot, root);
    assert.equal(draw(next.state).state.controlNav.projectCursor, 'project:role:pro');
    assert.equal(send(draw(state, PROJECTS[0].root), 'enter').state.mainTab, 'project', 'no stale-root alert opens on the new root');
  }
});

test('legacy Project/control continuation returns to the selected role on Control, in Classic and Split', async (t) => {
  const f = await fixture(t), data = richControl(f.data);
  for (const panelLayout of ['classic', 'split']) {
    const projectCursor = 'project:role:reviewer:0';
    process.env.HUD_PANEL_RELOAD_PLACE = JSON.stringify({ state: onPage('control', { panelLayout, projectRoot: PROJECTS[1].root, projectCursor }) },
      (_k, value) => value instanceof Set ? { panelSet: [...value] } : value);
    const place = readPanelPlace();
    assert.equal(place.state.mainTab, 'control');
    assert.equal(place.state.projectPage, undefined);
    assert.equal(place.state.projectRoot, PROJECTS[1].root);
    assert.equal(f.render(40, 'en', place.state, 36, data).state.controlNav.projectCursor, 'project:role:reviewer');
  }
});

test('Harnesses keys, click targets and 40-cell rows in Classic and Split, in EN and ZH', async (t) => {
  const f = await fixture(t);
  for (const name of ['agy', 'herdr', 'claude']) {
    const path = join(f.root, 'bin', name);
    f.put(path, '#!/bin/sh\nexit 99\n');
    fs.chmodSync(path, 0o700);
  }
  const run = [{ harness: 'pi', model: 'xai/grok-4.7', thinking: 'high' }, { harness: 'cli', agent: 'agy', model: 'gemini-4-hydrogen-high' },
    { harness: 'pi', model: 'synthetic/unseen' }];
  f.put(join(f.hud, 'roles/imp.json'), { role: 'imp', instructions: 'implementer', can_continue: true, run, presets: [{ name: 'daily', run }] });
  f.put(join(f.hud, 'display/model-lists.json'), { version: 1, fetchedAt: NOW, pi: ['openai/gpt-6.1-sol', 'xai/grok-4.7', 'anthropic/opus'] });
  const caption = (frame) => plain(frame).join('\n');
  const click = (frame, kind) => {
    const c = frame.controls.find((c) => c.kind === kind);
    assert.ok(c, kind);
    return { type: 'mouse', button: 'left', x: c.x, y: c.y };
  };
  for (const panelLayout of ['classic', 'split']) for (const lang of ['en', 'zh']) {
    f.put(join(f.hud, 'harnesses.json'), { disabled: ['cli:grok', 'pi:xai'] });
    const data = await f.collector.collect('control', f.board, NOW);
    const roles = { projectCursor: 'project:role:imp' };
    const draw = (state) => {
      const frame = f.render(40, lang, state, 38, data, true, 'unicode', 'none', { projectName: 'harbor-api', experiments: true });
      assert.ok(frame.lines.every((line) => visualLength(line) === 40));
      return frame;
    };
    const decoder = new WorkbenchInputDecoder('workboard');
    const h = decoder.push(Buffer.from('h'))[0];
    const classic = panelLayout === 'classic', zh = lang === 'zh';
    let frame = draw(send(draw(onControl(roles, { panelLayout, experiments: true })), h).state);
    assert.equal(frame.state.mainTab, 'control');
    assert.equal(frame.state.controlHarnesses, true);
    assert.match(caption(frame), zh ? /本机 · 所有项目/ : /This machine · all projects/);
    assert.match(caption(frame), /^  ◉ pi$/m);
    assert.match(caption(frame), /^  ◉ jev-ask  chatgpt gemini$/m);
    assert.match(caption(frame), /^  ◉ openai$/m);
    assert.match(caption(frame), zh ? /^  ◉ codex +未安装$/m : /^  ◉ codex +not installed$/m);
    assert.match(caption(frame), zh ? /^  ◉ synthetic +未见$/m : /^  ◉ synthetic +not seen$/m);
    assert.match(caption(frame), zh ? /▸ 已停用.*2/ : /▸ Off.*2/);
    assert.doesNotMatch(caption(frame), /cli:grok|pi:xai/);
    if (!classic) assert.match(caption(frame), zh ? /^状态 +已启用 · 已安装$/m : /^state +on · installed$/m);
    if (process.env.HUD_HARNESS_REPORT_FRAMES && zh) console.log(`${panelLayout} folded:\n${frame.lines.map(stripAnsi).join('\n')}`);
    frame = draw(send(frame, 'end').state);
    if (!classic) {
      const preview = frame.panes.find((p) => p.id === 'preview');
      assert.match(plain(frame)[preview.y - 1], zh ? /^已停用 ─+ 2$/ : /^Off ─+ 2$/);
      assert.match(plain(frame)[preview.y], zh ? /^  ⊘ cli:grok +未安装$/ : /^  ⊘ cli:grok +not installed$/);
      assert.equal(plain(frame)[preview.y + 1], '  ⊘ pi:xai');
      const clickPreview = send(frame, { type: 'mouse', button: 'left', x: 4, y: preview.y });
      assert.equal(clickPreview.action, undefined);
      assert.equal(clickPreview.state.controlHarnessNav.projectCursor, 'project:fold:harness-off');
    }
    frame = draw(send(frame, 'enter').state);
    assert.match(caption(frame), /⊘ cli:grok[\s\S]*⊘ pi:xai/);
    frame = draw(send(frame, 'end').state);
    if (process.env.HUD_HARNESS_REPORT_FRAMES && zh) console.log(`${panelLayout} expanded:\n${frame.lines.map(stripAnsi).join('\n')}`);
    assert.equal(send(frame, 'place-remove').action, undefined, 'Del does not restore an off item');
    assert.deepEqual(send(frame, 'enter').action, { type: 'harness-switch', id: 'pi:xai', off: false });
    frame = draw(send(frame, click(frame, 'harness-add')).state);
    assert.match(caption(frame), zh ? /添加回/ : /Add back/);
    for (const input of decoder.push(Buffer.from('qjk7'))) frame = draw(send(frame, input).state);
    assert.equal(frame.state.controlHarnessAdd.text, 'qjk7');
    assert.match(caption(frame), zh ? /没有匹配/ : /No matching switches/);
    assert.equal(send(frame, 'enter').action, undefined);
    // Cancel restores the list. Backspacing and filtering never start discovery or a write.
    frame = draw(send(frame, 'escape').state);
    const cursor = frame.state.controlHarnessNav.projectCursor;
    frame = draw(send(frame, 'place-add').state);
    for (const input of decoder.push(Buffer.from('xaz\x7fi'))) frame = draw(send(frame, input).state);
    assert.equal(frame.state.controlHarnessAdd.text, 'xai');
    assert.deepEqual(send(frame, 'enter').action, { type: 'harness-switch', id: 'pi:xai', off: false });
    frame = draw(send(frame, 'escape').state);
    assert.equal(frame.state.controlHarnessNav.projectCursor, cursor);
    frame = draw(send(frame, click(frame, 'control-roles')).state);
    assert.match(caption(frame), /imp \[daily\] → agy/);
    frame = draw(send(frame, click(frame, 'control-harnesses')).state);
    frame = draw(send(frame, 'home').state);
    const pane = frame.panes.find((p) => p.id === 'agents');
    const item = pane.rows.findIndex((r) => r.item === 'control:harness:pi');
    const rowClick = { type: 'mouse', button: 'left', x: 3, y: pane.y + item - pane.offset };
    assert.deepEqual(send(frame, rowClick).action, { type: 'harness-switch', id: 'pi', off: true });
    assert.deepEqual(send(frame, 'place-remove').action, { type: 'harness-switch', id: 'pi', off: true });
    setHarnessDisabled(f.hud, 'pi', true);
    f.collector.refreshRoles(data, NOW);
    frame = draw(frame.state);
    assert.match(caption(frame), zh ? /pi 已停用/ : /pi off/);
    assert.ok(data.harnessSwitches.find((s) => s.id === 'pi:xai').off);
    assert.equal(data.harnessSwitches.find((s) => s.id === 'pi:openai').off, false);
    setHarnessDisabled(f.hud, 'pi:lost', true);
    f.collector.refreshRoles(data, NOW);
    frame = draw(send(frame, 'place-add').state);
    for (const input of decoder.push(Buffer.from('lost'))) frame = draw(send(frame, input).state);
    assert.match(caption(frame), zh ? /pi:lost +未见/ : /pi:lost +not seen/);
    assert.deepEqual(send(frame, 'enter').action, { type: 'harness-switch', id: 'pi:lost', off: false });
  }
});

test('40-column preset row, successful switch and chooser text match the sample in both languages', async (t) => {
  const f = await fixture(t), rendered = presetFrames(f, richControl(f.data));
  for (const lang of ['en', 'zh']) {
    const sample = (id) => build(lang).frames.find((frame) => frame.id === id).frame.rows.map((r) => r.segs.map((s) => s.t).join('').trimEnd());
    const role = /^  ◉ imp \[/;
    const listEntry = /^ *(?:◉ )?(?:default |grok |daily |file chain |文件链 )+.*→/;
    const list = (rows) => rows.filter((line) => line.startsWith('/ ') || listEntry.test(line));
    const wanted = list(sample('4c').map((row) => row.replace(/(?:Custom|自定义) +→ (\S+) +(?:file chain|文件链)$/, lang === 'en' ? 'file chain → $1' : '文件链    → $1')));
    for (const layout of ['classic', 'split']) {
      assert.equal(rendered[`preset-row-40-${layout}-${lang}`].find((line) => role.test(line)), '  ◉ imp [daily] → xai/grok-4.7');
      assert.deepEqual(list(rendered[`preset-list-40-${layout}-${lang}`]), wanted);
    }
    const switched = rendered[`preset-switched-40-split-${lang}`];
    assert.ok(switched.includes('  ◉ imp → openai/gpt-6.1-sol'));
    assert.ok(switched.includes(lang === 'en' ? '✓ imp · preset applied' : '✓ imp · 已应用预设'));
  }
});

test('quick model role, picker and saved notice fit in both layouts and languages', async (t) => {
  const f = await fixture(t), frames = quickModelFrames(f, richControl(f.data));
  for (const width of [40, 120]) for (const layout of ['split', 'classic']) for (const lang of ['en', 'zh']) {
    const frame = (id) => frames[`quick-model-${id}-${width}-${layout}-${lang}`];
    const zh = lang === 'zh';
    for (const id of ['row', 'picker', 'saved']) assert.ok(frame(id).every((line) => visualLength(line) === width));
    assert.match(frame('row').join('\n'), /^  ◉ imp \[daily\] → xai\/grok-4.7 *$/m);
    assert.match(frame('row').join('\n'), /^  ◉ reviewer → mistral\/mistral-small-4 *$/m);
    assert.match(frame('row').at(-1), zh ? /^ *m 模型/ : /^ *m model/);
    assert.match(frame('picker').join('\n'), width < 100 ? /^› ◉ xai\/grok-4\.7 *$/m : /^› ◉ xai\/grok-4\.7 +[^│]*│/m);
    assert.match(frame('saved').join('\n'), zh ? /^✓ imp 第 1 位 → xai\/grok-4.7-fast *$/m : /^✓ imp #1 → xai\/grok-4.7-fast *$/m);
    assert.match(frame('saved').join('\n'), /^  ◉ imp \[daily\] → xai\/grok-4.7-fast *$/m);
    if (layout === 'split') {
      assert.match(frame('row').join('\n'), /^(?:Chain|备选链) ─+ 3\n  1 ◉ pi\/xai/m);
      assert.doesNotMatch(frame('row').join('\n'), /^(?:next job|下个任务|model +xai|模型 +xai|thinking +high|思考 +high)|click ▾ or press m|点 ▾ 或按 m/m);
    }
  }
});

test('project role at 40 columns shows source and lock, with open but no preset controls', async (t) => {
  const f = await fixture(t), data = richControl(f.data);
  for (const panelLayout of ['classic', 'split']) for (const lang of ['en', 'zh']) {
    const state = onControl({ projectCursor: 'project:role:frontend' }, { panelLayout,
      controlChain: { role: data.roles.find((r) => r.role === 'frontend'), at: 0 } });
    const frame = f.render(40, lang, state, 34, data);
    assert.ok(frame.lines.every((line) => visualLength(line) === 40));
    const content = plain(frame).join('\n');
    assert.match(content, lang === 'en' ? /source +project/ : /来源 +项目/);
    assert.match(content, lang === 'en' ? /pinned +project file · read-only here/ : /锁定 +项目文件 · 这里只读/);
    assert.ok(!frame.controls.some((c) => c.kind.startsWith('preset-')));
    const open = frame.controls.find((c) => c.kind === 'control-open-file');
    assert.ok(open);
    assert.deepEqual(send(frame, { type: 'mouse', button: 'left', x: open.x, y: open.y }).action,
      { type: 'open-files', files: ['/synthetic/project/roles/frontend.json'] });
  }
});

test('role preset sheets: filter, copy, rename and preview deletion in EN/ZH, Classic and Split', async (t) => {
  const f = await fixture(t), file = join(f.hud, 'roles/imp.json'), cursor = 'project:role:imp';
  const run = [{ harness: 'pi', model: 'openai/gpt-6.1-sol' }];
  const chain = [{ harness: 'pi', model: 'xai/grok-4.7', thinking: 'high', pi_args: ['--verbose'] }];
  const original = { role: 'imp', instructions: 'implementer', can_continue: true, run, active_preset: 'daily',
    presets: [{ name: 'daily', run: chain }] };
  f.put(join(f.hud, 'harnesses.json'), { disabled: ['pi:xai'] });
  for (const layout of ['split', 'classic']) for (const lang of ['en', 'zh']) {
    f.put(file, original);
    const snap = await f.collector.collect('control', f.board, NOW);
    const before = fs.readFileSync(file, 'utf8'), zh = lang === 'zh';
    const draw = (state) => {
      const frame = f.render(40, lang, state, 30, snap, true, 'unicode', 'none', { projectName: 'harbor-api' });
      assert.ok(frame.lines.every((line) => visualLength(line) === 40));
      return frame;
    };
    const decoder = new WorkbenchInputDecoder('workboard');
    let frame = draw(onControl({ projectCursor: cursor }, { panelLayout: layout }));
    const text = () => plain(frame).join('\n');
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    const apply = (out) => {
      let state = out.state;
      if (out.action?.type === 'preset-edit') {
        const done = editPreset(f.hud, f.cwd, f.env, out.action);
        assert.equal(done.ok, true, JSON.stringify(done));
        f.collector.refreshRoles(snap, NOW);
        state = state.controlChain ? finishChain(state) : { ...state, controlPresetInput: undefined };
      } else assert.equal(out.action, undefined);
      frame = draw(state);
    };
    const keys = (raw) => { for (const input of decoder.push(Buffer.from(raw))) apply(send(frame, input)); };
    const click = (kind) => {
      const c = frame.controls.find((control) => control.kind === kind);
      assert.ok(c, kind);
      apply(send(frame, { type: 'mouse', button: 'left', x: c.x, y: c.y }));
    };
    assert.match(text(), zh ? /imp \[daily\] → 无/ : /imp \[daily\] → none/);
    if (layout === 'classic' && zh) {
      const rename = frame.controls.find((c) => c.kind === 'preset-rename');
      const del = frame.controls.find((c) => c.kind === 'preset-delete');
      assert.equal(plain(frame)[rename.y], '  预设  复制预设  空白预设  重命名');
      assert.equal(del.y, rename.y + 1);
      assert.equal(plain(frame)[del.y], '  删除');
      assert.equal(del.width, visualLength('删除'));
      assert.equal(send(frame, { type: 'mouse', button: 'left', x: del.x + del.width - 1, y: del.y }).state.controlPresetInput.mode, 'delete');
    }
    click('preset-list');
    assert.match(text(), zh ? /选择预设/ : /choose preset/);
    assert.match(text(), zh ? /daily +→ 无/ : /daily +→ none/);
    assert.match(text(), zh ? /文件链 +→ pi\/openai/ : /file chain +→ pi\/openai/);
    assert.match(text(), /default +→/);
    keys('qjk7\r');
    assert.match(text(), zh ? /没有匹配的预设/ : /No matching presets/);
    assert.equal(frame.state.controlPresetInput.text, 'qjk7');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    keys('\x03');
    assert.equal(frame.state.controlNav.projectCursor, cursor);
    keys('pG\x1b[F\x7f\x1b[F\r'); // printable G is text; Home/End escapes are navigation.
    assert.equal(read().active_preset, null);
    keys('pgroK\r');
    assert.equal(read().active_preset, 'grok', 'the all-off named chain can be chosen');
    keys('NNO!\r');
    assert.match(text(), zh ? /预设名无效/ : /bad preset name/);
    keys('\x03');
    keys('Ndaily\r');
    assert.match(text(), zh ? /预设名称已存在/ : /preset name already exists/);
    keys('\x03');
    keys('Nqjk7\r');
    assert.match(text(), zh ? /未保存/ : /Not saved/);
    assert.equal(read().active_preset, 'grok');
    keys('s');
    assert.equal(read().active_preset, 'qjk7');
    keys('Rnight\r');
    assert.equal(read().active_preset, 'night');
    keys('D');
    assert.match(text(), zh ? /删除 night？[\s\S]*下次使用文件链/ : /Delete night\?[\s\S]*Use file chain next/);
    assert.match(text(), /^→ pi\/openai$/m);
    assert.equal(read().active_preset, 'night');
    keys('\x03');
    keys('D\r');
    assert.equal(read().active_preset, null);
    assert.deepEqual(read().run, run);
    assert.deepEqual(read().presets, original.presets);
    assert.equal(frame.state.controlNav.projectCursor, cursor);
    keys('pdefault\r');
    assert.equal(read().active_preset, 'default');
  }
});

test('live panel: no discovery on Home or Project, Control reads only the displayed root, r refreshes', async (t) => {
  const f = await fixture(t), other = join(f.root, 'other-project'), own = f.cwd;
  const gate = join(f.root, 'released'), collects = join(f.root, 'collects'), probes = join(f.root, 'probes');
  f.put(join(f.hud, 'projects.json'), { version: 1, projects: [{ root: own }, { root: other }] });
  for (const [root, role] of [[own, 'own-role'], [other, 'other-role']]) {
    f.put(join(root, '.hud/project.json'), { version: 1, roles: [role] });
    f.put(join(root, `.hud/roles/${role}.json`), { role, harness: 'pi', pi_role: 'implementer', model: 'demo/model' });
  }
  f.put(join(other, 'STATE.md'), '# Other\n\n## Waiting for the owner\n\n- Only other root waits');
  f.put(join(f.hud, 'hud-settings.json'), { modelEnabled: false, refreshMs: 250, language: 'en', theme: 'none' });
  fs.writeFileSync(join(f.root, 'bin/pi'), `#!/bin/sh\nprintf 'pi\n' >> '${probes}'\nprintf 'provider model\ndemo model\n'\n`, { mode: 0o700 });
  // Hold back the new root's first Control read so we can examine the intervening frame.
  const runner = join(f.root, 'live.mjs');
  fs.writeFileSync(runner, `
    import fs from 'node:fs';
    import { ProjectCollector } from ${JSON.stringify(new URL('../../dist/collectors/project-board.js', import.meta.url).href)};
    import { runLivePage } from ${JSON.stringify(new URL('../../dist/tree-page.js', import.meta.url).href)};
    Object.defineProperties(process.stdout, { columns: { value: 40 }, rows: { value: 38 } });
    const collect = ProjectCollector.prototype.collect;
    ProjectCollector.prototype.collect = async function(mode, ...args) {
      if (mode === 'control' && this.cwd === ${JSON.stringify(other)}) {
        while (!fs.existsSync(${JSON.stringify(gate)})) await new Promise(r => setTimeout(r, 15));
      }
      const result = await collect.call(this, mode, ...args);
      if (mode) fs.appendFileSync(${JSON.stringify(collects)}, JSON.stringify([mode, this.cwd, !!result.git, result.tickets.length, result.waiting.length]) + '\\n');
      return result;
    };
    await runLivePage();
    process.exit(0);
  `);
  const child = spawn(process.execPath, [runner], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...f.env, CODEX_HUD_CWD: own, CODEX_HUD_STANDALONE_PANEL: '1' } });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', (b) => { stdout += b; });
  child.stderr.on('data', (b) => { stderr += b; });
  const calls = () => fs.existsSync(collects) ? fs.readFileSync(collects, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const count = () => fs.existsSync(probes) ? fs.readFileSync(probes, 'utf8').match(/pi/g)?.length ?? 0 : 0;
  const wait = async (predicate, what) => {
    for (const until = Date.now() + 10000; Date.now() < until && child.exitCode === null; await new Promise((r) => setTimeout(r, 20))) if (predicate()) return;
    assert.fail(`${what}: ${stderr}\n${stripAnsi(stdout).slice(-1500)}`);
  };
  await wait(() => calls().some(([mode]) => mode === 'home' || mode === 'home-tasks'), 'Home collected');
  child.stdin.write('r\t'); // Home r, then Project
  await wait(() => calls().some(([mode]) => mode === true), 'Project collected');
  child.stdin.write(']r'); // select the other project while on Project
  await wait(() => calls().some(([mode, root]) => mode === true && root === other), 'other Project collected');
  assert.equal(count(), 0);
  const before = stdout.length;
  child.stdin.write('\t'); // Control follows that Project root; the narrow read is held back
  await wait(() => /Loading/.test(stripAnsi(stdout.slice(before))) && count() === 1, 'Control loading (discovery started)');
  assert.doesNotMatch(stripAnsi(stdout.slice(before)), /own-role|other-role/);
  f.put(gate, 'go');
  await wait(() => /other-role/.test(stripAnsi(stdout.slice(before))), 'other role displayed');
  assert.deepEqual(calls().filter(([mode]) => mode === 'control').at(-1), ['control', other, false, 0, 0]);
  await wait(() => fs.existsSync(join(f.hud, 'display/model-lists.json')), 'first discovery finished');
  child.stdin.write('r');
  await wait(() => count() === 2, 'Control r refreshed discovery');
  const switches = join(f.hud, 'harnesses.json'), role = join(other, '.hud/roles/other-role.json');
  const roleBytes = fs.readFileSync(role);
  assert.equal(fs.existsSync(switches), false, 'opening Control and refreshing do not write switches');
  const disabled = () => fs.existsSync(switches) ? JSON.parse(fs.readFileSync(switches, 'utf8')).disabled : [];
  child.stdin.write('h\x1b[Fk '); // Harnesses, Off fold, previous row (pi:demo), Space
  await wait(() => disabled().includes('pi:demo'), 'provider was disabled from the panel');
  assert.equal(fs.statSync(switches).mode & 0o777, 0o600);
  child.stdin.write('idemo\n');
  await wait(() => !disabled().includes('pi:demo'), 'Add back restored provider from the panel');
  assert.deepEqual(fs.readFileSync(role), roleBytes, 'project role stays byte-identical');
  assert.equal(count(), 2, 'Harnesses and Add back did not run discovery');
  child.stdin.write('h');
  const left = stdout.length;
  child.stdin.write('['); // Control can change the same choice without leaving
  await wait(() => /own-role/.test(stripAnsi(stdout.slice(left))), 'own role displayed');
  assert.deepEqual(calls().filter(([mode]) => mode === 'control').at(-1), ['control', own, false, 0, 0]);
  child.stdin.write(']');
  await wait(() => calls().filter(([mode]) => mode === 'control').at(-1)?.[1] === other, 'back on the other root');
  const n = calls().length;
  child.stdin.write('\t'); // wrap Control -> Home while Project still points to the other root
  await wait(() => calls().slice(n).some(([mode, root]) => (mode === 'home' || mode === 'home-tasks') && root === own), 'Home still collects its own project');
  assert.equal(count(), 2);
  child.stdin.write('q');
  assert.deepEqual(await once(child, 'exit'), [0, null]);
});
