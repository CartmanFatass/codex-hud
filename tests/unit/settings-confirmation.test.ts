import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSettingsConfirmation, handleSettingsConfirmation, type SettingsConfirmationState } from '../../src/render/settings-confirmation.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { setLanguage } from '../../src/render/i18n.js';

const initial: SettingsConfirmationState = { choice: 'cancel' };
const draw = (state = initial, width = 48, height = 20, navRows = 1) =>
  renderSettingsConfirmation(['Navigation', 'Hidden settings'], state, width, height, navRows);

test('unsaved confirmation defaults to staying, owns clicks, and offers three explicit decisions', () => {
  const frame = draw();
  assert.match(stripAnsi(frame.lines.join('\n')), /Unsaved settings/);
  assert.deepEqual(frame.controls.map(c => c.choice), ['save', 'discard', 'cancel']);
  assert.equal(handleSettingsConfirmation(initial, { type: 'key', key: 'enter' }, frame).action, 'cancel');
  assert.equal(handleSettingsConfirmation(initial, { type: 'key', key: 'escape' }, frame).action, 'cancel');
  assert.equal(handleSettingsConfirmation(initial, { type: 'mouse', button: 'left', x: 2, y: 0 }, frame).action, undefined,
    'underlying navigation cannot bypass confirmation');
  assert.equal(handleSettingsConfirmation(initial, { type: 'paste', text: 'do not submit me' }, frame).action, undefined);
  for (const control of frame.controls) {
    for (const x of [control.x, control.x + control.width - 1]) {
      assert.equal(handleSettingsConfirmation(initial, { type: 'mouse', button: 'left', x, y: control.y }, frame).action, control.choice);
    }
  }
});

test('arrows and Tab change the choice, only explicit confirmation applies it', () => {
  const frame = draw();
  const discard = handleSettingsConfirmation(initial, { type: 'key', key: 'left' }, frame);
  assert.equal(discard.state.choice, 'discard');
  assert.equal(discard.action, undefined);
  assert.equal(handleSettingsConfirmation(discard.state, { type: 'key', key: 'enter' }, frame).action, 'discard');
  const save = handleSettingsConfirmation(discard.state, { type: 'key', key: 'up' }, frame);
  assert.equal(save.state.choice, 'save');
  assert.equal(handleSettingsConfirmation(save.state, { type: 'key', key: 'enter' }, frame).action, 'save');
  assert.equal(handleSettingsConfirmation(initial, { type: 'key', key: 'sort', raw: 's' }, frame).action, 'save');
  assert.equal(handleSettingsConfirmation(initial, { type: 'key', key: '', raw: 'd' }, frame).action, 'discard');
  assert.equal(handleSettingsConfirmation(initial, { type: 'key', key: '', raw: 'c' }, frame).action, 'cancel');
  assert.equal(handleSettingsConfirmation(initial, { type: 'key', key: 'reset' }, frame).action, undefined);
});

test('confirmation fits CJK/ANSI and tiny terminals, retaining the selected safe decision first', () => {
  const previous = setLanguage('zh');
  try {
    for (const width of [0, 8, 16, 24, 32, 48, 56, 80]) {
      for (const height of [0, 1, 4, 8, 20]) {
        const frame = draw(initial, width, height);
        assert.equal(frame.lines.length, height);
        assert.ok(frame.lines.every(line => visualLength(line) === width), `${width}x${height}`);
        assert.ok(frame.controls.every(c => c.y >= 0 && c.y < height && c.x + c.width <= width));
        if (frame.controls.length) assert.ok(frame.controls.some(c => c.choice === 'cancel'));
      }
    }
  } finally { setLanguage(previous); }
});

test('a save error is rendered safely and does not imply leaving or losing the choice', () => {
  const state: SettingsConfirmationState = { choice: 'save', error: 'Save failed: \x1b[31mdenied\ntry again' };
  const frame = draw(state);
  const text = stripAnsi(frame.lines.join('\n'));
  assert.match(text, /Save failed:/);
  assert.match(text, /denied/);
  assert.equal(handleSettingsConfirmation(state, { type: 'key', key: 'enter' }, frame).action, 'save');
  assert.equal(handleSettingsConfirmation(state, { type: 'key', key: 'escape' }, frame).action, 'cancel');
});
