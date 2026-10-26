/** Private, local-filesystem coordination for panels sharing a model budget. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { boundedTelemetry, cleanTelemetryRecord, type ModelTelemetryRecord } from './model-telemetry.js';

export interface CachedModelReply { text: string; at: number }
interface Owner { pid: number; start: string; host: string }
interface Claim extends Owner { id: string }
interface Ticket extends Owner { choosing: boolean; number: number }
type Claims = Record<string, Claim>;
const HOUR_MS = 3_600_000;
const CACHE_LIMIT = 200;
const LOCK_WAIT_MS = 5000;
const HOST = os.hostname();

function processIdentity(pid: number): { start: string; state: string } | undefined {
  try {
    // comm may contain spaces and parentheses; field 22 follows the final ')'.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { start: createHash('sha256').update(fields[19]).digest('hex').slice(0, 16), state: fields[0] };
  } catch { return undefined; }
}
const OWNER: Owner = { pid: process.pid, start: processIdentity(process.pid)?.start ?? '', host: HOST };

function alive(owner: Owner): boolean {
  // State is for panels on this machine; unknown remote owners fail closed.
  if (owner.host !== HOST) return true;
  try { process.kill(owner.pid, 0); } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
  const current = processIdentity(owner.pid);
  if (current?.state === 'Z' || current?.state === 'X') return false;
  return !owner.start || !current || current.start === owner.start;
}

function atomicWrite(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch { /* Already renamed. */ } }
}

function read(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('model shared state unavailable');
  }
}

const pause = () => new Promise<void>(resolve => setTimeout(resolve, 15));

/**
 * Bakery mutual exclusion uses unique participant names, never a reusable
 * stale lock path. Removing a dead participant therefore cannot unlink a new
 * owner's lock. Atomic renames publish complete tickets; no network or await
 * occurs inside the critical section. It requires a local filesystem with
 * coherent directory reads and atomic same-directory rename.
 */
export class ModelRuntimeStore {
  private readonly lockDir: string;
  constructor(private readonly dir: string) { this.lockDir = path.join(dir, '.coordination'); }

  private participants(): Array<{ name: string; ticket: Ticket }> {
    const entries: Array<{ name: string; ticket: Ticket }> = [];
    for (const name of fs.readdirSync(this.lockDir)) {
      if (!name.endsWith('.ticket')) continue;
      const file = path.join(this.lockDir, name);
      const value = read(file) as Ticket | undefined;
      if (!value) continue;
      if (!Number.isInteger(value.pid) || value.pid <= 0 || typeof value.start !== 'string'
        || typeof value.host !== 'string' || typeof value.choosing !== 'boolean'
        || !Number.isSafeInteger(value.number) || value.number < 0) throw new Error('model coordination unavailable');
      if (!alive(value)) { try { fs.unlinkSync(file); } catch { /* Another waiter recovered it. */ } continue; }
      entries.push({ name, ticket: value });
    }
    return entries;
  }

  private async transaction<T>(operation: () => T, cancelled: () => boolean = () => false): Promise<T> {
    fs.mkdirSync(this.lockDir, { recursive: true, mode: 0o700 });
    const name = `${process.pid}-${randomUUID()}.ticket`;
    const file = path.join(this.lockDir, name);
    const deadline = performance.now() + LOCK_WAIT_MS;
    try {
      atomicWrite(file, { ...OWNER, choosing: true, number: 0 });
      const number = Math.max(0, ...this.participants().map(entry => entry.ticket.number)) + 1;
      atomicWrite(file, { ...OWNER, choosing: false, number });
      while (true) {
        if (cancelled()) throw new Error('cancelled');
        const blocked = this.participants().some(entry => entry.name !== name && (entry.ticket.choosing
          || entry.ticket.number < number || (entry.ticket.number === number && entry.name < name)));
        if (!blocked) return operation();
        if (performance.now() >= deadline) throw new Error('model coordination timed out');
        await pause();
      }
    } finally { try { fs.unlinkSync(file); } catch { /* Failed before registration or already recovered. */ } }
  }

