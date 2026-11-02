import * as fs from 'node:fs';
import { join } from 'node:path';

/**
 * `<HUD_HOME>/cache.json` v2 (NOTIFY v2 §5.2): one load, one validation, and a
 * pure `adviceFor` lookup over the resulting snapshot (§5.3).
 *
 * The four provenance blocks stay separate. `configured`, `documented`,
 * `observed` and `planningAssumption` are kept as written; an observation never
 * replaces a documented value and an assumption is never reported as either.
 * The file is read once per process — `adviceFor` does no I/O, so a change takes
 * effect in the next session (§5.2).
 *
 * Only the TTLs are carried here. The arithmetic fields that depend on a
 * multiplier, a context size and `marginMs` arrive with the later arithmetic
 * work; they must then be `null` — never zero or negative — when `ttlMs` is
 * null, `ttlMs <= marginMs`, a multiplier is missing or the context size is
 * unknown. The same rule already applies to the TTL fields: a TTL that is not a
 * positive number is never reported.
 */

export const CACHE_CONFIG_FILE = 'cache.json';
export const CACHE_CONFIG_VERSION = 2;
/** Bounded input: a larger file is refused instead of parsed. */
export const CACHE_CONFIG_MAX_BYTES = 64 * 1024;
/** Bounded input: more entries than this are refused. */
export const CACHE_CONFIG_MAX_ENTRIES = 64;
/** Bounded input: more auth alternatives in one entry than this are refused. */
export const CACHE_CONFIG_MAX_AUTH_ALTERNATIVES = 16;
/** Advisory context-quality threshold of §5.3 step 4 when the file does not set one. */
export const DEFAULT_HANDOFF_MIN_TOKENS = 60_000;

export type CacheHarness = 'claude' | 'codex' | 'pi';
export type CacheWarming = 'off' | 'native';

export type CacheConfigErrorCode =
  | 'file_unreadable'
  | 'file_too_large'
  | 'invalid_json'
  | 'invalid_shape'
  | 'wrong_version'
  | 'unknown_key'
  | 'invalid_type'
  | 'invalid_number'
  | 'too_many_entries'
  | 'too_many_alternatives'
  | 'duplicate_match';

export interface CacheConfigInvalid {
  ok: false;
  reason: 'cache_config_invalid';
  /** Stable machine code; `at` says which value produced it. */
  detail: CacheConfigErrorCode;
  /** JSON path of the offending value, e.g. `entries[2].documented.ttlMs`; null for whole-file problems. */
  at: string | null;
  /** The file the problem was found in; null for the pure validators. */
  path: string | null;
}

export interface CacheTtlBlock {
  ttlMs: number | null;
  source: string | null;
  note: string | null;
}

export interface CacheDocumentedBlock extends CacheTtlBlock {
  writeMultiplier: number | null;
  readMultiplier: Readonly<Record<string, number>> | null;
  lifetimeFrom: string | null;
}

export interface CachePlanningBlock {
  ttlMs: number | null;
  label: string | null;
}

export interface CacheConfigEntry {
  /** `auth: null` means the entry has no `auth` key and matches any verified auth label. */
  match: { harness: CacheHarness; auth: readonly string[] | null };
  configured: CacheTtlBlock | null;
  documented: CacheDocumentedBlock | null;
  observed: CacheTtlBlock | null;
  planningAssumption: CachePlanningBlock | null;
  warming: CacheWarming;
}

export interface CacheConfigSnapshot {
  version: typeof CACHE_CONFIG_VERSION;
  /** null when the file does not set it; see `handoffMinTokensFor` for the default. */
  handoffMinTokens: number | null;
  entries: readonly CacheConfigEntry[];
}

export interface CacheConfigLoaded {
  ok: true;
  snapshot: CacheConfigSnapshot;
  path: string;
  /** `missing` is a valid empty snapshot, not an error. */
  origin: 'file' | 'missing';
}

export type CacheConfigLoad = CacheConfigLoaded | CacheConfigInvalid;
export type CacheConfigParse = { ok: true; snapshot: CacheConfigSnapshot } | CacheConfigInvalid;

export interface CacheAdviceQuery {
  harness: string;
  auth: string;
  model?: string | null;
}

export interface CacheAdviceProvenance {
  /** Index of the matched entry in the snapshot, or null when no entry matched. */
  entry: number | null;
  /** How the entry matched the caller's auth label; null when no entry matched. */
  authMatch: 'listed' | 'wildcard' | null;
  configuredSource: string | null;
  documentedSource: string | null;
  observedSource: string | null;
  planningAssumptionLabel: string | null;
  /** An `observed` block exists; it is reported here and never replaces `documentedTtlMs`. */
  observed: boolean;
}

