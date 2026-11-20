/** Control's chain editor and quick model choice. Forms and drafts stay in memory until Save. */
import { isDeepStrictEqual } from 'node:util';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import { placeDestination, placeItem, placeModels, placeSwitch, previewDraft, replaceableTarget, targetKey,
  type DraftPlace, type ModelLists, type RoleFact } from '../roles/role-control.js';
import { MODEL_ID_MAX } from '../roles/model-discovery.js';
import { qualifiedPiProvider, type RolePlace } from '../roles/roster.js';
import { controlRoleItem } from './control-navigation.js';
import { glyph, modelButton, modelFieldRows, placeRows, presetName, presetTag, sourceLabel, withDestination } from './control-view.js';
import { theme, visualLength } from './colors.js';
import { t } from './i18n.js';
import { fit, flowLines, monitorText, pair, squeeze } from './monitor-text.js';
import { boardRow, kvRows, mark, section, type FooterHints } from './workboard-rows.js';
import { modelInputEvent } from './model-input.js';
import { monitorRowAt } from './monitor-input.js';
import type { MonitorContext, MonitorOutcome, MonitorRow, MonitorState } from './monitor.js';

type Field = 'target' | 'model' | 'kind' | 'thinking' | 'effort' | 'done';
type Choice = { text: string; at: number };
type Sheet = { index: number; place?: DraftPlace; field: Field; choice?: Choice; error?: string };
export type QuickModelInput = { role: RoleFact; index: number; choice?: Choice; error?: string };
export interface ChainInput {
  role: RoleFact;
  at: number;
  draft?: { name?: string; run: DraftPlace[] };
  sheet?: Sheet;
  leave?: WorkbenchInput;
  error?: string;
}
const fields = (sheet: Sheet): Field[] => {
  const p = sheet.place?.raw;
  if (!p) return ['target', 'model', 'thinking', 'done'];
  if (p.tool === 'jev-flow') return ['target', 'kind', 'done'];
  if (p.tool === 'jev-ask') return ['target', 'effort', 'done'];
  return ['target', 'model', 'thinking', 'done'];
};
const fieldLabel: Record<Field, string> = { target: 'target', model: 'model', kind: 'Flow kind', thinking: 'thinking', effort: 'Effort', done: 'done' };
const fieldItem = (field: Field) => `chain:field:${field}`;
const optItem = (at: number) => `chain:option:${at}`;
const muted = theme.board.muted;
const textOf = (value: string) => monitorText(value);
const savedNext = (role: RoleFact) => role.places.find((p) => p.state === 'active');
const nextLabel = (place: ReturnType<typeof savedNext>) => place ? placeDestination(place) : t('none');
const file = (chain: ChainInput, editing = false): MonitorOutcome['action'] => ({ type: 'open-files',
  files: [(editing ? chain.role.chainPath : undefined) ?? chain.role.path] });
const OFF = 'Off targets cannot be selected';
const ADVANCED = 'launch options are set in the file: o opens it';
const EMPTY = 'needs a place to save';

export function finishChain(state: MonitorState): MonitorState {
  const chain = state.controlChain!;
  return { ...state, controlChain: undefined, projectInput: undefined, controlNav: { ...state.controlNav,
    projectCursor: controlRoleItem(chain.role.role), splitFocus: undefined, splitList: undefined, splitSub: undefined, boardRevealed: undefined } };
}

/** The model field can take the existing pi picker (including zoom); other fields use an inline list. */
function fill(place: DraftPlace, field: 'model' | 'kind' | 'thinking' | 'effort', value?: string): DraftPlace {
  if (place.raw[field] === value) return place;
  const raw = { ...place.raw }, fact = { ...place.fact };
  if (value === undefined) delete raw[field];
  else Object.assign(raw, { [field]: value });
  if (field === 'kind') fact.kind = raw.kind ?? 'image';
  if (field === 'thinking') {
    fact.thinking = raw.thinking ?? place.defaultThinking ?? null;
    fact.inheritedThinking = value === undefined && !!fact.thinking;
  }
  if (field === 'effort') fact.thinking = raw.effort ?? null;
  if (field === 'model') {
    fact.model = raw.model ?? place.defaultModel ?? null;
    if (fact.piModel) {
      fact.provider = value === undefined ? place.defaultProvider : qualifiedPiProvider(value) ?? null;
      fact.piModel = { ...fact.piModel, current: value ?? fact.piModel.defaultId, isDefault: value === undefined };
    }
  }
  return { ...place, raw, fact };
}

