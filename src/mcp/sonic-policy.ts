import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { readFileBounded } from '../utils/atomic-fs.js';
import { jobFiles } from './paths.js';

export const sonicLimitDefaults = { check_s: 600, stall_s: 180, max_s: 1800 };
export type SonicLimits = typeof sonicLimitDefaults;
export type SonicStop = 'looping' | 'stalled' | 'timeout';
export const sonicLimitKeys = ['check_s', 'stall_s', 'max_s'] as const;
export function sonicLimits(role: Partial<SonicLimits>): SonicLimits {
  return {
    check_s: role.check_s ?? sonicLimitDefaults.check_s,
    stall_s: role.stall_s ?? sonicLimitDefaults.stall_s,
    max_s: role.max_s ?? sonicLimitDefaults.max_s,
  };
}

const eventTailBytes = 1024 * 1024;

function fingerprint(tool: string, args: unknown): string {
  const canonical = JSON.stringify(args, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  return createHash('sha256').update(tool).update('\0').update(canonical ?? '').digest('hex');
}

function toolEvents(file: string, offset: number, size: number) {
  const start = Math.max(offset, size - eventTailBytes);
  const { bytes } = readFileBounded(file, size - start, { offset: start });
  const newline = bytes.lastIndexOf(10);
  const complete = newline < 0 ? '' : bytes.subarray(0, newline).toString('utf8');
  const lines = complete.split('\n');
  // The tail may start in the middle of an event; a truncated window can't prove inactivity.
  if (start > offset) lines.shift();
  const calls = lines.flatMap(line => {
    try {
      const event = JSON.parse(line);
      const tool = event?.toolName;
      if (event?.type !== 'tool_execution_start' || typeof tool !== 'string' || tool === 'hud_progress') return [];
      const args = event.args;
      const target = args && typeof args === 'object' && ('path' in args || 'file_path' in args)
        ? { path: args.path ?? args.file_path, pattern: args.pattern } : args;
      return [{ tool, call: fingerprint(tool, args), target: fingerprint(tool, target) }];
    } catch { return []; }
  });
  return { calls, offset: newline < 0 ? offset : start + newline + 1, complete: start === offset };
}

function repeats(calls: string[]): boolean {
  for (let period = 1; period * 2 <= calls.length; period++) {
    if (calls.every((call, index) => index < period || call === calls[index - period])) return true;
  }
  return false;
}

function workerProgress(file: string) {
  const { bytes, truncated } = readFileBounded(file, 64 * 1024);
  if (truncated) return;
  for (const line of bytes.toString('utf8').trimEnd().split('\n').reverse()) {
    try {
      const row = JSON.parse(line);
      const at = Date.parse(row?.at);
      if (row?.source !== 'checkpoint' && Number.isFinite(at) && typeof row.text === 'string')
        return { line, at, text: row.text as string };
    } catch { /* Ignore incomplete lines. */ }
  }
}

/** The runner owns its sampling cursor; the watcher only settles and reaps it. */
export function monitorSonic(dir: string, limits: SonicLimits, started: number) {
  const stdout = join(dir, jobFiles.sonicStdout), progress = join(dir, jobFiles.progress);
  const seen = new Set<string>();
  let offset = 0, size = 0, progressMtime: number | undefined;
  let calls: string[] = [], newTarget = false, complete = true;
  let lastActivity = started, next = started + limits.check_s * 1000;
  let milestone: ReturnType<typeof workerProgress>, checkpointWorkerLine: string | undefined, lastTool: string | undefined;
  return (now: number): { stop?: SonicStop; progress?: string } => {
    if (now >= started + limits.max_s * 1000) return { stop: 'timeout' };
    const output = fs.statSync(stdout);
    if (output.size > size) lastActivity = Math.max(lastActivity, output.mtimeMs);
    if (output.size !== size) {
      size = output.size;
      const batch = toolEvents(stdout, offset, size);
      offset = batch.offset;
      complete &&= batch.complete;
      for (const { tool, target, call } of batch.calls) {
        if (!seen.has(target)) newTarget = true;
        seen.add(target);
        calls.push(call);
        lastTool = tool;
      }
    }
    const mtime = fs.statSync(progress, { throwIfNoEntry: false })?.mtimeMs;
    if (mtime !== undefined && mtime !== progressMtime) {
      try {
        const latest = workerProgress(progress);
        if (latest && latest.line !== milestone?.line) {
          milestone = latest;
          lastActivity = Math.max(lastActivity, latest.at);
        }
        progressMtime = mtime;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (now >= lastActivity + limits.stall_s * 1000) return { stop: 'stalled' };
    if (now < next) return {};
    const newProgress = milestone?.line !== checkpointWorkerLine ? milestone?.text : undefined;
    if (complete && (repeats(calls) || (!newTarget && !newProgress))) return { stop: 'looping' };
    calls = [];
    newTarget = false;
    complete = true;
    checkpointWorkerLine = milestone?.line;
    const elapsed = limits.check_s * Math.floor((now - started) / (limits.check_s * 1000));
    // If scheduling was delayed, don't run missed checkpoints back to back.
    next = started + (elapsed + limits.check_s) * 1000;
    const time = elapsed % 60 === 0 ? `${elapsed / 60} min` : `${elapsed} s`;
    return { progress: `still working at ${time}: ${newProgress ?? (lastTool ? `tool ${lastTool}` : 'processing output')}` };
  };
}
