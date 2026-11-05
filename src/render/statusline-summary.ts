/** Small direct-child display. No fake tree, totals, report text or transcript titles. */
import type { StatuslineSummary, StatuslineChild } from '../core/statusline-summary.js';
import { newNodeFacts } from './delegation/facts.js';
import { deriveMarker, harnessFromBackend } from './delegation/marker.js';
import { glyphSet, GLYPHS } from './delegation/glyphs.js';
import { monitorText } from './monitor-text.js';
import { truncateAnsi, visualLength } from './colors.js';
import { age } from './monitor-labels.js';

function facts(child: StatuslineChild) {
  const f = newNodeFacts();
  const status = child.status;
  const run = child.run;
  Object.assign(f, {
    key: child.key,
    conflictCount: child.conflict?.count ?? 0,
    conflictSince: child.conflict?.since ?? null,
    conflictName: child.conflict ? child.label : null,
    idKind: child.ref ? 'session' : 'delegationIntent',
    idHarness: child.ref?.harness ?? null,
    edge: child.ref ? 'delegated' : 'intent',
    loaded: status !== null,
    hasStatus: status !== null,
    stateKey: status?.stateKey ?? null,
    stateSince: status?.stateSince ?? null,
    stateSinceBasis: status?.stateSinceBasis ?? null,
    freshnessState: status?.freshness.state ?? null,
    clockAnomaly: status?.freshness.clockAnomaly ?? false,
    liveness: status?.liveness ?? null,
    activity: status?.activity ?? null,
    pendingReason: status?.pendingReason ?? null,
    lastTurnOutcome: status?.lastTurnOutcome ?? null,
    lastEvidenceAt: status?.lastEvidenceAt ?? null,
    observationUnavailableReason: child.unavailableReason,
    runId: run?.id ?? null,
    runState: run?.state ?? null,
    runMode: run?.mode ?? null,
    runCreatedAt: run?.createdAt ?? null,
    runEndedAt: run?.endedAt ?? null,
    runCancelRequestedAt: run?.cancelRequestedAt ?? null,
    isRunTerminal: run ? ['ended', 'failed', 'cancelled'].includes(run.state) : null,
    linkState: child.linkState,
  });
  return f;
}

/** Always marks the limited index scope. Unknown tree totals/capacity are never rendered. */
export function renderStatuslineSummary(summary: StatuslineSummary, width: number, nowMs: number): string | null {
  if (summary.state === 'unavailable' || summary.children.length === 0) return null;
  const g = glyphSet(false);
  const items = summary.children.map((child) => ({ child, marker: deriveMarker(facts(child)) }));
  // Same buckets as the panel. Deterministic tie-break without a ledger-wide sort or scan.
  items.sort(
    (a, b) =>
      a.marker.rank - b.marker.rank ||
      (a.marker.rank === 0 ? (b.marker.sinceMs ?? -1) - (a.marker.sinceMs ?? -1) : 0) ||
      a.child.key.localeCompare(b.child.key)
  );
  const live = items.filter(
    ({ marker: m }) => m.rank < 3 || (m.glyph === 'fail' && m.finishedAt !== null && nowMs - m.finishedAt < 60000)
  );
  if (live.length === 0) return null;
  const prefix = `${g.delegated} partial${summary.limitReached ? ' (limit)' : ''}`;
  if (visualLength(prefix) > width) return null;
  const parts = live.map(({ child, marker }) => {
    const harness = child.ref?.harness ?? harnessFromBackend(child.backend);
    const label = monitorText(child.label || 'delegation').replace(/[\u2028\u2029]/g, ' ');
    const clock = marker.clock;
    const duration =
      clock.at !== null && clock.kind !== 'none' && clock.at <= nowMs
        ? `${clock.approx ? '~' : ''}${age(new Date(clock.at), nowMs)}`
        : '';
    return {
      marker,
      name: `${g.marker[marker.glyph]}${harness ? ` ${g.harness[harness]}` : ''} ${truncateAnsi(label, 24)}`,
      words: marker.words.join(' '),
      duration,
    };
  });
  const maxShown = width >= 160 ? 5 : width >= 100 ? 3 : 2;
  for (const details of [true, false])
    for (let show = Math.min(maxShown, parts.length); show >= 0; show--) {
      const selected = parts
        .slice(0, show)
        .map((p) => [p.name, p.words, details ? p.duration : ''].filter(Boolean).join(' '));
      const rest = parts.slice(show);
      const folded = GLYPHS.filter((kind) => rest.some((p) => p.marker.glyph === kind)).map(
        (kind) =>
          `+${rest.filter((p) => p.marker.glyph === kind).length}${kind === 'fail' ? g.barFail : g.marker[kind]}`
      );
      const line = [prefix, ...selected, ...folded].join(` ${g.sep} `);
      if (visualLength(line) <= width) return line;
    }
  return prefix;
}
