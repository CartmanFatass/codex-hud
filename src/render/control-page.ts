/** The standalone Control tab uses the same role rows and chain detail in Classic and Split. */
import { basename } from 'node:path';
import type { ProjectSnapshot } from '../collectors/project-board.js';
import { placeDestination, type PlaceFact, type RoleFact } from '../roles/role-control.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import { CONTROL_FOLDS, controlRoleItem, controlRoleOf } from './control-navigation.js';
import { glyph, needsAttention, placeTarget, radarFacts, radarRows, radarSummary, roleName, roleToday } from './control-view.js';
import { projectItem } from './project-view.js';
import { projectSplitScene, type Shown } from './split-project.js';
import { boardRow, kvRows, mark, pack, section } from './workboard-rows.js';
import { fit, flowLines, monitorText, pair, squeeze } from './monitor-text.js';
import { theme, visualLength } from './colors.js';
import { t } from './i18n.js';
import { HARNESS_OFF, harnessErrorRow } from './harness-page.js';

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
  const change = state.controlHarnessNotice;
  const scope = t('This machine · all projects');
  const caption = change ? pair(theme.board.success(`${mark('✓', '+')} ${t(change.off ? 'Switched off' : 'Restored')} ${monitorText(change.id)}`), muted(scope), width)
    : muted(scope);
  return [section(monitorText(input.projectName ?? '') || t('Project'), width,
    projects.length > 1 ? `${t('project')} ${at + 1}/${projects.length}` : ''), {
    text: (state.controlHarnesses ? muted : theme.board.title)(roles) + (state.controlHarnesses ? theme.board.title : muted)(harnesses),
    controls: [{ kind: 'control-roles', x: 0, width: Math.min(width, x) },
      ...(width > x ? [{ kind: 'control-harnesses' as const, x, width: Math.min(width - x, visualLength(harnesses)) }] : [])],
  }, ...(state.controlHarnesses ? [boardRow(caption)] : [])];
}

export function controlHints(data: ProjectSnapshot | undefined, item?: string, inChain = false): string {
  const role = data?.roles.find((r) => r.role === controlRoleOf(item));
  const index = /:(\d+)$/.exec(item ?? '')?.[1];
  if (role && index !== undefined) {
    const clear = role.places[Number(index)]?.until !== undefined ? '  x clear' : '';
    return role.source === 'project' ? `↑↓ place  o open file${clear}  esc back  ? help`
      : `↑↓ place  p harness  m model  e thinking  i add  Del remove  K J move${clear}${role.preset !== undefined ? '  c C preset' : ''}  esc back  ? help`;
  }
  if (role) return `↑↓ move  ${inChain ? '⏎ places' : '⏎ open'}${role.source !== 'project' && role.preset !== undefined ? '  c C preset' : ''}  h harnesses  o open file  r refresh  ? help`;
  const enter = item?.startsWith('project:file:') ? '  ⏎ open file' : item?.startsWith('project:fold:') ? '  ⏎ open' : '';
  return `↑↓ move${enter}  h harnesses  r refresh  ←→ tab  [ ] project  ? help`;
}

function roleRows(role: RoleFact, width: number, now: number): MonitorRow[] {
  const next = active(role), dead = role.places.find((p) => p.state === 'exhausted'), why = dead ?? (!next ? role.places[0] : undefined);
  const extra = { item: controlRoleItem(role.role), files: [role.path] };
  const tag = role.source === 'project' ? muted(t('project')) : '';
  const room = width - (tag ? visualLength(tag) + 1 : 0), lead = `  ${glyph(!next ? 'missing' : dead ? 'exhausted' : 'active')} `;
  const arrow = ` ${mark('→', '>')} `, name = roleName(role), presetName = monitorText(preset(role));
  const to = squeeze(monitorText(next ? target(next) : t('none')), Math.max(4, room - visualLength(lead) - 10));
  const ids = room - visualLength(lead + arrow + to) - 3;
  const id = squeeze(name, Math.max(4, ids - Math.min(visualLength(presetName), Math.floor(ids / 2))));
  const shownPreset = squeeze(presetName, Math.max(4, ids - visualLength(id)));
  const line = `${lead}${theme.board.title(id)} ${muted(`[${shownPreset}]${arrow}`)}${next ? to : theme.board.attention(to)}`;
  const note = why ? why.offBy ? `${why.offBy} ${t('Switched off')}` : `${target(why)} ${reason(why, now)}` : '';
  return [{ ...extra, text: pair(line, tag, width) }, ...(note ? [{ ...extra, text: fit(`      ${theme.board.attention(monitorText(note))}`, width) }] : [])];
}

