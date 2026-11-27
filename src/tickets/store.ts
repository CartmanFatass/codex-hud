import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { ticketFileEvidence, ticketHeading } from '../collectors/ticket-evidence.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { readFileBounded, writeFileAtomic } from '../utils/atomic-fs.js';
import { FILTER_CONFIG_ARGS, filterOverrides, SAFE_GIT_ARGS, safeGitEnv } from '../utils/git-safety.js';

export const MAX_TICKET_BYTES = 64 * 1024;
const MAX_SWEEP_INPUT_BYTES = 256 * 1024;
const MAX_WRITES = 256;
const MAX_WRITE_RECORD_BYTES = 128 * 1024;
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
  repo?: string;
  main_review?: boolean;
  owner_try: boolean;
  live_try: string;
  approved_removals: string[];
  blocked_by: string[];
  repairs?: string[];
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
export const canonicalTicketRef = (ref: unknown): ref is string => {
  const parsed = parseTicketRef(ref);
  return !!parsed && ticketRef(parsed.feature, parsed.number) === ref;
};
export function parseMarkdownRepairRefs(raw: string | undefined, feature: string): string[] {
  return (raw ?? '').split(/[,;]+/).flatMap(item => {
    const clean = item.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
    if (!clean || clean === 'none') return [];
    const ref = parseTicketRef(/^#?\d+$/.test(clean) ? `${feature}/${clean.replace(/^#/, '')}` : clean);
    return ref ? [ticketRef(ref.feature, ref.number)] : [];
  });
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function homePathCandidates(homeDir?: string): string[] {
  const raw = homeDir ?? (process.env.HOME || homedir());
  if (!raw) return [];
  const resolved = resolve(raw);
  const candidates: string[] = [];
  const add = (dir: string) => {
    if (!dir || dir === parse(dir).root) return;
    const trimmed = dir.replace(/[/\\]+$/, '');
    if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed);
  };
  add(resolved);
  try { add(fs.realpathSync(resolved)); } catch { /* Synthetic or absent home. */ }
  return candidates.sort((a, b) => b.length - a.length);
}

/** Rewrite absolute paths inside `$HOME` to `~/...` (or `~`) while leaving paths outside `$HOME` verbatim. */
export function normalizeHomePaths(value: string, homeDir?: string): string {
  const homes = homePathCandidates(homeDir);
  if (!homes.length) return value;
  const sepPattern = sep === '\\' ? '[/\\\\]' : '\\/';
  let result = value;
  for (const home of homes) {
    const pattern = new RegExp(
      `(?<![A-Za-z0-9_.\\-~\\/\\\\])${escapeRegExp(home)}(?=${sepPattern}|$|[\\s)\\]}"'\`>,;:?!]|\\.(?=$|[\\s)\\]}"'\`>,;:?!]))`,
      'g',
    );
    result = result.replace(pattern, '~');
  }
  return result;
}

const isHomeRelativePath = (value: string) =>
  value === '~' || value.startsWith('~/') || (sep === '\\' && value.startsWith('~\\'));

/** Expand a leading `~` or `~/...` path against `$HOME` (or `homeDir`); leave other paths unchanged. */
export function expandHomePath(value: string, homeDir?: string): string {
  if (!isHomeRelativePath(value)) return value;
  const raw = homeDir ?? (process.env.HOME || homedir());
  if (!raw) return value;
  const base = resolve(raw);
  return value === '~' ? base : resolve(join(base, value.slice(2)));
}

/** Rewrite a single absolute or `~/...` path inside `$HOME` to `~/...` (or `~`); leave outside-home paths unchanged. */
export function compactHomePath(value: string, homeDir?: string): string {
  const expanded = expandHomePath(value, homeDir);
  if (!isAbsolute(expanded)) return value;
  const normalized = resolve(expanded);
  for (const home of homePathCandidates(homeDir)) {
    if (normalized === home) return '~';
    if (normalized.startsWith(`${home}${sep}`)) {
      const rel = normalized.slice(home.length + 1);
      return sep === '\\' ? `~/${rel.replace(/\\/g, '/')}` : `~/${rel}`;
    }
  }
  return normalized;
}

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
  claimed_at: optional(timestamp), role: optional(choice(...TICKET_ROLES)), repo: optional(text), main_review: optional(check(bool)),
  owner_try: check(bool), live_try: text, approved_removals: array(text), blocked_by: array(check(canonicalTicketRef)),
  repairs: optional(array(check(canonicalTicketRef))),
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

export class TicketFeatureFull extends Error {
  constructor(readonly feature: string) { super(`Ticket feature ${feature} exceeds 64 KiB`); }
}

export function serializeTicketFeature(doc: TicketFeatureDoc): string {
  const bytes = JSON.stringify(validateTicketFeature(doc), null, 2) + '\n';
  if (Buffer.byteLength(bytes) > MAX_TICKET_BYTES) throw new TicketFeatureFull(doc.feature);
  return bytes;
}

function directory(path: string): boolean {
  const stat = fs.lstatSync(path, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) throw new Error(`not a directory: ${path}`);
  return !!stat;
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const ticketDir = (root: string) => join(root, '.hud/tickets');
export function ticketFeaturePath(root: string, feature: string) {
  if (typeof feature !== 'string' || !TICKET_FEATURE.test(feature)) return invalid('feature');
  return join(ticketDir(root), `${feature}.json`);
}
export function readJsonTicketFeature(root: string, feature: string): TicketFeatureDoc | undefined {
  const path = ticketFeaturePath(root, feature);
  if (!directory(join(root, '.hud')) || !directory(ticketDir(root))) return;
  try {
    const { bytes, truncated } = readFileBounded(path, MAX_TICKET_BYTES);
    if (truncated) throw new Error('exceeds 64 KiB');
    return validateTicketFeature(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), feature);
  } catch (error) {
    if (missing(error)) return;
    throw new Error(`Cannot read ticket feature ${feature}: ${(error as Error).message}`, { cause: error });
  }
}

export function isTicketArchive(feature: string, sibling: string): boolean {
  return sibling.startsWith(`${feature}-done`) && /^(?:-done(?:-(?:[2-9]|[1-9]\d+))?)+$/.test(sibling.slice(feature.length));
}

export interface ArchiveCandidate<T> {
  slug: string;
  mirror?: boolean;
  unreadable?: boolean;
  value?: T;
}

export type ArchiveMatch<T> =
  | { status: 'missing' }
  | { status: 'ambiguous' }
  | { status: 'matched'; slug: string; value: T };

/** Resolve `feature` across already-loaded non-mirror archive siblings, rejecting ambiguous matches or incomplete families. */
export function matchArchivedTicket<T>(
  feature: string,
  candidates: Iterable<ArchiveCandidate<T>>,
  sourceBlocked = false,
): ArchiveMatch<T> {
  if (sourceBlocked) return { status: 'missing' };
  let found: { slug: string; value: T } | undefined;
  let ambiguous = false;
  for (const candidate of candidates) {
    if (!isTicketArchive(feature, candidate.slug)) continue;
    if (candidate.unreadable) return { status: 'missing' };
    if (candidate.mirror || candidate.value === undefined) continue;
    if (found) ambiguous = true;
    else found = { slug: candidate.slug, value: candidate.value };
  }
  if (ambiguous) return { status: 'ambiguous' };
  return found ? { status: 'matched', ...found } : { status: 'missing' };
}

export function resolveArchivedTicket(root: string, feature: string, number: number, sourceMirror = false) {
  if (sourceMirror) return;
  const candidates = jsonTicketFeatureSlugs(root)
    .filter(slug => isTicketArchive(feature, slug))
    .flatMap(slug => {
      const doc = readJsonTicketFeature(root, slug);
      if (!doc) return [];
      const record = doc.tickets.find(t => t.number === number);
      return [{ slug, mirror: !!doc.mirror, value: record ? { doc, record } : undefined }];
    });
  const resolved = matchArchivedTicket(feature, candidates, sourceMirror);
  if (resolved.status === 'ambiguous') throw new Error(`ambiguous ticket: ${ticketRef(feature, number)}`);
  return resolved.status === 'matched' ? resolved.value : undefined;
}

export function storedTicket(root: string, ticket: unknown) {
  const ref = parseTicketRef(ticket);
  if (!ref) return;
  const doc = readJsonTicketFeature(root, ref.feature);
  const record = doc?.tickets.find(t => t.number === ref.number);
  if (record || doc?.mirror) return { doc: doc!, record };
  return resolveArchivedTicket(root, ref.feature, ref.number) ?? (doc && { doc, record });
}

export function ticketWritesPath(home: string, mainRoot: string) {
  return join(home, 'projects', hash(mainRoot), 'ticket-writes.json');
}
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
export const OBJECTIVE_WRITE_KEY = '@objectives';
export const isTicketWriteKey = (key: string) => key === OBJECTIVE_WRITE_KEY || TICKET_FEATURE.test(key);
export const ticketWriteRelPath = (key: string) => key === OBJECTIVE_WRITE_KEY ? '.hud/objectives.md' : `.hud/tickets/${key}.json`;

export function readTicketWrites(home: string, mainRoot: string): Record<string, string> {
  try {
    const { bytes, truncated } = readFileBounded(ticketWritesPath(home, mainRoot), MAX_WRITE_RECORD_BYTES);
    if (truncated) throw new Error('Ticket write record exceeds 128 KiB');
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ticket write record');
    return Object.fromEntries(Object.entries(value).flatMap(([key, digest]) =>
      isTicketWriteKey(key) && typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest) ? [[key, digest] as const] : []).slice(-MAX_WRITES));
  } catch (error) {
    if (missing(error)) return {};
    throw error;
  }
}