type Option = { label: string; value?: string; target?: DraftPlace; off?: boolean; missing?: boolean };
function choices(role: RoleFact, sheet: Sheet, lists: ModelLists): Option[] {
  const p = sheet.place?.raw, catalog = lists.editor;
  if (sheet.field === 'target') return (role.editor?.targets ?? []).map((target) => ({
    label: target.fact.label, target, off: catalog?.off.includes(placeSwitch(target.raw)), missing: !!target.fact.missing,
  }));
  if (!p || !sheet.place) return [];
  const { field } = sheet;
  const values = field === 'kind' ? catalog?.flowKinds : field === 'model' || field === 'effort' ? placeModels(sheet.place.fact, lists)
    : p.harness === 'pi' ? catalog?.piThinking : p.harness === 'cli' ? catalog?.cliThinking : ['Low', 'High'];
  const current = field === 'done' ? undefined : p[field];
  return [{ label: t('clear') }, ...[...new Set([...(values ?? []), ...(current ? [current] : [])])].map((value) => ({ label: value, value }))];
}
function matching(role: RoleFact, sheet: Sheet, lists: ModelLists) {
  const needle = sheet.choice?.text.trim().toLowerCase() ?? '';
  return choices(role, sheet, lists).filter((option) => option.label.toLowerCase().includes(needle));
}
const modelsOf = (ctx: MonitorContext) => ctx.frame?.controlModels ?? { pi: [], cli: {}, bro: {} };
const clock = (ctx: MonitorContext) => ctx.nowMs ?? ctx.frame?.controlNow ?? 0;
export const takesModel = (p: DraftPlace | undefined) => p && (p.fact.harness !== 'bro' || p.fact.label === 'aistudio');
export const roleModelIndex = (role: RoleFact) => Math.max(0, role.places.findIndex((p) => p.state === 'active'));
const quickPlace = (state: MonitorState, { role, index }: QuickModelInput) =>
  (state.controlChain?.draft?.run ?? role.editor?.places)?.[index];
const inlineChoices = (state: MonitorState, quick: QuickModelInput, models: ModelLists) =>
  matching(quick.role, { ...quick, field: 'model', place: quickPlace(state, quick) }, models);
const choiceText = (text: string, typed?: string) => typed === undefined ? [...text].slice(0, -1).join('')
  : [...text, ...typed].slice(0, MODEL_ID_MAX).join('');

export function openQuickModel(state: MonitorState, role: RoleFact, index: number, ctx: MonitorContext): MonitorState {
  const quick: QuickModelInput = { role, index }, p = quickPlace(state, quick), models = modelsOf(ctx);
  if (role.source === 'project' || !p || !takesModel(p)) return state;
  if (p.raw.harness === 'pi') {
    const place = state.controlChain?.draft ? previewDraft([p], models, clock(ctx))[0] : role.places[index];
    return { ...state, controlQuickModel: quick, projectInput: { role: role.role, index, text: '', place } };
  }
  quick.choice = { text: '', at: Math.max(0, inlineChoices(state, quick, models).findIndex((o) => o.value === p.raw.model)) };
  return { ...state, controlQuickModel: quick };
}

