/** The standalone Control tab uses the same role rows and chain detail in Classic and Split. */
import { basename } from 'node:path';
import type { ProjectSnapshot } from '../collectors/project-board.js';
import { placeDestination, type PlaceFact, type RoleFact } from '../roles/role-control.js';
import type { MonitorControl, MonitorData, MonitorFrame, MonitorRow, MonitorState } from './monitor.js';
import { CONTROL_FOLDS, controlRoleItem, controlRoleOf } from './control-navigation.js';
import { glyph, needsAttention, pickerPlace, pickerRows, placeTarget, radarFacts, radarRows, radarSummary, roleName, roleToday, modelFieldRows } from './control-view.js';
import { pickerHints, type ModelInput } from './model-input.js';
import { projectItem } from './project-view.js';
import { projectSplitScene, type Shown } from './split-project.js';
import { boardRow, footHints, hintText, kvRows, mark, pack, section } from './workboard-rows.js';
import { fit, flowLines, monitorText, pair, squeeze } from './monitor-text.js';
import { theme, visualLength } from './colors.js';
import { t } from './i18n.js';
import { HARNESS_OFF, harnessErrorRow } from './harness-page.js';
import { presetSheet } from './preset-input.js';
import { chainSheet } from './chain-input.js';
import { splitPreviewRoom } from './split-frame.js';

const muted = theme.board.muted;
export const controlFolded = (state: MonitorState): ReadonlySet<string> => state.projectFolded ?? new Set(state.controlHarnesses ? [HARNESS_OFF] : CONTROL_FOLDS);
const preset = (role: RoleFact) => role.preset ?? t('Custom');
const target = placeDestination;
const active = (role: RoleFact) => role.places.find((p) => p.state === 'active');
const quota = (place: PlaceFact, now: number) => place.until === undefined ? '' :
  `${t('exhausted')} ${t('{n}m', { n: Math.max(1, Math.ceil((place.until - now) / 60000)) })}`;
const reason = (place: PlaceFact, now: number) => place.state === 'off' ? `${t('Switched off')} · ${place.offBy}`
  : place.state === 'exhausted' ? quota(place, now) || t('exhausted')
  : place.state === 'missing' ? [t('not installed'), place.missing].filter(Boolean).join(' · ') : '';

export function controlHeader(input: MonitorData, state: MonitorState, width: number): MonitorRow[] {
  const projects = input.projects ?? [], at = Math.max(0, projects.findIndex((p) => p.root === state.projectRoot));
  const roles = ` ${t('Roles')} `, harnesses = ` ${t('Harnesses')} `, x = visualLength(roles);
  const change = state.controlHarnessNotice, selected = state.controlPresetNotice;
  const scope = t('This machine · all projects');
  const caption = change ? pair(theme.board.success(`${mark('✓', '+')} ${t(change.off ? 'Switched off' : 'Restored')} ${monitorText(change.id)}`), muted(scope), width)
    : muted(scope);
  return [section(monitorText(input.projectName ?? '') || t('Project'), width,
    projects.length > 1 ? `${t('project')} ${at + 1}/${projects.length}` : ''), {
    text: (state.controlHarnesses ? muted : theme.board.title)(roles) + (state.controlHarnesses ? theme.board.title : muted)(harnesses),
    controls: [{ kind: 'control-roles', x: 0, width: Math.min(width, x) },
      ...(width > x ? [{ kind: 'control-harnesses' as const, x, width: Math.min(width - x, visualLength(harnesses)) }] : [])],
  }, ...(state.controlHarnesses ? [boardRow(caption)] : selected ? [boardRow(theme.board.success(`${mark('✓', '+')} ${t('{role} → preset {name}', {
    role: monitorText(selected.role), name: selected.name === null ? t('Custom') : monitorText(selected.name),
  })}`))] : [])];
}

export function controlHints(data: ProjectSnapshot | undefined, item?: string, inChain = false): string {
  const role = data?.roles.find((r) => r.role === controlRoleOf(item));
  if (role) {
    const enter = inChain ? '⏎ chain' : '⏎ open';
    if (role.source === 'project') return `↑↓ move  o open file  ${enter}  h harnesses  ? help`;
    const names = role.presets?.length ? '  c C preset  p presets' : '';
    const manage = role.preset ? '  R rename  D delete' : '';
    return `↑↓ move  ${enter}${names}  N copy  I empty${manage}  h harnesses  o open file  r refresh  ? help`;
  }
  const enter = item?.startsWith('project:file:') ? '  ⏎ open file' : item?.startsWith('project:fold:') ? '  ⏎ open' : '';
  return `↑↓ move${enter}  h harnesses  r refresh  ←→ tab  [ ] project  ? help`;
}

