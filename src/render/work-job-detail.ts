/** Job evidence rendered in Inspector and Project diagnostics. */
import type { WorkJob } from '../collectors/work-job.js';
import type { WorkFlow, WorkFlowStep } from '../collectors/workboard-types.js';
import { theme, visualLength, truncateAnsi } from './colors.js';
import { fit, monitorText, flowLines } from './monitor-text.js';
import { t } from './i18n.js';
import { displayConfig } from './hud-config.js';
import { mark } from './workboard-rows.js';
import { keywordMarks } from '../utils/keyword-marks.js';
import { failed, workStateInk } from './work-job-row.js';

export const cardSentence = (text: string): string => monitorText(text.split(/\r?\n/).find((l) => l.trim()) ?? '');
/** Paths, filenames, code and flags share the deterministic identifier ink. */
const identifierPattern = /`[^`]+`|(?:\.?\.?\/|~\/)[^\s,;，。；]+|\b[\w.-]+\/[\w/.-]+|\b[\w.-]+\.[a-zA-Z][\w-]*\b|--[\w-]+/g;
export const identifiers = (text: string): string => paintIdentifiers(monitorText(text));
function paintIdentifiers(safe: string): string {
  return safe.replace(identifierPattern, (s) => theme.board.identifier(s))
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
  return lines.map((line) => fit(`${ink(mark('┃', '|'))} ${paintIdentifiers(line)}`, width));
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
export function requestLines(card: WorkJob, full = false, numbered = false, original = false): string[] {
  const source = card.worker.work?.requestInfo, r = !original && source?.display || source;
  return r
    ? [
        r.question,
        ...(full ? [r.context ? `${t('blocked')} ${r.context}` : '', ...r.options.map((o, i) => (numbered && i < 4 ? `[${i + 1}] ${o}` : o))] : []),
        r.suggested ? `${t('default')}: ${r.suggested}` : '',
      ].filter(Boolean)
    : [];
}
const QUIET_REASONS: Record<string, string> = {
  'no-key': 'no key',
  cap: 'cap',
  error: 'error',
  'max-questions': 'max questions',
  'prompt-failed': 'prompt failed',
};
export function quietDecisionSummary(q: WorkJob['worker']['quietDecision']): string {
  if (!q) return '';
  const action = t(q.action);
  if (q.choice !== null && q.probability !== null) {
    return `${t(q.choice)} ${Math.round(q.probability * 100)}% ${mark('→', '->')} ${action}`;
  }
  const detail = q.reason ? t(QUIET_REASONS[q.reason] ?? q.reason) : '';
  return detail ? `${action} (${detail})` : action;
}
export function workJobDetail(card: WorkJob, sentence = ''): string {
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
/** The wait names the job it waits on (its ticket id, else a short title) when the board has it, else the holder's flow id. */
const holderName = (flow: string, waitsOn?: string) => (waitsOn ? truncateAnsi(monitorText(waitsOn), 24) : flow);
export function flowStepDetail(step: string, waitsOn?: string): string {
  const safe = monitorText(step);
  const wait = landWait(safe);
  if (wait) {
    const [, id, n, m] = wait, flow = holderName(id, waitsOn);
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
    return flow.step ? flowStepDetail(flow.step, flow.waitsOn) : '';
  }
  if (flow.state === 'completed') return t('done');
  if (flow.state === 'failed') return t('failed');
  if (flow.state === 'cancelled') return t('stopped');
  return flow.steps[0]?.state === 'failed' ? t('scout failed') : '';
}
export function flowSummary(flow: WorkFlow): string {
  const sep = mark(' ▸ ', ' > ');
  const glyph = (s: WorkFlowStep['state']) =>
    s === 'active' ? (flow.state === 'queued' ? mark('○', 'o') : mark('◉', '@'))
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
    const tail = flowOutcome(flow), [, id, n, m] = wait, holder = holderName(id, flow.waitsOn);
    const detail = n !== undefined && visualLength(tail) > width - 2 ? t('wait {flow} · gate {n}, {m}m', { flow: holder, n, m }) : tail;
    return fit(`${ink(mark('┃', '|'))} ${theme.board.muted(truncateAnsi(detail, width - 2))}`, width);
  }
  const sep = theme.board.muted(mark(' ▸ ', ' > '));
  const chain = flow.steps.map((s) => {
    const label = t(s.key);
    if (s.state === 'active') {
      return flow.state === 'queued'
        ? theme.board.muted(`${mark('○', 'o')} ${label}`)
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
export function labelSummary(labels: WorkJob['worker']['labels']): string {
  return [labels?.outcome ? `[${t(labels.outcome.value)}]` : '',
    ...(labels?.severity ?? []).map((n, i) => n ? `${n} ${t(['must fix', 'should fix', 'optional'][i])}` : '')].filter(Boolean).join(' · ');
}
/** Body only; callers choose the row budget and supply their own heading. */
export function jobDetailRows(card: WorkJob, width: number, includeDescription = true): string[] {
  const ink = workStateInk(card), rows: string[] = [];
  const route = card.worker.route;
  if (route) {
    const label = route.placement === 'even'
      ? t('Placement: even · {preset}', { preset: route.preset ? monitorText(route.preset) : t('active preset') })
      : t('Route: {tier} · {mode}', { tier: t(route.tier), mode: t(route.mode) });
    const why = route.fallback ?? route.mode_reason ?? route.reason;
    const detail = route.placement === 'even' ? why.split('; ').map(part => part.startsWith('Skipped unavailable presets: ')
      ? t('Skipped unavailable presets: {presets}', { presets: part.slice('Skipped unavailable presets: '.length) }) : t(part)).join('; ') : why;
    rows.push(fit(`${ink(mark('┃', '|'))} ${label} — ${monitorText(detail).replace(/\s+/g, ' ').trim()}`, width));
  }
  if (card.worker.flow) rows.push(flowLine(card.worker.flow, width, ink));
  if (includeDescription) {
    const step = card.worker.transcriptStep;
    const excerpt = step ? cardSentence(step.text) : '';
    const generated = step?.replaying && excerpt ? undefined : card.worker.modelSentence;
    if (generated) rows.push(...jobSentenceRows(generated, width, ink, true));
    const detail = (!generated && excerpt) || workJobDetail(card);
    if (detail) rows.push(...stemLines(detail, width, ink));
  }
  return rows.map(failed(card) ? theme.board.failedBody : theme.board.body);
}
