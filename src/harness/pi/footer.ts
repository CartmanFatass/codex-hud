import { truncateAnsi } from '../../render/colors.js';

/** Public UI API/source pin, not a runtime version attestation or capability grant. */
export const PI_FOOTER_SOURCE = '4a080252f06caf63a525d7873c5d94d3c23887e0';
export const PI_FOOTER_VERSION = '1.4.0';
export const PI_FOOTER_SUMMARY_MAX_AGE_MS = 15_000;
export const PI_FOOTER_MAX_ENTRIES = 10_000;

/** Native display identity only. No SourceId, caller context or managed authority is inferred. */
export interface PiFooterIdentity {
  sessionId: string;
  sessionFile: string | null;
  sessionDir: string;
  leafId: string | null;
}
export interface PiFooterHudSummary {
  identity: PiFooterIdentity;
  observedAt: number;
  coverage: 'complete' | 'partial' | 'catching_up';
  delegated: { total: number; working: number; waiting: number };
}
/** Explicit, already available in-memory data only. This module never discovers or reads storage. */
export type PiFooterSummaryProvider = (identity: Readonly<PiFooterIdentity>) => unknown;

// Narrow structural projections of the pinned official ExtensionContext/setFooter API.
// The extension entry itself imports official ExtensionAPI; no SDK is bundled into HUD.
export interface PiFooterContext {
  mode: string;
  hasUI: boolean;
  model: { id: string; provider?: string } | undefined;
  thinkingLevel?: string;
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getSessionDir(): string;
    getLeafId(): string | null;
    getBranch(): readonly unknown[];
  };
  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  isIdle(): boolean;
  ui: { setFooter(factory: PiFooterFactory | undefined): void };
}
export type PiFooterFactory = (
  tui: { requestRender(): void },
  theme: { fg(color: 'dim', text: string): string },
  data: {
    getGitBranch(): string | null;
    getExtensionStatuses(): ReadonlyMap<string, string>;
    onBranchChange(callback: () => void): () => void;
  }
) => { render(width: number): string[]; invalidate(): void; dispose(): void };

type UsageField = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'costUsd';
type BranchUsage = Record<UsageField, number | null> & { coverage: 'complete' | 'partial' };
type HudState = 'unavailable' | 'invalid' | 'identity_mismatch' | 'stale' | 'partial' | 'current';
export interface PiFooterSnapshot {
  identity: PiFooterIdentity | null;
  model: string | null;
  effort: string | null;
  activity: 'idle' | 'working' | 'unknown';
  context: { tokens: number | null; window: number | null; percent: number | null };
  usage: BranchUsage;
  hud: { state: HudState; summary: PiFooterHudSummary | null };
}
const fields: UsageField[] = ['input', 'output', 'cacheRead', 'cacheWrite', 'costUsd'];
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const count = (v: unknown): v is number => number(v) && Number.isSafeInteger(v);
const text = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const unknownUsage = (): BranchUsage => ({
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  costUsd: null,
  coverage: 'partial',
});

/** Current native branch, not whole-file/session/invoice totals. No content blocks are read. */
export function piFooterBranchUsage(entries: readonly unknown[]): BranchUsage {
  if (!Array.isArray(entries) || entries.length > PI_FOOTER_MAX_ENTRIES) return unknownUsage();
  const sums: BranchUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, coverage: 'complete' };
  const seen = new Map<string, Record<UsageField, number | null>>();
  for (const entry of entries) {
    // Official v1.4.0 stores compaction usage and standalone usage/cache_warm as
    // separate entry types. Neither is an assistant interaction on this branch.
    if (!object(entry)) return unknownUsage();
    if (entry.type !== 'message') continue;
    if (!object(entry.message) || !text(entry.message.role, 64)) return unknownUsage();
    if (entry.message.role !== 'assistant') continue;
    if (!text(entry.id, 256)) return unknownUsage();
    const usage = object(entry.message.usage) ? entry.message.usage : {};
    const cost = object(usage.cost) ? usage.cost.total : undefined;
    const values: Record<UsageField, number | null> = {
      input: count(usage.input) ? usage.input : null,
      output: count(usage.output) ? usage.output : null,
      cacheRead: count(usage.cacheRead) ? usage.cacheRead : null,
      cacheWrite: count(usage.cacheWrite) ? usage.cacheWrite : null,
      costUsd: number(cost) ? cost : null,
    };
    const previous = seen.get(entry.id);
    for (const field of fields) {
      if (values[field] === null || (previous && previous[field] !== values[field])) sums[field] = null;
      else if (!previous && sums[field] !== null) {
        const total = sums[field]! + values[field]!;
        sums[field] = (field === 'costUsd' ? number(total) : count(total)) ? total : null;
      }
    }
    if (!previous) seen.set(entry.id, values);
  }
  if (fields.some((field) => sums[field] === null)) sums.coverage = 'partial';
  return sums;
}

