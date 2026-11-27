/** Lead acceptance/question packets, report parsing, and normal HUD closure for workflow runs. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { readFileBounded } from '../utils/atomic-fs.js';
import type { Step } from '../workflows/graph.js';
import type { Job } from './job-contracts.js';
import { answerWorkerQuestion, closeJob } from './mcp/operations.js';
import type { AnswerResult } from '../collectors/panel-actions.js';
import { storedTicket } from '../tickets/store.js';
import { parseRemovalList, ticketApprovedRemovals } from './local-tickets.js';
import { jobFiles } from './paths.js';
import { landReportJob, readLand } from './land-state.js';
import { directory, findJob, hudHome, readCachedStatus, save } from './store/job-store.js';
import { recordDecision, type RunTodoItem, type TicketQueue, type TicketQueueItem } from './ticket-queue-state.js';
import type { OwnerApproval } from '../unattended/state.js';
import { declaresNone, extractAssumedLines, extractReportNotes } from './report-notes.js';

export { extractAssumedLines, extractReportNotes, recordDecision };

const approvalFormat = 'For escalate, include `Owner approval: feature-deletion` or `Owner approval: spec-change` and explain the specific change in Reason. Do not use escalate for operational failures.';

export const DEFAULT_ESCALATION_RULE =
  'Escalate to main only for owner matters that block: scope change, value trade-off, visible deletion, or irreversible act.';

const workerRuleStart = 'Workflow run rule: proceed on the ticket, docs/spec.md and your own default; write each assumption on its own `Assumed:` line (mark scope assumptions with `scope`);';
const workerRuleReport = 'Use `Blockers:` only for an owner decision needed before this can land (scope, value trade-off, visible deletion, irreversible act); otherwise write `Blockers: none`. A pending live try or owner try is never a blocker: put it on a `Try:` line or elsewhere in the report. Include a `Removes:` line (`Removes: none`, a comma-separated list of user-visible features removed, or `Removes: ambiguous: <detail>` if unsure).';

export const WORKFLOW_WORKER_RULE = `${workerRuleStart} ask with \`hud_ask\` only when no reasonable default is safe. ${workerRuleReport}`;
export const WORKFLOW_WORKER_RULE_NO_ASK = `${workerRuleStart} do not call \`hud_ask\`. ${workerRuleReport}`;
export const workflowTask = (task: string, ask: boolean) => `${task}\n\n${ask ? WORKFLOW_WORKER_RULE : WORKFLOW_WORKER_RULE_NO_ASK}`;

export const MAX_ANSWER_RETRIES = 3;
const MAX_RUN_TODOS = 200;

export type RemovalsDeclaration =
  | { kind: 'missing' }
  | { kind: 'none' }
  | { kind: 'ambiguous'; detail: string }
  | { kind: 'named'; items: string[]; raw: string };

export function extractRemovalsDeclaration(reportText: string): RemovalsDeclaration {
  const values: string[] = [];
  for (const match of reportText.matchAll(/^[ \t]*(?:[-*] |#{1,6} )?(?:\*\*)?Removes:(?:\*\*)?[ \t]*(.*?)[ \t]*$/gim)) {
    const val = match[1].trim();
    if (val) values.push(val);
  }
  if (!values.length) return { kind: 'missing' };
  const ambiguous = values.find(v => /^(?:ambiguous|unclear|unsure)\b/i.test(v) || /\bambiguous\b/i.test(v));
  if (ambiguous) return { kind: 'ambiguous', detail: ambiguous };
  const nonNone = values.filter(v => !declaresNone(v));
  if (!nonNone.length) return { kind: 'none' };
  const raw = nonNone.join(', ');
  const items = parseRemovalList(raw);
  return items.length ? { kind: 'named', items, raw } : { kind: 'missing' };
}

export function extractTodoLines(reportText: string): string[] {
  const lines: string[] = [];
  for (const match of reportText.matchAll(/^[ \t]*(?:[-*] |#{1,6} )?(?:\*\*)?Todo:(?:\*\*)?[ \t]*(.+?)[ \t]*$/gim)) {
    const text = match[1].trim();
    if (text) lines.push(text);
  }
  return lines;
}

export interface ParsedLeadReport {
  decision?: string;
  reason?: string;
  answer?: string;
  ownerApproval?: OwnerApproval;
  todos: string[];
}

export function parseLeadReport(reportText: string, allowedChoices: readonly string[]): ParsedLeadReport {
  const allowed = new Set(allowedChoices.map(c => c.toLowerCase()));
  const decMatch = /^[ \t]*(?:[-*] |#{1,6} )?(?:\*\*)?Decision:(?:\*\*)?[ \t]*([a-z][a-z0-9_-]*)/im.exec(reportText);
  const rawDecision = decMatch?.[1]?.toLowerCase();
  const decision = rawDecision && allowed.has(rawDecision) ? rawDecision : undefined;
  const reasonMatch = /^[ \t]*(?:[-*] |#{1,6} )?(?:\*\*)?Reason:(?:\*\*)?[ \t]*(.+?)[ \t]*$/im.exec(reportText);
  const reason = reasonMatch?.[1]?.trim();

  let answer: string | undefined;
  const answerMatch = /^[ \t]*(?:[-*] |#{1,6} )?(?:\*\*)?Answer:(?:\*\*)?[ \t]*(.*)$/im.exec(reportText);
  if (answerMatch) {
    const rest = reportText.slice(answerMatch.index + answerMatch[0].length);
    const tailLines: string[] = [];
    for (const line of rest.split(/\r?\n/)) {
      if (/^[ \t]*(?:[-*] |#{1,6} )?(?:\*\*)?(?:Decision|Reason|Todo):/i.test(line) || /^#{1,6}\s/.test(line)) break;
      tailLines.push(line);
    }
    const combined = [answerMatch[1].trim(), ...tailLines].join('\n').trim();
    if (combined) answer = combined;
  }

  const approval = /^[ \t]*(?:[-*] )?(?:\*\*)?Owner approval:(?:\*\*)?[ \t]*(feature-deletion|spec-change)[ \t]*\r?$/im.exec(reportText)?.[1];
  const ownerApproval = (decision === 'escalate' || decision === 'hold') && reason
    ? approval?.toLowerCase() as OwnerApproval | undefined : undefined;
  return { decision, reason, answer, ...(ownerApproval && { ownerApproval }), todos: extractTodoLines(reportText) };
}

const negatedPolicyTerm = /\b(?:no|not|without)\s+(?:a\s+|an\s+|any\s+|user-visible\s+|visible\s+|feature\s+|unapproved\s+)*(?:delet(?:e[ds]?|ing|ion)|remov(?:e[ds]?|ing|al)|spec(?:ification)?(?:\s+change)?|docs\/spec\.md)\b/gi;

/** Only a visible deletion or spec-change verdict becomes an owner hold for an assumption. */
export function assumptionOwnerApproval(parsed: ParsedLeadReport): OwnerApproval | undefined {
  if (parsed.ownerApproval) return parsed.ownerApproval;
  if (!parsed.reason) return undefined;
  const text = parsed.reason.replace(negatedPolicyTerm, ' ');
  if (/\b(?:docs\/spec\.md|spec(?:ification)?)\b/i.test(text)) return 'spec-change';
  if (/\b(?:delet(?:e[ds]?|ing|ion)|remov(?:e[ds]?|ing|al))\b/i.test(text)) return 'feature-deletion';
  return undefined;
}