function roleDetail(data: ProjectSnapshot, role: RoleFact, width: number, now: number, classic = false): MonitorRow[] {
  const next = active(role), today = radarFacts(data.radar).roles.find(([name]) => name === role.role)?.[1];
  const source = `${t(role.source)} · ${basename(role.path)}`;
  const chain = role.places.flatMap((place, i) => {
    const prefix = `${classic ? '    ' : '  '}${i + 1} ${glyph(place.state)} `, indent = ' '.repeat(visualLength(prefix));
    const label = place.harness === 'pi' && !place.model?.includes('/') ? target(place) : place.label;
    const body = [label, place.model ?? place.kind ?? (place.harness === 'bro' ? '' : t('default')), place.thinking].filter(Boolean).join('  ');
    const ink = place.state === 'active' ? (s: string) => s : muted;
    const extra = placeTarget(role, i, data), why = reason(place, now);
    const notes = [why, place.state === 'off' ? quota(place, now) : '', place.provider === null ? t('provider unknown') : ''];
    return [...flowLines(monitorText(body), Math.max(1, width - indent.length)).map((line, n) => ({ ...extra, text: fit((n ? indent : prefix) + ink(line), width) })),
      ...notes.filter(Boolean).flatMap((note) => flowLines(monitorText(note), Math.max(1, width - indent.length))
        .map((line) => ({ ...extra, text: fit(indent + muted(line), width) })))];
  });
  if (classic) return [...chain, ...[`${t('source')} ${monitorText(source)}`, ...(today ? [`${t('today')} ${roleToday(today)}`] : [])]
    .flatMap((line) => flowLines(line, Math.max(1, width - 4)).map((text) => boardRow('    ' + muted(text))))];
  return [
    ...kvRows('next job', next ? target(next) : t('none'), width),
    ...(next ? [...kvRows('model', next.model ?? next.kind ?? t('default'), width),
      ...kvRows('thinking', next.thinking ?? t(next.harness === 'bro' ? 'none' : 'default'), width)] : []),
    ...kvRows('source', source, width),
    ...(today ? kvRows('today', roleToday(today), width) : []),
    boardRow(''), section(t('Chain'), width, String(role.places.length)), ...chain,
  ];
}

function controlList(data: ProjectSnapshot, state: MonitorState, width: number, now: number, classic: boolean): MonitorRow[] {
  const attention = data.roles.filter(needsAttention).sort((a, b) => Number(!active(a)) - Number(!active(b)));
  const healthy = (['roles', 'project', 'browser'] as const).flatMap((group) => data.roles.filter((r) => r.group === group && !needsAttention(r)));
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
    ...(classic && folded.has(`role:${role.role}`) ? roleDetail(data, role, width, now, true) : [])];
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

export function controlScene(data: ProjectSnapshot, state: MonitorState, listWidth: number, now: number, previewWidth = listWidth) {
  const list = controlList(data, state, listWidth, now, false);
  const preview = (item?: string): Shown => {
    const role = data.roles.find((r) => controlRoleItem(r.role) === item);
    const hints = controlHints(data, item, true);
    return role ? { label: roleName(role), right: `[${monitorText(preset(role))}]`, rows: roleDetail(data, role, previewWidth, now), hints }
      : { label: '', rows: [], hints };
  };
  const hints = controlHints(data);
  const scene = projectSplitScene(state, { list, preview, hints, start: list.find((r) => r.item)?.item }, `control|${state.projectRoot ?? ''}`);
  if (scene.sub) scene.hints = controlHints(data, scene.sub, true);
  return scene;
}