export function roleRows(role: RoleFact, width: number, now: number): MonitorRow[] {
  const next = active(role), dead = role.places.find((p) => p.state === 'exhausted'), why = dead ?? (!next ? role.places[0] : undefined);
  const extra = { item: controlRoleItem(role.role), files: [role.path], roleFact: role };
  const tag = role.source === 'project' ? muted(t('project')) : '';
  const room = width - (tag ? visualLength(tag) + 1 : 0);
  const lead = `  ${role.missingPreset ? theme.board.attention('!') : glyph(!next ? 'missing' : dead ? 'exhausted' : 'active')} `;
  const arrow = ` ${mark('→', '>')} `, name = roleName(role), presetName = monitorText(preset(role));
  const to = squeeze(monitorText(next ? target(next) : t('none')), Math.max(4, room - visualLength(lead) - 10));
  const ids = room - visualLength(lead + arrow + to) - 3;
  const id = squeeze(name, Math.max(4, ids - Math.min(visualLength(presetName), Math.floor(ids / 2))));
  const shownPreset = squeeze(presetName, Math.max(4, ids - visualLength(id)));
  const line = `${lead}${theme.board.title(id)} ${muted(`[${shownPreset}]${arrow}`)}${next ? to : theme.board.attention(to)}`;
  const note = why ? why.offBy ? `${why.offBy} ${t('Switched off')}` : `${target(why)} ${reason(why, now)}` : '';
  const missing = role.missingPreset ? t('Preset {name} missing; using file chain', { name: monitorText(role.missingPreset) }) : '';
  return [{ ...extra, text: pair(line, tag, width) }, ...[note && monitorText(note), missing].filter(Boolean)
    .flatMap((message) => flowLines(message, width - 6).map((part) => ({ ...extra, text: fit(`      ${theme.board.attention(part)}`, width) })))];
}

function roleDetail(data: ProjectSnapshot, role: RoleFact, width: number, now: number): MonitorRow[] {
  const next = active(role), today = radarFacts(data.radar).roles.find(([name]) => name === role.role)?.[1];
  const source = `${t(role.source)} · ${role.source === 'project' ? '.hud/roles/' : ''}${basename(role.path)}`;
  const locked = t('project file · read-only here');
  const available = role.presets?.map((p) => p.name).join('  ');
  const metadata = [
    ...kvRows('source', source, width),
    ...(role.chainPath ? kvRows('chain source', role.chainPath, width) : []),
    ...(role.source === 'project' ? [...kvRows('pinned', locked, width), ...(available ? kvRows('Presets', available, width) : [])] : []),
  ];
  const actions = role.source === 'project' ? [] : roleActions(role, width);
  const chain = role.places.flatMap<MonitorRow>((place, i) => {
    const prefix = `  ${i + 1} ${glyph(place.state)} `, indent = ' '.repeat(visualLength(prefix));
    const label = place.harness === 'pi' && !place.model?.includes('/') ? target(place) : place.label;
    const body = [label, place.model ?? place.kind ?? (place.harness === 'bro' ? '' : t('default')), place.thinking].filter(Boolean).join('  ');
    const ink = place.state === 'active' ? (s: string) => s : muted;
    const extra = placeTarget(role, i, data), why = reason(place, now);
    const notes = [why, place.state === 'off' ? quota(place, now) : '', place.provider === null ? t('provider unknown') : ''];
    const rows = extra.modelPick && (place.harness === 'pi' || place.harness === 'cli')
      ? modelFieldRows(place, prefix, width, extra, ink)
      : flowLines(monitorText(body), Math.max(1, width - indent.length)).map((line, n) => ({ ...extra, text: fit((n ? indent : prefix) + ink(line), width) }));
    return [...rows, ...notes.filter(Boolean).flatMap((note) => flowLines(monitorText(note), Math.max(1, width - indent.length))
        .map((line) => ({ ...extra, text: fit(indent + muted(line), width) })))];
  });
  const hasFields = chain.some((row) => row.controls?.length);
  return [
    ...kvRows('next job', next ? target(next) : t('none'), width),
    ...(hasFields ? [boardRow(''), section(t('Chain'), width, String(role.places.length)), ...chain,
      boardRow(''), ...flowLines(t('click [model ▾] or press m to choose'), width - 2).map((line) => boardRow(`  ${muted(line)}`))] : []),
    ...(next ? [...kvRows('model', next.model ?? next.kind ?? t('default'), width),
      ...kvRows('thinking', next.thinking ?? t(next.harness === 'bro' ? 'none' : 'default'), width)] : []),
    ...metadata,
    ...(today ? kvRows('today', roleToday(today), width) : []),
    ...(!hasFields ? [boardRow(''), section(t('Chain'), width, String(role.places.length)), ...chain] : []), ...actions,
  ];
}

