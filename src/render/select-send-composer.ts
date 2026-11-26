/**
 * Pure renderer and input state machine for the minimal selection composer.
 * Follows ARCHITECTURE §8: exact width columns, pure paint (nowMs), single monitorText pass,
 * t() EN/ZH labels, theme roles (zero ANSI under theme=none / NO_COLOR), whole footer hints.
 */
import type { NormalizedExcerpt, SelectSendMode, SelectionJobTarget, SelectionSource } from '../roles/select-send.js';
import { theme, truncateAnsi, visualLength } from './colors.js';
import { t } from './i18n.js';
import { fit, monitorText, pair } from './monitor-text.js';

export interface ComposerState {
  readonly mode: SelectSendMode;
  readonly source: SelectionSource;
  readonly targetPane: string | null;
  readonly targetAgent: string | null;
  readonly jobs: readonly SelectionJobTarget[];
  readonly targetJob?: SelectionJobTarget;
  readonly picker: number | null;
  readonly excerpt: NormalizedExcerpt;
  readonly stale: boolean;
  readonly question: string;
  readonly cursor: number;
  readonly scroll: number;
  readonly notice: string | null;
  readonly error: string | null;
  readonly phase: 'editing' | 'sending' | 'waiting';
}

export type ComposerKey =
  | { type: 'text'; text: string }
  | { type: 'enter' }
  | { type: 'targets' }
  | { type: 'cancel' }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'clear-line' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'scroll'; delta: number };

export function createComposerState(input: {
  mode?: SelectSendMode;
  source: SelectionSource;
  targetPane: string | null;
  targetAgent: string | null;
  jobs?: readonly SelectionJobTarget[];
  excerpt: NormalizedExcerpt;
  initialQuestion?: string;
  stale?: boolean;
  notice?: string | null;
  error?: string | null;
}): ComposerState {
  const mode = input.mode ?? 'selection';
  const jobs = input.jobs ?? [];
  const question = input.initialQuestion ?? '';
  return {
    mode,
    source: input.source,
    targetPane: input.targetPane,
    targetAgent: input.targetAgent,
    jobs,
    picker: mode === 'investigate' && jobs.length > 0 ? 0 : null,
    excerpt: input.excerpt,
    stale: Boolean(input.stale),
    question,
    cursor: [...question].length,
    scroll: 0,
    notice: input.notice ?? null,
    error: input.error ?? null,
    phase: 'editing',
  };
}

/** Wrap a single already-sanitized line into chunks of at most `width` display columns. */
function wrapVisual(sanitized: string, width: number): string[] {
  if (width < 1) return [''];
  if (!sanitized) return [''];
  const out: string[] = [];
  let line = '';
  for (const ch of sanitized) {
    if (visualLength(line + ch) > width && line) {
      out.push(line);
      line = '';
    }
    line += ch;
  }
  out.push(line);
  return out;
}

export function excerptDisplayLines(excerpt: NormalizedExcerpt, contentWidth: number): string[] {
  if (excerpt.empty) return [];
  const innerWidth = Math.max(1, contentWidth);
  return excerpt.text.split('\n').flatMap((raw) => wrapVisual(monitorText(raw), innerWidth));
}

function fitWholeHints(hints: readonly string[], width: number): string {
  let out = '';
  for (const hint of hints) {
    const candidate = out ? `${out}  ${hint}` : hint;
    if (visualLength(candidate) <= width) out = candidate;
  }
  return out;
}

function headerMeta(source: SelectionSource, maxWidth: number): string {
  const project = source.project ? monitorText(source.project) : null;
  const pane = source.pane ? monitorText(source.pane) : null;
  const job = source.job ? monitorText(source.role ? `${source.job} (${source.role})` : source.job) : null;
  const candidates = [
    [project, pane, job].filter(Boolean).join(' · '),
    [project, job ?? pane].filter(Boolean).join(' · '),
    job ?? project ?? pane ?? '',
    '',
  ];
  for (const item of candidates) {
    if (visualLength(item) <= maxWidth) return item;
  }
  return '';
}

function sliceQuestionWindow(text: string, cursor: number, maxCols: number): { before: string; after: string } {
  const chars = [...text];
  const clamped = Math.max(0, Math.min(cursor, chars.length));
  const sanitizedChars = chars.map((ch) => monitorText(ch));
  const widths = sanitizedChars.map((ch) => visualLength(ch));

  let start = 0;
  let usedBefore = widths.slice(0, clamped).reduce((a, b) => a + b, 0);
  while (start < clamped && usedBefore > Math.max(0, maxCols - 1)) {
    usedBefore -= widths[start]!;
    start++;
  }
  let end = clamped;
  let usedTotal = usedBefore;
  while (end < sanitizedChars.length && usedTotal + widths[end]! <= maxCols) {
    usedTotal += widths[end]!;
    end++;
  }
  return {
    before: sanitizedChars.slice(start, clamped).join(''),
    after: sanitizedChars.slice(clamped, end).join(''),
  };
}

