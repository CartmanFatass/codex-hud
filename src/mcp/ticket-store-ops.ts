import * as fs from 'node:fs';
import { join } from 'node:path';
import { scanScratch } from '../cli/tickets.js';
import { OBJECTIVE_SLUG, readObjectives } from '../collectors/objectives.js';
import { localProjectRoots } from '../roles/projects.js';
import { runTicketEdit, type TicketEditWriter } from '../tickets/archive.js';
import { commitTicketWrites } from '../tickets/commit.js';
import {
  canonicalTicketRef, legacyTicketPaths, normalizeHomePaths, parseTicketRef, readJsonTicketFeature, readTicketFeature, resolveArchivedTicket,
  splitRemovals, storedTicket, ticketFeaturePath, ticketNumber, ticketRef, TICKET_FEATURE, TICKET_KINDS, TICKET_ROLES,
  TICKET_STATUSES, type TicketFeatureDoc, type TicketRecord,
} from '../tickets/store.js';
import { extractWhatAndLiveTry, repoFieldValue, unlinkedWarning } from './local-tickets.js';

function invalid(field: string): never { throw new Error(`invalid_arguments: ${field}`); }
const text = (value: unknown, field: string) => typeof value === 'string' && value.trim() ? normalizeHomePaths(value.trim()) : invalid(field);
const line = (value: unknown, field: string) => text(value, field).replace(/\s+/g, ' ');
const flag = (value: unknown, field: string) => typeof value === 'boolean' ? value : invalid(field);
const featureSlug = (value: unknown) => typeof value === 'string' && TICKET_FEATURE.test(value) ? value : invalid('feature');
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(field);
  return value as Record<string, unknown>;
}
function choice<T extends string>(choices: readonly T[], value: unknown, field: string) {
  return choices.find(option => option === value) ?? invalid(field);
}
const specFields = ['title', 'what', 'live_try', 'approved_removals', 'kind', 'role', 'main_review', 'acceptance', 'comment'];
const editFields = ['status', 'tick', 'blocked_by', 'repairs', 'owner_try', 'objective', 'repo', ...specFields];
const has = (args: Record<string, unknown>, fields: string[]) => fields.some(field => args[field] !== undefined);

function parseTicketNumber(value: unknown): number | undefined {
  if (ticketNumber(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value);
    if (ticketNumber(n)) return n;
  }
}

function resolveTicketTarget(featureArg: unknown, ticketArg: unknown, refError = 'ticket'): { feature: string; number: number } {
  const num = parseTicketNumber(ticketArg);
  const ref = typeof ticketArg === 'string' && num === undefined
    ? parseTicketRef(ticketArg) ?? invalid(refError)
    : undefined;
  const feature = featureArg === undefined && ref ? ref.feature : featureSlug(featureArg);
  if (ref && ref.feature !== feature) invalid('ticket does not match feature');
  const number = ref?.number ?? num;
  if (!number) return invalid('ticket');
  return { feature, number };
}

export function getTickets(cwd: string, args: Record<string, unknown>) {
  const { mainRoot } = localProjectRoots(cwd);
  if (args.ticket === undefined) {
    const feature = featureSlug(args.feature);
    const doc = readTicketFeature(mainRoot, feature);
    if (!doc) throw new Error(`unknown ticket feature: ${feature}`);
    return { ok: true, feature: doc };
  }
  const { feature, number: n } = resolveTicketTarget(args.feature, args.ticket, 'ticket (expected feature/NN)');
  const doc = readTicketFeature(mainRoot, feature);
  const matches = doc?.tickets.filter(ticket => ticket.number === n) ?? [];
  if (matches.length > 1) throw new Error(`ambiguous ticket: ${ticketRef(feature, n)}`);
  if (matches.length) return { ok: true, feature, ticket: matches[0] };
  const archived = !doc?.mirror && resolveArchivedTicket(mainRoot, feature, n);
  if (archived) return { ok: true, feature: archived.doc.feature, ticket: archived.record };
  if (!doc) throw new Error(`unknown ticket feature: ${feature}`);
  throw new Error(`unknown ticket: ${ticketRef(feature, n)}`);
}

