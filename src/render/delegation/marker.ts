/**
 * Five state dimensions plus the ledger's run facts, projected to one marker
 * (design §3.3). A pure function: the first matching row of the table wins,
 * and everything the renderers need from it (glyph, colour role, words, bucket,
 * clock, history eligibility) comes out of the same call, so the bar, the
 * statusline and the panel rows cannot disagree about a node.
 *
 * The B16 `stateKey` is read as the semantic class (its prefix) and the
 * dimensions are read as a second witness; either alone is enough, so a view
 * model whose status is missing (`null`, "unavailable") still gets the rows
 * the ledger can answer and falls to `? unknown` on the rest, never a guess.
 */

import type { StateSinceBasis } from '../../core/types/observation.js';
import type { NodeFacts } from './facts.js';
import type { Glyph, HarnessMark } from './glyphs.js';
import { W, type Role } from './style.js';

/** 0 needs a person, 1 alive, 2 alive but marked like an ending, 3 ended (§3.2). */
export type Rank = 0 | 1 | 2 | 3;
export type ClockKind = 'turn' | 'dwell' | 'evidence' | 'age' | 'none';

export interface MarkerClock {
  kind: ClockKind;
  /** Epoch ms the age is measured from; null leaves the column empty (never an invented age). */
  at: number | null;
  /** Observed rather than evented (`~10s`). */
  approx: boolean;
}

export interface NodeMarker {
  glyph: Glyph;
  role: Role;
  /** English word keys after the name, in order (`ended`, `runtime limit`). */
  words: string[];
  rank: Rank;
  /** §3.4: rows of the trouble kinds drop the badge and the meter. */
  trouble: boolean;
  /** The role turns muted this many ms after `sinceMs` (`FRESH_FINISH_MS`); null never. */
  fadesAfterMs: number | null;
  /** Whether the name is muted: always (stale, not loaded), after the fade (history), never. */
  muteName: 'always' | 'afterFade' | 'never';
  sinceMs: number | null;
  sinceBasis: StateSinceBasis;
  clock: MarkerClock;
  /** A terminal row that the 3 minute rule may put away; needs a known finish time. */
  historyEligible: boolean;
  finishedAt: number | null;
  /** `close pane` and `stop in pane` are two hints, not states (§3.3 rows 5a, 9b). */
  closePane: boolean;
  stopInPane: boolean;
  supervisorLost: boolean;
  /** The pending word of a `⚑` row, for the bar's alert text. */
  alertWord: string | null;
  notLoaded: boolean;
  /** `?` and `⚠` are counted per marker, but only a few of them light the bar. */
  uncertain: boolean;
  stale: boolean;
}

export const FRESH_MS = 60_000;

const RUN_REASON_WORD: Record<string, string> = {
  runtime_limit: W.runtimeLimit,
  retire_idle: W.idleLimit,
  retire_blocked_wait: W.blockedLimit,
  orphan_policy: W.parentGone,
};

type StateClass =
  | 'conflict'
  | 'uncertain'
  | 'pending'
  | 'failed'
  | 'interrupted'
  | 'stale'
  | 'working'
  | 'starting'
  | 'exited'
  | 'idle'
  | 'unknown';
const CLASSES = new Set<string>([
  'conflict',
  'uncertain',
  'pending',
  'failed',
  'interrupted',
  'stale',
  'working',
  'starting',
  'exited',
  'idle',
  'unknown',
]);

function stateClass(key: string | null): { cls: StateClass | null; reason: string | null } {
  if (!key) return { cls: null, reason: null };
  if (key === 'launch_failed') return { cls: 'failed', reason: 'launch_failed' };
  const at = key.indexOf(':');
  const cls = at < 0 ? key : key.slice(0, at);
  return CLASSES.has(cls)
    ? { cls: cls as StateClass, reason: at < 0 ? null : key.slice(at + 1) }
    : { cls: null, reason: null };
}

