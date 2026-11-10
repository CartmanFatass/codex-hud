/** Pure QA protocol policy. PR3 supplies exclusive file allocation and abortable I/O. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { QA_TIMEOUT_TEXT, QA_WAIT_MS, QA_POLL_MS, assertPath, readOwnedText, refuse } from './contracts.js';
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
/** Abort and timeout win at their boundary; a tool result never claims a default action. */
export async function askQuestion(
  directory: string,
  question: Question,
  options: {
    signal?: AbortSignal;
    now?: () => number;
    pause?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {}
): Promise<Exclude<QaDecision, { kind: 'waiting' }>> {
  if (Buffer.byteLength(questionMarkdown(question, 'q9999')) > 64 * 1024) refuse('file_too_large', 'question');
  const now = options.now ?? Date.now;
  const pause =
    options.pause ??
    (async (ms, signal) => {
      await delay(ms, undefined, { signal });
    });
  const qa = join(directory, 'qa');
  assertPath(qa, directory);
  fs.mkdirSync(qa, { recursive: true, mode: 0o700 });
  let id: string;
  for (;;) {
    id = nextQuestionId(fs.readdirSync(qa));
    const file = join(qa, `${id}.md`);
    try {
      fs.writeFileSync(file, questionMarkdown(question, id), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const created = fs.statSync(join(qa, `${id}.md`)).mtimeMs;
  const start = now();
  const answerFile = join(qa, `${id}.answer.md`);
  for (;;) {
    let answer: string | null = null;
    if (!options.signal?.aborted && now() - start < QA_WAIT_MS && fs.existsSync(answerFile)) {
      const text = readOwnedText(answerFile, 64 * 1024, directory);
      if (fs.statSync(answerFile).mtimeMs >= created) answer = text;
    }
    const decision = qaDecision(start, now(), options.signal?.aborted ?? false, answer);
    if (decision.kind !== 'waiting') return decision;
    try {
      await pause(Math.min(QA_POLL_MS, QA_WAIT_MS - (now() - start)), options.signal);
    } catch (error) {
      if (options.signal?.aborted) return { kind: 'interrupted' };
      throw error;
    }
  }
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
