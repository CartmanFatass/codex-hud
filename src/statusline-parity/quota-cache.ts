import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { getHudDisplayHome } from '../hud-home.js';
import type { HudSnapshot } from '../snapshot.js';
import { readBytes, record, saveJson } from './storage.js';

export const CLAUDE_QUOTA_FILE = 'claude-quota.json';

/** Publish only the two watermarks the statusline already observes, not its stdin or transcript. */
export function recordClaudeQuota(input: unknown, env: NodeJS.ProcessEnv, now: number): void {
  const limits = record(record(input).rate_limits), quota: HudSnapshot['quota'] = [];
  for (const [key, label] of [['five_hour', '5h'], ['seven_day', '7d']]) {
    const { used_percentage: percent, resets_at: seconds } = record(limits[key]);
    if (typeof percent !== 'number' || !(percent >= 0 && percent <= 100)) continue;
    const reset = new Date(typeof seconds === 'number' && seconds > 0 ? seconds * 1000 : NaN);
    quota.push({ label, percent, ...(Number.isFinite(reset.getTime()) && { resetsAt: reset.toISOString() }) });
  }
  if (!quota.length) return;
  const path = join(getHudDisplayHome(env), 'state', CLAUDE_QUOTA_FILE);
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && now >= stat.mtimeMs && now - stat.mtimeMs < 5000) return;
    const previous = record(JSON.parse(readBytes(path, 1024)?.toString('utf8') ?? 'null'));
    if (previous.version !== undefined) return; // Preserve a Codex snapshot if a session used this name.
    const age = now - Date.parse(typeof previous.updatedAt === 'string' ? previous.updatedAt : '');
    // Reconfirm unchanged readings occasionally, including windows without a reset time.
    if (age >= 0 && (age < 5000 || (age < 300000 && JSON.stringify(quota) === JSON.stringify(previous.quota)))) return;
    saveJson(path, { updatedAt: new Date(now).toISOString(), quota });
  } catch { /* Display state is optional; never fail the statusline. */ }
}
