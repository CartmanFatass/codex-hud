import { defaultSettings, type HudSettings } from '../settings.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import { truncateAnsi, theme, visualLength, coloredBar } from './colors.js';
import { t } from './i18n.js';
import { fit, monitorText } from './monitor-text.js';
import { PANEL_WIDTHS } from '../utils/pane-width.js';
import { BAR_STYLES, THEMES } from './hud-config.js';
import { section, subTopRow, footRow, mark } from './workboard-rows.js';
import { stemLines } from './work-job-detail.js';

type SettingValue = string | number | boolean;
const CALL_FEATURES: Record<string, string> = {
  'job-sentence': 'Job sentence', 'native-sentence': 'Native sentence', 'waiting-brief': 'Panel translation', title: 'Decision title',
  probe: 'Probe', outcome: 'outcome', looping: 'looping',
  'question-category': 'Question category', 'review-severity': 'Review severity',
  'quiet-job': 'Quiet job', 'sonic-thinking': 'Sonic thinking', 'imp-routing': 'Imp routing', prewalk: 'Prewalk', 'pool-pick': 'Pool pick',
  'advisor-shadow': 'Advisor shadow',
};
export type SettingKey = keyof HudSettings;
export type SettingGroup = 'Display' | 'Panel' | 'Models' | 'Workers' | 'Codex';
export type SettingsAction = 'back' | 'save' | 'reset';
export interface SettingRow {
  key: SettingKey;
  role?: string;
  group: SettingGroup;
  label: string;
  values: readonly SettingValue[];
  help: string;
  advanced?: true;
  format?: (value: SettingValue) => string;
  literal?: boolean;
  get?: (settings: HudSettings) => SettingValue;
  set?: (value: SettingValue, settings: HudSettings) => Partial<HudSettings>;
}
const seconds = (value: SettingValue) => `${Number(value) / 1000}s`;
const callCap = (value: SettingValue) => Number(value) === 0 ? t('unlimited') : `${value}/h`;
const roleCap = (value: SettingValue) => Number(value) === 0 ? t('unlimited') : String(value);
const NOTIFY_WORDS: Record<string, string> = { off: 'off', tmux: 'tmux', desktop: 'tmux + desktop' };
export const SETTING_ROWS: readonly SettingRow[] = [
  {
    key: 'theme',
    group: 'Display',
    label: 'Theme',
    values: THEMES,
    help: 'Colours of bar and panel',
  },
  {
    key: 'barStyle',
    group: 'Display',
    label: 'Bar style',
    values: BAR_STYLES,
    help: 'Look of the bottom bars',
    advanced: true,
    literal: true,
  },
  { key: 'icons', group: 'Display', label: 'Icons', values: ['nerd', 'unicode', 'text'], help: 'Nerd Font glyphs, Unicode marks, or words (text)', advanced: true },
  {
    key: 'language',
    group: 'Display',
    label: 'Language',
    values: ['auto', 'en', 'zh'],
    help: 'Panel interface language; source text stays unchanged',
  },
  {
    key: 'treeWidth',
    group: 'Panel',
    label: 'Width',
    values: PANEL_WIDTHS,
    help: 'Panel columns for every client; the agent pane keeps 41',
    format: (value) => (Number(value) === 0 ? 'auto' : t('{n} cols', { n: Number(value) })),
  },
  {
    key: 'notify',
    group: 'Panel',
    label: 'Notifications',
    values: ['off', 'tmux', 'desktop'],
    help: 'Approvals, failures: tmux, or desktop too',
    format: (value) => NOTIFY_WORDS[String(value)] ?? String(value),
    get: (settings) => (settings.notify ? (settings.notifyDesktop ? 'desktop' : 'tmux') : 'off'),
    set: (value) => ({ notify: value !== 'off', notifyDesktop: value === 'desktop' }),
  },
  {
    key: 'refreshMs',
    group: 'Panel',
    label: 'Refresh',
    values: [500, 1000, 2000, 5000],
    help: 'How often the panel reads',
    advanced: true,
    format: seconds,
  },
  { key: 'mouse', group: 'Panel', label: 'Mouse', values: [true, false], help: 'Click and scroll the panel', advanced: true },
  { key: 'openPreviews', group: 'Panel', label: 'Open previews', values: [true, false], help: 'Open report HTML previews in the default browser' },
  {
    key: 'decisionApi', group: 'Models', label: 'Decision API', values: ['gemini', 'openai', 'anthropic', 'typesafe'],
    help: 'Primary for Jev and execution decisions; automatic fallback uses another keyed provider',
    format: (value) => ({ gemini: 'Gemini', openai: 'OpenAI', anthropic: 'Anthropic', typesafe: 'TypeSafe' })[String(value)] ?? String(value),
  },
  { key: 'decisionCallsPerHour', group: 'Models', label: 'Decision cap', values: [600, 2000, 0],
    help: 'Decision-API calls per hour (quiet jobs, Sonic thinking, Imp routing, prewalk)', advanced: true, format: callCap },
  { key: 'quietJobDecision', group: 'Models', label: 'Quiet job', values: [true, false],
    help: 'Send the quiet worker’s pane tail to the Decision API; off hands the job back to main' },
  { key: 'sonicAutoThinking', group: 'Models', label: 'Sonic auto-thinking', values: [false, true],
    help: 'Send the Sonic task text to the Decision API to choose its thinking level' },
  { key: 'autoPrewalk', group: 'Models', label: 'Auto prewalk', values: [true, false],
    help: 'Run automatic prewalk scouts and pool picks before enabled roles; off disables all automatic prewalks' },
  { key: 'poolPick', group: 'Models', label: 'Pool pick', values: [true, false],
    help: 'Select design references before launch; off skips the pick and attaches nothing' },
  { key: 'advisorShadow', group: 'Models', label: 'Advisor shadow', values: [false, true],
    help: 'Send new main-session messages, previous reply and skill index to the Decision API; shown only, never injected' },
  { key: 'impPlacement', group: 'Models', label: 'Imp placement', values: ['fixed', 'even', 'auto'],
    help: 'Fixed: active preset. Even: spread starts across the pool. Auto: send the Imp brief, ticket and context file names and sizes to the Decision API' },
  { key: 'impEvenPool', group: 'Models', label: 'Even pool', values: [],
    help: 'Choose an Imp preset with ←→; Enter includes or excludes it', get: settings => settings.impEvenPool.join(', ') },
  { key: 'sonicPlacement', group: 'Models', label: 'Sonic placement', values: ['fixed', 'even'],
    help: 'Fixed: active preset. Even: spread starts across the pool' },
  { key: 'sonicEvenPool', group: 'Models', label: 'Sonic even pool', values: [],
    help: 'Choose a Sonic preset with ←→; Enter includes or excludes it', get: settings => settings.sonicEvenPool.join(', ') },
  {
    key: 'roleCaps',
    role: 'imp',
    group: 'Workers',
    label: 'imp cap',
    values: [1, 2, 3, 4, 5, 6, 8, 10, 0],
    help: 'Max concurrently working imp jobs; extra creates overflow or queue',
    advanced: true,
    format: roleCap,
    get: (settings) => settings.roleCaps.imp ?? 0,
    set: (value, settings) => ({ roleCaps: { ...settings.roleCaps, imp: Number(value) } }),
  },
  {
    key: 'roleCaps',
    role: 'general',
    group: 'Workers',
    label: 'general cap',
    values: [1, 2, 3, 4, 5, 6, 8, 10, 0],
    help: 'Max concurrently working general jobs; extra creates queue',
    advanced: true,
    format: roleCap,
    get: (settings) => settings.roleCaps.general ?? 0,
    set: (value, settings) => ({ roleCaps: { ...settings.roleCaps, general: Number(value) } }),
  },
  {
    key: 'impOverflow',
    group: 'Workers',
    label: 'imp→general overflow',
    values: [true, false],
    help: 'Start an imp job as general when imp is full and general has room',
    advanced: true,
  },
  {
    key: 'statusline',
    group: 'Codex',
    label: 'Bar on launch',
    values: [true, false],
    help: 'Next launch: one-line bar',
  },
];
export const ADVANCED = SETTING_ROWS.length;
const MAIN_INDICES = SETTING_ROWS.flatMap((row, i) => (row.advanced ? [] : [i]));
const ADVANCED_INDICES = SETTING_ROWS.flatMap((row, i) => (row.advanced ? [i] : []));
function clampSelected(selected: number): number {
  return Math.min(ADVANCED, Math.max(0, selected));
}
function isAdvancedOpen(state: Pick<SettingsPageState, 'selected' | 'advanced'>): boolean {
  const selected = clampSelected(state.selected);
  return Boolean(state.advanced || (selected < SETTING_ROWS.length && SETTING_ROWS[selected].advanced));
}
type PoolKey = 'impEvenPool' | 'sonicEvenPool';
const POOL_ROWS: Record<PoolKey, {
  placement: 'impPlacement' | 'sonicPlacement';
  presets: 'impPresets' | 'sonicPresets';
  index: 'poolIndex' | 'sonicPoolIndex';
  none: string;
}> = {
  impEvenPool: { placement: 'impPlacement', presets: 'impPresets', index: 'poolIndex', none: 'No Imp presets' },
  sonicEvenPool: { placement: 'sonicPlacement', presets: 'sonicPresets', index: 'sonicPoolIndex', none: 'No Sonic presets' },
};
const isPoolKey = (key: SettingKey | undefined): key is PoolKey => !!key && Object.hasOwn(POOL_ROWS, key);