function ticketWriteRecord(writes: Record<string, string>) {
  const bytes = JSON.stringify(writes) + '\n';
  if (Buffer.byteLength(bytes) > MAX_WRITE_RECORD_BYTES) throw new Error('Ticket write record exceeds 128 KiB');
  return bytes;
}

function saveTicketWrites(home: string, mainRoot: string, bytes: string) {
  writeFileAtomic(ticketWritesPath(home, mainRoot), bytes, { dotPrefix: true });
}

/** Caller holds the tickets lock. Remove entries whose stored digest matches what was committed/cleaned. */
export function pruneTicketWrites(home: string, mainRoot: string, matched: ReadonlyMap<string, string>) {
  if (!matched.size) return;
  const writes = readTicketWrites(home, mainRoot);
  for (const [key, digest] of matched) if (writes[key] === digest) delete writes[key];
  saveTicketWrites(home, mainRoot, ticketWriteRecord(writes));
}

/** A later land/commit uses this same lock around reading and sweeping the write record. */
export const withTicketStoreLock = <T>(mainRoot: string, fn: () => T | Promise<T>) =>
  withAbstractLock('tickets', mainRoot, fn, { timeoutMs: 10_000 });

function isCleanInGitSync(mainRoot: string, rel: string): boolean {
  const opts = { cwd: mainRoot, env: safeGitEnv(process.env), encoding: 'utf8' as const, timeout: 5000 };
  const cfg = spawnSync('git', [...SAFE_GIT_ARGS, ...FILTER_CONFIG_ARGS], opts);
  let filters: string[];
  if (cfg.status === 0) {
    try { filters = filterOverrides(cfg.stdout ?? ''); }
    catch { return false; }
  } else if (cfg.status === 1) {
    filters = [];
  } else {
    return false;
  }
  const st = spawnSync('git', [...SAFE_GIT_ARGS, ...filters, 'status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=all', '--', rel], opts);
  if (st.status !== 0 || st.stdout) return false;
  const ls = spawnSync('git', [...SAFE_GIT_ARGS, 'ls-files', '-v', '-z', '--', rel], opts);
  if (ls.status !== 0) return false;
  return !(ls.stdout ?? '').split('\0').some(row => /^[a-zS] /.test(row));
}

