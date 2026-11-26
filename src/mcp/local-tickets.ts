import * as fs from 'node:fs';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { scanScratch, slugify, ticketsCommand, writeFileAtomic } from '../cli/tickets.js';
import { OBJECTIVE_SLUG, objectiveLink, readObjectives } from '../collectors/objectives.js';
import type { ProjectTicket } from '../collectors/project-board.js';
import { STATE_BYTES } from '../collectors/state-ledger.js';
import { targetKey, ticketFileEvidence, ticketHeading } from '../collectors/ticket-evidence.js';
import { SETTLED_JOB_STATES, TicketRollup, ticketJobState } from '../collectors/ticket-rollup.js';
import { getHudHome } from '../hud-home.js';
import type { JobIndexCache } from '../roles/job-index-cache.js';
import { projectJobFilter } from '../roles/job-project.js';
import { projectRoot, sharedRoot } from '../roles/projects.js';
import { TICKET_STATUSES } from '../roles/tool-definitions.js';
import { readOpenHolds } from '../unattended/state.js';
import { readFileBounded } from '../utils/atomic-fs.js';
import type { Job } from './job-contracts.js';
import { linkFeature } from './local-objectives.js';

const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nn = (value: number) => String(value).padStart(2, '0');
function invalid(field: string): never {
  throw new Error(`invalid_arguments: ${field}`);
}
function line(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) return invalid(field);
  return value.replace(/\s+/g, ' ').trim();
}
function status(value: unknown): string {
  const label = TICKET_STATUSES.find((label) => label === value);
  return label ?? invalid('status');
}
function directoryExists(path: string): boolean {
  const st = fs.lstatSync(path, { throwIfNoEntry: false });
  if (st && !st.isDirectory()) throw new Error(`not a directory: ${path}`);
  return !!st;
}
const list = (dir: string) =>
  directoryExists(dir) && directoryExists(join(dir, 'issues'))
    ? fs.readdirSync(join(dir, 'issues'), { withFileTypes: true }).flatMap((entry) => {
        const match = /^(\d+)-.+\.md$/.exec(entry.name);
        return match && entry.isFile() ? [{ number: Number(match[1]), path: join(dir, 'issues', entry.name) }] : [];
      })
    : [];

function namedTicketPath(root: string, ticket: unknown): string | undefined {
  if (typeof ticket !== 'string') return;
  const match = /^([a-z0-9][a-z0-9_-]*)\/(\d+)$/.exec(ticket);
  if (!match) return;
  const scratch = join(root, '.scratch');
  if (!directoryExists(scratch)) return;
  const matches = list(join(scratch, match[1])).filter(item => item.number === Number(match[2]));
  if (matches.length === 1) return matches[0].path;
}

/** Outbound routing input: only the named local ticket, never the rest of the board. */
export function routingTicketText(root: string, ticket: unknown): string | undefined {
  try {
    const path = namedTicketPath(root, ticket);
    if (path) return readFileBounded(path, 4096).bytes.toString('utf8').slice(0, 4000);
  } catch { /* Missing or unreadable ticket contributes no text. */ }
}

