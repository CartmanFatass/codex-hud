import type { ProjectSnapshot } from '../collectors/project-board.js';
import type { HarnessSwitchFact } from '../roles/role-control.js';
import type { MonitorControl, MonitorFrame, MonitorRow, MonitorState } from './monitor.js';
import { projectSplitScene, type Shown } from './split-project.js';
import { boardRow, footerLayout, kvRows, mark, section, type FooterHints } from './workboard-rows.js';
import { monitorText, fit, flowLines, pair, squeeze } from './monitor-text.js';
import { theme, visualLength } from './colors.js';
import { t } from './i18n.js';
import { presetTag } from './control-view.js';

const GROUPS = [['runner', 'Runner'], ['cli', 'CLI agents'], ['browser', 'Browser tools'], ['provider', 'Pi providers']] as const;
const muted = theme.board.muted;
export const HARNESS_OFF = 'harness-off';
export const harnessFold = `project:fold:${HARNESS_OFF}`;
export const harnessItem = (id: string) => `control:harness:${id}`;
export const harnessId = (item?: string) => /^control:harness:(.+)$/.exec(item ?? '')?.[1];
export const restoreId = (item?: string) => /^control:restore:(.+)$/.exec(item ?? '')?.[1];

const scope = () => t('This machine · all projects');
const presence = (h: HarnessSwitchFact) => t(h.group === 'provider' ? h.present ? 'listed' : 'not seen' : h.present ? 'installed' : 'not installed');
const target = (id: string | null) => id ?? t('none');
const offFolded = (state: MonitorState) => state.projectFolded?.has(HARNESS_OFF) ?? true;
const offSwitches = (data: ProjectSnapshot) => (data.harnessSwitches ?? []).filter((h) => h.off).sort((a, b) => a.id.localeCompare(b.id));

function switchText(h: HarnessSwitchFact, width: number, showPresence = false): string {
  const icon = h.off ? muted(mark('⊘', 'x')) : theme.board.active(mark('◉', '@'));
  const right = [showPresence || !h.present ? presence(h) : '', !h.off && h.runnerOff ? t('pi off') : ''].filter(Boolean).join(' · ');
  const lead = `  ${icon} `, id = monitorText(h.off ? h.id : h.name), sites = h.sites?.join(' ');
  const room = width - visualLength(lead) - (right ? visualLength(right) + 1 : 0);
  const left = lead + squeeze(id, Math.max(1, room));
  const extra = sites && visualLength(`${id}  ${sites}`) <= room ? `  ${muted(sites)}` : '';
  return pair(left + extra, right ? muted(right) : '', width);
}

function switchRow(h: HarnessSwitchFact, width: number, restore = false): MonitorRow {
  return { text: switchText(h, width, h.off),
    item: restore ? `control:restore:${h.id}` : harnessItem(h.id), harnessOff: h.off };
}

export function harnessErrorRow(data: ProjectSnapshot, width: number): MonitorRow[] {
  return data.harnessSwitchError ? [{
    text: fit(theme.board.attention('! ') + t('Invalid or unreadable harnesses.json'), width),
    files: [data.harnessSwitchError], item: 'project:file:harnesses.json',
  }] : [];
}

export function harnessRows(data: ProjectSnapshot, state: MonitorState, width: number): MonitorRow[] {
  if (data.harnessSwitchError) return harnessErrorRow(data, width);
  const harnesses = data.harnessSwitches ?? [];
  const off = offSwitches(data), folded = offFolded(state);
  return [
    ...GROUPS.flatMap(([group, label]) => {
      const enabled = harnesses.filter((h) => h.group === group && !h.off);
      if (group === 'runner' && !enabled.length) return [];
      return [section(t(label), width, String(enabled.length)), ...enabled.map((h) => switchRow(h, width)), boardRow('')];
    }),
    { ...section(`${folded ? mark('▸', '>') + ' ' : ''}${t('Off')}`, width, String(off.length)), item: harnessFold },
    ...(folded ? [] : off.map((h) => switchRow(h, width))),
  ];
}

