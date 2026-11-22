import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import { readStateLedger, type parseLedger } from './state-ledger.js';

import { targetKey } from './ticket-evidence.js';

type Slice = ReturnType<typeof parseLedger>[number];
export type TryAction = 'accept' | 'flag';
// Mixed batches keep each slice's milestone aligned with its id (and, for flags, its revision).
export interface TryTarget { milestone: string; slices: Pick<Slice, 'id' | 'text'>[]; milestones?: string[] }
interface TryRecord {
  at: string; root: string; action: TryAction; milestone: string; slices: string[]; revisions?: string[]; milestones?: string[];
}
export const TRIES_FILE = 'tries.jsonl';
// STATE has no per-line timestamps. Fingerprint the parsed ledger text so unrelated edits don't clear a flag.
const revision = (text: string) => createHash('sha256').update(text).digest('hex');

function parseTry(line: string): TryRecord | undefined {
  try {
    const r: TryRecord = JSON.parse(line);
    if (typeof r.root === 'string' && typeof r.milestone === 'string' && ['accept', 'flag'].includes(r.action) &&
      Array.isArray(r.slices) && r.slices.every(id => typeof id === 'string')) return r;
  } catch { /* Malformed record. */ }
}
function tryLine(r: TryRecord, ids: string[]) {
  const milestone = (r.action === 'accept' || ids.length > 1) && !/^[—–-]*$/.test(r.milestone) ? ` ${r.milestone}` : '';
  return `try ${r.action === 'accept' ? 'accepted' : 'flagged'} ${basename(r.root)}${milestone}${milestone || ids.length > 1 ? ':' : ''} ${ids.join(', ')}`.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}
export function liveTryLine(line: string, root: string): string | undefined {
  const r = parseTry(line);
  return r?.root === root && r.slices.length ? tryLine(r, r.slices) : undefined;
}

export function appendTry(home: string, root: string, action: TryAction, target: TryTarget): void {
  const { milestone, slices, milestones } = target;
  const record: TryRecord = { at: new Date().toISOString(), root, action, milestone, slices: slices.map((s) => s.id),
    ...(milestones ? { milestones } : {}),
    ...(action === 'flag' ? { revisions: slices.map((s) => revision(s.text)) } : {}) };
  fs.mkdirSync(home, { mode: 0o700, recursive: true });
  const fd = fs.openSync(join(home, TRIES_FILE), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT |
    fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try { fs.appendFileSync(fd, JSON.stringify(record) + '\n'); }
  finally { fs.closeSync(fd); }
}

const pending = (record: TryRecord, slice: Slice, i: number) => slice.state === 'try' && slice.milestone === (record.milestones?.[i] ?? record.milestone) &&
  (record.action === 'accept' || record.revisions?.[i] === revision(slice.text));

/** The HUD home is private and the log append-only. Idle reads never reopen its body. */
export class TryLog {
  private stamp = '';
  private records: TryRecord[] = [];
  delivered?: number; // Live reader cursor; carried across an MCP rebuild.
  constructor(private home: string) {}
  private read(): TryRecord[] {
    const path = join(this.home, TRIES_FILE);
    try {
      const st = fs.lstatSync(path), stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
      if (!st.isFile()) return [];
      if (stamp === this.stamp) return this.records;
      const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        this.records = fs.readFileSync(fd, 'utf8').split('\n').slice(0, -1).flatMap(line => parseTry(line) ?? []);
        this.stamp = stamp;
      } finally { fs.closeSync(fd); }
    } catch { this.stamp = ''; this.records = []; }
    return this.records;
  }
  /** Keep archived accepts, but never apply an old acceptance to a reopened STATE row. */
  accepted(root: string, ledger: Slice[] = []): string[] {
    return [...this.marks(root, ledger, true)].filter(([, action]) => action === 'accept').map(([id]) => id);
  }
  marks(root: string, ledger: Slice[], includeArchived = false): Map<string, TryAction> {
    const byId = new Map(ledger.map((s) => [targetKey(s.id), s])), marks = new Map<string, [string, TryAction]>();
    for (const r of this.read()) if (r.root === root) r.slices.forEach((id, i) => {
      const key = targetKey(id), slice = byId.get(key);
      if (slice ? pending(r, slice, i) : includeArchived && r.action === 'accept') marks.set(key, [slice?.id ?? id, r.action]);
      else marks.delete(key);
    });
    return new Map(marks.values());
  }
  changes(root?: string): string[] {
    const catchup = this.delivered === undefined;
    const records = this.read(), fresh = records.slice(this.delivered ?? 0), ledgers = new Map<string, Map<string, Slice>>();
    this.delivered = records.length;
    const lines: string[] = [], seen = new Map<string, Set<string>>();
    for (const r of catchup ? fresh.reverse() : fresh) {
      if (root !== undefined && r.root !== root) continue;
      let ids = r.slices;
      // Live changes are events; catch-up asks only for the latest decisions not yet reflected in STATE.
      if (catchup) {
        const ledger = ledgers.get(r.root) ?? new Map(readStateLedger(r.root).map((s) => [s.id, s]));
        ledgers.set(r.root, ledger);
        const handled = seen.get(r.root) ?? new Set<string>();
        seen.set(r.root, handled);
        ids = r.slices.filter((id, i) => {
          if (handled.has(id)) return false;
          handled.add(id);
          const slice = ledger.get(id);
          return slice && pending(r, slice, i);
        });
      }
      if (!ids.length) continue;
      lines.push(tryLine(r, ids));
    }
    return catchup ? lines.reverse() : lines;
  }
}
