import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { modelPickerZoom } from '../../dist/cli/model-picker-zoom.js';
import { handleMonitorInput } from '../../dist/render/monitor.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { build } from '../../docs/design/model-picker/gen/frames.mjs';
import { modelPickerSample, onControl, projectFixture, TREE, NOW } from '../fixtures/project-page.mjs';

const pane = 'w4E:p2', caller = 'w4E:p1';
const on = ['pane', 'zoom', '--on', pane], off = ['pane', 'zoom', '--off', pane];
const reply = (changed, zoomed = true) => ({ ok: true, stdout: JSON.stringify({ result: { type: 'pane_zoom', zoom: {
  pane_id: pane, focused_pane_id: pane, zoomed, zoom_changed: changed, reason: !zoomed ? 'single_pane' : changed ? null : 'already_zoomed',
} } }) });
function fake(answer, inside = true) {
  const calls = [], env = { HOME: process.env.HOME, HUD_HOME: process.env.HUD_HOME, HERDR_PANE_ID: inside ? pane : undefined, HUD_PANEL_CALLER_PANE: caller };
  let repaints = 0;
  const zoom = modelPickerZoom(env, () => repaints++, async (args) => { calls.push(args); return answer(args); });
  return { zoom, calls, repaints: () => repaints };
}
const send = (frame, key) => handleMonitorInput(frame.state, typeof key === 'string' ? { type: 'key', key } : key, { frame, tree: TREE, nowMs: NOW });
const click = (frame, x, y, button = 'left') => send(frame, { type: 'mouse', x, y, button });
const type = (frame, text) => send(frame, { type: 'key', key: '', text });
const cells = (frame) => frame.lines.map(stripAnsi);
const sides = (frame) => cells(frame).slice(1, -1).map((line) => line.split('│').map((s) => s.trimEnd()));
const left = (frame) => sides(frame).map(([l]) => l);
const right = (frame) => sides(frame).map(([, r]) => r ?? '').join('\n');
const yOf = (frame, re) => {
  const i = left(frame).findIndex((line) => re.test(line));
  assert.ok(i >= 0, `${re}\n${left(frame).join('\n')}`);
  return i + 1;
};
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hud-zoom-picker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return projectFixture(dir);
}

test('Herdr zooms only the panel: owned restores, preexisting stays, refusals and no Herdr make no restore call', async () => {
  for (const [inside, answer, wide, expected] of [
    [true, reply(true), true, [on, off]],
    [true, reply(false), true, [on]],
    [true, { ok: false }, false, [on]],
    [true, reply(false, false), false, [on]],
    [true, { ok: true, stdout: '{' }, false, [on]],
    [false, undefined, false, []],
  ]) {
    const { zoom, calls, repaints } = fake(() => answer, inside);
    zoom.open();
    assert.equal(zoom.zoomed, false, 'paint narrow while the asynchronous request is outstanding');
    await nextTurn();
    assert.equal(zoom.zoomed, wide);
    assert.equal(repaints(), Number(wide), 'no repeated repaint for a refusal');
    await zoom.close();
    await zoom.close();
    assert.equal(zoom.zoomed, false);
    assert.deepEqual(calls, expected);
  }
});

test('closing during delayed --on does not wait in input; restore precedes a subsequent opening', async () => {
  const pending = Promise.withResolvers();
  const { zoom, calls, repaints } = fake((args) => args[2] === '--off' ? reply(false, false) : pending.promise);
  zoom.open();
  await nextTurn();
  assert.deepEqual(calls, [on]);
  const restoring = zoom.close(); // Not awaited by input.
  zoom.open();
  await nextTurn();
  assert.deepEqual(calls, [on]);
  assert.equal(zoom.zoomed, false);
  pending.resolve(reply(true));
  await restoring;
  await nextTurn();
  assert.deepEqual(calls, [on, off, on]);
  assert.equal(repaints(), 1, 'a reply for the closed picker must not paint it');
  assert.equal(zoom.zoomed, true);
  await zoom.close();
  assert.deepEqual(calls, [on, off, on, off]);
});

