import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { build } from '../../docs/design/model-picker/gen/frames.mjs';
import { handleMonitorInput } from '../../dist/render/monitor.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { modelPickerSample, onControl, plain, projectFixture, richControl, NOW, TREE } from '../fixtures/project-page.mjs';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hud-model-picker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return projectFixture(dir);
}
const send = (frame, key) => handleMonitorInput(frame.state, typeof key === 'string' ? { type: 'key', key } : key, { frame, tree: TREE, nowMs: NOW });
const type = (frame, text) => send(frame, { type: 'key', key: 'none', text });
const click = (frame, x, y, button = 0) => {
  const decoder = new WorkbenchInputDecoder('workboard');
  const [input] = decoder.push(Buffer.from(`\x1b[<${button};${x + 1};${y + 1}M`));
  assert.equal(input?.type, 'mouse');
  return send(frame, input);
};
const field = (frame, i = 0) => frame.controls.find((c) => c.kind === 'control-model' && c.item === `project:role:imp:${i}`);
const rowY = (frame, re) => {
  const y = plain(frame).findIndex((line) => re.test(line));
  assert.ok(y >= 0, `${re}:\n${plain(frame).join('\n')}`);
  return y;
};
function filled(out, value) {
  assert.equal(out.action, undefined, 'the picker only fills the in-memory field');
  assert.equal(out.state.projectInput, undefined);
  assert.equal(out.state.controlChain.sheet.place.raw.model, value);
}

test('40-column entry, pinned and typed frames follow the sample in EN/ZH and both layouts', async (t) => {
  const f = await fixture(t), { draw, state } = modelPickerSample(f);
  for (const layout of ['split', 'classic']) for (const lang of ['en', 'zh']) {
    const en = lang === 'en';
    const sample = (id) => build(lang).frames.find((f) => f.id === id).frame.rows.map((r) => r.segs.map((s) => s.t).join('').trimEnd());
    const normalize = (line) => line.trim().replace(/ +/g, ' ');
    const compare = (actual, sampleId, re) => assert.deepEqual(plain(actual).filter((l) => re.test(l)).map(normalize),
      sample(sampleId).filter((l) => re.test(l)).map(normalize));
    const entry = draw(lang, state(layout), 22);
    compare(entry, '1a', /^\s*(?:› )?\s*[123] [◉○].*\[.* ▾\]/);
    assert.match(entry.lines.at(-1).trimStart(), en ? /^m model/ : /^m 模型/);
    const open = click(entry, field(entry).x, field(entry).y);
    assert.equal(open.action, undefined);
    assert.deepEqual(open.state.projectInput, send(entry, 'place-model').state.projectInput);
    const cli = click(entry, field(entry, 1).x, field(entry, 1).y).state;
    assert.equal(cli.projectInput, undefined);
    assert.equal(cli.controlChain.sheet.index, 1);
    assert.equal(cli.controlChain.sheet.field, 'model');
    const pinned = draw(lang, open.state);
    compare(pinned, '2a', /^(?:\/|▸|⊘)/);
    assert.match(plain(pinned).join('\n'), en ? /› ◉ xai\/grok-4.7\n +openai\/gpt-6.1-sol +✗ 42m \[default\]\n +grok-4.7 +\? unknown \[lab\]/
      : /› ◉ xai\/grok-4.7\n +openai\/gpt-6.1-sol +✗ 42分钟\n +grok-4.7 +\? 未知 \[lab\]/);
    const backup = click(pinned, 3, rowY(pinned, /^ +openai\/gpt-6.1-sol +✗/));
    assert.match(plain(draw(lang, backup.state)).join('\n'), /^  \[default\]$/m, 'the selected strip also shows preset names');
    assert.doesNotMatch(plain(pinned).join('\n'), /Recent|最近|claude-opus|mistral-small/);
    let filtered = draw(lang, type(pinned, 'grok').state);
    const y = rowY(filtered, /grok-4.7-fast$/);
    const selected = click(filtered, 8, y);
    assert.equal(selected.action, undefined);
    filtered = draw(lang, selected.state);
    compare(filtered, '2b', /^(?:\/|▾|[› ]{4}grok-)/);
    filled(send(filtered, 'enter'), 'xai/grok-4.7-fast');
    for (const frame of [entry, pinned, filtered]) assert.ok(frame.lines.every((line) => visualLength(line) === 40));
    if (layout === 'split') assert.ok(pinned.panes.some((p) => p.id === 'preview'));
    if (layout === 'split' && process.env.HUD_MODEL_PICKER_REPORT_FRAMES)
      for (const [id, frame] of [['1a', entry], ['2a', pinned], ['2b', filtered]]) console.log(`${lang} ${id}\n${frame.lines.map(stripAnsi).join('\n')}`);
  }
});

