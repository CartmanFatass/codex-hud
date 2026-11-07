// Ported from the owner's jev-ask (jev_ask.py key, jev_send.py Operation / squash).
// Write path is the v4 rule (design §4.5 H1/M1), not the CLI's fixed `<key'>.tmp` overwrite:
// re-read, merge the delta, unique temp name, rename, fsync the file and the directory.
// `send_attempted: true` stays set unless the same delta has `released: true` and
// `send_attempted: false` (a reconcile release).

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { JevFailure } from './error.js';
import { type HeldLease, type LockRequest, assertLeaseHeld, tryAcquireBrowserLock } from './lease.js';
import { ensureOperationsDir, fsyncDirectory, operationPath, operationStem } from './names.js';

/** Python `str.isspace` / `re` `\s` over the BMP. U+FEFF is intentionally absent. */
const PY_SPACE = new Set<number>([
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x001c, 0x001d, 0x001e, 0x001f, 0x0020, 0x0085, 0x00a0, 0x1680, 0x2000,
  0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f,
  0x3000,
]);

export const KEY_PREFIX = { chatgpt: 'ask-pro:', gemini: 'ask-gemini:' } as const;
export type AskProvider = keyof typeof KEY_PREFIX;

/** M1. One slug, 1–64 characters, so Python `json.dumps` of the key fields stays ASCII. */
export const LABEL_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const MAX_ATTEMPTS = 20;

export type AttemptResult = 'pre_send' | 'dry_run' | 'uncertain' | 'sent';

export interface OperationAttempt {
  at: string;
  phase_reached: string;
  result: AttemptResult;
  error?: { code: string; message: string };
  evidence?: unknown;
}

/**
 * Schema v1 operation record. Unknown keys are kept: the CLI reads fields with `.get`.
 * See docs/design/jev-record-schema-v1.md.
 */
export interface OperationRecord {
  key?: string;
  provider?: string;
  prompt_sha256?: string | null;
  squashed_sha256?: string;
  conversation?: string;
  mode?: string;
  effort?: string;
  send_attempted?: boolean;
  send_effect?: string | null;
  released?: boolean;
  released_evidence?: string;
  released_prompt_sha256?: string | null;
  unresolved?: string;
  attempts?: OperationAttempt[];
  tabs?: unknown;
  pill_text?: string;
  updated?: string;
  dry_run?: string;
  steps?: unknown;
  [extra: string]: unknown;
}

export interface RecordDeps {
  now?: () => Date;
  pid?: () => number;
  random?: () => string;
  fsync?: (fd: number) => void;
  onTemp?: (file: string) => void;
  beforeRename?: (file: string) => void;
}

export function pyIsSpace(codePoint: number): boolean {
  return PY_SPACE.has(codePoint);
}

/** Python `str.strip`. Does not remove U+FEFF. Does remove U+0085 and U+001C–U+001F. */
export function pyStrip(text: string): string {
  const chars = Array.from(text);
  let start = 0;
  let end = chars.length;
  while (start < end && pyIsSpace(chars[start]!.codePointAt(0)!)) start += 1;
  while (end > start && pyIsSpace(chars[end - 1]!.codePointAt(0)!)) end -= 1;
  return chars.slice(start, end).join('');
}

/** Python `re.sub(r"\\s+", " ", text or "").strip()`. */
export function pySquash(text: string | null | undefined): string {
  if (!text) return '';
  let out = '';
  let pending = false;
  let started = false;
  for (const ch of text) {
    if (pyIsSpace(ch.codePointAt(0)!)) {
      if (started) pending = true;
      continue;
    }
    if (pending) out += ' ';
    pending = false;
    started = true;
    out += ch;
  }
  return out;
}

/**
 * Python text-mode universal newlines: `\\r\\n` and a lone `\\r` become `\\n`.
 * U+0085, U+2028 and U+2029 are not translated (Python 3).
 */
