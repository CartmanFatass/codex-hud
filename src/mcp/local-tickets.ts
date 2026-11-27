import * as fs from 'node:fs';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { scanScratch, slugify, ticketsCommand } from '../cli/tickets.js';
import { OBJECTIVE_SLUG, objectiveLink, readObjectives, type Objective } from '../collectors/objectives.js';
import type { ProjectTicket } from '../collectors/project-board.js';
import { STATE_BYTES } from '../collectors/state-ledger.js';
import { targetKey, ticketFileEvidence, ticketHeading } from '../collectors/ticket-evidence.js';
import { SETTLED_JOB_STATES, TicketRollup, ticketJobState } from '../collectors/ticket-rollup.js';
import { getHudHome } from '../hud-home.js';
import type { JobIndexCache } from '../roles/job-index-cache.js';
import { projectJobFilter } from '../roles/job-project.js';
import { localProjectRoots, projectList, projectRoot, sharedRoot } from '../roles/projects.js';
import {
  canonicalTicketRef, legacyTicketRepo, LEGACY_TICKET_HEADER_END, normalizeHomePaths, parseMarkdownRepairRefs, parseTicketRef, readJsonTicketFeature,
  renderTicketBrief, splitRemovals, storedTicket, ticketFeaturePath, ticketFeatureSlugs, TICKET_STATUSES, withTicketStoreLock,
  writeLegacyTicket, writeTicketFeature, type AcceptanceItem, type TicketFeatureDoc, type TicketRecord,
} from '../tickets/store.js';
import { commitTicketWrites } from '../tickets/commit.js';
import { readOpenHolds } from '../unattended/state.js';
import { readFileBounded } from '../utils/atomic-fs.js';
import { isRunningListTicket, readFlakesConfig, runningListAdmission } from './flake-admission.js';
import type { Job } from './job-contracts.js';
import { linkFeature } from './local-objectives.js';

export type TicketEdit = { ticket: string; path: string; before?: string; after: string; mode?: number };
export type TicketEdits = {
  read(path: string): string;
  stage(edit: TicketEdit): Promise<void>;
};

const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nn = (value: number) => String(value).padStart(2, '0');
function invalid(field: string): never {
  throw new Error(`invalid_arguments: ${field}`);
}
function line(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) return invalid(field);
  return normalizeHomePaths(value.replace(/\s+/g, ' ').trim());
}
const ownLiveTryLine = /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?Live try(?::\*\*|\*\*:|:(?!\*\*))[ \t]*(.+?)[ \t]*$/i;
const inlineBoldLiveTry = /(?:^|[\s·])\*\*Live try(?::\*\*|\*\*:)[ \t]*(.+?)[ \t]*$/i;
const inlineAfterPunctLiveTry = /([.;!?]|·)[ \t]+Live try:[ \t]*(.+?)[ \t]*$/i;

