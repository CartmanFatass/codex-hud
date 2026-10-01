/**
 * The status bar's fields, as a card at the foot of the tree panel. While
 * the panel is open it replaces the bar, so what the bar said has to be said
 * here; the panel is narrow and tall where the bar is wide and short, so the
 * fields become a small table, and the short identifying ones ride on the
 * card's frame where they cost no row:
 *
 *   ╭─ 状态 ☀◆ 2h10m ─────── , ? ─╮   model and session age on the top edge
 *   │ ! 等待批准                   │   alerts, only when there are any
 *   │ ▸ exec_command · 4m          │   what the session is doing
 *   │ 上下文 ━━━━━━━╸──── 61%      │   how full the context is
 *   │ 额度   ━━━━━━━━━━━━ 100% !   │   the account's usage window
 *   │ 输出   ~25.5 tok/s  任务 2/5 │   the rest, when there is any
 *   ╰─ hmasd-wsl · main * ── ◷~09m ─╯  where, and the prompt-cache reminder
 *
 * Labels sit in one column and meters start in the next, so the two meters
 * line up. The monitor draws the frame and fits the edge texts to it. Every value
 * here is read the way the bar reads it; a field with no data is left out
 * rather than shown as zero. The agents' counts are the panel's own job.
 */
import type { HudData } from '../types.js';
import { buildBarModules, formatDuration } from './layout/bar-modules.js';
import { collectAttention } from './attention.js';
import { colors, coloredPercent, getContextColor, icons, padEnd, theme, truncate, truncateAnsi, visualLength } from './colors.js';
import { renderModelEffortToken } from './model-glyphs.js';
import { formatTokenCount } from './lines/activity-line.js';
import { formatCountdown, readQuotaWindows } from './quota.js';
import { formatElapsedShort } from './subagent-chip.js';
import { formatTokenRate } from '../collectors/token-rate.js';
import { displayConfig } from './hud-config.js';
import { contextLine } from './monitor.js';
import { t } from './i18n.js';

type RowId = 'alert' | 'session' | 'context' | 'quota' | 'extras';
/** What stays when the card is short of rows, most wanted first. */
const KEEP_ORDER: RowId[] = ['alert', 'session', 'context', 'quota', 'extras'];
const SHOW_ORDER: RowId[] = ['alert', 'session', 'context', 'quota', 'extras'];

export interface StatusCard {
  rows: string[];
  /** For the top edge, after the title: the model's badge and the session's age. */
  top: string;
  /** For the bottom edge: where the session works, and the cache reminder. */
  bottom: string;
  bottomRight: string;
}

function alertLabel(label: string): string {
  const failed = label.match(/^(\d+) (tool|agent)s? failed$/);
  if (failed) return t(failed[1] === '1' ? `1 ${failed[2]} failed` : `{n} ${failed[2]}s failed`, { n: failed[1] });
  return t(label);
}

