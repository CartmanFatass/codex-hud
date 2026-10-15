import type { WorkbenchInput } from '../utils/workbench-input.js';
import { colors, theme, truncateAnsi, visualLength } from './colors.js';
import { t } from './i18n.js';
import { flowLines, monitorText } from './monitor-text.js';

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
  save: 'Save and leave', discard: 'Discard changes', cancel: 'Continue editing',
};
const SHORT: Record<SettingsLeaveChoice, string> = { save: 'Save', discard: 'Discard', cancel: 'Stay' };
const fit = (line: string, width: number) => {
  const clipped = truncateAnsi(line, width);
  return clipped + ' '.repeat(Math.max(0, width - visualLength(clipped)));
};

/** The dialog owns all input; hidden settings rows never receive a click. */
export function renderSettingsConfirmation(base: readonly string[], state: SettingsConfirmationState,
  width: number, height: number, navigationRows = 0): SettingsConfirmationFrame {
  width = Math.max(0, Math.floor(width)); height = Math.max(0, Math.floor(height));
  const lines = base.slice(0, Math.min(height, navigationRows));
  const controls: SettingsConfirmationFrame['controls'] = [];
  if (lines.length < height) lines.push(theme.strong(t('Unsaved settings')));
  const remaining = height - lines.length;
  const message = state.error ? monitorText(state.error) : t('Save your changes before leaving?');
  // Three decisions take precedence over explanation in a short terminal.
  const messageRows = Math.max(0, Math.min(3, remaining - CHOICES.length));
  lines.push(...flowLines(message, width).slice(0, messageRows).map(line => state.error ? theme.warning(line) : colors.dim(line)));
  const shownChoices = height-lines.length < CHOICES.length
    ? [state.choice,...CHOICES.filter(choice => choice !== state.choice)] : CHOICES;
  for (const choice of shownChoices) {
    if (lines.length >= height) break;
    const selected = choice === state.choice;
    const label = t(width < 24 ? SHORT[choice] : LABELS[choice]);
    const text = ` ${selected ? '›' : ' '} ${label}`;
    controls.push({ choice, x: 0, y: lines.length, width });
    lines.push(selected ? theme.selected(theme.strong(text)) : text);
  }
  if (lines.length < height) lines.push(colors.dim(t('←→ choose · Enter confirms · Esc keeps editing')));
  while (lines.length < height) lines.push('');
  return { lines: lines.map(line => fit(line, width)), controls };
}

export function handleSettingsConfirmation(state: SettingsConfirmationState, input: WorkbenchInput,
  frame: SettingsConfirmationFrame): { state: SettingsConfirmationState; action?: SettingsLeaveChoice } {
  if (input.type === 'mouse') {
    if (input.button !== 'left') return { state };
    const control = frame.controls.find(c => input.y === c.y && input.x >= c.x && input.x < c.x + c.width);
    return control ? { state: { ...state, choice: control.choice }, action: control.choice } : { state };
  }
  if (input.type !== 'key') return { state };
  if (['escape', 'close', 'settings'].includes(input.key)) return { state, action: 'cancel' };
  if (input.key === 'sort') return { state: { ...state, choice: 'save' }, action: 'save' };
  if (input.raw === 'd') return { state: { ...state, choice: 'discard' }, action: 'discard' };
  if (input.raw === 'c') return { state, action: 'cancel' };
  if (['enter', 'space'].includes(input.key)) return { state, action: state.choice };
  const delta = ['left', 'up', 'shift-tab'].includes(input.key) ? -1
    : ['right', 'down', 'tab'].includes(input.key) ? 1 : 0;
  if (!delta) return { state };
  const index = (CHOICES.indexOf(state.choice) + delta + CHOICES.length) % CHOICES.length;
  return { state: { ...state, choice: CHOICES[index] } };
}
