/** Shared place presentation, model picker and usage radar. Pure. */
import type { ProjectSnapshot } from '../collectors/project-board.js';
import type { ControlRadar, RoleRadar } from '../collectors/control-radar.js';
import { formatTokenCount } from './lines/activity-line.js';
import { placeItem, placeModels, type PlaceFact, type PlaceState, type RoleFact } from '../roles/role-control.js';
import type { MonitorRow } from './monitor.js';
import { pickOf, pickView, type ModelInput } from './model-input.js';
import { boardRow, section, mark, kvRows } from './workboard-rows.js';
import { monitorText, fit, flowLines, pair, squeeze } from './monitor-text.js';
import { theme, visualLength } from './colors.js';
import { t } from './i18n.js';

export const glyph = (state: PlaceState) => ({
  active: () => theme.board.active(mark('◉', '@')),
  standby: () => theme.board.muted(mark('○', 'o')),
  exhausted: () => theme.board.attention(mark('✗', 'x')),
  missing: () => theme.board.muted(mark('−', '-')),
})[state]();
/** A role needs the owner when one of its places is exhausted or none can run. Healthy roles are the rest. */
export const needsAttention = (role: RoleFact) =>
  role.places.some((p) => p.state === 'exhausted') || !role.places.some((p) => p.state === 'active');
