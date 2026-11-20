/** The zoomed picker is still one list. Only its left column has input targets. */
import type { ProjectSnapshot } from '../collectors/project-board.js';
import { MODEL_CACHE_TTL_MS } from '../roles/model-discovery.js';
import { placeModels, type PlaceFact } from '../roles/role-control.js';
import { qualifiedPiProvider } from '../roles/roster.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { pickerAge, pickerCap, pickerFact, pickerListWindow, pickerQuery } from './control-view.js';
import { t } from './i18n.js';
import { pickView, type ModelInput, type ModelPick, type PickEntry } from './model-input.js';
import { fit, flowLines, monitorText, pair, squeeze } from './monitor-text.js';
import type { MonitorFrame, MonitorRow } from './monitor.js';
import { boardCursor, footRow, hintText, mark, section } from './workboard-rows.js';

export const MODEL_PICKER_WIDE = 100;
const muted = (s: string) => theme.board.muted(s);
const placeName = (role: string, preset: string | null | undefined) => monitorText(role) + (preset ? ` [${monitorText(preset)}]` : '');
const location = (role: string, preset: string | null | undefined, index: number) => `${placeName(role, preset)} ${t('#{n}', { n: index + 1 })}`;
const capsOf = (pick: ModelPick, entry: PickEntry) => entry.model ? pick.lists.piFacts?.[entry.model] : undefined;
const end = (s: string, n: number) => ' '.repeat(Math.max(0, n - visualLength(s))) + truncateAnsi(s, n);
const center = (s: string, n: number) => fit(' '.repeat(Math.max(0, Math.floor((n - visualLength(s)) / 2))) + s, n);
const note = (entry: PickEntry, now: number) => entry.fact === 'off' ? pickerFact(entry, now, true) : pickerFact(entry, now);
const listedStatus = (entry: PickEntry, pick: ModelPick) =>
  pick.lists.pi.includes(entry.model ?? '') ? pick.lists.piStatus?.offline ? 'offline catalog' : 'listed' : 'not listed';

/** Resolved IDs are exact; an ambiguous bare ID is a separate reference, not a use of either provider. */
function uses(data: ProjectSnapshot, model: string, place: PlaceFact, bare?: string) {
  const exact: string[] = [], ambiguous: string[] = [];
  for (const role of data.roles) {
    const found: string[] = [], unresolved: string[] = [];
    const scan = (chain: PlaceFact[], preset: string | null | undefined) => chain.forEach((p, i) => {
      if (p.harness !== place.harness || p.label !== place.label) return;
      const id = p.piModel?.current ?? p.model;
      const hits = id === model ? found : bare && id === bare ? unresolved : undefined;
      hits?.push(`${preset ? `[${monitorText(preset)}] ` : ''}${t('#{n}', { n: i + 1 })}`);
    });
    const presets = role.presets ?? [];
    if (!presets.some((p) => p.name === role.preset && p.places)) scan(role.places, role.preset);
    for (const preset of presets) if (preset.places) scan(preset.places, preset.name);
    if (role.preset && role.fileChain && role.fileChain !== role.places) scan(role.fileChain, null);
    if (found.length) exact.push(`${monitorText(role.role)} ${found.join(' · ')}`);
    if (unresolved.length) ambiguous.push(`${monitorText(role.role)} ${unresolved.join(' · ')}`);
  }
  return { exact, ambiguous };
}

