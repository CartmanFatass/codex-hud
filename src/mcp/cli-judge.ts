import { join } from 'node:path';
import { writeJsonPrivate } from '../utils/atomic-fs.js';
import {
  isActiveProcState,
  isProcAlive,
  LINUX_USER_HZ,
  procStat,
  readBootTimeMs,
  readProcChildren,
  readProcCmdline,
} from '../utils/proc.js';
import type { QuietDecision } from './quiet-decision.js';
import { readTurn, receiptForTurn, reportSignature, turnToken, type DoneReceipt, type Turn } from '../roles/cli-turn.js';
export { procStat };
export { DONE_FILE, readDone, readTurn, reportSignature, turnToken, type DoneReceipt, type Turn } from '../roles/cli-turn.js';

export const firstInput = (turn: Turn) => turn.first_sent_at ?? (turn.seq === 1 ? turn.sent_at : undefined);
export const cliWorkerTools = (agent: string) => agent === 'claude' || agent === 'codex' || agent === 'agy';
export function withDonePrompt(text: string, bundled: string, dir: string, turn: Turn, agent: string): string {
  const token = turnToken(turn);
  const command = `node ${JSON.stringify(join(bundled, 'bin', 'hud-progress.mjs'))} --done --dir ${JSON.stringify(dir)} --turn ${token}`;
  if (!cliWorkerTools(agent)) {
    return `${text}\n\nAfter writing the report for this turn, run: ${command}\nUse the command from the prompt you are answering, not a newer turn.\n`;
  }
  const finish = `Finish with hud_report. Use the token in the prompt you are answering, not a newer turn. turn: ${token}`;
  const fallback = agent === 'agy'
    ? `\nOnly if hud_report is unavailable, write your report to ${JSON.stringify(join(dir, 'report.md'))} and run:\n${command} [--summary "…"] [--file path]`
    : '';
  return `${text}\n\n${finish}${fallback}\n`;
}

/** Publish before input: a fast report must differ from the send-time baseline. */
export function writeTurn(dir: string, options: { by?: 'hud'; reportPromptSent?: boolean; send?: Turn['send'] } = {}): Turn {
  const prev = readTurn(dir);
  const sent = options.reportPromptSent || prev?.report_prompt_sent;
  const turn: Turn = {
    seq: (prev?.seq ?? 0) + 1,
    sent_at: new Date().toISOString(),
    report_sig: reportSignature(dir),
    ...(sent ? { report_prompt_sent: true } : {}),
    ...(prev && firstInput(prev) ? { first_sent_at: firstInput(prev) } : {}),
    ...(options.by === 'hud' && prev ? { caller_token: prev.caller_token ?? turnToken(prev) } : {}),
    ...(options.send ? { send: options.send } : {}),
  };
  saveTurn(dir, turn);
  return turn;
}

export function saveTurn(dir: string, turn: Turn): void {
  writeJsonPrivate(join(dir, 'turn.json'), turn, { mkdir: false });
}

export function workerAlive(pid: number | null, start: string | null): boolean | null {
  if (!Number.isInteger(pid) || !pid || pid <= 0) return null;
  if (start) return isProcAlive(pid, start);
  const info = procStat(pid);
  return info === null || !isActiveProcState(info.state) ? false : null;
}

