/**
 * The pi footer: one line below the editor, from the shared bar builder (`render/layout/bar-fields.ts`), so it shows the
 * same fields in the same order as Claude's statusline and the Codex bar, in the style `barStyle` picks:
 *
 *   DeepSeek V4.1 Flash 1017 max │ ━━━━────── 42%/200K │ example main +1 *1 ?3 │ lens ✓   MCP 2  skills 5
 *
 * It replaces p10k-footer's band in the editor's top border and its identity row; pi's own editor, with its working
 * indicator, stays as it is. Other extensions' statuses (pi-lens, pi-viz) are read through the footer data provider and
 * share the right cluster, lowest priority. pi has no quota, so the cost the session reported stands in its place. The
 * notice zone tells the HUD jobs' events and questions (the footer host sees no skill loads, so none are told). A
 * reading with no data is left out.
 */

import { execFile } from 'node:child_process';
import * as bar from '../../render/layout/bar-fields.js';
import { shortModel } from '../../render/providers.js';
import type { WorkSignals } from '../../render/work-summary.js';
import { applyBarSettings } from '../../settings-runtime.js';
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

  /** The config groups kept from p10k-footer, so an imported `piFooter` section still applies; both are one line now. */
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
    context: { group: 'band', label: 'context window usage', on: true },
    cost: { group: 'band', label: 'session cost', on: true },
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
    for (const id of SEGMENT_IDS) sections[SEGMENT_SPECS[id].group][id] = next[id];
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
    for (const entry of ctx.sessionManager.getEntries()) {
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
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId(),
      totals,
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

  // ─── Other extensions' statuses (the `statuses` chip) ──────────────────────

  /**
   * Statuses other extensions publish with `ctx.ui.setStatus()`. They are only
   * reachable through the footer factory's `FooterDataProvider`, so the factory
   * below stashes it here and the identity line reads it on the next render.
   *
   * This is why the footer is not simply blanked: blanking it also hides every
   * extension status, which is how pi-lens's own line and pi-tps's notices went
   * missing.
   */
  let footerStatuses: ReadonlyMap<string, string> | null = null;

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
  function buildFacts(ctx: FooterContext, pi: FooterAPI, stats: Stats): bar.BarFacts {
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
    // pi-lens's verdict and pi-viz's mode, and every other extension's words, lead the right cluster:
    // `lens ✓` when every analyzed file is clean, `lens 2E 1W` when not.
    const statuses = footerStatuses ?? new Map<string, string>();
    const words: bar.Form[] = [];
    if (lensAnalyzed && enabled('lens')) {
      const { errors, warnings } = lensTotals();
      const verdict = [errors > 0 ? `${errors}E` : '', warnings > 0 ? `${warnings}W` : ''].filter(Boolean).join(' ');
      words.push([['lens', 'dim'], [' '], [verdict || '\u2713', errors > 0 ? 'bad' : warnings > 0 ? 'warn' : 'ok']]);
    }
    if (capturedViz && enabled('viz')) words.push([['viz', 'dim'], [' '], [capturedViz, 'value']]);
    if (enabled('statuses'))
      for (const [key, value] of statuses)
        if (!DUPLICATE_STATUS_KEYS.has(key) && value.trim()) words.push([[value.trim(), 'value']]);
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
      // pi has no usage window: what the provider reported (`$0.420`), else our list price for the models the session ran
      // on (`~$0.420`).
      quota:
        enabled('cost') && stats.totals.priced
          ? { text: `${stats.totals.estimated ? '~' : ''}$${formatCost(stats.totals.cost)}` }
          : undefined,
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
  // Hide pi-tps's measurements from the chat; the footer no longer shows them.
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
      usage = ctx.getContextUsage();
    view = {
      ...ctx,
      model: ctx.model ? { ...ctx.model } : undefined,
      sessionManager: { ...ctx.sessionManager, getCwd: () => cwd },
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
    const text = bar.renderBar(buildFacts(view, pi, stats), width).line;
    return host.visibleWidth(text) > width ? host.truncateToWidth(text, width, '') : text;
  }
  function stop() {
    const ctx = current;
    mounted = false;
    current = null;
    view = null;
    repaint = null;
    stats = undefined;
    footerStatuses = null;
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
      const statuses = () => {
        try {
          footerStatuses = data.getExtensionStatuses();
        } catch {
          footerStatuses = null;
        }
      };
      statuses();
      return {
        render(width) {
          statuses();
          const text = line(width);
          return text ? [text] : [];
        },
        invalidate() {},
        dispose() {
          if (current === ctx) footerStatuses = null;
        },
      };
    });
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
    /** A run is over: the bar's two display keys may have changed since the footer mounted. */
    settled() {
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