export const roleName = (role: RoleFact) => monitorText(role.role);
/** A model as it reads: no snapshot date (`-20261101`, `-2026-11-01`, `-1017`), which the picker and the selected place still show whole. */
export const shortModel = (model: string) => monitorText(model).replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{4})$/, '');
const placeJoin = (p: PlaceFact, model: string, gap: string) => [p.label, p.model ? model : model && theme.board.muted(model), monitorText(p.thinking ?? p.kind ?? '')].filter(Boolean).join(gap);
const modelOf = (p: PlaceFact) => (p.model ? shortModel(p.model) : p.harness === 'bro' ? '' : t('default'));
/** `pi  model  thinking`, the model short when the row is short of room: the vendor goes first (`openai/gpt-6.1-sol`), then the middle of the name. */
export function placeText(p: PlaceFact, room: number, gap: string): string {
  let model = modelOf(p);
  if (p.model && visualLength(placeJoin(p, model, gap)) > room) model = model.replace(/^[^/]+\//, '');
  if (p.model && visualLength(placeJoin(p, model, gap)) > room) model = squeeze(model, Math.max(4, visualLength(model) - (visualLength(placeJoin(p, model, gap)) - room)));
  return placeJoin(p, model, gap);
}
/**
 * A place as one row, or as two when its model does not fit whole: `lead  pi  xhigh` and the model under it, cut in the middle only
 * when even a row of its own is too short. `tag` sits at the right of the first row; `ink` paints the place (standby ones are dim).
 */
export function placeRows(lead: string, p: PlaceFact, width: number, gap: string, tag: string, extra: Partial<MonitorRow>, ink: (s: string) => string = (s) => s): MonitorRow[] {
  const room = width - visualLength(lead) - (tag ? visualLength(tag) + 1 : 0), model = modelOf(p).replace(/^[^/]+\//, '');
  const two = !!p.model && visualLength(placeJoin(p, model, gap)) > room;
  const first = lead + ink(two ? placeJoin({ ...p, model: null }, '', gap) : placeText(p, room, gap));
  return [{ ...extra, text: tag ? pair(first, tag, width) : fit(first, width) },
    ...(two ? [{ ...extra, text: fit('    ' + ink(squeeze(model, width - 5)), width) }] : [])];
}
/** What a row of a place carries for the keys: its id, its role file, and what the model picker needs when the place can have a model. */
export function placeTarget(role: RoleFact, i: number, data: ProjectSnapshot): Pick<MonitorRow, 'item' | 'files' | 'modelPick'> {
  const place = role.places[i]!, pickable = role.source !== 'project' && placeModels(place, data.models) !== undefined;
  return { item: placeItem(role.role, i), files: [role.path], ...(pickable ? { modelPick: { place, lists: data.models } } : {}) };
}
/**
 * The model picker, in place of the page while it is open: the place, its current model, the filter line and the entries
 * around the picked one (a window as tall as the panel allows). The picked entry is the row the cursor paints.
 */
export function pickerRows(data: ProjectSnapshot, input: ModelInput, width: number, room: number): MonitorRow[] {
  const pick = pickOf(data, input)!, view = pickView(pick, input), place = pick.place;
  const where = `${monitorText(input.role)} · ${monitorText(place.label)}${view.level === 'model' && place.harness === 'pi' ? ` ${mark('›', '>')} ${monitorText(input.provider || t('other'))}` : ''}`;
  const level = `${t(view.level)}${input.all ? ` · ${t('all')}` : ''}`;
  const typed = monitorText(input.text), cursor = theme.board.active(mark('▌', '_')), lead = `  ${theme.board.muted('/')} `;
  const shown = visualLength(typed) > width - visualLength(lead) - 1 ? mark('…', '~') + [...typed].slice(-(width - visualLength(lead) - 2)).join('') : typed;
  const count = view.at >= 0 ? `${view.at + 1}/${view.entries.length}` : view.free ? t('as typed') : '0';
  const size = Math.max(1, room - 4), first = Math.max(0, Math.min(view.entries.length - size, view.at - Math.floor(size / 2)));
  return [
    boardRow(''),
    section(where, width, theme.board.muted(level)),
    boardRow(fit(`  ${theme.board.muted(t('model'))}  ${place.model ? monitorText(place.model) : theme.board.muted(t('default'))}`, width)),
    { text: pair(`${lead}${shown}${cursor}`, theme.board.muted(count), width), item: placeItem(input.role, input.index), modelPick: pick },
    ...(view.entries.length ? view.entries.slice(first, first + size).map((e, k): MonitorRow => ({
      text: pair(`  ${e.current ? theme.board.active(mark('◉', '@')) : ' '} ${e.unset ? theme.board.muted(e.label) : monitorText(e.label)}`,
        e.count === undefined ? '' : theme.board.muted(String(e.count)), width),
      ...(first + k === view.at ? { item: 'project:pick' } : {}),
    })) : view.free ? [{ text: fit(`  ${theme.board.active(mark('⏎', '>'))} ${monitorText(view.free)}`, width), item: 'project:pick' }]
      : [boardRow(fit('  ' + theme.board.muted(t('none')), width))]),
  ];
}
export function radarFacts(radar: ControlRadar | undefined) {
  const quotas = (['codex', 'claude'] as const).flatMap((client) => {
    const windows = radar?.quotas?.[client];
    return windows?.length ? [{ client, windows }] : [];
  });
  const roles = Object.entries(radar?.roleStats ?? {}).filter(([, s]) => s.total > 0).sort(([a], [b]) => a.localeCompare(b));
  const pi = radar?.piToday?.sessions ? radar.piToday : undefined;
  return { quotas, roles, pi };
}
type RadarFacts = ReturnType<typeof radarFacts>;
const remaining = (p: number) => `${Math.round(p)}%`;
const usd = (p: NonNullable<RadarFacts['pi']>) => `${p.sampled ? '≥' : ''}$${p.costUsd.toFixed(2)}`;
const tokens = (p: NonNullable<RadarFacts['pi']>) => t('{n} tok', { n: (p.sampled ? '≥' : '') + formatTokenCount(p.tokens) });
export function radarSummary({ quotas, pi }: RadarFacts, withTokens: boolean): string[] {
  return [...quotas.map(({ client, windows }) => `${t(client)} ${t('{n} left', { n: remaining(Math.min(...windows.map((w) => w.remaining))) })}`),
    ...(pi ? [`${t('pi')} ${usd(pi)}${withTokens ? ` (${tokens(pi)})` : ''}`] : [])];
}
export function roleToday(s: RoleRadar, compact = false): string {
  return [compact ? `${s.ok}${mark('✓', '+')} ${s.failed}${mark('✗', 'x')}` : t('{ok} ok · {failed} failed', { ok: s.ok, failed: s.failed }),
    s.avgMinutes === null ? '' : t('avg {time}', { time: t('{n}m', { n: Math.round(s.avgMinutes) }) }),
    s.quietEscalated ? t('quiet {n}', { n: s.quietEscalated }) : ''].filter(Boolean).join(' · ');
}
export function radarRows(facts: RadarFacts, width: number, detail = false): MonitorRow[] {
  const { quotas, pi, roles } = facts, out: MonitorRow[] = [];
  const line = (value: string) => flowLines(value, Math.max(1, width - 2)).map((s) => boardRow(fit('  ' + s, width)));
  if (detail) {
    if (quotas.length) out.push(section(t('Quota'), width), ...quotas.flatMap(({ client, windows }) => windows.flatMap((w) => {
      const reset = w.resetsAt === undefined ? '' : t('resets {time}', { time: new Date(w.resetsAt).toISOString().slice(0, 16).replace('T', ' ') + 'Z' });
      return kvRows(client, [[w.label, t('{n} left', { n: remaining(w.remaining) })].filter(Boolean).join(' '), reset].filter(Boolean).join(' · '), width);
    })));
    if (pi) out.push(section(t('Pi today'), width), ...line([usd(pi), tokens(pi), t('{n} sessions', { n: pi.sessions })].join(' · ')));
    if (roles.length) out.push(section(t('Dispatch today'), width));
  } else {
    let row = '';
    for (const part of radarSummary(facts, true)) {
      if (row && visualLength(`${row} · ${part}`) > width - 2) { out.push(...line(row)); row = ''; }
      row = row ? `${row} · ${part}` : part;
    }
    if (row) out.push(...line(row));
  }
  return out.concat(roles.flatMap(([role, s]) => line(`${monitorText(role)}  ${detail ? t('{n} jobs', { n: s.total }) + ' · ' : ''}${roleToday(s, !detail)}`)));
}