export function appendTodos(q: TicketQueue, items: readonly RunTodoItem[]): boolean {
  if (!items.length) return false;
  const existing = q.todo ?? [];
  const seen = new Set(existing.map(t => `${t.source}\0${t.text}`));
  let added = false;
  for (const item of items) {
    if (existing.length >= MAX_RUN_TODOS) break;
    const key = `${item.source}\0${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    existing.push(item);
    added = true;
  }
  if (added) q.todo = existing;
  return added;
}

function ticketSummaryLines(q: TicketQueue, item: Pick<TicketQueue['tickets'][number], 'ticket' | 'path'>): { goal?: string; liveTry?: string } {
  try {
    const stored = storedTicket(q.root, item.ticket);
    if (stored) return stored.record ? { goal: stored.record.what.split('\n', 1)[0], liveTry: stored.record.live_try } : {};
    const { path } = item;
    const body = readFileBounded(path, 64 * 1024).bytes.toString('utf8').split(/^## Comments[ \t]*\r?$/m, 1)[0];
    const goal = body.match(/^(?:\*\*What to build:\*\*|## What to build\b)[ \t]*(?:\r?\n[ \t]*)*([^\r\n]*)/mi)?.[1]?.trim();
    const liveTry = body.match(/(?:^|·)[ \t]*(?:\*\*)?(?:Live try|How to try|Try)(?::\*\*|\*\*:|:)[ \t]*([^\r\n·]+)/im)?.[1]?.trim();
    return { ...(goal && { goal }), ...(liveTry && { liveTry }) };
  } catch {
    return {};
  }
}

function landedEvidence(item: TicketQueueItem) {
  let job = item.job;
  if (item.land) {
    const land = readLand(hudHome, item.land);
    // Don't cite the original as landed evidence when the actual receipt isn't available.
    job = land?.state === 'completed' && land.job === item.job ? landReportJob(land) : undefined;
  }
  if (!job) return {};
  const dir = directory(job);
  const checks = join(dir, jobFiles.checks);
  return { job, report: join(dir, jobFiles.report), checks: fs.existsSync(checks) ? checks : undefined };
}

export function buildReviewBrief(q: TicketQueue, stepTask: string) {
  const landed = q.tickets.filter(t => t.landed);
  const crossRepo = landed.some(item => item.repo && item.repo !== q.root);
  const local = landed.some(item => !item.repo || item.repo === q.root);
  const fromJobs: string[] = [];
  const lines = [
    stepTask,
    '',
    `Feature: ${q.feature} (run ${q.flow}, round ${(q.repair_rounds ?? 0) + 1})`,
    ...(q.start_head && local ? [`${crossRepo ? 'Tracker diff range' : 'Diff range'}: ${q.start_head}..HEAD (inspect with \`git diff --stat ${q.start_head}..HEAD\`)`] : []),
    '',
    'Landed tickets and design intent:',
    ...landed.map(item => {
      const info = ticketSummaryLines(q, item);
      const { job, report, checks } = landedEvidence(item);
      if (job && report && fs.existsSync(report)) fromJobs.push(job);
      const target = item.repo && item.repo !== q.root ? ` | target repo: ${item.repo} | land: ${item.land ?? 'none'}` : '';
      return `- ${item.ticket}: ${info.goal ?? item.path}${target} | report: ${report ?? 'no report'}${checks ? ` | checks: ${checks}` : ''}`;
    }),
  ];
  return { task: lines.join('\n') + '\n', fromJobs: fromJobs.slice(-16) };
}

