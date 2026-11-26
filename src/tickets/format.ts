/** Version 1 ticket schema and the pure Markdown brief shared by ticket readers and writers. */
export const MAX_TICKET_BYTES = 64 * 1024;
export const TICKET_FEATURE = /^[a-z0-9-]+$/;
export const TICKET_STATUSES = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'claimed', 'done', 'wontfix'] as const;
export const TICKET_KINDS = ['impl', 'flake-list', 'research', 'prototype', 'grilling', 'task'] as const;
export const TICKET_ROLES = ['imp', 'frontend-imp'] as const;
export type TicketStatus = typeof TICKET_STATUSES[number];
export type TicketKind = typeof TICKET_KINDS[number];
export type TicketRole = typeof TICKET_ROLES[number];

export interface AcceptanceItem { id: number; text: string; done: boolean }
export interface FlakeCaseRecord { step: string; test?: string; case_name?: string; flow?: string; log?: string; recorded_at: string }
export interface LandingRecord { at: string; job: string; flow: string; replay_base: string; gates: number; commit?: string }
export interface AcceptanceReceipt { at: string; by: 'main' | 'lead' | 'owner'; flow?: string; verdict?: string }
export interface TicketComment { at: string; author: string; text: string }

export interface TicketRecord {
  number: number;
  title: string;
  kind?: TicketKind;
  status: TicketStatus;
  claimed_at?: string;
  role?: TicketRole;
  main_review?: boolean;
  owner_try: boolean;
  live_try: string;
  approved_removals: string[];
  blocked_by: string[];
  objective?: string;
  what: string;
  cases?: FlakeCaseRecord[];
  acceptance: AcceptanceItem[];
  landing?: LandingRecord;
  accepted?: AcceptanceReceipt;
  comments: TicketComment[];
  created_at: string;
  updated_at: string;
}

export interface TicketFeatureDoc {
  version: 1;
  feature: string;
  title?: string;
  objective?: string;
  spec_path?: string;
  mirror?: { kind: 'github'; repo: string; issue: number; url: string; synced_at: string };
  tickets: TicketRecord[];
}

export const ticketNumber = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
export const ticketRef = (feature: string, n: number) => `${feature}/${String(n).padStart(2, '0')}`;
export function parseTicketRef(ref: unknown) {
  const match = typeof ref === 'string' && /^([a-z0-9-]+)\/(\d+)$/.exec(ref);
  const number = match ? Number(match[2]) : 0;
  return match && ticketNumber(number) ? { feature: match[1], number } : undefined;
}
const canonicalRef = (ref: unknown) => {
  const parsed = parseTicketRef(ref);
  return !!parsed && ticketRef(parsed.feature, parsed.number) === ref;
};

type Check = (value: unknown, field: string) => unknown;
const invalid = (field: string): never => { throw new Error(`Invalid ticket store field: ${field}`); };
const string = (x: unknown) => typeof x === 'string' && !!x.trim();
const date = (x: unknown) => typeof x === 'string' && Number.isFinite(Date.parse(x));
const bool = (x: unknown) => typeof x === 'boolean';
const check = (test: (x: unknown) => boolean): Check => (x, field) => test(x) ? x : invalid(field);
const optional = (read: Check): Check => (x, field) => x === undefined ? x : read(x, field);
const choice = (...values: unknown[]) => check(x => values.includes(x));
const array = (read: Check): Check => (x, field) => Array.isArray(x)
  ? Array.from(x, (item, i) => read(item, `${field}[${i}]`)) : invalid(field);
