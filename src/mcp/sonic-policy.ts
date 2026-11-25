import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { readFileBounded } from '../utils/atomic-fs.js';
import { jobFiles } from './paths.js';

export const sonicLimitDefaults = { check_s: 600, stall_s: 180, max_s: 1800 };
export type SonicLimits = typeof sonicLimitDefaults;
type AutoCompaction = 'overflow' | 'threshold';
export type SonicStop = 'looping' | 'stalled' | 'timeout' | `pi ${AutoCompaction} compaction did not finish within ${number} s`;
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

function sonicEvents(file: string, offset: number, size: number) {
  const start = Math.max(offset, size - eventTailBytes);
  const { bytes } = readFileBounded(file, size - start, { offset: start });
  const newline = bytes.lastIndexOf(10);
  const complete = newline < 0 ? '' : bytes.subarray(0, newline).toString('utf8');
  const lines = complete.split('\n');
  // The tail may start in the middle of an event; a truncated window can't prove inactivity.
  if (start > offset) lines.shift();
  const opened: { id: string; tool: string; timeout_s?: number }[] = [], ended: string[] = [];
  let compaction: AutoCompaction | null | undefined; // Last boundary in this batch; null means ended.
  const calls = lines.flatMap(line => {
    try {
      const event = JSON.parse(line);
      if (event?.type === 'compaction_start' && (event.reason === 'overflow' || event.reason === 'threshold')) compaction = event.reason;
      if (event?.type === 'compaction_end') compaction = null;
      const id = typeof event?.toolCallId === 'string' ? event.toolCallId : undefined;
      if (id && event?.type === 'tool_execution_end') ended.push(id);
      const tool = event?.toolName;
      if (id && event?.type === 'tool_execution_start') {
        const timeout = event?.args?.timeout;
        opened.push({
          id,
          tool: typeof tool === 'string' && tool ? tool : 'tool',
          ...(typeof timeout === 'number' && timeout > 0 ? { timeout_s: timeout } : {}),
        });
      }
      if (event?.type !== 'tool_execution_start' || typeof tool !== 'string' || tool === 'hud_progress') return [];
      const args = event.args;
      const target = args && typeof args === 'object' && ('path' in args || 'file_path' in args)
        ? { path: args.path ?? args.file_path, pattern: args.pattern } : args;
      return [{ tool, call: fingerprint(tool, args), target: fingerprint(tool, target) }];
    } catch { return []; }
  });
  return { calls, opened, ended, compaction, offset: newline < 0 ? offset : start + newline + 1, complete: start === offset };
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
  let compacting: { reason: AutoCompaction; deadline: number } | undefined;
  let lastActivity = started, next = started + limits.check_s * 1000;
  // A tool call that declared its own timeout (a long build or test run) is not a stall until that timeout passes.
  const running = new Map<string, number>();
  // A tool call without a declared timeout gets its child process tree ended once on silence so pi can continue.
  const unbounded = new Map<string, string>();
  const killedTools = new Set<string>();
  let milestone: ReturnType<typeof workerProgress>, checkpointWorkerLine: string | undefined, lastTool: string | undefined;
  return (now: number): { stop?: SonicStop; killTool?: boolean; progress?: string } => {
    if (now >= started + limits.max_s * 1000) return { stop: 'timeout' };
    const output = fs.statSync(stdout);
    if (output.size > size) lastActivity = Math.max(lastActivity, output.mtimeMs);
    if (output.size !== size) {
      size = output.size;
      const batch = sonicEvents(stdout, offset, size);
      // A skipped part of the log may contain compaction_end. Only act on an observed open phase.
      if (!batch.complete || batch.compaction === null) compacting = undefined;
      if (batch.compaction) compacting = { reason: batch.compaction, deadline: output.mtimeMs + limits.stall_s * 1000 };
      offset = batch.offset;
      complete &&= batch.complete;
      for (const { id, tool, timeout_s } of batch.opened) {
        if (timeout_s !== undefined) running.set(id, output.mtimeMs + timeout_s * 1000);
        else unbounded.set(id, tool);
      }
      for (const id of batch.ended) {
        running.delete(id);
        unbounded.delete(id);
        killedTools.delete(id);
      }
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
    // Pi waits for the summary as one result; retries or unrelated progress aren't a completed summary.
    if (compacting && now >= compacting.deadline)
      return { stop: `pi ${compacting.reason} compaction did not finish within ${limits.stall_s} s` };
    if (!compacting && now >= Math.max(lastActivity + limits.stall_s * 1000, ...running.values())) {
      if (!running.size && unbounded.size && [...unbounded.keys()].every(id => !killedTools.has(id))) {
        const silent = Math.floor((now - lastActivity) / 1000);
        const tools = [...new Set(unbounded.values())].join(', ');
        for (const id of unbounded.keys()) killedTools.add(id);
        lastActivity = now;
        return { killTool: true, progress: `ended a silent tool after ${silent} s: ${tools}` };
      }
      return { stop: 'stalled' };
    }
    if (now < next) return {};
    const newProgress = milestone?.line !== checkpointWorkerLine ? milestone?.text : undefined;
    if (!compacting && complete && !running.size && (repeats(calls) || (!newTarget && !newProgress))) return { stop: 'looping' };
    calls = [];
    newTarget = false;
    complete = true;
    checkpointWorkerLine = milestone?.line;
    const elapsed = limits.check_s * Math.floor((now - started) / (limits.check_s * 1000));
    // If scheduling was delayed, don't run missed checkpoints back to back.
    next = started + (elapsed + limits.check_s) * 1000;
    const time = elapsed % 60 === 0 ? `${elapsed / 60} min` : `${elapsed} s`;
    return { progress: `still working at ${time}: ${compacting ? `pi ${compacting.reason} compaction` : newProgress ?? (lastTool ? `tool ${lastTool}` : 'processing output')}` };
  };
}
