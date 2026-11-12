/** Stems and tracks: one title band, a two-cell state gutter, whole factual sentences. */
import type { WorkCard } from '../collectors/work-card.js';
import type { MonitorState } from './monitor.js';
import { theme, visualLength, truncateAnsi } from './colors.js';
import { fit, pair, monitorText, flowLines } from './monitor-text.js';
import { t } from './i18n.js';
import { displayConfig } from './hud-config.js';
import { providerMark } from './providers.js';
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
  return monitorText(text).replace(/`[^`]+`|(?:\.?\.?\/|~\/)[^\s,;]+|\b[\w.-]+\/[\w/.-]+|--[\w-]+/g, (s) =>
    theme.board.identifier(s)
  );
}
/** `max` keeps the first lines and cuts the rest into the last one with `…`. */
export function stemLines(text: string, width: number, ink = theme.board.muted, max = Infinity): string[] {
  const room = Math.max(1, width - 3);
  let lines = flowLines(monitorText(text), room);
  if (lines.length > max) lines = [...lines.slice(0, max - 1), truncateAnsi(lines.slice(max - 1).join(' '), room)];
  return lines.map((line) => fit(`${ink(mark('┃', '|'))} ${identifiers(line)}`, width));
}
/** An open question as its paragraphs; the context and every option only when `full`. */
export function requestLines(card: WorkCard, full = false): string[] {
  const r = card.worker.work?.requestInfo;
  return r
    ? [
        r.question,
        ...(full ? [r.context ? `${t('blocked')} ${r.context}` : '', ...r.options] : []),
        r.suggested ? `${t('default')} ${r.suggested}` : '',
      ].filter(Boolean)
    : [];
}
export const workRequestDetail = (card: WorkCard, full = false): string => requestLines(card, full).join('\n');
export function workCardDetail(card: WorkCard, sentence = ''): string {
  return sentence || card.worker.ask || card.worker.work?.reason || (card.reason ? t(card.reason) : '');
}
export function workPhaseText(phase: string): string {
  return monitorText(phase).replace(/reviewing|researching|working|generating|asking web|build|review|accept|done|fixing|asking|failed|stopped|major|minor/g, (word) => t(word));
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
  if (state.mainTab === 'work') {
    const w = card.worker,
      model = w.model ?? '';
    const vendor = providerMark(
      { id: model, provider: w.provider },
      displayConfig().icons === 'text' || displayConfig().glyphs === 'text'
    );
    const chip = [
      vendor?.glyph,
      model.replace(/^[^/]+\//, ''),
      w.effort,
      w.harness !== 'pi' ? w.harness : '',
      w.nodeId ? t('native') : '',
    ]
      .filter(Boolean)
      .join(' ');
    if (chip) rows.push(...stemLines(chip, width, ink));
    if (card.phases.length) {
      // Wrap plain history, then paint each phase (including its continuation lines).
      const inks = card.phases.map((p) =>
        /major/.test(p)
          ? theme.board.attention
          : /minor/.test(p)
            ? theme.board.muted
            : /accept/.test(p)
              ? theme.board.success
              : theme.value
      );
      let phase = 0;
      for (const line of flowLines(phaseChain(card), Math.max(1, width - 3))) {
        const painted = line
          .split(/(›|(?<!\S)>(?!\S))/u)
          .map((part) => {
            if (part === mark('›', '>')) {
              phase++;
              return part;
            }
            return inks[phase](part);
          })
          .join('');
        rows.push(fit(`${ink(mark('┃', '|'))} ${painted}`, width));
      }
    }
  }
  // Work prints an open question whole; Home's card is the short one in home-view.
  const asking = state.mainTab === 'work' && card.worker.homeNeedsHuman ? requestLines(card, true) : [];
  for (const part of asking.length ? asking : [workCardDetail(card, sentence)])
    if (part) rows.push(...stemLines(part, width, ink));
  return rows.map((line, i) => (i ? (failed(card) ? theme.board.failedBody : theme.board.body)(line) : line));
}