export function buildAcceptPacket(q: TicketQueue, step: Extract<Step, { kind: 'handback' }>): string {
  const round = q.repair_rounds ?? 0;
  const escalationRule = step.escalation_rule ?? q.escalation_rule ?? DEFAULT_ESCALATION_RULE;
  const landed = q.tickets.filter(t => t.landed);
  const held = q.tickets.filter(t => t.held);
  const failed = q.tickets.filter(t => t.failed);
  const latestReview = q.reviews?.at(-1);
  const earlierReviews = q.reviews?.filter(review => review.round < round) ?? [];
  const choices = step.options;

  const lines: string[] = [
    `# Workflow Acceptance Packet (${q.flow})`,
    '',
    q.unattended ? `Objective: ${q.unattended.objective}` : `Feature: ${q.feature}`,
    `Question: ${step.ask}`,
    `Declared choices: ${choices.join(', ')}`,
    `Current repair round: ${round} (0 = initial acceptance)`,
    `Owner escalation rule: ${escalationRule}`,
    'Also escalate to main when the review repeats a kind of finding an earlier round already repaired.',
    '',
    '## Tickets, Live Try & Reports',
    ...(landed.length ? landed.map(item => {
      const info = ticketSummaryLines(q, item);
      const { report, checks } = landedEvidence(item);
      return `- ${item.ticket}: ${info.goal ?? item.path}` +
        (info.liveTry ? ` | Live try: ${info.liveTry}` : '') +
        (item.repo && item.repo !== q.root ? ` | target repo: ${item.repo} | land: ${item.land ?? 'none'}` : '') +
        ` | ticket: ${item.path} | report: ${report ?? 'none'}${checks ? ` | checks: ${checks}` : ''}`;
    }) : ['- (none landed)']),
  ];

  if (failed.length) {
    lines.push('', '## Failed Tickets', ...failed.map(item =>
      `- ${item.ticket}${item.job ? ` (${item.job})` : ''}: ${item.failed!.reason} | ticket: ${item.path}`));
  }
  if (held.length) {
    lines.push('', '## Held Tickets (waiting for owner)', ...held.map(item =>
      `- ${item.ticket}${item.job ? ` (${item.job})` : ''}: ${item.held!.reason} | ticket: ${item.path}`));
  }
  if (q.blocked?.length) {
    lines.push('', '## Blocked Dependents', ...q.blocked.map(b => `- ${b.ticket}: blocked by ${b.blockers.join(', ')}`));
  }
  if (latestReview) {
    const revReport = join(directory(latestReview.job), jobFiles.report);
    const findings = latestReview.findings
      ? ` (findings: blocker=${latestReview.findings.blocker}, major=${latestReview.findings.major}, minor=${latestReview.findings.minor})`
      : '';
    lines.push('', '## Milestone Reviewer Report', `- ${latestReview.job}${findings}: ${revReport}`);
  }
  if (earlierReviews.length) {
    lines.push('', '## Earlier Reviews and Resulting Repairs');
    for (const review of earlierReviews) {
      const repairs = q.tickets.filter(t => t.round === review.round + 1).map(t => t.ticket);
      const counts = review.findings;
      const findings = counts ? `blocker=${counts.blocker}, major=${counts.major}, minor=${counts.minor}` : 'not reported';
      lines.push(
        `- Round ${review.round} review: ${review.summary ?? '(no summary)'} | findings: ${findings} | report: ${join(directory(review.job), jobFiles.report)}`,
        `  Repair tickets admitted in round ${review.round + 1}: ${repairs.join(', ') || 'none'}`,
      );
    }
  }
  if (q.decisions?.length) {
    lines.push('', '## Prior Decisions', ...q.decisions.slice(-10).map(d => `- [${d.step}/${d.kind}] ${d.decision}${d.reason ? `: ${d.reason}` : ''} (${d.job})`));
  }
  if (q.todo?.length) {
    lines.push('', '## Current Run Todo', ...q.todo.slice(-20).map(t => `- [${t.kind} ${t.source}] ${t.text}`));
  }
  lines.push(
    '',
    '## Required Report Format',
    `Respond via hud_report with \`Decision: <${choices.join('|')}>\`, \`Reason: <one line>\`, and optional \`Todo: <item>\` lines for non-blocking doubts/follow-ups.`,
    'If choosing `repair`, you must add the repair ticket(s) via `hud_tickets` with `repairs` set to the `<feature>/<NN>` slice(s) they fix (and `live_try`) before declaring `Decision: repair` so this run admits and lands them before re-reviewing.',
    'Do not edit docs/spec.md or land outside this run.',
    ...(q.unattended ? [
      `For unattended repair, add ready repair ticket(s) linked to Objective \`${q.unattended.objective}\` with \`repairs\` set to the \`<feature>/<NN>\` slice(s) they fix (and \`live_try\`) so this run admits them directly. Never create an Objective or edit docs/spec.md.`,
      'For an escalation requiring owner approval, include `Owner approval: feature-deletion` or `Owner approval: spec-change` and explain the specific change in Reason.',
    ] : []),
  );
  return lines.join('\n') + '\n';
}

