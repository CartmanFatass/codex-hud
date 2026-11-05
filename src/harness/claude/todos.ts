import type { Metric } from '../../core/types/observation.js';

/** Display projection only. Tool input and completed/pending task text are never retained. */
export interface ClaudeTodoProgress {
  done: number;
  total: number;
  current?: string;
}

export interface ConfirmedClaudeTodoProgress {
  value: ClaudeTodoProgress;
  at: number;
  observedTime: boolean;
}

export const MAX_TODO_ITEMS = 2000;
export const MAX_TODO_CURRENT_BYTES = 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function excerpt(text: string): string {
  if (Buffer.byteLength(JSON.stringify(text)) <= MAX_TODO_CURRENT_BYTES) return text;
  const limit = MAX_TODO_CURRENT_BYTES - Buffer.byteLength(JSON.stringify('…'));
  let bytes = 0;
  let result = '';
  for (const character of text) {
    const size = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes + size > limit) break;
    result += character;
    bytes += size;
  }
  return result + '…';
}

/** Reject the whole list rather than publishing a plausible count from a valid prefix. */
export function projectClaudeTodos(input: unknown): ClaudeTodoProgress | null {
  if (!object(input) || !Array.isArray(input.todos) || input.todos.length > MAX_TODO_ITEMS) return null;
  let done = 0;
  let current: string | undefined;
  for (const item of input.todos) {
    if (
      !object(item) ||
      typeof item.content !== 'string' ||
      !item.content.trim() ||
      typeof item.status !== 'string' ||
      !['pending', 'in_progress', 'completed'].includes(item.status) ||
      (item.activeForm !== undefined && typeof item.activeForm !== 'string')
    )
      return null;
    if (item.status === 'completed') done++;
    if (item.status === 'in_progress' && current === undefined)
      current = excerpt(typeof item.activeForm === 'string' && item.activeForm.trim() ? item.activeForm : item.content);
  }
  return { done, total: input.todos.length, ...(current === undefined ? {} : { current }) };
}

export function validClaudeTodoProgress(value: unknown): value is ClaudeTodoProgress {
  return (
    object(value) &&
    Object.keys(value).every((key) => ['done', 'total', 'current'].includes(key)) &&
    Number.isSafeInteger(value.done) &&
    Number.isSafeInteger(value.total) &&
    (value.done as number) >= 0 &&
    (value.total as number) >= (value.done as number) &&
    (value.total as number) <= MAX_TODO_ITEMS &&
    (value.current === undefined ||
      (typeof value.current === 'string' &&
        (value.done as number) < (value.total as number) &&
        Buffer.byteLength(JSON.stringify(value.current)) <= MAX_TODO_CURRENT_BYTES))
  );
}

export function validConfirmedClaudeTodoProgress(value: unknown): value is ConfirmedClaudeTodoProgress {
  return (
    object(value) &&
    Object.keys(value).length === 3 &&
    validClaudeTodoProgress(value.value) &&
    typeof value.at === 'number' &&
    Number.isFinite(value.at) &&
    value.at >= 0 &&
    typeof value.observedTime === 'boolean'
  );
}

export function claudeTodoMetric(confirmed: ConfirmedClaudeTodoProgress): Metric<ClaudeTodoProgress> {
  return {
    value: { ...confirmed.value },
    quality: 'reported',
    source: `claude.TodoWrite.last_confirmed${confirmed.observedTime ? '.observed-time' : ''}`,
    asOf: confirmed.at,
  };
}
