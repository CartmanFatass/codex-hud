/**
 * The status bar's fields, for the card at the foot of the tree panel. While
 * the panel is open it replaces the bar, so what the bar said has to be said
 * here. The card is drawn in omp's band style: a band row carrying the
 * session's state and its context meter, the brief under it behind a left
 * gutter, and a corner row with where it works and its quota meter:
 *
 *   ▕ ✓ ★◕ 41s ──────────56%──────────────246K ~3m ▏   band, on its own background
 *   │ ! 等待批准                                          alerts, only when there are any
 *   ╰─ atlas-wsl · main * 7d ──────────99% ↺113h
 *
 * Band: the session's state (while it works, the tool, the turn's clock and
 * the output rate), the model's badge and the session's age, then the
 * context meter with its window size. Corner row: where it works, the quota
 * meter, the reset countdown and, only in the minutes before it lapses, the
 * prompt-cache reminder. This module hands the monitor the parts; the
 * monitor fits them to the row, dropping the least wanted first. Every value
 * is read the way the bar reads it; a field with no data is left out rather
 * than shown as zero. The agents' counts are the panel's own job.
 */
import type { HudData } from '../types.js';
import { collectAttention, waitedText } from './attention.js';
import { colors, getMeterColor, icons, theme, truncate } from './colors.js';
import { renderModelEffortToken } from './model-glyphs.js';
import { formatTokenCount } from './lines/activity-line.js';
import { formatCountdown, readQuotaWindows } from './quota.js';
import { formatElapsedShort } from './subagent-chip.js';
import { formatTokenRate } from '../collectors/token-rate.js';
import { displayConfig } from './hud-config.js';
import { age, iconic, type EdgeMeter } from './monitor.js';
import { t } from './i18n.js';

/**
 * What the card's frame is painted by: the main session's state, or that it
 * needs the person (an approval, a failed tool or agent).
 */
export type StatusTone = 'idle' | 'working' | 'error' | 'stale' | 'needs';
/** The frame's colour for a tone; the meters keep their own. */
export function tonePaint(tone: StatusTone): (s: string) => string {
  return tone === 'working' ? theme.info : tone === 'error' ? theme.error : tone === 'stale' || tone === 'needs' ? theme.warning : colors.dim;
}

export interface StatusCard {
  tone: StatusTone;
  /** The session is working: a "needs" mark leads its state rather than replacing it. */
  busy?: boolean;
  /** Rows for the card's body: what needs a look, painted. */
  alerts: string[];
  /** The session's state: "✓ Idle", or while it works "▸ exec: npm test · 2m10s". */
  state: string;
  /** While it works only: the output rate, and the plan's progress. */
  rate: string;
  tasks: string;
  /** The model's badge and the session's age. */
  model: string;
  age: string;
  /** How full the context is, its window size closing the bar. */
  context?: EdgeMeter;
  /**
   * For the corner row: where the session works, in parts so the narrow
   * row can give up the branch, then the repository.
   */
  place: string;
  project?: string;
  repo?: string;
  branch?: string;
  /**
   * The account's tightest usage window: its meter, the window's name before
   * it ("7d", dim), a mark when the quota is spent, and `text`, the reading
   * alone for the one-line card ("7d 99%").
   */
  quota?: EdgeMeter & {window: string; spent: string; text: string};
  /** The other window's reading, a projection of running out, and the soonest reset (in the tick colour). */
  others: string;
  forecast: string;
  reset: string;
  /** The prompt-cache reminder, only in the minutes before it lapses: the rest of the time there is nothing to act on. */
  cache: string;
}

function alertLabel(label: string): string {
  const failed = label.match(/^(\d+) (tool|agent)s? failed$/);
  if (failed) return t(failed[1] === '1' ? `1 ${failed[2]} failed` : `{n} ${failed[2]}s failed`, { n: failed[1] });
  return t(label);
}

const SESSION_STATES = {
  working: ['▸', 'Working', theme.info],
  idle: ['✓', 'Idle', theme.success],
  interrupted: ['■', 'Interrupted', theme.warning],
  error: ['✗', 'Failed', theme.error],
  stale: ['?', 'Sync delayed', theme.warning],
} as const;

/**
 * What the main session is doing, in the card's own words, for the card's
 * one-line form: an approval or input it waits on, with how long it has
 * waited, wins; otherwise its state, with the turn's length while it works.
 * `attention` is true while it waits on the person, `failed` while a tool or
 * an agent has failed. Null when nothing has
 * been read. `short` is the same without its glyph, for a tight line.
 */
