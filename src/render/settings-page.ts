import { SHIPPED_MODELS_CATALOG } from '../models/catalog.js';
import { defaultSettings, type HudSettings } from '../settings.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { HudHealthState } from '../types.js';
import { truncateAnsi, theme, visualLength, coloredBar } from './colors.js';
import { t } from './i18n.js';
import { fit, monitorText } from './monitor-text.js';
import { PANEL_WIDTHS } from '../utils/pane-width.js';
import { BAR_STYLES, THEMES } from './hud-config.js';
import type { ModelProbeState } from '../collectors/model-probe.js';
import { section, subTopRow, footRow, mark } from './workboard-rows.js';
import { stemLines } from './work-card.js';

type SettingValue = string | number | boolean;
const CALL_FEATURES: Record<string, string> = {
  'job-sentence': 'Job sentence', 'native-sentence': 'Native sentence', 'try-brief': 'Try brief', 'waiting-brief': 'Panel translation', title: 'Decision title',
  'home-brief': 'Home brief', probe: 'Probe', outcome: 'outcome', kind: 'kind', looping: 'looping',
  'question-category': 'Question category', 'review-severity': 'Review severity', 'home-ranking': 'Home ranking',
  'quiet-job': 'Quiet job', 'sonic-thinking': 'Sonic thinking',
};
const PROBE_FAILURES: Record<string, string> = {
  auth: 'Authentication failed',
  'model-not-found': 'Model not found',
  'rate-limit': 'Rate limited',
  timeout: 'Request timed out',
  network: 'Connection failed',
  server: 'Service unavailable',
  'invalid-response': 'Invalid response',
  'output-limit': 'Output limit reached',
  'hourly-cap': 'Call cap reached',
  'runtime-unavailable': 'Budget store unavailable',
};
export type SettingKey = keyof HudSettings;
export type SettingGroup = 'Display' | 'Panel' | 'Models' | 'Workers' | 'Codex';
export type SettingsAction = 'back' | 'save' | 'reset' | 'test-api';
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
  { key: 'icons', group: 'Display', label: 'Icons', values: ['unicode', 'text'], help: 'Icons, or words (text)', advanced: true },
  {
    key: 'language',
    group: 'Display',
    label: 'Language',
    values: ['auto', 'en', 'zh'],
    help: 'Panel and everything a model writes',
  },
  { key: 'homeMode', group: 'Panel', label: 'Home mode', values: ['default', 'recommended'],
    help: 'Rank Home cards and show a progress brief through models', format: (value) => t(value === 'recommended' ? 'Recommended' : 'Default') },
  { key: 'panelLayout', group: 'Panel', label: 'Layout', values: ['classic', 'split'],
    help: 'Home, Project and Control: Classic is the default; Split puts a list over a preview of the selected row',
    format: (value) => t(({ classic: 'Classic', split: 'Split' } as Record<string, string>)[String(value)] ?? String(value)) },
  { key: 'projectLayout', group: 'Panel', label: 'Project layout', values: ['timeline', 'board', 'inbox'],
    help: 'Project tab: Timeline is the default; Board shows a milestone map and project table; Inbox puts what needs you first',
    format: (value) => t(({ timeline: 'Timeline', board: 'Board', inbox: 'Inbox' } as Record<string, string>)[String(value)] ?? String(value)) },
  { key: 'acceptance', group: 'Panel', label: 'Detail', values: ['task', 'slice'],
    help: 'Show milestones and features as tasks, or show individual slices and tickets', format: (value) => t(String(value)) },
  {
    key: 'treeWidth',
    group: 'Panel',
    label: 'Width',
    values: PANEL_WIDTHS,
    help: 'Panel columns for every client; the agent pane keeps 41',
    format: (value) => (Number(value) === 0 ? 'auto' : t('{n} cols', { n: Number(value) })),
  },
  {
    key: 'cardStallMinutes',
    group: 'Panel',
    label: 'Stall threshold',
    values: [5, 10, 15, 30, 60],
    help: 'Minutes without new evidence; presentation only',
    advanced: true,
    format: (value) => t('{n}m', { n: Number(value) }),
  },
  { key: 'cardFoldMinutes', group: 'Panel', label: 'Fold after', values: [1, 2, 5, 10, 15, 30],
    help: 'Finished jobs and agents shrink to one row after this long; Enter opens one', advanced: true, format: (value) => t('{n}m', { n: Number(value) }) },
  { key: 'cardHideMinutes', group: 'Panel', label: 'Hide after', values: [5, 10, 15, 30, 60, 120],
    help: 'Finished jobs and agents leave Home after this long (a shows them); failed ones stay 30m at least', advanced: true, format: (value) => t('{n}m', { n: Number(value) }) },
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
  { key: 'experiments', group: 'Panel', label: 'Experiments', values: [false, true], help: 'Show EXP usage settings for this machine', advanced: true },
  {
    key: 'modelEnabled',
    group: 'Models',
    label: 'Model text',
    values: [true, false],
    help: 'Sends public agent material for display text; off sends nothing',
  },
  {
    key: 'model',
    group: 'Models',
    label: 'Model',
    values: SHIPPED_MODELS_CATALOG.defaults.summary.settingsChoices,
    help: 'Chat-completions model; edit model in hud-settings.json for another ID',
    literal: true,
  },
  {
    key: 'decisionApi', group: 'Models', label: 'Decision API', values: ['gemini', 'openai', 'typesafe'],
    help: 'Primary for Jev and display labels; automatic fallback uses another keyed provider',
    format: (value) => ({ gemini: 'Gemini', openai: 'OpenAI', typesafe: 'TypeSafe' })[String(value)] ?? String(value),
  },
  {
    key: 'modelCallsPerHour',
    group: 'Models',
    label: 'Call cap',
    values: [30, 60, 120, 240, 0],
    help: 'LLM calls per hour (sentences, titles, brief)',
    format: callCap,
  },
  { key: 'decisionCallsPerHour', group: 'Models', label: 'Decision cap', values: [600, 2000, 0],
    help: 'Decision-API calls per hour (labels, Home ranking, Sonic thinking)', advanced: true, format: callCap },
  { key: 'sonicAutoThinking', group: 'Models', label: 'Sonic auto-thinking', values: [false, true],
    help: 'Send the Sonic task text to the Decision API to choose its thinking level' },
  { key: 'summaryIntervalMinutes', group: 'Models', label: 'Summary interval', values: [2, 5, 10, 15, 30],
    help: "How often a running job's sentence and Home's brief may refresh", advanced: true, format: (value) => t('{n}m', { n: Number(value) }) },
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
function visibleIndices(advanced: boolean): number[] {
  return advanced ? [...MAIN_INDICES, ADVANCED, ...ADVANCED_INDICES] : [...MAIN_INDICES, ADVANCED];
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
  Panel: ['homeMode', 'panelLayout', 'projectLayout', 'acceptance', 'treeWidth', 'cardStallMinutes', 'cardFoldMinutes', 'cardHideMinutes', 'notify', 'notifyDesktop', 'refreshMs', 'mouse', 'experiments'],
  Models: ['modelEnabled', 'decisionCallsPerHour', 'sonicAutoThinking', 'summaryIntervalMinutes'],
  Workers: ['roleCaps', 'impOverflow'],
  Codex: ['statusline'],
};
export function resetSettingsGroup(draft: HudSettings, group: string): HudSettings {
  if (!Object.hasOwn(RESET_FIELDS, group)) return draft;
  const defaults = defaultSettings(),
    patch: Partial<HudSettings> = {};
  for (const key of RESET_FIELDS[group as SettingGroup]) Object.assign(patch, { [key]: defaults[key] });
  if (group === 'Models') patch.modelEnabled = false;
  return { ...draft, ...patch };
}
export interface SettingsFrame {
  lines: string[];
  state: SettingsPageState;
  rows: Array<number | null>;
  back?: { y: number; x: number };
  footerY: number;
  saveX?: number;
  probeAction?: { y: number; width: number };
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
    state: HudHealthState | undefined;
    nowMs?: number;
    modelCalls?: { today: number; lastHour: number; cap: number; byFeature?: Record<string, number> };
    decisionCalls?: { lastHour: number; cap: number; byFeature?: Record<string, number> };
    probe?: ModelProbeState;
    settingsFile?: string;
  }
): SettingsFrame {
  width = Math.max(0, Math.floor(width));
  height = Math.max(0, Math.floor(height));
  const selected = clampSelected(state.selected),
    advanced = isAdvancedOpen({ selected, advanced: state.advanced }),
    original = state.original ?? { ...state.draft, roleCaps: { ...state.draft.roleCaps } },
    defaults = defaultSettings();
  const dirty = settingsDirty({ ...state, original }),
    content: { text: string; index?: number; back?: number; probe?: boolean }[] = [];
  const pushRow = (i: number) => {
    const row = SETTING_ROWS[i],
      value = rowValue(row, state.draft),
      changed = rowValue(row, original) !== value,
      active = rowValue(row, defaults) !== value;
    const rawLabel = row.advanced ? `${t(row.group)} · ${t(row.label)}` : t(row.label);
    const displayLabel = row.advanced
      ? `${i === selected ? `${t(row.group)} ·` : theme.board.muted(`${t(row.group)} ·`)} ${t(row.label)}`
      : t(row.label);
    const shown = truncateAnsi(
        valueText(row, value) + (row.key === 'decisionApi' && !state.decisionKeys?.[value as HudSettings['decisionApi']] ? ` ${t('(no key)')}` : ''),
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
      for (const text of stemLines(
        t(state.message || row.help) + (row.key === 'model' ? ' · ' + t('Keys: $HUD_HOME/credentials.env') : ''),
        width
      ))
        content.push({ text });
    if (row.key === 'modelCallsPerHour' || row.key === 'decisionCallsPerHour') {
      const decision = row.key === 'decisionCallsPerHour';
      const usage = decision ? health?.decisionCalls : health?.modelCalls,
        cap = usage?.cap ?? state.draft[row.key],
        n = usage?.lastHour;
      if (n !== undefined) {
        const atCap = cap > 0 && n >= cap,
          value = cap === 0 ? `${n}/∞` : `${coloredBar(Math.min(100, (n * 100) / cap), 10)} ${n}/${cap}`;
        content.push({
          text:
            fit('  ' + t(decision ? 'Decision calls this hour' : 'Calls this hour'), Math.max(0, width - visualLength(value))) +
            (atCap ? theme.board.danger(value) : theme.board.muted(value)),
        });
        if (n > 0 && usage?.byFeature) {
          const parts = Object.entries(usage.byFeature).filter(([, count]) => count > 0)
            .sort((a, b) => b[1] - a[1]).map(([feature, count]) => `${t(CALL_FEATURES[feature] ?? 'Earlier format')} ${count}`);
          if (parts.length) content.push({ text: theme.board.muted(truncateAnsi('  ' + parts.join(' · '), width)) });
        }
        if (atCap) content.push(...stemLines(t(decision ? 'at the cap: labels wait' : 'at the cap: sentences wait'), width).map((text) => ({ text })));
      }
      if (decision) return;
      const probe = health?.probe,
        failed = probe?.rows.find((r) => r.status === 'failed');
      const label = probe?.running
        ? t('testing…')
        : failed
          ? `${mark('✗', 'x')} ${t(PROBE_FAILURES[failed.failure ?? ''] ?? 'Model request failed')}`
          : probe?.rows.length && probe.rows.every((r) => r.status === 'ok')
            ? `${mark('✓', '+')} ${Math.max(...probe.rows.map((r) => r.elapsedMs ?? 0))} ms`
            : t('press t');
      content.push({
        text:
          fit('  ' + t('Test API'), Math.max(0, width - visualLength(label))) +
          (failed ? theme.board.danger : label.startsWith(mark('✓', '+')) ? theme.board.success : theme.board.muted)(
            label
          ),
        probe: true,
      });
    }
  };
  let lastGroup: SettingGroup | undefined;
  for (const i of MAIN_INDICES) {
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
    const helpEnd = content.findIndex((r, i) => i > at && (r.index !== undefined || r.probe));
    const reveal =
      SETTING_ROWS[selected]?.key === 'modelCallsPerHour'
        ? content.findIndex((r) => r.probe)
        : Math.min(at + 3, helpEnd < 0 ? content.length - 1 : helpEnd - 1);
    if (room && reveal >= offset + room) offset = Math.min(at, reveal - room + 1);
  }
  const body = content.slice(offset, offset + room),
    lines = [
      subTopRow(t('Settings'), dirty ? theme.board.attention(t('unsaved')) : '', width),
      ...body.map((r) => r.text),
    ];
  while (lines.length < height - 1) lines.push('');
  const models = selected < SETTING_ROWS.length && settingGroup({ selected }) === 'Models';
  const hints = selected === ADVANCED
    ? [advanced ? '⏎ collapse' : '⏎ expand', 's save', 'Esc back']
    : ['←→ change', 's save', 'Esc back', ...(models ? ['t test'] : []), 'r reset'];
  if (height > 1) lines.push(footRow('', hints, width));
  const back = body.findIndex((r) => r.back !== undefined),
    probe = body.findIndex((r) => r.probe);
  return {
    lines: lines.slice(0, height).map((s) => fit(s, width)),
    rows: [null, ...body.map((r) => r.index ?? null)],
    state: { ...state, original, selected, offset, revealed: selected, advanced },
    back: back < 0 ? undefined : { y: back + 1, x: body[back].back! },
    footerY: height - 1,
    saveX: dirty ? width - visualLength(t('unsaved')) : undefined,
    probeAction: probe < 0 ? undefined : { y: probe + 1, width },
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
    selected: clampSelected(state.selected),
    advanced: isAdvancedOpen({ selected: state.selected, advanced: state.advanced ?? frame.state.advanced }),
  };
  let key = input.type === 'key' ? input.key : '';
  if (input.type === 'mouse') {
    if (input.button === 'left' && input.y === 0)
      return {
        state: next,
        action: frame.saveX !== undefined && input.x >= frame.saveX ? 'save' : 'back',
      };
    if (input.button === 'left' && input.y === frame.probeAction?.y) return { state: next, action: 'test-api' };
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
      key = onBack ? 'left' : 'right';
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
  if (key === 'settings-test' && next.selected < SETTING_ROWS.length && settingGroup(next) === 'Models')
    return { state: next, action: 'test-api' };
  const visible = visibleIndices(!!next.advanced);
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
    const row = SETTING_ROWS[next.selected],
      values = row.values,
      current = rowValue(row, next.draft);
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
