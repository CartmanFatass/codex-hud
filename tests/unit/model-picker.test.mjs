import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { build } from '../../docs/design/model-picker/gen/frames.mjs';
import { handleMonitorInput } from '../../dist/render/monitor.js';
import { modelInput, modelInputEvent, pickOf, pickView } from '../../dist/render/model-input.js';
import { visualLength } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { chainOverlay, modelPickerSample, onControl, pickerOrderFrames, pickerOrderSample, plain, projectFixture, richControl, NOW, TREE } from '../fixtures/project-page.mjs';

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
function picked(out, value) {
  const { action, state } = out;
  assert.equal(action?.type, 'preset-edit');
  assert.equal(action.op, 'run');
  assert.equal(state.overlay.kind, 'control-chain');
  assert.equal(action.modelIndex, state.overlay.at);
  assert.equal(action.run[action.modelIndex].model, value);
  assert.equal(state.overlay.mode.kind, 'places');
  assert.equal(state.overlay.draft, undefined);
}

test('40-column entry and ranked picker keep the quick model route in EN/ZH and both layouts', async (t) => {
  const f = await fixture(t), { draw, state } = modelPickerSample(f);
  for (const layout of ['split', 'classic']) for (const lang of ['en', 'zh']) {
    const en = lang === 'en';
    const sample = (id) => build(lang).frames.find((f) => f.id === id).frame.rows.map((r) => r.segs.map((s) => s.t).join('').trimEnd());
    const normalize = (line) => line.trim().replace(/ +/g, ' ');
    const compare = (actual, sampleId, re) => assert.deepEqual(plain(actual).filter((l) => re.test(l)).map(normalize),
      sample(sampleId).filter((l) => re.test(l)).map(normalize));
    if (layout === 'split') {
      const roleRow = draw(lang, { ...state(layout), overlay: undefined });
      const hit = field(roleRow);
      const quick = click(roleRow, hit.x, hit.y);
      assert.equal(quick.state.overlay.kind, 'control-quick-model');
      assert.deepEqual(quick.state.overlay, send(roleRow, 'place-model').state.overlay);
    }
    const entry = draw(lang, state(layout), 22);
    compare(entry, '1a', /^\s*(?:› )?\s*[123] [◉○].*\[.* ▾\]/);
    assert.match(entry.lines.at(-1).trimStart(), en ? /^m model/ : /^m 模型/);
    const open = click(entry, field(entry).x, field(entry).y);
    assert.equal(open.action, undefined);
    assert.deepEqual(open.state.overlay, send(entry, 'place-model').state.overlay);
    const cli = click(entry, field(entry, 1).x, field(entry, 1).y).state.overlay;
    assert.equal(cli.kind, 'control-chain');
    assert.equal(cli.mode.kind, 'quick-model');
    assert.equal(cli.mode.index, 1);
    assert.equal(cli.mode.picker.place.label, 'agy');
    const pinned = draw(lang, open.state);
    assert.match(plain(pinned)[2], /^\/ ▌ +88$/);
    assert.match(plain(pinned).join('\n'), /^xai ─+ 6\n +grok-4.5/m);
    assert.match(plain(pinned).join('\n'), en ? /› ◉ xai\/grok-4.7\n +openai\/gpt-6.1-sol +✗ 42m\n +grok-4.7 +\? unknown \[lab\]/
      : /› ◉ xai\/grok-4.7\n +openai\/gpt-6.1-sol +✗ 42分\n +grok-4.7 +\? 未知 \[lab\]/);
    const backup = draw(lang, send(pinned, 'down').state);
    assert.doesNotMatch(plain(backup).join('\n'), /\[default\]/, 'the selected strip also omits the default preset tag');
    assert.doesNotMatch(plain(pinned).join('\n'), /Recent|最近|claude-opus|mistral-small/);
    let filtered = draw(lang, type(pinned, 'grok').state);
    for (let i = 0; i < 8 && !plain(filtered).some((row) => /^› .*grok-4.7-fast$/.test(row)); i++)
      filtered = draw(lang, send(filtered, 'down').state);
    assert.match(plain(filtered).join('\n'), /\/ grok▌ +8\n[\s\S]*›   xai\/grok-4.7-fast[\s\S]*arena\/grok-4.7/);
    picked(send(filtered, 'enter'), 'xai/grok-4.7-fast');
    for (const frame of [entry, pinned, filtered]) assert.ok(frame.lines.every((line) => visualLength(line) === 40));
    assert.deepEqual(pinned.panes.map((p) => p.id), ['agents']);
    assert.match(plain(pinned)[1], en ? /^imp #1 ─+ \[daily\] · pi$/ : /^imp 第 1 位 ─+ \[daily\] · pi$/);
  }
});

test('S4 first screen, flat filters and aggregate have the same order in both widths and locales', async (t) => {
  const f = await fixture(t), { draw, open, send: key } = pickerOrderSample(f);
  const frames = pickerOrderFrames(f);
  assert.deepEqual(pickerOrderFrames(f, 'classic'), frames);
  const ids = (frame) => frame.panes[0].rows.find((r) => r.modelWindow).modelWindow.entries.map(({ id }) => id);
  const grok = ['xai/grok-4.5', 'xai/grok-4.6', 'xai/grok-4.7', 'xai/grok-4.7-code', 'xai/grok-4.7-fast', 'xai/grok-4.7-mini', 'arena/grok-4.6', 'arena/grok-4.7'];
  const mini = ['gpt-5.5-mini', 'gpt-6-mini', 'gpt-6.1-mini', 'gpt-6.1-sol-mini'].map((id) => `openai/${id}`);
  for (const [name, lines] of Object.entries(frames)) {
    assert.equal(lines.length, 24);
    assert.ok(lines.every((line) => visualLength(line) === Number(name.split('-').at(-2))));
  }
  for (const lang of ['en', 'zh']) for (const width of [40, 120]) {
    const browse = open(width, lang), render = (out) => draw(width, lang, out.state);
    const lines = plain(browse).join('\n');
    assert.match(lines, /› ◉ xai\/grok-4.7[^\n]*\n +openai\/gpt-6.1-sol[^\n]*\n +xai\/grok-4.6[^\n]*(?:was|原)/);
    if (width === 40) assert.match(lines, /^ +openai\/gpt-6.1-sol +✗ (?:42m|42分) \[sol\]$/m);
    assert.match(lines, /^xai ─+ 6[^\n]*\n +grok-4.5/m);
    assert.doesNotMatch(lines, /^(?:Pinned|Selected|置顶|所选) ─/m);
    assert.equal(ids(browse).some((id) => /^model:(anthropic|arena|google)\//.test(id)), false);
    let other = render(key(browse, 'end'));
    assert.match(plain(other).join('\n'), /^› ▸ anthropic · arena · google ─+ 59/m);
    assert.match(plain(other).join('\n'), lang === 'en' ? /^⊘ off: deepseek/m : /^⊘ 已停用：deepseek/m);
    const expand = key(other, 'enter');
    assert.equal(expand.action, undefined);
    other = render(expand);
    assert.ok(ids(other).includes('model:anthropic/claude-opus-5-5'));
    assert.ok(ids(other).includes('model:arena/grok-4.7'));
    assert.ok(ids(other).some((id) => id.startsWith('model:google/')));
    assert.deepEqual(ids(render(key(other, 'enter'))), ids(browse));
    for (const [query, expected] of [['grok', grok], ['GROK', grok], ['gpt mini', mini], ['claude-opus', ['anthropic/claude-opus-5-5']], ['no-match', []]]) {
      const typed = key(browse, '', query);
      assert.equal(typed.action, undefined);
      const filtered = render(typed);
      assert.deepEqual(ids(filtered), expected.map((id) => `model:${id}`));
      assert.match(plain(filtered)[2].split('│')[0].trimEnd(), new RegExp(`▌ +${expected.length}$`));
      if (expected.length) assert.equal(filtered.panes[0].rows.find((r) => r.item === 'project:pick').modelHit.entry, `model:${expected[0]}`);
      else {
        assert.match(plain(filtered).join('\n'), lang === 'en' ? /No matching models/ : /没有匹配的模型/);
        assert.equal(key(filtered, 'enter').action, undefined);
      }
    }
  }
});

test('provider evidence comes only from Control places; match quality prefers starts over boundaries over interior', async (t) => {
  const f = await fixture(t), { data, open } = pickerOrderSample(f);
  const input = modelInput(open(40, 'en').state.overlay), role = data.roles[0], pi = input.place;
  const noModel = { ...pi, model: null, piModel: undefined };
  const explicit = { ...pi, model: 'xai/old', piModel: { ...pi.piModel, current: 'xai/old' } };
  const unset = { ...pi, model: 'arena/inherited', piModel: { isDefault: true, defaultId: 'arena/inherited' } };
  const get = (place, places = [], presets = []) => pickOf({ ...data, roles: [{ ...role, places, presets }] }, { ...input, place });
  const none = get(noModel, [noModel]);
  const rows = (pick, text = '') => pickView(pick, { ...input, text }).rows;
  const providers = (pick) => rows(pick).flatMap((r) => 'provider' in r ? [r.provider] : []);
  assert.deepEqual(providers(none), ['anthropic', 'arena', 'google', 'mistral', 'openai', 'xai']);
  assert.ok(!rows(none).some((r) => r.id === 'other'));
  // A fallback for an overridden place remains available to clear to, but does not count as a provider use.
  const current = [explicit], preset = [unset, unset, { ...pi, model: 'mistral/old', piModel: undefined }];
  const used = get(explicit, current, [{ name: 'daily', places: current }, { name: 'other', places: preset }]);
  assert.deepEqual([...used.inUse], [['xai', 1], ['arena', 2], ['mistral', 1]]);
  assert.deepEqual(providers(used), ['xai', 'arena', 'mistral']);
  const rank = { ...used, lists: { ...used.lists, pi: ['xai/aafoo', 'xai/ab-foo', 'xai/foo', 'xai/aafoo:foo', 'foop/aa'] } };
  assert.deepEqual(rows(rank, 'foo').map((r) => r.label), ['xai/foo', 'xai/aafoo:foo', 'xai/ab-foo', 'xai/aafoo', 'foop/aa']);
});

test('resolved bare pi models open and rank their provider; ambiguous bare models do not', async (t) => {
  const f = await fixture(t);
  f.put(join(f.hud, 'roles/imp.json'), { role: 'imp', can_continue: true, hidden_presets: ['default', 'grok', 'hydrogen'],
    run: ['gpt-current', 'arena/gpt-other', 'shared'].map((model) => ({ harness: 'pi', pi_role: 'implementer', model })) });
  f.put(join(f.hud, 'display/model-lists.json'), { version: 1, fetchedAt: NOW,
    pi: ['openai/gpt-current', 'openai/gpt-next', 'arena/gpt-other', 'anthropic/shared', 'mistral/shared'] });
  const snapshot = await f.collector.collect('control', f.board, NOW);
  const role = snapshot.roles.find((r) => r.role === 'imp'), [resolved, , ambiguous] = role.places;
  assert.equal(resolved.model, 'gpt-current');
  assert.equal(resolved.piModel.current, 'openai/gpt-current');
  assert.equal(ambiguous.piModel.current, 'shared');
  assert.equal(ambiguous.provider, null);

  const data = { ...snapshot, roles: [role] };
  const draw = (state) => f.render(40, 'en', state, 24, data);
  const chain = draw(onControl({ cursor: 'project:role:imp' }, { overlay: chainOverlay(role) }));
  const browse = draw(send(chain, 'place-model').state);
  const input = modelInput(browse.state.overlay), pick = pickOf(data, input), { rows } = pickView(pick, input);
  assert.deepEqual([...pick.inUse], [['openai', 1], ['arena', 1]]);
  assert.deepEqual(rows.filter((row) => 'provider' in row).map((row) => row.provider), ['openai', 'arena']);
  assert.deepEqual(rows.find((row) => row.id === 'other').providers, ['anthropic', 'mistral']);
  const filtered = draw(type(browse, 'gpt').state);
  const models = plain(filtered).filter((row) => /(?:openai|arena)\/gpt-/.test(row));
  assert.deepEqual(models.map((row) => row.trim().split(/\s+/).at(-1)), ['openai/gpt-current', 'openai/gpt-next', 'arena/gpt-other']);
});

test('draft reorder keeps clickable pi and CLI model fields in the in-memory chain', async (t) => {
  const f = await fixture(t), { draw, state } = modelPickerSample(f);
  for (const layout of ['classic', 'split']) for (const lang of ['en', 'zh']) {
    const render = (next) => draw(lang, next, 24);
    const entry = render(state(layout));
    const draft = render(send(entry, 'place-down').state);
    assert.ok(draft.state.overlay.draft, 'moving a place starts an unsaved draft');
    assert.ok(draft.lines.every((line) => visualLength(line) === 40));
    const cliField = field(draft), piField = field(draft, 1);
    assert.ok(cliField && piField, plain(draft).join('\n'));
    for (const hit of [cliField, piField]) assert.match(plain(draft)[hit.y], /\[.* ▾\]/);
    const cli = click(draft, cliField.x, cliField.y);
    assert.equal(cli.action, undefined);
    assert.equal(cli.state.overlay.mode.kind, 'quick-model');
    assert.equal(cli.state.overlay.mode.index, 0);
    const cliPicker = render(cli.state);
    const setCli = click(cliPicker, 3, rowY(cliPicker, /gemini-3\.8-flash-high$/));
    assert.equal(setCli.action, undefined, 'one click sets the CLI model in the draft only');
    assert.equal(setCli.state.overlay.mode.kind, 'places');
    assert.equal(setCli.state.overlay.draft.run[0].raw.model, 'gemini-3.8-flash-high');
    const pi = click(draft, piField.x, piField.y);
    assert.equal(pi.action, undefined);
    assert.equal(pi.state.overlay.mode.index, 1);
    const filtered = render(type(render(pi.state), 'grok-4.7-fast').state);
    const updated = send(filtered, 'enter');
    assert.equal(updated.action, undefined, 'Enter updates only the draft');
    assert.equal(updated.state.overlay.mode.kind, 'places');
    assert.equal(updated.state.overlay.draft.run[1].raw.model, 'xai/grok-4.7-fast');
    if (process.env.CONTROL_REVIEW_FRAMES && layout === 'classic') t.diagnostic(`${lang} draft:\n${plain(draft).join('\n')}`);
  }
});

test('picker mouse toggles other providers, ignores headers, sets in one click and cancels from the footer', async (t) => {
  const f = await fixture(t), { draw, state } = modelPickerSample(f);
  for (const layout of ['classic', 'split']) {
    const render = (state) => draw('en', state, 32);
    let frame = render(state(layout));
    assert.equal(modelInput(click(frame, 2, field(frame, 1).y).state.overlay), undefined, 'the rest of a place row is not the model field');
    frame = render(send(frame, 'place-model').state);
    const hit = (re) => { const out = click(frame, 3, rowY(frame, re)); assert.equal(out.action, undefined); frame = render(out.state); };
    const untouched = frame.state.overlay;
    for (const y of [0, 1, 2, rowY(frame, /^xai ─/), rowY(frame, /^256K ctx/)]) {
      const out = click(frame, 3, y);
      assert.equal(out.action, undefined);
      assert.deepEqual(out.state.overlay, untouched);
    }
    const cancel = frame.controls.find((c) => c.kind === 'model-cancel');
    assert.match(frame.lines[cancel.y].slice(cancel.x, cancel.x + cancel.width), /^esc cancel$/);
    const closed = click(frame, cancel.x, cancel.y);
    assert.equal(closed.action, undefined);
    assert.equal(closed.state.overlay.mode.kind, 'places');
    assert.deepEqual(closed.state.control.roles, frame.state.control.roles);
    const currentY = rowY(frame, /› ◉ xai\/grok-4.7/);
    const set = modelInputEvent(modelInput(frame.state.overlay), { type: 'mouse', button: 'left', x: 3, y: currentY }, { frame });
    assert.deepEqual(set, { action: { type: 'model-picked', value: 'xai/grok-4.7' } });
    assert.match(plain(frame).join('\n'), /^xai ─+ 6\n[\s\S]*  ◉ grok-4.7/m, 'the current model stays in its group too');
    frame = render(send(frame, 'end').state);
    assert.match(plain(frame).join('\n'), /^› ▸ anthropic · arena · google \+1 ─+ 67$/m);
    hit(/▸ anthropic · arena/);
    assert.ok(frame.state.overlay.mode.picker.otherOpen);
    frame = render(click(frame, 3, 5, 65).state);
    assert.match(plain(frame).join('\n'), /^anthropic ─/m);
    hit(/▾ anthropic · arena/);
    assert.equal(frame.state.overlay.mode.picker.otherOpen, false);
    frame = render(type(frame, 'grok').state);
    picked(send(frame, 'enter'), 'xai/grok-4.5');
    assert.deepEqual(click(frame, 3, rowY(frame, /^$/)).state.overlay, frame.state.overlay);
    picked(click(frame, 3, rowY(frame, /grok-4.7-fast$/)), 'xai/grok-4.7-fast');
    const tab = frame.controls.find((c) => c.kind === 'board-project');
    assert.deepEqual(click(frame, tab.x, tab.y).state.overlay, frame.state.overlay, 'typing owns input');
  }
});

test('wheel, arrows and page keys keep the cursor in the painted list at both widths', async (t) => {
  const f = await fixture(t), { state, data } = modelPickerSample(f);
  for (const width of [40, 100]) {
    const draw = (state) => f.render(width, 'en', state, 24, data);
    const window = (frame) => frame.panes[0].rows.find((row) => row.modelWindow).modelWindow;
    const entry = draw(state()), browse = draw(send(entry, 'place-model').state);
    const start = draw(type(browse, 'arena/').state);
    assert.equal(type(start, '?').state.overlay.mode.picker.text, 'arena/?');
    assert.doesNotMatch(start.lines.at(-1), /↑↓|\? help/);
    const { first, size } = window(start);
    const paged = draw(send(start, 'page-down').state);
    assert.equal(window(paged).first, first + size - 1);
    assert.equal(window(paged).entries.find(({ id }) => id === paged.state.overlay.mode.picker.pick).row, size - 1);
    assert.equal(window(draw(send(paged, 'page-up').state)).first, first);
    let frame = start;
    for (let row = 1; row < first + size; row++) {
      frame = draw(send(frame, 'down').state);
      assert.equal(window(frame).first, first, 'arrows do not scroll before the cursor passes the edge');
    }
    const crossed = draw(send(frame, 'down').state);
    assert.equal(window(crossed).first, first + 2, 'crossing leaves one row of context below the cursor');
    frame = start;
    for (const distance of [3, 6]) {
      frame = draw(click(frame, 3, 5, 65).state);
      assert.equal(window(frame).first, first + distance);
      assert.equal(rowY(frame, /^\/ /), rowY(start, /^\/ /));
    }
    const visible = frame.panes[0].rows.find((row) => row.item === 'project:pick');
    assert.ok(visible, 'the cursor survives two wheel steps');
    picked(send(frame, 'enter'), visible.modelHit.entry.slice('model:'.length));
    assert.match(plain(frame).join('\n'), /^› /m);
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
  const placeState = (role, i = 0, snapshot = data) => onControl({ cursor: `project:role:${role}` }, {
    overlay: chainOverlay(snapshot.roles.find((r) => r.role === role), i),
  });
  const opened = f.render(40, 'en', placeState('imp', 1), 32, data);
  const blank = field(opened, 1);
  assert.equal(blank.width, 3);
  assert.match(opened.lines[blank.y], /\[▾\]/);
  const openedCli = click(opened, blank.x + 1, blank.y);
  assert.equal(openedCli.state.overlay.mode.index, 1);
  assert.deepEqual(openedCli.state.overlay, send(opened, 'place-model').state.overlay);
  const pick = f.render(40, 'en', click(opened, field(opened).x, field(opened).y).state, 32, data);
  assert.match(plain(pick).join('\n'), /› ◉ xai\/current\n +openai\/backup +\[backup\] \[shared\]/);
  assert.doesNotMatch(plain(pick).join('\n'), /xai\/other|\[other\]|Pinned/);
  const synthetic = richControl(f.data);
  for (const role of ['frontend', 'flow']) {
    const frame = f.render(40, 'en', placeState(role, 0, synthetic), 32, synthetic);
    assert.equal(frame.controls.some((c) => c.kind === 'control-model'), false);
    const out = send(frame, 'place-model');
    assert.equal(out.state.overlay.mode.kind, 'places');
    assert.equal(out.action, undefined);
  }
});