export function buildQuestionPacket(
  q: TicketQueue,
  opts: { step?: string; ticket?: string; ticketPath?: string; workerJob: string; question: string; questionPath: string },
): string {
  const escalationRule = q.escalation_rule ?? DEFAULT_ESCALATION_RULE;
  const info = opts.ticket && opts.ticketPath ? ticketSummaryLines(q, { ticket: opts.ticket, path: opts.ticketPath }) : {};
  let questionBody = '';
  try {
    questionBody = readFileBounded(opts.questionPath, 16 * 1024).bytes.toString('utf8').trim();
  } catch { /* Missing or unreadable question file; path is still included. */ }

  const subject = opts.ticket
    ? `${q.unattended ? `Objective: ${q.unattended.objective}` : `Feature: ${q.feature}`} | Ticket: ${opts.ticket} | Worker: ${opts.workerJob} | Request: ${opts.question}`
    : `${q.unattended ? `Objective: ${q.unattended.objective}` : `Feature: ${q.feature}`} | Step: ${opts.step ?? 'review'} | Worker: ${opts.workerJob} | Request: ${opts.question}`;
  const lines: string[] = [
    `# Worker Question Packet (${q.flow})`,
    '',
    subject,
    ...(info.goal ? [`Ticket goal: ${info.goal}`] : []),
    ...(opts.ticketPath ? [`Ticket file: ${opts.ticketPath}`] : []),
    `Question file: ${opts.questionPath}`,
    'Declared choices: answer, escalate',
    `Escalation rule: ${escalationRule}`,
    '',
    '## Worker Question',
    questionBody || `(Read ${opts.questionPath})`,
  ];
  if (!opts.ticket) {
    const landed = q.tickets.filter(t => t.landed);
    if (landed.length) {
      lines.push('', '## Landed Tickets', ...landed.map(t => `- ${t.ticket}: ${t.path}`));
    }
  }
  if (q.decisions?.length) {
    lines.push('', '## Prior Decisions', ...q.decisions.slice(-10).map(d => `- [${d.step}/${d.kind}] ${d.decision}${d.reason ? `: ${d.reason}` : ''}`));
  }
  if (q.todo?.length) {
    lines.push('', '## Current Run Todo', ...q.todo.slice(-10).map(t => `- [${t.kind} ${t.source}] ${t.text}`));
  }
  lines.push(
    '',
    '## Required Report Format',
    'Respond via hud_report with either:',
    '- `Decision: answer`, `Reason: <one line>`, and `Answer: <answer for the worker>` (plus optional `Todo:` lines), OR',
    '- `Decision: escalate` and `Reason: <why this blocks on the owner per the escalation rule>`.',
    ...(q.unattended ? [approvalFormat, 'Never create an Objective or edit docs/spec.md.'] : []),
  );
  return lines.join('\n') + '\n';
}