function identity(value: unknown): value is PiFooterIdentity {
  return (
    object(value) &&
    Object.keys(value).sort().join(',') === 'leafId,sessionDir,sessionFile,sessionId' &&
    text(value.sessionId, 256) &&
    text(value.sessionDir) &&
    (value.sessionFile === null || text(value.sessionFile)) &&
    (value.leafId === null || text(value.leafId, 256))
  );
}
const sameIdentity = (a: PiFooterIdentity, b: PiFooterIdentity) =>
  a.sessionId === b.sessionId &&
  a.sessionFile === b.sessionFile &&
  a.sessionDir === b.sessionDir &&
  a.leafId === b.leafId;

export function validatePiFooterSummary(
  value: unknown,
  current: PiFooterIdentity | null,
  now: number
): PiFooterSnapshot['hud'] {
  const denied = (state: HudState): PiFooterSnapshot['hud'] => ({ state, summary: null });
  if (value === undefined || value === null || current === null) return denied('unavailable');
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'coverage,delegated,identity,observedAt' ||
    !identity(value.identity) ||
    !count(value.observedAt) ||
    !number(now) ||
    !['complete', 'partial', 'catching_up'].includes(String(value.coverage)) ||
    !object(value.delegated) ||
    Object.keys(value.delegated).sort().join(',') !== 'total,waiting,working' ||
    !count(value.delegated.total) ||
    !count(value.delegated.working) ||
    !count(value.delegated.waiting) ||
    value.delegated.working + value.delegated.waiting > value.delegated.total
  )
    return denied('invalid');
  if (!sameIdentity(value.identity, current)) return denied('identity_mismatch');
  if (value.observedAt > now || now - value.observedAt > PI_FOOTER_SUMMARY_MAX_AGE_MS) return denied('stale');
  if (value.coverage !== 'complete') return denied('partial');
  // Copy only validated presentation data. The provider cannot mutate a cached footer.
  return {
    state: 'current',
    summary: {
      identity: { ...value.identity },
      observedAt: value.observedAt,
      coverage: 'complete',
      delegated: { total: value.delegated.total, working: value.delegated.working, waiting: value.delegated.waiting },
    },
  };
}

/** Capture outside render; no repeated history traversal on repaint/resize. */
export function capturePiFooter(
  ctx: PiFooterContext,
  provider?: PiFooterSummaryProvider,
  now = Date.now()
): PiFooterSnapshot {
  let current: PiFooterIdentity | null = null;
  try {
    const candidate = {
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      sessionDir: ctx.sessionManager.getSessionDir(),
      leafId: ctx.sessionManager.getLeafId(),
    };
    if (identity(candidate)) current = candidate;
  } catch {
    /* An unavailable native identity is not guessed from cwd or environment. */
  }
  let usage = unknownUsage();
  try {
    usage = piFooterBranchUsage(ctx.sessionManager.getBranch());
  } catch {
    /* Unknown remains unknown. */
  }
  let context: PiFooterSnapshot['context'] = { tokens: null, window: null, percent: null };
  try {
    const value = ctx.getContextUsage();
    if (value && count(value.contextWindow) && value.contextWindow > 0) {
      context = {
        tokens: count(value.tokens) ? value.tokens : null,
        window: value.contextWindow,
        percent: count(value.tokens) && number(value.percent) ? value.percent : null,
      };
    }
  } catch {
    /* The public API explicitly permits unavailable/unknown context usage. */
  }
  let activity: PiFooterSnapshot['activity'] = 'unknown';
  try {
    const idle = ctx.isIdle();
    if (typeof idle === 'boolean') activity = idle ? 'idle' : 'working';
  } catch {
    /* No inferred terminal state. */
  }
  let hud: PiFooterSnapshot['hud'] = { state: 'unavailable', summary: null };
  if (provider && current) {
    try {
      hud = validatePiFooterSummary(provider(Object.freeze({ ...current })), current, now);
    } catch {
      hud = { state: 'invalid', summary: null };
    }
  }
  return {
    identity: current,
    model: text(ctx.model?.id, 256) ? ctx.model!.id : null,
    effort: text(ctx.thinkingLevel, 64) ? ctx.thinkingLevel! : null,
    activity,
    context,
    usage,
    hud,
  };
}

