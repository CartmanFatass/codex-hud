import { openLedgerReader } from '../core/ledger-read.js';
import { latestReportForRun } from '../core/lifecycle.js';
import type { LedgerReadRun, LedgerReader, LedgerReadSnapshot } from '../core/ledger-read.js';
import type { LedgerEvent } from '../core/types/execution.js';
import type { CommittedReport, Link, Report } from '../core/types/lifecycle.js';

export interface LinkListEntry {
  link: Link;
  currentRun: LedgerReadRun | null;
  latestReportForRun: Report | null;
}

export interface LinkListResult {
  ledgerId: string;
  asOfSeq: number;
  links: LinkListEntry[];
}

export interface LinkShowResult {
  ledgerId: string;
  asOfSeq: number;
  /** A missing link is distinct from an unavailable ledger (which throws). */
  link: Link | null;
  currentRun: LedgerReadRun | null;
  latestReportForRun: Report | null;
  runs: LedgerReadSnapshot['runs'];
  claims: LedgerReadSnapshot['claims'];
  reports: LedgerReadSnapshot['reports'];
  bindings: LedgerReadSnapshot['bindings'];
  events: LedgerReadSnapshot['events'];
  evidence: LedgerReadSnapshot['evidence'];
  slots: LedgerReadSnapshot['slots'];
}

async function read<T>(ledger: string | LedgerReader, action: (reader: LedgerReader) => T): Promise<T> {
  const reader = typeof ledger === 'string' ? await openLedgerReader(ledger) : ledger;
  try {
    return action(reader);
  } finally {
    if (typeof ledger === 'string') reader.close();
  }
}

/** B5 appends report.received with payload {reportId} and the report's run/link in the report transaction. */
function committedReports(reports: readonly Report[], events: readonly LedgerEvent[]): CommittedReport[] {
  const byId = new Map(reports.map((report) => [report.reportId, report]));
  const committed: CommittedReport[] = [];
  for (const event of events) {
    if (event.kind !== 'report.received' || typeof event.payload.reportId !== 'string') continue;
    const report = byId.get(event.payload.reportId);
    if (report && report.runId === event.runId && report.linkId === event.linkId)
      committed.push({ report, seq: event.seq });
  }
  return committed;
}

/** Callable hud link list entry point. B11 owns argument parsing and presentation. */
export function linkListCommand(ledger: string | LedgerReader): Promise<LinkListResult> {
  return read(ledger, (reader) =>
    reader.withSnapshot((view) => {
      const currentRuns = new Map(view.listRuns().map((run) => [run.linkId, run]));
      const reportsByRun = new Map<string, CommittedReport[]>();
      for (const report of committedReports(view.listReports(), view.listEvents())) {
        const group = reportsByRun.get(report.report.runId) ?? [];
        group.push(report);
        reportsByRun.set(report.report.runId, group);
      }
      return {
        ledgerId: view.ledgerId,
        asOfSeq: view.asOfSeq,
        links: view.listLinks().map((link) => {
          const currentRun = currentRuns.get(link.linkId) ?? null;
          return {
            link,
            currentRun,
            latestReportForRun:
              currentRun === null
                ? null
                : latestReportForRun(reportsByRun.get(currentRun.runId) ?? [], currentRun.runId),
          };
        }),
      };
    })
  );
}

/** Callable hud link show entry point. No collection, reconciliation or migration occurs. */
export function linkShowCommand(ledger: string | LedgerReader, linkId: string): Promise<LinkShowResult> {
  if (typeof linkId !== 'string' || linkId.length === 0) throw new TypeError('A link ID is required.');
  return read(ledger, (reader) => {
    const { links, ...snapshot } = reader.snapshot({ linkIds: [linkId] });
    const link = links[0] ?? null;
    const currentRun = snapshot.runs.at(-1) ?? null;
    return {
      ...snapshot,
      link,
      currentRun,
      latestReportForRun:
        currentRun === null
          ? null
          : latestReportForRun(committedReports(snapshot.reports, snapshot.events), currentRun.runId),
    };
  });
}