export interface CacheAdvice {
  harness: string;
  auth: string;
  model: string | null;
  configuredTtlMs: number | null;
  documentedTtlMs: number | null;
  planningTtlMs: number | null;
  provenance: CacheAdviceProvenance;
  /** MVP: the last qualifying request start is not observed, so the warm window is unknown. */
  lastQualifyingRequestStartAt: null;
  remainingWarmWindowMs: null;
  warming: CacheWarming;
}

type JsonObject = Record<string, unknown>;

class Problem extends Error {
  constructor(
    readonly detail: CacheConfigErrorCode,
    readonly at: string | null
  ) {
    super(detail);
  }
}

function problem(detail: CacheConfigErrorCode, at: string): never {
  throw new Problem(detail, at === '' ? null : at);
}

function child(at: string, key: string): string {
  return at === '' ? key : `${at}.${key}`;
}

function invalid(detail: CacheConfigErrorCode, at: string | null, path: string | null = null): CacheConfigInvalid {
  return { ok: false, reason: 'cache_config_invalid', detail, at, path };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonObject(value: unknown, at: string): JsonObject {
  if (!isJsonObject(value)) problem('invalid_type', at);
  return value;
}

function keys(value: JsonObject, at: string, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of required) if (!Object.hasOwn(value, key)) problem('invalid_type', child(at, key));
  for (const key of Object.keys(value))
    if (!required.includes(key) && !optional.includes(key)) problem('unknown_key', child(at, key));
}

function text(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.length === 0) problem('invalid_type', at);
  return value;
}

function optionalText(value: unknown, at: string): string | null {
  if (value === undefined || value === null) return null;
  return text(value, at);
}

/** A TTL is a positive integer number of milliseconds or `null` (unknown). */
function ttl(value: unknown, at: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) problem('invalid_number', at);
  return value;
}

function multiplier(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) problem('invalid_number', at);
  return value;
}

function ttlBlock(value: unknown, at: string): CacheTtlBlock {
  const block = jsonObject(value, at);
  keys(block, at, [], ['ttlMs', 'source', 'note']);
  if (Object.keys(block).length === 0) problem('invalid_type', at);
  return {
    ttlMs: Object.hasOwn(block, 'ttlMs') ? ttl(block.ttlMs, child(at, 'ttlMs')) : null,
    source: optionalText(block.source, child(at, 'source')),
    note: optionalText(block.note, child(at, 'note')),
  };
}

function documentedBlock(value: unknown, at: string): CacheDocumentedBlock {
  const block = jsonObject(value, at);
  keys(block, at, [], ['ttlMs', 'writeMultiplier', 'readMultiplier', 'lifetimeFrom', 'source', 'note']);
  if (Object.keys(block).length === 0) problem('invalid_type', at);
  let readMultiplier: Record<string, number> | null = null;
  if (Object.hasOwn(block, 'readMultiplier')) {
    const atRead = child(at, 'readMultiplier');
    const map = jsonObject(block.readMultiplier, atRead);
    const names = Object.keys(map);
    if (names.length === 0) problem('invalid_type', atRead);
    readMultiplier = {};
    for (const name of names) {
      if (name === '') problem('invalid_type', atRead);
      readMultiplier[name] = multiplier(map[name], child(atRead, name));
    }
  }
  return {
    ttlMs: Object.hasOwn(block, 'ttlMs') ? ttl(block.ttlMs, child(at, 'ttlMs')) : null,
    writeMultiplier: Object.hasOwn(block, 'writeMultiplier')
      ? multiplier(block.writeMultiplier, child(at, 'writeMultiplier'))
      : null,
    readMultiplier,
    lifetimeFrom: optionalText(block.lifetimeFrom, child(at, 'lifetimeFrom')),
    source: optionalText(block.source, child(at, 'source')),
    note: optionalText(block.note, child(at, 'note')),
  };
}

function planningBlock(value: unknown, at: string): CachePlanningBlock {
  const block = jsonObject(value, at);
  keys(block, at, [], ['ttlMs', 'label']);
  if (Object.keys(block).length === 0) problem('invalid_type', at);
  return {
    ttlMs: Object.hasOwn(block, 'ttlMs') ? ttl(block.ttlMs, child(at, 'ttlMs')) : null,
    label: optionalText(block.label, child(at, 'label')),
  };
}

function matchBlock(value: unknown, at: string): CacheConfigEntry['match'] {
  const block = jsonObject(value, at);
  keys(block, at, ['harness'], ['auth']);
  const harness = block.harness;
  if (harness !== 'claude' && harness !== 'codex' && harness !== 'pi') problem('invalid_type', child(at, 'harness'));
  let auth: string[] | null = null;
  if (Object.hasOwn(block, 'auth')) {
    const atAuth = child(at, 'auth');
    const alternatives = text(block.auth, atAuth)
      .split('|')
      .map((alternative) => alternative.trim());
    if (alternatives.some((alternative) => alternative.length === 0)) problem('invalid_type', atAuth);
    if (alternatives.length > CACHE_CONFIG_MAX_AUTH_ALTERNATIVES) problem('too_many_alternatives', atAuth);
    const unique = [...new Set(alternatives)];
    if (unique.length !== alternatives.length) problem('invalid_type', atAuth);
    auth = unique;
  }
  return { harness, auth };
}