function harnessDetail(h: HarnessSwitchFact, width: number): MonitorRow[] {
  const detail = [
    ...kvRows('state', t(h.off ? 'off · {detail}' : 'on · {detail}', { detail: presence(h) }), width),
    ...(!h.off && h.runnerOff ? kvRows('effect', t('pi off'), width) : []),
    ...(h.group === 'runner' && h.off ? kvRows('effect', t('Pi providers keep their own switches'), width) : []),
    ...(h.sites ? kvRows('sites', h.sites.join('  '), width) : []),
    ...(h.models ? kvRows('model', t('{n} listed models', { n: h.models }), width) : []),
  ];
  // Prefer a role whose Next would move; for the rest, show where the first referenced place sits.
  const uses = h.uses.slice().sort((a, b) => Number(b.next !== b.switchedNext) - Number(a.next !== a.switchedNext));
  const first = uses[0];
  detail.push(...kvRows('used by', first ? [first.role, presetTag(first.preset), t('place #{n}', { n: first.index + 1 })].filter(Boolean).join(' ') : t('none'), width));
  if (first) {
    if (h.off) detail.push(...kvRows('next job', `${first.role} → ${target(first.next)}`, width));
    detail.push(...kvRows(h.off ? 'if on' : 'if off', `${first.role} → ${target(first.switchedNext)}`, width));
    if (h.group === 'runner') for (const use of uses.slice(1, 5).filter((u) => u.next !== u.switchedNext)) {
      detail.push(...flowLines(monitorText(`${use.role} → ${target(use.switchedNext)}`), width - 2).map((s) => boardRow('  ' + s)));
    }
  }
  return [...detail, boardRow(''), ...flowLines(t('Role files untouched · restore any time'), width).map((s) => boardRow(muted(s)))];
}
export function harnessAddRows(data: ProjectSnapshot, state: MonitorState, width: number): MonitorRow[] {
  const add = state.controlHarnessAdd!;
  const needle = add.text.toLowerCase();
  const matches = offSwitches(data).filter((h) => h.id.toLowerCase().includes(needle));
  const items = matches.map((h) => switchRow(h, width, true));
  if (!items.some((r) => r.item === add.pick)) state.controlHarnessAdd = { ...add, pick: items[0]?.item };
  const count = String(matches.length), text = squeeze(monitorText(add.text), Math.max(0, width - 5 - count.length));
  return [boardRow(pair(`/ ${text}${theme.board.active(mark('▌', '_'))}`, muted(count), width)),
    ...(data.harnessSwitchError ? harnessErrorRow(data, width) : items.length ? items : [boardRow(t('No matching switches'))])];
}

export const addBackHints = { modal: ['type to filter', '⏎ restore', 'Esc back'] };
export function harnessHints(data: ProjectSnapshot | undefined, state: MonitorState, item = state.projectCursor): string[] {
  const entry = data?.harnessSwitches?.find((h) => h.id === harnessId(item));
  return [...(entry ? ['Space on/off'] : item === harnessFold ? [offFolded(state) ? '⏎ expand' : '⏎ fold']
    : data?.harnessSwitchError ? ['⏎ open file'] : []),
    ...(data?.harnessSwitches?.some((h) => h.off) ? ['i add back'] : []),
    'h roles', ...(entry && !entry.off ? ['Del remove'] : []), 'r refresh'];
}

export function harnessScene(data: ProjectSnapshot, state: MonitorState, width: number, previewWidth = width) {
  const list = harnessRows(data, state, width);
  const preview = (item?: string): Shown => {
    const hints = harnessHints(data, state, item);
    const h = data.harnessSwitches?.find((h) => h.id === harnessId(item));
    if (h) return { label: monitorText(h.id), rows: harnessDetail(h, previewWidth), hints };
    if (item === harnessFold) {
      const off = offSwitches(data);
      return { label: t('Off'), right: String(off.length), rows: off.map((entry) => boardRow(switchText(entry, previewWidth))), hints };
    }
    return { label: '', rows: [], hints };
  };
  const add = state.controlHarnessAdd;
  const scene = projectSplitScene(state, { list, preview, hints: harnessHints(data, state), start: list.find((r) => r.item)?.item },
    add ? 'harnesses|add' : 'harnesses');
  if (add) {
    scene.rule = { label: t('Add back'), right: scope() };
    scene.preview = harnessAddRows(data, state, previewWidth);
    scene.sub = state.controlHarnessAdd?.pick;
    scene.compact = true;
  }
  return add ? { ...scene, hints: addBackHints } : scene;
}

/** Whole fitted footer hints are actions too. The shared footer right-aligns the same text. */
export function harnessFooterControls(frame: MonitorFrame, hints: FooterHints, width: number, y: number): void {
  const kinds: Record<string, MonitorControl['kind']> = {
    'Space on/off': 'harness-toggle', 'Del remove': 'harness-remove', 'i add back': 'harness-add',
    'h roles': 'control-roles', '⏎ expand': 'harness-fold', '⏎ fold': 'harness-fold',
    '⏎ restore': 'harness-restore', 'Esc back': 'harness-back', 'r refresh': 'harness-refresh', '? help': 'help',
  };
  for (const { key, x, width: span } of footerLayout(hints, width)) {
    const kind = kinds[key];
    if (kind) frame.controls.push({ kind, x, width: span, y });
  }
}