export function quickModelKey(state: MonitorState, input: WorkbenchInput, ctx: MonitorContext): MonitorOutcome {
  const quick = state.controlQuickModel!, { role, index, choice } = quick, chain = state.controlChain;
  const closed = { ...state, controlQuickModel: undefined, projectInput: undefined };
  const out = (next = state, action?: MonitorOutcome['action']): MonitorOutcome => ({ state: next, close: false, action });
  const run = chain?.draft?.run ?? role.editor!.places, place = run[index]!, models = modelsOf(ctx);
  const set = (value?: string) => {
    const updated = [...run];
    updated[index] = fill(place, 'model', value);
    if (choice && value !== place.raw.model && previewDraft([updated[index]], models, clock(ctx))[0]?.state === 'off')
      return out({ ...state, controlQuickModel: { ...quick, error: OFF } });
    if (chain?.draft) return out({ ...closed, controlChain: { ...chain, draft: { ...chain.draft, run: updated }, error: undefined } });
    return out(closed, { type: 'preset-edit', op: 'run', role: role.role, revision: role.revision, modelIndex: index, run: updated.map((p) => p.raw) });
  };
  if (!choice) {
    const picked = modelInputEvent(state, input, ctx);
    if (picked?.action?.type === 'model-picked') return set(picked.action.value || undefined);
    if (!picked) return out();
    return picked.state.projectInput ? picked : out(closed);
  }
  const list = inlineChoices(state, quick, models);
  const update = (choice: Choice, error?: string) => out({ ...state, controlQuickModel: { ...quick, choice, error } });
  const move = (at: number) => update({ ...choice, at: Math.max(0, Math.min(list.length - 1, at)) });
  const apply = () => list[choice.at] ? set(list[choice.at]!.value) : update(choice, 'No matching choices');
  if (input.type === 'mouse') {
    if (input.button !== 'left') return move(choice.at + (input.button === 'wheel-down' ? 1 : -1));
    if (ctx.frame?.controls.some((c) => c.kind === 'preset-cancel' && c.y === input.y && input.x >= c.x && input.x < c.x + c.width))
      return out(closed);
    const pane = ctx.frame?.panes.find((p) => p.id === 'preview') ?? ctx.frame?.panes.find((p) => p.id === 'agents');
    const item = pane && monitorRowAt(pane, input.x, input.y)?.item;
    const id = /^chain:option:(\d+)$/.exec(item ?? '')?.[1];
    return id === undefined ? out() : Number(id) === choice.at ? apply() : move(Number(id));
  }
  if (input.text !== undefined || input.key === 'backspace') return update({ text: choiceText(choice.text, input.text), at: 0 });
  switch (input.key) {
    case 'escape': case 'close': return out(closed);
    case 'enter': return apply();
    case 'up': return move(choice.at - 1);
    case 'down': return move(choice.at + 1);
    case 'page-up': return move(choice.at - 5);
    case 'page-down': return move(choice.at + 5);
    case 'home': return move(0);
    case 'end': return move(list.length - 1);
    default: return out();
  }
}

function optionRows(list: Option[], at: number, size: number, width: number): MonitorRow[] {
  const start = Math.max(0, Math.min(list.length - size, at - Math.floor(size / 2)));
  return list.slice(start, start + size).map((opt, i) => ({ item: optItem(start + i), text: pair(
    `${start + i === at ? mark('›', '>') : ' '}     ` + (opt.off ? glyph('off') : opt.missing ? glyph('missing') : glyph('standby')) + ` ${textOf(opt.label)}`,
    muted(opt.off ? t('Off') : opt.missing ? t('not installed') : ''), width) }));
}

export function inlineModelSheet(state: MonitorState, models: ModelLists, width: number, room: number) {
  const quick = state.controlQuickModel!, { role, index, choice, error } = quick, draft = state.controlChain?.draft;
  const list = inlineChoices(state, quick, models), at = choice!.at;
  const rule = { label: monitorText(role.role), right: [presetTag(draft?.name ?? role.preset), t('place #{n}', { n: index + 1 }),
    draft ? t('Not saved') : ''].filter(Boolean).join(' · ') };
  const count = String(list.length), label = `  ${fit(t('model'), 10)} `;
  const query = boardRow(pair(label + squeeze(`/ ${textOf(choice!.text)}${mark('▌', '_')}`, width - visualLength(label + count) - 1), muted(count), width));
  const messages = error || !list.length ? flowLines(t(error ?? 'No matching choices'), width).map((line) => boardRow(theme.board.attention(line))) : [];
  return { rule, cursor: optItem(at), hints: 'type to filter  ↑↓ pick  ⏎ set  esc cancel',
    rows: [query, ...messages, ...optionRows(list, at, Math.max(1, room - 1 - messages.length), width)] };
}