export function ticketWriteSha(realMain: string, rel: string): string | undefined {
  const path = join(realMain, rel);
  try {
    if (!fs.lstatSync(path).isFile() || fs.realpathSync(path) !== path) return;
    const { bytes, truncated } = readFileBounded(path, MAX_SWEEP_INPUT_BYTES);
    if (!truncated) return hash(bytes);
  } catch { /* Unknown bytes cannot authorize a sweep. */ }
}

function isSweepEligibleBeforeWrite(mainRoot: string, rel: string, recordedSha: string | undefined): boolean {
  const path = join(mainRoot, rel);
  if (!fs.lstatSync(path, { throwIfNoEntry: false })) return true;
  const sha = ticketWriteSha(fs.realpathSync(mainRoot), rel);
  return sha !== undefined && (sha === recordedSha || isCleanInGitSync(mainRoot, rel));
}

export interface TicketWrite { key: string; bytes: string; mode?: number; mirror?: boolean; }

/** Low-level publication for the archive planner only. Caller holds the tickets lock. */
export function prepareTicketWrites(mainRoot: string, home: string, files: readonly TicketWrite[]) {
  directory(join(mainRoot, '.hud'));
  directory(ticketDir(mainRoot));
  if (!files.length) return () => {};
  const paths = files.map(file => ({ ...file, rel: ticketWriteRelPath(file.key) }));
  // Generated GitHub mirrors are never part of the local commit sweep.
  const local = paths.filter(file => !file.mirror);
  if (!local.length) return () => {
    for (const file of paths) writeFileAtomic(join(mainRoot, file.rel), file.bytes, { dotPrefix: true });
  };
  const writes = readTicketWrites(home, mainRoot);
  for (const { key, rel, bytes } of local) {
    if (isSweepEligibleBeforeWrite(mainRoot, rel, Object.hasOwn(writes, key) ? writes[key] : undefined)) {
      delete writes[key];
      writes[key] = hash(bytes);
    } else delete writes[key];
  }
  const keys = Object.keys(writes);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_WRITES))) delete writes[key];
  const receipt = Object.keys(writes).length || fs.existsSync(ticketWritesPath(home, mainRoot)) ? ticketWriteRecord(writes) : undefined;
  return () => {
    for (const file of paths) writeFileAtomic(join(mainRoot, file.rel), file.bytes, { dotPrefix: true, mode: file.mode });
    if (receipt !== undefined) saveTicketWrites(home, mainRoot, receipt);
  };
}