  /** Read only; telemetry corruption never changes call reservations or cache claims. */
  telemetry(): ModelTelemetryRecord[] {
    const file = path.join(this.dir, 'telemetry.json');
    try { if (fs.statSync(file).size > 1_048_576) throw new Error('model telemetry unavailable'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const value = read(file);
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error('model telemetry unavailable');
    return value.map(row => {
      const safe = cleanTelemetryRecord(row);
      if (!safe) throw new Error('model telemetry unavailable');
      return safe;
    });
  }

  async recordTelemetry(record: ModelTelemetryRecord, now: number): Promise<void> {
    await this.recordTelemetryBatch([record], now);
  }

  async recordTelemetryBatch(records: readonly ModelTelemetryRecord[], now: number): Promise<void> {
    await this.transaction(() => {
      const safe = records.flatMap(record => { const row = cleanTelemetryRecord(record); return row ? [row] : []; });
      if (!safe.length) return;
      atomicWrite(path.join(this.dir, 'telemetry.json'), boundedTelemetry([...this.telemetry(), ...safe], now));
    });
  }

  calls(): number[] {
    const value = read(path.join(this.dir, 'calls.json'));
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some(at => typeof at !== 'number' || !Number.isFinite(at))) throw new Error('model call log unavailable');
    return value as number[];
  }

  cache(): Map<string, CachedModelReply> {
    const value = read(path.join(this.dir, 'cache.json'));
    if (value === undefined) return new Map();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('model cache unavailable');
    const entries = Object.entries(value).filter(([key, item]) => /^[0-9a-f]{64}$/.test(key)
      && typeof item?.text === 'string' && typeof item.at === 'number' && Number.isFinite(item.at));
    return new Map(entries as Array<[string, CachedModelReply]>);
  }

  private activeFile(id: string): string { return path.join(this.lockDir, `${id}.active`); }

  private claims(): Claims {
    const value = read(path.join(this.dir, 'claims.json'));
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('model claims unavailable');
    for (const [digest, claim] of Object.entries(value as Claims)) {
      if (!/^[0-9a-f]{64}$/.test(digest) || !claim || !Number.isInteger(claim.pid) || claim.pid <= 0
        || typeof claim.start !== 'string' || typeof claim.host !== 'string' || typeof claim.id !== 'string' || !/^[0-9a-f-]{36}$/.test(claim.id)) throw new Error('model claims unavailable');
    }
    return value as Claims;
  }

  async reserve(digest: string | null, id: string, cap: number, clock: () => number, cancelled: () => boolean): Promise<
    | { kind: 'cached'; entry: CachedModelReply }
    | { kind: 'waiting' | 'refused' | 'reserved' }
  > {
    return this.transaction(() => {
      const now = clock();
      if (digest) {
        const hit = this.cache().get(digest);
        if (hit) return { kind: 'cached', entry: hit };
      }
      const claims = this.claims();
      for (const [key, claim] of Object.entries(claims)) {
        if (!alive(claim) || !fs.existsSync(this.activeFile(claim.id))) {
          try { fs.unlinkSync(this.activeFile(claim.id)); } catch { /* Already gone. */ }
          delete claims[key];
        }
      }
      if (digest && claims[digest]) return { kind: 'waiting' };
      const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
      const retainAfter = Math.min(midnight.getTime(), now - HOUR_MS);
      const calls = this.calls().filter(at => at >= retainAfter);
      // Count future reservations conservatively as well: clock rollback
      // must not reopen budget already spent by another panel.
      if (calls.filter(at => at > now - HOUR_MS).length >= cap) return { kind: 'refused' };
      // Persist the reservation before sending. A crash can conservatively
      // spend a slot, but cannot send an uncounted request.
      try {
        if (digest) atomicWrite(this.activeFile(id), OWNER);
        atomicWrite(path.join(this.dir, 'calls.json'), [...calls, now]);
        if (digest) {
          claims[digest] = { ...OWNER, id };
          atomicWrite(path.join(this.dir, 'claims.json'), claims);
        }
      } catch (error) {
        if (digest) { try { fs.unlinkSync(this.activeFile(id)); } catch { /* Failed before registration. */ } }
        throw error;
      }
      return { kind: 'reserved' };
    }, cancelled);
  }

  async finish(digest: string, id: string, entry?: CachedModelReply, shouldCache: () => boolean = () => true): Promise<void> {
    try { await this.transaction(() => {
      const claims = this.claims();
      // A cancelled/dead owner must never overwrite a successor's answer.
      if (claims[digest]?.id !== id) return;
      if (entry && shouldCache()) {
        const cache = this.cache();
        cache.delete(digest);
        cache.set(digest, entry);
        // Keep disk order oldest first. Stable ties then retain newly
        // completed entries even when several calls share a clock tick.
        const newest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(-CACHE_LIMIT);
        atomicWrite(path.join(this.dir, 'cache.json'), Object.fromEntries(newest));
      }
      delete claims[digest];
      atomicWrite(path.join(this.dir, 'claims.json'), claims);
    }); } finally {
      // A failed commit must not strand a claim in a still-live panel. This
      // unique marker may be removed without touching another owner's state.
      try { fs.unlinkSync(this.activeFile(id)); } catch { /* Already removed or unavailable. */ }
    }
  }
}
