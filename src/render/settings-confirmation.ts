import type { WorkbenchInput } from '../utils/workbench-input.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { t } from './i18n.js';
import { flowLines, monitorText, pair } from './monitor-text.js';
import { subTopRow, footRow, mark } from './workboard-rows.js';
import { stemLines } from './work-card.js';
import { SETTING_ROWS, rowValue, valueText, type SettingsPageState } from './settings-page.js';

export type SettingsLeaveChoice = 'save' | 'discard' | 'cancel';
export interface SettingsConfirmationState {
  choice: SettingsLeaveChoice;
  error?: string;
}
export interface SettingsConfirmationFrame {
  lines: string[];
  controls: Array<{ choice: SettingsLeaveChoice; x: number; y: number; width: number }>;
}
const CHOICES: readonly SettingsLeaveChoice[] = ['save', 'discard', 'cancel'];
const LABELS: Record<SettingsLeaveChoice, string> = {
  save: 'Save and leave',
  discard: 'Discard changes',
  cancel: 'Continue editing',
};
const SHORT: Record<SettingsLeaveChoice, string> = { save: 'Save', discard: 'Discard', cancel: 'Stay' };
const fit = (line: string, width: number) => {
  const clipped = truncateAnsi(line, width);
  return clipped + ' '.repeat(Math.max(0, width - visualLength(clipped)));
};

/** The dialog owns all input; hidden settings rows never receive a click. */
export function renderSettingsConfirmation(
  base: readonly string[],
  state: SettingsConfirmationState,
  width: number,
  height: number,
  navigationRows = 0,
  settings?: SettingsPageState
): SettingsConfirmationFrame {
  width = Math.max(0, Math.floor(width));
  height = Math.max(0, Math.floor(height));
  const lines = [subTopRow(t('Settings'), theme.board.attention(t('unsaved')), width)].slice(0, height);
  const controls: SettingsConfirmationFrame['controls'] = [];
  const changed = settings?.original
    ? SETTING_ROWS.filter((row) => rowValue(row, settings.draft) !== rowValue(row, settings.original!))
    : [];
  const remaining = height - lines.length;
  const message = state.error ? monitorText(state.error) : t('Save your changes before leaving?');
  // Three decisions take precedence over explanation in a short terminal.
  const messageRows = Math.max(0, Math.min(3, remaining - CHOICES.length));
  if (lines.length < height) lines.push('');
  lines.push(
    ...flowLines(message, width)
      .slice(0, messageRows)
      .map((line, i) =>
        theme.board.askTitle(
          fit(i === 0 && width >= 56 ? pair(line, t('{n} changed', { n: changed.length }), width) : line, width)
        )
      )
  );
  for (const row of changed) {
    if (lines.length >= height - 5) break;
    lines.push(
      ...stemLines(
        `${t(row.label)}  ${valueText(row, rowValue(row, settings!.original!))} ${mark('→', '->')} ${valueText(row, rowValue(row, settings!.draft))}`,
        width
      )
        .slice(0, height - 5 - lines.length)
        .map((line) => theme.board.slab(line))
    );
  }
  const shownChoices =
    height - lines.length < CHOICES.length
      ? [state.choice, ...CHOICES.filter((choice) => choice !== state.choice)]
      : CHOICES;
  for (const choice of shownChoices) {
    if (lines.length >= height) break;
    const selected = choice === state.choice;
    const label = t(width < 24 ? SHORT[choice] : LABELS[choice]);
    const text = `  ${label}`;
    controls.push({ choice, x: 0, y: lines.length, width });
    lines.push(selected ? theme.board.selected(fit(text, width)) : text);
  }
  while (lines.length < height - 1) lines.push('');
  if (lines.length < height) lines.push(footRow('', t('←→ choose  ⏎ confirm  esc keep editing'), width));
  return { lines: lines.map((line) => fit(line, width)), controls };
}

export function handleSettingsConfirmation(
  state: SettingsConfirmationState,
  input: WorkbenchInput,
  frame: SettingsConfirmationFrame
): { state: SettingsConfirmationState; action?: SettingsLeaveChoice } {
  if (input.type === 'mouse') {
    if (input.button !== 'left') return { state };
    const control = frame.controls.find((c) => input.y === c.y && input.x >= c.x && input.x < c.x + c.width);
    return control ? { state: { ...state, choice: control.choice }, action: control.choice } : { state };
  }
  if (input.type !== 'key') return { state };
  if (['escape', 'close', 'settings'].includes(input.key)) return { state, action: 'cancel' };
  if (input.key === 'settings-save') return { state: { ...state, choice: 'save' }, action: 'save' };
  if (input.raw === 'd') return { state: { ...state, choice: 'discard' }, action: 'discard' };
  if (input.raw === 'c') return { state, action: 'cancel' };
  if (['enter', 'space'].includes(input.key)) return { state, action: state.choice };
  const delta = ['left', 'up', 'shift-tab'].includes(input.key)
    ? -1
    : ['right', 'down', 'tab'].includes(input.key)
      ? 1
      : 0;
  if (!delta) return { state };
  const index = (CHOICES.indexOf(state.choice) + delta + CHOICES.length) % CHOICES.length;
  return { state: { ...state, choice: CHOICES[index] } };
}
