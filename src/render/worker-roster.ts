/**
 * Compact worker marks and Variant A worker-roster summary shared across Home (Classic and Split) and reusable by the
 * statusline. Reads provider glyphs from `providers.ts`, effort glyphs from `model-glyphs.ts`, and short model names
 * from the shipped model catalog (matching `docs/design/statusline-workers/sample.html` Variant A + sonic as `⚡N`).
 * Pure: no I/O, no raw ANSI escapes (`theme.board` roles only; `none` emits zero escapes).
 */
import { lookupModelEntry, SHIPPED_MODELS_CATALOG } from '../models/catalog.js';
import type { OwnerWorker, WorkLane } from '../collectors/workboard-types.js';
import { theme, visualLength } from './colors.js';
import { EFFORT_GLYPHS, classifyModelFamily, versionedModelLabel } from './model-glyphs.js';
import { PROVIDERS, providerMark, shortModel } from './providers.js';
import { activeFlow, unattendedFailure } from './work-visibility.js';
import { asciiBoard, mark } from './workboard-rows.js';

const RECENT_SETTLED_MS = 180_000;

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

/** Unpainted provider + short model + effort mark for surfaces with pinned foreground (e.g. amber `askTitle`). */
export function workerModelPlain(
  worker: Pick<OwnerWorker, 'model' | 'provider' | 'effort'>,
  level: 'full' | 'compact' = 'full',
  ascii = asciiBoard()
): string {
  if (!worker.model && !worker.provider) return '';
  const pm = providerMark({ id: worker.model ?? undefined, provider: worker.provider }, ascii);
  const prov = pm?.glyph ?? '';
  const effKey = (worker.effort ?? '').trim().toLowerCase();
  const eff = !ascii && effKey && EFFORT_GLYPHS[effKey] ? EFFORT_GLYPHS[effKey] : '';
  if (level === 'compact') return `${prov}${eff}`;
  const name = workerModelName(worker.model, worker.provider);
  if (!name) return `${prov}${eff}`;
  return `${prov ? prov + ' ' : ''}${name}${eff}`;
}

/** Whether a settled non-child worker has an unread report (distinguished by `✓●` / `+*`). */
export function isUnreadReport(worker: OwnerWorker): boolean {
  if (worker.parentJobId || !worker.reportUnread || worker.settledAt === null || worker.superseded) return false;
  return !(worker.work?.failed || ['failed', 'error', 'stopped'].includes(worker.state));
}

/** Non-child workers of a lane: sonic children (`parentJobId`) never render as rows or cards on Home. */
export function mainLaneWorkers(lane: WorkLane): OwnerWorker[] {
  return lane.workers.filter((w) => !w.parentJobId);
}

/** Count active (unsettled) sonic children belonging to `parentId`. */
export function sonicChildrenRunning(workers: readonly OwnerWorker[], parentId: string): number {
  let n = 0;
  for (const w of workers) if (w.parentJobId === parentId && w.settledAt === null && !w.superseded) n++;
  return n;
}

/** Count active (unsettled) sonic children anywhere in `lane`. */
export function laneSonicRunning(lane: WorkLane): number {
  let n = 0;
  for (const w of lane.workers) if (w.parentJobId && w.settledAt === null && !w.superseded) n++;
  return n;
}

