/** Bounded, stat-signature-cached ticket collection shared by Project, Execution and the CLI. */
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { MAX_TICKET_BYTES, TICKET_FEATURE, parseTicketRef, ticketNumber, validateTicketFeature, type TicketFeatureDoc } from '../tickets/store.js';
import { readFileBounded } from '../utils/atomic-fs.js';
import type { ProjectTicket, TicketFeature } from './project-board.js';
import { legacyTicketEvidence, storedTicketEvidence, targetKey, ticketFileEvidence, ticketHeading } from './ticket-evidence.js';

const MAX_FEATURES = 256, MAX_LEGACY_FILES = 512, MAX_LEGACY_PER_FEATURE = 64;
// `undefined` is absent; null is an unreadable path, not evidence of absence.
function stat(path: string): fs.Stats | null | undefined {
  try { return fs.lstatSync(path, { throwIfNoEntry: false }); } catch { return null; }
}
const signature = (st: ReturnType<typeof stat>) => st ? `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}` : st === null ? 'unknown' : '';

interface LegacyTicket { number: number; title: string; brief: string; ticket?: ProjectTicket; state?: ProjectTicket['state'] }
export type TicketSource = { doc: TicketFeatureDoc } | { legacy: readonly LegacyTicket[] };
interface TicketLookup { title: string; blockers?: readonly string[]; state?: ProjectTicket['state'] }
interface FeatureFiles { slug: string; source: TicketSource; at: number; path?: string; partial?: true }
interface TicketScan {
  stamp: number;
  features: TicketFeature[];
  partial: boolean;
  sources: ReadonlyMap<string, TicketSource>;
  lookup: (ticket: string, feature?: string) => TicketLookup | undefined;
}
let revision = 0;
class TicketStore {
  private files = new Map<string, { stamp: string; value: unknown }>();
  private previous?: { signature: string; scan: TicketScan };

  constructor(private readonly root: string) {}

  scan(): TicketScan {
    const { root } = this;
    const seen = new Set<string>(), stamps: string[] = [];
    const probe = (path: string) => {
      const st = stat(path);
      stamps.push(`${path}:${signature(st)}`);
      return st;
    };
    const cached = <T>(path: string, st: fs.Stats, read: () => T): T | null => {
      seen.add(path);
      const stamp = signature(st), hit = this.files.get(path);
      if (hit?.stamp === stamp) return hit.value as T | null;
      let value: T | null;
      try { value = read(); } catch { value = null; }
      this.files.set(path, { stamp, value });
      return value;
    };
    const names = (path: string, st: ReturnType<typeof stat>, cap: number, keep: (entry: fs.Dirent) => boolean) => {
      if (st === undefined) return [];
      if (!st?.isDirectory()) return null;
      return cached(path, st, () => {
        const dir = fs.opendirSync(path), names: string[] = [];
        try {
          for (let entry; (entry = dir.readSync());) {
            if (!keep(entry) || (names.length === cap && entry.name >= names[cap - 1])) continue;
            const { name } = entry, i = names.findIndex((other) => other > name);
            names.splice(i < 0 ? names.length : i, 0, name);
            if (names.length > cap) names.pop();
          }
        } finally { dir.closeSync(); }
        return names;
      });
    };
    const body = <T>(path: string, st: ReturnType<typeof stat>, parse: (bytes: Buffer) => T) =>
      st?.isFile() ? cached(path, st, () => {
        if (st.size > MAX_TICKET_BYTES) return null;
        const { bytes, truncated, stat } = readFileBounded(path, MAX_TICKET_BYTES);
        return truncated || signature(stat) !== signature(st) ? null : parse(bytes);
      }) : null;
    const groups: FeatureFiles[] = [];
    const hud = probe(join(root, '.hud')), jsonDir = join(root, '.hud', 'tickets');
    const jsonStat = hud?.isDirectory() ? probe(jsonDir) : hud === undefined ? undefined : null;
    const json = names(jsonDir, jsonStat, MAX_FEATURES + 1, (entry) => /^[a-z0-9-]+\.json$/.test(entry.name));
    const canonical = new Set((json ?? []).map((name) => name.slice(0, -5)));
    let partial = !json || json.length > MAX_FEATURES;
    for (const name of (json ?? []).slice(0, MAX_FEATURES)) {
      const slug = name.slice(0, -5), source = `.hud/tickets/${name}`, path = join(root, source), st = probe(path);
      const doc = body(path, st, (bytes) => validateTicketFeature(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), slug));
      if (!doc) { partial = true; continue; }
      groups.push({ slug, source: { doc }, path, at: st!.mtimeMs });
    }

