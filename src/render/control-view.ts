/** Shared place presentation, model picker and usage radar. Pure. */
import type { ProjectSnapshot } from '../collectors/project-board.js';
import type { ControlRadar, PlaceRadar, RoleRadar } from '../collectors/control-radar.js';
import { formatTokenCount } from './lines/activity-line.js';
import { placeDestination, placeItem, placeModels, type PlaceFact, type PlaceState, type RoleFact } from '../roles/role-control.js';
import type { MonitorRow } from './monitor.js';
import { pickerListWindow, pickView, type ModelInput, type ModelPick, type PickEntry } from './model-input.js';
import { boardRow, section, mark, kvRows, minuteAge } from './workboard-rows.js';
import { MODEL_CACHE_TTL_MS } from '../roles/model-discovery.js';
import { stripModelSnapshotDate } from '../models/catalog.js';
import { monitorText, fit, flowLines, pair, squeeze } from './monitor-text.js';
import { theme, visualLength } from './colors.js';
import { t } from './i18n.js';

export const glyph = (state: PlaceState) => ({
  active: () => theme.board.active(mark('◉', '@')),
  standby: () => theme.board.muted(mark('○', 'o')),
  exhausted: () => theme.board.attention(mark('✗', 'x')),
  off: () => theme.board.muted(mark('⊘', 'x')),
  missing: () => theme.board.muted(mark('−', '-')),
})[state]();
/** A role needs the owner when one of its places is exhausted or none can run. Healthy roles are the rest. */
export const needsAttention = (role: RoleFact) =>
  role.places.some((p) => p.state === 'exhausted') || !role.places.some((p) => p.state === 'active');
export const roleName = (role: RoleFact) => monitorText(role.role);
/** A model as it reads: no snapshot date (`-20261101`, `-2026-11-01`, `-1017`), which the picker and the selected place still show whole. */
export const shortModel = (model: string) => stripModelSnapshotDate(monitorText(model));
export const presetName = (name?: string | null) => name && name !== 'default' ? monitorText(name) : '';
export const presetTag = (name?: string | null) => {
  const shown = presetName(name);
  return shown ? `[${shown}]` : '';
};
export const sourceLabel = (source: RoleFact['source']) => t(source === 'default' ? 'shipped' : source);
export const effectiveModel = (p: PlaceFact) => p.model ?? (p.piModel?.isDefault ? p.piModel.defaultId : null);
export const unsetModel = (p: PlaceFact) => p.piModel?.isDefault ?? !p.model;
/** A role row adds a model only if the entire destination fits with its name and preset. */
export function roleModelDestination(p: PlaceFact): string | undefined {
  const model = monitorText(p.piModel?.current ?? effectiveModel(p) ?? '');
  if (!model) return;
  const value = mute(model, unsetModel(p));
  if (p.harness === 'cli') return `${monitorText(p.label)} ${value}`;
  if (p.harness === 'pi') {
    if (model.includes('/')) return value;
    if (p.provider) return mute(`${monitorText(p.provider)}/${model}`, unsetModel(p));
  }
}
export const withDestination = (p: PlaceFact): PlaceFact => {
  const model = effectiveModel(p), prefix = `${p.provider}/`;
  return p.provider ? { ...p, label: placeDestination(p), model: model?.startsWith(prefix) ? model.slice(prefix.length) : model } : p;
};
const mute = (text: string, muted: boolean) => text && muted ? theme.board.muted(text) : text;
const placeJoin = (p: PlaceFact, model: string, gap: string, control: boolean) => [monitorText(p.label),
  mute(model, control ? unsetModel(p) : !p.model), mute(monitorText(p.thinking ?? p.kind ?? ''), control && !!p.inheritedThinking)].filter(Boolean).join(gap);
/**
 * A place as one row, or as two when its model does not fit whole: `lead  pi  xhigh` and the model under it, cut in the middle only
 * when even a row of its own is too short. `tag` sits at the right of the first row; `ink` paints the place (standby ones are dim).
 */
