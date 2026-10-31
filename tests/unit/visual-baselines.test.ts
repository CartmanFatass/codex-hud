import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../fixtures/paths.js';
import { applyCardPreset, identifyCardPreset } from '../../src/card-presets.js';
import { cardSummaryTargets } from '../../src/render/cards.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { controlBar } from '../../src/render/control-bar.js';
import { t } from '../../src/render/i18n.js';
import { SETTING_ROWS, handleSettingsInput } from '../../src/render/settings-page.js';
import { handleSettingsConfirmation } from '../../src/render/settings-confirmation.js';
import {
  VISUAL_NOW, VISUAL_IDS, VISUAL_WIDTHS, VISUAL_LANGUAGES, VISUAL_PRESETS,
  visualCases, visualSettings, visualState, visualMaterial, withVisualDisplay,
  renderVisualPanel, renderVisualMenu, renderVisualConfirmation, visualConfirmationState, renderVisualInspector,
  generateVisualBaseline, normalizeVisualLines,
  type VisualCase, type VisualBaseline, type VisualGolden,
} from '../fixtures/visual-baselines.js';

// Compiled automatically by build:test; npm test discovers this *.test.ts.
// Local reviewed update only (never CI):
// npm run build:test && CODEX_HUD_UPDATE_VISUAL_BASELINES=1 node --test dist-test/tests/unit/visual-baselines.test.js
// Verification: node --test dist-test/tests/unit/visual-baselines.test.js
// This is a textual terminal-cell regression, NOT a font/pixel screenshot test.
const GOLDEN = join(REPO_ROOT, 'tests/fixtures/visual-baselines.json');
const UPDATE_COMMAND = 'npm run build:test && CODEX_HUD_UPDATE_VISUAL_BASELINES=1 node --test dist-test/tests/unit/visual-baselines.test.js';
const BASELINE_LIMIT = 600 * 1024;
const scenes = visualCases();

function assertDimensions(lines: readonly string[], scene: Pick<VisualCase, 'name' | 'width' | 'height'>) {
  assert.equal(lines.length, scene.height, `${scene.name}: exact frame height`);
  lines.forEach((line, index) => {
    assert.doesNotMatch(line, /[\r\n]/, `${scene.name}: row ${index + 1} must be a single line`);
    assert.equal(visualLength(line), scene.width, `${scene.name}: row ${index + 1} exact display width (trailing cells retained): ${JSON.stringify(stripAnsi(line))}`);
  });
}

function assertControls(controls: readonly { x: number; y: number; width: number }[], scene: VisualCase) {
  controls.forEach((control, i) => {
    assert.ok(control.x >= 0 && control.x + control.width <= scene.width && control.width > 0,
      `${scene.name}: control ${i} outside width: ${JSON.stringify(control)}`);
    assert.ok(control.y >= 0 && control.y < scene.height, `${scene.name}: control ${i} outside height`);
    for (const other of controls.slice(i + 1)) if (control.y === other.y) {
      assert.ok(control.x + control.width <= other.x || other.x + other.width <= control.x,
        `${scene.name}: overlapping controls ${JSON.stringify(control)} / ${JSON.stringify(other)}`);
    }
  });
}

/** Visible spaces make padding changes reviewable, without dumping 200 frames. */
function frameDiff(name: string, expected: VisualGolden, actual: VisualGolden): string | null {
  if (expected.width !== actual.width || expected.height !== actual.height)
    return `${name}: dimensions ${expected.width}x${expected.height} -> ${actual.width}x${actual.height}`;
  const at = Array.from({ length: Math.max(expected.lines.length, actual.lines.length) }, (_, i) => i)
    .find(i => expected.lines[i] !== actual.lines[i]);
  if (at === undefined) return null;
  const show = (line: string | undefined) => line === undefined ? '<missing>' : `${JSON.stringify(line.replace(/ /g, '·'))} [${visualLength(line)} cells]`;
  const rows = Array.from({ length: Math.min(actual.height, at + 2) - Math.max(0, at - 1) }, (_, i) => Math.max(0, at - 1) + i);
  return `${name}: first changed row ${at + 1} (· = retained space)\n` +
    rows.map(i => `row ${i + 1}\n- ${show(expected.lines[i])}\n+ ${show(actual.lines[i])}`).join('\n') +
    `\nInspect this case, then intentionally update locally:\n${UPDATE_COMMAND}\nGolden: ${GOLDEN}`;
}

