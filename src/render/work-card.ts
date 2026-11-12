/** Stems and tracks: one title band, a two-cell state gutter, whole factual sentences. */
import type { WorkCard } from '../collectors/work-card.js';
import { targetKey } from '../collectors/workboard-types.js';
import type { MonitorState } from './monitor.js';
import { theme, visualLength, truncateAnsi } from './colors.js';
import { fit, pair, monitorText, flowLines } from './monitor-text.js';
import { t } from './i18n.js';
import { displayConfig } from './hud-config.js';
import { mark } from './workboard-rows.js';
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
          ? mark('●', '*')
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
/** Only syntactic identifiers get emphasis until AI-THIN. */
export function identifiers(text: string): string {
  return monitorText(text)
    .replace(/`[^`]+`|(?:\.?\.?\/|~\/)[^\s,;]+|\b[\w.-]+\/[\w/.-]+|--[\w-]+/g, (s) => theme.board.identifier(s))
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
function jobSentenceRows(raw: string, width: number, ink: (s: string) => string, full: boolean): string[] {
  const safe = monitorText(raw).replace(/\s+/g, ' ').trim(),
    room = Math.max(1, width - 3);
  const spans = [...safe.matchAll(/«([^«»]+)»/g)];
  const valid = spans.length > 0 && spans.length <= 3 && !/[«»]/.test(safe.replace(/«[^«»]+»/g, ''));
  const plain = safe.replace(/[«»]/g, '');
  let text = truncateAnsi(plain, room);
  if (text !== plain) {
    const head = text.slice(0, -1),
      space = head.lastIndexOf(' ');
    text = (space > 0 ? head.slice(0, space) : head) + '…';
  }
  const ranges = valid
    ? spans.map((s) => {
        const start = safe.slice(0, s.index).replace(/[«»]/g, '').length;
        return [start, start + s[1].length];
      })
    : [];
  let offset = 0;
  return (full ? flowLines(plain, room) : [text]).map((line) => {
    const start = full ? plain.indexOf(line, offset) : 0;
    let painted = '',
      cursor = 0;
    for (const [a, b] of ranges) {
      const from = Math.max(cursor, a - start),
        to = Math.min(line.length, b - start);
      if (from >= to) continue;
      painted += line.slice(cursor, from) + theme.board.identifier(line.slice(from, to));
      cursor = to;
    }
    painted += line.slice(cursor);
    offset = start + line.length;
    return fit(`${ink(mark('┃', '|'))} ${painted}`, width);
  });
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
export function workCardDetail(card: WorkCard, sentence = ''): string {
  return sentence || card.worker.ask || card.worker.work?.reason || (card.reason ? t(card.reason) : '');
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
export function workCardName(card: WorkCard, _state: MonitorState, width: number) {
  const right = [workStateWord(card), ageText(card.elapsedMinutes ?? 0)].filter(Boolean).join(' ');
  const role = monitorText(card.role),
    x = 2 + visualLength(role) + 2;
  return {
    text: truncateAnsi(monitorText(card.title), Math.max(0, width - x - visualLength(right) - 2)),
    x,
    right,
    role,
  };
}
export function renderWorkCard(card: WorkCard, state: MonitorState, width: number, sentence = ''): readonly string[] {
  const ink = workStateInk(card),
    name = workCardName(card, state, width);
  const rows = [
    theme.board.title(pair(`${ink(workStateGlyph(card))} ${name.role}  ${name.text}`, ink(name.right), width)),
  ];
  // Open questions have their complete expandable slab above the lanes on Home.
  const generated = card.worker.modelSentence;
  const open = state.boardExpanded?.has(
    targetKey({ kind: 'worker', laneId: card.worker.laneId, workerId: card.worker.id })
  );
  if (generated) rows.push(...jobSentenceRows(generated, width, ink, Boolean(open)));
  for (const part of generated && !open ? [] : [workCardDetail(card, sentence)])
    if (part) rows.push(...stemLines(part, width, ink));
  return rows.map((line, i) => (i ? (failed(card) ? theme.board.failedBody : theme.board.body)(line) : line));
}
