/** Shared ticket identity and file evidence. No project scan or Git call. */
import { basename } from 'node:path';
import type { TicketRecord } from '../tickets/format.js';
import type { ProjectTicket } from './project-board.js';

/** JSON rows share a file, but never a cursor or checklist toggle. */
export const ticketRowKey = (ticket: Pick<ProjectTicket, 'number' | 'path'>) =>
  ticket.path.endsWith('.json') ? ticket.number : basename(ticket.path);
export function targetKey(id: string): string {
  const token = id.trim().toLowerCase();
  const m = /^([a-z0-9-]+)[/#](\d+)$/.exec(token) ?? /^([a-z0-9-]+)-(\d+)$/.exec(token);
  return m ? `${m[1]}/${Number(m[2])}` : token;
}

export function ticketHeading(text: string, number: number) {
  const match = text.match(/^# (\d+):[ \t]*(\S[^\r\n]*)/m);
  return match && Number(match[1]) === number ? { number: match[1], title: match[2].trim() } : null;
}

export function ticketFileEvidence(text: string) {
  const [body, commentsSection = ''] = text.split(/^## Comments[ \t]*\r?$/m, 2);
  const comments = commentsSection.split(/^## /m, 1)[0];
  const field = (key: string) => body.match(new RegExp(`(?:^|·)[ \\t]*\\*\\*${key}:\\*\\*[ \\t]*([^·\\r\\n]*)`, 'mi'))?.[1]?.trim();
  const status = field('Status'), blocked = field('Blocked by');
  const repairs = field('Repairs');
  const approvedRemovals = field('Approved removals');
  const trial = field('Owner try') ?? '';
  const ownerTry = /^yes$/i.test(trial);
  const items = [...body.matchAll(/^[ \t]*[-*] \[([ xX])\][ \t]*([^\r\n]*)/gm)].map(b => ({
    done: b[1].toLowerCase() === 'x', text: b[2].replace(/\s+/g, ' ').trim(),
  }));
  const checked = items.filter(i => i.done).length;
  const record = [...comments.matchAll(/^[ \t]*[-*][ \t]+Landed:?[ \t]+(?:in this commit \(replay base (?:[0-9a-f]{40}|[0-9a-f]{64})\)|(?:(?:in|at)[ \t]+)?`?([0-9a-f]{7,40})`?\b)/gim)].at(-1);
  const acceptedByLead = /^[ \t]*[-*][ \t]+Accepted by unattended lead \(q[0-9a-f]{16}\):/im.test(comments);
  const commit = record?.[1], recordedLanding = !!record;
  const allChecked = items.length > 0 && checked === items.length;
  const readyForHuman = /^ready-for-human\b/i.test(status ?? '');
  const landed = /^(wontfix|dropped)\b/i.test(status ?? '') ? 'dropped'
    : /^(accepted|done|closed|complete|resolved)\b/i.test(status ?? '') || acceptedByLead ? 'done'
    // Preserve legacy pending records with no Owner try field.
    : /^try\b/i.test(status ?? '') || recordedLanding || (readyForHuman && allChecked) ? (/^no\b/i.test(trial) ? 'done' : 'try')
    : allChecked ? 'done' : undefined;
  return { status, blocked, repairs, approvedRemovals, items, checked, ownerTry, landed, recordedLanding, ...(commit ? { commit } : {}) } as const;
}

const commentText = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 600);

export function legacyTicketEvidence(text: string, number: number, path: string, at: number): ProjectTicket | undefined {
  const heading = ticketHeading(text, number);
  const { status, blocked, items, checked, ownerTry, landed, commit, recordedLanding } = ticketFileEvidence(text);
  if (!heading || !status || blocked === undefined) return;
  const comments = text.split(/^## Comments[ \t]*\r?$/m)[1]?.split(/^## /m)[0] ?? '';
  const bullets = [...comments.matchAll(/^[-*] (.+(?:\r?\n[ \t]+.+)*)/gm)].map((m) => commentText(m[1])).filter(Boolean);
  const comment = bullets.at(-1), landedComment = bullets.filter((b) => /^Landed\b/i.test(b)).at(-1);
  return { ...heading, path, at, status, ownerTry, items, checked, total: items.length,
    ...(commit ? { commit } : {}), ...(recordedLanding ? { recordedLanding } : {}),
    ...(comment ? { comment } : {}), ...(landedComment && landedComment !== comment ? { landedComment } : {}),
    blockers: /^none\b/i.test(blocked) ? [] : [blocked],
    state: landed ?? (/^claimed\b/i.test(status) ? 'working' : 'ready') };
}

export function storedTicketEvidence(ticket: TicketRecord, path: string, sourcePath: string): ProjectTicket {
  const { status, landing, accepted, owner_try: ownerTry } = ticket;
  const landingAt = landing ? Date.parse(landing.at) : undefined;
  const state = status === 'wontfix' ? 'dropped' : status === 'done' || accepted ? 'done'
    : landing ? ownerTry ? 'try' : 'done' : status === 'claimed' ? 'working' : 'ready';
  const items = ticket.acceptance.map(({ done, text }) => ({ done, text }));
  const comment = ticket.comments.at(-1)?.text;
  return { number: String(ticket.number).padStart(2, '0'), title: ticket.title, path, sourcePath, status, ownerTry,
    at: Date.parse(ticket.updated_at), state, blockers: ticket.blocked_by,
    ...(ticket.claimed_at ? { claimedAt: Date.parse(ticket.claimed_at) } : {}),
    items, checked: items.filter(({ done }) => done).length, total: items.length,
    ...(landing ? { landingAt, recordedLanding: true,
      ...(/^[a-f0-9]{7,64}$/i.test(landing.commit ?? '') ? { commit: landing.commit } : {}) } : {}),
    ...(comment ? { comment: commentText(comment) } : {}) };
}
