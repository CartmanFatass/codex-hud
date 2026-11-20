/** Shared place presentation, model picker and usage radar. Pure. */
import type { ProjectSnapshot } from '../collectors/project-board.js';
import type { ControlRadar, RoleRadar } from '../collectors/control-radar.js';
import { formatTokenCount } from './lines/activity-line.js';
import { placeDestination, placeItem, placeModels, type PlaceFact, type PlaceState, type RoleFact } from '../roles/role-control.js';
import type { MonitorRow } from './monitor.js';
import { pickerListWindow, pickView, type ModelInput, type ModelPick, type PickEntry } from './model-input.js';
import { boardRow, section, mark, kvRows, minuteAge } from './workboard-rows.js';
import { MODEL_CACHE_TTL_MS } from '../roles/model-discovery.js';
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
export const shortModel = (model: string) => monitorText(model).replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{4})$/, '');
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

/** Narrow picker: keep the query and selected ID outside the scrolling list. */
export function pickerRows(data: ProjectSnapshot, input: ModelInput, pick: ModelPick, width: number, room: number, now: number): MonitorRow[] {
  const view = pickView(pick, input), { place, lists } = pick;
  const piStatus = lists.piStatus, fetchedAt = piStatus?.fetchedAt;
  const where = monitorText(input.role), rows: MonitorRow[] = [];
  const notice = (text: string) => boardRow(fit('  ' + theme.board.attention(text), width));
  if (piStatus?.failed) rows.push(notice(t('Refresh failed')));
  else if (fetchedAt !== undefined && now - fetchedAt >= MODEL_CACHE_TTL_MS) rows.push(notice(t('List is stale')));
  if (piStatus?.offline) rows.push(notice(t('Limited offline catalog')));
  const stateOf = (entry: PickEntry, detail = false) => {
    const fact = pickerFact(entry, now, detail);
    if (fact || !detail) return fact;
    if (!entry.current) return theme.board.muted(t('Enter sets it · not the current model'));
    const label = t('current');
    const extra = [where, presetTag(pick.preset), t('place #{n}', { n: input.index + 1 })].filter(Boolean).join(' ');
    return `${theme.board.active(mark('◉', '@'))} ${theme.board.muted(visualLength(label + ' · ' + extra) + 4 <= width ? `${label} · ${extra}` : label)}`;
  };
  const selected = view.selected;
  const full = selected ? monitorText(selected.model ?? selected.label) : '';
  const detail = [section(theme.board.muted(t('Selected')), width)];
  const detailLine = (line: string) => boardRow(fit('  ' + line, width));
  if (full) {
    detail.push(...flowLines(full, width - 2).map(detailLine));
    const id = selected?.model;
    if (id) {
      const [ctx, out, thinking, images] = lists.piFacts?.[id] ?? [];
      const muted = theme.board.muted;
      const fields = [muted(`${ctx ?? '?'} ${t('ctx')}`), muted(`${out ?? '?'} ${t('out')}`), `${muted(t('think'))} ${pickerCap(thinking)}`, `${muted(t('img'))} ${pickerCap(images)}`];
      let line = '';
      for (const field of fields) {
        if (line && visualLength(`${line}  ${field}`) > width - 2) {
          detail.push(detailLine(line));
          line = '';
        }
        line += (line ? '  ' : '') + field;
      }
      detail.push(detailLine(line));
    }
    if (selected) {
      detail.push(detailLine(stateOf(selected, true)));
      if (selected.tags?.length) {
        const tags = selected.tags.map((name) => `[${monitorText(name)}]`).join(' ');
        detail.push(detailLine(theme.board.muted(flowLines(tags, width - 2)[0] ?? '')));
      }
    }
  } else detail.push(detailLine(theme.board.muted(t('No selection'))));
  // Keep a row for the cursor even when the strip wraps or the pane is short.
  if (room < detail.length + 2) detail.shift();
  detail.length = Math.min(detail.length, Math.max(0, room - 2));
  const off = data.harnessSwitches?.filter((item) => item.group === 'provider' && item.off).map((item) => monitorText(item.name)).sort();
  const offLine = off?.length && room >= detail.length + 3
    ? boardRow(fit(theme.board.muted(`${mark('⊘', 'x')} ${t('off, not listed: {names}', { names: off.join(' · ') })}`), width)) : undefined;
  if (input.text.trim() && view.current?.fact && room >= rows.length + detail.length + 4 + Number(!!offLine)) {
    const label = t('current'), fact = stateOf(view.current);
    const id = squeeze(monitorText(view.current.label), width - visualLength(label + fact) - 5);
    rows.push(boardRow(pair(`  ${theme.board.muted(label)}  ${id}`, fact, width)));
  }
  // On short panes, the list and bottom strip take precedence over opening context.
  rows.length = Math.min(rows.length, Math.max(0, room - detail.length - 2 - Number(!!offLine)));
  const count = !input.text.trim() ? String(view.total) : t('{n} matches', { n: view.total });
  const empty = piStatus?.runnerOff ? 'pi is off' : piStatus?.empty ? 'No discovered models' : 'No matching models';
  const list: MonitorRow[] = [];
  const add = (entry: PickEntry) => {
    const cursor = selected?.id === entry.id;
    const lead = `${cursor ? theme.board.active(mark('›', '>')) : ' '} ${entry.current ? theme.board.active(mark('◉', '@')) : ' '} `;
    const name = monitorText(entry.label);
    const fact = stateOf(entry), tags = entry.tags?.map((name) => `[${monitorText(name)}]`) ?? [];
    const available = (side: string) => width - 4 - (side ? visualLength(side) + 2 : 0);
    // Keep whole tags when they fit, preserving the status and as much of the model ID as possible.
    while (tags.length > 1 && visualLength(name) > available([fact, ...tags].filter(Boolean).join(' '))) tags.pop();
    const tag = tags.length ? theme.board.muted(tags.join(' ')) : '';
    const both = [fact, tag].filter(Boolean).join(' ');
    const right = visualLength(name) <= available(both) ? both : fact;
    list.push({ text: pair(lead + squeeze(name, available(right)), right, width), modelHit: { entry: entry.id },
      ...(cursor ? { item: 'project:pick' } : {}) });
    if (entry.value === '' && place.piModel?.defaultSource) list.push(boardRow(fit(`      ${theme.board.muted(t(place.piModel.defaultSource))}`, width)));
  };
  if (view.pinned.length) {
    list.push(section(t('Pinned'), width, String(view.pinned.length)));
    for (const entry of view.pinned) add(entry);
  }
  for (const group of view.groups) {
    const arrow = group.open ? mark('▾', 'v') : mark('▸', '>');
    list.push({ ...section(theme.board.identifier(`${arrow} ${monitorText(group.provider)}`), width, String(group.entries.length)),
      modelHit: { provider: group.provider } });
    if (group.open) for (const entry of group.entries) add(entry);
  }
  if (view.fallback) add(view.fallback);
  if ((!selected && !view.groups.length) || piStatus?.empty) list.push(notice(t(empty)));
  const size = Math.max(0, room - detail.length - Number(!!offLine) - rows.length - 1);
  const window = pickerListWindow(list, input, size);
  rows.push(pickerQuery(input, pick, window, count, width));
  rows.push(...list.slice(window.first, window.first + size));
  if (offLine) rows.push(offLine);
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