export function statusCard(data: HudData | null, width: number, maxRows: number, nowMs: number = Date.now()): StatusCard | null {
  if (!data || width < 12 || maxRows <= 0) return null;
  const glyphs = displayConfig().glyphs;
  const labelWidth = Math.max(...['Context', 'Quota', 'Output'].map((label) => visualLength(t(label))));
  const label = (text: string) => colors.dim(padEnd(t(text), labelWidth)) + ' ';
  const rows = new Map<RowId, string>();
  const meters = new Map<RowId, Meter>();

  // Alerts the other rows do not already carry: a full quota is marked on the
  // quota row, a nearly full context is coloured on its meter.
  const alerts = collectAttention(data, nowMs).filter((item) => item.kind !== 'quota-exhausted' && item.kind !== 'context-critical');
  if (alerts.length) {
    const paint = alerts.some((item) => item.severity === 'error') ? theme.error : theme.warning;
    rows.set('alert', paint(`! ${alerts.map((item) => alertLabel(item.label)).join(' · ')}`));
  }

  const model = renderModelEffortToken(data.session?.model ?? data.config.model,
    data.session?.reasoningEffort ?? data.config.model_reasoning_effort, { mode: glyphs === 'text' ? 'text' : 'glyph' });
  const age = colors.dim(formatDuration(data.session?.startTime ?? data.sessionStart, nowMs));
  const top = [model, age].filter(Boolean).join(' ');

  const status = data.stale ? 'stale' : data.activity?.state;
  if (status) {
    const [glyph, word, paint] = {
      working: ['▸', 'Working', theme.info],
      idle: ['✓', 'Idle', theme.success],
      interrupted: ['■', 'Interrupted', theme.warning],
      error: ['✗', 'Failed', theme.error],
      stale: ['?', 'Sync delayed', theme.warning],
    }[status] as [string, string, (text: string) => string];
    let left = `${paint(glyph)} ${t(word)}`;
    if (status === 'working') {
      const running = [...(data.toolActivity?.recentCalls ?? [])].reverse().find((call) => call.status === 'running');
      const started = data.activity?.turnStartedAt;
      left = `${paint(glyph)} ${running ? theme.value(running.name) : t(word)}`
        + (running?.target ? colors.dim(`: ${truncate(running.target, 20)}`) : '')
        + (started ? colors.dim(` · ${formatElapsedShort(started, nowMs)}`) : '');
    }
    rows.set('session', truncateAnsi(left, width));
  }

  const git = data.git;
    const sync = `${git.ahead > 0 ? `${icons.ahead}${git.ahead}` : ''}${git.behind > 0 ? `${icons.behind}${git.behind}` : ''}`;
  const bottom = theme.projectName(data.project.projectName)
    + (git.repo ? `${colors.dim(' › ')}${theme.projectName(git.repo)}` : '')
    + (git.isGitRepo && git.branch ? `${colors.dim(' · ')}${theme.gitBranch(`${git.branch}${git.isDirty ? ` ${icons.dirty}` : ''}`)}${sync ? colors.dim(` ${sync}`) : ''}` : '');
  const bottomRight = buildBarModules(data, { nowMs, density: 'full' }).find((module) => module.id === 'cache')?.variants.full ?? '';

  const usage = data.contextUsage;
  if (usage && usage.total > 0) {
    const newer = Math.max(data.activity?.turnStartedAt?.getTime() ?? 0, usage.lastCompactTime?.getTime() ?? 0);
    const pending = data.stale || (newer > 0 && (data.tokenUsageAt?.getTime() ?? 0) < newer);
    const shown = displayConfig().context === 'remaining' ? t('{n}% left', { n: 100 - usage.percent }) : `${usage.percent}%`;
    const number = (pending ? colors.dim('~') : '') + getContextColor(usage.percent)(shown);
    const totals = colors.dim(` ${formatTokenCount(usage.used)}/${formatTokenCount(usage.total)}`);
    const compact = usage.compactCount > 0 ? colors.dim(` ${icons.refresh}${usage.compactCount}`) : '';
    meters.set('context', { label: label('Context'), percent: usage.percent, readings: [number + totals + compact, number + compact, number] });
  }

  const windows = readQuotaWindows(data.rateLimits, nowMs);
  if (windows.length) {
    const worst = windows.reduce((a, b) => (b.percent > a.percent ? b : a));
    const spent = windows.some((window) => window.percent >= 100) || Boolean(data.rateLimits?.rate_limit_reached_type);
    const soonest = windows.filter((window) => window.resetsAt && !window.resetDue)
      .sort((a, b) => a.resetsAt!.getTime() - b.resetsAt!.getTime())[0];
    const reset = soonest ? colors.dim(` ↺${formatCountdown(soonest.resetsAt!, nowMs)}`)
      : windows.some((window) => window.resetDue) ? colors.dim(` ${t('reset due')}`) : '';
    const mark = spent ? ` ${theme.error('!')}` : '';
    const one = (window: typeof worst) => `${window.label ? colors.dim(window.label) + ' ' : ''}${coloredPercent(window.percent)}`;
    meters.set('quota', { label: label('Quota'), percent: worst.percent, readings: [
      windows.map(one).join('  ') + mark + reset,
      one(worst) + mark + reset,
      one(worst) + mark,
    ] });
  }

  const extras: Array<[string, string]> = [];
  const rate = data.stale ? null : formatTokenRate(data.outputRate, nowMs);
  // "last ~25 tok/s" is a rate from an earlier turn: shown dim, not reworded.
  if (rate) extras.push(['Output', rate.startsWith('last ') ? colors.dim(rate.slice(5)) : theme.value(rate)]);
  const plan = data.planProgress;
  if (plan && plan.totalSteps > 0) extras.push(['Tasks', theme.value(`${plan.completedSteps}/${plan.totalSteps}`)]);
  if (extras.length) {
    rows.set('extras', truncateAnsi(extras.map(([name, value], i) =>
      i ? `${colors.dim(t(name))} ${value}` : `${label(name)}${value}`).join('   '), width));
  }

  for (const [id, row] of meterRows([...meters.values()], width).map((row, i) => [[...meters.keys()][i], row] as const)) rows.set(id, row);

  const kept = new Set(KEEP_ORDER.filter((id) => rows.has(id)).slice(0, maxRows));
  return { rows: SHOW_ORDER.filter((id) => kept.has(id)).map((id) => rows.get(id)!), top, bottom, bottomRight };
}

interface Meter { label: string; percent: number; readings: string[] }

/**
 * Meters drawn as one table: the same start column (the labels share a
 * width) and the same length, so both end where their readings begin. Each
 * reading shortens before the meters drop below four cells; past that the
 * meters go and the readings stay.
 */
function meterRows(meters: Meter[], width: number): string[] {
  if (!meters.length) return [];
  const room = width - visualLength(meters[0].label) - 1;
  const chosen = meters.map((meter) => meter.readings.find((reading) => room - visualLength(reading) >= 4) ?? meter.readings[meter.readings.length - 1]);
  const cells = Math.min(20, room - Math.max(...chosen.map(visualLength)));
  return meters.map((meter, i) => truncateAnsi(cells >= 4
    ? `${meter.label}${contextLine(meter.percent, cells)} ${chosen[i]}`
    : `${meter.label}${chosen[i]}`, width));
}
