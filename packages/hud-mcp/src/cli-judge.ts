import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { QuietDecision } from './quiet-decision.js';
import { procStat } from '../../../src/roles/worker-tree.js';
export { procStat };

export interface Turn {
  seq: number;
  sent_at: string;
  report_sig: string | null;
  report_prompt_sent?: boolean;
  first_sent_at?: string;
  send?: { key: string; pid: number; start: string | null };
}

export const firstInput = (turn: Turn) => turn.first_sent_at ?? (turn.seq === 1 ? turn.sent_at : undefined);

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

export const DONE_FILE = 'done.json';
export type DoneReceipt = Pick<Turn, 'seq' | 'sent_at'> & { report_sig: string; at: string };
export const turnToken = (turn: Turn) => `${turn.seq}@${turn.sent_at}`;
export const withDonePrompt = (text: string, bundled: string, dir: string, turn: Turn) =>
  `${text}\n\nAfter writing the report for this turn, run: node ${JSON.stringify(join(bundled, 'bin', 'hud-progress.mjs'))} --done --dir ${JSON.stringify(dir)} --turn ${turnToken(turn)}\nThen end with only \`report written: ${join(dir, 'report.md')}\`. Use the command from the prompt you are answering, not a newer turn.\n`;

export function readDone(dir: string): DoneReceipt | null {
  try {
    const fd = fs.openSync(join(dir, DONE_FILE), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const st = fs.fstatSync(fd);
      return st.isFile() && st.size <= 1024 ? JSON.parse(fs.readFileSync(fd, 'utf8')) as DoneReceipt : null;
    } finally { fs.closeSync(fd); }
  } catch { return null; } // Missing or unreadable evidence does not authorize a close.
}

/** Publish before input: a fast report must differ from the send-time baseline. */
export function writeTurn(dir: string, reportPromptSent?: boolean, send?: Turn['send']): Turn {
  const prev = readTurn(dir);
  const sent = reportPromptSent || prev?.report_prompt_sent;
  const turn: Turn = {
    seq: (prev?.seq ?? 0) + 1,
    sent_at: new Date().toISOString(),
    report_sig: reportSignature(dir),
    ...(sent ? { report_prompt_sent: true } : {}),
    ...(prev && firstInput(prev) ? { first_sent_at: firstInput(prev) } : {}),
    ...(send ? { send } : {}),
  };
  saveTurn(dir, turn);
  return turn;
}

export function saveTurn(dir: string, turn: Turn): void {
  const file = join(dir, 'turn.json');
  fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(turn) + '\n', { mode: 0o600 });
  fs.renameSync(`${file}.${process.pid}.tmp`, file);
}

export function workerAlive(pid: number | null, start: string | null): boolean | null {
  if (!Number.isInteger(pid) || !pid || pid <= 0) return null;
  const info = procStat(pid);
  if (info === null || info.state === 'Z') return false;
  return start ? info.start === start : null;
}

type Bootstrap = { stage: 'launcher' } | { stage: 'shell' | 'server'; entry: string };
const base = (path = '') => path.split('/').at(-1);
function bootstrap(pid: number, start: string, launchDirect: boolean, parent: number, chain?: Bootstrap): Bootstrap | boolean {
  let argv;
  try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0+$/, '').split('\0'); }
  catch { return false; }
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
  const buffer = Buffer.alloc(4096);
  const parents: { pid: number; start: string | null; chain?: Bootstrap }[] = [{ pid, start }];
  let budget = 512;
  try {
    const boot = +new Date() - parseFloat(fs.readFileSync('/proc/uptime', 'utf8')) * 1000;
    const since = Math.floor((Date.parse(sentAt) - boot) / 10); // Linux USER_HZ is 100; include the send's whole tick.
    const first = Math.floor((Date.parse(firstSentAt ?? '') - boot) / 10);
    // First input can race helper startup. A continuation does not get a launch window.
    const launchThrough = sentAt === firstSentAt ? first + 1000 : first - 1; // 10 s in USER_HZ ticks.
    if (!Number.isFinite(since)) return 'unknown';
    for (let item; (item = parents.pop()) !== undefined;) {
      const { pid: parent, chain } = item;
      if (chain && workerAlive(parent, item.start) !== true) return 'unknown';
      const tasks = `/proc/${parent}/task`;
      let threads;
      try { threads = fs.opendirSync(tasks); }
      catch (error) {
        if (parent !== pid && ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
        throw error;
      }
      try {
        for (let thread; (thread = threads.readSync()) !== null;) {
          if (--budget < 0) return 'unknown';
          let size;
          try {
            const fd = fs.openSync(`${tasks}/${thread.name}/children`, 'r');
            try { size = fs.readSync(fd, buffer, 0, buffer.length, null); }
            finally { fs.closeSync(fd); }
          } catch (error) {
            if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
            return 'unknown';
          }
          // Skip a possibly truncated final PID; incomplete coverage cannot justify closing.
          const ids = buffer.toString('utf8', 0, size).trimStart().split(/\s+/);
          if (size === buffer.length) ids.pop();
          for (const id of ids) {
            if (!id) continue;
            if (--budget < 0) return 'unknown';
            const child = procStat(Number(id));
            if (child?.ppid !== parent || (child.threads <= 1 && /^[ZXx]$/.test(child.state ?? ''))) continue;
            const childStart = Number(child.start);
            const launchDirect = parent === pid && childStart <= launchThrough;
            const match = launchDirect || chain ? bootstrap(Number(id), child.start, launchDirect, parent, chain) : false;
            if (!match && childStart >= since) return workerAlive(pid, start) === true;
            parents.push({ pid: Number(id), start: child.start, ...(typeof match === 'object' ? { chain: match } : {}) });
          }
          if (size === buffer.length) return 'unknown';
        }
      } finally { threads.closeSync(); }
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
  const receipt = done?.seq === facts.turn.seq && done.sent_at === facts.turn.sent_at &&
    typeof done.report_sig === 'string' && done.report_sig !== facts.turn.report_sig && Number.isFinite(Date.parse(done.at));
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
