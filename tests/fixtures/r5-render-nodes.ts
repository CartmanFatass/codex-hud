/**
 * Synthetic facade-job nodes for the R5b-ui render tests: the exact `JobDisplay` DTO (`src/collectors/job-display-types.ts`)
 * and the tree node `composeJobTree` makes of it. No collector, disk, clock or model runs here; every id, path, label
 * and model name is made up.
 */
import type { JobDisplay } from '../../src/collectors/job-display-types.js';
import type { SubagentStatus, SubagentTree, SubagentTreeNode } from '../../src/types.js';

export const R5R_NOW = Date.parse('2026-11-09T12:00:00Z');
const ago = (seconds: number) => R5R_NOW - seconds * 1000;

export const ROOT = 'synthetic/main';

/** A running CLI role job over herdr, source current: the plainest job there is. */
export function jobDto(patch: Partial<JobDisplay> = {}): JobDisplay {
  return {
    kind: 'role',
    id: 'role-job:j0000000000000001',
    jobId: 'j0000000000000001',
    root: ROOT,
    name: 'Synthetic task',
    role: 'imp',
    phase: null,
    preset: 'daily',
    backend: {
      id: 'synthetic-cli',
      executor: 'herdr',
      harness: 'pi',
      model: 'gpt-6.1-sol',
      effort: 'high',
      env_profile: null,
      recipe: 'pi-role',
    },
    location: { tab_id: 'tab-1', pane_id: 'pane-1', agent: 'synthetic-agent', workspace_id: 'ws-1' },
    lifecycle: 'open',
    runtimePhase: null,
    dispatchSession: null,
    outcome: null,
    judgments: null,
    status: 'running',
    freshness: {
      state: 'current',
      observedAt: ago(2),
      lastSuccessfulReadAt: ago(2),
      evidenceAt: ago(60),
      liveDeadline: ago(-13),
      reason: null,
    },
    requests: null,
    report: { path: '/synthetic/hud/jobs/j0000000000000001/report.md', available: false },
    native: null,
    createdAt: ago(300),
    closedAt: null,
    decision: null,
    observedModel: null,
    observedEffort: null,
    helpers: [],
    diagnostics: [],
    coverage: 'complete',
    summaryUnavailable: 'native_ref_required',
    ...patch,
  };
}

/** A source that has stopped answering: last read a while ago, nothing corroborating it now. */
export const stale = (patch: Partial<JobDisplay['freshness']> = {}): JobDisplay['freshness'] => ({
  state: 'stale',
  observedAt: ago(2),
  lastSuccessfulReadAt: ago(240),
  evidenceAt: ago(300),
  liveDeadline: ago(200),
  reason: 'herdr_uncorroborated',
  ...patch,
});
/** No valid sample yet. */
export const unavailable = (patch: Partial<JobDisplay['freshness']> = {}): JobDisplay['freshness'] => ({
  state: 'unavailable',
  observedAt: ago(2),
  lastSuccessfulReadAt: null,
  evidenceAt: ago(300),
  liveDeadline: null,
  reason: 'receipt_missing',
  ...patch,
});

/**
 * The tree node for a job, as `composeJobTree` builds it (`display()`): the DTO as `job`, its name, role, model and
 * effort mirrored, helpers as children. `status` is the node's own and defaults to the DTO's, so a test can hand the
 * renderer a node whose status disagrees with its stale DTO and see that the row follows the DTO.
 */
export function jobNode(job: JobDisplay, extra: Partial<SubagentTreeNode> = {}, depth = 1): SubagentTreeNode {
  return {
    id: job.id,
    name: job.name,
    ...(job.role ? { role: job.role } : {}),
    status: job.status as SubagentStatus,
    depth,
    children: job.helpers.map((helper) => jobNode(helper, {}, depth + 1)),
    job,
    ...(job.backend?.model ? { model: job.backend.model } : {}),
    ...(job.backend?.effort ? { effort: job.backend.effort } : {}),
    ...(job.createdAt !== null ? { startedAt: new Date(job.createdAt) } : {}),
    ...extra,
  };
}