function mainIndices(draft: HudSettings): readonly number[] {
  return MAIN_INDICES.filter(i => {
    const key = SETTING_ROWS[i].key;
    return !isPoolKey(key) || draft[POOL_ROWS[key].placement] === 'even';
  });
}
function visualGroup(index: number): SettingGroup | 'Advanced' {
  return index === ADVANCED || SETTING_ROWS[index]?.advanced ? 'Advanced' : SETTING_ROWS[index].group;
}
export function rowValue(row: SettingRow, settings: HudSettings): SettingValue {
  return row.get ? row.get(settings) : (settings[row.key] as SettingValue);
}
export function withRowValue(settings: HudSettings, row: SettingRow, value: SettingValue): HudSettings {
  return { ...settings, ...(row.set ? row.set(value, settings) : { [row.key]: value }) };
}
export interface SettingsPageState {
  draft: HudSettings;
  impPresets?: readonly string[];
  sonicPresets?: readonly string[];
  poolIndex?: number;
  sonicPoolIndex?: number;
  selected: number;
  offset: number;
  message: string;
  original?: HudSettings;
  decisionKeys?: Partial<Record<HudSettings['decisionApi'], boolean>>;
  revealed?: number;
  advanced?: boolean;
}
export function settingGroup(stateOrRow: Pick<SettingsPageState, 'selected'> | SettingRow): SettingGroup {
  return 'group' in stateOrRow
    ? stateOrRow.group
    : SETTING_ROWS[Math.min(SETTING_ROWS.length - 1, Math.max(0, stateOrRow.selected))].group;
}
const sameSettingValue = (a: unknown, b: unknown): boolean =>
  a === b || (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));