/** Formatted `⚡N` (ASCII `*N`) badge in sonic role ink, or `''` when zero. */
export function sonicBadge(count: number): string {
  return count > 0 ? theme.board.roleInk.sonic(`${mark('⚡', '*')}${count}`) : '';
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
export function routeBadge(w: OwnerWorker): string {
  const tier = w.route ? TIER_MARKS[w.route.tier] : undefined;
  const marks = (tier ? mark(tier[0], tier[1]) : '') + (isHeadless(w) ? mark('∅', 'h') : '');
  return marks ? theme.board.muted(marks) : '';
}

export type RosterRung = 'full' | 'no-model' | 'provider' | 'compact';

function isRosterEligible(w: OwnerWorker, now: number): boolean {
  if (w.parentJobId || w.role === 'sonic' || w.superseded) return false;
  if (w.settledAt === null || w.homeNeedsHuman || unattendedFailure(w) || isUnreadReport(w) || activeFlow(w)) return true;
  return now - w.settledAt < RECENT_SETTLED_MS;
}

/** Whether any worker is currently represented in the Variant A summary roster. */
export function hasRosterWorkers(workers: readonly OwnerWorker[], now: number): boolean {
  return workers.some(
    (w) =>
      (!w.superseded && (w.role === 'sonic' || !!w.parentJobId) && w.settledAt === null) ||
      isRosterEligible(w, now)
  );
}

/**
 * Variant A worker summary (aligned with `docs/design/statusline-workers/sample.html` + sonic as `⚡N`):
 * groups non-sonic workers by `(provider, shortModel, effort)` at `full`, regrouping at `no-model` and `provider`;
 * active sonic workers fold into one `⚡N` token at the end.
 */
export function renderWorkerRoster(
  workers: readonly OwnerWorker[],
  rung: RosterRung,
  now: number,
  ascii = asciiBoard()
): string {
  const liveSonic = workers.filter((w) => !w.superseded && (w.role === 'sonic' || !!w.parentJobId) && w.settledAt === null).length;
  const eligible = workers.filter((w) => isRosterEligible(w, now));
  if (!eligible.length && !liveSonic) return '';

  if (rung === 'compact') {
    const active = eligible.filter((w) => w.settledAt === null).length;
    return [
      active ? `${theme.board.active(mark('◉', '@'))}${active}` : '',
      sonicBadge(liveSonic),
    ]
      .filter(Boolean)
      .join(' ');
  }

  interface Group {
    provGlyph: string;
    provColor?: number;
    unknownProv: boolean;
    name: string;
    effKey: string;
    effGlyph: string;
    startedAt: number;
    count: number;
    ask: number;
    fail: number;
    unread: number;
    done: number;
  }

  const map = new Map<string, Group>();
  for (const w of eligible) {
    const pm = providerMark({ id: w.model ?? undefined, provider: w.provider }, ascii);
    const provGlyph = pm?.glyph ?? mark('◉', '@');
    const unknownProv = !pm;
    const name = rung === 'full' ? workerModelName(w.model, w.provider) : '';
    const effKey = rung !== 'provider' ? (w.effort ?? '').trim().toLowerCase() : '';
    const effGlyph = !ascii && effKey && EFFORT_GLYPHS[effKey] ? EFFORT_GLYPHS[effKey] : '';
    const key = `${unknownProv ? '?' : provGlyph}|${name}|${effKey}`;
    let g = map.get(key);
    if (!g) {
      g = {
        provGlyph,
        provColor: pm?.color,
        unknownProv,
        name,
        effKey,
        effGlyph,
        startedAt: w.startedAt ?? now,
        count: 0,
        ask: 0,
        fail: 0,
        unread: 0,
        done: 0,
      };
      map.set(key, g);
    }
    g.startedAt = Math.min(g.startedAt, w.startedAt ?? now);
    g.count++;
    if (w.homeNeedsHuman) g.ask++;
    else if (unattendedFailure(w)) g.fail++;
    else if (isUnreadReport(w)) g.unread++;
    else if (w.settledAt !== null && !activeFlow(w)) g.done++;
  }

  const groups = [...map.values()].sort((a, b) => a.startedAt - b.startedAt);
  const parts = groups.map((g) => {
    const prov = g.unknownProv ? theme.board.active(g.provGlyph) : theme.board.providerInk(g.provColor)(g.provGlyph);
    const eff = g.effGlyph ? paintEffortBoard(g.effKey, g.effGlyph) : '';
    const cnt = theme.bold(String(g.count));
    const head =
      rung === 'full'
        ? `${prov}${g.name ? ' ' + g.name : ''}${eff} ${cnt}`
        : `${prov}${eff}${cnt}`;
    const marks = [
      g.ask ? theme.board.attention(`?${g.ask > 1 ? g.ask : ''}`) : '',
      g.fail ? theme.board.danger(`${mark('✗', 'x')}${g.fail > 1 ? g.fail : ''}`) : '',
      g.unread ? theme.board.success(`${mark('✓●', '+*')}${g.unread > 1 ? g.unread : ''}`) : '',
      g.done ? theme.board.success(`${mark('✓', '+')}${g.done > 1 ? g.done : ''}`) : '',
    ]
      .filter(Boolean)
      .join(' ');
    return marks ? `${head} ${marks}` : head;
  });

  if (liveSonic > 0) parts.push(sonicBadge(liveSonic));
  return parts.join('  ');
}

/** Pick the richest Variant A rung that fits `room`, falling back to compact total or `''`. */
export function fitWorkerRoster(workers: readonly OwnerWorker[], room: number, now: number, ascii = asciiBoard()): string {
  if (room < 2) return '';
  for (const rung of ['full', 'no-model', 'provider', 'compact'] as const) {
    const text = renderWorkerRoster(workers, rung, now, ascii);
    if (!text) return '';
    if (visualLength(text) <= room) return text;
  }
  return '';
}

export const CATALOG_VENDORS = SHIPPED_MODELS_CATALOG.vendors;
