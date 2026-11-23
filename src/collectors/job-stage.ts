/** Display-only tail evidence. Never replay a transcript or persist its contents. */
import type { Stats } from 'node:fs';
import { readFileBounded } from '../utils/atomic-fs.js';
import type { OwnerWorker } from './workboard-types.js';

type Stage = OwnerWorker['stage'];
const WINDOW = 32 * 1024;
type Cursor = { stat: Stats; offset: number; partial: Buffer; skip: boolean; stage: Stage };
const tails = new Map<string, Cursor>(); // At most the panel's newest 200 jobs' worth of cursors.
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

function classify(name: string, input: unknown): Stage {
  name = name.toLowerCase();
  if (/^(read|read_file|view_file|ls|list_dir|list_directory|glob|grep|grep_search|find)$/.test(name)) return 'read';
  if (/^(edit|edit_file|replace_file_content|multi_replace_file_content|multiedit|write|write_file|write_to_file|apply_patch)$/.test(name)) return 'edit';
  if (!/^(bash|exec_command|run_command|run_terminal_command|shell_command)$/.test(name)) return;
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { return; }
  }
  const args = input as { command?: unknown; cmd?: unknown; CommandLine?: unknown } | null;
  const command = args?.command ?? args?.cmd ?? args?.CommandLine;
  if (typeof command !== 'string') return;
  const s = command.trimStart();
  // Recognise common command heads, not words like "test" in an arbitrary argument or comment.
  if (/^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|check)(?=[\s:]|$)|(?:cargo|go|make)\s+(?:test|build|check)\b|node\s+--test\b|(?:npx\s+)?(?:tsc|vitest|jest|pytest)(?=\s|$))/.test(s)) return 'test';
  if (/^(?:(?:ls|rg|grep|cat|head|tail|find)(?=\s|$)|git\s+(?:diff|status|show|log)(?=\s|$))/.test(s)) return 'read';
}

function stageAfter(line: Buffer, stage: Stage): Stage {
  try {
    const v = JSON.parse(line.toString('utf8'));
    const tool = (name: unknown, args: unknown) => typeof name === 'string' && name ? classify(name, args) : stage;
    if (v?.type === 'tool_execution_start') return tool(v.toolName, v.args); // pi stdout
    if (v?.event === 'step_update') {
      const s = v.step_update;
      return tool(s?.tool_info?.name ?? s?.tool_name, s?.tool_info?.parameters); // agy stdout
    }
    if (v?.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(v.payload?.type)) {
      return tool(v.payload.name, v.payload.arguments); // Codex rollout
    }
    if (v?.type === 'assistant' || (v?.type === 'message' && v.message?.role === 'assistant')) {
      const parts = v.message?.content;
      if (Array.isArray(parts)) for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (p?.type === 'toolCall' || p?.type === 'tool_use') return tool(p.name, p.arguments ?? p.input);
      }
    }
  } catch { /* Not a complete tool record. Plain output and malformed JSON are not evidence. */ }
  return stage;
}

/** Use the caller's existing target stat; unchanged targets don't even open the file. */
export function jobStage(path: string, stat: Stats): Stage {
  let prior = tails.get(path);
  tails.delete(path);
  if (prior && (!sameFile(prior.stat, stat) || stat.size < prior.stat.size ||
    (stat.size === prior.stat.size && (stat.mtimeMs !== prior.stat.mtimeMs || stat.ctimeMs !== prior.stat.ctimeMs)))) prior = undefined;
  if (prior?.offset === stat.size) {
    tails.set(path, prior);
    return prior.stage;
  }
  const offset = Math.max(prior?.offset ?? 0, stat.size - WINDOW);
  if (offset !== (prior?.offset ?? 0)) prior = undefined; // History skipped; don't keep evidence from before the gap.
  let stage = prior?.stage, skip = prior?.skip ?? (offset > 0);
  try {
    if (stat.size === offset) return;
    const { bytes } = readFileBounded(path, stat.size - offset, { offset, validate(opened) {
      if (!sameFile(stat, opened) || opened.size < stat.size) throw new Error('stage target changed');
    } });
    if (bytes.length !== stat.size - offset) return;
    const data = prior?.partial.length ? Buffer.concat([prior.partial, bytes]) : bytes;
    let start = 0, end: number;
    while ((end = data.indexOf(10, start)) !== -1) {
      if (end - start > WINDOW) stage = undefined;
      else if (!skip) stage = stageAfter(data.subarray(start, end), stage);
      skip = false;
      start = end + 1;
    }
    if (data.length - start > WINDOW) { stage = undefined; skip = true; }
    const partial = skip ? Buffer.alloc(0) : Buffer.from(data.subarray(start));
    tails.set(path, { stat, offset: stat.size, partial, skip, stage });
    if (tails.size > 200) tails.delete(tails.keys().next().value!);
    return stage;
  } catch { return; }
}
