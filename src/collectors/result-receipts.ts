import * as fs from 'node:fs';
import { join } from 'node:path';
import { readFileBounded } from '../utils/atomic-fs.js';
import { resultDigest, resultExcerpt } from './objectives.js';

interface ResultReceipt { project: string; id: string; at: number; result?: string; resultDigest?: string }
const receiptKey = (root: string, id: string) => JSON.stringify([root, id]);

/** Keep the newest year of monthly receipts, at most 64 KiB from the tail of each month. */
export class ResultReceipts {
  private months: string[] = [];
  private dirStamp?: string;
  private cache = new Map<string, { stamp: string; receipts: ResultReceipt[] }>();
  constructor(private dir: string) {}

  read(): Map<string, ResultReceipt> {
    const latest = new Map<string, ResultReceipt>();
    try {
      const dir = fs.lstatSync(this.dir, { throwIfNoEntry: false });
      const stamp = dir?.isDirectory() ? `${dir.ino}:${dir.mtimeMs}:${dir.ctimeMs}` : '';
      if (stamp !== this.dirStamp) {
        this.months = stamp ? fs.readdirSync(this.dir).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort().slice(-12) : [];
        this.dirStamp = stamp;
        for (const name of this.cache.keys()) if (!this.months.includes(name)) this.cache.delete(name);
      }
    } catch { return latest; }
    for (const name of this.months) {
      const file = join(this.dir, name);
      let st: fs.Stats | undefined;
      try { st = fs.lstatSync(file, { throwIfNoEntry: false }); } catch { continue; }
      if (!st?.isFile()) continue;
      const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
      let entry = this.cache.get(name);
      if (entry?.stamp !== stamp) {
        const receipts: ResultReceipt[] = [];
        try {
          const limit = 65536, offset = Math.max(0, st.size - limit);
          const lines = readFileBounded(file, limit, { offset }).bytes.toString('utf8').split('\n');
          lines.pop(); // The writer terminates every complete receipt with a newline.
          if (offset) lines.shift();
          for (const line of lines) try {
            const e = JSON.parse(line);
            if (e?.v !== 1 || e.kind !== 'objective' ||
                typeof e.project !== 'string' || typeof e.id !== 'string' || typeof e.at !== 'string') continue;
            const result = typeof e.result === 'string' ? e.result : undefined;
            // Creation/reset and old result receipts can supersede earlier dates even without evidence.
            if (result === undefined && e.change !== 'created' && e.change !== 'result') continue;
            const at = Date.parse(e.at);
            if (Number.isFinite(at) && new Date(at).toISOString() === e.at)
              receipts.push({ project: e.project, id: e.id, at, result,
                resultDigest: e.resultDigest === undefined ? undefined : typeof e.resultDigest === 'string' ? e.resultDigest : '' });
          } catch { /* A malformed line does not hide the rest of the file. */ }
        } catch { /* Unavailable month: no result dates from it. */ }
        this.cache.set(name, entry = { stamp, receipts });
      }
      for (const e of entry.receipts) {
        const key = receiptKey(e.project, e.id);
        if ((latest.get(key)?.at ?? -Infinity) <= e.at) latest.set(key, e);
      }
    }
    return latest;
  }
}

/** A receipt dates the current result only if it attests to the exact text. */
export function resultDate(receipts: ReadonlyMap<string, ResultReceipt>, root: string, id: string, result: string) {
  const receipt = receipts.get(receiptKey(root, id));
  const matches = receipt?.resultDigest !== undefined ? receipt.resultDigest === resultDigest(result)
    : receipt?.result === result && resultExcerpt(result) === result;
  return matches ? receipt?.at : undefined;
}