/**
 * Auth membership index: built once per entry at validation so `adviceFor`
 * checks one label in constant time instead of scanning the alternatives. A
 * hand-built snapshot gets its index on first use and is never rebuilt.
 */
const AUTH_INDEX = new WeakMap<CacheConfigEntry, ReadonlySet<string>>();

function authIndex(entry: CacheConfigEntry): ReadonlySet<string> {
  let index = AUTH_INDEX.get(entry);
  if (index === undefined) {
    index = new Set(entry.match.auth ?? []);
    AUTH_INDEX.set(entry, index);
  }
  return index;
}

function entryBlock(value: unknown, at: string): CacheConfigEntry {
  const block = jsonObject(value, at);
  keys(block, at, ['match'], ['configured', 'documented', 'observed', 'planningAssumption', 'warming']);
  const match = matchBlock(block.match, child(at, 'match'));
  const absent = (key: string) => block[key] === undefined || block[key] === null;
  const configured = absent('configured') ? null : ttlBlock(block.configured, child(at, 'configured'));
  const documented = absent('documented') ? null : documentedBlock(block.documented, child(at, 'documented'));
  const observed = absent('observed') ? null : ttlBlock(block.observed, child(at, 'observed'));
  const planningAssumption = absent('planningAssumption')
    ? null
    : planningBlock(block.planningAssumption, child(at, 'planningAssumption'));
  let warming: CacheWarming = 'off';
  if (Object.hasOwn(block, 'warming')) {
    const value = block.warming;
    if (value !== 'off' && value !== 'native') problem('invalid_type', child(at, 'warming'));
    warming = value;
  }
  const entry: CacheConfigEntry = { match, configured, documented, observed, planningAssumption, warming };
  if (entry.match.auth !== null) AUTH_INDEX.set(entry, new Set(entry.match.auth));
  return entry;
}

function snapshotOf(value: unknown): CacheConfigSnapshot {
  const root = jsonObject(value, '');
  keys(root, '', ['version', 'entries'], ['handoffMinTokens']);
  if (root.version !== CACHE_CONFIG_VERSION) problem('wrong_version', 'version');
  const handoffMinTokens = Object.hasOwn(root, 'handoffMinTokens')
    ? ttl(root.handoffMinTokens, 'handoffMinTokens')
    : null;
  if (!Array.isArray(root.entries)) problem('invalid_type', 'entries');
  if (root.entries.length > CACHE_CONFIG_MAX_ENTRIES) problem('too_many_entries', 'entries');
  const entries = root.entries.map((entry, index) => entryBlock(entry, `entries[${index}]`));
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    // The key is the match predicate itself: alternatives are already trimmed and
    // unique, so sorting makes `api|bedrock` and `bedrock|api` the same entry.
    const alternatives = entry.match.auth === null ? '' : [...entry.match.auth].sort().join('|');
    const key = `${entry.match.harness}\u0000${alternatives}`;
    if (seen.has(key)) problem('duplicate_match', `entries[${index}].match`);
    seen.add(key);
  }
  return { version: CACHE_CONFIG_VERSION, handoffMinTokens, entries };
}

/** Validate an already-parsed value. Never throws. */
export function validateCacheConfig(value: unknown): CacheConfigParse {
  try {
    return { ok: true, snapshot: snapshotOf(value) };
  } catch (error) {
    if (error instanceof Problem) return invalid(error.detail, error.at);
    return invalid('invalid_shape', null);
  }
}

/** Parse and validate JSON text. Never throws. */
export function parseCacheConfig(text: string): CacheConfigParse {
  if (typeof text !== 'string') return invalid('invalid_type', null);
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return invalid('invalid_json', null);
  }
  return validateCacheConfig(value);
}

/** The valid empty snapshot a missing file produces: every value unknown, warming off. */
export function emptyCacheConfig(): CacheConfigSnapshot {
  return { version: CACHE_CONFIG_VERSION, handoffMinTokens: null, entries: [] };
}

export function cacheConfigPath(home: string): string {
  return join(home, CACHE_CONFIG_FILE);
}