export function legacyTicketPaths(root: string, feature: string) {
  if (!TICKET_FEATURE.test(feature)) return [];
  const scratch = join(root, '.scratch'), dir = join(scratch, feature), issues = join(dir, 'issues');
  if (!directory(scratch) || !directory(dir) || !directory(issues)) return [];
  return fs.readdirSync(issues, { withFileTypes: true }).flatMap(entry => {
    const match = /^(\d+)-.+\.md$/.exec(entry.name), number = Number(match?.[1]);
    return entry.isFile() && ticketNumber(number) ? [{ number, path: join(issues, entry.name) }] : [];
  }).sort((a, b) => a.number - b.number);
}

function jsonTicketFeatureSlugs(root: string) {
  const json = ticketDir(root);
  return directory(join(root, '.hud')) && directory(json) ? fs.readdirSync(json).flatMap(name =>
    name.endsWith('.json') && TICKET_FEATURE.test(name.slice(0, -5)) ? [name.slice(0, -5)] : []) : [];
}

export function ticketFeatureSlugs(root: string) {
  const scratch = join(root, '.scratch');
  const slugs = new Set(jsonTicketFeatureSlugs(root));
  if (directory(scratch)) for (const entry of fs.readdirSync(scratch, { withFileTypes: true })) {
    if (entry.isDirectory() && TICKET_FEATURE.test(entry.name)) slugs.add(entry.name);
  }
  return [...slugs].sort();
}