    const scratch = join(root, '.scratch');
    const dirs = names(scratch, probe(scratch), MAX_FEATURES + 1, (entry) => entry.isDirectory() && TICKET_FEATURE.test(entry.name));
    let budget = MAX_LEGACY_FILES, slots = MAX_FEATURES - Math.min(MAX_FEATURES, canonical.size);
    if (!dirs || dirs.length > MAX_FEATURES) partial = true;
    const ranked = (dirs ?? []).slice(0, MAX_FEATURES).filter((slug) => !canonical.has(slug)).flatMap((slug) => {
      const issues = join(scratch, slug, 'issues'), st = probe(issues);
      if (st === undefined) return [];
      if (!st?.isDirectory()) { partial = true; return []; }
      return [{ slug, issues, st }];
    }).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs || a.slug.localeCompare(b.slug));
    for (const { slug, issues, st } of ranked) {
      const files = names(issues, st, MAX_LEGACY_PER_FEATURE + 1, (entry) => entry.isFile() && /^\d+-[^/]+\.md$/.test(entry.name));
      if (!files) { partial = true; continue; }
      if (!files.length) continue;
      if (slots <= 0 || budget <= 0) { partial = true; break; }
      slots--;
      const limit = Math.min(MAX_LEGACY_PER_FEATURE, budget), legacy: LegacyTicket[] = [];
      let incomplete = files.length > limit;
      for (const name of files.slice(0, limit)) {
        budget--;
        const path = join(issues, name), st = probe(path), number = Number(name.split('-')[0]);
        if (!ticketNumber(number)) continue;
        const result = body(path, st, (bytes) => {
          const brief = bytes.toString('utf8'), ticket = legacyTicketEvidence(brief, number, path, st!.mtimeMs);
          const title = ticket?.title ?? /^#{1,6}[ \t]+(?:\d+[ \t]*[:.-][ \t]*)?(\S.*)$/m.exec(brief)?.[1]?.trim();
          // An old ticket can establish settlement for job supersession without qualifying as a board row.
          const state = ticket?.state ?? (ticketHeading(brief, number) ? ticketFileEvidence(brief).landed : undefined);
          return { entry: title ? { number, title, brief, ticket, state } : undefined };
        });
        if (!result) incomplete = true;
        else if (result.entry) legacy.push(result.entry);
      }
      if (incomplete) partial = true;
      if (legacy.length) groups.push({ slug, source: { legacy }, at: st.mtimeMs, ...(incomplete && { partial: true }) });
    }
    for (const path of this.files.keys()) if (!seen.has(path)) this.files.delete(path);
    const fingerprint = JSON.stringify([partial, stamps]);
    if (this.previous?.signature === fingerprint) return this.previous.scan;
    const features: TicketFeature[] = [], sources = new Map<string, TicketSource>(), index = new Map<string, TicketLookup>();
    for (const group of groups) {
      const { slug, source } = group;
      let tickets: ProjectTicket[];
      if ('doc' in source) {
        tickets = source.doc.tickets.map((record) => {
          const ticket = storedTicketEvidence(record, group.path!, `.hud/tickets/${slug}.json`);
          index.set(`${slug}/${record.number}`, { title: ticket.title, blockers: record.blocked_by, state: ticket.state });
          return ticket;
        });
      } else {
        const numbers = new Set<number>();
        for (const { number, title, state } of source.legacy) {
          const key = `${slug}/${number}`;
          if (numbers.has(number)) index.delete(key);
          else index.set(key, { title, state });
          numbers.add(number);
        }
        source.legacy = [...source.legacy].sort((a, b) => a.number - b.number);
        tickets = source.legacy.flatMap(({ ticket }) => ticket ? [ticket] : []);
      }
      sources.set(slug, source);
      if (tickets.length || 'doc' in source) features.push({ slug, tickets, ...(group.partial && { partial: true }),
        at: tickets.length ? Math.max(...tickets.map((ticket) => ticket.at)) : group.at });
    }
    const scan: TicketScan = {
      stamp: ++revision, features: features.sort((a, b) => b.at - a.at || a.slug.localeCompare(b.slug)), partial, sources,
      lookup: (ticket, feature) => {
        const ref = parseTicketRef(targetKey(feature && /^\d+$/.test(ticket) ? `${feature}/${ticket}` : ticket));
        return ref && index.get(`${ref.feature}/${ref.number}`);
      },
    };
    this.previous = { signature: fingerprint, scan };
    return scan;
  }
}

const stores = new Map<string, TicketStore>();
/** ProjectCollectors keep their reader while visible; one-shot callers share the recent roots. */
export function ticketStoreFor(root: string): TicketStore {
  root = resolve(root);
  const store = stores.get(root) ?? new TicketStore(root);
  stores.delete(root);
  stores.set(root, store);
  if (stores.size > 32) stores.delete(stores.keys().next().value!);
  return store;
}

export const scanTicketStore = (root: string): TicketScan => ticketStoreFor(root).scan();