export function pythonUniversalNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Decode prompt bytes the way `Path.read_text(encoding="utf-8").strip()` does. */
export function readPromptBytes(bytes: Uint8Array): string {
  let text: string;
  try {
    // ignoreBOM keeps U+FEFF. Python text mode does not strip a leading BOM; the default decoder does.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new JevFailure('prompt_encoding', 'prompt is not valid utf-8');
  }
  return pyStrip(pythonUniversalNewlines(text));
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Python `json.dumps` of one string with the default `ensure_ascii=True`. */
export function pythonJsonString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    const cp = value.charCodeAt(i);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (cp < 0x20 || cp > 0x7e) out += `\\u${cp.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/** `json.dumps([label, digest])` with the default separators `(", ", ": ")`. */
export function pythonJsonPair(label: string, digest: string): string {
  return `[${pythonJsonString(label)}, ${pythonJsonString(digest)}]`;
}

export function promptSha256(strippedPrompt: string): string {
  return sha256Hex(strippedPrompt);
}

export function squashedSha256(strippedPrompt: string): string {
  return sha256Hex(pySquash(strippedPrompt));
}

/**
 * Key algorithm shared with `jev-ask key`, including labels the ask API rejects.
 * Tests compare this with the Python fixture for non-slug labels; `askKey` is the gate.
 */
export function operationKey(provider: AskProvider, label: string, strippedPrompt: string): string {
  const prefix = KEY_PREFIX[provider];
  if (!prefix) throw new JevFailure('config', 'provider must be chatgpt or gemini');
  const digest = promptSha256(strippedPrompt);
  return prefix + sha256Hex(pythonJsonPair(label, digest));
}

export function assertLabel(label: string): void {
  if (!LABEL_SLUG.test(label)) {
    throw new JevFailure('invalid_label', 'label must match [a-z0-9][a-z0-9-]{0,63}');
  }
}

export function assertPrompt(prompt: string): void {
  if (!prompt) throw new JevFailure('empty_prompt', 'prompt file is empty');
}

/** Ask entry: slug check, then the Python key of the stripped prompt. */
export function askKey(provider: AskProvider, label: string, strippedPrompt: string): string {
  assertLabel(label);
  return operationKey(provider, label, strippedPrompt);
}

export function askKeyFromBytes(provider: AskProvider, label: string, bytes: Uint8Array): string {
  return askKey(provider, label, readPromptBytes(bytes));
}

export function assertProvider(record: OperationRecord | null, provider: string): void {
  if (!record || Object.keys(record).length === 0) return;
  const recorded = typeof record.provider === 'string' ? record.provider : 'chatgpt';
  if (recorded !== provider) {
    throw new JevFailure('provider_mismatch', `this key belongs to provider ${recorded}; a key never changes provider`);
  }
}

/**
 * A released key needs an explicit confirm before another send. An attempted key
 * is never sent again; the caller waits or reconciles.
 */
export function assertCanSend(record: OperationRecord | null, confirmResend = false): void {
  if (!record) return;
  if (record.send_attempted === true) {
    throw new JevFailure('already_attempted', 'send already attempted for this key');
  }
  if (record.released === true && !confirmResend) {
    throw new JevFailure('resend_needs_confirmation', 'this key was released; confirm_resend is required');
  }
}

/** Observation and wait. Does not take the browser lock (design D4). */
export function readOperation(stateDir: string, key: string): OperationRecord | null {
  const file = operationPath(stateDir, key);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JevFailure('record_corrupt', 'operation record is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new JevFailure('record_corrupt', 'operation record is not an object');
  }
  return parsed as OperationRecord;
}

export interface LockedReadHooks {
  beforeRead?: () => void;
}

/**
 * Send and reconcile. The lease is checked before the record file is touched.
 * `beforeRead` runs only after that check, so a lost lease never reads the record.
 */
export function readOperationLocked(
  stateDir: string,
  key: string,
  lease: HeldLease,
  hooks?: LockedReadHooks
): OperationRecord | null {
  requireBrowserLease(stateDir, lease);
  hooks?.beforeRead?.();
  return readOperation(stateDir, key);
}

export interface OpenHooks extends LockedReadHooks {
  onLocked?: () => void;
}

/** Acquire the browser lock, then read. The caller releases `lease` (including on later failure). */
export function openForUpdate(
  stateDir: string,
  key: string,
  request: LockRequest,
  hooks?: OpenHooks
): { lease: HeldLease; record: OperationRecord | null } {
  const lease = tryAcquireBrowserLock({ ...request, stateDir, kind: 'browser' });
  try {
    hooks?.onLocked?.();
    const record = readOperationLocked(stateDir, key, lease, hooks);
    return { lease, record };
  } catch (error) {
    lease.release();
    throw error;
  }
}

export function mergeSave(
  stateDir: string,
  key: string,
  delta: OperationRecord,
  lease: HeldLease,
  deps?: RecordDeps
): OperationRecord {
  const disk = readForSave(stateDir, key, lease) ?? {};
  const merged = mergeRecord(disk, delta, (deps?.now ?? (() => new Date()))());
  writeRecord(stateDir, key, merged, deps);
  return merged;
}

/**
 * Re-read under the lock immediately before the click persist.
 * An already-true `send_attempted` throws and does not write.
 */
export function persistClick(
  stateDir: string,
  key: string,
  fields: OperationRecord,
  lease: HeldLease,
  deps?: RecordDeps
): OperationRecord {
  const disk = readOperationLocked(stateDir, key, lease) ?? {};
  if (disk.send_attempted === true) {
    throw new JevFailure('already_attempted', 'send already attempted for this key');
  }
  const merged = mergeRecord(
    disk,
    { ...fields, send_attempted: true, send_effect: 'uncertain' },
    (deps?.now ?? (() => new Date()))()
  );
  writeRecord(stateDir, key, merged, deps);
  return merged;
}

/**
 * Re-read under the browser lease before a reconcile release.
 * A record that already shows `send_effect: "sent"` or `released: true` is left untouched.
 */
export function persistRelease(
  stateDir: string,
  key: string,
  fields: OperationRecord,
  lease: HeldLease,
  deps?: RecordDeps
): OperationRecord {
  const disk = readOperationLocked(stateDir, key, lease) ?? {};
  if (disk.send_effect === 'sent') {
    throw new JevFailure('already_sent', 'send already completed for this key');
  }
  if (disk.released === true) {
    throw new JevFailure('already_released', 'this key was already released');
  }
  const merged = mergeRecord(
    disk,
    { ...fields, released: true, send_attempted: false },
    (deps?.now ?? (() => new Date()))()
  );
  writeRecord(stateDir, key, merged, deps);
  return merged;
}

export function appendAttempt(
  stateDir: string,
  key: string,
  attempt: OperationAttempt,
  lease: HeldLease,
  deps?: RecordDeps
): OperationRecord {
  const disk = readForSave(stateDir, key, lease) ?? {};
  const prev = Array.isArray(disk.attempts) ? disk.attempts : [];
  return mergeSave(stateDir, key, { attempts: capAttempts([...prev, attempt]) }, lease, deps);
}

export function mergeRecord(disk: OperationRecord, delta: OperationRecord, now = new Date()): OperationRecord {
  const clean = definedFields(delta);
  const release = clean.released === true && clean.send_attempted === false;
  // A release that races a completed send must not clear the attempt.
  if (release && disk.send_effect === 'sent') return { ...disk, updated: pythonTimestamp(now) };
  const merged: OperationRecord = { ...disk, ...clean };
  if (disk.send_attempted === true && !release) merged.send_attempted = true;
  if (Array.isArray(merged.attempts)) merged.attempts = capAttempts(merged.attempts);
  merged.updated = pythonTimestamp(now);
  return merged;
}

export function capAttempts(attempts: OperationAttempt[]): OperationAttempt[] {
  return attempts.length > MAX_ATTEMPTS ? attempts.slice(attempts.length - MAX_ATTEMPTS) : attempts;
}

/** Python `time.strftime("%Y-%m-%dT%H:%M:%S%z")` in the local offset, no colon in the zone. */
export function pythonTimestamp(now: Date): string {
  const pad = (value: number) => String(Math.trunc(Math.abs(value))).padStart(2, '0');
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.trunc(offsetMin / 60))}${pad(offsetMin % 60)}`
  );
}