test('visual semantics: all presets retain identity and exact frame dimensions', () => {
  for (const scene of scenes.filter(scene => scene.kind === 'panel')) withVisualDisplay(scene, () => {
    const settings = visualSettings(scene);
    assert.equal(identifyCardPreset(settings), scene.preset);
    const frame = renderVisualPanel(scene);
    assertDimensions(frame.lines, scene);
    assert.equal(frame.state.tree.selectedId, VISUAL_IDS.active, `${scene.name}: selection is by identity, not row`);
    const items = new Set(frame.panes.find(pane => pane.id === 'agents')!.rows.map(row => row.item));
    for (const id of [VISUAL_IDS.active, VISUAL_IDS.idle]) assert.ok(items.has(id), `${scene.name}: L1 identity ${id} remains`);
    const text = stripAnsi(frame.lines.join('\n'));
    assert.match(text, /Parser/, `${scene.name}: active L1 visibly named`);
    assert.doesNotMatch(text, /RAW_TASK_INSPECTOR_ONLY|RAW_CHARGE_INSPECTOR_ONLY/, `${scene.name}: card contains only model summaries`);
  });
});

test('visual semantics: child role counts off removes only footer counts, not children, summaries or targets', () => {
  for (const language of VISUAL_LANGUAGES) withVisualDisplay({ language, look: 'tab' }, () => {
    const scene = scenes.find(scene => scene.kind === 'panel' && scene.language === language && scene.look === 'tab' && scene.width === 80 && scene.preset === 'monitor')!;
    // Room for every content row: this isolates the switch from viewport clipping.
    const tall = { ...scene, height: 60 };
    const before = visualState(visualSettings(tall));
    const after = { ...before, cardVisibility: { ...before.cardVisibility, cardRoleCounts: false } };
    const on = renderVisualPanel(tall, before);
    const off = renderVisualPanel(tall, after);
    const counts = /\b1 implementer · 1 scout\b/;
    const content = (frame: typeof on) => frame.panes.find(pane => pane.id === 'agents')!.rows
      .map(row => stripAnsi(row.text)).filter(line => !counts.test(line));
    assert.ok(on.lines.some(line => counts.test(stripAnsi(line))), `${scene.name}: fixture actually exercises footer counts`);
    assert.ok(!off.lines.some(line => counts.test(stripAnsi(line))), `${scene.name}: counts removed`);
    assert.deepEqual(content(on), content(off), `${scene.name}: all other card rows identical`);
    for (const name of ['running_子', 'failed_子']) assert.ok(stripAnsi(off.lines.join('\n')).includes(name), `${scene.name}: child ${name} remains`);
    const material = visualMaterial(language);
    const targets = (state: typeof before) => cardSummaryTargets(material, state, VISUAL_NOW);
    assert.deepEqual(targets(before), targets(after), `${scene.name}: role counts never affect progress generation`);
  });
});

test('visual semantics: recap viewport is independent of card preset at every width and look', () => {
  for (const language of VISUAL_LANGUAGES) for (const width of VISUAL_WIDTHS) {
    for (const look of ['tab', 'band', 'tile', 'frame', 'pill'] as const) withVisualDisplay({ language, look }, () => {
      const frames = VISUAL_PRESETS.map(preset => renderVisualPanel(scenes.find(scene =>
        scene.kind === 'panel' && scene.language === language && scene.width === width && scene.look === look && scene.preset === preset)!));
      const foot = frames[0].statusCard;
      assert.ok(foot, `${language}/${look}/${width}: status viewport rendered`);
      // Width 32 deliberately shows the minimal status band, but still must
      // reserve an identical viewport across all card presets.
      if (width > 32) assert.ok(foot.brief > 0, `${language}/${look}/${width}: recap really rendered`);
      for (const frame of frames.slice(1)) {
        assert.deepEqual(frame.statusCard, foot, `${language}/${look}/${width}: same recap geometry across presets`);
        assert.deepEqual(normalizeVisualLines(frame.lines.slice(foot.y)), normalizeVisualLines(frames[0].lines.slice(foot.y)),
          `${language}/${look}/${width}: same recap text across presets`);
      }
    });
  }
});

test('visual semantics: active Settings navigation retains full localized label and nonoverlapping controls from width 24', () => {
  for (const scene of scenes.filter(scene => scene.kind === 'settings')) withVisualDisplay(scene, () => {
    const frame = renderVisualMenu(scene);
    assertDimensions(frame.lines, scene);
    assertControls([...frame.navigationControls, ...frame.actions.map(action => ({ ...action, y: frame.headerY }))], scene);
    const settings = frame.navigationControls.find(control => control.kind === 'settings');
    assert.ok(settings, `${scene.name}: Settings hit target remains`);
    assert.ok(stripAnsi(frame.lines[settings.y]).includes(t('Settings')), `${scene.name}: full localized Settings label`);
    for (const width of [24, 28]) {
      const nav = controlBar(visualState(visualSettings(scene)), { expired: 0, settingsActive: true }, width);
      assert.ok(nav.lines.map(stripAnsi).join('').includes(t('Settings')), `${scene.name}: full Settings label at ${width}`);
      assertControls(nav.controls, { ...scene, width });
    }
  });
});

