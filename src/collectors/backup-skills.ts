import { readFileSync } from 'node:fs';

export interface BackupSkill { name: string; en: string; zh: string }
/** Shipped beside dist, like the role assets; install keeps links into this checkout/extraction. */
export function readBackupSkills(file = new URL('../../integrations/skills/backup-skills.json', import.meta.url)): BackupSkill[] | null {
  try {
    const { skills } = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(skills) && skills.every((s) =>
      s && typeof s.name === 'string' && typeof s.en === 'string' && typeof s.zh === 'string') ? skills : null;
  } catch { return null; }
}