test('draft reorder keeps clickable pi and CLI model fields in the in-memory chain', async (t) => {
  const f = await fixture(t), { draw, state } = modelPickerSample(f);
  for (const layout of ['classic', 'split']) for (const lang of ['en', 'zh']) {
    const render = (next) => draw(lang, next, 24);
    const entry = render(state(layout));
    const draft = render(send(entry, 'place-down').state);
    assert.ok(draft.state.controlChain.draft, 'moving a place starts an unsaved draft');
    assert.ok(draft.lines.every((line) => visualLength(line) === 40));
    const cliField = field(draft), piField = field(draft, 1);
    assert.ok(cliField && piField, plain(draft).join('\n'));
    for (const hit of [cliField, piField]) assert.match(plain(draft)[hit.y], /\[.* ▾\]/);
    const cli = click(draft, cliField.x, cliField.y);
    assert.equal(cli.action, undefined);
    assert.equal(cli.state.projectInput, undefined);
    assert.equal(cli.state.controlChain.sheet.place.raw.harness, 'cli');
    assert.ok(cli.state.controlChain.sheet.choice, 'CLI uses the inline catalog');
    const pi = click(draft, piField.x, piField.y);
    assert.equal(pi.action, undefined);
    assert.equal(pi.state.projectInput.index, 1);
    const filtered = render(type(render(pi.state), 'grok-4.7-fast').state);
    const filledModel = send(filtered, 'enter');
    filled(filledModel, 'xai/grok-4.7-fast');
    assert.equal(filledModel.state.controlChain.draft.run[1].raw.model, 'xai/grok-4.7');
    const done = render(send(render(filledModel.state), 'end').state);
    const updated = send(done, 'enter');
    assert.equal(updated.action, undefined, 'Done updates only the draft');
    assert.equal(updated.state.controlChain.draft.run[1].raw.model, 'xai/grok-4.7-fast');
    if (process.env.CONTROL_REVIEW_FRAMES && layout === 'classic') t.diagnostic(`${lang} draft:\n${plain(draft).join('\n')}`);
  }
});

