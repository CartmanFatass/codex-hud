/** Control's role rows, presets and chain entry points. */
import { basename } from 'node:path';
import type { ProjectSnapshot } from '../collectors/project-board.js';
import { placeDestination, type PlaceFact, type RoleFact } from '../roles/role-control.js';
import type { MonitorControl, MonitorData, MonitorFrame, MonitorRow, MonitorState } from './monitor.js';
import { CONTROL_VIEWS, controlRoleItem, controlRoleOf, type ControlViewState } from './monitor-state.js';
import { glyph, needsAttention, presetName,
  radarFacts, radarRows, radarSummary, roleModelDestination, roleName, harnessErrorRow } from './control-view.js';
import { projectItem } from './project-view.js';
import { boardRow, footerLayout, kvRows, mark, pack, section, type FooterHints } from './workboard-rows.js';
import { fit, flowLines, monitorText, pair, squeeze } from './monitor-text.js';
import { age } from './monitor-labels.js';
import { theme, visualLength } from './colors.js';
import { t } from './i18n.js';
import { roleModelIndex, takesModel } from './chain-input.js';

const muted = theme.board.muted;
const target = placeDestination;
const active = (role: RoleFact) => role.places.find((p) => p.state === 'active');
const quota = (place: PlaceFact, now: number) => place.until === undefined ? '' :
  `${t('exhausted')} ${t('{n}m', { n: Math.max(1, Math.ceil((place.until - now) / 60000)) })}`;
const reason = (place: PlaceFact, now: number) => place.state === 'off' ? t('off · {detail}', { detail: String(place.offBy) })
  : place.state === 'exhausted' ? quota(place, now) || t('exhausted')
  : place.state === 'missing' ? [t('not installed'), place.missing].filter(Boolean).join(' · ') : '';

export function controlHeader(input: MonitorData, state: MonitorState, width: number): MonitorRow[] {
  const projects = input.projects ?? [], at = Math.max(0, projects.findIndex((p) => p.root === state.selectedProject));
  const { subTab, notice } = state.control, showingHarnesses = subTab === 'harnesses';
  const labels = { roles: 'Roles', harnesses: 'Harnesses', resources: 'Resources' };
  const controls: NonNullable<MonitorRow['controls']> = [];
  let x = 0;
  const tabs = CONTROL_VIEWS.map((id) => {
    const text = ` ${t(labels[id])} `, span = visualLength(text);
    if (x < width) controls.push({ kind: `control-${id}`, x, width: Math.min(span, width - x) });
    x += span;
    return (id === subTab ? theme.board.title : muted)(text);
  });
  const change = notice?.kind === 'harness' ? notice : undefined;
  const role = notice && notice.kind !== 'harness' ? monitorText(notice.role) : '';
  const name = notice?.kind === 'preset' ? presetName(notice.name) : '';
  const saved = notice?.kind === 'model'
    ? t('{role} #{n} → {model}', { role, n: notice.index + 1, model: notice.model ? monitorText(notice.model) : t('clear') })
    : notice?.kind === 'preset' ? name ? t('{role} → preset {name}', { role, name }) : t('{role} · preset applied', { role }) : '';
  const scope = t('This machine · all projects');
  const caption = change ? pair(theme.board.success(`${mark('✓', '+')} ${t(change.off ? 'off {id}' : 'Restored {id}', { id: monitorText(change.id) })}`), muted(scope), width)
    : muted(scope);
  const switcher = { text: tabs.join(''), controls };
  if (subTab === 'resources') return [switcher];
  return [section(monitorText(input.projectName ?? '') || t('Project'), width,
    projects.length > 1 ? `${t('project')} ${at + 1}/${projects.length}` : ''), switcher,
    ...(showingHarnesses ? [boardRow(caption)] : saved ? [boardRow(theme.board.success(`${mark('✓', '+')} ${saved}`))] : [])];
}

export function controlHints(data: ProjectSnapshot | undefined, item?: string): string[] {
  const role = data?.roles.find((r) => r.role === controlRoleOf(item));
  if (role) {
    const toggle = role.optionalEnabled === undefined ? [] : ['Space on/off'];
    if (role.optionalEnabled === false) return [...toggle, 'o file', 'h harnesses'];
    if (role.source === 'project') return [...toggle, 'o file', '⏎ chain', 'h harnesses'];
    const model = takesModel(role.editor?.places[roleModelIndex(role)]) ? ['m model'] : [];
    const names = role.presets?.length ? ['c C preset', 'p presets'] : [];
    const manage = role.preset ? ['R rename', 'D delete'] : [];
    return [...toggle, ...model, ...names, '⏎ chain', 'N copy', 'I empty', ...manage, 'h harnesses', 'o file', 'r refresh'];
  }
  const enter = item?.startsWith('project:file:') ? ['⏎ open file'] : item?.startsWith('project:fold:') ? ['⏎ open'] : [];
  return [...enter, 'h harnesses', 'r refresh', '[ ] project'];
}

