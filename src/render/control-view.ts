/** The Control plane's roles: one line a place, grouped as roles, project roles and browser tasks, then which harnesses exist. Pure. */
import type { ProjectSnapshot } from '../collectors/project-board.js';
import { placeItem, type PlaceFact, type PlaceState, type RoleFact } from '../roles/role-control.js';
import type { MonitorRow } from './monitor.js';
import { boardRow, section, mark, pack } from './workboard-rows.js';
import { monitorText, fit, pair, squeeze } from './monitor-text.js';
import { theme, visualLength } from './colors.js';
import { t } from './i18n.js';

const glyph = (state: PlaceState) => ({
  active: () => theme.board.active(mark('◉', '@')),
  standby: () => theme.board.muted(mark('○', 'o')),
  exhausted: () => theme.board.attention(mark('✗', 'x')),
  missing: () => theme.board.muted(mark('−', '-')),
})[state]();
const LEGEND: [PlaceState, string][] = [['active', 'in use'], ['standby', 'standby'], ['exhausted', 'exhausted'], ['missing', 'not installed']];
/** `pi  model  thinking`, the model cut in the middle (never the harness or the thinking) when the row is short. */
function placeText(p: PlaceFact, room: number, gap: string): string {
  const tail = monitorText(p.thinking ?? p.kind ?? ''), cells = (model: string) =>
    visualLength(p.label) + (tail ? gap.length + visualLength(tail) : 0) + (model ? gap.length + visualLength(model) : 0);
  let model = p.model ? monitorText(p.model) : p.harness === 'bro' ? '' : t('default');
  // Short of room: the vendor goes first (`openai/gpt-6.1-sol`), then the middle of the name.
  if (p.model && cells(model) > room) model = model.replace(/^[^/]+\//, '');
  if (p.model && cells(model) > room) model = squeeze(model, Math.max(4, visualLength(model) - (cells(model) - room)));
  return [p.label, p.model ? model : model && theme.board.muted(model), tail].filter(Boolean).join(gap);
}
/** The place's row: state mark, the role's name on its first place (`↳` on a fallback), then where it runs; a wide row adds the exhausted time. */
function placeRow(role: RoleFact, i: number, width: number, now: number): MonitorRow {
  const place = role.places[i]!, name = width < 56 ? 9 : 10, gap = width < 56 ? ' ' : '  ';
  // A state that needs the owner's eye, else (on the first place of a wide row) whose file is in force.
  const tag = width < 56 ? '' : place.state === 'exhausted' && place.until !== undefined
    ? theme.board.attention(`${t('exhausted')} ${t('{n}m', { n: Math.max(1, Math.ceil((place.until - now) / 60000)) })}`)
    : place.state === 'missing' ? theme.board.muted(t('not installed'))
    : i === 0 && width >= 80 ? theme.board.muted(t(role.source)) : '';
  const lead = `  ${glyph(place.state)} ${fit(i ? theme.board.muted(mark('↳', '>')) : theme.board.title(monitorText(role.role)), name)} `;
  const text = placeText(place, width - visualLength(lead) - (tag ? visualLength(tag) + 1 : 0), gap);
  const left = lead + (place.state === 'active' ? text : theme.board.muted(text));
  return { text: tag ? pair(left, tag, width) : fit(left, width), item: placeItem(role.role, i), files: [role.path] };
}
export function controlRows(data: ProjectSnapshot, width: number, now: number): MonitorRow[] {
  const rows: MonitorRow[] = [];
  const group = (title: string, roles: RoleFact[]) => {
    if (!roles.length) return;
    rows.push(...(rows.length ? [boardRow('')] : []), section(t(title), width, String(roles.length)));
    for (const role of roles) role.places.forEach((_, i) => rows.push(placeRow(role, i, width, now)));
  };
  group('Roles', data.roles.filter((r) => r.group === 'roles'));
  group('Project roles', data.roles.filter((r) => r.group === 'project'));
  group('Browser tasks', data.roles.filter((r) => r.group === 'browser'));
  if (data.harnesses.length) {
    rows.push(...(rows.length ? [boardRow('')] : []), section(t('Harnesses'), width));
    const ok = (yes: boolean) => yes ? theme.board.success(mark('✓', '+')) : theme.board.muted(mark('−', '-'));
    rows.push(...pack(data.harnesses.map((h) => `${monitorText(h.name)} ${ok(h.ok)}`), width).map((line) => boardRow(fit(line, width))));
    rows.push(...pack(LEGEND.map(([state, word]) => `${glyph(state)} ${theme.board.muted(t(word))}`), width).map((line) => boardRow(fit(line, width))));
  }
  return rows;
}
