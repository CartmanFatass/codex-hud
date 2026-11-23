/**
 * A headless job's output for the Inspector (auto-route/04): the newest lines of its `stdout.jsonl`, read from the end of the
 * file and kept in a form the panel paints without I/O. Pi's JSON events and Claude's and Antigravity's stream-json records become one line per tool
 * call, assistant text line or error; a line that is not JSON is plain text; any other JSON event is skipped.
 */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { readFileBounded } from '../utils/atomic-fs.js';
import { jobFiles } from '../mcp/paths.js';

export interface OutputLine { readonly kind: 'say' | 'tool' | 'error'; readonly text: string }
export interface HeadlessOutput {
  /** Oldest first, at most `OUTPUT_ROWS`. */
  readonly lines: readonly OutputLine[];
  /** The log's size: 0 is a job that has not written yet. */
  readonly bytes: number;
}

/** Bytes read from the end of the log; a longer event (a big tool result) is not shown. */
const WINDOW = 128 * 1024;
export const OUTPUT_ROWS = 12;
const MAX_TEXT = 240;
const cache = new Map<string, { stamp: string; value: HeadlessOutput }>();

const clip = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** `read src/a.ts`, `bash npm test`: the tool and the first thing it was given. */
function toolText(name: unknown, args: unknown): string {
  const input = isRecord(args) ? args : {};
  const first = ['command', 'path', 'file_path', 'pattern', 'query', 'url'].map((k) => input[k]).find((v) => typeof v === 'string')
    ?? Object.values(input).find((v) => typeof v === 'string');
  return clip(`${typeof name === 'string' ? name : 'tool'} ${typeof first === 'string' ? first : ''}`);
}

function sayText(text: unknown, out: OutputLine[]): void {
  if (typeof text === 'string')
    for (const line of text.split('\n')) if (line.trim()) out.push({ kind: 'say', text: clip(line) });
}

function say(content: unknown, out: OutputLine[]): void {
  for (const part of Array.isArray(content) ? content : []) {
    if (isRecord(part) && part.type === 'text') sayText(part.text, out);
  }
}

function eventLines(event: Record<string, unknown>, out: OutputLine[]): void {
  // Antigravity nests the payload under its event name; init and usage aren't display lines.
  if (event.event === 'step_update' && isRecord(event.step_update)) {
    const step = event.step_update, tool = isRecord(step.tool_info) ? step.tool_info : {};
    const name = tool.name ?? step.tool_name;
    if (typeof name === 'string' && name) out.push({ kind: 'tool', text: toolText(name, tool.parameters) });
    if (typeof tool.error === 'string' && tool.error.trim()) out.push({ kind: 'error', text: clip(tool.error) });
    sayText(step.text_delta, out);
    return;
  }
  if (event.event === 'result' && isRecord(event.result)) {
    sayText(event.result.response, out);
    if (typeof event.result.error === 'string' && event.result.error.trim()) out.push({ kind: 'error', text: clip(event.result.error) });
    return;
  }
  const message = isRecord(event.message) ? event.message : {};
  switch (event.type) {
    // Pi: a tool starts, a tool fails, an assistant message is complete.
    case 'tool_execution_start': out.push({ kind: 'tool', text: toolText(event.toolName, event.args) }); break;
    case 'tool_execution_end':
      if (event.isError === true) out.push({ kind: 'error', text: clip(`${typeof event.toolName === 'string' ? event.toolName : 'tool'} failed`) });
      break;
    case 'message_end':
      if (message.role !== 'assistant') break;
      say(message.content, out);
      if (typeof message.errorMessage === 'string' && message.errorMessage.trim()) out.push({ kind: 'error', text: clip(message.errorMessage) });
      break;
    // Claude stream-json: an assistant turn carries its text and tool calls whole.
    case 'assistant':
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (isRecord(part) && part.type === 'tool_use') out.push({ kind: 'tool', text: toolText(part.name, part.input) });
      }
      say(message.content, out);
      break;
    case 'result':
      if (event.is_error === true) out.push({ kind: 'error', text: clip(typeof event.result === 'string' ? event.result : 'failed') });
      break;
  }
}

/** The display lines of a log window. A line the window cut in half is not JSON and must not show as text, so the caller drops it. */
export function outputLines(text: string): OutputLine[] {
  const out: OutputLine[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { out.push({ kind: 'say', text: clip(line) }); continue; }
    if (isRecord(event)) eventLines(event, out);
  }
  return out.slice(-OUTPUT_ROWS);
}

/** The newest output of the job in `dir`, or undefined when its log is missing or unreadable. Read-only, bounded, and cached until the log changes. A log that exists and is empty is `{ lines: [], bytes: 0 }`. */
export function readHeadlessOutput(dir: string): HeadlessOutput | undefined {
  const file = join(dir, jobFiles.sonicStdout);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return undefined;
    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`, hit = cache.get(file);
    if (hit?.stamp === stamp) return hit.value;
    const offset = Math.max(0, stat.size - WINDOW);
    const { bytes } = readFileBounded(file, WINDOW, { offset });
    let text = bytes.toString('utf8');
    // The window starts mid-line: skip to the first whole line (none at all when one event is longer than the window).
    if (offset > 0) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    // An unfinished last line is the next read's.
    const end = text.lastIndexOf('\n');
    const value: HeadlessOutput = { lines: outputLines(end < 0 ? '' : text.slice(0, end)), bytes: stat.size };
    cache.delete(file);
    cache.set(file, { stamp, value });
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
    return value;
  } catch {
    // No log (not started, or gone) and an unreadable one are both unknown, never "no output".
    cache.delete(file);
    return undefined;
  }
}