export function roleRows(role: RoleFact, width: number, now: number): MonitorRow[] {
  const next = active(role), dead = role.places.find((p) => p.state === 'exhausted'), why = dead ?? (!next ? role.places[0] : undefined);
  const extra = { item: controlRoleItem(role.role), files: [role.path], roleFact: role };
  if (role.optionalEnabled === false) return [{ ...extra,
    text: pair(`  ${glyph('off')} ${roleName(role)}`, muted(t('Off')), width) }];
  const status = [role.source === 'project' ? t('project') : '', role.optionalEnabled ? t('on') : ''].filter(Boolean).join(' · ');
  const tag = status ? muted(status) : '';
  const room = width - (tag ? visualLength(tag) + 1 : 0);
  const lead = `  ${role.missingPreset ? theme.board.attention('!') : glyph(!next ? 'missing' : dead ? 'exhausted' : 'active')} `;
  const arrow = ` ${mark('→', '>')} `, name = roleName(role), preset = presetName(role.preset);
  const model = next && role.source !== 'project' ? roleModelDestination(next) : undefined;
  const fullPrefix = lead + name + (preset ? ` [${preset}]` : '') + arrow;
  const to = model && visualLength(fullPrefix + model) <= room ? model
    : squeeze(monitorText(next ? target(next) : t('none')), Math.max(4, room - visualLength(lead) - (preset ? 10 : 7)));
  const ids = room - visualLength(lead + arrow + to) - (preset ? 3 : 0);
  const id = to === model ? name : squeeze(name, Math.max(4, ids - Math.min(visualLength(preset), Math.floor(ids / 2))));
  const shownPreset = preset ? ` [${squeeze(preset, Math.max(4, ids - visualLength(id)))}]` : '';
  const line = `${lead}${theme.board.title(id)}${muted(shownPreset + arrow)}${next ? to : theme.board.attention(to)}`;
  const note = why ? why.offBy ? t('{id} off', { id: why.offBy }) : `${target(why)} ${reason(why, now)}` : '';
  const missing = role.missingPreset ? t('Preset {name} missing; using file chain', { name: monitorText(role.missingPreset) }) : '';
  return [{ ...extra, text: pair(line, tag, width) }, ...[note && monitorText(note), missing].filter(Boolean)
    .flatMap((message) => flowLines(message, width - 6).map((part) => ({ ...extra, text: fit(`      ${theme.board.attention(part)}`, width) })))];
}

function jobUsageRows(stats: ProjectSnapshot['jobStats'], width: number): MonitorRow[] {
  if (!stats) return [];
  const { coverage: c, total, roles, places } = stats;
  const lines = (text: string) => flowLines(text, Math.max(1, width - 4)).map(line => boardRow(fit(`  ${line}`, width)));
  const money = (n: number) => '$' + (n > 0 && n < 0.01 ? n.toPrecision(2) : n.toFixed(2));
  const cost = total.usage.cost_usd;
  const rows = (groups: typeof roles, title: string) => groups.length ? [section(t(title), width,
    groups.length > 8 ? `8/${groups.length}` : ''), ...groups.slice(0, 8).flatMap(g => {
    const usd = g.usage.cost_usd;
    return [...lines(g.label.map((value, i) => !value ? t('unknown') : i === 2 && (value === 'tab' || value === 'headless')
      ? t(value) : monitorText(value)).join(' / ')),
      ...lines(t('{n} jobs · median {time} · cost {cost} ({known}/{n})', { n: g.jobs,
        time: g.median === undefined ? t('unknown') : t('{n}m', { n: g.median.toFixed(1) }),
        cost: usd.known ? money(usd.total) : t('unknown'), known: usd.known }))];
  })] : [];
  return [section(t('Reported job usage today'), width),
    ...lines(t('{live} retained · {archive} archived · {flows} flow receipts', { live: c.live, archive: c.archive, flows: c.flows })),
    ...lines(t('Cost {cost} · known for {known}/{n} jobs', { cost: cost.known ? money(cost.total) : t('unknown'), known: cost.known, n: total.jobs })),
    ...(c.skipped ? lines(t('{n} unreadable or invalid', { n: c.skipped })) : []),
    ...(c.limited ? lines(t('Scan limits reached')) : []),
    ...rows(roles, 'By role'), ...rows(places, 'By role / place / mode')];
}