export function placeRows(lead: string, p: PlaceFact, width: number, gap: string, tag: string, extra: Partial<MonitorRow>, ink: (s: string) => string = (s) => s, control = true): MonitorRow[] {
  const room = width - visualLength(lead) - (tag ? visualLength(tag) + 1 : 0), value = control ? effectiveModel(p) : p.model;
  let model = value ? shortModel(value) : control || p.harness === 'bro' ? '' : t('default');
  const join = (m: string) => placeJoin(p, m, gap, control);
  if (value && visualLength(join(model)) > room) model = model.replace(/^[^/]+\//, '');
  const two = !!value && visualLength(join(model)) > room;
  const first = lead + ink(join(two ? '' : model));
  return [{ ...extra, text: tag ? pair(first, tag, width) : fit(first, width) },
    ...(two ? [{ ...extra, text: fit('    ' + ink(mute(squeeze(model, width - 5), control && unsetModel(p))), width) }] : [])];
}
export function modelButton(place: PlaceFact, room: number): string {
  const model = squeeze(shortModel(effectiveModel(place) ?? '').replace(/^[^/]+\//, ''), room - 4);
  const tail = `${mark('▾', 'v')}]`, accent = theme.board.identifier;
  return unsetModel(place) && model ? accent('[') + theme.board.muted(model) + accent(` ${tail}`)
    : accent(`[${model ? `${model} ` : ''}${tail}`);
}
export function modelFieldRows(place: PlaceFact, prefix: string, width: number, extra: Pick<MonitorRow, 'item' | 'files' | 'modelPick'>, ink: (s: string) => string): MonitorRow[] {
  const label = monitorText(placeDestination(place)), effort = mute(monitorText(place.thinking ?? ''), true);
  const normal = modelButton(place, Infinity), aligned = prefix + ink(fit(label, Math.max(7, visualLength(label)))) + ' ';
  const lead = visualLength(aligned + normal) <= width ? aligned : prefix + ink(label) + ' ';
  const two = visualLength(lead + normal) > width;
  const fieldLead = two ? ' '.repeat(visualLength(prefix)) : lead;
  const x = visualLength(fieldLead);
  const field = modelButton(place, width - x);
  const control = { kind: 'control-model' as const, item: extra.item, x, width: visualLength(field) };
  return [...(two ? [{ ...extra, text: pair(prefix + ink(label), effort, width) }] : []),
    { ...extra, text: pair(fieldLead + field, !two && visualLength(lead + field + effort) < width ? effort : '', width), controls: [control] }];
}

/** What a row of a place carries for the keys: its id, its role file, and what the model picker needs when the place can have a model. */
export function placeTarget(role: RoleFact, i: number, data: ProjectSnapshot): Pick<MonitorRow, 'item' | 'files' | 'modelPick'> {
  const place = role.places[i]!, pickable = role.source !== 'project' && placeModels(place, data.models) !== undefined;
  return { item: placeItem(role.role, i), files: [role.path], ...(pickable ? { modelPick: { place, lists: data.models } } : {}) };
}
export const pickerAge = (fetchedAt: number, now: number) => now - fetchedAt >= 3600000
  ? t('{n}h', { n: Math.floor((now - fetchedAt) / 3600000) }) : minuteAge(fetchedAt, now);

export function pickerFact(entry: PickEntry, now: number, detail = false) {
  if (entry.fact === 'off') {
    const off = mark('⊘', 'x');
    return theme.board.muted(detail ? t('{mark} off', { mark: off }) : off);
  }
  if (entry.fact === 'unknown') return theme.board.attention(`?${detail || entry.tags?.length ? ` ${t('unknown')}` : ''}`);
  if (entry.until !== undefined && entry.until > now) {
    const n = Math.ceil((entry.until - now) / 60000);
    const reset = detail ? t('resets in {n}m', { n }) : t('{n}m', { n });
    return detail ? `${glyph('exhausted')} ${theme.board.attention(t('exhausted'))} ${theme.board.muted(`· ${reset}`)}`
      : `${glyph('exhausted')} ${theme.board.attention(reset)}`;
  }
  return '';
}
export const pickerCap = (yes: boolean | undefined) => yes === undefined ? theme.board.muted('?')
  : yes ? theme.board.success(mark('✓', '+')) : theme.board.muted(mark('–', '-'));

export function pickerQuery(input: ModelInput, pick: ModelPick, window: NonNullable<MonitorRow['modelWindow']>, count: string, width: number): MonitorRow {
  const queryRoom = width - visualLength(count) - 4;
  let tail = monitorText(input.text);
  if (queryRoom > 1 && visualLength(tail) > queryRoom) {
    const chars = [...tail];
    let kept = '';
    while (chars.length && visualLength(chars.at(-1)! + kept) < queryRoom) kept = chars.pop()! + kept;
    tail = mark('…', '~') + kept;
  }
  return { text: pair(`${theme.board.muted('/')} ${tail}${theme.board.active(mark('▌', '_'))}`, theme.board.muted(count), width),
    item: placeItem(input.role, input.index), modelPick: pick, modelWindow: window };
}

export function pickerListRows(input: ModelInput, pick: ModelPick, view: ReturnType<typeof pickView>, width: number,
  paintModel: (entry: PickEntry) => MonitorRow[]): MonitorRow[] {
  const list = view.rows.flatMap((row) => {
    if ('provider' in row) return [section(theme.board.identifier(monitorText(row.provider)), width, String(row.count))];
    if (!('providers' in row)) return paintModel(row);
    const selected = view.selected?.id === row.id, count = String(row.count);
    const lead = (selected ? `${theme.board.active(mark('›', '>'))} ` : '') + mark(input.otherOpen ? '▾' : '▸', input.otherOpen ? 'v' : '>');
    let names = '';
    for (const [i, provider] of row.providers.entries()) {
      const next = names + (names ? ' · ' : ' ') + monitorText(provider);
      const rest = row.providers.length - i - 1;
      if (visualLength(lead + next + (rest ? ` +${rest}` : '') + count) + 3 > width) {
        names += ` +${rest + 1}`;
        break;
      }
      names = next;
    }
    return [{ ...section(theme.board.identifier(lead + names), width, count), modelHit: { entry: row.id },
      ...(selected ? { item: 'project:pick' } : {}) }];
  });
  const status = pick.place.harness === 'pi' ? pick.lists.piStatus : undefined, filtered = !!input.text.trim();
  const empty = filtered ? (!view.total && 'No matching models')
    : status?.runnerOff ? 'pi is off' : status?.empty ? 'No discovered models' : !view.rows.length && 'No matching models';
  if (empty) list.push(boardRow(theme.board.attention(t(empty))));
  if (!filtered && pick.off?.length) list.push(boardRow(theme.board.muted(`${mark('⊘', 'x')} ${t('off: {names}', { names: pick.off.map(monitorText).join(' · ') })}`)));
  return list;
}

/** Single-column picker. Pi adds a facts row and the full ID if it was cut in the list. */
export function pickerRows(input: ModelInput, pick: ModelPick, width: number, room: number, now: number): MonitorRow[] {
  const view = pickView(pick, input), { place, lists } = pick, selected = view.selected;
  const isPi = place.harness === 'pi';
  const status = isPi ? lists.piStatus : place.harness === 'cli' && (place.label === 'agy' || place.label === 'grok')
    ? lists.cliStatus?.[place.label] : undefined;
  const fetchedAt = status?.fetchedAt, rows: MonitorRow[] = [];
  const notice = (text: string) => boardRow(fit('  ' + theme.board.attention(text), width));
  if (status?.failed) rows.push(notice(t('Refresh failed')));
  else if (fetchedAt !== undefined && now - fetchedAt >= MODEL_CACHE_TTL_MS) rows.push(notice(t('List is stale')));
  if (isPi && lists.piStatus?.offline) rows.push(notice(t('Limited offline catalog')));
  let shortened = false;
  const list = pickerListRows(input, pick, view, width, (entry) => {
    const cursor = selected?.id === entry.id;
    const lead = `${cursor ? theme.board.active(mark('›', '>')) : ' '} ${entry.current ? theme.board.active(mark('◉', '@')) : ' '} `;
    const name = monitorText(entry.label);
    const fact = pickerFact(entry, now, !isPi && entry.fact === 'off'), was = entry.was ? theme.board.muted(t('was')) : '';
    const tags = entry.tags?.map((name) => theme.board.muted(`[${monitorText(name)}]`)) ?? [];
    const available = (side: string) => width - 4 - (side ? visualLength(side) + 2 : 0);
    const rightSide = () => [fact, ...tags, was].filter(Boolean).join(' ');
    while (tags.length && visualLength(name) > available(rightSide())) tags.pop();
    const right = rightSide(), nameRoom = available(right);
    if (cursor) shortened = visualLength(name) > nameRoom;
    return [{ text: pair(lead + squeeze(name, nameRoom), right, width), modelHit: { entry: entry.id },
      ...(cursor ? { item: 'project:pick' } : {}) },
      ...(entry.value === '' && place.piModel?.defaultSource ? [boardRow(`      ${theme.board.muted(t(place.piModel.defaultSource))}`)] : [])];
  });
  const detail: MonitorRow[] = [];
  if (isPi && selected?.model && room >= 3) {
    const muted = theme.board.muted;
    const [ctx, out, thinking, images] = lists.piFacts?.[selected.model] ?? [];
    const fields = [muted(`${monitorText(ctx ?? '?')} ${t('ctx')}`), muted(`${monitorText(out ?? '?')} ${t('out')}`),
      `${muted(t('think'))} ${pickerCap(thinking)}`, `${muted(t('img'))} ${pickerCap(images)}`];
    while (fields.length > 1 && visualLength(fields.join('  ')) > width) fields.pop();
    if (shortened) detail.push(...flowLines(monitorText(selected.model), width).slice(0, room - 3).map((line) => boardRow(muted(line))));
    detail.push(boardRow(fields.join('  ')));
  }
  rows.length = Math.min(rows.length, Math.max(0, room - detail.length - 2));
  const size = Math.max(0, room - detail.length - rows.length - 1);
  const window = pickerListWindow(list, input, size);
  rows.push(pickerQuery(input, pick, window, String(view.total), width));
  rows.push(...list.slice(window.first, window.first + size));
  while (rows.length + detail.length < room) rows.push(boardRow(''));
  rows.push(...detail);
  return rows;
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
function placeStats(p: PlaceRadar): string {
  const parts: string[] = [];
  if (p.ok || p.failed || (!p.launchFailed && !p.quietEscalated && !p.quota)) {
    parts.push(`${p.ok}${mark('✓', '+')} ${p.failed}${mark('✗', 'x')}`);
  }
  if (p.launchFailed) parts.push(t('launch {mark}{n}', { mark: mark('✗', 'x'), n: p.launchFailed }));
  if (p.quietEscalated) parts.push(t('quiet {n}', { n: p.quietEscalated }));
  if (p.quota) parts.push(t('quota {n}', { n: p.quota }));
  return parts.join(' · ');
}
function placeRadarRows(s: RoleRadar, width: number): MonitorRow[] {
  const entries = Object.entries(s.places ?? {}).filter(([, p]) =>
    p.launches > 0 || p.ok > 0 || p.failed > 0 || p.launchFailed > 0 || p.quietEscalated > 0 || p.quota > 0);
  if (entries.length < 2 && !entries.some(([, p]) => p.launchFailed > 0 || p.quota > 0)) return [];
  entries.sort(([a, pa], [b, pb]) => pb.launches - pa.launches || a.localeCompare(b));
  const shown = entries.slice(0, 4).map(([place, p]) => ({ name: monitorText(place), stats: placeStats(p) }));
  const extra = entries.length - shown.length;
  const maxName = Math.max(...shown.map((r) => visualLength(r.name)));
  const rows: MonitorRow[] = [];
  for (const { name, stats } of shown) {
    const room = width - 4 - 2 - visualLength(stats);
    if (room >= 12) {
      const label = fit(squeeze(name, room), Math.min(maxName, room));
      rows.push(boardRow(fit(`    ${theme.board.muted(`${label}  ${stats}`)}`, width)));
    } else {
      rows.push(boardRow(fit(`    ${theme.board.muted(squeeze(name, Math.max(1, width - 4)))}`, width)));
      rows.push(...flowLines(stats, Math.max(1, width - 6)).map((part) => boardRow(fit(`      ${theme.board.muted(part)}`, width))));
    }
  }
  if (extra > 0) rows.push(boardRow(fit(`    ${theme.board.muted(t('+{n} more', { n: extra }))}`, width)));
  return rows;
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
  return out.concat(roles.flatMap(([role, s]) => [
    ...line(`${monitorText(role)}  ${detail ? t('{n} jobs', { n: s.total }) + ' · ' : ''}${roleToday(s, !detail)}`),
    ...(detail ? placeRadarRows(s, width) : []),
  ]));
}