export function extractWhatAndLiveTry(rawWhat: unknown, rawLiveTry: unknown): { what: string; liveTry?: string } {
  if (typeof rawWhat !== 'string' || !rawWhat.trim()) return invalid('what');
  const what = normalizeHomePaths(rawWhat.trim());
  if (rawLiveTry !== undefined) return { what, liveTry: line(rawLiveTry, 'live_try') };
  const rawLines = what.split(/\r?\n/);
  let extracted: string | undefined;
  const kept: string[] = [];
  for (const rawLine of rawLines) {
    const match = !extracted ? ownLiveTryLine.exec(rawLine) : null;
    if (match?.[1]?.trim()) {
      extracted = match[1].replace(/\s+/g, ' ').trim();
    } else {
      kept.push(rawLine);
    }
  }
  if (extracted) {
    return { what: kept.join('\n').trim() || invalid('what'), liveTry: extracted };
  }
  const boldMatch = inlineBoldLiveTry.exec(what);
  if (boldMatch?.[1]?.trim()) {
    const rest = what.slice(0, boldMatch.index).replace(/[\s·]+$/, '');
    return { what: rest || invalid('what'), liveTry: line(boldMatch[1], 'live_try') };
  }
  const punctMatch = inlineAfterPunctLiveTry.exec(what);
  if (punctMatch?.[2]?.trim()) {
    const prefix = punctMatch[1] === '·' ? '' : punctMatch[1];
    const rest = (what.slice(0, punctMatch.index) + prefix).replace(/[\s·]+$/, '');
    return { what: rest || invalid('what'), liveTry: line(punctMatch[2], 'live_try') };
  }
  return { what };
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

export function repoFieldValue(value: unknown): string {
  if (typeof value !== 'string' || /[\0\r\n·]/.test(value) || !isAbsolute(value.trim())) return invalid('repo (expected an absolute project root)');
  return value.trim();
}

/** Exact, available registration: neither a child directory nor a linked worktree is a target root. */
export function registeredTicketRepo(home: string, repo: string): string | undefined {
  if (!isAbsolute(repo)) return;
  try {
    const real = fs.realpathSync(repo);
    if (localProjectRoots(real).mainRoot === real && projectList(home, real).some(p => p.root === real && !p.unavailable)) return real;
  } catch { /* Missing or unavailable root. */ }
}

export const unregisteredRepoReason = (repo: string) => `repo ${JSON.stringify(repo)} is not a registered project root`;

export function ticketBrief(cwd: string, ticket: unknown, legacy: boolean, target?: { home: string; root: string }) {
  const matches = (repo?: string) => !target || (repo && registeredTicketRepo(target.home, repo) === target.root);
  const { mainRoot, checkout } = localProjectRoots(cwd);
  const stored = storedTicket(mainRoot, ticket);
  if (stored) return stored.record ? (matches(stored.record.repo) ? renderTicketBrief(stored.record, stored.doc) : undefined) : null;
  if (!legacy) return;
  const path = namedTicketPath(checkout, ticket) ?? (checkout !== mainRoot ? namedTicketPath(mainRoot, ticket) : undefined);
  if (!path) return;
  const { bytes, truncated } = readFileBounded(path, STATE_BYTES);
  if (truncated) throw Error('Ticket brief exceeds 64 KiB');
  const brief = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return matches(target ? legacyTicketRepo(brief) : undefined) ? brief : undefined;
}

/** Outbound routing input: only the named local ticket, never the rest of the board. */
export function routingTicketText(root: string, ticket: unknown): string | undefined {
  try {
    const stored = storedTicket(root, ticket);
    if (stored) return stored.record && Buffer.from(renderTicketBrief(stored.record, stored.doc)).subarray(0, 4096).toString('utf8').slice(0, 4000);
    const path = namedTicketPath(root, ticket);
    if (path) return readFileBounded(path, 4096).bytes.toString('utf8').slice(0, 4000);
  } catch { /* Missing or unreadable ticket contributes no text. */ }
}

// Shared metadata lines may use ·, but the ticket title and prose aren't fields.
const objectiveField = /^([ \t]*(?:\*\*[^:\r\n]+:\*\*[^·\r\n]*·[ \t]*)*?\*\*Objective:\*\*[ \t]*)([^·\r\n]*?)([ \t]*)(?=·|\r?$)/im;
const repairsField = /^([ \t]*(?:\*\*[^:\r\n]+:\*\*[^·\r\n]*·[ \t]*)*?\*\*Repairs:\*\*[ \t]*)([^·\r\n]*?)([ \t]*)(?=·|\r?$)/im;
const ticketHeader = (text: string) => text.split(LEGACY_TICKET_HEADER_END, 1)[0];

export function ticketObjectiveId(path: string) {
  const { bytes, truncated } = readFileBounded(path, STATE_BYTES);
  if (truncated) throw Error('Ticket exceeds the Objective attribution limit');
  return objectiveField.exec(ticketHeader(bytes.toString('utf8')))?.[2];
}

/** An unreadable, missing or unresolvable header is not evidence of attribution. */
export function ticketObjective(cwd: string, ticket: unknown, shared: string) {
  try {
    const checkout = projectRoot(cwd);
    const stored = storedTicket(shared, ticket);
    const path = stored ? undefined : namedTicketPath(checkout, ticket) ?? namedTicketPath(shared, ticket);
    const id = stored?.record ? stored.record.objective ?? stored.doc.objective : path ? ticketObjectiveId(path) : undefined;
    if (!id) return;
    const record = readObjectives(checkout) ?? (checkout !== shared ? readObjectives(shared) : undefined);
    return objectiveLink(record?.objectives.find(item => item.id === id));
  } catch { /* No attribution. */ }
}

/** Explicit attribution wins; otherwise the feature must have exactly one Objective. */
export function ticketObjectiveOwner(objectives: readonly Objective[], ticket: string, declared?: string) {
  const feature = ticket.split('/')[0];
  if (!/^[a-z0-9-]+$/.test(feature)) return undefined;
  if (declared) return declared;
  const linked = objectives.filter(o => o.features.includes(feature));
  return linked.length === 1 ? linked[0].id : undefined;
}

export interface UnreadableTicketFeature {
  feature: string;
  path: string;
  error: string;
}

export function readyTickets(cwd: string, jobs: JobIndexCache, home?: string) {
  const { tickets, blocked, unreadable } = ticketReadiness(cwd, jobs, undefined, { home });
  return {
    ok: true,
    tickets: tickets.map(({ ticket, path, title, what, repo }) => ({ ticket, path, title, what, ...(repo && { repo }) })),
    ...(blocked.length && { blocked }),
    ...(unreadable?.length && { partial: true as const, unreadable }),
  };
}

export interface TicketGap {
  ticket: string;
  path: string;
  gaps: string[];
}

const liveTryField = /(?:^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+(?:\[[ x]\][ \t]+)?)?|·[ \t]*)(?:\*\*)?(?:Live try|How to try|Try)(?::\*\*|\*\*:|:(?!\*\*))[ \t]*[^\s·]/im;
const liveTryHeading = /^##[ \t]+(?:Live try|How to try|Try)\b[^\r\n]*\r?\n(?:[ \t]*\r?\n)*[ \t]*\S/im;
const approvedRemovalsField = /(?:^|·)[ \t]*\*\*Approved removals:\*\*/im;

export const parseRemovalList = splitRemovals;