function detail(data: ProjectSnapshot, input: ModelInput, pick: ModelPick, view: ReturnType<typeof pickView>, width: number, height: number, now: number) {
  const entry = view.selected;
  if (!entry) return [muted(t('No selection'))];
  const model = entry.model, full = model ? monitorText(model) : t('default');
  const target = location(input.role, pick.preset, input.index);
  const provider = qualifiedPiProvider(model);
  const off = entry.fact === 'off', offBy = pick.lists.piStatus?.runnerOff ? 'pi' : provider;
  const status = pick.lists.piStatus;
  const listed = listedStatus(entry, pick), fact = pickerFact(entry, now, true);
  const valueRows = (label: string, value: string, ink = theme.board.text) =>
    flowLines(value, width - 11).map((line, i) => `${muted(fit(i ? '' : t(label), 10))} ${ink(line)}`);
  const role = data.roles.find((r) => r.role === input.role);
  const name = placeName(input.role, pick.preset);
  const next = role?.places.find((p) => p.state === 'active');
  const nextProvider = next?.provider && monitorText(next.provider);
  const destination = next && `${monitorText(next.label)}${nextProvider ? `/${nextProvider}` : ''}`;
  const header = [...flowLines(full, width).map(theme.board.identifier), theme.board.frame(mark('─', '-').repeat(width - 1))];
  const providerState = off ? t('{mark} off (in Harnesses)', { mark: mark('⊘', 'x') }) : t('on · {status}', { status: t(listed) });
  const top = valueRows('provider', provider ? `${monitorText(provider)} · ${providerState}`
    : off ? t('pi is off') : t('provider unknown'), off ? muted : theme.board.text);
  const [ctx, out, thinking, images] = capsOf(pick, entry) ?? [];
  const fields = `${monitorText(ctx ?? '?')}    ${t('max out')} ${monitorText(out ?? '?')}`;
  // The field names are short enough to fit together even at the minimum zoom width.
  top.push(`${muted(fit(t('context'), 10))} ${fields}`,
    `${muted(fit(t('features'), 10))} ${t('thinking')} ${pickerCap(thinking)}    ${t('images')} ${pickerCap(images)}`);
  if (entry.value === '' && pick.place.piModel?.defaultSource) top.push(...valueRows('', t(pick.place.piModel.defaultSource), muted));
  top.push('');
  if (off && entry.current) {
    top.push(...valueRows('state', destination ? t('this place is skipped: {role} → {next}', { role: name, next: destination })
      : t('this place is skipped'), theme.board.attention));
    if (offBy) top.push(...valueRows('', t('⏎ keeps it; pick another model or restore {provider} in Harnesses.', { provider: monitorText(offBy) }), muted));
  } else if (fact) top.push(`${muted(fit(t('state'), 10))} ${fact}`);
  else top.push(...valueRows('state', t(entry.current && pick.place.state === 'missing' ? 'not installed' : listed)));
  if (!entry.fact && entry.until !== undefined && entry.until > now) {
    top.push(...valueRows('', t('it can still be set; the place is skipped until then'), muted));
  }
  const current = view.current?.model;
  const bare = provider && model ? model.slice(provider.length + 1) : undefined;
  if (bare && model !== current && current?.endsWith(`/${bare}`)) top.push(...valueRows('also in', monitorText(current), muted));
  top.push(...valueRows('current', entry.current ? t('yes · {place}', { place: target })
    : current ? t('no · {place} is now {model}', { place: t('place #{n}', { n: input.index + 1 }), model: monitorText(current) }) : t('no')));

  const used = model ? uses(data, model, pick.place, bare) : { exact: [], ambiguous: [] };
  const usage = (used.exact.length ? used.exact : [t('nothing uses it')]).flatMap((line, i) => valueRows(i ? '' : 'used by', line));
  if (!off && bare && used.ambiguous.length) usage.push(...valueRows('bare ID', `${monitorText(bare)} · ${used.ambiguous.join(' · ')}`, muted));
  const bottom = status?.fetchedAt === undefined ? valueRows('list', t('list age unknown'), muted)
    : valueRows('list', t('discovered {age} ago · ^R refreshes', { age: pickerAge(status.fetchedAt, now) }), muted);
  if (off && offBy) bottom.push(...valueRows('', t("{provider}'s models are not listed: the provider is off", { provider: monitorText(offBy) }), muted));
  if (status?.failed) bottom.push(...valueRows('', t('Refresh failed'), muted));
  else if (status?.fetchedAt !== undefined && now - status.fetchedAt >= MODEL_CACHE_TTL_MS) bottom.push(...valueRows('', t('List is stale'), muted));
  const canSet = entry.value !== undefined;
  const action = canSet ? entry.value === '' ? t('sets {place} to default', { place: target }) : t('sets {place} to this model', { place: target })
    : entry.current ? t('keeps {model}', { model: full }) : t('choose a provider row to set a model');
  const actionLead = canSet || entry.current ? `${muted('⏎')} ` : '';
  bottom.push('', ...flowLines(action, width - (actionLead ? 2 : 0)).map((line, i) => (i && actionLead ? '  ' : actionLead) + line));
  // Reserve the action and list facts before a long list of role/preset references.
  const room = Math.max(0, height - header.length - top.length - bottom.length);
  if (usage.length > room && room > 1) usage.splice(room - 1, usage.length, muted(t('… more uses')));
  return [...header, ...top, ...usage.slice(0, room), ...bottom];
}

