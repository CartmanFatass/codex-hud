/** Stems and tracks: one title band, a two-cell state gutter, whole factual sentences. */
import type { WorkCard } from '../collectors/work-card.js';
import { targetKey } from '../collectors/workboard-types.js';
import type { MonitorState } from './monitor.js';
import { theme, visualLength, truncateAnsi } from './colors.js';
import { fit, pair, monitorText, flowLines } from './monitor-text.js';
import { t } from './i18n.js';
import { displayConfig } from './hud-config.js';
import { mark } from './workboard-rows.js';
import { keywordMarks } from '../utils/keyword-marks.js';
export const cardSentence = (text: string): string => monitorText(text.split(/\r?\n/).find((l) => l.trim()) ?? '');
export const failed = (card: WorkCard) => card.worker.work?.failed || ['failed', 'error'].includes(card.worker.state);
export const workStateWord = (card: WorkCard) => {
  if (card.worker.state === 'stopped') return t('stopped');
  return t(
    failed(card)
      ? 'failed'
      : card.state === 'needs-you'
        ? 'asking'
        : card.state === 'in-progress'
          ? ''
          : card.state === 'awaiting-acceptance'
            ? 'report ready'
            : card.state
  );
};
export const workStateGlyph = (card: WorkCard) => {
  if (card.worker.state === 'stopped') return mark('−', '-');
  return failed(card)
    ? mark('✗', 'x')
    : card.state === 'needs-you'
      ? '?'
      : card.state === 'stalled'
        ? mark('◷', '~')
        : card.state === 'in-progress'
          ? mark('◉', '@')
          : mark('✓', '+');
};
export const workStateInk = (card: WorkCard) => {
  if (card.worker.state === 'stopped') return theme.board.muted;
  return failed(card)
    ? theme.board.danger
    : card.state === 'needs-you'
      ? theme.board.attention
      : card.state === 'stalled'
        ? theme.board.stalled
        : card.state === 'in-progress'
          ? theme.board.active
          : theme.board.success;
};
export function ageText(minutes: number): string {
  return minutes < 60 ? t('{n}m', { n: minutes }) : t('{h}h{m}m', { h: Math.floor(minutes / 60), m: minutes % 60 });
}
/** Paths, filenames, code and flags share the deterministic identifier ink. */
const identifierPattern = /`[^`]+`|(?:\.?\.?\/|~\/)[^\s,;，。；]+|\b[\w.-]+\/[\w/.-]+|\b[\w.-]+\.[a-zA-Z][\w-]*\b|--[\w-]+/g;
export const cardExpanded = (state: MonitorState, key: string) =>
  state.boardExpanded?.has(key) || (state.boardNewest === key && !state.boardToggled?.has(key));
export function identifiers(text: string): string {
  return monitorText(text)
    .replace(identifierPattern, (s) => theme.board.identifier(s))
    .replace(
      new RegExp(`(${t('default')}: )([a-zA-Z])([).,:])`),
      (_match, before, letter, after) => before + theme.board.askTitle(letter) + after
    );
}
/** `max` keeps the first lines and cuts the rest into the last one with `…`. */
export function stemLines(text: string, width: number, ink = theme.board.muted, max = Infinity): string[] {
  const room = Math.max(1, width - 3);
  let lines = flowLines(monitorText(text), room);
  if (lines.length > max) lines = [...lines.slice(0, max - 1), truncateAnsi(lines.slice(max - 1).join(' '), room)];
  return lines.map((line) => fit(`${ink(mark('┃', '|'))} ${identifiers(line)}`, width));
}
/** Model marks are presentation only; malformed marks leave a plain single line. */
export function jobSentenceLine(raw: string, width: number, ink = theme.board.muted): string {
  return jobSentenceRows(raw, width, ink, false)[0];
}
export function jobSentenceRows(raw: string, width: number, ink: (s: string) => string, full: boolean): string[] {
  const safe = monitorText(raw).replace(/\s+/g, ' ').trim(),
    room = Math.max(1, width - 3);
  const { plain, valid } = keywordMarks(safe);
  let text = truncateAnsi(plain, room);
  if (text !== plain) {
    const head = text.slice(0, -1),
      space = head.lastIndexOf(' ');
    text = (space > 0 ? head.slice(0, space) : head) + '…';
  }
  let offset = 0;
  return (full && valid ? flowLines(plain, room) : [text]).map((line) => {
    const start = full && valid ? plain.indexOf(line, offset) : 0;
    const painted = paintSentence(safe, line, start);
    offset = start + line.length;
    return fit(`${ink(mark('┃', '|'))} ${painted}`, width);
  });
}
/** Paint visible text after cutting/wrapping; file spans override model categories. */
export function paintSentence(raw: string, line?: string, start = 0): string {
  const { plain, spans } = keywordMarks(monitorText(raw));
  line ??= plain;
  const unpainted = (s: string) => s;
  const inks = Array.from({ length: line.length }, () => unpainted);
  for (const span of spans) {
    const ink =
      span.type === '+' ? theme.board.success :
      span.type === '-' ? theme.board.danger :
      span.type === '!' ? (displayConfig().icons === 'text' ? unpainted : theme.board.opinion) :
      theme.board.identifier;
    for (let i = Math.max(0, span.start - start); i < Math.min(line.length, span.end - start); i++) inks[i] = ink;
  }
  for (const m of plain.matchAll(identifierPattern))
    for (let i = Math.max(0, m.index! - start); i < Math.min(line.length, m.index! + m[0].length - start); i++)
      inks[i] = theme.board.identifier;
  let painted = '';
  for (let i = 0; i < line.length; ) {
    let end = i + 1;
    while (end < line.length && inks[end] === inks[i]) end++;
    painted += inks[i](line.slice(i, end));
    i = end;
  }
  return painted;
}
/** An open question as its paragraphs; the context and every option only when `full`. */
export function requestLines(card: WorkCard, full = false): string[] {
  const r = card.worker.work?.requestInfo;
  return r
    ? [
        r.question,
        ...(full ? [r.context ? `${t('blocked')} ${r.context}` : '', ...r.options] : []),
        r.suggested ? `${t('default')}: ${r.suggested}` : '',
      ].filter(Boolean)
    : [];
}
export const workRequestDetail = (card: WorkCard, full = false): string => requestLines(card, full).join('\n');
const QUIET_REASONS: Record<string, string> = {
  'no-key': 'no key',
  cap: 'cap',
  error: 'error',
  'max-questions': 'max questions',
  'prompt-failed': 'prompt failed',
};
export function quietDecisionSummary(q: WorkCard['worker']['quietDecision']): string {
  if (!q) return '';
  const action = t(q.action);
  if (q.choice !== null && q.probability !== null) {
    return `${t(q.choice)} ${Math.round(q.probability * 100)}% ${mark('→', '->')} ${action}`;
  }
  const detail = q.reason ? t(QUIET_REASONS[q.reason] ?? q.reason) : '';
  return detail ? `${action} (${detail})` : action;
}
export function workCardDetail(card: WorkCard, sentence = ''): string {
  const showQuiet =
    card.worker.settledAt === null || (failed(card) && card.worker.quietDecision?.action === 'fail');
  const quiet = showQuiet ? quietDecisionSummary(card.worker.quietDecision) : '';
  const detail =
    sentence ||
    card.worker.ask ||
    (card.worker.work?.reason ? t(card.worker.work.reason) : card.reason ? t(card.reason) : '');
  return [quiet, detail].filter(Boolean).join(' · ');
}
export function workPhaseText(phase: string): string {
  return monitorText(phase).replace(
    /reviewing|researching|working|generating|asking web|build|review|accept|done|fixing|asking|failed|stopped|major|minor/g,
    (word) => t(word)
  );
}
export function phaseChain(card: WorkCard): string {
  return card.phases
    .map((p, i) => {
      const text = workPhaseText(p);
      return (i === card.phases.length - 1 && !/✓|accept|done/.test(p) ? mark('▸', '>') : '') + text;
    })
    .join(mark(' › ', ' > '));
}
export function labelSummary(labels: WorkCard['worker']['labels']): string {
  return [labels?.outcome ? `[${t(labels.outcome.value)}]` : '',
    ...(labels?.severity ?? []).map((n, i) => n ? `${n} ${t(['must fix', 'should fix', 'optional'][i])}` : '')].filter(Boolean).join(' · ');
}
export function workCardName(card: WorkCard, _state: MonitorState, width: number) {
  const labels = card.worker.labels;
  const right = [labels?.looping !== undefined ? `${mark('⚠', '!')} ${t('looping')}` : '',
    labels?.outcome ? `[${t(labels.outcome.value)}]` : '', workStateWord(card), ageText(card.elapsedMinutes ?? 0)].filter(Boolean).join(' ');
  const role = monitorText(card.role),
    x = 2 + visualLength(role) + 2;
  return {
    text: truncateAnsi(
      monitorText(
        card.title +
          ((card.worker.nativeDepth ?? 0) > 2 && card.worker.parentName ? ` ↳ ${card.worker.parentName}` : '')
      ),
      Math.max(0, width - x - visualLength(right) - 2)
    ),
    x,
    right,
    role,
  };
}
/** Rows a collapsed card's sentence may use; the sentence prompt's length limit is sized for it. */
export const SENTENCE_ROWS = 2;
export function renderWorkCard(card: WorkCard, state: MonitorState, width: number, sentence = ''): readonly string[] {
  const ink = workStateInk(card),
    name = workCardName(card, state, width);
  const rows = [
    theme.board.title(pair(`${ink(workStateGlyph(card))} ${name.role}  ${name.text}`, ink(name.right), width)),
  ];
  // Open questions have their complete expandable slab above the lanes on Home.
  const generated = card.worker.modelSentence;
  const open = cardExpanded(
    state,
    targetKey({ kind: 'worker', laneId: card.worker.laneId, workerId: card.worker.id })
  );
  // Collapsed: the sentence on at most two rows (the prompt keeps it that short). Open: everything.
  if (generated) {
    const lines = jobSentenceRows(generated, width, ink, true);
    rows.push(...(open || lines.length <= SENTENCE_ROWS ? lines : [lines[0], fit(truncateAnsi(lines[1].trimEnd(), width - 1) + '…', width)]));
  }
  for (const part of generated && !open ? [] : [workCardDetail(card, sentence)])
    if (part) rows.push(...stemLines(part, width, ink, open ? Infinity : SENTENCE_ROWS));
  // A collapsed card keeps a fixed height, so a sentence arriving or growing does not move the cards below it.
  if (!open && rows.length === 1) rows.push(fit(`${ink(mark('┃', '|'))} ${theme.board.muted('…')}`, width));
  while (!open && rows.length < 1 + SENTENCE_ROWS) rows.push(fit(ink(mark('┃', '|')), width));
  return rows.map((line, i) => (i ? (failed(card) ? theme.board.failedBody : theme.board.body)(line) : line));
}
