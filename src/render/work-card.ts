/** Compact cards shared by Work and Home's peek. Pure; no execution or model scheduling. */
import type { WorkCard } from '../collectors/work-card.js';
import { summarySentence } from '../utils/summary-sentence.js';
import { fit, flowLines, monitorText, pair, plainText } from './monitor-text.js';
import { colors, theme, truncateAnsi, visualLength } from './colors.js';
import { displayConfig } from './hud-config.js';
import { language, t } from './i18n.js';
import type { MonitorState } from './monitor.js';
import type { WorkRole } from './palette.js';
import { mark } from './workboard-rows.js';
export function cardSentence(text: string): string {
  const lines = plainText(text)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*•]\s+|^\d+[.)]\s+/, ''));
  const line = lines.find(
    (line) => line && !/^(?:basis|caveats?|evidence|依据|根据|注意事项|局限|限制)(?:\s*[:：]|$)/i.test(line)
  );
  if (!line) return '';
  const meaningful = line.replace(/^(?:summary|digest|result|摘要|总结|结果)\s*[:：]\s*/i, '');
  return monitorText(
    summarySentence(
      meaningful.split(/\s+·\s+(?=(?:basis|caveats?|evidence|依据|根据|注意事项|局限|限制)\s*[:：])/i)[0].trim() ||
        meaningful
    )
  );
}
export const workStateWord = (card: WorkCard) =>
  t(
    card.state === 'needs-you'
      ? 'needs you'
      : card.state === 'in-progress'
        ? 'working'
        : card.state === 'awaiting-acceptance'
          ? 'to accept'
          : card.state
  );
export const workStateGlyph = (card: WorkCard) =>
  card.state === 'needs-you'
    ? '?'
    : card.state === 'stalled'
      ? mark('◷', '~')
      : card.state === 'in-progress'
        ? mark('▸', '>')
        : mark('✓', '+');
export const workStateInk = (card: WorkCard) =>
  card.state === 'needs-you'
    ? theme.board.attention
    : card.state === 'stalled'
      ? theme.board.muted
      : card.state === 'in-progress'
        ? theme.board.active
        : card.state === 'done'
          ? theme.board.success
          : theme.value;
