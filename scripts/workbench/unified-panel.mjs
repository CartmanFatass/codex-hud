// One canonical tree and destination list; SIMULATED job details are display-only.
import { delegationView, delegationAgentsRows } from '../../dist/render/delegation/panel.js';
import { resolveSelection } from '../../dist/render/delegation/selection.js';
import { inspectorRows } from '../../dist/render/monitor-inspector.js';
import { initialMonitorState } from '../../dist/render/monitor.js';
import { stripAnsi } from '../../dist/render/colors.js';
import { fit, monitorText } from '../../dist/render/monitor-text.js';

export function buildUnifiedFrame(vm, selected = null, width = 88, ordinary = null, nowMs = Date.now()) {
  const view = delegationView(vm, { nowMs, style: 'compact', showHistory: true });
  const selectedId = resolveSelection(selected, view.proj, view.plan, view.dest);
  const nodes = new Map(vm.tree.nodes.map((n) => [n.key, n]));
  const line = (text) => fit(monitorText(text), width);
  const paintedJobs = new Set();
  const agents = delegationAgentsRows(vm, { width, nowMs, style: 'compact', showHistory: true, selectedId }).flatMap(
    (r) => {
      const node = nodes.get(r.key),
        job = node?.simulationJob;
      if (!job) return [fit(stripAnsi(r.text), width)];
      if (paintedJobs.has(node.key)) return [];
      paintedJobs.add(node.key);
      const stale = job.availability === 'last_known';
      const custody = `${stale ? 'last known browser' : 'browser'} ${job.lease ? 'held' : 'free'}`;
      const summary = stale ? `${custody} · last known ${job.state}` : `${job.state} · ${custody}`;
      return [
        line(
          `${'  '.repeat(node.depth)}${node.key === selectedId ? '›' : '◎'} SIMULATED Jev ${job.ref.key} · ${summary}${job.holderLabel ? ` by ${job.holderLabel}` : ''}`
        ),
      ];
    }
  );
  const status = vm.tree.simulationJobs;
  if (status?.availability === 'unavailable')
    agents.unshift(line(`SIMULATED jobs unavailable: ${status.reason}; current count/holder unknown`));
  const node = nodes.get(selectedId),
    job = node?.simulationJob;
  let details;
  if (job) {
    const stale = job.availability === 'last_known';
    details = [
      `SIMULATED Job ${job.ref.key}${stale ? ' · LAST KNOWN' : ''}`,
      `Provider: ${job.ref.provider} · account: ${job.ref.account ?? 'unspecified'}`,
      `${stale ? 'Last known state' : 'State'}: ${job.state}${stale ? ` · unavailable: ${job.reason}` : ''}`,
      `${stale ? 'Last known browser' : 'Browser'}: ${job.lease ? 'held' : 'free'}${job.state === 'queued' ? ' · queued' : ''}${job.holderLabel ? ` · holder: ${job.holderLabel}` : ''}`,
      ...(stale ? ['Current custody: unknown'] : []),
      `${stale ? 'Last known generation' : 'Generation'}: ${job.generation ?? 'not acquired'} · ${stale ? 'last known' : 'current'} holder generation: ${job.lease?.generation ?? 'none'}`,
      `Store revision: ${job.storeRevision} · job revision: ${job.revision}`,
      `Dispatches: ${job.dispatches} · reconciled: ${job.reconciled}`,
      ...(job.answer && !stale ? [`Synthetic answer: ${job.answer}`] : []),
      'No run actions, real browser or provider action.',
    ].map(line);
  } else {
    const state = initialMonitorState();
    state.tree.selectedId = selectedId;
    state.preview = 'agent';
    details = inspectorRows({}, state, width, nowMs, view).map((r) => fit(stripAnsi(r.text), width));
  }
  const jobs = vm.tree.nodes
    .filter((n) => n.simulationJob)
    .map((n) => ({ key: n.key, parentKey: n.parentKey, ...n.simulationJob }));
  return {
    ledgerId: vm.tree.ledger.ledgerId,
    ledgerSeq: vm.tree.ledger.asOfSeq,
    selectedId,
    destinations: view.dest.rows.map((r) => r.key),
    agents,
    details,
    ordinary,
    selectedRunId: node?.identity.kind === 'job' ? null : (node?.currentRun?.runId ?? null),
    counts: vm.tree.counts,
    simulationJobs: status,
    jobCountKnown: !status || status.availability === 'available',
    relations: vm.tree.relations.map((r) => ({
      label: r.link.label,
      harness: r.currentRun?.harness ?? null,
      state: r.currentRun?.state ?? null,
      bound: r.link.childRef !== null,
      runId: r.currentRun?.runId ?? null,
    })),
    jobs,
  };
}
export function moveUnifiedSelection(frame, delta) {
  const rows = frame.destinations;
  if (!rows.length) return null;
  const at = Math.max(0, rows.indexOf(frame.selectedId));
  return rows[Math.max(0, Math.min(rows.length - 1, at + delta))];
}
