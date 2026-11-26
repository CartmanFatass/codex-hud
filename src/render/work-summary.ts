import type { MachineWorkSignal } from '../collectors/work-summary-snapshot.js';
import { visualLength } from './colors.js';
import { iconSet, type IconMode } from './hud-config.js';
import { ROLE_GLYPHS, roleIcon } from './model-glyphs.js';

/** The machine-wide HUD load, not a count of owner requests or native subagents. */
export function machineWorkForms(work: MachineWorkSignal, now: number, icons = iconSet()): string[] {
  const marker = 'Unatt';
  if (!work.roles) return work.unattended ? [marker] : [];
  const counts = new Map<string, number>();
  for (const [role, { running }] of Object.entries(work.roles)) {
    const key = Object.hasOwn(ROLE_GLYPHS, role) ? role : 'other';
    counts.set(key, (counts.get(key) ?? 0) + running);
  }
  const roles = Object.keys(ROLE_GLYPHS).flatMap((role) => {
    const count = counts.get(role);
    return count ? [`${roleIcon(role, icons)}${count}`] : [];
  });
  if (work.unattended) roles.unshift(marker);
  const queueIcon = icons === 'text' ? 'Q' : icons === 'nerd' ? '' : '◷';
  const queue = work.queued > 0 ? [`${queueIcon}${work.queued}`] : [];
  const detail: string[] = [];
  if (work.land) {
    const { count, oldest } = work.land;
    const badge = (icons === 'text' ? 'L' : icons === 'nerd' ? '\uf126' : '⇡') + (count > 1 ? count : '');
    const step = oldest.gate ? `gate ${oldest.gate.join('/')}` : oldest.step === 'wait' ? 'wait' : 'land';
    const minutes = Math.floor((now - oldest.step_started_at) / 60_000);
    const progress = `${badge} ${step}`;
    const full = (part: string) => [...roles, part, ...queue].join('  ');
    detail.push(full(`${progress} ${minutes < 1 ? '<1m' : `${minutes}m`}`), full(progress));
    roles.push(badge);
  }
  const groups = [...roles, ...queue];
  return groups.length ? [...detail, groups.join('  '), groups.join(' '), roles.join(' '),
    ...(work.unattended && roles.length > 1 ? [marker] : [])] : [];
}

export function formatMachineWork(work: MachineWorkSignal, now: number, icons?: IconMode): string {
  return machineWorkForms(work, now, icons)[0] ?? '';
}

export function fitMachineWork(work: MachineWorkSignal | undefined, width: number, now: number): string | undefined {
  return work && machineWorkForms(work, now).find((form) => form && visualLength(form) <= width);
}
