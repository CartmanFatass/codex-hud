/** Lead acceptance/question packets, report parsing, and normal HUD closure for workflow runs. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { readFileBounded } from '../utils/atomic-fs.js';
import type { Step } from '../workflows/graph.js';
import type { Job } from './job-contracts.js';
import { answerWorkerQuestion, closeJob } from './mcp/operations.js';
import type { AnswerResult } from '../collectors/panel-actions.js';
import { parseRemovalList, ticketApprovedRemovals } from './local-tickets.js';
import { jobFiles } from './paths.js';
import { directory, findJob, save } from './store/job-store.js';
import type { RunDecision, RunTodoItem, TicketQueue } from './ticket-queue-state.js';
import type { OwnerApproval } from '../unattended/state.js';

const approvalFormat = 'For escalate, include `Owner approval: feature-deletion` or `Owner approval: spec-change` and explain the specific change in Reason. Do not use escalate for operational failures.';

export const DEFAULT_ESCALATION_RULE =
  'Escalate to main only for owner matters that block: scope change, value trade-off, visible deletion, or irreversible act.';

export const WORKFLOW_WORKER_RULE =
  'Workflow run rule: proceed on the ticket, docs/spec.md and your own default; write each assumption on its own `Assumed:` line (mark scope assumptions with `scope`); ask with `hud_ask` only when no reasonable default is safe; report owner matters (scope, value trade-off, visible deletion, irreversible act) as `Blockers:` lines; include a `Removes:` line (`Removes: none`, a comma-separated list of user-visible features removed, or `Removes: ambiguous: <detail>` if unsure).';

export const WORKFLOW_WORKER_RULE_NO_ASK =
  'Workflow run rule: proceed on the ticket, docs/spec.md and your own default; write each assumption on its own `Assumed:` line (mark scope assumptions with `scope`); do not call `hud_ask`; report owner matters (scope, value trade-off, visible deletion, irreversible act) as `Blockers:` lines; include a `Removes:` line (`Removes: none`, a comma-separated list of user-visible features removed, or `Removes: ambiguous: <detail>` if unsure).';

export const MAX_REPAIR_ROUNDS = 2;
export const MAX_ANSWER_RETRIES = 3;
const MAX_RUN_TODOS = 200;
const MAX_RUN_DECISIONS = 100;

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
  const nonNone = values.filter(v => !/^none\.?$/i.test(v));
  if (!nonNone.length) return { kind: 'none' };
  const raw = nonNone.join(', ');
  const items = parseRemovalList(raw);
  return items.length ? { kind: 'named', items, raw } : { kind: 'missing' };
}

export function extractAssumedLines(reportText: string): { lines: string[]; scopeAssumptions: string[] } {
  const lines: string[] = [];
  for (const match of reportText.matchAll(/^[ \t]*(?:[-*] |#{1,6} )?(?:\*\*)?Assumed:(?:\*\*)?[ \t]*(.+?)[ \t]*$/gim)) {
    const text = match[1].trim();
    if (text) lines.push(text);
  }
  const scopeAssumptions = lines.filter(line => /\bscope\b/i.test(line));
  return { lines, scopeAssumptions };
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
  const ownerApproval = decision === 'escalate' && reason ? approval?.toLowerCase() as OwnerApproval | undefined : undefined;
  return { decision, reason, answer, ...(ownerApproval && { ownerApproval }), todos: extractTodoLines(reportText) };
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

export function recordDecision(q: TicketQueue, entry: RunDecision): void {
  const list = q.decisions ?? [];
  list.push(entry);
  q.decisions = list.length > MAX_RUN_DECISIONS ? list.slice(-MAX_RUN_DECISIONS) : list;
}

function ticketSummaryLines(path: string): { goal?: string; liveTry?: string } {
  try {
    const body = readFileBounded(path, 64 * 1024).bytes.toString('utf8').split(/^## Comments[ \t]*\r?$/m, 1)[0];
    const goal = body.match(/^(?:\*\*What to build:\*\*|## What to build\b)[ \t]*(?:\r?\n[ \t]*)*([^\r\n]*)/mi)?.[1]?.trim();
    const liveTry = body.match(/(?:^|·)[ \t]*(?:\*\*)?(?:Live try|How to try|Try)(?::\*\*|\*\*:|:)[ \t]*([^\r\n·]+)/im)?.[1]?.trim();
    return { ...(goal && { goal }), ...(liveTry && { liveTry }) };
  } catch {
    return {};
  }
}

export function buildReviewBrief(q: TicketQueue, stepTask: string): string {
  const landed = q.tickets.filter(t => t.landed);
  const lines = [
    stepTask,
    '',
    `Feature: ${q.feature} (run ${q.flow}, round ${(q.repair_rounds ?? 0) + 1})`,
    ...(q.start_head ? [`Diff range: ${q.start_head}..HEAD (inspect with \`git diff --stat ${q.start_head}..HEAD\`)`] : []),
    '',
    'Landed tickets and design intent:',
    ...landed.map(item => {
      const info = ticketSummaryLines(item.path);
      const report = item.job ? join(directory(item.job), jobFiles.report) : 'no report';
      return `- ${item.ticket}: ${info.goal ?? item.path} | report: ${report}`;
    }),
  ];
  return lines.join('\n') + '\n';
}

export function buildAcceptPacket(q: TicketQueue, step: Extract<Step, { kind: 'handback' }>): string {
  const rounds = q.repair_rounds ?? 0;
  const escalationRule = step.escalation_rule ?? q.escalation_rule ?? DEFAULT_ESCALATION_RULE;
  const landed = q.tickets.filter(t => t.landed);
  const held = q.tickets.filter(t => t.held);
  const failed = q.tickets.filter(t => t.failed);
  const latestReview = q.reviews?.at(-1);
  const choices = rounds >= MAX_REPAIR_ROUNDS ? step.options.filter(o => o !== 'repair') : step.options;

  const lines: string[] = [
    `# Workflow Acceptance Packet (${q.flow})`,
    '',
    q.unattended ? `Objective: ${q.unattended.objective}` : `Feature: ${q.feature}`,
    `Question: ${step.ask}`,
    `Declared choices: ${choices.join(', ')}${rounds >= MAX_REPAIR_ROUNDS ? ` (repair limit ${MAX_REPAIR_ROUNDS}/${MAX_REPAIR_ROUNDS} reached)` : ` (repair round ${rounds}/${MAX_REPAIR_ROUNDS})`}`,
    `Escalation rule: ${escalationRule}`,
    '',
    '## Tickets, Live Try & Reports',
    ...(landed.length ? landed.map(item => {
      const info = ticketSummaryLines(item.path);
      const jobDir = item.job ? directory(item.job) : undefined;
      const reportRef = jobDir ? join(jobDir, jobFiles.report) : 'none';
      const checksRef = jobDir && fs.existsSync(join(jobDir, jobFiles.checks)) ? ` | checks: ${join(jobDir, jobFiles.checks)}` : '';
      return `- ${item.ticket}: ${info.goal ?? item.path}` +
        (info.liveTry ? ` | Live try: ${info.liveTry}` : '') +
        ` | ticket: ${item.path} | report: ${reportRef}${checksRef}`;
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
    'If choosing `repair`, add the repair ticket(s) via `hud_tickets` (with `live_try`) before reporting so this run admits and lands them before re-reviewing.',
    'Do not edit docs/spec.md or land outside this run.',
    ...(q.unattended ? [`For unattended repair, add ready repair ticket(s) linked to Objective \`${q.unattended.objective}\` (with \`live_try\`) so this run admits them directly (bounded to ${MAX_REPAIR_ROUNDS} rounds). Never create an Objective or edit docs/spec.md.`, approvalFormat] : []),
  );
  return lines.join('\n') + '\n';
}

export function buildQuestionPacket(
  q: TicketQueue,
  opts: { step?: string; ticket?: string; ticketPath?: string; workerJob: string; question: string; questionPath: string },
): string {
  const escalationRule = q.escalation_rule ?? DEFAULT_ESCALATION_RULE;
  const info = opts.ticketPath ? ticketSummaryLines(opts.ticketPath) : {};
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
  const info = ticketSummaryLines(item.path);
  const approved = ticketApprovedRemovals(item.path);
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

export interface CloseLeadResult {
  ok: boolean;
  reason?: string;
}

/** Close a lead session through normal HUD closure (herdr, exact identity); adds no new kill sites. */
export async function closeLeadJob(job: Job): Promise<CloseLeadResult> {
  const latest = findJob(job.job) ?? job;
  if (latest.reaped_at) return { ok: true };
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