export function buildRemovalAmbiguityPacket(
  q: TicketQueue,
  item: TicketQueue['tickets'][number],
  job: Job,
  head: string,
  detail: string,
): string {
  const info = ticketSummaryLines(q, item);
  const approved = ticketApprovedRemovals(item.path, q.root, item.ticket);
  return [
    `# Unattended Removal Ambiguity Check (${q.flow})`,
    `Ticket: ${item.ticket} | Objective: ${q.unattended!.objective}`,
    `Ticket file: ${item.path}`,
    ...(info.goal ? [`Ticket goal: ${info.goal.slice(0, 4000)}`] : []),
    `Approved removals in ticket: ${approved.length ? approved.join(', ') : 'none'}`,
    `Worker declared Removes: ${detail}`,
    `Worker report: ${join(directory(job.job), jobFiles.report)}`,
    `Inspect the committed changes at ${head} in the worker checkout: ${job.cwd}`,
    `Escalation rule: ${q.escalation_rule}`,
    'Inspect the ticket, report and committed changes to resolve the declared removal ambiguity. Do not edit the worktree or docs/spec.md.',
    'Use hud_report: `Decision: finish` to authorize this exact commit if no unapproved user-visible feature is removed, `Decision: repair` if it needs further work, or `Decision: escalate` if owner approval is required. Include a one-line `Reason:`.',
    approvalFormat,
  ].join('\n') + '\n';
}