export const LEGACY_TICKET_HEADER_END = /^(?:[ \t]*\*\*What to build:\*\*|##(?:[ \t]|\r?$))/im;

export function legacyTicketRepo(brief: string): string | undefined {
  const header = brief.split(LEGACY_TICKET_HEADER_END, 1)[0];
  return /(?:^|·)[ \t]*\*\*Repo:\*\*[ \t]*([^·\r\n]*)/im.exec(header)?.[1]?.trim();
}

export function readLegacyTicket(path: string, number: number, feature: string) {
  const { bytes, truncated, stat } = readFileBounded(path, MAX_TICKET_BYTES);
  if (truncated) return;
  const brief = bytes.toString('utf8');
  const [body, comments] = brief.split(/^## Comments[ \t]*\r?$/im, 2);
  const heading = ticketHeading(body, number);
  if (!heading) return;
  const marker = /^(?:\*\*What to build:\*\*|## What to build\b)[ \t]*/im.exec(body);
  const header = marker ? body.slice(0, marker.index) : body;
  const field = (key: string) => header.match(new RegExp(`(?:^|·)[ \\t]*\\*\\*${key}:\\*\\*[ \\t]*([^·\\r\\n]*)`, 'mi'))?.[1]?.trim();
  const evidence = ticketFileEvidence(brief);
  const status = evidence.status?.toLowerCase().match(/^[a-z-]+/)?.[0];
  const legacyStatuses: Record<string, TicketStatus> = { resolved: 'done', closed: 'done', accepted: 'done', complete: 'done', dropped: 'wontfix', try: 'ready-for-human' };
  const at = stat.mtime.toISOString();
  const label = TICKET_STATUSES.find(value => value === status)
    ?? (status && Object.hasOwn(legacyStatuses, status) ? legacyStatuses[status] : 'needs-triage');
  const repairs = parseMarkdownRepairRefs(evidence.repairs, feature);
  const repo = legacyTicketRepo(brief);
  const ticket: TicketRecord = {
    number, title: heading.title, status: label, ...(repo !== undefined && { repo }),
    ...(/^(?:frontend-imp|frontend-implementer)\b/i.test(field('(?:Role|Who)') ?? '') && { role: 'frontend-imp' }),
    ...(/^yes$/i.test(field('Main review') ?? '') && { main_review: true }),
    owner_try: evidence.ownerTry, live_try: field('(?:Live try|How to try|Try)') || 'none',
    approved_removals: splitRemovals(evidence.approvedRemovals),
    blocked_by: (evidence.blocked ?? '').split(/[,;]+/).flatMap(item => {
      const clean = item.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
      const ref = parseTicketRef(/^#?\d+$/.test(clean) ? `${feature}/${clean.replace(/^#/, '')}` : clean);
      return ref ? [ticketRef(ref.feature, ref.number)] : [];
    }),
    ...(repairs.length && { repairs }),
    ...(field('Objective') && { objective: field('Objective') }),
    what: marker ? body.slice(marker.index + marker[0].length).split(/^[ \t]*[-*] \[[ xX]\]/m, 1)[0].trim() : '',
    acceptance: evidence.items.map((item, i) => ({ id: i + 1, ...item })),
    comments: comments?.trim() ? [{ at, author: 'legacy', text: comments.trim() }] : [], created_at: at, updated_at: at,
  };
  return { ticket, path, brief };
}

export function splitRemovals(raw: string | undefined): string[] {
  const trimmed = raw?.trim();
  if (!trimmed || /^none\.?$/i.test(trimmed)) return [];
  return trimmed.split(/[,;]+/).map(s => s.trim().replace(/\.+$/, '').replace(/\s+/g, ' ').toLowerCase()).filter(Boolean);
}

export function readTicketFeature(root: string, feature: string): TicketFeatureDoc | undefined {
  const json = readJsonTicketFeature(root, feature);
  if (json) return json;
  const paths = legacyTicketPaths(root, feature);
  if (!paths.length) return;
  const spec_path = `.scratch/${feature}/spec.md`;
  return { version: 1, feature, ...(fs.existsSync(join(root, spec_path)) && { spec_path }), tickets: paths.flatMap(({ path, number }) => {
    const found = readLegacyTicket(path, number, feature);
    return found ? [found.ticket] : [];
  }) };
}

export function renderTicketBrief(ticket: TicketRecord, feature: Pick<TicketFeatureDoc, 'objective' | 'spec_path'> = {}): string {
  const objective = ticket.objective ?? feature.objective;
  return [
    `# ${String(ticket.number).padStart(2, '0')}: ${ticket.title}`, '',
    `**Status:** ${ticket.status}`,
    ...(ticket.kind && ticket.kind !== 'impl' ? [`**Kind:** ${ticket.kind}`] : []),
    ...(ticket.role ? [`**Role:** ${ticket.role}`] : []),
    ...(ticket.repo ? [`**Repo:** ${ticket.repo}`] : []),
    ...(ticket.main_review ? ['**Main review:** yes'] : []),
    `**Owner try:** ${ticket.owner_try ? 'yes' : 'no'}`,
    ...(!ticket.live_try.includes('\n') ? [`**Live try:** ${ticket.live_try}`] : []),
    ...(ticket.approved_removals.length ? [`**Approved removals:** ${ticket.approved_removals.join(', ')}`] : []),
    `**Blocked by:** ${ticket.blocked_by.join(', ') || 'none'}`,
    ...(ticket.repairs?.length ? [`**Repairs:** ${ticket.repairs.join(', ')}`] : []),
    ...(objective ? [`**Objective:** ${objective}`] : []),
    ...(feature.spec_path ? [`**Spec:** ${feature.spec_path}`] : []),
    '', `**What to build:** ${ticket.what}`, '',
    ...(ticket.cases?.length ? [
      '### Cases', '',
      ...ticket.cases.map(c => {
        const subject = c.case_name
          ? (c.test ? `\`${c.case_name}\` (${c.test})` : `\`${c.case_name}\``)
          : (c.test ? `unidentified failure (\`${c.step}\`, ${c.test})` : `unidentified failure (\`${c.step}\`)`);
        const meta = [c.flow && `flow \`${c.flow}\``, c.log && `log \`${c.log}\``].filter(Boolean).join(', ');
        return meta ? `- ${subject} — ${meta}` : `- ${subject}`;
      }), '',
    ] : []),
    ...(ticket.live_try.includes('\n') ? ['## Live try', '', ticket.live_try, ''] : []),
    ...ticket.acceptance.map(item => `- [${item.done ? 'x' : ' '}] ${item.text}`),
    ...(ticket.acceptance.length ? [''] : []), '## Comments', '',
    ...(ticket.landing ? [
      `- ${ticket.landing.at} Landed ${ticket.landing.commit ?? `in this commit (replay base ${ticket.landing.replay_base})`}`
        + (ticket.landing.gates ? `; gate ${ticket.landing.gates}/${ticket.landing.gates} passed.` : ''),
    ] : []),
    ...(ticket.accepted ? [
      `- ${ticket.accepted.at} Accepted by ${ticket.accepted.by}${ticket.accepted.flow ? ` (${ticket.accepted.flow})` : ''}:`
        + (ticket.accepted.verdict ? ` ${ticket.accepted.verdict.replace(/\n/g, '\n  ')}` : ''),
    ] : []),
    ...ticket.comments.map(comment => `- ${comment.at} ${comment.author}: ${comment.text.replace(/\n/g, '\n  ')}`),
    ...(ticket.landing || ticket.accepted || ticket.comments.length ? [''] : []),
  ].join('\n');
}
