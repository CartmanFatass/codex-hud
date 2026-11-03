import { readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { runtimeFixture, runtimeRow } from './b10a-runtime-fixture.mjs';
export { runtimeRow };

/** Synthetic ledger/source only; no publication reader or authority survives arrangement. */
export async function sourceFixture(count = 3, history = 8, options = {}) {
  const f = await runtimeFixture(count, history);
  f.runtime.close();
  for (const ref of [f.parent, ...f.targets]) {
    const row = JSON.parse(readFileSync(f.file(ref.sessionId), 'utf8').trim());
    Object.assign(row.payload, { timestamp: row.timestamp, cwd: '/synthetic/project', cli_version: 'synthetic' });
    writeFileSync(f.file(ref.sessionId), JSON.stringify(row) + '\n');
  }
  const sourceRoot = f.file(f.parent.sessionId).split('/sessions/')[0];
  let file = f.file;
  if (options.legacyNames) {
    const dir = dirname(f.file(f.parent.sessionId)),
      mapped = new Map();
    for (const name of readdirSync(dir)) {
      const id = name.replace(/\.jsonl$/, ''),
        hex = createHash('sha256').update(id).digest('hex').slice(0, 32);
      const uuid = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
      const next = join(dir, 'rollout-2026-11-02T00-00-00-' + uuid + '.jsonl');
      renameSync(join(dir, name), next);
      mapped.set(id, next);
    }
    file = (id) => mapped.get(id) ?? f.file(id);
  }
  return { ...f, file, sourceRoot };
}
export const dist = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.ceil(sorted.length * p) - 1];
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) };
};
