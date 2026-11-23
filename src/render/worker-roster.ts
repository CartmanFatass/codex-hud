/** Shared model and route marks for Jobs, Inspector and Project diagnostics. */
import { lookupModelEntry, SHIPPED_MODELS_CATALOG } from '../models/catalog.js';
import type { OwnerWorker } from '../collectors/workboard-types.js';
import { theme } from './colors.js';
import { EFFORT_GLYPHS, classifyModelFamily, roleIcon, versionedModelLabel } from './model-glyphs.js';
import { PROVIDERS, providerMark, shortModel } from './providers.js';
import { asciiBoard, mark } from './workboard-rows.js';

/**
 * One-word model name derived from `models-catalog.json`: catalog family + variant less version (`gpt-6.2-sol-fast` →
 * `sol-fast`); else `shortLabel`, first alias or digit-free id (`opus`, `sonnet`, `haiku`); else Gemini codename
 * (`gemini-4-neon-high` → `neon`); else vendor ascii tag lowercased (`ds`, `glm`, `mis`, `xai`); else `shortModel`.
 */
export function workerModelName(model?: string | null, provider?: string | null): string {
  const whole = (model ?? '').trim();
  if (!whole) return '';
  const bare = whole.replace(/\[[^\]]*\]$/, '').replace(/^.*\//, '');
  if (!bare) return '';
  if (classifyModelFamily(bare)) return versionedModelLabel(bare).replace(/^\d+(?:\.\d+)?/, '');
  const entry = lookupModelEntry(bare);
  const word = entry?.shortLabel ?? entry?.aliases?.[0] ?? (entry && !/\d/.test(bare) ? bare.toLowerCase() : '');
  if (word) return word.toLowerCase();
  const codename = /^gemini-\d+(?:\.\d+)?-([a-z]+)/i.exec(bare)?.[1];
  if (codename) return codename.toLowerCase();
  const provId = (provider ?? '').trim().toLowerCase();
  const tag = (entry?.vendor ? PROVIDERS[entry.vendor] : providerMark({ id: bare, provider: provId || undefined }))?.ascii;
  return tag ? tag.toLowerCase() : shortModel(whole);
}

/** Paint an effort glyph using board theme roles (`none` emits no escape). */
export function paintEffortBoard(effort: string | null | undefined, glyph: string): string {
  const key = (effort ?? '').trim().toLowerCase();
  if (key === 'max' || key === 'ultra') return theme.board.attention(glyph);
  if (key === 'high' || key === 'xhigh') return theme.board.active(glyph);
  return theme.board.muted(glyph);
}

export type ModelBadgeLevel = 'full' | 'compact' | 'min';

/** Compact provider + short model + effort mark for a single worker row. Absent when model/provider are unknown. */
export function workerModelBadge(
  worker: Pick<OwnerWorker, 'model' | 'provider' | 'effort'>,
  level: ModelBadgeLevel = 'full',
  ascii = asciiBoard()
): string {
  if (!worker.model && !worker.provider) return '';
  const pm = providerMark({ id: worker.model ?? undefined, provider: worker.provider }, ascii);
  const prov = pm ? theme.board.providerInk(pm.color)(pm.glyph) : '';
  const effKey = (worker.effort ?? '').trim().toLowerCase();
  const eff = !ascii && effKey && EFFORT_GLYPHS[effKey] ? paintEffortBoard(effKey, EFFORT_GLYPHS[effKey]) : '';
  if (level === 'min') return prov;
  if (level === 'compact') return `${prov}${eff}`;
  const name = workerModelName(worker.model, worker.provider);
  if (!name) return `${prov}${eff}`;
  return `${prov ? prov + ' ' : ''}${theme.board.muted(name)}${eff}`;
}

/** Whether a settled non-child worker has an unread report (distinguished by `✓●` / `+*`). */
export function isUnreadReport(worker: OwnerWorker): boolean {
  if (worker.parentJobId || !worker.reportUnread || worker.settledAt === null || worker.superseded) return false;
  return !(worker.work?.failed || ['failed', 'error', 'stopped'].includes(worker.state));
}

/** Count active (unsettled) sonic children belonging to `parentId`. */
export function sonicChildrenRunning(workers: readonly OwnerWorker[], parentId: string): number {
  let n = 0;
  for (const w of workers) if (w.parentJobId === parentId && w.settledAt === null && !w.superseded) n++;
  return n;
}

/** Formatted `⚡N` (ASCII `*N`) badge in sonic role ink, or `''` when zero. */
export function sonicBadge(count: number): string {
  return count > 0 ? theme.board.roleInk.sonic(`${roleIcon('sonic')}${count}`) : '';
}

/** Headless: the job has no herdr tab (the record says so, or its route chose it). */
export const isHeadless = (w: OwnerWorker): boolean => w.headless === true || w.route?.mode === 'headless';

/** The tier mark: a bar that grows with the tier, `[unicode, ascii]`. */
const TIER_MARKS = { light: ['▂', '-'], standard: ['▄', '='], hard: ['▆', '#'] } as const;
/**
 * A job's route as marks (auto-route/04): `▂` light, `▄` standard or `▆` hard when the job was routed, then `∅` when it runs
 * headless. A job with neither has none, and the marks are muted like every secondary fact; the words and the reason are the
 * Inspector's Route row.
 */
export function routeBadge(w: OwnerWorker, withTier = true): string {
  const tier = withTier && w.route && !w.route.placement ? TIER_MARKS[w.route.tier] : undefined;
  const marks = (tier ? mark(tier[0], tier[1]) : '') + (isHeadless(w) ? mark('∅', 'h') : '');
  return marks ? theme.board.muted(marks) : '';
}
