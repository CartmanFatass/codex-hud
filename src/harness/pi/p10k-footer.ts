/**
 * The pi footer: one line below the editor, from the shared bar builder (`render/layout/bar-fields.ts`), so it shows the
 * same fields in the same order as Claude's statusline and the Codex bar, in the style `barStyle` picks:
 *
 *   DeepSeek V4.1 Flash 1017 max │ ━━━━────── 42%/200K │ example main +1 *1 ?3 │ lens ✓   MCP 2  skills 5
 *
 * The editor's top border carries the p10k ribbon and other extensions' statuses, after pi's native working
 * indicator. Context stays on the shared bottom bar; cost lives only in the ribbon. The notice zone tells the HUD
 * jobs' events and questions (the footer host sees no skill loads, so none are told).
 */

import { execFile } from 'node:child_process';
import * as bar from '../../render/layout/bar-fields.js';
import { shortModel } from '../../render/providers.js';
import { stripAnsi } from '../../render/colors.js';
import { monitorText } from '../../render/monitor-text.js';
import { formatTokenCount } from '../../render/lines/activity-line.js';
import type { WorkSignals } from '../../render/work-summary.js';
import { applyBarSettings } from '../../bar-settings.js';
import { footerConfigPath, loadFooterSettings, saveFooterSettings } from './footer-settings.js';
import { HUD_STATUS_KEY } from './segment.js';
import type { FooterAPI, FooterContext, FooterHost } from './footer-host.js';
export type { FooterHost } from './footer-host.js';