test('picker mouse folds off-cursor headers, scrolls only the list, and requires a second click to set', async (t) => {
  const f = await fixture(t), { draw, state } = modelPickerSample(f);
  for (const layout of ['classic', 'split']) {
    const render = (state) => draw('en', state, 32);
    let frame = render(state(layout));
    assert.equal(click(frame, 2, field(frame, 1).y).state.projectInput, undefined, 'the rest of a place row is not the model field');
    frame = render(send(frame, 'place-model').state);
    const hit = (re) => { const out = click(frame, 3, rowY(frame, re)); assert.equal(out.action, undefined); frame = render(out.state); };
    hit(/› ◉ xai\/grok-4.7/); // Already the cursor, but not yet clicked.
    assert.ok(frame.state.projectInput);
    hit(/^▸ xai ─/);
    assert.match(plain(frame).join('\n'), /▾ xai ─+ 6\n[\s\S]*  ◉ grok-4.7/, 'the pin stays in the group too');
    hit(/^▾ xai ─/);
    assert.doesNotMatch(plain(frame).join('\n'), /^ {2}◉ grok-4.7$/m);
    hit(/^▸ openai ─/);
    const query = rowY(frame, /^\/ /), strip = plain(frame).slice(rowY(frame, /^Selected /));
    const before = plain(frame), wheel = click(frame, 3, query + 1, 65);
    assert.equal(wheel.action, undefined);
    frame = render(wheel.state);
    assert.notDeepEqual(plain(frame), before);
    assert.equal(plain(frame)[query], before[query]);
    assert.deepEqual(plain(frame).slice(-strip.length), strip);
    frame = render(click(frame, 3, query + 1, 64).state);
    assert.deepEqual(plain(frame), before);
    frame = render(type(frame, 'grok').state);
    hit(/^▾ arena ─/);
    assert.match(plain(frame).join('\n'), /^▸ arena /m);
    hit(/^▸ arena ─/);
    assert.match(plain(frame).join('\n'), /^▾ arena /m);
    frame = render(send(frame, 'home').state);
    filled(send(frame, 'enter'), 'arena/grok-4.6'); // Headers are skipped by navigation.
    const fast = /grok-4.7-fast$/;
    hit(fast);
    const out = click(frame, 3, rowY(frame, fast));
    filled(out, 'xai/grok-4.7-fast');
    const tab = frame.controls.find((c) => c.kind === 'board-project');
    const left = click(frame, tab.x, tab.y);
    assert.equal(left.state.mainTab, 'control');
    assert.ok(left.state.projectInput, 'the active field owns input');
  }
});

test('the picker uses real collected preset chains, and locked and Flow places stay out of the model field', async (t) => {
  const f = await fixture(t), pi = (model) => ({ harness: 'pi', pi_role: 'implementer', model });
  f.put(join(f.hud, 'roles/imp.json'), { role: 'imp', can_continue: true, active_preset: 'daily', hidden_presets: ['default', 'grok', 'hydrogen'], run: [pi('xai/current')], presets: [
    { name: 'daily', run: [pi('xai/current'), { harness: 'cli', agent: 'agy' }] },
    { name: 'backup', run: [pi('openai/backup')] },
    { name: 'shared', run: [pi('openai/backup')] },
  ] });
  f.put(join(f.hud, 'roles/reviewer.json'), { role: 'reviewer', can_continue: true, run: [pi('xai/other')], presets: [{ name: 'other', run: [pi('xai/other')] }] });
  f.put(join(f.hud, 'display/model-lists.json'), { version: 1, fetchedAt: NOW, pi: ['xai/current', 'openai/backup', 'xai/other'] });
  const data = await f.collector.collect('control', f.board, NOW);
  const placeState = (role, i = 0, snapshot = data) => onControl({ projectCursor: `project:role:${role}` }, {
    controlChain: { role: snapshot.roles.find((r) => r.role === role), at: i },
  });
  const opened = f.render(40, 'en', placeState('imp', 1), 32, data);
  assert.match(opened.lines[field(opened, 1).y], /\[default ▾\]/);
  const pick = f.render(40, 'en', click(opened, field(opened).x, field(opened).y).state, 32, data);
  assert.match(plain(pick).join('\n'), /Pinned ─+ 2\n› ◉ xai\/current\n +openai\/backup +\[backup\] \[shared\]/);
  assert.doesNotMatch(plain(pick).join('\n'), /xai\/other|\[other\]/);
  const synthetic = richControl(f.data);
  for (const role of ['frontend', 'flow']) {
    const frame = f.render(40, 'en', placeState(role, 0, synthetic), 32, synthetic);
    assert.equal(frame.controls.some((c) => c.kind === 'control-model'), false);
    const out = send(frame, 'place-model');
    assert.equal(out.state.projectInput, undefined);
    assert.equal(out.action, undefined);
  }
});
