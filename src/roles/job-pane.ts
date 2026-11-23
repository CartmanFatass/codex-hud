/** Notification and ownership scope, not the worker's SESSION.txt LEFT pane. */
export function jobCallerPane(job: { caller_pane?: unknown; herdr_pane?: unknown }): string {
  const pane = job.caller_pane ?? job.herdr_pane; // Tabbed jobs and older headless receipts.
  return typeof pane === 'string' ? pane : '';
}