/** One ordinary package instance; no process-global state or host SDK dependency. */
export function createP10kFooter(
  pi: FooterAPI,
  host: FooterHost,
  env: NodeJS.ProcessEnv,
  deps: {
    gitStatus?: (cwd: string, done: (error: Error | null, stdout: string) => void) => void;
  } = {}
) {
  // ─── Which segments exist, and which are on ────────────────────────────────

  /** Context is listed with the bottom fields, but keeps its legacy band.context config key. */
  type Group = 'band' | 'footer';

  /** Every toggleable segment, in the order `/hud footer` lists them and the config file writes them. */
  const SEGMENT_SPECS = {
    model: { group: 'footer', label: 'model name', on: true },
    thinking: { group: 'footer', label: 'thinking level', on: true },
    path: { group: 'footer', label: 'working directory', on: true },
    git: { group: 'footer', label: 'git branch + dirty marks', on: true },
    mcp: { group: 'footer', label: 'loaded MCP server count', on: true },
    skill: { group: 'footer', label: 'loaded skill count', on: true },
    lens: { group: 'footer', label: 'pi-lens verdict', on: true },
    viz: { group: 'footer', label: 'pi-viz diagram mode', on: true },
    statuses: { group: 'footer', label: 'other extensions setStatus() values', on: true },
    context: { group: 'footer', label: 'context window usage', on: true },
    session: { group: 'band', label: 'session name', on: true },
    cache: { group: 'band', label: 'prompt cache hit rate', on: true },
    tokens: { group: 'band', label: 'session tokens', on: true },
    tps: { group: 'band', label: 'output tokens / second', on: true },
    ttft: { group: 'band', label: 'time to first token', on: true },
    cost: { group: 'band', label: 'session cost', on: true },
    time: { group: 'band', label: 'session working time', on: true },
  } as const satisfies Record<string, { group: Group; label: string; on: boolean }>;

  type SegmentId = keyof typeof SEGMENT_SPECS;
  type HudConfig = Record<SegmentId, boolean>;

  const SEGMENT_IDS = Object.keys(SEGMENT_SPECS) as SegmentId[];
  function configPath(): string {
    return footerConfigPath(env);
  }
  function defaultConfig(): HudConfig {
    return Object.fromEntries(SEGMENT_IDS.map((id) => [id, true])) as HudConfig;
  }
  function fromSettings(): HudConfig {
    const settings = loadFooterSettings(env);
    return { ...defaultConfig(), ...settings.footer, ...settings.band };
  }
  function saveConfig(next: HudConfig): string | null {
    const sections: Record<string, Record<string, boolean>> = { footer: {}, band: {} };
    for (const id of SEGMENT_IDS) sections[id === 'context' ? 'band' : SEGMENT_SPECS[id].group][id] = next[id];
    try {
      saveFooterSettings(sections, env);
      return null;
    } catch {
      return 'pi_footer_save_failed';
    }
  }
  let config: HudConfig = fromSettings();

  /** Whether `id` is drawn. An unknown id is on, so a typo cannot hide a segment. */
  function enabled(id: SegmentId): boolean {
    return config[id] !== false;
  }

  // ─── Session data ───────────────────────────────────────────────────────────

  interface UsageTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    /** False while no usage in the session could be priced at all. */
    priced: boolean;
    /** True when some of the cost is our list price, not what the provider reported. */
    estimated: boolean;
  }

  /** The usage block pi attaches to assistant messages, tool results and summaries. */
  interface EntryUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost?: { total?: number };
  }

  // ─── Prices ─────────────────────────────────────────────────────────────────

  /**
   * List prices in USD per 1M tokens, so the band can price a session whose
   * provider reports no cost (pi leaves `usage.cost` at 0 for gateway models).
   *
   * Mistral AI, from https://docs.mistral.ai/inference/pricing (2026-11-02).
   * Mistral bills input, cached input and output only — there is no separate
   * cache-write charge, so `cacheWrite` falls back to the input rate.
   * The same table lives in the source cost tracker for the cost tracker.
   */
  interface Price {
    input: number;
    cacheRead?: number;
    output: number;
  }

  const PRICES_PER_M: Record<string, Price> = {
    'deepseek-v4-1-flash-1017': { input: 0.3, cacheRead: 0.007, output: 1.2 },
    'zai-glm-5-3-flash': { input: 0.15, cacheRead: 0.03, output: 0.5 },
    'zai-glm-5-3': { input: 1.4, cacheRead: 0.14, output: 4.4 },
    'mistral-large-4': { input: 0.7, cacheRead: 0.07, output: 2.1 },
    'mistral-small-4': { input: 0.15, cacheRead: 0.015, output: 0.6 },
    'ministral-3-14b': { input: 0.2, cacheRead: 0.02, output: 0.2 },
    'ministral-3-8b': { input: 0.15, cacheRead: 0.015, output: 0.15 },
    'ministral-3-3b': { input: 0.1, cacheRead: 0.01, output: 0.1 },
    codestral: { input: 0.3, cacheRead: 0.03, output: 0.9 },
    'codestral-embed': { input: 0.15, cacheRead: 0.015, output: 0 },
    'mistral-embed': { input: 0.1, cacheRead: 0.01, output: 0 },
  };

  /** `gpt-5.2-pro` and `gpt-5-2-pro` name one row, as do dated ids and their base. */
  function priceFor(modelId: string | undefined): Price | null {
    if (!modelId) return null;
    const key = modelId.toLowerCase().replace(/\./g, '-');
    const direct = PRICES_PER_M[key];
    if (direct) return direct;
    const base = key.replace(/-\d{4,8}$/, '');
    const undated = PRICES_PER_M[base];
    if (undated) return undated;
    let match: string | null = null;
    for (const candidate of Object.keys(PRICES_PER_M)) {
      if (key.startsWith(candidate) && (match === null || candidate.length > match.length)) match = candidate;
    }
    return match === null ? null : PRICES_PER_M[match]!;
  }

  /** Provider-reported cost when there is one, else our own list price (`estimated`). */
  function entryCost(usage: EntryUsage, modelId: string | undefined): { cost: number; estimated: boolean } | null {
    const reported = usage.cost?.total;
    if (typeof reported === 'number' && reported > 0) return { cost: reported, estimated: false };
    const price = priceFor(modelId);
    if (!price) return null;
    const rate = (value: number | undefined) => (value ?? 0) / 1_000_000;
    const cost =
      usage.input * rate(price.input) +
      usage.output * rate(price.output) +
      usage.cacheRead * rate(price.cacheRead ?? price.input) +
      usage.cacheWrite * rate(price.input);
    return { cost, estimated: true };
  }

  interface Stats {
    sessionId: string;
    leafId: string | null;
    totals: UsageTotals;
    activeMs: number;
    rates: { tps: number | null; ttftMs: number | null };
  }

  /** Cumulative usage over the whole session, rescanned only when the leaf moves. */
  function computeStats(ctx: FooterContext): Stats {
    const totals: UsageTotals = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      priced: false,
      estimated: false,
    };
    // Entries after a message inherit its model: `usage` entries and summaries
    // carry no model of their own.
    let modelId: string | undefined = ctx.model?.id;
    let activeMs = 0;
    const rates: Stats['rates'] = { tps: null, ttftMs: null };
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === 'custom' && entry.customType === 'tps') {
        const data = entry.data as
          { tps?: number; timing?: { ttftMs?: number; totalMs?: number }; model?: { modelId?: string } } | undefined;
        const total = data?.timing?.totalMs;
        if (typeof total === 'number' && Number.isFinite(total) && total > 0) activeMs += total;
        if (data?.model?.modelId) modelId = data.model.modelId;
        continue;
      }
      let usage: EntryUsage | undefined;
      if (entry.type === 'usage') {
        usage = entry.usage;
      } else if (entry.type === 'message' && entry.message?.role === 'assistant') {
        usage = entry.message.usage;
        const recorded = (entry.message as { model?: string }).model;
        if (recorded) modelId = recorded;
      } else if (entry.type === 'message' && entry.message?.role === 'toolResult' && entry.message.usage) {
        usage = entry.message.usage;
      } else if ((entry.type === 'branch_summary' || entry.type === 'compaction') && entry.usage) {
        usage = entry.usage;
      }
      if (!usage) continue;
      totals.input += usage.input;
      totals.output += usage.output;
      totals.cacheRead += usage.cacheRead;
      totals.cacheWrite += usage.cacheWrite;
      const priced = entryCost(usage, modelId);
      if (priced !== null) {
        totals.cost += priced.cost;
        totals.priced = true;
        totals.estimated ||= priced.estimated;
      }
    }
    // Latest valid rates on the active branch; burst deliveries keep the last measurement.
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== 'custom' || entry.customType !== 'tps') continue;
      const data = entry.data as { tps?: number; timing?: { ttftMs?: number } } | undefined;
      const tps = data?.tps,
        ttft = data?.timing?.ttftMs;
      if (typeof tps === 'number' && Number.isFinite(tps) && tps > 0) rates.tps = tps;
      if (typeof ttft === 'number' && Number.isFinite(ttft) && ttft >= 0) rates.ttftMs = ttft;
    }
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId(),
      totals,
      activeMs,
      rates,
    };
  }

  function basename(path: string): string {
    const trimmed = path.replace(/\/+$/, '');
    const index = trimmed.lastIndexOf('/');
    return index < 0 ? trimmed : trimmed.slice(index + 1);
  }

  // ─── Git (branch + dirty counts in one cached call) ─────────────────────────

  interface GitState {
    branch: string | null;
    staged: number;
    unstaged: number;
    untracked: number;
  }

  const GIT_TTL_MS = 3000;
  let gitCache: { cwd: string; state: GitState; at: number } | null = null;
  let gitInFlight = false;

  function readGit(cwd: string): GitState | null {
    return gitCache && gitCache.cwd === cwd ? gitCache.state : null;
  }

  /** Refresh in the background; `onUpdate` repaints once the result lands. */
  function refreshGit(cwd: string, onUpdate: () => void): void {
    if (gitInFlight) return;
    if (gitCache && gitCache.cwd === cwd && Date.now() - gitCache.at < GIT_TTL_MS) return;

    gitInFlight = true;
    const run =
      deps.gitStatus ??
      ((cwd, done) => {
        execFile('git', ['-C', cwd, 'status', '--porcelain=v1', '-b'], { timeout: 1500 }, done);
      });
    run(cwd, (error, stdout) => {
      gitInFlight = false;
      if (error) {
        gitCache = { cwd, state: { branch: null, staged: 0, unstaged: 0, untracked: 0 }, at: Date.now() };
        return;
      }
      const lines = stdout.split('\n');
      const header = lines[0] ?? '';
      const branch = header.startsWith('## ') ? header.slice(3).split('...')[0]!.trim() || null : null;
      const state: GitState = { branch, staged: 0, unstaged: 0, untracked: 0 };
      for (const line of lines.slice(1)) {
        if (line.length < 2) continue;
        const index = line[0]!;
        const worktree = line[1]!;
        if (index === '?' && worktree === '?') state.untracked++;
        else {
          if (index !== ' ' && index !== '?') state.staged++;
          if (worktree !== ' ' && worktree !== '?') state.unstaged++;
        }
      }
      gitCache = { cwd, state, at: Date.now() };
      onUpdate();
    });
  }

  // ─── Loaded resources (MCP servers, skills) ─────────────────────────────────

  interface LoadedCounts {
    mcp: number;
    skills: number;
  }

  const LOADED_TTL_MS = 2000;
  let loadedCache: { counts: LoadedCounts; at: number } | null = null;

  /**
   * MCP servers that actually loaded, counted from the tools they expose:
   * `mcp__memory__read_graph` and the `mcp__memory` namespace proxy both name
   * `memory`. Servers that failed to connect expose nothing and are not counted.
   */
  function mcpServerCount(pi: FooterAPI): number {
    const names = new Set<string>();
    for (const tool of pi.getAllTools?.() ?? []) {
      if (!tool.name.startsWith('mcp__')) continue;
      const rest = tool.name.slice('mcp__'.length);
      const end = rest.indexOf('__');
      names.add(end < 0 ? rest : rest.slice(0, end));
    }
    return names.size;
  }

  /** Skills are registered as `skill:<name>` commands, so the command list is the count. */
  function loadedCounts(pi: FooterAPI): LoadedCounts {
    if (loadedCache && Date.now() - loadedCache.at < LOADED_TTL_MS) return loadedCache.counts;
    let counts: LoadedCounts = { mcp: 0, skills: 0 };
    try {
      counts = {
        mcp: mcpServerCount(pi),
        skills: (pi.getCommands?.() ?? []).filter((command) => command.source === 'skill').length,
      };
    } catch {
      // A mode without a command list simply has nothing to count.
    }
    loadedCache = { counts, at: Date.now() };
    return counts;
  }

  // ─── pi-lens verdict (the `lens` chip) ──────────────────────────────────────

  /**
   * pi-lens draws a summary widget under the editor. The identity line carries
   * that summary instead, so the footer keeps one row: the counts come from the
   * bus events pi-lens publishes after every analysis, keyed by file, so a
   * re-analysis replaces the previous verdict instead of adding to it.
   */
  interface LensFile {
    errors: number;
    warnings: number;
  }

  const lensFiles = new Map<string, LensFile>();
  /** False until the session has analyzed something; the chip stays absent. */
  let lensAnalyzed = false;

  function countLensSeverities(diagnostics: unknown): { errors: number; warnings: number } {
    let errors = 0;
    let warnings = 0;
    if (!Array.isArray(diagnostics)) return { errors, warnings };
    for (const diagnostic of diagnostics) {
      const severity = (diagnostic as { severity?: unknown } | null)?.severity;
      if (severity === 'error') errors += 1;
      else if (severity === 'warning') warnings += 1;
    }
    return { errors, warnings };
  }

  function recordLensFile(filePath: unknown, diagnostics: unknown): void {
    if (typeof filePath !== 'string' || filePath.length === 0) return;
    lensAnalyzed = true;
    const { errors, warnings } = countLensSeverities(diagnostics);
    if (errors === 0 && warnings === 0) lensFiles.delete(filePath);
    else lensFiles.set(filePath, { errors, warnings });
  }

  function lensTotals(): { errors: number; warnings: number } {
    let errors = 0;
    let warnings = 0;
    for (const file of lensFiles.values()) {
      errors += file.errors;
      warnings += file.warnings;
    }
    return { errors, warnings };
  }

  // ─── pi-viz mode (the `viz` chip) ───────────────────────────────────────────

  /**
   * pi-viz records its mode as a `viz-mode` custom entry whenever `/viz` changes
   * it, so the chip is read from the session rather than from the other
   * extension's memory: it survives a resume, and the two extensions stay
   * decoupled — neither imports the other.
   */
  function readVizMode(ctx: FooterContext): string | undefined {
    try {
      const entries = ctx.sessionManager.getBranch();
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type !== 'custom' || entry.customType !== 'viz-mode') continue;
        const mode = (entry.data as { mode?: unknown } | undefined)?.mode;
        return typeof mode === 'string' && mode.length > 0 ? mode : undefined;
      }
    } catch {
      // A session manager without getBranch is not worth a broken footer.
    }
    return undefined;
  }

  // ─── Other extensions' statuses ────────────────────────────────────────────

  /** The footer owns the provider; the top border reads it live, before giving any space to the ribbon. */
  let footerStatuses: (() => ReadonlyMap<string, string>) | null = null;

  /** `$0.0423` for pocket change, `$1.24` once it is real money. */
  function formatCost(cost: number): string {
    if (cost >= 100) return cost.toFixed(1);
    if (cost >= 1) return cost.toFixed(2);
    if (cost >= 0.01) return cost.toFixed(3);
    return cost.toFixed(4);
  }

  // ─── Segment assembly ───────────────────────────────────────────────────────

  /**
   * setStatus() keys that only repeat a segment we already draw. `mcp` is
   * pi-mcp-adapter's chip for the same server count, and pi-lens publishes its
   * verdict under `pi-lens-lsp` (older builds: `pi-lens`/`lens`). The HUD's own
   * key is the Work segment.
   */
  const DUPLICATE_STATUS_KEYS = new Set(['mcp', 'lens', 'pi-lens', 'pi-lens-lsp', HUD_STATUS_KEY]);

  /** What pi has to say, as `renderBar` takes it; a switched-off or empty field is simply not there. */
  function buildFacts(ctx: FooterContext, pi: FooterAPI): bar.BarFacts {
    const model = ctx.model;
    const thinking = model?.reasoning ? pi.getThinkingLevel?.() : undefined;
    // Context pressure against the window; `?` while pi has no reading yet.
    const usage = ctx.getContextUsage();
    const window = usage?.contextWindow ?? model?.contextWindow ?? 0;
    const percent = usage && usage.percent !== null ? Math.round(usage.percent) : null;
    // The directory's name, then the branch with its staged `+`, unstaged `*` and untracked `?` counts.
    const cwd = ctx.sessionManager.getCwd();
    const git = enabled('git') ? readGit(cwd) : null;
    const marks = git
      ? [
          ['+', git.staged],
          ['*', git.unstaged],
          ['?', git.untracked],
        ]
          .filter(([, n]) => n)
          .map(([mark, n]) => ` ${mark}${n}`)
      : [];
    const place = enabled('path') ? basename(cwd) || cwd : '';
    // pi-lens's verdict and pi-viz's mode lead the right cluster:
    // `lens ✓` when every analyzed file is clean, `lens 2E 1W` when not.
    const words: bar.Form[] = [];
    if (lensAnalyzed && enabled('lens')) {
      const { errors, warnings } = lensTotals();
      const verdict = [errors > 0 ? `${errors}E` : '', warnings > 0 ? `${warnings}W` : ''].filter(Boolean).join(' ');
      words.push([['lens', 'dim'], [' '], [verdict || '\u2713', errors > 0 ? 'bad' : warnings > 0 ? 'warn' : 'ok']]);
    }
    if (capturedViz && enabled('viz')) words.push([['viz', 'dim'], [' '], [capturedViz, 'value']]);
    return {
      model: model
        ? {
            name: shortModel(model.id) || model.name || model.id,
            effort: enabled('thinking') && thinking && thinking !== 'off' ? thinking : undefined,
            id: model.id,
            provider: model.provider,
            baseUrl: model.baseUrl,
          }
        : undefined,
      context:
        enabled('context') && (percent !== null || window > 0)
          ? { percent: percent ?? 0, shown: percent === null ? '?' : `${percent}%`, window }
          : undefined,
      project: {
        name: place || git?.branch || '',
        branch: place ? (git?.branch ?? null) : null,
        marks: marks.join(''),
        dirty: marks.length > 0,
      },
      needs: work.needs,
      events: work.events,
      loaded: {
        counts: [
          ['MCP', enabled('mcp') ? capturedLoaded.mcp : 0],
          ['skills', enabled('skill') ? capturedLoaded.skills : 0],
        ],
        words,
      },
    };
  }

  let current: FooterContext | null = null;
  let view: FooterContext | null = null;
  let stats: Stats | undefined;
  let capturedViz: string | undefined;
  let capturedLoaded: LoadedCounts = { mcp: 0, skills: 0 };
  /** What the HUD jobs ask and just did, pushed by the Work segment's timer. */
  let work: WorkSignals = { needs: [], events: [] };
  let repaint: (() => void) | null = null;
  let mounted = false;
  let live = true;
  const removers: (() => void)[] = [];
  // Measurements belong in the ribbon, not in the chat.
  pi.registerEntryRenderer?.('tps', () => undefined);
  function listen(name: string, handler: (data: unknown) => void) {
    const remove = pi.events?.on(name, (data) => {
      if (live) handler(data);
    });
    if (remove) removers.push(remove);
  }
  listen('pi-lens/analysis-complete', (data) => {
    const payload = data as { filePath?: unknown; diagnostics?: unknown } | undefined;
    recordLensFile(payload?.filePath, payload?.diagnostics);
    repaint?.();
  });
  listen('pilens:diagnostics', (data) => {
    const payload = data as { files?: unknown } | undefined;
    if (!Array.isArray(payload?.files)) return;
    for (const file of payload.files) {
      const entry = file as { path?: unknown; diagnostics?: unknown } | null;
      recordLensFile(entry?.path, entry?.diagnostics);
    }
    repaint?.();
  });
  // Capture all history/resource/git work on lifecycle events, never resize/repaint.
  function update() {
    const ctx = current;
    if (!ctx || !mounted) return;
    const sessionId = ctx.sessionManager.getSessionId(),
      leafId = ctx.sessionManager.getLeafId();
    if (!stats || stats.sessionId !== sessionId || stats.leafId !== leafId) stats = computeStats(ctx);
    capturedViz = readVizMode(ctx);
    capturedLoaded = loadedCounts(pi);
    const cwd = ctx.sessionManager.getCwd(),
      name = ctx.sessionManager.getSessionName?.(),
      usage = ctx.getContextUsage();
    view = {
      ...ctx,
      model: ctx.model ? { ...ctx.model } : undefined,
      sessionManager: { ...ctx.sessionManager, getCwd: () => cwd, getSessionName: () => name },
      getContextUsage: () => usage,
    };
    refreshGit(cwd, () => {
      if (current === ctx && mounted) repaint?.();
    });
    repaint?.();
  }
  /** The one line, fitted to `width`; pi's own width measure has the last word, so the host never gets a wider row. */
  function line(width: number): string {
    if (!view || !stats || !mounted || width <= 0) return '';
    const text = bar.renderBar(buildFacts(view, pi), width).line;
    return host.visibleWidth(text) > width ? host.truncateToWidth(text, width, '') : text;
  }
  /** Original p10k palette: terminal indices, not fixed RGB; every arrow bridges neighbouring backgrounds. */
  function band(width: number, nowMs: number): string {
    if (!view || !stats || width < 6) return '';
    const { totals, rates } = stats;
    const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
    const seconds = Math.floor(
      (stats.activeMs + (turnStartedAt === null ? 0 : Math.max(0, nowMs - turnStartedAt))) / 1000
    );
    const duration =
      seconds >= 3600
        ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
        : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    const segments: { text: string; bg: number }[] = [];
    const add = (id: SegmentId, text: string, bg: number) => {
      if (enabled(id) && text) segments.push({ text, bg });
    };
    add('session', monitorText(view.sessionManager.getSessionName?.()?.trim() ?? ''), 183);
    add('cache', `cache ${prompt > 0 ? `${Math.round((totals.cacheRead / prompt) * 100)}%` : '-'}`, 152);
    add('tokens', `tok ${prompt + totals.output > 0 ? formatTokenCount(prompt + totals.output) : '-'}`, 146);
    add('tps', rates.tps === null ? '- t/s' : `${rates.tps.toFixed(1)} t/s`, 173);
    add(
      'ttft',
      `TTFT ${rates.ttftMs === null ? '-' : rates.ttftMs >= 1000 ? `${(rates.ttftMs / 1000).toFixed(1)}s` : `${Math.round(rates.ttftMs)}ms`}`,
      250
    );
    add('cost', totals.priced ? `${totals.estimated ? '~' : ''}$${formatCost(totals.cost)}` : '$-', 179);
    add('time', duration, 187);
    const size = () => 1 + segments.reduce((n, s) => n + host.visibleWidth(s.text) + 3, 0);
    // Drop whole segments from the right; only the final block is ever cut.
    while (segments.length > 1 && size() > width) segments.pop();
    if (!segments.length) return '';
    if (size() > width) segments[0]!.text = host.truncateToWidth(segments[0]!.text, width - 4, '…');
    const fg = (index: number) => (noColor() ? '' : `\x1b[38;5;${index}m`);
    const bg = (index: number) => (noColor() ? '' : `\x1b[48;5;${index}m`);
    const reset = noColor() ? '' : '\x1b[0m';
    let out = reset + fg(segments[0]!.bg) + '\ue0b6';
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]!,
        next = segments[i + 1];
      out += bg(s.bg) + fg(235) + ` ${s.text} `;
      out += (next ? bg(next.bg) : reset) + fg(s.bg) + '\ue0b0';
    }
    return out + reset;
  }
  const noColor = () => Boolean(env.NO_COLOR ?? process.env.NO_COLOR);
  function statuses(): string {
    if (!enabled('statuses')) return '';
    try {
      return [...(footerStatuses?.() ?? [])]
        .filter(([key]) => !DUPLICATE_STATUS_KEYS.has(key))
        .map(([, value]) => monitorText(stripAnsi(value.trim())))
        .filter(Boolean)
        .join(' · ');
    } catch {
      return '';
    }
  }
  class BandEditor extends host.CustomEditor {
    renderTopBorder(width: number, hiddenLineCount: number): string {
      const base: string = super.renderTopBorder(width, hiddenLineCount);
      // Reuse pi's actual left working indicator and scroll hint, touching only trailing rule cells.
      const tail = stripAnsi(base).match(/─+$/)?.[0].length ?? 0;
      if (!mounted || tail < 2) return noColor() ? stripAnsi(base) : base;
      let prefix = host.truncateToWidth(base, width - tail, '');
      let room = tail - 1;
      const words = statuses();
      if (words && room > 4) {
        if (!prefix) {
          prefix = current!.ui.theme.fg('borderMuted', '── ');
          room -= 3;
        }
        const text = host.truncateToWidth(words, room - 1, '…');
        prefix += current!.ui.theme.fg('muted', text) + ' ';
        room -= host.visibleWidth(text) + 1;
      }
      const ribbon = band(room, Date.now());
      const rule = current!.ui.theme.fg('borderMuted', '─'.repeat(Math.max(0, room - host.visibleWidth(ribbon))));
      const result = prefix + rule + ribbon + current!.ui.theme.fg('borderMuted', '─');
      return noColor() ? stripAnsi(result) : result;
    }
  }
  let turnStartedAt: number | null = null;
  function stop() {
    const ctx = current;
    mounted = false;
    current = null;
    view = null;
    repaint = null;
    stats = undefined;
    turnStartedAt = null;
    footerStatuses = null;
    ctx?.ui.setEditorComponent(undefined);
    ctx?.ui.setFooter(undefined);
  }
  function start(ctx: FooterContext) {
    stop();
    if (!live || ctx.mode !== 'tui' || !ctx.hasUI) return;
    current = ctx;
    mounted = true;
    config = fromSettings();
    work = { needs: [], events: [] };
    applyBarSettings();
    lensFiles.clear();
    lensAnalyzed = false;
    update();
    ctx.ui.setFooter((tui, _theme, data) => {
      repaint = () => tui.requestRender();
      footerStatuses = () => data.getExtensionStatuses();
      return {
        render(width) {
          const text = line(width);
          return text ? [text] : [];
        },
        invalidate() {},
        dispose() {
          if (current === ctx) footerStatuses = null;
        },
      };
    });
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) => new BandEditor(tui, theme, keybindings, { embedWorkingStatus: true })
    );
  }
  return {
    start,
    stop,
    update,
    /** The Work segment's timer: what the HUD jobs ask now and what they just did. */
    setWork(signals: WorkSignals) {
      work = signals;
      repaint?.();
    },
    working() {
      turnStartedAt = Date.now();
      update();
    },
    /** A run is over: the bar's two display keys may have changed since the footer mounted. */
    settled() {
      turnStartedAt = null;
      applyBarSettings();
      update();
    },
    async command(args: string, ctx: FooterContext) {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const target = (id: string) => SEGMENT_IDS.includes(id as SegmentId);

      if (words.length === 0 || words[0] === 'list') {
        const lines = [
          `footer: ${SEGMENT_IDS.filter((id) => SEGMENT_SPECS[id].group === 'footer' && enabled(id)).join(' ') || '(empty)'}`,
          `band:   ${SEGMENT_IDS.filter((id) => SEGMENT_SPECS[id].group === 'band' && enabled(id)).join(' ') || '(empty)'}`,
          `config: ${configPath()}`,
        ];
        ctx.ui.notify(lines.join('\n'), 'info');
        return;
      }

      const before = { ...config };
      const [verb, ...rest] = words;

      if (verb === 'reset') {
        config = defaultConfig();
      } else if ((verb === 'band' || verb === 'footer') && (rest[0] === 'on' || rest[0] === 'off')) {
        for (const id of SEGMENT_IDS) {
          if (SEGMENT_SPECS[id].group === verb) config[id] = rest[0] === 'on';
        }
      } else if (verb === 'on' || verb === 'off' || verb === 'toggle') {
        const ids = rest.includes('all') ? SEGMENT_IDS : rest.filter(target);
        if (ids.length === 0) {
          ctx.ui.notify(`Nothing to change. Known segments: ${SEGMENT_IDS.join(' ')}`, 'error');
          return;
        }
        for (const id of ids) {
          config[id as SegmentId] = verb === 'on' ? true : verb === 'off' ? false : !config[id as SegmentId];
        }
      } else {
        ctx.ui.notify(
          `Unknown command "${verb}". Try: /hud footer, /hud footer off lens viz, /hud footer on all, /hud footer band off, /hud footer reset`,
          'error'
        );
        return;
      }

      const changed = SEGMENT_IDS.filter((id) => before[id] !== config[id]);
      if (changed.length === 0) {
        ctx.ui.notify('Nothing changed.', 'info');
        return;
      }

      const error = saveConfig(config);
      repaint?.();
      ctx.ui.notify(
        error
          ? `Updated for this session, but the config did not save: ${error}`
          : `${changed.map((id) => `${id} ${config[id] ? 'on' : 'off'}`).join(', ')}`,
        error ? 'error' : 'info'
      );
    },
    dispose() {
      stop();
      live = false;
      for (const remove of removers.splice(0)) remove();
    },
  };
}