function definedFields(delta: OperationRecord): OperationRecord {
  const out: OperationRecord = {};
  for (const [key, value] of Object.entries(delta)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function sameStateDir(stateDir: string, lease: HeldLease): boolean {
  return path.resolve(lease.stateDir) === path.resolve(stateDir);
}

function requireBrowserLease(stateDir: string, lease: HeldLease): void {
  if (lease.kind !== 'browser' || !sameStateDir(stateDir, lease)) {
    throw new JevFailure('lease_required', 'send and reconcile need the browser lock for this state directory');
  }
  assertLeaseHeld(lease);
}

/** Browser lease, or the wait lease for this same key. Click and release stay browser-only. */
function requireSaveLease(stateDir: string, key: string, lease: HeldLease): void {
  if (!sameStateDir(stateDir, lease) || (lease.kind === 'wait' ? lease.key !== key : lease.kind !== 'browser')) {
    throw new JevFailure('lease_required', 'saving a record needs the browser lock or the wait lease for this key');
  }
  assertLeaseHeld(lease);
}

function readForSave(stateDir: string, key: string, lease: HeldLease, hooks?: LockedReadHooks): OperationRecord | null {
  requireSaveLease(stateDir, key, lease);
  hooks?.beforeRead?.();
  return readOperation(stateDir, key);
}

function writeRecord(stateDir: string, key: string, record: OperationRecord, deps?: RecordDeps): void {
  const fsync = deps?.fsync ?? fs.fsyncSync;
  const dir = ensureOperationsDir(stateDir, fsync);
  const stem = operationStem(key);
  const pid = deps?.pid?.() ?? process.pid;
  const body = JSON.stringify(record, null, 2);
  let tmp = path.join(dir, `${stem}.${pid}.${deps?.random?.() ?? randomBytes(8).toString('hex')}.tmp`);
  let fd = -1;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt === 4) throw error;
      tmp = path.join(dir, `${stem}.${pid}.${randomBytes(8).toString('hex')}.tmp`);
    }
  }
  deps?.onTemp?.(tmp);
  try {
    fs.writeFileSync(fd, body);
    fsync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  const finalPath = path.join(dir, `${stem}.json`);
  try {
    deps?.beforeRename?.(tmp);
    fs.renameSync(tmp, finalPath);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  fsyncDirectory(dir, fsync);
}
