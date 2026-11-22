/** Stems and tracks: one title band, a two-cell state gutter, whole factual sentences. */
import type { WorkCard } from '../collectors/work-card.js';
import { targetKey, type WorkFlow, type WorkFlowStep } from '../collectors/workboard-types.js';
import type { MonitorState } from './monitor.js';
import { theme, visualLength, truncateAnsi } from './colors.js';
import { fit, pair, monitorText, flowLines } from './monitor-text.js';
import { t } from './i18n.js';
import { displayConfig } from './hud-config.js';
import { mark, originalRows } from './workboard-rows.js';
import { keywordMarks } from '../utils/keyword-marks.js';
import { isUnreadReport, sonicBadge, workerModelBadge } from './worker-roster.js';
import { activeFlow } from './work-visibility.js';
export const cardSentence = (text: string): string => monitorText(text.split(/\r?\n/).find((l) => l.trim()) ?? '');
export const failed = (card: WorkCard) => card.worker.work?.failed || ['failed', 'error'].includes(card.worker.state);
export const workStateWord = (card: WorkCard) => {
  if (card.worker.superseded) return t('superseded');
  if (card.worker.state === 'stopped') return t('stopped');
  if (card.state === 'queued') {
    return card.worker.queuePosition !== undefined
      ? t('queued #{n}', { n: card.worker.queuePosition })
      : t('queued');
  }
  if (failed(card)) return t('failed');
  if (card.state === 'needs-you') return t('asking');
  if (card.state === 'stalled') return t('stalled');
  if (card.worker.flow && activeFlow(card.worker)) return t('land');
  return '';
};
export const workStateGlyph = (card: WorkCard) => {
  if (card.worker.state === 'stopped') return mark('−', '-');
  if (card.state === 'queued') return mark('◷', '~');
  if (failed(card)) return mark('✗', 'x');
  if (card.state === 'needs-you') return '?';
  if (card.state === 'stalled') return mark('◷', '~');
  if (card.state === 'in-progress') return mark('◉', '@');
  if (isUnreadReport(card.worker)) return mark('✓●', '+*');
  return mark('✓', '+');
};
export const workStateInk = (card: WorkCard) => {
  if (card.worker.superseded || card.worker.state === 'stopped' || card.state === 'queued') return theme.board.muted;
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
    /reviewing|researching|working|generating|asking web|scouting|landing|queued|build|review|accept|done|fixing|asking|failed|stopped|major|minor/g,
    (word) => t(word)
  );
}
function landWait(step: string) {
  return /^waiting for (f[a-f0-9]{16}(?:-[1-9]\d*)?)(?: \(gate step (\d+), (\d+) min\))?$/.exec(step);
}
export function flowStepDetail(step: string): string {
  const safe = monitorText(step);
  const wait = landWait(safe);
  if (wait) {
    const [, flow, n, m] = wait;
    return n === undefined ? t('waiting for {flow}', { flow }) : t('waiting for {flow} (gate step {n}, {m} min)', { flow, n, m });
  }
  if (safe === 'main-checkout lease') return t('queued');
  if (safe === 'prepare' || safe === 'cherry-pick' || safe === 'records' || safe === 'fast-forward' || safe === 'cleanup')
    return t(safe);
  if (safe === 'push' || safe === 'done') return '';
  const gate = /^gate\[(\d+)\]:\s*(.*)$/.exec(safe);
  if (gate) return `${t('gate')}[${gate[1]}]: ${gate[2]}`;
  const after = /^after\[(\d+)\]:\s*(.*)$/.exec(safe);
  if (after) return `${t('after')}[${after[1]}]: ${after[2]}`;
  const repair = /^repair (\d+)$/.exec(safe);
  if (repair) return `${t('repair')} ${repair[1]}`;
  return safe;
}
function flowOutcome(flow: WorkFlow): string {
  if (flow.kind === 'land') {
    if (flow.state === 'completed') return flow.landedSha ? `${t('landed')} ${flow.landedSha}` : t('landed');
    if (flow.state === 'cancelled') return t('cancelled');
    if (flow.state === 'failed') {
      const error = flow.error === 'timeout' ? t('timeout') : flow.error ? monitorText(flow.error) : '';
      const fail = error ? t('{label}: {value}', { label: t('failed'), value: error }) : t('failed');
      return flow.landedSha ? `${t('landed')} ${flow.landedSha} · ${fail}` : fail;
    }
    return flow.step ? flowStepDetail(flow.step) : '';
  }
  if (flow.state === 'completed') return t('done');
  if (flow.state === 'failed') return t('failed');
  if (flow.state === 'cancelled') return t('stopped');
  return flow.steps[0]?.state === 'failed' ? t('scout failed') : '';
}
export function flowSummary(flow: WorkFlow): string {
  const sep = mark(' ▸ ', ' > ');
  const glyph = (s: WorkFlowStep['state']) =>
    s === 'active' ? (flow.state === 'queued' ? mark('◷', '~') : mark('◉', '@'))
      : s === 'done' ? mark('✓', '+')
      : s === 'failed' ? mark('✗', 'x')
      : s === 'cancelled' ? mark('−', '-')
      : '';
  const chain = flow.steps.map((s) => `${glyph(s.state) ? glyph(s.state) + ' ' : ''}${t(s.key)}`).join(sep);
  const tail = flowOutcome(flow);
  return tail ? `${chain} · ${tail}` : chain;
}
export function flowLine(flow: WorkFlow, width: number, ink: (s: string) => string): string {
  const wait = flow.kind === 'land' && flow.state === 'queued' && landWait(flow.step ?? '');
  if (wait) {
    const tail = flowOutcome(flow), [, holder, n, m] = wait;
    const detail = n !== undefined && visualLength(tail) > width - 2 ? t('wait {flow} · gate {n}, {m}m', { flow: holder, n, m }) : tail;
    return fit(`${ink(mark('┃', '|'))} ${theme.board.muted(truncateAnsi(detail, width - 2))}`, width);
  }
  const sep = theme.board.muted(mark(' ▸ ', ' > '));
  const chain = flow.steps.map((s) => {
    const label = t(s.key);
    if (s.state === 'active') {
      return flow.state === 'queued'
        ? theme.board.muted(`${mark('◷', '~')} ${label}`)
        : theme.board.active(`${mark('◉', '@')} ${label}`);
    }
    if (s.state === 'done') return theme.board.success(`${mark('✓', '+')} ${label}`);
    if (s.state === 'failed') return theme.board.danger(`${mark('✗', 'x')} ${label}`);
    if (s.state === 'cancelled') return theme.board.muted(`${mark('−', '-')} ${label}`);
    return theme.board.muted(label);
  }).join(sep);
  const head = `${ink(mark('┃', '|'))} ${chain}`;
  const tail = flowOutcome(flow);
  if (!tail) return fit(truncateAnsi(head, width), width);
  const tailInk = flow.state === 'completed' ? theme.board.success : flow.state === 'failed' ? theme.board.danger : theme.board.muted;
  const room = width - visualLength(head) - 3;
  if (room < 4) return fit(truncateAnsi(head, width), width);
  return fit(`${head}${theme.board.muted(' · ')}${tailInk(truncateAnsi(tail, room))}`, width);
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
const cardRoleInk = (role: string) =>
  (theme.board.roleInk as Record<string, (s: string) => string>)[role] ?? ((s: string) => s);
export interface RenderCardOptions {
  /** Active sonic children count folded onto this parent row as `⚡N`. */
  sonic?: number;
  /** Secondary workers (routine running, queued, read settled) pack into one row until Enter expands. */
  compact?: boolean;
}
/** What a job's title row says between its model mark and its age: the checks chip, `badge`, `⚠ looping`, the `[outcome]` label and the state `word`. */
export function cardMarks(card: WorkCard, badge = '', word = workStateWord(card)): string[] {
  const labels = card.worker.labels, outcomeVal = labels?.outcome?.value, ink = workStateInk(card);
  const outcome =
    outcomeVal && t(outcomeVal) !== word && !(outcomeVal === 'done' && !failed(card) && card.worker.settledAt !== null)
      ? `[${t(outcomeVal)}]`
      : '';
  const wordInk = card.worker.flow && activeFlow(card.worker) && word === t('land') ? theme.board.active : ink;
  return [
    checkChip(card.worker.checks),
    badge,
    labels?.looping !== undefined ? ink(`${mark('⚠', '!')} ${t('looping')}`) : '',
    outcome ? ink(outcome) : '',
    word ? wordInk(word) : '',
  ].filter(Boolean);
}
function workCardName(card: WorkCard, _state: MonitorState, width: number, badge = '', opts: RenderCardOptions = {}) {
  const ink = workStateInk(card), marks = cardMarks(card, badge);
  const sonic = sonicBadge(opts.sonic ?? 0);
  const age = theme.board.muted(ageText(card.elapsedMinutes ?? 0));
  const glyph = workStateGlyph(card);
  const role = monitorText(card.role);
  const paintedRole = card.worker.superseded ? theme.board.muted(role) : cardRoleInk(card.role)(role);
  const prefix = `${ink(glyph)} ${paintedRole}  `;
  const titleRaw = monitorText(
    card.title + ((card.worker.nativeDepth ?? 0) > 2 && card.worker.parentName ? ` ↳ ${card.worker.parentName}` : '')
  );
  const makeRight = (lvl: '' | 'full' | 'compact' | 'min') =>
    [lvl ? workerModelBadge(card.worker, lvl) : '', sonic, ...marks, age].filter(Boolean).join(' ');
  const minTitle = Math.min(visualLength(titleRaw), 26);
  let right = makeRight('');
  for (const lvl of ['full', 'compact', 'min', ''] as const) {
    const cand = makeRight(lvl);
    if (visualLength(prefix) + minTitle + 2 + visualLength(cand) <= width) {
      right = cand;
      break;
    }
  }
  return {
    prefix,
    text: truncateAnsi(titleRaw, Math.max(0, width - visualLength(prefix) - visualLength(right) - 2)),
    right,
    role,
  };
}
/** Rows a collapsed card's sentence may use; the sentence prompt's length limit is sized for it. */
export const SENTENCE_ROWS = 2;
export function renderWorkCard(
  card: WorkCard,
  state: MonitorState,
  width: number,
  sentence = '',
  badge = '',
  opts: RenderCardOptions = {}
): readonly string[] {
  const ink = workStateInk(card),
    name = workCardName(card, state, width, badge, opts);
  const open = cardExpanded(
    state,
    targetKey({ kind: 'worker', laneId: card.worker.laneId, workerId: card.worker.id })
  );
  const titleLine = pair(`${name.prefix}${name.text}`, name.right, width);
  if (opts.compact && !open) return [titleLine];
  const rows = [theme.board.title(titleLine)];
  // Open questions have their complete expandable slab above the lanes on Home.
  const step = card.worker.transcriptStep;
  const excerpt = step ? cardSentence(step.text) : '';
  const generated = step?.replaying && excerpt ? undefined : card.worker.modelSentence;
  if (card.worker.flow) rows.push(flowLine(card.worker.flow, width, ink));
  const bodyMax = open ? Infinity : card.worker.flow ? SENTENCE_ROWS - 1 : SENTENCE_ROWS;
  // Collapsed prominent cards show only actual content (flow, error, unread summary), never empty placeholder pipes.
  if (generated) {
    const lines = jobSentenceRows(generated, width, ink, true);
    rows.push(
      ...(open || lines.length <= bodyMax
        ? lines
        : [
            ...lines.slice(0, bodyMax - 1),
            fit(truncateAnsi(lines[bodyMax - 1].trimEnd(), width - 1) + '…', width),
          ])
    );
  }
  // A localized worker summary replaces its original, rather than adding a second result line.
  if (!generated && excerpt) {
    rows.push(fit(`${ink(mark('┃', '|'))} ${excerpt}`, width));
  } else if (!generated || (open && !card.worker.reportMeta?.summary)) {
    const detail = workCardDetail(card, sentence);
    if (detail) rows.push(...stemLines(detail, width, ink, bodyMax));
  }
  return rows.map((line, i) => (i ? (failed(card) ? theme.board.failedBody : theme.board.body)(line) : line));
}