function controlList(data: ProjectSnapshot, state: MonitorState, width: number, now: number, classic: boolean): MonitorRow[] {
  const needs = (r: RoleFact) => !!r.missingPreset || needsAttention(r);
  const attention = data.roles.filter(needs).sort((a, b) => Number(!active(a)) - Number(!active(b)));
  const healthy = (['roles', 'project', 'browser'] as const).flatMap((group) => data.roles.filter((r) => r.group === group && !needs(r)));
  const invalid = data.control.filter((r) => r.label === 'invalid'), folded = new Set(controlFolded(state));
  // A quota or preset change can move the selected role into Healthy; don't lose the cursor.
  if (folded.has('healthy') && healthy.some((r) => r.role === controlRoleOf(state.projectCursor))) {
    folded.delete('healthy');
    state.projectFolded = folded;
  }
  const fold = (id: string, label: string, summary: string[] = []): MonitorRow => {
    const left = `${folded.has(id) ? mark('▸', '>') + ' ' : ''}${t(label)}`;
    const parts = [...summary];
    while (parts.length && visualLength(`${left}  ${parts.join(' · ')}`) > width) parts.pop();
    return { ...section(left, width, parts.join(' · ')), item: `project:fold:${id}` };
  };
  const entries = (role: RoleFact) => [...roleRows(role, width, now),
    ...(classic && role.source !== 'project' && state.projectCursor === controlRoleItem(role.role) ? roleActions(role, width) : [])];
  const radar = radarFacts(data.radar), usage = radarSummary(radar, false);
  if (radar.roles.length) usage.push(t('{n} jobs', { n: radar.roles.reduce((n, [, s]) => n + s.total, 0) }));
  const ok = (yes: boolean) => yes ? theme.board.success(mark('✓', '+')) : muted(mark('−', '-'));
  const files = data.control.filter((r) => r.label !== 'invalid'), have = data.keys.filter(([, present]) => present).length;
  return [
    ...(classic ? [boardRow('')] : []), section(t('Needs attention'), width, theme.board.attention(String(attention.length + invalid.length + Number(!!data.harnessSwitchError)))),
    ...harnessErrorRow(data, width), ...attention.flatMap(entries),
    ...invalid.map((r, i): MonitorRow => ({ item: `project:file:${r.path}:invalid:${i}`, files: r.path ? [r.path] : undefined,
      text: pair(`  ${theme.board.attention('!')} ${monitorText(basename(r.path ?? r.value))}`, muted(t(r.value)), width) })),
    boardRow(''), fold('healthy', 'Healthy', [String(healthy.length)]),
    ...(folded.has('healthy') ? pack(healthy.map(roleName), width - 2).map((line, i) => ({
      item: 'project:fold:healthy', text: fit(`${i ? '    ' : `  ${glyph('active')} `}${line.trimStart()}`, width),
    })) : healthy.flatMap(entries)),
    boardRow(''), fold('usage', 'Usage', usage),
    ...(folded.has('usage') ? [] : radarRows(radar, width, true).map((row, i) => ({ ...row, item: `control:usage:${i}` }))),
    fold('files', 'Files', [...(data.keys.length ? [`${t('keys')} ${have}/${data.keys.length}`] : []), `${t('browser')} ${ok(data.browser)}`]),
    ...(folded.has('files') ? [] : [
      ...files.map((r, i) => projectItem(r.label === 'convention' ? { ...r, value: `${t(r.value)} · ${basename(r.path ?? '')}` } : r, i, '', width, now)),
      fold('agents', 'agents', [String(data.agents.length)]),
      ...(folded.has('agents') ? [] : data.agents.map((r, i) => projectItem(r, i, '', width, now))),
      ...kvRows('keys', data.keys.map(([name, present]) => `${name} ${mark(present ? '✓' : '−', present ? '+' : '-')}`).join('  '), width),
      ...(data.harnesses.length ? [section(t('Harnesses'), width), ...pack(data.harnesses.map((h) => `${monitorText(h.name)} ${ok(h.ok)}`), width).map((text) => boardRow(text))] : []),
    ]),
  ];
}

export const controlRows = (data: ProjectSnapshot | undefined, state: MonitorState, width: number, now: number) =>
  data ? controlList(data, state, width, now, true) : [boardRow(t('Loading…'))];