export function chainInputKey(state: MonitorState, input: WorkbenchInput, ctx: MonitorContext,
  route: (state: MonitorState, input: WorkbenchInput, ctx: MonitorContext) => MonitorOutcome): MonitorOutcome {
  if (state.controlPresetNotice && 'index' in state.controlPresetNotice) state = { ...state, controlPresetNotice: undefined };
  const chain = state.controlChain!, { role, draft, sheet } = chain;
  const run = draft?.run ?? role.editor?.places ?? [];
  const key = input.type === 'key' ? input.key : '', typed = input.type === 'key' ? input.text : undefined;
  const models = modelsOf(ctx);
  const camera = ctx.frame?.panes.find((p) => p.id === 'preview') ?? ctx.frame?.panes.find((p) => p.id === 'agents');
  const clicked = input.type === 'mouse' && input.button === 'left';
  const hit = clicked ? ctx.frame?.controls.find((c) => c.y === input.y && input.x >= c.x && input.x < c.x + c.width) : undefined;
  const item = clicked && camera ? monitorRowAt(camera, input.x, input.y)?.item : undefined;
  const move = input.type === 'mouse' && input.button !== 'left' ? input.button === 'wheel-down' ? 1 : -1
    : key === 'up' ? -1 : key === 'down' ? 1 : key === 'page-up' ? -5 : key === 'page-down' ? 5 : 0;
  const select = (at: number, n: number) => Math.max(0, Math.min(n - 1, key === 'home' ? 0 : key === 'end' ? n - 1 : at + move));
  const out = (update: Partial<ChainInput> = {}, action?: MonitorOutcome['action']): MonitorOutcome => ({
    state: { ...state, controlChain: { ...chain, ...update } }, close: false, action,
  });
  const cancelKey = key === 'escape' || (key === 'close' && !typed);
  if (chain.leave) {
    if (cancelKey || hit?.kind === 'chain-back') return out({ leave: undefined });
    if (key !== 'enter' && hit?.kind !== 'chain-accept') return out();
    const next = finishChain(state);
    return chain.leave.type === 'key' && chain.leave.key === 'escape' ? { state: next, close: false } : route(next, chain.leave, ctx);
  }
  if (state.projectInput && sheet?.place) {
    const picked = modelInputEvent(state, input, ctx);
    if (picked?.action?.type !== 'model-picked') return picked ?? out();
    const { value } = picked.action;
    return { ...picked, action: undefined, state: { ...picked.state, controlChain: { ...chain,
      sheet: { ...sheet, place: fill(sheet.place, 'model', value || undefined), error: undefined } } } };
  }
  const openField = (form: Sheet, field: Field): MonitorOutcome => {
    const fieldState = { ...form, field, error: undefined };
    if (field === 'done') {
      if (!form.place) return out({ sheet: { ...form, error: 'Choose a target first' } });
      const existing = run[form.index]?.raw;
      if (isDeepStrictEqual(existing, form.place.raw)) return out({ sheet: undefined });
      if ((!existing || targetKey(existing) !== targetKey(form.place.raw) || existing.model !== form.place.raw.model) &&
        previewDraft([form.place], models, ctx.nowMs ?? ctx.frame?.controlNow ?? 0)[0]?.state === 'off')
        return out({ sheet: { ...form, error: OFF } });
      const updated = [...run];
      updated[form.index] = form.place;
      return out({ draft: { ...draft, run: updated }, sheet: undefined, at: form.index, error: undefined });
    }
    if (!form.place && field !== 'target') return out({ sheet: { ...form, error: 'Choose a target first' } });
    if (field === 'model' && form.place?.raw.harness === 'pi') {
      const { role: name } = role, index = form.index;
      const result = out({ sheet: fieldState });
      result.state.projectInput = { role: name, index, text: '', place: previewDraft([form.place], models, clock(ctx))[0] };
      return result;
    }
    const options = matching(role, fieldState, models);
    const at = Math.max(0, field === 'target' ? options.findIndex((o) => form.place ? targetKey(o.target!.raw) === targetKey(form.place.raw) : !o.off)
      : options.findIndex((o) => o.value === form.place?.raw[field]));
    return out({ sheet: { ...fieldState, choice: { text: '', at } } });
  };
  const leave = (!sheet || (!sheet.choice && !cancelKey)) && (
    ['escape', 'close', 'tab', 'shift-tab', 'left', 'right', 'project-prev', 'project-next', 'settings', 'help', 'changes'].includes(key) ||
    hit?.kind.startsWith('board-') || hit?.kind === 'control-harnesses' || (!sheet && hit?.kind === 'chain-back'));
  if (leave) {
    const destination = hit?.kind === 'chain-back' ? { type: 'key' as const, key: 'escape' } : input;
    if (draft) return out({ leave: destination });
    const next = finishChain(state);
    return destination.type === 'key' && destination.key === 'escape' ? { state: next, close: false } : route(next, destination, ctx);
  }
  if (sheet) {
    if (cancelKey || hit?.kind === 'chain-back' || hit?.kind === 'preset-cancel')
      return out({ sheet: sheet.choice ? { ...sheet, choice: undefined, error: undefined } : undefined });
    if (((key === 'open-session' && !sheet.choice) || hit?.kind === 'control-open-file') && sheet.error === ADVANCED) return out({}, file(chain, true));
    if (sheet.choice) {
      const list = matching(role, sheet, models), index = /^chain:option:(\d+)$/.exec(item ?? '')?.[1];
      const choice = { ...sheet.choice }, update = (error?: string) => out({ sheet: { ...sheet, choice, error } });
      if (typed !== undefined || key === 'backspace') {
        choice.text = choiceText(choice.text, typed);
        choice.at = 0;
        return update();
      }
      if (move || key === 'home' || key === 'end') { choice.at = select(choice.at, list.length); return update(); }
      if (index !== undefined && Number(index) !== choice.at) { choice.at = Number(index); return update(); }
      if (key !== 'enter' && hit?.kind !== 'chain-accept' && index === undefined) return out();
      const value = list[choice.at];
      if (!value) return update('No matching choices');
      if (value.off) return update(OFF);
      let place = sheet.place;
      if (value.target) {
        if (place && targetKey(place.raw) !== targetKey(value.target.raw) && !replaceableTarget(place.raw))
          return out({ sheet: { ...sheet, choice: undefined, error: ADVANCED } });
        if (!place || targetKey(place.raw) !== targetKey(value.target.raw)) place = value.target;
      } else if (place && sheet.field !== 'target' && sheet.field !== 'done') place = fill(place, sheet.field, value.value);
      return out({ sheet: { ...sheet, place, choice: undefined, error: undefined } });
    }
    const all = fields(sheet), selected = all.find((field) => fieldItem(field) === item);
    if (key === 'enter' || hit?.kind === 'chain-edit' || selected === sheet.field) return openField(sheet, sheet.field);
    if ((key === 'place-model' || hit?.kind === 'control-model') && all.includes('model')) return openField(sheet, 'model');
    const field = selected ?? all[select(all.indexOf(sheet.field), all.length)]!;
    return out({ sheet: { ...sheet, field, error: field !== sheet.field ? undefined : sheet.error } });
  }
  if (key === 'reset') return out({}, { type: 'refresh-models' });
  if (!draft && (key === 'open-session' || hit?.kind === 'control-open-file')) return out({}, file(chain));
  if (!draft && key === 'place-clear' && role.places[chain.at]?.until !== undefined)
    return out({}, { type: 'role-edit', role: role.role, index: chain.at, op: 'clear', revision: role.revision });
  const n = draft || role.editor ? run.length : role.places.length;
  const index = /^project:role:[^:]+:(\d+)$/.exec(hit?.item ?? item ?? '')?.[1];
  const at = index === undefined ? chain.at : Number(index);
  if (move || key === 'home' || key === 'end') return out({ at: select(at, n) });
  if (role.source === 'project' || !role.editor) return index === undefined ? out() : out({ at });
  if (key === 'place-add' || hit?.kind === 'chain-add') return out({ sheet: { index: run.length, field: 'target' } });
  if (key === 'place-model' || hit?.kind === 'control-model') {
    if (!takesModel(run[at])) return out();
    return { state: openQuickModel(out({ at }).state, role, at, ctx), close: false };
  }
  if (run[at] && (key === 'enter' || hit?.kind === 'chain-edit' || (index !== undefined && at === chain.at)))
    return out({ at, sheet: { index: at, place: run[at], field: 'target' } });
  if (draft && (key === 'settings-save' || hit?.kind === 'chain-save')) {
    if (!run.length) return out({ error: EMPTY });
    const change = draft.name === undefined ? { op: 'run' as const } : { op: 'create' as const, name: draft.name };
    return out({}, { type: 'preset-edit', ...change, role: role.role, revision: role.revision, run: run.map((p) => p.raw) });
  }
  if (run[at] && (key === 'place-remove' || hit?.kind === 'chain-remove')) {
    const updated = run.filter((_, i) => i !== at);
    return out({ draft: { ...draft, run: updated }, at: Math.max(0, Math.min(at, updated.length - 1)), error: undefined });
  }
  const step = key === 'place-up' || hit?.kind === 'chain-up' ? -1 : key === 'place-down' || hit?.kind === 'chain-down' ? 1 : 0;
  const to = at + step;
  if (step && run[at] && run[to]) {
    const updated = [...run];
    [updated[at], updated[to]] = [run[to]!, run[at]!];
    return out({ draft: { ...draft, run: updated }, at: to, error: undefined });
  }
  return index === undefined ? out() : out({ at });
}