test('visual semantics: Save returns the new width and the next render reflows navigation, values and selected identity', () => {
  for (const scene of scenes.filter(scene => scene.kind === 'saved-width')) withVisualDisplay(scene, () => {
    const settings = { ...visualSettings(scene), treeWidth: 40 };
    const state = { draft: settings, original: { ...settings }, selected: SETTING_ROWS.findIndex(row => row.key === 'treeWidth'), offset: 0, message: '' };
    const before = renderVisualMenu({ ...scene, width: 40 }, state);
    let edited = handleSettingsInput(before.state, { type: 'key', key: 'right' }, before).state;
    edited = handleSettingsInput(edited, { type: 'key', key: 'right' }, before).state;
    assert.equal(edited.draft.treeWidth, 56, `${scene.name}: draft reaches 56`);
    const unsaved = renderVisualMenu({ ...scene, width: 40 }, edited);
    assertDimensions(unsaved.lines, { ...scene, width: 40 });
    const save = handleSettingsInput(unsaved.state, { type: 'key', key: 'sort' }, unsaved);
    assert.equal(save.action, 'save');
    // This is the render seam after the owner applies the returned draft. Actual
    // saveSettings/tmux resizing is deliberately covered by integration tests.
    const saved = { ...save.state, original: { ...save.state.draft }, message: '' };
    const after = renderVisualMenu(scene, saved);
    assertDimensions(after.lines, scene);
    assertControls([...after.navigationControls, ...after.actions.map(action => ({ ...action, y: after.headerY }))], scene);
    assert.equal(after.state.selected, state.selected);
    assert.deepEqual(normalizeVisualLines(after.lines), normalizeVisualLines(renderVisualMenu(scene).lines),
      `${scene.name}: golden is the actual post-Save reflow, not an unrelated fixture`);
    const valueColumn = (frame: typeof before) => {
      const line = stripAnsi(frame.lines[frame.rows.indexOf(state.selected)]);
      return visualLength(line.slice(0, line.indexOf('‹')));
    };
    assert.ok(valueColumn(after) > valueColumn(before), `${scene.name}: saved width moves value column right`);
    const oldPanel = renderVisualPanel({ ...scene, kind: 'panel', width: 40 }, visualState(settings));
    const newPanel = renderVisualPanel({ ...scene, kind: 'panel' }, { ...oldPanel.state, ...visualState(applyCardPreset(saved.draft, 'progress')), tree: oldPanel.state.tree });
    assert.equal(newPanel.state.tree.selectedId, VISUAL_IDS.active, `${scene.name}: selection survives saved-width reflow`);
  });
});

test('visual semantics: confirmation owns input, blocks hidden UI clicks and defaults to cancel', () => {
  for (const scene of scenes.filter(scene => scene.kind === 'confirmation')) withVisualDisplay(scene, () => {
    const state = visualConfirmationState(scene);
    const frame = renderVisualConfirmation(scene);
    assertDimensions(frame.lines, scene);
    assertControls(frame.controls, scene);
    assert.equal(handleSettingsConfirmation(state, { type: 'key', key: 'escape' }, frame).action, 'cancel');
    assert.equal(handleSettingsConfirmation(state, { type: 'key', key: 'enter' }, frame).action, scene.saveError ? 'save' : 'cancel');
    const hidden = renderVisualMenu(scene);
    for (const control of hidden.navigationControls) {
      const outcome = handleSettingsConfirmation(state, { type: 'mouse', button: 'left', x: control.x, y: control.y }, frame);
      assert.equal(outcome.action, undefined, `${scene.name}: hidden navigation must not accept clicks`);
      assert.deepEqual(outcome.state, state);
    }
    const emptyY = frame.lines.findIndex((line, y) => y > hidden.headerY && !stripAnsi(line).trim());
    assert.ok(emptyY >= 0);
    assert.equal(handleSettingsConfirmation(state, { type: 'mouse', button: 'left', x: 3, y: emptyY }, frame).action, undefined,
      `${scene.name}: hidden setting rows cannot receive clicks through the modal`);
    if (scene.saveError) assert.ok(stripAnsi(frame.lines.join('')).includes(scene.language === 'zh' ? '保存失败' : 'Save failed'));
  });
});