/**
 * Read `<home>/cache.json` once. A missing file is a valid empty snapshot; every
 * other problem is a typed `cache_config_invalid` result. Never throws, never
 * writes, and never reads more than `CACHE_CONFIG_MAX_BYTES`.
 *
 * One descriptor is opened without following a symlink and without blocking on a
 * FIFO, then inspected with `fstatSync`: only a regular file of at most the limit
 * is read, into a buffer of at most `CACHE_CONFIG_MAX_BYTES + 1` bytes. A read
 * longer than the limit is `file_too_large`; a read that does not return exactly
 * the size `fstat` reported is an inconsistent snapshot and is refused.
 */
export function loadCacheConfig(home: string): CacheConfigLoad {
  const path = typeof home === 'string' && home.length > 0 ? cacheConfigPath(home) : '';
  if (path === '') return invalid('file_unreadable', null, '');
  let fd: number;
  try {
    // O_NOFOLLOW refuses a symlink; O_NONBLOCK lets a FIFO be refused, not waited on.
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { ok: true, snapshot: emptyCacheConfig(), path, origin: 'missing' };
    return invalid('file_unreadable', null, path);
  }
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile()) return invalid('file_unreadable', null, path);
    if (info.size > CACHE_CONFIG_MAX_BYTES) return invalid('file_too_large', null, path);
    const buffer = Buffer.alloc(CACHE_CONFIG_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = fs.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk === 0) break;
      bytesRead += chunk;
    }
    if (bytesRead > CACHE_CONFIG_MAX_BYTES) return invalid('file_too_large', null, path);
    if (bytesRead !== info.size) return invalid('file_unreadable', null, path);
    const parsed = parseCacheConfig(buffer.toString('utf8', 0, bytesRead));
    if (!parsed.ok) return { ...parsed, path };
    return { ok: true, snapshot: parsed.snapshot, path, origin: 'file' };
  } catch {
    return invalid('file_unreadable', null, path);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // A descriptor that cannot be closed leaves nothing to report.
    }
  }
}

/** The file's `handoffMinTokens`, or the §5.3 default when it does not set one. */
export function handoffMinTokensFor(snapshot: CacheConfigSnapshot): number {
  const value = snapshot?.handoffMinTokens;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_HANDOFF_MIN_TOKENS;
}

/** A TTL is reported only when it is a positive number; anything else is unknown, never zero. */
function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * How an entry matches the caller's auth label. A listed alternative wins over a
 * wildcard entry; `unknown` is a literal label like any other, so it matches only
 * where the file lists it (or where the entry has no `auth` key).
 */
function authMatch(entry: CacheConfigEntry, harness: string, auth: string): 'listed' | 'wildcard' | null {
  if (entry.match.harness !== harness) return null;
  if (entry.match.auth === null) return 'wildcard';
  return authIndex(entry).has(auth) ? 'listed' : null;
}

const NO_PROVENANCE: CacheAdviceProvenance = {
  entry: null,
  authMatch: null,
  configuredSource: null,
  documentedSource: null,
  observedSource: null,
  planningAssumptionLabel: null,
  observed: false,
};

/**
 * Pure lookup over a loaded snapshot: no file I/O, no clock, no mutation. An
 * unmatched query answers the empty advice (every value null, warming off)
 * rather than a guess.
 */
export function adviceFor(snapshot: CacheConfigSnapshot, query: CacheAdviceQuery): CacheAdvice {
  const harness = typeof query?.harness === 'string' ? query.harness : '';
  const requested = typeof query?.auth === 'string' && query.auth.length > 0 ? query.auth : 'unknown';
  const model = typeof query?.model === 'string' && query.model.length > 0 ? query.model : null;
  const entries = snapshot && Array.isArray(snapshot.entries) ? snapshot.entries : [];
  let index = -1;
  let match: 'listed' | 'wildcard' | null = null;
  for (let i = 0; i < entries.length; i++) {
    const kind = authMatch(entries[i], harness, requested);
    if (kind === 'listed') {
      index = i;
      match = kind;
      break;
    }
    if (kind === 'wildcard' && match === null) {
      index = i;
      match = kind;
    }
  }
  const entry = index >= 0 ? entries[index] : null;
  return {
    harness,
    auth: requested,
    model,
    configuredTtlMs: positive(entry?.configured?.ttlMs),
    documentedTtlMs: positive(entry?.documented?.ttlMs),
    planningTtlMs: positive(entry?.planningAssumption?.ttlMs),
    provenance: entry
      ? {
          entry: index,
          authMatch: match,
          configuredSource: entry.configured?.source ?? null,
          documentedSource: entry.documented?.source ?? null,
          observedSource: entry.observed?.source ?? null,
          planningAssumptionLabel: entry.planningAssumption?.label ?? null,
          observed: entry.observed !== null,
        }
      : { ...NO_PROVENANCE },
    lastQualifyingRequestStartAt: null,
    remainingWarmWindowMs: null,
    warming: entry?.warming === 'native' ? 'native' : 'off',
  };
}
