import { providerMark } from '../../render/providers.js';
/**
 * p10k-band — a Powerlevel10k-style status band embedded in the input box.
 *
 * The band is not a row of its own: it occupies the left part of the editor's
 * top border, the border rule continues to the right edge and the working
 * spinner sits at the end. One row, one frame:
 *
 *   ────────────────────────── ⠋ Thinking… ▐ ctx 42% ▶ cache 99% ▶ 12.3 t/s ▶ 5.2s ▶ $0.42 ▶─
 *     the message being typed
 *   ────────────────────────────────────────────────────────────────────────────────────────
 *   DeepSeek V4.1 Flash 1017 · max · ~/projects/example · main +1 ?3 · mcp 2 · skill 5
 *
 * The layout is omp's `claude` composer (packages/tui/src/components/composer/
 * claude.ts), with our coloured band in place of its plain status chip:
 *
 *   - top rule, with the band docked at its RIGHT end and one dash after it,
 *   - the input rows,
 *   - a full-width bottom rule (the composer's underline),
 *   - the bottom-left bar: model, thinking level, path and git as dim text.
 *
 * Real powerline rendering, not "colored text with an arrow between it":
 * every segment paints its own background, and the separator is drawn with the
 * previous segment's background as *foreground* on the next segment's
 * background, so the band reads as one continuous ribbon. The last arrow is
 * drawn on the terminal background, so the ribbon fades into the border rule.
 *
 * The rule uses the theme's `borderMuted` and the identity line the theme's
 * `muted`, so the band reads as a neutral frame around a colored ribbon instead
 * of a p10k band floating above a thinking-level-colored box.
 *
 * Colors are ANSI indices from the source p10k prompt, not fixed hex, so the band inherits
 * the terminal palette exactly like the zsh prompt does. They live in
 * `PALETTES`; select one with PI_HUD_PALETTE=<name>.
 *
 * The model name is prefixed with its provider's mark in the provider's own
 * colour (`PROVIDERS`), the way toktrack marks a subscription. Marks that only
 * exist in newer Nerd Fonts are avoided; PI_HUD_MARKS=ascii falls back to the
 * provider's initial for a terminal without icon glyphs.
 *
 * Layout (left → right), dropped from the right as the terminal narrows:
 *   model · thinking · path · git · context% · cache% · tokens · t/s · TTFT · cost
 *
 * The dim identity line under the input carries model · thinking · path · git ·
 * mcp · skill · lens. The `lens` chip is pi-lens's analysis verdict: it takes
 * the place of the widget line pi-lens would otherwise draw below the editor,
 * so the footer stays one row.
 *
 * The band's own order is session name · context% · cache% · tokens · t/s ·
 * TTFT · cost · time. The name comes from the session-title extension (or
 * /rename) and leads the ribbon, so the band says what the session is about
 * before it says how it is doing.
 *
 * TPS and TTFT come from the `tps` entries @monotykamary/pi-tps appends to the
 * session; the measurement stays in that package. They are read from the
 * session, not only from its `tps:telemetry` event, so a missed event or a
 * resumed session cannot leave them empty. The cache hit rate is derived from
 * the usage pi attaches to messages: cached reads against every prompt token.
 *
 * The rate segments are always present — the last measurement, or a placeholder
 * before the first one — so a burst delivery cannot reflow the band.
 */