test('visual semantics: Inspector preserves stored summary and distinguishes explicit Coverage from legacy Recorded', () => {
  for (const scene of scenes.filter(scene => scene.kind === 'inspector')) withVisualDisplay(scene, () => {
    const frame = renderVisualInspector(scene);
    assertDimensions(frame.lines, scene);
    assert.equal(frame.state.tree.selectedId, VISUAL_IDS.active, `${scene.name}: Inspector selected identity`);
    const compact = (text: string) => text.replace(/\s+/g, '');
    const text = compact(frame.lines.map(line => stripAnsi(line).replace(/^│\s*/, '').trim()).join(''));
    const label = (key: string) => compact(t(key, { at: '' }));
    assert.ok(text.includes(compact(t('Model summary'))), `${scene.name}: model summary heading visible`);
    assert.ok(text.includes(compact(scene.language === 'zh' ? '正在验证中文恢复边界' : 'recovery boundaries')), `${scene.name}: stored summary remains visible`);
    if (scene.progressPhase === 'off') {
      assert.ok(text.includes(label('Recorded: {at}')), `${scene.name}: legacy note honestly says Recorded`);
      assert.ok(!text.includes(label('Coverage: {at}')), `${scene.name}: legacy at must not imply Coverage`);
      assert.ok(!text.includes(label('Generated: {at}')), `${scene.name}: legacy generated time is unknown`);
    } else {
      assert.ok(text.includes(label('Coverage: {at}')), `${scene.name}: explicit public-snapshot Coverage visible`);
      assert.ok(text.includes(label('Generated: {at}')), `${scene.name}: explicit Generated time visible`);
      assert.ok(!text.includes(label('Recorded: {at}')));
    }
    const phase = scene.progressPhase === 'off' ? 'model backend off' : scene.progressPhase === 'paused' ? 'models paused'
      : scene.progressPhase === 'queued' ? 'queued' : 'writing';
    assert.ok(text.includes(compact(t(phase))), `${scene.name}: explicit progress context and lifecycle rendered`);
  });
});

test('visual semantics: normalization retains spaces and diffs identify the exact case and row', () => {
  const normalized = normalizeVisualLines(['\u001b[31m中文\u001b[0m  ', 'abc   ']);
  assert.deepEqual(normalized, ['中文  ', 'abc   ']);
  assert.equal(visualLength(normalized[0]), 6);
  const original = { width: 6, height: 2, lines: normalized };
  const diff = frameDiff('panel/zh/tab/monitor/6x2', original, { ...original, lines: [normalized[0], 'abd   '] });
  assert.ok(diff?.includes('panel/zh/tab/monitor/6x2: first changed row 2'));
  assert.ok(diff?.includes('abc···') && diff.includes('abd···'), 'padding is visible in the actionable diff');
  assert.ok(diff?.includes(UPDATE_COMMAND));
  assert.equal(frameDiff('unchanged', original, original), null);
});

test('visual semantics: fixture generation is deterministic without reading a wall clock', () => {
  const original = Date.now;
  try {
    Date.now = () => { throw new Error('Visual fixture/render attempted to read a wall clock'); };
    assert.deepEqual(generateVisualBaseline(), generateVisualBaseline());
  } finally { Date.now = original; }
});

test('visual baselines: fixed-time EN/ZH textual frames match reviewed goldens', async context => {
  const updating = process.env.CODEX_HUD_UPDATE_VISUAL_BASELINES === '1';
  if (updating) assert.equal(process.env.CI, undefined,
    'Refusing to update visual baselines in CI (even CI=false). Review and update only on a local checkout.');
  const actual = generateVisualBaseline();
  for (const scene of scenes) assertDimensions(actual.frames[scene.name].lines, scene);
  const json = JSON.stringify(actual, null, 1) + '\n';
  assert.ok(Buffer.byteLength(json) <= BASELINE_LIMIT, `Human-readable golden must stay <=600 KiB, got ${Buffer.byteLength(json)} bytes`);
  if (updating) {
    writeFileSync(GOLDEN, json, 'utf8');
    context.diagnostic(`Updated ${scenes.length} synthetic textual frames (${Buffer.byteLength(json)} bytes). Review git diff -- tests/fixtures/visual-baselines.json`);
    return;
  }
  let raw: string;
  try { raw = readFileSync(GOLDEN, 'utf8'); } catch (error) {
    assert.fail(`Visual golden unavailable at ${GOLDEN}. Only after source/translations settle, review and run locally:\n${UPDATE_COMMAND}\n${String(error)}`);
  }
  assert.ok(raw.endsWith('\n') && !raw.includes('\r'), 'Golden uses stable LF newlines and one final newline');
  const expected = JSON.parse(raw) as VisualBaseline;
  assert.equal(expected.version, 1);
  assert.deepEqual(Object.keys(expected.frames), Object.keys(actual.frames), 'Visual case list changed; review coverage and intentionally update golden locally');
  for (const scene of scenes) await context.test(scene.name, () => {
    const mismatch = frameDiff(scene.name, expected.frames[scene.name], actual.frames[scene.name]);
    if (mismatch) assert.fail(mismatch);
  });
});