export function sessionState(data: HudData | null, nowMs: number = Date.now()): { text: string; short: string; attention: boolean; failed: boolean } | null {
  if (!data) return null;
  const items = collectAttention(data, nowMs);
  const waiting = items.find((item) => item.kind === 'approval');
  const failed = items.some((item) => item.severity === 'error');
  if (waiting) {
    const words = `${alertLabel(waiting.label)}${waiting.since ? ` ${waitedText(waiting.since, nowMs)}` : ''}`;
    return { text: theme.warning(`! ${words}`), short: theme.warning(words), attention: true, failed };
  }
  const status = data.stale ? 'stale' : data.activity?.state;
  if (!status) return null;
  const [glyph, word, paint] = SESSION_STATES[status];
  const started = status === 'working' ? data.activity?.turnStartedAt : undefined;
  const clock = started ? colors.dim(formatElapsedShort(started, nowMs)) : '';
  // The glyph and its word: the glyph survives without colour, the word
  // says what the glyph means.
  const words = `${paint(t(word))}${clock ? ` ${clock}` : ''}`;
  return { text: `${paint(glyph)} ${words}`, short: words, attention: false, failed };
}

/**
 * The prompt-cache reminder as the card shows it. The bar paints it red once
 * thirty minutes have passed, but on a card that stays open through a long
 * idle session that is most of the time, and nothing is left to act on: the
 * card shows it only in the minutes before it lapses (25–29m), as a warning.
 */
function cacheReminder(data: HudData, nowMs: number): string {
  const sampledAt = data.tokenUsageAt?.getTime();
  if (sampledAt === undefined || !Number.isFinite(sampledAt) || !Number.isFinite(nowMs)) return '';
  const minutes = Math.max(0, Math.floor((nowMs - sampledAt) / 60_000));
  if (minutes < 25 || minutes >= 30) return '';
  return theme.warning(`${displayConfig().glyphs === 'text' ? 'Cache ' : '◷'}${data.stale ? '?' : '~'}${String(minutes).padStart(2, '0')}m`);
}

