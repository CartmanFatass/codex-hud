import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { markExhausted, placeKey } from '../../dist/roles/roster.js';
import { handleMonitorInput } from '../../dist/render/monitor.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { build } from '../../docs/design/model-picker/gen/frames.mjs';
import { modelPickerSample, onControl, projectFixture, TREE, NOW } from '../fixtures/project-page.mjs';

const send = (frame, key) => handleMonitorInput(frame.state, typeof key === 'string' ? { type: 'key', key } : key, { frame, tree: TREE, nowMs: NOW });
const click = (frame, x, y, button = 'left') => send(frame, { type: 'mouse', x, y, button });
const type = (frame, text) => send(frame, { type: 'key', key: '', text });
const cells = (frame) => frame.lines.map(stripAnsi);
const sides = (frame) => cells(frame).slice(2, -1).map((line) => line.split('│').map((s) => s.trimEnd()));
const left = (frame) => sides(frame).map(([l]) => l);
const right = (frame) => sides(frame).map(([, r]) => r ?? '').join('\n');
const yOf = (frame, re) => {
  const i = left(frame).findIndex((line) => re.test(line));
  assert.ok(i >= 0, `${re}\n${left(frame).join('\n')}`);
  return i + 2;
};
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hud-picker-pane-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return projectFixture(dir);
}

