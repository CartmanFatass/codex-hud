/**
 * The Control plane's roles. What needs the owner comes first (a place at its limit, a role with nowhere to run, a role
 * file that does not load) with the place the next job will use; healthy roles fold to one row of names and open into
 * one line a place, grouped as roles, project roles and browser tasks; then which harnesses exist. Pure.
 */
import type { ProjectSnapshot } from '../collectors/project-board.js';
import type { ControlRadar, RoleRadar } from '../collectors/control-radar.js';
import { formatTokenCount } from './lines/activity-line.js';
import { placeItem, placeModels, type PlaceFact, type PlaceState, type RoleFact } from '../roles/role-control.js';
import type { MonitorRow } from './monitor.js';
import { pickOf, pickView, type ModelInput } from './model-input.js';
import { boardRow, section, mark, pack, kvRows } from './workboard-rows.js';
import { monitorText, fit, flowLines, pair, squeeze } from './monitor-text.js';
import { theme, visualLength } from './colors.js';
import { basename } from 'node:path';
import { t } from './i18n.js';

export const glyph = (state: PlaceState) => ({
  active: () => theme.board.active(mark('◉', '@')),
  standby: () => theme.board.muted(mark('○', 'o')),
  exhausted: () => theme.board.attention(mark('✗', 'x')),
  missing: () => theme.board.muted(mark('−', '-')),
})[state]();
const LEGEND: [PlaceState, string][] = [['active', 'in use'], ['standby', 'standby'], ['exhausted', 'exhausted'], ['missing', 'not installed']];
/** A role needs the owner when one of its places is exhausted or none can run. Healthy roles are the rest. */
export const needsAttention = (role: RoleFact) =>
  role.places.some((p) => p.state === 'exhausted') || !role.places.some((p) => p.state === 'active');
