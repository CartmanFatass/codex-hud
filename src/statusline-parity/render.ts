/** Owner's claude-hud 0.8.0 compact layout and colour roles (MIT; see NOTICE).
 * Pure: all disk/process evidence and clocks are supplied by the caller. */
import { monitorText } from '../render/monitor-text.js';
import { visualLength } from '../render/colors.js';
import { record } from './storage.js';
import type { ParitySettings } from './settings.js';
import type { TranscriptView } from './transcript.js';
import type { ConfigCounts } from './config-counts.js';
import type { GitView } from './git.js';
const RESET = '\x1b[0m',
  DIM = '\x1b[2m';
const ink = (code: number, text: string) => `\x1b[${code}m${text}${RESET}`;
const dim = (text: string) => `${DIM}${text}${RESET}`;
const safe = (v: unknown, n = 512) => (typeof v === 'string' ? monitorText(v.slice(0, n)).trim() : '');
const short = (v: string, n: number) => (v.length <= n ? v : v.slice(0, n - 1) + '…');
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown) => (finite(v) && v >= 0 ? v : 0);
const pct = (v: unknown) => (finite(v) ? Math.round(Math.max(0, Math.min(100, v))) : null);
const contextColor = (n: number) => (n >= 85 ? 31 : n >= 70 ? 33 : 32);
const quotaColor = (n: number) => (n >= 90 ? 31 : n >= 75 ? 95 : 94);
function bar(n: number, width: number, quota = false): string {
  const filled = Math.round((n / 100) * width);
  return `\x1b[${quota ? quotaColor(n) : contextColor(n)}m${'█'.repeat(filled)}${DIM}${'░'.repeat(width - filled)}${RESET}`;
}
export function contextPercent(value: unknown): number {
  const c = record(record(value).context_window),
    u = record(c.current_usage);
  if (finite(c.used_percentage) && c.used_percentage > 0) return pct(c.used_percentage)!;
  const size = num(c.context_window_size);
  if (!size) return 0;
  const ratio = (num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens)) / size;
  return Math.min(100, Math.round((ratio + 0.225 * Math.min(1, Math.max(0, (ratio - 0.05) / 0.45))) * 100));
}
function reset(ms: number, now: number): string {
  if (!Number.isFinite(ms) || ms <= now) return '';
  const mins = Math.ceil((ms - now) / 60000),
    hours = Math.floor(mins / 60);
  if (mins < 60) return `${mins}m`;
  if (hours >= 24) return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ''}`;
  return `${hours}h${mins % 60 ? ` ${mins % 60}m` : ''}`;
}
function provider(model: Record<string, unknown>, env: NodeJS.ProcessEnv): string {
  if (env.CLAUDE_CODE_USE_BEDROCK === '1') return 'Bedrock';
  if (env.CLAUDE_CODE_USE_VERTEX === '1') return 'Vertex';
  try {
    const u = new URL(env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_BASE_URL || '');
    if (
      ['https://api.minimax.io/anthropic', 'https://api.minimaxi.com/anthropic'].includes(
        u.origin + u.pathname.replace(/\/+$/, '')
      )
    )
      return 'MiniMax';
  } catch {
    /* no proxy */
  }
  return ['opusplan', 'sonnetplan', 'haikuplan'].includes(safe(model.id).toLowerCase()) ? 'Enterprise' : '';
}
function usageParts(value: Record<string, unknown>, width: number, now: number): string[] {
  const r = record(value.rate_limits),
    five = record(r.five_hour),
    seven = record(r.seven_day);
  const f = pct(five.used_percentage),
    s = pct(seven.used_percentage);
  const scoped = Array.isArray(r.model_scoped)
    ? r.model_scoped
        .flatMap((item) => {
          const v = record(item),
            name = safe(v.display_name, 64),
            n = pct(v.utilization);
          return name && (n !== null || v.utilization === null)
            ? [
                {
                  name,
                  n,
                  at: typeof v.resets_at === 'string' && v.resets_at.length <= 64 ? Date.parse(v.resets_at) : NaN,
                },
              ]
            : [];
        })
        .slice(0, 8)
    : [];
  if (f === null && s === null && !Array.isArray(r.model_scoped)) return [];
  const window = (name: string, n: number | null, at: number, force = false, period = name) => {
    const time = reset(at, now);
    return `${force ? dim(name) + ' ' : ''}${bar(n ?? 0, width, true)} ${n === null ? dim('--') : ink(quotaColor(n), `${n}%`)}${time ? ` (${time} / ${period})` : ''}`;
  };
  const scopedParts = scoped.map((v) => window(v.name, v.n, v.at, true, '7d'));
  if (f === 100 || s === 100) {
    const time = reset(num((f === 100 ? five : seven).resets_at) * 1000, now);
    return [ink(31, `⚠ Limit reached${time ? ` (resets in ${time})` : ''}`), ...scopedParts];
  }
  if (f === null && s !== null) return [window('Weekly', s, num(seven.resets_at) * 1000, true), ...scopedParts];
  if (f !== null || s !== null || scoped.length === 0)
    return [
      dim('Usage') + ' ' + window('5h', f, num(five.resets_at) * 1000),
      ...(s !== null && s >= 80 ? [window('Weekly', s, num(seven.resets_at) * 1000, true)] : []),
      ...scopedParts,
    ];
  return scopedParts.map((p, i) => (i === 0 ? dim('Usage') + ' ' + p : p));
}
function elapsed(start: number, end: number): string {
  const ms = Math.max(0, end - start);
  if (ms < 1000) return '<1s';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const secs = Math.floor(ms / 1000),
    mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
function agentModel(model: string | undefined): string {
  if (!model) return '';
  const candidate = model.replace(/\[[^\]]*\]$/, '');
  const match = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-\d{8})?$/i.exec(candidate);
  if (match) return `${match[1].toLowerCase()}-${match[2]}${match[3] ? '.' + match[3] : ''}`;
  const legacy = /^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)(?:-\d{8})?$/i.exec(candidate);
  return legacy ? `${legacy[3].toLowerCase()}-${legacy[1]}${legacy[2] ? '.' + legacy[2] : ''}` : safe(model);
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function truncateAnsi(text: string, width: number): string {
  if (visualLength(text) <= width) return text;
  const suffix = '.'.repeat(Math.min(3, width)),
    limit = width - suffix.length;
  let out = '',
    cells = 0;
  for (const token of text.split(/(\x1b\[[0-9;]*m)/g)) {
    if (token.startsWith('\x1b[')) {
      out += token;
      continue;
    }
    for (const { segment } of segmenter.segment(token)) {
      const n = visualLength(segment);
      if (cells + n > limit) return out + suffix + RESET;
      out += segment;
      cells += n;
    }
  }
  return out + suffix + RESET;
}
function wrap(parts: string[], width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const p of parts) {
    const candidate = line ? line + ' | ' + p : p;
    if (line && visualLength(candidate) > width) {
      lines.push(truncateAnsi(line, width));
      line = p;
    } else line = candidate;
  }
  if (line) lines.push(truncateAnsi(line, width));
  return lines;
}
export interface ParityEvidence {
  transcript: TranscriptView;
  counts: ConfigCounts;
  git: GitView | null;
}
export function renderParity(
  input: unknown,
  width: number,
  settings: ParitySettings,
  evidence: ParityEvidence,
  now: number,
  env: NodeJS.ProcessEnv = {}
): string {
  const v = record(input),
    m = record(v.model),
    t = evidence.transcript,
    d = settings.display;
  let model = safe(m.display_name) || safe(m.id) || 'Unknown';
  if (!safe(m.display_name) && /^(opus|sonnet|haiku)plan$/i.test(model))
    model = 'Claude ' + model[0].toUpperCase() + model.slice(1, -4);
  if (!safe(m.display_name) && /anthropic\.claude/.test(model)) {
    const match = /claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i.exec(model);
    if (match) model = `${match[1][0].toUpperCase() + match[1].slice(1)} ${match[2]}${match[3] ? '.' + match[3] : ''}`;
  }
  const effort = safe(typeof v.effort === 'string' ? v.effort : record(v.effort).level, 64).toLowerCase();
  const symbol: Record<string, string> = { low: '○', medium: '◔', high: '◑', xhigh: '◕', max: '●' };
  if (d.showEffortLevel && effort)
    model += ` ${symbol[effort] ? symbol[effort] + ' ' : ''}${t.ultracode ? `ultracode(${effort})` : effort}`;
  const prov = provider(m, env);
  if (prov) model += ' | ' + prov;
  const percent = contextPercent(v),
    barWidth = width >= 100 ? 10 : width >= 60 ? 6 : 4;
  const header = [`${ink(36, `[${model}]`)} ${bar(percent, barWidth)} ${ink(contextColor(percent), `${percent}%`)}`];
  let project = safe(v.cwd).split(/[/\\]/).filter(Boolean).slice(-1)[0] || (safe(v.cwd).startsWith('/') ? '/' : '');
  project = project ? ink(33, project) : '';
  const git = evidence.git;
  if (git && settings.gitStatus.enabled) {
    const branch =
      safe(git.branch) +
      (git.dirty && settings.gitStatus.showDirty ? '*' : '') +
      (settings.gitStatus.showAheadBehind
        ? `${git.ahead > 0 ? ` ↑${git.ahead}` : ''}${git.behind > 0 ? ` ↓${git.behind}` : ''}`
        : '');
    project += `${project ? ' ' : ''}${ink(35, 'git:(')}${ink(36, branch)}${ink(35, ')')}`;
  }
  if (project) header.push(project);
  if (d.showConfigCounts) {
    const c = evidence.counts;
    for (const [count, label] of [
      [c.claudeMdCount, 'CLAUDE.md'],
      [c.rulesCount, 'rules'],
      [c.mcpCount, 'MCPs'],
      [c.hooksCount, 'hooks'],
    ] as const)
      if (count > 0) header.push(dim(`${count} ${label}`));
  }
  if (prov !== 'Bedrock' && !safe(m.id).toLowerCase().includes('anthropic.claude-'))
    header.push(...usageParts(v, barWidth, now));
  if (d.showDuration && t.sessionStart !== undefined) {
    const mins = Math.floor((now - t.sessionStart) / 60000);
    header.push(dim(`⏱️  ${mins < 1 ? '<1m' : mins < 60 ? mins + 'm' : `${Math.floor(mins / 60)}h ${mins % 60}m`}`));
  }
  if (percent >= 85 && Object.keys(record(record(v.context_window).current_usage)).length) {
    const u = record(record(v.context_window).current_usage);
    const tokens = (n: number) =>
      n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(0) + 'k' : String(n);
    header[header.length - 1] += dim(
      ` (in: ${tokens(num(u.input_tokens))}, cache: ${tokens(num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens))})`
    );
  }
  const lines = wrap(header, width),
    activity: string[] = [];
  if (d.showSkills && t.skills.length)
    activity.push(
      `${ink(32, '✓')} Skills ${dim(`(${t.skills.length})`)}: ${[
        ...t.skills.slice(0, 4).map((n) => ink(36, short(safe(n, 64), 64))),
        ...(t.skills.length > 4 ? [dim(`+${t.skills.length - 4} more`)] : []),
      ].join(', ')}`
    );
  if (d.showAgents) {
    const ordered = [...t.agents].sort((a, b) => a.startPos - b.startPos).slice(-10);
    const running = ordered.filter((a) => a.end === undefined).slice(-3);
    const completed = ordered
      .filter((a) => a.end !== undefined && a.end <= now && now - a.end <= 60000)
      .slice(-Math.min(2, 3 - running.length));
    if (running.length === 3) completed.length = 0;
    for (const a of [...running, ...completed]) {
      const name = agentModel(a.model),
        desc = short(safe(a.description), 40);
      activity.push(
        `${ink(a.end === undefined ? 33 : 32, a.end === undefined ? '◐' : '✓')} ${ink(35, short(safe(a.type), 24) || 'agent')}${name ? ' ' + dim(`[${name}]`) : ''}${desc ? dim(': ' + desc) : ''} ${dim(`(${elapsed(a.start, a.end ?? now)})`)}`
      );
    }
  }
  if (d.showTodos && t.todos.length) {
    const progress = t.todos.find((t) => t.status === 'in_progress'),
      completed = t.todos.filter((t) => t.status === 'completed').length;
    if (progress)
      activity.push(`${ink(33, '▸')} ${short(safe(progress.content), 50)} ${dim(`(${completed}/${t.todos.length})`)}`);
    else if (completed === t.todos.length)
      activity.push(`${ink(32, '✓')} All todos complete ${dim(`(${completed}/${t.todos.length})`)}`);
  }
  if (settings.showSeparators && activity.length)
    lines.push(dim('─'.repeat(Math.min(width, Math.max(20, ...lines.map(visualLength))))));
  lines.push(...activity.map((l) => truncateAnsi(l, width)));
  return lines.map((l) => RESET + l).join('\n');
}
