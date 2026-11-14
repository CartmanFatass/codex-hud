import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { QuietDecision } from './quiet-decision.js';

export interface Turn {
  seq: number;
  sent_at: string;
  report_sig: string | null;
}

export function reportSignature(dir: string): string | null {
  try {
    const file = join(dir, 'report.md');
    const body = fs.readFileSync(file);
    if (!body.toString('utf8').trim()) return null;
    return `${fs.statSync(file).mtimeMs}:${body.length}:${createHash('sha256').update(body).digest('hex')}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function readTurn(dir: string): Turn | null {
  try {
    return JSON.parse(fs.readFileSync(join(dir, 'turn.json'), 'utf8')) as Turn;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Publish before input: a fast report must differ from the send-time baseline. */
export function writeTurn(dir: string): Turn {
  const turn = { seq: (readTurn(dir)?.seq ?? 0) + 1, sent_at: new Date().toISOString(), report_sig: reportSignature(dir) };
  const file = join(dir, 'turn.json');
  fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(turn) + '\n', { mode: 0o600 });
  fs.renameSync(`${file}.${process.pid}.tmp`, file);
  return turn;
}

export function procStat(pid: number) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    return /^\d+$/.test(fields[19] ?? '') ? { state: fields[0], ppid: Number(fields[1]), start: fields[19]! } : null;
  } catch {
    return null;
  }
}

export function workerAlive(pid: number | null, start: string | null): boolean | null {
  if (!Number.isInteger(pid) || !pid || pid <= 0) return null;
  const info = procStat(pid);
  if (info === null || info.state === 'Z') return false;
  return start ? info.start === start : null;
}

export interface Judgment {
  state: 'working' | 'idle_grace' | 'waiting_orchestrator' | 'closed' | 'failed' | 'stopped';
  seq: number;
  reportSig: string | null;
  quietSince: number | null;
  errorsSince: number | null;
  deadline: number | null;
  settledAt: number | null;
  outputWritten: boolean;
  blocked: boolean;
  reason: string | null;
  exitReason: string | null;
  action: 'decide' | 'quit' | 'sample' | null;
  quietHandled: boolean;
  missingTicks: number;
  wakeAt: number | null;
}
export interface Facts {
  turn: Turn;
  reportSig: string | null;
  alive: boolean | null;
  status: string | null;
  newerChild: boolean | null;
  stop: boolean;
  close: boolean;
  openQuestions: boolean;
  canContinue: boolean;
  graceMs: number;
  tick?: boolean;
  agentMissing?: boolean;
  workingAt?: number | null;
  tabClosed?: boolean;
  decision?: QuietDecision & { failReason?: string };
  supervisorError?: string;
}

/** All lifecycle choices live here; the shell only collects facts and applies effects. */
export function judge(prev: Judgment | null, facts: Facts, now: number): Judgment {
  const newTurn = prev?.seq !== facts.turn.seq;
  const next: Judgment = newTurn || !prev ? {
    state: 'working', seq: facts.turn.seq, reportSig: facts.reportSig, quietSince: null, errorsSince: null,
    deadline: null, settledAt: null, outputWritten: false, blocked: false,
    reason: null, exitReason: null, action: null, quietHandled: false, missingTicks: 0, wakeAt: null,
  } : { ...prev, action: null, blocked: false, reason: null, wakeAt: null };
  const report = facts.reportSig !== null && facts.reportSig !== facts.turn.report_sig;
  if (next.reportSig !== facts.reportSig || (next.quietSince !== null && (facts.workingAt ?? -Infinity) > next.quietSince)) next.quietSince = null;
  next.reportSig = facts.reportSig;
  const end = (state: Judgment['state'], reason: string, quit = false): Judgment => ({
    ...next, state, exitReason: reason, outputWritten: report,
    settledAt: next.settledAt ?? now, action: quit ? 'quit' : null, wakeAt: null,
  });
  if (facts.alive === false) return end(report ? 'closed' : 'failed', report ? 'settled' : 'worker exited');
  if (facts.tabClosed) return end('failed', 'tab closed');
  if (facts.stop) return end('stopped', 'stop requested');
  if (facts.close) return end('closed', 'settled', true);
  if (facts.supervisorError) return { ...next, state: 'waiting_orchestrator', reason: facts.supervisorError };
  if (facts.alive !== null) next.missingTicks = 0;
  else if (facts.tick) next.missingTicks = facts.agentMissing ? next.missingTicks + 1 : 0;
  if (next.missingTicks >= 3) return { ...next, state: 'waiting_orchestrator', reason: 'worker not found' };
  next.errorsSince = facts.status === null ? (next.errorsSince ?? now) : null;
  if (facts.status === 'blocked' || facts.openQuestions) {
    return { ...next, state: 'waiting_orchestrator', blocked: facts.status === 'blocked', quietSince: null };
  }
  // Only explicit input reopens a settled turn. Advisory flapping cannot re-baseline it.
  if (!newTurn && prev?.state === 'idle_grace') {
    if (now < next.deadline!) return { ...next, state: 'idle_grace', wakeAt: next.deadline };
    if (facts.status === 'working' || facts.newerChild === true) return { ...next, state: 'idle_grace' };
    if (facts.newerChild === null) return { ...next, state: 'idle_grace', action: 'sample' };
    return end('closed', 'settled', true);
  }
  const quiet = facts.status !== 'working' && (facts.status !== null || report);
  next.quietSince = quiet ? (next.quietSince ?? now) : null;
  if (!report && facts.newerChild === true) next.quietSince = null;
  if (next.quietSince === null) return { ...next, state: 'working', quietHandled: false };
  if (report) {
    // Error quiet runs inside the 60s outage window, but a new/partial report still needs 10s stability.
    const due = Math.max(next.quietSince + 10_000, facts.status === null ? next.errorsSince! + 60_000 : 0);
    if (now < due) return { ...next, state: 'working', wakeAt: due };
    if (facts.newerChild === null) return { ...next, state: 'working', action: 'sample' };
    if (!facts.canContinue && facts.newerChild) return { ...next, state: 'idle_grace', outputWritten: true, settledAt: now, deadline: now };
    if (!facts.canContinue) return end('closed', 'settled', true);
    return { ...next, state: 'idle_grace', outputWritten: true, settledAt: now,
      deadline: now + facts.graceMs, wakeAt: now + facts.graceMs };
  }
  const due = next.quietSince + facts.graceMs;
  next.reason = !newTurn ? prev?.reason ?? null : null;
  if (now < due) return { ...next, state: 'working', wakeAt: due };
  if (facts.newerChild === null) return { ...next, state: 'working', action: 'sample' };
  const decision = facts.decision;
  if (decision?.action === 'fail') return end('failed', decision.failReason ?? 'quota failure');
  if (decision?.action === 'wait' || decision?.action === 'prompt-report') {
    return { ...next, state: 'working', quietSince: now, quietHandled: false,
      reason: decision.action === 'wait' ? 'turn ended, no report yet' : null, wakeAt: now + facts.graceMs };
  }
  if (decision || next.quietHandled) return {
    ...next, state: 'waiting_orchestrator', quietHandled: true,
    reason: 'quiet without a report; hud_send to continue or hud_close to stop',
  };
  return { ...next, state: 'working', action: 'decide' };
}
