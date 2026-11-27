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
import { directory, findJob, readCachedStatus, save } from './store/job-store.js';
import { MAX_REPAIR_ROUNDS, recordDecision, type RunTodoItem, type TicketQueue } from './ticket-queue-state.js';
import type { OwnerApproval } from '../unattended/state.js';

export { MAX_REPAIR_ROUNDS, recordDecision };

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

const declaresNone = (value: string) => /^none\p{P}*$/iu.test(value.trim());

// Match pending-try notes (standalone or followed by detail), never mixed text
// that also names an owner decision.
const pendingTryPhrase =
  '(?:(?:only|just)\\s+)?(?:(?:a|the)\\s+)?(?:pending\\s+)?(?:owner\\s+(?:live\\s+|acceptance\\s+)?|live\\s+|acceptance\\s+)tr(?:y|ies)(?:\\s+(?:is\\s+|are\\s+)?(?:still\\s+)?(?:remain(?:s|ing)?|pending|outstanding|not\\s+(?:run|done)(?:\\s+yet)?|(?:left|yet|still)\\s+to\\s+(?:run|do)|(?:to\\s+be|needs?\\s+to\\s+be)\\s+(?:run|done)))?(?:\\s+(?:by|for)\\s+(?:the\\s+)?owner)?(?:\\s+only)?';

const pendingTryExact = new RegExp(`^${pendingTryPhrase}\\s*[.!]?$`, 'i');
const pendingTryWithDetail = new RegExp(`^${pendingTryPhrase}(?:\\s*(?::|[—–]|\\s+-\\s+)\\s*(.+)|\\s*\\(([^()]+)\\)\\s*[.!]?)$`, 'i');
const detailNamesDecision = /\b(?:decid(?:e[ds]?|ing)|decision|approv(?:e[ds]?|ing|al)|choos(?:e[ds]?|ing)|choice|confirm(?:ation)?|block(?:ed|er|ers|ing)?|escalat(?:e[ds]?|ing|ion)|delet(?:e[ds]?|ing|ion)|remov(?:e[ds]?|ing|al)|docs\/spec\.md|spec(?:ification)?|scope|trade-?off|irreversible|needs?\s+(?:an?\s+)?owner|owner\s+(?:must|needs?|should|to\s+decide)|ask\s+(?:the\s+)?owner|sign-?off|also|however|except)\b|[?;]/i;

const noneModifier = /^(?:(?:that\s+)?(?:requir(?:e[ds]?|ing)|need(?:s|ed|ing)?)\s+(?:an?\s+)?owner\s+(?:decision|decisions|approval|sign-?off|input|action)(?:\s+(?:before\s+(?:this\s+can\s+)?land(?:ing)?|to\s+land))?|(?:for\s+(?:the\s+)?owner|before\s+(?:this\s+can\s+)?land(?:ing)?|blocking\s+land(?:ing)?))\b/i;
const noOwnerDecisionClause = /^no\s+(?:owner\s+(?:decision|decisions|approval|sign-?off|input|action|blocker|blockers)|blockers?)(?:\s+(?:is\s+|are\s+)?(?:needed|required|pending|before\s+(?:this\s+can\s+)?land(?:ing)?|to\s+land))?\s*[.!]?$/i;

