import type { WorkbenchInput } from '../utils/workbench-input.js';
import { placeDestination, type RoleFact } from '../roles/role-control.js';
import { validPresetName, type PresetChange } from '../roles/roster.js';
import type { MonitorContext, MonitorOutcome, MonitorRow, MonitorState } from './monitor.js';
import { glyph, placeRows, presetTag, withDestination } from './control-view.js';
import { monitorRowAt } from './monitor-input.js';
import { fit, flowLines, monitorText, pair, squeeze } from './monitor-text.js';
import { theme, visualLength } from './colors.js';
import { boardRow, mark, type FooterHints } from './workboard-rows.js';
import { t } from './i18n.js';

export type PresetInput = { role: RoleFact; error?: string } & (
  | { mode: 'list'; text: string; at: number }
  | { mode: 'copy' | 'empty' | 'rename'; text: string }
  | { mode: 'delete'; scroll?: number }
);
const muted = theme.board.muted;
const item = (at: number) => `control:preset:${at}`;
const nextOf = (places: RoleFact['places']) => {
  const next = places.find((p) => p.state === 'active');
  return next ? placeDestination(next) : null;
};
const nameOf = (name: string | null) => name === null ? t('file chain') : monitorText(name);
const nextText = (next: string | null) => next === null ? theme.board.attention(t('none')) : monitorText(next);
const matches = (sheet: Extract<PresetInput, { mode: 'list' }>) => [
  ...(sheet.role.presets ?? []),
  { name: null, next: nextOf(sheet.role.fileChain ?? sheet.role.places), offBy: undefined },
].filter(({ name }) => nameOf(name).toLowerCase().includes(sheet.text.toLowerCase()) ||
  (name === null && 'custom'.includes(sheet.text.toLowerCase())));

export function presetInputKey(state: MonitorState, sheet: PresetInput, input: WorkbenchInput, ctx: MonitorContext): MonitorOutcome {
  const out = (value: PresetInput = sheet, action?: MonitorOutcome['action']): MonitorOutcome => ({
    state: { ...state, overlay: { kind: 'control-preset', sheet: value } }, close: false, action,
  });
  const cancel = (): MonitorOutcome => ({ state: { ...state, overlay: undefined }, close: false });
  const commit = (change: Exclude<PresetChange, { op: 'run' }>) =>
    out(sheet, { ...change, type: 'preset-edit', role: sheet.role.role, revision: sheet.role.revision });
  const entries = sheet.mode === 'list' ? matches(sheet) : [];
  const pick = (at: number) => sheet.mode === 'list' ? out({ ...sheet, at: Math.max(0, Math.min(entries.length - 1, at)), error: undefined }) : out();
  const choose = (at = sheet.mode === 'list' ? sheet.at : 0): MonitorOutcome => {
    if (sheet.mode === 'list') return entries[at] ? commit({ op: 'select', name: entries[at].name }) : out();
    if (sheet.mode === 'delete') return commit({ op: 'delete' });
    const { text } = sheet;
    if (!validPresetName(text)) return out({ ...sheet, error: 'bad preset name' });
    if (sheet.role.presets?.some((p) => p.name === text)) return out({ ...sheet, error: 'preset name already exists' });
    if (sheet.mode === 'rename') return commit({ op: 'rename', name: text });
    return { state: { ...state, overlay: { kind: 'control-chain', role: sheet.role, at: 0, mode: { kind: 'places' },
      draft: { name: text, run: sheet.mode === 'empty' ? [] : sheet.role.editor?.places ?? [] } } }, close: false };
  };
  const pane = ctx.frame?.panes.find((p) => p.id === 'preview') ?? ctx.frame?.panes.find((p) => p.id === 'agents');
  const page = Math.max(1, (pane?.height ?? 1) - 2);
  const step = (by: number) => sheet.mode === 'list' ? pick(sheet.at + by)
    : sheet.mode === 'delete'
      ? out({ ...sheet, scroll: Math.max(0, Math.min(pane ? presetSheet(sheet, pane.width, pane.height - Number(pane.id === 'agents')).scrollMax ?? 0 : 0,
        (sheet.scroll ?? 0) + by)) }) : out();
  if (input.type === 'mouse') {
    if (input.button !== 'left') return step(input.button === 'wheel-down' ? 1 : -1);
    const hit = ctx.frame?.controls.find((c) => c.y === input.y && input.x >= c.x && input.x < c.x + c.width)?.kind;
    if (hit === 'preset-cancel') return cancel();
    if (hit === 'preset-accept') return choose();
    const row = pane && monitorRowAt(pane, input.x, input.y);
    const at = /^control:preset:(\d+)$/.exec(row?.item ?? '')?.[1];
    return at === undefined || sheet.mode !== 'list' ? out() : Number(at) === sheet.at ? choose(sheet.at) : pick(Number(at));
  }
  if (input.key === 'escape' || (input.key === 'close' && !input.text)) return cancel();
  if (sheet.mode === 'delete') {
    if (input.key === 'enter' && !input.text) return choose();
    if (input.key === 'page-up' || input.key === 'page-down') return step(input.key === 'page-up' ? -page : page);
    if (!input.text && (input.key === 'up' || input.key === 'down')) return step(input.key === 'up' ? -1 : 1);
    return out();
  }
  if (input.text || input.key === 'backspace') {
    const text = input.text ? (sheet.text + input.text).slice(0, 128) : [...sheet.text].slice(0, -1).join('');
    return out(sheet.mode === 'list' ? { ...sheet, text, at: 0, error: undefined } : { ...sheet, text, error: undefined });
  }
  if (input.key === 'enter') return choose();
  if (sheet.mode !== 'list') return out();
  switch (input.key) {
    case 'home': return pick(0);
    case 'end': return pick(entries.length - 1);
    case 'up': return pick(sheet.at - 1);
    case 'down': return pick(sheet.at + 1);
    case 'page-up': return pick(sheet.at - page);
    case 'page-down': return pick(sheet.at + page);
    default: return out();
  }
}

