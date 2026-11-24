import type { MachineWorkCounts } from '../collectors/work-summary-snapshot.js';
import { visualLength } from './colors.js';
import { iconSet, type IconMode } from './hud-config.js';
import { ROLE_GLYPHS, roleIcon } from './model-glyphs.js';

/** The machine-wide HUD load, not a count of owner requests or native subagents. */
export function machineWorkForms(work: MachineWorkCounts, icons = iconSet()): string[] {
  const counts = new Map<string, number>();
  for (const [role, { running }] of Object.entries(work.roles)) {
    const key = Object.hasOwn(ROLE_GLYPHS, role) ? role : 'other';
    counts.set(key, (counts.get(key) ?? 0) + running);
  }
  const roles = Object.keys(ROLE_GLYPHS).flatMap((role) => {
    const count = counts.get(role);
    return count ? [`${roleIcon(role, icons)}${count}`] : [];
  });
  const queueIcon = icons === 'text' ? 'Q' : icons === 'nerd' ? '' : '◷';
  const groups = work.queued > 0 ? [...roles, `${queueIcon}${work.queued}`] : roles;
  return groups.length ? [groups.join('  '), groups.join(' '), roles.join(' ')] : [];
}

export function formatMachineWork(work: MachineWorkCounts, icons?: IconMode): string {
  return machineWorkForms(work, icons)[0] ?? '';
}

export function fitMachineWork(work: MachineWorkCounts | undefined, width: number): string | undefined {
  return work && machineWorkForms(work).find((form) => form && visualLength(form) <= width);
}