export async function commitTickets(cwd: string, home: string) {
  return commitTicketWrites(cwd, home);
}

export async function editTickets(cwd: string, args: Record<string, unknown>, home: string, author: 'main' | 'lead') {
  const { op } = args;
  if (op !== 'add' && op !== 'update') return invalid('op');
  const { mainRoot } = localProjectRoots(cwd);
  const guardMirror = () => scanScratch(join(mainRoot, '.scratch'), true);
  const markdown = (feature: string) => !readJsonTicketFeature(mainRoot, feature) && legacyTicketPaths(mainRoot, feature).length > 0;
  const legacyError = (feature: string) =>
    new Error(`Feature "${feature}" still uses legacy Markdown tickets; run "hud tickets migrate" first`);
  const json = <T>(edit: (write: TicketEditWriter) => Promise<T>) => runTicketEdit(mainRoot, home, 300, edit);
  let objectiveIds: Set<string> | undefined;
  const objectiveId = (value: unknown) => {
    if (typeof value !== 'string' || !new RegExp(OBJECTIVE_SLUG).test(value)) return invalid('objective');
    objectiveIds ??= new Set(readObjectives(mainRoot)?.objectives.map(o => o.id));
    if (!objectiveIds.has(value)) throw new Error(`unknown objective: ${value}`);
    return value;
  };
  const existingRef = (doc: TicketFeatureDoc, { feature, number }: { feature: string; number: number }) => {
    const local = feature === doc.feature ? doc : readJsonTicketFeature(mainRoot, feature);
    if ((local?.tickets ?? legacyTicketPaths(mainRoot, feature)).some(t => t.number === number)) return ticketRef(feature, number);
    const archived = !local?.mirror && resolveArchivedTicket(mainRoot, feature, number);
    if (archived) return ticketRef(archived.doc.feature, number);
  };
  const blockers = (value: unknown, doc: TicketFeatureDoc) => {
    if (!Array.isArray(value)) return invalid('blocked_by');
    return value.map(raw => {
      const ref = ticketNumber(raw) ? { feature: doc.feature, number: raw } : parseTicketRef(raw);
      if (!ref) return invalid(`blocked_by (invalid ticket reference: ${String(raw)})`);
      const existing = existingRef(doc, ref);
      if (!existing) throw new Error(`unknown blocked_by ticket: ${raw}`);
      return existing;
    });
  };
  const repairs = (value: unknown, doc: TicketFeatureDoc) => {
    if (!Array.isArray(value)) return invalid('repairs');
    return value.map(raw => {
      if (!canonicalTicketRef(raw)) return invalid(`repairs (invalid ticket reference: ${String(raw)}; expected <feature>/<NN>)`);
      const existing = existingRef(doc, parseTicketRef(raw)!);
      if (!existing) throw new Error(`unknown repairs ticket: ${raw}`);
      return existing;
    });
  };
  const writable = (feat: string) => {
    const doc = readJsonTicketFeature(mainRoot, feat);
    if (doc?.mirror) throw new Error('refusing local ticket edits: GitHub mirror; edit issues with gh, then call hud_tickets with op: sync');
    return doc;
  };
  const patch = (ticket: TicketRecord, input: Record<string, unknown>, at: string) => {
    if (input.title !== undefined) ticket.title = line(input.title, 'title');
    if (input.what !== undefined) ticket.what = text(input.what, 'what');
    if (input.live_try !== undefined) ticket.live_try = line(input.live_try, 'live_try');
    if (input.approved_removals !== undefined) {
      ticket.approved_removals = Array.isArray(input.approved_removals)
        ? input.approved_removals.flatMap(item => splitRemovals(text(item, 'approved_removals')))
        : splitRemovals(text(input.approved_removals, 'approved_removals'));
    }
    if (input.kind !== undefined) ticket.kind = choice(TICKET_KINDS, input.kind, 'kind');
    if (input.role !== undefined) ticket.role = choice(TICKET_ROLES, input.role, 'role');
    if (input.repo !== undefined) ticket.repo = repoFieldValue(input.repo);
    if (input.main_review !== undefined) ticket.main_review = flag(input.main_review, 'main_review');
    if (input.owner_try !== undefined) ticket.owner_try = flag(input.owner_try, 'owner_try');
    if (input.status !== undefined) {
      ticket.status = choice(TICKET_STATUSES, input.status, 'status');
      if (ticket.status === 'claimed') ticket.claimed_at ??= at;
      else delete ticket.claimed_at;
    }
    if (input.objective !== undefined) ticket.objective = objectiveId(input.objective);
    if (input.comment !== undefined) ticket.comments.push({ at, author, text: text(input.comment, 'comment') });
  };

  const addJson = async (feature: string, write: TicketEditWriter) => {
    objectiveIds = undefined;
    let doc = writable(feature);
    if (!doc) {
      guardMirror();
      const spec_path = `.scratch/${feature}/spec.md`;
      doc = { version: 1, feature, ...(fs.existsSync(join(mainRoot, spec_path)) && { spec_path }), tickets: [] };
    }
    if (!Array.isArray(args.tickets) || !args.tickets.length) return invalid('tickets');
    const shared = args.objective === undefined ? undefined : objectiveId(args.objective);
    let next = doc.tickets.at(-1)?.number ?? 0;
    const at = new Date().toISOString();
    const tickets = args.tickets.map(raw => {
      const draft = object(raw, 'tickets');
      if (!ticketNumber(++next)) throw new Error('ticket numbering exhausted');
      if (!Array.isArray(draft.acceptance)) return invalid('acceptance');
      const extracted = draft.live_try === undefined ? extractWhatAndLiveTry(draft.what, undefined) : undefined;
      const repairRefs = draft.repairs === undefined ? undefined : repairs(draft.repairs, doc!);
      const ticket: TicketRecord = {
        number: next, title: line(draft.title, 'title'), status: 'ready-for-agent', owner_try: false,
        live_try: extracted?.liveTry ?? 'none', what: text(draft.what, 'what'), approved_removals: [],
        blocked_by: blockers(draft.blocked_by, doc!), ...(repairRefs?.length && { repairs: repairRefs }),
        ...(shared && { objective: shared }),
        acceptance: draft.acceptance.map((item, i) => ({ id: i + 1, text: text(item, 'acceptance'), done: false })),
        comments: [], created_at: at, updated_at: at,
      };
      patch(ticket, draft, at);
      if (extracted?.liveTry) ticket.what = extracted.what;
      doc!.tickets.push(ticket);
      return ticket;
    });
    const links = new Map(tickets.flatMap(ticket => ticket.objective ? [[ticket.objective, new Set([feature])] as const] : []));
    const { moved } = await write([doc], links);
    const warning = unlinkedWarning(mainRoot, feature);
    return { ok: true, tickets: tickets.map(({ number }) => ({ number, path: editedPath(feature, number, moved) })), ...(warning && { warning }) };
  };

  const editedPath = (feature: string, number: number, moved: ReadonlyMap<string, string>) =>
    ticketFeaturePath(mainRoot, parseTicketRef(moved.get(ticketRef(feature, number)))?.feature ?? feature);
  const updateJson = async (feature: string, item: Record<string, unknown>, write: TicketEditWriter) => {
    objectiveIds = undefined;
    if (!ticketNumber(item.ticket)) return invalid('ticket');
    if (!has(item, editFields)) return invalid(`update requires one of: ${editFields.join(', ')}`);
    const stored = storedTicket(mainRoot, ticketRef(feature, item.ticket));
    if (stored?.doc.mirror) writable(stored.doc.feature); // Report the mirror edit refusal.
    if (!stored?.record) throw new Error(`unknown ticket: ${ticketRef(feature, item.ticket)}`);
    const { doc, record: ticket } = stored;
    const base = JSON.stringify(ticket), at = new Date().toISOString();
    patch(ticket, item, at);
    if (item.blocked_by !== undefined) ticket.blocked_by = blockers(item.blocked_by, doc);
    if (item.repairs !== undefined) {
      const repairRefs = repairs(item.repairs, doc);
      if (repairRefs.length) ticket.repairs = repairRefs;
      else delete ticket.repairs;
    }
    const acceptance = (id: unknown) => {
      if (typeof id !== 'number' || !Number.isSafeInteger(id)) return invalid('acceptance id');
      const match = ticket.acceptance.find(item => item.id === id);
      if (!match) {
        const ids = ticket.acceptance.map(item => item.id);
        const help = !ids.length ? 'no acceptance items' : ids.every((id, i) => id === i + 1)
          ? `valid range: 1-${ids.length}` : `valid IDs: ${ids.join(', ')}`;
        throw new Error(`unknown acceptance item: ${id} (${help})`);
      }
      return match;
    };
    if (item.acceptance !== undefined) {
      if (!Array.isArray(item.acceptance)) return invalid('acceptance');
      for (const raw of item.acceptance) {
        const change = object(raw, 'acceptance');
        acceptance(change.id).text = text(change.text, 'acceptance text');
      }
    }
    if (item.tick !== undefined) {
      if (!Array.isArray(item.tick)) return invalid('tick');
      for (const id of item.tick) acceptance(id).done = true;
    }
    let path = ticketFeaturePath(mainRoot, doc.feature);
    if (JSON.stringify(ticket) !== base) {
      ticket.updated_at = at;
      path = editedPath(doc.feature, ticket.number, (await write([doc])).moved);
    }
    return { ok: true, number: ticket.number, path };
  };
  if (op === 'add') {
    if (args.updates !== undefined) return invalid('updates');
    const feature = featureSlug(args.feature);
    if (markdown(feature)) throw legacyError(feature);
    return json((write) => addJson(feature, write));
  }
  // Preserve project-wide protection for a GitHub Markdown mirror.
  guardMirror();
  if (args.updates === undefined) {
    const { feature, number } = resolveTicketTarget(args.feature, args.ticket);
    if (markdown(feature)) throw legacyError(feature);
    return json((write) => updateJson(feature, { ...args, feature, ticket: number }, write));
  }
  if (args.ticket !== undefined || has(args, editFields) || !Array.isArray(args.updates) || !args.updates.length) return invalid('updates');
  const sharedFeature = args.feature === undefined ? undefined : featureSlug(args.feature);
  type BatchItem = { index: number; feature: string; item: Record<string, unknown> };
  const jsonItems: BatchItem[] = [];
  const updates: object[] = [];
  const failed = (index: number, feature: unknown, ticket: unknown, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    updates[index] = { ...(typeof feature === 'string' && { feature }), ...(ticketNumber(ticket) && { ticket }),
      ok: false, code: message.startsWith('invalid_arguments') ? 'invalid_arguments' : 'tool_error', error: message };
  };
  for (const [index, raw] of args.updates.entries()) {
    let feature: unknown = sharedFeature, ticket: unknown;
    try {
      const item = object(raw, 'updates');
      feature = item.feature ?? sharedFeature;
      ticket = item.ticket;
      const resolved = resolveTicketTarget(feature, ticket);
      feature = resolved.feature;
      ticket = resolved.number;
      if (markdown(resolved.feature)) throw legacyError(resolved.feature);
      jsonItems.push({ index, feature: resolved.feature, item: { ...item, feature: resolved.feature, ticket: resolved.number } });
    } catch (error) { failed(index, feature, ticket, error); }
  }
  for (const { index, feature, item } of jsonItems) {
    try { updates[index] = { feature, ...await json((write) => updateJson(feature, item, write)) }; }
    catch (error) { failed(index, feature, item.ticket, error); }
  }
  return { updates };
}