test('wide picker frames in EN/ZH: open groups, columns, exact uses, long IDs, provider off', async (t) => {
  const f = await fixture(t), sample = modelPickerSample(f);
  const dataOff = {
    ...sample.data,
    models: { ...sample.data.models, pi: sample.data.models.pi.filter((id) => !id.startsWith('xai/')), editor: { off: ['pi:xai'] } },
    harnessSwitches: [...sample.data.harnessSwitches, { id: 'pi:xai', name: 'xai', group: 'provider', off: true }],
    roles: sample.data.roles.map((r) => r.role !== 'imp' ? r : { ...r, places: r.places.map((p, i) => i === 0 ? { ...p, state: 'off' } : i === 1 ? { ...p, state: 'active' } : p) }),
  };
  for (const layout of ['split', 'classic']) for (const lang of ['en', 'zh']) {
    const zh = lang === 'zh', drawing = (state, width = 120, data = sample.data) => f.render(width, lang, state, 36, data);
    const entry = sample.draw(lang, sample.state(layout), 24), opening = send(entry, 'place-model');
    assert.ok(opening.state.projectInput);
    const picker = opening.state;
    const draw = (state, data = sample.data) => drawing(state, 120, data);
    const a = draw(picker);
    assert.equal(a.lines.length, 36);
    assert.ok(a.lines.every((line) => visualLength(line) === 120));
    assert.match(left(a).join('\n'), /^▾ anthropic ─+ 9\n +claude-opus-5-5 +500K +64K +✓ +✓/m);
    assert.match(left(a).join('\n'), /openai\/gpt-6.1-sol +1M +128K +✓ +✓ +✗/);
    assert.match(right(a), /xai\/grok-4.7/);
    assert.match(cells(a)[0], zh ? /首页.*项目.*控制/ : /Home.*Project.*Control/);
    assert.match(cells(a)[1], zh ? /模型 · imp \[daily\] 第 1 位 · pi +88 个模型 · 列表 2小时前/ : /Model · imp \[daily\] place #1 · pi +88 models · list 2h old/);
    assert.doesNotMatch(cells(a).join('\n'), /zoomed|已放大|restore|还原/);
    assert.equal(yOf(a, /^\/ /), 2);
    const boundary = drawing(picker, 100);
    assert.ok(boundary.lines.every((line) => visualLength(line) === 100));
    assert.equal(yOf(boundary, /^\/ /), 2);
    assert.match(left(boundary).join('\n'), /^▾ anthropic ─+/m);
    const narrow = drawing(picker, 99);
    assert.match(cells(narrow).join('\n'), /^▸ anthropic ─+/m);
    assert.doesNotMatch(cells(narrow)[2], /│/);
    const normalized = (line) => line.trim().replace(/ +/g, ' ');
    const modelHeader = build(lang).frames.find((frame) => frame.id === '3e').frame.rows[2].segs.map((s) => s.t).join('').split('│')[0];
    assert.equal(normalized(left(a)[1]), normalized(modelHeader));

    const b = draw(send(a, 'down').state);
    assert.match(right(b), zh ? /✗ 已耗尽 · 42分后恢复/ : /✗ exhausted · resets in 42m/);
    for (const role of ['imp +(?:#1|第 1 位)', 'reviewer \\[pi\\]', 'oracle \\[fable\\][\\s\\S]*\\[architect\\]']) assert.match(right(b), new RegExp(role));
    assert.doesNotMatch(right(b), /\[default\]/);
    assert.match(right(b), zh ? /2小时前发现/ : /discovered 2h ago/);
    const detailClick = click(b, 75, yOf(b, /openai\/gpt-6.1-sol/));
    assert.equal(detailClick.action, undefined, 'detail is not a second list');
    assert.deepEqual(detailClick.state.projectInput, b.state.projectInput);
    const picked = click(a, 5, yOf(a, /openai\/gpt-6.1-sol/));
    assert.equal(picked.action.type, 'preset-edit');
    assert.equal(picked.action.run[0].model, 'openai/gpt-6.1-sol');
    assert.equal(picked.state.controlChain.sheet, undefined);
    const wheel = draw(click(b, 2, 4, 'wheel-down').state);
    assert.notDeepEqual(left(wheel), left(b));
    assert.equal(left(wheel)[0], left(b)[0]);
    assert.match(left(wheel).join('\n'), /^› /m);
    const folded = draw(click(a, 2, yOf(a, /^▾ anthropic /)).state);
    assert.match(left(folded).join('\n'), /^▸ anthropic /m);
    assert.doesNotMatch(left(folded).join('\n'), /claude-opus-5-5/);

    const c = draw(type(a, 'grok').state);
    assert.match(left(c)[0], zh ? /8 \/ 88 个匹配/ : /8 \/ 88 matches/);
    assert.match(left(c).join('\n'), /^▾ arena [\s\S]*^▾ xai /m);
    const selected = draw(send(c, 'down').state); // arena's grok-4.7, not xai's.
    assert.match(right(selected), /arena\/grok-4.7/);
    assert.match(right(selected), /xai\/grok-4.7/);
    assert.match(right(selected), /imp \[lab\]/);
    const set = send(selected, 'enter');
    assert.equal(set.action.type, 'preset-edit');
    assert.equal(set.action.run[0].model, 'arena/grok-4.7');
    assert.equal(set.state.controlChain.sheet, undefined);
    assert.equal(set.state.projectInput, undefined);
    assert.deepEqual(send(selected, 'model-refresh').action, { type: 'refresh-models' });
    const cleared = send(selected, 'escape');
    assert.equal(cleared.state.projectInput.text, '');
    assert.equal(send(draw(cleared.state), 'escape').state.projectInput, undefined);

    const d = draw(send(draw(type(a, 'maverick').state), 'down').state);
    assert.match(left(d).join('\n'), /^› +meta-llama\/.*….*-fp8 +1M +16K +– +✓/m);
    assert.equal(right(d).split('\n').slice(0, 2).map((s) => s.trim()).join(''), 'arena/meta-llama/llama-4-maverick-17b-128e-instruct-fp8');

    const pickerOff = send(sample.draw(lang, sample.state(layout), 24, dataOff), 'place-model').state;
    const allOpenOff = draw(pickerOff, dataOff);
    const groups = { anthropic: false, arena: false, google: false, mistral: false, openai: false };
    const e = draw({ ...pickerOff, projectInput: { ...pickerOff.projectInput, groups } }, dataOff);
    for (const frame of [allOpenOff, e]) {
      assert.ok(frame.lines.every((line) => visualLength(line) === 120));
      assert.match(left(frame).join('\n'), /› ◉ xai\/grok-4.7 +256K +64K +✓ +✓ +⊘/);
      assert.doesNotMatch(left(frame).join('\n'), /^[▸▾] xai /m);
      assert.match(right(frame).replace(/\n\s*/g, ' '), zh ? /这个位置被跳过：imp \[daily\] → agy/ : /this place is skipped: imp \[daily\] → agy/);
      assert.match(right(frame), zh ? /⏎ 保留 xai\/grok-4.7/ : /⏎ keeps xai\/grok-4.7/);
      assert.deepEqual([send(frame, 'enter').action, send(frame, 'enter').state.projectInput], [undefined, undefined]);
    }
    const sampleOff = build(lang).frames.find((frame) => frame.id === '3e').frame.rows.map((r) => r.segs.map((s) => s.t).join('').split('│')[0]);
    assert.deepEqual(left(e).filter((s) => /^[▸⊘/]/.test(s)).map(normalized), sampleOff.filter((s) => /^[▸⊘/]/.test(s)).map(normalized));
    if (layout === 'split' && process.env.HUD_MODEL_PICKER_REPORT_FRAMES)
      for (const [width, frame] of [[100, boundary], [120, a]]) console.log(`${lang} ${width}×36\n${cells(frame).join('\n')}`);
  }
});

test('live picker paints wide immediately and never asks herdr to zoom or restore', { timeout: 10000 }, async (t) => {
  const f = await fixture(t), log = join(f.cwd, 'herdr-log');
  f.put(join(f.hud, 'hud-settings.json'), { language: 'en', modelEnabled: false, theme: 'none', panelLayout: 'classic' });
  const exhausted = { harness: 'pi', pi_role: 'implementer', model: 'synthetic/exhausted' };
  markExhausted(f.hud, placeKey(exhausted), 'quota exceeded', Date.now());
  f.put(join(f.hud, 'roles/imp.json'), { role: 'imp', can_continue: true, hidden_presets: ['default', 'grok', 'hydrogen'], run: [
    exhausted, { harness: 'pi', pi_role: 'implementer', model: 'synthetic/current' },
  ] });
  f.put(join(f.hud, 'display/model-lists.json'), { version: 1, fetchedAt: Date.now(), pi: ['synthetic/current', 'synthetic/next'] });
  const herdr = join(f.env.PATH, 'herdr');
  f.put(herdr, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\n` +
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');\nprocess.exitCode = 97;\n`);
  chmodSync(herdr, 0o700);
  const state = onControl({ projectCursor: 'project:role:imp' });
  const place = JSON.stringify({ state, settings: null }, (_k, v) => v instanceof Set ? { panelSet: [...v] } : v);
  const entry = pathToFileURL(resolve('dist/tree-page.js')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `process.stdout.columns = 120; process.stdout.rows = 36; await (await import(${JSON.stringify(entry)})).runLivePage();`], {
    cwd: f.cwd, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...f.env, PATH: `${f.env.PATH}:${dirname(process.execPath)}`, HERDR_PANE_ID: 'w4E:p2', HERDR_SOCKET_PATH: join(f.cwd, 'fake.sock'),
      HUD_PANEL_RELOAD_PLACE: place, CODEX_HUD_STANDALONE_PANEL: '1' },
  });
  let output = '', stderr = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const waitFor = async (re) => {
    for (let i = 0; i < 200 && child.exitCode === null; i++) {
      if (re.test(stripAnsi(output))) return;
      await delay(20);
    }
    assert.fail(`missing ${re}: ${stderr}\n${stripAnsi(output)}`);
  };
  await waitFor(/imp → synthetic\/current/);
  output = '';
  child.stdin.write('m');
  await waitFor(/2 models · list .* old[\s\S]*│/);
  assert.doesNotMatch(stripAnsi(output), /imp #2 ─/, 'the first update is already wide');
  output = '';
  child.stdin.write('next');
  await waitFor(/1 \/ 2 matches[\s\S]*› +next/);
  child.stdin.write('\x1b[<0;5;6M');
  await waitFor(/✓ imp #2 → synthetic\/next/);
  assert.doesNotMatch(stripAnsi(output), /Edit place|Not saved/);
  const role = JSON.parse(readFileSync(join(f.hud, 'roles/imp.json'), 'utf8'));
  assert.deepEqual(role.run[0], exhausted);
  assert.equal(role.run[1].model, 'synthetic/next');
  output = '';
  child.stdin.write('m');
  await waitFor(/2 models · list .* old/);
  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  // The panel's background job observation is independent of the picker.
  for (const args of calls) assert.deepEqual(args, ['agent', 'list', '--json']);
});