// Shared metadata lines may use ·, but the ticket title and prose aren't fields.
const objectiveField = /^([ \t]*(?:\*\*[^:\r\n]+:\*\*[^·\r\n]*·[ \t]*)*?\*\*Objective:\*\*[ \t]*)([^·\r\n]*?)([ \t]*)(?=·|\r?$)/im;
const ticketHeader = (text: string) => text.split(/^(?:[ \t]*\*\*What to build:\*\*|##(?:[ \t]|\r?$))/im, 1)[0];

export function ticketObjectiveId(path: string) {
  const { bytes, truncated } = readFileBounded(path, STATE_BYTES);
  if (truncated) throw Error('Ticket exceeds the Objective attribution limit');
  return objectiveField.exec(ticketHeader(bytes.toString('utf8')))?.[2];
}

/** An unreadable, missing or unresolvable header is not evidence of attribution. */
export function ticketObjective(cwd: string, ticket: unknown, shared: string) {
  try {
    const path = namedTicketPath(cwd, ticket);
    if (!path) return;
    const id = ticketObjectiveId(path);
    if (!id) return;
    const checkout = projectRoot(cwd);
    const record = readObjectives(checkout) ?? (checkout !== shared ? readObjectives(shared) : undefined);
    return objectiveLink(record?.objectives.find(item => item.id === id));
  } catch { /* No attribution. */ }
}

export function readyTickets(cwd: string, jobs: JobIndexCache, home?: string) {
  return { ok: true, tickets: ticketReadiness(cwd, jobs, undefined, { home }).tickets.map(({ ticket, path, title, what }) => ({ ticket, path, title, what })) };
}

export interface TicketGap {
  ticket: string;
  path: string;
  gaps: string[];
}

const liveTryField = /(?:^|·)[ \t]*(?:\*\*)?(?:Live try|How to try|Try)(?::\*\*|\*\*:|:)[ \t]*\S/im;
const liveTryHeading = /^##[ \t]+(?:Live try|How to try|Try)\b[^\r\n]*\r?\n(?:[ \t]*\r?\n)*[ \t]*\S/im;
const approvedRemovalsField = /(?:^|·)[ \t]*\*\*Approved removals:\*\*/im;

export function parseRemovalList(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed || /^none\.?$/i.test(trimmed)) return [];
  return trimmed.split(/[,;]+/).map(s => s.trim().replace(/\.+$/, '').replace(/\s+/g, ' ').toLowerCase()).filter(Boolean);
}

export function ticketApprovedRemovals(path: string): string[] {
  try {
    const { bytes, truncated } = readFileBounded(path, STATE_BYTES);
    if (truncated) return [];
    return parseRemovalList(ticketFileEvidence(bytes.toString('utf8')).approvedRemovals);
  } catch {
    return [];
  }
}

function validateTicketBody(
  feature: string,
  ticket: string,
  path: string,
  text: string,
  knownIn: (slug: string) => Set<number>,
): TicketGap | null {
  const body = text.split(/^## Comments[ \t]*\r?$/m, 1)[0];
  const { status, blocked, approvedRemovals, items } = ticketFileEvidence(text);
  if (!status || !/^ready-for-agent$/i.test(status)) return null;
  const gaps: string[] = [];
  const what = body.match(/^(?:\*\*What to build:\*\*|## What to build\b)[ \t]*(?:\r?\n[ \t]*)*([^\r\n]*)/mi)?.[1]
    ?.replace(/\s+/g, ' ').trim() ?? '';
  if (!what) gaps.push('missing goal (What to build)');
  if (items.length === 0) gaps.push('missing acceptance items');
  if (blocked === undefined || !blocked.trim()) {
    gaps.push('missing Blocked by');
  } else if (!/^none\b/i.test(blocked.trim())) {
    const parts = blocked.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
    if (!parts.length) gaps.push('invalid Blocked by');
    for (const raw of parts) {
      const clean = raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
      const cross = /^([a-z0-9-]+)\/(\d+)$/i.exec(clean);
      if (cross) {
        const slug = cross[1].toLowerCase(), n = Number(cross[2]);
        if (!knownIn(slug).has(n)) gaps.push(`unknown blocked_by ticket: ${clean}`);
      } else {
        const local = /^#?(\d+)$/.exec(clean);
        if (!local || !knownIn(feature).has(Number(local[1]))) gaps.push(`unknown blocked_by ticket: ${clean}`);
      }
    }
  }
  if (!liveTryField.test(body) && !liveTryHeading.test(body)) {
    gaps.push('missing Live try (add how to try or Live try: none)');
  }
  if (approvedRemovalsField.test(body) && !approvedRemovals) {
    gaps.push('empty Approved removals (list removals or Approved removals: none)');
  }
  return gaps.length ? { ticket, path, gaps } : null;
}

/** Deterministic pre-start check: every ready-for-agent ticket needs a goal (What to build),
 * acceptance items, valid Blocked by references, a Live try / How to try line (or Live try: none),
 * and non-empty Approved removals if declared. */
export function checkFeatureTickets(cwd: string, feature: string, only?: string): TicketGap[] {
  const scratch = join(cwd, '.scratch');
  if (!directoryExists(scratch)) return [];
  const featureTickets = list(join(scratch, feature)).sort((a, b) => a.number - b.number);
  const byFeature = new Map<string, Set<number>>();
  byFeature.set(feature, new Set(featureTickets.map(t => t.number)));
  const knownIn = (slug: string) => {
    let set = byFeature.get(slug);
    if (!set) {
      set = new Set(list(join(scratch, slug)).map(t => t.number));
      byFeature.set(slug, set);
    }
    return set;
  };
  const results: TicketGap[] = [];
  for (const { number: num, path } of featureTickets) {
    const ticket = `${feature}/${nn(num)}`;
    if (only && ticket !== only) continue;
    const { bytes, truncated } = readFileBounded(path, STATE_BYTES);
    if (truncated) continue;
    const gap = validateTicketBody(feature, ticket, path, bytes.toString('utf8'), knownIn);
    if (gap) results.push(gap);
  }
  return results;
}

export function checkTicketPaths(cwd: string, items: readonly { ticket: string; path: string }[]): TicketGap[] {
  const scratch = join(cwd, '.scratch');
  if (!directoryExists(scratch)) return [];
  const byFeature = new Map<string, Set<number>>();
  const knownIn = (slug: string) => {
    let set = byFeature.get(slug);
    if (!set) {
      set = new Set(list(join(scratch, slug)).map(t => t.number));
      byFeature.set(slug, set);
    }
    return set;
  };
  const results: TicketGap[] = [];
  for (const { ticket, path } of items) {
    const feature = ticket.split('/')[0];
    if (!feature) continue;
    try {
      const { bytes, truncated } = readFileBounded(path, STATE_BYTES);
      if (truncated) continue;
      const gap = validateTicketBody(feature, ticket, path, bytes.toString('utf8'), knownIn);
      if (gap) results.push(gap);
    } catch { /* Missing ticket will not be admitted. */ }
  }
  return results;
}

interface ParsedTicketMemo {
  stamp: string;
  ticket: (ProjectTicket & { what: string; objective?: string }) | null;
}
const parsedTicketMemo = new Map<string, ParsedTicketMemo>();

function parseTicketForReadiness(path: string, num: number): (ProjectTicket & { what: string; objective?: string }) | null {
  const st = fs.lstatSync(path, { throwIfNoEntry: false });
  if (!st || !st.isFile()) { parsedTicketMemo.delete(path); return null; }
  const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${num}`;
  const hit = parsedTicketMemo.get(path);
  if (hit?.stamp === stamp) {
    return hit.ticket ? { ...hit.ticket, blockers: [...hit.ticket.blockers] } : null;
  }
  const { bytes, truncated } = readFileBounded(path, STATE_BYTES);
  let parsed: (ProjectTicket & { what: string; objective?: string }) | null = null;
  if (!truncated) {
    const text = bytes.toString('utf8');
    const body = text.split(/^## Comments[ \t]*\r?$/m, 1)[0];
    const heading = ticketHeading(body, num);
    const { status, blocked, items, checked, landed } = ticketFileEvidence(text);
    if (heading && status && blocked !== undefined) {
      const what = body.match(/^(?:\*\*What to build:\*\*|## What to build\b)[ \t]*(?:\r?\n[ \t]*)*([^\r\n]*)/mi)?.[1]
        ?.replace(/\s+/g, ' ').trim() ?? '';
      const objective = objectiveField.exec(ticketHeader(text))?.[2]?.trim() || undefined;
      parsed = { ...heading, path, what, ...(objective && { objective }), status, at: 0, items, checked,
        total: items.length, blockers: /^none\b/i.test(blocked) ? [] : [blocked],
        state: landed ?? (/^ready-for-human$/i.test(status) ? 'try' : 'ready') };
    }
  }
  parsedTicketMemo.delete(path);
  if (parsedTicketMemo.size >= 512) parsedTicketMemo.delete(parsedTicketMemo.keys().next().value!);
  parsedTicketMemo.set(path, { stamp, ticket: parsed });
  return parsed ? { ...parsed, blockers: [...parsed.blockers] } : null;
}

export interface ReadinessOptions {
  home?: string;
  excludeTickets?: ReadonlySet<string>;
}

export function ticketReadiness(cwd: string, jobs: JobIndexCache, feature?: string, options?: ReadinessOptions) {
  const scratch = join(cwd, '.scratch');
  if (!directoryExists(scratch)) return { tickets: [], queued: [], blocked: [] };
  const features = fs.readdirSync(scratch, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name)).map(({ name: slug }) => ({ slug, at: 0,
      tickets: list(join(scratch, slug)).sort((a, b) => a.number - b.number).flatMap(({ number: num, path }) => {
        const ticket = parseTicketForReadiness(path, num);
        return ticket ? [ticket] : [];
      }),
    }));
  const rollup = new TicketRollup(features), matches = projectJobFilter(cwd);
  for (const id of jobs.listJobIds({ onError: error => { throw error; } })) {
    const receipt = jobs.readJob<Job>(id);
    if (receipt.status !== 'ok' || !receipt.value.ticket || receipt.value.reaped_at || !matches(receipt.value)) continue;
    const job = receipt.value, status = jobs.readStatus(id);
    const state = ticketJobState(job, status.status === 'ok' ? status.value : {});
    if (!SETTLED_JOB_STATES.has(state)) rollup.link({ ticket: job.ticket, package: job.package }, '',
      { role: job.role, state, created: Date.parse(job.created_at) || 0 });
  }
  const home = options?.home ?? getHudHome();
  const root = sharedRoot(cwd);
  const blockedSet = new Set<string>();
  for (const hold of readOpenHolds(home, root)) {
    if (hold.ticket) blockedSet.add(targetKey(hold.ticket));
  }
  if (options?.excludeTickets) {
    for (const ticket of options.excludeTickets) blockedSet.add(targetKey(ticket));
  }
  const { crossBlockers, missingCrossBlockers } = rollup.derive(
    Date.now(), undefined, undefined, undefined, blockedSet.size ? blockedSet : undefined,
  );
  const candidates = features.filter(({ slug }) => feature === undefined || slug === feature).flatMap(({ slug, tickets }) => tickets.flatMap(t =>
    /^ready-for-agent$/i.test(t.status) ? [{ t, ticket: `${slug}/${nn(Number(t.number))}` }] : []));
  if (feature !== undefined) for (const { t, ticket } of candidates) {
    const missing = missingCrossBlockers.get(t);
    if (missing) throw Error(`${ticket}: unknown blocked_by ticket: ${missing}`);
  }
  return {
    tickets: candidates.flatMap(({ t, ticket }) => t.state === 'ready'
      ? [{ ticket, path: t.path, title: t.title, what: t.what, ...(t.objective && { objective: t.objective }) }] : []),
    queued: candidates.flatMap(({ t, ticket }) => {
      const blockers = crossBlockers.get(t);
      return t.state === 'queued' && blockers ? [{ ticket, blockers }] : [];
    }),
    blocked: candidates.flatMap(({ t, ticket }) =>
      t.state === 'blocked' && t.blockers.length ? [{ ticket, blockers: t.blockers }] : []),
  };
}

function ownerTry(value: unknown): 'yes' | 'no' {
  if (typeof value !== 'boolean') return invalid('owner_try');
  return value ? 'yes' : 'no';
}
function withStatus(body: string, label: string, ticket: number): string {
  const field = /((?:^|·)[ \t]*\*\*Status:\*\*[ \t]*)([^·\r\n]*?)([ \t]*)(?=·|\r?$)/im;
  if (!field.test(body)) throw new Error(`missing Status field in ticket: ${ticket}`);
  return body.replace(field, (_, prefix, _old, suffix) => `${prefix}${label}${suffix}`);
}
function headerField(body: string, field: RegExp, label: string, value: string, ticket: number): string {
  if (field.test(body)) return body.replace(field, (_, prefix, _old, suffix) => `${prefix}${value}${suffix}`);
  const statusLine = /^[^\r\n]*\*\*Status:\*\*[^\r\n]*$/im;
  if (!statusLine.test(body)) throw new Error(`missing Status field in ticket: ${ticket}`);
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  return body.replace(statusLine, (line) => `${line}${eol}**${label}:** ${value}`);
}
function withOwnerTry(body: string, value: 'yes' | 'no', ticket: number): string {
  const field = /((?:^|·)[ \t]*\*\*Owner try:\*\*[ \t]*)([^·\r\n]*?)([ \t]*)(?=·|\r?$)/im;
  return headerField(body, field, 'Owner try', value, ticket);
}
function withObjective(body: string, id: string, ticket: number): string {
  const header = ticketHeader(body);
  return headerField(header, objectiveField, 'Objective', id, ticket) + body.slice(header.length);
}

/** Acceptance is the checklist before Comments; checkboxes in discussion aren't acceptance. */
export function landedTicket(original: string, ticket: number, comment: string) {
  const start = original.search(/^## Comments[ \t]*\r?$/m);
  const before = start < 0 ? original : original.slice(0, start);
  const needsTry = /(?:^|·)[ \t]*\*\*Owner try:\*\*[ \t]*yes[ \t]*(?=·|\r?$)/im.test(before);
  const body = withStatus(before, needsTry ? 'ready-for-human' : 'done', ticket)
    .replace(/^([ \t]*[-*] \[) \]/gm, '$1x]');
  return (body + (start < 0 ? '\n## Comments' : original.slice(start))).trimEnd() + `\n\n- ${comment}\n`;
}

/** Record durable unattended lead acceptance on a landed ticket: status done + run/verdict comment. */
export function recordUnattendedAcceptance(root: string, ticketPath: string, ticketRef: string, flowId: string, verdict: string): boolean {
  const scratch = join(root, '.scratch');
  if (!directoryExists(scratch)) return false;
  const rel = relative(resolve(scratch), resolve(ticketPath));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
  scanScratch(scratch, true);
  const st = fs.lstatSync(ticketPath, { throwIfNoEntry: false });
  if (!st || !st.isFile() || fs.realpathSync(ticketPath) !== resolve(ticketPath)) return false;
  const original = fs.readFileSync(ticketPath, 'utf8');
  const marker = `- Accepted by unattended lead (${flowId}):`;
  if (original.includes(marker)) return false;
  const start = original.search(/^## Comments[ \t]*\r?$/m);
  const before = start < 0 ? original : original.slice(0, start);
  const num = Number(ticketRef.split('/')[1] ?? 0);
  const currentStatus = ticketFileEvidence(original).status ?? '';
  const body = /^wontfix$/i.test(currentStatus) ? before : withStatus(before, 'done', num);
  const summary = verdict.replace(/\s+/g, ' ').trim().slice(0, 400);
  const updated = (body + (start < 0 ? '\n## Comments' : original.slice(start))).trimEnd() + `\n\n${marker} ${summary}\n`;
  writeFileAtomic(ticketPath, updated, st.mode & 0o777);
  return true;
}

/** The panel groups work by an Objective's Features; no record, no warning. */
function unlinkedWarning(root: string, feature: string): string | undefined {
  const objectives = readObjectives(root)?.objectives;
  if (!objectives || objectives.some(({ features }) => features.includes(feature))) return;
  return `feature "${feature}" is in no Objective's Features, so the panel shows it as unlinked. Objective IDs: ${
    objectives.map(({ id }) => id).join(', ') || 'none'}. List it with hud_objective (op: set, features: the whole list); op: add with objective does this itself.`;
}

export async function editTickets(cwd: string, args: Record<string, unknown>, home: string) {
  const { op, feature } = args;
  if (op === 'sync') {
    const output: string[] = [];
    const capture = (text: string) => {
      output.push(...text.trimEnd().split(/\r?\n/));
    };
    await ticketsCommand(['sync', '--cwd', cwd], { env: process.env, stdout: capture, stderr: capture });
    return { ok: true, output };
  }
  if (op !== 'add' && op !== 'update') return invalid('op');
  const scratch = join(cwd, '.scratch');
  scanScratch(scratch, true);
  let objectiveIds: Set<string> | undefined;
  const objectiveId = (value: unknown) => {
    if (typeof value !== 'string' || !new RegExp(OBJECTIVE_SLUG).test(value)) return invalid('objective');
    objectiveIds ??= new Set(readObjectives(sharedRoot(cwd))?.objectives.map(({ id }) => id));
    if (!objectiveIds.has(value)) throw new Error(`unknown objective: ${value}`);
    return value;
  };
  const resolveBlockers = (value: unknown, feat: string, known: Set<number>) => {
    if (!Array.isArray(value)) return invalid('blocked_by');
    const refs = value.map(ref => {
      const match = typeof ref === 'string' && /^([a-z0-9-]+)\/(\d+)$/.exec(ref);
      const n = match ? Number(match[2]) : ref;
      if (!number(n)) return invalid('blocked_by');
      const exists = match && match[1] !== feat ? list(join(scratch, match[1])).some(t => t.number === n) : known.has(n);
      if (!exists) throw new Error(`unknown blocked_by ticket: ${ref}`);
      return match ? `${match[1]}/${nn(n)}` : nn(n);
    });
    return refs.join(', ') || 'none';
  };
  if (op === 'add') {
    if (args.updates !== undefined) return invalid('updates');
    if (typeof feature !== 'string' || !/^[a-z0-9-]+$/.test(feature)) return invalid('feature');
    const featureDir = join(scratch, feature),
      issues = join(featureDir, 'issues');
    const existing = list(featureDir);
    const known = new Set(existing.map(t => t.number));
    if (!Array.isArray(args.tickets) || !args.tickets.length) return invalid('tickets');
    const shared = args.objective === undefined ? undefined : objectiveId(args.objective);
    let next = existing.reduce((max, ticket) => Math.max(max, ticket.number), 0);
    // Plan the entire batch before making directories or writing any ticket.
    const plans = args.tickets.map((ticket: Record<string, unknown>) => {
      if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) return invalid('tickets');
      if (!number(++next)) throw new Error('ticket numbering exhausted');
      const title = line(ticket.title, 'title'),
        what = line(ticket.what, 'what');
      const label = ticket.status === undefined ? 'ready-for-agent' : status(ticket.status);
      const tryLine = ticket.owner_try === undefined ? [] : [`**Owner try:** ${ownerTry(ticket.owner_try)}`];
      const liveTryLine = ticket.live_try === undefined ? [] : [`**Live try:** ${line(ticket.live_try, 'live_try')}`];
      const approvedRemovalsLine = ticket.approved_removals === undefined ? [] : [`**Approved removals:** ${line(ticket.approved_removals, 'approved_removals')}`];
      const blocked = resolveBlockers(ticket.blocked_by, feature, known);
      if (!Array.isArray(ticket.acceptance)) return invalid('acceptance');
      const items = ticket.acceptance.map((item) => `- [ ] ${line(item, 'acceptance')}`);
      const objective = ticket.objective === undefined ? shared : objectiveId(ticket.objective);
      const body = [
        `# ${nn(next)}: ${title}`,
        '',
        `**Status:** ${label}`,
        ...tryLine,
        ...liveTryLine,
        ...approvedRemovalsLine,
        `**Blocked by:** ${blocked}`,
        ...(objective === undefined ? [] : [`**Objective:** ${objective}`]),
        '',
        `**What to build:** ${what}`,
        '',
        ...items,
        ...(items.length ? [''] : []),
        '## Comments',
        '',
      ].join('\n');
      known.add(next);
      return { number: next, path: join(issues, `${nn(next)}-${slugify(title, next)}.md`), body, objective };
    });
    // Link first: if the record cannot be edited, no ticket is written.
    const linked = [...new Set(plans.flatMap(({ objective }) => objective ?? []))];
    if (linked.length) await linkFeature(sharedRoot(cwd), home, linked, feature);
    fs.mkdirSync(issues, { recursive: true });
    const tickets = plans.map(({ number, path, body }) => {
      fs.writeFileSync(path, body, { flag: 'wx' });
      return { number, path };
    });
    const warning = unlinkedWarning(sharedRoot(cwd), feature);
    return { ok: true, tickets, ...(warning && { warning }) };
  }

  const updateOne = (feat: unknown, item: Record<string, unknown>) => {
    if (typeof feat !== 'string' || !/^[a-z0-9-]+$/.test(feat)) return invalid('feature');
    if (!number(item.ticket)) return invalid('ticket');
    if (item.status === undefined && item.tick === undefined && item.blocked_by === undefined && item.owner_try === undefined && item.objective === undefined)
      return invalid('status, tick, blocked_by, owner_try or objective');
    const existing = list(join(scratch, feat));
    const known = new Set(existing.map(t => t.number));
    const matches = existing.filter(({ number }) => number === item.ticket);
    if (!matches.length) throw new Error(`unknown ticket: ${item.ticket}`);
    if (matches.length > 1) throw new Error(`ambiguous ticket: ${item.ticket}`);
    const [ticket] = matches;
    const original = fs.readFileSync(ticket.path, 'utf8');
    const comments = original.search(/^## Comments[ \t]*\r?$/m);
    let body = comments < 0 ? original : original.slice(0, comments);
    if (item.tick !== undefined) {
      if (!Array.isArray(item.tick) || !item.tick.every(Number.isSafeInteger)) return invalid('tick');
      const box = /^([ \t]*[-*] \[)([ xX])\]/gm;
      const count = body.match(box)?.length ?? 0;
      const unknown = item.tick.find(n => n < 1 || n > count);
      if (unknown !== undefined) {
        throw new Error(`unknown acceptance item: ${unknown} (${count ? `valid range: 1-${count}` : 'no acceptance items'})`);
      }
      const tick = new Set(item.tick);
      let index = 0;
      body = body.replace(box, (match, prefix, mark) => tick.has(++index) && mark === ' ' ? `${prefix}x]` : match);
    }
    if (item.status !== undefined) body = withStatus(body, status(item.status), item.ticket);
    if (item.owner_try !== undefined) body = withOwnerTry(body, ownerTry(item.owner_try), item.ticket);
    if (item.blocked_by !== undefined) {
      const field = /((?:^|·)[ \t]*\*\*Blocked by:\*\*[ \t]*)([^·\r\n]*?)([ \t]*)(?=·|\r?$)/im;
      if (!field.test(body)) throw new Error(`missing Blocked by field in ticket: ${item.ticket}`);
      const refs = resolveBlockers(item.blocked_by, feat, known);
      body = body.replace(field, (_, prefix, _old, suffix) => `${prefix}${refs}${suffix}`);
    }
    if (item.objective !== undefined) body = withObjective(body, objectiveId(item.objective), item.ticket);
    const updated = body + (comments < 0 ? '' : original.slice(comments));
    if (updated !== original) writeFileAtomic(ticket.path, updated, fs.statSync(ticket.path).mode & 0o777);
    return { ok: true, ...ticket };
  };

  if (args.updates !== undefined) {
    if (args.ticket !== undefined || args.status !== undefined || args.tick !== undefined || args.blocked_by !== undefined || args.owner_try !== undefined || args.objective !== undefined)
      return invalid('updates');
    if (!Array.isArray(args.updates) || !args.updates.length) return invalid('updates');
    if (feature !== undefined && (typeof feature !== 'string' || !/^[a-z0-9-]+$/.test(feature))) return invalid('feature');
    const updates = args.updates.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, code: 'invalid_arguments', error: 'invalid_arguments: updates' };
      }
      const item = raw as Record<string, unknown>;
      const feat = item.feature ?? feature;
      try {
        return { feature: feat as string, ...updateOne(feat, item) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ...(typeof feat === 'string' ? { feature: feat } : {}),
          ...(number(item.ticket) ? { ticket: item.ticket } : {}),
          ok: false,
          code: message.startsWith('invalid_arguments') ? 'invalid_arguments' : 'tool_error',
          error: message,
        };
      }
    });
    return { updates };
  }

  return updateOne(feature, args);
}