export function settingsDirty(state: Pick<SettingsPageState, 'draft' | 'original'>): boolean {
  return (
    !!state.original &&
    (Object.keys(defaultSettings()) as Array<keyof HudSettings>).some(
      (key) => !sameSettingValue(state.draft[key], state.original![key])
    )
  );
}
const RESET_FIELDS: Record<SettingGroup, readonly (keyof HudSettings)[]> = {
  Display: ['theme', 'barStyle', 'icons', 'language'],
  Panel: ['treeWidth', 'notify', 'notifyDesktop', 'refreshMs', 'mouse', 'openPreviews'],
  Models: ['decisionCallsPerHour', 'quietJobDecision', 'sonicAutoThinking', 'autoPrewalk', 'poolPick', 'advisorShadow', 'impPlacement', 'impEvenPool', 'sonicPlacement', 'sonicEvenPool'],
  Workers: ['roleCaps', 'impOverflow'],
  Codex: ['statusline'],
};
export function resetSettingsGroup(draft: HudSettings, group: string): HudSettings {
  if (!Object.hasOwn(RESET_FIELDS, group)) return draft;
  const defaults = defaultSettings(),
    patch: Partial<HudSettings> = {};
  for (const key of RESET_FIELDS[group as SettingGroup]) Object.assign(patch, { [key]: defaults[key] });
  return { ...draft, ...patch };
}
export interface SettingsFrame {
  lines: string[];
  state: SettingsPageState;
  rows: Array<number | null>;
  back?: { y: number; x: number };
  footerY: number;
  saveX?: number;
  maxOffset?: number;
}
export function valueText(row: SettingRow, value: SettingValue): string {
  const text = typeof value === 'boolean' ? (value ? 'on' : 'off') : row.format ? row.format(value) : String(value);
  return row.literal && value !== '' ? text : t(text);
}
export function renderSettingsPage(
  state: SettingsPageState,
  width: number,
  height: number,
  health?: {
    decisionCalls?: { lastHour: number; byFeature: Record<string, number> };
  }
): SettingsFrame {
  width = Math.max(0, Math.floor(width));
  height = Math.max(0, Math.floor(height));
  const clamped = clampSelected(state.selected), clampedKey = SETTING_ROWS[clamped]?.key;
  const selected = isPoolKey(clampedKey) && state.draft[POOL_ROWS[clampedKey].placement] !== 'even' ? clamped - 1 : clamped,
    advanced = isAdvancedOpen({ selected, advanced: state.advanced }),
    original = state.original ?? { ...state.draft, roleCaps: { ...state.draft.roleCaps } },
    defaults = defaultSettings();
  const dirty = settingsDirty({ ...state, original }),
    content: { text: string; index?: number; back?: number; counter?: boolean }[] = [];
  const pushRow = (i: number) => {
    const row = SETTING_ROWS[i],
      value = rowValue(row, state.draft),
      changed = rowValue(row, original) !== value,
      active = rowValue(row, defaults) !== value;
    const rawLabel = row.advanced ? `${t(row.group)} · ${t(row.label)}` : t(row.label);
    const displayLabel = row.advanced
      ? `${i === selected ? `${t(row.group)} ·` : theme.board.muted(`${t(row.group)} ·`)} ${t(row.label)}`
      : t(row.label);
    const pool = isPoolKey(row.key) ? POOL_ROWS[row.key] : undefined;
    const preset = pool ? state[pool.presets]?.[state[pool.index] ?? 0] : undefined;
    const displayValue = !pool ? valueText(row, value) : i !== selected ? String(value || t('empty'))
      : preset ? `${monitorText(preset)} · ${t(state.draft[row.key as PoolKey].includes(preset) ? 'included' : 'excluded')}` : t(pool.none);
    const shown = truncateAnsi(
        displayValue + (row.key === 'decisionApi' && !state.decisionKeys?.[value as HudSettings['decisionApi']] ? ` ${t('(no key)')}` : ''),
        Math.max(1, width - visualLength(rawLabel) - (i === selected ? 7 : 3))
      ),
      tail = i === selected ? `${mark('‹', '<')} ${shown} ${mark('›', '>')}` : shown;
    const ink = active ? theme.board.active : (s: string) => s;
    const left = `${changed ? theme.board.attention('*') : ' '} ${displayLabel}`;
    const name = truncateAnsi(left, Math.max(0, width - visualLength(tail) - 1));
    const text = fit(name, Math.max(0, width - visualLength(tail))) + ink(tail);
    content.push({
      text: i === selected ? boardSelected(fit(text, width)) : text,
      index: i,
      back: i === selected ? Math.max(0, width - visualLength(tail)) : undefined,
    });
    if (i === selected)
      for (const text of stemLines(t(state.message || row.help), width)) content.push({ text });
    if (row.key === 'decisionCallsPerHour') {
      const usage = health?.decisionCalls,
        cap = state.draft.decisionCallsPerHour,
        n = usage?.lastHour;
      if (n !== undefined) {
        const atCap = cap > 0 && n >= cap, label = '  ' + t('Decision calls this hour');
        const count = `${n}/${cap || '∞'}`;
        const value = cap > 0 && visualLength(label + count) + 12 <= width
          ? `${coloredBar(Math.min(100, (n * 100) / cap), 10)} ${count}` : count;
        content.push({
          text: fit(label, Math.max(0, width - visualLength(value))) +
            (atCap ? theme.board.danger(value) : theme.board.muted(value)),
          counter: true,
        });
        if (n > 0 && usage?.byFeature) {
          // Retired features still count toward the cap until their existing reservations age out.
          const parts = Object.entries(usage.byFeature)
            .filter(([feature, count]) => count > 0 && !['kind', 'home-ranking', 'home-brief'].includes(feature))
            .sort((a, b) => b[1] - a[1]).map(([feature, count]) => `${t(CALL_FEATURES[feature] ?? 'Earlier format')} ${count}`);
          if (parts.length) content.push({ text: theme.board.muted(truncateAnsi('  ' + parts.join(' · '), width)) });
        }
      }
    }
  };
  let lastGroup: SettingGroup | undefined;
  for (const i of mainIndices(state.draft)) {
    const row = SETTING_ROWS[i];
    if (lastGroup !== row.group) {
      content.push({ text: '' }, { text: section(t(row.group), width).text });
      lastGroup = row.group;
    }
    pushRow(i);
  }
  content.push({ text: '' }, { text: section(t('Advanced'), width).text });
  const advChanged = !advanced && ADVANCED_INDICES.some((i) => rowValue(SETTING_ROWS[i], original) !== rowValue(SETTING_ROWS[i], state.draft));
  const advActive = !advanced && ADVANCED_INDICES.some((i) => rowValue(SETTING_ROWS[i], defaults) !== rowValue(SETTING_ROWS[i], state.draft));
  const advTail = advanced ? `${t('open')} ${mark('▾', 'v')}` : `${t('closed')} ${mark('›', '>')}`;
  const advInk = advActive ? theme.board.active : (s: string) => s;
  const advLeft = `${advChanged ? theme.board.attention('*') : ' '} ${t('Advanced ({n})', { n: ADVANCED_INDICES.length })}`;
  const advName = truncateAnsi(advLeft, Math.max(0, width - visualLength(advTail) - 1));
  const advText = fit(advName, Math.max(0, width - visualLength(advTail))) + advInk(advTail);
  content.push({
    text: selected === ADVANCED ? boardSelected(fit(advText, width)) : advText,
    index: ADVANCED,
  });
  if (selected === ADVANCED)
    for (const text of stemLines(
      state.message ? t(state.message) : t('Rarely changed settings; Enter to show or hide'),
      width
    ))
      content.push({ text });
  if (advanced) for (const i of ADVANCED_INDICES) pushRow(i);
  const room = Math.max(0, height - 2),
    at = content.findIndex((r) => r.index === selected),
    maxOffset = Math.max(0, content.length - room);
  let offset = Math.max(0, Math.min(state.offset, maxOffset));
  if (state.revealed !== selected) {
    if (at < offset) offset = Math.max(0, at - 1);
    const helpEnd = content.findIndex((r, i) => i > at && r.index !== undefined);
    const counter = SETTING_ROWS[selected]?.key === 'decisionCallsPerHour' ? content.findIndex((row) => row.counter) : -1;
    const reveal = counter >= 0 ? counter : Math.min(at + 3, helpEnd < 0 ? content.length - 1 : helpEnd - 1);
    if (room && reveal >= offset + room) offset = Math.min(at, reveal - room + 1);
  }
  const body = content.slice(offset, offset + room),
    lines = [
      subTopRow(t('Settings'), dirty ? theme.board.attention(t('unsaved')) : '', width),
      ...body.map((r) => r.text),
    ];
  while (lines.length < height - 1) lines.push('');
  const hints = selected === ADVANCED
    ? [advanced ? '⏎ collapse' : '⏎ expand', 's save', 'Esc back']
    : [...(isPoolKey(SETTING_ROWS[selected]?.key) ? ['←→ choose', '⏎ toggle'] : ['←→ change']), 's save', 'Esc back', 'r reset'];
  if (height > 1) lines.push(footRow('', hints, width));
  const back = body.findIndex((r) => r.back !== undefined);
  return {
    lines: lines.slice(0, height).map((s) => fit(s, width)),
    rows: [null, ...body.map((r) => r.index ?? null)],
    state: { ...state, original, selected, offset, revealed: selected, advanced },
    back: back < 0 ? undefined : { y: back + 1, x: body[back].back! },
    footerY: height - 1,
    saveX: dirty ? width - visualLength(t('unsaved')) : undefined,
    maxOffset,
  };
}
const boardSelected = (text: string) => theme.board.selected(text);
export function handleSettingsInput(
  state: SettingsPageState,
  input: WorkbenchInput,
  frame: SettingsFrame
): { state: SettingsPageState; action?: SettingsAction } {
  const next: SettingsPageState = {
    ...state,
    original: state.original ?? frame.state.original,
    selected: frame.state.selected,
    advanced: isAdvancedOpen({ selected: state.selected, advanced: state.advanced ?? frame.state.advanced }),
  };
  let key = input.type === 'key' ? input.key : '';
  if (input.type === 'mouse') {
    if (input.button === 'left' && input.y === 0)
      return {
        state: next,
        action: frame.saveX !== undefined && input.x >= frame.saveX ? 'save' : 'back',
      };
    if (input.button === 'left') {
      const index = frame.rows[input.y];
      if (index === null || index === undefined) return { state: next };
      if (index === ADVANCED) {
        next.selected = ADVANCED;
        next.advanced = !next.advanced;
        next.message = '';
        next.revealed = undefined;
        return { state: next };
      }
      if (index !== frame.state.selected) {
        next.selected = index;
        next.message = '';
        return { state: next };
      }
      const onBack =
        frame.back?.y === input.y &&
        input.x >= frame.back.x &&
        input.x <= frame.back.x + 1;
      key = isPoolKey(SETTING_ROWS[index].key) && input.x < (frame.back?.x ?? 0) ? 'enter' : onBack ? 'left' : 'right';
    } else {
      const delta = input.button === 'wheel-down' ? 3 : -3;
      next.offset = Math.max(0, Math.min(frame.maxOffset ?? Infinity, next.offset + delta));
      next.revealed = next.selected;
      return { state: next };
    }
  }
  if (key === 'escape' || key === 'settings' || key === 'close') return { state: next, action: 'back' };
  if (key === 'settings-save') return { state: next, action: 'save' };
  if (key === 'reset') {
    if (next.selected === ADVANCED) {
      next.message = t('Choose a row to reset its group');
      return { state: next };
    }
    return { state: next, action: 'reset' };
  }
  const visible = [...mainIndices(next.draft), ADVANCED, ...(next.advanced ? ADVANCED_INDICES : [])];
  const pos = Math.max(0, visible.indexOf(next.selected));
  const moved = next.selected;
  if (key === 'down' || key === 'tab') next.selected = visible[Math.min(visible.length - 1, pos + 1)];
  if (key === 'up' || key === 'shift-tab') next.selected = visible[Math.max(0, pos - 1)];
  if (key === 'page-down') {
    const group = visualGroup(visible[pos]);
    const after = visible.findIndex((rowIndex, i) => i > pos && visualGroup(rowIndex) !== group);
    if (after >= 0) next.selected = visible[after];
  }
  if (key === 'page-up') {
    const start = (i: number) => {
      while (i > 0 && visualGroup(visible[i - 1]) === visualGroup(visible[i])) i--;
      return i;
    };
    const here = start(pos);
    next.selected = visible[here < pos ? here : start(Math.max(0, here - 1))];
  }
  if (key === 'home') next.selected = visible[0];
  if (key === 'end') next.selected = visible[visible.length - 1];
  if (next.selected !== moved) next.message = '';
  if (key === 'enter' || key === 'left' || key === 'right') {
    if (next.selected === ADVANCED) {
      next.advanced = !next.advanced;
      next.message = '';
      next.revealed = undefined;
      return { state: next };
    }
    const row = SETTING_ROWS[next.selected];
    if (isPoolKey(row.key)) {
      const cfg = POOL_ROWS[row.key];
      const presets = next[cfg.presets] ?? [], index = next[cfg.index] ?? 0, preset = presets[index];
      if (key === 'enter' && preset) {
        const pool = next.draft[row.key];
        next.draft = { ...next.draft, [row.key]: pool.includes(preset) ? pool.filter(name => name !== preset) : [...pool, preset] };
      } else if (presets.length && key !== 'enter') next[cfg.index] = (index + presets.length + (key === 'left' ? -1 : 1)) % presets.length;
      next.message = '';
      return { state: next };
    }
    const values = row.values, current = rowValue(row, next.draft);
    let index = values.indexOf(current);
    if (index < 0 && typeof current === 'number') {
      const descending = Number(values[0]) > Number(values[1]);
      const beyond = values.findIndex((value) => (descending ? Number(value) < current : Number(value) > current));
      index = key === 'left' ? (beyond < 0 ? values.length : beyond) : beyond < 0 ? values.length - 1 : beyond - 1;
    } else if (index < 0) index = key === 'left' ? 0 : -1;
    const value = values[(index + (key === 'left' ? values.length - 1 : 1) + values.length) % values.length];
    next.draft = withRowValue(next.draft, row, value);
    next.message = '';
  }
  return { state: next };
}