type Bootstrap = { stage: 'launcher' } | { stage: 'shell' | 'server'; entry: string };
const base = (path = '') => path.split('/').at(-1);
function bootstrap(pid: number, start: string, launchDirect: boolean, parent: number, chain?: Bootstrap): Bootstrap | boolean {
  let argv = readProcCmdline(pid);
  if (!argv) return false;
  if (workerAlive(pid, start) !== true) return false;
  if (launchDirect) {
    const command = base(argv[0]);
    if (!command || /^(sh|bash|zsh|dash|fish)$/.test(command)) return false;
    // npm normally retitles itself to one argv element; other launchers may retain the original argv.
    if (argv.length === 1 && argv[0]?.startsWith('npm exec ')) argv = argv[0].split(' ');
    if (base(argv[0]) === 'node') argv.shift();
    const launcher = base(argv.shift());
    if (launcher === 'npm' || launcher === 'npm-cli.js') { if (argv.shift() !== 'exec') return true; }
    else if (launcher === 'pnpm' || launcher === 'pnpm.cjs') { if (argv.shift() !== 'dlx') return true; }
    else if (launcher !== 'npx' && launcher !== 'npx-cli.js' && launcher !== 'uvx') return true;
    while (['-y', '--yes', '--'].includes(argv[0] ?? '')) argv.shift();
    const spec = argv[0];
    return argv.length === 1 && spec && !spec.startsWith('-') && !/\s/.test(spec) ? { stage: 'launcher' } : true;
  }
  if (!chain) return false;
  if (chain.stage === 'launcher') {
    // Learn the executable from the shell, not the package spec. Reject arguments and shell syntax.
    // npm exec quotes the bin name (`sh -c 'playwright-mcp'`); one matching pair of quotes is not syntax.
    const entry = argv[2]?.trim().replace(/^(['"])(.*)\1$/, '$2');
    return base(argv[0]) === 'sh' && argv.length === 3 && argv[1] === '-c' && entry && /^[\w.@%+-]+$/.test(entry)
      ? { stage: 'shell', entry } : false;
  }
  const { entry, stage } = chain;
  if (stage === 'shell') return (base(argv[0]) === entry || (base(argv[0]) === 'node' && argv[1]?.endsWith(`/.bin/${entry}`)))
    ? { stage: 'server', entry } : false;
  return entry === 'chrome-devtools-mcp' && base(argv[0]) === 'node' &&
    Boolean(argv[1]?.endsWith('/node_modules/chrome-devtools-mcp/build/src/telemetry/watchdog/main.js')) &&
    (argv.includes(`--parent-pid=${parent}`) || argv.some((arg, i) => arg === '--parent-pid' && argv[i + 1] === String(parent)));
}

/** Exempt launch helpers and their known bootstrap steps, not the work started below them. */
export function workerHasChild(pid: number | null, start: string | null, sentAt: string, firstSentAt?: string): boolean | 'unknown' {
  if (pid === null || workerAlive(pid, start) !== true) return false;
  const parents: { pid: number; start: string | null; chain?: Bootstrap }[] = [{ pid, start }];
  let budget = 512;
  try {
    const boot = readBootTimeMs();
    if (boot === null) return workerAlive(pid, start) === true ? 'unknown' : false;
    const msPerTick = 1000 / LINUX_USER_HZ;
    const since = Math.floor((Date.parse(sentAt) - boot) / msPerTick); // Linux USER_HZ is 100; include the send's whole tick.
    const first = Math.floor((Date.parse(firstSentAt ?? '') - boot) / msPerTick);
    // First input can race helper startup. A continuation does not get a launch window.
    const launchThrough = sentAt === firstSentAt ? first + 10 * LINUX_USER_HZ : first - 1; // 10 s in USER_HZ ticks.
    if (!Number.isFinite(since)) return 'unknown';
    for (let item; (item = parents.pop()) !== undefined;) {
      const { pid: parent, chain } = item;
      if (chain && workerAlive(parent, item.start) !== true) return 'unknown';
      const children = readProcChildren(parent, { budget, strict: true });
      if (children === null) {
        if (parent !== pid) continue;
        return workerAlive(pid, start) === true ? 'unknown' : false;
      }
      budget = children.budgetRemaining;
      for (const id of children.pids) {
        if (--budget < 0) return 'unknown';
        const child = procStat(id);
        if (child?.ppid !== parent || (child.threads <= 1 && !isActiveProcState(child.state))) continue;
        const childStart = Number(child.start);
        const launchDirect = parent === pid && childStart <= launchThrough;
        const match = launchDirect || chain ? bootstrap(id, child.start, launchDirect, parent, chain) : false;
        if (!match && childStart >= since) return workerAlive(pid, start) === true;
        parents.push({ pid: id, start: child.start, ...(typeof match === 'object' ? { chain: match } : {}) });
      }
      if (children.truncated) return 'unknown';
    }
  } catch {
    return workerAlive(pid, start) === true ? 'unknown' : false;
  }
  return false;
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
  action: 'decide' | 'quit' | 'sample' | 'collect-sonic' | null;
  quietHandled: boolean;
  decisionWait?: boolean; // A quiet decision's wait still uses the full idle grace.
  missingTicks: number;
  wakeAt: number | null;
  declared?: boolean;
}
export const REPORT_READ_EXIT = 'closed after report read';

export interface Facts {
  turn: Turn;
  reportSig: string | null;
  reportRead: boolean;
  alive: boolean | null;
  status: string | null;
  liveChild: boolean | 'unknown' | null; // null: not sampled yet
  sonic?: { open: boolean; uncollected: string[] };
  stop: boolean;
  close: boolean;
  openQuestions: boolean;
  canContinue: boolean;
  graceMs: number;
  stateTrust?: 'turn' | 'advisory';
  tick?: boolean;
  agentMissing?: boolean;
  workingAt?: number | null;
  done?: DoneReceipt | null;
  tabClosed?: boolean;
  decision?: QuietDecision & { failReason?: string };
  supervisorError?: string;
}

export function terminalFact({ stop, alive, tabClosed, turn, reportSig }: Pick<Facts, 'stop' | 'alive' | 'tabClosed' | 'reportSig'> & { turn: Turn | null }) {
  const outputWritten = reportSig !== null && reportSig !== turn?.report_sig;
  // Stop intent is written before termination, so it wins over both exit and tab close.
  if (stop) return { state: 'stopped', exitReason: 'stop requested', outputWritten } as const;
  if (alive === false) return { state: outputWritten ? 'closed' : 'failed', exitReason: outputWritten ? 'settled' : 'worker exited', outputWritten } as const;
  if (tabClosed) return { state: 'failed', exitReason: 'tab closed', outputWritten } as const;
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
  if (reportChanged || (next.quietSince !== null && (facts.workingAt ?? -Infinity) > next.quietSince)) next.quietSince = null;
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
  if (facts.sonic?.open) return { ...next, state: 'working', quietSince: null, quietHandled: false, decisionWait: false };
  if (awaitingReceipt) {
    next.quietHandled = false;
    next.decisionWait = false;
  }
  if (next.state === 'idle_grace' && !collectSonic) {
    if (!readReport && now < next.deadline!)
      return { ...next, state: 'idle_grace', wakeAt: next.deadline };
    if (!declared) {
      if (facts.status === 'working' || facts.liveChild) return { ...next, state: 'idle_grace' };
      if (facts.liveChild === null) return { ...next, state: 'idle_grace', action: 'sample' };
    }
    return end('closed', readReport ? REPORT_READ_EXIT : 'settled', true);
  }
  const trustedEnd = facts.stateTrust === 'turn' && (facts.workingAt ?? -Infinity) >= Date.parse(facts.turn.sent_at)
    && (facts.status === 'done' || facts.status === 'idle');
  const quiet = declared || (facts.status !== 'working' && (facts.status !== null || report));
  next.quietSince = quiet ? (next.quietSince ?? now) : null;
  if ((!report || awaitingReceipt) && facts.liveChild) next.quietSince = null;
  if (next.quietSince === null) return { ...next, state: 'working', quietHandled: false, decisionWait: false };
  if (report || collectSonic || awaitingReceipt) {
    // A trusted turn end shortens stability, not the fresh-receipt grace or the outage window.
    if (!declared) {
      const stableMs = trustedEnd ? 2000 : 10_000;
      const due = Math.max(next.quietSince + Math.max(stableMs, awaitingReceipt ? facts.graceMs : 0),
        facts.status === null ? next.errorsSince! + 60_000 : 0);
      if (now < due) return { ...next, state: 'working', wakeAt: due };
      if (facts.liveChild === null) return { ...next, state: 'working', action: 'sample' };
      if (facts.liveChild) return { ...next, state: 'working' };
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
  const due = next.quietSince + (trustedEnd && !next.decisionWait ? 10_000 : facts.graceMs);
  next.reason = !newTurn ? prev?.reason ?? null : null;
  if (now < due && !facts.decision && !next.quietHandled) return { ...next, state: 'working', wakeAt: due };
  if (facts.liveChild === null) return { ...next, state: 'working', action: 'sample' };
  const decision = facts.decision;
  if (decision?.action === 'fail') return end('failed', decision.failReason ?? 'quota failure');
  if (decision?.action === 'wait' || decision?.action === 'prompt-report') {
    return { ...next, state: 'working', quietSince: now, quietHandled: false, decisionWait: true,
      reason: decision.action === 'wait' ? 'turn ended, no report yet' : null, wakeAt: now + facts.graceMs };
  }
  if (decision || next.quietHandled) return {
    ...next, state: 'waiting_orchestrator', quietHandled: true,
    reason: 'quiet without a report; hud_send to continue or hud_close to stop',
  };
  return { ...next, state: 'working', action: 'decide' };
}