export function ticketApprovedRemovals(path: string, root: string, ticket: string): string[] {
  try {
    const stored = storedTicket(root, ticket);
    if (stored) return (stored.record?.approved_removals ?? []).flatMap(splitRemovals);
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
    gaps.push('missing Live try (add how to try or `**Live try:** none`)');
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
  const doc = readJsonTicketFeature(cwd, feature);
  if (doc) return checkTicketPaths(cwd, doc.tickets.map(t => ({ ticket: `${feature}/${nn(t.number)}`, path: ticketFeaturePath(cwd, feature) }))
    .filter(item => !only || item.ticket === only));
  const scratch = join(cwd, '.scratch');
  if (!directoryExists(scratch)) return [];
  const featureTickets = list(join(scratch, feature)).sort((a, b) => a.number - b.number);
  const byFeature = new Map<string, Set<number>>();
  byFeature.set(feature, new Set(featureTickets.map(t => t.number)));
  const knownIn = (slug: string) => {
    let set = byFeature.get(slug);
    if (!set) {
      set = new Set((readJsonTicketFeature(cwd, slug)?.tickets ?? list(join(scratch, slug))).map(t => t.number));
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
  const byFeature = new Map<string, Set<number>>(), docs = new Map<string, TicketFeatureDoc | undefined>();
  const docFor = (slug: string) => {
    if (!docs.has(slug)) docs.set(slug, readJsonTicketFeature(cwd, slug));
    return docs.get(slug);
  };
  const knownIn = (slug: string) => {
    let set = byFeature.get(slug);
    if (!set) {
      set = new Set((docFor(slug)?.tickets ?? list(join(scratch, slug))).map(t => t.number));
      byFeature.set(slug, set);
    }
    return set;
  };
  const results: TicketGap[] = [];
  for (const { ticket, path } of items) {
    const feature = ticket.split('/')[0];
    if (!feature) continue;
    const doc = docFor(feature);
    if (doc) {
      const record = doc.tickets.find(t => t.number === parseTicketRef(ticket)?.number);
      if (record?.status !== 'ready-for-agent') continue;
      const gaps = record.acceptance.length ? [] : ['missing acceptance items'];
      for (const ref of record.blocked_by) {
        const parsed = parseTicketRef(ref)!;
        if (!knownIn(parsed.feature).has(parsed.number)) gaps.push(`unknown blocked_by ticket: ${ref}`);
      }
      if (gaps.length) results.push({ ticket, path, gaps });
    } else try {
      const { bytes, truncated } = readFileBounded(path, STATE_BYTES);
      if (truncated) continue;
      const gap = validateTicketBody(feature, ticket, path, bytes.toString('utf8'), knownIn);
      if (gap) results.push(gap);
    } catch { /* Missing ticket will not be admitted. */ }
  }
  return results;
}

function supersession(body: string, comments: string) {
  const names = (text: string, pattern: RegExp) => Array.from(text.matchAll(pattern), m => targetKey(m[1]));
  return {
    supersedes: names(`${body}\n${comments}`, /\bsupersedes\b[ \t]*:?[ \t`*]*([a-z0-9-]+\/\d+)(?![\w/-])/gi),
    replacedBy: names(comments, /\b(?:superseded by|replaced by|replacement(?=:))[ \t]*:?[ \t`*]*([a-z0-9-]+\/\d+)(?![\w/-])/gi),
  };
}

type LocalTicket = ProjectTicket & ReturnType<typeof supersession> & {
  what: string; objective?: string; role: 'imp' | 'frontend-imp'; runningList: boolean; repairs?: string[]; repo?: string;
};
const FRONTEND_ROLE_RE = /(?:^|·)[ \t]*\*\*(?:Role|Who):\*\*[ \t]*frontend-(?:imp|implementer)(?=[ \t\r\n·(]|$)/im;
const declaredReady = (t: LocalTicket) => /^ready-for-agent$/i.test(t.status);
const readinessRef = (slug: string, t: LocalTicket) => `${slug}/${nn(Number(t.number))}`;
const parsedTicketMemo = new Map<string, { stamp: string; ticket: LocalTicket | null }>();

function parseTicketForReadiness(path: string, num: number, slug: string): LocalTicket | null {
  const st = fs.lstatSync(path, { throwIfNoEntry: false });
  if (!st || !st.isFile()) { parsedTicketMemo.delete(path); return null; }
  const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${num}`;
  const hit = parsedTicketMemo.get(path);
  if (hit?.stamp === stamp) {
    return hit.ticket ? { ...hit.ticket, blockers: [...hit.ticket.blockers], ...(hit.ticket.repairs && { repairs: [...hit.ticket.repairs] }) } : null;
  }
  const { bytes, truncated } = readFileBounded(path, STATE_BYTES);
  let parsed: LocalTicket | null = null;
  if (!truncated) {
    const text = bytes.toString('utf8');
    const [body, comments = ''] = text.split(/^## Comments[ \t]*\r?$/m, 2);
    const heading = ticketHeading(body, num);
    const { status, blocked, repairs: rawRepairs, items, checked, landed } = ticketFileEvidence(text);
    if (heading && status && blocked !== undefined) {
      const what = body.match(/^(?:\*\*What to build:\*\*|## What to build\b)[ \t]*(?:\r?\n[ \t]*)*([^\r\n]*)/mi)?.[1]
        ?.replace(/\s+/g, ' ').trim() ?? '';
      const objective = objectiveField.exec(ticketHeader(text))?.[2]?.trim() || undefined;
      const repo = legacyTicketRepo(text);
      const role = FRONTEND_ROLE_RE.test(body) ? 'frontend-imp' : 'imp';
      const repairs = parseMarkdownRepairRefs(rawRepairs, slug);
      parsed = { ...heading, path, what, role, repo, runningList: isRunningListTicket(body), ...(objective && { objective }),
        ...(repairs.length && { repairs }), status, at: 0, items, checked,
        ...supersession(body, comments.split(/^## /m, 1)[0]),
        total: items.length, blockers: /^none\b/i.test(blocked) ? [] : [blocked],
        state: landed ?? (/^ready-for-human$/i.test(status) ? 'try' : 'ready') };
    }
  }
  parsedTicketMemo.delete(path);
  if (parsedTicketMemo.size >= 512) parsedTicketMemo.delete(parsedTicketMemo.keys().next().value!);
  parsedTicketMemo.set(path, { stamp, ticket: parsed });
  return parsed ? { ...parsed, blockers: [...parsed.blockers], ...(parsed.repairs && { repairs: [...parsed.repairs] }) } : null;
}

function jsonReadiness(root: string, doc: TicketFeatureDoc, record: TicketRecord): LocalTicket {
  const { title, status, acceptance: items } = record;
  const checked = items.filter(item => item.done).length;
  const state = status === 'wontfix' ? 'dropped' : status === 'done' || record.accepted ? 'done'
    : status === 'ready-for-human' ? 'try' : 'ready';
  return { number: nn(record.number), title, status, state, repo: record.repo, path: ticketFeaturePath(root, doc.feature), at: 0,
    what: record.what.trimStart().split(/\r?\n/, 1)[0].replace(/\s+/g, ' ').trim(), role: record.role ?? 'imp', runningList: record.kind === 'flake-list',
    objective: record.objective ?? doc.objective, ...(record.repairs?.length && { repairs: [...record.repairs] }), items, checked, total: items.length,
    ...supersession(`${title}\n${record.what}`, record.comments.map(c => c.text).join('\n')),
    blockers: record.blocked_by.length ? [record.blocked_by.join(', ')] : [] };
}

function readTicketFeatures(root: string, feature?: string) {
  const scratch = join(root, '.scratch');
  return (feature === undefined ? ticketFeatureSlugs(root) : [feature]).map(slug => {
    let json: TicketFeatureDoc | undefined;
    try {
      json = readJsonTicketFeature(root, slug);
    } catch (error) {
      if (feature !== undefined) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return { slug, at: 0, tickets: [] as LocalTicket[], unreadable: message };
    }
    return { slug, at: 0, unreadable: undefined as string | undefined, tickets: json ? json.tickets.map(record => jsonReadiness(root, json, record))
      : directoryExists(scratch) ? list(join(scratch, slug)).sort((a, b) => a.number - b.number).flatMap(({ number: num, path }) => {
        const ticket = parseTicketForReadiness(path, num, slug);
        return ticket ? [ticket] : [];
      }) : [] };
  });
}

/** Start-time workset, before dependency and live-job rollup hides non-dispatchable tickets. */
export function declaredReadyTickets(cwd: string, feature?: string) {
  return readTicketFeatures(cwd, feature).flatMap(({ slug, tickets }) => tickets.filter(t => t.state === 'ready' && declaredReady(t))
    .map(t => ({ ticket: readinessRef(slug, t), role: t.role, objective: t.objective, repo: t.repo })));
}

function ticketReplacements(features: ReturnType<typeof readTicketFeatures>) {
  const replacements = new Map<string, Set<string>>();
  const add = (original: string, replacement: string) => {
    if (original === replacement) return;
    const refs = replacements.get(original) ?? new Set();
    refs.add(replacement);
    replacements.set(original, refs);
  };
  for (const { slug, tickets } of features) for (const t of tickets) {
    const id = targetKey(readinessRef(slug, t));
    for (const ref of t.supersedes) add(ref, id);
    for (const ref of t.replacedBy) add(id, ref);
  }
  return replacements;
}

/** Resolve blockers across ticket features using the same TicketRollup pass as ticketReadiness. */
export function ticketBlockersByKey(cwd: string): Map<string, readonly string[]> {
  const blockers = new Map<string, readonly string[]>();
  const features = readTicketFeatures(cwd);
  new TicketRollup(features).derive(Date.now(), undefined, undefined, { replacements: ticketReplacements(features) });
  for (const { slug, tickets } of features) {
    for (const t of tickets) blockers.set(targetKey(`${slug}/${t.number}`), t.blockers);
  }
  return blockers;
}

export interface ReadinessOptions {
  home?: string;
  excludeTickets?: ReadonlySet<string>;
  landedInRun?: readonly string[];
}

export function ticketReadiness(cwd: string, jobs: JobIndexCache, feature?: string, options?: ReadinessOptions) {
  const { mainRoot: root } = localProjectRoots(cwd);
  const features = readTicketFeatures(root);
  if (!features.length) return { tickets: [], queued: [], blocked: [], future: [] };
  const unreadable: UnreadableTicketFeature[] = features.flatMap(f =>
    f.unreadable ? [{ feature: f.slug, path: ticketFeaturePath(root, f.slug), error: f.unreadable }] : [],
  );
  if (feature !== undefined) {
    const bad = unreadable.find(u => u.feature === feature);
    if (bad) throw Error(bad.error);
  }
  const rollup = new TicketRollup(features), matches = projectJobFilter(root, dir => localProjectRoots(dir).mainRoot);
  for (const id of jobs.listJobIds({ onError: error => { throw error; } })) {
    const receipt = jobs.readJob<Job>(id);
    if (receipt.status !== 'ok' || !receipt.value.ticket || receipt.value.reaped_at ||
        !(receipt.value.ticket_root ? receipt.value.ticket_root === root : matches(receipt.value))) continue;
    const job = receipt.value, status = jobs.readStatus(id);
    const state = ticketJobState(job, status.status === 'ok' ? status.value : {});
    if (!SETTLED_JOB_STATES.has(state)) rollup.link({ ticket: job.ticket, package: job.package }, '',
      { role: job.role, state, created: Date.parse(job.created_at) || 0 });
  }
  const home = options?.home ?? getHudHome();
  const blockedSet = new Set<string>();
  for (const hold of readOpenHolds(home, root)) {
    if (hold.ticket) blockedSet.add(targetKey(hold.ticket));
  }
  if (options?.excludeTickets) {
    for (const ticket of options.excludeTickets) blockedSet.add(targetKey(ticket));
  }
  const { declaredBlockers, crossBlockers, missingCrossBlockers } = rollup.derive(
    Date.now(), undefined, blockedSet.size ? blockedSet : undefined, {
      replacements: ticketReplacements(features),
      landedInRun: options?.landedInRun && new Set(options.landedInRun.map(targetKey)),
    },
  );
  const repos = new Map<string, string | undefined>();
  const candidates = features.filter(({ slug }) => feature === undefined || slug === feature).flatMap(({ slug, tickets }) =>
    tickets.filter(declaredReady).map(t => {
      if (t.repo !== undefined && !repos.has(t.repo)) repos.set(t.repo, registeredTicketRepo(home, t.repo));
      const repo = t.repo === undefined ? undefined : repos.get(t.repo);
      return { t, ticket: readinessRef(slug, t), repo, repoProblem: t.repo !== undefined && !repo ? unregisteredRepoReason(t.repo) : undefined };
    }));
  if (feature !== undefined) for (const { t, ticket } of candidates) {
    const missing = missingCrossBlockers.get(t);
    if (missing) throw Error(`${ticket}: unknown blocked_by ticket: ${missing}`);
  }
  const flakeFeature = readFlakesConfig(root)?.feature;
  let flakes: ReturnType<typeof runningListAdmission> | undefined;
  return {
    tickets: candidates.flatMap(({ t, ticket, repo, repoProblem }) => {
      if (t.state !== 'ready' || repoProblem) return [];
      if (flakeFeature && t.runningList && ticket.startsWith(`${flakeFeature}/`) &&
          !(flakes ??= runningListAdmission(home, root, flakeFeature, jobs)).eligible(ticket)) return [];
      const blockers = declaredBlockers.get(t) ?? [];
      return [{ ticket, path: t.path, title: t.title, what: t.what, role: t.role, blockers, ...(repo && { repo }),
        ...(t.repairs?.length && { repairs: [...t.repairs] }), ...(t.objective && { objective: t.objective }) }];
    }),
    queued: candidates.flatMap(({ t, ticket, repoProblem }) => {
      const blockers = crossBlockers.get(t);
      return t.state === 'queued' && blockers && !repoProblem ? [{ ticket, blockers }] : [];
    }),
    blocked: candidates.flatMap(({ t, ticket, repoProblem }) => {
      if (!['ready', 'queued', 'blocked'].includes(t.state)) return [];
      const blockers = repoProblem ? [repoProblem] : t.state === 'blocked' ? t.blockers : [];
      return blockers.length ? [{ ticket, blockers }] : [];
    }),
    // The display workset includes same-feature waits and other ready tickets that dispatch cannot take yet.
    future: candidates.flatMap(({ t, ticket, repoProblem }) =>
      t.state === 'ready' || t.state === 'queued' || t.state === 'blocked' ? [{
        ticket, title: t.title, role: t.role, blockers: declaredBlockers.get(t) ?? [],
        ...(repoProblem ? { waiting_on: [repoProblem] } : t.blockers.length ? { waiting_on: t.blockers } : {}),
        ...(t.objective && { objective: t.objective }),
      }] : []),
    ...(unreadable.length && { partial: true as const, unreadable }),
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
function withRepairs(body: string, refs: string[], ticket: number): string {
  const header = ticketHeader(body), rest = body.slice(header.length);
  if (refs.length) return headerField(header, repairsField, 'Repairs', refs.join(', '), ticket) + rest;
  const ownLine = /^[ \t]*\*\*Repairs:\*\*[^·\r\n]*\r?\n/im;
  if (ownLine.test(header)) return header.replace(ownLine, '') + rest;
  if (repairsField.test(header)) return header.replace(repairsField, (_, prefix, _old, suffix) => `${prefix}none${suffix}`) + rest;
  return body;
}

const acceptanceName = (text: string) => text.replace(/`|\*\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

export function unfinishedAcceptance(items: readonly AcceptanceItem[], notes: readonly string[]) {
  const ids = new Set<number>();
  const names = notes.map(acceptanceName).filter(note => !/^(?:[-*] )?(?:none|nothing|n\/a)[.!]?$/.test(note));
  for (const note of names) {
    const bare = /^(?:[-*+] (?:\[ \] )?)?(?:#(\d+)(?=[.:\s]|$)|(\d+)(?=:|$))/.exec(note);
    if (bare) ids.add(Number(bare[1] ?? bare[2]));
    for (const match of note.matchAll(/\b(?:acceptance(?:\s+(?:item|criterion))?|item(?:\s+id)?)\s+#?(\d+)\b/g)) ids.add(Number(match[1]));
  }
  return items.flatMap(({ id, done, text }) => {
    if (done) return [];
    const name = acceptanceName(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const phrase = name && new RegExp(`(?<![\\p{L}\\p{N}_])${name}(?![\\p{L}\\p{N}_])`, 'u');
    return ids.has(id) || (phrase && names.some(note => phrase.test(note))) ? [{ id, text }] : [];
  });
}

/** Acceptance is the checklist before Comments; checkboxes in discussion aren't acceptance. */
export function landedTicket(original: string, ticket: number, comment: string, notes: readonly string[]) {
  const start = original.search(/^## Comments[ \t]*\r?$/m);
  const before = start < 0 ? original : original.slice(0, start);
  const { ownerTry, items } = ticketFileEvidence(before);
  const unfinished = unfinishedAcceptance(items.map((item, i) => ({ id: i + 1, ...item })), notes);
  const skip = new Set(unfinished.map(({ id }) => id));
  let index = 0;
  const checked = before.replace(/^([ \t]*[-*] \[)([ xX])\]/gm, (match, prefix, mark) =>
    !skip.has(++index) && mark === ' ' ? `${prefix}x]` : match);
  const body = withStatus(checked, ownerTry ? 'ready-for-human' : unfinished.length ? 'ready-for-agent' : 'done', ticket);
  const pending = unfinished.length ? `- Acceptance left unticked: ${unfinished.map(({ id }) => `#${id}`).join(', ')}.\n` : '';
  return { body: (body + (start < 0 ? '\n## Comments' : original.slice(start))).trimEnd() + `\n\n- ${normalizeHomePaths(comment)}\n${pending}`, unfinished };
}

export interface UnattendedAcceptanceFailure {
  ticket: string;
  error: string;
}

export interface UnattendedAcceptanceResult {
  persisted: string[];
  failed: UnattendedAcceptanceFailure[];
  committed: boolean;
  deferred?: boolean;
}

/** Record unattended lead acceptance in the ticket store (or legacy Markdown) and attempt a non-blocking commit at run end. */
export async function recordUnattendedAcceptance(
  root: string,
  home: string,
  landed: () => readonly { path: string; ticket: string }[],
  flowId: string,
  verdict: string,
): Promise<UnattendedAcceptanceResult> {
  const { mainRoot } = localProjectRoots(root);
  const { persisted, failed, firstChanged } = await withTicketStoreLock(mainRoot, async () => {
    const tickets = landed();
    const persisted: string[] = [];
    const failed: UnattendedAcceptanceFailure[] = [];
    if (!tickets.length) return { persisted, failed, firstChanged: undefined as string | undefined };
    const at = new Date().toISOString();
    const summary = normalizeHomePaths(verdict).replace(/\s+/g, ' ').trim().slice(0, 400);
    const scratch = join(mainRoot, '.scratch');
    let scratchChecked = false;
    let scratchMirror = false;
    let firstTicket: string | undefined;
    const dirtyDocs = new Map<string, { doc: TicketFeatureDoc; tickets: string[] }>();

    for (const { path, ticket } of tickets) {
      const ref = parseTicketRef(ticket);
      if (!ref) continue;
      try {
        const dirty = dirtyDocs.get(ref.feature);
        const doc = dirty?.doc ?? readJsonTicketFeature(mainRoot, ref.feature);
        if (doc) {
          if (doc.mirror) continue;
          const record = doc.tickets.find(t => t.number === ref.number);
          if (!record) continue;
          if (record.accepted?.flow === flowId) {
            persisted.push(ticket);
            continue;
          }
          if (record.landing && record.acceptance.some(item => !item.done)) continue;
          if (record.status !== 'wontfix') {
            record.status = 'done';
            delete record.claimed_at;
          }
          record.accepted = { at, by: 'lead', flow: flowId, ...(summary && { verdict: summary }) };
          record.updated_at = at;
          if (dirty) dirty.tickets.push(ticket);
          else dirtyDocs.set(ref.feature, { doc, tickets: [ticket] });
          continue;
        }

        // Legacy unmigrated Markdown ticket fallback.
        if (!directoryExists(scratch)) continue;
        if (!scratchChecked) {
          scratchChecked = true;
          try { scanScratch(scratch, true); }
          catch (err) {
            if (err instanceof Error && /GitHub mirror/i.test(err.message)) { scratchMirror = true; continue; }
            throw err;
          }
        }
        if (scratchMirror) continue;
        const relFromScratch = relative(resolve(scratch), resolve(path));
        if (!relFromScratch || relFromScratch.startsWith('..') || isAbsolute(relFromScratch)) continue;
        const st = fs.lstatSync(path, { throwIfNoEntry: false });
        if (!st || !st.isFile() || fs.realpathSync(path) !== resolve(path)) continue;
        const original = fs.readFileSync(path, 'utf8');
        const marker = `- Accepted by unattended lead (${flowId}):`;
        if (original.includes(marker)) {
          persisted.push(ticket);
          continue;
        }
        const start = original.search(/^## Comments[ \t]*\r?$/m);
        const before = start < 0 ? original : original.slice(0, start);
        const { status, unfinishedLanding } = ticketFileEvidence(original);
        if (unfinishedLanding) continue;
        const body = /^wontfix$/i.test(status ?? '') ? before : withStatus(before, 'done', ref.number);
        const updated = (body + (start < 0 ? '\n## Comments' : original.slice(start))).trimEnd() + `\n\n${marker} ${summary}\n`;
        writeLegacyTicket(mainRoot, home, relative(mainRoot, fs.realpathSync(path)), updated, st.mode & 0o777);
        persisted.push(ticket);
        firstTicket ??= ticket;
      } catch (error) {
        failed.push({ ticket, error: error instanceof Error ? error.message : String(error) });
      }
    }

    for (const { doc, tickets: docTickets } of dirtyDocs.values()) {
      try {
        writeTicketFeature(mainRoot, home, doc);
        persisted.push(...docTickets);
        firstTicket ??= docTickets[0];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const ticket of docTickets) failed.push({ ticket, error: message });
      }
    }
    return { persisted, failed, firstChanged: firstTicket };
  });

  if (firstChanged) {
    try {
      const res = await commitTicketWrites(mainRoot, home, { wait_s: 0, message: `tickets: ${firstChanged} accept` });
      return { persisted, failed, committed: res.committed, ...(res.deferred && { deferred: true }) };
    } catch {
      return { persisted, failed, committed: false, deferred: true };
    }
  }
  return { persisted, failed, committed: false };
}

/** The panel groups work by an Objective's Features; no record, no warning. */
export function unlinkedWarning(root: string, feature: string): string | undefined {
  const objectives = readObjectives(root)?.objectives;
  if (!objectives || objectives.some(({ features }) => features.includes(feature))) return;
  return `feature "${feature}" is in no Objective's Features, so the panel shows it as unlinked. Objective IDs: ${
    objectives.map(({ id }) => id).join(', ') || 'none'}. List it with hud_objective (op: set, features: the whole list); op: add with objective does this itself.`;
}

export async function syncTickets(cwd: string) {
  const output: string[] = [];
  const capture = (text: string) => {
    output.push(...text.trimEnd().split(/\r?\n/));
  };
  await ticketsCommand(['sync', '--cwd', cwd], { env: process.env, stdout: capture, stderr: capture });
  return { ok: true, output };
}

export async function editLocalTickets(cwd: string, args: Record<string, unknown>, home: string, op: 'add' | 'update', edits: TicketEdits, mainRoot = sharedRoot(cwd)) {
  const { feature } = args;
  const scratch = join(cwd, '.scratch');
  scanScratch(scratch, true);
  let objectiveIds: Set<string> | undefined;
  const objectiveId = (value: unknown) => {
    if (typeof value !== 'string' || !new RegExp(OBJECTIVE_SLUG).test(value)) return invalid('objective');
    objectiveIds ??= new Set(readObjectives(mainRoot)?.objectives.map(({ id }) => id));
    if (!objectiveIds.has(value)) throw new Error(`unknown objective: ${value}`);
    return value;
  };
  const resolveBlockers = (value: unknown, feat: string, known: Set<number>) => {
    if (!Array.isArray(value)) return invalid('blocked_by');
    const refs = value.map(ref => {
      const match = typeof ref === 'string' && /^([a-z0-9-]+)\/(\d+)$/.exec(ref);
      const n = match ? Number(match[2]) : ref;
      if (!number(n)) return invalid('blocked_by');
      const exists = match && match[1] !== feat
        ? (readJsonTicketFeature(mainRoot, match[1])?.tickets ?? list(join(scratch, match[1]))).some(t => t.number === n) : known.has(n);
      if (!exists) throw new Error(`unknown blocked_by ticket: ${ref}`);
      return match ? `${match[1]}/${nn(n)}` : nn(n);
    });
    return refs.join(', ') || 'none';
  };
  const resolveRepairs = (value: unknown, feat: string, known: Set<number>) => {
    if (!Array.isArray(value)) return invalid('repairs');
    return value.map(raw => {
      if (!canonicalTicketRef(raw)) return invalid(`repairs (invalid ticket reference: ${String(raw)}; expected <feature>/<NN>)`);
      const ref = parseTicketRef(raw)!;
      const exists = ref.feature === feat
        ? known.has(ref.number)
        : (readJsonTicketFeature(mainRoot, ref.feature)?.tickets ?? list(join(scratch, ref.feature))).some(t => t.number === ref.number);
      if (!exists) throw new Error(`unknown repairs ticket: ${raw}`);
      return raw;
    });
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
      const title = line(ticket.title, 'title');
      const { what, liveTry } = extractWhatAndLiveTry(ticket.what, ticket.live_try);
      const label = ticket.status === undefined ? 'ready-for-agent' : status(ticket.status);
      const tryLine = ticket.owner_try === undefined ? [] : [`**Owner try:** ${ownerTry(ticket.owner_try)}`];
      const liveTryLine = liveTry === undefined ? [] : [`**Live try:** ${liveTry}`];
      const approvedRemovalsLine = ticket.approved_removals === undefined ? [] : [`**Approved removals:** ${line(ticket.approved_removals, 'approved_removals')}`];
      const blocked = resolveBlockers(ticket.blocked_by, feature, known);
      const repairs = ticket.repairs === undefined ? [] : resolveRepairs(ticket.repairs, feature, known);
      const repairsLine = repairs.length ? [`**Repairs:** ${repairs.join(', ')}`] : [];
      const repoLine = ticket.repo === undefined ? [] : [`**Repo:** ${repoFieldValue(ticket.repo)}`];
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
        ...repairsLine,
        ...repoLine,
        ...(objective === undefined ? [] : [`**Objective:** ${objective}`]),
        '',
        `**What to build:** ${line(what, 'what')}`,
        '',
        ...items,
        ...(items.length ? [''] : []),
        '## Comments',
        '',
      ].join('\n');
      known.add(next);
      return { number: next, path: join(issues, `${nn(next)}-${slugify(title, next)}.md`), body, objective };
    });
    for (const { number, path, body } of plans) await edits.stage({ ticket: `${feature}/${nn(number)}`, path, after: body });
    // Link first: if the record cannot be edited, no ticket is written.
    const linked = [...new Set(plans.flatMap(({ objective }) => objective ?? []))];
    if (linked.length) await linkFeature(mainRoot, home, linked, feature);
    const tickets = plans.map(({ number, path }) => ({ number, path }));
    const warning = unlinkedWarning(mainRoot, feature);
    return { ok: true, tickets, ...(warning && { warning }) };
  }

  const updateOne = async (feat: unknown, item: Record<string, unknown>) => {
    if (typeof feat !== 'string' || !/^[a-z0-9-]+$/.test(feat)) return invalid('feature');
    if (!number(item.ticket)) return invalid('ticket');
    if (item.status === undefined && item.tick === undefined && item.blocked_by === undefined && item.repairs === undefined && item.owner_try === undefined && item.objective === undefined && item.repo === undefined)
      return invalid('status, tick, blocked_by, repairs, owner_try, objective or repo');
    const existing = list(join(scratch, feat));
    const known = new Set(existing.map(t => t.number));
    const matches = existing.filter(({ number }) => number === item.ticket);
    if (!matches.length) throw new Error(`unknown ticket: ${item.ticket}`);
    if (matches.length > 1) throw new Error(`ambiguous ticket: ${item.ticket}`);
    const [ticket] = matches;
    const original = edits.read(ticket.path);
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
    if (item.repairs !== undefined) body = withRepairs(body, resolveRepairs(item.repairs, feat, known), item.ticket);
    if (item.objective !== undefined) body = withObjective(body, objectiveId(item.objective), item.ticket);
    if (item.repo !== undefined) {
      const header = ticketHeader(body);
      const field = /((?:^|·)[ \t]*\*\*Repo:\*\*[ \t]*)([^·\r\n]*?)([ \t]*)(?=·|\r?$)/im;
      body = headerField(header, field, 'Repo', repoFieldValue(item.repo), item.ticket) + body.slice(header.length);
    }
    const updated = body + (comments < 0 ? '' : original.slice(comments));
    await edits.stage({ path: ticket.path, ticket: `${feat}/${nn(ticket.number)}`, before: original, after: updated,
      mode: fs.statSync(ticket.path).mode & 0o777 });
    return { ok: true, ...ticket };
  };

  if (args.updates !== undefined) {
    if (args.ticket !== undefined || args.status !== undefined || args.tick !== undefined || args.blocked_by !== undefined || args.repairs !== undefined || args.owner_try !== undefined || args.objective !== undefined || args.repo !== undefined)
      return invalid('updates');
    if (!Array.isArray(args.updates) || !args.updates.length) return invalid('updates');
    if (feature !== undefined && (typeof feature !== 'string' || !/^[a-z0-9-]+$/.test(feature))) return invalid('feature');
    const updates = [];
    for (const raw of args.updates) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        updates.push({ ok: false, code: 'invalid_arguments', error: 'invalid_arguments: updates' });
        continue;
      }
      const item = raw as Record<string, unknown>;
      const feat = item.feature ?? feature;
      try {
        updates.push({ feature: feat as string, ...await updateOne(feat, item) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updates.push({
          ...(typeof feat === 'string' ? { feature: feat } : {}),
          ...(number(item.ticket) ? { ticket: item.ticket } : {}),
          ok: false,
          code: message.startsWith('invalid_arguments') ? 'invalid_arguments' : 'tool_error',
          error: message,
        });
      }
    }
    return { updates };
  }

  return updateOne(feature, args);
}