export function statusCard(data: HudData | null, nowMs: number = Date.now()): StatusCard | null {
  if (!data) return null;
  const glyphs = displayConfig().glyphs;

  // Alerts the edges do not already carry: a full quota is marked on the
  // quota meter, a nearly full context is coloured on its own.
  const alerts = collectAttention(data, nowMs).filter((item) => item.kind !== 'quota-exhausted' && item.kind !== 'context-critical');
  const paintAlert = alerts.some((item) => item.severity === 'error') ? theme.error : theme.warning;
  const alertRows = alerts.length
    ? [paintAlert(`! ${alerts.map((item) => alertLabel(item.label) + (item.since ? ` ${waitedText(item.since, nowMs)}` : '')).join(' · ')}`)]
    : [];

  const model = renderModelEffortToken(data.session?.model ?? data.config.model,
    data.session?.reasoningEffort ?? data.config.model_reasoning_effort, { mode: glyphs === 'text' ? 'text' : 'glyph' });
  const start = data.session?.startTime ?? data.sessionStart;
  const shownAge = start ? colors.dim(age(start, nowMs)) : '';

  const status = data.stale ? 'stale' : data.activity?.state;
  let state = '';
  let rate = '';
  let tasks = '';
  if (status) {
    const [glyph, word, paint] = SESSION_STATES[status];
    // The glyph and its word: a lone "✓" said nothing without the legend.
    state = `${paint(glyph)} ${t(word)}`;
    if (status === 'working') {
      const running = [...(data.toolActivity?.recentCalls ?? [])].reverse().find((call) => call.status === 'running');
      const started = data.activity?.turnStartedAt;
      // The tool and the turn's clock say it is working; with no tool, the word does.
      const doing = running ? theme.value(running.name) + (running.target ? colors.dim(`: ${truncate(running.target, 20)}`) : '')
        : t(word);
      const clock = started ? formatElapsedShort(started, nowMs) : '';
      state = [paint(glyph), doing, clock ? colors.dim(doing ? `· ${clock}` : clock) : ''].filter(Boolean).join(' ');
      // The rate is the turn's own: a rate from an earlier turn says nothing now.
      const reading = formatTokenRate(data.outputRate, nowMs);
      if (reading && !reading.startsWith('last ')) rate = colors.dim(`· ${reading.replace(/(\.\d)? tok\/s$/, ' tok/s')}`);
      const plan = data.planProgress;
      if (plan && plan.totalSteps > 0) tasks = colors.dim(`${t('Tasks')} ${plan.completedSteps}/${plan.totalSteps}`);
    }
  }

  const git = data.git;
  const sync = `${git.ahead > 0 ? `${icons.ahead}${git.ahead}` : ''}${git.behind > 0 ? `${icons.behind}${git.behind}` : ''}`;
  // The project is the card's identity: bold, as the band's mock has it.
  const project = theme.bold(theme.projectName(data.project.projectName));
  const repo = git.repo ? `${colors.dim('› ')}${theme.projectName(git.repo)}` : '';
  const branch = git.isGitRepo && git.branch ? `${colors.dim('· ')}${theme.gitBranch(`${git.branch}${git.isDirty ? ` ${icons.dirty}` : ''}`)}${sync ? colors.dim(` ${sync}`) : ''}` : '';
  const place = [project, repo, branch].filter(Boolean).join(' ');

  let context: EdgeMeter | undefined;
  const usage = data.contextUsage;
  if (usage && usage.total > 0) {
    const newer = Math.max(data.activity?.turnStartedAt?.getTime() ?? 0, usage.lastCompactTime?.getTime() ?? 0);
    const pending = data.stale || (newer > 0 && (data.tokenUsageAt?.getTime() ?? 0) < newer);
    const shown = displayConfig().context === 'remaining' ? t('{n}% left', { n: 100 - usage.percent }) : `${usage.percent}%`;
    const compacted = usage.compactCount > 0 ? ` ${icons.refresh}${usage.compactCount}` : '';
    // The auto-compact point only where Codex's config names it: its default
    // depends on the model and is not written anywhere the HUD reads.
    const limit = data.config.model_auto_compact_token_limit;
    context = { percent: usage.percent, label: shown, ...(pending ? { mark: colors.dim('~') } : {}),
      // The window's size, whole thousands: the meter is the reading, the tail only names its scale.
      tail: (usage.total >= 1_000_000 ? formatTokenCount(usage.total) : `${Math.round(usage.total / 1000)}K`) + compacted,
      ...(limit && limit > 0 && limit < usage.total ? { tick: (limit / usage.total) * 100 } : {}) };
  }

  let quota: StatusCard['quota'];
  let others = '';
  let forecast = '';
  let reset = '';
  const windows = readQuotaWindows(data.rateLimits, nowMs);
  if (windows.length) {
    // The meter is the window that runs out first; the other is a reading beside it.
    const worst = windows.reduce((a, b) => (b.percent > a.percent ? b : a));
    const spent = windows.some((window) => window.percent >= 100) || Boolean(data.rateLimits?.rate_limit_reached_type);
    const mark = spent ? theme.error('!') : '';
    const window = worst.label ? colors.dim(worst.label) : '';
    const text = `${window ? window + ' ' : ''}${getMeterColor(worst.percent)(`${worst.percent}%`)}${mark}`;
    quota = { percent: worst.percent, window, spent: mark, text };
    others = windows.filter((window) => window !== worst)
      .map((window) => `${window.label ? colors.dim(window.label) + ' ' : ''}${getMeterColor(window.percent)(`${window.percent}%`)}`).join(' ');
    const soonest = windows.filter((window) => window.resetsAt && !window.resetDue)
      .sort((a, b) => a.resetsAt!.getTime() - b.resetsAt!.getTime())[0];
    // The reset is the quota meter's scale, as the window size is the context's: the tick colour.
    reset = soonest ? theme.tick(`↺${formatCountdown(soonest.resetsAt!, nowMs)}`)
      : windows.some((window) => window.resetDue) ? colors.dim(t('reset due')) : '';
    const projected = data.quotaForecast;
    forecast = projected ? theme.warning(t('out ~{d}', { d: formatCountdown(projected.exhaustAt, nowMs) })) : '';
  }

  const tone: StatusTone = status === 'error' ? 'error' : alerts.length ? 'needs' : status === 'stale' ? 'stale'
    : status === 'working' ? 'working' : 'idle';
  return { tone, busy: status === 'working', alerts: alertRows, state, rate, tasks, model, age: shownAge, context, place, project, repo, branch,
    quota, others, forecast, reset, cache: cacheReminder(data, nowMs) };
}