function controlList(data: ProjectSnapshot, view: ControlViewState, width: number, now: number): MonitorRow[] {
  const needs = (r: RoleFact) => r.optionalEnabled !== false && (!!r.missingPreset || needsAttention(r));
  const attention = data.roles.filter(needs).sort((a, b) => Number(!active(a)) - Number(!active(b)));
  const healthy = (['roles', 'project', 'browser'] as const).flatMap((group) =>
    data.roles.filter((r) => r.group === group && r.optionalEnabled !== false && !needs(r)));
  const off = data.roles.filter((r) => r.optionalEnabled === false);
  const invalid = data.control.filter((r) => r.label === 'invalid'), folded = new Set(view.folded);
  // A quota or preset change can move the selected role into Healthy; don't lose the cursor.
  if (folded.has('healthy') && healthy.some((r) => r.role === controlRoleOf(view.nav.cursor))) {
    folded.delete('healthy');
    view.folded = folded;
  }
  const fold = (id: string, label: string, summary: string[] = []): MonitorRow => {
    const left = `${folded.has(id) ? mark('▸', '>') + ' ' : ''}${t(label)}`;
    const parts = [...summary];
    while (parts.length && visualLength(`${left}  ${parts.join(' · ')}`) > width) parts.pop();
    return { ...section(left, width, parts.join(' · ')), item: `project:fold:${id}` };
  };
  const entries = (role: RoleFact) => [...roleRows(role, width, now),
    ...(role.source !== 'project' && role.optionalEnabled !== false && view.nav.cursor === controlRoleItem(role.role) ? roleActions(role, width) : [])];
  const radar = radarFacts(data.radar), usage = radarSummary(radar, false);
  const jobs = data.jobStats?.total.jobs ?? radar.roles.reduce((n, [, s]) => n + s.total, 0);
  if (jobs) usage.push(t('{n} jobs', { n: jobs }));
  const ok = (yes: boolean) => yes ? theme.board.success(mark('✓', '+')) : muted(mark('−', '-'));
  const files = data.control.filter((r) => r.label !== 'invalid'), have = data.keys.filter(([, present]) => present).length;
  return [
    boardRow(''), section(t('Needs attention'), width, theme.board.attention(String(attention.length + invalid.length + Number(!!data.harnessSwitchError)))),
    ...harnessErrorRow(data, width), ...attention.flatMap(entries),
    ...invalid.map((r, i): MonitorRow => ({ item: `project:file:${r.path}:invalid:${i}`, files: r.path ? [r.path] : undefined,
      text: pair(`  ${theme.board.attention('!')} ${monitorText(basename(r.path ?? r.value))}`, muted(t(r.value)), width) })),
    boardRow(''), fold('healthy', 'Healthy', [String(healthy.length)]),
    ...(folded.has('healthy') ? pack(healthy.map(roleName), width - 2).map((line, i) => ({
      item: 'project:fold:healthy', text: fit(`${i ? '    ' : `  ${glyph('active')} `}${line.trimStart()}`, width),
    })) : healthy.flatMap(entries)),
    ...(off.length ? [boardRow(''), section(t('Optional roles'), width), ...off.flatMap(entries)] : []),
    ...(data.leases?.length ? [boardRow(''), section(t('Leases'), width), ...data.leases.map((lease) => {
      const elapsed = age(new Date(lease.since), now);
      const holder = squeeze(monitorText(lease.holder), Math.max(1, width - visualLength(elapsed) - 12));
      const detail = `${holder} · ${elapsed}`;
      const name = squeeze(monitorText(lease.name), Math.max(1, width - visualLength(detail) - 4));
      return boardRow(pair(`  ${name}`, muted(detail), width));
    })] : []),
    boardRow(''), fold('usage', 'Usage', usage),
    ...(folded.has('usage') ? [] : [...radarRows(radar, width, true), ...jobUsageRows(data.jobStats, width)]
      .map((row, i) => ({ ...row, item: `control:usage:${i}` }))),
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

export const controlRows = (data: ProjectSnapshot | undefined, view: ControlViewState, width: number, now: number) =>
  data ? controlList(data, view, width, now) : [boardRow(t('Loading…'))];

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
    if (visualLength(text) + span + 2 > width) {
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
export function presetFooterControls(frame: MonitorFrame, hints: FooterHints, width: number, y: number) {
  const kinds: Record<string, MonitorControl['kind']> = {
    'Space on/off': 'role-toggle', 'p presets': 'preset-list', 'N copy': 'preset-copy', 'I empty': 'preset-empty', 'R rename': 'preset-rename', 'D delete': 'preset-delete',
    '⏎ apply': 'preset-accept', '⏎ delete': 'preset-accept', '⏎ rename': 'preset-accept',
    '⏎ continue': 'preset-accept', 'Esc cancel': 'preset-cancel', 'o file': 'control-open-file',
    'i add': 'chain-add', 's save': 'chain-save', '⏎ edit': 'chain-edit', '⏎ choose': 'chain-edit', '⏎ fill': 'chain-accept',
    'Del remove': 'chain-remove', 'm model': 'control-model',
    'Esc back': 'chain-back', 'Esc discard': 'chain-back', '⏎ discard': 'chain-accept', 'Esc resume': 'chain-back',
  };
  for (const { key, x, width: span } of footerLayout(hints, width)) {
    const kind = kinds[key];
    if (kind) frame.controls.push({ kind, x, width: span, y });
    if (key === 'c C preset' || key === 'K J move') {
      const [first, second] = key === 'c C preset' ? ['preset-next', 'preset-prev'] as const : ['chain-up', 'chain-down'] as const;
      frame.controls.push({ kind: first, x, width: 1, y }, { kind: second, x: x + 2, width: 1, y },
        { kind: first, x: x + 4, width: Math.max(0, span - 4), y });
    }
  }
}
