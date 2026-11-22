/** Stems and tracks: one title band, a two-cell state gutter, whole factual sentences. */
import type { WorkCard } from '../collectors/work-card.js';
import { targetKey } from '../collectors/workboard-types.js';
import type { MonitorState } from './monitor.js';
import { theme, visualLength, truncateAnsi } from './colors.js';
import { fit, pair, monitorText, flowLines } from './monitor-text.js';
import { t } from './i18n.js';
import { displayConfig } from './hud-config.js';
import { mark, originalRows } from './workboard-rows.js';
import { keywordMarks } from '../utils/keyword-marks.js';
export const cardSentence = (text: string): string => monitorText(text.split(/\r?\n/).find((l) => l.trim()) ?? '');
export const failed = (card: WorkCard) => card.worker.work?.failed || ['failed', 'error'].includes(card.worker.state);
export const workStateWord = (card: WorkCard) => {
  if (card.worker.superseded) return t('superseded');
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
  if (card.worker.superseded || card.worker.state === 'stopped') return theme.board.muted;
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
export function ageText(minutes: number, padMinutes = false): string {
  const rest = minutes % 60;
  return minutes < 60 ? t('{n}m', { n: minutes }) : t('{h}h{m}m', {
    h: Math.floor(minutes / 60), m: padMinutes ? String(rest).padStart(2, '0') : rest,
  });
}
/** Paths, filenames, code and flags share the deterministic identifier ink. */
const identifierPattern = /`[^`]+`|(?:\.?\.?\/|~\/)[^\s,;，。；]+|\b[\w.-]+\/[\w/.-]+|\b[\w.-]+\.[a-zA-Z][\w-]*\b|--[\w-]+/g;
export const cardExpanded = (state: MonitorState, key: string) =>
  state.home.expanded?.has(key) || (state.home.newestCard === key && !state.home.toggled?.has(key));
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
/** An open question as its paragraphs; the context and every option only when `full`, the first four numbered `[1]`… when `numbered` (the owner can answer it here). */
export function requestLines(card: WorkCard, full = false, numbered = false, original = false): string[] {
  const source = card.worker.work?.requestInfo, r = !original && source?.display || source;
  return r
    ? [
        r.question,
        ...(full ? [r.context ? `${t('blocked')} ${r.context}` : '', ...r.options.map((o, i) => (numbered && i < 4 ? `[${i + 1}] ${o}` : o))] : []),
        r.suggested ? `${t('default')}: ${r.suggested}` : '',
      ].filter(Boolean)
    : [];
}
export function questionOriginalRows(card: WorkCard, state: MonitorState, width: number) {
  const r = card.worker.work?.requestInfo;
  if (!r?.display) return [];
  const item = `original:${card.worker.id}:${r.id}`;
  return originalRows(requestLines(card, true, true, true).join('\n'), item, state.home.expanded.has(item), width);
}
export const workRequestDetail = (card: WorkCard, full = false): string => requestLines(card, full).join('\n');
const QUIET_REASONS: Record<string, string> = {
  'no-key': 'no key',
  cap: 'cap',
  error: 'error',
  'max-questions': 'max questions',
  'prompt-failed': 'prompt failed',
};
export function milestoneLine(worker: WorkCard['worker'], width: number): string | undefined {
  const entry = worker.latest_progress;
  if (entry) return fit(theme.board.muted(`${mark('┃', '|')} ${t('Milestone')}: ${monitorText(entry.text)}`), width);
}
/** Ten one-minute buckets of observed writes as one segment: a quiet minute is blank, eight writes in a minute fill the cell. */
export function sparkline(counts: readonly number[]): string {
  const glyphs = mark('▁▂▃▄▅▆▇█', '..--==##');
  return counts.map((c) => (c > 0 ? glyphs[Math.min(8, c) - 1] : ' ')).join('');
}
/** The running worker's activity row (the Inspector and an expanded card); absent while nothing has been observed. */
export function pulseLine(worker: WorkCard['worker'], width: number): string | undefined {
  if (worker.activity?.some((c) => c > 0))
    return fit(theme.board.muted(`${mark('┃', '|')} ${t('Activity')} `) + theme.board.active(sparkline(worker.activity)) + theme.board.muted(` ${ageText(worker.activity.length)}`), width);
}
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
    card.worker.reportMeta?.summary ||
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
function checkChip(checks: WorkCard['worker']['checks']): string {
  if (!checks) return '';
  const { stale, state, passed, total } = checks;
  const [glyph, ink] = stale ? [mark('~', '~'), theme.board.muted]
    : state === 'running' ? [mark('↻', '@'), theme.board.active]
    : passed === total ? [mark('✓', '+'), theme.board.success] : [mark('✗', 'x'), theme.board.danger];
  return ink(`[${glyph}${passed}/${total}]`);
}
function workCardName(card: WorkCard, _state: MonitorState, width: number, badge = '') {
  const labels = card.worker.labels;
  // The model's outcome mark joins the state word only when it says something else (`[partial] done`, not `[done] done`).
  const word = workStateWord(card), outcome = labels?.outcome && t(labels.outcome.value) !== word ? `[${t(labels.outcome.value)}]` : '';
  const state = [badge, labels?.looping !== undefined ? `${mark('⚠', '!')} ${t('looping')}` : '', outcome, word, ageText(card.elapsedMinutes ?? 0)].filter(Boolean).join(' ');
  const chip = checkChip(card.worker.checks), ink = workStateInk(card);
  const right = chip ? `${chip} ${ink(state)}` : ink(state);
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
export function renderWorkCard(card: WorkCard, state: MonitorState, width: number, sentence = '', badge = ''): readonly string[] {
  const ink = workStateInk(card),
    name = workCardName(card, state, width, badge);
  const rows = [
    theme.board.title(pair(`${ink(workStateGlyph(card))} ${name.role}  ${name.text}`, name.right, width)),
  ];
  // Open questions have their complete expandable slab above the lanes on Home.
  const step = card.worker.transcriptStep;
  const excerpt = step ? cardSentence(step.text) : '';
  const generated = step?.replaying && excerpt ? undefined : card.worker.modelSentence;
  const open = cardExpanded(
    state,
    targetKey({ kind: 'worker', laneId: card.worker.laneId, workerId: card.worker.id })
  );
  // Collapsed: the sentence on at most two rows (the prompt keeps it that short). Open: everything.
  if (generated) {
    const lines = jobSentenceRows(generated, width, ink, true);
    rows.push(...(open || lines.length <= SENTENCE_ROWS ? lines : [lines[0], fit(truncateAnsi(lines[1].trimEnd(), width - 1) + '…', width)]));
  }
  // A localized worker summary replaces its original, rather than adding a second result line.
  if (!generated && excerpt) {
    rows.push(fit(`${ink(mark('┃', '|'))} ${excerpt}`, width));
  } else if (!generated || (open && !card.worker.reportMeta?.summary)) {
    const detail = workCardDetail(card, sentence);
    if (detail) rows.push(...stemLines(detail, width, ink, open ? Infinity : SENTENCE_ROWS));
  }
  // A collapsed card keeps a fixed height, so a sentence arriving or growing does not move the cards below it.
  if (!open && rows.length === 1) rows.push(fit(`${ink(mark('┃', '|'))} ${theme.board.muted('…')}`, width));
  while (!open && rows.length < 1 + SENTENCE_ROWS) rows.push(fit(ink(mark('┃', '|')), width));
  return rows.map((line, i) => (i ? (failed(card) ? theme.board.failedBody : theme.board.body)(line) : line));
}