function pendingWord(pendingReason: string, reason: string | null, blockedReport: boolean): string {
  const raw = pendingReason !== 'none' ? pendingReason : reason;
  if (raw === 'approval') return W.approval;
  if (raw === 'question') return W.question;
  if (raw === 'needs_human') return W.needsHuman;
  return blockedReport ? W.blocked : raw === 'blocked' ? W.blocked : W.needsHuman;
}

/** `ended · runtime limit` etc.: the requested cause, only when the ledger holds it (§3.3 row 9a). */
function endedWords(requestedCause: string | null, hasReport: boolean): string[] {
  const reason = requestedCause ? RUN_REASON_WORD[requestedCause] : undefined;
  return !hasReport && reason ? [W.ended, reason] : [W.ended];
}

const NO_CLOCK: MarkerClock = { kind: 'none', at: null, approx: false };

/**
 * The first matching row of §3.3, from the node's facts alone (`facts.ts`).
 *
 * A clock the observation calls anomalous (`freshness.clockAnomaly`, the clock ran backwards) is not trusted
 * for any age: the row keeps its marker and word but has no clock and no entering time, so nothing is sorted,
 * faded or told "just now" by it (§3.4 "时钟倒退留空").
 */
export function deriveMarker(f: NodeFacts): NodeMarker {
  const isRoot = f.isRoot;
  const exec = { isRunTerminal: f.isRunTerminal };
  // Row inputs the observation owns are ignored for a node that was not loaded: its old summary is history.
  // An observation the reader said is unavailable is not read at all, whatever status it left behind.
  const hasStatus = f.loaded && !f.observationUnavailableReason && f.hasStatus;
  const managed = exec.isRunTerminal !== null;
  const { cls, reason: classReason } = stateClass(hasStatus ? f.stateKey : null);
  const activity = hasStatus ? (f.activity ?? 'unknown') : 'unknown';
  const liveness = hasStatus ? (f.liveness ?? 'unknown') : 'unknown';
  const pendingReason = hasStatus ? (f.pendingReason ?? 'none') : 'none';
  const lastTurnOutcome = hasStatus ? f.lastTurnOutcome : null;
  const anomaly = hasStatus && f.clockAnomaly;
  const statusSince = hasStatus ? f.stateSince : null;
  const statusBasis = (hasStatus ? (f.stateSinceBasis ?? 'unknown') : 'unknown') as StateSinceBasis;
  const evidenceAt = hasStatus ? f.lastEvidenceAt : null;
  const runState = f.runState;
  const visible = f.runMode === 'visible';
  const reportStatus = f.reportStatus;
  const hasReport = reportStatus !== null;

  const base = (glyph: Glyph, role: Role, extra: Partial<NodeMarker> = {}): NodeMarker => {
    const marker: NodeMarker = {
      glyph,
      role,
      words: [],
      rank: 1,
      trouble: false,
      fadesAfterMs: null,
      muteName: 'never',
      sinceMs: null,
      sinceBasis: 'unknown',
      clock: NO_CLOCK,
      historyEligible: false,
      finishedAt: null,
      closePane: false,
      stopInPane: false,
      supervisorLost: false,
      alertWord: null,
      notLoaded: false,
      uncertain: false,
      stale: false,
      ...extra,
    };
    return anomaly ? { ...marker, clock: NO_CLOCK, sinceMs: null, sinceBasis: 'unknown' } : marker;
  };
  const sinceOf = (
    fallback: number | null,
    fallbackBasis: StateSinceBasis = 'event'
  ): { at: number | null; basis: StateSinceBasis } => {
    if (anomaly) return { at: null, basis: 'unknown' };
    if (statusSince !== null && statusBasis !== 'unknown') return { at: statusSince, basis: statusBasis };
    return fallback === null ? { at: null, basis: 'unknown' } : { at: fallback, basis: fallbackBasis };
  };
  const dwell = (s: { at: number | null; basis: StateSinceBasis }): MarkerClock =>
    s.at === null ? NO_CLOCK : { kind: 'dwell', at: s.at, approx: s.basis === 'observed' };

  // 1. Contradicting records: not a guess at either one.
  if (f.conflictCount > 0)
    return base('warn', 'warning', {
      words: [W.conflict],
      rank: 0,
      trouble: true,
      sinceMs: f.conflictSince,
      sinceBasis: 'observed',
      clock: { kind: 'dwell', at: f.conflictSince, approx: true },
    });

  // A node the observation did not load: ended in the ledger it is a history row (below); otherwise the
  // honest row is `? not loaded`, not the last summary and not a guess (§3.4).
  // It sorts with the living (rank 1, creation order), drops badge and meter like the other `?` rows, and never
  // lights the bar: the coverage chip and the root Inspector carry the signal, and §4.1's attention list does
  // not include it. It is counted as `?` by marker (rulings B10b s1, Q4).
  if (!f.loaded && exec.isRunTerminal !== true)
    return base('unknown', 'muted', {
      words: [W.notLoaded],
      rank: 1,
      trouble: true,
      muteName: 'always',
      notLoaded: true,
    });

  // 2. Run state needing reconciliation.
  if (runState === 'uncertain' || cls === 'uncertain') {
    const lost = f.reconciliationCause === 'supervisor_dead' || classReason === 'supervisor_dead';
    const at = evidenceAt ?? f.runHeartbeatAt ?? null;
    const since = sinceOf(f.runCreatedAt);
    return base('unknown', 'warning', {
      words: [lost ? W.supervisorLost : W.uncertain],
      rank: 0,
      trouble: true,
      uncertain: true,
      supervisorLost: lost,
      sinceMs: since.at,
      sinceBasis: since.basis,
      clock: { kind: 'evidence', at, approx: false },
    });
  }

  // 3. Something waits for a person.
  const blockedReport = reportStatus === 'blocked';
  if (hasStatus ? pendingReason !== 'none' || cls === 'pending' || blockedReport : blockedReport) {
    const word = pendingWord(pendingReason, classReason, blockedReport);
    const since = sinceOf(blockedReport ? f.reportCreatedAt : null);
    return base('flag', 'alert', {
      words: [word],
      rank: 0,
      trouble: true,
      alertWord: word,
      sinceMs: since.at,
      sinceBasis: since.basis,
      clock: dwell(since),
    });
  }

  // A plain session or a native child that has ended by its own facts (the observation says its process is
  // gone, or it exited) is a finished row whatever it ended as: §3.2 gives natives their history eligibility
  // through their own completion facts. A managed run's end is the ledger's alone; the root never folds.
  const exitedFact = hasStatus && (liveness === 'gone' || activity === 'exited' || cls === 'exited');
  const nativeEnded = !managed && !isRoot && exitedFact;
  const terminal = exec.isRunTerminal === true || nativeEnded;

  // 4. Failure: a turn, a report, a native result with a source, or a run that never executed.
  const launchFailed = runState === 'failed' || f.launchFailed || classReason === 'launch_failed';
  const nativeFailure =
    f.runExitSource !== null && ((f.runExitCode !== null && f.runExitCode !== 0) || f.runExitSignal !== null);
  const failedReport = reportStatus === 'failed';
  if (launchFailed || nativeFailure || failedReport || lastTurnOutcome === 'failed' || cls === 'failed') {
    // A visible run that reported and is still alive keeps its slot until the user closes the pane.
    const closePane = !terminal && managed && visible && failedReport;
    const since = sinceOf(failedReport ? f.reportCreatedAt : f.runEndedAt);
    const finishedAt = terminal ? (f.runEndedAt ?? f.reportCreatedAt ?? since.at) : null;
    return base('fail', 'danger', {
      words: [launchFailed ? W.launchFailed : W.failed],
      rank: terminal ? 3 : managed && failedReport ? 2 : 0,
      trouble: true,
      closePane,
      sinceMs: since.at,
      sinceBasis: since.basis,
      clock: terminal
        ? { kind: 'age', at: finishedAt, approx: finishedAt === since.at && since.basis === 'observed' }
        : dwell(since),
      historyEligible: terminal && !isRoot && finishedAt !== null,
      finishedAt,
      muteName: terminal ? 'afterFade' : 'never',
    });
  }

  // 5a. A visible cancel was accepted and cannot be delivered; the run is alive and only the user can stop it.
  if (runState === 'cancelling' && visible) {
    const since = sinceOf(f.runCancelRequestedAt);
    return base('flag', 'alert', {
      words: [W.stopInPane],
      rank: 0,
      trouble: true,
      stopInPane: true,
      alertWord: W.stopInPane,
      sinceMs: since.at,
      sinceBasis: since.basis,
      clock: dwell(since),
    });
  }

  // 5b. Interrupted, cancelling (headless ladder in flight) or cancelled.
  const cancelling = runState === 'cancelling';
  if (
    cancelling ||
    runState === 'cancelled' ||
    lastTurnOutcome === 'interrupted' ||
    reportStatus === 'interrupted' ||
    cls === 'interrupted'
  ) {
    const since = sinceOf(f.runCancelRequestedAt ?? f.runEndedAt ?? f.reportCreatedAt);
    const finishedAt = terminal ? (f.runEndedAt ?? since.at) : null;
    return base('stop', 'warning', {
      words: [cancelling ? W.cancelling : runState === 'cancelled' ? W.cancelled : W.interrupted],
      rank: terminal ? 3 : 2,
      trouble: true,
      fadesAfterMs: FRESH_MS,
      muteName: terminal ? 'afterFade' : 'never',
      sinceMs: since.at,
      sinceBasis: since.basis,
      clock: terminal ? { kind: 'age', at: finishedAt, approx: false } : dwell(since),
      historyEligible: terminal && !isRoot && finishedAt !== null,
      finishedAt,
    });
  }

  // 6. Sources lost, not reconciled: quiet, and never the last known good marker. Only the current freshness
  // decides (`stale` is lost sources, every other reading of "not fresh" is `unknown`, §3.3 row 6): a retained
  // `stale:` state key beside a fresh reading is history, not the present.
  if (hasStatus && (f.freshnessState !== 'fresh' || (liveness === 'unknown' && activity === 'unknown'))) {
    return base('unknown', 'muted', {
      words: [f.freshnessState === 'stale' ? W.stale : W.unknown],
      rank: 0,
      trouble: true,
      stale: true,
      muteName: 'always',
      sinceMs: statusSince,
      sinceBasis: statusBasis,
      clock: { kind: 'evidence', at: evidenceAt ?? f.runHeartbeatAt ?? null, approx: false },
    });
  }

  // 7. Working.
  if (hasStatus && (activity === 'working' || cls === 'working')) {
    const since = sinceOf(null);
    return base('working', 'info', {
      rank: 1,
      sinceMs: since.at,
      sinceBasis: since.basis,
      clock: { kind: 'turn', at: since.at, approx: since.basis === 'observed' },
    });
  }

  const terminalManaged = exec.isRunTerminal === true;

  // 8. Starting.
  const linkState = f.linkState;
  const awaitingLink = (linkState === 'pending' || linkState === 'claimed') && (!hasStatus || activity === 'unknown');
  if (runState === 'starting' || cls === 'starting' || (awaitingLink && !terminalManaged)) {
    const since = sinceOf(f.runCreatedAt);
    return base('starting', 'muted', {
      words: [W.starting],
      rank: 1,
      trouble: true,
      sinceMs: since.at,
      sinceBasis: since.basis,
      clock: { kind: 'age', at: since.at, approx: since.basis === 'observed' },
    });
  }

  // 9b. Reported while the run is still alive (B16 `exited:reported`): a visible agent waits for its pane to
  // be closed, a headless one for hud-run to retire it. The slot is held either way, so the row stays alive.
  if (managed && !terminalManaged && reportStatus === 'completed') {
    return base('done', 'success', {
      words: [visible ? W.closePane : W.reported],
      rank: 2,
      fadesAfterMs: FRESH_MS,
      closePane: visible,
      sinceMs: f.reportCreatedAt,
      sinceBasis: 'event',
      clock: { kind: 'age', at: f.reportCreatedAt, approx: false },
    });
  }

  // 9a. The run is over (process group verified empty, whatever the exit result), or a session exited.
  if (terminalManaged || exitedFact) {
    const finishedAt = terminalManaged ? (f.runEndedAt ?? f.reportCreatedAt ?? statusSince) : statusSince;
    const approx = finishedAt !== null && finishedAt === statusSince && statusBasis === 'observed';
    if (managed && reportStatus === 'completed')
      return base('done', 'success', {
        words: [W.reported],
        rank: 3,
        fadesAfterMs: FRESH_MS,
        muteName: 'afterFade',
        sinceMs: finishedAt,
        sinceBasis: 'event',
        clock: { kind: 'age', at: finishedAt, approx },
        historyEligible: !isRoot && finishedAt !== null,
        finishedAt,
      });
    return base('stop', 'warning', {
      words: managed ? endedWords(f.requestedCause, hasReport) : [W.exited],
      rank: 3,
      fadesAfterMs: FRESH_MS,
      muteName: 'afterFade',
      sinceMs: finishedAt,
      sinceBasis: 'event',
      clock: { kind: 'age', at: finishedAt, approx },
      historyEligible: !isRoot && finishedAt !== null,
      finishedAt,
    });
  }

  // 10. Idle.
  if (hasStatus && (activity === 'idle' || activity === 'waiting_input' || cls === 'idle')) {
    const since = sinceOf(null);
    if (managed)
      return base('starting', 'muted', {
        words: [W.idle],
        rank: 1,
        sinceMs: since.at,
        sinceBasis: since.basis,
        clock: { kind: 'age', at: since.at, approx: since.basis === 'observed' },
      });
    // A plain session at rest keeps today's green check; a finished native child is a finished row.
    // §3.3 row 10 ("root session or native node: ✓, today's meaning") and §3.2: a native child at rest has
    // finished its own work, so it is a `✓` history row (rank 3, put away after the linger window, §2 (b);
    // rulings B10b s1, Q5).
    return base('done', 'success', {
      rank: isRoot ? 1 : 3,
      sinceMs: since.at,
      sinceBasis: since.basis,
      clock: { kind: 'age', at: since.at, approx: since.basis === 'observed' },
      historyEligible: !isRoot && since.at !== null,
      finishedAt: isRoot ? null : since.at,
      fadesAfterMs: isRoot ? null : FRESH_MS,
      muteName: isRoot ? 'never' : 'afterFade',
    });
  }

  // 11. Not enough evidence: unknown, quiet, and no clock.
  return base('unknown', 'muted', { words: [W.unknown], rank: 0, trouble: true, stale: true, muteName: 'always' });
}

/** The harness a node's icon slot shows (null for natives without a mark, and for roots in a single-harness view). */
export function harnessOf(f: NodeFacts): HarnessMark | null {
  if (f.idKind === 'job') return 'jev';
  if (f.idKind === 'session') return f.idHarness;
  // An intent has no session yet: the link's child when it names one, else the backend profile name, and only
  // when that names a harness.
  return f.childHarness ?? harnessFromBackend(f.linkBackend ?? undefined);
}

/** A backend profile name that begins with a harness name (`codex-sol`, `pi-reviewer`); anything else is no hint. */
export function harnessFromBackend(backend: string | undefined): HarnessMark | null {
  const name = backend?.toLowerCase() ?? '';
  return name.startsWith('codex')
    ? 'codex'
    : name.startsWith('pi')
      ? 'pi'
      : name.startsWith('claude')
        ? 'claude'
        : null;
}
