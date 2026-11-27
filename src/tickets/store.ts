import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join, parse, resolve, sep } from 'node:path';
import { ticketFileEvidence, ticketHeading } from '../collectors/ticket-evidence.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { readFileBounded, writeFileAtomic, writeJsonPrivate } from '../utils/atomic-fs.js';
import { FILTER_CONFIG_ARGS, filterOverrides, SAFE_GIT_ARGS, safeGitEnv } from '../utils/git-safety.js';

export const MAX_TICKET_BYTES = 64 * 1024;
const MAX_SWEEP_INPUT_BYTES = 256 * 1024;
const MAX_WRITES = 256;
export const TICKET_FEATURE = /^[a-z0-9-]+$/;
export const LEGACY_TICKET_PATH = /^\.scratch\/[a-z0-9-]+\/issues\/\d+-[^/]+\.md$/;
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

export function serializeTicketFeature(doc: TicketFeatureDoc): string {
  const bytes = JSON.stringify(validateTicketFeature(doc), null, 2) + '\n';
  if (Buffer.byteLength(bytes) > MAX_TICKET_BYTES) throw new Error(`Ticket feature ${doc.feature} exceeds 64 KiB`);
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

export function storedTicket(root: string, ticket: unknown) {
  const ref = parseTicketRef(ticket);
  if (!ref) return;
  const doc = readJsonTicketFeature(root, ref.feature);
  if (doc) return { doc, record: doc.tickets.find(t => t.number === ref.number) };
}

export function ticketWritesPath(home: string, mainRoot: string) {
  return join(home, 'projects', hash(mainRoot), 'ticket-writes.json');
}
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
export const sha256Bytes = (data: string | Buffer) => hash(data);
export const isTicketWriteKey = (key: string) => TICKET_FEATURE.test(key) || LEGACY_TICKET_PATH.test(key);
export const ticketWriteRelPath = (key: string) => TICKET_FEATURE.test(key) ? `.hud/tickets/${key}.json` : key;
export function readTicketWrites(home: string, mainRoot: string): Record<string, string> {
  try {
    const { bytes, truncated } = readFileBounded(ticketWritesPath(home, mainRoot), 128 * 1024);
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

/** Caller holds the tickets lock. Remove entries whose stored digest matches what was committed/cleaned. */
export function pruneTicketWrites(home: string, mainRoot: string, matched: ReadonlyMap<string, string>) {
  if (!matched.size) return;
  const current = readTicketWrites(home, mainRoot);
  const kept = Object.entries(current).filter(([key, digest]) => matched.get(key) !== digest);
  if (kept.length === Object.keys(current).length) return;
  writeJsonPrivate(ticketWritesPath(home, mainRoot), Object.fromEntries(kept), { dotPrefix: true });
}

/** A later land/commit uses this same lock around reading and sweeping the write record. */
export const withTicketStoreLock = <T>(mainRoot: string, fn: () => T | Promise<T>) => withAbstractLock('tickets', mainRoot, fn);

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

function isSweepEligibleBeforeWrite(mainRoot: string, rel: string, path: string, recordedSha: string | undefined): boolean {
  const st = fs.lstatSync(path, { throwIfNoEntry: false });
  if (!st) return true;
  if (!st.isFile()) return false;
  try {
    if (fs.realpathSync(path) !== join(fs.realpathSync(mainRoot), rel)) return false;
    const { bytes, truncated } = readFileBounded(path, MAX_SWEEP_INPUT_BYTES);
    if (truncated) return false;
    if (recordedSha !== undefined && hash(bytes) === recordedSha) return true;
  } catch {
    return false;
  }
  return isCleanInGitSync(mainRoot, rel);
}

/** Caller holds the tickets lock across the read, edit and write. */
export function writeTicketFeature(mainRoot: string, home: string, doc: TicketFeatureDoc) {
  const bytes = serializeTicketFeature(doc), path = ticketFeaturePath(mainRoot, doc.feature);
  const rel = `.hud/tickets/${doc.feature}.json`;
  directory(join(mainRoot, '.hud'));
  directory(ticketDir(mainRoot));
  const currentWrites = readTicketWrites(home, mainRoot);
  const eligible = isSweepEligibleBeforeWrite(mainRoot, rel, path, currentWrites[doc.feature]);
  const writes = Object.entries(currentWrites).filter(([feature]) => feature !== doc.feature);
  if (eligible) writes.push([doc.feature, hash(bytes)]);
  const updateWrites = eligible || Object.hasOwn(currentWrites, doc.feature);
  writeFileAtomic(path, bytes, {
    dotPrefix: true,
    ...(updateWrites && {
      beforeRename: () => {
        // A failed publish cannot authorize sweeping old bytes with the new digest.
        writeJsonPrivate(ticketWritesPath(home, mainRoot), Object.fromEntries(writes.slice(-MAX_WRITES)), { dotPrefix: true });
      },
    }),
  });
  return path;
}

/** Caller holds the tickets lock. Write a legacy Markdown ticket and record its digest when sweep-eligible. */
export function writeLegacyTicket(mainRoot: string, home: string, relPath: string, bytes: string, mode?: number) {
  if (!LEGACY_TICKET_PATH.test(relPath)) throw new Error(`Invalid legacy ticket path: ${relPath}`);
  const path = join(mainRoot, relPath);
  const currentWrites = readTicketWrites(home, mainRoot);
  const eligible = isSweepEligibleBeforeWrite(mainRoot, relPath, path, currentWrites[relPath]);
  const writes = Object.entries(currentWrites).filter(([key]) => key !== relPath);
  if (eligible) writes.push([relPath, hash(bytes)]);
  const updateWrites = eligible || Object.hasOwn(currentWrites, relPath);
  writeFileAtomic(path, bytes, {
    dotPrefix: true,
    ...(mode !== undefined && { mode }),
    ...(updateWrites && {
      beforeRename: () => {
        writeJsonPrivate(ticketWritesPath(home, mainRoot), Object.fromEntries(writes.slice(-MAX_WRITES)), { dotPrefix: true });
      },
    }),
  });
  return path;
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

export function ticketFeatureSlugs(root: string) {
  const scratch = join(root, '.scratch'), json = ticketDir(root);
  const slugs = new Set(directory(scratch) ? fs.readdirSync(scratch, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name) : []);
  if (directory(join(root, '.hud')) && directory(json)) for (const entry of fs.readdirSync(json, { withFileTypes: true })) {
    if (entry.name.endsWith('.json')) slugs.add(entry.name.slice(0, -5));
  }
  return [...slugs].filter(slug => TICKET_FEATURE.test(slug)).sort();
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
  const ticket: TicketRecord = {
    number, title: heading.title, status: label,
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