import { execFile } from 'node:child_process';
import { footerConfigPath, loadFooterSettings, saveFooterSettings } from './footer-settings.js';
import type { FooterAPI, FooterContext, FooterHost, FooterTui } from './footer-host.js';
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
  const { CustomEditor, visibleWidth, truncateToWidth } = host;
  // ─── Glyphs ─────────────────────────────────────────────────────────────────

  const ARROW = '\ue0b0'; // right-pointing triangle: previous bg → next bg
  const CAP_LEFT = '\ue0b6'; // left half circle: soft cap on the terminal background
  const RULE = '\u2500'; // box-drawing horizontal: the rest of the top border
  /** Narrowest band worth drawing: cap, one block, fading arrow. */
  const MIN_BAND = 6;

  const ICON = {
    model: '\uec19',
    path: '\uf115',
    git: '\uf126',
    tps: '\uf0e7',
    ttft: '\uf017',
    time: '\uf252',
    cost: '\uf155',
  };

  // ─── Palettes (ANSI indices, mirroring the source p10k prompt) ─────────────────────────

  interface Paint {
    /** 256-color background index. */
    bg: number;
    /** 256-color foreground index. */
    fg: number;
  }

  interface Palette {
    label: string;
    segments: {
      model: Paint;
      thinking: Paint;
      path: Paint;
      gitClean: Paint;
      gitDirty: Paint;
      /** The generated session name: the band's leftmost block. */
      title: Paint;
      context: Paint;
      contextWarn: Paint;
      contextError: Paint;
      cache: Paint;
      tokens: Paint;
      tps: Paint;
      ttft: Paint;
      time: Paint;
      cost: Paint;
    };
  }

  /** The palette currently in use, kept verbatim from the source p10k prompt. */
  const P10K: Palette = {
    label: 'p10k (zsh prompt)',
    segments: {
      /** POWERLEVEL9K_OS_ICON_BACKGROUND=7 / _FOREGROUND=232 */
      model: { bg: 7, fg: 232 },
      /** Light block + dark text: white on a dark magenta was unreadable. */
      thinking: { bg: 175, fg: 235 },
      /** POWERLEVEL9K_DIR_BACKGROUND=4, lightened so the block reads on black. */
      path: { bg: 110, fg: 235 },
      /** POWERLEVEL9K_VCS_CLEAN_BACKGROUND=2, lightened */
      gitClean: { bg: 108, fg: 235 },
      /** POWERLEVEL9K_VCS_MODIFIED_BACKGROUND=3, amber */
      gitDirty: { bg: 179, fg: 235 },
      /** No p10k counterpart: pale lavender, so the name reads before the gauges. */
      title: { bg: 183, fg: 235 },
      /** POWERLEVEL9K_ASDF_POSTGRES_BACKGROUND=6, lightened */
      context: { bg: 116, fg: 235 },
      /** POWERLEVEL9K_COMMAND_EXECUTION_TIME_BACKGROUND=3, amber */
      contextWarn: { bg: 179, fg: 235 },
      /** POWERLEVEL9K_STATUS_ERROR_BACKGROUND=1, lightened */
      contextError: { bg: 204, fg: 235 },
      /** No p10k counterpart: a pale blue-grey between the cyan and orange. */
      cache: { bg: 152, fg: 235 },
      /** No p10k counterpart: pale periwinkle for the session token total. */
      tokens: { bg: 146, fg: 235 },
      /** ASDF_RUST_BACKGROUND=208, but 208 is glare: 173 keeps the hue, calmer. */
      tps: { bg: 173, fg: 235 },
      /** VCS_LOADING_BACKGROUND=8 with fg 0 is unreadable: light grey, dark text. */
      ttft: { bg: 250, fg: 235 },
      /** Session working time: pale khaki, the quietest block. */
      time: { bg: 187, fg: 235 },
      /** POWERLEVEL9K_COMMAND_EXECUTION_TIME_BACKGROUND=3, amber */
      cost: { bg: 179, fg: 235 },
    },
  };

  /** Warm, low-saturation: olive/sage blocks on a dark terminal. */
  const GRUGBOX: Palette = {
    label: 'gruvbox',
    segments: {
      model: { bg: 223, fg: 235 },
      thinking: { bg: 108, fg: 235 },
      path: { bg: 66, fg: 230 },
      gitClean: { bg: 100, fg: 235 },
      gitDirty: { bg: 172, fg: 235 },
      title: { bg: 181, fg: 235 },
      context: { bg: 109, fg: 235 },
      contextWarn: { bg: 172, fg: 235 },
      contextError: { bg: 124, fg: 230 },
      cache: { bg: 24, fg: 230 },
      tokens: { bg: 175, fg: 235 },
      tps: { bg: 137, fg: 230 },
      time: { bg: 180, fg: 235 },
      ttft: { bg: 239, fg: 223 },
      cost: { bg: 172, fg: 235 },
    },
  };

  /** Cool and desaturated: frost blues with aurora accents. */
  const NORD: Palette = {
    label: 'nord',
    segments: {
      model: { bg: 223, fg: 236 },
      thinking: { bg: 175, fg: 236 },
      path: { bg: 110, fg: 236 },
      gitClean: { bg: 108, fg: 236 },
      gitDirty: { bg: 179, fg: 236 },
      title: { bg: 181, fg: 236 },
      context: { bg: 109, fg: 236 },
      contextWarn: { bg: 179, fg: 236 },
      contextError: { bg: 131, fg: 223 },
      cache: { bg: 66, fg: 230 },
      tokens: { bg: 139, fg: 230 },
      tps: { bg: 173, fg: 236 },
      time: { bg: 187, fg: 236 },
      ttft: { bg: 238, fg: 223 },
      cost: { bg: 179, fg: 236 },
    },
  };

  /** Blue-violet: indigo blocks with a peach rate segment. */
  const TOKYO: Palette = {
    label: 'tokyo-night',
    segments: {
      model: { bg: 189, fg: 235 },
      thinking: { bg: 141, fg: 235 },
      path: { bg: 111, fg: 235 },
      gitClean: { bg: 114, fg: 235 },
      gitDirty: { bg: 179, fg: 235 },
      title: { bg: 183, fg: 235 },
      context: { bg: 117, fg: 235 },
      contextWarn: { bg: 179, fg: 235 },
      contextError: { bg: 204, fg: 235 },
      cache: { bg: 68, fg: 235 },
      tokens: { bg: 152, fg: 235 },
      tps: { bg: 215, fg: 235 },
      time: { bg: 187, fg: 235 },
      ttft: { bg: 238, fg: 223 },
      cost: { bg: 179, fg: 235 },
    },
  };

  const PALETTES: Record<string, Palette> = {
    p10k: P10K,
    gruvbox: GRUGBOX,
    nord: NORD,
    'tokyo-night': TOKYO,
  };

  const PALETTE = PALETTES[env.PI_HUD_PALETTE ?? ''] ?? P10K;
  const PAINT = PALETTE.segments;

  const RESET = '\x1b[0m';

  function fgAnsi(index: number): string {
    return `\x1b[38;5;${index}m`;
  }

  function bgAnsi(index: number): string {
    return `\x1b[48;5;${index}m`;
  }

  // ─── Segments ───────────────────────────────────────────────────────────────

  /** Where a segment is drawn: the coloured band, or the dim identity line. */
  type Group = 'band' | 'footer';

  interface Segment extends Paint {
    text: string;
    /** Higher survives narrow terminals longer. */
    priority: number;
    /** Narrower replacements, consumed in order before the segment is dropped. */
    variants: string[];
    group: Group;
    /** Identity line only: paint this segment in a 256-colour index. */
    color?: number;
    /** Identity line only: sit tight against the previous segment, no separator. */
    glue?: boolean;
  }

  // ─── Which segments exist, and which are on ────────────────────────────────

  /**
   * Every toggleable segment. `group` says which zone it belongs to: `band` is
   * the ribbon docked at the right end of the editor's top rule, `footer` is the
   * dim identity line under the input.
   *
   * The order here is the order `/hud` lists them and the order the config file
   * writes them, not the drawing order — that still comes from the `add()` calls
   * in `buildSegments`.
   */
  const SEGMENT_SPECS = {
    // Bottom-left identity line.
    model: { group: 'footer', label: 'model name + provider mark', on: true },
    thinking: { group: 'footer', label: 'thinking level', on: true },
    path: { group: 'footer', label: 'working directory', on: true },
    git: { group: 'footer', label: 'git branch + dirty marks', on: true },
    mcp: { group: 'footer', label: 'loaded MCP server count', on: true },
    skill: { group: 'footer', label: 'loaded skill count', on: true },
    lens: { group: 'footer', label: 'pi-lens verdict', on: true },
    viz: { group: 'footer', label: 'pi-viz diagram mode', on: true },
    statuses: { group: 'footer', label: 'other extensions setStatus() values', on: true },
    // Top-right band.
    session: { group: 'band', label: 'session name', on: true },
    context: { group: 'band', label: 'context window usage', on: true },
    cache: { group: 'band', label: 'prompt cache hit rate', on: true },
    tokens: { group: 'band', label: 'session token total', on: true },
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

  /** One block: a space, the text, a space. */
  function blockWidth(text: string): number {
    return visibleWidth(text) + 2;
  }

  /** A soft cap on the left, one arrow between neighbours, one fading arrow last. */
  function bandWidth(segments: Segment[]): number {
    if (segments.length === 0) return 0;
    return 1 + segments.reduce((sum, s) => sum + blockWidth(s.text), 0) + segments.length;
  }

  /**
   * Consume shorter variants, then drop the lowest-priority segments, until the
   * band fits. Never drops the last remaining segment: it is truncated instead.
   */
  function fitSegments(segments: Segment[], width: number): Segment[] {
    const kept = segments.map((segment) => ({ ...segment, variants: [...segment.variants] }));

    while (kept.length > 1 && bandWidth(kept) > width) {
      let variantIndex = -1;
      for (let i = 0; i < kept.length; i++) {
        const segment = kept[i]!;
        const next = segment.variants[0];
        if (next === undefined || visibleWidth(next) >= visibleWidth(segment.text)) continue;
        if (variantIndex < 0 || segment.priority < kept[variantIndex]!.priority) variantIndex = i;
      }
      if (variantIndex >= 0) {
        const segment = kept[variantIndex]!;
        segment.text = segment.variants.shift()!;
        continue;
      }

      let drop = -1;
      for (let i = 0; i < kept.length; i++) {
        if (drop < 0 || kept[i]!.priority < kept[drop]!.priority) drop = i;
      }
      kept.splice(drop, 1);
    }

    return kept;
  }

  /** Paint the ribbon. Every escape is closed, so the line never leaks state. */
  function paintBand(fitted: Segment[], width: number): string {
    if (fitted.length === 0) return '';

    // The last block may still overflow on a very narrow terminal.
    const overflow = bandWidth(fitted) - width;
    if (overflow > 0) {
      const last = fitted[fitted.length - 1]!;
      const room = Math.max(1, visibleWidth(last.text) - overflow);
      last.text = truncateToWidth(last.text, room, '…');
    }

    let out = RESET + fgAnsi(fitted[0]!.bg) + CAP_LEFT;
    for (let i = 0; i < fitted.length; i++) {
      const segment = fitted[i]!;
      out += bgAnsi(segment.bg) + fgAnsi(segment.fg) + ` ${segment.text} `;
      const next = fitted[i + 1];
      // The last arrow is drawn on the terminal background, so the ribbon fades
      // into the border rule that follows it.
      out += next ? bgAnsi(next.bg) + fgAnsi(segment.bg) + ARROW : RESET + fgAnsi(segment.bg) + ARROW;
    }
    return out + RESET;
  }

  const IDENTITY_SEP = ' \u00b7 '; // " · "

  /**
   * The identity line under the input: model, thinking level, path and git as
   * plain muted text. Same idea as omp's `claude` composer, which docks its left
   * segments at the bottom-left instead of crowding the status band.
   */
  function paintIdentity(segments: Segment[], width: number, frame: Frame): string {
    const kept = [...segments];
    const joined = (list: Segment[]) =>
      list.map((segment, i) => (i === 0 || segment.glue ? '' : IDENTITY_SEP) + segment.text).join('');

    while (kept.length > 1 && visibleWidth(joined(kept)) > width) {
      let drop = 0;
      for (let i = 1; i < kept.length; i++) {
        if (kept[i]!.priority < kept[drop]!.priority) drop = i;
      }
      kept.splice(drop, 1);
    }

    // Painted segment by segment, so a provider mark keeps its own colour while
    // the rest of the line stays dim.
    let out = '';
    let used = 0;
    for (let i = 0; i < kept.length; i++) {
      const segment = kept[i]!;
      const room = width - used;
      if (room <= 0) break;
      const sep = i === 0 || segment.glue ? '' : IDENTITY_SEP;
      const sepText = visibleWidth(sep) <= room ? sep : '';
      const textRoom = room - visibleWidth(sepText);
      const text =
        visibleWidth(segment.text) <= textRoom ? segment.text : truncateToWidth(segment.text, textRoom, '\u2026');
      out += frame.fg('muted', sepText);
      out += segment.color === undefined ? frame.fg('muted', text) : `${fgAnsi(segment.color)}${text}${RESET}`;
      used += visibleWidth(sepText) + visibleWidth(text);
      if (text !== segment.text) break;
    }

    return out + ' '.repeat(Math.max(0, width - used));
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

  /** Provider-reported cost when there is one, else our own list price. */
  function entryCost(usage: EntryUsage, modelId: string | undefined): number | null {
    const reported = usage.cost?.total;
    if (typeof reported === 'number' && reported > 0) return reported;
    const price = priceFor(modelId);
    if (!price) return null;
    const rate = (value: number | undefined) => (value ?? 0) / 1_000_000;
    return (
      usage.input * rate(price.input) +
      usage.output * rate(price.output) +
      usage.cacheRead * rate(price.cacheRead ?? price.input) +
      usage.cacheWrite * rate(price.input)
    );
  }

  interface Stats {
    sessionId: string;
    leafId: string | null;
    totals: UsageTotals;
    /** Wall clock spent inside turns, summed from the per-turn telemetry. */
    activeMs: number;
  }

  /** Cumulative usage over the whole session, rescanned only when the leaf moves. */
  function computeStats(ctx: FooterContext): Stats {
    const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, priced: false };
    let activeMs = 0;
    // Entries after a message inherit its model: `usage` entries and summaries
    // carry no model of their own.
    let modelId: string | undefined = ctx.model?.id;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === 'custom' && entry.customType === 'tps') {
        const data = entry.data as (TpsTelemetry & { model?: { modelId?: string } }) | undefined;
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
      const cost = entryCost(usage, modelId);
      if (cost !== null) {
        totals.cost += cost;
        totals.priced = true;
      }
    }
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId(),
      totals,
      activeMs,
    };
  }

  /** `1M`, `1.5M`, `200k`, `37.6M`: one decimal only when it carries information. */
  function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${Number((count / 1000).toFixed(1))}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    if (count < 100000000) return `${Number((count / 1000000).toFixed(1))}M`;
    return `${Math.round(count / 1000000)}M`;
  }

  function cwdDisplay(cwd: string): string {
    const home = env.HOME ?? env.USERPROFILE;
    if (!home) return cwd;
    if (cwd === home) return '~';
    if (cwd.startsWith(home + '/')) return `~${cwd.slice(home.length)}`;
    return cwd;
  }

  function basename(path: string): string {
    const trimmed = path.replace(/\/+$/, '');
    const index = trimmed.lastIndexOf('/');
    return index < 0 ? trimmed : trimmed.slice(index + 1);
  }

  /** `DeepSeek V4.1 Flash 1017 (Mistral)` → `DeepSeek V4.1 Flash 1017`. */
  function compactModelName(name: string): string {
    return name.replace(/\s*\([^)]*\)\s*$/, '').trim() || name;
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

  // ─── Telemetry (from @monotykamary/pi-tps) ──────────────────────────────────

  interface TpsTelemetry {
    tps?: number | null;
    timing?: { ttftMs?: number | null; totalMs?: number | null } | null;
  }

  interface Rates {
    tps: number | null;
    ttftMs: number | null;
  }

  let rates: Rates = { tps: null, ttftMs: null };
  /** Start of the turn that is running, so its time counts before it ends. */
  let turnStartedAt: number | null = null;
  /** Leaf the rates were read at; `undefined` forces a re-read on the next paint. */
  let ratesLeaf: string | null | undefined;

  function readRates(telemetry: TpsTelemetry | null | undefined): Rates {
    const tps = telemetry?.tps;
    const ttft = telemetry?.timing?.ttftMs;
    return {
      tps: typeof tps === 'number' && Number.isFinite(tps) && tps > 0 ? tps : null,
      ttftMs: typeof ttft === 'number' && Number.isFinite(ttft) && ttft >= 0 ? ttft : null,
    };
  }

  /**
   * Keep the last measurement when the new one is empty (burst delivery reports
   * no rate). Both rate segments stay in the band, so the band keeps its width
   * instead of reflowing on every burst.
   */
  function rememberRates(next: Rates): void {
    rates = { tps: next.tps ?? rates.tps, ttftMs: next.ttftMs ?? rates.ttftMs };
  }

  /**
   * The newest measurement on the active branch, read from the session rather
   * than only from `tps:telemetry`: a missed event or a resumed session would
   * otherwise leave the rate segments empty. The scan stops at the first `tps`
   * entry and only runs when the leaf moved, so it costs nothing per paint.
   */
  function refreshRates(ctx: FooterContext): Rates {
    const leafId = ctx.sessionManager.getLeafId();
    if (ratesLeaf === leafId) return rates;
    ratesLeaf = leafId;

    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== 'custom' || entry.customType !== 'tps') continue;
      rememberRates(readRates(entry.data as TpsTelemetry));
      break;
    }
    return rates;
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

  /** Identity-line colours: the palette's own green, amber and red. */
  const LENS_CLEAN_COLOR = 108;
  const LENS_WARN_COLOR = 179;
  const LENS_ERROR_COLOR = 204;

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

  /** Red as soon as anything is an error, amber for warnings alone, else green. */
  function lensColor(errors: number, warnings: number): number {
    if (errors > 0) return LENS_ERROR_COLOR;
    if (warnings > 0) return LENS_WARN_COLOR;
    return LENS_CLEAN_COLOR;
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

  /** The session name, if this build of pi has one and it is set. */
  function readSessionName(ctx: FooterContext): string | undefined {
    try {
      const name = ctx.sessionManager.getSessionName?.();
      return name && name.trim() ? name.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  function formatMs(ms: number): string {
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
  }

  /** `$0.0423` for pocket change, `$1.24` once it is real money. */
  function formatCost(cost: number): string {
    if (cost >= 100) return cost.toFixed(1);
    if (cost >= 1) return cost.toFixed(2);
    if (cost >= 0.01) return cost.toFixed(3);
    return cost.toFixed(4);
  }

  /** `4:02` under an hour, `1:23:45` above it. */
  function formatDuration(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    const pad = (value: number) => value.toString().padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
  }

  // ─── Segment assembly ───────────────────────────────────────────────────────

  /**
   * setStatus() keys that only repeat a segment we already draw. `mcp` is
   * pi-mcp-adapter's chip for the same server count, and pi-lens publishes its
   * verdict under `pi-lens-lsp` (older builds: `pi-lens`/`lens`). Letting them
   * through `statuses` would double the line for no information.
   */
  const DUPLICATE_STATUS_KEYS = new Set(['mcp', 'lens', 'pi-lens', 'pi-lens-lsp']);

  function buildSegments(
    ctx: FooterContext,
    pi: FooterAPI,
    stats: Stats,
    _repaint: () => void,
    withIcons: boolean
  ): Segment[] {
    const segments: Segment[] = [];
    const icon = (glyph: string) => (withIcons ? `${glyph} ` : '');
    // The id names the segment in the config; the zone comes from the spec, so a
    // segment cannot be filed under the wrong group by a call site.
    const add = (
      id: SegmentId,
      paint: Paint,
      text: string,
      priority: number,
      variants: string[] = [],
      extra: { color?: number; glue?: boolean } = {}
    ) => {
      if (!enabled(id)) return;
      if (!text || visibleWidth(text) === 0) return;
      segments.push({ ...paint, text, priority, variants, group: SEGMENT_SPECS[id].group, ...extra });
    };
    const shorten = (text: string, max: number) => truncateToWidth(text, max, '…');

    // Model: the provider's mark in its own colour, glued to the name. The
    // parenthetical is dropped and the name is truncated last.
    const model = ctx.model;
    if (model) {
      const mark = providerMark(model, env.PI_HUD_MARKS === 'ascii');
      const name = compactModelName(model.name || model.id);
      // The mark keeps a space of its own, so an emoji mark does not touch the name.
      add('model', PAINT.model, mark ? `${mark.glyph} ` : icon(ICON.model), 8, [], {
        color: mark?.color,
      });
      add(
        'model',
        PAINT.model,
        name,
        9,
        [shorten(name, 16), shorten(model.id, 12)].filter((variant) => visibleWidth(variant) < visibleWidth(name)),
        { glue: true }
      );
    } else {
      add('model', PAINT.model, `${icon(ICON.model)}no-model`, 9);
    }

    // Thinking level, only when the active model reasons.
    const thinking = model?.reasoning ? pi.getThinkingLevel?.() : undefined;
    if (thinking && thinking !== 'off') {
      add('thinking', PAINT.thinking, thinking, 8);
    }

    // Working directory: full path, then basename.
    const cwd = ctx.sessionManager.getCwd();
    const display = cwdDisplay(cwd);
    const shortPath = basename(display);
    add(
      'path',
      PAINT.path,
      `${icon(ICON.path)}${display}`,
      7,
      [`${icon(ICON.path)}${shortPath}`].filter(
        (variant) => visibleWidth(variant) < visibleWidth(`${icon(ICON.path)}${display}`)
      )
    );

    // Git branch plus dirty markers, colored when the tree is not clean.
    const git = readGit(cwd);
    if (git?.branch) {
      const marks: string[] = [];
      if (git.staged) marks.push(`+${git.staged}`);
      if (git.unstaged) marks.push(`*${git.unstaged}`);
      if (git.untracked) marks.push(`?${git.untracked}`);
      const dirty = marks.length > 0;
      const label = `${git.branch}${dirty ? ` ${marks.join(' ')}` : ''}`;
      add(
        'git',
        dirty ? PAINT.gitDirty : PAINT.gitClean,
        `${icon(ICON.git)}${label}`,
        6,
        [`${icon(ICON.git)}${shorten(label, 16)}`].filter(
          (variant) => visibleWidth(variant) < visibleWidth(`${icon(ICON.git)}${label}`)
        )
      );
    }

    // Loaded MCP servers and skills, on the dim bottom-left bar after git.
    const loaded = capturedLoaded;
    add('mcp', PAINT.model, `mcp ${loaded.mcp}`, 5);
    add('skill', PAINT.model, `skill ${loaded.skills}`, 4);

    // pi-lens's verdict, where its own widget line used to sit: `lens ✓` when
    // every analyzed file is clean, `lens 2E 1W` when it is not. Absent until
    // the session has analyzed something, so a session that never touches a file
    // does not advertise an analyzer with nothing to say.
    if (lensAnalyzed) {
      const { errors, warnings } = lensTotals();
      const marks: string[] = [];
      if (errors > 0) marks.push(`${errors}E`);
      if (warnings > 0) marks.push(`${warnings}W`);
      const verdict = marks.length === 0 ? '\u2713' : marks.join(' ');
      add('lens', PAINT.model, `lens ${verdict}`, 3, [], { color: lensColor(errors, warnings) });
    }

    // pi-viz's mode, read from the session so the chip survives a resume. It
    // replaces the widget line pi-viz would otherwise draw below the editor.
    const vizMode = capturedViz;
    if (vizMode) {
      add('viz', PAINT.model, `viz ${vizMode}`, 3);
    }

    // Everything else an extension published with setStatus(). Keys that only
    // repeat a segment above are skipped, so a status cannot double the line.
    if (footerStatuses && footerStatuses.size > 0) {
      const others = [...footerStatuses.entries()]
        .filter(([key]) => !DUPLICATE_STATUS_KEYS.has(key))
        .map(([, value]) => value.trim())
        .filter((value) => value.length > 0);
      if (others.length > 0) {
        add(
          'statuses',
          PAINT.model,
          others.join(' '),
          2,
          [others.slice(0, 2).join(' ')].filter((variant) => visibleWidth(variant) < visibleWidth(others.join(' ')))
        );
      }
    }

    // Session name: generated by the session-title extension, or set with
    // /rename. It leads the ribbon, so the band answers "what is this session"
    // before it answers "how is it doing".
    const sessionName = readSessionName(ctx);
    if (sessionName) {
      add(
        'session',
        PAINT.title,
        sessionName,
        7,
        [shorten(sessionName, 18), shorten(sessionName, 12)].filter(
          (variant) => visibleWidth(variant) < visibleWidth(sessionName)
        )
      );
    }

    // Context pressure: cyan, amber above 70%, red above 90%.
    const usage = ctx.getContextUsage();
    const window = usage?.contextWindow ?? model?.contextWindow ?? 0;
    // Two adjacent percentages need words, not icons: a gauge and a database are
    // indistinguishable at a glance. Both drop the label on narrow terminals.
    if (usage && usage.percent !== null) {
      const paint = usage.percent > 90 ? PAINT.contextError : usage.percent > 70 ? PAINT.contextWarn : PAINT.context;
      const percent = `${usage.percent.toFixed(1)}%`;
      // `1.1%/1M`: the share used and the window it is a share of.
      add('context', paint, window > 0 ? `${percent}/${formatTokens(window)}` : percent, 9, [percent]);
    } else if (window > 0) {
      add('context', PAINT.context, `?/${formatTokens(window)}`, 9, ['?']);
    }

    // Prompt-cache hit rate over the whole session: cached reads against every
    // prompt token the model saw (uncached input + cache reads + cache writes).
    const { totals } = stats;
    const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
    const cacheText = promptTokens > 0 ? `${Math.round((totals.cacheRead / promptTokens) * 100)}%` : '-';
    add('cache', PAINT.cache, `cache ${cacheText}`, 7, [cacheText]);

    // Session token total: every prompt and completion token, cache included.
    const totalTokens = promptTokens + totals.output;
    const tokensText = totalTokens > 0 ? formatTokens(totalTokens) : '-';
    add('tokens', PAINT.tokens, `tok ${tokensText}`, 7, [tokensText]);

    // Live rates. Both segments are always present: the last measurement, or a
    // placeholder before the first one, so the band never reflows mid-stream.
    const tpsText = rates.tps === null ? '-' : `${rates.tps.toFixed(1)} t/s`;
    add('tps', PAINT.tps, `${icon(ICON.tps)}${tpsText}`, 8, [tpsText]);
    const ttftText = rates.ttftMs === null ? '-' : formatMs(rates.ttftMs);
    add('ttft', PAINT.ttft, `${icon(ICON.ttft)}${ttftText}`, 5, [ttftText]);

    // Session cost: what the provider reported, else our list price for the
    // models the session ran on. Always present, so the band keeps its width.
    const costText = totals.priced ? `$${formatCost(totals.cost)}` : '-';
    add('cost', PAINT.cost, `${icon(ICON.cost)}${costText}`, 4, [costText]);

    // Session working time: the wall clock spent inside turns, plus the turn that
    // is running right now.
    const elapsed = stats.activeMs + (turnStartedAt === null ? 0 : Math.max(0, Date.now() - turnStartedAt));
    const duration = formatDuration(elapsed);
    add('time', PAINT.time, `${icon(ICON.time)}${duration}`, 4, [duration]);

    return segments;
  }

  // ─── Editor ─────────────────────────────────────────────────────────────────

  interface Frame {
    fg(token: string, text: string): string;
  }

  interface StatusLike {
    renderInBorder(width: number): string;
  }

  /**
   * The stock editor with the band painted into its top border. Everything else —
   * keybindings, autocomplete, paste handling, focus, cursor — is inherited, so
   * the app's editor features keep working.
   */
  class BandEditor extends CustomEditor {
    private readonly band: (width: number) => string;
    private readonly identity: (width: number) => string;
    private readonly frame: Frame;
    private status: StatusLike | null = null;

    constructor(
      tui: FooterTui,
      theme: unknown,
      keybindings: unknown,
      options: { embedWorkingStatus: boolean },
      band: (width: number) => string,
      identity: (width: number) => string,
      frame: Frame
    ) {
      super(tui, theme, keybindings, options);
      this.band = band;
      this.identity = identity;
      this.frame = frame;
    }

    override setWorkingStatusIndicator(
      indicator: Parameters<InstanceType<FooterHost['CustomEditor']>['setWorkingStatusIndicator']>[0]
    ): void {
      super.setWorkingStatusIndicator(indicator);
      this.status = (indicator as StatusLike | undefined) ?? null;
    }

    override renderTopBorder(width: number, hiddenLineCount: number): string {
      if (width <= 0) return '';
      // The working indicator keeps pi's own place: `── ⠋ Working…` at the left
      // end of the top border. Only the band moved to the right end.
      const status = this.leftSlot(width);
      const statusWidth = status ? visibleWidth(status) + 4 : 0;
      const right = this.rightSlot(width, hiddenLineCount);
      const rightWidth = right ? visibleWidth(right) + 1 : 0;
      // One column is reserved for the dash that closes the rule after the band.
      const room = Math.max(1, width - statusWidth - rightWidth - 1);
      // Below the width of a single block there is no band left to draw.
      const band = room >= MIN_BAND ? this.band(room) : '';
      const tail = band ? 1 : 0;
      const ruleWidth = Math.max(0, width - statusWidth - rightWidth - visibleWidth(band) - tail);
      const rule = ruleWidth > 0 ? this.frame.fg('borderMuted', RULE.repeat(ruleWidth)) : '';
      const tailRule = tail ? this.frame.fg('borderMuted', RULE) : '';
      const head = status ? `${this.frame.fg('borderMuted', `${RULE}${RULE} `)}${status} ` : '';
      return head + rule + (right ? `${right} ` : '') + band + tailRule;
    }

    /**
     * The editor's bottom border becomes the composer's underline, and the dim
     * bottom-left bar goes under it — omp's `claude` composer puts its left
     * segments there.
     */
    override render(width: number): string[] {
      const lines = super.render(width);
      if (width <= 0 || lines.length === 0) return lines;

      // Set by the base render pass; without it the row layout is unknown.
      // SAFETY: pi's base Editor sets this internal layout count during super.render.
      const visible = (this as unknown as { renderedVisibleLineCount?: number }).renderedVisibleLineCount;
      if (typeof visible !== 'number') return lines;

      // The bottom border follows the visible rows; autocomplete rows come after.
      const bottom = 1 + visible;
      if (bottom <= 0 || bottom >= lines.length) return lines;
      // The composer's underline, then the dim bottom-left bar.
      const underline = this.frame.fg('borderMuted', RULE.repeat(width));
      return [...lines.slice(0, bottom), underline, this.identity(width), ...lines.slice(bottom + 1)];
    }

    /** The working spinner while a turn runs, else the scroll hint. */
    /** `⠋ Working…`, or nothing when it does not fit next to the band. */
    private leftSlot(width: number): string {
      if (!this.status) return '';
      try {
        const status = this.status.renderInBorder(Math.max(1, Math.min(width - 8, 48)));
        if (!status) return '';
        // `── ` before it and a space after it, as pi's own editor draws it.
        return visibleWidth(status) + 4 <= width ? status : '';
      } catch {
        // A disposed indicator must not take the border down with it.
        return '';
      }
    }

    /** The scroll hint, docked just left of the band. */
    private rightSlot(width: number, hiddenLineCount: number): string {
      if (hiddenLineCount > 0 && width >= 16) {
        const hint = truncateToWidth(`↑ ${hiddenLineCount} more`, width - 2, '');
        return this.frame.fg('borderMuted', hint);
      }
      return '';
    }
  }

  let current: FooterContext | null = null;
  let view: FooterContext | null = null;
  let stats: Stats | undefined;
  let capturedViz: string | undefined;
  let capturedLoaded: LoadedCounts = { mcp: 0, skills: 0 };
  let repaint: (() => void) | null = null;
  let mounted = false;
  let widget = false;
  let live = true;
  const removers: (() => void)[] = [];
  pi.registerEntryRenderer?.('tps', () => undefined);
  function listen(name: string, handler: (data: unknown) => void) {
    const remove = pi.events?.on(name, (data) => {
      if (live) handler(data);
    });
    if (remove) removers.push(remove);
  }
  listen('tps:telemetry', (data) => {
    rememberRates(readRates(data as TpsTelemetry));
    ratesLeaf = undefined;
    update();
  });
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
    refreshRates(ctx);
    capturedViz = readVizMode(ctx);
    capturedLoaded = loadedCounts(pi);
    const cwd = ctx.sessionManager.getCwd(),
      name = readSessionName(ctx),
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
  function band(width: number): string {
    if (!view || !stats || !mounted) return '';
    const segments = (icons: boolean) =>
      buildSegments(view!, pi, stats!, () => {}, icons).filter((s) => s.group === 'band');
    const withIcons = segments(true),
      fitted = fitSegments(withIcons, width);
    const kept = bandWidth(fitted) <= width ? withIcons : segments(false);
    return paintBand(fitSegments(kept, width), width);
  }
  function identity(width: number): string {
    if (!view || !stats || !mounted) return '';
    return paintIdentity(
      buildSegments(view, pi, stats, () => {}, true).filter((s) => s.group === 'footer'),
      width,
      current!.ui.theme
    );
  }
  function stop() {
    const ctx = current;
    mounted = false;
    current = null;
    view = null;
    repaint = null;
    stats = undefined;
    footerStatuses = null;
    if (!ctx) return;
    try {
      ctx.ui.setEditorComponent(undefined);
    } catch {
      /* TUI may be gone. */
    }
    if (widget) ctx.ui.setWidget('hud-pi-footer', undefined);
    widget = false;
    ctx.ui.setFooter(undefined);
  }
  function start(ctx: FooterContext) {
    stop();
    if (!live || ctx.mode !== 'tui' || !ctx.hasUI) return;
    current = ctx;
    mounted = true;
    config = fromSettings();
    rates = { tps: null, ttftMs: null };
    ratesLeaf = undefined;
    turnStartedAt = null;
    lensFiles.clear();
    lensAnalyzed = false;
    update();
    try {
      ctx.ui.setEditorComponent((tui, theme, keybindings) => {
        repaint = () => tui.requestRender();
        return new BandEditor(tui, theme, keybindings, { embedWorkingStatus: true }, band, identity, ctx.ui.theme);
      });
    } catch {
      widget = true;
      ctx.ui.setWidget(
        'hud-pi-footer',
        (tui) => {
          repaint = () => tui.requestRender();
          return { render: (width) => (width > 0 ? [band(width), identity(width)] : ['']), invalidate() {} };
        },
        { placement: 'aboveEditor' }
      );
    }
    ctx.ui.setFooter((_tui, _theme, data) => {
      const statuses = () => {
        try {
          footerStatuses = data.getExtensionStatuses();
        } catch {
          footerStatuses = null;
        }
      };
      statuses();
      return {
        render() {
          statuses();
          return [];
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
    turnStart(timestamp?: number) {
      if (mounted) {
        turnStartedAt = timestamp ?? Date.now();
        repaint?.();
      }
    },
    turnEnd() {
      turnStartedAt = null;
      update();
    },
    async command(args: string, ctx: FooterContext) {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const target = (id: string) => SEGMENT_IDS.includes(id as SegmentId);

      if (words.length === 0 || words[0] === 'list') {
        const lines = [
          `footer (bottom-left): ${SEGMENT_IDS.filter((id) => SEGMENT_SPECS[id].group === 'footer' && enabled(id)).join(' ') || '(empty)'}`,
          `band (top-right):     ${SEGMENT_IDS.filter((id) => SEGMENT_SPECS[id].group === 'band' && enabled(id)).join(' ') || '(empty)'}`,
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