const presetName = (role: RoleFact) => role.preset === undefined ? '' : ` [${role.preset ?? t('custom')}]`;
/** A role row says the role and nothing else: its preset is in the preview's rule and the selected place, never in a row that has to fit. */
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
/** The place's row: state mark, the role's name on its first place (`↳` on a fallback), then where it runs; a wide row adds the exhausted time. */
function placeRow(role: RoleFact, i: number, width: number, now: number, data: ProjectSnapshot): MonitorRow[] {
  const place = role.places[i]!, name = width < 56 ? 9 : 10, gap = width < 56 ? ' ' : '  ';
  // A state that needs the owner's eye, else (on the first place of a wide row) whose file is in force.
  const tag = width < 56 ? '' : place.state === 'exhausted' && place.until !== undefined
    ? theme.board.attention(`${t('exhausted')} ${t('{n}m', { n: Math.max(1, Math.ceil((place.until - now) / 60000)) })}`)
    : place.state === 'missing' ? theme.board.muted(t('not installed'))
    : i === 0 && width >= 80 ? theme.board.muted(t(role.source)) : '';
  const lead = `  ${glyph(place.state)} ${fit(i ? theme.board.muted(mark('↳', '>')) : theme.board.title(roleName(role)), Math.max(name, visualLength(roleName(role))))} `;
  return placeRows(lead, place, width, gap, tag, placeTarget(role, i, data), place.state === 'active' ? undefined : theme.board.muted);
}
export function placePreview(data: ProjectSnapshot, item: string | undefined, width: number): MonitorRow[] {
  const id = /^project:role:(.+):(\d+)$/.exec(item ?? '');
  if (!id) return [];
  const role = data.roles.find((r) => r.role === id[1]), index = Number(id[2]), place = role?.places[index];
  if (!role || !place) return [];
  const status = place.state === 'active' ? t('next job runs here')
    : place.state === 'standby' ? t('fallback {n}', { n: index })
    : place.state === 'missing' ? t('not installed')
    : place.until === undefined ? t('exhausted')
    : t('exhausted until {time}', { time: new Date(place.until).toTimeString().slice(0, 5) });
  return [
    boardRow(''),
    section(t('Selected place'), width),
    ...kvRows('role', role.role + presetName(role), width),
    ...kvRows('state', status, width),
    ...kvRows('harness', [place.harness, place.label !== place.harness && place.label, place.kind].filter(Boolean).join(' · '), width),
    ...kvRows('model', place.model ?? t(place.kind ? 'none' : 'default'), width),
    ...kvRows('thinking', place.thinking ?? t(place.harness === 'bro' ? 'none' : 'default'), width),
    ...kvRows('source file', `${t(role.source)} · ${basename(role.path)}`, width, undefined, 11),
  ].map((r) => ({ ...r, placePreview: true }));
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
export function controlRows(data: ProjectSnapshot, width: number, now: number, healthyOpen: boolean, cursor?: string): MonitorRow[] {
  const out: MonitorRow[] = [], nameWidth = width < 56 ? 9 : 10, push = (row: MonitorRow) => out.push(row);
  const gap = () => { if (out.length) out.push(boardRow('')); };
  const attention = data.roles.filter(needsAttention), invalid = data.control.filter((r) => r.label === 'invalid');
  if (attention.length + invalid.length) {
    gap();
    out.push(section(t('Needs attention'), width, theme.board.attention(String(attention.length + invalid.length))));
    for (const role of attention) {
      const lead = (i: number, g: string) => `  ${g} ${fit(i ? theme.board.muted(mark('↳', '>')) : theme.board.title(roleName(role)), Math.max(nameWidth, visualLength(roleName(role))))} `;
      const dead = role.places.map((p, i) => [p, i] as const).filter(([p]) => p.state === 'exhausted');
      dead.forEach(([p, i], n) => {
        const min = p.until === undefined ? '' : ` ${t('{n}m', { n: Math.max(1, Math.ceil((p.until - now) / 60000)) })}`;
        push({ text: fit(lead(n, glyph('exhausted')) + theme.board.attention(`${p.label} ${t('exhausted')}${min}`), width), ...placeTarget(role, i, data) });
      });
      const next = role.places.findIndex((p) => p.state === 'active');
      if (next < 0 && !dead.length)
        push({ text: fit(lead(0, glyph('missing')) + theme.board.muted(`${role.places.map((p) => [p.label, p.kind].filter(Boolean).join(' ')).join(' ')} ${t('not installed')}`), width), ...placeTarget(role, 0, data) });
      else {
        const prefix = `      ${theme.board.muted(`${t('next job')} ${mark('→', '>')}`)} `;
        const place = role.places[next];
        if (!place) push({ text: fit(prefix + theme.board.muted(t('none')), width) });
        else out.push(...placeRows(`${prefix}${glyph('active')} `, place, width, ' ', '', placeTarget(role, next, data)));
      }
      role.places.forEach((p, i) => { if (p.state === 'standby') out.push(...placeRow(role, i, width, now, data)); });
    }
    invalid.forEach((r, i) => out.push({
      text: pair(`  ${theme.board.attention('!')} ${monitorText(basename(r.path ?? r.value))}`, theme.board.muted(monitorText(t(r.value))), width),
      item: `project:file:${r.path}:invalid:${i}`, files: r.path ? [r.path] : [],
    }));
  }
  const healthy = data.roles.filter((r) => !needsAttention(r));
  if (healthy.length) {
    gap();
    out.push({ ...section(`${healthyOpen ? '' : mark('▸', '>') + ' '}${t('Healthy')}`, width, String(healthy.length)), item: 'project:fold:healthy' });
    // The folded names wrap onto a second row rather than lose the last ones to a cut.
    if (!healthyOpen) pack(healthy.map(roleName), width - 4).forEach((line, i) => out.push({ text: fit(`${i ? '    ' : `  ${glyph('active')} `}${line.trim().replace(/ {2}/g, ' ')}`, width), item: 'project:fold:healthy' }));
    else for (const [title, group] of [['Roles', 'roles'], ['Project roles', 'project'], ['Browser tasks', 'browser']] as const) {
      const roles = healthy.filter((r) => r.group === group);
      if (!roles.length) continue;
      out.push(section(t(title), width, String(roles.length)));
      for (const role of roles) role.places.forEach((_, i) => out.push(...placeRow(role, i, width, now, data)));
    }
  }
  // Preview the same default stop that the frame selects when the old cursor is gone.
  const selected = out.find((r) => r.item === cursor && r.item) ?? out.find((r) => r.item);
  out.push(...placePreview(data, selected?.item, width));
  const radar = radarRows(radarFacts(data.radar), width);
  if (radar.length) {
    gap();
    out.push(section(t('Usage'), width), ...radar);
  }
  if (data.harnesses.length) {
    gap();
    out.push(section(t('Harnesses'), width));
    const ok = (yes: boolean) => yes ? theme.board.success(mark('✓', '+')) : theme.board.muted(mark('−', '-'));
    out.push(...pack(data.harnesses.map((h) => `${monitorText(h.name)} ${ok(h.ok)}`), width).map((line) => boardRow(fit(line, width))));
    out.push(...pack(LEGEND.map(([state, word]) => `${glyph(state)} ${theme.board.muted(t(word))}`), width).map((line) => boardRow(fit(line, width))));
  }
  return out;
}