export function presetSheet(sheet: PresetInput, width: number, room: number): {
  rule: { label: string; right: string }; hints: FooterHints; cursor?: string; rows: MonitorRow[]; scrollMax?: number;
} {
  const name = sheet.role.preset ?? null;
  const label = monitorText(sheet.role.role);
  const right = t({ list: 'choose preset', copy: 'new · from current chain', empty: 'new · from empty', rename: 'rename preset', delete: 'delete preset' }[sheet.mode]);
  const rule = { label, right };
  const error = sheet.error ? flowLines(t(sheet.error), width).map((line) => boardRow(fit(theme.board.attention(line), width))) : [];
  const field = (lead: string, text: string, count: string) => boardRow(pair(
    lead + squeeze(monitorText(text), Math.max(1, width - visualLength(lead + count) - 2)) + theme.board.active(mark('▌', '_')),
    muted(count), width,
  ));
  const lines = (text: string) => flowLines(text, width).map((line) => boardRow(fit(line, width)));
  const saved = (preset: string | null, next: string | null = nextOf(sheet.role.places)) =>
    [presetTag(preset), mark('→', '>'), nextText(next)].filter(Boolean).join(' ');
  if (sheet.mode === 'list') {
    const found = matches(sheet);
    const entries = found.map(({ name: n, next, offBy }, at) => {
      const target = nextText(next), prefix = `  ${n === name ? theme.board.active(mark('◉', '@')) : ' '} `;
      const col = Math.max(4, width - visualLength(prefix + target) - 4);
      const caption = nameOf(n);
      const shown = fit(squeeze(caption, col), Math.min(n === null ? Math.max(9, visualLength(caption)) : 9, col));
      const row = `${prefix}${shown} ${muted(mark('→', '>'))} ${target}`;
      const extra = offBy ? t('{id} off', { id: monitorText(offBy) }) : '';
      return { item: item(at), text: fit(row + (extra && visualLength(`${row}  ${extra}`) <= width ? `  ${muted(extra)}` : ''), width) };
    });
    const hints = { modal: ['type to filter', '⏎ apply', 'Esc cancel'] };
    const notes = [...lines(muted(t('⏎ applies · an all-off preset: none'))), ...lines(muted(t('Global role · all projects')))];
    const selected = found[sheet.at]?.name;
    const full = selected && selected.length > Math.max(4, width - visualLength(nextText(found[sheet.at]!.next)) - 8) ? lines(nameOf(selected)) : [];
    const tail = entries.length + 2 + notes.length <= room - error.length - full.length ? [boardRow(''), ...notes] : [];
    const size = Math.max(1, room - 1 - tail.length - error.length - full.length);
    const start = Math.max(0, Math.min(entries.length - size, sheet.at - Math.floor(size / 2)));
    return { rule, hints, cursor: item(sheet.at), rows: [field('/ ', sheet.text, String(entries.length)), ...error,
      ...(entries.length ? entries.slice(start, start + size) : lines(t('No matching presets'))), ...full, ...tail] };
  }
  if (sheet.mode === 'delete') {
    const chain = sheet.role.fileChain ?? sheet.role.places;
    const header = [...lines(t('Delete {name}?', { name: nameOf(name) })),
      ...lines(t('Use file chain next')), ...lines(saved(null, nextOf(chain))), boardRow('')];
    const places = chain.flatMap((p, i) => placeRows(`  ${i + 1} ${glyph(p.state)} `, withDestination(p), width, ' ', '', {}));
    const available = Math.max(1, room - header.length - error.length);
    const scroll = Math.min(sheet.scroll ?? 0, Math.max(0, places.length - available));
    return { rule, hints: { modal: ['⏎ delete', 'Esc cancel'] },
      rows: [...error, ...header, ...places.slice(scroll, scroll + available),
        ...(places.length < available ? lines(muted(t('Global role · all projects'))) : [])],
      // Number of extra chain rows is used by input to keep scrolling bounded.
      scrollMax: Math.max(0, places.length - available) };
  }
  return { rule, hints: { modal: ['type a name', sheet.mode === 'rename' ? '⏎ rename' : '⏎ continue', 'Esc cancel'] },
    rows: [...(sheet.mode === 'rename' ? [] : lines(t('New preset'))), field(`${t('name')}  `, sheet.text, `${sheet.text.length}/32`), ...error,
      ...lines(t('A–Z a–z 0–9 . _ - · 1–32 chars')),
      ...lines(muted(t('must differ from {role}’s names', { role: label }))), boardRow(''), ...lines(`${t('saved')}  ${saved(name)}`)] };
}
