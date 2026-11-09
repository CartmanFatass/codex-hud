/**
 * How a facade job, a pi helper or a registered external herdr task reads in
 * the panel: the status its row draws, the words beside its name, and the
 * Inspector's job sections. Pure; the reduced DTO (`collectors/job-display-types.ts`)
 * is all it knows, and nothing here reads a report, a prompt or a clock.
 *
 * Every field maps to an existing slot or to the Inspector, never to a new
 * mark: the status glyph, the name, the role (and an oracle's phase), the
 * model badge, and the `!` the log already uses for "needs a look". A source
 * that is `stale` or `unavailable` is never drawn as running; `unknown` is
 * never drawn as done or failed. Text from outside the HUD (names, paths,
 * outcomes, diagnostics, verdict names) passes `monitorText` once.
 */
import type { SubagentStatus, SubagentTreeNode } from '../types.js';
import type { JobDisplay, JobRequest } from '../collectors/job-display-types.js';
import { theme, colors, visualLength } from './colors.js';
import { t } from './i18n.js';
import { monitorText, flowLines, pathRows } from './monitor-text.js';
import { age } from './monitor-labels.js';

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/** Whether a settled outcome is on record: only these survive a source that has gone stale. */
function terminal(job: JobDisplay): boolean {
  return job.status === 'completed' || job.status === 'error';
}

/**
 * The status a job is drawn with. A source that is not corroborated right
 * now keeps a recorded outcome (history) but is never running or starting.
 */
export function jobStatus(job: JobDisplay): SubagentStatus {
  return job.freshness.state === 'current' || terminal(job) ? job.status : 'unknown';
}

/** The status every row, count and filter reads: a job's own, else the node's, which is unchanged. */
export function effectiveStatus(node: SubagentTreeNode): SubagentStatus {
  return node.job ? jobStatus(node.job) : node.status;
}

/**
 * The nodes as their rows read them, for the counts: a job's status is its
 * effective one. Returned as given when no node carries a job, so a tree of
 * native agents is counted exactly as before.
 */
export function withEffectiveStatus(nodes: readonly SubagentTreeNode[]): readonly SubagentTreeNode[] {
  const carries = (items: readonly SubagentTreeNode[]): boolean => items.some((n) => !!n.job || carries(n.children));
  if (!carries(nodes)) return nodes;
  const map = (n: SubagentTreeNode): SubagentTreeNode => ({
    ...n,
    status: effectiveStatus(n),
    children: n.children.map(map),
  });
  return nodes.map(map);
}

/** The job's source is not corroborated right now: stale, or no valid sample yet. */
export function jobUncertain(node: SubagentTreeNode): boolean {
  return !!node.job && node.job.freshness.state !== 'current';
}

/**
 * A row only the facade knows: no native session behind it, so nothing in the
 * panel can switch to it and no native summaries describe it.
 */
export function facadeOnly(node: SubagentTreeNode): boolean {
  return !!node.job && !node.ref && !node.rolloutPath;
}

/** The job has been closed: its tab or runtime job is done with, whatever it last said. */
export function jobClosed(job: JobDisplay): boolean {
  return job.lifecycle === 'closed' || job.closedAt !== null;
}

/** A request the job is waiting on now. Historical pointers and answered ones do not count. */
export function needsInput(node: SubagentTreeNode): boolean {
  return !!node.job?.requests?.some((request) => request.current);
}

/** Worth a line on its parent's card whatever the child scope: failed, waiting on the person, or not known to be settled. */
export function jobFlagged(node: SubagentTreeNode): boolean {
  return !!node.job && (node.job.status === 'error' || needsInput(node) || (jobUncertain(node) && !terminal(node.job)));
}

