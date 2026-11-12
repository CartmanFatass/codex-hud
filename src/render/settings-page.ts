import { defaultSettings, type HudSettings } from '../settings.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { HudHealthState } from '../types.js';
import { truncateAnsi, theme, visualLength, coloredBar } from './colors.js';
import { t } from './i18n.js';
import { fit, monitorText } from './monitor-text.js';
import { PREFIX_KEYS, prefixName } from '../utils/panel-command.js';
import { PANEL_WIDTHS } from '../utils/pane-width.js';
import { BAR_STYLES } from './hud-config.js';
import type { ModelProbeState } from '../collectors/model-probe.js';
import { section, subTopRow, footRow, mark } from './workboard-rows.js';
import { stemLines } from './work-card.js';

type SettingValue = string | number | boolean;
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
export type SettingGroup = 'Display' | 'Panel' | 'Models' | 'Codex';
export type SettingsAction = 'back' | 'save' | 'reset' | 'test-api';
export interface SettingRow {
  key: SettingKey;
  group: SettingGroup;
  label: string;
  values: readonly SettingValue[];
  help: string;
  format?: (value: SettingValue) => string;
  literal?: boolean;
  get?: (settings: HudSettings) => SettingValue;
  set?: (value: SettingValue, settings: HudSettings) => Partial<HudSettings>;
}
const seconds = (value: SettingValue) => `${Number(value) / 1000}s`;
const NOTIFY_WORDS: Record<string, string> = { off: 'off', tmux: 'tmux', desktop: 'tmux + desktop' };
export const SETTING_ROWS: readonly SettingRow[] = [
  {
    key: 'theme',
    group: 'Display',
    label: 'Theme',
    values: ['terminal', 'titanium', 'mocha', 'latte', 'none'],
    help: 'Colours of bar and panel',
  },
  {
    key: 'barStyle',
    group: 'Display',
    label: 'Bar style',
    values: BAR_STYLES,
    help: 'Look of the bottom bars',
    literal: true,
  },
  { key: 'icons', group: 'Display', label: 'Icons', values: ['unicode', 'text'], help: 'Icons, or words (text)' },
  {
    key: 'language',
    group: 'Display',
    label: 'Language',
    values: ['auto', 'en', 'zh'],
    help: 'Panel and everything a model writes',
  },
  {
    key: 'cardStallMinutes',
    group: 'Panel',
    label: 'Stall threshold',
    values: [5, 10, 15, 30, 60],
    help: 'Minutes without new evidence; presentation only',
    format: (value) => t('{n}m', { n: Number(value) }),
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
    format: seconds,
  },
  { key: 'mouse', group: 'Panel', label: 'Mouse', values: [true, false], help: 'Click and scroll the panel' },
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
    values: ['deepseek-v4-1-flash-1017'],
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
    values: [30, 60, 120, 240],
    help: 'Model calls per hour, all features; at the cap, sentences wait',
    format: (value) => `${value}/h`,
  },
  {
    key: 'treeWidth',
    group: 'Codex',
    label: 'Width',
    values: PANEL_WIDTHS,
    help: 'Panel columns; Codex keeps 41',
    format: (value) => (Number(value) === 0 ? 'auto' : t('{n} cols', { n: Number(value) })),
  },
  {
    key: 'prefixKey',
    group: 'Codex',
    label: 'Prefix key',
    values: PREFIX_KEYS,
    help: 'Then a key: a panel command. Codex uses Ctrl+] for Skip Question',
    format: (value) => prefixName(String(value)),
  },
  {
    key: 'statusline',
    group: 'Codex',
    label: 'Bar on launch',
    values: [true, false],
    help: 'Next launch: one-line bar',
  },
];
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
}
export function settingGroup(stateOrRow: Pick<SettingsPageState, 'selected'> | SettingRow): SettingGroup {
  return 'group' in stateOrRow
    ? stateOrRow.group
    : SETTING_ROWS[Math.min(SETTING_ROWS.length - 1, Math.max(0, stateOrRow.selected))].group;
}
export function settingsDirty(state: Pick<SettingsPageState, 'draft' | 'original'>): boolean {
  return (
    !!state.original &&
    (Object.keys(defaultSettings()) as Array<keyof HudSettings>).some(
      (key) => state.draft[key] !== state.original![key]
    )
  );
}
const RESET_FIELDS: Record<SettingGroup, readonly (keyof HudSettings)[]> = {
  Display: ['theme', 'barStyle', 'icons', 'language'],
  Panel: ['cardStallMinutes', 'notify', 'notifyDesktop', 'refreshMs', 'mouse'],
  Models: ['modelEnabled'],
  Codex: ['treeWidth', 'prefixKey', 'statusline'],
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
    modelCalls?: { today: number; lastHour: number; cap: number };
    probe?: ModelProbeState;
    settingsFile?: string;
  }
): SettingsFrame {
  width = Math.max(0, Math.floor(width));
  height = Math.max(0, Math.floor(height));
  const selected = Math.min(SETTING_ROWS.length - 1, Math.max(0, state.selected)),
    original = state.original ?? { ...state.draft };
  const dirty = settingsDirty({ ...state, original }),
    content: { text: string; index?: number; back?: number; probe?: boolean }[] = [];
  for (const [i, row] of SETTING_ROWS.entries()) {
    if (!i || SETTING_ROWS[i - 1].group !== row.group)
      content.push({ text: '' }, { text: section(t(row.group), width).text });
    const value = rowValue(row, state.draft),
      changed = rowValue(row, original) !== value,
      active = rowValue(row, defaultSettings()) !== value;
    const shown = truncateAnsi(
        valueText(row, value) + (row.key === 'decisionApi' && !state.decisionKeys?.[value as HudSettings['decisionApi']] ? ` ${t('(no key)')}` : ''),
        Math.max(1, width - visualLength(t(row.label)) - (i === selected ? 7 : 3))
      ),
      tail = i === selected ? `${mark('‹', '<')} ${shown} ${mark('›', '>')}` : shown;
    const ink = active ? theme.board.active : (s: string) => s;
    const left = `${changed ? theme.board.attention('*') : ' '} ${t(row.label)}`;
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
    if (row.key === 'modelCallsPerHour') {
      const usage = health?.modelCalls,
        cap = usage?.cap ?? state.draft.modelCallsPerHour,
        n = usage?.lastHour;
      if (n !== undefined) {
        const atCap = n >= cap,
          value = `${coloredBar(Math.min(100, (n * 100) / cap), 10)} ${n}/${cap}`;
        content.push({
          text:
            fit('  ' + t('Calls this hour'), Math.max(0, width - visualLength(value))) +
            (atCap ? theme.board.danger(value) : theme.board.muted(value)),
        });
        if (atCap) content.push(...stemLines(t('at the cap: sentences wait'), width).map((text) => ({ text })));
      }
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
  }
  const room = Math.max(0, height - 2),
    at = content.findIndex((r) => r.index === selected);
  let offset = Math.max(0, Math.min(state.offset, Math.max(0, content.length - room)));
  if (at < offset) offset = Math.max(0, at - 1);
  const helpEnd = content.findIndex((r, i) => i > at && (r.index !== undefined || r.probe));
  const reveal =
    SETTING_ROWS[selected].key === 'modelCallsPerHour'
      ? content.findIndex((r) => r.probe)
      : Math.min(at + 3, helpEnd < 0 ? content.length - 1 : helpEnd - 1);
  if (room && reveal >= offset + room) offset = Math.min(at, reveal - room + 1);
  const body = content.slice(offset, offset + room),
    lines = [
      subTopRow(t('Settings'), dirty ? theme.board.attention(t('unsaved')) : '', width),
      ...body.map((r) => r.text),
    ];
  while (lines.length < height - 1) lines.push('');
  const models = settingGroup({ selected }) === 'Models';
  const hints = t(
    models
      ? '↑↓ select  ←→ change  s save  t test  esc back  r reset'
      : '↑↓ select  ←→ change  s save  esc back  r reset'
  ).split('  ');
  // At narrow widths Esc wins; keep Save/Test/Esc when all three fit (owner ruling q2).
  if (models && visualLength(hints.slice(0, -1).join('  ')) > width) [hints[3], hints[4]] = [hints[4], hints[3]];
  if (height > 1) lines.push(footRow('', hints.join('  '), width));
  const back = body.findIndex((r) => r.back !== undefined),
    probe = body.findIndex((r) => r.probe);
  return {
    lines: lines.slice(0, height).map((s) => fit(s, width)),
    rows: [null, ...body.map((r) => r.index ?? null)],
    state: { ...state, original, selected, offset },
    back: back < 0 ? undefined : { y: back + 1, x: body[back].back! },
    footerY: height - 1,
    saveX: dirty ? width - visualLength(t('unsaved')) : undefined,
    probeAction: probe < 0 ? undefined : { y: probe + 1, width },
  };
}
const boardSelected = (text: string) => theme.board.selected(text);
export function handleSettingsInput(
  state: SettingsPageState,
  input: WorkbenchInput,
  frame: SettingsFrame
): { state: SettingsPageState; action?: SettingsAction } {
  const next = { ...state, original: state.original ?? frame.state.original };
  let key = input.type === 'key' ? input.key : '';
  if (input.type === 'mouse') {
    if (input.button === 'left' && input.y === 0)
      return {
        state: next,
        action: input.x < 2 ? 'back' : frame.saveX !== undefined && input.x >= frame.saveX ? 'save' : undefined,
      };
    if (input.button === 'left' && input.y === frame.probeAction?.y) return { state: next, action: 'test-api' };
    if (input.button === 'left') {
      const index = frame.rows[input.y];
      if (index === null || index === undefined) return { state: next };
      const onBack =
        frame.back?.y === input.y &&
        index === frame.state.selected &&
        input.x >= frame.back.x &&
        input.x <= frame.back.x + 1;
      next.selected = index;
      key = onBack ? 'left' : 'right';
    } else key = input.button === 'wheel-down' ? 'down' : 'up';
  }
  if (key === 'escape' || key === 'settings' || key === 'close') return { state: next, action: 'back' };
  if (key === 'settings-save') return { state: next, action: 'save' };
  if (key === 'reset') return { state: next, action: 'reset' };
  if (key === 'settings-test' && settingGroup(next) === 'Models') return { state: next, action: 'test-api' };
  const moved = next.selected;
  if (key === 'down' || key === 'tab') next.selected = Math.min(SETTING_ROWS.length - 1, next.selected + 1);
  if (key === 'up' || key === 'shift-tab') next.selected = Math.max(0, next.selected - 1);
  if (key === 'page-down') {
    const after = SETTING_ROWS.findIndex(
      (row, i) => i > next.selected && row.group !== SETTING_ROWS[next.selected].group
    );
    if (after >= 0) next.selected = after;
  }
  if (key === 'page-up') {
    const start = (i: number) => {
      while (i > 0 && SETTING_ROWS[i - 1].group === SETTING_ROWS[i].group) i--;
      return i;
    };
    const here = start(next.selected);
    next.selected = here < next.selected ? here : start(Math.max(0, here - 1));
  }
  if (key === 'home') next.selected = 0;
  if (key === 'end') next.selected = SETTING_ROWS.length - 1;
  if (next.selected !== moved) next.message = '';
  if (key === 'enter' || key === 'left' || key === 'right') {
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