const minutes = (n: number) => t(n < 1 ? '<1m' : '{n}m', { n });
export function workRequestDetail(card: WorkCard, full = false): string {
  const request = card.worker.work?.requestInfo;
  if (!request) return '';
  const action = `${t('answer')} ${monitorText(request.id)}`;
  const fallback = request.suggested ? t('default {value}', { value: monitorText(request.suggested) }) : '';
  if (!full) return [action, fallback, monitorText(request.question)].filter(Boolean).join(mark(' · ', ' . '));
  return [action, request.question, ...request.options, fallback].filter(Boolean).map(monitorText).join('\n');
}
export function workCardDetail(card: WorkCard, sentence = ''): string {
  if (card.reason === 'Decision requested; inspect the job' && card.worker.work?.requestInfo)
    return workRequestDetail(card);
  if (card.reason === 'Decision requested; inspect the job' && card.worker.work?.requestId)
    return t('answer {id}; inspect the job', { id: monitorText(card.worker.work.requestId) });
  if (card.reason === 'No new activity') return `${t(card.reason)} ${minutes(card.inactivityMinutes ?? 0)}`;
  if (card.reason && ['needs-you', 'stalled'].includes(card.state)) return t(card.reason);
  const facts = card.worker.work?.reported;
  const reported = facts
    ? [
        facts.tests !== null ? t('reported {n} tests', { n: facts.tests }) : '',
        facts.failed !== null ? t('{n} failed', { n: facts.failed }) : '',
        facts.files !== null ? t('{n} files', { n: facts.files }) : '',
      ]
        .filter(Boolean)
        .join(mark(' · ', ' . '))
    : '';
  return [reported, sentence || (!reported && card.reason ? t(card.reason) : '')]
    .filter(Boolean)
    .join(mark(' · ', ' . '));
}
function expandedDetail(card: WorkCard, sentence: string, fullDetail: string) {
  return [
    card.worker.work?.requestInfo && card.reason === 'Decision requested; inspect the job'
      ? workRequestDetail(card, true)
      : workCardDetail(card),
    (fullDetail || sentence)
      .split(/\r?\n/)
      .map((line) => monitorText(plainText(line)))
      .join('\n'),
    ...card.phases.map(workPhaseText),
  ]
    .filter(Boolean)
    .join('\n');
}
export function workCardHeight(
  card: WorkCard,
  sentence = '',
  expanded = false,
  fullDetail = sentence,
  width = 56
): number {
  const base = 1 + Number(card.phases.length > 0) + Number(!!workCardDetail(card, sentence));
  return (
    base +
    (expanded
      ? expandedDetail(card, sentence, fullDetail)
          .split('\n')
          .filter(Boolean)
          .reduce((n, p) => n + flowLines(p, Math.max(1, width - 2)).length, 0)
      : 0)
  );
}
export function workCardName(card: WorkCard, state: MonitorState, width: number) {
  const age =
    state.cardVisibility?.cardClock !== false && card.elapsedMinutes !== null ? minutes(card.elapsedMinutes) : '';
  const right = [workStateWord(card), age].filter(Boolean).join(' ');
  const fullRole = monitorText(card.role === 'agent' ? t('agent') : card.role);
  // Below the 44-column layout, abbreviate an unspecified role rather than erasing the subject's identity.
  const role =
    card.role === 'agent' && width < 36
      ? '?'
      : Object.hasOwn(theme.board.roleInk, card.role.toLowerCase())
        ? fullRole
        : truncateAnsi(fullRole, 7);
  const room = Math.max(0, width - 4 - visualLength(right) - visualLength(role) - 2);
  return { text: truncateAnsi(monitorText(card.title), room), x: 4 + visualLength(role) + 1, right, role };
}
export function workPhaseText(phase: string): string {
  if (phase.endsWith(' unknown')) return `${workPhaseText(phase.slice(0, -8))} ${t('unknown')}`;
  const review = /^review r([1-9][0-9]*)(?: (accept|changes-required))?$/.exec(phase);
  return review ? `${t('review')} r${review[1]}${review[2] ? ' ' + t(review[2]) : ''}` : monitorText(t(phase));
}
const cache = new Map<string, readonly string[]>();
/** Explicit costs let production-path tests prove cards outside the viewport are not formatted. */
export const workCardCost = { formatted: 0, hits: 0 };
export function renderWorkCard(
  card: WorkCard,
  state: MonitorState,
  width: number,
  sentence = '',
  expanded = false,
  linkName = false,
  fullDetail = sentence
): readonly string[] {
  if (state.cardVisibility?.cardSummary === false) {
    sentence = '';
    fullDetail = '';
  }
  const key = JSON.stringify([
    card.title,
    card.role,
    card.state,
    card.phases,
    card.reason,
    card.worker.work?.reported,
    card.worker.work?.requestId,
    card.worker.work?.requestInfo,
    card.elapsedMinutes,
    card.inactivityMinutes,
    state.cardVisibility?.cardClock !== false,
    state.cardVisibility?.cardSummary !== false,
    state.cardCorners,
    width,
    sentence,
    expanded,
    linkName,
    fullDetail,
    language(),
    displayConfig(),
  ]);
  const cached = cache.get(key);
  if (cached) {
    workCardCost.hits++;
    return cached;
  }
  workCardCost.formatted++;
  const ink = workStateInk(card);
  const roleKey = card.role.toLowerCase() as WorkRole;
  const roleInk = Object.hasOwn(theme.board.roleInk, roleKey) ? theme.board.roleInk[roleKey] : theme.value;
  const corner =
    displayConfig().icons === 'text'
      ? ['[', '|', ']']
      : state.cardCorners === 'round'
        ? ['╭', '│', '╰']
        : ['┌', '│', '└'];
  const name = workCardName(card, state, width);
  const title = linkName ? colors.underline(name.text) : name.text;
  const lines = [
    pair(
      `${roleInk(corner[0])} ${ink(workStateGlyph(card))} ${roleInk(name.role)} ${theme.bold(roleInk(title))}`,
      ink(name.right),
      width
    ),
  ];
  const detail = workCardDetail(card, state.cardVisibility?.cardSummary !== false ? sentence : '');
  if (card.phases.length) {
    const tokens = card.phases.map(workPhaseText);
    // Shed old completed tokens, never the current phase or latest result in favour of old history.
    while (tokens.length > 1 && visualLength(tokens.join(' -> ')) > width - 4) tokens.shift();
    const text = tokens.join(mark(' → ', ' > '));
    lines.push(`${roleInk(corner[detail ? 1 : 2])} ${truncateAnsi(text, Math.max(0, width - 2))}`);
  }
  if (detail) lines.push(`${roleInk(corner[2])} ${truncateAnsi(detail, Math.max(0, width - 2))}`);
  if (expanded) {
    const full = expandedDetail(card, sentence, fullDetail);
    for (const paragraph of full.split('\n').filter(Boolean))
      for (const line of flowLines(paragraph, Math.max(1, width - 2))) lines.push(`${roleInk(corner[1])} ${line}`);
  }
  const result = lines.map((line) => fit(line, width));
  cache.set(key, result);
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return result;
}