export function buildAssumptionPacket(
  q: TicketQueue,
  item: TicketQueue['tickets'][number],
  job: Job,
  head: string,
  opts: { trigger: string; assumed: readonly string[]; blockers: readonly string[] },
): string {
  const info = ticketSummaryLines(q, item);
  return [
    `# Assumption Check (${q.flow})`,
    `Ticket: ${item.ticket} | ${q.unattended ? `Objective: ${q.unattended.objective}` : `Feature: ${q.feature}`}`,
    `Ticket file: ${item.path}`,
    ...(info.goal ? [`Ticket goal: ${info.goal.slice(0, 4000)}`] : []),
    `Trigger: ${opts.trigger}`,
    'Worker Assumed: lines:',
    ...opts.assumed.map(line => `- ${line}`),
    ...(opts.blockers.length ? ['Worker Blockers: lines:', ...opts.blockers.map(line => `- ${line}`)] : []),
    `Worker report: ${join(directory(job.job), jobFiles.report)}`,
    `Inspect the committed changes at ${head} in the worker checkout: ${job.cwd}`,
    `Escalation rule: ${q.escalation_rule ?? DEFAULT_ESCALATION_RULE}`,
    `Inspect the ticket, report and committed changes to judge the worker ${opts.blockers.length ? 'blockers and assumptions' : 'assumptions'} under the escalation rule. Do not edit the worktree or docs/spec.md.`,
    'Use hud_report with one decision and a one-line `Reason:`:',
    '- `Decision: continue` if no owner decision or repair is needed before landing (a pending live try or owner try is never a blocker);',
    opts.blockers.length
      ? '- `Decision: escalate` only if an owner decision is needed before landing; name the matter in `Reason:`. For visible deletion or spec change, include `Owner approval: feature-deletion` or `Owner approval: spec-change` respectively;'
      : '- `Decision: hold` with `Reason:` naming the visible deletion or docs/spec.md change and `Owner approval: feature-deletion` or `Owner approval: spec-change` ONLY if owner approval is required for a visible deletion or spec change;',
    '- `Decision: repair` if the commit needs further work within the current spec (not an owner hold).',
  ].join('\n') + '\n';
}

export interface CloseLeadResult {
  ok: boolean;
  reason?: string;
}

/** Close a lead session through normal HUD closure (herdr, exact identity); adds no new kill sites. */
export async function closeLeadJob(job: Job): Promise<CloseLeadResult> {
  const latest = findJob(job.job) ?? job;
  if (latest.reaped_at) return { ok: true };
  // A known failed tab dispatch with no session receipt has nothing for hud-reap to close.
  // An ambiguous launch is not proof that no tab was created.
  if (!latest.headless && latest.dispatch_exit_code && !latest.launch_unknown &&
      !fs.existsSync(join(directory(latest.job), jobFiles.session))) {
    const { status } = readCachedStatus(latest.job);
    if (status?.state === 'failed' && !status.pid && !status.launch_unknown) return { ok: true };
  }
  const result = await closeJob(latest);
  if (result.exit_code === 0) {
    const after = findJob(job.job);
    if (after && !after.reaped_at) save({ ...after, reaped_at: new Date().toISOString() });
    return { ok: true };
  }
  return { ok: false, reason: result.last_line || `close failed (exit ${result.exit_code})` };
}

export async function applyLeadQuestionAnswer(workerJobId: string, requestId: string, answer: string): Promise<AnswerResult> {
  const answerPath = join(directory(workerJobId), jobFiles.qa, `${requestId}.answer.md`);
  if (fs.existsSync(answerPath)) return { ok: true, written: false };
  return answerWorkerQuestion(workerJobId, requestId, answer);
}