const object = (fields: Record<string, Check>): Check => (x, field) => {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return invalid(field);
  const source = x as Record<string, unknown>;
  for (const key of Object.keys(source)) if (!Object.hasOwn(fields, key)) invalid(`${field}.${key}`);
  return Object.fromEntries(Object.entries(fields).flatMap(([key, read]) => {
    const value = read(Object.hasOwn(source, key) ? source[key] : undefined, `${field}.${key}`);
    return value === undefined ? [] : [[key, value]];
  }));
};
const text = check(string), timestamp = check(date), positive = check(ticketNumber);
const record = object({
  number: positive, title: text, kind: optional(choice(...TICKET_KINDS)), status: choice(...TICKET_STATUSES),
  claimed_at: optional(timestamp), role: optional(choice(...TICKET_ROLES)), main_review: optional(check(bool)),
  owner_try: check(bool), live_try: text, approved_removals: array(text), blocked_by: array(check(canonicalRef)),
  objective: optional(text), what: text,
  cases: optional(array(object({ step: text, test: optional(text), case_name: optional(text), flow: optional(text), log: optional(text), recorded_at: timestamp }))),
  acceptance: array(object({ id: positive, text, done: check(bool) })),
  landing: optional(object({ at: timestamp, job: text, flow: text, replay_base: text,
    gates: check(n => n === 0 || ticketNumber(n)), commit: optional(text) })),
  accepted: optional(object({ at: timestamp, by: choice('main', 'lead', 'owner'), flow: optional(text), verdict: optional(text) })),
  comments: array(object({ at: timestamp, author: text, text })), created_at: timestamp, updated_at: timestamp,
});
const featureDoc = object({
  version: choice(1), feature: check(x => typeof x === 'string' && TICKET_FEATURE.test(x)), title: optional(text),
  objective: optional(text), spec_path: optional(text),
  mirror: optional(object({ kind: choice('github'), repo: text, issue: positive, url: text, synced_at: timestamp })),
  tickets: array(record),
});

/** Rebuild in schema order (including nested keys), never mutate the supplied document. */
export function validateTicketFeature(value: unknown, feature?: string): TicketFeatureDoc {
  const doc = featureDoc(value, 'feature') as TicketFeatureDoc;
  if (feature !== undefined && doc.feature !== feature) invalid('feature (does not match filename)');
  const numbers = new Set<number>();
  for (const ticket of doc.tickets) {
    const id = ticketRef(doc.feature, ticket.number);
    if (numbers.has(ticket.number)) invalid(`${id} (duplicate ticket number)`);
    numbers.add(ticket.number);
    if (ticket.claimed_at && ticket.status !== 'claimed') invalid(`${id}.claimed_at (not claimed)`);
    if (new Set(ticket.acceptance.map(item => item.id)).size !== ticket.acceptance.length) invalid(`${id}.acceptance (duplicate id)`);
  }
  doc.tickets.sort((a, b) => a.number - b.number);
  return doc;
}

export function renderTicketBrief(ticket: TicketRecord, feature: Pick<TicketFeatureDoc, 'objective' | 'spec_path'> = {}): string {
  const objective = ticket.objective ?? feature.objective;
  return [
    `# ${String(ticket.number).padStart(2, '0')}: ${ticket.title}`, '',
    `**Status:** ${ticket.status}`,
    ...(ticket.kind && ticket.kind !== 'impl' ? [`**Kind:** ${ticket.kind}`] : []),
    ...(ticket.role ? [`**Role:** ${ticket.role}`] : []),
    ...(ticket.main_review ? ['**Main review:** yes'] : []),
    `**Owner try:** ${ticket.owner_try ? 'yes' : 'no'}`, `**Live try:** ${ticket.live_try}`,
    ...(ticket.approved_removals.length ? [`**Approved removals:** ${ticket.approved_removals.join(', ')}`] : []),
    `**Blocked by:** ${ticket.blocked_by.join(', ') || 'none'}`,
    ...(objective ? [`**Objective:** ${objective}`] : []),
    ...(feature.spec_path ? [`**Spec:** ${feature.spec_path}`] : []),
    '', `**What to build:** ${ticket.what}`, '',
    ...ticket.acceptance.map(item => `- [${item.done ? 'x' : ' '}] ${item.text}`),
    ...(ticket.acceptance.length ? [''] : []), '## Comments', '',
    ...(ticket.comments.length ? [...ticket.comments.map(comment => `- ${comment.at} ${comment.author}: ${comment.text}`), ''] : []),
  ].join('\n');
}