export function paintZoomedPicker(frame: MonitorFrame, data: ProjectSnapshot, input: ModelInput, pick: ModelPick, width: number, height: number, now: number) {
  const left = Math.floor(width * 7 / 12), rightWidth = width - left - 1, room = height - 2;
  const view = pickView(pick, input, true), status = pick.lists.piStatus;
  const age = status?.fetchedAt === undefined ? '' : t('list {age} old', { age: pickerAge(status.fetchedAt, now) });
  const filtered = !!input.text.trim(), count = filtered ? new Set(placeModels(pick.place, pick.lists)).size : view.total;
  const total = t(count === 1 ? '{n} model' : '{n} models', { n: count });
  const provider = view.current?.fact === 'off' ? qualifiedPiProvider(view.current.model) : undefined;
  const off = data.harnessSwitches?.filter((s) => s.group === 'provider' && s.off).map((s) => s.name).sort();
  if (provider && off?.includes(provider)) off.unshift(...off.splice(off.indexOf(provider), 1));
  const offLine = off?.length ? muted(`${mark('⊘', 'x')} ${t('off, not listed: {names}', { names: off.map(monitorText).join(' · ') })}`) : '';
  const offBadge = provider ? `${monitorText(provider)} ${mark('⊘', 'x')}` : '';
  const where = ` ${t('Model')} · ${placeName(input.role, pick.preset)} ${t('place #{n}', { n: input.index + 1 })} · ${monitorText(pick.place.label)}`;
  const titles = [total, age, offBadge, t('zoomed')].filter(Boolean).join(' · ');
  const shorter = [total, age, t('zoomed')].filter(Boolean).join(' · ');
  frame.lines[0] = theme.board.title(fit(pair(where, `${visualLength(where) + visualLength(titles) + 2 <= width ? titles : shorter} `, width), width));

  const idWidth = left - 38, cols = (ctx: string, out: string, thinking: string, images: string) =>
    ` ${end(ctx, 6)} ${end(out, 5)} ${center(thinking, 5)} ${center(images, 4)}`;
  const columns = `    ${fit(t('Model'), idWidth)}${cols(t('ctx'), t('out'), t('think'), t('img'))} ${t('note')}`;
  const list: MonitorRow[] = [];
  const add = (entry: PickEntry) => {
    const selected = view.selected?.id === entry.id;
    list.push({ text: '', modelHit: { entry: entry.id }, ...(selected ? { item: 'project:pick' } : {}), paint: () => {
      const lead = `${selected ? theme.board.active(mark('›', '>')) : ' '} ${entry.current ? theme.board.active(mark('◉', '@')) : ' '} `;
      const name = entry.value === '' ? entry.label + (entry.model ? ` → ${monitorText(entry.model)}` : '') : monitorText(entry.label);
      const [ctx, out, thinking, images] = capsOf(pick, entry) ?? [];
      const fact = note(entry, now), tag = entry.tags?.map((s) => `[${monitorText(s)}]`).join(' ') ?? '';
      const prefix = lead + fit(squeeze(name, idWidth), idWidth)
        + cols(muted(monitorText(ctx ?? '·')), muted(monitorText(out ?? '·')), pickerCap(thinking), pickerCap(images)) + ' ';
      const annotations = [fact, muted(tag)].filter((s) => visualLength(s)).join(' ');
      return prefix + (visualLength(prefix + annotations) <= left ? annotations : fact || squeeze(tag, left - visualLength(prefix)));
    } });
  };
  if (view.pinned.length) {
    list.push(section(t('Pinned'), left, String(view.pinned.length)));
    view.pinned.forEach(add);
  }
  for (const group of view.groups) {
    list.push({ ...section(theme.board.identifier(`${group.open ? mark('▾', 'v') : mark('▸', '>')} ${monitorText(group.provider)}`), left,
      String(group.entries.length)), modelHit: { provider: group.provider } });
    if (group.open) group.entries.forEach(add);
  }
  if (view.fallback) add(view.fallback);
  if (pick.lists.piStatus?.runnerOff) list.push({ text: muted(t('pi is off')) });
  else if (pick.lists.piStatus?.empty) list.push({ text: muted(t('No discovered models')) });
  else if (!view.groups.length && !view.selected) list.push({ text: muted(t('No matching models')) });
  const size = Math.max(0, room - 2 - Number(!!offLine));
  const window = pickerListWindow(list, input, size);
  const matches = filtered ? t('{n} / {total} matches', { n: view.total, total: count }) : String(view.total);
  const rows: MonitorRow[] = [pickerQuery(input, pick, { ...window, wide: true }, matches, left), { text: muted(columns) },
    ...list.slice(window.first, window.first + size)];
  if (offLine) rows.push({ text: offLine });
  const details = detail(data, input, pick, view, rightWidth - 1, room, now);
  const divider = theme.board.frame(mark('│', '|'));
  for (let i = 0; i < room; i++) {
    const row = rows[i], l = fit(row?.paint?.() ?? row?.text ?? '', left);
    frame.lines[i + 1] = theme.board.text((row?.item === 'project:pick' ? boardCursor(l) : l) + divider + fit(` ${details[i] ?? ''}`, rightWidth));
  }
  const closeHint = input.text ? 'esc clear' : 'esc close and restore';
  frame.lines[height - 1] = theme.board.text(fit(footRow('', hintText(`type to filter  ↑↓ pick  ⏎ set  click a header: fold  ^R refresh  ${closeHint}`), width), width));
  frame.panes.push({ id: 'agents', x: 0, y: 1, width: left, height: room, offset: 0, contentLength: rows.length, edge: 0, visible: room, rows });
  return frame;
}
