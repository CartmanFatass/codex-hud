/** Display only: one row per shipped backup skill, without row actions. */
import type { BackupSkill } from '../collectors/backup-skills.js';
import type { MonitorRow } from './monitor.js';
import { language, t } from './i18n.js';
import { fit, monitorText } from './monitor-text.js';
import { theme } from './colors.js';
import { boardRow, mark, section } from './workboard-rows.js';

export function skillsRows(skills: BackupSkill[] | null | undefined, width: number): MonitorRow[] {
  return [
    section(`${t('Skills')} ${mark('›', '>')} ${t('Backup skills')}`, width),
    ...(skills ? skills.map((skill) => boardRow(fit(
      `${theme.board.identifier(monitorText(skill.name))}  ${monitorText(skill[language() === 'zh' ? 'zh' : 'en'])}`,
      width
    ))) : [boardRow(theme.board.muted(t('Skills catalog unavailable')))]),
  ];
}