export function chainSheet(chain: ChainInput, models: ModelLists, width: number, room: number, now: number): {
  rule: { label: string; right: string }; cursor?: string; hints: FooterHints; rows: MonitorRow[];
} {
  const { role, draft, sheet } = chain, name = draft?.name ?? role.preset;
  const rule = { label: monitorText(role.role), right: [draft ? presetName(name) : presetTag(name),
    draft ? t('Not saved') : ''].filter(Boolean).join(' · ') };
  const line = (text: string) => boardRow(fit(text, width));
  const error = (word?: string) => word ? flowLines(t(word), width).map((part) => line(theme.board.attention(part))) : [];
  if (chain.leave) return { rule, cursor: undefined, hints: { modal: ['⏎ discard', 'Esc resume'] }, rows: error('Discard edits?') };
  if (sheet) {
    const list = sheet.choice ? matching(role, sheet, models) : [];
    const at = sheet.choice?.at ?? 0;
    const caption = section(t(sheet.index < (draft?.run.length ?? role.places.length) ? 'Edit place' : 'Add place'), width, t('#{n}', { n: sheet.index + 1 }));
    const messages = error(sheet.error);
    const row = (field: Field): MonitorRow => {
      const { place } = sheet, p = place?.raw, fact = place?.fact;
      const val = field === 'target' ? fact?.label : field === 'done' ? '' : field === 'thinking' ? fact?.thinking ?? ''
        : field === 'kind' ? fact?.kind ?? '' : p?.[field] ?? (p ? '' : undefined);
      const lead = !sheet.choice && field === sheet.field ? `${mark('›', '>')} ` : '  ';
      const label = lead + fit(t(fieldLabel[field]), 10) + ' ', x = visualLength(label);
      const query = sheet.choice && field === sheet.field ? `/ ${textOf(sheet.choice.text)}${mark('▌', '_')}` : undefined;
      const right = query !== undefined ? String(list.length) : field === 'done' && !p && !sheet.choice ? t('after target and model') : '';
      const item = fieldItem(field);
      if (query === undefined && field === 'model' && fact) {
        const button = modelButton(fact, width - x);
        return { item, text: fit(label + button, width), ...(!sheet.choice ? { controls: [{ kind: 'control-model', item, x, width: visualLength(button) }] } : {}) };
      }
      const value = squeeze(query ?? (val === undefined ? t('choose…') : textOf(val)), width - x - (right ? visualLength(right) + 1 : 0));
      return { item, text: pair(label + (field === 'thinking' && fact?.inheritedThinking && !query && value ? muted(value) : value), muted(right), width) };
    };
    const all = fields(sheet), cursor = sheet.choice ? optItem(at) : fieldItem(sheet.field);
    const size = Math.max(1, room - 1 - all.length - messages.length - Number(sheet.field === 'target'));
    const options = optionRows(list, at, size, width);
    const rows = sheet.choice ? all.flatMap((f) => [row(f), ...(f === sheet.field ? options.length || sheet.error ? options : error('No matching choices') : [])]) : all.map(row);
    if (sheet.choice && sheet.field === 'target' && room > rows.length + messages.length + 1) rows.push(line(muted(t('off: not selectable · missing: marked'))));
    const hints = sheet.choice ? { modal: ['type to filter', '⏎ fill', 'Esc cancel'] }
      : [...(sheet.error === ADVANCED ? ['o file'] : []), '⏎ choose', 'Esc cancel'];
    return { rule, cursor, hints, rows: [caption, ...messages, ...rows] };
  }
  const places = draft ? previewDraft(draft.run, models, now) : role.places;
  const cursor = places[chain.at] ? placeItem(role.role, chain.at) : undefined;
  const header = draft ? [line(theme.board.attention(t('Not saved')) + ' · ' + t(places.length ? 's saves and selects' : EMPTY)),
    ...kvRows('saved', [presetTag(role.preset), mark('→', '>'), nextLabel(savedNext(role))].filter(Boolean).join(' '), width),
    ...kvRows('draft', nextLabel(places.find((p) => p.state === 'active')) + (places.length ? ' ' + t('(unsaved)') : ''), width)]
    : [];
  const source = draft ? [] : [...kvRows('source', `${sourceLabel(role.source)} · ${role.source === 'project' ? '.hud/roles/' : ''}${role.path.split('/').at(-1)}`, width),
    ...(role.source === 'project' ? kvRows('pinned', t('project file · read-only here'), width) : kvRows('scope', t('Global role · all projects'), width))];
  const rows = places.flatMap((p, i) => {
    const extra = { item: placeItem(role.role, i), files: [role.path] };
    const status = p.state === 'off' ? t('Switched off') : p.state === 'missing' ? t('not installed') : p.state === 'exhausted' ? t('exhausted') : '';
    const unknown = p.provider === null ? t('provider unknown') : '';
    const lead = `${i === chain.at ? mark('›', '>') : ' '} ${i + 1} ${glyph(p.state)} `;
    if (role.source === 'project' || !takesModel((draft?.run ?? role.editor?.places)?.[i])) {
      return [...placeRows(lead, withDestination(p), width, '  ', muted(status), extra),
        ...(unknown ? [{ ...extra, text: fit('      ' + muted(unknown), width) }] : [])];
    }
    const note = [status, unknown].filter(Boolean).join(' · ');
    return [...modelFieldRows(p, lead, width, extra, p.state === 'active' ? (text) => text : muted),
      ...(note ? [{ ...extra, text: fit('      ' + muted(note), width) }] : [])];
  });
  const messages = chain.error && chain.error !== EMPTY ? error(chain.error) : [];
  const top = [...messages, ...header, ...(header.length ? [boardRow('')] : []), section(t('Chain'), width, String(places.length))];
  const size = Math.max(1, room - top.length - source.length), at = rows.findIndex((row) => row.item === cursor);
  let end = at;
  while (rows[end + 1] && rows[end + 1]!.item === cursor) end++;
  // Keep the selected place's continuation and notes in view when they fit together.
  const start = Math.max(0, Math.min(rows.length - size, at, Math.max(end - size + 1, at - Math.floor(size / 2))));
  const clear = !draft && places[chain.at]?.until !== undefined ? ['x clear'] : [];
  const move = places.length > 1 ? ['K J move'] : [], edit = cursor ? ['⏎ edit'] : [];
  const model = takesModel((draft?.run ?? role.editor?.places)?.[chain.at]) ? ['m model'] : [];
  const hints = role.source === 'project' ? ['o file', ...clear, 'Esc back'] : draft
    ? places.length ? ['s save', ...edit, 'Esc discard', 'i add', ...move, 'Del remove', ...model] : ['i add', 'Esc discard']
    : [...model, ...clear, ...edit, 'Esc back', 'i add', 'o file', ...move, 'Del remove'];
  return { rule, cursor, hints, rows: [...top, ...(places.length ? rows.slice(start, start + size) : [line(muted(`  ${t('empty · i adds the first place')}`))]), ...source] };
}