test('120×36 zoom frames follow the sample in EN/ZH: open groups, columns, exact uses, long IDs, provider off', async (t) => {
  const f = await fixture(t), sample = modelPickerSample(f);
  const dataOff = {
    ...sample.data,
    models: { ...sample.data.models, pi: sample.data.models.pi.filter((id) => !id.startsWith('xai/')), editor: { off: ['pi:xai'] } },
    harnessSwitches: [...sample.data.harnessSwitches, { id: 'pi:xai', name: 'xai', group: 'provider', off: true }],
    roles: sample.data.roles.map((r) => r.role !== 'imp' ? r : { ...r, places: r.places.map((p, i) => i === 0 ? { ...p, state: 'off' } : i === 1 ? { ...p, state: 'active' } : p) }),
  };
  for (const layout of ['split', 'classic']) for (const lang of ['en', 'zh']) {
    const zh = lang === 'zh', drawing = (state, width = 120, zoomed, data = sample.data) => f.render(width, lang, state, 36, data, true, 'unicode', 'none', { modelPickerZoomed: zoomed });
    const entry = sample.draw(lang, sample.state(layout), 24), opening = send(entry, 'place-model');
    assert.ok(opening.state.projectInput);
    const picker = opening.state;
    const confirmed = fake(() => reply(true)), preexisting = fake(() => reply(false)), refused = fake(() => ({ ok: false }));
    for (const { zoom } of [confirmed, preexisting, refused]) zoom.open();
    await nextTurn();
    const draw = (state, data = sample.data) => drawing(state, 120, confirmed.zoom.zoomed, data);
    const a = draw(picker);
    assert.equal(a.lines.length, 36);
    assert.ok(a.lines.every((line) => visualLength(line) === 120));
    assert.deepEqual(cells(a), cells(drawing(picker, 120, preexisting.zoom.zoomed)));
    assert.match(left(a).join('\n'), /^▾ anthropic ─+ 9\n +claude-opus-5-5 +500K +64K +✓ +✓/m);
    assert.match(left(a).join('\n'), /openai\/gpt-6.1-sol +1M +128K +✓ +✓ +✗/);
    assert.match(right(a), /xai\/grok-4.7/);
    assert.match(cells(a)[0], zh ? /88 个模型 · 列表 2小时前 · 已放大/ : /88 models · list 2h old · zoomed/);
    assert.equal(yOf(a, /^\/ /), 1);
    const normalized = (line) => line.trim().replace(/ +/g, ' ');
    const modelHeader = build(lang).frames.find((frame) => frame.id === '3e').frame.rows[2].segs.map((s) => s.t).join('').split('│')[0];
    assert.equal(normalized(left(a)[1]), normalized(modelHeader));
    const pending = drawing(picker);
    assert.deepEqual(cells(drawing(picker, 120, refused.zoom.zoomed)), cells(pending));
    assert.deepEqual(cells(drawing(picker, 99, confirmed.zoom.zoomed)), cells(drawing(picker, 99)));
    assert.notDeepEqual(cells(drawing(picker, 100, true)), cells(drawing(picker, 100)));
    assert.match(cells(pending).join('\n'), /^▸ anthropic ─+/m);

    const bSelected = click(a, 5, yOf(a, /openai\/gpt-6.1-sol/));
    assert.equal(bSelected.action, undefined);
    const b = draw(bSelected.state);
    assert.match(right(b), zh ? /✗ 已耗尽 · 42分钟后恢复/ : /✗ exhausted · resets in 42m/);
    for (const role of ['imp \\[default\\]', 'reviewer \\[pi\\]', 'oracle \\[fable\\][\\s\\S]*\\[architect\\]']) assert.match(right(b), new RegExp(role));
    assert.match(right(b), zh ? /2小时前发现/ : /discovered 2h ago/);
    assert.equal(click(b, 75, yOf(b, /openai\/gpt-6.1-sol/)).state.projectInput.pick, b.state.projectInput.pick, 'detail is not a second list');
    const picked = click(b, 5, yOf(b, /openai\/gpt-6.1-sol/));
    assert.equal(picked.action, undefined);
    assert.equal(picked.state.controlChain.sheet.place.raw.model, 'openai/gpt-6.1-sol');
    const wheel = draw(click(b, 2, 4, 'wheel-down').state);
    assert.notDeepEqual(left(wheel), left(b));
    assert.equal(right(wheel), right(b));
    assert.equal(left(wheel)[0], left(b)[0]);
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
    assert.equal(set.action, undefined);
    assert.equal(set.state.controlChain.sheet.place.raw.model, 'arena/grok-4.7');
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
    if (layout === 'split' && process.env.HUD_MODEL_PICKER_ZOOM_REPORT)
      for (const [id, frame] of [['3a', a], ['3e', e]]) console.log(`${lang} ${id}\n${cells(frame).join('\n')}`);
    for (const { zoom } of [confirmed, preexisting, refused]) await zoom.close();
  }
});

test('live panel wiring opens with herdr on PATH and restores its own pane on shutdown', { timeout: 10000 }, async (t) => {
  const f = await fixture(t), log = join(f.cwd, 'herdr-log');
  f.put(join(f.hud, 'hud-settings.json'), { language: 'en', modelEnabled: false, theme: 'none', panelLayout: 'classic' });
  f.put(join(f.hud, 'roles/imp.json'), { role: 'imp', can_continue: true, hidden_presets: ['default', 'grok', 'hydrogen'], run: [
    { harness: 'pi', pi_role: 'implementer', model: 'synthetic/current' },
  ] });
  f.put(join(f.hud, 'display/model-lists.json'), { version: 1, fetchedAt: Date.now(), pi: ['synthetic/current'] });
  const herdr = join(f.env.PATH, 'herdr');
  f.put(herdr, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\n` +
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');\nconsole.log(${JSON.stringify(reply(true).stdout)});\n`);
  chmodSync(herdr, 0o700);
  const state = onControl({ projectCursor: 'project:role:imp' });
  const place = JSON.stringify({ state, settings: null }, (_k, v) => v instanceof Set ? { panelSet: [...v] } : v);
  const entry = pathToFileURL(resolve('dist/tree-page.js')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `process.stdout.columns = 120; process.stdout.rows = 36; await (await import(${JSON.stringify(entry)})).runLivePage();`], {
    cwd: f.cwd, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...f.env, PATH: `${f.env.PATH}:${dirname(process.execPath)}`, HERDR_PANE_ID: pane, HERDR_SOCKET_PATH: join(f.cwd, 'fake.sock'),
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
  await waitFor(/imp \[Custom\]/);
  child.stdin.write('\rm');
  await waitFor(/1 model · list .* old · zoomed/);
  output = '';
  child.stdin.write('\r');
  await waitFor(/Edit place/);
  const role = JSON.parse(readFileSync(join(f.hud, 'roles/imp.json'), 'utf8'));
  assert.equal(role.run[0].model, 'synthetic/current');
  child.stdin.write('m');
  await waitFor(/1 model · list .* old · zoomed/);
  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter((args) => args[1] === 'zoom'), [on, off, on, off]);
});
