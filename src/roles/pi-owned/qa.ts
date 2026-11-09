/** Pure QA protocol policy. PR3 supplies exclusive file allocation and abortable I/O. */
import { QA_TIMEOUT_TEXT, QA_WAIT_MS, refuse } from './contracts.js';
export type QaDecision =
  | { kind: 'waiting' }
  | { kind: 'answered'; text: string }
  | { kind: 'interrupted' }
  | { kind: 'timeout'; text: typeof QA_TIMEOUT_TEXT };
export function qaDecision(startMs: number, nowMs: number, aborted: boolean, answer?: string | null): QaDecision {
  if (aborted) return { kind: 'interrupted' };
  if (nowMs - startMs >= QA_WAIT_MS) return { kind: 'timeout', text: QA_TIMEOUT_TEXT };
  if (answer?.trim()) return { kind: 'answered', text: answer.trim() };
  return { kind: 'waiting' };
}
/** Count answer-only slots and gaps; allocator must still reserve with exclusive create. */
export function nextQuestionId(names: readonly string[], localCounter = 0): string {
  let last = localCounter;
  if (!Number.isSafeInteger(last) || last < 0) refuse('invalid_contract', 'question_counter');
  for (const name of names) {
    const match = /^q([1-9][0-9]{0,3})(?:\.answer)?\.md$/.exec(name);
    if (match) last = Math.max(last, Number(match[1]));
  }
  if (last >= 9999) refuse('qa_exhausted', 'q9999');
  return `q${last + 1}`;
}
export interface Question {
  question: string;
  options?: readonly string[];
  proposedDefault?: string;
  context?: string;
}
export function questionMarkdown(question: Question, id: string): string {
  if (!/^q[1-9][0-9]{0,3}$/.test(id) || !question.question.trim()) refuse('invalid_contract', 'question');
  return [
    `# Question ${id}`,
    question.question,
    ...(question.options?.length ? ['## Options', ...question.options.map((option) => `- ${option}`)] : []),
    ...(question.proposedDefault ? ['## Proposed default', question.proposedDefault] : []),
    ...(question.context ? ['## Context', question.context] : []),
    `Write your answer to ${id}.answer.md.`,
    '',
  ].join('\n\n');
}