/** When a job's status was settled or last evidenced: the DTO's event time, never the read time. */
export function jobSettledAt(node: SubagentTreeNode): Date | undefined {
  const job = node.job;
  if (!job) return undefined;
  const at = [job.freshness.evidenceAt, job.closedAt, job.freshness.lastSuccessfulReadAt].find(finite);
  return at === undefined ? undefined : new Date(at);
}

/** When the job's source was last read successfully, for an uncertain job's "last seen". */
export function jobSeenAt(node: SubagentTreeNode): Date | undefined {
  const at = node.job?.freshness.lastSuccessfulReadAt;
  return finite(at) ? new Date(at) : undefined;
}

/**
 * The node as the panel names it. A job's name is its task label and wins over
 * every native name: on a row the facade enriched, neither Codex's name nor a
 * model-written label may head it, with labels-as-names on or off. The native
 * name and label stay on the node for the Inspector, which lists them as facts.
 * Raw text: the callers' title and `monitorText` paths sanitise it.
 */
export function shownNode(node: SubagentTreeNode): SubagentTreeNode {
  const job = node.job;
  if (!job?.name) return node;
  if (job.name === node.name && !node.label) return node;
  const { label: _label, ...rest } = node;
  return { ...rest, name: job.name };
}

/**
 * The model and effort a row's badge shows. A job's is its backend binding and
 * nothing else: a field the binding leaves out stays out, and what the session
 * was observed to run is the Inspector's. Any other node shows what it carries.
 */
