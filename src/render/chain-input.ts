/** Control's in-place chain editor. The form and draft are memory only until one explicit Save. */
import { isDeepStrictEqual } from 'node:util';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import { placeDestination, placeItem, placeModels, placeSwitch, previewDraft, replaceableTarget, targetKey,
  type DraftPlace, type ModelLists, type RoleFact } from '../roles/role-control.js';
import { MODEL_ID_MAX } from '../roles/model-discovery.js';
import { qualifiedPiProvider, type RolePlace } from '../roles/roster.js';
import { controlRoleItem } from './control-navigation.js';
import { glyph, modelFieldRows, placeRows } from './control-view.js';
import { theme, visualLength } from './colors.js';
import { t } from './i18n.js';
import { fit, flowLines, monitorText, pair, squeeze } from './monitor-text.js';
import { boardRow, kvRows, mark, section } from './workboard-rows.js';
import { modelInputEvent } from './model-input.js';
import { monitorRowAt } from './monitor-input.js';
import type { MonitorContext, MonitorOutcome, MonitorRow, MonitorState } from './monitor.js';

type Field = 'target' | 'model' | 'kind' | 'thinking' | 'effort' | 'done';
type Sheet = { index: number; place?: DraftPlace; field: Field; choice?: { text: string; at: number }; error?: string };
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
  if (field === 'thinking') fact.thinking = raw.thinking ?? place.defaultThinking ?? null;
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
function choices(chain: ChainInput, sheet: Sheet, lists: ModelLists): Option[] {
  const p = sheet.place?.raw, catalog = lists.editor;
  if (sheet.field === 'target') return (chain.role.editor?.targets ?? []).map((target) => ({
    label: target.fact.label, target, off: catalog?.off.includes(placeSwitch(target.raw)), missing: !!target.fact.missing,
  }));
  if (!p || !sheet.place) return [];
  const { field } = sheet;
  const values = field === 'kind' ? catalog?.flowKinds : field === 'model' || field === 'effort' ? placeModels(sheet.place.fact, lists)
    : p.harness === 'pi' ? catalog?.piThinking : p.harness === 'cli' ? catalog?.cliThinking : ['Low', 'High'];
  const current = field === 'done' ? undefined : p[field];
  return [{ label: t('default') }, ...[...new Set([...(values ?? []), ...(current ? [current] : [])])].map((value) => ({ label: value, value }))];
}
function matching(chain: ChainInput, sheet: Sheet, lists: ModelLists) {
  const needle = sheet.choice?.text.trim().toLowerCase() ?? '';
  return choices(chain, sheet, lists).filter((option) => option.label.toLowerCase().includes(needle) ||
    (option.value === undefined && !option.target && 'default'.includes(needle)));
}

