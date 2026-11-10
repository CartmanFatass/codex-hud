/** Pure, bounded role-work segment shared by Claude and pi. */
import type { RoleSummaryRead } from '../roles/role-summary.js';
import { truncateAnsi } from './colors.js';
export function renderRoleSummary(result: RoleSummaryRead, width: number): string {
  if (result.state !== 'available' || !Number.isFinite(width) || width < 1) return '';
  const { counts, coverage } = result.summary;
  const parts = [
    counts['needs-you'] ? `${counts['needs-you']} needs you` : '',
    counts.stalled ? `${counts.stalled} stalled` : '',
    counts['awaiting-acceptance'] ? `${counts['awaiting-acceptance']} awaiting acceptance` : '',
    counts['in-progress'] ? `${counts['in-progress']} in progress` : '',
  ].filter(Boolean);
  return parts.length
    ? truncateAnsi(`Work${coverage === 'partial' ? ' (partial)' : ''}: ${parts.join(' · ')}`, Math.floor(width))
    : '';
}
