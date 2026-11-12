/** Retained public native material reductions, shared by the unified card sentences. */
import type { SubagentTreeNode } from '../types.js';
export function headTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = '\n[… middle omitted …]\n';
  const room = Math.max(0, max - marker.length);
  const head = Math.ceil(room * 0.4);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (room - head))}`;
}
export function tail(text: string, max: number): string {
  return text.length <= max ? text : `[…]${text.slice(text.length - max)}`;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function* entries(jsonl: string): Generator<{ entry: Record<string, unknown>; payload: Record<string, unknown> }> {
  for (const line of jsonl.split('\n')) {
    try {
      const entry = record(JSON.parse(line));
      const payload = record(entry?.payload);
      if (entry && payload) yield { entry, payload };
    } catch {
      /* Partial records are not evidence. */
    }
  }
}
export function finalAnswer(jsonl: string): { text: string; at: Date } | null {
  let found: { text: string; at: Date } | null = null;
  for (const { entry, payload } of entries(jsonl)) {
    if (
      entry.type !== 'response_item' ||
      payload.type !== 'message' ||
      payload.role !== 'assistant' ||
      !Array.isArray(payload.content)
    )
      continue;
    if (!(payload.phase === 'final_answer' || payload.channel === 'final')) continue;
    if (payload.channel !== undefined && payload.channel !== null && payload.channel !== 'final') continue;
    const at = typeof entry.timestamp === 'string' ? new Date(entry.timestamp) : null;
    if (!at || !Number.isFinite(at.getTime())) continue;
    const text = payload.content
      .map((part) => {
        const block = record(part);
        return block && (block.type === 'output_text' || block.type === 'text') && typeof block.text === 'string'
          ? block.text
          : '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) found = { text, at };
  }
  return found;
}
const ERROR_EVENTS: ReadonlySet<string> = new Set(['error', 'stream_error', 'task_failed']);
function outputText(value: unknown, depth = 0): string {
  if (depth > 4) return '';
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return outputText(parsed, depth + 1);
    } catch {
      /* plain text */
    }
    return value;
  }
  if (Array.isArray(value))
    return value
      .map((item) => outputText(item, depth + 1))
      .filter(Boolean)
      .join('\n');
  const object = record(value);
  if (!object) return '';
  if (typeof object.text === 'string') return object.text;
  return ['output', 'content', 'stderr', 'stdout']
    .map((key) => outputText(object[key], depth + 1))
    .filter(Boolean)
    .join('\n');
}
export function errorMaterial(jsonl: string): string | null {
  const errors: string[] = [];
  let failedOutput: string | null = null;
  for (const { entry, payload } of entries(jsonl)) {
    if (entry.type === 'event_msg' && typeof payload.type === 'string' && ERROR_EVENTS.has(payload.type)) {
      const message = [payload.message, payload.reason, payload.error].find(
        (value) => typeof value === 'string' && value.trim()
      );
      if (typeof message === 'string') errors.push(message.trim());
    } else if (
      entry.type === 'response_item' &&
      (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')
    ) {
      const text = outputText(payload.output);
      const codes = [...text.matchAll(/(?:Process exited with code|Exit code:)\s*(-?\d+)/gi)].map((match) =>
        Number(match[1])
      );
      if ((codes.some((code) => code !== 0) || record(payload.output)?.success === false) && text.trim())
        failedOutput = text.trim();
    }
  }
  if (errors.length) return tail(errors.slice(-4).join('\n'), 2000);
  return failedOutput ? tail(failedOutput, 2000) : null;
}
function usableCharge(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim();
  if (!text || text.includes('gAAAAA') || /^Message Type:/.test(text)) return undefined;
  return text;
}
export function labelSource(node: SubagentTreeNode): string | undefined {
  if (jobOnlyNode(node) || displayOnlyRoot in node) return undefined;
  const charge = usableCharge(node.charge);
  if (charge) {
    const where = [node.agentPath, node.role].filter((part): part is string => Boolean(part)).join(' ');
    return where ? `${where} ${charge}` : charge;
  }
  return usableCharge(node.task);
}
export function jobOnlyNode(node: Pick<SubagentTreeNode, 'id'>): boolean {
  return /^(?:role-job:|external-herdr:|job-root:)/.test(node.id);
}
const displayOnlyRoot = Symbol('display-only-job-root');
export function displayOnlySummaryRoot<T extends SubagentTreeNode>(node: T): T {
  return Object.assign(node, { [displayOnlyRoot]: true });
}