/** Treat every native string as plain text. Never permit terminal controls or bidi overrides. */
function clean(value: string, max = 160): string {
  return value
    .slice(0, max)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const tokens = (n: number | null) => (n === null ? '?' : n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`);

export function renderPiFooter(
  snapshot: PiFooterSnapshot,
  width: number,
  now = Date.now(),
  gitBranch: string | null = null,
  statuses: readonly string[] = []
): string[] {
  if (!Number.isFinite(width) || width < 1) return [];
  width = Math.min(10_000, Math.floor(width));
  const s = snapshot,
    u = s.usage,
    c = s.context;
  const ctx =
    c.window === null
      ? 'ctx unknown'
      : `ctx ~${tokens(c.tokens)}/${tokens(c.window)}${c.percent === null ? '' : ` ${c.percent.toFixed(1)}%`}`;
  const hud = s.hud.summary ? validatePiFooterSummary(s.hud.summary, s.identity, now) : s.hud;
  const status = hud.summary
    ? `HUD ${hud.summary.delegated.total} delegated ${hud.summary.delegated.working} working ${hud.summary.delegated.waiting} waiting`
    : `HUD ${hud.state === 'current' ? 'unavailable' : hud.state.replace('_', ' ')}`;
  const cost = u.costUsd === null ? '$?' : `$${u.costUsd.toFixed(3)}`;
  const lines = [
    `π ${clean(s.model ?? 'model unknown')}${s.effort ? ` ${clean(s.effort, 64)}` : ''} | ${ctx} | ${s.activity}`,
    `current branch: ↑${tokens(u.input)} ↓${tokens(u.output)} cache↓${tokens(u.cacheRead)} cache↑${tokens(u.cacheWrite)} ${cost}${u.coverage === 'partial' ? ' partial' : ''}`,
    `session ${s.identity ? clean(s.identity.sessionId, 12) : '?'} | ${status}${gitBranch ? ` | git ${clean(gitBranch, 80)}` : ''}`,
  ];
  const visibleStatuses = statuses
    .slice(0, 8)
    .map((value) => clean(value, 128))
    .filter(Boolean);
  if (visibleStatuses.length) lines.push(visibleStatuses.join(' | '));
  return lines.map((line) => truncateAnsi(line, width));
}

/** Owns only this explicitly loaded footer. No timer, file access, provider call or lifecycle authority. */
export function createPiFooterController(options: { summary?: PiFooterSummaryProvider; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  let enabled = true;
  let current: PiFooterContext | null = null;
  let snapshot: PiFooterSnapshot | null = null;
  let remove: (() => void) | null = null;
  let requestRender: (() => void) | null = null;
  function unmount() {
    remove?.();
    remove = null;
    requestRender = null;
    if (current?.mode === 'tui' && current.hasUI) current.ui.setFooter(undefined);
    current = null;
    snapshot = null;
  }
  function start(ctx: PiFooterContext) {
    unmount();
    if (!enabled || ctx.mode !== 'tui' || !ctx.hasUI) return;
    current = ctx;
    snapshot = capturePiFooter(ctx, options.summary, now());
    ctx.ui.setFooter((tui, theme, data) => {
      let disposed = false;
      let gitBranch: string | null = null;
      const branch = () => {
        try {
          gitBranch = data.getGitBranch();
        } catch {
          gitBranch = null;
        }
      };
      branch();
      const unsubscribe = data.onBranchChange(() => {
        if (!disposed) {
          branch();
          tui.requestRender();
        }
      });
      const dispose = () => {
        if (!disposed) {
          disposed = true;
          unsubscribe();
        }
      };
      remove = dispose;
      requestRender = () => {
        if (!disposed) tui.requestRender();
      };
      return {
        dispose,
        invalidate() {},
        render(width) {
          if (disposed || !snapshot) return [];
          const statuses: string[] = [];
          try {
            let inspected = 0;
            for (const value of data.getExtensionStatuses().values()) {
              if (inspected++ === 8) break;
              if (typeof value === 'string') statuses.push(value);
            }
          } catch {
            /* Other extensions' statuses are optional. */
          }
          return renderPiFooter(snapshot, width, now(), gitBranch, statuses).map((line) => theme.fg('dim', line));
        },
      };
    });
  }
  return {
    start,
    update(ctx: PiFooterContext) {
      if (!enabled || !current || ctx.mode !== 'tui' || !ctx.hasUI) return;
      current = ctx;
      snapshot = capturePiFooter(ctx, options.summary, now());
      requestRender?.();
    },
    setEnabled(value: boolean, ctx: PiFooterContext) {
      enabled = value;
      if (enabled) start(ctx);
      else unmount();
    },
    isEnabled: () => enabled,
    shutdown: unmount,
  };
}