export function jobTree(nodes: SubagentTreeNode[]): SubagentTree {
  const count = (items: SubagentTreeNode[]): number => items.reduce((sum, n) => sum + 1 + count(n.children), 0);
  return { rootId: 'synthetic-root', nodes, totalCount: count(nodes), updatedAt: new Date(R5R_NOW) };
}

// The five kinds of job the panel has to show.

/** A CLI job (imp) over herdr. */
export const cliJob = (patch: Partial<JobDisplay> = {}) => jobDto({ name: 'Fix parser recovery', ...patch });

/** A pi job with two helpers, one running and one finished. */
export function piJob(patch: Partial<JobDisplay> = {}): JobDisplay {
  const helper = (n: number, patch: Partial<JobDisplay>): JobDisplay =>
    jobDto({
      kind: 'helper',
      id: `role-job:j0000000000000002:dispatch:review-${n}`,
      jobId: 'j0000000000000002',
      name: `Review pass ${n}`,
      role: 'reviewer',
      preset: null,
      backend: null,
      requests: null,
      report: null,
      ...patch,
    });
  return jobDto({
    id: 'role-job:j0000000000000002',
    jobId: 'j0000000000000002',
    name: 'Port the recovery path',
    helpers: [
      helper(1, {}),
      helper(2, {
        status: 'completed',
        lifecycle: 'closed',
        outcome: 'completed',
        closedAt: ago(500),
        freshness: { ...jobDto().freshness, evidenceAt: ago(520) },
      }),
    ],
    ...patch,
  });
}

/** An oracle job answered by the web oracle through Jev, in its propose phase. */
export const oracleJob = (patch: Partial<JobDisplay> = {}) =>
  jobDto({
    id: 'role-job:j0000000000000003',
    jobId: 'j0000000000000003',
    name: 'Compare the two designs',
    role: 'oracle',
    phase: 'propose',
    backend: {
      id: 'synthetic-web-oracle',
      executor: 'jev',
      harness: null,
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
      env_profile: null,
      recipe: null,
    },
    location: { tab_id: null, pane_id: null, agent: null, workspace_id: null },
    lifecycle: 'running',
    runtimePhase: 'wait',
    decision: { id: 'typesafe', model: 'decision-model' },
    report: null,
    ...patch,
  });

/** A direct Jev judge job whose statements have per-statement verdicts. */
export const judgeJob = (patch: Partial<JobDisplay> = {}) =>
  jobDto({
    id: 'role-job:j0000000000000004',
    jobId: 'j0000000000000004',
    name: 'Judge the claims',
    role: 'jev',
    backend: {
      id: 'synthetic-jev',
      executor: 'jev',
      harness: null,
      model: null,
      effort: null,
      env_profile: null,
      recipe: null,
    },
    location: { tab_id: null, pane_id: null, agent: null, workspace_id: null },
    lifecycle: 'completed',
    status: 'completed',
    judgments: [
      { name: 'claim one', verdict: 'pass' },
      { name: 'claim two', verdict: 'deny' },
    ],
    report: null,
    closedAt: ago(100),
    ...patch,
  });

/** A registered external herdr task: a label, a location, a status, and nothing the registration did not say. */
export const externalJob = (patch: Partial<JobDisplay> = {}) =>
  jobDto({
    kind: 'external',
    id: 'external-task:ext1',
    jobId: 'ext1',
    name: 'Manual herdr agent',
    role: null,
    phase: null,
    preset: null,
    backend: null,
    requests: null,
    report: null,
    createdAt: ago(900),
    diagnostics: ['locator_only_no_instance_discriminator'],
    ...patch,
  });

/** A request the job waits on now, or a historical pointer. */
export const request = (
  id: string,
  patch: Partial<NonNullable<JobDisplay['requests']>[number]> = {}
): NonNullable<JobDisplay['requests']>[number] => ({
  id,
  path: `/synthetic/hud/jobs/j0000000000000001/qa/${id}.md`,
  state: 'unanswered',
  current: true,
  respondable: true,
  observedAt: ago(5),
  ...patch,
});