function guardedWaitText(width: number): string {
  const full = t("Waiting for the main session's prompt to be empty · Esc cancels");
  return visualLength(full) <= width ? full : t('Waiting · Esc cancel');
}

function targetJobLabel(job: SelectionJobTarget): string {
  return [monitorText(job.role), t('working'), job.ticket && monitorText(job.ticket),
    job.package && job.package !== job.ticket && monitorText(job.package), job.job].filter(Boolean).join(' · ');
}

export function renderSelectSendComposer(
  state: ComposerState,
  opts: { width: number; height: number; nowMs: number }
): string[] {
  void opts.nowMs;
  const width = Math.max(20, Math.floor(opts.width));
  const height = Math.max(6, Math.floor(opts.height));
  const rows: string[] = [];

  const main = state.targetPane && monitorText(state.targetAgent ? `${state.targetAgent} (${state.targetPane})` : state.targetPane);
  const investigate = state.mode === 'investigate';
  if (state.picker !== null) {
    const available = height - 2;
    const start = Math.max(0, state.picker - available + 1);
    rows.push(theme.strong(t(investigate ? 'Choose working job' : 'Selection target')));
    for (let i = start; i < start + available; i++) {
      const job = investigate ? state.jobs[i] : state.jobs[i - 1];
      const label = !investigate && i === 0
        ? (main ? t('Main: {target}', { target: main }) : t('Main unavailable'))
        : job ? targetJobLabel(job) : '';
      rows.push(i === state.picker ? theme.selected(`› ${label}`) : label ? `  ${label}` : '');
    }
    rows.push(theme.dim(fitWholeHints([
      t('Enter choose'),
      t(investigate && !state.targetJob ? 'Esc cancel' : 'Esc back'),
      t('↑↓ move'),
    ], width)));
    return rows.map(line => fit(line, width));
  }

  // 1. Header: target on left, optional source metadata dropped before cutting on right.
  const targetDesc = state.targetJob ? targetJobLabel(state.targetJob) : investigate ? null : main;
  const leftTitle = targetDesc
    ? t(investigate ? 'Investigate pane -> {target}' : 'Send selection -> {target}', { target: targetDesc })
    : t(investigate ? 'Investigate pane' : 'Send selection');
  const rightBudget = Math.max(0, width - visualLength(leftTitle) - 2);
  const meta = headerMeta(state.source, rightBudget);
  rows.push(fit(pair(theme.strong(leftTitle), meta ? theme.dim(meta) : '', width), width));

  // 2. Optional banner (error, notice, or stale alert).
  const banner = state.error
    ? { text: state.error, paint: theme.error }
    : state.phase !== 'editing'
      ? { text: state.phase === 'waiting' ? guardedWaitText(width) : t('Sending…'), paint: theme.info }
      : state.notice
        ? { text: state.notice, paint: state.stale ? theme.warning : theme.info }
        : state.stale
          ? { text: t('Content changed — showing latest excerpt. Press Enter to send.'), paint: theme.warning }
          : null;
  if (banner) {
    rows.push(fit(banner.paint(monitorText(banner.text)), width));
  }

  // Reserve 1 row for excerpt label + 1 row for question + 1 row for footer.
  const viewportRows = Math.max(1, height - rows.length - 3);
  const contentWidth = Math.max(1, width - 2);
  const wrappedLines = excerptDisplayLines(state.excerpt, contentWidth);
  const maxScroll = Math.max(0, wrappedLines.length - viewportRows);
  const offset = Math.max(0, Math.min(state.scroll, maxScroll));
  const overflow = wrappedLines.length > viewportRows;

  // 3. Excerpt label row.
  const labelLeft = theme.label(t(investigate ? 'Pane output (visible region to send)' : 'Excerpt (exact text to send)'));
  const labelRight = overflow
    ? theme.dim(
        t('lines {start}-{end}/{total}', {
          start: offset + 1,
          end: Math.min(wrappedLines.length, offset + viewportRows),
          total: wrappedLines.length,
        })
      )
    : '';
  rows.push(fit(pair(labelLeft, labelRight, width), width));

  // 4. Excerpt viewport rows (exact text, sanitized once above).
  const bar = theme.dim('│ ');
  for (let i = 0; i < viewportRows; i++) {
    const line = wrappedLines[offset + i];
    if (line !== undefined) {
      rows.push(fit(bar + theme.value(line), width));
    } else if (i === 0 && wrappedLines.length === 0) {
      rows.push(fit(bar + theme.dim(t(investigate ? 'Pane has no visible output; nothing to send.' : 'Selection is empty; nothing to send.')), width));
    } else {
      rows.push(fit('', width));
    }
  }

  // 5. Question input line.
  const promptLabel = t('Question: ');
  const promptStyled = theme.accent(promptLabel);
  const editing = state.phase === 'editing';
  const cursorMark = editing ? theme.selected('▏') : '';
  const inputBudget = Math.max(1, width - visualLength(promptLabel) - (editing ? 1 : 0));
  const { before, after } = sliceQuestionWindow(state.question, state.cursor, inputBudget);
  rows.push(fit(promptStyled + theme.value(before) + cursorMark + theme.value(after), width));

  // 6. Footer hints (kept whole when fitted).
  const canSend = investigate ? Boolean(state.targetJob) : Boolean(state.targetPane || state.targetJob);
  const hints = [
    ...(editing && state.jobs.length ? [t('Tab targets')] : []),
    ...(editing && canSend && !state.excerpt.empty ? [t('Enter send')] : []),
    ...(state.phase !== 'waiting' ? [t('Esc cancel')] : []),
    ...(editing && overflow ? [t('↑↓ scroll')] : []),
  ];
  rows.push(fit(theme.dim(fitWholeHints(hints, width)), width));

  return rows.slice(0, height).map((line) => {
    const clipped = truncateAnsi(line, width);
    return clipped + ' '.repeat(Math.max(0, width - visualLength(clipped)));
  });
}

