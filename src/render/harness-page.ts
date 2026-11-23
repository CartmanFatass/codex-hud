import type { ProjectSnapshot } from '../collectors/project-board.js';
import type { HarnessSwitchFact } from '../roles/role-control.js';
import type { MonitorControl, MonitorFrame, MonitorRow } from './monitor.js';
import { HARNESS_OFF, harnessFold, type ControlViewState, type OverlayState } from './monitor-state.js';
import { boardRow, footerLayout, mark, section, type FooterHints } from './workboard-rows.js';
import { monitorText, pair, squeeze } from './monitor-text.js';
import { theme, visualLength } from './colors.js';
import { t } from './i18n.js';
import { harnessErrorRow } from './control-view.js';

const GROUPS = [['runner', 'Runner'], ['cli', 'CLI agents'], ['browser', 'Browser tools'], ['provider', 'Pi providers']] as const;
const muted = theme.board.muted;
export const harnessItem = (id: string) => `control:harness:${id}`;
export const harnessId = (item?: string) => /^control:harness:(.+)$/.exec(item ?? '')?.[1];
export const restoreId = (item?: string) => /^control:restore:(.+)$/.exec(item ?? '')?.[1];

const presence = (h: HarnessSwitchFact) => t(h.group === 'provider' ? h.present ? 'listed' : 'not seen' : h.present ? 'installed' : 'not installed');
const offFolded = (view: ControlViewState) => view.folded.has(HARNESS_OFF);
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

export function harnessRows(data: ProjectSnapshot, view: ControlViewState, width: number): MonitorRow[] {
  if (data.harnessSwitchError) return harnessErrorRow(data, width);
  const harnesses = data.harnessSwitches ?? [];
  const off = offSwitches(data), folded = offFolded(view);
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

export function harnessAddRows(data: ProjectSnapshot, add: Extract<OverlayState, { kind: 'control-harness-add' }>, width: number) {
  const needle = add.text.toLowerCase();
  const matches = offSwitches(data).filter((h) => h.id.toLowerCase().includes(needle));
  const items = matches.map((h) => switchRow(h, width, true));
  const pick = items.some((r) => r.item === add.pick) ? add.pick : items[0]?.item;
  const count = String(matches.length), text = squeeze(monitorText(add.text), Math.max(0, width - 5 - count.length));
  return { pick, rows: [boardRow(pair(`/ ${text}${theme.board.active(mark('▌', '_'))}`, muted(count), width)),
    ...(data.harnessSwitchError ? harnessErrorRow(data, width) : items.length ? items : [boardRow(t('No matching switches'))])] };
}

export const addBackHints = { modal: ['type to filter', '⏎ restore', 'Esc back'] };
export function harnessHints(data: ProjectSnapshot | undefined, view: ControlViewState, item = view.nav.cursor): string[] {
  const entry = data?.harnessSwitches?.find((h) => h.id === harnessId(item));
  return [...(entry ? ['Space on/off'] : item === harnessFold ? [offFolded(view) ? '⏎ expand' : '⏎ fold']
    : data?.harnessSwitchError ? ['⏎ open file'] : []),
    ...(data?.harnessSwitches?.some((h) => h.off) ? ['i add back'] : []),
    'h resources', ...(entry && !entry.off ? ['Del remove'] : []), 'r refresh'];
}

/** Whole fitted footer hints are actions too. The shared footer right-aligns the same text. */
export function harnessFooterControls(frame: MonitorFrame, hints: FooterHints, width: number, y: number): void {
  const kinds: Record<string, MonitorControl['kind']> = {
    'Space on/off': 'harness-toggle', 'Del remove': 'harness-remove', 'i add back': 'harness-add',
    'h resources': 'control-resources', '⏎ expand': 'harness-fold', '⏎ fold': 'harness-fold',
    '⏎ restore': 'harness-restore', 'Esc back': 'harness-back', 'r refresh': 'harness-refresh', '? help': 'help',
  };
  for (const { key, x, width: span } of footerLayout(hints, width)) {
    const kind = kinds[key];
    if (kind) frame.controls.push({ kind, x, width: span, y });
  }
}