export function controlScene(data: ProjectSnapshot, state: MonitorState, listWidth: number, now: number, previewWidth: number, height: number, notes: number) {
  const list = controlList(data, state, listWidth, now, false);
  const preview = (item?: string): Shown => {
    const role = data.roles.find((r) => controlRoleItem(r.role) === item);
    const hints = controlHints(data, item, true);
    return role ? { label: roleName(role), right: `[${monitorText(preset(role))}]`, rows: roleDetail(data, role, previewWidth, now), hints }
      : { label: '', rows: [], hints };
  };
  const hints = controlHints(data);
  const scene = projectSplitScene(state, { list, preview, hints, start: list.find((r) => r.item)?.item },
    `control|${state.projectRoot ?? ''}|${state.controlPresetInput?.mode ?? ''}`);
  if (state.controlChain || state.controlPresetInput) {
    const room = splitPreviewRoom({ ...scene, compact: true }, state, height, notes);
    const sheet = state.controlChain ? chainSheet(state.controlChain, data.models, previewWidth, room, now)
      : presetSheet(state.controlPresetInput!, previewWidth, room);
    return { ...scene, rule: sheet.rule, preview: sheet.rows, sub: sheet.cursor, hints: sheet.hints, compact: true };
  }
  return scene;
}

/** A narrow Split picker keeps the role context when there is room for the query, list and strip. */
export function controlPickerScene(data: ProjectSnapshot, state: MonitorState, input: ModelInput, width: number, now: number, height: number, notes: number) {
  const role = state.controlChain?.role ?? data.roles.find((r) => r.role === input.role)!;
  const scene = { list: controlList(data, state, width, now, false), cursor: controlRoleItem(role.role),
    rule: { label: roleName(role), right: state.controlChain?.draft
      ? `${monitorText(state.controlChain.draft.name ?? role.preset ?? t('Custom'))} · ${t('Not saved')}` : pickerPlace(input, role.preset) }, preview: [] as MonitorRow[],
    scope: 'control-picker', compact: true, sub: 'project:pick', hints: pickerHints(input) };
  const room = splitPreviewRoom(scene, state, height, notes);
  if (room < 13) return;
  return { ...scene, preview: pickerRows(data, input, width, room, now, true) };
}

function roleActions(role: RoleFact, width: number): MonitorRow[] {
  const actions = [
    ...(!role.presets?.length ? [] : [['preset-list', 'Presets'] as const]),
    ['preset-copy', 'Copy preset'] as const, ['preset-empty', 'Empty preset'] as const,
    ...(role.preset ? [['preset-rename', 'Rename'] as const, ['preset-delete', 'Delete'] as const] : []),
  ];
  const rows: MonitorRow[] = [];
  let text = role.presets?.length ? '  ' : `  ${t('No presets')} · `;
  let controls: NonNullable<MonitorRow['controls']> = [];
  for (const [kind, label] of actions) {
    const word = t(label), span = visualLength(word);
    if (visualLength(text) + span > width) {
      rows.push({ text: fit(text, width), controls });
      text = '  ';
      controls = [];
    }
    controls.push({ kind, item: controlRoleItem(role.role), x: visualLength(text), width: Math.min(span, width - visualLength(text)) });
    text += `${theme.board.identifier(word)}  `;
  }
  return [...rows, { text: fit(text, width), controls }];
}

/** Match the footer's whole translated hints and their cells (same alignment as footRow). */
export function presetFooterControls(frame: MonitorFrame, hints: string, width: number, y: number) {
  const kinds: Record<string, MonitorControl['kind']> = {
    'p presets': 'preset-list', 'N copy': 'preset-copy', 'I empty': 'preset-empty', 'R rename': 'preset-rename', 'D delete': 'preset-delete',
    '⏎ apply': 'preset-accept', '⏎ delete': 'preset-accept', '⏎ rename': 'preset-accept',
    '⏎ continue': 'preset-accept', 'esc cancel': 'preset-cancel', 'o open file': 'control-open-file',
    'i add': 'chain-add', 's save': 'chain-save', '⏎ edit': 'chain-edit', '⏎ choose': 'chain-edit', '⏎ fill': 'chain-accept',
    'Del remove': 'chain-remove', 'm model': 'control-model',
    'esc back': 'chain-back', 'esc discard': 'chain-back', '⏎ discard': 'chain-accept', 'esc resume': 'chain-back',
  };
  const labels = hints.split('  '), shown = footHints(hintText(hints), width);
  let x = width - visualLength(shown);
  for (const [i, label] of shown.split('  ').entries()) {
    const span = visualLength(label), kind = kinds[labels[i]!];
    if (kind) frame.controls.push({ kind, x, width: span, y });
    if (labels[i] === 'c C preset' || labels[i] === 'K J move') {
      const [first, second] = labels[i] === 'c C preset' ? ['preset-next', 'preset-prev'] as const : ['chain-up', 'chain-down'] as const;
      frame.controls.push({ kind: first, x, width: 1, y }, { kind: second, x: x + 2, width: 1, y },
        { kind: first, x: x + 4, width: Math.max(0, span - 4), y });
    }
    x += span + 2;
  }
}
