/**
 * The status bar's fields, for the card at the foot of the tree panel. While
 * the panel is open it replaces the bar, so what the bar said has to be said
 * here. The card spends its rows on the brief, so the fields ride on its
 * edges, and the edges are the meters, as omp's input box draws its context
 * meter in its border:
 *
 *   ╭─ ▸ exec: npm test · 2m10s ☀◆ 2h 56%━━━━━━━────────246K , ? ─╮
 *   │ ! 等待批准                                                   │   alerts, only when there are any
 *   ╰─ atlas-wsl · main * 7d 99%━━━━━━━━━━━━━━━━━━━━━ ↺114h ◷~30m+ ─╯
 *
 * Top: the session's state (while it works, the tool, the turn's clock and
 * the output rate), the model's badge and the session's age, then the
 * context meter with its window size. Bottom: where it works, the quota
 * meter, the reset countdown and the prompt-cache reminder. This module
 * hands the monitor the parts; the monitor fits them to the edge, dropping
 * the least wanted first. Every value is read the way the bar reads it; a
 * field with no data is left out rather than shown as zero. The agents'
 * counts are the panel's own job.
 */
import type { HudData } from '../types.js';
import { collectAttention, waitedText } from './attention.js';
import { colors, getContextColor, icons, theme, truncate } from './colors.js';
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
  /** For the bottom edge: where the session works. */
  place: string;
  /** The account's tightest usage window, labelled with its length; `text` is its reading alone. */
  quota?: EdgeMeter & {text: string};
  /** The other window's reading, a projection of running out, and the soonest reset. */
  others: string;
  forecast: string;
  reset: string;
  /** The prompt-cache reminder: dim, but in the warning colour in the minutes before it lapses. */
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
  // The card's frame is painted by the state: with icons the word goes and
  // the glyph stays, which survives without colour.
  if (iconic()) {
    const text = [paint(glyph), clock].filter(Boolean).join(' ');
    return { text, short: text, attention: false, failed };
  }
  const words = `${paint(t(word))}${clock ? ` ${clock}` : ''}`;
  return { text: `${paint(glyph)} ${words}`, short: words, attention: false, failed };
}

/**
 * The prompt-cache reminder as the card shows it. The bar paints it red once
 * thirty minutes have passed, but on a card that stays open through a long
 * idle session that is most of the time, and nothing is left to act on: it
 * is dim then, and only the minutes before it lapses (25–29m) are a warning.
 */
function cacheReminder(data: HudData, nowMs: number): string {
  const sampledAt = data.tokenUsageAt?.getTime();
  if (sampledAt === undefined || !Number.isFinite(sampledAt) || !Number.isFinite(nowMs)) return '';
  const minutes = Math.max(0, Math.floor((nowMs - sampledAt) / 60_000));
  const text = `${displayConfig().glyphs === 'text' ? 'Cache ' : '◷'}${data.stale ? '?' : '~'}${minutes >= 30 ? '30m+' : `${String(minutes).padStart(2, '0')}m`}`;
  return minutes >= 25 && minutes < 30 ? theme.warning(text) : colors.dim(text);
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
    // The frame's colour says the state; with icons the word goes, the glyph stays.
    state = iconic() ? paint(glyph) : `${paint(glyph)} ${t(word)}`;
    if (status === 'working') {
      const running = [...(data.toolActivity?.recentCalls ?? [])].reverse().find((call) => call.status === 'running');
      const started = data.activity?.turnStartedAt;
      // The tool and the turn's clock say it is working; the word only without icons and a tool.
      const doing = running ? theme.value(running.name) + (running.target ? colors.dim(`: ${truncate(running.target, 20)}`) : '')
        : iconic() ? '' : t(word);
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
  const place = theme.projectName(data.project.projectName)
    + (git.repo ? `${colors.dim(' › ')}${theme.projectName(git.repo)}` : '')
    + (git.isGitRepo && git.branch ? `${colors.dim(' · ')}${theme.gitBranch(`${git.branch}${git.isDirty ? ` ${icons.dirty}` : ''}`)}${sync ? colors.dim(` ${sync}`) : ''}` : '');

  let context: EdgeMeter | undefined;
  const usage = data.contextUsage;
  if (usage && usage.total > 0) {
    const newer = Math.max(data.activity?.turnStartedAt?.getTime() ?? 0, usage.lastCompactTime?.getTime() ?? 0);
    const pending = data.stale || (newer > 0 && (data.tokenUsageAt?.getTime() ?? 0) < newer);
    const shown = displayConfig().context === 'remaining' ? t('{n}% left', { n: 100 - usage.percent }) : `${usage.percent}%`;
    const paint = getContextColor(usage.percent);
    const compacted = usage.compactCount > 0 ? colors.dim(` ${icons.refresh}${usage.compactCount}`) : '';
    // The auto-compact point only where Codex's config names it: its default
    // depends on the model and is not written anywhere the HUD reads.
    const limit = data.config.model_auto_compact_token_limit;
    context = { percent: usage.percent, paint, label: (pending ? colors.dim('~') : '') + paint(shown),
      // The window's size, whole thousands: the meter is the reading, the tail only names its scale.
      tail: colors.dim(usage.total >= 1_000_000 ? formatTokenCount(usage.total) : `${Math.round(usage.total / 1000)}K`) + compacted,
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
    const paint = getContextColor(worst.percent);
    const mark = spent ? theme.error('!') : '';
    const text = `${worst.label ? colors.dim(worst.label) + ' ' : ''}${paint(`${worst.percent}%`)}${mark}`;
    quota = { percent: worst.percent, paint, label: text, text };
    others = windows.filter((window) => window !== worst)
      .map((window) => `${window.label ? colors.dim(window.label) + ' ' : ''}${getContextColor(window.percent)(`${window.percent}%`)}`).join(' ');
    const soonest = windows.filter((window) => window.resetsAt && !window.resetDue)
      .sort((a, b) => a.resetsAt!.getTime() - b.resetsAt!.getTime())[0];
    reset = soonest ? colors.dim(`↺${formatCountdown(soonest.resetsAt!, nowMs)}`)
      : windows.some((window) => window.resetDue) ? colors.dim(t('reset due')) : '';
    const projected = data.quotaForecast;
    forecast = projected ? theme.warning(t('out ~{d}', { d: formatCountdown(projected.exhaustAt, nowMs) })) : '';
  }

  const tone: StatusTone = status === 'error' ? 'error' : alerts.length ? 'needs' : status === 'stale' ? 'stale'
    : status === 'working' ? 'working' : 'idle';
  return { tone, alerts: alertRows, state, rate, tasks, model, age: shownAge, context, place, quota, others, forecast, reset,
    cache: cacheReminder(data, nowMs) };
}
