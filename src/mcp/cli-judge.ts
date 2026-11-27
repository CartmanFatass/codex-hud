import { realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { writeJsonPrivate } from '../utils/atomic-fs.js';
import { isActiveProcState, isProcAlive, procStat } from '../utils/proc.js';
import { binScript, jobFiles } from './paths.js';
import type { QuietDecision } from './quiet-decision.js';
import { readTurn, receiptForTurn, reportSignature, turnToken, type DoneReceipt, type Turn } from '../roles/cli-turn.js';
export { procStat };
export { DONE_FILE, readDone, readTurn, reportSignature, turnToken, type DoneReceipt, type Turn } from '../roles/cli-turn.js';

export const cliWorkerTools = (agent: string) => agent === 'claude' || agent === 'codex' || agent === 'agy';
export function withDonePrompt(text: string, bundled: string, dir: string, turn: Turn, agent: string): string {
  const token = turnToken(turn);
  const command = `node ${JSON.stringify(binScript('hud-progress', bundled))} --done --dir ${JSON.stringify(dir)} --turn ${token}`;
  if (!cliWorkerTools(agent)) {
    return `${text}\n\nAfter writing the report for this turn, run: ${command}\nUse the command from the prompt you are answering, not a newer turn.\n`;
  }
  const finish = `Finish with hud_report. Use the token in the prompt you are answering, not a newer turn. turn: ${token}`;
  const fallback = agent === 'agy'
    ? `\nOnly if hud_report is unavailable, write your report to ${JSON.stringify(join(dir, jobFiles.report))} and run:\n${command} [--summary "…"] [--file path]`
    : '';
  return `${text}\n\n${finish}${fallback}\n`;
}

type TurnOptions = { by?: 'hud'; restarted?: boolean; reportPromptSent?: boolean; send?: Turn['send']; callerToken?: string };

/** Publish before input: a fast report must differ from the send-time baseline. */
export function writeTurn(dir: string, options: TurnOptions = {}, prev = readTurn(dir)): Turn {
  const start = options.send?.start ?? (options.by && procStat(process.pid)?.start);
  const sent = options.reportPromptSent || (!options.restarted && prev?.report_prompt_sent);
  const sent_at = new Date().toISOString();
  const turn: Turn = {
    seq: (prev?.seq ?? 0) + 1,
    sent_at,
    report_sig: reportSignature(dir),
    ...(prev && start ? { pending_from: { seq: prev.seq, sent_at: prev.sent_at, report_sig: prev.report_sig, pid: process.pid, start } } : {}),
    ...(sent ? { report_prompt_sent: true } : {}),
    ...(options.callerToken ? { caller_token: options.callerToken } : options.by === 'hud' && prev ? { caller_token: prev.caller_token ?? turnToken(prev) } : {}),
    ...(options.send ? { send: options.send } : {}),
  };
  saveTurn(dir, turn);
  return turn;
}

// Serialize only disk updates with hud_report, never hold the lock across prompt delivery.
export const withTurnLock = <T>(dir: string, fn: () => T) => withAbstractLock('cli-turn', realpathSync(dir), fn);
export function beginPrompt(dir: string, options: Pick<TurnOptions, 'by' | 'send' | 'reportPromptSent'>) {
  return withTurnLock(dir, () => {
    const prior = readTurn(dir);
    return { prior, turn: writeTurn(dir, options, prior) };
  });
}
export function endPrompt(dir: string, { prior, turn }: Awaited<ReturnType<typeof beginPrompt>>, refused = false) {
  return withTurnLock(dir, () => {
    const active = readTurn(dir);
    if (!active || turnToken(active) !== turnToken(turn) || active.send?.key !== turn.send?.key || active.send?.pid !== turn.send?.pid) return;
    if (refused) {
      if (turn.pending_from && !active.pending_from) return; // A declaration with the new token proves delivery.
      if (prior) {
        delete prior.pending_from; // Do not reopen an overlapping, older submission window.
        saveTurn(dir, prior);
      } else unlinkSync(join(dir, jobFiles.turn));
    } else if (active.pending_from) {
      delete active.pending_from;
      saveTurn(dir, active);
    }
  });
}

export function saveTurn(dir: string, turn: Turn): void {
  writeJsonPrivate(join(dir, jobFiles.turn), turn, { mkdir: false });
}

export function workerAlive(pid: number | null, start: string | null): boolean | null {
  if (!Number.isInteger(pid) || !pid || pid <= 0) return null;
  if (start) return isProcAlive(pid, start);
  const info = procStat(pid);
  return info === null || !isActiveProcState(info.state) ? false : null;
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
  action: 'decide' | 'quit' | 'collect-sonic' | null;
  quietHandled: boolean;
  decisionWait?: boolean; // A quiet decision's wait still uses the full idle grace.
  missingTicks: number;
  wakeAt: number | null;
  declared?: boolean;
}
export const REPORT_READ_EXIT = 'closed after report read';
export const REPORT_SETTLED_EXIT = 'closed after declared report';
export const QUIET_WITHOUT_REPORT = 'quiet without a report; hud_send to continue or hud_close to stop';

export type PaneExit = { exitCode: number | null; signal: string | null };

export function formatPaneExitReason(exit: PaneExit): string {
  if (exit.signal) return `worker exited (signal ${exit.signal})`;
  if (typeof exit.exitCode === 'number') return `worker exited (code ${exit.exitCode})`;
  return 'worker exited (exit unknown)';
}

export interface Facts {
  turn: Turn;
  reportSig: string | null;
  reportRead: boolean;
  closeAtReport?: boolean; // Jobs launched before close-at-report keep their original grace.
  alive: boolean | null;
  paneExit?: PaneExit | null;
  directExec?: boolean;
  status: string | null;
  statusAt?: number | null;
  sonic?: { open: boolean; uncollected: string[]; remind: string[] };
  stop: boolean;
  close: boolean;
  openQuestions: boolean;
  canContinue: boolean;
  graceMs: number;
  stateTrust?: 'turn' | 'advisory';
  tick?: boolean;
  agentMissing?: boolean;
  workingAt?: number | null;
  nativeActivityAt?: number | null;
  nativeActive?: boolean;
  done?: DoneReceipt | null;
  tabClosed?: boolean;
  decision?: QuietDecision & { failReason?: string };
  supervisorError?: string;
}

export function terminalFact({ stop, alive, paneExit, directExec, tabClosed, turn, reportSig }: Pick<Facts, 'stop' | 'alive' | 'paneExit' | 'directExec' | 'tabClosed' | 'reportSig'> & { turn: Turn | null }) {
  const outputWritten = reportSig !== null && reportSig !== turn?.report_sig;
  // Stop intent is written before termination, so it wins over both exit and tab close.
  if (stop) return { state: 'stopped', exitReason: 'stop requested', outputWritten } as const;
  if (paneExit) {
    if (paneExit.exitCode === 0 && !paneExit.signal)
      return { state: outputWritten ? 'closed' : 'failed', exitReason: outputWritten ? 'settled' : 'worker exited', outputWritten } as const;
    return { state: 'failed', exitReason: formatPaneExitReason(paneExit), outputWritten } as const;
  }
  if (alive === false) {
    // On direct-exec, a missed exit with no exit code must never settle as success on a partial report.
    if (directExec) return { state: 'failed', exitReason: 'worker exited (exit unknown)', outputWritten } as const;
    return { state: outputWritten ? 'closed' : 'failed', exitReason: outputWritten ? 'settled' : 'worker exited', outputWritten } as const;
  }
  if (tabClosed && !directExec) return { state: 'failed', exitReason: 'tab closed', outputWritten } as const;
  return null;
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
  const readReport = report && facts.reportRead;
  const reportChanged = next.reportSig !== facts.reportSig;
  const done = facts.done;
  const receipt = receiptForTurn(facts.turn, done);
  const declared = report && receipt && done.report_sig === facts.reportSig;
  // A stale receipt for this turn is evidence that it declared, not permission to settle as a legacy turn.
  const awaitingReceipt = receipt && !declared;
  if (awaitingReceipt || (next.declared && (!declared || reportChanged))) {
    next.state = 'working';
    next.outputWritten = false;
    next.settledAt = next.deadline = null;
    if (next.declared) next.quietSince = null;
  }
  next.declared = declared;
  const sentAt = Date.parse(facts.turn.sent_at);
  const nativeAt = typeof facts.nativeActivityAt === 'number' && Number.isFinite(facts.nativeActivityAt) && facts.nativeActivityAt >= sentAt
    ? facts.nativeActivityAt : null;
  const activityAt = Math.max(facts.workingAt ?? -Infinity, nativeAt ?? -Infinity);
  const refreshedActivity = next.quietSince !== null && activityAt > next.quietSince;
  if (reportChanged || refreshedActivity) {
    next.quietSince = null;
    if (refreshedActivity) {
      next.quietHandled = false;
      next.decisionWait = false;
    }
  }
  next.reportSig = facts.reportSig;
  const end = (state: Judgment['state'], reason: string, quit = false): Judgment => ({
    ...next, state, exitReason: reason, outputWritten: report,
    settledAt: next.settledAt ?? now, action: quit ? 'quit' : null, wakeAt: null,
  });
  const terminal = terminalFact(facts);
  if (terminal) return end(terminal.state, terminal.exitReason);
  if (facts.close) return end('closed', 'settled', true);
  if (facts.supervisorError) return { ...next, state: 'waiting_orchestrator', reason: facts.supervisorError };
  if (facts.alive !== null) next.missingTicks = 0;
  else if (facts.tick) next.missingTicks = facts.agentMissing ? next.missingTicks + 1 : 0;
  if (next.missingTicks >= 3) return { ...next, state: 'waiting_orchestrator', reason: 'worker not found' };
  next.errorsSince = facts.status === null ? (next.errorsSince ?? now) : null;
  const collectSonic = Boolean(facts.sonic?.uncollected.length);
  if (facts.sonic?.open || collectSonic) {
    next.outputWritten = false;
    next.settledAt = next.deadline = null;
  }
  if (facts.openQuestions || (!receipt && facts.status === 'blocked')) {
    return { ...next, state: 'waiting_orchestrator', blocked: facts.status === 'blocked', quietSince: null };
  }
  if (facts.sonic?.open || (collectSonic && !facts.sonic?.remind.length))
    return { ...next, state: 'working', quietSince: null, quietHandled: false, decisionWait: false };
  if (awaitingReceipt) {
    next.quietHandled = false;
    next.decisionWait = false;
  }
  if (facts.closeAtReport && declared) {
    const declaredAt = Date.parse(done.at), due = declaredAt + 10_000;
    const sentAt = Date.parse(facts.turn.sent_at);
    const ended = (facts.status === 'done' || facts.status === 'idle') &&
      (facts.statusAt ?? now) >= sentAt && ((facts.workingAt ?? -Infinity) >= sentAt || (facts.statusAt ?? now) >= declaredAt);
    if (collectSonic) return { ...next, state: 'working', action: ended ? 'collect-sonic' : null };
    // A lingering daemon can keep herdr working until close reaps it. The receipt still matches the report.
    if (ended || now >= due) return end('closed', REPORT_SETTLED_EXIT);
    return { ...next, state: 'working', wakeAt: due };
  }
  if (next.state === 'idle_grace' && !collectSonic) {
    if (!readReport && now < next.deadline!)
      return { ...next, state: 'idle_grace', wakeAt: next.deadline };
    if (!declared && facts.status === 'working') return { ...next, state: 'idle_grace' };
    return end('closed', readReport ? REPORT_READ_EXIT : 'settled', true);
  }
  const trustedEnd = facts.stateTrust === 'turn' && (facts.workingAt ?? -Infinity) >= sentAt
    && (facts.status === 'done' || facts.status === 'idle');
  const legacyReport = report && !facts.closeAtReport;
  const nativeActive = !declared && facts.nativeActive === true;
  const quiet = declared || (!nativeActive && facts.status !== 'working' && (facts.status !== null || legacyReport));
  next.quietSince = quiet ? (next.quietSince ?? now) : null;
  if (next.quietSince === null) return { ...next, state: 'working', quietHandled: false, decisionWait: false };
  if (legacyReport || collectSonic || awaitingReceipt) {
    // A trusted turn end shortens stability, not the fresh-receipt grace or the outage window.
    if (!declared) {
      const stableMs = trustedEnd ? 2000 : 10_000;
      const due = Math.max(next.quietSince + Math.max(stableMs, awaitingReceipt ? facts.graceMs : 0),
        facts.status === null ? next.errorsSince! + 60_000 : 0);
      if (now < due) return { ...next, state: 'working', wakeAt: due };
    }
    if (awaitingReceipt) return {
      ...next, state: 'waiting_orchestrator',
      reason: 'report changed after done receipt; no new receipt (hud_send to continue or hud_close to stop)',
    };
    if (collectSonic) return { ...next, state: 'working', action: 'collect-sonic' };
    if (readReport || !facts.canContinue) return end('closed', readReport ? REPORT_READ_EXIT : 'settled', true);
    return { ...next, state: 'idle_grace', outputWritten: true, settledAt: now,
      deadline: now + facts.graceMs, wakeAt: now + facts.graceMs };
  }
  const baseDue = next.quietSince + (trustedEnd && !next.decisionWait ? 10_000 : facts.graceMs);
  const due = nativeAt !== null && !next.decisionWait ? Math.max(baseDue, nativeAt + facts.graceMs) : baseDue;
  next.reason = !newTurn ? prev?.reason ?? null : null;
  if (now < due && !facts.decision && !next.quietHandled) return { ...next, state: 'working', wakeAt: due };
  const decision = facts.decision;
  if (decision?.action === 'fail') return end('failed', decision.failReason ?? 'quota failure');
  if (decision?.action === 'wait' || decision?.action === 'prompt-report') {
    return { ...next, state: 'working', quietSince: now, quietHandled: false, decisionWait: true,
      reason: decision.action === 'wait' ? 'turn ended, no report yet' : null, wakeAt: now + facts.graceMs };
  }
  if (decision || next.quietHandled) return {
    ...next, state: 'waiting_orchestrator', quietHandled: true,
    reason: QUIET_WITHOUT_REPORT,
  };
  return { ...next, state: 'working', action: 'decide' };
}