const noteHeaderWithColon = /^([ \t]*)(?:([-*])[ \t]+|(#{1,6})[ \t]+(?:\d+\.[ \t]+)?)?(?:\*\*)?(Blockers|Try)(?:\*\*)?:(?:\*\*)?([^\r\n]*)$/i;
const noteHeadingNoColon = /^([ \t]*)(#{1,6})[ \t]+(?:\d+\.[ \t]+)?(?:\*\*)?(Blockers|Try)(?:\*\*)?[ \t]*$/i;
const knownReportField = /^[ \t]*(?:[-*][ \t]+|#{1,6}[ \t]+(?:\d+\.[ \t]+)?)?(?:\*\*)?(?:Blockers|Try|Removes|Assumed|Todo|Decision|Reason|Answer|Owner approval)(?:\*\*)?:|^[ \t]*#{1,6}[ \t]+(?:\d+\.[ \t]+)?(?:\*\*)?(?:Blockers|Try)(?:\*\*)?[ \t]*$/i;
const markdownHeading = /^[ \t]*#{1,6}[ \t]+/;
const horizontalRule = /^[ \t]*(?:[-*_][ \t]*){3,}$/;
const bulletLine = /^([ \t]*)(?:[-*]|\d+\.)[ \t]+(.*)$/;

function cleanInlineNote(raw: string): string {
  let text = raw.trim();
  if (text.endsWith('**') && ((text.match(/\*\*/g)?.length ?? 0) % 2 === 1)) {
    text = text.slice(0, -2).trimEnd();
  }
  if (text.startsWith('**') && text.endsWith('**') && text.length > 4 && !text.slice(2, -2).includes('**')) {
    text = text.slice(2, -2).trim();
  } else if (text.startsWith('`') && text.endsWith('`') && text.length > 2 && !text.slice(1, -1).includes('`')) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function isPendingTryNote(text: string): boolean {
  if (pendingTryExact.test(text)) return true;
  const match = pendingTryWithDetail.exec(text);
  if (!match) return false;
  const detail = (match[1] ?? match[2] ?? '').trim();
  return Boolean(detail) && !detailNamesDecision.test(detail);
}

function classifyNoneQualifier(tail: string): { ok: true; tries: string[] } | { ok: false } {
  const parts = tail.split(/\s*;\s*/).map(p => p.trim()).filter(Boolean);
  if (!parts.length) return { ok: false };
  const tries: string[] = [];
  for (const part of parts) {
    if (noOwnerDecisionClause.test(part)) continue;
    if (isPendingTryNote(part)) { tries.push(part); continue; }
    return { ok: false };
  }
  return { ok: true, tries };
}

function classifyBlockerText(text: string): { kind: 'none'; tries: string[] } | { kind: 'try'; text: string } | { kind: 'blocker'; text: string } {
  if (declaresNone(text)) return { kind: 'none', tries: [] };
  if (isPendingTryNote(text)) return { kind: 'try', text };
  if (/^none\b/i.test(text)) {
    let rest = text.slice(4).trim();
    const mod = noneModifier.exec(rest);
    if (mod) {
      rest = rest.slice(mod[0].length).trim();
      if (!rest || /^[.!;]+$/.test(rest)) return { kind: 'none', tries: [] };
    }
    const paren = /^\(([^()]+)\)\s*[.!]?$/.exec(rest);
    if (paren) {
      const qual = classifyNoneQualifier(paren[1].trim());
      if (qual.ok) return { kind: 'none', tries: qual.tries };
    }
    const sep = /^(?:\.\s+|[—–;,:]\s*|-\s+)(.+)$/.exec(rest);
    if (sep) {
      const afterSep = sep[1].trim();
      const innerParen = /^\(([^()]+)\)\s*[.!]?$/.exec(afterSep);
      const qual = classifyNoneQualifier(innerParen ? innerParen[1].trim() : afterSep);
      if (qual.ok) return { kind: 'none', tries: qual.tries };
    }
  }
  return { kind: 'blocker', text };
}

export function extractReportNotes(reportText: string): { blockers: string[]; tries: string[] } {
  const blockers: string[] = [], tries: string[] = [];
  const lines = reportText.split(/\r?\n/);

  const recordEntry = (field: 'blockers' | 'try', raw: string) => {
    const text = cleanInlineNote(raw);
    if (!text) return false;
    if (field === 'try') {
      if (!declaresNone(text)) tries.push(text);
      return true;
    }
    const classified = classifyBlockerText(text);
    if (classified.kind === 'none') tries.push(...classified.tries);
    else if (classified.kind === 'try') tries.push(classified.text);
    else blockers.push(classified.text);
    return true;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const colonMatch = noteHeaderWithColon.exec(line);
    const headingMatch = colonMatch ? null : noteHeadingNoColon.exec(line);
    if (!colonMatch && !headingMatch) continue;

    const indent = (colonMatch?.[1] ?? headingMatch?.[1] ?? '').length;
    const isListHeader = Boolean(colonMatch?.[2]);
    const field = (colonMatch?.[4] ?? headingMatch?.[3] ?? '').toLowerCase() as 'blockers' | 'try';
    const inlineValue = colonMatch ? cleanInlineNote(colonMatch[5]) : '';

    if (inlineValue) {
      recordEntry(field, inlineValue);
      continue;
    }

    const items: string[] = [];
    let sawBullet = false;
    let lastBulletIndent = -1;
    let sawBlank = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const next = lines[j];
      if (!next.trim()) {
        if (items.length) sawBlank = true;
        continue;
      }
      if (knownReportField.test(next) || markdownHeading.test(next) || horizontalRule.test(next)) break;

      const bMatch = bulletLine.exec(next);
      if (bMatch) {
        const bIndent = bMatch[1].length;
        const bText = bMatch[2].trim();
        if (isListHeader && bIndent <= indent && /^\*\*[^*]+:\*\*/.test(bText)) break;
        if (sawBlank && !sawBullet) break;
        sawBlank = false;
        sawBullet = true;
        lastBulletIndent = bIndent;
        if (bText) items.push(bText);
        continue;
      }

      if (sawBlank) break;
      const nextIndent = next.match(/^[ \t]*/)![0].length;
      if (sawBullet && nextIndent > lastBulletIndent && items.length) {
        items[items.length - 1] = `${items[items.length - 1]} ${next.trim()}`;
      } else if (!sawBullet) {
        items.push(next.trim());
      } else {
        break;
      }
    }
    i = j - 1;

    let recorded = false;
    for (const item of items) {
      if (recordEntry(field, item)) recorded = true;
    }
    if (field === 'blockers' && !recorded) {
      blockers.push('Blockers: declared without details');
    }
  }
  return { blockers, tries };
}

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

export function buildReviewBrief(q: TicketQueue, stepTask: string): string {
  const landed = q.tickets.filter(t => t.landed);
  const crossRepo = landed.some(item => item.repo && item.repo !== q.root);
  const local = landed.some(item => !item.repo || item.repo === q.root);
  const lines = [
    stepTask,
    '',
    `Feature: ${q.feature} (run ${q.flow}, round ${(q.repair_rounds ?? 0) + 1})`,
    ...(q.start_head && local ? [`${crossRepo ? 'Tracker diff range' : 'Diff range'}: ${q.start_head}..HEAD (inspect with \`git diff --stat ${q.start_head}..HEAD\`)`] : []),
    '',
    'Landed tickets and design intent:',
    ...landed.map(item => {
      const info = ticketSummaryLines(q, item);
      const report = item.job ? join(directory(item.job), jobFiles.report) : 'no report';
      const target = item.repo && item.repo !== q.root ? ` | target repo: ${item.repo} | land: ${item.land ?? 'none'}` : '';
      return `- ${item.ticket}: ${info.goal ?? item.path}${target} | report: ${report}`;
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
      const info = ticketSummaryLines(q, item);
      const jobDir = item.job ? directory(item.job) : undefined;
      const reportRef = jobDir ? join(jobDir, jobFiles.report) : 'none';
      const checksRef = jobDir && fs.existsSync(join(jobDir, jobFiles.checks)) ? ` | checks: ${join(jobDir, jobFiles.checks)}` : '';
      return `- ${item.ticket}: ${info.goal ?? item.path}` +
        (info.liveTry ? ` | Live try: ${info.liveTry}` : '') +
        (item.repo && item.repo !== q.root ? ` | target repo: ${item.repo} | land: ${item.land ?? 'none'}` : '') +
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
    'If choosing `repair`, you must add the repair ticket(s) via `hud_tickets` with `repairs` set to the `<feature>/<NN>` slice(s) they fix (and `live_try`) before declaring `Decision: repair` so this run admits and lands them before re-reviewing.',
    'Do not edit docs/spec.md or land outside this run.',
    ...(q.unattended ? [`For unattended repair, add ready repair ticket(s) linked to Objective \`${q.unattended.objective}\` with \`repairs\` set to the \`<feature>/<NN>\` slice(s) they fix (and \`live_try\`) so this run admits them directly (bounded to ${MAX_REPAIR_ROUNDS} rounds). Never create an Objective or edit docs/spec.md.`, approvalFormat] : []),
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