export function applyComposerKey(
  state: ComposerState,
  key: ComposerKey,
  maxScroll = Infinity
): { state: ComposerState; intent: 'none' | 'submit' | 'cancel' } {
  if (state.phase !== 'editing') {
    return key.type === 'cancel' ? { state, intent: 'cancel' } : { state, intent: 'none' };
  }
  if (state.picker !== null) {
    const investigate = state.mode === 'investigate';
    if (key.type === 'cancel') {
      if (investigate && !state.targetJob) return { state, intent: 'cancel' };
      return { state: { ...state, picker: null }, intent: 'none' };
    }
    if (key.type === 'targets') {
      if (investigate && !state.targetJob) return { state, intent: 'none' };
      return { state: { ...state, picker: null }, intent: 'none' };
    }
    if (key.type === 'scroll' || key.type === 'home' || key.type === 'end') {
      const maxIndex = investigate ? Math.max(0, state.jobs.length - 1) : state.jobs.length;
      const picker = key.type === 'home' ? 0 : key.type === 'end' ? maxIndex
        : Math.max(0, Math.min(maxIndex, state.picker + key.delta));
      return { state: { ...state, picker }, intent: 'none' };
    }
    if (key.type === 'enter') {
      const picked = investigate ? state.jobs[state.picker] : state.jobs[state.picker - 1];
      if (investigate && !picked) return { state, intent: 'none' };
      return { state: { ...state, targetJob: picked, picker: null, error: null }, intent: 'none' };
    }
    return { state, intent: 'none' };
  }
  const chars = [...state.question];
  const clampCursor = (pos: number, len: number) => Math.max(0, Math.min(pos, len));
  switch (key.type) {
    case 'cancel':
      return { state, intent: 'cancel' };
    case 'enter':
      return { state, intent: 'submit' };
    case 'targets': {
      if (!state.jobs.length) return { state, intent: 'none' };
      const idx = state.targetJob ? state.jobs.indexOf(state.targetJob) : -1;
      const picker = state.mode === 'investigate' ? Math.max(0, idx) : idx >= 0 ? idx + 1 : 0;
      return { state: { ...state, picker }, intent: 'none' };
    }
    case 'text': {
      const insert = [...key.text.replace(/[\r\n\x00-\x1f\x7f]/g, ' ')];
      if (!insert.length) return { state, intent: 'none' };
      const next = [...chars.slice(0, state.cursor), ...insert, ...chars.slice(state.cursor)];
      return {
        state: { ...state, question: next.join(''), cursor: state.cursor + insert.length, error: null },
        intent: 'none',
      };
    }
    case 'backspace': {
      if (state.cursor <= 0) return { state, intent: 'none' };
      const next = [...chars.slice(0, state.cursor - 1), ...chars.slice(state.cursor)];
      return { state: { ...state, question: next.join(''), cursor: state.cursor - 1 }, intent: 'none' };
    }
    case 'delete': {
      if (state.cursor >= chars.length) return { state, intent: 'none' };
      const next = [...chars.slice(0, state.cursor), ...chars.slice(state.cursor + 1)];
      return { state: { ...state, question: next.join('') }, intent: 'none' };
    }
    case 'clear-line':
      return { state: { ...state, question: '', cursor: 0 }, intent: 'none' };
    case 'left':
      return { state: { ...state, cursor: clampCursor(state.cursor - 1, chars.length) }, intent: 'none' };
    case 'right':
      return { state: { ...state, cursor: clampCursor(state.cursor + 1, chars.length) }, intent: 'none' };
    case 'home':
      return { state: { ...state, cursor: 0 }, intent: 'none' };
    case 'end':
      return { state: { ...state, cursor: chars.length }, intent: 'none' };
    case 'scroll': {
      const nextScroll = Math.max(0, Math.min(maxScroll, state.scroll + key.delta));
      return { state: { ...state, scroll: nextScroll }, intent: 'none' };
    }
  }
}