export function chainInputKey(state: MonitorState, input: WorkbenchInput, ctx: MonitorContext,
  route: (state: MonitorState, input: WorkbenchInput, ctx: MonitorContext) => MonitorOutcome): MonitorOutcome {
  const chain = state.controlChain!, { role, draft, sheet } = chain;
  const run = draft?.run ?? role.editor?.places ?? [];
  const key = input.type === 'key' ? input.key : '', typed = input.type === 'key' ? input.text : undefined;
  const models = ctx.frame?.controlModels ?? { pi: [], cli: {}, bro: {} };
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
      result.state.projectInput = { role: name, index, text: '', sheetPlace: previewDraft([form.place], models, ctx.nowMs ?? ctx.frame?.controlNow ?? 0)[0] };
      return result;
    }
    const options = matching(chain, fieldState, models);
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
      const list = matching(chain, sheet, models), index = /^chain:option:(\d+)$/.exec(item ?? '')?.[1];
      const choice = { ...sheet.choice }, update = (error?: string) => out({ sheet: { ...sheet, choice, error } });
      if (typed !== undefined || key === 'backspace') {
        choice.text = typed !== undefined ? [...choice.text, ...typed].slice(0, MODEL_ID_MAX).join('') : [...choice.text].slice(0, -1).join('');
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
    if (key === 'place-model' && all.includes('model')) return openField(sheet, 'model');
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
  if (run[at] && (key === 'enter' || key === 'place-model' || hit?.kind === 'chain-edit' || hit?.kind === 'control-model' || (index !== undefined && at === chain.at))) {
    const form: Sheet = { index: at, place: run[at], field: 'target' };
    if (key === 'place-model' || hit?.kind === 'control-model') {
      if (!fields(form).includes('model')) return out({ at });
      const opened = openField(form, 'model');
      opened.state.controlChain!.at = at;
      return opened;
    }
    return out({ at, sheet: form });
  }
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
  rule: { label: string; right: string }; cursor?: string; hints: string; rows: MonitorRow[];
} {
  const { role, draft, sheet } = chain, name = draft?.name ?? role.preset;
  const rule = { label: monitorText(role.role), right: [name ? draft ? monitorText(name) : `[${monitorText(name)}]` : t('Custom'),
    draft ? t('Not saved') : ''].filter(Boolean).join(' · ') };
  const line = (text: string) => boardRow(fit(text, width));
  const error = (word?: string) => word ? flowLines(t(word), width).map((part) => line(theme.board.attention(part))) : [];
  if (chain.leave) return { rule, cursor: undefined, hints: '⏎ discard  esc resume', rows: error('Discard edits?') };
  if (sheet) {
    const list = sheet.choice ? matching(chain, sheet, models) : [];
    const at = sheet.choice?.at ?? 0;
    const caption = section(t(sheet.index < (draft?.run.length ?? role.places.length) ? 'Edit place' : 'Add place'), width, t('#{n}', { n: sheet.index + 1 }));
    const messages = error(sheet.error);
    const row = (field: Field) => {
      const { place } = sheet, p = place?.raw;
      const val = field === 'target' ? place?.fact.label : field === 'done' ? ''
        : p?.[field] ?? (p || field === 'thinking' ? t('default') : undefined);
      const lead = !sheet.choice && field === sheet.field ? `${mark('›', '>')} ` : '  ';
      const label = lead + fit(t(fieldLabel[field]), 10) + ' ';
      const query = sheet.choice && field === sheet.field ? `/ ${textOf(sheet.choice.text)}${mark('▌', '_')}` : undefined;
      const right = query !== undefined ? String(list.length) : field === 'done' && !p && !sheet.choice ? t('after target and model') : '';
      return { item: fieldItem(field), text: pair(label + squeeze(query ?? (val === undefined ? t('choose…') : textOf(val)),
        width - visualLength(label) - (right ? visualLength(right) + 1 : 0)), muted(right), width) };
    };
    const all = fields(sheet), cursor = sheet.choice ? optItem(at) : fieldItem(sheet.field);
    const size = Math.max(1, room - 1 - all.length - messages.length - Number(sheet.field === 'target'));
    const start = Math.max(0, Math.min(list.length - size, at - Math.floor(size / 2)));
    const options = list.slice(start, start + size).map((opt, i) => ({ item: optItem(start + i), text: pair(
      `${start + i === at ? mark('›', '>') : ' '}     ` + (opt.off ? glyph('off') : opt.missing ? glyph('missing') : glyph('standby')) + ` ${textOf(opt.label)}`,
      muted(opt.off ? t('Off') : opt.missing ? t('not installed') : ''), width) }));
    const rows = sheet.choice ? all.flatMap((f) => [row(f), ...(f === sheet.field ? options.length || sheet.error ? options : error('No matching choices') : [])]) : all.map(row);
    if (sheet.choice && sheet.field === 'target' && room > rows.length + messages.length + 1) rows.push(line(muted(t('off: not selectable · missing: marked'))));
    return { rule, cursor, hints: sheet.choice ? 'type to filter  ↑↓ pick  ⏎ fill  esc cancel'
      : sheet.error === ADVANCED ? 'o open file  ↑↓ field  ⏎ choose  esc cancel' : '↑↓ field  ⏎ choose  esc cancel', rows: [caption, ...messages, ...rows] };
  }
  const places = draft ? previewDraft(draft.run, models, now) : role.places;
  const cursor = places[chain.at] ? placeItem(role.role, chain.at) : undefined;
  const header = draft ? [line(theme.board.attention(t('Not saved')) + ' · ' + t(places.length ? 's saves and selects' : EMPTY)),
    ...kvRows('saved', `[${role.preset ?? t('Custom')}] ${mark('→', '>')} ${nextLabel(savedNext(role))}`, width),
    ...kvRows('draft', nextLabel(places.find((p) => p.state === 'active')) + (places.length ? ' ' + t('(unsaved)') : ''), width)]
    : [...kvRows('next job', nextLabel(savedNext(role)), width), ...kvRows('source', `${t(role.source)} · ${role.source === 'project' ? '.hud/roles/' : ''}${role.path.split('/').at(-1)}`, width),
      ...(role.source === 'project' ? kvRows('pinned', t('project file · read-only here'), width) : kvRows('scope', t('Global role · all projects'), width))];
  const rows = places.flatMap((p, i) => {
    const extra = { item: placeItem(role.role, i), files: [role.path] };
    const status = p.state === 'off' ? t('Switched off') : p.state === 'missing' ? t('not installed') : p.state === 'exhausted' ? t('exhausted') : '';
    const lead = `${i === chain.at ? mark('›', '>') : ' '} ${i + 1} ${glyph(p.state)} `;
    if (draft || role.source === 'project' || p.harness === 'bro') {
      const shown = p.provider ? { ...p, label: placeDestination(p), model: p.model?.replace(`${p.provider}/`, '') ?? null } : p;
      return placeRows(lead, shown, width, '  ', muted(status), extra);
    }
    return [...modelFieldRows(p, lead, width, extra, p.state === 'active' ? (text) => text : muted),
      ...(status ? [{ ...extra, text: fit('      ' + muted(status), width) }] : [])];
  });
  const messages = chain.error && chain.error !== EMPTY ? error(chain.error) : [];
  const top = [...messages, ...header, boardRow(''), section(t('Chain'), width, String(places.length))];
  const size = Math.max(1, room - top.length), at = rows.findIndex((row) => row.item === cursor);
  const start = Math.max(0, Math.min(rows.length - size, at - Math.floor(size / 2)));
  const clear = !draft && places[chain.at]?.until !== undefined ? '  x clear' : '';
  const move = places.length > 1 ? '  K J move' : '', edit = cursor ? '  ⏎ edit' : '';
  const model = places[chain.at] && (places[chain.at]!.harness !== 'bro' || places[chain.at]!.label === 'aistudio') ? '  m model' : '';
  const hints = role.source === 'project' ? `↑↓ place  o open file${clear}  esc back` : draft
    ? places.length ? `s save  esc discard  i add${edit}${move}  Del remove${model}` : 'i add  esc discard'
    : `${model.trim()}${model ? '  ' : ''}↑↓ place${edit}  i add${clear}  esc back  o open file${move}  Del remove`;
  return { rule, cursor, hints, rows: [...top, ...(places.length ? rows.slice(start, start + size) : [line(muted(`  ${t('empty · i adds the first place')}`))])] };
}