export function badgeOf(node: SubagentTreeNode): { model?: string; effort?: string } {
  const source = node.job ? node.job.backend : node;
  const model = source?.model;
  const effort = source?.effort;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/** `stale` or `unavailable`, in the reader's words; empty while the source is current. */
export function freshnessWord(job: JobDisplay): string {
  return job.freshness.state === 'stale' ? t('stale') : job.freshness.state === 'unavailable' ? t('unavailable') : '';
}

/** The role a row names, and its short form without the phase: "oracle·propose", "oracle". External: "herdr". */
export function roleVariants(job: JobDisplay): string[] {
  if (job.kind === 'external') return [t('herdr')];
  const role = job.role ? monitorText(job.role) : '';
  const phase = job.phase ? monitorText(job.phase) : '';
  if (role && phase) return [`${role}·${phase}`, role];
  return role || phase ? [role || phase] : [];
}

/** One optional word beside a row's name, in as many forms as it has, widest first. */
export interface RowPart {
  variants: string[];
  /** Lower is kept longer when space runs out. */
  rank: number;
  /** Left to right among the parts that stay. */
  slot: number;
}

/** Shedding order, highest priority first: role and phase, freshness, model and effort, attention. */
const RANK = { role: 1, fresh: 2, badge: 3, attention: 4 } as const;

/**
 * The words beside a job's name, each with the forms it can take. `badge` is
 * the model badge already fitted to the row. Painting stays here: attention
 * and a stale source in the warning colour, the role dim.
 */
export function jobParts(node: SubagentTreeNode, badge = ''): RowPart[] {
  const job = node.job;
  if (!job) return [];
  const parts: RowPart[] = [];
  if (needsInput(node)) parts.push({ variants: [theme.warning('!')], rank: RANK.attention, slot: 0 });
  const word = freshnessWord(job);
  if (word) parts.push({ variants: [theme.warning(word)], rank: RANK.fresh, slot: 1 });
  const role = roleVariants(job);
  if (role.length) parts.push({ variants: role.map((form) => colors.dim(form)), rank: RANK.role, slot: 2 });
  if (badge) parts.push({ variants: [badge], rank: RANK.badge, slot: 3 });
  return parts;
}

/**
 * The parts that fit `room` columns (one space between them), chosen by rank:
 * a part takes its widest form that fits what is left and is left out when
 * none does. Returned left to right.
 */
export function fitParts(parts: readonly RowPart[], room: number): string[] {
  const chosen: Array<{ slot: number; text: string }> = [];
  let used = 0;
  for (const part of [...parts].sort((a, b) => a.rank - b.rank)) {
    const gap = chosen.length ? 1 : 0;
    const form = part.variants.find((text) => text && used + gap + visualLength(text) <= room);
    if (form === undefined) continue;
    chosen.push({ slot: part.slot, text: form });
    used += gap + visualLength(form);
  }
  return chosen.sort((a, b) => a.slot - b.slot).map((part) => part.text);
}

/** The ids of the requests the job waits on now, as the "Needs" line says them. */
export function waitingIds(node: SubagentTreeNode): string {
  return (node.job?.requests ?? [])
    .filter((request) => request.current)
    .map((request) => monitorText(request.id))
    .join(' ');
}

// ---------------------------------------------------------------------------
// The Inspector
// ---------------------------------------------------------------------------

export interface JobSection {
  title: string;
  /** Plain lines, each at most the width asked for. */
  lines: string[];
}

const REQUEST_STATES: Record<JobRequest['state'], string> = {
  unanswered: 'unanswered',
  written_consumption_unconfirmed: 'answer written, consumption unconfirmed',
};
const VERDICTS: Record<NonNullable<JobDisplay['judgments']>[number]['verdict'], string> = {
  pass: 'pass',
  deny: 'deny',
  unsettled: 'unsettled',
  timeout: 'timeout',
  needs_human: 'needs human',
};
const SUMMARY_REASONS: Record<JobDisplay['summaryUnavailable'], string> = {
  native_ref_required: 'needs a native session ref',
  requires_authorization: 'requires authorization',
};
/** Diagnostics shown; the DTO bounds them, this keeps the page short. */
const DIAGNOSTICS_SHOWN = 8;

/** "12s ago" in words, from a DTO timestamp; nothing for one that is not a time. */
function ago(at: number | null | undefined, now: number): string {
  return finite(at) ? t('{age} ago', { age: age(new Date(at), now) }) : '';
}

/** The job's sections for the Inspector, empty fields left out. Every line fits `width`. */
export function jobSections(node: SubagentTreeNode, width: number, now: number): JobSection[] {
  const job = node.job;
  if (!job || width < 1) return [];
  const fit = (text: string, indent = 0): string[] =>
    flowLines(text, Math.max(1, width - indent)).map((line) => ' '.repeat(indent) + line);
  const field = (label: string, value: string | null | undefined, indent = 0): string[] =>
    value ? fit(t('{label}: {value}', { label: t(label), value: monitorText(value) }), indent) : [];
  const where = (...pairs: Array<[string, string | null]>): string =>
    pairs
      .filter((pair): pair is [string, string] => !!pair[1])
      .map(([key, id]) => t(key, { id: monitorText(id) }))
      .join(' · ');
  const sections: JobSection[] = [];
  const add = (title: string, lines: string[]) => {
    if (lines.length) sections.push({ title: t(title), lines });
  };

  const binding = job.backend;
  const modelEffort = (model: string | null | undefined, effort: string | null | undefined) =>
    [model, effort].filter(Boolean).join(' · ');
  // What the session was seen to run: the facade's reading, else the native row's own; only where it is not the binding.
  const seenModel = job.observedModel ?? node.model;
  const seenEffort = job.observedEffort ?? node.effort;
  const observed = modelEffort(
    seenModel && seenModel !== binding?.model ? seenModel : null,
    seenEffort && seenEffort !== binding?.effort ? seenEffort : null
  );
  const decision = job.decision ? [job.decision.id, job.decision.model].filter(Boolean).join(' · ') : '';
  const place = where(
    ['tab {id}', job.location.tab_id],
    ['pane {id}', job.location.pane_id],
    ['agent {id}', job.location.agent],
    ['workspace {id}', job.location.workspace_id]
  );
  add('Job', [
    ...field('Kind', t(job.kind === 'external' ? 'external task' : job.kind === 'helper' ? 'helper' : 'role job')),
    ...field('Id', job.jobId),
    ...field('Role', job.role),
    ...field('Phase', job.phase),
    ...field('Preset', job.preset),
    ...field('Backend', binding?.id),
    ...field('Executor', binding?.executor),
    ...field('Harness', binding?.harness),
    ...field('Model', modelEffort(binding?.model, binding?.effort)),
    ...field('Recipe', binding?.recipe),
    ...field('Decision', decision),
    ...field('Observed', observed),
    ...field('Location', place),
    ...field('Lifecycle', job.lifecycle),
    ...field('Runtime phase', job.runtimePhase),
    ...field('Outcome', job.outcome),
    ...field('Created', ago(job.createdAt, now)),
    ...field('Closed', ago(job.closedAt, now)),
  ]);

  // Verdicts are per statement; nothing here adds them up.
  add(
    'Judge verdicts',
    (job.judgments ?? []).flatMap((judgment) =>
      fit(
        t('{label}: {value}', {
          label: monitorText(judgment.name),
          value: t(VERDICTS[judgment.verdict] ?? 'unsettled'),
        }),
        2
      )
    )
  );

  // Current ones first; a historical pointer is not proof the job waits.
  const requests = [...(job.requests ?? [])].sort((a, b) => Number(b.current) - Number(a.current));
  add(
    'Requests',
    requests.flatMap((request) => [
      ...fit(
        [
          monitorText(request.id),
          t(REQUEST_STATES[request.state] ?? 'unanswered'),
          t(request.current ? 'current' : 'historical'),
        ].join(' · ')
      ),
      ...pathRows(request.path, Math.max(1, width - 2)).map((line) => `  ${line}`),
    ])
  );

  add('Report', [
    ...(job.report ? pathRows(job.report.path, width) : []),
    ...(job.report
      ? field(
          'Availability',
          t(job.report.available === true ? 'available' : job.report.available === false ? 'not written' : 'unreadable')
        )
      : []),
  ]);

  const fresh = job.freshness;
  const live = finite(fresh.liveDeadline)
    ? fresh.liveDeadline > now
      ? t('ends in {age}', { age: age(new Date(now - (fresh.liveDeadline - now)), now) })
      : t('ended {age} ago', { age: age(new Date(fresh.liveDeadline), now) })
    : '';
  add('Freshness', [
    ...field('State', t(fresh.state)),
    ...field('Reason', fresh.reason),
    // The recorded status of a source that stopped answering, kept apart from what is drawn.
    ...(fresh.state !== 'current' && !terminal(job) && (job.status === 'running' || job.status === 'starting')
      ? field('Last known', t(job.status))
      : []),
    ...field('Checked', ago(fresh.observedAt, now)),
    ...field('Last read', ago(fresh.lastSuccessfulReadAt, now)),
    ...field('Evidence', ago(fresh.evidenceAt, now)),
    ...field('Live window', live),
  ]);

  add(
    'Helpers',
    job.helpers.flatMap((helper) =>
      fit(
        [
          monitorText(helper.name),
          helper.role ? monitorText(helper.role) : '',
          t(jobStatus(helper)),
          freshnessWord(helper),
        ]
          .filter(Boolean)
          .join(' · '),
        2
      )
    )
  );

  const shown = job.diagnostics.slice(0, DIAGNOSTICS_SHOWN);
  add('Diagnostics', [
    ...shown.flatMap((diagnostic) => fit(monitorText(diagnostic), 2)),
    ...(job.diagnostics.length > shown.length
      ? fit(t('+{n} more', { n: job.diagnostics.length - shown.length }), 2)
      : []),
  ]);

  // A facade-only row has no native session to summarise; a native row it enriched keeps its own summaries.
  if (facadeOnly(node))
    add('Model summary', fit(`${t('Model summaries unavailable')} · ${t(SUMMARY_REASONS[job.summaryUnavailable])}`));
  return sections;
}
